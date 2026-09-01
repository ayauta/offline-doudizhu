# Open-Source Survey (Historical)

> Historical research for the retired platform. It is retained for provenance,
> not as a current dependency or implementation recommendation.

Status: Approved by product owner  
Review date: 2026-08-30  
Scope: offline, native WeChat Mini Game, Canvas 2D, TypeScript, one human and
two local AI players

## 1. Decision summary

The recommended strategy is deliberately conservative:

1. Reuse only the official `minigame-api-typings` package, pinned as a
   development dependency when the toolchain is created.
2. Write the game rules, move generator, state machine, hint system, and
   first-version AI in this repository from a project-owned specification and
   tests.
3. Use selected projects only to discover design boundaries, invariants, test
   cases, and failure modes. Do not translate or copy their implementation.
4. Do not use code or assets without a clear compatible license. Do not use
   networked, account-based, server-based, LLM-based, or model-heavy features.
5. Recheck the exact version, commit, license, transitive dependencies, and
   security state immediately before any future import.

No third-party code, package, model, sound, image, or font was copied or
installed during this survey.

### Evaluation

- **Why do this:** Dou Dizhu has many rule edge cases, and WeChat Mini Game has
  a non-browser runtime. Prior work can expose cases and boundaries that are
  easy to miss.
- **If we skip it:** we are more likely to invent an incomplete rule model,
  couple AI to UI, or choose an obsolete Mini Game setup. License provenance
  may also become impossible to reconstruct later.
- **Benefit:** better test coverage and architecture decisions without
  inheriting unrelated product scope.
- **Cost and risk:** research takes time and reference material can bias our
  design toward another project's rule interpretation. We control that risk by
  making our specification authoritative and avoiding code translation.
- **Worth it:** yes. The survey is valuable now, before module boundaries are
  approved. Direct gameplay-code reuse is not worth its semantic and
  provenance cost for this small product.

## 2. Classification rules

### CAN REUSE

A package may be proposed for installation or direct integration. Approval of
this document makes it an allowed candidate; it does not install it. The exact
version and lockfile change still belong to the implementation gate.

### REFERENCE ONLY

We may read public documentation, APIs, tests, issue discussions, and high-level
designs to learn concepts and identify cases. We must not copy, mechanically
translate, or closely reproduce source code, generated tables, model weights,
or assets.

### DO NOT USE

Do not copy, install, bundle, translate, or derive code or assets from the
project. Public algorithms described in independent academic literature may be
evaluated separately in the future, but that is not permission to use the
repository.

## 3. CAN REUSE

### 3.1 WeChat Mini Game API typings

- **Project:**
  [`wechat-miniprogram/minigame-api-typings`](https://github.com/wechat-miniprogram/minigame-api-typings)
- **Purpose and technology:** official TypeScript declaration files for the
  `wx` Mini Game APIs; development-time types only.
- **License:**
  [MIT](https://github.com/wechat-miniprogram/minigame-api-typings/blob/master/LICENSE).
- **Maintenance snapshot:** official WeChat organization, 91 commits and an
  active issue/PR queue at review time. The declarations are generated from
  WeChat documentation and the repository contains `tsd` tests.
- **Useful parts:** accurate global API names, callback shapes, Canvas creation,
  touch events, storage, audio, and device information used by the adapter
  layer.
- **Unwanted parts:** declarations for many APIs the product forbids, including
  network, login, ads, social, payment, and analytics-adjacent capabilities.
  Their presence in types must not be mistaken for product permission.
- **Risks:** type definitions can lag behind or contain errors. They cannot
  replace verification of critical runtime behavior in WeChat Developer Tools
  and on a phone.
- **Proposed reuse:** pin one reviewed version as a `devDependency`; reference
  it through `tsconfig`; do not copy its `.d.ts` files into our source tree.
- **Obligations:** retain the package's MIT license through normal dependency
  distribution and notices. Record the pinned version and source in the
  lockfile/dependency inventory.
- **Value assessment:** high benefit, low runtime cost, low coupling. **Worth
  doing at the toolchain implementation gate, not before.**

## 4. REFERENCE ONLY

### 4.1 Browser Dou Dizhu with shared move generation

- **Project:**
  [`DavidWang1231/doudizhu-online`](https://github.com/DavidWang1231/doudizhu-online)
- **Purpose and technology:** static JavaScript browser game with local AI and
  optional PeerJS/WebRTC multiplayer.
- **License:**
  [MIT](https://github.com/DavidWang1231/doudizhu-online/blob/main/LICENSE).
- **Maintenance snapshot:** small, recent repository with 25 commits and no
  stable release history visible at review time.
- **Architecture:** card and combination utilities, legal move generation,
  heuristic AI, game orchestration, UI, networking, and localization are split
  into separate modules. Hints and AI share legal move generation.
- **Test evidence:** Node-based engine tests plus automated AI-versus-AI
  simulations; the README reports 120 simulations per supported mode, 720 in
  total.
- **Useful references:** one legal-action source for both hints and AI; keeping
  rendering outside the rule engine; full-game simulations; edge cases around
  repeated ranks and compound hands.
- **Unwanted parts:** WebRTC/broker/STUN/TURN networking, rooms, chat, multiple
  variants, wildcards, two-player mode, doubling, scores, spring multipliers,
  and accumulated points.
- **Why not reuse code:** plain JavaScript, direct `Math.random()` use, different
  bidding/scoring rules, variant branches inside core logic, and a small
  maintenance base. Extracting selected functions would cost more verification
  than implementing our narrower typed specification.
- **Value assessment:** strong design and test reference; medium semantic-drift
  risk. **Worth referencing, not worth importing.**

### 4.2 Combinatorial rule engine

- **Project:**
  [`onestraw/doudizhu`](https://github.com/onestraw/doudizhu)
- **Purpose and technology:** Python package for hand classification,
  comparison, dealing, and enumeration of stronger plays.
- **License:**
  [MIT](https://github.com/onestraw/doudizhu/blob/master/LICENSE).
- **Maintenance snapshot:** 18 commits; the latest PyPI release shown is
  `0.1.5`, published in April 2018. It is useful but inactive.
- **Architecture:** it enumerates 37 detailed patterns into a
  rank/order/suit-independent dictionary of 34,152 entries for constant-time
  validation and comparison.
- **Test evidence:** dedicated card, rule, and game tests are present.
- **Useful references:** mathematical invariants, suit independence, ambiguous
  interpretations of the same cards, exhaustive pattern accounting, and
  boundary test vectors.
- **Unwanted parts:** Python runtime and a generated lookup-table strategy that
  may be harder to audit and unnecessary for a 54-card casual game.
- **Why not reuse code/data:** translating Python or reproducing the generated
  table would create derived-code/provenance questions and lock us to its rule
  interpretation. Our product still needs readable TypeScript predicates and
  table-driven tests based on our own rule spec.
- **Value assessment:** high rules-research value, low implementation fit.
  **Worth using to challenge our tests only.**

### 4.3 RLCard Dou Dizhu environment

- **Project:**
  [`datamllab/rlcard`](https://github.com/datamllab/rlcard)
- **Purpose and technology:** Python toolkit providing card-game environments
  for reinforcement-learning research, including Dou Dizhu.
- **License:**
  [MIT](https://github.com/datamllab/rlcard/blob/master/LICENSE).
- **Maintenance snapshot:** established multi-game project with hundreds of
  commits, substantial community use, tests, and continuing issue/PR activity;
  core-main activity is less frequent than the issue stream.
- **Architecture:** dealer, round, player, judger, game, utilities, environment,
  legal actions, and observation encoding are separated. Dou Dizhu exposes a
  very large complete action space (documented as 27,472 actions).
- **Test evidence:** game and judger tests exist alongside cross-game tests.
- **Useful references:** information-set boundaries, immutable observations for
  agents, legal-action APIs, recorded action traces, deterministic environment
  reset, and keeping an AI replaceable behind an agent interface.
- **Unwanted parts:** Python, NumPy/RL framework integration, precomputed action
  data, training environments, evaluation tooling, and a landlord selection
  strategy that does not match our explicit `叫地主 / 不叫` flow.
- **Risks:** research encodings optimize training rather than human-readable
  domain logic; open bug discussions show that observation fields require
  careful independent validation.
- **Value assessment:** excellent boundary reference, excessive implementation
  weight. **Worth referencing for the AI interface, not importing.**

### 4.4 DouZero

- **Project:** [`kwai/DouZero`](https://github.com/kwai/DouZero)
- **Research paper:**
  [DouZero: Mastering DouDizhu with Self-Play Deep Reinforcement Learning](https://proceedings.mlr.press/v139/zha21a.html),
  ICML 2021.
- **Purpose and technology:** Python/PyTorch self-play deep-RL system with
  role-specific agents and pretrained models.
- **License:**
  [Apache-2.0](https://github.com/kwai/DouZero/blob/main/LICENSE).
- **Maintenance snapshot:** mature research repository with hundreds of commits
  and a large user community; the main code line is not a fast-moving product
  SDK.
- **Architecture:** environment, game state, move detection/generation,
  selection utilities, actors, learners, evaluation, and role-specific model
  checkpoints.
- **Test evidence:** no conventional unit-test suite was found in the reviewed
  repository tree; research evaluation is reported by the paper and scripts.
- **Useful references:** a clean legal-action boundary, role-specific agent
  replacement, repeatable AI evaluation, and the difference between public game
  history and a player's private hand.
- **Unwanted parts:** PyTorch, model weights, training pipelines, multiprocessing,
  GPU-oriented workflows, and opaque decision-making. The paper reports a
  substantial training setup, far beyond a small offline phone game.
- **Value assessment:** useful only for a future advanced-AI roadmap. **Not
  worth integrating in Phase 1 or the first playable release.**

### 4.5 Official lightweight Canvas engine

- **Project:**
  [`wechat-miniprogram/minigame-canvas-engine`](https://github.com/wechat-miniprogram/minigame-canvas-engine)
- **Purpose and technology:** official lightweight Canvas 2D layout/rendering
  engine, largely aimed at simple Canvas applications and open-data-domain UI.
- **License:**
  [MIT](https://github.com/wechat-miniprogram/minigame-canvas-engine/blob/master/LICENSE).
- **Maintenance snapshot:** 505 commits, tests, documentation, and maintenance
  activity in the official WeChat organization at review time.
- **Useful references:** device-pixel-ratio handling, tree layout, hit testing,
  text measurement, clipping, and separation of layout from drawing.
- **Unwanted parts:** a declarative layout runtime and engine-specific concepts
  that would become another production abstraction to learn and maintain.
- **Why not reuse now:** the first screen is one fixed landscape game table with
  a small number of controls. A thin project-owned renderer is easier to audit
  and can be replaced later behind a rendering boundary.
- **Value assessment:** credible reference, but current integration value is
  lower than its coupling cost. **Reconsider only if measured UI complexity
  outgrows our renderer.**

## 5. DO NOT USE

### 5.1 Old TypeScript/Webpack Mini Game template

- **Project:**
  [`theajack/wx-minigame-ts`](https://github.com/theajack/wx-minigame-ts)
- **Snapshot:** seven commits and no repository-level license exposed in the
  reviewed tree. Its documented stack includes TypeScript 3.7, Webpack 4,
  deprecated ESLint/Babel plugins, browser/DOM types, and a copied `wx.d.ts`.
- **Potential idea:** a minimal `game.js` entry that loads a generated bundle.
- **Why not use:** unclear reuse rights, obsolete dependencies, incorrect DOM
  assumptions for a Mini Game, and unnecessary toolchain surface. Official
  typings and a current minimal build solve the legitimate need more safely.
- **Value assessment:** high modernization cost and no unique benefit. **Not
  worth using.**

### 5.2 C/WebAssembly browser game with LLM integration

- **Project:**
  [`tian11111/doudizhu`](https://github.com/tian11111/doudizhu)
- **Snapshot:** 44 commits and visible activity in 2026, but no license file was
  present in the reviewed root. The project combines native web UI, a C/Wasm
  core, local difficulty modes, LLM API configuration, sounds, and card images.
- **Potential ideas:** local difficulty settings and a replaceable decision
  engine.
- **Why not use:** absent license means code and assets are not safely reusable;
  asset provenance is unverified. C/Wasm, API keys, external model calls,
  scores, and a monolithic web page all conflict with this product's scope and
  maintainability goals.
- **Value assessment:** some visible product ideas, but severe license and scope
  risk. **Do not copy code or assets.**

### 5.3 React/Vite/Gemini training simulator

- **Project:**
  [`AAsteria/Dou-Dizhu-Master`](https://github.com/AAsteria/Dou-Dizhu-Master)
- **Snapshot:** small 17-commit React/TypeScript project generated from a Google
  AI Studio template. The root tree does not expose a license or test suite,
  and local use requires a Gemini API key.
- **Potential ideas:** rule explanations, card-counting education, and post-play
  reasoning.
- **Why not use:** no verified license, mandatory network/API credentials,
  React/DOM architecture instead of native Mini Game Canvas, and AI-generated
  explanations that cannot guarantee offline deterministic behavior.
- **Value assessment:** conflicts with core privacy and offline constraints.
  **Do not use.**

### 5.4 Server-backed Phaser implementation

- **Project:** [`svzdev/doudizhu`](https://github.com/svzdev/doudizhu)
- **Snapshot:** older, larger repository with 277 commits; Python/Tornado/MySQL
  server plus Phaser client. No license file is exposed in the reviewed root.
- **Potential ideas:** separation between client and authoritative game server.
- **Why not use:** no clear license, mandatory backend/database, networked
  multiplayer architecture, and a substantial Phaser runtime. Its central
  design problem is absent from our local-only game.
- **Value assessment:** almost entirely irrelevant coupling. **Do not use.**

### 5.5 DanLM / DouLM repository

- **Project:** [`dashidhy/DanLM`](https://github.com/dashidhy/DanLM)
- **Purpose and technology:** experimental self-play RL and causal sequence
  modeling for GuanDan and Dou Dizhu.
- **License risk:** the repository appends a non-commercial Section 10 to the
  Apache-2.0 text. It is therefore not the standard Apache-2.0 license and is
  incompatible with our simple permissive reuse policy without separate legal
  review and permission.
- **Quality risk:** the authors explicitly warn that the project was almost
  entirely produced through AI-assisted “vibe coding” and may contain critical
  bugs or inaccuracies.
- **Why not use:** custom restrictions, experimental quality, training and model
  complexity, and no value for the first-version casual heuristic AI.
- **Value assessment:** high legal and engineering uncertainty. **Do not use
  repository code or weights.** Any future interest in the research idea must
  begin from independently published literature and a new approval.

## 6. License and provenance policy

This is an engineering policy, not legal advice.

1. **No license means no reuse.** Public visibility on GitHub is not a grant to
   copy, modify, or distribute code or assets.
2. **MIT dependencies or copied code require preservation of their copyright
   and license notice.** If direct source reuse is ever proposed, record the
   exact files and commit before copying.
3. **Apache-2.0 reuse requires its license and applicable notices, retention of
   attribution notices, and prominent change notices for modified files.**
4. **A familiar license name plus extra restrictions is a custom license.** It
   must not be treated as standard MIT or Apache-2.0.
5. **Code and assets are reviewed separately.** A repository license may not
   cover third-party card art, fonts, sound effects, datasets, or model weights.
6. **Reference-only work leaves an audit trail.** Architecture decisions and
   tests should cite the idea or edge case while the resulting implementation
   remains independently written from our own specification.
7. **No GPL/AGPL or unclear terms by default.** Any exception needs a separate
   product-owner decision and legal compatibility review before access or use.

## 7. Proposed approved reuse strategy

If this survey is approved:

- `minigame-api-typings` becomes the only pre-approved third-party package
  candidate from this survey. It may be added later as a pinned development
  dependency.
- The five projects under **REFERENCE ONLY** may inform architecture and test
  planning, with citations, but no code/data/assets may be copied or translated.
- The five projects under **DO NOT USE** are excluded from source, dependency,
  model, and asset reuse.
- All gameplay code remains project-owned and is driven by the approved product
  spec plus a dedicated rule specification and table-driven tests.
- Any additional dependency or any change from reference-only to direct reuse
  requires a new written assessment: purpose, source, exact version/commit,
  license, maintenance, unwanted features, alternatives, obligations, and an
  explicit product-owner approval.

This strategy gives us the useful part of open source—known boundaries and test
ideas—without making a small family game dependent on somebody else's variants,
servers, models, assets, or maintenance choices.
