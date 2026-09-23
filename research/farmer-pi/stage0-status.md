# Factory v1 — Stage 0 状态

记录日期：2026-09-23。分支：`research/farmer-policy-iteration-v1`（从 `98ea3f9` 分出）。
本节在 closure 工作中更新（`e3f5e02` 之后）。

**状态：Stage 0 未完成。Factory 尚未启动，没有分配任何 fresh pool。**

这一条必须放在最前面，因为 §46 的顺序是「先完成 infrastructure + rehearsal + protocol freeze，
PASS 之后才允许分配 fresh pool」。下面逐项列出 §33 清单的真实状态。

---

## 1. §33 清单

| # | 项目 | 状态 | 证据 |
| --- | --- | --- | --- |
| 1 | champion chain runtime | **完成** | `benchmarks/farmer-pi-chain.ts` |
| 2 | feature / reference action 语义 | **完成，且无需 schema bump** | 见 §2 |
| 3 | pool ledger | **完成** | `research/farmer-pi/pool-ledger.jsonl`、`benchmarks/farmer-pi-pools.ts` |
| 4 | checkpoint / resume | **完成** | `benchmarks/farmer-pi-stage.ts`（deal 级原子 record） |
| 5 | atomic output | **完成** | `writeFileAtomic`（tmp → fsync → rename → dir fsync） |
| 6 | no-peek coordinator | **完成（status 协议）** | `PI_STATUS_KEYS` + `assertNoPeekStatus`；缺 driver 接线 |
| 7 | formal statistic | **完成** | `pairedTest` / `formalVerdict` / `requiredFormalN` / `stage1Decision` / `offlineVerdict` |
| 8 | attempt state machine | **完成** | `benchmarks/farmer-pi-attempt.ts` |
| 9 | Windows host launcher / watchdog | **完成** | `scripts/farmer-pi-host.mjs`，进程级实测 |
| 10 | champion archive | **完成** | `benchmarks/farmer-pi-champions.ts` |
| 11 | retired-seed rehearsal（含故障注入） | **完成** | `benchmarks/farmer-pi-rehearsal.test.ts`，9/9 |
| 12 | 单一命令 runner（§31） | **未完成** | `scripts/farmer-pi.mjs` 尚未编写；规格已定，见 §9 |
| 13 | protocol freeze commit | **未提交** | protocol 文件已在，但 Stage 0 未完成，故未冻结 |
| 14 | τ/λ/top3/feature 的不可变 identity | **完成** | `benchmarks/farmer-pi-identity.ts`，写进 protocol 的 `identities` 块 |
| 15 | worker 的 protocolHash 语义 | **完成** | 见 §6（原缺口已修） |
| 16 | miniature real-pipeline E2E（§7/§8/§9） | **未完成** | 依赖 runner |

**因此：fresh pool 未分配，π1→π2 未开始。** §46 N/O 未执行。

## 2. §11 的 reference action：不需要 schema bump

§11 允许「为支持 reference=b_n 做必要的 schema version bump」。检查后的结论是**不需要**：

* `cfRow(view, action, reference)` 从 Spec 062 起就把 reference action 作为**参数**，
  `a0_*` 列块的含义一直是「reference action 的特征 + 与它的数值差」。
* Spec 064 已经在用 reference = `b1`（capture 记录 `rawProductionIndex` 与
  `productionIndex` 两个索引来区分 `b0` 与 `b1`）。
* 因此 Factory 的 chain 只是把 reference 从「一层的 b1」换成「n 层的 b_n」，
  列名、列序、列数都不变。

结论：`featureSchemaVersion` 保持 2，`schemaHash` 保持
`0ec9d20f4abde4b7c5d72751b488de2180723863d3a6248593404c8bee7d85f0`，
冻结的 `ai-v1` artifact 无需重新导出。

## 3. §36 π1 identity gate：已通过，且被 mutation 验证

`tests/core/farmer-pi-chain.test.ts`，27 个断言，全部通过。最强的一条是**语料级逐字节相等**：
在 3 个退休 deal 上，用 1 层 chain 生成的整个 `CfGroupResult`（visit、fork、continuation、
sampled roots、labels）与 `cfPiPolicy`（冻结的 `cfSelectFarmerAction`）在相同 salt /
datasetVersion 下**逐字节相同**，并断言 override 至少发生一次（非平凡）。

三个 mutation 各自变红，证明守卫不是装饰：

| mutation | 结果 |
| --- | --- |
| 层 k 用 `b0` 而不是 `b_{k-1}` 作 reference | **3 failed** |
| 每层各自重新 proposal top3 | **2 failed** |
| 内层 decline 回落到 `b0` | **2 failed** |

## 4. protocol 的当前哈希（**未冻结**）

```
research/farmer-pi/protocol-v1.yaml
sha256 16d5bc33433312f0673855022206e1b707b0c01161977d4a6ac09a5f218dff8b
bytes  4430
```

这个值现在**只是记录**，不是冻结承诺：Stage 0 完成后重跑一次哈希并提交
FACTORY FREEZE commit，那一次的值才是 attempt 要登记的 `protocolHash`。

## 5. 质量门禁

`pnpm check` 通过（exit 0）：strict TypeScript、47 个测试文件 / 578 个测试、
WebView 兼容、production build、bundle、Android delivery、架构边界、privacy、
Chromium acceptance。新守卫全部在门禁内。

`benchmarks/` 不在 `pnpm check` 覆盖范围内（这是仓库既有约定），
所以 rehearsal 必须**单独显式运行**：

```bash
source scripts/activate-toolchain.sh
node node_modules/vitest/vitest.mjs run --config vitest.benchmark.config.ts \
  benchmarks/farmer-pi-rehearsal.test.ts
```

## 6. protocolHash 的接线缺口 —— 已修（`e3f5e02`）

原缺口：两个 worker 都用 `AI_FPI_POLICY_COMMIT`（runner 的 git commit）当作
`protocolHash`，而 §25 要求的是 `protocol-v1.yaml` 字节的 SHA-256。已改为：

* runner 通过 `AI_FPI_PROTOCOL_HASH` 传它登记的那个 hash；
* worker 自己 `loadProtocol()` 重新读文件、重新哈希，用
  `assertProtocolHash(registered, actual)` 比对，不一致就拒绝，**在起第一个 deal 之前**；
* runner 的 commit 以 `runnerCommit` 单独记录，永不与 protocolHash 互相顶替。

负向测试（`tests/core/farmer-pi-protocol.test.ts`）：protocol 追加 1 字节 →
`assertProtocolHash` 拒绝；attempt 登记的 hash 与文件不符 → `assertAttemptProtocol`
拒绝；protocol 里的 identity hash 与工作树不符 → `verifyIdentities` 拒绝。

**frozen policy（已写进 protocol 的 `runner` 块）**：改变 scientific semantics 的
runner 改动必须开新 protocol/version；不改变 semantics 的普通修复允许，只移动
`runnerCommit`。

## 9. runner 的规格（已定，实现中）

一条命令：`node scripts/farmer-pi.mjs <status|inspect|run>`。

* `run` 幂等且 resume-safe：有未完成 attempt 就恢复它，绝不偷偷建新的。
* 每个 transition 写原子状态；持有 `acquireRunLock`。
* 任何 payload 的读取都必须走 `readSealedStage`（未 SEALED 就抛 `IntegrityError`）。
* verdict 只来自冻结公式（`cfSelectThreshold` / `offlineVerdict` /
  `stage1Decision` / `formalVerdict`），runner 没有任何「看起来不错就继续」的分支。
* deadline 先于一切检查；已过期则记 `PAUSED_DEADLINE` 并退出，不启动任何工作。

## 7. 下一步（按 §46）

1. 写 `scripts/farmer-pi.mjs`（§31 的单一命令 runner），把 attempt 状态机接到
   两个 worker 上，并实现 deadline 检查、resume、journal。
2. 在退休种子上跑一次**完整**的 miniature pipeline（含真实 LightGBM 训练），
   作为 rehearsal 的第二段。
3. 重跑 `pnpm check` 与 rehearsal。
4. 计算 protocol hash，提交 **FACTORY FREEZE COMMIT**。
5. 只有以上全 PASS 之后，才用 `allocateAttempt` 分配 attempt-001 的 25,000-deal block，
   开始 π1 → candidate π2。

## 8. 一个需要写清楚的解释性决定

§27 要求 deal 级 checkpoint 落盘，§29 要求 no-peek。两者只有在下述读法下相容，
本 Factory 采用这一读法并在此声明：

> **no-peek 是输出协议，不是磁盘加密。** deal record 里当然有胜负——否则无法 resume。
> 受约束的是**任何运行期间可读的输出面**：status、console、日志。
> `PI_STATUS_KEYS` 是那个输出面的全部字段，`assertNoPeekStatus` 按**精确键集合**校验，
> 而不是逐一禁止某人记得起来的字段。verdict 只在 stage seal 之后写一次。

这条与 Spec 065 的「children write nothing」不同，是**有意**不同：§27 的存在正是因为
「什么都不写」会让一次挂起吃掉几小时。同样的性质由「无人值守 + 输出协议 + 一次写成」
来保证，而不是由「磁盘上没有中间态」来保证。
