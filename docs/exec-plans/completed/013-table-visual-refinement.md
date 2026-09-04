# Execution Plan 013: Table Visual Refinement

Status: Completed

Started: 2026-09-04

Completed: 2026-09-04

Spec: `docs/specs/040-production-table-ui/spec.md`

## Goal

Refine the accepted production table into a calmer Apple-influenced physical
card experience: replace button-like opponent identity blocks with borderless
card-stack status anchors, give desktop play a centered stage with larger
overlapping cards, and strengthen typography and material hierarchy without
weakening phone readability, touch behavior, privacy, or offline operation.

## Change boundary

- Presentation markup, native CSS, browser acceptance, Spec 040, and the phone
  checklist are in scope.
- The authoritative session, core rules, AI, ordering, timing, persistence
  boundary, and PWA network policy do not change.
- No dependency, remote asset, custom font, image asset, audio, or framework is
  added.

## Steps

1. [Completed] Re-read the product specification, architecture, ADRs 0009 and
   0010, Spec 040, the completed production-table plan, current UI, browser
   tests, and phone checklist; verify a clean worktree.
2. [Completed] Record the approved C2 status-anchor, centered desktop stage,
   desktop card-density, material separation, and readability decisions in
   Spec 040 before changing behavior.
3. [Completed] Add failing Chromium acceptance for noninteractive opponent
   anchors, desktop card size/overlap/stage placement, and readable narrow-phone
   card typography.
4. [Completed] Implement the smallest semantic component and CSS changes for the
   C2 anchor, centered desktop hand and seats, refined card surfaces, stronger
   typography, and distinctly interactive controls.
5. [Completed] Run deterministic/type/boundary checks and targeted browser tests;
   repair regressions without changing game behavior.
6. [Completed] Capture and inspect representative 1440×900, 1366×768, 900×400,
   800×360, and 640×340 states plus portrait/reduced-motion behavior.
7. [Completed] Update the physical-phone checklist, self-review the complete diff,
   run `pnpm check`, and record exact evidence here. Do not claim a physical
   phone pass.

## Acceptance evidence

- [x] Opponent count is visually integrated with the card stack, role is
      secondary, and no opponent status anchor is a control or shares a generic
      rounded control container.
- [x] At 1366×768 and 1440×900, 17 and 20 card hands use 78–86px cards, overlap,
      remain centered within about 1040px, and opponents sit on the centered
      stage rather than the window edge.
- [x] At 800×360, 900×400, and 640×340, all cards/actions remain inside the
      viewport and exposed rank typography remains legible.
- [x] Reduced motion, selection, bidding, exit, results, offline relaunch,
      boundaries, and privacy checks remain green.
- [x] Node 24.20.0 / pnpm 11.24.0 `pnpm check` passes.

## Recorded evidence

- The new acceptance first failed against the old UI at the missing C2 status
  structure, 67.99px desktop card width, and 11.84px narrow rank size. It then
  passed after implementation.
- All 205 deterministic tests and all 13 Chromium acceptance tests pass.
- Desktop measurement covers both 17 and 20 cards at 1366×768 and 1440×900;
  card width stays in the approved 78–86px range, every adjacent pair overlaps,
  the hand span is at most 1041px, and the centered-stage seat bounds pass.
- Narrow landscape acceptance covers 800×360, 900×400, and 640×340 without
  viewport or action overlap; exposed corner type is at least 13px.
- Visual review inspected bidding, landlord, AI-current, AI-action, portrait,
  desktop, and narrow-phone captures. The C2 anchors remain visually separate
  from actions; the max-height action offset and result-state fading were
  corrected during self-review.
- Production output contains 7 fully local precached files (70.53 KiB): JS
  51.84 kB / 17.46 kB gzip and CSS 18.88 kB / 4.97 kB gzip.
- TypeScript, build-output, architecture-boundary, and privacy checks pass. No
  dependency, remote asset, runtime request capability, generated output, or
  private data was added. Physical-phone acceptance remains pending and is not
  claimed.

## Recovery

All changes are version-controlled text in presentation, tests, and docs. The
refinement introduces no migration, generated artifact, credential, network
capability, or persistent data. Revert this plan's files as one unit if the new
layout cannot satisfy the narrow landscape baselines.
