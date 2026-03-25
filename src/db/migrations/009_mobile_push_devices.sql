CREATE TABLE IF NOT EXISTS mobile_push_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  platform TEXT,
  device_id TEXT,
  device_model TEXT,
  os_version TEXT,
  app_version TEXT,
  user_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_user ON mobile_push_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_mobile_push_devices_active ON mobile_push_devices(is_active, last_seen_at);
