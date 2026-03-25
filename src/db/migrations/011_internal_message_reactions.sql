CREATE TABLE IF NOT EXISTS internal_message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_message_reactions_unique
ON internal_message_reactions(message_id, user_id, emoji);

CREATE INDEX IF NOT EXISTS idx_internal_message_reactions_message
ON internal_message_reactions(message_id, created_at);
