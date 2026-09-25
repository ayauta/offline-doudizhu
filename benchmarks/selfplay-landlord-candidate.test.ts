/**
 * Freeze the landlord candidate, and freeze what it is being compared against.
 *
 * The candidate is the **existing** TARGET landlord model — the same bytes that
 * produced the +13.25pp development role result. Nothing is retrained here; this
 * file's job is to name the artifact by identity rather than by description, so
 * that "the model we validated" and "the model on disk" cannot drift apart
 * between the freeze and the reveal.
 *
 * The baseline needs the same treatment, and more care: **π1 is a farmer-only
 * enhancement**. Its landlord seat is production `master` with the
 * counterfactual overlay *not installed*, which is a different code path from
 * the farmer seats, not a weaker version of the same one. Writing "π1 landlord"
 * would hide exactly the distinction the development result turned on, so the
 * baseline landlord is recorded as the `master` tier's own identity.
 *
 * ```
 *   AI_SELFPLAY_LANDLORD_FREEZE=1 vitest run --config vitest.benchmark.config.ts \
 *     benchmarks/selfplay-landlord-candidate.test.ts
 * ```
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel } from "../src/core/ai/cf-model.js";
import { SELFPLAY_FEATURE_COUNT, SELFPLAY_FEATURE_NAMES, SELFPLAY_FEATURE_SCHEMA_VERSION, SELFPLAY_HISTORY_LENGTH } from "./selfplay-features.js";
import { ACTION_IDENTITY_VERSION, RANK_SLOT_COUNT } from "./selfplay-actions.js";
import { COLLECTOR_VERSION } from "./selfplay-collector.js";
import { SELFPLAY_DATASET_VERSION, schemaHash } from "./selfplay-dataset.js";
import { closureIdentity } from "./farmer-pi-identity.js";
import { createPi1Bundle } from "./selfplay-policy.js";
import { CF_FEATURE_SCHEMA_VERSION } from "./cf-dataset.js";
import { sha256 } from "./farmer-pi-stage.js";

const ENABLED = process.env.AI_SELFPLAY_LANDLORD_FREEZE === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REH = join(ROOT, ".local", "selfplay-reh", "TARGET");
const OUT = join(ROOT, ".local", "landlord-validation");

export const CANDIDATE_ID = "landlord-independent-validation-v1/candidate-target-landlord";

/**
 * Identity of a repository file, by content.
 *
 * `closureIdentity` walks the `src/` import graph, so it can only name entries
 * under `src/`. The research-side implementations live in `benchmarks/`, and
 * they still need a content identity — a plain digest of the file is the
 * honest one for a leaf that nothing else derives from.
 */
function fileIdentity(role: string, path: string): { role: string; path: string; hash: string } {
  const text = readFileSync(join(ROOT, path), "utf8");
  return { role, path, hash: sha256(text) };
}

/** The frozen candidate: the TARGET landlord model, by content. */
export function candidateModelPath(): string {
  return join(REH, "train-input", "landlord.model.json");
}

export function readCandidate(): {
  readonly raw: Buffer;
  readonly model: ReturnType<typeof parseTreeModel>;
  readonly sha256: string;
  readonly gzipBytes: number;
  readonly rawBytes: number;
} {
  const raw = readFileSync(candidateModelPath());
  const model = parseTreeModel(JSON.parse(raw.toString("utf8")));
  return {
    raw,
    model,
    sha256: createHash("sha256").update(raw).digest("hex"),
    rawBytes: raw.length,
    // gzip is computed later by the caller that has zlib; kept out of here so
    // this module has no compression dependency.
    gzipBytes: -1,
  };
}

describe.skipIf(!ENABLED)("freeze the landlord candidate and its baseline", () => {
  it("writes an immutable manifest of identities", () => {
    mkdirSync(OUT, { recursive: true });
    const raw = readFileSync(candidateModelPath());
    const model = parseTreeModel(JSON.parse(raw.toString("utf8")));
    const modelSha = createHash("sha256").update(raw).digest("hex");

    expect(model.numFeatures).toBe(SELFPLAY_FEATURE_COUNT);
    expect(model.featureNames).toEqual([...SELFPLAY_FEATURE_NAMES]);
    expect(model.featureNames.length).toBe(403);

    const pi1 = createPi1Bundle("master");

    const manifest = {
      candidateId: CANDIDATE_ID,
      candidate: {
        role: "landlord",
        modelPath: "TARGET/train-input/landlord.model.json",
        modelSha256: modelSha,
        rawBytes: raw.length,
        numTrees: model.numTrees,
        numFeatures: model.numFeatures,
        lightgbmVersion: model.lightgbmVersion,
        artifactModelSha256: (
          JSON.parse(raw.toString("utf8")) as { modelSha256: string }
        ).modelSha256,
      },
      featureSchema: {
        version: SELFPLAY_FEATURE_SCHEMA_VERSION,
        datasetVersion: SELFPLAY_DATASET_VERSION,
        columns: SELFPLAY_FEATURE_COUNT,
        schemaHash: schemaHash(),
        legacyCfSchemaVersion: CF_FEATURE_SCHEMA_VERSION,
      },
      historyRepresentation: {
        recentEvents: SELFPLAY_HISTORY_LENGTH,
        padding: "patternKind=-1, distinguishable from a real pass",
      },
      legalActionEnumerator: closureIdentity(
        "legal-action-enumerator",
        "src/core/rules/generate-legal-actions.ts",
      ),
      actionIdentity: {
        version: ACTION_IDENTITY_VERSION,
        rankSlots: RANK_SLOT_COUNT,
        canonicalOrder: "generateLegalActions order: pattern kind, card count, main rank strength, card id",
        tieBreak: "highest score; ties resolved to the earliest position in that order",
      },
      selectorImplementation: {
        qPolicy: fileIdentity("landlord-q-policy", "benchmarks/selfplay-policy.ts"),
        featureBuilder: fileIdentity("state-action-features", "benchmarks/selfplay-features.ts"),
        collector: fileIdentity("three-role-collector", "benchmarks/selfplay-collector.ts"),
        dataset: fileIdentity("dataset-and-split", "benchmarks/selfplay-dataset.ts"),
        treeEvaluator: closureIdentity("tree-evaluator", "src/core/ai/cf-model.ts"),
      },
      collector: { version: COLLECTOR_VERSION },
      baseline: {
        /*
         * The landlord seat of the incumbent. `final-validation.md` records
         * "arm-A games 24, overlay decisions on the landlord: 0" — the overlay
         * is never installed on a landlord — so the baseline landlord IS the
         * master tier, and that is what is hashed here.
         */
        landlord: {
          description: "production master tier, counterfactual overlay NOT installed",
          identity: closureIdentity("baseline-landlord-master-tier", "src/app/ai/decision-handler.ts"),
        },
        farmerNext: {
          description: "pi1: master tier plus the frozen single-layer cf overlay, bound to that seat",
          identity: fileIdentity("pi1-farmer-next-chain", "benchmarks/farmer-pi-chain.ts"),
        },
        farmerPrevious: {
          description: "pi1: same chain, bound to the other farmer seat",
          identity: fileIdentity("pi1-farmer-previous-chain", "benchmarks/farmer-pi-chain.ts"),
        },
        championBundleIdentity: pi1.identity,
        championModelSha256: "010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359",
        championThreshold: 0.01,
      },
      gameRules: closureIdentity("game-rules", "src/core/rules/index.ts"),
      dealGenerator: closureIdentity("deal-generator", "src/core/cards/index.ts"),
      training: {
        manifestSha256: sha256(readFileSync(join(REH, "manifest.json"), "utf8")),
        dealRange: [907_001, 913_000],
        groups: 6_000,
        environment: JSON.parse(readFileSync(join(REH, "manifest.json"), "utf8")).environment,
        lgbm: JSON.parse(
          readFileSync(join(REH, "train-input", "landlord.train-config.json"), "utf8"),
        ).params,
      },
    };

    const text = JSON.stringify(manifest, null, 2);
    writeFileSync(join(OUT, "candidate-manifest.json"), `${text}\n`);
    writeFileSync(join(OUT, "candidate-manifest.sha256"), `${sha256(text)}  candidate-manifest.json\n`);
    console.log(`[landlord-freeze] candidate ${modelSha.slice(0, 16)}… (${raw.length} B, ${model.numTrees} trees)`);
    console.log(`[landlord-freeze] manifest sha256 ${sha256(text)}`);
    console.log(`[landlord-freeze] baseline landlord identity ${manifest.baseline.landlord.identity.hash.slice(0, 16)}…`);
    expect(manifest.candidate.modelSha256).toHaveLength(64);
  }, 600_000);
});
