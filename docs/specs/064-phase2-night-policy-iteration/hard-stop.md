# Spec 064 硬停止交接

状态：**TERMINATED / NO VERDICT**。本轮没有得到 `NIGHT KEEP`、`REVERT`、
`POSITIVE` 或 `NEGATIVE` 结论，也不得从 corpus 或模型训练指标推断棋力。

硬停止线：2026-09-21 08:30 CST（UTC+8）  
收尾核验：2026-09-22 00:20 CST  
保存分支：`research/phase2-night-lab`

## 停止时的权威状态

| 项 | 状态 |
| --- | --- |
| Phase 2 v1 | tag `ai-v1` / commit `96dc640`，未改写 |
| Night Lab HEAD | `ca6c5dfa9e4addfd72d6a40e794283ddf861f62c` |
| dataset pool `100001–120000` | 已完整生成并训练，暴露计数 1，随本轮退休 |
| Stage 1 pool `120001–120200` | **未运行，暴露计数 0** |
| Stage 2 pool `130001–131200` | **未运行，暴露计数 0** |
| 强度结论 | **无**；Stage 1/2 都没有结果 |
| 产品集成 | 无；π2 仍是 ignored `.local/` 下的 benchmark-only artifact |
| 残留进程 | 2026-09-22 00:20 核验时无 Claude、Vitest、训练或 benchmark 进程 |

最后一个研究提交在 2026-09-21 05:51 完成。其后没有提交，也没有比该提交更新的
Spec 064 本地产物；收尾扫描未发现 Stage 1/2 result、paired dump 或 benchmark 文件。
因此没有部分 Stage 1/2 结果可解释，也没有被硬停中断而需要退休的评估池。

## 已保存的可复现进度

正式 corpus、manifest、全量审计和 π2 模型的记录见 [corpus.md](corpus.md)：

- 20,000 groups，merged checksum
  `5a730edd1e461c0c72cd9bd6c00b4c7d3619c45617ed1308956230d3034cfd9e`；
- π2 booster sha256
  `c5ee2fd328b4da63d5b52f6bd6793f7749245a4142a58fa40bf64c7a3183253a`；
- `pnpm check` 在 `ca6c5df` 前通过：470 个 deterministic tests、33 个 Chromium
  acceptance tests，以及 boundaries、privacy、build、Android delivery；
- worktree 在本交接编辑前为 clean；ignored corpus/model artifacts 保留在 `.local/`，
  没有提交生成物、密钥或个人信息。

## 终止语义

Spec 064 §14 规定本轮 night-only、不得跨日续跑。因为评估尚未开始，本轮应读作
**在强度判定前终止**，而不是把未运行的 Stage 1 当作失败，也不是把训练完成当作成功。
继续研究必须另开明确的预登记与执行授权；不得把本文件改写成一次已经完成的正式判定。

