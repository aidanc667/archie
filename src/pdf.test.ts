// src/pdf.test.ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { convertToPdf } from "./pdf.js";

describe("convertToPdf", () => {
  it("writes a non-empty PDF file from markdown content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "archie-pdf-test-"));
    const outPath = path.join(dir, "summary.pdf");
    try {
      await convertToPdf("# Hello\n\nThis is a test summary.", outPath);

      const buf = await readFile(outPath);
      expect(buf.subarray(0, 4).toString()).toBe("%PDF");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
});
