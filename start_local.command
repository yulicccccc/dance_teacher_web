#!/bin/bash
# Finder 入口：双击即可启动。真正的启动逻辑放在 start_local.sh，方便终端复用和测试。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! "$SCRIPT_DIR/start_local.sh"; then
  echo
  echo "启动失败。上方已经显示原因；按回车键关闭这个窗口。"
  read -r
  exit 1
fi
