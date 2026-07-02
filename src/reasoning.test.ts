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

const FAKE_RISKS = [
  {
    title: "High coupling in core module",
    file: "src/core.ts",
    severity: "High" as const,
    confidence: "high" as const,
    why_it_matters: "Many dependents will break.",
    root_cause: "fanIn=14 means many files import this module directly.",
    evidence: "fanIn=14",
  },
];

const FAKE_RISKS_TOOL_RESPONSE = {
  content: [
    {
      type: "tool_use",
      id: "tu_1",
      name: "report_risks",
      input: { risks: FAKE_RISKS },
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
};

describe("generateReport", () => {
  it("calls the Claude client twice and returns assembled report with all sections", async () => {
    const remainingText = [
      "## 1. System Summary\ncontent",
      "## 3. Production Failure Scenarios\ncontent",
      "## 4. Refactor Plan (step-by-step)\ncontent",
      "## 5. Senior Engineer Verdict\ncontent",
    ].join("\n\n");

    const fakeClient = {
      messages: {
        create: vi
          .fn()
          .mockResolvedValueOnce(FAKE_RISKS_TOOL_RESPONSE)
          .mockResolvedValueOnce({
            content: [{ type: "text", text: remainingText }],
            usage: { input_tokens: 200, output_tokens: 150 },
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

    const { report: result, usage } = await generateReport(fakeClient as any, pack);
    expect(result).toContain("1. System Summary");
    expect(result).toContain("2. Top 5 Architectural Risks");
    expect(result).toContain("**Severity:** High");
    expect(result).toContain("**Root cause:**");
    expect(result).toContain("3. Production Failure Scenarios");
    expect(result).toContain("4. Refactor Plan (step-by-step)");
    expect(result).toContain("5. Senior Engineer Verdict");
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(2);
    expect(usage).toEqual({ inputTokens: 300, outputTokens: 200 });
  });

  it("throws when pass 1 does not return a tool_use block", async () => {
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
      /report_risks tool/
    );
  });

  it("throws when the assembled report is missing required sections", async () => {
    const fakeClient = {
      messages: {
        create: vi
          .fn()
          .mockResolvedValueOnce(FAKE_RISKS_TOOL_RESPONSE)
          .mockResolvedValueOnce({ content: [{ type: "text", text: "incomplete" }] }),
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

  it("sorts risks by severity (Critical, then High, then Medium) regardless of input order", async () => {
    const remainingText = [
      "## 1. System Summary\ncontent",
      "## 3. Production Failure Scenarios\ncontent",
      "## 4. Refactor Plan (step-by-step)\ncontent",
      "## 5. Senior Engineer Verdict\ncontent",
    ].join("\n\n");

    const unsortedRisks = [
      {
        title: "Medium severity issue",
        file: "src/medium.ts",
        severity: "Medium" as const,
        confidence: "high" as const,
        why_it_matters: "Some impact.",
        root_cause: "Some cause.",
        evidence: "Some evidence.",
      },
      {
        title: "Critical severity issue",
        file: "src/critical.ts",
        severity: "Critical" as const,
        confidence: "high" as const,
        why_it_matters: "Severe impact.",
        root_cause: "Severe cause.",
        evidence: "Severe evidence.",
      },
      {
        title: "High severity issue",
        file: "src/high.ts",
        severity: "High" as const,
        confidence: "high" as const,
        why_it_matters: "Notable impact.",
        root_cause: "Notable cause.",
        evidence: "Notable evidence.",
      },
    ];

    const fakeClient = {
      messages: {
        create: vi
          .fn()
          .mockResolvedValueOnce({
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "report_risks",
                input: { risks: unsortedRisks },
              },
            ],
            usage: { input_tokens: 100, output_tokens: 50 },
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: remainingText }],
            usage: { input_tokens: 200, output_tokens: 150 },
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

    const { report: result } = await generateReport(fakeClient as any, pack);
    const criticalIndex = result.indexOf("Critical severity issue");
    const highIndex = result.indexOf("High severity issue");
    const mediumIndex = result.indexOf("Medium severity issue");

    expect(criticalIndex).toBeGreaterThan(-1);
    expect(highIndex).toBeGreaterThan(-1);
    expect(mediumIndex).toBeGreaterThan(-1);
    expect(criticalIndex).toBeLessThan(highIndex);
    expect(highIndex).toBeLessThan(mediumIndex);
  });

  it("appends a confidence caveat for low/medium confidence risks but not high confidence risks", async () => {
    const remainingText = [
      "## 1. System Summary\ncontent",
      "## 3. Production Failure Scenarios\ncontent",
      "## 4. Refactor Plan (step-by-step)\ncontent",
      "## 5. Senior Engineer Verdict\ncontent",
    ].join("\n\n");

    const risks = [
      {
        title: "Low confidence issue",
        file: "src/lowconf.ts",
        severity: "Medium" as const,
        confidence: "low" as const,
        why_it_matters: "Some impact.",
        root_cause: "Some cause.",
        evidence: "Some evidence.",
      },
      {
        title: "High confidence issue",
        file: "src/highconf.ts",
        severity: "High" as const,
        confidence: "high" as const,
        why_it_matters: "Notable impact.",
        root_cause: "Notable cause.",
        evidence: "Notable evidence.",
      },
    ];

    const fakeClient = {
      messages: {
        create: vi
          .fn()
          .mockResolvedValueOnce({
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "report_risks",
                input: { risks },
              },
            ],
            usage: { input_tokens: 100, output_tokens: 50 },
          })
          .mockResolvedValueOnce({
            content: [{ type: "text", text: remainingText }],
            usage: { input_tokens: 200, output_tokens: 150 },
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

    const { report: result } = await generateReport(fakeClient as any, pack);
    expect(result).toContain(
      "*Confidence: based on graph structure and metrics only — full source wasn't available to verify this finding directly.*"
    );

    const highConfSectionStart = result.indexOf("High confidence issue");
    const nextRiskOrEnd = result.indexOf("### Risk", highConfSectionStart + 1);
    const highConfSection =
      nextRiskOrEnd === -1
        ? result.slice(highConfSectionStart)
        : result.slice(highConfSectionStart, nextRiskOrEnd);
    expect(highConfSection).not.toContain("*Confidence:");
  });
});

describe("ABSENCE_CLAIM_RULE", () => {
  it("explicitly forbids claiming a file lacks tests unless hasTests is present and false", () => {
    expect(ABSENCE_CLAIM_RULE).toMatch(/hasTests/);
    expect(ABSENCE_CLAIM_RULE.toLowerCase()).toMatch(/insufficient visibility/);
  });

  it("explicitly forbids claiming a file lacks error handling unless hasErrorHandling is present and false", () => {
    expect(ABSENCE_CLAIM_RULE).toMatch(/hasErrorHandling/);
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
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      },
    };

    const { summary, usage } = await generateSimplifiedSummary(fakeClient as any, "## 1. System Summary\nDetailed technical report content here.");
    expect(summary).toBe(simplifiedText);
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 50 });
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
