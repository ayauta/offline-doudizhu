# Execution Plan 026: Exact Endgame Branch — Design

Status: Design only. Nothing built, nothing measured, `src/` untouched.

Started: 2026-09-12

Spec: none yet. Depends on the measurements in
`docs/exec-plans/active/025-exact-endgame-feasibility.md`.

## What is actually known at a decision

Stated with the code as the authority, because this plan's predecessor got it
wrong twice:

- The acting seat knows **its own hand** (`view.hand`) and **the three bottom
  cards** (`view.bottomCards`, public from `landlord-selected` onward).
- It knows **every card played** (`view.history`) and **every seat's remaining
  count** (`view.remainingCardCounts`).
- It knows **nothing else**. An opponent's count being public fixes how many
  cards they hold, never which.

So the unknown is a **pool** of cards — the deck minus played minus own hand
minus its own bottom cards — split between the two opponents in the known sizes
`f1` and `f2`. The number of positions consistent with what the seat knows is
`C(pool, f1) × C(pool − f1, f2) = C(pool, min(f1, f2))`.

Note the asymmetry the shipped sampler already encodes and this design keeps: when
the acting seat is a **farmer**, the bottom cards belong to the landlord, so they
are removed from the pool and placed in the landlord's hand first; the pool then
splits between the landlord and the other farmer. When the acting seat is the
**landlord**, the bottom cards are already inside its own hand and the pool splits
between both farmers.

## The branch

Below a threshold on `min(f1, f2)`, replace sampling with **full enumeration**.

1. **Enumerate.** Generate every distinct split of the pool into the two known
   hand sizes. `min(f1, f2) = 1` yields `pool` worlds, `2` yields `C(pool, 2)`,
   `4` yields `C(pool, 4)`. Deduplicate by the smaller hand's card set, since it
   determines the larger.
2. **Solve each world exactly.** The existing perfect-information solver settles
   whether the acting seat's side wins under optimal play in that world. No
   rollout, no heuristic evaluation, no sampling noise — the value is exact.
3. **Aggregate.** A move is scored by the **worst** case over the enumerated
   worlds, with total wins as the tie-break. Maximin is the right aggregate here
   because the solver answers win/loss, and because it is the only aggregate that
   makes a guarantee: a move chosen this way wins in **every** enumerated world,
   which is the strongest statement the available information supports.

Enumerating is what makes step 3 legitimate. Sampling produces a move that is good
on average across 32 draws; enumeration produces a move that is good against every
hand the opponents can actually hold. The two are different claims, and only the
second one survives the fact that the seat does not know the hand.

## Why this differs from everything already rejected

Every rejected experiment changed **how hard the search tries**: the anchor
(Spec 052), the rollout weight (Spec 052), the hand estimate (Spec 053), the win
distance's shape (Spec 023), the node allowance (Spec 024). Spec 024 proved the
last of those is literally a no-op, and Spec 054 explained why: the rollout's
value function is already exact where it is asked to work.

This branch does not search harder. It changes **what the search is asked**, from
"evaluate this sampled world" to "settle this world", and removes the sampling
error entirely by covering all of them.

## Threshold, cost, and where it hands back

From the Spec 025 measurements: `min(f1, f2) ≤ 4` covers **48.8%** of master
decisions, `≤ 2` covers **25.2%**, `= 1` covers **13.1%**. A node costs 238 µs on
the Xiaomi 10S and a solve costs single-to-low-hundreds of nodes.

Cost is worlds × candidate moves × nodes-per-solve. **Spec 027 measured this and
the estimate below was wrong**: the prototype spent a mean of 67,273 nodes per
decision, about 16 seconds at the device's 238 µs per node. The middle factor is
what does it — with one card unknown the seat may hold several, so there are
several root actions to solve *per world*, and each is solved from scratch.

The original text read: "so the branch is not obviously more expensive than what
it replaces." It was; by one to two orders of magnitude. **The threshold must be set from a measured
time-versus-worlds curve, not from this arithmetic**; the branch has to fall back
to the shipped sampler whenever its own budget check says so, exactly as the rest
of the path already does.

## What has to be measured before any of it ships

1. **A time-versus-`min` curve on the device.** Worlds multiply fast; the ceiling
   is wherever the branch can no longer finish inside the master's budget.
2. **How often the branch changes the move**, compared with the shipped master on
   the same positions. A branch that never differs is worthless however exact it
   is.
3. **Whether differing is better**, by the paired roll-forward method Spec 054
   already built — never by comparing solver values against rollout values, which
   are on different scales.
4. **The user-visible envelope**, unchanged: 480 ms window, 520 ms beat, one
   worker, silent degradation.

## Open risks, stated plainly

- **Maximin is conservative.** A move that wins in 99 of 100 worlds but loses in
  one scores below a move that wins in 60 and never loses. That is the price of a
  guarantee, and it may cost strength rather than gain it. The alternative —
  maximise expected wins over enumerated worlds — is weaker in claim but may play
  better; this is a decision to settle by measurement, not by argument.
- **Bundle size — a tripwire, not a wall.** The worker budget is 9,217 B gzip
  against a current 8,356 B, so 861 B of headroom. That limit is not a product
  requirement, a device constraint, or a performance budget: `check-bundle.mjs`
  derives it as "current baseline plus a third of one enhanced policy module",
  and its own comment says its job is to catch **the payload growing without
  anyone deciding to spend the bytes** — and enhanced policy reaching the main
  entry at all, which `check-boundaries.mjs` already enforces structurally
  through the runtime import closure.

  So the correct move if this branch needs room is to **raise the limit and
  record why** in that script's comment, which is exactly the "anchored to a
  measurement" discipline it documents. It is not a reason to abandon the
  branch, and it was wrong to describe it as one. What must stay true is the
  thing the budget is a proxy for: the enhancement must not reach the main
  entry, and the increase should be a deliberate, recorded decision.
- **The solver's correctness is still only smoke-tested** (7 positions, brute-force
  agreement). A branch built on it inherits that; hardening it comes first.
- **A counting error was made twice in this line of work** — first double-counting
  the bottom cards, then reading a public *count* as if it fixed *which* cards.
  Both were caught by review rather than by the measurements. Every quantity in
  this design is therefore quoted with the code that produces it, and any future
  step should re-derive them rather than trust this document.
- **Enumeration is per root position only.** Deeper plies re-enter the shipped
  machinery, so the branch is a better root decision, not a better search.
