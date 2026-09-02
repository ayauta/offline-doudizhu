# Execution Plan 005: Contextual Play Validation

Status: Completed

Started: 2026-09-02

Completed: 2026-09-02

Spec: `docs/specs/012-contextual-play-validation/spec.md`

## Goal

Add one pure rules seam for validating play/pass actions against a hand and
current play, using vertical red-green slices and without introducing the game
state machine or legal-action generation.

## Steps

1. [Completed] Review product, architecture, relevant ADRs, roadmap, Spec 010,
   current rules interfaces, and the requested architecture/TDD guidance.
2. [Completed] Resolve the Spec 012/021 roadmap overlap and approve the public
   `validatePlay(context, action)` test seam, validation precedence, stable
   errors, and non-goals.
3. [Completed] Add one failing public-seam test, implement only enough to
   pass, and repeat for lead, pass, ownership, response comparison, error
   passthrough, and immutability.
4. [Completed] Self-review depth, locality, dependency direction, error
   stability, determinism, privacy, and scope against the approved spec.
5. [Completed] Run the focused suite, strict typecheck, complete `pnpm check`,
   inspect the staged diff, move this plan to completed, and commit the slice.

## Evidence to record

- [x] The only new rules seam is `validatePlay`.
- [x] Every contextual and inherited classification error has a fixture.
- [x] Same-rank different-suit ownership cannot substitute a physical card.
- [x] Every non-higher comparison outcome is rejected.
- [x] Bomb/rocket rules are reused, not duplicated.
- [x] Inputs remain unchanged and outputs are frozen and serializable.
- [x] Node 24.20.0/pnpm 11.24.0 `pnpm check` passes: 95 Vitest tests,
      production/build-output checks, boundaries, privacy, and 7 Chromium tests.
- [x] No UI, game state, legal generator, dependency, or generated output is
      staged.

## Recovery

All feature changes are ordinary version-controlled text after baseline commit
`db1126d`. No remote, generated output, dependency, credential, or destructive
operation is part of this plan.
