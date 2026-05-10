UPDATE hr_email_autoreply_schedules
SET message = replace(replace(message, 'nn', char(10) || char(10)), ',n', ',' || char(10)),
    updated_at = CURRENT_TIMESTAMP
WHERE message LIKE '%nnObrigada%' OR message LIKE '%,n{{%';
