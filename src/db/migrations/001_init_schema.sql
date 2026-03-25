CREATE TABLE IF NOT EXISTS migrations (
    id TEXT PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT,
    account_id TEXT,
    from_number TEXT,
    body TEXT,
    status TEXT DEFAULT 'pending',
    direction TEXT DEFAULT 'inbound',
    media_kind TEXT,
    media_path TEXT,
    media_mime_type TEXT,
    media_file_name TEXT,
    media_size INTEGER,
    media_provider TEXT,
    media_remote_id TEXT,
    media_remote_url TEXT,
    media_meta_json TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    source_id TEXT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'AGENT',
    password TEXT,
    avatar_url TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    source_id TEXT,
    name TEXT NOT NULL,
    company TEXT NOT NULL,
    contact_name TEXT,
    phone TEXT,
    email TEXT,
    owner_id TEXT,
    type TEXT,
    contacts_json TEXT,
    allow_auto_responses INTEGER NOT NULL DEFAULT 1,
    documents_folder TEXT,
    nif TEXT,
    niss TEXT,
    senha_financas TEXT,
    senha_seg_social TEXT,
    tipo_iva TEXT,
    morada TEXT,
    customer_profile_json TEXT,
    managers_json TEXT,
    access_credentials_json TEXT,
    agregado_familiar_json TEXT,
    fichas_relacionadas_json TEXT,
    supabase_payload_json TEXT,
    supabase_updated_at TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'normal',
    due_date TEXT NOT NULL,
    assigned_user_id TEXT,
    notes TEXT,
    attachments_json TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    user_id TEXT,
    started_at TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    whatsapp_account_id TEXT,
    owner_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    last_message_at TEXT NOT NULL,
    unread_count INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS outbound_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    account_id TEXT,
    to_number TEXT NOT NULL,
    message_kind TEXT NOT NULL DEFAULT 'text',
    message_body TEXT,
    template_name TEXT,
    variables_json TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    wa_id TEXT,
    last_error TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    sent_at TEXT
);

CREATE TABLE IF NOT EXISTS outbound_dead_letter (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id INTEGER NOT NULL UNIQUE,
    conversation_id TEXT,
    account_id TEXT,
    to_number TEXT NOT NULL,
    message_kind TEXT NOT NULL,
    message_body TEXT,
    template_name TEXT,
    variables_json TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_by TEXT,
    failed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS message_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'template',
    content TEXT NOT NULL,
    meta_template_name TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id TEXT,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    action TEXT NOT NULL,
    details_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS saft_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    conversation_id TEXT,
    document_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    file_name TEXT,
    file_path TEXT,
    error TEXT,
    requested_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS saft_documents_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    customer_nif TEXT,
    document_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'collected',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_requested_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS obrigacoes_recolhas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    customer_source_id TEXT,
    obrigacao_id INTEGER NOT NULL,
    obrigacao_codigo TEXT,
    obrigacao_nome TEXT,
    periodo_tipo TEXT NOT NULL DEFAULT 'mensal',
    periodo_ano INTEGER NOT NULL,
    periodo_mes INTEGER NOT NULL DEFAULT 0,
    periodo_trimestre INTEGER NOT NULL DEFAULT 0,
    estado_codigo TEXT,
    identificacao TEXT,
    data_recebido TEXT,
    data_comprovativo TEXT,
    empresa TEXT,
    nif TEXT,
    payload_json TEXT,
    origem TEXT NOT NULL DEFAULT 'saft_dri_robot',
    synced_supabase_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_from_number ON messages(from_number, id);
CREATE INDEX IF NOT EXISTS idx_messages_account_id ON messages(account_id, id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_source_id ON users(source_id);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_source_id ON customers(source_id);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_calls_customer ON calls(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_customer ON conversations(customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_outbound_queue_status ON outbound_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbound_queue_account_id ON outbound_queue(account_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbound_dead_letter_failed_at ON outbound_dead_letter(failed_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_templates_kind ON message_templates(kind, is_active);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_saft_jobs_customer ON saft_jobs(customer_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_saft_cache_customer_doc ON saft_documents_cache(customer_id, document_type);
CREATE INDEX IF NOT EXISTS idx_saft_cache_nif_doc ON saft_documents_cache(customer_nif, document_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_obrigacoes_recolhas_unique ON obrigacoes_recolhas(customer_id, obrigacao_id, periodo_ano, periodo_mes, periodo_trimestre);
CREATE INDEX IF NOT EXISTS idx_obrigacoes_recolhas_periodo ON obrigacoes_recolhas(obrigacao_id, periodo_ano, periodo_mes, periodo_trimestre);
