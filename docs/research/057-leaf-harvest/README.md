# 057 叶采集包（归档，非生产代码）

这里保存的是采集 E1 calibration corpus 所需的一次性工具与那次生产代码改动。
它们**不在任何门禁或构建路径上**，也不应被重新接入 `src/`——`rootUtility` 的
叶值采集是一次性研究动作，把观察接缝留在出厂代码里会让 worker 包多背一份
研究用途的表面。

重新生成语料时按下面顺序做，全程约 4 分钟（8 路并行）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `instrumentation.patch` | 对 `src/core/ai/master-policy.ts` 的临时改动（130 行） |
| `harvest-driver.test.ts` | 采集驱动，放到 `benchmarks/` 下运行 |
| `harvest.sh` | 8 路并行的驱动脚本 |
| `freeze.mjs` | 校验分片铺满区间、写 manifest 与校验和 |

## 插桩做了什么

只做三件事，**都是观察，不可能改变任何决策**：

1. `rolloutCandidate` 拆成 `rolloutLeaf`（返回末态）+ 原函数（返回效用），
   两者算术完全相同。
2. 模块级 `decisionSink` 与导出的 `setDecisionSink()`。
3. 决策结束时把该决策的候选专家分、被选项与 24 个叶子的三手牌交给 sink。

叶子的手牌只保留**点数计数**：斗地主没有任何依赖花色的牌型或比较，所以点数
计数对求值是**无损**的。

## 重新生成

```bash
source scripts/activate-toolchain.sh

git apply docs/research/057-leaf-harvest/instrumentation.patch
cp docs/research/057-leaf-harvest/harvest-driver.test.ts benchmarks/zz-leaf-harvest.test.ts
bash docs/research/057-leaf-harvest/harvest.sh          # 写 /tmp/e1h/shards
node docs/research/057-leaf-harvest/freeze.mjs /tmp/e1h/shards .local/calibration

rm benchmarks/zz-leaf-harvest.test.ts
git checkout -- src/core/ai/master-policy.ts
```

`freeze.mjs` 在分片没铺满区间时会 exit 1，不会写出一份有洞的语料。

## 语料为什么可信

采集来自打过补丁的出厂代码，但补丁还原**不影响语料的效力**：
`benchmarks/leaf-replay.test.ts` 用出货 evaluator 在完全相同的叶子上重放，
**25,684 个决策全部落到记录的选择上，0 处不符**。这条自检同时钉住了阵营划分、
终局处理、混合权重（0.2）与平手规则四件事——重放链是忠实的，语料才谈得上
可比。
