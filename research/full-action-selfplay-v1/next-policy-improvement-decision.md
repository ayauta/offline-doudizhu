# Next policy-improvement mechanism — decision memo

状态：**设计 memo，不执行**。不训练任何模型，不分配任何 pool。
本文只回答 Decision Node 2：

> 在不使用神经网络和外部斗地主 AI 的条件下，怎样更可靠地从 incumbent 产生
> "对历史策略集合整体更强"的下一代，而不是只学会克制最新对手？

---

## 12. 证据分级

### A. 实验已经支持（可直接引用）

| # | 结论 | 证据 |
| --- | --- | --- |
| A1 | π1 farmer 在冻结 benchmark 上有大幅独立增益 | farmer +10.583pp、combined +5.292pp，`10001–10400`，n=400/arm（Spec 063 final-validation） |
| A2 | 当前 fixed-C3 / current-schema / current-selector 配方**没有**产生可进入正式评测的下一代 | 两次 preregistered attempt 都 `calibration-no-go`；`eligible 3/6000` 与 `4/12000` |
| A3 | full-action MC-Q 能产生**有用的 landlord policy** | TARGET landlord 在 fresh 2400 groups 上 +9.875pp [+7.736, +12.014] |
| A4 | 同一个 TARGET landlord 在另一种 farmer 环境**明显退步** | −2.875pp [−5.074, −0.676]，同一次验证 |
| A5 | **训练对手分布会改变学到的 landlord policy** | 等规模（7500 vs 7500 组、rows 246,811 vs 252,135、ε 实测都是 10.09%）下，TARGET−CHEAP 在两个独立评测上都为正：single-step +0.964pp、takeover +2.000pp，CI 都不含 0 |
| A6 | 现有 farmer full-takeover candidate **不值得**直接替换 π1 | rehearsal takeover：farmer-next −8.417pp、farmer-previous −5.333pp，CI 都不含 0 |
| A7 | 训练对手**覆盖**与泛化直接相关 | TARGET 的 landlord rows 中 `DEFAULT_AI_STRATEGY` 占 **0%**，`P0` 占 50.03%；CHEAP 的 rows 中 `default` 占 49.61% |
| A8 | 单步诊断与整局接管**会分道扬镳** | prototype：single-step T−π1 = +2.182pp（CI 不含 0），takeover T−π1 = −0.167pp（CI 含 0） |
| A9 | 平均指标会掩盖单环境退步 | TARGET takeover 总体 ≈ π1（−0.167pp），但 landlord +13.250pp 与 farmer −8.417pp 相互抵消 |
| A10 | game-level 与 row-level 有效权重**基本一致** | 四个 pair 的 drift ≤ 0.54pp |

### B. 合理但未验证的机制假设（**不得写成结论**）

| # | 假设 | 状态 |
| --- | --- | --- |
| B1 | TARGET 的 default regression **主要由缺少 DEFAULT coverage 导致** | 最强工作假设，**不是单变量因果证明**；representation / objective 效应未被因果排除。正确表述：`existing evidence is most consistent with missing DEFAULT coverage, but representation/objective effects are not causally excluded.` |
| B2 | farmer degradation 来自 teammate credit assignment | 与 A6 一致，但从未做过消融 |
| B3 | full-action 的增益主要来自 C3/C5 之外的动作 | **未测量**。eval A 的子样本显示模型在 root 上约 40% 选到旧 C3 之外，但**没有**做过"把 C3 之外动作屏蔽掉再测"的实验。禁止说 C3/C5 外动作就是地主提升来源 |
| B4 | LightGBM capacity 已成为主要 ceiling | 无证据；见 §15 |
| B5 | opponent-style inference 是必要条件 | 无证据；且 §12 的运行时约束禁止用隐藏 identity 做这件事 |
| B6 | TARGET 学会了某种具体的"让牌 exploit" / π1 farmer 的某种行为被识别 | **完全未做 causal attribution**，禁止编造 |

### C. 新研究方向

只能从 A ∪ B 推导，且**每个方向必须指向一个已经观测到的失败模式**。
本文只给三条（§14），不给大清单。

---

## 13. 当前瓶颈排序

按证据强弱排序，不平铺。**#1 是最可能阻碍持续进步的。**

| 排名 | 类别 | 证据 | 判断 |
| --- | --- | --- | --- |
| **#1** | **policy-update / generalization mechanism** | A4+A5+A7+A8+A9 | **当前最可能阻碍持续进步的**。同一个算法、同样的规模，只换训练对手就得到 +9.875pp 与 −2.875pp 两种结果；这不是拟合问题（train L2 0.076–0.119 远低于常数基线 0.198–0.250），而是**跨对手分布的泛化**问题，而当前配方里**没有任何机制**去处理它。 |
| #2 | **evaluation methodology** | 本项目自己的记录 | 三轮里连续发现：300-root 诊断欠功率 ~20 倍；aggregate 把 3600 cells 当 iid；eval-B 的 candidate arm 有 47.6% 的局环境不纯；single-step 与 takeover 分道扬镳。**每一次都足以单独得出错误结论。** 这是"测量"而非"算法"的瓶颈，但它污染的是判断本身。 |
| #3 | **action-value / label quality** | A3+A8+A9 | MC terminal target 的 paired sd ≈ 53–55pp；要分辨 +2pp 需要 ~5,400 groups，分辨 −1pp NI 需要 ~23,400。**从未测试过任何非 MC 的目标**（bootstrap、search-assisted、lower-variance label）。目标本身是"在当前 continuation 下"的条件期望，这正是 A4 的机制来源之一。 |
| #4 | **exploration / state coverage** | A7 + coverage 表 | 已有直接证据：**对手策略覆盖**在 0% 时导致该环境退步。ε=0.10 实测 10.09%，稀有动作族（`triple` ~90 次/batch）偏薄，但**没有证据**表明动作族覆盖是当前瓶颈。 |
| #5 | **feature / information representation** | state-only 消融 | 弱证据。动作列带来 1.8–8.6% 的 dev MSE 下降、离散度比值 0.117–0.201 而 state-only 恰为 0.000。**没有任何实验隔离过表征**是否不足。 |
| #6 | **LightGBM model capacity** | §15 | 弱证据，且方向相反：三个 role 的 train L2 都远低于常数基线，没有欠拟合迹象。 |
| #7 | **research infrastructure / organization** | 本项目记录 | pool 纪律、ledger、seal、确定性 runner **都工作正常**；这几轮真正的失误是操作性的（grep 过滤器把自己要找的行滤掉、mixture 权重写错、聊天消息里手打 hash）。属于流程卫生，不是科学瓶颈。 |
| #8 | **raw compute** | 实测 | **不是瓶颈**：46.7 groups/min @8 workers；7500-group batch ≈ 2.7 h。 |

**#1 的表述**（避免过度声称）：
> 现有证据指向"**跨对手分布的策略泛化**"是首要瓶颈，而不是回归器容量、表征或算力；
> 但 representation / objective 的因果贡献**尚未被排除**。

---

## 14. 最多三条下一代路线

### Route 1 — Conservative incumbent improvement

**不能原封不动重复失败的 π1→π2 fixed-C3 配方。** 与旧配方的四处实质差异：

1. **动作比较用 full-action 而不是 top3 override。**
   旧配方只在 production 的 top-3 里选，A2 证明它两次都到不了 calibration。
   新配方对**全部合法动作**打分（枚举器已由 brute-force oracle 验证完备，
   延迟 p95 0.3 ms），因此候选不再被 incumbent 的短名单限制。

2. **保留 incumbent safety 的方式是"限制偏离量"，不是"限制候选集"。**
   只有当候选动作相对 incumbent 动作的**分数优势超过一个冻结门槛**时才接管；
   门槛在**独立的环境上**标定，不是在同一批数据上调。

3. **避免一次性改变整个 state distribution。**
   候选**不产生轨迹**：轨迹始终由 incumbent 产生，候选只在决策点替换动作。
   这正是 A8 里被验证会"稀释"的结构，所以——

4. **必须用 takeover 评测，不能用 single-step 评测。**
   这是本项目自己的教训：prototype 的 single-step T−π1 = +2.182pp，
   而 takeover = −0.167pp。**single-step 是乐观的，不能作为晋级 gate。**

**什么证据会判死这条路线**：

* 有效接管率（超过门槛的决策占比）低于一个预先登记的 floor；
* **多环境 takeover** 里任一环境 CI 上界 < 0；
* 或：即便门槛放到最大，takeover 增益仍不显著。

---

### Route 2 — Historical-policy population improvement

**不能简单定义成 "always train against latest opponent"。**

* **opponent population 如何冻结**：每个成员以**内容身份**冻结
  （model SHA-256 + tier + overlay 状态 + 规则身份），像 TARGET/CHEAP 的 manifest 那样。
  池子在同一轮内不可变，成员变动即新的一轮。
* **candidate 优化什么**：**不是**池上的加权平均，而是**约束下的最坏情形**：
  要求 candidate 在每个环境上分别通过预登记判据（本轮已经用过的
  `env A: ≥ +2pp 且 CI 下界 > 0` 与 `env B: NI margin −1pp` 就是这种形式）。
* **如何防止"赢最新版却输旧版"**：把**旧成员留在池里**并且**每一轮都重测**；
  晋级只看跨环境约束，不看平均值。
* **promotion 是否应使用 multi-environment constraints**：**是**。
  A9 就是反例：总体 ≈ 0 的候选可以同时包含 +13.25pp 与 −8.42pp。
* **为什么 opponent pool 不能修复错误的 action values**：
  把池子做大改变的是**目标的分布**，不是**估计量在每个环境上的偏差**。
  MC 回归拟合的是 `E[G | h,a; 本批的 continuation 分布]`；
  如果那个分布错了（例如某个对手 0% 覆盖，A7），池子并不会告诉你"在缺的那个对手下这个 a 值多少"——
  它只会把缺失的那一项以 0 权重平均掉。**覆盖问题只能靠覆盖解决，不能靠平均解决。**
* **怎样避免循环克制被误认为进步**：本项目**已经观测到一个非传递对**
  ——TARGET 在 π1 farmers 上更强（+9.667 vs +7.000），CHEAP 在 default farmers 上更强
  （+2.667 vs −2.083），直接 paired 在 env B 上 CHEAP−TARGET = **+4.750pp（CI 不含 0）**。
  两个候选各赢一个环境。因此每一轮晋级都必须包含**显式的非传递检测**：
  在池上两两配对，若出现环则判该轮 **NO-GO**，而不是挑一个方向宣布进步。

---

### Route 3 — 一个真正值得考虑的非神经网络替代机制

选：**search-assisted target construction（搜索构造更好的 label），运行时仍用可蒸馏的小模型。**

**它具体解决我们已经观测到的哪个失败模式？**
解决 **#3 与 A4 的共同根源**：现有 label 是"在当前 continuation 下采样一次的终局胜负"，
它 ① 方差极大（paired sd ≈ 53–55pp），② **条件于当前对手分布**——
这正是 A4 里同一个网络在两种 farmer 环境下差 12.8pp 的机制来源。

做法：把 label 从"采样一条 continuation"换成"**对对手手牌做有界 determinization 聚合**"，
并让 continuation 本身也由 incumbent 策略给出（而不是由当前对手分布给出）。
仓库里**已经有** `master-policy.samplePossibleWorld`（按 `remainingCardCounts` 发牌、
把已亮底牌钉给地主）与 `HandTurnSolver`，所以这不是从零开始。

必须回答的问题：

| 问题 | 回答 |
| --- | --- |
| 不完全信息 | 用 determinization（采样一致的隐藏手牌）近似；这不是新机制，是本仓库既有的做法。**不用**神经网络也不需要外部 AI。 |
| farmer cooperation | 两个 farmer **共享一个阵营价值**，搜索里不能把它们当对手。这是一个硬设计约束：determinization 必须把"队友的手牌"和"对手的手牌"分开采样，且 farmer 的候选评估要按**阵营**聚合。 |
| offline compute | 有界：determinizations × 深度 × 每决策 legal actions。用 8-worker 实测吞吐（46.7 groups/min）可外推；**必须先测，不允许先假设**。 |
| mobile / Web inference | **运行时不变**：搜索只用于**离线构造 target**，产物蒸馏回同一个 403 列 schema 的 LightGBM；推理路径、延迟、体积口径都不变。 |
| 能否 distill 回小模型 | 能——这正是选择它的理由。搜索是 teacher，不是 runtime。 |
| 工程复杂度 | 中等：复用 `samplePossibleWorld` / 枚举器 / 现有 value model；新代码主要是 target 构造与一致性 guard。 |

**为什么不是别的**：CFR-inspired 方法在不完全信息下理论上更正确，
但它的产物是**策略**而不是可蒸馏的**值函数**，与本项目的 mobile/Web 约束冲突；
"更强的搜索直接当 policy" 会撞上延迟与体积预算（landlord 单独已 440 KB gzip，
预算是 120.7 KB）。

---

## 15. LightGBM 专门结论

**是否已有证据应该弃用 LightGBM？——没有。默认继续把它当作 cheap deployable function approximator。**

逐项区分：

| 维度 | 本项目证据 | 判断 |
| --- | --- | --- |
| **regressor capacity** | 三个 role 的 train L2 = 0.076 / 0.105 / 0.108，常数基线 0.198 / 0.214 / 0.212；state-only 消融更差 | **无欠拟合迹象**，capacity 不是 ceiling 的证据 |
| **feature representation** | 动作列带来 1.8–8.6% dev MSE 下降；离散度比值 0.117–0.201，state-only 恰 0.000 | 表征**有用**，是否**不足**从未被隔离测量 |
| **label semantics** | 单次采样的终局胜负，paired sd ≈ 53–55pp，且条件于当前对手分布 | **最可疑的一项**，但这是**目标**的问题，不是回归器的问题 |
| **exploration** | 实测 10.09%，稀有动作族偏薄 | 未证明是瓶颈 |
| **training distribution** | A7：某对手 0% 覆盖 | **已证明会伤害泛化**；同样不是回归器的问题 |
| **policy-update mechanism** | A2、A4、A5 | **#1 瓶颈** |

两条禁止的推论：

* **不能**因为某个 LightGBM candidate 失败就推出 `tree model 不行`——
  失败的那些是**目标/分布/机制**的问题；
* **不能**因为两个模型成功就推出 `LightGBM 足够达到最终目标`——
  它只在"地主 + 特定对手环境"上被验证过。

**如果将来要换模型**，必须先指出新模型具体解决上面哪一项**已经观察到**的问题。
在 Route 1/2/3 里，Route 3 改变的是 **label semantics**，而它的产物仍然可以蒸馏回 LightGBM
——**所以换模型不是这三条路线的前置条件**。

---

## 16. 为什么 alternating self-play 不会自然单调变强

用本项目自己的结果解释：

```
普通地主 → 强 farmer(π1) → 强 landlord(TARGET) → 更强 farmer → ...
```

**为什么它不是自动的**：

1. **"best response to latest opponent" ≠ "stable strength across a population"。**
   本项目有一个**实测的非传递对**：TARGET 与 CHEAP 互为胜负
   （TARGET 在 π1 farmers 上更强，CHEAP 在 default farmers 上更强，
   env B 上 CHEAP−TARGET = +4.750pp，CI 不含 0）。
   非传递意味着"打赢当前对手"**不蕴含**"比上一代强"——
   两个策略可以各自只在对方弱的那个环境里领先。

2. **目标函数把它固化了。** MC 回归拟合的是
   `E[G | h,a; 本批的 continuation 分布]`。换对手 = 换目标函数。
   A5 实测：同样规模、只换环境，TARGET−CHEAP 在**两个独立评测**上都为正。
   也就是说**每一代都在解一道不同的题**，而交替循环把这道题不断换掉。

3. **A4 是这条循环的具体产物**：TARGET 是在 π1 环境里练出来的，
   它对 default 环境**没有任何训练信号**（0% 覆盖），于是退步 −2.875pp。

**要把 alternating training 变成真正的 policy improvement process，至少需要**：

* (a) 一个**冻结且可识别**的对手 population（内容身份，不是"最新版"）；
* (b) 一个**约束型**晋级规则（每环境分别判定），不是池上平均值；
* (c) 一个**不塌缩到池分布**的目标估计——否则 candidate 的值只在那一个混合下成立；
* (d) **显式的非传递检测**（池上两两配对，出现环即 NO-GO）；
* (e) 每一步之后**重测旧环境**，且旧环境不能从池里移除。

**不写** `self-play naturally converges`，也**不**把 AlphaZero 类系统简化成
"不停和自己打就会越来越强"——那类系统依赖的是搜索 + 值函数的联合迭代与
一个明确的、固定的对局规则，而不是"换一个对手就算进步"。

---

## 17. 只规划两个未来关键决策节点

### NEXT NODE A

```
question      产品地主是否已经有一个值得进入 integration / deployment retention 的候选？
single design CHEAP 的 joint dual-environment confirmation（本轮正在跑）。
              仅在 JOINT RESEARCH PASS 时才继续。
artifact      integration prototype（**不发布**）：landlord 接管的真实
              Worker / deadline / runtime retention 测量 + asset 口径复核。
go/no-go      GO 需要同时满足：① 本轮 JOINT RESEARCH PASS；
              ② integration prototype 在真实预算内的 retention 达标
              （当前口径：landlord 单独 440.0 KB gzip，合计 548.5 KB，
              预算 120.7 KB —— 现状是 deployment not yet qualified）。
maximum budget  一次 integration prototype + 一次 retention 测量。不训练模型。
stop condition  任一条件不满足即停；**不得**自动 production promote。
```

### NEXT NODE B

```
question      下一种 policy-improvement mechanism 是否能比 current recipe
              更稳定地产生跨历史对手增益？
single design 在 **一个** 冻结的多环境池上比较 Route 1 与 Route 3 的 target 语义：
              Route 1 用保守接管门槛（full-action 打分 + 冻结 margin），
              Route 3 用 search-assisted target 构造 + 蒸馏回同一 403 列 schema。
              **两条路线共用同一批 fresh groups、同一个 baseline、
              同一套 multi-environment 判据**，只改变 target/acceptance 语义。
artifact      一份 preregistration + 两个 candidate manifest + 一次 joint 评测。
go/no-go      必须**同时**通过 env A 正向判据与 env B non-inferiority；
              任一不通过即该路线 NO-GO。**不做 mixed average 晋级。**
maximum budget  一个 fresh pool（规模由 preregistration 的 power 计算决定，
              参考本轮算术：envA +2pp ≈ 5,400 groups；envB −1pp NI ≈ 23,400 groups
              —— 若两者都要，由较严的一侧决定，这一点必须在 preregistration 里写清楚）。
stop condition  不通过即停，不追加 N，不换 candidate 重试同一池。
```

---

## 18. 产品与研究严格分离

* **若 CHEAP JOINT PASS**：只允许建议
  `integration prototype` / `actual worker + mobile deadline retention` /
  `asset-size & compression research` / `broader product benchmark`。
  **不得**直接 production promote。
* **若 CHEAP FAIL 或 INCONCLUSIVE**：**不得**自动训练到成功；
  转 Node 2 的 mechanism decision。
* **无论哪种结果，production π1 不受影响。**

## 19. 本轮明确不做

new training before the CHEAP result、farmer retraining、third landlord training、
hyperparameter sweep、LightGBM replacement、feature changes、epsilon changes、
history-length changes、reward shaping、C3/C5 attribution、model compression、
production modification。**Node 2 只是 memo。**

## 20. 追加：CHEAP 确认结果对本 memo 的影响

本 memo 起草于 CHEAP 揭盲**之前**，正文里的 CHEAP 数字全部来自开发池。
揭盲后（见 [`landlord-robust-confirmation-report.md`](landlord-robust-confirmation-report.md)）
需要补两处，不动上面任何已写结论：

* **新增证据 A11**：CHEAP 是本线**第一个在 fresh pool 上独立确认的地主候选**
  ——env A `+9.400pp [+8.038, +10.762]`、env B `+3.450pp [+2.059, +4.841]`，
  6000 groups，0 exclusion，`JOINT RESEARCH PASS`。
  这坐实了 A3 那一类结果**可以被独立复现**，不再只是单个候选的孤例。
* **§14 Route 2 里的非传递对**：换用确认后的数字表述更稳——
  TARGET 与 CHEAP 在 env B 上的差距**在开发池上**是 CHEAP−TARGET `+4.750pp`（CI 不含 0），
  而 CHEAP 现在有了自己的 fresh 确认；TARGET 的 env A 优势（+9.875pp）来自**另一个池**，
  **两者不可相减**。非传递的结论不变，但不能用两个池的数字直接对比来"证明"它。

§13 的瓶颈排序、§15 的 LightGBM 结论、§16 的机制分析**都不受影响**：
确认的是"CHEAP 这个候选成立"，而 A4/A5/A7 指出的是"**换对手分布就换一个解**"，
后者是机制问题，一个候选通过确认并不回答它。
