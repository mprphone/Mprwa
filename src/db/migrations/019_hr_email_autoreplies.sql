CREATE TABLE IF NOT EXISTS hr_email_autoreply_schedules (
    id TEXT PRIMARY KEY,
    pedido_id TEXT,
    funcionario_id TEXT NOT NULL,
    funcionario_nome TEXT,
    email TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    subject TEXT NOT NULL DEFAULT 'Ausência temporária',
    message TEXT NOT NULL,
    alternate_contact TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    deactivate_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    last_action TEXT,
    last_error TEXT,
    activated_at DATETIME,
    deactivated_at DATETIME,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pedido_id)
);

CREATE INDEX IF NOT EXISTS idx_hr_email_autoreply_due
ON hr_email_autoreply_schedules(enabled, status, start_date, end_date, deactivate_date);

CREATE INDEX IF NOT EXISTS idx_hr_email_autoreply_funcionario
ON hr_email_autoreply_schedules(funcionario_id, start_date);

CREATE TABLE IF NOT EXISTS hr_email_autoreply_logs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    command TEXT,
    details_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hr_email_autoreply_logs_schedule
ON hr_email_autoreply_logs(schedule_id, created_at);
