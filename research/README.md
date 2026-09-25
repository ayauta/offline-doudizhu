# Research

这个文件是研究部分的入口。如果你只读一页，读这一页。

---

## CURRENT PRODUCTION CHAMPION

```
AI-v2                                    tag: ai-v2   version: 0.5.0
record: research/champions/ai-v2.json

Landlord  full-action LightGBM policy
          origin: the CHEAP research candidate
          070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b

Farmers   π1 counterfactual selector
          010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359
          threshold 0.01

Active on the master tier only. `casual` and `default` are unchanged.
```

STATUS: **released / ready-to-publish**

---

## PAST

| | 内容 | 结果 |
| --- | --- | --- |
| AI-v1 | 农民强化：counterfactual selector（π1） | 已发布 |
| AI-v2 | 地主强化：full-action policy（CHEAP）+ 接线为 production | 已发布 |

详细历史见 [`EXPERIMENTS.md`](EXPERIMENTS.md)（每条一行）。
已经结束的研究树保留在原地作为 archive，不再作为 active 入口。

## NEXT

**AI-v3 研究暂停。** 现在没有在跑的训练、没有预留的 pool、没有待启动的工厂。

恢复研究时的接续说明见 [`ai-v3/README.md`](ai-v3/README.md)（1–2 页，不是协议）。

---

## 读研究时先读这个

[`GUARDRAILS.md`](GUARDRAILS.md) —— 十来条本项目真实踩过的坑。
它们比任何一份报告都更省时间，因为每一条都对应一次得出过错误结论的测量。

---

## 目录

```
research/
  README.md              <- 你在这里
  EXPERIMENTS.md         每条实验一行：问题 / 基线 / 候选 / 结果 / 状态
  GUARDRAILS.md          测量与晋级的经验教训
  champions/             immutable champion 记录（ai-v2.json）
  farmer-pi/             AI-v1 那条线；protocol-v1.yaml 与 pool-ledger.jsonl 仍被代码读取
  full-action-selfplay-v1/  AI-v2 那条线；协议与报告
  ai-v3/                 仅接续说明，无协议、无 pool、无训练
```
