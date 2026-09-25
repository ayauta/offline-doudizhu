/**
 * Spec 065 stage-run protocol rules — the parts of §14 that must be enforced
 * by construction rather than by the operator remembering them.
 *
 * Spec 064's Stage 1 was invalidated because intermediate results reached disk:
 * the runner streamed per-deal cumulative totals into a log, and they were read.
 * The first cut of *this* round's runner repeated the mistake in a quieter form
 * — it wrote `AI_CF_T5_S1_OUT` after each arm, so a complete baseline-only
 * result existed on disk while the challenger was still running. Nobody had to
 * do anything wrong for that to be readable; it simply existed.
 *
 * §14 says results are written **once, after both arms finish**. So:
 *
 *   - the formal stages have exactly one output mode, and it runs both arms and
 *     writes a single combined file at the very end, atomically;
 *   - the per-arm mode still exists, because a retired-seed smoke needs it, but
 *     it **refuses any range that touches a formal pool**;
 *   - the write is temp-then-rename, so the destination path never holds a
 *     half-written document.
 *
 * Every rule here is a pure function so `tests/` can falsify it cheaply.
 */
import { renameSync, writeFileSync } from "node:fs";

import { CfInvalidError } from "./cf-dataset.js";
import {
  CF_TOP5_STAGE1_END,
  CF_TOP5_STAGE1_START,
  CF_TOP5_STAGE2_END,
  CF_TOP5_STAGE2_START,
} from "./cf-top5-corpus.js";

/** The two pools a formal run draws from. Neither may be touched casually. */
export const CF_TOP5_FORMAL_RANGES: readonly Readonly<{
  name: string;
  start: number;
  end: number;
}>[] = Object.freeze([
  Object.freeze({ name: "stage1", start: CF_TOP5_STAGE1_START, end: CF_TOP5_STAGE1_END }),
  Object.freeze({ name: "stage2", start: CF_TOP5_STAGE2_START, end: CF_TOP5_STAGE2_END }),
]);

/**
 * Throws when `[dealStart, dealStart + deals)` overlaps a formal pool.
 *
 * A run is refused if it touches one *at all*, not merely if it starts inside
 * one: a window that begins at 160000 would deal 160001 on its second iteration,
 * and "the first deal was fine" is not a property anyone wants to rely on.
 */
export function assertNotFormalRange(dealStart: number, deals: number, purpose: string): void {
  const end = dealStart + Math.max(0, deals - 1);
  for (const range of CF_TOP5_FORMAL_RANGES) {
    if (dealStart <= range.end && end >= range.start) {
      throw new CfInvalidError(
        `${purpose} would touch the ${range.name} pool ` +
        `(${range.start}..${range.end}); the requested window is ` +
        `${dealStart}..${end}. A formal pool has exactly one output mode — the ` +
        "combined two-arm run — so that no partial result can exist on disk.",
      );
    }
  }
}

/**
 * Writes the combined stage result, atomically and exactly once.
 *
 * Temp-then-rename rather than a direct write: a reader that looks at the
 * destination during the write sees either the previous state (nothing) or the
 * complete document, never a truncated one. The temp file is removed by the
 * rename itself, so a crash cannot leave a readable fragment under a path
 * anyone is watching.
 */
export function writeCombinedAtomic(path: string, payload: unknown): void {
  const temporary = `${path}.partial`;
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/**
 * The shape of the one file a formal stage produces.
 *
 * Both arms live in a single document precisely so that "the baseline finished"
 * is not an observable state: there is no moment at which one arm's numbers are
 * on disk without the other's.
 */
export type CfTop5CombinedResult = Readonly<{
  label: string;
  config: Readonly<Record<string, unknown>>;
  preregisteredUniverse: Readonly<{ start: number; end: number }>;
  preregisteredStage2: Readonly<{ start: number; end: number }>;
  /** Both arms, always both, never one. */
  arms: Readonly<Record<"baseline" | "challenger", Readonly<{
    perDealA: readonly number[];
    perDealB: readonly number[];
    cost: Readonly<Record<string, number>>;
  }>>>;
  completedAt: string;
}>;

/**
 * Splits a completed combined result into the two dumps `paired-compare.test.ts`
 * reads.
 *
 * Deliberately a *post-completion* derivation: both arms are already in hand and
 * already on disk together, so producing two files from them cannot create a
 * partial state. The combined document remains the result; these are views of it.
 */
export function splitCombined(
  combined: CfTop5CombinedResult,
): Readonly<{ baseline: unknown; challenger: unknown }> {
  const view = (arm: "baseline" | "challenger") => Object.freeze({
    label: `${combined.label}-${arm}`,
    config: combined.config,
    runs: {
      "master-default": {
        perDealA: [...combined.arms[arm].perDealA],
        perDealB: [...combined.arms[arm].perDealB],
        stoppedEarly: false,
      },
    },
    cost: combined.arms[arm].cost,
  });
  return Object.freeze({ baseline: view("baseline"), challenger: view("challenger") });
}
