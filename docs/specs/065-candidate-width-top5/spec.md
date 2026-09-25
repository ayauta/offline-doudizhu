# Spec 065：候选接口宽度 top3 → top5（预登记）

状态：**协议冻结**。本文件在任何 fresh seed 被生成、任何模型被训练、任何 Stage 1 / Stage 2
对局被运行**之前**写死。此后任何修改都使本轮预登记失效。
日期：2026-09-22
分支：`research/phase2-night-lab`，起点 `84a6c67`。

**这是一条新的机制线，不是 Spec 064 的重跑或抢救。** Spec 064 的 Stage 1 因 no-peek 违规
被判 INVALID/INCOMPLETE 并已终止（[stage1-invalid.md](../064-phase2-night-policy-iteration/stage1-invalid.md)），
其 `120001–120200` 已退休、`130001–131200` 不再是本机制线的池。**Spec 064 的任何池都不得
再被触碰。**

前置：Spec 062（Gate A PASS）、Spec 063（Gate B PASS、final validation FINAL KEEP）、
Spec 064 Stage 0（机制 + 守卫）、corpus（20,000 groups）、π2 模型（sha256 `c5ee2fd3…`）。
**Spec 064 的这些产物都不被本轮使用**：它们是另一条机制线的证据。

---

## 0. Non-production 状态（先读这一条）

本 spec 描述的一切都**不是产品**，也**不改变产品**：

- **`src/` 零改动。** 这是本轮的设计约束，不是许可：top5 候选集**完全在 `benchmarks/` 里
  构造**（`rankPlayActionsWithProposal` 已经是 `src/core` 的导出）。`cfProposal`、
  `CF_CANDIDATE_LIMIT`、Worker、`decideEnhancedAi`、任何 delivery entry、任何产品设置
  **一个字节都不动**。
- **不新增依赖。** 仍是已有的 TS tree-table 求值器，没有 Python / LightGBM runtime。
- **无产品收益主张。** 判定词是 **NIGHT KEEP / REVERT**。产品化是另一条独立流程。
- **本轮正式实验次数 = 1**（§11）。不存在「再试一次」的分支。

## 1. 唯一假设

> 把 counterfactual 的**候选接口宽度**从 top3 放宽到 top5 —— 其余一切不变 —— 能否让
> 叠加在冻结 π1 之上的模型在整局中**再**提高一次高手 AI 的胜率。

**唯一变量是候选接口宽度。** 如果 top5 赢不了 top3，说明第 4、5 个候选携带的信息不足以
支付它们的代价；这条机制线就此结束。

## 2. 冻结的基线（不可变）

| 项 | 值 |
| --- | --- |
| π1 commit | `96dc640`（tag `ai-v1`，`git rev-parse ai-v1^{commit}`） |
| model artifact | `sha256 010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359` |
| schema hash | `0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0` |
| threshold | **恰为 `0.01`**，严格 `>`；由冻结产物读出 |
| selector 语义 | argmax，tie 取原始 production 候选序 |
| comparator | **精确的 frozen π1**，不是 raw master |

π1 的 model / threshold / schema **一个字节都不许动**。改动即本轮作废。

## 3. 定义：C3、C5、b0、b1

`rankPlayActionsWithProposal(context, "expert", { analyzerNodes: 220 })` 给出的
`anchored` 是**对全部合法动作**排序后的列表（`evaluateLegalActions` 排全部，`cfProposal`
之后才 `slice`）。因此对同一个 context：

```
C3 = anchored.slice(0, 3)      ← 与 ai-v1 今天用的候选集逐字节相同
C5 = anchored.slice(0, 5)
C3 = C5 的前三项                     （§6.1 断言，见 §7）
```

| 符号 | 定义 |
| --- | --- |
| `b0` | raw production master action（同一 decision seed） |
| `C5` | top5 候选，按 ranking 自身顺序 |
| `C3` | `C5` 的前三项 —— **π1 看到的全部** |
| `b1` | `b1 = selector_π1(context, b0)`，其中 π1 只在 `C3` 内选 |

**π1 的输入必须恰好是 `C3`**，否则它就不是 frozen π1 了。当 `b0 ∉ C3` 时 π1 **拒绝**并返回
`b0`（与今天同一规则），因此 π1 在**每一个 root 上**的输出与 ai-v1 逐字节相同。

## 4. Runtime challenger（§5 的判据）

```
b0  = raw production master action
C5  = cfProposal5(context)                       ← 只算一次，两层共享
i0  = index of b0 in C5                          ；-1 则整体 fallback b0
c1  = 用 frozen π1 model 对 C3 \ {b0} 打一次分    ← π1 model 一次，C3 = C5[0..2]
b1  = c1.overrode ? C3[c1.index] : b0
c2  = 用 π2 model 对 C5 \ {b1} 打一次分          ← π2 model 一次，不重算 C5
out = c2.overrode ? C5[c2.index] : b1
```

* **不重算候选集**给第二层：两层共享同一个 proposal 对象。
* 两层都是**严格** `score > 0.01`。
* 两层 tie 都取**原始 `C5` 顺序**（数组首个严格最大值）。
* `i0 < 0`、`|C5| < 2`、非农民座位、非被绑定座位、非 play context → **整体 decline**，
  返回**传入的 production 命令对象本身**（`toBe`）。
* **`b0 ∉ C3` 但 `b0 ∈ C5` 时**：π1 拒绝（`b1 = b0`），π2 仍在 `C5 \ {b0}` 上打分。
  这正是「第 4、5 个候选能不能带来东西」被检验的地方。
* **Baseline comparator 是 frozen π1。**

**组合的代价，明确写清**：相对 π1，组合多一次模型遍历，但
**π1 那一层只看 `C3`（2 个替代项），π2 那一层看 `C5`（4 个替代项）**——
所以第二层的行数是 4 而不是 2。这是本机制相对 Spec 064 额外的成本，见 §10。

### 4.1 Landlord 恒等（硬门禁）

被测 challenger 是 landlord 时两层 selector **都不得启用**：零 proposal、零模型遍历、
逐位相同 command stream。任何 divergence 判 **INVALID**。

## 5. 特征、模型与训练配置（与 v1 完全一致）

**特征不变**：仍是 **86 列**，仍是

```
x(o, a, b1) = [ context(o), phi(o,a), phi(o,b1), delta_numeric(o,a,b1) ]
```

列名、列序、categorical 编码、missing 约定（`NaN`）、schema version、**schema hash** 全部
与 v1 相同：`0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0`。
放宽候选宽度**不改变 schema**：`cand_*` 是每一行自己的候选的动作描述。

**训练配置不变**：`CF_LGBM_CONFIG_VERSION` 同一份 —— LightGBM CPU `regression` / L2、
`num_iterations 256`、`max_depth 6`、`num_leaves 31`、`learning_rate 0.05`、
`min_data_in_leaf 100`、`lambda_l1 0`、`lambda_l2 5`、`feature_fraction 1`、
`bagging_fraction 1`、`bagging_freq 0`、`max_bin 63`、`num_threads 1`、`deterministic true`、
`force_col_wise true`、**train seed `20260920` 不变**。只训练一次，训练后冻结 artifact +
checksum。禁止多 seed 挑选、禁止 calibration 后重训。

**数据侧不变**：220 节点 proposal 预算、**每 group 3 个 useful snapshot 的上限**、
keyed-priority 无放回抽样、row weights `w ∝ 1/(m_i · k_ij)` 再归一化到 mean 1、
train/calibration/held-out = **12,000 / 4,000 / 4,000**。split 仍是 group ID 的函数。

**唯一改变的是候选集宽度**，且只有它：

| | Spec 064 / ai-v1 | 本轮 |
| --- | --- | --- |
| 候选集 | `C3`（宽度 3） | **`C5`（宽度 5）** |
| π1 看到的 | `C3` | `C3`（**不变**，= `C5[0..2]`） |
| 数据行的替代项 | `C3 \ {b1}` | **`C5 \ {b1}`** |
| 数据访问 / 参考 / 续局 | π1 下 | **π1 下（不变）** |

**明确禁止**：拿任何在 top3 数据上训练出来的模型（包括 Spec 064 的 `c5ee2fd3…`）去给 top5
候选打分。宽接口上的候选必须由**同一宽度**的数据训练出来的模型来评。行列的 schema 相同
**不构成**可互换的理由。

## 6. 数据集生成

在每个被研究的农民 root 上：

1. 在 **π1** 下跑完 preregistered 的 arm-B seat variants，枚举 studied seat 遇到的
   **所有** eligible farmer roots（`C5` 在每个 root 上都要算，因为 `b1` 是实际执行的）；
2. 按 deterministic keyed priority 无放回取最小的最多 **3** 个（salt 为本轮冻结值）；
3. **强制恰好一个候选** `a ∈ C5 \ {b1}`；
4. **恰好消耗一个 studied-seat decision index**；
5. 之后所有座位恢复 **frozen π1** 续局到真正 terminal；
6. label = terminal 农民阵营结果(candidate) − terminal 农民阵营结果(`b1`)，`∈ {-1,0,+1}`。

**参考分支也必须被 fork**，并且必须**逐命令、逐 decision index** 复现原局续局。

## 7. Integrity gates（任一失败 = INVALID）

比 Spec 064 §7 多一条，其余同构。编号沿用，**第 19 条是本轮新增的核心断言**：

1. `b0 != b1` 真的会发生，且该 root 上 `b0` 仍在候选集里；
2. **参考 = `b1`**：行的第三个参数就是 `b1`；
3. 候选集 = `C5 \ {b1}`，逐元素与 `C5` 的顺序一致；
4. **严格 fallback**：分数恰等于 `0.01` 不 override；`0.01 + 1e-9` override；
5. **原始顺序 tie**：所有候选同分时取 `C5` 中最早的那个；
6. **force-once**：每个 fork 只强制一手，且恰好消耗一个 studied-seat decision index；
7. **π1 续局**：参考分支的 command 后缀与 per-seat decision-index 后缀逐位等于原局；
8. **续局不是 π2**：续局策略接口上根本不接受 π2 model；
9. **不给其它座位装 selector**：非被绑定座位、landlord 座位都返回传入对象本身；
10. **seed mapping**：`dealSeed = dealIndex`，tournament `seedBase = 0`；
11. **hidden-hand invariance**：重发隐藏手牌，feature 与 selector 命令逐位不变；
12. **determinism**：同一输入重复运行逐字节相同；
13. **landlord identity**：landlord root 上零 proposal / 零模型遍历 / 原对象返回；
14. **legality**：`C5` 中每个候选、`b0`、`b1`、challenger 输出都必须落在引擎自己的合法
    动作集合内（`generateLegalActions` 与引擎既有命令校验）；
15. **baseline identity**：baseline 臂必须逐位就是 frozen π1 —— 测试必须用 frozen
    selector **独立重新导出** `b1` 并与 baseline 臂实际命令流逐位比对；baseline 臂
    **根本不构造 π2 model**；
16. **seed overlap**：三个池两两不交，每个生成 group 的 `dealIndex` 必须严格落在自己池的
    区间内，且与 §8 全部不可用区间**交集为空**。对**全部生成物**机械断言，不是抽样；
17. **单次 proposal**：每个被研究的 root 上候选集恰好算 **1** 次（两层共享同一对象）、
    raw production master 恰好调用 **1** 次；用计数器断言 `=== 1`；
18. **candidate interface**：数据行与 v1 **逐字段同接口**（同一 `CfRow` shape、同一列序、
    `a ∈ C5 \ {b1}`、cap ≤ 5）；v1 的读取端（`cf-model.ts` / `cf-dataset.ts` 的 `cfRows`）
    **不改一行**就能消费；
19. **宽度包含（本轮核心）**：对**每一个**被研究的 context，
    **`C5.actions.slice(0, 3)` 与 `C3`（即 frozen `cfProposal` 的输出）逐元素相同**。
    这条是「唯一变量是宽度」这句话的全部依据：如果 top5 的排序与 top3 的排序不同，
    那被改变的就是排序而不是宽度，π1 也不再是 frozen π1。**必须用真实对局中的 root
    断言，不是抽样**。

**这些测试必须先在旧代码上变红**，再实现到绿。

## 8. 池与种子 ledger

| 范围 | 身份 | 本轮用途 |
| --- | --- | --- |
| **140001–160000** | **top5 dataset**（20,000 groups） | train / calibration / held-out = 12,000 / 4,000 / 4,000 |
| **160001–160200** | **Stage 1 screen**（**恰好 200 groups**） | 固定 200 组 paired 整局筛选 |
| **170001–171200** | **Stage 2 confirmation**（**恰好 1,200 groups**） | 固定 1,200 组 paired 整局判定 |
| 160201–170000、171201 起 | **未分配** | 本轮不得使用，也不得事后改判 |

**不可用**（沿用历史状态并**新增 Spec 064 的全部池**）：

* 已退休 / 已暴露：`301–700`、`20001–20400`、`30001–30400`；
* 机械 prototype：`5001–5400`；
* 已消耗：`10001–10400`；
* Gate B Discovery V4：`40001–41200`；
* Phase 2 v1 dataset：`50001–70000`；
* 旧 reserve：`70001–78000`；
* **Spec 064 的池，本机制线一律不得触碰**：`100001–120000`（π2 dataset）、
  **`120001–120200`（Stage 1，已因 no-peek 违规退休）**、`130001–131200`（Stage 2，未暴露
  但属于 064 的预登记）。

**零重叠核验**（预登记前完成，2026-09-22）：对 `.local/` 下 626 个 `.json`/`.txt`/`.log`
产物做字段级扫描（`dealIndex` / `dealStart` / `deal-<n>` / `variantId` / shard 文件名），
三个新池与两个 gap **overlap 全部 = 0**，且历史最大 deal index 为 **120000**。
方法与 Spec 064 ledger §3 相同，边界也相同（字段级正则，不是语义解析）。

三个池**互不合并、互不补位**。Stage 1 的结果**永不**与 Stage 2 合并统计。

## 9. Stage 1 —— 固定 200 组 paired 整局筛选

* 规模：**恰好 200 groups**，`160001–160200`，两臂各重跑同样 200 副，**无 peek**。
* 配置：designed / deterministic / 无 deadline；paired deal-level 方法沿用仓库既有
  `benchmarks/paired-compare.test.ts` + `clusterInterval`（seed `20260919`）。
* 臂：baseline = frozen π1；challenger = §4 的两层组合。

**继续条件（全部满足）**：

1. **combined paired point estimate > 0**（pooled 行）；
2. 所有 integrity checks 通过；
3. **结构成本门通过**（§10）。

**Stage 1 不能 KEEP。** 任何一条不满足（含恰好为 0）→ **本机制线 STOP**。

## 10. 结构成本门

| 项 | 要求 |
| --- | --- |
| raw production master | 一次（每 root） |
| 候选集 | **恰好一次**，两层共享 |
| π1 model | **一次**遍历，且只覆盖 `C3` 的替代项 |
| π2 model | **一次**遍历，覆盖 `C5` 的替代项 |
| 新依赖 | **无** |
| 产品集成 | **无**（`src/` 零改动） |

## 11. Stage 2 —— 固定 1,200 组确认（本轮唯一一次正式判定）

* 规模：**恰好 1,200 groups**，`170001–171200`。**不扩样**，没有第三次。
* 只有 Stage 1 通过才运行。配置与 Stage 1 相同。

**NIGHT KEEP 判据（全部满足）**：

1. **combined paired Δ >= +1.0pp**；
2. **paired deal-cluster 95% CI lower > 0**；
3. integrity valid；
4. landlord exact（arm A 逐副 0 差异）；
5. 结构成本门 valid。

**否则 REVERT。**

## 12. 判定后的动作

* `160001–160200` 与 `170001–171200` **用毕即 retire**；
* 不调 threshold、不重训、不扩样、不换 subgroup、不创建 v2；
* REVERT 时**不得**回到 Stage 1 重新解释。

## 13. 明确禁止的事后抢救

* 改 threshold（必须恰为 `0.01`）/ per-seat threshold / stage-specific threshold；
* 多 seed 挑模型、加树、换 objective、calibration 后重训；
* 改 schema（86 列）、**再改候选宽度**（top5 就是这个值；改 4 或 6 是新假设）、
  改 3-root cap、改 row weights；
* 去掉表现差的 stage / seat / expert-gap bucket；
* 把 Stage 1 与 Stage 2 合并统计；
* 把 Spec 064 的任何池重新解释或重新使用。

以上任何一条都是**新 hypothesis**，必须开**新池**并重新预登记。

## 14. 运行纪律、停止规则与 08:30 CST 硬停

**Night-only。** 本轮全部计算只在**本夜**进行，不跨日续跑。

**硬停：`08:30`（CST，UTC+8），2026-09-22。** 到点**无条件下停**：杀掉仍在执行的 stage，
已产出的部分一律记为 **INCOMPLETE**，被触及的池按已暴露处理并退休。

**No-peek 必须由构造保证，不靠自觉。** Spec 064 的 Stage 1 正是死在这一点上
（[stage1-invalid.md](../064-phase2-night-policy-iteration/stage1-invalid.md)）。本轮的硬性要求：

1. **任何 stage 的中间结果不得以可读形式落盘**：`runPairTournament` 一律
   `quiet: true`，结果只在两臂都结束后一次性写出；
2. **不得存在部分结果文件**：不写 per-deal 进度、不写可被中途打开的累积胜负；
3. **存活检查只允许看 PID 与行数**，不得 grep 会带出结果内容的模式；
4. 违反以上任何一条 = **INVALID**，与 Spec 064 同等处置。

**逐级停止规则**（任一触发即停；不得换 threshold / 换模型 / 换 subgroup 抢救）：

| 触发 | 动作 |
| --- | --- |
| 任一 integrity gate（§7）失败 | 允许修实现，但该池已消费的部分不得回收；本轮不得用同一池出判定 |
| landlord identity（§7 第 13 条）出现任何 divergence | INVALID，先修实现，再谈结果 |
| Stage 1 继续条件任一不满足（**含点估计恰好为 0**） | **本机制线 STOP**，不进 Stage 2 |
| Stage 2 判据任一不满足 | **REVERT**；不扩样、不回头解释 Stage 1 |
| 结构成本门（§10）不通过 | Stage 1 → STOP，Stage 2 → REVERT |
| `08:30` CST | 无条件下停 |

**无生产提升。** 任何结果（**包括 NIGHT KEEP**）都**不**触发 `src/` 或 Worker 的行为变更。

## 15. 产出

* 本 spec（预登记 commit，**在实现之前**）
* `docs/research/ai-used-seed-ledger.md`（更新：新池分配 + 零重叠核验）
* `benchmarks/cf-top5.ts`（top5 候选集、宽度包含断言、两层 runtime 组合）
* `tests/core/cf-top5.test.ts`（§7 的公开契约守卫，进 `pnpm check`）
* `benchmarks/cf-top5-corpus.test.ts`（新 universe 的 generate / merge / audit driver）
* `scripts/cf-top5-corpus.mjs`（分片 + resume launcher）
* `benchmarks/cf-top5-stage1.test.ts`（Stage 1 / Stage 2 共用 runner，`quiet: true`）
* Stage 0 证据：`docs/specs/065-candidate-width-top5/stage0.md`
* 后续（若时间允许）：corpus、模型 artifact、Stage 1 / Stage 2 结果记录
