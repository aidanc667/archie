# Grounding and Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ARCHIE from making unverifiable "absence" claims (no tests, no validation, no lock) by making test coverage a checked graph fact instead of a guess, tightening the system prompt to forbid ungrounded absence claims, and measuring the false-positive rate on real external repos before further feature work.

**Architecture:** Add a `TESTED_BY` edge type to the code graph, detected by filename convention (`<name>.test.<ext>` / `<name>.spec.<ext>` in the same directory as `<name>.<ext>`). Thread a `hasTests: boolean` field onto `TopRiskFile` in the Context Pack so Claude can check coverage directly instead of inferring it from graph silence. Tighten `SYSTEM_PROMPT` in `reasoning.ts` to forbid any absence claim not backed by a field or source actually present in the pack. Close with a manual validation pass against 5-10 external repos to measure the absence-claim false-positive rate.

**Tech Stack:** TypeScript, vitest, existing ARCHIE graph/summarizer/reasoning pipeline — no new dependencies.

---

### Task 1: Add `TESTED_BY` edge type to graph schema

**Files:**
- Modify: `src/types.ts`
- Test: `src/types.test.ts`

- [ ] **Step 1: Read the existing types test for style**

Run: `cat src/types.test.ts`

- [ ] **Step 2: Write the failing test**

Add to `src/types.test.ts` (inside the existing `describe` block, or as a new one if the file has no top-level describe — match whatever's already there):

```typescript
import type { Edge } from "./types.js";

describe("EdgeType", () => {
  it("allows TESTED_BY as a valid edge type", () => {
    const edge: Edge = { type: "TESTED_BY", from: "file:a.ts", to: "file:a.test.ts", confidence: 1.0 };
    expect(edge.type).toBe("TESTED_BY");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/types.test.ts`
Expected: FAIL with a TypeScript error — `"TESTED_BY"` is not assignable to type `EdgeType`.

- [ ] **Step 4: Add `TESTED_BY` to `EdgeType`**

In `src/types.ts`, change:

```typescript
export type EdgeType = "CONTAINS" | "IMPORTS" | "CALLS" | "EXPORTS";
```

to:

```typescript
export type EdgeType = "CONTAINS" | "IMPORTS" | "CALLS" | "EXPORTS" | "TESTED_BY";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/types.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/types.test.ts
git commit -m "feat: add TESTED_BY edge type to graph schema"
```

---

### Task 2: Detect test files and emit `TESTED_BY` edges in the graph builder

**Files:**
- Modify: `src/graph.ts`
- Test: `src/graph.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/graph.test.ts`:

```typescript
  it("emits a TESTED_BY edge from a source file to its same-directory .test.ts file", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/src/metrics.ts",
        { loc: 20, parsed: { functions: [], classes: [], imports: [] } },
      ],
      [
        "/repo/src/metrics.test.ts",
        { loc: 15, parsed: { functions: [], classes: [], imports: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const testedByEdges = graph.edges.filter((e) => e.type === "TESTED_BY");
    expect(testedByEdges).toHaveLength(1);
    expect(testedByEdges[0].from).toBe("file:src/metrics.ts");
    expect(testedByEdges[0].to).toBe("file:src/metrics.test.ts");
  });

  it("emits a TESTED_BY edge for .spec. files too, and does not emit one when no test file exists", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/src/walker.ts",
        { loc: 20, parsed: { functions: [], classes: [], imports: [] } },
      ],
      [
        "/repo/src/walker.spec.ts",
        { loc: 15, parsed: { functions: [], classes: [], imports: [] } },
      ],
      [
        "/repo/src/orphan.ts",
        { loc: 5, parsed: { functions: [], classes: [], imports: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const testedByEdges = graph.edges.filter((e) => e.type === "TESTED_BY");
    expect(testedByEdges).toHaveLength(1);
    expect(testedByEdges[0].from).toBe("file:src/walker.ts");
    expect(testedByEdges[0].to).toBe("file:src/walker.spec.ts");

    const orphanHasTest = testedByEdges.some((e) => e.from === "file:src/orphan.ts");
    expect(orphanHasTest).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/graph.test.ts`
Expected: FAIL — `testedByEdges` has length 0 in both new tests.

- [ ] **Step 3: Implement test-file detection and `TESTED_BY` edges**

In `src/graph.ts`, add this helper near the top of the file (after the `resolveImport` function, before `buildGraph`):

```typescript
const TEST_SUFFIX_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

function testTargetKey(relPath: string): string {
  const dir = path.dirname(relPath);
  const base = path.basename(relPath).replace(TEST_SUFFIX_RE, "");
  return path.join(dir, base);
}

function sourceKey(relPath: string): string {
  const dir = path.dirname(relPath);
  const ext = path.extname(relPath);
  const base = path.basename(relPath, ext);
  return path.join(dir, base);
}
```

Then in `buildGraph`, after Pass 3 (the IMPORTS resolution loop), add a new pass:

```typescript
  // Pass 4: TESTED_BY edges — link each non-test source file to a same-directory
  // test file matching the `<name>.test.<ext>` / `<name>.spec.<ext>` convention.
  // This makes "has tests" a checkable graph fact instead of something the LLM
  // has to infer from the file's absence in the context pack.
  const testFileIdByKey = new Map<string, string>();
  for (const absPath of parsedByFile.keys()) {
    const relPath = path.relative(root, absPath);
    if (TEST_SUFFIX_RE.test(relPath)) {
      testFileIdByKey.set(testTargetKey(relPath), fileIdByAbsPath.get(absPath)!);
    }
  }
  for (const absPath of parsedByFile.keys()) {
    const relPath = path.relative(root, absPath);
    if (TEST_SUFFIX_RE.test(relPath)) continue;
    const testFileId = testFileIdByKey.get(sourceKey(relPath));
    if (testFileId) {
      edges.push({ type: "TESTED_BY", from: fileIdByAbsPath.get(absPath)!, to: testFileId, confidence: 1.0 });
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/graph.test.ts`
Expected: PASS (all tests in the file, including the two new ones)

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/graph.ts src/graph.test.ts
git commit -m "feat: detect test files and emit TESTED_BY edges in graph builder"
```

---

### Task 3: Thread `hasTests` onto `TopRiskFile` in the Context Pack

**Files:**
- Modify: `src/summarizer.ts`
- Test: `src/summarizer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/summarizer.test.ts`:

```typescript
  it("sets hasTests=true on a top-risk file with a TESTED_BY edge, and false otherwise", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 100 },
        { kind: "file", id: "file:a.test.ts", path: "a.test.ts", loc: 30 },
        { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 },
      ],
      edges: [
        { type: "TESTED_BY", from: "file:a.ts", to: "file:a.test.ts", confidence: 1.0 },
      ],
    };
    const scores: RiskScore[] = [
      { fileId: "file:a.ts", riskScore: 0.9, complexity: 10, fanIn: 0, loc: 100, dependencyDepth: 1 },
      { fileId: "file:b.ts", riskScore: 0.5, complexity: 5, fanIn: 1, loc: 10, dependencyDepth: 0 },
    ];

    const pack = buildContextPack(graph, scores, new Map(), { topN: 2, maxTokens: 50000 });

    const fileA = pack.topRiskFiles.find((f) => f.path === "a.ts");
    const fileB = pack.topRiskFiles.find((f) => f.path === "b.ts");
    expect(fileA?.hasTests).toBe(true);
    expect(fileB?.hasTests).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/summarizer.test.ts`
Expected: FAIL — `fileA?.hasTests` is `undefined`, not `true`.

- [ ] **Step 3: Add `hasTests` to `TopRiskFile` and compute it**

In `src/summarizer.ts`, update the `TopRiskFile` interface:

```typescript
export interface TopRiskFile {
  path: string;
  riskScore: number;
  complexity: number;
  fanIn: number;
  loc: number;
  source: string;
  hasTests: boolean;
}
```

Add a helper function near `pathByFileId`:

```typescript
function testedFileIds(graph: CodeGraph): Set<string> {
  const set = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type === "TESTED_BY") set.add(edge.from);
  }
  return set;
}
```

In `buildContextPack`, after `const systemSummary = buildSystemSummary(graph);`, add:

```typescript
  const tested = testedFileIds(graph);
```

Then in the `topRiskFiles` mapping inside the pruning loop, add the field:

```typescript
    const topRiskFiles: TopRiskFile[] = topN.map((s) => ({
      path: paths.get(s.fileId) ?? s.fileId,
      riskScore: s.riskScore,
      complexity: s.complexity,
      fanIn: s.fanIn,
      loc: s.loc,
      source: sourceByPath.get(s.fileId) ?? "",
      hasTests: tested.has(s.fileId),
    }));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/summarizer.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: All tests pass. (The existing summarizer tests construct `TopRiskFile` results via `buildContextPack`, not by hand, so they should be unaffected — but check the diff output for any test that asserts the full shape of a `TopRiskFile` object directly, e.g. with `toEqual`, and update it to include `hasTests`.)

- [ ] **Step 6: Commit**

```bash
git add src/summarizer.ts src/summarizer.test.ts
git commit -m "feat: thread hasTests field onto TopRiskFile in Context Pack"
```

---

### Task 4: Tighten the system prompt to forbid ungrounded absence claims

**Files:**
- Modify: `src/reasoning.ts`
- Test: `src/reasoning.test.ts`

- [ ] **Step 1: Write a failing test asserting the prompt content via the exported report contract**

`SYSTEM_PROMPT` is not exported, so we can't assert its literal string from a test (and shouldn't — that would be a brittle test of prose, not behavior). Instead, export a small, testable piece of the rule as a named constant so it's both reusable and verifiable.

Add to `src/reasoning.test.ts`:

```typescript
import { ABSENCE_CLAIM_RULE } from "./reasoning.js";

describe("ABSENCE_CLAIM_RULE", () => {
  it("explicitly forbids claiming a file lacks tests unless hasTests is present and false", () => {
    expect(ABSENCE_CLAIM_RULE).toMatch(/hasTests/);
    expect(ABSENCE_CLAIM_RULE.toLowerCase()).toMatch(/insufficient visibility/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/reasoning.test.ts`
Expected: FAIL — `ABSENCE_CLAIM_RULE` is not exported from `./reasoning.js`.

- [ ] **Step 3: Extract and tighten the grounding rule into an exported constant**

In `src/reasoning.ts`, replace the existing inline grounding bullet inside `SYSTEM_PROMPT` with a reference to a new exported constant. Change:

```typescript
const SYSTEM_PROMPT = `You are a Staff Engineer evaluating a codebase's architecture.
You will be given a Context Pack: a system summary, top-risk files with metrics and
full source code, a compressed dependency graph snapshot, and (if the repo is large)
cluster-level aggregates instead of per-file detail.

Rules:
- Only reason from facts present in the Context Pack. Never invent files, functions,
  dependencies, or relationships not present in the data given to you.
- Top-risk files include their full source code. Before claiming something is
  "missing," "absent," or "has no evidence of" (e.g. error handling, a guard clause,
  a cycle check), you MUST check the actual source code included for that file, not
  just its metrics. If the source for a file is not included (e.g. it wasn't a
  top-risk file, or the pack fell back to cluster-summary mode), say
  "insufficient visibility" rather than guessing.
- Always respond with exactly these five sections, in this order, using these
  exact headings:
1. System Summary
2. Top 5 Architectural Risks
3. Production Failure Scenarios
4. Refactor Plan (step-by-step)
5. Senior Engineer Verdict
Do not add, omit, or reorder sections.`;
```

to:

```typescript
export const ABSENCE_CLAIM_RULE = `- Never claim a file or system "lacks," "is missing," "has no evidence of," or
  "does not have" something (tests, error handling, a guard clause, validation,
  a lock, etc.) unless the Context Pack gives you a concrete way to check it:
  - For test coverage specifically: each top-risk file has a \`hasTests\` boolean.
    Only state a file has no tests if \`hasTests\` is present and false. If a file
    is not in \`topRiskFiles\` at all, you have no test-coverage information about
    it — do not claim it lacks tests.
  - For anything else (error handling, locks, validation, duplicate logic, etc.):
    only claim absence if the file's full \`source\` is included in the Context
    Pack and you have actually read it looking for that thing.
  - If you cannot verify presence or absence because the relevant file's source
    or fields are not in the Context Pack, say "insufficient visibility" instead
    of asserting absence. A claim of absence without a verifiable basis is a
    fabrication, not a finding.`;

const SYSTEM_PROMPT = `You are a Staff Engineer evaluating a codebase's architecture.
You will be given a Context Pack: a system summary, top-risk files with metrics,
full source code, and a \`hasTests\` flag, a compressed dependency graph snapshot,
and (if the repo is large) cluster-level aggregates instead of per-file detail.

Rules:
- Only reason from facts present in the Context Pack. Never invent files, functions,
  dependencies, or relationships not present in the data given to you.
${ABSENCE_CLAIM_RULE}
- Always respond with exactly these five sections, in this order, using these
  exact headings:
1. System Summary
2. Top 5 Architectural Risks
3. Production Failure Scenarios
4. Refactor Plan (step-by-step)
5. Senior Engineer Verdict
Do not add, omit, or reorder sections.`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/reasoning.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite and build to check for regressions**

Run: `npm run build && npx vitest run`
Expected: Clean build, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/reasoning.ts src/reasoning.test.ts
git commit -m "feat: forbid ungrounded absence claims, ground test-coverage claims in hasTests"
```

---

### Task 5: Wire `hasTests` through the pipeline types (verify no gaps)

**Files:**
- Modify: `src/index.ts` (only if a type error surfaces)
- Test: none new — this task is a verification pass, not new behavior

- [ ] **Step 1: Build and run the full suite**

Run: `npm run build && npx vitest run`
Expected: Clean build, all tests passing. `index.ts` calls `buildContextPack(graph, scores, sourceByPath, ...)` and doesn't construct `TopRiskFile` directly, so this should already be green from Tasks 1-4. This step exists to catch any spot that does construct a `TopRiskFile` or `ContextPack` by hand (e.g. a stray fixture) that the earlier steps missed.

- [ ] **Step 2: If the build fails on a missing `hasTests` field**

Grep for any other hand-built `TopRiskFile` literals:

Run: `grep -rn "TopRiskFile" src/ --include="*.ts"`

Add `hasTests: false` (or the correct computed value) to any literal found outside `summarizer.ts` and its test file.

- [ ] **Step 3: Commit (only if Step 2 required changes)**

```bash
git add -A
git commit -m "fix: add hasTests to remaining TopRiskFile construction sites"
```

(Skip this commit if Step 1 was already clean.)

---

### Task 6: Manual validation — measure the absence-claim false-positive rate

**Files:** none (this is a manual verification task, not a code change)

This task answers the advisor's question directly: *on unfamiliar repos, what fraction of ARCHIE's absence claims turn out to be false?* Do not skip it — Tasks 1-5 are a hypothesis about how to fix overclaiming, and this is the test of that hypothesis.

- [ ] **Step 1: Pick 5-10 external TS/JS repos you don't own well enough to already know the answer**

Mix sizes/styles — e.g. a few small open-source CLI tools, a mid-size web app, a library with a `__tests__` folder (note: the current convention only matches same-directory `.test.`/`.spec.` files — a repo using a separate `__tests__/` directory will show `hasTests: false` even with real tests; record this as a known limitation, not a false positive, since it's a detection gap rather than an overclaim).

- [ ] **Step 2: Run ARCHIE on each repo**

```bash
cd /path/to/external-repo
node /Users/aidan/Desktop/Archie/dist/cli.js analyze . --out archie-report.md --verbose
```

- [ ] **Step 3: For each report, extract every absence-style claim**

```bash
grep -niE "no (test|lock|mutex|validation|error handling|guard)|lacks|does not have|missing (test|validation|error)" archie-report.md
```

- [ ] **Step 4: For each matched claim, manually check the actual source**

Mark each as:
- **True positive** — claim is correct, verified by reading the code.
- **False positive** — claim is wrong (e.g. tests exist elsewhere, a guard is present).
- **Detection gap** — claim is technically about something ARCHIE can't see (e.g. `__tests__/` convention) rather than a reasoning failure.

- [ ] **Step 5: Compute the false-positive rate**

`false positives / (true positives + false positives)`, excluding detection gaps from the denominator (track them separately — they point at Task 2's convention needing to widen, not at the prompt rule failing).

- [ ] **Step 6: Record results and decide next step**

Write the results (repo list, claim counts, rate) into `docs/superpowers/specs/2026-06-30-grounding-validation-results.md`. If the false-positive rate is under ~5%, the grounding fix worked — safe to move on to npm publish / GitHub integration. If it's 20%+ on a category (e.g. test coverage still gets claimed wrong even with `hasTests`), that means the prompt rule isn't being followed reliably and needs a stronger mechanism (e.g. moving from prose instruction to a structured/forced-field response), not just rewording.

No commit for this task — it produces a findings document, not code. Commit the findings doc itself:

```bash
git add docs/superpowers/specs/2026-06-30-grounding-validation-results.md
git commit -m "docs: record absence-claim false-positive measurement results"
```

---

## Self-Review Notes

- **Spec coverage:** Task 1-2 cover "ingest test files into the graph" (advisor recommendation #2). Tasks 3-4 cover "evidence-tagging / forbid ungrounded absence claims" (advisor recommendation #1). Task 6 covers "validate against repos you don't own" (advisor recommendation #3). Task 5 is a safety-net verification step to catch any construction site Tasks 1-4 missed.
- **Detection convention is intentionally narrow (YAGNI):** only same-directory `.test.`/`.spec.` files are detected, matching ARCHIE's own codebase convention. Task 6 explicitly surfaces this as a known gap rather than silently undercounting — widening it (e.g. to `__tests__/` directories) is a follow-up only if Task 6's data shows it matters.
- **Type consistency check:** `hasTests` is introduced in `types.ts`'s edge type (`TESTED_BY`) in Task 1, produced in `graph.ts` in Task 2, consumed in `summarizer.ts`'s `TopRiskFile` in Task 3, and referenced by name in the `reasoning.ts` prompt in Task 4 — same field name throughout.
