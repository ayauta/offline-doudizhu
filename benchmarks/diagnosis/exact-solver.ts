/**
 * Exact perfect-information endgame solver — the artefact under test.
 *
 * This is the solver whose correctness Spec 027 is establishing. It is written
 * to be *parameterisable* so the consistency layers can vary one thing at a
 * time: memoisation on/off, move ordering, and the node cap. A solver with no
 * such knobs cannot be checked against itself.
 *
 * It answers one question: from `state`, does the **landlord's side** win under
 * optimal play? Everything else — which side the mover is on, whether a farmer
 * partner is out — follows from that one boolean.
 *
 * The oracle in `exact-oracle.ts` is deliberately a separate implementation and
 * shares no code with this file. Two implementations written to be different are
 * how a shared bug is avoided; one implementation with two call sites is not.
 *
 * Research scaffolding. Not shipped, not imported by `src/`.
 */

import { createPlayerView, type PlayingPlayerView } from "../../src/core/ai/index.js";
import { currentPlaySeat } from "../../src/core/ai/state-evaluator.js";
import { transition, type GameCommand, type GameState, type Seat } from "../../src/core/game/index.js";
import { generateLegalActions } from "../../src/core/rules/index.js";

export type RootValue = Readonly<{
  /** The root action, as a stable key: sorted card ids, or "pass". */
  key: string;
  /** True when the acting seat's side wins after this action, given the world. */
  sideWins: boolean;
}>;

export type RootValuesResult = Readonly<{
  values: readonly RootValue[];
  completed: boolean;
  nodes: number;
  tableSize: number;
}>;

export type SolveOptions = Readonly<{
  /** Memoise visited positions. Off is appreciably slower but must not differ. */
  cache?: boolean;
  /** Visit order of the mover's options. Must not affect the result. */
  order?: "as-generated" | "reversed";
  /** Stop past this many nodes; the result then reports `completed: false`. */
  nodeCap?: number;
}>;

export type SolveResult = Readonly<{
  /** True when the landlord's side wins with optimal play from here. */
  landlordWins: boolean;
  /** False when the node cap stopped the search; `landlordWins` is then unusable. */
  completed: boolean;
  nodes: number;
  tableSize: number;
}>;

const DEFAULT_CAP = 2_000_000;

/** All three hands plus the public position, so a key cannot alias two states. */
export function positionKey(state: GameState, view: PlayingPlayerView): string {
  const hands = (state as Extract<GameState, { readonly hands: unknown }>).hands;
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

/** The acting seat and its view, or null when the phase has no play to make. */
export function playingOf(
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

/** Legal commands for the acting seat, in the engine's own order. */
export function commandsFrom(seat: Seat, view: PlayingPlayerView): readonly GameCommand[] {
  return generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }).map((action) =>
    action.type === "pass"
      ? Object.freeze({ type: "pass" as const, seat })
      : Object.freeze({ type: "play" as const, seat, cards: action.play.cards }),
  );
}

export function solve(state: GameState, options: SolveOptions = {}): SolveResult {
  const useCache = options.cache ?? true;
  const cap = options.nodeCap ?? DEFAULT_CAP;
  const table = new Map<string, boolean>();
  let nodes = 0;
  let hitCap = false;

  const search = (current: GameState): boolean => {
    if (current.phase === "finished") {
      return current.winner === current.landlord;
    }
    const playing = playingOf(current);
    if (playing === null) {
      return false;
    }
    nodes += 1;
    if (nodes > cap) {
      hitCap = true;
      return false;
    }
    const key = useCache ? positionKey(current, playing.view) : "";
    if (useCache) {
      const cached = table.get(key);
      if (cached !== undefined) {
        return cached;
      }
    }
    // Read the mover before recursing: inside the loop `current` is still the
    // parent, and reading `currentSeat` there would test the wrong side.
    const moverIsLandlord = playing.seat === playing.view.landlord;
    const generated = commandsFrom(playing.seat, playing.view);
    const ordered = options.order === "reversed" ? [...generated].reverse() : generated;

    let result = !moverIsLandlord;
    for (const command of ordered) {
      const next = transition(current, command);
      if (!next.ok) {
        continue;
      }
      const child = search(next.state);
      if (moverIsLandlord && child) {
        result = true;
        break;
      }
      if (!moverIsLandlord && !child) {
        result = false;
        break;
      }
    }
    if (useCache) {
      table.set(key, result);
    }
    return result;
  };

  // The root call's own return value is the answer; nothing is re-derived.
  const landlordWins = search(state);
  return Object.freeze({
    landlordWins,
    completed: !hitCap,
    nodes,
    tableSize: table.size,
  });
}

/**
 * Win/loss for **every** root action from one search.
 *
 * The root's options share almost all of their subtree: after two different
 * openings the reachable positions overlap heavily. Solving each action
 * separately — as an earlier prototype did — rebuilds that shared subtree once
 * per action. One table over the whole root makes each distinct position cost
 * one visit, however many actions lead to it.
 *
 * The table is keyed on positions, not on values from different games, so it
 * stays valid across the root's options: all of them are moves by the same
 * player in the same world.
 */
export function solveRootActions(
  state: GameState,
  options: SolveOptions & { readonly table?: Map<string, boolean> } = {},
): RootValuesResult {
  const useCache = options.cache ?? true;
  const cap = options.nodeCap ?? DEFAULT_CAP;
  // A caller enumerating neighbouring worlds can pass one table in, because a
  // position's value does not depend on which world produced it — only on the
  // hands and the public position, which the key already carries.
  const table = options.table ?? new Map<string, boolean>();
  let nodes = 0;
  let hitCap = false;

  /** True when the landlord's side wins from `current`. */
  const search = (current: GameState): boolean => {
    if (current.phase === "finished") {
      return current.winner === current.landlord;
    }
    const playing = playingOf(current);
    if (playing === null) {
      return false;
    }
    nodes += 1;
    if (nodes > cap) {
      hitCap = true;
      return false;
    }
    const key = useCache ? positionKey(current, playing.view) : "";
    if (useCache) {
      const cached = table.get(key);
      if (cached !== undefined) {
        return cached;
      }
    }
    const moverIsLandlord = playing.seat === playing.view.landlord;
    const generated = commandsFrom(playing.seat, playing.view);
    const ordered = options.order === "reversed" ? [...generated].reverse() : generated;
    let result = !moverIsLandlord;
    for (const command of ordered) {
      const next = transition(current, command);
      if (!next.ok) {
        continue;
      }
      const child = search(next.state);
      if (moverIsLandlord && child) {
        result = true;
        break;
      }
      if (!moverIsLandlord && !child) {
        result = false;
        break;
      }
    }
    if (useCache) {
      table.set(key, result);
    }
    return result;
  };

  const rootPlaying = playingOf(state);
  const values: RootValue[] = [];
  if (rootPlaying === null) {
    return Object.freeze({ values: Object.freeze([]), completed: !hitCap, nodes, tableSize: table.size });
  }
  const rootIsLandlord = rootPlaying.seat === rootPlaying.view.landlord;
  for (const command of commandsFrom(rootPlaying.seat, rootPlaying.view)) {
    const key = command.type === "play"
      ? [...command.cards].sort((left, right) => left - right).join(",")
      : command.type;
    const next = transition(state, command);
    if (!next.ok) {
      continue;
    }
    const landlordWins = search(next.state);
    values.push(
      Object.freeze({ key, sideWins: rootIsLandlord ? landlordWins : !landlordWins }),
    );
  }

  return Object.freeze({
    values: Object.freeze(values),
    completed: !hitCap,
    nodes,
    tableSize: table.size,
  });
}
