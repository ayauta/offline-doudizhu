# ADR 0018: Outcome-Based Requirements for Stronger Local AI

Status: Accepted product direction; candidate execution architecture pending

Date: 2026-09-12

Replaces the former fixed enhanced-AI worker count, computation budgets,
delivery margin and enhanced asset limits as requirements for future candidates.
ADR 0017's existing failure behavior remains implemented; it does not set a
new algorithm's time budget. No runtime implementation changes in this ADR.

## Context

The owner wants one stronger opponent while preserving the family-validated
Default. Historical implementation choices accumulated into algorithm bans and
budgets that constrain research without establishing a stronger opponent.
The owner has now explicitly allowed small pretrained neural models and
license-compatible third-party implementations, with fair inputs, on-device
offline execution, responsive play and a modest installation increment.

## Decision

[Spec 055](../specs/055-stronger-local-ai/spec.md) is the single current product
contract for AI selection and acceptance. Conflicting historical specifications,
plans and handoffs have been removed from the working tree. Their useful
experimental evidence is consolidated in the
[experiment record](../research/ai-experiment-results.md), without additional bans.

Algorithm family, inference runtime, execution technology and worker count are
candidate decisions. The existing worker is a starting implementation, not the
only permitted architecture. Game rules and authoritative state remain in the
existing game/application layers. Any model/runtime adapter must receive only
the acting player's permitted view and return actions through engine validation.
Pure game code need not absorb a model runtime or platform capability.

Installed local model/runtime assets may be loaded through reviewed delivery
and platform adapters. This does not authorize remote inference, tracking,
post-install model downloads or uploads. Concrete loaders and runtime adapters
must be documented with the selected candidate rather than designed in advance.

Preserve the existing Default path and keep expensive computation from blocking
interaction. Existing failure handling is preserved until an integration change
requires a documented update. Avoid hard-coding historical enhanced deadlines
or resource limits as universal product requirements.

## Consequences

- Review code and model-weight licenses separately; document version, source,
  dependencies and measured footprint when selecting a candidate.
- Keep current executable checks until implementation updates them together
  with evidence-based replacements. Removing a stale AI ceiling does not mean
  removing privacy, legal-action, responsiveness or offline checks.
- Main-thread blocking and hidden-hand access remain failures regardless of
  whether the chosen engine is TypeScript, a model runtime or another local
  implementation. Existing platform compatibility is assessed explicitly.
- Historical failed experiments remain available with their actual scope and
  uncertainty. Neither an implementation's cost nor move divergence alone
  establishes the general feasibility or strength of an algorithm family.
