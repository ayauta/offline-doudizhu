# ADR 0016: Bounded Worker for Enhanced AI

Status: Superseded by ADR 0017 for failure scope; the bounded single Worker, its computation budgets and delivery margin, lazy worker creation, and the runtime import closure and asset budgets remain accepted

Date: 2026-09-11

## Context

Spec 051 adds three rule-based AI levels while preserving the current strategy
as the default. Hand decomposition and limited hidden-card sampling can create
long JavaScript tasks even when their total latency is modest. The product's
primary interaction requirement is a continuously responsive table on Android
WebView and ordinary browsers.

Moving every AI path or hint into asynchronous infrastructure would risk
changing the accepted default behavior and the instant hint interaction.
Adding a worker pool, framework, or native bridge would add disproportionate
state and lifecycle complexity.

## Decision

Keep the existing default strategy and hint ranking on their current synchronous
paths. Run only the three enhanced opponent policies in one native Dedicated Web
Worker.

Pure AI modules own legal-action scoring, hand analysis, state evaluation,
determinization, and shallow rollout. They receive explicit seeds and work
limits and never read clocks, browser globals, or ambient randomness. An app
request handler adapts serializable redacted `AiDecisionContext` values. The
`platform/web` worker entry alone reads `performance.now()` and owns worker
messaging. A platform client implements the app port and rejects stale results.

The worker receives no `GameState` and no real opponent hand. Master sampling
constructs possible worlds solely from the acting seat's hand, revealed bottom
cards, public history, and public remaining-card counts.

One request has a hard computation budget: casual 16 ms, expert 40 ms, and
master 120 ms. The master normally aims to finish in roughly 40–80 ms and stops
at the deadline with the best completed evidence. Work begins immediately and
overlaps the existing 520 ms readable AI presentation beat; it never adds a
fake thinking delay or blocks the main thread.

Worker computation time and delivery time are separate budgets. The algorithm
keeps its 16/40/120 ms computation limits inside the worker. Worker module cold
start, message delivery, and result validation may use the remainder of the
existing 520 ms presentation beat, leaving a small main-thread safety margin.
A late result never extends that beat.

How much of a match a failure affects — and what the player is told — is
decided in ADR 0017. The lazy worker creation described here is what makes the
next-match retry possible.

The main delivery entries must not transitively import enhanced policy
implementation modules. The worker entry is their only runtime owner. The
architecture check enforces both runtime import closures, while the build check
enforces reviewed gzip budgets for the main JavaScript, CSS, and worker assets.

## Consequences

- Expensive AI work cannot become a main-thread rendering long task.
- The accepted default strategy and hint behavior remain owned by their
  existing implementation.
- Worker startup, cancellation, request identity, serializability, PWA
  precaching, and embedded WebView loading become test and release obligations.
- Main-entry reachability and asset budgets fail locally before enhanced code
  can regress startup or main-thread responsiveness.
- A single worker can finish a stale bounded request before accepting the next;
  the small hard limit makes a pool or interrupt protocol unnecessary.
- Android requires no permission, native bridge, or platform-specific AI code.

## Reconsider when

- measured target-device traces show a single worker misses the existing turn
  cadence;
- a future browser baseline cannot load the bundled same-origin worker; or
- a measured feature needs true parallel search enough to justify a second
  worker and its added lifecycle cost.
