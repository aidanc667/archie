// src/reasoning.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { ContextPack } from "./summarizer.js";

// Single source of truth for the model used across all three Claude calls in
// this file -- previously duplicated as a literal string in each call site,
// which meant a version bump required three separate, easy-to-miss edits.
const CLAUDE_MODEL = "claude-sonnet-4-6";

export const REQUIRED_HEADINGS = [
  "1. System Summary",
  "2. Top 5 Architectural Risks",
  "3. Production Failure Scenarios",
  "4. Refactor Plan (step-by-step)",
  "5. Senior Engineer Verdict",
];

export function validateReportSections(text: string): boolean {
  const lowerText = text.toLowerCase();
  return REQUIRED_HEADINGS.every((heading) => lowerText.includes(heading.toLowerCase()));
}

export const ABSENCE_CLAIM_RULE = `- Never claim a file or system "lacks," "is missing," "has no evidence of," or
  "does not have" something (tests, error handling, a guard clause, validation,
  a lock, etc.) unless the Context Pack gives you a concrete way to check it:
  - For test coverage specifically: each top-risk file has a \`hasTests\` boolean.
    Only state a file has no tests if \`hasTests\` is present and false. If a file
    is not in \`topRiskFiles\` at all, you have no test-coverage information about
    it — do not claim it lacks tests.
  - For error handling specifically: each top-risk file has a \`hasErrorHandling\`
    boolean (true if the source contains a \`try\` block or a \`.catch(\` call —
    a heuristic check, not exhaustive). Only state a file has no error handling
    if \`hasErrorHandling\` is present and false. Do not claim a file lacks error
    handling based on absence from \`topRiskFiles\` alone.
  - For anything else (guard clauses, validation, locks, duplicate logic, etc.):
    only claim absence if the file's full \`source\` is included in the Context
    Pack and you have actually read it looking for that thing.
  - If you cannot verify presence or absence because the relevant file's source
    or fields are not in the Context Pack, say "insufficient visibility" instead
    of asserting absence. A claim of absence without a verifiable basis is a
    fabrication, not a finding.`;

export const SCENARIO_GROUNDING_RULE = `Grounding rule for this section: a scenario may describe a real code
weakness (e.g. an unvalidated input, a missing guard) as the trigger even without seeing every caller. But
do NOT assert that a specific untrusted or attacker-controlled value actually reaches that weakness through
a named call chain (e.g. "an attacker's POST payload flows through function X into function Y") unless the
Context Pack's \`graphSnapshot\` or included source actually shows that call path. If the path is plausible
but not shown, phrase it conditionally — "if X's caller ever passes untrusted input here" — rather than as a
demonstrated attack chain. A vulnerability pattern that's real but whose reachability is unverified is still
worth reporting; overstating how it's triggered is not.`;

export const DEPENDENCY_GROUNDING_RULE = `Grounding rule for naming frameworks/libraries and their versions: if
the Context Pack includes a \`dependencies\` field, name a framework's version ONLY by quoting the exact
version string from \`dependencies\` (e.g. "Next.js 16.2.2", not "Next.js 14" inferred from how the file
structure looks). Do not guess or infer a version number from code conventions, file layout, or general
familiarity with a framework's history — different major versions of the same framework can look nearly
identical in file structure, and a guessed version is a fabrication even if it sounds plausible. If
\`dependencies\` is absent, or a specific library isn't listed in it, describe the framework by name only
with no version number, or note the version could not be verified.`;

export const EXPORT_GROUNDING_RULE = `Grounding rule for a file's exported API surface: each top-risk file's
\`exportedSymbols\` field lists exactly the functions/classes that file actually exports — this is computed
from the code, not inferred. Only refer to a function or class as "exported," part of "the public API," or
usable by other files if its name appears in that file's \`exportedSymbols\`. A function/class that appears
in the file's source or signature summary but NOT in \`exportedSymbols\` is a private, module-internal
helper — do not count it toward an "N exported functions" claim, and do not name it as the target of a
refactor step for a concern that only matters at the module boundary (e.g. adding error handling "at the
public API"). If a private helper is the true root cause of a risk, say so explicitly and point the fix at
the actual exported function that calls it, not the private helper in isolation.`;

export const NAMING_CONSISTENCY_RULE = `Grounding rule for naming consistency: the Context Pack's
\`namingConsistency.inconsistencies\` array lists specific naming-case outliers actually detected across the
whole codebase (e.g. a snake_case function sitting among an otherwise camelCase (language, kind) group). If
this array is non-empty, the System Summary's one-sentence architectural-style remark should mention it,
citing a real example from the array — the outlier's \`name\`, its \`detectedStyle\`, and the group's
\`dominantStyle\` — not a vague, generic statement about "some naming inconsistencies." If
\`namingConsistency.inconsistencies\` is empty, say nothing about naming consistency at all: do not
compliment the codebase for being "consistently named" or similar. An empty array only means no outlier was
found among the (language, kind) groups that met the minimum sample size to have a dominant style computed
in the first place — it is not an affirmative, deliberate check that every name in the codebase is
consistent. A compliment about consistency that was never actually verified is a fabrication, not a
finding.`;

export const TEST_QUALITY_GROUNDING_RULE = `Grounding rule for test quality: each top-risk file's
\`testCaseCount\` and \`hasTestAssertions\` fields describe its actual linked test file (a real count of
\`it\`/\`test\`/\`def test_\`/\`func Test\`-style cases found in that test file, and whether it contains any
assertion calls at all — heuristic checks, not exhaustive, same caveat as \`hasErrorHandling\`). If you cite
a file's test coverage as thin, superficial, or "just a smoke test," ground that claim in these numbers (e.g.
"testCaseCount: 1" or "hasTestAssertions: false" for a file whose test exists but asserts nothing) rather than
a vague impression from the file's \`source\` alone. Do not claim a file's tests are "comprehensive" or
"thorough" — a count and an assertion-presence boolean cannot establish that; describe what's checkable
(the count, whether assertions exist) and stop there. If \`hasTests\` is false, \`testCaseCount\` is always 0
and \`hasTestAssertions\` is always false by definition — this is not itself a separate finding, it's the same
absence already covered by \`ABSENCE_CLAIM_RULE\`.`;

export const MAGIC_NUMBER_GROUNDING_RULE = `Grounding rule for magic numbers: each top-risk file's
\`magicNumbers\` field lists the exact unexplained numeric literals actually found in that file's source
(excluding 0, 1, -1, and any value declared as a named constant) along with the line each occurs on. Only
cite a specific magic number as evidence (e.g. "a hardcoded 86400 on line 42") if that exact value and line
appear in that file's \`magicNumbers\` array. If a top-risk file's \`magicNumbers\` array is empty, say nothing
about magic numbers for that file at all — do not compliment it for avoiding magic numbers or claim none
exist. An empty array only means none were found in the files that happened to make the top-N cut, not that
the whole codebase is free of them. A claim about a magic number that isn't backed by a real entry in that
file's array is a fabrication, not a finding.`;

export const DUPLICATION_GROUNDING_RULE = `Grounding rule for duplication: the Context Pack's
\`duplication.groups\` field lists specific groups of functions that were found to share the exact same
normalized structural shape (identifiers and literal content collapsed away, so this catches copies renamed
or re-parameterized, not just verbatim text matches) across two or more distinct files. Only claim that two
files or functions contain duplicated logic if they actually appear together as entries within the SAME group
in \`duplication.groups\` — cite the real function names and file paths from that entry, not a vague
"this looks similar to" impression from reading source. This is a real, checked structural match, not a
stylistic or subjective judgment call — treat it with the same confidence as any other graph-derived fact. If
\`duplication.groups\` is empty, say nothing about cross-file duplication at all: do not claim the codebase is
free of duplicate logic. An empty array only means no structural match was detected among the functions that
had a computable body hash — it is not an affirmative, deliberate check that no duplication exists anywhere.
A duplication claim that isn't backed by a real group entry is a fabrication, not a finding.`;

export const DEAD_FILE_GROUNDING_RULE = `Grounding rule for dead files: the Context Pack's
\`deadFiles.candidates\` field lists files with zero detected IMPORTS edges pointing to them, that also don't
look like an entry point (by a known basename like \`index\`/\`main\`/\`cli\`/\`app\`/\`server\`) or a test file.
Only describe a file as "possibly dead code," "appears unused," or similar if it actually appears in
\`deadFiles.candidates\` — and even then, phrase it as something worth verifying, not a certainty: this is a
heuristic based on statically detected imports within this repo, and it cannot see dynamic imports, a file
invoked only from a CLI entry point under some other basename, or wiring declared in a non-JS/TS/Go/Python
manifest. If \`deadFiles.candidates\` is empty, say nothing about dead or unused files at all — do not claim
every file is in active use. An empty array only means the heuristic found no candidate, not that dead code
has been ruled out. A dead-code claim about a file that isn't in \`deadFiles.candidates\`, or one stated as a
certainty rather than something to verify, is a fabrication, not a finding.`;

export const SECURITY_GROUNDING_RULE = `Grounding rule for security findings: the Context Pack's
\`security.secrets\` and \`security.dangerousSinks\` arrays list specific, statically-detected findings across
the whole codebase. \`security.secrets\` entries are lines matching a hardcoded-credential-shaped pattern (an
AWS-style access key, a PEM private-key header, or a generic api_key/secret/token/password assignment).
\`security.dangerousSinks\` entries are call sites of a dynamic-execution primitive (eval, new Function,
execSync, os.system, subprocess.*(shell=True), exec.Command("sh"/"bash", "-c", ...)) found in that file, with
\`hasDynamicArgument\` indicating whether the argument was dynamically constructed (a real injection risk) or a
plain literal (a discouraged pattern, but not itself an injection). Every entry is only \`{file, line, ruleId}\`
(plus \`hasDynamicArgument\` for a dangerousSinks entry) — CRITICALLY, a \`security.secrets\` entry NEVER
includes the actual matched secret text, only which detection rule fired (\`ruleId\`, e.g. "aws-access-key",
"private-key-block", "generic-secret-assignment") and where. Describe a finding ONLY by its \`ruleId\` and
location — e.g. "an AWS-access-key-shaped string was found in \`config.ts\` at line 12" or "a hardcoded
credential-shaped assignment was found in \`db.ts\` at line 40" — you have not seen the actual value and must
never invent, guess, or reconstruct what the secret's value might be, not even as an illustrative example or a
plausible-looking placeholder. If \`security.secrets\` is empty, say nothing about hardcoded secrets at all;
if \`security.dangerousSinks\` is empty, say nothing about dangerous sinks at all — an empty array only means
this run's heuristic found no candidate, not that the codebase has been verified secret-free or
injection-free. A security claim
not backed by a real entry in \`security.secrets\`/\`security.dangerousSinks\`, or one that guesses at a
secret's actual value, is a fabrication, not a finding.

Unlike every other whole-codebase signal above, a non-empty \`security.secrets\` or \`security.dangerousSinks\`
array is not optional color for the System Summary — it changes what Section 2 ("Top 5 Architectural Risks")
MUST contain. If either array has at least one entry, Section 2 MUST include at least one Critical-severity
risk citing that finding directly by file, line, and ruleId, even if that file does not appear in
\`topRiskFiles\` at all: a leaked secret or a shell-injection sink is critical regardless of the file's
complexity or fan-in score, and this deliberately overrides the normal expectation that Section 2's risks are
sourced from \`topRiskFiles\`.`;

const SYSTEM_PROMPT = `You are a Staff Engineer writing a formal architecture review for a software engineering team.
You will be given a Context Pack: a system summary, top-risk files with full source code and metrics
(complexity, fan-in, LOC, dependency depth, hasTests, testCaseCount, hasTestAssertions), a dependency graph
snapshot, and optionally cluster-level aggregates for large repos.

Your job is to write a clear, honest, actionable report that helps the reader understand exactly what
is risky, why it matters, and precisely what to do about it — in priority order.

Grounding rules (follow strictly):
- Only reason from facts in the Context Pack. Never invent files, functions, or relationships.
${ABSENCE_CLAIM_RULE}
${DEPENDENCY_GROUNDING_RULE}
${EXPORT_GROUNDING_RULE}
${NAMING_CONSISTENCY_RULE}
${TEST_QUALITY_GROUNDING_RULE}
${MAGIC_NUMBER_GROUNDING_RULE}
${DUPLICATION_GROUNDING_RULE}
${DEAD_FILE_GROUNDING_RULE}
${SECURITY_GROUNDING_RULE}
- Every risk and finding must cite a specific file, function, or metric from the Context Pack.
  Format citations inline as \`filename.ts\` or \`filename.ts → functionName\`. No bare assertions.

---

Respond with exactly these five sections, using these exact headings. No extra sections.

## 1. System Summary

Write 3-5 sentences covering:
- What this system does and its apparent purpose
- The tech stack: name frameworks/libraries from file names, imports, and structure, but any version
  number must come from the Context Pack's \`dependencies\` field (see grounding rule above) — never
  inferred or guessed
- Scale indicators: total files, LOC, rough complexity level (simple / moderate / complex)
- One sentence on overall architectural style (e.g. "monolithic with a clean pipeline pattern" or "loosely coupled modules with a central orchestrator"). If the Context Pack's \`namingConsistency.inconsistencies\` array is non-empty, also mention this here, citing a real example from that array (see grounding rule above). If the array is empty, say nothing about naming consistency at all. Likewise, if \`duplication.groups\` is non-empty, mention it here too, citing a real example (see grounding rule above) — say nothing if it's empty. Likewise, if \`deadFiles.candidates\` is non-empty, mention it here too, citing a real example (see grounding rule above) — say nothing if it's empty.

Then a **Key Metrics** block:

| Metric | Value |
|--------|-------|
| Files analysed | [n] |
| Total lines of code | [n] |
| Highest-risk file | [\`filename.ts\`] (risk score: [x.xx]) |
| Files with test coverage | [n of m top-risk files have hasTests=true] |

---

## 2. Top 5 Architectural Risks

For each risk, use this exact structure:

### Risk [N]: [Short descriptive title] — \`[primary file]\`
**Severity:** [Critical / High / Medium]
**Why this matters:** [1-2 sentences on the real-world consequence if this risk materialises — frame it in terms of user impact, data integrity, or engineering cost, not just code quality.]
**Root cause:** [1-2 sentences on the specific technical reason this is risky. Reference the metric or source code evidence. E.g. "fanIn=14 means 14 files depend on this module — a breaking change here cascades across the entire codebase."]
**Evidence:** [Direct quote or paraphrase from the source code, or the specific metric, that confirms this risk. Never assert something you did not see in the pack.]

Order risks from most to least severe. If fewer than 5 genuine risks exist, report only the ones you can evidence — do not pad.

If the Context Pack's \`security.secrets\` or \`security.dangerousSinks\` array is non-empty, you MUST report at least one Critical severity risk here for that exact finding (cite \`file\`/\`line\`/\`ruleId\` — never the secret's actual value, see grounding rule above) even if its file never appears in \`topRiskFiles\` — a leaked secret or a shell-injection sink is critical regardless of complexity/fanIn, and this takes priority over the normal topRiskFiles-sourced risks if it means displacing a lower-severity one to stay within 5.

---

## 3. Production Failure Scenarios

Write exactly 3 concrete failure scenarios — realistic sequences of events that could cause a production incident or user-facing bug. Each must follow this format:

### Scenario [N]: [Descriptive title]
**Trigger:** [The specific action, condition, or edge case that starts the failure — be concrete, not hypothetical. Reference a real file or function.]
**Chain of failure:** [Step-by-step: what breaks, what cascades, what the user or system experiences.]
**Business impact:** [Data loss / downtime / security breach / incorrect results / degraded performance — and at what scale or frequency this is likely.]
**Likelihood:** [High / Medium / Low] — [one sentence justification]

${SCENARIO_GROUNDING_RULE}

---

## 4. Refactor Plan (step-by-step)

List fixes in priority order (highest impact first). Each step MUST follow this exact format:

### Step [N]: [Imperative title — what this step achieves]
**Why now:** [One sentence explaining why this is the right priority order — what does fixing this unblock or prevent?]
**File:** \`path/to/file.ts\`
**Effort:** [< 1 hour / half day / 1-2 days / 1 week]

> **Paste into Claude Code to implement this step:**
> [A complete, self-contained instruction for an AI coding agent. Include: the exact file and function to change, what to change and how, the specific bug or problem being fixed, and a clear acceptance criterion ("this step is done when X"). Write this as a direct imperative. The agent has no other context — everything it needs must be in this block. Minimum 3 sentences. IMPORTANT: you (the report writer) only see the top-risk files, not the whole repo, so you cannot know whether a reusable component for a cross-cutting concern (an error boundary, a modal, a loading spinner, a toast/notification, etc.) already exists elsewhere. If a step would introduce a new component for one of these concerns, the instruction MUST tell the agent to first search the codebase for an existing implementation with matching behavior and reuse or extend it instead of building a new one, only building new if that search comes up empty — the agent has full repo access and can actually verify this, which you cannot.]

---

## 5. Senior Engineer Verdict

Write a final assessment covering:
- **Overall health rating:** [one of: Needs significant work / Functional but fragile / Solid foundation / Production-ready]
- **Biggest strength:** One specific, evidenced positive about this codebase.
- **Biggest risk:** One sentence on the single most dangerous unresolved issue.
- **Recommended first action:** Exactly one thing the team should do this week, specific enough to assign to a developer.
- A closing paragraph (3-5 sentences) that gives an honest overall picture — is this codebase ready to scale, or does it need foundational work first? Who is this team, based on what you see? What trajectory are they on?`;

export interface RiskFinding {
  title: string;
  file: string;
  severity: "Critical" | "High" | "Medium";
  confidence: "high" | "medium" | "low";
  why_it_matters: string;
  root_cause: string;
  evidence: string;
  complexity: number;
  fanIn: number;
  loc: number;
}

export interface ScenarioFinding {
  title: string;
  trigger: string;
  chain_of_failure: string;
  business_impact: string;
  likelihood: "High" | "Medium" | "Low";
  likelihood_justification: string;
}

// Pass 4: a detection-only self-critique of Sections 1, 4, and 5 (the three
// free-text sections Pass 2 writes, which -- unlike Sections 2/3 -- have no
// schema enforcement and no per-claim grounding check at all today). This
// intentionally never rewrites report text itself: an automated "fix" risks
// introducing new errors or breaking formatting, which is a materially
// different, riskier feature than surfacing issues for a human to review.
export interface QualityWarning {
  section: string;
  claim: string;
  issue: string;
}

const REPORT_RISKS_TOOL: Anthropic.Tool = {
  name: "report_risks",
  description:
    "Report the top architectural risks as structured data. For each risk, the " +
    "`complexity`, `fanIn`, and `loc` fields must be copied VERBATIM from the " +
    "matching entry in the Context Pack's `topRiskFiles` (the file you are citing " +
    "as the risk's primary file) — do not estimate, round, or invent these numbers.",
  input_schema: {
    type: "object",
    properties: {
      risks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            file: { type: "string" },
            severity: { type: "string", enum: ["Critical", "High", "Medium"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            why_it_matters: { type: "string" },
            root_cause: { type: "string" },
            evidence: { type: "string" },
            complexity: {
              type: "number",
              description:
                "Copied verbatim from topRiskFiles[].complexity for this file — do not estimate.",
            },
            fanIn: {
              type: "number",
              description:
                "Copied verbatim from topRiskFiles[].fanIn for this file — do not estimate.",
            },
            loc: {
              type: "number",
              description:
                "Copied verbatim from topRiskFiles[].loc for this file — do not estimate.",
            },
          },
          required: [
            "title",
            "file",
            "severity",
            "confidence",
            "why_it_matters",
            "root_cause",
            "evidence",
            "complexity",
            "fanIn",
            "loc",
          ],
        },
      },
    },
    required: ["risks"],
  },
};

const REPORT_SCENARIOS_TOOL: Anthropic.Tool = {
  name: "report_scenarios",
  description: "Report exactly 3 production failure scenarios as structured data.",
  input_schema: {
    type: "object",
    properties: {
      scenarios: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            trigger: { type: "string" },
            chain_of_failure: { type: "string" },
            business_impact: { type: "string" },
            likelihood: { type: "string", enum: ["High", "Medium", "Low"] },
            likelihood_justification: { type: "string" },
          },
          required: [
            "title",
            "trigger",
            "chain_of_failure",
            "business_impact",
            "likelihood",
            "likelihood_justification",
          ],
        },
      },
    },
    required: ["scenarios"],
  },
};

const REPORT_QUALITY_CHECK_TOOL: Anthropic.Tool = {
  name: "report_quality_check",
  description:
    "Report any specific claims in the already-written report sections (System Summary, " +
    "Refactor Plan, Senior Engineer Verdict) that are not grounded in the Context Pack. " +
    "The `warnings` array may legitimately be empty -- an empty array means no issues were " +
    "found, which is a valid, good outcome. Do not manufacture issues just to have something " +
    "to report.",
  input_schema: {
    type: "object",
    properties: {
      warnings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            section: {
              type: "string",
              description:
                'Which section the claim appears in, e.g. "1. System Summary" or "5. Senior Engineer Verdict".',
            },
            claim: {
              type: "string",
              description:
                "The specific sentence/claim that's ungrounded, quoted or closely paraphrased from the report text.",
            },
            issue: {
              type: "string",
              description:
                'Why the claim is ungrounded, e.g. "cites Next.js 15 but dependencies field shows 16.2.2".',
            },
          },
          required: ["section", "claim", "issue"],
        },
      },
    },
    required: ["warnings"],
  },
};

const CONFIDENCE_RULES = `Confidence scoring for each risk:
- "high": the finding cites a file whose full \`source\` is in the context pack (i.e. it's in the top-3 detail files)
- "medium": the finding cites a file that is in \`topRiskFiles\` but has a signature summary only (not full source)
- "low": the finding is based on graph topology/metrics alone without source visibility

For each risk, also provide:
- "severity": one of Critical / High / Medium, based on the real-world consequence and blast radius of this risk materialising.
- "root_cause": 1-2 sentences on the specific technical reason this is risky. Reference the metric or source code evidence, e.g. "fanIn=14 means 14 files depend on this module — a breaking change here cascades across the entire codebase."
- "complexity", "fanIn", "loc": copy these three numbers VERBATIM from the matching
  entry in the Context Pack's \`topRiskFiles\` for the file this risk cites. Do not
  estimate, round, or infer them — they must exactly match the pack's data.`;

function extractTextBlock(response: Anthropic.Messages.Message): string {
  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock && "text" in textBlock ? textBlock.text : "";
}

const REQUIRED_RISK_STRING_FIELDS = [
  "title",
  "file",
  "severity",
  "confidence",
  "why_it_matters",
  "root_cause",
  "evidence",
] as const;

const REQUIRED_RISK_NUMBER_FIELDS = ["complexity", "fanIn", "loc"] as const;

// The report_risks tool call is trusted with zero validation downstream
// (formatRisksSection reads risk.title/severity/etc. directly). If the
// response was truncated (e.g. hit max_tokens mid-JSON on a large, complex
// repo) or otherwise malformed, `risks` can come back as something other
// than a clean array of well-formed objects -- and every field access on a
// malformed entry silently evaluates to `undefined` rather than throwing,
// producing a report full of "Risk N: undefined — `undefined`" instead of a
// clear failure. Fail loudly instead.
function validateRisks(risks: unknown): RiskFinding[] {
  if (!Array.isArray(risks)) {
    throw new Error(
      `report_risks tool call returned a malformed "risks" field (expected an array, got ${typeof risks}). This usually means the response was truncated by the token limit — try again, or reduce --topN to shrink the context pack.`
    );
  }
  risks.forEach((risk, i) => {
    if (typeof risk !== "object" || risk === null) {
      throw new Error(
        `report_risks tool call returned a malformed risk at index ${i} (expected an object, got ${typeof risk}). This usually means the response was truncated by the token limit.`
      );
    }
    for (const field of REQUIRED_RISK_STRING_FIELDS) {
      const value = (risk as Record<string, unknown>)[field];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(
          `report_risks tool call returned a malformed risk at index ${i}: "${field}" is missing or empty. This usually means the response was truncated by the token limit.`
        );
      }
    }
    for (const field of REQUIRED_RISK_NUMBER_FIELDS) {
      const value = (risk as Record<string, unknown>)[field];
      if (typeof value !== "number") {
        throw new Error(
          `report_risks tool call returned a malformed risk at index ${i}: "${field}" is missing or not a number. This usually means the response was truncated by the token limit.`
        );
      }
    }
  });
  return risks as RiskFinding[];
}

const REQUIRED_SCENARIO_STRING_FIELDS = [
  "title",
  "trigger",
  "chain_of_failure",
  "business_impact",
  "likelihood",
  "likelihood_justification",
] as const;

const ALLOWED_LIKELIHOODS = new Set(["High", "Medium", "Low"]);

// Mirrors validateRisks exactly: the report_scenarios tool call is trusted
// with zero validation downstream (formatScenariosSection reads
// scenario.title/trigger/etc. directly), so a truncated or malformed
// response must fail loudly rather than silently render "undefined" fields.
function validateScenarios(scenarios: unknown): ScenarioFinding[] {
  if (!Array.isArray(scenarios)) {
    throw new Error(
      `report_scenarios tool call returned a malformed "scenarios" field (expected an array, got ${typeof scenarios}). This usually means the response was truncated by the token limit — try again, or reduce --topN to shrink the context pack.`
    );
  }
  scenarios.forEach((scenario, i) => {
    if (typeof scenario !== "object" || scenario === null) {
      throw new Error(
        `report_scenarios tool call returned a malformed scenario at index ${i} (expected an object, got ${typeof scenario}). This usually means the response was truncated by the token limit.`
      );
    }
    for (const field of REQUIRED_SCENARIO_STRING_FIELDS) {
      const value = (scenario as Record<string, unknown>)[field];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(
          `report_scenarios tool call returned a malformed scenario at index ${i}: "${field}" is missing or empty. This usually means the response was truncated by the token limit.`
        );
      }
    }
    const likelihood = (scenario as Record<string, unknown>).likelihood as string;
    if (!ALLOWED_LIKELIHOODS.has(likelihood)) {
      throw new Error(
        `report_scenarios tool call returned a malformed scenario at index ${i}: "likelihood" must be one of High/Medium/Low, got "${likelihood}". This usually means the response was truncated by the token limit.`
      );
    }
  });
  return scenarios as ScenarioFinding[];
}

const REQUIRED_QUALITY_WARNING_STRING_FIELDS = ["section", "claim", "issue"] as const;

// Mirrors validateRisks/validateScenarios's strictness, with one deliberate
// difference: an empty `warnings` array is not just allowed but a good,
// expected outcome (it means the quality check found nothing to flag), so
// unlike a truncated/malformed `risks`/`scenarios` field this only throws on
// structurally malformed data -- never on a legitimately empty array.
function validateQualityWarnings(warnings: unknown): QualityWarning[] {
  if (!Array.isArray(warnings)) {
    throw new Error(
      `report_quality_check tool call returned a malformed "warnings" field (expected an array, got ${typeof warnings}). This usually means the response was truncated by the token limit.`
    );
  }
  warnings.forEach((warning, i) => {
    if (typeof warning !== "object" || warning === null) {
      throw new Error(
        `report_quality_check tool call returned a malformed warning at index ${i} (expected an object, got ${typeof warning}). This usually means the response was truncated by the token limit.`
      );
    }
    for (const field of REQUIRED_QUALITY_WARNING_STRING_FIELDS) {
      const value = (warning as Record<string, unknown>)[field];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(
          `report_quality_check tool call returned a malformed warning at index ${i}: "${field}" is missing or empty. This usually means the response was truncated by the token limit.`
        );
      }
    }
  });
  return warnings as QualityWarning[];
}

const SEVERITY_PRIORITY: Record<RiskFinding["severity"], number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
};

const CONFIDENCE_CAVEATS: Record<"medium" | "low", string> = {
  low: "*Confidence: based on graph structure and metrics only — full source wasn't available to verify this finding directly.*",
  medium:
    "*Confidence: based on a partial view of this file (signature summary, not full source) — treat as directionally correct pending closer review.*",
};

function buildScopeStatement(pack: ContextPack): string {
  const totalFiles = pack.systemSummary.fileCount;
  const detailedFiles = pack.topRiskFiles.length;

  if (pack.mode === "cluster-summary") {
    return `**Scope of this analysis:** Archie analyzed all ${totalFiles} files in this repository and ranked them by risk. The top ${detailedFiles} were examined in full detail; the remaining files were assessed only at a coarse, cluster-level (aggregate complexity and risk statistics, no individual findings) because this repository exceeded the size this tool can fully detail in one pass. This report's specific, evidenced findings apply only to the ${detailedFiles} files analyzed in detail — the rest were not individually assessed and may contain risks this report does not surface.`;
  }

  const unassessed = totalFiles - detailedFiles;
  if (unassessed <= 0) {
    return `**Scope of this analysis:** Archie analyzed all ${totalFiles} files in this repository in detail.`;
  }
  return `**Scope of this analysis:** Archie analyzed all ${totalFiles} files in this repository, ranked them by risk, and examined the top ${detailedFiles} in detail for this report. The remaining ${unassessed} file${unassessed === 1 ? "" : "s"} were not individually assessed and are not covered by this report's findings.`;
}

const MAX_DISPLAYED_RISKS = 5;

function formatRisksSection(risks: RiskFinding[]): string {
  const sortedRisks = [...risks]
    .sort((a, b) => SEVERITY_PRIORITY[a.severity] - SEVERITY_PRIORITY[b.severity])
    .slice(0, MAX_DISPLAYED_RISKS);

  const lines = ["## 2. Top 5 Architectural Risks", ""];
  sortedRisks.forEach((risk, i) => {
    lines.push(`### Risk ${i + 1}: ${risk.title} — \`${risk.file}\``);
    lines.push(`**Severity:** ${risk.severity}`);
    lines.push(`**Why this matters:** ${risk.why_it_matters}`);
    lines.push(`**Root cause:** ${risk.root_cause}`);
    lines.push(`**Evidence:** ${risk.evidence}`);
    lines.push(`*Metrics: complexity=${risk.complexity}, fanIn=${risk.fanIn}, loc=${risk.loc}*`);
    if (risk.confidence === "medium" || risk.confidence === "low") {
      lines.push(CONFIDENCE_CAVEATS[risk.confidence]);
    }
    lines.push("");
  });
  return lines.join("\n");
}

function formatScenariosSection(scenarios: ScenarioFinding[]): string {
  const lines = ["## 3. Production Failure Scenarios", ""];
  scenarios.forEach((scenario, i) => {
    lines.push(`### Scenario ${i + 1}: ${scenario.title}`);
    lines.push(`**Trigger:** ${scenario.trigger}`);
    lines.push(`**Chain of failure:** ${scenario.chain_of_failure}`);
    lines.push(`**Business impact:** ${scenario.business_impact}`);
    lines.push(`**Likelihood:** ${scenario.likelihood} — ${scenario.likelihood_justification}`);
    lines.push("");
  });
  return lines.join("\n");
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

const RETRYABLE_ERROR_RE = /truncated|malformed/i;
const MAX_RISK_EXTRACTION_ATTEMPTS = 3;

// Pass 1 (structured risk extraction) is the step observed to intermittently
// truncate on large/complex repos -- confirmed live: the same repo produced
// a clean 5-risk response on some runs and a truncated, malformed one on
// others, with no code-level difference between attempts. This is API-level
// non-determinism, not a bug to "fix" away entirely, so it's handled with a
// bounded retry rather than a one-shot hard failure. Only retries the
// specific truncation/malformation error class raised by validateRisks/the
// stop_reason check above -- any other error (missing tool call, bad API
// key, etc.) is not transient and is rethrown immediately.
async function extractRisks(
  client: Anthropic,
  pack: ContextPack
): Promise<{ risks: RiskFinding[]; usage: TokenUsage }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RISK_EXTRACTION_ATTEMPTS; attempt++) {
    try {
      const risksResponse = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        temperature: 0,
        system: `${SYSTEM_PROMPT}\n\n${CONFIDENCE_RULES}`,
        messages: [
          {
            role: "user",
            content: `Identify at most ${MAX_DISPLAYED_RISKS} of the top architectural risks in this codebase — do not enumerate more than ${MAX_DISPLAYED_RISKS} even if you find more candidates, and keep each field concise (root_cause and evidence: 1-3 sentences each) so the response fits comfortably within the token budget. Use the report_risks tool.\n\n${JSON.stringify(pack, null, 2)}`,
          },
        ],
        tools: [REPORT_RISKS_TOOL],
        tool_choice: { type: "tool", name: "report_risks" },
      });

      if (risksResponse.stop_reason === "max_tokens") {
        throw new Error(
          "Claude's risk-extraction response was truncated (hit the max_tokens limit) before completing. This can happen on very large or complex repos."
        );
      }

      const toolUseBlock = risksResponse.content.find(
        (block) => block.type === "tool_use" && block.name === "report_risks"
      );
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
        throw new Error("Claude did not call report_risks tool as expected.");
      }
      const risks = validateRisks((toolUseBlock.input as { risks: unknown }).risks);

      return {
        risks,
        usage: {
          inputTokens: risksResponse.usage.input_tokens,
          outputTokens: risksResponse.usage.output_tokens,
        },
      };
    } catch (err) {
      lastError = err;
      const isRetryable = err instanceof Error && RETRYABLE_ERROR_RE.test(err.message);
      if (!isRetryable || attempt === MAX_RISK_EXTRACTION_ATTEMPTS) {
        if (isRetryable) {
          throw new Error(
            `${(err as Error).message} Retried ${MAX_RISK_EXTRACTION_ATTEMPTS} times with no success — try reducing --topN to shrink the context pack.`
          );
        }
        throw err;
      }
    }
  }

  // Unreachable — the loop above always returns or throws — but keeps
  // TypeScript satisfied that every path returns a value.
  throw lastError;
}

const MAX_DISPLAYED_SCENARIOS = 3;

// Mirrors extractRisks exactly: same bounded retry on the same
// truncation/malformation error class, same stop_reason check, same forced
// tool_choice. This gives Section 3 ("Production Failure Scenarios") the
// same structural enforcement Section 2's risks already have, instead of
// relying purely on SCENARIO_GROUNDING_RULE as unenforced prompt text.
async function extractScenarios(
  client: Anthropic,
  pack: ContextPack
): Promise<{ scenarios: ScenarioFinding[]; usage: TokenUsage }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RISK_EXTRACTION_ATTEMPTS; attempt++) {
    try {
      const scenariosResponse = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        temperature: 0,
        system: `${SYSTEM_PROMPT}\n\n${SCENARIO_GROUNDING_RULE}`,
        messages: [
          {
            role: "user",
            content: `Write exactly ${MAX_DISPLAYED_SCENARIOS} concrete failure scenarios — realistic sequences of events that could cause a production incident or user-facing bug — do not write more or fewer than ${MAX_DISPLAYED_SCENARIOS}, and keep each field concise (1-3 sentences each) so the response fits comfortably within the token budget. Use the report_scenarios tool.\n\n${JSON.stringify(pack, null, 2)}`,
          },
        ],
        tools: [REPORT_SCENARIOS_TOOL],
        tool_choice: { type: "tool", name: "report_scenarios" },
      });

      if (scenariosResponse.stop_reason === "max_tokens") {
        throw new Error(
          "Claude's scenario-extraction response was truncated (hit the max_tokens limit) before completing. This can happen on very large or complex repos."
        );
      }

      const toolUseBlock = scenariosResponse.content.find(
        (block) => block.type === "tool_use" && block.name === "report_scenarios"
      );
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
        throw new Error("Claude did not call report_scenarios tool as expected.");
      }
      const scenarios = validateScenarios(
        (toolUseBlock.input as { scenarios: unknown }).scenarios
      );

      return {
        scenarios,
        usage: {
          inputTokens: scenariosResponse.usage.input_tokens,
          outputTokens: scenariosResponse.usage.output_tokens,
        },
      };
    } catch (err) {
      lastError = err;
      const isRetryable = err instanceof Error && RETRYABLE_ERROR_RE.test(err.message);
      if (!isRetryable || attempt === MAX_RISK_EXTRACTION_ATTEMPTS) {
        if (isRetryable) {
          throw new Error(
            `${(err as Error).message} Retried ${MAX_RISK_EXTRACTION_ATTEMPTS} times with no success — try reducing --topN to shrink the context pack.`
          );
        }
        throw err;
      }
    }
  }

  // Unreachable — the loop above always returns or throws — but keeps
  // TypeScript satisfied that every path returns a value.
  throw lastError;
}

const QUALITY_CHECK_SYSTEM_PROMPT = `You are auditing a Staff Engineer's architecture report for ungrounded claims before it
reaches a reader. You will be given the same Context Pack the report was written from, plus the
already-written "System Summary", "Refactor Plan", and "Senior Engineer Verdict" sections (sections
1, 4, and 5) of that report.

Your job is to find any specific claim in those three sections that is not actually grounded in the
Context Pack. This is the same grounding standard the report-writing prompt was already told to
follow:
${ABSENCE_CLAIM_RULE}
${DEPENDENCY_GROUNDING_RULE}
${EXPORT_GROUNDING_RULE}
${SCENARIO_GROUNDING_RULE}
${NAMING_CONSISTENCY_RULE}
${TEST_QUALITY_GROUNDING_RULE}
${MAGIC_NUMBER_GROUNDING_RULE}
${DUPLICATION_GROUNDING_RULE}
${DEAD_FILE_GROUNDING_RULE}
${SECURITY_GROUNDING_RULE}

Concretely, check for:
(a) A version number that doesn't match the Context Pack's \`dependencies\` field.
(b) An "exported" or "public API" claim about a symbol that does not appear in that file's
    \`exportedSymbols\`.
(c) An absence claim ("no tests", "no error handling", "lacks X") that isn't backed by \`hasTests\`
    or \`hasErrorHandling\` being explicitly false for that file.
(d) A named file, function, or metric that does not actually appear anywhere in the Context Pack.
(e) A naming-consistency claim (either citing an inconsistency, or complimenting consistency) that
    isn't backed by a real entry in \`namingConsistency.inconsistencies\` — including a compliment
    about consistent naming when that array is empty.
(f) A test-quality claim ("comprehensive tests", "just a smoke test", "thin coverage") that isn't
    backed by that file's actual \`testCaseCount\`/\`hasTestAssertions\` values.
(g) A magic-number claim that cites a value/line not actually present in that file's \`magicNumbers\`
    array, or any magic-number claim at all for a file whose \`magicNumbers\` array is empty.
(h) A cross-file duplication claim about two files/functions that don't actually appear together in
    the same entry of \`duplication.groups\`, or any duplication claim at all when \`duplication.groups\`
    is empty.
(i) A dead-code/"appears unused" claim about a file that isn't in \`deadFiles.candidates\`, one stated
    as a certainty rather than something to verify, or any such claim at all when \`deadFiles.candidates\`
    is empty.
(j) A security claim (a hardcoded secret or a dangerous dynamic-execution sink) that isn't backed by a
    real entry in \`security.secrets\`/\`security.dangerousSinks\`, OR a claim that reproduces, guesses at,
    or otherwise reconstructs an actual secret's value instead of describing it only by \`ruleId\` and
    location -- the latter is a safety violation, not just an ungrounded claim, and must always be flagged.

Only flag claims you can concretely trace back to a mismatch or absence in the Context Pack — do not
flag stylistic issues, subjective judgment calls, or claims you merely find surprising. If you find
nothing wrong, call the report_quality_check tool with an empty \`warnings\` array. Do not manufacture
issues just to have something to report — a clean report with zero warnings is a valid, good outcome.

For each warning, quote or closely paraphrase the specific offending claim and explain exactly why it
is ungrounded (e.g. "cites Next.js 15 but dependencies field shows 16.2.2").`;

// Pass 4: detection-only self-critique of Sections 1, 4, and 5. Unlike
// extractRisks/extractScenarios (whose output is load-bearing -- the report
// can't be assembled without them), this pass is purely supplementary: a
// report is still usable without a quality check having run. So on
// truncation failure after all retries, this does NOT throw and abort the
// whole report -- it's caught, logged, and swallowed by the caller.
async function runQualityCheck(
  client: Anthropic,
  pack: ContextPack,
  assembledText: string
): Promise<{ warnings: QualityWarning[]; usage: TokenUsage }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RISK_EXTRACTION_ATTEMPTS; attempt++) {
    try {
      const response = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        temperature: 0,
        system: QUALITY_CHECK_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Here are the already-written report sections (System Summary, Refactor Plan, Senior Engineer Verdict):\n\n${assembledText}\n\nHere is the Context Pack these sections must be grounded in:\n\n${JSON.stringify(pack, null, 2)}\n\nUse the report_quality_check tool.`,
          },
        ],
        tools: [REPORT_QUALITY_CHECK_TOOL],
        tool_choice: { type: "tool", name: "report_quality_check" },
      });

      if (response.stop_reason === "max_tokens") {
        throw new Error(
          "Claude's quality-check response was truncated (hit the max_tokens limit) before completing."
        );
      }

      const toolUseBlock = response.content.find(
        (block) => block.type === "tool_use" && block.name === "report_quality_check"
      );
      if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
        throw new Error("Claude did not call report_quality_check tool as expected.");
      }
      const warnings = validateQualityWarnings(
        (toolUseBlock.input as { warnings: unknown }).warnings
      );

      return {
        warnings,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (err) {
      lastError = err;
      const isRetryable = err instanceof Error && RETRYABLE_ERROR_RE.test(err.message);
      if (!isRetryable || attempt === MAX_RISK_EXTRACTION_ATTEMPTS) {
        break;
      }
    }
  }

  // This pass is supplementary, not required for a usable report -- unlike
  // extractRisks/extractScenarios, a failure here must never abort the whole
  // report. Log and fail open with an empty warnings list instead.
  console.warn(
    `[archie] Report quality check failed after ${MAX_RISK_EXTRACTION_ATTEMPTS} attempts and was skipped: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
  return { warnings: [], usage: { inputTokens: 0, outputTokens: 0 } };
}

function buildQualityCaveatBlock(warnings: QualityWarning[]): string {
  if (warnings.length === 0) return "";

  const lines = [
    `> ⚠️ **Automated grounding check flagged ${warnings.length} potential issue(s) in this report:**`,
    ...warnings.map((w) => `> - [Section ${w.section}] "${w.claim}" — ${w.issue}`),
  ];
  return lines.join("\n");
}

export async function generateReport(
  client: Anthropic,
  pack: ContextPack
): Promise<{
  report: string;
  risks: RiskFinding[];
  scenarios: ScenarioFinding[];
  qualityWarnings: QualityWarning[];
  usage: TokenUsage;
}> {
  // Pass 1 risks and pass 1 scenarios are independent of each other (both
  // only depend on `pack`), so run them concurrently rather than
  // sequentially to avoid adding latency for the new third API call.
  const [
    { risks, usage: risksUsage },
    { scenarios, usage: scenariosUsage },
  ] = await Promise.all([extractRisks(client, pack), extractScenarios(client, pack)]);

  const risksSection = formatRisksSection(risks);
  const scenariosSection = formatScenariosSection(scenarios);
  const scopeStatement = buildScopeStatement(pack);

  // Pass 2: remaining sections (1, 4, 5) with structured risks as context.
  // Section 3 is no longer generated here — it now comes from
  // formatScenariosSection, sourced from the structured, validated
  // extractScenarios call above.
  const remainingSectionsPrompt = `You are writing an architecture report. The "Top 5 Architectural Risks" section and the "Production Failure Scenarios" section have already been generated (shown below). Write only sections 1, 4, and 5 — do NOT include section 2 or section 3.

Here are the structured risks for your reference when writing sections 4 and 5:
${JSON.stringify(risks, null, 2)}

Here are the structured failure scenarios for your reference when writing sections 4 and 5:
${JSON.stringify(scenarios, null, 2)}

Context Pack:
${JSON.stringify(pack, null, 2)}

Write exactly these three sections with these exact headings (no section 2, no section 3):
## 1. System Summary
## 4. Refactor Plan (step-by-step)
## 5. Senior Engineer Verdict`;

  const remainingResponse = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 6144,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: remainingSectionsPrompt }],
  });

  const remainingText = extractTextBlock(remainingResponse);

  // Pass 4: detection-only grounding check over the just-written Sections 1,
  // 4, and 5. Runs after Pass 2 (not in parallel with it) because it needs
  // that pass's output as input. Never throws -- see runQualityCheck.
  const { warnings: qualityWarnings, usage: qualityUsage } = await runQualityCheck(
    client,
    pack,
    remainingText
  );
  const qualityCaveatBlock = buildQualityCaveatBlock(qualityWarnings);
  // Caveat block (if any) is placed right after the scope statement and
  // before the risks section, per the required report layout.
  const scopeAndCaveat = qualityCaveatBlock
    ? `${scopeStatement}\n\n${qualityCaveatBlock}`
    : scopeStatement;

  // Assemble final report: inject risks section between section 1 and
  // section 4 (section 3 is now generated separately, see above), splicing
  // in scenariosSection right after risksSection.
  // Found via Archie's own self-analysis: the previous approach required an
  // exact literal "## 3." match and fell back to splitting on that same
  // literal string if the model varied heading formatting even slightly
  // (extra space, different capitalisation) -- and that fallback split could
  // duplicate or drop content if "## 3." happened to appear more than once
  // (e.g. inside a quoted code example). Matching the heading as a
  // case-insensitive, whitespace-tolerant *line* anchored to the start of a
  // line avoids both problems: it tolerates formatting drift and can't
  // accidentally match "## 4." appearing mid-sentence.
  const heading4Match = remainingText.match(/^##\s*4\.[^\n]*$/im);

  let finalReport: string;
  if (heading4Match && heading4Match.index !== undefined) {
    const section1Text = remainingText.slice(0, heading4Match.index).trimEnd();
    const section45Text = remainingText.slice(heading4Match.index);
    finalReport = `${section1Text}\n\n${scopeAndCaveat}\n\n${risksSection}\n\n${scenariosSection}\n\n${section45Text}`;
  } else {
    // Heading 4 doesn't appear at all -- prepend scope statement, risks
    // section, and scenarios section rather than lose the response
    // outright. validateReportSections below still catches a report that's
    // missing required sections.
    finalReport = `${remainingText.trimEnd()}\n\n${scopeAndCaveat}\n\n${risksSection}\n\n${scenariosSection}`;
  }

  if (!validateReportSections(finalReport)) {
    throw new Error(
      `Assembled report is missing required sections. Raw response:\n${finalReport}`
    );
  }

  const usage: TokenUsage = {
    inputTokens:
      risksUsage.inputTokens +
      scenariosUsage.inputTokens +
      remainingResponse.usage.input_tokens +
      qualityUsage.inputTokens,
    outputTokens:
      risksUsage.outputTokens +
      scenariosUsage.outputTokens +
      remainingResponse.usage.output_tokens +
      qualityUsage.outputTokens,
  };

  return { report: finalReport, risks, scenarios, qualityWarnings, usage };
}

const MIN_SUMMARY_LENGTH = 100;

const SIMPLIFIED_SUMMARY_SYSTEM_PROMPT = `You are translating a technical software architecture report into a complete, polished, professional summary for a non-technical reader — a founder, product manager, or investor who needs the full picture of the product's health, not the code, and should not need to read the technical report to get it.

Use EXACTLY this markdown structure (headings must appear word-for-word as shown):

# [Name or one-line description of the system — infer from the report]

*Architecture Report · Generated by ARCHIE*

---

## What This System Does

2-3 sentences. Plain English only. What does this software do, who uses it, and what problem does it solve? Zero jargon, zero technical terms.

---

## What's Working Well

3-4 bullet points. Each bullet is one sentence. Focus on genuine strengths the non-technical reader would find reassuring: stability signals, good structure, evidence the team knows what they're doing. Be honest — only include things the technical report actually supports.

---

## The Concerns

Cover EVERY risk listed in the technical report's "Top Architectural Risks" section — do not select a subset. Match its count exactly (if it lists 5, write 5; if fewer, write that many) and keep the same most-to-least-severe order. Each follows this structure:

**[Short name for the concern]**
[2-3 sentences. What is the risk in plain business terms? What could go wrong for users, the product, or the company? What would it look like if this became a real problem? No file names, no line numbers, no metrics — only business consequences.]

If the technical report attaches a confidence caveat to this risk (a line starting with "*Confidence:" noting it's based on a partial view or graph structure alone, not full source), end this concern with one plain-English sentence carrying that caveat forward — e.g. "This one is based on a partial read of the file and is worth a closer look before acting on it." Do not use the words "confidence," "medium," or "low" — translate the caveat's meaning, not its technical framing. If the technical report shows no such caveat for a risk (i.e. it was fully verified against source), add nothing — do not manufacture uncertainty that isn't there.

---

## What Could Go Wrong

Translate EVERY scenario in the technical report's "Production Failure Scenarios" section (there are always exactly 3) into a short, concrete story in plain English. Each follows this structure:

**[Short name for the scenario]**
[2-3 sentences combining the trigger and the chain of failure into a plain narrative — what specific situation sets this off, and what happens next for the user or the business. No file names, no function names — describe the situation and the consequence, not the code path.]

---

## What Should Happen Next

Translate EVERY step in the technical report's "Refactor Plan" section into one plain-English action — do not select a subset or cap the count. Match the technical report's step count and priority order. Each bullet: one concrete action, not "refactor X" but "The team should add automated tests for the payment processing flow before adding new features to it." Carry over the urgency/effort framing (e.g. "this week," "half a day") in plain language where the technical report states it.

---

## Bottom Line

**Overall health:** [choose one: Needs significant work · Functional but fragile · Solid foundation · Production-ready]

3-5 sentences. Is this a codebase that can support a growing product, or does it need investment before it's ready to scale? Give an honest, direct verdict. End with one clear recommendation for what the team should prioritise first.

---

Rules:
- No jargon. No file paths. No function names. No metrics or scores.
- Every concern, scenario, and recommendation must trace back to something in the technical report — do not invent.
- Completeness matters more than brevity: a reader who only sees this summary should learn about every risk, every failure scenario, and every recommended action from the technical report, just without the technical detail. Do not omit findings to keep this short.
- Tone: direct, professional, honest. Not alarmist, not reassuring for the sake of it.
- Every section heading must appear exactly as shown above.`;

const SCOPE_STATEMENT_RE = /\*\*Scope of this analysis:\*\*\s*([^\n]+)/;

// Pulls the deterministically-generated scope line out of the technical
// report (already spliced in by `generateReport`/`buildScopeStatement`) and
// re-inserts it near the top of the simplified summary. The simplified
// summary is a non-technical, LLM-written translation of the technical
// report; nothing guarantees the model remembers to restate a limitation
// buried in its input, and the executive-facing PDF is exactly the surface
// where a reader is least likely to think to ask "did this cover everything?"
function spliceScopeNote(summary: string, technicalReport: string): string {
  const match = technicalReport.match(SCOPE_STATEMENT_RE);
  if (!match) return summary;

  const scopeNote = `*Scope: ${match[1].trim()}*`;
  const firstSeparator = summary.indexOf("\n---\n");
  if (firstSeparator === -1) {
    // No "---" separator found (unexpected shape) — prepend rather than lose the note.
    return `${scopeNote}\n\n${summary}`;
  }

  const insertAt = firstSeparator + "\n---\n".length;
  return `${summary.slice(0, insertAt)}\n${scopeNote}\n\n---\n${summary.slice(insertAt)}`;
}

// Rough estimate (~4 characters per token) of how many output tokens
// translating this report will take -- the simplified summary must cover
// every risk, scenario, and refactor step in the input, so its length scales
// with the technical report rather than staying roughly constant.
function estimateSummaryMaxTokens(technicalReport: string): number {
  return Math.min(8192, Math.max(4096, Math.ceil(technicalReport.length / 4)));
}

export async function generateSimplifiedSummary(
  client: Anthropic,
  technicalReport: string
): Promise<{ summary: string; usage: TokenUsage }> {
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: estimateSummaryMaxTokens(technicalReport),
    temperature: 0,
    system: SIMPLIFIED_SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: technicalReport }],
  });

  // Same failure class already found in generateReport's risk-extraction pass:
  // the simplified summary now translates every risk, every failure scenario,
  // and every refactor step (not a fixed 2-3 item teaser), so its output size
  // scales with the technical report instead of being roughly constant. A
  // truncated response here doesn't produce a parse error -- it produces a
  // plausible-looking PDF that just stops mid-sentence (and can leave a
  // dangling, unrendered "**" where a bold span never found its closing pair).
  // Fail loudly instead of shipping a broken file.
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "Claude's simplified-summary response was truncated (hit the max_tokens limit) before completing. This can happen on reports with many risks/scenarios/steps to translate."
    );
  }

  const text = extractTextBlock(response);

  if (text.trim().length < MIN_SUMMARY_LENGTH) {
    throw new Error(
      `Simplified summary response is too short (${text.trim().length} chars, expected at least ${MIN_SUMMARY_LENGTH}). Raw response:\n${text}`
    );
  }

  const summary = spliceScopeNote(text, technicalReport);

  const usage: TokenUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };

  return { summary, usage };
}
