# Spec 045: Public v0.1 Preview Release

Status: Approved for implementation
Approved: 2026-09-06
Decision: ADR 0012

## Outcome

Publish `v0.1.0` as a reproducible GitHub Pre-release with a signed universal
Android APK, SHA-256 digest, and matching GitHub Pages Web/PWA deployment. A
future release is produced by tagging reviewed protected `main`; no maintainer
must build or upload an APK manually.

## Repository contract

- Canonical repository: `https://github.com/ayauta/offline-doudizhu`.
- Default branch: `main`, with force pushes and deletion disabled.
- Required CI checks gate changes to `main` after the initial repository setup.
- Issues are disabled initially. Existing Apache-2.0 licensing, privacy,
  security, public handle, and noreply Git identity remain unchanged.
- No credential, signing material, generated output, private configuration,
  device identifier, or other PII is committed or logged.

## Version contract

- Project and Android display version: `0.1.0`.
- Android `versionCode`: `1`; every later public APK must increase it.
- Tag: `v0.1.0`.
- GitHub marks every `0.x` release as a Pre-release until a later approved spec
  changes that policy.
- The first preview openly states that offline rules help and unfinished-game
  recovery are not implemented.

## Continuous-integration contract

Ordinary pushes and pull requests run read-only/reproducible verification:

- exact Node 24.20.0 and pnpm 11.24.0 installation;
- frozen dependency installation;
- `pnpm check` including deterministic, bundle/privacy, and Chromium tests;
- JDK 17, Android SDK 36, `lintDebug`, and `assembleDebug`;
- APK metadata, permission, embedded-entry, and signature inspection;
- an Android API 36 emulator shell smoke that installs and cold-starts the APK
  offline, enters the game, backgrounds/resumes, switches both landscape
  rotations, verifies the two-press Back contract, and cold-starts again.

The emulator smoke owns only Android-shell integration. Playwright remains the
complete deterministic gameplay and browser-interaction acceptance.

## Release contract

A `v*` tag must point to a commit contained in `main`. The release workflow:

1. validates that the tag and source versions agree;
2. reruns the complete Web and Android gates;
3. restores the release keystore from Actions Secrets without printing it;
4. builds and verifies the signed release APK;
5. runs the same Android-emulator shell smoke against that APK;
6. creates an APK with a stable versioned filename and a SHA-256 digest file;
7. creates the GitHub Pre-release with Chinese notes; and
8. deploys the already-verified `dist/` from that tag to GitHub Pages.

Publication must fail closed when signing Secrets, the expected tag, the
verified APK, or any gate is missing. An ordinary branch build receives no
release signing material and cannot publish.

## Documentation contract

The root README leads with the playable product, online URL, Android download,
Android 10+ sideload note, privacy promise, known preview limitations, and
links to focused developer documentation.

Chinese guides document local Web development, Android development, release
versioning, one-time signing setup, GitHub Secrets, tag-driven release,
recovery, and failure diagnosis. Existing English architecture, ADR, and
feature specifications remain the engineering source of truth.

## Acceptance

- Repository tests lock version agreement, release trigger, least-privilege
  workflow permissions, secret names, tag-to-main verification, Pre-release
  creation, Pages artifact source, and absence of committed signing files.
- The local full gate passes with the pinned project toolchain.
- Android lint/debug build and the emulator smoke pass locally when the
  corresponding SDK/emulator environment is available.
- GitHub CI passes on the public repository before branch protection is made
  required.
- A tag-driven dry path or `v0.1.0` run proves signed APK, checksum, Release,
  and Pages publication from one commit.
- GitHub Release and Pages URLs are added to README only when verified.

## Non-goals

- Google Play, AAB publication, custom domains, automatic in-app updates,
  analytics, crash reporting, public support commitments, issue templates,
  contribution guides, rules help, persistence, or new gameplay behavior.
