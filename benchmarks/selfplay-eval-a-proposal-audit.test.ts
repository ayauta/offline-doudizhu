/**
 * Evaluation A support: how often each arm's chosen action leaves the old
 * candidate sets.
 *
 * Evaluation A records action *indices*, and an index only means something next
 * to the state it came from. This audit re-derives the root for a fixed,
 * evenly-spaced subsample of the same pool and asks the question directly:
 * of the actions CHEAP and TARGET pick, how many are outside production's old
 * top-3 and top-5?
 *
 * The subsample is every 50th group — fixed here, before looking — and it is
 * labelled as a subsample wherever it is reported. C3 is
 * `cfProposal(context).actions.slice(0, 3)`; C5 is `cfProposal5`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel, type TreeModel } from "../src/core/ai/cf-model.js";
import { generateLegalActions } from "../src/core/rules/index.js";
import { cfProposal, CF_CANDIDATE_LIMIT } from "../src/app/ai/cf-selector.js";
import { cfProposal5 } from "./cf-top5.js";
import {
  argmaxAction,
  createPi1Bundle,
  createTierBundle,
  roleOfSeat,
  scoreLegalActions,
  type MixtureSpec,
  type PolicyBundle,
  type SelfPlayRole,
} from "./selfplay-policy.js";
import { collectEpisode, type CollectorConfig, type ScenarioSpecName } from "./selfplay-collector.js";
import { actionIdentity } from "./selfplay-actions.js";

const ENABLED = process.env.AI_SELFPLAY_EVAL_A_AUDIT === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_DIR = join(ROOT, ".local", "selfplay-eval-a");

const START = 900_001;
const GROUPS = 6_000;
const STRIDE = 50;
const ROLES: readonly SelfPlayRole[] = ["landlord", "farmer-next", "farmer-previous"];
const SCENARIOS: readonly ScenarioSpecName[] = ["L", "F-next", "F-prev"];
const MODEL_DIR = join(ROOT, ".local", "selfplay-reh");

function loadModels(branch: string): Record<SelfPlayRole, TreeModel> {
  const models = {} as Record<SelfPlayRole, TreeModel>;
  for (const role of ROLES) {
    models[role] = parseTreeModel(
      JSON.parse(readFileSync(join(MODEL_DIR, branch, "train-input", `${role}.model.json`), "utf8")),
    );
  }
  return models;
}

function environment(): CollectorConfig {
  const bundles = new Map<string, PolicyBundle>([
    ["PI1", createPi1Bundle("master")],
    ["MASTER", createTierBundle("MASTER", "master")],
  ]);
  const mixture: MixtureSpec = Object.freeze({
    version: "fas-mixture-v1",
    current: "PI1",
    history: Object.freeze(["MASTER"]),
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

describe.skipIf(!ENABLED)("evaluation A: C3/C5 membership of each arm's pick", () => {
  it("reports how often CHEAP and TARGET leave the old candidate sets", () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const config = environment();
    const cheap = loadModels("CHEAP");
    const target = loadModels("TARGET");

    const tally = {
      groups: 0,
      parentInC3: 0,
      cheapInC3: 0,
      targetInC3: 0,
      parentInC5: 0,
      cheapInC5: 0,
      targetInC5: 0,
      cheapEqualsParent: 0,
      targetEqualsParent: 0,
    };
    const rows: Record<string, unknown>[] = [];

    for (let offset = 0; offset < GROUPS; offset += STRIDE) {
      const dealIndex = START + offset;
      const scenario = SCENARIOS[offset % SCENARIOS.length]!;
      const baseline = collectEpisode(config, dealIndex, scenario);
      const record = baseline.records.find((entry) => entry.legalActionCount >= 2);
      if (record === undefined) {
        continue;
      }
      const view = record.view;
      const legal = generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay });
      const role = roleOfSeat(view.seat, view.landlord);
      const context = Object.freeze({ kind: "play" as const, view, legalActions: legal });

      let c3: Set<string>;
      let c5: Set<string>;
      try {
        c3 = new Set(
          cfProposal(context).actions.slice(0, CF_CANDIDATE_LIMIT).map((action) => actionIdentity(action)),
        );
        c5 = new Set(cfProposal5(context).actions.map((action) => actionIdentity(action)));
      } catch {
        continue;
      }

      const parent = actionIdentity(legal[record.greedyIndex]!);
      const cheapPick = actionIdentity(
        legal[argmaxAction(scoreLegalActions(view, cheap[role], legal).scores)]!,
      );
      const targetPick = actionIdentity(
        legal[argmaxAction(scoreLegalActions(view, target[role], legal).scores)]!,
      );

      tally.groups += 1;
      tally.parentInC3 += c3.has(parent) ? 1 : 0;
      tally.cheapInC3 += c3.has(cheapPick) ? 1 : 0;
      tally.targetInC3 += c3.has(targetPick) ? 1 : 0;
      tally.parentInC5 += c5.has(parent) ? 1 : 0;
      tally.cheapInC5 += c5.has(cheapPick) ? 1 : 0;
      tally.targetInC5 += c5.has(targetPick) ? 1 : 0;
      tally.cheapEqualsParent += cheapPick === parent ? 1 : 0;
      tally.targetEqualsParent += targetPick === parent ? 1 : 0;
      rows.push({ dealIndex, role, parent, cheapPick, targetPick });
    }

    const n = tally.groups;
    const pct = (value: number): string => `${((100 * value) / n).toFixed(2)}%`;
    const lines = [
      `[eval-a audit] fixed subsample: every ${STRIDE}th group of 900001..906000 -> ${n} groups`,
      `  in old C3   parent ${pct(tally.parentInC3)}   CHEAP ${pct(tally.cheapInC3)}   TARGET ${pct(tally.targetInC3)}`,
      `  in old C5   parent ${pct(tally.parentInC5)}   CHEAP ${pct(tally.cheapInC5)}   TARGET ${pct(tally.targetInC5)}`,
      `  outside C3  parent ${pct(n - tally.parentInC3)}   CHEAP ${pct(n - tally.cheapInC3)}   TARGET ${pct(n - tally.targetInC3)}`,
      `  outside C5  parent ${pct(n - tally.parentInC5)}   CHEAP ${pct(n - tally.cheapInC5)}   TARGET ${pct(n - tally.targetInC5)}`,
      `  pick == pi1 action   CHEAP ${pct(tally.cheapEqualsParent)}   TARGET ${pct(tally.targetEqualsParent)}`,
    ];
    console.log(lines.join("\n"));
    writeFileSync(join(OUT_DIR, "proposal-audit.txt"), `${lines.join("\n")}\n`);
    writeFileSync(
      join(OUT_DIR, "proposal-audit.json"),
      JSON.stringify(
        { label: "DEVELOPMENT_ONLY", subsampleStride: STRIDE, groups: n, tally, contentDigest: createHash("sha256").update(JSON.stringify(rows)).digest("hex") },
        null,
        2,
      ),
    );
    expect(n).toBeGreaterThan(0);
  }, 3_600_000);
});
