// src/parser.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
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
});
