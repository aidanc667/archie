#!/usr/bin/env node
// src/cli.ts
import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { runPipeline } from "./index.js";
import type { GraphNode, Edge } from "./types.js";

/**
 * The shape of `archie analyze --json` stdout output. This is a real
 * integration surface: `scripts/post-pr-comment.mjs` and potentially other
 * external consumers (CI scripts, dashboards, editor extensions) parse this
 * exact shape. Bump `version` any time a field is added, removed, renamed,
 * or changes meaning — see docs/json-output-schema.md.
 */
export interface ArchieJsonOutput {
  version: 1;
  repoPath: string;
  topN: number;
  report: string;
  graph: {
    nodeCount: number;
    edgeCount: number;
    nodes: GraphNode[];
    edges: Edge[];
  };
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

      const getFilterFiles = (): string[] | undefined => {
        if (!opts.diff) return undefined;
        try {
          const output = execSync(`git diff --name-only ${opts.diff} HEAD`, { cwd: resolvedRepo, encoding: "utf8" });
          const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);
          const changed = output
            .split("\n")
            .map((f) => f.trim())
            .filter((f) => f.length > 0)
            .filter((f) => {
              const ext = f.slice(f.lastIndexOf("."));
              return SOURCE_EXTS.has(ext);
            })
            .map((f) => resolve(resolvedRepo, f))
            .filter((f) => existsSync(f));
          if (changed.length === 0) {
            console.error(`[diff] no changed source files vs ${opts.diff}, running full analysis`);
            return undefined;
          }
          console.error(`[diff] analyzing ${changed.length} changed files vs ${opts.diff}`);
          return changed;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[diff] git diff failed: ${message}, running full analysis`);
          return undefined;
        }
      };

      const runOnce = async (): Promise<string | undefined> => {
        try {
          if (opts.verbose) console.error(`Analyzing ${repoPath}...`);
          const filterFiles = getFilterFiles();
          const result = await runPipeline({
            repoPath,
            topN: Number.parseInt(opts.topN, 10),
            maxTokens: 200000,
            generatePdf: false,
            noCache: opts.noCache,
            filterFiles,
          });
          const { report, graph } = result;

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
            const output: ArchieJsonOutput = {
              version: 1,
              repoPath: resolvedRepo,
              topN: Number.parseInt(opts.topN, 10),
              report,
              graph: {
                nodeCount: graph.nodes.length,
                edgeCount: graph.edges.length,
                nodes: graph.nodes,
                edges: graph.edges,
              },
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

program.parse();
