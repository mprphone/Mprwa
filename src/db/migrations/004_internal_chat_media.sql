ALTER TABLE internal_messages ADD COLUMN media_path TEXT;
ALTER TABLE internal_messages ADD COLUMN mime_type TEXT;
ALTER TABLE internal_messages ADD COLUMN file_name TEXT;
ALTER TABLE internal_messages ADD COLUMN file_size INTEGER;
