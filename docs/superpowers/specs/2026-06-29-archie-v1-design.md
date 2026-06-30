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

4. **Static analysis** — per file: lines of code, import fan-in count, import
   fan-out count, naive cyclomatic complexity (branch/loop/conditional counting
   on the AST, not a full control-flow graph).

5. **Summarizer** — large repos won't fit in an LLM context window. Ranks files
   by risk signals (high fan-in, high complexity, large size) and includes the
   top N files plus their immediate graph neighbors in full detail, with
   aggregate statistics (file count, total LOC, average complexity) for the rest.
   N is configurable but defaults to a value tuned to fit comfortably under
   Claude's context window alongside the system prompt and report generation.

6. **Reasoning layer** — single Claude API call. System prompt instructs the
   model to behave as a Staff Engineer evaluating system architecture, given the
   summarized graph and metrics. Output follows the 5-part structure from the
   product spec:
   1. System understanding summary
   2. Architectural risks (ranked)
   3. What will break in production
   4. Refactor plan (step-by-step, concrete)
   5. Senior Engineer Verdict (one paragraph)

7. **Output** — writes the report to `archie-report.md` in the current working
   directory by default, or to a path given via `--out`.

## Error handling

Fail fast with a clear, actionable message for:
- Path does not exist or is not a directory
- No parseable TS/JS files found
- `ANTHROPIC_API_KEY` environment variable is missing
- Claude API call fails (network/auth/rate-limit) — surface the error, no retry logic in v1

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
