# Spec 064 corpus + π2 model 记录（Stage 1 就绪）

协议见 [spec.md](spec.md)，Stage 0 见 [stage0.md](stage0.md)。状态：**corpus 已生成、
π2 模型已训练并冻结、Stage 1 runner 已就绪**。**Stage 1 与 Stage 2 尚未运行**，
`120001–120200` 与 `130001–131200` 两个池**未暴露**。
日期：2026-09-21（夜）
分支：`research/phase2-night-lab`

---

## 1. 执行摘要

| 步骤 | 结果 |
| --- | --- |
| corpus driver + §7 全套断言 | ✅ commit `cdfae29` / `87b24b1`，27 条 guard |
| 生成 universe `100001–120000` | ✅ 20,000 groups / 15 shards / 152 min |
| 逐行机械断言（非抽样） | ✅ **`{"accepted": 20000}`**，零拒绝 |
| merge + manifest | ✅ 577 s，checksum `5a730edd…` |
| rows 导出（v1 读取端，未改一行） | ✅ train 62,986 / calibration 21,058 |
| 训练（冻结配置，未改一字） | ✅ model sha256 `c5ee2fd3…` |
| 确定性 | ✅ 独立目录重训 **逐字节相同** |
| π2 artifact（benchmark-only） | ✅ `.local/cf-pi-rows/pi2-model.json`，**`src/` 零改动** |
| Stage 1 runner | ✅ commit `4ff3aed`+，真实 artifact 已冒烟 |

---

## 2. Corpus

pipeline commit **`87b24b1abb94f6cd234e3af7c23dda3f4f3c3dda`**（`AI_CF_PI_POLICY_COMMIT`，
写进每个 shard 的 `versions` 并在 merge 时逐字段核对）。

| 项 | 值 |
| --- | --- |
| universe | `100001–120000`（20,000 groups） |
| split | train / calibration / held-out = **12,000 / 4,000 / 4,000** |
| split salt | `phase2-pi1-split` |
| snapshot salt | `phase2-pi1-snapshot` |
| dataset version | `3` |
| per-group cap | `3` |
| seedBase | `0`（`assertPiSeedBase` 在发牌前断言） |
| baseline | frozen π1，model sha256 `010a8a4a…`，threshold **`0.01`** |
| schema hash | `0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0`（**与 v1 逐字节相同**） |
| merged corpus checksum | `5a730edd1e461c0c72cd9bd6c00b4c7d3619c45617ed1308956230d3034cfd9e` |

| split | groups | snapshots | rows | max/group |
| --- | ---: | ---: | ---: | ---: |
| train | 12,000 | 36,000 | 62,986 | 3 |
| calibration | 4,000 | 12,000 | 21,058 | 3 |
| heldout（封存） | 4,000 | 11,999 | 21,062 | 3 |

结构审计（修正后，见 §5）：**三个 split 全部 `splitMismatch 0  schemaMismatch 0
labelIntegrity 0  productionIndex 0`**。零空 group。

文件校验和：

```
train.json          d0cb648646a7a25463fdc5d8d08f00fbbc24be0762bb61a865596841b59c4a00
calibration.json    79211ad47a02d0ad64cfff3638aeccdfdd2f3cee08eb6a1ed036433c64742bd9
heldout.sealed.json 948323c75c28129db7da919e84a2209e71904e5266860c79622ea610f92c5123
```

### 2.1 计时

| 阶段 | 墙钟 | 说明 |
| --- | --- | --- |
| generate | **152 min**（03:04→05:36） | 15 shard 并行，16 核满载 |
| 每 shard | 8,740–9,010 s / 1,333 groups | **6.56 s/group/shard** |
| merge（含全量复检） | 577 s | 读 179 MiB shards，重跑整套 §7 断言，写 187 MiB |
| rows | 3.2 s | |
| train | 6 s | |

**π1 的代价**：相比 v1 的 π0 capture，本轮的 capture 在 studied seat 上每个决策都要跑一次
selector，实测 6.56 s/group（v1 pilot 的 π0 路径更快）。

---

## 3. π1 真的改变了的东西（非空转证据）

| 量 | 值 |
| --- | --- |
| snapshot 总数 | 59,999 |
| `b0 != b1` 的 root | **18,008 = 30.0%** |
| farmer roots（3 个 variant 合计） | ~640,000 |
| useful farmer roots | ~400,000 |

**30% 的 root 上 frozen π1 真的把 production 的动作换掉了**。这不是「机制可能存在」的
推断，是生成物里逐行数出来的：`meta.rawProductionIndex !== meta.productionIndex` 的行数。
v1 的 Gate A 里这个数**恒为 0**（参考就是 `a0` 本身），所以本轮的数据集与 v1 的**不是同一
个问题**——这正是 §1 假设要求的东西。

### 3.1 标签分布与 v1 的差异（符合机制预期，非异常）

| | v1（参考 = `a0`） | π2（参考 = `b1`） |
| --- | ---: | ---: |
| train rows | 63,199 | 62,986 |
| `+1` | 3,333 | **2,386** |
| `0` | 54,087 | 54,419 |
| `-1` | 5,779 | **6,181** |
| nonzero rate | 14.42% | 13.60% |

`+1` 变少、`-1` 变多是**应该的**：参考从 production 的动作换成了 π1 更强的一手，
「候选比参考好」自然更难发生、「比参考差」更容易发生。若两者分布**相同**，反而说明参考
根本没换。

---

## 4. π2 模型

| 项 | 值 |
| --- | --- |
| model sha256 | **`c5ee2fd328b4da63d5b52f6bd6793f7749245a4142a58fa40bf64c7a3183253a`** |
| artifact | `.local/cf-pi-rows/pi2-model.json`（483,573 B），**benchmark-only** |
| trees / nodes / features | 256 / 12,856 / 86 |
| objective | `regression`（L2） |
| LightGBM | `4.6.0` |
| schema hash | `0ec9d20f…`（与 v1 相同） |
| train / calibration rows | 62,986 / 21,058 |
| weight mean | `1.000000` |

**训练配置与 v1 逐字相同**（spec §4）：`num_iterations 256`、`max_depth 6`、`num_leaves 31`、
`learning_rate 0.05`、`min_data_in_leaf 100`、`lambda_l1 0`、`lambda_l2 5`、
`feature_fraction 1`、`bagging_fraction 1`、`bagging_freq 0`、`max_bin 63`、`num_threads 1`、
`deterministic true`、`force_col_wise true`、**train seed `20260920`**。

**没有做的事**（都是 §13 禁止的事后抢救）：没有超参搜索、没有多 seed 挑模型、没有
calibration 后重训、没有改 threshold。π2 的 threshold **恰好是 `0.01`**，从冻结产物 import。

### 4.1 确定性

同一个 `cf-train.py` 在**另一个目录**上对同一份 rows 独立重跑：

```
c5ee2fd328b4da63d5b52f6bd6793f7749245a4142a58fa40bf64c7a3183253a  .local/cf-pi-rows/model.txt
c5ee2fd328b4da63d5b52f6bd6793f7749245a4142a58fa40bf64c7a3183253a  /tmp/pi2-refit/model.txt
```

**逐字节相同**。artifact 里 `modelSha256` 字段 == `model.txt` 的实际 sha256 == 上表的值。

### 4.2 训练路径本身也是被验证过的

跑正式 corpus 之前，先用**已退休的** v1 rows 做了一次同样的训练彩排：
`cf-train.py` 在 5 秒内**逐字节复现**了 v1 冻结产物 `010a8a4a…`。也就是说，
「训练路径能复现冻结 artifact」这件事是在依赖它之前就证明过的，不是事后相信的。

---

## 5. 本轮发现并修掉的三个缺陷

### 5.1 artifact 摘要断言写错了对象（`87b24b1`）

第一次启动 15 个 shard 时**全部立刻失败**：`The shipped model artifact does not hash to
CF_MODEL_SHA256`。原因是我写的断言错了：`CF_MODEL_SHA256` 标识的是 **LightGBM booster
文本**（`cf-export-model.py` 把 `sha256(model.txt)` 抄进生成的模块），不是 JSON wrapper。
拿 wrapper 的摘要去比 booster 的摘要，是一条**只可能失败**的检查。

**它在发牌之前就失败**，所以本轮 15 个 shard 一个 seed 都没消耗。

### 5.2 `cfAuditStructure` 的分母（本次 commit）

merge 报告 `splitMismatch 12000 / 4000 / 4000` —— **每一个 group 都是 mismatch**。
排查结果：`cfAuditStructure` 调的是 **v1 的** `cfSplitOf`，它只在 `50001–70000` 上有定义，
对 `100001+` 一律返回 `undefined`，于是 `undefined !== "train"` 对每个 group 都成立。

**这不是数据缺陷，是调用方的问题**，而它长得像数据缺陷——正是最危险的一种假警报。
凭证：

```
v1  cfSplitOf(50011)    = heldout
v1  cfSplitOf(100011)   = undefined      <-- v1 resolver 不认识这个 universe
pi  cfPiSplitOf(100011) = train
pi  cfPiSplitOf(120001) = undefined      <-- Stage 1 池本来就不该有 split
```

修法：`cfAuditStructure` 增加一个可选的 `splitOf` 参数（默认仍是 v1 的 `cfSplitOf`，所以
v1 三个调用点行为不变），π2 driver 传 `cfPiSplitOf`。修正后审计**四项全 0**。

数据的正确性从一开始就不是靠它保证的：driver 自己的 `cfPiAssertGroup`（**用本轮的
resolver**）在 generate 和 merge 两次跑完全部 20,000 个 group，全部接受。

### 5.3 我给 5.2 写的第一条 guard 是空的

第一版 guard 长这样：

```ts
expect(cfAuditStructure([group], split, cfSplitOf).splitMismatches).toBe(0);
```

它**显式传了 `cfSplitOf`，而且用的是退休 deal `50_011`** —— 两个 resolver 在这个 index 上
**结果相同**，所以那个参数从没被真正考验过。变异实验证实了这一点：把
`cfAuditStructure` 改回永远用 `cfSplitOf`（即**忽略传入的 resolver**），
这条 guard **照样通过（27 passed）**。

这与 Stage 0 里被修掉的 §7.8 空转守卫是**同一类错误**：断言里没有任何一个符号来自被改的
那条路径。修好之后的 guard 用一个**只有本轮 resolver 才能回答的 index**（`100_011`，
纯对象字面量，不发牌）：

* 传 `cfPiSplitOf` → `splitMismatches 0`；
* 用默认（v1）resolver → `splitMismatches 1` —— 把那条假警报本身钉住；
* 变异「忽略传入的 resolver」→ **这条 guard 红（1 failed）**。

---

## 6. 零暴露

`120001–120200`（Stage 1）与 `130001–131200`（Stage 2）**至今暴露计数 = 0**：

* 生成只碰 `100001–120000`；driver 的 `cfPiGroupSpecFor` 对池外 index **直接抛错**，
  不返回 null、不静默跳过；
* Stage 1 runner 的所有冒烟都在**退休区间** `50_001–50_080` 上跑，并且用
  `AI_CF_PI_P2_MODEL` 指向 artifact —— **没有一次以 `120001+` 为 `dealStart`**；
* Stage 1 / Stage 2 **尚未运行**。

`100001–120000` 本身**已经暴露**（已生成），按 §12 它的用途就是本轮的 train / calibration /
held-out，用毕即随本轮退休。

---

## 7. 限制

1. **本轮尚未做出任何判定。** Stage 1 只能 screen、不能 KEEP（§9）；判定词属于 Stage 2。
   corpus 与模型的存在**不构成任何强度证据**。
2. **held-out 仍然封存。** 生成、merge、审计都只报结构，`cfAuditStructure` 的返回记录里
   **根本没有 label 字段**。
3. **merge 的 `splitMismatch` 曾整轮误报**（§5.2）。已修，但这条记录保留在案：一个只
   在**换 universe 时**才出现的假警报，在 v1 上永远是 0，所以它不可能被 v1 的任何回归发现。
4. **`cfPiAssertGroup` 里仍有 3 条冗余检查**（universe 边界、`rawProductionIndex` 范围、
   `groupId` 一致性）：变异实验显示删掉它们**不会**让任何 guard 变红，因为同一违例被另一条
   检查先抓到。行为仍然被守住，但这三行本身未被单独覆盖——记录在案而不是假装每条都吃劲。
5. corpus 与模型是**本夜产物**；按 §14 本轮不跨日续跑。

---

## 8. Stage 1 就绪状态与时间预算

### 8.1 就绪清单

| 项 | 状态 |
| --- | --- |
| corpus + manifest + checksum | ✅ |
| π2 artifact（benchmark-only，`src/` 零改动） | ✅ |
| Stage 1 runner（`benchmarks/cf-pi-stage1.test.ts`） | ✅ commit `4ff3aed` 起 |
| 真实 artifact 冒烟（退休种子） | ✅ arm-A 不变式 6 games / **0 divergence** |
| 结构成本门 | ✅ `proposalCalls 102 == decisions 192 − landlordDecisions 90`；`baselineRows == challengerRows == 115` |
| 非空转 | ✅ 同一冒烟里两臂的 `perDealB` 不同（`[2,2,2]` vs `[2,2,1]`） |

### 8.2 实测速率与预算

退休种子上实测（机器空闲，无竞争）：**3.06 s/deal/arm**（baseline 60.79 s / 20 deals，
challenger 61.81 s / 20 deals）。

| 阶段 | 规模 | 预估墙钟（两臂并行） |
| --- | --- | --- |
| arm-A 不变式 | 8 deals | < 1 min |
| Stage 1 | 200 deals | **~11 min** |
| Stage 2 | 1,200 deals | **~61 min** |

若在 **06:00** 开始 Stage 1：Stage 1 约 06:12 结束，Stage 2 约 07:15 结束 —— 都在
`08:30` 硬停之前，且留有余量。**但 Stage 2 是唯一一次正式判定（§11），一旦开始就不能
半途而废**：`08:30` 到点时仍在跑的部分记 INCOMPLETE，并按 §14 **该池按已暴露处理并退休**。

Stage 2 还有一条可选的加速路径：像 Gate B 那样按 deal 区间分片（每片一个 dump，再合并），
可把 61 min 压到 ~10 min；代价是要写一个 paired dump 的合并步骤（Gate B 有
`cf-gate-b-merge.mjs` 可照抄）。

### 8.3 顺带修掉的一处：Stage 1 的第一次断言是错的

Stage 1 runner 第一次冒烟时，结构成本门断言 `proposalCalls === decisions`，
在 119 vs 60 上失败。**失败的是断言，不是实现**：119 个决策里有 59 个在 landlord root 上，
它们按 §5.1 在计算任何东西**之前**就 decline 了，所以不产生 proposal。正确的等式是
`proposalCalls === decisions - landlordDecisions`，现在断言的是它，外加
`landlordDecisions > 0`（让 landlord 路径被**测到**而不是被假定）与
`baselineRows === challengerRows`。

---

## 9. 复跑方式

```bash
source scripts/activate-toolchain.sh
export AI_CF_PI_POLICY_COMMIT=87b24b1abb94f6cd234e3af7c23dda3f4f3c3dda
AI_CF_PI_JOBS=15 node scripts/cf-pi-corpus.mjs generate   # 152 min；已完成，shard 可 resume
node scripts/cf-pi-corpus.mjs merge                       # 577 s
node scripts/cf-pi-corpus.mjs audit                       # 4 s
node scripts/cf-pi-corpus.mjs rows                        # 3 s
PYTHONPATH=.local/pylibs python3 scripts/cf-train.py .local/cf-pi-rows
PYTHONPATH=.local/pylibs python3 scripts/cf-export-model.py \
  .local/cf-pi-rows/model.txt .local/cf-pi-rows/pi2-model.json     # 2 参数 = 不写 src/

# Stage 1（未运行）
AI_CF_PI_S1_INVARIANT=1 AI_BENCH_DEAL_START=120001 AI_BENCH_DEALS=8 AI_BENCH_DESIGNED=1 \
  AI_BENCH_SEED=0 node node_modules/vitest/vitest.mjs run --config vitest.benchmark.config.ts \
  benchmarks/cf-pi-stage1.test.ts
```
