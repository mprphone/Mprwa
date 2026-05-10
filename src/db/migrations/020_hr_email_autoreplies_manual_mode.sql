ALTER TABLE hr_email_autoreply_schedules ADD COLUMN template_variant TEXT NOT NULL DEFAULT 'default';
ALTER TABLE hr_email_autoreply_schedules ADD COLUMN alternate_contact_email TEXT;
ALTER TABLE hr_email_autoreply_schedules ADD COLUMN alternate_contact_phone TEXT;
ALTER TABLE hr_email_autoreply_schedules ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE hr_email_autoreply_schedules ADD COLUMN manual_url TEXT;
ALTER TABLE hr_email_autoreply_schedules ADD COLUMN activation_alert_at DATETIME;
ALTER TABLE hr_email_autoreply_schedules ADD COLUMN deactivation_alert_at DATETIME;
