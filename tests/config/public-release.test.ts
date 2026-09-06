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

  it("runs CI without release signing or publication authority", async () => {
    const [ci, emulatorSmoke] = await Promise.all([
      source("../../.github/workflows/ci.yml"),
      source("../../scripts/android-emulator-smoke.mjs"),
    ]);

    expect(ci).toContain("pnpm check");
    expect(ci).toContain("lintDebug assembleDebug");
    expect(ci).toContain("scripts/android-emulator-smoke.sh");
    expect(ci).toContain("cmdline-tools/latest/bin/sdkmanager");
    expect(ci).toContain("/dev/kvm");
    expect(emulatorSmoke).toContain('["shell", "service", "check", "phone"]');
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
