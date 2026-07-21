// src/consistency.test.ts
import { describe, it, expect } from "vitest";
import { computeNamingConsistency } from "./consistency.js";
import type { CodeGraph } from "./types.js";

describe("computeNamingConsistency", () => {
  it("computes each language's dominant style independently, with no cross-language false flags", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "file", id: "file:b.py", path: "b.py", loc: 10 },
        // TS functions: mostly camelCase
        { kind: "function", id: "fn:1", name: "doWork", fileId: "file:a.ts", startLine: 1, endLine: 2 },
        { kind: "function", id: "fn:2", name: "fetchData", fileId: "file:a.ts", startLine: 3, endLine: 4 },
        { kind: "function", id: "fn:3", name: "parseInput", fileId: "file:a.ts", startLine: 5, endLine: 6 },
        // Python functions: mostly snake_case
        { kind: "function", id: "fn:4", name: "do_work", fileId: "file:b.py", startLine: 1, endLine: 2 },
        { kind: "function", id: "fn:5", name: "fetch_data", fileId: "file:b.py", startLine: 3, endLine: 4 },
        { kind: "function", id: "fn:6", name: "parse_input", fileId: "file:b.py", startLine: 5, endLine: 6 },
      ],
      edges: [],
    };

    const report = computeNamingConsistency(graph);

    expect(report.dominantStyleByGroup["ts:function"]).toBe("camelCase");
    expect(report.dominantStyleByGroup["python:function"]).toBe("snake_case");
    // Every python name is snake_case which matches python's own dominant style -
    // none of them should be flagged just because TS's dominant style differs.
    expect(report.inconsistencies).toEqual([]);
  });

  it("classifies a signal-less name as ambiguous and never flags it, even sitting among many camelCase names", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "function", id: "fn:1", name: "doWork", fileId: "file:a.ts", startLine: 1, endLine: 2 },
        { kind: "function", id: "fn:2", name: "fetchData", fileId: "file:a.ts", startLine: 3, endLine: 4 },
        { kind: "function", id: "fn:3", name: "parseInput", fileId: "file:a.ts", startLine: 5, endLine: 6 },
        { kind: "function", id: "fn:4", name: "run", fileId: "file:a.ts", startLine: 7, endLine: 8 },
      ],
      edges: [],
    };

    const report = computeNamingConsistency(graph);

    expect(report.inconsistencies).toEqual([]);
  });

  it("flags a name with a clear underscore signal sitting among many camelCase TS functions", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "function", id: "fn:1", name: "doWork", fileId: "file:a.ts", startLine: 1, endLine: 2 },
        { kind: "function", id: "fn:2", name: "fetchData", fileId: "file:a.ts", startLine: 3, endLine: 4 },
        { kind: "function", id: "fn:3", name: "parseInput", fileId: "file:a.ts", startLine: 5, endLine: 6 },
        { kind: "function", id: "fn:4", name: "my_function", fileId: "file:a.ts", startLine: 7, endLine: 8 },
      ],
      edges: [],
    };

    const report = computeNamingConsistency(graph);

    expect(report.inconsistencies).toEqual([
      {
        name: "my_function",
        fileId: "file:a.ts",
        kind: "function",
        language: "ts",
        detectedStyle: "snake_case",
        dominantStyle: "camelCase",
      },
    ]);
  });

  it("computes no dominant style for a group with only 1 non-ambiguous name, and flags nothing", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.go", path: "a.go", loc: 10 },
        { kind: "function", id: "fn:1", name: "run", fileId: "file:a.go", startLine: 1, endLine: 2 },
        { kind: "function", id: "fn:2", name: "go", fileId: "file:a.go", startLine: 3, endLine: 4 },
        { kind: "function", id: "fn:3", name: "weird_ONE", fileId: "file:a.go", startLine: 5, endLine: 6 },
      ],
      edges: [],
    };

    const report = computeNamingConsistency(graph);

    expect(report.dominantStyleByGroup["go:function"]).toBeUndefined();
    expect(report.inconsistencies).toEqual([]);
  });

  it("contributes nothing and does not crash for a file with zero functions and zero classes", () => {
    const graph: CodeGraph = {
      nodes: [{ kind: "file", id: "file:constants.ts", path: "constants.ts", loc: 20 }],
      edges: [],
    };

    expect(() => computeNamingConsistency(graph)).not.toThrow();
    const report = computeNamingConsistency(graph);
    expect(report).toEqual({ inconsistencies: [], dominantStyleByGroup: {} });
  });

  it("tracks classes and functions as separate groups within the same file, so PascalCase classes and camelCase functions don't flag each other", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "class", id: "cls:1", name: "UserService", fileId: "file:a.ts", startLine: 1, endLine: 10 },
        { kind: "class", id: "cls:2", name: "OrderRepository", fileId: "file:a.ts", startLine: 11, endLine: 20 },
        { kind: "function", id: "fn:1", name: "doWork", fileId: "file:a.ts", startLine: 21, endLine: 22 },
        { kind: "function", id: "fn:2", name: "fetchData", fileId: "file:a.ts", startLine: 23, endLine: 24 },
      ],
      edges: [],
    };

    const report = computeNamingConsistency(graph);

    expect(report.dominantStyleByGroup["ts:class"]).toBe("PascalCase");
    expect(report.dominantStyleByGroup["ts:function"]).toBe("camelCase");
    expect(report.inconsistencies).toEqual([]);
  });

  it("classifies SCREAMING_SNAKE_CASE as its own distinct style, not folded into snake_case", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "function", id: "fn:1", name: "MAX_RETRY_COUNT", fileId: "file:a.ts", startLine: 1, endLine: 2 },
        { kind: "function", id: "fn:2", name: "DEFAULT_TIMEOUT_MS", fileId: "file:a.ts", startLine: 3, endLine: 4 },
        { kind: "function", id: "fn:3", name: "my_function", fileId: "file:a.ts", startLine: 5, endLine: 6 },
      ],
      edges: [],
    };

    const report = computeNamingConsistency(graph);

    expect(report.dominantStyleByGroup["ts:function"]).toBe("SCREAMING_SNAKE_CASE");
    expect(report.inconsistencies).toEqual([
      {
        name: "my_function",
        fileId: "file:a.ts",
        kind: "function",
        language: "ts",
        detectedStyle: "snake_case",
        dominantStyle: "SCREAMING_SNAKE_CASE",
      },
    ]);
  });

  it("does not misclassify a leading-underscore private-name marker as snake_case", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "function", id: "fn:1", name: "doWork", fileId: "file:a.ts", startLine: 1, endLine: 2 },
        { kind: "function", id: "fn:2", name: "fetchData", fileId: "file:a.ts", startLine: 3, endLine: 4 },
        { kind: "function", id: "fn:3", name: "_privateHelper", fileId: "file:a.ts", startLine: 5, endLine: 6 },
      ],
      edges: [],
    };

    const report = computeNamingConsistency(graph);

    // `_privateHelper` reads as camelCase once its privacy marker is set
    // aside -- it should match the group's dominant camelCase style, not be
    // flagged as a snake_case outlier just because of the leading underscore.
    expect(report.inconsistencies).toEqual([]);
  });

  it("classifies a dunder name as ambiguous once its underscore markers are stripped, not SCREAMING_SNAKE_CASE", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.py", path: "a.py", loc: 10 },
        { kind: "function", id: "fn:1", name: "do_work", fileId: "file:a.py", startLine: 1, endLine: 2 },
        { kind: "function", id: "fn:2", name: "fetch_data", fileId: "file:a.py", startLine: 3, endLine: 4 },
        { kind: "function", id: "fn:3", name: "__init__", fileId: "file:a.py", startLine: 5, endLine: 6 },
      ],
      edges: [],
    };

    const report = computeNamingConsistency(graph);

    // "__init__" strips to "init" -- a single lowercase word with no
    // internal signal, so it's ambiguous and compatible with the group's
    // snake_case dominant style, not flagged.
    expect(report.inconsistencies).toEqual([]);
  });

  it("returns an empty report for a completely empty graph", () => {
    const graph: CodeGraph = { nodes: [], edges: [] };

    const report = computeNamingConsistency(graph);

    expect(report).toEqual({ inconsistencies: [], dominantStyleByGroup: {} });
  });
});
