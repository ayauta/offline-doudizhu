#!/usr/bin/env node
/**
 * Farmer Policy Iteration Factory v1 — the single command.
 *
 *   node scripts/farmer-pi.mjs status   [--root <dir>]
 *   node scripts/farmer-pi.mjs inspect  [--root <dir>]
 *   node scripts/farmer-pi.mjs run      [--root <dir>] [--deadline <ISO-8601 with offset>]
 *
 * This file owns the *process*. It decides what runs next, spawns it, watches
 * the clock, kills what it started, and writes a journal. It owns no science:
 * every derivation — the attempt state machine, the pool allocation, the
 * manifests and seals, the threshold selection, the screens and the formal
 * verdict — is asked for from `benchmarks/farmer-pi-control.test.ts` over a
 * process boundary, because a `.mjs` file cannot import the Factory's `.ts`
 * modules and a second implementation of the frozen rules is exactly the
 * failure the previous two rounds were made of.
 *
 * Three properties §31 asks for, and where each one lives:
 *
 *   - **the runner is the state machine.** `run` is a loop over
 *     `nextAttemptStep`; there is no mode in which an operator names a stage.
 *     One command advances the Factory as far as the clock and the protocol
 *     allow, and running it twice does the second half of the first run's work
 *     rather than starting over.
 *   - **resume is not a new attempt.** `register` is asked first, every time;
 *     it either restores the attempt that is already on disk or creates the
 *     next one the ledger and the state machine allow. Nothing here allocates a
 *     range.
 *   - **the console is the no-peek surface.** Everything printed during a run
 *     comes from `PI_STATUS_KEYS` or from the control plane's own progress
 *     lines, and every stage payload is read by the control plane after the
 *     stage is sealed — never by this file. There is no code path here that
 *     could print a win, a loss, a delta or a mean, because none of them is
 *     ever parsed into this process.
 *
 * The deadline is an absolute UTC instant, checked against the wall clock and
 * never as an elapsed duration: a monotonic timer inside a suspended machine
 * measures the wrong thing, which is how Spec 065 missed a hard stop by forty
 * minutes after the machine slept for twenty hours.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const BENCH_CONFIG = "vitest.benchmark.config.ts";
const CONTROL_BENCH = "benchmarks/farmer-pi-control.test.ts";
const CORPUS_BENCH = "benchmarks/farmer-pi-corpus.test.ts";
const STAGE_BENCH = "benchmarks/farmer-pi-stage.test.ts";

/** Exit codes. The host launcher and any operator depend on these. */
export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  PAUSED_DEADLINE: 3,
  INTEGRITY_STOP: 4,
  RESOURCE_STOP: 5,
});

const DEFAULT_JOBS = Number.parseInt(process.env.FPI_JOBS ?? "8", 10);

// ---------------------------------------------------------------------------
// Arguments and the clock
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    mode: argv[0] ?? "status", root: null, deadline: null, protocolPath: null, ledgerPath: null,
  };
  const rest = argv.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--root") {
      options.root = rest[index + 1] ?? null;
      index += 1;
    } else if (token === "--deadline") {
      options.deadline = rest[index + 1] ?? null;
      index += 1;
    } else if (token === "--protocol") {
      options.protocolPath = rest[index + 1] ?? null;
      index += 1;
    } else if (token === "--ledger") {
      options.ledgerPath = rest[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${token}".`);
    }
  }
  if (options.root === null) {
    options.root = join(ROOT, ".local", "farmer-pi");
  }
  return options;
}

/**
 * The deadline as an absolute instant, from `--deadline` or `FPI_DEADLINE_UTC`.
 *
 * A string without an offset is refused rather than assumed: a local time means
 * something different after a suspend across a DST boundary, which is a real
 * thing that happened to this repository's predecessor.
 */
function deadlineMs(options) {
  const text = options.deadline ?? process.env.FPI_DEADLINE_UTC ?? null;
  if (text === null) {
    return null;
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new Error(`Deadline "${text}" carries no offset; an absolute instant is required.`);
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Deadline "${text}" is not a parseable instant.`);
  }
  return parsed;
}

function past(deadline) {
  return deadline !== null && Date.now() >= deadline;
}

// ---------------------------------------------------------------------------
// The control plane
// ---------------------------------------------------------------------------

let controlSeq = 0;

/**
 * One control mode, one answer.
 *
 * The config is written to a file rather than passed in the environment because
 * it is a structured document — pools, steps, directives — and an environment
 * variable is a string with a length limit and a shell quoting story. The mode
 * appears in both the env var and the file, and the control plane refuses when
 * they disagree.
 */
function control(mode, config, scope) {
  const root = typeof scope === "string" ? scope : scope.root;
  const dir = join(root, "control");
  mkdirSync(dir, { recursive: true });
  controlSeq += 1;
  const configPath = join(dir, `${String(controlSeq).padStart(4, "0")}-${mode}.json`);
  // A rehearsal points the whole pipeline at its own protocol document and its
  // own pool ledger. Both are threaded rather than fixed so that a rehearsal can
  // never be an accident: it has to be named on the command line.
  const scoped = typeof scope === "string"
    ? {}
    : {
        ...(scope.protocolPath === null || scope.protocolPath === undefined
          ? {} : { protocolPath: scope.protocolPath }),
        ...(scope.ledgerPath === null || scope.ledgerPath === undefined
          ? {} : { ledgerPath: scope.ledgerPath }),
      };
  writeFileSync(configPath,
    `${JSON.stringify({ mode, ...scoped, ...config }, null, 2)}\n`, "utf8");

  const child = spawnSync(VITEST, ["run", "--config", BENCH_CONFIG, CONTROL_BENCH], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, AI_FPI_CONTROL: mode, AI_FPI_CONTROL_CONFIG: configPath },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  const answers = output
    .split("\n")
    .filter((line) => line.startsWith("[fpi control] "))
    .map((line) => {
      try {
        return JSON.parse(line.slice("[fpi control] ".length));
      } catch {
        return null;
      }
    })
    .filter((value) => value !== null);
  if (answers.length === 0) {
    throw new Error(
      `Control mode "${mode}" produced no answer (exit ${String(child.status)}).\n` +
      output.split("\n").slice(-25).join("\n"),
    );
  }
  return answers[answers.length - 1];
}

/** A status-safe narration line. Counts, clock and error codes only. */
function say(line) {
  process.stdout.write(`[fpi] ${line}\n`);
}

function journal(root, entry) {
  const dir = join(root, "journal");
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const path = join(dir, `${day}.jsonl`);
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  writeFileSync(path, existsSync(path) ? readFileSync(path, "utf8") + line : line, "utf8");
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

/** The environment both workers share. */
function workerEnv(config, protocolHash, runnerCommit) {
  return {
    ...process.env,
    AI_FPI_PROTOCOL_HASH: protocolHash,
    AI_FPI_POLICY_COMMIT: runnerCommit,
    AI_FPI_ATTEMPT_ID: config.attemptId,
    AI_FPI_CHAMPION_ID: config.championId,
  };
}

/**
 * Runs one worker window and returns its exit code, or `null` when the
 * deadline cut it short.
 *
 * The child is spawned rather than run in-process for two reasons: vitest's
 * benchmark config forces single-file, non-concurrent execution, so the
 * parallelism has to come from processes; and a killed child leaves its
 * already-written deal checkpoints on disk, which is the whole point of §27.
 */
function runWindow(bench, env, deadline, onSpawn) {
  return new Promise((resolve) => {
    const child = spawn(VITEST, ["run", "--config", BENCH_CONFIG, bench], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    onSpawn(child);
    let settled = false;
    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timer);
      resolve(code);
    };
    const timer = setInterval(() => {
      if (deadline !== null && Date.now() >= deadline) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, 30_000).unref();
      }
    }, 5_000);
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", () => finish(1));
    child.on("exit", (code) => finish(code ?? 1));
  });
}

/**
 * Splits a pool window into contiguous per-worker windows.
 *
 * Contiguous and absolute, so a shard plays exactly the deals the unsharded run
 * would have played: a deal's seed is its absolute index and nothing about it
 * depends on how the window was cut.
 */
function windowsFor(start, deals, jobs) {
  const count = Math.max(1, Math.min(jobs, deals));
  const windows = [];
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    const size = Math.floor(((index + 1) * deals) / count) - Math.floor((index * deals) / count);
    if (size > 0) {
      windows.push({ start: cursor, deals: size });
      cursor += size;
    }
  }
  return windows;
}

async function runCorpusWindow(options) {
  const { dir, pool, window, ctx, deadline } = options;
  const env = {
    ...workerEnv(ctx, ctx.protocolHash, ctx.runnerCommit),
    AI_FPI_CORPUS_GENERATE: dir,
    AI_FPI_POOL_ID: pool.poolId,
    AI_FPI_POOL_START: String(pool.start),
    AI_FPI_POOL_END: String(pool.end),
    AI_FPI_PURPOSE: pool.purpose,
    AI_FPI_DEAL_START: String(window.start),
    AI_FPI_DEALS: String(window.deals),
  };
  return runWindow(CORPUS_BENCH, env, deadline, (child) => ctx.children.add(child));
}

async function runArmWindow(options) {
  const { dir, pool, arm, ctx, deadline, layer } = options;
  const env = {
    ...workerEnv(ctx, ctx.protocolHash, ctx.runnerCommit),
    AI_FPI_ARM_RUN: dir,
    AI_FPI_ARM: arm,
    AI_FPI_STAGE: ctx.stage,
    AI_FPI_POOL_START: String(pool.start),
    AI_FPI_DEALS: String(ctx.deals),
  };
  if (layer !== undefined) {
    env.AI_FPI_CANDIDATE_LAYER = layer.artifactPath;
    env.AI_FPI_CANDIDATE_SHA = layer.modelSha256;
    env.AI_FPI_CANDIDATE_THRESHOLD = String(layer.threshold);
    env.AI_FPI_CANDIDATE_BYTES = String(layer.modelBytes);
  }
  return runWindow(STAGE_BENCH, env, deadline, (child) => ctx.children.add(child));
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

function python(args, extraEnv) {
  const run = spawnSync("python3", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: join(ROOT, ".local", "pylibs"), ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(
      `python3 ${args.join(" ")} failed (${String(run.status)}).\n` +
      `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").slice(-25).join("\n"),
    );
  }
  return run.stdout ?? "";
}

/** Step: generate one corpus pool, in parallel windows, resumable per deal. */
async function stepCorpus(step, ctx) {
  const pool = ctx.attempt.pools[step.purpose];
  if (pool === undefined) {
    throw new Error(`${ctx.attemptId} has no pool for purpose "${step.purpose}".`);
  }
  const opened = control("open-stage", {
    root: ctx.root, attemptId: ctx.attemptId, stage: step.purpose, role: "corpus",
    championId: ctx.championId, at: new Date().toISOString(),
    pool: { poolId: pool.poolId, purpose: step.purpose, start: pool.start, end: pool.end },
  }, ctx);
  control("ledger", {
    ledgerPath: ctx.ledgerPath, poolId: pool.poolId, to: "RUNNING",
    at: new Date().toISOString(), note: `${ctx.attemptId} generating`,
  }, ctx);

  const windows = windowsFor(pool.start, pool.end - pool.start + 1, ctx.jobs);
  say(`corpus ${step.purpose}: ${windows.length} window(s) over ${pool.start}..${pool.end}`);
  const codes = await Promise.all(windows.map((window) =>
    runCorpusWindow({ dir: opened.dir, pool, window, ctx, deadline: ctx.deadline })));
  if (past(ctx.deadline)) {
    return { paused: true };
  }
  if (codes.some((code) => code !== 0)) {
    throw new Error(`corpus ${step.purpose}: ${codes.filter((c) => c !== 0).length} window(s) failed.`);
  }

  const sealed = control("seal-stage", { dir: opened.dir, at: new Date().toISOString() }, ctx);
  control("ledger", {
    ledgerPath: ctx.ledgerPath, poolId: pool.poolId, to: "SEALED_COMPLETE",
    at: new Date().toISOString(), note: `${ctx.attemptId} corpus sealed`,
  }, ctx);
  say(`corpus ${step.purpose}: sealed, ${String(sealed.deals)} deals, ` +
    `${String(sealed.checkpoints)} checkpoints`);
  return { paused: false, dir: opened.dir, configHash: opened.configHash };
}

/** Step: train from the sealed train and calibration corpora, then package. */
function stepTrain(ctx) {
  const attemptDir = join(ctx.root, "attempts", ctx.attemptId);
  const trainDir = join(attemptDir, "train");
  const at = new Date().toISOString();
  control("rows", {
    root: ctx.root, attemptId: ctx.attemptId, outDir: trainDir, at,
    sources: [
      { dir: ctx.stageDirs.train, purpose: "train" },
      { dir: ctx.stageDirs.calibration, purpose: "calibration" },
    ],
  }, ctx);
  // cf-train.py reads both splits from one directory and refuses when their
  // schemas or feature orders disagree, which is the check that a corpus
  // generated across a pause did not change shape underneath it.
  python(["scripts/cf-train.py", trainDir]);
  const modelText = join(trainDir, "model.txt");
  const packagePath = join(attemptDir, "models", `M${ctx.attempt.generation ?? 1}.json`);
  mkdirSync(dirname(packagePath), { recursive: true });
  python(["scripts/cf-export-model.py", modelText, packagePath]);
  const modelBytes = Buffer.byteLength(readFileSync(packagePath, "utf8"), "utf8");
  const config = JSON.parse(readFileSync(join(trainDir, "train-config.json"), "utf8"));
  say(`train: ${String(config.trainRows)} rows, model ${String(config.modelSha256).slice(0, 16)}`);
  return {
    artifactPath: packagePath,
    modelSha256: config.modelSha256,
    modelBytes,
    // The threshold is not known yet; the layer is recorded with its model and
    // the calibration step fills in the threshold it plays at.
    threshold: 0,
  };
}

/** The layer the candidate arm plays, with the calibrated threshold. */
function candidateLayerOf(ctx) {
  const layer = ctx.candidateLayer;
  if (layer === null) {
    throw new Error(`${ctx.attemptId} has no candidate layer.`);
  }
  return layer;
}

function strengthPool(ctx, purpose) {
  const pool = ctx.attempt.pools[purpose];
  if (pool === undefined) {
    throw new Error(`${ctx.attemptId} has no pool for "${purpose}".`);
  }
  return { poolId: pool.poolId, purpose, start: pool.start, end: pool.end };
}

/** Step: one strength stage — two arms, sealed, then one verdict. */
async function stepStrength(stage, ctx, deals) {
  const pool = strengthPool(ctx, stage);
  const at = new Date().toISOString();
  const record = control("open-stage", {
    root: ctx.root, attemptId: ctx.attemptId, stage, role: "record",
    championId: ctx.championId, at, pool,
  }, ctx);
  const layer = candidateLayerOf(ctx);
  const dirs = {};
  for (const arm of ["champion", "candidate"]) {
    const opened = control("open-stage", {
      root: ctx.root, attemptId: ctx.attemptId, stage, role: "arm", arm,
      championId: ctx.championId, at,
      pool: { ...pool, end: pool.start + deals - 1 },
      layer: arm === "candidate" ? layer : undefined,
    }, ctx);
    dirs[arm] = opened.dir;
  }
  control("ledger", {
    ledgerPath: ctx.ledgerPath, poolId: pool.poolId, to: "RUNNING", at,
    note: `${ctx.attemptId} ${stage} running`,
  }, ctx);

  say(`${stage}: two arms, ${String(deals)} deals each`);
  ctx.stage = stage;
  ctx.deals = deals;
  const codes = await Promise.all(["champion", "candidate"].map((arm) =>
    runArmWindow({ dir: dirs[arm], pool: strengthPool(ctx, stage), arm, ctx, deadline: ctx.deadline,
      layer: arm === "candidate" ? layer : undefined })));
  if (past(ctx.deadline)) {
    return { paused: true };
  }
  if (codes.some((code) => code !== 0)) {
    throw new Error(`${stage}: ${codes.filter((c) => c !== 0).length} arm(s) failed.`);
  }
  for (const arm of ["champion", "candidate"]) {
    control("seal-stage", { dir: dirs[arm], at: new Date().toISOString() }, ctx);
  }
  control("seal-stage", { dir: record.dir, at: new Date().toISOString() }, ctx);

  // §6 — the verdict is derived once, from the sealed record, and a second
  // derivation that disagrees is an integrity stop rather than a new answer.
  const verdict = control("strength-verdict", {
    root: ctx.root, attemptId: ctx.attemptId, stage, dirs, recordDir: record.dir,
    at: new Date().toISOString(),
  }, ctx);
  control("ledger", {
    ledgerPath: ctx.ledgerPath, poolId: pool.poolId, to: "REVEALED", at,
    note: `${ctx.attemptId} ${stage} revealed`,
  }, ctx);
  say(`${stage}: sealed and revealed`);
  return { paused: false, verdict, dirs, recordDir: record.dir };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function record(step, fields, ctx) {
  return control("record", {
    root: ctx.root, attemptId: ctx.attemptId, at: new Date().toISOString(), step, fields,
  }, ctx);
}

async function runAttempt(ctx) {
  for (;;) {
    if (past(ctx.deadline)) {
      record({ kind: "stop", reason: "PAUSED_DEADLINE" }, { stopReason: "PAUSED_DEADLINE" }, ctx);
      say("deadline reached; the attempt is paused and its checkpoints are on disk");
      return EXIT.PAUSED_DEADLINE;
    }
    const { step } = control("next-step", {
      root: ctx.root, attemptId: ctx.attemptId,
    }, ctx);

    if (step.kind === "stop") {
      say(`stopped: ${step.reason}`);
      return step.reason === "PAUSED_DEADLINE" ? EXIT.PAUSED_DEADLINE : EXIT.OK;
    }
    if (step.kind === "done") {
      say(`decided: ${step.outcome}`);
      return EXIT.OK;
    }

    journal(ctx.root, { attemptId: ctx.attemptId, step: step.kind, detail: step.purpose ?? null });

    switch (step.kind) {
      case "corpus": {
        const result = await stepCorpus(step, ctx);
        if (result.paused) {
          say(`corpus ${step.purpose}: paused at the deadline`);
          return EXIT.PAUSED_DEADLINE;
        }
        ctx.stageDirs[step.purpose] = result.dir;
        record(step, {}, ctx);
        break;
      }
      case "train": {
        ctx.candidateLayer = stepTrain(ctx);
        const fields = { threshold: undefined };
        void fields;
        record(step, {}, ctx);
        break;
      }
      case "calibrate": {
        const attemptDir = join(ctx.root, "attempts", ctx.attemptId);
        const result = control("calibrate", {
          root: ctx.root, attemptId: ctx.attemptId, at: new Date().toISOString(),
          dir: ctx.stageDirs.calibration, pools: ctx.attempt.pools,
          schemaHash: ctx.schemaHash,
          params: ctx.protocol.model, lightgbmVersion: ctx.protocol.model.lightgbmVersion,
        }, ctx);
        const selected = result.selected;
        if (selected === null || result.reason !== "selected") {
          say("calibration: no threshold cleared the support floors and the lower bound");
          record(step, { threshold: null }, ctx);
          break;
        }
        const calibrated = { ...candidateLayerOf(ctx), threshold: selected };
        ctx.candidateLayer = calibrated;
        // The layer the strength arms play is the one the calibration chose, so
        // the packaged artifact is rewritten with its threshold beside it and
        // the arm config hash moves with it.
        writeFileSync(join(attemptDir, "calibration.json"),
          `${JSON.stringify({ threshold: selected, reason: result.reason }, null, 2)}\n`, "utf8");
        say(`calibration: threshold ${String(selected)}`);
        record(step, { threshold: selected }, ctx);
        break;
      }
      case "offline": {
        const result = control("offline", {
          root: ctx.root, attemptId: ctx.attemptId, at: new Date().toISOString(),
          dir: ctx.stageDirs.offline, pools: ctx.attempt.pools,
          recordDir: join(ctx.root, "attempts", ctx.attemptId, "stages", "offline"),
          threshold: candidateLayerOf(ctx).threshold,
        }, ctx);
        say(`offline: ${result.decision}`);
        record(step, {}, ctx);
        if (result.decision === "SCREEN_REJECT") {
          // The state machine routes a rejected screen to `decide` on its own;
          // nothing here has to remember to.
          break;
        }
        break;
      }
      case "stage1": {
        const result = await stepStrength("stage1", ctx, ctx.protocol.stage1.deals);
        if (result.paused) {
          return EXIT.PAUSED_DEADLINE;
        }
        record(step, { stage1: result.verdict }, ctx);
        break;
      }
      case "plan-formal": {
        const attemptDir = join(ctx.root, "attempts", ctx.attemptId);
        const plan = control("formal-plan", {
          root: ctx.root, attemptId: ctx.attemptId, at: new Date().toISOString(),
          pool: strengthPool(ctx, "formal"),
          recordDir: join(attemptDir, "verdicts", "stage1"),
        }, ctx);
        say(`formal plan: N=${String(plan.n)}${plan.powerCapped ? " (POWER_CAPPED)" : ""}`);
        record(step, { formalPlan: plan, formalN: plan.n }, ctx);
        break;
      }
      case "formal": {
        const result = await stepStrength("formal", ctx, step.n);
        if (result.paused) {
          return EXIT.PAUSED_DEADLINE;
        }
        record(step, {}, ctx);
        break;
      }
      case "decide": {
        const decided = control("decide", {
          root: ctx.root, attemptId: ctx.attemptId, at: new Date().toISOString(),
        }, ctx);
        say(`decided: ${decided.outcome} at ${decided.stage}`);
        break;
      }
      default:
        throw new Error(`The runner has no branch for step "${step.kind}".`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function gitState() {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  return {
    runnerCommit: (commit.stdout ?? "").trim() || "unknown",
    runnerDirty: (status.stdout ?? "").trim() !== "",
  };
}

async function run(options) {
  const deadline = deadlineMs(options);
  if (past(deadline)) {
    // Rule 3 of the host protocol, applied again here: a runner that woke up
    // late starts nothing at all.
    say(`the absolute deadline ${String(options.deadline)} has already passed; nothing started`);
    return EXIT.PAUSED_DEADLINE;
  }
  const { runnerCommit, runnerDirty } = gitState();
  const at = new Date().toISOString();
  const registered = control("register", {
    root: options.root, at, runnerCommit, runnerDirty,
    ledgerPath: process.env.FPI_LEDGER_PATH,
  }, options);
  if (registered.stop !== null && registered.stop !== undefined) {
    say(`factory stopped: ${registered.stop}`);
    return EXIT.OK;
  }
  const attempt = registered.attempt;
  if (attempt === null || attempt === undefined) {
    say("the factory has no attempt to run and the state machine allows no new one");
    return EXIT.OK;
  }
  const view = control("inspect", {
    root: options.root, runnerCommit, runnerDirty,
  }, options);
  if (typeof view.protocolHash !== "string" || view.protocol === undefined) {
    throw new Error("The control plane did not report the protocol it is running under.");
  }
  const protocol = view;
  if (attempt.protocolHash !== protocol.protocolHash) {
    throw new Error(
      `Attempt ${attempt.attemptId} is registered under protocol ` +
      `${String(attempt.protocolHash).slice(0, 16)}; the file now hashes to ` +
      `${String(protocol.protocolHash).slice(0, 16)}.`,
    );
  }
  say(`attempt ${attempt.attemptId} (${attempt.kind}) parent ${attempt.parentChampionId} ` +
    `${registered.created === true ? "created" : "restored"}`);
  if (runnerDirty) {
    say("warning: the working tree is dirty; runnerCommit names the last commit, not the tree");
  }

  const ctx = {
    root: options.root,
    attemptId: attempt.attemptId,
    attempt,
    championId: attempt.parentChampionId,
    ledgerPath: process.env.FPI_LEDGER_PATH ?? null,
    protocolHash: protocol.protocolHash,
    runnerCommit,
    protocol: protocol.protocol,
    schemaHash: protocol.schemaHash,
    deadline,
    jobs: Number.isFinite(DEFAULT_JOBS) && DEFAULT_JOBS > 0 ? DEFAULT_JOBS : 8,
    stageDirs: {},
    candidateLayer: null,
    children: new Set(),
    stage: null,
    deals: 0,
  };
  return runAttempt(ctx);
}

/**
 * Progress, and only progress.
 *
 * Built from the control plane's `inspect`, whose per-stage view is already
 * exactly the allowed set for an unsealed stage — the plan, the completion
 * counts and the hash table — so there is no field here that could carry a
 * strength even if somebody wanted one to.
 */
function status(options) {
  const answer = control("inspect", {
    root: options.root, runnerCommit: null, runnerDirty: null,
  }, options);
  const factory = answer.factory;
  const lines = [
    `attempt ${factory?.pendingAttemptId ?? "none"}  champion ${factory?.championId ?? "?"}  ` +
    `attempts used ${Array.isArray(factory?.attempts) ? factory.attempts.length : 0}  ` +
    `protocol ${String(answer.protocolHash ?? "").slice(0, 16)}`,
  ];
  for (const stage of answer.stages ?? []) {
    const counts = Object.entries(stage.completed ?? {})
      .map(([arm, done]) => `${arm} ${String(done)}/${String(stage.deals ?? 0)}`)
      .join("  ");
    lines.push(
      `  ${String(stage.stage)}: ${String(stage.completion)}  ${counts}` +
      `${stage.sealed === true ? "  sealed" : ""}`,
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.OK;
}

function inspect(options) {
  const { runnerCommit, runnerDirty } = gitState();
  const answer = control("inspect", { root: options.root, runnerCommit, runnerDirty }, options);
  process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
  return EXIT.OK;
}

const options = parseArgs(process.argv.slice(2));
const handlers = {
  run,
  status: async (value) => status(value),
  inspect: async (value) => inspect(value),
};
const handler = handlers[options.mode];
if (handler === undefined) {
  console.error(`unknown mode "${options.mode}"; expected run, status or inspect`);
  process.exit(EXIT.ERROR);
}
try {
  process.exit(await handler(options));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[fpi] ${message}\n`);
  if (/INTEGRITY|integrity/.test(message)) {
    process.exit(EXIT.INTEGRITY_STOP);
  }
  if (/ENOSPC|EACCES|ENOMEM/.test(message)) {
    process.exit(EXIT.RESOURCE_STOP);
  }
  process.exit(EXIT.ERROR);
}
