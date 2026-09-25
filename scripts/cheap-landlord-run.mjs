#!/usr/bin/env node
/**
 * Run a command with the CHEAP landlord prototype embedded, then always
 * restore the stub.
 *
 *     node scripts/cheap-landlord-run.mjs node node_modules/vite/bin/vite.js build
 *     node scripts/cheap-landlord-run.mjs npx vitest run --config vitest.benchmark.config.ts \
 *       benchmarks/cheap-integration.test.ts
 *
 * The restore happens in a `finally`, so a failing command, a crash or a
 * signal does not leave a 2 MB model sitting in a tracked source file. That is
 * the whole reason this wrapper exists rather than a documented two-step
 * sequence: the failure mode of the two-step sequence is silent, and it would
 * be found later as "the default build is huge".
 *
 * Set `CHEAP_LANDLORD_ENV=1` to put `CHEAP_LANDLORD_BUILD=1` in the child's
 * environment, for harnesses that assert on it.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EMBED = join(ROOT, "scripts/cheap-landlord-embed.mjs");

const [command, ...args] = process.argv.slice(2);
if (command === undefined) {
  console.error("usage: node scripts/cheap-landlord-run.mjs <command> [args…]");
  process.exit(2);
}

function embed(flag) {
  const result = spawn(process.execPath, [EMBED, ...(flag ? ["--embed"] : [])], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`cheap-landlord-embed.mjs ${flag ? "--embed" : ""} failed`);
  }
}

let status = 1;
embed(true);
try {
  status = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env.CHEAP_LANDLORD_ENV === "1"
        ? { ...process.env, CHEAP_LANDLORD_BUILD: "1" }
        : process.env,
    });
    child.on("close", (code, signal) => {
      resolve(signal === null ? (code ?? 1) : 1);
    });
  });
} finally {
  embed(false);
}
process.exit(status);
