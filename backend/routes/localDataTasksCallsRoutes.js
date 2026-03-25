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
    } = helpers;

    app.get('/api/tasks/local', async (req, res) => {
        try {
            const conversationId = String(req.query.conversationId || '').trim();
            const tasks = await getLocalTasks(conversationId || '');
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

    app.post('/api/tasks/import/supabase', async (req, res) => {
        try {
            if (!SUPABASE_URL || !SUPABASE_KEY || typeof fetchSupabaseTable !== 'function') {
                return res.status(400).json({ success: false, error: 'Supabase não configurado para importação de tarefas.' });
            }

            const force = parseBoolean(req.body?.force);
            const actorUserId = String(req.body?.actorUserId || '').trim() || null;

            const tasksTableRequested = String(req.body?.tasksTable || SUPABASE_TAREFAS_SOURCE || 'tarefas').trim();
            const usersTableRequested = String(req.body?.usersTable || SUPABASE_FUNCIONARIOS_SOURCE || 'funcionarios').trim();
            const customersTableRequested = String(req.body?.customersTable || SUPABASE_CLIENTS_SOURCE || 'clientes').trim();

            const tasksTable = typeof resolveSupabaseTableName === 'function'
                ? await resolveSupabaseTableName(tasksTableRequested, ['public.tarefas', 'tarefas'])
                : tasksTableRequested;
            const usersTable = typeof resolveSupabaseTableName === 'function'
                ? await resolveSupabaseTableName(usersTableRequested, ['public.funcionarios', 'funcionarios'])
                : usersTableRequested;
            const customersTable = typeof resolveSupabaseTableName === 'function'
                ? await resolveSupabaseTableName(customersTableRequested, ['public.clientes', 'clientes'])
                : customersTableRequested;

            const [sourceTasksRows, sourceUsersRows, sourceCustomersRows, localUsersRows, localCustomersRows] = await Promise.all([
                fetchSupabaseTable(tasksTable),
                fetchSupabaseTable(usersTable).catch(() => []),
                fetchSupabaseTable(customersTable).catch(() => []),
                dbAllAsync('SELECT id, source_id, email, name FROM users'),
                dbAllAsync('SELECT id, source_id, nif, name, company, owner_id FROM customers'),
            ]);

            const toSourceCandidates = (rawValue, parser) => {
                const raw = String(rawValue || '').trim();
                if (!raw) return [];
                const out = new Set([raw]);
                const parserA = parser(raw, '');
                const parserB = parser('', raw);
                if (parserA) out.add(String(parserA).trim());
                if (parserB) out.add(String(parserB).trim());
                if (raw.startsWith('ext_u_') || raw.startsWith('ext_c_')) out.add(raw.slice(6));
                if (raw.includes(':')) out.add(raw.split(':').pop());
                return Array.from(out).filter(Boolean);
            };

            const sourceUserById = new Map();
            sourceUsersRows.forEach((row) => {
                const sourceId = String(row?.id || '').trim();
                if (!sourceId) return;
                sourceUserById.set(sourceId, {
                    id: sourceId,
                    email: String(row?.email || '').trim().toLowerCase(),
                });
            });

            const localUserBySource = new Map();
            const localUserByEmail = new Map();
            localUsersRows.forEach((row) => {
                const localUserId = String(row?.id || '').trim();
                if (!localUserId) return;

                const sourceRaw = String(row?.source_id || '').trim();
                for (const key of toSourceCandidates(sourceRaw, parseSourceId)) {
                    localUserBySource.set(key, localUserId);
                }

                const email = String(row?.email || '').trim().toLowerCase();
                if (email) localUserByEmail.set(email, localUserId);
            });

            const sourceCustomerById = new Map();
            const sourceCustomerByNif = new Map();
            const sourceCustomerByLookup = new Map();
            sourceCustomersRows.forEach((row) => {
                const id = String(row?.id || '').trim();
                const nif = normalizeDigits(String(row?.nif || '').trim());
                const name = String(row?.nome || row?.name || '').trim();
                const company = String(row?.empresa || row?.company || '').trim();
                const payload = { id, nif, name, company, row };
                if (id) sourceCustomerById.set(id, payload);
                if (nif) sourceCustomerByNif.set(nif, payload);
                appendLookupIndex(sourceCustomerByLookup, normalizeLookupText(name), payload);
                appendLookupIndex(sourceCustomerByLookup, normalizeLookupText(company), payload);
            });

            const localCustomerBySource = new Map();
            const localCustomerByNif = new Map();
            const localCustomerByLookup = new Map();
            localCustomersRows.forEach((row) => {
                const payload = {
                    id: String(row?.id || '').trim(),
                    sourceId: String(row?.source_id || '').trim(),
                    nif: normalizeDigits(String(row?.nif || '').trim()),
                    name: String(row?.name || '').trim(),
                    company: String(row?.company || '').trim(),
                    ownerId: String(row?.owner_id || '').trim(),
                };
                if (!payload.id) return;

                for (const key of toSourceCandidates(payload.sourceId, parseCustomerSourceId)) {
                    localCustomerBySource.set(key, payload);
                }
                if (payload.nif) localCustomerByNif.set(payload.nif, payload);
                appendLookupIndex(localCustomerByLookup, normalizeLookupText(payload.name), payload);
                appendLookupIndex(localCustomerByLookup, normalizeLookupText(payload.company), payload);
            });

            async function ensureLocalCustomerFromSource(sourceCustomer) {
                const sourceId = String(sourceCustomer?.id || '').trim();
                if (!sourceId) return null;

                for (const key of toSourceCandidates(sourceId, parseCustomerSourceId)) {
                    const current = localCustomerBySource.get(key);
                    if (current?.id) return current;
                }

                const sourceRow = sourceCustomer?.row || sourceCustomerById.get(sourceId)?.row || null;
                if (!sourceRow) return null;

                const localId = 'ext_c_' + sourceId;
                const name = String(sourceRow?.nome || sourceRow?.name || sourceRow?.cliente || sourceRow?.empresa || '').trim() || sourceCustomer?.name || ('Cliente ' + sourceId);
                const company = String(sourceRow?.empresa || sourceRow?.company || sourceRow?.entidade || '').trim() || sourceCustomer?.company || name;
                const phone = String(sourceRow?.telefone || sourceRow?.telemovel || sourceRow?.phone || sourceRow?.whatsapp || '').trim();
                const email = String(sourceRow?.email || sourceRow?.mail || '').trim().toLowerCase();
                const nifRaw = String(sourceRow?.nif || sourceCustomer?.nif || '').trim();
                const nifNormalized = normalizeDigits(nifRaw);

                await dbRunAsync(
                    `INSERT INTO customers (
                        id, source_id, name, company, phone, email, owner_id, type, contacts_json, allow_auto_responses, nif, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'Empresa', '[]', 1, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(id) DO UPDATE SET
                        source_id = excluded.source_id,
                        name = excluded.name,
                        company = excluded.company,
                        phone = excluded.phone,
                        email = excluded.email,
                        nif = excluded.nif,
                        updated_at = CURRENT_TIMESTAMP`,
                    [localId, sourceId, name, company, phone || null, email || null, nifRaw || null]
                );

                const localPayload = {
                    id: localId,
                    sourceId,
                    nif: nifNormalized,
                    name,
                    company,
                    ownerId: '',
                };

                for (const key of toSourceCandidates(sourceId, parseCustomerSourceId)) {
                    localCustomerBySource.set(key, localPayload);
                }
                if (nifNormalized) localCustomerByNif.set(nifNormalized, localPayload);
                appendLookupIndex(localCustomerByLookup, normalizeLookupText(name), localPayload);
                appendLookupIndex(localCustomerByLookup, normalizeLookupText(company), localPayload);

                return localPayload;
            }

            function pickSourceCustomerByText(clienteText) {
                const raw = String(clienteText || '').trim();
                if (!raw) return null;

                const nifCandidates = extractNifCandidates(raw);
                for (const nif of nifCandidates) {
                    const byNif = sourceCustomerByNif.get(nif);
                    if (byNif) return byNif;
                }

                const lookup = normalizeLookupText(raw);
                if (!lookup) return null;

                const exact = sourceCustomerByLookup.get(lookup);
                if (Array.isArray(exact) && exact.length > 0) return exact[0];

                for (const list of sourceCustomerByLookup.values()) {
                    const found = list.find((item) => {
                        const nameLookup = normalizeLookupText(item?.name || '');
                        const companyLookup = normalizeLookupText(item?.company || '');
                        return (
                            (nameLookup && (nameLookup.includes(lookup) || lookup.includes(nameLookup))) ||
                            (companyLookup && (companyLookup.includes(lookup) || lookup.includes(companyLookup)))
                        );
                    });
                    if (found) return found;
                }

                return null;
            }

            const summary = {
                tasksTable,
                usersTable,
                customersTable,
                sourceTasks: Array.isArray(sourceTasksRows) ? sourceTasksRows.length : 0,
                imported: 0,
                updated: 0,
                skippedExisting: 0,
                skippedNoTitle: 0,
                skippedNoCustomer: 0,
                failed: 0,
                createdConversations: 0,
                warnings: [],
            };

            for (const row of sourceTasksRows) {
                try {
                    const sourceTaskIdRaw = String(row?.id || '').trim() || buildFallbackTaskSourceId(row);
                    const localTaskId = `ext_t_${sourceTaskIdRaw}`;
                    const title = String(row?.titulo || row?.title || '').trim();
                    if (!title) {
                        summary.skippedNoTitle += 1;
                        continue;
                    }

                    const existingTask = await dbGetAsync('SELECT id FROM tasks WHERE id = ? LIMIT 1', [localTaskId]);
                    if (existingTask && !force) {
                        summary.skippedExisting += 1;
                        continue;
                    }

                    const clienteText = String(row?.cliente || row?.cliente_nome || row?.customer || '').trim();
                    const sourceCustomer = pickSourceCustomerByText(clienteText);

                    let localCustomer = null;
                    if (sourceCustomer?.id) {
                        for (const key of toSourceCandidates(sourceCustomer.id, parseCustomerSourceId)) {
                            const match = localCustomerBySource.get(key);
                            if (match) {
                                localCustomer = match;
                                break;
                            }
                        }
                    }
                    if (!localCustomer && sourceCustomer?.nif) {
                        localCustomer = localCustomerByNif.get(sourceCustomer.nif) || null;
                    }
                    if (!localCustomer && clienteText) {
                        const lookup = normalizeLookupText(clienteText);
                        const byLookup = localCustomerByLookup.get(lookup);
                        if (Array.isArray(byLookup) && byLookup.length > 0) localCustomer = byLookup[0];
                    }
                    if (!localCustomer && sourceCustomer) {
                        const lookup = normalizeLookupText(sourceCustomer.company || sourceCustomer.name || '');
                        const byLookup = localCustomerByLookup.get(lookup);
                        if (Array.isArray(byLookup) && byLookup.length > 0) localCustomer = byLookup[0];
                    }
                    if (!localCustomer && sourceCustomer?.id) {
                        localCustomer = await ensureLocalCustomerFromSource(sourceCustomer);
                    }

                    if (!localCustomer?.id) {
                        summary.skippedNoCustomer += 1;
                        if (summary.warnings.length < 30) {
                            summary.warnings.push(`Sem cliente local para tarefa "${title}" (${clienteText || 'sem cliente'}).`);
                        }
                        continue;
                    }

                    const existingConversation = await dbGetAsync(
                        'SELECT id, owner_id, status, unread_count, last_message_at FROM conversations WHERE customer_id = ? LIMIT 1',
                        [localCustomer.id]
                    );

                    const conversation = await upsertLocalConversation({
                        id: String(existingConversation?.id || '').trim() || undefined,
                        customerId: localCustomer.id,
                        ownerId: String(existingConversation?.owner_id || '').trim() || localCustomer.ownerId || null,
                        status: String(existingConversation?.status || '').trim() || 'open',
                        lastMessageAt: String(existingConversation?.last_message_at || '').trim() || nowIso(),
                        unreadCount: Number(existingConversation?.unread_count || 0),
                    });

                    if (!existingConversation?.id) {
                        summary.createdConversations += 1;
                    }

                    let assignedUserId = '';
                    const sourceAssignedId = String(row?.atribuido_a || row?.responsavel_id || '').trim();
                    if (sourceAssignedId) {
                        for (const key of toSourceCandidates(sourceAssignedId, parseSourceId)) {
                            const localId = localUserBySource.get(key);
                            if (localId) {
                                assignedUserId = localId;
                                break;
                            }
                        }
                    }

                    if (!assignedUserId && sourceAssignedId) {
                        const sourceUser = sourceUserById.get(sourceAssignedId);
                        if (sourceUser?.email) {
                            assignedUserId = localUserByEmail.get(sourceUser.email) || '';
                        }
                    }
                    if (!assignedUserId) {
                        assignedUserId = String(localCustomer.ownerId || '').trim();
                    }

                    const dueDate = toIsoDateTime(row?.prazo || row?.data_inicio || row?.created_at || nowIso());
                    const status = normalizeSourceTaskStatus(row?.status);
                    const priority = normalizeSourceTaskPriority(row?.tipo, row?.status);

                    const taskType = String(row?.tipo || '').trim().toUpperCase();
                    const taskPeriodicidade = String(row?.periodicidade || '').trim().toUpperCase();
                    const sourceNotes = String(row?.notas || '').trim();
                    const notesParts = [];
                    if (sourceNotes) notesParts.push(sourceNotes);
                    if (taskType) notesParts.push(`[Tipo] ${taskType}`);
                    if (taskPeriodicidade) notesParts.push(`[Periodicidade] ${taskPeriodicidade}`);
                    if (clienteText) notesParts.push(`[Cliente origem] ${clienteText}`);
                    const notes = notesParts.join('\n').trim();

                    const saved = await upsertLocalTask({
                        id: localTaskId,
                        conversationId: conversation.id,
                        title,
                        status,
                        priority,
                        dueDate,
                        assignedUserId,
                        notes,
                    });

                    if (!saved?.id) {
                        summary.failed += 1;
                        if (summary.warnings.length < 30) {
                            summary.warnings.push(`Falha ao guardar tarefa "${title}".`);
                        }
                        continue;
                    }

                    if (existingTask) summary.updated += 1;
                    else summary.imported += 1;
                } catch (taskError) {
                    summary.failed += 1;
                    if (summary.warnings.length < 30) {
                        summary.warnings.push(String(taskError?.message || taskError));
                    }
                }
            }

            await writeAuditLog({
                actorUserId,
                entityType: 'task',
                entityId: null,
                action: 'import_supabase',
                details: summary,
            });

            return res.json({ success: true, summary });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Tasks] Erro na importação Supabase:', details);
            return res.status(500).json({ success: false, error: details });
        }
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
