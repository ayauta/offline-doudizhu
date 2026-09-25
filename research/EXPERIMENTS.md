# Experiments

每条一行。**结论以报告为准，这里只是索引** —— 任何数字引用都必须回到它的报告与 pool。

`status` 取值：`PASS` / `REJECT` / `DOUBLE_REJECT` / `DIAGNOSTIC` / `ENV-SPECIFIC PASS` /
`JOINT PASS` / `RELEASED` / `PAUSED`。

| # | experiment | question | baseline | candidate | result | status | report |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **π1 farmer** | 能否用 counterfactual selector 强化农民？ | production master farmer | π1 selector | farmer +10.583pp、combined +5.292pp（`10001–10400`，n=400/arm） | **PASS** | `docs/specs/063-.../final-validation.md` |
| 2 | old E1/E3/E4/H5 | 早期启发式与阈值方向 | 各自 baseline | 各自 candidate | 未达到采用门槛 | **REJECT** | `docs/research/ai-experiment-results.md` |
| 3 | **Factory π1→π2** | fixed-C3 / current-schema 配方能否稳定产出下一代？ | π1 | 两次 preregistered attempt | 两次都停在 `calibration-no-go`；eligible 3/6000 与 4/12000 | **DOUBLE_REJECT** | `research/farmer-pi/terminal-v1.md` |
| 4 | **full-action feasibility** | 不用神经网络、解除 top3/top5 限制是否可行？ | —— | 7 部分可行性研究 | 枚举器经 brute-force oracle 验证完备 | **DIAGNOSTIC** | `research/full-action-selfplay-v1/feasibility.md` |
| 5 | **TARGET landlord** | full-action MC-Q 能否产出有用的地主？ | production master landlord | TARGET | env A +9.875pp；env B **−2.875pp** | **ENV-SPECIFIC PASS** | `research/full-action-selfplay-v1/landlord-validation-report.md` |
| 6 | **CHEAP landlord** | 换训练对手分布会改变学到的策略吗？ | TARGET | CHEAP | 两个独立评测上 TARGET−CHEAP 都为正；CHEAP 在两环境都通过 | **DIAGNOSTIC** | `research/full-action-selfplay-v1/rehearsal-report.md` |
| 7 | **CHEAP independent confirmation** | CHEAP 在 fresh data 上是否成立？ | master landlord | CHEAP | env A +9.400pp [+8.038,+10.762]；env B +3.450pp [+2.059,+4.841] | **JOINT PASS** | `research/full-action-selfplay-v1/landlord-robust-confirmation-report.md` |
| 8 | **AI-v2 integration** | 确认过的策略能否走真实产品路径？ | research reference | production Worker | 3,532 个地主决策 0 mismatch；1,000 个农民决策 0 回归 | **PASS** | `research/full-action-selfplay-v1/cheap-release-candidate-report.md` |
| 9 | **AI-v2 Android** | 真机真实 Worker 上是否保持策略？ | —— | 真机 | 152 个地主决策、0 mismatch、0 fallback、retention 100%、p99 92.2 ms | **PASS** | 同上 |
| 10 | **AI-v2 release** | 接线为 production 并发布 | —— | AI-v2 | `pnpm check` 694 tests 绿；tag `ai-v2`；v0.5.0 | **RELEASED** | `research/champions/ai-v2.json` |
| 11 | AI-v3 | 如何从 AI-v2 稳定产生下一代？ | AI-v2 | （未定） | 未开始 | **PAUSED** | `research/ai-v3/README.md` |

## 读这张表时的三个提醒

* **第 5 行与第 7 行不是同一件事。** TARGET 只在 env A 通过、在 env B 退步；CHEAP 在两个
  环境都通过。两者用不同的 pool，数字**不可相减**。
* **第 1 行的 combined 与第 7 行的 delta 不可相加。** 不同 benchmark、不同配对、
  不同 pool。本项目吃过这个亏。
* **第 4、6 行是诊断，不是强度证据。** 它们回答"机制是什么"，不回答"更强没有"。
