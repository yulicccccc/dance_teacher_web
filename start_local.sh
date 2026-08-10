#!/bin/bash
# 舞蹈老师本地版：用与网页部署相同的 Docker 镜像启动前后端。

set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PORT="${DANCE_TEACHER_PORT:-8000}"
APP_URL="http://localhost:${APP_PORT}"
COMPOSE_FILE="$APP_DIR/compose.yaml"
COMPOSE_CMD=(
  docker compose
  --project-directory "$APP_DIR"
  --file "$COMPOSE_FILE"
)

print_banner() {
  echo "=================================================="
  echo " 舞蹈老师 · 本地一键启动"
  echo "=================================================="
}

wait_for_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "没有找到 Docker。请先安装并打开 Docker Desktop。"
    return 1
  fi

  if docker info >/dev/null 2>&1; then
    return 0
  fi

  if [ "$(uname -s)" = "Darwin" ] && open -Ra Docker >/dev/null 2>&1; then
    echo "Docker Desktop 还没运行，正在替你打开……"
    open -gja Docker
    for _attempt in $(seq 1 60); do
      if docker info >/dev/null 2>&1; then
        echo "Docker 已就绪。"
        return 0
      fi
      sleep 2
    done
  fi

  echo "Docker Desktop 未能就绪。请确认它已完成启动后再试。"
  return 1
}

open_app() {
  if [ "$(uname -s)" = "Darwin" ]; then
    open "$APP_URL"
  fi
}

print_banner
wait_for_docker

RUNNING_CONTAINER="$("${COMPOSE_CMD[@]}" ps --quiet app 2>/dev/null || true)"
HEALTH_STATUS=""
if [ -n "$RUNNING_CONTAINER" ]; then
  HEALTH_STATUS="$(docker inspect --format '{{.State.Health.Status}}' "$RUNNING_CONTAINER" 2>/dev/null || true)"
fi

if [ "$HEALTH_STATUS" = "healthy" ]; then
  echo "本地版已经在运行，正在打开浏览器：$APP_URL"
  open_app
  exit 0
fi

echo "正在构建最新前后端并启动（首次约需几分钟，之后通常很快）……"
if ! "${COMPOSE_CMD[@]}" up --detach --build --wait --wait-timeout 300; then
  echo
  echo "容器启动失败，以下是最近的诊断信息："
  "${COMPOSE_CMD[@]}" ps || true
  "${COMPOSE_CMD[@]}" logs --tail 80 || true
  exit 1
fi

echo
echo "本地版已启动：$APP_URL"
echo "视频和练习数据保存在项目的 backend/data 文件夹，不会随容器关闭而丢失。"

open_app
