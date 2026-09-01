# ADR 0006: Versioned Local Persistence Boundary

Status: Accepted  
Date: 2026-08-30

## Context

The product should eventually recover an unfinished game and remember a small
set of settings. Core state must therefore be serializable, but implementing
storage before the game state stabilizes would freeze an immature schema.

## Decision

Define persistence as an application port implemented by the Web adapter with
`localStorage`. Persist only one unfinished-game snapshot plus approved
settings in a versioned, validated envelope. Keep at most one previous recovery
slot. Do not persist match history, statistics, identity, device identifiers,
or analytics. IndexedDB remains deferred until measured size or transaction
requirements justify it.

Do not implement resume in the minimal vertical slice. Add it through a
dedicated spec after the core state machine is stable and before public release.

## Consequences

- Core types remain serialization-friendly from the start.
- Corrupt or old saves fail safely without affecting rule logic.
- Schema migration and invariants can be tested outside a browser.
- The first engineering slice does not yet resume a game.
- Once released, card and state schema changes carry migration cost.

## Reconsider when

- users explicitly reject resume/settings persistence;
- storage limits or runtime behavior make the proposed envelope unsafe; or
- a new approved feature requires additional local data, with a privacy review.
