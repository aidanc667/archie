#!/usr/bin/env node
// src/cli.ts
import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { runPipeline } from "./index.js";
import { resolveDiffScope } from "./diff.js";
import type { GraphNode, Edge } from "./types.js";
import type { RiskFinding, ScenarioFinding, QualityWarning } from "./reasoning.js";
import type { HistoryEntry } from "./history.js";
import type { NamingConsistencyReport } from "./consistency.js";
import type { DuplicationReport } from "./duplication.js";
import type { DeadFileReport } from "./deadcode.js";
import type { SecurityReport } from "./summarizer.js";

/**
 * The shape of `archie analyze --json` stdout output. This is a real
 * integration surface: `scripts/post-pr-comment.mjs` and potentially other
 * external consumers (CI scripts, dashboards, editor extensions) parse this
 * exact shape. Bump `version` any time a field is added, removed, renamed,
 * or changes meaning — see docs/json-output-schema.md.
 */
export interface ArchieJsonOutput {
  version: 7;
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
  // Whole-codebase naming-case consistency signal, computed once per run --
  // see src/consistency.ts for the authoritative NamingConsistencyReport/
  // NamingInconsistency shapes. New in schema version 5, see
  // docs/json-output-schema.md.
  namingConsistency: NamingConsistencyReport;
  // Whole-codebase cross-file duplicate-function groups, computed once per
  // run -- see src/duplication.ts for the authoritative DuplicationReport/
  // DuplicateGroup shapes. New in schema version 6, see
  // docs/json-output-schema.md.
  duplication: DuplicationReport;
  // Whole-codebase dead-file candidates (files with no detected importers),
  // computed once per run -- see src/deadcode.ts for the authoritative
  // DeadFileReport/DeadFileCandidate shapes. New in schema version 6, see
  // docs/json-output-schema.md.
  deadFiles: DeadFileReport;
  // Whole-codebase security findings (hardcoded-secret-shaped strings and
  // dangerous dynamic-execution sinks), computed once per run -- see
  // src/summarizer.ts for the authoritative SecurityReport/SecurityFinding
  // shapes. New in schema version 7, see docs/json-output-schema.md.
  // SAFETY: SecurityFinding is {file, line, ruleId} only -- a `secrets`
  // entry never carries the actual matched secret text in any form.
  security: SecurityReport;
}

const program = new Command();

program
  .name("archie")
  .description("AI Staff Engineer architecture analysis for a local repo");

program
  .command("analyze")
  .argument("<path>", "path to the repository to analyze")
  .option("--out <file>", "output path for the report", "./archie-report.md")
  .option("--topN <n>", "number of top-risk files to include in detail", "10")
  .option("--verbose", "print pipeline progress to stderr", false)
  .option("--debug-graph", "dump the raw graph to <out>.graph.json", false)
  .option("--pdf", "also generate a simplified PDF summary at <out>.pdf", false)
  .option("--json", "output structured JSON to stdout instead of writing a markdown file", false)
  .option("--no-cache", "skip reading and writing the parse cache", false)
  .option("--watch", "watch repo for changes and re-run on each change", false)
  .option("--diff <branch>", "only analyze files changed vs the given branch")
  .action(
    async (
      repoPath: string,
      opts: { out: string; topN: string; verbose: boolean; debugGraph: boolean; pdf: boolean; json: boolean; noCache: boolean; watch: boolean; diff?: string }
    ) => {
      const { resolve } = await import("node:path");
      const resolvedRepo = resolve(repoPath);

      const runOnce = async (): Promise<string | undefined> => {
        try {
          if (opts.verbose) console.error(`Analyzing ${repoPath}...`);
          const diffScope = resolveDiffScope(resolvedRepo, opts.diff);
          if (diffScope.scoped) {
            console.error(`[diff] ${diffScope.changedFileCount} changed files vs ${opts.diff} — prioritizing them for detailed review (full repo still parsed for accurate fan-in)`);
          } else if (diffScope.errorMessage) {
            console.error(`[diff] git diff failed: ${diffScope.errorMessage}, running full analysis`);
          } else if (diffScope.requested) {
            console.error(`[diff] no changed source files vs ${opts.diff}, running full analysis`);
          }
          const result = await runPipeline({
            repoPath,
            topN: Number.parseInt(opts.topN, 10),
            maxTokens: 200000,
            generatePdf: false,
            noCache: opts.noCache,
            filterFiles: diffScope.files,
          });
          const { report, graph, risks, scenarios, qualityWarnings } = result;

          // Printed unconditionally (both --json and normal mode), not
          // gated behind --verbose: previously the only place this coverage
          // tradeoff was disclosed was a sentence buried inside the
          // generated report itself, which a user could easily never read.
          const { totalFiles, detailedFiles, mode: scopeMode } = result.scope;
          if (scopeMode === "cluster-summary") {
            console.error(
              `[scope] ${totalFiles} files found; top ${detailedFiles} reviewed in full detail, the rest assessed only at a coarse aggregate level (repo exceeded this run's token budget)`
            );
          } else if (detailedFiles < totalFiles) {
            console.error(
              `[scope] ${totalFiles} files found; top ${detailedFiles} reviewed in detail, remaining ${totalFiles - detailedFiles} not individually assessed (raise --topN to review more)`
            );
          } else {
            console.error(`[scope] ${totalFiles} files found, all reviewed in detail`);
          }

          if (!opts.json) {
            const { current, previous } = result.history;
            if (previous === null) {
              console.error("[history] First recorded run for this repo — trend will be available next time.");
            } else if (previous.topRiskFile && current.topRiskFile) {
              const prevDate = previous.timestamp.slice(0, 10);
              if (previous.topRiskFile.path === current.topRiskFile.path) {
                console.error(
                  `[history] Highest-risk file ${current.topRiskFile.path}: ${current.topRiskFile.riskScore.toFixed(2)} (was ${previous.topRiskFile.riskScore.toFixed(2)} last run)`
                );
              } else {
                console.error(
                  `[history] Highest-risk file: ${current.topRiskFile.path} (${current.topRiskFile.riskScore.toFixed(2)}) — up from ${previous.topRiskFile.riskScore.toFixed(2)} on ${prevDate} (${previous.topRiskFile.path})`
                );
              }
            }

            const { inputTokens, outputTokens, estimatedCostUsd } = result.usage;
            console.error(
              `[usage] ~${inputTokens.toLocaleString()} input / ${outputTokens.toLocaleString()} output tokens (~$${estimatedCostUsd.toFixed(2)})`
            );
          }

          if (opts.json) {
            const changedFiles = (diffScope.files ?? []).map((f) => path.relative(resolvedRepo, f));
            const output: ArchieJsonOutput = {
              version: 7,
              repoPath: resolvedRepo,
              topN: Number.parseInt(opts.topN, 10),
              report,
              risks,
              scenarios,
              history: result.history,
              qualityWarnings,
              diff: {
                requested: diffScope.requested,
                scoped: diffScope.scoped,
                changedFileCount: diffScope.changedFileCount,
                changedFiles,
              },
              graph: {
                fileCount: graph.nodes.filter((n) => n.kind === "file").length,
                nodeCount: graph.nodes.length,
                edgeCount: graph.edges.length,
                nodes: graph.nodes,
                edges: graph.edges,
              },
              namingConsistency: result.namingConsistency,
              duplication: result.duplication,
              deadFiles: result.deadFiles,
              security: result.security,
            };
            console.log(JSON.stringify(output, null, 2));
            return report;
          }

          await writeFile(opts.out, report, "utf8");
          console.error(`Report written to ${opts.out}`);

          if (opts.debugGraph) {
            const graphPath = `${opts.out}.graph.json`;
            await writeFile(graphPath, JSON.stringify(graph, null, 2), "utf8");
            console.error(`Graph dumped to ${graphPath}`);
          }

          return report;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`archie: ${message}`);
          process.exitCode = 1;
          return undefined;
        }
      };

      const firstReport = await runOnce();

      if (opts.watch) {
        const { watch } = await import("node:fs");
        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        watch(resolvedRepo, { recursive: true }, (_event, filename) => {
          if (debounceTimer !== undefined) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(async () => {
            console.error(`[watch] re-analyzed after change to ${filename ?? "unknown"}`);
            await runOnce();
          }, 300);
        });
        // Keep process alive; Ctrl+C exits naturally
        return;
      }

      if (firstReport === undefined) return;

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
          const { summary: simplifiedSummary, usage } = await generateSimplifiedSummary(client, firstReport);
          if (opts.verbose) {
            console.error(`[usage] PDF summary: ~${usage.inputTokens.toLocaleString()} input / ${usage.outputTokens.toLocaleString()} output tokens`);
          }

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

program
  .command("fix")
  .argument("<repo>", "path to the target repository")
  .requiredOption("--report <path>", "path to an already-generated ARCHIE report markdown file")
  .option("--verbose", "print pipeline progress to stderr", false)
  .option(
    "--yes",
    "apply all successful steps without an interactive confirmation prompt (still reverts a step if the agent failed or build/test failed)",
    false
  )
  .action(async (repoArg: string, opts: { report: string; verbose: boolean; yes: boolean }) => {
    const { resolve } = await import("node:path");
    const resolvedRepo = resolve(repoArg);

    try {
      let status: string;
      try {
        status = execFileSync("git", ["status", "--porcelain"], { cwd: resolvedRepo, encoding: "utf8" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to check git status in ${resolvedRepo}: ${message}`);
      }
      // Ignore ARCHIE's own cache directory when deciding if the tree is dirty.
      // `archie analyze` leaves an untracked `.archie-cache/` behind in the
      // target repo; without this filter, running `fix` right after `analyze`
      // on the same repo would always refuse to start, even though nothing
      // the user did made the tree dirty.
      const meaningfulStatus = status
        .split("\n")
        .filter((line) => line.trim().length > 0 && !line.includes(".archie-cache"))
        .join("\n");
      if (meaningfulStatus.trim().length > 0) {
        console.error(
          `archie: refusing to run fix on a dirty working tree in ${resolvedRepo} — commit or stash your changes first.`
        );
        process.exitCode = 1;
        return;
      }

      if (!existsSync(opts.report)) {
        console.error(`archie: report file not found: ${opts.report}`);
        process.exitCode = 1;
        return;
      }
      const reportMarkdown = readFileSync(opts.report, "utf8");

      const { parseRefactorSteps, runFixStep } = await import("./fix.js");
      const steps = parseRefactorSteps(reportMarkdown);
      if (steps.length === 0) {
        console.error(`archie: no Refactor Plan steps found in ${opts.report}`);
        process.exitCode = 1;
        return;
      }

      const rl = opts.yes
        ? undefined
        : (await import("node:readline/promises")).createInterface({
            input: process.stdin,
            output: process.stdout,
          });

      let appliedCount = 0;
      let revertedCount = 0;
      let failedCount = 0;

      try {
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          console.error(`[fix] Step ${i + 1}/${steps.length}: ${step.title}`);

          const result = await runFixStep(step, resolvedRepo, opts.verbose);

          if (result.agentSucceeded) {
            console.error("[fix] agent: succeeded");
          } else {
            console.error(`[fix] agent: failed — ${result.agentError ?? "unknown error"}`);
          }
          console.error(`[fix] build: ${result.buildResult}`);
          console.error(`[fix] test: ${result.testResult}`);
          if (result.syntaxCheckResult !== "not-applicable") {
            console.error(
              `[fix] syntax check (fallback, no build/test script found): ${result.syntaxCheckResult}`
            );
          }
          if (result.diffStat.trim().length > 0) {
            console.error(`[fix] diff stat:\n${result.diffStat}`);
          }

          if (!result.agentSucceeded) {
            execFileSync("git", ["checkout", "--", "."], { cwd: resolvedRepo, encoding: "utf8" });
            console.error("[fix] reverted changes for this step");
            failedCount++;
            continue;
          }

          if (opts.yes) {
            appliedCount++;
            console.error(`[fix] step ${i + 1} auto-applied (--yes)`);
          } else {
            const answer = await rl!.question("Apply this change? [y/N] ");
            if (answer.trim() === "y" || answer.trim() === "Y") {
              appliedCount++;
            } else {
              execFileSync("git", ["checkout", "--", "."], { cwd: resolvedRepo, encoding: "utf8" });
              console.error("[fix] reverted changes for this step");
              revertedCount++;
            }
          }
        }
      } finally {
        rl?.close();
      }

      console.error("");
      console.error(
        `[fix] summary: ${appliedCount} applied (uncommitted), ${revertedCount} reverted, ${failedCount} failed`
      );
      console.error(
        "[fix] nothing was committed — review `git diff` in the repo yourself before committing."
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`archie: ${message}`);
      process.exitCode = 1;
    }
  });

program.parse();
