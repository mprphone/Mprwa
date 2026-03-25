CREATE TABLE IF NOT EXISTS occurrence_types (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    source_id TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS occurrences (
    id TEXT PRIMARY KEY,
    source_id TEXT UNIQUE,
    customer_id TEXT NOT NULL,
    source_customer_id TEXT,
    customer_nif TEXT,
    date TEXT NOT NULL,
    type_id INTEGER,
    type_name TEXT,
    title TEXT NOT NULL,
    description TEXT,
    state TEXT NOT NULL DEFAULT 'ABERTA',
    due_date TEXT,
    responsible_user_id TEXT,
    responsible_ids_json TEXT,
    responsible_names_text TEXT,
    resolution TEXT,
    projeto_apoio_detalhe_json TEXT,
    supabase_payload_json TEXT,
    sync_origin TEXT NOT NULL DEFAULT 'local',
    last_synced_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS occurrence_attachments (
    id TEXT PRIMARY KEY,
    source_id TEXT UNIQUE,
    occurrence_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'foto',
    source_table TEXT,
    file_url TEXT,
    storage_path TEXT,
    original_name TEXT,
    created_at TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_occurrences_customer ON occurrences(customer_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_occurrences_state ON occurrences(state, due_date);
CREATE INDEX IF NOT EXISTS idx_occurrences_source_customer ON occurrences(source_customer_id);
CREATE INDEX IF NOT EXISTS idx_occurrence_attachments_occurrence ON occurrence_attachments(occurrence_id);
