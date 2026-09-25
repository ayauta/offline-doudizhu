# Spec 063 实验记录（Gate B-S2：产品交付闭合）

协议见 [spec.md](spec.md)。状态：**GATE B-S2 PASS**。
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
| **Worker end-to-end timing / cadence** | ✅ 已测（见 §6） |

**判定 `GATE B-S2 PASS`**——§9 的十条全部满足（见 §6）。

> 上一版曾判 NOT READY，唯一原因是当时真实 Worker 往返延迟尚未测量。本轮补测后通过。

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

### 产品资产预算变更（owner 已批准，2026-09-21）

`scripts/check-bundle.mjs` 有一条 **reviewed gzip budget**：enhanced AI worker 原为
**9,217 B**。加入模型后实测 **122,713 B**，超 113,496 B。

该预算的注释写明它的用途是「捕获在没人决定花这些字节的情况下膨胀的 payload」，
锚定公式是「baseline + 值得捕获的最小回归的三分之一」。本次膨胀是**一个决定要花的
artifact**（模型占 122,713 B 中的 113,496 B），不是漂移。ADR 0018 明确把历史上的
enhanced asset limits 替换为「evidence-based replacement」，并保留「现有可执行检查
直到实现与证据一起更新它们」。

因此我把预算按同一锚定公式更新为 **123,575 B**（122,713 + 2,587/3），
并在注释里写明：**若模型被 revert，这个上限应随之回到 9,217 B**。

**这是本轮唯一的、产品可见的规则改动。已获 owner 批准。**

| | |
| --- | ---: |
| pre-model anchor（旧上限） | 9,217 B |
| frozen model 贡献 | ≈ 113,496 B |
| current shipped bundle | 122,713 B |
| **approved limit** | **123,575 B** |

**若未来整体 revert Phase 2，worker gzip bundle limit 必须随之恢复到旧 anchor 9,217 B。**

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

## 5. 真实 Worker 往返测量

`e2e/ai-worker-timing.spec.ts`，`AI_CF_TIMING=1` 时启用，默认 skip。
**Chromium production build，jobs=1，真实 Worker，两臂各自 18/7 副真实对局。**

插桩**完全在应用之外**：在应用代码加载前把页面里的 `Worker` 换成子类，
记录 `postMessage` 与配对的 `message` 事件时间戳。`src/` 里**没有任何测试钩子**，
因此不存在「插桩 on/off 行为是否一致」的问题——没有东西可关。

### 激活验证（不是假设）

基线臂 `flagged 0`，挑战臂 `flagged 145/145`。请求数 372 → 401（18 副）
与 129 → 145（7 副）：selector 确实改变了出牌，游戏因此不同。

### Warm request→response

| | N | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 372 | 26.0 ms | 83.6 ms | 115.7 ms | 122.4 ms |
| challenger | 401 | 24.5 ms | 70.9 ms | 105.7 ms | 134.6 ms |

**受控对比**（只取「master 决策 + 农民座位」，两臂同口径）：

| | N | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: |
| baseline | 129 | 24.3 ms | 80.7 ms | 113.8 ms |
| challenger | 145 | 26.1 ms | 68.6 ms | 115.5 ms |
| Δ | | **+1.8 ms** | −12.1 ms | +1.7 ms |

**一个我没有解释清楚的观测**：benchmark 里 overlay 自身耗时 9.11 ms，
这里受控 p50 只涨 1.8 ms。两者口径不同（前者是 overlay 内部计时，后者是端到端
墙钟差），但这个差距**我没有在这次预算内查清**，因此如实记录为未解释，
而不是编一个说法。它不影响任何一条 PASS 判据。

### Cold

N = **6** 次独立页面加载（每次全新浏览器进程）：

| | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| worker created → first valid AI response | 43.6 ms | 47.2 ms | 47.2 ms |

样本 `[42.1, 46.5, 43.6, 42.0, 39.8, 47.2]` ms；worker 创建发生在页面加载后
317–336 ms。**应用没有 ready 信号**，所以「creation → ready」不可单独观测，
只能报 creation → 首个有效响应。

### 失败计数（两臂全为 0）

| | baseline | challenger |
| --- | ---: | ---: |
| responses > 480 ms | **0** | **0** |
| responses > 520 ms（beat） | 0 | 0 |
| outer timeout（`ok:false`） | **0** | **0** |
| fallback | 0 | 0 |
| worker cancellation（发出未回） | **0** | **0** |
| malformed / empty response | **0** | **0** |

### 内部 deadline / overlay 分阶段

master cutoff rate 与 overlay 分阶段计时**无法从 Worker 外部观测**（那需要生产侧钩子）。
它们来自 Gate B-S 的同一 shipped handler、同一 120 ms 预算：cutoff **0.8% → 0.9%**，
overlay 9.11 ms / eligible decision（proposal 8.927 + feature 0.105 + inference 0.078）。

## 6. 未触碰

* 未用 final validation `10001–10400`（仍 untouched）。
* 未改 model / threshold / features / selector semantics / candidate set /
  production policy / rollout / Gate B strength rules。
* `40001–41200` 保持 retired，本轮未用于任何参数选择。
* arm-A 的 `+0.028pp` 解释边界不变：**activation invariant = 0**（已由「把 overlay 装在
  地主座位上跑 12 局、decisions = 0」直接证明）与 **deadline execution reproducibility**
  是两件不同的事，后者存在极低率墙钟非确定性。
