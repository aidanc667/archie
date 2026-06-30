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
        console.error(`archie: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    }
  );

program.parse();
