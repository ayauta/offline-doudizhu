# Spec 063 实验记录（Gate B-S2：产品交付闭合）

协议见 [spec.md](spec.md)。状态：**PRODUCT RUNTIME NOT READY**。
日期：2026-09-21
前置：Gate B-S PASS（[shipped.md](shipped.md)）。

## 0. 结论先说

| 项 | 状态 |
| --- | --- |
| frozen model 真实资产交付 | ✅ packaged、编译进 worker、通过全部 build/Android/WebView 门禁 |
| packaged → source 行为等价 | ✅ `max |Δ| = 0`，selector 三类 divergence 全 0 |
| hidden-information boundary | ✅ 未变（feature 仍只吃 `PlayingPlayerView`） |
| fallback 路径 | ✅ 单元层穷举；worker 层「模型不可用即不装 overlay」 |
| production gates | ✅ `pnpm check` exit 0，Chromium 33 项通过 |
| **Worker end-to-end timing / cadence** | ❌ **未测量** |

**因此判定 `PRODUCT RUNTIME NOT READY`**——不是因为工程失败，而是因为 §6 要求的
真实 Worker 往返延迟、cadence miss、outer timeout、fallback count **本轮没有测**，
而 §11 的 PASS 明确要求「product timing 合格」。**不能声称没有测过的东西。**

## 1. Delivery

| | |
| --- | --- |
| 生成方式 | `scripts/cf-export-model.py` 从 `.local/cf-rows/model.txt` 转写 |
| packaged path | `src/app/ai/cf-model-data.ts`（生成物，勿手改） |
| packed source size | 507,588 B（一个 JSON 字符串字面量 + 两个常量） |
| worker asset | `dist/assets/ai-worker-*.js` **540,606 B raw / 122,713 B gzip** |
| source model SHA-256 | `010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359` |
| packaged SHA-256 | `CF_MODEL_SHA256` = 同上（构建时断言） |
| runtime-loaded SHA-256 | 同上（`tests/app/cf-model-packaging.test.ts` 断言） |
| threshold | `CF_SELECTOR_THRESHOLD = 0.01`，由 `threshold.json` 生成，**不是手打的** |

为什么是「打包成模块」而不是运行时取文件：`check-boundaries` 禁止 `src/` 出现任何
request API（`fetch`/XHR/WebSocket/…），AGENTS.md 也禁止运行时拉取远端资产。
Worker 因此无法自行读取静态文件，模型只能随包交付。

为什么是**一个 JSON 字符串字面量**而不是数字数组字面量：后者会让 `tsc` 每次门禁都
类型检查 9.4 万个数字。字符串是同一条 JSON，`parseTreeModel` 在加载时校验结构。

### 一处必须由 owner 确认的产品改动

`scripts/check-bundle.mjs` 有一条 **reviewed gzip budget**：enhanced AI worker 原为
**9,217 B**。加入模型后实测 **122,713 B**，超 113,496 B。

该预算的注释写明它的用途是「捕获在没人决定花这些字节的情况下膨胀的 payload」，
锚定公式是「baseline + 值得捕获的最小回归的三分之一」。本次膨胀是**一个决定要花的
artifact**（模型占 122,713 B 中的 113,496 B），不是漂移。ADR 0018 明确把历史上的
enhanced asset limits 替换为「evidence-based replacement」，并保留「现有可执行检查
直到实现与证据一起更新它们」。

因此我把预算按同一锚定公式更新为 **123,575 B**（122,713 + 2,587/3），
并在注释里写明：**若模型被 revert，这个上限应随之回到 9,217 B**。

**这是本轮唯一的、产品可见的规则改动。它需要 owner 确认。** 如果不接受，
模型必须换一种交付方式（例如按需分块加载），或者不交付。

## 2. Equivalence

| 检查 | 结果 |
| --- | --- |
| TS runtime vs LightGBM reference（21,066 rows） | `max |Δ| = 0.000e+0` |
| **packaged table vs source table** | `max |Δ| = 0.000e+0` |
| argmax divergence（11,999 roots × 6 thresholds） | **0** |
| override-decision divergence | **0** |
| selected-label divergence | **0** |
| corpus row 重生成逐字节相同（移动后） | ✅ 7,771,864 B 同 sha256 |
| packaged threshold == frozen threshold | ✅ 0.01 |

移动 `cfRow` / `cfProposal` / tree evaluator 进 `src/` 之后，**重新生成 calibration rows
得到逐字节相同的文件**（`405809617b63a9b9…`）。这是「移动是逐字搬迁」的直接证据，
不是论证。

## 3. 结构：现在只有一份实现

| 模块 | 位置 |
| --- | --- |
| Option-C feature schema | `src/core/ai/cf-features.ts` |
| tree table evaluator | `src/core/ai/cf-model.ts` |
| frozen selector + proposal | `src/app/ai/cf-selector.ts` |
| benchmark instrumentation | `benchmarks/cf-challenger.ts`（薄包装） |

`benchmarks/cf-dataset.ts` 与 `benchmarks/cf-model.ts` 现在**只做 re-export**。
语料、两个 benchmark、产品跑的是同一份代码——这是本轮真正的结构性收益。

## 4. Fallback

seam（`decideEnhancedAi`）已经 catch 一切异常并返回 production 命令；worker 层再往前
一步：`loadModel()` 的任何失败（JSON 解析、结构不合法、schema 不匹配、行宽不一致）
都得到 `null`，`null` 意味着**根本不安装 overlay**。因此：

* model asset missing / parse failure / malformed / schema mismatch → 不装 overlay → `a0`
* inference exception / feature error → seam 捕获 → `a0`
* non-farmer seat / 非 master 档 / bid 路径 → 不装或不触发 → `a0`

单元层穷举在 `tests/app/ai-decision-overlay.test.ts`；packaged 层的结构拒绝在
`tests/app/cf-model-packaging.test.ts`。

**未测**：worker cancellation、outer timeout pressure——它们要经真实 Worker 才能构造。

## 5. 未做的事（这就是 NOT READY 的原因）

* **Worker request→response 的 p50/p95/p99/max 未测。**
* **cadence miss / outer timeout / fallback count / worker cancellation 未测。**
* 因此 §15 的「是否出现 >480ms response」在 Worker 层面**没有答案**。

已有的、能说的：decision 层（handler 内，jobs=1，designed=false）master latency
p50 31.8 ms / p95 99.6 ms / max 171.1 ms，**0 个 decision 超过 480 ms**；
overlay 9.11 ms / eligible decision；真实 Worker 里模型能加载、能出招、整局能走完
（`pnpm check` 的 Chromium 新增用例）。这些**不等于** worker 往返延迟。

要做完这一步需要：在 Playwright 里对 worker 往返打点（需要一处测试专用的观测钩子，
或对 presentation beat 做外部观测），按 jobs=1 跑 baseline 与 challenger 两臂。
这是一块独立的工作，本轮没有把它做扎实，因此不声称通过。

## 6. 未触碰

* 未用 final validation `10001–10400`（仍 untouched）。
* 未改 model / threshold / features / selector semantics / candidate set /
  production policy / rollout / Gate B strength rules。
* `40001–41200` 保持 retired，本轮未用于任何参数选择。
* arm-A 的 `+0.028pp` 解释边界不变：**activation invariant = 0**（已由「把 overlay 装在
  地主座位上跑 12 局、decisions = 0」直接证明）与 **deadline execution reproducibility**
  是两件不同的事，后者存在极低率墙钟非确定性。
