# 单机斗地主

`offline-doudizhu` 是为家人制作的纯本地斗地主：一名真人玩家与两名本地
AI 对局，不登录、不收集数据、没有广告或付费，也没有后端。

当前仓库正在交付 Web/PWA 架构验证切片，不是完整牌局。它保留纯
TypeScript 的 54 张牌与确定性洗牌基础，并用语义化 DOM 展示 17 张模拟手牌、
`不出 / 提示 / 出牌` 三个调试按钮以及点击/滑动选牌。竖屏只提示旋转。

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

目前能体验的是 Web/PWA 架构验证切片：

- 点击一张牌可选择/取消；按住并横向滑过多张牌可连续选择或取消；
- `不出 / 提示 / 出牌` 会更新页面上的调试动作；
- 竖屏只显示旋转提示；
- 它还没有发牌、叫地主、牌型判断、AI 出牌和胜负流程，因此暂时不能完成一局
  斗地主。

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
见 `ARCHITECTURE.md`；当前迁移见 `docs/specs/004-web-dom-platform-migration/`
与 `docs/exec-plans/active/003-web-dom-platform-migration.md`。

## 许可

Apache License 2.0。第三方直接依赖的用途、版本、许可和维护成本记录在
`docs/research/toolchain-dependencies.md`。
