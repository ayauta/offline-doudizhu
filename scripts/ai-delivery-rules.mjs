/**
 * Single source of truth for the enhanced-AI runtime import closure rules.
 *
 * Both `scripts/check-boundaries.mjs` and `tests/config/ai-delivery.test.ts`
 * consume these lists. Adding an enhanced implementation module is a one-line
 * change here; before, the same paths were duplicated in both gates and could
 * drift into a gate that silently stopped guarding a path.
 *
 * `src/app/ai/enhanced-ai-turn.ts` is deliberately absent: it is the
 * application-module owner of an enhanced turn and belongs to the main
 * closure. It must not be pulled into the worker.
 */

export const MAIN_RUNTIME_ENTRIES = Object.freeze([
  "src/delivery/pwa.ts",
  "src/delivery/embedded.ts",
]);

export const WORKER_ENTRY = "src/platform/web/ai-worker.ts";

/** Enhanced policy implementation the worker owns. The worker must reach all of these. */
export const WORKER_REQUIRED_PATHS = Object.freeze([
  "src/app/ai/decision-handler.ts",
  "src/core/ai/enhanced.ts",
  "src/core/ai/hand-analyzer.ts",
  "src/core/ai/master-policy.ts",
  "src/core/ai/scoring-policy.ts",
  "src/core/ai/state-evaluator.ts",
]);

/** Paths the main delivery closures must never reach. */
export const MAIN_FORBIDDEN_PATHS = Object.freeze([
  ...WORKER_REQUIRED_PATHS,
  WORKER_ENTRY,
]);

/** Ownership areas the worker closure must stay clear of. */
export const WORKER_FORBIDDEN_PREFIXES = Object.freeze([
  "src/app/session/",
  "src/platform/pwa/",
  "src/ui/",
]);
