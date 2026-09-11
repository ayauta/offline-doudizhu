import { describe, expect, it } from "vitest";

import type {
  EnhancedAiWorkerRequest,
  EnhancedAiWorkerResponse,
} from "../../src/app/ai/decision-handler.js";
import type { AiDecisionContext } from "../../src/core/ai/index.js";
import { createWebAiDecisionService, type WorkerLike } from "../../src/platform/web/ai-worker-client.js";

const BID_CONTEXT: Extract<AiDecisionContext, { readonly kind: "bid" }> = Object.freeze({
  kind: "bid",
  view: Object.freeze({
    phase: "bidding",
    seat: "ai-one",
    hand: Object.freeze([]),
    currentSeat: "ai-one",
    declinedSeats: Object.freeze(["human"] as const),
    remainingCardCounts: Object.freeze({ human: 17, "ai-one": 17, "ai-two": 17 }),
  }),
});

class FakeWorker implements WorkerLike {
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<EnhancedAiWorkerResponse>) => void) | null = null;
  readonly requests: EnhancedAiWorkerRequest[] = [];
  terminated = false;

  postMessage(request: EnhancedAiWorkerRequest): void {
    this.requests.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: EnhancedAiWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<EnhancedAiWorkerResponse>);
  }
}

describe("Web AI worker client", () => {
  it("matches responses by request ID and ignores a cancelled stale response", () => {
    const worker = new FakeWorker();
    const service = createWebAiDecisionService({
      createWorker: () => worker,
      nextSeed: () => 91,
      queue: (callback) => callback(),
    });
    const outcomes: string[] = [];
    const cancelFirst = service.request("casual", BID_CONTEXT, (outcome) => {
      outcomes.push(outcome.ok ? "first-ok" : "first-failed");
    });
    service.request("expert", BID_CONTEXT, (outcome) => {
      outcomes.push(outcome.ok ? "second-ok" : "second-failed");
    });
    cancelFirst();

    expect(worker.requests.map(({ requestId, aiType, seed }) => ({ requestId, aiType, seed }))).toEqual([
      { requestId: 1, aiType: "casual", seed: 91 },
      { requestId: 2, aiType: "expert", seed: 91 },
    ]);
    worker.respond({
      requestId: 1,
      outcome: { ok: true, command: { type: "bid", seat: "ai-one", decision: "decline" } },
    });
    worker.respond({
      requestId: 2,
      outcome: { ok: true, command: { type: "bid", seat: "ai-one", decision: "call" } },
    });

    expect(outcomes).toEqual(["second-ok"]);
  });

  it("fails safely when worker construction or execution is unavailable", () => {
    const queued: Array<() => void> = [];
    const unavailable = createWebAiDecisionService({
      createWorker: () => { throw new Error("unsupported"); },
      nextSeed: () => 1,
      queue: (callback) => queued.push(callback),
    });
    const outcomes: boolean[] = [];
    unavailable.request("master", BID_CONTEXT, (outcome) => outcomes.push(outcome.ok));
    expect(outcomes).toEqual([]);
    queued.shift()?.();
    expect(outcomes).toEqual([false]);

    const worker = new FakeWorker();
    const failing = createWebAiDecisionService({
      createWorker: () => worker,
      nextSeed: () => 2,
      queue: (callback) => callback(),
    });
    failing.request("expert", BID_CONTEXT, (outcome) => outcomes.push(outcome.ok));
    worker.onerror?.();
    expect(outcomes).toEqual([false, false]);
    failing.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("turns malformed responses and post failures into ordinary fallbacks", () => {
    const worker = new FakeWorker();
    const outcomes: boolean[] = [];
    const service = createWebAiDecisionService({
      createWorker: () => worker,
      nextSeed: () => 3,
      queue: (callback) => callback(),
    });
    service.request("master", BID_CONTEXT, (outcome) => outcomes.push(outcome.ok));
    worker.onmessage?.({ data: { requestId: 1, outcome: "broken" } } as unknown as MessageEvent<EnhancedAiWorkerResponse>);
    expect(outcomes).toEqual([false]);

    const throwingWorker = new FakeWorker();
    throwingWorker.postMessage = () => { throw new Error("clone failed"); };
    const throwing = createWebAiDecisionService({
      createWorker: () => throwingWorker,
      nextSeed: () => 4,
      queue: (callback) => callback(),
    });
    expect(() => throwing.request("expert", BID_CONTEXT, (outcome) => outcomes.push(outcome.ok))).not.toThrow();
    expect(outcomes).toEqual([false, false]);
  });
});
