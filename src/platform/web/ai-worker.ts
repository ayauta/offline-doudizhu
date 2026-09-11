import {
  ENHANCED_AI_BUDGET_MS,
  decideEnhancedAi,
  type EnhancedAiWorkerRequest,
  type EnhancedAiWorkerResponse,
} from "../../app/ai/decision-handler.js";

type WorkerScope = {
  onmessage: ((event: MessageEvent<EnhancedAiWorkerRequest>) => void) | null;
  postMessage: (response: EnhancedAiWorkerResponse) => void;
};

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  const started = performance.now();
  const request = event.data;
  const outcome = decideEnhancedAi(request, {
    deadline: started + ENHANCED_AI_BUDGET_MS[request.aiType],
    now: () => performance.now(),
  });
  workerScope.postMessage(Object.freeze({
    requestId: request.requestId,
    outcome,
  }));
};
