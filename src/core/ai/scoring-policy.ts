import { STANDARD_RANKS, getCard, type CardId, type Rank } from "../cards/index.js";
import type { GameCommand } from "../game/index.js";
import type { PlayPattern, ValidatedPlayAction } from "../rules/index.js";
import type { AiDecisionContext, AiStrategy } from "./ai.js";
import { rankCasualPlayActions } from "./casual-strategy.js";
import {
  createHandAnalyzer,
  estimateBasicHandTurns,
  type HandAnalyzer,
} from "./hand-analyzer.js";
import { mainRankStrength, scorePublicPosition } from "./state-evaluator.js";

export type RuleAiProfile = "casual" | "expert";

export type ScoredPlayAction = Readonly<{
  action: ValidatedPlayAction;
  score: number;
}>;

type PlayContext = Extract<AiDecisionContext, { readonly kind: "play" }>;

const RANKS: readonly Rank[] = Object.freeze([
  ...STANDARD_RANKS,
  "small-joker",
  "big-joker",
]);

function groupCounts(cards: readonly CardId[]): Map<Rank, number> {
  const counts = new Map<Rank, number>();
  for (const cardId of cards) {
    const rank = getCard(cardId).rank;
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }
  return counts;
}

function withoutCards(hand: readonly CardId[], cards: readonly CardId[]): CardId[] {
  const selected = new Set(cards);
  return hand.filter((cardId) => !selected.has(cardId));
}

function shapeValue(pattern: PlayPattern): number {
  switch (pattern.kind) {
    case "single": return 0;
    case "pair": return 36;
    case "triple": return 60;
    case "triple-with-single": return 115;
    case "triple-with-pair": return 145;
    case "straight": return pattern.sequenceLength * 40;
    case "consecutive-pairs": return pattern.sequenceLength * 58;
    case "airplane": return pattern.sequenceLength * 80;
    case "airplane-with-singles": return pattern.sequenceLength * 105;
    case "airplane-with-pairs": return pattern.sequenceLength * 120;
    case "four-with-two-cards": return 70;
    case "four-with-two-pairs": return 90;
    case "bomb":
    case "rocket": return 0;
  }
}

function highCardCost(cards: readonly CardId[]): number {
  let cost = 0;
  for (const cardId of cards) {
    const strength = RANKS.indexOf(getCard(cardId).rank);
    if (strength >= 11) {
      cost += (strength - 10) * 34;
    }
  }
  return cost;
}

function structureBreakCost(
  hand: readonly CardId[],
  action: Extract<ValidatedPlayAction, { readonly type: "play" }>,
): number {
  const handCounts = groupCounts(hand);
  const actionCounts = groupCounts(action.play.cards);
  let cost = 0;
  for (const [rank, used] of actionCounts) {
    const held = handCounts.get(rank) ?? 0;
    if (held === 4 && used < 4) {
      cost += 390 + used * 45;
    } else if (held === 3 && used < 3) {
      cost += used === 1 ? 150 : 110;
    } else if (held === 2 && used === 1) {
      cost += 95;
    }
  }
  const heldSmall = handCounts.get("small-joker") === 1;
  const heldBig = handCounts.get("big-joker") === 1;
  if (heldSmall && heldBig && action.play.pattern.kind !== "rocket") {
    cost += action.play.cards.some((card) => {
      const rank = getCard(card).rank;
      return rank === "small-joker" || rank === "big-joker";
    }) ? 520 : 0;
  }
  return cost;
}

function bombCost(
  context: PlayContext,
  action: Extract<ValidatedPlayAction, { readonly type: "play" }>,
): number {
  if (action.play.pattern.kind !== "bomb" && action.play.pattern.kind !== "rocket") {
    return action.play.pattern.kind === "four-with-two-cards" ||
      action.play.pattern.kind === "four-with-two-pairs" ? 170 : 0;
  }
  const enemyMinimum = Math.min(
    ...(["human", "ai-one", "ai-two"] as const)
      .filter((seat) => seat !== context.view.seat &&
        (context.view.seat === context.view.landlord
          ? seat !== context.view.landlord
          : seat === context.view.landlord))
      .map((seat) => context.view.remainingCardCounts[seat]),
  );
  let cost = action.play.pattern.kind === "rocket" ? 1_080 : 820;
  if (context.view.hand.length <= 6) {
    cost -= 360;
  }
  if (context.view.currentPlay !== null && enemyMinimum <= 1) {
    cost = 0;
  } else if (context.view.currentPlay !== null && enemyMinimum <= 2) {
    cost -= 480;
  }
  return cost;
}

function bidStrength(context: Extract<AiDecisionContext, { readonly kind: "bid" }>, profile: RuleAiProfile): number {
  const counts = groupCounts(context.view.hand);
  let score = 0;
  score += (counts.get("A") ?? 0) * 2;
  score += (counts.get("2") ?? 0) * 5;
  score += (counts.get("small-joker") ?? 0) * 8;
  score += (counts.get("big-joker") ?? 0) * 10;
  if (counts.get("small-joker") === 1 && counts.get("big-joker") === 1) {
    score += 8;
  }
  for (const count of counts.values()) {
    score += count === 4 ? 9 : count === 3 ? 3 : count === 2 ? 1 : 0;
  }
  if (profile === "expert") {
    const analysis = createHandAnalyzer({ maxNodes: 180 }).analyze(context.view.hand);
    score += analysis.structureScore - analysis.minimumTurns * 2 + analysis.controlCards;
  }
  return score;
}

export function scoreAction(
  context: PlayContext,
  action: ValidatedPlayAction,
  profile: RuleAiProfile,
  analyzer: HandAnalyzer = createHandAnalyzer({ maxNodes: profile === "expert" ? 600 : 40 }),
  policyPrior = 0,
): number {
  if (action.type === "pass") {
    return policyPrior + scorePublicPosition(context.view, action, profile);
  }
  if (action.play.cards.length === context.view.hand.length) {
    return 1_000_000;
  }

  const remaining = withoutCards(context.view.hand, action.play.cards);
  // The current-hand term is constant across every candidate. Keeping it on the
  // inexpensive estimator leaves the bounded recursive budget for the state
  // that actually differs: the hand after this action.
  const beforeTurns = estimateBasicHandTurns(context.view.hand);
  const after = profile === "expert" ? analyzer.analyze(remaining) : null;
  const afterTurns = after?.minimumTurns ?? estimateBasicHandTurns(remaining);
  let score = action.play.cards.length * (profile === "expert" ? 78 : 62);
  score += shapeValue(action.play.pattern);
  score += (beforeTurns - afterTurns) * (profile === "expert" ? 260 : 150);
  if (after !== null) {
    score += after.structureScore * 18;
    score -= after.looseSingles * 52;
    score += after.controlCards * 12;
  }
  score -= mainRankStrength(action.play.pattern) * (profile === "expert" ? 6 : 4);
  score -= highCardCost(action.play.cards);
  score -= structureBreakCost(context.view.hand, action);
  score -= bombCost(context, action);
  score += scorePublicPosition(context.view, action, profile);
  return score + policyPrior;
}

function defaultPolicyPrior(rank: number): number {
  // The shipped policy is a proven foundation. The expert layer may reorder
  // nearby choices when its deeper evidence is meaningful, while increasingly
  // distant default choices require correspondingly stronger evidence.
  return Math.max(0, 12 - rank) * 160;
}

export function rankScoredPlayActions(
  context: PlayContext,
  profile: RuleAiProfile,
  options: Readonly<{
    analyzerNodes?: number;
    shouldContinue?: () => boolean;
  }> = {},
): readonly ScoredPlayAction[] {
  const totalAnalyzerNodes = options.analyzerNodes ?? (profile === "expert" ? 600 : 40);
  const analyzerNodesPerAction = Math.max(
    1,
    Math.floor(totalAnalyzerNodes / Math.max(1, context.legalActions.length)),
  );
  const defaultRanks = profile === "expert"
    ? new Map(rankCasualPlayActions(context).map((action, rank) => [action, rank]))
    : null;
  const evaluationOrder = context.legalActions
    .map((action, index) => ({ action, index }))
    .sort((left, right) => defaultRanks === null
      ? left.index - right.index
      : (defaultRanks.get(left.action) ?? 12) - (defaultRanks.get(right.action) ?? 12));
  const scored: Array<{ action: ValidatedPlayAction; index: number; score: number }> = [];
  for (const { action, index } of evaluationOrder) {
    if (scored.length > 0 && options.shouldContinue?.() === false) {
      break;
    }
    // Give every candidate the same bounded search allowance. A single shared
    // node counter made later legal actions depend on generator order once an
    // early candidate consumed the budget.
    const score = scoreAction(
      context,
      action,
      profile,
      createHandAnalyzer({
        maxNodes: analyzerNodesPerAction,
      }),
      defaultRanks === null ? 0 : defaultPolicyPrior(defaultRanks.get(action) ?? 12),
    );
    scored.push({ action, index, score });
  }
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return Object.freeze(scored.map(({ action, score }) => Object.freeze({ action, score })));
}

function playCommand(context: PlayContext, profile: RuleAiProfile): GameCommand {
  const action = rankScoredPlayActions(context, profile)[0]?.action;
  return action === undefined || action.type === "pass"
    ? Object.freeze({ type: "pass", seat: context.view.seat })
    : Object.freeze({
        type: "play",
        seat: context.view.seat,
        cards: Object.freeze([...action.play.cards]),
      });
}

function createStrategy(profile: RuleAiProfile): AiStrategy {
  return Object.freeze({
    chooseCommand(context: AiDecisionContext): GameCommand {
      if (context.kind === "play") {
        return playCommand(context, profile);
      }
      const lastBidder = context.view.seat === "ai-two" && context.view.declinedSeats.length >= 2;
      const threshold = profile === "expert"
        ? (lastBidder ? 16 : 29)
        : (lastBidder ? 8 : 18);
      return Object.freeze({
        type: "bid",
        seat: context.view.seat,
        decision: bidStrength(context, profile) >= threshold ? "call" : "decline",
      });
    },
  });
}

export const SCORING_CASUAL_AI_STRATEGY = createStrategy("casual");
export const EXPERT_AI_STRATEGY = createStrategy("expert");
