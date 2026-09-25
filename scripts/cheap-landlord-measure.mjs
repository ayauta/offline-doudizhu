#!/usr/bin/env node
/**
 * Measure the CHEAP landlord integration prototype's real product size.
 *
 *     node scripts/cheap-landlord-measure.mjs
 *
 * Builds the default product, measures it, builds the prototype, measures that,
 * and leaves `dist/` holding the default build again. Both builds are the real
 * `vite build` the release path runs — nothing is simulated, and no size is
 * inferred from a model file's own bytes.
 *
 * The calibers are the ones frozen in §10 of
 * `research/full-action-selfplay-v1/cheap-integration-protocol.md`, and S2 is
 * deliberately the same computation `scripts/check-bundle.mjs` enforces, so the
 * reported number and the gated number cannot drift apart.
 *
 * This script **does not** edit the reviewed budget. §12 of the protocol is
 * explicit that the historical limit is reported against, not adjusted to fit.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(ROOT, "dist");
const OUT = join(ROOT, ".local", "cheap-integration");

/** §10 S5: the historical reviewed budget for the enhanced AI worker asset. */
const HISTORICAL_WORKER_BUDGET_GZIP = 123_575;

/** The prototype's build needs a raised Workbox limit; see the file's header. */
const PROTOTYPE_CONFIG = ".local/vite.prototype.config.ts";

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Writes the model file in one of its two states. `stub` is measurement-only:
 * the released tree carries the table, because a `pnpm build` that proved the
 * budget green against a stubbed worker would say nothing about what ships.
 */
function embed(stub) {
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "scripts/cheap-landlord-embed.mjs"), ...(stub ? ["--stub"] : [])],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr?.toString() ?? "");
    throw new Error(`cheap-landlord-embed.mjs ${stub ? "--stub" : ""} failed`);
  }
}

/**
 * `config` names a Vite config; the prototype needs the measurement-only one
 * because Workbox refuses to precache a chunk over its default 2 MiB limit.
 */
function build(stub, config) {
  embed(stub);
  const result = spawnSync(
    process.execPath,
    [
      join(ROOT, "node_modules/vite/bin/vite.js"),
      "build",
      ...(config === undefined ? [] : ["--config", config]),
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout?.toString() ?? "");
    process.stderr.write(result.stderr?.toString() ?? "");
    throw new Error(`vite build failed (stub=${stub}) with status ${result.status}`);
  }
}

function measure(label) {
  const paths = walk(DIST);
  const assets = paths.map((path) => {
    const name = relative(DIST, path).replaceAll("\\", "/");
    const raw = readFileSync(path);
    return { name, rawBytes: raw.length, gzipBytes: gzipSync(raw, { level: 9 }).length };
  });
  const worker = assets.filter((asset) => /^assets\/ai-worker-[^/]+\.js$/.test(asset.name));
  if (worker.length !== 1) {
    throw new Error(`expected exactly one worker asset, found ${worker.length}`);
  }
  const main = assets.filter((asset) => /^assets\/main-[^/]+\.js$/.test(asset.name));
  const css = assets.filter((asset) => /^assets\/main-[^/]+\.css$/.test(asset.name));
  return {
    label,
    workerAsset: worker[0].name,
    workerRawBytes: worker[0].rawBytes,
    workerGzipBytes: worker[0].gzipBytes,
    mainRawBytes: main.reduce((sum, asset) => sum + asset.rawBytes, 0),
    mainGzipBytes: main.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    cssRawBytes: css.reduce((sum, asset) => sum + asset.rawBytes, 0),
    cssGzipBytes: css.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    distRawBytes: assets.reduce((sum, asset) => sum + asset.rawBytes, 0),
    distGzipBytes: assets.reduce((sum, asset) => sum + asset.gzipBytes, 0),
    fileCount: assets.length,
    assets,
  };
}

const kib = (value) => (value / 1024).toFixed(2);

console.log("[clm] building the glue-only baseline (model stubbed)…");
build(true);
const baseline = measure("baseline");

/*
 * The measurement config differs from the production one by a single number, so
 * the baseline is built with it too and the two must agree byte for byte. If
 * they ever do not, the prototype numbers below are not about this product.
 */
console.log("[clm] checking the measurement config produces the same baseline…");
build(true, PROTOTYPE_CONFIG);
const baselineViaMeasurementConfig = measure("baseline-measurement-config");
if (baselineViaMeasurementConfig.workerRawBytes !== baseline.workerRawBytes) {
  throw new Error(
    "The measurement config produced a different baseline " +
      `(${baselineViaMeasurementConfig.workerRawBytes} vs ${baseline.workerRawBytes} bytes); ` +
      "refusing to report prototype numbers from it.",
  );
}

console.log("[clm] building the release candidate…");
build(false, PROTOTYPE_CONFIG);
const prototype = measure("prototype");

console.log("[clm] restoring the released build…");
build(false);
const restored = measure("restored");

const delta = {
  workerRawBytes: prototype.workerRawBytes - baseline.workerRawBytes,
  workerGzipBytes: prototype.workerGzipBytes - baseline.workerGzipBytes,
  distRawBytes: prototype.distRawBytes - baseline.distRawBytes,
  distGzipBytes: prototype.distGzipBytes - baseline.distGzipBytes,
};

/*
 * Raw bytes, not gzip. The main chunk's *content* does not change — but its
 * content hash does, because the worker asset it sits beside is renamed, and
 * that one-byte difference in the gzip stream is a hash string, not growth.
 * Gating on raw bytes is what distinguishes "the model leaked into the main
 * bundle" from "a filename moved".
 */
const mainGrew = prototype.mainRawBytes !== baseline.mainRawBytes;
const cssGrew = prototype.cssRawBytes !== baseline.cssRawBytes;

const report = {
  historicalWorkerBudgetGzipBytes: HISTORICAL_WORKER_BUDGET_GZIP,
  baseline,
  prototype,
  delta,
  ratios: {
    workerGzip: prototype.workerGzipBytes / HISTORICAL_WORKER_BUDGET_GZIP,
    workerGzipOverBudgetBytes: prototype.workerGzipBytes - HISTORICAL_WORKER_BUDGET_GZIP,
    workerGzipPercentageDelta: (100 * delta.workerGzipBytes) / baseline.workerGzipBytes,
    distGzipPercentageDelta: (100 * delta.distGzipBytes) / baseline.distGzipBytes,
  },
  /** The integration must not touch anything except the worker chunk. */
  mainChunkUnchanged: !mainGrew,
  mainGzipDeltaBytes: prototype.mainGzipBytes - baseline.mainGzipBytes,
  cssUnchanged: !cssGrew,
  restoreIsByteIdentical:
    restored.workerRawBytes === baseline.workerRawBytes &&
    restored.distRawBytes === baseline.distRawBytes,
  restoredWorkerGzipBytes: restored.workerGzipBytes,
  measurementConfigBaselineIdentical:
    baselineViaMeasurementConfig.workerRawBytes === baseline.workerRawBytes,
  preIntegrationRecorded: {
    note:
      "Measured on this tree with the src/ integration changes stashed, so the " +
      "integration's own byte cost is separable from the model's.",
    workerRawBytes: 540_849,
    workerGzipBytes: 122_788,
  },
  integrationGlueOnly: {
    workerRawBytes: baseline.workerRawBytes - 540_849,
    workerGzipBytes: baseline.workerGzipBytes - 122_788,
    overHistoricalBudgetBytes: baseline.workerGzipBytes - HISTORICAL_WORKER_BUDGET_GZIP,
  },
};

writeFileSync(join(OUT, "size.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

const line = (label, value) => `[clm] ${label.padEnd(26)} ${String(value).padStart(12)}`;
console.log(line("baseline worker raw", baseline.workerRawBytes));
console.log(line("baseline worker gzip", baseline.workerGzipBytes));
console.log(line("prototype worker raw", prototype.workerRawBytes));
console.log(line("prototype worker gzip", prototype.workerGzipBytes));
console.log(line("delta worker raw", delta.workerRawBytes));
console.log(line("delta worker gzip", delta.workerGzipBytes));
console.log(
  `[clm] worker gzip ${kib(prototype.workerGzipBytes)} KiB / historical budget ` +
    `${kib(HISTORICAL_WORKER_BUDGET_GZIP)} KiB -> ${report.ratios.workerGzip.toFixed(2)}x ` +
    `(${report.ratios.workerGzipOverBudgetBytes} B over)`,
);
console.log(
  `[clm] dist raw ${baseline.distRawBytes} -> ${prototype.distRawBytes} ` +
    `(delta ${delta.distRawBytes}, ${report.ratios.distGzipPercentageDelta.toFixed(1)}% gzip)`,
);
console.log(
  `[clm] main chunk unchanged ${report.mainChunkUnchanged}, CSS unchanged ${report.cssUnchanged}, ` +
    `default build restored byte-identically ${report.restoreIsByteIdentical}`,
);
