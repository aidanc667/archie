// src/parser.test.ts
import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { parseFile, computeComplexity } from "./parser.js";

describe("parseFile", () => {
  it("extracts functions, classes, and imports", async () => {
    const filePath = path.resolve("fixtures/parser-basic/sample.ts");
    const result = await parseFile(filePath);

    expect(result.functions.map((f) => f.name)).toEqual(["doWork", "run"]);
    expect(result.classes.map((c) => c.name)).toEqual(["Worker"]);
    expect(result.imports).toEqual(["./helper"]);
  });

  // Regression coverage for the tree-sitter-python grammar: the package was
  // previously pinned to a version whose prebuilt .wasm was compiled at
  // language ABI 15, which web-tree-sitter (ABI 13-14) cannot load at all --
  // every .py file failed with "Incompatible language version 15" before a
  // single line of Python was ever parsed. No test caught it because there
  // was no Python coverage at all. This exercises both loading AND
  // extraction correctness, not just that the grammar loads without error.
  it("extracts functions, classes, and imports from a Python file", async () => {
    const filePath = path.resolve("fixtures/parser-basic/sample.py");
    const result = await parseFile(filePath);

    expect(result.functions.map((f) => f.name)).toEqual(["do_work", "run"]);
    expect(result.classes.map((c) => c.name)).toEqual(["Worker"]);
    expect(result.imports).toEqual(["./helper", "os"]);
  });

  // Regression coverage for a bug found running archie from a GitHub Action
  // step in a repo other than archie's own: grammarsDir was resolved via
  // path.resolve("grammars"), which resolves against process.cwd(). When
  // archie is invoked as `node archie-tool/dist/cli.js analyze .` from a
  // DIFFERENT repo's checkout root, cwd is that other repo's root, which has
  // no grammars/ directory at all -- ENOENT before a single file gets parsed,
  // regardless of how correct everything else in the pipeline is. Uses
  // vi.resetModules() to get a fresh, un-initialized parser module instance,
  // since ensureInitialized() memoizes after its first successful call and
  // would otherwise skip re-resolving the grammar path entirely.
  it("resolves grammar files relative to its own module location, not process.cwd()", async () => {
    const originalCwd = process.cwd();
    const absoluteFixturePath = path.resolve("fixtures/parser-basic/sample.ts");
    try {
      vi.resetModules();
      const freshParser = await import("./parser.js");
      process.chdir(os.tmpdir());
      const result = await freshParser.parseFile(absoluteFixturePath);
      expect(result.functions.map((f) => f.name)).toEqual(["doWork", "run"]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  // Regression coverage found via Archie's own self-analysis: ensureInitialized
  // used a bare `initialized` boolean with no single-flight guard, so
  // concurrent callers could all observe `initialized === false` before any
  // of them finished loading the grammars, each redundantly re-running
  // initialization and racing to reassign the shared language variables. Uses
  // a fresh, un-initialized module (vi.resetModules()) so the very first
  // calls genuinely race through initialization concurrently, across all
  // three languages, rather than hitting an already-memoized fast path.
  it("returns correct results for all three languages when parsed concurrently on first use", async () => {
    vi.resetModules();
    const freshParser = await import("./parser.js");

    const tsPath = path.resolve("fixtures/parser-basic/sample.ts");
    const pyPath = path.resolve("fixtures/parser-basic/sample.py");
    const branchyPath = path.resolve("fixtures/parser-basic/branchy.ts");

    const [tsResult, pyResult, branchyComplexity] = await Promise.all([
      freshParser.parseFile(tsPath),
      freshParser.parseFile(pyPath),
      freshParser.computeComplexity(branchyPath),
    ]);

    expect(tsResult.functions.map((f) => f.name)).toEqual(["doWork", "run"]);
    expect(pyResult.functions.map((f) => f.name)).toEqual(["do_work", "run"]);
    expect(branchyComplexity).toBe(5);
  });

  // Regression coverage found via Archie's own self-analysis: parseFile had
  // no error handling, so one unreadable/unparseable file in the target repo
  // (a vendored .min.js, a generated file, a symlink resolving to nothing)
  // would abort analysis of the entire repo with a raw, uncaught exception --
  // even though every other file was perfectly parseable.
  it("does not throw when a file cannot be read, returning an empty result instead", async () => {
    const nonexistentPath = path.resolve("fixtures/parser-basic/does-not-exist.ts");
    const result = await parseFile(nonexistentPath);
    expect(result).toEqual({ functions: [], classes: [], imports: [] });
  });
});

describe("computeComplexity", () => {
  it("counts branches, loops, and conditionals", async () => {
    const filePath = path.resolve("fixtures/parser-basic/branchy.ts");
    const complexity = await computeComplexity(filePath);
    expect(complexity).toBe(5);
  });

  it("counts && and || operators", async () => {
    const filePath = path.resolve("fixtures/parser-basic/logical.ts");
    const complexity = await computeComplexity(filePath);
    expect(complexity).toBe(3);
  });

  it("does not throw when a file cannot be read, returning base complexity instead", async () => {
    const nonexistentPath = path.resolve("fixtures/parser-basic/does-not-exist.ts");
    const complexity = await computeComplexity(nonexistentPath);
    expect(complexity).toBe(1);
  });
});
