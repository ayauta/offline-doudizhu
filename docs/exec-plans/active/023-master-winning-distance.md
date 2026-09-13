# Execution Plan 023: Master Rollout Winning Distance

Status: Completed — rejected by the pre-registered rule; shipped behaviour restored

Started: 2026-09-12

Spec: none yet — this plan pre-registers its own decision rule. If adopted, it
folds into the tier-separation line of `docs/specs/052-ai-strength-evaluation/spec.md`.

## Why

The master's rollout scores a position with
`(enemyTurns − friendlyTurns) * 220 + (enemyCards − friendlyCards) * 24`
(`src/core/ai/master-policy.ts:229`). `friendlyTurns` **sums** both farmers'
estimated remaining plays. A farmer camp wins as soon as *either* farmer runs
out, so the camp's distance to winning is the **minimum** of the two, not their
sum. When one farmer is nearly out and the other is not, the sum hides exactly
the urgency the search needs to see.

This is the concern the follow-up handoff §3 already recorded ("a farmer near
finishing with a partner holding many cards can be masked by the sum"), and it
is the shape the winning-distance reward in PerfectDou (NeurIPS 2022) uses:
`Adv = N_landlord − min(N_farmer1, N_farmer2)`. Their ablation (RewardlessDou)
shows that node reward is load-bearing, so its shape is worth correcting.

Note the landlord side is a **singleton**: `sum` and `min` coincide there. So
"take the minimum over each side" has the same value as the shipped code for a
landlord root and changes only the farmer side. That is what makes this a clean
one-variable change rather than a redesign.

This is **not** a re-run of either rejected experiment. Spec 052 rejected moving
the rollout's *weight* and Spec 053 rejected changing the hand estimate. This
changes the *shape of the utility function* — a term that is currently, on
inspection, computed wrongly for the farmer camp.

## Pre-registered decision rule (written before any measurement)

**One variable.** `friendlyTurns`/`enemyTurns` change from sum-over-side to
min-over-side. Nothing else moves: no weight rescaling, no rollout depth, no
node allowance, no sample count, no hand-estimate change.

**Primary metric.** `expert → master` over the same completed deals, paired
per deal, on discovery seeds 301–700. `casual → default` is the unchanged
control and must stay byte-identical.

**Adopt if and only if** the paired 95% interval's lower bound for
`expert → master` is **above zero** on discovery seeds, **and** the same
direction holds on the reserved validation seeds 10001–10400, **and**
`pnpm check` passes, **and** the worker gzip budget still fits.

**Reject otherwise**, roll the change back, and record the negative result. A
rejection is a real answer, not a failure: it would say the sum was not the
problem, and would close the winning-distance shape as a lever.

**Also reported, never used as the criterion:** per-arm splits (master as
landlord / as farmer), whether master's advantage over expert survives, and
whether expert is dragged down (master's shortlist comes from expert's ranking).

## Steps

1. [x] Record the shipped baseline on discovery seeds.
2. [x] Change only the turn aggregation in `rootUtility`.
3. [x] Build a research-side sum stub (`benchmarks/diagnosis/master-flip.ts`) that
   reimplements only the rollout and the blend, calls the real exported functions
   everywhere else, and so differs from production in exactly one respect. It
   serves both as the flip measurement and as the reproducible evidence a guard
   would rest on.
4. [x] Re-run the identical configuration and compare per deal.
5. [x] **Reject the change and restore the shipped behaviour.** The criterion was
   not met.

## Completion evidence

**The change moves master's move in 0.1% of decisions.** Over 739 master
decisions across 12 deals, the shortest-distance aggregation chose a different
action exactly once (1/739), and that one case was a farmer root — the situation
the change exists for. In that position the shipped sum chose a five-card
straight (`4,5,6,7,8`) while the shortest-distance form chose to pass, on a hand
of 17 cards with a partner holding few.

**Re-running the pre-registered experiment produced byte-identical results.**

| Pairing | Baseline | Shortest-distance | Paired Δ |
| --- | --- | --- | --- |
| `default → expert` | 50.083% (1202/2400) | 50.083% (1202/2400) | **0.0000 pp** |
| `casual → default` (control) | 45.250% (1086/2400) | 45.250% (1086/2400) | 0.0000 pp |

All four per-deal arrays (`perDealA` and `perDealB` for both pairings, 1600
values) are **identical value for value**, with zero deals showing any
difference. This is a much stronger statement than "not statistically
significant": on this schedule the correction changed no game outcome at all.

**Why the criterion could not have been met.** The flip rate bounds the result
before any tournament runs: a move that changes on 0.1% of master decisions
cannot move a 2400-game win rate by an amount any feasible experiment could
resolve.

**A measurement caveat that surfaced while checking this** — and it matters for
reading `docs/specs/053-ai-hand-planning/spec.md`:

> Two independent runs of **the same shipped code** with **the same
> configuration** (400 deals, seeds 301–700) produced per-deal arrays differing
> on 163/400 deals (arm A) and 167/400 (arm B), and pooled rates of 49.625%
> versus 50.083% — a **0.458 pp** gap from nothing but run-to-run variation,
> almost certainly the wall-clock truncation path (`shouldStop`), which is not
> strictly deterministic.

So the run-to-run resolution of this harness is roughly ±0.5 pp. The 053
candidate's +0.75 pp is near that floor and its interval crossed zero; this plan
does not attempt to re-litigate 053, but no adoption decision should rest on a
difference smaller than this floor. The baseline JSON in this directory is
reported as the number this experiment compared against, not as a reproduction
of 053's published 49.625%.

## Commands

```bash
source scripts/activate-toolchain.sh
AI_ARM_LABEL=baseline AI_ARM_SEED=301 AI_ARM_DEALS=400 AI_ARM_SECONDS=180 \
  AI_ARM_PAIRS=default:expert,casual:default AI_ARM_OUT=.../023-baseline.json \
  pnpm harvest:ai -t 'arm run'
AI_FLIP_DEALS=12 pnpm harvest:ai -t 'aggregation flip'
```

## Decided next (not this plan)

The aggregation shape is closed as a lever: it cannot flip enough decisions to
be measurable. The remaining lever supported by the Spec 054 diagnosis is the
**per-candidate analyzer allowance** (`220` in `decideEnhancedAi`, and master's
`rootAnalyzerNodes`), which the diagnosis showed is what stops the endgame from
being solved exactly. That changes the fraction of decisions the search can
affect by orders of magnitude more than an aggregation shape does.

## Recovery

One function in one pure-TypeScript module. Reverting the change restores the
shipped behaviour exactly. No dependency, fixture, persisted format, or
delivered artifact changes. No validation seeds are consumed unless the
discovery criterion passes.
