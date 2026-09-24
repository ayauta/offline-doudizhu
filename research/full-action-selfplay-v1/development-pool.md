# Full-action self-play v1 — development seed pools

状态：**development-only 预登记**。本文不是正式 KEEP/REVERT 的池登记，
不触碰旧 Factory 的 `pool-ledger.jsonl`，也不改变它的任何一行。

## 为什么需要一份新的登记

`docs/research/ai-used-seed-ledger.md` §4 的规则是：
退休池**可以**继续做诊断、机制归因与 regression，但**新机制的考试必须换卷子**。
本线的 feasibility 阶段已经消耗了 `5001–5400`（机械 prototype 区间）。

powered development diagnostic 需要一个**与 prototype 训练 group 严格分离**的区间，
而该区间**不是**任何正式 pool：它的全部用途是诊断，它永远不会出现在
KEEP / REVERT 判定里，也永远不会与任何正式 pool 合并。

已退休且尚未被本线使用、又足以支撑 6000 组的区间并不存在
（`301–700`、`20001–20400`、`30001–30400`、`40001–41200` 合计 2400 组）。
因此这里**显式声明一个新的 development 区间**，并在同一份文档里写清它的身份与边界。

## 声明

| 范围 | 身份 | 规模 | 用途 | 暴露 |
| --- | --- | ---: | --- | --- |
| **`900001–920000`** | **FAS v1 development pool** | 预留 20,000，本阶段使用 `900001–906000`（6,000） | powered development diagnostic、动作族覆盖统计、runtime 测量 | **0 → 1** |

规则：

1. 该区间**只服务 `research/full-action-selfplay-v1` 的 development 活动**。
2. 它**不是**正式 pool。任何 KEEP / REVERT 判定都不得用它。
3. 它可以被本线重复使用于**诊断**，但一旦某个数字被用来决定
   "要不要启动正式 run"，那个数字就变成 selection-on-discovery —— 因此
   **正式 run 必须使用另一个尚未分配的新 pool**，这一点写在 freeze draft 的 §12。
4. 它与任何已登记区间**零重叠**：历史最大 deal index 为 160000
   （Spec 065 dataset 的上界，2026-09-22 退休），
   旧 Factory 的 namespace 是 `200001–450000`。`900001` 在其上，且不在任何 namespace 内。
5. runtime 测量使用 `900001–900300`（300 组），与 diagnostic 的 root 选取
   共享同一区间但**不共享任何统计量**：runtime 只看墙钟，diagnostic 只看胜负。

## 与旧 ledger 的关系

**不写入旧 ledger。** 旧 Factory 已终局（见 `../../farmer-pi/terminal-v1.md`），
它的 ledger 是那份终局记录的一部分，不是本线的登记簿。
本线的池登记以本文档为准；若将来本线需要正式 pool，
应当在**新的一次预登记**里声明，而不是往旧 ledger 追加。

## 边界说明

这份声明的强度与旧 ledger 的 `NAMESPACE_RULE` 相同，不多不少：
它证明的是「本线声明自己会用哪些数字」，不是「这些数字从未以任何形式出现过」。
它不覆盖 `.local/` 之外的位置，也不是对全部产物的语义解析。
