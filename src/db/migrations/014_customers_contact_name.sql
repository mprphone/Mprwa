-- Already handled by ensureColumn in schema.js; kept for reference only
-- ALTER TABLE customers ADD COLUMN contact_name TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_contact_name
ON customers(contact_name);
