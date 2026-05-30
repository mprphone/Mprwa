ALTER TABLE email_automation_processed ADD COLUMN raw_text TEXT;
ALTER TABLE email_automation_processed ADD COLUMN parsed_fields_json TEXT;
ALTER TABLE email_automation_processed ADD COLUMN reviewed_fields_json TEXT;
ALTER TABLE email_automation_processed ADD COLUMN ignored_at TEXT;
