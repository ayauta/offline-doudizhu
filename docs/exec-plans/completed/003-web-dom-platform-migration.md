# Execution Plan 003: Web/DOM Platform Migration

Status: Completed  
Started: 2026-09-01  
Completed: 2026-09-02  
Spec: `docs/specs/004-web-dom-platform-migration/spec.md`

## Goal

Deliver the approved offline Web/PWA DOM vertical slice, remove current
platform and Canvas implementation, preserve the portable card foundation, and
establish a reproducible browser quality gate.

## Safety and recovery

- [x] Inspect the repository and confirm it has no commits and all public files
  are untracked.
- [x] Preview current platform/Canvas paths and platform-coupled documents.
- [x] Create separate restricted temporary archives for public repository
  contents and ignored private platform configuration.
- [x] Generate and verify SHA-256 checksums for both archives.
- [x] Keep the recovery archives until the product owner accepts the migration.
- [x] Move ignored retired private configuration out of the project only after
  its archive is verified; retain the moved copy with recovery evidence.

The migration must not inspect, print, stage, or copy private configuration
into public files. Recovery means restoring an archive into an empty copy of
the repository, not merging it over the migrated tree.

## Steps

1. [Completed] Add the approved migration spec and replacement platform ADR;
   rewrite current product/architecture instructions before behavior changes.
2. [Completed] Add exact candidate dependencies and disposable equivalent
   Vanilla DOM/Preact spikes; ADR 0009 accepts Preact based on lifecycle,
   synchronization, and bundle measurements.
3. [Completed] Add tests for Web repository config and the pointer-selection
   state machine before implementation.
4. [Completed] Remove retired configuration, runtime adapter, Canvas UI, build
   scripts, compatibility checks, and obsolete tests.
5. [Completed] Implement the selected semantic DOM renderer, application
   session, Web platform boundary, landscape gate, and composition root.
6. [Completed] Add Vite build, strictly scoped PWA generation, output
   validation, boundary/privacy checks, and Playwright Chromium flows.
7. [Completed] Run the complete quality gate, inspect output and commit
   candidates, document dependency/privacy impact, and perform self-review.
8. [Completed] Move this plan to completed and include it in the first clean
   Web-platform commit. The product owner explicitly deferred the physical
   working-directory rename so the existing Codex project mapping remains
   valid; that rename is a separate future operation.

The approved repository-local author identity is
`ayauta <32976579+ayauta@users.noreply.github.com>`. The baseline commit is the
commit containing this completed plan.

## Dependency candidates

| Package | Exact candidate | License | Purpose and boundary |
| --- | ---: | --- | --- |
| `vite` | `8.2.2` | MIT | Development server and static production build only. |
| `preact` | `10.29.8` | MIT | Candidate DOM component renderer only; no game state authority. |
| `@preact/preset-vite` | `2.10.6` | MIT | Candidate JSX integration for Vite. |
| `@playwright/test` | `1.62.1` | Apache-2.0 | Development-only real-browser acceptance. |
| `vite-plugin-pwa` | `1.3.0` | MIT | Build-time precache generation; generated worker is strictly scoped to static assets. |

Alternatives and costs are recorded in the spec, ADR, dependency research, and
renderer spike. All direct versions remain exact and the lockfile is committed.

## Evidence to record

- [x] Renderer spike outcome and rejected alternative: ADR 0009.
- exact install/lockfile result and license review;
- [x] Deterministic tests: 4 files, 18 tests.
- [x] Playwright Chromium: 7 flows at 800x360, 900x400, 640x340, and
  400x800 portrait; offline relaunch included.
- [x] Production build: 7 files, application JS 20.09 kB / 8.38 kB gzip,
  CSS 4.37 kB / 1.59 kB gzip, 7 complete precache entries.
- [x] Offline launch passes; source never sends `SKIP_WAITING`, so an update
  cannot reload or replace an open session.
- [x] Privacy scan: 21 runtime files; boundary scan: 11 source files.
- any real-phone result supplied by the product owner;
- [x] Untracked commit-candidate review; ignored output/private paths excluded.
- [x] Final staged-file review and initial baseline commit (the commit containing
  this completed plan).

## Stop line

Stop after the Web/PWA architecture-validation slice passes. Do not implement
formal Dou Dizhu rules, AI, persistence, production styling, public hosting, or
an Android wrapper under this plan.
