CREATE TABLE IF NOT EXISTS blocked_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    contact_key TEXT NOT NULL,
    reason TEXT,
    created_by TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blocked_contacts_unique ON blocked_contacts(channel, contact_key);
CREATE INDEX IF NOT EXISTS idx_blocked_contacts_active ON blocked_contacts(is_active, channel, contact_key);
