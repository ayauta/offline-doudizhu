# ADR 0015: Independently Versioned Local Documents

Status: Accepted

Date: 2026-09-11

Supersedes: ADR 0006's single-envelope decision; its local-only scope and
privacy limits remain accepted

## Context

ADR 0006 placed approved settings and a future unfinished-game snapshot in one
versioned envelope. Settings are now needed before match recovery is designed.
Coupling both lifecycles would make a small preference depend on an unrelated,
larger game-state schema and would turn ordinary additive fields into needless
migrations.

The Web/PWA and embedded Android deliveries share application code but use
different browser storage origins. No cross-installation or cloud
synchronization is required.

## Decision

Store settings and any future unfinished-game recovery snapshot as separate
local documents with independent keys, validators, and schema versions.

The first settings document is JSON at `offline-doudizhu.settings`:

```json
{
  "schemaVersion": 1,
  "data": {
    "aiType": "default"
  }
}
```

The application release version and persisted schema versions are unrelated.
Stable machine-facing field and enum values are persisted; translated labels
are not. Decoders ignore unknown fields, supply explicit defaults for missing
fields, and treat unknown enum values as their safe default. Additive optional
fields normally do not bump a schema version. A version changes only for an
incompatible type or semantic change.

Supported old documents decode directly into the current in-memory model rather
than relying on a growing chain of release-by-release mutations. A document
with an unsupported future schema is not overwritten. Corrupt or unavailable
storage falls back safely and never prevents play.

Only the AI setting is implemented by Spec 051. Unfinished-game recovery and
its key remain deferred to a dedicated specification.

## Consequences

- A settings change does not freeze or migrate the future match-state schema.
- App releases may change without rewriting local data.
- Browser/PWA and Android WebView preferences remain intentionally local to
  their respective installation origins.
- The small synchronous `localStorage` document remains appropriate; IndexedDB,
  a database, and a serialization dependency add no value.
- Future breaking formats need a direct decoder for each supported historical
  shape and a test that future unknown versions remain untouched.

## Reconsider when

- settings become large or require transactions;
- an approved native capability introduces an explicit shared-storage contract;
  or
- local recovery is implemented and reveals a measured need for atomic updates
  spanning both documents.
