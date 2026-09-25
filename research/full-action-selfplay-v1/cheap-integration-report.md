# CHEAP landlord — product integration prototype and deployment feasibility

状态：**原型，未发布**。不训练，不压缩，不修改 production π1。
协议见 [`cheap-integration-protocol.md`](cheap-integration-protocol.md)。

---

## A. FROZEN INTEGRATION PROTOCOL + HASH

```
research/full-action-selfplay-v1/cheap-integration-protocol.md
sha256 ac4302bcc7e928a17d4f22fda55a8ad9d01dfa71cb669269856845f8d695c15f
冻结于任何测量运行之前
```

冻结对象：`070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b`
（512 trees × 403 columns，raw 2,019,876 B / gzip 450,524 B，node zlib level 9）。
Farmers 为现有 production π1，未动。

## B. PRODUCT PATH

```
src/platform/web/ai-worker.ts
  request.cheapLandlord === true && aiType === "master"
    -> loadLandlordModel()            惰性；失败 -> null -> 分支不安装
    -> { modelSha256, decide(context) }
  -> decideEnhancedAi(request, runtime)
       landlord 分支在 master rollout **之前** 返回
         view.seat === view.landlord
         -> enumerate ALL legal actions   (context.legalActions，session 自己的
                                           generateLegalActions，无短名单)
         -> stateFeaturesOf(view)         每决策一次
         -> 每动作一条 403 列 row
         -> scoreTrees                    frozen evaluator
         -> landlordArgmax                strict >，并列取最早
         -> landlordActionCommand -> actual game command
```

**没有被隐藏的东西**：`rankMasterPlayActions` / `cfProposal` / `expert.slice(0,3)` /
`defaultPolicyPrior` 在地主分支被安装时**根本不会被调用**——分支在它们之前返回，
不是"结果被丢弃"。

**路由范围**：`master` tier 的地主位。`casual` 不动（§3 的 product 语义：casual 是
刻意较弱的档位，且确认的 baseline 是 master）；farmer 位不动。

**Farmer unchanged proof**：200 个真实 farmer decision，安装 landlord runtime 前后
用**冻结虚拟时钟**比较，**0 分歧**；casual 位同样 **0/200**。虚拟时钟是必需的——
master rollout 读时钟，不冻结就无法区分"集成改变了它"与"调度改变了它"。

**Fallback 行为**：唯一的 fallback 是**拒绝**（model 缺失 / 非法状态 / schema 不匹配 /
打分抛错），此时**落回 production 自己的路径**，地主不会丢回合。每一次拒绝都是一个
具名 reason，可逐条计数——本次实测 **0 次拒绝**。

## C. FUNCTIONAL EQUIVALENCE

```
dataset     120 deals，915001–915120（development pool；**不是** strength evidence）
states      1402 landlord + 2596 farmer
E1          1402 states，**0 mismatch**，**0 declines**
            比较量 = 最终执行的 action identity（GameCommand canonical key），
            **不是** raw score
E2          200 farmer states，0 unexpected divergence
```

覆盖（逐类计数，实测）：

| 类别 | n | 类别 | n |
| --- | ---: | --- | ---: |
| leading | 397 | singleAction（1 个合法动作）| 679 |
| responding | 1005 | wideSet（≥20 个）| 173 |
| passLegal | 1005 | canEmptyHand | 32 |
| bomb | 32 | nearTie（top-2 差 ≤1e-3）| 5 |
| rocket | 64 | opening（history 空）| 120 |
| attachment | 207 | lateGame（最短手牌 ≤5）| 882 |
| sequence | 215 | **exactTie** | **0 —— 未覆盖** |

合法动作数：min 1、p50 2、p95 57、p99 120、**max 245**。
历史 109-state benchmark 的 median 很低，**没有**用它代表产品尾部；上表是真实分布。

**`exactTie` 覆盖缺口如实报告**：1402 个真实状态里候选模型从未产生 top-2 精确相等。
该规则改由 `tests/app/cheap-landlord-routing.test.ts` 用 constant model 覆盖
（每个决策都是 tie），并已验红（把 `>` 改成 `>=` 时 2 个测试失败）。

## D. PRODUCT SIZE

口径见协议 §10；S2 与 `scripts/check-bundle.mjs` 强制的计算**完全相同**。
**无 brotli**（仓库中不存在该口径）。构建为真实 `vite build`。

```
                               raw bytes      gzip -9        占历史预算
pre-integration（记档）           540,849       122,788        0.99x
baseline（仅集成胶水，无模型）      549,993       125,386        1.01x  ← 超 1,811 B
prototype（胶水 + 冻结模型）     2,569,883       575,787        4.66x  ← 超 452,212 B

delta（模型贡献）               +2,019,890      +450,401
  —— 模型文件本身 2,019,876 B，差 14 B 为包装代码

集成胶水（代码，非模型）            +9,144        +2,598

dist 总 raw        653,611 -> 2,673,501   (+2,019,890)
main chunk         raw 61,124 -> 61,124   （**逐字节相同**）
application CSS    raw 21,829 -> 21,829   （相同）
default build 还原后与 baseline 逐字节相同
```

`mainChunkUnchanged` 用 **raw** 判定：prototype 的 main chunk 内容不变，只是文件名
hash 变了（gzip 差 1 B 是那个 hash 字符串）。用 gzip 判定会把"文件名变了"读成
"模型漏进主包"。

**不可忽略的构建事实**：默认 Workbox `maximumFileSizeToCacheInBytes` 是 2 MiB，
prototype 的 worker chunk 2.57 MB **超出该限，`pnpm build` 直接失败**：

```
Configure "workbox.maximumFileSizeToCacheInBytes" to change the limit: the default value is 2 MiB.
```

本次测量用一个**只改这一个数字**的 `.local/` 配置绕过，并先验证它与生产配置产出的
baseline 逐字节相同才采信 prototype 数字。**production 配置未改**——是否提高该限是
review 的决定，因为它把预缓存载荷从约 621 KiB 推到约 3.1 MiB，影响安装成本。

## E. STARTUP

真实浏览器、真实 Worker（`vite preview` 提供 production `dist`，Playwright 驱动真实 UI）：

```
worker created at        baseline 233.8 ms      prototype 221.4 ms   （页面加载后）
cold first decision      baseline  29.8 ms      prototype  73.3 ms
```

cold 差 **+43.5 ms**，即模块加载 + **2 MB 模型解析**的成本，仍然远低于 480 ms 窗口。
warm 稳态见 §F。`worker.evaluate` 已用于读 Worker 自身状态；见 §H 关于堆的限制。

## F. DECISION LATENCY

**in-process（1402 states，产品 handler，含完整拆解）**：

```
total       n 1402  p50 0.09  p90 1.40  p95 2.87  p99 5.82  max 11.81 ms
  feature           p50 0.02  p90 0.29  p95 0.58  p99 1.29  max  2.38
  inference         p50 0.06  p90 1.11  p95 2.25  p99 4.62  max  9.38
  select            p50 0.01  p90 0.01  p95 0.02  p99 0.02  max  0.15
leading     n  397  p50 0.70  p90 3.72  p95 5.47  p99 7.38  max 11.81 ms
responding  n 1005  p50 0.06  p90 0.16  p95 0.22  p99 0.44  max  1.22 ms
wide sets（≥20 合法动作） n 173  p50 2.56  p99 11.02  max 11.81 ms
```

**wide-action 尾部按要求单独报告**，不用 median 代表它。最宽合法集 **245**。

**browser round trip（真实 Worker，真实产品节奏，6 deals）**：

```
                   n     p50     p90     p95     p99     max
baseline landlord 65   23.3    60.0    68.9   108.7   108.7 ms
prototype landlord 74   12.7    13.9    14.1    14.3    14.3 ms
```

CHEAP 在地主位**更快且尾部紧得多**（max 108.7 → 14.3 ms）。farmer 位两臂都用 master，
未受影响。浏览器 round trip 远高于 in-process 决策成本，差额是消息传递与结构化克隆。

## G. DEADLINE / POLICY RETENTION

```
真实 deadline：ENHANCED_AI_RESPONSE_WINDOW_MS = 520 - 40 = 480 ms   （未放宽）
手工定义的 retention = 该地主决策的答案被产出并实际执行 / 全部地主决策

total landlord decisions      1402（in-process） + 74（browser）
deadline fallbacks            0
other fallbacks（decline）     0
action divergence due to deadline  0
policy retention rate         100.000%
冻结门槛（协议 §9 R1）           ≥ 99.00%      -> 满足
R2  p99 total ≤ 480 ms        5.82 ms        -> 满足
R3  max                       11.81 ms       -> 只报告
```

门槛的锚（不是圆整数）：incumbent master 在 480 ms 预算下**从未被记录到错过窗口**，
最坏单次决策为开发机 126.72 ms、目标手机 139–157 ms，即预算的 26–33%。
99% 比 incumbent 的实测行为宽一个数量级，同时仍约束尾部。
**本仓库没有任何已采纳的 retention 门槛**（`docs/research/ai-experiment-results.md:119`
明确声明那些历史数字"不是当前采用门槛"），所以 R1 是**新的 engineering threshold**，
已在协议中测前冻结。

## H. MEMORY

**口径**：Node `process.memoryUsage()`，显式 `gc()`；`live = heapUsed + arrayBuffers`。
**这是与浏览器 Worker 不同的运行时，两者不可互换**；它界定的是解析后表示的代价，
不是产品的占用。delta **不**使用 `rss`（RSS 是分配器从 OS 拿到的，不随 GC 回落）。

```
model raw                     1.93 MB
read -> decode               +0.00 MB
decode -> json parse         +3.03 MB
json -> tree（typed arrays）  +0.02 MB
peak over baseline            4.97 MB      (Buffer + 解析表示短暂共存)
tree table retained          ~3.04 MB
steady after 139 decisions    7.25 MB      (含 harness 自身 episode 保留，非模型)
rss baseline -> steady        105.27 -> 193.97 MB   (分配器 arena，**不归属模型**)
```

**Worker 自身堆未能直接测量**：此 Chromium 构建的 Worker 上下文里
`performance.memory` 未暴露，`worker.evaluate` 返回 `null`。按协议 §12 以进程级测量
替代并写明口径。**没有**从 model raw file size 推断 runtime memory。

**页面主线程堆（单次采样，非受控对比）**：baseline 3.46 MB / prototype 9.19 MB used。
两臂局数与 GC 时机不同，**不作为结论**；仅记录，并且 main chunk 逐字节相同已排除
"模型进入主线程"这一解释。

## I. PLATFORM BREAKDOWN

| 平台 | 状态 | 来源 |
| --- | --- | --- |
| desktop Chromium（in-process） | 已测 | `benchmarks/cheap-integration.test.ts` |
| desktop Chromium（真实 Worker / 真实 UI） | 已测 | `e2e/cheap-landlord-integration.spec.ts` |
| Android / WebView | **未测** | 本机无 emulator：无 AVD、SDK 无 `emulator/` 与 `system-images/`、`/dev/kvm` 存在但非本用户可写；仓库的 emulator smoke 是 CI-only |
| 真实物理手机 | **`not yet measured on physical phone`** | 设备 `f28c4fbd` = Xiaomi 10S（M2102J2SC），Android 11 / SDK 30，`.debug` 已安装且当前连接；但需要构建并安装一个带本原型的 debug APK，且 `phone-probe` 会 force-stop 用户正在玩的牌局 |

**没有**把 desktop benchmark 写成 mobile verified。
唯一的移动端锚是历史记录（`docs/device-tests/055-ai-on-device.md`：master p50 51–56 ms、
max 139–157 ms，该机约为开发机 3.7×），那是**旧记录的锚，不是本原型的测量**。

## J. HISTORICAL BUDGET STATUS

```
历史预算（enhanced AI worker asset）    123,575 B gzip
baseline 实测（仅集成代码）            125,386 B gzip   -> 超 1,811 B (1.47%)
prototype 实测（含冻结模型）           575,787 B gzip   -> 超 452,212 B (4.66x)
```

按 §12，**没有**为了变绿而修改 `scripts/check-bundle.mjs`，也没有自行修改预算。

**建议的新预算（供 review，未实施）**：

```
label                       现限       实测       建议新限     余量
enhanced AI worker          123,575   575,787    600,000     24,213 B (4.2%)
  —— 若模型不发布：         123,575   125,386    128,000      2,614 B (2.0%)
```

新限的锚：实测值 + 约 4% 余量，与仓库既有做法一致（现有每条 limit 都锚在
"baseline + 值得捕获的最小回归的三分之一"）。**是否接受这个成本是产品决定**：
产品方已明确接受"增加几百 KB 换取已独立确认的地主棋力提升"，实测增量为
**450,401 B gzip（440 KiB）**，落在该区间内。

## K. DEPLOYMENT VERDICT

```
INTEGRATION READY FOR SHIPPED VALIDATION
```

依据（协议 §14）：E1 = 0 mismatch、E2 = 0 unexpected divergence、R1 满足（100% ≥ 99%）、
deadline / memory / startup 均无 material 问题、模型增量属产品方已接受量级。

**这不是 production promote。** 明确不自动进行 shipped-strength validation。
两个 review 前置项见 §L。

## L. HIGHEST-PRIORITY ENGINEERING OBSTACLE

```
Workbox 预缓存上限：默认 maximumFileSizeToCacheInBytes = 2 MiB，
prototype 的 worker chunk 2.57 MB 超限，`pnpm build` 直接失败。
```

这不是棋力或延迟问题，是**构建配置**问题：提高该限是一行改动，但它把预缓存载荷
从约 621 KiB 推到约 3.1 MiB，影响安装与首次加载，因此属于产品决定。
第二个前置项是 §J 的预算修订。两者都不影响 §C/§F/§G 的结论。

## M. DOCUMENTATION CORRECTIONS

按 §17 修正了 `next-policy-improvement-decision.md` 中五处过强表述，未重跑任何旧实验：

1. 「第一个独立确认地主候选」→「第一个在预注册的两个关键 farmer environments 上
   联合 independent PASS 的地主候选」，并注明 TARGET 已先独立验证过**单一 primary
   environment**。
2. 「出现环即 NO-GO」→「已观察到明显的 opponent-dependent performance，**尚不足以
   证明完整 non-transitive cycle**；若未来观察到 cycle，应进入 population-level
   evaluation，而不是机械 NO-GO」。
3. LightGBM → 「当前没有直接证据要求弃用；**低训练误差不能排除 capacity /
   representation limitation**」，并在 §15 表格中把「capacity 不是 ceiling 的证据」
   改为「无欠拟合迹象；但低训练误差不能排除 capacity limitation」。
4. Route 3 → 「**值得测试的 candidate mechanism，不是已证明的修复**」，并列出它仍
   依赖 hidden-state sampling / opponent assumptions / continuation policy /
   search budget，**尚未被证明能解决 cross-opponent generalization**。
5. §13 首要瓶颈 → `current evidence most strongly implicates policy-update/generalization
   as the next research focus, while representation/objective/capacity contributions
   remain unresolved.`

## N. COMMIT / WORKTREE / PRODUCTION STATUS

见下方提交记录。要点：

* **`pnpm check` 现在有一处红灯**，且只有一处：`enhanced AI worker is 125386 B gzip,
  1811 B over the reviewed 123575 B budget`。其余全部通过——strict TypeScript、
  deterministic tests（**53 files / 687 tests**）、WebView 90、production build、
  Android delivery、architecture boundaries、privacy、Chromium acceptance（33 passed /
  2 skipped，两个 skipped 是 env-gated 的测量 spec）。
  按 §12，**没有**修改该预算来让它变绿。
* **两个 frozen identity 移动**（§N.1），协议文件未改。
* production π1 与全部 products 路径未变；default build 与 baseline 逐字节相同。

### N.1 被移动的 frozen identity（2 / 5）

closure identity 对闭包内**每个模块的内容**求 hash，**包括入口模块自己**。集成编辑了
`src/app/ai/decision-handler.ts`，因此凡闭包含该文件的身份都会移动：

```
role                     entry                                  frozen (协议)   现在
teammate (tau)           src/core/ai/index.ts                   2a393860…       2a393860…  未变
landlord (lambda)        src/core/ai/index.ts                   2a393860…       2a393860…  未变
strong seat (master)     src/app/ai/decision-handler.ts         a6ae8a6a…       62f51372…  移动
ordered top three        src/app/ai/cf-selector.ts              e63d084e…       dc92715b…  移动
legal-action-enumerator  src/core/rules/generate-legal-actions.ts 7f1645ee…      7f1645ee…  未变
tree-evaluator           src/core/ai/cf-model.ts                43bc6279…       43bc6279…  未变
```

master 闭包的**文件集合未变**（19 个文件，不含 `cheap-landlord.ts` / `fa-features.ts`），
差异只来自 `decision-handler.ts` 自身的字节。让 landlord policy 由调用方注入而不是被
`decision-handler.ts` 直接 import，正是为了不让 403 列 schema 进入这个闭包。

`top3` 移动是因为 `cf-selector.ts` 从 `decision-handler.ts` import `ENHANCED_AI_SEARCH`
——"ordered top three" 从来就不是独立于 master tier 的，只是此前没有东西在它下面动过。

**协议文件未被修改。** 一个被改到"匹配后来的树"的 frozen identity 就不再是 frozen
identity。两个新值被 pin 在 `tests/core/farmer-pi-protocol.test.ts` 里，强度相同，
并且该 guard 仍然逐字节断言**未移动的三个身份**——其中 enumerator 与 tree-evaluator
正是被确认的候选真正依赖的两个。

### N.2 一处遗留

`git stash list` 中留有一条 `On full-action-selfplay-v1: cl-integration`。它是为测量
pre-integration 尺寸而做的暂存，内容已全部恢复到工作区，属于重复条目。删除 stash
被权限分类器拦下（合理：stash 不可从工作区恢复），因此**保留原样**，交由你决定。
