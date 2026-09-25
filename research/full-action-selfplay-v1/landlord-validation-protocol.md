# Landlord independent validation — protocol (FROZEN before any outcome is read)

状态：**单一候选的、独立验证**。不是新的 self-play 项目，不重训，不启动 batch 2/3，
不触碰 production π1，不分配任何 final-validation pool。

冻结时间：2026-09-25。**在分配 fresh pool 与读取任何新 outcome 之前冻结。**

它只回答一个问题：

> 已经在 development 中出现强正信号的现有 TARGET landlord model，
> 在完全新的、独立的 initial deal groups 上，地主全程接管时，
> 是否能稳定优于当前地主 baseline？

---

## 1. 问题与选择效应的说明

`+13.250pp` 是**上一轮 development 的 role breakdown 之后**才被选中的角色。
所以它是 **post-development selected**，本身不是正式证据。
**本轮是这条假设的第一次 confirmatory test。**
只有一个 frozen candidate；验证失败后**不得**改验 CHEAP landlord、另一个 checkpoint，
或重训后继续用同一池。这正是本轮不需要重训的原因。

---

## 2. 候选（immutable）

```
candidateId          landlord-independent-validation-v1/candidate-target-landlord
role                 landlord
artifact             .local/selfplay-reh/TARGET/train-input/landlord.model.json
modelSha256          7ad463175b54d632…          （完整值见 candidate-manifest.json）
rawBytes             2,040,850
numTrees             512
numFeatures          403
lightgbmVersion      4.6.0
manifestSha256       19e528061368ec32f62a5369e43c99d74815f125a963f9cd36e0ed02194afdc0
```

Feature / action / selector identity：

```
featureSchema      SELFPLAY_FEATURE_SCHEMA_VERSION = 1, 403 columns, schemaHash 502946fd…
history            SELFPLAY_HISTORY_LENGTH = 12
actionIdentity     ACTION_IDENTITY_VERSION = "fas-action-identity-v1"
canonicalOrder     generateLegalActions order（pattern kind → card count → main rank strength → card id）
tieBreak           highest score；平局取该顺序中位置最靠前者（不得改为 pass）
enumerator         7f1645eee455c4bcfcb6e9a984286e830005f83c7afc8a45a4b4667f5ede3c18
treeEvaluator      43bc62798482e234fbaf6148e1e62a08b912876503d261451c3f5b089084a77f
training            deal range 907001–913000, 6000 groups, TARGET environment manifest
training commit     d196765（含本轮训练代码）
```

## 3. Baseline（必须按真实身份命名）

**π1 是 farmer-only enhancement。** 它的地主席位是 production `master`，
counterfactual overlay **未安装**（`final-validation.md`：arm-A games 24,
overlay decisions on the landlord: 0）。所以 baseline landlord **就是 master tier**：

```
PRIMARY baseline landlord
  description   production master tier, cf overlay NOT installed
  identity      a6ae8a6aebd31e88172a12a64845284f799b1487abc07a49d934188a0cee89e3
                (src/app/ai/decision-handler.ts)
```

π1 farmer（PRIMARY 环境里另外两个 seat）：

```
farmer-next       pi1 chain, seat-bound      pi1;chain=ai-v1;tier=master;schema=0ec9d20f…
farmer-previous   同上
champion model    010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359
threshold         0.01
```

SECONDARY 环境的旧 farmers：

```
old/default farmer   2a39386007949cf1c37010c1d97f61e8468a3d41b44df50cebf70c9cc46b7297
                     (src/core/ai/index.ts — DEFAULT_AI_STRATEGY)
```

规则与发牌：

```
gameRules       04e4814a781412b490b6acbbca1bc1e4226a90713a920ad8c9f7a5d6ca1056d6
dealGenerator   8202c1334d58e3b858ff4d7850b35fc2b9edb31f60759c9236ce2fadc2acf86a
```

---

## 4. Fresh pool

namespace **`landlord-independent-validation-v1`**，保留 `950001–960000`。
本协议**分配 `950001–952400`，恰好 2400 个 initial deal groups**。

与全部历史范围的交集为 **零**（逐条核对见 `landlord-validation-report.md` §H）。
该池自分配起**永久不得**用于：training、model selection、feature tuning、
compression tuning、threshold tuning。

## 5. 样本量（揭盲前冻结）

用上一轮 development 的**地主 role deal-level paired D_i** 做 power planning：

```
sd(D_i) = 55.0936pp     var = 0.303530     N_dev = 1200
z = 1.96 + 0.84 = 2.80
planning effect = +5pp
N_req = (2.80^2 * 0.303530) / 0.05^2 = 951.8  ->  952
```

`N_req = 952 <= 2400` **⇒ 冻结 N = 2400。** 不因为理论上可以更少而减 N。

`+5pp` 只是 planning 用的效应量，**不是收益预测**。

**工程门槛（PASS gate 的 point-estimate 要求）：`+2.00pp`。**
它不代表 PASS 后可以宣称真实 effect ≥ +2pp。

## 6. PRIMARY 设计

```
Arm A   landlord = frozen baseline landlord (master tier)
        farmer-next = frozen pi1 farmer     farmer-previous = frozen pi1 farmer
Arm B   landlord = frozen TARGET landlord candidate
        farmer-next = frozen pi1 farmer     farmer-previous = frozen pi1 farmer
```

* 同一 initial deal；同一 landlord 分配语义（`scenarioSpec(dealIndex,"L")`）；
  同一规则；同一 RNG identity；
* candidate 控制**每一次**地主 decision；
* **exploration OFF**；无 top3/top5 fallback；无人工 override；行为不依赖墙钟。

## 7. SECONDARY 设计（generalization，secondary only）

```
Arm A2  baseline landlord + frozen old/default farmer-next + frozen old/default farmer-previous
Arm B2  TARGET landlord   + 完全相同的 old/default farmers
```

同一批 2400 个 group。**secondary only、单独报告、无 promotion authority。**
PRIMARY fail 时不能用 SECONDARY PASS 替代。
PRIMARY PASS 但 SECONDARY 显著退步 ⇒
`landlord candidate is environment-specific; product generalization unresolved`，
**不是**自动 production candidate。
**不得**与旧的 58.9% benchmark 做算术相加。

## 8. 统计

单位恒为 **initial deal group**。每个 registered group 都进入分母。

```
d_i = W_i(Arm B) - W_i(Arm A)   ∈ {-1, 0, +1}
N, candidate win rate, baseline win rate, mean paired delta,
better / worse / tie, sd(d_i), SE = sd/sqrt(N), two-sided 95% CI
```

**唯一允许的 exclusion 是预登记的 integrity failure，且必须逐条列出原因。**
禁止：useful-root filtering、candidate-action availability filtering、
"发生 override 才计入"、post-hoc exclusion。

## 9. 判定（预登记）

```
RESEARCH PASS               integrity valid
                            且 mean delta >= +2.00pp
                            且 95% CI lower bound > 0
                            含义：存在独立正向证据，且 point estimate 达到工程门槛。
                            不得表述成"已证明真实地主提升至少 2pp"。

BELOW ENGINEERING TARGET    95% CI upper bound < +2.00pp

INCONCLUSIVE                其余（例如 mean +1.5pp 且 CI > 0；
                            或 mean +3pp 但 CI 跨 0）。不临时追加 seeds。

INVALID                     只用于 integrity failure / candidate identity mismatch /
                            protocol violation / corrupted evaluation data。
                            棋力差不属于 INVALID。
```

## 10. Worker / reproducibility

沿用已由 1/4/8 scaling 验证 deterministic 的 **8-worker** runner
（`digest 52eed2f7…` 在三档上相同）。要求：deal identity 不依赖 worker count；
RNG identity 不依赖 shard assignment；canonical merge；deal-level atomic checkpoint；
resume 不重写 completed deals；scientific content hash 与调度无关。

## 11. No-peek

运行期间 console/status 只显示：progress、completed/total、throughput、elapsed、
ETA、worker state、checkpoint count、integrity/operational error。

**禁止显示**：wins、losses、running delta、better/worse、running CI、
role win rate、secondary result。

PRIMARY 与 SECONDARY 全部 seal 后**一次性 reveal**；
即使 secondary 先完成也不提前查看。

## 12. 本轮不做

farmer retraining、farmer feature change、credit-assignment experiment、
C3/C5 mask attribution、new self-play batch、batch 2/3、policy pool expansion。
农民机制问题留在 development backlog。

研究记录中**不得**写 "three-role self-play disproven"。正确状态：

```
three-role first-batch candidate:  not suitable for whole-bundle advancement
landlord branch:                   selected for independent confirmation
farmer branches:                   insufficient evidence to justify further scaling
```

## 13. 执行顺序

```
1 statistical audit  → 2 candidate manifest freeze  → 3 standalone equivalence
→ 4 landlord deployment benchmark → 5 power calculation → 6 protocol freeze + SHA-256
→ 7 fresh pool allocation → 8 PRIMARY + SECONDARY run → 9 seal → 10 reveal once
→ 11 verdict → 12 STOP
```

1–6 任一步失败：**不分配 fresh validation pool**。
普通 implementation bug 可修复并重跑 pre-validation guards。
一旦 fresh pool 已启动：**不允许修改 candidate 或 scientific protocol**。
