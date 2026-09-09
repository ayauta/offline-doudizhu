# Spec 044: Private Android Package and Explicit Delivery Entries

Status: Implemented; private-only distribution superseded by Spec 045
Approved: 2026-09-06
Decision: ADR 0011

## Outcome

Maintain exactly two delivery targets: the existing Web/PWA and a private
Android APK. Both targets use one reviewed Vite `dist/` and the same game
implementation. Android launches offline from its first run without Android
permissions, a backend, remote content, or a JavaScript-native bridge.

## Web delivery contract

- `index.html` remains the normal browser/PWA entry.
- `embedded.html` is a second Vite HTML entry for packaged hosts.
- Both entries load the same application composition and generated application
  assets.
- Only the PWA entry imports the service-worker registration module.
- The PWA worker precaches `index.html` and the shared application closure but
  excludes `embedded.html`.
- The installed-PWA offline/update acceptance remains unchanged.
- An embedded browser acceptance starts the application and observes no service
  worker registrations.

## Android package contract

- Application ID: `io.github.ayauta.offlinedoudizhu`.
- Debug application ID: `io.github.ayauta.offlinedoudizhu.debug`.
- `minSdk`: 29. `targetSdk` and `compileSdk`: 36.
- One Activity, one WebView, Java source, no XML layout, no native gameplay.
- The Activity loads
  `https://appassets.androidplatform.net/assets/embedded.html` with
  `WebViewAssetLoader`.
- JavaScript and DOM storage are enabled because the application requires them.
- Network loads, cleartext traffic, file access, content access, mixed content,
  external navigation, and unmapped requests are blocked.
- The manifest contains no `uses-permission` declaration.
- Backup is disabled so future local game state is not copied to cloud backup.
- The Web/PWA icon and Android launcher icon use the same three overlapping
  blue card backs shown on the game home screen, on the established green
  field with ivory outlines. Delivery formats may encode the vector geometry
  separately, but must retain that shared visual identity.
- WebView debugging is enabled only for a debuggable build.
- Landscape sensor orientation is used; Activity configuration changes preserve
  the current WebView/session when switching between landscape orientations.
- Android system Back has one meaning on every application screen. The first
  invocation shows the short message `再按一次退出游戏`; a second invocation
  within two seconds ends the Activity task and returns to the device home
  screen. Back is never delegated to WebView history or used as in-application
  navigation.
- Visible in-application controls remain responsible for returning to the game
  home screen. Leaving during a match through system Back discards that
  in-memory match, so the next launch starts from a clean home screen.
- The launcher Activity has a single task instance so reopening the application
  cannot create a native back stack containing an older game or settlement.
- Renderer loss is handled by ending and recreating the Activity rather than
  leaving a broken surface.

## Build and signing contract

- Web `dist/` is built and verified before Android packaging.
- Gradle copies the complete verified `dist/` into a generated build directory;
  generated files are not committed beneath Android sources.
- Android packaging fails clearly when `dist/embedded.html` is absent.
- Debug builds use the standard debug signing key.
- Release signing uses one long-lived owner-controlled key supplied outside the
  repository. The build reads only environment variables and does not provide a
  committed fallback key.
- Signing files, passwords, local SDK paths, APKs, Android build output, and
  generated Web assets remain ignored.

## Dependencies

| Dependency | Exact version | License | Purpose and boundary |
| --- | ---: | --- | --- |
| Android Gradle Plugin | 9.4.0 | Apache-2.0 | Android build-time packaging only. |
| Gradle wrapper | 9.6.0 | Apache-2.0 | Reproducible Android build runner. |
| AndroidX WebKit | 1.17.0 | Apache-2.0 | Official `WebViewAssetLoader`; Android shell only. |

Java is used instead of adding the Kotlin plugin. AndroidX WebKit is preferred
over a custom request interceptor because it supplies the reviewed, origin-aware
Android asset loader recommended by Android documentation.

## Automated acceptance

- Repository tests assert both delivery entries and the absence of PWA
  registration from shared/embedded startup.
- Build-output checks verify both HTML entries, relative references, the PWA
  precache exclusion, and no private path/source map leakage.
- Playwright retains the PWA offline relaunch and adds an embedded launch with
  zero service-worker registrations.
- Static Android checks verify identifiers, SDK baseline, exact dependency,
  asset URL, no manifest permissions, no JavaScript bridge, and the required
  WebView restrictions. They also lock the uniform two-press system-Back
  contract, modern/legacy Android callback paths, task removal, and single-task
  launcher behavior.
- Android lint and `assembleDebug` pass once the pinned Android toolchain is
  available.

## Physical-device quick acceptance

On Xiaomi 10S first, and later the Redmi K60E/K70 Pro family targets:

1. Install the debug APK with Wi-Fi and mobile data disabled.
2. Perform five cold launches and confirm the home screen appears each time.
3. Start a game, perform a fast continuous card-selection swipe for roughly
   thirty seconds, and complete one representative bidding/play flow.
4. Background/resume three times and rotate between both landscape directions.
5. Confirm no reload, state loss, delayed taps, unexpected external page,
   visible stutter, uncomfortable heat, or permission prompt.
6. From the home, active-match, and settlement screens, confirm the first
   system Back invocation shows `再按一次退出游戏`, the second within two
   seconds returns to the device home screen, and reopening starts at the game
   home screen. Confirm that a single Back invocation never navigates within
   the WebView or reveals an older settlement.

Expected duration is three to five minutes. A fifteen-minute continuous run is
diagnostic follow-up only when the quick run exposes stutter, reload, heat, or
battery concerns.

## Non-goals

- Google Play, Play App Signing, analytics, crash upload,
  auto-update, online content, notifications, deep links, file access, camera,
  audio recording, location, account integration, iOS, macOS, and Windows.
- Native menus, settings, game logic, persistence bridge, or asset downloader.

Public GitHub preview distribution is intentionally added later by ADR 0012 and
Spec 045; the Android shell and signing boundaries in this spec remain active.
