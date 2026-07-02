'use strict';

/**
 * Task, Call, Conversation, Template & Software Link routes.
 * Extracted from localDataRoutes.js for maintainability.
 */
function registerTasksCallsRoutes(context, helpers) {
    const {
        app, dbRunAsync, dbGetAsync, dbAllAsync, writeAuditLog,
        getLocalTasks, upsertLocalTask, getLocalCalls, upsertLocalCall,
        getAllLocalConversations, upsertLocalConversation,
        getLocalTemplates, upsertLocalTemplate,
        SUPABASE_URL, SUPABASE_KEY,
        SUPABASE_TAREFAS_SOURCE, SUPABASE_FUNCIONARIOS_SOURCE, SUPABASE_CLIENTS_SOURCE,
        fetchSupabaseTable, resolveSupabaseTableName,
        normalizeDigits, normalizeLookupText,
        parseSourceId, parseCustomerSourceId, nowIso,
    } = context;

    const {
        parseBoolean, normalizeSourceTaskStatus, normalizeSourceTaskPriority,
        toIsoDateTime, buildFallbackTaskSourceId, extractNifCandidates,
        appendLookupIndex, ensureSoftwareLinksSchema,
        sendResponsibleNotification,
        nowIso: nowIsoHelper,
    } = helpers;
    const _nowIso = nowIso || nowIsoHelper || (() => new Date().toISOString());

    app.get('/api/tasks/local', async (req, res) => {
        try {
            const conversationId = String(req.query.conversationId || '').trim();
            const requestingUserId = String(req.query?.userId || '').trim();

            let tasks = await getLocalTasks(conversationId || '');

            // Filtrar por utilizador se não for admin
            if (requestingUserId) {
                const userRow = await dbGetAsync(
                    'SELECT role FROM users WHERE id = ? LIMIT 1',
                    [requestingUserId]
                );
                const isAdmin = userRow?.role === 'ADMIN' || userRow?.role === 'OWNER';
                if (!isAdmin) {
                    tasks = tasks.filter(t => t.assignedUserId === requestingUserId);
                }
            }

            return res.json({ success: true, data: tasks });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao listar tarefas:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/tasks/sync', async (req, res) => {
        const body = req.body || {};
        try {
            // Verificar se a tarefa já existe ANTES do upsert (para saber se é criação ou update)
            const preExistingTask = body.id
                ? await dbGetAsync('SELECT id FROM tasks WHERE id = ? LIMIT 1', [body.id])
                : null;

            const normalized = await upsertLocalTask({
                id: body.id,
                conversationId: body.conversationId,
                title: body.title,
                status: body.status,
                priority: body.priority,
                dueDate: body.dueDate,
                assignedUserId: body.assignedUserId,
                notes: body.notes,
                attachments: body.attachments,
            });

            if (!normalized) {
                return res.status(500).json({
                    success: false,
                    error: 'Não foi possível guardar tarefa no SQLite local.',
                });
            }

            await writeAuditLog({
                actorUserId: body.actorUserId || normalized.assignedUserId || null,
                entityType: 'task',
                entityId: normalized.id,
                action: 'upsert',
                details: normalized,
            });

            // ── Automação: nova tarefa → agenda + notificação email ──────────
            // O frontend gera ID antes de enviar, por isso verificamos se já existia na BD
            const isNew = !preExistingTask;
            if (isNew && normalized.assignedUserId && normalized.dueDate) {
                try {
                    // 1. Obter email do funcionário atribuído
                    const assignee = await dbGetAsync(
                        'SELECT id, name, email FROM users WHERE id = ? LIMIT 1',
                        [normalized.assignedUserId]
                    );

                    // 2. Obter nome do cliente (via conversação → customer)
                    let customerName = '';
                    if (normalized.conversationId) {
                        const conv = await dbGetAsync(
                            `SELECT c.company, c.name as cname
                             FROM conversations cv
                             LEFT JOIN customers c ON c.id = cv.customer_id
                             WHERE cv.id = ? LIMIT 1`,
                            [normalized.conversationId]
                        );
                        customerName = String(conv?.company || conv?.cname || '').trim();
                    }
                    if (!customerName && body.customerId) {
                        const cust = await dbGetAsync(
                            'SELECT company, name FROM customers WHERE id = ? LIMIT 1',
                            [body.customerId]
                        );
                        customerName = String(cust?.company || cust?.name || '').trim();
                    }

                    // 3. Calcular startsAt / endsAt para a agenda
                    const dueRaw = String(normalized.dueDate || '').trim();
                    // Se só tem data (sem hora), usar 09:00; se tem hora, usar tal e qual
                    const hasTime = /T\d{2}:\d{2}/.test(dueRaw);
                    const startsAt = hasTime ? dueRaw : dueRaw.replace(/T.*/, '') + 'T09:00:00.000Z';
                    const endsAt   = hasTime
                        ? new Date(new Date(dueRaw).getTime() + 30 * 60000).toISOString()
                        : dueRaw.replace(/T.*/, '') + 'T09:30:00.000Z';

                    // 4. Criar evento na agenda
                    const agendaId = `ag_task_${normalized.id}`;
                    await dbRunAsync(
                        `INSERT INTO agenda_events (id, title, type, customer_id, assigned_user_id, starts_at, ends_at, notes, source, created_at, updated_at)
                         VALUES (?, ?, 'other', ?, ?, ?, ?, ?, 'task', ?, ?)
                         ON CONFLICT(id) DO NOTHING`,
                        [
                            agendaId,
                            String(normalized.title || 'Tarefa').trim(),
                            customerName ? (await dbGetAsync('SELECT id FROM customers WHERE company=? OR name=? LIMIT 1', [customerName, customerName]))?.id || null : null,
                            normalized.assignedUserId,
                            startsAt,
                            endsAt,
                            String(normalized.notes || '').trim() || null,
                            _nowIso(),
                            _nowIso(),
                        ]
                    );

                    // 5. Enviar email com .ics ao funcionário
                    if (assignee?.email && sendResponsibleNotification) {
                        await sendResponsibleNotification({
                            to: assignee.email,
                            entityType: 'Tarefa',
                            entityId: normalized.id,
                            title: normalized.title,
                            description: [
                                customerName ? `Cliente: ${customerName}` : '',
                                normalized.notes || '',
                            ].filter(Boolean).join('\n'),
                            startsAt,
                            endsAt,
                            location: '',
                            customerName,
                        }).catch((e) => console.error('[Task Auto] Notificação falhou:', e?.message));
                    }
                } catch (autoErr) {
                    // Automação não deve bloquear a resposta
                    console.error('[Task Auto] Erro na automação agenda/email:', autoErr?.message);
                }
            }
            // ────────────────────────────────────────────────────────────────

            return res.json({
                success: true,
                storage: 'sqlite_local',
                task: normalized,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao atualizar tarefa:', details);
            return res.status(500).json({
                success: false,
                error: details,
            });
        }
    });

    app.delete('/api/tasks/:id', async (req, res) => {
        const taskId = String(req.params.id || '').trim();
        const actorUserId = String(req.query?.actorUserId || req.body?.actorUserId || '').trim() || null;

        if (!taskId) {
            return res.status(400).json({
                success: false,
                error: 'Tarefa inválida.',
            });
        }

        try {
            const existing = await dbGetAsync(
                `SELECT id, conversation_id, title, status, priority, due_date, assigned_user_id, notes, updated_at
                 FROM tasks
                 WHERE id = ?
                 LIMIT 1`,
                [taskId]
            );

            if (!existing?.id) {
                return res.status(404).json({
                    success: false,
                    error: 'Tarefa não encontrada.',
                });
            }

            await dbRunAsync('DELETE FROM tasks WHERE id = ?', [taskId]);

            await writeAuditLog({
                actorUserId,
                entityType: 'task',
                entityId: taskId,
                action: 'delete',
                details: {
                    id: String(existing.id || '').trim(),
                    conversationId: String(existing.conversation_id || '').trim(),
                    title: String(existing.title || '').trim(),
                    status: String(existing.status || '').trim(),
                    priority: String(existing.priority || '').trim(),
                    dueDate: String(existing.due_date || '').trim(),
                    assignedUserId: String(existing.assigned_user_id || '').trim() || null,
                    notes: String(existing.notes || '').trim() || null,
                    deletedAt: nowIso(),
                },
            });

            return res.json({
                success: true,
                deletedTaskId: taskId,
                storage: 'sqlite_local',
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao eliminar tarefa:', details);
            return res.status(500).json({
                success: false,
                error: details,
            });
        }
    });

    app.post('/api/tasks/import/supabase', (_req, res) => {
        // Tarefas vivem apenas no WA PRO (SQLite). Import do Supabase desativado — dados migrados.
        return res.status(410).json({ success: false, error: 'Import de tarefas do Supabase desativado. As tarefas existem apenas no WA PRO.' });
    });

    app.get('/api/calls/local', async (req, res) => {
        try {
            const customerId = String(req.query.customerId || '').trim();
            const calls = await getLocalCalls(customerId || '');
            return res.json({ success: true, data: calls });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao listar chamadas:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/calls/sync', async (req, res) => {
        const body = req.body || {};
        try {
            const normalized = await upsertLocalCall({
                id: body.id,
                customerId: body.customerId,
                userId: body.userId,
                startedAt: body.startedAt,
                durationSeconds: body.durationSeconds,
                notes: body.notes,
                source: body.source,
            });

            if (!normalized) {
                return res.status(500).json({
                    success: false,
                    error: 'Não foi possível guardar chamada no SQLite local.',
                });
            }

            await writeAuditLog({
                actorUserId: body.actorUserId || normalized.userId || null,
                entityType: 'call',
                entityId: normalized.id,
                action: 'upsert',
                details: normalized,
            });

            return res.json({
                success: true,
                storage: 'sqlite_local',
                call: normalized,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao atualizar chamada:', details);
            return res.status(500).json({
                success: false,
                error: details,
            });
        }
    });

    app.get(['/api/conversations/local', '/api/chat/conversations/local'], async (req, res) => {
        try {
            const conversations = await getAllLocalConversations();
            return res.json({ success: true, data: conversations });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao listar conversas:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post(['/api/conversations/sync', '/api/chat/conversations/sync'], async (req, res) => {
        const body = req.body || {};
        try {
            const normalized = await upsertLocalConversation({
                id: body.id,
                customerId: body.customerId,
                whatsappAccountId: body.whatsappAccountId,
                ownerId: body.ownerId,
                status: body.status,
                lastMessageAt: body.lastMessageAt,
                unreadCount: body.unreadCount,
            });

            if (!normalized) {
                return res.status(500).json({
                    success: false,
                    error: 'Não foi possível guardar conversa no SQLite local.',
                });
            }

            await writeAuditLog({
                actorUserId: body.actorUserId || body.ownerId || null,
                entityType: 'conversation',
                entityId: normalized.id,
                action: 'upsert',
                details: normalized,
            });

            return res.json({ success: true, conversation: normalized });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao atualizar conversa:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/templates', async (req, res) => {
        try {
            const kind = String(req.query.kind || '').trim();
            const templates = await getLocalTemplates(kind);
            return res.json({ success: true, data: templates });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao listar templates:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/templates/sync', async (req, res) => {
        const body = req.body || {};
        try {
            const template = await upsertLocalTemplate({
                id: body.id,
                name: body.name,
                kind: body.kind,
                content: body.content,
                metaTemplateName: body.metaTemplateName,
                isActive: body.isActive,
            });
            await writeAuditLog({
                actorUserId: body.actorUserId || null,
                entityType: 'template',
                entityId: template?.id || null,
                action: 'upsert',
                details: template,
            });
            return res.json({ success: true, template });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao guardar template:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.delete('/api/templates/:id', async (req, res) => {
        const templateId = String(req.params.id || '').trim();
        if (!templateId) {
            return res.status(400).json({ success: false, error: 'Template inválido.' });
        }

        try {
            await dbRunAsync('DELETE FROM message_templates WHERE id = ?', [templateId]);
            await writeAuditLog({
                actorUserId: String(req.query.actorUserId || '').trim() || null,
                entityType: 'template',
                entityId: templateId,
                action: 'delete',
            });
            return res.json({ success: true });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao apagar template:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/software-links', async (_req, res) => {
        try {
            await ensureSoftwareLinksSchema();
            const rows = await dbAllAsync(
                `SELECT id, name, url, image_url, sort_order
                 FROM software_links
                 ORDER BY sort_order ASC, lower(name) ASC`
            );

            const data = (Array.isArray(rows) ? rows : [])
                .map((row) => ({
                    id: String(row?.id || '').trim(),
                    name: String(row?.name || '').trim(),
                    url: String(row?.url || '').trim(),
                    imageUrl: String(row?.image_url || '').trim(),
                }))
                .filter((row) => row.id && row.name);

            return res.json({ success: true, data });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Software Links] Erro ao listar links:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.put('/api/software-links', async (req, res) => {
        try {
            await ensureSoftwareLinksSchema();
            const rawLinks = Array.isArray(req.body?.links) ? req.body.links : [];
            const actorUserId = String(req.body?.actorUserId || '').trim() || null;

            const sanitized = [];
            const seenIds = new Set();
            for (const item of rawLinks) {
                const name = String(item?.name || '').trim();
                if (!name) continue;

                const fallbackId = `sw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
                const id = String(item?.id || fallbackId).trim();
                if (!id || seenIds.has(id)) continue;
                seenIds.add(id);

                sanitized.push({
                    id,
                    name,
                    url: String(item?.url || '').trim(),
                    imageUrl: String(item?.imageUrl || '').trim(),
                    sortOrder: sanitized.length,
                });
            }

            await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
            try {
                await dbRunAsync('DELETE FROM software_links');
                for (const row of sanitized) {
                    await dbRunAsync(
                        `INSERT INTO software_links (id, name, url, image_url, sort_order, updated_at, updated_by)
                         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
                        [row.id, row.name, row.url, row.imageUrl, row.sortOrder, actorUserId]
                    );
                }
                await dbRunAsync('COMMIT');
            } catch (transactionError) {
                await dbRunAsync('ROLLBACK').catch(() => null);
                throw transactionError;
            }

            return res.json({
                success: true,
                data: sanitized.map((row) => ({ id: row.id, name: row.name, url: row.url, imageUrl: row.imageUrl })),
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Software Links] Erro ao guardar links:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });
}

module.exports = { registerTasksCallsRoutes };
