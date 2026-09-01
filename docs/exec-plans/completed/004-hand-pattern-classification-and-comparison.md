# Execution Plan 004: Hand-Pattern Classification and Comparison

Status: Completed

Started: 2026-09-02

Completed: 2026-09-02

Spec: `docs/specs/010-hand-pattern-classification-and-comparison/spec.md`

## Goal

Implement the complete project-owned 14-pattern classification and comparison
contract as pure TypeScript, starting from compatibility research and
executable table-driven tests.

## Steps

1. [Completed] Review product, architecture, pure-core ADR, card contract, and
   mature player/open-source compatibility references.
2. [Completed] Write the compatibility research and approved feature spec,
   resolving airplane, four-with-two, `2`, joker, bomb, and rocket boundaries.
3. [Completed] Add table-driven tests for every valid pattern, sequence
   boundary, invalid selection, mature rare case, normalization invariant, and
   comparison outcome before implementation.
4. [Completed] Implement the rank histogram, explicit classification predicates,
   immutable public result values, and comparison precedence.
5. [Completed] Run focused tests and strict typecheck, then self-review API,
   boundary direction, determinism, privacy, and third-party independence.
6. [Completed] Run `pnpm check`, record evidence, review the staged feature,
   and move this plan to completed for inclusion in
   `feat: add hand pattern classification and comparison`.

## Evidence to record

- [x] All 14 pattern kinds have valid fixtures.
- [x] Minimum/effective maximum sequence and ace boundaries pass.
- [x] All five stable classification error codes pass.
- [x] `33344455` passes and `333444555777` fails.
- [x] Pair-wing, second-bomb, `2`, individual-joker, and rocket-attachment
  boundaries pass.
- [x] Input order, suit, canonical ordering, and non-mutation invariants pass.
- [x] Comparison kind/length reasons plus bomb/rocket precedence pass.
- [x] Strict typecheck, 79 unit tests, production build, boundaries, privacy, and
  existing Chromium acceptance pass.
- [x] No dependency, runtime network capability, copied code, lookup table, or
  generated output is staged.

## Recovery

All changes after baseline commit `9e2d151` are ordinary version-controlled
text changes. Keep the migration recovery backup intact. Do not rename the
physical working directory, create a remote, or push under this plan.
