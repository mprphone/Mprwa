DELETE FROM messages
WHERE wa_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM messages
    WHERE wa_id IS NOT NULL
    GROUP BY wa_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_id_unique ON messages(wa_id) WHERE wa_id IS NOT NULL;
