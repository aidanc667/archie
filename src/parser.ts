// src/parser.ts
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Parser from "web-tree-sitter";

// Resolved relative to this module's own compiled location (dist/parser.js),
// not process.cwd() -- archie is frequently invoked from a directory other
// than its own repo root (e.g. a GitHub Action step that checks out a
// different target repo and runs `node archie-tool/dist/cli.js ...` from
// that repo's root). Resolving "grammars" against cwd in that case looks for
// a grammars/ directory in the TARGET repo instead of archie's own, and
// fails with a raw ENOENT no matter how correct the rest of the pipeline is.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface ParsedFunction {
  name: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  // Structural hash of this function's normalized body -- see
  // computeBodyHash below for what "normalized" means and why.
  bodyHash: string;
}

export interface ParsedClass {
  name: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
}

export interface MagicNumberOccurrence {
  value: string;
  line: number;
}

export interface DangerousSinkOccurrence {
  sink: string; // e.g. "eval", "execSync", "os.system", "subprocess.run(shell=True)"
  line: number;
  hasDynamicArgument: boolean;
}

export interface ParsedFile {
  functions: ParsedFunction[];
  classes: ParsedClass[];
  imports: string[];
  magicNumbers: MagicNumberOccurrence[];
  dangerousSinks: DangerousSinkOccurrence[];
}

let tsLanguage: Parser.Language | undefined;
let jsLanguage: Parser.Language | undefined;
let pyLanguage: Parser.Language | undefined;
let goLanguage: Parser.Language | undefined;

// Single-flight guard found missing via Archie's own self-analysis: a bare
// `initialized` boolean lets concurrent callers all observe `false` before
// any of them finishes awaiting Parser.init() and the three grammar loads,
// so each would redundantly re-run initialization and race to reassign
// tsLanguage/jsLanguage/pyLanguage. Sharing one in-flight promise means every
// caller, no matter how many arrive concurrently, awaits the exact same
// initialization instead of racing to start their own.
let initPromise: Promise<void> | undefined;

function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await Parser.init();
      const grammarsDir = path.resolve(MODULE_DIR, "..", "grammars");
      tsLanguage = await Parser.Language.load(
        path.join(grammarsDir, "tree-sitter-typescript.wasm")
      );
      jsLanguage = await Parser.Language.load(
        path.join(grammarsDir, "tree-sitter-javascript.wasm")
      );
      pyLanguage = await Parser.Language.load(
        path.join(grammarsDir, "tree-sitter-python.wasm")
      );
      goLanguage = await Parser.Language.load(
        path.join(grammarsDir, "tree-sitter-go.wasm")
      );
    })();
  }
  return initPromise;
}

function languageFor(filePath: string): Parser.Language {
  const ext = path.extname(filePath);
  if (ext === ".ts" || ext === ".tsx") return tsLanguage!;
  if (ext === ".py") return pyLanguage!;
  if (ext === ".go") return goLanguage!;
  return jsLanguage!;
}

function walkTree(
  node: Parser.SyntaxNode,
  visit: (node: Parser.SyntaxNode) => void
): void {
  visit(node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkTree(child, visit);
  }
}

function pythonRelativeToPath(moduleText: string): string | undefined {
  let i = 0;
  while (i < moduleText.length && moduleText[i] === ".") i++;
  const dots = i;
  const remainder = moduleText.slice(dots);
  if (!remainder) return undefined;
  const prefix = dots === 1 ? "./" : "../".repeat(dots - 1);
  return prefix + remainder.replace(/\./g, "/");
}

// A single malformed, binary, or unusually-encoded file walking an arbitrary
// target repo (vendored .min.js, generated protobuf output, a data file with
// a misleading extension) can throw during tree-sitter parsing. Without this
// isolation, one bad file aborts the entire pipeline with a raw stack trace
// and no report at all, even though every other file was perfectly parseable
// -- found via Archie's own self-analysis of this same function.
export async function parseFile(filePath: string): Promise<ParsedFile> {
  await ensureInitialized();
  try {
    return await parseFileUnsafe(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[archie] Skipping unparseable file: ${filePath} — ${message}`);
    return { functions: [], classes: [], imports: [], magicNumbers: [], dangerousSinks: [] };
  }
}

// ---------------------------------------------------------------------------
// Magic-number detection node types, verified empirically against real parse
// output from each grammar's .wasm (see the git history for this change --
// the throwaway probe script's output is quoted in the PR description, not
// checked in, per this codebase's existing discipline of never guessing
// tree-sitter node names). TS/JS numeric literals are "number"; Python's
// grammar splits them into "integer" and "float"; Go's splits them into
// "int_literal" and "float_literal". None of these three sets overlap with
// each other, so a single Set lookup keyed by language is enough.
const TS_NUMBER_TYPES = new Set(["number"]);
const PY_NUMBER_TYPES = new Set(["integer", "float"]);
const GO_NUMBER_TYPES = new Set(["int_literal", "float_literal"]);

function numberNodeTypesFor(isPython: boolean, isGo: boolean): Set<string> {
  return isPython ? PY_NUMBER_TYPES : isGo ? GO_NUMBER_TYPES : TS_NUMBER_TYPES;
}

// String-literal node types, same empirical-verification discipline as
// above. TS/JS has two distinct node types worth collapsing: "string" for
// quoted literals and "template_string" for backtick literals (which can
// contain `${...}` interpolations). Python is simpler than it looks: both
// plain and f-prefixed strings parse to the SAME "string" node type --
// confirmed by parsing an f-string and a plain string side by side, the only
// difference shows up one level down, in string_start's own text ("f\"" vs
// "\""), which this code never descends into anyway (see collectTokens).
// Go has "interpreted_string_literal" (double-quoted, escapes allowed) and
// "raw_string_literal" (backtick, verbatim) as separate node types.
const TS_STRING_TYPES = new Set(["string", "template_string"]);
const PY_STRING_TYPES = new Set(["string"]);
const GO_STRING_TYPES = new Set(["interpreted_string_literal", "raw_string_literal"]);

function stringNodeTypesFor(isPython: boolean, isGo: boolean): Set<string> {
  return isPython ? PY_STRING_TYPES : isGo ? GO_STRING_TYPES : TS_STRING_TYPES;
}

// Checks whether a numeric literal node's value is on the allowlist (0, 1,
// or -1) and therefore never counts as a "magic number" regardless of
// context. -1 needs special handling: the minus sign is never part of the
// number node's own text in any of these three grammars -- it's a sibling
// token inside a wrapping unary-minus node (verified empirically:
// TS/JS/Go all use "unary_expression" with the "-" token as the first child
// and the operand as the second; Python uses "unary_operator" with the same
// two-child shape). So "-1" as written in source is two sibling AST nodes,
// not one, and detecting it means looking at the number node's parent, not
// just its own text.
// web-tree-sitter mints a fresh JS wrapper object every time a node is
// accessed (childForFieldName, .parent, .child(i), ...), even for the exact
// same underlying AST position -- verified empirically: calling
// declarator.childForFieldName("value") twice in a row and comparing the two
// results with `===` returns false, even though both wrap identical
// underlying node data (same .id, same .startIndex, and .equals() reports
// true). Every "is this specific node the same one I already have a
// reference to" check in this file therefore has to go through nodesEqual
// (SyntaxNode#equals) rather than `===` -- a plain reference-equality check
// silently always returns false and every "is this the declaration's own
// value" check below would otherwise never match anything.
function nodesEqual(a: Parser.SyntaxNode | null, b: Parser.SyntaxNode | null): boolean {
  if (!a || !b) return false;
  return a.equals(b);
}

// The minus sign in a negative literal (e.g. `-40`) is never part of the
// number node's own text in any of these three grammars -- it's a sibling
// token inside a wrapping unary-minus node (verified empirically: TS/JS/Go
// all use "unary_expression" with the "-" token as the first child and the
// operand as the second; Python uses "unary_operator" with the same
// two-child shape). Returns the node whose parent should actually be
// inspected for "is this a named constant's value" purposes (the wrapper,
// when present -- a declarator's `value` field points at the whole `-40`
// expression, not the inner `40` literal) and the text that should be
// recorded as the occurrence's value (with the sign restored). Every caller
// that needs either of these must go through here rather than reading
// node.text/node.parent directly, or it silently loses the sign the same
// way this file's own const-exemption and occurrence-recording code
// originally did.
function unwrapUnaryMinus(node: Parser.SyntaxNode): { effectiveNode: Parser.SyntaxNode; text: string } {
  const parent = node.parent;
  if (
    parent &&
    (parent.type === "unary_expression" || parent.type === "unary_operator") &&
    parent.childCount === 2 &&
    parent.child(0)?.text === "-" &&
    nodesEqual(parent.child(1), node)
  ) {
    return { effectiveNode: parent, text: `-${node.text}` };
  }
  return { effectiveNode: node, text: node.text };
}

function isAllowlistedNumericValue(text: string): boolean {
  return text === "0" || text === "1" || text === "-1";
}

// A `const`/module-level declaration's value is "already named" and should
// never be flagged as magic, no matter how large or unusual it is. Each
// language gets its own check because each language's own AST shape for
// "this value is named at the appropriate scope" is different -- verified
// empirically per language rather than assumed from the other two:
//
// - TS/JS: `const NAME = <number>` parses as
//   lexical_declaration > variable_declarator > (name, "=", value), where
//   the number is the declarator's "value" field. Distinguishing `const`
//   from `let`/`var` matters here because TS/JS overload `const` for
//   ordinary locals that just happen to never be reassigned, not only for
//   genuine named constants -- so this only exempts a `const` whose
//   lexical_declaration has no function ancestor between it and the module
//   root (i.e. is declared at module/top level, not merely with the `const`
//   keyword).
// - Python has no separate "constant" declaration syntax at all -- a
//   module-level `NAME = <number>` is just an ordinary assignment whose
//   grandparent is the "module" node directly (verified: assignment's
//   parent is always "expression_statement", and that expression_statement's
//   parent is "module" only when nothing indents it -- a class body or
//   function body wraps it in an indented "block" node instead).
// - Go's `const Name = <number>` is unambiguous in a way TS/JS's `const`
//   isn't: Go has a completely separate keyword/mechanism for ordinary
//   locals (`:=`, `var`), so `const` in Go ALWAYS means "this is a genuine
//   named constant" regardless of what scope it's declared in. That's why,
//   unlike the TS/JS case above, this intentionally does not walk up looking
//   for a function ancestor -- a `const` declared inside a Go function body
//   still names its value the same way a package-level one does.
function isDeclaredConstantValue(
  node: Parser.SyntaxNode,
  isPython: boolean,
  isGo: boolean
): boolean {
  if (isGo) return isGoConstSpecValue(node);
  if (isPython) return isPythonModuleLevelAssignmentValue(node);
  return isTsTopLevelConstValue(node);
}

function hasFunctionAncestor(node: Parser.SyntaxNode): boolean {
  let cur = node.parent;
  while (cur) {
    if (
      cur.type === "function_declaration" ||
      cur.type === "function_expression" ||
      cur.type === "arrow_function" ||
      cur.type === "method_definition" ||
      cur.type === "generator_function_declaration"
    ) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

function isTsTopLevelConstValue(node: Parser.SyntaxNode): boolean {
  const declarator = node.parent;
  if (!declarator || declarator.type !== "variable_declarator") return false;
  if (!nodesEqual(declarator.childForFieldName("value"), node)) return false;
  const lexicalDecl = declarator.parent;
  if (!lexicalDecl || lexicalDecl.type !== "lexical_declaration") return false;
  const keyword = lexicalDecl.child(0);
  if (!keyword || keyword.type !== "const") return false;
  return !hasFunctionAncestor(lexicalDecl);
}

function isPythonModuleLevelAssignmentValue(node: Parser.SyntaxNode): boolean {
  const assignment = node.parent;
  if (!assignment || assignment.type !== "assignment") return false;
  if (!nodesEqual(assignment.childForFieldName("right"), node)) return false;
  const exprStmt = assignment.parent;
  if (!exprStmt || exprStmt.type !== "expression_statement") return false;
  return exprStmt.parent?.type === "module";
}

function isGoConstSpecValue(node: Parser.SyntaxNode): boolean {
  const exprList = node.parent;
  if (!exprList || exprList.type !== "expression_list") return false;
  const constSpec = exprList.parent;
  if (!constSpec || constSpec.type !== "const_spec") return false;
  if (!nodesEqual(constSpec.childForFieldName("value"), exprList)) return false;
  return constSpec.parent?.type === "const_declaration";
}

// ---------------------------------------------------------------------------
// Dangerous dynamic-execution sink detection, verified empirically against
// real parse output from each grammar's .wasm the same way the magic-number
// node types above were (throwaway probe script parsing each snippet below
// and dumping the resulting tree, not assumed from memory of the grammar):
//
// - TS/JS: a bare call like `eval("x")` or `execSync(cmd)` parses as
//   call_expression whose "function" field is a plain identifier node.
//   `new Function(...)` is a DIFFERENT node type (new_expression, not
//   call_expression) with NO "function" field at all -- its callee identifier
//   is reachable via the "constructor" field instead (verified: calling
//   .childForFieldName("function") on a new_expression returns undefined,
//   .childForFieldName("constructor") returns the identifier). A member-style
//   call like `cp.execSync(cmd)` gives call_expression a member_expression in
//   its "function" field instead, with its own "object"/"property" fields
//   (verified: property is a property_identifier node). Both call_expression
//   and new_expression share the same "arguments" field shape: an `arguments`
//   node whose anonymous "(", ",", ")" tokens sit alongside the real argument
//   expressions as named children -- filtering to isNamed children in order
//   gives the actual argument list.
// - Python: `eval(x)`/`exec(x)` are `call` nodes whose "function" field is a
//   bare identifier, same shape as TS/JS. `os.system(x)`/`subprocess.run(...)`
//   are also `call` nodes, but "function" is instead an `attribute` node with
//   its own "object"/"attribute" fields (verified: parsing `os.system(cmd)`
//   gives attribute.childForFieldName("attribute").text === "system").
//   Arguments live in an "argument_list" field; a `shell=True` keyword
//   argument shows up as its own named child of type keyword_argument with
//   "name"/"value" fields, distinguishable from the plain positional argument
//   next to it (verified by parsing `subprocess.run(cmd, shell=True)`).
// - Go: `exec.Command(...)` is a call_expression whose "function" field is a
//   selector_expression with "operand"/"field" fields (verified: parsing
//   `exec.Command("sh", "-c", cmd)` gives operand.text === "exec",
//   field.text === "Command"). Arguments live in an "arguments" field (an
//   argument_list node), same shape as the other two languages' argument
//   lists above.
function namedArguments(argsNode: Parser.SyntaxNode | null): Parser.SyntaxNode[] {
  if (!argsNode) return [];
  const result: Parser.SyntaxNode[] = [];
  for (let i = 0; i < argsNode.childCount; i++) {
    const child = argsNode.child(i);
    if (child && child.isNamed) result.push(child);
  }
  return result;
}

// A TS/JS call's callee name for the purposes of this codebase's existing
// "match by name, don't resolve imports" heuristic (the same discipline the
// magic-number/const-exemption checks use elsewhere in this file): either a
// bare identifier (`eval(...)`) or the rightmost name of a member expression
// (`cp.execSync(...)`) -- both shapes verified empirically above.
function tsJsCalleeName(functionField: Parser.SyntaxNode | null): string | undefined {
  if (!functionField) return undefined;
  if (functionField.type === "identifier") return functionField.text;
  if (functionField.type === "member_expression") {
    const property = functionField.childForFieldName("property");
    return property?.type === "property_identifier" ? property.text : undefined;
  }
  return undefined;
}

const TS_EXEC_SHELL_SINK_NAMES = new Set(["execSync", "exec"]);

// Whether a TS/JS argument node is anything other than a single, complete
// plain string literal. A quoted "string" is never dynamic (no interpolation
// is possible inside one). A template_string is only dynamic when it
// actually CONTAINS a `${...}` interpolation -- verified empirically: parsing
// a plain `` `git status` `` (no ${}) produces a template_string whose only
// non-delimiter child is a string_fragment, with no template_substitution
// node anywhere, so a template literal used exactly like a fixed string
// isn't treated as a real injection risk just for using backticks. Anything
// else (identifier, call_expression, binary `+` concatenation, ...) is
// dynamic by definition -- it's not a literal at all.
function hasDynamicArgumentTsJs(node: Parser.SyntaxNode): boolean {
  if (node.type === "string") return false;
  if (node.type === "template_string") {
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i)?.type === "template_substitution") return true;
    }
    return false;
  }
  return true;
}

const PY_EVAL_EXEC_NAMES = new Set(["eval", "exec"]);
const PY_SHELL_ARG_SINK_NAMES = new Set(["run", "call", "Popen"]);

// Same "is this a fixed literal" question as hasDynamicArgumentTsJs, but for
// Python's grammar: plain strings and f-strings share the exact same "string"
// node type (see PY_STRING_TYPES's comment earlier in this file), so an
// f-string is only dynamic when it actually contains an `{expr}`
// interpolation -- verified empirically: parsing f"cmd {x}" produces a
// string node with an "interpolation" named child (itself wrapping the
// identifier), while parsing a plain "plain" string produces no such child
// at all. A non-string argument (identifier, call, ...) is dynamic by
// definition.
function hasDynamicArgumentPython(node: Parser.SyntaxNode): boolean {
  if (node.type !== "string") return true;
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === "interpolation") return true;
  }
  return false;
}

// Extracts the literal text of a Go string-literal argument node (both
// interpreted "..." and raw `...` forms, stripped of their surrounding quote
// characters), or undefined if the node isn't a string literal at all --
// used both to recognize the literal "sh"/"bash"/"-c" arguments that make
// exec.Command's shell-interpretation shape recognizable, and to decide
// whether the shell-command argument itself is dynamic (any non-string-
// literal argument is dynamic by definition, same reasoning as the TS/JS and
// Python cases above; Go has no string interpolation syntax at all, so a
// literal Go string argument is never dynamic the way a template/f-string
// can be).
function goStringLiteralValue(node: Parser.SyntaxNode): string | undefined {
  if (!GO_STRING_TYPES.has(node.type)) return undefined;
  return node.text.slice(1, -1);
}

function detectTsJsDangerousSink(
  node: Parser.SyntaxNode
): { sink: string; hasDynamicArgument: boolean } | undefined {
  if (node.type === "call_expression") {
    const callee = tsJsCalleeName(node.childForFieldName("function"));
    if (!callee) return undefined;
    // eval(...) is flagged for ANY call regardless of argument shape -- eval
    // itself is the risk, not just a dynamic argument to it -- but
    // hasDynamicArgument is still computed from the actual argument so a
    // later severity pass can still tell `eval("fixed")` (discouraged) apart
    // from `eval(userInput)` (an actual injection risk).
    if (callee === "eval" || TS_EXEC_SHELL_SINK_NAMES.has(callee)) {
      const args = namedArguments(node.childForFieldName("arguments"));
      return {
        sink: callee,
        hasDynamicArgument: args.length === 0 ? true : hasDynamicArgumentTsJs(args[0]),
      };
    }
    return undefined;
  }
  if (node.type === "new_expression") {
    const constructorField = node.childForFieldName("constructor");
    if (constructorField?.type === "identifier" && constructorField.text === "Function") {
      const args = namedArguments(node.childForFieldName("arguments"));
      return {
        sink: "new Function",
        hasDynamicArgument: args.length === 0 ? true : hasDynamicArgumentTsJs(args[0]),
      };
    }
  }
  return undefined;
}

function detectPythonDangerousSink(
  node: Parser.SyntaxNode
): { sink: string; hasDynamicArgument: boolean } | undefined {
  if (node.type !== "call") return undefined;
  const functionField = node.childForFieldName("function");
  if (!functionField) return undefined;

  if (functionField.type === "identifier" && PY_EVAL_EXEC_NAMES.has(functionField.text)) {
    const args = namedArguments(node.childForFieldName("arguments"));
    return {
      sink: functionField.text,
      hasDynamicArgument: args.length === 0 ? true : hasDynamicArgumentPython(args[0]),
    };
  }

  if (functionField.type === "attribute") {
    const objectField = functionField.childForFieldName("object");
    const attributeField = functionField.childForFieldName("attribute");
    if (!objectField || !attributeField) return undefined;

    if (objectField.type === "identifier" && objectField.text === "os" && attributeField.text === "system") {
      const args = namedArguments(node.childForFieldName("arguments"));
      return {
        sink: "os.system",
        hasDynamicArgument: args.length === 0 ? true : hasDynamicArgumentPython(args[0]),
      };
    }

    // subprocess.run/call/Popen take an argv LIST by default and are only a
    // shell-injection risk once `shell=True` opts back into shell
    // interpretation -- so this only flags the call when a `shell=True`
    // keyword argument is actually present; the argv-list form (no shell=
    // kwarg at all) is left alone entirely, not just tagged non-dynamic.
    if (
      objectField.type === "identifier" &&
      objectField.text === "subprocess" &&
      PY_SHELL_ARG_SINK_NAMES.has(attributeField.text)
    ) {
      const args = namedArguments(node.childForFieldName("arguments"));
      const shellTrueArg = args.find(
        (arg) =>
          arg.type === "keyword_argument" &&
          arg.childForFieldName("name")?.text === "shell" &&
          arg.childForFieldName("value")?.text === "True"
      );
      if (!shellTrueArg) return undefined;
      const commandArg = args.find((arg) => arg.type !== "keyword_argument");
      return {
        sink: `subprocess.${attributeField.text}(shell=True)`,
        hasDynamicArgument: commandArg ? hasDynamicArgumentPython(commandArg) : true,
      };
    }
  }

  return undefined;
}

// Go scope note, stated honestly rather than silently narrowed: exec.Command
// is inherently argv-based -- each argument is passed straight to the child
// process with no shell involved, so there is no shell-interpolation footgun
// the way os.system/eval have everywhere else -- UNLESS the code deliberately
// re-introduces a shell via `exec.Command("sh", "-c", ...)` or
// `exec.Command("bash", "-c", ...)`, the one place Go code opts back into
// that same risk. This intentionally does NOT try to catch every indirect
// path to a shell (a variable holding "sh" passed as the first argument, a
// wrapper function around exec.Command, etc.) -- only the literal, directly-
// written three-argument shape verified above by parsing
// `exec.Command("sh", "-c", cmd)`'s tree. Catching the indirect cases would
// need real data-flow analysis, which this single-pass per-file AST walk
// doesn't do anywhere else either.
function detectGoDangerousSink(
  node: Parser.SyntaxNode
): { sink: string; hasDynamicArgument: boolean } | undefined {
  if (node.type !== "call_expression") return undefined;
  const functionField = node.childForFieldName("function");
  if (functionField?.type !== "selector_expression") return undefined;
  const operandField = functionField.childForFieldName("operand");
  const fieldField = functionField.childForFieldName("field");
  if (operandField?.type !== "identifier" || operandField.text !== "exec" || fieldField?.text !== "Command") {
    return undefined;
  }

  const args = namedArguments(node.childForFieldName("arguments"));
  if (args.length < 3) return undefined;
  const shellName = goStringLiteralValue(args[0]);
  const flag = goStringLiteralValue(args[1]);
  if ((shellName !== "sh" && shellName !== "bash") || flag !== "-c") return undefined;

  return {
    sink: "exec.Command",
    hasDynamicArgument: goStringLiteralValue(args[2]) === undefined,
  };
}

// Builtins that are a genuine structural signal (calling Number.isFinite vs.
// Array.isArray is a real difference in behavior) rather than an arbitrary
// naming choice, so they're deliberately excluded from identifier
// placeholdering in computeBodyHash. This list is intentionally small and
// per-language -- it is not an attempt at a complete standard-library
// catalog, just the common cases likely to show up in the kind of small
// validation/guard functions this feature targets.
const TS_BUILTIN_IDENTIFIERS = new Set([
  "Number", "Math", "String", "Array", "Object", "Boolean", "console", "JSON", "Promise",
  "isFinite", "isNaN", "max", "min", "floor", "ceil", "round", "parseInt", "parseFloat",
  "keys", "values", "entries", "stringify", "parse",
]);
const PY_BUILTIN_IDENTIFIERS = new Set(["len", "str", "int", "float", "range", "print", "dict", "list", "set"]);
const GO_BUILTIN_IDENTIFIERS = new Set(["len", "cap", "make", "append", "panic", "fmt", "errors"]);

function builtinIdentifiersFor(isPython: boolean, isGo: boolean): Set<string> {
  return isPython ? PY_BUILTIN_IDENTIFIERS : isGo ? GO_BUILTIN_IDENTIFIERS : TS_BUILTIN_IDENTIFIERS;
}

// A number/string leaf node whose parent is one of these types is playing
// the role of a TYPE, not a value -- either the `number`/`string` keyword in
// an ordinary type annotation (predefined_type), or a specific literal used
// as a type constraint like `version: 6` (literal_type). Both wrap a leaf
// node whose own node.type name collides with the real literal-expression
// node types (verified empirically -- see the two call sites below), so
// both need the same exemption or the type-level constraint gets
// misidentified as an ordinary literal value.
const TYPE_CONTEXT_PARENT_TYPES = new Set(["predefined_type", "literal_type"]);

// Recursively flattens a function's AST subtree into a normalized token
// sequence for structural hashing. Three deliberate collapses, in order:
//
// 1. TS/JS's predefined_type keyword nodes (the `string`/`number`/etc in a
//    type annotation like `text: string`) reuse the EXACT SAME node.type
//    names ("string", "number") as this grammar's actual string/number
//    LITERAL EXPRESSION nodes -- verified empirically by parsing
//    `text: string` and finding `predefined_type > (leaf, type "string")`,
//    indistinguishable by type name alone from a real `"..."` literal node.
//    Left unguarded, every function's own parameter/return type annotations
//    would get silently collapsed into STR/NUM tokens, which is structurally
//    backwards: `: string` vs `: number` is a real signature difference, not
//    incidental literal content, so this checks the parent and keeps the
//    keyword as a literal token instead of collapsing it.
// 2. Any string-literal node (plain, template/f-string) becomes a single
//    "STR" token WITHOUT descending into its children -- deliberately, even
//    for a template literal's `${...}` interpolation. Recursing into an
//    interpolation would mean the two acceptance-case functions'
//    ``${maxLength}``/``${limit}`` template substitutions need to line up
//    token-for-token with everything else, which is more fragile than
//    necessary: the interpolated expression is usually incidental (as in the
//    motivating case), and treating the whole template as one opaque token
//    mirrors how a plain string literal's content is already ignored
//    regardless of what's inside the quotes.
// 3. Any identifier that isn't a recognized builtin gets replaced with a
//    positional placeholder (P1, P2, ...) keyed by first occurrence WITHIN
//    THIS FUNCTION, so the same local name reused twice maps to the same
//    placeholder both times, but two unrelated functions never accidentally
//    share placeholder numbering (each call gets its own fresh map).
//    property_identifier/field_identifier nodes (the `.isFinite`/`.Println`
//    part of a member/selector expression) are NOT identifiers by this
//    grammar's own node-type naming and so never enter this branch --
//    they fall through to the generic leaf case below and keep their real
//    text, because which method is being called on an object IS a real
//    structural signal, not a renameable local.
function collectTokens(
  node: Parser.SyntaxNode,
  tokens: string[],
  placeholderIds: Map<string, number>,
  numberTypes: Set<string>,
  stringTypes: Set<string>,
  builtins: Set<string>
): void {
  if (node.type === "comment") return; // incidental to structure, not code shape

  if ((numberTypes.has(node.type) || stringTypes.has(node.type)) && TYPE_CONTEXT_PARENT_TYPES.has(node.parent?.type ?? "")) {
    tokens.push(node.type);
    return;
  }
  if (stringTypes.has(node.type)) {
    tokens.push("STR");
    return;
  }
  if (numberTypes.has(node.type)) {
    tokens.push("NUM");
    return;
  }
  if (node.type === "identifier") {
    if (builtins.has(node.text)) {
      tokens.push(node.text);
      return;
    }
    let id = placeholderIds.get(node.text);
    if (id === undefined) {
      id = placeholderIds.size + 1;
      placeholderIds.set(node.text, id);
    }
    tokens.push(`P${id}`);
    return;
  }
  if (node.childCount === 0) {
    // Anonymous leaf tokens (keywords, operators, punctuation) have their
    // literal text as their node.type in tree-sitter's grammars, so node.type
    // and node.text agree for those. Named leaf tokens that AREN'T
    // identifiers/numbers/strings (property_identifier, field_identifier,
    // type_identifier, ...) need their actual text, not their type name --
    // node.type for those is a category label ("property_identifier"), and
    // collapsing every property/method name to that same label would erase
    // the real difference between e.g. calling .isFinite vs .isArray.
    tokens.push(node.isNamed ? node.text : node.type);
    return;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collectTokens(child, tokens, placeholderIds, numberTypes, stringTypes, builtins);
  }
}

// Structural duplicate-detection hash for a function: normalizes away
// renameable identifiers and literal content (see collectTokens) so two
// functions with the same shape hash identically even when every local name
// and string differs, then hashes the resulting token sequence the same way
// cache.ts's hashContent does (sha256, hex, truncated to 16 chars) --
// duplicated here rather than imported to avoid parser.ts (a low-level
// module with no other dependencies in this codebase) taking on a
// dependency on cache.ts (a higher-level module that already depends on
// parser.ts for its ParsedFile type).
function computeBodyHash(node: Parser.SyntaxNode, isPython: boolean, isGo: boolean): string {
  try {
    const tokens: string[] = [];
    collectTokens(
      node,
      tokens,
      new Map<string, number>(),
      numberNodeTypesFor(isPython, isGo),
      stringNodeTypesFor(isPython, isGo),
      builtinIdentifiersFor(isPython, isGo)
    );
    // Joined with a control character (not a plain space) so that no real
    // token's own text -- a keyword, an operator, a property name, a "P<n>"
    // placeholder -- could ever blur two adjacent tokens together into the
    // same joined string a differently-split token sequence would produce.
    return createHash("sha256").update(tokens.join("\u0001")).digest("hex").slice(0, 16);
  } catch {
    // Matches this codebase's existing fail-open convention (parseFile's own
    // try/catch around parseFileUnsafe): one function whose subtree can't be
    // cleanly walked must not crash analysis of the rest of the file. Hashing
    // the empty string is a deliberately inert fallback -- a fixed, always-
    // reproducible value that won't spuriously collide with any function
    // that hashed successfully (a genuinely empty body would need an
    // identically-empty token sequence to match, vanishingly unlikely).
    return createHash("sha256").update("").digest("hex").slice(0, 16);
  }
}

async function parseFileUnsafe(filePath: string): Promise<ParsedFile> {
  const source = await readFile(filePath, "utf8");

  const parser = new Parser();
  parser.setLanguage(languageFor(filePath));
  const tree = parser.parse(source);

  const functions: ParsedFunction[] = [];
  const classes: ParsedClass[] = [];
  const imports: string[] = [];
  const magicNumbers: MagicNumberOccurrence[] = [];
  const dangerousSinks: DangerousSinkOccurrence[] = [];

  const isPython = path.extname(filePath) === ".py";
  const isGo = path.extname(filePath) === ".go";
  const numberTypes = numberNodeTypesFor(isPython, isGo);

  // Exported status found missing entirely in an earlier version of this
  // pipeline: nothing computed or tracked which functions/classes a file
  // actually exports, so the report-generation LLM had to eyeball raw source
  // text to guess a file's "public API" -- and on a real report, it named
  // four private, module-internal helper functions as exported and told a
  // refactor step to modify them directly, when the real fix boundary was
  // the actual exported function that calls them. TS/JS exported status is
  // syntactic (wrapped in an export_statement); Python has no export
  // keyword, so a leading underscore is used as the closest equivalent to
  // its own "private by convention" idiom.
  const isExportStatement = (node: Parser.SyntaxNode | null): boolean =>
    node !== null && node.type === "export_statement";

  walkTree(tree.rootNode, (node) => {
    // Magic-number extraction runs unconditionally on every node, ahead of
    // the function/class/import dispatch below -- a numeric-literal node
    // never also matches one of those other branches, so this is a genuinely
    // separate concern rather than another arm of that if/else-if chain.
    // Only the number's own occurrence is recorded here: the "is this
    // exempt" checks look at the number node's immediate AST context
    // (parent/ancestor), never at surrounding source text or indentation.
    //
    // The TYPE_CONTEXT_PARENT_TYPES guard matters here for the same reason
    // it matters in collectTokens: TS/JS's `: number` type-annotation
    // keyword parses to a leaf node whose type is literally "number" -- the
    // exact same node.type as a real numeric literal -- verified empirically
    // by parsing a typed parameter and finding predefined_type > (leaf, type
    // "number"). A literal type used as a value constraint (e.g.
    // `version: 6` in an interface) hits the same collision from a second
    // angle -- verified empirically by parsing `interface Foo { version: 6 }`
    // and finding type_annotation > literal_type > (leaf, type "number"), a
    // distinct wrapper from predefined_type but the same underlying problem.
    // Without this guard, every numerically-typed parameter/return
    // annotation, or literal-type constraint, in a TS file would get
    // reported as a bogus "magic number".
    if (numberTypes.has(node.type) && !TYPE_CONTEXT_PARENT_TYPES.has(node.parent?.type ?? "")) {
      const { effectiveNode, text } = unwrapUnaryMinus(node);
      if (!isAllowlistedNumericValue(text) && !isDeclaredConstantValue(effectiveNode, isPython, isGo)) {
        magicNumbers.push({ value: text, line: node.startPosition.row + 1 });
      }
    }

    // Dangerous-sink detection runs unconditionally too, same reasoning as
    // magic-number extraction above: a call_expression/new_expression/call
    // node never also matches the function/class/import dispatch below, so
    // this is a separate concern rather than another arm of that chain. Only
    // one of the three per-language detectors ever matches for a given file
    // (isPython/isGo select the language up front the same way numberTypes
    // does above), so there's no risk of e.g. the TS detector's
    // call_expression check firing on a Go call_expression's different
    // "function" field shape.
    const sinkMatch = isGo
      ? detectGoDangerousSink(node)
      : isPython
      ? detectPythonDangerousSink(node)
      : detectTsJsDangerousSink(node);
    if (sinkMatch) {
      dangerousSinks.push({ ...sinkMatch, line: node.startPosition.row + 1 });
    }

    if (node.type === "function_declaration" || node.type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        // Go has no export keyword; its convention is that a capitalized
        // top-level identifier is exported from the package. This only
        // applies to top-level function_declaration (verified via
        // tree-sitter-go's node-types.json) -- method_declaration is handled
        // in its own branch below and is always isExported: false.
        const isExported = isPython
          ? !nameNode.text.startsWith("_")
          : isGo
          ? /^[A-Z]/.test(nameNode.text)
          : isExportStatement(node.parent);
        functions.push({
          name: nameNode.text,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported,
          bodyHash: computeBodyHash(node, isPython, isGo),
        });
      }
    } else if (isGo && node.type === "method_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        // Same simplification as JS/TS method_definition below: a method
        // can't be imported independently of its receiver type, so
        // "exported" (= directly importable by another file) is always
        // false here, regardless of the method name's capitalization.
        functions.push({
          name: nameNode.text,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: false,
          bodyHash: computeBodyHash(node, isPython, isGo),
        });
      }
      // Go structs/interfaces have no class_declaration/class_definition
      // equivalent in this grammar (verified via node-types.json); v1
      // intentionally skips struct/interface detection as "classes".
    } else if (node.type === "class_declaration" || node.type === "class_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isExported = isPython
          ? !nameNode.text.startsWith("_")
          : isExportStatement(node.parent);
        classes.push({
          name: nameNode.text,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported,
        });
      }
    } else if (!isPython && node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source");
      if (sourceNode) {
        imports.push(sourceNode.text.slice(1, -1));
      }
    } else if (isPython && node.type === "import_statement") {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === "dotted_name") {
          imports.push(child.text);
        }
      }
    } else if (!isPython && node.type === "variable_declarator") {
      const valueNode = node.childForFieldName("value");
      if (valueNode && (valueNode.type === "arrow_function" || valueNode.type === "function_expression")) {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          // export const foo = () => {} nests as
          // export_statement > lexical_declaration > variable_declarator,
          // two levels up rather than one.
          functions.push({
            name: nameNode.text,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            isExported: isExportStatement(node.parent?.parent ?? null),
            bodyHash: computeBodyHash(node, isPython, isGo),
          });
        }
      }
    } else if (!isPython && node.type === "method_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode && nameNode.text !== "constructor") {
        // A method can't be imported independently of its class, regardless
        // of whether the class itself is exported -- "exported" here means
        // "directly importable by another file", which no method is.
        functions.push({
          name: nameNode.text,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported: false,
          bodyHash: computeBodyHash(node, isPython, isGo),
        });
      }
    } else if (isGo && node.type === "import_spec") {
      // Matches import_spec directly rather than the enclosing
      // import_declaration: a grouped `import (...)` block wraps its specs
      // in an import_spec_list, while a single `import "fmt"` attaches the
      // spec directly -- walkTree already recurses into both shapes, so
      // matching on import_spec itself handles both without needing to
      // special-case the grouping node.
      const pathNode = node.childForFieldName("path");
      if (pathNode) {
        imports.push(pathNode.text.slice(1, -1));
      }
    } else if (isPython && node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      if (moduleNode) {
        const text = moduleNode.text;
        if (text.startsWith(".")) {
          const resolved = pythonRelativeToPath(text);
          if (resolved) imports.push(resolved);
        }
      }
    }
  });

  return { functions, classes, imports, magicNumbers, dangerousSinks };
}

const BRANCH_NODE_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "case_clause",
  "catch_clause",
  "ternary_expression",
  "elif_clause",
  "with_statement",
  "except_clause",
  "conditional_expression",
  "boolean_operator",
  // Go-specific branch node types, verified against tree-sitter-go's
  // node-types.json (0.25.0). "if_statement" and "for_statement" above are
  // already the exact node type names Go's grammar uses too, so no
  // duplicate entries are needed for those. "default_case" is deliberately
  // excluded, matching the existing convention of not counting a switch's
  // default/else fallthrough as its own branch.
  "expression_case", // a `case` arm of an expression switch statement
  "type_case", // a `case` arm of a type switch statement
  "communication_case", // a `case` arm of a select statement
]);

// Same per-file isolation as parseFile: one unparseable file shouldn't abort
// complexity scoring for the rest of the repo. Falls back to base complexity
// (1) rather than throwing.
export async function computeComplexity(filePath: string): Promise<number> {
  await ensureInitialized();
  try {
    return await computeComplexityUnsafe(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[archie] Skipping unparseable file: ${filePath} — ${message}`);
    return 1;
  }
}

async function computeComplexityUnsafe(filePath: string): Promise<number> {
  const source = await readFile(filePath, "utf8");

  const parser = new Parser();
  parser.setLanguage(languageFor(filePath));
  const tree = parser.parse(source);

  let complexity = 1; // base complexity

  walkTree(tree.rootNode, (node) => {
    if (node.type === "binary_expression") {
      const operator = node.children.find(
        (c) => c.type === "&&" || c.type === "||"
      );
      if (operator) complexity += 1;
    } else if (BRANCH_NODE_TYPES.has(node.type)) {
      complexity += 1;
    }
  });
  return complexity;
}
