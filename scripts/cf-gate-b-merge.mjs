#!/usr/bin/env node
/**
 * Joins the Gate B shards back into the two dumps `paired-compare.test.ts` reads.
 *
 *   node scripts/cf-gate-b-merge.mjs .local/cf-gb .local/cf-gb/merged
 *
 * Sharding only parallelises: a deal's seed is its absolute index, so the
 * joined arrays are indexed by the same deal position the unsharded run would
 * have used. The merge refuses to produce a dump when any shard is short or was
 * cut off by the wall-clock cap, because a silently truncated shard would be
 * read as a shorter experiment rather than as a failure.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , shardDir = ".local/cf-gb", outDir = ".local/cf-gb/merged"] = process.argv;

function loadShards(arm) {
  const names = readdirSync(shardDir)
    .filter((name) => name.startsWith(`${arm}-`) && name.endsWith(".json"))
    .sort();
  if (names.length === 0) {
    throw new Error(`no shards for arm ${arm} in ${shardDir}`);
  }
  const shards = names.map((name) => {
    const parsed = JSON.parse(readFileSync(join(shardDir, name), "utf8"));
    const run = parsed.runs["master-default"];
    if (run === undefined) throw new Error(`${name} has no master-default run`);
    if (run.stoppedEarly === true) throw new Error(`${name} stopped early`);
    return { name, dealStart: parsed.config.dealStart, deals: parsed.config.deals, run };
  });
  shards.sort((left, right) => left.dealStart - right.dealStart);
  let expected = shards[0].dealStart;
  for (const shard of shards) {
    if (shard.dealStart !== expected) {
      throw new Error(`shard window gap at ${shard.name}: expected ${expected}, got ${shard.dealStart}`);
    }
    if (shard.run.perDealA.length !== shard.deals || shard.run.perDealB.length !== shard.deals) {
      throw new Error(
        `${shard.name} holds ${shard.run.perDealA.length}/${shard.run.perDealB.length} deals, expected ${shard.deals}`,
      );
    }
    expected += shard.deals;
  }
  return {
    label: `phase2-${arm}`,
    config: { dealStart: shards[0].dealStart, deals: expected - shards[0].dealStart, designed: true },
    runs: {
      "master-default": {
        perDealA: shards.flatMap((shard) => shard.run.perDealA),
        perDealB: shards.flatMap((shard) => shard.run.perDealB),
      },
    },
  };
}

mkdirSync(outDir, { recursive: true });
for (const arm of ["baseline", "challenger"]) {
  const merged = loadShards(arm);
  const path = join(outDir, `${arm}.json`);
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  const { perDealA, perDealB } = merged.runs["master-default"];
  console.log(
    `${arm.padEnd(10)} deals ${perDealA.length}  ` +
    `armA wins ${perDealA.reduce((a, b) => a + b, 0)}/${perDealA.length * 3}  ` +
    `armB wins ${perDealB.reduce((a, b) => a + b, 0)}/${perDealB.length * 3}  -> ${path}`,
  );
}
