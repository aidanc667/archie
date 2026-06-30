// src/pdf.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { convertToPdf } from "./pdf.js";

describe("convertToPdf", () => {
  it("writes a non-empty PDF file from markdown content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "archie-pdf-test-"));
    const outPath = path.join(dir, "summary.pdf");
    try {
      await convertToPdf("# Hello\n\nThis is a test summary.", outPath);

      const stats = await stat(outPath);
      expect(stats.size).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
