# AI 强度续研：先验证拆牌估计，再扩搜索

日期：2026-09-12。接续 `2026-09-12-ai-strength-handoff.md`。

本轮只做代码审查、开发机 CPU 采样、穷举反例探针与研究记录。
没有修改生产代码、现有基准或测试，没有声称棋力已经提高。
原交接中的硬约束继续适用。

## 1. 新证据：拆牌估计存在无法靠加节点纠正的低估

`src/core/ai/hand-analyzer.ts:96` 的 `basicTurnEstimate` 同时扣除序列
节省与三张附件节省，没有确保两种节省使用互不重叠的牌。
`:177` 又把这个估计作为 `best` 的初值，后续只通过 `Math.min`
降低它，`:191` 在 `best <= 2` 时提前结束。

因此，即使启发式初值低于真正最少手数，更多搜索也无法把它调高。
这不是墙钟截断造成的。

使用引擎的 `generateLegalActions` 穷举所有合法拆分，得到：

| 手牌（数字表示点数） | 基础估计 | 10,000 节点分析 | 真正最少手数 | 可行拆分 |
| --- | --- | --- | --- | --- |
| 3334445 | 1 | 1 | 2 | 333444 + 5 |
| 3334455 | 1 | 1 | 2 | 33344 + 55 |
| 33344556 | 1 | 1 | 3 | 33344 + 55 + 6 |

这里“真正最少手数”指独立手牌的合法划分，不是对抗局面下保证几轮获胜。
探针枚举 3 至 8 六个点数、每点 0–3 张、总牌数不超过 9 张；
在检查 111 种手牌后已找到 10 个低估，按预定的 10 个反例上限停止。
**这不是随机抽样，不能把 10/111 当作实战错误率。**

精确参照使用以下递推：空手为 0；否则枚举所有引擎认可的出牌，
取 `1 + exact(剩余手牌)` 的最小值；按手牌缓存。每步至少删除一张牌，
并且不使用生产估计作为剪枝依据。这是开发期手牌分析，不向 AI 注入真实对手牌。

可在临时 Vitest 探针中复现以下核心代码（从仓库导入对应函数）：

```ts
const cache = new Map<string, number>();
function exact(hand: readonly CardId[]): number {
  if (hand.length === 0) return 0;
  const key = hand.join(",");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let best = hand.length;
  for (const action of generateLegalActions({ hand, currentPlay: null })) {
    if (action.type !== "play") continue;
    const used = new Set(action.play.cards);
    best = Math.min(best, 1 + exact(hand.filter(card => !used.has(card))));
    if (best === 1) break;
  }
  cache.set(key, best);
  return best;
}
// 3334445；牌 ID 的前四张是 3，后四张是 4，再后四张是 5。
const hand = [0, 1, 2, 4, 5, 6, 8].map(asCardId);
console.log(exact(hand)); // 2
console.log(createHandAnalyzer({ maxNodes: 10_000 }).analyze(hand).minimumTurns); // 1
```

本轮探针是观察工具，不是新门禁。它没有替代修复前应先变红的正式回归测试。
临时完整探针保存在 `/tmp/ai-strength-profile-20260912/probe.test.ts`；
临时路径不是仓库交付依赖。

**含义：** 已发现明确的估计质量问题；尚未证明纠正它会增加比赛胜率。
现有权重可能已经适应这种偏差，必须用同种子前后对照验证。
只把 `best` 改成手牌长度也不够：预算耗尽时递归仍返回可能偏低的估计，
需要先明确近似值、可行拆分上界和精确结果的语义。

## 2. 新证据：合法动作生成确实是 CPU 热点

未改出厂代码，运行原有 `expert:master` 对局，12 副牌、72 局，种子从
默认的 301 开始。使用 V8 CPU 采样，测试耗时 50.54 秒并通过。

```bash
source scripts/activate-toolchain.sh
mkdir -p /tmp/ai-strength-profile-20260912
AI_BENCH_PAIRS=expert:master AI_BENCH_DEALS=12 AI_BENCH_SECONDS=90 \
AI_BENCH_UNBOUNDED_EVERY=1000000 \
node --cpu-prof --cpu-prof-dir=/tmp/ai-strength-profile-20260912 \
  node_modules/vitest/vitest.mjs run --config vitest.benchmark.config.ts \
  --reporter=verbose -t 'over mirrored deals'
```

激活确认：Node v24.20.0、pnpm 11.24.0。
筛选须用 `over mirrored deals`；Vitest 展开的档位名称带单引号，
`measures master vs expert` 不匹配，首次尝试全跳过，未计入证据。

选择执行测试的子进程 profile，排除几乎全是 idle 的父进程。
按 `timeDeltas` 加权，子进程采样总时长 50.741 秒：

| 调用 | 含子调用的时间占比 |
| --- | --- |
| decideEnhancedAi | 94.72% |
| rankMasterPlayActions | 89.61% |
| rolloutCandidate | 86.54% |
| generateLegalActions（所有调用来源） | 75.66% |
| HandAnalyzer.analyze | 70.45% |
| solveMinimumTurns | 68.50% |
| searchContext | 16.69% |

这些是嵌套调用占比，**不能相加**。函数自身热点包括
`consecutiveSelections` 20.48%、`buildGroups` 14.62%、
`validatePlay` 9.96%。

原始子进程文件为临时目录中的
`CPU.20260912.105946.62.0.001.cpuprofile`。
采样包含基准自身的额外根排序等开销，也可能影响墙钟截断。
因此本次只用于热点定位，不作为新的胜率、延迟或设备性能基线。

**含义：** 原交接关于合法动作生成的猜测得到支持，但不能直接推出
缓存一定收益。主要开销还包括拆牌分析中的再次生成，不能只盯 rollout
的 `searchContext`。下一步应测重复请求比例，再决定缓存位置与键；
真实 CardId、当前牌型与长度等语义必须保留。缓存预算受限的分析结果
还会涉及节点余量与遍历顺序，不能只按手牌跨候选复用。

## 3. 仍待验证的评估问题

`src/core/ai/master-policy.ts:210` 的非终局 `rootUtility` 对每方的
剩余手数和牌数求和；但农民方的胜利条件是任意一名农民出完。
例如一名农民接近出完、另一名农民牌多时，求和可能掩盖紧急程度。
终局分支正确地按阵营给正负分；问题假设只针对非终局估计。

这值得设计残局对照，但**不能直接断言替换成 min 就会更强**：
能否拿到出牌权、队友能否接应、对手是否先出完都影响结果。

另两个实现细节必须纳入后续实验解释：

- `rolloutDepth: 3` 实际是根动作之后再走 3 步，总计最多 4 个动作。
  做 3→4 实验前应明确报告口径，避免混淆总深度。
- rollout 给评分器的节点参数为 8，但每候选的下限为 1；合法动作
  超过 8 个时，实际累计访问节点可以超过 8。它是分配参数，不是
  整次 rollout 的严格总节点上限。不要为了省开销恢复顺序偏置。

## 4. 对旧结论的修正

1. 两个负面实验否决了“移除锚定”和“权重放大十倍”这两个配置，
   支持优先检查评估质量；**没有排除更深搜索、不同宽度或其他权重**。
   “标定是唯一可行道路”目前没有足够证据。
2. 相邻对的胜率不可相加成总跨度，也不保证传递性。完整跨度仍应
   看直接的 casual 对 master；旧数据 53.3% [47.5%, 59.2%] 尚未证明分离。
3. default 对 expert 的 CI [48.4%, 50.8%] 是**跨过 50%**，不是
   “区间到不了 50% 以上”；准确结论是没有证实 expert 更强。
4. 墙钟预算路径不是严格确定性的。同种子重跑一次相同是有用证据，
   不能保证以后逐位相同。比较配置时应使用相同完成副牌集合，并按副牌
   的前后差值计算配对区间；不同软时限完成副数不宜直接当作配对实验。
5. 当前胜率赛制固定地主，不评估叫地主策略带来的整局收益；bid 探针
   只测耗时。该结果应称为固定角色下的出牌强度。
6. Spec 052 写了确定性自检留在 `pnpm check`，但实际自检都在
   `benchmarks/ai-benchmark.test.ts`，而默认 Vitest 只包含 `tests/**`。
   文档与执行范围不一致，不能把此前 265 测试通过说成基准自检也通过。

## 5. 推荐实验顺序

1. 先为以上小手牌写表驱动回归，证明现实现变红；明确有限预算下拆牌
   估计的契约，再研究一种有合法划分依据的估计修正。
2. 仅在开发实验中改这一项，以原出厂路径和相同种子对照 default/expert；
   同时保留 default 不变对照。先诊断，后用未参与选择的种子验证。
3. 若没有收益，记录并回滚；若有收益，再测 master 的角色分臂与端点
   对照，最后检查体积、完整门禁和浏览器验收。不能只看小残局正确就发布。
4. 另行研究农民终局距离和重复动作生成；不要与拆牌修正同时加入，
   避免无法解释收益来源。

本轮没有引入新门禁或产品行为；只新增本研究记录，未重跑完整
`pnpm check`，未提交。之前的完整门禁结果仍只属于上一轮工作。
