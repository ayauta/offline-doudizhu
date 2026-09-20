/**
 * Re-export of the tree-table evaluator, which lives in `src/core/ai/cf-model.ts`.
 *
 * It moved there when the shipped Worker started scoring rows itself. The
 * benchmark keeps importing it from here so that every existing call site, and
 * the equivalence check that holds it to LightGBM's own predictions, run against
 * the same file the product runs.
 */
export {
  assertRowMatchesSchema,
  parseTreeModel,
  scoreTrees,
  type TreeModel,
  type TreeArrays,
} from "../src/core/ai/cf-model.js";
