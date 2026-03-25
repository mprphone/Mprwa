CREATE TABLE IF NOT EXISTS supabase_pedidos_tracking (
    supabase_pedido_id TEXT PRIMARY KEY,
    supabase_table TEXT NOT NULL DEFAULT 'pedidos',
    requester_user_id TEXT NOT NULL,
    requester_name TEXT,
    manager_user_id TEXT,
    tipo TEXT,
    descricao TEXT,
    status_last TEXT NOT NULL DEFAULT 'PENDENTE',
    status_notified TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_supabase_pedidos_tracking_requester
ON supabase_pedidos_tracking(requester_user_id, status_last);

CREATE INDEX IF NOT EXISTS idx_supabase_pedidos_tracking_open
ON supabase_pedidos_tracking(closed_at, updated_at DESC);
