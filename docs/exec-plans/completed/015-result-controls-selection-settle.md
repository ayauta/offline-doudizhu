# Execution Plan 015: Result Controls and Selection Settle

Status: Completed

Started: 2026-09-05

Completed: 2026-09-05

Spec: `docs/specs/040-production-table-ui/spec.md`

## Goal

Fix two phone interaction regressions reported from real play: result actions
that can be seen but not touched on an unusually short landscape viewport, and
the origin card rebounding later than the rest during continuous deselection.

## Change boundary

- Spec 040, native CSS interaction layering, Playwright regressions, and phone
  acceptance notes are in scope.
- Game state, session actions, pointer path recovery, AI, rules, card order,
  offline behavior, and privacy boundaries do not change.
- Card-face artwork and typography are explicitly deferred to a separate
  design discussion. The supplied screenshots record joker glyph collision,
  tight two-character ranks such as `10`, and inconsistent visual density
  between hand cards and table cards, but this bug-fix plan does not pre-empt
  that broader design decision.

## Diagnosis

- The result controls use z-index 30 while the faded human hand remains at
  z-index 35 and pointer-active. Wherever their responsive bounds overlap, a
  losing hand therefore intercepts touch over the visible result buttons;
  desktop card height makes the overlap especially clear.
- During continuous deselection, the origin button remains `:active` until
  pointer-up. Its `translateY(-3px)` overrides the deselected resting position,
  while later cards already target zero, producing the reported delayed first
  rebound.

## Steps

1. [Completed] Read the screenshots, product/architecture constraints, ADRs
   0009 and 0010, Spec 040, current styles, and current browser coverage.
2. [Completed] Record unobstructed result-hit-area and synchronized selection
   settle requirements in Spec 040 before implementation.
3. [Completed] Add failing Chromium regressions for both result actions at a
   desktop result and the held-pointer transform of a five-card deselection.
4. [Completed] Make receded result-state hand content pointer-inert and keep
   result controls above noninteractive table content.
5. [Completed] Replace positional `:active` card feedback with an immediate
   non-positional boundary/shadow response.
6. [Completed] Run targeted and complete quality gates, inspect both supplied
   viewport cases, update phone checks, self-review, archive, and commit.

## Acceptance evidence

- [x] Both `返回首页` and `再来一局` pass hit-target trials across their visible
      surface at 1440×900 with a nonempty losing hand.
- [x] While a five-card deselection is still held, all five cards have the same
      settled vertical transform; pointer-up causes no extra first-card move.
- [x] Fast path recovery and all existing 640×340 through desktop acceptance
      remain green.
- [x] No card-face redesign, dependency, remote asset, request capability,
      persistence change, or private data is introduced.

## Recorded evidence

- Before the fix, the result regression timed out with Playwright reporting
  that a remaining hand card intercepted `返回首页`; the held-deselection test
  measured two distinct transforms across the five cards.
- After the fix, both result buttons pass center and near-bottom hit-target
  trials at 1440×900 with 14 human cards remaining. A real Chromium review then
  clicked `返回首页` successfully and returned to the home screen.
- The held-pointer regression now measures one transform for all five
  deselected cards after the shared 100 ms settle. The previous fast-segment,
  direction-reversal, and corridor recovery scenarios remain green.
- Node 24.20.0 / pnpm 11.24.0 `pnpm check` passes: 211 deterministic tests,
  17 Chromium scenarios, strict TypeScript, production build, build-output,
  architecture-boundary, and privacy checks all pass.
- The physical-phone checklist now explicitly covers the held second swipe and
  both result actions with cards remaining. Physical Redmi execution remains
  pending and is not claimed.

## Recovery

All changes are version-controlled CSS, tests, and documentation. Revert this
plan's files together if the layering or pressed-state correction regresses
selection clarity at the supported landscape baselines.
