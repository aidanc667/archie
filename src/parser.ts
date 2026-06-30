// src/parser.ts
import path from "node:path";
import { readFile } from "node:fs/promises";
import Parser from "web-tree-sitter";

export interface ParsedFunction {
  name: string;
  startLine: number;
  endLine: number;
}

export interface ParsedClass {
  name: string;
  startLine: number;
  endLine: number;
}

export interface ParsedFile {
  functions: ParsedFunction[];
  classes: ParsedClass[];
  imports: string[];
}

let initialized = false;
let tsLanguage: Parser.Language | undefined;
let jsLanguage: Parser.Language | undefined;

async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  const grammarsDir = path.resolve("grammars");
  tsLanguage = await Parser.Language.load(
    path.join(grammarsDir, "tree-sitter-typescript.wasm")
  );
  jsLanguage = await Parser.Language.load(
    path.join(grammarsDir, "tree-sitter-javascript.wasm")
  );
  initialized = true;
}

function languageFor(filePath: string): Parser.Language {
  const ext = path.extname(filePath);
  if (ext === ".ts" || ext === ".tsx") return tsLanguage!;
  return jsLanguage!;
}

export async function parseFile(filePath: string): Promise<ParsedFile> {
  await ensureInitialized();
  const source = await readFile(filePath, "utf8");

  const parser = new Parser();
  parser.setLanguage(languageFor(filePath));
  const tree = parser.parse(source);

  const functions: ParsedFunction[] = [];
  const classes: ParsedClass[] = [];
  const imports: string[] = [];

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "function_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        functions.push({
          name: nameNode.text,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
      }
    } else if (node.type === "class_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        classes.push({
          name: nameNode.text,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
      }
    } else if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source");
      if (sourceNode) {
        imports.push(sourceNode.text.slice(1, -1));
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  }

  walk(tree.rootNode);

  return { functions, classes, imports };
}
