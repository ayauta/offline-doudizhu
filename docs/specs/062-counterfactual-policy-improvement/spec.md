# Spec 062：Phase 2 v1 / Gate A 预登记（反事实农民优势模型）

状态：**Gate A v1 协议冻结**。第 1–13 步执行中；**正式 held-out 判定未运行**。
日期：2026-09-20
基线：`ea67aa3 docs(ai): record H5 terminal-evidence gating revert`
编号说明：`061` 曾分配给已删除、从未运行的 H6 spec。本阶段另起 `062`。

本文件是 Phase 2 v1 的**预登记**。所有阈值、切分、采样、模型容量、判据在**看到任何
正式 held-out 结果之前**写死；此后任何修改都使原 held-out 失效。

本轮只执行到「冻结 threshold / CALIBRATION NO-GO」为止，**不运行正式 held-out**。

---

## 1. Gate A 要回答的唯一问题

> 在 production top3 完全不变的前提下，仅使用合法可见信息训练出的 counterfactual
> advantage model，能否在独立 initial deals 上选择出比 production action `a0` 更好的
> 农民动作？

第一版只研究农民；地主完全不进入模型；模型没有线上接线。

Gate A 若通过，只证明**合法信息里存在可泛化的单步农民动作优势信号**，不证明整局产品收益。

## 2. 池与 universe

| 范围 | 身份 | 用途 |
| --- | --- | --- |
| **50001–70000** | **Phase 2 v1 dataset**（20,000 groups） | 本次 train / calibration / held-out |
| **70001–78000** | test-only reserve（8,000 groups） | 仅当首轮 held-out 为 INCONCLUSIVE 时启用一次；**本轮不生成** |

50001–70000 永久属于 Phase 2 v1 dataset，**不得**再用于 Gate B、product discovery 或
final validation。

已退休、不得复活：`301–700`、`20001–20400`、`30001–30400`。
`10001–10400` 继续作为最终 validation，**Gate A 不得触碰**。
V4 `40001–40400` 虽未暴露，本 Phase 不使用。
旧 calibration `5001–5400` 仅用于早期的机械 prototype 与吞吐测量，**不进入正式 corpus**。

## 3. Split

对 20,000 个 group 精确切分为 **12,000 train / 4,000 calibration / 4,000 held-out**。

算法（`cfSplitTable`）：

1. 对每个 group ID 计算 `mix32(dealIndex ^ hash(CF_SPLIT_SALT))`；
2. 按 hash 升序排序（hash 相同则按 dealIndex），**不使用 modulo**；
3. 前 12,000 → train；接着 4,000 → calibration；最后 4,000 → held-out。

冻结 salt：`phase2-cf-v1-split`。

同一个 initial deal 派生出的 seat variants、games、snapshots、candidate rows、fork
outcomes **永远在同一 split**：split 是 group ID 的函数，除此以外不吃任何输入。
不变式测试：`split-crossing violations = 0`。

## 4. Snapshot sampling

每个 initial deal group：

1. 跑完 preregistered 的全部 arm-B seat variants（production `master` 坐农民位，
   其余 `default`）；
2. 枚举该座位遇到的**所有** eligible farmer roots；
3. 对每个 root 计算 deterministic keyed priority；
4. 无放回取 priority 最小的最多 **3** 个；
5. 选中之后才允许生成 counterfactual labels。

**上限是每 group 3 个 useful snapshot**——不是每局 3 个，也不是每座位 3 个。

### 4.1 Eligibility

判据直接写在 **production 候选集合**上，而不是「合法动作数 >= 2」：

> 去重后的 production 候选集合包含 `a0`，且至少存在一个不同于 `a0` 的候选。

两个子句都要满足；`legacy` 的「合法动作 >= 2」是这条规则的**推论**而非等价物。
（实测：均匀采样下 46% 的农民 root 只有一个合法动作，全部被这条规则排除。）

### 4.2 Sampling key

只允许依赖：

- initial deal group ID
- variant ID
- variant 内 farmer decision index
- 固定 sampling salt

冻结 salt：`phase2-cf-v1-snapshot`。

**不得**依赖 label、fork outcome、expert gap、candidate score、future winner。
group 内 farmer decision ID 唯一（`groupId:variantId:decisionIndex`），避免不同 variant
的 decision #17 键冲突。

### 4.3 记录

每 group 记录：`totalFarmerRoots`、`usefulFarmerRoots`、`sampledRoots`、
`sourceVariantCounts`。没有 useful root 的 group **仍然保留 registration**（0 snapshot），
**不得**用另一副牌补位。

## 5. Snapshot identity

每个 snapshot 保存：exact production `a0`、同一次 production decision 实际产生的候选
集合、候选顺序、decision seed、decision index、continuation 所需随机状态
（`gameSeed` + 逐座位 counters）、完整冻结的三家策略配置（`tiers`）、production policy
version、source commit、game rules version、feature schema version、group ID、variant ID、
snapshot ID。

**禁止**之后重新调用 stochastic master AI 来重建 `a0` 或候选集合。`a0` 与 candidates
只能来自原生产决策当时实际使用的那一次结果。

> 这一条是实测教训：早期版本用一次固定 seed 的 `decideEnhancedAi` 重算 `a0`，而 master
> 的 rollout world 由 decision seed 决定，换个 seed 可能排出不同 top1。`default` 档完全
> 忽略 seed，所以该错误在轻档守卫里不可见，只在真实 `master` 捕获时被自检拦下。

保留守卫：`forced a0 fork must reproduce original continuation`（逐元素命令轨迹 +
decision index 序列）。

## 6. Counterfactual labels

从**完全相同**的 frozen GameState 分叉：分支 A 强制执行 `a0`，分支 B 强制执行候选 `a`。
第一手之后两边恢复**完全相同的冻结 production policies** 与 deterministic continuation
protocol，直到真正 terminal。按**农民阵营**判定：

| 情形 | label |
| --- | --- |
| candidate 赢 / a0 输 | `+1` |
| 同阵营结果相同 | `0` |
| candidate 输 / a0 赢 | `-1` |

**未终局不能记成 0**，必须视为 INVALID / pipeline failure（`CfInvalidError`）。
每个分叉都要跑满 256 条命令上限，超限即抛错。

## 7. Feature representation：Option C

```
x(o, a, a0) = [ context(o), phi(o,a), phi(o,a0), delta_numeric(o,a,a0) ]
```

- **shared public context**：与候选无关的公开状态；
- **candidate / a0 representation**：各一份，categorical 与 numeric 分开；
- **numeric delta**：只对有数值意义的字段做 candidate − a0。

### 7.1 Numeric delta 允许的字段

`cardCount`、`mainRankStrength`、`sequenceLength`、`afterTurns`、`turnsDelta`、
`afterLooseSingles`、`afterControlCards`、`breaksPair/Triple/Four`、`unseenHigher`。
同时保留 candidate 原值、a0 原值、delta 三者。

### 7.2 Categorical 字段

牌型族 one-hot（pass/single/pair/triple/sequence/four/bomb）、`usesJoker`、`usesTopRank`、
`emptiesHand`、`nextIsSelf/Partner/Opponent`。candidate 与 a0 **分别编码**，
**不做减法**——`straightType - pairType` 没有语义。

### 7.3 Missing values

缺失的 numeric 一律为 `NaN`（LightGBM 原生按 missing 处理），delta 由 NaN 传播得到 NaN。
**禁止**用 arbitrary sentinel numeric 参与 delta。
（例：pass 没有 main rank；rocket 也没有 → 两者都是 `NaN`，不是 0 也不是 15。）

### 7.4 列布局（frozen）

| 段 | 槽数 | 前缀 |
| --- | ---: | --- |
| context | 27 | — |
| candidate categorical | 13 | `cand_` |
| candidate numeric | 11 | `cand_` |
| a0 categorical | 13 | `a0_` |
| a0 numeric | 11 | `a0_` |
| numeric delta | 11 | `delta_` |
| **合计** | **86** | |

冻结：字段名、字段顺序、类型、categorical 编码、missing 约定、schema version、
**schema hash**（`sha256(JSON.stringify({version, names}))`，写入 corpus manifest）。
此后不得再改 feature；改了就是新 schema，必须重新生成整个 corpus。

## 8. Feature scope（禁止项）

只允许**已有信息的 candidate / a0 / meaningful delta 展开**，不得趁机增加新的牌力假设。

**禁止进入模型输入**：`expertScore`、`expertGap`、decision seed、split ID、shard ID、
initial seed、绝对座位身份、对手隐藏手牌、队友隐藏手牌、terminal winner、future actions、
fork result。

`expertScore` / `expertGap` 只允许 **diagnostic storage**（`candidates[].anchoredScore` /
`baseScore`、`diagnostics.expertGap`），用于分桶报告与「不要只是把 expertScore 重学一遍」
的自查。

绝对座位身份的处理：位置一律写成**相对地主**的距离；arm B 会轮换哪个座位被研究，
绝对座位名会泄漏轮换规律并间接与 dealIndex 相关。

## 9. Leakage guards

`tests/core/cf-dataset-guards.test.ts`，**进 `pnpm check`**：

1. **Hidden hand invariance**：在 model-visible public state 不变时，改变 landlord hidden
   hand / teammate hidden hand / other opponent hidden allocation，`cfRow` 必须逐位相同
   ——**candidate 侧、a0 侧、delta 侧全部**。label 可以变，feature 不得变。
   同时断言 view 本身深度相等（钉住出货的 `createPlayerView` redaction 边界）。
2. **非空洞性**：同一次重发必须能改变终局。否则「特征不变」会被一个根本没在模拟其他座位
   的管线满足。
3. **Rotation / identity**：改 `dealIndex / dealSeed / gameSeed / variantId / snapshotId /
   seatDecisionIndex / decisionSeed / policyCommit`，`x` 不变。
4. **Future leakage**：future actions、continuation decisions、terminal result、fork
   length、fork winner 均不得进入 feature（结构上 `cfRow` 只有 3 个参数，且都来自 view）。
5. **Metadata leakage**：seed / split / shard / file order / diagnostic expert score 不入 feature。
6. **结构守卫**：`cfRow.length === 3`。

### 9.1 变异测试（证明守卫不是摆设）

逐个把回归注入实现，看守卫是否变红。**当前 15/15 全红**：

| # | 变异 | 结果 |
| --- | --- | --- |
| M1 | 把 dealIndex 拼进 `x` | 🔴 |
| M2 | `cfForkLabels` 不消费强制那一手的 decision index | 🔴 |
| M3 | `cfPlayToTerminal` 计数器不前进 | 🔴（3 项） |
| M4 | `cfLabel` 的 `+1/-1` 反号 | 🔴 |
| M5 | 重发变成 no-op | 🔴（非空洞性） |
| M6 | 阵营判定改成「按座位」 | 🔴 |
| M7 | 候选集放宽成「全部合法动作」 | 🔴（2 项） |
| M8 | 允许地主行 | 🔴（2 项） |
| M9 | `cfRow` 长出隐藏手牌参数 | 🔴 |
| M10 | 把 categorical 也塞进 delta | 🔴（3 项） |
| M11 | 缺失 rank 用 sentinel 0 代替 NaN | 🔴 |
| M12 | `tiers` 退回 group 级（只取第一个 variant） | 🔴 |
| M13 | eligibility 去掉「包含 a0」子句 | 🔴 |
| M14 | group 上限改成 per-variant | 🔴 |
| M15 | 未终局分叉返回伪造的 draw | 🔴 |

**两个变异第一轮存活，都是守卫本身的洞，已补**：

- **M13**：pipeline 里 `master` 座位的 `a0` 必然属于它自己的 top3，「包含 a0」子句**恒真**，
  删掉它没有任何可观测变化。补了直接针对 `cfIsEligible` 的合成用例（候选集不含 a0 时
  必须为 false），子句才真正被钉住。
- **M8**：地主检查在两处各有一份，单点删除后另一处仍然拦下，用例照旧通过。现在按「两处
  同时删除」验证，确认该检查确实是 load-bearing。

**一次真实 bug 是守卫抓出来的**：`tiers` 原先是 group 级字段，但 arm B 的三个 variant
**被研究的座位各不相同**（landlord 轮换），于是三个 variant 里有两个在用错误的档位跑，
eligibility 会大面积失效。现在 `tiers` 挂在 `CfVariantSpec` 上。这条如果漏到 corpus，
整个数据集都是废的。

## 10. Behavior policy freeze

正式 corpus 的 continuation policy 写入 manifest：

- production baseline commit
- pipeline commit
- `tiers` 逐 variant 记录在 snapshot `meta` 里
- designed / deterministic path：`CF_FROZEN_RUNTIME = {deadline: ∞, now: () => 0}`，
  **不读时钟**，因此 wall-clock deadline 与 CPU 竞争无法改变续局策略。

deal-level multiprocessing **只能改变 wall time**。验证：同一 shard 在 `jobs=1` 与
`jobs>1` 下输出**逐字节相同**，且比较的是 snapshots / a0 / candidates / decision indices /
labels / serialized rows，不只是最终 winner。

> 注意：`default` 档完全忽略 decision seed，只有 `master` 用 seed 采样 rollout world。
> 因此涉及 π0 身份的守卫必须比较 **decision index 序列**（而非命令轨迹），或用真实
> `master` 档。M2/M3 就是靠 index 序列才钉住的。

## 11. 基础设施冻结门（生成 corpus 之前必须全绿）

1. 本 spec 落盘；
2. Option C schema 与 guards 完成；
3. 全部 mutation / deterministic / leakage tests 通过（15/15 变异变红）；
4. `pnpm check` 全绿；
5. production `src/` **0 diff**；
6. prototype 小 shard 重跑通过；
7. `jobs=1` vs parallel deterministic。

然后提交 `bench(ai): add counterfactual farmer dataset pipeline`（pipeline code + tests +
spec；**不提交** `.local` corpus），并记录 commit hash。正式 dataset manifest 引用**这个**
commit，而不是只引用 `ea67aa3`。

## 12. Corpus 生成

universe `50001–70000` 全部 20,000 groups，允许 multiprocessing。
生成的 manifest 记录：pipeline commit、production baseline commit、schema hash、split salt、
sampling salt、LightGBM config version、group range、jobs、每个 shard 的 checksum、
merged corpus checksum、row counts。

## 13. Held-out blind protocol

正式 held-out 只能用于最终 Gate A 判定一次。corpus 生成时 held-out labels 写入
**封存文件**（`heldout.sealed.json`），本轮**禁止**查看：

held-out label distribution、`+1/0/-1`、model score、override coverage、subgroup result；
禁止用 held-out 训练或 calibration。

允许对 held-out 做的只有：schema validation、checksum、row/group count、structural
integrity、illegal action check、leakage invariant、split membership validation。

工具默认 blind：`cfAuditStructure` 的返回类型**根本没有 label 字段**，所以「顺手打印
held-out 统计」在结构上不可能发生；要看 outcome 必须专门去读封存文件。

## 14. Train split QA（可看 outcome）

报告：12,000 registered groups、有 useful roots 的 groups、snapshots、non-a0 rows、
`+1/0/-1`、nonzero rate、per-deal concentration、candidate count、两个农民位置、
stage buckets、expert-gap diagnostics。

**这些都是 diagnostics**。看到数据后不得修改 schema、sampling、model capacity、objective
——除非发现 integrity INVALID。若 INVALID：修 pipeline → **整个正式 dataset 重新生成**，
不得静默删除异常 rows 继续。

## 15. Calibration split

可看 outcome，但**只能用于选择 frozen threshold**。不得改 feature / model / objective /
tree count / learning rate，不得重新训练另一个模型，不得改 sampling。

## 16. 模型训练目标

冻结：**LightGBM CPU regression**，目标 `E[label | legal observation, candidate, a0]`，
loss `L2 / squared error`。

只训练 **non-a0 candidate rows**；**保留所有 `label = 0`**。
禁止：class reweight positive/negative、3-class classification、pairwise ranking、
SMOTE / oversampling、zero-label downsampling。

### 16.1 Row weights

deal `i` 有 `m_i` 个 sampled useful roots，root `j` 有 `k_ij` 个 non-a0 candidates：

```
w_ija ∝ 1 / (m_i * k_ij)
```

然后全部 train rows 归一化到 `mean weight = 1`。含义：每个有效 deal 等权、每个 sampled
root 等权、同 root 的多个 alternative 分享该 root 权重。记录权重分布并测试。

### 16.2 固定 LightGBM 配置

| 项 | 值 |
| --- | --- |
| library | LightGBM CPU（exact version 见 manifest） |
| objective | `regression` |
| metric | 仅 diagnostic，**不用于选模型** |
| num_iterations | 256 |
| max_depth | 6 |
| num_leaves | 31 |
| learning_rate | 0.05 |
| min_data_in_leaf | 100 |
| lambda_l1 | 0 |
| lambda_l2 | 5 |
| feature_fraction | 1 |
| bagging_fraction | 1 |
| bagging_freq | 0 |
| max_bin | 63 |
| early_stopping | off |
| num_threads | 1 |
| deterministic | true |
| force_col_wise | true |
| training seed | 冻结，见 manifest |

另外冻结：feature ordering、categorical encoding、training row ordering。

**训练一次**。禁止训练多个 seed 后挑最好；禁止 calibration 后 train+calibration 重训。
模型一旦训练即冻结 model artifact + checksum。

> 依赖记录：LightGBM 只用于**离线训练**，不进入 `src/`，不进任何交付物，不进运行时。
> 版本、license（MIT）与安装位置记录在 manifest 与 `docs/research/toolchain-dependencies.md`。

## 17. Selector semantics

对每个 `a != a0` 计算 `f(o,a,a0)`，取 `a* = argmax score`；
tie 用 **frozen production candidate order**。然后：

```
score(a*) > threshold  → 选择 a*
否则                    → 选择 a0
```

严格 `>`，不是 `>=`。每个 snapshot 最终只产生**一个** selector outcome；
禁止「多个 candidates 超过 threshold 后各自算一次成功」。

## 18. Calibration threshold grid

只允许六个 finite thresholds：`T = {0, 0.01, 0.02, 0.04, 0.08, 0.16}`，另加 `∞`
（永不 override，作为 no-go fallback）。不得增加 0.03 / 0.05 / quantile threshold /
adaptive threshold / per-seat threshold。

## 19. Calibration primary metric

统计单位是 **initial deal group**，不是 candidate row，也不是 snapshot。

root `j` 的实际单步结果：override 时 `z_ij = selected candidate label ∈ {-1,0,+1}`；
不 override 时 `z_ij = 0`。group `i` 有 `m_i > 0` sampled roots 时
`R_i = mean_j(z_ij)`；没有 useful root 时 `R_i = 0`。

primary：`mu_hat = mean_i(R_i)`，**全部 4,000 calibration registered groups 都在分母里**，
不能只统计发生 override 的 groups。

## 20. Threshold selection

对六个 finite thresholds 各跑一遍完整 selector，计算 `mu_hat(t)`、
`SE(t) = sd(R_i(t)) / sqrt(N)`，以及 Bonferroni 校正的单侧保守下界：

```
L_cal(t) = mu_hat(t) - t_(1 - 0.05/6, N-1) * SE(t)
```

threshold 还必须满足支持量：

- override 出现在 **>= 200** 个 distinct initial deals；
- 被 selector 选中的 override 在 **>= 50** 个 distinct deals 中出现 **nonzero label**
  （是 selected override 的**真实 label 非零**，不是候选集合里「存在非零」）。

在满足支持量的 threshold 中：取 `L_cal(t)` 最大者；完全并列取较大 threshold；
只有最佳 `L_cal(t) > 0` 才冻结 threshold。否则 `threshold = ∞` 并判 **CALIBRATION NO-GO**，
直接 STOP Phase 2 v1，**不打开 held-out**。

## 21. Calibration diagnostics（可报告）

每个阈值的 `mu_hat`、conservative lower bound、override deals、selected-nonzero deals、
coverage、conditional `(good-bad)/overrides`。

一旦选定 threshold，冻结：model、threshold、selector code、tie break、
statistical evaluation script、Gate A decision rules。之后任何修改都会使原 held-out 失效。

## 22. Gate A 正式 held-out 判定规则（本轮不运行）

N = 4,000 initial deal groups，使用冻结 selector。先算每 group 的 `R_i`，再算
`mu_hat = mean(R_i)`，区间为**双侧 97.5% t interval**：

```
[L, U] = mu_hat ± t_(0.9875, N-1) * sd(R_i)/sqrt(N)
```

用 97.5% 而非 95%，因为最多允许两次正式 test（initial held-out + only-if-inconclusive
reserve），以此控制整体重复检验。

最低工程效应 `mu_min = 0.005`。

### PASS（全部满足才可进入 Gate B）

1. `mu_hat >= 0.005`
2. `L > 0`
3. override deals >= 200
4. selected nonzero override deals >= 50
5. 所有 integrity gates valid

### FAIL

`U < 0.005` → **FAIL**，停止 Phase 2 v1，**不得使用 reserve**。

### INCONCLUSIVE

不满足 PASS 也不满足 FAIL（区间跨越 0.005，或 supporting deals 不足）。
此时才允许启用预登记的 reserve。

## 23. Reserve test（本轮不生成）

首轮 held-out INCONCLUSIVE 时：model / threshold / feature / selector / policy / sampling /
PASS rule **全部不变**，生成全部 8,000 reserve groups，**只用新增的 8,000 groups** 做第二次
正式判定（**不把第一次的 4,000 合并进去重算**）。第二次 PASS 则进入 Gate B，否则 STOP。
不允许第三次扩样。

## 24. INVALID

以下任一发生即判 **INVALID**（≠ FAIL）：hidden information leakage、illegal candidate、
`a0` 不在原候选集合、baseline fork 无法复现、nonterminal fork 被记为 0、split crossing、
nondeterministic formal corpus、selector implementation 与 reference 不一致、
model export / inference 不一致。

先修基础设施并**重新生成受污染的数据**；绝对不能静默删异常 row 然后继续。

## 25. Farmer-only 与未来产品 metric

Gate B 若确保「landlord arm 被测 agent 不启用新 selector / farmer arm 启用 /
combined 50:50 权重」，则 `combined Δ = farmer Δ / 2`，产品 KEEP 等价要求：

- farmer point estimate `>= +2.0pp`
- farmer paired CI lower `> 0`
- combined point estimate `>= +1.0pp`

**不要因为 farmer-only 而降低产品门槛。** 但当前 Gate A 不要求提前证明 +2pp 整局收益。

> 补充（本仓库推导，未实测）：由于 arm A 上 challenger 与 baseline 逐字节相同，
> 逐副差值恒为 0，combined 的均值与标准差同时减半，**t 统计量与只看 arm B 完全相同**。
> 所以这半折是**门槛**问题，不是**统计功效**问题。

## 26. 产出

- 本 spec
- `benchmarks/cf-dataset.ts`（纯机器，无 `node:*`）
- `benchmarks/cf-corpus.ts`、`benchmarks/cf-corpus.test.ts`（生成 / 合并 / 审计）
- `tests/core/cf-dataset-guards.test.ts`（进 `pnpm check`）
- `.local/cf-corpus/`（corpus + manifest，gitignored）
- `docs/research/` 下的 Gate A v1 结果记录（calibration 之后）
