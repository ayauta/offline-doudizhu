import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Android delivery check failed: ${message}`);
  }
}

async function read(relativePath) {
  return readFile(join(repositoryRoot, relativePath), "utf8");
}

const [manifest, appBuild, rootBuild, wrapper, activity, strings, extractionRules, appIcon, webIcon, sharedEntry, pwaEntry, embeddedEntry] =
  await Promise.all([
    read("android/app/src/main/AndroidManifest.xml"),
    read("android/app/build.gradle.kts"),
    read("android/build.gradle.kts"),
    read("android/gradle/wrapper/gradle-wrapper.properties"),
    read("android/app/src/main/java/io/github/ayauta/offlinedoudizhu/MainActivity.java"),
    read("android/app/src/main/res/values/strings.xml"),
    read("android/app/src/main/res/xml/data_extraction_rules.xml"),
    read("android/app/src/main/res/drawable/app_icon.xml"),
    read("public/icon.svg"),
    read("src/main.tsx"),
    read("src/delivery/pwa.ts"),
    read("src/delivery/embedded.ts"),
  ]);

assert(!/<uses-permission\b/.test(manifest), "manifest must declare zero permissions");
assert(manifest.includes('android:usesCleartextTraffic="false"'), "cleartext traffic is not disabled");
assert(manifest.includes('android:allowBackup="false"'), "Android backup is not disabled");
assert(manifest.includes('android:dataExtractionRules="@xml/data_extraction_rules"'), "Android 12+ backup and device transfer rules are missing");
assert(manifest.includes('android:icon="@drawable/app_icon"'), "Android application icon is missing");
assert(manifest.includes('android:screenOrientation="sensorLandscape"'), "landscape orientation is not fixed");
assert(manifest.includes('android:enableOnBackInvokedCallback="true"'), "modern Android Back callback is not enabled");
assert(manifest.includes('android:launchMode="singleTask"'), "launcher Activity can be duplicated in its task");
assert(extractionRules.includes("<cloud-backup>"), "cloud backup exclusions are missing");
assert(extractionRules.includes("<device-transfer>"), "device-transfer exclusions are missing");
assert(!extractionRules.includes("<include"), "Android backup rules must not include application data");
assert(appIcon.includes("<vector"), "Android application icon is not a vector drawable");
assert((appIcon.match(/android:name="card-[^"]+"/g) ?? []).length === 3, "Android icon must show three card backs");
assert(appIcon.includes('android:fillColor="#173B59"'), "Android icon does not use the home card-back color");
assert(webIcon.includes('aria-label="三张牌背"'), "Web icon does not describe the home-screen mark");
assert((webIcon.match(/<g id="card-[^"]+"/g) ?? []).length === 3, "Web icon must show three card backs");

assert(appBuild.includes('namespace = "io.github.ayauta.offlinedoudizhu"'), "unexpected namespace");
assert(appBuild.includes('applicationId = "io.github.ayauta.offlinedoudizhu"'), "unexpected application ID");
assert(appBuild.includes('applicationIdSuffix = ".debug"'), "debug package cannot coexist with release");
assert(appBuild.includes("minSdk = 29"), "Android 10 minimum is missing");
assert(appBuild.includes("compileSdk = 36") && appBuild.includes("targetSdk = 36"), "SDK levels changed");
assert(appBuild.includes('implementation("androidx.webkit:webkit:1.17.0")'), "unexpected AndroidX WebKit version");
assert(rootBuild.includes('version "9.4.0"'), "unexpected Android Gradle Plugin version");
assert(wrapper.includes("gradle-9.6.0-bin.zip"), "unexpected Gradle wrapper version");

for (const setting of [
  "setBlockNetworkLoads(true)",
  "setAllowFileAccess(false)",
  "setAllowContentAccess(false)",
  "setAllowFileAccessFromFileURLs(false)",
  "setAllowUniversalAccessFromFileURLs(false)",
  "MIXED_CONTENT_NEVER_ALLOW",
]) {
  assert(activity.includes(setting), `missing hardened WebView setting: ${setting}`);
}
assert(activity.includes("WebViewAssetLoader"), "official local asset loader is missing");
assert(activity.includes("https://appassets.androidplatform.net/assets/embedded.html"), "unexpected Android entry URL");
assert(!activity.includes("addJavascriptInterface"), "JavaScript-native bridge is forbidden");
assert(activity.includes("EXIT_CONFIRMATION_WINDOW_MILLIS = 2_000L"), "two-press Back window changed");
assert(activity.includes("R.string.press_back_again_to_exit"), "Back exit guidance is missing");
assert(strings.includes("再按一次退出游戏"), "Back exit guidance text changed");
assert(activity.includes("registerOnBackInvokedCallback"), "Android 13+ Back callback is missing");
assert(activity.includes("public void onBackPressed()"), "Android 10-12 Back fallback is missing");
assert(activity.includes("finishAndRemoveTask()"), "Back confirmation does not remove the Activity task");
assert(!activity.includes("webView.goBack("), "system Back must not navigate WebView history");
const remoteUrls = [...activity.matchAll(/https?:\/\/[^"\s]+/g)].map((match) => match[0]);
assert(
  remoteUrls.every((url) => url === "https://appassets.androidplatform.net/assets/embedded.html"),
  "Android runtime contains an unexpected URL",
);

assert(!sharedEntry.includes("registerOfflineWorker"), "shared composition registers the PWA worker");
assert(pwaEntry.includes("registerOfflineWorker"), "PWA entry does not register its worker");
assert(!embeddedEntry.includes("registerOfflineWorker"), "embedded entry registers the PWA worker");

console.log("Android delivery check passed (zero permissions; local embedded entry; hardened WebView)." );
