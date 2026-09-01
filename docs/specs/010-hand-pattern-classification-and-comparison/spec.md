# Spec 010: Hand-Pattern Classification and Comparison

Status: Approved for implementation

Date: 2026-09-02

## Goal

Provide a pure TypeScript rules API that classifies a selected set of physical
cards into the project's complete classic hand-pattern vocabulary and compares
two already classified plays. The result must be deterministic, serializable,
independent of input order and suits, and suitable for later game, AI, and UI
layers.

Research input is recorded in
`docs/research/classic-rules-compatibility.md`. This specification and its tests
are authoritative where references differ.

## Public API

`src/core/rules` exports:

```ts
classifyPlay(cardIds: readonly CardId[]): ClassificationResult
comparePlays(challenger: ClassifiedPlay, incumbent: ClassifiedPlay): ComparisonResult
```

`ClassificationResult` is a discriminated result:

- success: `{ ok: true, play: ClassifiedPlay }`;
- failure: `{ ok: false, error: ClassificationError }`.

`ClassifiedPlay` contains:

- `cards`: a readonly copy of the physical `CardId` values in canonical
  rank-major order;
- `pattern`: a discriminated `PlayPattern`.

`PlayPattern` has exactly these `kind` values:

- `single`, `pair`, `triple`;
- `triple-with-single`, `triple-with-pair`;
- `straight`, `consecutive-pairs`;
- `airplane`, `airplane-with-singles`, `airplane-with-pairs`;
- `four-with-two-cards`, `four-with-two-pairs`;
- `bomb`, `rocket`.

Every non-rocket pattern records its comparison `mainRank`. Sequence patterns
also record `sequenceLength`, measured as ranks for a straight, pairs for
consecutive pairs, and core triples for every airplane form.

The stable classification error codes are:

- `empty-selection`;
- `invalid-card-id`;
- `duplicate-card-id`;
- `too-many-cards`;
- `unsupported-pattern`.

Validation precedence is empty selection, more than 20 selected values, invalid
CardId, duplicate physical CardId, then pattern recognition. Errors may include
safe structured context such as the offending value or selected count, but do
not guess an intended play.

`ComparisonResult` has `outcome` equal to `higher`, `equal`, `lower`, or
`incomparable`. An incomparable result distinguishes `different-pattern` from
`different-length`.

## General classification rules

- A play contains 1 through 20 unique physical cards. Empty is an error, never
  pass; pass will be a separate game-state command.
- A CardId must be an integer from 0 through 53 even when untyped runtime input
  reaches the TypeScript boundary.
- Input arrays are never mutated. Input order and suits do not affect the
  result. Returned cards use canonical CardId order.
- Recognition and comparison use rank only.
- Rank order is `3 4 5 6 7 8 9 10 J Q K A 2 small-joker big-joker`.
- `2` and jokers cannot enter a straight, consecutive-pair core, or airplane
  core. Attachments cannot reuse a core rank.

## Supported patterns

| Kind | Exact shape and comparison main rank |
| --- | --- |
| Single | One card; that card's rank. |
| Pair | Two standard cards of one rank; `2` is allowed. Jokers cannot form a pair. |
| Triple | Three cards of one standard rank. |
| Triple with single | One triple plus one card of another rank; `2` or one joker is allowed. |
| Triple with pair | One triple plus an exact pair of another standard rank; pair `2` is allowed. |
| Straight | At least five consecutive single ranks from `3` through ace; highest rank is main. |
| Consecutive pairs | At least three consecutive exact pairs from `3` through ace; highest pair is main. The 20-card selection cap makes ten pairs the largest accepted play. |
| Airplane | At least two consecutive exact triples from `3` through ace; highest triple is main. The cap permits at most six triples. |
| Airplane with single wings | `n` consecutive core triples plus exactly `n` attachment cards. Attachment ranks occur once or twice; a pair may therefore supply two wings. A rank occurring three or four times cannot be split. At most five core triples fit the cap. |
| Airplane with pair wings | `n` consecutive core triples plus exactly `n` distinct exact pairs. A four-of-a-kind cannot be split. At most four core triples fit the cap. |
| Four with two cards | One four-of-a-kind plus exactly two cards outside its rank. The attachments may be two singles or one exact pair. |
| Four with two pairs | One four-of-a-kind plus two distinct exact pairs outside its rank. A second four-of-a-kind cannot be split. |
| Bomb | Exactly four cards of one standard rank. |
| Rocket | Exactly the small and big jokers. |

For every attachment-bearing pattern, `2` and an individual joker are allowed
when their required multiplicity fits. Small and big joker may not both appear
among attachments of the same play; the rocket cannot be dismantled.

Normative rare examples:

- `33344455` is airplane with two single wings.
- `333444555777` is unsupported because neither a triple nor a bomb may be
  split into single wings.
- `555577` is four with two cards.
- `55557788` is four with two pairs.
- `55557777` is unsupported because the second bomb cannot be split.
- `33344422`, `3334445` plus one joker, and `55552` plus one joker are valid
  attachment shapes.
- `333444` plus both jokers and `5555` plus both jokers are unsupported.

## Comparison

- Ordinary plays compare only when `kind` matches and required sequence length
  matches. The greater `mainRank` is higher.
- Same kind, same required length, and same main rank returns `equal`; equality
  does not beat the incumbent.
- Same sequence kind with different `sequenceLength` is incomparable with
  reason `different-length`.
- Different ordinary kinds are incomparable with reason `different-pattern`.
- A bomb is higher than every non-bomb, non-rocket play. Bombs compare by their
  four-card rank.
- The rocket is higher than every other play. Rocket against rocket is equal.
- Four with attachments is an ordinary pattern, never a bomb.

## Implementation constraints

- Use a rank-count histogram and explicit shape predicates.
- Do not introduce a generated lookup table, copied action table, dependency,
  browser API, Node API, timer, wall-clock time, or randomness.
- Export plain immutable/readonly serializable values and structured results.
- Complexity should be bounded by selected cards plus the fixed rank set.

## Test plan and acceptance

Table-driven tests must cover:

- every valid pattern, minimum and effective maximum sequence lengths, ace
  boundaries, and rejection of `2`/jokers in sequence cores;
- unordered input, suit invariance, canonical result order, and input
  non-mutation;
- every stable error code, duplicate physical cards, the 20-card cap,
  disconnected/short sequences, wrong wing counts, and core-rank reuse;
- the normative rare examples above, including pair wings, second bombs,
  individual joker attachments, and forbidden rocket attachments;
- comparison matrices for same-shape high/equal/low, length mismatch, kind
  mismatch, bomb precedence, larger bombs, and rocket precedence.

Acceptance requires strict typecheck, deterministic Vitest, boundary/privacy
checks, production build, and the existing Playwright Chromium regression.
This core-only feature adds no UI scenario or real-phone acceptance requirement.

## Non-goals

No legal-action enumeration, hinting, ownership validation, passing, trick or
turn state, dealing/bidding, game state machine, AI, UI integration,
persistence, scoring, or Android wrapper is included.
