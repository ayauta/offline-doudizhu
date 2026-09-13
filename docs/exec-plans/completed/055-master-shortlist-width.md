# Execution Plan 055-A: Widen the Master Shortlist

Status: Completed — 被预注册判据拒绝；出厂行为已恢复
Started: 2026-09-13
Spec: [055-stronger-local-ai](../../specs/055-stronger-local-ai/spec.md)

## 为什么是这个变量

大师的候选集是 `expert.slice(0, 3)`（`src/core/ai/master-policy.ts:270`）。
高手的排序被 `defaultPolicyPrior`（`src/core/ai/scoring-policy.ts:185-190`）
强锚在默认排序上——默认第 0 名先白拿 +1920 分，第 3 名 +1440，第 11 名 +160，
而「少一手牌」值 260 分。所以大师实际上只能在一张**默认本来就喜欢的、
三个选项的清单**里挑。

2026-09-12 首次测出 `master vs default = 53.2% [51.9%, 54.5%]`
（400 副 / 2400 局，种子 301–700），而 rollout 只在 **6.9%（12/174）**
的决策上推翻高手的首选——它的全部优势都来自这一小部分决策。

**深度已经被试过两次，两次都是逐值零改动**（023 改效用函数形状、
024 改 rollout 的策略节点额度）。**宽度一次都没试过。**

这不是重跑 023/024：那两次改的是 rollout 内部的节点分配与价值函数形状，
本次改的是**哪些动作有资格进入 rollout**。

## 预注册判据

**唯一变量。** `src/core/ai/master-policy.ts:270` 的候选上限由 `3` 变 `8`。
其余一律不动：`maxWorlds`(32)、`rolloutDepth`(3)、`rootAnalyzerNodes`(220)、
`:305` 的 0.2 混合阻尼、`defaultPolicyPrior`、`rootUtility` 的形状、
rollout 策略的 `analyzerNodes: 8`、`decision-handler.ts` 的 120 ms 预算。

**主指标。** 同一批副牌（种子 301–700）上 `master vs default` 的**逐副配对**
增量。逐副数组由
[`arm-run.probe.test.ts`](../../benchmarks/diagnosis/arm-run.probe.test.ts)
写出，改动前后各跑一次同配置。

**采用当且仅当** 配对 95% 区间的下界 **> 0**（放宽确实提高大师胜率），
且 `pnpm check` 通过，且开发机 master 的 p99 不撞穿 480 ms 响应窗口。

**否则拒绝并回滚。** "宽度这个杠杆没用"本身就是有价值的答案：它会把
"基于搜索的方向还能不能再挖"这个问题关掉，而不是留着一个没试过的选项。

**同时报告、但不作为判据：** 分角色（地主／农民）增量、大师的截断率变化、
rollout 推翻高手首选的次数变化（`rootLeaderDiffers`）。

## 已知局限（写在测量之前）

1. 逐副配对消得掉副牌带来的方差，消不掉 harness 的墙钟截断路径
   （`shouldStop` 不严格确定）。023 记录过同代码同配置两次运行差 0.458 个百分点。
2. **若结果为负或零，有两种解释无法用本次实验区分**：搜索确实没货了，
   或者 `rootUtility` 太粗、用不了更多候选（候选放多了反而挑错）。
   区分二者需要另一次改价值函数的实验。本次不试图区分。
3. 候选从 3 到 8 会把每个世界的 rollout 成本乘约 2.7，
   在 120 ms 预算下截断率会上升。截断本身**不是**判据，但要记录——
   若截断严重到 rollout 跑不完第一个世界，那测的就不是"宽度"。

## 步骤

1. [x] 捕获改动前的基线逐副数据。
2. [x] 只改候选上限，其余不动。
3. [x] 同配置复跑，逐副比较。
4. [x] **按判据拒绝并回滚。** 出厂行为已恢复。

`git diff --stat src/` 之后为空；`master-policy.ts:270` 回到 `Math.min(3, ...)`。

## 完成证据

两次运行各 400 副牌、种子 301–700、`stoppedEarly=false`，
逐副数组各 400 个，配对比较用同一批副牌：

| | 出厂（3 候选） | 放宽（8 候选） |
| --- | --- | --- |
| 强方胜率 | 53.167% | 53.417% |
| 配对增量 | — | **+0.25 个百分点** |
| bootstrap 95% 区间 | — | **[-0.08, +0.58]** |
| t 95% 区间 | — | **[-0.10, +0.60]** |
| 逐副差值 sd | — | 0.0353 |
| 结果变了的副牌 | — | 18/400（12 好、6 坏、**382 副逐值相同**） |

区间跨过 0，判据不成立。**改变选择的副牌只有 4.5%**，其中 382 副连结果都完全一样。

代价同时变差（开发机 shipped-path 探针，改动前 → 改动后）：

| 指标 | 3 候选 | 8 候选 |
| --- | --- | --- |
| 400 副牌计算耗时 | 1794 s | 2131 s（+19%） |
| master 撞穿 120 ms 预算 | 22.4% | 33.3% |
| overshoot p99 | 5.31 ms | 10.50 ms |
| rollout 完成 world 数 p10 | 27.0 | 10.3 |
| master p50 | 59.90 ms | 43.45 ms |
| 480 ms 窗口余量 | 3.8x | 3.7x |

（ARM 日志里的 `7126 s` 是 `Date.now()` 墙钟值，含机器休眠；vitest 的
2131 s 来自单调时钟，是真实计算时间，两者差值不影响逐副配对。）

**为什么这条没通过，以及它关掉了什么。** 与 023（效用函数形状）和 024
（rollout 策略节点额度）的逐值零改动合起来看，滚动搜索的三个杠杆——深度、
策略额度、候选宽度——现在都被测过且都没有收益。大师 6.9% 的翻盘率**不是**
被候选数限制的。

**本次没能区分的：** 预注册里第 2 条局限成立——p10 的 world 完成数从 27.0
掉到 10.3，说明放宽后的搜索有一部分没跑完，所以"搜索没货了"与"价值函数
太粗、用不了更多候选"这一次仍然无法分开。若要继续，下一个该动的是
`rootUtility`（`master-policy.ts:210-230`），而不是搜索的任何一个旋钮。

## 命令

```bash
source scripts/activate-toolchain.sh

# 基线（出厂代码）
AI_ARM_LABEL=widen-baseline AI_ARM_SEED=301 AI_ARM_DEALS=400 AI_ARM_SECONDS=3000 \
AI_ARM_PAIRS=master:default \
AI_ARM_OUT=.local/harvest/055-widen-baseline.json \
  vitest run --config vitest.harvest.config.ts --reporter=verbose \
    --testTimeout=6000000 benchmarks/diagnosis/arm-run.probe.test.ts

# 改动后（同上，只换 label 与 OUT）
```

`AI_ARM_PAIRS` 按 **`stronger:weaker`** 读取（与 `AI_BENCH_PAIRS` 相反）。
必须显式给文件过滤器，否则 harvest 配置会把 `benchmarks/diagnosis/` 下
12 个探针全部加载。`arm-run` 自带 1,800,000 ms 超时，400 副牌的大师约需
29 分钟，必须用 `--testTimeout` 抬高。
