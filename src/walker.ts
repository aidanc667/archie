// src/walker.ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ignorePkg from "ignore";
import type { Ignore } from "ignore";

const ignore = ignorePkg as unknown as (options?: unknown) => Ignore;

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go"]);
const ALWAYS_EXCLUDED = new Set(["node_modules", ".git"]);

// Archie's own declared package name. A CI workflow that checks out a target
// repo to the working directory root and then clones Archie itself into a
// subdirectory (e.g. `archie-tool/`) before running `analyze .` causes
// Archie to walk into its own freshly-cloned source and analyze it as if it
// were part of the target repo -- inflating file/LOC counts and attributing
// Archie's own test coverage and risk findings to the target codebase. This
// only excludes NESTED occurrences found while walking; the root directory
// itself is never checked, so intentional self-analysis (`analyze .` run
// directly against Archie's own repo) is unaffected.
const ARCHIE_OWN_PACKAGE_NAME = "archie";

async function isArchieOwnCheckout(dir: string): Promise<boolean> {
  try {
    const content = await readFile(path.join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(content) as { name?: unknown };
    return pkg.name === ARCHIE_OWN_PACKAGE_NAME;
  } catch {
    return false;
  }
}

async function loadIgnore(root: string): Promise<Ignore> {
  const ig = ignore();
  try {
    const content = await readFile(path.join(root, ".gitignore"), "utf8");
    ig.add(content);
  } catch {
    // no .gitignore present — nothing to add
  }
  return ig;
}

export async function walkRepo(root: string): Promise<string[]> {
  const ig = await loadIgnore(root);
  const results: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath);

      if (entry.isDirectory()) {
        if (ALWAYS_EXCLUDED.has(entry.name)) continue;
        if (ig.ignores(relPath)) continue;
        if (await isArchieOwnCheckout(fullPath)) continue;
        await visit(fullPath);
      } else if (entry.isFile()) {
        if (ig.ignores(relPath)) continue;
        if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
          results.push(fullPath);
        }
      }
    }
  }

  await visit(root);
  return results;
}
