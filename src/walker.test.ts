// src/walker.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { walkRepo } from "./walker.js";

describe("walkRepo", () => {
  it("finds .ts and .js files, excludes node_modules and .gitignore entries", async () => {
    const root = path.resolve("fixtures/walker-basic");
    const files = await walkRepo(root);
    const relative = files.map((f) => path.relative(root, f)).sort();

    expect(relative).toEqual(["src/a.ts", "src/b.js"]);
  });

  it("terminates instead of infinitely recursing through a symlink cycle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archie-walker-cycle-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;");
      // Create a symlink inside src/ that points back to root, forming a cycle.
      await symlink(root, path.join(root, "src", "loop"), "dir");

      const files = await walkRepo(root);
      const relative = files.map((f) => path.relative(root, f)).sort();

      expect(relative).toEqual(["src/a.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
