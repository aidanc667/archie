# Simplified PDF Summary — Design Spec

## Goal

Add an opt-in `--pdf` flag that, after the detailed markdown report is
generated and validated, makes a second Claude call to translate it into a
short, plain-language summary for non-technical readers, then converts that
summary into a PDF file.

This is separate from the source-snippet-grounding and Critic-agent ideas
discussed earlier — those address report *accuracy*, this addresses report
*audience*. The detailed markdown report remains the source of truth for
engineers; the PDF is a derived, simplified artifact for people who don't
need (or want) file paths, line numbers, or cyclomatic complexity numbers.

## Non-goals

- Replacing markdown output with PDF — markdown stays the default,
  always-generated output. PDF is additive and opt-in.
- A second independent analysis pass over the Context Pack — the simplified
  summary is generated *from* the already-validated detailed report, not by
  re-analyzing the graph/metrics data. This guarantees the two documents
  agree on facts and conclusions, since one is derived from the other.
- Strict structural validation of the simplified summary (no required
  5-section schema like `validateReportSections`) — that schema is designed
  for the engineer-facing report's consistency, not appropriate for a loose,
  readable summary.
- Custom PDF styling/branding/templates — plain markdown-to-PDF conversion
  with default styling is sufficient for v1.

## Pipeline addition

```
generateReport() [existing] → validated markdown report (written to disk)
  → (if --pdf) generateSimplifiedSummary(client, report) → plain-language text
  → convertToPdf(text, outPath) → archie-report.pdf
```

## Components

### `src/reasoning.ts`

New function `generateSimplifiedSummary(client: Anthropic, technicalReport: string): Promise<string>`.

- System prompt instructs Claude to rewrite the report for a non-technical
  reader (e.g. a founder, PM, or investor evaluating the team/product, not
  the code): no jargon, no file paths, no line numbers, no complexity
  scores. Focus on business-level risk ("what could go wrong for users/the
  company") rather than code-level risk ("what could go wrong in this
  function").
- Target length: roughly 1/3 to 1/2 the detailed report's length — short
  enough to read in about two minutes.
- Loose structure, not a strict schema: what the system does, the 2-3
  things most worth worrying about, and the bottom-line recommendation.
  No heading-based validation like `validateReportSections`.
- Minimal validation: reject (throw) only if the response is suspiciously
  short (e.g. under ~100 characters) or empty, since that signals a
  degenerate API response rather than a real summary. No other structural
  checks.

### `src/pdf.ts` (new file)

`convertToPdf(text: string, outPath: string): Promise<void>` — converts
markdown-formatted text (the simplified summary may use basic markdown:
headers, bullet points, bold) into a PDF written to `outPath`, using a
markdown-to-PDF library (e.g. `md-to-pdf`). This module has no knowledge of
Claude, the pipeline, or report structure — it's a generic markdown-to-PDF
converter, kept separate so it could be reused or swapped independently.

### `src/index.ts`

`PipelineOptions` gains `generatePdf: boolean`. After the detailed report
is generated and returned (existing behavior unchanged), if `generatePdf`
is true, `runPipeline` calls `generateSimplifiedSummary` then
`convertToPdf`, writing the PDF to `<out base name>.pdf`. The detailed
report's generation, validation, and write are unaffected and unchanged by
this addition.

### `src/cli.ts`

New `--pdf` flag (boolean, default `false`). When set, the CLI passes
`generatePdf: true` into `runPipeline`'s options and informs the user (via
`--verbose` logging, consistent with existing CLI patterns) that a PDF
summary is being generated.

## Error handling

If `generateSimplifiedSummary` or `convertToPdf` fails, the run does **not**
fail overall — the detailed markdown report was already generated and
written successfully before the PDF stage runs. The CLI prints a warning
to stderr (e.g. `archie: warning: PDF summary generation failed: <message>`)
and exits 0, since the primary deliverable (the detailed report) succeeded.

This is a deliberate, narrow exception to v1's existing "fail fast, no
partial output" error-handling philosophy (documented in the original
design spec): that philosophy applies to the primary pipeline producing the
primary deliverable. The PDF is an explicitly secondary, opt-in addition
layered on top of an already-successful run, so a failure in that addition
shouldn't discard a result the user already has.

## Testing

- `src/reasoning.test.ts`: extend with tests for `generateSimplifiedSummary`
  using a mocked client (same pattern as existing `generateReport` tests) —
  one test confirming it returns the mocked text on a normal response, one
  confirming it throws on a suspiciously short/empty response.
- `src/pdf.test.ts` (new): test that `convertToPdf` produces a non-empty
  file at the given path from sample markdown input, using a temp directory
  (same `mkdtemp`/`rm` pattern already used in `walker.test.ts`'s symlink
  test).
- `src/cli.test.ts`: extend to confirm that when `--pdf` is NOT passed, no
  PDF-related code path runs (existing behavior unchanged); and that a
  failure in the detailed-report stage short-circuits before any PDF
  attempt is made (consistent with the error-handling section above).

## Why this approach (alternatives considered)

Considered generating both the detailed and simplified report in a single
Claude call (two sections in one response) to halve API cost. Rejected
because the simplified section would be generated alongside dense technical
content in the same context, risking jargon leaking into the "simple"
section — generating the simplified summary as a dedicated second call,
explicitly instructed to translate already-finalized prose, produces more
reliably plain language.

Considered having the simplified summary re-analyze the original Context
Pack independently (its own grounded pass over the graph/metrics) rather
than summarizing the detailed report. Rejected because two independently
generated documents about the same codebase could reach different
conclusions or flag different risks, which would undermine trust in either
one — deriving the summary from the already-validated report guarantees
they agree.
