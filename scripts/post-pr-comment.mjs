#!/usr/bin/env node
// scripts/post-pr-comment.mjs
//
// Posts (or updates) a single PR comment with the ARCHIE architecture review,
// and (best-effort) posts inline PR review comments for risks anchored to
// files that are actually part of the PR's diff.
//
// Standalone ESM script — not part of the TypeScript build. Uses Node's native
// fetch, no extra dependencies.
//
// Usage: node scripts/post-pr-comment.mjs <path-to-archie-json-output>
// Required env vars: GITHUB_TOKEN, REPO (owner/name), PR_NUMBER, PR_HEAD_SHA

import { readFile } from "node:fs/promises";

const MARKER = "<!-- archie-pr-review -->";
const STATE_RE = /<!-- archie-pr-review-state:(.*?) -->/;
const SUPPORTED_VERSION = 6;

const SECTION_HEADING_RE = /## \d\. [^\n]+/g;

const SEVERITY_EMOJI = {
  Critical: "🔴",
  High: "🟡",
  Medium: "🟢",
};

const SEVERITY_ORDER = ["Critical", "High", "Medium"];

function splitSections(report) {
  const headings = [...report.matchAll(SECTION_HEADING_RE)];
  const sections = {};
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i][0];
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : report.length;
    sections[heading] = report.slice(start, end).trim();
  }
  return sections;
}

function findSection(sections, prefix) {
  const key = Object.keys(sections).find((heading) => heading.startsWith(prefix));
  return key ? sections[key] : undefined;
}

function scopeLine(diff, graph) {
  if (diff.scoped) {
    return `_Analyzed ${diff.changedFileCount} changed file${diff.changedFileCount === 1 ? "" : "s"} in this diff, ${graph.edgeCount} dependency edges._`;
  }
  if (diff.requested) {
    return `_No changed source files detected in this diff — ran a full-repo analysis instead: ${graph.fileCount} files, ${graph.edgeCount} dependency edges._`;
  }
  return `_Analyzed ${graph.fileCount} files, ${graph.edgeCount} dependency edges._`;
}

// --- Severity badge -------------------------------------------------------

function buildSeverityBadge(risks) {
  if (!risks || risks.length === 0) {
    return "_No architectural risks flagged._";
  }
  const counts = {};
  for (const risk of risks) {
    counts[risk.severity] = (counts[risk.severity] ?? 0) + 1;
  }
  const parts = SEVERITY_ORDER.filter((severity) => counts[severity]).map(
    (severity) => `${SEVERITY_EMOJI[severity] ?? "⚪"} ${counts[severity]} ${severity}`
  );
  return `**${parts.join(" · ")}**`;
}

// --- Diff-anchorable risk partitioning ------------------------------------

function partitionDiffAnchorableRisks(risks, changedFiles) {
  const changedSet = new Set(changedFiles ?? []);
  const anchorable = [];
  const general = [];
  for (const risk of risks ?? []) {
    if (changedSet.has(risk.file)) {
      anchorable.push(risk);
    } else {
      general.push(risk);
    }
  }
  return { anchorable, general };
}

function formatInlineRiskComment(risk) {
  const lines = [];
  lines.push(`**${SEVERITY_EMOJI[risk.severity] ?? "⚪"} ${risk.severity} — ${risk.title}**`);
  lines.push("");
  lines.push(`**Why it matters:** ${risk.why_it_matters}`);
  lines.push(`**Root cause:** ${risk.root_cause}`);
  lines.push(`**Evidence:** ${risk.evidence}`);
  lines.push("");
  lines.push(`_complexity=${risk.complexity} · fanIn=${risk.fanIn} · loc=${risk.loc}_`);
  return lines.join("\n");
}

function buildReviewComments(anchorableRisks) {
  return anchorableRisks.map((risk) => ({
    path: risk.file,
    line: 1,
    side: "RIGHT",
    body: formatInlineRiskComment(risk),
  }));
}

// --- Risk trend line ---------------------------------------------------------

// Minimum absolute change in averageRiskScore worth calling out — smaller
// swings are treated as noise (floating-point-level fluctuation) rather than
// a real trend.
const TREND_THRESHOLD = 0.02;

function buildTrendLine(history) {
  if (!history || !history.previous) return null;
  const prev = history.previous.averageRiskScore;
  const curr = history.current.averageRiskScore;
  const delta = curr - prev;
  if (delta >= TREND_THRESHOLD) {
    return `📈 Average risk score trending up: ${prev.toFixed(2)} → ${curr.toFixed(2)} since last review`;
  }
  if (delta <= -TREND_THRESHOLD) {
    return `📉 Average risk score trending down: ${prev.toFixed(2)} → ${curr.toFixed(2)} since last review`;
  }
  return null;
}

// --- Quality-warning caveat --------------------------------------------------

function buildQualityCaveatLine(qualityWarnings) {
  if (!qualityWarnings || qualityWarnings.length === 0) return null;
  const count = qualityWarnings.length;
  return `⚠️ Automated grounding check flagged ${count} potential issue${count === 1 ? "" : "s"} in this report — see below.`;
}

// generateReport (src/reasoning.ts) splices its own "Automated grounding
// check flagged" blockquote directly after the scope statement, which lands
// inside the "## 1." slice once split by splitSections() -- i.e. inside
// `systemSummary`, not inside any of the collapsed "## 2./3./4." sections.
// `systemSummary` and `verdict` are both rendered above the fold already, so
// check the actual assembled visible text rather than assume where the
// blockquote ends up -- avoids double-rendering the same caveat if the
// report assembly ever changes.
function isQualityCaveatAlreadyVisible(systemSummary, verdict) {
  const haystack = `${systemSummary ?? ""}\n${verdict ?? ""}`;
  return haystack.includes("Automated grounding check flagged");
}

// --- Incremental delta -----------------------------------------------------

function parsePriorState(body) {
  if (!body) return null;
  const match = body.match(STATE_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed && Array.isArray(parsed.riskTitles)) {
      return { riskTitles: parsed.riskTitles };
    }
    return null;
  } catch {
    return null;
  }
}

function buildStateComment(riskTitles) {
  return `<!-- archie-pr-review-state:${JSON.stringify({ riskTitles })} -->`;
}

function buildDeltaLine(previousTitles, currentTitles) {
  if (!previousTitles) return null;
  const prevSet = new Set(previousTitles);
  const currSet = new Set(currentTitles);
  const resolved = [...prevSet].filter((title) => !currSet.has(title));
  const added = [...currSet].filter((title) => !prevSet.has(title));
  if (resolved.length === 0 && added.length === 0) return null;
  const clauses = [];
  if (resolved.length > 0) clauses.push(`${resolved.length} resolved`);
  if (added.length > 0) clauses.push(`${added.length} new`);
  return `_Since last review: ${clauses.join(", ")}._`;
}

// --- Comment body assembly --------------------------------------------------

function formatCommentBody(data, deltaLine) {
  const { report, graph, diff, risks, history, qualityWarnings } = data;
  const sections = splitSections(report);

  const systemSummary = findSection(sections, "## 1.") ?? "_System summary not available._";
  const verdict = findSection(sections, "## 5.");
  const collapsedSections = ["## 2.", "## 3.", "## 4."]
    .map((prefix) => findSection(sections, prefix))
    .filter((section) => section !== undefined);

  const badge = buildSeverityBadge(risks);
  const trendLine = buildTrendLine(history);
  const qualityCaveatLine = isQualityCaveatAlreadyVisible(systemSummary, verdict)
    ? null
    : buildQualityCaveatLine(qualityWarnings);

  const lines = [];
  lines.push(MARKER);
  lines.push(buildStateComment((risks ?? []).map((risk) => risk.title)));
  lines.push("## Archie Architecture Review");
  lines.push("");
  lines.push(systemSummary);
  lines.push("");
  lines.push(scopeLine(diff, graph));
  lines.push("");
  if (deltaLine) {
    lines.push(deltaLine);
    lines.push("");
  }
  lines.push(badge);
  const aboveFoldExtras = [trendLine, qualityCaveatLine].filter(Boolean);
  if (aboveFoldExtras.length > 0) {
    lines.push(aboveFoldExtras.join("\n"));
  }
  lines.push("");
  if (verdict) {
    lines.push(verdict);
    lines.push("");
  }
  lines.push("<details>");
  lines.push("<summary>Full architecture review</summary>");
  lines.push("");
  lines.push(collapsedSections.join("\n\n"));
  lines.push("");
  lines.push("</details>");

  return lines.join("\n");
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function githubRequest(url, options, token, { exitOnError = true } = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const bodyText = await res.text();
    const message = `GitHub API request failed: ${options.method ?? "GET"} ${url} -> ${res.status}\n${bodyText}`;
    if (exitOnError) {
      console.error(message);
      process.exit(1);
    }
    throw new Error(message);
  }
  return res.json();
}

async function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    throw new Error("Usage: node scripts/post-pr-comment.mjs <path-to-archie-json-output>");
  }

  const token = getRequiredEnv("GITHUB_TOKEN");
  const repo = getRequiredEnv("REPO");
  const prNumber = getRequiredEnv("PR_NUMBER");
  const prHeadSha = getRequiredEnv("PR_HEAD_SHA");

  const raw = await readFile(jsonPath, "utf8");
  const data = JSON.parse(raw);

  if (data.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported Archie JSON output version: ${data.version}. This script expects version ${SUPPORTED_VERSION}. Update scripts/post-pr-comment.mjs or pin an older Archie release.`
    );
  }

  const risks = data.risks ?? [];
  const changedFiles = data.diff?.changedFiles ?? [];
  const { anchorable } = partitionDiffAnchorableRisks(risks, changedFiles);

  const commentsUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`;
  const comments = await githubRequest(commentsUrl, { method: "GET" }, token);

  const existing = comments.find((comment) => comment.body?.includes(MARKER));

  const priorState = existing ? parsePriorState(existing.body) : null;
  const currentTitles = risks.map((risk) => risk.title);
  const deltaLine = existing ? buildDeltaLine(priorState?.riskTitles ?? null, currentTitles) : null;

  const body = formatCommentBody(data, deltaLine);

  if (existing) {
    const updateUrl = `https://api.github.com/repos/${repo}/issues/comments/${existing.id}`;
    await githubRequest(updateUrl, { method: "PATCH", body: JSON.stringify({ body }) }, token);
    console.log(`Updated existing Archie review comment (id ${existing.id}).`);
  } else {
    const createUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
    const created = await githubRequest(createUrl, { method: "POST", body: JSON.stringify({ body }) }, token);
    console.log(`Created new Archie review comment (id ${created.id}).`);
  }

  // Inline review comments are a best-effort addition — any failure here
  // (bad SHA, permissions, etc.) must never take down the main issue
  // comment above, which already succeeded by this point.
  if (anchorable.length === 0) {
    console.log("No diff-anchorable risks found; skipping inline review comments.");
  } else {
    try {
      const reviewUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`;
      const reviewPayload = {
        commit_id: prHeadSha,
        event: "COMMENT",
        body: `Archie found ${anchorable.length} architecture risk${anchorable.length === 1 ? "" : "s"} anchored inline below.`,
        comments: buildReviewComments(anchorable),
      };
      await githubRequest(reviewUrl, { method: "POST", body: JSON.stringify(reviewPayload) }, token, {
        exitOnError: false,
      });
      console.log(`Posted inline review with ${anchorable.length} risk comment(s).`);
    } catch (error) {
      console.error("Warning: failed to post inline Archie review comments; continuing.", error);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
