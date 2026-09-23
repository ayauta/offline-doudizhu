#!/usr/bin/env node
/**
 * Farmer Policy Iteration Factory v1 — the host launcher and watchdog.
 *
 * This exists because of a specific failure. Spec 065 ran a corpus generation
 * from 01:14 to a hard stop at 08:30 CST, and the stop never happened: the
 * machine suspended for roughly twenty hours, and every liveness monitor was a
 * `sleep` loop inside the suspended machine. They froze with it, reported
 * nothing, and woke up long after the deadline. The run was killed by hand at
 * 09:10:46, forty minutes late, with nothing to show for it.
 *
 * So this launcher is built around three rules that the failure taught:
 *
 *   1. **The deadline is an absolute UTC instant, checked against the wall
 *      clock.** Never an elapsed duration. A monotonic timer inside a suspended
 *      machine measures the wrong thing — that is precisely what went wrong.
 *   2. **The watchdog is a separate process from the work.** It holds a
 *      process-group handle and kills the group it started, and nothing else.
 *   3. **Nothing new starts after the deadline.** The check happens before the
 *      work is spawned and again before every respawn, so a launcher that wakes
 *      up late does nothing at all.
 *
 * ## What keeps the machine awake, and what that is worth
 *
 * `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` is requested
 * from a Windows PowerShell process for the length of the run, on a bounded
 * lease that this launcher renews. It is a *request*. It does not override:
 *
 *   - closing the lid, where the firmware or the power plan wins;
 *   - a manual Sleep or Hibernate from the Start menu;
 *   - a battery-saver policy deciding to suspend anyway.
 *
 * **A watchdog inside a suspended machine cannot act.** If the machine suspends
 * despite the request, this process stops running too, and the deadline is
 * enforced only when it resumes — which is still better than never, but it is
 * not the same guarantee. The user power profile is never modified; the request
 * is scoped to this process and released when it exits, so nothing about the
 * machine's power settings is different afterwards.
 *
 * Usage:
 *
 *   node scripts/farmer-pi-host.mjs run \
 *     --deadline 2026-09-24T08:30:00Z \
 *     --state .local/farmer-pi/attempts/attempt-001/host \
 *     -- node scripts/farmer-pi.mjs run --attempt attempt-001
 *
 *   node scripts/farmer-pi-host.mjs status --state <dir>
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

/** How often the watchdog looks at the clock and at the child. */
const POLL_MS = 10_000;
/** The stay-awake lease. Bounded so a hard-killed host cannot pin power forever. */
const AWAKE_LEASE_MS = 25 * 60_000;
/** Grace between SIGTERM and SIGKILL for the research process group. */
const TERM_GRACE_MS = 60_000;

/**
 * The stay-awake holder. Runs on the Windows side because the execution-state
 * request is a Windows thread's, and re-asserts it on a loop so that the lease
 * is visibly renewable.
 */
const AWAKE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$src = @"
using System;
using System.Runtime.InteropServices;
public class FpiPower {
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
if (-not ([System.Management.Automation.PSTypeName]'FpiPower').Type) { Add-Type -TypeDefinition $src }
$ES_CONTINUOUS = [uint32]0x80000000
$ES_SYSTEM_REQUIRED = [uint32]0x00000001
$seconds = [int]$env:FPI_AWAKE_SECONDS
$deadline = [DateTime]::Parse($env:FPI_DEADLINE).ToUniversalTime()
$end = (Get-Date).ToUniversalTime().AddSeconds($seconds)
if ($end -gt $deadline) { $end = $deadline }
try {
  while ((Get-Date).ToUniversalTime() -lt $end) {
    [void][FpiPower]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
    Start-Sleep -Seconds 20
  }
} finally {
  [void][FpiPower]::SetThreadExecutionState($ES_CONTINUOUS)
}
`;

function parseArgs(argv) {
  const options = { mode: argv[0] ?? "status", state: null, deadline: null, command: [] };
  const rest = argv.slice(1);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--deadline") {
      options.deadline = rest[index + 1] ?? null;
      index += 1;
    } else if (token === "--state") {
      options.state = rest[index + 1] ?? null;
      index += 1;
    } else if (token === "--") {
      options.command = rest.slice(index + 1);
      break;
    } else {
      throw new Error(`Unknown argument "${token}".`);
    }
  }
  return options;
}

function parseDeadline(text) {
  if (text === null) {
    throw new Error("--deadline is required and must be an absolute UTC instant.");
  }
  if (!/Z$|[+-]\d{2}:\d{2}$/.test(text)) {
    throw new Error(
      `--deadline "${text}" carries no timezone. An absolute UTC instant is required, ` +
      "because a local time means something different after a suspend across a DST boundary.",
    );
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--deadline "${text}" is not a parseable instant.`);
  }
  return parsed;
}

function stateFile(dir) {
  return join(dir, "host-state.json");
}

function writeState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const path = stateFile(dir);
  const temporary = `${path}.partial`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function readState(dir) {
  const path = stateFile(dir);
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Progress and health only. Nothing here can be inverted into a strength. */
function status(dir) {
  const state = readState(dir);
  if (state === null) {
    console.log(`no host state at ${dir}`);
    return 1;
  }
  const deadline = Date.parse(state.deadline);
  const remaining = deadline - Date.now();
  console.log(
    `mode ${state.mode}  phase ${state.phase}  deadline ${state.deadline} ` +
    `(${remaining > 0 ? `${Math.round(remaining / 60000)} min left` : "passed"})\n` +
    `started ${state.startedAt}  updated ${state.updatedAt}  child ${state.childPid ?? "none"}  ` +
    `reason ${state.reason ?? "none"}`,
  );
  return 0;
}

/**
 * One stay-awake holder, on a lease. Resolves when it exits, which is either
 * when the lease runs out or when this process kills it.
 */
function startAwakeHolder(deadlineMs) {
  if (!existsSync(POWERSHELL)) {
    return null;
  }
  const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", AWAKE_SCRIPT], {
    env: {
      ...process.env,
      FPI_AWAKE_SECONDS: String(Math.floor(AWAKE_LEASE_MS / 1000)),
      FPI_DEADLINE: new Date(deadlineMs).toISOString(),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.on("error", () => { /* the request is best-effort; the deadline is not */ });
  return child;
}

function killGroup(child, signal) {
  if (child.pid === undefined) {
    return;
  }
  try {
    // The child was spawned detached, so it leads its own process group and a
    // negative pid reaches exactly the group this launcher created.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

async function run(options) {
  const deadlineMs = parseDeadline(options.deadline);
  const dir = options.state;
  if (dir === null) {
    throw new Error("--state is required.");
  }
  if (options.command.length === 0) {
    throw new Error("No command given after `--`.");
  }
  const startedAt = new Date().toISOString();

  // Rule 3, first application: a launcher that woke up late starts nothing.
  if (Date.now() >= deadlineMs) {
    writeState(dir, {
      mode: "run", phase: "PAUSED_DEADLINE", deadline: new Date(deadlineMs).toISOString(),
      startedAt, updatedAt: new Date().toISOString(), childPid: null,
      reason: "deadline had already passed when the launcher started",
    });
    console.error(
      `The absolute deadline ${new Date(deadlineMs).toISOString()} has passed. ` +
      "Nothing was started. Resume the same attempt with a later deadline.",
    );
    return 2;
  }

  let awake = startAwakeHolder(deadlineMs);
  let awakeRenewedAt = Date.now();

  const [program, ...args] = options.command;
  const child = spawn(program, args, {
    stdio: "inherit",
    detached: true,
    env: { ...process.env, FPI_DEADLINE_UTC: new Date(deadlineMs).toISOString() },
  });

  const finish = (phase, reason, code) => {
    if (awake !== null) {
      awake.kill();
      awake = null;
    }
    writeState(dir, {
      mode: "run",
      phase,
      deadline: new Date(deadlineMs).toISOString(),
      startedAt,
      updatedAt: new Date().toISOString(),
      childPid: child.pid ?? null,
      exitCode: code,
      reason,
    });
  };

  writeState(dir, {
    mode: "run", phase: "RUNNING", deadline: new Date(deadlineMs).toISOString(),
    startedAt, updatedAt: new Date().toISOString(), childPid: child.pid ?? null, reason: null,
  });

  return await new Promise((resolve) => {
    let settled = false;
    const timer = setInterval(() => {
      const now = Date.now();
      // Renew the stay-awake lease. Failure is not fatal: the request is
      // best-effort and the deadline below is not.
      if (awake === null || now - awakeRenewedAt > AWAKE_LEASE_MS - 60_000) {
        if (awake !== null) {
          awake.kill();
        }
        awake = startAwakeHolder(deadlineMs);
        awakeRenewedAt = now;
      }
      if (now >= deadlineMs && !settled) {
        settled = true;
        clearInterval(timer);
        console.error(
          `Absolute deadline ${new Date(deadlineMs).toISOString()} reached. ` +
          "Stopping the research process group; its deal-level checkpoints are already on disk.",
        );
        killGroup(child, "SIGTERM");
        setTimeout(() => killGroup(child, "SIGKILL"), TERM_GRACE_MS).unref();
        finish("PAUSED_DEADLINE", "absolute deadline reached", null);
        resolve(3);
      }
    }, POLL_MS);

    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timer);
      finish("EXITED", `child exited (${signal ?? code})`, code);
      resolve(code ?? 1);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timer);
      finish("EXITED", `child failed to start: ${error.message}`, 1);
      resolve(1);
    });
  });
}

const options = parseArgs(process.argv.slice(2));
const handler = options.mode === "run"
  ? run
  : options.mode === "status"
    ? async () => status(options.state ?? ".")
    : null;
if (handler === null) {
  console.error(`unknown mode "${options.mode}"; expected run or status`);
  process.exit(2);
}
process.exit(await handler(options));
