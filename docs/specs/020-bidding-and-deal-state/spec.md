# Spec 020: Bidding and Deal State

Status: Approved for implementation

Date: 2026-09-02

## Goal

Establish the first deterministic `core/game` state transitions: deal one
canonical deck to three fixed seats, run the simplified human-first landlord
bidding sequence, assign and reveal the bottom cards to the first caller, or
request a fresh deal after three declines.

## Public seam

`src/core/game` exports one state-machine seam:

```ts
transition(state: GameState, command: GameCommand): GameTransitionResult;
```

It also exports the frozen `INITIAL_GAME_STATE`, state/command/event/error
types, `SEAT_ORDER`, and `Seat`. Tests import only this public module.

The transition result is either:

- success: a new frozen state plus ordered frozen domain events; or
- failure: the exact unchanged input state plus one frozen structured error.

All values are plain, readonly, JSON-serializable data. The game module uses no
browser API, time, timer, ambient randomness, AI strategy, or mutation.

## Seats and phases

Seat order is fixed and public:

```text
human -> ai-one -> ai-two -> human
```

`GameState` is a discriminated union with these phases:

- `awaiting-deal`: accepts only a `deal` command;
- `bidding`: owns all three private hands, the unrevealed bottom cards, the
  current bidder, and the seats that have declined;
- `ready-to-play`: owns all hands, the now-public bottom cards, the landlord,
  and the landlord as `currentSeat` for the first trick.

Phase names deliberately stop before the Spec 021 playing state machine. The
internal full game state may contain hidden information; later application and
AI views must redact it at their own public seams.

## Deal command

`{ type: "deal", deck }` supplies nondeterminism explicitly as a complete
already-shuffled deck. The command is valid only in `awaiting-deal`.

- `deck` must contain every canonical `CardId` from 0 through 53 exactly once.
- The first 51 cards are dealt round-robin in `SEAT_ORDER`; the last three are
  bottom cards.
- Every stored hand and the stored bottom cards are sorted by canonical
  `CardId`, independent of input deck order.
- Each seat receives 17 cards, the bottom contains three, all 54 identities are
  conserved, and no stored array aliases the command input.
- Successful dealing enters `bidding` with `human` as `currentSeat`, no
  declines, and emits exactly `deal-completed`.

Invalid decks return `invalid-deck`. A valid deal in another phase returns
`command-not-allowed`.

## Bid command

`{ type: "bid", seat, decision }` uses decision `call` or `decline` and is
valid only in `bidding` for the current seat.

- Any other phase returns `command-not-allowed`.
- A non-current seat returns `not-current-bidder`.
- `call` immediately enters `ready-to-play`: that seat is landlord and
  `currentSeat`, its sorted hand contains its original 17 cards plus all three
  bottom cards, the other hands remain unchanged, and `landlord-selected`
  reveals the bottom cards.
- Human `decline` records the decline, advances to `ai-one`, and emits
  `bid-declined`.
- `ai-one` `decline` records the decline, advances to `ai-two`, and emits
  `bid-declined`.
- `ai-two` `decline` returns to `awaiting-deal` and emits ordered events
  `bid-declined`, then `redeal-requested`. No old cards survive in the new
  state; a later `deal` command must supply a fresh shuffled deck.

There is no rob-landlord, point bidding, doubling, or ability to continue
bidding after the first call.

AI bidding strategy is not part of this spec. Later orchestration submits the
same ordinary `bid` command for the current AI seat.

## Invariants and acceptance

Public-seam table tests prove:

- exact round-robin distribution, sorted storage, 17/17/17 plus three bottom
  cards, conservation, non-aliasing, and human-first bidding;
- every seat can become landlord only at its legal turn, receives exactly the
  bottom cards, and leads next;
- all-pass event order and a subsequent independent redeal;
- invalid deck shapes, duplicates, runtime-invalid IDs, wrong-phase commands,
  and out-of-turn bids return stable errors with the identical original state;
- all states, nested hands/arrays, results, errors, and events are frozen,
  serializable, deterministic, and input-preserving.

Acceptance requires strict typecheck, deterministic Vitest, production and
build-output checks, architecture boundaries, privacy, and existing Chromium
acceptance through the project-local Node 24.20.0/pnpm 11.24.0 toolchain.

## Non-goals

No play/pass command, trick state, hand removal, winner, result, restart UI,
automatic AI choice, redacted player view, app session, persistence, hint, UI,
animation, scoring, statistics, dependency, or generated lookup table is
included.
