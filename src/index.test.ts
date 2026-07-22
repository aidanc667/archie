// src/index.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runPipeline, buildSecurityReport } from "./index.js";
import { findDuplicateGroups } from "./duplication.js";
import { computeDeadFiles } from "./deadcode.js";
import { detectHardcodedSecrets } from "./security.js";
import type { CodeGraph } from "./types.js";

const REQUIRED_HEADINGS = [
  "1. System Summary",
  "2. Top 5 Architectural Risks",
  "3. Production Failure Scenarios",
  "4. Refactor Plan (step-by-step)",
  "5. Senior Engineer Verdict",
];

// The remaining-sections text returned by Pass 2 (no section 2 or 3 — both
// are injected from structured data: risks from report_risks, scenarios
// from report_scenarios).
const REMAINING_SECTIONS_TEXT = [
  "## 1. System Summary\nsome content",
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
            complexity: 42,
            fanIn: 14,
            loc: 310,
          },
        ],
      },
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
};

const FAKE_SCENARIOS_TOOL_RESPONSE = {
  content: [
    {
      type: "tool_use",
      id: "tu_2",
      name: "report_scenarios",
      input: {
        scenarios: [
          {
            title: "Unvalidated payload crashes the worker",
            trigger: "A malformed payload is sent to the ingest endpoint.",
            chain_of_failure: "The worker reads a missing field and throws, retrying indefinitely.",
            business_impact: "Ingest backlog grows unbounded.",
            likelihood: "Medium",
            likelihood_justification: "Depends on upstream payload validation.",
          },
        ],
      },
    },
  ],
  usage: { input_tokens: 80, output_tokens: 40 },
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

const SIMPLIFIED_SUMMARY_TEXT =
  "# What This System Does\n\nThis tool checks code quality.\n\n# Bottom Line\n\nWorks fine, some cleanup needed and this sentence pads it past the minimum length requirement.";

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi
          .fn()
          .mockImplementation(
            ({
              system,
              tool_choice,
            }: {
              system: string;
              tools?: unknown[];
              tool_choice?: { name?: string };
            }) => {
              if (tool_choice?.name === "report_risks") {
                // Pass 1: structured risks
                return Promise.resolve(FAKE_RISKS_TOOL_RESPONSE);
              }
              if (tool_choice?.name === "report_scenarios") {
                // Pass 1: structured scenarios (runs in parallel with risks)
                return Promise.resolve(FAKE_SCENARIOS_TOOL_RESPONSE);
              }
              if (tool_choice?.name === "report_quality_check") {
                // Pass 4: detection-only grounding check on sections 1/4/5
                return Promise.resolve(FAKE_QUALITY_CHECK_RESPONSE);
              }
              if (system.includes("Staff Engineer")) {
                // Pass 2: remaining sections (1, 4, 5)
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
            }
          ),
      },
    })),
  };
});

// Required test (Wave 2): buildSecurityReport is a pure aggregation function
// over a CodeGraph + per-file source map, unit-tested directly (not just
// through the full runPipeline) because a hand-constructed graph node can
// exercise the "no dangerousSinks field at all" case that a real parsed
// FileNode never produces (parser.ts always sets dangerousSinks to a real
// array, even an empty one, for any file it actually parses). Mirrors the
// fail-open convention this codebase already uses for magicNumbers
// (`?? []`), never crashing on an older-shaped or hand-built FileNode.
describe("buildSecurityReport", () => {
  it("aggregates every file's FileNode.dangerousSinks, treating a missing field as [] rather than crashing", () => {
    const graph: CodeGraph = {
      nodes: [
        {
          kind: "file",
          id: "file:a.ts",
          path: "a.ts",
          loc: 10,
          dangerousSinks: [{ sink: "eval", line: 3, hasDynamicArgument: true }],
        },
        { kind: "file", id: "file:b.ts", path: "b.ts", loc: 10 }, // no dangerousSinks field at all
      ],
      edges: [],
    };

    const security = buildSecurityReport(graph, new Map());

    expect(security.dangerousSinks).toEqual([
      { file: "a.ts", line: 3, ruleId: "eval", hasDynamicArgument: true },
    ]);
  });

  it("computes security.secrets by running detectHardcodedSecrets against each file's own source", () => {
    const source = 'const awsKey = "AKIAIOSFODNN7EXAMPLE";';
    const graph: CodeGraph = {
      nodes: [{ kind: "file", id: "file:a.ts", path: "a.ts", loc: 1 }],
      edges: [],
    };
    const sourceByPath = new Map<string, string>([["file:a.ts", source]]);

    const security = buildSecurityReport(graph, sourceByPath);

    const expected = detectHardcodedSecrets(source).map((finding) => ({
      file: "a.ts",
      ...finding,
    }));
    expect(security.secrets).toEqual(expected);
    expect(security.secrets.length).toBeGreaterThan(0); // sanity: this fixture actually has one
  });

  it("returns [] for both fields on a graph with no file nodes", () => {
    const security = buildSecurityReport({ nodes: [], edges: [] }, new Map());
    expect(security).toEqual({ secrets: [], dangerousSinks: [] });
  });
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
    // generateSimplifiedSummary now deterministically splices in the scope
    // statement already present in `result.report` — SIMPLIFIED_SUMMARY_TEXT
    // has no "---" separator, so it lands prepended rather than mid-document.
    expect(result.simplifiedSummary).toContain(SIMPLIFIED_SUMMARY_TEXT);
    expect(result.simplifiedSummary).toMatch(/^\*Scope: .+analyzed.+\*/);
  });

  // Regression coverage: generateReport's structured risks/scenarios (not
  // just the rendered markdown) must flow all the way through runPipeline's
  // return value, so consumers like scripts/post-pr-comment.mjs can read
  // per-risk file/severity/metrics without re-parsing the report string.
  it("threads the structured risks and scenarios from generateReport through to PipelineResult", async () => {
    const repoPath = path.resolve("fixtures/parser-basic");
    const result = await runPipeline({
      repoPath,
      topN: 5,
      maxTokens: 50000,
      generatePdf: false,
    });

    expect(result.risks).toEqual(FAKE_RISKS_TOOL_RESPONSE.content[0].input.risks);
    expect(result.scenarios).toEqual(FAKE_SCENARIOS_TOOL_RESPONSE.content[0].input.scenarios);
  });

  // Regression coverage: generateReport's 4th pass (a detection-only
  // grounding check over Sections 1/4/5) must also thread its findings
  // through to PipelineResult, so consumers can see flagged ungrounded
  // claims without re-parsing the report markdown for the caveat block.
  it("threads qualityWarnings from generateReport through to PipelineResult", async () => {
    const repoPath = path.resolve("fixtures/parser-basic");
    const result = await runPipeline({
      repoPath,
      topN: 5,
      maxTokens: 50000,
      generatePdf: false,
    });

    expect(result.qualityWarnings).toEqual([]);
  });

  // Required test #5: PipelineResult.namingConsistency must be populated by
  // runPipeline -- a whole-codebase signal computed once from the graph, not
  // dependent on generatePdf or any other option.
  it("populates result.namingConsistency with a well-formed report", async () => {
    const repoPath = path.resolve("fixtures/parser-basic");
    const result = await runPipeline({
      repoPath,
      topN: 5,
      maxTokens: 50000,
      generatePdf: false,
    });

    expect(result.namingConsistency).toBeDefined();
    expect(Array.isArray(result.namingConsistency.inconsistencies)).toBe(true);
    expect(typeof result.namingConsistency.dominantStyleByGroup).toBe("object");
  });

  // Required test #4: PipelineResult.duplication/.deadFiles must be populated
  // by runPipeline directly from the graph, same shape as
  // findDuplicateGroups/computeDeadFiles's own return types -- whole-codebase
  // signals computed once, independent of generatePdf or any other option.
  it("populates result.duplication and result.deadFiles from the graph, matching findDuplicateGroups/computeDeadFiles", async () => {
    const repoPath = path.resolve("fixtures/parser-basic");
    const result = await runPipeline({
      repoPath,
      topN: 5,
      maxTokens: 50000,
      generatePdf: false,
    });

    expect(result.duplication).toEqual(findDuplicateGroups(result.graph));
    expect(result.deadFiles).toEqual(computeDeadFiles(result.graph));
  });

  // Required test (Wave 2): PipelineResult.security must be populated by
  // runPipeline directly from the graph and per-file source, same shape
  // buildSecurityReport itself produces -- a whole-codebase signal computed
  // once, independent of generatePdf or any other option. fixtures/security
  // is Wave 1's dedicated fixture directory (secrets.ts/py/go, sinks.ts/py/go)
  // built specifically to exercise both detectors across all three languages.
  it("populates result.security from the graph and source, matching buildSecurityReport's own output", async () => {
    const repoPath = path.resolve("fixtures/security");
    const result = await runPipeline({
      repoPath,
      topN: 5,
      maxTokens: 50000,
      generatePdf: false,
    });

    expect(result.security.dangerousSinks.length).toBeGreaterThan(0);
    expect(result.security.secrets.length).toBeGreaterThan(0);

    // Recompute independently from the graph's own FileNode.dangerousSinks
    // fields to confirm runPipeline's aggregation isn't dropping or
    // duplicating anything.
    const expectedDangerousSinks = result.graph.nodes
      .filter((n): n is Extract<typeof n, { kind: "file" }> => n.kind === "file")
      .flatMap((n) =>
        (n.dangerousSinks ?? []).map((s) => ({
          file: n.path,
          line: s.line,
          ruleId: s.sink,
          hasDynamicArgument: s.hasDynamicArgument,
        }))
      );
    expect(result.security.dangerousSinks).toEqual(expectedDangerousSinks);
  });

  // Required test (Wave 2) -- the most important test in this whole task: a
  // planted, real-shaped fake secret (fixtures/security/secrets.ts's AWS-style
  // key and generic-secret-assignment value) must NEVER appear anywhere in
  // the serialized PipelineResult, because SecurityFinding is {file, line,
  // ruleId} only -- never the matched text. Archie's report is posted as a
  // public/org-visible GitHub comment; if either planted value leaked through
  // any field (report text, risks, security findings, anywhere), that would
  // be a real, shipped secret leak, not just a failed assertion.
  it("never leaks the planted fixture secret's actual text anywhere in the pipeline result", async () => {
    const repoPath = path.resolve("fixtures/security");
    const result = await runPipeline({
      repoPath,
      topN: 5,
      maxTokens: 50000,
      generatePdf: false,
    });

    // Sanity: the detector actually found something to potentially leak --
    // otherwise this test would trivially pass for the wrong reason.
    expect(result.security.secrets.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(serialized).not.toContain("sk-test-abcdefghijklmnopqrstuvwxyz");
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

  // Regression coverage: the top-N coverage tradeoff was previously
  // disclosed nowhere except a sentence buried inside the generated report
  // itself, which a user could easily miss entirely -- leading to exactly
  // the "this isn't analyzing my codebase fully" impression that's actually
  // a disclosed, deliberate token-budget tradeoff. result.scope surfaces the
  // same numbers as structured data so the CLI can print them unconditionally.
  it("populates result.scope with the actual file counts and mode used", async () => {
    const repoPath = path.resolve("fixtures/parser-basic");
    const result = await runPipeline({
      repoPath,
      topN: 5,
      maxTokens: 50000,
      generatePdf: false,
    });

    expect(result.scope.mode).toBe("top-n-detail");
    expect(result.scope.totalFiles).toBeGreaterThan(0);
    expect(result.scope.detailedFiles).toBeLessThanOrEqual(result.scope.totalFiles);
  });

  it("reports cluster-summary mode in result.scope when the repo exceeds the token budget", async () => {
    const repoPath = path.resolve("fixtures/parser-basic");
    const result = await runPipeline({
      repoPath,
      topN: 5,
      maxTokens: 1,
      generatePdf: false,
    });

    expect(result.scope.mode).toBe("cluster-summary");
    expect(result.scope.detailedFiles).toBe(0);
  });

  // Regression coverage for a real, verified bug: diff-scoping (--topN
  // combined with filterFiles from --diff) used to restrict which files were
  // even PARSED, not just which were eligible for detailed review. That
  // meant a changed file's fan-in silently came out as 0 whenever its real
  // importers/dependents lived outside the diff -- a file depended on by
  // many others could score as if nothing used it, purely because of how a
  // PR happened to be scoped. Reproduced with a real fixture: shared.ts has
  // a genuine fan-in of 2 (a.ts and c.ts both import it), and a diff that
  // only touches shared.ts must still see fan-in=2, not 0.
  it("computes correct fan-in for a diff-scoped file even when its importers are outside the diff", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archie-diff-fanin-test-"));
    try {
      await writeFile(path.join(root, "shared.ts"), "export function shared() { return 1; }");
      await writeFile(path.join(root, "a.ts"), 'import { shared } from "./shared"; export const a = shared();');
      await writeFile(path.join(root, "c.ts"), 'import { shared } from "./shared"; export const c = shared();');

      const result = await runPipeline({
        repoPath: root,
        topN: 5,
        maxTokens: 50000,
        generatePdf: false,
        filterFiles: [path.join(root, "shared.ts")],
      });

      // The graph must still be the whole repo -- all 3 files, all 2 real
      // IMPORTS edges into shared.ts -- even though only shared.ts was
      // eligible for the top-N detailed review slot.
      const fileNodes = result.graph.nodes.filter((n) => n.kind === "file");
      expect(fileNodes).toHaveLength(3);

      const importsToShared = result.graph.edges.filter(
        (e) => e.type === "IMPORTS" && e.to === "file:shared.ts"
      );
      expect(importsToShared).toHaveLength(2);

      // totalFiles in the scope disclosure must reflect the whole repo (3),
      // not just the 1 file that was in the diff.
      expect(result.scope.totalFiles).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
