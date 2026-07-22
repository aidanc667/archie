// src/reasoning.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  validateReportSections,
  generateReport,
  generateSimplifiedSummary,
  ABSENCE_CLAIM_RULE,
  SCENARIO_GROUNDING_RULE,
  DEPENDENCY_GROUNDING_RULE,
  EXPORT_GROUNDING_RULE,
  NAMING_CONSISTENCY_RULE,
  MAGIC_NUMBER_GROUNDING_RULE,
  DUPLICATION_GROUNDING_RULE,
  DEAD_FILE_GROUNDING_RULE,
  SECURITY_GROUNDING_RULE,
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

// Pass 1 now runs TWO forced tool calls in parallel (report_risks and
// report_scenarios) followed by ONE sequential free-text pass (sections 1,
// 4, 5). Every generateReport test below needs a fake client that can
// distinguish which of the three requests it's answering. Dispatching on
// `tool_choice.name` (rather than positional mockResolvedValueOnce calls)
// keeps each test's intent isolated: e.g. a test that wants to prove
// extractRisks fails on a truncated response can leave the scenarios and
// remaining handlers on their default "success" behavior, so the assertion
// isn't racing against unrelated failures from the other parallel call.
const FAKE_RISKS = [
  {
    title: "High coupling in core module",
    file: "src/core.ts",
    severity: "High" as const,
    confidence: "high" as const,
    why_it_matters: "Many dependents will break.",
    root_cause: "fanIn=14 means many files import this module directly.",
    evidence: "fanIn=14",
    complexity: 42,
    fanIn: 14,
    loc: 310,
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

const FAKE_SCENARIOS = [
  {
    title: "Unvalidated webhook payload crashes the ingest worker",
    trigger: "A third-party webhook sends a payload missing the expected `amount` field.",
    chain_of_failure:
      "The ingest worker reads payload.amount without a null check, throws, and the queue retries indefinitely.",
    business_impact:
      "Ingest backlog grows unbounded until manual intervention; downstream reports show stale data.",
    likelihood: "Medium" as const,
    likelihood_justification:
      "Depends on how strictly the third party validates its own payloads before sending.",
  },
];

const FAKE_SCENARIOS_TOOL_RESPONSE = {
  content: [
    {
      type: "tool_use",
      id: "tu_2",
      name: "report_scenarios",
      input: { scenarios: FAKE_SCENARIOS },
    },
  ],
  usage: { input_tokens: 80, output_tokens: 40 },
};

const DEFAULT_REMAINING_TEXT = [
  "## 1. System Summary\ncontent",
  "## 4. Refactor Plan (step-by-step)\ncontent",
  "## 5. Senior Engineer Verdict\ncontent",
].join("\n\n");

const DEFAULT_REMAINING_RESPONSE = {
  content: [{ type: "text", text: DEFAULT_REMAINING_TEXT }],
  usage: { input_tokens: 200, output_tokens: 150 },
};

const FAKE_QUALITY_CHECK_RESPONSE = {
  content: [
    {
      type: "tool_use",
      id: "tu_3",
      name: "report_quality_check",
      input: { warnings: [] },
    },
  ],
  usage: { input_tokens: 60, output_tokens: 20 },
};

type Responder = () => unknown;

// Builds a fake Anthropic client whose `messages.create` dispatches on the
// request's `tool_choice.name` to decide whether it's answering the risks
// call, the scenarios call, the (tool-less) remaining-sections call, or the
// quality-check call. Each of the four can be overridden independently, and
// each override may be stateful (e.g. a counter closure that fails once then
// succeeds) to exercise the retry loop deterministically regardless of the
// actual resolution order between the two parallel calls.
function makeFakeClient(overrides: {
  risks?: Responder;
  scenarios?: Responder;
  remaining?: Responder;
  qualityCheck?: Responder;
} = {}) {
  const risksResponder = overrides.risks ?? (() => FAKE_RISKS_TOOL_RESPONSE);
  const scenariosResponder = overrides.scenarios ?? (() => FAKE_SCENARIOS_TOOL_RESPONSE);
  const remainingResponder = overrides.remaining ?? (() => DEFAULT_REMAINING_RESPONSE);
  const qualityCheckResponder = overrides.qualityCheck ?? (() => FAKE_QUALITY_CHECK_RESPONSE);

  const create = vi.fn(async (params: any) => {
    if (params?.tool_choice?.name === "report_risks") return risksResponder();
    if (params?.tool_choice?.name === "report_scenarios") return scenariosResponder();
    if (params?.tool_choice?.name === "report_quality_check") return qualityCheckResponder();
    return remainingResponder();
  });

  return { messages: { create } };
}

const EMPTY_NAMING_CONSISTENCY = { inconsistencies: [], dominantStyleByGroup: {} };
const EMPTY_DUPLICATION = { groups: [] };
const EMPTY_DEAD_FILES = { candidates: [] };
const EMPTY_SECURITY = { secrets: [], dangerousSinks: [] };

const BASE_PACK: ContextPack = {
  mode: "top-n-detail",
  systemSummary: { fileCount: 1, totalLoc: 10 },
  topRiskFiles: [],
  graphSnapshot: [],
  clusters: [],
  namingConsistency: EMPTY_NAMING_CONSISTENCY,
  duplication: EMPTY_DUPLICATION,
  deadFiles: EMPTY_DEAD_FILES,
  security: EMPTY_SECURITY,
};

describe("generateReport", () => {
  it("calls the Claude client four times (risks + scenarios in parallel, then remaining sections, then the quality check) and returns assembled report with all sections", async () => {
    const fakeClient = makeFakeClient();

    const { report: result, risks, scenarios, qualityWarnings, usage } = await generateReport(
      fakeClient as any,
      BASE_PACK
    );
    expect(result).toContain("1. System Summary");
    expect(result).toContain("2. Top 5 Architectural Risks");
    expect(result).toContain("**Severity:** High");
    expect(result).toContain("**Root cause:**");
    expect(result).toContain("*Metrics: complexity=42, fanIn=14, loc=310*");
    expect(result).toContain("3. Production Failure Scenarios");
    expect(result).toContain("### Scenario 1:");
    expect(result).toContain("**Trigger:**");
    expect(result).toContain("**Chain of failure:**");
    expect(result).toContain("**Business impact:**");
    expect(result).toContain("**Likelihood:** Medium —");
    expect(result).toContain("4. Refactor Plan (step-by-step)");
    expect(result).toContain("5. Senior Engineer Verdict");
    // No warnings from the default fake quality-check response, so no
    // caveat block should be appended.
    expect(result).not.toContain("Automated grounding check");

    expect(fakeClient.messages.create).toHaveBeenCalledTimes(4);
    expect(risks).toEqual(FAKE_RISKS);
    expect(scenarios).toEqual(FAKE_SCENARIOS);
    expect(qualityWarnings).toEqual([]);
    expect(usage).toEqual({
      inputTokens: 100 + 80 + 200 + 60,
      outputTokens: 50 + 40 + 150 + 20,
    });
  });

  it("issues the risks and scenarios requests before the remaining-sections request, and the quality check after that (parallel pass 1, sequential passes 2 and 4)", async () => {
    const fakeClient = makeFakeClient();

    await generateReport(fakeClient as any, BASE_PACK);

    const calls = fakeClient.messages.create.mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0][0].tool_choice).toEqual({ type: "tool", name: "report_risks" });
    expect(calls[1][0].tool_choice).toEqual({ type: "tool", name: "report_scenarios" });
    expect(calls[2][0].tool_choice).toBeUndefined();
    expect(calls[3][0].tool_choice).toEqual({ type: "tool", name: "report_quality_check" });
  });

  // Regression test: the same repo (same context pack) produced different
  // "Top 5 Architectural Risks" selections between a local CLI run and a
  // GitHub Actions run, because neither Claude call set a temperature,
  // defaulting to the API's maximum-variance setting. This pins all four
  // calls to temperature 0 so the same input reliably produces the same
  // output regardless of which environment ran it.
  it("calls all four passes with temperature 0 for reproducible output", async () => {
    const fakeClient = makeFakeClient();

    await generateReport(fakeClient as any, BASE_PACK);

    const calls = fakeClient.messages.create.mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0][0]).toMatchObject({ temperature: 0 });
    expect(calls[1][0]).toMatchObject({ temperature: 0 });
    expect(calls[2][0]).toMatchObject({ temperature: 0 });
    expect(calls[3][0]).toMatchObject({ temperature: 0 });
  });

  // Regression coverage found via Archie's own self-analysis: section
  // assembly previously required an exact literal "## 3." match and fell
  // back to splitting on that same literal string if the model varied
  // heading formatting even slightly -- which broke on minor formatting
  // variation and could duplicate content if the literal string appeared
  // more than once. Section 3 is now sourced entirely from the structured
  // report_scenarios tool call, so the splice boundary this test pins is
  // now the start of "## 4." in the remaining (pass 2) text.
  it("assembles the report correctly even when heading 4 has different casing and extra whitespace", async () => {
    const remainingText = [
      "## 1. System Summary\ncontent",
      "##  4. REFACTOR PLAN (STEP-BY-STEP)\ncontent",
      "## 5. Senior Engineer Verdict\ncontent",
    ].join("\n\n");

    const fakeClient = makeFakeClient({
      remaining: () => ({
        content: [{ type: "text", text: remainingText }],
        usage: { input_tokens: 200, output_tokens: 150 },
      }),
    });

    const { report } = await generateReport(fakeClient as any, BASE_PACK);
    expect(report).toContain("1. System Summary");
    expect(report).toContain("2. Top 5 Architectural Risks");
    expect(report).toContain("3. Production Failure Scenarios");
    expect(report).toContain("REFACTOR PLAN (STEP-BY-STEP)");
    expect(report).toContain("5. Senior Engineer Verdict");
  });

  it("does not duplicate content when a heading-4-like string appears earlier in section 1 (e.g. inside a quoted example)", async () => {
    const remainingText = [
      "## 1. System Summary\nThis codebase used to split reports on the literal string \"## 4.\" which was fragile.",
      "## 4. Refactor Plan (step-by-step)\nreal content",
      "## 5. Senior Engineer Verdict\ncontent",
    ].join("\n\n");

    const fakeClient = makeFakeClient({
      remaining: () => ({
        content: [{ type: "text", text: remainingText }],
        usage: { input_tokens: 200, output_tokens: 150 },
      }),
    });

    const { report } = await generateReport(fakeClient as any, BASE_PACK);
    // The quoted mention in section 1 should appear exactly once, not
    // duplicated by an over-eager literal-string split.
    const occurrences = report.split('"## 4."').length - 1;
    expect(occurrences).toBe(1);
    expect(report).toContain("real content");
  });

  it("throws when pass 1's risks call does not return a tool_use block", async () => {
    const fakeClient = makeFakeClient({
      risks: () => ({ content: [{ type: "text", text: "incomplete response" }] }),
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(
      /report_risks tool/
    );
  });

  it("throws when pass 1's scenarios call does not return a tool_use block", async () => {
    const fakeClient = makeFakeClient({
      scenarios: () => ({ content: [{ type: "text", text: "incomplete response" }] }),
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(
      /report_scenarios tool/
    );
  });

  it("throws a clear error when the risks call's response was truncated (stop_reason: max_tokens)", async () => {
    const fakeClient = makeFakeClient({
      risks: () => ({ ...FAKE_RISKS_TOOL_RESPONSE, stop_reason: "max_tokens" }),
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(/truncated/i);
    // 3 retry attempts for the risks call + 1 successful scenarios call.
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(4);
  });

  it("throws a clear error when the scenarios call's response was truncated (stop_reason: max_tokens)", async () => {
    const fakeClient = makeFakeClient({
      scenarios: () => ({ ...FAKE_SCENARIOS_TOOL_RESPONSE, stop_reason: "max_tokens" }),
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(/truncated/i);
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(4);
  });

  it("throws a clear error instead of silently producing undefined-field risks when the risks tool call's risks field is not an array", async () => {
    // Regression test: a malformed (e.g. truncated) tool response can return
    // `risks` as something other than a well-formed array. Previously this
    // silently produced a report with thousands of "Risk N: undefined —
    // `undefined`" entries instead of failing loudly.
    const fakeClient = makeFakeClient({
      risks: () => ({
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
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(
      /malformed.*risks.*field/i
    );
  });

  it("throws a clear error instead of silently producing undefined-field scenarios when the scenarios tool call's scenarios field is not an array", async () => {
    const fakeClient = makeFakeClient({
      scenarios: () => ({
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "report_scenarios",
            input: { scenarios: "not an array, e.g. truncated raw JSON text" },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(
      /malformed.*scenarios.*field/i
    );
  });

  it("throws a clear error when a risk object is missing a required field", async () => {
    const fakeClient = makeFakeClient({
      risks: () => ({
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
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(
      /malformed risk at index 0/i
    );
  });

  it("throws a clear error when a scenario object is missing a required field", async () => {
    const fakeClient = makeFakeClient({
      scenarios: () => ({
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "report_scenarios",
            input: { scenarios: [{ title: "Missing fields" }] },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(
      /malformed scenario at index 0/i
    );
  });

  it("throws a clear error when a scenario's likelihood is not one of High/Medium/Low", async () => {
    const badScenario = { ...FAKE_SCENARIOS[0], likelihood: "Severe" };
    const fakeClient = makeFakeClient({
      scenarios: () => ({
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "report_scenarios",
            input: { scenarios: [badScenario] },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(
      /malformed scenario at index 0/i
    );
  });

  it("throws a clear error when a risk's complexity/fanIn/loc field is missing", async () => {
    const { complexity, ...riskWithoutComplexity } = FAKE_RISKS[0];
    const fakeClient = makeFakeClient({
      risks: () => ({
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "report_risks",
            input: { risks: [riskWithoutComplexity] },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(
      /malformed risk at index 0.*"complexity"/i
    );
  });

  it("throws a clear error when a risk's numeric field is the wrong type (e.g. a string instead of a number)", async () => {
    const riskWithStringComplexity = { ...FAKE_RISKS[0], complexity: "42" };
    const fakeClient = makeFakeClient({
      risks: () => ({
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "report_risks",
            input: { risks: [riskWithStringComplexity] },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(
      /malformed risk at index 0.*"complexity"/i
    );
  });

  it("retries the risks extraction after a truncated response and succeeds on a later attempt", async () => {
    let riskAttempts = 0;
    const fakeClient = makeFakeClient({
      risks: () => {
        riskAttempts += 1;
        if (riskAttempts === 1) {
          return { ...FAKE_RISKS_TOOL_RESPONSE, stop_reason: "max_tokens" };
        }
        return FAKE_RISKS_TOOL_RESPONSE;
      },
    });

    const { report } = await generateReport(fakeClient as any, BASE_PACK);
    expect(report).toContain("**Severity:** High");
    expect(riskAttempts).toBe(2);
    // 2 risks attempts + 1 scenarios call + 1 remaining call + 1 quality check call.
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(5);
  });

  it("retries the scenarios extraction after a truncated response and succeeds on a later attempt", async () => {
    let scenarioAttempts = 0;
    const fakeClient = makeFakeClient({
      scenarios: () => {
        scenarioAttempts += 1;
        if (scenarioAttempts === 1) {
          return { ...FAKE_SCENARIOS_TOOL_RESPONSE, stop_reason: "max_tokens" };
        }
        return FAKE_SCENARIOS_TOOL_RESPONSE;
      },
    });

    const { report } = await generateReport(fakeClient as any, BASE_PACK);
    expect(report).toContain("### Scenario 1:");
    expect(scenarioAttempts).toBe(2);
    // 1 risks call + 2 scenarios attempts + 1 remaining call + 1 quality check call.
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(5);
  });

  it("does not retry a non-retryable error (e.g. no tool_use block at all)", async () => {
    const fakeClient = makeFakeClient({
      risks: () => ({
        content: [{ type: "text", text: "incomplete response" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(
      /report_risks tool/
    );
    // Risks call failed fast (no retries) + the scenarios call still ran in parallel.
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(2);
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
      complexity: 10 + i,
      fanIn: i,
      loc: 100 + i * 10,
    }));

    const fakeClient = makeFakeClient({
      risks: () => ({
        content: [
          { type: "tool_use", id: "tu_1", name: "report_risks", input: { risks: manyRisks } },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });

    const { report } = await generateReport(fakeClient as any, BASE_PACK);
    expect(report.match(/^### Risk \d+:/gm)).toHaveLength(5);
  });

  it("throws when the assembled report is missing required sections", async () => {
    const fakeClient = makeFakeClient({
      remaining: () => ({ content: [{ type: "text", text: "incomplete" }] }),
    });

    await expect(generateReport(fakeClient as any, BASE_PACK)).rejects.toThrow(
      /missing required sections/
    );
  });

  it("sorts risks by severity (Critical, then High, then Medium) regardless of input order", async () => {
    const unsortedRisks = [
      {
        title: "Medium severity issue",
        file: "src/medium.ts",
        severity: "Medium" as const,
        confidence: "high" as const,
        why_it_matters: "Some impact.",
        root_cause: "Some cause.",
        evidence: "Some evidence.",
        complexity: 5,
        fanIn: 1,
        loc: 50,
      },
      {
        title: "Critical severity issue",
        file: "src/critical.ts",
        severity: "Critical" as const,
        confidence: "high" as const,
        why_it_matters: "Severe impact.",
        root_cause: "Severe cause.",
        evidence: "Severe evidence.",
        complexity: 30,
        fanIn: 20,
        loc: 500,
      },
      {
        title: "High severity issue",
        file: "src/high.ts",
        severity: "High" as const,
        confidence: "high" as const,
        why_it_matters: "Notable impact.",
        root_cause: "Notable cause.",
        evidence: "Notable evidence.",
        complexity: 15,
        fanIn: 8,
        loc: 200,
      },
    ];

    const fakeClient = makeFakeClient({
      risks: () => ({
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "report_risks",
            input: { risks: unsortedRisks },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });

    const { report: result } = await generateReport(fakeClient as any, BASE_PACK);
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
    const risks = [
      {
        title: "Low confidence issue",
        file: "src/lowconf.ts",
        severity: "Medium" as const,
        confidence: "low" as const,
        why_it_matters: "Some impact.",
        root_cause: "Some cause.",
        evidence: "Some evidence.",
        complexity: 5,
        fanIn: 1,
        loc: 50,
      },
      {
        title: "High confidence issue",
        file: "src/highconf.ts",
        severity: "High" as const,
        confidence: "high" as const,
        why_it_matters: "Notable impact.",
        root_cause: "Notable cause.",
        evidence: "Notable evidence.",
        complexity: 15,
        fanIn: 8,
        loc: 200,
      },
    ];

    const fakeClient = makeFakeClient({
      risks: () => ({
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "report_risks",
            input: { risks },
          },
        ],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    });

    const { report: result } = await generateReport(fakeClient as any, BASE_PACK);
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
    const fakeClient = makeFakeClient();

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
          exportedSymbols: [],
          testCaseCount: 0,
          hasTestAssertions: false,
          magicNumbers: [],
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
          exportedSymbols: [],
          testCaseCount: 0,
          hasTestAssertions: false,
          magicNumbers: [],
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
          exportedSymbols: [],
          testCaseCount: 0,
          hasTestAssertions: false,
          magicNumbers: [],
        },
      ],
      graphSnapshot: [],
      clusters: [],
      namingConsistency: EMPTY_NAMING_CONSISTENCY,
      duplication: EMPTY_DUPLICATION,
      deadFiles: EMPTY_DEAD_FILES,
      security: EMPTY_SECURITY,
    };

    const { report: result } = await generateReport(fakeClient as any, pack);
    expect(result).toContain("**Scope of this analysis:**");
    expect(result).toContain("analyzed all 20 files");
    expect(result).toContain("examined the top 3 in detail");
  });

  it("includes cluster-specific scope wording for a cluster-summary pack", async () => {
    const fakeClient = makeFakeClient();

    const pack: ContextPack = {
      mode: "cluster-summary",
      systemSummary: { fileCount: 500, totalLoc: 50000 },
      topRiskFiles: [],
      graphSnapshot: [],
      clusters: [{ fileCount: 500, averageComplexity: 5, maxRiskScore: 0.95 }],
      namingConsistency: EMPTY_NAMING_CONSISTENCY,
      duplication: EMPTY_DUPLICATION,
      deadFiles: EMPTY_DEAD_FILES,
      security: EMPTY_SECURITY,
    };

    const { report: result } = await generateReport(fakeClient as any, pack);
    expect(result).toContain("**Scope of this analysis:**");
    expect(result.toLowerCase()).toMatch(/coarse|cluster-level/);
  });

  it("uses 'all N files' wording when every file was analyzed in detail", async () => {
    const fakeClient = makeFakeClient();

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
          exportedSymbols: [],
          testCaseCount: 0,
          hasTestAssertions: false,
          magicNumbers: [],
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
          exportedSymbols: [],
          testCaseCount: 0,
          hasTestAssertions: false,
          magicNumbers: [],
        },
      ],
      graphSnapshot: [],
      clusters: [],
      namingConsistency: EMPTY_NAMING_CONSISTENCY,
      duplication: EMPTY_DUPLICATION,
      deadFiles: EMPTY_DEAD_FILES,
      security: EMPTY_SECURITY,
    };

    const { report: result } = await generateReport(fakeClient as any, pack);
    expect(result).toContain("**Scope of this analysis:** Archie analyzed all 2 files in this repository in detail.");
    expect(result).not.toContain("were not individually assessed");
  });
});

describe("generateReport quality check (pass 4)", () => {
  it("appends no caveat block when the quality check returns an empty warnings array", async () => {
    const fakeClient = makeFakeClient({
      qualityCheck: () => ({
        content: [
          { type: "tool_use", id: "tu_3", name: "report_quality_check", input: { warnings: [] } },
        ],
        usage: { input_tokens: 60, output_tokens: 20 },
      }),
    });

    const { report, qualityWarnings } = await generateReport(fakeClient as any, BASE_PACK);
    expect(qualityWarnings).toEqual([]);
    expect(report).not.toContain("Automated grounding check");
    expect(report).not.toContain("⚠️");
    expect(fakeClient.messages.create).toHaveBeenCalledTimes(4);
  });

  it("passes the assembled Section 1/4/5 text and the Context Pack to the quality-check call, forcing the report_quality_check tool", async () => {
    const fakeClient = makeFakeClient();

    await generateReport(fakeClient as any, BASE_PACK);

    const calls = fakeClient.messages.create.mock.calls;
    const qualityCall = calls[3][0];
    expect(qualityCall.tool_choice).toEqual({ type: "tool", name: "report_quality_check" });
    expect(qualityCall.tools).toHaveLength(1);
    expect(qualityCall.tools[0].name).toBe("report_quality_check");
    expect(qualityCall.messages[0].content).toContain(DEFAULT_REMAINING_TEXT);
  });

  it("appends a correctly formatted caveat block right after the scope statement, before the risks section, when the quality check finds real issues", async () => {
    const fakeClient = makeFakeClient({
      qualityCheck: () => ({
        content: [
          {
            type: "tool_use",
            id: "tu_3",
            name: "report_quality_check",
            input: {
              warnings: [
                {
                  section: "1. System Summary",
                  claim: "Next.js 15",
                  issue: "dependencies field shows 16.2.2, not 15",
                },
                {
                  section: "5. Senior Engineer Verdict",
                  claim: "the exported `foo` function",
                  issue: "`foo` is not in exportedSymbols for this file",
                },
              ],
            },
          },
        ],
        usage: { input_tokens: 60, output_tokens: 20 },
      }),
    });

    const { report, qualityWarnings } = await generateReport(fakeClient as any, BASE_PACK);
    expect(qualityWarnings).toHaveLength(2);
    expect(report).toContain(
      "> ⚠️ **Automated grounding check flagged 2 potential issue(s) in this report:**"
    );
    expect(report).toContain(
      '> - [Section 1. System Summary] "Next.js 15" — dependencies field shows 16.2.2, not 15'
    );
    expect(report).toContain(
      '> - [Section 5. Senior Engineer Verdict] "the exported `foo` function" — `foo` is not in exportedSymbols for this file'
    );

    // Positioning: the caveat block must land after the scope statement and
    // before the risks section.
    const scopeIndex = report.indexOf("**Scope of this analysis:**");
    const caveatIndex = report.indexOf("Automated grounding check");
    const risksIndex = report.indexOf("## 2. Top 5 Architectural Risks");
    expect(scopeIndex).toBeGreaterThan(-1);
    expect(caveatIndex).toBeGreaterThan(scopeIndex);
    expect(risksIndex).toBeGreaterThan(caveatIndex);
  });

  it("fails open with an empty warnings array (rather than propagating a throw) when the warnings field is not an array", async () => {
    const fakeClient = makeFakeClient({
      qualityCheck: () => ({
        content: [
          {
            type: "tool_use",
            id: "tu_3",
            name: "report_quality_check",
            input: { warnings: "not an array, e.g. truncated raw JSON text" },
          },
        ],
        usage: { input_tokens: 60, output_tokens: 20 },
      }),
    });

    // Structurally malformed, not merely empty -- this pass still fails open
    // rather than throwing out of generateReport (see resilience test below),
    // so the report succeeds with qualityWarnings === [] rather than
    // rejecting.
    const { qualityWarnings } = await generateReport(fakeClient as any, BASE_PACK);
    expect(qualityWarnings).toEqual([]);
  });

  it("fails open with an empty warnings array when a warning entry is not an object (retries exhausted, non-throwing)", async () => {
    let attempts = 0;
    const fakeClient = makeFakeClient({
      qualityCheck: () => {
        attempts += 1;
        return {
          content: [
            {
              type: "tool_use",
              id: "tu_3",
              name: "report_quality_check",
              input: { warnings: ["not an object"] },
            },
          ],
          usage: { input_tokens: 60, output_tokens: 20 },
        };
      },
    });

    const { qualityWarnings } = await generateReport(fakeClient as any, BASE_PACK);
    // validateQualityWarnings rejects this every attempt, but the error is
    // non-retryable (doesn't match /truncated|malformed/... wait it does
    // match "malformed"), so it retries MAX_RISK_EXTRACTION_ATTEMPTS times,
    // then fails open.
    expect(attempts).toBe(3);
    expect(qualityWarnings).toEqual([]);
  });

  it("fails open with an empty warnings array when a warning is missing a required field (retries exhausted, non-throwing)", async () => {
    const fakeClient = makeFakeClient({
      qualityCheck: () => ({
        content: [
          {
            type: "tool_use",
            id: "tu_3",
            name: "report_quality_check",
            input: { warnings: [{ section: "1. System Summary", claim: "" }] },
          },
        ],
        usage: { input_tokens: 60, output_tokens: 20 },
      }),
    });

    const { qualityWarnings } = await generateReport(fakeClient as any, BASE_PACK);
    expect(qualityWarnings).toEqual([]);
  });

  it("does not throw or abort the report when the quality check pass fails after all retries -- it fails open with an empty warnings array", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fakeClient = makeFakeClient({
        qualityCheck: () => ({
          content: [{ type: "text", text: "no tool_use here" }],
          usage: { input_tokens: 60, output_tokens: 20 },
        }),
      });

      const { report, risks, scenarios, qualityWarnings } = await generateReport(
        fakeClient as any,
        BASE_PACK
      );

      // The report itself must still succeed, with all its other content intact.
      expect(report).toContain("1. System Summary");
      expect(report).toContain("2. Top 5 Architectural Risks");
      expect(risks).toEqual(FAKE_RISKS);
      expect(scenarios).toEqual(FAKE_SCENARIOS);
      expect(qualityWarnings).toEqual([]);
      expect(report).not.toContain("Automated grounding check");
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[archie]")
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("retries the quality check after a truncated response and succeeds on a later attempt", async () => {
    let qualityAttempts = 0;
    const fakeClient = makeFakeClient({
      qualityCheck: () => {
        qualityAttempts += 1;
        if (qualityAttempts === 1) {
          return { ...FAKE_QUALITY_CHECK_RESPONSE, stop_reason: "max_tokens" };
        }
        return FAKE_QUALITY_CHECK_RESPONSE;
      },
    });

    const { qualityWarnings } = await generateReport(fakeClient as any, BASE_PACK);
    expect(qualityWarnings).toEqual([]);
    expect(qualityAttempts).toBe(2);
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

  it("is included in the system prompt sent to Claude for the scenarios extraction call", async () => {
    const fakeClient = makeFakeClient();

    await generateReport(fakeClient as any, BASE_PACK);

    const calls = fakeClient.messages.create.mock.calls;
    expect(calls[1][0].system).toContain("do NOT assert that a specific untrusted");
  });
});

// Regression coverage for a bug found on a real report: the System Summary
// claimed "Next.js 14" for a target repo whose actual package.json said
// "next": "16.2.2" -- the LLM was inferring a version from file-structure
// conventions rather than reading the manifest, because nothing in the
// prompt required otherwise and package.json was never even parsed.
describe("DEPENDENCY_GROUNDING_RULE", () => {
  it("forbids inferring or guessing a framework version instead of quoting it from the dependencies field", () => {
    expect(DEPENDENCY_GROUNDING_RULE).toMatch(/dependencies/);
    expect(DEPENDENCY_GROUNDING_RULE.toLowerCase()).toMatch(/do not guess or infer/);
  });

  it("is included in the system prompt sent to Claude for all three passes", async () => {
    const fakeClient = makeFakeClient();

    const pack: ContextPack = {
      ...BASE_PACK,
      dependencies: { next: "16.2.2" },
    };

    await generateReport(fakeClient as any, pack);

    const calls = fakeClient.messages.create.mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0][0].system).toContain("Do not guess or infer");
    expect(calls[1][0].system).toContain("Do not guess or infer");
    expect(calls[2][0].system).toContain("Do not guess or infer");
    expect(calls[3][0].system).toContain("Do not guess or infer");
    // The dependencies map itself is serialized into both pass-1 user
    // messages (the Context Pack JSON), so the actual version string
    // reaches the model for both the risks and scenarios calls.
    expect(calls[0][0].messages[0].content).toContain("16.2.2");
    expect(calls[1][0].messages[0].content).toContain("16.2.2");
  });
});

// Regression coverage for a false claim found on a real report: Archie named
// four private, module-internal helper functions as part of a file's
// exported API (claiming "13 exported functions") and told a refactor step
// to modify those private helpers directly -- the real fix boundary was the
// actual exported function that calls them.
describe("EXPORT_GROUNDING_RULE", () => {
  it("forbids counting or naming a symbol as exported unless it appears in exportedSymbols", () => {
    expect(EXPORT_GROUNDING_RULE).toMatch(/exportedSymbols/);
    expect(EXPORT_GROUNDING_RULE.toLowerCase()).toMatch(/private, module-internal/);
  });

  it("is included in the system prompt sent to Claude for all three passes", async () => {
    const fakeClient = makeFakeClient();

    await generateReport(fakeClient as any, BASE_PACK);

    const calls = fakeClient.messages.create.mock.calls;
    expect(calls[0][0].system).toContain("private, module-internal");
    expect(calls[1][0].system).toContain("private, module-internal");
    expect(calls[2][0].system).toContain("private, module-internal");
    expect(calls[3][0].system).toContain("private, module-internal");
  });
});

// Required test #6: the System Summary prompt must not instruct the model to
// fabricate a naming-consistency compliment when namingConsistency.inconsistencies
// is empty. SYSTEM_PROMPT is a static string (the actual pack data is only
// interpolated into the user message at call time), so this is verified by
// inspecting the rule text itself -- the same direct-string-assertion approach
// already used for ABSENCE_CLAIM_RULE/DEPENDENCY_GROUNDING_RULE/EXPORT_GROUNDING_RULE
// above, not a full red-green cycle against a real LLM call.
describe("NAMING_CONSISTENCY_RULE", () => {
  it("instructs the model to cite a real example from namingConsistency.inconsistencies when non-empty", () => {
    expect(NAMING_CONSISTENCY_RULE).toMatch(/namingConsistency/);
    expect(NAMING_CONSISTENCY_RULE.toLowerCase()).toMatch(/inconsistencies/);
  });

  it("forbids manufacturing a naming-consistency compliment when the inconsistencies array is empty", () => {
    expect(NAMING_CONSISTENCY_RULE.toLowerCase()).toMatch(/is empty/);
    expect(NAMING_CONSISTENCY_RULE.toLowerCase()).toMatch(/fabrication/);
  });

  it("is included in the system prompt sent to Claude for all four passes", async () => {
    const fakeClient = makeFakeClient();

    await generateReport(fakeClient as any, BASE_PACK);

    const calls = fakeClient.messages.create.mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0][0].system).toContain("namingConsistency.inconsistencies");
    expect(calls[1][0].system).toContain("namingConsistency.inconsistencies");
    expect(calls[2][0].system).toContain("namingConsistency.inconsistencies");
    expect(calls[3][0].system).toContain("namingConsistency.inconsistencies");
  });
});

// Required test #6: same direct-string-assertion approach as
// NAMING_CONSISTENCY_RULE above, for the three new wave-3 grounding rules
// (magic numbers, duplication, dead files). Each rule must name its field,
// mention the empty-array case, and end on the fabrication-framing language
// this file's grounding rules consistently use.
describe("MAGIC_NUMBER_GROUNDING_RULE", () => {
  it("instructs the model to only cite a magic number that's actually in that file's magicNumbers array", () => {
    expect(MAGIC_NUMBER_GROUNDING_RULE).toMatch(/magicNumbers/);
  });

  it("forbids saying anything about magic numbers for a file whose magicNumbers array is empty", () => {
    expect(MAGIC_NUMBER_GROUNDING_RULE.toLowerCase()).toMatch(/is empty/);
    expect(MAGIC_NUMBER_GROUNDING_RULE.toLowerCase()).toMatch(/fabrication/);
  });

  it("is included in the system prompt sent to Claude for all four passes", async () => {
    const fakeClient = makeFakeClient();

    await generateReport(fakeClient as any, BASE_PACK);

    const calls = fakeClient.messages.create.mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0][0].system).toContain("magicNumbers");
    expect(calls[1][0].system).toContain("magicNumbers");
    expect(calls[2][0].system).toContain("magicNumbers");
    expect(calls[3][0].system).toContain("magicNumbers");
  });
});

describe("DUPLICATION_GROUNDING_RULE", () => {
  it("instructs the model to only claim duplication when two files/functions appear together in the same duplication.groups entry", () => {
    expect(DUPLICATION_GROUNDING_RULE).toMatch(/duplication\.groups/);
  });

  it("forbids saying anything about cross-file duplication when duplication.groups is empty", () => {
    expect(DUPLICATION_GROUNDING_RULE.toLowerCase()).toMatch(/is empty/);
    expect(DUPLICATION_GROUNDING_RULE.toLowerCase()).toMatch(/fabrication/);
  });

  it("is included in the system prompt sent to Claude for all four passes", async () => {
    const fakeClient = makeFakeClient();

    await generateReport(fakeClient as any, BASE_PACK);

    const calls = fakeClient.messages.create.mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0][0].system).toContain("duplication.groups");
    expect(calls[1][0].system).toContain("duplication.groups");
    expect(calls[2][0].system).toContain("duplication.groups");
    expect(calls[3][0].system).toContain("duplication.groups");
  });
});

describe("DEAD_FILE_GROUNDING_RULE", () => {
  it("instructs the model to only call a file possibly dead code when it's in deadFiles.candidates", () => {
    expect(DEAD_FILE_GROUNDING_RULE).toMatch(/deadFiles\.candidates/);
  });

  it("forbids saying anything about dead code when deadFiles.candidates is empty", () => {
    expect(DEAD_FILE_GROUNDING_RULE.toLowerCase()).toMatch(/is empty/);
    expect(DEAD_FILE_GROUNDING_RULE.toLowerCase()).toMatch(/fabrication/);
  });

  it("is included in the system prompt sent to Claude for all four passes", async () => {
    const fakeClient = makeFakeClient();

    await generateReport(fakeClient as any, BASE_PACK);

    const calls = fakeClient.messages.create.mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0][0].system).toContain("deadFiles.candidates");
    expect(calls[1][0].system).toContain("deadFiles.candidates");
    expect(calls[2][0].system).toContain("deadFiles.candidates");
    expect(calls[3][0].system).toContain("deadFiles.candidates");
  });
});

// Required test (Wave 2): mirrors NAMING_CONSISTENCY_RULE/DUPLICATION_GROUNDING_RULE/
// DEAD_FILE_GROUNDING_RULE's direct-string-assertion tests above, plus two
// assertions specific to this rule: (1) it must explicitly forbid inventing,
// guessing, or reconstructing a secret's actual value (the hard safety
// constraint carried over from src/security.ts's SecretFinding shape), and
// (2) it must state the Critical-severity escalation for Section 2 -- unlike
// every other whole-codebase rule, a non-empty finding here is not optional
// System Summary color, it's a mandatory Section 2 entry.
describe("SECURITY_GROUNDING_RULE", () => {
  it("instructs the model to describe a security finding only by ruleId and location", () => {
    expect(SECURITY_GROUNDING_RULE).toMatch(/security\.secrets/);
    expect(SECURITY_GROUNDING_RULE).toMatch(/security\.dangerousSinks/);
    expect(SECURITY_GROUNDING_RULE.toLowerCase()).toMatch(/ruleid/);
  });

  it("explicitly forbids inventing, guessing, or reconstructing a secret's actual value", () => {
    expect(SECURITY_GROUNDING_RULE.toLowerCase()).toMatch(/never (invent|guess|reconstruct)/);
  });

  it("forbids saying anything about secrets or dangerous sinks when both arrays are empty", () => {
    expect(SECURITY_GROUNDING_RULE.toLowerCase()).toMatch(/is empty/);
    expect(SECURITY_GROUNDING_RULE.toLowerCase()).toMatch(/fabrication/);
  });

  it("requires escalating a non-empty finding to a Critical-severity risk in Section 2, even outside topRiskFiles", () => {
    expect(SECURITY_GROUNDING_RULE).toMatch(/Critical/);
    expect(SECURITY_GROUNDING_RULE.toLowerCase()).toMatch(/topriskfiles/);
  });

  it("is included in the system prompt sent to Claude for all four passes", async () => {
    const fakeClient = makeFakeClient();

    await generateReport(fakeClient as any, BASE_PACK);

    const calls = fakeClient.messages.create.mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0][0].system).toContain("security.secrets");
    expect(calls[1][0].system).toContain("security.secrets");
    expect(calls[2][0].system).toContain("security.secrets");
    expect(calls[3][0].system).toContain("security.secrets");
  });

  // The escalation instruction must appear in BOTH the grounding rule AND
  // Section 2's own prompt prose -- same pattern this codebase already used
  // for the namingConsistency mention in Section 1 (see NAMING_CONSISTENCY_RULE's
  // own test above). This checks for wording specific to Section 2's inline
  // instruction, distinct from the grounding rule's own phrasing, so this
  // test can't pass merely because the grounding rule text is present.
  // Section 2's prose lives only in SYSTEM_PROMPT itself (calls[0]=risks,
  // calls[1]=scenarios, calls[2]=remaining sections all use it) -- unlike
  // the other three, QUALITY_CHECK_SYSTEM_PROMPT (calls[3]) deliberately
  // audits only Sections 1/4/5, never Section 2, so it never carries
  // Section 2's own inline prose and is correctly excluded from this check.
  it("also states the Critical-severity escalation instruction directly in Section 2's own prompt text", async () => {
    const fakeClient = makeFakeClient();

    await generateReport(fakeClient as any, BASE_PACK);

    const calls = fakeClient.messages.create.mock.calls;
    expect(calls).toHaveLength(4);
    for (let i = 0; i < 3; i++) {
      expect(calls[i][0].system).toContain("report at least one Critical severity risk here");
    }
  });
});

// Regression coverage for a second bug on the same report: a refactor step
// told Claude Code to build a brand-new TabErrorBoundary class from scratch
// when a generic, reusable ErrorBoundary already existed elsewhere in the
// repo and was already used by two other files -- because Archie only sees
// the top-risk files, not the whole repo, so it can't know a matching
// component already exists.
describe("cross-cutting-concern reuse instruction", () => {
  it("instructs refactor steps to search for an existing implementation before building a new component for a cross-cutting concern", async () => {
    const fakeClient = makeFakeClient();

    await generateReport(fakeClient as any, BASE_PACK);

    // The refactor plan (section 4) is written by the remaining-sections
    // call, which is now the third call (index 2) since sections 2 and 3
    // are each generated by their own structured tool call ahead of it.
    const calls = fakeClient.messages.create.mock.calls;
    expect(calls[2][0].system.toLowerCase()).toMatch(/error boundary/);
    expect(calls[2][0].system.toLowerCase()).toMatch(/search the codebase for an existing implementation/);
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

  // Regression coverage found via Archie's own self-analysis: max_tokens was
  // a fixed 4096 while the simplified summary must translate every risk,
  // scenario, and refactor step in the input -- so output size scales with
  // the technical report instead of staying roughly constant, making
  // truncation more likely as reports grow. This pins that the budget now
  // scales with input size, within a sane floor and ceiling.
  it("scales max_tokens with the size of the technical report, within a floor and ceiling", async () => {
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

    const smallReport = "## 1. System Summary\nshort report";
    await generateSimplifiedSummary(fakeClient as any, smallReport);
    expect(fakeClient.messages.create.mock.calls[0][0]).toMatchObject({ max_tokens: 4096 });

    const hugeReport = "## 1. System Summary\n" + "x".repeat(40000);
    await generateSimplifiedSummary(fakeClient as any, hugeReport);
    expect(fakeClient.messages.create.mock.calls[1][0]).toMatchObject({ max_tokens: 8192 });
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
