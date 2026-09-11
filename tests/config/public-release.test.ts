import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

async function json(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await source(relativePath)) as Record<string, unknown>;
}

async function exists(relativePath: string): Promise<boolean> {
  try {
    await access(new URL(relativePath, import.meta.url));
    return true;
  } catch {
    return false;
  }
}

describe("public preview release delivery", () => {
  it("keeps the public version consistent", async () => {
    const [packageConfig, androidBuild, readme] = await Promise.all([
      json("../../package.json"),
      source("../../android/app/build.gradle.kts"),
      source("../../README.md"),
    ]);

    // These literals are a tripwire: bumping a release means updating
    // package.json, the Android versionName and versionCode, the README, and
    // this test together. `versionCode` must increase, or Android rejects the
    // new APK as a downgrade over an installed older release.
    expect(packageConfig.version).toBe("0.2.0");
    expect(androidBuild).toContain('versionName = "0.2.0"');
    expect(androidBuild).toContain("versionCode = 2");
    expect(readme).toContain("v0.2.0");
  });

  it("targets the WebView generation shipped with Android 10 emulator images", async () => {
    const viteConfig = await source("../../vite.config.ts");

    expect(viteConfig).toContain('target: "chrome74"');
  });

  it("keeps Android CI proportional to the permission-free delivery shell", async () => {
    const [ci, release, emulatorRunner, emulatorSmoke, androidBuild, replacedAdr, replacementAdr] =
      await Promise.all([
        source("../../.github/workflows/ci.yml"),
        source("../../.github/workflows/release.yml"),
        source("../../scripts/android-emulator-smoke.sh"),
        source("../../scripts/android-emulator-smoke.mjs"),
        source("../../android/app/build.gradle.kts"),
        source("../../docs/decisions/0013-layered-android-ci-verification.md"),
        source("../../docs/decisions/0014-proportionate-android-artifact-verification.md"),
      ]);

    expect(ci).toContain("pnpm check");
    expect(ci).toContain("lintDebug assembleDebug");
    expect(ci).toContain("api-level: [29, 36]");
    expect(ci).toContain("scripts/android-emulator-smoke.sh");
    expect(ci).toContain("cmdline-tools/latest/bin/sdkmanager");
    expect(ci).toContain("/dev/kvm");
    expect(ci).toContain("if: always()");
    expect(ci).not.toContain("connectedDebugAndroidTest");
    expect(ci).not.toContain("scripts/android-ci-test.sh");
    expect(release).toContain("scripts/android-emulator-smoke.sh");
    expect(release).not.toContain("scripts/android-ci-test.sh");
    expect(release).not.toContain("connectedDebugAndroidTest");
    expect(emulatorRunner).toContain("ANDROID_TEST_ARTIFACT_DIR");
    expect(emulatorRunner).toContain("adb -e logcat -d");
    expect(emulatorRunner).toContain("adb -e exec-out screencap -p");
    expect(emulatorSmoke).toContain('["shell", "service", "check", "phone"]');
    expect(emulatorSmoke).toContain('"screencap", "-p"');
    expect(emulatorSmoke).toContain("KEYCODE_HOME");
    expect(emulatorSmoke).not.toContain("KEYCODE_BACK");
    expect(emulatorSmoke).not.toContain('"input", "tap"');
    expect(androidBuild).not.toContain("testInstrumentationRunner");
    expect(androidBuild).not.toContain("androidTestImplementation");
    expect(await exists("../../scripts/android-ci-test.sh")).toBe(false);
    expect(
      await exists(
        "../../android/app/src/androidTest/java/io/github/ayauta/offlinedoudizhu/AndroidShellInteractionTest.java",
      ),
    ).toBe(false);
    expect(replacedAdr).toContain("Superseded by ADR 0014");
    expect(replacementAdr).toContain("Playwright is authoritative");
    expect(replacementAdr).toContain("exact APK");
    expect(replacementAdr).toContain("physical-device release checklist");
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
    expect(release).toContain("scripts/android-emulator-smoke.sh");
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
    // The guide uses a `vX.Y.Z` placeholder rather than a literal release, so
    // assert the procedure it must keep documenting instead of a version.
    expect(releaseGuide).toContain("git tag -a");
    expect(releaseGuide).toContain("恢复");
    expect(readme).toContain("GitHub Pages");
    expect(readme).toContain("Android 10");
    expect(gitignore).toContain("*-release-recovery.json");
  });
});
