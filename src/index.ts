// src/index.ts
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { walkRepo } from "./walker.js";
import { parseFile, computeComplexity } from "./parser.js";
import { buildGraph, type FileEntry } from "./graph.js";
import { computeRiskScores } from "./metrics.js";
import { buildContextPack } from "./summarizer.js";
import { generateReport } from "./reasoning.js";
import type { CodeGraph } from "./types.js";

export interface PipelineOptions {
  repoPath: string;
  topN: number;
  maxTokens: number;
}

export interface PipelineResult {
  report: string;
  graph: CodeGraph;
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const root = path.resolve(options.repoPath);

  try {
    await access(root, constants.F_OK);
  } catch {
    throw new Error(`Path does not exist: ${root}`);
  }

  const files = await walkRepo(root);
  if (files.length === 0) {
    throw new Error(`No parseable TS/JS files found under: ${root}`);
  }

  const parsedByFile = new Map<string, FileEntry>();
  const complexityByFile = new Map<string, number>();

  for (const filePath of files) {
    const parsed = await parseFile(filePath);
    const complexity = await computeComplexity(filePath);
    const loc = (await readFile(filePath, "utf8")).split("\n").length;

    parsedByFile.set(filePath, { loc, parsed });
    complexityByFile.set(`file:${path.relative(root, filePath)}`, complexity);
  }

  const graph = buildGraph(parsedByFile, root);
  const scores = computeRiskScores(graph, complexityByFile);
  const pack = buildContextPack(graph, scores, { topN: options.topN, maxTokens: options.maxTokens });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is missing");
  }

  const client = new Anthropic({ apiKey });
  const report = await generateReport(client, pack);

  return { report, graph };
}
