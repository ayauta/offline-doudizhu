import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("explicit Web and Android delivery", () => {
  it("keeps PWA registration out of shared and embedded startup", async () => {
    const [main, pwaEntry, embeddedEntry, embeddedHtml] = await Promise.all([
      source("../../src/main.tsx"),
      source("../../src/delivery/pwa.ts"),
      source("../../src/delivery/embedded.ts"),
      source("../../embedded.html"),
    ]);

    expect(main).not.toContain("registerOfflineWorker");
    expect(pwaEntry).toContain("registerOfflineWorker");
    expect(embeddedEntry).not.toContain("registerOfflineWorker");
    expect(embeddedHtml).toContain("/src/delivery/embedded.ts");
  });

  it("declares a permission-free hardened Android shell", async () => {
    const [manifest, build, activity, strings, extractionRules, appIcon, webIcon] = await Promise.all([
      source("../../android/app/src/main/AndroidManifest.xml"),
      source("../../android/app/build.gradle.kts"),
      source("../../android/app/src/main/java/io/github/ayauta/offlinedoudizhu/MainActivity.java"),
      source("../../android/app/src/main/res/values/strings.xml"),
      source("../../android/app/src/main/res/xml/data_extraction_rules.xml"),
      source("../../android/app/src/main/res/drawable/app_icon.xml"),
      source("../../public/icon.svg"),
    ]);

    expect(manifest).not.toContain("uses-permission");
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    expect(manifest).toContain('android:icon="@drawable/app_icon"');
    expect(manifest).toContain('android:enableOnBackInvokedCallback="true"');
    expect(manifest).toContain('android:launchMode="singleTask"');
    expect(extractionRules).toContain("<cloud-backup>");
    expect(extractionRules).toContain("<device-transfer>");
    expect(extractionRules).not.toContain("<include");
    expect(appIcon).toContain("<vector");
    expect(appIcon.match(/android:name="card-[^"]+"/g)).toHaveLength(3);
    expect(appIcon).toContain('android:fillColor="#173B59"');
    expect(webIcon).toContain('aria-label="三张牌背"');
    expect(webIcon.match(/<g id="card-[^"]+"/g)).toHaveLength(3);
    expect(webIcon).toContain('fill="#173b59"');
    expect(build).toContain('namespace = "io.github.ayauta.offlinedoudizhu"');
    expect(build).toContain('applicationId = "io.github.ayauta.offlinedoudizhu"');
    expect(build).toContain('applicationIdSuffix = ".debug"');
    expect(build).toContain("minSdk = 29");
    expect(build).toContain("androidx.webkit:webkit:1.17.0");
    expect(build).not.toContain("assets.srcDir(generatedWebAssets)");
    expect(build).toContain("addGeneratedSourceDirectory");
    expect(build).not.toContain('tasks.named("preReleaseBuild")');
    expect(build).toContain("VerifyReleaseSigning");
    expect(activity).toContain("WebViewAssetLoader");
    expect(activity).toContain("https://appassets.androidplatform.net/assets/embedded.html");
    expect(activity).toContain("setBlockNetworkLoads(true)");
    expect(activity).toContain("setAllowFileAccess(false)");
    expect(activity).toContain("setAllowContentAccess(false)");
    expect(activity).not.toContain("addJavascriptInterface");
    expect(activity).toContain("EXIT_CONFIRMATION_WINDOW_MILLIS = 2_000L");
    expect(activity).toContain("R.string.press_back_again_to_exit");
    expect(strings).toContain("再按一次退出游戏");
    expect(activity).toContain("registerOnBackInvokedCallback");
    expect(activity).toContain("public void onBackPressed()");
    expect(activity).toContain("finishAndRemoveTask()");
    expect(activity).not.toContain("webView.goBack(");
    expect(activity.indexOf("setContentView(")).toBeLessThan(
      activity.indexOf("configureFullscreenWindow();"),
    );
  });
});
