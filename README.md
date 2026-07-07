# Archie

Archie is an AI-powered architecture reviewer for codebases. It parses your code with real AST parsing (not regex or heuristics), builds a dependency graph across every file, ranks files by how risky they are to change, and sends only the riskiest ones to Claude for a grounded, evidence-backed review — one that isn't allowed to claim a file has no tests or no error handling unless that's actually true in the graph.

It runs two ways: as a CLI you point at any local repo, or as a step in a GitHub Action that reviews every pull request automatically.

## See it in action

[`examples/deepinsight-report.md`](examples/deepinsight-report.md) is a real, unedited report from a live run against [DeepInsight](https://github.com/aidanc667/DeepInsight), a ~7,000 LOC production Next.js/TypeScript app. It caught a race condition in concurrent promise handling, a client-side auth guard with no corresponding code that ever sets the session key it checks, an untested 986-line god-component, and a fan-in-15 data transformer with no error handling — with root causes, reproduction scenarios, and a step-by-step refactor plan formatted to paste directly into Claude Code.

## Quickstart

```bash
git clone https://github.com/aidanc667/archie
cd archie
npm install
npm run build

export ANTHROPIC_API_KEY=sk-...
node dist/cli.js analyze /path/to/your/repo
```

This writes `archie-report.md` in the current directory.

## How it works

1. Parses every TypeScript, JavaScript, and Python file using tree-sitter to extract functions, classes, and imports.
2. Builds a dependency graph across the whole repo — which files import which, how many files depend on each file (fan-in), and whether each file has a matching test file.
3. Scores every file for risk using complexity, fan-in, and test coverage, and picks the riskiest ones.
4. Sends only those files to Claude through a two-pass, tool-calling pipeline. The model can only claim a file lacks tests or error handling if the graph actually confirms it — this is what stops it from hallucinating risks that aren't there.
5. Assembles a report: a system summary, the top risks with root cause and evidence, concrete production failure scenarios, and a refactor plan written as ready-to-paste Claude Code instructions.

## Commands

### `archie analyze <path>`

| Flag | Description |
|---|---|
| `--out <file>` | Output path for the report (default `./archie-report.md`) |
| `--topN <n>` | Number of top-risk files to review in detail (default `10`) |
| `--diff <branch>` | Only analyze files changed vs. the given branch — used for PR review |
| `--json` | Print structured JSON to stdout instead of writing a markdown file |
| `--pdf` | Also generate a simplified, non-technical PDF summary |
| `--watch` | Re-run automatically on every file change |
| `--no-cache` | Skip the parse cache |
| `--verbose` | Print pipeline progress to stderr |

### `archie fix <repo> --report <path>`

Takes an existing Archie report and, for each refactor step, hands it to a second headless Claude Code agent to implement and verify. Nothing is committed automatically — each change is shown to you with a build/test result, and you approve or reject it before it's kept.

## Using it on GitHub pull requests

Add a workflow like this to the repo you want reviewed:

```yaml
# .github/workflows/archie-pr-review.yml
name: Archie PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  archie-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: aidanc667/archie@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Then add an `ANTHROPIC_API_KEY` repo secret (Settings → Secrets and variables → Actions). Archie will comment its review directly on every pull request.

`aidanc667/archie@v1` is a composite Action (see [`action.yml`](action.yml)) — it checks out and builds Archie fresh on every run and posts the PR comment itself, so this is the entire setup; no manual multi-step workflow to copy. `top-n` is also configurable (`with: { top-n: '15' }`) if you want more files reviewed in detail per run.

## Testing

`npm test` runs 125 tests across 15 files (Vitest), covering the parser, graph construction, risk scoring, the fix pipeline, and CLI integration.
