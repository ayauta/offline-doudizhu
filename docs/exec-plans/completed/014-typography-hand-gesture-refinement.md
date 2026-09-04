# Execution Plan 014: Typography, Hand, and Gesture Refinement

Status: Completed

Started: 2026-09-05

Completed: 2026-09-05

Spec: `docs/specs/040-production-table-ui/spec.md`

## Goal

Refine the production table's typography and spacing, keep low-card hands
naturally compact without shrinking physical cards, and make rapid continuous
selection deterministic. Preserve Apple-influenced restraint and readability
on both desktop and phone while retaining familiar Dou Dizhu table grammar.

## Change boundary

- Spec 040, native Preact/CSS presentation, pure pointer geometry, browser
  acceptance, and the physical-phone checklist are in scope.
- The authoritative session, core rules, AI, card order, privacy boundary,
  offline behavior, and PWA delivery do not change.
- No dependency, remote/custom font, external asset, runtime request, sound,
  vibration, or decorative animation is added.

## Approved decisions

- Result success and failure share one quiet type/layout system; only wording
  differs. The result settles with opacity plus 4 pixels over 220 ms.
- A five-role system-font hierarchy replaces arbitrary weights and Chinese
  tracking across the home, table, result, confirmation, and rotate gate.
- Card size remains stable. A 1–17-card hand uses a preferred 68–72% card-width
  step and naturally narrows around center; 18–20 cards compress only as needed.
- Continuous selection uses coalesced events plus segment/card intersection,
  a forgiving vertical corridor, pause/re-entry behavior, and one state change
  per card per gesture.
- Selection feedback remains a quiet 100 ms, 10–12-pixel lift with boundary
  contrast. Accepted human plays regroup remaining cards horizontally over
  180 ms with `cubic-bezier(0.77, 0, 0.175, 1)`; reduced motion is immediate.

## Steps

1. [Completed] Re-read product/architecture constraints, ADRs 0009 and 0010,
   Spec 040, Plan 013, current UI/input/tests, the screenshot, and public Apple,
   Pointer Events, 欢乐斗地主, and JJ斗地主 references.
2. [Completed] Record the approved type, spacing, density, hit-corridor,
   sampling, and motion decisions in Spec 040 before changing behavior.
3. [Completed] Add failing deterministic and Chromium regressions for fast
   segment crossing, low-count hand width, result typography/spacing, and
   post-play regrouping/reduced motion.
4. [Completed] Implement pure pointer path recovery and the smallest Preact
   wiring for coalesced samples, corridor pause/re-entry, and FLIP regrouping.
5. [Completed] Implement natural hand density and the unified system typography/
   result vertical rhythm with shared native CSS tokens.
6. [Completed] Run targeted deterministic/type/browser checks and repair any
   regression without changing gameplay rules.
7. [Completed] Review representative desktop, narrow phone, result, rapid-swipe,
   and reduced-motion states; update the physical-phone checklist.
8. [Completed] Self-review dependency/privacy/motion/accessibility impact, run
   `pnpm check`, record evidence here, move this plan to completed, and commit.

## Acceptance evidence

- [x] One delivered pointer jump across four cards selects all four in path
      order; reversing or revisiting does not toggle them twice.
- [x] Leaving the vertical hand corridor adds no card, re-entry continues, and
      pointer-up retains prior changes.
- [x] Two remaining cards stay centered with the same physical width and a
      preferred exposed step; 17 cards remain compact and 20 fit all baselines.
- [x] Win/failure use matching readable typography and spacing, retain the
      final play, and add no celebratory or color-only distinction.
- [x] Accepted plays alone trigger a 180 ms horizontal regroup; reduced motion
      triggers no regroup animation.
- [x] Node 24.20.0 / pnpm 11.24.0 `pnpm check` passes.

## Recorded evidence

- The new deterministic regressions first failed because segment recovery and
  natural hand-width calculation did not exist; implementation then brought
  all 211 deterministic tests green.
- All 16 Chromium scenarios pass, including a single delivered jump across
  four cards, reverse selection, corridor exit/re-entry, exact 180 ms easing,
  reduced motion, result spacing, and the existing offline/full-round flows.
- Desktop acceptance verifies a 17-card origin step between 68% and 72% of card
  width at 1366×768 and 1440×900. Twenty cards compress within the 1040-pixel
  stage; 800×360, 900×400, and 640×340 remain free of overflow.
- Visual review inspected a 1440×900 20-card table, its completed result, a
  640×340 20-card table, and a diagnostic two-card hand. The result now reads
  as one title/subline/final-play/action axis; two cards remain centered and
  related without shrinking.
- The production build contains 7 locally precached files (73.42 KiB). Strict
  TypeScript, build-output, boundary, privacy, deterministic, and browser
  checks pass. No dependency, remote/custom font, asset, request capability,
  generated build output, or private data was added.
- The physical-phone checklist now covers fast flings, path exit/re-entry,
  two-card density, regrouping, result rhythm, and reduced motion. Redmi K60E
  and K70 Pro execution remains pending and is not claimed here.

## Recovery

All changes are version-controlled source, test, and documentation text. There
is no migration, dependency, generated artifact, credential, or persisted-data
change. Revert this plan's files together if the refinement cannot satisfy the
desktop and narrow-phone acceptance baselines.
