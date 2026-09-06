import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const [apkPath, packageId] = process.argv.slice(2);
if (apkPath === undefined || packageId === undefined) {
  throw new Error("Usage: node scripts/android-emulator-smoke.mjs <apk> <package-id>");
}

const component = `${packageId}/io.github.ayauta.offlinedoudizhu.MainActivity`;
const BACK_DISPATCH_SETTLE_MILLISECONDS = 500;

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

function captureScreen() {
  const result = spawnSync("adb", ["-e", "exec-out", "screencap", "-p"], {
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`adb screencap failed: ${result.stderr.toString("utf8")}`);
  }
  const png = result.stdout;
  if (png.length < 24 || png.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error("adb screencap did not return a PNG image.");
  }
  return {
    bytes: png.length,
    digest: createHash("sha256").update(png).digest("hex"),
    height: png.readUInt32BE(20),
    width: png.readUInt32BE(16),
  };
}

async function waitForPaintedScreen(label, changedFrom) {
  const deadline = Date.now() + 30_000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = captureScreen();
    if (
      snapshot.bytes >= 30_000
      && snapshot.width > snapshot.height
      && (changedFrom === undefined || snapshot.digest !== changedFrom)
    ) {
      return snapshot;
    }
    await delay(500);
  }
  throw new Error(
    `Timed out waiting for ${label}; last screenshot was ${snapshot?.width}x${snapshot?.height}, ${snapshot?.bytes} bytes.`,
  );
}

function startActivity({ stop = false } = {}) {
  const args = ["shell", "am", "start", "-W"];
  if (stop) {
    args.push("-S");
  }
  args.push("-n", component);
  adb(args);
}

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
  const homeScreen = await waitForPaintedScreen("painted landscape home screen");
  adb([
    "shell",
    "input",
    "tap",
    String(Math.round(homeScreen.width * 0.5)),
    String(Math.round(homeScreen.height * 0.63)),
  ]);
  await delay(750);
  const gameScreen = await waitForPaintedScreen("game table after the centered start action", homeScreen.digest);

  adb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await waitUntil("backgrounded Activity", () => !isResumed());
  startActivity();
  await waitUntil("resumed Activity", isResumed);
  await waitForPaintedScreen("resumed game table");

  adb(["shell", "settings", "put", "system", "user_rotation", "3"]);
  await waitUntil("opposite landscape rotation", isResumed);
  await waitForPaintedScreen("opposite landscape game table");
  adb(["shell", "settings", "put", "system", "user_rotation", "1"]);
  await waitUntil("original landscape rotation", isResumed);
  await waitForPaintedScreen("original landscape game table");

  adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  await waitUntil("first Back to retain the Activity", isResumed, 5_000);
  await delay(BACK_DISPATCH_SETTLE_MILLISECONDS);
  adb(["shell", "input", "keyevent", "KEYCODE_BACK"]);
  await waitUntil("second Back to remove the Activity", () => !isResumed(), 5_000);

  startActivity();
  await waitUntil("clean relaunch", isResumed);
  await waitForPaintedScreen("painted clean relaunch", gameScreen.digest);

  const crashLog = adb(["logcat", "-d", "-b", "crash"], { quiet: true });
  if (crashLog.includes(packageId)) {
    throw new Error(`Crash buffer contains ${packageId}:\n${crashLog}`);
  }
  console.log("Android emulator smoke passed (offline launch, centered game entry, resume, rotation, Back, clean relaunch)." );
