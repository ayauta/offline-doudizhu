# ADR 0012: Public Preview Distribution Through GitHub

Status: Accepted
Date: 2026-09-06
Supersedes: ADR 0011 only for the private-distribution constraint

## Context

ADR 0011 established a permission-free Android shell and intentionally limited
it to private APK replacement. The product owner has now approved a public
`v0.1.0` preview so people can either install Android directly or play the same
reviewed static Web build online.

Public distribution adds release integrity, repeatability, hosting, update-key,
and repository-governance obligations. It does not change the application
runtime: the game remains local-only, has no business API, and contains no
analytics, telemetry, account, remote configuration, or external runtime
assets.

## Decision

The canonical public repository is `ayauta/offline-doudizhu`.

- GitHub Releases distributes one universal Android APK and its SHA-256 digest.
- GitHub Pages serves the Web/PWA build from the same `v*` tag as the APK.
- A `v*` tag, not an ordinary `main` push, starts public delivery.
- The release workflow reruns the complete Web gate, Android lint and release
  build, APK inspection, and Android-emulator shell smoke acceptance before it
  can publish either target.
- `v0.1.0` is a GitHub Pre-release. Missing rules help and unfinished-game
  recovery are disclosed limitations, not hidden release claims.
- The Android application keeps one project-specific long-lived signing key.
  CI receives the encoded keystore and credentials only through GitHub Actions
  Secrets. The owner keeps a recoverable copy outside GitHub and the repository.
- The repository keeps `main` protected against force pushes and unchecked
  changes. Issues remain disabled for the initial preview; no contribution
  program is implied.
- Automated gates are release-authoritative. Real-device comfort, perceived
  touch quality, and heat checks remain useful non-blocking sampling because an
  emulator cannot measure them honestly.

The public APK remains direct-download only. Google Play, Play App Signing,
in-application updating, auto-download, and an AAB are outside this decision.

## Consequences

- APK updates require permanent custody of the first public signing identity.
- A release tag becomes an externally visible, difficult-to-retract action and
  must point to protected `main` history.
- Pages availability is a delivery convenience, not a new backend or an online
  gameplay dependency. Installed PWA and Android play remain offline-capable.
- CI may download pinned build tools and dependencies. That build-time network
  access does not widen the runtime network boundary.
- Public release automation and GitHub-hosted actions become maintained
  build-time dependencies and must be recorded and reviewed.

## Replacement triggers

A replacement ADR is required before adding an app store, a custom update
service, a backend, remote runtime content, telemetry, a different signing
identity, or automatic publication from ordinary branch pushes.
