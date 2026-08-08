#!/usr/bin/env bash
#
# Update and restart. Works for both deployment styles:
#
#   ./scripts/deploy.sh          build from source (docker-compose.yml)
#   ./scripts/deploy.sh --pull   pull the prebuilt image (docker-compose.ghcr.yml)
#
# Run from the repo checkout on the machine that hosts the app.
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="build"
if [ "${1:-}" = "--pull" ]; then
  MODE="pull"
fi

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example to .env and fill it in first." >&2
  exit 1
fi

COMPOSE_ARGS=()
if [ "$MODE" = "pull" ]; then
  COMPOSE_ARGS=(-f docker-compose.ghcr.yml)
  if ! grep -qE '^IMAGE=' .env; then
    echo "--pull needs IMAGE set in .env, e.g." >&2
    echo "  IMAGE=ghcr.io/you/forge-shelf:latest" >&2
    exit 1
  fi
fi

# Source updates matter either way: the compose files, entrypoint and schema all
# live in git even when the image is prebuilt.
if [ -d .git ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  BEFORE="$(git rev-parse HEAD)"

  echo "==> Pulling $BRANCH"
  git pull --ff-only origin "$BRANCH"

  AFTER="$(git rev-parse HEAD)"
  if [ "$BEFORE" = "$AFTER" ]; then
    echo "==> Source already up to date ($AFTER)"
  else
    echo "==> $BEFORE -> $AFTER"
    git --no-pager log --oneline "$BEFORE..$AFTER" | head -20
  fi
fi

if [ "$MODE" = "pull" ]; then
  echo "==> Pulling image"
  docker compose "${COMPOSE_ARGS[@]}" pull
else
  echo "==> Building"
  docker compose build
fi

echo "==> Restarting"
docker compose "${COMPOSE_ARGS[@]}" up -d --remove-orphans

echo "==> Waiting for the app to answer"
PORT="$(grep -E '^APP_PORT=' .env | cut -d= -f2 || true)"
PORT="${PORT:-8770}"

for _ in $(seq 1 45); do
  if curl -fsS "http://localhost:${PORT}/api/system/health" >/dev/null 2>&1; then
    echo "==> Healthy on port ${PORT}"
    docker compose "${COMPOSE_ARGS[@]}" ps
    exit 0
  fi
  sleep 2
done

echo "!! The app did not become healthy in 90s. Recent logs:" >&2
docker compose "${COMPOSE_ARGS[@]}" logs --tail 60 web worker >&2
exit 1
