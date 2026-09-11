# Spec 051: Rule-Based AI Difficulty

Status: Implemented; automated and browser acceptance passed

Date: 2026-09-11

## Goal

Preserve the current production AI as the unchanged default while adding three
pure rule/algorithm opponent levels: `休闲`, `高手`, and `大师`. All levels choose
the best action according to what they evaluate; weaker play comes only from a
simpler view of the position, never from deliberate random mistakes.

The table must remain continuously responsive. Enhanced opponent computation
runs in one bounded worker and overlaps the existing readable AI turn beat.
Hints remain immediate and independent of opponent difficulty.

## Product contract

The persisted values and player-facing order are:

| Stored value | Label | Behavior |
| --- | --- | --- |
| `casual` | 休闲 | basic deterministic scoring |
| `default` | 默认 | the existing `CASUAL_AI_STRATEGY`, unchanged |
| `expert` | 高手 | complete rule-based action scoring |
| `master` | 大师 | expert shortlist plus sampled shallow rollout |

`default` is the initial and invalid-data fallback. One setting controls both
AI seats. It is visible only on the home screen, saves immediately, and is
captured when a new game starts. The level is not displayed or changeable
during a game.

The home screen keeps `开始游戏` as its only primary action. Beneath it, one
compact inline segmented control is labelled `电脑水平` and contains only
`休闲 / 默认 / 高手 / 大师`. The current segment uses a calm filled highlight;
there is no checkmark, description, disclosure row, sheet, scrim, or completion
action. Choosing a segment saves immediately.

Each segment retains a practical touch target at the narrow 640×340 landscape
baseline. Press feedback begins on pointer down. The selection highlight uses
only transform and color/opacity transitions, settles without bounce, and
removes movement under reduced-motion preference. No framework, icon
dependency, glass/blur effect, spinner, or blocking overlay is added.

## Compatibility and persistence

Spec 051 implements only the settings document from ADR 0015. There is no
unfinished-game save or recovery. The codec is independent of `localStorage`,
uses stable English keys, tolerates missing/unknown fields, and does not
overwrite an unsupported future schema. Storage read/write exceptions never
prevent a game.

The global package/app release version remains independent. Web/PWA and Android
retain their separate origin/application storage. No import/export or cross-app
migration is introduced.

## AI architecture

Every enhanced play policy consumes the existing engine-produced legal actions
and uses one `scoreAction(context, action, profile)` pipeline:

1. `LegalMoveGenerator` is the existing `generateLegalActions`; it is never
   duplicated.
2. `HandAnalyzer` memoizes a rank-count representation and estimates the minimum
   remaining plays plus singles, pairs, triples, sequences, airplanes,
   bombs/rocket, high controls, and structural breakage.
3. `StateEvaluator` scores public remaining counts, initiative, current-play
   ownership, landlord/farmer roles, teammate cooperation, unseen controlling
   ranks, dangerous one/two/three-card endings, and bomb opportunity cost.
4. Policy profiles select the highest score with stable legal-order tie breaks.

All new modules remain pure TypeScript under `src/core/ai`. They receive only
the existing redacted view and legal actions. They do not classify or validate
plays independently, edit state, use browser APIs, inspect hidden hands, or add
models/dependencies/network capability.

### Casual

Casual uses basic hand burden, obvious structure preservation, bomb/rocket
protection, low adequate responses, and one/two-card opponent danger. It does
not count unseen controls or search hidden worlds. It always takes its own
top-scored action and uses basic visible-hand bidding.

### Expert

Expert evaluates every legal action through the memoized hand analyzer and full
public state evaluator. It adds remaining-card inference, control-card value,
role-specific pressure, farmer cooperation, initiative, bomb cost, and endgame
shape. It always takes the top-scored action and uses the full visible-hand bid
evaluation.

### Master

Master reuses Expert bidding and Expert play scores. It first shortlists the top
three to five actions. From the cards not in its own hand or public history, it
uses an explicit seeded PRNG to deal possible opponent hands consistent with
revealed bottom-card ownership and public remaining counts. It never receives
the real hands.

For each completed sampled world, Master applies each shortlisted root action
and performs a greedy Expert rollout two to four plies deep. The final ranking
combines the base Expert score with the mean root-side outcome. Sampling order
is balanced across candidates so a deadline cannot systematically favor the
first action. The best result from completed evidence is returned; with no
completed sample it returns the Expert leader.

Runtime sampling may vary possible worlds, but randomness never chooses a
lower-ranked action directly. Fixed seeds and fixed sample/node budgets provide
deterministic tests.

## Bidding and play integration

The default level continues to call `runAiTurn(state, CASUAL_AI_STRATEGY)` on
the existing synchronous path. Its decisions and timing are regression-locked.

Enhanced levels send a serializable `AiDecisionContext`, level, and request
identity to the worker. One deep enhanced-turn application module owns request
lifecycle, the response window inside the presentation beat, cancellation,
result validation, and fallback scope. A returned command is still cloned and
submitted through the existing transition safety seam.

Casual bidding uses a basic visible-hand threshold. Expert and Master share the
full visible-hand bid evaluator. No bidding policy sees bottom cards before the
landlord is selected.

## Hint contract

`提示` remains synchronous and continues to use `rankCasualPlayActions`
regardless of the selected opponent level. It never invokes the worker or waits
for Expert/Master. Pointer-down feedback is immediate; the action selection is
visible in the same interaction without a spinner or later replacement.

The highest current default-ranked playable action is suggested first and
repeated taps retain the existing deterministic candidate cycling. A hint never
submits a play.

## Failure and performance contract

- Casual target: 2–8 ms, hard worker budget 16 ms.
- Expert target: 8–25 ms, hard worker budget 40 ms.
- Master target: 40–80 ms, hard worker budget 120 ms.
- No enhanced AI task runs on the main thread.
- Every level preserves the existing approximately 520 ms presentation beat;
  AI computation adds no deliberate delay.
- Worker construction or execution failure changes the effective level to
  Default for the rest of that match without freezing or retry loops.
  `当前电脑水平暂不可用，本局已使用默认水平` appears once and fades without
  requiring confirmation. The saved selection is retried on the next match.
- A request timeout, stale/malformed response, computation failure, or illegal
  command silently uses Default for that turn only. It must not display the
  match-level unavailable notice.
- Default AI is evaluated only when fallback is required; it is never
  speculatively computed while the worker is pending.
- A valid Worker result arriving before the main-thread safety margin is used
  at the existing presentation beat even when cold module startup exceeds the
  algorithm's own computation budget.

Target-device browser and Android WebView release checks treat visible main-
thread AI stalls as failures. Physical-device comfort, frame pacing, heat, and
touch checks are recorded as manual evidence and are never claimed as automated.

## Evaluation and acceptance

The everyday `pnpm check` remains fast and covers:

- exact identity and representative golden decisions for the unchanged default;
- settings codec/storage failure/future-version behavior;
- scorer completeness, stable ties, input preservation, and legal commands;
- hand-analysis memoization and structure/endgame fixtures;
- landlord/farmer cooperation, pass, bomb, rocket, and direct-finish cases;
- Master determinization card conservation, public-information-only inputs,
  fixed-budget termination, and seeded repeatability;
- session locking, async cancellation, stale results, match-scoped fallback when
  the Worker is unavailable, a silent turn-scoped fallback on a single request
  failure, one notice per match, hint independence, and ordinary game
  termination;
- home segmented-control semantics, immediate pressed state,
  persistence/reload, reduced motion, narrow landscape fit, worker build
  output, PWA offline loading, and embedded startup;
- transitive runtime import closure: enhanced policy implementation is
  unreachable from the main entries and reachable from the worker entry;
- reviewed gzip budgets for main JavaScript, CSS, and the AI worker, each
  anchored to a measured regression rather than a round number;
- deterministic browser fault injection at two points on the response window:
  a 300 ms delayed Worker asset, and a delay past the window, neither of which
  may show the unavailable notice.

A separate `pnpm bench:ai` runs a larger fixed-seed, role-balanced paired
tournament and real timing sample during tuning or release—not on every edit.
Results report design expectation, scenario behavior, paired aggregate wins,
and median/P95/max latency separately. The intended aggregate order is
`休闲 < 默认 < 高手 < 大师`; a single deal may upset that order and tests must not
pretend otherwise.

## Non-goals

No neural network, learned model, TensorFlow, PyTorch, remote service, MCTS,
large search tree, worker pool, third-party concurrency library, per-seat level,
in-match selector/badge, unfinished-game persistence, statistics, telemetry,
native bridge, or Android permission is added.
