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

  // Run Kahn's on the reversed graph so depth means "longest chain below this node".
  // Leaves (files that import nothing) start at depth 0; a file's depth is
  // 1 + max(depths of its direct imports). Cycle edges are ignored — nodes stuck
  // in a cycle are never dequeued and stay at depth 0.
  const reverseAdj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const fileId of adjacency.keys()) {
    reverseAdj.set(fileId, []);
    inDegree.set(fileId, 0);
  }
  for (const [fileId, neighbors] of adjacency) {
    for (const neighbor of neighbors) {
      reverseAdj.get(neighbor)!.push(fileId);
      inDegree.set(fileId, (inDegree.get(fileId) ?? 0) + 1);
    }
  }

  const depth = new Map<string, number>();
  for (const fileId of adjacency.keys()) depth.set(fileId, 0);

  const queue: string[] = [];
  for (const [fileId, deg] of inDegree) {
    if (deg === 0) queue.push(fileId);
  }

  while (queue.length > 0) {
    const fileId = queue.shift()!;
    const currentDepth = depth.get(fileId)!;
    for (const parent of reverseAdj.get(fileId) ?? []) {
      const next = Math.max(depth.get(parent) ?? 0, currentDepth + 1);
      depth.set(parent, next);
      const remaining = inDegree.get(parent)! - 1;
      inDegree.set(parent, remaining);
      if (remaining === 0) queue.push(parent);
    }
  }

  const result = new Map<string, number>();
  for (const [fileId, d] of depth) result.set(fileId, d);
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

  if (raw.length >= 2) {
    const collapsedMetrics: Array<{ name: string; range: { min: number; max: number } }> = [
      { name: "complexity", range: complexityRange },
      { name: "fanIn", range: fanInRange },
      { name: "loc", range: locRange },
      { name: "dependencyDepth", range: depthRange },
    ];
    for (const { name, range } of collapsedMetrics) {
      if (range.max === range.min) {
        console.warn(
          `[archie] Risk scoring: all files have identical ${name} (no variation) — the ${name} term contributes 0 to every risk score in this run`
        );
      }
    }
  }

  return raw.map((r) => {
    const riskScore =
      0.4 * normalize(r.complexity, complexityRange.min, complexityRange.max) +
      0.3 * normalize(r.fanIn, fanInRange.min, fanInRange.max) +
      0.2 * normalize(r.loc, locRange.min, locRange.max) +
      0.1 * normalize(r.dependencyDepth, depthRange.min, depthRange.max);

    return { ...r, riskScore };
  });
}
