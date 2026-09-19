# Spec 058 实验记录（E3）

协议见 [spec.md](spec.md)。状态：**Step 1 重构已验证、preflight 已过、E3-A 尚未跑**。
日期：2026-09-19

## Step 1：评分出口重构，生产行为零变化

`scoreAction` 拆成一次性求值的 `evaluateAction`，同时产出 `baseScore`（不含先验）、
`prior`、`anchoredScore`（= 出货返回值）。两个排序由**同一批求值**生成，因此只可能
因先验而不同。`rankScoredPlayActions` 的返回值与重构前逐位一致。

一个必须尊重的细节：「一手走完」的捷径在加先验之前就 `return 1_000_000`，所以它
**不收先验**——base 与 anchored 都取 1_000_000，否则去锚定排序会把"能走完"排下去。

**行为冻结证明**（designed、seeds 301–700、400 副、带命令日志，与 E1-A 冻结的
baseline 逐位比对）：

| 配对 | 逐副数组 | 命令日志 |
| --- | --- | --- |
| `default vs casual` | 400 副全同 | **76,361 条逐位相同** |
| `master vs default` | 400 副全同 | **75,888 条逐位相同** |

**0 分歧。**

## Step 2：root-proposal preflight

语料：calibration seeds `5001–5400`、designed、8 路并行。只记 root 决策的
`legalActionCount / baseExpertScore / defaultPolicyPrior / anchoredScore /
anchored top3 / unanchored top3 / 两个第三候选`，不采叶、不跑胜负。

eligible 定义：`legalActions >= 3`。

| 指标 | 值 |
| --- | --- |
| root 决策 | 25,684 |
| eligible | **11,980（46.6%）** |
| **intervention count** | **4,859** |
| **intervention rate** | **40.6%（占 eligible）** |
| 重合率 | 59.4% |
| 地主位 | 2,720 / 6,044 = **45.0%** |
| 农民位 | 2,139 / 5,936 = **36.0%** |
| top3 重合分布 | 0/3: 1,045　1/3: 1,620　2/3: 3,211　3/3: 6,104 |

eligible 的 11,980 与 E1 语料独立测得的候选数直方图（46.64% 的决策有 3 个候选）
**逐数吻合**，两条采集路径互证。

**Gate：`intervention count = 4,859 ≠ 0` → PROCEED。** 按 Spec 058，这是唯一的停止
条件；不设比率阈值。

诊断（非判据）：去锚定提议在 **40.6%** 的 eligible 决策上真的替换了第三个候选，
且**地主位比农民位更容易被替换**（45.0% vs 36.0%）。这两个数字都只是干预的存在性
证据，不构成任何棋力预期。

## Step 3–5

尚未执行。E3-A 的 baseline 复用 `.local/e1a-base.json`。
