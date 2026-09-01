# ADR 0003: Offline-Only and No Backend

Status: Accepted  
Date: 2026-08-30

## Context

The game is for two family members, has no account or social features, and must
remain simple and trustworthy. Network capabilities introduce privacy,
security, availability, cost, and maintenance obligations with no first-version
player benefit.

## Decision

The runtime has no backend and no network dependency. Do not use login, user
profile, ads, payment, analytics, telemetry, cloud development, remote config,
or network request APIs. Gameplay and allowed settings are local only.

The application port set intentionally contains no network abstraction.
`check:privacy` and review guard the boundary.

## Consequences

- The game launches and plays without connectivity.
- There are no service credentials, server operations, or personal-data flows.
- Cross-device sync, remote multiplayer, remote diagnostics, and cloud backup
  are unavailable.
- Updates arrive through reviewed static PWA releases or, for a future private
  Android package, a separately signed replacement package.

## Reconsider when

Only after an explicit product-scope change, privacy impact assessment, threat
model, data inventory, user-facing disclosure, and a replacement architecture
approval. Adding a harmless-looking HTTP helper is not an incremental change.
