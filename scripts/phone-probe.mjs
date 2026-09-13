#!/usr/bin/env node
/**
 * Measures the shipped AI decision path on a connected Android device.
 *
 * The probe source is `benchmarks/diagnosis/phoneprobe.ts`. It is bundled here
 * with the same target the app uses, pushed into the installed app's WebView
 * over the Chrome DevTools Protocol, and run on the device. Because the *same
 * bundle bytes* also run on this machine, the dev-to-device ratio is meaningful
 * even though a millisecond is not portable between machines.
 *
 * Two numbers matter and they answer different questions:
 *   - `unbounded` gives the handler a runtime that never expires, so it
 *     measures the whole designed workload.
 *   - `shipped` gives it the real per-tier budget, so it measures the path the
 *     product actually runs. This is the one to quote.
 *
 * Read the result together with the device state: a locked screen (the app
 * behind the keyguard) makes the same code roughly 2.5x slower. Compare only
 * runs taken in the same state.
 *
 *   source scripts/activate-toolchain.sh
 *   node scripts/phone-probe.mjs [--deals 3] [--package <id>] [--serial <adb-serial>]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, ".local", "phoneprobe.js");
const PORT = 9222;
const DEFAULT_PACKAGE = "io.github.ayauta.offlinedoudizhu.debug";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const deals = Number(argument("--deals", "3"));
const packageId = argument("--package", DEFAULT_PACKAGE);
const serial = argument("--serial", undefined);

const adbArgs = serial === undefined ? [] : ["-s", serial];
const adb = (args) => execFileSync("adb", [...adbArgs, ...args], { encoding: "utf8" }).trim();

function buildBundle() {
  mkdirSync(dirname(BUNDLE), { recursive: true });
  execFileSync(
    join(ROOT, "node_modules", ".bin", "esbuild"),
    [
      join(ROOT, "benchmarks", "diagnosis", "phoneprobe.ts"),
      "--bundle",
      "--format=iife",
      "--target=chrome74",
      `--outfile=${BUNDLE}`,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}

function attach() {
  const pid = adb(["shell", "pidof", packageId]);
  if (pid === "") {
    throw new Error(`${packageId} is not running. Launch it, then retry.`);
  }
  const socket = `webview_devtools_remote_${pid}`;
  adb(["forward", `tcp:${PORT}`, `localabstract:${socket}`]);
  return socket;
}

async function cdp() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((target) => target.type === "page");
  if (page === undefined) {
    throw new Error(`No debuggable page on port ${PORT}.`);
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 1;
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      const onMessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id === id) {
          socket.removeEventListener("message", onMessage);
          resolve(message);
        }
      };
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
  // The timeout must be cleared on every path. `Promise.race` with a bare
  // `setTimeout` leaves one pending timer per call, and a single 15-minute
  // timer is enough to keep the event loop alive long after the last print —
  // the script looks hung while it is really finished.
  const evaluate = (expression, timeoutMs = 900_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Device evaluation timed out.")),
        timeoutMs,
      );
      send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
        .then((result) => {
          clearTimeout(timer);
          const details = result.result?.exceptionDetails;
          if (details !== undefined) {
            reject(new Error(details.exception?.description ?? details.text ?? "exception"));
            return;
          }
          resolve(result.result?.result?.value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed.")), { once: true });
  });
  return { evaluate, close: () => socket.close() };
}

function report(label, value) {
  const pct = (n) => `${n.toFixed(1)} ms`;
  console.log(`  ${label.padEnd(18)} first=${pct(value.first)} p50=${pct(value.p50)} ` +
    `p95=${pct(value.p95)} max=${pct(value.max)} (n=${value.decisions})`);
}

buildBundle();
const socket = attach();
console.log(`attached: ${socket}, package ${packageId}, ${deals} deals`);
const { evaluate, close } = await cdp();
const loaded = await evaluate(readFileSync(BUNDLE, "utf8"));
void loaded;
const raw = await evaluate(
  `JSON.stringify(globalThis.__probe.run(${deals}))`,
);
for (const tier of ["master", "casual"]) {
  console.log(`${tier}:`);
  for (const mode of ["shipped", "unbounded"]) {
    report(mode, JSON.parse(raw)[tier][mode]);
  }
}
close();
process.exit(0);
