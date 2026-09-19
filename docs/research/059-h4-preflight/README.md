# 059 H4 preflight 工具（归档，非生产代码）

`structure-preflight.test.ts` 测量三个等结构预算配置在有资格局面上的
**terminal trajectory rate**。它依赖 `docs/research/057-leaf-harvest/instrumentation.patch`
才能看到 rollout 的叶子（`setDecisionSink`），因此不能留在 `benchmarks/`——那样门禁
与基准都会因为缺一个未接线的导出而变红。

重新生成 4×6 / 6×4 / 8×3 的比较：

```bash
source scripts/activate-toolchain.sh
git apply docs/research/057-leaf-harvest/instrumentation.patch
# 测量需要 depth=6，生产类型 rolloutDepth: 2|3|4 需临时放宽为 number
cp docs/research/059-h4-preflight/structure-preflight.test.ts benchmarks/
# 8 路并行，窗口 5001+i*50 / 50 副，见 /tmp 脚本或按下式：
#   AI_BENCH_DESIGNED=1 AI_BENCH_DEAL_START=<start> AI_BENCH_DEALS=50 AI_BENCH_SEED=0 \
#   AI_BENCH_STRUCT_OUT=<shard.json> pnpm exec vitest run --config vitest.benchmark.config.ts \
#     benchmarks/structure-preflight.test.ts
# 汇总：
AI_BENCH_STRUCT_MERGE=<shard dir> pnpm exec vitest run --config vitest.benchmark.config.ts \
  benchmarks/structure-preflight.test.ts

rm benchmarks/structure-preflight.test.ts
git checkout -- src/core/ai/master-policy.ts
```

结果（calibration 5001–5400，eligible = `rootMinHand <= 2` 的 9,247 个 root）：

| 结构 | trajectories | 终局 | rate | 有终局的决策 |
| --- | ---: | ---: | ---: | ---: |
| 8×3（出货） | 137,184 | 42,088 | 30.7% | 53.4% |
| **4×6** | 68,592 | 34,800 | **50.7%** | **74.8%** |
| 6×4 | 102,888 | 39,841 | 38.7% | 63.8% |

按事先冻结的规则（率高者胜；精确平手取 6×4）→ **冻结 4×6**。
