# Spec 063：Phase 2 / Gate B v1 — 整局策略验证（预登记）

状态：**预登记冻结**。所有阈值、臂、判据、池在**看到任何 Gate B 结果之前**写死。
日期：2026-09-20
前置：Spec 062（Gate A）已 **PASS**；冻结产物见
[062/experiment.md](../062-counterfactual-policy-improvement/experiment.md)。

## 1. 唯一目标

> 检验冻结的 counterfactual farmer selector 在整局中**反复启用**后，是否真正提高高手 AI
> 的完整对局胜率。

Gate A 证明的是「改变一手 → 后续恢复 π0」下的单步反事实收益。Gate B 测的是
`π1 = 整局中每次符合条件且被测 agent 当前是农民时，允许 frozen selector override`。

因此会产生 distribution shift、连续多次 override、以及后续局面离开训练分布。

**Gate A 的 `+2.0083%` 不得外推成整局胜率。** 禁止 `2% × 每局决策数` 之类换算。
Gate B 只看真实完整对局。

## 2. 冻结产物（不得重新训练 / 重新 calibration）

| 项 | 值 |
| --- | --- |
| model artifact | `sha256 010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359` |
| runtime table | `scripts/cf-export-model.py` 从该 artifact 转写，`modelSha256` 字段记录同一 checksum |
| schema hash | `0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0` |
| threshold | **恰为 `0.01`**，由冻结产物 `threshold.json` 读出，**不得在代码里重打** |
| selector | `cfChooseOverride` 语义（严格 `>`，tie 取 production 候选序） |
| Gate A pipeline commit | `4e20be3` |
| Gate A production baseline | `ea67aa3` |

**不得**用同配置重新拟合的模型代替 artifact；**不得**用 calibration / held-out 重新拟合。

## 3. Runtime 架构

```
legal player-visible state
        ↓
production master（完全不变）→ production a0 + 原始有序 top3
        ↓
if 没有非 a0 候选:  return a0
        ↓
frozen Option-C feature（复用 Gate A schema）
        ↓
frozen GBDT inference（TS tree table）
        ↓
a* = 最高分的非 a0 候选（tie → production 候选序）
        ↓
if score(a*) > 0.01:  return a*
else:                 return a0
```

**GBDT score 不得加回 expertScore。** expertScore 仍只负责 candidate proposal。
模型拥有真正 override authority。

## 4. Activation scope（必须严格）

selector 只允许作用于：**benchmark 中被测的 challenger agent，且该 agent 当前角色是农民**。

实现：challenger 只**装饰一个座位的 strategy**（identity 由构造绑定，不可能漏掉），
wrapper 内再检查 `view.seat === options.seat && view.seat !== view.landlord`（role）。

**禁止**全局 `if (current player is farmer)`：那会同时改变两个农民，地主臂不再 invariant。

## 5. Landlord invariant（硬门禁）

被测 challenger 是 landlord 时 selector **绝不启用**。要求 baseline vs challenger：

* command stream 逐位相同
* decision count 相同
* candidate sequence 相同
* game result 相同

在一批 deterministic designed games 上 **`0 divergence`**。任何 divergence 判 **INVALID**，
先修实现，不得进入正式 Gate B。

## 6. Runtime model implementation

产品 runtime 不依赖 Python / SciPy / LightGBM Python runtime。frozen artifact 由
`scripts/cf-export-model.py` 转写成扁平 node 数组（`model.json`），由
`benchmarks/cf-model.ts` 确定性遍历。**转写不改变模型**：traversal 复刻 LightGBM 语义
（NaN → `default_left`；`missing_type == "Zero"` 时 0 也算缺失；比较是 `<=` 不是 `<`）。

### Reference equivalence（门禁）

对 Gate A calibration 的 21,066 个 candidate rows：

* 数值预测：`max |runtime − reference|` 必须 < 1e-9（实测 **0**）
* `argmax divergence` = **0**
* `override-decision divergence`（全部六个阈值）= **0**
* `selected-label divergence` = **0**
* 单独报告 `|score − 0.01| < 1e-6` 的样本数

## 7. Runtime information boundary

runtime feature builder 复用 Gate A frozen schema，只接受合法 player-visible 信息。
不得因为 runtime 拿得到完整 `GameState` 就把隐藏信息带入 feature。

守卫（`tests/core/cf-challenger.test.ts` + `cf-dataset-guards.test.ts`）：改变 landlord /
teammate 隐藏手牌而保持合法 observation 不变时，runtime features 与 selector command
必须相同。

## 8. Gate B discovery pool

| 范围 | 身份 |
| --- | --- |
| **40001–41200**（1,200 deals） | **Phase 2 Gate B Discovery V4**，本轮唯一使用 |

* `40001–40400` 曾被计划用于已取消的 H6，但 **H6 从未正式运行，exposure = 0**。
  整个 `40001–41200` 在本实验前确认未被任何正式 strength A/B 使用。
* 记录 **`Gate B V4 exposure 0 → 1`**。
* Gate B 结果一旦被看到，**整个 `40001–41200` retire**，不得再用于修改后的 Phase 2 模型。
* Final validation `10001–10400` 继续 **untouched**。

## 9. 为什么是 1,200 deals

Gate B 是 Phase 2 架构的关键整局验证。不希望再得到「点估计接近 1pp 但区间太宽，
于是再决定是否扩样」。因此**一次性预登记 1,200 deals**。

**不做中途查看**：不在 400、800 时 peek。只有全部 1,200 完成后才看结果。

## 10. Gate B-A 协议

第一轮只跑 **designed / deterministic / no deadline**。不同时测试 shipped deadline。
两臂重跑相同 1,200 deals。允许 deal-level multiprocessing；jobs 只改变 wall time。

## 11. Baseline arm

current production master，完全不含 Phase 2 selector。

## 12. Challenger arm

只有被测 agent 当 farmer 时启用 frozen selector。其他一切完全 baseline：candidate
generation、production master、`defaultPolicyPrior`、worlds、rollout depth、root utility、
sampling、teammate policy、opponent policy、bidding、game rules。

## 13. 臂语义

沿用仓库既有 benchmark 语义（`armSchedule`）：每副 3 局 strong-as-landlord（arm A）
+ 3 局 strong-as-farmer（arm B）。

* **arm A**：baseline vs challenger 必须**严格恒等**，`Δ = 0`（implementation invariant）。
* **arm B**：challenger 启用 selector，测真实整局效果。
* **combined**：沿用仓库既有 50/50 landlord/farmer 加权（每副 6 局）。

因为 arm A 恒 0，应满足 `combined Δ = farmer Δ / 2`（允许浮点舍入差）。
**若 arm A 非零 → INVALID**，不得解释为棋力。

## 14. Primary endpoint

产品 primary = **combined paired full-game Δ**。不是 Gate A `mu`、不是 override precision、
不是 farmer subgroup、不是 model RMSE。

统计实现**继续使用仓库已有 paired deal-level 方法**（`benchmarks/paired-compare.test.ts`
的 per-deal difference + `clusterInterval` deal-clustered bootstrap，seed `20260919`）。
**不得**把 games / decisions 当独立样本。

必须报告：landlord baseline/challenger、farmer baseline/challenger、farmer paired Δ 与其
95% CI、combined paired Δ 与其 95% CI、good / bad / equal deal transitions。

## 15. Gate B-A continuation criterion

必须**同时**满足：

1. `combined Δ > 0`
2. combined paired **95% CI lower > 0**
3. `combined point estimate >= +1.0pp`
4. landlord invariant exact（arm A 逐副 0 差异）
5. no integrity failure

才判 **GATE B-A PASS**，之后才允许进入 shipped validation。

由于 arm A = 0，这通常等价于 farmer point estimate `>= +2.0pp`，
但**正式判定仍使用 combined metric**。

## 16. 不通过

未满足上述任一条 → **Gate B v1 does not qualify for product continuation**。停止 v1。

**特别禁止事后**：threshold 0.02 / threshold 0 / per-seat threshold / stage-specific
threshold / min-hand filtering / 去掉表现差的 late-game bucket / 重新训练 / 增加 trees /
top5 / H5+GBDT / farmer seat 分模型。

以上都是新 hypothesis，且**不得继续使用已经暴露的 `40001–41200`**。

## 17. Diagnostics（primary 判定完成后才报告）

farmer decision count、selector eligible decisions、override decisions、override rate、
distinct deals with override、score distribution、threshold margin、candidate rank chosen
（production rank0 / rank1 / rank2）、game stage、两个 farmer relative seat、expert-gap
buckets、consecutive override counts per game。

这些**不得替代** full-game strength result。

## 18. 连续 override / distribution shift

每场 challenger game 统计 override 次数：0 / 1 / 2 / 3 / 4+。
Gate A 只训练「one intervention then π0」；若 Gate B 出现大量 `π1 → π1 → π1`，
这可能是 Gate A 与 Gate B 差异的解释。**只记录，不据此修改策略。**

## 19. Performance instrumentation

Designed strength test 与 shipped performance test **分开**。Gate B-A 不使用 deadline，
但记录纯模型成本：feature construction / tree inference / total selector overhead 的
p50 / p95 / max。

**不得**把 jobs>1 的聚合 wall time 当产品性能。真实性能测量未来必须 `jobs=1`。

## 20. 正式执行前门禁

必须全部通过：

* frozen model checksum
* schema hash
* runtime/reference **0 selector divergence**
* threshold exactly `0.01`
* landlord invariant **0 divergence**
* hidden-state runtime invariance
* candidate contract
* deterministic jobs invariant
* `pnpm check`
* production fallback behavior（selector 不启用时返回 production 原命令对象）

本 spec 提交后（preregistration commit），才允许运行 1,200-deal strength A/B。

## 21. 运行完成后立即停止

无论 PASS / FAIL：不跑 shipped、不使用 final validation、不改 threshold、不 retrain、
不创建 Phase 2 v2。先报告结果。

## 22. 产出

* 本 spec
* `benchmarks/cf-model.ts`、`benchmarks/cf-challenger.ts`、`benchmarks/cf-gate-b.test.ts`
* `scripts/cf-export-model.py`
* `tests/core/cf-challenger.test.ts`、`tests/support/cf-fixtures.ts`
* `docs/specs/063-counterfactual-farmer-selector-gate-b/experiment.md`（结果）
