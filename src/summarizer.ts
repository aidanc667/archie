// src/summarizer.ts
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

export interface TopRiskFile {
  path: string;
  riskScore: number;
  complexity: number;
  fanIn: number;
  loc: number;
  source: string;
  hasTests: boolean;
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
  options: ContextPackOptions
): ContextPack {
  const paths = pathByFileId(graph);
  const systemSummary = buildSystemSummary(graph);
  const tested = testedFileIds(graph);

  const sorted = [...scores].sort((a, b) => b.riskScore - a.riskScore);
  let topN = sorted.slice(0, options.topN);

  // Mode 1: top-N detail, pruning lowest-risk entries until it fits.
  while (topN.length > 0) {
    const topRiskFiles: TopRiskFile[] = topN.map((s) => ({
      path: paths.get(s.fileId) ?? s.fileId,
      riskScore: s.riskScore,
      complexity: s.complexity,
      fanIn: s.fanIn,
      loc: s.loc,
      source: sourceByPath.get(s.fileId) ?? "",
      hasTests: tested.has(s.fileId),
    }));

    const includedIds = new Set(topN.map((s) => s.fileId));
    const graphSnapshot = graph.edges
      .filter((e) => includedIds.has(e.from) || includedIds.has(e.to))
      .map((e) => ({ from: paths.get(e.from) ?? e.from, to: paths.get(e.to) ?? e.to, type: e.type }));

    const candidate = { systemSummary, topRiskFiles, graphSnapshot, clusters: [] };

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
  };
}
