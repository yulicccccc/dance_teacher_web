#!/bin/bash
# 中文双击入口：启动完整本地版，并由主启动脚本负责 Docker、健康检查和打开浏览器。

set -Eeuo pipefail

ENTRY_PATH="${BASH_SOURCE[0]}"
while [ -L "$ENTRY_PATH" ]; do
  ENTRY_DIR="$(cd "$(dirname "$ENTRY_PATH")" && pwd)"
  LINK_TARGET="$(readlink "$ENTRY_PATH")"
  if [[ "$LINK_TARGET" = /* ]]; then
    ENTRY_PATH="$LINK_TARGET"
  else
    ENTRY_PATH="$ENTRY_DIR/$LINK_TARGET"
  fi
done
APP_DIR="$(cd "$(dirname "$ENTRY_PATH")" && pwd)"

if ! "$APP_DIR/start_local.command"; then
  echo
  echo "启动失败。上方已经显示原因；按回车键关闭这个窗口。"
  read -r
  exit 1
fi
