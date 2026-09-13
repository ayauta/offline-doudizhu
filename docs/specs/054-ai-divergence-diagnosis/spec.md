# Spec 054: Where the Enhanced AI's Hand Estimate Changes the Move

Status: Diagnosis complete; no behaviour change proposed for adoption this round

Date: 2026-09-12

## Why this exists

Spec 052 showed the four levels are not distinct, and Spec 053 showed the one
candidate estimator fix moved `default → expert` from 49.625% to 50.375% — a
paired interval of [−0.167, +1.708] points that establishes nothing. Both
results are aggregates. Neither says *where* the enhanced AI's hand estimate
changes what it plays, and the failed experiments closed off weight tuning
without answering that.

This spec answers it by refusing to measure another aggregate. It finds the
positions where the shipped estimator and the archived candidate's estimator
make the AI **choose different actions**, classifies those positions by board
state, and asks which of the two actions wins more often from that exact state.

The archived candidate is a probe, not a proposal. It is the concrete, measured
instance of "correct the remaining-play estimate"; what it can and cannot reach
tells us about the mechanism, not about one patch.

## Hard constraints

- `src/**` is unchanged: `git diff src/` is empty, the three gzip budgets are
  byte-identical, and the 480 ms window, the 520 ms beat, single-Worker
  isolation, and silent degradation are untouched.
- The Default level, its initial selection, its hints, and the four selector
  options are unchanged.
- No neural network, no hidden-hand access, no deliberate mistakes, no dependency
  or network capability.
- No alignment, weight, or depth change; the archived candidate is not re-applied
  to the product tree and its rejected experiment design is not re-run.
- Profiled (untimed) probes are reported separately from shipped-clock strength.
- Every new guard was proven to fail on an injected regression before it was
  trusted (see `docs/exec-plans/active/022-ai-divergence-diagnosis.md`).

## The question, and what the answer may claim

> Among positions the shipped strong seat actually reached, where the two
> estimators choose different actions, which action wins more often from that
> same position under the shipped continuation policy?

That is a **paired, crossover, conditional** quantity. It is **not** an estimate
of the shipped win-rate change: the positions are sampled on the shipped
trajectory (_on-policy_ selection), so the candidate's own trajectory would visit
different positions, and local effect × divergence frequency is not the aggregate
effect. Categories overlap in cause, so the per-category intervals are not
corrected for multiplicity and a winning category must not be declared from
overlapping intervals.

The statistical unit is the **deal**, not the divergence: several divergences in
one deal share one outcome. Per-category reports give the distinct-deal count,
which is the honest _n_.

## Design: what counts as a category

Two families are kept apart, because they answer different questions:

- **position** features answer *where* the arms disagree and are computed from
  the board alone (hand size, whose turn, remaining counts, who is the partner);
- **action** features answer *what* they disagree about (does the action spend
  part of a bomb, rocket, or triple).

**No category is defined by which arm chose an action.** Defining a group by the
outcome and then testing it for an outcome is how this analysis would fool
itself.

Frozen before any outcome was inspected: a seat is nearly out at ≤ 2 cards; the
endgame is a hand of ≤ 7 cards; the opening is a 20-card hand. Priority order,
with the residual last so it can never quietly absorb everything:

1. `endgame-low-cards` — hand ≤ 7 cards
2. `farmer-partner-nearly-out` — a farmer whose partner holds ≤ 2 cards
3. `breaks-control` — either action spends part of a four-of-a-kind, rocket, or triple
4. `opening-twenty-cards` — a 20-card hand
5. `midgame-other` — the residual

## Method

Two arms inside one process, both faithful:

- **shipped arm** — the real `decideEnhancedAi` with `analyzerNodes: 220`.
- **candidate arm** — a generated shadow tree: `hand-analyzer.ts` copied verbatim
  from the shipped source with the archived patch's two substitutions applied,
  and `scoring-policy.ts` copied with its analyzer import redirected. Nothing
  else differs. Generated only under `.local/harvest/gen/`, never committed, and
  every source and generated file is hashed into the run record.

The schedule is the shipped fixed-landlord one (`armSchedule`, one strong seat
per game). At every strong-seat decision the context is built once and both arms
rank it; **the game always follows the shipped arm**, so the sample is the
positions the shipped AI actually reaches. The clock is fixed (`shouldContinue`
always true), so runs are byte-reproducible.

Roll-forward rebuilds each position by replaying the recorded command prefix from
the deal through `startWithLandlord`, checks the rebuilt position against the
frozen public view, then plays each arm's action to the end under the shipped
continuation. Both roots run under the same continuation: the candidate patch
cannot change the continuation policy, because master's rollout scores with
`estimateBasicHandTurns`, which the patch never touched. A second "candidate
continuation" cell would look like a different policy while running the first.

## Results — 200 deals, seeds 301–500

12,694 strong-seat decisions, 492 divergences (3.88%), every one of the 492
positions rebuilt and verified.

| Category | Decisions | Divergences | Rate | Paired Δ (candidate − shipped) |
| --- | --- | --- | --- | --- |
| endgame-low-cards | 5,884 | 5 | 0.1% | **0.0 pp** over 5 deals |
| farmer-partner-nearly-out | 480 | 13 | 2.7% | **0.0 pp** over 10 deals |
| breaks-control | 463 | 127 | 27.4% | +5.7 pp over 82 deals, CI [−5.0, +16.5] |
| opening-twenty-cards | 406 | 72 | 17.7% | +3.8 pp over 65 deals, CI [−4.6, +12.3] |
| midgame-other | 5,461 | 275 | 5.0% | +4.3 pp over 123 deals, CI [−2.2, +10.9] |
| **pooled** | 12,694 | 492 | 3.88% | **+5.1 pp** over 166 deals, CI [−0.2, +10.3] |

Branch win rates under the shipped continuation: candidate action 44.1%
(651/1476), shipped action 39.8% (588/1476).

The divergence rate rises monotonically with the number of legal actions — 0.0%
at 1 legal action, 1.6% at 2, 5.1% at 7, 12.6% at 9 — and is zero for every hand
of 7 cards or fewer except five decisions out of 5,884.

### Estimate accuracy against an exhaustive oracle

Over the 8,026 decisions on hands of ≤ 12 cards, an independent exhaustive
legal-partition oracle (engine action generation only, never a production
estimate as a pruning bound) finds:

- the **shipped** estimate is below the true minimum in **1,147** positions (14.3%);
- the **candidate** estimate differs from the true minimum in **95** (1.2%), and
  in every sampled case it errs **upward** — conservative, which is the direction
  Spec 053's contract requires.

So the diagnosis Spec 053 could not make: the shipped bound really is optimistic
in a measurable share of small hands, and the feasible-partition bound really is
a better approximation of the truth — by roughly a factor of twelve.

## The finding that decides the next step

**The candidate cannot reach two of the owner's three categories.**

The mechanism is not incidental. `rankScoredPlayActions` gives every candidate
action `floor(220 / legalActionCount)` analyzer nodes, so an endgame position with
two or three legal actions gets a hundred or more nodes and the bounded search
**solves those hands exactly** — and an exact answer does not depend on where the
search started. In the endgame the two estimators converge on the same minimum,
the two rankings agree, and the move is identical. That is why 5,884 endgame
decisions produce 5 divergences, and why those 5 change nothing measurable.

The same arithmetic runs the other way at the opening: a 20-card hand exposes ~30
legal actions, each candidate gets ~7 nodes, the search barely descends, and the
returned value *is* the initial bound — the only thing the patch changes. Hence
25% divergence at 20 cards.

The consequence for the owner's stated goals is direct and negative:

- **"few cards left but no play control"** — measured, and the candidate is worth
  exactly nothing there: 0.0 pp over 5 divergences.
- **"a farmer not feeding a nearly-out partner"** — measured, and worth exactly
  nothing there either: 0.0 pp over 10 deals.
- **"breaking control cards early"** — this is where the candidate lives: 27.4%
  divergence over 463 decisions, the largest per-decision effect (+5.7 pp), with
  an interval that still includes zero.

A correct bound is not enough to improve endgame play, because at that node
budget the search already finds the exact answer. Endgame strength — the
capability with the strongest literature support — needs a different lever:
more nodes, a deeper rollout, or a better evaluation of the position rather than
of the hand.

Pooled, the candidate's action wins 5.1 points more often, over 166 deals, with
the interval spanning zero by two tenths of a point. That is a hint, not a
result, and it is a hint about the opening, not about the endgame.

## Proposed next experiment (not run this round)

One variable, chosen from the largest measured effect:

> Raise the per-candidate analyzer allowance for the enhanced play path only —
> the constant `220` in `decideEnhancedAi`'s expert call and master's
> `rootAnalyzerNodes` — and measure `default → expert` on identical completed
> deals with paired per-deal differences.

Rationale: the diagnosis shows the bound only matters when the node budget is too
small to solve the hand, which is exactly the opening and the wide midgame, and
that is where all measurable effect lives. This is the one lever the two rejected
experiments did not test (they moved weights and depth, not the node allowance),
and it is measurable inside the existing worker budget because master already
truncates at 120 ms with 3.8× headroom against the 480 ms window.

Decision rule, fixed before the run: adopt only if the paired interval's lower
bound is above zero on discovery seeds 301–700 **and** the effect holds on the
reserved validation seeds 10001–10400. Any result that fails either test is
recorded as a negative result and rolled back. Rejecting is the expected outcome
if the evaluation terms, not the search depth, are the real constraint.

## Measurement and honesty rules carried forward

- Report profiled/unbounded probes separately from shipped-clock strength. Expert
  truncates 0.1% of decisions, so its untimed sample is defensible; master
  truncates 13.3%, so any master number must be labelled *designed master*, not
  shipped master, in the same sentence.
- Compare configurations over identical completed deals, paired by deal.
- No machine-specific timing assertion enters the daily gate.

## Recovery and scaffolding

`benchmarks/diagnosis/**` and the generated `.local/harvest/gen/` tree are
**disposable research scaffolding**. They generate a candidate arm from the real
source bytes; they are not a second implementation, nothing in the product may
depend on them, and they are deleted once this line of work ends. No ADR is
superseded; ADR 0016/0017 worker isolation and fallback stay intact.

Not consumed: validation seeds 10001–10400 remain reserved, as Spec 053 §4
requires.
