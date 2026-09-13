# Execution Plan 024: Give the Rollout's Policy Enough Nodes to Search

Status: Completed — rejected by the pre-registered rule; shipped behaviour restored

Started: 2026-09-12

Spec: none yet — this plan pre-registers its own decision rule. If adopted it
folds into the tier-separation line of
`docs/specs/052-ai-strength-evaluation/spec.md`.

## Why

Master's rollout plays the continuation with
`rankScoredPlayActions(context, "expert", { analyzerNodes: 8 })`
(`src/core/ai/master-policy.ts:243`). The allowance is split across candidates:
`floor(8 / legalActionCount)` nodes each (`src/core/ai/scoring-policy.ts:201`).
A position with 8 or more legal actions therefore gets **one node per candidate**,
and at one node the bounded search returns its initial bound without descending.
The policy master's rollout imagines for its opponents is not searching at all —
it is the raw fast heuristic.

This explains the rejected experiment in Spec 052. Raising the rollout's blend
weight from 0.2 to 2.0 made play *worse*, and the recorded interpretation was
"letting a component dominate degrades play". The mechanism offered here is
sharper: the experiment amplified a component that was not evaluating anything.
Giving it nodes is the variable that was never tested.

Compare the three allowances in the shipped handler:

| Path | Total | Per candidate (≈10 legal actions) |
| --- | --- | --- |
| Expert play | 220 | ~22 nodes — actually searches |
| Master shortlist | 220 | ~73 nodes (3 candidates) |
| **Rollout policy** | **8** | **~1 node — does not search** |

## Pre-registered decision rule (written before any measurement)

**One variable.** The rollout's analyzer allowance, `analyzerNodes: 8` at
`master-policy.ts:243`, becomes `32`. Nothing else moves: not the blend weight,
not `maxWorlds`, not `rolloutDepth`, not `rootAnalyzerNodes`, not the expert
allowance, not any scoring weight.

**Primary metric.** `default → expert` over the same completed deals, paired per
deal, discovery seeds 301–700, against the baseline measured in the same session
at `.local/harvest/023-baseline.json` (referred to here as the 023 baseline).
`casual → default` is the unchanged control.

**Adopt if and only if** the paired 95% interval's lower bound for
`default → expert` is **above zero**, **and** the same direction holds on the
reserved validation seeds 10001–10400, **and** master's p99 decision time still
fits its 120 ms budget with a truncation rate no worse than the 13.3% baseline,
**and** `pnpm check` passes with the worker gzip budget intact.

**Reject otherwise** and roll back. A rejection closes "give the rollout policy
more nodes" as a lever.

**Also reported, never used as the criterion:** per-arm splits, master's win rate
against expert, the truncation rate change, and whether expert is dragged down.

## Steps

1. [x] Change the one allowance and nothing else.
2. [x] Re-run the identical configuration; report paired per-deal differences and
   the truncation change.
3. [x] **Reject and restore the shipped behaviour.** The criterion was not met.

## Completion evidence

The change is a no-op, confirmed twice over:

| Pairing | Baseline (8 nodes) | Rollout at 32 nodes | Paired Δ |
| --- | --- | --- | --- |
| `default → expert` | 50.083% (1202/2400) | 50.083% (1202/2400) | **0.0000 pp** |
| `casual → default` (control) | 45.250% (1086/2400) | 45.250% (1086/2400) | 0.0000 pp |

All four per-deal arrays are identical value for value; neither run stopped early;
the pairing's wall-clock was unchanged (104.7 s → 105.2 s, +0.4%, i.e. no more
work was done).

An independent check with the Spec 023 comparison stub — which plays the rollout
at the shipped 8 nodes while production ran at 32 — found the master's chosen move
identical on **all 739 master decisions** across 12 deals. So the no-op is a
property of the algorithm, not of the measurement.

**Why it is a no-op, and what that means.** `floor(N / legalActions)` collapses to
one node per candidate whenever a position exposes eight or more legal actions, so
the rollout's policy returns its initial bound without descending — it is the raw
`estimateBasicHandTurns` heuristic wearing the expert ranker's clothes. At the
rollout's own plies the hands are short, and at short hands that heuristic is
already exact (Spec 054 measured the bounded analyzer as exact for every hand of
seven cards or fewer). Raising the allowance from 8 to 32 therefore replaces an
exact value with the same exact value, and the rollout does not move.

**The two node-allowance experiments in this session both came back byte-identical
— Spec 023 at the win-distance shape and Spec 024 at the rollout allowance.** They
share one cause: the rollout's *value function* is already exact where it is
asked to work, so its search depth and its aggregation shape cannot matter. The
binding constraint is not search effort inside the rollout. It is that a
1-node-policy can only ever be as good as its one-ply heuristic, and making that
heuristic exact changed nothing because it already was.

**Consequence for the next step.** Levers that redistribute nodes among candidates
(`floor(N/legalActions)` with a larger `N`, more worlds, more plies) are the wrong
family: the arithmetic shows they buy depth only in the positions that need it
least. The families that remain are the ones that change what the rollout *knows*
rather than how far it looks: a transposition table shared across candidates and
plies so that repeated sub-positions are not recomputed (the published endgame
solvers' main accelerator — `xioxiongzzz/doudizhu_endgame` regenerates rather
than re-searches precisely because memoisation carries the cost), belief-weighted
determinization instead of uniform sampling, and revisiting `maxWorlds` **only
after** the per-candidate collapse is fixed.

## Recovery

One numeric literal in one pure-TypeScript module. Reverting restores the
shipped behaviour exactly. No dependency, fixture, or delivered artifact changes.
Validation seeds are consumed only if the discovery criterion passes.
