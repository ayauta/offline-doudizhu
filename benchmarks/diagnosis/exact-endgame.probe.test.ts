/**
 * Feasibility probe: how many nodes does an exact endgame solve cost?
 *
 * The reported quantity is **nodes**, not milliseconds, on purpose. This machine
 * is not the target — the target is a Xiaomi 10S — and the repository's own rule
 * is that no dev-machine wall-clock number may stand in for device evidence. A
 * node count transfers; a millisecond does not.
 *
 * Positions come from the harvest's snapshots, so they are real game states at
 * real decision points. Only positions whose remaining pool is small are worth
 * solving exactly, and the pool size is what the table bins on.
 *
 * The solver is a plain perfect-information game solver with a transposition
 * table and a hard node cap. It is given no hidden information: at these pool
 * sizes the pool is what the card count leaves over.
 */

import { describe, expect, it } from "vitest";

import type { CardId } from "../../src/core/cards/index.js";
import { createPlayerView, type PlayingPlayerView } from "../../src/core/ai/index.js";
import { transition, type GameCommand, type GameState, type Seat } from "../../src/core/game/index.js";
import { currentPlaySeat } from "../../src/core/ai/state-evaluator.js";
import { generateLegalActions } from "../../src/core/rules/index.js";
import { runProbe } from "./harvest.js";
import { replayToDecision } from "./roll-forward.js";

const DEALS = Number(process.env.AI_EXACT_DEALS ?? "20");
const MAX_POOL = Number(process.env.AI_EXACT_MAX_POOL ?? "12");
const MAX_NODES = Number(process.env.AI_EXACT_MAX_NODES ?? "200000");

type SolveResult = Readonly<{ nodes: number; completed: boolean; tableSize: number }>;

function poolOf(state: GameState): number {
  if (state.phase === "awaiting-deal" || state.phase === "bidding" || state.phase === "finished") {
    return Number.POSITIVE_INFINITY;
  }
  return state.hands.human.length + state.hands["ai-one"].length + state.hands["ai-two"].length;
}

/** The acting seat and its public view, or null when there is no play to make. */
function playingView(
  state: GameState,
): Readonly<{ seat: Seat; view: PlayingPlayerView }> | null {
  if (state.phase !== "ready-to-play" && state.phase !== "playing") {
    return null;
  }
  const view = createPlayerView(state, state.currentSeat);
  if (view === null || view.phase === "bidding") {
    return null;
  }
  return { seat: state.currentSeat, view };
}

/**
 * All three hands plus the public position. A key built from the acting seat's
 * view alone would collapse positions that differ in the other seats' cards and
 * silently return the wrong value.
 */
function handsOf(state: GameState): Readonly<Record<Seat, readonly CardId[]>> {
  return (state as Extract<GameState, { readonly hands: unknown }>).hands;
}

function tableKey(
  hands: Readonly<Record<Seat, readonly CardId[]>>,
  view: PlayingPlayerView,
): string {
  // `currentPlaySeat` needs a playing view, and a null `currentPlay` means nobody
  // is on the table, which is the same information as `seatOfPlay === null`.
  const seatOfPlay = view.currentPlay === null ? null : currentPlaySeat(view);
  const play = view.currentPlay === null
    ? "lead"
    : `${String(seatOfPlay)}:${view.currentPlay.cards.join(",")}`;
  const trailing = view.history.at(-1)?.type === "pass" ? "pass" : "lead";
  return [
    hands.human.join("|"),
    hands["ai-one"].join("|"),
    hands["ai-two"].join("|"),
    play,
    trailing,
    String(view.seat),
  ].join("/");
}

function commandsFrom(
  seat: Seat,
  view: PlayingPlayerView,
): readonly GameCommand[] {
  const actions = generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
  return actions.map((action) =>
    action.type === "pass"
      ? Object.freeze({ type: "pass" as const, seat })
      : Object.freeze({ type: "play" as const, seat, cards: action.play.cards }),
  );
}

/**
 * True when the landlord's side wins with optimal play from `state`.
 * Recursion stops at depth 0 or the node cap, reporting "not won yet" for the
 * side to move — a censored result, never a wrong one at the cap boundary.
 */
function solve(root: GameState, cap: number): SolveResult {
  const table = new Map<string, boolean>();
  let nodes = 0;
  let hitCap = false;

  const landlordWins = (state: GameState): boolean => {
    if (state.phase === "finished") {
      return state.winner === state.landlord;
    }
    const playing = playingView(state);
    if (playing === null) {
      return false;
    }
    nodes += 1;
    if (nodes > cap) {
      hitCap = true;
      return false;
    }
    const key = tableKey(handsOf(state), playing.view);
    const cached = table.get(key);
    if (cached !== undefined) {
      return cached;
    }
    // Capture the mover before recursing: inside the loop `state` is still the
    // parent, and reading `currentSeat` there would test the wrong side.
    const moverIsLandlord = playing.seat === playing.view.landlord;
    let result = !moverIsLandlord;
    for (const command of commandsFrom(playing.seat, playing.view)) {
      const next = transition(state, command);
      if (!next.ok) {
        continue;
      }
      const child = landlordWins(next.state);
      if (moverIsLandlord && child) {
        result = true;
        break;
      }
      if (!moverIsLandlord && !child) {
        result = false;
        break;
      }
    }
    table.set(key, result);
    return result;
  };

  landlordWins(root);
  return { nodes, completed: !hitCap, tableSize: table.size };
}

describe("exact endgame cost", () => {
  it(`counts nodes for ${String(DEALS)} deals`, async () => {
    const run = await runProbe({ seedBase: 301, deals: DEALS, strongProfile: "master", quiet: true });
    const buckets = new Map<number, { solved: number; capped: number; nodes: number[]; ms: number[] }>();
    let considered = 0;

    const distinct = new Map<string, number>();

    for (const record of run.records) {
      const state = replayToDecision(record.snapshot, record.snapshot.prefix);
      const pool = poolOf(state);
      if (!Number.isFinite(pool) || pool > MAX_POOL) {
        continue;
      }
      const playing = playingView(state);
      if (playing === null) {
        continue;
      }
      // The harvest records a state once per acting seat; solving it again would
      // weight long games more heavily for no reason.
      const fingerprint = tableKey(handsOf(state), playing.view);
      if (distinct.has(fingerprint)) {
        continue;
      }
      distinct.set(fingerprint, pool);
      considered += 1;
      const started = performance.now();
      const result = solve(state, MAX_NODES);
      const elapsed = performance.now() - started;
      const bucket = buckets.get(pool) ?? { solved: 0, capped: 0, nodes: [], ms: [] };
      if (result.completed) {
        bucket.solved += 1;
        bucket.nodes.push(result.nodes);
        bucket.ms.push(elapsed);
      } else {
        bucket.capped += 1;
      }
      buckets.set(pool, bucket);
    }

    const median = (values: readonly number[]): number => {
      if (values.length === 0) {
        return 0;
      }
      const sorted = [...values].sort((left, right) => left - right);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };

    console.log(
      [
        "",
        `positions with a pool at or below ${String(MAX_POOL)}: ${String(considered)}`,
        `node cap: ${String(MAX_NODES)}`,
        "",
        "pool | solved/capped | median nodes | max nodes | median ms",
        ...[...buckets.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([pool, bucket]) =>
            `  ${String(pool).padStart(2)} | ${String(bucket.solved).padStart(6)}/${String(bucket.capped).padStart(6)} | ${String(median(bucket.nodes)).padStart(12)} | ${String(Math.max(0, ...bucket.nodes)).padStart(9)} | ${median(bucket.ms).toFixed(1).padStart(9)}`),
        "",
      ].join("\n"),
    );
    expect(considered).toBeGreaterThan(0);
  }, 1_800_000);
});

