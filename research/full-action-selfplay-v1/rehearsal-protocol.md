# Dual-environment rehearsal — protocol (FROZEN before the run)

状态：**REHEARSAL / DEVELOPMENT**。这份协议在收集开始前冻结，跑完后不根据任何中间结果修改。
它不是 final scientific protocol，不产生 KEEP / REVERT，不触碰 production π1，
不分配任何 final-validation pool。

冻结时间：2026-09-25（写入本文件即视为冻结）。

---

## 0. 要区分的两件事

| | |
| --- | --- |
| **A. 训练规模** | prototype 只有 1200 个 group |
| **B. 训练环境** | prototype 在廉价环境训练，评测在 π1 环境 |

本 rehearsal 的设计：**两个 branch 用完全相同的 group IDs、完全相同的规模、
完全相同的 feature/RNG/训练配置，只有环境不同。** 于是 A 被控住，剩下的差异只能归给 B。

**不做的**：不改 LightGBM 参数、不做 `min_data_in_leaf` sweep、不做 feature selection、
不做 pruning、不改 ε、不 over-sample 稀有动作。

---

## 1. 冻结的 group 分配（DEVELOPMENT reservation 内）

`research/full-action-selfplay-v1/development-pool.md` 声明 `900001–920000` 为
FAS v1 development pool。本协议在其内部分配：

| 用途 | 范围 | 数量 | 状态 |
| --- | --- | ---: | --- |
| powered diagnostic（已消耗） | `900001–906000` | 6000 | 已暴露，**永久失去 final-validation 资格**，可继续作 development 对照 |
| **本 rehearsal 的 TRAIN** | **`907001–913000`** | **6000** | 本次首次使用 |
| **本 rehearsal 的 DIAGNOSTIC** | **`913001–914500`** | **1500** | 本次首次使用 |
| **Evaluation B (full takeover) 的 dev pool** | **`915001–916200`** | **1200** | 本次首次使用，事前冻结 IDs |
| 时序 pilot / scaling | `919001–919200` | 200 | 已暴露，仅机械测量 |

**train / diagnostic split 按上表冻结，不重新抽样。**
两个 branch 使用**同一组 IDs 与同一个 split**。

---

## 2. 两个 branch 的完整环境 manifest

### Branch `CHEAP` — 复现 prototype 的训练环境

```yaml
branchId: CHEAP
bundles:
  REH-current: { kind: tier, tier: casual }    # rankScoredPlayActions(context,"casual",{analyzerNodes:24})
  REH-history: { kind: tier, tier: default }   # DEFAULT_AI_STRATEGY（出厂 casual 规则策略）
learningBundleId: REH-current
mixture:
  version: fas-mixture-v1
  current: REH-current
  history: [REH-history]
  weights: { current: 0.50, sharedHistory: 0.25, independentHistory: 0.25 }
epsilon: 0.10
explorationSalt: 0x5eed1001
mixtureSalt: 0x5eed2002
auditProposal: true
```

### Branch `TARGET` — freeze draft 的 batch-1 目标环境

```yaml
branchId: TARGET
bundles:
  PI1: { kind: pi1-chain, championId: ai-v1, tier: master }   # master + frozen cf overlay on farmer seats
  P0:  { kind: tier, tier: master }                            # pre-π1 production AI
learningBundleId: PI1
mixture:
  version: fas-mixture-v1
  current: PI1
  history: [P0]
  weights: { current: 0.50, sharedHistory: 0.25, independentHistory: 0.25 }
epsilon: 0.10
explorationSalt: 0x5eed1001
mixtureSalt: 0x5eed2002
auditProposal: true
```

两个 branch **只在 bundles 与 mixture 的成员上不同**：
learning seat 的 bundle、两个对手 bundle、以及由它们产生的 trajectory 与 rows。
salts、ε、weights、scenario 语义、split、feature schema 全部相同。

**两个 branch 的 rows 分开保存，绝不混料。**

---

## 3. 冻结的采集与训练配置

```yaml
collector: benchmarks/selfplay-collector.ts   COLLECTOR_VERSION = fas-collector-v1
groupSemantics: 3 scenarios per group (L / F-next / F-prev); learning seat = SEAT_ORDER[dealIndex % 3]
actionIdentity: ACTION_IDENTITY_VERSION = fas-action-identity-v1
featureSchema: SELFPLAY_FEATURE_SCHEMA_VERSION = 1, 403 columns
historyLength: 12
reward: terminal team win = 1 / loss = 0, gamma = 1
importanceWeighting: none
replayCorrection: none
trainingRows: one row per learning-seat decision (state, executed action, terminal reward)
```

LightGBM（与 freeze draft 一致，**不 sweep**）：

```yaml
objective: regression   metric: l2        num_iterations: 512   max_depth: 8
num_leaves: 63          learning_rate: 0.05   min_data_in_leaf: 100   lambda_l2: 5
max_bin: 255            num_threads: 1    deterministic: true   force_col_wise: true
seed: 20260924          from scratch, no early stopping
```

---

## 4. Evaluation A — single-step greedy deployment diagnostic

* pool：`900001–906000`（已暴露的 development 对照池，**不是**独立验证）
* root 规则：与已冻结的 powered diagnostic 相同 —
  learning seat 的**第一个合法动作数 ≥ 2 的 decision**
* arm：`A = π1 action`、`B = CHEAP model argmax`、`C = TARGET model argmax`
  （三个 arm 在**同一 root state** 上，同一次运行内相互 paired）
* forced action 之后：三个 seat 全部用同一冻结 π1 bundle，**探索 OFF**
* 统计单位：**initial deal group**
* primary：`TARGET − CHEAP`（同组 paired）；另报 `TARGET − π1`、`CHEAP − π1`
* 不追加 N，不因为 CI 宽而延长

## 5. Evaluation B — full-policy takeover

* pool：`915001–916200`，1200 个 group，IDs 事前冻结
* 对每个被测 role（landlord / farmer-next / farmer-previous）分别：
  * baseline arm：该 role **整局每一次 decision 都用 π1**
  * candidate arm：该 role **整局每一次 decision 都用 candidate model**
  * 另外两个 seat **始终** π1；所有 exploration **OFF**
* 三个 role 的 landlord 分配用与 collector 相同的轮换规则，使每个 role 恰好被覆盖
* 统计单位：**initial deal group**
* 对 CHEAP 与 TARGET **各跑一遍完整设计**；同 design 下再报 `TARGET vs CHEAP`
* 三个 role **分别展示，不平均后隐藏**

## 6. 排除规则（事前固定）

* Evaluation A：违反 root 规则的 group 记为 `excluded`，
  并在 `exclusion-audit` 里逐类列原因（已有实现：`benchmarks/selfplay-exclusion-audit.test.ts`）。
  任何 crash / timeout / malformed / integrity failure **不是排除，是停止**。
* Evaluation B：不排除任何 group。若某局无法完成，记为 integrity failure 并停止。
* 训练：不删除 0 reward / 输局 / 差探索；不 over-sample 胜局。

## 7. No-peek

训练期间只公开 progress / throughput / memory / checkpoint 数 / 运行错误。
**不公开** partial win rate、partial TARGET-vs-CHEAP delta、partial role delta、partial CI。
评测全部 seal 后统一揭示。

## 8. Worker count（2026-09-25 由 §2 结果决定）

1/4/8 scaling 实测（200 组，batch-1 配置）：

```
determinism  merged collection digest identical across all worker counts: true
             training rows identical: true (6526)
digest       52eed2f7f8d15839bbeee434253c42a7f0e11f16fd4daff70866c4fbc89dcccd

workers  wall_s  groups/min  games/min  cpu_s  rss/worker_MB  rss_total_MB  speedup  efficiency
      1   927.1       12.94      38.83    930            368           368     1.00       1.000
      4   313.9       38.22     114.67   1232            321          1162     2.95       0.738
      8   200.8       59.75     179.25   1547            313          2128     4.62       0.577
```

**决定：worker count = 8。** 理由：8 是**已验证 deterministic** 的最大档；
12 未验证，且效率已从 0.738 掉到 0.577，边际收益小。
worker 数只允许改变 wall time —— 这一条已由 digest 相等证明。

**两条要如实记录的观察**：

1. `rss/worker` 在 368 → 313 MB 之间**没有随 worker 数增长**，total RSS 是
   有界的 `workers × per-worker`，没有单调无界增长。
2. 效率下降的来源**部分是这次 scaling 测试自己的写入模式**：它为了测
   "disk bytes/group" 而**每组每 split 每 role 写一个小文件**（200 组约 1200 个文件），
   而真实采集路径写的是**每 shard 6 个聚合文件**。因此 0.577 是效率的**下界**，
   正式 rehearsal 的真实吞吐以它自己的测量为准。

不为省时间改算法、加 pruning、做特征/模型裁剪。

## 9. 完成后

无论结果如何：**不启动 batch 2 / batch 3 / formal validation / production integration。**
按 §8 的 case matrix 解释，然后 STOP 等 review。
