# Spec 022: Game Result and Restart

Status: Approved for implementation

Date: 2026-09-02

## Goal

Turn Spec 021's winning physical seat into clear landlord/farmer and human
win/loss presentation data, then provide one clean finished-round restart
boundary. There are no points, multipliers, statistics, or history storage.

## Public seam and result

The existing `transition(state, command)` seam remains the only game mutator.
`FinishedState` adds one frozen `result`:

```ts
type GameResult = Readonly<{
  winner: Seat;
  winningSide: "landlord" | "farmers";
  humanRole: "landlord" | "farmer";
  humanOutcome: "win" | "loss";
}>;
```

The existing top-level `winner` and `landlord` fields remain available as
state-machine facts. `result` is presentation-ready derived data:

- the landlord seat winning means `winningSide: "landlord"`;
- either non-landlord winning means `winningSide: "farmers"`;
- the human role is derived from whether `landlord === "human"`;
- the human wins exactly when their role's side wins.

The `game-finished` event includes the same result value alongside `winner`.
Result creation is deterministic, contains no score, and is deeply frozen with
the rest of the successful transition.

## Restart command

`GameCommand` adds `{ type: "restart" }`.

- It is accepted only in `finished`.
- It returns the existing frozen `INITIAL_GAME_STATE` (`awaiting-deal`) and
  emits exactly `{ type: "game-restarted" }`.
- No cards, history, result, or role data survive in the new state.
- A later `deal` command supplies a fresh already-shuffled deck, preserving the
  explicit-randomness contract.
- In every other phase it returns `command-not-allowed` with the identical
  state.

## Test plan and acceptance

Public-transition table tests cover all four human-role/winning-side outcomes,
including either AI farmer winning; they assert the finished state and event
carry equal result data. Restart tests assert exact state/event output, old
state immutability, wrong-phase rejection, deep freezing, serialization, and a
fresh deal after restart.

Acceptance requires the project-local full quality gate.

## Non-goals

No score, coins, multipliers, spring/anti-spring, statistics, match history,
rematch shortcut, automatic deal, AI, redacted view, persistence, UI wording,
animation, audio, dependency, or generated output is included.
