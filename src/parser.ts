// src/parser.ts
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
}

export interface ParsedClass {
  name: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
}

export interface ParsedFile {
  functions: ParsedFunction[];
  classes: ParsedClass[];
  imports: string[];
}

let tsLanguage: Parser.Language | undefined;
let jsLanguage: Parser.Language | undefined;
let pyLanguage: Parser.Language | undefined;

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
    })();
  }
  return initPromise;
}

function languageFor(filePath: string): Parser.Language {
  const ext = path.extname(filePath);
  if (ext === ".ts" || ext === ".tsx") return tsLanguage!;
  if (ext === ".py") return pyLanguage!;
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
    return { functions: [], classes: [], imports: [] };
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

  const isPython = path.extname(filePath) === ".py";

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
    if (node.type === "function_declaration" || node.type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isExported = isPython
          ? !nameNode.text.startsWith("_")
          : isExportStatement(node.parent);
        functions.push({
          name: nameNode.text,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          isExported,
        });
      }
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
        });
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

  return { functions, classes, imports };
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
