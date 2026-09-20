# AI 种子池 ledger（已用 / 已暴露 / 本轮新分配）

状态：**记录性文档**。它不规定任何算法、门槛或下一步，只回答一个审计问题：
**每一个牌局区间被哪些正式实验看过，现在还能不能再看。**

建立日期：2026-09-21（Spec 064 / Phase 2 Night Lab 预登记时）。

## 为什么需要这份文档

单次预登记防的是「事后改协议」，防不住的是**几十个都合规的实验反复看同一批牌**。
selection-on-discovery 的风险随暴露次数累积，而不是被预登记消掉。此前这条规则散落在
[ai-experiment-results.md](ai-experiment-results.md) 的正文与各 spec 的「池」一节里；
本次把它收拢成一张表，并在 Spec 064 开新池时**同时**记录新分配。

规则不变：**一个新池只服务一条机制线。** 一条机制线的结论一旦被用来生成下一条假设，
那个池就随之退休。**已退休的池可以回看错题，但新机制的考试必须换卷子。**

## 1. 已用 / 已暴露（本轮不得使用）

| 范围 | 身份 | 暴露计数 | 状态 | 证据 |
| --- | --- | ---: | --- | --- |
| `301–700` | Discovery V1（被 E1、E3 使用） | 2 | **已退休** 2026-09-19 | [results](ai-experiment-results.md) §种子池与暴露计数 |
| `20001–20400` | Discovery V2（被 E4 使用） | 1 | **已退休** 2026-09-19 | 同上 |
| `30001–30400` | Discovery V3（被 E5 / H5 v1 使用，判 REVERT） | 1 | **已退休** 2026-09-19 | [Spec 060](../specs/060-terminal-evidence-gating/experiment.md) |
| `5001–5400` | 早期 calibration | — | **仅机械 prototype 与吞吐测量**，不进入任何正式 corpus | [Spec 062 §2](../specs/062-counterfactual-policy-improvement/spec.md) |
| `10001–10400` | Phase 2 v1 final validation | 1 | **已消耗，永久 retire** 2026-09-21（FINAL KEEP） | [Spec 063 final-validation](../specs/063-counterfactual-farmer-selector-gate-b/final-validation.md) |
| `40001–41200` | Gate B Discovery V4 | 1（0 → 1） | **已 retire**（结果被看到即退休） | [Spec 063 §8](../specs/063-counterfactual-farmer-selector-gate-b/spec.md)、[experiment](../specs/063-counterfactual-farmer-selector-gate-b/experiment.md) |
| `50001–70000` | Phase 2 v1 dataset（20,000 groups） | 1 | **永久属于 Phase 2 v1**，不得再用于其它 Phase | [Spec 062 §2](../specs/062-counterfactual-policy-improvement/spec.md) |
| `70001–78000` | Spec 062 test-only reserve（8,000 groups） | **0（从未生成）** | **仍不可用** | Spec 062 §2 / §23；`experiment.md` 记录「未生成 reserve」 |

`20001–20400` 只被用过一次就退休，理由不是次数，而是**下一条机制必然受到它上面结果
的启发**——再用同一批牌验证由这些结果催生的想法，selection-on-discovery 就已经开始。

`70001–78000` 虽然从未生成，但它是 Spec 062 预登记里**留给那一轮**的 reserve。
本轮是**另一条机制线**，不得征用它；它保持不可用。

## 2. 本轮新分配（Spec 064 / Phase 2 Night Lab）

| 范围 | 身份 | 规模 | 用途 |
| --- | --- | ---: | --- |
| **`100001–120000`** | **π1→π2 dataset** | 20,000 groups | train / calibration / held-out = 12,000 / 4,000 / 4,000 |
| **`120001–120200`** | **Stage 1 screen** | **恰好 200 groups** | 固定 200 组 paired 整局筛选；**不能 KEEP**，永不与 Stage 2 合并 |
| **`130001–131200`** | **Stage 2 confirmation** | **恰好 1,200 groups** | 唯一一次正式判定（NIGHT KEEP / REVERT） |
| `120201–130000`、`131201` 起 | **未分配** | — | 本轮不得使用；也不得事后改判 |

先例：Gate A/B 的 deal seed 就是绝对下标本身 —— `dealSeed = dealIndex`，
tournament 侧 `seedBase = 0`（`AI_BENCH_SEED=0`）使
`dealSeed = seedBase + dealIndex = dealIndex` 与 corpus 完全一致。
本轮**沿用并显式断言**这条映射（Spec 064 §7 第 10 条）。

Stage 1 与 Stage 2 **互不合并、互不补位**。Stage 1 不通过就不跑 Stage 2，也不扩样。

## 3. 新池「未被触碰」的机械证据（2026-09-21）

在写下 Spec 064 的当时，对 `.local/` 下全部 `.json` / `.txt` / `.log` 产物做了一次
正则扫描，提取四类承载 deal index 的字段：

```
"dealStart": <n>      "dealIndex": <n>      "deal-<n>"      "variantId": "<n>:..."
```

结果（脚本一次性运行，未提交；可原样重跑）：

```
files scanned: 632
  dealGroupId: n=20060  min=5001   max=70000
  dealIndex:   n=20060  min=5001   max=70000
  dealStart:   n=57     min=0      max=68572
  variantId:   n=20000  min=50001  max=70000

overlap with 100001–120000: 0
overlap with 120001–120200: 0
overlap with 130001–131200: 0
```

即：**历史上被生成过的最大 deal index 是 `70000`**（Spec 062 universe 的上界），
三个新池在此之前**暴露计数 = 0**。

同日（2026-09-21）Spec 064 补齐了 §7 的 legality / baseline identity / seed overlap /
单次 proposal / candidate interface 五条门禁与 §14 的 `08:30` CST 硬停。**补写发生在
任何生成、训练与对局之前**，因此本节的扫描结论不变：三个新池**至今暴露计数仍为 0**。

**这条证据的边界要说清楚**：它是**字段级正则**，不是对全部 JSON 的语义解析；它证明的是
「没有任何产物在 deal-index 字段上落进新池」，不是「这些数字从未以任何形式出现过」。
它也不覆盖 `.local/` 之外的位置。作为「新池尚未被消费」的证据它足够，作为更强的声称不够。

## 4. 使用规则（与 results 文档一致）

1. 退休池**可以**继续做诊断、人工阅读、机制归因与 regression。
2. 这些诊断**可以**用于生成下一条假设。
3. 但由这些诊断启发的新算法，**正式判定不得再用退休池**。
4. 新机制的第一次正式 paired A/B 必须用一个**未消耗的池**。
5. 判定一旦做出，该池**用毕即退休**，不得再决定任何 KEEP / REVERT。

一句话：**可以回看错题，但新机制的考试必须换卷子。**
