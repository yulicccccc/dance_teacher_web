#!/bin/bash
# 舞蹈老师本地版：用与网页部署相同的 Docker 镜像启动前后端。

set -Eeuo pipefail

# Finder/AppleScript launches with a minimal PATH, so include Docker Desktop's
# common CLI locations explicitly instead of relying on a Terminal profile.
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PORT="${DANCE_TEACHER_PORT:-8000}"
APP_URL="http://localhost:${APP_PORT}"
LOCAL_VERSION="$(tr -d '[:space:]' < "$APP_DIR/VERSION")"
APP_LAUNCH_URL="${APP_URL}/?v=${LOCAL_VERSION}"
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
    open "$APP_LAUNCH_URL"
  fi
}

read_server_version() {
  local health_body
  health_body="$(curl -fsS --max-time 5 "$APP_URL/health" 2>/dev/null || true)"
  if [[ "$health_body" =~ \"version\":\"([^\"]+)\" ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
  return 0
}

print_banner
wait_for_docker

RUNNING_CONTAINER="$("${COMPOSE_CMD[@]}" ps --quiet app 2>/dev/null || true)"
HEALTH_STATUS=""
RUNNING_VERSION=""
if [ -n "$RUNNING_CONTAINER" ]; then
  HEALTH_STATUS="$(docker inspect --format '{{.State.Health.Status}}' "$RUNNING_CONTAINER" 2>/dev/null || true)"
fi
if [ "$HEALTH_STATUS" = "healthy" ]; then
  RUNNING_VERSION="$(read_server_version)"
fi

if [ "$HEALTH_STATUS" = "healthy" ] && [ "$RUNNING_VERSION" = "$LOCAL_VERSION" ]; then
  echo "本地 v${LOCAL_VERSION} 已经在运行，正在刷新浏览器：$APP_LAUNCH_URL"
  open_app
  exit 0
fi

if [ "$HEALTH_STATUS" = "healthy" ]; then
  echo "检测到本地版本更新（运行中：${RUNNING_VERSION:-旧版}；目标：${LOCAL_VERSION}），正在自动更新……"
  if "${COMPOSE_CMD[@]}" up --detach --build --wait --wait-timeout 300; then
    STARTED=true
  else
    STARTED=false
  fi
else
  echo "正在用本机已有版本启动……"
  if ! "${COMPOSE_CMD[@]}" up --detach --no-build --wait --wait-timeout 60; then
    echo "已有版本无法启动，正在自动重新构建（可能需要几分钟）……"
    if "${COMPOSE_CMD[@]}" up --detach --build --wait --wait-timeout 300; then
      STARTED=true
    else
      STARTED=false
    fi
  else
    RUNNING_VERSION="$(read_server_version)"
    if [ "$RUNNING_VERSION" = "$LOCAL_VERSION" ]; then
      STARTED=true
    else
      echo "已有镜像是 ${RUNNING_VERSION:-旧版}，正在自动更新到 ${LOCAL_VERSION}……"
      if "${COMPOSE_CMD[@]}" up --detach --build --wait --wait-timeout 300; then
        STARTED=true
      else
        STARTED=false
      fi
    fi
  fi
fi

if [ "$STARTED" != "true" ]; then
  echo
  echo "容器启动失败，以下是最近的诊断信息："
  "${COMPOSE_CMD[@]}" ps || true
  "${COMPOSE_CMD[@]}" logs --tail 80 || true
  exit 1
fi

echo
echo "本地 v${LOCAL_VERSION} 已启动：$APP_LAUNCH_URL"
echo "视频和练习数据保存在项目的 backend/data 文件夹，不会随容器关闭而丢失。"

open_app
