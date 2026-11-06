#!/usr/bin/env bash
# Example daily backup: consistent snapshot.mjs, then optional restic copy off-box.
# Install: copy to /etc/cron.daily/owndesk-backup (root) and edit paths. chmod 700.
set -euo pipefail
ROOT="/opt/owndesk"   # ← change
ENV="$ROOT/deploy/.env"
STAMP="$(date +%Y-%m-%d)"
DATA="/var/backups/owndesk/data-$STAMP"
KEYS="/var/backups/owndesk-keys/$STAMP.env"
LOG="/var/log/owndesk-backup.log"

exec >>"$LOG" 2>&1
echo "=== backup $STAMP ==="
mkdir -p "$(dirname "$DATA")" "$(dirname "$KEYS")"
# Short downtime window (Caddy/web/worker stop inside snapshot after our stop, or let snapshot check)
docker compose --file "$ROOT/deploy/compose.yaml" --env-file "$ENV" \
  stop --timeout 60 caddy web worker
node "$ROOT/scripts/snapshot.mjs" backup "$ENV" "$DATA" "$KEYS"
docker compose --file "$ROOT/deploy/compose.yaml" --env-file "$ENV" up -d

# Optional off-site (restic is BSD-2-Clause): uncomment after restic init
# export RESTIC_REPOSITORY=s3:s3.amazonaws.com/YOUR_BUCKET/owndesk
# export RESTIC_PASSWORD_FILE=/root/.owndesk-restic-password
# restic backup "$DATA" "$KEYS" --tag owndesk

# Keep two weeks of local snapshots
find /var/backups/owndesk -maxdepth 1 -type d -name 'data-*' -mtime +14 -exec rm -rf {} +
find /var/backups/owndesk-keys -type f -name '*.env' -mtime +14 -delete
echo "done"
