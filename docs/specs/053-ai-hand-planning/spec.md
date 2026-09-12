# Spec 053: Bounded Hand Planning Experiment

Status: Experiment rejected after discovery; shipped behavior restored

Date: 2026-09-12

## Confirmed product direction

The owner's family has played the existing Default level and finds it suitable.
Preserve that strategy, its initial selection, hints, and presentation exactly.
Keep an easier level. Improve one challenging level first; the eventual number
of levels depends on demonstrated separation, not a requirement to retain four.
This experiment does not remove, rename, or change the selector's four options.

All levels make their own best decision, retain basic card sense, and never
inject deliberate mistakes. No neural network, personal adaptation, biased
dealing, hidden-hand access, dependency, or network capability is permitted.
Evaluate increasing challenge primarily with the human as landlord; farmer
play should improve cooperation rather than force decreasing human win rates.
Self-play is algorithm evidence, not a substitute for family experience.

## One experimental variable

Correct the bounded enhanced HandAnalyzer's remaining-play estimate. Leave
Default, Casual's fast estimate, public-position scoring, Master utility,
shortlist, rollout depth/worlds, scoring weights, worker budgets, 480 ms response
window, and 520 ms presentation beat unchanged. Expert and Master share the
analyzer, including their existing bidding path; any bidding change must be
reported separately because fixed-landlord tournaments bypass bidding.

The current search initializes its best result from an optimistic heuristic and
only lowers it. It therefore reports one play for hands requiring two or three,
even with abundant nodes. More depth cannot correct an optimistic initial bound.

## Experimental estimate contract

`HandEvaluation.minimumTurns` remains the existing field name for compatibility,
but means a bounded estimate of the minimum number of independent legal plays,
not turns to win an adversarial game and not a claim of exact optimality.

During this experiment its value must be an upper bound backed by a legal hand
partition, including on node exhaustion and cache hits. Empty hands return zero.
Fallback can partition by rank and attach distinct single/pair groups to distinct
triples; it must not deduct overlapping sequence and attachment savings. Search
uses only engine-generated legal actions. Existing node allowances remain fixed.
Enough search must find the exact answers on the small regression corpus.

| Hand | Required minimum | Legal partition example |
| --- | --- | --- |
| 3334445 | 2 | 333444 + 5 |
| 3334455 | 2 | 33344 + 55 |
| 33344556 | 3 | 33344 + 55 + 6 |

Use an independent exhaustive partition oracle in development tests; do not use
the production heuristic to prune that oracle. Check several node budgets,
cache reuse, exhausted budgets, conservation/input preservation, and real
one-play hands. No exhaustive oracle belongs in delivered application code.

## Measurement and adoption

1. Record the shipped baseline before editing production code. Use Spec 052's
   actual decision handler, imported budgets, fixed-landlord schedule, and the
   same 400 discovery seeds (301–700) for before/after comparisons.
2. Preserve per-deal arm outcomes, calculate paired changes over identical
   completed deals, and report both arms as well as pooled intervals. The
   casual/default comparison is an unchanged control. Keep measurement serial.
3. Reject if discovery does not support improved Expert play versus Default.
   Do not retune other terms to rescue this one-variable experiment.
4. A promising result requires unused validation seeds (10001–10400), Master
   follow-up, latency/truncation/bidding review, unchanged default goldens,
   bundle limits, `pnpm check`, and applicable browser acceptance before adoption.
   This is not by itself proof of perceptible human difficulty separation.
5. Report profiled/unbounded probes separately from shipped-clock strength.
   No machine-specific timing assertion enters the daily gate.

## Recovery

If rejected, restore production code and keep the experimental candidate plus
regression tests outside the shipped runtime as reproducible research evidence.
Do not leave a failing daily test that demands an unshipped contract. Record
the negative result, test limitations, and next decision. No ADR is superseded;
ADR 0016/0017 worker isolation and fallback stay intact.

## Outcome

The feasible-partition candidate passed the regression/oracle tests but did not
establish improved play: Expert vs Default changed from 49.625% to 50.375%, with
a paired 95% interval for the change of [-0.167, +1.708] percentage points.
No validation seeds were consumed and no production change is adopted. This
rejects adoption of this candidate, not the possibility of better hand planning.

See [experiment evidence](experiment.md), [per-deal results](discovery-results.json),
and the [reproducible candidate and tests](candidate.patch). These archived tests
specify the rejected candidate's stronger upper-bound contract; the current
production heuristic does not satisfy that contract and they are not daily gates.
