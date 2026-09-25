/**
 * H5 v1's gates at benchmark scale: the recorded corpus, and a shipped-path
 * dump comparison.
 *
 * Two legs, both mechanical — neither plays a game to learn a strength number.
 *
 * 1. **Corpus** (`AI_BENCH_H5_CORPUS`, default `.local/calibration`). The E1
 *    calibration corpus stores every leaf of every master decision in
 *    `5001–5400`, including which seat emptied its hand in each trajectory. That
 *    is ground truth for the gate: the verdicts are known independently of the
 *    implementation, and one candidate's terminal evidence is observable without
 *    an observation seam in shipped code. The leg therefore replays production's
 *    ranking from the stored leaves — a fidelity anchor, since it must
 *    reproduce the recorded choice — and then holds the gated form to the
 *    frozen contract decision by decision.
 *
 * 2. **Dump identity** (`AI_BENCH_H5_IDENTITY=<production.json>,<gate02.json>`).
 *    Runs the shipped decision path in two builds over the same designed deals
 *    and demands byte-identical commands. The mechanism's own identity claim is
 *    "at `W_gate = 0.2` the score is production's, bit for bit"; only the real
 *    path, playing real deals, can settle that.
 *
 *   corpus:  AI_BENCH_H5_CORPUS=.local/calibration vitest run ... benchmarks/h5-gate.test.ts
 *   dumps:   AI_BENCH_H5_IDENTITY=<base>,<cand> vitest run ... benchmarks/h5-gate.test.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { estimateBasicHandTurns } from "../src/core/ai/hand-analyzer.js";
import {
  ROLLOUT_BLEND_WEIGHT,
  rolloutBlendedScore,
  terminalVerdict,
  type CandidateRollout,
} from "../src/core/ai/enhanced.js";
import type { Seat } from "../src/core/game/index.js";
import { formatPercent } from "./ai-stats.js";
import { report } from "./ai-tournament.js";
import {
  shippedUtility,
  type CorpusDecision,
  type CorpusShard,
} from "./leaf-corpus.js";

const CORPUS_DIR = process.env.AI_BENCH_H5_CORPUS ?? ".local/calibration";
const IDENTITY = process.env.AI_BENCH_H5_IDENTITY;
/** H5 v1's frozen W_gate: terminal utility back at its original design scale. */
const GATE_WEIGHT = 1;
const TERMINAL_UTILITY = 10_000;

/** The exact 64 bits of a double: a bit-identity claim needs bit comparisons. */
function bits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16);
}

function sameSide(seat: Seat, other: Seat, landlord: Seat): boolean {
  return seat === landlord ? other === landlord : other !== landlord;
}

/** Production's ordering: score descending, then the earlier candidate. */
function orderOf(scores: readonly number[]): readonly number[] {
  return scores
    .map((score, index) => ({ score, index }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.index);
}

function loadCorpus(directory: string): readonly CorpusDecision[] {
  const decisions: CorpusDecision[] = [];
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const parsed = JSON.parse(readFileSync(join(directory, name), "utf8")) as Partial<CorpusShard>;
    if (Array.isArray(parsed.decisions)) {
      decisions.push(...parsed.decisions);
    }
  }
  return decisions;
}

describe.runIf(existsSync(CORPUS_DIR))("H5 v1 against the recorded corpus", () => {
  it("reproduces production's ranking, then holds the gated form to the freeze", () => {
    const decisions = loadCorpus(CORPUS_DIR);
    expect(decisions.length).toBeGreaterThan(0);

    const verdictCounts = new Map<string, number>();
    let candidates = 0;
    let gatedCandidates = 0;
    let identityBreaks = 0;
    let orderingBreaks = 0;
    let replayMismatches = 0;
    let decisionsWithGatedCandidate = 0;
    let decisionsWhoseChoiceMoves = 0;
    let terminalTrajectories = 0;
    let gatedTrajectories = 0;

    for (const decision of decisions) {
      const root = { seat: decision.seat, landlord: decision.landlord };
      const worlds = decision.completedWorlds;
      // Rebuild each candidate's rollout accumulation from the stored leaves,
      // exactly as the shipped loop accumulates it in memory.
      const rollouts: Array<{
        expertScore: number;
        total: number;
        terminalTotal: number;
        terminalWinners: (Seat | null)[];
      }> = decision.expertScores.map((expertScore) => ({
        expertScore,
        total: 0,
        terminalTotal: 0,
        terminalWinners: [],
      }));
      const leafCounts = decision.expertScores.map(() => 0);
      for (const leaf of decision.leaves) {
        const rollout = rollouts[leaf.candidate];
        if (rollout === undefined) {
          throw new Error(`leaf names candidate ${leaf.candidate}, outside the shortlist`);
        }
        leafCounts[leaf.candidate] = (leafCounts[leaf.candidate] ?? 0) + 1;
        const utility = shippedUtility(decision, leaf, estimateBasicHandTurns);
        rollout.total += utility;
        if (leaf.winner !== null) {
          rollout.terminalTotal += utility;
          rollout.terminalWinners.push(leaf.winner);
        }
      }
      // A world is counted only after every candidate was rolled out in it, so
      // every candidate has exactly `completedWorlds` leaves. Anything else
      // would mean the divisor below is a different number than production's.
      for (const count of leafCounts) {
        expect(count).toBe(worlds);
      }

      const production = rollouts.map(
        (rollout: CandidateRollout) => rolloutBlendedScore(rollout, root, worlds, undefined),
      );
      const identity = rollouts.map(
        (rollout: CandidateRollout) =>
          rolloutBlendedScore(rollout, root, worlds, ROLLOUT_BLEND_WEIGHT),
      );
      const gated = rollouts.map(
        (rollout: CandidateRollout) => rolloutBlendedScore(rollout, root, worlds, GATE_WEIGHT),
      );

      // Fidelity anchor: the replayed production ranking must land on the
      // choice the shipped code actually made, or nothing below means anything.
      if ((orderOf(production)[0] ?? -1) !== decision.chosen) {
        replayMismatches += 1;
      }
      if (orderOf(identity).join() !== orderOf(production).join()) {
        orderingBreaks += 1;
      }
      if ((orderOf(gated)[0] ?? -1) !== decision.chosen) {
        decisionsWhoseChoiceMoves += 1;
      }

      let gatedHere = 0;
      rollouts.forEach((rollout, index) => {
        candidates += 1;
        if (bits(identity[index] ?? 0) !== bits(production[index] ?? 0)) {
          identityBreaks += 1;
        }
        // Ground truth, read from the recorded winners rather than from the
        // implementation: which way this candidate's terminal trajectories
        // point, from the root seat's side.
        const winners = rollout.terminalWinners;
        const rootWon = winners.map((winner) =>
          winner === null ? null : sameSide(decision.seat, winner, decision.landlord)
        );
        const expected = winners.length === 0
          ? "none"
          : rootWon.some((entry) => entry === null)
            ? "conflicting"
            : rootWon.every((entry) => entry === true)
              ? "win"
              : rootWon.every((entry) => entry === false)
                ? "loss"
                : "conflicting";
        verdictCounts.set(expected, (verdictCounts.get(expected) ?? 0) + 1);
        // The implementation's verdict must agree with that ground truth on
        // every real decision in the corpus.
        expect(terminalVerdict(decision.seat, decision.landlord, winners)).toBe(expected);

        const delta = (gated[index] ?? 0) - (production[index] ?? 0);
        terminalTrajectories += winners.length;
        if (expected === "none" || expected === "conflicting") {
          // No gate: the score must be production's, bit for bit.
          expect(bits(gated[index] ?? 0)).toBe(bits(production[index] ?? 0));
          expect(delta).toBe(0);
          return;
        }
        gatedCandidates += 1;
        gatedHere += 1;
        gatedTrajectories += winners.length;
        // Only the terminal component moves, at the gate's own scale: whole
        // terminal trajectories, never a fraction, never more than the worlds
        // that produced them.
        const quantum = ((GATE_WEIGHT - ROLLOUT_BLEND_WEIGHT) * TERMINAL_UTILITY) / worlds;
        const trajectories = delta / quantum;
        expect(expected === "win" ? delta > 0 : delta < 0).toBe(true);
        expect(Math.abs(trajectories - Math.round(trajectories))).toBeLessThan(1e-6);
        expect(Math.abs(Math.round(trajectories))).toBe(winners.length);
        // And that count is the *whole* increment: nothing from the candidate's
        // non-terminal evidence rides along. The code adds the term exactly;
        // reading it back through a difference of two rounded sums costs an
        // ulp, so the comparison is relative — a leak would be six orders of
        // magnitude larger than that.
        const term = (GATE_WEIGHT - ROLLOUT_BLEND_WEIGHT) * (rollout.terminalTotal / worlds);
        expect(Math.abs(delta - term)).toBeLessThanOrEqual(Math.abs(gated[index] ?? 0) * 1e-12);
      });
      if (gatedHere > 0) {
        decisionsWithGatedCandidate += 1;
      }
    }

    report(`\n== H5 v1 corpus gates (${decisions.length} decisions, ${CORPUS_DIR}) ==`);
    report(`replay fidelity  ${replayMismatches} mismatches vs the recorded choice (must be 0)`);
    report(`identity at 0.2  ${identityBreaks} candidates differ from production (must be 0)`);
    report(`ordering at 0.2  ${orderingBreaks} decisions reorder (must be 0)`);
    report(
      `candidates       ${candidates} total, ${gatedCandidates} gated ` +
      `(${formatPercent(candidates === 0 ? 0 : gatedCandidates / candidates)})`,
    );
    report(
      `decisions        ${decisionsWithGatedCandidate} have a gated candidate ` +
      `(${formatPercent(decisions.length === 0 ? 0 : decisionsWithGatedCandidate / decisions.length)}); ` +
      `${decisionsWhoseChoiceMoves} would choose differently under the gate ` +
      `(${formatPercent(decisions.length === 0 ? 0 : decisionsWhoseChoiceMoves / decisions.length)})`,
    );
    report(
      `verdicts         ${
        [...verdictCounts.entries()].sort().map(([name, count]) => `${name}:${count}`).join("  ")
      }`,
    );
    report(
      `trajectories     ${gatedTrajectories} gated of ${terminalTrajectories} terminal`,
    );

    expect(replayMismatches).toBe(0);
    expect(identityBreaks).toBe(0);
    expect(orderingBreaks).toBe(0);
    // Non-vacuity: a corpus where the gate never opens would make every
    // assertion above trivially true.
    expect(gatedCandidates).toBeGreaterThan(0);
    expect(decisionsWhoseChoiceMoves).toBeGreaterThan(0);
  });
});

type DumpRun = {
  stronger?: string;
  weaker?: string;
  dealStart?: number;
  playedDeals?: number;
  perDealA?: readonly number[];
  perDealB?: readonly number[];
  commands?: readonly string[];
};
type Dump = { label?: string; config?: Record<string, unknown>; runs?: Record<string, DumpRun> };

describe.runIf(IDENTITY !== undefined)("H5 v1 shipped-path identity", () => {
  it("holds two designed runs of the same deals to byte equality", () => {
    const [basePath, candPath] = (IDENTITY as string).split(",");
    expect(basePath, "AI_BENCH_H5_IDENTITY must be <production.json>,<candidate.json>").toBeDefined();
    expect(candPath).toBeDefined();
    const base = JSON.parse(readFileSync(basePath as string, "utf8")) as Dump;
    const cand = JSON.parse(readFileSync(candPath as string, "utf8")) as Dump;
    report(`\n== H5 v1 shipped-path identity ==`);
    report(`production  ${basePath}  (${base.label ?? "?"})`);
    report(`candidate   ${candPath}  (${cand.label ?? "?"})`);
    report(`configs     ${JSON.stringify(base.config)} vs ${JSON.stringify(cand.config)}`);

    const keys = Object.keys(base.runs ?? {}).sort();
    expect(keys.length).toBeGreaterThan(0);
    let differingCommands = 0;
    let comparedCommands = 0;
    for (const key of keys) {
      const left = base.runs?.[key];
      const right = cand.runs?.[key];
      expect(left, `candidate dump is missing pair ${key}`).toBeDefined();
      expect(right, `candidate dump is missing pair ${key}`).toBeDefined();
      const a = left as DumpRun;
      const b = right as DumpRun;
      report(`\n-- ${key} --`);
      report(`deals       ${a.playedDeals} vs ${b.playedDeals} (dealStart ${a.dealStart} vs ${b.dealStart})`);
      expect(b.playedDeals).toBe(a.playedDeals);
      expect(b.dealStart).toBe(a.dealStart);
      expect(b.perDealA).toEqual(a.perDealA);
      expect(b.perDealB).toEqual(a.perDealB);
      report(`per-deal    identical`);

      const leftCommands = a.commands;
      const rightCommands = b.commands;
      if (leftCommands === undefined || rightCommands === undefined) {
        report(`commands    not logged (set AI_BENCH_LOG_COMMANDS=1)`);
        continue;
      }
      const n = Math.min(leftCommands.length, rightCommands.length);
      comparedCommands += n;
      let first = -1;
      for (let index = 0; index < n; index += 1) {
        if (leftCommands[index] !== rightCommands[index]) {
          differingCommands += 1;
          if (first < 0) {
            first = index;
          }
        }
      }
      report(
        `commands    ${differingCommands}/${n} differ ` +
        `(${formatPercent(n === 0 ? 0 : differingCommands / n)}); first at #${first}` +
        (first >= 0 ? "" : " — the two builds are byte-identical on this window"),
      );
      if (first >= 0) {
        report(`  production ${leftCommands[first]}`);
        report(`  candidate  ${rightCommands[first]}`);
      }
      expect(a.commands?.length).toBe(b.commands?.length);
    }
    report(`\ncommands    ${differingCommands} of ${comparedCommands} differ overall`);
    expect(differingCommands).toBe(0);
  });
});
