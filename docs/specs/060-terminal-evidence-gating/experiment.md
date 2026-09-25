# Spec 060 实验记录（H5 v1 / E5）

协议见 [spec.md](spec.md)，机制冻结见
[H5 诊断与冻结](../../research/h5-terminal-evidence.md)。状态：**实现门禁已通过；
E5-A 已跑，判定 REVERT；E5-B 未跑**。
日期：2026-09-19

## 实现门禁（先于 E5-A）

载体两个，都是本实验的一部分：

- [`tests/core/terminal-evidence-gate.test.ts`](../../../tests/core/terminal-evidence-gate.test.ts)
  —— 11 项，进 `pnpm check`。冻结评分形式的代数契约、confidence gate 的阵营符号穷举、
  以及真实残局局面上的非空洞断言。
- [`benchmarks/h5-gate.test.ts`](../../../benchmarks/h5-gate.test.ts)
  —— corpus 腿（calibration `5001–5400` 的 25,684 个真实决策，含每条轨迹的胜者）与
  出货路径 dump 恒等腿。

| 门禁 | 证据 | 结果 |
| --- | --- | --- |
| **恒等（公式）** | corpus 53,688 个候选在 `W_gate = 0.2` 下与生产**逐位**相同；25,684 个 decision 的 ordering 0 个不同 | ✅ |
| **恒等（出货路径）** | 同一 50 副 designed 窗口、production build 与 `W_gate = 0.2` build：**0 / 9,660 条命令分歧**，逐副胜负数组完全相同 | ✅ |
| 恒等**非空洞** | 同窗口 `W_gate = 1.0`：从第 **#54** 条命令起分歧，**2 / 50** 副结果改变 → gate 确实会在这批局面上触发 | ✅ |
| **0 terminal** | corpus 45,979 个候选逐位等于生产；单元层另测无终局证据 | ✅ |
| **conflicting** | corpus 410 个 conflicting 候选逐位等于生产；单元层覆盖"终局效用**不抵消**的 conflicting"（2 胜 1 负） | ✅ |
| **unanimous win / loss** | corpus 3,711 win + 3,588 loss：符号正确、增量 `= (1 − 0.2) × terminalTotal / worlds`、且正好等于该候选终局轨迹条数的整数倍（≤ worlds） | ✅ |
| **non-terminal 不放大** | 单元层：只改 non-terminal total 不改变增量；corpus 层：增量不含任何 non-terminal 项 | ✅ |
| **阵营符号** | 3 root seat × 3 landlord × 3 winner 穷举；农民 root 的具体反例；corpus 上 25,684 个决策逐条与独立推出的 ground truth 一致 | ✅ |
| corpus replay fidelity | 用存档叶子重放生产排序，25,684 个决策**0 个**偏离记录下来的 `chosen` —— 上面所有 corpus 结论的前提 | ✅ |

### 变异测试（证明门禁不是摆设）

逐个把回归注入实现，看门禁是否变红。**单元层 + corpus 层**（`M1`–`M7`）与
**出货路径层**（`M8`–`M9`）：

| 变异 | 单元层 | corpus 层 | 出货路径层 |
| --- | --- | --- | --- |
| M1 改成 component-wise `W×T + 0.2×N` | 🔴 | 🔴 | — |
| M2 阵营符号反转 | 🔴 | 🔴 | — |
| M3 分母改成 terminalCount | 🔴 | 🔴 | — |
| M4 连 non-terminal 一起放大 | 🔴 | 🔴 | — |
| M5 无条件开门（去掉 verdict 检查） | 🔴¹ | 🔴 | — |
| M6 gate 永不触发 | 🔴（非空洞断言） | 🔴 | — |
| M7 要求 `terminalCount >= 2` | 🔴 | 🔴 | — |
| M8 接线错误：终局证据记到候选 0 | 🔴² | 🟢³ | 🔴⁴ |
| M9 权重常量漂移 `0.2 → 0.3` | 🔴 | 🔴 | 🔴⁵ |

¹ 首轮**漏掉**：当时的 conflicting 用例 `terminalTotal` 恰好为 0，改不动分数。补上
"冲突但终局效用不抵消"的用例后变红——这正是变异测试要找的洞。
² delta 对应 10 条终局轨迹 > 8 个 world，越界断言抓住。
³ corpus 腿自己从存档叶子重建聚合，结构上看不到循环接线；这不是缺口，而是**分层**——
公式契约由 corpus 层钉，出货路径由 dump 层钉。
⁴ 与干净 challenger 对比：8,327 / 9,723 条命令分歧、7 / 50 副结果改变。
⁵ 与存档的 production dump 对比：逐副胜负数组不同。

**一次失败的"隔离"尝试（记录在案）**：曾想用一个"只有出货路径层能抓"的变异来证明该腿
的独立价值——把 `(x / N) * 0.2` 重结合为 `(x * 0.2) / N`。结果那次运行与干净 challenger
**逐位相同**，因为 `completedWorlds` 恒为 8、而 8 是 2 的幂，这个重结合是精确等价的：
**变异根本没发生**。改用 M8 的接线变异才真正隔离出该腿的作用。

## E5-A（designed，Discovery V3 `30001–30400`，400 副，两臂各跑一遍）

`AI_BENCH_PAIRS=default:master`、`AI_BENCH_DESIGNED=1`、jobs=8、`AI_BENCH_LOG_COMMANDS=1`。
baseline = 未改动的生产高手；challenger = H5 v1（`terminalGateWeight: 1`）。

| 臂 | baseline | challenger | **配对 Δ** | 95% CI |
| --- | --- | --- | --- | --- |
| 强方当地主 | 54.3% | 54.1% | −0.250pp | [−0.667pp, +0.167pp] |
| 强方当农民 | 49.8% | 51.2% | **+1.417pp** | [+0.667pp, +2.167pp] |
| **合并（primary）** | 52.1% | 52.7% | **+0.583pp** | **[+0.167pp, +1.042pp]** |

逐副转移：challenger **好 21 / 差 7 / 平 372**；swing 直方图 `−1:7  0:372  +1:21`。
出招分歧 68,820 / 76,088（90.4%），首次在第 **#139** 条命令（baseline 出 pass、
challenger 出 `[49]`），之后是级联。

### 门控诊断（`benchmarks/h5-diagnostics.test.ts` + 观测型插桩，同一 400 副窗口）

| 项 | 值 |
| --- | --- |
| master 出招决策 | 25,799（zero-world 决策 0） |
| **gate 触发的决策** | **5,112（19.8%）** |
| **gated candidate** | **7,388 / 53,861（13.7%）** |
| 逐候选 verdict 分布 | none 46,084；**win 3,464；loss 3,924**；conflicting 389 |
| gated terminal trajectory | 42,021 |
| 按 root 阵营（触发时） | 地主 2,684；农民 2,428 |
| **gate 会改变最终 action 的决策** | **182（0.7%）**（同一批 trajectory 上，生产混合 vs 门控混合） |
| wall-clock（designed，jobs=8，成本诊断） | baseline 235s；challenger 258s（8 个分片**全部**更慢，226–235s vs 246–258s，约 +9%） |

**插桩是惰性的（实测，不是论证）**：带插桩的 challenger 与干净 challenger 的
**0 / 76,433 条命令逐位相同**——上表描述的正是被报告的那次运行。

读法：机制**确实发生了**（近两成决策上有同向终局证据，7,388 个候选获得门控），
**且几乎不改变选择**（0.7% 的决策上换 action）。这与 calibration 上的 preflight 一致
（13.6% 候选、0.6% 决策），也是 90.4% 命令分歧里绝大多数属于级联的原因。
不对称在分角色上：农民位 +1.417pp（下界 +0.667）、地主位 −0.250pp（区间跨 0）。

## REVERT

```
Decision: REVERT
Reason: primary effect is positive and its interval excludes zero, but the point
        estimate is below the preregistered practical-effect threshold (SESOI).
```

| 条件 | 实际 | |
| --- | --- | --- |
| 配对 Δ > 0 | +0.583pp | ✅ |
| 95% CI 下界 > 0 | +0.167pp | ✅ |
| Δ ≥ SESOI 1.0pp | +0.583pp | ❌ |
| 复杂度 / 性能合理 | +9% designed wall-clock（分片系统性变慢）；未进入 E5-B 实测 | 未定 |

按 Spec 060 的判据**关闭 H5**。

### Primary conclusion

**`+0.583pp [ +0.167, +1.042 ]`** —— H5 v1 有**可靠的正向棋力信号**：这是本仓库
**第一个 primary 95% CI 明确排除 0** 的机制实验（E1/E3/E4 的区间都包含 0）。

但 **`+0.583pp < SESOI 1.0pp`**，代价是约 **+9%** 的 designed wall-clock 与一层新增机制，
因此按预登记 → **REVERT**。

两层读法都必须留下，**不得**互相顶替：

- **不得**因为 CI 上界（+1.042pp）越过 1.0pp 就改判 KEEP——判据是**点估计对 SESOI**，
  且是事先冻结的；
- **不得**读成「这个方向没用」或「终局证据没有信息」。诊断与 override 探针
  （[H5 文档](../../research/h5-terminal-evidence.md)）测的是「信号有没有信息」（为正），
  E5-A 测的是「按这个信号提高影响力有没有棋力收益」（未达标准）——两件事不矛盾。

结论限定为：

> 在 `maxWorlds=8 / rolloutDepth=3`、候选上限 3 的出货结构下，把**同向终局证据**的
> terminal component 从 `0.2` 恢复到 `1.0`，有正向信号（区间排除 0），但没有达到
> 预登记的棋力收益标准。

### Secondary diagnostic（只作 hypothesis-generating）

| root 阵营 | 配对 Δ | 95% CI |
| --- | --- | --- |
| 地主 | −0.250pp | [−0.667, +0.167] |
| 农民 | **+1.417pp** | [+0.667, +2.167] |

这是**很明显的角色异质性信号**，值得记下来——它可能指向「角色策略差异」这一层更深的
问题。但它现在**只能作为 hypothesis-generating observation**：

- 分角色子集是**事后**看的，不是预登记的检验；两个子集的区间与合并区间不属于同一族
  推断，不能当作「农民位已被证明有效」；
- **不得**把 H5 事后改写成「农民专项实验」，也不得据此就地重跑；
- 若今后要研究「terminal evidence gating 是否只对农民有价值」，必须作为**新的独立
  假设**：新 spec、**新 discovery pool**（不得再用 V3）、事先登记 role-specific
  mechanism 与它自己的判据。

**不得**事后尝试：改 `W_gate`；加 `terminalCount` 阈值；改成 terminal-only mean；
lexicographic terminal override；调 `defaultPolicyPrior`；加深搜索。
它们各自是新假设、新实验编号、新 discovery pool。

回滚：`src/` 三处改动（机制 + 出货接线 + barrel 导出）全部撤掉，`pnpm check` 全绿；
H5 专属门禁测试随回滚撤掉（它们钉的正是被回滚的定义），与插桩、诊断载体一并归档在
[`docs/research/h5-v1/`](../../research/h5-v1/README.md)，可 `git apply` 完整复跑。

## 四次机制实验并看

| | 干预量 | 结果改变 | 配对 Δ | 95% CI |
| --- | --- | --- | --- | --- |
| E1 叶值更准 | 66.3% 叶值变 / 0.7% 出招变 | 33/400 副 | +0.458pp | [−0.000, +0.917] |
| E3 候选来源 | 40.6% eligible 决策换候选 | 5/400 副 | +0.125pp | [−0.042, +0.333] |
| E4 残局深度 | terminal rate 30.7%→50.7% | 44/400 副 | +0.375pp | [−0.167, +0.918] |
| **E5 终局证据门控** | **19.8% 决策触发 / 0.7% 换 action** | **28/400 副** | **+0.583pp** | **[+0.167, +1.042]** |

E5 是四次里**唯一 95% CI 下界离开 0** 的一次，也是点估计最大的一次；四次都仍是正的、
三次包含 0。E5 因此把「这些机制全都是噪声」这个读法排除掉了：这次的方向是**有相当
明确的正向信号**，只是增益 `+0.583pp` 还不值得承担当前复杂度和约 +9% 的实验成本。

这是**观察**，不是结论：把四条并排读能得出什么、下一条机制该怎么做，本文不作推断——
样本量与分辨率只能在事先登记的协议里定，不能事后由已有结果反推。

