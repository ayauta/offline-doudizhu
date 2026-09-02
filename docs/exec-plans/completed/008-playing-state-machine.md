# Execution Plan 008: Playing State Machine

Status: Completed

Started: 2026-09-02

Completed: 2026-09-02

Spec: `docs/specs/021-playing-state-machine/spec.md`

## Goal

Deepen the existing `core/game` command/transition module through deterministic
play, pass, trick reset, history, hand removal, and winner detection without
adding outcome presentation or AI strategy.

## Steps

1. [Completed] Review Specs 012/013/020, current game/rules interfaces, product
   flow, architecture, and the accepted command/transition ADR.
2. [Completed] Approve play/pass commands, playing/finished states, history,
   event order, validation reuse, reset rules, errors, invariants, and the Spec
   022/030 stop lines in Spec 021.
3. [Completed] Add one failing public-transition fixture and implement only
   enough for each play, response, pass/reset, and finish vertical slice.
4. [Completed] Self-review locality, rule reuse, turn invariants, conservation,
   immutability, replayability, and external-command completeness.
5. [Completed] Run the complete project-local quality gate, inspect staged scope,
   move this plan to completed, and commit Spec 021 independently.

## Evidence to record

- [x] Every accepted play is normalized by Spec 012 and removes exact physical
      cards only from the acting hand.
- [x] Rotation, response replacement, first pass, two-pass clearing, and
      mandatory new lead match the three-seat rules.
- [x] Public history and event order contain every accepted action without
      hidden cards or nondeterministic metadata.
- [x] A legitimate 54-card deal produces a final legal 20-card play, one winner,
      ordered finish events, and rejection of later commands.
- [x] All turn/rule failures retain the exact original state and stable error.
- [x] Results remain deterministic, deeply frozen, serializable, conserving,
      and non-mutating.
- [x] Node 24.20.0/pnpm 11.24.0 `pnpm check` passes: 161 Vitest tests,
      production/build-output checks, boundaries, privacy, and 7 Chromium tests.
- [x] No result presentation, AI strategy, UI, persistence, dependency, or
      generated output is staged.

## Recovery

All feature changes are ordinary version-controlled text after baseline commit
`a12ce8a`. No remote, dependency, generated output, credential, or destructive
operation is part of this plan.
