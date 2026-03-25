function createTaskRepository(deps) {
    const {
        dbAllAsync,
        dbGetAsync,
        dbRunAsync,
        parseJsonArray,
    } = deps;

    function normalizeTaskStatus(value) {
        const candidate = String(value || '').trim().toLowerCase();
        if (candidate === 'done') return 'done';
        if (candidate === 'in_progress') return 'in_progress';
        if (candidate === 'waiting') return 'waiting';
        return 'open';
    }

    function normalizeTaskPriority(value) {
        const candidate = String(value || '').trim().toLowerCase();
        return candidate === 'urgent' ? 'urgent' : 'normal';
    }

    function parseTaskAttachmentsArray(rawValue) {
        return parseJsonArray(rawValue)
            .map((item) => ({
                id: String(item?.id || '').trim(),
                name: String(item?.name || '').trim(),
                mimeType: String(item?.mimeType || item?.type || '').trim() || 'application/octet-stream',
                size: Number(item?.size || 0),
                dataUrl: String(item?.dataUrl || item?.url || '').trim(),
                createdAt: String(item?.createdAt || '').trim() || new Date().toISOString(),
            }))
            .filter((item) => item.id && item.name && item.dataUrl);
    }

    function normalizeLocalSqlTask(row) {
        if (!row) return null;
        const id = String(row.id || '').trim();
        const conversationId = String(row.conversation_id || '').trim();
        const title = String(row.title || '').trim();
        const dueDateRaw = String(row.due_date || '').trim();
        if (!id || !conversationId || !title || !dueDateRaw) return null;

        return {
            id,
            conversationId,
            title,
            status: normalizeTaskStatus(row.status),
            priority: normalizeTaskPriority(row.priority),
            dueDate: dueDateRaw,
            assignedUserId: String(row.assigned_user_id || '').trim() || '',
            notes: String(row.notes || '').trim() || undefined,
            attachments: parseTaskAttachmentsArray(row.attachments_json),
        };
    }

    async function getLocalTasks(conversationId) {
        const query = conversationId
            ? {
                  sql: `SELECT id, conversation_id, title, status, priority, due_date, assigned_user_id, notes, attachments_json
                        FROM tasks WHERE conversation_id = ? ORDER BY datetime(updated_at) DESC`,
                  params: [conversationId],
              }
            : {
                  sql: `SELECT id, conversation_id, title, status, priority, due_date, assigned_user_id, notes, attachments_json
                        FROM tasks ORDER BY datetime(updated_at) DESC`,
                  params: [],
              };

        const rows = await dbAllAsync(query.sql, query.params);
        return rows.map(normalizeLocalSqlTask).filter(Boolean);
    }

    async function upsertLocalTask(input) {
        const taskId = String(input.id || '').trim() || `t${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const existing = await dbGetAsync('SELECT * FROM tasks WHERE id = ? LIMIT 1', [taskId]);

        const conversationId = String(input.conversationId || existing?.conversation_id || '').trim();
        const title = String(input.title || existing?.title || '').trim();
        const dueDate = String(input.dueDate || existing?.due_date || '').trim() || new Date().toISOString();
        const status = normalizeTaskStatus(input.status || existing?.status);
        const priority = normalizeTaskPriority(input.priority || existing?.priority);
        const assignedUserId = String(input.assignedUserId || existing?.assigned_user_id || '').trim();
        const notes = input.notes !== undefined ? String(input.notes || '').trim() : String(existing?.notes || '').trim();
        const attachments =
            input.attachments !== undefined
                ? parseTaskAttachmentsArray(input.attachments)
                : parseTaskAttachmentsArray(existing?.attachments_json);
        const attachmentsJson = attachments.length > 0 ? JSON.stringify(attachments) : null;

        if (!conversationId || !title) {
            throw new Error('Tarefa requer conversationId e title.');
        }

        await dbRunAsync(
            `INSERT INTO tasks (
                id, conversation_id, title, status, priority, due_date, assigned_user_id, notes, attachments_json, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
               conversation_id = excluded.conversation_id,
               title = excluded.title,
               status = excluded.status,
               priority = excluded.priority,
               due_date = excluded.due_date,
               assigned_user_id = excluded.assigned_user_id,
               notes = excluded.notes,
               attachments_json = excluded.attachments_json,
               updated_at = CURRENT_TIMESTAMP`,
            [taskId, conversationId, title, status, priority, dueDate, assignedUserId || null, notes || null, attachmentsJson]
        );

        const savedRow = await dbGetAsync('SELECT * FROM tasks WHERE id = ? LIMIT 1', [taskId]);
        return normalizeLocalSqlTask(savedRow);
    }

    function normalizeCallSource(value) {
        const source = String(value || '').trim().toLowerCase();
        return source === 'import' ? 'import' : 'manual';
    }

    function normalizeLocalSqlCall(row) {
        if (!row) return null;

        const id = String(row.id || '').trim();
        const customerId = String(row.customer_id || '').trim();
        const startedAt = String(row.started_at || '').trim();
        if (!id || !customerId || !startedAt) return null;

        return {
            id,
            customerId,
            userId: String(row.user_id || '').trim() || null,
            startedAt,
            durationSeconds: Number(row.duration_seconds || 0),
            notes: String(row.notes || '').trim() || undefined,
            source: normalizeCallSource(row.source),
        };
    }

    async function getLocalCalls(customerId) {
        const query = customerId
            ? {
                  sql: `SELECT id, customer_id, user_id, started_at, duration_seconds, notes, source
                        FROM calls WHERE customer_id = ? ORDER BY datetime(started_at) DESC`,
                  params: [customerId],
              }
            : {
                  sql: `SELECT id, customer_id, user_id, started_at, duration_seconds, notes, source
                        FROM calls ORDER BY datetime(started_at) DESC`,
                  params: [],
              };

        const rows = await dbAllAsync(query.sql, query.params);
        return rows.map(normalizeLocalSqlCall).filter(Boolean);
    }

    async function upsertLocalCall(input) {
        const callId = String(input.id || '').trim() || `call${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const existing = await dbGetAsync('SELECT * FROM calls WHERE id = ? LIMIT 1', [callId]);

        const customerId = String(input.customerId || existing?.customer_id || '').trim();
        const userId = String(input.userId || existing?.user_id || '').trim();
        const startedAt = String(input.startedAt || existing?.started_at || '').trim() || new Date().toISOString();
        const durationSeconds = Number(input.durationSeconds ?? existing?.duration_seconds ?? 0);
        const notes = input.notes !== undefined ? String(input.notes || '').trim() : String(existing?.notes || '').trim();
        const source = normalizeCallSource(input.source || existing?.source);

        if (!customerId) {
            throw new Error('Chamada requer customerId.');
        }

        await dbRunAsync(
            `INSERT INTO calls (
                id, customer_id, user_id, started_at, duration_seconds, notes, source, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
               customer_id = excluded.customer_id,
               user_id = excluded.user_id,
               started_at = excluded.started_at,
               duration_seconds = excluded.duration_seconds,
               notes = excluded.notes,
               source = excluded.source`,
            [callId, customerId, userId || null, startedAt, Number.isFinite(durationSeconds) ? durationSeconds : 0, notes || null, source]
        );

        const savedRow = await dbGetAsync('SELECT * FROM calls WHERE id = ? LIMIT 1', [callId]);
        return normalizeLocalSqlCall(savedRow);
    }

    return {
        normalizeLocalSqlTask,
        getLocalTasks,
        upsertLocalTask,
        normalizeLocalSqlCall,
        getLocalCalls,
        upsertLocalCall,
    };
}

module.exports = { createTaskRepository };
