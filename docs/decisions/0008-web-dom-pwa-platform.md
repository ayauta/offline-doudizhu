# ADR 0008: Web, DOM, and PWA Delivery Platform

Status: Accepted  
Date: 2026-09-01

Interaction update: ADR 0010 supersedes this record's requirement that
keyboard input be a complete gameplay alternative. The remaining Web, DOM,
PWA, pointer-selection, and semantic-control decisions stay accepted.

## Context

The product remains a private, offline, accessible Dou Dizhu game for one
human and two local AI players, but the previous platform-specific delivery
environment imposed disproportionate development and validation friction. The
pure TypeScript card foundation is portable; the platform adapter, renderer,
entry point, build, tests, and current documentation are not.

The product owner approved a platform migration after an explicit design
interview. This ADR replaces the earlier platform-specific presentation and
bundle decisions. It does not change the accepted game rules, deterministic
core, redacted AI boundary, privacy promise, or local-only persistence scope.

## Decision

The primary product is a standards-based static web application and
installable PWA:

- Android 10 or newer Chrome/System WebView is the release browser baseline.
- Desktop Chrome, Edge, and Firefox are development and trial targets.
- The application is useful in a normal browser and does not require PWA
  installation.
- Portrait orientation shows only a clear rotate-device gate. All product
  functionality is landscape-only.
- The presentation uses semantic HTML and CSS, not Canvas.
- Native CSS owns layout, cards, controls, dialogs, and responsive behavior;
  no CSS framework or UI component library is permitted in the first slice.
- A small component renderer may be selected only after a documented
  Vanilla-DOM versus Preact spike. No global state library is permitted.
- The authoritative session remains outside UI components. UI receives a
  read-only view and emits intents.
- `src/platform/web` owns browser storage, lifecycle, service-worker
  registration, and other browser capabilities. These APIs do not enter core,
  application, or presentation contracts.
- Vite produces portable static output in `dist/`.
- A pinned `vite-plugin-pwa`/Workbox build step precaches an exact same-origin
  static asset list. It defines no business API cache, external origin,
  background sync, push, analytics, or remote runtime content.
- A downloaded PWA update never reloads an active session. It activates after
  the old clients close and is used on a later launch.

The web build may be wrapped later as a privately distributed Android package.
The wrapper is a separate delivery layer, bundles the complete web output, and
must not introduce framework APIs into core, app, or UI. The initial migration
does not choose Tauri, Capacitor, an app store, or a public hosting provider.

## Offline and network boundary

The first web load may fetch the same-origin static application. After a
successful PWA install, the complete version must start and operate offline.
An Android package must operate offline from its first launch.

Application code remains unable to make network requests. Only generated PWA
installation/update code may request the build's fixed same-origin static
asset list. External fonts, images, scripts, APIs, CDNs, and remote
configuration remain forbidden.

## Interaction boundary

Card selection supports both discrete activation and continuous pointer
selection. A continuous gesture changes selection state; it never drags or
repositions cards. The state of the first visited card determines whether the
gesture selects or deselects, and each card is processed at most once per
gesture. Keyboard and discrete activation remain complete alternatives.

Animation timing, visual styling, spacing, and detailed gesture feel are
deliberately deferred to later UI specifications.

## Persistence boundary

The first persistence implementation will use versioned, validated
`localStorage` envelopes through an application port. It is limited to one
current unfinished-game snapshot, one recovery slot, and approved settings.
IndexedDB is deferred until measured size or transaction needs justify it.

## Consequences

- The pure TypeScript core remains reusable and independently testable.
- Semantic controls, browser accessibility, responsive CSS, and normal browser
  diagnostics become available.
- Real-browser automation replaces platform-specific simulator automation.
- Service-worker correctness and update behavior become part of the product's
  quality gate.
- PWA tooling adds a non-trivial development dependency graph and generated
  worker code; exact versions, licenses, scope, and upgrade cost must remain
  documented.
- A later Android wrapper requires a separate ADR, build pipeline, signing-key
  plan, and device acceptance pass.
- Public store distribution is not part of the current Definition of Done.

## Reconsider when

- Android 10 no longer covers the actual family devices;
- semantic DOM cannot meet measured interaction or performance needs;
- the PWA generator becomes unmaintained or its dependency/upgrade cost exceeds
  the cost of a small reviewed service worker;
- persistence measurably exceeds safe synchronous local-storage use; or
- a concrete Android wrapper requirement cannot be isolated to delivery code.
