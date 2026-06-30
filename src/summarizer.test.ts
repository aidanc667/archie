// src/summarizer.test.ts
import { describe, it, expect } from "vitest";
import { buildContextPack } from "./summarizer.js";
import type { CodeGraph } from "./types.js";
import type { RiskScore } from "./metrics.js";

function makeGraph(): CodeGraph {
  return {
    nodes: [
      { kind: "file", id: "file:a.ts", path: "a.ts", loc: 100 },
      { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 },
    ],
    edges: [{ type: "IMPORTS", from: "file:a.ts", to: "file:b.ts", confidence: 1.0 }],
  };
}

function makeScores(): RiskScore[] {
  return [
    { fileId: "file:a.ts", riskScore: 0.9, complexity: 10, fanIn: 0, loc: 100, dependencyDepth: 1 },
    { fileId: "file:b.ts", riskScore: 0.1, complexity: 1, fanIn: 1, loc: 10, dependencyDepth: 0 },
  ];
}

describe("buildContextPack", () => {
  it("includes top-N risk files with full metrics and a graph snapshot", () => {
    const pack = buildContextPack(makeGraph(), makeScores(), { topN: 1, maxTokens: 50000 });

    expect(pack.topRiskFiles).toHaveLength(1);
    expect(pack.topRiskFiles[0].path).toBe("a.ts");
    expect(pack.systemSummary.fileCount).toBe(2);
    expect(pack.mode).toBe("top-n-detail");
  });

  it("falls back to cluster-summary mode when detail set exceeds token budget", () => {
    const pack = buildContextPack(makeGraph(), makeScores(), { topN: 1, maxTokens: 1 });

    expect(pack.mode).toBe("cluster-summary");
    expect(pack.topRiskFiles).toEqual([]);
  });
});
