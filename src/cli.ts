#!/usr/bin/env node
// src/cli.ts
import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { runPipeline } from "./index.js";

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
  .action(
    async (
      repoPath: string,
      opts: { out: string; topN: string; verbose: boolean; debugGraph: boolean; pdf: boolean }
    ) => {
      let report: string;
      let graph: import("./types.js").CodeGraph;

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
          const simplifiedSummary = await generateSimplifiedSummary(client, report);

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
