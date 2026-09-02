# Execution Plan 009: Game Result and Restart

Status: Completed

Started: 2026-09-02

Completed: 2026-09-02

Spec: `docs/specs/022-game-result-and-restart/spec.md`

## Goal

Add presentation-ready landlord/farmer outcome data and one deterministic
finished-round restart command behind the existing deep game transition seam.

## Steps

1. [Completed] Review product settlement rules, Specs 020/021, current finished
   state/event, and the explicit-randomness boundary.
2. [Completed] Approve result vocabulary, the four human outcome mappings,
   restart behavior, event shape, errors, and non-goals in Spec 022.
3. [Completed] Add failing public-transition outcome/restart fixtures and
   implement one vertical slice at a time.
4. [Completed] Self-review derivation correctness, state cleanup, immutability,
   and separation from AI/UI/persistence.
5. [Completed] Run the complete project-local quality gate, inspect staged scope,
   move this plan to completed, and commit Spec 022 independently.

## Evidence to record

- [x] All landlord/farmer and human role/outcome mappings are explicit.
- [x] Finished state and event expose the same frozen result.
- [x] Restart clears the round and accepts a separately supplied fresh deal.
- [x] Wrong-phase restart retains the identical input state.
- [x] Node 24.20.0/pnpm 11.24.0 `pnpm check` passes: 166 Vitest tests,
      production/build-output checks, boundaries, privacy, and 7 Chromium tests.
- [x] No score, statistic, AI, UI, persistence, dependency, or generated output
      is staged.

## Recovery

All feature changes are ordinary version-controlled text after baseline commit
`4759cb8`. No remote, dependency, generated output, credential, or destructive
operation is part of this plan.
