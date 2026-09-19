# Spec 060：终局证据门控（H5 v1，E5）

状态：**机制与 W_gate 已冻结**（见下）；实现门禁已通过；E5-A 已跑并判定 **REVERT**
（见 [experiment.md](experiment.md)）。
日期：2026-09-19
前置：E1（057）、E3（058）、E4（059）均已 REVERT；E0 并行 runner（`5d1091e`）是基础设施。
机制的全部诊断与冻结过程见 [H5 诊断与冻结](../research/h5-terminal-evidence.md)——
本文只登记**协议**，不重述诊断。

## 假设

> **H5：只有高置信 terminal evidence 应获得更高的 rollout influence。**
> 普通 rollout 仍保持生产权重 `0.2`；当一个候选的终局轨迹对 root 阵营给出同向结论时，
> 它的 **terminal component** 按原始设计尺度（`W_gate = 1.0`）进入评分。

措辞纪律：H5 不是「rollout 权重更大更好」。历史已否决过整体放大（0.2 → 2.0 使大师对
高手 53.2% 掉到 48.9%）。H5 只放大**被终局证据支持的那一个分量**。

## 冻结一：confidence gate（二值）

```
hasConfidentTerminalEvidence(candidate)
  ⟺ terminalCount >= 1
     且 所有 terminal trajectory 从 root 阵营视角看结果同向（全胜 或 全负）
```

返回 false：0 条 terminal；win/loss conflicting；无法明确归属 root 阵营的异常状态。

**「同向」只能站在 root 阵营视角定义**（地主阵营 vs 农民阵营），不能写成「当前 seat
赢/输」——斗地主有两个阵营，视角一混，农民位的符号会直接反掉。

不要求 `terminalCount >= 2`：那会引入一个没有机制必然性的计数阈值。排除 conflicting
的理由是机制性的（不同 sampled world 给出相反答案 = 不确定性仍高），不依赖任何阈值。

## 冻结二：component-wise 增量式

```
terminalComponent    = sum(terminal utilities)     / totalWorldCount
nonTerminalComponent = sum(non-terminal utilities) / totalWorldCount

无高置信终局证据： 0.2 × mean(all)                          ← 与生产逐位相同
有高置信终局证据： 0.2 × mean(all) + (W_gate − 0.2) × terminalComponent
```

- 分母始终是**全部 worlds 数**（生产实现里即 `completedWorlds`）。
- **必须增量式**，不得写成 `W_gate×T + 0.2×N`：两者数学等价但浮点不等价，分量式会让
  恒等测试被迫放宽成容差比较，丢掉真正的保护。增量式在 `W_gate = 0.2` 时增量恰好为 `0`。
- estimator 不变；sampling 不变；non-terminal 信息永远维持 `0.2`；conflicting 不触发；
  同向胜/负对称（全负 → 负项被放大，该候选被更强地压低）。

## 冻结三：W_gate = 1.0

语义是**取消对 terminal utility 的 0.2 shrinkage**，让它按原始设计尺度完整进入评分。
它不是根据 historical 胜率调出来的参数，也不由 gap 分位数、override 数量拟合。

**禁止**试 0.4 / 0.5 / 0.8 / 1.2 / 2.0，禁止按 gap 或 terminalCount 调权重。
E5 只有这一种机制、这一个数值。

## 冻结项

| 冻结项 | 说明 |
| --- | --- |
| candidate generation | 仍是 `expert.slice(0, 3)`，不碰 |
| `defaultPolicyPrior` / expert score / `rootUtility` 其余部分 | 不碰 |
| world sampling / rollout policy / `maxWorlds=8` / `rolloutDepth=3` / `rootAnalyzerNodes=220` / rollout 的 `analyzerNodes: 8` | 不碰 |
| bidding / 默认档 / 休闲档 | 不碰 |
| worker / deadline / hand-turn evaluator / opponent modelling | 不碰 |
| 性能 | 不做顺手优化 |

## 实现门禁（先于 E5-A，必须全绿）

| 门禁 | 内容 |
| --- | --- |
| **恒等** | `W_gate = 0.2` 时每个 candidate final score **逐位**等于生产、root ordering 逐位相同、出货路径 command 逐位相同 |
| **0 terminal** | 完全等于 baseline |
| **conflicting** | 完全等于 baseline（含终局效用不抵消的 conflicting） |
| **unanimous win** | 只增加 terminal 正贡献 |
| **unanimous loss** | 只增加 terminal 负贡献 |
| **non-terminal** | gate 前后保持生产 `0.2`，不得被放大 |
| **阵营符号** | 地主 root / 农民 root / 不同 rollout seat 下，terminal win/loss 始终从 root 阵营视角一致 |

载体与实跑证据见 [experiment.md](experiment.md) 的「实现门禁」一节。

## E5-A / E5-B

- **E5-A**：designed / 无 deadline、**Discovery V3 `30001–30400`**、400 副、jobs=8。
  **两臂都要重新跑**（V3 是新池，没有任何历史 baseline 可复用）：
  baseline = 当前生产高手算法；challenger = H5 v1。逐副 paired comparison。
- **E5-B**：仅在 E5-A 通过后跑，shipped 120ms 预算，实测成本。
- KEEP 前仍需未消耗的 `10001–10400` 独立复核。

## 判据（E5-A 必须同时满足）

1. `paired Δ > 0`
2. `95% CI 下界 > 0`
3. `paired Δ ≥ 1.0pp`（SESOI）
4. 复杂度与性能合理

否则：**REVERT H5，关闭该实验。** 显著性只由实跑出来的 paired 95% CI 判断。

## 报告要求

**Primary**：baseline / challenger 胜率、paired Δ、paired 95% CI、地主 / 农民分角色、
逐副好 / 差 / 平转移。

**Diagnostics**（不得替代棋力结论）：confidence gate 触发的决策数与比例、gated candidate
数、root command divergence、unanimous-win / unanimous-loss / conflicting 分布、gate 导致
的最终 action change 数、wall-clock。

## 禁止（看到 E5-A 结果之后）

- 不得改 `W_gate`；不得加 `terminalCount` 阈值；不得改成 terminal-only mean；
- 不得改成 lexicographic terminal override；不得调 `defaultPolicyPrior`；不得加深搜索。

以上每一项都是**新的独立假设**，必须新实验编号、新 spec、新 discovery pool。

## Discovery pool 暴露计数

| 实验 | 使用 `30001–30400`（V3） |
| --- | --- |
| **E5（本 spec）** | **1**（首次消耗） |

`301–700`（V1 = 2 次）与 `20001–20400`（V2 = 1 次）已退休，本实验不使用。
`5001–5400` 只用于 mechanical preflight（门禁、corpus 回放）。
`10001–10400` 保持未消耗。

## 产出

- 本 spec（实现前冻结）
- `experiment.md`（门禁证据、E5-A 结果、KEEP / REVERT 与理由）
- 若 KEEP：E5-B、validation 复核记录、以及写进 `ENHANCED_AI_SEARCH` 的冻结值
