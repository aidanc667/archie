#!/usr/bin/env node
// scripts/open-fix-pr.mjs
//
// Takes whatever uncommitted working-tree changes `archie fix --yes` left
// behind, and — if there are any real ones — proposes them as a brand new
// pull request targeting the SAME branch the human is already reviewing.
// Never touches `main`/the default branch, and never pushes directly to the
// PR branch that triggered this run: the new branch is a separate proposal
// that still needs a normal human merge decision.
//
// Standalone ESM script — not part of the TypeScript build. Uses Node's
// native fetch, no extra dependencies.
//
// Usage: node scripts/open-fix-pr.mjs <pr-number>
// Required env vars: GITHUB_TOKEN, REPO (owner/name)
//
// Must be run from inside the target repo's working tree, on the PR's head
// commit, after `archie fix --report <path> --yes` has already run there
// (i.e. exactly the sequence fix-action/action.yml wires up).

import { execFileSync } from "node:child_process";

// Run artifacts left behind by earlier steps in the pipeline — not source
// changes, and never something we want to open a PR (or even commit) with.
// Mirrors the exact filtering approach `archie fix`'s dirty-tree check uses
// for `.archie-cache` in src/cli.ts, extended to the two other artifacts
// this pipeline produces (archie-output.json, archie-report.md).
const IGNORED_PATTERNS = [".archie-cache", "archie-output.json", "archie-report.md"];

function isIgnoredStatusLine(line) {
  return IGNORED_PATTERNS.some((pattern) => line.includes(pattern));
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

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

async function main() {
  const prNumber = process.argv[2];
  if (!prNumber) {
    throw new Error("Usage: node scripts/open-fix-pr.mjs <pr-number>");
  }

  const token = getRequiredEnv("GITHUB_TOKEN");
  const repo = getRequiredEnv("REPO");

  // --- Step 1: is there anything meaningful to propose at all? -------------

  let status;
  try {
    status = git(["status", "--porcelain"]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to check git status: ${message}`);
  }

  const meaningfulStatus = status
    .split("\n")
    .filter((line) => line.trim().length > 0 && !isIgnoredStatusLine(line))
    .join("\n");

  if (meaningfulStatus.trim().length === 0) {
    console.log("No changes to propose — archie fix made no accepted changes.");
    return;
  }

  // --- Step 2: find the original PR's head branch — the new PR's base ------
  // Critical safety property: the fix PR must target the branch the human is
  // already reviewing, never `main`/the default branch.

  const prUrl = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
  const originalPr = await githubRequest(prUrl, { method: "GET" }, token);
  const baseBranch = originalPr.head.ref;

  if (!baseBranch) {
    throw new Error(`Could not determine head branch for PR #${prNumber} — aborting.`);
  }

  const newBranch = `archie-fix/pr-${prNumber}-${Date.now()}`;

  // --- Steps 3-6: branch, commit, push, open PR, comment back --------------
  // Anything here failing (most notably the push, e.g. no write access from
  // this token) must surface as a clear, actionable error and a non-zero
  // exit — not be silently swallowed, since it means the fix was computed
  // but never actually proposed anywhere.

  try {
    git(["checkout", "-b", newBranch]);

    git(["config", "user.name", "archie-fix-bot"]);
    git(["config", "user.email", "archie-fix-bot@users.noreply.github.com"]);

    // Stage everything except the run artifacts, using exclude pathspecs
    // rather than `git add -A` + reset, so nothing is ever transiently staged.
    git([
      "add",
      "-A",
      "--",
      ".",
      ":!.archie-cache",
      ":!archie-output.json",
      ":!archie-report.md",
    ]);

    git(["commit", "-m", `Archie: automated fix suggestions for PR #${prNumber}`]);

    try {
      git(["push", "-u", "origin", newBranch]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `failed to push branch '${newBranch}' to origin (does the provided GITHUB_TOKEN have write access to this repo?): ${message}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`archie-fix: failed to prepare or push the fix branch: ${message}`);
    process.exit(1);
  }

  const newPrBody = [
    "This PR was opened automatically by **Archie Fix** in response to a `/archie fix` command on " +
      `#${prNumber}.`,
    "",
    "These are **automated, unreviewed** refactor suggestions produced by a headless Claude Code agent, " +
      "verified only by build/test passing after each step. Nothing here has been reviewed by a human yet.",
    "",
    `It targets \`${baseBranch}\` (the same branch #${prNumber} is on) rather than the default branch, ` +
      "so it can be reviewed and merged (or closed) like any other PR — merging is a normal human decision; " +
      "nothing auto-merges.",
  ].join("\n");

  const createPrUrl = `https://api.github.com/repos/${repo}/pulls`;
  const newPr = await githubRequest(
    createPrUrl,
    {
      method: "POST",
      body: JSON.stringify({
        title: `Archie: automated fix suggestions for #${prNumber}`,
        head: newBranch,
        base: baseBranch,
        body: newPrBody,
      }),
    },
    token
  );

  console.log(`Opened fix PR #${newPr.number}: ${newPr.html_url}`);

  const commentUrl = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  const commentBody =
    `Archie ran \`/archie fix\` and opened #${newPr.number} with its suggested changes, targeting this PR's branch ` +
    `(\`${baseBranch}\`). These are automated and unreviewed — please review #${newPr.number} like any other PR ` +
    "before merging it.";
  await githubRequest(
    commentUrl,
    { method: "POST", body: JSON.stringify({ body: commentBody }) },
    token
  );

  console.log(`Commented on #${prNumber} with a link to #${newPr.number}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
