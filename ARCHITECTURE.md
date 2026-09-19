# Architecture

Status: Accepted  
Last updated: 2026-09-12
Source of truth for: module boundaries, dependency direction, state ownership,
Web integration, and verification

Current stronger-AI requirements are owned by
[Spec 055](docs/specs/055-stronger-local-ai/spec.md) and
[ADR 0018](docs/decisions/0018-outcome-based-local-ai.md). This document describes
the shipped architecture. Its single-worker enhanced engine, fixed budgets and
TypeScript-only policies are not restrictions on future AI candidates; concrete
integration changes must update the relevant architecture and checks together.

## 1. Outcome

单机斗地主 is a static Web/PWA and public-preview Android modular monolith around a
deterministic pure TypeScript game engine. Semantic DOM and native CSS present
the game. A thin application layer owns the session, while narrow browser
adapters own browser capabilities. Android is a permission-free native shell
around the same reviewed static output. There is no backend, account,
telemetry, remote content, runtime plugin system, event bus,
dependency-injection container, or global state library.

The priorities are correct rules, readable family use, offline reliability,
privacy, and code whose authority and dependencies remain obvious.

## 2. Context and dependency direction

```text
touch / mouse
      |
      v
semantic DOM UI --intent--> application session --> pure game core
          ^                         |                    |
          |                         +--> default AI -----+
          |                         +--> enhanced-AI port --> dedicated worker
          |                         +--> settings port
          |
Web adapter: lifecycle, localStorage
PWA delivery adapter: service-worker registration

Generated service worker: fixed same-origin PWA static assets only
Android delivery adapter: packaged dist -> WebViewAssetLoader -> embedded.html
No backend, business API, account, ads, analytics, or remote content
```

The compile-time direction is:

```text
cards <- rules <- game <- app <- ui/composition
   ^         ^       ^
   +---------+-------+--- ai

app ports <- platform/web
delivery/pwa -> main composition + platform/pwa
delivery/embedded -> main composition
```

Core never imports app, UI, platform, DOM, storage, timers, or network. UI
consumes read-only application views and emits intents; it does not mutate
engine state or call platform APIs. Platform adapters implement application
ports and are wired by `src/main.tsx`. Delivery entry modules wrap that single
composition root without adding game state or business behavior.

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
    ai/                enhanced-AI request handler and fixed budgets
    ports/             AI/settings and future capability contracts
    settings/          versioned settings codec and defaults
  ui/
    components/        semantic presentation
    input/             pure pointer-selection state machine
    styles.css         native responsive styling
  platform/
    web/               browser adapters shared by WebView and normal browsers
    pwa/               generated-worker registration only
  delivery/
    pwa.ts             PWA delivery entry
    embedded.ts        packaged-host delivery entry
  main.tsx             shared application composition root

android/               minimal native shell and Android packaging

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

## 6. Browser, Android, and offline boundary

`src/platform/web` owns browser primitives shared by normal browsers and
WebView. It provides safe `localStorage` settings and one lazily created
Dedicated Worker for enhanced AI. The application stores AI difficulty in its
own versioned settings document; unfinished-game recovery remains unimplemented.
Independent document schemas follow ADR 0015, so release version changes do not
create migrations and unrelated future data can evolve separately.

The existing default AI remains on its exact synchronous core path. Casual,
Expert, and Master receive only a serializable redacted `PlayerView` through an
application port; their computation is isolated from the main thread, bounded,
cancelable, and submitted back through the normal engine transition. Failure,
late results, and invalid commands fall back to the default strategy. Master
samples possible hidden hands from public information only. These are shipped
implementation details; ADR 0018 governs future candidate architecture.
ADR 0017 owns the implemented failure scope and notices.

The Android runtime capability floor is Chrome/System WebView 90. Vite keeps
the more conservative `chrome74` syntax target, while TypeScript uses the
ES2021 library ceiling and a project compatibility check rejects later runtime
built-ins and reviewed DOM/CSS incompatibilities. Syntax transpilation does not
polyfill built-ins. The enhanced-AI Worker must stay a classic-script bundle:
Vite emits IIFE output, and the client's
`type: "module"` option is ignored as an unknown dictionary member where module
workers are unsupported, so the worker still runs on the baseline browser.
Emitting ES worker output would break those browsers silently, and no other
check would catch it.

`src/platform/pwa` alone owns service-worker registration.

Current application source contains no request API. ADR 0018 allows a future
reviewed platform adapter to load installed local model/runtime assets, while
preserving offline play and forbidding remote inference or data transfer.
Vite emits portable static files.
Pinned PWA tooling generates a precache worker for the reviewed same-origin
build output only. It has no runtime API cache, external origin, push,
background sync, analytics, or remote configuration. An update never reloads an
open session; it activates after old clients close and is used on a later
launch.

One Vite invocation emits `index.html` for browser/PWA delivery and
`embedded.html` for packaged delivery. Android packages the verified `dist/`
and loads `embedded.html` with AndroidX `WebViewAssetLoader`. Its manifest has
no permissions, its WebView blocks network/file/content access, and it has no
JavaScript-native bridge. The native shell owns Android system-Back handling:
all application screens use the same two-press task-exit behavior, while
visible Web controls own navigation back to the game home screen. System Back
is never delegated to WebView history. APK replacement under the owner's
long-lived signing key is the Android update channel. ADR 0011 owns the shell
boundary; ADR 0012 owns public distribution and release automation.

## 7. Verification

- Vitest proves cards, rules, transitions, session behavior, input state
  machines, and repository contracts deterministically under Node.
- TypeScript strict mode and the boundary check enforce dependency direction.
  The boundary check computes the runtime import closure of both main delivery
  entries and the AI worker, so enhanced policy implementation is unreachable
  from the main thread and reachable only from the worker entry.
- The WebView 90 compatibility check rejects unsupported runtime built-ins,
  independent transform properties, and dynamic viewport units without their
  legacy fallback. Playwright also runs the continuous-selection path with
  post-WebView-90 built-ins removed.
- The privacy check rejects network capability, secrets, remote assets, and
  unexpected generated-worker behavior.
- Build inspection verifies manifest, relative output, PWA precache coverage
  and embedded exclusion, absence of source maps/private paths, and reviewed
  gzip budgets on the main JavaScript, CSS, and worker assets. Each budget is
  anchored to a measured regression rather than a round number, and the build
  is deterministic, so they are hard limits rather than flaky ones.
- Playwright Chromium verifies semantic behavior, orientation gating, target
  viewports, gestures, PWA offline relaunch, and embedded startup without a
  service-worker registration. It also injects a delayed Worker asset. That
  interception must be installed on the context: a Dedicated Worker script
  request never reaches a page-level route, so a page-level interceptor is
  never called and the injected fault silently does not happen.
- Android source checks enforce zero permissions, fixed identities, the local
  asset URL, hardened WebView settings, and both system-Back implementations.
  Android lint/build are supplemented by an exact-APK offline, rendering,
  lifecycle, relaunch, and crash smoke on API 29/36 under ADR 0014.
- Physical-phone release sampling covers comfort, touch feel, heat, both
  landscape rotations, lifecycle continuity, and two-press system Back without
  being represented as an automated capability. A developer-operated ADB/CDP
  probe can additionally report runtime capabilities and check forward/reverse
  continuous selection plus discrete tap on the connected WebView; it is a
  focused diagnostic, not a replacement for the manual sampling or emulator
  artifact smoke.
- GitHub Release and Pages delivery is tag-driven from protected `main` under
  ADR 0012. Both public targets come from the same verified tag artifact.

## 8. Change rules

Rules begin with tables and tests. Bugs begin with a regression test. A new
dependency needs purpose, alternatives, exact version, license, boundary, and
maintenance cost. A change to offline/network, state authority, platform
boundary, rendering model, persistence scope, or dependency direction requires
a replacement ADR before implementation.
