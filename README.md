# 单机斗地主

一款给家人和休闲玩家使用的纯本地斗地主：一名真人玩家与两名本地 AI
完成一整局游戏。不登录、不收集数据、没有广告或付费，也没有后端。

当前版本是 **v0.1.0 公开预览版**，支持 Android 10+ 和现代桌面浏览器。

## 在线试玩与下载

- **GitHub Pages 在线版：** 首次 `v0.1.0` 发布完成后开放；安装为 PWA 后可离线启动。
- **Android APK：** 从 GitHub Releases 下载 `offline-doudizhu-v0.1.0-android.apk`。
- **源码仓库：** `ayauta/offline-doudizhu`。

Android 没有上架应用商店。首次安装需要允许浏览器或文件管理器安装未知来源
应用；安装后可以关闭该授权。APK 不申请 Android 权限，首次启动也不需要网络。
下载后可使用同一 Release 中的 `.sha256` 文件校验完整性。

## 已有功能

- 完整经典牌型、比较、合法动作和胜负流程；
- 简化的 `叫地主 / 不叫` 流程，不抢地主、不加倍、不计分；
- 两名只读取脱敏视图的本地 AI；
- `提示`、不合法原因、连续滑动选牌和清晰的横屏牌桌；
- Web/PWA 与 Android 使用同一份经过检查的静态游戏输出；
- PWA 安装后离线运行，Android 从第一次启动起完全离线运行。

## v0.1.0 已知限制

- 暂无游戏内规则查看器；
- 退出或重载后不会恢复未完成的牌局；
- 暂无声音和 AI 难度选择；
- 这是 Pre-release，不代表兼容性和界面已经达到 `v1.0` 稳定承诺。

## 开发入口

- [本地开发与验证](docs/development.md)
- [版本发布与签名恢复](docs/releasing.md)
- [产品规格](docs/product-spec.md)
- [架构](ARCHITECTURE.md)
- [规格路线图](docs/specs/README.md)
- [隐私说明](PRIVACY.md)
- [安全说明](SECURITY.md)

核心工作流是：

```text
spec -> tests -> implementation -> self-review -> playable review -> commit
```

所有提交和发布都必须通过 `pnpm check`。发布标签还会在 GitHub Actions 中
自动构建并检查签名 APK、启动 Android 模拟器执行离线/旋转/返回键冒烟测试，
然后从同一提交创建 GitHub Release 和 GitHub Pages 部署。

## 许可

Apache License 2.0。第三方直接依赖的用途、版本、许可和维护成本记录在
[工具链与依赖记录](docs/research/toolchain-dependencies.md)。
