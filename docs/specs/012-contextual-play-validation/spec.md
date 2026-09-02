# Spec 012: Contextual Play Validation

Status: Approved for implementation

Date: 2026-09-02

## Goal

Provide one pure TypeScript rules API that validates a typed pass or selected
physical cards against a player's current hand and the current play. The API
must reuse hand-pattern classification and comparison, return stable
user-explainable errors, and normalize accepted card selections for later
legal-action generation, game transitions, hints, and AI safety checks.

## Public API and test seam

`src/core/rules` exports:

```ts
type PlayAction =
  | Readonly<{ type: "pass" }>
  | Readonly<{ type: "play"; cards: readonly CardId[] }>;

type PlayContext = Readonly<{
  hand: readonly CardId[];
  currentPlay: ClassifiedPlay | null;
}>;

type ValidatedPlayAction =
  | Readonly<{ type: "pass" }>
  | Readonly<{ type: "play"; play: ClassifiedPlay }>;

validatePlay(
  context: PlayContext,
  action: PlayAction,
): PlayValidationResult;
```

`validatePlay` is the only new public test seam. Tests exercise it through
`src/core/rules/index.ts` without mocking `classifyPlay` or `comparePlays`.

`PlayValidationResult` is a discriminated result:

- success: `{ ok: true, action: ValidatedPlayAction }`;
- failure: `{ ok: false, error: PlayValidationError }`.

Accepted play actions contain the classified, canonically ordered physical
cards. Accepted pass actions contain no cards. Results, errors, accepted
actions, and newly created values are readonly, frozen, plain, and
serializable.

## Stable errors and precedence

`PlayValidationErrorCode` contains every existing `ClassificationErrorCode`
plus:

- `card-not-in-hand`;
- `cannot-pass-when-leading`;
- `play-does-not-beat-current`.

Errors are code-only values: `{ code: PlayValidationErrorCode }`. User-facing
Chinese strings remain outside the rules model.

For a `play` action, validation order is:

1. call `classifyPlay` once and preserve its existing error precedence;
2. verify every classified physical `CardId` occurs in `context.hand`;
3. if `currentPlay` is null, accept the classified play as a lead;
4. otherwise call `comparePlays` once and accept only `higher`.

Classification errors pass through unchanged. Ownership is based on physical
`CardId`, not rank or suit equivalence. `equal`, `lower`,
`different-pattern`, and `different-length` all map to
`play-does-not-beat-current`.

For a `pass` action, a null `currentPlay` returns
`cannot-pass-when-leading`; otherwise pass is accepted. An empty `play` action
is not pass and retains the classification error `empty-selection`.

`hand` and `currentPlay` are trusted engine context produced by later game
state. This feature validates the candidate action and does not validate a
whole snapshot.

## Behavior and constraints

- Inputs are never mutated.
- The function is deterministic and has no effects, time, timers, platform
  APIs, storage, network, or ambient randomness.
- Pattern recognition and bomb/rocket precedence remain owned by the existing
  classification and comparison implementations; contextual validation must
  not duplicate them.
- The implementation belongs in `src/core/rules`, behind one deep public
  interface. Ownership or pass checks are not exported as shallow helpers.
- No dependency or accepted ADR changes are required.

## Test plan and acceptance

Vertical red-green slices through `validatePlay` cover:

- a legal lead returning a normalized classified play;
- leading pass rejected and responding pass accepted;
- physical-card ownership, including rejection of a same-rank different-suit
  card not in the hand;
- a higher response accepted;
- equal, lower, different-pattern, and different-length responses rejected;
- bomb-over-ordinary success through the existing comparison rules;
- all five classification errors passed through, including empty play versus
  pass;
- input non-mutation plus frozen, plain, serializable success and error values.

Acceptance requires the focused deterministic tests, strict typecheck, all
existing Vitest tests, boundary/privacy checks, production build, and existing
Playwright Chromium regression. This core-only feature adds no UI scenario,
motion, interaction design, or phone acceptance requirement.

## Non-goals

No turn or seat validation, hand removal, state mutation, command transition,
trick reset, pass counting, dealing, bidding, legal-action enumeration,
hinting, AI, UI integration, localization strings, persistence, scoring, or
Android packaging is included.
