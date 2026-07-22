// src/index.ts
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { walkRepo } from "./walker.js";
import { parseFile, computeComplexity } from "./parser.js";
import { buildGraph, loadPathAliases, loadGoModuleName, type FileEntry } from "./graph.js";
import { computeRiskScores } from "./metrics.js";
import { buildContextPack, loadDependencies } from "./summarizer.js";
import { computeNamingConsistency, type NamingConsistencyReport } from "./consistency.js";
import { findDuplicateGroups, type DuplicationReport } from "./duplication.js";
import { computeDeadFiles, type DeadFileReport } from "./deadcode.js";
import {
  generateReport,
  generateSimplifiedSummary,
  type RiskFinding,
  type ScenarioFinding,
  type QualityWarning,
} from "./reasoning.js";
import type { CodeGraph } from "./types.js";
import { hashContent, loadCache, saveCache } from "./cache.js";
import { loadHistory, appendHistoryEntry, type HistoryEntry } from "./history.js";

// Approximate Claude Sonnet pricing (USD per million tokens). This is a rough
// cost estimate, not billing-accurate — update if Anthropic's pricing changes.
const CLAUDE_SONNET_INPUT_COST_PER_MTOK = 3;
const CLAUDE_SONNET_OUTPUT_COST_PER_MTOK = 15;

export interface PipelineOptions {
  repoPath: string;
  topN: number;
  maxTokens: number;
  generatePdf: boolean;
  noCache?: boolean;
  filterFiles?: string[];
}

export interface PipelineResult {
  report: string;
  graph: CodeGraph;
  // Structured findings behind the rendered `report` markdown -- the same
  // data the report's "Top 5 Architectural Risks" and "Production Failure
  // Scenarios" sections are generated from. Useful for consumers (e.g. the
  // PR-comment script) that want per-risk file/severity/metrics without
  // re-parsing markdown headings out of `report`.
  risks: RiskFinding[];
  scenarios: ScenarioFinding[];
  // Detection-only self-critique findings from generateReport's 4th pass --
  // specific claims in Sections 1/4/5 that don't trace back to the Context
  // Pack (a mismatched version number, a symbol claimed as exported that
  // isn't in exportedSymbols, an absence claim not backed by hasTests/
  // hasErrorHandling, etc). Empty when the check found nothing, or when the
  // check itself failed and was skipped (see runQualityCheck).
  qualityWarnings: QualityWarning[];
  /**
   * Present when `generatePdf` is set. This is simplified summary text only —
   * `runPipeline` never writes a PDF file. Callers who want a PDF should pass
   * this text to `convertToPdf` (from `./pdf.js`) themselves; see `src/cli.ts`.
   */
  simplifiedSummary?: string;
  history: { current: HistoryEntry; previous: HistoryEntry | null };
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
  // Previously the top-N coverage tradeoff (only the riskiest files get
  // individual review; the rest only ever contribute to graph structure)
  // was disclosed nowhere except a sentence buried inside the generated
  // report itself -- a user could easily miss it and conclude the tool
  // "isn't analyzing the codebase fully" without realizing this is a
  // disclosed, deliberate token-budget tradeoff. Surfacing it here lets the
  // CLI print it unconditionally, not just to someone who reads the report.
  scope: { totalFiles: number; detailedFiles: number; mode: "top-n-detail" | "cluster-summary" };
  // Whole-codebase naming-case consistency signal (e.g. a stray snake_case
  // function among mostly camelCase ones), computed once per run directly
  // from the graph -- independent of which files made the top-N cut.
  namingConsistency: NamingConsistencyReport;
  // Whole-codebase cross-file duplicate-function signal, computed once per
  // run directly from the graph -- independent of which files made the
  // top-N cut.
  duplication: DuplicationReport;
  // Whole-codebase dead-file-candidate signal (files with no detected
  // importers), computed once per run directly from the graph --
  // independent of which files made the top-N cut.
  deadFiles: DeadFileReport;
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

  // filterFiles (from --diff) no longer restricts which files get parsed and
  // graphed -- it only restricts which files are ELIGIBLE for top-N detailed
  // review, applied later in buildContextPack. The graph itself is always
  // built from the whole repo. Found via a real test case: filtering here
  // meant a changed file's fan-in silently came out as 0 whenever its actual
  // importers/dependents lived outside the diff, because those other files
  // were never parsed at all -- a file depended on by 15 others could score
  // as if nothing used it, purely because of how the PR happened to be scoped.
  const parsedByFile = new Map<string, FileEntry>();
  const complexityByFile = new Map<string, number>();
  const sourceByPath = new Map<string, string>();

  const useCache = !options.noCache;
  const store = useCache ? await loadCache(root) : { version: 1 as const, entries: {} };

  for (const filePath of files) {
    const source = await readFile(filePath, "utf8");
    const loc = source.split("\n").length;
    const relPath = path.relative(root, filePath);
    const fileId = `file:${relPath}`;

    let parsed: Awaited<ReturnType<typeof parseFile>>;
    let complexity: number;

    if (useCache) {
      const hash = hashContent(source);
      const entry = store.entries[relPath];
      if (entry && entry.hash === hash) {
        parsed = entry.parsed;
        complexity = entry.complexity;
      } else {
        parsed = await parseFile(filePath);
        complexity = await computeComplexity(filePath);
        store.entries[relPath] = { hash, parsed, complexity };
      }
    } else {
      parsed = await parseFile(filePath);
      complexity = await computeComplexity(filePath);
    }

    parsedByFile.set(filePath, { loc, parsed });
    complexityByFile.set(fileId, complexity);
    sourceByPath.set(fileId, source);
  }

  if (useCache) {
    await saveCache(root, store);
  }

  const aliases = await loadPathAliases(root);
  const dependencies = await loadDependencies(root);
  const goModuleName = await loadGoModuleName(root);
  const graph = buildGraph(parsedByFile, root, aliases, goModuleName);
  const namingConsistency = computeNamingConsistency(graph);
  const duplication = findDuplicateGroups(graph);
  const deadFiles = computeDeadFiles(graph);
  const scores = computeRiskScores(graph, complexityByFile);

  const restrictToFileIds =
    options.filterFiles && options.filterFiles.length > 0
      ? new Set(options.filterFiles.map((f) => `file:${path.relative(root, path.resolve(f))}`))
      : undefined;

  const pack = buildContextPack(
    graph,
    scores,
    sourceByPath,
    { topN: options.topN, maxTokens: options.maxTokens, restrictToFileIds },
    namingConsistency,
    duplication,
    deadFiles,
    dependencies
  );

  const useHistory = !options.noCache;
  const previousHistory = useHistory ? await loadHistory(root) : null;
  const previousEntry =
    previousHistory && previousHistory.entries.length > 0
      ? previousHistory.entries[previousHistory.entries.length - 1]
      : null;

  const fileNodesById = new Map(
    graph.nodes.filter((n) => n.kind === "file").map((n) => [n.id, n])
  );
  const topScore = scores.reduce<(typeof scores)[number] | null>(
    (best, s) => (best === null || s.riskScore > best.riskScore ? s : best),
    null
  );
  const topRiskFile =
    topScore !== null
      ? {
          path: fileNodesById.get(topScore.fileId)?.path ?? topScore.fileId,
          riskScore: topScore.riskScore,
        }
      : null;
  const averageRiskScore =
    scores.length > 0 ? scores.reduce((sum, s) => sum + s.riskScore, 0) / scores.length : 0;
  const totalLoc = graph.nodes
    .filter((n) => n.kind === "file")
    .reduce((sum, n) => sum + n.loc, 0);

  const currentEntry: HistoryEntry = {
    timestamp: new Date().toISOString(),
    fileCount: files.length,
    totalLoc,
    topRiskFile,
    averageRiskScore,
  };

  if (useHistory) {
    await appendHistoryEntry(root, currentEntry);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is missing");
  }

  const client = new Anthropic({ apiKey });
  const {
    report,
    risks,
    scenarios,
    qualityWarnings,
    usage: reportUsage,
  } = await generateReport(client, pack);

  let simplifiedSummary: string | undefined;
  let totalInputTokens = reportUsage.inputTokens;
  let totalOutputTokens = reportUsage.outputTokens;
  if (options.generatePdf) {
    const { summary, usage: summaryUsage } = await generateSimplifiedSummary(client, report);
    simplifiedSummary = summary;
    totalInputTokens += summaryUsage.inputTokens;
    totalOutputTokens += summaryUsage.outputTokens;
  }

  const estimatedCostUsd =
    (totalInputTokens / 1_000_000) * CLAUDE_SONNET_INPUT_COST_PER_MTOK +
    (totalOutputTokens / 1_000_000) * CLAUDE_SONNET_OUTPUT_COST_PER_MTOK;

  return {
    report,
    graph,
    risks,
    scenarios,
    qualityWarnings,
    simplifiedSummary,
    history: { current: currentEntry, previous: previousEntry },
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCostUsd,
    },
    scope: {
      totalFiles: pack.systemSummary.fileCount,
      detailedFiles: pack.topRiskFiles.length,
      mode: pack.mode,
    },
    namingConsistency,
    duplication,
    deadFiles,
  };
}
