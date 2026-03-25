-- Indexes to speed up WhatsApp contact/message lookups
-- Normalize digits by stripping +, spaces and dashes (same logic used in queries)

CREATE INDEX IF NOT EXISTS idx_messages_from_number_id
ON messages(from_number, id DESC);

CREATE INDEX IF NOT EXISTS idx_messages_from_digits_timestamp
ON messages(replace(replace(replace(ifnull(from_number, ''), '+', ''), ' ', ''), '-', ''), timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_customers_phone_digits
ON customers(replace(replace(replace(ifnull(phone, ''), '+', ''), ' ', ''), '-', ''));
