export interface WebRandomSource {
  readonly next: () => number;
}

export function createWebRandomSource(): WebRandomSource {
  const sample = new Uint32Array(1);
  return Object.freeze({
    next() {
      crypto.getRandomValues(sample);
      return sample[0]! / 0x1_0000_0000;
    },
  });
}

export function scheduleWebPresentation(
  delayMs: number,
  callback: () => void,
): () => void {
  const handle = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(handle);
}
