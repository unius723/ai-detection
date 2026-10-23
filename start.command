#!/bin/zsh
set -eu
cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [[ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
  NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
else
  echo "未找到 Node.js。请安装 Node.js 18 或以上版本后重新打开此文件。"
  exit 1
fi

# Local testing only. Override these environment variables if needed.
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-local-test-123}"
export BIND_HOST="${BIND_HOST:-127.0.0.1}"
export PORT="${PORT:-3000}"
echo "答题页面：http://$BIND_HOST:$PORT"
echo "管理后台：http://$BIND_HOST:$PORT/admin（用户名可填 admin）"
echo "默认测试密码：local-test-123（若已设置 ADMIN_PASSWORD，则使用你设置的密码）"
echo "保持此终端开启；按 Ctrl+C 停止服务。"
exec "$NODE_BIN" server.js
