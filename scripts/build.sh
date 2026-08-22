#!/bin/bash
# dsh-parallel-pool 构建门禁：运行期依赖落地 + 语法校验。
# 纯 ESM JS（whale-girl 模式），无 TypeScript 编译步骤。
#
# 依赖落地策略（loader 内部解析器实测只认包根 index.js、不读 package.json）：
# - dsh-tools：junction 链接（实测可用）。
# - dsh-llm 及其传递闭包（cordis/cosmokit/schemastery/dsh-timeout）：复制为
#   真实目录副本（沙箱可读路径），并生成包根 index.js 再导出（垫片）。
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

# 复制包为真实目录并生成包根 index.js 再导出（loader 内部解析器的 index.js 约定）。
copy_pkg_with_shim() {
  local name="$1"
  local target="$DEPLOY_MODULES/$name"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  rm -rf "node_modules/$name"
  cp -rL "$target" "node_modules/$name"
  local main
  main=$(node -e "
    const fs = require('fs');
    const d = JSON.parse(fs.readFileSync(process.argv[1] + '/package.json', 'utf8'));
    const exp = d.exports;
    const entry = exp && typeof exp === 'object' && !Array.isArray(exp) ? (exp['.'] || exp) : undefined;
    const imp = entry && typeof entry === 'object' ? (entry.import || entry.default) : undefined;
    console.log(imp || d.main || 'index.js');
  " "node_modules/$name")
  echo "export * from './$main'" > "node_modules/$name/index.js"
  echo "  copy+shim $name -> ./$main"
}

echo "=== Landing runtime deps (deploy: $DEPLOY_MODULES) ==="
mkdir -p node_modules/@deepseek-ai
link_pkg "@deepseek-ai/dsh-tools"
link_pkg "@deepseek-ai/dsh-settings"
copy_pkg_with_shim "@deepseek-ai/dsh-llm"
copy_pkg_with_shim "@deepseek-ai/cordis"
copy_pkg_with_shim "@deepseek-ai/cosmokit"
copy_pkg_with_shim "@deepseek-ai/schemastery"
copy_pkg_with_shim "@deepseek-ai/dsh-timeout"

echo "=== Syntax check lib/index.js ==="
node --check lib/index.js

echo "=== Import chain check ==="
node --input-type=module -e "import('./lib/index.js').then(m => console.log('  plugin import OK:', m.name)).catch(e => { console.error('  FAIL:', e.message); process.exit(1) })"

echo "=== Build complete ==="
