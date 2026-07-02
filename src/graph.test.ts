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
            functions: [{ name: "doWork", startLine: 1, endLine: 3 }],
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
