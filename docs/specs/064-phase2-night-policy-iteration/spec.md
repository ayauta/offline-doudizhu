# Spec 064：Phase 2 Night Lab — π1→π2 policy iteration（预登记）

状态：**协议冻结**。本文件在任何 fresh seed 被生成、任何 π2 模型被训练、任何 Stage 1 /
Stage 2 对局被运行**之前**写死。此后任何修改都使本轮预登记失效。
日期：2026-09-21
分支：`research/phase2-night-lab`，起点 `96dc640`（tag `ai-v1`）。

**修订 2026-09-21，仍在任何 seed 暴露之前**（三个新池暴露计数 = 0、无 π2 模型、无对局）：
补齐 §7 的 legality / baseline identity / seed overlap / 单次 proposal / candidate
interface 五条门禁，并写入 §14 的运行纪律与 **08:30 CST 硬停**。补写与冻结属于**同一次**
预登记动作：本文件在补写之后**仍然没有见过任何本轮数据**。
前置：Spec 062（Gate A **PASS**）、Spec 063（Gate B-A/B-S/B-S2 **PASS**、final
validation **FINAL KEEP**）。结果记录见
[062/experiment.md](../062-counterfactual-policy-improvement/experiment.md)、
[063/experiment.md](../063-counterfactual-farmer-selector-gate-b/experiment.md)、
[063/final-validation.md](../063-counterfactual-farmer-selector-gate-b/final-validation.md)。

---

## 0. Night Lab 非生产状态（先读这一条）

本 spec 描述的一切都**不是产品**，也**不改变产品**：

- **Stage 0 不得有任何 `src/` 行为改动**。允许的 `src/` 变更只有一种：把既有 selector
  的评分核心抽成一个**被 `cfSelectFarmerAction` 委托**的纯函数，且等价测试证明 v1 行为
  逐命令不变。不得把 π2 接进 Worker、`decideEnhancedAi`、任何 delivery entry 或产品设置。
- **不新增依赖**。π2 是离线训练的 LightGBM artifact，运行时仍是已有的 TS tree-table
  求值器（`src/core/ai/cf-model.ts`），没有 Python / SciPy / LightGBM runtime。
- **无产品收益主张**。Night Lab 的判定词是 **NIGHT KEEP / REVERT**，不是产品 KEEP。
  即使 Stage 2 判 NIGHT KEEP，也只说明「这条机制线在预登记判据下成立」，产品化是**另一条
  独立流程**，需要自己的预登记、自己的池、自己的产品门禁。
- **本轮正式实验次数 = 1**（§11）。不存在「再试一次」的分支。

## 1. 唯一假设

> 在 π1（= ai-v1，冻结的 counterfactual farmer selector）**已经**改变了棋力的前提下，
> 用 π1 自己的访问分布、以 π1 的实际执行为参考、以 π1 续局重新生成一份反事实数据集，
> 训练出的 π2 模型**叠加在 π1 之上**，能否在整局中**再**提高一次高手 AI 的胜率。

这是一次**纯 policy iteration**：π0→π1 只改数据访问 / 参考 / 续局，不改任何超参、schema
或候选接口（§4）。Gate A 与 Gate B 已经各自预登记并消耗完自己的池；本轮开新池。

**不得**把 Gate A 的 `+2.0083%`、Gate B 的 `+10.917%`、final validation 的 `+5.292%`
外推成本轮的预期值。它们只是历史记录。

## 2. 冻结的 π1 基线（不可变）

| 项 | 值 |
| --- | --- |
| π1 commit | `96dc640`（tag `ai-v1`，`git rev-parse ai-v1^{commit}`） |
| model artifact | `sha256 010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359` |
| schema hash | `0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0` |
| threshold | **恰为 `0.01`**，严格 `>`；由冻结产物读出，不得在代码里重打 |
| selector 语义 | `cfChooseOverride` / `cfSelectFarmerAction`：argmax，tie 取原始 production 候选序 |

π1 在本轮中的角色有两个，都必须同时成立：

1. **基线臂**：Stage 1 / Stage 2 的 paired 对照是 **frozen π1**，不是 raw production master。
2. **数据生成策略**：数据集的访问、参考与续局全部在 π1 下进行。

π1 的 model / threshold / schema **一个字节都不许动**。改动即本轮作废。

## 3. 定义：b0 / C / b1

在一个**被研究的农民 root**（studied farmer root）上：

| 符号 | 定义 |
| --- | --- |
| `b0` | **raw production master action**：该次决策 master 在同一个 decision seed 下给出的原始动作 |
| `C` | **原始 production top3**：按 production 自己的顺序排列的有序候选集，宽度上限 3，与 v1 完全同一规则 |
| `b1` | **冻结 π1 在该 root 上实际执行的动作**：`b1 = selector_π1(context, b0)`，同一个 decision seed |

`b1` 必属于 `C`（selector 只在 `C` 内选，拒绝时返回 `b0`；`b0 ∈ C` 由 eligibility 保证）。
当 `b0 ∉ C` 时该 root **不 eligible**，与 v1 同一规则，直接丢弃。

**参考固定为 `b1`。** 数据集的候选集是 `C \ {b1}`；并且**只要 `b0 != b1`，`b0` 必须仍在
候选集里**（因为 `b0 ∈ C` 且 `b0 != b1`，这条由构造自动成立，但它是**被断言**的不变量，
见 §7）。当 `b0 == b1` 时参考就是 `b0`，与 v1 在这一点上重合。

## 4. 特征、模型与训练配置（与 v1 完全一致）

**特征不变**：仍然是 **86 列**，仍是

```
x(o, a, b1) = [ context(o), phi(o,a), phi(o,b1), delta_numeric(o,a,b1) ]
```

即 Option C 的同一 schema，只是第三个参数从 `a0` 变成 `b1`。列名、列序、categorical 编码、
missing 约定（`NaN`）、schema version、**schema hash** 全部与 v1 相同：
`0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0`。

**训练配置不变**：`CF_LGBM_CONFIG_VERSION` 同一份 —— LightGBM CPU `regression` / L2、
`num_iterations 256`、`max_depth 6`、`num_leaves 31`、`learning_rate 0.05`、
`min_data_in_leaf 100`、`lambda_l1 0`、`lambda_l2 5`、`feature_fraction 1`、
`bagging_fraction 1`、`bagging_freq 0`、`max_bin 63`、`num_threads 1`、`deterministic true`、
`force_col_wise true`、**train seed `20260920` 不变**。只训练一次，训练后冻结 artifact +
checksum。禁止多 seed 挑选、禁止 calibration 后重训。

**数据侧不变**：220 节点 proposal 预算（`ENHANCED_AI_SEARCH.rootAnalyzerNodes`）、
candidate 上限 3、**每 group 3 个 useful snapshot 的上限**、sampling salt 机制、
row weights `w ∝ 1/(m_i · k_ij)` 再归一化到 mean 1、train/calibration/held-out =
**12,000 / 4,000 / 4,000**。split 仍是 group ID 的函数，group 内不跨 split。

**唯一改变的是三件事**，且只有这三件：

| | π0（Spec 062 / Gate A） | π1（本轮） |
| --- | --- | --- |
| **数据访问** | studied seat 走 raw master | studied seat 走 **π1**（master + selector）；其余座位仍是 v1 预登记的档位 |
| **参考** | `a0` = raw production action | **`b1`** = π1 实际执行的动作 |
| **续局** | 两边恢复 π0 | 两边恢复 **π1，永不 π2** |

## 5. Runtime challenger 定义（later tests 的判据）

```
b0  = raw production master action
C   = cfProposal(context)                        ← 只算一次
i0  = index of b0 in C                           ；-1 则整体 fallback b0
c1  = 用 frozen π1 model 对 C \ {b0} 打一次分    ← π1 model 一次
b1  = c1.overrode ? C[c1.index] : b0
i1  = index of b1 in C
c2  = 用 π2 model 对 C \ {b1} 打一次分           ← π2 model 一次，不重算 C
out = c2.overrode ? C[c2.index] : b1
```

* **不重算 C** 给第二层：两层共享同一个 `CfProposal` 对象。
* 两层都是**严格** `score > 0.01`。
* 两层 tie 都取**原始 `C` 顺序**（即数组首个严格最大值）。
* `i0 < 0`、`|C| < 2`、非农民座位、非被绑定座位、非 play context → **整体 decline**，
  返回**传入的 production 命令对象本身**（`toBe`，不是等值重建）。
* **Baseline comparator 是 frozen π1**，不是 raw master。

**组合的代价，明确写清**：相对 π1，组合**多一次模型遍历**（π1 一次 + π2 一次），
但**不多一次 proposal**（`cfProposal` 仍然只有一次）。这是本机制的成本上界，
见 §10 结构成本门。

### 5.1 Landlord 恒等（硬门禁）

被测 challenger 是 landlord 时两层 selector **都不得启用**：零 proposal、零模型遍历、
逐位相同 command stream。任何 divergence 判 **INVALID**，先修实现再谈结果。

## 6. 数据集生成（Stage 0 只做基础设施，不在本任务内生成）

在每个被研究的农民 root 上：

1. 在 **π1** 下跑完 preregistered 的 arm-B seat variants，枚举 studied seat 遇到的
   **所有** eligible farmer roots（`C` 在每个 root 上都要算，因为 `b1` 是实际执行的）；
2. 按 deterministic keyed priority 无放回取最小的最多 **3** 个（salt 与算法同 v1，
   **值改为本轮的冻结 salt**）；
3. **强制恰好一个候选** `a ∈ C \ {b1}`；
4. **恰好消耗一个 studied-seat decision index**（这一手确实发生过，只是输出被替换）；
5. 之后**所有座位**（含 studied seat）恢复 **frozen π1** 续局到真正 terminal，**永不 π2**；
6. label = terminal 农民阵营结果(candidate) − terminal 农民阵营结果(`b1`)，`∈ {-1,0,+1}`。

**参考分支也必须被 fork**，并且必须**逐命令、逐 decision index** 复现原局续局
（winner 相等**不足以**证明这件事，见 §7）。未终局判 `CfInvalidError`，不得记 0。

`b1` 的种子依赖：`b0` 由 master 在 `decisionSeed = (gameSeed + 1 + seatIndex + index*7919) >>> 0`
下给出，`b1` 是同一 context、同一 `b0` 上的确定性函数，因此**同一 decision seed**。

## 7. Integrity gates（任一失败 = INVALID）

`tests/` 中的公开契约测试必须证明（**红→绿**）：

1. **`b0 != b1` 真的会发生**，且该 root 上 `b0` 仍在候选集里（否则 selector 没有 override
   过任何东西，整套机制是空转）；
2. **参考 = `b1`**：行的第三个参数就是 `b1`，不是 `b0`，也不是其它候选；
3. **候选集 = `C \ {b1}`**，逐元素与原始 `C` 的顺序一致（tie-break 依赖这个顺序）；
4. **严格 fallback**：分数恰等于 `0.01` 不 override；`0.01 + 1e-9` override；
5. **原始顺序 tie**：所有候选同分时取 `C` 中最早的那个；
6. **force-once**：每个 fork 只强制一手，且恰好消耗一个 studied-seat decision index；
7. **π1 续局**：参考分支的 command 后缀与 **per-seat decision-index 后缀**逐位等于原局
   ——winner 相等不算证明；
8. **续局不是 π2**：续局策略接口上根本不接受 π2 model；
9. **不给其它座位装 selector**：非被绑定座位、landlord 座位都返回传入对象本身；
10. **seed mapping**：`dealSeed = dealIndex`，tournament `seedBase = 0`，
    corpus 与 tournament 对同一 (dealIndex, strongSeat, landlord) 得到同一 `gameSeed`；
11. **hidden-hand invariance**：重发隐藏手牌，feature 与 selector 命令逐位不变；
12. **determinism**：同一输入重复运行逐字节相同；
13. **landlord identity**：landlord root 上零 proposal / 零模型遍历 / 原对象返回；
14. **legality**：`C` 中每个候选、`b0`、`b1`、以及 challenger 的输出，都必须落在引擎自己
    的合法动作集合内（`src/core/rules` 的 `generateLegalActions` 与引擎既有命令校验，不另
    造一套）；数据集每一行的 `a` 也必须是该 context 下的合法命令。出现任何非法候选 =
    **INVALID**，**不是**「跳过这一行」；
15. **baseline identity**：baseline 臂必须**逐位**就是 frozen π1 —— 同一 model
    sha、同一 `0.01`、同一 tie 规则。测试必须用 frozen selector **独立重新导出** `b1`，
    并与 baseline 臂实际产生的命令流逐位比对；且 baseline 臂**根本不构造 π2 model**
    （零 π2 遍历、零 π2 artifact 读取）。任何一处不等 = INVALID；
16. **seed overlap**：三个池两两不交，每个生成 group 的 `dealIndex` 必须严格落在**自己**
    池的区间内，且与 §8 / ledger §1 列出的全部不可用区间**交集为空**。这条要对**全部**生成
    物机械断言，不是抽样。发现重叠 = 本轮 INVALID，且**不得重抽**——看到重叠之后再抽新
    数字，本身就是 selection；
17. **单次 proposal**：每个被研究的 root 上 `cfProposal` 恰好调用 **1** 次（两层共享同一
    对象）、raw production master 恰好调用 **1** 次；用计数器断言 `=== 1`。这是 §10 成本门
    的运行时前提，也是「组合只多一次模型遍历、不多一次 proposal」这句话的唯一证据；
18. **candidate interface 不变**：π2 数据行与 v1 **逐字段同接口**（同一 `CfRow` shape、
    同一列序、`a ∈ C \ {b1}`、cap ≤ 3、`b0 ∈ C` 的 eligibility 规则）。v1 的读取端
    （`cf-model.ts` / `cf-dataset.ts`）**不改一行**就能消费 π2 行；接口一旦漂移 = INVALID
    （那等于换 schema，而 schema 是冻结项）。

**这些测试必须先在旧代码上变红**，再实现到绿。守卫之所以是守卫，是因为它曾经红过。

## 8. 池与种子 ledger

完整 provenance 见 [docs/research/ai-used-seed-ledger.md](../../research/ai-used-seed-ledger.md)。
本 spec 只固定**本轮分配**：

| 范围 | 身份 | 本轮用途 |
| --- | --- | --- |
| **100001–120000** | **π1→π2 dataset**（20,000 groups） | train / calibration / held-out = 12,000 / 4,000 / 4,000 |
| **120001–120200** | **Stage 1 screen**（**恰好 200 groups**） | 固定 200 组 paired 整局筛选 |
| **130001–131200** | **Stage 2 confirmation**（**恰好 1,200 groups**） | 固定 1,200 组 paired 整局判定 |
| 120201–130000、131201 起 | **未分配** | 本轮不得使用，也不得事后改判 |

**不可用**（沿用历史状态，本轮不重新解释）：

* 已退休 / 已暴露：`301–700`、`20001–20400`、`30001–30400`；
* 机械 prototype：`5001–5400`；
* 已消耗：`10001–10400`（Phase 2 v1 final validation，用毕永久 retire）；
* Gate B Discovery V4：`40001–41200`（已 retire）；
* Phase 2 v1 dataset：`50001–70000`（永久属于 Phase 2 v1）；
* 旧 reserve：`70001–78000`（Spec 062 的 test-only reserve，**保持不可用**）。

三个池**互不合并、互不补位**。Stage 1 的结果**永不**与 Stage 2 合并统计。

## 9. Stage 1 —— 固定 200 组 paired 整局筛选

* 规模：**恰好 200 groups**，`120001–120200`，两臂各重跑同样 200 副，**无 peek**。
* 配置：designed / deterministic / 无 deadline；paired deal-level 方法沿用仓库既有
  `benchmarks/paired-compare.test.ts` + `clusterInterval`（seed `20260919`）。
* 臂：baseline = frozen π1；challenger = π1∘π2（§5）。arm A 必须恒等。

**继续条件（全部满足）**：

1. **combined paired point estimate > 0**；
2. 所有 integrity checks 通过；
3. **结构成本门通过**（§10）。

**Stage 1 不能 KEEP。** 它只是 screen。任何一条不满足（含恰好为 0）→ **本机制线 STOP**，
不得进入 Stage 2，不得换 threshold / 换模型 / 换 subgroup 抢救。

## 10. 结构成本门（Stage 1 与 Stage 2 都必须过）

| 项 | 要求 |
| --- | --- |
| raw production master | **一次**（每 root） |
| `cfProposal` | **恰好一次**，两层共享 |
| π1 model | **一次**遍历 |
| π2 model | **一次**遍历 |
| 新依赖 | **无** |
| 产品集成 | Stage 0 **无**；后续若产品化，是另一条独立流程 |

后续 artifact / runtime 检查必须**把新增的这个模型算进去**，并覆盖**完整 proposal 成本**
（不能只报第二层的增量推理时间）。

## 11. Stage 2 —— 固定 1,200 组确认（本轮唯一一次正式判定）

* 规模：**恰好 1,200 groups**，`130001–131200`。**不扩样**，没有第三次。
* 只有 Stage 1 通过才运行。
* 配置与 Stage 1 相同（designed / deterministic / 无 deadline，同 paired 方法）。

**NIGHT KEEP 判据（全部满足）**：

1. **combined paired Δ >= +1.0pp**；
2. **paired deal-cluster 95% CI lower > 0**；
3. integrity valid；
4. landlord exact（arm A 逐副 0 差异）；
5. 结构成本门 valid。

**否则 REVERT。**

### 11.1 历史规划估计（近似，可转移性未知）

按历史 paired 数据规划的样本量估计：`sd ≈ 0.1151`、`SE ≈ 0.332pp`、
95% halfwidth ≈ `0.65pp`（1,200 组）。

**明确标注**：这是**近似规划值**，来自历史运行，**不是**对本轮功效的预测；
本轮的效应量、方差与分布都可能不同，**只有真正跑完的 1,200 组决定结果**。
不得用这个数字论证「区间一定够窄」或「一定能检出」。

## 12. 判定后的动作

无论 NIGHT KEEP 还是 REVERT：

* `130001–131200` 与 `120001–120200` **用毕即 retire**，不得再决定任何 KEEP / REVERT；
* 不调 threshold、不重训、不扩样、不换 subgroup、不创建 v2；
* REVERT 时**不得**回到 Stage 1 的 200 组上重新解释。

## 13. 明确禁止的事后抢救

* 改 π2 threshold（必须恰为 `0.01`）/ per-seat threshold / stage-specific threshold；
* 用 p1 的 calibration 或 held-out 重新拟合、多 seed 挑模型、加树、换 objective；
* 改 schema（86 列）、改候选接口、放宽 top3、改 3-root cap、改 row weights；
* 去掉表现差的 stage / seat / expert-gap bucket；
* 把 Stage 1 与 Stage 2 合并统计；
* 在 Stage 2 未达标时回头用 Stage 1 的正点估计作为结论。

以上任何一条都是**新 hypothesis**，必须开**新池**并重新预登记。

## 14. 运行纪律、停止规则与 08:30 CST 硬停

**Night-only。** 本轮全部计算（dataset 生成、π2 训练、Stage 1、Stage 2）只在**本夜**进行，
不跨日续跑、不「明天接着跑」：跨夜续跑会把同一个池拆成两段被分别解释的结果。

**硬停：`08:30`（CST，UTC+8）。** 到点**无条件下停**：杀掉仍在执行的 stage，已产出的部分
结果一律记为 **INCOMPLETE**。

* INCOMPLETE **不得**被解释成 KEEP、REVERT、POSITIVE 或 NEGATIVE，也不得据此调参数后重跑；
* 被 INCOMPLETE 触及的池**按已暴露处理并退休**（即使只跑了一部分，这些对局的结果已经被
  看到），**不得**在下一夜用同一池续做；要继续这条机制线，必须**开新池 + 重新预登记**；
* 硬停优先于本节其它任何规则，也优先于 Stage 1 / Stage 2 的完成度。

**逐级停止规则**（任一触发即停；不得换 threshold / 换模型 / 换 subgroup 抢救，见 §13）：

| 触发 | 动作 |
| --- | --- |
| 任一 integrity gate（§7）失败 | 允许修实现，但**该池已消费的部分不得回收**；本轮不得用同一池出判定 |
| landlord identity（§7 第 13 条）出现任何 divergence | INVALID，先修实现，再谈结果 |
| Stage 1 继续条件任一不满足（**含点估计恰好为 0**） | **本机制线 STOP**，不进 Stage 2 |
| Stage 2 判据任一不满足 | **REVERT**；不扩样、不回头解释 Stage 1 |
| 结构成本门（§10）不通过 | 按对应 stage 的停止规则处理（Stage 1 → STOP，Stage 2 → REVERT） |
| `08:30` CST | 无条件下停，见上 |

**无 peek。** Stage 1 的两臂在跑完固定 200 组之前不得被查看中间结果；不存在「看几副再决定
要不要跑完」这一步。

**无生产提升。** Night Lab 的任何结果（**包括 NIGHT KEEP**）都**不**触发 `src/` 或 Worker
的行为变更；产品化是另一条独立流程（§0）。

## 15. 产出

* 本 spec（预登记 commit，**在实现之前**）
* [docs/research/ai-used-seed-ledger.md](../../research/ai-used-seed-ledger.md)（种子池 ledger）
* `benchmarks/cf-policy-iteration.ts`（π1→π2 机制、runtime 组合、π1 group capture、池/切分配置）
* `benchmarks/cf-pi-corpus.test.ts`（新 universe 的 generate / merge / audit driver）
* `tests/core/cf-policy-iteration.test.ts`（§7 的公开契约守卫，进 `pnpm check`）
* Stage 0 证据：`docs/specs/064-phase2-night-policy-iteration/stage0.md`（红测试证据 + 绿门禁）
* 后续（本任务不做）：corpus、π2 model artifact、Stage 1 / Stage 2 结果记录
