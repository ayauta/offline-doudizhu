#!/usr/bin/env node
/**
 * Farmer Policy Iteration Factory v1 — the single command (§31).
 *
 *   node scripts/farmer-pi.mjs run      [--root <dir>] [--attempt <id>]
 *                                       [--deadline <ISO-8601 with offset>] [--jobs <n>]
 *   node scripts/farmer-pi.mjs status   [--root <dir>] [--jobs <n>]
 *   node scripts/farmer-pi.mjs inspect  [--root <dir>] [--guard-selftest]
 *
 * `node scripts/farmer-pi.mjs`, not `pnpm farmer-pi`: package.json is not part of
 * this round, so the line above is the entire interface. `run` is what the
 * absolute-deadline host launches, and the two are designed together — this is
 * the host's own usage line, verbatim:
 *
 *   node scripts/farmer-pi-host.mjs run \
 *     --deadline 2026-09-24T08:30:00Z \
 *     --state .local/farmer-pi/attempts/attempt-001/host \
 *     -- node scripts/farmer-pi.mjs run --attempt attempt-001
 *
 * `--attempt` is not how an attempt is chosen — the state machine chooses it, and
 * a run whose flag disagrees refuses to start. It is there so that a host which
 * was told to keep one attempt alive cannot quietly be running another.
 *
 * Environment: `FPI_ROOT` (default `.local/farmer-pi`), `FPI_JOBS` (default 8),
 * `FPI_DEADLINE_UTC` (an absolute instant; `--deadline` wins). `--protocol` and
 * `--ledger` point a rehearsal at a copied protocol document and a copied pool
 * ledger; a rehearsal is the only way to exercise this file without spending a
 * pool, so both are flags rather than a mode of their own.
 *
 * Exit codes — the host and any operator depend on them:
 *
 *   0  progressed to a clean stop, or the Factory has nothing left to do
 *   1  an unexpected error: a bug, a missing file, a broken toolchain
 *   3  PAUSED_DEADLINE — the absolute deadline was reached, or a signal arrived
 *   4  INTEGRITY_STOP — a checkpoint, a seal or a verdict disagreed with itself
 *   5  RESOURCE_STOP — disk, memory or file descriptors ran out
 *
 * ## What this file owns, and what it deliberately does not
 *
 * This file owns the *process*: which step runs next, what is spawned, what is
 * killed, the clock, the journal, the lock and the console. It owns no science.
 * Every derivation — the attempt state machine, the allocation, the manifests and
 * seals, the threshold, the screens and the formal verdict — is asked for from
 * `benchmarks/farmer-pi-control.test.ts` over a process boundary, because a
 * `.mjs` file cannot import the Factory's `.ts` modules and a second
 * implementation of frozen rules is exactly what the two previous rounds were
 * made of. The control plane answers one JSON document per invocation; nothing
 * here re-derives anything it could ask for.
 *
 * Four consequences, each of which has an obvious way to be quietly wrong:
 *
 *   - **the state machine decides, not the runner.** The loop asks `next-step`,
 *     executes what it is told and records what happened. There is no invocation
 *     in which an operator names a stage, and no branch here that compares a
 *     number to a threshold: `decide` is a control mode, so the preregistered
 *     table lives in one frozen place.
 *   - **a running stage is opaque.** Nothing here reads a `deals/` directory, a
 *     manifest or a verdict file; those reads happen in the control plane behind
 *     `readSealedStage`. What reaches this process about a running stage is
 *     `status`, whose fields are `PI_STATUS_KEYS` and nothing else.
 *   - **the console carries no result.** Progress, elapsed, throughput, ETA,
 *     worker health, stage transitions, error codes and retries — and never a
 *     win, a loss, a delta, a mean or an interval. Concretely: worker output is
 *     forwarded only for lines the workers themselves prefix `[fpi `, control
 *     answers are never echoed, and a failed child contributes its log path plus
 *     at most three lines that look like an exception rather than a measurement.
 *   - **resume is not a new attempt.** `register` is asked first on every run.
 *     It restores the attempt already on disk — clearing a deadline pause, and
 *     only a deadline pause — or creates the next one the ledger and the state
 *     machine allow. Nothing here allocates a range; a range only ever comes from
 *     `attemptLayout`, through `register`.
 *
 * ## What is spawned
 *
 *   the control plane   `vitest run --config vitest.benchmark.config.ts
 *                       benchmarks/farmer-pi-control.test.ts`, synchronously, one
 *                       answer per call
 *   the corpus worker   one process per window of a pool's deals, `FPI_JOBS`
 *                       windows in parallel
 *   the stage worker    two processes, one per arm, always in parallel
 *   python              `scripts/cf-train.py <attempt>/train`, then
 *                       `scripts/cf-export-model.py <model.txt> <candidate.json>`
 *                       with exactly two path arguments: the exporter writes the
 *                       module the product ships when it is given a third, and
 *                       nothing in this round may touch `src/`.
 *
 * `--jobs` shards corpora only. A stage's two arms are one directory each — the
 * manifest is per directory and the two arms' configuration hashes differ — so an
 * arm cannot be split across processes without inventing a merge that the seal
 * does not have.
 *
 * ## On disk
 *
 *   <root>/factory.json               the Factory state (written by the control)
 *   <root>/attempts/<attemptId>/      attempt.json, stages/, verdicts/, models/,
 *                                     train/, logs/, run.lock
 *   <root>/control/<NNNN>-<mode>.{json,log}  one file per control call
 *   <root>/journal/<date>.jsonl       one line per step, written by this file
 *
 * `writeFileAtomic` and the lock belong to the control plane; this file writes the
 * journal and the control configurations, and holds `run.lock` for a whole run —
 * releasing it on every exit path, including a signal, because a lock left behind
 * by a runner that forgot to release it is indistinguishable from a live one.
 *
 * ## The deadline, and what a signal means
 *
 * The deadline is an absolute UTC instant compared against the wall clock, never
 * an elapsed duration: a monotonic timer inside a suspended machine measures the
 * wrong thing. It is checked before anything starts, before every step, and every
 * five seconds while workers run; reaching it terminates every spawned child
 * (SIGTERM, then SIGKILL thirty seconds later — the host's own sixty-second budget
 * is the outer bound) and records the attempt's pause, because a pause is a state
 * the next run is meant to find. A SIGTERM or SIGINT does the same to the children
 * but records nothing: an operator's signal is not a result, and the attempt stays
 * exactly where its checkpoints put it.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  rmSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST = join(ROOT, "node_modules", ".bin", "vitest");
const BENCH_CONFIG = "vitest.benchmark.config.ts";
const CONTROL_BENCH = "benchmarks/farmer-pi-control.test.ts";
const CORPUS_BENCH = "benchmarks/farmer-pi-corpus.test.ts";
const STAGE_BENCH = "benchmarks/farmer-pi-stage.test.ts";
const DEFAULT_ROOT = join(ROOT, ".local", "farmer-pi");
const PYLIBS = join(ROOT, ".local", "pylibs");

/** Exit codes. Exported so a host can import them rather than copy them. */
export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  PAUSED_DEADLINE: 3,
  INTEGRITY_STOP: 4,
  RESOURCE_STOP: 5,
});

/** Plain failures are retried this many times; a stop is never retried. */
const RETRY_LIMIT = 2;
const RETRY_PAUSE_MS = 15_000;
/** How often a running stage reports its own health. */
const STATUS_POLL_MS = 120_000;
/** The grace a signalled child gets before it is killed hard. */
const TERM_GRACE_MS = 30_000;
/** How long a shutting-down runner waits for its children to leave. */
const SHUTDOWN_WAIT_MS = 45_000;
/** How much of a failed child's log is read back for classification. */
const TAIL_BYTES = 64 * 1024;

/** The keys the no-peek guard refuses, anywhere in a printed object. */
const FORBIDDEN_KEYS = Object.freeze([
  "wins", "winsA", "winsB", "delta", "mean", "label", "outcome", "payload",
]);

/**
 * A failure with an exit code attached.
 *
 * The distinction the codes carry is between "this data cannot be trusted" (4),
 * "this machine ran out of something" (5) and "this code or this configuration is
 * wrong" (1) — because the first two are conditions the protocol has answers for
 * and the third is a bug report.
 */
class RunnerStop extends Error {
  constructor(message, code = EXIT.ERROR) {
    super(message);
    this.name = "RunnerStop";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Arguments, environment and the clock
// ---------------------------------------------------------------------------

const USAGE = `Farmer Policy Iteration Factory v1.

  node scripts/farmer-pi.mjs run      [--root <dir>] [--attempt <id>]
                                      [--deadline <ISO-8601 with offset>] [--jobs <n>]
  node scripts/farmer-pi.mjs status   [--root <dir>] [--jobs <n>]
  node scripts/farmer-pi.mjs inspect  [--root <dir>] [--guard-selftest]

  --root <dir>       where factory.json, attempts/ and the journal live
                     (default: FPI_ROOT, else .local/farmer-pi)
  --jobs <n>         windows a corpus pool is cut into (default: FPI_JOBS, else 8)
  --deadline <iso>   an absolute instant; --deadline wins over FPI_DEADLINE_UTC
  --attempt <id>     must match the attempt the state machine selects
  --protocol <path>  a copied protocol document, for a rehearsal
  --ledger <path>    a copied pool ledger, for a rehearsal
  --guard-selftest   prove the no-peek guard rejects every forbidden key, then exit

  exit 0 progressed or cleanly stopped, 1 error, 3 PAUSED_DEADLINE,
       4 INTEGRITY_STOP, 5 RESOURCE_STOP
`;

const VALUED_FLAGS = Object.freeze(new Map([
  ["--root", "root"],
  ["--jobs", "jobs"],
  ["--deadline", "deadline"],
  ["--attempt", "attempt"],
  ["--protocol", "protocolPath"],
  ["--ledger", "ledgerPath"],
]));

function parseArgs(argv) {
  const options = {
    mode: null,
    help: false,
    root: null,
    jobs: null,
    deadline: null,
    attempt: null,
    protocolPath: null,
    ledgerPath: null,
    guardSelftest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      options.help = true;
      continue;
    }
    if (token === "--guard-selftest") {
      options.guardSelftest = true;
      continue;
    }
    const key = VALUED_FLAGS.get(token);
    if (key !== undefined) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new RunnerStop(`${token} needs a value.`);
      }
      options[key] = value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      throw new RunnerStop(`Unknown argument "${token}". Try --help.`);
    }
    if (options.mode !== null) {
      throw new RunnerStop(`"${token}" names a second mode; one at a time.`);
    }
    options.mode = token;
  }
  if (options.root === null) {
    options.root = process.env.FPI_ROOT || DEFAULT_ROOT;
  }
  if (options.jobs === null) {
    options.jobs = process.env.FPI_JOBS ?? "8";
  }
  if (!/^[1-9]\d*$/.test(String(options.jobs))) {
    throw new RunnerStop(`--jobs must be a positive integer; received "${options.jobs}".`);
  }
  options.jobs = Number.parseInt(options.jobs, 10);
  return options;
}

/** The paths every control configuration carries, so a rehearsal is explicit. */
function scopeOf(options) {
  return {
    root: options.root,
    protocolPath: options.protocolPath,
    ledgerPath: options.ledgerPath,
  };
}

/**
 * The deadline, as an absolute instant.
 *
 * A string without an offset is refused rather than assumed to be local: after a
 * suspend across a DST boundary the same local time is a different instant, and a
 * hard stop that moves by an hour is not a hard stop.
 */
function deadlineMs(options) {
  const text = options.deadline ?? process.env.FPI_DEADLINE_UTC ?? null;
  if (text === null || text === "") {
    return null;
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new RunnerStop(
      `Deadline "${text}" carries no offset; an absolute instant is required.`,
    );
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new RunnerStop(`Deadline "${text}" is not a parseable instant.`);
  }
  return parsed;
}

function past(deadline) {
  return deadline !== null && Date.now() >= deadline;
}

function sleep(ms) {
  // Deliberately not unref'd: the retry pause is the only pending work at that
  // moment, and an unref'd timer would let the process exit mid-pause with a
  // success code it has not earned.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function short(error) {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.split("\n")[0];
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

/** The last `bytes` of a file, so a failure is classified without reading a gigabyte. */
function tailText(path, bytes = TAIL_BYTES) {
  try {
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

/** A narration line from this file. Counts, the clock, names and codes only. */
function say(line) {
  process.stdout.write(`[fpi] ${line}\n`);
}

/**
 * A worker's own progress line, forwarded verbatim.
 *
 * Only lines the workers prefix `[fpi ` are forwarded. Their other output —
 * vitest's framing, an assertion diff, a failure's code frame — can quote
 * anything, including the numbers a running stage exists to keep unread, so the
 * filter is an allowlist of prefixes rather than a denylist of words. All of every
 * child's output goes to its log either way.
 */
function forward(line) {
  process.stdout.write(`${line.length > 500 ? `${line.slice(0, 500)}...` : line}\n`);
}

function journal(root, entry) {
  const dir = join(root, "journal");
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  appendFileSync(
    join(dir, `${day}.jsonl`),
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// The control plane
// ---------------------------------------------------------------------------

let controlSeq = 0;

/**
 * Which exit code a wall of text implies.
 *
 * A heuristic, and deliberately a narrow one: the frozen modules already say
 * *what* went wrong, and this only classifies it. `IntegrityError` from any of
 * them means a checkpoint, a seal or a verdict disagreed with itself; the resource
 * patterns are the ones a long run actually hits. Everything else is an ordinary
 * failure, and an ordinary failure is retried before it is reported.
 */
const INTEGRITY_PATTERNS = Object.freeze([
  /IntegrityError/, /LedgerError/, /ProtocolError/, /no-peek/,
  /hashes to /, /disagrees with the one/, /registered under protocol/,
  /was edited after/,
]);
const RESOURCE_PATTERNS = Object.freeze([
  /ENOSPC/, /ENOMEM/, /EMFILE/, /EAGAIN/, /EDQUOT/, /no space left/i,
]);

function classifyText(text) {
  if (INTEGRITY_PATTERNS.some((pattern) => pattern.test(text))) {
    return EXIT.INTEGRITY_STOP;
  }
  if (RESOURCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return EXIT.RESOURCE_STOP;
  }
  return EXIT.ERROR;
}

/**
 * At most three lines of a log that look like an exception.
 *
 * An allowlist, not a denylist: a worker's output holds progress lines, vitest's
 * framing and a training script's summary statistics, and the point of this filter
 * is that a failure report cannot smuggle a measurement out with it. The log file
 * keeps everything, for a human to read.
 */
function errorLines(text) {
  const wanted = /IntegrityError|LedgerError|ProtocolError|AssertionError|Error:|error:|Error \[|Traceback|panic/;
  return text
    .split("\n")
    .filter((line) => wanted.test(line))
    .slice(0, 3)
    .join("\n");
}

/**
 * The answers a control invocation gave, in the order it gave them.
 *
 * Two shapes, both legitimate. Most modes `emit` a JSON object. A few report a
 * sentence about the files they wrote — `rows` says which row files it produced
 * and how many rows are in each — and that is an answer too. The failure worth
 * distinguishing is *no* answer at all, because a mode that exited 0 having said
 * nothing is the one case that is not a success.
 *
 * A prose answer is returned as `{ text }` rather than dropped. Treating it as
 * silence cost this runner two spurious retries on its first real training step,
 * and a retry that re-runs a step that already succeeded is exactly the kind of
 * thing that looks like robustness and behaves like a duplicate.
 */
function parseAnswers(output) {
  const answers = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("[fpi control] ")) {
      continue;
    }
    const payload = line.slice("[fpi control] ".length);
    try {
      answers.push(JSON.parse(payload));
    } catch {
      answers.push(Object.freeze({ text: payload }));
    }
  }
  return answers;
}

/**
 * One control mode, one answer.
 *
 * The configuration is a file rather than an environment variable: it is a
 * structured document — pools, steps, sources, directives — and an environment
 * variable is a string with a length limit and a shell-quoting story. The mode
 * appears in both the variable and the file and the control plane refuses when
 * they disagree, so a stale configuration cannot be run as a different mode.
 *
 * Synchronous on purpose. A control call is bookkeeping (milliseconds) or a pass
 * over a sealed corpus (minutes), and nothing else may proceed until it answers.
 */
function controlSync(mode, config, scope) {
  const dir = join(scope.root, "control");
  mkdirSync(dir, { recursive: true });
  controlSeq += 1;
  const stamp = `${String(controlSeq).padStart(4, "0")}-${mode}`;
  const configPath = join(dir, `${stamp}.json`);
  const logPath = join(dir, `${stamp}.log`);
  writeFileSync(configPath, `${JSON.stringify({
    mode,
    ...(scope.protocolPath === null || scope.protocolPath === undefined
      ? {} : { protocolPath: scope.protocolPath }),
    ...(scope.ledgerPath === null || scope.ledgerPath === undefined
      ? {} : { ledgerPath: scope.ledgerPath }),
    ...config,
  }, null, 2)}\n`, "utf8");

  const run = spawnSync(VITEST, ["run", "--config", BENCH_CONFIG, CONTROL_BENCH], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, AI_FPI_CONTROL: mode, AI_FPI_CONTROL_CONFIG: configPath },
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  writeFileSync(logPath, output, "utf8");
  if (run.status !== 0) {
    throw new RunnerStop(
      `control "${mode}" failed (exit ${String(run.status)}). Log ${logPath}\n` +
      errorLines(output),
      classifyText(output),
    );
  }
  const answers = parseAnswers(output);
  if (answers.length === 0) {
    throw new RunnerStop(
      `control "${mode}" exited 0 and answered nothing. Log ${logPath}\n${errorLines(output)}`,
    );
  }
  return answers[answers.length - 1];
}

/** The control plane's answer, refused unless it carries the record the runner reads. */
function attemptOf(answer, mode) {
  const attempt = answer.attempt;
  if (attempt === null || typeof attempt !== "object" || typeof attempt.attemptId !== "string") {
    throw new RunnerStop(`control "${mode}" answered without an attempt record.`);
  }
  return attempt;
}

// ---------------------------------------------------------------------------
// The ledger, and the lock
// ---------------------------------------------------------------------------

/**
 * One pool transition, best effort.
 *
 * The load-bearing ledger write is the allocation, and `register` makes it. The
 * moves below describe *where a pool has got to*, and a runner that refused to
 * continue because a bookkeeping append failed would turn a stale note into a lost
 * night — so they are reported and the run continues. The allocation itself is
 * never best effort.
 */
function movePool(scope, poolId, to, note) {
  try {
    controlSync("ledger", {
      poolId, to, at: new Date().toISOString(), note,
    }, scope);
  } catch (error) {
    say(`ledger: ${poolId} -> ${to} did not land (${short(error)})`);
  }
}

/** Every pool of an attempt, closed. Called once the attempt has decided. */
function consumePools(ctx) {
  for (const [purpose, pool] of Object.entries(ctx.pools)) {
    movePool(ctx.scope, pool.poolId, "CONSUMED", `${ctx.attemptId} decided (${purpose})`);
  }
}

let heldLock = null;

function releaseLock() {
  const path = heldLock;
  heldLock = null;
  if (typeof path === "string") {
    rmSync(path, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

/** Every child that is still running, so a stop can reach all of them. */
const ACTIVE = new Set();

/** The protocol document this run is under: the scope's, or the repository's. */
function protocolPathOf(ctx) {
  const fromScope = ctx.scope === undefined ? null : ctx.scope.protocolPath;
  const path = fromScope ?? ctx.protocolPath ?? null;
  return path === "" ? null : path;
}

function workerEnv(ctx) {
  return {
    ...process.env,
    // Two identities, never merged (§2): the hash of `protocol-v1.yaml`'s own
    // bytes, which every checkpoint cites, and the runner's git commit, which is
    // provenance and nothing else. The workers re-derive the first from the file
    // and refuse when the two disagree.
    AI_FPI_PROTOCOL_HASH: ctx.protocolHash,
    AI_FPI_POLICY_COMMIT: ctx.runnerCommit,
    AI_FPI_ATTEMPT_ID: ctx.attemptId,
    AI_FPI_CHAMPION_ID: ctx.championId,
    // The document, not just its digest: a worker re-derives the hash from the
    // file it is pointed at, and a rehearsal runs under its own protocol. The
    // path lives on the scope every control call already carries.
    ...(protocolPathOf(ctx) === null ? {} : { AI_FPI_PROTOCOL_PATH: protocolPathOf(ctx) }),
  };
}

/**
 * One worker window, spawned and watched.
 *
 * A child process rather than an in-process call for two reasons: the benchmark
 * configuration forces single-file, non-concurrent execution, so parallelism has
 * to come from processes; and a killed child leaves the deal checkpoints it had
 * already written on disk, which is the whole point of §27.
 *
 * The log is opened in append mode, so a resume's second attempt at the same
 * window keeps the first one's failure text beside its own.
 */
function startWindow(spec) {
  const { bench, env, logPath, label } = spec;
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  const child = spawn(VITEST, ["run", "--config", BENCH_CONFIG, bench], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const window = {
    label,
    logPath,
    killed: false,
    terminate() {
      if (window.killed) {
        return;
      }
      window.killed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone; the promise below is what this waits on either way.
      }
      const hard = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // As above.
        }
      }, TERM_GRACE_MS);
      hard.unref?.();
    },
  };
  let pending = "";
  const onChunk = (chunk) => {
    writeSync(logFd, chunk);
    const lines = `${pending}${chunk.toString("utf8")}`.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("[fpi ")) {
        forward(line);
      }
    }
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);
  window.done = new Promise((resolve) => {
    let settled = false;
    const finish = (code) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        closeSync(logFd);
      } catch {
        // Already closed; there is nothing else to do about it.
      }
      resolve(code);
    };
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });
  ACTIVE.add(window);
  window.done.then(() => ACTIVE.delete(window));
  return window;
}

/**
 * Runs a set of windows to completion with the deadline enforced on the way.
 *
 * A deadline-killed window exits non-zero, so it is reported as `deadlineHit`
 * rather than as a failure: the two need different words from the caller, and only
 * one of them is about the stage.
 *
 * A window that fails on its own stops its siblings immediately. Shards of one
 * corpus are hours of the same work, and an integrity failure in one of them is a
 * judgment about the pool they were all drawn from — waiting for the other seven
 * to finish before reporting it would spend a night to learn what was known in the
 * first minute.
 */
async function runWindows(specs, ctx) {
  const windows = specs.map((spec) => startWindow(spec));
  const polled = specs.filter((spec) => spec.statusDir !== undefined);
  const poll = polled.length === 0 ? () => {} : startStatusPoll(polled, ctx);
  const watchdog = setInterval(() => {
    if (past(ctx.deadline)) {
      for (const window of windows) {
        if (!window.killed) {
          say(`deadline reached: stopping ${window.label}`);
        }
        window.terminate();
      }
    }
  }, 5_000);
  const codes = new Array(windows.length).fill(0);
  const collateral = new Set();
  let stopped = false;
  await Promise.all(windows.map(async (window, index) => {
    codes[index] = await window.done;
    // A window the runner killed is not evidence about the stage, so only an
    // unkilled non-zero exit starts the cascade.
    if (codes[index] !== 0 && !window.killed && !stopped) {
      stopped = true;
      say(`stopping the other window(s): ${window.label} failed`);
      for (const other of windows) {
        if (other !== window && !other.killed) {
          collateral.add(other);
          other.terminate();
        }
      }
    }
  }));
  clearInterval(watchdog);
  poll();
  if (past(ctx.deadline)) {
    return { deadlineHit: true };
  }
  const failed = windows.filter((window, index) => codes[index] !== 0 && !collateral.has(window));
  if (failed.length > 0) {
    const logs = failed.map((window) => window.logPath).join(", ");
    const text = failed.map((window) => tailText(window.logPath)).join("\n");
    throw new RunnerStop(
      `${failed.length} of ${windows.length} window(s) failed (${failed
        .map((window) => window.label).join(", ")}). Logs ${logs}\n${errorLines(text)}`,
      classifyText(text),
    );
  }
  return { deadlineHit: false };
}

/**
 * Live health for a running stage: `status` and nothing else.
 *
 * The poll is a separate vitest process and it is synchronous, so the window in
 * which a worker's stdout is not being drained is the poll's own runtime — a
 * second or two, against the 64 KiB pipe buffer a deal-per-second worker fills in
 * minutes. The fields printed are `PI_STATUS_KEYS` by construction, which is why
 * this is the one way a running stage may describe itself.
 */
function startStatusPoll(specs, ctx) {
  const timer = setInterval(() => {
    for (const spec of specs) {
      try {
        const status = controlSync("status", {
          dir: spec.statusDir,
          elapsedMs: Date.now() - spec.statusStartedAt,
          workers: ctx.jobs,
        }, ctx.scope);
        const eta = status.etaMs === null || status.etaMs === undefined
          ? "unknown"
          : `${(Number(status.etaMs) / 60000).toFixed(0)}m`;
        say(
          `${spec.statusLabel}: ${String(status.completion)} checkpoints ` +
          `${String(status.checkpoints)} elapsed ${(Number(status.elapsedMs) / 1000).toFixed(0)}s ` +
          `throughput ${Number(status.throughputPerHour).toFixed(1)}/h eta ${eta} ` +
          `workers ${String(status.workers)}`,
        );
      } catch (error) {
        say(`${spec.statusLabel}: status unavailable (${short(error)})`);
      }
    }
  }, STATUS_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Splits a pool into contiguous per-worker windows.
 *
 * Contiguous and absolute, so the shards together play exactly the deals an
 * unsharded run would have played: a deal's seed is its absolute index and nothing
 * about it depends on how the window was cut. That is what makes the sharding a
 * change in wall clock and in nothing else.
 */
function windowsFor(start, deals, jobs) {
  const count = Math.max(1, Math.min(jobs, deals));
  const windows = [];
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    const before = Math.floor((index * deals) / count);
    const after = Math.floor(((index + 1) * deals) / count);
    const size = after - before;
    if (size > 0) {
      windows.push({ start: cursor, deals: size });
      cursor += size;
    }
  }
  return windows;
}

/**
 * One python step, with its output kept in the log.
 *
 * `cf-train.py` prints the label tally of the corpus it was handed and the summary
 * statistics of the calibration scores. Both are results, neither is allowed on a
 * console, and both are useful in a post-mortem — so the log gets everything and
 * the console gets the exit code, the log path and at most three exception-shaped
 * lines.
 */
function pythonStep(args, logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const run = spawnSync("python3", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONPATH: process.env.PYTHONPATH === undefined
        ? PYLIBS
        : `${PYLIBS}${process.env.PYTHONPATH.startsWith(":") ? "" : ":"}${process.env.PYTHONPATH}`,
    },
  });
  const output = `$ python3 ${args.join(" ")}\n${run.stdout ?? ""}${run.stderr ?? ""}`;
  appendFileSync(logPath, output, "utf8");
  if (run.status !== 0) {
    throw new RunnerStop(
      `python3 ${args.join(" ")} failed (exit ${String(run.status)}). Log ${logPath}\n` +
      errorLines(output),
    );
  }
}

// ---------------------------------------------------------------------------
// Paths, pools and the candidate layer
// ---------------------------------------------------------------------------

/**
 * The three directory shapes the layout defines.
 *
 * Written here rather than asked for, because a resumed step has no `open-stage`
 * answer to reuse and the layout *is* the contract. Every read that follows is
 * guarded on the control plane's side: a directory that is not sealed, or whose
 * payload was edited after the seal, is refused there and not here.
 */
function attemptDir(ctx) {
  return join(ctx.root, "attempts", ctx.attemptId);
}

function corpusStageDir(ctx, purpose) {
  return join(attemptDir(ctx), "stages", purpose);
}

function recordStageDir(ctx, stage) {
  return join(attemptDir(ctx), "verdicts", stage);
}

/**
 * The pool a *stage directory* was generated from.
 *
 * Read from the stage's own manifest rather than looked up in the current
 * attempt's pools, because a retry inherits its parent's training corpus: the
 * `train` source of an attempt-002 belongs to attempt-001, and asking the
 * current record for it is how a correct retry reads as "no such pool".
 */
function poolIdOfStage(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (typeof manifest.poolId !== "string" || manifest.poolId === "") {
    throw new RunnerStop(`The stage at ${dir} records no pool.`);
  }
  return manifest.poolId;
}

function poolOf(ctx, purpose) {
  const pool = ctx.pools[purpose];
  if (pool === undefined) {
    throw new RunnerStop(`${ctx.attemptId} holds no pool for purpose "${purpose}".`);
  }
  return pool;
}

function logPathFor(ctx, label) {
  return join(attemptDir(ctx), "logs", `${label}.log`);
}

/**
 * The candidate layer, as far as the record knows it.
 *
 * On a resume this is rebuilt from the attempt record — the packaged artifact's
 * path, digest and size, written once by the `train` step, and the threshold,
 * written once by `calibrate` — because a resumed run never re-enters those steps,
 * and a layer reconstructed from anything else could play a different chain than
 * the one the attempt registered.
 *
 * The record calls the artifact's location `path`; a chain layer calls it
 * `artifactPath`. The two names are the record's and the chain's respectively, and
 * this is the one place they meet.
 */
function layerOf(attempt) {
  if (attempt.model === null || attempt.model === undefined) {
    return null;
  }
  return {
    artifactPath: attempt.model.path,
    modelSha256: attempt.model.modelSha256,
    modelBytes: attempt.model.modelBytes,
    threshold: attempt.threshold ?? null,
  };
}

function layerSpec(ctx) {
  if (ctx.layer === null) {
    throw new RunnerStop(
      `${ctx.attemptId} has no packaged candidate layer; its train step has not run.`,
    );
  }
  return ctx.layer;
}

function calibratedLayer(ctx) {
  const layer = layerSpec(ctx);
  if (layer.threshold === null || !Number.isFinite(layer.threshold)) {
    throw new RunnerStop(
      `${ctx.attemptId} has no calibrated threshold, so its candidate arm cannot play.`,
    );
  }
  return layer;
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/**
 * `corpus` — one pool's deals, sharded, sealed when complete.
 *
 * The manifest is written before the first deck is dealt, so a run killed in its
 * first minute resumes rather than restarts; the seal comes after every shard has
 * exited zero, because a verdict may only follow a seal and the seal is therefore
 * the moment the pool becomes readable.
 */
async function stepCorpus(step, ctx) {
  const purpose = step.purpose;
  const pool = poolOf(ctx, purpose);
  const at = new Date().toISOString();
  const opened = controlSync("open-stage", {
    root: ctx.root,
    attemptId: ctx.attemptId,
    stage: purpose,
    role: "corpus",
    championId: ctx.championId,
    at,
    pool: { poolId: pool.poolId, purpose, start: pool.start, end: pool.end },
  }, ctx.scope);
  if (opened.completion !== "SEALED") {
    movePool(ctx.scope, pool.poolId, "RUNNING", `${ctx.attemptId} generating ${purpose}`);
  }

  const windows = windowsFor(pool.start, pool.end - pool.start + 1, ctx.jobs);
  say(`corpus ${purpose}: ${windows.length} window(s) over ${pool.start}..${pool.end}`);
  const startedAt = Date.now();
  const { deadlineHit } = await runWindows(windows.map((window) => ({
    bench: CORPUS_BENCH,
    label: `corpus ${purpose} ${window.start}..${window.start + window.deals - 1}`,
    logPath: logPathFor(ctx, `corpus-${purpose}-${window.start}`),
    statusDir: opened.dir,
    statusLabel: `corpus ${purpose}`,
    statusStartedAt: startedAt,
    env: {
      ...workerEnv(ctx),
      AI_FPI_CORPUS_GENERATE: opened.dir,
      AI_FPI_POOL_ID: pool.poolId,
      AI_FPI_POOL_START: String(pool.start),
      AI_FPI_POOL_END: String(pool.end),
      AI_FPI_PURPOSE: purpose,
      AI_FPI_DEAL_START: String(window.start),
      AI_FPI_DEALS: String(window.deals),
    },
  })), ctx);
  if (deadlineHit) {
    say(`corpus ${purpose}: paused at the deadline; its deals stay checkpointed`);
    return { paused: true };
  }

  if (opened.completion !== "SEALED") {
    const sealed = controlSync("seal-stage", {
      dir: opened.dir, at: new Date().toISOString(),
    }, ctx.scope);
    movePool(ctx.scope, pool.poolId, "SEALED_COMPLETE", `${ctx.attemptId} sealed ${purpose}`);
    say(
      `corpus ${purpose}: sealed, ${String(sealed.deals)} deals, ` +
      `${String(sealed.checkpoints)} checkpoints, ` +
      `${((Date.now() - startedAt) / 60000).toFixed(1)} min`,
    );
  } else {
    say(`corpus ${purpose}: already sealed`);
  }
  return { paused: false, attempt: recordStep(step, {}, ctx) };
}

/**
 * The base attempt's sealed `train` stage, for a retry's inherited rows.
 *
 * Found through the control plane's own inventory rather than by guessing at
 * `attempt-<n-1>`: a retry inherits the rows of the base attempt *of its own
 * parent champion*, which is what `parentChampionId` says, and the attempt that
 * generated them is the one this looks for.
 */
function parentTrainStageDir(ctx) {
  const view = controlSync("inspect", { root: ctx.root }, ctx.scope);
  const attempts = Array.isArray(view.attempts) ? view.attempts : [];
  const stages = Array.isArray(view.stages) ? view.stages : [];
  for (const attempt of attempts) {
    if (attempt.attemptId === ctx.attemptId || attempt.kind !== "base") {
      continue;
    }
    if (attempt.parentChampionId !== ctx.championId) {
      continue;
    }
    const train = stages.find((stage) =>
      stage.attemptId === attempt.attemptId && stage.stage === "train" &&
      stage.sealed === true && typeof stage.dir === "string");
    if (train !== undefined) {
      return train.dir;
    }
  }
  throw new RunnerStop(
    `${ctx.attemptId} is a retry of ${ctx.championId} and no sealed train stage of that ` +
    "champion's base attempt exists to inherit rows from.",
  );
}

/**
 * `train` — the rows, the booster and the packaged layer.
 *
 * Three steps in the order the provenance needs them: the control plane writes the
 * two row files out of the *sealed* corpora, `cf-train.py` fits and scores,
 * `cf-export-model.py` packages. The exporter is handed exactly two paths, so it
 * writes the JSON wrapper and never the module the product ships.
 *
 * The digest is computed here, from the booster's own bytes, and required to equal
 * the one the wrapper claims. Copying the claim instead would make the attempt's
 * record a statement about a file rather than about the model in it, and the arms
 * verify that claim against the file *they* parse — so a wrapper that lied would
 * be caught two stages later, at the arm, after the pools had been spent.
 *
 * A retry trains on the base attempt's rows as well as its own fresh ones: that is
 * "the same candidate with more data", and the order of the sources is part of the
 * corpus, so the inherited half is listed first.
 */
function stepTrain(step, ctx) {
  const trainDir = join(attemptDir(ctx), "train");
  const at = new Date().toISOString();
  const freshPurpose = ctx.attempt.kind === "retry" ? "train-fresh" : "train";
  const sources = [{ dir: corpusStageDir(ctx, freshPurpose), purpose: freshPurpose }];
  if (ctx.attempt.kind === "retry") {
    sources.unshift({ dir: parentTrainStageDir(ctx), purpose: "train" });
  }
  sources.push({ dir: corpusStageDir(ctx, "calibration"), purpose: "calibration" });

  controlSync("rows", {
    root: ctx.root, attemptId: ctx.attemptId, at, outDir: trainDir, sources,
  }, ctx.scope);
  for (const source of sources) {
    movePool(
      ctx.scope,
      poolIdOfStage(source.dir),
      "REVEALED",
      `${ctx.attemptId} rows exported from ${source.purpose}`,
    );
  }

  const boosterPath = join(trainDir, "model.txt");
  const packagePath = join(attemptDir(ctx), "models", "candidate.json");
  mkdirSync(dirname(packagePath), { recursive: true });
  say(`train: ${sources.length} source(s), fitting`);
  const startedAt = Date.now();
  pythonStep(["scripts/cf-train.py", trainDir], logPathFor(ctx, "train"));
  pythonStep(
    ["scripts/cf-export-model.py", boosterPath, packagePath],
    logPathFor(ctx, "export"),
  );

  const booster = readFileSync(boosterPath);
  const digest = createHash("sha256").update(booster).digest("hex");
  const wrapperText = readFileSync(packagePath, "utf8");
  const claimed = JSON.parse(wrapperText).modelSha256;
  if (claimed !== digest) {
    throw new RunnerStop(
      `${packagePath} claims model ${String(claimed)} and ${boosterPath} hashes to ${digest}. ` +
      "The packaged layer is not the booster that was just trained.",
      EXIT.INTEGRITY_STOP,
    );
  }
  const model = {
    path: packagePath,
    modelSha256: digest,
    modelBytes: Buffer.byteLength(wrapperText, "utf8"),
  };
  say(
    `train: model ${digest.slice(0, 16)} ${model.modelBytes} bytes, ` +
    `${((Date.now() - startedAt) / 60000).toFixed(1)} min`,
  );
  // The threshold does not exist yet. The layer is carried from here so that
  // `calibrate` can fill it in and the offline screen can screen at it.
  ctx.layer = { ...model, artifactPath: packagePath, threshold: null };
  return { paused: false, attempt: recordStep(step, { model }, ctx) };
}

/**
 * `calibrate` — the threshold, from the sealed calibration corpus (§16).
 *
 * The selection is the control plane's; what this step does is refuse to carry a
 * value it cannot use and record the one it can. A no-go is not an error: the
 * preregistered answer to "no threshold cleared the floors" is to decide the
 * attempt, and the state machine routes it there on its own once the record says
 * no threshold was frozen.
 */
function stepCalibrate(step, ctx) {
  const layer = layerSpec(ctx);
  const result = controlSync("calibrate", {
    root: ctx.root,
    attemptId: ctx.attemptId,
    at: new Date().toISOString(),
    dir: corpusStageDir(ctx, "calibration"),
    pools: ctx.pools,
    // `calibrate` reads the artifact, its digest and its size, and chooses the
    // threshold. The field is carried with a placeholder because a chain layer has
    // a threshold and this is the step that finds out what it is.
    layer: { ...layer, threshold: 0 },
  }, ctx.scope);
  if (result.selected === null || result.selected === undefined) {
    say(`calibration: ${String(result.reason)} (no threshold frozen)`);
    return { paused: false, attempt: recordStep(step, {}, ctx) };
  }
  const threshold = Number(result.selected);
  if (!Number.isFinite(threshold)) {
    throw new RunnerStop(
      `calibration selected ${String(result.selected)}; a threshold is a finite number.`,
      EXIT.INTEGRITY_STOP,
    );
  }
  ctx.layer = { ...layer, threshold };
  say(`calibration: threshold frozen (${String(result.reason)})`);
  return { paused: false, attempt: recordStep(step, { threshold }, ctx) };
}

/**
 * `offline` — the screen (§15), and the first verdict of an attempt.
 *
 * The screen has no `decide` step of its own: the state machine routes OFFLINE
 * onward unconditionally, so a SCREEN_REJECT is recorded by the decide mode, which
 * reads the same sealed verdict this writes. What this step owes the verdict is a
 * *sealed* stage to live in, which is what the record directory is for — a verdict
 * is written once, into a stage that no longer changes.
 */
function stepOffline(step, ctx) {
  const pool = poolOf(ctx, "offline");
  const at = new Date().toISOString();
  const record = controlSync("open-stage", {
    root: ctx.root,
    attemptId: ctx.attemptId,
    stage: "offline",
    role: "record",
    championId: ctx.championId,
    at,
    pool: { poolId: pool.poolId, purpose: "offline", start: pool.start, end: pool.end },
  }, ctx.scope);
  if (record.completion !== "SEALED") {
    controlSync("seal-stage", { dir: record.dir, at: new Date().toISOString() }, ctx.scope);
  }
  const layer = calibratedLayer(ctx);
  const screen = controlSync("offline", {
    root: ctx.root,
    attemptId: ctx.attemptId,
    at,
    dir: corpusStageDir(ctx, "offline"),
    pools: ctx.pools,
    recordDir: record.dir,
    threshold: layer.threshold,
    layer,
  }, ctx.scope);
  say(`offline: ${String(screen.decision)}${screen.recorded === true ? " (recorded)" : ""}`);
  movePool(ctx.scope, pool.poolId, "REVEALED", `${ctx.attemptId} offline screened`);
  return { paused: false, attempt: recordStep(step, {}, ctx) };
}

/**
 * `stage1` and `formal` — two arms, sealed, then one verdict (§6, §20).
 *
 * Four directories are opened before anything plays: one per arm, because the two
 * arms' configuration hashes differ and a manifest holds one hash, and one
 * *record* stage with no deals of its own, which exists so that the verdict has a
 * sealed stage to be written into. The arms are then spawned together — they are
 * the same deals played by two chains, and running them one after the other only
 * doubles the wall clock.
 */
async function stepStrength(step, ctx) {
  const stage = step.kind === "stage1" ? "stage1" : "formal";
  const pool = poolOf(ctx, stage);
  const deals = step.kind === "stage1" ? ctx.protocol.stage1.deals : step.n;
  const at = new Date().toISOString();
  const record = controlSync("open-stage", {
    root: ctx.root, attemptId: ctx.attemptId, stage, role: "record",
    championId: ctx.championId, at,
    pool: { poolId: pool.poolId, purpose: stage, start: pool.start, end: pool.end },
  }, ctx.scope);
  const layer = calibratedLayer(ctx);
  const dirs = {};
  const opened = {};
  for (const arm of ["champion", "candidate"]) {
    const answer = controlSync("open-stage", {
      root: ctx.root, attemptId: ctx.attemptId, stage, role: "arm", arm,
      championId: ctx.championId, at,
      pool: {
        poolId: pool.poolId, purpose: stage, start: pool.start, end: pool.start + deals - 1,
      },
      ...(arm === "candidate" ? { layer } : {}),
    }, ctx.scope);
    dirs[arm] = answer.dir;
    opened[arm] = answer;
  }
  if (opened.champion.completion !== "SEALED") {
    movePool(ctx.scope, pool.poolId, "RUNNING", `${ctx.attemptId} ${stage} playing`);
  }

  const startedAt = Date.now();
  say(`${stage}: two arms over deals ${pool.start}..${pool.start + deals - 1}`);
  const { deadlineHit } = await runWindows(["champion", "candidate"].map((arm) => ({
    bench: STAGE_BENCH,
    label: `${stage} ${arm}`,
    logPath: logPathFor(ctx, `${stage}-${arm}`),
    statusDir: dirs[arm],
    statusLabel: `${stage} ${arm}`,
    statusStartedAt: startedAt,
    env: {
      ...workerEnv(ctx),
      AI_FPI_ARM_RUN: dirs[arm],
      AI_FPI_ARM: arm,
      AI_FPI_STAGE: stage,
      AI_FPI_POOL_START: String(pool.start),
      AI_FPI_DEALS: String(deals),
      ...(arm === "candidate"
        ? {
            AI_FPI_CANDIDATE_LAYER: layer.artifactPath,
            AI_FPI_CANDIDATE_SHA: layer.modelSha256,
            AI_FPI_CANDIDATE_THRESHOLD: String(layer.threshold),
            AI_FPI_CANDIDATE_BYTES: String(layer.modelBytes),
          }
        : {}),
    },
  })), ctx);
  if (deadlineHit) {
    say(`${stage}: paused at the deadline; its deals stay checkpointed`);
    return { paused: true };
  }

  if (opened.champion.completion !== "SEALED") {
    for (const arm of ["champion", "candidate"]) {
      controlSync("seal-stage", { dir: dirs[arm], at: new Date().toISOString() }, ctx.scope);
    }
    movePool(ctx.scope, pool.poolId, "SEALED_COMPLETE", `${ctx.attemptId} ${stage} sealed`);
  }
  if (record.completion !== "SEALED") {
    controlSync("seal-stage", { dir: record.dir, at: new Date().toISOString() }, ctx.scope);
  }
  const verdict = controlSync("strength-verdict", {
    root: ctx.root, attemptId: ctx.attemptId, stage, dirs, recordDir: record.dir,
    at: new Date().toISOString(),
  }, ctx.scope);
  movePool(ctx.scope, pool.poolId, "REVEALED", `${ctx.attemptId} ${stage} revealed`);
  say(
    `${stage}: sealed and revealed, ${deals} deals per arm, ` +
    `${((Date.now() - startedAt) / 60000).toFixed(1)} min` +
    `${verdict.recorded === true ? " (verdict already on disk)" : ""}`,
  );
  return { paused: false, verdict };
}

/**
 * `plan-formal` — the size of the formal test, from the screen's own variance.
 *
 * Both numbers are recorded, because the state machine refuses to leave
 * FORMAL_PLAN with only one of them, and the plan is fixed before any formal deal
 * is played — which is the whole reason the screen runs first.
 */
function stepPlanFormal(step, ctx) {
  const plan = controlSync("formal-plan", {
    root: ctx.root,
    attemptId: ctx.attemptId,
    at: new Date().toISOString(),
    pool: poolOf(ctx, "formal"),
    recordDir: recordStageDir(ctx, "stage1"),
  }, ctx.scope);
  say(`formal plan: n=${String(plan.n)}${plan.powerCapped === true ? " (power capped)" : ""}`);
  return {
    paused: false,
    attempt: recordStep(step, {
      formalPlan: { required: plan.required, n: plan.n, powerCapped: plan.powerCapped },
      formalN: plan.n,
    }, ctx),
  };
}

/** `decide` — the preregistered table, applied in the control plane. */
function stepDecide(step, ctx) {
  const decided = controlSync("decide", {
    root: ctx.root, attemptId: ctx.attemptId, at: new Date().toISOString(),
  }, ctx.scope);
  say(`decided: ${String(decided.outcome)} at ${String(decided.stage)} (${String(decided.detail)})`);
  consumePools(ctx);
  return { paused: false };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function recordStep(step, fields, ctx) {
  const answer = controlSync("record", {
    root: ctx.root, attemptId: ctx.attemptId, at: new Date().toISOString(), step, fields,
  }, ctx.scope);
  ctx.attempt = attemptOf(answer, "record");
  return ctx.attempt;
}

/**
 * One step, with plain failures retried and stops never retried.
 *
 * A step is resumable by construction — every deal is a checkpoint and every
 * verdict is idempotent against its own seal — so a transient failure costs the
 * deals the step had not yet written and nothing else. An integrity or resource
 * stop is a judgment about the data or the machine, and retrying one would be the
 * runner deciding to disagree with it.
 */
async function executeStep(step, ctx) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await executeOnce(step, ctx);
    } catch (error) {
      const code = error instanceof RunnerStop ? error.code : EXIT.ERROR;
      if (code !== EXIT.ERROR || attempt >= RETRY_LIMIT) {
        throw error;
      }
      say(
        `retrying ${step.kind} (${attempt + 1}/${RETRY_LIMIT}) in ` +
        `${RETRY_PAUSE_MS / 1000}s after: ${short(error)}`,
      );
      journal(ctx.root, {
        attemptId: ctx.attemptId, step: step.kind, retry: attempt + 1, error: short(error),
      });
      await sleep(RETRY_PAUSE_MS);
    }
  }
}

async function executeOnce(step, ctx) {
  switch (step.kind) {
    case "corpus": return stepCorpus(step, ctx);
    case "train": return stepTrain(step, ctx);
    case "calibrate": return stepCalibrate(step, ctx);
    case "offline": return stepOffline(step, ctx);
    case "stage1": {
      const result = await stepStrength(step, ctx);
      if (result.paused) {
        return result;
      }
      // The four fields the record's own type declares, and nothing else: the
      // verdict carries an integrity flag and a provenance flag beside them, and
      // those belong to the verdict file rather than to the attempt's state.
      const { deals, mean, variance, proceed } = result.verdict;
      return {
        paused: false,
        attempt: recordStep(step, { stage1: { deals, mean, variance, proceed } }, ctx),
      };
    }
    case "formal": {
      const result = await stepStrength(step, ctx);
      return result.paused ? result : { paused: false, attempt: recordStep(step, {}, ctx) };
    }
    case "plan-formal": return stepPlanFormal(step, ctx);
    case "decide": return stepDecide(step, ctx);
    default:
      throw new RunnerStop(`The runner has no branch for step "${String(step.kind)}".`);
  }
}

/**
 * The record a deadline pause writes.
 *
 * A pause is visible on disk on purpose: `PAUSED_DEADLINE` is the one stop the
 * next run clears, and an operator looking at an attempt that did nothing
 * overnight should be able to see why without reading the host's log.
 */
function pauseForDeadline(ctx) {
  if (ctx.attempt.stopReason === "PAUSED_DEADLINE") {
    return;
  }
  recordStep({ kind: "stop", reason: "PAUSED_DEADLINE" }, { stopReason: "PAUSED_DEADLINE" }, ctx);
  say("paused; the checkpoints are on disk and the next run resumes here");
}

/**
 * One attempt, driven until it decides or something stops it.
 *
 * `{ done: true }` means the attempt reached its decision; the caller then hands
 * off to `register`, which applies the decision and allocates the next attempt.
 * Anything else is an exit code.
 */
async function runAttempt(ctx) {
  for (;;) {
    if (past(ctx.deadline)) {
      pauseForDeadline(ctx);
      return { code: EXIT.PAUSED_DEADLINE };
    }
    const answer = controlSync("next-step", {
      root: ctx.root, attemptId: ctx.attemptId,
    }, ctx.scope);
    const step = answer.step;
    if (step === null || typeof step !== "object" || typeof step.kind !== "string") {
      throw new RunnerStop('control "next-step" answered without a step.');
    }

    if (step.kind === "stop") {
      say(`stopped: ${String(step.reason)}`);
      return { code: exitForStop(step.reason) };
    }
    if (step.kind === "done") {
      say(`attempt ${ctx.attemptId} decided ${String(step.outcome)}`);
      return { done: true };
    }

    journal(ctx.root, {
      attemptId: ctx.attemptId,
      step: step.kind,
      purpose: step.purpose ?? null,
      n: step.n ?? null,
    });
    say(
      `step ${step.kind}` +
      `${step.purpose === undefined ? "" : ` ${step.purpose}`}` +
      `${step.n === undefined ? "" : ` n=${step.n}`}`,
    );
    const result = await executeStep(step, ctx);
    if (result.paused === true) {
      pauseForDeadline(ctx);
      return { code: EXIT.PAUSED_DEADLINE };
    }
  }
}

/**
 * The Factory's stops, as exit codes.
 *
 * A rejection that closes a direction, the attempt cap and an operator's stop are
 * all *results*: the Factory did what it was asked and there is nothing left to
 * run, which is exit 0. The other three are the codes the host watches for.
 */
function exitForStop(reason) {
  switch (reason) {
    case "PAUSED_DEADLINE": return EXIT.PAUSED_DEADLINE;
    case "INTEGRITY_STOP": return EXIT.INTEGRITY_STOP;
    case "RESOURCE_STOP": return EXIT.RESOURCE_STOP;
    default: return EXIT.OK;
  }
}

function gitState() {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  return {
    runnerCommit: (commit.stdout ?? "").trim() || "unknown",
    runnerDirty: (status.stdout ?? "").trim() !== "",
  };
}

/**
 * `run` — the whole Factory, as far as the clock and the protocol allow.
 *
 * Register, resume, drive the attempt to its decision, hand the decision back to
 * `register`, repeat. The lock is held across all of it and released on every path
 * out, including a signal, because a lock left behind by a runner that forgot to
 * release it is indistinguishable from a live one.
 */
async function runMode(options) {
  const deadline = deadlineMs(options);
  if (past(deadline)) {
    say("the absolute deadline has already passed; nothing was started");
    return EXIT.PAUSED_DEADLINE;
  }
  if (!existsSync(VITEST)) {
    throw new RunnerStop(`${VITEST} is missing; run this from the repository root.`);
  }
  const { runnerCommit, runnerDirty } = gitState();
  const scope = scopeOf(options);
  say(`runner commit ${runnerCommit.slice(0, 12)}${runnerDirty ? " (dirty tree)" : ""}`);
  if (deadline !== null) {
    say(
      `deadline ${new Date(deadline).toISOString()}, ` +
      `${((deadline - Date.now()) / 3600000).toFixed(1)}h left`,
    );
  }

  try {
    for (;;) {
      const registered = controlSync("register", {
        root: options.root, at: new Date().toISOString(), runnerCommit, runnerDirty,
      }, scope);
      if (registered.stop !== null && registered.stop !== undefined) {
        say(`factory stopped: ${String(registered.stop)}`);
        return exitForStop(registered.stop);
      }
      if (registered.attempt === null || registered.attempt === undefined) {
        say("the state machine offers no attempt and no stop; there is nothing to run");
        return EXIT.OK;
      }
      const attempt = attemptOf(registered, "register");
      // The lock is taken before anything can refuse: `register` has already
      // acquired it, and a run that walks away from a lock it holds leaves the
      // next one refusing to start. Every exit path from here releases it.
      heldLock = registered.lockPath ?? null;
      if (options.attempt !== null && options.attempt !== attempt.attemptId) {
        throw new RunnerStop(
          `--attempt ${options.attempt} was asked for and the Factory's attempt is ` +
          `${attempt.attemptId}. The runner runs the attempt the state machine selects.`,
        );
      }
      say(
        `attempt ${attempt.attemptId} (${attempt.kind}) parent ${attempt.parentChampionId} ` +
        `${registered.created === true ? "created" : "resumed"} phase ${attempt.phase}`,
      );

      let current = attempt;
      if (current.stopReason === "PAUSED_DEADLINE") {
        const resumed = controlSync("resume", {
          root: options.root, attemptId: current.attemptId, at: new Date().toISOString(),
        }, scope);
        current = attemptOf(resumed, "resume");
        say(`cleared the deadline pause; resuming phase ${current.phase}`);
      } else if (current.stopReason !== null && current.stopReason !== undefined) {
        say(`stopped: ${String(current.stopReason)}`);
        return exitForStop(current.stopReason);
      }

      // The protocol the attempt registered under, against the protocol on disk
      // now. The control plane asserts this at every transition; the runner asks
      // again because the runner is where a resumed run starts, and because the
      // protocol's own numbers (the screen's size) are read from here.
      const view = controlSync("inspect", {
        root: options.root, runnerCommit, runnerDirty,
      }, scope);
      if (typeof view.protocolHash !== "string" || typeof view.protocol !== "object") {
        throw new RunnerStop("The control plane reported no protocol to run under.");
      }
      if (current.protocolHash !== view.protocolHash) {
        throw new RunnerStop(
          `${current.attemptId} registered under protocol ` +
          `${String(current.protocolHash).slice(0, 16)} and the file now hashes to ` +
          `${view.protocolHash.slice(0, 16)}. A protocol is changed by stopping the Factory ` +
          "and opening a new one, never under a running attempt.",
          EXIT.INTEGRITY_STOP,
        );
      }

      const result = await runAttempt({
        root: options.root,
        scope,
        attemptId: current.attemptId,
        attempt: current,
        pools: current.pools,
        championId: current.parentChampionId,
        layer: layerOf(current),
        protocol: view.protocol,
        protocolHash: view.protocolHash,
        runnerCommit,
        deadline,
        jobs: options.jobs,
      });
      if (result.done !== true) {
        return result.code;
      }
      releaseLock();
    }
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// status and inspect
// ---------------------------------------------------------------------------

/**
 * `status` — what a running attempt may say about itself (§29).
 *
 * Exactly the fields of `PI_STATUS_KEYS`, per stage, built by `stageStatus` from
 * the manifest and the clock. Nothing here reads a deal, a verdict or a record:
 * the attempt, its phase and the stages that belong to it are the inventory, and a
 * stage's own numbers come from the control plane's status mode.
 */
function statusMode(options) {
  const scope = scopeOf(options);
  const view = controlSync("inspect", { root: options.root }, scope);
  const factory = view.factory ?? null;
  const attempts = Array.isArray(view.attempts) ? view.attempts : [];
  const stages = Array.isArray(view.stages) ? view.stages : [];
  say(
    `root ${options.root} champion ${String(factory?.championId ?? "none")} generation ` +
    `${String(factory?.generation ?? 0)} attempts recorded ` +
    `${Array.isArray(factory?.attempts) ? factory.attempts.length : 0}`,
  );
  const started = new Map();
  for (const attempt of attempts) {
    const at = Date.parse(String(attempt.startedAt));
    started.set(attempt.attemptId, Number.isFinite(at) ? at : Date.now());
    say(
      `attempt ${String(attempt.attemptId)} ${String(attempt.kind)} phase ` +
      `${String(attempt.phase)} parent ${String(attempt.parentChampionId)}`,
    );
  }
  if (stages.length === 0) {
    say("no stage directory exists yet");
    return EXIT.OK;
  }
  for (const stage of stages) {
    const status = controlSync("status", {
      dir: stage.dir,
      elapsedMs: Date.now() - (started.get(stage.attemptId) ?? Date.now()),
      workers: options.jobs,
    }, scope);
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  }
  return EXIT.OK;
}

/**
 * The guard the whole no-peek surface depends on.
 *
 * It is a check on *key names*, anywhere in the object that is about to be
 * printed, and it is deliberately blunt: the eight names below are the names a
 * strength travels under, and a view that carries one is a view that is about to
 * put a running stage's outcome on an operator's terminal.
 */
function assertNoForbiddenKeys(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new RunnerStop(
        `The view carries "${key}" at ${path}.${key}. A stage's outcome may not reach a console ` +
        "before its verdict is written, whatever it is nested inside.",
      );
    }
    assertNoForbiddenKeys(entry, `${path}.${key}`);
  }
}

/**
 * `--guard-selftest` — prove the guard is wired up, once per key.
 *
 * A guard nobody has seen fail is a guard nobody knows is wired up, so every
 * forbidden name is planted deep inside a synthetic view, and the clean view the
 * guard is supposed to accept is run through it as well.
 */
function guardSelftest() {
  for (const key of FORBIDDEN_KEYS) {
    const probe = { attempt: [{ stage: { nested: { [key]: 1 } } }] };
    let rejected = false;
    try {
      assertNoForbiddenKeys(probe);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new RunnerStop(`The no-peek guard accepted "${key}". It is not a guard.`);
    }
  }
  assertNoForbiddenKeys({
    runnerCommit: "abc",
    stages: [{ dir: "/tmp", sealed: false, checkpoints: 12, completion: "RUNNING" }],
    attempts: [{ phase: "FORMAL", thresholdFrozen: true, decision: "PROMOTE" }],
  });
  say(`guard selftest: ${FORBIDDEN_KEYS.length} forbidden keys rejected, a clean view accepted`);
}

/**
 * `inspect` — manifests, hashes, pool states, artifact digests, phase, commit.
 *
 * Everything on this surface is an identity: a digest, a hash, a count, a state
 * name, a phase, a decision under its own name. The guard runs over the whole
 * object before a byte of it is printed, so a control plane that started leaking a
 * running stage's payload would be stopped here rather than read.
 */
function inspectMode(options) {
  const { runnerCommit, runnerDirty } = gitState();
  if (options.guardSelftest) {
    guardSelftest();
    return EXIT.OK;
  }
  const view = controlSync("inspect", {
    root: options.root, runnerCommit, runnerDirty,
  }, scopeOf(options));
  assertNoForbiddenKeys(view);
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

let stopping = false;

/**
 * A signal is a pause, not a result.
 *
 * The children are stopped and the lock is released, and nothing is recorded: the
 * pause exists for the absolute deadline, and an operator's signal is not a reason
 * to write a reason onto an attempt. The attempt stays exactly where the
 * checkpoints put it and the next run resumes the same step.
 */
async function shutdown(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  say(`${signal}: stopping ${ACTIVE.size} worker(s) and releasing the lock`);
  for (const window of ACTIVE) {
    window.terminate();
  }
  await Promise.race([
    Promise.all([...ACTIVE].map((window) => window.done)),
    sleep(SHUTDOWN_WAIT_MS),
  ]);
  releaseLock();
  process.exit(EXIT.PAUSED_DEADLINE);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

/**
 * One dispatch, one exit code.
 *
 * The three modes are the whole interface: `run` advances the Factory, `status`
 * says how a stage is doing, `inspect` shows what is on disk. A fourth kind of
 * invocation — "run stage X" — is exactly what §31 forbids, so there is no flag
 * that could be read as one.
 */
async function main(options) {
  if (options.help || options.mode === null) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  switch (options.mode) {
    case "run": return runMode(options);
    case "status": return statusMode(options);
    case "inspect": return inspectMode(options);
    default:
      throw new RunnerStop(`Unknown mode "${String(options.mode)}". Try --help.`);
  }
}

/** The exit code a thrown value implies, which is what the shell sees. */
function codeFor(error) {
  if (error instanceof RunnerStop) {
    return error.code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return classifyText(message);
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`[fpi] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(codeFor(error));
}

main(options).then((code) => {
  process.exit(code);
}).catch((error) => {
  process.stderr.write(
    `[fpi] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(codeFor(error));
});
