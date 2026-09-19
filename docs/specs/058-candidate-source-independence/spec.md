# Spec 058：候选来源独立性实验（E3）

状态：协议已登记并冻结；未实现；未运行。
日期：2026-09-19
前置：E1（Spec 057）已 REVERT。E0 并行 runner（commit `5d1091e`）是本次基础设施。

## 目标

只回答一个问题：

> 高手档的候选准入是否被 `defaultPolicyPrior` 垄断，以至于**在候选总数不变的前提下**，
> 引入一个与默认排序独立的候选，能提升棋力？

## 为什么是这个机制

E1 已经证明「更准的叶值」穿不透到决策：66.3% 的叶值改变 → 2.5% 的候选排序改变 →
**0.7% 的最终出招改变** → +0.458pp（未达 SESOI，已回滚）。所以下一步该问的不是
"叶值还能不能更准"，而是**准入这一层的结构**。

指向准入的证据：

- 最终选择就是锚定首选的决策占 **96.51%**；锚定第 1、2 位分别只有 2.77% / 0.72%。
- `defaultPolicyPrior` 给默认排序第 0 名 **+1920**，而专家自身的公开局面项只有几百量级——
  「专家前三名」实际上约等于「默认前几名」。
- 历史：**整体删除**先验会让强方从 49.6% 掉到 36.8%（否决）；把锚定排序的宽度
  3→8 只有 +0.25pp、区间跨 0（否决）。所以 E3 不是「更多候选」，而是**不同来源的候选**。

## 唯一变量

```
candidates = A2 ∪ { U 中首个不属于 A2 的动作 }     （总候选数封顶 3）
```

- `A2` = 当前带 `defaultPolicyPrior` 的 expert top2，作为安全锚保留。
- `U` = **同一份 `baseExpertScore`**、仅去掉 `defaultPolicyPrior` 后的排序。
- 去重；若 U 不提供新的动作，则退化为现有候选（干预未发生）。
- **base 分数只算一遍**：`scoreAction` 以 `policyPrior = 0` 求值，先验在排序层再加。
  challenger 只多一次 O(n log n) 排序，**零额外评分**。不得维护两套评分逻辑。
- **tie-break 冻结**：`baseExpertScore` 相同时沿用生产代码现有的稳定 tie-break。
  否则「去掉 prior」会顺带改掉平手规则，偷渡第二个变量。

唯一变量因此是：**第三个候选从「锚定排序的第三名」变成「去锚定来源的最佳新增动作」。**

## 冻结项

| 冻结项 | 说明 |
| --- | --- |
| `defaultPolicyPrior` 本身 | 不删、不改、不调强度 |
| `rootUtility` 与 220 / 24 | E1 已回滚，本实验不碰 |
| rollout 混合权重 0.2 | 不碰 |
| `maxWorlds = 8` / `rolloutDepth = 3` / `rootAnalyzerNodes = 220` / rollout 的 `analyzerNodes: 8` | 不碰 |
| rollout 策略、`sampleWithRandom` 与世界构造 | 不碰 |
| 120ms 预算 / 480ms 窗口 / 520ms 节拍 / worker / fallback | 产品基线 |
| 默认档与休闲档 | 不碰 |
| 候选总数上限 = 3 | 本实验的核心约束，不得改成 5 |

## root-level structural search budget

两臂的候选数**恒等**，因此候选数 × worlds × plies 逐字相同：

| 合法动作数 | baseline（锚定 top3） | challenger（A2 ∪ U 首个新动作） |
| --- | --- | --- |
| 1 | 1 | 1（U 无新动作可加） |
| 2 | 2 | 2（U 无新动作可加） |
| ≥3 | 3 | 3 |

措辞要求：写 **「root-level structural search budget 相同」**，不写「计算量严格相同」。
候选不同则后续状态的合法动作数、排序成本与组合生成成本都可能不同，CPU 指令量与
墙钟不会严格相等。designed 路径没有 deadline，所以这不是 E3-A 的混淆变量；
它是 **E3-B 必须实测的产品成本**。

## Effect gate：root-proposal preflight（最小化）

目的只有一句：**证明这个候选来源的干预真实存在，不证明它有棋力价值。**

载体：**不回采完整叶语料**。只在 calibration seeds `5001–5400` 上记录每个 root 决策的
`decision id / legalActionCount / action ids / baseExpertScore / defaultPolicyPrior /
anchoredScore / anchored top3 / unanchored ordering / challenger 第三候选`。

- eligible 只算 `legalActions >= 3`；**`legalActions < 3` 的决策不进分母**（那些局面
  结构上不可能发生 E3 干预，混进去只会人为抬高重合率）。
- `intervention = challengerThird !== baselineThird`
- 报告：eligible 决策数、intervention count、intervention rate、重合率。

**唯一停止条件：`intervention count = 0`**（eligible 决策中重合率 = 100%）。
含义是「实验变量实际上没有发生」，不是「影响太少」。

不设 99% / 95% / 最低 intervention rate / 最低预计棋力收益——这些都没有证据基础。
哪怕只发生 0.5% 的干预，只要不是 0，就进入 E3-A，让 paired match 判断它有没有价值。

## E3-A / E3-B

沿用 E1 的判据：

- **E3-A**：designed / 无 deadline、seeds `301–700`、400 副、`maxWorlds=8`、jobs=8。
  **baseline 直接复用已冻结的 `.local/e1a-base.json`** —— 它就是同一配置、同一 seeds、
  同一 designed 路径、同一份出货代码（E3 改的是候选选择，该 baseline 跑在改动之前）。
  所以 E3-A 只需跑 challenger 一趟。
- **E3-B**：仅在 E3-A 通过后跑，shipped 120ms、8 worlds，并实测成本差异。
- KEEP 判据：`配对 Δ > 0` 且 `95% CI 下界 > 0` 且 `Δ ≥ SESOI 1.0pp`，
  且复杂度 / 性能合理。显著性只由**实跑出来的 paired 95% CI** 判断。
- 不设例外条款的自动 KEEP；低于 SESOI 时按同一套复杂度/性能标准判断。

## 停止规则

**E3 只允许一个 candidate-source family**，即上面那一个形状。流程只有：

```
preflight effect gate → E3-A designed → （通过则）E3-B shipped → KEEP 前独立 validation → E3 结束
```

结果出来之后**不允许**：把 cap 3 改成 5；再接 hand-turns proposal；再加 tactical
proposal；调 `defaultPolicyPrior`；调 rollout weight；调 `rootUtility`；调 worlds / depth；
根据失败局面新增特例。

若 E3-A 不过：**关闭 E3。** 结论只能写成：

> 在 candidate cap = 3、保留 anchored top2 的条件下，加入一个最佳 unanchored proposal
> 没有达到预登记的棋力收益标准。

**不得**扩大成「候选准入不是瓶颈」。更宽的候选集合是不同机制，必须作为**新假设、
新实验编号、新 spec、新 effect gate**，不得命名为 E3-B2 / E3-v2 来延续搜索。

以后若研究 hand-turns structural proposer、tactical forced proposer、cap=5 /
wider proposal set、prior strength 本身、candidate racing，一律按新实验处理。

## Discovery pool 暴露计数

E3 继续使用 `301–700`，因为协议在看到结果前已冻结、validation `10001–10400` 仍完全
未消耗、且 E3 只是第 2 个使用该 pool 的正式机制实验。

从本 spec 起，实验索引维护 `discovery-pool exposure count`：

| 实验 | 使用 301–700 |
| --- | --- |
| E1（Spec 057） | 1 |
| E3（本 spec） | 2 |

不要假设同一 discovery pool 可以无限复用。即使每次单独都预登记，实验数量增加最终
会产生 selection-on-discovery 风险。**E3 之后若再开新的机制线，先单独决定是否退休
`301–700` 并换一套新的 discovery seeds。**

## E3-A 只作诊断、不作判据的量

新第三候选最终被选中的比例；root action divergence；逐副好/差/平转移；
新候选出现在哪些牌型/角色/局面；锚定 top1 被推翻率。

它们**不能成为 KEEP 的替代指标**——「出招分歧率不能代替强度」是本仓库付过代价的教训。

## 禁止

- 不得用分歧率 / 重合率 / 干预率代替棋力结论。
- 不得为"更新数字"重跑没有信息增益的实验（baseline 复用即由此而来）。
- 不得在 E3 内顺带改动任何冻结项。
- 不得在 E3-A 不过之后沿同一 discovery seeds 步进式地试到成功。

## 产出

- 本 spec（实现前冻结）
- `experiment.md`（preflight 结果、E3-A / E3-B 结果、KEEP / REVERT 与理由）
- 若 KEEP：新的 baseline 与 validation 复核记录
