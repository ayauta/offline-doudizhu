# Landlord artifact / training-distribution audit, and the 2×2 development matrix

状态：**audit + development candidate comparison**。不训练任何模型，不分配新 pool，
不触碰 production π1。`landlord-independent-validation-v1` 池（`950001–952400`）
**已 RETIRED**，本报告不读它。

---

## A. SHA / ARTIFACT IDENTITY AUDIT

逐字读取六个位置，全部 64 hex：

| 位置 | 值 |
| --- | --- |
| 1. 真实 model 文件 `.local/selfplay-reh/TARGET/train-input/landlord.model.json` | `7ad463175b54d632c1d3e7ad1b15af3cfd0c454b96b39f73f636254a964b98a9` |
| 2. candidate manifest `.candidate.modelSha256` | `7ad463175b54d632c1d3e7ad1b15af3cfd0c454b96b39f73f636254a964b98a9` |
| 3. protocol 引用 | `7ad463175b54d632c1d3e7ad1b15af3cfd0c454b96b39f73f636254a964b98a9` |
| 4. seal `.candidateSha256` | `7ad463175b54d632c1d3e7ad1b15af3cfd0c454b96b39f73f636254a964b98a9` |
| 5. 报告文件（§C 行 / §K 行） | `7ad463175b54d632c1d3e7ad1b15af3cfd0c454b96b39f73f636254a964b98a9` |
| 6. manifest 内 `.artifactModelSha256` | `dfc35a05e67e712476c785454240ea1686ffd6ed46714a6bb4af4e2cea5bb48b` |

**判定：artifact / manifest / seal / protocol / 报告文件完全一致。scientific result 保持 valid。**

`7ad463175b64…` **不出现在任何一个 artifact 里**（grep 全部为 False）。
它是**我在上一条聊天消息里手打的 12 字符前缀**，把 `…5b54d632` 抄成了 `…5b64`。
**不是** artifact 不一致，**不是** typo in a document —— 文档里从来没有出现过它。

因此按 §1 的规则：只做 documentation correction（见 §N 的 commit）。

### A.1 两个必须写下来的 digest 约定（都是我的工具造成的）

审计过程中发现两个**不是**不一致、但会让 `sha256sum` 对不上的约定：

1. **`candidate-manifest.sha256` sidecar 哈希的是 JSON 文本本身，而文件是文本 + 一个换行。**
   实测：`sha256(file bytes)` = `8522e6c08fdf2fad902c161b1bb1497c214a582a89326b6aed5d76eac7c1b412`，
   而 sidecar 记的是 `sha256(text without trailing \n)` = `19e528061368ec32f62a5369e43c99d74815f125a963f9cd36e0ed02194afdc0`。
   验证方式：`head -c -1 candidate-manifest.json | sha256sum`。
   **不修 writer**：protocol §2 引用的是 `19e52806…`，而 protocol 的 SHA 已被 seal 记录；
   改 writer 会让 protocol 失效。冻结约定，不改代码。
2. **模型 JSON 内部的 `modelSha256` 是自指 digest**（先写文件、再算 hash、再把 hash 写回文件），
   所以它等于"插入该字段之前那份文件的 hash"，`sha256sum` 永远对不上。
   正确的身份是**外层** `modelSha256`（第 1 行那个），manifest 已把两者分开命名。

两条都是 documentation 层面的事实，不影响任何科学结论。

---

## B. TARGET CANDIDATE MANIFEST（复核，未变）

```
candidateId   landlord-independent-validation-v1/candidate-target-landlord
modelSha256   7ad463175b54d632c1d3e7ad1b15af3cfd0c454b96b39f73f636254a964b98a9
rawBytes      2,040,850 = 2.041 MB        gzipBytes 455,080 = 444.4 KB
numTrees      512        numFeatures 403  lightgbm 4.6.0
schema        v1, hash 502946fd…   history 12   identity fas-action-identity-v1
enumerator    7f1645eee455c4bcfcb6e9a984286e830005f83c7afc8a45a4b4667f5ede3c18
treeEvaluator 43bc62798482e234fbaf6148e1e62a08b912876503d261451c3f5b089084a77f
training      deal range 907001–913000, 6000 groups, TARGET env manifest, commit d196765
```

## C. CHEAP CANDIDATE MANIFEST

```
candidateId   full-action-selfplay-v1/candidate-cheap-landlord
modelSha256   070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b
rawBytes      2,019,876 = 2.020 MB        gzipBytes 462,403 = 451.6 KB
numTrees      512        numFeatures 403
schema        v1, hash 502946fd…   history 12   identity fas-action-identity-v1
enumerator    7f1645eee455c4bcfcb6e9a984286e830005f83c7afc8a45a4b4667f5ede3c18
treeEvaluator 43bc62798482e234fbaf6148e1e62a08b912876503d261451c3f5b089084a77f
training      deal range 907001–913000, 6000 groups, CHEAP env manifest, commit d196765
```

**Standalone equivalence（CHEAP）**：单独加载 CHEAP landlord 与原 CHEAP bundle 的
landlord 分支逐 state 比较**最终执行的 command**：

```
mismatches 0
coverage  leading 26 · responding 83 · passOffered 83 · bombOrRocket 4
          attachment 17 · largeActionSet(≥30) 11 · canEmptyHand 2
```

与 TARGET 同样的 109 个 state、同样 0 mismatch。

---

## D. TARGET TRAINING FARMER-PAIR DISTRIBUTION

6000 groups / 18000 games；其中 **6000 场是 landlord game**（learning seat 坐地主，
只发生在 scenario `L`），共 **69,532 条 landlord training rows**。

| farmer pair（两个 farmer seat） | games | game % | landlord rows | row % | mean rows/game |
| --- | ---: | ---: | ---: | ---: | ---: |
| `P0 / P0` — production master, **overlay NOT installed** | 9026 | 50.14% | 34,790 | **50.03%** | 11.64 |
| `π1 / π1` — master + frozen cf overlay | 8974 | 49.86% | 34,742 | **49.97%** | 11.53 |

**`DEFAULT_AI_STRATEGY` farmers 在 TARGET 的 landlord training rows 里占 0%。**
TARGET 从未见过它们。

## E. CHEAP TRAINING FARMER-PAIR DISTRIBUTION

6000 groups / 18000 games / 6000 landlord games / **70,101 landlord rows**。

| farmer pair | games | game % | landlord rows | row % | mean rows/game |
| --- | ---: | ---: | ---: | ---: | ---: |
| `REH-history / REH-history` — **DEFAULT_AI_STRATEGY** | 9026 | 50.14% | 34,774 | **49.61%** | 11.64 |
| `REH-current / REH-current` — scoring casual（analyzerNodes 24） | 8974 | 49.86% | 35,327 | **50.39%** | 11.73 |

**CHEAP 的 landlord 训练数据里有一半是 `DEFAULT_AI_STRATEGY` farmers** ——
正是 SECONDARY/matrix 环境 B 的那两个对手。

### D.1 / E.1 一个结构事实：mixed pair 从不出现

`mixture` 的 history pool 只有**一个**成员，于是三个 arm 全部退化成"两个 seat 同源"：

```
current arm        (50%)  -> A = B = current
shared-history arm (25%)  -> A = B = history[0]
independent arm    (25%)  -> 两次都从 history[0] 抽 -> A = B = history[0]
```

实测：`gameLevel` 里只有两个 key。**`π1/P0`、`default/casual` 这类 mixed pair
在本设计的两个 branch 里出现次数为 0。** §14 要求的 mixed pair 报告因此是"不存在"，
而不是"未测量"。

## F. GAME-LEVEL VS ROW-LEVEL EFFECTIVE WEIGHTS

| branch | pair | game % | row % | drift |
| --- | --- | ---: | ---: | ---: |
| TARGET | `P0/P0` | 50.14% | 50.03% | **−0.11pp** |
| TARGET | `π1/π1` | 49.86% | 49.97% | **+0.11pp** |
| CHEAP | `default/default` | 50.14% | 49.61% | **−0.54pp** |
| CHEAP | `casual/casual` | 49.86% | 50.39% | **+0.54pp** |

**回答 §4 的问题：不明显不同。** 最大 drift 0.54pp，来自每局 landlord 决策数的
微小差异（11.64 vs 11.73，或 11.64 vs 11.53）。**不存在"game 占比不低但 row 权重很低"的策略组合。**

---

## G. 2×2 DEVELOPMENT TAKEOVER MATRIX

同一个 **1200-group development pool `915001–916200`**（已暴露，可继续做 candidate analysis，
永久不能作为 confirmatory validation）。baseline 全部是同一个：
`production master tier, overlay NOT installed`。每格都是同 deal 直接 paired。
每 deal 6 局（每环境一个 baseline + 两个 candidate）。

| candidate | vs π1/π1 farmers | vs default/default farmers |
| --- | --- | --- |
| **TARGET landlord** | **+9.667pp**  [+6.563, +12.770]  244/128/828 | **−2.083pp**  [−5.134, +0.967]  162/187/851 |
| **CHEAP  landlord** | **+7.000pp**  [+4.031, +9.969]  210/126/864 | **+2.667pp**  [−0.421, +5.755]  195/163/842 |

baseline win rate：env A 29.58%，env B 49.08%。
（每格 sd ≈ 52.5–54.6pp，SE ≈ 1.52–1.58pp，N = 1200。）

**环境并排报告，不给 (A+B)/2 作为选择依据。**

一条交叉验证：本表 TARGET-envA 的 **+9.667pp** 与正式独立验证的 **+9.875pp**
（不同 pool、N=2400）几乎相同 —— 正式结果在开发池上复现。

## H. PAIRED TARGET-vs-CHEAP RESULTS BY ENVIRONMENT

同 deal、同 baseline，直接 paired：

| 环境 | CHEAP − TARGET | sd | SE | 95% CI | better/worse/tie |
| --- | ---: | ---: | ---: | --- | --- |
| A：π1 / π1 farmers | **−2.667pp** | 53.34 | 1.540 | [−5.685, **+0.351**] | 155 / 187 / 858 |
| B：default / default farmers | **+4.750pp** | 53.43 | 1.542 | [**+1.727**, +7.773] | 201 / 144 / 855 |

**环境 B 上 CHEAP 相对 TARGET 的优势是显著为正的（CI 不含 0）。**
环境 A 上 TARGET 更好，但 CI 含 0（−5.685 ~ +0.351）。

### H.1 一条必须记录的更正：上一轮 eval B 的 candidate arm 环境不纯

上一轮 rehearsal 的 `selfplay-eval-b.test.ts` 给 candidate bundle 用了
**默认 50/25/25** 权重，且 history = `["THROWAWAY"]`（master tier，无 overlay）。
实测这个 mixture 在同一个 1200 pool 上的 seat 分配是：

```
TAKEOVER/TAKEOVER    629 / 1200  -> farmer 两个 seat 拿到 π1
THROWAWAY/THROWAWAY  571 / 1200  -> farmer 两个 seat 拿到 master-no-overlay
```

也就是说 **eval B 的 candidate arm 有 47.6% 的局，farmers 不是 π1**，
而是 master-without-overlay。而正式 validation 与本次 matrix 都用 `current: 1`（100% 纯环境）。

因此：**eval B 的 `TARGET − π1 = +13.250pp` 不是干净的 π1/π1 测量**，
它被 master-no-overlay farmers 稀释了。**正式 validation 的 +9.875pp 与 matrix 的
+9.667pp 是干净的，且互相印证；eval B 的那个数字应视为被取代。**
两者都保留在记录里，不挑好看的那个。

---

## I. DEFAULT-REGRESSION DESCRIPTIVE DIAGNOSTICS

1200 groups × 2 environments，记录 TARGET landlord 在每个地主 decision 上
是否会与 baseline 选不同的动作。**descriptive only。**

| 轴 | env A (π1) | env B (default) |
| --- | --- | --- |
| disagreement rate | **29.67%** (4051/13652) | **31.50%** (4131/13116) |
| 平均地主决策数/局 | 11.38 | 10.93 |
| opening | 51.1% / 4797 | 50.9% / 4796 |
| middle | 22.0% / 5439 | 23.8% / 5369 |
| endgame | 11.8% / 3416 | 14.1% / 2951 |
| leading | 64.0% / 3931 | 63.7% / 3830 |
| responding | 15.8% / 9721 | 18.2% / 9286 |
| legal 1-2 | 8.5% / 8330 | 8.3% / 7117 |
| legal 3-8 | 50.0% / 2708 | 45.2% / 3338 |
| legal 9-30 | 69.3% / 1298 | 69.9% / 1344 |
| legal 31+ | 82.8% / 1316 | 82.9% / 1317 |
| hand 1-5 | 12.7% / 6463 | 14.1% / 6031 |
| hand 6-10 | 31.4% / 3856 | 34.1% / 3712 |
| hand 11-15 | 47.4% / 2107 | 46.3% / 2145 |
| hand 16+ | 83.4% / 1226 | 83.1% / 1228 |

**读法**：两个环境下的**行为画像几乎重合** —— 偏离率 29.67% vs 31.50%，
每个轴的偏离率相差都在几个百分点以内。**回归并不集中在某个状态区域。**
变化的是**同样的偏离在两个环境下的收益**：对着 π1 farmers 赚 +9.667pp，
对着 default farmers 亏 −2.083pp。

这与"策略被调到了某个特定对手上"一致，而与"在某个状态区域失效"不一致。

---

## J. NONINFERIORITY / POWER PLANNING TABLE

用本轮的**实测 paired sd**（env A CHEAP 52.472pp；env B CHEAP 54.578pp，TARGET 53.911pp）。
公式 `N = (z_{0.975} + z_{0.80})² · sd² / δ²`，`z = 2.80`，双侧 95%、80% power。
**只是 planning；不开新 pool。**

### Environment B（default farmers）：non-inferiority margin

margin `d` 的含义：要求 **95% CI lower bound > −d**。

| margin | N（用 CHEAP vs baseline sd 54.578pp） |
| --- | ---: |
| −0.5pp | **≈ 93,400** |
| −1.0pp | **≈ 23,400** |
| −2.0pp | **≈ 5,800** |

**margin 0pp 不是 non-inferiority margin，它是 superiority。** 所需的 N 取决于
**真实效应**而不是 margin：

| 真实效应 | N |
| --- | ---: |
| +1pp | ≈ 23,400 |
| +2pp | ≈ 5,800 |
| +5pp | ≈ 930 |

### Environment A（π1 farmers）：正向效应目标

| target | N（用 CHEAP vs baseline sd 52.472pp） |
| --- | ---: |
| +2pp | **≈ 5,400** |
| +5pp | **≈ 860** |

**必须写明的两点**：

1. **`CI contains zero` 不等于 `non-inferior`。** 本 matrix 里 CHEAP-envB 的
   95% CI 是 [−0.421, +5.755] —— 它**含 0**，所以在 margin 0pp 下既没证明优效，
   也没证明非劣；它只在 **−0.5pp 及更宽的 margin** 下满足非劣。
   而这是 **development** 数据、被用来做 candidate selection，**因此它不构成确认**。
2. **同时满足两个条件的 N 由较严的一侧决定。** 若未来要求 env A `+2pp`（N≈5,400）
   且 env B `−1pp` non-inferiority（N≈23,400），那么单是 env B 一项就需要
   **约 23,400 个 fresh groups** —— 是上一轮验证池的 10 倍。这是下一轮设计必须先面对的算术。

---

## K. INTERPRETATION

1. **不存在 SHA 问题。** 六个 artifact 一致；不一致只存在于我的一条聊天消息里。
2. **TARGET 的 default 回归，最符合的假设是"缺少覆盖"** —— 但不是缺 `P0`，
   而是缺 `DEFAULT_AI_STRATEGY`：TARGET 的 landlord rows 里 `default` 占 **0%**。
   `P0`（master-no-overlay）占 50.03%，所以"模型没见过非 π1 对手"是**错的**；
   正确的说法是"模型没见过**这一种**非 π1 对手"。
3. **effective row-weight imbalance 不成立**：最大 drift 0.54pp。
4. **representation/objective 未被证明有问题**：行为画像在两个环境下几乎重合，
   回归不集中在任何状态区域，因此没有证据指向表征或目标函数。
   但也没有被排除——本轮没有做表征实验（§15 禁止）。
5. **CHEAP 是明显更均衡的候选**：两个环境都是正的（env A +7.000pp 显著，
   env B +2.667pp 点估计为正、CI 含 0）。
6. **但 CHEAP 在 env A 上比 TARGET 弱约 2.7pp（CI 含 0）**，所以它不是无代价的替换。

**允许的表述**：
> CHEAP is a promising more-balanced development candidate.

**禁止的表述**：`robust landlord validated`。本 pool 是 development/selection 数据。

---

## L. RECOMMENDED NEXT BRANCH

## **Branch A — validate CHEAP**

判定依据（§10 的 Branch A 条件，逐条对照）：

| 条件 | 实测 | 命中 |
| --- | --- | --- |
| CHEAP vs π1：substantial positive gain | +7.000pp [+4.031, +9.969] | ✔ |
| CHEAP vs default：no obvious material regression | +2.667pp [−0.421, +5.755]（点估计为正，CI 含 0） | ✔ |
| TARGET：仍强于 π1，但明显差于 default | +9.667pp / −2.083pp；且 paired CHEAP−TARGET 在 env B = +4.750pp（CI 不含 0） | ✔ |

**建议：把 CHEAP freeze 为下一个 robust-landlord candidate，并为它设计一次新的
独立双环境确认。** 本轮**只给 protocol proposal**（§M），
**不实际开启新的 confirmatory pool**（§15 禁止）。

不选 Branch B / C 的理由：B 要求两个候选都存在明显 environment tradeoff ——
TARGET 有，但 CHEAP 没有（两个环境都不为负）；C 要求两个候选在 default 都明显退步 ——
CHEAP 在 default 上是正的。

### K.1 三个必答问题

1. **是否已经存在一个值得独立验证的更均衡地主候选？**
   **是** —— CHEAP landlord，`070f5b0b…`，两个环境都不为负，
   且 standalone equivalence 0 mismatch。但它**尚未被独立确认**。

2. **TARGET 的 default regression 更符合哪一类？**
   **`lack of coverage`**，而且定位很具体：缺的是 `DEFAULT_AI_STRATEGY` 这一种对手
   （占 TARGET landlord rows 的 **0%**），**不是** effective row-weight imbalance
   （drift ≤0.54pp），**不是**已证明的表征/目标问题（行为画像重合、回归不集中），
   也**不是** evidence insufficient。

3. **如果需要第三个 landlord，下一次实验只允许改变哪个单一主要变量？**
   **训练时的对手策略集合（opponent policy coverage）。**
   具体地：让 landlord 的训练数据里出现 `DEFAULT_AI_STRATEGY` 这类对手。
   **不允许**同时改 feature、history length、ε、reward、LightGBM 配置、
   model 结构或 mixture 权重之外的任何东西。

---

## M. PROPOSED NEXT PROTOCOL — **DO NOT EXECUTE**

草案（供 review；本轮不分配任何 pool、不训练）：

```yaml
name: landlord-robust-confirmation-v1   (PROPOSAL ONLY)
candidate:
  frozen before the run: one complete landlord artifact + manifest
  identity: model SHA-256, 403-col schema hash, enumerator, tree evaluator,
            canonical order, tie-break, LightGBM version
baseline:
  production master tier, overlay NOT installed   (a6ae8a6a…)
environments (both reported side by side, never averaged into one headline):
  A: both farmer seats = frozen pi1
  B: both farmer seats = frozen DEFAULT_AI_STRATEGY
  (mixed pairs: development generalization only, not a primary environment)
statistics:
  unit: initial deal group
  env A: point estimate >= +2.00pp and 95% CI lower bound > 0
  env B: non-inferiority, margin to be frozen at review
         (-1pp needs ~23,400 groups; -2pp needs ~5,800; see §J)
  no post-hoc exclusion; integrity failures listed individually
no-peek:
  progress / throughput / integrity only; both environments seal; reveal once
```

**明确记录在提案里的两条**：

* `CI contains zero` ≠ `non-inferior`。
* margin 由 review 决定，本轮**不擅自冻结**。

## N. COMMIT / WORKTREE STATE

本轮新增：`benchmarks/selfplay-landlord-audit.test.ts`（分布审计 + CHEAP manifest）、
`benchmarks/selfplay-landlord-matrix.test.ts`（2×2）、
`benchmarks/selfplay-landlord-diag.test.ts`（descriptive diagnostics）、
本报告；`selfplay-landlord-standalone.test.ts` 参数化到两个 branch。

**未触碰**：`src/**`、production `ai-v1`、任何历史 pool 的 provenance、
`landlord-independent-validation-v1` 的 checkpoint 与 seal。
