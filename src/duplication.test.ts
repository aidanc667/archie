// src/duplication.test.ts
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { findDuplicateGroups } from "./duplication.js";
import type { CodeGraph } from "./types.js";

// Same fallback value computeBodyHash in parser.ts produces when hashing
// fails -- sha256 of the empty string, truncated to 16 hex chars. Computed
// here rather than hardcoded so this test can't silently drift from
// parser.ts's actual fallback shape.
const EMPTY_STRING_HASH = createHash("sha256").update("").digest("hex").slice(0, 16);

describe("findDuplicateGroups", () => {
  it("groups two functions in different files sharing the same real bodyHash", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 },
        { kind: "function", id: "fn:1", name: "foo", fileId: "file:a.ts", startLine: 1, endLine: 2, bodyHash: "abc123abc123abc1" },
        { kind: "function", id: "fn:2", name: "bar", fileId: "file:b.ts", startLine: 1, endLine: 2, bodyHash: "abc123abc123abc1" },
      ],
      edges: [],
    };

    const report = findDuplicateGroups(graph);

    expect(report.groups).toEqual([
      {
        bodyHash: "abc123abc123abc1",
        functions: [
          { name: "foo", fileId: "file:a.ts" },
          { name: "bar", fileId: "file:b.ts" },
        ],
      },
    ]);
  });

  it("does not group two functions in the same file sharing the same bodyHash", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "function", id: "fn:1", name: "foo", fileId: "file:a.ts", startLine: 1, endLine: 2, bodyHash: "abc123abc123abc1" },
        { kind: "function", id: "fn:2", name: "bar", fileId: "file:a.ts", startLine: 3, endLine: 4, bodyHash: "abc123abc123abc1" },
      ],
      edges: [],
    };

    const report = findDuplicateGroups(graph);

    expect(report.groups).toEqual([]);
  });

  it("groups three functions across three different files sharing the same bodyHash into one group of 3", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 },
        { kind: "file", id: "file:c.ts", path: "c.ts", loc: 10 },
        { kind: "function", id: "fn:1", name: "foo", fileId: "file:a.ts", startLine: 1, endLine: 2, bodyHash: "deadbeefdeadbeef" },
        { kind: "function", id: "fn:2", name: "bar", fileId: "file:b.ts", startLine: 1, endLine: 2, bodyHash: "deadbeefdeadbeef" },
        { kind: "function", id: "fn:3", name: "baz", fileId: "file:c.ts", startLine: 1, endLine: 2, bodyHash: "deadbeefdeadbeef" },
      ],
      edges: [],
    };

    const report = findDuplicateGroups(graph);

    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.functions).toHaveLength(3);
    expect(report.groups[0]).toEqual({
      bodyHash: "deadbeefdeadbeef",
      functions: [
        { name: "foo", fileId: "file:a.ts" },
        { name: "bar", fileId: "file:b.ts" },
        { name: "baz", fileId: "file:c.ts" },
      ],
    });
  });

  it("does not include a bodyHash shared by only one function anywhere", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "function", id: "fn:1", name: "foo", fileId: "file:a.ts", startLine: 1, endLine: 2, bodyHash: "onlyoneuniquehas" },
      ],
      edges: [],
    };

    const report = findDuplicateGroups(graph);

    expect(report.groups).toEqual([]);
  });

  it("does not group two functions whose bodyHash both equal the empty-string fallback hash", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 },
        { kind: "function", id: "fn:1", name: "foo", fileId: "file:a.ts", startLine: 1, endLine: 2, bodyHash: EMPTY_STRING_HASH },
        { kind: "function", id: "fn:2", name: "bar", fileId: "file:b.ts", startLine: 1, endLine: 2, bodyHash: EMPTY_STRING_HASH },
      ],
      edges: [],
    };

    const report = findDuplicateGroups(graph);

    expect(report.groups).toEqual([]);
  });

  it("returns only the one real cross-file group amid unrelated unique-hash functions", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 },
        { kind: "file", id: "file:c.ts", path: "c.ts", loc: 10 },
        { kind: "function", id: "fn:1", name: "foo", fileId: "file:a.ts", startLine: 1, endLine: 2, bodyHash: "sharedrealhash01" },
        { kind: "function", id: "fn:2", name: "bar", fileId: "file:b.ts", startLine: 1, endLine: 2, bodyHash: "sharedrealhash01" },
        { kind: "function", id: "fn:3", name: "unique1", fileId: "file:a.ts", startLine: 3, endLine: 4, bodyHash: "uniquehashone001" },
        { kind: "function", id: "fn:4", name: "unique2", fileId: "file:c.ts", startLine: 1, endLine: 2, bodyHash: "uniquehashtwo002" },
        { kind: "function", id: "fn:5", name: "empty1", fileId: "file:a.ts", startLine: 5, endLine: 6, bodyHash: EMPTY_STRING_HASH },
        { kind: "function", id: "fn:6", name: "empty2", fileId: "file:c.ts", startLine: 3, endLine: 4, bodyHash: EMPTY_STRING_HASH },
      ],
      edges: [],
    };

    const report = findDuplicateGroups(graph);

    expect(report.groups).toEqual([
      {
        bodyHash: "sharedrealhash01",
        functions: [
          { name: "foo", fileId: "file:a.ts" },
          { name: "bar", fileId: "file:b.ts" },
        ],
      },
    ]);
  });

  it("returns an empty groups array for an empty graph with no function nodes", () => {
    const graph: CodeGraph = {
      nodes: [{ kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 }],
      edges: [],
    };

    const report = findDuplicateGroups(graph);

    expect(report).toEqual({ groups: [] });
  });

  it("returns an empty groups array when every function has an undefined bodyHash", () => {
    const graph: CodeGraph = {
      nodes: [
        { kind: "file", id: "file:a.ts", path: "a.ts", loc: 10 },
        { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 },
        { kind: "function", id: "fn:1", name: "foo", fileId: "file:a.ts", startLine: 1, endLine: 2 },
        { kind: "function", id: "fn:2", name: "bar", fileId: "file:b.ts", startLine: 1, endLine: 2 },
      ],
      edges: [],
    };

    const report = findDuplicateGroups(graph);

    expect(report).toEqual({ groups: [] });
  });
});
