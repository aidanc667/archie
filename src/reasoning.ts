// src/reasoning.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { ContextPack } from "./summarizer.js";

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

const SYSTEM_PROMPT = `You are a Staff Engineer writing a formal architecture review for a software engineering team.
You will be given a Context Pack: a system summary, top-risk files with full source code and metrics
(complexity, fan-in, LOC, dependency depth, hasTests), a dependency graph snapshot, and optionally
cluster-level aggregates for large repos.

Your job is to write a clear, honest, actionable report that helps the reader understand exactly what
is risky, why it matters, and precisely what to do about it — in priority order.

Grounding rules (follow strictly):
- Only reason from facts in the Context Pack. Never invent files, functions, or relationships.
${ABSENCE_CLAIM_RULE}
- Every risk and finding must cite a specific file, function, or metric from the Context Pack.
  Format citations inline as \`filename.ts\` or \`filename.ts → functionName\`. No bare assertions.

---

Respond with exactly these five sections, using these exact headings. No extra sections.

## 1. System Summary

Write 3-5 sentences covering:
- What this system does and its apparent purpose
- The tech stack as you can infer it from file names, imports, and structure
- Scale indicators: total files, LOC, rough complexity level (simple / moderate / complex)
- One sentence on overall architectural style (e.g. "monolithic with a clean pipeline pattern" or "loosely coupled modules with a central orchestrator")

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
> [A complete, self-contained instruction for an AI coding agent. Include: the exact file and function to change, what to change and how, the specific bug or problem being fixed, and a clear acceptance criterion ("this step is done when X"). Write this as a direct imperative. The agent has no other context — everything it needs must be in this block. Minimum 3 sentences.]

---

## 5. Senior Engineer Verdict

Write a final assessment covering:
- **Overall health rating:** [one of: Needs significant work / Functional but fragile / Solid foundation / Production-ready]
- **Biggest strength:** One specific, evidenced positive about this codebase.
- **Biggest risk:** One sentence on the single most dangerous unresolved issue.
- **Recommended first action:** Exactly one thing the team should do this week, specific enough to assign to a developer.
- A closing paragraph (3-5 sentences) that gives an honest overall picture — is this codebase ready to scale, or does it need foundational work first? Who is this team, based on what you see? What trajectory are they on?`;

interface RiskFinding {
  title: string;
  file: string;
  severity: "Critical" | "High" | "Medium";
  confidence: "high" | "medium" | "low";
  why_it_matters: string;
  root_cause: string;
  evidence: string;
}

const REPORT_RISKS_TOOL: Anthropic.Tool = {
  name: "report_risks",
  description: "Report the top architectural risks as structured data.",
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
          },
          required: [
            "title",
            "file",
            "severity",
            "confidence",
            "why_it_matters",
            "root_cause",
            "evidence",
          ],
        },
      },
    },
    required: ["risks"],
  },
};

const CONFIDENCE_RULES = `Confidence scoring for each risk:
- "high": the finding cites a file whose full \`source\` is in the context pack (i.e. it's in the top-3 detail files)
- "medium": the finding cites a file that is in \`topRiskFiles\` but has a signature summary only (not full source)
- "low": the finding is based on graph topology/metrics alone without source visibility

For each risk, also provide:
- "severity": one of Critical / High / Medium, based on the real-world consequence and blast radius of this risk materialising.
- "root_cause": 1-2 sentences on the specific technical reason this is risky. Reference the metric or source code evidence, e.g. "fanIn=14 means 14 files depend on this module — a breaking change here cascades across the entire codebase."`;

function extractTextBlock(response: Anthropic.Messages.Message): string {
  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock && "text" in textBlock ? textBlock.text : "";
}

const REQUIRED_RISK_FIELDS = [
  "title",
  "file",
  "severity",
  "confidence",
  "why_it_matters",
  "root_cause",
  "evidence",
] as const;

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
    for (const field of REQUIRED_RISK_FIELDS) {
      const value = (risk as Record<string, unknown>)[field];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(
          `report_risks tool call returned a malformed risk at index ${i}: "${field}" is missing or empty. This usually means the response was truncated by the token limit.`
        );
      }
    }
  });
  return risks as RiskFinding[];
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
    if (risk.confidence === "medium" || risk.confidence === "low") {
      lines.push(CONFIDENCE_CAVEATS[risk.confidence]);
    }
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
        model: "claude-sonnet-4-6",
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

export async function generateReport(
  client: Anthropic,
  pack: ContextPack
): Promise<{ report: string; usage: TokenUsage }> {
  const { risks, usage: risksUsage } = await extractRisks(client, pack);

  const risksSection = formatRisksSection(risks);
  const scopeStatement = buildScopeStatement(pack);

  // Pass 2: remaining sections with structured risks as context
  const remainingSectionsPrompt = `You are writing an architecture report. The "Top 5 Architectural Risks" section has already been generated (shown below). Write only sections 1, 3, 4, and 5 — do NOT include section 2.

Here are the structured risks for your reference when writing sections 3, 4, and 5:
${JSON.stringify(risks, null, 2)}

Context Pack:
${JSON.stringify(pack, null, 2)}

Write exactly these four sections with these exact headings (no section 2):
## 1. System Summary
## 3. Production Failure Scenarios
## 4. Refactor Plan (step-by-step)
## 5. Senior Engineer Verdict`;

  const remainingResponse = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 6144,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: remainingSectionsPrompt }],
  });

  const remainingText = extractTextBlock(remainingResponse);

  // Assemble final report: inject risks section between section 1 and section 3
  const section1Match = remainingText.match(/(## 1\. System Summary[\s\S]*?)(?=## 3\.)/);
  const section345Match = remainingText.match(/(## 3\.[\s\S]*)/);

  let finalReport: string;
  if (section1Match && section345Match) {
    finalReport = `${section1Match[1].trimEnd()}\n\n${scopeStatement}\n\n${risksSection}\n\n${section345Match[1]}`;
  } else {
    // Fallback: prepend scope statement and risks section to the response
    finalReport = `${remainingText.split("## 3.")[0].trimEnd()}\n\n${scopeStatement}\n\n${risksSection}\n\n## 3.${remainingText.split("## 3.").slice(1).join("## 3.")}`;
  }

  if (!validateReportSections(finalReport)) {
    throw new Error(
      `Assembled report is missing required sections. Raw response:\n${finalReport}`
    );
  }

  const usage: TokenUsage = {
    inputTokens: risksUsage.inputTokens + remainingResponse.usage.input_tokens,
    outputTokens: risksUsage.outputTokens + remainingResponse.usage.output_tokens,
  };

  return { report: finalReport, usage };
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

export async function generateSimplifiedSummary(
  client: Anthropic,
  technicalReport: string
): Promise<{ summary: string; usage: TokenUsage }> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
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
