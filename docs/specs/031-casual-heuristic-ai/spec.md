# Spec 031: Casual Heuristic AI

Status: Approved for implementation

Date: 2026-09-03

## Goal

Add one deterministic casual strategy that makes locally sensible bidding and
playing decisions over the existing redacted AI contract. It should feel like
a competent but forgiving family player because it evaluates the visible
position without deep search, not because it deliberately makes random or
obviously bad moves.

This specification establishes one reusable action-ranking framework and one
casual profile. Later difficulty work may replace or extend the evaluator, but
must continue to consume the same redacted views and engine-produced legal
actions.

## Public seam and boundaries

`src/core/ai` adds:

```ts
CASUAL_AI_STRATEGY: AiStrategy;

rankCasualPlayActions(
  context: Extract<AiDecisionContext, { readonly kind: "play" }>,
): readonly ValidatedPlayAction[];
```

The strategy uses the ranking result's first action and converts it to the
ordinary command for its own seat. The ranking is also the future hint seam:
Spec 040 may cycle through the ranked actions without reimplementing strategy
rules. No hint UI or explanation text is included now.

The existing `BASELINE_AI_STRATEGY`, redacted `PlayerView`, `runAiTurn` safety
wrapper, and game transition authority remain unchanged. Every candidate comes
from `generateLegalActions`; this feature does not classify, compare, invent,
or validate actions independently.

The casual module is pure TypeScript. It uses no opponent hands, hidden bottom
cards, ambient randomness, clock, timer, browser/Node API, persistence,
network, worker, dependency, model, or generated strategy table.

## Product behavior

The casual strategy is deterministic. An identical frozen decision context
produces the same command and ranked action order. Equal evaluations preserve
the legal generator's stable order. There is no random variation or deliberate
blunder injection.

The strategy applies one coherent evaluation to every legal action. The
evaluation balances:

- immediate completion of the hand;
- reducing cards and estimated remaining hand burden;
- preserving useful pairs, triples, sequences, airplanes, bombs, and rocket;
- spending the lowest adequate ranks when responding;
- keeping bombs, rocket, twos, and jokers unless endgame pressure justifies
  them;
- gaining or yielding initiative based on public remaining-card threats; and
- landlord-versus-farmer team relationships.

Immediate legal victory is the only universal play override. Role and threat
terms influence the same evaluation rather than growing a separate list of
scripted deals. Farmers apply the same cooperation rules whether the partner or
opponent is human: they normally yield to a partner's useful play and become
more willing to contest when the landlord is close to finishing. The strategy
never receives the identity or strength of hidden opponent cards.

## Bidding

Bidding evaluates only the acting seat's seventeen cards plus the public fact
that earlier seats declined. The hand-strength evaluation considers high
control cards, bombs/rocket, groups, and existing multi-card structure. It does
not inspect the bottom cards or simulate hidden hands.

`ai-one` uses the normal casual calling threshold. When the human and `ai-one`
have both declined, `ai-two` uses a lower last-bidder threshold because both
opponents have publicly signalled weak landlord interest. It still declines a
genuinely poor hand; landlord assignment is never forced and the all-pass
redeal rule is unchanged.

Across the checked deterministic shuffled-deck corpus with a forced human
decline, the design target for both AIs declining is at most 2%. The hard
acceptance ceiling is strictly below 5%. Thresholds may be calibrated against
that corpus, but an individual decision remains a transparent consequence of
the visible hand and bid position; deck order is never changed to force the
metric. The corpus also guards against starving either AI seat of a material
share of landlord calls.

## Evaluation and acceptance

Table-driven fixtures cover:

- clearly strong and clearly poor bids, including the lower last-bidder
  threshold without an unconditional call;
- the fixed-corpus all-pass rate and deterministic repeated evaluation;
- immediate completion, multi-card structure shedding, low-cost response,
  structure preservation, bomb/rocket restraint, opponent endgame pressure,
  and role-symmetric farmer cooperation;
- ranked-action completeness, uniqueness, freezing, input preservation, stable
  tie-breaking, and conversion to an ordinary engine command;
- safety-wrapper acceptance and bounded complete games with both AI seats
  acting; and
- paired fixed-deck matches showing the casual side improves on the existing
  first-legal-action baseline in both landlord and farmer roles.

Automated evaluation guards legality, termination, deterministic behavior, and
obvious strategic regressions. It does not claim to measure human intelligence.
Family playtesting remains authoritative for whether the casual strategy feels
enjoyable, and later tuning must preserve these contracts.

Acceptance requires the complete project-local quality gate through Node
24.20.0 and pnpm 11.24.0. No dependency, generated output, private data, or
runtime network capability is added.

## Research provenance

The implementation is project-owned and derived from this specification and
tests. External work is reference-only:

- [`daimons/DouDiZhu-2`](https://github.com/daimons/DouDiZhu-2) motivates
  visible hand-strength and hand-burden features;
- [DouZero (ICML 2021)](https://proceedings.mlr.press/v139/zha21a.html)
  motivates role-aware fixed-deck evaluation and shows that strong Dou Dizhu
  play does not require runtime tree search; and
- [AP-MCTS (IJCAI 2021)](https://www.ijcai.org/proceedings/2021/470) shows that
  imperfect-information tree search depends on opponent-action modelling
  rather than simulation count alone.

No source, model, weights, assets, or generated data from those projects is
copied or distributed.

## Deferred difficulty work

This historical deferred direction is superseded by approved Spec 051. The
strategy introduced here remains byte-for-byte behaviorally authoritative for
the `默认` level and for immediate hint ranking. Spec 051 adds `休闲 / 默认 / 高手 /
大师` around it without changing this strategy.

## Non-goals

No game-tree search, MCTS, hidden-card inference, trained model, multiple
profiles, difficulty selector, random personality, UI, hint cycling state,
explanation strings, delay animation, timer, autoplay, persistence, scoring,
audio, dependency, or ADR replacement is included.
