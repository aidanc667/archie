// fixtures/security/sinks.ts
import { execSync, execFileSync } from "node:child_process";

export function runLiteralEval(): unknown {
  return eval("some code");
}

export function runDynamicEval(userInput: string): unknown {
  return eval(userInput);
}

export function makeDynamicFunction(): () => number {
  return new Function("return 1") as () => number;
}

export function runLiteralExecSync(): Buffer {
  return execSync("git status");
}

export function runDynamicExecSync(dir: string): Buffer {
  return execSync(`rm -rf ${dir}`);
}

// eval("this text must never be flagged -- it's inside a comment, not code")
export function runExecFileSync(): Buffer {
  return execFileSync("git", ["diff"]);
}
