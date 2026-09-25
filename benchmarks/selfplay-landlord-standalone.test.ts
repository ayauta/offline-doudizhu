/**
 * Standalone landlord equivalence, and the landlord's real deployment cost.
 *
 * Two questions, one file, because both are about the same object: the frozen
 * landlord artifact used **alone**.
 *
 * 1. **Equivalence.** The development result came from a three-role bundle in
 *    which only the landlord entry was ever consulted. Validation must load the
 *    landlord model by itself and reach the *same executed command* on every
 *    state. Comparing raw tree scores would not be enough: two policies can
 *    agree on every score and still differ on a tie, and a tie is exactly where
 *    a tie-break rule earns its keep.
 *
 * 2. **Cost.** The whole path is measured — enumerate, featurise every legal
 *    action, score, argmax — for the landlord artifact on its own. The
 *    3-model total divided by three is not a measurement of anything.
 *
 * ```
 *   AI_SELFPLAY_LANDLORD_STANDALONE=1 vitest run --config vitest.benchmark.config.ts \
 *     benchmarks/selfplay-landlord-standalone.test.ts
 * ```
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel, scoreTrees, type TreeModel } from "../src/core/ai/cf-model.js";
import { generateLegalActions, type ValidatedPlayAction } from "../src/core/rules/index.js";
import type { PlayingPlayerView } from "../src/core/ai/index.js";
import { cfActionCommand, cfCommandKey } from "../src/app/ai/cf-selector.js";
import {
  argmaxAction,
  createPi1Bundle,
  createQBundle,
  createQModelPolicy,
  roleOfSeat,
  scoreLegalActions,
  type DecisionInput,
  type MixtureSpec,
  type PolicyBundle,
  type SelfPlayRole,
} from "./selfplay-policy.js";
import { collectEpisode, type CollectorConfig } from "./selfplay-collector.js";
import { selfplayRowFromState, stateFeaturesOf } from "./selfplay-features.js";

const ENABLED = process.env.AI_SELFPLAY_LANDLORD_STANDALONE === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REH = join(ROOT, ".local", "selfplay-reh", "TARGET");
const OUT = join(ROOT, ".local", "landlord-validation");

const ROLES: readonly SelfPlayRole[] = ["landlord", "farmer-next", "farmer-previous"];
const DEV_SEEDS = [5001, 5010, 5020, 5030, 5040, 5060, 5080, 5100];

function report(line: string): void {
  console.log(line);
}

interface LoadedModel {
  readonly model: TreeModel;
  readonly sha256: string;
}

function loadRoleModels(): Record<SelfPlayRole, LoadedModel> {
  const out = {} as Record<SelfPlayRole, LoadedModel>;
  for (const role of ROLES) {
    const raw = JSON.parse(
      readFileSync(join(REH, "train-input", `${role}.model.json`), "utf8"),
    ) as { modelSha256: string };
    out[role] = { model: parseTreeModel(raw), sha256: raw.modelSha256 };
  }
  return out;
}

/** π1 for the other two seats, exactly as the takeover arm had it. */
function pi1Environment(): CollectorConfig {
  const bundles = new Map<string, PolicyBundle>([["PI1", createPi1Bundle("master")]]);
  const mixture: MixtureSpec = Object.freeze({
    version: "fas-mixture-v1",
    current: "PI1",
    history: Object.freeze([]),
    weights: Object.freeze({ current: 1, sharedHistory: 0, independentHistory: 0 }),
  });
  return Object.freeze({
    bundles,
    learningBundleId: "PI1",
    mixture,
    epsilon: 0,
    explorationSalt: 0,
    mixtureSalt: 0,
    auditProposal: false,
  });
}

interface LandlordState {
  readonly label: string;
  readonly view: PlayingPlayerView;
  readonly legal: readonly ValidatedPlayAction[];
  readonly seat: string;
}

/** Real landlord-turn states from retired deals. */
function landlordStates(): readonly LandlordState[] {
  const config = pi1Environment();
  const states: LandlordState[] = [];
  for (const dealIndex of DEV_SEEDS) {
    for (const scenario of ["L", "F-next", "F-prev"] as const) {
      const episode = collectEpisode(config, dealIndex, scenario);
      for (const record of episode.records) {
        const view = record.view;
        if (roleOfSeat(view.seat, view.landlord) !== "landlord") {
          continue;
        }
        states.push({
          label: `${dealIndex}/${scenario}/${record.seatDecisionIndex}`,
          view,
          legal: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
          seat: view.seat,
        });
      }
    }
  }
  return states;
}

function isAttachment(kind: string): boolean {
  return (
    kind === "triple-with-single" ||
    kind === "triple-with-pair" ||
    kind === "airplane-with-singles" ||
    kind === "airplane-with-pairs" ||
    kind === "four-with-two-cards" ||
    kind === "four-with-two-pairs"
  );
}

describe.skipIf(!ENABLED)("standalone landlord: equivalence and cost", () => {
  it("reaches the same executed command as the full bundle, on every covered category", () => {
    mkdirSync(OUT, { recursive: true });
    const models = loadRoleModels();
    const bundle = createQBundle(models, "SP-TARGET");
    const standalone = createQModelPolicy(models.landlord.model, models.landlord.sha256);

    const coverage = {
      leading: 0,
      responding: 0,
      passOffered: 0,
      bombOrRocketAvailable: 0,
      attachmentAvailable: 0,
      largeActionSet: 0,
      canEmptyHand: 0,
    };
    const mismatches: string[] = [];
    const states = landlordStates();

    for (const state of states) {
      const input: DecisionInput = Object.freeze({
        context: Object.freeze({ kind: "play" as const, view: state.view, legalActions: state.legal }),
        seat: state.seat as DecisionInput["seat"],
        role: "landlord",
        dealSeed: 0,
        gameSeed: 0,
        decisionIndex: 0,
      });
      const fromBundle = cfCommandKey(cfActionCommand(input.seat, bundle.roles.landlord(input)));
      const fromStandalone = cfCommandKey(cfActionCommand(input.seat, standalone(input)));
      if (fromBundle !== fromStandalone) {
        mismatches.push(`${state.label}: ${fromBundle} vs ${fromStandalone}`);
      }
      const legalKeys = new Set(
        state.legal.map((action) => cfCommandKey(cfActionCommand(input.seat, action))),
      );
      if (!legalKeys.has(fromStandalone)) {
        mismatches.push(`${state.label}: standalone chose outside the legal set`);
      }

      if (state.view.currentPlay === null) {
        coverage.leading += 1;
      } else {
        coverage.responding += 1;
      }
      if (state.legal.some((action) => action.type === "pass")) {
        coverage.passOffered += 1;
      }
      if (
        state.legal.some(
          (action) =>
            action.type === "play" &&
            (action.play.pattern.kind === "bomb" || action.play.pattern.kind === "rocket"),
        )
      ) {
        coverage.bombOrRocketAvailable += 1;
      }
      if (
        state.legal.some(
          (action) => action.type === "play" && isAttachment(action.play.pattern.kind),
        )
      ) {
        coverage.attachmentAvailable += 1;
      }
      if (state.legal.length >= 30) {
        coverage.largeActionSet += 1;
      }
      if (
        state.legal.some(
          (action) => action.type === "play" && action.play.cards.length === state.view.hand.length,
        )
      ) {
        coverage.canEmptyHand += 1;
      }
    }

    report(
      `[landlord-standalone] ${states.length} landlord states from ${DEV_SEEDS.length} retired deals, ` +
        `mismatches ${mismatches.length}\n  coverage ${JSON.stringify(coverage)}`,
    );
    writeFileSync(
      join(OUT, "standalone-equivalence.json"),
      JSON.stringify(
        {
          candidateSha256: models.landlord.sha256,
          states: states.length,
          mismatches,
          coverage,
          contentDigest: createHash("sha256").update(JSON.stringify(coverage)).digest("hex"),
        },
        null,
        2,
      ),
    );
    expect(mismatches).toEqual([]);
    expect(states.length).toBeGreaterThan(50);
    // Every category must actually be exercised, or "0 mismatches" is thin.
    expect(coverage.leading).toBeGreaterThan(0);
    expect(coverage.responding).toBeGreaterThan(0);
    expect(coverage.bombOrRocketAvailable).toBeGreaterThan(0);
    expect(coverage.attachmentAvailable).toBeGreaterThan(0);
    expect(coverage.largeActionSet).toBeGreaterThan(0);
  }, 900_000);

  it("hard-fails on a corrupted model instead of falling back to the baseline", () => {
    const path = join(REH, "train-input", "landlord.model.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    // A model whose tree tables reference columns the schema does not have is
    // refused at parse time.
    expect(() => parseTreeModel({ ...raw, numFeatures: 86 })).toThrow(/beyond the schema/);

    const model = parseTreeModel(raw);
    const view = landlordStates()[0]!.view;
    const legal = generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
    expect(() => scoreLegalActions(view, model, legal)).not.toThrow();

    // Scoring itself does not validate width — `scoreTrees` just sums leaves —
    // so the selector is the only place a schema mismatch can become an error.
    // A leaf-only model that declares the legacy 86-column schema must refuse a
    // 403-wide row rather than quietly scoring it.
    const legacy = parseTreeModel({
      formatVersion: 1,
      lightgbmVersion: "test",
      modelSha256: "0".repeat(64),
      numTrees: 1,
      numFeatures: 86,
      featureNames: new Array(86).fill("legacy"),
      trees: [
        { feature: [-1], threshold: [0], defaultLeft: [0], missingZero: [0], left: [0], right: [0], value: [0.5] },
      ],
    });
    expect(() => scoreLegalActions(view, legacy, legal)).toThrow(/does not match/);

    // Identity is content: the bytes on disk must hash to what the manifest
    // recorded, or the run must not start.
    const digestOfBytes = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(digestOfBytes).toMatch(/^[0-9a-f]{64}$/);
    const manifestPath = join(OUT, "candidate-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      candidate: { modelSha256: string };
    };
    expect(manifest.candidate.modelSha256).toBe(digestOfBytes);
    // A selector handed an empty legal set must throw, never invent an action.
    const policy = createQModelPolicy(model, String(raw.modelSha256));
    expect(() =>
      policy({
        context: { kind: "play", view: {} as PlayingPlayerView, legalActions: [] },
        seat: "human",
        role: "landlord",
        dealSeed: 0,
        gameSeed: 0,
        decisionIndex: 0,
      }),
    ).toThrow();
  }, 300_000);

  it("measures the landlord decision path on its own", () => {
    const models = loadRoleModels();
    const model = models.landlord.model;
    const standalone = createQModelPolicy(model, models.landlord.sha256);
    const states = landlordStates();

    const enumerateMs: number[] = [];
    const featureMs: number[] = [];
    const scoreMs: number[] = [];
    const totalMs: number[] = [];
    const actionCounts: number[] = [];

    for (const state of states) {
      const t0 = performance.now();
      const legal = generateLegalActions({ hand: state.view.hand, currentPlay: state.view.currentPlay });
      const t1 = performance.now();
      const features = stateFeaturesOf(state.view);
      const rows = legal.map((action) => selfplayRowFromState(state.view, features, action));
      const t2 = performance.now();
      const scores = rows.map((row) => scoreTrees(model, row));
      const t3 = performance.now();
      const chosen = argmaxAction(scores);
      const t4 = performance.now();

      // The measured path must be the path the policy takes.
      const viaPolicy = standalone({
        context: Object.freeze({ kind: "play" as const, view: state.view, legalActions: legal }),
        seat: state.seat as DecisionInput["seat"],
        role: "landlord",
        dealSeed: 0,
        gameSeed: 0,
        decisionIndex: 0,
      });
      expect(cfCommandKey(cfActionCommand(state.seat as DecisionInput["seat"], legal[chosen]!))).toBe(
        cfCommandKey(cfActionCommand(state.seat as DecisionInput["seat"], viaPolicy)),
      );

      enumerateMs.push(t1 - t0);
      featureMs.push(t2 - t1);
      scoreMs.push(t3 - t2);
      totalMs.push(t4 - t0);
      actionCounts.push(legal.length);
    }

    const pct = (values: readonly number[], fraction: number): number => {
      const sorted = [...values].sort((a, b) => a - b);
      const position = fraction * (sorted.length - 1);
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      const weight = position - lower;
      return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
    };

    const raw = readFileSync(join(REH, "train-input", "landlord.model.json"));
    const gz = gzipSync(raw, { level: 9 }).length;
    const pi1Raw = readFileSync(join(ROOT, "src/app/ai/cf-model-data.ts"));
    const pi1Gz = gzipSync(pi1Raw, { level: 9 }).length;

    const lines = [
      `[landlord-runtime] ${states.length} landlord decisions, one model, no pruning`,
      `  legal actions   p50 ${pct(actionCounts, 0.5).toFixed(1)}  p95 ${pct(actionCounts, 0.95).toFixed(1)}  ` +
        `p99 ${pct(actionCounts, 0.99).toFixed(1)}  max ${Math.max(...actionCounts)}`,
      `  enumerate ms    p50 ${pct(enumerateMs, 0.5).toFixed(3)}  p95 ${pct(enumerateMs, 0.95).toFixed(3)}  max ${Math.max(...enumerateMs).toFixed(3)}`,
      `  features ms     p50 ${pct(featureMs, 0.5).toFixed(3)}  p95 ${pct(featureMs, 0.95).toFixed(3)}  max ${Math.max(...featureMs).toFixed(3)}`,
      `  scoring ms      p50 ${pct(scoreMs, 0.5).toFixed(3)}  p95 ${pct(scoreMs, 0.95).toFixed(3)}  max ${Math.max(...scoreMs).toFixed(3)}`,
      `  total ms        p50 ${pct(totalMs, 0.5).toFixed(3)}  p95 ${pct(totalMs, 0.95).toFixed(3)}  ` +
        `p99 ${pct(totalMs, 0.99).toFixed(3)}  max ${Math.max(...totalMs).toFixed(3)}`,
      `  landlord model  raw ${raw.length} B = ${(raw.length / 1e6).toFixed(3)} MB   gzip ${gz} B = ${(gz / 1024).toFixed(1)} KB`,
      `  combined assets new landlord + existing pi1 farmer: raw ${((raw.length + pi1Raw.length) / 1e6).toFixed(3)} MB, ` +
        `gzip ${((gz + pi1Gz) / 1024).toFixed(1)} KB`,
      `  pi1 farmer alone  raw ${(pi1Raw.length / 1e6).toFixed(3)} MB, gzip ${(pi1Gz / 1024).toFixed(1)} KB ` +
        `(previous worker bundle gzip budget 123,575 B)`,
    ];
    report(lines.join("\n"));
    writeFileSync(join(OUT, "landlord-runtime.txt"), `${lines.join("\n")}\n`);
    writeFileSync(
      join(OUT, "landlord-runtime.json"),
      JSON.stringify(
        {
          label: "DEVELOPMENT_ONLY",
          decisions: states.length,
          landlordModelRawBytes: raw.length,
          landlordModelGzipBytes: gz,
          pi1ModelRawBytes: pi1Raw.length,
          pi1ModelGzipBytes: pi1Gz,
          latencyMs: {
            total: { p50: pct(totalMs, 0.5), p95: pct(totalMs, 0.95), p99: pct(totalMs, 0.99), max: Math.max(...totalMs) },
            enumerate: { p50: pct(enumerateMs, 0.5), p95: pct(enumerateMs, 0.95) },
            features: { p50: pct(featureMs, 0.5), p95: pct(featureMs, 0.95) },
            scoring: { p50: pct(scoreMs, 0.5), p95: pct(scoreMs, 0.95) },
          },
          actionCounts: { p50: pct(actionCounts, 0.5), p95: pct(actionCounts, 0.95), max: Math.max(...actionCounts) },
        },
        null,
        2,
      ),
    );
  }, 900_000);
});
