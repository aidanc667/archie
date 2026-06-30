# ARCHIE v1 — Design Spec

## Goal

A TypeScript CLI, `archie analyze <path>`, that parses a local TypeScript/JavaScript
repository, builds an in-memory code graph, runs static analysis, and calls Claude
once to produce a markdown "Senior Engineer Simulation Report" — the core wedge
feature of the larger ARCHIE product (see original product spec for full vision).

This is deliberately the smallest slice that validates whether LLM-generated
architectural judgment on a real codebase is useful, before building GitHub
integration, a web UI, or the two-pass critic pipeline.

## Non-goals (explicitly out of scope for v1)

- GitHub OAuth, repo cloning, PR fetching, webhooks
- PR diff review / pre-review intelligence
- Critic agent (second LLM pass) — deferred to v2
- Web UI / Next.js frontend / D3/Cytoscape visualization
- Neo4j or any persistent graph store — in-memory only
- Multi-language parsing — TS/JS only
- Embeddings / vector DB
- Architecture drift detection (requires historical tracking)

## Pipeline

```
Local repo path
  → File walker (find .ts/.tsx/.js/.jsx, respect .gitignore)
  → tree-sitter parser (extract functions, classes, imports per file)
  → In-memory graph builder (nodes: files/functions/classes; edges: imports/calls)
  → Static analysis (file size, import fan-in/out, rough cyclomatic complexity)
  → Graph summarizer (condense graph + metrics into a token-budget-safe summary)
  → Claude API call (single pass) → Senior Engineer Report
  → Write report.md to output path
```

## Components

1. **File walker** — recursive scan starting at the given path, finds
   `.ts/.tsx/.js/.jsx` files, excludes `node_modules`, honors `.gitignore`.

2. **Parser** — `web-tree-sitter` with TypeScript and JavaScript grammars.
   Extracts a per-file symbol table: functions, classes, imports, exported names.

3. **Graph builder** — resolves import statements to local files where possible
   (relative imports; best-effort for path aliases). Builds edges for imports and,
   where statically resolvable from the AST, function call relationships. Not a
   full type-checker — call resolution is best-effort, not exhaustive.

   **Graph schema:**

   Nodes:
   - `FileNode` — `{ id, path, loc }`
   - `FunctionNode` — `{ id, name, fileId, startLine, endLine }`
   - `ClassNode` — `{ id, name, fileId, startLine, endLine }`

   Edges:
   - `CONTAINS` (FileNode → FunctionNode | ClassNode)
   - `IMPORTS` (FileNode → FileNode)
   - `CALLS` (FunctionNode → FunctionNode, best-effort resolution)
   - `EXPORTS` (FileNode → FunctionNode | ClassNode)

   Each edge carries a `confidence` field (0–1). Deterministic edges (`CONTAINS`,
   `IMPORTS`, `EXPORTS`) are always 1.0. `CALLS` edges get 1.0 when resolved via
   direct local-symbol reference, 0.5 when resolved heuristically (e.g. name
   matches a single in-scope candidate among several). Confidence is not used
   in v1 scoring logic — it's captured now so call-resolution quality can
   improve later without a schema change.

4. **Static analysis** — per file: lines of code, import fan-in count, import
   fan-out count, naive cyclomatic complexity (branch/loop/conditional counting
   on the AST, not a full control-flow graph), and dependency depth (longest
   import chain reachable from the file).

   **Risk score** (per file, used for ranking in the summarizer):
   ```
   risk_score =
     0.4 * normalized(complexity) +
     0.3 * normalized(fan_in) +
     0.2 * normalized(file_size) +
     0.1 * normalized(dependency_depth)
   ```
   Each component is normalized to 0–1 against the repo's own distribution
   (min-max scaling) before weighting, so the score is comparable across
   repos of different sizes.

5. **Summarizer** — large repos won't fit in an LLM context window. Ranks files
   by `risk_score` and includes the top N files plus their immediate graph
   neighbors in full detail, with aggregate statistics (file count, total LOC,
   average complexity) for the rest. N is configurable but defaults to a value
   tuned to fit comfortably under Claude's context window alongside the system
   prompt and report generation. If the selected detail set still exceeds the
   token budget, the summarizer aggressively prunes lowest-risk nodes from the
   detail set first (neighbors before top-N files) until it fits.

   Produces a structured **LLM Context Pack** (not raw graph dump):
   - System summary (repo name, file count, total LOC, language)
   - Top risk files (path, risk_score, contributing metrics)
   - Graph snapshot (compressed: only CONTAINS/IMPORTS/CALLS edges touching
     the detail set, as a compact adjacency list)
   - Metrics table (per detail-set file: LOC, fan-in, fan-out, complexity)
   - Key dependency clusters (groups of files with dense mutual IMPORTS edges)

6. **Reasoning layer** — single Claude API call. System prompt instructs the
   model to behave as a Staff Engineer evaluating system architecture, given
   the LLM Context Pack. The prompt enforces a strict output schema — Claude
   must always return exactly these five sections, in this order and these
   headings, with no additional or reordered sections:
   ```
   1. System Summary
   2. Top 5 Architectural Risks
   3. Production Failure Scenarios
   4. Refactor Plan (step-by-step)
   5. Senior Engineer Verdict
   ```
   If the response doesn't contain all five expected headings, the CLI treats
   it as a failed generation and surfaces an error rather than writing a
   malformed report (no retry loop in v1 — see Error handling).

7. **Output** — writes the report to `archie-report.md` in the current working
   directory by default, or to a path given via `--out`.

## Error handling

Fail fast with a clear, actionable message for:
- Path does not exist or is not a directory
- No parseable TS/JS files found
- `ANTHROPIC_API_KEY` environment variable is missing
- Claude API call fails (network/auth/rate-limit) — surface the error, no retry logic in v1
- Claude response is missing one or more of the five required output sections — surface the raw response and an error, do not write `archie-report.md`

No fallback behavior beyond these checks — this is a CLI tool for direct use,
not a service with uptime requirements.

## Testing

- Unit tests for: file walker (fixture directory trees, `.gitignore` handling),
  parser extraction (fixture files with known functions/classes/imports), graph
  builder (known import graphs resolve to expected edges), complexity scoring
  (fixture files with known branch counts).
- The Claude call itself is not meaningfully unit-testable. Acceptance testing
  is manual: run `archie analyze` against a real repository (this repo, or
  another of the user's) and review report quality directly.

## Tech stack

- **Language:** TypeScript, run via Node.js
- **CLI framework:** TBD at implementation time (e.g. `commander` or similar) — no strong constraint
- **Parsing:** `web-tree-sitter` + TypeScript/JavaScript grammars
- **LLM:** Anthropic API (Claude), via `@anthropic-ai/sdk`
- **Graph:** plain in-memory data structures (no graph DB)

## Why this scope (alternatives considered)

Considered starting with the full GitHub-integrated web app (OAuth, PR diffing,
Next.js UI) first, since that's the eventual product surface. Rejected for v1
because it triples the surface area (auth, hosting, webhooks) before validating
the actually-hard, actually-uncertain part: whether an LLM can produce
genuinely useful architectural judgment from a code graph. A local CLI lets
that be iterated on with zero infrastructure.

Considered including the Critic Agent (second LLM pass) from the start, per the
original spec's two-pass design. Deferred to v2 — single-pass report quality
should be validated before adding a second LLM call's worth of complexity and
cost.

Chose TypeScript over Python (the spec's other listed option) because the
eventual product is a Next.js web app sharing graph-building/analysis logic
with the frontend — a single-language stack avoids a rewrite or a
cross-language microservice boundary later. tree-sitter has solid Node
bindings, so there's no real capability gap for v1's scope.
