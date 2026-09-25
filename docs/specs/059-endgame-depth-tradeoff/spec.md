# Spec 059：残局定向搜索（H4）

状态：协议已登记并冻结；门槛与结构已按事先冻结的规则由数据选定；preflight 已通过；
**E4-A 尚未运行**。
日期：2026-09-19
前置：E1（057）与 E3（058）均已 REVERT；基础设施 `5d1091e`（E0）。

## 假设

> **H4：当 `min(三家剩余牌数) <= 2` 时，在保持 root-level structural search budget
> 不变的前提下，把一部分 world 广度换成 rollout 深度，使更多搜索真正到达终局，
> 能提升高手档棋力。**

措辞纪律：本文**不写**「残局才是高杠杆」。历史诊断**提示**残局可能具有更高的决策
杠杆，因此 H4 在**新的** discovery pool 上对此进行前瞻验证。

## 为什么是这个机制（诊断线索，不是结论）

E1 与 E3 两条互相独立的机制实验给出了同一形状：改动量大，胜负改动极小。

| | 干预量 | 结果改变 | 棋力 |
| --- | --- | --- | --- |
| E1 叶值更准 | 66.3% 叶值变 / 0.7% 出招变 | 33/400 副 | +0.458pp |
| E3 候选来源 | 40.6% eligible 决策换候选 | 5/400 副 | +0.125pp |

诊断（`benchmarks/leverage-diagnosis.test.ts`，只读分数结构、不碰胜负）：

- 决策在前两名之间的典型差距是 **305 分**（p50）；rollout 的混合影响力只有约 **37 分**
  （p50），差约 7 倍；实测 rollout 只推翻锚定首选 **5.6%**。
- **rollout 几乎从不走到终局**：终局叶只占 **8.9%**，只有 19% 的多候选决策出现过终局叶。
  也就是说搜索价值的大部分来自那个粗糙的手数估计。
- 终局叶几乎只出现在**最小手牌 ≤ 1** 的局面（min=1 → 32.7% 的决策有终局叶；min≥4 → 0.0%）。

所以最直接的实验不是让 rollout 权重更大（历史已否决：0.2→2.0 使 53.2% 掉到 48.9%），
而是**让 rollout 本身产生更有判别力的信息**。

## 冻结一：资格门槛 `rootMinHand <= 2`

在 calibration pool `5001–5400` 上采 root 级数据（25,684 个 root 决策），按**采集之前
冻结**的规则选 K：候选 K ∈ {1,2,3,4}；选最小的 K，使得 (1) `rootMinHand <= K` 覆盖
绝大多数 baseline 能产生终局信息的 root，(2) 扩到 K+1 时新增局面的终局信息密度出现
断崖式下降。不看棋力、胜率、E1/E3 结果。

| K | 准入 | 终局叶密度 | **覆盖全部终局叶** | 扩到 K+1 的新增密度 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 5,161 | 48.88% | 80.2% | 10.69%（不是断崖） |
| **2** | **9,247** | 30.66% | **96.2%** | **1.38%（↓7.7×）** |
| 3 | 12,500 | 22.05% | 98.0% | 0.62% |
| 4 | 15,237 | 17.71% | 98.7% | 0.67% |

K=2 是唯一同时满足两条的最小 K → **冻结 `eligible = rootMinHand <= 2`**
（9,247 个决策 = 全部 root 决策的 36%，覆盖 96.2% 的终局叶）。

注：不采用 `totalRemainingCards <= 15`——实测显示决定「深度能否摸到终局」的是最小
手牌，而总张数会把 min≥4（终局率 0.0%）的局面算进来、把 min=3 而总张数大的漏掉。

## 冻结二：搜索结构 `4 worlds × 6 plies`

候选集**事先限定**为 `{4×6, 6×4}`：baseline 是 `8×3 = 24 world-plies`；challenger 必须
`plies > 3`（干预要真的加深）；`worlds >= 4`（4 worlds 是唯一有配对实测支持"相对 8 无
可靠损失"的下限，−0.42pp [−1.08, +0.25]）。等于 24 world-plies 的整数结构里只剩这两个；
不测 `3×8`、`2×12`，不扩候选集。

选择指标（**只用于选择，不是棋力判据**）：**terminal trajectory rate** =
到达终局的 candidate-world trajectory / 实际展开的 candidate-world trajectory。
必须用**率**：三个结构展开的 trajectory 数不同（8×3 → 24 条、4×6 → 12 条、6×4 → 18 条），
比原始计数会给 world 少的结构白送优势。

规则：率高者胜；显示精度下精确平手则取 `6×4`（保留更多 determinization 多样性）；
不看棋力、不看胜率、不看 Discovery V2；选定后冻结，E4 不再比较另一个结构。

在 eligible roots（9,247 个）上的实测：

| 结构 | trajectories | 终局 | **rate** | 有终局的决策 | 跑满深度 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 8×3（出货） | 137,184 | 42,088 | **30.7%** | 53.4% | 69.3% |
| **4×6** | 68,592 | 34,800 | **50.7%** | **74.8%** | 49.3% |
| 6×4 | 102,888 | 39,841 | 38.7% | 63.8% | 61.3% |

**冻结 `4×6`**（50.7% > 38.7%，非平手）。

**限制**：这只证明 4×6 **更有效地产生 H4 想要的 terminal information**，
**不证明它搜索更强**。棋力是否因此更强，只能由 Discovery V2 的 paired A/B 回答。

## Preflight 结论：通过

正式 preflight 的条件是「相较 baseline `8×3`，eligible roots 上的 terminal-information
rate 没有提高则 STOP」。实测 **30.7% → 50.7%**，有提高 → **不 STOP，进入 E4-A**。
（同一批 9,247 个 eligible roots 上的同口径比较。）

## 唯一变量与冻结项

唯一机制变化：**在 `rootMinHand <= 2` 的局面里，同样的结构预算从广度转向深度
（`8 worlds × 3 plies` → `4 worlds × 6 plies`）。** 其他局面完全保持生产 baseline。

冻结不动：

| 冻结项 | |
| --- | --- |
| candidate set（含 E3 已回滚的锚定 top3） | `defaultPolicyPrior` |
| expert score 与全部权重 | `rootUtility`（含 220 / 24） |
| rollout 混合权重 0.2 | 采样方法（`sampleWithRandom`） |
| `rootAnalyzerNodes = 220` | rollout 的 `analyzerNodes = 8` |
| rollout 策略（`rankScoredPlayActions` expert） | 默认档、休闲档、叫牌 |
| 120ms 预算 / 480ms 窗口 / 520ms 节拍 / worker / deadline | 非 eligible 局面的 `8×3` |

不得同时：增加总预算；改候选；改叶值；改 prior；做残局 solver；做 uncertainty / gap
自适应；改 `plies` 或 `worlds` 以外的任何东西。

`root-level structural search budget`：eligible 局面两臂都是 `候选数 × 24 world-plies`；
非 eligible 局面两臂逐字相同。措辞仍写「root-level structural search budget 相同」，
因为候选不同则后续状态的合法动作数与排序成本不同，CPU 指令与墙钟不会严格相等。

## E4-A / E4-B

- **E4-A**：designed / 无 deadline、**Discovery V2 `20001–20400`**、400 副、jobs=8。
  判据沿用：`配对 Δ > 0` 且 `95% CI 下界 > 0` 且 `Δ ≥ SESOI 1.0pp`，显著性只由实跑出来
  的 paired 95% CI 判断。baseline 与 challenger 同种子逐副配对。
- **E4-B**：仅在 E4-A 通过后跑，shipped 120ms、8 worlds，并实测成本差异。
- **KEEP 前**用从未消耗的 validation `10001–10400` 独立复核。
- Discovery V2 exposure count 在 E4-A 运行时 0 → 1。

## 停止规则

- 若 E4-A 不过：**关闭 H4**。结论限定为「在 `rootMinHand <= 2` 的局面里把结构预算从
  广度转向深度，没有达到预登记的棋力收益标准」，不得扩大成「深度无用」或「残局不重要」。
- 不得在结果出来后改门槛 K、改结构、改 `4×6` 为 `6×4`、改 worlds / plies、调权重、
  或引入 gap / uncertainty 条件。
- 不得把 calibration 上的 terminal-rate 优势当成棋力证据。
- 若将来研究残局 solver、uncertainty 自适应、更宽的结构集：按新假设、新实验编号、
  新 spec、新 effect gate 处理。

## 诊断量（不作判据）

eligible 决策的 terminal rate、root action divergence、逐副好/差/平转移、anchored top1
被推翻率、wall-clock 与每决策成本。它们**不能成为 KEEP 的替代指标**。

## 产出

- 本 spec（实现前冻结）
- `experiment.md`（E4-A / E4-B 结果、KEEP / REVERT 与理由）
- 归档的 preflight 工具：[docs/research/059-h4-preflight/](../../research/059-h4-preflight/)
