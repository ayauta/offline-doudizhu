# Spec 052: AI Strength Measurement and Tier Separation

Status: Measurement implemented; tier separation not achieved, cause recorded

Date: 2026-09-12

## Goal

Make each computer level's strength and time cost measurable on the shipped
decision path, then use that measurement to decide what, if anything, can
honestly make the four levels distinct.

**Outcome.** Measurement is in place and the four levels are *not* distinct.
The obvious correction — removing the anchor that ties Expert's ranking to the
Default level's ordering — was implemented, measured, and **rejected**: it made
Expert much worse (see below). The anchor turned out to be load-bearing, which
reframes the problem rather than solving it. No behaviour change is shipped by
this spec; the anchor and all four levels are exactly as they were.

Two things this spec does *not* do: it does not weaken any level by deliberate
mistakes, and it does not change anything the player sees or feels. The 520 ms
presentation beat, the 480 ms response window, the per-level computation
budgets, and the fallback semantics stay owned by Spec 051, ADR 0016, and
ADR 0017.

## Non-goals

No neural network, learned model, MCTS, large search tree, worker pool,
dependency, network capability, or native bridge. No new level, no renamed
level, no in-match level display or change. No human playtest evidence is
claimed. The first-legal baseline is a test fixture, not a product level.

## Measurement contract

The benchmark measures the product, so it must run the product:

1. Enhanced levels are played by calling `decideEnhancedAi` with the imported
   `ENHANCED_AI_BUDGET_MS` and a real clock anchored where the worker anchors
   it. Constants are imported, never retyped; the previous harness drifted from
   the product by carrying its own copies.
2. The default level keeps its synchronous path.
3. Latency is reported as p50/p95/p99/max. Performance judgements use **p99 with
   a safety factor**; the maximum is recorded for information and is not treated
   as a stable estimator.
4. Truncation — the level's own budget check firing — is reported with a Wilson
   interval, together with the overshoot distribution and the completed-world
   count for Master's rollout.
5. Headroom is reported as `480 ms / p99`. **This measures headroom only.** The
   480 ms guarantee itself is implemented by the deadline and fallback mechanism
   and is proven by the session and browser fault-injection tests; no statistical
   result here may be presented as proving it.
6. Strength is reported as deal-clustered win rates with confidence intervals,
   from a role-balanced schedule that gives exactly one strong seat per game.
   **Elo is explanatory only and is never an acceptance criterion.**
7. A sampled unlimited-deadline re-run reports how much the budget costs the
   level's own answer (command agreement).
8. The benchmark stays out of `pnpm check`: it is a tuning and release tool.

## Baseline evidence

Measured 2026-09-12 on the development machine (Node 24.20.0), shipped path,
40 deals per level for latency and 400 mirrored deals (2400 games) per adjacent
pair for strength:

| Level | p50 | p95 | p99 | max | Budget | Truncated | Headroom |
| --- | --- | --- | --- | --- | --- | --- | --- |
| casual | 0.01 ms | 0.16 ms | 0.55 ms | 2.36 ms | 16 ms | 0.0% [0.0, 0.3] | 880× |
| default | 0.01 ms | 0.11 ms | 0.42 ms | 1.60 ms | sync | — | 1132× |
| expert | 0.09 ms | 5.06 ms | 15.24 ms | 40.38 ms | 40 ms | 0.1% [0.0, 0.4] | 31.5× |
| master | 46.73 ms | 123.21 ms | 126.58 ms | 136.49 ms | 120 ms | 13.3% [11.6, 15.3] | 3.8× |

Master completes its full 32-world rollout on roughly nine decisions in ten
(p50 = 32, p10 = 28 completed worlds). The bid path reads the clock zero times
by construction: it is answered before any deadline is consulted, and measured
at 3.8 ms p50 for Expert and Master.

Strength, before this spec's correction:

| Adjacent pair | Deals / games | Win rate | Clustered 95% CI |
| --- | --- | --- | --- |
| casual → default | 400 / 2400 | 54.8% | [53.2%, 56.3%] |
| default → expert | 400 / 2400 | **49.6%** | **[48.4%, 50.8%]** |
| expert → master | 74 / 444 | 53.2% | [51.1%, 55.4%] |

The default-to-expert pairing is **not shown to improve**: at 2400 games the
interval [48.4%, 50.8%] still **includes 50%**, and the point estimate sits below
it. The accurate statement is "no demonstrated advantage", not "measurably
weaker". Adjacent win rates also do not add up into a total span and need not be
transitive, so the ladder's overall spread should be read from the direct
`casual → master` comparison, whose interval [47.5%, 59.2%] equally does not
establish separation.

## Tier separation requirement

- **Hard**: every adjacent pair's clustered 95% confidence interval lower bound
  is above 50%. This is the only statistical requirement that is enforced.
- **Target**: adjacent pairs at or above 60%; the full 休闲→大师 span at or above
  75%. These guide tuning and are recorded, not gated, until a measured baseline
  supports a threshold.
- A run always reports the per-deal standard deviation and the number of deals
  needed to detect a 10-point difference, so a claim can be checked against the
  power of the run that produced it.

## Expert tier: the defect, the attempted correction, and why it was rejected

**Defect.** Expert's score is dominated by
`defaultPolicyPrior = max(0, 12 − casualRank) × 160`
(`src/core/ai/scoring-policy.ts:185-190`, applied per candidate at `:228`) — an
anchor to the *default level's own ordering*. Everything Expert itself adds is
of comparable magnitude (`publicControlScore` spans ±210), so Expert largely
reproduces Default and the measured pairing is 49.6%.

**Attempted correction.** Remove the prior, and rank Expert's candidates on its
own evaluation alone. Implemented in full — the prior term, the cross-level
ranking map, and the evaluation order derived from it.

**Result: rejected.** Measured with the identical configuration and seeds:

| Pairing | Shipped (anchored) | Prior removed |
| --- | --- | --- |
| default → expert | 49.6% [48.4, 50.8] | **36.8% [35.2, 38.5]** |
| casual → default | 54.8% [53.2, 56.3] | 54.8% [53.2, 56.3] (unchanged) |
| control: casual → master | 53.3% [47.5, 59.2] | 36.7% [29.2, 43.3] |

The `casual → default` pair is byte-identical across both runs, which confirms
the change was scoped to the Expert path and that the shift is not run noise.
Removing the anchor made Expert decisively worse and took Master down with it,
because Master's shortlist is built from Expert's ranking.

**What this establishes.** Expert's own evaluation is not merely weaker than the
anchor — when it is allowed to dominate, it plays substantially *worse* than the
Default level. The anchor was masking a miscalibrated evaluation, not competing
with a good one. Any future attempt to differentiate this tier has to first make
Expert's own terms better than Default's ordering on the same positions; simply
letting them speak is worse than leaving the anchor in place.

## Master tier: the attempted correction, and why it was rejected

**Defect.** Master's contract is the Expert shortlist plus a sampled shallow
rollout, and the rollout is blended in at weight 0.2. Measured on the shipped
path, that rollout overturns the action Expert's ranking led with on **6.9%** of
decisions (12 of 174), and Master beats Expert by 53.2% [51.1, 55.4]. The search
is present, decides rarely, and is worth about three points.

**Attempted correction.** Raise the blend weight tenfold (0.2 → 2.0) so the
rollout decides far more often. Measured with the identical configuration:

| | Shipped (weight 0.2) | Weight 2.0 |
| --- | --- | --- |
| rollout overturns the Expert leader | 6.9% (12/174) | **13.0%** (38/292) |
| master vs expert, pooled | 53.2% [51.1, 55.4] | **48.9% [46.3, 51.1]** |
| arm A (Master as landlord) | — | 42.2% [37.7, 46.8] |
| arm B (Master as farmer) | — | 55.5% [51.4, 59.6] |

**Result: rejected.** Making the rollout decide twice as often removed Master's
advantage entirely (876 games; the pooled intervals of the two runs barely
touch, so the direction is likely but not overwhelming — the arm split, where
the damage concentrates on Master as landlord, is the clearer signal). The
shipped weight is restored and no behaviour change ships.

**What the two experiments establish together.** Removing Expert's anchor made
Expert much worse. Increasing Master's rollout influence made Master worse.
Both are cases of letting a component of this evaluation *dominate*, and both
degrade play — so the bottleneck is the quality of the evaluation terms, not
how strongly they are weighted or how deeply they are searched. The productive
next step is recalibrating evaluation against an objective, not turning knobs.

**Still forbidden.** No deliberate mistake, no blunder injection, no hidden
information, no second look at a world the acting seat cannot see. Weakening a
level is only ever permitted by making its view of the position simpler.

## Acceptance and test plan

**In the daily gate (`pnpm check`, `tests/**` only):**

- the shipped decision path returns legal commands and every game terminates
  (`tests/app/ai-decision-handler.test.ts`, `tests/core/ai.test.ts`);
- every existing expectation is unchanged (see below).

**In the benchmark only (`pnpm bench:ai`, `benchmarks/**`) — these are NOT in
`pnpm check`, because the default Vitest config includes only `tests/**`:**

- a designed-configuration replay reproduces identical commands;
- the budget-check structure matches the shipped world cap, so truncation
  attribution cannot silently drift;
- the harness statistics are self-checked (interval collapse on constant input,
  monotonic widening, bootstrap agreement);
- truncation, overshoot and headroom ceilings under `AI_BENCH_STRICT=1`.

A green `pnpm check` therefore says nothing about the benchmark's own guards;
they are only evidence when `pnpm bench:ai` has been run.
- **every existing expectation is unchanged**, because this spec ships no
  behaviour change: the default level's golden decisions, Expert's pinned top
  action, the returned-set-equals-legal-set property, Master's shortlist
  containment, and deadline-expired Master equalling Expert all stay green
  without edits.

Reported by the benchmark, never gated:

- win rates with clustered intervals, per-deal spread, and required deal counts;
- latency percentiles, truncation rates, overshoot, headroom, rollout
  completion, and shipped-versus-unlimited agreement.

Browser acceptance is unchanged: the visible product does not change, so the
existing scenarios must stay green without edits.

## Rollout and recovery

The harness is development tooling and the correction is one scoring term in
pure TypeScript. Reverting the term restores the previous behaviour exactly;
reverting the harness restores the previous benchmark. No persisted data,
dependency, permission, or delivered artifact is affected.
