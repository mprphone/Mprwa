#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

log() {
  printf '[%s] %s\n' "$(date -Is)" "$*"
}

get_env_value() {
  local key="$1"
  local line
  line=$(grep -E "^${key}=" "$ENV_FILE" | head -n 1 || true)
  local value="${line#*=}"
  if [ "$value" != "$line" ]; then
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    printf '%s' "$value"
  fi
}

if [ ! -f "$ENV_FILE" ]; then
  log "Erro: .env não encontrado em $ENV_FILE"
  exit 1
fi

NAS_HOST="$(get_env_value NAS_HOST)"
NAS_USER="$(get_env_value NAS_USER)"
NAS_PASSWORD="$(get_env_value NAS_PASSWORD)"
NAS_SSH_PORT="$(get_env_value NAS_SSH_PORT)"
NAS_BACKUP_PATH="$(get_env_value NAS_BACKUP_PATH)"

NAS_SSH_PORT="${NAS_SSH_PORT:-22}"

if [ -z "$NAS_HOST" ] || [ -z "$NAS_USER" ] || [ -z "$NAS_BACKUP_PATH" ]; then
  log "Erro: NAS_HOST, NAS_USER e NAS_BACKUP_PATH são obrigatórios no .env"
  exit 1
fi

if [ -n "$NAS_PASSWORD" ] && ! command -v sshpass >/dev/null 2>&1; then
  log "Erro: NAS_PASSWORD definido mas sshpass não está instalado."
  exit 1
fi

SSH_OPTS="-p $NAS_SSH_PORT -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new"
if [ -f "$HOME/.ssh/id_ed25519" ] || [ -f "$HOME/.ssh/id_rsa" ]; then
  SSH_CMD=(ssh $SSH_OPTS)
  RSYNC_SSH="ssh $SSH_OPTS"
elif [ -n "$NAS_PASSWORD" ]; then
  SSH_CMD=(sshpass -p "$NAS_PASSWORD" ssh $SSH_OPTS)
  RSYNC_SSH="sshpass -p \"$NAS_PASSWORD\" ssh $SSH_OPTS"
else
  log "Erro: Sem chave SSH e NAS_PASSWORD vazio."
  exit 1
fi

REMOTE_BASE="$NAS_BACKUP_PATH"
BACKUP_DATE="$(date +%Y-%m-%d)"
REMOTE_DIR="$REMOTE_BASE/mprWA_$BACKUP_DATE"

TMP_DIR="$(mktemp -d /tmp/mprwa_backup.XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

log "A iniciar backup NAS para $NAS_HOST:$REMOTE_DIR"

"${SSH_CMD[@]}" "$NAS_USER@$NAS_HOST" "mkdir -p '$REMOTE_DIR/data'"

DB_PATH="$ROOT_DIR/whatsapp.db"
if [ -f "$DB_PATH" ]; then
  log "A criar snapshot da base de dados"
  sqlite3 "$DB_PATH" ".backup '$TMP_DIR/whatsapp.db'"
  rsync -a -e "$RSYNC_SSH" "$TMP_DIR/whatsapp.db" "$NAS_USER@$NAS_HOST:$REMOTE_DIR/data/"
else
  log "Aviso: whatsapp.db não encontrado, a ignorar"
fi

copy_dir() {
  local name="$1"
  local src="$ROOT_DIR/$name"
  if [ -d "$src" ]; then
    log "A copiar $name"
    rsync -a -e "$RSYNC_SSH" "$src/" "$NAS_USER@$NAS_HOST:$REMOTE_DIR/data/$name/"
  else
    log "Aviso: diretoria $name não encontrada, a ignorar"
  fi
}

copy_file() {
  local name="$1"
  local src="$ROOT_DIR/$name"
  if [ -f "$src" ]; then
    log "A copiar $name"
    rsync -a -e "$RSYNC_SSH" "$src" "$NAS_USER@$NAS_HOST:$REMOTE_DIR/data/"
  fi
}

copy_dir "customer_documents"
copy_dir "internal_chat_media"
copy_dir "chat_media"
copy_dir "exports"

"${SSH_CMD[@]}" "$NAS_USER@$NAS_HOST" "cat > '$REMOTE_DIR/backup_manifest.txt' <<'EOF'
backup_date=$BACKUP_DATE
source_host=$(hostname)
source_path=$ROOT_DIR
EOF"

log "A manter apenas os 2 backups mais recentes"
"${SSH_CMD[@]}" "$NAS_USER@$NAS_HOST" "cd '$REMOTE_BASE' && count=\$(ls -1d mprWA_* 2>/dev/null | wc -l | tr -d ' ') && if [ \"\$count\" -gt 2 ]; then ls -1d mprWA_* 2>/dev/null | sort | head -n \$((count-2)) | xargs -r rm -rf; fi"

log "Backup concluído"
