/**
 * Farmer Policy Iteration Factory v1 — the corpus worker.
 *
 * Two env-gated modes, both off by default so the benchmark suite stays green
 * when it is run without configuration:
 *
 *   generate  AI_FPI_CORPUS_GENERATE=<dir> AI_FPI_POOL_ID=... AI_FPI_POOL_START=... \
 *             AI_FPI_POOL_END=... AI_FPI_PURPOSE=train AI_FPI_CHAMPION_ID=ai-v1 \
 *             AI_FPI_DEAL_START=200001 AI_FPI_DEALS=6000 \
 *             AI_FPI_POLICY_COMMIT=<sha> AI_FPI_ATTEMPT_ID=attempt-001
 *   rows      AI_FPI_CORPUS_ROWS=<dir> AI_FPI_PURPOSE=train
 *
 * The runner (`scripts/farmer-pi.mjs`, under the absolute-deadline host) decides
 * the ranges and the parallelism; this file only plays the deals it is given.
 * Sharding only parallelises: a group's seed is its absolute deal index, so two
 * workers given two windows produce exactly what one worker given both would.
 *
 * Three things are this file's job rather than the library's:
 *
 *   1. **the resume contract.** A deal is the transaction (§27), so a resumed
 *      run re-derives the deal it already has and compares. A match leaves the
 *      file untouched and is reported; a mismatch is the checkpoint layer's
 *      `INTEGRITY_STOP`, not a quiet overwrite. This is why `payload` is the
 *      `CfGroupResult` and nothing else — it has to hash identically on a second
 *      run — and why every timing goes under the record's separate `cost`.
 *   2. **the window is checked before the first deck is dealt.** A window that
 *      runs off the end of its pool is a configuration error, and the cheap
 *      place to find it is the first second of the run rather than its fifth
 *      hour.
 *   3. **the report.** Progress is counts, elapsed and throughput only. The
 *      rows mode deliberately does not print a label tally: the tally of
 *      override/keep/reject labels is a strength signal, and a corpus is
 *      generated blind.
 *
 * The champion is fixed at `ai-v1` for this round: no research champion exists
 * yet, so there is nothing else a loader could load, and `championChainById`
 * says so rather than failing later.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { dealDeck } from "./ai-tournament.js";
import type { CfGroupResult } from "./cf-dataset.js";
import {
  factoryCaptureGroup,
  factoryGroupSpecFor,
  factorySplitOfPurpose,
} from "./farmer-pi-corpus.js";
import {
  IntegrityError,
  completedDeals,
  makeDealRecord,
  readDealRecord,
  stableHash,
  writeDealRecord,
  writeFileAtomic,
} from "./farmer-pi-stage.js";
import {
  championChainById,
  corpusConfigHash,
  dealCheckpointed,
  factoryPoolRefFromEnv,
  factoryRowsFile,
  progress,
  requiredInt,
  requiredText,
} from "./farmer-pi-workers.js";

const GENERATE_DIR = process.env.AI_FPI_CORPUS_GENERATE;
const ROWS_DIR = process.env.AI_FPI_CORPUS_ROWS;
const ENABLED = GENERATE_DIR !== undefined || ROWS_DIR !== undefined;

/**
 * A corpus pool is a multi-hour job. The budget is stated here rather than
 * inherited from the benchmark config's backstop, so that a run which is still
 * working at the five-hour mark is not killed by a number nobody chose.
 */
const CORPUS_TIMEOUT_MS = 6 * 60 * 60 * 1000;

describe.runIf(!ENABLED)("Factory v1 corpus worker (idle)", () => {
  it("does nothing without AI_FPI_CORPUS_GENERATE or AI_FPI_CORPUS_ROWS", () => {
    // The worker is an entry point for a runner, not part of `pnpm check`. With
    // no mode selected it must leave the suite exactly as it found it: one
    // passing assertion, no deals, no files, no clock read.
    expect(GENERATE_DIR === undefined && ROWS_DIR === undefined).toBe(true);
  });
});

describe.runIf(ENABLED)("Farmer Policy Iteration Factory v1 corpus", () => {
  it("generates one pool's deals, or turns their snapshots into rows", () => {
    if (GENERATE_DIR !== undefined) {
      generate(GENERATE_DIR);
      return;
    }
    if (ROWS_DIR !== undefined) {
      exportRows(ROWS_DIR);
      return;
    }
    throw new Error("Neither AI_FPI_CORPUS_GENERATE nor AI_FPI_CORPUS_ROWS is set.");
  }, CORPUS_TIMEOUT_MS);
});

/** §27 — one deal is one transaction, written when it is finished and not before. */
function generate(dir: string): void {
  const pool = factoryPoolRefFromEnv();
  const championId = requiredText("AI_FPI_CHAMPION_ID");
  const policyCommit = requiredText("AI_FPI_POLICY_COMMIT");
  const attemptId = requiredText("AI_FPI_ATTEMPT_ID");
  const dealStart = requiredInt("AI_FPI_DEAL_START");
  const deals = requiredInt("AI_FPI_DEALS");
  if (deals < 1) {
    throw new Error(`AI_FPI_DEALS must be at least 1; received ${deals}.`);
  }
  const lastDeal = dealStart + deals - 1;
  if (dealStart < pool.range.start || lastDeal > pool.range.end) {
    throw new Error(
      `The requested window ${dealStart}..${lastDeal} is not inside pool ${pool.poolId} ` +
      `(${pool.range.start}..${pool.range.end}). Nothing has been dealt.`,
    );
  }

  const chain = championChainById(championId);
  const configHash = corpusConfigHash({ pool, chain, policyCommit, attemptId });
  const chainLayers = chain.layers.map((layer) => layer.modelSha256);
  const started = Date.now();
  let written = 0;
  let resumed = 0;
  let snapshots = 0;

  progress(
    `[fpi corpus] pool ${pool.poolId} purpose ${pool.purpose} range ` +
    `${pool.range.start}..${pool.range.end} window ${dealStart}..${lastDeal} ` +
    `champion ${chain.championId} layers ${chain.layers.length} ` +
    `policy ${policyCommit} attempt ${attemptId} config ${configHash.slice(0, 16)}`,
  );
  progress(`[fpi corpus] chain ${JSON.stringify(chainLayers)}`);

  for (let offset = 0; offset < deals; offset += 1) {
    const dealIndex = dealStart + offset;
    const spec = factoryGroupSpecFor(dealIndex, pool, policyCommit);
    const captureStarted = performance.now();
    const group = factoryCaptureGroup(dealDeck(dealIndex), spec, chain);
    const captureMs = performance.now() - captureStarted;
    snapshots += group.snapshots.length;
    // The payload is the group alone. `artifactHash` covers it and nothing else,
    // so a second run of the same deal hashes identically and a difference means
    // the deal really did change; the measurements about the run live under
    // `cost`, which is never hashed.
    const record = makeDealRecord({
      dealIndex,
      stage: "corpus",
      arm: null,
      configHash,
      payload: group,
      cost: Object.freeze({
        captureMs,
        snapshots: group.snapshots.length,
        forkGames: group.forkGames,
        farmerRoots: group.totalFarmerRoots,
      }),
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
      `[fpi corpus] deal ${dealIndex} ${offset + 1}/${deals} written ${written} ` +
      `resumed ${resumed} snapshots ${snapshots} elapsed ${elapsed.toFixed(1)}s ` +
      `throughput ${(((offset + 1) / Math.max(elapsed, 1)) * 3600).toFixed(0)}/h`,
    );
  }

  const elapsed = (Date.now() - started) / 1000;
  progress(
    `[fpi corpus] done written ${written} resumed ${resumed} snapshots ${snapshots} ` +
    `elapsed ${elapsed.toFixed(1)}s`,
  );
  expect(written + resumed).toBe(deals);
}

/**
 * The rows export: one corpus directory in, one `rows.json` out.
 *
 * The split is the purpose's, and the purpose is the runner's: a corpus knows
 * which pool it came from, not which bucket the attempt intends to train on and
 * which it intends to keep blind. `factorySplitOfPurpose` is the one place that
 * mapping exists, and it borrows v1's `heldout` label so a reader downstream
 * cannot mistake an offline-screen row for a trainable one.
 *
 * Every record is re-hashed on the way in. The deal records are the authority on
 * what was computed, so a file edited after generation has to be caught here or
 * it is trained on.
 */
function exportRows(dir: string): void {
  const purpose = requiredText("AI_FPI_PURPOSE");
  const split = factorySplitOfPurpose(purpose);
  const indexes = completedDeals(dir, null);
  if (indexes.length === 0) {
    throw new Error(`No deal records under ${join(dir, "deals")}.`);
  }

  const started = Date.now();
  const groups: CfGroupResult[] = [];
  let snapshots = 0;
  for (const dealIndex of indexes) {
    const record = readDealRecord(dir, null, dealIndex);
    const recomputed = stableHash(record.payload);
    if (recomputed !== record.artifactHash) {
      throw new IntegrityError(
        `Deal ${dealIndex}'s record hashes to ${recomputed} and claims ` +
        `${record.artifactHash}. The checkpoint area was edited after generation; no rows ` +
        "are exported from it.",
      );
    }
    const group = record.payload as CfGroupResult;
    if (group.dealIndex !== dealIndex || group.groupId !== `deal-${dealIndex}`) {
      throw new IntegrityError(
        `Deal ${dealIndex}'s record holds group ${group.groupId} for deal ${group.dealIndex}.`,
      );
    }
    groups.push(group);
    snapshots += group.snapshots.length;
  }

  const file = factoryRowsFile(groups, split);
  const path = join(dir, "rows.json");
  const text = `${JSON.stringify(file)}\n`;
  writeFileAtomic(path, text);
  const elapsed = (Date.now() - started) / 1000;
  // No label tally here, on purpose: how often the champion's own action was
  // beaten is a result, and the corpus is generated blind.
  progress(
    `[fpi rows] purpose ${purpose} split ${split} groups ${groups.length} ` +
    `snapshots ${snapshots} rows ${file.rows.length} weights ${file.weights.length} ` +
    `elapsed ${elapsed.toFixed(1)}s ${(text.length / 1024 / 1024).toFixed(1)}MiB`,
  );
  progress(`[fpi rows] written ${path}`);
  expect(file.weights.length).toBe(file.rows.length);
}
