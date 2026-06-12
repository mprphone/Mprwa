'use strict';

function registerAgendaRoutes(context) {
    const { app, dbRunAsync, dbGetAsync, dbAllAsync, writeAuditLog, sendResponsibleNotification, nowIso } = context;

    function normalizeAgendaType(value) {
        const raw = String(value || '').trim().toLowerCase();
        if (['visit', 'visita'].includes(raw)) return 'visit';
        if (['call', 'chamada', 'telefonema'].includes(raw)) return 'call';
        if (['other', 'outro'].includes(raw)) return 'other';
        return 'meeting';
    }

    function normalizeAgendaRow(row) {
        if (!row) return null;
        const id = String(row.id || '').trim();
        const title = String(row.title || '').trim();
        const startsAt = String(row.starts_at || '').trim();
        const endsAt = String(row.ends_at || '').trim();
        if (!id || !title || !startsAt || !endsAt) return null;
        return {
            id,
            title,
            type: normalizeAgendaType(row.type),
            customerId: String(row.customer_id || '').trim() || undefined,
            assignedUserId: String(row.assigned_user_id || '').trim(),
            startsAt,
            endsAt,
            location: String(row.location || '').trim() || undefined,
            notes: String(row.notes || '').trim() || undefined,
            createdAt: String(row.created_at || '').trim() || nowIso(),
            updatedAt: String(row.updated_at || '').trim() || nowIso(),
        };
    }

    async function upsertAgendaEvent(input) {
        const now = nowIso();
        const id = String(input.id || '').trim() || `ag${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const existing = await dbGetAsync('SELECT * FROM agenda_events WHERE id = ? LIMIT 1', [id]);
        const title = String(input.title || existing?.title || '').trim();
        const startsAt = String(input.startsAt || input.starts_at || existing?.starts_at || '').trim();
        const endsAt = String(input.endsAt || input.ends_at || existing?.ends_at || '').trim();
        const assignedUserId = String(input.assignedUserId || input.assigned_user_id || existing?.assigned_user_id || '').trim();

        if (!title || !startsAt || !endsAt || !assignedUserId) {
            throw new Error('Evento requer título, responsável, início e fim.');
        }

        await dbRunAsync(
            `INSERT INTO agenda_events (
                id, title, type, customer_id, assigned_user_id, starts_at, ends_at, location, notes, source, source_email_uid, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                type = excluded.type,
                customer_id = excluded.customer_id,
                assigned_user_id = excluded.assigned_user_id,
                starts_at = excluded.starts_at,
                ends_at = excluded.ends_at,
                location = excluded.location,
                notes = excluded.notes,
                updated_at = excluded.updated_at`,
            [
                id,
                title,
                normalizeAgendaType(input.type || existing?.type),
                String(input.customerId || input.customer_id || existing?.customer_id || '').trim() || null,
                assignedUserId,
                startsAt,
                endsAt,
                String(input.location ?? existing?.location ?? '').trim() || null,
                String(input.notes ?? existing?.notes ?? '').trim() || null,
                String(input.source || existing?.source || 'manual').trim() || 'manual',
                String(input.sourceEmailUid || input.source_email_uid || existing?.source_email_uid || '').trim() || null,
                String(existing?.created_at || '').trim() || now,
                now,
            ]
        );

        const row = await dbGetAsync('SELECT * FROM agenda_events WHERE id = ? LIMIT 1', [id]);
        return normalizeAgendaRow(row);
    }

    app.get('/api/agenda/events', async (req, res) => {
        try {
            const requestingUserId = String(req.query?.userId || '').trim();

            // Verificar se o utilizador é admin (pode ver tudo)
            let isAdmin = false;
            if (requestingUserId) {
                const userRow = await dbGetAsync(
                    'SELECT role, email FROM users WHERE id = ? LIMIT 1',
                    [requestingUserId]
                );
                isAdmin = userRow?.role === 'ADMIN' || userRow?.role === 'OWNER';
            }

            let rows;
            if (!requestingUserId || isAdmin) {
                // Admin ou sem filtro: devolver tudo
                rows = await dbAllAsync(
                    `SELECT * FROM agenda_events
                     ORDER BY datetime(starts_at) ASC, datetime(updated_at) DESC`
                );
            } else {
                // Funcionário: só os seus eventos
                rows = await dbAllAsync(
                    `SELECT * FROM agenda_events
                     WHERE assigned_user_id = ?
                     ORDER BY datetime(starts_at) ASC, datetime(updated_at) DESC`,
                    [requestingUserId]
                );
            }

            return res.json({ success: true, data: rows.map(normalizeAgendaRow).filter(Boolean) });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.get('/api/agenda/assistant-entry', async (req, res) => {
        try {
            const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 80) || 80));
            const rows = await dbAllAsync(
                `SELECT mailbox, uid, action_type, entity_type, entity_id, subject, from_email, status, error, raw_text, parsed_fields_json, reviewed_fields_json, ignored_at, processed_at
                 FROM email_automation_processed
                 ORDER BY datetime(processed_at) DESC
                 LIMIT ?`,
                [limit]
            );
            const summaryRows = await dbAllAsync(
                `SELECT status, COUNT(*) AS total
                 FROM email_automation_processed
                 GROUP BY status`
            );
            const summary = { processed: 0, pending: 0, error: 0, total: 0 };
            summaryRows.forEach((row) => {
                const status = String(row.status || '').trim() || 'pending';
                const total = Number(row.total || 0);
                if (status === 'processed') summary.processed += total;
                else if (status === 'error') summary.error += total;
                else summary.pending += total;
                summary.total += total;
            });
            return res.json({
                success: true,
                summary,
                data: rows.map((row) => ({
                    mailbox: String(row.mailbox || '').trim(),
                    uid: String(row.uid || '').trim(),
                    actionType: String(row.action_type || '').trim(),
                    entityType: String(row.entity_type || '').trim(),
                    entityId: String(row.entity_id || '').trim(),
                    subject: String(row.subject || '').trim(),
                    fromEmail: String(row.from_email || '').trim(),
                    status: String(row.status || '').trim() || 'pending',
                    error: String(row.error || '').trim(),
                    rawText: String(row.raw_text || '').trim(),
                    parsedFields: (() => {
                        try {
                            return row.parsed_fields_json ? JSON.parse(row.parsed_fields_json) : {};
                        } catch (_) {
                            return {};
                        }
                    })(),
                    reviewedFields: (() => {
                        try {
                            return row.reviewed_fields_json ? JSON.parse(row.reviewed_fields_json) : {};
                        } catch (_) {
                            return {};
                        }
                    })(),
                    ignoredAt: String(row.ignored_at || '').trim(),
                    processedAt: String(row.processed_at || '').trim(),
                })),
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.post('/api/agenda/events', async (req, res) => {
        try {
            const saved = await upsertAgendaEvent(req.body || {});
            await writeAuditLog({
                actorUserId: req.body?.actorUserId || saved.assignedUserId || null,
                entityType: 'agenda_event',
                entityId: saved.id,
                action: 'upsert',
                details: saved,
            });
            try {
                const row = await dbGetAsync(
                    `SELECT ae.*, u.email AS responsible_email, c.name AS customer_name, c.company AS customer_company
                     FROM agenda_events ae
                     LEFT JOIN users u ON u.id = ae.assigned_user_id
                     LEFT JOIN customers c ON c.id = ae.customer_id
                     WHERE ae.id = ? LIMIT 1`,
                    [saved.id]
                );
                if (row?.responsible_email && typeof sendResponsibleNotification === 'function') {
                    await sendResponsibleNotification({
                        to: row.responsible_email,
                        entityType: 'Agenda',
                        entityId: saved.id,
                        title: saved.title,
                        description: saved.notes || '',
                        startsAt: saved.startsAt,
                        endsAt: saved.endsAt,
                        location: saved.location || '',
                        customerName: String(row.customer_name || row.customer_company || '').trim(),
                    });
                }
            } catch (notifyError) {
                console.error('[Agenda] Falha ao enviar aviso por email:', notifyError?.message || notifyError);
            }
            return res.json({ success: true, data: saved });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.delete('/api/agenda/events/:id', async (req, res) => {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ success: false, error: 'Evento inválido.' });
        try {
            await dbRunAsync('DELETE FROM agenda_events WHERE id = ?', [id]);
            await writeAuditLog({
                actorUserId: String(req.query?.actorUserId || '').trim() || null,
                entityType: 'agenda_event',
                entityId: id,
                action: 'delete',
                details: { deletedAt: nowIso() },
            });
            return res.json({ success: true, deletedEventId: id });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    return { upsertAgendaEvent };
}

module.exports = { registerAgendaRoutes };
