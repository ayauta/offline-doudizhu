# Spec 063 实验记录（Gate B-S：shipped / deadline 验证）

协议见 [spec.md](spec.md)。状态：**GATE B-S PASS**。
日期：2026-09-20
前置：Gate B-A designed PASS（[experiment.md](experiment.md)）。

## 0. 本轮做了什么、没做什么（先说清楚）

**做了**：把 frozen selector 作为 **post-decision overlay 装进真实出货的
`decideEnhancedAi`**（`src/app/ai/decision-handler.ts`），因此 Gate B-S 的每一次决策都经过
真的 master 搜索、真的 120 ms deadline、真的 deadline fallback、以及真的 try/catch。

**没做**：**没有把 0.48 MiB 的模型表打进 worker 资产**，因此 §16 要求的
「frozen model loading in the real runtime」**不成立**。把模型送进出货 Worker 属于
ADR 0018 管辖的交付改动（bundle、precache、worker 资产），在 final validation 之前做是
顺序颠倒。**Worker 初始化与 fallback 路径**由既有 Chromium 验收覆盖；**artifact 交付未覆盖**。

集成方式（`src/app/ai/decision-handler.ts`，约 30 行）：

```ts
export type PlayDecisionOverlay = (context, productionCommand) => GameCommand;
export type AiDecisionRuntime = { deadline; now; overlay?: PlayDecisionOverlay };
```

overlay 是 **runtime** 的一部分（和时钟并列），出货 Worker 的 runtime 只有时钟，
所以**production 行为按构造不变**。overlay 抛错 → 返回 production 命令，永不阻塞合法出牌。

## 1. Repository / Integrity

| | |
| --- | --- |
| HEAD | `c0fc752`（Gate B-A）+ 本轮 integration commit |
| production `src/` diff | **仅 `decision-handler.ts` 的 seam**（约 30 行，opt-in） |
| model checksum | `010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359`（跑完后复验 OK） |
| schema hash | `0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0` |
| threshold | 由冻结产物读出，恰为 `0.01` |

### 门禁

| 门禁 | 结果 |
| --- | --- |
| runtime / reference 等价 | ✅ `max|Δ| = 0.000e+0`；argmax / override / label divergence 全 0 |
| overlay ≡ decorator（同一 context+command） | ✅ 两种安装形式同一决策函数；decline 时返回 production **对象本身** |
| seam 契约 | ✅ 缺失即惰性；抛错即惰性；存在即有权；bid / casual 路径不受影响 |
| **landlord activation = 0** | ✅ 把 overlay **装在地主自己的座位上**跑 12 局 arm-A：overlay decisions = **0** |
| shipped landlord invariant | ✅ arm A 1,200 副中 **1 副**不同（+0.028pp）——见 §2 |
| hidden-state guard | ✅ 重发隐藏手牌 5 次，selector 命令不变 |
| `pnpm check` | ✅ exit 0（含 Chromium 验收 32 项） |

## 2. Primary（shipped，jobs=1，真实 120 ms deadline）

1,200 deals × 6 games × 2 arms = 14,400 games，**jobs=1**，两臂顺序跑（无 CPU 竞争）。

| 臂 | baseline | challenger | **PAIRED Δ** | 95% CI |
| --- | ---: | ---: | ---: | --- |
| arm A（strong 当地主） | 50.5% | 50.5% | **+0.028%** | [+0.000%, +0.083%] |
| arm B（strong 当农民） | 53.8% | 64.8% | **+10.917%** | [+9.583%, +12.194%] |
| **combined（pooled）** | 52.2% | 57.6% | **+5.472%** | **[+4.806%, +6.111%]** |

逐副转移：**better 422 / worse 87 / tie 691**。

### arm A 的 +0.028pp 是什么

**1,200 副里有 1 副不同**（对手臂：designed→shipped 的变化在 baseline 上 0/1200、
challenger 上 1/1200）。这是**墙钟截断**造成的，不是 selector 激活：
shipped 模式下 deadline 读真实时钟，两次运行的截断点可以不同。§1 那条
「把 overlay 装在地主座位上跑 12 局，activation = 0」是直接反证。

| GATE B-S criterion | 实际 | |
| --- | --- | --- |
| combined point estimate `>= +1.0pp` | +5.472pp | ✅ |
| combined paired 95% CI lower > 0 | +4.806% | ✅ |
| landlord activation invariant | activation 0；arm A 1/1200 由时钟解释 | ✅ |
| no integrity failure | 见 §1 | ✅ |
| performance acceptable | 见 §4 | ✅ |

## **GATE B-S PASS**

## 3. Designed → shipped retention（diagnostic，非门槛）

| | designed | shipped | 差 |
| --- | ---: | ---: | ---: |
| arm A | +0.000pp | +0.028pp | +0.028pp |
| arm B | +10.917pp | **+10.917pp** | **+0.000pp** |
| **combined** | +5.4583pp | **+5.4722pp** | **+0.0139pp** |

**retention ≈ 100%**，没有任何「deadline 系统性吃掉 Phase 2 效果」的迹象。

原因在 §4：**jobs=1 下 deadline 几乎不触发**（cutoff rate 0.8–0.9%）。所以 designed 与
shipped 的决策内容基本一致。这不证明在节流设备上也如此——本轮没有在真实手机上测。

### Deadline / 完成度诊断

| | baseline | challenger | 差 |
| --- | ---: | ---: | ---: |
| master play decisions | 76,568 | 77,802 | +1,234 |
| deadline cutoff decisions | 640 | 689 | +49 |
| **cutoff rate** | **0.8%** | **0.9%** | **+0.1pp** |
| master latency p50 | 29.5 ms | 31.8 ms | +2.3 ms |
| master latency p95 | 90.4 ms | 99.6 ms | +9.2 ms |
| master latency p99 | 124.1 ms | 131.2 ms | +7.1 ms |
| master latency max | 152.0 ms | **171.1 ms** | +19.1 ms |

cutoff rate 只上升 0.1pp：overlay 在 master 搜索**之后**运行，不消耗 master 的预算，
所以它不会让搜索更早被截断。

## 4. Performance

### 必须先更正 Gate B-A 的一个数字

Gate B-A 报的「selector overhead ≈ 0.19 ms / decision」**只数了 feature + inference**，
漏掉 overlay 里最大的一项：**重新推导 production shortlist**（`cfProposal`，220 analyzer nodes）。
Gate B-S 直接测得（shipped，jobs=1）：

| overlay 组成部分 | 每 eligible decision |
| --- | ---: |
| **`cfProposal` shortlist 重推** | **8.927 ms** |
| feature construction | 0.105 ms |
| tree inference | 0.078 ms |
| **合计** | **9.110 ms** |

**真实 overlay 成本是此前报告的 47 倍，其中 98% 是 shortlist 重推。**
Gate B-A 的棋力结论不受影响（overlay 不改变任何决策内容），性能结论被高估——
已在 [experiment.md](experiment.md) §5 就地更正。

### 相对产品窗口

| | 值 |
| --- | ---: |
| master internal budget | 120 ms |
| 本产品 response window（`ENHANCED_AI_RESPONSE_WINDOW_MS`） | 480 ms |
| presentation beat（`ENHANCED_AI_PRESENTATION_BEAT_MS`） | 520 ms |
| overlay 合计 / eligible decision | **9.11 ms** |
| overlay p95 | ~0.2 ms（feature+inference）+ ~9 ms（proposal） |
| master decision max（challenger） | **171.1 ms** |
| 出现 >480 ms 的 decision | **0** |

overlay p95 远低于 120 ms master budget（约 13×余量），master decision max 171.1 ms
仍在 480 ms 窗口内。**未修改任何产品窗口。**

**未测**：Worker 端到端 latency、cadence miss、outer timeout、fallback 计数——
benchmark 直接调用 `decideEnhancedAi`，不经过 Worker，因此这些量在本轮**没有测量**，
不能声称「无 cadence 回归」。

## 5. 未做的事

* 未用 final validation `10001–10400`（仍 untouched）。
* 未改 threshold / model / feature / selector / 统计方法 / 数据。
* 未创建新 discovery pool；`40001–41200` 保持 **retired**。
* 未做 artifact 交付（见 §0）。
* 未因结果调整任何参数。

下一步（若获批准）：`10001–10400` 最终独立 validation。
