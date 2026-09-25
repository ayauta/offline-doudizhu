# Spec 062 实验记录（Gate A v1：数据、训练、calibration）

协议见 [spec.md](spec.md)。状态：**calibration 完成，threshold 已冻结，
正式 held-out 已揭盲一次并判定 GATE A PASS**。
日期：2026-09-20

held-out `4000` groups **只被 frozen selector 正式判定一次**。未使用 reserve，
未开始 Gate B，production `src/` 0 diff。

## 1. 执行摘要

| 步骤 | 结果 |
| --- | --- |
| 1–6 基础设施 / guards / `pnpm check` / commit | ✅ `4e20be3` |
| 7 生成 universe `50001–70000` | ✅ 20,000 groups / 14 shards |
| 8 train + calibration 结构 QA | ✅ 全部 integrity 计数为 0 |
| 9–10 训练唯一冻结配置的 LightGBM | ✅ 63,199 rows，model sha256 `010a8a4a…` |
| 11 calibration 六阈值 | ✅ 六个阈值 `L_cal` 全为正 |
| 12 冻结 threshold | ✅ **`0.01`** |
| 13 停止 | ✅ 未打开 held-out |

## 2. Corpus

pipeline commit `4e20be3cc53d8434ed9e5642f014d2d5cb7c0878`，
production baseline `ea67aa3`，schema hash `0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0`，
merged corpus checksum `75618f65383be903cee0456538a16bd83c525e263ea9452bcebaeddd28332748`。

| split | registered groups | groups with snapshots | snapshots | non-a0 rows | max/group |
| --- | ---: | ---: | ---: | ---: | ---: |
| train | 12,000 | 12,000 | 35,999 | 63,199 | 3 |
| calibration | 4,000 | 4,000 | 11,999 | 21,066 | 3 |
| heldout（封存） | 4,000 | 4,000 | 12,000 | 21,067 | 3 |

结构审计（三个 split 全部）：`splitMismatch 0  schemaMismatch 0  labelIntegrity 0  productionIndex 0`。
held-out 只报告这些结构性计数。

**每个 group 都产出了 snapshot**（empty groups = 0）：20,000 副牌里没有一副是「农民完全没有
可选动作」的，这比 pilot 的估计乐观——pilot 里 46% 的**root** 只有单一动作，但一个 group 有
三次 arm-B 机会，取到至少一个可用 root 的概率接近 1。

## 3. Train / calibration QA（diagnostics，非判据）

| | train | calibration |
| --- | ---: | ---: |
| rows（non-a0） | 63,199 | 21,066 |
| `+1` | 3,333 | 1,161 |
| `0` | 54,087 | 18,070 |
| `-1` | 5,779 | 1,835 |
| non-zero rate | **14.42%** | **14.22%** |
| groups with ≥1 nonzero row | 5,325 / 12,000 | 1,753 / 4,000 |
| 农民座位覆盖 | ai-one 11,912 / human 12,201 / ai-two 11,886 | 3,893 / 4,064 / 4,042 |

分支交叉表（train，按非 a0 行）：

| a0 分支阵营 | 候选分支阵营 | 行数 | label |
| --- | --- | ---: | --- |
| 输 | 输 | 22,831 | 0 |
| **输** | **赢** | **3,333** | **`+1`** |
| 赢 | 输 | 5,779 | `-1` |
| 赢 | 赢 | 31,256 | 0 |

a0 分支赢下 59.1% 的 snapshot。`+1 : -1 = 1 : 1.73`——生产动作比它的替代项更好更常见，
这正是「a0 是生产动作」应有的方向，也是这套标签没有退化成单侧的证据。

expert gap 分桶（train，non-a0 行的 non-zero 率）：`<=0` 602/2,909（20.7%）、
`0–500` 2,959/27,846（10.6%）、`500–1500` 3,708/22,946（16.2%）、`>=1500` 1,843/9,498（19.4%）。
非单调，说明反事实优势不是 expert gap 的单调重述——但没有模型的 held-out 结果之前，
这只是一条观察。

## 4. 模型

| 项 | 值 |
| --- | --- |
| library | LightGBM **4.6.0**（CPU，离线） |
| config version | `gateA-v1-frozen` |
| objective / loss | `regression` / L2 |
| trees / depth / leaves | 256 / 6 / 31 |
| learning rate | 0.05 |
| min_data_in_leaf | 100 |
| lambda_l2 | 5 |
| max_bin | 63 |
| threads / deterministic | 1 / true |
| seed | 20260920 |
| train rows | 63,199（仅 non-a0） |
| weights | `1/(roots_in_group × alternatives_at_root)`，归一化到 mean 1（实际 0.8778–1.7555） |
| **model sha256** | **`010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359`** |

训练一次，无超参搜索，无早停，无 seed 挑选，未在 calibration 后重训。

## 5. Calibration（4,000 registered groups）

`mu_hat` 与 `L_cal` 都是 **group 级** primary：每个 registered group 先算
`R_i = mean_j(z_ij)`（未 override 的 root 记 0，无 useful root 的 group 记 0），
再对全部 4,000 个 group 取均值。`L_cal` 为 Bonferroni 校正单侧下界
（`t_(1-0.05/6, 3999) = 2.39499`）。

| threshold | `mu_hat` | `L_cal` | override deals | selected-nonzero deals | coverage | cond (good−bad)/ovr |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | +0.019167 | +0.013989 | 3,180 | 534 | 41.65% | +0.0460 |
| **0.01** | **+0.019083** | **+0.014310** | **2,800** | **471** | **33.97%** | **+0.0562** |
| 0.02 | +0.018000 | +0.013589 | 2,415 | 412 | 27.84% | +0.0647 |
| 0.04 | +0.014917 | +0.011093 | 1,765 | 318 | 18.88% | +0.0790 |
| 0.08 | +0.006917 | +0.004351 | 768 | 147 | 7.24% | +0.0955 |
| 0.16 | +0.002000 | +0.000805 | 131 | 27 | 1.13% | +0.1765 |

支持量门槛（override deals ≥ 200、selected-nonzero deals ≥ 50）把 `0.16` 排除
（131 / 27）。其余五个阈值合格，其中 `L_cal` 最大的是 **`0.01`**（+0.014310，与 `0` 的
+0.013989 相差 0.00032）。

### 冻结

```
threshold = 0.01
selector  = benchmarks/cf-selector.ts::cfChooseOverride  （严格 >，tie 取 production 候选序）
evaluator = benchmarks/cf-selector.ts::cfHeldoutVerdict   （双侧 97.5%，mu_min = 0.005）
model     = sha256 010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359
```

**读法上的克制**：这是 **calibration** 数字，threshold 是在同一批 4,000 个 group 上选出来的，
因此 `mu_hat` 必然带有选择效应，不能被当成 Gate A 的效应量。它只回答一个问题——
「是否存在一个阈值，其保守下界为正」。答案是「是」，所以按协议继续，而不是在这里庆祝。

## 6. 本轮抓到的问题（都已修，且都有守卫）

1. **`tiers` 是 group 级字段，但 arm B 会轮换被研究的座位** —— 三个 variant 里有两个跑在
   错误档位上，eligibility 会大面积失效。守卫测试抓到的；若漏到 corpus，整个数据集作废。
   已改为 per-variant。
2. **label 统计的键写错** —— 第一版 tally 用 `String(label)` 做键（得到 `"1"`），
   而报告读 `counts["+1"]`。所有 `+1` 被数出来然后从不显示，corpus 看起来一个正例都没有。
   数据没错，是**读数**错了——这是最贵的错法。现在 tally 是有测试的导出函数。
3. **`cfRow` 的 a0 用固定 seed 重算** —— master 的 rollout world 由 decision seed 决定，
   换 seed 可能排出不同 top1，于是「a0 分支复现原局」的自检在真实 master 上直接拒收。
   现在 a0 只从游戏主循环里带出来。
4. **生成器依赖 vitest 的 15 分钟默认超时** —— 每个 shard 都是多小时的活。第一次全量运行
   **14 个 shard 全部报超时，但 14 个 shard 文件全都写出来了**：vitest 无法中断同步测试，
   活干完了、文件落盘了、超时是事后报的。driver 把这些报告读成失败并跳过了 merge，
   于是一个完整躺在磁盘上的 corpus 看起来像从未建成。现在超时显式声明，driver 带 resume。
5. **shard 文件里带 `jobs` 字段** —— 让 `jobs=1` 与 `jobs=16` 的「逐字节相同」检查变成
   假警报。删掉之后，检查覆盖的是**整个文件**，比原来更严。

## 7. 未做的事

- 未运行正式 held-out（Step 13）。
- 未读取任何 held-out outcome 统计。
- 未创建 Gate B pool，未接 production selector，`src/` 0 diff。
- 未生成 reserve `70001–78000`。

---

# 正式 held-out 揭盲（唯一一次）

## 0. 揭盲前 freeze verification（全部通过）

| 检查 | 结果 |
| --- | --- |
| HEAD == `2ce4bfb043f55ca407b4fd8c9eb156ccd0617299` | ✅ |
| worktree clean；`4e20be3` 是 HEAD 的祖先 | ✅ |
| production `src/` diff vs `ea67aa3` | ✅ 0 |
| `sha256(model.txt)` == `train-config.modelSha256` | ✅ `010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359` |
| schema hash（运行时重算）== manifest | ✅ `0ec9d20f…7d85f0` |
| corpus checksum（从三个封存文件重算）== manifest | ✅ `75618f65…32748` |
| threshold 恰为 `0.01` | ✅ |
| selector 严格 `>`、tie 取 production 候选序 | ✅ 由 `tests/core/cf-selector.test.ts` 钉住（23 tests green） |
| 4,000 held-out groups 与预登记 `cfSplitTable` **成员完全一致** | ✅ |
| split crossing | ✅ 0 |
| held-out 从未进入 train / calibration | ✅ snapshot id 交集 0；universe 无重叠 |

> 注：任务描述里写的 model SHA `010a8a4a00524f0694d5881bacd82fc3359` 是**截断转写**，
> 实际 artifact 是上表 64 位全串；已核验与 `train-config.json` 一致。

**harness 说明（揭盲前完成，已披露）**：frozen evaluator 此前没有 held-out 的输入通路。
补的是**纯 plumbing**——row exporter 增加 split 选择、新增 held-out 判定分支、以及
「held-out 的 label 统计不打印」。**模型 / feature / threshold / selector / 统计规则 / 数据
一律未动**，并由上表 checksum 在改动前后**逐字节复验**。threshold 由冻结产物
`threshold.json` 读出，不是重打一遍。

## 1. PRIMARY

| | |
| --- | ---: |
| N registered groups | **4,000** |
| `mu_hat` | **+0.020083** |
| SE | 0.001923 |
| **97.5% t interval** | **[+0.015771, +0.024396]** |
| `mu_min` | 0.005 |
| override distinct deals | 2,774（门槛 200） |
| selected-nonzero distinct deals | 459（门槛 50） |
| integrity | valid |

| PASS 条件 | 实际 | |
| --- | --- | --- |
| `mu_hat >= 0.005` | +0.020083 | ✅ |
| `L > 0` | +0.015771 | ✅ |
| override deals >= 200 | 2,774 | ✅ |
| selected-nonzero deals >= 50 | 459 | ✅ |
| integrity valid | true | ✅ |

## **GATE A PASS**

区间下界 `+0.015771` 是最低工程效应的 **3.15 倍**；上界 `+0.024396` 远高于 `mu_min`，
因此既不构成 FAIL，也不构成 INCONCLUSIVE。

**与 calibration 的对照（读法很重要）**：calibration `mu_hat` 在 `0.01` 上是 `+0.019083`，
held-out 是 `+0.020083`。**没有出现收缩**——threshold 是在 calibration 上选的，
如果选择效应显著，held-out 通常会掉下来。这条对照**不改变判定**（判定只由 held-out
的预登记规则给出），但它说明 `+1.9pp` 不是同一批数据上的自证。

## 2. Selector diagnostics

| | |
| --- | ---: |
| sampled snapshots | 12,000 |
| override snapshots | 4,100 |
| deal-equal coverage | 2,774 / 4,000 = **69.35%** |
| root-level coverage | **34.17%** |
| raw selected overrides | good 368 / neutral 3,605 / bad 127 |
| `(good − bad) / overrides` | **+0.0588** |

override 里 **87.9% 是 neutral**——模型提出的大多数偏离并不改变终局，这与 pilot 的
14% 非零标签密度一致。收益来自少数真实翻转，且方向有利（368 : 127）。

## 3. 预登记 subgroup（descriptive，不能改变 primary）

| subgroup | snapshots | overrides | good | neutral | bad | (good−bad)/ovr |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| farmer position +1 | 6,105 | 1,620 | 148 | 1,420 | 52 | +0.0593 |
| farmer position +2 | 5,895 | 2,480 | 220 | 2,185 | 75 | +0.0585 |
| stage min<=2 | 4,470 | 1,599 | 134 | 1,430 | 35 | +0.0619 |
| stage min 3-4 | 3,267 | 1,339 | 130 | 1,177 | 32 | +0.0732 |
| stage min 5-9 | 3,315 | 955 | 94 | 819 | 42 | +0.0545 |
| **stage min>=10** | 948 | 207 | 10 | 179 | **18** | **−0.0386** |
| expertGap <=0 | 77 | 77 | 5 | 69 | 3 | +0.0260 |
| expertGap 0-500 | 1,774 | 1,774 | 128 | 1,603 | 43 | +0.0479 |
| expertGap 500-1500 | 1,723 | 1,723 | 183 | 1,474 | 66 | +0.0679 |
| expertGap >=1500 | 526 | 526 | 52 | 459 | 15 | +0.0703 |

两个农民相对座位几乎无差异（+0.0593 vs +0.0585）。**唯一为负的是 `stage min>=10`**
（+10 : 18，n=207，占比很小）。这**不改变判定**，也不允许据此改 primary、改 threshold
或做 per-stage selector——那属于揭盲后的协议修改。它只是一个留待 Gate B 设计时参考的观察。

## 4. 本轮未做

- 未开始 Gate B，未设计 Gate B。
- 未生成 reserve `70001–78000`。
- 未修改 production `src/`（仍 0 diff）。
- 未改 threshold / model / feature / selector / tie-break / 统计规则 / 数据。
- 未把 calibration 与 held-out 合并重算，未换 95% 区间。
