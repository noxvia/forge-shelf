#!/bin/sh
set -e

ROLE="${1:-web}"

echo "[entrypoint] role=$ROLE storage=$STORAGE_DIR"

mkdir -p "$STORAGE_DIR/models" "$STORAGE_DIR/thumbs" "$STORAGE_DIR/slices" "$STORAGE_DIR/tmp"

wait_for_db() {
  echo "[entrypoint] waiting for database..."
  i=0
  until node -e "
    const {PrismaClient}=require('@prisma/client');
    const p=new PrismaClient();
    p.\$queryRaw\`SELECT 1\`.then(()=>process.exit(0)).catch(()=>process.exit(1));
  " 2>/dev/null; do
    i=$((i+1))
    if [ "$i" -gt 60 ]; then
      echo "[entrypoint] database did not become ready in time" >&2
      exit 1
    fi
    sleep 2
  done
  echo "[entrypoint] database is up"
}

case "$ROLE" in
  web)
    wait_for_db
    # `db push` keeps the database in sync with schema.prisma without carrying a
    # migration history. Fine for a single-tenant self-hosted app; it refuses to
    # run rather than destroy data if a change would be lossy.
    #
    # ALLOW_DATA_LOSS exists for upgrades that intentionally remove something —
    # dropping the slicing tables, say. It is opt-in and per-run on purpose: the
    # default has to be the one that protects a library you cannot re-create.
    echo "[entrypoint] syncing schema"
    if [ "${ALLOW_DATA_LOSS:-false}" = "true" ]; then
      echo "[entrypoint] ALLOW_DATA_LOSS=true — destructive schema changes are permitted"
      npx prisma db push --skip-generate --accept-data-loss
    else
      npx prisma db push --skip-generate || {
        echo ""
        echo "[entrypoint] Schema sync refused because it would drop data."
        echo "[entrypoint] If that is expected (for example upgrading past the"
        echo "[entrypoint] in-container slicer), set ALLOW_DATA_LOSS=true for one"
        echo "[entrypoint] run. Your model files on disk are never touched by this."
        exit 1
      }
    fi
    echo "[entrypoint] seeding defaults (idempotent)"
    npx tsx prisma/seed.ts || echo "[entrypoint] seed skipped"
    exec npx next start -p "${PORT:-3000}"
    ;;
  worker)
    wait_for_db
    # The web container owns migrations; the worker just waits for the schema.
    echo "[entrypoint] starting worker"
    exec npx tsx src/worker/index.ts
    ;;
  *)
    exec "$@"
    ;;
esac
