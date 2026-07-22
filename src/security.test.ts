// src/security.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { detectHardcodedSecrets } from "./security.js";

describe("detectHardcodedSecrets", () => {
  it("flags an AWS-shaped access key with the correct rule id and line number", () => {
    const source = [
      "const config = {};",
      'const awsKey = "AKIAIOSFODNN7EXAMPLE";',
    ].join("\n");
    const findings = detectHardcodedSecrets(source);
    expect(findings).toContainEqual({ ruleId: "aws-access-key", line: 2 });
  });

  it("flags a private-key-block header line with the correct rule id and line number", () => {
    const source = [
      "const privateKey = `",
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFErFakeFakeFake",
      "-----END RSA PRIVATE KEY-----",
      "`;",
    ].join("\n");
    const findings = detectHardcodedSecrets(source);
    expect(findings).toContainEqual({ ruleId: "private-key-block", line: 2 });
  });

  it("flags a generic secret-shaped assignment of at least 12 characters", () => {
    const source = 'const apiKey = "sk-test-abcdefghijklmnopqrstuvwxyz";';
    const findings = detectHardcodedSecrets(source);
    expect(findings).toContainEqual({ ruleId: "generic-secret-assignment", line: 1 });
  });

  it("does not flag an env-var reference as a generic secret assignment", () => {
    const jsSource = "const apiKey = process.env.API_KEY;";
    const pySource = 'api_key = os.environ["API_KEY"]';
    const pyGetenvSource = 'api_key = os.getenv("API_KEY")';
    expect(detectHardcodedSecrets(jsSource)).toEqual([]);
    expect(detectHardcodedSecrets(pySource)).toEqual([]);
    expect(detectHardcodedSecrets(pyGetenvSource)).toEqual([]);
  });

  it("does not flag obvious placeholder values", () => {
    expect(detectHardcodedSecrets('const secret = "changeme";')).toEqual([]);
    expect(detectHardcodedSecrets('const apiKey = "<YOUR_API_KEY>";')).toEqual([]);
    expect(detectHardcodedSecrets('const token = "example-value-here";')).toEqual([]);
    expect(detectHardcodedSecrets('const password = "xxxxxxxxxxxx";')).toEqual([]);
  });

  it("does not flag a secret-shaped value shorter than 12 characters", () => {
    expect(detectHardcodedSecrets('const apiKey = "short1";')).toEqual([]);
  });

  it("never includes the raw matched secret text anywhere in a finding, even as a fragment", () => {
    const plantedSecret = "zK9mQ7pL2xR8vT4wN6bY1cD3eF5gH0jA";
    const source = `const apiKey = "${plantedSecret}";`;
    const findings = detectHardcodedSecrets(source);

    // Sanity check: this fixture should actually produce a finding, otherwise
    // the "no leakage" assertion below would be vacuously true.
    expect(findings.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain(plantedSecret);
    // Also check partial fragments don't leak (e.g. a truncated preview).
    expect(serialized).not.toContain(plantedSecret.slice(0, 10));
    expect(serialized).not.toContain(plantedSecret.slice(-10));
  });

  it("reports multiple distinct findings in one file, each with the correct line number", () => {
    const source = [
      'const awsKey = "AKIAIOSFODNN7EXAMPLE";', // line 1
      'const apiKey = "sk-test-abcdefghijklmnopqrstuvwxyz";', // line 2
      "-----BEGIN EC PRIVATE KEY-----", // line 3
    ].join("\n");
    const findings = detectHardcodedSecrets(source);
    expect(findings).toContainEqual({ ruleId: "aws-access-key", line: 1 });
    expect(findings).toContainEqual({ ruleId: "generic-secret-assignment", line: 2 });
    expect(findings).toContainEqual({ ruleId: "private-key-block", line: 3 });
    expect(findings.length).toBe(3);
  });

  it("returns an empty array for a file with no secret-shaped content", () => {
    const source = [
      "function add(a, b) {",
      "  return a + b;",
      "}",
    ].join("\n");
    expect(detectHardcodedSecrets(source)).toEqual([]);
  });

  it("detects secrets across TS, Python, and Go fixture files using the same language-agnostic regex approach", () => {
    const tsSource = fs.readFileSync(path.resolve("fixtures/security/secrets.ts"), "utf-8");
    const pySource = fs.readFileSync(path.resolve("fixtures/security/secrets.py"), "utf-8");
    const goSource = fs.readFileSync(path.resolve("fixtures/security/secrets.go"), "utf-8");

    for (const source of [tsSource, pySource, goSource]) {
      const findings = detectHardcodedSecrets(source);
      const ruleIds = findings.map((f) => f.ruleId);
      expect(ruleIds).toContain("aws-access-key");
      expect(ruleIds).toContain("private-key-block");
      expect(ruleIds).toContain("generic-secret-assignment");
      // The env-var reference and placeholder lines in each fixture must not
      // contribute extra generic-secret-assignment findings beyond the one
      // intentional flaggable case.
      expect(ruleIds.filter((id) => id === "generic-secret-assignment").length).toBe(1);
    }
  });

  it("detects Go's `:=` short assignment operator as a generic secret assignment (distinct syntax from `=`)", () => {
    const source = 'apiKey := "sk-test-abcdefghijklmnopqrstuvwxyz"';
    const findings = detectHardcodedSecrets(source);
    expect(findings).toContainEqual({ ruleId: "generic-secret-assignment", line: 1 });
  });
});
