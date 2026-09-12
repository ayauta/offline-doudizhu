# Execution Plan 021: AI Strength Measurement and Tier Separation

Status: Completed

Started: 2026-09-12

Completed: 2026-09-12

Spec: `docs/specs/052-ai-strength-evaluation/spec.md`

## Goal

Make the four computer levels' strength and time cost measurable on the shipped
decision path, then correct the one adjacent pair that the measurement shows is
not separated, without weakening any level by deliberate mistakes and without
changing anything the player sees.

## Steps

1. [x] Recheck product/architecture constraints, ADRs 0016/0017, Spec 051, the
   live decision handler, the app turn runner, and the existing benchmark.
2. [x] Rebuild the benchmark so it plays the shipped path: import
   `decideEnhancedAi` and `ENHANCED_AI_BUDGET_MS` instead of carrying local
   stand-in strategies, add clock-instrumented truncation measurement, a
   one-strong-seat schedule, a deal-clustered interval, a soft wall-clock cap
   with streamed progress, and the bid-path probe.
3. [x] Prove every new guard fails on an injected regression before claiming it
   works.
4. [x] Run the baseline against the shipped configuration and record it.
5. [x] Correct the Expert anchor so the tier ranks by its own evaluation.
6. [x] Re-run the identical benchmark configuration and report before/after.
7. [x] **Reject the correction and restore the shipped behaviour.** The change
   made Expert decisively worse, so it was reverted rather than shipped.
8. [x] Investigate the master tier: measure whether its rollout decides at all
   (6.9% of decisions), then attempt to make it dominate by raising the blend
   weight tenfold. Measured and **rejected** — the advantage disappeared.
9. [x] Restore the shipped behaviour and complete `pnpm check`.

## Completion evidence

- The harness reports, per level: p50/p95/p99/max decision time, budget,
  truncation rate with a Wilson interval, overshoot, headroom against the 480 ms
  response window, rollout completion, and shipped-versus-unlimited agreement;
  and per adjacent pair: deal-clustered win rate with a confidence interval,
  per-deal spread, and the deals needed to detect a 10-point difference.
- Baseline (2026-09-12, shipped path): casual 0.01/0.16/0.55/2.36 ms,
  default 0.01/0.11/0.42/1.60 ms, expert 0.09/5.06/15.24/40.38 ms,
  master 46.73/123.21/126.58/136.49 ms against a 120 ms budget with 13.3%
  truncation [11.6, 15.3] and 3.8× headroom.
- Baseline strength: `casual → default` 54.8% [53.2, 56.3],
  `default → expert` 49.6% [48.4, 50.8] — the pair that fails,
  `expert → master` 53.2% [51.1, 55.4].
- Guards proven red on injected regressions: the world-cap canary
  (`maxWorlds 32 → 8` failed with `expected 8 to be 32`), the strict truncation
  ceiling (`master` budget `120 → 0` failed with `truncates 100.0% of decisions`),
  and the determinism replay (non-determinism injected into casual scoring
  produced divergent command logs). The soft wall-clock cap was proven to stop
  cleanly and still report (`AI_BENCH_DEALS=100000 AI_BENCH_SECONDS=15` exited 0
  with a partial report).
- **The Expert correction was attempted, measured, and rejected.** Removing the
  cross-level ranking prior changed `default → expert` from 49.6% [48.4, 50.8]
  to 36.8% [35.2, 38.5], with `casual → default` byte-identical at 54.8% in both
  runs and the `casual → master` control falling from 53.3% to 36.7%. The change
  was reverted, so the shipped levels are unchanged and the negative result is
  recorded instead of a regression being shipped.
- **The Master correction was attempted, measured, and rejected too.** Raising
  the rollout blend weight from 0.2 to 2.0 doubled how often the rollout decides
  (6.9% → 13.0% of decisions) and dropped `master vs expert` from
  53.2% [51.1, 55.4] to 48.9% [46.3, 51.1] over 876 games. Reverted.
- Together the two rejected experiments point the same way: letting any single
  component of this evaluation dominate degrades play, so the bottleneck is the
  quality of the evaluation terms rather than their weighting or search depth.
- `src/**` is unchanged: the three reviewed gzip budgets are byte-identical to
  the pre-change baseline, and `git diff src/` is empty.
- No dependency, permission, persisted format, or delivered artifact changed.

## Recovery

The harness is development tooling and the correction is a single scoring term
in pure TypeScript. Reverting the term restores the previous behaviour exactly;
reverting the benchmark files restores the previous harness. No destructive
operation, credential, or remote mutation is part of this plan.
