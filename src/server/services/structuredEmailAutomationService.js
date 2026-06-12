function createStructuredEmailAutomationService(deps) {
    const {
        dbRunAsync,
        dbGetAsync,
        dbAllAsync,
        inbox,
        mailbox,
        upsertLocalTask,
        upsertAgendaEvent,
        sendResponsibleNotification,
        defaultUserEmail = 'mpr@mpr.pt',
        nowIso = () => new Date().toISOString(),
    } = deps;

    function normalizeText(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[“”‘’]/g, '"')
            .toLowerCase()
            .trim();
    }

    function normalizeFieldKey(value) {
        return normalizeText(value)
            .replace(/[“”"']/g, '')
            .replace(/\s+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    function cleanFieldValue(value) {
        return String(value ?? '')
            .trim()
            .replace(/^[“”"']+|[“”"',]+$/g, '')
            .trim();
    }

    function extractEmail(value) {
        const raw = String(value || '').trim();
        const match = raw.match(/<([^>]+)>/) || raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
        return String(match?.[1] || match?.[0] || raw).trim().toLowerCase();
    }

    function parseStructuredBody(text) {
        const rawText = String(text || '').trim();
        const jsonCandidates = [
            rawText,
            rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || '',
            rawText.match(/(\{[\s\S]*\})/)?.[1] || '',
        ].filter(Boolean);

        for (const candidate of jsonCandidates) {
            try {
                const parsed = JSON.parse(candidate);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    const fieldsFromJson = {};
                    Object.entries(parsed).forEach(([key, value]) => {
                        const normalizedKey = normalizeFieldKey(key);
                        if (!normalizedKey) return;
                        fieldsFromJson[normalizedKey] = Array.isArray(value)
                            ? value.map((item) => String(item || '').trim()).filter(Boolean).join(', ')
                            : cleanFieldValue(value);
                    });
                    if (Object.keys(fieldsFromJson).length > 0) return fieldsFromJson;
                }
            } catch (_) {
                // fall back to Campo: valor parsing
            }
        }

        const fields = {};
        const lines = rawText.replace(/\r/g, '\n').split('\n');
        let currentKey = '';
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line) continue;
            const match = line.match(/^([^:：]{2,40})[:：]\s*(.*)$/);
            if (match) {
                currentKey = normalizeFieldKey(match[1]);
                fields[currentKey] = cleanFieldValue(match[2] || '');
                continue;
            }
            if (currentKey && fields[currentKey]) {
                fields[currentKey] = `${fields[currentKey]}\n${cleanFieldValue(line)}`.trim();
            }
        }
        return fields;
    }

    function field(fields, names) {
        for (const name of names) {
            const key = normalizeFieldKey(name);
            if (fields[key]) return String(fields[key]).trim();
        }
        return '';
    }

    function serializeFields(fields) {
        try {
            return JSON.stringify(fields || {});
        } catch (_) {
            return '{}';
        }
    }

    function normalizeAction(rawValue, subject = '') {
        const value = normalizeText(`${rawValue} ${subject}`);
        if (value.includes('tarefa')) return 'task';
        if (value.includes('ocorrencia') || value.includes('ocorrência')) return 'occurrence';
        if (value.includes('nota')) return 'customer_note';
        if (value.includes('lembrete') || value.includes('lembrar')) return 'task';
        if (value.includes('agenda') || value.includes('reuniao') || value.includes('reunião') || value.includes('visita')) return 'agenda';
        return '';
    }

    function isIgnorableSystemEmail(message) {
        const subject = normalizeText(message?.subject || '');
        const from = normalizeText(message?.from || '');
        return (
            from.includes('postmaster') ||
            subject.startsWith('aceite:') ||
            subject.startsWith('accepted:') ||
            subject.startsWith('recusado:') ||
            subject.startsWith('declined:') ||
            subject.startsWith('tentativa:') ||
            subject.startsWith('tentative:') ||
            subject.includes('convite outlook wa pro')
        );
    }

    function normalizeAgendaType(value) {
        const raw = normalizeText(value);
        if (raw.includes('visita')) return 'visit';
        if (raw.includes('chamada') || raw.includes('telefonema')) return 'call';
        if (raw.includes('outro')) return 'other';
        return 'meeting';
    }

    function parseDate(rawValue) {
        const raw = String(rawValue || '').trim();
        if (!raw) return '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
        const pt = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
        if (pt) return `${pt[3]}-${String(pt[2]).padStart(2, '0')}-${String(pt[1]).padStart(2, '0')}`;
        const parsed = new Date(raw);
        if (!Number.isFinite(parsed.getTime())) return '';
        return parsed.toISOString().slice(0, 10);
    }

    function parseTime(rawValue, fallback) {
        const raw = String(rawValue || '').trim();
        const match = raw.match(/(\d{1,2})[:hH](\d{2})|^(\d{1,2})$/);
        if (!match) return fallback;
        const hour = Number(match[1] || match[3] || 0);
        const minute = Number(match[2] || 0);
        return `${String(Math.max(0, Math.min(23, hour))).padStart(2, '0')}:${String(Math.max(0, Math.min(59, minute))).padStart(2, '0')}`;
    }

    function parseDurationMinutes(rawValue, fallback = 60) {
        const raw = normalizeText(rawValue);
        if (!raw) return fallback;
        const hourMatch = raw.match(/(\d+(?:[,.]\d+)?)\s*(h|hora|horas)/);
        if (hourMatch) return Math.max(1, Math.round(Number(String(hourMatch[1]).replace(',', '.')) * 60));
        const minuteMatch = raw.match(/(\d+)\s*(m|min|minuto|minutos)/);
        if (minuteMatch) return Math.max(1, Number(minuteMatch[1]) || fallback);
        const plainNumber = Number(raw.replace(/[^\d]/g, ''));
        return Number.isFinite(plainNumber) && plainNumber > 0 ? plainNumber : fallback;
    }

    function addMinutesToTime(time, minutes) {
        const [hourRaw, minuteRaw] = String(time || '09:00').split(':');
        const date = new Date(Date.UTC(2000, 0, 1, Number(hourRaw || 9), Number(minuteRaw || 0), 0));
        date.setUTCMinutes(date.getUTCMinutes() + Math.max(1, Number(minutes) || 60));
        return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
    }

    function localDateTimeIso(date, time) {
        return new Date(`${date}T${time}:00`).toISOString();
    }

    async function findUser(rawValue) {
        const raw = String(rawValue || '').trim();
        const fallbackEmail = String(defaultUserEmail || '').trim().toLowerCase();
        const byEmail = extractEmail(raw || fallbackEmail);
        let row = null;
        if (byEmail) {
            row = await dbGetAsync('SELECT id, name, email FROM users WHERE lower(email) = lower(?) LIMIT 1', [byEmail]);
        }
        if (!row && raw) {
            row = await dbGetAsync('SELECT id, name, email FROM users WHERE lower(name) LIKE lower(?) ORDER BY updated_at DESC LIMIT 1', [`%${raw}%`]);
        }
        if (!row && fallbackEmail) {
            row = await dbGetAsync('SELECT id, name, email FROM users WHERE lower(email) = lower(?) LIMIT 1', [fallbackEmail]);
        }
        if (!row) {
            row = await dbGetAsync('SELECT id, name, email FROM users ORDER BY updated_at DESC LIMIT 1');
        }
        return row;
    }

    async function findCustomer(rawValue) {
        const raw = String(rawValue || '').trim();
        if (!raw) return null;
        const digits = raw.replace(/\D/g, '');
        if (digits.length >= 8) {
            const row = await dbGetAsync('SELECT id, name, company, nif FROM customers WHERE REPLACE(REPLACE(nif, ?, ?), ?, ?) = ? LIMIT 1', [' ', '', '-', '', digits]);
            if (row) return row;
        }
        return dbGetAsync(
            `SELECT id, name, company, nif
             FROM customers
             WHERE lower(name) LIKE lower(?)
                OR lower(company) LIKE lower(?)
                OR lower(email) = lower(?)
             ORDER BY updated_at DESC
             LIMIT 1`,
            [`%${raw}%`, `%${raw}%`, raw.toLowerCase()]
        );
    }

    async function ensureConversation(customerId, ownerId) {
        const existing = await dbGetAsync('SELECT id FROM conversations WHERE customer_id = ? ORDER BY datetime(updated_at) DESC LIMIT 1', [customerId]);
        if (existing?.id) return String(existing.id);
        const id = `conv_email_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        await dbRunAsync(
            `INSERT INTO conversations (id, customer_id, owner_id, status, last_message_at, unread_count, updated_at)
             VALUES (?, ?, ?, 'open', ?, 0, CURRENT_TIMESTAMP)`,
            [id, customerId, ownerId || null, nowIso()]
        );
        return id;
    }

    async function createOccurrenceFromFields(fields, meta) {
        const customer = await findCustomer(field(fields, ['Cliente', 'NIF', 'Email Cliente']));
        if (!customer?.id) throw new Error('Cliente não encontrado para ocorrência.');
        const user = await findUser(field(fields, ['Responsável', 'Responsavel']));
        const title = field(fields, ['Assunto', 'Título', 'Titulo']);
        if (!title) throw new Error('Ocorrência sem assunto.');
        const date = parseDate(field(fields, ['Data'])) || new Date().toISOString().slice(0, 10);
        const dueDate = parseDate(field(fields, ['Data Limite', 'Prazo']));
        const typeName = field(fields, ['Tipo Ocorrência', 'Tipo Ocorrencia', 'Tipo']) || 'Outros Assuntos';
        const typeRow = await dbGetAsync('SELECT id, name FROM occurrence_types WHERE lower(name) = lower(?) LIMIT 1', [typeName]);
        const id = `occ_email_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        await dbRunAsync(
            `INSERT INTO occurrences (
                id, customer_id, customer_nif, date, type_id, type_name, title, description, state, due_date,
                responsible_user_id, responsible_ids_json, responsible_names_text, resolution, sync_origin, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ABERTA', ?, ?, ?, ?, NULL, 'email', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
                id,
                customer.id,
                String(customer.nif || '').trim() || null,
                date,
                typeRow?.id || null,
                String(typeRow?.name || typeName || '').trim() || null,
                title,
                field(fields, ['Descrição', 'Descricao', 'Notas']) || `Criado por email: ${meta.subject || ''}`,
                dueDate || null,
                user?.id || null,
                user?.id ? JSON.stringify([user.id]) : null,
                user?.name || null,
            ]
        );
        return { entityType: 'occurrence', entityId: id };
    }

    async function appendCustomerNoteFromFields(fields, meta) {
        const customer = await findCustomer(field(fields, ['Cliente', 'NIF', 'Email Cliente']));
        if (!customer?.id) throw new Error('Cliente não encontrado para nota.');
        const note = field(fields, ['Nota', 'Notas', 'Descrição', 'Descricao', 'Conteúdo', 'Conteudo']);
        if (!note) throw new Error('Nota sem texto.');
        const row = await dbGetAsync('SELECT customer_profile_json FROM customers WHERE id = ? LIMIT 1', [customer.id]);
        let profile = {};
        try {
            profile = row?.customer_profile_json ? JSON.parse(row.customer_profile_json) : {};
        } catch (_) {
            profile = {};
        }
        const previous = String(profile.notes || '').trim();
        const stampedNote = `[${new Date().toLocaleString('pt-PT')}] ${note}`;
        profile.notes = previous ? `${previous}\n\n${stampedNote}` : stampedNote;
        await dbRunAsync('UPDATE customers SET customer_profile_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(profile), customer.id]);
        return { entityType: 'customer_note', entityId: customer.id };
    }

    async function createTaskFromFields(fields, meta) {
        const customer = await findCustomer(field(fields, ['Cliente', 'NIF', 'Email Cliente']));
        if (!customer?.id) throw new Error('Cliente não encontrado para tarefa.');
        const user = await findUser(field(fields, ['Responsável', 'Responsavel']));
        const conversationId = await ensureConversation(customer.id, user?.id || null);
        const saved = await upsertLocalTask({
            conversationId,
            title: field(fields, ['Assunto', 'Título', 'Titulo']) || meta.subject || 'Tarefa por email',
            status: 'open',
            priority: normalizeText(field(fields, ['Prioridade'])).includes('urgent') || normalizeText(field(fields, ['Prioridade'])).includes('urgente') ? 'urgent' : 'normal',
            dueDate: parseDate(field(fields, ['Prazo', 'Data Limite'])) || new Date().toISOString(),
            assignedUserId: user?.id || '',
            notes: field(fields, ['Notas', 'Descrição', 'Descricao', 'Conteúdo', 'Conteudo']) || `Criado por email: ${meta.subject || ''}`,
        });
        if (user?.email && typeof sendResponsibleNotification === 'function') {
            const dueDate = parseDate(field(fields, ['Prazo', 'Data Limite'])) || new Date().toISOString().slice(0, 10);
            const taskTime = parseTime(field(fields, ['Hora']), '09:00');
            const startsAt = new Date(`${dueDate}T${taskTime}:00`).toISOString();
            await sendResponsibleNotification({
                to: user.email,
                entityType: 'Tarefa',
                entityId: saved.id,
                title: saved.title,
                description: saved.notes || '',
                startsAt,
                endsAt: new Date(new Date(startsAt).getTime() + 30 * 60000).toISOString(),
                location: '',
                customerName: customer.name || customer.company || '',
            });
        }
        return { entityType: 'task', entityId: saved.id };
    }

    async function createAgendaFromFields(fields, meta) {
        const date = parseDate(field(fields, ['Data']));
        if (!date) throw new Error('Agenda sem data válida.');
        const startTime = parseTime(field(fields, ['Início', 'Inicio', 'Hora', 'Hora Início', 'Hora Inicio']), '09:00');
        const endTimeRaw = field(fields, ['Fim', 'Hora Fim']);
        const durationMinutes = parseDurationMinutes(field(fields, ['Duração', 'Duracao']), 60);
        const endTime = endTimeRaw ? parseTime(endTimeRaw, addMinutesToTime(startTime, durationMinutes)) : addMinutesToTime(startTime, durationMinutes);
        const user = await findUser(field(fields, ['Responsável', 'Responsavel', 'Responsável Interno', 'Responsavel Interno']));
        const customer = await findCustomer(field(fields, ['Cliente', 'NIF', 'Email Cliente']));
        const saved = await upsertAgendaEvent({
            title: field(fields, ['Assunto', 'Título', 'Titulo']) || meta.subject || 'Evento por email',
            type: normalizeAgendaType(field(fields, ['Tipo'])),
            customerId: customer?.id || undefined,
            assignedUserId: user?.id || '',
            startsAt: localDateTimeIso(date, startTime),
            endsAt: localDateTimeIso(date, endTime),
            location: field(fields, ['Local', 'Localização', 'Localizacao']),
            notes: field(fields, ['Notas', 'Descrição', 'Descricao', 'Participantes']) || `Criado por email: ${meta.subject || ''}`,
            source: 'email',
            sourceEmailUid: meta.uid,
        });
        if (user?.email && typeof sendResponsibleNotification === 'function') {
            await sendResponsibleNotification({
                to: user.email,
                entityType: 'Agenda',
                entityId: saved.id,
                title: saved.title,
                description: saved.notes || '',
                startsAt: saved.startsAt,
                endsAt: saved.endsAt,
                location: saved.location || '',
                customerName: customer?.name || customer?.company || '',
            });
        }
        return { entityType: 'agenda_event', entityId: saved.id };
    }

    async function runAction(action, fields, meta) {
        if (action === 'agenda') return createAgendaFromFields(fields, meta);
        if (action === 'task') return createTaskFromFields(fields, meta);
        if (action === 'occurrence') return createOccurrenceFromFields(fields, meta);
        if (action === 'customer_note') return appendCustomerNoteFromFields(fields, meta);
        throw new Error('Tipo de ação não suportado.');
    }

    async function processMessage(message) {
        const uid = String(message.uid || '').trim();
        const already = await dbGetAsync('SELECT uid FROM email_automation_processed WHERE mailbox = ? AND uid = ? LIMIT 1', [mailbox, uid]);
        if (already) return { skipped: true, uid, reason: 'already_processed' };

        if (isIgnorableSystemEmail(message)) {
            await dbRunAsync(
                `INSERT OR REPLACE INTO email_automation_processed (
                    mailbox, uid, action_type, entity_type, entity_id, subject, from_email, status, error, raw_text, parsed_fields_json, ignored_at, processed_at
                 ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, 'ignored', ?, ?, '{}', ?, CURRENT_TIMESTAMP)`,
                [mailbox, uid, message.subject || '', extractEmail(message.from), 'Email automático ignorado.', message.plainText || '', nowIso()]
            );
            return { skipped: true, uid, reason: 'ignored_system_email' };
        }

        const fields = parseStructuredBody(message.plainText || '');
        const action = normalizeAction(field(fields, ['Tipo', 'Ação', 'Acao']), message.subject);
        if (!action) {
            await dbRunAsync(
                `INSERT OR REPLACE INTO email_automation_processed (
                    mailbox, uid, action_type, entity_type, entity_id, subject, from_email, status, error, raw_text, parsed_fields_json, processed_at
                 ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, 'pending', ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                    mailbox,
                    uid,
                    message.subject || '',
                    extractEmail(message.from),
                    'Não foi possível detetar se é agenda, tarefa, ocorrência ou nota.',
                    message.plainText || '',
                    serializeFields(fields),
                ]
            );
            return { skipped: true, uid, reason: 'pending_classification' };
        }

        let result;
        try {
            result = await runAction(action, fields, message);

            await dbRunAsync(
                `INSERT INTO email_automation_processed (
                    mailbox, uid, action_type, entity_type, entity_id, subject, from_email, status, error, raw_text, parsed_fields_json, processed_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processed', NULL, ?, ?, CURRENT_TIMESTAMP)`,
                [mailbox, uid, action, result.entityType, result.entityId, message.subject || '', extractEmail(message.from), message.plainText || '', serializeFields(fields)]
            );
            return { uid, action, ...result };
        } catch (error) {
            await dbRunAsync(
                `INSERT OR REPLACE INTO email_automation_processed (
                    mailbox, uid, action_type, entity_type, entity_id, subject, from_email, status, error, raw_text, parsed_fields_json, processed_at
                 ) VALUES (?, ?, ?, NULL, NULL, ?, ?, 'error', ?, ?, ?, CURRENT_TIMESTAMP)`,
                [mailbox, uid, action, message.subject || '', extractEmail(message.from), error?.message || String(error), message.plainText || '', serializeFields(fields)]
            );
            throw error;
        }
    }

    async function processManualEntry({ uid, actionType, fields, actor = 'manual' } = {}) {
        const safeUid = String(uid || '').trim();
        const action = normalizeAction(actionType, actionType);
        if (!safeUid) throw new Error('UID obrigatório.');
        if (!action) throw new Error('Tipo obrigatório.');
        const existing = await dbGetAsync(
            `SELECT mailbox, uid, subject, from_email, raw_text
             FROM email_automation_processed
             WHERE mailbox = ? AND uid = ?
             LIMIT 1`,
            [mailbox, safeUid]
        );
        if (!existing?.uid) throw new Error('Entrada não encontrada.');

        const cleanFields = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
        const result = await runAction(action, cleanFields, {
            uid: safeUid,
            subject: existing.subject || actionType,
            from: existing.from_email || actor,
            plainText: existing.raw_text || '',
        });
        await dbRunAsync(
            `UPDATE email_automation_processed
             SET action_type = ?,
                 entity_type = ?,
                 entity_id = ?,
                 status = 'processed',
                 error = NULL,
                 reviewed_fields_json = ?,
                 processed_at = CURRENT_TIMESTAMP
             WHERE mailbox = ? AND uid = ?`,
            [action, result.entityType, result.entityId, serializeFields(cleanFields), mailbox, safeUid]
        );
        return { uid: safeUid, action, ...result };
    }

    async function scan({ sinceDays = 14, maxMessages = 50, dryRun = false } = {}) {
        if (!inbox?.hasImapConfig?.()) throw new Error('Conta agenda@mpr.pt sem IMAP configurado.');
        const messages = await inbox.listRecentMessages({ sinceDays, maxMessages });
        const summary = { scanned: messages.length, processed: 0, skipped: 0, errors: 0, results: [] };
        for (const message of messages) {
            try {
                if (dryRun) {
                    const fields = parseStructuredBody(message.plainText || '');
                    const action = normalizeAction(field(fields, ['Tipo', 'Ação', 'Acao']), message.subject);
                    summary.results.push({ uid: message.uid, action: action || '', subject: message.subject, dryRun: true });
                    summary.skipped += 1;
                    continue;
                }
                const result = await processMessage(message);
                if (result.skipped) summary.skipped += 1;
                else summary.processed += 1;
                summary.results.push(result);
            } catch (error) {
                summary.errors += 1;
                summary.results.push({ uid: message.uid, subject: message.subject, error: error?.message || String(error) });
            }
        }
        return summary;
    }

    return { scan, parseStructuredBody, processManualEntry };
}

module.exports = { createStructuredEmailAutomationService };
