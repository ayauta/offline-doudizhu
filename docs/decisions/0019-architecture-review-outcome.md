# ADR 0019: Architecture Review Outcome — Shared Vocabulary and Testable Boundaries

Status: Accepted
Date: 2026-09-19

## Context

The project was reviewed against a deep-module vocabulary (leverage at the
interface, locality for maintainers) and against *Game Programming Patterns*. The
review found the structure sound and recorded why, so that the same ground is not
re-broken later:

- `src/core/game/game.ts` is the reference module. Three exported symbols, 223
  lines of `transition`, errors as values, deeply frozen state, randomness and
  time injected at the composition root.
- Dependency direction is enforced against the build artifact, not by directory
  convention: `scripts/check-boundaries.mjs` computes the runtime import closure
  of both delivery entries and the worker.
- `src/main.tsx` assembles dependencies by passing them in. *Game Programming
  Patterns* prefers exactly that over a global lookup ("首先考虑把对象传给它"), so
  the "no dependency-injection container" rule in `ARCHITECTURE.md` is confirmed
  rather than relaxed.

Two weaknesses had single, mechanical root causes:

1. `src/core/rules/index.ts` did not re-export `ranks.ts`. Every consumer that
   needed the strength order therefore carried its own copy of the ladder
   "3 … A, 2, small-joker, big-joker": five under `src/core/ai/` and a sixth in
   `src/app/session/production-session.ts`, where it had also been rewritten as
   string literals. `SEQUENCE_RANKS` was re-sliced three more times.
2. Pure logic sat behind DOM-bound signatures and a 954-line session closure, so
   it could only be exercised through the slowest acceptance tests, or not at
   all. `production-session.ts` held 27 mutable bindings and 30 inner functions,
   18 of which re-triggered a hand-written `publish()`.

`tests/` had no shared harness: five byte-identical `expectDeepFrozen`, four
`cardIds` helpers whose validation had drifted, and two `seededRandom`. The
laxest `cardIds` performed no bounds check at all, so `["3", 5]` silently
produced a four and a four instead of failing.

## Decision

1. **`src/core/rules` owns rank order.** `RANK_ORDER`, `SEQUENCE_RANKS`,
   `rankStrength`, and `MAX_SEQUENCE_RANK_STRENGTH` are exported from the rules
   barrel, and every consumer imports them. A source-contract test
   (`tests/config/rank-ladder.test.ts`) fails if a joker-terminated ladder
   appears anywhere under `src/` other than `core/rules/ranks.ts`.

2. **`src/core/cards/shuffle` owns shuffling.** `shuffleCards` in
   `core/ai/master-policy.ts` is deleted; `SeededRandom` declares
   `implements RandomSource` and is passed to the shared `shuffle`. The enhanced
   AI's sampling now runs on the implementation whose arithmetic is pinned by
   `tests/core/cards.test.ts`, which the removed copy never was.

3. **`src/app/session/table-view.ts` owns the read-only view.** It holds the view
   types and `deriveView(snapshot)`. The session stays the single authority
   (`ARCHITECTURE.md` §4) and still owns every mutable binding; it now hands the
   derivation an explicit `TableViewSnapshot` instead of letting it read closure
   state. The displayed hand and the seat card counts are derived from the game
   state rather than cached alongside it, which removes `syncPublicCountsAndHand`
   and two of the session's bindings.

4. **Pure presentation logic lives outside the components.** Hit-region geometry
   in `ui/input/pointer-geometry.ts`, regroup offsets in
   `ui/layout/hand-layout.ts`, the live-feedback priority in
   `ui/feedback-message.ts`, and card naming in `ui/components/card-face.tsx`.

5. **`tests/support/harness.ts` owns the shared fixtures** and carries the
   strictest validation any copy had, so the silent case can no longer occur.

## Deliberately not done

Recorded because each was considered and rejected on a stated ground, not missed.

| Rejected | Ground |
| --- | --- |
| Event bus or event queue | *Game Programming Patterns*: a queue is only needed to decouple in **time**; the engine already returns ordered events synchronously. `ARCHITECTURE.md` §1 excludes one. |
| Service locator or DI container | The book's own priority is to pass the object in; `main.tsx` already does. |
| Dirty-flag caching of the view | The pattern's stated preconditions are a high change-to-use ratio and expensive incremental updates. Neither holds at this size. |
| Component/ECS decomposition | The component pattern pays off with many entities and orthogonal aspects; this game has three seats and one deck. |
| GoF State classes for the session | The book's own ladder starts at enum-plus-switch, and warns against over-object-orienting. The session's control flags should collapse to a discriminated union in the existing house style before anything more elaborate is considered. |
| Splitting `styles.css` | Cosmetic only, and the stylesheet sits near its measured gzip budget. |
| Extracting the duplicated 9-line `freezeDeep` | No variance axis and no legitimate home; `ARCHITECTURE.md` §3 forbids generic helper directories. Two copies of nine trivial lines cost less than inventing a module for them. |
| Altering `shuffle` semantics | `useSeatHand` in the acceptance suite inverts the Fisher-Yates arithmetic; changing it would silently re-deal a dozen browser tests. |
| A test-only hook in `main.tsx` | The acceptance suite patches the browser random source, which is the real seam. A production hook would be worse. |
| Changing `core/game` state shape | ADR 0004 makes commands and snapshots stable contracts. |

## Dependencies

None added. Every change is a move, a deletion, or an export within existing
modules.

## Consequences

- View rules became testable in Node: the derived view, the control matrix, the
  hand order, hit-region geometry, regroup offsets, and feedback priority now
  have unit tests. The suite grew from 268 to 314 deterministic tests.
- A rule that had **no** guard now has one. Breaking
  `hitRegionsFromRects` so each card keeps its full width passes all four
  browser tests that cover continuous selection, because their touch points land
  on card left edges; only the new unit test catches it.
- Main JavaScript gzip grew about 0.19 KiB, from 19.59 to 19.89 of the 20.51 KiB
  budget, because the session now builds an explicit snapshot per publish. The
  budget remains a hard limit and `check:bundle` enforces it.
- The enhanced AI's world sampling is now covered by the shuffle test rather
  than by nothing.

## Reconsider when

- a future change needs a view rule the snapshot cannot express without widening
  it past readability — that is the signal to collapse the session's control
  flags into an explicit mode rather than to grow the snapshot;
- the main-JavaScript gzip budget blocks a needed change, which would mean
  revisiting the snapshot construction rather than the boundary;
- the enhanced AI gains a second consumer of `activeCurrentPlay` or
  `selectionIsLegal`, at which point those queries belong to the game core rather
  than to the view module; or
- a native surface or a second delivery shell appears, which would reopen the
  delivery and platform questions this review left alone.
