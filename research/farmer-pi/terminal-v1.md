# Farmer Policy Iteration Factory v1 — terminal record

状态：**归档记录**。本文只记录已经发生的事实与它们的出处，不改写任何科学结论，
不重新解释 REJECT 的理由，也不提出下一步。日期：2026-09-24 补记。

## 1. 为什么需要这份文档

Factory v1 的终局此前只存在于两处，都在 git 忽略的 `.local/` 下：

* 运行器的 stdout：`.local/farmer-pi-attempt-001.log:25816` —
  `[fpi] factory stopped: DOUBLE_REJECT`
* 控制面的一段折叠记录：`.local/farmer-pi/factory.json` 与
  `.local/farmer-pi/control/1707-register.json`

`pool-ledger.jsonl` 里**没有任何 STOP 事件**（52 行中事件类型只有
`NAMESPACE_RULE` / `QUARANTINE` / `RESERVE_NAMESPACE` / `ALLOCATE` / `TRANSITION`），
`research/farmer-pi/attempts/` 与 `research/farmer-pi/champions/` 都是空目录，
`README.md` 里提到的 `report-v1.md` 从未生成。
[`../..` 的 `docs/research/ai-experiment-results.md`] 也没有这一轮的条目。

换言之：**一次正式的、消耗了 attempt budget 的终止判定，其唯一记录随时可能被
`.local/` 的清理抹掉。** 本文把该判定按原样搬进受版本管理的归档，只做搬运。

## 2. 终局

```
结果            DOUBLE_REJECT
开始            2026-09-23T13:45:33.383Z   （= freeze commit 0d1d3da 的时间）
停止            2026-09-23T20:47:35.024Z
runner commit   0d1d3daa4ca95ca9ee67e13d9bbcafb06d012387
runner dirty    false
champion        ai-v1（未改动）
generation      1
```

两次 attempt，均为 `REJECT`，`stopReason` 字段为 `null`：`DOUBLE_REJECT` 不是被写下来的
字段，而是 `factoryStopReason()`（`benchmarks/farmer-pi-attempt.ts:330-338`）从
`base.outcome === "REJECT" && retries.length >= retryPerChampion && 每个 retry 都是 REJECT`
折叠出来的。

| attempt | kind | parent | outcome | stage | detail |
| --- | --- | --- | --- | --- | --- |
| `attempt-001` | base | `ai-v1` | `REJECT` | `calibrate` | `calibration-no-go: no threshold cleared the support floors and the lower bound` |
| `attempt-002` | retry | `ai-v1` | `REJECT` | `calibrate` | 同上，逐字相同 |

出处：
`.local/farmer-pi/control/0894-decide.log:1-2` 与 `:1700-decide.log:1-2`；
运行器侧的对应行在 `.local/farmer-pi-attempt-001.log:10955` 与 `:25814`。

两次 attempt 的 `attempt.json` 都停在 `"phase": "DECIDED"`、`"threshold": null`、
`"stage1": null`、`"formalPlan": null`、`"formalN": null`，
`corpusDone` 到 `offline` 为止。**没有进入 Stage 1，也没有进入 formal。**

## 3. calibration 停在门槛之下的原始数值

```
attempt-001  calibration-no-go  groups 2000  snapshots 6000  eligible 3  roots 6000
attempt-002  calibration-no-go  groups 4000  snapshots 12000 eligible 4  roots 12000
```

出处：`.local/farmer-pi/control/0891-calibrate.log`、`:1697-calibrate.log`。

理由串本身来自 `benchmarks/cf-selector.ts:191` 的 `reason: "selected" | "calibration-no-go"`
与 `:211,:229` 的读者侧文本。

## 4. 两次候选模型的摘要（不是 champion）

```
attempt-001  modelSha256 3c8a1284c89e1e448ddd40897ce84c8dbeff6b3212df50f228462ee2968504fd  412856 B
attempt-002  modelSha256 67e948c3e0b1b4e09ff433535f8cd4e5d7efc656a2507e61d8bb8720d5810c19  466715 B
```

出处：`.local/farmer-pi/attempts/attempt-001/attempt.json`、`attempt-002/attempt.json`。

两者都是被 REJECT 的候选，不是 champion，`research/farmer-pi/champions/` 里没有它们的档案，
`ai-v2-research` 从未存在。

## 5. pool 与 ledger

本次运行在 `factory-v1-namespace`（`200001–450000`，seq 1 的 `NAMESPACE_RULE` +
seq 16 的 `RESERVE_NAMESPACE`）内分配了十个 pool，**全部 `CONSUMED`**：

```
factory-v1/attempt-001/{train 200001-206000, calibration 206001-208000, offline 208001-210000,
                       stage1 210001-210200, formal 210201-215000}
factory-v1/attempt-002/{train-fresh 225001-231000, calibration 231001-235000, offline 235001-239000,
                       stage1 239001-239200, formal 239201-244000}
```

`stage1` 与 `formal` 四个 pool 被 `ALLOCATE` 之后又被 `CONSUMED`，**一副牌都没有发过**。

协议封印：`protocol-v1.sha256` =
`45aa9ee46b5865c030cb7e9221542c86f06c1b7223b4cbea89d8e8f22f1a4018  protocol-v1.yaml`（8900 B，
本次已重算，逐字相符）。每个 `ALLOCATE` 事件都带这个 `protocolHash`。

`pool-ledger.jsonl` 自身**没有校验和、没有封条**。`stage0-status.md:419` 里记的
`0d32a1d0…`（7237 B）对应的是运行前的 16 行版本，本次运行前 ledger 才 16 行；
运行后它是 52 行、16121 B。那条记录不是 ledger 的封条，它只是当时的快照。

## 6. 运行期间发现、当时被吞掉的记账 bug

```
2026-09-23T20:47:19.963Z
[fpi] ledger: factory-v1/attempt-001/train -> REVEALED did not land
      (control "ledger" failed (exit 1))
LedgerError: Pool factory-v1/attempt-001/train is CONSUMED and cannot return to
             REVEALED. A closed pool is closed.
```

出处：`.local/farmer-pi-attempt-001.log:25808`、`.local/farmer-pi/control/1692-ledger.log:8-13`。

性质：**benign bookkeeping bug**。retry 会继承 parent 的 train pool，而它的代码路径
（`scripts/farmer-pi.mjs` 的 `stepTrain` 组装 `sources` 时把 parent 的 train 目录 `unshift` 进去）
会顺手把那个已经 `CONSUMED` 的 pool 再写回 `REVEALED`。
`benchmarks/farmer-pi-pools.ts:558-562` 的「closed pool is closed」守卫正确地拒绝了它，
`movePool` 又刻意是 best-effort 的（`scripts/farmer-pi.mjs:514-527`），
所以它只被报告、没有中断运行。**ledger 未被污染**：seq 30 之后
`factory-v1/attempt-001/train` 没有新的 `REVEALED`。

## 7. 未触发的已知缺口

`championChainById`（`benchmarks/farmer-pi-workers.ts:190-201`）只认 `ai-v1`。
本轮没有发生 PROMOTE，`championId` 始终是 `ai-v1`，所以缺口**没有触发**，
`research/farmer-pi/champions/` 至今为空，`ai-v1` 仍然只从
`src/app/ai/cf-model-data.ts` 读取。

## 8. 生产与研究基线未受影响

```
生产 champion        ai-v1（= π1）
模型摘要             010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359
选取阈值             0.01（恰为 0.01）
feature schema       version 2，sha256 0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0，86 列
```

`src/` 在本轮 Factory 中零改动；两次 REJECT 的候选模型只存在于 `.local/`，
从未进入 `src/app/ai/cf-model-data.ts`。

## 9. 这份文档没有做的事

* 没有重新论证 REJECT 是否正确；
* 没有把 rehearsal 的 `REHEARSAL_CALIBRATION_NO_GO`
  （`stage0-status.md:236,362,365`）与本轮的两次真实 REJECT 混为一谈——两者是不同运行；
* 没有修改任何 pool 状态、ledger 行、协议文件或模型档案；
* 没有提出第三次 attempt、放宽 calibration gate、或换 seed 重试的方案。

`research/farmer-pi/README.md` 与 `stage0-status.md` 中若干处仍写着「fresh pool 尚未分配」
「STAGE 0 COMPLETE」，与本文不一致；本文不修改它们，只在此指出。
