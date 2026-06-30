// src/graph.ts
import path from "node:path";
import type { CodeGraph, GraphNode, Edge, FileNode } from "./types.js";
import type { ParsedFile } from "./parser.js";

export interface FileEntry {
  loc: number;
  parsed: ParsedFile;
}

function resolveImport(
  fromFile: string,
  importSpecifier: string,
  fileIdByAbsPath: Map<string, string>
): string | undefined {
  if (!importSpecifier.startsWith(".")) return undefined;

  const baseDir = path.dirname(fromFile);
  const resolved = path.resolve(baseDir, importSpecifier);
  const knownExtensions = [".ts", ".tsx", ".js", ".jsx"];
  const matchedExtension = knownExtensions.find((ext) => resolved.endsWith(ext));
  const candidateBase = matchedExtension
    ? resolved.slice(0, -matchedExtension.length)
    : resolved;
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx"];

  for (const ext of extensions) {
    const candidate = candidateBase + ext;
    if (fileIdByAbsPath.has(candidate)) {
      return fileIdByAbsPath.get(candidate);
    }
  }
  return undefined;
}

const TEST_SUFFIX_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/;

function testTargetKey(relPath: string): string {
  const dir = path.dirname(relPath);
  const base = path.basename(relPath).replace(TEST_SUFFIX_RE, "");
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
  root: string
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
    }
  }

  // Pass 3: resolve IMPORTS edges, deduplicated per (from, to) pair —
  // a file can have multiple import statements (e.g. a value import and a
  // separate type-only import) targeting the same file, which should still
  // count as a single dependency edge, not inflate fan-in.
  for (const [absPath, entry] of parsedByFile) {
    const fileId = fileIdByAbsPath.get(absPath)!;
    const resolvedTargets = new Set<string>();
    for (const importSpecifier of entry.parsed.imports) {
      const targetId = resolveImport(absPath, importSpecifier, fileIdByAbsPath);
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
