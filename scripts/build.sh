#!/bin/bash
# dsh-parallel-pool 构建门禁：junction 运行期依赖 + 语法校验。
# 纯 ESM JS（whale-girl 模式），无 TypeScript 编译步骤。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 部署目录的 node_modules（DSH 已编译包所在处）；可用 DSH_DEPLOY_MODULES 覆盖。
DEPLOY_MODULES="${DSH_DEPLOY_MODULES:-/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules}"
if [ ! -d "$DEPLOY_MODULES" ]; then
  echo "build: deploy node_modules not found at $DEPLOY_MODULES" >&2
  exit 1
fi

link_pkg() {
  local name="$1"
  local target="$DEPLOY_MODULES/$name"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const t = path.resolve(process.argv[2]);
    try {
      if (fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === t) process.exit(0);
    } catch (_missing) {}
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(t, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$name" "$target"
}

echo "=== Linking runtime deps (deploy: $DEPLOY_MODULES) ==="
mkdir -p node_modules/@deepseek-ai
link_pkg "@deepseek-ai/dsh-tools"

echo "=== Syntax check lib/index.js ==="
node --check lib/index.js

echo "=== Build complete ==="
