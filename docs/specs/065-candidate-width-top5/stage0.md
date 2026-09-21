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

### 3.2 三个共享文件只增加了**带默认值**的参数

| 文件 | 新增 | 默认值 |
| --- | --- | --- |
| `benchmarks/cf-dataset.ts` | `CfCaptureOptions.proposalFor` | shipped `cfProposal` |
| `benchmarks/cf-pi-corpus.ts` | `CfPiGroupExpectation.proposalFor` / `.candidateLimit` / `.datasetVersion` | shipped / `CF_CANDIDATE_LIMIT` / `CF_PI_DATASET_VERSION` |

**所有默认值都是原值**，所以 Spec 064 的 29 条守卫**一行未改、全部通过**。
共享 `cf-pi-corpus.ts` 的 §7 全套判据（而不是为 065 重写一份）是刻意的：
那套判据已经在 20,000 个 group 上验证过，重写它等于把已经证明的安全网换成一个未证明的。

---

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

1. **driver 的第一次冒烟**：battery 仍在校验 Spec 064 的 dataset version（3），
   而 top5 capture 写的是 4 → `§7.18 … carries dataset version 4`。
   修法：把 `datasetVersion` 加进 expectation。
   **没有任何 shard 被写出**，因为断言在生成循环里、写文件之前。

2. **runner 的第一次冒烟**：`AI_CF_PI_S1_ARM` 这个环境变量名没有被改名，
   于是传 `AI_CF_T5_S1_ARM=challenger` 时**两臂都跑成了 baseline**，而日志里
   两次都印 `[spec065 baseline]`，看起来完全正常。
   这是本轮最危险的一类 bug：**它不会失败，它会把 challenger 悄悄换成 baseline，
   然后给出一个看起来很干净的结论。**

两次都是「先冒烟再长跑」抓到的。这条纪律在本轮又一次付了钱。

---

## 6. 成本与投影

退休种子实测（单进程，无竞争）：

| | v1 / top3 | 本轮 top5 |
| --- | ---: | ---: |
| s/group | 3.06 | **3.41**（1.11×） |
| 平均候选宽度 | ~2.7 | **4.09** |
| forks/group | — | 12.3 |

**只贵 11%**，因为一次 capture 的主要成本是**访问阶段**（在 π1 下把整局打完），
而访问阶段不受宽度影响；宽度只影响 fork 的数量。

20,000 groups 投影：单进程 1,138 min；15 分片 76 min；按 Spec 064 实测的
**2.2× 竞争系数** → **约 167 min**。

---

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
