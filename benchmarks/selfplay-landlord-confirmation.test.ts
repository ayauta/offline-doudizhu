/**
 * CHEAP landlord — joint dual-environment confirmation, one shard.
 *
 * Four games per initial deal: one baseline and one CHEAP arm in each of two
 * environments. Both environments run on the **same** deals, and every group
 * goes into the denominator — there is no root filter, no useful-state filter
 * and no post-hoc exclusion. An integrity failure stops the run; it never
 * quietly shrinks N.
 *
 * The console is blind: progress, throughput and checkpoint counts only. Wins,
 * deltas and intervals appear once, after both environments have sealed.
 *
 * ```
 *   AI_SELFPLAY_LRC=1 AI_SELFPLAY_LRC_START=952401 AI_SELFPLAY_LRC_GROUPS=750 \
 *   AI_SELFPLAY_LRC_OUT=<dir> vitest run --config vitest.benchmark.config.ts \
 *     benchmarks/selfplay-landlord-confirmation.test.ts
 * ```
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel } from "../src/core/ai/cf-model.js";
import {
  createPi1Bundle,
  createQModelPolicy,
  createTierPolicy,
  type ActionPolicy,
  type PolicyBundle,
} from "./selfplay-policy.js";
import { collectEpisode, type CollectorConfig } from "./selfplay-collector.js";

const ENABLED = process.env.AI_SELFPLAY_LRC === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = process.env.AI_SELFPLAY_LRC_OUT ?? join(ROOT, ".local", "landlord-robust", "run");
const CHECKPOINTS = join(OUT_DIR, "checkpoints");

/** Frozen by landlord-robust-confirmation-protocol.md: namespace, range, N. */
const START = Number(process.env.AI_SELFPLAY_LRC_START ?? 952_401);
const GROUPS = Number(process.env.AI_SELFPLAY_LRC_GROUPS ?? 6_000);
const CHEAP_SHA = "070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b";

export interface ConfirmRecord {
  readonly dealIndex: number;
  /** Environment A: baseline landlord / CHEAP landlord, both with pi1 farmers. */
  readonly aBaseline: boolean;
  readonly aCheap: boolean;
  /** Environment B: same two landlords, both with DEFAULT farmers. */
  readonly bBaseline: boolean;
  readonly bCheap: boolean;
}

function loadCheap(): ActionPolicy {
  const bytes = readFileSync(join(ROOT, ".local/selfplay-reh/CHEAP/train-input/landlord.model.json"));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== CHEAP_SHA) {
    throw new Error(`CHEAP landlord hashes to ${digest}, not the frozen ${CHEAP_SHA}.`);
  }
  const model = parseTreeModel(JSON.parse(bytes.toString("utf8")));
  if (model.numFeatures !== 403) {
    throw new Error(`CHEAP landlord declares ${model.numFeatures} features, not 403.`);
  }
  return createQModelPolicy(model, CHEAP_SHA);
}

function bundle(id: string, landlord: ActionPolicy, next: ActionPolicy, previous: ActionPolicy): PolicyBundle {
  return Object.freeze({
    bundleId: id,
    identity: id,
    roles: Object.freeze({ landlord, "farmer-next": next, "farmer-previous": previous }),
  });
}

/** Every seat plays `seat`'s bundle; exploration off; no mixture noise. */
function configFor(seat: PolicyBundle, others: PolicyBundle): CollectorConfig {
  return Object.freeze({
    bundles: new Map<string, PolicyBundle>([
      [others.bundleId, others],
      [seat.bundleId, seat],
    ]),
    learningBundleId: seat.bundleId,
    mixture: Object.freeze({
      version: "fas-mixture-v1",
      current: seat.bundleId,
      history: Object.freeze([others.bundleId]),
      weights: Object.freeze({ current: 1, sharedHistory: 0, independentHistory: 0 }),
    }),
    epsilon: 0,
    explorationSalt: 0,
    mixtureSalt: 0,
    auditProposal: false,
  });
}

/** Scenario `L` seats the learning seat as the landlord; we read its team's result. */
function landlordTeamWon(config: CollectorConfig, dealIndex: number): boolean {
  const episode = collectEpisode(config, dealIndex, "L");
  if (episode.role !== "landlord") {
    throw new Error(`Scenario L did not seat the learning seat as landlord at ${dealIndex}.`);
  }
  return episode.learningTeamWon;
}

describe.skipIf(!ENABLED)("CHEAP landlord joint confirmation shard", () => {
  it("runs four games per deal and checkpoints each completed deal", () => {
    mkdirSync(CHECKPOINTS, { recursive: true });
    const cheap = loadCheap();
    const pi1 = createPi1Bundle("master");
    const baselineLandlord = createTierPolicy("master");
    const defaultFarmer = createTierPolicy("default");

    // Environment A: pi1 farmers.
    const aAnchor = bundle("LRC-A0", baselineLandlord, pi1.roles["farmer-next"], pi1.roles["farmer-previous"]);
    const aCheap = bundle("LRC-A1", cheap, pi1.roles["farmer-next"], pi1.roles["farmer-previous"]);
    // Environment B: DEFAULT farmers, same two landlords.
    const bAnchor = bundle("LRC-B0", baselineLandlord, defaultFarmer, defaultFarmer);
    const bCheap = bundle("LRC-B1", cheap, defaultFarmer, defaultFarmer);

    const cfgA0 = configFor(aAnchor, pi1);
    const cfgA1 = configFor(aCheap, aAnchor);
    const cfgB0 = configFor(bAnchor, pi1);
    const cfgB1 = configFor(bCheap, bAnchor);

    const started = Date.now();
    let completed = 0;
    let resumed = 0;

    for (let offset = 0; offset < GROUPS; offset += 1) {
      const dealIndex = START + offset;
      const path = join(CHECKPOINTS, `${dealIndex}.json`);
      if (existsSync(path)) {
        resumed += 1;
        continue;
      }
      const record: ConfirmRecord = {
        dealIndex,
        aBaseline: landlordTeamWon(cfgA0, dealIndex),
        aCheap: landlordTeamWon(cfgA1, dealIndex),
        bBaseline: landlordTeamWon(cfgB0, dealIndex),
        bCheap: landlordTeamWon(cfgB1, dealIndex),
      };
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, JSON.stringify(record));
      renameSync(temporary, path);
      completed += 1;

      // Blind progress only.
      if (completed % 25 === 0) {
        const elapsed = (Date.now() - started) / 1000;
        const rate = completed / elapsed;
        console.log(
          `[lrc] progress ${completed}/${GROUPS - resumed} completed, ${resumed} resumed, ` +
            `${rate.toFixed(2)} groups/s, elapsed ${elapsed.toFixed(0)}s, ` +
            `eta ${(((GROUPS - resumed - completed) / Math.max(1e-9, rate))).toFixed(0)}s`,
        );
      }
    }
    console.log(`[lrc] shard ${START}+${GROUPS}: ${completed} completed, ${resumed} resumed`);
    expect(completed + resumed).toBe(GROUPS);
  }, 86_400_000);
});
