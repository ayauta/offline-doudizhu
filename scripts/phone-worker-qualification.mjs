#!/usr/bin/env node
/**
 * Qualify the CHEAP landlord on a physical phone through the **real AI Worker**.
 *
 *     node scripts/phone-worker-qualification.mjs --deals 3 \
 *       --adb .local/platform-tools/adb --out .local/phone-worker.json
 *
 * Why this exists next to `phone-probe.mjs`: that probe calls `decideEnhancedAi`
 * in the WebView's main thread with the model bundled into the probe, so it
 * measures the device's CPU on the policy bytes and nothing about the Worker.
 * The outstanding question for the release candidate is not CPU, it is whether
 * the *shipped* path — the app's own Worker, its own message passing, its own
 * deadline — retains the policy on a phone. Only the installed APK's Worker can
 * answer that, so this drives the real UI and times the real `postMessage`
 * round trip.
 *
 * The only thing injected is a `Worker` wrapper, exactly as the desktop
 * Playwright spec does it: the product's own code is untouched, there is no
 * test hook in `src/`, and nothing here reads or influences a decision. The
 * wrapper rebuilds the outgoing request rather than mutating it, because
 * `ai-worker-client.ts` posts a frozen object and assigning to a frozen object
 * inside a class body throws in strict mode — the failure mode is a silent
 * "this turn failed" that looks like a broken model.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PACKAGE = "io.github.ayauta.offlinedoudizhu.debug";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const deals = Number(argument("--deals", "3"));
const packageId = argument("--package", DEFAULT_PACKAGE);
const adbExecutable = argument("--adb", "adb");
const adbServerPort = argument("--adb-server-port", undefined);
const outPath = argument("--out", join(ROOT, ".local", "phone-worker.json"));
/** Injected as a flag so the same script can measure the candidate and its absence. */
const inject = !process.argv.includes("--no-inject");

const adbArgs = [
  ...(adbServerPort === undefined ? [] : ["-P", adbServerPort]),
];
const adb = (args) => execFileSync(adbExecutable, [...adbArgs, ...args], { encoding: "utf8" }).trim();

/**
 * The injected payload. Kept as a string rather than a bundled module because
 * it needs nothing from the repository: the Worker under measurement already
 * carries the model, which is the entire point.
 */
const PAYLOAD = `
(() => {
  if (globalThis.__clq !== undefined) {
    /* Refuse rather than reuse. A second run against a live page re-exports the
       first run's sink, and its contexts have already been consumed -- which
       reads downstream as "0 mismatches" over zero comparisons. */
    throw new Error("STALE_SESSION: the page already carries a probe; restart the app");
  }
  const sink = {
    installedAt: performance.now(),
    workerCreatedAt: null,
    sent: 0, injected: 0, received: 0, malformed: 0,
    errors: [],
    workerUrl: null,
    records: [],
  };
  globalThis.__clq = sink;
  const Original = window.Worker;
  window.Worker = class extends Original {
    constructor(url, options) {
      super(url, options);
      if (sink.workerCreatedAt === null) {
        sink.workerCreatedAt = performance.now();
        sink.workerUrl = String(url);
      }
      const inFlight = new Map();
      const post = this.postMessage.bind(this);
      /* Rebuilt, never mutated: the client posts a frozen request and this
         class body is strict mode, so assignment would throw. */
      this.postMessage = function (message, transfer) {
        let outgoing = message;
        const record = message;
        if (record !== null && typeof record === "object" && typeof record.requestId === "number") {
          const view = record.context && record.context.view;
          const landlord = view && typeof view.seat === "string" && typeof view.landlord === "string"
            ? view.seat === view.landlord
            : null;
          inFlight.set(record.requestId, {
            at: performance.now(),
            aiType: record.aiType,
            landlord: landlord,
            /* Kept by reference; serialised only at export. The context is
               frozen by the caller, so nothing can change underneath it. */
            context: landlord === true ? record.context : null,
          });
          sink.sent += 1;
          if (${inject} && record.aiType === "master") {
            outgoing = Object.assign({}, record, { cheapLandlord: true });
            sink.injected += 1;
          }
        }
        return transfer === undefined ? post(outgoing) : post(outgoing, transfer);
      };
      this.addEventListener("message", (event) => {
        const response = event.data;
        const id = response && response.requestId;
        if (typeof id !== "number") { sink.malformed += 1; return; }
        const started = inFlight.get(id);
        inFlight.delete(id);
        sink.received += 1;
        sink.records.push({
          requestId: id,
          sentAt: started ? started.at : null,
          receivedAt: performance.now(),
          aiType: started ? started.aiType : null,
          landlord: started ? started.landlord : null,
          ok: !!(response.outcome && response.outcome.ok === true),
          reason: (response.outcome && response.outcome.reason) || null,
          command: response.outcome && response.outcome.ok === true ? response.outcome.command : null,
          context: started ? started.context : null,
        });
      });
      this.addEventListener("error", (event) => {
        sink.errors.push(String((event && event.message) || "worker error"));
      });
    }
  };
  return "installed";
})()
`;

/**
 * One driver step, evaluated in the page. Returns what it did so the caller can
 * tell "the game advanced" from "the selector matched nothing".
 */
const STEP = `
(() => {
  /*
   * Every heading, not the first one. The rotate-device notice is also a
   * heading and it sorts first, so a presence test on the first one reads
   * never sees 胜利/失败, and leaves the driver looping on a finished match
   * instead of pressing 再来一局 -- 559 s of "no progress" with the result
   * sitting on screen the whole time.
   */
  const finished = Array.from(document.querySelectorAll("h1, h2, [role=heading]"))
    .some((h) => /胜利|失败/.test(h.textContent || ""));
  /*
   * Visibility, not presence.
   *
   * The exit-confirmation layer is rendered unconditionally and only toggles a
   * class, so "继续游戏" is in \`querySelectorAll("button")\` during every second
   * of every match. A presence test on it matches every step, clicks a hidden
   * button, and reports progress while the game never advances — which is
   * exactly what the first three runs did, at zero Worker requests.
   */
  /*
   * offsetParent is not a visibility test here: the exit layer keeps its
   * buttons laid out and hides them with pointer-events, so "继续游戏" reports
   * visible during every second of every match. It is the layer's own open
   * class that says whether the confirmation is actually up, and asking the
   * app's state is both shorter and correct.
   */
  const layer = document.querySelector(".exit-layer");
  const exitOpen = layer !== null && layer.classList.contains("is-open");
  const visible = Array.from(document.querySelectorAll("button"))
    .filter((b) => b.offsetParent !== null);
  const byText = (text) => visible.find((b) => (b.textContent || "").trim() === text) || null;
  if (exitOpen) {
    const resume = byText("继续游戏");
    if (resume !== null) { resume.click(); return { did: "dismiss-exit-dialog" }; }
  }
  if (finished) {
    return { done: true, again: byText("再来一局") !== null };
  }
  const decline = byText("不叫");
  if (decline !== null) { decline.click(); return { did: "decline" }; }
  /*
   * 提示 and 出牌 are one move, not two steps.
   *
   * 提示 selects a suggested play and stays on screen afterwards, so a driver
   * that returns after clicking it finds it again on the next step and clicks
   * it forever, never reaching 出牌. The desktop spec clicks them as a pair for
   * the same reason.
   */
  const hint = byText("提示");
  if (hint !== null) {
    hint.click();
    const play = byText("出牌");
    if (play !== null) { play.click(); return { did: "hint+play" }; }
    return { did: "hint" };
  }
  const play = byText("出牌");
  if (play !== null) { play.click(); return { did: "play" }; }
  const pass = byText("不出");
  if (pass !== null) { pass.click(); return { did: "pass" }; }
  const start = byText("开始游戏");
  if (start !== null) { start.click(); return { did: "start" }; }
  return { did: "none" };
})()
`;

const EXPORT = `
(() => {
  const sink = globalThis.__clq;
  if (sink === undefined) { return null; }
  return {
    installedAt: sink.installedAt,
    workerCreatedAt: sink.workerCreatedAt,
    workerUrl: sink.workerUrl,
    sent: sink.sent,
    injected: sink.injected,
    received: sink.received,
    malformed: sink.malformed,
    errors: sink.errors,
    records: sink.records,
  };
})()
`;

/**
 * Put the app on the master tier.
 *
 * `DEFAULT_AI_SETTINGS.aiType` is `"default"`, and the default tier never
 * creates a Worker at all — it runs the local strategy in the page. A
 * qualification that skipped this step would time nothing and report a
 * flawless zero-fallback run over zero decisions.
 */
const SET_TIER = `
(async () => {
  const key = "offline-doudizhu.settings";
  let current = null;
  try { current = JSON.parse(window.localStorage.getItem(key) || "null"); } catch (e) { current = null; }
  const tier = current && current.data && current.data.aiType;
  if (tier === "master") { return "already-master"; }
  window.localStorage.setItem(key, JSON.stringify({
    schemaVersion: 1,
    data: { aiType: "master", counterfactualFarmer: false },
  }));
  location.reload();
  return "reloading";
})()
`;

const RESET = `
(() => {
  const sink = globalThis.__clq;
  if (sink === undefined) { return "absent"; }
  for (const record of sink.records) { record.context = null; }
  return "reset";
})()
`;

/* ---------------------------------------------------------------- adb / CDP */

function attach() {
  const pid = adb(["shell", "pidof", packageId]);
  if (pid === "") {
    throw new Error(`${packageId} is not running. Start it and keep it in the foreground.`);
  }
  // The socket name is derived from the pid, exactly as `phone-probe.mjs` does
  // it. Scanning `/proc/net/unix` for it looks equivalent and is not: the
  // entries carry a leading `@`, so a prefix test on the bare name finds
  // nothing and reports "not a debug build" about a build that is one.
  const socket = `webview_devtools_remote_${pid}`;
  const port = Number(adb(["forward", "tcp:0", `localabstract:${socket}`]));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("ADB did not return a valid forwarded CDP port.");
  }
  return { port, pid };
}

async function cdp(port, timeoutMs = 60_000) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((target) => target.type === "page") ?? list[0];
  if (page === undefined) {
    throw new Error("No CDP page target.");
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  });
  const send = (method, params = {}, timeout = 30_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression, timeout = 900_000) => {
    const result = await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeout,
    );
    const details = result.result?.exceptionDetails;
    if (details !== undefined) {
      throw new Error(details.exception?.description ?? details.text ?? "page exception");
    }
    return result.result?.result?.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

/* -------------------------------------------------------------------- main */

/**
 * A clean page, owned by this script.
 *
 * The Worker wrapper only installs on a page that has not created one, so a
 * leftover session silently produces a capture with no contexts and no cold
 * start. Restarting here is not politeness; it is what makes the sample mean
 * anything.
 */
function restartApp() {
  try {
    adb(["shell", "am", "force-stop", packageId]);
  } catch {
    /* not running */
  }
  adb(["shell", "am", "start", "-n", `${packageId}/io.github.ayauta.offlinedoudizhu.MainActivity`]);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if (adb(["shell", "pidof", packageId]) !== "") {
        return;
      }
    } catch {
      /* keep waiting */
    }
  }
  throw new Error(`${packageId} did not come up after a restart.`);
}

restartApp();
const forwarding = attach();
console.log(`attached to ${packageId} (pid ${forwarding.pid})`);
let client;
try {
  client = await cdp(forwarding.port);
  const tier = await client.evaluate(SET_TIER, 60_000).catch(() => "reloading");
  console.log(`tier: ${tier}`);
  if (tier === "reloading") {
    // The evaluate that triggered the navigation is destroyed with its context.
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await client
      .evaluate(`document.readyState === "complete" && document.querySelectorAll("button").length > 0`, 15_000)
      .catch(() => false);
    if (ready === true) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const confirmed = await client.evaluate(
    `(() => { try { return (JSON.parse(localStorage.getItem("offline-doudizhu.settings")||"{}").data||{}).aiType || null; } catch (e) { return null; } })()`,
    15_000,
  );
  console.log(`settings aiType: ${confirmed}`);
  if (confirmed !== "master") {
    throw new Error(`The app is on tier ${confirmed}; the Worker is never created below master.`);
  }

  // The wrapper must exist before the Worker does, so it goes in after the
  // reload and before the first match.
  const installed = await client.evaluate(PAYLOAD);
  console.log(`worker wrapper: ${installed}`);

  let finishedDeals = 0;
  let steps = 0;
  const startedAt = Date.now();
  while (finishedDeals < deals && steps < 20000) {
    const step = await client.evaluate(STEP, 30_000);
    steps += 1;
    if (step !== null && step.done === true) {
      finishedDeals += 1;
      console.log(`deal ${finishedDeals}/${deals} finished after ${steps} steps`);
      if (step.again === true && finishedDeals < deals) {
        await client.evaluate(`(() => {
          const again = Array.from(document.querySelectorAll("button"))
            .find((b) => (b.textContent || "").trim() === "再来一局");
          if (again) { again.click(); }
          return "again";
        })()`, 30_000);
      }
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const wallSeconds = (Date.now() - startedAt) / 1000;

  const exported = await client.evaluate(EXPORT, 300_000);
  if (exported === null) {
    throw new Error("The wrapper was not installed in the page.");
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ deals: finishedDeals, steps, wallSeconds, ...exported }, null, 2)}\n`, "utf8");
  console.log(`wrote ${outPath}`);
  console.log(
    `sent ${exported.sent} received ${exported.received} injected ${exported.injected} ` +
      `malformed ${exported.malformed} errors ${exported.errors.length} in ${wallSeconds.toFixed(0)}s`,
  );
  // The contexts are the point of the capture; freeing them here would leave a
  // later analysis reporting "0 mismatches" over zero comparisons.
} finally {
  client?.close();
  // A forward can already be gone if the app restarted mid-run; that is not a
  // result, and letting it throw here would mask whatever the run did produce.
  try {
    adb(["forward", "--remove", `tcp:${forwarding.port}`]);
  } catch {
    /* nothing to clean up */
  }
}
