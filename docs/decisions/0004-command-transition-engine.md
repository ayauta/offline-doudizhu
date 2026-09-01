# ADR 0004: Command/Transition Game Engine and Canonical Card IDs

Status: Accepted  
Date: 2026-08-30

## Context

The game must validate all human and AI actions, reproduce failures, support
eventual local recovery, and keep visual selection separate from rules. Card
identity must remain stable across dealing, selection, removal, tests, and save
files.

## Decision

Represent the 54 physical cards with canonical unique `CardId` values and derive
rank/suit/joker data through one cards module. Hands, moves, and snapshots store
IDs.

Represent `GameState` as a serializable discriminated union by phase. Change it
only through a pure `transition(state, command)` API. The result contains either
a new state plus ordered domain events or a structured error with the original
state unchanged.

UI state, platform handles, effects, and wall-clock metadata are separate.

## Consequences

- Deck/card conservation and duplicate selection are easy to validate.
- Tests can assert exact state transitions and event order.
- AI and UI share the same validation path.
- Commands and snapshots become stable contracts that require deliberate
  migration when changed.
- Some mapping and copying is required instead of in-place object mutation.

## Reconsider when

- profiling proves immutable transitions are a material device bottleneck;
- a rule spec shows canonical IDs cannot express a required variant; or
- persistence has not shipped and a demonstrably clearer state contract is
  proposed with migrated tests.
