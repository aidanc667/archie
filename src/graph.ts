// src/graph.ts
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { CodeGraph, GraphNode, Edge, FileNode } from "./types.js";
import type { ParsedFile } from "./parser.js";

export interface FileEntry {
  loc: number;
  parsed: ParsedFile;
}

// A single tsconfig/jsconfig "paths" mapping entry, pre-split around its `*`
// wildcard (if any) so lookups at resolve time are a cheap prefix/suffix check.
export interface PathAliasRule {
  prefix: string;
  suffix: string;
  hasWildcard: boolean;
  // Absolute path templates (still containing a literal `*` for wildcard
  // rules) to try in order, mirroring how TypeScript tries each target.
  targets: string[];
}

// Strips `//` and `/* */` comments from JSONC while tracking whether the
// scanner is inside a string literal, so comment-marker-like substrings
// inside string values (e.g. the `/*` inside a completely ordinary tsconfig
// glob like `"./src/*"`) are left alone. A plain regex-based stripper gets
// this wrong — it will happily "close" that fake comment at the next real
// `*/` in the file, eating everything in between.
function stripJsoncComments(raw: string): string {
  let result = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      result += ch;
      if (ch === "\\" && i + 1 < raw.length) {
        result += raw[i + 1];
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1;
      i -= 1; // let the loop's i++ land back on the newline
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
      i += 1; // land on the closing '/', loop's i++ moves past it
      continue;
    }
    result += ch;
  }
  return result;
}

// tsconfig.json/jsconfig.json commonly contain comments and trailing commas,
// which JSON.parse rejects. This is a best-effort JSONC-tolerant parse, not a
// full parser — it does not handle `extends` chains. If parsing still fails,
// callers treat that the same as "no config present."
function parseJsonc(raw: string): unknown {
  const withoutComments = stripJsoncComments(raw);
  const withoutTrailingCommas = stripTrailingCommas(withoutComments);
  return JSON.parse(withoutTrailingCommas);
}

// Removes trailing commas (`,` before a closing `}`/`]`) that JSON.parse
// rejects. Like stripJsoncComments, this tracks whether the scanner is inside
// a string literal — with identical escape-aware logic — so a comma that lives
// inside a string value (e.g. a path glob like `"./src/a,}b/*"`) is emitted
// verbatim rather than being mistaken for a trailing comma and eaten. A plain
// regex gets this wrong: it has no notion of string boundaries.
function stripTrailingCommas(input: string): string {
  let result = "";
  let inString = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      result += ch;
      if (ch === "\\" && i + 1 < input.length) {
        result += input[i + 1];
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === ",") {
      // Look past any whitespace: if the next non-whitespace char closes an
      // object/array, this is a trailing comma — drop it and emit the
      // whitespace + bracket. Otherwise emit the comma as usual.
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j += 1;
      if (j < input.length && (input[j] === "}" || input[j] === "]")) {
        result += input.slice(i + 1, j + 1);
        i = j;
        continue;
      }
    }
    result += ch;
  }
  return result;
}

// Reads `tsconfig.json` (falling back to `jsconfig.json`) from the repo root
// and extracts `compilerOptions.paths` as resolvable alias rules, so imports
// like `@/components/Foo` can be matched to a real file instead of being
// silently dropped. Resolves quietly to `[]` on any missing/unparseable
// config, matching the fail-open convention used by `cache.ts`'s `loadCache`
// and `walker.ts`'s `loadIgnore`. Does not follow `tsconfig.json`'s `extends`
// field — a monorepo whose path aliases live only in a base config it
// extends will not have those aliases picked up (a known, documented gap,
// not a silent one).
export async function loadPathAliases(root: string): Promise<PathAliasRule[]> {
  for (const configName of ["tsconfig.json", "jsconfig.json"]) {
    let raw: string;
    try {
      raw = await readFile(path.join(root, configName), "utf8");
    } catch {
      continue;
    }

    try {
      const parsed = parseJsonc(raw) as {
        compilerOptions?: { paths?: Record<string, unknown>; baseUrl?: string };
      };
      const paths = parsed.compilerOptions?.paths;
      if (!paths || typeof paths !== "object") return [];

      const baseUrl = parsed.compilerOptions?.baseUrl ?? ".";
      const baseDir = path.resolve(root, baseUrl);
      const rules: PathAliasRule[] = [];

      for (const [pattern, targets] of Object.entries(paths)) {
        if (!Array.isArray(targets)) continue;
        const starIndex = pattern.indexOf("*");
        const hasWildcard = starIndex !== -1;
        const prefix = hasWildcard ? pattern.slice(0, starIndex) : pattern;
        const suffix = hasWildcard ? pattern.slice(starIndex + 1) : "";
        const resolvedTargets = targets
          .filter((t): t is string => typeof t === "string")
          .map((t) => path.resolve(baseDir, t));
        if (resolvedTargets.length > 0) {
          rules.push({ prefix, suffix, hasWildcard, targets: resolvedTargets });
        }
      }
      return rules;
    } catch {
      return [];
    }
  }
  return [];
}

function resolveImport(
  fromFile: string,
  importSpecifier: string,
  fileIdByAbsPath: Map<string, string>,
  root: string,
  isPython: boolean,
  aliases: PathAliasRule[] = []
): string | undefined {
  const knownExtensions = [".ts", ".tsx", ".js", ".jsx", ".py"];
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".py"];

  const resolveCandidates = (resolvedBase: string): string | undefined => {
    const matchedExtension = knownExtensions.find((ext) => resolvedBase.endsWith(ext));
    const candidateBase = matchedExtension
      ? resolvedBase.slice(0, -matchedExtension.length)
      : resolvedBase;
    for (const ext of extensions) {
      const candidate = candidateBase + ext;
      if (fileIdByAbsPath.has(candidate)) {
        return fileIdByAbsPath.get(candidate);
      }
    }
    return undefined;
  };

  if (importSpecifier.startsWith(".")) {
    const baseDir = path.dirname(fromFile);
    return resolveCandidates(path.resolve(baseDir, importSpecifier));
  }

  // Python absolute imports (e.g. `import foo.bar`) are rooted at the repo
  // root, not the importing file's directory -- parser.ts pushes these as
  // the raw dotted name ("foo.bar") with no path conversion, so without this
  // they never match a real file and the edge is silently dropped, quietly
  // undercounting fan-in for every locally-imported Python module. A genuine
  // third-party package (e.g. `import requests`) simply won't match any
  // known file here and falls through with no edge created, same as today.
  if (isPython) {
    const asRelativePath = importSpecifier.replace(/\./g, "/");
    const found = resolveCandidates(path.resolve(root, asRelativePath));
    if (found) return found;
  }

  // Non-relative specifier: try tsconfig/jsconfig "paths" aliases (e.g. `@/*`)
  // before giving up. Without this, every alias-based import — the norm in
  // most modern Next.js/Vite/monorepo codebases — is invisible to the graph,
  // which silently undercounts fanIn for exactly the files most likely to be
  // architecturally central.
  for (const rule of aliases) {
    let wildcardMatch: string | undefined;
    if (rule.hasWildcard) {
      if (
        importSpecifier.startsWith(rule.prefix) &&
        importSpecifier.endsWith(rule.suffix) &&
        importSpecifier.length >= rule.prefix.length + rule.suffix.length
      ) {
        wildcardMatch = importSpecifier.slice(
          rule.prefix.length,
          importSpecifier.length - rule.suffix.length
        );
      }
    } else if (importSpecifier === rule.prefix) {
      wildcardMatch = "";
    }
    if (wildcardMatch === undefined) continue;

    for (const target of rule.targets) {
      const resolvedBase = target.includes("*")
        ? target.replace("*", wildcardMatch)
        : target;
      const found = resolveCandidates(resolvedBase);
      if (found) return found;
    }
  }

  return undefined;
}

const TEST_SUFFIX_RE = /(\.(test|spec)\.(ts|tsx|js|jsx)$)|((_test|\.test)\.py$)/;

const PY_TEST_PREFIX_RE = /^test_(.+)\.py$/;

// Jest/RTL convention: tests live one directory below their source file, in
// a sibling `__tests__/` directory (e.g. `agents/foo.ts` tested by
// `agents/__tests__/foo.test.ts`), rather than next to it. Without stripping
// this segment, testTargetKey and sourceKey never produce the same key for
// this layout and `hasTests` is silently wrong for every file that uses it.
function stripTestDirSegment(dir: string): string {
  const segments = dir.split(path.sep);
  if (segments[segments.length - 1] === "__tests__") {
    return segments.slice(0, -1).join(path.sep) || ".";
  }
  return dir;
}

function testTargetKey(relPath: string): string {
  const dir = stripTestDirSegment(path.dirname(relPath));
  const basename = path.basename(relPath);
  const prefixMatch = PY_TEST_PREFIX_RE.exec(basename);
  if (prefixMatch) {
    return path.join(dir, prefixMatch[1]);
  }
  const base = basename.replace(TEST_SUFFIX_RE, "");
  return path.join(dir, base);
}

function sourceKey(relPath: string): string {
  const dir = path.dirname(relPath);
  const ext = path.extname(relPath);
  const base = path.basename(relPath, ext);
  return path.join(dir, base);
}

export function buildGraph(
  parsedByFile: Map<string, FileEntry>,
  root: string,
  aliases: PathAliasRule[] = []
): CodeGraph {
  const nodes: GraphNode[] = [];
  const edges: Edge[] = [];
  const fileIdByAbsPath = new Map<string, string>();

  // Pass 1: create FileNodes
  for (const absPath of parsedByFile.keys()) {
    const id = `file:${path.relative(root, absPath)}`;
    fileIdByAbsPath.set(absPath, id);
  }

  // Pass 2: create FileNodes, function/class nodes, CONTAINS edges
  for (const [absPath, entry] of parsedByFile) {
    const fileId = fileIdByAbsPath.get(absPath)!;
    const relPath = path.relative(root, absPath);

    const fileNode: FileNode = { kind: "file", id: fileId, path: relPath, loc: entry.loc };
    nodes.push(fileNode);

    for (const fn of entry.parsed.functions) {
      const fnId = `function:${relPath}:${fn.name}:${fn.startLine}`;
      nodes.push({
        kind: "function",
        id: fnId,
        name: fn.name,
        fileId,
        startLine: fn.startLine,
        endLine: fn.endLine,
      });
      edges.push({ type: "CONTAINS", from: fileId, to: fnId, confidence: 1.0 });
      // Distinct from CONTAINS: this is what lets a consumer ask "is this
      // function actually part of the file's public API" as a checked graph
      // fact, rather than the report-generation LLM having to guess from raw
      // source text -- which, on a real report, led to four private helper
      // functions being named as exported and a refactor step being aimed at
      // them directly instead of their actual (exported) call site.
      if (fn.isExported) {
        edges.push({ type: "EXPORTS", from: fileId, to: fnId, confidence: 1.0 });
      }
    }

    for (const cls of entry.parsed.classes) {
      const clsId = `class:${relPath}:${cls.name}:${cls.startLine}`;
      nodes.push({
        kind: "class",
        id: clsId,
        name: cls.name,
        fileId,
        startLine: cls.startLine,
        endLine: cls.endLine,
      });
      edges.push({ type: "CONTAINS", from: fileId, to: clsId, confidence: 1.0 });
      if (cls.isExported) {
        edges.push({ type: "EXPORTS", from: fileId, to: clsId, confidence: 1.0 });
      }
    }
  }

  // Pass 3: resolve IMPORTS edges, deduplicated per (from, to) pair —
  // a file can have multiple import statements (e.g. a value import and a
  // separate type-only import) targeting the same file, which should still
  // count as a single dependency edge, not inflate fan-in.
  for (const [absPath, entry] of parsedByFile) {
    const fileId = fileIdByAbsPath.get(absPath)!;
    const isPython = path.extname(absPath) === ".py";
    const resolvedTargets = new Set<string>();
    for (const importSpecifier of entry.parsed.imports) {
      const targetId = resolveImport(absPath, importSpecifier, fileIdByAbsPath, root, isPython, aliases);
      if (targetId) {
        resolvedTargets.add(targetId);
      }
    }
    for (const targetId of resolvedTargets) {
      edges.push({ type: "IMPORTS", from: fileId, to: targetId, confidence: 1.0 });
    }
  }

  // Pass 4: TESTED_BY edges — link each non-test source file to a same-directory
  // test file matching the `<name>.test.<ext>` / `<name>.spec.<ext>` convention.
  // This makes "has tests" a checkable graph fact instead of something the LLM
  // has to infer from the file's absence in the context pack.
  const testFileIdByKey = new Map<string, string>();
  for (const absPath of parsedByFile.keys()) {
    const relPath = path.relative(root, absPath);
    if (TEST_SUFFIX_RE.test(relPath)) {
      testFileIdByKey.set(testTargetKey(relPath), fileIdByAbsPath.get(absPath)!);
    }
  }
  for (const absPath of parsedByFile.keys()) {
    const relPath = path.relative(root, absPath);
    if (TEST_SUFFIX_RE.test(relPath)) continue;
    const testFileId = testFileIdByKey.get(sourceKey(relPath));
    if (testFileId) {
      edges.push({ type: "TESTED_BY", from: fileIdByAbsPath.get(absPath)!, to: testFileId, confidence: 1.0 });
    }
  }

  return { nodes, edges };
}
