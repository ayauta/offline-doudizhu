# Execution Plan 018: Public v0.1 Preview Release

Status: Active
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
9. [ ] Replace the unstable raw-adb interaction smoke under ADR 0013 with
   layered API 29/36 instrumentation and exact-APK shell checks, retain failure
   evidence, and rerun the complete local and hosted gates.
10. [ ] Create the public GitHub repository, push the feature branch, let CI pass,
   merge to `main`, and enable branch protection/disable Issues.
11. [ ] Generate the long-lived project signing identity, configure GitHub
    Secrets without exposing them, and hand the owner a recovery requirement.
12. [ ] Create `v0.1.0`, monitor Release and Pages jobs to completion, verify
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
