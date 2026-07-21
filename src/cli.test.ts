// src/cli.test.ts
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runPipeline } from "./index.js";
import type { ArchieJsonOutput } from "./cli.js";

const execFileAsync = promisify(execFile);

describe("runPipeline", () => {
  it("throws a clear error when the path does not exist", async () => {
    await expect(
      runPipeline({ repoPath: "/nonexistent/path/xyz", topN: 5, maxTokens: 50000, generatePdf: false })
    ).rejects.toThrow(/does not exist/);
  });

  it("throws a clear error when no parseable files are found", async () => {
    const emptyDir = path.resolve("fixtures/empty-repo");
    await expect(
      runPipeline({ repoPath: emptyDir, topN: 5, maxTokens: 50000, generatePdf: false })
    ).rejects.toThrow(/No parseable/);
  });
});

describe("archie fix (CLI integration)", () => {
  it("shows the fix command and its flags in help output", async () => {
    const cliPath = path.resolve("dist/cli.js");
    const { stdout } = await execFileAsync("node", [cliPath, "--help"]);
    expect(stdout).toContain("fix");
  });

  it("shows the --report flag in `fix --help` output", async () => {
    const cliPath = path.resolve("dist/cli.js");
    const { stdout } = await execFileAsync("node", [cliPath, "fix", "--help"]);
    expect(stdout).toContain("--report");
    expect(stdout).toContain("--verbose");
    expect(stdout).toContain("--yes");
  });

  describe("with a clean, isolated git repo fixture", () => {
    let cleanRepoDir: string;

    beforeAll(() => {
      // Use an isolated temp git repo (not fixtures/parser-basic, which lives
      // inside this repo's own working tree and would trip the dirty-tree
      // check depending on the outer repo's current git status).
      cleanRepoDir = mkdtempSync(path.join(tmpdir(), "archie-fix-cli-test-"));
      execFileSync("git", ["init"], { cwd: cleanRepoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: cleanRepoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: cleanRepoDir });
      execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: cleanRepoDir });
    });

    afterAll(() => {
      rmSync(cleanRepoDir, { recursive: true, force: true });
    });

    it("exits non-zero with a clear message when --report points to a non-existent file", async () => {
      const cliPath = path.resolve("dist/cli.js");
      const nonexistentReport = path.join(cleanRepoDir, "does-not-exist-report.md");

      await expect(
        execFileAsync("node", [cliPath, "fix", cleanRepoDir, "--report", nonexistentReport])
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("report file not found"),
      });
    });

    it("does not treat an untracked .archie-cache/ directory as a dirty working tree", async () => {
      const cliPath = path.resolve("dist/cli.js");
      const cacheDir = path.join(cleanRepoDir, ".archie-cache");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(path.join(cacheDir, "history.json"), "{}", "utf8");

      const nonexistentReport = path.join(cleanRepoDir, "does-not-exist-report.md");

      // If the dirty-tree check still refused, the error would mention
      // "dirty working tree" instead of getting past it to the report check.
      await expect(
        execFileAsync("node", [cliPath, "fix", cleanRepoDir, "--report", nonexistentReport])
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("report file not found"),
      });

      rmSync(cacheDir, { recursive: true, force: true });
    });
  });

  // These exercise the real `archie fix --yes` code path end-to-end via a
  // subprocess (dist/cli.js), the same way the tests above do. Since the
  // fix command shells out to a real `claude` binary (see runAgent in
  // src/fix.ts), a fake executable named `claude` is placed at the front of
  // PATH for the subprocess so its exit code is fully controlled without
  // depending on a real Claude Code CLI install or network access -- one
  // script always exits 0 (agent "succeeds"), the other always exits 1
  // (agent "fails"). Neither script touches any files, so there's nothing
  // for the repo-under-test to revert unless the CLI's own logic reverts it.
  describe("archie fix --yes", () => {
    const REPORT_WITH_ONE_STEP = [
      "## 4. Refactor Plan (step-by-step)",
      "",
      "### Step 1: Do the thing",
      "**File:** `src/foo.ts`",
      "",
      "> **Paste into Claude Code to implement this step:**",
      "> Do the thing.",
      "",
      "## 5. Senior Engineer Verdict",
      "",
    ].join("\n");

    function makeCleanRepo(): string {
      const dir = mkdtempSync(path.join(tmpdir(), "archie-fix-yes-repo-"));
      execFileSync("git", ["init"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
      // A real tracked file (not just an empty initial commit) is required
      // here: `git checkout -- .` (used by the fix command's revert path)
      // errors with "pathspec '.' did not match any file(s) known to git"
      // against a repo with zero tracked files, since "." has nothing to
      // resolve to.
      writeFileSync(path.join(dir, "placeholder.txt"), "placeholder\n", "utf8");
      execFileSync("git", ["add", "placeholder.txt"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
      return dir;
    }

    function makeFakeClaudeBin(exitCode: number): string {
      const binDir = mkdtempSync(path.join(tmpdir(), "archie-fake-claude-bin-"));
      writeFileSync(path.join(binDir, "claude"), `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o755 });
      return binDir;
    }

    function writeReport(): string {
      const reportPath = path.join(
        tmpdir(),
        `archie-fix-yes-report-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
      );
      writeFileSync(reportPath, REPORT_WITH_ONE_STEP, "utf8");
      return reportPath;
    }

    it("auto-applies a successful step without prompting when --yes is passed", async () => {
      const cliPath = path.resolve("dist/cli.js");
      const repoDir = makeCleanRepo();
      const binDir = makeFakeClaudeBin(0);
      const reportPath = writeReport();

      try {
        const { stdout, stderr } = await execFileAsync(
          "node",
          [cliPath, "fix", repoDir, "--report", reportPath, "--yes"],
          { env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` } }
        );
        const output = stdout + stderr;
        expect(output).toContain("[fix] step 1 auto-applied (--yes)");
        expect(output).not.toContain("Apply this change?");
        expect(output).toContain("1 applied (uncommitted), 0 reverted, 0 failed");
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
        rmSync(reportPath, { force: true });
      }
    });

    it("still reverts a step when the agent fails, even with --yes", async () => {
      const cliPath = path.resolve("dist/cli.js");
      const repoDir = makeCleanRepo();
      const binDir = makeFakeClaudeBin(1);
      const reportPath = writeReport();

      try {
        const { stdout, stderr } = await execFileAsync(
          "node",
          [cliPath, "fix", repoDir, "--report", reportPath, "--yes"],
          { env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` } }
        );
        const output = stdout + stderr;
        expect(output).toContain("[fix] reverted changes for this step");
        expect(output).not.toContain("auto-applied");
        expect(output).toContain("0 applied (uncommitted), 0 reverted, 1 failed");
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(binDir, { recursive: true, force: true });
        rmSync(reportPath, { force: true });
      }
    });
  });
});

// `cli.ts` has top-level `program.parse()` side effects and doesn't export its
// action handler, so it can't be invoked in-process the way `runPipeline` is
// above. A real subprocess `archie analyze --json` run (see cli-pdf.test.ts
// for the subprocess pattern) needs a live ANTHROPIC_API_KEY, which isn't
// available in this test environment. Instead, this test mocks the Anthropic
// SDK (same pattern as index.test.ts), runs the real pipeline, and builds the
// JSON output object exactly as cli.ts's `--json` branch does — verifying the
// `ArchieJsonOutput` shape stays JSON-serializable and carries the expected
// top-level keys.
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi
          .fn()
          .mockImplementation(
            ({
              system,
              tool_choice,
            }: {
              system: string;
              tools?: unknown[];
              tool_choice?: { name?: string };
            }) => {
              if (tool_choice?.name === "report_risks") {
                return Promise.resolve({
                  content: [
                    {
                      type: "tool_use",
                      id: "tu_1",
                      name: "report_risks",
                      input: {
                        risks: [
                          {
                            title: "High coupling",
                            file: "src/core.ts",
                            severity: "High",
                            confidence: "high",
                            why_it_matters: "Cascading failures.",
                            root_cause: "fanIn=14 means many files import this module directly.",
                            evidence: "fanIn=14",
                            complexity: 42,
                            fanIn: 14,
                            loc: 310,
                          },
                        ],
                      },
                    },
                  ],
                  usage: { input_tokens: 100, output_tokens: 50 },
                });
              }
              if (tool_choice?.name === "report_scenarios") {
                return Promise.resolve({
                  content: [
                    {
                      type: "tool_use",
                      id: "tu_2",
                      name: "report_scenarios",
                      input: {
                        scenarios: [
                          {
                            title: "Unvalidated payload crashes the worker",
                            trigger: "A malformed payload is sent to the ingest endpoint.",
                            chain_of_failure:
                              "The worker reads a missing field and throws, retrying indefinitely.",
                            business_impact: "Ingest backlog grows unbounded.",
                            likelihood: "Medium",
                            likelihood_justification: "Depends on upstream payload validation.",
                          },
                        ],
                      },
                    },
                  ],
                  usage: { input_tokens: 80, output_tokens: 40 },
                });
              }
              if (system.includes("Staff Engineer")) {
                return Promise.resolve({
                  content: [
                    {
                      type: "text",
                      text: [
                        "## 1. System Summary\nsome content",
                        "## 4. Refactor Plan (step-by-step)\nsome content",
                        "## 5. Senior Engineer Verdict\nsome content",
                      ].join("\n\n"),
                    },
                  ],
                  usage: { input_tokens: 200, output_tokens: 150 },
                });
              }
              return Promise.resolve({
                content: [{ type: "text", text: "unused" }],
                usage: { input_tokens: 0, output_tokens: 0 },
              });
            }
          ),
      },
    })),
  };
});

describe("archie analyze --json output shape", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it("produces a JSON-serializable ArchieJsonOutput with the documented top-level keys", async () => {
    const repoPath = path.resolve("fixtures/parser-basic");
    const topN = 5;
    const { report, graph, risks, scenarios, history, qualityWarnings } = await runPipeline({
      repoPath,
      topN,
      maxTokens: 50000,
      generatePdf: false,
    });

    // Mirrors the `output` construction in the `--json` branch of src/cli.ts.
    const output: ArchieJsonOutput = {
      version: 4,
      repoPath,
      topN,
      report,
      risks,
      scenarios,
      history,
      qualityWarnings,
      diff: { requested: false, scoped: false, changedFileCount: null, changedFiles: [] },
      graph: {
        fileCount: graph.nodes.filter((n) => n.kind === "file").length,
        nodeCount: graph.nodes.length,
        edgeCount: graph.edges.length,
        nodes: graph.nodes,
        edges: graph.edges,
      },
    };

    const parsed = JSON.parse(JSON.stringify(output));
    expect(parsed.version).toBe(4);
    expect(parsed).toHaveProperty("repoPath");
    expect(parsed).toHaveProperty("topN");
    expect(parsed).toHaveProperty("report");
    expect(parsed).toHaveProperty("risks");
    expect(parsed).toHaveProperty("scenarios");
    expect(parsed).toHaveProperty("history");
    expect(parsed).toHaveProperty("qualityWarnings");
    expect(parsed).toHaveProperty("diff");
    expect(parsed).toHaveProperty("graph");
    expect(Array.isArray(parsed.risks)).toBe(true);
    expect(parsed.risks[0]).toMatchObject({
      title: expect.any(String),
      file: expect.any(String),
      severity: expect.any(String),
      confidence: expect.any(String),
      complexity: expect.any(Number),
      fanIn: expect.any(Number),
      loc: expect.any(Number),
    });
    expect(Array.isArray(parsed.scenarios)).toBe(true);
    expect(parsed.scenarios[0]).toMatchObject({
      title: expect.any(String),
      trigger: expect.any(String),
      chain_of_failure: expect.any(String),
      business_impact: expect.any(String),
      likelihood: expect.any(String),
    });
    // `history` mirrors PipelineResult.history verbatim -- current is always
    // populated, previous is null on a repo with no prior recorded run.
    expect(parsed.history.current).toMatchObject({
      timestamp: expect.any(String),
      fileCount: expect.any(Number),
      totalLoc: expect.any(Number),
      averageRiskScore: expect.any(Number),
    });
    expect(parsed.history).toHaveProperty("previous");
    // `qualityWarnings` is an array (possibly empty -- the mocked SDK above
    // never returns a report_quality_check tool_use block, so the
    // self-critique pass fails open with an empty list per runQualityCheck's
    // documented fail-open behavior in src/reasoning.ts).
    expect(Array.isArray(parsed.qualityWarnings)).toBe(true);
    expect(parsed.diff.changedFiles).toEqual([]);
    expect(parsed.graph.fileCount).toBe(graph.nodes.filter((n) => n.kind === "file").length);
    // Regression guard: fileCount must NOT equal nodeCount here, since the
    // fixture graph contains function/class nodes in addition to file nodes
    // -- this is exactly the distinction that was missing when
    // scripts/post-pr-comment.mjs mislabeled nodeCount as "changed files".
    expect(parsed.graph.fileCount).toBeLessThan(parsed.graph.nodeCount);
    expect(parsed.graph.nodeCount).toBe(graph.nodes.length);
    expect(parsed.graph.edgeCount).toBe(graph.edges.length);
    expect(Array.isArray(parsed.graph.nodes)).toBe(true);
    expect(Array.isArray(parsed.graph.edges)).toBe(true);
  });

  // Regression coverage: diff.changedFiles must contain repo-relative paths
  // of the actual changed files (converted from resolveDiffScope's absolute
  // paths), not just a count -- a downstream PR-comment inline-annotation
  // feature needs the paths to know which files are safe to anchor a GitHub
  // inline review comment to.
  it("converts diffScope.files to repo-relative paths for diff.changedFiles", () => {
    const resolvedRepo = "/repo";
    const diffScopeFiles = ["/repo/src/foo.ts", "/repo/src/nested/bar.ts"];
    const changedFiles = diffScopeFiles.map((f) => path.relative(resolvedRepo, f));
    expect(changedFiles).toEqual(["src/foo.ts", "src/nested/bar.ts"]);
  });
});
