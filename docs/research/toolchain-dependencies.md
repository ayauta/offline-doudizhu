# Toolchain and Dependency Record

Status: Approved Web and Android baseline
Last updated: 2026-09-06

All direct versions are exact and the lockfile is committed. Runtime gameplay
has one possible renderer dependency; the remaining packages are development
or build-time only.

| Package | Exact version | License | Boundary and purpose |
| --- | ---: | --- | --- |
| `preact` | `10.29.8` | MIT | Accepted semantic DOM renderer under ADR 0009. It owns no authoritative game state. |
| `vite` | `8.2.2` | MIT | Development server and static production build. No runtime service. |
| `@preact/preset-vite` | `2.10.6` | MIT | Accepted JSX/Preact Vite integration, build-time only. |
| `vite-plugin-pwa` | `1.3.0` | MIT | Generates manifest, registration, and fixed static precache worker. No business runtime cache. |
| `@playwright/test` | `1.62.1` | Apache-2.0 | Development-only Chromium interaction/offline acceptance. Browser binaries are local artifacts, not committed. |
| `typescript` | `7.0.2` | Apache-2.0 | Strict static checking only. |
| `vitest` | `4.1.11` | MIT | Deterministic Node test runner only. |
| `@types/node` | `24.13.3` | MIT | Types for build/check/test configuration only. |
| Android Gradle Plugin | `9.4.0` | Apache-2.0 | Android build-time packaging only; no application runtime code. |
| Gradle wrapper | `9.6.0` | Apache-2.0 | Reproducible Android build runner; wrapper files only are committed. |
| `androidx.webkit:webkit` | `1.17.0` | Apache-2.0 | Android-shell-only `WebViewAssetLoader`; no bridge or game dependency. |
| `actions/checkout` | commit `3d3c42e5aac5ba805825da76410c181273ba90b1` (`v7`) | MIT | GitHub-hosted source checkout in CI/release only. |
| `actions/setup-node` | commit `820762786026740c76f36085b0efc47a31fe5020` (`v7`) | MIT | Installs exact Node 24.20.0 on GitHub-hosted runners. |
| `actions/setup-java` | commit `dd06d9cba3e5552c54d9f8ea23572deb30010f7c` (`v6`) | MIT | Installs Temurin JDK 17 and caches Gradle inputs in CI. |
| `actions/upload-artifact` / `download-artifact` | commits `b7c566a772e6b6bfb58ed0dc250532a479d7789f` (`v6`) / `37930b1c2abaa49bbe596cd826c3c89aef350131` (`v7`) | MIT | Transfers already-verified release assets between isolated release jobs. |
| GitHub Pages actions | `configure-pages` `983d7736d9b0ae728b81ab479565c72886d7745b`, `upload-pages-artifact` `7b1f4a764d45c48632c6b24a0339c27f5614fb0b`, `deploy-pages` `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e` | MIT | Official tag-only static Pages artifact and deployment path. |
| `ReactiveCircus/android-emulator-runner` | commit `a421e43855164a8197daf9d8d40fe71c6996bb0d` (`v2`) | MIT | CI-only AVD lifecycle for Android shell smoke; no application/runtime dependency. |

## Alternatives and costs

- Vanilla DOM avoids a runtime renderer dependency, but the approved equivalent
  spike must show whether manual synchronization and listener lifecycle remain
  safer as bidding, dialogs, rules help, and session views grow. If equivalent,
  Vanilla wins by default.
- A hand-written service worker would reduce the PWA dependency tree but moves
  precache completeness, hashing, manifest integration, and update lifecycle
  into bespoke security-sensitive code. The generator is worth its cost only
  while output inspection and offline browser tests enforce its narrow scope.
- Direct Vite scripts replace bespoke bundler wrappers. Native CSS replaces CSS
  frameworks. Preact hooks, if accepted, replace any global state library.
- AndroidX WebKit replaces a custom local-request interceptor because the
  official loader provides reviewed origin-aware asset mapping. Plain platform
  `Activity` and Java avoid AppCompat, Compose, the Kotlin plugin, Capacitor,
  Tauri, and a general JavaScript-native bridge.
- GitHub-hosted Actions are pinned to immutable commits instead of floating
  tags. Direct shell setup was retained for pnpm and APK inspection; official
  actions are used only where they encapsulate runner authentication/artifact
  protocols. A fully hand-written emulator lifecycle was rejected because AVD
  boot, acceleration, shutdown, and diagnostics are runner-sensitive; the
  pinned emulator action is isolated to CI and invokes project-owned tests.

## Maintenance controls

Every upgrade is deliberate: review release notes and licenses, inspect
lockfile changes, run the full quality gate, compare production file inventory
and sizes, verify no new remote/network behavior, and retest offline install and
non-disruptive update behavior. Do not add a direct package solely for a small
utility that can remain clear project-owned code.
