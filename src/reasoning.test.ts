// src/reasoning.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  validateReportSections,
  generateReport,
  generateSimplifiedSummary,
  ABSENCE_CLAIM_RULE,
} from "./reasoning.js";
import type { ContextPack } from "./summarizer.js";

const REQUIRED_HEADINGS = [
  "1. System Summary",
  "2. Top 5 Architectural Risks",
  "3. Production Failure Scenarios",
  "4. Refactor Plan (step-by-step)",
  "5. Senior Engineer Verdict",
];

describe("validateReportSections", () => {
  it("accepts a response containing all five required headings", () => {
    const text = REQUIRED_HEADINGS.map((h) => `${h}\nsome content`).join("\n\n");
    expect(validateReportSections(text)).toBe(true);
  });

  it("rejects a response missing a heading", () => {
    const text = REQUIRED_HEADINGS.slice(0, 4).map((h) => `${h}\nsome content`).join("\n\n");
    expect(validateReportSections(text)).toBe(false);
  });

  it("accepts headings that differ only in case (e.g. markdown 'Step-by-Step' vs 'step-by-step')", () => {
    const headingsWithCaseVariation = [
      "1. System Summary",
      "2. Top 5 Architectural Risks",
      "3. Production Failure Scenarios",
      "## 4. Refactor Plan (Step-by-Step)",
      "5. SENIOR ENGINEER VERDICT",
    ];
    const text = headingsWithCaseVariation.map((h) => `${h}\nsome content`).join("\n\n");
    expect(validateReportSections(text)).toBe(true);
  });
});

describe("generateReport", () => {
  it("calls the Claude client and returns its text when sections are valid", async () => {
    const text = REQUIRED_HEADINGS.map((h) => `${h}\ncontent`).join("\n\n");
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text }],
        }),
      },
    };

    const pack: ContextPack = {
      mode: "top-n-detail",
      systemSummary: { fileCount: 1, totalLoc: 10 },
      topRiskFiles: [],
      graphSnapshot: [],
      clusters: [],
    };

    const result = await generateReport(fakeClient as any, pack);
    expect(result).toBe(text);
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(1);
  });

  it("throws when the response is missing required sections", async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "incomplete response" }],
        }),
      },
    };

    const pack: ContextPack = {
      mode: "top-n-detail",
      systemSummary: { fileCount: 1, totalLoc: 10 },
      topRiskFiles: [],
      graphSnapshot: [],
      clusters: [],
    };

    await expect(generateReport(fakeClient as any, pack)).rejects.toThrow(
      /missing required sections/
    );
  });
});

describe("ABSENCE_CLAIM_RULE", () => {
  it("explicitly forbids claiming a file lacks tests unless hasTests is present and false", () => {
    expect(ABSENCE_CLAIM_RULE).toMatch(/hasTests/);
    expect(ABSENCE_CLAIM_RULE.toLowerCase()).toMatch(/insufficient visibility/);
  });
});

describe("generateSimplifiedSummary", () => {
  it("returns the simplified text from a normal response", async () => {
    const simplifiedText =
      "# What This System Does\n\nThis tool checks code quality.\n\n# Bottom Line\n\nWorks fine, some cleanup needed.";
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: simplifiedText }],
        }),
      },
    };

    const result = await generateSimplifiedSummary(fakeClient as any, "## 1. System Summary\nDetailed technical report content here.");
    expect(result).toBe(simplifiedText);
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(1);
  });

  it("throws when the response is suspiciously short", async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "too short" }],
        }),
      },
    };

    await expect(
      generateSimplifiedSummary(fakeClient as any, "## 1. System Summary\nDetailed technical report content here.")
    ).rejects.toThrow(/too short/i);
  });
});
