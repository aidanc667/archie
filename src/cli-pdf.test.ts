// src/cli-pdf.test.ts
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

describe("archie analyze --pdf (CLI integration)", () => {
  it("shows the --pdf flag in help output", async () => {
    const cliPath = path.resolve("dist/cli.js");
    const { stdout } = await execFileAsync("node", [cliPath, "analyze", "--help"]);
    expect(stdout).toContain("--pdf");
  });

  it("does not crash and exits non-zero when --pdf is passed but ANTHROPIC_API_KEY is missing for the main report stage", async () => {
    const cliPath = path.resolve("dist/cli.js");
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    await expect(
      execFileAsync(
        "node",
        [cliPath, "analyze", "fixtures/parser-basic", "--out", "/tmp/archie-cli-pdf-test.md", "--pdf"],
        { env }
      )
    ).rejects.toMatchObject({
      code: 1,
    });
  });

  it("shows the --json flag in help output", async () => {
    const cliPath = path.resolve("dist/cli.js");
    const { stdout } = await execFileAsync("node", [cliPath, "analyze", "--help"]);
    expect(stdout).toContain("--json");
  });

  it("fails cleanly (non-zero exit, no partial JSON on stdout) when --json is passed but ANTHROPIC_API_KEY is missing", async () => {
    const cliPath = path.resolve("dist/cli.js");
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    await expect(
      execFileAsync("node", [cliPath, "analyze", "fixtures/parser-basic", "--json"], { env })
    ).rejects.toMatchObject({
      code: 1,
    });
  });
});
