# 版本发布与 Android 签名恢复

公开发布由 GitHub Actions 完成。维护者不应在本机生成 APK 后手工上传。当前
公开仓库为 `ayauta/offline-doudizhu`，首个版本是 `v0.1.0` Pre-release。

## 发布包含什么

同一个 `v*` 标签触发：

1. 完整 `pnpm check`；
2. Android lint、签名 release APK 和静态检查；
3. API 36 模拟器离线壳层冒烟测试；
4. 版本化通用 APK 与 SHA-256 文件；
5. GitHub Pages 的同提交 Web/PWA；
6. GitHub Pre-release 和中文说明。

任何一步失败都不会继续公开 Release。普通 `main` 提交不会更新 Pages。

## 一次性签名身份

Android 覆盖升级依赖同一签名证书。第一次公开发布前，优先使用仓库提供的脚本
生成项目专用长期密钥。脚本要求绝对路径且拒绝仓库内部路径和覆盖已有文件；它
生成随机口令，只把口令写入权限为 `0600` 的恢复 JSON，不打印到终端：

```bash
source scripts/activate-toolchain.sh
export JAVA_HOME=/可信的/JDK17/路径
node scripts/create-release-signing.mjs /安全且不在仓库中的绝对路径
```

输出目录内的 `.p12` 和 `-recovery.json` 必须作为一个恢复单元保存。至少保留
两个不在仓库和 GitHub 中的加密副本，并把 JSON 中的口令放入密码管理器。
恢复资料包含 keystore、store password、key alias、key password 和证书
SHA-256 指纹；丢失任一必要资料后，已经安装公开版的用户将无法直接覆盖升级。

GitHub Actions Secrets 使用以下固定名称：

- `OFFLINE_DDZ_KEYSTORE_BASE64`
- `OFFLINE_DDZ_KEYSTORE_PASSWORD`
- `OFFLINE_DDZ_KEY_ALIAS`
- `OFFLINE_DDZ_KEY_PASSWORD`

使用辅助脚本和 `gh` 写入。脚本通过标准输入传值，不会打印 Secrets：

```bash
source scripts/activate-toolchain.sh
node scripts/configure-github-signing-secrets.mjs \
  /安全且不在仓库中的绝对路径 \
  ayauta/offline-doudizhu
```

Secrets 不能作为恢复备份：GitHub 不允许再次读取其明文。

## 准备一个版本

1. 更新 `package.json` 的 `version`。
2. 更新 `android/app/build.gradle.kts` 的 `versionName`，并递增 `versionCode`。
3. 新建对应的 `docs/release-notes/vX.Y.Z.md`。
4. 更新 README 的已知限制和下载文件名。
5. 运行 `pnpm check`、Android lint/debug build 和 APK 检查。
6. 通过 Pull Request 合并到受保护的 `main`，等待必需 CI 全部通过。

版本必须一致；例如首发三处分别是 `0.1.0`、`versionCode = 1` 和标签
`v0.1.0`。`scripts/check-release-tag.mjs` 会在任何发布动作之前验证它们。

## 创建发布

确认当前 `main` 已同步且工作区干净，再创建带说明的标签：

```bash
git switch main
git pull --ff-only
git tag -a v0.1.0 -m "单机斗地主 v0.1.0"
git push origin v0.1.0
```

Actions 会确认标签提交属于远端 `main`。不要移动或覆盖已经公开的标签；修复后
递增版本，例如发布 `v0.1.1`。

用 `gh` 查看流水线和结果：

```bash
gh run list --repo ayauta/offline-doudizhu --workflow Release
gh release view v0.1.0 --repo ayauta/offline-doudizhu
```

下载 APK 后用 `.sha256` 文件复核；Android 还应通过 `apksigner verify
--verbose --print-certs`，证书指纹必须与首次公开版本记录一致。

## 失败与恢复

- CI/模拟器失败：不要创建替代手工 APK；修复源码或工作流，提交后用新标签。
- Pages 失败：Release job 会等待 Pages 成功，不会先发布 APK。
- Release 已存在：不要覆盖资产；判断是否为同一不可变提交，否则递增版本。
- Secrets 丢失：从维护者加密恢复副本重新写入四个 Secrets。
- keystore 或口令永久丢失：不能对现有安装做兼容升级；停止发布并记录签名身份
  断裂，不得悄悄换钥匙冒充正常更新。
