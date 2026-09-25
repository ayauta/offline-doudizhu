# CHEAP landlord — joint dual-environment independent confirmation

状态：**已揭盲一次**。不重训，不训练第三个 landlord，不碰 farmers，production π1 未变。
协议见 [`landlord-robust-confirmation-protocol.md`](landlord-robust-confirmation-protocol.md)，
SHA-256 `81fbd4f647ac3e404892fddc603889f7538daa586112e960c32e0cf6a10ae7b7`（跑前冻结）。

---

## A. CANDIDATE / BASELINE IDENTITY

```
candidateId    landlord-robust-confirmation-v1/candidate-cheap-landlord
modelSha256    070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b
rawBytes       2,019,876 = 2.020 MB      gzipBytes 450,524 = 440.0 KB  (node zlib, level 9)
numTrees 512   numFeatures 403           lightgbm 4.6.0
schemaHash     502946fd7e880422dd13dde49fcb25afdb63e16269a2ef56357432f72aa509cf
historyLength  12    actionIdentity fas-action-identity-v1    collector fas-collector-v1
enumerator     7f1645eee455c4bcfcb6e9a984286e830005f83c7afc8a45a4b4667f5ede3c18
treeEvaluator  43bc62798482e234fbaf6148e1e62a08b912876503d261451c3f5b089084a77f
canonicalOrder generateLegalActions order
tieBreak       highest score; ties to earliest position; never resolves to pass
training       907001–913000, 6000 groups, CHEAP environment manifest, commit d196765
```

```
baseline landlord      production master tier, overlay NOT installed
                       a6ae8a6aebd31e88172a12a64845284f799b1487abc07a49d934188a0cee89e3
pi1 farmer             pi1;chain=ai-v1;tier=master;schema=0ec9d20f…   model 010a8a4a…  threshold 0.01
DEFAULT_AI_STRATEGY    2a39386007949cf1c37010c1d97f61e8468a3d41b44df50cebf70c9cc46b7297
gameRules              04e4814a781412b490b6acbbca1bc1e4226a90713a920ad8c9f7a5d6ca1056d6
dealGenerator          8202c1334d58e3b858ff4d7850b35fc2b9edb31f60759c9236ce2fadc2acf86a
```

**CHEAP standalone equivalence 仍然 0 mismatch**（109 个真实地主 state，
leading 26 / responding 83 / pass 83 / bomb-rocket 4 / attachment 17 / wide set 11 / canEmptyHand 2）。

### A.1 gzip 口径更正

`gzip` 字节数**依赖压缩器实现**：同一个文件，python `gzip.compress(raw, 9)` 得 462,403 B，
node `zlib.gzipSync(raw, {level:9})` 得 450,524 B（差 2.6%）。两者各自可复现。
**本报告统一使用 node zlib level 9**，并在体积表里标注。

---

## B. PROTOCOL SHA

```
research/full-action-selfplay-v1/landlord-robust-confirmation-protocol.md
sha256 81fbd4f647ac3e404892fddc603889f7538daa586112e960c32e0cf6a10ae7b7
```
冻结于分配 pool 与读取任何新 outcome 之前；seal 内记录同一个 hash。

## C. FRESH POOL PROVENANCE

namespace **`landlord-robust-confirmation-v1`**，分配 **`952401–958400`**（6000 groups）。
落在本线已声明的 `950001–960000` 保留区内、且紧接已 RETIRED 的
`950001–952400`（TARGET independent validation）之后。
与**全部 31 个历史区间**逐条核对 **交集 = 0**；分配前历史最大 deal index = 952400。
该池用毕即永久 RETIRED。

## D. ENVIRONMENT A RESULT

```
N 6000        （每个 registered group 进入分母，0 excluded）
baseline 29.583%      CHEAP 38.983%
delta +9.400pp    sd 53.840pp    SE 0.695pp    95% CI [+8.038pp, +10.762pp]
better 1178 / worse 614 / tie 4208
VERDICT  A_PASS
```
（判据：point ≥ +2.00pp **且** CI 下界 > 0。两个条件都满足。）

## E. ENVIRONMENT B RESULT

```
N 6000
baseline 50.883%      CHEAP 54.333%
delta +3.450pp    sd 54.957pp    SE 0.709pp    95% CI [+2.059pp, +4.841pp]
better 1013 / worse 806 / tie 4181
VERDICT  B_NI_PASS
```
（判据：CI 下界 > −1.00pp。实测下界 **+2.059pp**，比 NI margin 强得多——
这个区间不仅不含 −1pp，它连 0 都不含。）

## F. JOINT PRE-REGISTERED VERDICT

```
A_PASS  AND  B_NI_PASS   ->   JOINT RESEARCH PASS
```

含义**仅**为：

> CHEAP 在 fresh data 上确认了对 π1 farmers 的正向增益，
> 同时在预登记 −1pp margin 下没有可检测的不可接受 default regression。

**不得**表述为 "CHEAP 对所有 opponent universally stronger"。

### F.1 与开发期数字的关系（都保留，不挑好看的）

| | 开发池 `915001–916200`（N=1200） | 确认池 `952401–958400`（N=6000） |
| --- | --- | --- |
| env A | +7.000pp [+4.031, +9.969] | **+9.400pp [+8.038, +10.762]** |
| env B | +2.667pp [−0.421, +5.755] | **+3.450pp [+2.059, +4.841]** |

两个环境在两个池上**方向一致**；确认池上两个环境都变强且都显著。
开发池 env B 含 0，确认池 env B 不含 0 —— 这正是"开发池不能当确认"的例子。

### F.2 与 TARGET 的关系

TARGET 的独立验证（`950001–952400`，N=2400）是 env A **+9.875pp**、env B **−2.875pp**。
CHEAP 的确认（不同池、N=6000）是 env A **+9.400pp**、env B **+3.450pp**。
**两个池不可直接相减**；可比的只有开发池上的 paired 对比
（CHEAP−TARGET：env A −2.667pp [−5.685, +0.351]；env B **+4.750pp [+1.727, +7.773]**）。
**结论**：CHEAP 在 env A 与 TARGET 相当（差值 CI 含 0），在 env B 明显更好。

**不得**与本项目旧的 58.9% combined benchmark 做算术相加。

## G. INTEGRITY / RESUME / DIGEST

```
checkpoints      6000 / 6000    missing 0    extra 0
content digest   36bb01a0d95cfe69…（对排序后的 per-group 记录求 hash，与调度无关）
seal verify      records 6000/6000, digest MATCHES, candidate 070f5b0b728176a8…,
                 protocol 81fbd4f647ac3e40…   （verify 在 reveal 之前，且不打印 outcome）
exclusions       0 —— 没有 integrity failure，没有 post-hoc exclusion
resume           已由 harness 的 checkpoint 机制保证；本轮 0 resumed（一次跑完）
吞吐盲态         运行中 console 只有 [lrc] progress 行；wins/deltas/CI/joint status 一次未出现
```

## H. ACTUAL WALL TIME

```
6000 groups × 4 games = 24,000 games
wall 59.7 min @ 8 workers   ->  100.5 groups/min, ~402 games/min
（对比：TARGET 环境 batch 实测 46.7 groups/min @8w；本轮含一半廉价 default-环境局）
```
