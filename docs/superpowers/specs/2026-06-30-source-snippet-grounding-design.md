# Source-Snippet Grounding — Design Spec

## Goal

Include full source content for each top-risk file in the Context Pack sent to
Claude during report generation, instead of metrics-only. This addresses a
concrete failure mode observed in production use: the Reasoning layer claimed
`computeDependencyDepth` had "no evidence of" a cycle guard, when one in fact
exists (`metrics.ts`'s `visiting: Set<string>` check) — the model had no way
to check, since it only ever saw graph/metric summaries, never source.

This is the first of three planned improvements to ARCHIE
(source-snippet grounding → Critic agent → PDF export), sequenced first
because it directly fixes the most concrete quality problem found so far,
and because the Critic agent (next) will be more effective once the first
pass is better grounded.

## Non-goals

- Smart excerpting (only the flagged hot-spot functions, not full files) —
  deferred; full-file inclusion is simpler and the token budget increase
  comfortably covers it for v1-scale repos.
- A separate sub-budget for source vs. metadata — the existing single
  `maxTokens` budget and pruning loop already handle this correctly once
  raised; a split budget adds complexity without a clear v1 need.
- Redaction or secret-scrubbing of source before sending to the LLM. Full
  source content goes to Anthropic's API under the same trust boundary that
  already applies to file paths, metrics, and code structure today — this
  is a quantity change (more data), not a new category of risk, so no new
  safeguard is being added as part of this change.
- A CLI flag to tune `maxTokens` — the default is simply being raised; this
  isn't new user-facing configurability.

## Changes by component

### `src/index.ts`

`runPipeline` already reads every file's content (for LOC counting) inside
its per-file loop. That same read is captured into a new
`Map<string, string>` (absolute file path → source text) and passed as a new
argument to `buildContextPack`. No new file reads are introduced.

### `src/summarizer.ts`

- `buildContextPack(graph, scores, sourceByPath, options)` — new third
  parameter `sourceByPath: Map<string, string>`, inserted before
  `options` to match the existing parameter ordering convention
  (data inputs before options).
- `TopRiskFile` gains a `source: string` field. When building each
  `TopRiskFile` entry, the implementation looks up the corresponding
  absolute path's content from `sourceByPath`. If a top-risk file's
  source is missing from the map (should not happen in practice, since
  every walked-and-parsed file gets an entry — but the function stays
  total rather than throwing), `source` falls back to `""`.
- The existing pruning loop and `estimateTokens` require no logic changes.
  `estimateTokens` already measures `JSON.stringify(candidate).length`,
  which will naturally reflect the larger payload once `source` is
  populated, so the loop prunes harder under the same mechanism it
  already uses.
- Mode 2 (cluster-summary fallback) is unaffected — it has no per-file
  detail and therefore no source-snippet concept.

### Token budget default

The default `maxTokens` passed from `cli.ts` into `runPipeline`'s
`PipelineOptions` (currently hardcoded as `50000`) is raised to `200000`.
This is a constant change in `cli.ts`, not new configurability — `--topN`
remains the only summarizer-related CLI flag.

### `src/reasoning.ts`

The system prompt's grounding-rule paragraph is updated to mention that the
Context Pack now includes full source for top-risk files, and that claims
about something being "missing" or "no evidence of" must be checked against
the included source for that file, not inferred from the absence of a
metric. Wording change only — no change to `validateReportSections` or the
required-headings contract.

## Testing

- `src/summarizer.test.ts`: extend with a test asserting that
  `topRiskFiles[].source` is populated correctly from `sourceByPath` for
  the top-N files.
- Extend the existing incremental-pruning test pattern (Task 8's
  three-file pruning test) with a case using larger fixture source content,
  confirming the budget still falls back to `cluster-summary` mode when
  source content pushes the candidate past `maxTokens`.
- No new tests needed for `reasoning.ts` beyond the existing
  `validateReportSections`/`generateReport` suite — the prompt wording
  change doesn't alter validation logic.

## Why this approach (alternatives considered)

Considered excerpting only the flagged high-complexity functions/lines
rather than full files. Rejected for this pass because it requires slicing
source by line range (parser already has `startLine`/`endLine` for
functions/classes, so it's feasible), which adds real implementation
complexity for a first iteration — full-file inclusion is simpler, and at
v1's `topN` scale (≤10-20 files) plus a 200k-token budget, full files fit
comfortably without needing the excerpting logic yet. Worth revisiting if
token costs or repo sizes become a problem in practice.

Considered having the summarizer read files itself (taking a repo root
instead of a pre-built map). Rejected to keep `summarizer.ts` filesystem-free
and synchronously testable, consistent with its current design — `index.ts`
already does the file reads for LOC counting, so reusing that data is free.
