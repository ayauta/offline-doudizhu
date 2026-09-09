# Execution Plan 018: Public v0.1 Preview Release

Status: Completed
Started: 2026-09-06
Spec: `docs/specs/045-public-preview-release/spec.md`

## Goal

Implement ADR 0012 and Spec 045, then publish one reproducible signed Android
preview and matching Web/PWA from protected GitHub history.

## Steps

1. [x] Resolve public scope, version, hosting, signing, testing, documentation,
   and repository-governance decisions with the product owner.
2. [x] Record the replacement distribution ADR and approved release spec.
3. [x] Add failing repository tests for version and workflow contracts.
4. [x] Implement CI, release, Pages, signing restoration, APK inspection, and
   Android-emulator smoke automation.
5. [x] Align project versions and reorganize public/developer/release docs.
6. [x] Close Plan 017 without overstating unrecorded physical checks; make
   automated gates authoritative and retain manual checks as optional evidence.
7. [x] Run the full local Web gate, Android lint/build/inspection, and every
   locally feasible release-script check.
8. [x] Self-review tracked/generated files, history, privacy, permissions,
   workflow privilege, signing exclusions, and recovery instructions.
9. [x] Replace the unstable interaction instrumentation under ADR 0014 with
   proportional API 29/36 exact-APK shell checks, retain failure evidence, and
   rerun the complete local and hosted gates.
10. [x] Create the public GitHub repository, push the feature branch, let CI pass,
   merge to `main`, and enable branch protection/disable Issues.
11. [x] Generate the long-lived project signing identity, configure GitHub
    Secrets without exposing them, and hand the owner a recovery requirement.
12. [x] Create `v0.1.0`, monitor Release and Pages jobs to completion, verify
    downloadable checksums/signature and live offline-capable Web startup, then
    record the published URLs and complete this plan.

## Safety and recovery

- Workflow and documentation changes are version-controlled and reversible.
- Repository creation precedes branch protection so initial history can be
  pushed; protection is enabled only after its named CI checks exist and pass.
- Signing material is generated outside tracked paths, never printed, and sent
  to GitHub only as encrypted Actions Secrets.
- No tag is pushed until the source commit, local gates, CI, signing identity,
  and release notes are ready. Before that point, rollback is an ordinary code
  revert. After publication, fixes use an incremented version; the public tag is
  not silently rewritten.

## Completion evidence

- Release: <https://github.com/ayauta/offline-doudizhu/releases/tag/v0.1.0>
- Web/PWA: <https://ayauta.github.io/offline-doudizhu/>
- Protected source commit: `389f31c484f3d818e198f8cfb09bd844eee4b12c`
- CI run `34351418129` passed the Web gate and API 29/36 exact-APK smoke jobs on
  `main`; release run `34352107144` passed the complete Web gate, signed APK
  inspection, API 36 signed exact-APK smoke, Pages deployment, and Pre-release
  publication.
- The downloaded APK checksum matched its published `.sha256` file. Independent
  inspection confirmed package `io.github.ayauta.offlinedoudizhu`, version
  `0.1.0`, Android API 29–36, zero requested permissions, embedded Web entry,
  valid v2 signature, and the externally backed-up RSA 4096 certificate.
