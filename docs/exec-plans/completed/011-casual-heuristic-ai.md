# Execution Plan 011: Casual Heuristic AI

Status: Completed

Started: 2026-09-03

Completed: 2026-09-03

Spec: `docs/specs/031-casual-heuristic-ai/spec.md`

## Goal

Deliver one deterministic, role-aware casual strategy over the existing
redacted/legal AI contract, with measured bidding flow and clear improvement
over the first-legal-action baseline.

## Steps

1. [Completed] Review the approved product/architecture boundaries, ADRs
   0002/0004/0005, Specs 013/020/021/022/030, current AI/rules/game seams, and
   reference-only heuristic/search research.
2. [Completed] Agree the casual experience, deterministic behavior, rare
   all-pass target, team fairness, later difficulty/search boundary, hint reuse,
   evaluation method, and Spec 031 stop line with the product owner.
3. [Completed] Synchronize current project documentation and add failing
   bidding, ranking, cooperation, restraint, determinism, corpus, and tournament
   tests through public seams.
4. [Completed] Implement the smallest cohesive casual evaluator and strategy,
   calibrate visible bidding thresholds, and preserve all redaction/safety
   contracts.
5. [Completed] Run representative complete games and paired fixed-deck evaluation;
   self-review fairness, determinism, termination, module depth, performance,
   provenance, boundaries, and privacy.
6. [Completed] Run the complete project-local quality gate, inspect staged scope,
   move this plan to completed, and commit Spec 031 independently.

## Evidence to record

- [x] Strong/poor/last-bidder fixtures pass. Across 10,000 deterministic
      shuffled decks after a human decline, `ai-one` calls 4,203 times,
      `ai-two` calls 5,725 times, and 72 all-pass redeals produce a 0.72% rate.
- [x] Ranked actions preserve engine legality, completeness, input identity,
      freezing, and deterministic tie order.
- [x] Play fixtures cover completion, structure, low-cost response, resource
      restraint, public endgame pressure, and symmetric farmer cooperation.
- [x] In paired fixed-deck evaluation, the casual side wins 29/36 landlord
      games and 33/36 farmer games against the first-legal baseline. Three
      additional fixed games finish within 256 commands with both AI seats
      acting.
- [x] Node 24.20.0/pnpm 11.24.0 `pnpm check` passes: 197 Vitest tests,
      strict TypeScript, production/build-output, boundaries, privacy, and 7
      Chromium tests.
- [x] No search, model, dependency, UI, persistence, generated output, private
      data, or runtime network capability is staged.

## Recovery

All changes are ordinary version-controlled text after baseline commit
`64324c6`. No remote mutation, dependency installation, credential, generated
asset, or destructive operation is part of this plan.
