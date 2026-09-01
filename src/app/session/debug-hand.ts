import {
  compareCardIds,
  createDeck,
  getCard,
  shuffle,
  type Card,
  type RandomSource,
} from "../../core/cards/index.js";

function createSeededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next() {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}

export function createDebugHand(): readonly Card[] {
  return shuffle(createDeck(), createSeededRandom(20_260_901))
    .slice(0, 17)
    .sort(compareCardIds)
    .map(getCard);
}
