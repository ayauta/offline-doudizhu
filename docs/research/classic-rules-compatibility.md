# Classic Hand-Pattern Compatibility Research

Status: Reviewed for spec 010

Date: 2026-09-02

## Purpose

Resolve the hand-pattern boundaries that public player rules and mature open
source implementations describe differently. This document is research input;
the product specification and project-owned table-driven tests remain
normative.

No third-party source code, generated move table, action list, or data file is
copied into this repository.

## Sources reviewed

- 欢乐斗地主玩家规则：<https://u.360.cn/qqhlddz/article/11482>
- JJ 斗地主玩家规则：<https://www.jj.cn/news/320/20110920103700018196.shtml>
- 一起游戏经典斗地主帮助：<https://www.yiqihuiyou.com/index/help/game/key/doudizhu>
- RLCard game/action-space documentation:
  <https://github.com/datamllab/rlcard/blob/master/docs/games.md>
- DouZero move detector:
  <https://github.com/kwai/DouZero/blob/main/douzero/env/move_detector.py>
- DouZero move generator:
  <https://github.com/kwai/DouZero/blob/main/douzero/env/move_generator.py>

The player-facing sources establish the familiar 14-pattern vocabulary and
bomb/rocket precedence. RLCard and DouZero are useful cross-checks for machine
representations and rare shapes, but their training/action-space compatibility
needs are not automatically product rules.

## Compatibility findings

| Boundary | Player-rule expectation / reference behavior | Project decision |
| --- | --- | --- |
| Airplane single wings | Descriptions commonly say one single per core triple; machine action spaces may accept rare decompositions such as `333444555777`. | A pair may supply two single wings, with at most two attachments of one rank. A triple or bomb may not be split. Therefore `33344455` is valid and `333444555777` is invalid. |
| Airplane pair wings | Wings are matching pairs. Some detectors infer shapes from counts rather than state an attachment policy. | Every wing is a distinct rank occurring exactly twice. A four-of-a-kind cannot become two pairs. |
| Four with two cards | Public rules permit two single cards; practical play often treats a pair as two cards. | The two attachments may be two different singles or exactly one pair. |
| Four with two pairs | Public descriptions require two pairs. | The pairs must have two different ranks; another bomb cannot be split into two pairs. |
| Jokers as attachments | Classic help distinguishes individual jokers from the two-joker rocket. | `2` and one joker may be attachments. Small and big joker together may not both be attachments, so the rocket cannot be split. |
| Sequence cores | Public rules consistently exclude `2` and jokers. | Straights, consecutive pairs, and airplane cores end at ace. |
| Ambiguous interpretation | Training environments may preserve broad action compatibility. | Prefer one explainable classification fixed by explicit histogram predicates and tests. Do not guess the player's intended alternate shape. |

## Engineering consequences

- Recognition uses rank-count histograms and explicit predicates, not action
  enumeration or a generated lookup table.
- Suits and input order never affect the pattern.
- Attachments cannot reuse a core rank.
- Classification has one deterministic result or one structured error.
- Compatibility changes require a new spec decision and regression tests; an
  upstream RLCard or DouZero change does not silently change this project.

## Licensing boundary

The reviewed player pages and repositories are references only. The
implementation and tests are original project work based on public game
concepts. No textual rule section, code, action table, or dataset is reproduced.
