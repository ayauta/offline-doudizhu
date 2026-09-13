# Execution Plan 025: Exact Endgame Feasibility on the Target Device

Status: Completed — feasibility measured on the Xiaomi 10S; no behaviour change

Started: 2026-09-12

Spec: none yet — a measurement, not an adoption. If pursued, it folds into the
tier-separation line of `docs/specs/052-ai-strength-evaluation/spec.md`.

## Why

Spec 054 showed the master's rollout does not search: at `floor(8 / legalActions)`
nodes a candidate returns its initial bound, and Spec 024 proved raising that
allowance is a byte-identical no-op. The step change that remains is not more
search effort but a different question — when a position's remaining pool is
small, the hands are fixed by the card count, the position is one of perfect
information, and it can be solved exactly instead of sampled.

This plan answers the only question that decides whether that is worth building:
**can the target phone afford an exact solve inside its budget?**

The repository's own rule is that no development-machine wall-clock number may
stand in for device evidence, so the measurement is built around quantities that
transfer: node counts, and a per-node cost measured on the device.

## Method

1. **Node cost.** `benchmarks/diagnosis/exact-endgame.probe.test.ts` counts nodes
   for an exact solve of real captured endgame positions, binned by pool size.
   `benchmarks/diagnosis/primitive-probe.ts` measures the cost of the two engine
   primitives a node is made of — the legal-action generator and the transition —
   the same way on both machines.
2. **Calibration.** `benchmarks/diagnosis/phoneprobe.ts` runs the *shipped*
   `decideEnhancedAi` over deterministic deals and times every decision. The same
   bundle bytes run on the development machine and on the phone, so the ratio
   between them is measured on identical work.
3. **Transport.** Built with esbuild, injected into the phone's WebView over the
   Chrome DevTools Protocol through `adb forward`. No application code, no
   dependency, and no change to `src/` is involved.

## Device under test

Xiaomi 10S (`M2102J2SC`, codename `thyme`), Android 13, arm64-v8a, WebView
`com.google.android.webview` 116.0.5845.92 — the same device the Spec 044 record
covers.

## Results

### The phone against the development machine, same bundle

| Level | | dev p50 | phone p50 | dev p99 | phone p99 | dev max | phone max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| expert | | 0.47 ms | **1.30 ms** | 12.19 ms | **29.5 ms** | 16.6 ms | **104.8 ms** |
| master | | 36.4 ms | **86.1 ms** | 165.2 ms | **383.7 ms** | 235.7 ms | **536.9 ms** |

Same 113 expert and 124 master decisions in both runs.

### Per-node cost, the number that transfers

| Primitive | dev | phone | ratio |
| --- | --- | --- | --- |
| `generateLegalActions` | 72.7 µs | **238.0 µs** | **3.3×** |
| `transition` | 5.0 µs | **21.2 µs** | **4.2×** |

The legal-action generator dominates, at 14× the transition on both machines —
matching the Spec 054 profile, where it held 75.7% of inclusive time. The phone
is roughly **3.7×** slower per operation.

### Exact solve cost, in nodes and in device time

241 distinct captured endgame positions, every one solved within a 400,000-node
cap, none censored:

| Pool | median nodes | max nodes | dev median | **phone estimate** |
| --- | --- | --- | --- | --- |
| ≤8 | 9 | 73 | 0.1 ms | **~0.4 ms** |
| ≤12 | 161 | 1,379 | 2.8 ms | **~10 ms** |
| ≤16 | 107 | 13,452 | 2.5 ms | **~9 ms (worst ~48 ms)** |

The phone estimate applies the measured 3.7× per-node ratio to the measured
development-machine solve time. It is a ratio-based estimate, not a device
measurement of the solver itself; the solver was never installed on the phone.

## What this decides

**Exact endgame solving fits the budget with room to spare.** The worst observed
position — pool 16, 13,452 nodes, the tail of the distribution — projects to
roughly 48 ms on the device. The 480 ms response window is untouched and the
existing 120 ms master budget is respected in every observed case. For contrast,
one `scoring-policy` candidate action is already allowed 220 nodes, and a node
there costs the same order of magnitude.

One in eight master decisions leaves a **single** hidden card; nearly half leave four or fewer.

## The threshold, and why the quantity had to be restated

An earlier attempt asked "is the position determined by public information?" by
testing `unseen cards == the other seats' remaining`. That was the wrong
quantity for two reasons:

1. **It double-counted the bottom cards.** `createPlayerView` gives a landlord a
   20-card hand that already *contains* the three bottom cards, so subtracting
   the bottom separately made the pool look three cards smaller than it is.
2. **Even fixed, it is trivially true.** With the bookkeeping right, the two
   sides are equal by construction and the test never fails — it says nothing.

A second correction was needed. A seat knows **only its own hand and the bottom
cards** (`PlayingPlayerView.bottomCards`); it does not know any opponent's cards,
and no amount of card counting reveals them. What public information fixes is the
opponents' hand **sizes** and the **pool** they are drawn from — not which cards
go where.

So if the pool holds `P` cards and the two opponents hold `f1` and `f2` of them
(`f1 + f2 = P`), the number of positions consistent with what the acting seat
knows is

    C(P, f1) x C(P - f1, f2)  =  C(P, min(f1, f2))

— identical from the landlord's and a farmer's view, because choosing the smaller
hand determines the larger one. The unknown is therefore `min(f1, f2)` cards, and
the pool alone — which the previous version of this section reported — overstated
it. Note that this is a count of *distinct hands*, not of cards: at `min = 1` the
opponent still holds one hidden card, and every one of the `P` choices is a
different position.

An earlier draft of this section claimed a farmer could deduce the landlord's hand
because the partner's count is public. That was wrong: the count being public
fixes how *many* cards the landlord holds, never *which*.

Measured over 2,449 master decisions in 40 deals, card conservation asserted at
every step (0 failures):

| Unknown cards | Decisions | Cumulative |
| --- | --- | --- |
| 1 | 322 | **13.1%** |
| 2 | 296 | **25.2%** |
| 3 | 282 | **36.7%** |
| 4 | 294 | **48.8%** |
| 5 | 181 | 56.1% |
| 6 | 156 | 62.5% |
| 8 | 72 | 70.5% |
| 10 | 85 | 76.0% |
| 17 | 262 | 100.0% |

**Almost half of master decisions differ from some other position by at most four
cards — and one in eight by a single card.** At `min = 4` the position has
`C(P, 4)` consistent hands, each of which the exact search can settle on its own;
at `min = 1` it has `P` of them, which at that point in a game is a handful.

That is a far better footing than the pool figure suggested, and it is still not
"perfect information". The honest reading: **the endgame is a region where the
unknown is small enough to enumerate and settle**, rather than one where nothing
is unknown. One in eight decisions differs from its neighbours by a single card;
half by four or fewer. A mean over all decisions is not the relevant statistic
and is not reported, because the distribution is bimodal — the tail at 17 unknown
cards dominates any average and would hide exactly the region that matters.

## Honesty

- **The solver's correctness is weakly verified.** A brute-force reimplementation
  agreed on all 7 distinct positions checked. That is a smoke test, not a proof.
- **The phone figures come from one unbounded run.** The timings are taken with
  no deadline, so they show the full cost where the shipped path would truncate.
  A sustained loop on a phone can also thermal-throttle, which this single run
  does not characterise.
- **A small unknown is not no unknown.** With `min(f1, f2)` hidden cards the
  position still has `C(pool, min)` consistent hands. An exact solve of one of
  them returns "this move wins **in that hand**", which is not yet "this move
  wins whatever the hand is". The design that closes the gap — enumerate every
  consistent hand when the count is small, settle each, and choose on the
  aggregate rather than on 32 sampled worlds — has not been built or measured.
- **No behaviour changed.** `src/` is untouched.

## Recovery

Everything added is a benchmark probe plus throwaway tooling under `.local/`.
Deleting them restores the previous state exactly. No dependency, fixture,
persisted format, or delivered artifact changed.
