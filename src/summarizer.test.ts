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

function makeThreeFileGraph(): CodeGraph {
  return {
    nodes: [
      { kind: "file", id: "file:a.ts", path: "a.ts", loc: 100 },
      { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 },
      { kind: "file", id: "file:c.ts", path: "c.ts", loc: 20 },
    ],
    edges: [
      { type: "IMPORTS", from: "file:a.ts", to: "file:b.ts", confidence: 1.0 },
      { type: "IMPORTS", from: "file:a.ts", to: "file:c.ts", confidence: 1.0 },
    ],
  };
}

function makeThreeFileScores(): RiskScore[] {
  return [
    { fileId: "file:a.ts", riskScore: 0.9, complexity: 10, fanIn: 0, loc: 100, dependencyDepth: 1 },
    { fileId: "file:c.ts", riskScore: 0.5, complexity: 5, fanIn: 1, loc: 20, dependencyDepth: 1 },
    { fileId: "file:b.ts", riskScore: 0.1, complexity: 1, fanIn: 1, loc: 10, dependencyDepth: 0 },
  ];
}

describe("buildContextPack", () => {
  it("includes top-N risk files with full metrics and a graph snapshot", () => {
    const pack = buildContextPack(makeGraph(), makeScores(), new Map(), { topN: 1, maxTokens: 50000 });

    expect(pack.topRiskFiles).toHaveLength(1);
    expect(pack.topRiskFiles[0].path).toBe("a.ts");
    expect(pack.systemSummary.fileCount).toBe(2);
    expect(pack.mode).toBe("top-n-detail");
  });

  it("falls back to cluster-summary mode when detail set exceeds token budget", () => {
    const pack = buildContextPack(makeGraph(), makeScores(), new Map(), { topN: 1, maxTokens: 1 });

    expect(pack.mode).toBe("cluster-summary");
    expect(pack.topRiskFiles).toEqual([]);
  });

  it("incrementally prunes the lowest-risk file when budget fits 2 of 3 but not all 3", () => {
    const pack = buildContextPack(makeThreeFileGraph(), makeThreeFileScores(), new Map(), {
      topN: 3,
      maxTokens: 89,
    });

    expect(pack.mode).toBe("top-n-detail");
    expect(pack.topRiskFiles).toHaveLength(2);
    expect(pack.topRiskFiles.map((f) => f.path)).toEqual(["a.ts", "c.ts"]);
  });

  it("populates topRiskFiles[].source from sourceByPath for included files", () => {
    const sourceByPath = new Map<string, string>([
      ["file:a.ts", "export function a() { return 1; }"],
      ["file:b.ts", "export function b() { return 2; }"],
    ]);

    const pack = buildContextPack(makeGraph(), makeScores(), sourceByPath, {
      topN: 1,
      maxTokens: 50000,
    });

    expect(pack.topRiskFiles).toHaveLength(1);
    expect(pack.topRiskFiles[0].path).toBe("a.ts");
    expect(pack.topRiskFiles[0].source).toBe("export function a() { return 1; }");
  });

  it("falls back to an empty string when a top-risk file's source is missing from the map", () => {
    const sourceByPath = new Map<string, string>(); // empty — no entries

    const pack = buildContextPack(makeGraph(), makeScores(), sourceByPath, {
      topN: 1,
      maxTokens: 50000,
    });

    expect(pack.topRiskFiles).toHaveLength(1);
    expect(pack.topRiskFiles[0].source).toBe("");
  });
});
