// src/parser.test.ts
import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { parseFile, computeComplexity } from "./parser.js";

describe("parseFile", () => {
  it("extracts functions, classes, and imports", async () => {
    const filePath = path.resolve("fixtures/parser-basic/sample.ts");
    const result = await parseFile(filePath);

    expect(result.functions.map((f) => f.name)).toEqual(["doWork", "run"]);
    expect(result.classes.map((c) => c.name)).toEqual(["Worker"]);
    expect(result.imports).toEqual(["./helper"]);
  });

  // Regression coverage for the tree-sitter-python grammar: the package was
  // previously pinned to a version whose prebuilt .wasm was compiled at
  // language ABI 15, which web-tree-sitter (ABI 13-14) cannot load at all --
  // every .py file failed with "Incompatible language version 15" before a
  // single line of Python was ever parsed. No test caught it because there
  // was no Python coverage at all. This exercises both loading AND
  // extraction correctness, not just that the grammar loads without error.
  it("extracts functions, classes, and imports from a Python file", async () => {
    const filePath = path.resolve("fixtures/parser-basic/sample.py");
    const result = await parseFile(filePath);

    expect(result.functions.map((f) => f.name)).toEqual(["do_work", "run"]);
    expect(result.classes.map((c) => c.name)).toEqual(["Worker"]);
    expect(result.imports).toEqual(["./helper", "os"]);
  });

  // Regression coverage for a false claim found on a real report: Archie
  // named four private, module-internal helper functions as part of a
  // file's exported API (claiming "13 exported functions") and told a
  // refactor step to modify those private helpers directly -- because
  // nothing in the pipeline ever computed which functions/classes a file
  // actually exports, leaving the report-generation LLM to guess from raw
  // source text. This pins the actual detection logic per declaration
  // style: a plain function/class declaration is exported only if wrapped
  // in an export_statement; an arrow function assigned via `export const`
  // is exported via its lexical_declaration parent two levels up; a class
  // method is never independently exported regardless of its class.
  it("marks TS functions/classes as exported only when actually wrapped in an export statement", async () => {
    const filePath = path.resolve("fixtures/parser-basic/exports.ts");
    const result = await parseFile(filePath);

    const byName = (name: string) =>
      [...result.functions, ...result.classes].find((f) => f.name === name);

    expect(byName("publicFn")?.isExported).toBe(true);
    expect(byName("privateFn")?.isExported).toBe(false);
    expect(byName("publicArrow")?.isExported).toBe(true);
    expect(byName("privateArrow")?.isExported).toBe(false);
    expect(byName("PublicClass")?.isExported).toBe(true);
    expect(byName("PrivateClass")?.isExported).toBe(false);
    // A method is never independently exported, even inside an exported class.
    expect(byName("method")?.isExported).toBe(false);
  });

  it("treats a Python name as exported unless it has a leading underscore (Python's own private convention)", async () => {
    const filePath = path.resolve("fixtures/parser-basic/exports.py");
    const result = await parseFile(filePath);

    const byName = (name: string) =>
      [...result.functions, ...result.classes].find((f) => f.name === name);

    expect(byName("public_fn")?.isExported).toBe(true);
    expect(byName("_private_fn")?.isExported).toBe(false);
    expect(byName("PublicClass")?.isExported).toBe(true);
    expect(byName("_PrivateClass")?.isExported).toBe(false);
  });

  // Regression coverage for adding Go support: verifies both the
  // function_declaration/method_declaration extraction and the import_spec
  // extraction (single "fmt" import and a grouped module-path import) against
  // a real Go file, parsed with the actual tree-sitter-go.wasm grammar --
  // not asserted from memory of the grammar's node types.
  it("extracts functions, methods, and imports from a Go file", async () => {
    const filePath = path.resolve("fixtures/go-basic/widget.go");
    const result = await parseFile(filePath);

    expect(result.functions.map((f) => f.name)).toEqual(["Widget", "unexportedHelper", "Run"]);
    // Go has no class/struct-as-class equivalent in this grammar; v1
    // intentionally does not detect structs as classes.
    expect(result.classes).toEqual([]);
    expect(result.imports).toEqual(["fmt", "github.com/acme/widget/helper"]);
  });

  // Regression coverage for Go's capitalization-based export convention
  // (verified against tree-sitter-go's node-types.json: function_declaration
  // uses an `identifier` name field, method_declaration uses a
  // `field_identifier` name field and a required `receiver` field). A method
  // is always isExported: false, regardless of its name's capitalization --
  // the same "can't be imported independently of its receiver" simplification
  // already applied to JS/TS class methods above.
  it("marks Go top-level functions as exported based on capitalization, and methods as never exported", async () => {
    const filePath = path.resolve("fixtures/go-basic/widget.go");
    const result = await parseFile(filePath);

    const byName = (name: string) => result.functions.find((f) => f.name === name);

    expect(byName("Widget")?.isExported).toBe(true);
    expect(byName("unexportedHelper")?.isExported).toBe(false);
    expect(byName("Run")?.isExported).toBe(false);
  });

  // Regression coverage for a bug found running archie from a GitHub Action
  // step in a repo other than archie's own: grammarsDir was resolved via
  // path.resolve("grammars"), which resolves against process.cwd(). When
  // archie is invoked as `node archie-tool/dist/cli.js analyze .` from a
  // DIFFERENT repo's checkout root, cwd is that other repo's root, which has
  // no grammars/ directory at all -- ENOENT before a single file gets parsed,
  // regardless of how correct everything else in the pipeline is. Uses
  // vi.resetModules() to get a fresh, un-initialized parser module instance,
  // since ensureInitialized() memoizes after its first successful call and
  // would otherwise skip re-resolving the grammar path entirely.
  it("resolves grammar files relative to its own module location, not process.cwd()", async () => {
    const originalCwd = process.cwd();
    const absoluteFixturePath = path.resolve("fixtures/parser-basic/sample.ts");
    try {
      vi.resetModules();
      const freshParser = await import("./parser.js");
      process.chdir(os.tmpdir());
      const result = await freshParser.parseFile(absoluteFixturePath);
      expect(result.functions.map((f) => f.name)).toEqual(["doWork", "run"]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  // Regression coverage found via Archie's own self-analysis: ensureInitialized
  // used a bare `initialized` boolean with no single-flight guard, so
  // concurrent callers could all observe `initialized === false` before any
  // of them finished loading the grammars, each redundantly re-running
  // initialization and racing to reassign the shared language variables. Uses
  // a fresh, un-initialized module (vi.resetModules()) so the very first
  // calls genuinely race through initialization concurrently, across all
  // three languages, rather than hitting an already-memoized fast path.
  it("returns correct results for all three languages when parsed concurrently on first use", async () => {
    vi.resetModules();
    const freshParser = await import("./parser.js");

    const tsPath = path.resolve("fixtures/parser-basic/sample.ts");
    const pyPath = path.resolve("fixtures/parser-basic/sample.py");
    const branchyPath = path.resolve("fixtures/parser-basic/branchy.ts");

    const [tsResult, pyResult, branchyComplexity] = await Promise.all([
      freshParser.parseFile(tsPath),
      freshParser.parseFile(pyPath),
      freshParser.computeComplexity(branchyPath),
    ]);

    expect(tsResult.functions.map((f) => f.name)).toEqual(["doWork", "run"]);
    expect(pyResult.functions.map((f) => f.name)).toEqual(["do_work", "run"]);
    expect(branchyComplexity).toBe(5);
  });

  // Regression coverage found via Archie's own self-analysis: parseFile had
  // no error handling, so one unreadable/unparseable file in the target repo
  // (a vendored .min.js, a generated file, a symlink resolving to nothing)
  // would abort analysis of the entire repo with a raw, uncaught exception --
  // even though every other file was perfectly parseable.
  it("does not throw when a file cannot be read, returning an empty result instead", async () => {
    const nonexistentPath = path.resolve("fixtures/parser-basic/does-not-exist.ts");
    const result = await parseFile(nonexistentPath);
    expect(result).toEqual({ functions: [], classes: [], imports: [], magicNumbers: [], dangerousSinks: [] });
  });
});

describe("computeComplexity", () => {
  it("counts branches, loops, and conditionals", async () => {
    const filePath = path.resolve("fixtures/parser-basic/branchy.ts");
    const complexity = await computeComplexity(filePath);
    expect(complexity).toBe(5);
  });

  it("counts && and || operators", async () => {
    const filePath = path.resolve("fixtures/parser-basic/logical.ts");
    const complexity = await computeComplexity(filePath);
    expect(complexity).toBe(3);
  });

  it("does not throw when a file cannot be read, returning base complexity instead", async () => {
    const nonexistentPath = path.resolve("fixtures/parser-basic/does-not-exist.ts");
    const complexity = await computeComplexity(nonexistentPath);
    expect(complexity).toBe(1);
  });

  // Regression coverage for adding Go support: widget.go's Widget function
  // contains an if/else-if (2 if_statements), a for loop, a nested if inside
  // the loop, and a two-arm expression switch (case 1 / default) -- base 1 +
  // 4 if/for branches + 1 expression_case (default_case excluded, matching
  // the existing convention of not counting a switch's fallthrough arm) = 6.
  // Confirmed by running computeComplexity itself and reading off the
  // result, not by hand-counting from memory of the grammar.
  it("counts Go's if/for/switch-case branches, excluding the default arm", async () => {
    const filePath = path.resolve("fixtures/go-basic/widget.go");
    const complexity = await computeComplexity(filePath);
    expect(complexity).toBe(6);
  });
});

describe("magic number extraction", () => {
  it("does not flag a top-level `const NAME = <number>` declaration in TS", async () => {
    const filePath = path.resolve("fixtures/magic-numbers/consts.ts");
    const result = await parseFile(filePath);
    expect(result.magicNumbers.some((m) => m.value === "5")).toBe(false);
  });

  it("flags a number used inline in a condition", async () => {
    const filePath = path.resolve("fixtures/magic-numbers/consts.ts");
    const result = await parseFile(filePath);
    expect(result.magicNumbers).toContainEqual({ value: "42", line: 6 });
  });

  it("never flags 0, 1, or -1 used inline", async () => {
    const filePath = path.resolve("fixtures/magic-numbers/consts.ts");
    const result = await parseFile(filePath);
    expect(result.magicNumbers.some((m) => m.value === "0")).toBe(false);
    expect(result.magicNumbers.some((m) => m.value === "1")).toBe(false);
    expect(result.magicNumbers.some((m) => m.value === "-1")).toBe(false);
  });

  // Also pins the nesting check itself: a `const` declared INSIDE a function
  // body is not "module/top level" just because it uses the `const` keyword
  // -- TS/JS overload `const` for ordinary locals that are never reassigned,
  // not just genuine named constants, so this codebase's exemption only
  // applies to a `const` whose lexical_declaration has no function ancestor.
  it("flags a TS local `const`'s value when the declaration is nested inside a function body", async () => {
    const filePath = path.resolve("fixtures/magic-numbers/consts.ts");
    const result = await parseFile(filePath);
    expect(result.magicNumbers).toContainEqual({ value: "99", line: 31 });
  });

  it("flags a number used as a function-call argument, not inside any declaration", async () => {
    const filePath = path.resolve("fixtures/magic-numbers/consts.ts");
    const result = await parseFile(filePath);
    expect(result.magicNumbers).toContainEqual({ value: "3000", line: 27 });
  });

  // A `const`'s value being negative (`const MIN_TEMP = -40`) must not
  // defeat the const-exemption check: the declarator's `value` field points
  // at the whole `-40` unary expression, not the inner `40` literal, so the
  // const-detection logic has to unwrap through that wrapper to see it's
  // still the declaration's own value.
  it("does not flag a top-level TS `const`'s value even when it is negative", async () => {
    const filePath = path.resolve("fixtures/magic-numbers/consts.ts");
    const result = await parseFile(filePath);
    expect(result.magicNumbers.some((m) => m.value === "40" || m.value === "-40")).toBe(false);
  });

  // A negative number used inline (not inside any const) must be flagged
  // WITH its sign -- the number node's own text never includes the minus
  // (it's a sibling token), so recording node.text verbatim would silently
  // report "273" for a `-273` in the source, which doesn't match what a
  // reader would actually find on that line.
  it("flags a negative number used inline, with the sign preserved", async () => {
    const filePath = path.resolve("fixtures/magic-numbers/consts.ts");
    const result = await parseFile(filePath);
    expect(result.magicNumbers).toContainEqual({ value: "-273", line: 13 });
    expect(result.magicNumbers.some((m) => m.value === "273")).toBe(false);
  });

  // A literal type used as a value constraint (e.g. `version: 6` in an
  // interface) parses to type_annotation > literal_type > (leaf, type
  // "number") -- the same node.type collision predefined_type has with a
  // real numeric literal, just one level further down. Without exempting
  // literal_type too, a discriminated-union tag or version-literal field
  // (a pattern this very codebase's own ArchieJsonOutput.version uses)
  // would be misreported as a magic number.
  it("does not flag a TS literal-type value used as a type constraint", async () => {
    const filePath = path.resolve("fixtures/magic-numbers/consts.ts");
    const result = await parseFile(filePath);
    expect(result.magicNumbers.some((m) => m.value === "6")).toBe(false);
  });

  it("does not flag a Python module-level assignment, but flags a number used inline inside a function body", async () => {
    const filePath = path.resolve("fixtures/magic-numbers/consts.py");
    const result = await parseFile(filePath);
    expect(result.magicNumbers.some((m) => m.value === "5")).toBe(false);
    expect(result.magicNumbers).toContainEqual({ value: "42", line: 7 });
    expect(result.magicNumbers).toContainEqual({ value: "99", line: 17 });
  });

  it("does not flag a negative Python module-level assignment, but flags a negative number used inline with its sign", async () => {
    const filePath = path.resolve("fixtures/magic-numbers/consts.py");
    const result = await parseFile(filePath);
    expect(result.magicNumbers.some((m) => m.value === "40" || m.value === "-40")).toBe(false);
    expect(result.magicNumbers).toContainEqual({ value: "-273", line: 13 });
  });

  // Unlike TS/JS's overloaded `const` (also used for plain, non-constant
  // locals), Go's `const` keyword can ONLY declare a genuine named constant
  // at any scope -- there is no separate "this local never changes but isn't
  // really a constant" idiom the way TS/JS's `const` is used today. So Go's
  // exemption intentionally has no top-level/nesting requirement, unlike the
  // TS and Python cases above.
  it("does not flag a Go `const Name = <number>` declaration at any scope, but flags a number used inline in a condition", async () => {
    const filePath = path.resolve("fixtures/magic-numbers/consts.go");
    const result = await parseFile(filePath);
    expect(result.magicNumbers.some((m) => m.value === "5")).toBe(false);
    expect(result.magicNumbers.some((m) => m.value === "99")).toBe(false);
    expect(result.magicNumbers).toContainEqual({ value: "42", line: 7 });
  });

  it("does not flag a negative Go `const`'s value, but flags a negative number used inline with its sign", async () => {
    const filePath = path.resolve("fixtures/magic-numbers/consts.go");
    const result = await parseFile(filePath);
    expect(result.magicNumbers.some((m) => m.value === "40" || m.value === "-40")).toBe(false);
    expect(result.magicNumbers).toContainEqual({ value: "-273", line: 14 });
  });
});

describe("dangerous sink detection", () => {
  it("flags a literal-argument `eval` call in TS, with hasDynamicArgument false", async () => {
    const filePath = path.resolve("fixtures/security/sinks.ts");
    const result = await parseFile(filePath);
    expect(result.dangerousSinks).toContainEqual({ sink: "eval", line: 5, hasDynamicArgument: false });
  });

  it("flags an identifier-argument `eval` call in TS, with hasDynamicArgument true", async () => {
    const filePath = path.resolve("fixtures/security/sinks.ts");
    const result = await parseFile(filePath);
    expect(result.dangerousSinks).toContainEqual({ sink: "eval", line: 9, hasDynamicArgument: true });
  });

  it("flags `new Function(...)` in TS", async () => {
    const filePath = path.resolve("fixtures/security/sinks.ts");
    const result = await parseFile(filePath);
    expect(result.dangerousSinks).toContainEqual({ sink: "new Function", line: 13, hasDynamicArgument: false });
  });

  it("flags a literal-argument `execSync` call in TS, with hasDynamicArgument false", async () => {
    const filePath = path.resolve("fixtures/security/sinks.ts");
    const result = await parseFile(filePath);
    expect(result.dangerousSinks).toContainEqual({ sink: "execSync", line: 17, hasDynamicArgument: false });
  });

  // The interpolated `${dir}` is exactly the shape that makes execSync a real
  // injection risk rather than just a discouraged pattern -- a literal
  // "git status" and an attacker-influenced `rm -rf ${dir}` both call the
  // same sink, but only one of them lets external input reach a shell.
  it("flags a template-literal-with-interpolation `execSync` call in TS, with hasDynamicArgument true", async () => {
    const filePath = path.resolve("fixtures/security/sinks.ts");
    const result = await parseFile(filePath);
    expect(result.dangerousSinks).toContainEqual({ sink: "execSync", line: 21, hasDynamicArgument: true });
  });

  // execFileSync takes an argv array, not a shell string -- there is no
  // shell-interpolation footgun the way there is for execSync/exec, so it is
  // deliberately never flagged. This is also a real regression check: the
  // "eval(" text inside the preceding comment line must not leak a false
  // positive either, since detection is AST-based, not text search.
  it("does not flag `execFileSync` at all", async () => {
    const filePath = path.resolve("fixtures/security/sinks.ts");
    const result = await parseFile(filePath);
    expect(result.dangerousSinks.some((s) => s.sink === "execFileSync")).toBe(false);
  });

  it("does not flag the word `eval(` appearing only inside a comment", async () => {
    const filePath = path.resolve("fixtures/security/sinks.ts");
    const result = await parseFile(filePath);
    // The comment sits on the line directly above runExecFileSync's own
    // execFileSync call; if detection were text-based rather than AST-based,
    // this line would spuriously produce an "eval" finding.
    expect(result.dangerousSinks.some((s) => s.line === 24)).toBe(false);
  });

  it("flags Python `eval`, `exec`, and `os.system` calls", async () => {
    const filePath = path.resolve("fixtures/security/sinks.py");
    const result = await parseFile(filePath);
    expect(result.dangerousSinks).toContainEqual({ sink: "eval", line: 7, hasDynamicArgument: true });
    expect(result.dangerousSinks).toContainEqual({ sink: "exec", line: 11, hasDynamicArgument: true });
    expect(result.dangerousSinks).toContainEqual({ sink: "os.system", line: 15, hasDynamicArgument: true });
  });

  // subprocess.run/call/Popen take an argv list by default and are only a
  // shell-injection risk once `shell=True` opts back into shell
  // interpretation -- so the plain argv-list call must not be flagged, while
  // the shell=True call must be.
  it("flags Python `subprocess.run(..., shell=True)` but not the argv-list form", async () => {
    const filePath = path.resolve("fixtures/security/sinks.py");
    const result = await parseFile(filePath);
    expect(result.dangerousSinks).toContainEqual({
      sink: "subprocess.run(shell=True)",
      line: 19,
      hasDynamicArgument: true,
    });
    expect(result.dangerousSinks.some((s) => s.line === 23)).toBe(false);
  });

  // Go's exec.Command is inherently argv-based -- verified empirically (see
  // detectDangerousSinks's comment on GO scope below) -- so only the specific
  // `exec.Command("sh"/"bash", "-c", ...)` shape, where the code deliberately
  // opts back into shell interpretation, is flagged. A plain argv call like
  // exec.Command("ls", "-la") is left alone.
  it("flags Go `exec.Command(\"sh\", \"-c\", ...)` but not a plain argv `exec.Command` call", async () => {
    const filePath = path.resolve("fixtures/security/sinks.go");
    const result = await parseFile(filePath);
    expect(result.dangerousSinks).toContainEqual({
      sink: "exec.Command",
      line: 6,
      hasDynamicArgument: true,
    });
    expect(result.dangerousSinks.some((s) => s.line === 10)).toBe(false);
  });

  // The real regression case named in the task brief: cli.ts's own git-diff
  // invocation uses execFileSync (argv-based), never execSync/exec, so
  // running the actual detection against Archie's own real source must
  // produce zero dangerous-sink findings for it.
  it("does not flag any dangerous sink in Archie's own src/cli.ts (real execFileSync usage)", async () => {
    const filePath = path.resolve("src/cli.ts");
    const result = await parseFile(filePath);
    expect(result.dangerousSinks).toEqual([]);
  });
});

describe("bodyHash (structural duplicate detection)", () => {
  // The actual motivating case: two functions that clamp a string to a max
  // length, differing only in parameter/local names and the literal text of
  // their error message and truncation suffix. Renamed identifiers and
  // different string content must not affect the hash; the same builtin
  // call (Number.isFinite) is a genuine structural match.
  it("produces the same bodyHash for two functions with renamed params/locals, different string content, and the same builtin call", async () => {
    const truncate = await parseFile(path.resolve("fixtures/body-hash/truncate.ts"));
    const shorten = await parseFile(path.resolve("fixtures/body-hash/shorten.ts"));
    const truncateFn = truncate.functions.find((f) => f.name === "truncateForDisplay");
    const shortenFn = shorten.functions.find((f) => f.name === "shortenTitle");

    expect(truncateFn?.bodyHash).toBeTruthy();
    expect(truncateFn?.bodyHash).toBe(shortenFn?.bodyHash);
  });

  it("produces a different bodyHash for functions with genuinely different control flow", async () => {
    const truncate = await parseFile(path.resolve("fixtures/body-hash/truncate.ts"));
    const loop = await parseFile(path.resolve("fixtures/body-hash/different-control-flow.ts"));
    const truncateFn = truncate.functions.find((f) => f.name === "truncateForDisplay");
    const loopFn = loop.functions.find((f) => f.name === "clampWithLoop");

    expect(truncateFn?.bodyHash).not.toBe(loopFn?.bodyHash);
  });

  it("produces a different bodyHash for same-shaped functions that call different builtins", async () => {
    const numberVariant = await parseFile(path.resolve("fixtures/body-hash/uses-number-isfinite.ts"));
    const arrayVariant = await parseFile(path.resolve("fixtures/body-hash/uses-array-isarray.ts"));
    const numberFn = numberVariant.functions.find((f) => f.name === "guardNumber");
    const arrayFn = arrayVariant.functions.find((f) => f.name === "guardArray");

    expect(numberFn?.bodyHash).not.toBe(arrayFn?.bodyHash);
  });

  it("produces a valid hash for a function with zero parameters and a trivial one-line body, without crashing", async () => {
    const trivial = await parseFile(path.resolve("fixtures/body-hash/trivial.ts"));
    const trivialFn = trivial.functions.find((f) => f.name === "trivial");

    expect(typeof trivialFn?.bodyHash).toBe("string");
    expect(trivialFn?.bodyHash?.length).toBeGreaterThan(0);
  });
});
