# Architecture

Status: Accepted  
Last updated: 2026-09-04
Source of truth for: module boundaries, dependency direction, state ownership,
Web integration, and verification

## 1. Outcome

单机斗地主 is a static Web/PWA modular monolith around a deterministic pure
TypeScript game engine. Semantic DOM and native CSS present the game. A thin
application layer owns the session, while a narrow Web adapter owns browser
capabilities. There is no backend, account, telemetry, remote content, runtime
plugin system, event bus, dependency-injection container, or global state
library.

The priorities are correct rules, readable family use, offline reliability,
privacy, and code whose authority and dependencies remain obvious.

## 2. Context and dependency direction

```text
touch / mouse
      |
      v
semantic DOM UI --intent--> application session --> pure game core
          ^                         |                    |
          |                         +--> local AI -------+
          |                         +--> persistence port
          |
Web adapter: lifecycle, localStorage, service-worker registration

Generated service worker: fixed same-origin static assets only
No backend, business API, account, ads, analytics, or remote content
```

The compile-time direction is:

```text
cards <- rules <- game <- app <- ui/composition
   ^         ^       ^
   +---------+-------+--- ai

app ports <- platform/web
```

Core never imports app, UI, platform, DOM, storage, timers, or network. UI
consumes read-only application views and emits intents; it does not mutate
engine state or call platform APIs. Platform adapters implement application
ports and are wired only by `src/main.tsx`.

## 3. Layout and ownership

```text
src/
  core/
    cards/             canonical cards, deck, explicit-RNG shuffle
    rules/             combinations, comparison, legal moves
    game/              deterministic commands and transitions
    ai/                strategies over redacted PlayerView
  app/
    session/           authoritative live session and read-only views
    ports/             persistence/audio/lifecycle contracts when needed
  ui/
    components/        semantic presentation
    input/             pure pointer-selection state machine
    styles.css         native responsive styling
  platform/
    web/               browser-only adapter implementations
  main.tsx             composition root

tests/                 deterministic unit/config tests
e2e/                   Playwright Chromium acceptance
public/                project-owned static PWA assets
scripts/               repository/build/privacy checks
dist/                  generated, never committed
```

Avoid generic `utils`, `helpers`, and `common` directories. Code belongs to the
narrowest owner of its meaning.

## 4. State and command model

One application session is authoritative. It exposes immutable/read-only views,
accepts typed intents, and notifies subscribers after accepted transitions.
Later formal gameplay follows:

```ts
transition(state, command) -> Result<{ state, events }, GameError>
```

The core receives explicit randomness and never reads time or ambient random
state. Invalid commands return stable structured errors. UI-only state such as
hover, focus, pointer gesture progress, and selected-card animation remains in
the UI and is not persisted.

AI receives only a redacted `PlayerView`, returns a normal engine command, and
cannot edit state. A safety wrapper validates every AI result with the same
rules as human input.

## 5. DOM interaction

Cards and actions are semantic buttons. The supported gameplay-input baseline
is touch, with mouse click retained for development and browser trials. Card
selection supports discrete tap/click and continuous pointer selection. A pure
gesture state machine fixes the gesture mode from the first card's initial
state, visits each card once, and emits selection intents; the gesture never
repositions DOM or uses drag-and-drop.

The product defines no dedicated keyboard model, key bindings, focus-navigation
scheme, or keyboard acceptance requirement. Semantic controls keep any native
browser keyboard behavior they receive; that incidental behavior is neither
disabled nor claimed as a complete way to play a match. ADR 0010 supersedes the
earlier keyboard-completeness requirement in ADR 0008.

Landscape is the only functional orientation. CSS makes the complete table
unavailable in portrait and exposes only the accessible rotate prompt. Layout
uses safe-area insets and is verified at representative family-phone and narrow
landscape viewports.

## 6. Browser and offline boundary

`src/platform/web` is the only source area allowed to access `window`,
`localStorage`, service workers, or lifecycle events. The first persistence
adapter will store a versioned current snapshot, one recovery slot, and approved
settings in `localStorage`; persistence is not implemented in the migration
slice.

Application source contains no request API. Vite emits portable static files.
Pinned PWA tooling generates a precache worker for the reviewed same-origin
build output only. It has no runtime API cache, external origin, push,
background sync, analytics, or remote configuration. An update never reloads an
open session; it activates after old clients close and is used on a later
launch.

A future Android wrapper is packaging around `dist/`, not a new application
architecture. It requires its own ADR for tool choice, signing, update channel,
and device acceptance.

## 7. Verification

- Vitest proves cards, rules, transitions, session behavior, input state
  machines, and repository contracts deterministically under Node.
- TypeScript strict mode and the boundary check enforce dependency direction.
- The privacy check rejects network capability, secrets, remote assets, and
  unexpected generated-worker behavior.
- Build inspection verifies manifest, relative output, precache coverage, and
  absence of source maps/private paths.
- Playwright Chromium verifies semantic behavior, orientation gating, target
  viewports, gestures, and offline relaunch.
- Redmi K60E and Redmi K70 Pro review is required before production UI
  acceptance, but not before the architecture-validation slice is handed off.

## 8. Change rules

Rules begin with tables and tests. Bugs begin with a regression test. A new
dependency needs purpose, alternatives, exact version, license, boundary, and
maintenance cost. A change to offline/network, state authority, platform
boundary, rendering model, persistence scope, or dependency direction requires
a replacement ADR before implementation.
