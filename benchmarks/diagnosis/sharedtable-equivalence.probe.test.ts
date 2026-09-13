/**
 * Sharing one transposition table across enumerated worlds must not change any
 * answer. The claim is that a position's value depends on the hands and the
 * public position alone — which the key already carries — and not on which world
 * produced it. This checks the claim rather than assuming it.
 *
 * Research scaffolding. Not shipped, not imported by `src/`.
 */

import { describe, expect, it } from "vitest";

import { createPlayerView } from "../../src/core/ai/index.js";
import type { GameState } from "../../src/core/game/index.js";
import { solveRootActions } from "./exact-solver.js";
import { beliefOf, worldHands, stateForWorld, type BeliefState } from "./endgame-branch.js";
import { replayToDecision } from "./roll-forward.js";
import { runProbe } from "./harvest.js";

const DEALS = Number(process.env.AI_SHARED_DEALS ?? "2");
const MAX_WORLDS = 8;

/** Per-action win counts over the enumerated worlds, with or without a shared table. */
function winCounts(
  state: GameState,
  belief: BeliefState,
  table: Map<string, boolean> | undefined,
): Map<string, number> {
  const wins = new Map<string, number>();
  let worlds = 0;
  for (const hand of worldHands(belief)) {
    if (worlds >= MAX_WORLDS) {
      break;
    }
    worlds += 1;
    const world = stateForWorld(state, belief, hand);
    const solved = solveRootActions(world, {
      nodeCap: 2_000_000,
      ...(table === undefined ? {} : { table }),
    });
    for (const value of solved.values) {
      wins.set(value.key, (wins.get(value.key) ?? 0) + (value.sideWins ? 1 : 0));
    }
  }
  return wins;
}

describe("a table shared across worlds changes no answer", () => {
  it("gives the same per-action win counts with and without sharing", async () => {
    const harvest = await runProbe({ seedBase: 301, deals: DEALS, strongProfile: "master", quiet: true });
    const failures: string[] = [];
    let compared = 0;

    for (const record of harvest.records) {
      const state = replayToDecision(record.snapshot, record.snapshot.prefix);
      const view = createPlayerView(state, record.seat);
      if (view === null || view.phase === "bidding") {
        continue;
      }
      const belief = beliefOf(view);
      if (belief === null || belief.smallerCount !== 1 || belief.worlds > MAX_WORLDS) {
        continue;
      }
      const shared = winCounts(state, belief, new Map());
      const separate = winCounts(state, belief, undefined);
      compared += 1;
      for (const key of new Set([...shared.keys(), ...separate.keys()])) {
        if ((shared.get(key) ?? -1) !== (separate.get(key) ?? -1)) {
          failures.push(
            `deal ${String(record.dealIndex)} action=${key}: shared=${String(shared.get(key))} separate=${String(separate.get(key))}`,
          );
        }
      }
    }

    console.log(
      [
        "",
        `positions compared: ${String(compared)}`,
        `failures: ${String(failures.length)}`,
        ...failures.slice(0, 8),
        "",
      ].join("\n"),
    );
    expect(failures).toEqual([]);
    expect(compared).toBeGreaterThan(0);
  }, 1_800_000);
});
