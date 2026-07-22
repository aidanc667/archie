// src/summarizer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildContextPack, loadDependencies } from "./summarizer.js";
import { computeNamingConsistency } from "./consistency.js";
import * as testqualityModule from "./testquality.js";
import type { CodeGraph } from "./types.js";
import type { RiskScore } from "./metrics.js";
import type { NamingConsistencyReport } from "./consistency.js";
import type { DuplicationReport } from "./duplication.js";
import type { DeadFileReport } from "./deadcode.js";

// Wraps the real computeTestQualitySignal in a spy so tests can assert
// exactly which (source, language) pair it was called with -- or that it was
// never called at all for a top-risk file with no matching test file. The
// real implementation still runs (vi.fn(actual.computeTestQualitySignal)),
// so these tests exercise real behavior, not a stub.
vi.mock("./testquality.js", async () => {
  const actual = await vi.importActual<typeof import("./testquality.js")>("./testquality.js");
  return {
    ...actual,
    computeTestQualitySignal: vi.fn(actual.computeTestQualitySignal),
  };
});

const EMPTY_NAMING_CONSISTENCY: NamingConsistencyReport = {
  inconsistencies: [],
  dominantStyleByGroup: {},
};

const EMPTY_DUPLICATION: DuplicationReport = { groups: [] };
const EMPTY_DEAD_FILES: DeadFileReport = { candidates: [] };

beforeEach(() => {
  vi.mocked(testqualityModule.computeTestQualitySignal).mockClear();
});

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
    const pack = buildContextPack(makeGraph(), makeScores(), new Map(), { topN: 1, maxTokens: 50000 }, EMPTY_NAMING_CONSISTENCY, EMPTY_DUPLICATION, EMPTY_DEAD_FILES);

    expect(pack.topRiskFiles).toHaveLength(1);
    expect(pack.topRiskFiles[0].path).toBe("a.ts");
    expect(pack.systemSummary.fileCount).toBe(2);
    expect(pack.mode).toBe("top-n-detail");
  });

  // Regression coverage: restrictToFileIds (diff-scoping) must only filter
  // *eligibility* for the top-N slot, not the scores or graph themselves --
  // a restricted, lower-risk file must still carry its real, full-graph fanIn.
  it("restrictToFileIds limits which files are eligible for top-N, without changing their scores", () => {
    const pack = buildContextPack(
      makeGraph(),
      makeScores(),
      new Map(),
      {
        topN: 1,
        maxTokens: 50000,
        restrictToFileIds: new Set(["file:b.ts"]),
      },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

    // a.ts has the higher risk score (0.9 vs 0.1) and would normally win the
    // single topN slot -- but it's excluded from the restriction set, so
    // b.ts (fanIn=1, computed from the full 2-file graph) is selected instead.
    expect(pack.topRiskFiles).toHaveLength(1);
    expect(pack.topRiskFiles[0].path).toBe("b.ts");
    expect(pack.topRiskFiles[0].fanIn).toBe(1);
    // systemSummary still reflects the whole repo, not just the restricted set.
    expect(pack.systemSummary.fileCount).toBe(2);
  });

  it("falls back to cluster-summary mode when detail set exceeds token budget", () => {
    const pack = buildContextPack(makeGraph(), makeScores(), new Map(), { topN: 1, maxTokens: 1 }, EMPTY_NAMING_CONSISTENCY, EMPTY_DUPLICATION, EMPTY_DEAD_FILES);

    expect(pack.mode).toBe("cluster-summary");
    expect(pack.topRiskFiles).toEqual([]);
  });

  it("incrementally prunes the lowest-risk file when budget fits 2 of 3 but not all 3", () => {
    const pack = buildContextPack(
      makeThreeFileGraph(),
      makeThreeFileScores(),
      new Map(),
      // Bumped from 170: adding the required magicNumbers field to every
      // TopRiskFile (this phase's wave-3 wiring) grew the serialized pack
      // size, so the old threshold no longer fit 2 of 3 files -- this value
      // restores the test's original intent (2 of 3 fit, not all 3), it is
      // not a change in what's being verified.
      { topN: 3, maxTokens: 200 },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

    expect(pack.mode).toBe("top-n-detail");
    expect(pack.topRiskFiles).toHaveLength(2);
    expect(pack.topRiskFiles.map((f) => f.path)).toEqual(["a.ts", "c.ts"]);
  });

  it("populates topRiskFiles[].source from sourceByPath for included files", () => {
    const sourceByPath = new Map<string, string>([
      ["file:a.ts", "export function a() { return 1; }"],
      ["file:b.ts", "export function b() { return 2; }"],
    ]);

    const pack = buildContextPack(
      makeGraph(),
      makeScores(),
      sourceByPath,
      { topN: 1, maxTokens: 50000 },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

    expect(pack.topRiskFiles).toHaveLength(1);
    expect(pack.topRiskFiles[0].path).toBe("a.ts");
    expect(pack.topRiskFiles[0].source).toBe("export function a() { return 1; }");
  });

  it("falls back to an empty string when a top-risk file's source is missing from the map", () => {
    const sourceByPath = new Map<string, string>(); // empty — no entries

    const pack = buildContextPack(
      makeGraph(),
      makeScores(),
      sourceByPath,
      { topN: 1, maxTokens: 50000 },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

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

    const pack = buildContextPack(
      graph,
      scores,
      new Map(),
      { topN: 2, maxTokens: 50000 },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

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

    const pack = buildContextPack(
      makeGraph(),
      makeScores(),
      sourceByPath,
      { topN: 2, maxTokens: 50000 },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

    const fileA = pack.topRiskFiles.find((f) => f.path === "a.ts");
    const fileB = pack.topRiskFiles.find((f) => f.path === "b.ts");
    expect(fileA?.hasErrorHandling).toBe(true);
    expect(fileB?.hasErrorHandling).toBe(false);
  });

  // Regression coverage for a false claim found on a real report: Archie
  // named four private helper functions as exported (claiming "13 exported
  // functions") because nothing surfaced a file's real exported API surface
  // as a checkable fact. exportedSymbols is that fact -- built from EXPORTS
  // edges, so it can only ever list what's actually exported.
  it("populates exportedSymbols from EXPORTS edges, excluding private/unexported symbols", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 50 },
        { kind: "function", id: "function:a.ts:publicFn:1", name: "publicFn", fileId: "file:a.ts", startLine: 1, endLine: 3 },
        { kind: "function", id: "function:a.ts:privateFn:5", name: "privateFn", fileId: "file:a.ts", startLine: 5, endLine: 7 },
        { kind: "class", id: "class:a.ts:PublicClass:9", name: "PublicClass", fileId: "file:a.ts", startLine: 9, endLine: 12 },
      ],
      edges: [
        { type: "CONTAINS", from: "file:a.ts", to: "function:a.ts:publicFn:1", confidence: 1.0 },
        { type: "CONTAINS", from: "file:a.ts", to: "function:a.ts:privateFn:5", confidence: 1.0 },
        { type: "CONTAINS", from: "file:a.ts", to: "class:a.ts:PublicClass:9", confidence: 1.0 },
        { type: "EXPORTS", from: "file:a.ts", to: "function:a.ts:publicFn:1", confidence: 1.0 },
        { type: "EXPORTS", from: "file:a.ts", to: "class:a.ts:PublicClass:9", confidence: 1.0 },
      ],
    };
    const scores: RiskScore[] = [
      { fileId: "file:a.ts", riskScore: 0.9, complexity: 5, fanIn: 0, loc: 50, dependencyDepth: 0 },
    ];

    const pack = buildContextPack(
      graph,
      scores,
      new Map(),
      { topN: 1, maxTokens: 50000 },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

    expect(pack.topRiskFiles[0].exportedSymbols.sort()).toEqual(["PublicClass", "publicFn"]);
  });

  it("excludes private symbols from the signature summary for files beyond the top 3 (full-source cutoff)", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:d.ts", path: "d.ts", loc: 50 },
        { kind: "function", id: "function:d.ts:publicFn:1", name: "publicFn", fileId: "file:d.ts", startLine: 1, endLine: 3 },
        { kind: "function", id: "function:d.ts:privateFn:5", name: "privateFn", fileId: "file:d.ts", startLine: 5, endLine: 7 },
      ],
      edges: [
        { type: "CONTAINS", from: "file:d.ts", to: "function:d.ts:publicFn:1", confidence: 1.0 },
        { type: "CONTAINS", from: "file:d.ts", to: "function:d.ts:privateFn:5", confidence: 1.0 },
        { type: "EXPORTS", from: "file:d.ts", to: "function:d.ts:publicFn:1", confidence: 1.0 },
      ],
    };
    // 4 filler files ranked above "d.ts" so it lands at index 4 (beyond the
    // top-3 full-source cutoff) and gets the signature-summary path instead.
    const fillerNodes: CodeGraph["nodes"] = [];
    const fillerScores: RiskScore[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `file:filler${i}.ts`;
      fillerNodes.push({ kind: "file", id, path: `filler${i}.ts`, loc: 5 });
      fillerScores.push({ fileId: id, riskScore: 1 - i * 0.01, complexity: 1, fanIn: 0, loc: 5, dependencyDepth: 0 });
    }
    const fullGraph: CodeGraph = { nodes: [...fillerNodes, ...graph.nodes], edges: graph.edges };
    const scores: RiskScore[] = [...fillerScores, { fileId: "file:d.ts", riskScore: 0.5, complexity: 5, fanIn: 0, loc: 50, dependencyDepth: 0 }];

    const pack = buildContextPack(
      fullGraph,
      scores,
      new Map(),
      { topN: 5, maxTokens: 50000 },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

    const fileD = pack.topRiskFiles.find((f) => f.path === "d.ts");
    expect(fileD?.source).toContain("publicFn");
    expect(fileD?.source).not.toContain("privateFn");
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
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES,
      { next: "16.2.2", react: "19.0.0" }
    );

    expect(pack.dependencies).toEqual({ next: "16.2.2", react: "19.0.0" });
  });

  it("leaves dependencies undefined when none is provided", () => {
    const pack = buildContextPack(
      makeGraph(),
      makeScores(),
      new Map(),
      { topN: 1, maxTokens: 50000 },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

    expect(pack.dependencies).toBeUndefined();
  });

  it("includes dependencies in the cluster-summary fallback too", () => {
    const pack = buildContextPack(
      makeGraph(),
      makeScores(),
      new Map(),
      { topN: 1, maxTokens: 1 },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES,
      { next: "16.2.2" }
    );

    expect(pack.mode).toBe("cluster-summary");
    expect(pack.dependencies).toEqual({ next: "16.2.2" });
  });

  // Required test #1: buildContextPack's result includes a namingConsistency
  // field populated from computeNamingConsistency(graph)'s actual return
  // value -- this is a whole-codebase signal, so it must appear in both
  // top-n-detail mode and the cluster-summary fallback, not just the former.
  it("populates namingConsistency from computeNamingConsistency(graph) in top-n-detail mode", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "function", id: "fn:1", name: "doWork", fileId: "file:a.ts", startLine: 1, endLine: 2 },
        { kind: "function", id: "fn:2", name: "fetchData", fileId: "file:a.ts", startLine: 3, endLine: 4 },
        { kind: "function", id: "fn:3", name: "my_function", fileId: "file:a.ts", startLine: 5, endLine: 6 },
      ],
      edges: [],
    };
    const scores: RiskScore[] = [
      { fileId: "file:a.ts", riskScore: 0.9, complexity: 5, fanIn: 0, loc: 10, dependencyDepth: 0 },
    ];
    const expected = computeNamingConsistency(graph);
    expect(expected.inconsistencies.length).toBeGreaterThan(0); // sanity: this fixture actually has one

    const pack = buildContextPack(
      graph,
      scores,
      new Map(),
      { topN: 1, maxTokens: 50000 },
      expected,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

    expect(pack.mode).toBe("top-n-detail");
    expect(pack.namingConsistency).toEqual(expected);
  });

  it("populates namingConsistency in the cluster-summary fallback too", () => {
    const graph = makeGraph();
    const expected = computeNamingConsistency(graph);

    const pack = buildContextPack(
      graph,
      makeScores(),
      new Map(),
      { topN: 1, maxTokens: 1 },
      expected,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

    expect(pack.mode).toBe("cluster-summary");
    expect(pack.namingConsistency).toEqual(expected);
  });

  // Required test: buildContextPack threads duplication/deadFiles through
  // unchanged in top-n-detail mode -- these are whole-codebase signals (same
  // reasoning as namingConsistency above), so they belong in the pack
  // regardless of which files made the top-N cut.
  it("populates duplication and deadFiles from the values passed in, in top-n-detail mode", () => {
    const duplication: DuplicationReport = {
      groups: [
        {
          bodyHash: "hash1",
          functions: [
            { name: "doThing", fileId: "file:a.ts" },
            { name: "doThingToo", fileId: "file:b.ts" },
          ],
        },
      ],
    };
    const deadFiles: DeadFileReport = {
      candidates: [{ fileId: "file:b.ts", path: "b.ts" }],
    };

    const pack = buildContextPack(
      makeGraph(),
      makeScores(),
      new Map(),
      { topN: 1, maxTokens: 50000 },
      EMPTY_NAMING_CONSISTENCY,
      duplication,
      deadFiles
    );

    expect(pack.mode).toBe("top-n-detail");
    expect(pack.duplication).toEqual(duplication);
    expect(pack.deadFiles).toEqual(deadFiles);
  });

  it("populates duplication and deadFiles in the cluster-summary fallback too", () => {
    const duplication: DuplicationReport = {
      groups: [
        {
          bodyHash: "hash1",
          functions: [
            { name: "doThing", fileId: "file:a.ts" },
            { name: "doThingToo", fileId: "file:b.ts" },
          ],
        },
      ],
    };
    const deadFiles: DeadFileReport = {
      candidates: [{ fileId: "file:b.ts", path: "b.ts" }],
    };

    const pack = buildContextPack(
      makeGraph(),
      makeScores(),
      new Map(),
      { topN: 1, maxTokens: 1 },
      EMPTY_NAMING_CONSISTENCY,
      duplication,
      deadFiles
    );

    expect(pack.mode).toBe("cluster-summary");
    expect(pack.duplication).toEqual(duplication);
    expect(pack.deadFiles).toEqual(deadFiles);
  });

  // Required test: a top-risk file's magicNumbers field is sourced from that
  // file's FileNode.magicNumbers (via the graph), defaulting to [] when the
  // FileNode has none set (older-style fixture, or a file with none found) --
  // mirrors the ?? [] fail-open convention used elsewhere in this codebase for
  // missing optional signals (dependencies, goModuleName, path aliases).
  it("populates topRiskFiles[].magicNumbers from the file's FileNode.magicNumbers, defaulting to [] when unset", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          kind: "file",
          id: "file:a.ts",
          path: "a.ts",
          loc: 100,
          magicNumbers: [{ value: "42", line: 3 }],
        },
        { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 }, // no magicNumbers field at all
      ],
      edges: [],
    };

    const pack = buildContextPack(
      graph,
      makeScores(),
      new Map(),
      { topN: 2, maxTokens: 50000 },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

    const fileA = pack.topRiskFiles.find((f) => f.path === "a.ts");
    const fileB = pack.topRiskFiles.find((f) => f.path === "b.ts");
    expect(fileA?.magicNumbers).toEqual([{ value: "42", line: 3 }]);
    expect(fileB?.magicNumbers).toEqual([]);
  });

  // Required test #2: a top-risk file with a matching test file gets its
  // testCaseCount/hasTestAssertions computed from the TEST file's source (not
  // the source file's own source), via the language detected from the test
  // file's path.
  it("computes testCaseCount/hasTestAssertions from the matching test file's source and detected language", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "file", id: "file:a.test.ts", path: "a.test.ts", loc: 20 },
      ],
      edges: [{ type: "TESTED_BY", from: "file:a.ts", to: "file:a.test.ts", confidence: 1.0 }],
    };
    const scores: RiskScore[] = [
      { fileId: "file:a.ts", riskScore: 0.9, complexity: 5, fanIn: 0, loc: 10, dependencyDepth: 0 },
    ];
    const sourceByPath = new Map<string, string>([
      ["file:a.ts", "export function a() { return 1; } // no it()/test() calls in here"],
      [
        "file:a.test.ts",
        `
        import { it, expect } from "vitest";
        it("does a thing", () => { expect(1).toBe(1); });
        it("does another thing", () => { expect(2).toBe(2); });
        `,
      ],
    ]);

    const pack = buildContextPack(
      graph,
      scores,
      sourceByPath,
      { topN: 1, maxTokens: 50000 },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

    expect(pack.topRiskFiles[0].testCaseCount).toBe(2);
    expect(pack.topRiskFiles[0].hasTestAssertions).toBe(true);
    expect(vi.mocked(testqualityModule.computeTestQualitySignal)).toHaveBeenCalledWith(
      sourceByPath.get("file:a.test.ts"),
      "ts"
    );
    // Never called with the source file's own source -- that would be
    // meaningless (it's not a test file).
    expect(vi.mocked(testqualityModule.computeTestQualitySignal)).not.toHaveBeenCalledWith(
      sourceByPath.get("file:a.ts"),
      expect.anything()
    );
  });

  // Required test #3: a top-risk file with NO matching test file defaults to
  // the zero-signal values, and computeTestQualitySignal is never invoked for
  // it at all (there's nothing meaningful to compute a signal from).
  it("defaults to zero testCaseCount/hasTestAssertions and never calls computeTestQualitySignal when there is no matching test file", () => {
    const pack = buildContextPack(
      makeGraph(),
      makeScores(),
      new Map(),
      { topN: 2, maxTokens: 50000 },
      EMPTY_NAMING_CONSISTENCY,
      EMPTY_DUPLICATION,
      EMPTY_DEAD_FILES
    );

    expect(pack.topRiskFiles).toHaveLength(2);
    for (const file of pack.topRiskFiles) {
      expect(file.testCaseCount).toBe(0);
      expect(file.hasTestAssertions).toBe(false);
    }
    expect(testqualityModule.computeTestQualitySignal).not.toHaveBeenCalled();
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
