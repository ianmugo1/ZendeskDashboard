#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DOCKER_BIN="$(command -v docker || true)"
if [[ -z "$DOCKER_BIN" && -x "/Applications/Docker.app/Contents/Resources/bin/docker" ]]; then
  DOCKER_BIN="/Applications/Docker.app/Contents/Resources/bin/docker"
fi
if [[ -z "$DOCKER_BIN" ]]; then
  echo "Docker CLI not found."
  exit 1
fi

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_root="${ROOT_DIR}/backups"
backup_dir="${backup_root}/dashboard-data-${timestamp}"
mkdir -p "$backup_dir"

if "$DOCKER_BIN" compose version >/dev/null 2>&1; then
  container_id="$("$DOCKER_BIN" compose -f docker-compose.prod.yml --env-file .env.production ps -q metrics-api)"
elif [[ -x "/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose" ]]; then
  container_id="$("/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose" -f docker-compose.prod.yml --env-file .env.production ps -q metrics-api)"
elif command -v docker-compose >/dev/null 2>&1; then
  container_id="$(docker-compose -f docker-compose.prod.yml --env-file .env.production ps -q metrics-api)"
else
  echo "Neither 'docker compose' nor 'docker-compose' is available."
  exit 1
fi

if [[ -z "$container_id" ]]; then
  echo "metrics-api container is not running."
  exit 1
fi

"$DOCKER_BIN" cp "${container_id}:/app/data" "$backup_dir/data"
tar -czf "${backup_root}/dashboard-data-${timestamp}.tgz" -C "$backup_dir" data
rm -rf "$backup_dir"

echo "Backup created: ${backup_root}/dashboard-data-${timestamp}.tgz"
