# Spec 065 Stage 0 记录（机制 + 守卫 + driver）

协议见 [spec.md](spec.md)。状态：**Stage 0 完成**，corpus 生成已启动。
日期：2026-09-22
分支：`research/phase2-night-lab`，起点 `84a6c67`，Stage 0 commit `01ab1eb`

本轮是**新的机制族**，不是 Spec 064 的重跑或抢救：冠军仍是冻结 π1（`ai-v1`），
**唯一变量是 counterfactual 候选接口宽度 top3 → top5**。Spec 064 的任何池**未被触碰**。

---

## 1. 本轮赖以成立的那一条事实

「唯一变量是宽度」必须是对**代码**的陈述，不是对意图的陈述。它落在一条可以验证的性质上：

> `cfProposal` 调 `rankPlayActionsWithProposal`，后者对**全部合法动作**排序；
> `slice(0, CF_CANDIDATE_LIMIT)` 发生在排序**之后**。而每动作的搜索预算是
> `floor(analyzerNodes / context.legalActions.length)`
> （`src/core/ai/scoring-policy.ts:228`）——按**合法动作数**分，**不按 limit 分**。

因此 `anchored.slice(0,5)` 是 `anchored.slice(0,3)` 的**扩展**而不是替换，
`C3` 恰好是 `C5` 的前三项。

**实测（不是推理）**：在 **117 个真实退休 root** 上

```
C5 > C3 的 root: 64 / 117 = 55%
|C5| === 5 的 root: 54 / 117 = 46%
宽度分布: {2: 33, 3: 20, 4: 10, 5: 54}
宽度包含失败: 0
```

**0 失败**意味着 π1 在每一个 root 上仍是它自己；**55%** 意味着放宽是真的放宽，
不是把同一个集合换个写法。

## 2. 设计里被明确写死的两个后果

### 2.1 π1 看不到第 4、5 个候选

π1 的输入**恰好是 `C3`**。当 `b0` 落在 index 3 或 4 时，π1 **看不到它**，
于是按 ai-v1 一直以来的规则拒绝（`b1 = b0`）；而 challenger 那一层仍然拿到
`C5 \ {b0}`。这正是第 4、5 个候选被检验的地方，也是 comparator 保持精确的原因。
**让 π1 偷看 C5 会改变 π1，而 π1 是比较基准。**

### 2.2 两层的宽度不再相等

Spec 064 的成本恒等式 `baselineRows === challengerRows` 在本轮**不再成立**：
π1 那层打 `|C3| − 1` 个替代项，π2 那层打 `|C5| − 1` 个。退休种子冒烟实测：

```
decisions 198  landlordDecisions 90  proposals 108   (108 = 198 − 90 ✓ §7.17)
baselineRows 128   challengerRows 217                (217 ≥ 128 ✓ §10)
```

守卫相应改成 `challengerRows >= baselineRows`，**而不是**假装两者仍然相等。

---

## 3. 交付物

| 文件 | 作用 |
| --- | --- |
| `benchmarks/cf-top5.ts` | top5 proposal、宽度包含断言、两层 runtime 组合、top5 capture |
| `benchmarks/cf-top5-corpus.ts` | 池 / split / 本轮的 §7 expectation |
| `benchmarks/cf-top5-corpus.test.ts` | generate / merge / audit driver |
| `scripts/cf-top5-corpus.mjs` | 分片 + resume launcher |
| `benchmarks/cf-top5-stage1.test.ts` | Stage 1 / Stage 2 共用 runner（`quiet: true`） |
| `tests/core/cf-top5.test.ts` | 19 条公开契约守卫（进 `pnpm check`） |

### 3.1 `src/` 零改动

top5 候选集**完全在 `benchmarks/` 里构造**，用的是 `src/core` 已经导出的
`rankPlayActionsWithProposal`。产品的 `cfProposal`、`CF_CANDIDATE_LIMIT`、Worker、
任何 delivery entry **一个字节未动**。

### 3.2 冻结的校验器**一字未改**

初版为了复用，把 Spec 064 的校验器 `benchmarks/cf-pi-corpus.ts` 加了三个带默认值的字段
（`proposalFor` / `candidateLimit` / `datasetVersion`）。默认值等于原值，29 条 064 守卫也确实
全绿——但它仍然**改动了那个产出已记录结果的校验器**，而那是不该付出的代价。

现在它已**逐字节恢复到记录时的版本**（`git diff --cached ca6c5df` 为空），
Spec 065 改用**专用副本** `benchmarks/cf-top5-battery.ts`：逻辑逐条对应，只有 universe /
split resolver / 候选宽度 / dataset version / proposal 函数不同。副本由
`tests/core/cf-top5-battery.test.ts` 的 14 条守卫证明（含真实 capture 的正例、以及 12 条
「破坏一条规则就必须被拒」的变异）。

**为什么副本在这里安全、在 `cf-dataset.ts` 却不安全**：校验器对数据**没有副作用**，
副本不会让两份数据分叉；而生成器会。所以 `cf-dataset.ts` 的 capture 只增加了**一个带默认值
的 `proposalFor`**（默认 = shipped `cfProposal`），而不是复制一份生成器——两份生成同一个
corpus 的代码会漂移，而 corpus 是后面每一个数字的地基。

| 文件 | 处理 |
| --- | --- |
| `benchmarks/cf-pi-corpus.ts`（064 校验器） | **逐字节恢复，未改动** |
| `benchmarks/cf-dataset.ts`（生成器） | 仅加 `CfCaptureOptions.proposalFor`，默认 = shipped |
| `benchmarks/cf-top5-battery.ts`（065 校验器） | **专用副本**，14 条守卫 |

## 4. 守卫与变异

19 条守卫，覆盖 §7 的门禁与 §7.19 的宽度包含。三条关键变异，**全部 RED**：

| 变异 | 破坏的东西 | 结果 |
| --- | --- | --- |
| M1 `slice(1, limit+1)` | 宽度包含（§7.19） | **RED（2 failed）** |
| M2 让 π1 那层直接看 `C5` | π1 恒等（§7.15） | **RED（2 failed）** |
| M3 让 challenger 那层只看 `C3` | 放宽本身（§4） | **RED（2 failed）** |

**非空转**：一条守卫要求「challenger 能选中 top3 从未提供的候选」。
这条**常量模型做不到**——所有候选同分，冻结的 tie-break 取最早的那个，永远落在 index 0 或 1。
所以它用一个按 `cand_cardCount` 打分的模型，让 argmax 能落到第 4、5 个候选上。
若这条守不住，本轮就是在测量一个不可能发生的选择。

**no-peek 守卫扩到两个 runner**（`cf-pi-stage1.test.ts` 与 `cf-top5-stage1.test.ts`）：
断言源码里不出现 `quiet: false`、出现 `quiet: true`、且仍然调用 `runPairTournament`。

---

## 5. 两个被**绊线**而不是被运气抓到的缺陷

两者都发生在任何长跑之前，且都是**发牌之前**失败——没有消耗任何 seed。

1. **driver 的第一次冒烟**：校验器仍在校验 Spec 064 的 dataset version（3），
   而 top5 capture 写的是 4 → `§7.18 … carries dataset version 4`。
   这直接促成了 §3.2 的重构：**没有**去改冻结校验器的签名，而是给它做了一份 top5 专用副本。
   **没有任何 shard 被写出**，因为断言在生成循环里、写文件之前。

2. **runner 的第一次冒烟**：`AI_CF_PI_S1_ARM` 这个环境变量名没有被改名，
   于是传 `AI_CF_T5_S1_ARM=challenger` 时**两臂都跑成了 baseline**，而日志里
   两次都印 `[spec065 baseline]`，看起来完全正常。
   这是本轮最危险的一类 bug：**它不会失败，它会把 challenger 悄悄换成 baseline，
   然后给出一个看起来很干净的结论。**

两次都是「先冒烟再长跑」抓到的。这条纪律在本轮又一次付了钱。

---

## 6. 成本与投影（可复现）

测速不是一次性探针。harness 本身已提交：

```bash
source scripts/activate-toolchain.sh
AI_CF_T5_RATE_N=30 node node_modules/vitest/vitest.mjs run \
  --config vitest.benchmark.config.ts benchmarks/cf-top5-rate.test.ts
```

它在**同一批退休 deal**（`50_001` 起，默认 30 组）上跑 **top3 与 top5 两次 capture**，
所以「放宽的代价」是在相同工作量上量出来的比值，而不是与另一夜记住的数字相比。
结果写入 `AI_CF_T5_RATE_OUT`（默认 `/tmp/cf-top5-rate.json`）。

**样本 30 组 × 2 次独立运行**（单进程，无竞争）：

| | top3 | top5 | 比值 |
| --- | ---: | ---: | ---: |
| run 1 | 3.251 s/group | **3.783 s/group** | 1.164× |
| run 2 | 3.281 s/group | **3.913 s/group** | 1.193× |
| 结构性计数 | 90 snapshots / 245 forks | 90 snapshots / 363 forks | 两次运行**完全相同** |
| meanCandidates | 2.72 | **4.03** | |

时间抖动 0.9% / 3.4%；结构性计数**逐位相同**，所以计时差异来自机器而不是来自数据。

**20,000 groups 投影**（15 分片并行）：串行 1,261 / 1,304 min → ÷15 = 84 / 87 min →
按 Spec 064 实测的 **2.2× 竞争系数** → **185 / 191 min**。

**只贵 16–19%**：一次 capture 的主要成本是**访问阶段**（在 π1 下把整局打完），
而访问阶段不受宽度影响；宽度只增加 fork 的数量（245 → 363）。

### 6.1 时间预算（以真实系统时间计）

| 项 | 值 |
| --- | --- |
| 测速完成 | 2026-09-22 **01:2x CST** |
| 语料生成（15 分片） | **185–191 min** |
| 生成完成（预估） | **约 04:40 CST** |
| merge + audit + rows + train + export | 约 25 min |
| Stage 1（200 组） | 约 15 min |
| Stage 2（1,200 组） | 约 90 min |
| 全部完成（预估） | **约 06:50 CST** |
| **硬停 08:30 CST 余量** | **约 100 min** |

## 7. 零暴露

| 范围 | 状态 |
| --- | --- |
| `140001–160000`（top5 dataset） | **0 → 1**，生成已启动（`00:58:34`） |
| `160001–160200`（Stage 1） | **0**，未暴露 |
| `170001–171200`（Stage 2） | **0**，未暴露 |
| Spec 064 全部池 | **未触碰**（`100001–120000`、`120001–120200`、`130001–131200`） |

预登记前的零重叠核验：626 个 `.local/` 产物、五个区间（三池 + 两 gap）**overlap 全为 0**，
历史最大 deal index = 120000。

---

## 8. 限制

1. **Stage 0 没有产生任何科学结论。** 它只证明机制可跑、守卫能红、宽度包含成立。
   判定词属于 Stage 2（§11）。
2. **§7.19 是在 Stage 0 的 117 个 root 上验证的**，不是在全量 corpus 上。全量 corpus
   的每一个 root 由 driver 的全套 §7 判据覆盖（含 §7.3 的候选集重导），但那是
   **同一次** `cfProposal5` 调用，不是独立的第二次验证。
3. **`cf-top5-stage1.test.ts` 由 `cf-pi-stage1.test.ts` 改写而来**，两者的差异是
   组合函数、环境变量名与 universe 常量；改写的风险由冒烟测试与
   「两臂都真的跑起来」这件事承担（§5.2 正是这条抓到的）。
4. 本轮的 corpus 与模型是**本夜产物**；按 §14 不跨日续跑。
