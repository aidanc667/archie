# Simplified PDF Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `--pdf` flag to `archie analyze` that generates a short, plain-language PDF summary (derived from the already-validated detailed markdown report) alongside the existing detailed report.

**Architecture:** After the existing detailed-report pipeline completes successfully, an optional second Claude call translates the technical report into a non-technical summary, which is then converted to PDF via `md-to-pdf`. This is additive — the existing detailed-report path is unmodified.

**Tech Stack:** TypeScript, `@anthropic-ai/sdk` (existing), `md-to-pdf` (new dependency).

---

## File Structure

- `src/reasoning.ts` — add `generateSimplifiedSummary(client, technicalReport)`, alongside existing `generateReport`
- `src/pdf.ts` (new) — `convertToPdf(text, outPath)`, a generic markdown-to-PDF converter with no knowledge of Claude or report structure
- `src/index.ts` — `PipelineOptions` gains `generatePdf: boolean`; `runPipeline` optionally runs the summary+PDF stage after the detailed report succeeds
- `src/cli.ts` — new `--pdf` flag, wires `generatePdf` into `runPipeline`, handles PDF-stage failure as a non-fatal warning

---

## Task 1: Install `md-to-pdf` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dependency**

Run: `npm install md-to-pdf`

- [ ] **Step 2: Verify it installed correctly**

Run: `node -e "import('md-to-pdf').then(m => console.log(typeof m.mdToPdf))"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add md-to-pdf dependency"
```

---

## Task 2: PDF converter module

**Files:**
- Create: `src/pdf.ts`
- Test: `src/pdf.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/pdf.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { convertToPdf } from "./pdf.js";

describe("convertToPdf", () => {
  it("writes a non-empty PDF file from markdown content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "archie-pdf-test-"));
    const outPath = path.join(dir, "summary.pdf");
    try {
      await convertToPdf("# Hello\n\nThis is a test summary.", outPath);

      const stats = await stat(outPath);
      expect(stats.size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
```

Note: this test launches a headless Chromium instance via Puppeteer (a `md-to-pdf` dependency), so it's slower than the rest of the suite — the 30000ms timeout in the third argument to `it(...)` accounts for that.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/pdf.test.ts`
Expected: FAIL — `Cannot find module './pdf.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/pdf.ts
import { mdToPdf } from "md-to-pdf";

export async function convertToPdf(text: string, outPath: string): Promise<void> {
  await mdToPdf({ content: text }, { dest: outPath });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/pdf.test.ts`
Expected: PASS (1 test) — may take several seconds due to Chromium launch

- [ ] **Step 5: Commit**

```bash
git add src/pdf.ts src/pdf.test.ts
git commit -m "feat: add markdown-to-PDF converter"
```

---

## Task 3: Simplified summary generation

**Files:**
- Modify: `src/reasoning.ts`
- Modify: `src/reasoning.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/reasoning.test.ts` (the file already has `import { describe, it, expect, vi } from "vitest";` and other imports at the top — add this new `describe` block at the end, and add `generateSimplifiedSummary` to the existing import from `./reasoning.js`):

```typescript
import {
  validateReportSections,
  generateReport,
  generateSimplifiedSummary,
} from "./reasoning.js";
```

(Replace the existing `import { validateReportSections, generateReport } from "./reasoning.js";` line with the above.)

```typescript
describe("generateSimplifiedSummary", () => {
  it("returns the simplified text from a normal response", async () => {
    const simplifiedText =
      "# What This System Does\n\nThis tool checks code quality.\n\n# Bottom Line\n\nWorks fine, some cleanup needed.";
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: simplifiedText }],
        }),
      },
    };

    const result = await generateSimplifiedSummary(fakeClient as any, "## 1. System Summary\nDetailed technical report content here.");
    expect(result).toBe(simplifiedText);
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(1);
  });

  it("throws when the response is suspiciously short", async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "too short" }],
        }),
      },
    };

    await expect(
      generateSimplifiedSummary(fakeClient as any, "## 1. System Summary\nDetailed technical report content here.")
    ).rejects.toThrow(/too short/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/reasoning.test.ts`
Expected: FAIL — `generateSimplifiedSummary is not a function` (or similar import error)

- [ ] **Step 3: Add the implementation to `src/reasoning.ts`**

Append to `src/reasoning.ts` (after the existing `generateReport` function):

```typescript
const MIN_SUMMARY_LENGTH = 100;

const SIMPLIFIED_SUMMARY_SYSTEM_PROMPT = `You are translating a technical software architecture report into a short summary for a non-technical reader — e.g. a founder, product manager, or investor evaluating the team and product, not the code.

Rules:
- No jargon, no file paths, no line numbers, no complexity scores or other code-level metrics.
- Focus on business-level risk: what could go wrong for users or the company, not what could go wrong in a specific function.
- Keep it short — roughly a third to a half the length of the original report. It should be readable in about two minutes.
- Use a loose, readable structure: what the system does, the 2-3 things most worth worrying about, and the bottom-line recommendation. Do not use the original report's five-section heading structure.
- Base everything on the technical report given to you. Do not invent details not present in it.`;

export async function generateSimplifiedSummary(
  client: Anthropic,
  technicalReport: string
): Promise<string> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SIMPLIFIED_SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: technicalReport }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text : "";

  if (text.trim().length < MIN_SUMMARY_LENGTH) {
    throw new Error(
      `Simplified summary response is too short (${text.trim().length} chars, expected at least ${MIN_SUMMARY_LENGTH}). Raw response:\n${text}`
    );
  }

  return text;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/reasoning.test.ts`
Expected: PASS (7 tests — 5 existing plus 2 new)

- [ ] **Step 5: Commit**

```bash
git add src/reasoning.ts src/reasoning.test.ts
git commit -m "feat: add simplified summary generation for non-technical readers"
```

---

## Task 4: Wire PDF generation into the pipeline

**Files:**
- Modify: `src/index.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Update `PipelineOptions` and `PipelineResult` in `src/index.ts`**

In `src/index.ts`, change the imports at the top to add `generateSimplifiedSummary`:

```typescript
import { generateReport, generateSimplifiedSummary } from "./reasoning.js";
```

(Replace the existing `import { generateReport } from "./reasoning.js";` line.)

Change the `PipelineOptions` and `PipelineResult` interfaces:

```typescript
export interface PipelineOptions {
  repoPath: string;
  topN: number;
  maxTokens: number;
  generatePdf: boolean;
}

export interface PipelineResult {
  report: string;
  graph: CodeGraph;
  simplifiedSummary?: string;
}
```

- [ ] **Step 2: Add the simplified-summary stage to `runPipeline`**

In `src/index.ts`, replace this block:

```typescript
  const client = new Anthropic({ apiKey });
  const report = await generateReport(client, pack);

  return { report, graph };
}
```

with:

```typescript
  const client = new Anthropic({ apiKey });
  const report = await generateReport(client, pack);

  let simplifiedSummary: string | undefined;
  if (options.generatePdf) {
    simplifiedSummary = await generateSimplifiedSummary(client, report);
  }

  return { report, graph, simplifiedSummary };
}
```

Note: per the design spec, a failure in this stage should NOT discard the already-successful detailed report. That behavior is implemented in `cli.ts` (Step 4 below), not here — `runPipeline` still throws normally if `generateSimplifiedSummary` fails, and the CLI layer is responsible for catching that specific failure mode separately from the rest of the pipeline. This keeps `runPipeline` itself simple (single error path) while letting the CLI apply different handling to a stage that runs after the primary deliverable is already complete.

- [ ] **Step 3: Update `src/cli.test.ts` if needed**

Read `src/cli.test.ts` first. Its two existing tests only test `runPipeline`'s early-error paths (`/does not exist/` and `/No parseable/`), both of which throw before reaching `options.generatePdf` at all. Update the two `runPipeline(...)` calls in that file to include `generatePdf: false` in the options object passed, since `PipelineOptions` is now a required field on the interface (TypeScript will flag this as a compile error otherwise — fix it so the test file still type-checks):

```typescript
runPipeline({ repoPath: "/nonexistent/path/xyz", topN: 5, maxTokens: 50000, generatePdf: false })
```

and

```typescript
runPipeline({ repoPath: emptyDir, topN: 5, maxTokens: 50000, generatePdf: false })
```

- [ ] **Step 4: Run tests to verify nothing broke**

Run: `npx vitest run src/cli.test.ts`
Expected: PASS (2 tests)

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean, no errors

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/cli.test.ts
git commit -m "feat: wire optional simplified-summary generation into runPipeline"
```

---

## Task 5: CLI `--pdf` flag

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Read the current `src/cli.ts` to confirm exact structure before editing**

The file currently has this `action` handler body (as of the previous task):

```typescript
  .action(
    async (
      repoPath: string,
      opts: { out: string; topN: string; verbose: boolean; debugGraph: boolean }
    ) => {
      try {
        if (opts.verbose) console.error(`Analyzing ${repoPath}...`);
        const { report, graph } = await runPipeline({
          repoPath,
          topN: Number.parseInt(opts.topN, 10),
          maxTokens: 50000,
        });
        await writeFile(opts.out, report, "utf8");
        console.error(`Report written to ${opts.out}`);

        if (opts.debugGraph) {
          const graphPath = `${opts.out}.graph.json`;
          await writeFile(graphPath, JSON.stringify(graph, null, 2), "utf8");
          console.error(`Graph dumped to ${graphPath}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`archie: ${message}`);
        process.exitCode = 1;
      }
    }
  );
```

- [ ] **Step 2: Add the `--pdf` option and wire it through**

Replace the entire `program.command("analyze")...` block in `src/cli.ts` with:

```typescript
program
  .command("analyze")
  .argument("<path>", "path to the repository to analyze")
  .option("--out <file>", "output path for the report", "./archie-report.md")
  .option("--topN <n>", "number of top-risk files to include in detail", "10")
  .option("--verbose", "print pipeline progress to stderr", false)
  .option("--debug-graph", "dump the raw graph to <out>.graph.json", false)
  .option("--pdf", "also generate a simplified PDF summary at <out>.pdf", false)
  .action(
    async (
      repoPath: string,
      opts: { out: string; topN: string; verbose: boolean; debugGraph: boolean; pdf: boolean }
    ) => {
      let report: string;
      let graph: import("./types.js").CodeGraph;
      let simplifiedSummary: string | undefined;

      try {
        if (opts.verbose) console.error(`Analyzing ${repoPath}...`);
        const result = await runPipeline({
          repoPath,
          topN: Number.parseInt(opts.topN, 10),
          maxTokens: 50000,
          generatePdf: false,
        });
        report = result.report;
        graph = result.graph;
        await writeFile(opts.out, report, "utf8");
        console.error(`Report written to ${opts.out}`);

        if (opts.debugGraph) {
          const graphPath = `${opts.out}.graph.json`;
          await writeFile(graphPath, JSON.stringify(graph, null, 2), "utf8");
          console.error(`Graph dumped to ${graphPath}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`archie: ${message}`);
        process.exitCode = 1;
        return;
      }

      if (opts.pdf) {
        try {
          if (opts.verbose) console.error("Generating simplified PDF summary...");
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (!apiKey) {
            throw new Error("ANTHROPIC_API_KEY environment variable is missing");
          }
          const { default: Anthropic } = await import("@anthropic-ai/sdk");
          const { generateSimplifiedSummary } = await import("./reasoning.js");
          const { convertToPdf } = await import("./pdf.js");

          const client = new Anthropic({ apiKey });
          simplifiedSummary = await generateSimplifiedSummary(client, report);

          const pdfPath = opts.out.replace(/\.md$/, "") + ".pdf";
          await convertToPdf(simplifiedSummary, pdfPath);
          console.error(`Simplified PDF summary written to ${pdfPath}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`archie: warning: PDF summary generation failed: ${message}`);
        }
      }
    }
  );
```

Note: this deliberately calls `generateSimplifiedSummary`/`convertToPdf` directly from the CLI layer (re-implementing the second Claude call here, rather than via `runPipeline`'s `generatePdf` option from Task 4) so that a PDF-stage failure can be caught independently and treated as a non-fatal warning, per the design spec's error-handling section — `runPipeline`'s `generatePdf` option from Task 4 still exists for programmatic/library callers who want both stages handled as one atomic call that throws on any failure, but the CLI itself uses the split-error-handling path for its own UX. `runPipeline` is therefore called with `generatePdf: false` always from the CLI, and the CLI does its own second call when `--pdf` is passed.

- [ ] **Step 3: Build and smoke-test the CLI help output**

Run: `npm run build && node dist/cli.js analyze --help`
Expected: prints usage text including `--out`, `--topN`, `--verbose`, `--debug-graph`, `--pdf` options, exit code 0

- [ ] **Step 4: Run full test suite and typecheck**

Run: `npx vitest run`
Expected: all tests PASS

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: clean, no errors

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add --pdf flag for simplified PDF summary generation"
```

---

## Task 6: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all tests across all files PASS

- [ ] **Step 2: Run against this repo with `--pdf`**

Run (requires `ANTHROPIC_API_KEY` to be set in the shell): `npm run build && node dist/cli.js analyze . --out archie-report.md --pdf --verbose`
Expected: exits 0, `archie-report.md` is created (detailed report), `archie-report.pdf` is created (simplified summary)

- [ ] **Step 3: Manually review `archie-report.pdf`**

Open the PDF and confirm:
- It's noticeably shorter than `archie-report.md`
- It contains no file paths, line numbers, or complexity scores
- It reads coherently as a standalone summary for a non-technical reader
- Its conclusions are consistent with (not contradicting) `archie-report.md`

- [ ] **Step 4: Verify non-fatal PDF failure behavior**

Run with an invalid API key to force a PDF-stage failure after a successful detailed report:
`ANTHROPIC_API_KEY=invalid-key node dist/cli.js analyze . --out test-failure-report.md --pdf --verbose`

This will fail at the detailed-report stage too (since the same key is used for both calls), so this specific test doesn't isolate the PDF-only failure path with a single invalid key. Instead, verify the behavior by temporarily reading the code: confirm in `src/cli.ts` that the `try/catch` around the PDF stage is structurally separate from the `try/catch` around the detailed-report stage (already true from Step 2 above), and that `process.exitCode` is only set to `1` in the first `catch` block, not the second. This confirms the design intent (PDF failure does not fail the overall run) is implemented, even without an easy way to trigger only-the-second-call-fails in a manual test.

- [ ] **Step 5: Clean up test artifacts**

```bash
rm -f test-failure-report.md
```

- [ ] **Step 6: Commit verification note** (only if any fixes were needed during verification; otherwise skip — no commit needed for a clean verification pass)

---

## Self-Review Notes

- **Spec coverage:** All components from the design spec are covered — `src/pdf.ts` (Task 2), `generateSimplifiedSummary` (Task 3), pipeline wiring (Task 4), CLI flag with non-fatal error handling (Task 5), manual verification including the consistency/jargon checks the spec calls for (Task 6).
- **Placeholder scan:** No TBDs; all steps contain complete code.
- **Type consistency:** `generateSimplifiedSummary(client: Anthropic, technicalReport: string): Promise<string>` is defined once in Task 3 and used identically in Task 5. `PipelineOptions`/`PipelineResult` are extended once in Task 4 and the CLI in Task 5 conforms to the updated shape (passing `generatePdf: false` since the CLI implements its own separate PDF stage rather than using `runPipeline`'s built-in one — this is intentional per Task 5's note, not an inconsistency).
- **Design deviation flagged inline:** Task 5 deliberately doesn't use `runPipeline`'s `generatePdf: true` option from Task 4 — it re-implements the second call at the CLI layer instead, to get independent error handling. This was called out explicitly in Task 5's note rather than left as a silent inconsistency between the two tasks.
