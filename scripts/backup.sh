#!/bin/bash
# ── Permic Men's Wear — Automatic MySQL Backup ────────────────────────────────
# Cron example: 0 2 * * * /var/www/permic_v5/permic-wear-backend/scripts/backup.sh
# Keeps last 30 days of backups locally.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | grep -v '^$' | xargs)
fi

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-root}"
DB_PASS="${DB_PASS:-}"
DB_NAME="${DB_NAME:-permic_wear}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/permic-wear}"
KEEP_DAYS=30
DATE=$(date +%Y-%m-%d_%H-%M)
FILENAME="permic-wear-${DATE}.sql.gz"

mkdir -p "$BACKUP_DIR"
echo "[$(date)] Backing up $DB_NAME..."

mysqldump \
  -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
  ${DB_PASS:+-p"$DB_PASS"} \
  --single-transaction --routines --triggers --add-drop-table \
  "$DB_NAME" | gzip > "$BACKUP_DIR/$FILENAME"

echo "[$(date)] Saved: $BACKUP_DIR/$FILENAME ($(du -sh "$BACKUP_DIR/$FILENAME" | cut -f1))"
find "$BACKUP_DIR" -name "permic-wear-*.sql.gz" -mtime +${KEEP_DAYS} -delete
echo "[$(date)] Done. Kept last ${KEEP_DAYS} days."
