# Spec 030: Legal Baseline AI and Safety Contract

Status: Approved for implementation

Date: 2026-09-03

## Goal

Provide one deterministic local baseline strategy usable by both AI seats, a
redacted `PlayerView`, and a safety wrapper that submits every strategy result
through the ordinary game transition seam. Prove the AIs cannot receive hidden
hands through their declared interface, always act legally in valid engine
states, and complete full games in a bounded number of commands.

## Module and dependency direction

Implementation belongs in `src/core/ai` and may import `game`, `rules`, and
`cards`. The game engine never imports AI. No AI edits state, removes cards,
classifies plays, or bypasses `transition`.

`src/core/ai` publicly exports:

```ts
createPlayerView(state, seat): PlayerView | null;
runAiTurn(state, strategy): AiTurnResult;
BASELINE_AI_STRATEGY: AiStrategy;
```

These are the only new public seams. All returned/context values are readonly,
deeply frozen, plain where serializable, deterministic, and input-preserving.

## Redacted player views

`createPlayerView` returns null outside bidding/ready/playing phases. Views
contain only information legitimately available to the requested seat.

A bidding view contains:

- phase, requested seat, that seat's own 17-card hand;
- current bidder, public declined seats, and public remaining-card counts.

It contains no opponent hands, bottom cards, landlord, or private deck order.

A ready/playing view contains:

- phase, requested seat, only that seat's own current hand;
- landlord, current player, revealed bottom cards, remaining-card counts;
- current public play (null when leading) and public play/pass history.

No view contains a `hands` field or references any opponent hand array. Card
and history values are copied before freezing.

## Strategy interface and legal actions

```ts
interface AiStrategy {
  chooseCommand(context: AiDecisionContext): GameCommand;
}
```

The bidding context contains a bidding `PlayerView`. The playing context
contains a playing `PlayerView` plus the exact frozen output of
`generateLegalActions` for that seat's own hand/current play. A strategy
returns an ordinary game command; it is not given `GameState` or a state
mutator.

The baseline strategy is intentionally modest and deterministic:

- on its legal bidding turn, return `call` for its own seat;
- on a play turn, choose the first engine-produced legal action;
- convert the selected action to an ordinary `play` or `pass` command for its
  own seat.

Because legal-action ordering is deterministic, identical contexts produce
identical commands. On valid non-finished states there is always a legal lead
or pass, so the strategy has no retry loop.

## Safety wrapper

`runAiTurn` derives the current seat from state and rejects human/no-active-turn
states with `not-ai-turn`. It builds only the redacted context, calls the
strategy once, copies its command, and submits that command to `transition`.

Success returns the accepted command plus the normal next state and events.
If transition rejects the command, the wrapper returns `illegal-ai-command`
with the underlying structured game error and the identical original state.
If a strategy throws or returns malformed runtime data, the wrapper returns
`strategy-failed` without changing state. No retry or fallback action occurs.

This makes bad strategies observable while preserving the engine as the sole
authority.

## Termination argument

Every accepted non-pass play removes at least one physical card. Between two
plays, at most two passes can occur before the trick clears. The baseline never
passes when the legal generator offers a play before pass, and bidding calls on
the first AI turn. Therefore a valid round has a finite decreasing card count
and cannot loop.

Tests drive several deterministic 54-card deck orders from deal through a
human decline, AI bidding, and a complete one-human/two-AI round. Human turns
use the same first-legal-action policy in the test driver. Each game must reach
`finished` within 256 play/pass commands and both AI seats must act.

## Test plan and acceptance

Public-seam tests cover exact bidding and playing view redaction, revealed
public fields, copied/frozen data, baseline bid/play/pass choices, successful
safety submission, spoofed/illegal/throwing strategies, deterministic repeated
decisions, and bounded full-game termination across representative deck orders.

Acceptance requires the complete project-local quality gate.

## Non-goals

No strategic hand scoring, farmer cooperation, card preservation, bomb
restraint, difficulty, search, randomness, timer, worker, UI, animation,
persistence, telemetry, dependency, or hidden-state snapshot is included.
Those heuristics belong to Spec 031.
