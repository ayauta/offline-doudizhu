# Spec 057：rootUtility 叶值信息实验（E1）

状态：协议已登记并冻结；newEvaluator 尚未实现；基线已测。
日期：2026-09-19
基础设施基线：commit `5d1091e`（E0，确定性的牌局级并行 runner）

## 目标

在不引入神经网络、不作弊、不显著增加等待时间的前提下，让高手档明显强于默认档。

E1 只回答一个问题：

> 把 rollout 叶子节点的剩余手数估计从 `estimateBasicHandTurns` 换成更准确的
> minimum-combination evaluator，棋力是否提升？

## 为什么是这个机制

- **搜索的三个旋钮全部测过且全部无收益**：效用函数形状（阵营求和 → 取最小）、
  每动作节点额度（8 → 32）、候选宽度（3 → 8，+0.25pp 区间跨 0）。瓶颈在评估。
- **在 analyzer 上做同类改动已经做过**（Spec 053）：配对增量 +0.75pp、
  95% 区间 [−0.167, +1.708]，撤回。而且 `solveMinimumTurns` 把 `best` 初始化成
  乐观的廉价估计之后只做 `Math.min`，节点再多也修不好——那个插座的结构决定了
  它不可能从"更准的估计"里获益。
- **`rootUtility` 是搜索真正在优化的东西**，而它一直用着那个乐观、已知会低估的
  `estimateBasicHandTurns`。053 冻结项里明确写着 "Master utility 不变"。
  实验记录把它标为「唯一没试过的机制」。

**AI 内部提速不属于候选**：出厂 master 路径读时钟，把合法动作生成从 20ms 优化到
10ms 就可能让原本被截断的 rollout 跑完，从而改变出招。E0 选的是另一条路——
跨牌局并行，一副牌内部一个字节都不动。

## 唯一变量

`rankMasterPlayActions` 中 `rootUtility` 对三个座位的手数估计：

```
现在：  estimateBasicHandTurns(state.hands[seat])
改为：  新 evaluator，其手数差先经预登记仿射归一化
```

`rootUtility` 的形状与权重**不动**：

```
U = (敌方手数 − 我方手数) × 220 + (敌方张数 − 我方张数) × 24
```

只替换"手数怎么算"，这样胜率一旦变化，归因唯一。

## 冻结项

| 冻结项 | 位置 | 为什么不能动 |
| --- | --- | --- |
| `estimateBasicHandTurns` **本体** | `hand-analyzer.ts` | 休闲档与专家档的 `beforeTurns` 都用它；改它就不是单变量。**新 evaluator 必须是新函数** |
| `createHandAnalyzer` / `solveMinimumTurns` | `hand-analyzer.ts` | Spec 053 已证明这个插座无收益 |
| `defaultPolicyPrior` | `scoring-policy.ts` | 承重：移除会让强方从 49.6% 掉到 36.8% |
| 候选集 = `expert.slice(0, 3)` | `master-policy.ts` | 候选宽度是 E3 的事 |
| `maxWorlds=8` / `rolloutDepth=3` / `rootAnalyzerNodes=220` / rollout 的 `analyzerNodes: 8` | `decision-handler.ts` | 基准有金丝雀钉着；本来就是成本上限而非强度旋钮 |
| `sampleWithRandom` 与世界构造 | `master-policy.ts` | 不偷看的证据链 |
| 120ms 预算 / 480ms 窗口 / 520ms 节拍 / worker / fallback | 出厂 | 产品基线 |
| `rootUtility` 的 220 / 24 | `master-policy.ts` | 权重是 E2 的事 |
| 默认档全部 | — | 产品硬约束 |

## 尺度归一化 k/b（预登记，一次算完即冻结）

新估计与旧估计的数值尺度不同（旧值系统性乐观低估），直接接入等于同时改了 220
这个权重。因此先用独立校准集做**一次性仿射标准化**：

```
d_old = oldEnemyTurns − oldMyTurns        （同一叶子上）
d_new = newEnemyTurns − newMyTurns

k = SD(d_old) / SD(d_new)
b = Mean(d_old) − k · Mean(d_new)

送入 ×220 的是：k · d_new + b
```

这样新旧在进入 `rootUtility` 前拥有相同的均值与标准差，这一项在总分里的
"话语权"不变，E1 测的就只是**排序信息是否更好**。

- `k/b` 只能在 calibration corpus 上算**一次**，冻结后写入实验配置。
- **禁止**根据 E1 胜率重新调整 `k/b`；禁止 clipping、分角色分别调尺度、
  多参数拟合、按候选排序人工调。
- 若算出来 `b ≈ 0`，仍保留公式，不为"简化"而改实验定义。

## 三个门槛（跑棋力 A/B 之前）

### 1. Correctness gate

已知反例与组合结构测试必须通过，至少覆盖：`3334445`、`3334455`、`33344556`、
顺子、连对、飞机、三带、炸弹拆分、王炸、多种可竞争拆法。
**不通过 → STOP，修 evaluator，不跑棋力 A/B。**

### 2. Effect gate

在冻结的 calibration corpus 上比较新旧 `rootUtility`。经预登记 `k/b` 归一化后，
若新旧**在所有实际 root 候选上完全不产生排序差异**（或差异小到不可能改变任何
决策），直接放弃 E1。

**不设最低翻转率门槛。** 翻转率、divergence、top3 变化率、"残局看起来更合理"
永远只是解释变量，不能代替棋力结论——「出招分歧率不能代替强度」是本仓库
已经付过代价的教训。一个更好的 evaluator 完全可能只翻转更少的决策而赢更多。

### 3. Cost gate

单独 benchmark evaluator，记录：每决策调用次数、cache 命中率、per-call
p50/p95、整个决策的额外成本。

依据：`rootUtility` 每决策调用 24 次（3 候选 × 8 world）× 3 个座位 =
**每决策 72 次手牌评估**。据此推算的单次预算：

| 单次成本 | 开发机每决策增量 | 小米 10S（×3.7） | 判断 |
| --- | --- | --- | --- |
| ~1 µs | +0.07ms | +0.26ms | 免费 |
| ~10 µs | +0.72ms | +2.7ms | 安全（设计目标） |
| ~50 µs | +3.6ms | +13ms | 硬上限，p95 会吃紧 |
| ~500 µs | +36ms | 爆预算 | 实验作废，先去优化实现 |

**在 designed 路径上都无法满足合理性能范围 → STOP，先优化实现**，不要把正式
棋力实验预算花在一个明显无法出货的版本上。

## E1-A：designed 棋力 A/B（主要结论）

- 两条臂都跑同一个 `decideEnhancedAi`，同一 `maxWorlds=8`、同 seeds、同 world、
  同候选、同 rollout、同权重；唯一差异是 `rootUtility` 用旧估计还是新 evaluator。
- deadline 放宽到足以保证两边都跑完 8 个 world（`AI_BENCH_DESIGNED=1`）。
  这不是换替身策略——它跑的是同一个 handler，只是把残留的墙钟抖动掐掉。
  依据：8-world 下开发机的出货 p50 14.1ms 与无预算 p50 13.9ms 几乎重合。
- 语料：discovery seeds 301–700。

**KEEP 候选条件（三条同时成立）**：

1. 配对 Δ 点估计 > 0；
2. 配对 Δ 的 95% 区间下界 > 0；
3. 点估计 ≥ SESOI。

## E1-B：shipped 复核（只有 E1-A 通过才跑）

真实 120ms 预算、`maxWorlds=8`、worker、deadline、fallback。记录：配对 Δ、
p50/p95/max、截断率、完成 world 数、fallback/timeout、evaluator 成本。

**最终 KEEP 需要三条同时成立**：

- **A 算法价值**：designed A/B 证明棋力收益；
- **B 产品价值**：shipped 方向仍为正，且没有证据表明收益被计算成本系统性吃掉；
- **C 性能**：真实性能可接受，截断 / fallback 未出现不可接受恶化。

判定分支：

| 情况 | 处置 |
| --- | --- |
| designed 不赢 | REVERT，不值得为它做性能优化 |
| designed 赢、shipped 明显退化 | **不要直接回滚 evaluator，也不要直接 KEEP**；先判定是否为算力交互（evaluator 太慢 / cache 命中不足 / world 完成数下降 / 截断增加），另开实验优化 evaluator 成本 |
| 两者都赢 | KEEP，成为下一轮 baseline |

## SESOI

```
SESOI = max(1.0pp, 实测复跑地板)
```

- +1pp 是**单个实验值得永久进入基线的工程收益门槛**，不是最终产品目标。最终目标
  由多个经证实的简单改进累积，不要求任一机制单独完成。
- **例外**：低于 +1pp 但复杂度≈0、性能成本≈0 且独立复现的改动允许保留。
  **惩罚的是复杂度，不是小收益本身。**
- 复跑地板只在 >1pp 时才抬高 SESOI。

### 复跑地板与统计不确定性是两件事

| 概念 | 测法 | 用途 |
| --- | --- | --- |
| reproducibility / runtime nondeterminism | 同种子两次 baseline 的逐副差异 | 判定实验是否可复现；**不得**代替统计不确定性 |
| 统计不确定性 | 正式 A/B 的 paired bootstrap CI | 判定效应是否存在 |

8-world 出货配置已实测：designed 路径 22,138 个决策两次跑**逐位相同**（算法
确定性成立）；shipped 路径两次跑有 7 个决策截断标记不同但**零命令分歧**。
旧的 0.46pp 地板是 32-world / 13.3% 截断下的产物，在出货配置下不成立。

## 种子池（从现在起隔离）

| 池 | 范围 | 用途 |
| --- | --- | --- |
| calibration | 5001–5400 | 只用于算 `k/b`、跑 effect gate、离线重放 |
| discovery | 301–700 | E1-A、E1-B 的正式棋力配对 |
| validation | 10001–10400 | Spec 053 划定但从未消耗；KEEP 前独立复核 |

校准集与正式 A/B 集必须分开。即使这里只拟合两个数，也从现在开始建立
train → validation → test 的纪律，防止后面的参数迭代越调越"适合那 400 副固定牌"。

## 禁止事项

- 任何改动不得因为「感觉更聪明」「残局看起来更合理」「改变了很多出牌」被接受。
- **唯一主要棋力标准是稳定、可复现的对局收益。**
- 不得为了"更新数字"重跑没有信息增益的实验。
- 不得在 E1 内顺带调 `rootUtility` 权重；权重是 E2 的事。
- 不得在 E1 内顺带做 AI 内部性能优化；那是另一条实验（E-Perf-1），因为它可能
  改变 shipped deadline 行为。

## 产出

- 本文（协议，实现前冻结）
- `experiment.md`（结果、KEEP/REVERT 与理由）
- calibration corpus 与它的校验和、形状描述
- 叶采集插桩补丁的归档（用完还原，不留在生产代码里）
- 下一轮 baseline（若 KEEP）

实验记录与失败原因并入 [AI 实验结果索引](../../research/ai-experiment-results.md)，
本文不重复承载证据。
