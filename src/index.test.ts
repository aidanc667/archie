// src/index.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { runPipeline } from "./index.js";

const REQUIRED_HEADINGS_TEXT = [
  "1. System Summary",
  "2. Top 5 Architectural Risks",
  "3. Production Failure Scenarios",
  "4. Refactor Plan (step-by-step)",
  "5. Senior Engineer Verdict",
]
  .map((h) => `${h}\nsome content`)
  .join("\n\n");

const SIMPLIFIED_SUMMARY_TEXT =
  "# What This System Does\n\nThis tool checks code quality.\n\n# Bottom Line\n\nWorks fine, some cleanup needed and this sentence pads it past the minimum length requirement.";

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockImplementation(({ system }: { system: string }) => {
          // Distinguish which prompt is being used by checking the system prompt text,
          // since generateReport and generateSimplifiedSummary use different prompts.
          if (system.includes("Staff Engineer")) {
            return Promise.resolve({ content: [{ type: "text", text: REQUIRED_HEADINGS_TEXT }] });
          }
          return Promise.resolve({ content: [{ type: "text", text: SIMPLIFIED_SUMMARY_TEXT }] });
        }),
      },
    })),
  };
});

describe("runPipeline with generatePdf", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it("populates simplifiedSummary when generatePdf is true", async () => {
    const repoPath = path.resolve("fixtures/parser-basic");
    const result = await runPipeline({
      repoPath,
      topN: 5,
      maxTokens: 50000,
      generatePdf: true,
    });

    expect(result.report).toBe(REQUIRED_HEADINGS_TEXT);
    expect(result.simplifiedSummary).toBe(SIMPLIFIED_SUMMARY_TEXT);
  });

  it("leaves simplifiedSummary undefined when generatePdf is false", async () => {
    const repoPath = path.resolve("fixtures/parser-basic");
    const result = await runPipeline({
      repoPath,
      topN: 5,
      maxTokens: 50000,
      generatePdf: false,
    });

    expect(result.report).toBe(REQUIRED_HEADINGS_TEXT);
    expect(result.simplifiedSummary).toBeUndefined();
  });
});
