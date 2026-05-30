CREATE TABLE IF NOT EXISTS simulator_history (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_id TEXT,
  customer_nif TEXT,
  simulator_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  saved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_simulator_history_saved_at ON simulator_history(saved_at DESC);
