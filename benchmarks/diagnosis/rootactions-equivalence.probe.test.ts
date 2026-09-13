/**
 * The shared-root search must return exactly what solving each action on its own
 * returned. Folding the root into one table is a cost change, not a semantic one,
 * and this is the check that keeps it that way.
 *
 * Research scaffolding. Not shipped, not imported by `src/`.
 */

import { describe, expect, it } from "vitest";

import { createDeck, type CardId } from "../../src/core/cards/index.js";
import { transition, type GameState, type Seat } from "../../src/core/game/index.js";
import { commandsFrom, playingOf, solve, solveRootActions } from "./exact-solver.js";

const SEATS: readonly Seat[] = Object.freeze(["human", "ai-one", "ai-two"]);

function makeState(hands: Record<Seat, readonly CardId[]>, turn: Seat, landlord: Seat): GameState {
  return Object.freeze({
    phase: "ready-to-play" as const,
    hands: Object.freeze({
      human: Object.freeze([...hands.human]),
      "ai-one": Object.freeze([...hands["ai-one"]]),
      "ai-two": Object.freeze([...hands["ai-two"]]),
    }),
    bottomCards: Object.freeze([]),
    landlord,
    currentSeat: turn,
  }) as GameState;
}

function seededShuffle(cards: readonly CardId[], seed: number): CardId[] {
  const result = [...cards];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    const swap = result[index];
    const other = result[target];
    if (swap !== undefined && other !== undefined) {
      result[index] = other;
      result[target] = swap;
    }
  }
  return result;
}

describe("solveRootActions equals solving each action separately", () => {
  it("agrees on every root action of every sampled position", () => {
    const failures: string[] = [];
    let checked = 0;
    let actions = 0;

    for (let index = 0; index < 300; index += 1) {
      const pool = seededShuffle(createDeck(), 31_000 + index);
      const hands = {
        human: pool.slice(0, 1 + (index % 3)),
        "ai-one": pool.slice(3, 4 + (index % 4)),
        "ai-two": pool.slice(7, 8 + (index % 2)),
      };
      if (SEATS.some((seat) => hands[seat].length === 0)) {
        continue;
      }
      const state = makeState(hands, SEATS[index % 3] ?? "human", SEATS[(index >> 1) % 3] ?? "human");
      const playing = playingOf(state);
      if (playing === null) {
        continue;
      }

      const shared = solveRootActions(state, { nodeCap: 2_000_000 });
      if (!shared.completed) {
        continue;
      }
      checked += 1;

      for (const command of commandsFrom(playing.seat, playing.view)) {
        if (command.type !== "play" && command.type !== "pass") {
          continue;
        }
        const key = command.type === "play"
          ? [...command.cards].sort((left, right) => left - right).join(",")
          : "pass";
        const fromShared = shared.values.find((value) => value.key === key);
        if (fromShared === undefined) {
          failures.push(`index=${String(index)}: shared search omitted root action ${key}`);
          continue;
        }
        const after = transition(state, command);
        if (!after.ok) {
          continue;
        }
        const alone = solve(after.state, { nodeCap: 2_000_000 });
        if (!alone.completed) {
          continue;
        }
        const expected = playing.seat === playing.view.landlord
          ? alone.landlordWins
          : !alone.landlordWins;
        actions += 1;
        if (fromShared.sideWins !== expected) {
          failures.push(
            `index=${String(index)} action=${key}: shared=${String(fromShared.sideWins)} separate=${String(expected)}`,
          );
        }
      }
    }

    console.log(
      [
        "",
        `positions compared: ${String(checked)}`,
        `root actions compared: ${String(actions)}`,
        `failures: ${String(failures.length)}`,
        ...failures.slice(0, 8),
        "",
      ].join("\n"),
    );
    expect(failures).toEqual([]);
    expect(actions).toBeGreaterThan(200);
  }, 1_800_000);
});
