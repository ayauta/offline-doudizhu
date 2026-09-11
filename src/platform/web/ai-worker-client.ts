import type {
  EnhancedAiWorkerRequest,
  EnhancedAiWorkerResponse,
} from "../../app/ai/decision-handler.js";
import type {
  AiDecisionOutcome,
  AiDecisionContext,
  EnhancedAiDecisionService,
  EnhancedAiType,
} from "../../app/ports/ai-decision-service.js";

export interface WorkerLike {
  onerror: (() => void) | null;
  onmessage: ((event: MessageEvent<EnhancedAiWorkerResponse>) => void) | null;
  readonly postMessage: (request: EnhancedAiWorkerRequest) => void;
  readonly terminate: () => void;
}

type ClientOptions = Readonly<{
  createWorker?: () => WorkerLike;
  nextSeed?: () => number;
  queue?: (callback: () => void) => void;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function createBundledWorker(): WorkerLike {
  return new Worker(new URL("./ai-worker.ts", import.meta.url), {
    name: "offline-doudizhu-ai",
    type: "module",
  }) as unknown as WorkerLike;
}

function webSeed(): number {
  const sample = new Uint32Array(1);
  crypto.getRandomValues(sample);
  return sample[0] ?? 0;
}

export function createWebAiDecisionService(options: ClientOptions = {}): EnhancedAiDecisionService {
  const queue = options.queue ?? queueMicrotask;
  const nextSeed = options.nextSeed ?? webSeed;
  const pending = new Map<number, (outcome: AiDecisionOutcome) => void>();
  let nextRequestId = 1;
  let disposed = false;
  let worker: WorkerLike | null | undefined;

  function failPending(reason: "failed" | "unavailable"): void {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) {
      callback(Object.freeze({ ok: false, reason }));
    }
  }

  function ensureWorker(): WorkerLike | null {
    if (worker !== undefined) {
      return worker;
    }
    try {
      worker = (options.createWorker ?? createBundledWorker)();
    } catch {
      worker = null;
      return null;
    }
    worker.onmessage = (event) => {
      const data: unknown = event.data;
      if (!isRecord(data) || typeof data.requestId !== "number") {
        failPending("failed");
        return;
      }
      const callback = pending.get(data.requestId);
      if (callback === undefined) {
        return;
      }
      pending.delete(data.requestId);
      const outcome = data.outcome;
      if (
        !isRecord(outcome) ||
        typeof outcome.ok !== "boolean" ||
        (outcome.ok === false && outcome.reason !== "failed" && outcome.reason !== "unavailable")
      ) {
        callback(Object.freeze({ ok: false, reason: "failed" }));
        return;
      }
      callback(outcome as AiDecisionOutcome);
    };
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      failPending("unavailable");
    };
    return worker;
  }

  return Object.freeze({
    beginMatch() {
      if (worker === null) {
        worker = undefined;
      }
    },
    request(
      aiType: EnhancedAiType,
      context: AiDecisionContext,
      complete: (outcome: AiDecisionOutcome) => void,
    ) {
      const activeWorker = disposed ? null : ensureWorker();
      if (activeWorker === null) {
        queue(() => complete(Object.freeze({ ok: false, reason: "unavailable" })));
        return () => undefined;
      }
      const requestId = nextRequestId;
      nextRequestId += 1;
      pending.set(requestId, complete);
      try {
        activeWorker.postMessage(Object.freeze({
          requestId,
          aiType,
          context,
          seed: nextSeed(),
        }));
      } catch {
        pending.delete(requestId);
        queue(() => complete(Object.freeze({ ok: false, reason: "failed" })));
      }
      return () => {
        pending.delete(requestId);
      };
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      worker?.terminate();
      worker = null;
      failPending("unavailable");
    },
  });
}
