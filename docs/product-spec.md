# Product Specification

Status: Approved by product owner  
Last updated: 2026-09-02  
Product: 单机斗地主 (`offline-doudizhu`)

## 1. Purpose

Build a simple, trustworthy, open-source Dou Dizhu game for older family
members. The game is for one human player and two local AI players. It must be
easy to read, easy to operate, usable without a network connection, and free of
commercial engagement mechanisms.

The current delivery phase is not a complete game. Phase 1 established the
engineering foundation, proved it with a minimal vertical slice, and was
accepted by the product owner on 2026-09-02.

## 2. Product principles

In priority order:

1. Readability and interaction clarity
2. Correct and explainable classic rules
3. Offline reliability and privacy
4. Maintainability and auditability
5. Modest, replaceable AI
6. Visual polish

The product must not optimize for engagement, monetization, competitive rank,
or collection mechanics.

## 3. Target users and experience

- Primary users are middle-aged and older adults playing casually on a phone.
- Each game has one human and two AI players.
- Important actions use large Chinese text, not icon-only controls.
- There is no account, login, tutorial funnel, currency, rank, or daily task.
- A player should be able to understand why a selected move is invalid.
- The game must remain fully usable offline after installation.

The first release language is Simplified Chinese. User-facing strings should be
kept out of the game-rule model so later localization remains possible.

## 4. Platform and presentation

- Primary platform: standards-based Web application and installable PWA.
- Formal mobile baseline: Android 10 or newer Chrome/System WebView. Desktop
  Chrome, Edge, and Firefox are development and trial targets; iOS is not a
  release blocker.
- Rendering: semantic HTML and native CSS. Gameplay presentation does not use
  Canvas, a CSS framework, a component library, or remote fonts/assets.
- Orientation: landscape only. Portrait displays only `请旋转手机`; no game
  controls or other functionality remain active.
- The layout accounts for safe-area insets and differing landscape aspect
  ratios, including the Redmi K60E and Redmi K70 Pro used for family review.
- The first browser load may retrieve fixed same-origin static files. Once
  installed, the PWA must start and play offline.
- The maintained private Android package bundles the same verified static
  output and must work offline from its first launch. It loads the explicit
  embedded entry without registering the PWA service worker. Android wrapping
  and signing remain delivery work, not game-application architecture.
- The game has no backend, business API, account, telemetry, or remote runtime
  content.

## 5. Scope boundaries

### 5.1 Phase 1: accepted foundation

Phase 1 consists of:

- reproducible TypeScript toolchain and repository instructions;
- pure TypeScript core boundary;
- documented product, research, architecture, and decisions;
- automated tests and privacy checks;
- Card representation;
- generation of a 54-card deck;
- deterministic shuffle with injected randomness;
- a landscape DOM table with a deterministic 17-card mock hand;
- click/tap and continuous swipe selection, including deselection;
- large `不出`, `提示`, and `出牌` buttons;
- debug-state changes caused by semantic controls;
- an installable static PWA build and real-browser offline acceptance.

Phase 1 explicitly does not implement a complete round, bidding state machine,
hand-pattern engine, scoring, production AI, persistence, rules viewer, or
voice assets.

### 5.2 First complete playable version

The first complete playable version is expected to add, through separate small
specifications:

- complete classic hand-pattern recognition and comparison;
- legal move validation and generation;
- simplified landlord bidding;
- deterministic game state and turn transitions;
- casual heuristic AI;
- hints and clear invalid-move feedback;
- local recovery of an unfinished game;
- an offline in-game rules viewer;
- production-quality accessible table UI.

Optional local voice prompts are planned after the rules and interaction flow
are stable. Multiple AI difficulty levels are a later enhancement.

### 5.3 Explicitly out of scope

- multiplayer or friend rooms;
- leaderboards or competitive rankings;
- login or any user system;
- cloud development, servers, or backend services;
- ads, payment, shops, currency, rewards, events, or daily tasks;
- analytics, telemetry, tracking, or remote configuration;
- wild-card, two-player, no-shuffle, or commercial rule variants;
- autoplay, trusteeship, or turn timers;
- MCTS, neural-network AI, or other advanced search in the first playable
  version.

## 6. Confirmed game rules

### 6.1 Players, cards, and dealing

- Three seats: one human and two AI players.
- Standard 54-card deck, including the small and big jokers.
- Each player receives 17 cards; three bottom cards remain.
- Cards have unique identities and deterministic ordering.

### 6.2 Simplified landlord bidding

The product uses `叫地主 / 不叫`, not point bidding.

1. The human always decides first.
2. If the human calls, the human immediately becomes the landlord.
3. If the human declines, the two AI players decide in seat order.
4. The first AI that calls becomes the landlord.
5. If all three decline, the deck is dealt again.
6. There is no rob-landlord phase and no doubling phase.
7. The landlord receives the three bottom cards, which are revealed to all
   players, and leads the first trick.

The human-first rule intentionally favors role choice and clarity over
competitive bidding-position fairness.

### 6.3 Play flow

- Play proceeds by seat order.
- A player leading a new trick must play cards and cannot pass.
- A responding player may beat the current move or pass.
- After both other players pass, the last player who played leads a new trick.
- A player wins immediately after legally playing their final card.
- The landlord wins alone; the two farmers win or lose as a team.

### 6.4 Supported hand patterns

The complete playable version supports:

- single;
- pair;
- triple;
- triple with one single;
- triple with one pair;
- straight of at least five ranks;
- consecutive pairs of at least three pairs;
- airplane of at least two consecutive triples;
- airplane with the matching number of single-card wings;
- airplane with the matching number of pair wings;
- four of a kind with two additional cards;
- four of a kind with two additional pairs;
- four-card bomb;
- rocket: both jokers.

Rank 2 and the jokers cannot be part of a straight, consecutive-pair sequence,
or airplane core. Attachments cannot reuse ranks from their triple or four-card
core. Exact classification of rare ambiguous wing arrangements must be fixed in
the relevant rule specification and table-driven tests before that pattern is
implemented; it must not be decided implicitly inside implementation code.

Except for bombs and the rocket, moves can only beat moves of the same pattern
and required length. Bombs beat non-bombs, higher bombs beat lower bombs, and
the rocket is the highest move.

### 6.5 Settlement

- There are no points, coins, multipliers, or persistent win-rate statistics.
- Bombs and the rocket affect move comparison only; they do not multiply a
  score.
- Spring and anti-spring do not affect settlement.
- The result presents a clear landlord/farmer win or loss only.

## 7. AI product requirements

The first playable AI should feel like a competent but forgiving family player:

- it must never access hidden cards belonging to another player;
- it must act only through legal engine APIs;
- it must always choose a legal move or legal pass;
- it should understand basic preservation and use of singles, pairs, sequences,
  airplanes, bombs, and the rocket;
- it should have basic farmer-team awareness;
- it must not enter an infinite decision loop;
- decisions must be deterministic when given the same state and injected
  randomness.

The AI strategy is replaceable. Later versions may expose casual, standard, and
hard difficulty levels. Phase 1 does not implement that selector.

## 8. Assistance and accessibility

- The human has a large `提示` button.
- Repeated hints may cycle through legal candidate moves.
- When no move can beat the current trick, the game states that clearly.
- Invalid selections produce a concise reason instead of silently failing.
- There is no timer, automatic play, or trusteeship.
- Cards remain upright and visually legible.
- Selecting a card moves it upward; selected state must not rely on color alone.
- Touch targets are larger than their visual bounds where practical.
- Important information must have strong contrast and large type.
- Animation is restrained and never required to understand state.

## 9. Rules help

The first complete playable version includes an offline rules viewer:

- a clearly labeled `游戏规则` entry outside the match;
- an accessible `牌型帮助` entry during a match;
- large text, short pages, and visual card examples;
- bidding, play order, supported patterns, comparison, passing, and victory;
- project-specific differences such as no points, no doubling, and no robbing.

The engineering specifications and tests are authoritative for exact behavior.
The in-game viewer is a player-friendly explanation. A consistency check should
ensure that every supported pattern has corresponding help content.

## 10. Local persistence

The complete playable version should recover an unfinished game after the Web
application is closed or reclaimed by the operating system.

Persist only:

- a versioned, validated snapshot of the unfinished deterministic game state;
- sound, display, and future AI-difficulty settings.

Do not persist:

- match history or timelines;
- points, win rates, or engagement statistics;
- device identifiers, account identifiers, or personal information.

Persistence is an architectural constraint now, but implementation is deferred
until the game state machine is stable. UI animation and transient card
selection state do not belong in the persisted game state.

## 11. Audio

Audio is not part of Phase 1. A later playable release may bundle optional local
voice prompts for key events such as calling, declining, passing, bombs, the
rocket, and victory.

- Audio must work offline.
- No microphone, cloud speech, or online text-to-speech is permitted.
- Audio must have a clear on/off setting.
- Visual information remains complete when audio is disabled.
- Audio assets require documented, compatible licensing and attribution.
- Background music and exhaustive card-by-card speech are not current
  requirements.

## 12. Privacy and security

The product design guarantees:

- no ads;
- no analytics or telemetry;
- no tracking;
- no account or login;
- no personal-data collection;
- no backend;
- no network dependency;
- gameplay data stored locally only.

Application source must not use `fetch`, XMLHttpRequest, WebSocket,
EventSource, Beacon, login, advertising, analytics, remote configuration, or
equivalent network capability. Generated PWA installation/update code is the
only exception and may retrieve only the reviewed, fixed, same-origin static
build files.

The public repository must not contain hosting credentials, Android signing
keys, API keys, tokens, cookies, sessions, private email addresses, unapproved
real names, phone numbers, device identifiers, certificates, keystores, or
other secrets or personal information. An explicitly approved public
contributor handle and its public/noreply address may appear in Git metadata
and public project records. Local developer configuration and future delivery
credentials belong in ignored paths; only safe examples may be public.

Before the first commit, Git author identity must be configured locally with a
separately approved public handle and public/noreply email. Global Git identity
may be modified only when the user explicitly requests that change.

## 13. Open-source policy

- Project license: Apache License 2.0.
- The public copyright identity must be approved before the license and first
  commit are created.
- Third-party projects are reference-only by default.
- Direct reuse requires an explicit source/version record, verified compatible
  license, material engineering value, preserved attribution, and separate
  approval.
- Code with an unclear license must not be copied.
- GPL or AGPL code must not be incorporated without explicit acceptance of the
  resulting licensing consequences.
- Architectural ideas, algorithmic concepts, and testing coverage may be used
  as references without disguising copied implementation as original work.

## 14. Phase 1 acceptance boundary

Phase 1 is accepted when:

- product scope and rule boundaries are approved in writing;
- open-source research and license classification are approved;
- architecture and key ADRs are approved;
- the strict TypeScript core runs tests without DOM or browser globals;
- build, typecheck, test, repository check, and privacy check pass;
- the installed PWA starts offline in landscape in Chromium;
- portrait exposes only the rotate-device gate;
- 17 mock cards support discrete and continuous select/deselect interaction,
  and all three large buttons update application-owned debug state;
- generated output contains the reviewed manifest and static precache only;
- no private identity, credential, signing material, or personal information is
  staged;
- no complete hand-pattern engine, AI, or full match has been implemented beyond
  the agreed minimal vertical slice.

This boundary was reached and accepted by the product owner on 2026-09-02.
