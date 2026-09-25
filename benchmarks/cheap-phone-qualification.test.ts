/**
 * Android runtime qualification for the CHEAP landlord release candidate.
 *
 *     AI_CHEAP_PHONE=1 npx vitest run --config vitest.benchmark.config.ts \
 *       benchmarks/cheap-phone-qualification.test.ts
 *
 * Reads what `scripts/phone-worker-qualification.mjs` captured from the
 * installed APK and answers the questions the release candidate still owes:
 * did the **shipped Worker** — not a probe's copy of the policy — retain the
 * confirmed action, inside the real 480 ms deadline, on the real device.
 *
 * The captured record carries, per landlord decision, the context the Worker
 * received and the command it returned. The reference is recomputed here from
 * the research evaluator, and the comparison is on the **executed action
 * identity**, never on a score: two policies that agree to twelve decimals and
 * disagree on the argmax are different policies.
 *
 * `implementation regression only, not new strength evidence`. The deals are
 * whatever the device played; no pool is allocated and no fresh group is spent.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTreeModel, type TreeModel } from "../src/core/ai/cf-model.js";
import type { PlayingPlayerView } from "../src/core/ai/index.js";
import type { ValidatedPlayAction } from "../src/core/rules/index.js";
import type { GameCommand, Seat } from "../src/core/game/index.js";
import { cfActionCommand, cfCommandKey } from "../src/app/ai/cf-selector.js";
import { CHEAP_LANDLORD_MODEL_JSON, CHEAP_LANDLORD_MODEL_SHA256 } from "../src/app/ai/cheap-landlord-model.js";
import { argmaxAction, scoreLegalActions } from "./selfplay-policy.js";

const ENABLED = process.env.AI_CHEAP_PHONE === "1";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const INPUT = process.env.AI_CHEAP_PHONE_IN ?? join(ROOT, ".local", "phone-worker.json");
const OUT = join(ROOT, ".local", "cheap-integration", "phone-qualification.json");

const CHEAP_SHA256 = "070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b";
/** The real product deadline. Never relaxed to make a number look better. */
const RESPONSE_WINDOW_MS = 480;
const RETENTION_FLOOR = 0.99;

interface CapturedRecord {
  readonly requestId: number;
  readonly sentAt: number | null;
  readonly receivedAt: number;
  readonly aiType: string | null;
  readonly landlord: boolean | null;
  readonly ok: boolean;
  readonly reason: string | null;
  readonly command: GameCommand | null;
  readonly context: { readonly view: PlayingPlayerView; readonly legalActions: readonly ValidatedPlayAction[] } | null;
}

interface Capture {
  readonly deals: number;
  readonly steps: number;
  readonly wallSeconds: number;
  readonly workerCreatedAt: number | null;
  readonly workerUrl: string | null;
  readonly sent: number;
  readonly injected: number;
  readonly received: number;
  readonly malformed: number;
  readonly errors: readonly string[];
  readonly records: readonly CapturedRecord[];
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

function stats(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? Number.NaN,
  };
}

describe.skipIf(!ENABLED)("Android runtime qualification", () => {
  it("compares the shipped Worker's actions with the research reference", () => {
    expect(existsSync(INPUT), `no capture at ${INPUT}; run scripts/phone-worker-qualification.mjs`).toBe(true);
    const capture = JSON.parse(readFileSync(INPUT, "utf8")) as Capture;

    // The device must have run the confirmed policy, not some other table.
    expect(CHEAP_LANDLORD_MODEL_SHA256).toBe(CHEAP_SHA256);
    expect(CHEAP_LANDLORD_MODEL_JSON).not.toBeNull();
    const model: TreeModel = parseTreeModel(
      JSON.parse(CHEAP_LANDLORD_MODEL_JSON as string),
    );
    expect(model.numFeatures).toBe(403);

    const withContext = capture.records.filter(
      (record) => record.landlord === true && record.context !== null && record.command !== null,
    );
    const landlordRecords = capture.records.filter((record) => record.landlord === true);
    const farmerRecords = capture.records.filter((record) => record.landlord === false);

    const mismatches: Record<string, unknown>[] = [];
    for (const record of withContext) {
      const context = record.context;
      const command = record.command;
      if (context === null || command === null) continue;
      const reference = scoreLegalActions(context.view, model, context.legalActions);
      const action = reference.actions[argmaxAction(reference.scores)];
      if (action === undefined) {
        mismatches.push({ requestId: record.requestId, note: "reference had no action" });
        continue;
      }
      const referenceKey = cfCommandKey(cfActionCommand(context.view.seat as Seat, action));
      const actualKey = cfCommandKey(command);
      if (referenceKey !== actualKey) {
        mismatches.push({ requestId: record.requestId, referenceKey, actualKey });
      }
    }

    // End-to-end round trip, exactly what the product's client waits on.
    const roundTrips = landlordRecords
      .filter((record) => record.sentAt !== null)
      .map((record) => record.receivedAt - (record.sentAt as number));
    const deadlineFallbacks = roundTrips.filter((value) => value > RESPONSE_WINDOW_MS).length;
    const otherFallbacks = landlordRecords.filter((record) => !record.ok).length;
    const retention = landlordRecords.length === 0 ? 0 : 1 - (deadlineFallbacks + otherFallbacks) / landlordRecords.length;

    const firstLandlord = landlordRecords
      .filter((record) => record.sentAt !== null)
      .sort((left, right) => (left.sentAt as number) - (right.sentAt as number))[0];
    const coldMs = firstLandlord === undefined
      ? null
      : firstLandlord.receivedAt - (firstLandlord.sentAt as number);
    const workerStartupMs = capture.workerCreatedAt === null || firstLandlord === undefined
      ? null
      : (firstLandlord.sentAt as number) - capture.workerCreatedAt;

    const report = {
      deals: capture.deals,
      wallSeconds: capture.wallSeconds,
      workerUrl: capture.workerUrl,
      workerErrors: capture.errors,
      sent: capture.sent,
      received: capture.received,
      injected: capture.injected,
      malformed: capture.malformed,
      landlordDecisions: landlordRecords.length,
      farmerDecisions: farmerRecords.length,
      landlordWithContext: withContext.length,
      implementationMismatches: mismatches.length,
      mismatchExamples: mismatches.slice(0, 5),
      roundTrip: stats(roundTrips),
      responseWindowMs: RESPONSE_WINDOW_MS,
      deadlineFallbacks,
      otherFallbacks,
      retention,
      retentionFloor: RETENTION_FLOOR,
      coldFirstLandlordMs: coldMs,
      workerStartupToFirstRequestMs: workerStartupMs,
      farmerRoundTrip: stats(
        farmerRecords
          .filter((record) => record.sentAt !== null)
          .map((record) => record.receivedAt - (record.sentAt as number)),
      ),
      farmerFallbacks: farmerRecords.filter((record) => !record.ok).length,
    };

    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const line = (label: string, value: ReturnType<typeof stats>) =>
      `[clq] ${label.padEnd(12)} n ${value.n} p50 ${value.p50.toFixed(1)} p90 ${value.p90.toFixed(1)} ` +
      `p95 ${value.p95.toFixed(1)} p99 ${value.p99.toFixed(1)} max ${value.max.toFixed(1)} ms`;
    console.log(
      `[clq] deals ${report.deals} in ${report.wallSeconds.toFixed(0)}s; worker ${report.workerUrl}`,
    );
    console.log(
      `[clq] sent ${report.sent} received ${report.received} injected ${report.injected} ` +
        `malformed ${report.malformed} errors ${report.workerErrors.length}`,
    );
    console.log(
      `[clq] landlord ${report.landlordDecisions} (with context ${report.landlordWithContext}), ` +
        `farmer ${report.farmerDecisions}`,
    );
    console.log(line("landlord rt", report.roundTrip));
    console.log(line("farmer rt", report.farmerRoundTrip));
    console.log(
      `[clq] E1 mismatches ${report.implementationMismatches}; deadline fallbacks ${report.deadlineFallbacks}; ` +
        `other fallbacks ${report.otherFallbacks}; retention ${(100 * report.retention).toFixed(3)}% ` +
        `(floor ${(100 * RETENTION_FLOOR).toFixed(2)}%)`,
    );
    console.log(
      `[clq] cold: worker->first request ${report.workerStartupToFirstRequestMs?.toFixed(1) ?? "n/a"} ms, ` +
        `first landlord round trip ${report.coldFirstLandlordMs?.toFixed(1) ?? "n/a"} ms`,
    );
    if (mismatches.length > 0) {
      console.error(`[clq] mismatch examples ${JSON.stringify(mismatches.slice(0, 3))}`);
    }

    expect(mismatches).toEqual([]);
    expect(report.malformed).toBe(0);
    expect(report.workerErrors).toEqual([]);
    expect(retention).toBeGreaterThanOrEqual(RETENTION_FLOOR);
    expect(report.roundTrip.p99).toBeLessThan(RESPONSE_WINDOW_MS);
  });
});
