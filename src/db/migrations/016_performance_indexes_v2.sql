-- Extra performance indexes for frequent lookups and ordering

-- Conversations: direct lookup by customer
CREATE INDEX IF NOT EXISTS idx_conversations_customer_id
ON conversations(customer_id);

-- Calls: customer history ordered by start time
CREATE INDEX IF NOT EXISTS idx_calls_customer_started_at
ON calls(customer_id, started_at DESC);

-- Internal chat: unread count and recent message scans
CREATE INDEX IF NOT EXISTS idx_internal_messages_conv_deleted_created
ON internal_messages(conversation_id, deleted_at, created_at DESC);

-- Tasks: common user + due date sorting
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_due_date
ON tasks(assigned_user_id, due_date);
