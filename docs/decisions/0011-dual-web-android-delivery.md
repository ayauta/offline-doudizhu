# ADR 0011: Explicit PWA and Embedded Android Delivery Entries

Status: Superseded by ADR 0012 for distribution; embedded delivery design remains accepted
Date: 2026-09-06

## Context

The accepted Web/PWA application is now also being packaged as a private
Android application. The two delivery environments share the same application,
UI, and static assets but have different installation and update lifecycles:

- a browser-installed PWA needs a service worker to install, precache, and
  update reviewed same-origin static files;
- an Android APK already contains those files and is updated by installing a
  newly signed APK.

Registering a service worker from the shared composition root would make the
embedded package participate in an unnecessary browser update lifecycle.
Detecting Android with a query parameter, user-agent string, or runtime flag
would hide a delivery decision inside shared application startup.

## Decision

Vite produces one `dist/` artifact with two explicit HTML delivery entries:

- `index.html` loads the shared application through a PWA entry module that
  also registers the generated service worker;
- `embedded.html` loads the same shared application through an embedded entry
  module and never imports or registers the service worker.

`src/main.tsx` remains the one application composition root. The two delivery
entry modules select outer delivery behavior; they do not duplicate or own
application composition. The generated PWA worker excludes `embedded.html`
from its precache. Build and browser checks verify the PWA and embedded output
contracts separately.

The Android application is a minimal platform-owned Java shell. It:

- uses application ID `io.github.ayauta.offlinedoudizhu`, with `.debug` added
  to debug builds;
- supports Android 10 (API 29) and newer;
- bundles the reviewed `dist/` output as generated APK assets;
- loads `embedded.html` through AndroidX `WebViewAssetLoader` at the reserved
  HTTPS-like `appassets.androidplatform.net` origin;
- requests no Android permissions, including no `INTERNET` permission;
- blocks network loads, cleartext traffic, file/content access, external
  navigation, and unmapped resource fallback;
- exposes no JavaScript-native bridge and contains no native business logic.

One build artifact is verified before Web publication or Android packaging.
Release signing is a final Android delivery step. A release build requires the
owner's external keystore path, alias, and passwords from environment variables;
no key or secret is stored in the repository.

## Consequences

- Web and Android share one application implementation and one static build.
- PWA installation/update behavior is absent from Android runtime startup.
- The delivery difference is explicit, reviewable, and independently testable.
- Android works offline on first launch and has no network permission.
- The Android shell adds Android Gradle Plugin, Gradle wrapper, and AndroidX
  WebKit maintenance, signing, and device acceptance obligations.
- `dist/` may contain inert PWA files inside the APK; they are not loaded or
  registered. A filtered embedded artifact is deferred until a measured size,
  audit, or platform requirement justifies the extra packaging logic.
- iOS, macOS, and Windows are not maintained targets. If approved later, their
  native shells consume `embedded.html`; no speculative JavaScript host adapter
  is added now.

## Rejected alternatives

- Runtime `delivery=android` markers, user-agent detection, and platform flags:
  they turn a build-time delivery choice into shared runtime branching.
- Registering and intercepting the PWA worker inside Android: it duplicates an
  update/cache lifecycle already supplied by the APK.
- `file://` asset loading: it weakens origin behavior and requires unsafe file
  access settings.
- Capacitor, Tauri, or a JavaScript-native bridge: they add permissions,
  capability surface, and maintenance without product value for this shell.
- Separate Web and Android frontend builds or repositories: they invite drift
  without isolating any real application difference.

## Reconsider when

- the embedded application needs an approved native capability;
- measured APK size justifies filtering PWA-only generated files;
- a second native platform exposes a real shared host abstraction; or
- Android WebView cannot meet measured correctness, accessibility, or
  performance requirements on the family devices.
