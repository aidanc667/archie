// src/cli.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { runPipeline } from "./index.js";

describe("runPipeline", () => {
  it("throws a clear error when the path does not exist", async () => {
    await expect(
      runPipeline({ repoPath: "/nonexistent/path/xyz", topN: 5, maxTokens: 50000 })
    ).rejects.toThrow(/does not exist/);
  });

  it("throws a clear error when no parseable files are found", async () => {
    const emptyDir = path.resolve("fixtures/empty-repo");
    await expect(
      runPipeline({ repoPath: emptyDir, topN: 5, maxTokens: 50000 })
    ).rejects.toThrow(/No parseable/);
  });
});
