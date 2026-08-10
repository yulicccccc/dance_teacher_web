#!/bin/bash
# Finder 入口：停止本地服务，不删除视频、练习数据或 Docker 镜像。

set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$APP_DIR/compose.yaml"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop 当前没有运行，本地版已经是停止状态。"
  exit 0
fi

docker compose \
  --project-directory "$APP_DIR" \
  --file "$COMPOSE_FILE" \
  stop

echo "舞蹈老师本地版已停止；视频和练习数据均已保留。"
