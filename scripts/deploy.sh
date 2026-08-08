#!/usr/bin/env bash
#
# Pull the latest code and restart. This is the whole deploy story:
#
#   ./scripts/deploy.sh
#
# Run it from the repo checkout on the machine that hosts the app.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env found. Copy .env.example to .env and fill it in first." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BEFORE="$(git rev-parse HEAD)"

echo "==> Pulling $BRANCH"
git pull --ff-only origin "$BRANCH"

AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "==> Already up to date ($AFTER)"
else
  echo "==> $BEFORE -> $AFTER"
  git --no-pager log --oneline "$BEFORE..$AFTER" | head -20
fi

# Rebuild only when something that affects the image changed. The slicer layer
# is expensive, so Docker's cache is worth respecting.
echo "==> Building"
docker compose build

echo "==> Restarting"
docker compose up -d --remove-orphans

echo "==> Waiting for the app to answer"
PORT="$(grep -E '^APP_PORT=' .env | cut -d= -f2 || true)"
PORT="${PORT:-8770}"

for i in $(seq 1 45); do
  if curl -fsS "http://localhost:${PORT}/api/system/health" >/dev/null 2>&1; then
    echo "==> Healthy on port ${PORT}"
    docker compose ps
    exit 0
  fi
  sleep 2
done

echo "!! The app did not become healthy in 90s. Recent logs:" >&2
docker compose logs --tail 60 web worker >&2
exit 1
