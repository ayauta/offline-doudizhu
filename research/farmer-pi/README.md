> **ARCHIVE — 这条线已经结束，不再是 active research 入口。**
> 它产出的是 **AI-v1**（π1 农民），其结果已经并入现行的 **AI-v2**。
> 从这里开始读研究，请回到 [`../README.md`](../README.md)。
> 本目录中的 `protocol-v1.yaml`、`pool-ledger.jsonl`、`protocol-rehearsal.yaml`
> **仍被代码读取**，不要移动。

# Farmer Policy Iteration Factory v1

这一目录是 Factory 的**状态与事实来源**。代码在 `benchmarks/farmer-pi-*.ts` 与
`scripts/farmer-pi*.mjs`，不在这里；这里放的是**协议、账本、冠军档案与停止报告** ——
那些必须能被单独阅读、单独哈希、单独引用的东西。

## 这是什么

一条固定、可恢复、可无人值守运行的流水线：

```text
πn
→ candidate πn+1
→ 独立 promotion 判定
→ πn+1（PROMOTE）或同一 champion 的一次大样本 retry（REJECT）
```

一直运行到：连续两次失败 / 达到 10 次 attempt 上限 / integrity failure /
资源不可继续 / 人工终止。

**它不是一次实验。** 目标是同一个 improvement operator 一代一代地用同一个判据测下去，
看它究竟还能走多远。

## 目录

| 文件 | 是什么 |
| --- | --- |
| `protocol-v1.yaml` | 冻结协议。全部模型参数、split 规模、门槛、alpha、promotion floor、retry 规则、attempt 上限。**其字节的 SHA-256 就是 protocolHash** |
| `pool-ledger.jsonl` | 唯一事实来源。append-only 事件日志，pool 状态是事件的 fold |
| `champions/` | 不可变冠军档案。`ai-v1.json` 是 production；`ai-vN-research.json` 是研究冠军 |
| `attempts/` | 每次 attempt 的 manifest、journal、checkpoint、stage 输出与 verdict |
| `archive-night-lab.md` | Spec 064 / 065 的归档与 quarantined 记录 |
| `report-v1.md` | 停止后生成的最终报告（尚未生成） |

## 三条不能破的规则

1. **production 不动。** `ai-v1` 是 production champion，Factory 从不修改它，
   也从不把任何 research champion 变成 production。
2. **协议冻结。** Factory 运行期间不修改 protocol、runner 统计逻辑、feature 语义或训练配置。
   要改就停掉 Factory v1，另开 Factory v2。
3. **数据不回流。** 旧 continuation policy 的 label 不混训；calibration / offline /
   Stage1 / formal 永不回流 training；退休数据只用于 regression、工程测试与描述性参考。

## 术语

* **generation** —— 只有 PROMOTE 才 +1。π1、π2、π3。
* **attempt** —— 任何一次训练候选。base 与 retry 都算，上限 10。
  失败的候选**不叫** π3。
* **champion chain** —— `B → C3 → M1 → M2 → … → Mn`。
  master 每个 decision 只跑一次，ordered top3 每个 decision 只生成一次，
  所有层共享同一份 C3。

## 权威文档

* 协议与判据：[`protocol-v1.yaml`](protocol-v1.yaml)
* 池状态与历史 quarantine：[`pool-ledger.jsonl`](pool-ledger.jsonl)、[`archive-night-lab.md`](archive-night-lab.md)
* 历史种子账本（Factory 之前）：[`../../docs/research/ai-used-seed-ledger.md`](../../docs/research/ai-used-seed-ledger.md)
* production champion 的证据：[`../../docs/specs/063-counterfactual-farmer-selector-gate-b/final-validation.md`](../../docs/specs/063-counterfactual-farmer-selector-gate-b/final-validation.md)
