# ADR 0005: Redacted and Replaceable AI

Status: Accepted  
Date: 2026-08-30

## Context

The first AI should be casual and reliable, while future versions may offer
difficulty levels. An AI running in the same process could accidentally inspect
opponent hands or bypass validation unless the boundary prevents it.

## Decision

Define `AiStrategy` against a redacted `PlayerView`, engine-produced legal
actions, and an explicit optional random source. AI returns ordinary bidding or
play commands. The application submits them to the same game transition API as
human commands.

The engine never imports AI. Strategy implementations cannot access full game
state, opponent hands, UI, platform, or persistence.

## Consequences

- AI cannot cheat through its declared interface.
- Legal-only contract tests are straightforward.
- Heuristics and future difficulty implementations are replaceable.
- Advanced AI may need new public observation fields, which require explicit
  fairness review.
- Enumerating legal actions has a cost, accepted for correctness and reuse by
  hints.

## Reconsider when

A future AI has a measured need for a different observation/action encoding.
Any new view must still expose only information legitimately available to that
seat, and commands must still pass engine validation.
