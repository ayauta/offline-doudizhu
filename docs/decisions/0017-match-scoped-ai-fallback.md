# ADR 0017: Match-Scoped Fallback for Enhanced AI Unavailability

Status: Accepted

Date: 2026-09-11

Supersedes ADR 0016 for the failure-scope clause only. The bounded single
Worker, its computation budgets and delivery margin, lazy worker creation, and
the runtime import closure and asset budgets remain owned by ADR 0016.

## Context

ADR 0016 recorded that any enhanced-AI failure would show one notice and fall
back to the default strategy for that turn only.

That produced a defect the interface could not truthfully describe. The
`AiDecisionOutcome` port carried a single `ok: false` arm, so worker
construction failure, worker execution failure, a response deadline, a
malformed message, and an illegal command all reached the session
indistinguishable. The session degraded one turn, told the player the match had
fallen back to `默认水平`, and then requested the selected level again on the
very next turn. The notice claimed a match-level state the implementation never
entered, and it repeated until the match ended.

The distinction is real, and the platform can draw it. A worker that cannot be
constructed, or that fails while executing, will not recover on the next turn.
A deadline, a stale or malformed message, or a rejected command is a property
of one request.

## Decision

Failure meaning is explicit across the application port instead of collapsing
into a boolean. `AiDecisionOutcome` carries a reason: `unavailable` for worker
construction failure, worker execution error, or an absent service, and
`failed` for a response deadline, a stale or malformed result, a rejected
command, or a computation failure.

An `unavailable` outcome changes the effective computer level to Default for
the remainder of the current match. The application presents one non-blocking
notice that truthfully describes a match-level fallback. It does not block
play, require confirmation, or alter the saved preference. A later new match
retries the selected enhanced level once through lazy worker creation, so a
transient environment failure still recovers.

A `failed` outcome falls back to the existing default strategy for that turn
only and stays silent. It must not claim that the selected level is
unavailable. The default strategy is never speculatively computed while
enhanced work is pending.

One application module owns this lifecycle — request identity, the response
window inside the presentation beat, cancellation, result validation, and
fallback scope — so a turn's meaning is decided in one place rather than
reconstructed by the session from platform facts.

## Consequences

- A player whose environment cannot run the selected level is told once per
  match and can go change the selector; a player whose single request failed
  sees nothing.
- The saved preference and the level actually available during a match are
  independent. `CONTEXT.md` owns the vocabulary for that distinction.
- The Web Worker adapter reports platform facts only. It no longer decides how
  much of the match a failure affects.
- Naming a new failure category now requires naming its scope, not just its
  cause.
- In a permanently degraded environment the notice returns every match. That is
  deliberate: it is the only signal telling the player the saved preference is
  not taking effect.

## Reconsider when

- measured environment failures recover within a match often enough that
  waiting for the next match is slower than retrying immediately;
- a permanently degraded environment makes a per-match notice disruptive
  enough to warrant a page-session latch; or
- a future level's failure is genuinely partial, so neither scope describes it.
