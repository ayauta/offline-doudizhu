# Execution Plan 017: Private Android Package

Status: Active
Started: 2026-09-06
Spec: `docs/specs/044-android-private-package/spec.md`

## Goal

Implement ADR 0011 and Spec 044: one verified Web artifact, explicit PWA and
embedded entries, and a minimal permission-free Android package.

## Steps

1. [x] Record the accepted replacement delivery decision and approved spec.
2. [x] Add failing repository and delivery-contract tests.
3. [x] Split PWA delivery registration from the shared composition root and
   build both HTML entries from one Vite invocation.
4. [x] Deepen bundle/privacy checks and add embedded Playwright acceptance.
5. [x] Add the minimal Android project, generated asset wiring, hardened
   WebView host, debug/release identities, and external signing contract.
6. [x] Add Android static checks and documentation/dependency records.
7. [x] Run the complete Web gate, Android lint, and debug APK build.
8. [x] Add the owner-approved uniform two-press Android system-Back exit,
   prevent duplicate launcher Activities, and verify the native path from the
   home and active-match screens on Xiaomi 10S.
9. [ ] Finish the approved Xiaomi 10S three-to-five-minute quick
   acceptance; record environment and results without device identifiers.
10. [ ] Self-review tracked/generated files, privacy, permissions, APK contents,
   signing exclusions, and documentation; then move this plan to completed.

## Safety and recovery

- All source changes are version controlled.
- `dist/`, Android build output, local SDK configuration, signing keys, and APKs
  remain generated/ignored.
- No existing signing material is inspected or printed.
- Revert ADR 0011, Spec 044, the Android project, delivery entries, tests, and
  documentation together if the slice is rejected.

## Current environment note

At plan start, the workstation exposed no trusted Android SDK, JDK, Gradle, or
Android Platform Tools installation. Project-local ignored tooling now contains
Temurin JDK 17.0.20.1, Android SDK/Build Tools 36, and Google Platform Tools
37.0.1 for Linux and Windows. The unrelated third-party `adb` was not executed.

On 2026-09-06, `pnpm check` passed 215 deterministic tests and 24 Chromium
acceptance tests. Gradle 9.6.0 completed `lintDebug assembleDebug`; APK inspection
confirmed the `.debug` application ID, API 29–36, zero permissions, packaged
`embedded.html`, and a valid debug v2 signature. Four lint warnings remain by
approved policy: the pinned API 36/Gradle 9.6.0 baselines and landscape-only
orientation. Backup/device-transfer exclusions and an application icon were
added after the initial lint pass, removing the two actionable warnings.

During the first physical-attempt preflight, both the Linux and official
Windows ADB 37.0.1 clients reported no connected device without listing or
recording any device identifier. No APK was installed during that attempt.

Later on 2026-09-06, Windows ADB detected the authorized Xiaomi 10S and installed
the debug APK. The first physical launch exposed a Xiaomi-specific startup NPE:
fullscreen configuration requested the window insets controller before the
decor view existed. A regression test now fixes the lifecycle order. The rebuilt
APK passed five cold starts, stayed top-resumed without crash logs, rendered the
home and bidding table, and reported the packaged `embedded.html` URL with no
service-worker target. Owner-operated swipe, round, background/rotation, heat,
and offline checks remain pending in
`docs/device-tests/044-xiaomi-10s-android-quick-check.md`.

The owner then found that Android system Back could expose an older settlement
from the native Activity stack and otherwise behaved differently by screen.
The approved interaction contract is now uniform: every screen requires two
Back invocations within two seconds to exit to the device home screen; visible
application controls alone navigate to the game home screen. Implementation
uses the Android 13+ callback with an Android 10-12 fallback and a single-task
launcher Activity. On Xiaomi 10S, a first Back invocation retained both the
home and active-match screens; two consecutive invocations returned to the
MIUI launcher, and reopening after the active-match exit showed a clean game
home. Owner confirmation of the visible message and settlement-screen path
remains in step 9.
