# 本地开发与验证

本文面向后续维护者。产品范围、依赖方向和行为规格分别以
`docs/product-spec.md`、`ARCHITECTURE.md` 和 `docs/specs/` 为准。

## 环境

- Node.js `24.20.0`
- pnpm `11.24.0`
- Android 工作需要 JDK 17、Android SDK 36 和 Build Tools 36.0.0
- Android Gradle Plugin 与 Gradle wrapper 由仓库固定

受管工作区已经在已忽略的 `.local/` 中准备 Node 和 pnpm。每个新终端先运行：

```bash
source scripts/activate-toolchain.sh
```

输出必须是 Node `v24.20.0` 和 pnpm `11.24.0`。在这个工作区中不要切换到系统
Node/Corepack，也不要重新下载工具链。

普通干净克隆不含 `.local/`。请自行安装准确版本的 Node，然后运行：

```bash
npm install --global pnpm@11.24.0
pnpm install --frozen-lockfile
```

## Web 开发

```bash
source scripts/activate-toolchain.sh
pnpm dev
```

浏览器打开终端显示的地址并使用横屏窗口。静态预览：

```bash
source scripts/activate-toolchain.sh
pnpm build
pnpm preview
```

## 验证

完整本地门禁：

```bash
source scripts/activate-toolchain.sh
pnpm check
```

它依次运行严格类型检查、确定性测试、生产构建、输出检查、Android 静态契约、
架构边界、隐私扫描和 Chromium 验收。常用的局部命令：

```bash
pnpm test
pnpm typecheck
pnpm check:privacy
pnpm test:browser e2e/production-table.spec.ts -g "quiet card"
```

人工视觉复核截图只在需要时生成，写入已忽略的 `output/playwright/`：

```bash
VISUAL_REVIEW=1 pnpm test:browser e2e/production-table.spec.ts -g "quiet card"
```

## Android 调试

Android 必须打包已经生成并检查过的同一份 `dist/`：

```bash
source scripts/activate-toolchain.sh
pnpm build
pnpm check:bundle
pnpm check:android
cd android
./gradlew lintDebug assembleDebug
```

调试 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。它使用独立的
`.debug` 包名，可以与正式版共存。APK、SDK 配置和所有 Android 构建目录都被
忽略，不能提交。

有模拟器运行时，可以对已经生成的具体 APK 执行同一项黑盒冒烟：

```bash
ANDROID_TEST_ARTIFACT_DIR=test-results/android-local \
  scripts/android-emulator-smoke.sh \
  android/app/build/outputs/apk/debug/app-debug.apk \
  io.github.ayauta.offlinedoudizhu.debug
```

GitHub Actions 在 API 29 和 36 上安装指定 debug APK，关闭可用网络，并验证
离线冷启动、横屏画面、前后台恢复、再次冷启动和 crash buffer；发布标签还会
在 API 36 上对签名 release APK 运行同一检查。Playwright 负责完整游戏逻辑、
DOM 交互、方向呈现和嵌入入口。Android 静态契约检查负责权限、WebView 加固和
系统返回实现。CI 保留 logcat 和最终截图；两种横屏方向、连续使用感受和两次
系统返回由发布前真机清单抽样，不宣称为自动化能力。

## 修改纪律

- 行为变化先更新规格并写失败测试；Bug 先写回归测试。
- 规则变化使用表驱动测试。
- 不提交 `dist/`、APK、截图、浏览器二进制、SDK、签名材料或本地配置。
- 不在 `src/core` 中使用 DOM、浏览器、Node、存储、定时器、环境随机或时间。
- 新依赖必须记录用途、替代方案、精确版本/提交、许可、边界和维护成本。
- 发布操作只按 [版本发布指南](releasing.md) 执行。
