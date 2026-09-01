export interface RandomSource {
  next(): number;
}

export function shuffle<T>(items: readonly T[], random: RandomSource): T[] {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const sample = random.next();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new RangeError(
        `RandomSource.next() must return a finite number in [0, 1); received ${sample}.`,
      );
    }

    const swapIndex = Math.floor(sample * (index + 1));
    const item = result[index]!;
    result[index] = result[swapIndex]!;
    result[swapIndex] = item;
  }

  return result;
}
