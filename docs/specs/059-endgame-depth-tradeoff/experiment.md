# Spec 059 实验记录（H4）

协议见 [spec.md](spec.md)。状态：**E4-A 已跑，判定 REVERT；E4-B 未跑**。
日期：2026-09-19

## 前置测量的结论（实现之前）

- 门槛：按**采集前冻结**的规则在 calibration 上选 K → **`rootMinHand <= 2`**
  （9,247 个决策 = 36%，覆盖 96.2% 的终局叶）。
- 结构：按**选择前冻结**的规则比较 `{4×6, 6×4}` 的 terminal trajectory rate →
  **`4×6`**（eligible roots 上 8×3 = 30.7%、4×6 = 50.7%、6×4 = 38.7%）。
- Preflight：30.7% → 50.7%，terminal-information rate 有提高 → 不 STOP。

**限制（写死在登记里，事后不得改写）**：这只证明 4×6 更有效地产生 H4 想要的终局
信息，**不证明它搜索更强**。

## E4-A（designed，Discovery V2 `20001–20400`，400 副，两臂各跑一遍）

| 臂 | baseline | challenger | **配对 Δ** | 95% CI |
| --- | --- | --- | --- | --- |
| 强方当地主 | 50.1% | 50.3% | +0.250pp | [−0.417pp, +0.917pp] |
| 强方当农民 | 54.5% | 55.0% | +0.500pp | [−0.417pp, +1.417pp] |
| **合并（primary）** | 52.3% | 52.7% | **+0.375pp** | **[−0.167pp, +0.918pp]** |

逐副转移：challenger **好 26 / 差 18 / 平 356**；swing 直方图 `−1:18  0:356  +1:25  +2:1`。

对照 `default vs casual`：逐副完全相同、**0/76,304 条命令分歧**——改动只落在高手档。

出招分歧 89.6%，首次在第 **#36** 条命令（baseline 出 `[38]`、challenger 出 `[41]`），
之后是级联。

### Mechanism diagnostics

| 项 | 值 |
| --- | --- |
| eligible root 决策 | 9,247 / 25,684 = 36.0%（calibration 上测得；本试验用同一门槛） |
| eligible 局面的结构 | baseline `8×3` → challenger `4×6`（24 world-plies 不变） |
| terminal trajectory rate（calibration，eligible） | 30.7% → **50.7%** |
| 有终局 trajectory 的 eligible 决策（calibration） | 53.4% → **74.8%** |
| 跑满深度的 trajectory（calibration） | 69.3% → 49.3% |
| wall-clock（designed，仅成本诊断） | baseline 242s、challenger 246s（jobs=8） |

## REVERT

```
Decision: REVERT
Reason: positive but below preregistered practical-effect threshold;
        the 95% CI does not exclude zero.
```

| 条件 | 实际 | |
| --- | --- | --- |
| 配对 Δ > 0 | +0.375pp | ✅ |
| 95% CI 下界 > 0 | **−0.167pp** | ❌ |
| Δ ≥ SESOI 1.0pp | +0.375pp | ❌ |

按 Spec 059 的停止规则**关闭 H4**。结论限定为：

> 在 `rootMinHand <= 2` 的局面里把结构预算从广度转向深度，没有达到预登记的
> 棋力收益标准。

**不得**扩大成「深度无用」或「残局不重要」。`6×4`、`minHand <= 3`、`2×12`、更大
depth、更高 rollout weight 一律按新假设、新实验编号、新 spec 处理。

回滚：`rankMasterPlayActions` 恢复「调用方结构直通」（`src/` 零改动）。
E4 专属的门禁测试随回滚撤掉（它钉的正是被回滚的定义，可从本实验 commit 精确恢复）。

## 三次机制实验并看

| | 干预量 | 结果改变 | 配对 Δ | 95% CI |
| --- | --- | --- | --- | --- |
| E1 叶值更准 | 66.3% 叶值变 / 0.7% 出招变 | 33/400 副 | +0.458pp | [−0.000, +0.917] |
| E3 候选来源 | 40.6% eligible 决策换候选 | 5/400 副 | +0.125pp | [−0.042, +0.333] |
| **E4 残局深度** | **terminal rate 30.7%→50.7%** | **44/400 副** | **+0.375pp** | **[−0.167, +0.918]** |

E4 是三者中**唯一真正改变了搜索信息量**的一次（终局信息率提高 20 个百分点，
有终局的决策从 53% 升到 75%），也是改动牌局结果最多的一次（44 副）。三者都朝正向，
三者都没到 SESOI。

这是**观察**，不是结论。三次的点估计都是正的，三次的区间都包含 0；把这三条并排
放在一起能读出什么、下一次该用什么样本量，本文不作推断——样本量与分辨率只能在
事先登记的协议里定，不能事后由已有结果反推。
