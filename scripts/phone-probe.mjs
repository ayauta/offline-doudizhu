#!/usr/bin/env node
/**
 * Measures the shipped AI decision path on a connected Android device, or
 * runs a focused WebView compatibility smoke with `--compat`.
 *
 * The probe source is `benchmarks/phoneprobe.ts`. It is bundled here
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
 *   node scripts/phone-probe.mjs --compat [--adb <path>] [--adb-server-port <port>]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, ".local", "phoneprobe.js");
const DEFAULT_PACKAGE = "io.github.ayauta.offlinedoudizhu.debug";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const deals = Number(argument("--deals", "3"));
const packageId = argument("--package", DEFAULT_PACKAGE);
const serial = argument("--serial", undefined);
const adbExecutable = argument("--adb", "adb");
const adbServerPort = argument("--adb-server-port", undefined);
const compatibilityMode = process.argv.includes("--compat");

const adbArgs = [
  ...(adbServerPort === undefined ? [] : ["-P", adbServerPort]),
  ...(serial === undefined ? [] : ["-s", serial]),
];
const adb = (args) => execFileSync(adbExecutable, [...adbArgs, ...args], {
  encoding: "utf8",
}).trim();

function buildBundle() {
  mkdirSync(dirname(BUNDLE), { recursive: true });
  execFileSync(
    join(ROOT, "node_modules", ".bin", "esbuild"),
    [
      join(ROOT, "benchmarks", "phoneprobe.ts"),
      "--bundle",
      "--format=iife",
      // Keep in step with `build.target` in vite.config.ts. The premise of this
      // bundle is that it transpiles the way the shipped one does, so the two
      // drifting apart would silently make the dev-to-device ratio a different
      // measurement.
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
  const port = Number(adb(["forward", "tcp:0", `localabstract:${socket}`]));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("ADB did not return a valid forwarded CDP port.");
  }
  return { port };
}

async function cdp(port) {
  const deadline = Date.now() + 10_000;
  let page;
  while (page === undefined && Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((target) => target.type === "page");
    } catch {
      // The forwarded socket can exist just before the WebView debugger starts.
    }
    if (page === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (page === undefined) {
    throw new Error("No debuggable WebView page is available.");
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const eventListeners = new Set();
  const send = (method, params = {}, timeoutMs = 10_000) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, { reject, resolve, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (request !== undefined) {
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error !== undefined) {
          request.reject(new Error(message.error.message ?? "CDP command failed."));
        } else {
          request.resolve(message);
        }
      }
      return;
    }
    for (const listener of eventListeners) {
      listener(message);
    }
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
  return {
    close: () => socket.close(),
    evaluate,
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    send,
  };
}

function report(label, value) {
  const ms = (n) => `${n.toFixed(1)} ms`;
  console.log(
    `  ${label.padEnd(10)} first=${ms(value.first)} p50=${ms(value.p50)} ` +
    `p95=${ms(value.p95)} max=${ms(value.max)} ` +
    `total=${(value.totalMs / 1000).toFixed(1)}s (n=${value.count})`,
  );
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitFor(evaluate, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression, 5_000)) {
        return;
      }
    } catch {
      // Startup or navigation can briefly destroy the execution context.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagnostic = await evaluate(`({
    controls: Array.from(document.querySelectorAll('[data-control]'), (element) => element.getAttribute('data-control')),
    home: Boolean(document.querySelector('.home-screen')),
    match: Boolean(document.querySelector('.match-screen')),
    readyState: document.readyState
  })`, 5_000).catch(() => ({ unavailable: true }));
  throw new Error(`Timed out waiting for: ${expression}; page=${JSON.stringify(diagnostic)}`);
}

async function runCompatibilityProbe(client) {
  const exceptions = [];
  client.onEvent((message) => {
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      exceptions.push(details?.exception?.description ?? details?.text ?? "page exception");
    }
  });
  await client.send("Runtime.enable");
  await waitFor(client.evaluate, "Boolean(document.querySelector('.start-button'))");

  const capabilities = await client.evaluate(`(() => ({
    arrayAt: typeof Array.prototype.at === "function",
    dynamicViewport: CSS.supports("height", "100dvh"),
    objectHasOwn: typeof Object.hasOwn === "function",
    pointerEvents: typeof PointerEvent === "function",
    structuredClone: typeof globalThis.structuredClone === "function",
    webAnimations: typeof Element.prototype.animate === "function",
    deviceScale: devicePixelRatio
  }))()`);
  requireCondition(capabilities.pointerEvents, "Pointer Events are unavailable.");
  requireCondition(capabilities.webAnimations, "Web Animations are unavailable.");
  requireCondition(capabilities.deviceScale > 0, "Device scale is unavailable.");
  console.log(`capabilities: ${JSON.stringify(capabilities)}`);

  const devicePoint = (point) => ({
    x: Math.round(point.x * capabilities.deviceScale),
    y: Math.round(point.y * capabilities.deviceScale),
  });
  const tap = (point) => {
    const target = devicePoint(point);
    adb(["shell", "input", "tap", String(target.x), String(target.y)]);
  };
  const drag = (from, to) => {
    const start = devicePoint(from);
    const end = devicePoint(to);
    adb([
      "shell", "input", "swipe",
      String(start.x), String(start.y), String(end.x), String(end.y), "180",
    ]);
  };
  const elementPoint = (selector) => client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  const tapElement = async (selector, missingMessage) => {
    const target = await elementPoint(selector);
    requireCondition(target !== null, missingMessage);
    tap(target);
  };

  await tapElement(".start-button", "Start control was not available.");
  await waitFor(client.evaluate, "Boolean(document.querySelector('[data-control=\"bid-call\"]'))");
  await tapElement('[data-control="bid-call"]', "Landlord control was not available.");
  await waitFor(
    client.evaluate,
    "document.querySelectorAll('.human-hand [data-card-id]').length === 20",
  );

  const point = (index) => client.evaluate(`(() => {
    const card = document.querySelectorAll('.human-hand [data-card-id]')[${index}];
    if (!(card instanceof HTMLElement)) return null;
    const box = card.getBoundingClientRect();
    return { x: box.x + 5, y: box.y + box.height * 0.58 };
  })()`);
  const selected = () => client.evaluate(`Array.from(
    document.querySelectorAll('.human-hand [data-card-id]'),
    (card) => card.getAttribute('aria-pressed') === 'true'
  )`);
  const swipe = async (fromIndex, toIndex) => {
    const [from, to] = await Promise.all([point(fromIndex), point(toIndex)]);
    requireCondition(from !== null && to !== null, "Unable to measure hand cards.");
    drag(from, to);
  };

  await swipe(3, 6);
  let states = await selected();
  requireCondition(
    [3, 4, 5, 6].every((index) => states[index] === true) &&
      states[2] === false && states[7] === false,
    `Forward continuous selection did not select exactly the crossed cards; ` +
      `page exceptions: ${exceptions.join(" | ") || "none"}`,
  );

  await swipe(6, 3);
  states = await selected();
  requireCondition(
    [3, 4, 5, 6].every((index) => states[index] === false),
    "Reverse continuous selection did not deselect the crossed cards.",
  );

  const tapPoint = await point(8);
  requireCondition(tapPoint !== null, "Unable to measure the tap target.");
  tap(tapPoint);
  states = await selected();
  requireCondition(
    states.filter(Boolean).length === 1 && states[8] === true,
    "A discrete tap did not toggle exactly one card.",
  );

  requireCondition(exceptions.length === 0, `WebView page exceptions: ${exceptions.join(" | ")}`);

  console.log("compatibility ADB/CDP interactions: forward, reverse, tap passed");
}

if (!compatibilityMode) {
  buildBundle();
} else {
  adb(["shell", "input", "keyevent", "224"]);
  adb(["shell", "wm", "dismiss-keyguard"]);
  adb(["shell", "am", "force-stop", packageId]);
  adb([
    "shell", "am", "start", "-n",
    `${packageId}/io.github.ayauta.offlinedoudizhu.MainActivity`,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const windowState = adb(["shell", "dumpsys", "window"]);
  if (/isKeyguardShowing=true|mCurrentFocus=.*\bAOD\b/.test(windowState)) {
    throw new Error("Device is locked. Unlock it and keep the app in the foreground, then retry.");
  }
}
const forwarding = attach();
console.log(`attached to package ${packageId}`);
let client;
try {
  client = await cdp(forwarding.port);
  if (compatibilityMode) {
    await runCompatibilityProbe(client);
  } else {
    await client.evaluate(readFileSync(BUNDLE, "utf8"));
    // Report whatever the probe returned rather than a retyped tier list: a tier it
    // drops or adds would otherwise become a TypeError or a silent gap. Object key
    // order preserves the probe's deliberate cold-first ordering.
    const run = await client.evaluate(`globalThis.__probe.run(${deals})`);
    for (const [tier, modes] of Object.entries(run)) {
      console.log(`${tier}:`);
      for (const [mode, summary] of Object.entries(modes)) {
        report(mode, summary);
      }
    }
  }
} finally {
  client?.close();
  adb(["forward", "--remove", `tcp:${forwarding.port}`]);
}
