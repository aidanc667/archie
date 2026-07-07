// src/summarizer.ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CodeGraph } from "./types.js";
import type { RiskScore } from "./metrics.js";

export interface ContextPackOptions {
  topN: number;
  maxTokens: number;
}

export interface SystemSummary {
  fileCount: number;
  totalLoc: number;
}

// Loads and merges dependencies + devDependencies from the target repo's
// root package.json, so the report-generation prompt can cite exact,
// verified framework/library versions instead of guessing them from code
// patterns (e.g. inferring "Next.js 14" from App Router file conventions
// that look nearly identical across several major versions -- found on a
// real report where the target's package.json said "next": "16.2.2" but
// the generated System Summary claimed "Next.js 14"). Fails open (returns
// undefined) if package.json is missing or malformed -- Python repos and
// other edge cases shouldn't break the pipeline over this.
export async function loadDependencies(root: string): Promise<Record<string, string> | undefined> {
  try {
    const content = await readFile(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const merged = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.keys(merged).length > 0 ? merged : undefined;
  } catch {
    return undefined;
  }
}

export interface TopRiskFile {
  path: string;
  riskScore: number;
  complexity: number;
  fanIn: number;
  loc: number;
  source: string;
  hasTests: boolean;
  hasErrorHandling: boolean;
  // The file's actual exported API surface, per EXPORTS edges in the graph --
  // a checked fact, not something to infer from the raw source. Found
  // missing on a real report: without this, the model named four private,
  // module-internal helper functions as "exported" and aimed a refactor
  // step directly at them instead of their real (exported) call site.
  exportedSymbols: string[];
}

export interface ClusterSummary {
  fileCount: number;
  averageComplexity: number;
  maxRiskScore: number;
}

export interface ContextPack {
  mode: "top-n-detail" | "cluster-summary";
  systemSummary: SystemSummary;
  topRiskFiles: TopRiskFile[];
  graphSnapshot: { from: string; to: string; type: string }[];
  clusters: ClusterSummary[];
  dependencies?: Record<string, string>;
}

// Rough token estimate: ~4 characters per token. This measures the length of the
// JSON-serialized pack, not actual LLM prompt formatting, so it's an approximation
// that may diverge from real prompt token counts.
function estimateTokens(pack: Omit<ContextPack, "mode">): number {
  return Math.ceil(JSON.stringify(pack).length / 4);
}

function pathByFileId(graph: CodeGraph): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind === "file") map.set(node.id, node.path);
  }
  return map;
}

function testedFileIds(graph: CodeGraph): Set<string> {
  const set = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type === "TESTED_BY") set.add(edge.from);
  }
  return set;
}

function hasErrorHandling(source: string): boolean {
  return /\btry\s*\{/.test(source) || /\.catch\s*\(/.test(source);
}

function exportedNodeIds(graph: CodeGraph): Set<string> {
  const set = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type === "EXPORTS") set.add(edge.to);
  }
  return set;
}

// Found returning every function/class in the file regardless of export
// status on a real report, despite its own "[no exports detected]" label
// implying otherwise -- meaning ranks 4-10 (signature-summary only, no full
// source) presented private, module-internal helpers to the model
// indistinguishably from the file's actual public API. Now filters to
// exported symbols only, matching what the label always claimed to show.
function buildSignatureSummary(graph: CodeGraph, fileId: string, exported: Set<string>): string {
  const functions: string[] = [];
  const classes: string[] = [];
  for (const node of graph.nodes) {
    if (!exported.has(node.id)) continue;
    if (node.kind === "function" && node.fileId === fileId) functions.push(node.name);
    else if (node.kind === "class" && node.fileId === fileId) classes.push(node.name);
  }
  if (functions.length === 0 && classes.length === 0) return "[no exports detected]";
  const parts: string[] = [];
  if (functions.length > 0) parts.push(`[functions: ${functions.join(", ")}]`);
  if (classes.length > 0) parts.push(`[classes: ${classes.join(", ")}]`);
  return parts.join(" ");
}

function exportedSymbolsForFile(graph: CodeGraph, fileId: string, exported: Set<string>): string[] {
  return graph.nodes
    .filter((n) => (n.kind === "function" || n.kind === "class") && n.fileId === fileId && exported.has(n.id))
    .map((n) => (n as { name: string }).name);
}

function buildSystemSummary(graph: CodeGraph): SystemSummary {
  const fileNodes = graph.nodes.filter((n) => n.kind === "file");
  const totalLoc = fileNodes.reduce(
    (sum, n) => sum + (n.kind === "file" ? n.loc : 0),
    0
  );
  return { fileCount: fileNodes.length, totalLoc };
}

function buildClusterSummary(scores: RiskScore[]): ClusterSummary[] {
  if (scores.length === 0) return [];
  const averageComplexity =
    scores.reduce((sum, s) => sum + s.complexity, 0) / scores.length;
  const maxRiskScore = Math.max(...scores.map((s) => s.riskScore));
  return [{ fileCount: scores.length, averageComplexity, maxRiskScore }];
}

export function buildContextPack(
  graph: CodeGraph,
  scores: RiskScore[],
  sourceByPath: Map<string, string>,
  options: ContextPackOptions,
  dependencies?: Record<string, string>
): ContextPack {
  const paths = pathByFileId(graph);
  const systemSummary = buildSystemSummary(graph);
  const tested = testedFileIds(graph);
  const exported = exportedNodeIds(graph);

  const sorted = [...scores].sort((a, b) => b.riskScore - a.riskScore);
  let topN = sorted.slice(0, options.topN);

  // Mode 1: top-N detail, pruning lowest-risk entries until it fits.
  while (topN.length > 0) {
    const topRiskFiles: TopRiskFile[] = topN.map((s, index) => ({
      path: paths.get(s.fileId) ?? s.fileId,
      riskScore: s.riskScore,
      complexity: s.complexity,
      fanIn: s.fanIn,
      loc: s.loc,
      source: index < 3
        ? (sourceByPath.get(s.fileId) ?? "")
        : buildSignatureSummary(graph, s.fileId, exported),
      hasTests: tested.has(s.fileId),
      hasErrorHandling: hasErrorHandling(sourceByPath.get(s.fileId) ?? ""),
      exportedSymbols: exportedSymbolsForFile(graph, s.fileId, exported),
    }));

    const includedIds = new Set(topN.map((s) => s.fileId));
    const graphSnapshot = graph.edges
      .filter((e) => includedIds.has(e.from) || includedIds.has(e.to))
      .map((e) => ({ from: paths.get(e.from) ?? e.from, to: paths.get(e.to) ?? e.to, type: e.type }));

    const candidate = { systemSummary, topRiskFiles, graphSnapshot, clusters: [], dependencies };

    if (estimateTokens(candidate) <= options.maxTokens) {
      return { mode: "top-n-detail", ...candidate };
    }

    topN = topN.slice(0, -1);
  }

  // Mode 2: cluster-summary fallback.
  return {
    mode: "cluster-summary",
    systemSummary,
    topRiskFiles: [],
    graphSnapshot: [],
    clusters: buildClusterSummary(scores),
    dependencies,
  };
}
