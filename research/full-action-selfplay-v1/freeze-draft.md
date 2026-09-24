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

`[D]` on ε：0.10 是研究提案给的候选值，也已按其实现。实测显示它带来 10.15% 的探索决策，
但**动作族覆盖极不均衡**（见 §9 的覆盖表）——`bomb`、`airplane-with-singles`、
`four-with-two-cards` 在一个 1310 决策的样本里只出现 1–2 次。
ε 提高会改善覆盖但会降低行为策略质量；本文件不建议现在改，
建议在正式 run 之前用**同一个 retired 区间**先测一次覆盖与成本的权衡，再决定。

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

`[D]` on `min_data_in_leaf = 100`：这是研究提案给的候选值。它在一个 batch 只有
~19.6 万行、每角色 ~6.5 万行、特征 403 列的情况下**可能是主要瓶颈**——100 的最小叶样本数
限制了树能把"同一状态里的少数动作"分开。

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
| 开发反事实集 | `300` 个 development root state | **`[D]` — 实测欠功率约 20 倍，见下** |
| 第三个 arm 的预登记规则 | canonical order 的**中位下标**动作（结果盲选） | `[D]` |
| continuation | 强迫动作之后，三个 seat 全部改用同一个冻结 bundle，探索全关 | `[S]` |
| 禁止 | 用 hidden state 挑"最好"的 alternative；用该诊断给正式候选补票 | `[S]` |

`[D]` on 第三个 arm：中位下标规则简单、结果盲、可复现，但它与 parent 动作常常重合
（rehearsal 实测 300 root 中只有 78 个三臂互不相同）。
另一个候选是"canonical order 里第一个不在 C3 的动作"，更能测出 C3 之外的价值，
但它依赖旧候选集，会把旧 C3 的定义带进新诊断。
**建议保持中位下标**，并把"三臂互不相同"的 root 数作为该诊断的**有效样本量**报告，
而不是把 300 当作样本量。

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

planning target 是 `+2pp`。**在一个分辨力约 ±3.5pp 的仪器上判定 +2pp 的目标，
等于把结论交给噪声。** 三条可选路线，**需要复核者选一条**：

* (a) 把 development 反事实集提到 **≥3000 roots**（成本：每次 fork 是一整局，
  以 rehearsal 池计约 6 s/300 roots，3000 roots 约 1 分钟——**这个成本是可以承受的**，
  贵的是 root 的选取与统计口径）；
* (b) 换一个**方差更低**的仪器：把"整局胜负"换成"该步之后本方的局面优势代理"
  （例如最低手数差 × 剩余牌差）。它改变了测量的语义，必须重新预登记，
  不能与 (a) 的结果混着读；
* (c) 明确接受 dev 诊断**只用于看方向**，判定完全交给 formal validation。
  这条最便宜，但它把"dev ΔJ 决定选哪个 checkpoint"这条规则变成了噪声驱动的选择，
  **与 §12 的选择规则冲突**，所以选 (c) 就必须同时改 §12。

**本文不建议 (c)。**

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

`[D]` on 研究运行时 vs 潜在生产运行时：

* **研究运行时**：单进程、`num_threads=1`、每 batch 串行采集。用 `P0/PI1` 两个 master bundle 时
  实测 **4498 ms/group**，7500 groups ≈ **9.4 h/batch**，3 个 batch ≈ **28 h**。
  这个数字来自 6 个 group 的线性外推，**不是**完整跑完的测量，正式 run 前必须用一个
  真实的中等窗口（例如 200 groups）重新确认斜率。
* **潜在生产运行时**：不在本阶段的范围内。但需要记录的是，三个 512-tree 模型合计约 0.6 MB JSON，
  而当前 shipped worker bundle 的预算约 123 KB gzip
  （`docs/specs/063-.../final-validation.md`），**相差约一个数量级**。
  任何把它搬进产品的想法都需要先解决这个预算，而这不是本线的判定条件。

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

---

## 13. 本草案明确不做的事

arbitrary-N-generation 自动 league、通用 RL 平台、PSRO、Nash solver、PPO、
神经网络、在线 actor-critic、自动超参搜索、replay correction 框架、
分布式训练集群、自动 production promotion。够支撑这三个 batch 即可。
