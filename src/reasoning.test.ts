// src/reasoning.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  validateReportSections,
  generateReport,
  generateSimplifiedSummary,
  ABSENCE_CLAIM_RULE,
  SCENARIO_GROUNDING_RULE,
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

  // Regression test: the same repo (same context pack) produced different
  // "Top 5 Architectural Risks" selections between a local CLI run and a
  // GitHub Actions run, because neither Claude call set a temperature,
  // defaulting to the API's maximum-variance setting. This pins both calls
  // to temperature 0 so the same input reliably produces the same output
  // regardless of which environment ran it.
  it("calls both passes with temperature 0 for reproducible output", async () => {
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

    await generateReport(fakeClient as any, pack);

    const calls = fakeClient.messages.create.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toMatchObject({ temperature: 0 });
    expect(calls[1][0]).toMatchObject({ temperature: 0 });
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

  it("throws a clear error when pass 1's response was truncated (stop_reason: max_tokens)", async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          ...FAKE_RISKS_TOOL_RESPONSE,
          stop_reason: "max_tokens",
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

    await expect(generateReport(fakeClient as any, pack)).rejects.toThrow(/truncated/i);
  });

  it("throws a clear error instead of silently producing undefined-field risks when the tool call's risks field is not an array", async () => {
    // Regression test: a malformed (e.g. truncated) tool response can return
    // `risks` as something other than a well-formed array. Previously this
    // silently produced a report with thousands of "Risk N: undefined —
    // `undefined`" entries instead of failing loudly.
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "report_risks",
              input: { risks: "not an array, e.g. truncated raw JSON text" },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
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
      /malformed.*risks.*field/i
    );
  });

  it("throws a clear error when a risk object is missing a required field", async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "report_risks",
              input: { risks: [{ title: "Missing fields", file: "src/x.ts" }] },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
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

    await expect(generateReport(fakeClient as any, pack)).rejects.toThrow(/malformed risk at index 0/i);
  });

  it("retries pass 1 after a truncated response and succeeds on a later attempt", async () => {
    const remainingText = [
      "## 1. System Summary\ncontent",
      "## 3. Production Failure Scenarios\ncontent",
      "## 4. Refactor Plan (step-by-step)\ncontent",
      "## 5. Senior Engineer Verdict\ncontent",
    ].join("\n\n");

    const truncatedResponse = { ...FAKE_RISKS_TOOL_RESPONSE, stop_reason: "max_tokens" };

    const fakeClient = {
      messages: {
        create: vi
          .fn()
          .mockResolvedValueOnce(truncatedResponse) // attempt 1: truncated
          .mockResolvedValueOnce(FAKE_RISKS_TOOL_RESPONSE) // attempt 2: succeeds
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

    const { report } = await generateReport(fakeClient as any, pack);
    expect(report).toContain("**Severity:** High");
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(3); // 2 pass-1 attempts + 1 pass-2 call
  });

  it("does not retry a non-retryable error (e.g. no tool_use block at all)", async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "incomplete response" }],
          usage: { input_tokens: 100, output_tokens: 50 },
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

    await expect(generateReport(fakeClient as any, pack)).rejects.toThrow(/report_risks tool/);
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(1); // failed fast, no retries
  });

  it("caps the rendered risks section at 5, even if the model returns more", async () => {
    const manyRisks = Array.from({ length: 8 }, (_, i) => ({
      title: `Risk ${i}`,
      file: `src/file${i}.ts`,
      severity: "Medium" as const,
      confidence: "high" as const,
      why_it_matters: "matters",
      root_cause: "cause",
      evidence: "evidence",
    }));

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
          .mockResolvedValueOnce({
            content: [
              { type: "tool_use", id: "tu_1", name: "report_risks", input: { risks: manyRisks } },
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

    const { report } = await generateReport(fakeClient as any, pack);
    expect(report.match(/^### Risk \d+:/gm)).toHaveLength(5);
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

  it("includes a scope statement with partial-coverage wording for a top-n-detail pack with unassessed files", async () => {
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
      systemSummary: { fileCount: 20, totalLoc: 1000 },
      topRiskFiles: [
        {
          path: "src/a.ts",
          riskScore: 0.9,
          complexity: 10,
          fanIn: 5,
          loc: 100,
          source: "",
          hasTests: true,
          hasErrorHandling: true,
        },
        {
          path: "src/b.ts",
          riskScore: 0.8,
          complexity: 8,
          fanIn: 3,
          loc: 80,
          source: "",
          hasTests: false,
          hasErrorHandling: false,
        },
        {
          path: "src/c.ts",
          riskScore: 0.7,
          complexity: 6,
          fanIn: 2,
          loc: 60,
          source: "",
          hasTests: true,
          hasErrorHandling: false,
        },
      ],
      graphSnapshot: [],
      clusters: [],
    };

    const { report: result } = await generateReport(fakeClient as any, pack);
    expect(result).toContain("**Scope of this analysis:**");
    expect(result).toContain("analyzed all 20 files");
    expect(result).toContain("examined the top 3 in detail");
  });

  it("includes cluster-specific scope wording for a cluster-summary pack", async () => {
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
      mode: "cluster-summary",
      systemSummary: { fileCount: 500, totalLoc: 50000 },
      topRiskFiles: [],
      graphSnapshot: [],
      clusters: [{ fileCount: 500, averageComplexity: 5, maxRiskScore: 0.95 }],
    };

    const { report: result } = await generateReport(fakeClient as any, pack);
    expect(result).toContain("**Scope of this analysis:**");
    expect(result.toLowerCase()).toMatch(/coarse|cluster-level/);
  });

  it("uses 'all N files' wording when every file was analyzed in detail", async () => {
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
      systemSummary: { fileCount: 2, totalLoc: 100 },
      topRiskFiles: [
        {
          path: "src/a.ts",
          riskScore: 0.9,
          complexity: 10,
          fanIn: 5,
          loc: 50,
          source: "",
          hasTests: true,
          hasErrorHandling: true,
        },
        {
          path: "src/b.ts",
          riskScore: 0.8,
          complexity: 8,
          fanIn: 3,
          loc: 50,
          source: "",
          hasTests: false,
          hasErrorHandling: false,
        },
      ],
      graphSnapshot: [],
      clusters: [],
    };

    const { report: result } = await generateReport(fakeClient as any, pack);
    expect(result).toContain("**Scope of this analysis:** Archie analyzed all 2 files in this repository in detail.");
    expect(result).not.toContain("were not individually assessed");
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

describe("SCENARIO_GROUNDING_RULE", () => {
  it("forbids asserting a specific attacker-controlled call chain unless graphSnapshot or source shows it", () => {
    expect(SCENARIO_GROUNDING_RULE).toMatch(/graphSnapshot/);
    expect(SCENARIO_GROUNDING_RULE.toLowerCase()).toMatch(/conditionally/);
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

  it("calls Claude with temperature 0 for reproducible summaries", async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: "text",
            text: "# What This System Does\n\nThis tool checks code quality.\n\n# Bottom Line\n\nWorks fine, some cleanup needed.",
          }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      },
    };

    await generateSimplifiedSummary(fakeClient as any, "## 1. System Summary\nDetailed technical report content here.");

    expect(fakeClient.messages.create.mock.calls[0][0]).toMatchObject({ temperature: 0 });
  });

  it("throws a clear error instead of returning a truncated summary when stop_reason is max_tokens", async () => {
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "# System\n\n**Over the course of one week, break the 1,900-" }],
          usage: { input_tokens: 100, output_tokens: 4096 },
          stop_reason: "max_tokens",
        }),
      },
    };

    await expect(
      generateSimplifiedSummary(fakeClient as any, "## 1. System Summary\nDetailed technical report content here.")
    ).rejects.toThrow(/truncated/i);
  });

  it("deterministically splices the technical report's scope statement into the simplified summary, near the top", async () => {
    const simplifiedText =
      "# Some System\n\n*Architecture Report · Generated by ARCHIE*\n\n---\n\n## What This System Does\n\nDoes things.\n\n---\n\n## Bottom Line\n\nFine.";
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: simplifiedText }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      },
    };

    const technicalReport =
      "## 1. System Summary\n\nSome prose.\n\n**Scope of this analysis:** 10 of 32 files were analyzed in detail for this report. The remaining 22 files were not individually assessed.\n\n## 2. Top 5 Architectural Risks\n...";

    const { summary } = await generateSimplifiedSummary(fakeClient as any, technicalReport);

    expect(summary).toContain("10 of 32 files were analyzed in detail");
    // Must land before "What This System Does", not buried at the end.
    expect(summary.indexOf("10 of 32 files")).toBeLessThan(summary.indexOf("What This System Does"));
  });

  it("leaves the simplified summary unchanged when the technical report has no scope statement (unexpected shape, fail open)", async () => {
    const simplifiedText =
      "# System\n\nNo separator anywhere in here at all, and this sentence pads it past the minimum length requirement.";
    const fakeClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: simplifiedText }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      },
    };

    const { summary } = await generateSimplifiedSummary(fakeClient as any, "no scope line in this input at all");
    expect(summary).toBe(simplifiedText);
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
