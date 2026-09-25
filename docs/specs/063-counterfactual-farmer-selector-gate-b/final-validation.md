# Phase 2 v1 — FINAL VALIDATION

状态：**PHASE 2 v1 — FINAL KEEP**。
日期：2026-09-21
前置：Gate A PASS · Gate B-A designed PASS · Gate B-S shipped PASS · Gate B-S2 runtime PASS。

`10001–10400` 是本研究自始至终保留、从未用于 hypothesis generation、calibration、
training、threshold selection、discovery 或 debugging 的 pool。**本轮是它唯一一次正式
使用，用毕永久 retire。**

## 1. Freeze（运行前核验，全部通过）

| | |
| --- | --- |
| HEAD | `4173d323ee48f70f050aa8b8be2c4354bd26f145`（= 通过 Gate B-S2 的同一 candidate） |
| worktree | clean |
| model SHA-256 | `010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359` |
| schema hash | `0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0` |
| threshold | 恰为 `0.01`（由冻结产物读出） |
| corpus checksum | `75618f65383be903cee0456538a16bd83c525e263ea9452bcebaeddd28332748` |
| worker bundle | 540,606 B raw / 122,713 B gzip（budget 123,575 B） |
| **pool 完整性** | 扫描 `.local/` 下 **425** 个 json 产物，**没有任何窗口与 10001–10400 重叠**；该区间完全落在 Phase 2 universe（50001–70000）之外，不属于任何 split |

冻结项一个未动：model / schema / threshold / selector semantics / tie-break /
candidate set / production master / rollout / prior / teammate-opponent policy /
Worker integration。

**配置**：真实 shipped strength configuration —— production handler、frozen Phase 2
integration、真实 120 ms master deadline、shipped fallback、**jobs = 1**。
两臂各自在 `10001–10400` 上重跑 400 副，未复用任何历史结果。

## 2. Final primary

| 臂 | baseline | challenger | **PAIRED Δ** | 95% CI |
| --- | ---: | ---: | ---: | --- |
| arm A（strong 当地主） | 49.3% | 49.3% | **+0.000%** | [+0.000%, +0.000%] |
| arm B（strong 当农民） | 57.8% | 68.4% | **+10.583%** | [+8.500%, +12.833%] |
| **combined** | 53.6% | 58.9% | **+5.292%** | **[+4.250%, +6.417%]** |

逐副转移：**better 124 / worse 20 / tie 256**。swing `−1:20  0:256  +1:102  +2:21  +3:1`。

**arm A 在 400 副上逐副完全相同**（paired Δ 0.000%），比 discovery 轮的 1/1200 更干净。

| FINAL KEEP criterion | 实际 | |
| --- | --- | --- |
| `combined Δ > 0` | +5.292% | ✅ |
| combined paired 95% CI lower > 0 | +4.250% | ✅ |
| `combined point estimate >= +1.0pp` | +5.292pp | ✅ |
| selector activation scope 正确 | 见 §3 | ✅ |
| no integrity failure | 见 §1 / §4 | ✅ |
| product / runtime gates 仍绿 | 见 §5 | ✅ |

## 3. Activation scope（直接验证，不是推断）

在 final pool 上把 overlay **装在地主自己的座位上**跑 24 场 arm-A：

```
arm-A games 24   overlay decisions on the landlord: 0
arm-B strong-farmer decisions 314   overrides 73
```

地主 **0 次激活**，同一批牌上农民座位 314 次决策产生 73 次 override —— 既证明 scope
正确，也证明 overlay 在这一轮确实是活的（非空洞）。

## 4. Discovery → final replication

| 运行 | farmer Δ | combined Δ |
| --- | ---: | ---: |
| Gate B-A designed discovery（40001–41200） | +10.917pp | +5.4583pp |
| Gate B-S shipped discovery（40001–41200） | +10.917pp | +5.4722pp |
| **FINAL validation（10001–10400，untouched）** | **+10.583pp** | **+5.2917pp** |

shipped discovery → final：combined **−0.1806pp**，farmer **−0.333pp**，
即 **保留 96.7%**。方向一致、没有有意义的 shrinkage、没有衰减趋势。
（KEEP 判据仍只是预登记的 `combined ≥ +1pp` 且 `CI lower > 0`，不是「必须复制 +5.47pp」。）

## 5. Runtime sanity（final run 之后）

| | |
| --- | --- |
| baseline deadline cutoff | 393 / 25,818 = **1.5%** |
| challenger deadline cutoff | 291 / 26,275 = **1.1%** |
| baseline master latency | p50 33.1 / p95 101.6 / p99 128.9 / max 153.0 ms |
| challenger master latency | p50 33.1 / p95 104.5 / p99 136.3 / max 168.9 ms |
| `pnpm check` | ✅ exit 0（含 Chromium 33 项、Android、boundaries、privacy、bundle budget） |
| 冻结产物复验 | ✅ 全部 OK |
| HEAD 与 B-S2 candidate 相同 | ✅ `4173d32`，因此 Gate B-S2 的 Worker 往返证据直接适用，未重跑 |

## 6. Decision

```
PHASE 2 v1 — FINAL KEEP
```

**owner 批准（2026-09-21）。** 冻结状态自此为 production KEEP，全部参数不变：
model artifact、threshold `0.01`、feature schema 与 schema hash、activation scope
（identity + role）、fallback 语义。

### 保留的 provenance

| 产物 | 位置 |
| --- | --- |
| model artifact（源） | `.local/cf-rows/model.txt`，sha256 `010a8a4a…82fc3359` |
| model 转写脚本 | `scripts/cf-export-model.py` |
| packaged model | `src/app/ai/cf-model-data.ts`（生成物） |
| training corpus manifest + checksum | `.local/cf-corpus/manifest.json`，`75618f65…32748` |
| calibration 协议与产物 | `docs/specs/062-…/experiment.md`、`.local/cf-rows/threshold.json` |
| Gate A 报告 | `docs/specs/062-…/experiment.md` |
| Gate B-A / B-S | `docs/specs/063-…/experiment.md`、`shipped.md` |
| Gate B-S2 runtime | `docs/specs/063-…/shipped-delivery.md` |
| final validation | 本文档 |
| experiment registry | `docs/research/ai-experiment-results.md` |

## 7. KEEP 后的处置

* `10001–10400` **permanent retired / final validation consumed**，不得再作为
  discovery、calibration 或任何后续机制的判据来源。
* frozen Phase 2 selector 标记为 **production KEEP**。
* 保留全部 provenance：model 转写脚本与 SHA、corpus manifest 与 checksum、
  calibration 协议与 threshold 产物、Gate A 报告、Gate B-A / B-S / B-S2 报告、
  final validation 结果。
* **未**自动启动 Phase 2 v2 / π2。
* 产品资产预算变更 **已获 owner 批准**（2026-09-21）：`check-bundle.mjs` 的 worker
  gzip budget 由 9,217 B → **123,575 B**。记录见
  [shipped-delivery.md](shipped-delivery.md) §1；**若未来整体 revert Phase 2，
  limit 恢复 9,217 B**。
