# H5 v1（E5）的可复现产物（归档）

H5 v1 按 **REVERT** 关闭（判据、数字与理由见
[Spec 060 实验记录](../../specs/060-terminal-evidence-gating/experiment.md)）。这里保存
复跑 E5-A 与它的诊断所需的全部东西——机制本身已从 `src/` 撤掉。

与 [`057-leaf-harvest`](../057-leaf-harvest/) 同样的理由：这些载体不能留在
`benchmarks/` / `tests/`——它们 import 的是**已被回滚的**导出
（`terminalVerdict` / `rolloutBlendedScore` / `terminalGateWeight` / `setGateSink`），
留在仓库里会让 `pnpm check` 与基准都因为缺导出而变红。

## 内容

| 文件 | 作用 |
| --- | --- |
| `challenger.patch` | H5 v1 的全部 `src/` 改动：机制 + 出货接线（`terminalGateWeight: 1`）。相对 HEAD，可 `git apply` |
| `instrumentation.patch` | 观测型插桩（`setGateSink`），**在 `challenger.patch` 之后**应用。只读，不可能改变决策 |
| `terminal-evidence-gate.test.ts` | 实现门禁的单元层（原 `tests/core/`），11 项 |
| `h5-gate.test.ts` | 门禁的 corpus 腿与出货路径恒等腿（原 `benchmarks/`） |
| `h5-diagnostics.test.ts` | E5-A 门控诊断的采集/汇总（原 `benchmarks/`，临时文件） |

## 复跑

```bash
source scripts/activate-toolchain.sh
git apply docs/research/h5-v1/challenger.patch
cp docs/research/h5-v1/terminal-evidence-gate.test.ts tests/core/
cp docs/research/h5-v1/h5-gate.test.ts benchmarks/

# 门禁（单元层进 check；corpus 腿与 dump 恒等腿用基准配置）
pnpm test tests/core/terminal-evidence-gate.test.ts
AI_BENCH_H5_CORPUS=.local/calibration pnpm exec vitest run --config vitest.benchmark.config.ts benchmarks/h5-gate.test.ts
# 出货路径恒等：两次 designed 跑，第二次把 terminalGateWeight 改成 0.2
AI_BENCH_H5_IDENTITY=<production.json>,<gate02.json> pnpm exec vitest run --config vitest.benchmark.config.ts benchmarks/h5-gate.test.ts

# E5-A（两臂；baseline 用未打补丁的 HEAD）
AI_BENCH_PAIRS=default:master AI_BENCH_DESIGNED=1 AI_BENCH_LOG_COMMANDS=1 \
AI_BENCH_SEED=0 AI_BENCH_DEAL_START=30001 AI_BENCH_DEALS=400 AI_BENCH_JOBS=8 \
AI_BENCH_SECONDS=1800 AI_BENCH_LABEL=e5a-challenger \
AI_BENCH_MERGE_OUT=.local/e5a-cand.json AI_BENCH_MERGE_COMMANDS_OUT=.local/e5a-cand-commands.json \
  pnpm bench:ai
AI_BENCH_PAIRED=.local/e5a-base.json,.local/e5a-cand.json pnpm exec vitest run \
  --config vitest.benchmark.config.ts benchmarks/paired-compare.test.ts

# 门控诊断（需先应用 instrumentation.patch）
git apply docs/research/h5-v1/instrumentation.patch
cp docs/research/h5-v1/h5-diagnostics.test.ts benchmarks/
for i in 0 1 2 3 4 5 6 7; do
  AI_BENCH_DESIGNED=1 AI_BENCH_SEED=0 AI_BENCH_DEALS=50 AI_BENCH_SECONDS=1800 \
  AI_BENCH_DEAL_START=$((30001 + i*50)) AI_BENCH_H5_DIAG_OUT=.local/e5a-diag-shards/shard-$i.json \
    node node_modules/vitest/vitest.mjs run --config vitest.benchmark.config.ts benchmarks/h5-diagnostics.test.ts &
done; wait
AI_BENCH_H5_DIAG_MERGE=.local/e5a-diag-shards node node_modules/vitest/vitest.mjs run \
  --config vitest.benchmark.config.ts benchmarks/h5-diagnostics.test.ts
```

`5001–5400` 用于 mechanical preflight（门禁、corpus 回放）；E5-A 用 `30001–30400`，
那次消耗把 Discovery V3 的暴露计数从 0 变成 1。`10001–10400` 仍未消耗。
