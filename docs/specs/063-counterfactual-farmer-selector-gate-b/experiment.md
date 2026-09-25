# Spec 063 实验记录（Gate B-A 整局 A/B）

协议见 [spec.md](spec.md)。状态：**Gate B-A 已跑完，判定 PASS；未跑 shipped，未使用 final
validation，未创建 Phase 2 v2**。
日期：2026-09-20

## 1. Repository / Integrity

| | |
| --- | --- |
| prereg commit | `258f456`（Spec 063 + runtime，**在跑 A/B 之前**提交） |
| Gate A pipeline commit | `4e20be3`；production baseline `ea67aa3` |
| worktree | clean（运行前） |
| production `src/` diff | **0** |
| model checksum | `010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359`（跑完全程后复验仍 OK） |
| schema hash | `0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0` |
| threshold | 由冻结产物读出，恰为 `0.01` |

### 运行前门禁

| 门禁 | 结果 |
| --- | --- |
| frozen model checksum | ✅ |
| runtime / reference 等价 | ✅ **`max|Δ| = 0.000e+0`**（21,066 rows）；argmax / override / selected-label divergence 全 **0**（六阈值 × 11,999 roots） |
| threshold exactly 0.01 | ✅ |
| landlord invariant（arm A 命令流） | ✅ **0 divergence**（18 games / 565 commands） |
| hidden-state runtime invariance | ✅ 重发隐藏手牌 5 次，selector 命令不变 |
| candidate contract | ✅ eligibility 与 Gate A 同一规则 |
| deterministic jobs invariant | ✅ 分片拼接 == 整段（`shard A + B == whole`） |
| production fallback behavior | ✅ selector 拒绝时返回 **production 原命令对象本身**（`toBe`） |
| `pnpm check` | ✅ exit 0 |
| pool `40001–41200` exposure | ✅ 0（无任何 shard metadata / 正式 A/B 使用记录） |

`Gate B V4 exposure 0 → 1`。

## 2. Primary（combined paired full-game）

1,200 deals × 6 games/副/臂 = 7,200 games per arm。统计沿用仓库既有 paired deal-level 方法
（per-deal difference + `clusterInterval` deal-clustered bootstrap，seed `20260919`）。

| 臂 | baseline | challenger | **PAIRED Δ** | 95% CI |
| --- | ---: | ---: | ---: | --- |
| arm A（strong 当地主） | 50.5% | 50.5% | **0.000%** | [0.000%, 0.000%] |
| arm B（strong 当农民） | 53.8% | 64.8% | **+10.917%** | [+9.583%, +12.194%] |
| **combined（pooled）** | 52.2% | 57.6% | **+5.458%** | **[+4.792%, +6.097%]** |

逐副转移（pooled，每副 6 局）：**challenger better 422 / worse 87 / tie 691**。
swing 直方图 `−2:2  −1:85  0:691  +1:365  +2:54  +3:3`。

`combined Δ = 5.458% = farmer Δ / 2 = 10.917 / 2` ✅ ——与 arm A 恒 0 的推论一致。

| continuation criterion | 实际 | |
| --- | --- | --- |
| `combined Δ > 0` | +5.458% | ✅ |
| combined paired 95% CI lower > 0 | +4.792% | ✅ |
| `combined point estimate >= +1.0pp` | +5.458pp | ✅ |
| landlord invariant exact | 1,200 副逐副 0 差异 | ✅ |
| no integrity failure | 见 §1 | ✅ |

## **GATE B-A PASS**

farmer point estimate `+10.917pp` 远超产品门槛所需的 `+2.0pp`。

## 3. Selector diagnostics

| 项 | 值 |
| --- | ---: |
| strong-seat farmer decisions | 38,347 |
| selector eligible decisions | 24,016（62.6%） |
| override decisions | **7,316**（19.1% of decisions，30.5% of eligible） |
| distinct deals with ≥1 override | 1,175 / 1,200 |
| 每场 arm-B game 平均 override | **2.03** |
| override 次数分布（0/1/2/3/4+） | 538 / 930 / 917 / 658 / 557 |
| chosen candidate rank（production 候选序） | rank0 122 / rank1 4,348 / rank2 2,846 |
| override 的 score：p10 / p50 / p90 | 0.0144 / 0.0431 / 0.1062 |
| override margin 超过阈值：p50 / max | 0.0331 / 0.3171 |
| 被拒绝的最近 margin | −0.000008（严格 `>` 确实在边界上起作用） |
| override by farmer position | +1 3,069 / +2 4,247 |
| override by stage | min≤2 2,581 / 3–4 2,494 / 5–9 1,848 / ≥10 393 |

## 4. 连续 override / distribution shift

**85% 的 arm-B game 至少发生一次 override，34% 至少三次。** Gate A 训练的是
「干预一手然后回到 π0」，而 Gate B 里 `π1 → π1 → π1` 是常态而非例外。
这正是 Gate A 的单步数字不可外推的原因，也是本实验要测的东西。**只记录，未据此修改策略。**

## 5. Performance instrumentation

selector 纯模型成本（designed，jobs>1，**不作为产品性能**）：

| | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| feature construction / decision | 0.101 ms | 0.136 ms | 1.227 ms |
| tree inference / decision | 0.091 ms | 0.117 ms | 0.439 ms |
| **合计 / decision** | **0.192 ms** | — | — |

约 **0.39 ms / game**。

> **更正（Gate B-S 实测）**：上表**漏了一项，而且漏的是最大的一项**。
> overlay 除了 feature + inference，还要重新推导一次 production shortlist
> （`cfProposal`，220 analyzer nodes）。Gate B-S 直接测得：
> **proposal 8.927 ms + feature 0.105 ms + inference 0.078 ms = 9.110 ms / eligible decision**。
> 也就是说真实 overlay 成本是上表的 **47 倍**，proposal 占了 98%。
>
> 上表数字本身没测错，但它测的是三个部分里的两个，而报告时被当成了全部。
> 这是本项目里第二次「数据没错、读数错了」。Gate B-A 的棋力结论不受影响
> （overlay 只在 master 搜索之后运行，不改变 any 决策内容），但性能结论被高估了。

真实产品性能测量仍必须 `jobs=1`。

## 6. 一个必须说明的读数陷阱

用 benchmark 的 `recorder.commands`（命令日志）去定位 baseline 与 challenger 的第一处分歧，
会得到**错误答案**：`createMeasuredStrategy` 在 decorator 之前就把命令写进日志，所以
challenger 被 override 的那一手在日志里看起来与 baseline **完全相同**，第一处*日志*分歧
出现在下游座位（地主/队友）上。

第一次检查因此报出「14 处分歧中只有 5 处在 strong seat」，看起来像 selector 泄漏到了别的座位。

用**实际打出的命令**重新检查（装饰器外层记录真正被 play 的命令）：
**24 场 arm-B 对局中 20 场分歧，20/20 的第一处分歧都发生在 strong seat 自己身上，
20/20 challenger 的第一手分歧命令都属于 strong seat。** 机制正确。

这条不影响 primary（primary 只看胜负），但它是一个真实的观测陷阱，记在这里以免下次再踩。

## 7. 未做的事

* 未跑 shipped / deadline 路径。
* 未使用 final validation `10001–10400`。
* 未改 threshold / model / feature / selector / 统计方法 / 数据。
* 未因结果而调整任何东西；未创建 Phase 2 v2。
* **`40001–41200` 自本条记录起 retire**，不得再用于修改后的 Phase 2 模型。
