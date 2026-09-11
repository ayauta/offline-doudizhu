# Execution Plan 019: Rule-Based AI Difficulty

Status: Completed

Started: 2026-09-11

Completed: 2026-09-11

Spec: `docs/specs/051-ai-difficulty/spec.md`

## Goal

Add the approved `休闲 / 默认 / 高手 / 大师` opponent choices, independently
versioned settings, bounded worker execution, and fast evaluation coverage while
preserving the current production AI and hint behavior as exact default paths.

## Steps

1. [x] Recheck product/architecture constraints, ADRs 0005/0006/0008/0010/
   0011, Specs 030/031/040, actual AI/rules/session/UI seams, and clean Git
   scope; record replacement ADRs 0015/0016 and approved Spec 051.
2. [x] Add deterministic tests for settings decoding/storage, default identity,
   enhanced scoring/hand analysis, Master public-information sampling, worker
   request handling, and session async/fallback behavior.
3. [x] Implement pure hand analyzer/state evaluator/policies and bounded Master
   sampling without changing the existing production strategy.
4. [x] Implement the app AI port/handler, single Web Worker client, deadline/
   fallback integration, malformed-message defense, and one-time notice.
5. [x] Implement independent settings persistence and the approved home sheet
   with large targets, checkmark state, dynamic description, immediate press
   response, and reduced motion.
6. [x] Add Playwright coverage, a separate fast benchmark, worker build/precache
   checks, and Android source/static-delivery checks.
7. [x] Run focused tests, complete `pnpm check`, extended evaluation, visual
   review, self-review, documentation updates, and final privacy inspection.

## Completion evidence

- `DEFAULT_AI_STRATEGY` is the exact existing `CASUAL_AI_STRATEGY` object; the
  original implementation is unchanged. The default session and hint paths do
  not invoke the worker.
- All three enhanced handlers return legal commands, and deterministic complete
  games for Casual, Expert, and Master terminate below the 256-command guard.
- Settings tests cover save/reload, corrupt and unknown values, additive fields,
  future schemas, and storage exceptions. Browser acceptance covers selection,
  persistence, match locking, and immediate pointer-down feedback.
- One local AI worker asset is emitted and included by the complete PWA precache.
  The embedded entry starts without registering the PWA service worker. Android
  source checks confirm the same packaged static tree, DOM storage, zero
  permissions, hardened local asset loading, and no native bridge.
- The opt-in role-balanced run with 10 fixed deals per role pairing reported:
  `默认 vs 休闲 33/60`, `高手 vs 默认 31/60`, and `大师 vs 高手 33/60`.
  These are tuning evidence, not a guarantee for any deal.
- In that run, median/P95/max decision times were `0.08/0.39/1.84 ms` for
  Casual, `0.05/0.30/3.32 ms` for Default, `0.22/5.30/28.79 ms` for Expert,
  and `6.93/28.63/50.64 ms` for Master. Enhanced work is off the main thread.
- `pnpm check` passed 249 deterministic tests, the production build and local
  precache check, Android source delivery, architecture/privacy checks, and 26
  Chromium scenarios. Reviewed screenshots cover 640×340 and 1366×768.
- A fresh APK assembly was attempted but this machine has no Linux or Windows
  JDK configured. No APK/emulator/physical-device result is claimed for this
  change; release automation remains the authoritative Android artifact gate.
- No dependency, network capability, private data, generated output, or Android
  permission was added to tracked scope.

## Recovery

All changes are version-controlled text. The persisted setting is additive and
defaults to the old behavior. Removing the new composition wiring restores the
previous runtime; an unknown/future settings document is never overwritten.
No destructive file operation, credential, remote mutation, or dependency
installation was part of this plan.
