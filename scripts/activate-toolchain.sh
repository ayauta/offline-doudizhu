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

hash -r
echo "已激活 offline-doudizhu 工具链：Node $(node --version)，pnpm $(pnpm --version)"
