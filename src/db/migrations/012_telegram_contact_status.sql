CREATE TABLE IF NOT EXISTS telegram_contact_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT,
    phone_e164 TEXT NOT NULL,
    phone_digits TEXT NOT NULL,
    has_telegram INTEGER NOT NULL DEFAULT 0,
    telegram_user_id TEXT,
    telegram_username TEXT,
    telegram_first_name TEXT,
    telegram_last_name TEXT,
    telegram_phone TEXT,
    source TEXT NOT NULL DEFAULT 'user_api',
    checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    raw_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_contact_status_phone_digits
ON telegram_contact_status(phone_digits);

CREATE INDEX IF NOT EXISTS idx_telegram_contact_status_customer_id
ON telegram_contact_status(customer_id);

CREATE INDEX IF NOT EXISTS idx_telegram_contact_status_checked_at
ON telegram_contact_status(checked_at DESC);
