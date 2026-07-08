#!/usr/bin/env sh
# Production entrypoint (wired in via render.yaml's startCommand):
#   1. If the SQLite DB is missing from the disk (fresh disk / disaster recovery),
#      restore it from Cloudflare R2.
#   2. Run the app under `litestream replicate` so the database is continuously
#      streamed to R2 while the server is up.
#
# Fails SAFE: if the litestream binary or the R2 credentials are missing, it just
# runs the app normally (without replication) rather than refusing to boot — a
# backup misconfiguration must never take the site down.
#
# Local dev is unaffected: keep using `npm start` / `npm run dev`. This script only
# does anything when the binary + R2 env vars are present.
set -e

DB="/data/auth-store.db"
LITESTREAM="./bin/litestream"
CONFIG="litestream.yml"

# Staging must NEVER touch the production backup: skip Litestream entirely so a
# staging deploy neither REPLICATES (its throwaway data would overwrite the prod
# snapshot in R2) nor RESTORES (prod user/billing data would leak into staging).
# Matches the app's IS_STAGING truthiness (true/1/on/yes).
case "$(printf '%s' "$IS_STAGING" | tr 'A-Z' 'a-z')" in
  true|1|on|yes)
    echo "[start] IS_STAGING is set — Litestream DISABLED (staging never reads/writes the prod backup)."
    exec npm start
    ;;
esac

if [ ! -x "$LITESTREAM" ]; then
  echo "[start] litestream binary not found — starting WITHOUT replication."
  exec npm start
fi

if [ -z "$LITESTREAM_ACCESS_KEY_ID" ] || [ -z "$LITESTREAM_SECRET_ACCESS_KEY" ]; then
  echo "[start] R2 credentials not set — starting WITHOUT replication."
  exec npm start
fi

# Restore only if the DB isn't already on the disk. -if-replica-exists makes the
# very first run (empty bucket) a graceful no-op instead of an error.
if [ ! -f "$DB" ]; then
  echo "[start] no local DB at $DB — attempting restore from R2…"
  if "$LITESTREAM" restore -if-replica-exists -config "$CONFIG" "$DB"; then
    echo "[start] restore complete."
  else
    echo "[start] nothing to restore (first run / empty bucket) — continuing."
  fi
fi

echo "[start] launching app under litestream replicate…"
exec "$LITESTREAM" replicate -exec "npm start" -config "$CONFIG"
