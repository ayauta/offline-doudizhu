/**
 * Canonical identity and complete enumeration for the full-action self-play
 * research line (`research/full-action-selfplay-v1`).
 *
 * Two things live here and nothing else does:
 *
 * 1. A **suit-free action identity**. Two card selections that differ only in
 *    which copy of a rank they use are the same strategic action, and the
 *    engine agrees: `classifyPlay` is a pure function of the rank-count vector.
 *    Every set comparison in this research line is made on this identity, never
 *    on raw card ids.
 *
 * 2. An **independent brute-force oracle**. The engine's `generateLegalActions`
 *    is a constructive enumerator: it walks pattern shapes and adds candidates.
 *    The oracle instead walks every subset of the hand and asks the validator.
 *    It shares no enumeration logic with the generator, so a disagreement is
 *    real evidence rather than a restatement of the same assumption.
 *
 * This module does not change engine behaviour. It observes it.
 */
import { getCard, type CardId } from "../src/core/cards/index.js";
import {
  RANK_ORDER,
  generateLegalActions,
  rankStrength,
  validatePlay,
  type PlayContext,
  type ValidatedPlayAction,
} from "../src/core/rules/index.js";

/**
 * Bump when `actionIdentity` or the canonical order changes. The value is
 * recorded in every dataset manifest so a stale corpus cannot be re-read as if
 * it were current.
 */
export const ACTION_IDENTITY_VERSION = "fas-action-identity-v1";

/** 13 standard ranks plus the two jokers, in `RANK_ORDER`. */
export const RANK_SLOT_COUNT = RANK_ORDER.length;

const STANDARD_RANK_COUNT = RANK_SLOT_COUNT - 2;
const SMALL_JOKER_ID = 52;

/**
 * Maps a card id onto its `RANK_ORDER` slot.
 *
 * Card ids are laid out four-per-standard-rank in `STANDARD_RANKS` order, with
 * the jokers at 52 and 53; `tests/core/selfplay-actions.test.ts` pins this
 * closed form against `getCard().rank` + `RANK_ORDER` so it can never drift
 * silently.
 */
export function rankSlotOf(cardId: CardId): number {
  return cardId < SMALL_JOKER_ID
    ? Math.floor(cardId / 4)
    : cardId === SMALL_JOKER_ID
      ? STANDARD_RANK_COUNT
      : STANDARD_RANK_COUNT + 1;
}

function emptyCounts(): number[] {
  return new Array<number>(RANK_SLOT_COUNT).fill(0);
}

/** The rank-count vector of a set of cards, in `RANK_ORDER`. */
export function rankCountsOf(cards: readonly CardId[]): readonly number[] {
  const counts = emptyCounts();
  for (const cardId of cards) {
    const slot = rankSlotOf(cardId);
    counts[slot] = (counts[slot] ?? 0) + 1;
  }
  return counts;
}

/**
 * The canonical, suit-free identity of an action. `pass` is its own identity;
 * every play is the `RANK_ORDER`-indexed count vector, which determines the
 * pattern completely.
 */
export function actionIdentity(action: ValidatedPlayAction): string {
  if (action.type === "pass") {
    return "pass";
  }
  return rankCountsOf(action.play.cards).join(",");
}

export function actionIdentities(
  actions: readonly ValidatedPlayAction[],
): readonly string[] {
  return actions.map(actionIdentity);
}

export interface ActionSetDifference {
  readonly onlyInLeft: readonly string[];
  readonly onlyInRight: readonly string[];
}

/**
 * Set difference on action identity, reported in canonical order so a failure
 * message is stable across runs.
 */
export function compareActionSets(
  left: readonly ValidatedPlayAction[],
  right: readonly ValidatedPlayAction[],
): ActionSetDifference {
  const leftKeys = new Set(actionIdentities(left));
  const rightKeys = new Set(actionIdentities(right));
  return {
    onlyInLeft: [...leftKeys].filter((key) => !rightKeys.has(key)).sort(),
    onlyInRight: [...rightKeys].filter((key) => !leftKeys.has(key)).sort(),
  };
}

export interface ActionSetProblem {
  readonly kind:
    | "duplicate-identity"
    | "not-a-subset-of-hand"
    | "illegal-action"
    | "identity-mismatch";
  readonly identity: string;
  readonly detail: string;
}

/**
 * Guard A1: every enumerated action is legal from `context`, uses only cards
 * that are actually in hand, and carries the identity its own cards imply.
 *
 * This deliberately re-validates through `validatePlay` rather than trusting the
 * generator, so a generator bug that emits an illegal action is caught here.
 */
export function auditEnumeratedActions(
  context: PlayContext,
  actions: readonly ValidatedPlayAction[],
): readonly ActionSetProblem[] {
  const problems: ActionSetProblem[] = [];
  const seen = new Set<string>();
  const hand = new Set<CardId>(context.hand);

  for (const action of actions) {
    const identity = actionIdentity(action);
    if (seen.has(identity)) {
      problems.push({
        kind: "duplicate-identity",
        identity,
        detail: "The same canonical action appears more than once.",
      });
      continue;
    }
    seen.add(identity);

    if (action.type === "pass") {
      const revalidated = validatePlay(context, { type: "pass" });
      if (!revalidated.ok) {
        problems.push({
          kind: "illegal-action",
          identity,
          detail: `pass was rejected: ${revalidated.error.code}.`,
        });
      }
      continue;
    }

    const cards = action.play.cards;
    if (cards.some((cardId) => !hand.has(cardId))) {
      problems.push({
        kind: "not-a-subset-of-hand",
        identity,
        detail: "The action plays a card that is not in hand.",
      });
      continue;
    }

    const revalidated = validatePlay(context, { type: "play", cards });
    if (!revalidated.ok || revalidated.action.type !== "play") {
      problems.push({
        kind: "illegal-action",
        identity,
        detail: revalidated.ok
          ? "validatePlay did not return a play action."
          : `validatePlay rejected the action: ${revalidated.error.code}.`,
      });
      continue;
    }

    if (revalidated.action.play.pattern.kind !== action.play.pattern.kind) {
      problems.push({
        kind: "identity-mismatch",
        identity,
        detail: `The action claims ${action.play.pattern.kind} but reclassifies as ${revalidated.action.play.pattern.kind}.`,
      });
    }
  }

  return problems;
}

/**
 * Guard A2: complete enumeration by exhaustive subset search.
 *
 * Every non-empty subset of the hand is handed to the validator, so this cannot
 * miss a pattern kind the generator forgot, cannot emit an illegal action, and
 * cannot emit the same strategic action twice. It is intentionally slow and is
 * bounded by `maxHandCards`.
 */
export function bruteForceLegalActions(
  context: PlayContext,
  maxHandCards = 20,
): readonly ValidatedPlayAction[] {
  const hand = context.hand;
  if (hand.length > maxHandCards) {
    throw new Error(
      `The brute-force oracle is bounded to ${maxHandCards} cards; received ${hand.length}.`,
    );
  }

  const canonical = new Map<string, ValidatedPlayAction>();
  const selected: CardId[] = [];

  function visit(index: number): void {
    if (index === hand.length) {
      if (selected.length > 0) {
        const result = validatePlay(context, { type: "play", cards: [...selected] });
        if (result.ok && result.action.type === "play") {
          const identity = actionIdentity(result.action);
          if (!canonical.has(identity)) {
            canonical.set(identity, result.action);
          }
        }
      }
      return;
    }

    visit(index + 1);
    const cardId = hand[index];
    if (cardId !== undefined) {
      selected.push(cardId);
      visit(index + 1);
      selected.pop();
    }
  }

  visit(0);

  const passResult = validatePlay(context, { type: "pass" });
  if (passResult.ok && passResult.action.type === "pass") {
    canonical.set("pass", passResult.action);
  }

  return [...canonical.values()];
}

/**
 * Guard A5/A6: the canonical order is a deterministic total order on distinct
 * actions, and re-enumerating the same context yields the identical sequence.
 *
 * The order itself is the engine's `generateLegalActions` order, which sorts by
 * structural pattern kind, then card count, then main-rank strength, then card
 * id. It is a rules-level order; it is **not** the old expert ranking and it
 * carries no hand-crafted card-value heuristic.
 */
export interface ActionOrderAudit {
  readonly stableAcrossCalls: boolean;
  readonly identitiesUnique: boolean;
  readonly passPosition: "absent" | "first" | "last" | "middle";
  readonly identitySequence: readonly string[];
}

export function auditActionOrder(context: PlayContext): ActionOrderAudit {
  const first = actionIdentities(generateLegalActions(context));
  const second = actionIdentities(generateLegalActions(context));
  const passIndex = first.indexOf("pass");

  return {
    stableAcrossCalls: first.join("|") === second.join("|"),
    identitiesUnique: new Set(first).size === first.length,
    passPosition:
      passIndex < 0
        ? "absent"
        : passIndex === 0
          ? "first"
          : passIndex === first.length - 1
            ? "last"
            : "middle",
    identitySequence: first,
  };
}

/**
 * Guard A7: `pass` is present exactly when the rules allow it, which is exactly
 * when the seat is facing a play rather than leading.
 */
export function auditPassLegality(context: PlayContext): boolean {
  const actions = generateLegalActions(context);
  const offersPass = actions.some((action) => action.type === "pass");
  const passIsLegal = validatePlay(context, { type: "pass" }).ok;
  return offersPass === passIsLegal && offersPass === (context.currentPlay !== null);
}

/**
 * Guard A4: no hidden truncation. The enumerator must return an action for every
 * legal identity the oracle finds, and `top` must not change that; a caller that
 * silently keeps only the first `top` actions is exactly the failure this
 * research line exists to remove.
 */
export function auditNoTruncation(
  context: PlayContext,
  oracle: readonly ValidatedPlayAction[],
): boolean {
  const generated = generateLegalActions(context);
  return actionIdentities(generated).length === actionIdentities(oracle).length;
}

/** Sorted main-rank strength of a play, for diagnostics only. */
export function actionMainRankStrength(action: ValidatedPlayAction): number | null {
  return action.type === "pass" ? null : rankStrength(action.play.pattern.kind === "rocket"
    ? "big-joker"
    : action.play.pattern.mainRank);
}

/** The rank vector a caller can hand to a model without leaking suit identity. */
export function actionRankVector(action: ValidatedPlayAction): readonly number[] {
  return action.type === "pass" ? emptyCounts() : rankCountsOf(action.play.cards);
}

/** Human-readable slot names, used by dataset manifests and failure messages. */
export const RANK_SLOT_NAMES: readonly string[] = Object.freeze([...RANK_ORDER]);

/** Convenience for tests: the rank names held at each count in a vector. */
export function describeRankVector(vector: readonly number[]): string {
  return vector
    .map((count, slot) => (count === 0 ? null : `${RANK_SLOT_NAMES[slot]}x${count}`))
    .filter((entry): entry is string => entry !== null)
    .join(" ");
}

/** True when `cardId` is the given rank's first copy, used to build fixtures. */
export function firstCardIdOfRank(rank: (typeof RANK_ORDER)[number]): CardId {
  const slot = RANK_ORDER.indexOf(rank);
  if (slot < 0) {
    throw new Error(`Unknown rank: ${rank}.`);
  }
  return Math.min(slot * 4, SMALL_JOKER_ID + (slot - STANDARD_RANK_COUNT)) as CardId;
}

/** The `RANK_ORDER` slot a card id belongs to, read back through the card table. */
export function rankSlotViaCardTable(cardId: CardId): number {
  return RANK_ORDER.indexOf(getCard(cardId).rank);
}
