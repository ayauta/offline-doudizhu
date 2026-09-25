# AI-v3 — 接续说明

**状态：PAUSED。** 本文不是协议，没有 N、没有 seed 范围、没有 margin、没有预算。
这些在真正开始 AI-v3 时再做 preregistration。

它存在只是为了：将来重新进入项目的人不必翻聊天记录就能知道**起点在哪、第一个问题
是什么、以及哪些前提已经被纠正过**。

---

## 13. 当前基线

```
INCUMBENT = AI-v2

landlord = CHEAP（full-action LightGBM，403 列，512 树）
farmers  = π1（counterfactual selector，threshold 0.01）
```

未来任何 successor **默认对 AI-v2 比较**。
拿旧的 production master 当地主基线是错的：那部分增益已经入账。

## 14. 已经纠正的训练环境事实

```
CHEAP  training opponents:  ~50% casual/casual   +  ~50% default/default
TARGET training opponents:  ~50% π1/π1           +  ~50% P0/P0
```

（来源：`benchmarks/selfplay-rehearsal-collect.test.ts` 的 `branchConfig`。）

**CHEAP 从未以 π1 farmers 作为训练对手，但在独立评测中对 π1/π1 拿到 +9.400pp。
因此这是跨环境泛化，不是覆盖。**

不要再写成 `CHEAP 缺 default coverage` ——那是错的：CHEAP 的 rows 里 default 占 49.61%。
缺 π1 覆盖的是 CHEAP，缺 default 覆盖的是 TARGET。

## 15. 第一候选问题（一句话）

> Test whether replacing CHEAP's casual/casual training component with π1/π1, while
> retaining default/default and freezing all other training semantics, can produce a
> successor that beats AI-v2.

候选训练 mixture：

```
50% π1/π1
50% default/default
```

必须是 **pair-level sampling**（按副采对手，不是按 row），否则同一副牌的多个决策会
被当成独立样本。

```
PROPOSAL ONLY
NOT PREREGISTERED
NOT AUTHORIZED TO RUN
```

它之所以值得先做，是因为它便宜且能证伪：通过 → "训练分布对齐评估分布"就是稳定产出
下一代的机制；不通过 → 覆盖假说被证伪，这正是下面 B 值得付代价的前提。

## 16. 晋级原则（只有三条，现在不冻结更多）

```
1. baseline = AI-v2, not the old master
2. evaluate environments separately, no mixed-average promotion
3. development candidate must pass fresh independent confirmation
```

N、seed 范围、NI margin、具体阈值、compute 预算 —— **都不在这里冻结**。

## 17. 如果 coverage-only successor 失败

两个备选方向，各一句，不展开：

**A. Conservative full-action incumbent improvement.**
对全部合法动作打分，只有当候选相对 incumbent 的分数优势超过一个**冻结门槛**时才接管；
轨迹仍由 incumbent 产生，因此必须用 **takeover** 评测，不能用 single-step。

**B. Search-assisted target generation.**
把 label 从"采样一条 continuation"换成对对手手牌做有界 determinization 聚合，产物蒸馏回
同一个 403 列 schema（运行时不变）。改动的是 **label 语义**——即现有 label 条件于当前
对手分布这一问题的根源。代价高，且必须先实测 offline compute。

---

## 开始前请先读

[`../GUARDRAILS.md`](../GUARDRAILS.md)。本项目绝大部分错误结论都来自那十二条里的某一条。
