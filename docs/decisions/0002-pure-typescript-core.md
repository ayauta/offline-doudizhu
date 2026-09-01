# ADR 0002: Pure TypeScript Core

Status: Accepted  
Date: 2026-08-30

## Context

Rules, state transitions, and AI legality are correctness-critical. They must be
fast to test and must not require a browser, DOM, storage, or a phone. Future
portability is desirable.

## Decision

Implement cards, rules, the game state machine, and AI contracts as pure strict
TypeScript under `src/core`.

Core code may not access DOM or browser globals, storage, network, wall-clock
time, timers, or ambient randomness. Nondeterminism is explicit input. Core
exports plain, serializable values and structured results.

## Consequences

- Rule tests run quickly under Node.js.
- The same inputs reproduce the same state and errors.
- Web delivery, UI, and persistence concerns cannot leak into domain types.
- Outer layers need small adapters and mapping code.
- Developers must resist convenient global calls inside the core.

## Reconsider when

Only if a proven platform constraint makes pure TypeScript impossible. A desire
to save adapter code or access a runtime convenience is not sufficient.
