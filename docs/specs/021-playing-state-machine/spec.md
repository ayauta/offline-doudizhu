# Spec 021: Playing State Machine

Status: Approved for implementation

Date: 2026-09-02

## Goal

Extend the deterministic `core/game` transition module from the
`ready-to-play` handoff through legal turn rotation, play, pass, trick reset,
physical-card removal, public action history, and final-card winner detection.
After this spec, an external command driver can advance a dealt and assigned
round all the way to a winner.

## Public seam

The existing public seam remains unchanged:

```ts
transition(state: GameState, command: GameCommand): GameTransitionResult;
```

`GameCommand` adds:

```ts
{ type: "play"; seat: Seat; cards: readonly CardId[] }
{ type: "pass"; seat: Seat }
```

`GameState` adds `playing` and `finished` phases. No second transition API,
turn helper, hand-removal helper, or state mutator is exported. Tests exercise
only `src/core/game` and arrange real rounds through deal/bid commands wherever
practical.

Every play/pass candidate is submitted once to Spec 012 `validatePlay` with
the acting seat's current hand and the state's current play. The game module
does not duplicate classification, ownership, comparison, bomb/rocket, or
lead/pass rules.

## Playing state

A non-finished accepted play produces `playing` state containing:

- all three current private hands and the revealed bottom cards;
- landlord and `currentSeat`;
- `currentPlay`, or null after a cleared trick;
- `lastPlaySeat`, or null after a cleared trick;
- `consecutivePasses`, stored only as 0 or 1;
- an ordered public `history` of normalized play/pass entries.

History entries reveal only actions that have occurred:

```ts
{ type: "play"; seat; play: ClassifiedPlay }
{ type: "pass"; seat }
```

There is no time, animation, UI selection, hidden-card snapshot, or AI
reasoning in history.

## Turn and play transitions

Only `ready-to-play` and `playing` accept play/pass commands. The acting seat
must equal `currentSeat`; otherwise the transition returns
`not-current-player` with the identical input state.

On an accepted play:

1. use `validatePlay` against that seat's hand and `currentPlay` (null in
   `ready-to-play` and after a trick reset);
2. remove exactly the normalized physical `CardId` values from that hand;
3. append the normalized play to public history;
4. emit `cards-played` with the normalized play and remaining-card count;
5. reset `consecutivePasses` to 0 and make the actor `lastPlaySeat`;
6. if cards remain, rotate `currentSeat` to the next seat;
7. if no cards remain, enter `finished`, record that seat as `winner`, and emit
   `game-finished` after `cards-played`.

An accepted response therefore replaces `currentPlay`; any earlier single pass
is discarded by the new play.

## Pass and trick reset

Passing is validated by `validatePlay`; leading or leading after a cleared
trick returns `cannot-pass-when-leading`.

- The first consecutive pass appends history, emits `player-passed`, stores
  `consecutivePasses: 1`, and rotates to the next seat without changing the
  current play or last player.
- The second consecutive pass appends history and emits ordered events
  `player-passed`, then `trick-cleared`. It clears `currentPlay`, clears
  `lastPlaySeat`, resets the count to 0, and sets `currentSeat` to the seat that
  made the last accepted play. That seat must lead the next trick.

Because there are exactly three seats and every accepted command rotates in
seat order, two consecutive passes always belong to the other two seats.

## Finished state and errors

`finished` stores hands after the final removal, revealed bottom cards,
landlord, winner, and complete public history. Spec 022 will derive
landlord/farmer outcome presentation and restart boundaries; this spec records
only the winning physical seat.

Play/pass commands in other phases or after finish return
`command-not-allowed`. Validation failures reuse the exact Spec 012 error code,
including classification, physical ownership, leading-pass, and
non-beating-response errors. Error precedence is:

1. command allowed in phase;
2. acting seat owns the current turn;
3. Spec 012 action validation.

Every failure returns the identical input state. Every success returns newly
frozen, plain, serializable state/events/history and never mutates state or
command inputs.

## Events

This spec adds:

- `cards-played { seat, play, remainingCardCount }`;
- `player-passed { seat }`;
- `trick-cleared { leader }`;
- `game-finished { winner }`.

Event order is part of the contract for second-pass and final-play transitions.

## Test plan and acceptance

Public-seam vertical tests cover:

- landlord's mandatory first play, exact card removal, history, event, and
  seat rotation;
- out-of-turn, unowned, malformed, non-beating, and leading-pass failures with
  exact original-state identity;
- an accepted response replacing the current play and resetting a prior pass;
- first pass, second-pass trick clearing, and mandatory lead after reset;
- every seat-order wraparound;
- a legitimate 54-card deal whose landlord can legally play all 20 cards at
  once, proving final removal, winner, ordered finish events, and rejection of
  later commands;
- hand/history conservation, deterministic output, deep freezing, JSON round
  trip, and input non-mutation.

Acceptance requires project-local strict typecheck, deterministic Vitest,
production/build-output checks, boundaries, privacy, and existing Chromium
acceptance.

## Non-goals

No landlord/farmer win wording, score, multiplier, spring, restart command,
automatic AI, redacted `PlayerView`, hint cycling, app session, persistence,
UI, animation, sound, statistics, dependency, or state-snapshot validation is
included.
