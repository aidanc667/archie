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
