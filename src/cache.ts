// src/cache.ts
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ParsedFile } from "./parser.js";

export interface CacheEntry {
  hash: string;
  parsed: ParsedFile;
  complexity: number;
}

export interface CacheStore {
  version: number;
  entries: Record<string, CacheEntry>; // key = repo-relative file path
}

const CACHE_VERSION = 1;
const CACHE_DIR = ".archie-cache";
const CACHE_FILE = "parse-cache.json";

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export async function loadCache(repoRoot: string): Promise<CacheStore> {
  const cachePath = path.join(repoRoot, CACHE_DIR, CACHE_FILE);
  try {
    const raw = await readFile(cachePath, "utf8");
    const store = JSON.parse(raw) as CacheStore;
    if (store.version !== CACHE_VERSION) return { version: CACHE_VERSION, entries: {} };
    return store;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

export async function saveCache(repoRoot: string, store: CacheStore): Promise<void> {
  const cacheDir = path.join(repoRoot, CACHE_DIR);
  await mkdir(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, CACHE_FILE);
  await writeFile(cachePath, JSON.stringify(store, null, 2), "utf8");
}
