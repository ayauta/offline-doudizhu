# Execution Plan 010: Legal Baseline AI and Safety Contract

Status: Completed

Started: 2026-09-03

Completed: 2026-09-03

Spec: `docs/specs/030-legal-baseline-ai/spec.md`

## Goal

Add one redacted, deterministic, engine-validated baseline AI module that can
drive both local computer seats and terminate complete rounds.

## Steps

1. [Completed] Review product AI requirements, ADR 0005, Specs 013/020/021/022,
   game/rules public seams, dependency direction, and privacy constraints.
2. [Completed] Approve redacted views, decision contexts, baseline policy,
   safety result/errors, bounded termination argument, and Spec 031 stop line.
3. [Completed] Add failing public-seam tests and implement view, baseline
   decision, and safety wrapper in vertical slices.
4. [Completed] Drive representative full games, self-review hidden-information
   exposure, legality authority, termination, determinism, and module depth.
5. [Completed] Run the complete project-local quality gate, inspect staged scope,
   move this plan to completed, and commit Spec 030 independently.

## Evidence to record

- [x] Bidding and playing views expose own/public data only and copy/freeze it.
- [x] The baseline strategy produces deterministic own-seat ordinary commands.
- [x] Every strategy command is accepted or rejected through `transition`.
- [x] Illegal, spoofed, malformed, and throwing strategies preserve state.
- [x] Canonical, reversed, and rotated 54-card games terminate within 256
      play/pass commands, with both AI seats acting in every game.
- [x] Node 24.20.0/pnpm 11.24.0 `pnpm check` passes: 182 Vitest tests,
      production/build-output checks, boundaries, privacy, and 7 Chromium tests.
- [x] No heuristic strategy, UI, persistence, dependency, or generated output
      is staged.

## Recovery

All feature changes are ordinary version-controlled text after baseline commit
`01da5d1`. No remote, dependency, generated output, credential, or destructive
operation is part of this plan.
