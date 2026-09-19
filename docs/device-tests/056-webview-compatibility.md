# Spec 056 Android WebView 兼容性真机检查

本检查用于已连接、已解锁且保持前台的 Android 调试包。它复用
`scripts/phone-probe.mjs` 的 ADB forward 与 Chrome DevTools Protocol 连接，
不输出设备序列号。

先安装本次源码构建的 debug APK，再运行：

```bash
source scripts/activate-toolchain.sh
pnpm probe:phone:compat -- --adb <adb-path> --adb-server-port <port>
```

未指定 `--adb` 与 `--adb-server-port` 时使用当前 PATH 和 ADB 默认 server。
Windows ADB 使用非默认 server port 时显式传入两项；不要把本机路径、设备序列号
或探针原始输出提交到仓库。

探针会冷启动 `io.github.ayauta.offlinedoudizhu.debug`，通过 CDP 读取能力与 DOM
几何，通过 ADB 注入由 DOM 坐标推导的点击/划动，然后通过 CDP 验证：

- 目标 WebView 的 `.at`、`Object.hasOwn`、`structuredClone`、`100dvh`、
  Pointer Events 与 Web Animations 能力；
- 正向快速跨过四张牌只选中经过牌；
- 反向划回可取消这四张牌；
- 单击只切换一张牌；
- 页面执行期间没有未处理异常。

## 2026-09-19 设备验证

设备：小米 10S（`M2102J2SC`），Android 11（API 30），System WebView
`90.0.4430.210`；app 冷启动后在前台。探针打在源码构建出的 debug APK 上，该 APK
的 SHA-256 与设备上已安装的 `base.apk` 一致。

| 项 | 结果 |
| --- | --- |
| `.at` / `Object.hasOwn` / `structuredClone` / `100dvh` | 缺失（WebView 90 基线，符合预期） |
| Pointer Events / Web Animations | 可用 |
| 正向快速跨过四张牌 | 只选中经过的四张，未扩散到相邻牌 |
| 反向划回 | 这四张全部取消 |
| 单击 | 只切换一张 |
| 页面未处理异常 | 0 |

能力读数说明修复方向是对的：WebView 90 缺的正是源码先前依赖的那几个 built-in，
修复后应用运行时不再需要它们。本节不含设备序列号，也不含探针原始输出。

这是一项开发者触发的焦点兼容 smoke，不是 CI emulator shell smoke。它不自动证明
触摸舒适度、两种横屏握持、发热、系统返回键或完整对局；这些仍按 ADR 0014 的
真机人工清单抽查。pointer cancel、移出后返回和单击阈值由确定性状态机测试与
Playwright 验收覆盖。
