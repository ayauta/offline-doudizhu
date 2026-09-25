# CHEAP landlord — joint dual-environment independent confirmation

状态：**单一候选的独立确认**。不重新训练，不训练第三个 landlord，不碰 farmers，
不修改 production π1。

冻结时间：2026-09-25，**在分配 fresh pool 与读取任何新 outcome 之前**。

它回答 Decision Node 1：

> 现有 CHEAP landlord 是否具有独立确认的产品研究价值？

---

## 1. 候选与 baseline 的身份（从真实 artifact 读取）

```
candidateId      landlord-robust-confirmation-v1/candidate-cheap-landlord
modelSha256      070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b
rawBytes         2,019,876 = 2.020 MB
gzipBytes        450,524 = 440.0 KB        (node zlib.gzipSync, level 9)
numTrees 512     numFeatures 403          lightgbmVersion 4.6.0
featureNames     与 SELFPLAY_FEATURE_NAMES 逐项相同（403）
training         907001–913000, 6000 groups, CHEAP environment manifest, commit d196765
```

混合身份（全部从磁盘重新计算，不是转抄）：

```
schemaHash        502946fd7e880422dd13dde49fcb25afdb63e16269a2ef56357432f72aa509cf
                  SELFPLAY_FEATURE_SCHEMA_VERSION = 1, datasetVersion fas-dataset-v1
historyLength     12
actionIdentity    fas-action-identity-v1
collector         fas-collector-v1
enumerator        7f1645eee455c4bcfcb6e9a984286e830005f83c7afc8a45a4b4667f5ede3c18
treeEvaluator     43bc62798482e234fbaf6148e1e62a08b912876503d261451c3f5b089084a77f
gameRules         04e4814a781412b490b6acbbca1bc1e4226a90713a920ad8c9f7a5d6ca1056d6
dealGenerator     8202c1334d58e3b858ff4d7850b35fc2b9edb31f60759c9236ce2fadc2acf86a
canonicalOrder    generateLegalActions order
tieBreak          highest score; ties to earliest position; never resolves to pass
```

Baseline 与两个环境的对手：

```
baseline landlord        production master tier, overlay NOT installed
                         a6ae8a6aebd31e88172a12a64845284f799b1487abc07a49d934188a0cee89e3
pi1 farmer               pi1;chain=ai-v1;tier=master;schema=0ec9d20f…
                         champion model 010a8a4a…, threshold 0.01
DEFAULT_AI_STRATEGY      (旧 default tier)  2a39386007949cf1c37010c1d97f61e8468a3d41b44df50cebf70c9cc46b7297
```

**CHEAP standalone equivalence 必须仍为 0 mismatch**（109 个真实地主 state，
覆盖 leading / responding / pass / bomb-rocket / attachment / wide set）。
任何 identity 不一致 ⇒ **STOP，不分配 fresh pool**。

## 2. Fresh pool

namespace **`landlord-robust-confirmation-v1`**，分配 **`952401–958400`**，
恰好 **6000** 个 initial deal groups。

与**全部 31 个历史区间**（含 `950001–952400`，TARGET independent validation，已 RETIRED）
的交集逐条核对 **= 0**。分配前历史最大 deal index = 952400。

该池用毕即永久 RETIRED，不得再用于任何 KEEP / REVERT 或 candidate selection。

## 3. 设计

**同一批 6000 个 initial deals 同时服务两个环境。** 每个 group 在两个环境各一对：

```
Environment A（strong farmers）
  A0  baseline landlord + frozen pi1 farmer-next + frozen pi1 farmer-previous
  A1  CHEAP  landlord  + 完全相同的 pi1 farmers

Environment B（default farmers）
  B0  baseline landlord + frozen DEFAULT farmer-next + frozen DEFAULT farmer-previous
  B1  CHEAP  landlord  + 完全相同的 DEFAULT farmers
```

* exploration **OFF**；landlord 控制**每一次**地主 decision；
* 无 root / useful-state filtering；无 topK fallback；无 threshold tuning；
* 同一对内 initial deal 完全相同；两个环境用**同一个 landlord 分配语义**
  （`scenarioSpec(dealIndex,"L")`）；
* 每个 registered group 都进入分母；**唯一允许的 exclusion 是预登记的 integrity failure**，
  且必须逐条列出原因；
* 不允许换 candidate、不允许看到中间结果后改任何东西。

统计单位恒为 **initial deal group**。
**不构造 mixed average 作为晋级主指标** —— 两个环境分开判定。

## 4. Environment A 判定（预登记）

```
D_Ai = W(CHEAP landlord vs pi1/pi1) - W(baseline landlord vs pi1/pi1)
```

```
A_PASS                      point estimate >= +2.00pp
                            且 two-sided 95% CI lower bound > 0
A_BELOW_ENGINEERING_TARGET  95% CI upper bound < +2.00pp
A_INCONCLUSIVE              其余
```

## 5. Environment B non-inferiority 判定（预登记）

本轮冻结 engineering margin **−1.00pp**：

```
D_Bi = W(CHEAP landlord vs default/default) - W(baseline landlord vs default/default)

B_NI_PASS        two-sided 95% CI lower bound > −1.00pp
B_INFERIOR       95% CI upper bound < −1.00pp
B_INCONCLUSIVE   其余
```

**`CI contains 0` 既不代表失败，也不自动代表 non-inferior。**
关心的是**下界相对 −1pp 的位置**。
`−1pp` 是本轮预先接受的 engineering tolerance，不是数学真理，
**结果出来以后不允许修改**。

## 6. Joint verdict（预登记）

```
A_PASS  AND  B_NI_PASS        -> JOINT RESEARCH PASS
A_BELOW_ENGINEERING_TARGET
  或 B_INFERIOR               -> JOINT NO-GO
其余未满足全部条件            -> JOINT INCONCLUSIVE
```

`JOINT RESEARCH PASS` 的含义**仅**为：

> CHEAP 在 fresh data 上确认了对 π1 farmers 的正向增益，
> 同时在预登记 −1pp margin 下没有可检测的不可接受 default regression。

**不得**表述为 "CHEAP 对所有 opponent universally stronger"。

**无论哪种结果：禁止临时追加 N。6000 groups 跑完即结束 confirmatory experiment。**
`INCONCLUSIVE` 是合法科研结果，不为了消除它扩到 20k+ groups。

## 7. No-peek / seal

运行中 console 只允许输出：progress、completed/total、wall time、throughput、
worker status、checkpoint count、integrity error。

**禁止输出**：candidate wins、baseline wins、running delta、running CI、
环境分别的部分结果、joint status。

A、B 两环境**全部完成**后：`verify → seal → verify hashes → reveal once`。
A 先跑完也不提前查看。

## 8. Reproducibility

使用已验证 deterministic 的 **8-worker** path（`digest 52eed2f7…` 在 1/4/8 三档相同）。
要求：worker count 不影响 RNG；shard assignment 不影响 deal/role；
canonical merge；deal-level checkpoint；resume 不重写 completed group；
scientific-content digest 与调度无关。**不为本次验证重写 runner。**

## 9. 本轮不做

farmer retraining、第三个 landlord、hyperparameter sweep、LightGBM 替换、
feature / epsilon / history-length / reward 改动、C3/C5 attribution、
model compression、production 修改。Node 2 只出 memo。
