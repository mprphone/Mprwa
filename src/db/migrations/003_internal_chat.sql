CREATE TABLE IF NOT EXISTS internal_conversations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'direct',
    title TEXT,
    direct_key TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_message_at DATETIME
);

CREATE TABLE IF NOT EXISTS internal_conversation_members (
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_read_at DATETIME,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS internal_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    body TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    reply_to_message_id INTEGER,
    edited_at DATETIME,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_conversations_direct_key
ON internal_conversations(direct_key) WHERE direct_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_internal_members_user
ON internal_conversation_members(user_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_internal_messages_conversation
ON internal_messages(conversation_id, id DESC);
