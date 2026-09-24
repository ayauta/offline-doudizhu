/**
 * Evaluation B — full-policy takeover.
 *
 * The tested seat plays a candidate model at **every one of its decisions for
 * the whole game**; the other two seats play π1 throughout; exploration is off
 * everywhere. The baseline arm is the same deal with all three seats on π1.
 *
 * This is the measurement the single-step diagnostic is not. A single forced
 * action says what one deviation is worth under a frozen continuation; a
 * takeover says what happens when the policy keeps choosing, including in the
 * states its own choices created. Those can disagree, and when they do the
 * disagreement is the finding.
 *
 * Statistical unit: the initial deal group. The three roles are reported
 * separately and never averaged into one number that could hide a regression.
 *
 * ```
 *   AI_SELFPLAY_EVAL_B=1 vite... benchmarks/selfplay-eval-b.test.ts
 * ```
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel } from "../src/core/ai/cf-model.js";
import {
  DEFAULT_MIXTURE_WEIGHTS,
  createPi1Bundle,
  createQBundle,
  createTierBundle,
  scenarioSpec,
  type MixtureSpec,
  type PolicyBundle,
  type SelfPlayRole,
} from "./selfplay-policy.js";
import {
  collectEpisode,
  type CollectorConfig,
  type ScenarioSpecName,
} from "./selfplay-collector.js";

const ENABLED = process.env.AI_SELFPLAY_EVAL_B === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = process.env.AI_SELFPLAY_EVAL_B_OUT ?? join(ROOT, ".local", "selfplay-eval-b");

/** Frozen by the rehearsal protocol: a fresh, development-only pool. */
const START = Number(process.env.AI_SELFPLAY_EVAL_B_START ?? 915_001);
const GROUPS = Number(process.env.AI_SELFPLAY_EVAL_B_GROUPS ?? 1_200);

const ROLES: readonly SelfPlayRole[] = ["landlord", "farmer-next", "farmer-previous"];
const SCENARIO_OF_ROLE: Readonly<Record<SelfPlayRole, ScenarioSpecName>> = Object.freeze({
  landlord: "L",
  "farmer-next": "F-next",
  "farmer-previous": "F-prev",
});
const MODEL_DIR = join(ROOT, ".local", "selfplay-reh");

function report(line: string): void {
  console.log(line);
}

/**
 * A bundle that plays `candidate` in exactly one role and π1 in the other two.
 *
 * Because the collector picks a policy by the *role* a seat is playing rather
 * than by the seat itself, assigning this bundle to every seat is what makes
 * "one seat takes over" true by construction: the tested seat finds the
 * candidate, the other two find π1.
 */
function takeoverBundle(
  role: SelfPlayRole,
  candidate: PolicyBundle,
  pi1: PolicyBundle,
  bundleId: string,
): PolicyBundle {
  return Object.freeze({
    bundleId,
    identity: `takeover:${role}:${candidate.identity}`,
    roles: Object.freeze({
      landlord: role === "landlord" ? candidate.roles.landlord : pi1.roles.landlord,
      "farmer-next":
        role === "farmer-next" ? candidate.roles["farmer-next"] : pi1.roles["farmer-next"],
      "farmer-previous":
        role === "farmer-previous"
          ? candidate.roles["farmer-previous"]
          : pi1.roles["farmer-previous"],
    }),
  });
}

function configFor(bundles: ReadonlyMap<string, PolicyBundle>, learningBundleId: string): CollectorConfig {
  const mixture: MixtureSpec = Object.freeze({
    version: "fas-mixture-v1",
    current: learningBundleId,
    history: Object.freeze([...bundles.keys()].filter((id) => id !== learningBundleId)),
    weights: DEFAULT_MIXTURE_WEIGHTS,
  });
  return Object.freeze({
    bundles,
    learningBundleId,
    mixture,
    epsilon: 0,
    explorationSalt: 0,
    mixtureSalt: 0,
    auditProposal: false,
  });
}

function loadQBundle(branch: string): PolicyBundle {
  const models = {} as Record<SelfPlayRole, ReturnType<typeof parseTreeModel>>;
  const digests = {} as Record<SelfPlayRole, string>;
  for (const role of ROLES) {
    const raw = JSON.parse(
      readFileSync(join(MODEL_DIR, branch, "train-input", `${role}.model.json`), "utf8"),
    ) as { modelSha256: string };
    models[role] = parseTreeModel(raw);
    digests[role] = raw.modelSha256;
  }
  return createQBundle(
    Object.fromEntries(ROLES.map((role) => [role, { model: models[role], sha256: digests[role] }])) as Record<
      SelfPlayRole,
      { model: ReturnType<typeof parseTreeModel>; sha256: string }
    >,
    `SP-${branch}`,
  );
}

describe.skipIf(!ENABLED)("evaluation B: full-policy takeover", () => {
  it("compares whole-game takeover against π1, per role", () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const pi1 = createPi1Bundle("master");
    const throwaway = createTierBundle("THROWAWAY", "master");
    const cheap = loadQBundle("CHEAP");
    const target = loadQBundle("TARGET");
    const candidates: readonly (readonly [string, PolicyBundle])[] = [
      ["CHEAP", cheap],
      ["TARGET", target],
    ];

    const started = Date.now();
    const rows: Record<string, unknown>[] = [];

    for (let offset = 0; offset < GROUPS; offset += 1) {
      const dealIndex = START + offset;
      for (const role of ROLES) {
        const scenario = SCENARIO_OF_ROLE[role];
        const spec = scenarioSpec(dealIndex, scenario);
        // Sanity: the tested seat must actually be playing the role we think.
        if (spec.role !== role) {
          throw new Error(`Role/scenario mismatch at ${dealIndex} ${scenario}: ${spec.role} vs ${role}`);
        }

        const baselineBundles = new Map<string, PolicyBundle>([["PI1", pi1]]);
        const baseline = collectEpisode(configFor(baselineBundles, "PI1"), dealIndex, scenario);
        const record: Record<string, unknown> = {
          dealIndex,
          role,
          scenario,
          testedSeat: spec.learningSeat,
          plies: baseline.audit.plies,
          parentWon: baseline.learningTeamWon,
        };

        for (const [name, candidate] of candidates) {
          const bundleId = `${name}-takeover-${role}`;
          const bundles = new Map<string, PolicyBundle>([
            [bundleId, takeoverBundle(role, candidate, pi1, bundleId)],
            ["THROWAWAY", throwaway],
          ]);
          const episode = collectEpisode(configFor(bundles, bundleId), dealIndex, scenario);
          record[`${name}Won`] = episode.learningTeamWon;
          record[`${name}Plies`] = episode.audit.plies;
          record[`${name}Decisions`] = episode.records.length;
        }
        rows.push(record);
      }
    }

    const elapsed = Date.now() - started;
    const paired = (
      subset: readonly Record<string, unknown>[],
      left: string,
      right: string,
    ): { mean: number; se: number; better: number; worse: number; ties: number } => {
      const d = subset.map((row) => (row[right] ? 1 : 0) - (row[left] ? 1 : 0));
      const n = Math.max(1, d.length);
      const mean = d.reduce((sum, value) => sum + value, 0) / n;
      const variance = d.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, n - 1);
      return {
        mean,
        se: Math.sqrt(variance / n),
        better: d.filter((value) => value > 0).length,
        worse: d.filter((value) => value < 0).length,
        ties: d.filter((value) => value === 0).length,
      };
    };

    const lines = [
      `[eval-b] full-policy takeover, ${GROUPS} deal groups x 3 roles (${rows.length} cells)`,
      `  wall ${(elapsed / 60000).toFixed(1)} min   mean plies ${(rows.reduce((s, r) => s + (r.plies as number), 0) / rows.length).toFixed(2)}`,
    ];
    const summary: Record<string, unknown> = {};
    for (const role of ROLES) {
      const subset = rows.filter((row) => row.role === role);
      const line: string[] = [`  ${role} (${subset.length} groups)`];
      for (const [name] of candidates) {
        const vs = paired(subset, "parentWon", `${name}Won`);
        summary[`${role}.${name}`] = vs;
        line.push(
          `${name}: pi1 ${(100 * subset.filter((r) => r.parentWon).length) / subset.length}% ` +
            `vs ${(100 * subset.filter((r) => r[name + "Won"]).length) / subset.length}%  ` +
            `Δ ${(100 * vs.mean).toFixed(3)}pp ± ${(100 * 1.96 * vs.se).toFixed(3)}pp  ` +
            `(${vs.better}/${vs.worse}/${vs.ties})`,
        );
      }
      const cross = paired(subset, "CHEAPWon", "TARGETWon");
      summary[`${role}.TARGET-CHEAP`] = cross;
      line.push(
        `TARGET-CHEAP Δ ${(100 * cross.mean).toFixed(3)}pp ± ${(100 * 1.96 * cross.se).toFixed(3)}pp  ` +
          `(${cross.better}/${cross.worse}/${cross.ties})`,
      );
      lines.push(line.join("   "));
    }
    report(lines.join("\n"));
    writeFileSync(join(OUT_DIR, "eval-b-report.txt"), `${lines.join("\n")}\n`);
    writeFileSync(
      join(OUT_DIR, "eval-b-summary.json"),
      JSON.stringify(
        {
          label: "DEVELOPMENT_ONLY",
          evaluation: "full-policy-takeover",
          pool: [START, START + GROUPS - 1],
          groups: GROUPS,
          wallSeconds: elapsed / 1000,
          summary,
          rows,
          contentDigest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
        },
        null,
        2,
      ),
    );
    expect(rows.length).toBeGreaterThan(0);
  }, 86_400_000);
});
