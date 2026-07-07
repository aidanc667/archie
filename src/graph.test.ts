// src/graph.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildGraph, loadPathAliases, type PathAliasRule } from "./graph.js";
import type { ParsedFile } from "./parser.js";

describe("buildGraph", () => {
  it("builds FileNodes, CONTAINS edges, and resolves relative IMPORTS edges", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/src/a.ts",
        {
          loc: 10,
          parsed: {
            functions: [{ name: "doWork", startLine: 1, endLine: 3, isExported: true }],
            classes: [],
            imports: ["./b"],
          },
        },
      ],
      [
        "/repo/src/b.ts",
        { loc: 5, parsed: { functions: [], classes: [], imports: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const fileNodes = graph.nodes.filter((n) => n.kind === "file");
    expect(fileNodes.map((n) => n.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);

    const functionNodes = graph.nodes.filter((n) => n.kind === "function");
    expect(functionNodes).toHaveLength(1);

    const containsEdges = graph.edges.filter((e) => e.type === "CONTAINS");
    expect(containsEdges).toHaveLength(1);

    const importEdges = graph.edges.filter((e) => e.type === "IMPORTS");
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0].confidence).toBe(1.0);
  });

  // Regression coverage for a false claim found on a real report: Archie
  // named four private helper functions as exported (claiming "13 exported
  // functions") because nothing tracked which functions/classes a file
  // actually exports. EXPORTS edges (an edge type already defined in
  // types.ts but never generated until now) make this a checkable graph
  // fact instead of something the report-generation LLM has to guess.
  it("emits an EXPORTS edge only for functions/classes actually marked isExported", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/src/a.ts",
        {
          loc: 20,
          parsed: {
            functions: [
              { name: "publicFn", startLine: 1, endLine: 3, isExported: true },
              { name: "privateFn", startLine: 5, endLine: 7, isExported: false },
            ],
            classes: [
              { name: "PublicClass", startLine: 9, endLine: 12, isExported: true },
              { name: "PrivateClass", startLine: 14, endLine: 16, isExported: false },
            ],
            imports: [],
          },
        },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const exportsEdges = graph.edges.filter((e) => e.type === "EXPORTS");
    expect(exportsEdges).toHaveLength(2);

    const exportedNames = exportsEdges
      .map((e) => graph.nodes.find((n) => n.id === e.to))
      .map((n) => (n && "name" in n ? n.name : undefined));
    expect(exportedNames.sort()).toEqual(["PublicClass", "publicFn"]);
  });

  it("resolves NodeNext-style imports that use a .js extension pointing at a .ts source file", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/src/a.ts",
        {
          loc: 10,
          parsed: {
            functions: [],
            classes: [],
            imports: ["./b.js"],
          },
        },
      ],
      [
        "/repo/src/b.ts",
        { loc: 5, parsed: { functions: [], classes: [], imports: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const importEdges = graph.edges.filter((e) => e.type === "IMPORTS");
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0].from).toBe("file:src/a.ts");
    expect(importEdges[0].to).toBe("file:src/b.ts");
  });

  it("deduplicates IMPORTS edges when a file imports the same target via multiple import statements", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/src/a.ts",
        {
          loc: 10,
          parsed: {
            functions: [],
            classes: [],
            // e.g. a value import and a separate type-only import from the same file
            imports: ["./b", "./b"],
          },
        },
      ],
      [
        "/repo/src/b.ts",
        { loc: 5, parsed: { functions: [], classes: [], imports: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const importEdges = graph.edges.filter((e) => e.type === "IMPORTS");
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0].from).toBe("file:src/a.ts");
    expect(importEdges[0].to).toBe("file:src/b.ts");
  });

  it("emits a TESTED_BY edge from a source file to its same-directory .test.ts file", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/src/metrics.ts",
        { loc: 20, parsed: { functions: [], classes: [], imports: [] } },
      ],
      [
        "/repo/src/metrics.test.ts",
        { loc: 15, parsed: { functions: [], classes: [], imports: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const testedByEdges = graph.edges.filter((e) => e.type === "TESTED_BY");
    expect(testedByEdges).toHaveLength(1);
    expect(testedByEdges[0].from).toBe("file:src/metrics.ts");
    expect(testedByEdges[0].to).toBe("file:src/metrics.test.ts");
  });

  it("emits a TESTED_BY edge for .spec. files too, and does not emit one when no test file exists", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/src/walker.ts",
        { loc: 20, parsed: { functions: [], classes: [], imports: [] } },
      ],
      [
        "/repo/src/walker.spec.ts",
        { loc: 15, parsed: { functions: [], classes: [], imports: [] } },
      ],
      [
        "/repo/src/orphan.ts",
        { loc: 5, parsed: { functions: [], classes: [], imports: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const testedByEdges = graph.edges.filter((e) => e.type === "TESTED_BY");
    expect(testedByEdges).toHaveLength(1);
    expect(testedByEdges[0].from).toBe("file:src/walker.ts");
    expect(testedByEdges[0].to).toBe("file:src/walker.spec.ts");

    const orphanHasTest = testedByEdges.some((e) => e.from === "file:src/orphan.ts");
    expect(orphanHasTest).toBe(false);
  });

  // Regression coverage for a false-negative found reviewing a real external
  // repo: portfolioRules.ts was tested (agents/__tests__/portfolioRules.test.ts)
  // but got reported as having no tests, because TESTED_BY only matched a test
  // file in the exact same directory as its source file. The Jest/RTL
  // convention of a sibling __tests__/ directory one level down was silently
  // never matched, making the grounded "hasTests: false" claim confidently wrong.
  it("emits a TESTED_BY edge when the test file lives in a sibling __tests__/ directory", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/src/lib/agents/portfolioRules.ts",
        { loc: 20, parsed: { functions: [], classes: [], imports: [] } },
      ],
      [
        "/repo/src/lib/agents/__tests__/portfolioRules.test.ts",
        { loc: 15, parsed: { functions: [], classes: [], imports: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const testedByEdges = graph.edges.filter((e) => e.type === "TESTED_BY");
    expect(testedByEdges).toHaveLength(1);
    expect(testedByEdges[0].from).toBe("file:src/lib/agents/portfolioRules.ts");
    expect(testedByEdges[0].to).toBe("file:src/lib/agents/__tests__/portfolioRules.test.ts");
  });

  it("resolves a tsconfig-style path alias (e.g. @/*) when alias rules are provided", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/app/page.tsx",
        { loc: 10, parsed: { functions: [], classes: [], imports: ["@/components/Foo"] } },
      ],
      [
        "/repo/components/Foo.tsx",
        { loc: 5, parsed: { functions: [], classes: [], imports: [] } },
      ],
    ]);

    const aliases: PathAliasRule[] = [
      { prefix: "@/", suffix: "", hasWildcard: true, targets: [path.join("/repo", "*")] },
    ];

    const graph = buildGraph(parsedByFile, "/repo", aliases);

    const importEdges = graph.edges.filter((e) => e.type === "IMPORTS");
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0].from).toBe("file:app/page.tsx");
    expect(importEdges[0].to).toBe("file:components/Foo.tsx");
  });

  it("leaves a non-relative import unresolved when no alias rules are provided (default behavior unchanged)", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/app/page.tsx",
        { loc: 10, parsed: { functions: [], classes: [], imports: ["@/components/Foo"] } },
      ],
      [
        "/repo/components/Foo.tsx",
        { loc: 5, parsed: { functions: [], classes: [], imports: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const importEdges = graph.edges.filter((e) => e.type === "IMPORTS");
    expect(importEdges).toHaveLength(0);
  });

  // Regression coverage for a false-negative found via Archie's own
  // self-analysis: parser.ts pushes Python absolute imports (`import foo.bar`)
  // as the raw dotted name with no path conversion, so this edge was always
  // silently dropped, quietly undercounting fan-in for every locally-imported
  // Python module -- exactly the same class of bug as the __tests__/
  // directory case, just for a different import style.
  it("resolves a Python absolute import (e.g. `import foo.bar`) to the corresponding local file", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/main.py",
        { loc: 10, parsed: { functions: [], classes: [], imports: ["foo.bar"] } },
      ],
      [
        "/repo/foo/bar.py",
        { loc: 5, parsed: { functions: [], classes: [], imports: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const importEdges = graph.edges.filter((e) => e.type === "IMPORTS");
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0].from).toBe("file:main.py");
    expect(importEdges[0].to).toBe("file:foo/bar.py");
  });

  it("leaves a Python absolute import unresolved when it refers to a genuine third-party package", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/main.py",
        { loc: 10, parsed: { functions: [], classes: [], imports: ["requests"] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const importEdges = graph.edges.filter((e) => e.type === "IMPORTS");
    expect(importEdges).toHaveLength(0);
  });
});

describe("loadPathAliases", () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "archie-alias-test-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("returns an empty array when no tsconfig.json or jsconfig.json exists", async () => {
    await withTempDir(async (dir) => {
      const aliases = await loadPathAliases(dir);
      expect(aliases).toEqual([]);
    });
  });

  it("parses a wildcard paths mapping from tsconfig.json", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        path.join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } },
        }),
        "utf8"
      );

      const aliases = await loadPathAliases(dir);
      expect(aliases).toHaveLength(1);
      expect(aliases[0].prefix).toBe("@/");
      expect(aliases[0].hasWildcard).toBe(true);
      expect(aliases[0].targets).toEqual([path.resolve(dir, "./src/*")]);
    });
  });

  it("tolerates JSONC comments and a trailing comma", async () => {
    await withTempDir(async (dir) => {
      const jsonc = `{
        // path aliases
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@/*": ["./src/*"], /* trailing comma above */
          },
        },
      }`;
      await writeFile(path.join(dir, "tsconfig.json"), jsonc, "utf8");

      const aliases = await loadPathAliases(dir);
      expect(aliases).toHaveLength(1);
      expect(aliases[0].prefix).toBe("@/");
    });
  });

  it("falls back to jsconfig.json when tsconfig.json is absent", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        path.join(dir, "jsconfig.json"),
        JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
        "utf8"
      );

      const aliases = await loadPathAliases(dir);
      expect(aliases).toHaveLength(1);
    });
  });
});
