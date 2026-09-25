# Powered development counterfactual diagnostic — design and result

状态：**development-only**。本文件里没有任何数字可以用来决定 KEEP / REVERT，
它也不能给任何候选"补票"。它回答一个问题：

> prototype model 的 argmax，在冻结的 deployment continuation 下，
> 相对 π1 的 action，有没有可测的 terminal advantage？

## 1. 为什么从 300 换成 6000

feasibility 阶段的 300-root 版本实测分辨力约 ±3.5pp，而 planning target 是 `+2pp`。
用**实测**的分歧率反算：

```
model vs parent 分歧 47/300 = 15.7%
  分辨 +2pp 需 n ≈ 6,020      +3pp 需 2,675      +5pp 需 963
```

`300` 从此作废。`6000` 是事前定下的固定预算，**运行开始后不得因为看到中间结果而加 N**。

## 2. 测量的是什么，不是什么

| | |
| --- | --- |
| 名称 | **greedy deployment counterfactual diagnostic** |
| arm A | π1 在该 root 的动作（incumbent） |
| arm B | prototype model 在全部合法动作上的 argmax |
| arm C | 预登记的其他合法动作，仅在**固定前 1000 个 group** 上跑 |
| outcome | learning seat 所属阵营的**终局胜负**（terminal team win） |
| continuation | 强迫动作之后，三个 seat 全部改用同一个冻结 bundle（π1），**探索全关** |
| 环境 | 三个 seat 都跑 π1；ε = 0 |

**它不是**训练 Q target 的无偏估计：训练数据的 continuation 用 ε=0.10、
对手分布也不同。两者是不同的测量，**永不合并**。

## 3. 事前固定的规则

**root 规则**：learning seat 的**第一个合法动作数 ≥ 2 的 decision**。

* 与结果无关：它只依赖 deal 与 π1 的确定性轨迹；
* 事前固定，写在代码常量 `ROOT_RULE` 里；
* 每个 initial deal group **只抽一个 root**，因此 deal group 就是 iid 单位，
  不需要 cluster 修正——**绝不把 root 当独立样本**。

**三角色平衡**：`scenario = ["L","F-next","F-prev"][offset % 3]`，
于是三个角色各占约 1/3。

**第三臂规则**：canonical order 的**中位下标**动作；若与 A 或 B 重合则上移，
直到与两者都不同；若合法集容不下三个不同动作，则记为该 group 的平局。

**统计量**：`d_i = win_B(i) − win_A(i) ∈ {−1,0,+1}`，按 deal group 求均值；
`SE = sd(d)/sqrt(N)`；双侧 95% CI = `mean ± 1.96·SE`。
平局计入 N（它们是真的"没有差别"），不剔除。

## 4. 种子来源

`research/full-action-selfplay-v1/development-pool.md` 声明的
development 区间 `900001–906000`（6000 组）。
与 prototype 训练区间 `5001–5400` **零重叠**；
与任何历史正式 pool 零重叠。
时序 pilot 用 `919001–919140`（同一 reservation 内的不相交切片）。

---

## 5. 结果（2026-09-25，6000 group 固定预算，一次性，跑完后未加 N）

```
groups          5913 kept, 87 excluded (1.45%: 该局没有合法动作数 >= 2 的 learning decision)
deal range      900001..906000
mean legal      30.74 (median 6, max 420)   at the root
A pi1 win       57.940%
B model win     56.773%
PRIMARY delta   -1.167pp   SE 0.488pp   95% CI [-2.124, -0.209]pp
discordance     383 better / 452 worse / 5078 tied  (14.12%)
deviation       model left pi1 at 4244/5913 roots (71.8%)
C arm (988 groups, 886 with three distinct actions)
  other vs pi1  -3.036pp   SE 1.355pp   95% CI [-5.693, -0.380]pp   75 better / 105 worse
  model vs pi1  -1.923pp   SE 1.184pp   95% CI [-4.243, +0.397]pp   59 better / 78 worse
  model vs other +1.113pp  SE 1.491pp   95% CI [-1.810, +4.036]pp   114 better / 103 worse
by role
  landlord         2000 groups  pi1 27.45%  model 30.55%  delta +3.100pp +- 1.975pp
  farmer-next      1954 groups  pi1 74.21%  model 71.34%  delta -2.866pp +- 1.434pp
  farmer-previous  1959 groups  pi1 72.84%  model 69.01%  delta -3.828pp +- 1.478pp
```

## 6. 这些数字说明什么，不说明什么

**说明：**

1. **判定仪器现在够了。** SE 0.488pp，半宽 0.96pp —— 足够看见 planning target（+2pp）。
   300-root 版本分辨不了的东西，现在分辨得了。
2. **prototype model 的 argmax 显著劣于 π1**，−1.167pp，CI 不含 0。
   按角色分解：**地主侧 +3.10pp（CI 含 0，方向为正但不显著）**，
   两个农民侧都是负的（−2.87pp / −3.83pp，各自 CI 不含 0）。
3. **"偏离 π1"本身是有代价的。** C arm 是一个**预登记的、结果无关的**
   任意合法动作，它比 π1 差 −3.036pp（CI 不含 0）。
   也就是说：在同一个 root 上随便换一个合法动作，平均要输 3pp。
4. **模型比"随便换一个"好，但没有好到能赢 π1。**
   model vs other 是 **+1.113pp（CI 含 0）**——
   方向与"模型学到了动作信息"一致，且与 state-action 消融的结论（动作列带来
   1.8–6.8% 的 dev MSE 下降、离散度比值 0.117–0.201 而 state-only 恰为 0.000）互相印证。
   但它只弥补了"任意偏离"与 π1 之间约 1/3 的差距。

**不说明：**

* 这**不是** SP-B1 的棋力。被评估的是一个 **prototype 模型**：
  在 `5001–5400` 的 1200 个 group 上、用 `casual`/`default` 的**廉价环境**训练出来的三模型。
  正式 batch 1 会在 **π1 环境**里、用 7500 个 group 重新训练。
  训练分布与评估分布不一致是本结果里**最大的已知混淆**。
* 因此它**没有**证明"在正确环境里训练也会输"。它证明的是
  **现有证据不支持启动正式 run**。
* 它不构成对 terminal-reward Monte-Carlo 这条机制的普遍否定。
  它是对"这一个 prototype，在这一个环境下，用这一个预算"的测量。

## 7. 一条不对称的观察

两个农民侧是负的，而 **π1 本身就是一个 farmer-only 的机制**——
production 的地主侧从未被 overlay 触碰过（`final-validation.md`: arm-A games 24,
overlay decisions on the landlord: 0）。所以：

* 地主侧：模型对的是一个**未被 π1 强化过**的对手 → delta 方向为正；
* 农民侧：模型对的是**π1 最强的地方** → delta 为负。

这个对照本身是这条线目前最有信息量的一条结果，且它是在同一个诊断、
同一批 group 上测出来的，没有跨实验拼接。
