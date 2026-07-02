// src/history.ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface HistoryEntry {
  timestamp: string; // ISO 8601, e.g. new Date().toISOString()
  fileCount: number;
  totalLoc: number;
  topRiskFile: { path: string; riskScore: number } | null;
  averageRiskScore: number;
}

export interface HistoryStore {
  version: number;
  entries: HistoryEntry[];
}

const CACHE_VERSION = 1;
const CACHE_DIR = ".archie-cache";
const HISTORY_FILE = "history.json";
const MAX_ENTRIES = 50;

export async function loadHistory(repoRoot: string): Promise<HistoryStore> {
  const historyPath = path.join(repoRoot, CACHE_DIR, HISTORY_FILE);
  try {
    const raw = await readFile(historyPath, "utf8");
    const store = JSON.parse(raw) as HistoryStore;
    if (store.version !== CACHE_VERSION) return { version: CACHE_VERSION, entries: [] };
    return store;
  } catch {
    return { version: CACHE_VERSION, entries: [] };
  }
}

export async function appendHistoryEntry(repoRoot: string, entry: HistoryEntry): Promise<void> {
  const store = await loadHistory(repoRoot);
  store.entries.push(entry);
  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(store.entries.length - MAX_ENTRIES);
  }

  const historyDir = path.join(repoRoot, CACHE_DIR);
  await mkdir(historyDir, { recursive: true });
  const historyPath = path.join(historyDir, HISTORY_FILE);
  await writeFile(historyPath, JSON.stringify(store, null, 2), "utf8");
}
