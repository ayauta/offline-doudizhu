# Execution Plan 020: AI Delivery and Selector Refinement

Status: Completed

Started: 2026-09-11

Completed: 2026-09-11

Spec: `docs/specs/051-ai-difficulty/spec.md`

## Goal

Turn the observed enhanced-AI cold-start and fallback defects into enforced
architecture properties while replacing the oversized computer-level sheet
with the approved inline segmented control.

## Steps

1. [x] Record the agreed match-level versus turn-level fallback semantics,
   runtime-entry ownership, experience budgets, and inline selector contract in
   ADR 0016, Spec 051, and `CONTEXT.md`.
2. [x] Add failing deterministic tests for explicit failure meaning,
   match-scoped degradation and next-match retry, no speculative fallback, and
   a deep runtime import-closure check.
3. [x] Deepen enhanced-turn lifecycle ownership in the application module and
   keep the Web Worker adapter limited to platform facts.
4. [x] Add build gzip budgets and a deterministic delayed Worker asset browser
   scenario without adding a dependency or flaky wall-clock assertion.
5. [x] Replace the home sheet with an inline four-segment selector and update
   reduced-motion, narrow-landscape, accessibility, and persistence acceptance.
6. [x] Run focused checks, the complete `pnpm check`, production/browser visual
   review at 640×340 and 1366×768, self-review, and commit.

## Findings that changed the plan

- TypeScript 7 ships the native compiler and no longer exposes the classic
  `ts.createSourceFile` text parser, so the runtime closure scanner is
  hand-written rather than compiler-backed.
- Under `verbatimModuleSyntax`, `import { type X } from "m"` still evaluates
  `m` (`import {} from "m"`); only `import type` is elided. The original
  implementation treated those as type-only edges, which left the gate blind to
  exactly the leak it exists to catch.
- `page.route` never intercepts a Dedicated Worker script request, so the
  original delayed-asset scenario injected nothing and could not fail. The
  interception must be installed with `context.route`.
- A negative property that only holds over time cannot be asserted as a single
  snapshot: the notice shows at the presentation beat and fades 2.2 s later, so
  an assertion taken after the bottom cards are revealed passed even while the
  notice was being shown. The browser tests now observe the feedback element
  for the whole scenario.
- The exported budget numbers are anchored to measurements: one enhanced module
  on the main entry costs 2 587 B gzip, and the removed computer-level sheet
  cost 1 200 B.

## Recovery

All changes are version-controlled text. Default AI and synchronous hints stay
on their existing paths. Removing the enhanced-turn module wiring restores
the preceding runtime behavior; no stored preference format changes.
