# ADR 0014: Proportionate Android Artifact Verification

Status: Accepted
Date: 2026-09-09
Supersedes: ADR 0013

## Context

ADR 0013 added API 29/36 instrumentation for lifecycle, rotation, WebView
interaction, and system Back. Repeated hosted runs failed in AndroidX Test
facilitator and window-focus behavior rather than in the shipped application.
The suite duplicated behavior already covered deterministically by Playwright
and made a thin, permission-free delivery shell carry the test complexity of a
native application with multiple screens and platform integrations.

Comparable projects use verification proportional to their native surface:

- Jellyfin Android describes itself as a Web client wrapper and gates changes
  with Gradle tests, lint, and APK assembly rather than per-PR emulator-driven
  WebView interaction.
- Capacitor's Android package CI runs clean, lint, build, and unit tests without
  starting an emulator, even though the framework exposes a much larger native
  bridge surface than this application.
- Home Assistant Android has extensive native integrations and instrumentation,
  but places its complete WebView onboarding flow in scheduled E2E rather than
  treating that flow as the basic APK-build contract. Its workflow also records
  that older WebViews do not reliably expose content to hierarchy-based tools.

The public preview needs strong evidence that the distributed APK is the
expected permission-free offline wrapper. It does not need a second, less
stable implementation of the Web acceptance suite.

## Decision

Android verification has two required automated layers:

- Playwright is authoritative for gameplay, DOM interaction, app-level exit
  confirmation, responsive layout, both orientation presentations, PWA
  behavior, and embedded-entry startup.
- A black-box emulator smoke installs the exact APK, clears its data, disables
  available network transports, cold-starts it offline, requires a painted
  landscape frame, backgrounds and resumes it, performs a clean relaunch, and
  rejects application entries in the crash buffer.

Ordinary CI builds and inspects the debug APK and runs that exact artifact smoke
on API 29 and 36. The tag workflow builds and inspects the signed release APK
and runs the same smoke on API 36 before publication. Logs and a final
screenshot are retained on success or failure.

The Android source-contract check remains authoritative for zero permissions,
the embedded URL, blocked network/file/content access, absence of a JavaScript
bridge, landscape configuration, and both Android Back implementations. A
short physical-device release checklist samples touch comfort, both landscape
rotations, lifecycle continuity, and the two-press system-Back behavior. This
manual evidence is recorded honestly and is not represented as an automated CI
capability.

The ADR 0013 instrumentation source set, runner, and AndroidX Test dependencies
are removed. They may return only with a new failing native-shell regression or
a materially larger native surface, and then should target that native behavior
without driving ordinary Web gameplay through WebView.

## Dependencies

The pinned MIT-licensed `ReactiveCircus/android-emulator-runner` remains a
CI-only dependency for AVD lifecycle. The project-owned smoke uses only Node,
`adb`, Android framework diagnostics, and the exact APK under test. No Android
test framework dependency is added to the application or build.

## Consequences

- CI measures the released artifact instead of AndroidX Test task/focus
  mechanics.
- Web behavior has one complete browser acceptance owner rather than two
  competing automation paths.
- API 29 and 36 still prove minimum/current Android installation, offline
  startup, rendering, lifecycle resume, relaunch, and crash absence.
- System Back and physical rotation are no longer automated release claims;
  their source contracts and physical sampling remain explicit.
- CI time, emulator flakiness, and Android test-only dependencies are reduced.

## Reconsider when

- a reproducible defect escapes the exact-APK smoke and cannot be covered by a
  source contract, Playwright, or a focused native test;
- the Android wrapper gains another Activity, native screen, permission,
  JavaScript bridge, or other approved platform behavior;
- release-only shrinking or variant behavior needs focused on-device coverage;
  or
- a stable black-box tool can exercise system Back without depending on WebView
  hierarchy or a facilitator Activity.
