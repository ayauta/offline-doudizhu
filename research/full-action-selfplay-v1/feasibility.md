# Full-action self-play v1 — Feasibility Stage 报告

日期：2026-09-24。分支：`research/farmer-policy-iteration-v1`（工作区）。
状态：**可行性阶段完成**。未启动正式 3-batch research run，未分配任何 fresh pool，
未开启 independent final-validation pool。生产 `ai-v1`（π1）全程冻结。

所有数字都是**实测值**，来源在每节标注。凡是外推，都标明是外推。

---

## 1. BASELINE / REPO STATE

```
HEAD              0d1d3daa4ca95ca9ee67e13d9bbcafb06d012387  bench(ai): freeze farmer policy iteration factory v1
branch            research/farmer-policy-iteration-v1
worktree          起始时仅 research/farmer-pi/pool-ledger.jsonl 为 modified
工程门            pnpm check（tsc + vitest + webview + build + bundle + android + boundaries + privacy + Chromium）
```

**上一轮 FPI 的终局**：`DOUBLE_REJECT`，两次 attempt 都停在 `calibrate`，
detail 逐字相同：`calibration-no-go: no threshold cleared the support floors and the lower bound`。
champion 仍是 `ai-v1`，没有 PROMOTE，没有进入 offline/Stage1/formal。

**它此前没有独立的 research result record。** 该判定只存在于 git 忽略的
`.local/farmer-pi-attempt-001.log` 与 `.local/farmer-pi/factory.json`；
ledger 里没有任何 STOP 事件（52 行里只有 `NAMESPACE_RULE` / `QUARANTINE` /
`RESERVE_NAMESPACE` / `ALLOCATE` / `TRANSITION`），
`research/farmer-pi/attempts/` 与 `champions/` 都是空目录，`report-v1.md` 从未生成。

→ **最小归档方案已执行**：新增 `research/farmer-pi/terminal-v1.md`，
逐条搬运事实与出处（attempt id、两次 detail、calibration 原始计数、模型摘要、
pool 终态、协议 hash），**不改写任何科学结论、不修改 ledger 与协议文件**。
该文件是新增的，唯一的改动是追加，可整文件 revert。

**π1 不可变身份**（本次复核，未改动）：

```
模型 sha256   010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359  (src/app/ai/cf-model-data.ts)
阈值          0.01
schema        version 2, sha256 0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0, 86 列
```

**⚠️ 当前工作区 `pnpm check` 是红的，且与本次改动无关。** 实测：

```
tests/core/farmer-pi-protocol.test.ts   2 条失败
  1) readLedger(FACTORY_LEDGER_PATH) —— 读的是活的 ledger
  2) "allocates atomically and refuses the same attempt twice"
     LedgerError: Pool factory-v1/attempt-001/train is already in the ledger.

证据（只读）：
  HEAD 的 ledger        16 行，包含 "factory-v1/attempt-001" 的次数 = 0
  工作区 ledger         52 行，同一字符串出现 18 次
  前 16 行与 HEAD 逐字节相同（纯 append）
  git status 在本次会话开始时已经是  M research/farmer-pi/pool-ledger.jsonl
```

也就是说：上一轮真实运行的 ledger 追加**没有提交**，而这两条测试把「活的 ledger」
当成了"运行前"的 fixture。**本次改动没有触碰 ledger，也没有触碰那两条测试。**
`terminal-v1.md` 是新增文件，不改任何既有内容。

这只影响 `pnpm check` 的绿灯，不影响本报告的任何数字。

**已按 (a) 修复（2026-09-24，commit A `23b31ce`）**：
真实 ledger 作为历史事实提交；`tests/core/farmer-pi-protocol.test.ts` 中
依赖 ledger *内容* 的四条 guard 改为读一份**自建的四行最小 ledger fixture**
（namespace rule + 两个已关闭的历史 pool + reserve，全部是字面量，不读磁盘）。
仍读真实 artifact 的只剩一条 `readLedger`/`foldPools` 解析检查，
它断言的性质对任何长度的合法 ledger 都成立。

已验证：把 `allocateAttempt` 的 duplicate 守卫改坏后，该 guard **确实变红**；
恢复后 `pnpm check` **全绿**（52 files / 672 tests / 9 步全过）。
旧 FPI 的协议、模型、判定、`stage0-status.md` 里记录的 freeze 时刻 ledger SHA **一律未改**。

**两个旧工程事项的现状**（复核后确认）：

1. retry 继承 train pool 时把 `CONSUMED` 写回 `REVEALED` —— 真实运行中**发生过一次**
   （2026-09-23T20:47:19.963Z，`factory-v1/attempt-001/train`），被
   `benchmarks/farmer-pi-pools.ts:558-562` 正确拒绝，因为 `movePool` 是 best-effort 的，
   所以只报告不中断。ledger 未被污染。性质确认为 benign bookkeeping bug。
2. `championChainById` 只认 `ai-v1` —— 没有 PROMOTE，**未触发**。

两者本线都不需要，因此**未扩建旧 champion-chain infrastructure**。

**新 pool 名额**：未分配。可行性阶段使用 retired 原型区间 `5001–5400`
（`docs/research/ai-used-seed-ledger.md` §1 已登记为「仅机械 prototype 与吞吐测量」）。

---

## 2. FULL LEGAL ACTION ENUMERATION

**结论：引擎已有的 `generateLegalActions` 在本规则集下未发现遗漏。本线不新建第二个枚举器。**

独立 oracle 的实现方式：逐一遍历手牌的全部非空子集，交给 `validatePlay`，
按 rank-count vector 规范化后做集合比较。它与生成器**不共享任何枚举逻辑**——
生成器按牌型形状构造候选，oracle 按子集穷举并询问判定器——
所以任何分歧都是证据，而不是同一个假设的复述。

覆盖范围（全部实测）：

| 检查 | 规模 | 结果 |
| --- | --- | --- |
| 手牌 size 1–12，随机，含 lead 与 response | 96 个 context | 集合差为空 |
| 目标牌型固定用例（含 12 张连续顺、10 连对、四带两对、rocket、炸弹） | 18 个 | 集合差为空 |
| 随机满手牌 13 / 15 / 17 / 20 张，穷举 | 105 手 | 集合差为空 |
| 真实对局 decision 状态（含 response） | 1193 个 | 无非法动作、无重复 identity、`pass` 仅在被允许时出现 |

七条 guard 全部落地为可执行检查，并且**都验证过会红**：

1. 枚举出的动作全部合法 —— `auditEnumeratedActions`（重新走 `validatePlay`）。
2. 小牌量状态与 brute-force oracle 对照 —— 上表。
3. π1 当前实际动作存在于新 legal set —— `tests/core/selfplay-policy.test.ts`
   对 9 个真实状态断言每个 bundle 的选择都在枚举集内；
   另有一个 12 ply × 4 role × 3 landlord 的扫描。
4. 无隐藏 topK —— 选取路径上没有 `slice` / limit / filter；
   另有反证测试：把动作集截断后 oracle 会报出缺失。
5. 相同状态下 action order deterministic —— `auditActionOrder.stableAcrossCalls`。
6. tie behavior deterministic —— `argmaxAction` 固定，见 §3。
7. `pass` 仅在合法时出现 —— `auditPassLegality` 断言
   `offersPass === (currentPlay !== null)`。

**canonical identity**：`RANK_ORDER` 索引的 count vector。`classifyPlay` 是 count vector 的纯函数，
所以这既是完备的也是无关花色的。`rankSlotOf` 的闭式映射被逐张（54 张）钉在 `getCard().rank` 上。

**canonical order / tie-break**：沿用生成器自身的顺序（pattern kind → card count →
main rank strength → card id），它是 structural order，**不含旧 expert ranking、不含牌值启发式**，
且在互异动作上是全序。tie-break 取位置最靠前者。
**已知副作用（必须写进协议）**：顺序以 `pass` 结尾、以最小 single 开头，
所以平局解成最小 single 而不是 pass。

---

## 3. STATE-ACTION FEATURE SCHEMA

`benchmarks/selfplay-features.ts`。`SELFPLAY_FEATURE_SCHEMA_VERSION = 1`，
**403 列**，`selfplayRow(view, action)` —— **恰好两个参数**。

分块：自身手牌 34（15 个 rank count + 19 个结构描述子）· 候选动作 23 ·
动作后手牌 47（15 + 19 + emptiesHand + 12 个 delta）· 公共局面 72 · bounded history 228
（12 个事件 × 19）。

**与旧 86 列 schema 的三处刻意不同**，每一处都有 guard：

1. **没有 parent action。** `cfRow(view, action, a0)` 有 35 列描述 `a0` 或其差值；
   这里一列都没有。`selfplayRow.length === 2` 被断言，
   且列名被正则扫描，禁词 `a0|reference|parent|production|policy|seed|deal|batch|episode|winner|label|reward`
   一个都不出现。
2. **只用合法观测。** 模块作用域里没有 `GameState`。
   leakage guard：把两个隐藏手牌重新洗牌后**逐列不动**（3 个 deal × 3 个 variant），
   并配有一个**非空验证**——同一份重洗确实会改变终局胜者，所以前一条 guard 不是在对
   "什么都没测" 做断言。
3. **不含手工牌力权重。** 引擎自带的 `controlCards`（1/2/3/4 系数）与
   `structureScore`（2/5/7/8/10/9/12 系数）**没有复用**。理由不是"它们不好"，
   而是它们会把"这副牌好不好"直接喂给模型，使 §5 的判据无法与 schema 自身区分。
   保留的是它们所基于的**无权重计数**，加上 `minimumTurns`（结构量）。

`minimumTurnsFromCounts` 是从 count vector 直接算的快路径，被 10 个表驱动用例 +
400 个随机手牌钉在引擎的 `estimateBasicHandTurns` 上；
`trickOwnership` 被钉在 `currentPlaySeat` 上。

history 长度冻结为 **12**，最近的事件在前；不足 12 个用 `patternKind = -1` 填充，
与真 pass（`0`）可区分。

---

## 4. THREE-ROLE COLLECTION SEMANTICS

`benchmarks/selfplay-collector.ts`。每个 initial deal group 跑三个 scenario
（`L` / `F-next` / `F-prev`），**learning seat 三个 scenario 共用 `SEAT_ORDER[dealIndex % 3]`**，
landlord 分别取 `i` / `i+2` / `i+1`，于是同一副牌覆盖三个角色，且没有任何 seat 系统性地当学习者。

* learning seat：本 batch 的 bundle，探索开
* 另外两个 seat：batch 开始前冻结的 bundle，探索关
* **训练行只来自 learning seat**；另一侧的 trajectory 保存做审计，不进入当前角色的 Q target

ε = 0.10，uniform over ALL legal actions，`behaviorProbability = (1-ε)·1[greedy] + ε/K`
逐条写入。第一版**不做 importance weighting**。

所有随机源都是 keyed counter：
`keyedExplorationRandom(salt, dealSeed, scenarioIndex, seatDecisionIndex)`、
`keyedOpponentRandom(salt, dealSeed, scenarioIndex)`。
两者**都不读任何结果字段**。

已验证（`tests/core/selfplay-collector.test.ts`，10 条 guard 全绿）：

* 同一 config 重放**逐字节相同**（JSON.stringify 全等）；
* 一个 group 单独采集 == 同一 group 在一个 5-group 窗口里采集；
* 实测探索率 9.9%（1200 groups / 31290 行），目标 10%；
* `explored` 与 `actionChanged` 两个字段分开：均匀抽样**可能**抽回 greedy 动作，
  所以 `explored` 不蕴含动作改变，反之成立（这条被测试钉住）；
* **fork 复现性**：把 fork 点强制成该局原本执行的动作、且不改 mixture 时，
  fork 的胜者与原局**完全相同**。这条是专门用来抓"重放走偏"的回归——
  第一版实现里 exploration 在 fork 模式下被提前关掉，导致重放在 fork 点之前就发散，
  这条 guard 抓到了它。

采集语义的实测形态（1200 groups）：

```
plies/game 30.5   rows/group 26.1   learning decisions 31290
positive rate 46.0%   mean legal actions at a learning decision 7.3
```

动作族覆盖（rehearsal 池 40 groups / 1310 个 learning decision，最细粒度的一次统计）：

```
pass 667  single 317  pair 148  straight 55  triple-with-pair 50  consecutive-pairs 28
triple-with-single 21  airplane-with-pairs 7  rocket 6  four-with-two-pairs 6
airplane-with-singles 2  triple 1  four-with-two-cards 1  bomb 1
```

**这不是"覆盖已经充分"。** 在 1310 个决策里，`bomb`、`four-with-two-cards`、
`airplane-with-singles`、`triple` 各只出现 1–2 次。放大到完整 batch（~19.6 万行）
按比例也只有 ~150 次量级。**ε > 0 不等于覆盖充分**，这一条必须进 freeze draft。

---

## 5. CONTROLLED LEARNING SANITY RESULT

这一节是本次可行性阶段的核心。运行：**1200 个 retired 原型 group
（3 × 1200 = 3600 局），31290 train 行 / 8044 dev 行，按 group 切分**。
输出全部标记 `DEVELOPMENT_ONLY`，写在 `.local/selfplay-rehearsal/`。

### 5.1 它有没有学到"动作"

| role | train MSE | dev MSE | 常数基线 (dev) | dev 优于基线 |
| --- | --- | --- | --- | --- |
| landlord | 0.0449 | 0.1746 | 0.2441 | −28.5% |
| farmer-next | 0.0445 | 0.2121 | 0.2500 | −15.2% |
| farmer-previous | 0.0400 | 0.2286 | 0.2497 | −8.5% |

模型**不是纯记忆**：三者在 dev 上都优于常数基线，landlord 上幅度不小。

**同状态 vs 跨状态离散度**（这是"学会了动作排序还是只学会状态强度"的直接判据）：

| role | within-state SD | between-state SD | 比值 |
| --- | --- | --- | --- |
| landlord | 0.0554 | 0.2754 | **0.201** |
| farmer-next | 0.0351 | 0.2713 | **0.129** |
| farmer-previous | 0.0288 | 0.2458 | **0.117** |

读完：动作条件信号**存在，但比状态信号弱 5–8 倍**。
`mean spread`（同状态内 max−min）为 0.173 / 0.099 / 0.081。

**消融（这是本次最关键的一条）**：用**同一批行、同一组参数**，
把 `act_*` / `post_*` / `delta_*` 三类列**整体删掉**再训一次（331 列 vs 403 列）：

| role | state-only dev MSE | full dev MSE | 动作列带来的下降 | state-only 离散度比值 |
| --- | --- | --- | --- | --- |
| landlord | 0.18740 | 0.17460 | −6.8% | **0.000** |
| farmer-next | 0.21602 | 0.21206 | −1.8% | **0.000** |
| farmer-previous | 0.23263 | 0.22855 | −1.8% | **0.000** |

两件事同时被证实：

1. **离散度这个判据本身是有效的**，不是自证。state-only 模型在定义上无法在同一状态内
   给出不同分数，它的比值恰好是 **0.000**；而 full 模型是 0.117–0.201。
   这是一个阳性对照：如果判据在测别的东西，这里就不会是 0。
2. **动作列确实携带了 dev 上的、状态列没有的信息**：噪声下限之外还有 1.8–6.8% 的 MSE 下降。
   **但幅度很小**，且与 §5.2 的 fork 结果方向一致——
   这些列带来的是几个百分点的效应，而几百个 root 的 fork 看不见几个百分点。

**动作改变率**（模型 argmax vs 行为策略的 greedy 动作，dev 上）：

```
landlord 1107/2814 = 39.3%   farmer-next 1031/2642 = 39.0%   farmer-previous 1294/2588 = 50.0%
其中 chosen ∉ old C3：398 / 338 / 552        chosen ∉ old C5：同上
```

按阶段：opening 的比例最高（landlord 558/988 = 56%），endgame 最低（140/681 = 21%）。

### 5.2 反事实 fork：模型的动作排序**没有**被证明有效

300 个 development root state × 3 arm，全部从**同一个 simulator 状态**出发，
强迫一个动作后用同一个冻结 bundle 走完：

```
win rate        parent policy 50.0%   model argmax 51.0%   median legal 47.0%
model vs parent 25 better / 22 worse        diff +1.00pp   SE 2.29pp   95% CI [−3.48, +5.48]pp
model vs median 30 better / 18 worse        diff +4.00pp   SE 2.31pp   95% CI [−0.53, +8.53]pp
distinct arms   146/300 个 root 的三臂互不相同
rank agreement  0.520（49 个有判定分歧的 root）
```

**读法**：点估计方向为正（对 parent +1.0pp，对任意 median 规则 +4.0pp），
但 95% CI 都跨过 0，rank agreement 0.520 与 0.5 无法区分。
**在这次 rehearsal 的尺度上，模型的 action ranking 既没有被证明有效，也没有被证明无效。**

### 5.3 为什么这个诊断本身看不见效应（关键发现）

用本次**实测**的分歧率（model vs parent：47/300 = 15.7%）反算需要的样本量：

```
分辨 +2pp（planning target）：n ≈ 6,020 roots
分辨 +3pp：                  n ≈ 2,675 roots
分辨 +5pp：                  n ≈   963 roots
```

预登记的 **300 roots 对 +2pp 目标是欠功率约 20 倍**。
这不是模型的失败，是**诊断设计的失败**，必须在 freeze draft 里改掉，
否则正式 run 会在一个看不见目标效应的仪器上做判定。

### 5.4 Task E 的判定

Task E 的停止条件是「model 只学到 state strength 而几乎不区分 action」。
本次实测的答案是**否**：within-state SD 非零，比值 0.12–0.20，
argmax 相对行为策略改变了 39–50% 的动作，其中 12–21% 落在旧 C3/C5 之外
（`chosen ∉ C3` 与 `∉ C5` 计数相同，说明被选中的动作要么在 C3 内，要么同时在 C5 外）。

**但"区分了"不等于"区分对了"。** 现在的完整答案是三句话，缺一不可：

* **学到了**：删除全部动作列后 dev MSE 变差（1.8–6.8%），离散度比值从 0.117–0.201
  掉到 0.000。动作列不是装饰。
* **学得很少**：效应只有几个百分点量级；同状态离散度比跨状态离散度小 5–8 倍。
* **没有被证明有用**：300-root 的 fork 分辨不了几个百分点（CI 全部跨 0）。

把这三句合并成"学到了动作排序"或"什么也没学到"都是不诚实的。

### 5.5 端到端确定性

**两次独立的 1200-group 运行**（不同进程、间隔约 6 分钟）产出**逐字节相同的模型摘要**：

```
landlord        44a5c50a2aaa39a0…    farmer-next 2787f5b5d2cfb279…    farmer-previous de5cd28116133434…
train rows      31290 / dev 8044（两次相同）    train L2 0.044907 / 0.044526 / 0.040033（两次相同）
fork            parent 50.0% / model 51.0% / median 47.0%（两次相同）
```

（`collectSeconds` 两次不同——537.9 s vs 545.5 s——因为第二次与其它负载共享 CPU。
**只有时间戳不同，数据与模型完全相同。**）

---

## 6. RUNTIME / STORAGE / MODEL COST

全部实测。区分**研究运行时**与**潜在生产运行时**。

### 6.1 枚举与打分

| 项 | 值 |
| --- | --- |
| legal action count（all，3038 个真实 decision） | mean 9.4 · p50 2 · p95 28 · p99 88 · max 230 |
| 其中 leading（289 个） | mean 25.4 · p50 10 · p95 75.6 · p99 140.6 · max 230 |
| 其中 responding（904 个） | mean 4.4 · p50 2 · p95 8 · p99 11 · max 42 |
| action enumeration 延迟 | p50 0.092 ms · p95 0.304 ms · p99 0.494 ms · max 1.137 ms |

「leading 时 p95 有 76 个动作」是全动作枚举成本的**决定因素**：特征生成与打分
是 O(K)，不是 O(1)。

### 6.2 采集（研究运行时）

**已由 2026-09-24 的 250-group 独占实测取代**（`benchmarks/selfplay-runtime.test.ts`，
batch-1 完整配置：3 scenario/group、learning bundle = π1、mixture 对 P0 50/25/25、
ε = 0.10、auditProposal 开、写 float32 blob）：

| 环境 | ms/group | 7500-group batch | 3 batches |
| --- | --- | --- | --- |
| rehearsal 池（`casual` 学习 / `default` 历史，auditProposal 开） | 393 | 0.82 h | 2.5 h |
| **batch-1 配置（π1 学习 / P0+π1 mixture），250 groups 实测** | **4784.8** | **9.97 h** | **29.9 h** |

实测的完整指标：

```
wall 1196.2 s / 250 groups / 750 games      12.54 groups/min   37.62 games/min
cpu 1197.6 s over 1196.2 s wall = 100.1% of one core
rss 86 MB -> 356 MB                         plies/game 34.13
decisions/group 34.13   rows/group 34.13    rows/batch 255,990
行存储 55,157 B/group -> 0.414 GB / batch    600-group dev 0.80 h
positive rate 56.77%    explored 10.10%
```

与 6-group 外推的 9.4 h 相差 6%——但**现在是测量，不是外推**。
另外测得采集是 **100.1% of one core**（单线程），所以多进程切分 deal group 是纯机械加速，
不改变任何科学语义。

### 6.3 训练与存储

| 项 | 值 |
| --- | --- |
| 训练 3 个模型（full） | **11.7 s**（31290 行总规模，`num_threads=1`） |
| 单模型 JSON | 1.16–1.23 MB（512 trees × 63 leaves × 403 列） |
| 三个模型 | **3.4 MB** |
| 每 group 行数 | 26.1（本次 1200-group 实测） |
| 7500-group batch 行数 | ~196,000 |
| 行存储（float32，403 列） | ~0.32 GB / batch |

### 6.4 潜在生产运行时（不在本阶段范围，但必须记录）

三个模型合计 **3.4 MB JSON**。当前 shipped worker bundle 的预算是
**123,575 B gzip**（Spec 063 `final-validation.md`）。**相差约 28 倍。**
任何把它搬进产品的想法都要先解决这个预算。这不是本线的判定条件，
也不应该反过来限制研究 schema。

---

## 7. DATA-INTEGRITY / LEAKAGE TESTS

| guard | 文件 | 已验证会红？ |
| --- | --- | --- |
| 隐藏手牌重洗后 feature 逐列不动 | `tests/core/selfplay-features.test.ts` | 是（且配非空验证：重洗会改终局胜者） |
| 行只由 `(view, action)` 决定，元数 = 2 | 同上 | 是 |
| 列名不含 `a0`/seed/deal/winner/reward 等 | 同上 | 是（正则扫描） |
| 没有 parent action 的 delta 列 | 同上 | 是 |
| 枚举无遗漏 / 无重复 / 无非法 | `tests/core/selfplay-actions.test.ts` | 是（反证：截断会被 oracle 报出） |
| `pass` 仅在合法时出现 | 同上 | 是 |
| 枚举顺序 deterministic | 同上 | 是 |
| 采样 key 不含 label / 结果 | `tests/core/selfplay-collector.test.ts` | 是（改 key 必改流） |
| 同 group 三个 scenario 同侧 split | 同上 | 是 |
| 探索不吃结果 | 同上 | 是 |
| 同一 config 重放逐字节相同 | 同上 + `benchmarks/selfplay-collector-bench.test.ts` | 是 |
| fork 重放精确复现原局 | 同上 | **是——它抓到了第一版的 exploration 提前关闭 bug** |

`benchmarks/selfplay-dataset.ts` 把 provenance 定义为一个**与 feature 分开的类型**，
`rowsOfEpisodes` 只把 `features` 交给模型、把 `provenance` 写在行旁。

---

## 8. REUSED INFRASTRUCTURE

复用：`transition` / `generateLegalActions` / `validatePlay` / `classifyPlay`（引擎，
**零改动**）· `createPlayerView` 的 redaction · `dealDeck` / `startWithLandlord` /
`dealGameSeed` 的种子推导 · `seededRandom` 的 LCG · `cfActionCommand` / `cfCommandKey`
的动作→命令映射 · `frozenPi1Chain` 的 π1 身份 · `cfProposal` / `cfProposal5`
（仅用于 C3/C5 覆盖审计）· `scoreTrees` / `parseTreeModel` 的树求值器 ·
`estimateBasicHandTurns` / `currentPlaySeat`（作为被钉住的参照）·
`aim-tournament` 的 deal/seed 约定 · `.local/pylibs` 的 LightGBM 4.6.0。

**没有复用**：旧 Farmer PI 的状态机、协议、pool ledger 类型、attempt 生命周期。
新逻辑全部在新 namespace（`benchmarks/selfplay-*.ts`）下，
旧抽象与新抽象没有合并成一个万能框架。

**`src/` 零改动。** 本线没有触碰 `src/**` 的任何文件。

---

## 9. NEW CODE / TESTS / COMMITS

新增（全部在 `benchmarks/`、`scripts/`、`tests/`、`research/`）：

```
benchmarks/selfplay-actions.ts          canonical identity + 独立 brute-force oracle + 7 条 guard
benchmarks/selfplay-features.ts         403 列 state-action schema（无 a0）
benchmarks/selfplay-policy.ts           role/scenario 映射、tie-break、bundle、对手 mixture
benchmarks/selfplay-collector.ts        三角色采集器 + fork
benchmarks/selfplay-dataset.ts          split / manifest / schema hash / provenance 分离
benchmarks/selfplay-diagnostics.ts      离散度、改动作率、回归误差
scripts/selfplay-train.py               LightGBM 训练 + full / state-only 消融 + 树表导出
benchmarks/selfplay-legal-bench.test.ts      规模化的 oracle 校验与动作数分布
benchmarks/selfplay-collector-bench.test.ts  采集器因果性、确定性、成本
benchmarks/selfplay-rehearsal.test.ts        端到端 rehearsal（env 门控）
tests/core/selfplay-actions.test.ts     (36)
tests/core/selfplay-features.test.ts    (27)
tests/core/selfplay-policy.test.ts      (12)
tests/core/selfplay-collector.test.ts   (10)
research/farmer-pi/terminal-v1.md       上一轮 DOUBLE_REJECT 的归档记录
research/full-action-selfplay-v1/…      本线 README / feasibility / freeze-draft
```

`tests/core/selfplay-*.test.ts` 全部进 `pnpm check`（85 条 guard，约 15 s）。
`benchmarks/selfplay-*.test.ts` 只在 `pnpm bench:ai` 下运行，但**会被 `tsc` 检查**。

---

## 10. KNOWN RISKS

1. **诊断欠功率（高）。** §5.3 实测：300-root 反事实集对 +2pp 目标欠功率约 20 倍。
   不改这一点，正式 run 的 dev 判定等于抛硬币。
2. **schema 相对数据量过大（高）。** 403 列 / 每角色 1 万行（rehearsal）≈ 25 行/列。
   正式 batch 每角色约 6.5 万行 ≈ 160 行/列，仍属偏小；
   `min_data_in_leaf = 100` 会进一步限制树在"同状态少数动作"上的分裂能力。
   这是**待验证的工程起点**，不是已证明的配置。
3. **动作效应可能本来就小（中，且是领域性质）。** 一局里 learning seat 有 ~11 次决策，
   单次决策对终局的影响被摊薄；实测 fork 的三臂胜率差在 1–4pp 量级。
   如果真实效应就是 1–2pp，那么任何以 terminal win/loss 为唯一 target 的
   Monte-Carlo 方法都需要极大的样本量，这与研究提案里的 planning target 一致，
   但意味着**成本被低估**。
4. **稀有动作族覆盖极薄（中）。** `bomb` / `four-with-two-cards` /
   `airplane-with-singles` 在一个 1310 决策样本里各 1–2 次。
5. **P0/PI1 成本外推不可靠（中）。** 9.4 h/batch 来自 6 个 group。必须用 ≥200 groups 实测。
6. **成本与产品预算差 28 倍（低，本阶段不构成判定条件）。**
7. **未测**：resume 跨进程（只测了同进程内的 group 级确定性）·
   真实 worker/browser 推断路径（本线没有产品化，未走 Worker）·
   磁盘 IO 与 checkpoint seal（本阶段只写了一个 rehearsal 目录）。

---

## 11. FREEZE DRAFT

见 [`freeze-draft.md`](freeze-draft.md)。其中 `[D]`（需要决定）项共 11 条，
最重要的一条是**诊断的样本量**，另一条是**是否接受 `master × master` 的采集成本**。

---

## 12. GO / NO-GO RECOMMENDATION FOR THE 3-BATCH RESEARCH RUN

**判定范围**：只评价**工程与学习闭环是否具备开始正式 research run 的条件**，
不评价棋力。

### GO（有条件）—— 但**不建议现在启动**，建议先做一次"诊断先行"的补测

**支持 GO 的实测事实：**

* 全合法动作枚举在 1400+ 个状态上与独立 oracle 无分歧，延迟 p95 0.3 ms；
* 403 列 state-action schema 不依赖 parent action，且 leakage guard 全部**已验证会红**；
* 三角色单 learning-seat 采集器端到端跑通，逐字节确定，fork 重放精确；
* 学习闭环真的闭合：1200 groups / 31290 行 → 训练 11.7 s → 三个可推理的模型；
* 模型**不是**只学到状态强度：within-state SD 非零，比值 0.12–0.20，
  39–50% 的决策改变了动作，其中 12–21% 落在旧 C3/C5 之外；
* 在 dev 上优于常数基线 8.5–28.5%。

**阻止现在启动的实测事实：**

* **§5.2 的判定仪器本身欠功率。** 预登记的 300-root 反事实集对 planning target
  欠功率约 20 倍。在一个看不见目标效应的仪器上跑三批正式采集，
  是在花 28 小时买一个 `INCONCLUSIVE`。
* P0/PI1 的 9.4 h/batch 是 6 个 group 的外推，不是测量。
* `min_data_in_leaf = 100` 与 403 列 schema 在 1–6 万行规模上是否为合适配置，未验证。

**建议的最小补测（不消耗任何 fresh pool，仍用 `5001–5400`）：**

1. 把 development 反事实集从 300 提到 **≥3000 roots**（实测 2675 roots 可分辨 +3pp），
   或者**改变诊断的形态**——例如把"整局胜负"换成"这一步之后本方的局面优势代理"，
   后者方差低得多，是更可能在这个预算内看见效应的仪器。**这一条需要复核者决定。
   **
2. 用 **200–300 个 group** 实测 P0/PI1 池的真实斜率，替换 9.4 h 的外推。
3. 在同一批数据上跑一次 `min_data_in_leaf` ∈ {25, 100} 的**一次性对照**
   （不是超参搜索，是二选一的工程对照），并在 dev 上比较。

补测通过后，**GO**。补测若显示即便在 3000+ roots 上也看不见方向性，则 **NO-GO**，
理由不是工程不可行，而是**这条机制线在可承受的样本量下无法被判定**——
那是一个关于机制的结论，应该写进研究记录，而不是用更多算力盖过去。

### 明确没有做的事

* 没有启动任何正式 batch；
* 没有分配 fresh seed pool；
* 没有开启 final-validation pool；
* 没有修改 `src/`、没有触碰 π1、没有改动旧 Factory 的任何文件或 ledger 行。
