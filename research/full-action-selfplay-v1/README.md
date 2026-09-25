> **ARCHIVE — 这条线已经结束，不再是 active research 入口。**
> 它产出的是 **AI-v2** 的地主策略（研究代号 CHEAP），已于 v0.5.0 发布。
> 现行 champion 见 [`../champions/ai-v2.json`](../champions/ai-v2.json)；
> 从这里开始读研究，请回到 [`../README.md`](../README.md)。
> 本目录中的 `cheap-integration-protocol.md`、`landlord-validation-protocol.md`、
> `rehearsal-protocol.md`、`development-pool.md` 与
> `ai-v2-release-candidate-manifest.json` **仍被代码或记录引用**，不要移动。

# Full-action self-play v1 — research line

状态：**可行性阶段（feasibility stage）**。尚无正式 corpus，尚无正式判定，
尚未分配任何 fresh seed pool。生产 `ai-v1`（π1）全程冻结且未被本线触碰。

## 1. 研究问题

> 不使用外部斗地主 AI、不使用神经网络，在**解除固定 top3/top5 动作限制**、
> 并允许地主 / 地主下家农民 / 地主上家农民三个角色从自家历史策略中自我对弈学习
> 之后，能否训练出一个相对自研 π1 有**独立整局增益**的新策略？

这是**带 π1 初始化的自我对弈**，不是 tabula rasa。本线不研究叫牌。
本线不主张：从只知道规则开始；已证明可以持续迭代很多代；已接近最优。

## 2. 与上一条机制线的区别（为什么不是它的泛化）

| | Farmer PI Factory v1（已终止） | 本线 |
| --- | --- | --- |
| 动作集合 | 旧 master 的 top3 候选 | **全部合法动作** |
| 特征 | `x(o, a, a0)`，含 35 列描述 parent action `a0` 及其差值 | `features(o, a)`，**两参数**，无 `a0` |
| 学习对象 | 单层 override 的阈值 | 每角色一个 Q 值模型 |
| 角色 | 只有农民（landlord roots untouched） | 地主 / 下家农民 / 上家农民 |
| 数据语义 | 同一 continuation 下的反事实 label | 本 batch 自己的 Monte-Carlo terminal reward |
| 终局 | REJECT 两次，DOUBLE_REJECT | — |

两者**共享基础设施，不共享抽象**。Factory 的状态机、协议、pool ledger 原样保留为研究记录
（见 `research/farmer-pi/terminal-v1.md`），本线不修改它们，也不把它们的语义揉进新代码。

## 3. 架构

```
每个角色一个 LightGBM value model：
    Q_landlord, Q_farmer_next, Q_farmer_previous
    Q_r(h, a) ≈ E[G_r | h, a; 本 batch 冻结的 continuation/对手分布]

运行时：
    enumerate ALL legal actions
      → build features(view, action) for all
      → batch score with the role model
      → choose max-Q action        （canonical tie-break，不含旧 expert ranking）

reward：地主赢 = (1, 0, 0)，农民赢 = (0, 1, 1)；gamma = 1；无炸弹倍率、无积分、无 shaping
```

三个 checkpoint 是**三个独立模型**，不构成 `M1 → M2 → M3` 的在线叠加链。

## 4. 代码位置

| 关注点 | 文件 |
| --- | --- |
| 动作 canonical identity + 独立 brute-force oracle | `benchmarks/selfplay-actions.ts` |
| state-action feature schema（无 `a0`） | `benchmarks/selfplay-features.ts` |
| 策略 / bundle / 对手 mixture | `benchmarks/selfplay-policy.ts` |
| 三角色 collector（单 learning seat、ε=0.10、keyed RNG） | `benchmarks/selfplay-collector.ts` |
| dataset / split / manifest / schema hash | `benchmarks/selfplay-dataset.ts` |
| 诊断（同状态离散度、改动作率、反事实 fork） | `benchmarks/selfplay-diagnostics.ts` |
| LightGBM 训练与导出 | `scripts/selfplay-train.py` |
| 快速 guard（进 `pnpm check`） | `tests/core/selfplay-*.test.ts` |
| 重基准与实测 | `benchmarks/selfplay-*-bench.test.ts`、`benchmarks/selfplay-rehearsal.test.ts` |

本线**不修改 `src/`**。所有新代码位于 `benchmarks/`、`scripts/`、`tests/`。

## 5. 种子纪律

可行性阶段使用 **retired 原型区间 `5001–5400`**，该区间在
`docs/research/ai-used-seed-ledger.md` 里已经登记为「仅机械 prototype 与吞吐测量，
不进入任何正式 corpus」。在此区间上产生的任何模型都标记 `DEVELOPMENT_ONLY`，
不构成棋力证据，也不得用于任何 KEEP / REVERT。

正式 3-batch research run 需要**一个新 pool + 一次新的预登记**，
且必须先通过 `feasibility.md` 的 GO 判定与 `freeze-draft.md` 的复核。

## 6. 文档

* `feasibility.md` — 可行性阶段报告（§18 结构）。
* `freeze-draft.md` — 待复核的冻结草案。
* `../farmer-pi/terminal-v1.md` — 上一条机制线的终局归档。
