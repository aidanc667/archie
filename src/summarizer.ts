// src/summarizer.ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CodeGraph, FileNode } from "./types.js";
import type { RiskScore } from "./metrics.js";
import { detectFileLanguage } from "./consistency.js";
import type { NamingConsistencyReport } from "./consistency.js";
import { computeTestQualitySignal } from "./testquality.js";
import type { DuplicationReport } from "./duplication.js";
import type { DeadFileReport } from "./deadcode.js";
import type { MagicNumberOccurrence } from "./parser.js";

// A single security-relevant finding, deliberately identical in shape for
// both a leaked-secret hit and a dangerous-sink hit: `file`+`line`+`ruleId`
// is enough for the model to cite either kind of finding by exact location,
// and keeping one shape (instead of two subtly different ones) means the
// downstream grounding rule and prompt instructions only have to describe
// one thing. `hasDynamicArgument` is only ever set for a dangerousSinks
// entry (a dynamically-constructed argument to eval/exec/etc. is a real
// injection risk; a literal argument is merely a discouraged pattern) --
// left undefined for secrets, where it has no meaning.
//
// SAFETY: this type must NEVER grow a field that could carry a secret's
// actual matched text (a snippet, a masked preview, a hash of it). `ruleId`
// names which detection rule fired (e.g. "aws-access-key") and `line`
// pinpoints where -- that is deliberately the entire ceiling. See
// src/security.ts's own header comment for why: Archie's report is posted
// as a public/org-visible GitHub comment, so any field here that carried
// even a fragment of a real secret would turn this feature into the exact
// leak mechanism it exists to catch.
export interface SecurityFinding {
  file: string;
  line: number;
  ruleId: string; // secrets: "aws-access-key" etc; dangerousSinks: the sink name, e.g. "eval", "execSync"
  hasDynamicArgument?: boolean; // only ever set for a dangerousSinks finding
}

export interface SecurityReport {
  secrets: SecurityFinding[];
  dangerousSinks: SecurityFinding[];
}

export interface ContextPackOptions {
  topN: number;
  maxTokens: number;
  // When set (diff-scoped runs), only files in this set are eligible for
  // top-N detailed review -- but this only restricts *selection*. The graph
  // and risk scores this filters over are always built from the whole repo,
  // so fan-in and other graph-derived metrics for files in this set stay
  // accurate. Previously diff-scoping restricted which files were even
  // parsed, so a changed file's fan-in silently came out as 0 whenever its
  // real importers/dependents lived outside the diff.
  restrictToFileIds?: Set<string>;
}

export interface SystemSummary {
  fileCount: number;
  totalLoc: number;
}

// Loads and merges dependencies + devDependencies from the target repo's
// root package.json, so the report-generation prompt can cite exact,
// verified framework/library versions instead of guessing them from code
// patterns (e.g. inferring "Next.js 14" from App Router file conventions
// that look nearly identical across several major versions -- found on a
// real report where the target's package.json said "next": "16.2.2" but
// the generated System Summary claimed "Next.js 14"). Fails open (returns
// undefined) if package.json is missing or malformed -- Python repos and
// other edge cases shouldn't break the pipeline over this.
export async function loadDependencies(root: string): Promise<Record<string, string> | undefined> {
  try {
    const content = await readFile(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const merged = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.keys(merged).length > 0 ? merged : undefined;
  } catch {
    return undefined;
  }
}

export interface TopRiskFile {
  path: string;
  riskScore: number;
  complexity: number;
  fanIn: number;
  loc: number;
  source: string;
  hasTests: boolean;
  hasErrorHandling: boolean;
  // The file's actual exported API surface, per EXPORTS edges in the graph --
  // a checked fact, not something to infer from the raw source. Found
  // missing on a real report: without this, the model named four private,
  // module-internal helper functions as "exported" and aimed a refactor
  // step directly at them instead of their real (exported) call site.
  exportedSymbols: string[];
  // Test-quality signals for the file's matching test file (via TESTED_BY),
  // not this file's own source -- going beyond hasTests' binary "some test
  // exists" check to say something about how substantial that test file
  // actually is. Zero/false when there is no matching test file at all.
  testCaseCount: number;
  hasTestAssertions: boolean;
  // This file's own raw magic-number occurrences, sourced from its FileNode
  // (via the graph) -- pipeline-internal prompt evidence, like testCaseCount/
  // hasTestAssertions above, NOT part of the JSON schema. Defaults to []
  // (never undefined) when the FileNode has no magicNumbers set, matching
  // this codebase's fail-open convention for missing optional signals.
  magicNumbers: MagicNumberOccurrence[];
}

export interface ClusterSummary {
  fileCount: number;
  averageComplexity: number;
  maxRiskScore: number;
}

export interface ContextPack {
  mode: "top-n-detail" | "cluster-summary";
  systemSummary: SystemSummary;
  topRiskFiles: TopRiskFile[];
  graphSnapshot: { from: string; to: string; type: string }[];
  clusters: ClusterSummary[];
  dependencies?: Record<string, string>;
  // A whole-codebase signal (not scoped to top-N), so it belongs in both
  // top-n-detail and cluster-summary modes -- unlike topRiskFiles, which is
  // empty in cluster-summary mode.
  namingConsistency: NamingConsistencyReport;
  // A whole-codebase signal (not scoped to top-N), so it belongs in both
  // top-n-detail and cluster-summary modes -- unlike topRiskFiles, which is
  // empty in cluster-summary mode.
  duplication: DuplicationReport;
  // A whole-codebase signal (not scoped to top-N), so it belongs in both
  // top-n-detail and cluster-summary modes -- unlike topRiskFiles, which is
  // empty in cluster-summary mode.
  deadFiles: DeadFileReport;
  // A whole-codebase signal (not scoped to top-N), so it belongs in both
  // top-n-detail and cluster-summary modes -- unlike topRiskFiles, which is
  // empty in cluster-summary mode.
  security: SecurityReport;
}

// Rough token estimate: ~4 characters per token. This measures the length of the
// JSON-serialized pack, not actual LLM prompt formatting, so it's an approximation
// that may diverge from real prompt token counts.
function estimateTokens(pack: Omit<ContextPack, "mode">): number {
  return Math.ceil(JSON.stringify(pack).length / 4);
}

function pathByFileId(graph: CodeGraph): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind === "file") map.set(node.id, node.path);
  }
  return map;
}

function testedFileIds(graph: CodeGraph): Set<string> {
  const set = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type === "TESTED_BY") set.add(edge.from);
  }
  return set;
}

// Maps each tested source file's id to its test file's id (TESTED_BY edges:
// edge.from is the source file, edge.to is the test file). testedFileIds
// above only answers "does a test file exist"; this answers "which one",
// so a top-risk file's test-quality signal can be computed from the actual
// test file's source instead of the source file's own source.
function testFileIdByFile(graph: CodeGraph): Map<string, string> {
  const map = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.type === "TESTED_BY") map.set(edge.from, edge.to);
  }
  return map;
}

function hasErrorHandling(source: string): boolean {
  return /\btry\s*\{/.test(source) || /\.catch\s*\(/.test(source);
}

function exportedNodeIds(graph: CodeGraph): Set<string> {
  const set = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.type === "EXPORTS") set.add(edge.to);
  }
  return set;
}

// Found returning every function/class in the file regardless of export
// status on a real report, despite its own "[no exports detected]" label
// implying otherwise -- meaning ranks 4-10 (signature-summary only, no full
// source) presented private, module-internal helpers to the model
// indistinguishably from the file's actual public API. Now filters to
// exported symbols only, matching what the label always claimed to show.
function buildSignatureSummary(graph: CodeGraph, fileId: string, exported: Set<string>): string {
  const functions: string[] = [];
  const classes: string[] = [];
  for (const node of graph.nodes) {
    if (!exported.has(node.id)) continue;
    if (node.kind === "function" && node.fileId === fileId) functions.push(node.name);
    else if (node.kind === "class" && node.fileId === fileId) classes.push(node.name);
  }
  if (functions.length === 0 && classes.length === 0) return "[no exports detected]";
  const parts: string[] = [];
  if (functions.length > 0) parts.push(`[functions: ${functions.join(", ")}]`);
  if (classes.length > 0) parts.push(`[classes: ${classes.join(", ")}]`);
  return parts.join(" ");
}

function exportedSymbolsForFile(graph: CodeGraph, fileId: string, exported: Set<string>): string[] {
  return graph.nodes
    .filter((n) => (n.kind === "function" || n.kind === "class") && n.fileId === fileId && exported.has(n.id))
    .map((n) => (n as { name: string }).name);
}

function buildSystemSummary(graph: CodeGraph): SystemSummary {
  const fileNodes = graph.nodes.filter((n) => n.kind === "file");
  const totalLoc = fileNodes.reduce(
    (sum, n) => sum + (n.kind === "file" ? n.loc : 0),
    0
  );
  return { fileCount: fileNodes.length, totalLoc };
}

function buildClusterSummary(scores: RiskScore[]): ClusterSummary[] {
  if (scores.length === 0) return [];
  const averageComplexity =
    scores.reduce((sum, s) => sum + s.complexity, 0) / scores.length;
  const maxRiskScore = Math.max(...scores.map((s) => s.riskScore));
  return [{ fileCount: scores.length, averageComplexity, maxRiskScore }];
}

export function buildContextPack(
  graph: CodeGraph,
  scores: RiskScore[],
  sourceByPath: Map<string, string>,
  options: ContextPackOptions,
  namingConsistency: NamingConsistencyReport,
  duplication: DuplicationReport,
  deadFiles: DeadFileReport,
  security: SecurityReport,
  dependencies?: Record<string, string>
): ContextPack {
  const paths = pathByFileId(graph);
  const systemSummary = buildSystemSummary(graph);
  const tested = testedFileIds(graph);
  const exported = exportedNodeIds(graph);
  const testFileIds = testFileIdByFile(graph);
  const fileNodesById = new Map<string, FileNode>(
    graph.nodes.filter((n): n is FileNode => n.kind === "file").map((n) => [n.id, n])
  );

  const eligible = options.restrictToFileIds
    ? scores.filter((s) => options.restrictToFileIds!.has(s.fileId))
    : scores;
  const sorted = [...eligible].sort((a, b) => b.riskScore - a.riskScore);
  let topN = sorted.slice(0, options.topN);

  // Mode 1: top-N detail, pruning lowest-risk entries until it fits.
  while (topN.length > 0) {
    const topRiskFiles: TopRiskFile[] = topN.map((s, index) => {
      const testFileId = testFileIds.get(s.fileId);
      // A missing test file is a normal, expected case (most files don't
      // have one) -- default to the zero-signal values rather than calling
      // computeTestQualitySignal on the source file's own source, which
      // would be meaningless (it isn't a test file).
      const testQuality = testFileId
        ? computeTestQualitySignal(
            sourceByPath.get(testFileId) ?? "",
            detectFileLanguage(paths.get(testFileId) ?? "") ?? ""
          )
        : { testCaseCount: 0, hasTestAssertions: false };

      return {
        path: paths.get(s.fileId) ?? s.fileId,
        riskScore: s.riskScore,
        complexity: s.complexity,
        fanIn: s.fanIn,
        loc: s.loc,
        source: index < 3
          ? (sourceByPath.get(s.fileId) ?? "")
          : buildSignatureSummary(graph, s.fileId, exported),
        hasTests: tested.has(s.fileId),
        hasErrorHandling: hasErrorHandling(sourceByPath.get(s.fileId) ?? ""),
        exportedSymbols: exportedSymbolsForFile(graph, s.fileId, exported),
        testCaseCount: testQuality.testCaseCount,
        hasTestAssertions: testQuality.hasTestAssertions,
        magicNumbers: fileNodesById.get(s.fileId)?.magicNumbers ?? [],
      };
    });

    const includedIds = new Set(topN.map((s) => s.fileId));
    const graphSnapshot = graph.edges
      .filter((e) => includedIds.has(e.from) || includedIds.has(e.to))
      .map((e) => ({ from: paths.get(e.from) ?? e.from, to: paths.get(e.to) ?? e.to, type: e.type }));

    const candidate = {
      systemSummary,
      topRiskFiles,
      graphSnapshot,
      clusters: [],
      dependencies,
      namingConsistency,
      duplication,
      deadFiles,
      security,
    };

    if (estimateTokens(candidate) <= options.maxTokens) {
      return { mode: "top-n-detail", ...candidate };
    }

    topN = topN.slice(0, -1);
  }

  // Mode 2: cluster-summary fallback.
  return {
    mode: "cluster-summary",
    systemSummary,
    topRiskFiles: [],
    graphSnapshot: [],
    clusters: buildClusterSummary(scores),
    dependencies,
    namingConsistency,
    duplication,
    deadFiles,
    security,
  };
}
