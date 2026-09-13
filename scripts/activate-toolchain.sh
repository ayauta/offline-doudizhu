#!/usr/bin/env bash

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "请使用 source scripts/activate-toolchain.sh 激活当前终端。" >&2
  exit 1
fi

OFFLINE_DOUDIZHU_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OFFLINE_DOUDIZHU_NODE_VERSION="$(tr -d '\r\n' < "$OFFLINE_DOUDIZHU_ROOT/.node-version")"
OFFLINE_DOUDIZHU_NODE_BIN="$OFFLINE_DOUDIZHU_ROOT/.local/toolchains/node-v${OFFLINE_DOUDIZHU_NODE_VERSION}-linux-x64/bin"
OFFLINE_DOUDIZHU_NODE="$OFFLINE_DOUDIZHU_NODE_BIN/node"
OFFLINE_DOUDIZHU_COREPACK_HOME="$OFFLINE_DOUDIZHU_ROOT/.local/corepack"
OFFLINE_DOUDIZHU_PNPM_CLI="$OFFLINE_DOUDIZHU_ROOT/.local/corepack/v1/pnpm/11.24.0/bin/pnpm.cjs"

if [[ ! -x "$OFFLINE_DOUDIZHU_NODE" ]]; then
  echo "缺少项目本地 Node：$OFFLINE_DOUDIZHU_NODE" >&2
  return 1
fi

if [[ ! -f "$OFFLINE_DOUDIZHU_PNPM_CLI" ]]; then
  echo "缺少项目本地 pnpm：$OFFLINE_DOUDIZHU_PNPM_CLI" >&2
  return 1
fi

export OFFLINE_DOUDIZHU_ROOT
export OFFLINE_DOUDIZHU_NODE
export OFFLINE_DOUDIZHU_COREPACK_HOME
export OFFLINE_DOUDIZHU_PNPM_CLI
export COREPACK_HOME="$OFFLINE_DOUDIZHU_COREPACK_HOME"
export PATH="$OFFLINE_DOUDIZHU_NODE_BIN:$PATH"

pnpm() {
  "$OFFLINE_DOUDIZHU_NODE" "$OFFLINE_DOUDIZHU_PNPM_CLI" "$@"
}

# Android toolchain, project-local and optional.
#
# Optional because CI provisions its own JDK and SDK, and because web-only work
# must still activate on a checkout that has no local copy. These are real
# directories under `.local/android/`, not symlinks into a sibling worktree:
# the previous symlinks pointed outside this repository and vanished with the
# worktree that owned them, which is why the build once looked impossible here.
OFFLINE_DOUDIZHU_ANDROID="$OFFLINE_DOUDIZHU_ROOT/.local/android"
export OFFLINE_DOUDIZHU_ANDROID

if [[ -x "$OFFLINE_DOUDIZHU_ANDROID/jdk/bin/java" ]]; then
  export JAVA_HOME="$OFFLINE_DOUDIZHU_ANDROID/jdk"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if [[ -x "$OFFLINE_DOUDIZHU_ANDROID/sdk/platform-tools/adb" ]]; then
  export ANDROID_HOME="$OFFLINE_DOUDIZHU_ANDROID/sdk"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  export PATH="$ANDROID_HOME/platform-tools:$PATH"
fi

if [[ -d "$OFFLINE_DOUDIZHU_ANDROID/gradle-home" ]]; then
  export GRADLE_USER_HOME="$OFFLINE_DOUDIZHU_ANDROID/gradle-home"
fi

hash -r
echo "已激活 offline-doudizhu 工具链：Node $(node --version)，pnpm $(pnpm --version)"
if [[ -n "${JAVA_HOME:-}" ]]; then
  echo "  $(java -version 2>&1 | head -1)"
fi
if [[ -n "${ANDROID_HOME:-}" ]]; then
  echo "  Android SDK：$ANDROID_HOME（adb 已在 PATH）"
fi
