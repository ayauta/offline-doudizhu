import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

async function json(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await source(relativePath)) as Record<string, unknown>;
}

describe("public preview release delivery", () => {
  it("keeps the public version consistent", async () => {
    const [packageConfig, androidBuild] = await Promise.all([
      json("../../package.json"),
      source("../../android/app/build.gradle.kts"),
    ]);

    expect(packageConfig.version).toBe("0.1.0");
    expect(androidBuild).toContain('versionName = "0.1.0"');
    expect(androidBuild).toContain("versionCode = 1");
  });

  it("targets the WebView generation shipped with Android 10 emulator images", async () => {
    const viteConfig = await source("../../vite.config.ts");

    expect(viteConfig).toContain('target: "chrome74"');
  });

  it("layers Android interaction and exact-APK CI without publication authority", async () => {
    const [ci, emulatorSmoke, androidBuild, interactionTest, androidRunner] = await Promise.all([
      source("../../.github/workflows/ci.yml"),
      source("../../scripts/android-emulator-smoke.mjs"),
      source("../../android/app/build.gradle.kts"),
      source(
        "../../android/app/src/androidTest/java/io/github/ayauta/offlinedoudizhu/AndroidShellInteractionTest.java",
      ),
      source("../../scripts/android-ci-test.sh"),
    ]);

    expect(ci).toContain("pnpm check");
    expect(ci).toContain("lintDebug assembleDebug");
    expect(ci).toContain("api-level: [29, 36]");
    expect(ci).toContain("scripts/android-ci-test.sh");
    expect(ci).toContain("cmdline-tools/latest/bin/sdkmanager");
    expect(ci).toContain("/dev/kvm");
    expect(ci).toContain("build/reports/androidTests/connected");
    expect(ci).toContain("if: always()");
    expect(androidRunner).toContain("connectedDebugAndroidTest");
    expect(androidRunner).toContain("enable-exclusive --category");
    expect(androidRunner).toContain("adb -e logcat -d");
    expect(androidRunner).toContain("adb -e exec-out screencap -p");
    expect(emulatorSmoke).toContain('["shell", "service", "check", "phone"]');
    expect(emulatorSmoke).toContain('"screencap", "-p"');
    expect(emulatorSmoke).toContain("KEYCODE_HOME");
    expect(emulatorSmoke).not.toContain("KEYCODE_BACK");
    expect(emulatorSmoke).not.toContain('"input", "tap"');
    expect(androidBuild).toContain(
      'testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"',
    );
    expect(androidBuild).toContain('androidx.test:core:1.7.0');
    expect(androidBuild).toContain('androidx.test.ext:junit:1.3.0');
    expect(androidBuild).toContain('androidx.test.espresso:espresso-core:3.7.0');
    expect(androidBuild).toContain('androidx.test.espresso:espresso-web:3.7.0');
    expect(androidBuild).toContain('androidx.test.uiautomator:uiautomator:2.4.0');
    expect(interactionTest).toContain("onWebView()");
    expect(interactionTest).toContain('Locator.CSS_SELECTOR, ".start-button"');
    expect(interactionTest).toContain('waitForWebElement(".match-screen")');
    expect(interactionTest).toContain("waitForWindowFocus(scenario)");
    expect(interactionTest).toContain("WINDOW_FOCUS_STABLE_MILLIS");
    expect(interactionTest).not.toContain("forceJavascriptEnabled()");
    expect(interactionTest).toContain("moveToState");
    expect(interactionTest).toContain("SCREEN_ORIENTATION_REVERSE_LANDSCAPE");
    expect(interactionTest).toContain("performSystemBack");
    expect(interactionTest).toContain("waitForExitConfirmationState");
    expect(interactionTest).not.toContain("Until.hasObject(By.text(confirmationText))");
    expect(interactionTest).not.toContain("enable-exclusive --category");
    expect(interactionTest).not.toContain("UI Automator could not inject Back.");
    expect(interactionTest).toContain("UiDevice");
    expect(ci).toContain("contents: read");
    expect(ci).not.toContain("OFFLINE_DDZ_KEYSTORE_BASE64");
    expect(ci).not.toContain("pages: write");
    expect(ci).not.toContain("contents: write");
  });

  it("publishes only from a verified version tag", async () => {
    const release = await source("../../.github/workflows/release.yml");

    expect(release).toContain("tags:");
    expect(release).toContain('"v*"');
    expect(release).toContain("scripts/check-release-tag.mjs");
    expect(release).toContain("scripts/check-tag-on-main.sh");
    expect(release).toContain("OFFLINE_DDZ_KEYSTORE_BASE64");
    expect(release).toContain("lintRelease assembleRelease");
    expect(release).toContain("scripts/android-ci-test.sh");
    expect(release).toContain("android-release-test-evidence");
    expect(release).toContain("cmdline-tools/latest/bin/sdkmanager");
    expect(release).toContain("gh release create");
    expect(release).toContain("--prerelease");
    expect(release).toContain("actions/upload-pages-artifact");
    expect(release).toContain("path: dist");
    expect(release).toContain("actions/deploy-pages");
  });

  it("documents the recoverable signing and release procedure", async () => {
    const [development, releaseGuide, readme, gitignore] = await Promise.all([
      source("../../docs/development.md"),
      source("../../docs/releasing.md"),
      source("../../README.md"),
      source("../../.gitignore"),
    ]);

    expect(development).toContain("pnpm check");
    expect(releaseGuide).toContain("OFFLINE_DDZ_KEYSTORE_BASE64");
    expect(releaseGuide).toContain("versionCode");
    expect(releaseGuide).toContain("v0.1.0");
    expect(releaseGuide).toContain("恢复");
    expect(readme).toContain("GitHub Pages");
    expect(readme).toContain("Android 10");
    expect(readme).toContain("v0.1.0");
    expect(gitignore).toContain("*-release-recovery.json");
  });
});
