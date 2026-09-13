# Execution Plan 028: The Exact Branch Verdict — Right Direction, Unaffordable

Status: Closed. Offline measurement only; `src/` untouched.

Started: 2026-09-12

Depends on: `027-branch-divergence-result.md` and the solver verification at
`5fb8f5a`.

## What was done

Spec 027 found the branch changing the move 55.7% of the time at 67,273 nodes per
decision. Two optimisations followed, each with an equivalence check before it was
trusted:

1. **One search serving every root action.** The prototype solved each root action
   from scratch; the root's options share almost all of their subtree. One table
   over the whole root amortises it. Verified against solving each action
   separately: 300 positions, 501 root actions, 0 failures.
2. **One transposition table across the enumerated worlds.** Neighbouring worlds
   differ by a single card, so their subtrees largely coincide. Verified against
   per-world tables: 7 positions, 0 failures.

Together they cut the mean from 67,273 to 43,088 nodes — **36%, not the 30x that
was needed.**

## The band measurement, and what it settles

The remaining hope was that cost is concentrated in a few expensive positions, so
a threshold on unknown cards could carve out a cheap, useful band. Measured over
20 deals, by the number of unknown opponent cards:

| Unknown cards | Compared | Diverged | Mean nodes | Device cost |
| --- | --- | --- | --- | --- |
| 1 | 138 | 76 (55%) | 43,088 | ~10.3 s |
| 2 | 59 | 37 (63%) | 77,672 | ~18.5 s |
| 3 | 21 | 13 (62%) | 93,652 | ~22.3 s |

Two things are settled.

**The branch genuinely changes play, in every band.** Divergence runs 55–63% and
does not decay with the size of the unknown. This is not an artefact of the
cheapest band. Against this line's history — Spec 024 byte-identical, Spec 023
0.1%, Spec 054 3.88% — an exact endgame search is the first thing found that
changes the move most of the time.

**And it is uniformly unaffordable.** There is no cheap band to carve out: even
one unknown card costs ~10 s on the target device against a 480 ms window, twenty
times over. Cost rises with the unknown but stays two orders of magnitude above
budget throughout, so a threshold cannot rescue it.

## Verdict

**The exact endgame branch is the right direction and is not affordable.** The
distinction matters: this is not a lever that failed like the anchor, the rollout
weight, the hand estimate, the win-distance shape or the node allowance. Those
were wrong or inert. This one works — it changes the move, verifiably and often —
and costs far more than the device can pay.

It therefore belongs in the same category as a future-hardware or offline-analysis
option, not in the same category as a rejected idea.

## What is not claimed

- **That the branch is better.** Divergence is not improvement, and the paired
  outcome step was never reached.
- **That 43,088 nodes is the algorithm's cost.** It is this prototype's, after two
  optimisations. A genuine implementation would order moves, bound and prune the
  tree, and share more aggressively — but the prototype already amortises the root
  and the enumeration, so the surviving factor is the search tree itself, which is
  the solver's own complexity rather than bookkeeping.
- **That the bands are representative.** Positions with few unknown cards cluster
  early, and the sample above three unknowns is small (21 positions), so the
  shape of the curve is indicative rather than precise.
- **That maximin is the right aggregate.** It disagreed with expected on most
  decisions, and nothing here tests which plays better.

## Recovery

Everything added is under `benchmarks/diagnosis/` plus throwaway tooling in
`.local/`. No production file, test, dependency, fixture or delivered artifact
changed. Deleting those restores the previous state exactly.
