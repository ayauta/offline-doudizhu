/**
 * Landlord audit: candidate manifests, and the environment the landlord
 * training rows actually came from.
 *
 * Three things this measures, none of which is a strength claim:
 *
 * 1. **CHEAP landlord manifest**, at the same level of identity as TARGET's.
 * 2. **Game-level opponent distribution.** The opponent draw is a keyed function
 *    of `(salt, dealSeed, scenarioIndex)`, so the exact distribution over the
 *    6000 training groups is computable without playing a single game.
 * 3. **Row-level effective distribution.** Only scenario `L` produces landlord
 *    rows — the learning seat is the landlord only there — and scenario `L`
 *    draws at `scenarioIndex 0`. So the landlord model's effective environment
 *    is the pair distribution *at index 0*, weighted by how many landlord
 *    decisions each such game contained. Game-level percentages and row-level
 *    percentages are different numbers, and LightGBM only ever sees the second.
 *
 * ```
 *   AI_SELFPLAY_AUDIT=1 AI_SELFPLAY_AUDIT_START=907001 AI_SELFPLAY_AUDIT_GROUPS=750 \
 *   AI_SELFPLAY_AUDIT_BRANCH=TARGET AI_SELFPLAY_AUDIT_OUT=<dir> vitest run \
 *     --config vitest.benchmark.config.ts benchmarks/selfplay-landlord-audit.test.ts
 * ```
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel } from "../src/core/ai/cf-model.js";
import {
  DEFAULT_MIXTURE_WEIGHTS,
  createPi1Bundle,
  createQModelPolicy,
  createTierBundle,
  drawOpponents,
  roleOfSeat,
  scenarioSpec,
  type MixtureSpec,
} from "./selfplay-policy.js";
import { collectEpisode, groupScenarios, type CollectorConfig } from "./selfplay-collector.js";
import { branchConfig, branchManifest } from "./selfplay-rehearsal-collect.test.js";
import { closureIdentity } from "./farmer-pi-identity.js";
import { sha256 } from "./farmer-pi-stage.js";
import { ACTION_IDENTITY_VERSION } from "./selfplay-actions.js";
import { SELFPLAY_FEATURE_COUNT, SELFPLAY_FEATURE_SCHEMA_VERSION, SELFPLAY_HISTORY_LENGTH } from "./selfplay-features.js";
import { schemaHash } from "./selfplay-dataset.js";

const ENABLED = process.env.AI_SELFPLAY_AUDIT === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = process.env.AI_SELFPLAY_AUDIT_OUT ?? join(ROOT, ".local", "landlord-audit");
const BRANCH = (process.env.AI_SELFPLAY_AUDIT_BRANCH ?? "TARGET") as "CHEAP" | "TARGET";
const AUDIT_START = Number(process.env.AI_SELFPLAY_AUDIT_START ?? 907_001);
const AUDIT_GROUPS = Number(process.env.AI_SELFPLAY_AUDIT_GROUPS ?? 6_000);

const SCENARIOS = groupScenarios();

/** Human-readable, hash-bearing identity for every bundle the pool contains. */
function bundleIdentities(): Record<string, Record<string, unknown>> {
  const pi1 = createPi1Bundle("master");
  return {
    PI1: {
      name: "pi1 farmer (master + frozen single-layer cf overlay, seat-bound)",
      runtimeIdentity: pi1.identity,
      championModelSha256: "010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359",
      overlay: "installed on farmer seats only",
      tier: "master",
    },
    P0: {
      name: "production master, counterfactual overlay NOT installed",
      runtimeIdentity: createTierBundle("P0", "master").identity,
      implementation: closureIdentity("master-tier", "src/app/ai/decision-handler.ts").hash,
      overlay: "never",
      tier: "master",
    },
    "REH-current": {
      name: "scoring casual (CASUAL ranking with analyzerNodes 24)",
      runtimeIdentity: createTierBundle("REH-current", "casual").identity,
      implementation: closureIdentity("default-tier", "src/core/ai/index.ts").hash,
      overlay: "never",
      tier: "casual",
    },
    "REH-history": {
      name: "DEFAULT_AI_STRATEGY (shipped casual rule policy)",
      runtimeIdentity: createTierBundle("REH-history", "default").identity,
      implementation: closureIdentity("default-tier", "src/core/ai/index.ts").hash,
      overlay: "never",
      tier: "default",
    },
  };
}

function mixtureOf(branch: "CHEAP" | "TARGET"): MixtureSpec {
  const current = branch === "CHEAP" ? "REH-current" : "PI1";
  const history = branch === "CHEAP" ? "REH-history" : "P0";
  return Object.freeze({
    version: "fas-mixture-v1",
    current,
    history: Object.freeze([history]),
    weights: DEFAULT_MIXTURE_WEIGHTS,
  });
}

function pairLabel(a: string, b: string): string {
  return [a, b].sort().join(" / ");
}

describe.skipIf(!ENABLED)("landlord audit shard", () => {
  it("measures the actual opponent distribution behind the landlord rows", () => {
    mkdirSync(OUT, { recursive: true });
    const mixture = mixtureOf(BRANCH);
    const config: CollectorConfig = branchConfig(BRANCH);

    // ---- game-level: the keyed draw is a pure function, so this is exact ----
    const gamePairs = new Map<string, number>();
    const landlordGamePairs = new Map<string, number>();
    const lDecisions = new Map<string, number[]>();
    let games = 0;
    let landlordGames = 0;
    const perGroupLandlordRows: number[] = [];

    const started = Date.now();
    for (let offset = 0; offset < AUDIT_GROUPS; offset += 1) {
      const dealIndex = AUDIT_START + offset;
      let landlordRowsThisGroup = 0;
      for (let scenarioIndex = 0; scenarioIndex < SCENARIOS.length; scenarioIndex += 1) {
        const scenario = SCENARIOS[scenarioIndex]!;
        const draw = drawOpponents(mixture, config.mixtureSalt, dealIndex, scenarioIndex);
        const label = pairLabel(draw.bundleA, draw.bundleB);
        gamePairs.set(label, (gamePairs.get(label) ?? 0) + 1);
        games += 1;

        const spec = scenarioSpec(dealIndex, scenario);
        if (roleOfSeat(spec.learningSeat, spec.landlord) !== "landlord") {
          continue;
        }
        // Only `L` reaches here: the learning seat is the landlord only there.
        landlordGames += 1;
        landlordGamePairs.set(label, (landlordGamePairs.get(label) ?? 0) + 1);

        // The landlord's own decisions in that game — the row count that carries
        // this game's environment into the training set.
        const episode = collectEpisode(config, dealIndex, scenario);
        const rows = episode.records.length;
        landlordRowsThisGroup += rows;
        const list = lDecisions.get(label) ?? [];
        list.push(rows);
        lDecisions.set(label, list);
      }
      perGroupLandlordRows.push(landlordRowsThisGroup);
    }
    const elapsed = Date.now() - started;

    const totalLandlordRows = perGroupLandlordRows.reduce((sum, value) => sum + value, 0);
    const gameLevel = [...gamePairs.entries()].sort((a, b) => b[1] - a[1]);
    const rowLevel = [...lDecisions.entries()]
      .map(([label, counts]) => [
        label,
        {
          games: counts.length,
          rows: counts.reduce((sum, value) => sum + value, 0),
        },
      ] as const)
      .sort((a, b) => b[1].rows - a[1].rows);

    const artefacts = {
      bundleIdentities: bundleIdentities(),
      branch: BRANCH,
      environment: branchManifest(BRANCH),
      groups: AUDIT_GROUPS,
      games,
      landlordGames,
      totalLandlordRows,
      meanLandlordDecisionsPerGame: totalLandlordRows / Math.max(1, landlordGames),
      meanGameLength: null,
      gameLevel: Object.fromEntries(gameLevel),
      rowLevel: Object.fromEntries(
        rowLevel.map(([label, value]) => [label, value]),
      ),
    };
    writeFileSync(join(OUT, `${BRANCH}-distribution.json`), JSON.stringify(artefacts, null, 2));
    console.log(
      `[audit] ${BRANCH}: ${games} games, ${landlordGames} landlord games, ` +
        `${totalLandlordRows} landlord rows, ${elapsed / 1000}s\n` +
        gameLevel.map(([label, n]) => `   game-level ${label}: ${n} (${((100 * n) / games).toFixed(2)}%)`).join("\n") +
        "\n" +
        rowLevel
          .map(
            ([label, value]) =>
              `   row-level  ${label}: ${value.rows} rows (${((100 * value.rows) / totalLandlordRows).toFixed(2)}%) ` +
              `over ${value.games} games, mean ${(value.rows / value.games).toFixed(2)}/game`,
          )
          .join("\n"),
    );
    expect(games).toBe(AUDIT_GROUPS * 3);
  }, 86_400_000);

  it("writes the CHEAP landlord candidate manifest", () => {
    const path = join(ROOT, ".local/selfplay-reh/CHEAP/train-input/landlord.model.json");
    const raw = readFileSync(path);
    const model = parseTreeModel(JSON.parse(raw.toString("utf8")));
    const pi1 = createPi1Bundle("master");
    const manifest = {
      candidateId: "full-action-selfplay-v1/candidate-cheap-landlord",
      role: "landlord",
      branch: "CHEAP",
      modelPath: "CHEAP/train-input/landlord.model.json",
      modelSha256: createHash("sha256").update(raw).digest("hex"),
      rawBytes: raw.length,
      gzipBytes: gzipSync(raw, { level: 9 }).length,
      numTrees: model.numTrees,
      numFeatures: model.numFeatures,
      lightgbmVersion: model.lightgbmVersion,
      featureSchema: { version: SELFPLAY_FEATURE_SCHEMA_VERSION, columns: SELFPLAY_FEATURE_COUNT, schemaHash: schemaHash() },
      historyRepresentation: { recentEvents: SELFPLAY_HISTORY_LENGTH },
      actionIdentityVersion: ACTION_IDENTITY_VERSION,
      canonicalOrder: "generateLegalActions order",
      tieBreak: "highest score, earliest position, never pass",
      enumerator: closureIdentity("legal-action-enumerator", "src/core/rules/generate-legal-actions.ts").hash,
      treeEvaluator: closureIdentity("tree-evaluator", "src/core/ai/cf-model.ts").hash,
      training: {
        manifestSha256: sha256(readFileSync(join(ROOT, ".local/selfplay-reh/CHEAP/manifest.json"), "utf8")),
        dealRange: [907_001, 913_000],
        groups: 6_000,
        environment: branchManifest("CHEAP"),
      },
      metadataOnly: true,
      note: "Sizes are the artifact's own bytes; the digests inside each JSON are self-referential and are not sha256sum-verifiable. See the audit report for the verification convention.",
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "cheap-landlord-manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(
      `[audit] CHEAP landlord: sha256 ${manifest.modelSha256}\n` +
        `        raw ${manifest.rawBytes} B, gzip ${manifest.gzipBytes} B, trees ${manifest.numTrees}`,
    );
    void pi1;
    expect(manifest.modelSha256).toHaveLength(64);
  }, 300_000);

  it("reports the CHEAP standalone-equivalence fixture coverage", () => {
    // The equivalence run itself lives in selfplay-landlord-standalone.test.ts;
    // here the CHEAP model is simply loaded and scored once to prove it parses
    // under the same 403-column schema the selector enforces.
    const path = join(ROOT, ".local/selfplay-reh/CHEAP/train-input/landlord.model.json");
    const model = parseTreeModel(JSON.parse(readFileSync(path, "utf8")));
    expect(model.numFeatures).toBe(403);
    expect(model.numTrees).toBe(512);
    const policy = createQModelPolicy(model, "cheap");
    expect(typeof policy).toBe("function");
  }, 300_000);
});
