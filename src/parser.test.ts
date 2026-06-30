// src/parser.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { parseFile } from "./parser.js";

describe("parseFile", () => {
  it("extracts functions, classes, and imports", async () => {
    const filePath = path.resolve("fixtures/parser-basic/sample.ts");
    const result = await parseFile(filePath);

    expect(result.functions.map((f) => f.name)).toEqual(["doWork"]);
    expect(result.classes.map((c) => c.name)).toEqual(["Worker"]);
    expect(result.imports).toEqual(["./helper"]);
  });
});
