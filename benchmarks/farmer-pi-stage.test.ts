/**
 * Farmer Policy Iteration Factory v1 — the strength-run worker.
 *
 * One env-gated mode, off by default so the benchmark suite stays green when it
 * is run without configuration:
 *
 *   AI_FPI_ARM_RUN=<dir> AI_FPI_ARM=champion|candidate AI_FPI_CHAMPION_ID=ai-v1 \
 *   AI_FPI_STAGE=stage1 AI_FPI_POOL_START=200001 AI_FPI_DEALS=200 \
 *   AI_FPI_POLICY_COMMIT=<sha> AI_FPI_ATTEMPT_ID=attempt-001
 *
 *   candidate only: AI_FPI_CANDIDATE_LAYER=<model.json> AI_FPI_CANDIDATE_SHA=<sha> \
 *                   AI_FPI_CANDIDATE_THRESHOLD=<t> AI_FPI_CANDIDATE_BYTES=<n>
 *
 * One invocation plays one arm of one stage over one deal window, and checkpoints
 * each deal as it finishes (§27). The runner starts one worker per arm — usually
 * in parallel, each with its own directory — and this file never sees the other
 * arm's numbers, which is what makes the no-peek rule structural rather than a
 * promise about how the runner behaves.
 *
 * What the two arms differ in is exactly one thing: the champion arm plays the
 * frozen `ai-v1` chain, and the candidate arm plays that same chain with one
 * layer appended (`candidateChain`). Nothing else changes — same deals, same
 * seeds, same landlord and teammate, same run knobs — because a stage whose arms
 * differ in two ways measures neither.
 *
 * Three deliberate choices worth stating:
 *
 *   - **the config hash covers the chain and the protocol, never the window.**
 *     A resumed run must be allowed to narrow its window — that is what resuming
 *     after a hard stop means — while a run that changed chains, thresholds or
 *     arm must be refused by the checkpoint layer.
 *   - **a resumed deal is re-derived and compared, not trusted.** The deal is
 *     cheap next to the consequences of training or deciding on a deal the
 *     current chain did not produce, so the record is recomputed and the
 *     comparison is the checkpoint layer's (§27).
 *   - **the win counts are never printed.** They are in the record's payload,
 *     where the aggregator reads them after the stage is sealed, and they are
 *     read from nowhere before that. Progress is counts, elapsed and throughput.
 */
import { describe, expect, it } from "vitest";

import {
  FARMER_ARMS,
  FARMER_RUN_CONFIG,
  armConfigHash,
  runFarmerDeal,
  type FarmerArm,
} from "./farmer-pi-arm.js";
import { chainDepth, type ChainLayer, type ChampionChain } from "./farmer-pi-chain.js";
import { assertFactorySeedBase } from "./farmer-pi-corpus.js";
import { makeDealRecord, writeDealRecord } from "./farmer-pi-stage.js";
import {
  candidateChain,
  candidateLayer,
  championChainById,
  dealCheckpointed,
  progress,
  requiredFloat,
  requiredInt,
  requiredText,
} from "./farmer-pi-workers.js";

const ARM_RUN = process.env.AI_FPI_ARM_RUN;
const ENABLED = ARM_RUN !== undefined;

/**
 * An arm is hours of play. The budget is stated here rather than inherited from
 * the benchmark config's backstop: the absolute deadline in the host is what
 * stops a formal stage, and this timeout must never be the thing that does.
 */
const STAGE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

describe.runIf(!ENABLED)("Factory v1 stage worker (idle)", () => {
  it("does nothing without AI_FPI_ARM_RUN", () => {
    // The worker is an entry point for a runner, not part of `pnpm check`. With
    // no mode selected it must leave the suite exactly as it found it: one
    // passing assertion, no games, no files.
    expect(ARM_RUN === undefined).toBe(true);
  });
});

describe.runIf(ENABLED)("Farmer Policy Iteration Factory v1 stage arm", () => {
  it("plays one arm's deal window and checkpoints every deal", () => {
    runArm(requiredText("AI_FPI_ARM_RUN"));
  }, STAGE_TIMEOUT_MS);
});

function armFromEnv(): FarmerArm {
  const raw = requiredText("AI_FPI_ARM");
  const arm = FARMER_ARMS.find((candidate) => candidate === raw);
  if (arm === undefined) {
    throw new Error(
      `AI_FPI_ARM must be one of ${FARMER_ARMS.join(", ")}; received "${raw}".`,
    );
  }
  return arm;
}

/**
 * The candidate layer, from the environment's description of it.
 *
 * The three fields are the runner's *record* of what the round registered: the
 * booster digest, the packaged artifact's size, and the threshold that was
 * calibrated for this layer. `candidateLayer` checks the file against the first
 * two; the threshold is checked for finiteness here and by `assertChainShape` on
 * the assembled chain, because a layer whose threshold is a mistyped variable is
 * a layer that decides everything.
 */
function candidateLayerFromEnv(): ChainLayer {
  return candidateLayer(Object.freeze({
    artifactPath: requiredText("AI_FPI_CANDIDATE_LAYER"),
    modelSha256: requiredText("AI_FPI_CANDIDATE_SHA"),
    threshold: requiredFloat("AI_FPI_CANDIDATE_THRESHOLD"),
    modelBytes: requiredInt("AI_FPI_CANDIDATE_BYTES"),
  }));
}

function runArm(dir: string): void {
  const arm = armFromEnv();
  const stage = requiredText("AI_FPI_STAGE");
  const championId = requiredText("AI_FPI_CHAMPION_ID");
  const policyCommit = requiredText("AI_FPI_POLICY_COMMIT");
  const attemptId = requiredText("AI_FPI_ATTEMPT_ID");
  const dealStart = requiredInt("AI_FPI_POOL_START");
  const deals = requiredInt("AI_FPI_DEALS");
  if (deals < 1) {
    throw new Error(`AI_FPI_DEALS must be at least 1; received ${deals}.`);
  }

  // §7.10 — the corpus and the strength run must name the same game the same
  // way. The run's own frozen seed base is what this checks, because that is the
  // number the decks are actually dealt from; a non-zero base would put every
  // stage on deals no corpus describes.
  assertFactorySeedBase(FARMER_RUN_CONFIG.seedBase);

  const base: ChampionChain = championChainById(championId);
  const chain: ChampionChain = arm === "candidate"
    ? candidateChain(base, candidateLayerFromEnv())
    : base;
  // The protocol identity is the pipeline commit the runner launched from.
  // `armConfigHash` wants a `protocolHash`; if the Factory's frozen protocol
  // file ever becomes the cited authority — it can be read with `loadProtocol`,
  // whose hash is that file's own sha256 — this one argument is where it enters,
  // and every checkpoint's config hash moves with it.
  const configHash = armConfigHash({ chain, arm, protocolHash: policyCommit });
  const started = Date.now();
  let written = 0;
  let resumed = 0;
  let decisions = 0;

  progress(
    `[fpi arm] stage ${stage} arm ${arm} champion ${chain.championId} ` +
    `layers ${chain.layers.length} window ${dealStart}..${dealStart + deals - 1} ` +
    `policy ${policyCommit} attempt ${attemptId} config ${configHash.slice(0, 16)}`,
  );

  for (let offset = 0; offset < deals; offset += 1) {
    const dealIndex = dealStart + offset;
    const outcome = runFarmerDeal({ chain, dealIndex });
    decisions += outcome.payload.chainDecisions;
    // The payload is the deal's result and nothing else — it is what
    // `artifactHash` covers, so a replayed deal has to hash identically — and
    // the whole of it is opaque here: the win counts are read by the aggregator
    // after the stage is sealed, never printed by the arm that produced them.
    const record = makeDealRecord({
      dealIndex,
      stage,
      arm,
      configHash,
      payload: outcome.payload,
      cost: outcome.cost,
      at: new Date().toISOString(),
    });
    if (dealCheckpointed(dir, record)) {
      resumed += 1;
    } else {
      writeDealRecord(dir, record);
      written += 1;
    }
    const elapsed = (Date.now() - started) / 1000;
    progress(
      `[fpi arm] ${arm} deal ${dealIndex} ${offset + 1}/${deals} written ${written} ` +
      `resumed ${resumed} decisions ${decisions} elapsed ${elapsed.toFixed(1)}s ` +
      `throughput ${(((offset + 1) / Math.max(elapsed, 1)) * 3600).toFixed(1)}/h`,
    );
  }

  const elapsed = (Date.now() - started) / 1000;
  progress(
    `[fpi arm] ${arm} done written ${written} resumed ${resumed} decisions ${decisions} ` +
    `elapsed ${elapsed.toFixed(1)}s`,
  );
  expect(written + resumed).toBe(deals);
  // The candidate arm's whole claim is that it is the champion's chain plus one
  // layer, and nothing else. Asserted against the objects this run actually
  // used rather than against the intent of the two lines that built them: an
  // arm that rebuilt the champion's layers would still play every deal and
  // still checkpoint a complete stage, and every number it produced would
  // belong to a different chain.
  if (arm === "candidate") {
    expect(chainDepth(chain)).toBe(chainDepth(base) + 1);
    expect(chain.layers.slice(0, base.layers.length).map((layer) => layer.modelSha256))
      .toEqual(base.layers.map((layer) => layer.modelSha256));
  }
}
