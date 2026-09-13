/**
 * Spec 027 step 2 — does an exact endgame branch change the move at all?
 *
 * A branch that never differs from the shipped master is worthless however exact
 * it is, so this is the gate that decides whether the line is worth building.
 * It is offline: nothing here touches `src/`.
 *
 * Scope on purpose: only positions whose unknown is one card. That keeps the
 * enumeration exact and cheap, and it is the largest single band of endgames
 * (13.1% of master decisions per the Spec 025 measurement).
 *
 * Research scaffolding. Not shipped, not imported by `src/`.
 */

import { describe, expect, it } from "vitest";

import { ENHANCED_AI_SEARCH } from "../../src/app/ai/decision-handler.js";
import { createPlayerView } from "../../src/core/ai/index.js";
import { rankMasterPlayActions } from "../../src/core/ai/enhanced.js";
import { generateLegalActions } from "../../src/core/rules/index.js";
import { beliefOf, proposeExact } from "./endgame-branch.js";
import { replayToDecision } from "./roll-forward.js";
import { runProbe } from "./harvest.js";

const DEALS = Number(process.env.AI_BRANCH_DEALS ?? "20");
const MAX_WORLDS = Number(process.env.AI_BRANCH_MAX_WORLDS ?? "60");
const MAX_UNKNOWN = Number(process.env.AI_BRANCH_MAX_UNKNOWN ?? "4");

function keyOfCards(cards: readonly number[]): string {
  return [...cards].sort((left, right) => left - right).join(",");
}

function keyOfCommand(command: { readonly type: string; readonly cards?: readonly number[] }): string {
  return command.type !== "play" ? "pass" : keyOfCards(command.cards ?? []);
}

describe("spec 027 — does the branch change the move", () => {
  it(`measures ${String(DEALS)} deals of master endgames`, async () => {
    const harvest = await runProbe({ seedBase: 301, deals: DEALS, strongProfile: "master", quiet: true });

    let enumerated = 0;
    let compared = 0;
    let diverged = 0;
    let sameAggregate = 0;
    let totalNodes = 0;
    const byBand = new Map<number, { compared: number; diverged: number; nodes: number }>();
    const examples: string[] = [];

    for (const record of harvest.records) {
      const state = replayToDecision(record.snapshot, record.snapshot.prefix);
      const view = createPlayerView(state, record.seat);
      if (view === null || view.phase === "bidding") {
        continue;
      }
      const belief = beliefOf(view);
      if (belief === null || belief.smallerCount > MAX_UNKNOWN || belief.worlds > MAX_WORLDS) {
        continue;
      }
      enumerated += 1;
      const band = belief.smallerCount;

      const context = Object.freeze({
        kind: "play" as const,
        view,
        legalActions: generateLegalActions({ hand: view.hand, currentPlay: view.currentPlay }),
      });
      // The shipped move, with the production master's own options. Read from
      // the shipped constant: a retyped 32 measured a rollout four times the
      // size the target phone can afford, under a comment claiming otherwise.
      const shipped = rankMasterPlayActions(context, {
        ...ENHANCED_AI_SEARCH,
        seed: 424_242,
      })[0]?.action;
      const shippedKey = shipped === undefined ? "pass" : keyOfCommand(shipped);

      const proposal = proposeExact(state, { maxWorlds: MAX_WORLDS });
      if (proposal === null || !proposal.completed) {
        continue;
      }
      compared += 1;
      totalNodes += proposal.nodes;
      const entry = byBand.get(band) ?? { compared: 0, diverged: 0, nodes: 0 };
      entry.compared += 1;
      entry.nodes += proposal.nodes;
      byBand.set(band, entry);
      // Compare the two aggregates by the action each led with. `maximin` is a
      // 0/1 "wins in every world" flag, so dividing it by the world count and
      // comparing to the expected rate measured nothing.
      if (proposal.choice === proposal.expectedChoice) {
        sameAggregate += 1;
      }
      if (proposal.choice !== shippedKey) {
        diverged += 1;
        const bandEntry = byBand.get(band);
        if (bandEntry !== undefined) {
          bandEntry.diverged += 1;
        }
        if (examples.length < 5) {
          examples.push(
            [
              `  seat=${record.seat} landlord=${view.landlord} hand=${String(view.hand.length)} worlds=${String(belief.worlds)}`,
              `    shipped=${shippedKey}`,
              `    branch =${proposal.choice}`,
              `    legal  =${context.legalActions
                .map((entry) => keyOfCommand(entry.type === "play" ? { type: "play", cards: entry.play.cards } : { type: "pass" }))
                .join(" | ")}`,
            ].join("\n"),
          );
        }
      }
    }

    const rate = compared === 0 ? 0 : (diverged / compared) * 100;
    console.log(
      [
        "",
        `positions with one unknown card: ${String(enumerated)}`,
        `compared against the shipped move: ${String(compared)}`,
        `diverged: ${String(diverged)} (${rate.toFixed(1)}%)`,
        `mean nodes per decision: ${compared === 0 ? "n/a" : (totalNodes / compared).toFixed(0)}`,
        `decisions where maximin and expected chose the same action: ${String(sameAggregate)}`,
        "",
        "by unknown-card band (device cost uses the measured 238 us/node):",
        ...[...byBand.entries()].sort((left, right) => left[0] - right[0]).map(([cards, entry]) => {
          const mean = entry.nodes / Math.max(1, entry.compared);
          const seconds = (mean * 238) / 1_000_000;
          return `  ${String(cards)} unknown | ${String(entry.compared).padStart(3)} compared | ${String(entry.diverged).padStart(3)} diverged | mean ${mean.toFixed(0).padStart(7)} nodes | ~${seconds.toFixed(2)}s on device`;
        }),
        "",
        ...examples,
        "",
      ].join("\n"),
    );
    expect(compared).toBeGreaterThan(0);
  }, 1_800_000);
});
