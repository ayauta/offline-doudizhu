# Execution Plan 022: AI Divergence Diagnosis

Status: Completed

Started: 2026-09-12

Completed: 2026-09-12

Spec: `docs/specs/054-ai-divergence-diagnosis/spec.md`

## Goal

Stop measuring aggregates and find where the enhanced AI's hand estimate changes
the move. Sample the positions where the shipped estimator and the archived
candidate's estimator choose differently, classify them by board state, and ask
which action wins more often from that same position — without changing anything
the player sees.

## Steps

1. [x] Build the candidate arm by generating a shadow tree from the real source
   bytes rather than hand-copying an implementation, and guard the generation.
2. [x] Prove the two arms are independently verified to agree with the real code,
   and that the candidate arm carries the archived candidate's semantics.
3. [x] Prove the premise: some input must make the two arms differ, or there is
   nothing to diagnose.
4. [x] Probe 20 deals to measure the divergence rate and its distribution by hand
   size and legal-action count, and fix the harvest size from that.
5. [x] Harvest 200 deals, recording a replayable command prefix at every
   strong-seat decision.
6. [x] Freeze the category thresholds before inspecting outcomes, and classify.
7. [x] Roll forward every divergence from its frozen position under the shipped
   continuation, paired by deal, with per-category intervals.
8. [x] Record the negative result for the two categories the candidate cannot
   reach, and propose one next experiment without running it.
9. [x] Verify `src/` is untouched, `pnpm check` passes, and the bundle budgets are
   byte-identical.

## Guard evidence — each guard was proven red before it was trusted

| Guard | Injected regression | Result |
| --- | --- | --- |
| Generator: two patch sites | (found for real) an implementation that replaced only the first occurrence left `let best = estimateBasicHandTurns(hand)` in the generated file — a half-candidate | ✅ red: the generated file kept one shipped call site |
| Generator: anchor counts | malformed sources with a missing anchor, a duplicated anchor, and one and three call sites | ✅ red: refused to patch, naming the anchor and the count |
| Generator: import rewrite | a source whose analyzer import is not the expected shape | ✅ red: `occurs 0 times, expected 1` |
| Premise: the arms differ | the candidate arm built without the patch (`body = original`) | ✅ red: `3334445 must differ for the diagnosis to have an object` |
| Replay fidelity | every one of the 492 harvested positions rebuilt from its command prefix and compared against the frozen public view | ✅ 492/492 verified; a failure would fail the test |

The first row is the guard doing real work: hand-written and generator code alike
had a bug where only the first of two call sites was replaced, which would have
produced a candidate arm almost identical to the shipped one and made the entire
diagnosis meaningless.

## Completion evidence

- Probe (20 deals): 1,255 decisions, 38 divergences (3.03%). Zero divergences in
  328 decisions on hands of ≤ 7 cards; 25.0% at 20 cards.
- Harvest (200 deals, seeds 301–500): 12,694 decisions, 492 divergences (3.88%),
  0.40 s/deal. Divergence by legal-action count rises monotonically from 0.0% at
  1 action to 12.6% at 9.
- Estimate accuracy over 8,026 decisions on hands of ≤ 12 cards against an
  independent exhaustive oracle: shipped estimate below truth in 1,147 (14.3%),
  candidate estimate different from truth in 95 (1.2%), always upward.
- Roll-forward (492 divergences, 166 distinct deals, 94.6 s): candidate action
  44.1% vs shipped action 39.8% under the shipped continuation; paired per-deal
  difference **+5.1 pp, deal-clustered 95% CI [−0.2, +10.3]**.
- Per category: `endgame-low-cards` **0.0 pp** over 5 deals;
  `farmer-partner-nearly-out` **0.0 pp** over 10 deals; `breaks-control`
  +5.7 pp over 82 deals [−5.0, +16.5]; `opening-twenty-cards` +3.8 pp over 65
  deals [−4.6, +12.3]; `midgame-other` +4.3 pp over 123 deals [−2.2, +10.9].
- **Negative result recorded**: the candidate cannot reach the endgame or
  farmer-cooperation categories, for a mechanism reason, not a sampling reason —
  at the per-candidate node allowance an endgame hand is solved exactly, and an
  exact answer does not depend on the search's starting bound.
- `src/**` unchanged: `git diff src/` is empty. `pnpm typecheck` clean;
  `pnpm test` 265/265.

## Commands

```bash
source scripts/activate-toolchain.sh
pnpm harvest:ai                      # probe: 20 deals, distribution tables
AI_DIAG_DEALS=200 pnpm harvest:ai    # probe at scale
AI_DIAG_DEALS=200 AI_DIAG_SECONDS=1200 pnpm harvest:ai -t 'rolls forward'
```

## Recovery

Everything this plan added lives under `benchmarks/diagnosis/` plus the harvest
vitest config. No production file, test, dependency, fixture, or delivered
artifact changed; deleting the two additions restores the previous state exactly.
The generated `.local/harvest/gen/` tree is gitignored and regenerated on demand.
No validation seeds were consumed.
