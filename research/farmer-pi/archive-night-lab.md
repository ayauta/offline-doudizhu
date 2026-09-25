# Night Lab / Spec 064 / Spec 065 归档

建立日期：2026-09-23。Factory v1 从 `research/phase2-night-lab` 的 HEAD 分出新分支时写下。

这条记录只回答一个问题：**Spec 064 与 Spec 065 留下了什么，它们现在是什么身份，
Factory 能不能用它们。**

---

## 1. 分支与 tag

| 对象 | 值 | 身份 |
| --- | --- | --- |
| `research/phase2-night-lab` | `98ea3f9`（冻结，不再前进） | Night Lab 的归档分支 |
| tag `night-lab-archive-2026-09-23` | `98ea3f9` | 上者的不可变指针 |
| `research/farmer-policy-iteration-v1` | 从 `98ea3f9` 分出 | **Factory v1**，本目录所属 |
| tag `ai-v1` | `96dc640` | **production champion**，Factory 不修改 |

`96dc640` 是 Factory 分支的祖先，所以 Factory 拿得到全部必要的研究基础设施
（`benchmarks/cf-*.ts`、`scripts/cf-*.mjs`、`tests/core/cf-*.test.ts`）
以及 production champion 本身。

## 2. Spec 064 —— INVALID

Phase 2 Night Lab（π1→π2）。Stage 1 在 `00:26:49` 因 **no-peek 违规**被强制终止：
runner 把每副牌的累计结果打进了 log，而那个 log 在跑完之前被读了。

* **没有判定。** 不得解释为 KEEP / REVERT / POSITIVE / NEGATIVE。
* `100001–120000`（dataset）：已生成并被看过，**CONSUMED**。
* `120001–120200`（Stage 1）：被触碰且无效，**INVALID_EXPOSED**。
  只可用于 regression 与工程测试。
* `130001–131200`（Stage 2）：从未启动，**QUARANTINED_UNEXPOSED**。
  它属于那一轮的预登记，因此不可征用。

记录：[Spec 064/stage1-invalid.md](../../docs/specs/064-phase2-night-policy-iteration/stage1-invalid.md)。

## 3. Spec 065 —— INCOMPLETE

候选接口 top3→top5。corpus 生成于 `01:14:18` 启动，
机器随后挂起约 20 小时，`08:30` 的硬停**没有执行**，
全部 worker 在 `09:10:46` 被人工杀掉 —— 晚 40 分钟。

**磁盘上零产出**：`0/15` shard，没有 corpus、没有 rows、没有模型。
约 75% 的对局在内存里跑过，没有任何结果被写出或被读到。

* **没有判定。**
* `140001–160000`（dataset）：被 INCOMPLETE 触及，**INVALID_EXPOSED**。
* `160001–160200`（Stage 1）：从未启动，**QUARANTINED_UNEXPOSED**。
* `170001–171200`（Stage 2）：从未启动，**QUARANTINED_UNEXPOSED**。

记录：[Spec 065/incomplete.md](../../docs/specs/065-candidate-width-top5/incomplete.md)。

### 3.1 top5 工具的去向

§42 明确禁止 top5 进入 Factory v1。工具本身**保存归档**：
`benchmarks/cf-top5*.ts` 与 `scripts/cf-top5-*.mjs` 留在仓库里，
作为可复用的研究与回归资产。Factory **不导入它们中的任何一个**，
也不会把候选宽度从 3 改开。

## 4. 这两轮真正留下的、Factory 直接继承的东西

Spec 065 §4 列出的产物全部有效，且不因 corpus INCOMPLETE 而失效。Factory 复用其中三条：

1. **§14 no-peek 协议**（原子 combined 写、正式池拒绝单臂文件）。
   Factory 把它扩展成 §27 的 deal 级 checkpoint + §29 的输出协议：
   结果可以按 deal 落盘（否则挂起会丢几小时），但**任何可反推棋力的东西不得出现在
   status/console 上**，verdict 只在 stage seal 之后写一次。
2. **两臂并行 coordinator**（1.84× 加速，且磁盘上任何时刻都没有部分结果）。
   Factory 的 stage runner 沿用同一形状。
3. **硬停教训。** 这是最重要的一条，见下。

## 5. 硬停教训 → Factory 的三条规则

Spec 065 失败的直接原因不是负载估算，而是**把停表责任交给了一个 `sleep` 监视器**。
机器一挂起，监视器跟着冻结，既没报错也没到点提醒。教训被写进 Factory：

1. **deadline 必须是绝对 UTC 时刻，用墙钟核对。** 挂起期间单调时钟量错了对象。
   → `scripts/farmer-pi-host.mjs` 的 `--deadline` 参数拒绝没有时区的字符串。
2. **watchdog 必须与工作进程分离，并且只杀本 run 注册的 process group。**
   → host 用 `detached: true` 起子进程，`process.kill(-pid)` 只覆盖那一组。
3. **deadline 之后不得启动任何新工作。**
   → host 在 spawn 之前先查一次；已经过期就退 2，且 `childPid` 记为 null。

同时明确记录**这条机制做不到什么**：`SetThreadExecutionState` 是请求，不是命令。
合盖、手动睡眠、电池策略都可能覆盖它；**一台已经挂起的机器里的 watchdog 无法执行**。
Factory 不修改用户电源配置，请求随进程退出释放。

## 6. Factory 不使用的东西

* 不使用 Spec 064 / 065 的任何 verdict（它们没有 verdict）。
* 不使用 `100001–160200`、`170001–171200` 中的任何 deal 作为判据。
* 不使用 top5 候选接口。
* 不把 π1 的 continuation 当作 π2 的 training target（§24）。

退休数据仍然可以：做 regression、做工程测试、画描述性曲线（如 §26 的 reference board）、
以及启发下一条假设。**不能**再决定任何 KEEP / REVERT。
