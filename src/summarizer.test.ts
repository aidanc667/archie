// src/summarizer.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildContextPack, loadDependencies } from "./summarizer.js";
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
      maxTokens: 110,
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

  it("sets hasTests=true on a top-risk file with a TESTED_BY edge, and false otherwise", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 100 },
        { kind: "file", id: "file:a.test.ts", path: "a.test.ts", loc: 30 },
        { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 },
      ],
      edges: [
        { type: "TESTED_BY", from: "file:a.ts", to: "file:a.test.ts", confidence: 1.0 },
      ],
    };
    const scores: RiskScore[] = [
      { fileId: "file:a.ts", riskScore: 0.9, complexity: 10, fanIn: 0, loc: 100, dependencyDepth: 1 },
      { fileId: "file:b.ts", riskScore: 0.5, complexity: 5, fanIn: 1, loc: 10, dependencyDepth: 0 },
    ];

    const pack = buildContextPack(graph, scores, new Map(), { topN: 2, maxTokens: 50000 });

    const fileA = pack.topRiskFiles.find((f) => f.path === "a.ts");
    const fileB = pack.topRiskFiles.find((f) => f.path === "b.ts");
    expect(fileA?.hasTests).toBe(true);
    expect(fileB?.hasTests).toBe(false);
  });

  it("sets hasErrorHandling=true for a file with a try/catch block, and false otherwise", () => {
    const sourceByPath = new Map<string, string>([
      ["file:a.ts", "function a() { try { risky(); } catch (e) { handle(e); } }"],
      ["file:b.ts", "function b() { return 2; }"],
    ]);

    const pack = buildContextPack(makeGraph(), makeScores(), sourceByPath, {
      topN: 2,
      maxTokens: 50000,
    });

    const fileA = pack.topRiskFiles.find((f) => f.path === "a.ts");
    const fileB = pack.topRiskFiles.find((f) => f.path === "b.ts");
    expect(fileA?.hasErrorHandling).toBe(true);
    expect(fileB?.hasErrorHandling).toBe(false);
  });

  // Regression coverage for a bug found on a real report: the System Summary
  // claimed "Next.js 14" for a target repo whose actual package.json said
  // "next": "16.2.2" -- the version was guessed from file-structure
  // conventions instead of read from the manifest. This pins that a
  // dependencies map passed into buildContextPack shows up verbatim in the
  // pack for the prompt to cite.
  it("includes a dependencies map in the pack when provided", () => {
    const pack = buildContextPack(
      makeGraph(),
      makeScores(),
      new Map(),
      { topN: 1, maxTokens: 50000 },
      { next: "16.2.2", react: "19.0.0" }
    );

    expect(pack.dependencies).toEqual({ next: "16.2.2", react: "19.0.0" });
  });

  it("leaves dependencies undefined when none is provided", () => {
    const pack = buildContextPack(makeGraph(), makeScores(), new Map(), { topN: 1, maxTokens: 50000 });

    expect(pack.dependencies).toBeUndefined();
  });

  it("includes dependencies in the cluster-summary fallback too", () => {
    const pack = buildContextPack(
      makeGraph(),
      makeScores(),
      new Map(),
      { topN: 1, maxTokens: 1 },
      { next: "16.2.2" }
    );

    expect(pack.mode).toBe("cluster-summary");
    expect(pack.dependencies).toEqual({ next: "16.2.2" });
  });
});

describe("loadDependencies", () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "archie-deps-test-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("merges dependencies and devDependencies from package.json", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({
          dependencies: { next: "16.2.2", react: "19.0.0" },
          devDependencies: { typescript: "5.6.3" },
        })
      );

      const deps = await loadDependencies(dir);
      expect(deps).toEqual({ next: "16.2.2", react: "19.0.0", typescript: "5.6.3" });
    });
  });

  it("returns undefined when package.json does not exist", async () => {
    await withTempDir(async (dir) => {
      const deps = await loadDependencies(dir);
      expect(deps).toBeUndefined();
    });
  });

  it("returns undefined for malformed JSON rather than throwing", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "package.json"), "{ not valid json");
      const deps = await loadDependencies(dir);
      expect(deps).toBeUndefined();
    });
  });

  it("returns undefined when package.json has neither dependencies nor devDependencies", async () => {
    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "some-repo" }));
      const deps = await loadDependencies(dir);
      expect(deps).toBeUndefined();
    });
  });
});
