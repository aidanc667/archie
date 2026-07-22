// src/types.ts
import type { MagicNumberOccurrence } from "./parser.js";

export interface FileNode {
  kind: "file";
  id: string;
  path: string;
  loc: number;
  // Raw magic-number occurrences found in this file's source (excludes 0/1/-1
  // and const-declared values -- see parser.ts's magic-number extraction for
  // the exact exclusion rules). Optional, not required: dozens of test
  // fixtures across the suite construct FileNode literals directly without
  // this field, and this addition must stay purely additive rather than
  // forcing every one of them to change.
  magicNumbers?: MagicNumberOccurrence[];
}

export interface FunctionNode {
  kind: "function";
  id: string;
  name: string;
  fileId: string;
  startLine: number;
  endLine: number;
  // Structural hash of the function's normalized body (identifiers
  // positionally placeholdered, string/number literals collapsed) -- see
  // parser.ts's computeBodyHash. Lets a duplicate-detection consumer match
  // two functions that are shaped identically but use different parameter
  // names, local variable names, and literal content. Optional, not
  // required: summarizer.test.ts (owned by a different in-flight task in
  // this same build, out of scope here) constructs FunctionNode literals
  // directly without this field, and this addition must stay purely
  // additive rather than forcing an unrelated file to change.
  bodyHash?: string;
}

export interface ClassNode {
  kind: "class";
  id: string;
  name: string;
  fileId: string;
  startLine: number;
  endLine: number;
}

export type GraphNode = FileNode | FunctionNode | ClassNode;

export type EdgeType = "CONTAINS" | "IMPORTS" | "CALLS" | "EXPORTS" | "TESTED_BY";

export interface Edge {
  type: EdgeType;
  from: string;
  to: string;
  confidence: number;
}

export interface CodeGraph {
  nodes: GraphNode[];
  edges: Edge[];
}
