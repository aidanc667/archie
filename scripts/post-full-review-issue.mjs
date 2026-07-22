#!/usr/bin/env node
// scripts/post-full-review-issue.mjs
//
// Posts (or updates) a single, persistent GitHub Issue with the ARCHIE
// full-repo architecture review, labeled `archie-report`. Unlike
// post-pr-comment.mjs, this run is not PR-scoped: there's no diff, no PR
// number, no inline review comments, and no PR-scoped incremental delta.
// Every invocation just keeps one open issue in sync with the latest
// full-repo analysis — creating it on the first run, updating it on every
// run after that.
//
// Standalone ESM script — not part of the TypeScript build. Uses Node's native
// fetch, no extra dependencies.
//
// Usage: node scripts/post-full-review-issue.mjs <path-to-archie-json-output>
// Required env vars: GITHUB_TOKEN, REPO (owner/name)

import { readFile } from "node:fs/promises";

const SUPPORTED_VERSION = 6;

const LABEL_NAME = "archie-report";
const LABEL_DESCRIPTION = "Persistent full-repo Archie architecture review";
const LABEL_COLOR = "5319e7";

const ISSUE_TITLE = "Archie Architecture Review";

const SECTION_HEADING_RE = /## \d\. [^\n]+/g;

const SEVERITY_EMOJI = {
  Critical: "🔴",
  High: "🟡",
  Medium: "🟢",
};

const SEVERITY_ORDER = ["Critical", "High", "Medium"];

// --- Report section splitting -----------------------------------------------

export function splitSections(report) {
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

export function findSection(sections, prefix) {
  const key = Object.keys(sections).find((heading) => heading.startsWith(prefix));
  return key ? sections[key] : undefined;
}

// --- Severity badge ---------------------------------------------------------

export function buildSeverityBadge(risks) {
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

// --- Risk trend line ---------------------------------------------------------

// Minimum absolute change in averageRiskScore worth calling out — smaller
// swings are treated as noise (floating-point-level fluctuation) rather than
// a real trend.
const TREND_THRESHOLD = 0.02;

export function buildTrendLine(history) {
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

export function buildQualityCaveatLine(qualityWarnings) {
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
export function isQualityCaveatAlreadyVisible(systemSummary, verdict) {
  const haystack = `${systemSummary ?? ""}\n${verdict ?? ""}`;
  return haystack.includes("Automated grounding check flagged");
}

// --- Issue body assembly -----------------------------------------------------

export function buildIssueBody(data) {
  const { report, risks, history, qualityWarnings } = data;
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
  lines.push(`## ${ISSUE_TITLE}`);
  lines.push("");
  lines.push(systemSummary);
  lines.push("");
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

// GitHub's hard limit on an issue body is 65,536 characters. A full-repo
// report is more likely to approach that than a PR-scoped one (that's the
// whole point of this feature) -- unlike post-pr-comment.mjs, this can't
// assume the report stays small. The above-the-fold content (summary,
// badge, verdict) is what matters most and stays intact; only the bulky
// collapsed detail gets cut, with an explicit note so a truncated report
// never reads as a complete one.
const MAX_ISSUE_BODY_LENGTH = 60_000;

export function truncateIfNeeded(body) {
  if (body.length <= MAX_ISSUE_BODY_LENGTH) return body;
  const note =
    "\n\n_⚠️ This report was truncated because it exceeded GitHub's issue body size limit — see the workflow run logs for the full, untruncated report._";
  return body.slice(0, MAX_ISSUE_BODY_LENGTH - note.length) + note;
}

// --- Existing-issue lookup ---------------------------------------------------

// A degenerate state (more than one open issue carrying the label) shouldn't
// normally occur, but if it does we pick deterministically rather than error
// or silently ignore the anomaly.
export function pickReportIssue(issues) {
  if (!issues || issues.length === 0) return null;
  if (issues.length > 1) {
    const numbers = issues.map((issue) => issue.number).sort((a, b) => a - b);
    console.error(
      `Warning: found ${issues.length} open issues labeled "${LABEL_NAME}" (#${numbers.join(", #")}); using the lowest-numbered one (#${numbers[0]}).`
    );
  }
  return issues.reduce((lowest, issue) => (issue.number < lowest.number ? issue : lowest));
}

// --- Env / GitHub API plumbing ------------------------------------------------

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

// GitHub's REST API does not auto-create a label when you attach an unknown
// one to a new issue, so this has to run — and succeed — before anything
// that depends on the `archie-report` label being attachable. A 422 here
// means the label already exists, which is fine; anything else is a real
// failure.
async function ensureReportLabelExists(repo, token) {
  const labelsUrl = `https://api.github.com/repos/${repo}/labels`;
  try {
    await githubRequest(
      labelsUrl,
      {
        method: "POST",
        body: JSON.stringify({ name: LABEL_NAME, description: LABEL_DESCRIPTION, color: LABEL_COLOR }),
      },
      token,
      { exitOnError: false }
    );
    console.log(`Created label "${LABEL_NAME}".`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(`-> 422`)) {
      console.log(`Label "${LABEL_NAME}" already exists; continuing.`);
      return;
    }
    throw error;
  }
}

async function findOpenReportIssue(repo, token) {
  const searchUrl = `https://api.github.com/repos/${repo}/issues?labels=${LABEL_NAME}&state=open&per_page=100`;
  const issues = await githubRequest(searchUrl, { method: "GET" }, token);
  // GitHub's issues endpoint returns pull requests too (a PR is an issue
  // under the hood) -- exclude them so a PR that ever picked up this label
  // by accident can't have its description silently overwritten.
  return pickReportIssue(issues.filter((issue) => !issue.pull_request));
}

async function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    throw new Error("Usage: node scripts/post-full-review-issue.mjs <path-to-archie-json-output>");
  }

  const token = getRequiredEnv("GITHUB_TOKEN");
  const repo = getRequiredEnv("REPO");

  const raw = await readFile(jsonPath, "utf8");
  const data = JSON.parse(raw);

  if (data.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported Archie JSON output version: ${data.version}. This script expects version ${SUPPORTED_VERSION}. Update scripts/post-full-review-issue.mjs or pin an older Archie release.`
    );
  }

  // Ensure the label exists before doing anything else that depends on it
  // (searching by label, attaching it to a freshly-created issue).
  await ensureReportLabelExists(repo, token);

  const body = truncateIfNeeded(buildIssueBody(data));
  const existing = await findOpenReportIssue(repo, token);

  if (existing) {
    const updateUrl = `https://api.github.com/repos/${repo}/issues/${existing.number}`;
    await githubRequest(updateUrl, { method: "PATCH", body: JSON.stringify({ body }) }, token);
    console.log(`Updated existing Archie report issue (#${existing.number}).`);
  } else {
    const createUrl = `https://api.github.com/repos/${repo}/issues`;
    const created = await githubRequest(
      createUrl,
      { method: "POST", body: JSON.stringify({ title: ISSUE_TITLE, body, labels: [LABEL_NAME] }) },
      token
    );
    console.log(`Created new Archie report issue (#${created.number}).`);
  }
}

// Only run main() when this file is executed directly (e.g. via the CLI
// usage above) — not when its pure helpers are imported for local testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
