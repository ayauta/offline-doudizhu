# Execution Plan 016: Quiet Card Faces

Status: Completed

Started: 2026-09-05

Completed: 2026-09-06

Spec: `docs/specs/040-production-table-ui/spec.md`

## Goal

Implement the owner's final large-type/whitespace sample: fixed index column,
one suit below the rank, no center art, no visible Chinese on jokers, upright
red/graphite JOKER, soft-white opaque paper and short restrained shadows.
Preserve Chinese accessible card names and all input/game behavior. Use existing
project-owned SVG suits, system fonts and native CSS; add no dependencies.

## Change boundary

- Shared card presentation, public-play density, responsive result layering,
  Spec 040, Chromium acceptance, and the physical-phone handoff are in scope.
- Core cards, rules, AI decisions, session authority, hand order, gestures,
  offline behavior, privacy boundaries, and persistence do not change.
- The browser-test wrapper may forward Playwright filters and optionally retain
  ignored review screenshots. It continues to use the repository-pinned WSL
  Playwright and bundled Chromium; no system Chrome or new dependency is added.

## Steps

1. [Completed] Record the approved spec and add browser regressions before
   implementation.
2. [Completed] Simplify the shared card artwork and define separate optical
   hand/table typography.
3. [Completed] Make long public plays wrap without hiding indices and keep
   result-state labels, cards, and actions in nonintercepting layers.
4. [Completed] Review dense public groups and 20-card hands at 640×340,
   800×360, 900×400, 1366×768, and 1440×900; preserve input, result, and
   reduced-motion behavior.
5. [Completed] Remove browser-tool friction by forwarding file/title filters
   and adding an ignored `VISUAL_REVIEW=1` screenshot mode around the existing
   pinned Playwright runner.
6. [Completed] Run the full local quality gate, self-review dependency/privacy
   impact, update the physical-phone handoff, archive, and commit.

## Acceptance evidence

- [x] Standard faces contain one large rank and one project-owned SVG suit in a
      fixed exposed index; no central mark remains.
- [x] Both jokers render five upright `JOKER` letters with distinct red/graphite
      color while retaining accessible names `大王` and `小王`.
- [x] Twenty-card hands expose every complete index with at least 21px phone
      ranks and 30px desktop ranks across all automated baseline viewports.
- [x] Two-joker, 12-card straight, human 20-card airplane, and AI 20-card
      winning-airplane public groups retain readable indices and labels.
- [x] Result controls stay topmost and no transparent result/live-feedback layer
      intercepts the retained final play.
- [x] Public-play width uses precomputed card-count offsets instead of requiring
      Chrome 140 typed arithmetic for the dynamic count calculation.
- [x] Filtered browser commands run only matching tests, and visual-review runs
      store automatic screenshots under ignored `output/playwright/`.

## Recorded evidence

- The first AI-result fixture exposed a genuine test-deal error: its intended
  landlord scored below the normal call threshold. The corrected deterministic
  deal reaches the threshold with its visible 17-card hand and receives three
  bottom cards that complete a legal 20-card airplane with pair wings.
- That corrected fixture then exposed result-button and transparent-layer hit
  interception over the long winning play at 640×340. Moving short-height
  result actions below the label and making noninteractive result layers
  pointer-inert restored both readability and action priority.
- Stable screenshots reviewed 20-card hands at 640×340, 800×360, and 900×400,
  the centered desktop stage at 1366×768 and 1440×900, and a 640×340 AI-loss
  result retaining all 20 winning cards and `飞机`.
- Official Playwright guidance confirms the default bundled Chromium is the
  appropriate local regression target and that file/title filters belong on
  `playwright test`; pnpm documents that arguments after a script name are
  forwarded to the script. The repository wrapper now preserves those options
  instead of requiring a separate system Chrome.
- Node 24.20.0 / pnpm 11.24.0 `pnpm check` passes: 213 deterministic tests,
  23 Chromium scenarios, strict TypeScript, production build, build-output,
  architecture-boundary, and privacy checks all pass.
- Physical Redmi K60E and K70 Pro execution remains pending under Spec 043 and
  is not claimed.

## Protection and recovery

Preview: changes are limited to version-controlled card presentation,
public-group/result layout, browser-test tooling, acceptance tests, and
documentation. Generated build/test output and review images remain ignored.
Revert this plan's source, tests, runner/config, and documentation together if
the refinement regresses readability or browser-test reliability.
