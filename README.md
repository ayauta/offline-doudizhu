# 单机斗地主

`offline-doudizhu` 是为家人制作的纯本地斗地主：一名真人玩家与两名本地
AI 对局，不登录、不收集数据、没有广告或付费，也没有后端。

当前纯 TypeScript 引擎已经支持完整牌型、合法动作、发牌叫地主、出牌过牌、
胜负重开，以及两台只读取脱敏视图的合法基线与休闲启发式 AI；确定性自动
对局可以从发牌运行到结束。网页仍是架构验证用的调试桌面，尚未把这些引擎
能力接成正式牌局。
它展示 17 张模拟手牌、`不出 / 提示 / 出牌` 三个调试按钮以及点击/滑动选牌，
竖屏只提示旋转。

## 技术边界

- 标准 Web 与可安装 PWA；正式移动基线为 Android 10+ Chrome/System
  WebView。
- Preact（须经 Vanilla DOM 对照 ADR 确认）负责轻量视图组合，原生 CSS
  负责布局；不使用 Canvas、CSS 框架或全局状态库。
- `src/core` 是不依赖 DOM、浏览器或平台的纯 TypeScript。
- Vite 生成静态 `dist/`；PWA 工具只预缓存固定同源构建文件。
- 应用源码没有网络请求、远程字体/图片、账号、统计或遥测。
- 未来可以把同一份静态输出包装为私人签名 Android APK；本仓库当前不
  选择包装器、不签名、不上架、不托管。

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

目前浏览器中能体验的仍是 Web/PWA 架构验证切片：

- 点击一张牌可选择/取消；按住并横向滑过多张牌可连续选择或取消；
- `不出 / 提示 / 出牌` 会更新页面上的调试动作；
- 竖屏只显示旋转提示；
- 正式发牌、叫地主、AI 出牌和胜负流程已经存在于核心引擎，但尚未连接到这个
  调试页面，因此网页暂时不能完成一局斗地主。

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

常用命令：`pnpm test` 运行确定性测试，`pnpm test:browser` 运行 Chromium
验收，`pnpm build` 生成 PWA，`pnpm typecheck` 进行严格类型检查。

产品范围、规则和隐私承诺见 `docs/product-spec.md`；依赖方向和状态所有权
见 `ARCHITECTURE.md`；功能顺序见 `docs/specs/README.md`，最近完成的工作见
`docs/specs/031-casual-heuristic-ai/` 与
`docs/exec-plans/completed/011-casual-heuristic-ai.md`。

## 许可

Apache License 2.0。第三方直接依赖的用途、版本、许可和维护成本记录在
`docs/research/toolchain-dependencies.md`。
