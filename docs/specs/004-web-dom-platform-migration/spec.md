# Spec 004: Web/DOM Platform Migration

Status: Approved  
Date: 2026-09-01

Historical note: this completed migration slice required keyboard operation for
its architecture-validation screen. ADR 0010 retires that requirement for the
formal game UI; it is not a Spec 040 product or acceptance requirement.

## Goal

Replace the retired platform and Canvas vertical slice with a standards-based,
offline-capable Web/PWA vertical slice while preserving the pure TypeScript
card foundation, product rules, privacy promise, and architectural boundaries.

The result is still an architecture-validation screen, not a playable Dou
Dizhu match.

## Product decisions

- Product name: `offline-doudizhu`; user-facing name: `单机斗地主`.
- Primary runtime: standards-based Web/PWA.
- Formal mobile baseline: Android 10 or newer Chrome/System WebView.
- Target devices for later manual acceptance: Redmi K60E and Redmi K70 Pro.
- Landscape is the only functional orientation. Portrait shows only a rotate
  prompt.
- Normal browser use does not require installation. No custom install prompt is
  included.
- Public hosting, an Android wrapper, app-store distribution, and formal game
  implementation are separate future work.

## Technology selection spike

Before selecting the retained renderer, implement equivalent disposable
Vanilla DOM and Preact versions of the migration screen. Compare:

- authority and direction of state flow;
- amount of manual DOM synchronization and event cleanup;
- ability to preserve semantic controls and pointer selection;
- deterministic test ergonomics;
- production bundle contents and dependency/license cost;
- expected change surface for bidding, rules help, result dialogs, and future
  session views.

If the results are materially equivalent, retain Vanilla DOM. Retain Preact
only when it demonstrably reduces synchronization and lifecycle risk without
moving authoritative game state into components. Record the outcome in an ADR
and remove the losing spike.

## Landscape screen

At startup in a landscape viewport:

- fill the viewport and safe-area insets with a table surface;
- show a deterministic 17-card mock hand derived from the pure core deck;
- show large `不出`, `提示`, and `出牌` semantic buttons;
- show `架构验证 · 非正式牌局` and the current debug-state message;
- keep card rank and suit readable without external art or fonts;
- expose selected state through position and a non-color-only visual marker;
- keep all essential controls usable at 800-by-360 and 900-by-400 CSS
  viewports, plus a narrower regression viewport.

In portrait, the screen contains only an accessible `请旋转手机` message. The
table and all actions are inert and unavailable.

## Selection interaction

- Activating a card toggles that card.
- Pointer movement beyond a small tap threshold starts continuous selection.
- The first card's initial state determines whether the gesture selects or
  deselects every subsequently visited card.
- A card is processed at most once in one continuous gesture.
- The gesture never moves a card's physical DOM position and never invokes the
  browser drag-and-drop API.
- Pointer cancellation ends the gesture safely.
- Mouse, touch, discrete activation, and keyboard operation share the same
  intent path.
- Button activation updates application-owned debug state and redraws the
  view. Buttons still do not invoke formal bidding, hint, pass, play, AI, or
  rule logic.

Detailed timing, animation, haptics, card spacing, and final visual style are
non-goals of this migration.

## Architecture

- `src/core` stays pure strict TypeScript with no DOM, browser, storage,
  timers, wall clock, ambient randomness, or platform imports.
- `src/app` owns the authoritative debug/session state and exposes a read-only
  view plus intents/subscription.
- `src/ui` owns semantic DOM components and transient selection state.
- `src/platform/web` owns browser lifecycle, local storage, service-worker
  registration, and orientation observation.
- `src/main.tsx` is the only composition root.
- UI may use DOM element/event types required for presentation, but it may not
  access storage, network, service-worker, or global lifecycle APIs.
- No Redux, Zustand, Signals, router, CSS framework, UI component library, CDN,
  external font, or remote asset is introduced.

## PWA and offline behavior

- Vite creates a clean, reproducible `dist/` with relative/portable static
  references.
- The manifest declares `单机斗地主`, landscape orientation, and standalone
  display.
- A pinned PWA generator precaches only reviewed same-origin build output.
- Business source contains no `fetch`, XHR, WebSocket, EventSource, Beacon,
  login, advertising, analytics, or remote-configuration capability.
- A newly installed version launches with the browser context offline.
- An available update does not reload an open session and becomes active only
  after old clients close.
- Android packaging is not implemented in this spec.

## Automated acceptance

- Existing card/deck/shuffle tests continue to pass unchanged.
- Tests cover application debug-state transitions.
- Tests cover the continuous-selection state machine, including select,
  deselect, revisits, cancellation, and tap behavior.
- Repository tests assert Web/PWA package/config identity and absence of retired
  platform configuration.
- Playwright Chromium proves:
  - landscape initial render;
  - semantic buttons and 17 cards;
  - discrete selection/unselection;
  - continuous select and deselect gestures;
  - all three debug-button state changes;
  - portrait rotate gate and inert table;
  - target/narrow viewport layout without clipping;
  - a built application starts after the browser context goes offline.
- Build-output checks verify the PWA manifest, complete precache list, no
  source maps/private paths, and no forbidden runtime capability.
- `pnpm check` runs typecheck, deterministic tests, build checks, boundary and
  privacy checks, and Playwright noninteractively.

## Documentation and removal acceptance

- Current README, product spec, architecture, privacy/security policy, agent
  instructions, dependency record, commands, and checks describe only the Web
  product.
- Accepted platform decisions are replaced explicitly before their obsolete
  files are removed; surviving ADRs use platform-neutral or Web terminology.
- Completed platform-specific specs, research, and execution plans remain
  clearly labeled historical records and are not current instructions.
- Retired runtime adapters, configuration examples, compatibility typings,
  build scripts, tests, ignored private configuration, and Canvas renderer are
  removed.
- No generated output, browser binary, private configuration, signing key,
  secret, or PII is staged.

## Playable acceptance

Automated browser acceptance is required in this migration. A real-phone pass
on Redmi K60E and Redmi K70 Pro remains required before claiming production UI
acceptance, but may be recorded after the code is handed to the product owner.

## Non-goals

- formal dealing or bidding;
- combination classification/comparison;
- legal move generation, hint strategy, or AI;
- completed match flow or settlement;
- production visual design, animation, audio, or haptics;
- persisted game recovery implementation;
- public deployment;
- Android packaging, signing, updates, or store submission.
