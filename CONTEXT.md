# Domain Context

This glossary names concepts that cross implementation modules. Product rules
remain authoritative in `docs/product-spec.md` and feature specifications.

This glossary describes shipped behavior. Current stronger-AI requirements are
in [Spec 055](docs/specs/055-stronger-local-ai/spec.md); the historical enhanced
timing and execution shape below do not constrain new candidates.

## Computer level

The single home-screen preference used by both computer seats for the next
match. The saved choice is independent of the level actually available during
an active match.

## Enhanced AI turn

One Casual, Expert, or Master computer decision from a redacted player view,
including its bounded background execution, presentation beat, result
validation, cancellation, and fallback outcome.

An environment-level Worker availability failure changes the effective
computer level to Default for the remainder of the current match and may be
explained once without blocking play. A transient turn failure, late result, or
invalid result falls back to Default for that turn only and does not claim that
the selected level is unavailable.

## Presentation beat

The existing minimum readable interval before a computer action is presented.
In the shipped implementation, background AI work overlaps this interval without
extending it or blocking the table. New enhanced candidates use Spec 055's
end-to-end waiting target; the Default presentation remains unchanged.
