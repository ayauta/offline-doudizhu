# Agent Instructions

## Project

This repository builds 单机斗地主 (`offline-doudizhu`): a standards-based,
offline PWA for one human and two local AI players. It is designed for older
family members and prioritizes readability, direct operation, correctness,
privacy, and maintainability. A future private Android package may wrap the
static Web output, but is not part of the current implementation.

## Hard constraints

- No backend, business API, login, account, ads, payment, analytics, telemetry,
  remote configuration, cloud service, or personal-data collection.
- Runtime application source must not use request APIs or remote assets. Only
  generated PWA installation/update code may retrieve reviewed fixed
  same-origin static build files.
- Never commit hosting credentials, signing keys, tokens, cookies, real names,
  private email addresses, phone numbers, device identifiers, or other PII.
- `src/core` is pure TypeScript: no DOM/browser APIs, storage, Node APIs,
  timers, wall-clock time, ambient randomness, UI, or platform imports.
- AI sees only a redacted `PlayerView`, returns normal engine commands, and
  never edits state directly.
- Do not add a framework or dependency without documenting purpose,
  alternatives, exact version, license, boundary, and maintenance cost.
- Do not overturn an Accepted ADR silently. Propose a replacement ADR first.

## Dependency direction

`cards <- rules <- game <- app <- ui/composition`, with
`ai -> game/rules/cards` and `platform/web -> app ports`.

The application session is authoritative. UI consumes read-only views and emits
intents. Browser storage, lifecycle, and service-worker APIs remain in
`src/platform/web`; `src/main.tsx` is the composition root.

## Required workflow

Before changing behavior, read:

1. `docs/product-spec.md`
2. `ARCHITECTURE.md`
3. relevant files under `docs/decisions/`
4. the active feature spec and execution plan

Use small changes following:

`spec -> tests -> implementation -> self-review -> browser/playable review -> commit`

Rules changes require table-driven tests first. Every bug gets a regression test
before its fix. UI changes require applicable Playwright acceptance and later
real-phone review; build success alone is not playable acceptance.

## Commands

The managed workspace includes the pinned Linux Node and pnpm toolchain under
the ignored `.local/` directory. In every fresh shell, activate it before any
`node`, `pnpm`, package-script, build, or test command, and keep activation and
the project command in the same shell:

```bash
source scripts/activate-toolchain.sh
pnpm check
```

The activation banner must report Node `v24.20.0` and pnpm `11.24.0`. When this
project-local toolchain is present, do not use a system Node/Corepack, Windows
PowerShell/Node, or download/install a replacement toolchain. If Playwright or
Vite cannot bind localhost because the execution sandbox returns `listen
EPERM`, rerun the same project-local Linux command with the required sandbox
permission; do not change toolchains.

- `pnpm dev` — start the Vite development server
- `pnpm build` — generate the static PWA in `dist/`
- `pnpm test` — run deterministic Vitest tests
- `pnpm test:browser` — run Playwright Chromium acceptance
- `pnpm typecheck` — run strict TypeScript checks
- `pnpm check:boundaries` — enforce module/platform boundaries
- `pnpm check:privacy` — scan source and output for forbidden capabilities
- `pnpm check` — run the complete local quality gate

## Definition of Done

A change is done only when its approved spec is satisfied, relevant deterministic
and browser tests exist, `pnpm check` passes, dependency/privacy impact is
reviewed, contract changes include documentation/ADR updates, applicable phone
checks are recorded, and no generated output, browser binary, private config,
secret, signing material, or PII is staged.
