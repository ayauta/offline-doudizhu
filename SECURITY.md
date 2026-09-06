# Security Policy

## Supported surface

当前受支持的安全边界是本地开发、静态 Web/PWA 构建、生成的同源静态
precache worker、GitHub Pages 静态托管、离线浏览器运行，以及无权限的
公开预览 Android 包。没有服务器、账号、业务 API 或远程配置。

## Reporting

不要在公开 issue、提交、测试日志或截图中发布漏洞细节、凭据、签名材料或
个人信息。请通过仓库所有者指定的私下渠道报告，并提供最小复现、影响范围、
浏览器/构建版本及去敏后的证据。仓库当前不公开私人联系地址。

## Maintainer checks

- 所有直接依赖固定精确版本并提交 lockfile；升级需重新审查许可、传递依赖、
  构建输出和维护成本。
- `src/core` 不得接触浏览器或平台能力；共享 Web API 限于
  `src/platform/web`，PWA worker 注册限于 `src/platform/pwa`。
- 应用源码不得包含网络请求、外部资源、登录、广告、统计或遥测能力。
- 生成 worker 只缓存构建清单中的同源静态文件，不启用 runtime API cache、
  push、background sync 或跨域缓存。
- `pnpm check` 必须覆盖严格类型、确定性测试、构建检查、边界/隐私扫描和
  Playwright Chromium 的离线及交互验收。
- 构建产物、浏览器二进制、私有配置、凭据和签名材料不得提交。
- Android manifest 必须保持零权限；WebView 禁止网络、明文、文件和内容
  访问，只能加载 `WebViewAssetLoader` 映射的包内 `embedded.html`，且不得
  添加 JavaScript-native bridge。
- `v*` 发布必须通过受保护主分支、签名 APK 检查和 Android 模拟器冒烟；
  keystore 与口令只存在于仓库外恢复副本和 GitHub Actions Secrets。
- 真机可读性、触感和发热保留为非阻塞抽查，不得被描述成自动化已测能力。

Android 签名、分发渠道或公开托管范围变化需要独立威胁复核和 ADR。
