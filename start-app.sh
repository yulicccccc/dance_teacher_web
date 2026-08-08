#!/bin/bash
# 一键启动舞蹈教学应用（仅后端，单端口 8000 托管前端 dist）
# 用法：bash start-app.sh   —— 启动后浏览器打开 http://localhost:8000/
set -u

ROOT="/Users/claw/WorkBuddy/2026-07-24-22-13-28"
BACKEND="$ROOT/backend"

# 1) 杀掉残留的旧后端（避免端口占用）
pkill -f "uvicorn app.main:app" 2>/dev/null || true
sleep 1

# 2) 启动后端（它会在 8000 上托管前端 dist）
cd "$BACKEND"
source .venv/bin/activate
nohup uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/dance-backend.log 2>&1 &
echo "backend starting (pid $!)..."

# 3) 等 /health 就绪（最多 ~40s）
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health 2>/dev/null || true)
  if [ "$code" = "200" ]; then
    echo "backend is UP"
    break
  fi
  sleep 1
done

echo "----------------------------------------"
echo "打开下面这个带缓存破除参数的地址（强制最新）："
echo "http://localhost:8000/?cb=$(date +%s)"
echo "----------------------------------------"
