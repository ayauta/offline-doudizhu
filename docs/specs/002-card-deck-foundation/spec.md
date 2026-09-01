# Spec 002: Card and Deck Foundation

Status: Implemented; automated acceptance passed  
Date: 2026-08-30

## Goal

Provide the smallest pure TypeScript card foundation needed to prove that the
core can generate and shuffle a complete deck without DOM, browser, UI,
storage, or ambient randomness.

## Representation

- A `CardId` is a branded integer from 0 through 53.
- IDs 0 through 51 are standard cards in rank-major order.
- Standard rank order is `3 4 5 6 7 8 9 10 J Q K A 2`.
- Within each rank, suit order is clubs, diamonds, hearts, spades.
- ID 52 is the small joker and ID 53 is the big joker.
- Rank/suit/joker values are derived from the ID by one cards module.
- Deck generation returns all 54 IDs exactly once in canonical order.

This mapping is an internal persistence/command contract and must not be
changed casually after saves ship.

## Shuffle contract

- Use a new-array Fisher-Yates shuffle.
- Accept a `RandomSource` with `next(): number`.
- Every sample must be finite and in the half-open range `[0, 1)`; otherwise
  throw a `RangeError`.
- Never call `Math.random` inside core.
- Never mutate the input array.
- The same input and same random sequence produce the same output.

## Acceptance criteria

- Exactly 54 unique IDs are generated.
- There are 52 standard cards and two distinct jokers.
- Every standard rank has all four suits.
- Card ordering and ID decoding are deterministic.
- Shuffle is a permutation, preserves input, and is reproducible.
- Invalid card IDs and random samples fail explicitly.
- Tests run under Node with no DOM or browser globals.

## Non-goals

No hand pattern, comparison, move validation, bidding, turn state, scoring, AI,
or production card art is part of this spec.
