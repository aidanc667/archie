// src/metrics.test.ts
import { describe, it, expect } from "vitest";
import { computeFanInOut, computeRiskScores, computeDependencyDepth } from "./metrics.js";
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

describe("computeDependencyDepth", () => {
  it("computes increasing depth along a linear import chain (a -> b -> c)", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 },
        { kind: "file", id: "file:c.ts", path: "c.ts", loc: 10 },
      ],
      edges: [
        { type: "IMPORTS", from: "file:a.ts", to: "file:b.ts", confidence: 1.0 },
        { type: "IMPORTS", from: "file:b.ts", to: "file:c.ts", confidence: 1.0 },
      ],
    };

    const result = computeDependencyDepth(graph);
    expect(result.get("file:c.ts")).toBe(0);
    expect(result.get("file:b.ts")).toBe(1);
    expect(result.get("file:a.ts")).toBe(2);
  });

  it("terminates and returns 0 for all nodes in a mutual import cycle (a -> b -> a)", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 },
      ],
      edges: [
        { type: "IMPORTS", from: "file:a.ts", to: "file:b.ts", confidence: 1.0 },
        { type: "IMPORTS", from: "file:b.ts", to: "file:a.ts", confidence: 1.0 },
      ],
    };

    const result = computeDependencyDepth(graph);
    // Kahn's algorithm: cycle nodes are never dequeued, so their depth stays 0.
    expect(result.get("file:a.ts")).toBe(0);
    expect(result.get("file:b.ts")).toBe(0);
  });

  it("does not stack-overflow on a long linear chain (10 000 files)", () => {
    const N = 10_000;
    const nodes = Array.from({ length: N }, (_, i) => ({
      kind: "file" as const,
      id: `file:f${i}.ts`,
      path: `f${i}.ts`,
      loc: 1,
    }));
    const edges = Array.from({ length: N - 1 }, (_, i) => ({
      type: "IMPORTS" as const,
      from: `file:f${i}.ts`,
      to: `file:f${i + 1}.ts`,
      confidence: 1.0,
    }));

    expect(() => computeDependencyDepth({ nodes, edges })).not.toThrow();
    const result = computeDependencyDepth({ nodes, edges });
    expect(result.get("file:f0.ts")).toBe(N - 1); // root importer: longest chain below
    expect(result.get(`file:f${N - 1}.ts`)).toBe(0); // leaf: nothing below it
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
