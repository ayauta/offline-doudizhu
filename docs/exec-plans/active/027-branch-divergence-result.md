# Execution Plan 027: The Branch Changes the Move — and Costs Far Too Much

Status: Result only. Offline measurement; `src/` untouched.

Started: 2026-09-12

Depends on: `025-exact-endgame-feasibility.md` (device costs),
`026-endgame-exact-branch-design.md` (the design), and the solver verification
committed at `5fb8f5a`.

## What was measured

On the real master endgames captured from 20 deals, restricted to the band where
exactly **one opponent card is unknown** — 13.1% of master decisions — the branch
was asked to propose a move from the same belief the shipped sampler draws from,
and the proposal was compared with what the shipped master actually plays.

| | |
| --- | --- |
| positions in that band | 152 |
| compared against the shipped move | 140 |
| **diverged** | **78 (55.7%)** |
| mean nodes per decision | **67,273** |
| maximin and expected agreed on the same action | 37 of 140 |

## The two findings

**1. The branch is not a no-op.** 55.7% divergence is an order of magnitude above
anything this line of work has produced before. Spec 024's node-allowance change
was byte-identical; Spec 023's aggregation change moved 0.1% of decisions; Spec 054
found the two hand estimators differing on 3.88%. This changes the move most of the
time it is consulted. The question the design asked — does an exact endgame branch
matter — is answered yes.

**2. As prototyped, it cannot ship.** 67,273 nodes at the device-measured 238 µs
per node is about **16 seconds** per decision against a 480 ms window. Even
allowing that endgame nodes are cheaper than the average the 238 µs was measured
over, this is one to two orders of magnitude over budget. The threshold is not the
problem; the cost *inside* the threshold is.

The design's own note that the branch "is not obviously more expensive than what
it replaces" was wrong, and is corrected below.

## Why it costs so much, and what that implies

The prototype does the most expensive thing available: for every enumerated world
it solves the position **once per legal action at the root**, each solve starting
from scratch with no move ordering and no reuse. Cost is
`worlds x rootActions x nodesPerSolve`, and the middle factor is large precisely
where the branch fires — only one card is unknown, so the acting seat may hold
several, giving several legal actions.

Two things follow.

- **The aggregate choice is load-bearing.** Maximin and expected chose different
  actions on 103 of 140 decisions. The conservative-versus-expected question the
  design flagged as "settle it by measurement" is not hypothetical; it decides the
  move most of the time.
- **The prototype is not the algorithm.** A real implementation would reuse one
  solve across the root actions rather than re-solving per action, order moves to
  cut the tree, and share sub-positions between neighbouring worlds — the worlds
  differ by a single card, so their subtrees overlap heavily. Whether that closes
  a 30x gap is unmeasured; it is the obvious next question.

## What is not claimed

- **Not that the branch is better.** Divergence is not improvement. The paired
  roll-forward that could say so has not been run, and cannot be run until the
  cost is tractable — a decision that takes 16 seconds cannot be rolled forward at
  any useful sample size.
- **Not that 67,273 nodes is the algorithm's cost.** It is this prototype's cost.
- **Not that maximin is right.** It differs from expected on most decisions; which
  of the two plays better is untested.

## Next, in dependency order

1. **Make one solve serve all root actions.** The current shape re-solves the same
   world once per action; that is pure duplication and the largest single saving
   available.
2. **Reuse across worlds.** Neighbouring worlds differ by one card, so their
   subtrees mostly coincide. A transposition table shared across the enumeration —
   not per solve, as now — is the published solvers' main accelerator.
3. **Re-measure cost and divergence** at that point. Only if the cost lands inside
   the device budget does the paired outcome step become possible.
