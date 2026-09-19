#!/usr/bin/env node
/**
 * Freezes the harvested calibration shards into the corpus used by
 * `benchmarks/leaf-replay.test.ts`: verifies the shards tile the deal range
 * exactly, copies them into place, and writes a manifest with checksums.
 *
 * usage: node freeze.mjs <shards dir> <destination dir>
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  console.error("usage: node freeze.mjs <shards dir> <destination dir>");
  process.exit(2);
}

const files = readdirSync(source).filter((name) => name.endsWith(".json")).sort();
if (files.length === 0) {
  console.error("no shard JSON files found");
  process.exit(1);
}

const shards = files.map((name) => {
  const raw = readFileSync(join(source, name));
  return {
    name,
    bytes: raw.byteLength,
    sha256: createHash("sha256").update(raw).digest("hex"),
    parsed: JSON.parse(raw.toString("utf8")),
  };
});

// Coverage: shards must tile [dealStart, dealStart + deals) with no hole and
// no overlap, otherwise the corpus silently misses positions.
const covered = new Map();
let gaps = 0;
let overlaps = 0;
let decisions = 0;
let leaves = 0;
let terminalLeaves = 0;
let seedBase;
const perDeal = new Map();

for (const shard of shards) {
  const { dealStart, deals, seedBase: base } = shard.parsed.shard;
  seedBase = seedBase ?? base;
  for (let index = 0; index < deals; index += 1) {
    const deal = dealStart + index;
    if (covered.has(deal)) {
      overlaps += 1;
    }
    covered.set(deal, shard.name);
  }
  for (const decision of shard.parsed.decisions) {
    decisions += 1;
    leaves += decision.leaves.length;
    for (const leaf of decision.leaves) {
      if (leaf.winner !== null) {
        terminalLeaves += 1;
      }
    }
    perDeal.set(decision.deal, (perDeal.get(decision.deal) ?? 0) + 1);
  }
}

const first = Math.min(...covered.keys());
const last = Math.max(...covered.keys());
for (let deal = first; deal <= last; deal += 1) {
  if (!covered.has(deal)) {
    gaps += 1;
  }
}
const dealsWithNoDecisions = [...covered.keys()].filter((deal) => !perDeal.has(deal));

mkdirSync(destination, { recursive: true });
for (const shard of shards) {
  copyFileSync(join(source, shard.name), join(destination, shard.name));
}

const decisionsPerDeal = [...perDeal.values()].sort((a, b) => a - b);
const manifest = {
  purpose: "E1 calibration corpus — rootUtility leaves, offline replayable",
  spec: "docs/specs/057-root-utility-leaf-value/spec.md",
  harvestedBy: "benchmarks/zz-leaf-harvest.test.ts + instrumentation patch (docs/research/057-leaf-harvest/)",
  seedBase,
  dealRange: [first, last],
  shards: shards.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
  totalBytes: shards.reduce((sum, shard) => sum + shard.bytes, 0),
  decisions,
  leaves,
  terminalLeaves,
  decisionsPerDeal: {
    min: decisionsPerDeal[0] ?? 0,
    median: decisionsPerDeal[Math.floor(decisionsPerDeal.length / 2)] ?? 0,
    max: decisionsPerDeal[decisionsPerDeal.length - 1] ?? 0,
  },
  coverage: {
    deals: covered.size,
    gaps,
    overlaps,
    dealsWithNoDecisions: dealsWithNoDecisions.length,
  },
  combinedSha256: createHash("sha256")
    .update(shards.map((shard) => shard.sha256).join(""))
    .digest("hex"),
};

writeFileSync(join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`shards      ${shards.length}`);
console.log(`deal range  ${first}..${last} (${covered.size} deals)`);
console.log(`decisions   ${decisions}`);
console.log(`leaves      ${leaves} (terminal ${terminalLeaves})`);
console.log(`per deal    min ${manifest.decisionsPerDeal.min} / median ${manifest.decisionsPerDeal.median} / max ${manifest.decisionsPerDeal.max}`);
console.log(`bytes       ${manifest.totalBytes} (${(manifest.totalBytes / 1048576).toFixed(1)} MiB)`);
console.log(`coverage    gaps=${gaps} overlaps=${overlaps} dealsWithNoDecisions=${dealsWithNoDecisions.length}`);
console.log(`combined    ${manifest.combinedSha256}`);
if (gaps > 0 || overlaps > 0 || dealsWithNoDecisions.length > 0) {
  console.error("COVERAGE BROKEN — the corpus does not tile its deal range");
  process.exit(1);
}
void statSync;
