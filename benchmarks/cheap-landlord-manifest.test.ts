/**
 * Emit the release-candidate manifest for the CHEAP landlord integration.
 *
 *     AI_CHEAP_MANIFEST=1 npx vitest run --config vitest.benchmark.config.ts \
 *       benchmarks/cheap-landlord-manifest.test.ts
 *
 * Writes `research/full-action-selfplay-v1/ai-v2-release-candidate-manifest.json`.
 *
 * **This is not a champion archive and not a promotion.** The Farmer Policy
 * Iteration factory reserves `ai-vN-research` for champions it promotes and
 * `ai-v1` for the shipped model; nothing here writes to either. The name says
 * "release candidate" because that is what it is: a record of which bytes the
 * candidate is made of, so a reviewer can check them instead of trusting a
 * commit message.
 *
 * Every value is imported from the module that defines it, not re-derived by
 * pattern-matching source text. That matters for the identities in particular:
 * a manifest that recomputed them its own way could disagree with the guard in
 * `tests/core/farmer-pi-protocol.test.ts` and neither would be obviously wrong.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { closureIdentity } from "./farmer-pi-identity.js";
import { SELFPLAY_FEATURE_COUNT, SELFPLAY_FEATURE_NAMES, SELFPLAY_FEATURE_SCHEMA_VERSION, SELFPLAY_HISTORY_LENGTH } from "../src/core/ai/fa-features.js";
import { SELFPLAY_DATASET_VERSION, schemaHash } from "./selfplay-dataset.js";
import { CHEAP_LANDLORD_MODEL_SHA256 } from "../src/app/ai/cheap-landlord-model.js";
import { CHEAP_LANDLORD_POLICY_VERSION } from "../src/app/ai/cheap-landlord.js";
import { CF_MODEL_SHA256, CF_SELECTOR_THRESHOLD } from "../src/app/ai/cf-model-data.js";
import { ENHANCED_AI_BUDGET_MS } from "../src/app/ai/decision-handler.js";
import { ENHANCED_AI_RESPONSE_WINDOW_MS } from "../src/app/ai/enhanced-ai-turn.js";

const ENABLED = process.env.AI_CHEAP_MANIFEST === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(ROOT, "dist");
const OUT = join(ROOT, "research/full-action-selfplay-v1/ai-v2-release-candidate-manifest.json");

/** The values the Farmer PI protocol froze, kept beside the current ones. */
const FROZEN = Object.freeze({
  strongSeat: "a6ae8a6aebd31e88172a12a64845284f799b1487abc07a49d934188a0cee89e3",
  orderedTopThree: "e63d084ecd2d7e262886e682bbaad87490fccf340081092ae42200505b922df2",
  legalActionEnumerator: "7f1645eee455c4bcfcb6e9a984286e830005f83c7afc8a45a4b4667f5ede3c18",
  treeEvaluator: "43bc62798482e234fbaf6148e1e62a08b912876503d261451c3f5b089084a77f",
  defaultTier: "2a39386007949cf1c37010c1d97f61e8468a3d41b44df50cebf70c9cc46b7297",
});

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes).digest("hex");
const fileSha = (path: string) => sha256(readFileSync(path));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function workerAsset(): Record<string, unknown> {
  if (!existsSync(DIST)) {
    return { note: "dist/ absent; run `pnpm build` before generating the manifest" };
  }
  const names = readdirSync(join(DIST, "assets")).filter((name) => /^ai-worker-.*\.js$/.test(name));
  if (names.length !== 1) {
    return { note: `expected exactly one worker asset, found ${names.length}` };
  }
  const bytes = readFileSync(join(DIST, "assets", names[0]!));
  return {
    asset: `assets/${names[0]}`,
    rawBytes: bytes.length,
    gzipBytes: gzipSync(bytes, { level: 9 }).length,
  };
}

/** Reads a numeric literal out of a config file, and says so when it cannot. */
function numericOption(path: string, pattern: RegExp, stripSeparators = false): number | null {
  const source = readFileSync(join(ROOT, path), "utf8");
  const match = source.match(pattern);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const text = stripSeparators ? match[1].replaceAll("_", "") : match[1];
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

describe.skipIf(!ENABLED)("release-candidate manifest", () => {
  it("writes the identity of everything the candidate is made of", () => {
    const packaged = readFileSync(join(ROOT, "src/app/ai/cheap-landlord-model.ts"));
    const manifest = {
      kind: "release-candidate-manifest",
      champion: false,
      note:
        "Not a champion archive and not a promotion. The ai-v1 model recorded here is the " +
        "shipped production model and is unchanged by this work.",
      generatedAt: new Date().toISOString(),

      models: {
        cheapLandlord: {
          confirmedSha256: "070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b",
          declaredSha256: CHEAP_LANDLORD_MODEL_SHA256,
          // The file that carries it, not the table: a reviewer diffing the tree
          // needs the byte count that will appear in the commit.
          packagedFile: "src/app/ai/cheap-landlord-model.ts",
          packagedFileBytes: packaged.length,
          packagedFileSha256: sha256(packaged),
          numTrees: 512,
          numFeatures: SELFPLAY_FEATURE_COUNT,
        },
        pi1Farmers: {
          source: "src/app/ai/cf-model-data.ts",
          sha256: CF_MODEL_SHA256,
          selectorThreshold: CF_SELECTOR_THRESHOLD,
        },
      },

      schema: {
        module: "src/core/ai/fa-features.ts",
        fileSha256: fileSha(join(ROOT, "src/core/ai/fa-features.ts")),
        datasetVersion: SELFPLAY_DATASET_VERSION,
        featureSchemaVersion: SELFPLAY_FEATURE_SCHEMA_VERSION,
        historyLength: SELFPLAY_HISTORY_LENGTH,
        columns: SELFPLAY_FEATURE_COUNT,
        columnsMatchNames: SELFPLAY_FEATURE_NAMES.length === SELFPLAY_FEATURE_COUNT,
        schemaHash: schemaHash(),
      },

      identities: {
        strongSeat: {
          entry: "src/app/ai/decision-handler.ts",
          current: closureIdentity("strong seat (master)", "src/app/ai/decision-handler.ts").hash,
          frozenInProtocol: FROZEN.strongSeat,
          changedBecause: "decision-handler.ts was edited by the landlord integration",
        },
        orderedTopThree: {
          entry: "src/app/ai/cf-selector.ts",
          current: closureIdentity("ordered top three", "src/app/ai/cf-selector.ts").hash,
          frozenInProtocol: FROZEN.orderedTopThree,
          changedBecause: "cf-selector.ts imports ENHANCED_AI_SEARCH from decision-handler.ts",
        },
        legalActionEnumerator: {
          entry: "src/core/rules/generate-legal-actions.ts",
          current: closureIdentity("legal-action-enumerator", "src/core/rules/generate-legal-actions.ts").hash,
          frozenInProtocol: FROZEN.legalActionEnumerator,
          changedBecause: null,
        },
        treeEvaluator: {
          entry: "src/core/ai/cf-model.ts",
          current: closureIdentity("tree-evaluator", "src/core/ai/cf-model.ts").hash,
          frozenInProtocol: FROZEN.treeEvaluator,
          changedBecause: null,
        },
        defaultTier: {
          entry: "src/core/ai/index.ts",
          current: closureIdentity("teammate (tau)", "src/core/ai/index.ts").hash,
          frozenInProtocol: FROZEN.defaultTier,
          changedBecause: null,
        },
      },

      policy: {
        version: CHEAP_LANDLORD_POLICY_VERSION,
        scope: "master tier, landlord seat only",
        canonicalOrder: "generateLegalActions order",
        tieBreak: "highest score; ties to the earliest position; never resolves to pass",
        candidateSet: "context.legalActions, the full legal set; no shortlist, no topK",
      },

      deadline: {
        responseWindowMs: ENHANCED_AI_RESPONSE_WINDOW_MS,
        masterBudgetMs: ENHANCED_AI_BUDGET_MS.master,
        casualBudgetMs: ENHANCED_AI_BUDGET_MS.casual,
        landlordPolicyReadsMasterBudget: false,
        fallback:
          "decline -> production path (model unavailable, empty legal set, schema mismatch, " +
          "scoring failure); otherwise the client's response budget expires and the turn " +
          "falls back to the casual strategy",
      },

      build: {
        commit: git("rev-parse", "HEAD"),
        branch: git("rev-parse", "--abbrev-ref", "HEAD"),
        worker: workerAsset(),
        // The literal is written as `650_000`; `Number` does not read separators,
        // so the underscores come out before it does.
        workerGzipBudgetBytes: numericOption(
          "scripts/check-bundle.mjs",
          /label: "enhanced AI worker",\s*\n\s*limitBytes: ([\d_]+)/,
          true,
        ),
        workboxMaximumFileSizeToCacheInBytes: (() => {
          const source = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
          const match = source.match(/maximumFileSizeToCacheInBytes: (\d+) \* (\d+) \* (\d+)/);
          return match === null ? null : Number(match[1]) * Number(match[2]) * Number(match[3]);
        })(),
        android: {
          note:
            "The device probe was injected over CDP into the installed .debug WebView; the " +
            "APK's own worker bundle is not what it measured. See the report.",
          installedPackage: "io.github.ayauta.offlinedoudizhu.debug",
        },
      },
    };

    // The candidate is only a candidate if the table the Worker parses is the
    // table the confirmation passed. A manifest is the wrong place to discover
    // otherwise, so this refuses rather than records.
    expect(CHEAP_LANDLORD_MODEL_SHA256).toBe(manifest.models.cheapLandlord.confirmedSha256);
    expect(manifest.schema.columnsMatchNames).toBe(true);
    expect(manifest.schema.columns).toBe(403);

    writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`[clm-mf] wrote ${OUT}`);
    console.log(
      `[clm-mf] cheap ${CHEAP_LANDLORD_MODEL_SHA256.slice(0, 16)}… pi1 ${CF_MODEL_SHA256.slice(0, 16)}… ` +
        `schema ${manifest.schema.schemaHash.slice(0, 16)}…`,
    );
    console.log(
      `[clm-mf] worker ${JSON.stringify(workerAsset())} budget ${manifest.build.workerGzipBudgetBytes} ` +
        `workbox ${manifest.build.workboxMaximumFileSizeToCacheInBytes}`,
    );
  });
});
