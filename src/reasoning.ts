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

const SYSTEM_PROMPT = `You are a Staff Engineer evaluating a codebase's architecture.
You will be given a Context Pack: a system summary, top-risk files with metrics,
a compressed dependency graph snapshot, and (if the repo is large) cluster-level
aggregates instead of per-file detail.

Rules:
- Only reason from facts present in the Context Pack. Never invent files, functions,
  dependencies, or relationships not present in the data given to you.
- If the Context Pack lacks the detail needed to support a claim, say
  "insufficient visibility" rather than guessing.
- Always respond with exactly these five sections, in this order, using these
  exact headings:
1. System Summary
2. Top 5 Architectural Risks
3. Production Failure Scenarios
4. Refactor Plan (step-by-step)
5. Senior Engineer Verdict
Do not add, omit, or reorder sections.`;

export async function generateReport(
  client: Anthropic,
  pack: ContextPack
): Promise<string> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(pack, null, 2) }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text : "";

  if (!validateReportSections(text)) {
    throw new Error(
      `Claude response is missing required sections. Raw response:\n${text}`
    );
  }

  return text;
}

const MIN_SUMMARY_LENGTH = 100;

const SIMPLIFIED_SUMMARY_SYSTEM_PROMPT = `You are translating a technical software architecture report into a short summary for a non-technical reader — e.g. a founder, product manager, or investor evaluating the team and product, not the code.

Rules:
- No jargon, no file paths, no line numbers, no complexity scores or other code-level metrics.
- Focus on business-level risk: what could go wrong for users or the company, not what could go wrong in a specific function.
- Keep it short — roughly a third to a half the length of the original report. It should be readable in about two minutes.
- Use a loose, readable structure: what the system does, the 2-3 things most worth worrying about, and the bottom-line recommendation. Do not use the original report's five-section heading structure.
- Base everything on the technical report given to you. Do not invent details not present in it.`;

export async function generateSimplifiedSummary(
  client: Anthropic,
  technicalReport: string
): Promise<string> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SIMPLIFIED_SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: technicalReport }],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text : "";

  if (text.trim().length < MIN_SUMMARY_LENGTH) {
    throw new Error(
      `Simplified summary response is too short (${text.trim().length} chars, expected at least ${MIN_SUMMARY_LENGTH}). Raw response:\n${text}`
    );
  }

  return text;
}
