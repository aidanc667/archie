// src/graph.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildGraph, loadPathAliases, loadGoModuleName, type PathAliasRule } from "./graph.js";
import type { ParsedFile } from "./parser.js";

describe("buildGraph", () => {
  it("builds FileNodes, CONTAINS edges, and resolves relative IMPORTS edges", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/src/a.ts",
        {
          loc: 10,
          parsed: {
            functions: [{ name: "doWork", startLine: 1, endLine: 3, isExported: true, bodyHash: "abc123" }],
            classes: [],
            imports: ["./b"],
            magicNumbers: [],
          },
        },
      ],
      [
        "/repo/src/b.ts",
        { loc: 5, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
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

  // bodyHash is purely additive to ParsedFunction/FunctionNode -- buildGraph
  // must copy it through to the graph's function node alongside the existing
  // startLine/endLine/name fields, or every downstream duplicate-detection
  // consumer of the graph would silently lose it despite parser.ts computing
  // it correctly.
  it("copies bodyHash from ParsedFunction through to the function node", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/src/a.ts",
        {
          loc: 10,
          parsed: {
            functions: [
              { name: "doWork", startLine: 1, endLine: 3, isExported: true, bodyHash: "deadbeef" },
            ],
            classes: [],
            imports: [],
            magicNumbers: [],
          },
        },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const functionNode = graph.nodes.find((n) => n.kind === "function");
    expect(functionNode && "bodyHash" in functionNode ? functionNode.bodyHash : undefined).toBe(
      "deadbeef"
    );
  });

  // magicNumbers is purely additive to ParsedFile/FileNode, mirroring bodyHash
  // above -- buildGraph must copy it through to the graph's FileNode, or every
  // downstream magic-number-surfacing consumer would silently lose it despite
  // parser.ts computing it correctly.
  it("copies magicNumbers from ParsedFile through to the resulting FileNode", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/src/a.ts",
        {
          loc: 10,
          parsed: {
            functions: [],
            classes: [],
            imports: [],
            magicNumbers: [{ value: "42", line: 3 }, { value: "9000", line: 7 }],
          },
        },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const fileNode = graph.nodes.find((n) => n.kind === "file");
    expect(fileNode && "magicNumbers" in fileNode ? fileNode.magicNumbers : undefined).toEqual([
      { value: "42", line: 3 },
      { value: "9000", line: 7 },
    ]);
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
              { name: "publicFn", startLine: 1, endLine: 3, isExported: true, bodyHash: "h1" },
              { name: "privateFn", startLine: 5, endLine: 7, isExported: false, bodyHash: "h2" },
            ],
            classes: [
              { name: "PublicClass", startLine: 9, endLine: 12, isExported: true },
              { name: "PrivateClass", startLine: 14, endLine: 16, isExported: false },
            ],
            imports: [], magicNumbers: []
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
            imports: ["./b.js"], magicNumbers: []
          },
        },
      ],
      [
        "/repo/src/b.ts",
        { loc: 5, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
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
            imports: ["./b", "./b"], magicNumbers: []
          },
        },
      ],
      [
        "/repo/src/b.ts",
        { loc: 5, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
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
        { loc: 20, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
      ],
      [
        "/repo/src/metrics.test.ts",
        { loc: 15, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
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
        { loc: 20, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
      ],
      [
        "/repo/src/walker.spec.ts",
        { loc: 15, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
      ],
      [
        "/repo/src/orphan.ts",
        { loc: 5, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
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
        { loc: 20, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
      ],
      [
        "/repo/src/lib/agents/__tests__/portfolioRules.test.ts",
        { loc: 15, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
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
        { loc: 10, parsed: { functions: [], classes: [], imports: ["@/components/Foo"], magicNumbers: [] } },
      ],
      [
        "/repo/components/Foo.tsx",
        { loc: 5, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
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
        { loc: 10, parsed: { functions: [], classes: [], imports: ["@/components/Foo"], magicNumbers: [] } },
      ],
      [
        "/repo/components/Foo.tsx",
        { loc: 5, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
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
        { loc: 10, parsed: { functions: [], classes: [], imports: ["foo.bar"], magicNumbers: [] } },
      ],
      [
        "/repo/foo/bar.py",
        { loc: 5, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
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
        { loc: 10, parsed: { functions: [], classes: [], imports: ["requests"], magicNumbers: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const importEdges = graph.edges.filter((e) => e.type === "IMPORTS");
    expect(importEdges).toHaveLength(0);
  });

  // Regression coverage for adding Go support: Go import specifiers are
  // rooted at the module's declared go.mod path, not a relative path and not
  // Python's dotted-module convention. "github.com/acme/widget/helper"
  // (module "github.com/acme/widget" + package dir "helper") should resolve
  // to helper/helper.go (v1's documented same-named-file convention), while
  // the stdlib "fmt" import should produce no edge at all.
  it("resolves a Go import specifier against the go.mod module path to the corresponding package file", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/widget.go",
        {
          loc: 20,
          parsed: {
            functions: [],
            classes: [],
            imports: ["fmt", "github.com/acme/widget/helper"], magicNumbers: []
          },
        },
      ],
      [
        "/repo/helper/helper.go",
        { loc: 5, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo", [], "github.com/acme/widget");

    const importEdges = graph.edges.filter((e) => e.type === "IMPORTS");
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0].from).toBe("file:widget.go");
    expect(importEdges[0].to).toBe("file:helper/helper.go");
  });

  it("leaves a Go import unresolved when no go.mod module name is provided (default behavior unchanged)", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/widget.go",
        {
          loc: 20,
          parsed: { functions: [], classes: [], imports: ["github.com/acme/widget/helper"], magicNumbers: [] },
        },
      ],
      [
        "/repo/helper/helper.go",
        { loc: 5, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const importEdges = graph.edges.filter((e) => e.type === "IMPORTS");
    expect(importEdges).toHaveLength(0);
  });

  // Regression coverage for adding Go support: Go's test convention is
  // `<name>_test.go` co-located in the same directory, unlike `.test.ts`/
  // `.spec.ts` or Python's `test_*.py`/`*_test.py`. Without extending
  // TEST_SUFFIX_RE, widget_test.go would never link back to widget.go and
  // "has tests" would be silently wrong for every Go file that has one.
  it("emits a TESTED_BY edge from a Go source file to its co-located _test.go file", () => {
    const parsedByFile = new Map<string, { loc: number; parsed: ParsedFile }>([
      [
        "/repo/widget.go",
        { loc: 20, parsed: { functions: [], classes: [], imports: [], magicNumbers: [] } },
      ],
      [
        "/repo/widget_test.go",
        { loc: 10, parsed: { functions: [], classes: [], imports: ["testing"], magicNumbers: [] } },
      ],
    ]);

    const graph = buildGraph(parsedByFile, "/repo");

    const testedByEdges = graph.edges.filter((e) => e.type === "TESTED_BY");
    expect(testedByEdges).toHaveLength(1);
    expect(testedByEdges[0].from).toBe("file:widget.go");
    expect(testedByEdges[0].to).toBe("file:widget_test.go");
  });
});

describe("loadGoModuleName", () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "archie-gomod-test-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("extracts the module path from a go.mod module directive", async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        path.join(dir, "go.mod"),
        "module github.com/acme/widget\n\ngo 1.22\n",
        "utf8"
      );

      const moduleName = await loadGoModuleName(dir);
      expect(moduleName).toBe("github.com/acme/widget");
    });
  });

  it("returns undefined when no go.mod is present, matching the fail-open convention of loadPathAliases", async () => {
    await withTempDir(async (dir) => {
      const moduleName = await loadGoModuleName(dir);
      expect(moduleName).toBeUndefined();
    });
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

  // Regression coverage for a string-literal-blind trailing-comma stripper:
  // the old `replace(/,(\s*[}\]])/g, "$1")` had no awareness of string
  // boundaries, so a perfectly valid path target that happened to contain a
  // literal `,}` or `,]` substring (e.g. a glob with an unusual directory
  // name) had its comma silently eaten, resolving imports to the wrong file.
  it("does not strip a comma that lives inside a path string value", async () => {
    await withTempDir(async (dir) => {
      const jsonc = `{
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@/*": ["./src/a,}b/*"],
          },
        },
      }`;
      await writeFile(path.join(dir, "tsconfig.json"), jsonc, "utf8");

      const aliases = await loadPathAliases(dir);
      expect(aliases).toHaveLength(1);
      expect(aliases[0].targets).toEqual([path.resolve(dir, "./src/a,}b/*")]);
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
