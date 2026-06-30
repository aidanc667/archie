// src/metrics.test.ts
import { describe, it, expect } from "vitest";
import { computeFanInOut, computeRiskScores } from "./metrics.js";
import type { CodeGraph } from "./types.js";

describe("computeFanInOut", () => {
  it("counts import fan-in and fan-out per file", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "file", id: "file:b.ts", path: "b.ts", loc: 5 },
        { kind: "file", id: "file:c.ts", path: "c.ts", loc: 5 },
      ],
      edges: [
        { type: "IMPORTS", from: "file:a.ts", to: "file:b.ts", confidence: 1.0 },
        { type: "IMPORTS", from: "file:c.ts", to: "file:b.ts", confidence: 1.0 },
      ],
    };

    const result = computeFanInOut(graph);
    expect(result.get("file:b.ts")).toEqual({ fanIn: 2, fanOut: 0 });
    expect(result.get("file:a.ts")).toEqual({ fanIn: 0, fanOut: 1 });
  });
});

describe("computeRiskScores", () => {
  it("ranks higher complexity/fan-in/size files with higher risk score", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:big.ts", path: "big.ts", loc: 1000 },
        { kind: "file", id: "file:small.ts", path: "small.ts", loc: 10 },
      ],
      edges: [],
    };
    const complexityByFile = new Map([
      ["file:big.ts", 50],
      ["file:small.ts", 1],
    ]);

    const scores = computeRiskScores(graph, complexityByFile);
    const big = scores.find((s) => s.fileId === "file:big.ts")!;
    const small = scores.find((s) => s.fileId === "file:small.ts")!;

    expect(big.riskScore).toBeGreaterThan(small.riskScore);
  });
});
