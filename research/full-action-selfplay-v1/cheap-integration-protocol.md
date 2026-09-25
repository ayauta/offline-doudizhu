# CHEAP landlord — product integration prototype: frozen measurement protocol

状态：**产品集成原型的测量协议**。不训练模型，不做压缩，不修改 production π1，
不发布。冻结于**任何测量运行之前**。

它回答 Decision Node A：

> 已经通过独立确认的 CHEAP landlord，能否作为一个真实产品候选被集成并度量？

冻结时间：2026-09-25。

---

## 1. 冻结对象（唯一）

```
candidateId    landlord-robust-confirmation-v1/candidate-cheap-landlord
modelSha256    070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b
rawBytes       2,019,876 = 2.020 MB
gzipBytes      450,524 = 440.0 KB        (node zlib.gzipSync, level 9)
numTrees 512   numFeatures 403           lightgbm 4.6.0
featureSchema  与 SELFPLAY_FEATURE_NAMES 逐项相同（403 列）
```

Farmers：现有 production π1，**完全不动**。不重训、不量化、不剪枝、不蒸馏、
不减树、不改 schema / history length / action space / tie-break / 数值顺序 /
topK 预筛 / LightGBM 参数。**本次验证的对象就是通过确认的那份原始 CHEAP policy。**

## 2. 目标构建与目标 Worker 路径

```
build command   CHEAP_LANDLORD_BUILD=1 pnpm build      （vite build -> dist/）
target Worker   src/platform/web/ai-worker.ts
worker asset    dist/assets/ai-worker-<hash>.js        （独立 asset，不内联进 main）
default build   不带该环境变量时，src/app/ai/cheap-landlord-model.ts 的表为 null，
                集成分支永不安装 —— production 行为由构造保证不变
```

模型通过 Vite alias 从 `.local/cheap-landlord-model-data.ts` 注入；
`scripts/cheap-landlord-embed.mjs` 逐字节转写并**拒绝**转写任何 sha256 不等于
上面冻结值的表。

## 3. 地主真实路径（必须是这条）

```
received legal observation
  -> enumerate ALL legal actions          （context.legalActions：session 自己的
                                            generateLegalActions，无短名单）
  -> stateFeaturesOf(view)                （每个决策一次）
  -> 每个动作一条 403 列 selfplayRowFromState
  -> scoreTrees（frozen evaluator）
  -> landlordArgmax（strict >，并列取最早）
  -> landlordActionCommand -> actual game command
```

**不得存在**：old master top3 filter、heuristic shortlist、research-only shortcut、
silent fallback、altered canonical order。`rankMasterPlayActions` / `cfProposal`
在地主分支被安装时**根本不会被调用**（分支在其之前返回）。

## 4. Deadline（当前真实产品机制，不放宽）

```
ENHANCED_AI_RESPONSE_WINDOW_MS = 520 - 40 = 480 ms
    真实产品 deadline：客户端在此之后放弃 Worker 的答案，该回合回退到
    CASUAL_AI_STRATEGY（fallbackScope = "turn"）。
ENHANCED_AI_BUDGET_MS.master   = 120 ms
    master rollout 的内部预算。**地主路径不读它**：CHEAP 是原子打分，
    没有可截断的 anytime 结构，中途停下得到的 argmax 不是该 policy 的答案。
```

baseline measurement **一律使用 480 ms**。任何"把 deadline 放宽后 retention 更高"
的说法都不作为结论。

## 5. 三类策略差异分开统计

```
A  Implementation divergence   同一状态、无 deadline/fallback 时
                               research action != product action        目标 0
                               任何非零 => STOP（correctness bug），不进入性能讨论
B  Deadline divergence         CHEAP 本可作答，但产品 runtime 因 480 ms 超时而
                               回退，最终动作与 CHEAP 的答案不同         单独统计
C  Intentional operational fallback
                               model load failure / integrity failure /
                               unsupported state / schema mismatch      hard-visible，逐条计数
```

B 与 C **不得**混进 A，也不得互相吞并。

## 6. 等价规则（冻结）

```
E1  单元 = 一个真实地主决策 state。
    比较量 = **最终执行的 actual action identity**（GameCommand 的 canonical key），
    **不是** raw Q score。任何行为等价都必须落在最终动作上。
E2  farmer 回归：integration 前后，production π1 farmer 的 action 必须 0 意外分歧。
    用**冻结虚拟时钟**比较（now() 恒为常数），使 master rollout 的截断不可能
    造成差异 —— 否则测的是调度，不是集成。
E3  E1 非零 => INVALID IMPLEMENTATION，STOP。
```

## 7. 状态与 deal 集合（不是新的棋力证据）

```
development pool   915001–916200
retired pools      已消耗的 validation / audit ranges
```

这些数据**永久不能**重新称为 independent strength validation。
本协议只用它们做 implementation equivalence、determinism、deadline retention
characterization、regression tests。**不分配任何 fresh pool。**

覆盖必须实际出现（逐类计数，缺一类即报告为未覆盖）：
leading / responding / pass legal / bomb / rocket / attachments /
straight / sequences / 大合法动作集 / 1 legal action / 极宽合法集 /
can-empty-hand / exact score tie / near tie / late game / opening。

## 8. 延迟统计（冻结）

```
计时范围 = received legal observation -> final action command ready
           （不是只测 tree scoring）
拆解     = legal enumeration / feature construction / tree scoring /
           argmax+tie-break / other integration overhead / total
统计量   = p50, p90, p95, p99, max
分层     = legal action count；leading vs responding；game phase（最小必要）
```

**特别要求**：`wide legal-action states` 必须单独报告。
历史 109-state benchmark 的 median legal actions 很低，**不能**用它代表产品尾部。

## 9. Deadline / policy retention（冻结判据）

定义：

```
policy retention rate =
    (landlord decisions where CHEAP's answer was produced and actually played)
  / (all landlord decisions)
```

**仓库里没有任何已被采纳的 retention 门槛。** `docs/research/ai-experiment-results.md:119`
明确写着那些历史数字"是实验记录，不是当前采用门槛或新的时间预算"。
因此下列是**新的 engineering threshold**，在此冻结，测前确定、测后不改：

```
R1  deadline fallback rate <= 1.00%   （= policy retention rate >= 99.00%）
    reference desktop 环境，真实 480 ms budget
R2  p99 total decision cost <= 480 ms （R1 的隐含条件，单独报告）
R3  max total decision cost 只报告，不设阈值 —— 单个离群点本身不是失败
```

R1 的锚（不是凭空的圆整数）：incumbent master 在 480 ms 预算下**从未被记录到错过窗口**，
其最坏单次决策为开发机 126.72 ms、目标手机 139–157 ms，即预算的 26–33%。
1.00% 比 incumbent 的实测行为**宽一个数量级**，同时仍然约束尾部。

**Android / WebView 本轮只做 characterization，不设门槛**：本机没有 emulator
（CI-only），真机测量是另一个决策（见 §11）。

## 10. 体积口径（冻结）

```
S1  dist/assets/ai-worker-<hash>.js raw bytes
S2  gzip level 9 (node zlib) of that same file
    —— 与 scripts/check-bundle.mjs 强制的口径**完全相同**
S3  dist/ 全部文件 raw bytes 合计
S4  dist/ 全部 asset 各自 gzip -9 后合计（compressed distributable size）
S5  历史预算 123,575 B gzip（enhanced AI worker asset）
```

**没有 brotli**：仓库中不存在 brotli 记账，不引入第二口径。
分别报告 baseline / prototype / absolute delta / percentage delta，
以及 CHEAP model raw、packaged、production compression 后的贡献、
π1 model 贡献、JS/runtime glue 贡献、feature code 贡献。

**禁止**再用 `landlord gzip + farmer gzip = worker bundle` 这种相加口径。
**禁止**为了让预算变绿而修改 `scripts/check-bundle.mjs` 的 limit。

## 11. 平台（冻结）

```
reference      desktop Chromium（Playwright，production dist 由 vite preview 提供）
Android        本机无 emulator（无 AVD、SDK 无 emulator/system-images；/dev/kvm 存在
               但非本用户可写）。真机 f28c4fbd = Xiaomi 10S，Android 11 / SDK 30，
               .debug 已安装且当前连接。
               真机测量会 force-stop 用户正在玩的牌局，且需要先构建并安装一个
               带本原型的 debug APK —— **本轮不执行，作为单独决策提出**。
```

**禁止**把 desktop benchmark 写成 `mobile verified`。
未测的就是 `not yet measured on physical phone`。

## 12. 内存（冻结）

```
口径   优先 JS heap（CDP + --enable-precise-memory-info）；
       拿不到时退回 Worker/process 级别测量，并写明口径。
测     baseline worker memory / prototype worker memory / incremental model memory /
       peak during load / steady-state after initialization
检查   反复创建销毁对局、model 复用 vs 重复、多局后的增长、并发 Worker（若有）
禁止   从 model raw file size 推断 runtime memory
```

## 13. 本轮不做

new training、farmer retraining、third landlord、hyperparameter sweep、
LightGBM 替换、feature / epsilon / history-length / reward 改动、C3/C5 attribution、
**compression research**（除非本轮实测出现 §12 意义上的明确部署障碍）、
production promote、shipped-strength validation（只提交 eligibility 判断，不运行）。

## 14. 判定（冻结）

```
INTEGRATION READY FOR SHIPPED VALIDATION
    E1 == 0 且 E2 == 0 且 R1 满足 且 无其它 operational blocker
ENGINEERING BLOCKED
    E1 == 0 但存在明确工程障碍（deadline / memory / size / startup 之一materially unacceptable）
INVALID IMPLEMENTATION
    E1 != 0 或 E2 有意外分歧 —— correctness bug，STOP
```

`historical byte budget exceeded` **不是**自动 NO-GO（产品约束已更新）。
