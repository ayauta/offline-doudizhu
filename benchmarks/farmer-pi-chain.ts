/**
 * Farmer Policy Iteration Factory v1 — the champion chain runtime.
 *
 * A champion is a *chain*, not a model:
 *
 * ```
 * b0  = the production master's own action        (computed once per decision)
 * C3  = the production master's ordered top three (computed once per decision)
 * b1  = C3[M1 scores C3 \ {b0}] or b0             (layer 1)
 * b2  = C3[M2 scores C3 \ {b1}] or b1             (layer 2)
 * ...
 * bn  = the champion's action
 * ```
 *
 * Every layer answers exactly the same question — "given this observation, this
 * candidate, and the action the chain would otherwise play, is the candidate
 * better?" — and the only thing that changes from layer to layer is which
 * model and which threshold answer it. Adding a generation appends one layer.
 * Nothing already in the chain is retrained, re-tuned or re-run.
 *
 * Three properties are structural rather than procedural, because each of them
 * has an obvious way to be quietly wrong:
 *
 *   - **once only.** `cfProposal` is called at most once per decision, and the
 *     *same object* feeds every layer. A chain that re-proposed per layer would
 *     let layer 2 compare against a candidate list layer 1 never saw.
 *   - **the reference is the real action.** Layer `k` builds its features
 *     against `C3[b_{k-1}]` — the action the chain would actually have played —
 *     never against the production action and never against a re-derived one.
 *   - **innermost decline wins.** A layer that declines leaves the previous
 *     layer's action standing. Falling back to `b0` would silently discard
 *     every earlier generation's work and rename the experiment.
 *
 * The n = 1 chain is *ai-v1*: `tests/core/farmer-pi-chain.test.ts` holds it to
 * `cfSelectFarmerAction` command for command on a retired corpus, so "the chain
 * runtime reproduces the shipped champion" is a checked claim rather than a
 * reading of this file.
 *
 * Nothing in `src/` imports this module, and nothing here imports the product's
 * wiring. The Factory never ships.
 */
import type { GameCommand, Seat } from "../src/core/game/index.js";
import type { AiDecisionContext, AiStrategy } from "../src/core/ai/index.js";
import {
  cfActionCommand,
  cfCommandKey,
  cfProposal,
  cfScoreAlternatives,
  type CfProposal,
  type TreeModel,
} from "../src/app/ai/cf-selector.js";
import type { CfPolicy } from "./cf-dataset.js";

type PlayContext = Extract<AiDecisionContext, { readonly kind: "play" }>;

/**
 * One generation's contribution: a model and the threshold it was calibrated
 * at. The threshold is absolute and belongs to its own layer — it is never
 * inherited, averaged or re-derived from the layer below.
 */
export type ChainLayer = Readonly<{
  /** The frozen artifact identity, for the champion archive. */
  modelSha256: string;
  model: TreeModel;
  /** This layer's frozen threshold, in the model's own score units. */
  threshold: number;
  /**
   * Serialized size of the layer's packaged artifact. Carried on the layer
   * rather than recomputed because the archive has to report cumulative model
   * bytes for a chain whose artifacts may not all still be on disk.
   */
  modelBytes: number;
}>;

export type ChampionChain = Readonly<{
  /** `ai-v1` for the production champion, `ai-vN-research` for later ones. */
  championId: string;
  /** The champion this one was built on top of; `null` for the starting chain. */
  parentChampionId: string | null;
  /** Layers in order. `layers[0]` is generation 1's model. */
  layers: readonly ChainLayer[];
  /** Frozen provenance strings. Recorded, never consulted for a decision. */
  baseMasterVersion: string;
  top3Version: string;
  schemaHash: string;
}>;

export function chainDepth(chain: ChampionChain): number {
  return chain.layers.length;
}

export function cumulativeModelBytes(chain: ChampionChain): number {
  return chain.layers.reduce((total, layer) => total + layer.modelBytes, 0);
}

/**
 * The identity of a decision the chain made. Returned rather than inferred so a
 * guard can assert the once-only contract on real calls instead of trusting
 * that this module reports its own call count honestly.
 */
export type ChainOutcome = Readonly<{
  /** The command the chain plays. The caller's own object whenever it declines. */
  command: GameCommand;
  /** `cfProposal` calls made: one on the running path, zero on every decline. */
  proposals: number;
  /** `b0`'s index in `C3`, or -1 when the chain declined. */
  rawIndex: number;
  /** `b_k`'s index in `C3` after each layer, in order. */
  layerIndexes: readonly number[];
  /** Whether each layer replaced the action it was handed. */
  layerOverrode: readonly boolean[];
  /** Candidate traversals each layer made — `|C3| - 1` for every layer that ran. */
  layerRows: readonly number[];
  /** Sum of `layerRows`. The chain's total model traversals for this decision. */
  totalRows: number;
  /** Model-inference milliseconds per layer, for the cost record. */
  layerInferenceMs: readonly number[];
  /** True when any layer replaced the production action. */
  overrode: boolean;
}>;

const DECLINED: Omit<ChainOutcome, "command"> = Object.freeze({
  proposals: 0,
  rawIndex: -1,
  layerIndexes: Object.freeze([]),
  layerOverrode: Object.freeze([]),
  layerRows: Object.freeze([]),
  totalRows: 0,
  layerInferenceMs: Object.freeze([]),
  overrode: false,
});

function decline(productionCommand: GameCommand): ChainOutcome {
  return Object.freeze({ command: productionCommand, ...DECLINED });
}

export type ChainOptions = Readonly<{
  chain: ChampionChain;
  /** The one seat this chain is bound to. */
  seat: Seat;
  /**
   * The shared proposal. Defaults to the frozen `cfProposal`; a guard injects a
   * counting wrapper around that same function, so "one proposal per decision"
   * is a count of real calls rather than a number this module reports about
   * itself.
   */
  proposalOf?: (context: PlayContext) => CfProposal;
  /** Set false for a pure pass-through. */
  enabled?: boolean;
  /**
   * Called with each decision's outcome when the chain is installed as a
   * strategy. `cfSelectChainFarmerAction` never reads it — it is the cost
   * accounting seam, kept here so a caller does not have to wrap the strategy
   * and re-derive what the chain already knew.
   */
  observe?: (outcome: ChainOutcome) => void;
}>;

/**
 * The chain, exactly as the header states it.
 *
 * The decline conditions are the frozen selector's, repeated rather than
 * shared: a mis-bound call site must not be able to widen the blast radius, and
 * the landlord's invariance is the property every strength number in this
 * repository rests on.
 */
export function cfSelectChainFarmerAction(
  context: AiDecisionContext,
  productionCommand: GameCommand,
  options: ChainOptions,
): ChainOutcome {
  if (options.enabled === false || context.kind !== "play") {
    return decline(productionCommand);
  }
  const view = context.view;
  if (view.seat !== options.seat || view.seat === view.landlord) {
    return decline(productionCommand);
  }

  const proposalOf = options.proposalOf ?? cfProposal;
  // Exactly one proposal, whatever the depth. Every layer below reads this
  // object; none of them can ask for a second one.
  const proposal = proposalOf(context);

  if (proposal.actions.length < 2) {
    return Object.freeze({ command: productionCommand, ...DECLINED, proposals: 1 });
  }
  const productionKey = cfCommandKey(productionCommand);
  const rawIndex = proposal.actions.findIndex(
    (action) => cfCommandKey(cfActionCommand(view.seat, action)) === productionKey,
  );
  if (rawIndex < 0) {
    // Production's own action is not among production's own shortlist. That
    // cannot happen on the shipped path, and guessing here would be worse than
    // declining.
    return Object.freeze({ command: productionCommand, ...DECLINED, proposals: 1 });
  }

  let currentIndex = rawIndex;
  let overrode = false;
  const layerIndexes: number[] = [];
  const layerOverrode: boolean[] = [];
  const layerRows: number[] = [];
  const layerInferenceMs: number[] = [];

  for (const layer of options.chain.layers) {
    const choice = cfScoreAlternatives(
      view, proposal, currentIndex, layer.model, layer.threshold);
    // A layer that declines leaves the action it was handed standing. The
    // `currentIndex` assignment is therefore conditional on the override, and
    // the fallback is the previous layer's action rather than `b0`.
    if (choice.overrode && choice.index >= 0) {
      currentIndex = choice.index;
      overrode = true;
    }
    layerIndexes.push(currentIndex);
    layerOverrode.push(choice.overrode);
    layerRows.push(choice.scored);
    layerInferenceMs.push(choice.inferenceMs);
  }

  const chosen = proposal.actions[currentIndex];
  if (chosen === undefined) {
    return Object.freeze({ command: productionCommand, ...DECLINED, proposals: 1 });
  }
  // Rebuilt only when some layer actually replaced the production action. When
  // none did, the champion's action *is* the caller's production command —
  // object for object — and rebuilding it would break the identity the landlord
  // arm and every declining root depend on.
  const command = overrode ? cfActionCommand(view.seat, chosen) : productionCommand;

  return Object.freeze({
    command,
    proposals: 1,
    rawIndex,
    layerIndexes: Object.freeze(layerIndexes),
    layerOverrode: Object.freeze(layerOverrode),
    layerRows: Object.freeze(layerRows),
    totalRows: layerRows.reduce((total, rows) => total + rows, 0),
    layerInferenceMs: Object.freeze(layerInferenceMs),
    overrode,
  });
}

/**
 * πn for one seat, in the form the corpus generator's `CfPolicy` seam takes.
 *
 * Every seat the chain is not bound to gets the production command back, object
 * for object, which is what makes "πn is πn-1 plus one layer" true by
 * construction rather than by inspection — and what lets `cfPlayToTerminal`
 * resume the identical champion after a forced first action.
 */
export function cfChainPolicy(chain: ChampionChain, seat: Seat): CfPolicy {
  return (context, productionCommand) =>
    cfSelectChainFarmerAction(context, productionCommand, { chain, seat }).command;
}

/**
 * The chain in the form the tournament installs on one seat.
 *
 * `production.chooseCommand` is called exactly once per decision: the master's
 * raw action is the input to layer 1, not something layer `n` goes and gets
 * again. This is the runtime half of "the base master runs once per decision".
 */
export function createChainStrategy(
  production: AiStrategy,
  options: ChainOptions,
): AiStrategy {
  return Object.freeze({
    chooseCommand(context: AiDecisionContext): GameCommand {
      const raw = production.chooseCommand(context);
      const outcome = cfSelectChainFarmerAction(context, raw, options);
      options.observe?.(outcome);
      return outcome.command;
    },
  });
}

/**
 * The shape every chain must have before it is allowed to generate data or play
 * a stage. Cheap, and it fails loudly on the four mistakes that are silent
 * otherwise: an empty chain, a model built on a different feature schema, a
 * threshold that is not a finite number, and a layer list that does not start
 * at generation 1.
 */
export function assertChainShape(chain: ChampionChain, expectedFeatures: number): void {
  if (chain.layers.length < 1) {
    throw new Error(`Chain ${chain.championId} has no layers.`);
  }
  if (chain.championId === "" || (chain.layers.length > 1 && chain.parentChampionId === null)) {
    throw new Error(`Chain ${chain.championId} has inconsistent parentage.`);
  }
  chain.layers.forEach((layer, index) => {
    if (layer.model.numFeatures !== expectedFeatures) {
      throw new Error(
        `Chain ${chain.championId} layer ${index + 1} expects ${layer.model.numFeatures} ` +
        `features; the frozen schema has ${expectedFeatures}.`,
      );
    }
    if (!Number.isFinite(layer.threshold)) {
      throw new Error(`Chain ${chain.championId} layer ${index + 1} has a non-finite threshold.`);
    }
    if (layer.modelBytes <= 0) {
      throw new Error(`Chain ${chain.championId} layer ${index + 1} has no recorded artifact size.`);
    }
  });
}
