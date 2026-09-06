# 单机斗地主

`offline-doudizhu` 是为家人制作的纯本地斗地主：一名真人玩家与两名本地
AI 对局，不登录、不收集数据、没有广告或付费，也没有后端。

当前纯 TypeScript 引擎已经支持完整牌型、合法动作、发牌叫地主、出牌过牌、
胜负重开，以及两台只读取脱敏视图的合法基线与休闲启发式 AI；确定性自动
对局可以从发牌运行到结束。网页已经把这些能力接成一局完整的正式牌局：从
安静首页进入叫地主，完成出牌、提示、不出、胜负结算、再来一局或返回首页；
点击和横向滑过牌面都可选牌，竖屏只提示旋转。

## 技术边界

- 同时维护标准 Web/PWA 与私人 Android APK；正式移动基线为 Android 10+
  Chrome/System WebView。
- Preact 负责轻量视图组合，原生 CSS
  负责布局；不使用 Canvas、CSS 框架或全局状态库。
- `src/core` 是不依赖 DOM、浏览器或平台的纯 TypeScript。
- Vite 一次生成静态 `dist/`：`index.html` 用于 Web/PWA，`embedded.html`
  用于 Android；PWA 工具只预缓存自己的固定同源构建文件。
- 应用源码没有网络请求、远程字体/图片、账号、统计或遥测。
- Android 使用最小原生 WebView 壳安全加载包内输出，无 Android 权限、
  JS-native bridge 或原生业务逻辑；不使用第三方跨平台包装器，也不上架。

## 本地开发

需要 Node.js 24 和 pnpm 11.24.0。

当前受管工作区已经在 `.local/` 准备好固定版本。每次打开新终端，先在项目
根目录激活一次：

```bash
source scripts/activate-toolchain.sh
```

看到 `Node v24.20.0，pnpm 11.24.0` 后，该终端即可直接使用 `pnpm`。

## 打开试玩

```bash
source scripts/activate-toolchain.sh
pnpm dev
```

终端会显示本地地址，通常是 `http://localhost:5173/`。在 Windows 浏览器中
打开它，并把窗口调整为横向（宽度大于高度）。按 `Ctrl+C` 停止服务。

目前浏览器中可以体验完整的本地牌局：

- 点击一张牌可选择/取消，按住并横向滑过多张牌可连续选择或取消；
- `提示` 只选择建议牌，不会自动出牌；不合法的牌会给出简短原因；
- 两位 AI 会在本地依次叫牌和出牌，不读取彼此或玩家的隐藏手牌；
- `返回` 会先确认是否结束本局，结算后可返回首页或重新发牌；
- 竖屏只显示旋转提示，转回横屏会继续同一局；浏览器重载仍从首页开始。

若想模拟安装后的静态版本：

```bash
pnpm build
pnpm preview
```

再打开终端显示的预览地址。首次加载成功后，自动化测试会验证它可以断网重载。

```text
pnpm install --frozen-lockfile
pnpm dev
pnpm check
```

常用命令：`pnpm test` 运行确定性测试，`pnpm test:browser` 使用仓库固定的
Playwright 与 Chromium 运行验收，`pnpm build` 生成 PWA，`pnpm typecheck`
进行严格类型检查。浏览器测试可以把文件和标题筛选直接传给 Playwright：

```bash
pnpm test:browser e2e/production-table.spec.ts -g "quiet card"
```

需要留下人工复核截图时，在相同命令前加 `VISUAL_REVIEW=1`；截图和本次运行
记录写入已忽略的 `output/playwright/`，不会进入提交：

```bash
VISUAL_REVIEW=1 pnpm test:browser e2e/production-table.spec.ts -g "quiet card"
```

## Android 调试包

先生成并验证 Web 制品，再由 Android 工程打包同一份 `dist/`：

```bash
source scripts/activate-toolchain.sh
pnpm build
pnpm check:bundle
pnpm check:android
cd android
./gradlew lintDebug assembleDebug
```

APK 位于 `android/app/build/outputs/apk/debug/`，构建输出已忽略。Android
工程需要 JDK 17、Android SDK 36 和 Build Tools 36；Gradle 由仓库 wrapper
固定为 9.6.0。Release 构建只从 `OFFLINE_DDZ_KEYSTORE`、
`OFFLINE_DDZ_KEYSTORE_PASSWORD`、`OFFLINE_DDZ_KEY_ALIAS`、
`OFFLINE_DDZ_KEY_PASSWORD` 环境变量读取仓库外签名信息。

产品范围、规则和隐私承诺见 `docs/product-spec.md`；依赖方向和状态所有权
见 `ARCHITECTURE.md`；功能顺序见 `docs/specs/README.md`，最近完成的工作见
`docs/specs/040-production-table-ui/` 与
`docs/exec-plans/completed/012-production-table-ui.md`。Android 交付见 Spec 044；真机调优将在 Spec 043
按 `docs/device-tests/043-physical-phone-checklist.md` 执行；这里不提前声明
Redmi K60E 或 Redmi K70 Pro 已通过真机验收。

## 许可

Apache License 2.0。第三方直接依赖的用途、版本、许可和维护成本记录在
`docs/research/toolchain-dependencies.md`。
