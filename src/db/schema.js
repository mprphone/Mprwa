const path = require('path');
const { runMigrations } = require('./migrations');

async function ensureColumn({ dbAllAsync, dbRunAsync }, tableName, columnName, alterSql) {
    const rows = await dbAllAsync(`PRAGMA table_info(${tableName})`);
    const exists = rows.some((row) => String(row.name || '').trim().toLowerCase() === String(columnName).trim().toLowerCase());
    if (!exists) {
        await dbRunAsync(alterSql);
        console.log(`[DB] Coluna adicionada: ${tableName}.${columnName}`);
    }
}

async function initializeSchema(dbHelpers) {
    const { dbRunAsync, dbAllAsync, dbExecAsync } = dbHelpers;

    await runMigrations({
        dbRunAsync,
        dbAllAsync,
        dbExecAsync,
        migrationsDir: path.resolve(__dirname, 'migrations'),
    });

    await ensureColumn(dbHelpers, 'messages', 'status', "ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'pending'");
    await ensureColumn(dbHelpers, 'messages', 'direction', "ALTER TABLE messages ADD COLUMN direction TEXT DEFAULT 'inbound'");
    await ensureColumn(dbHelpers, 'messages', 'account_id', "ALTER TABLE messages ADD COLUMN account_id TEXT");
    await ensureColumn(dbHelpers, 'messages', 'media_kind', "ALTER TABLE messages ADD COLUMN media_kind TEXT");
    await ensureColumn(dbHelpers, 'messages', 'media_path', "ALTER TABLE messages ADD COLUMN media_path TEXT");
    await ensureColumn(dbHelpers, 'messages', 'media_mime_type', "ALTER TABLE messages ADD COLUMN media_mime_type TEXT");
    await ensureColumn(dbHelpers, 'messages', 'media_file_name', "ALTER TABLE messages ADD COLUMN media_file_name TEXT");
    await ensureColumn(dbHelpers, 'messages', 'media_size', "ALTER TABLE messages ADD COLUMN media_size INTEGER");
    await ensureColumn(dbHelpers, 'messages', 'media_provider', "ALTER TABLE messages ADD COLUMN media_provider TEXT");
    await ensureColumn(dbHelpers, 'messages', 'media_remote_id', "ALTER TABLE messages ADD COLUMN media_remote_id TEXT");
    await ensureColumn(dbHelpers, 'messages', 'media_remote_url', "ALTER TABLE messages ADD COLUMN media_remote_url TEXT");
    await ensureColumn(dbHelpers, 'messages', 'media_meta_json', "ALTER TABLE messages ADD COLUMN media_meta_json TEXT");
    await ensureColumn(dbHelpers, 'users', 'is_ai_assistant', 'ALTER TABLE users ADD COLUMN is_ai_assistant INTEGER NOT NULL DEFAULT 0');
    await ensureColumn(dbHelpers, 'users', 'ai_allowed_sites_json', 'ALTER TABLE users ADD COLUMN ai_allowed_sites_json TEXT');
    await ensureColumn(dbHelpers, 'internal_messages', 'updated_at', 'ALTER TABLE internal_messages ADD COLUMN updated_at DATETIME');
    await ensureColumn(dbHelpers, 'tasks', 'attachments_json', 'ALTER TABLE tasks ADD COLUMN attachments_json TEXT');
    await ensureColumn(dbHelpers, 'conversations', 'whatsapp_account_id', 'ALTER TABLE conversations ADD COLUMN whatsapp_account_id TEXT');
    await ensureColumn(dbHelpers, 'outbound_queue', 'account_id', 'ALTER TABLE outbound_queue ADD COLUMN account_id TEXT');
    await ensureColumn(dbHelpers, 'outbound_dead_letter', 'account_id', 'ALTER TABLE outbound_dead_letter ADD COLUMN account_id TEXT');

    await ensureColumn(dbHelpers, 'customers', 'documents_folder', 'ALTER TABLE customers ADD COLUMN documents_folder TEXT');
    await ensureColumn(dbHelpers, 'customers', 'contact_name', 'ALTER TABLE customers ADD COLUMN contact_name TEXT');
    await ensureColumn(dbHelpers, 'customers', 'nif', 'ALTER TABLE customers ADD COLUMN nif TEXT');
    await ensureColumn(dbHelpers, 'customers', 'niss', 'ALTER TABLE customers ADD COLUMN niss TEXT');
    await ensureColumn(dbHelpers, 'customers', 'senha_financas', 'ALTER TABLE customers ADD COLUMN senha_financas TEXT');
    await ensureColumn(dbHelpers, 'customers', 'senha_seg_social', 'ALTER TABLE customers ADD COLUMN senha_seg_social TEXT');
    await ensureColumn(dbHelpers, 'customers', 'tipo_iva', 'ALTER TABLE customers ADD COLUMN tipo_iva TEXT');
    await ensureColumn(dbHelpers, 'customers', 'morada', 'ALTER TABLE customers ADD COLUMN morada TEXT');
    await ensureColumn(dbHelpers, 'customers', 'customer_profile_json', 'ALTER TABLE customers ADD COLUMN customer_profile_json TEXT');
    await ensureColumn(dbHelpers, 'customers', 'managers_json', 'ALTER TABLE customers ADD COLUMN managers_json TEXT');
    await ensureColumn(dbHelpers, 'customers', 'access_credentials_json', 'ALTER TABLE customers ADD COLUMN access_credentials_json TEXT');
    await ensureColumn(dbHelpers, 'customers', 'agregado_familiar_json', 'ALTER TABLE customers ADD COLUMN agregado_familiar_json TEXT');
    await ensureColumn(dbHelpers, 'customers', 'fichas_relacionadas_json', 'ALTER TABLE customers ADD COLUMN fichas_relacionadas_json TEXT');
    await ensureColumn(dbHelpers, 'customers', 'supabase_payload_json', 'ALTER TABLE customers ADD COLUMN supabase_payload_json TEXT');
    await ensureColumn(dbHelpers, 'customers', 'supabase_updated_at', 'ALTER TABLE customers ADD COLUMN supabase_updated_at TEXT');

    await dbRunAsync(
        `CREATE TABLE IF NOT EXISTS sync_state (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`
    );

    await dbRunAsync(
        `UPDATE saft_jobs
         SET status = 'error',
             error = COALESCE(NULLIF(error, ''), 'Job interrompido por reinício do servidor.'),
             updated_at = CURRENT_TIMESTAMP
         WHERE status = 'processing'`
    );

    await dbRunAsync(
        `UPDATE internal_messages
         SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
         WHERE updated_at IS NULL`
    );

    await dbRunAsync(
        `CREATE INDEX IF NOT EXISTS idx_messages_account_id
         ON messages(account_id, id)`
    );

    await dbRunAsync(
        `CREATE INDEX IF NOT EXISTS idx_outbound_queue_account_id
         ON outbound_queue(account_id, status, next_attempt_at)`
    );

    await dbRunAsync(
        `CREATE INDEX IF NOT EXISTS idx_customers_contact_name
         ON customers(contact_name)`
    );
}

module.exports = {
    initializeSchema,
};
