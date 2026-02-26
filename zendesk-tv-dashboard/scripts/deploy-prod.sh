#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f ".env.production" ]]; then
  echo "Missing .env.production. Create it from .env.production.example first."
  exit 1
fi

get_env_value() {
  local key="$1"
  grep -E "^${key}=" .env.production | tail -n 1 | cut -d '=' -f2-
}

assert_not_placeholder() {
  local key="$1"
  local value
  value="$(get_env_value "$key")"
  if [[ -z "${value}" || "${value}" == "change-me" || "${value}" == *"change-me"* ]]; then
    echo "Refusing deploy: ${key} is empty or still using a placeholder value."
    exit 1
  fi
}

assert_not_placeholder "METRICS_API_TOKEN"
assert_not_placeholder "DASHBOARD_BASIC_AUTH_PASSWORD"
assert_not_placeholder "DASHBOARD_ANALYST_AUTH_PASSWORD"
assert_not_placeholder "DASHBOARD_ADMIN_AUTH_PASSWORD"
assert_not_placeholder "SCREENSHOT_BASIC_AUTH_PASSWORD"

DOCKER_BIN="$(command -v docker || true)"
if [[ -z "$DOCKER_BIN" && -x "/Applications/Docker.app/Contents/Resources/bin/docker" ]]; then
  DOCKER_BIN="/Applications/Docker.app/Contents/Resources/bin/docker"
fi

if [[ -z "$DOCKER_BIN" ]]; then
  echo "Docker CLI not found. Start Docker Desktop, reopen terminal, and retry."
  exit 1
fi

export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
export DOCKER_CLI_PLUGIN_EXTRA_DIRS="/Applications/Docker.app/Contents/Resources/cli-plugins"
export DOCKER_CONFIG="$ROOT_DIR/.docker-local"
mkdir -p "$DOCKER_CONFIG"
cat > "$DOCKER_CONFIG/config.json" <<'EOF'
{
  "auths": {},
  "credsStore": ""
}
EOF

if "$DOCKER_BIN" compose version >/dev/null 2>&1; then
  "$DOCKER_BIN" compose -f docker-compose.prod.yml --env-file .env.production up -d --build
  "$DOCKER_BIN" compose -f docker-compose.prod.yml --env-file .env.production ps
elif [[ -x "/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose" ]]; then
  "/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose" -f docker-compose.prod.yml --env-file .env.production up -d --build
  "/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose" -f docker-compose.prod.yml --env-file .env.production ps
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose -f docker-compose.prod.yml --env-file .env.production up -d --build
  docker-compose -f docker-compose.prod.yml --env-file .env.production ps
else
  echo "Neither 'docker compose' nor 'docker-compose' is available."
  exit 1
fi
