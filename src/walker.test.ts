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

  // Regression coverage for a bug found reviewing a real PR run: a CI
  // workflow that checks out the target repo to the working directory root
  // and then clones Archie itself into a subdirectory (e.g. `archie-tool/`)
  // before running `analyze .` was silently walking into Archie's own
  // freshly-cloned source and analyzing it as part of the target repo --
  // inflating file counts and attributing Archie's own test coverage and
  // risk findings to the target codebase. Detected via a nested package.json
  // declaring Archie's own package name.
  it("excludes a nested checkout of Archie's own source (e.g. archie-tool/), but still includes the real target files", async () => {
    const root = path.resolve("fixtures/walker-archie-nested");
    const files = await walkRepo(root);
    const relative = files.map((f) => path.relative(root, f)).sort();

    expect(relative).toEqual(["target.ts"]);
    expect(relative).not.toContain(path.join("archie-tool", "src", "graph.ts"));
  });

  it("does not exclude the root itself, even if the root's own package.json is named archie (intentional self-analysis)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archie-walker-self-"));
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "archie" }));
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;");

      const files = await walkRepo(root);
      const relative = files.map((f) => path.relative(root, f)).sort();

      expect(relative).toEqual(["src/a.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
