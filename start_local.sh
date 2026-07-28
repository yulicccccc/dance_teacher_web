#!/bin/bash
# 舞蹈教学网站 — 本地一键启动（单端口：后端同时托管前端 + API）
# 用法：在 Finder 里双击本文件（会打开终端并运行），或终端里执行 bash start_local.command
# 启动后，浏览器打开 http://localhost:8000 即可使用。
# 关闭：在终端按 Ctrl+C。

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/backend"

# numba(librosa 加速引擎) 的 JIT 缓存放到系统临时目录，避免某些环境的"安全删除"钩子拦截。
if [ -z "$NUMBA_CACHE_DIR" ]; then
  NUMBA_CACHE_DIR="${TMPDIR:-/tmp}/numba_cache"
fi
mkdir -p "$NUMBA_CACHE_DIR"
export NUMBA_CACHE_DIR

VENV_PY="$SCRIPT_DIR/backend/.venv/bin/python"
VENV_UVICORN="$SCRIPT_DIR/backend/.venv/bin/uvicorn"

# 若 venv 不存在或没装依赖，自动重建（仅首次会慢，需要联网装 librosa 等）。
if [ ! -x "$VENV_UVICORN" ]; then
  echo "[setup] 首次初始化 Python 虚拟环境并安装后端依赖（librosa 等，约 1-3 分钟）..."
  /Users/claw/.workbuddy/binaries/python/versions/3.13.12/bin/python3 -m venv "$SCRIPT_DIR/backend/.venv"
  "$SCRIPT_DIR/backend/.venv/bin/pip" install --upgrade pip -q
  unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY 2>/dev/null || true
  "$SCRIPT_DIR/backend/.venv/bin/pip" install --only-binary=:all: -r "$SCRIPT_DIR/backend/requirements.txt"
fi

echo "=================================================="
echo " 舞蹈教学网站本地版已启动"
echo " 浏览器打开: http://localhost:8000"
echo " 关闭请按 Ctrl+C"
echo "=================================================="
exec "$VENV_UVICORN" app.main:app --host 0.0.0.0 --port 8000
