-- Performance indexes for queries identified in the audit
-- Messages: timestamp ordering and direction lookup
-- NOTE: messages.conversation_id does not exist in current schema, skipped
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction, from_number);

-- Conversations: ordering by last message
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_account ON conversations(whatsapp_account_id);

-- Customers: owner and NIF lookups
CREATE INDEX IF NOT EXISTS idx_customers_owner_id ON customers(owner_id);
CREATE INDEX IF NOT EXISTS idx_customers_nif ON customers(nif);
CREATE INDEX IF NOT EXISTS idx_customers_contact_name ON customers(contact_name);

-- Tasks: assignment and status
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_user ON tasks(assigned_user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at DESC);

-- Internal chat: timestamp ordering and member lookups
CREATE INDEX IF NOT EXISTS idx_internal_messages_timestamp ON internal_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_internal_conv_members_conv ON internal_conversation_members(conversation_id);

-- Calls: user and timestamp
CREATE INDEX IF NOT EXISTS idx_calls_user_id ON calls(user_id);
CREATE INDEX IF NOT EXISTS idx_calls_started_at ON calls(started_at DESC);

-- Obrigacoes: customer NIF and estado
CREATE INDEX IF NOT EXISTS idx_obrigacoes_nif ON obrigacoes_recolhas(nif);
CREATE INDEX IF NOT EXISTS idx_obrigacoes_estado ON obrigacoes_recolhas(estado_codigo);
