// src/history.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadHistory, appendHistoryEntry, type HistoryEntry } from "./history.js";

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    timestamp: new Date().toISOString(),
    fileCount: 10,
    totalLoc: 1000,
    topRiskFile: { path: "src/foo.ts", riskScore: 0.5 },
    averageRiskScore: 0.3,
    ...overrides,
  };
}

describe("history", () => {
  it("loadHistory returns an empty store when no file exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "archie-history-test-"));
    try {
      const store = await loadHistory(dir);
      expect(store.version).toBe(1);
      expect(store.entries).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("appendHistoryEntry then loadHistory round-trips a single entry correctly", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "archie-history-test-"));
    try {
      const entry = makeEntry();
      await appendHistoryEntry(dir, entry);

      const store = await loadHistory(dir);
      expect(store.entries).toHaveLength(1);
      expect(store.entries[0]).toEqual(entry);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps the stored array at 50 entries and drops the oldest", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "archie-history-test-"));
    try {
      for (let i = 0; i < 55; i++) {
        await appendHistoryEntry(dir, makeEntry({ fileCount: i }));
      }

      const store = await loadHistory(dir);
      expect(store.entries).toHaveLength(50);
      // Oldest 5 (fileCount 0-4) should have been dropped; entries 5..54 remain.
      expect(store.entries[0].fileCount).toBe(5);
      expect(store.entries[49].fileCount).toBe(54);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
