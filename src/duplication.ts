// src/duplication.ts
import { createHash } from "node:crypto";
import type { CodeGraph, FunctionNode } from "./types.js";

export interface DuplicateFunctionRef {
  name: string;
  fileId: string;
}

export interface DuplicateGroup {
  bodyHash: string;
  functions: DuplicateFunctionRef[];
}

export interface DuplicationReport {
  groups: DuplicateGroup[];
}

// parser.ts's computeBodyHash falls back to hashing the empty string (then
// truncating to 16 hex chars, same as every real bodyHash) whenever it can't
// walk a function's subtree cleanly. Computed here rather than hardcoded so
// this exclusion can't silently drift if parser.ts's hashing approach ever
// changes -- two functions sharing THIS value share nothing but a failed
// hash computation, not an actual structural shape, so it's not a real
// duplication signal and must never be allowed to group functions together.
const FALLBACK_EMPTY_BODY_HASH = createHash("sha256").update("").digest("hex").slice(0, 16);

export function findDuplicateGroups(graph: CodeGraph): DuplicationReport {
  const functionsByHash = new Map<string, FunctionNode[]>();

  for (const node of graph.nodes) {
    if (node.kind !== "function") continue;
    const hash = node.bodyHash;
    // undefined means no hash was ever computed for this node (e.g. older
    // test fixtures built before this field existed) -- there's no signal
    // to group on at all, real or otherwise.
    if (hash === undefined) continue;
    // The fallback value means hashing failed, not that the function is
    // trivially empty -- matching on it would report unrelated functions
    // as "duplicates" purely because their hash computation both failed.
    if (hash === FALLBACK_EMPTY_BODY_HASH) continue;

    let bucket = functionsByHash.get(hash);
    if (!bucket) {
      bucket = [];
      functionsByHash.set(hash, bucket);
    }
    bucket.push(node);
  }

  const groups: DuplicateGroup[] = [];
  for (const [hash, functions] of functionsByHash) {
    if (functions.length < 2) continue;

    // Same-file duplication is out of scope for this feature (the user
    // asked for duplication specifically ACROSS files), so a group only
    // counts if its members span 2+ distinct files.
    const distinctFileIds = new Set(functions.map((fn) => fn.fileId));
    if (distinctFileIds.size < 2) continue;

    groups.push({
      bodyHash: hash,
      functions: functions.map((fn) => ({ name: fn.name, fileId: fn.fileId })),
    });
  }

  return { groups };
}
