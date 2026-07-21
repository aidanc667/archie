// src/consistency.ts
import type { CodeGraph, FileNode } from "./types.js";

export interface NamingInconsistency {
  name: string;
  fileId: string;
  kind: "function" | "class";
  language: string;
  detectedStyle: string;
  dominantStyle: string;
}

export interface NamingConsistencyReport {
  inconsistencies: NamingInconsistency[];
  dominantStyleByGroup: Record<string, string>;
}

// TS and JS share the same naming conventions in practice, so both extensions
// fold into a single "ts" language key rather than splitting sample sizes (and
// dominant-style computation) across two buckets that would behave identically.
// Exported (renamed from the module-private `detectLanguage`) so summarizer.ts
// can resolve a test file's language the same way this module resolves a
// source file's -- the two features must agree on what "language" a file is
// rather than a third, possibly-inconsistent copy of this logic.
export function detectFileLanguage(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  const ext = dot === -1 ? "" : filePath.slice(dot);
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
      return "ts";
    case ".py":
      return "python";
    case ".go":
      return "go";
    default:
      return null;
  }
}

type CaseStyle =
  | "camelCase"
  | "snake_case"
  | "PascalCase"
  | "SCREAMING_SNAKE_CASE"
  | "ambiguous";

// A name only carries a real signal if it contains an underscore (snake family)
// or a capital letter after position 0 (camel/Pascal family). A single
// all-lowercase word, or a single word whose only capital is the first letter,
// looks identical under either convention, so it's classified "ambiguous"
// rather than silently assumed to match (or deviate from) the group's style.
//
// Leading/trailing underscores are stripped before classifying -- they're a
// private-name marker (Python's `_private`/`__dunder__`, the same convention
// in JS/TS), not a snake_case signal by themselves. Without this,
// `_privateHelper` in an otherwise camelCase file would be misclassified as
// snake_case purely because of its privacy marker, and `__init__` would read
// as SCREAMING_SNAKE_CASE instead of the ambiguous single word ("init") it
// actually is once the markers are set aside.
function classifyCaseStyle(name: string): CaseStyle {
  const stripped = name.replace(/^_+/, "").replace(/_+$/, "");
  if (stripped.length === 0) return "ambiguous"; // name was entirely underscores

  if (stripped.includes("_")) {
    const hasLower = /[a-z]/.test(stripped);
    return hasLower ? "snake_case" : "SCREAMING_SNAKE_CASE";
  }

  const hasInternalCapital = /[A-Z]/.test(stripped.slice(1));
  if (hasInternalCapital) {
    return /[A-Z]/.test(stripped[0] ?? "") ? "PascalCase" : "camelCase";
  }

  return "ambiguous";
}

export function computeNamingConsistency(graph: CodeGraph): NamingConsistencyReport {
  const fileById = new Map<string, FileNode>();
  for (const node of graph.nodes) {
    if (node.kind === "file") fileById.set(node.id, node);
  }

  interface Candidate {
    name: string;
    fileId: string;
    kind: "function" | "class";
    language: string;
    style: CaseStyle;
  }

  const candidates: Candidate[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "function" && node.kind !== "class") continue;
    const file = fileById.get(node.fileId);
    if (!file) continue;
    const language = detectFileLanguage(file.path);
    if (!language) continue; // unrecognized extension - not a tracked language bucket

    candidates.push({
      name: node.name,
      fileId: node.fileId,
      kind: node.kind,
      language,
      style: classifyCaseStyle(node.name),
    });
  }

  // Tally non-ambiguous style counts per (language, kind) group.
  const groupCounts = new Map<string, Map<CaseStyle, number>>();
  for (const c of candidates) {
    if (c.style === "ambiguous") continue;
    const groupKey = `${c.language}:${c.kind}`;
    let counts = groupCounts.get(groupKey);
    if (!counts) {
      counts = new Map();
      groupCounts.set(groupKey, counts);
    }
    counts.set(c.style, (counts.get(c.style) ?? 0) + 1);
  }

  // Require at least 2 non-ambiguous samples before declaring a dominant style -
  // with fewer, there's no real basis to call anything "consistent" or not.
  const dominantStyleByGroup: Record<string, string> = {};
  for (const [groupKey, counts] of groupCounts) {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    if (total < 2) continue;

    let bestStyle: CaseStyle | null = null;
    let bestCount = -1;
    for (const [style, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        bestStyle = style;
      }
    }
    dominantStyleByGroup[groupKey] = bestStyle as CaseStyle;
  }

  const inconsistencies: NamingInconsistency[] = [];
  for (const c of candidates) {
    if (c.style === "ambiguous") continue;
    const groupKey = `${c.language}:${c.kind}`;
    const dominant = dominantStyleByGroup[groupKey];
    if (!dominant) continue; // group never met the minimum sample size
    if (c.style !== dominant) {
      inconsistencies.push({
        name: c.name,
        fileId: c.fileId,
        kind: c.kind,
        language: c.language,
        detectedStyle: c.style,
        dominantStyle: dominant,
      });
    }
  }

  return { inconsistencies, dominantStyleByGroup };
}
