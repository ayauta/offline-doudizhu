# Execution Plan 002: Minimal Vertical Slice (Historical)

> Completed historical work. Platform-specific instructions in this plan were
> superseded by ADR 0008 and execution plan 003.

Status: Completed  
Completed: 2026-08-30

## Goal

Implement specs 002 and 003 only, prove the accepted boundaries end to end,
then stop before formal Dou Dizhu rules.

## Steps

1. [Done] Add card/deck/shuffle tests and pure core implementation.
2. [Done] Add deterministic debug-state, geometry/layout, drawing, hit testing, and
   tap-recognition tests and implementation.
3. [Done] Add an injectable WeChat Canvas/touch adapter and fake-adapter tests.
4. [Done] Wire a deterministic 17-card mock hand in `src/game.ts`.
5. [Done] Run frozen install, typecheck, tests, build, bundle smoke,
   boundary/privacy checks, and aggregate check.
6. [Done] Verify in WeChat Developer Tools and on a phone.
7. [Done] Record playable evidence, move this plan to completed, and stop.

## Automated evidence

Recorded: 2026-08-30

- `pnpm install --frozen-lockfile` passed with pnpm 11.24.0.
- `pnpm typecheck` passed both project and official WeChat API compatibility checks.
- `pnpm test` passed 7 files / 19 tests.
- `pnpm build` produced `dist/game.js` at 16,693 bytes.
- `pnpm check:bundle` passed startup, draw, selection, and debug-button interaction.
- `pnpm check:boundaries` passed.
- `pnpm check:privacy` passed with 18 runtime files scanned.
- The complete local gate was reproduced with the repository's installed tools;
  the current WSL shell lacked the `pnpm` shim, so the same package scripts were
  run individually through `npm run` without installing or changing dependencies.

## Playable evidence

Recorded: 2026-08-30

- Windows used WeChat Developer Tools Nightly `2.02.2608272` with the bundled
  official `wechatide` Skill `0.3.10`.
- Because WeChat Developer Tools rejected a WSL UNC project path, the ignored
  build and private project configuration were copied into a private Windows
  preview mirror. Every copied file was verified against the WSL source with
  SHA-256; no AppID or generated output was added to the repository.
- Official simulator refresh and screenshot calls succeeded. The 964-by-446
  landscape frame showed a deep-green table, 17 readable mock cards, three
  readable buttons, and correct safe-area placement.
- Official image-coordinate Canvas taps proved selection and unselection, then
  proved visible debug-state changes for `不出`, `提示`, and `出牌`. A final
  refresh restored the initial state.
- The exact project-console filter `/game.js` returned no matches. A platform
  `WAGame.js` entry produced by an inapplicable page-runtime diagnostic was
  classified as tooling noise after the official Mini Game automator guidance
  was applied.
- Official `auto_preview` successfully pushed the 26,701-byte preview package.
  The product owner confirmed on a real phone that landscape layout, safe areas,
  readability, card toggling, and all three debug-button changes passed.

## Safety and rollback

The slice has no persistence or external runtime effects. Generated `dist/`,
private local configuration, Windows preview mirrors, screenshots, and
diagnostic manifests stay outside version control. Reverting the slice means
removing only its source/tests/spec files and restoring the empty composition
root; Gate E remains intact.

## Explicit stop line

Do not begin pattern classification, move generation, bidding, AI, scoring, or
the full game state machine after this plan.
