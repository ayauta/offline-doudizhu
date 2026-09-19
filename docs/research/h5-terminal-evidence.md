# H5 诊断：终局证据是否真的与牌局结果相关

日期：2026-09-19。**只做诊断，不实现算法，不消耗 Discovery V3。**
工具：[`benchmarks/terminal-evidence.test.ts`](../../benchmarks/terminal-evidence.test.ts)。

## 问题

H5 的前提是：固定混合权重 `0.2` 不区分搜索证据的质量；非终局 rollout 不值得信，
而强终局证据可能出现时 `0.2` 又太保守。前提可测且无需拟合任何参数——按被选中候选
**产生的终局证据**分桶，再看每个桶里**真实的**牌局结果。

采 2,400 局真实对局（calibration `5001–5400`、master:default、designed），按
`gameSeed` 与叶语料逐条对齐：**25,684 个决策全部对齐，0 个未匹配**。

## 结果

| 被选中候选的终局证据 | 决策数 | **真实 root 方胜率** | \|0.2×rollout\| 量级 |
| --- | ---: | ---: | ---: |
| **0 个终局** | 21,129（82.3%） | **50.7%** | 388 |
| conflicting | 209（0.8%） | 54.1% | 652 |
| **全胜** | 2,797（10.9%） | **90.4%** | 1,694 |
| **全负** | 1,549（6.0%） | **13.3%** | 1,000 |

- **终局证据高度有信息**：全胜 90.4% 对全负 13.3%，分离度 77 个百分点。
- **非终局 rollout 完全没有信息**：50.7% 就是基准率（镜像牌局下 root 方应约 50%）。
- **82.3% 的决策落在零信息桶里**，而 rollout 实测推翻锚定首选 5.6%（896/16,024）
  ——**那些推翻绝大多数发生在 rollout 没有任何信息的地方**。

## 必须同时写下的限制

1. 「全胜/全负」的桶是按**被选中候选**的证据分的，而该候选能被选中本身就受混合
   分数影响（终局叶贡献 ±10000）。所以这两个数字**不能读作「gating 能带来多少胜率」**。
2. 真实的**反事实**（同一个局面下另一个候选会赢还是会输）无法观测；本文只测了
   「桶与真实结果的相关性」，没有测「按此 gating 会更强」。
3. 因此本文只支持一件事：**存在一个简单、机制明确、可预登记的 confidence signal**
   ——「这次 rollout 到底有没有走到终局」。它**不**证明基于它的 gating 会提升棋力；
   那只能由 Discovery V3 的 paired A/B 回答。

## 对 H5 的含义

- 信号建议**二值**（有终局证据 / 没有），而不是连续函数——符合奥卡姆，也符合
  「简单、机制明确、可预登记」的要求。
- 零信息桶占 82.3%，意味着任何 gating 都会是一次**大范围**干预，不是微调。
- 若登记 H5，公式与阈值必须在**看到 V3 结果之前**冻结，且不得由本文的数字反推权重。

---

# 追加：反事实 override 探针（2026-09-19）

上文只测了「桶与真实结果的相关性」，那是无条件结果率，且有 selection effect。
本探针直接回答 H5 需要的那一层：**终局证据能否区分 rollout override 的质量？**

工具：[`docs/research/h5-override-probe/override-probe.test.ts`](h5-override-probe/override-probe.test.ts)
（依赖 057 的插桩补丁；运行时拷进 `benchmarks/`）。

方法：对每一个 rollout 推翻 expert top1 的决策，**在该决策点分叉**——
E 支强制执行原 expert top1，R 支强制执行 rollout 的选择——两支用**完全相同**的生产
AI 与确定性配置续行到终局。同一副牌、同一份真实隐藏牌、同一续行，只有那一手不同。
策略全程只看到正常公开信息；探针只是持有状态，从不把隐藏牌喂给策略。

自检：重放循环必须与 `playGame` 在同种子上给出相同胜者，否则该局作废。

## 结果（896 个 override 决策，calibration 5001–5400）

| 桶 | 决策数 | rollout 支胜 | expert 支胜 | 相同 | **NET** |
| --- | ---: | ---: | ---: | ---: | ---: |
| **no-terminal** | 286 | 22 | 21 | 243 | **+0.35pp** |
| **terminal** | 610 | 120 | 12 | 478 | **+17.70pp** |

分角色（rollout 支更好的比例）：no-terminal 地主 8.0% / 农民 7.3%；
terminal 地主 12.5% / **农民 23.4%**。

## 读法

- **无终局证据的 override 是掷硬币**：286 个决策净多赢 1 个。
- **有终局证据的 override 是 10:1 偏向 rollout**：120 比 12。
- 因此 **terminal evidence 确实区分 override 质量**，H5 的二值 gating 有了直接机制依据。

**同样必须写下的限制：**

1. 这**不是棋力实验**，不决定 KEEP / REVERT，不消耗任何 discovery pool。
2. 探针只覆盖**发生了 override 的 896 个决策**；它没有测「在有终局证据但没有 override
   的大量决策上提高影响力」会怎样——而那正是 H5 的主要上行空间。
3. 无终局 override 是**中性**（22 对 21），不是有害。所以「无证据时归零」的预期收益
   接近零，它只是拿掉一次掷硬币。
4. 单条终局叶给混合分带来约 ±250，而典型锚定差距 p50 约 275——**刚好打平**。

---

# 冻结：H5 的方向与 gating condition（2026-09-19）

**方向：只做上行。** 保持现有的 rollout weight `0.2` 作为默认值；只有当一个候选
拿到高置信终局证据时，才**提高该候选 rollout 项的影响力**。

「上行」指的是**提高可信度/影响力**，不是只放大正值：
unanimous win → 正项被放大；unanimous loss → 负项同样被放大，该候选被更强地压低。
这才是"有证据时更相信搜索"。**没有证据的候选保持 0.2 不动。**

不做（明确排除，各自需另立假设）：no-terminal 降权或归零；terminal 直接
lexicographic override；terminal evidence 独立成为排序层；同时改 expert/default prior。

## 冻结的 gating condition（二值）

```
hasConfidentTerminalEvidence(candidate)
  ⟺ terminalCount >= 1
     且 所有 terminal trajectory 对 root 阵营的结果一致（全胜 或 全负）
```

返回 false 的情形：0 条 terminal；terminal 中同时存在胜与负；任何无法明确归属
root 阵营胜负的异常状态。

**不要求 `terminalCount >= 2`**：那会引入一个没有机制必然性的计数阈值。现有诊断只
说明「1 条同向已明显有信息、更多同向更强」，没有证明 2 是一个该编码进算法的边界。

**排除 conflicting 的理由是机制性的**，不依赖把 54.1% 当成调出来的阈值：不同 sampled
world 给出相反答案，本身就是"不确定性仍高"的直接表现，不应进入 confidence gate。

## 实现时必须覆盖的视角陷阱

**「同向」只能站在 root 阵营视角定义**（地主阵营 vs 农民阵营），不能写成
「当前 seat 赢/输」——斗地主有两个阵营，视角一混，农民位的符号会直接反掉。

门禁测试必须覆盖：root 是地主 / root 是农民 / 不同 rollout seat 下，
terminal evidence 的正负方向一致。

## 尚未决定

**gate 触发后 rollout influence 到底怎么提高**——包括提高的形式与数值。这一项必须在
看到 Discovery V3 结果之前冻结，且不得由本诊断的胜率数字反推。

一个**结构性**（非拟合）的输入供下一问参考：单条终局叶给混合分带来 `0.2 × 10000/8
≈ 250`，而前两名锚定差距 p50 ≈ 275。也就是说**现有 0.2 已经大致落在"一条终局叶约等于
一个典型差距"的位置**；两条终局叶（≈500）已越过它。这不是"应该设成多少"的依据，
只是说明当前的权重处在哪里。

---

# 冻结：H5 v1 的作用形式与 W_gate（2026-09-19）

## 作用形式：component-wise gating

**否决整体放大。** `confident ? W_gate × rolloutMean : 0.2 × rolloutMean` 有一个机制污染：
8 个 world 里只要有 1 条同向终局，gate 就会把**其余 7 个 non-terminal 效用一起放大**。
而证据只支持「终局信息值得更信」，**不支持**「与它同候选的 non-terminal 估计也更可信」。

```
terminalComponent    = sum(terminal utilities)    / worldCount
nonTerminalComponent = sum(non-terminal utilities) / worldCount

无高置信终局证据： 0.2 × mean(all)                       ← 与生产逐位相同
有高置信终局证据： 0.2 × mean(all) + (W_gate − 0.2) × terminalComponent
```

第二行是**增量式**，与「分量式」（`W_gate×T + 0.2×N`）数学等价但浮点不等价：增量式在
`W_gate = 0.2` 时增量恰好为 `0`，因此恒等测试**真的逐位成立**。实现必须用增量式，
否则恒等测试会因为末位浮点差而被迫放宽成容差比较，丢掉真正的保护。

性质：estimator 不变；sampling 不变；non-terminal 信息永远维持 `0.2`；conflicting 不
触发；同向胜/负对称。

## W_gate = 1.0

语义是**取消对 terminal utility 的 0.2 shrinkage**，让它按原始设计尺度完整进入评分——
不是调出来的倍数，也不由 historical 胜率、gap 分位数或 override 数量拟合，
不搜索 0.4 / 0.6 / 0.8 / 1.2 等中间值。

H5 v1 因此只有一个离散干预：**当且仅当存在同向终局证据时，terminal component 从
0.2 恢复到 1.0；其他所有 rollout 信息仍保持 0.2。**

## 实现硬要求（门禁）

- **恒等**：`W_gate = 0.2` 时，新公式与当前生产公式**逐位完全相同**。
- 0 条 terminal → 完全等于 baseline。
- conflicting terminal → 完全等于 baseline。
- 同向全胜 → 只增加 terminal 的**正**贡献。
- 同向全负 → 只增加 terminal 的**负**贡献。
- non-terminal component 在 gate 前后**逐位不变**。
- 地主 root / 农民 root 的符号一致（同向只能站在 root 阵营视角定义）。

这样 H5 测的才是「高置信终局证据是否应按完整尺度进入决策」，而不是「只要见过终局就把
整个 rollout 放大 5 倍」——否则即使赢了，也无法归因。

---

# E5-A 结果：REVERT（2026-09-19）

按冻结的形态实现（component-wise 增量式、`W_gate = 1.0`），实现门禁全绿，然后在
Discovery V3 `30001–30400` 上跑两臂各 400 副 designed。完整记录见
[Spec 060 实验记录](../../specs/060-terminal-evidence-gating/experiment.md)。

| 臂 | baseline | challenger | 配对 Δ | 95% CI |
| --- | --- | --- | --- | --- |
| 强方当地主 | 54.3% | 54.1% | −0.250pp | [−0.667, +0.167] |
| 强方当农民 | 49.8% | 51.2% | +1.417pp | [+0.667, +2.167] |
| **合并** | 52.1% | 52.7% | **+0.583pp** | **[+0.167, +1.042]** |

判据：Δ > 0 ✅、CI 下界 > 0 ✅、**Δ ≥ SESOI 1.0pp ❌** → **REVERT H5，关闭该实验。**
`src/` 已回滚为零改动；机制、插桩与门禁载体归档在
[`docs/research/h5-v1/`](h5-v1/README.md)。

**机制确实发生了，只是不值 1.0pp**：19.8% 的出招决策上有同向终局证据（13.7% 的候选获得
门控），但只有 **0.7%** 的决策因此换了 action。所以本文测到的「信号有信息」（全胜 90.4%
对全负 13.3%、override 探针 10:1）与 E5-A 测到的「提高影响力有棋力收益」是两件事：
**前者为正，后者未达预登记标准。**

**不得**事后用这份结果去调 `W_gate`、加 `terminalCount` 阈值、改成 terminal-only mean、
lexicographic override、动 `defaultPolicyPrior` 或加深搜索——那各自是新假设、新实验编号、
新 discovery pool。
