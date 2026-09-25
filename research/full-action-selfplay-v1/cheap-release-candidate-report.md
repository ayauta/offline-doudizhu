# CHEAP landlord — release candidate

状态：**release candidate，未发布**。不训练，不压缩，不运行 Node B，不开新 strength pool。
前序：[`cheap-integration-protocol.md`](cheap-integration-protocol.md)、
[`cheap-integration-report.md`](cheap-integration-report.md)。

---

## A. PHYSICAL PHONE RESULTS

设备 `f28c4fbd` = **Xiaomi 10S (M2102J2SC)**，Android **11** / SDK **30**。
已安装包 `io.github.ayauta.offlinedoudizhu.debug` versionName **0.4.0-debug** / versionCode 4。
Probe 经 CDP 注入到该 app 正在运行的 WebView，`--deals 5`。

模型身份由 probe 自己核对：`070f5b0b728176a8…`、2,019,876 bytes、512 trees、403 columns。

```
                        Xiaomi 10S      desktop（同一 bundle、同一批牌）   ratio
model JSON.parse          74.0 ms             9.3 ms                     8.0x
model parseTreeModel      39.7 ms             1.2 ms                    33.1x
first landlord decision  179.5 ms            10.9 ms                    16.5x
landlord p50               4.85 ms            0.34 ms                   14.4x
landlord p95              69.04 ms            3.52 ms                   19.6x
landlord p99             164.69 ms            9.51 ms                   17.3x
landlord max             179.50 ms           10.93 ms                   16.4x
landlord decisions            68                68                      ——
deadline fallbacks            0                  0
declines                      0                  0
policy retention          100.0%             100.0%
device legal actions      min 1 / median 2 / max 172
```

**真实 deadline 480 ms，未放宽。** 设备最坏地主决策 179.5 ms = 预算的 37%，余量 2.7×。
ratio 用**同一份 bundle、同一批牌、同样 68 个地主决策**测得——这是仓库自己的口径
（"a millisecond does not transfer between machines, but a ratio measured on the same bytes does"）。

### A.1 三个必须写清楚的限制

1. **APK 没有重新构建**：本机**没有任何 JDK**（`java` 不在 PATH，无 `/usr/lib/jvm`，
   无 Android Studio JBR），`android/local.properties` 也不存在。APK 构建在本仓库是
   **CI-only**（`reactivecircus/android-emulator-runner`）。因此
   "build/install 带 CHEAP prototype 的 debug APK" **本轮无法执行**，没有伪造。
   安装的仍是旧包；测量走的是 probe，不是 APK 自己的 worker bundle。
2. **口径是 WebView 主线程，不是 Worker 线程**：probe 在 WebView 主线程里执行
   `decideEnhancedAi`，用与 Worker 相同的 runtime 对象。**Worker 线程调度、消息传递、
   结构化克隆都不在这些数字里。** 含真实 Worker 的数字是 desktop 那一列
   （`cheap-integration-report.md` §F）。
3. **真机上的真实 Worker 路径未测**：该机只装了 `com.android.browser`（无 Chrome），
   没有可用的 CDP 目标；要测真实 Worker 需要重装带新 bundle 的 APK，而 (1) 已说明做不到。

### A.2 memory

`performance.memory` 在 WebView 中存在但**被量化**：arm 前后两次读数都是
`usedJSHeapSize = 10,000,000`，差值恒为 0，**不可用于求增量**。如实报告，不做替代推断。
进程级口径见 `cheap-integration-report.md` §H。

### A.3 一个不解释的观察

同一 probe 中，farmer 位（master，**无截止**运行）在真机上 p50 **150.3 ms**、max **2086.7 ms**，
而 desktop 同 bundle 为 p50 8.95 / max 124.4（**16.8×**）。历史记录
（`docs/device-tests/055-ai-on-device.md`）在同一机型上记的是 master 无截止 p50 49–54 ms、
max 322–364 ms。**本轮数字明显更慢，原因未查明**，可能是热节流/电量策略/机型状态，
也可能是 probe 组合不同。它**不影响**地主结论（那是分开计的），但值得记下来。

## B. FINAL PRODUCT SIZE

```
                              raw bytes      gzip -9        budget 650,000
release candidate worker      2,569,883       575,787        562.29 / 634.77 KiB
  其中冻结模型                2,019,876       450,401
  其中集成胶水（代码）            +9,144        +2,598   （相对 pre-integration）
dist 总计                     2,673,501  (2.55 MiB, 10 files)
main chunk raw                     61,124   与 pre-integration 逐字节相同
application CSS raw                21,829   相同
```

预缓存载荷 **621.22 KiB → 2,593.77 KiB**。

## C. FINAL WORKBOX / PRECACHE CONFIG

```
old Workbox limit     2 MiB  (2,097,152)      —— 当时 chunk 2.57 MB，build 直接失败
new Workbox limit     3 MiB  (3,145,728)
current worker raw    2,569,883 B
headroom              575,845 B  (22.4%)
precache before       621.22 KiB (9 entries)
precache after        2,593.77 KiB (9 entries)
```

3 MiB 是**有界**的：覆盖最大 asset 且留 22% 余量，同时在"再打一份同规模的表"（+76%）
之前就会触发。没有设置无限值，也**没有**引入 lazy-loading / split-chunk / 外部 fetch
——按 §6，产品决定是接受已确认模型的字节数，预缓存变大是这个决定的诚实后果。
`vite.config.ts` 里不残留任何 local override；测量用的 `.local/vite.prototype.config.ts`
已不再是构建路径的一部分。

## D. FINAL ENGINEERING BUDGET

```
old enhanced-worker budget   123,575 B gzip   （保留在文件里作为 provenance）
new enhanced-worker budget   650,000 B gzip
measured                     575,787 B gzip
headroom                      74,213 B (12.9% of measured)
```

**为什么不是 600,000**：600,000 只留 24,213 B（4.2%），本轮一次胶水变化就是 2,598 B——
余量虽够，但一次正常的重构就可能贴近上限，正是 §4 要避免的"频繁红灯"。
**为什么不是更松**：650,000 让 glue 类改动有约 28× 的余量，同时"再打一份模型"（+76%）
或任何同量级膨胀仍会被抓住；它不是无限放宽。
**为什么偏离仓库既有的"baseline + 最小回归的三分之一"锚**：该规则在单个冻结 artifact
主导 asset 之后失效——worker 现在是 450 KB 模型 + 约 125 KB 代码，按总量取百分比会
让模型的体积决定代码的容差，而能漂移的是代码。所以余量按**胶水**标定。
理由写在 `scripts/check-bundle.mjs` 的注释里，改的是 product budget，不是科学协议。

## E. PRODUCTION BUILD / CHECK

```
pnpm build    真实配置，**不使用任何 local bypass**   -> 通过
pnpm check    EXIT=0
  strict TypeScript            通过
  deterministic tests          53 files / 687 tests 全通过
  WebView 90 compatibility     通过
  production build             通过
  build output                 通过（Reviewed gzip budgets: main 19.99/20.51、
                               CSS 5.32/5.71、enhanced AI worker 562.29/634.77 KiB）
  Android delivery             通过
  architecture boundaries      通过（50 source files）
  privacy                      通过（63 runtime files）
  Chromium acceptance          33 passed / 2 skipped（两个是 env-gated 的测量 spec）
```

## F. FINAL RELEASE EQUIVALENCE

`Implementation regression only, not new strength evidence`。
整轮 **5 个 test 全绿**（`Tests 5 passed (5)`，EXIT=0）；下面的 latency 数字取自这次
全绿运行，不是上一次因 harness timeout 被标红、但数据已经产出的那次。
数据来自 **development pool `915001–915300`**（300 deals），**不是**新的 strength 证据。

```
                              n        结果
landlord decisions         3,532       research CHEAP vs final production Worker CHEAP
                                        **final action mismatch = 0**
                                       declines 0
farmer decisions           6,579       被收集；回归抽样 1,000
legal actions              min 1 / p50 2 / p95 58 / p99 121 / max 245

in-process latency（3,532 个地主决策，含拆解）
  total      p50 0.10  p90 1.37  p95 3.07  p99 6.32  max 12.64 ms
    feature  p50 0.02  p90 0.29  p95 0.64  p99 1.36  max  2.99
    inference p50 0.07 p90 1.07  p95 2.40  p99 4.92  max  9.68
    select   p50 0.01  p90 0.01  p95 0.02  p99 0.03  max  0.17
  leading     n 1013  p50 0.71  p99 7.58  max 12.64
  responding  n 2519  p50 0.06  p99 0.47  max  1.39
  wide sets（≥20）n 429  p50 2.77  p99 8.67  max 12.64
```

覆盖（逐类计数，全部实测非零）：

| 类别 | n | 类别 | n |
| --- | ---: | --- | ---: |
| leading | 1013 | singleAction | 1621 |
| responding | 2519 | wideSet（≥20） | 429 |
| passLegal | 2519 | canEmptyHand | 84 |
| bomb | 97 | nearTie | 18 |
| rocket | 179 | opening | 300 |
| attachment | 531 | lateGame | 2202 |
| sequence | 510 | **exactTie** | **0 —— 真实状态未覆盖** |

比较量始终是**最终执行的 action identity**，不是 raw score。
`exactTie` 在 3,532 个真实状态中一次都没出现，该规则由
`tests/app/cheap-landlord-routing.test.ts` 的 constant-model guard 覆盖（并已验红）。

## G. FARMER REGRESSION

```
pre-integration production π1  vs  final release candidate π1
样本 1,000 个真实 farmer decision
unexpected action mismatch = 0
casual-seat divergence     = 0
```

"pre-integration" 在此只能表达为**不安装 landlord runtime**（模型现在始终在树里），
两次运行使用**冻结虚拟时钟**——master rollout 读时钟，不冻结就无法把"集成改变了它"
与"调度改变了它"分开。**没有**任何 farmer 位进入过 landlord 分支。

## H. DEADLINE / FALLBACK RETENTION

```
真实 deadline 480 ms（未放宽）

                      desktop in-process   desktop browser   Xiaomi 10S
landlord decisions              3,532            74              68
deadline fallbacks                  0             0               0
other fallbacks（decline）           0             0               0
policy retention              100.000%        100.0%          100.0%
冻结门槛 R1 ≥ 99.00%             满足            满足             满足
R2 p99 ≤ 480 ms                6.32 ms         14.3 ms         164.69 ms
R3 max（只报告）              12.64 ms         14.3 ms         179.50 ms
```

设备侧余量 2.7×（最坏 179.5 ms / 480 ms）。

## I. MEMORY / STARTUP

```
startup（desktop，真实 Worker）
  cold first decision      baseline 29.8 ms      release candidate 73.3 ms
  worker created at        baseline 233.8 ms     release candidate 221.4 ms
startup（Xiaomi 10S，WebView 主线程口径）
  model JSON.parse 74.0 ms   parseTreeModel 39.7 ms   first landlord decision 179.5 ms
memory（进程级口径，node；详见前份报告 §H）
  peak during load 4.97 MB   tree table retained ~3.04 MB   steady 7.25 MB
memory（真机）  不可得：performance.memory 被量化，前后均为 10,000,000 B
```

## J. RELEASE-CANDIDATE MANIFEST

`research/full-action-selfplay-v1/ai-v2-release-candidate-manifest.json`
（由 `benchmarks/cheap-landlord-manifest.test.ts` 生成，每个值都 import 自定义它的模块，
不是正则从源码里抠出来的）。内容：

```
kind release-candidate-manifest, champion false —— 不是 champion archive，不做 promote
CHEAP model      070f5b0b728176a8…（declared）；packaged file 2,028,939 B + sha256
π1 model         010a8a4a00524f06…；threshold 0.01
schema           fa-features.ts sha256；version 1；history 12；403 columns；
                 schemaHash 502946fd7e880422…
identity  strongSeat        62f51372…  (协议 frozen a6ae8a6a…，因 decision-handler.ts 被编辑)
identity  orderedTopThree   dc92715b…  (协议 frozen e63d084e…，经源码依赖)
identity  legalActionEnumerator 7f1645ee…  未变
identity  treeEvaluator     43bc6279…  未变
identity  defaultTier       2a393860…  未变
policy    fa-landlord-v1；master tier 地主位；canonical order；tie-break；full legal set
deadline  480 ms；master 120 ms；地主路径不读 master 预算；fallback 语义
build     commit / branch / worker asset + raw + gzip / gzip budget 650000 / workbox 3145728
```

`ai-v1` 的身份未被覆盖，也没有任何东西写入 champion archive。

## K. STASH STATUS

`cl-integration` stash **已删除**。删除前核实：它是本次会话创建的（`-m cl-integration`），
内容是集成早期版本（`decision-handler.ts` 直接 import 政策的那一版），已被此后
dependency-injection 版本完全取代。`git stash list` 现仅剩
`stash@{1}: On android-private-package: codex-transfer-android-private-package`
——**不是本次会话的，未动**。不是 release blocker。

## L. FINAL VERDICT

```
RELEASE CANDIDATE READY
```

| §11 条件 | 实测 |
| --- | --- |
| physical phone acceptable | ✅ 480 ms 预算下 0 fallback、retention 100%、最坏 179.5 ms |
| production build green | ✅ 无 bypass |
| `pnpm check` green | ✅ EXIT=0，687 tests |
| 0 implementation mismatch | ✅ 3,532 个地主决策 |
| 0 unexpected farmer regression | ✅ 1,000 个农民决策 |
| deadline retention acceptable | ✅ 100% ≥ 冻结的 99% |
| size within newly approved product budget | ✅ 575,787 ≤ 650,000 B |

**旧 CHEAP independent confirmation 继续作为该策略的 strength evidence**，本轮
**没有**、也**不需要**重新消耗 fresh pool。

**未自动发布。** 下面三条是 review 时应当看到的限制，都不改变上面的判定：

1. 真机测量是 WebView 主线程口径，且 probe 自带模型字节；**APK 未重建**（本机无 JDK）。
   真实 Worker 在真机上的路径**未测**。
2. `exactTie` 在真实状态中未被覆盖，只由合成 guard 覆盖。
3. 真机 master（farmer，无截止）比 desktop 慢约 16.8×，明显慢于同机型的历史记录，
   **原因未查明**；不影响地主结论。

## M. COMMIT / WORKTREE STATUS

```
eb8e9ed  feat(release): package the confirmed landlord model, and revise its budgets
88326ba  test(ai): measure the landlord prototype, and report it READY FOR SHIPPED VALIDATION
2f2cf3d  feat(ai): route a master landlord through the confirmed CHEAP policy
450b387  docs(ai): freeze the landlord integration protocol, and soften five claims
```

worktree 干净；production π1（`src/app/ai/cf-model-data.ts`）本轮及上一轮**零改动**。
manifest 记录的 `build.commit` 是 `eb8e9ed`——即它描述的那棵树；manifest 自身的提交
必然在其之后，这是无法回避的（一个文件不能包含自己的 hash）。

本轮 `src/` 只改了一个文件：`src/app/ai/cheap-landlord-model.ts`（由 stub 变为承载
冻结模型）。`src/app/ai/decision-handler.ts`、`src/platform/web/ai-worker.ts`、
`src/core/ai/fa-features.ts`、`src/app/ai/cheap-landlord.ts` **本轮未再改动**——
策略自确认以来字节未变。

---

# ADDENDUM — ANDROID RUNTIME CLOSURE

前一轮的 §A 把真机一列标为"WebView 主线程 probe、非真实 Worker"。本轮补上了这一项。

## APK 身份（先确认，再测量）

```
build        ./gradlew assembleDebug  （AGP 9.4.0 / Gradle 9.6.0 / JDK 17）
             JDK 不存在 -> 本轮装入 .local/toolchains/jdk-17.0.20.1+1（仓库 toolchain 惯例）
             android/local.properties 指向 .local/android/sdk（gitignored）
APK          android/app/build/outputs/apk/debug/app-debug.apk
             sha256 9745ac9bdfaa38a2210754cbdfe4581feffb886a2f9c16615706e8eee796a543
包内 worker  assets/assets/ai-worker-k7BbEMss.js
             sha256 57a0b30b8cf41004a2128d6e0f41de0d2222fe8d0bac098f314c7b22be3e7361
dist worker  同一 sha256  —— **逐字节相同**
manifest     assets/ai-worker-k7BbEMss.js, 2,569,883 raw / 575,787 gzip  —— 相同
CHEAP SHA    070f5b0b728176a8fb11d6a79e585b1315b847e053a23821830e17394faac26b
π1 SHA       010a8a4a00524f0694d5881bacdd885d99243acf4d71e2b2fdcae7ae82fc3359
```

装到 `f28c4fbd`（Xiaomi 10S / Android 11 / SDK 30），走**真实产品 Worker**：
instrumentation 只包一层 `window.Worker`，不加任何 `src/` 钩子。
运行中记录的 worker URL 就是 APK 里的那份：

```
https://appassets.androidplatform.net/assets/assets/ai-worker-k7BbEMss.js
```

## 测量（真实 deadline 480 ms，未放宽）

```
deals 12      requests 309     injected 309     malformed 0     errors 0
landlord decisions 152（全部带 context）        farmer decisions 141

landlord end-to-end round trip
  p50 13.6   p90 31.3   p95 43.2   p99 92.2   max 95.3 ms     全部 < 480 ms
farmer round trip（master）
  p50 177.0  p90 255.8  p95 263.5  p99 305.3  max 320.7 ms

implementation mismatch（research reference vs 设备上真实 Worker 执行的动作）
  152 个地主决策，**0 mismatch**
deadline fallback 0      other fallback 0      policy retention **100.000%**（门槛 ≥ 99%）

cold
  worker 创建 -> 首个请求发出      0.3 ms（惰性创建，就在请求那一刻）
  首个请求 round trip（bid，含 module load + π1 parse）  277.5 ms   < 480 ms
  首个地主决策 round trip                                 58.5 ms
```

`_analysis_` 用的参考实现与 desktop 大样本那份完全相同（`scoreLegalActions` +
`argmaxAction`），比较量是**最终执行的 action identity**。

## 与上一轮 §A 的关系（不要混用）

上一轮那 68 个地主决策是 **WebView 主线程**口径（probe 自带模型字节），
本轮 152 个是 **真实 Worker** 口径。两批数字**不可相加、不可比较**，
本轮取代上一轮作为 Android closure。

## 一处仍未取得

**真机内存仍 unavailable**：`performance.memory` 在 WebView 中被量化（arm 前后均为
10,000,000 B），本轮同样无法取得可靠增量。不做替代推断。

## 判定

```
ANDROID RUNTIME PASS
  candidate/build identity correct        APK worker == dist worker == manifest worker
  implementation mismatch = 0             152 个地主决策
  unexpected farmer regression = 0        141 个 farmer 决策，0 fallback，全 ok
  policy retention >= 99%                 100.000%
  no material operational fallback        0 deadline + 0 other
  p99 < 480 ms                            92.2 ms
```
