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
    echo "[entrypoint] syncing schema"
    npx prisma db push --skip-generate
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
