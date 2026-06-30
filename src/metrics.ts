// src/metrics.ts
import type { CodeGraph } from "./types.js";

export interface FanInOut {
  fanIn: number;
  fanOut: number;
}

export function computeFanInOut(graph: CodeGraph): Map<string, FanInOut> {
  const result = new Map<string, FanInOut>();

  for (const node of graph.nodes) {
    if (node.kind === "file") {
      result.set(node.id, { fanIn: 0, fanOut: 0 });
    }
  }

  for (const edge of graph.edges) {
    if (edge.type !== "IMPORTS") continue;
    const fromEntry = result.get(edge.from);
    if (fromEntry) fromEntry.fanOut += 1;
    const toEntry = result.get(edge.to);
    if (toEntry) toEntry.fanIn += 1;
  }

  return result;
}

export function computeDependencyDepth(graph: CodeGraph): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind === "file") adjacency.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (edge.type !== "IMPORTS") continue;
    adjacency.get(edge.from)?.push(edge.to);
  }

  const depthCache = new Map<string, number>();

  function depthOf(fileId: string, visiting: Set<string>): number {
    if (depthCache.has(fileId)) return depthCache.get(fileId)!;
    if (visiting.has(fileId)) return 0; // cycle guard
    visiting.add(fileId);

    const neighbors = adjacency.get(fileId) ?? [];
    let max = 0;
    for (const neighbor of neighbors) {
      max = Math.max(max, 1 + depthOf(neighbor, visiting));
    }
    visiting.delete(fileId);
    depthCache.set(fileId, max);
    return max;
  }

  const result = new Map<string, number>();
  for (const fileId of adjacency.keys()) {
    result.set(fileId, depthOf(fileId, new Set()));
  }
  return result;
}

export interface RiskScore {
  fileId: string;
  riskScore: number;
  complexity: number;
  fanIn: number;
  loc: number;
  dependencyDepth: number;
}

function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return (value - min) / (max - min);
}

export function computeRiskScores(
  graph: CodeGraph,
  complexityByFile: Map<string, number>
): RiskScore[] {
  const fanInOut = computeFanInOut(graph);
  const depth = computeDependencyDepth(graph);
  const fileNodes = graph.nodes.filter((n) => n.kind === "file");

  const raw = fileNodes.map((node) => ({
    fileId: node.id,
    complexity: complexityByFile.get(node.id) ?? 0,
    fanIn: fanInOut.get(node.id)?.fanIn ?? 0,
    loc: node.kind === "file" ? node.loc : 0,
    dependencyDepth: depth.get(node.id) ?? 0,
  }));

  const complexities = raw.map((r) => r.complexity);
  const fanIns = raw.map((r) => r.fanIn);
  const locs = raw.map((r) => r.loc);
  const depths = raw.map((r) => r.dependencyDepth);

  const minMax = (values: number[]) => ({
    min: Math.min(...values),
    max: Math.max(...values),
  });
  const complexityRange = minMax(complexities);
  const fanInRange = minMax(fanIns);
  const locRange = minMax(locs);
  const depthRange = minMax(depths);

  return raw.map((r) => {
    const riskScore =
      0.4 * normalize(r.complexity, complexityRange.min, complexityRange.max) +
      0.3 * normalize(r.fanIn, fanInRange.min, fanInRange.max) +
      0.2 * normalize(r.loc, locRange.min, locRange.max) +
      0.1 * normalize(r.dependencyDepth, depthRange.min, depthRange.max);

    return { ...r, riskScore };
  });
}
