// src/index.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { runPipeline } from "./index.js";

const REQUIRED_HEADINGS = [
  "1. System Summary",
  "2. Top 5 Architectural Risks",
  "3. Production Failure Scenarios",
  "4. Refactor Plan (step-by-step)",
  "5. Senior Engineer Verdict",
];

// The remaining-sections text returned by Pass 2 (no section 2 — it's injected from structured data)
const REMAINING_SECTIONS_TEXT = [
  "## 1. System Summary\nsome content",
  "## 3. Production Failure Scenarios\nsome content",
  "## 4. Refactor Plan (step-by-step)\nsome content",
  "## 5. Senior Engineer Verdict\nsome content",
].join("\n\n");

const FAKE_RISKS_TOOL_RESPONSE = {
  content: [
    {
      type: "tool_use",
      id: "tu_1",
      name: "report_risks",
      input: {
        risks: [
          {
            title: "High coupling",
            file: "src/core.ts",
            severity: "High",
            confidence: "high",
            why_it_matters: "Cascading failures.",
            root_cause: "fanIn=14 means many files import this module directly.",
            evidence: "fanIn=14",
          },
        ],
      },
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
};

const SIMPLIFIED_SUMMARY_TEXT =
  "# What This System Does\n\nThis tool checks code quality.\n\n# Bottom Line\n\nWorks fine, some cleanup needed and this sentence pads it past the minimum length requirement.";

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockImplementation(({ system, tools }: { system: string; tools?: unknown[] }) => {
          if (system.includes("Staff Engineer") && tools && tools.length > 0) {
            // Pass 1: structured risks
            return Promise.resolve(FAKE_RISKS_TOOL_RESPONSE);
          }
          if (system.includes("Staff Engineer")) {
            // Pass 2: remaining sections
            return Promise.resolve({
              content: [{ type: "text", text: REMAINING_SECTIONS_TEXT }],
              usage: { input_tokens: 200, output_tokens: 150 },
            });
          }
          // generateSimplifiedSummary
          return Promise.resolve({
            content: [{ type: "text", text: SIMPLIFIED_SUMMARY_TEXT }],
            usage: { input_tokens: 80, output_tokens: 40 },
          });
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

    REQUIRED_HEADINGS.forEach((h) => expect(result.report).toContain(h));
    expect(result.report).toContain("**Severity:** High");
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

    REQUIRED_HEADINGS.forEach((h) => expect(result.report).toContain(h));
    expect(result.simplifiedSummary).toBeUndefined();
  });
});
