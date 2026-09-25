/**
 * The full-action self-play state-action feature schema — research entry point.
 *
 * The implementation moved to `src/core/ai/fa-features.ts` when the landlord
 * policy was integrated into the shipped Worker. It moved for the reason
 * `src/app/ai/cf-selector.ts` states about the farmer selector: there must be
 * exactly one implementation, or "the schema the experiment measured" and "the
 * schema the product runs" are two files that can drift apart silently.
 *
 * This module stays as the name every research file and test already imports,
 * so the move changed no call site. It re-exports the implementation rather
 * than restating it: a copy here is the drift this arrangement exists to
 * prevent.
 */
export * from "../src/core/ai/fa-features.js";
