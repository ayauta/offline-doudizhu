# Execution Plan 007: Bidding and Deal State

Status: Completed

Started: 2026-09-02

Completed: 2026-09-02

Spec: `docs/specs/020-bidding-and-deal-state/spec.md`

## Goal

Add the first deep `core/game` module behind the accepted command/transition
seam, covering only deterministic dealing and simplified landlord bidding.

## Steps

1. [Completed] Review product, architecture, ADRs 0002/0004/0005, roadmap,
   card/shuffle contracts, the requested architecture vocabulary, and TDD
   public-seam guidance.
2. [Completed] Approve seats, phases, explicit shuffled-deck input,
   round-robin distribution, bid transitions, events, errors, invariants, and
   Spec 021/030 stop lines in Spec 020.
3. [Completed] Add one failing `core/game` public-seam fixture and implement
   only enough for each deal and bidding vertical slice.
4. [Completed] Self-review module depth, locality, immutable-state correctness,
   card conservation, replayability, and later Spec 021 leverage.
5. [Completed] Run the complete project-local quality gate, inspect staged scope,
   move this plan to completed, and commit Spec 020 independently.

## Evidence to record

- [x] Deal stores sorted 17/17/17 hands plus three bottom cards with exact
      conservation and no input aliasing.
- [x] Human, `ai-one`, and `ai-two` call paths assign the landlord and bottom
      cards correctly.
- [x] All-pass emits ordered decline/redeal events and accepts a fresh deal.
- [x] Wrong phase, wrong bidder, and every invalid-deck class preserve the
      exact input state with stable errors.
- [x] States, results, errors, events, and nested collections are frozen,
      deterministic, serializable, and non-mutating.
- [x] Node 24.20.0/pnpm 11.24.0 `pnpm check` passes: 147 Vitest tests,
      production/build-output checks, boundaries, privacy, and 7 Chromium tests.
- [x] No play state machine, AI strategy, UI, persistence, dependency, or
      generated output is staged.

## Recovery

All feature changes are ordinary version-controlled text after baseline commit
`dd54516`. No remote, dependency, generated output, credential, or destructive
operation is part of this plan.
