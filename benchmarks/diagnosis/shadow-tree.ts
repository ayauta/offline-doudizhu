/**
 * Research scaffolding — NOT a product module and NOT a second AI implementation.
 *
 * Builds the candidate arm for the Spec 054 divergence diagnosis by generating a
 * minimal shadow tree from the *real* source bytes, so the candidate arm is the
 * archived candidate itself rather than a hand-copied replica. Hand-copying was
 * rejected because `hand-analyzer.ts` has several silent drift points: one
 * `cacheHits` counter serves both caches, the budget-exhaustion path neither
 * caches nor counts a visit, `seenRemainders` is per-node and checked before the
 * recursion, and `analyze` searches a canonicalized hand.
 *
 * Generated output lands in `.local/harvest/gen/` (gitignored, never committed).
 * `src/` is never written to. Delete the whole module once the diagnosis is done.
 *
 * The two edits come from the archived, rejected candidate
 * `docs/specs/053-ai-hand-planning/candidate.patch`. Recorded, not re-shipped.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CardId } from "../../src/core/cards/index.js";
import { runtimeImportClosure, runtimeModuleSpecifiers } from "../../scripts/runtime-import-graph.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const generatedDirectory = join(repositoryRoot, ".local/harvest/gen");

export const SHADOW_ANALYZER_PATH = join(generatedDirectory, "hand-analyzer.ts");
export const SHADOW_SCORING_PATH = join(generatedDirectory, "scoring-policy.ts");

export type SourceHash = Readonly<{ path: string; sha256: string }>;

export type ShadowTree = Readonly<{
  /** Hash of every file the candidates were derived from, for the run record. */
  sourceHashes: readonly SourceHash[];
  /** Hash of every generated file. */
  generatedHashes: readonly SourceHash[];
  /** The candidate analyzer factory, loaded from the generated tree. */
  createHandAnalyzer: (options?: Readonly<{ maxNodes?: number }>) => CandidateAnalyzer;
  /** The candidate ranking, loaded from the generated tree. */
  rankScoredPlayActions: (
    context: unknown,
    profile: "casual" | "expert",
    options?: Readonly<{ analyzerNodes?: number; shouldContinue?: () => boolean }>,
  ) => readonly { action: unknown; score: number }[];
}>;

export type CandidateAnalyzer = Readonly<{
  analyze: (hand: readonly CardId[]) => Readonly<{ minimumTurns: number }>;
  stats: () => Readonly<{ cacheHits: number; cacheSize: number; visitedNodes: number }>;
}>;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Replaces `find` with `replace` and asserts it fired exactly once, so a source
 * edit that moves or duplicates an anchor fails loudly instead of silently
 * producing a candidate arm that is not the archived candidate.
 */
function occurrences(source: string, find: string): number {
  return source.split(find).length - 1;
}

function replaceExactlyOnce(
  source: string,
  find: string,
  replace: string,
  expected: number,
  label: string,
): string {
  const found = occurrences(source, find);
  if (found !== expected) {
    throw new Error(
      `Candidate patch anchor (${label}) occurs ${String(found)} times, expected ${String(expected)}; refusing to patch.`,
    );
  }
  return source.split(find).join(replace);
}

/** The archived candidate's replacement bound; taken verbatim from candidate.patch. */
const CANDIDATE_BOUND_FUNCTION = `function partitionTurnBound(hand: readonly CardId[]): number {
  const counts = rankCounts(hand);
  // Each rank is a legal group. Attach each single/pair group to at most one
  // triple; unlike the fast heuristic, no card also funds sequence savings.
  const groups = counts.filter(count => count > 0).length;
  const triples = counts.filter(count => count === 3).length;
  const attachments = counts.filter(count => count === 1 || count === 2).length;
  return groups - Math.min(triples, attachments);
}

export function createHandAnalyzer`;

const EXPORTED_ANALYZER_ANCHOR = "export function createHandAnalyzer";

const BOUND_CALL_SITE = "estimateBasicHandTurns(hand)";
const CANDIDATE_BOUND_CALL = "partitionTurnBound(hand)";

/** Matches only the scoring policy's analyzer import, `.js` or `.ts` alike. */
const REAL_ANALYZER_IMPORT =
  /import \{\n {2}createHandAnalyzer,\n {2}estimateBasicHandTurns,\n {2}type HandAnalyzer,\n\} from "\.\/hand-analyzer\.[cm]?js";/;

// The mirrored analyzer keeps `estimateBasicHandTurns` byte-identical -- the
// candidate patch never touched it -- so the split import stays inside the mirror.
const SHADOW_ANALYZER_IMPORT = `import { estimateBasicHandTurns } from "./hand-analyzer.js";
import {
  createHandAnalyzer,
  type HandAnalyzer,
} from "./hand-analyzer.js";`;

/**
 * Lines the inserted bound function adds. Verified against the shipped source on
 * 2026-09-12; asserted so a source edit that moves the anchor cannot pass quietly.
 */
export const CANDIDATE_BLOCK_LINES = 10;

let boundCallReplacements = 0;

/** Applies the archived candidate's edits to a copy of the shipped analyzer. */
export function applyCandidatePatch(source: string): string {
  const inserted = replaceExactlyOnce(
    source,
    EXPORTED_ANALYZER_ANCHOR,
    CANDIDATE_BOUND_FUNCTION,
    1,
    "bound function insertion",
  );
  const sites = occurrences(inserted, BOUND_CALL_SITE);
  const patched = replaceExactlyOnce(inserted, BOUND_CALL_SITE, CANDIDATE_BOUND_CALL, 2, "bound call sites");
  boundCallReplacements = sites;
  return patched;
}

/**
 * Rewrites only the analyzer import, so `estimateBasicHandTurns` still comes from
 * the real module while `createHandAnalyzer` comes from the shadow copy.
 */
let analyzerImportRewrites = 0;

/** How many times the seed's analyzer import was rewritten. Reset per generation. */
export function analyzerImportRewriteCount(): number {
  return analyzerImportRewrites;
}

export function rewriteAnalyzerImport(source: string): string {
  const matches = source.match(new RegExp(REAL_ANALYZER_IMPORT, "g"))?.length ?? 0;
  if (matches !== 1) {
    throw new Error(
      `Analyzer import anchor occurs ${String(matches)} times, expected 1; refusing to rewrite.`,
    );
  }
  analyzerImportRewrites += 1;
  return source.replace(REAL_ANALYZER_IMPORT, SHADOW_ANALYZER_IMPORT);
}

/**
 * The mirror carries the real `src/` layout one level down, so a specifier that
 * leaves the working area in the real tree leaves it the same way here -- and
 * lands on `.local/harvest/gen/src`, which is a full copy rather than a hole.
 */
const generatedPrefix = posix.join(
  relative(repositoryRoot, generatedDirectory).split(sep).join(posix.sep),
  "src",
);

/**
 * The mirror keeps each file's path relative to `src/`, so a relative specifier
 * resolves the same way in both trees. Only the extension changes.
 *
 * `runtimeModuleSpecifiers` is the repository's own scanner, so the mirror sees
 * exactly the edges the runtime sees -- including `import { type X } from "m"`,
 * which under `verbatimModuleSyntax` still evaluates the module.
 */
export function retargetSpecifiers(
  source: string,
  expected: number,
  label: string,
  fromPath: string,
): string {
  const specifiers = runtimeModuleSpecifiers(source).filter((specifier) => specifier.startsWith("."));
  if (specifiers.length !== expected) {
    throw new Error(
      `${label} has ${String(specifiers.length)} relative imports, expected ${String(expected)}.`,
    );
  }
  // Both paths are expressed relative to `src/`, because the mirror sits at
  // `<gen>/src`. Keeping the repo-relative form would double the prefix.
  const fromSource = posix.relative("src", fromPath);
  const counts = new Map<string, number>();
  for (const specifier of specifiers) {
    counts.set(specifier, (counts.get(specifier) ?? 0) + 1);
  }

  let rewritten = source;
  for (const [specifier, count] of counts) {
    const resolved = posix.normalize(posix.join(posix.dirname(fromSource), specifier));
    const mirrored = posix.relative(posix.dirname(fromSource), resolved);
    const rewrittenSpecifier = (mirrored.startsWith(".") ? mirrored : `./${mirrored}`).replace(
      /\.[cm]?js$/,
      ".ts",
    );
    // One specifier may legitimately appear twice, as when a single import is
    // split into two; the expected count keeps every other repeat failing.
    rewritten = replaceExactlyOnce(
      rewritten,
      `"${specifier}"`,
      `"${rewrittenSpecifier}"`,
      count,
      `${label} specifier ${specifier}`,
    );
  }
  return rewritten;
}

function assertOnlyExpectedEdits(shipped: string, generated: string): void {
  const inserted = generated.split("\n").length - shipped.split("\n").length;
  if (inserted !== CANDIDATE_BLOCK_LINES) {
    throw new Error(
      `Shadow analyzer gained ${String(inserted)} lines, expected ${String(CANDIDATE_BLOCK_LINES)}.`,
    );
  }
  // Count the replacements rather than infer them from the text: the shipped
  // estimate's own definition and its `export function estimateBasicHandTurns`
  // wrapper legitimately still call the shipped estimate.
  if (boundCallReplacements !== 2) {
    throw new Error(`Shadow analyzer replaced ${String(boundCallReplacements)} bound calls, expected 2.`);
  }
  if (occurrences(generated, CANDIDATE_BOUND_FUNCTION) !== 1) {
    throw new Error("Shadow analyzer does not define the candidate bound exactly once.");
  }
}

/** Reads every TypeScript source under `src/`, keyed by repo-relative posix path. */
async function readSourceTree(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        sources.set(relative(repositoryRoot, path).split(sep).join(posix.sep), await readFile(path, "utf8"));
      }
    }
  };
  await walk(join(repositoryRoot, "src"));
  return sources;
}

const SEED_PATH = "src/core/ai/scoring-policy.ts";
const ANALYZER_PATH = "src/core/ai/hand-analyzer.ts";

/**
 * Runtime specifier counts for the two files this module treats specially,
 * asserted so a new import cannot pass quietly. Both differ from a naive text
 * count: `import type { ... }` is elided and is not a runtime edge.
 */
const EXPECTED_IMPORTS: Readonly<Record<string, number>> = Object.freeze({
  [ANALYZER_PATH]: 2,
  [SEED_PATH]: 4,
});

export async function generateShadowTree(): Promise<ShadowTree> {
  analyzerImportRewrites = 0;
  const sources = await readSourceTree();
  const reached = runtimeImportClosure(sources, SEED_PATH);
  const sourceHashes: SourceHash[] = [];
  const generatedHashes: SourceHash[] = [];
  const mirrored = new Set<string>();

  for (const sourcePath of [...reached].sort()) {
    const original = sources.get(sourcePath);
    if (original === undefined) {
      throw new Error(`Shadow tree reached ${sourcePath} but never read it.`);
    }

    // Assert before retargeting: rewriting a specifier would otherwise disturb
    // the byte-level checks, which are about the patch and nothing else.
    let body = original;
    if (sourcePath === ANALYZER_PATH) {
      body = applyCandidatePatch(original);
      assertOnlyExpectedEdits(original, body);
    }
    if (sourcePath === SEED_PATH) {
      body = rewriteAnalyzerImport(original);
    }
    const expectedImports = sourcePath === SEED_PATH
      ? (EXPECTED_IMPORTS[sourcePath] ?? 0) + 1
      : EXPECTED_IMPORTS[sourcePath] ??
        runtimeModuleSpecifiers(original).filter((specifier) => specifier.startsWith(".")).length;
    const generated = retargetSpecifiers(body, expectedImports, sourcePath, sourcePath);

    const target = join(repositoryRoot, generatedPrefix, sourcePath.replace(/^src\//, ""));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, generated, "utf8");
    mirrored.add(sourcePath);
    sourceHashes.push(Object.freeze({ path: sourcePath, sha256: sha256(original) }));
    generatedHashes.push(
      Object.freeze({ path: relative(repositoryRoot, target), sha256: sha256(generated) }),
    );
  }

  // Every rewritten specifier must land on a mirrored file, or the tree Node
  // loads would import a module the diagnosis never intended.
  for (const sourcePath of mirrored) {
    const original = sources.get(sourcePath) ?? "";
    for (const specifier of runtimeModuleSpecifiers(original)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = posix
        .normalize(posix.join(posix.dirname(sourcePath), specifier))
        .replace(/\.[cm]?js$/, ".ts");
      if (!mirrored.has(resolved)) {
        throw new Error(`${sourcePath} imports ${specifier}, which the mirror does not contain.`);
      }
    }
  }

  if (analyzerImportRewrites !== 1) {
    throw new Error(
      `The candidate tree must redirect exactly one analyzer import, saw ${String(analyzerImportRewrites)}.`,
    );
  }

  const entry = (name: string): string =>
    pathToFileURL(join(repositoryRoot, generatedPrefix, "core/ai", name)).href;
  const analyzerModule = (await import(entry("hand-analyzer.ts"))) as {
    createHandAnalyzer: ShadowTree["createHandAnalyzer"];
  };
  const scoringModule = (await import(entry("scoring-policy.ts"))) as {
    rankScoredPlayActions: ShadowTree["rankScoredPlayActions"];
  };

  return Object.freeze({
    sourceHashes: Object.freeze(sourceHashes),
    generatedHashes: Object.freeze(generatedHashes),
    createHandAnalyzer: analyzerModule.createHandAnalyzer,
    rankScoredPlayActions: scoringModule.rankScoredPlayActions,
  });
}
