# Full-action self-play v1 — FREEZE DRAFT

状态：**草案，等待复核**。本文不是已经生效的预登记。任何一项在复核通过之前
都还不是冻结值；复核通过的项由复核者指定，不由本文件自行宣布。

标注约定：

* `[S]` 稳定 —— 有实测或结构性证据支撑，且没有发现需要权衡的替代方案；
* `[D]` 需要决定 —— 存在多个合理取值，本文给出建议与取舍理由；
* `[M]` 需要测量 —— 可行性阶段已给出数字，但数字本身指向一个仍未做的选择。

---

## 1. 动作表示与顺序

| 项 | 建议冻结值 | 状态 |
| --- | --- | --- |
| 动作 identity | `RANK_ORDER` 索引的 count vector；`pass` 为独立 identity `"pass"` | `[S]` |
| identity 版本串 | `ACTION_IDENTITY_VERSION = "fas-action-identity-v1"` | `[S]` |
| 花色 | 完全无关；同一 count vector 的所有花色组合视为同一动作 | `[S]` |
| canonical order | `generateLegalActions` 自身的顺序：pattern kind → card count → main rank strength → card id | `[S]` |
| tie-break | 取 legal action list 中**位置最靠前**的最高分动作 | `[S]` |

`[S]` 的依据：`classifyPlay` 是 rank-count vector 的纯函数（`src/core/rules/classify-play.ts`），
所以 count vector 是完备的 identity；`compareActions` 是 structural order，
**不含 expert ranking、不含牌值启发式**，且在互不相同的动作上是全序。

**要写进协议的 tie-break 副作用**：顺序以 `pass` 结尾、以最小的 single 开头，因此
平局不会解成 pass，而会解成最小的 single。这是确定的，但它是**有偏的**——
必须在任何正式判定里作为已知性质声明，而不是当作中性规则。

---

## 2. 枚举完备性

| 项 | 值 | 状态 |
| --- | --- | --- |
| 枚举器 | 复用引擎的 `generateLegalActions`，**不新建第二实现** | `[S]` |
| 完备性证据 | 与逐子集 brute-force oracle 的集合差为空 | `[S]` |
| 隐藏 topK | 无。选取路径上没有任何 `slice` / limit / filter | `[S]` |

---

## 3. Feature schema

| 项 | 建议冻结值 | 状态 |
| --- | --- | --- |
| 版本 | `SELFPLAY_FEATURE_SCHEMA_VERSION = 1` | `[S]` |
| 函数元数 | `selfplayRow(view, action)` —— **恰好两个参数** | `[S]` |
| parent action | 不存在任何 `a0` / reference / delta-to-parent 列 | `[S]` |
| history 长度 | `SELFPLAY_HISTORY_LENGTH = 12`（最近 12 个公开事件，最近在前） | `[S]` |
| 更早历史 | 只保留累计公开统计量（played / unseen / turnIndex） | `[S]` |
| 缺失编码 | 无值处用 `NaN`；"没有动作"用 `patternKind = -1`，与真 pass（`0`）区分 | `[S]` |
| 手工牌力权重 | 不复用引擎的 `controlCards` / `structureScore`（系数是手调的） | `[S]` |
| schema hash | sha256 over `{datasetVersion, featureSchemaVersion, actionIdentityVersion, collectorVersion, names}` | `[S]` |

**这条 `[S]` 的理由要写清楚**：`controlCards` 与 `structureScore` 是既有实现，复用它们不算
"新增启发式"，但它们会把"这副牌好不好"直接喂给模型，
从而让"模型只学到状态强度"这个失败模式**无法与本 schema 自身区分开**。
Task E 的整个判据依赖这一点，所以它们被排除。

**403 列本阶段不做任何裁剪**（2026-09-24 决定）：prototype 每角色约 1 万行，
`rows / columns` 偏低是一个**风险提示，不是特征选择准则**；完整 batch 每角色约 6.5 万行。
不做 feature selection sweep，也不因"列多"删列。
每次报告固定包含：train/dev MSE、state-only 消融、同状态离散度、tree split 覆盖。

---

## 4. Reward / 折扣 / 探索

| 项 | 建议冻结值 | 状态 |
| --- | --- | --- |
| terminal reward | 阵营胜 = 1，负 = 0；三角色按阵营取值 | `[S]` |
| gamma | 1（Monte-Carlo，无 bootstrap） | `[S]` |
| 炸弹倍率 / 积分 / shaping | 一律不用 | `[S]` |
| epsilon | `0.10` | `[D]` |
| behavior probability | 每条记录 `(1-ε)·1[greedy] + ε/K`，逐条写入 | `[S]` |
| importance weighting | 第一版**不做** | `[S]` |
| 训练时探索 | 开；开发/正式评估时 | 关 | `[S]` |

`[S]` on ε（2026-09-24 决定）：**ε 保持 0.10，不因覆盖率修改。**
覆盖不足**记为 limitation**，不作为修改探索分布的理由：调 ε 会同时改变行为策略质量
与 Q target 的分布，把"覆盖不够"和"目标变了"两件事混在一起，代价大于收益。
过采样稀有动作同样不做。

### 4.1 动作族覆盖（更新，250-group 实测 / 8533 个 learning decision）

learning seat **实际执行**的动作族：

```
pass 4254   single 2176   pair 992   triple-with-pair 328   straight 316
triple-with-single 223   consecutive-pairs 111   rocket 30   four-with-two-pairs 28
airplane-with-singles 24   bomb 19   airplane-with-pairs 17   four-with-two-cards 12   triple 3
```

按同一比例外推到 7500-group batch（×30）：

| 族 | 本窗口 | 外推 batch | 评价 |
| --- | ---: | ---: | --- |
| pass / single / pair | 4254 / 2176 / 992 | 12.8 万 / 6.5 万 / 3.0 万 | 充足 |
| 带牌类（triple / airplane / four-with） | 328+223+28+24+17+12 | 约 1.9 万 | 充足 |
| straight / consecutive-pairs | 316 / 111 | 9.5 千 / 3.3 千 | 充足 |
| **rocket** | 30 | ~900 | 偏少但可用 |
| **bomb** | 19 | ~570 | 偏少 |
| **triple（裸三张）** | 3 | **~90** | **极稀有，记为 limitation** |

`triple` 极稀有是**规则与策略共同造成的**，不是采样缺陷：裸三张几乎总是劣于三带一或三带二，
所以任何合理策略都很少打它。它保留为 limitation，不因它调整探索。

旧候选集之外的动作：**executed ∉ old C3 = 183/8533 (2.14%)，∉ old C5 = 108/8533 (1.27%)**。
注意这个窗口里 learning bundle 就是 π1，所以"离开 C3"几乎全部由 ε 探索造成
（探索率 10.10%，即约 21% 的探索动作落在 C3 之外）。

---

## 5. 三角色采集语义

| 项 | 建议冻结值 | 状态 |
| --- | --- | --- |
| 每个 initial deal group | 恰好 3 个 scenario：`L` / `F-next` / `F-prev` | `[S]` |
| learning seat | 三个 scenario 共用 `SEAT_ORDER[dealIndex % 3]` | `[S]` |
| landlord 轮换 | `L` → `i`；`F-next` → `i+2`；`F-prev` → `i+1` | `[S]` |
| 每局 learning seat 数量 | 恰好 1 | `[S]` |
| 另外两个 seat | 用 batch 开始前冻结的 bundle，探索**关** | `[S]` |
| 训练行来源 | 只有 learning seat 的 decision | `[S]` |
| 另一侧 trajectory | 保存做审计，**不进入**当前角色的 Q target | `[S]` |
| game seed | `dealSeed * 100 + seatIndex(learningSeat) * 10 + seatIndex(landlord)` | `[S]` |

改为「三个 scenario 用同一个 learning seat」的理由：这样每个 role 都被学到，
且没有任何一个 seat 系统性地当学习者。代价是**三个 scenario 的数据来自同一副牌**，
所以 split 必须按 group 而不是按 episode —— 这一条已经是 `[S]`。

---

## 6. policy pool 与对手采样

| 项 | 建议冻结值 | 状态 |
| --- | --- | --- |
| 初始 pool | `P0`（旧自研 bundle，三个 role 都用 `master` 层） + `PI1`（frozen champion，农民侧带 cf overlay） | `[D]` |
| mixture 权重 | 50% current / 25% 同一历史 bundle / 25% 两个 seat 独立抽 | `[S]` |
| mixture 版本串 | `MIXTURE_VERSION = "fas-mixture-v1"` | `[S]` |
| 抽签 key | `(salt, dealSeed, scenarioIndex)`，**不含**任何结果字段 | `[S]` |
| duplicate identity | **显式拒绝**（同一 bundle 同时出现在 current 与 history 会抛错） | `[S]` |
| history pool 增长 | 第一阶段保留 original baseline / π1 / 最近 3 个 research checkpoint | `[D]` |

`[D]` on `P0`：本线把 `P0` 定为 "pre-π1 的 production AI"，也就是每个 seat 都跑 `master`。
这样 `PI1 = P0 + 一层 overlay` 在结构上成立，与 `final-validation.md` 的历史描述一致。
代价见 §10：两个 bundle 都是 master 时，一批 7500 groups 约 9.4 h。
若复核者选择更便宜的环境（例如 `casual`），**必须**同时接受"学习信号来自更弱的对手"这一语义变化，
并重新预登记，而不是在同一个协议里换。

---

## 7. 一条 training row 是什么

| 项 | 建议冻结值 | 状态 |
| --- | --- | --- |
| row 粒度 | **每个 learning-seat decision 一行**：`(features(view, executed_action), terminal_reward)` | `[D]` |
| 全动作行 | 不存。只存被执行动作的一行 | `[D]` |
| 观测快照 | 每行同时保存 `view`（合法观测，无隐藏信息），供诊断重新枚举与重新打分 | `[S]` |
| provenance | deal/scenario/role/bundle 身份/mixture arm/behavior_probability 全部记录在**行旁**，不进 feature | `[S]` |
| 0 reward / 输局 / 差探索 | **全部保留**，不删、不加权、不 over-sample 胜局 | `[S]` |

`[D]` 的依据与代价：目标 `Q_r(h,a) ≈ E[G_r | h, a]` 的 Monte-Carlo 样本就是
"被执行的那个 a"。存全动作行会把数据量乘以 K（本 rehearsal 实测 K 均值 7.1，
leading 时 p95 达 75），换来的是"未访问动作也有 target"——但那些 target 我们并没有观测到，
只能靠模型自己插值。**本文建议保持单行**，并把"模型能否对未访问动作给出有意义的排序"
交给 §9 的判据去回答，而不是靠存更多行假装回答了它。

---

## 8. 训练配置

| 项 | 建议冻结值 | 状态 |
| --- | --- | --- |
| 模型数 | 每角色一个，共 3 个 | `[S]` |
| objective | `L2 regression` on 0/1 reward | `[S]` |
| trees / depth / leaves | 512 / 8 / 63 | `[D]` |
| learning_rate | 0.05 | `[S]` |
| min_data_in_leaf | 100 | `[D]` |
| lambda_l2 | 5 | `[S]` |
| seed / deterministic | 固定 seed，`deterministic=true`，`force_col_wise=true`，`num_threads=1` | `[S]` |
| 训练起点 | 每个 batch 从零重训三个模型 | `[S]` |
| early stopping / 超参搜索 | 都不用 | `[S]` |
| 输出裁剪 | **不 clamp**；排序用 raw score | `[S]` |
| 模型库 | LightGBM（`.local/pylibs`，4.6.0），不换 | `[S]` |

`[S]` on `min_data_in_leaf = 100`（2026-09-24 决定）：**保持 100，不做 sweep。**
它在一个 batch 只有 ~19.6 万行、每角色 ~6.5 万行、特征 403 列的情况下**可能是主要瓶颈**——
100 的最小叶样本数限制了树能把"同一状态里的少数动作"分开。
但当前最大的未解决问题是**诊断功效**，不是模型容量；同时增加一个 tuning 维度，
会让"powered diagnostic 看不见效应"这件事多出一个无法排除的解释。
若 powered diagnostic 之后出现**训练集上动作信号强、held-out 动作排序明显失效**，
再另立一个 representation/capacity 实验——那是另一条实验线，不在这条线里扫参。

**实测的现状**（1200-group rehearsal，每角色约 1 万行 / 403 列，即约 25 行每列）：

```
full       dev MSE 0.17460 / 0.21206 / 0.22855      state-only dev MSE 0.18740 / 0.21602 / 0.23263
动作列带来的 dev MSE 下降：  −6.8% / −1.8% / −1.8%
离散度比值       0.201 / 0.129 / 0.117              state-only 的同一比值 0.000 / 0.000 / 0.000
```

动作列**确实**携带了 dev 上状态列没有的信息，但幅度只有几个百分点。
**这不构成"100 是对的"或"100 是错的"的证据**——它只说明在这个数据量下，
能提取到的动作信号本来就不大。建议在补测里做一次 `min_data_in_leaf ∈ {25, 100}` 的
**一次性二选一对**（不是搜索），并把 `state-only` 消融作为固定对照一起报告。

---

## 9. 诊断与判据

| 项 | 建议冻结值 | 状态 |
| --- | --- | --- |
| 必须报告 | train / dev regression error；同状态分数离散度；**state-only 消融的 dev error 与离散度**；改动作率；chosen ∉ C3 / C5 率；按 role 与 stage 分解；模型大小；feature 生成与打分延迟 | `[S]` |
| 同状态判别量 | `within-state SD / between-state SD` 比值，**必须与 state-only 消融的同一比值并列报告** | `[S]` |
| development 反事实集 | **6000 个 development deal group，每组恰好一个 root** | `[S]`（2026-09-24 决定） |
| 统计单位 | **initial deal group**，绝不是 decision root | `[S]` |
| root 规则 | learning seat 的**第一个合法动作数 ≥ 2 的 decision**；结果无关、确定性、事前固定 | `[S]` |
| arm A / B | A = π1 在该 root 的动作；B = prototype model 的 argmax | `[S]` |
| 第三个 arm | 只在**固定前 1000 个 group** 上跑；canonical order 的中位下标，若与 A 或 B 重合则上移 | `[S]` |
| continuation | 强迫动作之后，三个 seat 全部改用同一个冻结 bundle，**探索全关** | `[S]` |
| 诊断命名 | **greedy deployment counterfactual diagnostic** | `[S]` |
| 禁止的解读 | 它不是训练 Q target 的无偏估计（训练用 ε=0.10、另一套对手分布），两者**永不合并** | `[S]` |
| 禁止 | 用 hidden state 挑"最好"的 alternative；用该诊断给正式候选补票 | `[S]` |

`[D]` on 第三个 arm：中位下标规则简单、结果盲、可复现，但它与 parent 动作常常重合
（rehearsal 实测 300 root 中只有 78 个三臂互不相同）。
另一个候选是"canonical order 里第一个不在 C3 的动作"，更能测出 C3 之外的价值，
但它依赖旧候选集，会把旧 C3 的定义带进新诊断。
**保持中位下标**，并在与 A 或 B 重合时上移一位，使第三臂尽量真正是"第三个动作"。
"三臂互不相同"的 group 数作为该诊断的**有效样本量**报告。

### 9.0 continuation 语义（2026-09-24 明确）

这是两条**不同**的测量，永远不合并：

| 名称 | 定义 | 能回答什么 |
| --- | --- | --- |
| **greedy deployment counterfactual diagnostic** | forced action 之后所有 seat 用同一冻结 bundle，**探索关** | "在部署式对局下，单步偏离 incumbent 值多少" |
| Q-target 近似诊断（**未采用**） | continuation 保留 learning seat 的 ε=0.10 | 更接近训练时收集 Q target 的分布 |

本线采用**前者**。用户问的是"model argmax 在冻结 greedy/deployment continuation 下，
相对 parent action 是否有可测的 terminal advantage"，正是前者的语义。
把后者当前者用、或把两者的数字放进同一张表，都是错的。

### 9.1 300 这个数字已经改掉（实测，不是推理）

### 9.1 300 这个数字必须改（实测，不是推理）

用 1200-group rehearsal 上**实测**的分歧率反算：

```
model vs parent   实测分歧 47/300 = 15.7%   ->  分辨 +2pp 需要 n ≈ 6,020 roots
                                              分辨 +3pp 需要 n ≈ 2,675 roots
                                              分辨 +5pp 需要 n ≈   963 roots

300 roots 的实际分辨力：
  model vs parent  +1.00pp  95% CI [−3.48, +5.48]
  model vs median  +4.00pp  95% CI [−0.53, +8.53]
  rank agreement   0.520（49 个有判定分歧的 root）
```

**决定（2026-09-24）：走 terminal semantics 的路线，把 N 提到 6000 个 deal group。**

明确否决的两条：

* **不换局面优势 / heuristic proxy。** 本线的核心价值就是直接学 terminal team reward；
  换成低方差 proxy 会改变研究问题本身。当前的问题是"300 个 root 太少"，
  不是"terminal reward 不能用"。
* **不做"先 3000 再说"。** 若 3000 仍欠功率，那就是把一个已知欠功率的仪器跑了两遍。
  N 一次定在 6000。

设计要点（全部事前固定）：

* 每个 **initial deal group 只抽一个 root**，所以 deal group 就是 iid 单位，
  不需要 cluster 修正；**绝不把 root 当独立样本**；
* root 规则与第三个 arm 的规则在跑之前写死，见 §9 的表；
* 三角色由 `dealIndex % 3` 决定 scenario，天然约 1/3 均分；
* 第三个 arm 只在**固定的前 1000 个 group** 上跑，不占主预算。

`300` 这个数字从此作废。6000 是在**实测**分歧率 15.7% 下对 `+2pp` 给出约 ±1.8pp 的
半宽（`1.96·sqrt(0.157/6000) = 1.0pp`）——**这是投影，不是保证**；
真实半宽由运行本身给出，并且**运行开始后不得因为看到中间结果而加 N**。

---

## 10. 成本

| 项 | 实测 | 状态 |
| --- | --- | --- |
| 合法动作数 all | p50 2 / p95 28 / p99 88 / max 230（3038 个真实 decision） | `[S]` |
| 合法动作数 leading | p50 10 / p95 75.6 / p99 140.6 / max 230 | `[S]` |
| 合法动作数 responding | p50 2 / p95 8 / p99 11 / max 42 | `[S]` |
| 枚举延迟 | p50 0.092 ms / p95 0.304 ms / max 1.137 ms | `[S]` |
| 每 group 行数 | 32.75（3 个 scenario 的 learning-seat decision 之和） | `[S]` |
| 7500-group batch 行数 | ~245,000 | `[S]` |
| 单模型 JSON | ~0.2 MB（512 trees，63 leaves，404 features） | `[S]` |
| 三个模型 | ~0.6 MB | `[S]` |
| 训练时间 | 3 个模型 < 1 s（rehearsal 规模） | `[S]` |

`[S]` on 研究运行时（2026-09-24 **实测**，取代此前的 6-group 外推）：

```
配置        batch 1 的完整配置：3 scenario/group、learning bundle = π1、mixture 对 P0 50/25/25、
            ε = 0.10、auditProposal 开、每个 learning decision 建行并写 float32 blob
窗口        250 个 deal group / 750 局，**单进程、独占机器**
wall        1196.2 s  ->  4784.8 ms/group  ->  12.54 groups/min   37.62 games/min
cpu         1197.6 s cpu / 1196.2 s wall = **100.1% of one core**（num_threads=1）
rss         86 MB -> 356 MB
plies/game  34.13      decisions/group 34.13      rows/group 34.13
行存储      55,157 B/group  ->  0.414 GB / 7500-group batch
投影        7500-group batch **9.97 h**   3 batches **29.9 h**   600-group dev **0.80 h**
```

与 6-group 外推的 9.4 h 相差 6%，但**现在是测量**。

`[S]` on 潜在生产运行时：**不构成本阶段的判定条件，也不驱动任何 schema 或参数改动。**
三个 512-tree 模型合计约 3.4 MB JSON，而当前 shipped worker bundle 的预算约 123 KB gzip
（`docs/specs/063-.../final-validation.md`），**相差约 28 倍**。
记为重要 deployment risk；压缩 / 蒸馏 / 减树 / 减 depth 一律**不在本阶段做**——
若研究棋力成功，再单独研究部署并**重新验证压缩后的策略**。

`[S]` on 并行：实测 `100.1% of one core` 说明采集是单线程的，
多进程切分 deal group 是**纯机械**加速（deal group 本来就是 iid 单位），
不改变任何科学语义。是否在正式 run 里用它属于调度决定，不影响本草案的任何一条。

---

## 11. 数据完整性 / 无泄漏

| 项 | 规则 | 状态 |
| --- | --- | --- |
| split 单位 | initial deal group；同 group 三个 scenario 同侧 | `[S]` |
| 跨 batch 混用旧 label | **禁止**。每个 batch 从零拟合，旧数据只用于 integrity / feature / diagnostic / regression | `[S]` |
| replay correction | 第一版不建设 | `[S]` |
| feature 输入 | 只有 `PlayingPlayerView` + legal action；模块作用域内没有 `GameState` | `[S]` |
| 禁止进入 feature | 他方真实手牌 / deal seed / deal id / batch id / episode id / terminal result / 未来信息 / 对手策略身份 / simulator-only hidden state | `[S]` |
| public pass history | 只作为行为编码，不得变成"该玩家一定没有对应牌"的硬事实 | `[S]` |
| provenance | 进 manifest / 行旁字段，**不进** feature | `[S]` |

---

## 12. checkpoint 选择与正式验证

| 项 | 建议冻结值 | 状态 |
| --- | --- | --- |
| batch 数 | 固定 3 个；`π1 → B1 → B2 → B3 → STOP AND REVIEW` | `[S]` |
| batch 规模 | 6000 train + 1500 diagnostic groups | `[D]` |
| checkpoint 命名 | `SP-B1` / `SP-B2` / `SP-B3`（**不得**叫 P1/P2，避免与 π1/π2 混淆） | `[S]` |
| 中途换 parent / 改规则 | 禁止，即使 B1 开发表现不如 π1 | `[S]` |
| dev pool | 600 个独立 initial deal group，三个 checkpoint 共用；**用毕只能做 development** | `[S]` |
| 主指标 | `d_{i,r,e} = W(candidate@role) - W(π1@role)`；`D_i` = 3 roles × 2 environments 的均值；`ΔJ = mean D_i` | `[S]` |
| 禁止 | 把新 `ΔJ` 直接加到旧的 58.9% 上 | `[S]` |
| 选择规则 | 取 dev `ΔJ` 最大的**完整 bundle**；平局取更早的 | `[S]` |
| 禁止 | 从不同 checkpoint 拼 hybrid（B1 的地主 + B2 的农民） | `[S]` |
| 停止条件 | 三个 checkpoint 的 dev `ΔJ <= 0` → STOP，不跑正式验证，不加第 4 批 | `[S]` |
| formal N | 按 dev deal-level 方差，从 2000 / 4000 / 8000 中选 | `[D]` |
| planning target | `+2pp ΔJ` | `[S]` |
| qualification | integrity 有效 且 `ΔJ >= +1pp` 且 deal-level 双侧 95% CI 下界 > 0 | `[S]` |
| 灰区 | CI 上界 < +1pp → 未达工程目标；其余 → `INCONCLUSIVE` | `[S]` |
| 开始正式验证后 | 不换 checkpoint、不改 threshold、不追加 batch、不按 interim 扩 N | `[S]` |

`[S]` 的一条附带约束：本线的 `ΔJ` 与旧的 combined win-rate **不是同一个量**，
所以它**不允许**用来替换或更新生产 `ai-v1`；那条路需要另一次独立的、单独预登记的验证。

### 12.1 本草案当前的适用性（2026-09-25）

powered diagnostic 已给出结果：prototype model 相对 π1 为
**−1.167pp，95% CI [−2.124, −0.209]**（详见 `powered-diagnostic.md`）。
本草案里 §12 的 batch 结构、§7 的 row 粒度、§9 的判据**都还没有被任何正式运行检验过**，
因为**没有启动正式 run**。

若将来要以"正确环境里重新训练"为假设再走一次，需要注意：
本草案的 §6 `[D]`（P0 的取法）、§7 的 row 粒度、§8 的 `min_data_in_leaf`
都是**在 prototype 上定的**，而 prototype 与正式 batch 的差异（廉价环境 vs π1 环境）
正是本次结果最大的混淆。换句话说：**这份草案的每一项都还需要在 π1 环境的
一次小规模训练上重新确认一次**，不能直接当作已被验证的配置。

---

## 13. 本草案明确不做的事

arbitrary-N-generation 自动 league、通用 RL 平台、PSRO、Nash solver、PPO、
神经网络、在线 actor-critic、自动超参搜索、replay correction 框架、
分布式训练集群、自动 production promotion。够支撑这三个 batch 即可。
