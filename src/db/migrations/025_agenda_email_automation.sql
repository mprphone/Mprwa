CREATE TABLE IF NOT EXISTS agenda_events (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'meeting',
    customer_id TEXT,
    assigned_user_id TEXT,
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    location TEXT,
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    source_email_uid TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agenda_events_starts_at ON agenda_events(starts_at);
CREATE INDEX IF NOT EXISTS idx_agenda_events_assigned_user_id ON agenda_events(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_agenda_events_customer_id ON agenda_events(customer_id);

CREATE TABLE IF NOT EXISTS email_automation_processed (
    mailbox TEXT NOT NULL,
    uid TEXT NOT NULL,
    action_type TEXT,
    entity_type TEXT,
    entity_id TEXT,
    subject TEXT,
    from_email TEXT,
    status TEXT NOT NULL DEFAULT 'processed',
    error TEXT,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (mailbox, uid)
);
