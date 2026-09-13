/**
 * Cross-check the exact solver against an obvious brute-force implementation.
 * A feasibility conclusion resting on a wrong solver would be worse than none.
 */
import { describe, expect, it } from "vitest";
import type { CardId } from "../../src/core/cards/index.js";
import { createPlayerView, type PlayingPlayerView } from "../../src/core/ai/index.js";
import { transition, type GameCommand, type GameState, type Seat } from "../../src/core/game/index.js";
import { currentPlaySeat } from "../../src/core/ai/state-evaluator.js";
import { generateLegalActions } from "../../src/core/rules/index.js";

export function handsOf(state: GameState): Readonly<Record<Seat, readonly CardId[]>> {
  return (state as Extract<GameState, { readonly hands: unknown }>).hands;
}
export function playingOf(state: GameState): Readonly<{ seat: Seat; view: PlayingPlayerView }> | null {
  if (state.phase !== "ready-to-play" && state.phase !== "playing") return null;
  const view = createPlayerView(state, state.currentSeat);
  if (view === null || view.phase === "bidding") return null;
  return { seat: state.currentSeat, view };
}
export function keyOf(state: GameState, view: PlayingPlayerView): string {
  const seatOfPlay = view.currentPlay === null ? null : currentPlaySeat(view);
  const play = view.currentPlay === null ? "lead" : `${String(seatOfPlay)}:${view.currentPlay.cards.join(",")}`;
  const trailing = view.history.at(-1)?.type === "pass" ? "pass" : "lead";
  const h = handsOf(state);
  return [h.human.join("|"), h["ai-one"].join("|"), h["ai-two"].join("|"), play, trailing, String(view.seat)].join("/");
}
export function movesOf(seat: Seat, view: PlayingPlayerView): readonly GameCommand[] {
  return generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }).map((a) =>
    a.type === "pass" ? Object.freeze({ type: "pass" as const, seat }) : Object.freeze({ type: "play" as const, seat, cards: a.play.cards }));
}

/** No memo, no early exit beyond what the game gives: the slow but obvious version. */
function brute(state: GameState, budget: { left: number }): boolean {
  if (state.phase === "finished") return state.winner === state.landlord;
  const playing = playingOf(state);
  if (playing === null) return false;
  budget.left -= 1;
  if (budget.left <= 0) throw new Error("brute budget exhausted");
  const moverIsLandlord = playing.seat === playing.view.landlord;
  let seenFalse = false;
  let seenTrue = false;
  for (const command of movesOf(playing.seat, playing.view)) {
    const next = transition(state, command);
    if (!next.ok) continue;
    const child = brute(next.state, budget);
    if (child) seenTrue = true; else seenFalse = true;
    if (moverIsLandlord && child) return true;
    if (!moverIsLandlord && !child) return false;
  }
  void seenTrue; void seenFalse;
  return !moverIsLandlord;
}

/** Memoised version, same logic. */
function memo(state: GameState, table: Map<string, boolean>, budget: { left: number }): boolean {
  if (state.phase === "finished") return state.winner === state.landlord;
  const playing = playingOf(state);
  if (playing === null) return false;
  budget.left -= 1;
  if (budget.left <= 0) throw new Error("memo budget exhausted");
  const k = keyOf(state, playing.view);
  const hit = table.get(k);
  if (hit !== undefined) return hit;
  const moverIsLandlord = playing.seat === playing.view.landlord;
  let result = !moverIsLandlord;
  for (const command of movesOf(playing.seat, playing.view)) {
    const next = transition(state, command);
    if (!next.ok) continue;
    const child = memo(next.state, table, budget);
    if (moverIsLandlord && child) { result = true; break; }
    if (!moverIsLandlord && !child) { result = false; break; }
  }
  table.set(k, result);
  return result;
}

describe("solver cross-check", () => {
  it("memoised and brute force agree", async () => {
    const { armSchedule, dealDeck, startWithLandlord } = await import("../ai-tournament.js");
    const { replayToDecision } = await import("./roll-forward.js");
    const { runProbe } = await import("./harvest.js");
    const run = await runProbe({ seedBase: 301, deals: 3, strongProfile: "master", quiet: true });
    let checked = 0, agree = 0;
    const seen = new Set<string>();
    for (const record of run.records) {
      const state = replayToDecision(record.snapshot, record.snapshot.prefix);
      const playing = playingOf(state);
      if (playing === null) continue;
      const pool = handsOf(state).human.length + handsOf(state)["ai-one"].length + handsOf(state)["ai-two"].length;
      if (pool > 9) continue;
      const k = keyOf(state, playing.view);
      if (seen.has(k)) continue;
      seen.add(k);
      checked += 1;
      let a: boolean, b: boolean;
      try { a = memo(state, new Map(), { left: 2_000_000 }); } catch { continue; }
      try { b = brute(state, { left: 2_000_000 }); } catch { continue; }
      if (a === b) agree += 1; else console.log(`MISMATCH pool=${pool} memo=${String(a)} brute=${String(b)}`);
    }
    console.log(`\ncross-check: ${String(agree)}/${String(checked)} distinct positions agree\n`);
    void armSchedule; void dealDeck; void startWithLandlord;
    expect(checked).toBeGreaterThan(0);
    expect(agree).toBe(checked);
  }, 900_000);
});
