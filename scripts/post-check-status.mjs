#!/usr/bin/env node
// scripts/post-check-status.mjs
//
// Posts a GitHub Check Run reporting whether Archie found any risks at or
// above a configured severity threshold, so a repo owner can wire branch
// protection to block a merge on it.
//
// Standalone ESM script — not part of the TypeScript build. Uses Node's native
// fetch, no extra dependencies.
//
// Usage: node scripts/post-check-status.mjs <path-to-archie-json-output>
// Required env vars: GITHUB_TOKEN, REPO (owner/name), PR_HEAD_SHA,
// FAIL_ON_SEVERITY (one of "none" | "Critical" | "High" | "Medium")

import { readFile } from "node:fs/promises";

const CHECK_NAME = "Archie Architecture Review";
const SUPPORTED_VERSION = 5;

// Higher rank == more severe. "none" is handled separately as a special case
// (severity gating disabled) rather than given a rank.
const SEVERITY_RANK = {
  Critical: 3,
  High: 2,
  Medium: 1,
};

// --- Pure helpers (exported for local/manual testing without hitting the network) --

export function filterRisksAboveThreshold(risks, threshold) {
  if (threshold === "none") {
    return [];
  }
  const thresholdRank = SEVERITY_RANK[threshold];
  if (thresholdRank === undefined) {
    throw new Error(`Unknown FAIL_ON_SEVERITY value: ${threshold}`);
  }
  return (risks ?? []).filter((risk) => SEVERITY_RANK[risk.severity] >= thresholdRank);
}

function buildOffendingTitle(offendingRisks, threshold) {
  if (offendingRisks.length === 0) {
    return `No risks at or above the ${threshold} threshold`;
  }
  const severities = new Set(offendingRisks.map((risk) => risk.severity));
  if (severities.size === 1) {
    const [severity] = severities;
    return `${offendingRisks.length} ${severity} risk(s) found`;
  }
  return `${offendingRisks.length} risk(s) at or above the ${threshold} threshold`;
}

function buildOffendingSummary(offendingRisks, threshold) {
  if (offendingRisks.length === 0) {
    return `No risks met the configured ${threshold} threshold.`;
  }
  return offendingRisks
    .map((risk) => `- **${risk.severity}** — ${risk.title} (\`${risk.file}\`)`)
    .join("\n");
}

export function buildCheckRunPayload(risks, threshold, headSha) {
  const allRisks = risks ?? [];

  if (threshold === "none") {
    return {
      name: CHECK_NAME,
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      output: {
        title: `Archie found ${allRisks.length} risk(s); severity gating disabled`,
        summary: `Archie found ${allRisks.length} risk(s); severity gating is disabled.`,
      },
    };
  }

  const offendingRisks = filterRisksAboveThreshold(allRisks, threshold);
  const conclusion = offendingRisks.length > 0 ? "failure" : "success";

  return {
    name: CHECK_NAME,
    head_sha: headSha,
    status: "completed",
    conclusion,
    output: {
      title: buildOffendingTitle(offendingRisks, threshold),
      summary: buildOffendingSummary(offendingRisks, threshold),
    },
  };
}

// --- Env / GitHub API plumbing --------------------------------------------

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
    throw new Error("Usage: node scripts/post-check-status.mjs <path-to-archie-json-output>");
  }

  const token = getRequiredEnv("GITHUB_TOKEN");
  const repo = getRequiredEnv("REPO");
  const headSha = getRequiredEnv("PR_HEAD_SHA");
  const failOnSeverity = getRequiredEnv("FAIL_ON_SEVERITY");

  const raw = await readFile(jsonPath, "utf8");
  const data = JSON.parse(raw);

  if (data.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported Archie JSON output version: ${data.version}. This script expects version ${SUPPORTED_VERSION}. Update scripts/post-check-status.mjs or pin an older Archie release.`
    );
  }

  const payload = buildCheckRunPayload(data.risks, failOnSeverity, headSha);

  const checkRunsUrl = `https://api.github.com/repos/${repo}/check-runs`;
  const created = await githubRequest(
    checkRunsUrl,
    { method: "POST", body: JSON.stringify(payload) },
    token
  );

  console.log(
    `Posted check run "${payload.name}" (id ${created.id}) with conclusion "${payload.conclusion}": ${payload.output.title}`
  );
}

// Only run main() when this file is executed directly (e.g. via the CLI
// usage above) — not when its pure helpers are imported for local testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
