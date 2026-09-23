/**
 * Farmer Policy Iteration Factory v1 — the πn-distribution corpus.
 *
 * The generator is `cf-dataset.ts`'s, unchanged. That is the whole point: the
 * Factory asks the same question of every generation — "at the roots the
 * current champion actually reached, would the champion's own action have been
 * beaten by something else in the same top three?" — so the machinery that
 * answers it must not be re-written per generation, or the generations stop
 * being comparable.
 *
 * What this module supplies is the four things that *do* differ:
 *
 *   1. **The policy.** A chain instead of a single model. The capture visits,
 *      forks and continues under the full champion (§9), which is what makes
 *      the labels `A^(πn; τ, λ)` rather than `A^(π1; τ, λ)`.
 *   2. **The reference.** `cfCaptureGroup` already takes the reference from the
 *      action the policy actually played, so `b_n` is recorded as it happened
 *      rather than recomputed afterwards (§6). No schema change is needed: the
 *      `a0_*` column block has always been "the reference action's features",
 *      and under a chain the reference is the champion's action.
 *   3. **The pools.** Ranges come from the ledger, never from a literal here.
 *   4. **Provenance.** A dataset version and two salts of its own, so a Factory
 *      corpus can never be mistaken for a Spec 062/064/065 one by a reader that
 *      only looks at the rows.
 *
 * The landlord and the teammate are frozen for the whole Factory: the studied
 * seat is the only seat the chain is bound to, and every other seat receives
 * the production command object for object. That is §9's "one farmer agent is
 * under study" expressed as a property of the policy rather than as a promise.
 */
import type { CardId } from "../src/core/cards/index.js";
import {
  CF_SPLIT_COUNTS,
  CfInvalidError,
  cfCaptureGroup,
  type CfGroupResult,
  type CfGroupSpec,
  type CfSplit,
} from "./cf-dataset.js";
import { armSchedule, dealGameSeed, scheduleFor } from "./ai-tournament.js";
import { cfChainPolicy, type ChampionChain } from "./farmer-pi-chain.js";
import type { Range } from "./farmer-pi-pools.js";

/**
 * Dataset 5: v1's is 2, the π1→π2 round's is 3, the top5 round's is 4. A reader
 * that only checks the version cannot silently train on the wrong round.
 */
export const FACTORY_DATASET_VERSION = 5;

/** This Factory's salts. Distinct from every earlier round's, deliberately. */
export const FACTORY_SNAPSHOT_SALT = "farmer-pi-v1-snapshot";
export const FACTORY_SPLIT_SALT = "farmer-pi-v1-split";

/** At most three sampled roots per initial deal, as every earlier round. */
export const FACTORY_GROUP_SNAPSHOT_CAP = 3;

/**
 * The tournament's `seedBase`. Zero makes the corpus's `dealSeed` and the
 * tournament's `seedBase + dealIndex` the same number, which is the only reason
 * "the corpus describes games the strength run plays" is checkable at all.
 */
export const FACTORY_SEED_BASE = 0;

export function assertFactorySeedBase(seedBase: number): void {
  if (seedBase !== FACTORY_SEED_BASE) {
    throw new CfInvalidError(
      `Factory v1 preregisters seedBase ${FACTORY_SEED_BASE}; received ${seedBase}. ` +
      "A different base puts the corpus and the strength run on different decks.",
    );
  }
}

/**
 * The one place a purpose becomes a split.
 *
 * The Factory's third bucket is the offline screen, and it borrows v1's
 * `"heldout"` label because that label means "this row is never trained on" to
 * every reader downstream — the exporter, the split-count check and the frozen
 * v1 row reader all key off it. A fourth name would have needed changes in
 * three frozen files to say the same thing.
 */
export const FACTORY_SPLIT_OF_PURPOSE: Readonly<Record<string, CfSplit>> = Object.freeze({
  train: "train",
  "train-fresh": "train",
  calibration: "calibration",
  offline: "heldout",
});

export function factorySplitOfPurpose(purpose: string): CfSplit {
  const split = FACTORY_SPLIT_OF_PURPOSE[purpose];
  if (split === undefined) {
    throw new CfInvalidError(`Pool purpose "${purpose}" is not a dataset split.`);
  }
  return split;
}

/** A pool a corpus may be generated from, resolved from the ledger by the runner. */
export type FactoryPoolRef = Readonly<{
  poolId: string;
  purpose: string;
  range: Range;
}>;

/**
 * The arm-B group spec for one deal of a Factory dataset pool.
 *
 * Arm A is excluded for the reason every earlier round excluded it: the strong
 * seat holds the landlord, where no override exists, so those games can never
 * yield a row. The landlord and teammate tiers are the production schedule's —
 * `master` for the studied seat, `default` for the two others — and the chain
 * is layered on top by the capture, never by the tiers.
 */
export function factoryGroupSpecFor(
  dealIndex: number,
  pool: FactoryPoolRef,
  policyCommit: string,
): CfGroupSpec {
  if (dealIndex < pool.range.start || dealIndex > pool.range.end) {
    throw new CfInvalidError(
      `Deal ${dealIndex} is outside pool ${pool.poolId} (${pool.range.start}..${pool.range.end}).`,
    );
  }
  const dealSeed = dealIndex;
  const variants = armSchedule(dealIndex)
    .filter((slot) => slot.arm === "B" && slot.strongSeat !== slot.landlord)
    .map((slot) => Object.freeze({
      variantId: `${dealIndex}:${slot.landlord}:${slot.strongSeat}`,
      landlord: slot.landlord,
      studiedSeat: slot.strongSeat,
      // The same function the tournament calls, so the corpus and the strength
      // run cannot disagree about which game a deal index names.
      gameSeed: dealGameSeed(dealSeed, slot.strongSeat, slot.landlord),
      tiers: scheduleFor("master", "default", slot.strongSeat),
    }));
  return Object.freeze({
    groupId: `deal-${dealIndex}`,
    dealIndex,
    dealSeed,
    variants: Object.freeze(variants),
    snapshotCap: FACTORY_GROUP_SNAPSHOT_CAP,
    policyCommit,
  });
}

/**
 * One group captured under the champion chain.
 *
 * `recordRawProduction` is on so the base master's own action is kept beside
 * the champion's: the diagnostics that ask "how often did the chain disagree
 * with production, and how often did layer k disagree with layer k-1?" need
 * both, and a snapshot that stored only the reference could not answer either.
 */
export function factoryCaptureGroup(
  deck: readonly CardId[],
  spec: CfGroupSpec,
  chain: ChampionChain,
): CfGroupResult {
  return cfCaptureGroup(deck, spec, {
    policyFor: (variant) => cfChainPolicy(chain, variant.studiedSeat),
    snapshotSalt: FACTORY_SNAPSHOT_SALT,
    datasetVersion: FACTORY_DATASET_VERSION,
    recordRawProduction: true,
  });
}

/**
 * The Factory's split counts, re-exported rather than retyped. The ledger fixes
 * the pool *sizes*; this fixes the names those sizes are reported under.
 */
export const FACTORY_SPLIT_COUNTS = CF_SPLIT_COUNTS;

/**
 * How many groups each dataset pool holds, from the layout. Exposed so the
 * runner can assert the ledger and the protocol agree before generating
 * anything — a mismatch there is a configuration error, not a slow discovery
 * forty minutes into a stage.
 */
export const FACTORY_DATASET_SIZES: Readonly<Record<string, number>> = Object.freeze({
  train: 6_000,
  calibration: 2_000,
  offline: 2_000,
});
