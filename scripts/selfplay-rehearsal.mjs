#!/usr/bin/env node
/**
 * Drive the dual-environment rehearsal: collect both branches, then train.
 *
 *   node scripts/selfplay-rehearsal.mjs collect [workers]
 *   node scripts/selfplay-rehearsal.mjs train
 *
 * Collection shards by contiguous window, which is exact here for the same
 * reason it is exact in the diagnostic: a group's three episodes depend only on
 * its own deal id, its scenario and the frozen policies. Rows are written in
 * deal order within a shard and shards are concatenated in index order, so the
 * merged file is in canonical order; the merge checks the deal ranges tile.
 *
 * Training calls `scripts/selfplay-train.py` unchanged — the same frozen
 * LightGBM configuration for both branches, so the only difference between the
 * two sets of models is the data they were fitted on.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT_ROOT = join(ROOT, ".local", "selfplay-reh");
const BRANCHES = ["CHEAP", "TARGET"];
const ROLE_SPLITS = [
  "train.landlord",
  "train.farmer-next",
  "train.farmer-previous",
  "dev.landlord",
  "dev.farmer-next",
  "dev.farmer-previous",
];

// Frozen in research/full-action-selfplay-v1/rehearsal-protocol.md.
const TRAIN_START = 907_001;
const TRAIN_GROUPS = 6_000;
const DIAGNOSTIC_START = 913_001;
const DIAGNOSTIC_GROUPS = 1_500;

const command = process.argv[2] ?? "collect";
const WORKERS = Math.max(1, Number(process.argv[3] ?? process.env.AI_SELFPLAY_JOBS ?? 8));

function windows(start, total, jobs) {
  const out = [];
  const base = Math.floor(total / jobs);
  const extra = total % jobs;
  let offset = 0;
  for (let index = 0; index < jobs; index += 1) {
    const size = base + (index < extra ? 1 : 0);
    if (size > 0) {
      out.push({ start: start + offset, size, index });
    }
    offset += size;
  }
  return out;
}

function runShard(branch, window) {
  const outDir = join(OUT_ROOT, branch, `shard-${window.index}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const env = {
    ...process.env,
    AI_SELFPLAY_REH: "1",
    AI_SELFPLAY_REH_BRANCH: branch,
    AI_SELFPLAY_REH_START: String(window.start),
    AI_SELFPLAY_REH_GROUPS: String(window.size),
    AI_SELFPLAY_REH_OUT: outDir,
  };
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        join(ROOT, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "--config",
        "vitest.benchmark.config.ts",
        "benchmarks/selfplay-rehearsal-collect.test.ts",
      ],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      writeFileSync(join(outDir, "shard.log"), output);
      resolve({ ...window, code, outDir });
    });
  });
}

async function collectBranch(branch) {
  // The two window groups must not both start their shard indices at 0: two
  // windows sharing an output directory means the later one silently overwrites
  // the earlier one's rows, and the merge then sees one window twice. Re-index
  // the concatenated plan and refuse a plan whose indices are not unique.
  const plan = [
    ...windows(TRAIN_START, TRAIN_GROUPS, WORKERS),
    ...windows(DIAGNOSTIC_START, DIAGNOSTIC_GROUPS, Math.max(1, Math.round(WORKERS / 4))),
  ].map((window, index) => ({ ...window, index }));
  if (new Set(plan.map((window) => window.index)).size !== plan.length) {
    console.error(`[reh] ${branch}: shard indices are not unique.`);
    process.exit(1);
  }
  if (new Set(plan.map((window) => window.outDirKey ?? `${window.start}`)).size !== plan.length) {
    console.error(`[reh] ${branch}: two windows start at the same deal.`);
    process.exit(1);
  }
  const started = Date.now();
  const results = [];
  // Bounded concurrency: the diagnostic window is small, so it rides along.
  for (let index = 0; index < plan.length; index += WORKERS) {
    const batch = plan.slice(index, index + WORKERS);
    results.push(...(await Promise.all(batch.map((window) => runShard(branch, window)))));
  }
  const failed = results.filter((result) => result.code !== 0);
  for (const result of failed) {
    process.stderr.write(readFileSync(join(result.outDir, "shard.log"), "utf8"));
  }
  if (failed.length > 0) {
    console.error(`[reh] ${branch}: ${failed.length} shard(s) failed; refusing to merge.`);
    process.exit(1);
  }

  results.sort((left, right) => left.start - right.start);
  const outDir = join(OUT_ROOT, branch);
  const headers = results.map((result) =>
    JSON.parse(readFileSync(join(result.outDir, "shard.json"), "utf8")),
  );

  let expected = results[0].start;
  for (const result of results) {
    if (result.start !== expected) {
      console.error(`[reh] ${branch}: shard windows do not tile (expected ${expected}, saw ${result.start}).`);
      process.exit(1);
    }
    expected += result.size;
  }

  // Concatenate in shard order: within a shard rows are in deal order, and
  // shards ascend, so the result is the canonical deal order.
  const mergedCounts = {};
  const mergedDigests = [];
  let writtenBytes = 0;
  for (const key of ROLE_SPLITS) {
    const xParts = [];
    const yParts = [];
    let count = 0;
    for (const result of results) {
      const xPath = join(result.outDir, `${key}.x.f32`);
      const yPath = join(result.outDir, `${key}.y.f32`);
      if (!existsSync(xPath)) {
        continue;
      }
      xParts.push(readFileSync(xPath));
      yParts.push(readFileSync(yPath));
      count += readFileSync(yPath).length / 4;
    }
    const x = Buffer.concat(xParts);
    const y = Buffer.concat(yParts);
    if (x.length > 0) {
      writeFileSync(join(outDir, `${key}.x.f32`), x);
      writeFileSync(join(outDir, `${key}.y.f32`), y);
      writtenBytes += x.length + y.length;
    }
    mergedCounts[key] = count;
  }
  for (const header of headers) {
    mergedDigests.push(...header.groupDigests);
  }
  mergedDigests.sort((left, right) => left.dealIndex - right.dealIndex);
  if (new Set(mergedDigests.map((entry) => entry.dealIndex)).size !== mergedDigests.length) {
    console.error(`[reh] ${branch}: merged digests contain a duplicate deal group.`);
    process.exit(1);
  }

  const merged = {
    branchId: branch,
    environment: headers[0].environment,
    schemaHash: headers[0].schemaHash,
    featureCount: headers[0].featureCount,
    featureNames: headers[0].featureNames,
    datasetVersion: headers[0].datasetVersion,
    collectorVersion: headers[0].collectorVersion,
    actionIdentityVersion: headers[0].actionIdentityVersion,
    groups: mergedDigests.length,
    rowCounts: mergedCounts,
    rows: Object.values(mergedCounts).reduce((sum, value) => sum + value, 0),
    writtenBytes,
    wallSeconds: (Date.now() - started) / 1000,
    cpuSeconds: headers.reduce((sum, header) => sum + header.cpuSeconds, 0),
    rssMaxBytes: Math.max(...headers.map((header) => header.rssMaxBytes)),
    positiveRate: headers.reduce((sum, h) => sum + h.positiveRate * h.rows, 0) /
      headers.reduce((sum, h) => sum + h.rows, 0),
    exploredRate: headers.reduce((sum, h) => sum + h.exploredRate * h.rows, 0) /
      headers.reduce((sum, h) => sum + h.rows, 0),
    outsideC3: headers.reduce((sum, h) => sum + h.outsideC3, 0),
    outsideC5: headers.reduce((sum, h) => sum + h.outsideC5, 0),
    withProposal: headers.reduce((sum, h) => sum + h.withProposal, 0),
    patternKinds: headers.reduce((acc, h) => {
      for (const [kind, count] of Object.entries(h.patternKinds)) {
        acc[kind] = (acc[kind] ?? 0) + count;
      }
      return acc;
    }, {}),
    attachmentKinds: headers.reduce((acc, h) => {
      for (const [kind, count] of Object.entries(h.attachmentKinds)) {
        acc[kind] = (acc[kind] ?? 0) + count;
      }
      return acc;
    }, {}),
    collectionDigest: createHash("sha256")
      .update(mergedDigests.map((entry) => `${entry.dealIndex}:${entry.digest}`).join("\n"))
      .digest("hex"),
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(merged, null, 2));
  writeFileSync(
    join(outDir, "group-digests.jsonl"),
    mergedDigests.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  console.log(
    `[reh] ${branch}: ${merged.groups} groups, rows ${merged.rows}, ` +
      `${(merged.wallSeconds / 60).toFixed(1)} min wall, digest ${merged.collectionDigest.slice(0, 16)}…`,
  );
  return merged;
}

async function collect() {
  mkdirSync(OUT_ROOT, { recursive: true });
  const log = join(OUT_ROOT, "rehearsal.log");
  const note = (line) => {
    console.log(line);
    appendFileSync(log, `${line}\n`);
  };
  note(`[reh] collect: train ${TRAIN_START}+${TRAIN_GROUPS}, diagnostic ${DIAGNOSTIC_START}+${DIAGNOSTIC_GROUPS}, ${WORKERS} workers`);
  const out = {};
  for (const branch of BRANCHES) {
    out[branch] = await collectBranch(branch);
  }
  for (const branch of BRANCHES) {
    const m = out[branch];
    note(
      `[reh] ${branch}: groups ${m.groups} rows ${m.rows} (${JSON.stringify(m.rowCounts)}) ` +
        `positive ${(100 * m.positiveRate).toFixed(2)}% explored ${(100 * m.exploredRate).toFixed(2)}% ` +
        `outsideC3 ${m.outsideC3}/${m.withProposal} outsideC5 ${m.outsideC5}/${m.withProposal} ` +
        `written ${(m.writtenBytes / 1e6).toFixed(1)} MB`,
    );
  }
  writeFileSync(join(OUT_ROOT, "collect-summary.json"), JSON.stringify(out, null, 2));
}

function train() {
  for (const branch of BRANCHES) {
    const dir = join(OUT_ROOT, branch);
    // `selfplay-train.py` reads <dir>/manifest.json for width and names, then
    // <role>.train.{x,y}.f32. The merged files are named per split AND role, so
    // a small shim directory with the names it expects is built here.
    const shim = join(dir, "train-input");
    rmSync(shim, { recursive: true, force: true });
    mkdirSync(shim, { recursive: true });
    for (const role of ["landlord", "farmer-next", "farmer-previous"]) {
      const x = readFileSync(join(dir, `train.${role}.x.f32`));
      const y = readFileSync(join(dir, `train.${role}.y.f32`));
      writeFileSync(join(shim, `${role}.train.x.f32`), x);
      writeFileSync(join(shim, `${role}.train.y.f32`), y);
    }
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    writeFileSync(
      join(shim, "manifest.json"),
      JSON.stringify({
        schemaHash: manifest.schemaHash,
        featureCount: manifest.featureCount,
        featureNames: manifest.featureNames,
        label: "DEVELOPMENT_ONLY",
        branchId: branch,
      }),
    );
    const python = spawn(
      "python3",
      [join(ROOT, "scripts", "selfplay-train.py"), shim],
      { cwd: ROOT, env: { ...process.env, PYTHONPATH: join(ROOT, ".local", "pylibs") }, stdio: "inherit" },
    );
    python.on("close", (code) => {
      if (code !== 0) {
        console.error(`[reh] training failed for ${branch}`);
        process.exit(code ?? 1);
      }
    });
  }
}

if (command === "collect") {
  await collect();
} else if (command === "train") {
  train();
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}
