# Execution Plan 006: Legal Action Generation

Status: Completed

Started: 2026-09-02

Completed: 2026-09-02

Spec: `docs/specs/013-legal-action-generation/spec.md`

## Goal

Add one complete, deterministic, deduplicated rules seam for hints, AI, and
later game validation without introducing strategy or game state.

## Steps

1. [Completed] Review product, architecture, ADR 0005, Specs 010/012, current
   rules interfaces, research boundaries, and the project-local toolchain.
2. [Completed] Fix the public seam, semantic deduplication, canonical physical
   representatives, pass behavior, ordering, structural constraints, and
   non-goals in Spec 013.
3. [Completed] Add table-driven failing tests and implement vertical slices
   for basic patterns, sequences, attachments, response filtering, and result
   invariants.
4. [Completed] Cross-check bounded representative hands against an independent
   brute-force test oracle and self-review completeness, locality, leverage,
   determinism, and performance shape.
5. [Completed] Run the project-local full quality gate, inspect staged scope,
   move this plan to completed, and commit Spec 013 independently.

## Evidence to record

- [x] All 14 pattern kinds have generated fixtures.
- [x] Sequence windows and effective maximums are complete.
- [x] Attachment combinations match Spec 010 rare-case decisions.
- [x] Suit-equivalent physical choices collapse to one canonical action.
- [x] Responses contain every beating play and exactly one pass.
- [x] Bounded brute-force oracle comparisons match across four representative
      lead/response hands of at most twelve cards.
- [x] Results are unique, ordered, frozen, serializable, and non-mutating.
- [x] Node 24.20.0/pnpm 11.24.0 `pnpm check` passes: 131 Vitest tests,
      production/build-output checks, boundaries, privacy, and 7 Chromium tests.
- [x] No strategy, game state, UI, dependency, lookup table, or generated output
      is staged.

## Recovery

All feature changes are ordinary version-controlled text after baseline commit
`10a02c6`. No remote, dependency, generated output, credential, or destructive
operation is part of this plan.
