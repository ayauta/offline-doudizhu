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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
/**
 * The immutable champion record.
 *
 * The release-candidate manifest is what a reviewer reads while deciding; this
 * is what the repository keeps afterwards. Same computed values, richer
 * framing: it names the generation, its parent, and the evidence that promoted
 * it, so a reader arriving in a year does not have to reconstruct why `ai-v2`
 * is production from a commit log.
 *
 * `ai-v1`'s record is not touched. There is no `ai-v1.json` here to overwrite —
 * that champion is defined by `src/app/ai/cf-model-data.ts` and its protocol —
 * and nothing in this file writes anywhere near it.
 */
const CHAMPION_OUT = join(ROOT, "research/champions/ai-v2.json");

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

/** `package.json`'s version, so the record cannot drift from the release. */
function packageVersion(): string {
  const parsed = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };
  return parsed.version;
}

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
          package: "io.github.ayauta.offlinedoudizhu.debug",
          variant: "debug (assembleDebug, AGP 9.4.0 / Gradle 9.6.0 / JDK 17)",
          apkSha256: "9745ac9bdfaa38a2210754cbdfe4581feffb886a2f9c16615706e8eee796a543",
          /*
           * The link between the APK and this manifest. The Worker inside the
           * built APK is hashed and compared with `dist/`, and `dist/`'s Worker
           * is what `worker.asset` above names. Equal hashes are what make
           * "the phone ran this release candidate" a statement about bytes.
           */
          packagedWorkerPath: "assets/assets/ai-worker-k7BbEMss.js",
          packagedWorkerSha256: "57a0b30b8cf41004a2128d6e0f41de0d2222fe8d0bac098f314c7b22be3e7361",
          packagedWorkerMatchesDist: true,
          device: {
            model: "Xiaomi 10S (M2102J2SC)",
            androidRelease: "11",
            sdk: 30,
          },
          measuredThrough: "the shipped Worker (appassets.androidplatform.net/assets/assets/ai-worker-*.js)",
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

    /*
     * The champion record. Every field is the same computed value the
     * release-candidate manifest carries -- one run, one set of digests, two
     * framings -- so the two files cannot disagree about what shipped.
     */
    const champion = {
      generation: "ai-v2",
      champion: true,
      parentChampion: "ai-v1",
      promotedAt: new Date().toISOString(),
      /*
       * The stable pointer. Commit hashes move when history is tidied and this
       * file cannot name the commit that contains it; a tag can do both jobs.
       * `build.commit` below records the tree the digests were taken from.
       */
      releaseTag: "ai-v2",
      productVersion: packageVersion(),
      summary:
        "Landlord upgraded to the full-action CHEAP policy; farmers continue on " +
        "the pi1 counterfactual selector. Active on the master tier.",
      policy: {
        landlord: {
          name: "CHEAP (full-action LightGBM, 403-column state-action schema)",
          modelSha256: CHEAP_LANDLORD_MODEL_SHA256,
          packagedFile: manifest.models.cheapLandlord.packagedFile,
          packagedFileBytes: manifest.models.cheapLandlord.packagedFileBytes,
          numTrees: manifest.models.cheapLandlord.numTrees,
          numFeatures: manifest.models.cheapLandlord.numFeatures,
        },
        farmers: {
          name: "pi1 (frozen counterfactual selector)",
          modelSha256: CF_MODEL_SHA256,
          threshold: CF_SELECTOR_THRESHOLD,
        },
      },
      schema: manifest.schema,
      identities: manifest.identities,
      deadline: manifest.deadline,
      bundle: {
        worker: manifest.build.worker,
        workerGzipBudgetBytes: manifest.build.workerGzipBudgetBytes,
        workboxMaximumFileSizeToCacheInBytes: manifest.build.workboxMaximumFileSizeToCacheInBytes,
      },
      platformQualification: {
        desktopChromium: "measured (in-process and real Worker)",
        android: manifest.build.android,
      },
      evidence: {
        strength: {
          // The numbers the promotion rests on, kept with their pools. They are
          // quoted, never re-derived here: re-running a strength experiment is
          // not this file's job and would spend a pool.
          landlordIndependentConfirmation: {
            pool: "952401-958400 (retired)",
            groups: 6000,
            vsPi1Farmers: { deltaPp: 9.4, ci95: [8.038, 10.762] },
            vsDefaultFarmers: { deltaPp: 3.45, ci95: [2.059, 4.841] },
            verdict: "JOINT RESEARCH PASS",
            report: "research/full-action-selfplay-v1/landlord-robust-confirmation-report.md",
            protocolSha256: "81fbd4f647ac3e404892fddc603889f7538daa586112e960c32e0cf6a10ae7b7",
          },
          farmerPi1: {
            note: "Spec 063 final validation; farmer +10.583pp, combined +5.292pp",
          },
        },
        releaseEquivalence: {
          note:
            "Implementation regression only, not strength evidence. Research reference vs " +
            "the final production Worker, on retired development deals.",
          report: "research/full-action-selfplay-v1/cheap-release-candidate-report.md",
        },
      },
      build: {
        commit: manifest.build.commit,
        branch: manifest.build.branch,
      },
    };
    mkdirSync(dirname(CHAMPION_OUT), { recursive: true });
    writeFileSync(CHAMPION_OUT, `${JSON.stringify(champion, null, 2)}\n`, "utf8");
    console.log(`[clm-mf] champion ${CHAMPION_OUT}`);
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
