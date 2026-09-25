# Landlord independent validation — report

状态：**单一候选的独立验证，已揭盲一次**。不重训、不启动 batch 2/3、
不触碰 production π1、不分配 final-validation pool。
协议见 [`landlord-validation-protocol.md`](landlord-validation-protocol.md)，
SHA-256 `6ac9ad42a92af8517300664f306948e97dd84e39da8f56ac1a1dcf3d7d1a0c64`（揭盲前冻结）。

---

## A. STATISTICAL AUDIT

对上一轮 Evaluation B 的 **sealed per-deal records**（`.local/selfplay-eval-b/merged-eval-b.json`，
3600 cells / 1200 groups，contentDigest `92428e43…`）重算。

**上一份报告的口径错误**：aggregate 把 `1200 groups × 3 roles = 3600 cells`
当作 3600 个 iid 样本。正确做法是先对每个 initial deal group 求
`D_i = (d_iL + d_iFnext + d_iFprev) / 3`，再 `SE = sd(D_i)/sqrt(N_groups)`。

**修正后的数值**（保留原口径以便对照）：

| 比较 | 原口径 (n=3600) | 修正后 (N=1200) |
| --- | --- | --- |
| TARGET − π1 | mean −0.167pp, SE 0.820pp, CI [−1.775, +1.441] | mean −0.167pp, SE **0.836pp**, CI **[−1.806, +1.473]** |
| CHEAP − π1 | mean −2.167pp, SE 0.813pp, CI [−3.760, −0.573] | mean −2.167pp, SE **0.802pp**, CI **[−3.739, −0.595]** |
| TARGET − CHEAP | mean +2.000pp, SE 0.785pp, CI [+0.461, +3.539] | mean +2.000pp, SE **0.799pp**, CI **[+0.433, +3.567]** |

**点估计完全不变**（同样的 3600 个观测，同样的权重），只有 SE 变。
数值影响很小（0.785 → 0.799，约 2%），原因是**这个设计里每个 deal 的三个 cell
不是同一局的三次测量**：三个 role 用的是**不同的 landlord 分配**，
因而不是聚类样本而更接近三次独立观测。实测 `sd(D_i) = 28.975pp`，
若三个 role 独立应为 `sd(role)/sqrt(3) ≈ 31.8pp` —— 观察值略小，说明有轻微正相关，
但远不足以让 iid 假设失效到改变结论。

**方法错了，结论没变**：三条比较的显著性判定在新旧口径下**完全一致**。
原口径仍然应当被记录为错误，本文即为其 provenance。

**landlord role 的数字从未受影响**：上一份报告里 landlord 那一行本来就是
`N 1200`、deal-level 的，本次逐项重算完全相符（见 §B）。

## B. CORRECTED DEVELOPMENT ROLE RESULTS

`N = 1200` per role（每个 initial deal group 恰好一个 paired observation），
全部从 sealed records 重算：

| role | 比较 | mean | sd(D_i) | SE | 95% CI | better/worse/tie |
| --- | --- | ---: | ---: | ---: | --- | --- |
| landlord | TARGET − π1 | **+13.250pp** | 55.094pp | 1.590pp | [+10.133, +16.367] | 272 / 113 / 815 |
| landlord | CHEAP − π1 | +11.833pp | 52.557pp | 1.517pp | [+8.860, +14.807] | 245 / 103 / 852 |
| landlord | TARGET − CHEAP | +1.417pp | 52.681pp | 1.521pp | [−1.564, +4.397] | 175 / 158 / 867 |
| farmer-next | TARGET − π1 | −8.417pp | 45.890pp | 1.325pp | [−11.013, −5.820] | 80 / 181 / 939 |
| farmer-next | CHEAP − π1 | −6.583pp | 44.534pp | 1.286pp | [−9.103, −4.064] | 82 / 161 / 957 |
| farmer-next | TARGET − CHEAP | −1.833pp | 44.328pp | 1.280pp | [−4.341, +0.675] | 107 / 129 / 964 |
| farmer-previous | TARGET − π1 | −5.333pp | 43.086pp | 1.244pp | [−7.771, −2.895] | 81 / 145 / 974 |
| farmer-previous | CHEAP − π1 | −11.750pp | 45.702pp | 1.319pp | [−14.336, −9.164] | 63 / 204 / 933 |
| farmer-previous | TARGET − CHEAP | **+6.417pp** | 43.421pp | 1.253pp | [+3.960, +8.873] | 154 / 77 / 969 |

**landlord hypothesis 的产生过程必须记录**：`+13.250pp` 是在看到 role breakdown
**之后**被选中的，属于 post-development selection，不是正式证据。本轮 (§I) 是
它的第一次 confirmatory test。

## C. FROZEN LANDLORD CANDIDATE MANIFEST

```
candidateId        landlord-independent-validation-v1/candidate-target-landlord
modelSha256        7ad463175b54d632c1d3e7ad1b15af3cfd0c454b96b39f73f636254a964b98a9
rawBytes           2,040,850           numTrees 512        numFeatures 403
lightgbmVersion    4.6.0
manifestSha256     19e528061368ec32f62a5369e43c99d74815f125a963f9cd36e0ed02194afdc0
```

```
featureSchema      v1, 403 columns, schemaHash 502946fd…
history            recent 12 public events
actionIdentity     fas-action-identity-v1
canonicalOrder     generateLegalActions order
tieBreak           highest score; ties to earliest position; never resolves to pass
enumerator         7f1645eee455c4bcfcb6e9a984286e830005f83c7afc8a45a4b4667f5ede3c18
treeEvaluator      43bc62798482e234fbaf6148e1e62a08b912876503d261451c3f5b089084a77f
training           deal range 907001–913000, 6000 groups, TARGET environment manifest
training commit    d196765
```

**Baseline 按真实身份命名**（π1 是 farmer-only，它的地主席位不是"弱化版 π1"，
而是另一条代码路径）：

```
PRIMARY baseline landlord
  production master tier, cf overlay NOT installed
  a6ae8a6aebd31e88172a12a64845284f799b1487abc07a49d934188a0cee89e3
  (src/app/ai/decision-handler.ts)
  —— 与旧 FPI 协议记录的 "strong seat" identity 逐字相符

π1 farmers（PRIMARY 环境另外两个 seat）
  pi1;chain=ai-v1;tier=master;schema=0ec9d20f…    model 010a8a4a…    threshold 0.01

SECONDARY baseline farmers（old/default）
  2a39386007949cf1c37010c1d97f61e8468a3d41b44df50cebf70c9cc46b7297
  (src/core/ai/index.ts — DEFAULT_AI_STRATEGY)
  —— 与旧 FPI 协议记录的 "teammate (tau) / landlord (lambda)" identity 逐字相符

rules          04e4814a781412b490b6acbbca1bc1e4226a90713a920ad8c9f7a5d6ca1056d6
dealGenerator  8202c1334d58e3b858ff4d7850b35fc2b9edb31f60759c9236ce2fadc2acf86a
```

## D. STANDALONE EQUIVALENCE

从完整 TARGET bundle 中单独加载 landlord model，在 8 个 retired deal 的
**109 个真实地主 state** 上比较**最终执行的 command**（不是 raw tree score）：

```
mismatches 0
coverage  leading 26  responding 83  passOffered 83  bombOrRocketAvailable 4
          attachmentAvailable 17  largeActionSet(>=30) 11  canEmptyHand 2
```

每个类别都被真正走到，"0 mismatch" 不是空断言。

**这一步发现并修掉了一个真实缺口**：`scoreTrees` 不校验 row 宽度——它只是把叶子相加。
一个用别的 schema 训练的模型不会报错，它会**读错列并给出一个自信的数字**。
现在 `scoreLegalActions` 在每次决策时校验 `row.length === model.numFeatures`，
不匹配即 **hard throw**，绝不静默回退到 incumbent。

**tie / near-tie**（加入 `pnpm check` 的常驻 guard）：
- 精确平局：constant model ⇒ 全部同分 ⇒ 取 canonical order 中位置最靠前者，可复现；
- 近平局：两叶相差 `1e-9` ⇒ 取分高者，**即使它在更后面**；
- 平局永不落到 `pass`（顺序以 pass 结尾）。

## E. LANDLORD RUNTIME / ASSET COST

109 个真实地主 decision，单模型、无 pruning、无 topK：

```
legal actions   p50 1.0   p95 49.4   p99 111.0   max 117
enumerate ms    p50 0.098  p95 0.272  max 0.632
features ms     p50 0.022  p95 0.410  max 0.996
scoring ms      p50 0.071  p95 1.849  max 4.691
total ms        p50 0.189  p95 2.508  p99 5.826  max 6.107
```

体积（直接测 actual landlord artifact，不用 3 模型 ÷ 3）：

| 口径 | raw | gzip -9 |
| --- | ---: | ---: |
| **landlord model（本候选）** | 2,040,850 B = **2.041 MB** | 455,080 B = **444.4 KB** |
| π1 farmer（现有 production） | 507,631 B = 0.508 MB | 111.6 KB |
| **combined assets（新地主 + 现有 π1 farmer）** | 2,548,481 B = **2.548 MB** | **553.0 KB** |
| 旧 worker bundle gzip 预算 | — | 123,575 B |

**landlord 单独就是旧预算的 3.6×；合计是 4.5×。**

结论按本轮要求记录：**strength validation possible; deployment not yet qualified.**
本轮**没有**做 pruning / compression / quantization / 减树 / feature selection /
topK prefilter，也不因体积调整任何配置。

## F. POWER CALCULATION

用上一轮 development **地主 role 的 deal-level paired D_i** 做 planning：

```
sd(D_i) = 55.0936pp      var = 0.303530      N_dev = 1200
z = 1.96 + 0.84 = 2.80
planning effect = +5pp
N_req = (2.80^2 * 0.303530) / 0.05^2 = 951.8  ->  952
```

`N_req = 952 <= 2400` **⇒ 冻结 N = 2400**，不因为理论上可以更少而减 N。
`+5pp` 只是 planning 用量，不是收益预测。
工程门槛冻结为 **+2.00pp**（PASS 的 point-estimate 要求）。

## G. VALIDATION PROTOCOL + SHA

```
research/full-action-selfplay-v1/landlord-validation-protocol.md
sha256 6ac9ad42a92af8517300664f306948e97dd84e39da8f56ac1a1dcf3d7d1a0c64
```

冻结于**分配 fresh pool 与读取任何新 outcome 之前**。seal 里记录了同一个 hash。

## H. FRESH POOL PROVENANCE

namespace **`landlord-independent-validation-v1`**，保留 `950001–960000`，
本次分配 **`950001–952400`（2400 groups）**。

与全部历史范围的交集**逐条核对，全部为 0**：

```
301-700 · 5001-5400 · 5001-6200 · 10001-10400 · 20001-20400 · 30001-30400 · 40001-41200
50001-70000 · 70001-78000 · 100001-120000 · 120001-120200 · 130001-131200
140001-160000 · 160001-160200 · 170001-171200
factory-v1 attempt-001 200001-215000 · attempt-002 225001-244000
FAS: 900001-906000 · 907001-913000 · 913001-914500 · 915001-916200 · 919001-919200
```

分配前历史最大 deal index = **919200**；新池起点 950001。
该池自分配起**永久不得**用于 training / model selection / feature tuning /
compression tuning / threshold tuning。

## I. PRIMARY INDEPENDENT RESULT

```
N 2400（每个 registered group 都进入分母，0 excluded）
baseline win rate   27.542%
candidate win rate  37.417%
delta               +9.875pp
sd(D_i)             53.459pp
SE                  1.091pp
95% CI              [+7.736pp, +12.014pp]
better / worse / tie   473 / 236 / 1691
```

**这是第一次 confirmatory test，用的是从未用于任何训练或选择的 2400 个 fresh groups。**
landlord baseline 在这一环境下只赢 27.5% —— π1 的 farmers 是很强的对手。

## J. SECONDARY GENERALIZATION RESULT

同一批 2400 groups，另外两个 seat 换成 frozen old/default farmers：

```
N 2400
baseline win rate   49.208%
candidate win rate  46.333%
delta               -2.875pp
SE                  1.122pp
95% CI              [-5.074pp, -0.676pp]
better / worse / tie   329 / 398 / 1673
```

**显著为负。** 协议 §8 预登记的分支被触发：

> `landlord candidate is environment-specific; product generalization unresolved`

**不是**自动 production candidate。PRIMARY PASS 不能替代它。
这个数字**不得**与旧的 58.9% benchmark 做算术相加。

## K. INTEGRITY / RESUME REPORT

```
checkpoints        2400 / 2400，missing 0，extra 0
content digest     443bd6c755703fe4…（对排序后的 per-group 记录求 hash，与调度无关）
seal verification  records 2400/2400, digest MATCHES, candidate 7ad463175b54d632…,
                   protocol 6ac9ad42a92af851…（verify 在 reveal 之前跑，且不打印任何 outcome）
candidate decisions  27,256；baseline decisions 27,653
每个 group 的候选决策数  最小 3（地主每局至少 3 次决策），0 个 group 没有候选决策
含义：没有 "candidate 从未真正接管" 的 group，也没有静默回退的迹象
resume             已实测：同一窗口重跑 ⇒ 0 completed / N resumed，不重写 completed deals
exclusions         0。没有 integrity failure，没有 post-hoc exclusion
```

运行期间 console 只输出 progress / 吞吐 / elapsed / ETA / shard 计数（`[lv]` 前缀行）；
wins / deltas / CI / role rate **一次都没有出现**，PRIMARY 与 SECONDARY 同时 seal 后
才执行唯一一次 `reveal`。

## L. PRE-REGISTERED VERDICT

按协议 §9 的规则机械判定：

```
PRIMARY  mean +9.875pp >= +2.00pp   且   CI lower +7.736pp > 0
   ⇒  RESEARCH PASS
```

**含义**：存在独立正向证据，且 point estimate 达到预登记的工程门槛。
**不等于**"已证明真实地主提升至少 2pp"。

SECONDARY 同时触发 generalization 警告，因此本轮结论是：

```
RESEARCH PASS on the pre-registered primary hypothesis
+ landlord candidate is environment-specific; product generalization unresolved
```

## M. NEXT-STEP RECOMMENDATION

**不建议自动 production-promote。** 按本轮预登记的路径，下一步**只**做三件事：

1. **landlord integration prototype**（不发布）：在真实 Worker / deadline / 运行时长
   约束下跑通地主接管，measure retention。
2. **real Worker / deadline / runtime retention**：现状是 **deployment not yet qualified** ——
   landlord 单独 444.4 KB gzip，合计 553.0 KB，是旧预算 123,575 B 的 4.5×。
   total 延迟 p95 2.508 ms / p99 5.826 ms（research 路径，单线程，无 pruning），
   必须放进真实预算里重新测。
3. **product-level role / generalization checks**：SECONDARY 的 −2.875pp 说明这个地主
   是针对 π1 farmer 环境调出来的。任何产品化提案都必须先回答
   "它面对 `default` farmers 时为什么变差"，且**不得**用 PRIMARY 的数字覆盖它。

**不做**：farmer retraining、credit-assignment 实验、C3/C5 mask attribution、
新 self-play batch、batch 2/3、policy pool expansion。农民机制问题留在 development backlog。

研究记录中的状态（按本轮 §14 的要求）：

```
three-role first-batch candidate:  not suitable for whole-bundle advancement
landlord branch:                   RESEARCH PASS on independent fresh validation
farmer branches:                   insufficient evidence to justify further scaling
production π1:                     unchanged
```

## N. COMMIT / WORKTREE STATE

本轮新增：`benchmarks/selfplay-landlord-candidate.test.ts`（manifest）、
`benchmarks/selfplay-landlord-standalone.test.ts`（equivalence + runtime）、
`benchmarks/selfplay-landlord-validation.test.ts`（validation shard）、
`scripts/selfplay-landlord-validation.mjs`（run / verify / reveal）、
本报告与 `landlord-validation-protocol.md`；
`benchmarks/selfplay-policy.ts` 增加 row-width hard-fail；
`tests/core/selfplay-policy.test.ts` 增加 tie / near-tie 常驻 guard。

**未触碰**：`src/**`、production `ai-v1`、旧 FPI 的任何文件或 ledger 行。
