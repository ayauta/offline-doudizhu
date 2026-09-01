# Spec 003: Canvas/Platform Vertical Slice (Historical)

> Historical record accepted on 2026-08-30. Superseded by spec 004 and ADR
> 0008; nothing in this file is a current platform instruction.

Status: Implemented; automated and playable acceptance passed  
Date: 2026-08-30

## Goal

Prove that pure core cards, application debug state, a project-owned Canvas UI,
touch input, the WeChat adapter, the build, and Node tests can cooperate without
implementing a Dou Dizhu game.

## Initial screen

On Mini Game startup in landscape orientation:

- fill the safe logical viewport with a deep green table;
- show a deterministic mock hand derived from the core deck;
- show large `不出`, `提示`, and `出牌` buttons;
- show `架构验证 · 非正式牌局` and a visible debug-state message;
- keep all cards upright and use text/suit glyphs instead of unlicensed art.

## Interaction

- A tap on a card toggles its selected state.
- A selected card moves upward and receives a high-contrast border.
- Hit testing checks overlapping cards from front to back and allows a small
  touch margin.
- A touch becomes a tap only when the matching touch ends within a short
  movement threshold.
- Each large button updates application-owned debug state and redraws.
- Buttons do not invoke bidding, hint, pass, play, AI, or rule logic.

## Boundaries

- UI uses project-owned drawing/touch interfaces and never calls `wx`.
- Only `platform/wechat` imports WeChat types or touches the global `wx` object.
- Device pixel ratio and a valid safe-area rectangle are normalized by the
  adapter; layout works in logical pixels.
- The composition root wires modules but contains no rules.
- No animation loop, network, storage, audio, account, ad, or analytics API is
  required.

## Automated acceptance

- Layout and hit testing have deterministic tests.
- Tap recognition rejects drags and mismatched touch IDs.
- Debug actions update debug state deterministically.
- A fake WeChat API test proves Canvas sizing, DPR scaling, touch mapping, and
  resize callbacks.
- A built-bundle smoke check proves startup, the initial draw, one card tap, and
  one debug-button tap using a controlled WeChat-compatible host.
- `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check` pass.
- The built bundle passes the privacy scan and contains no network capability.

## Playable acceptance

In WeChat Developer Tools and then on a phone:

- the Mini Game starts without runtime error;
- the viewport is landscape with a deep green table;
- 17 mock cards and all three buttons are readable;
- card selection/unselection works by touch;
- each button visibly changes debug state;
- safe-area and DPR behavior look correct.

## Playable evidence

Recorded: 2026-08-30

- WeChat Developer Tools Nightly `2.02.2608272` and the bundled official
  `wechatide` Skill `0.3.10` were used on Windows.
- The official simulator refresh and screenshot interfaces succeeded. A
  964-by-446 landscape capture showed the deep-green table, all 17 mock cards,
  and all three large buttons without safe-area clipping.
- Official Mini Game image-coordinate taps proved card selection and
  unselection (`已选 0 张` → `已选 1 张` → `已选 0 张`).
- Separate taps proved that `不出`, `提示`, and `出牌` each changed the visible
  application-owned debug state. The simulator was refreshed back to its
  initial state afterward.
- An exact console filter for the project path fragment `/game.js` returned no
  matches. A prior `WAGame.js` `jsbridge not ready` entry was caused by an
  inapplicable page-runtime diagnostic; the official automator instructions
  explicitly route Mini Games to Canvas coordinate actions instead.
- Official `auto_preview` succeeded, and the product owner confirmed on a real
  phone that landscape layout, safe areas, readability, card toggling, and all
  three debug-button state changes passed.

## Non-goals

No formal dealing, hand classification, legal move, hint algorithm, bidding,
turn rotation, landlord, AI, win state, scoring, save, rules viewer, production
art, or audio is part of this spec.
