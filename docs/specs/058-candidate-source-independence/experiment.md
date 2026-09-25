# Spec 058 实验记录（E3）

协议见 [spec.md](spec.md)。状态：**Step 1 重构已验证、preflight 已过、E3-A 尚未跑**。
日期：2026-09-19

## Step 1：评分出口重构，生产行为零变化

`scoreAction` 拆成一次性求值的 `evaluateAction`，同时产出 `baseScore`（不含先验）、
`prior`、`anchoredScore`（= 出货返回值）。两个排序由**同一批求值**生成，因此只可能
因先验而不同。`rankScoredPlayActions` 的返回值与重构前逐位一致。

一个必须尊重的细节：「一手走完」的捷径在加先验之前就 `return 1_000_000`，所以它
**不收先验**——base 与 anchored 都取 1_000_000，否则去锚定排序会把"能走完"排下去。

**行为冻结证明**（designed、seeds 301–700、400 副、带命令日志，与 E1-A 冻结的
baseline 逐位比对）：

| 配对 | 逐副数组 | 命令日志 |
| --- | --- | --- |
| `default vs casual` | 400 副全同 | **76,361 条逐位相同** |
| `master vs default` | 400 副全同 | **75,888 条逐位相同** |

**0 分歧。**

## Step 2：root-proposal preflight

语料：calibration seeds `5001–5400`、designed、8 路并行。只记 root 决策的
`legalActionCount / baseExpertScore / defaultPolicyPrior / anchoredScore /
anchored top3 / unanchored top3 / 两个第三候选`，不采叶、不跑胜负。

eligible 定义：`legalActions >= 3`。

| 指标 | 值 |
| --- | --- |
| root 决策 | 25,684 |
| eligible | **11,980（46.6%）** |
| **intervention count** | **4,859** |
| **intervention rate** | **40.6%（占 eligible）** |
| 重合率 | 59.4% |
| 地主位 | 2,720 / 6,044 = **45.0%** |
| 农民位 | 2,139 / 5,936 = **36.0%** |
| top3 重合分布 | 0/3: 1,045　1/3: 1,620　2/3: 3,211　3/3: 6,104 |

eligible 的 11,980 与 E1 语料独立测得的候选数直方图（46.64% 的决策有 3 个候选）
**逐数吻合**，两条采集路径互证。

**Gate：`intervention count = 4,859 ≠ 0` → PROCEED。** 按 Spec 058，这是唯一的停止
条件；不设比率阈值。

诊断（非判据）：去锚定提议在 **40.6%** 的 eligible 决策上真的替换了第三个候选，
且**地主位比农民位更容易被替换**（45.0% vs 36.0%）。这两个数字都只是干预的存在性
证据，不构成任何棋力预期。

## Step 3–4：接入与冻结验证

`rankMasterPlayActions` 的候选选择改为 `A2 ∪ { U 中首个不属于 A2 的动作 }`，总数封顶 3；
新候选仍携带**锚定分**，所以变的只有「谁被准入」。生产 diff 只有 `master-policy.ts`
的候选选择那一段（+ 一个 action 身份的 key 助手与一处 import）——`rootUtility`、
`defaultPolicyPrior`、评分权重、`maxWorlds` / `rolloutDepth` / `rootAnalyzerNodes` /
rollout `analyzerNodes`、world sampling、rollout 策略、220 / 24、默认档、叫牌、
worker / deadline **全部未动**。

候选数恒等由一条 invariant 保证并进了日常门禁：**只要所有合法动作都被评分过，
`legalActions >= 3` 的决策必须产出恰好 3 个候选**，否则抛错（不静默退化成 2 个、
静默改变 root-level structural search budget）。该 invariant 只在完整评分时检查——
预算被截断的排序本来就候选更少，那是本实验不得改动的出货行为。

## Step 5：E3-A（designed，seeds 301–700，400 副）

baseline 复用 `.local/e1a-base.json`；只跑 challenger。

| 臂 | baseline | challenger | **配对 Δ** | 95% CI |
| --- | --- | --- | --- | --- |
| 强方当地主 | 51.7% | 51.7% | **0.000pp** | [0.000pp, 0.000pp] |
| 强方当农民 | 54.3% | 54.6% | +0.250pp | [−0.083pp, +0.667pp] |
| **合并（primary）** | 53.0% | 53.1% | **+0.125pp** | **[−0.042pp, +0.333pp]** |

逐副转移：challenger **好 4 / 差 1 / 平 395**；swing 直方图 `−1:1  0:395  +1:4`。

对照 `default vs casual`：逐副完全相同、**0/76,361 条命令分歧**——改动只落在高手档。

出招分歧 93.9%，首次在第 **#44** 条命令（baseline 出王炸 `[52,53]`、challenger 出单张
`[43]`），之后是级联，不是 71,216 个独立事件。

一个值得记录的观察：**地主臂 400 副的逐副结果完全相同**（Δ 与 CI 都是 0）。干预真实
发生了（40.6% 的 eligible 决策换了第三候选）、出招序列几乎全变，但在地主位上一次
都没有改变胜负。这是解释性观察，不是判据。

### 未能测量的诊断

`U1 最终被选率`、`原 anchored third 被替换率`、`anchored top1 被推翻率` 需要「每个决策
最终选中的是第几个候选」这一信息，当前工具链只 dump 逐副结果与命令日志，给不出候选
槽位。`U1 出现率` 有（= preflight 的 40.6%）。这三项**没有测**，不以其他数字代替。

## REVERT

```
Decision: REVERT
Reason: positive but below preregistered practical-effect threshold;
        the 95% CI does not exclude zero.
```

| 条件 | 实际 | |
| --- | --- | --- |
| 配对 Δ > 0 | +0.125pp | ✅ |
| 95% CI 下界 > 0 | **−0.042pp** | ❌ |
| Δ ≥ SESOI 1.0pp | +0.125pp | ❌ |

按 Spec 058 的停止规则，**关闭 E3**。结论只能写成：

> 在 candidate cap = 3、保留 anchored top2 的条件下，加入一个最佳 unanchored
> proposal 没有达到预登记的棋力收益标准。

**不得**扩大成「候选准入不是瓶颈」。更宽的候选集合、structural / tactical proposer、
prior strength、candidate racing 都是不同机制，按新假设、新实验编号、新 spec、
新 effect gate 处理。

回滚：`rankMasterPlayActions` 恢复锚定 top3（`src/` 零改动）。E3 专属的定义测试随回滚
撤掉（它钉的正是被回滚的定义，可从本实验的 commit 精确恢复）；保留下来的是**回滚后
仍然成立**的两条不变式——`baseScore + prior === anchoredScore`（一手走完除外）与
短名单长度恒为 `min(3, 合法动作数)`。

## E3 回答了什么

| 层 | 变化量 |
| --- | --- |
| eligible 决策的第三候选被替换 | **40.6%**（4,859/11,980） |
| 出招序列 | 93.9%（级联） |
| **改变胜负的副** | **5/400**（好 4 / 差 1） |
| 棋力 | **+0.125pp** |

干预是**真实且大量**的——远比「第三个候选很少被选中」所能解释的要多。但把这些干预
换成胜负的能力极低：400 副里只有 5 副的结果因此改变，净 +0.125pp，区间跨 0。

与 E1 并列看，两条独立的机制实验给出了同一个形状：**改动量本身不是瓶颈，改动能否
落在高杠杆局面上才是**。E1 换了叶值（66.3% 叶变 → 0.7% 出招变），E3 换了候选来源
（40.6% 候选变 → 5/400 副结果变）——两者都没有把这些改动转化成胜负。
