# Execution Plan 012: Production Table UI

Status: Completed

Started: 2026-09-04

Completed: 2026-09-04

Spec: `docs/specs/040-production-table-ui/spec.md`

Baseline: `be099e2 feat: add casual heuristic AI`

## Goal

Replace the debug Web slice with the approved calm, touch-first production UI
and connect the complete deterministic engine plus casual AI into one playable
offline match, without expanding into rules help, persistence, audio, settings,
or difficulty selection.

## Preconditions and current change boundary

- Spec 040 is approved after the product/design interview.
- ADR 0010 and its narrow removal of keyboard-specific debug glue are current
  uncommitted prerequisites and must stay in the same reviewed change boundary
  or be committed independently before UI implementation.
- The core game/rules/AI public contracts are accepted and must not be changed
  for presentation convenience.
- No dependency installation or generated asset is planned.

## Steps

1. [Completed] Recheck the approved product, architecture, ADRs 0004/0005/0008/
   0009/0010, Specs 013/020/021/022/030/031/040, current debug seams, and clean
   diff scope before behavior changes.
2. [Completed] Add failing deterministic tests for the production application
   session: redacted views, fixed-deck start/redeal, human commands, immediate
   AI computation with paced presentation, timer cancellation, selection
   validation, hint cycling, trick projection, result retention, restart, and
   abandon-to-home.
3. [Completed] Implement the smallest production session plus injected Web deck
   source/presentation scheduler, keeping state authority outside Preact and
   routing every game action through accepted core/AI seams.
4. [Completed] Add production component states and semantic structure for home,
   bidding, playing, cannot-beat, exit confirmation, result, and portrait gate;
   replace debug copy and delete obsolete debug session paths only after the
   replacement tests pass.
5. [Completed] Implement the approved card face/back SVG language, responsive
   table geometry, fixed 20-card hand ordering/overlap, role/count/action zones,
   unified button system, and safe-area behavior with native CSS.
6. [Completed] Implement selection and action feedback, current-trick retention,
   special-pattern labels, two motion weights, bottom-card/start/result
   transitions, reduced-motion variants, and cancellation-safe AI/readability
   intervals.
7. [Completed] Replace debug Playwright coverage with production flows, including
   a complete hint-driven match, both bidding choices, gestures, invalid and
   cannot-beat states, exit/rematch, reduced motion, orientation resume, offline
   relaunch, and the three landscape viewport fixtures.
8. [Completed] Run browser/playable visual review and inspect the required state
   screenshot matrix for hierarchy, contrast, clipping, motion, button geometry,
   special-hand restraint, and last-play visibility; fix every reproducible UI
   defect with a regression test where applicable.
9. [Completed] Add the Spec 043 physical-phone checklist, update README/current
   progress, and self-review architecture authority, hidden information, stale
   scheduled work, accessibility semantics, dependency/privacy boundaries,
   production output, and the complete diff.
10. [Completed] Run `pnpm check` through the pinned Linux toolchain, record exact
    Vitest/Chromium/build evidence here, mark the plan completed, move it under
    `docs/exec-plans/completed/`, and commit Spec 040 independently after staged
    scope review.

## Evidence to record

- [x] The complete suite has 205 deterministic tests. Ten production-session
      cases cover fixed-deck start/call/decline/all-pass, redacted frozen views,
      AI pacing and cancellation, selection errors, hint wrap/reset, trick
      retention, full landlord/farmer games, result/restart/home, and disposal.
- [x] All 11 Chromium acceptance tests pass, including complete victory and
      failure flows, continuous selection, reduced motion, offline reload,
      orientation resume, and 800x360, 900x400, and 640x340 layouts.
- [x] Production output contains 7 fully local precached files (67.89 KiB): JS
      51.83 kB / 17.47 kB gzip and CSS 16.19 kB / 4.31 kB gzip.
- [x] The screenshot matrix covers home, bidding, both human roles, narrow
      20-card hand, normal/cannot-beat responses, rocket feedback, exit,
      victory, failure, and portrait. Review found and fixed result-title/final-
      play overlap and the erroneous zero-card low warning; the repeated matrix
      has no observed clipping, semantic overlap, or debug copy.
- [x] `docs/device-tests/043-physical-phone-checklist.md` is prepared for Redmi
      K60E and Redmi K70 Pro; no physical
      device pass claimed unless actually performed and recorded.
- [x] Node 24.20.0/pnpm 11.24.0 `pnpm check` passes strict TypeScript,
      deterministic tests, production/build-output checks, boundaries, privacy,
      and Chromium acceptance.
- [x] No AI hidden hand, unrevealed bottom-card identity, new dependency, runtime
      network capability, generated output, private data, or debug-only UI is
      staged.

## Recovery

All planned changes are version-controlled source, tests, and documentation
after baseline commit `be099e2`. No remote mutation, persistent data migration,
credential, dependency install, audio/image binary, or destructive filesystem
operation is part of this plan. Before the first implementation edit, preserve
and review the existing ADR 0010 change separately from unrelated user work.

## Stop line

Stop when one complete production match and its approved presentation states
pass the quality gate and browser/playable review. Do not begin Specs 041, 042,
043 implementation, 050, or 051 under this plan.
