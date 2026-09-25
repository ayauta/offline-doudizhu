import {
  ENHANCED_AI_BUDGET_MS,
  decideEnhancedAi,
  type EnhancedAiWorkerRequest,
  type EnhancedAiWorkerResponse,
  type PlayDecisionOverlay,
} from "../../app/ai/decision-handler.js";
import {
  cfSelectFarmerAction,
  parseTreeModel,
  type TreeModel,
} from "../../app/ai/cf-selector.js";
import { CF_MODEL_JSON, CF_SELECTOR_THRESHOLD } from "../../app/ai/cf-model-data.js";
import {
  CHEAP_LANDLORD_MODEL_JSON,
  CHEAP_LANDLORD_MODEL_SHA256,
} from "../../app/ai/cheap-landlord-model.js";
import type { CheapLandlordRuntime } from "../../app/ai/decision-handler.js";

type WorkerScope = {
  onmessage: ((event: MessageEvent<EnhancedAiWorkerRequest>) => void) | null;
  postMessage: (response: EnhancedAiWorkerResponse) => void;
};

const workerScope = globalThis as unknown as WorkerScope;

/**
 * The frozen model, parsed once on first use.
 *
 * Every failure mode here — a malformed table, a schema that does not match,
 * a row of the wrong width — resolves to `null`, and a null model means the
 * overlay is never installed and production plays its own move. A selector that
 * cannot load must not be able to block or corrupt a legal move.
 */
let cachedModel: TreeModel | null | undefined;

function loadModel(): TreeModel | null {
  if (cachedModel === undefined) {
    try {
      cachedModel = parseTreeModel(JSON.parse(CF_MODEL_JSON));
    } catch {
      cachedModel = null;
    }
  }
  return cachedModel;
}

function overlayFor(request: EnhancedAiWorkerRequest): PlayDecisionOverlay | undefined {
  if (request.counterfactualFarmer !== true || request.aiType !== "master") {
    return undefined;
  }
  if (request.context.kind !== "play") {
    return undefined;
  }
  const model = loadModel();
  if (model === null) {
    return undefined;
  }
  // The request is a play context, so the overlay only ever sees one.
  const options = {
    model,
    threshold: CF_SELECTOR_THRESHOLD,
    seat: request.context.view.seat,
  };
  return (context, productionCommand) =>
    cfSelectFarmerAction(context, productionCommand, options);
}

/**
 * The landlord policy, parsed once on first use.
 *
 * Same discipline as `loadModel`: a build with no table, a malformed table or a
 * schema that does not match resolves to `null`, and a null model means the
 * landlord branch is never installed and master plays its own move. A policy
 * that cannot load must not be able to block or corrupt a legal move.
 *
 * `undefined` means "not tried yet" and `null` means "tried, unavailable" —
 * the distinction matters because a failed parse must not be retried per
 * decision, and because the two are reported differently.
 */
let cachedLandlordModel: TreeModel | null | undefined;

function loadLandlordModel(): TreeModel | null {
  if (cachedLandlordModel === undefined) {
    try {
      if (CHEAP_LANDLORD_MODEL_JSON === null) {
        cachedLandlordModel = null;
      } else {
        cachedLandlordModel = parseTreeModel(JSON.parse(CHEAP_LANDLORD_MODEL_JSON));
      }
    } catch {
      cachedLandlordModel = null;
    }
  }
  return cachedLandlordModel;
}

function landlordRuntimeFor(request: EnhancedAiWorkerRequest): CheapLandlordRuntime | undefined {
  if (request.cheapLandlord !== true || request.aiType !== "master") {
    return undefined;
  }
  const model = loadLandlordModel();
  if (model === null) {
    return undefined;
  }
  return Object.freeze({ model, modelSha256: CHEAP_LANDLORD_MODEL_SHA256 });
}

workerScope.onmessage = (event) => {
  const started = performance.now();
  const request = event.data;
  const overlay = overlayFor(request);
  const landlord = landlordRuntimeFor(request);
  const outcome = decideEnhancedAi(request, {
    deadline: started + ENHANCED_AI_BUDGET_MS[request.aiType],
    now: () => performance.now(),
    ...(overlay === undefined ? {} : { overlay }),
    ...(landlord === undefined ? {} : { landlord }),
  });
  workerScope.postMessage(Object.freeze({
    requestId: request.requestId,
    outcome,
  }));
};
