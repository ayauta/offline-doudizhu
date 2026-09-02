# Spec Roadmap

Status: Approved sequencing baseline  
Last updated: 2026-09-02

## 1. Workflow

Each numbered feature gets a directory under `docs/specs/` when it becomes
active. A feature spec should contain scope, non-goals, rule examples or UX
states, acceptance criteria, test plan, and rollout/recovery notes where
relevant.

Implementation follows:

```text
spec -> tests -> implementation -> self-review -> playable review -> commit
```

Rules work starts with table-driven tests. UI work starts from written states
and acceptance criteria, then requires screenshot/manual phone review. A spec
must stay small enough for one agent to understand and verify without loading
the entire project history.

Numbers leave space for insertion. “Later” means not part of the current Gates
E/F; it does not promise a release date.

## 2. Foundation gates

### 001 — Repository bootstrap

Historical bootstrap of the strict TypeScript/pnpm/Vitest build skeleton,
repository guidance, public docs, privacy/security checks, and
architecture-aligned directories. Its retired platform configuration is not a
current instruction.

Acceptance: install, typecheck, test, build, privacy check, and aggregate check
pass from a clean checkout. No gameplay is implemented.

### 002 — Card/deck foundation

Specify and implement canonical 54-card IDs, ranks/suits/jokers, deterministic
ordering, deck generation, explicit-RNG shuffle, and conservation tests.

Acceptance: pure Node tests prove exactly 54 unique cards and deterministic
shuffle behavior. This is the only real core logic needed by the minimal slice.

### 003 — Historical Canvas/platform vertical slice

This accepted historical slice proved the original platform boundary. It is
superseded by spec 004 and is retained only as project history.

Accepted on 2026-08-30. Its platform-specific acceptance criteria are retired.
It was explicitly not a Dou Dizhu game loop.

### 004 — Web/DOM platform migration

Replace the retired platform slice with a standards-based semantic DOM/PWA
slice, preserve pure card logic, add click/tap and continuous card selection,
and establish deterministic plus real-browser acceptance.

Acceptance: the approved migration spec passes `pnpm check`, Chromium starts
the installed build offline, portrait shows only the rotate gate, and no
retired platform implementation remains active.

The current migration stop line is after 004 is accepted.

## 3. Correctness-critical rule foundation

### 010 — Hand-pattern classification and comparison

Resolve every supported pattern and disputed edge case in a written canonical
rule table, then implement deterministic classification and comparison. This
feature covers selected physical cards only; it does not infer alternate
intentions or validate a turn. Its active specification is
`docs/specs/010-hand-pattern-classification-and-comparison/spec.md`.

Acceptance: all 14 pattern kinds, stable errors, rare attachment boundaries,
normalization invariants, comparison compatibility, and bomb/rocket precedence
pass table-driven tests under the pure TypeScript core boundary.

### 012 — Contextual play validation

Validate physical-card ownership, lead/pass restrictions, and response strength
using the classified-play contract. Produce stable user-explainable context
errors without duplicating pattern recognition. Its active specification is
`docs/specs/012-contextual-play-validation/spec.md`.

### 013 — Legal move generation and hint primitive

Generate complete legal actions for a hand/trick without duplicates. The hint
feature and every AI strategy must consume this source rather than reimplement
rules. Its active specification is
`docs/specs/013-legal-action-generation/spec.md`.

## 4. Deterministic game flow

### 020 — Bidding and deal state

Implement 17/17/17 plus three bottom cards, human-first `叫地主 / 不叫`, AI
decisions in order after a human pass, first call wins landlord, bottom-card
assignment, and all-pass redeal request. Its active specification is
`docs/specs/020-bidding-and-deal-state/spec.md`.

### 021 — Playing state machine

Implement current-turn validation, lead/play/pass transitions, turn rotation,
two-pass trick reset, public history, hand removal, invariant checks, and
finished-state detection. Its active specification is
`docs/specs/021-playing-state-machine/spec.md`.

### 022 — Game result and restart

Implement landlord/farmer win presentation data and clean new-game/redeal
boundaries. There are no points, multipliers, spring settlement, or statistics.

## 5. Local AI

### 030 — Legal baseline AI and safety contract

Build deterministic test strategies and the legal-command safety wrapper.
Prove redacted views contain no hidden hands and automated games terminate.

### 031 — Casual heuristic AI

Add understandable bidding and playing heuristics, basic farmer cooperation,
structure preservation, ordinary bomb restraint, and deterministic evaluation
fixtures. No search, MCTS, neural model, or difficulty selector.

## 6. First playable product

### 040 — Production table UI

Replace the debug table with full bidding/playing/win states, readable cards,
remaining counts, role/turn cues, forgiving hit regions, error messages, hint,
restart, and layout fixtures for phone aspect ratios/safe areas.

### 041 — Offline rules viewer

Provide large-text Chinese rules with examples for every supported pattern and
the simplified bidding/no-scoring rules. Content derives from spec 010 so UI
help and executable rules do not drift.

### 042 — Local resume and settings

Implement versioned unfinished-game recovery plus approved display settings.
Validate and migrate snapshots; safely discard corrupt data; store no history,
statistics, identity, or analytics.

### 043 — Accessibility and device acceptance

Run the real-phone landscape matrix, tune contrast/card overlap/touch targets,
verify offline/background-resume behavior, and record playable acceptance.

## 7. Later optional improvements

### 050 — Optional local key-action voice

Add reviewed local audio assets and a local on/off setting. No microphone,
streaming, TTS service, background music, or network.

### 051 — Difficulty choices

Add strategy profiles behind `AiStrategy`, with player-facing descriptions and
evaluation fixtures. Difficulty must not change rules or expose hidden cards.

### 052 — Further AI evaluation

Only if family playtesting shows a real need, investigate stronger bounded
heuristics or search under phone performance limits. Any dependency/model needs
a new license, privacy, size, explainability, and maintenance assessment.

## 8. Explicitly absent roadmap items

There are no planned specs for login, networking, backend, matchmaking, rooms,
leaderboards, ads, payments, currency, telemetry, analytics, user profiles,
cloud saves, daily tasks, match history, win rate, two-player mode, wildcards,
no-shuffle mode, point bidding, doubling, or scoring multipliers.

Adding any of these is a product/architecture change, not ordinary backlog work.
