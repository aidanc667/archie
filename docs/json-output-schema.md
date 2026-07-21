# ARCHIE JSON Output Schema

## Command

```
archie analyze <path> --json
```

When `--json` is passed, `archie analyze` writes a single JSON object to stdout instead of writing a markdown report file. Progress/status messages still go to stderr, so stdout contains only the JSON payload (safe to pipe: `archie analyze . --json > out.json`).

The TypeScript type for this shape is `ArchieJsonOutput`, exported from `src/cli.ts`.

## Shape: `ArchieJsonOutput`

```typescript
interface ArchieJsonOutput {
  version: 4;
  repoPath: string;
  topN: number;
  report: string;
  risks: RiskFinding[];
  scenarios: ScenarioFinding[];
  history: { current: HistoryEntry; previous: HistoryEntry | null };
  qualityWarnings: QualityWarning[];
  diff: {
    requested: boolean;
    scoped: boolean;
    changedFileCount: number | null;
    changedFiles: string[];
  };
  graph: {
    fileCount: number;
    nodeCount: number;
    edgeCount: number;
    nodes: GraphNode[];
    edges: Edge[];
  };
}
```

| Field | Type | Description |
|---|---|---|
| `version` | `4` | Schema version of this JSON output, as a literal number. Currently always `4`. See "Stability" below. |
| `repoPath` | `string` | Absolute, resolved filesystem path to the repository that was analyzed (the `<path>` argument, resolved via `path.resolve`). |
| `topN` | `number` | The `--topN` value used for this run (number of top-risk files included in report detail). Parsed from the CLI flag, default `10`. |
| `report` | `string` | The full architecture report as a markdown string. See "Report field structure" below. |
| `risks` | `RiskFinding[]` | The structured per-risk findings the "Top 5 Architectural Risks" section of `report` was rendered from. See "`RiskFinding`" below. |
| `scenarios` | `ScenarioFinding[]` | The structured per-scenario findings the "Production Failure Scenarios" section of `report` was rendered from. See "`ScenarioFinding`" below. |
| `history.current` | `HistoryEntry` | A summary of this run (timestamp, file count, total LOC, top-risk file, average risk score), recorded to `.archie-cache/history.json` in the analyzed repo. See "`HistoryEntry`" below. |
| `history.previous` | `HistoryEntry \| null` | The same summary from the immediately preceding recorded run against this repo, or `null` if there is no prior run (first run, or `--no-cache` was passed, which skips history entirely). Lets a consumer compute a run-over-run risk trend without keeping its own state. |
| `qualityWarnings` | `QualityWarning[]` | Findings from a detection-only self-critique pass over the free-text sections of `report` (System Summary, Refactor Plan, Senior Engineer Verdict) — claims that don't trace back to the Context Pack (e.g. a version number mismatch, a symbol claimed as exported that isn't, an absence claim not backed by the underlying metrics). Empty when the check found nothing wrong, or when the check itself failed and was skipped. See "`QualityWarning`" below. |
| `diff.requested` | `boolean` | Whether `--diff <ref>` was passed at all. |
| `diff.scoped` | `boolean` | Whether analysis was actually restricted to a changed-file set. `false` when `--diff` wasn't passed, when `git diff` found no changed *source* files (falls back to full-repo analysis), or when `git diff` itself failed. |
| `diff.changedFileCount` | `number \| null` | Count of changed source files found by `git diff --name-only <ref> HEAD`, filtered to source extensions. `null` when `--diff` wasn't requested or when `git diff` failed; `0` when it succeeded but found no changed source files. |
| `diff.changedFiles` | `string[]` | Paths of the changed source files found by `git diff --name-only <ref> HEAD`, relative to `repoPath`. Always `[]` when `--diff` wasn't requested, when `git diff` failed, or when it found no changed source files (i.e. whenever `diff.scoped` is `false`). A downstream consumer that wants to post an inline PR review comment can use these paths to know which files are actually part of the PR's diff — GitHub only allows inline comments anchored to files that appear in the diff. |
| `graph.fileCount` | `number` | Count of `FileNode`s only (`graph.nodes.filter(n => n.kind === "file").length`). This is the correct number to use for "N files analyzed" — see the warning below. |
| `graph.nodeCount` | `number` | Total count of *all* nodes in the code graph (files + functions + classes combined), equal to `graph.nodes.length`. **Do not use this as a file count** — see below. |
| `graph.edgeCount` | `number` | Total count of edges in the code graph, equal to `graph.edges.length`. |
| `graph.nodes` | `GraphNode[]` | Full array of graph nodes (files, functions, classes). See "GraphNode" below. |
| `graph.edges` | `Edge[]` | Full array of graph edges (relationships between nodes). See "Edge" below. |

> **Warning — `nodeCount` is not a file count.** `graph.nodes` is a discriminated union of `FileNode`, `FunctionNode`, and `ClassNode`; `nodeCount` sums all three. An earlier version of `scripts/post-pr-comment.mjs` reported `graph.nodeCount` as "changed files" in the PR comment, which produced numbers like "345 changed files" on PRs that touched exactly one file — the real count was every function and class node in the (sometimes full-repo-fallback) graph, not files, and not scoped to the diff. Use `graph.fileCount` for a file count, and `diff.changedFileCount` for the actual diff-scoped count.

## `GraphNode`

`GraphNode` is a discriminated union on the `kind` field, defined in `src/types.ts`:

```typescript
type GraphNode = FileNode | FunctionNode | ClassNode;
```

### `FileNode` (`kind: "file"`)

| Field | Type | Description |
|---|---|---|
| `kind` | `"file"` | Discriminant. |
| `id` | `string` | Unique node id, format `file:<relative/path>`. |
| `path` | `string` | Path to the file, relative to the analyzed repo root. |
| `loc` | `number` | Line count of the file. |

### `FunctionNode` (`kind: "function"`)

| Field | Type | Description |
|---|---|---|
| `kind` | `"function"` | Discriminant. |
| `id` | `string` | Unique node id. |
| `name` | `string` | Function name. |
| `fileId` | `string` | `id` of the containing `FileNode`. |
| `startLine` | `number` | 1-based start line of the function in its file. |
| `endLine` | `number` | 1-based end line of the function in its file. |

### `ClassNode` (`kind: "class"`)

| Field | Type | Description |
|---|---|---|
| `kind` | `"class"` | Discriminant. |
| `id` | `string` | Unique node id. |
| `name` | `string` | Class name. |
| `fileId` | `string` | `id` of the containing `FileNode`. |
| `startLine` | `number` | 1-based start line of the class in its file. |
| `endLine` | `number` | 1-based end line of the class in its file. |

## `Edge`

```typescript
interface Edge {
  type: EdgeType;
  from: string;
  to: string;
  confidence: number;
}
```

| Field | Type | Description |
|---|---|---|
| `type` | `EdgeType` | Relationship type. One of `"CONTAINS"`, `"IMPORTS"`, `"CALLS"`, `"EXPORTS"`, `"TESTED_BY"` (see below). |
| `from` | `string` | `id` of the source node. |
| `to` | `string` | `id` of the target node. |
| `confidence` | `number` | Confidence score (0–1) that this edge is correct. Static analysis of dynamic languages is imperfect; lower values indicate a heuristic/inferred edge rather than a syntactically certain one. |

### `EdgeType` values

- `CONTAINS` — a `FileNode` contains a `FunctionNode`/`ClassNode`.
- `IMPORTS` — a `FileNode` imports another `FileNode`.
- `CALLS` — a function/class calls another function.
- `EXPORTS` — a `FileNode` exports a function/class.
- `TESTED_BY` — a source node is exercised by a test file/node.

## `RiskFinding`

`RiskFinding` is defined in `src/reasoning.ts` (exported from that module — treat it as the authoritative shape if this table and the source ever disagree). Each entry is one structured risk from the model's `report_risks` tool call, one-to-one with an entry rendered into the "Top 5 Architectural Risks" section of `report`.

```typescript
interface RiskFinding {
  title: string;
  file: string;
  severity: "Critical" | "High" | "Medium";
  confidence: "high" | "medium" | "low";
  why_it_matters: string;
  root_cause: string;
  evidence: string;
  complexity: number;
  fanIn: number;
  loc: number;
}
```

| Field | Type | Description |
|---|---|---|
| `title` | `string` | Short, human-readable name for the risk (e.g. "High coupling in the core module"). |
| `file` | `string` | The primary file this risk is attributed to, as a path relative to the analyzed repo root. This is the field a PR-comment consumer should match against `diff.changedFiles` to decide whether the risk can be posted as an inline comment. |
| `severity` | `"Critical" \| "High" \| "Medium"` | The model's severity rating for this risk. |
| `confidence` | `"high" \| "medium" \| "low"` | The model's confidence that this risk is real and correctly diagnosed (static analysis of dynamic languages is imperfect, same caveat as `Edge.confidence`). |
| `why_it_matters` | `string` | One or more sentences explaining the consequence of leaving this risk unaddressed. |
| `root_cause` | `string` | The underlying structural reason this risk exists (e.g. a specific coupling pattern, a missing abstraction). |
| `evidence` | `string` | The concrete signal that led the model to flag this risk, typically citing the metrics below (e.g. `"fanIn=14"`). |
| `complexity` | `number` | Cyclomatic-style complexity score for `file`, copied verbatim from the context pack's `topRiskFiles` entry for that file — the model is instructed not to estimate or round this. |
| `fanIn` | `number` | Fan-in (number of other files that import `file`) for `file`, copied verbatim from the context pack. Computed from the whole repo graph, not just a diff-scoped subset. |
| `loc` | `number` | Line count of `file`, copied verbatim from the context pack. |

## `ScenarioFinding`

`ScenarioFinding` is also defined in and exported from `src/reasoning.ts`. Each entry is one structured failure scenario from the model's `report_scenarios` tool call, one-to-one with an entry rendered into the "Production Failure Scenarios" section of `report`.

```typescript
interface ScenarioFinding {
  title: string;
  trigger: string;
  chain_of_failure: string;
  business_impact: string;
  likelihood: "High" | "Medium" | "Low";
  likelihood_justification: string;
}
```

| Field | Type | Description |
|---|---|---|
| `title` | `string` | Short, human-readable name for the failure scenario. |
| `trigger` | `string` | The specific event or condition that sets the failure in motion (e.g. "A malformed payload is sent to the ingest endpoint."). |
| `chain_of_failure` | `string` | The causal sequence from trigger to failure — what breaks, and why, step by step. |
| `business_impact` | `string` | The real-world consequence if this scenario occurs (e.g. data loss, an outage, growing backlog). |
| `likelihood` | `"High" \| "Medium" \| "Low"` | The model's estimate of how likely this scenario is to occur. |
| `likelihood_justification` | `string` | One or more sentences explaining the reasoning behind the `likelihood` rating. |

## `HistoryEntry`

`HistoryEntry` is defined in and exported from `src/history.ts` — treat it as the authoritative shape if this table and the source ever disagree.

```typescript
interface HistoryEntry {
  timestamp: string;
  fileCount: number;
  totalLoc: number;
  topRiskFile: { path: string; riskScore: number } | null;
  averageRiskScore: number;
}
```

| Field | Type | Description |
|---|---|---|
| `timestamp` | `string` | ISO 8601 timestamp of when this run happened (`new Date().toISOString()`). |
| `fileCount` | `number` | Total number of parseable source files found in the repo for this run. |
| `totalLoc` | `number` | Total line count summed across all `FileNode`s in the graph. |
| `topRiskFile` | `{ path: string; riskScore: number } \| null` | The single highest-risk-score file for this run, or `null` if the repo had no scored files. |
| `averageRiskScore` | `number` | Mean risk score across all scored files for this run. |

## `QualityWarning`

`QualityWarning` is defined in and exported from `src/reasoning.ts` — treat it as the authoritative shape if this table and the source ever disagree. Each entry is one grounding issue flagged by the detection-only self-critique pass over Sections 1, 4, and 5 of `report`.

```typescript
interface QualityWarning {
  section: string;
  claim: string;
  issue: string;
}
```

| Field | Type | Description |
|---|---|---|
| `section` | `string` | Which report section the flagged claim appears in. |
| `claim` | `string` | The specific offending claim, quoted or closely paraphrased from `report`. |
| `issue` | `string` | Why the claim is considered ungrounded (e.g. "cites Next.js 15 but dependencies field shows 16.2.2"). |

## `report` field structure

`report` is a single markdown string containing exactly 5 fixed section headings, in order:

```
## 1. System Summary
## 2. Top 5 Architectural Risks
## 3. Production Failure Scenarios
## 4. Refactor Plan (step-by-step)
## 5. Senior Engineer Verdict
```

There is currently no structured, per-section JSON representation of the report — only the assembled markdown string. A consumer that wants programmatic access to an individual section (e.g. just the System Summary) must split the string on these heading markers itself. The headings are stable text and safe to match on, e.g. with a regex like `/## \d\. [^\n]+/g` to locate section boundaries.

## Version 3 changes

Version 3 is additive only (no field was removed, renamed, or changed meaning), but it is still a version bump per the stability policy above, since it adds fields a consumer coded strictly against v2's field list wouldn't know to look for:

- **`risks` / `scenarios`** — expose the model's structured findings behind the "Top 5 Architectural Risks" and "Production Failure Scenarios" sections of `report`, rather than only the rendered markdown. Previously, a consumer that wanted per-risk `file` or `severity` (e.g. to decide which PR file to attach a comment to) had to regex-parse markdown headings and prose out of `report`. `scripts/post-pr-comment.mjs` is the motivating case — see "Known consumers" below.
- **`diff.changedFiles`** — the actual changed-file paths (repo-relative), where previously only `diff.changedFileCount` existed. A consumer needs the real paths, not just a count, to determine which files are safe to anchor an inline GitHub PR review comment to (GitHub only allows inline comments on files that appear in the PR's diff).

## Version 4 changes

Version 4 is also additive only, and again still a version bump per the stability policy below:

- **`history`** — exposes the run-over-run risk trend that was previously only ever printed to CLI stderr (the `[history] Highest-risk file: ...` lines `archie analyze` prints in non-`--json` mode). A consumer like the PR-comment script can now compare `history.current` against `history.previous` itself and show something like "risk trending up/down since last run" without scraping stderr or maintaining its own run history.
- **`qualityWarnings`** — exposes the findings from the new self-critique pass (Pass 4 in `generateReport`, `src/reasoning.ts`) that checks Sections 1, 4, and 5 of `report` for claims that don't trace back to the Context Pack. Previously this was only visible as an inline "⚠️ Automated grounding check flagged N potential issue(s)" caveat block spliced into `report`'s markdown. A consumer can now read `qualityWarnings` directly to surface an "automated grounding check flagged N issues" caveat in its own UI, without parsing it back out of the report text.

## Stability

This is schema **version 4**. The `version` field will be incremented whenever a field is added, removed, renamed, or changes meaning in a way that could break an existing consumer. Consumers should:

- Check `version` before parsing.
- Fail loudly (rather than silently guessing) if `version` is not a value they understand — do not assume forward or backward compatibility across versions.

## Known consumers

- `scripts/post-pr-comment.mjs` — the GitHub Action PR-comment script. Runs `archie analyze . --diff <ref> --json`, parses stdout, and reads `.report` (splitting it into sections by the fixed headings above), `.diff.scoped` / `.diff.changedFileCount`, and `.graph.fileCount` / `.graph.edgeCount` to build a PR comment body. As of schema version 4 it does not yet read `.risks`, `.scenarios`, `.diff.changedFiles`, `.history`, or `.qualityWarnings` — a follow-up task will update it to consume structured `.risks`/`.scenarios` directly (instead of parsing them out of `.report`), to use `.diff.changedFiles` to post inline, per-file review comments, and to surface `.history` / `.qualityWarnings` in the PR comment body.
