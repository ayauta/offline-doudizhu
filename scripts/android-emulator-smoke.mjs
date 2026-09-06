import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [apkPath, packageId] = process.argv.slice(2);
if (apkPath === undefined || packageId === undefined) {
  throw new Error("Usage: node scripts/android-emulator-smoke.mjs <apk> <package-id>");
}

const component = `${packageId}/io.github.ayauta.offlinedoudizhu.MainActivity`;
const scratch = mkdtempSync(join(tmpdir(), "offline-ddz-emulator-"));
const uiDumpPath = join(scratch, "window.xml");

function adb(args, { quiet = false } = {}) {
  const result = spawnSync("adb", ["-e", ...args], {
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`adb ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.replaceAll("\r", "");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(label, predicate, timeoutMilliseconds = 30_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError === undefined ? "" : `: ${lastError}`}`);
}

function isResumed() {
  const state = adb(["shell", "dumpsys", "activity", "activities"], { quiet: true });
  return state.split("\n").some(
    (line) => /(?:topResumedActivity|mResumedActivity)/.test(line) && line.includes(packageId),
  );
}

function dumpUi() {
  adb(["shell", "uiautomator", "dump", "/sdcard/offline-ddz-window.xml"], { quiet: true });
  adb(["pull", "/sdcard/offline-ddz-window.xml", uiDumpPath], { quiet: true });
  return readFileSync(uiDumpPath, "utf8");
}

function boundsForLabel(xml, label) {
  const escaped = label.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const node = xml.match(new RegExp(`<node[^>]*(?:text|content-desc)="${escaped}"[^>]*>`))?.[0];
  const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (bounds === undefined) {
    return null;
  }
  return {
    x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2),
    y: Math.round((Number(bounds[2]) + Number(bounds[4])) / 2),
  };
}

async function waitForLabel(label) {
  let bounds = null;
  await waitUntil(`UI label ${label}`, () => {
    bounds = boundsForLabel(dumpUi(), label);
    return bounds !== null;
  });
  return bounds;
}

function startActivity({ stop = false } = {}) {
  const args = ["shell", "am", "start", "-W"];
  if (stop) {
    args.push("-S");
  }
  args.push("-n", component);
  adb(args);
}

try {
  adb(["install", "-r", apkPath]);
  adb(["shell", "pm", "clear", packageId]);
  adb(["shell", "settings", "put", "system", "accelerometer_rotation", "0"]);
  adb(["shell", "settings", "put", "system", "user_rotation", "1"]);
  adb(["shell", "svc", "wifi", "disable"]);
  const phoneService = adb(["shell", "service", "check", "phone"], { quiet: true });
  if (phoneService.includes("Service phone: found")) {
    adb(["shell", "svc", "data", "disable"]);
  } else {
    console.log("No emulator telephony service is present; cellular data is unavailable.");
  }
  adb(["logcat", "-c"]);

  startActivity({ stop: true });
  await waitUntil("offline cold-started Activity", isResumed);
  const start = await waitForLabel("开始游戏");
  adb(["shell", "input", "tap", String(start.x), String(start.y)]);
  await waitForLabel("叫地主");

  adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await waitUntil("backgrounded Activity", () => !isResumed());
  startActivity();
  await waitUntil("resumed Activity", isResumed);
  await waitForLabel("叫地主");

  adb(["shell", "settings", "put", "system", "user_rotation", "3"]);
  await waitUntil("opposite landscape rotation", isResumed);
  await waitForLabel("叫地主");
  adb(["shell", "settings", "put", "system", "user_rotation", "1"]);
  await waitUntil("original landscape rotation", isResumed);

  adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  await waitUntil("first Back to retain the Activity", isResumed, 5_000);
  adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  await waitUntil("second Back to remove the Activity", () => !isResumed(), 5_000);

  startActivity();
  await waitUntil("clean relaunch", isResumed);
  await waitForLabel("开始游戏");

  const crashLog = adb(["logcat", "-d", "-b", "crash"], { quiet: true });
  if (crashLog.includes(packageId)) {
    throw new Error(`Crash buffer contains ${packageId}:\n${crashLog}`);
  }
  console.log("Android emulator smoke passed (offline launch, game entry, resume, rotation, Back, clean relaunch)." );
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
