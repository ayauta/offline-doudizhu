# Dual-environment rehearsal — report

状态：**REHEARSAL / DEVELOPMENT**。不产生 KEEP / REVERT，不触碰 production π1，
不分配 final-validation pool。协议见 [`rehearsal-protocol.md`](rehearsal-protocol.md)（跑前冻结）。

---

## A. PRE-RUN CLARIFICATIONS

### A.0 先纠正上一份报告里的三处口径

1. **prototype 的训练规模是 1200 个 group，不是约 400。**
   证据：`.local/selfplay-rehearsal/manifest.json` 的 `seedRange [5001, 6200]`、`groups 1200`。
2. **模型体积的倍数是 7.0×，不是 28×。** 上一份报告拿 3.4 MB（**未压缩**）去比
   123 KB（**gzip 预算**），是不同口径相减。同口径见 §L。
3. **"7 shells still running" 是 7 个空闲的 bash 等待循环**，不是计算。
   它们的命令行里含有 `selfplay-powered` 字样，而循环条件是
   `until ! pgrep -f "selfplay-powered"` —— 于是每个循环都匹配到**自己**，永远不退出。
   实测：CPU 0.0%、load average 0.12；没有任何 node/vitest/python 在算。
   已在 2026-09-25 00:36 全部 kill（PID 3261756 / 3272779 / 3283492 / 3295121 / 3317486 / 3327511），
   之后 `pgrep -fa "selfplay"` 只剩命令自身。**没有任何后台计算被遗留。**

### A.1 prototype 的精确训练规模

```
训练 group 数        1200           seedRange [5001, 6200]
dataset              fas-dataset-v1, label DEVELOPMENT_ONLY
schema hash          502946fd7e880422dd13dde49fcb25afdb63e16269a2ef56357432f72aa509cf
feature count        403
```

### A.2 每角色的 episode 数与 training rows

每个 group 跑 3 个 scenario，共 **3600 局**；learning seat 每局恰好一个。

| role | training rows | dev rows（同一次 1200-group 运行的 20% split） |
| --- | ---: | ---: |
| landlord | 11,019 | 2,814 |
| farmer-next | 10,359 | 2,642 |
| farmer-previous | 9,912 | 2,588 |
| 合计 | 31,290 | 8,044 |

三个数字加起来 31,290，与 `manifest.out.json` 的 `rows` 一致。
（上一份报告里出现的 "400 groups" 没有出处，作废。）

### A.3 prototype 的完整采集配置（不再写 "cheap/casual"）

```yaml
bundles:
  REH-current: { kind: tier, tier: casual }    # rankScoredPlayActions(context,"casual",{analyzerNodes:24})
  REH-history: { kind: tier, tier: default }   # DEFAULT_AI_STRATEGY，出厂 casual 规则策略
learningBundleId: REH-current
mixture: { version: fas-mixture-v1, current: REH-current, history: [REH-history],
           weights: { current: 0.50, sharedHistory: 0.25, independentHistory: 0.25 } }
epsilon: 0.10
explorationSalt: 0x5eed1001
mixtureSalt: 0x5eed2002
auditProposal: true
collector: fas-collector-v1，3 scenarios/group，learning seat = SEAT_ORDER[dealIndex % 3]
```

### A.4 87 个 excluded group 的逐类原因

用 `benchmarks/selfplay-exclusion-audit.test.ts` 重跑**恰好那 87 个** group
（先由 merged summary 的 kept 集合取补集，只重跑被排除的，不重跑 6000 个）：

```
reasons  every-decision-had-one-legal-action = 87 / 87
by role  farmer-next 46, farmer-previous 41, landlord 0
by seat  ai-two 46, human 41
decisions per episode: 1×1, 2×27, 3×30, 4×11, 5×9, 6×5, 7×2, 8×1, 9×1
winner   landlord 76, farmer 11
```

**没有 crash、没有 timeout、没有 malformed、没有 integrity failure。**
全部是同一个机械原因：learning seat 全程处于"只能 pass"的局面
（合法动作数恒为 1），于是 root 规则找不到落脚点。

一条必须记录的**选择性效应**：地主**从不**被排除（地主总是领出，合法动作数 ≥ 2），
而被排除的 87 局里有 76 局是**地主赢**。也就是说这条 root 规则系统性地丢掉了
"农民被碾压"的局，root 池偏向"learning seat 还有得打"的对局，且这个偏向按角色不对称。
powered diagnostic 的 5913 个 root 是在这个条件下取得的。

### A.5 模型体积的三种口径

见 §L。结论先行：3-role **raw 3.557 MB / gzip 0.795 MB**；
production 同口径 **raw 0.508 MB / gzip 111.6 KB**。同压缩口径的倍数是 **7.0×**。

### A.6 后台状态

见 A.0。只有空闲等待 shell，已全部清理；`pnpm check` 与所有测量都在之后重跑过。

---

## B. 1/4/8 WORKER SCALING

固定小型 DEVELOPMENT deal set：`919001–919200`（200 组，已暴露的机械测量切片，
**没有为 throughput test 新建 scientific pool**）。1/4/8 worker 使用**同一组 IDs、
同一 role assignment、同一 policy configuration、同一 keyed RNG identity、
同一 exploration semantics、同一 collector implementation**。

```
workers   wall_s   groups/min   games/min   cpu_s   eff%   rss/worker_MB  rss_total_MB   speedup   efficiency
      1    927.1        12.94       38.83     930    100            368           368      1.00        1.000
      4    313.9        38.22      114.67    1232    392            321          1162      2.95        0.738
      8    200.8        59.75     179.25    1547    770            313          2128      4.62        0.577
```

**Determinism guard（本次最重要的结果）：**

```
merged collection digest identical across all worker counts : true
training rows identical                                    : true (6526)
digest  52eed2f7f8d15839bbeee434253c42a7f0e11f16fd4daff70866c4fbc89dcccd
```

digest 覆盖的是**科学内容**：per-group episode identity、learning role、
action sequence、exploration decisions、terminal reward、training rows、provenance。
**不覆盖**：wall-clock、PID、shard-local operational metadata。
三者相等说明：

* deal seed 不依赖 worker id；
* scenario assignment 不依赖 shard-local offset；
* keyed RNG 不依赖 scheduling order；
* CPU contention 不改变 action selection（1/4/8 三档在负载 1 到 8 之间，digest 相同）。

**内存**：`rss/worker` 368 → 313 MB，**不随 worker 数增长**；
total RSS = `workers × per-worker`，有界。没有单调无界增长。

**一条如实记录的限定**：0.577 是并行效率的**下界**。这个 scaling 测试为了测
"disk bytes/group" 而**每组每 split 每 role 写一个小文件**（200 组约 1200 个文件），
真实采集路径写的是**每 shard 6 个聚合文件**（见 §M 的实际吞吐：TARGET 分支
7500 组在 8 worker 下 160.6 min，折合 46.7 groups/min，而 1 worker 单测是 10.6 groups/min，
实际加速 4.4×，效率 0.55 —— 与 scaling 测试同量级）。

**决定**：worker count = **8**（已验证 deterministic 的最大档）。

---

## C. REHEARSAL PROTOCOL + HASH

`research/full-action-selfplay-v1/rehearsal-protocol.md`

```
sha256  124b968c72add0d7ecc2c30a4e163c5da44f6abc0b860b8020afeb42d5ae4f55
```

冻结于收集开始之前。跑了之后**没有**根据任何中间结果修改它；
唯一的事后追加是 §8 的 worker-count 决定，而协议本身写明该决定由 §2 的测量得出。

冻结内容：两个 branch 的完整环境 manifest、group 区间、train/diagnostic split、
feature schema hash、LightGBM 配置、ε、RNG identity、Evaluation A 的 root 规则与 arm、
Evaluation B 的 1200 group IDs、统计量、排除规则、worker count、no-peek 规则。

---

## D. CHEAP TRAINING SUMMARY

```
branchId            CHEAP
bundles             REH-current = tier casual (scoring casual, analyzerNodes 24)
                    REH-history = tier default (DEFAULT_AI_STRATEGY)
learningBundleId    REH-current
mixture             current REH-current 50% / shared-history 25% / independent 25%
epsilon 0.10        explorationSalt 0x5eed1001   mixtureSalt 0x5eed2002   auditProposal true
groups              7500   (train 907001-913000 = 6000; diagnostic 913001-914500 = 1500)
rows                246,811
  train.landlord 70,195 | train.farmer-next 65,277 | train.farmer-previous 61,994
  dev.landlord   17,556 | dev.farmer-next   16,357 | dev.farmer-previous   15,432
positive rate       46.28%
explored            10.09%
executed ∉ old C3   13,970/246,811 (5.66%)      ∉ old C5  9,003/246,811 (3.65%)
wall                16.8 min (8 workers)        written 398.8 MB
collection digest   8dbc393fc4d96b9b…
```

| role | rows | trees | train L2 | state-only L2 | 动作列带来的下降 |
| --- | ---: | ---: | ---: | ---: | ---: |
| landlord | 70,195 | 512 | 0.094017 | 0.101230 | −7.12% |
| farmer-next | 65,277 | 512 | 0.110635 | 0.115666 | −4.35% |
| farmer-previous | 61,994 | 512 | 0.118672 | 0.124194 | −4.45% |

## E. TARGET TRAINING SUMMARY

```
branchId            TARGET
bundles             PI1 = pi1-chain ai-v1, tier master (master + frozen cf overlay on farmer seats)
                    P0  = tier master (pre-pi1 production AI)
learningBundleId    PI1
mixture             current PI1 50% / shared-history 25% / independent 25%
epsilon / salts / auditProposal   与 CHEAP 完全相同
groups              7500（同一组 IDs，同一个 split）
rows                252,135
  train.landlord 69,707 | train.farmer-next 67,184 | train.farmer-previous 64,931
  dev.landlord   17,300 | dev.farmer-next   16,820 | dev.farmer-previous   16,193
positive rate       54.87%
explored            10.09%
executed ∉ old C3    5,409/252,135 (2.15%)      ∉ old C5  3,495/252,135 (1.39%)
wall                160.6 min (8 workers)       written 407.5 MB
collection digest   3606c60dccc4ee82…
```

| role | rows | trees | train L2 | state-only L2 | 动作列带来的下降 |
| --- | ---: | ---: | ---: | ---: | ---: |
| landlord | 69,707 | 512 | 0.076077 | 0.083222 | −8.59% |
| farmer-next | 67,184 | 512 | 0.104930 | 0.105699 | −0.73% |
| farmer-previous | 64,931 | 512 | 0.108007 | 0.110843 | −2.56% |

**两条只看训练数据、不看胜负的观察**（no-peek 允许的 operational 内容）：

* 两个 branch 的 rows 数几乎相同（246,811 vs 252,135），**规模是被控住的**。
* ε 的实际探索率两边都是 **10.09%**，说明两个环境下的探索语义没有被环境改变。
* `executed ∉ old C3` 差 2.6 倍（5.66% vs 2.15%）：CHEAP 的行为策略是 casual 规则策略，
  它本来就不总在 expert top-3 里；TARGET 的行为策略就是 π1 本身，离开 C3 几乎只由 ε 造成。

---

## L. MODEL SIZE BY CONSISTENT FORMAT

同压缩口径才能算倍数。三个数字都是**文件字节数**，不是 JS 字符串长度。

| 口径 | raw | gzip -9 |
| --- | ---: | ---: |
| CHEAP 三角色（本 rehearsal，7500 groups） | 6,154,997 B = **6.155 MB** | 1,410,261 B = **1.410 MB** |
| TARGET 三角色（本 rehearsal，7500 groups） | 6,151,786 B = **6.152 MB** | 1,406,814 B = **1.407 MB** |
| prototype 三角色（上一轮，1200 groups） | 3,556,538 B = 3.557 MB | 795,309 B = 0.795 MB |
| production `src/app/ai/cf-model-data.ts`（单个 86 列模型） | 507,631 B = 0.508 MB | 114,329 B = **111.6 KB** |
| production worker bundle 预算（Spec 063 final-validation） | — | 123,575 B |

**同 gzip 口径的倍数：1.410 MB / 111.6 KB = 12.9×**（prototype 时代是 7.1×）。
上一份报告里的 "28×" 是把未压缩的 3.4 MB 去比 gzip 预算得到的，口径不一致，**作废**。

一个值得单独记录的观察：**训练数据变多以后模型变大**（raw 3.557 → 6.155 MB），
因为 512 棵树的 63 个叶子终于被数据填满了。也就是说模型体积会随 batch 规模继续变化，
现在这个数字不是稳态值。

**仍然只是 deployment risk，不驱动本次任何配置改动。**

---

## F. SINGLE-STEP PAIRED RESULTS（Evaluation A）

pool `900001–906000`，5913 组（87 excluded，见 §A.4/N），103.9 min wall。
三个 arm 在**同一 root state** 上，同一次运行内 paired。

```
win rates    pi1 57.940%   CHEAP 59.158%   TARGET 60.122%

TARGET - CHEAP   Δ +0.964pp  SE 0.469pp  95% CI [+0.045, +1.883]pp   413 / 356 / 5144
TARGET - pi1     Δ +2.182pp  SE 0.482pp  95% CI [+1.237, +3.126]pp   472 / 343 / 5098
CHEAP  - pi1     Δ +1.218pp  SE 0.485pp  95% CI [+0.267, +2.169]pp   448 / 376 / 5089
```
（`better / worse / tie`）

**TARGET − CHEAP 是正的且 CI 不含 0**，而且是**同组直接 paired**，
不是两份独立报告的 point estimate 相减。

## G. SINGLE-STEP ROLE BREAKDOWN

```
landlord        (2000 cells)
  TARGET - CHEAP  +0.850pp  SE 0.971pp  CI [-1.053, +2.753]   197/180/1623
  TARGET - pi1    +9.550pp  SE 1.057pp  CI [+7.478, +11.622]  328/137/1535
  CHEAP  - pi1    +8.700pp  SE 1.038pp  CI [+6.665, +10.735]  310/136/1554

farmer-next     (1954 cells)
  TARGET - CHEAP   0.000pp  SE 0.694pp  CI [-1.361, +1.361]    92/ 92/1770
  TARGET - pi1    -1.433pp  SE 0.663pp  CI [-2.732, -0.134]    70/ 98/1786
  CHEAP  - pi1    -1.433pp  SE 0.655pp  CI [-2.716, -0.150]    68/ 96/1790

farmer-previous (1959 cells)
  TARGET - CHEAP  +2.042pp  SE 0.735pp  CI [+0.601, +3.482]   124/ 84/1751
  TARGET - pi1    -1.736pp  SE 0.688pp  CI [-3.083, -0.388]    74/108/1777
  CHEAP  - pi1    -3.777pp  SE 0.742pp  CI [-5.232, -2.323]    70/144/1745
```

## H. FULL-TAKEOVER RESULTS（Evaluation B）

pool `915001–916200`，1200 组 × 3 role = 3600 cells，**0 excluded**，62.6 min wall。
tested seat 整局用 candidate，另外两个 seat 始终 π1，全程 exploration OFF。

```
CHEAP  - pi1    Δ -2.167pp  SE 0.813pp  95% CI [-3.760, -0.573]pp   390 / 468 / 2742
TARGET - pi1    Δ -0.167pp  SE 0.820pp  95% CI [-1.775, +1.441]pp   433 / 439 / 2728
TARGET - CHEAP  Δ +2.000pp  SE 0.785pp  95% CI [+0.461, +3.539]pp   436 / 364 / 2800
```

## I. FULL-TAKEOVER ROLE BREAKDOWN

```
landlord        (1200 cells)
  CHEAP  - pi1    +11.833pp  SE 1.517pp  CI [+8.860, +14.807]   245/103/852
  TARGET - pi1    +13.250pp  SE 1.590pp  CI [+10.133, +16.367]  272/113/815
  TARGET - CHEAP   +1.417pp  SE 1.521pp  CI [-1.564, +4.397]    175/158/867

farmer-next     (1200 cells)
  CHEAP  - pi1     -6.583pp  SE 1.286pp  CI [-9.103, -4.064]     82/161/957
  TARGET - pi1     -8.417pp  SE 1.325pp  CI [-11.013, -5.820]    80/181/939
  TARGET - CHEAP   -1.833pp  SE 1.280pp  CI [-4.341, +0.675]    107/129/964

farmer-previous (1200 cells)
  CHEAP  - pi1    -11.750pp  SE 1.319pp  CI [-14.336, -9.164]    63/204/933
  TARGET - pi1     -5.333pp  SE 1.244pp  CI [-7.771, -2.895]     81/145/974
  TARGET - CHEAP   +6.417pp  SE 1.253pp  CI [+3.960, +8.873]    154/ 77/969
```

三个 role **分别展示**。它们的符号不一致，任何把它们平均掉的数字都会同时
隐藏一个 +13pp 和一个 −8pp。

## J. TARGET-vs-CHEAP PAIRED COMPARISON

**同一组 root / 同一组 deal 上直接 paired**，不是两份报告的差：

| evaluation | TARGET − CHEAP | SE | 95% CI | better/worse/tie |
| --- | ---: | ---: | --- | --- |
| A（single-step，5913 组） | **+0.964pp** | 0.469 | [+0.045, +1.883] | 413 / 356 / 5144 |
| B（full takeover，3600 cells） | **+2.000pp** | 0.785 | [+0.461, +3.539] | 436 / 364 / 2800 |

按 role：

| role | A: TARGET−CHEAP | B: TARGET−CHEAP |
| --- | --- | --- |
| landlord | +0.850pp [−1.053, +2.753] | +1.417pp [−1.564, +4.397] |
| farmer-next | 0.000pp [−1.361, +1.361] | −1.833pp [−4.341, +0.675] |
| farmer-previous | +2.042pp [+0.601, +3.482] | **+6.417pp [+3.960, +8.873]** |

**两个独立评测在同方向上给出 TARGET > CHEAP，且都 CI 不含 0。**
这是本 rehearsal 对 "训练环境" 这个 treatment 的核心回答：
在训练规模被控住（7500 组 vs 7500 组、row 数 246,811 vs 252,135、
ε 实测都是 10.09%）的条件下，**换环境确实改变结果**。

## K. ACTION DEVIATION / C3-C5 COVERAGE

**偏离 π1 的比例**（Evaluation A，5913 组）：
CHEAP 在 3998/5913 = **67.6%** 的 root 上选了与 π1 不同的第一手；
TARGET 在 3964/5913 = **67.0%**。两者选到**同一个动作**的有 2143/5913 = **36.2%**。

**是否落在旧候选集里**（固定子样本：每 50 组取 1，118 组，事前固定，标注为 subsample）：

```
in old C3   parent 100.00%   CHEAP 59.32%   TARGET 61.86%
in old C5   parent 100.00%   CHEAP 72.03%   TARGET 77.97%
outside C3  parent  0.00%    CHEAP 40.68%   TARGET 38.14%
outside C5  parent  0.00%    CHEAP 27.97%   TARGET 22.03%
pick == pi1 action           CHEAP 29.66%   TARGET 25.42%
```

（parent 在 C3 里是 100% 是同义反复：root 就是 π1 自己产生的状态。）

两个模型都在约 **六成**的 root 上选到旧 top-3 之内、约 **四成**在 top-3 之外、
约 **四分之一**在 top-5 之外。作为对照，采集阶段"离开 C3"的比例只有
2.15–5.66%，且几乎全由 ε 造成 —— 也就是说**这些偏离是模型的选择，不是探索的残留**。

**coverage 只记录，不修**（§13）：稀有动作族的事实见
`benchmarks/selfplay-runtime.test.ts` 的输出与 `freeze-draft.md` §4.1。
既不 over-sample、也不改 ε、也不分层探索。
既不声称 "coverage sufficient"，也不声称 "rarity is intrinsic" —— 只记录出现次数。

## N. INTEGRITY / EXCLUSIONS

```
Evaluation A   5913 / 6000（87 excluded = 1.45%）
  原因全部为 every-decision-had-one-legal-action（逐类见 §A.4）
  无 crash / timeout / malformed / integrity failure
  root 与重放的 legal action 数在每一组上一致（不一致会 throw）
  arm A 用 baseline 结果 + 每 50 组强制重放一次做一致性校验：全部相符
Evaluation B   1200 / 1200 groups，0 excluded
  每个 (group, role) cell 都完成；role/scenario 映射逐组断言
collection     两个 branch 各 7500 组，没有丢组
  merge 时校验：shard 窗口必须恰好平铺、deal group 不得重复
  —— 这条校验在第一次 CHEAP 合并时**真的红了**（见下）
```

**一次被 guard 抓到的真实 bug**：第一次 CHEAP 收集跑完后 merge 拒绝执行，
报 `merged digests contain a duplicate deal group`。原因：train 窗口与 diagnostic 窗口
**各自从 shard index 0 开始编号**，于是两个窗口写进了同一个输出目录，
后者覆盖了前者的 rows，merge 里同一个窗口被读到两次。
已修（拼接 plan 后重新编号，并加 uniqueness 断言），两个 branch 全部重跑。
这个 bug 不会影响任何 policy/RNG 结果，但它会**静默丢数据**——这正是
"merge 必须校验平铺与唯一性"的理由。

## M. ACTUAL WALL TIME / RESOURCE COST

```
1/4/8 scaling（200 组，batch-1 配置，独占）
  w1 927.1 s   w4 313.9 s   w8 200.8 s       确定性：三档 collection digest 完全相同

CHEAP  收集 7500 组   16.8 min  (8 workers)    → 446 groups/min
TARGET 收集 7500 组  160.6 min  (8 workers)    →  46.7 groups/min
   （TARGET 单 worker 实测 10.6 groups/min，8 worker 实际加速 4.4×，效率 0.55）

训练（每 branch 3 个 full 模型 + 3 个 state-only 消融，num_threads=1）≈ 1 min / branch

Evaluation A  5913 组 × 3 armed runs   103.9 min (8 workers)
Evaluation B  3600 cells × 3 局        62.6 min  (8 workers)
   （A 与 B 并发跑，16 进程 / 16 核）

本轮总计墙钟 ≈ 6.6 h（含第一次 CHEAP 失败重跑）
```

**实测**：TARGET 环境采集 **46.7 groups/min @ 8 workers** ⇒
7500-group batch ≈ **2.7 h/批**（不是之前外推的 9.97 h —— 那是单 worker；
也不改变"3 批 ≈ 8 h @ 8 workers"这个量级判断）。这些数字只是测量，
不驱动任何 scientific 语义改动。

---

## L'. 模型摘要（provenance）

```
CHEAP   landlord d0bb33a9ddb24ff4…   farmer-next 71cb190441ad7c9f…   farmer-previous af8b5e76243b9e47…
TARGET  landlord dfc35a05e67e7124…   farmer-next 4e44dd30bdc5a284…   farmer-previous b81cc3174e5445b7…
```
（完整 sha256 见 `.local/selfplay-reh/<branch>/train-input/manifest.out.json`。）

---

## O. INTERPRETATION USING THE PREDEFINED CASE MATRIX

先把六个 case 逐条对照，**不改标准**：

| case | 条件 | 是否命中 |
| --- | --- | --- |
| 1 | single-step T>C **且** full takeover T>C/π1 | **部分**：前两条成立，第三条不成立 |
| 2 | C 与 T 都明显优于旧 prototype，但 T vs C 分不清 | 否 —— T vs C 两次都 CI 不含 0 |
| 3 | single-step T 改善，但 full takeover 明显退步 | 否 —— takeover 对 π1 是 −0.167pp（CI 含 0），不是明显退步 |
| 4 | single-step T 仍差，但 full takeover 改善 | 否 —— 方向相反 |
| 5 | 等规模 T 在两者都明确较差 | 否 —— single-step 与 takeover 对 π1 都不是"明确较差" |
| 6 | 区间仍宽 / 混杂 | 宽度上否（SE 0.47–0.82pp），**按 role 是混杂** |

**结论：没有一个 case 被干净命中。** 最接近的是 case 1 的前两条，
但第三条（takeover 上 TARGET > π1）以 −0.167pp 失败。

### O.1 这次真正得到的四件事

**(1) 训练环境是真的 treatment，而且方向一致。**
TARGET − CHEAP 在**两个独立评测**上都为正、都 CI 不含 0：
single-step **+0.964pp** [+0.045, +1.883]，full takeover **+2.000pp** [+0.461, +3.539]。
规模被控住（7500 vs 7500 组；rows 246,811 vs 252,135；
两边实测探索率都是 10.09%）。这是本次 rehearsal 对 A/B 问题的直接回答：
**换环境会改变结果，且不是噪声。**

**(2) 但 TARGET 整体并没有赢过 π1。**
full takeover `TARGET − π1 = −0.167pp`，CI [−1.775, +1.441] —— 与 π1 无法区分。
本线的目标是"相对 π1 有独立整局增益"，这个目标**没有达成**。

**(3) 聚合数字掩盖了一个巨大且显著的 role 不对称。**

```
landlord         TARGET - pi1   single-step +9.550pp [+7.478, +11.622]
                               takeover   +13.250pp [+10.133, +16.367]
farmer-next      TARGET - pi1   single-step -1.433pp [-2.732, -0.134]
                               takeover    -8.417pp [-11.013, -5.820]
farmer-previous  TARGET - pi1   single-step -1.736pp [-3.083, -0.388]
                               takeover    -5.333pp [-7.771, -2.895]
```

两个评测**符号一致**，takeover 把幅度**放大**。
按 §10 要求的措辞：这个结果与
**"旧地主自身仍可能有较多可改进空间，而 π1 的 farmer 已经较强"相容**。
必须保持正确的区分：**地主 candidate 面对的是 π1 的 farmers**；
未被 π1 farmer overlay 强化的是**旧 landlord baseline 本身**，不是"地主面对了一个弱对手"。

**(4) single-step 与 full takeover 会分道扬镳——分道的方式是"稀释"，不是"反转"。**
`TARGET − π1` 在 single-step 是 **+2.182pp**（CI 不含 0），
在 full takeover 是 **−0.167pp**（CI 含 0）。
**一步的优势没有复利到整局；它被后续决策摊平到零。**
这与 case 4 的结论同向（"single-step π1-continuation diagnostic 不能作为唯一 architecture gate"），
只是从相反的方向到达：这里 single-step 是**乐观**的。

### O.2 不做的解释

* **不**把 C arm（median canonical legal action）当作 benchmark，也**不**说
  "模型学会了不乱出牌"或"挽回了多少比例损失"。
  上一轮 C arm 的 `model − median` CI 含 0；本轮 §J 的结论只立足于
  **TARGET − CHEAP** 与 **TARGET − π1** 这两组，且它们是同组 paired。
* **不**把 single-step 的数字与 full takeover 的数字放进同一张表相加减。
* **不**声称 environment mismatch 已被完全解释：本 rehearsal 只做了
  "廉价环境 vs π1 环境"这一个对比，训练规模虽被控住，但两个环境的
  **对手强度、胜率分布（positive rate 46.28% vs 54.87%）、以及 Q target 的方差**都不同。

---

## P. GO / NO-GO / INCONCLUSIVE FOR THE 3-BATCH RESEARCH RUN

> 只回答：是否值得进入**预先设计的三批 full-action self-play research run**？
> 不代表 production promotion。

## **NO-GO（按当前设计）**

三条理由，每条都基于本轮实测：

1. **目标未达成。** 设计的目的是"相对 π1 有独立整局增益"，
   而 full takeover 的 `TARGET − π1 = −0.167pp`（CI 含 0）。
   两个评测都**没有**给出 TARGET 整体优于 π1 的证据。

2. **聚合会洗掉一个显著的退步。** 两个农民角色在 takeover 下分别是
   **−8.417pp** 与 **−5.333pp**，各自 CI 不含 0。§12 定义的 `ΔJ`
   是 3 roles × 2 environments 的平均 —— 在这个数据上，
   它会把一个 +13.25pp 和一个 −8.42pp 掺成一个接近 0 的数，
   然后让三批预算去"确认"这个 0。**按 role 分别看，这条线的两个角色是明确退步的。**

3. **唯一强正信号指向的是另一个问题。** 地主侧在**两个独立评测**里都大幅为正
   （single-step +9.55pp、takeover +13.25pp，CI 都不含 0，符号一致），
   而三批 run 的设计是为"整局三角色 ΔJ"服务的，不是为"地主专线"服务的。
   把它塞进现有三批设计，等于用一个为别的问题造的仪器去测它。

**这不是对机制的普遍否定。** 本轮证明了：全动作枚举、403 列无 `a0` schema、
三角色单 learning-seat 采集、Monte-Carlo terminal target、LightGBM 三个模型，
这一整套工程闭环可以等规模地跑起来、可以确定性地产出、并且**环境这个变量是真的**。

**若将来要再走一次，本报告建议的起点**（供 review，不自行启动）：
先做一次**地主专线**的小规模 rehearsal，并对农民侧的退步做失败机制诊断
（是 state-strength 主导、还是 partner 相关的 credit assignment、
还是 takeover 下的 distribution shift）。这两件事都需要**新的预登记**，
不能借用本轮的 case matrix 结论。

**没有做的事**：没有启动 batch 2 / batch 3；没有启动 independent formal validation；
没有 production integration；没有改 ε / history length / LightGBM 参数 / reward / mixture；
没有做 pruning、feature selection 或 `min_data_in_leaf` sweep；
没有因为看到中间结果追加任何 N；没有触碰 production π1。
