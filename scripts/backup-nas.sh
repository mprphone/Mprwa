#!/bin/bash
# ─── NAS Backup Script (semanal — sábados) ───────────────
# Reads config from .env: NAS_HOST, NAS_USER, NAS_SSH_PORT, NAS_BACKUP_PATH
# Rotation: keeps only the LATEST backup, deletes any previous ones
# Usage: ./scripts/backup-nas.sh [--db-only]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$LOG_DIR"

# Load .env — use node to safely parse (handles # and $ in values)
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env not found at $ENV_FILE"
    exit 1
fi

eval "$(node -e "
  const fs = require('fs');
  const lines = fs.readFileSync('$ENV_FILE','utf8').split('\n');
  const keys = ['NAS_HOST','NAS_USER','NAS_PASSWORD','NAS_SSH_PORT','NAS_BACKUP_PATH'];
  for (const line of lines) {
    const m = line.match(/^(\w+)=(.*)/);
    if (m && keys.includes(m[1])) {
      // Escape single quotes for safe bash export
      const val = m[2].trim().replace(/'/g, \"'\\\\''\" );
      console.log('export ' + m[1] + \"='\" + val + \"'\");
    }
  }
")"

# Validate config
if [ -z "${NAS_HOST:-}" ] || [ -z "${NAS_USER:-}" ] || [ -z "${NAS_BACKUP_PATH:-}" ]; then
    echo "ERROR: NAS config incomplete in .env (need NAS_HOST, NAS_USER, NAS_BACKUP_PATH)"
    exit 1
fi

NAS_SSH_PORT="${NAS_SSH_PORT:-22}"
DATE=$(date +%Y%m%d_%H%M%S)
WEEK_TAG=$(date +%Y_W%V)
DB_FILE="$PROJECT_DIR/whatsapp.db"
REMOTE="$NAS_USER@$NAS_HOST"
SSH_OPTS="-p $NAS_SSH_PORT -o ConnectTimeout=15 -o StrictHostKeyChecking=no -o ServerAliveInterval=30"

# Auth: prefer SSH key, fallback to sshpass
SSH_CMD="ssh"
if [ -f "$HOME/.ssh/id_ed25519" ] || [ -f "$HOME/.ssh/id_rsa" ]; then
    echo "Using SSH key authentication"
elif [ -n "${NAS_PASSWORD:-}" ]; then
    if ! command -v sshpass >/dev/null 2>&1; then
        echo "Installing sshpass..."
        sudo apt-get install -y sshpass >/dev/null 2>&1
    fi
    export SSHPASS="$NAS_PASSWORD"
    SSH_CMD="sshpass -e ssh"
    echo "Using password authentication (sshpass)"
else
    echo "ERROR: No SSH key found and no NAS_PASSWORD set"
    exit 1
fi

echo "═══════════════════════════════════════"
echo "  NAS Backup — $DATE (semana $WEEK_TAG)"
echo "  Target: $REMOTE:$NAS_BACKUP_PATH"
echo "═══════════════════════════════════════"

# [1] Test SSH connection
echo "[1/4] Testing SSH connection..."
if ! $SSH_CMD $SSH_OPTS "$REMOTE" "echo OK" >/dev/null 2>&1; then
    echo "ERROR: Cannot SSH to $REMOTE (port $NAS_SSH_PORT)"
    echo "  → Se usa password:  verifique NAS_PASSWORD no .env"
    echo "  → Se usa SSH key:   ssh-copy-id -p $NAS_SSH_PORT $REMOTE"
    exit 1
fi
echo "  ✓ SSH OK"

# [2] Ensure remote backup directory exists
echo "[2/4] Creating remote directories..."
$SSH_CMD $SSH_OPTS "$REMOTE" "mkdir -p '$NAS_BACKUP_PATH/db' '$NAS_BACKUP_PATH/code' '$NAS_BACKUP_PATH/media'"

# [3] Backup database
echo "[3/4] Backing up database..."
if [ -f "$DB_FILE" ]; then
    TEMP_BACKUP="/tmp/whatsapp_backup_$DATE.db"

    # Safe SQLite backup
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$DB_FILE" ".backup '$TEMP_BACKUP'"
    else
        cp "$DB_FILE" "$TEMP_BACKUP"
    fi

    DB_BACKUP_NAME="whatsapp_$WEEK_TAG.db"
    rsync -az -e "$SSH_CMD $SSH_OPTS" "$TEMP_BACKUP" "$REMOTE:$NAS_BACKUP_PATH/db/$DB_BACKUP_NAME"
    rm -f "$TEMP_BACKUP"
    echo "  ✓ Database → $DB_BACKUP_NAME"

    # Rotation: keep only the latest backup, delete all older ones
    $SSH_CMD $SSH_OPTS "$REMOTE" "cd '$NAS_BACKUP_PATH/db' && ls -t whatsapp_*.db 2>/dev/null | tail -n +2 | xargs rm -f 2>/dev/null || true"
    echo "  ✓ Previous DB backups deleted (keeping only latest)"
else
    echo "  ⚠ No database file found, skipping"
fi

if [ "${1:-}" = "--db-only" ]; then
    echo "═══════════════════════════════════════"
    echo "  Done (db-only mode) — $(date)"
    exit 0
fi

# [4] Backup code + media
echo "[4/4] Syncing project files..."
rsync -az --delete \
    --exclude='node_modules/' \
    --exclude='.baileys_auth/' \
    --exclude='.baileys_auth_2/' \
    --exclude='dist/' \
    --exclude='release/' \
    --exclude='backups/' \
    --exclude='*.db' \
    --exclude='*.db-journal' \
    --exclude='*.db-wal' \
    --exclude='.env' \
    --exclude='.git/' \
    --exclude='logs/' \
    -e "$SSH_CMD $SSH_OPTS" \
    "$PROJECT_DIR/" "$REMOTE:$NAS_BACKUP_PATH/code/"
echo "  ✓ Code synced (mirror)"

# Sync media (no --delete — preserve files deleted locally)
for dir in chat_media internal_chat_media customer_documents; do
    if [ -d "$PROJECT_DIR/$dir" ]; then
        rsync -az \
            -e "$SSH_CMD $SSH_OPTS" \
            "$PROJECT_DIR/$dir/" "$REMOTE:$NAS_BACKUP_PATH/media/$dir/" 2>/dev/null || true
    fi
done
echo "  ✓ Media synced"

echo "═══════════════════════════════════════"
echo "  ✅ Backup completo! $(date)"
echo "═══════════════════════════════════════"
