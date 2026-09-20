# Spec 064 Stage 0 记录（基础设施 + 红→绿门禁）

协议见 [spec.md](spec.md)。状态：**Stage 0 完成**。本轮**没有生成任何 corpus、没有训练
任何 π2 模型、没有跑任何 Stage 1 / Stage 2 对局**，三个新池暴露计数 **= 0**。
日期：2026-09-21
分支：`research/phase2-night-lab`

Stage 0 的产物是**机制与守卫**：π1 的数据访问 / 参考 / 续局改写、runtime 两层组合、
以及把 spec §7 的 18 条门禁变成能在 `pnpm check` 里跑的测试。按 §6，Stage 0
**只做基础设施，不在本任务内生成数据**。

---

## 1. Repository / Integrity

| | |
| --- | --- |
| 起点 commit | `ea9066f`（预登记写完之后的 HEAD） |
| `ai-v1^{commit}` | **`96dc6408f9460df50d2240ef642ded15f4b4c586`**（`git rev-parse ai-v1^{commit}`） |
| model artifact sha256 | `010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359` |
| schema hash | `0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0` |
| threshold | `0.01`，严格 `>`，**由冻结产物 import**，代码里没有第二份字面量 |
| production `src/` diff | **1 个文件**（`cf-selector.ts`），且只是把既有评分循环抽成被委托的纯函数 |
| worktree | 提交前：新增 `benchmarks/cf-policy-iteration.ts` + `tests/core/cf-policy-iteration.test.ts` + 本文档；修改 3 个源文件。**无生成物、无私有产物、无 `.local/` 下任何东西** |

`ai-v1` 在本轮的两个角色都落在**同一个记录**上：`CfPiBaseline` 只有 `model` 与
`threshold` 两个字段（`benchmarks/cf-policy-iteration.ts`），基线臂与数据生成策略都从它
读，**没有挑战者字段**，所以两者不可能被指到不同的 model 上（§7.15 的结构半边）。

### 1.1 §0 的唯一 `src/` 变更

`src/app/ai/cf-selector.ts` 新增并导出 `cfScoreAlternatives` / `CfAlternativeChoice`，
`cfSelectFarmerAction` 改为委托它，行为逐命令不变。除此之外 `src/` **零改动**：π2 没有接进
Worker、`decideEnhancedAi`、任何 delivery entry 或产品设置。没有新增依赖。

---

## 2. RED 证据

### 2.1 导入级 RED（`/tmp/stage0-backup/RED.txt`，逐字）

```
 RUN  v4.1.11 /home/andy/code/wx_doudizhu

 ❯ tests/core/cf-policy-iteration.test.ts (0 test)

⎯⎯⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/core/cf-policy-iteration.test.ts [ tests/core/cf-policy-iteration.test.ts ]
Error: Cannot find module '../../benchmarks/cf-policy-iteration.js' imported from /home/andy/code/wx_doudizhu/tests/core/cf-policy-iteration.test.ts
 ❯ tests/core/cf-policy-iteration.test.ts:84:1
     82|   type CfSnapshot,
     83| } from "../../benchmarks/cf-dataset.js";
     84| import {
       | ^
     85|   CF_PI_DATASET_VERSION,
     86|   CF_PI_GROUP_SNAPSHOT_CAP,

⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  no tests
   Start at  02:35:43
   Duration  322ms (transform 207ms, setup 0ms, import 0ms, tests 0ms, environment 0ms)
```

（这条导入级 RED 的另一份同内容记录是 `/tmp/stage0-backup/red-old-code.txt`，02:29。）

**这条 RED 是弱的**：它只证明测试文件先于实现写下，不证明任何守卫真的会红。守卫之所以是
守卫，是因为它**在回归上**红过，所以下面才是本轮真正的 RED 证据。

### 2.2 回归级 RED（强证据）

下面这份是 battery v1 的 **M12**（= battery v2 的 **N14**：`cfForkLabels` 的 fork 不再
消耗一个 decision index）留下的输出。它在 v1 的 `mutations.log` 里**没有条目**——那次
battery 同样中断在最后一条之前——所以这个残留文件是该变异唯一的原始记录。文件：
`/tmp/stage0-backup/red-m12-residue.txt`（逐字；其中行号属于**修正前**的测试文件，
本轮修正后整体下移）：

```
 ❯ tests/core/cf-policy-iteration.test.ts (48 tests | 10 failed) 13694ms
     × produces π2 rows v1's own reader consumes without a change (§7.18) 1376ms
     × moves the continuation when π1 replaces π0, so a π0 fork could not pass 1533ms
     × reproduces the variant's own continuation, rebuilt here rather than self-reported (§7.7) 1527ms
     × keeps the reference's label at zero and records b0 beside it (§7.2) 1338ms
     × really overrides somewhere, and keeps the candidate set at C minus b1 (§7.1, §7.3) 1336ms
     × builds every row against b1, and would differ if it were built against b0 (§7.2) 1331ms
     × consumes exactly one studied-seat decision at each root (§7.6) 1352ms
     × replays a whole π1 capture byte for byte (§7.12) 1139ms
     × records b0 as the reference when π1 declines everywhere 588ms
     × is exactly `cfCaptureGroup` with this round's four frozen options 588ms

⎯⎯⎯⎯⎯⎯ Failed Tests 10 ⎯⎯⎯⎯⎯

 FAIL  tests/core/cf-policy-iteration.test.ts > policy iteration: the frozen baseline is imported, not restated > produces π2 rows v1's own reader consumes without a change (§7.18)
Error: The reference branch did not replay its own game: decisions[2]: human#3 != human#4
 ❯ cfCaptureGroup benchmarks/cf-dataset.ts:840:15
    838|       });
    839|       if (divergence !== null) {
    840|         throw new CfInvalidError(`The reference branch did not replay …
       |               ^
    841|       }
    842|     }
 ❯ cfPiCaptureGroup benchmarks/cf-policy-iteration.ts:319:10
 ❯ group tests/core/cf-policy-iteration.test.ts:358:16
 ❯ tests/core/cf-policy-iteration.test.ts:558:22
```

关键在于它红的**方式**：10 条红，而失败信息是**逐 (seat, decision index)** 的比对
（`decisions[2]: human#3 != human#4`），不是胜者。一条 fork 少消耗一个 decision index
不会改变「谁赢」这个总账，只会让续局的每一步错位——这正是 §7.7 存在的理由，
也正是「winner 相等不算证明」那句话的可执行形态。

**本轮独立复现**：同一变异亲自重跑 → `Tests 10 failed | 38 passed (48)`，
首条失败同为 `produces π2 rows v1's own reader consumes without a change (§7.18)`。
两份记录互证。

另一条中心失败模式（**N2**：reference 改回 raw production 命令 `b0`）在
`mutations2.log` 记为 `Tests 9 failed`；本轮亲自重跑，同为 `Tests 9 failed`，
报错 `The reference branch did not replay its own game: commands length: 10 != 4`。

---

## 3. Mutation 证据

### 3.1 两个 mutation battery（改动实现，不动测试；RED = 守卫抓住了）

`/tmp/stage0-backup/mutate.sh` / `mutate2.sh` 各做一次「还原 → 植入单一破坏 → 跑 focused
suite」。脚本一次性运行、未提交。

| battery | 变异 | 结果 |
| --- | --- | --- |
| v1（`mutate.sh`） | M1 reference := b0 · M2 续局走 π0 · M3 π1 policy 不绑定座位 · M4 layer 1 用 challenger model · M5 layer 2 重算 proposal · M6 阈值比较变非严格 · M7 argmax 取最后一个最大值 · M8 组合对 landlord 生效 · M9 capture 用 v1 的 snapshot salt · M10 capture 不记录 raw production · M11 trace 比较忽略 decision index | **11/11 RED**（`mutations.log`） |
| v1 | M12 fork 不再消耗 decision index | RED · `Tests 10 failed` —— **日志里没有这一条**，原始输出是残留文件 `red-m12-residue.txt`，见 §2.2 |
| v2（`mutate2.sh`） | N1 π2 对 `C-{b0}` 打分 · N2 reference := b0 · N3 续局走 π0 · N4 π2 拒绝回落到 b0 · N5 layer 1 用 challenger model · N6 layer 2 重算 proposal · N7 组合对 landlord 生效 · N8 π1 policy 解绑座位 · N9 非严格阈值 · N10 argmax 取最后一个 · N11 用 v1 的 salt · N12 不记 raw production · N13 忽略 decision index | **13/13 RED**（`mutations2.log`） |
| v2 | N14 fork 不再消耗 decision index（= M12） | **当时无记录**：`mutate2.sh` 在 02:38:51 加入 N14，battery 到 02:42:16 中断于 N13，`last2.txt` 是被打断的残片 —— **本轮补跑：RED，`Tests 10 failed \| 38 passed`** |

**没有任何一条变异存活。** 两个 battery 的变异大体同源（M1–M12 ↔ N2–N14），v2 比 v1 多出
**N1**（π2 对 `C-{b0}` 打分）与 **N4**（π2 拒绝回落到 `b0`）两条，去重后共 **14 条不同变异**，
**14/14 RED**。

值得注意的是两个 battery 都**中断在最后一条之前**：v1 的 M12 与 v2 的 N14 —— 恰好是
**同一条变异**（fork 不再消耗 decision index）—— 双双缺席日志。本轮把这条补跑掉、并与 v1
留下的残留输出对上（都是 `Tests 10 failed`）之后，才敢把「14/14」写进结论。

### 3.2 Stage 0 复核发现并修正的一处空转守卫（重点）

复核时对每条守卫问了一个问题：**它能不能红？** §7.8 那条不能。

原测试断言的是测试文件自己的对象字面量：

```ts
expect(Object.keys(baselineOf(ALWAYS)).sort()).toEqual(["model", "threshold"]);
expect(Object.isFrozen(baselineOf(ALWAYS))).toBe(true);
```

`baselineOf` 定义在测试文件里（`tests/core/cf-policy-iteration.test.ts:193`），
`Object.keys` 读的是那份字面量。这两行**对任何实现都成立**，因此它们关于实现什么都没说。

**实测证明**（变异 V：把 π1 capture 的续局从 π1 换成 π0，即 §7.8 被违反且本轮机制整体失效）：

```
 Tests  4 failed | 44 passed (48)
     × reproduces the variant's own continuation, rebuilt here rather than self-reported (§7.7)
     × really overrides somewhere, and keeps the candidate set at C minus b1 (§7.1, §7.3)
     × builds every row against b1, and would differ if it were built against b0 (§7.2)
     × is exactly `cfCaptureGroup` with this round's four frozen options
```

—— 机制断了，§7.8 那条**照样通过**（44 passed 里就有它）。

**修正**：把空转断言换成同一个 §7.8 主张里**唯一可证伪**的形态 ——
「续局的自由度只有那份冻结记录」。挑战者要漏进续局，只能经由第二个 model 或第二个
threshold；记录里只有这两样，所以两样都必须真的被读到：

* 同一份记录 → 同一结果（纯函数）；
* model 被读到 → 该记录下续局离开 production 命令；
* **threshold 被读到，且用的是这条记录自己的 threshold** → 把它抬到 `ALWAYS` 的分数之上，
  续局必须回到 production 命令。一个「用冻结 model 打分、却拿硬编码 `0.01` 比较」的
  seam（§2 钉死的那个数字的第二份来源）会在这里 override，从而红。

**修正后的守卫能红，且此前无人覆盖**（变异 W：续局忽略 `baseline.threshold`）：

```
 Tests  1 failed | 47 passed (48)
     × has nowhere to put a π2 model, so the continuation cannot be π2 (§7.8)
```

只有它一条红 —— 说明同一分组里那条「独立重导 b1 并与基线臂命令流逐位比对」
（`executes exactly what the shipped selector returns at its own seat`）**并没有**覆盖这个
失败模式，这条断言是**净增**的。

类型层面的「参数表里没有挑战者槽位」仍然由编译器在每个调用点强制；测试里写明了这一点，
不再用运行时断言假装它。

### 3.3 本轮亲自复现的变异（可原样重跑）

| 变异 | 内容 | 结果 |
| --- | --- | --- |
| N2 | `cfCaptureGroup` 的 reference 改回 `rawCommand`（即 `b0`） | RED · `Tests 9 failed` · `The reference branch did not replay its own game: commands length: 10 != 4` |
| N14 | `cfForkLabels` 的 fork 不再消耗一个 decision index | RED · `Tests 10 failed \| 38 passed` |
| V | `cfPiCaptureGroup` 的续局换成 `CF_PRODUCTION_POLICY` | RED · `Tests 4 failed \| 44 passed`（§7.8 当时存活 → §3.2） |
| W | `cfPiDecision` 的 threshold 换成 `CF_PI_THRESHOLD` 字面量 | RED · `Tests 1 failed \| 47 passed`（**仅** §7.8） |

每次变异后都用 `sha256sum` 核对还原：四个实现文件与复核开始时逐字节相同
（`/tmp/stage0-backup/pre-mutation-hashes.txt`），只有被有意修改的测试文件不同。

---

## 4. GREEN 结果

工具链按 AGENTS.md 激活，banner 报 Node `v24.20.0` / pnpm `11.24.0`
（`which node` 落在 `.local/toolchains/node-v24.20.0-linux-x64/bin/node`）。

| 门 | 命令 | 结果 |
| --- | --- | --- |
| focused | `vitest run tests/core/cf-policy-iteration.test.ts` | **1 file / 48 passed** |
| related（`tests/` 下除 focused 外的全部 `cf-*` 套件） | `cf-dataset-guards` 28 + `cf-selector` 17 + `cf-challenger` 11 + `cf-tquantile` 6 | **4 files / 62 passed** |
| boundaries | `pnpm check:boundaries` | **PASS**（47 source files checked） |
| privacy | `pnpm check:privacy` | **PASS**（60 runtime files scanned） |
| full | `pnpm check` | **EXIT=0** |

`pnpm check` 逐段：strict TypeScript ✅ · deterministic tests **41 files / 443 passed** ✅ ·
WebView 90 ✅ · production build ✅ · build output ✅（10 files；main JS 19.99/20.51 KiB gzip，
CSS 5.32/5.71，enhanced AI worker 119.91/120.68）· Android delivery ✅（zero permissions）·
architecture boundaries ✅ · privacy ✅ · Chromium acceptance **33 passed / 1 skipped** ✅。

**§7 的 18 条门禁都落到了具体断言上**（编号 → 测试名，不引行号：行号会随编辑漂移）：

| §7 | 测试 |
| --- | --- |
| 1, 3 | `really overrides somewhere, and keeps the candidate set at C minus b1` · `gives layer 2 the candidate set C minus b1, with b0 still in it` |
| 2 | `keeps the reference's label at zero and records b0 beside it` · `builds every row against b1, and would differ if it were built against b0` |
| 4 | `keeps the frozen threshold strict: exactly 0.01 declines, 0.01 + 1e-9 overrides` · `requires the score to be strictly above the threshold in both layers` |
| 5 | `breaks a tie by the earliest production candidate, not the last` · `breaks ties by the original C order in both layers` |
| 6 | `forces one hand per fork and consumes exactly one studied decision per root` |
| 7 | `moves the continuation when π1 replaces π0, so a π0 fork could not pass` · `reproduces the variant's own continuation, rebuilt here rather than self-reported` |
| 8 | `has nowhere to put a π2 model, so the continuation cannot be π2`（见 §3.2） |
| 9 | `leaves other seats and the landlord on plain production, object for object` · `never fires for a seat it was not bound to` |
| 10 | `derives the game seed from the tournament's own function, at seedBase zero` · `picks the same deck from the corpus seed and from the tournament seed` |
| 11, 12 | `is deterministic and blind to the hidden hands` · `replays a whole π1 capture byte for byte` |
| 13 | `keeps the landlord arm identical and does no work to do it` · `plays the landlord arm identically for both arms, on the real game loop` |
| 14 | `answers with a command the engine itself accepts` |
| 15 | `re-derives b1 with the frozen selector and matches the baseline arm's own commands` |
| 16 | `keeps the three pools pairwise disjoint and off every unavailable range` · `lists every range the spec calls unavailable, including the gaps between its own pools` · `assigns the whole universe to the frozen split counts, with nothing left over` · `gives no stage pool, gap or retired range a training split` |
| 17 | `shares one proposal and traverses each model once per alternative` · `calls the raw production strategy exactly once per decision` · `declines the whole composition when production's action is not a candidate` |
| 18 | `produces π2 rows v1's own reader consumes without a change` |

### 4.1 v1 未被破坏

* `cfCaptureGroup(deck, spec)` 的**全部**新参数都有 v1 默认值
  （`policyFor` → π0、`snapshotSalt` → `CF_SNAPSHOT_SALT`、`datasetVersion` →
  `CF_DATASET_VERSION`、`recordRawProduction` → `false`），`rawProductionIndex` 在 π0 下
  **根本不写进 meta**，所以 v1 snapshot 的字节不变。
* `cfPlayToTerminal` / `cfForkLabels` 的 `policy` 均为尾参默认 π0；
  `productionIndex → referenceIndex` 是**参数改名**，调用点全是位置参数。
* `cfRows` / `cfRow` / `cfSplitTable` / `cfSnapshotPriority` / `cf-model.ts`
  **一行未改**，仍然直接消费 π2 行（§7.18）。
* 未改动的 v1 守卫套件（`cf-dataset-guards` 等，共 62 条）全绿。
* 唯一 `src/` 改动的等价性由 `agrees with the shipped selector command for command, over a
  model battery` 用四个 model（含恰好落在阈值上的和全平局的）逐命令对齐
  `cfSelectFarmerAction` 与 `cfScoreAlternatives` 来钉。

---

## 5. 变更的 seam（Stage 0 全部改动）

**新增文件**

| 文件 | 作用 |
| --- | --- |
| `benchmarks/cf-policy-iteration.ts` | π1→π2 机制：池/切分、π1 作为 capture policy、runtime 两层组合、`createTwoLayerStrategy` |
| `tests/core/cf-policy-iteration.test.ts` | §7 的公开契约守卫（48 条，进 `pnpm check`） |

**修改文件**

| 文件 | 改动 |
| --- | --- |
| `src/app/ai/cf-selector.ts` | 抽出并导出 `cfScoreAlternatives` + `CfAlternativeChoice`（严格 `>`、首个最大值、跳过参考项）；`cfSelectFarmerAction` 委托它 |
| `benchmarks/cf-dataset.ts` | 新增 `CfPolicy` + `CF_PRODUCTION_POLICY`、`cfTraceDivergence`（逐命令 + 逐 (seat, index) 比较）；`cfPlayToTerminal` / `cfForkLabels` / `cfCaptureGroup` 各加**默认 π0** 的尾参；`cfPlayVariant` 接收 policy 并回报自己那条 trace；`CfSnapshotMeta` 增加可选 `rawProductionIndex` |
| `benchmarks/ai-tournament.ts` | 抽出并导出 `dealGameSeed(dealSeed, strongSeat, landlord)`，`runPairTournament` 改用它（**纯抽取**，表达式逐字不变） |

**本轮明确不做**：`benchmarks/cf-pi-corpus.test.ts`（spec §15 的 generate/merge/audit
driver）—— 它是下一步，见 §7。

---

## 6. 零暴露（三个新池暴露计数 = 0）

### 6.1 产物扫描（本轮重跑，同一方法）

对 `.local/` 下全部 `.json` / `.txt` / `.log` 做字段级正则扫描，四类字段
（`dealStart` / `dealIndex` / `dealGroupId` / `variantId`）：

```
files scanned: 632
  dealIndex:   n=160743  min=5001  max=70000
  variantId:   n=119996  min=50001  max=70000
overlap with 100001-120000: 0
overlap with 120001-120200: 0
overlap with 130001-131200: 0
```

历史上被生成过的最大 deal index 是 `70000`（Spec 062 universe 的上界）。

### 6.2 静态论证（Stage 0 的代码不可能碰到新池）

* 测试只会**真正发牌/打牌**的 index 是 `50_001–50_080`，全部落在 `50001–70000`
  （Phase 2 v1 dataset，已消耗，本轮不得作为**新**池使用，但作为只读守卫 fixture 不产生
  任何新暴露，与 `cf-dataset-guards` 既有做法一致）。
* `cfPiGroupSpecFor(100_001, …)` 这类调用**只构造 spec 对象**：算 `gameSeed`、挑 tiers、
  排 variants，**不发牌、不打牌**。
* `cfPiSplitOf` 是 `mix32` 纯哈希，与对局无关。
* 测试跑完后 `git status` 里**没有任何生成物**，只有两个新源文件。

### 6.3 这条证据的边界

它是**字段级正则**，不是对全部 JSON 的语义解析；它证明的是「没有任何产物在 deal-index
字段上落进新池」，不是「这些数字从未以任何形式出现过」；也不覆盖 `.local/` 之外的位置
（与 [seed ledger](../../research/ai-used-seed-ledger.md) §3 自陈的边界一致）。

---

## 7. 限制

1. **Stage 0 没有生成任何数据**（§6）。因此 §7.16 的「对**全部生成物**机械断言、不是抽样」
   目前只在**区间层**成立 —— 池两两不交、每个生成 group 的 `dealIndex` 必须在自己的池内、
   与全部不可用区间交集为空，分别由 `keeps the three pools pairwise disjoint and off every
   unavailable range`、`gives no stage pool, gap or retired range a training split`、
   `assigns the whole universe to the frozen split counts, with nothing left over` 钉住；
   **行级**断言要等 corpus 生成时对每一行做。
2. **§7.8 的运行时形态是间接的**（§3.2）：类型层面「参数表里没有挑战者槽位」由编译器强制，
   运行时只能钉「续局的自由度只有那份冻结记录」。这是该主张最强的可证伪形态，不等于该主张本身。
3. **fixture 是搜索出来的，不是写死的**：某个农民 root 有没有三宽候选集、某条 variant 上
   π1 会不会真的 override，都是**牌局的属性**，不是这个文件能决定的。所以 `fixture()`、
   `piReplayFixture()`、以及 baseline identity 那条都在退休区间
   （`50_001–50_080`）里**搜**出满足形状的 deal。这避免了「靠一副牌碰巧成立」，
   代价是每组 fixture 要多跑若干局（focused suite 约 16s 主要来自这里）。
4. **mutation battery 是一次性脚本，未提交**（在 `/tmp/stage0-backup/`）。它的结论已抄进本
   文件，但脚本本身不随仓库长期存在。
5. **本轮不做任何强度/语料/训练 benchmark**（按任务边界），所以 Stage 0 **对效应量一无所知**。
   Gate A `+2.0083%`、Gate B `+10.917%`、final validation `+5.292%` **不得**被外推成本轮预期值
   （§1）；§11.1 的 `sd ≈ 0.1151 / SE ≈ 0.332pp` 是**近似规划值**，不是功效预测。
6. **Stage 0 的红绿门禁不构成任何 NIGHT KEEP 证据**。判定词只属于 Stage 2（§11）。

---

## 8. 下一步：corpus handoff（精确）

按 spec §15，下一步要产出 `benchmarks/cf-pi-corpus.test.ts` —— 新 universe 的
generate / merge / audit driver。它必须**逐字**使用下面这些冻结值，不得另立字面量：

| 项 | 值 / 来源 |
| --- | --- |
| universe | `CF_PI_UNIVERSE_START`–`CF_PI_UNIVERSE_END` = 100001–120000 |
| spec 构造 | `cfPiGroupSpecFor(dealIndex, policyCommit)`（越界即抛，不返回 null） |
| capture | `cfPiCaptureGroup(dealDeck(spec.dealSeed), spec, baseline)` |
| baseline | `{ model: parseTreeModel(<冻结 artifact>), threshold: CF_PI_THRESHOLD }` |
| seedBase | `CF_PI_SEED_BASE` = 0，用 `assertPiSeedBase` 断言 |
| split | `cfPiSplitOf`（salt `CF_PI_SPLIT_SALT`），train/calibration/held-out = 12000/4000/4000 |
| snapshot salt | `CF_PI_SNAPSHOT_SALT`（**不是** v1 的） |
| dataset version | `CF_PI_DATASET_VERSION` = 3 |
| 每 group cap | `CF_PI_GROUP_SNAPSHOT_CAP` = 3 |
| 读取端 | v1 的 `cfRows`，**一行不改**；`x` 必须是 86 列 |

**生成时必须机械断言（对每一行 / 每一个 group，不是抽样）**：

1. 每个生成 group 的 `dealIndex` 落在 **dataset 池**内，且与 spec §8 的全部不可用区间交集为空；
2. 每一行 `a ∈ C \ {b1}`，`|C| ≤ 3`，`b0 ∈ C`，且 `b0 != b1` 时 `b0` 仍在候选集里（§7.1/§7.3）；
3. 每一行的 `a` 与 `b0`、`b1`、challenger 输出都落在引擎自己的合法动作集合里（§7.14）；
4. 每个被研究 root 上 `cfProposal` 恰好 1 次、raw production master 恰好 1 次（§7.17）；
5. 参考分支逐命令、逐 decision index 复现原局续局（§7.7，`cfTraceDivergence` 已就位）。

**不得触碰**：`120001–120200`、`130001–131200`、`120201–130000`、`131201` 起，
以及 ledger §1 列出的全部已退休 / 已消耗区间。

**训练配置一个字都不改**（§4）：同一份 `CF_LGBM_CONFIG_VERSION`、train seed `20260920`、
只训练一次、训练后冻结 artifact + checksum。禁止多 seed 挑选、禁止 calibration 后重训。

**其后**：π2 artifact → Stage 1（`120001–120200`，恰好 200 组，**不能 KEEP**）→
只有 Stage 1 通过才跑 Stage 2（`130001–131200`，恰好 1,200 组，本轮唯一一次正式判定）。

**`08:30` CST 硬停**（§14）优先于以上一切：到点无条件下停，已产出的部分记 INCOMPLETE，
被触及的池按已暴露处理并退休，**不得**下一夜用同一池续做。

---

## 9. 复跑方式

```bash
source scripts/activate-toolchain.sh          # banner 必须报 Node v24.20.0 / pnpm 11.24.0
node node_modules/vitest/vitest.mjs run tests/core/cf-policy-iteration.test.ts   # 48
pnpm check:boundaries
pnpm check:privacy
pnpm check
```

RED 证据与 mutation battery 的原始输出在 `/tmp/stage0-backup/`
（`RED.txt`、`red-m12-residue.txt`、`mutations.log`、`mutations2.log`、`mutate*.sh`）——
**临时目录，不随仓库存在**；本文件已把结论逐条抄录。
