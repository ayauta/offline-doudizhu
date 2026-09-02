# Spec 013: Legal Action Generation

Status: Approved for implementation

Date: 2026-09-02

## Goal

Generate the complete deterministic set of legal play/pass actions for a
player's hand and current play. Hints, every AI strategy, and later game safety
checks will consume this one source instead of reconstructing combinations or
comparison rules.

## Public API and test seam

`src/core/rules` exports:

```ts
generateLegalActions(
  context: PlayContext,
): readonly ValidatedPlayAction[];
```

`generateLegalActions` is the only new public test seam. It accepts the trusted
engine context already defined by Spec 012 and returns only actions accepted by
`validatePlay`.

The returned array and every returned action are readonly, frozen, plain, and
serializable. Inputs are never mutated. Generation has no failure result:
trusted context either has zero or more legal actions.

## Completeness and uniqueness

Generation covers all 14 Spec 010 pattern kinds:

- single, pair, triple;
- triple with single, triple with pair;
- straight, consecutive pairs;
- airplane, airplane with single wings, airplane with pair wings;
- four with two cards, four with two pairs;
- bomb and rocket.

Completeness is defined over rule-equivalent actions, not suit variants. Two
plays are equivalent when their selected cards have the same rank-count
histogram. The generator returns exactly one action per legal histogram and
chooses the lowest physical `CardId` values available for every selected rank.
For example, four cards of one rank yield one canonical single, pair, triple,
and bomb rather than every suit combination.

This deduplication affects generated hints/AI choices only. Spec 012 continues
to accept any owned physical-card selection with the same legal ranks.

Every constructed candidate is submitted to `validatePlay`; only successful
normalized actions enter the result. Candidate construction must not duplicate
classification, comparison, bomb/rocket precedence, ownership, or pass rules.

## Pass and response behavior

- A lead (`currentPlay === null`) contains play actions only; pass is absent.
- A response contains every play that strictly beats `currentPlay` plus exactly
  one pass action.
- If no play can beat the current play, the response is exactly `[pass]`.
- An empty leading hand returns an empty array. Finished-state handling remains
  a later game-state responsibility.

## Stable ordering

Results are deterministic and sorted as follows:

1. play actions precede pass;
2. play-pattern kinds follow the existing Spec 010 order, leaving bomb and
   rocket after ordinary patterns;
3. within one kind, fewer selected cards come first;
4. then lower comparison `mainRank` comes first;
5. remaining ties use lexicographic canonical `CardId` order.

The order is a stable enumeration contract, not AI strategy. Later hint and AI
layers may filter or rank the returned actions without changing legality.

## Structural generation constraints

- Build candidates from a rank-grouped hand and explicit pattern shapes.
- Enumerate consecutive windows and bounded attachment choices directly.
- Airplane single wings and four-with-two-cards may take two cards from one
  attachment rank, as Spec 010 permits; core ranks are excluded.
- Airplane pair wings and four-with-two-pairs use distinct pair ranks.
- Small and big joker cannot both be used as attachments in one action.
- Do not enumerate all `2^handSize` physical-card subsets in production.
- Do not introduce a generated action table, copied action list, dependency,
  browser/Node API, timer, time source, or randomness.
- Complexity is bounded by the fixed 15-rank vocabulary and the legal
  attachment combinations of a maximum 20-card hand.

## Test plan and acceptance

Table-driven public-seam tests cover:

- at least one generated action for every supported pattern kind;
- every straight/consecutive-pair/airplane window in representative runs,
  including effective maximum lengths and the ace boundary;
- complete single-wing and pair-wing attachment choices, pair-as-two-wings,
  core-rank exclusion, individual joker attachments, and forbidden two-joker
  attachments;
- canonical physical-card selection and removal of suit-equivalent duplicates;
- exact response filtering for ordinary plays, bombs, rocket, and pass;
- no-beating-play and empty-lead results;
- deterministic ordering, input non-mutation, uniqueness, freezing, and JSON
  round-trip serialization;
- comparison with an independent brute-force/deduplicating oracle on bounded
  representative hands, used only in tests.

Acceptance requires strict typecheck, all deterministic Vitest tests,
production/build-output checks, boundaries, privacy, and existing Playwright
Chromium regression through the project-local Node 24.20.0/pnpm 11.24.0
toolchain.

## Non-goals

No hint cycling state, strategic ranking, AI choice, turn/seat validation, hand
removal, state transition, dealing, bidding, trick reset, UI integration,
localization strings, persistence, scoring, or Android packaging is included.
