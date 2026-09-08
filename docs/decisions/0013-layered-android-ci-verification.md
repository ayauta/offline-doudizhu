# ADR 0013: Layered Android CI Verification

Status: Accepted
Date: 2026-09-06
Supersedes: ADR 0012 only for Android CI verification responsibilities

## Context

ADR 0012 required one project-owned Android shell smoke to install the APK and
also drive WebView content, lifecycle changes, rotation, and the two-press
system-Back contract through raw `adb` input. Repeated API 36 runs showed that
this mixed unrelated responsibilities and depended on an unsupported test
path: Android no longer supports intercepting `KeyEvent.KEYCODE_BACK` for
predictive Back.

Android's testing guidance and established Android projects instead use
instrumented tests for interactions that need a real Android device, Espresso-
Web for native/WebView integration, and UI Automator only for system-level
interaction. General Web tests remain faster and more reliable for behavior
that does not depend on the Android host.

## Decision

Android release verification is split into three layers:

- Playwright remains authoritative for complete Web gameplay, DOM interaction,
  responsive layout, PWA behavior, and embedded-entry startup.
- A small `androidTest` suite verifies the Android/WebView seam with
  Espresso-Web, ActivityScenario, and UI Automator. It enters the embedded
  game, exercises background/resume and rotation, verifies retained WebView
  state, and drives the two-press exit contract through the platform's actual
  Back path.
- The project-owned shell smoke installs the exact APK under test, disables
  available emulator network transports, proves offline cold start and a
  painted landscape frame, backgrounds/resumes, cold-starts again, and rejects
  crash-buffer entries. It does not locate or operate Web DOM elements and does
  not inject raw Back key events.

Ordinary CI runs the instrumented suite and shell smoke on Android API 29 and
36 so both the minimum supported platform fallback and the current target API
are covered. The tag workflow reruns the instrumented suite on API 36 and runs
the black-box shell smoke against the signed release APK. Android test reports,
logcat, and a final screenshot are uploaded even when a test fails.

The pinned emulator action continues to own AVD creation and teardown. Gradle
build-managed devices are deferred: they would add a second device lifecycle
change without fixing interaction ownership, and Automated Test Device images
remove SystemUI and hardware rendering needed by this acceptance.

## Dependencies

The Android test source set adds exact Apache-2.0 AndroidX Test dependencies:

- `androidx.test:core:1.7.0` for ActivityScenario;
- `androidx.test.ext:junit:1.3.0` for the Android JUnit runner;
- `androidx.test.espresso:espresso-core:3.7.0` and
  `androidx.test.espresso:espresso-web:3.7.0` for synchronized native/WebView
  interaction; and
- `androidx.test.uiautomator:uiautomator:2.4.0` for system-level Back gestures
  and device-state waits.

These are build/test-only dependencies. They are absent from application
runtime artifacts and have no access to game state in production.

## Consequences

- Web behavior is not duplicated across Playwright and Android tests; only the
  delivery seam is sampled on Android.
- System interaction uses state-based Android test APIs instead of sleeps and
  coordinate guesses inside a Node script.
- API 29 and 36 add CI time, but expose both native Back implementations before
  release.
- The exact signed APK still receives a permission-free offline black-box
  launch test even though the instrumented suite targets the debug variant.
- Emulator infrastructure failures can be diagnosed from retained reports,
  logcat, and screenshots without weakening genuine test failures with blind
  retries.

## Reconsider when

- GitHub-hosted emulator startup becomes the dominant source of failures;
- the Android wrapper gains another native screen or approved capability;
- standard Gradle-managed devices support the required SystemUI/rendering
  checks with lower maintenance cost; or
- release minification or variant-specific code requires instrumentation of the
  exact release variant.
