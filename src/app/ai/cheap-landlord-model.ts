/**
 * The CHEAP landlord model, as the shipped Worker sees it.
 *
 * **Generated. Do not edit.** `scripts/cheap-landlord-embed.mjs` owns this file
 * and switches it between two states:
 *
 *   - **stub** (committed, default): the table is `null`, so the landlord
 *     branch is never installed and the shipped build packages no part of the
 *     candidate. This is why "production did not change" is a property of the
 *     build rather than a claim about it.
 *   - **embedded** (`--embed`, for the prototype build and the integration
 *     harness): the frozen 2.0 MB table, byte for byte as confirmed.
 *
 * The digest is not a placeholder in either state. It is the value the joint
 * dual-environment confirmation froze, and the Worker refuses a table that does
 * not hash to it, so "the model failed to load" and "the model was never
 * shipped" stay distinguishable in a trace instead of both reading as a silent
 * fallback.
 */

export const CHEAP_LANDLORD_MODEL_SHA256 =
  "070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b";

export const CHEAP_LANDLORD_MODEL_JSON: string | null = null;
