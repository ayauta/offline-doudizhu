# Guardrails

本项目真实踩过的坑。每一条都对应一次**已经得出过错误结论**的测量，不是一般性建议。

1. **统计单位是 initial deal group，不是决策点。** 一局里的多个决策不独立；把它们当
   iid 会把样本量放大一个数量级，区间随之假性收窄。

2. **同一副牌下的不同角色 cell 不是 iid。** paired 设计必须按副配对，不能把
   3,600 个 cell 当独立样本汇总 —— 本项目因此得到过错误的显著性。

3. **development ≠ confirmation。** 开发池上看到的效应会变。CHEAP 的 env B 在开发池
   上是 `+2.667pp [−0.421, +5.755]`（含 0），在 fresh 池上是 `+3.450pp [+2.059, +4.841]`
   （不含 0）。**开发池上不显著不等于不存在，显著也不等于成立。**

4. **single-step ≠ takeover。** 本项目实测过分道扬镳：single-step T−π1 = `+2.182pp`
   （CI 不含 0），takeover = `−0.167pp`（CI 含 0）。**single-step 是乐观的，不能当晋级 gate。**

5. **对手身份必须显式。** "master"、"default"、"π1"、"P0" 是四种不同的对手策略。
   换训练对手 = 换一道题：同样规模、只换环境，TARGET 与 CHEAP 在两个独立评测上都分得出胜负。

6. **禁止静默排除。** 任何被排除的 group 都要逐条列出原因并计数。分母只允许因**预登记
   的** integrity failure 缩小，且必须在跑之前写明。

7. **fresh pool 必须 no-peek。** 运行中 console 只允许 progress / throughput / ETA；
   结果在 seal 后一次性 reveal。看到一个方向的 partial 结果之后再决定 N，等于没有预注册。

8. **模型、schema、协议的 identity 必须 hash。** 一次注释改动就会移动 closure identity
   ——这正是设计意图。**已被 frozen 的 identity 不要为了让测试变绿而改**：改过的 frozen
   identity 不再是 frozen identity。

9. **晋级基线是当前 champion，不是旧的 master。** AI-v3 的候选默认对 **AI-v2** 比较。
   拿旧 master 当基线会把已经入账的增益重新算一遍。

10. **手机自动化不得改动全局显示配置。** 用 `wm size` / `wm density` 去凑横屏，会在
    设备上留下一个真实的分辨率故障。改显示状态的自动化，收尾时必须能还原。

11. **判定要按环境分开，禁止混合平均。** 总体 ≈ 0 的候选可以同时包含 `+13.250pp` 与
    `−8.417pp`。平均数是唯一能同时掩盖这两者的统计量。

12. **先冻结判据，再看数字。** 门槛、margin、N、pool 范围必须在跑之前写进协议。
    看到结果之后再定"这个 fallback rate 也可以"，得到的不是结论，是拟合。
