function createConversationRepository(deps) {
    const {
        dbAllAsync,
        dbGetAsync,
        dbRunAsync,
        normalizePhone,
        normalizeDigits,
        normalizeBoolean,
        sanitizeIdPart,
        nowIso,
        logChatCore,
        getLocalCustomerById,
        upsertLocalCustomer,
        parseContactsArray,
        normalizeLocalSqlCustomer,
        CUSTOMER_TYPES,
        isBaileysProviderEnabled,
        BAILEYS_ACCOUNTS_BY_ID,
        ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID,
        ACTIVE_BAILEYS_NAME_CONFLICT_ACCOUNT_ID,
    } = deps;

    function normalizeConversationStatus(value) {
        const status = String(value || '').trim().toLowerCase();
        if (status === 'waiting') return 'waiting';
        if (status === 'closed') return 'closed';
        return 'open';
    }

    function sanitizeConversationId(rawId, customerId) {
        const candidate = String(rawId || '').trim();
        if (candidate) return candidate;
        return `conv_${sanitizeIdPart(customerId || Date.now(), String(Date.now()))}`;
    }

    function normalizeLocalSqlConversation(row) {
        if (!row) return null;

        const id = String(row.id || '').trim();
        const customerId = String(row.customer_id || '').trim();
        if (!id || !customerId) return null;

        return {
            id,
            customerId,
            whatsappAccountId: String(row.whatsapp_account_id || '').trim() || null,
            ownerId: String(row.owner_id || '').trim() || null,
            status: normalizeConversationStatus(row.status),
            lastMessageAt: String(row.last_message_at || '').trim() || nowIso(),
            unreadCount: Number(row.unread_count || 0),
        };
    }

    async function getAllLocalConversations() {
        const rows = await dbAllAsync(
            `SELECT id, customer_id, whatsapp_account_id, owner_id, status, last_message_at, unread_count
             FROM conversations
             ORDER BY datetime(last_message_at) DESC`
        );
        return rows.map(normalizeLocalSqlConversation).filter(Boolean);
    }

    async function getLocalConversationById(conversationId) {
        const row = await dbGetAsync(
            `SELECT id, customer_id, whatsapp_account_id, owner_id, status, last_message_at, unread_count
             FROM conversations
             WHERE id = ?
             LIMIT 1`,
            [conversationId]
        );
        return normalizeLocalSqlConversation(row);
    }

    async function getLocalConversationByCustomerId(customerId) {
        const row = await dbGetAsync(
            `SELECT id, customer_id, whatsapp_account_id, owner_id, status, last_message_at, unread_count
             FROM conversations
             WHERE customer_id = ?
             LIMIT 1`,
            [customerId]
        );
        return normalizeLocalSqlConversation(row);
    }

    function extractPhoneDigitsFromConversationId(rawConversationId) {
        const value = String(rawConversationId || '').trim();
        if (!value) return '';
        const match = value.match(/(?:conv_wa_c_|conv_wa_|wa_conv_|wa_c_)(\d{6,})/i);
        return String(match?.[1] || '').trim();
    }

    function phoneDigitsMatch(leftValue, rightValue) {
        const left = normalizeDigits(String(leftValue || ''));
        const right = normalizeDigits(String(rightValue || ''));
        if (!left || !right) return false;
        return left === right || left.endsWith(right) || right.endsWith(left);
    }

    async function ensureCustomerPhoneForConversationReassign(sourceConversationRow, targetCustomerId) {
        const targetId = String(targetCustomerId || '').trim();
        if (!sourceConversationRow || !targetId) return;

        const sourceCustomerId = String(sourceConversationRow?.customer_id || '').trim();
        const sourceCustomer = sourceCustomerId ? await getLocalCustomerById(sourceCustomerId) : null;
        const sourceContacts = parseContactsArray(sourceCustomer?.contacts || []);
        const phoneFromId = normalizePhone(extractPhoneDigitsFromConversationId(sourceConversationRow?.id));
        const phoneFromSourceCustomer = normalizePhone(String(sourceCustomer?.phone || '').trim());
        const phoneFromSourceContact = normalizePhone(String(sourceContacts.find((item) => String(item?.phone || '').trim())?.phone || ''));
        const phoneHint = phoneFromId || phoneFromSourceCustomer || phoneFromSourceContact;
        if (!phoneHint) return;

        const targetCustomer = await getLocalCustomerById(targetId);
        if (!targetCustomer) return;

        const targetPhone = normalizePhone(String(targetCustomer.phone || '').trim());
        const targetContacts = parseContactsArray(targetCustomer.contacts || []);
        const hasHintInContacts = targetContacts.some((contact) => phoneDigitsMatch(contact?.phone, phoneHint));
        if (phoneDigitsMatch(targetPhone, phoneHint) || hasHintInContacts) return;

        if (!targetPhone) {
            await upsertLocalCustomer({
                id: targetCustomer.id,
                phone: phoneHint,
                contacts: targetContacts,
            });
            logChatCore('conversation_reassign_phone_backfilled', {
                customerId: targetCustomer.id,
                phone: phoneHint,
                mode: 'main_phone',
                conversationId: String(sourceConversationRow?.id || '').trim() || null,
            });
            return;
        }

        const sourceLabel = String(sourceCustomer?.name || '').trim() || 'WhatsApp';
        await upsertLocalCustomer({
            id: targetCustomer.id,
            contacts: [
                ...targetContacts,
                {
                    name: sourceLabel,
                    phone: phoneHint,
                },
            ],
        });
        logChatCore('conversation_reassign_phone_backfilled', {
            customerId: targetCustomer.id,
            phone: phoneHint,
            mode: 'contacts_json',
            conversationId: String(sourceConversationRow?.id || '').trim() || null,
        });
    }

    async function mergeConversationReferences(sourceConversationId, targetConversationId) {
        const sourceId = String(sourceConversationId || '').trim();
        const targetId = String(targetConversationId || '').trim();
        if (!sourceId || !targetId || sourceId === targetId) return;

        await dbRunAsync(
            `UPDATE tasks
             SET conversation_id = ?
             WHERE conversation_id = ?`,
            [targetId, sourceId]
        );
        await dbRunAsync(
            `UPDATE outbound_queue
             SET conversation_id = ?
             WHERE conversation_id = ?`,
            [targetId, sourceId]
        );
        await dbRunAsync(
            `UPDATE outbound_dead_letter
             SET conversation_id = ?
             WHERE conversation_id = ?`,
            [targetId, sourceId]
        );
        await dbRunAsync(
            `UPDATE saft_jobs
             SET conversation_id = ?
             WHERE conversation_id = ?`,
            [targetId, sourceId]
        );
    }

    async function upsertLocalConversation(input) {
        const customerId = String(input.customerId || '').trim();
        if (!customerId) {
            throw new Error('Conversa requer customerId.');
        }

        const requestedId = String(input.id || '').trim();
        const existingById = requestedId
            ? await dbGetAsync('SELECT * FROM conversations WHERE id = ? LIMIT 1', [requestedId])
            : null;
        let existingByCustomer = customerId
            ? await dbGetAsync('SELECT * FROM conversations WHERE customer_id = ? LIMIT 1', [customerId])
            : null;
        const requestedExistingId = String(existingById?.id || '').trim();
        const customerExistingId = String(existingByCustomer?.id || '').trim();
        const hasConflictingCustomerConversation =
            requestedExistingId &&
            customerExistingId &&
            requestedExistingId !== customerExistingId;

        if (requestedExistingId && String(existingById?.customer_id || '').trim() !== customerId) {
            await ensureCustomerPhoneForConversationReassign(existingById, customerId);
        }

        if (hasConflictingCustomerConversation) {
            const sourceConversation = requestedExistingId;
            const destinationConversation = customerExistingId;
            await mergeConversationReferences(destinationConversation, sourceConversation);
            await dbRunAsync('DELETE FROM conversations WHERE id = ?', [destinationConversation]);
            existingByCustomer = null;
            logChatCore('conversation_reassign_merged', {
                fromConversationId: destinationConversation,
                toConversationId: sourceConversation,
                customerId,
            });
        }

        const existing = existingById || existingByCustomer;

        const id = sanitizeConversationId(existing?.id || requestedId, customerId);
        const ownerId =
            input.ownerId !== undefined ? String(input.ownerId || '').trim() : String(existing?.owner_id || '').trim();
        const whatsappAccountId =
            input.whatsappAccountId !== undefined
                ? resolveConversationAccountId(input.whatsappAccountId)
                : resolveConversationAccountId(existing?.whatsapp_account_id);
        const status = normalizeConversationStatus(input.status || existing?.status || 'open');
        const lastMessageAt = String(input.lastMessageAt || existing?.last_message_at || nowIso()).trim() || nowIso();
        const unreadCount = Number(
            input.unreadCount !== undefined ? input.unreadCount : Number(existing?.unread_count || 0)
        );

        try {
            await dbRunAsync(
                `INSERT INTO conversations (
                    id, customer_id, whatsapp_account_id, owner_id, status, last_message_at, unread_count, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(id) DO UPDATE SET
                   customer_id = excluded.customer_id,
                   whatsapp_account_id = excluded.whatsapp_account_id,
                   owner_id = excluded.owner_id,
                   status = excluded.status,
                   last_message_at = excluded.last_message_at,
                   unread_count = excluded.unread_count,
                   updated_at = CURRENT_TIMESTAMP`,
                [
                    id,
                    customerId,
                    whatsappAccountId || null,
                    ownerId || null,
                    status,
                    lastMessageAt,
                    Number.isFinite(unreadCount) ? unreadCount : 0,
                ]
            );
        } catch (error) {
            const details = String(error?.message || error || '');
            if (!details.includes('UNIQUE constraint failed: conversations.customer_id')) {
                throw error;
            }
            await dbRunAsync(
                `UPDATE conversations
                 SET whatsapp_account_id = ?,
                     owner_id = ?,
                     status = ?,
                     last_message_at = ?,
                     unread_count = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE customer_id = ?`,
                [
                    whatsappAccountId || null,
                    ownerId || null,
                    status,
                    lastMessageAt,
                    Number.isFinite(unreadCount) ? unreadCount : 0,
                    customerId,
                ]
            );
        }

        const saved = (await getLocalConversationByCustomerId(customerId)) || (await getLocalConversationById(id));
        return saved;
    }

    function resolveConversationAccountId(value) {
        if (!isBaileysProviderEnabled()) return null;
        const normalized = sanitizeIdPart(value || '', '');
        if (normalized && BAILEYS_ACCOUNTS_BY_ID.has(normalized)) return normalized;
        return ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID;
    }

    function normalizeCustomerNameForConflict(value, phoneDigits = '') {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const lowered = raw.toLowerCase();
        if (['whatsapp', 'contacto whatsapp', 'contato whatsapp'].includes(lowered)) {
            return '';
        }
        const nameDigits = raw.replace(/\D/g, '');
        if (phoneDigits && nameDigits) {
            if (
                nameDigits === phoneDigits ||
                nameDigits.endsWith(phoneDigits) ||
                phoneDigits.endsWith(nameDigits)
            ) {
                return '';
            }
        }
        return lowered;
    }

    async function hasDifferentCustomerNamesForPhone(rawPhone) {
        const normalizedPhone = normalizePhone(String(rawPhone || ''));
        const digits = normalizedPhone.replace(/\D/g, '');
        if (!digits) return false;

        const rows = await dbAllAsync(
            `SELECT name
             FROM customers
             WHERE replace(replace(replace(ifnull(phone, ''), '+', ''), ' ', ''), '-', '') = ?`,
            [digits]
        );

        const distinctNames = new Set();
        for (const row of Array.isArray(rows) ? rows : []) {
            const normalizedName = normalizeCustomerNameForConflict(row?.name, digits);
            if (!normalizedName) continue;
            distinctNames.add(normalizedName);
            if (distinctNames.size > 1) return true;
        }

        return false;
    }

    async function resolveOutboundAccountIdForPhone(rawPhone, preferredAccountId = '') {
        const baseAccountId = resolveConversationAccountId(preferredAccountId);
        if (!isBaileysProviderEnabled()) return baseAccountId;

        try {
            const hasNameConflict = await hasDifferentCustomerNamesForPhone(rawPhone);
            if (!hasNameConflict) return baseAccountId;
            return ACTIVE_BAILEYS_NAME_CONFLICT_ACCOUNT_ID;
        } catch (error) {
            logChatCore('name_conflict_account_resolve_error', {
                phone: String(rawPhone || '').replace(/\D/g, ''),
                error: String(error?.message || error),
            });
            return baseAccountId;
        }
    }

    async function setConversationWhatsAppAccount(conversationId, rawAccountId) {
        const normalizedConversationId = String(conversationId || '').trim();
        if (!normalizedConversationId) return null;
        const accountId = resolveConversationAccountId(rawAccountId);
        await dbRunAsync(
            `UPDATE conversations
             SET whatsapp_account_id = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [accountId || null, normalizedConversationId]
        );
        return getLocalConversationById(normalizedConversationId);
    }

    async function findLocalCustomerByPhone(rawPhone) {
        const normalized = normalizePhone(String(rawPhone || ''));
        if (!normalized) return null;
        const digits = normalized.replace(/\D/g, '');

        const exact = await dbGetAsync(
            `SELECT id, source_id, name, company, contact_name, phone, email, owner_id, type, contacts_json, allow_auto_responses, documents_folder, nif, niss, senha_financas, senha_seg_social, tipo_iva, morada, customer_profile_json, managers_json, access_credentials_json, agregado_familiar_json, fichas_relacionadas_json, supabase_payload_json, supabase_updated_at
             FROM customers
             WHERE phone = ?
             LIMIT 1`,
            [normalized]
        );
        if (exact) return normalizeLocalSqlCustomer(exact);

        const likeRows = await dbAllAsync(
            `SELECT id, source_id, name, company, contact_name, phone, email, owner_id, type, contacts_json, allow_auto_responses, documents_folder, nif, niss, senha_financas, senha_seg_social, tipo_iva, morada, customer_profile_json, managers_json, access_credentials_json, agregado_familiar_json, fichas_relacionadas_json, supabase_payload_json, supabase_updated_at
             FROM customers
             WHERE replace(replace(phone, '+', ''), ' ', '') LIKE ?
             LIMIT 5`,
            [`%${digits}`]
        );
        if (likeRows.length > 0) {
            return normalizeLocalSqlCustomer(likeRows[0]);
        }

        return null;
    }

    function shouldHydrateCustomerNameFromHint(existing) {
        const name = String(existing?.name || '').trim();
        const phone = String(existing?.phone || '').trim();
        const company = String(existing?.company || '').trim().toLowerCase();
        if (!name) return true;
        if (phone && name === phone) return true;
        if (name.startsWith('+') && name.replace(/\D/g, '').length >= 6) return true;
        if (company === 'whatsapp') return true;
        return false;
    }

    function looksLikePhoneLabel(value) {
        const raw = String(value || '').trim();
        if (!raw) return false;
        if (/^\+?\d[\d\s-]{5,}$/.test(raw)) return true;
        const digits = raw.replace(/\D/g, '');
        return digits.length >= 7 && digits.length >= Math.max(7, raw.length - 3);
    }

    async function ensureCustomerForPhone(rawPhone, options = {}) {
        const preferredName = String(options?.preferredName || '').trim();
        const preferredContactName = preferredName && !looksLikePhoneLabel(preferredName) ? preferredName : '';
        const preferredCompany = String(options?.preferredCompany || '').trim();

        const existing = await findLocalCustomerByPhone(rawPhone);
        if (existing) {
            const updateName = preferredName && shouldHydrateCustomerNameFromHint(existing);
            const updateCompany = preferredCompany && String(existing?.company || '').trim().toLowerCase() === 'whatsapp';
            const currentContactName = String(existing?.contactName || '').trim();
            const updateContactName =
                preferredContactName &&
                preferredContactName.toLowerCase() !== currentContactName.toLowerCase();
            if (updateName || updateCompany || updateContactName) {
                return upsertLocalCustomer({
                    id: existing.id,
                    name: updateName ? preferredName : existing.name,
                    company: updateCompany ? preferredCompany : existing.company,
                    contactName: updateContactName ? preferredContactName : currentContactName,
                    phone: existing.phone,
                });
            }
            return existing;
        }

        const normalized = normalizePhone(String(rawPhone || ''));
        const fallbackName = preferredContactName || normalized || 'Contacto WhatsApp';
        return upsertLocalCustomer({
            id: `wa_c_${normalized.replace(/\D/g, '') || Date.now()}`,
            name: fallbackName,
            company: preferredCompany || 'WhatsApp',
            contactName: preferredContactName || undefined,
            phone: normalized,
            allowAutoResponses: true,
            type: CUSTOMER_TYPES.PRIVATE,
            contacts: [],
        });
    }

    async function ensureConversationForPhone(rawPhone, options = {}) {
        const normalized = normalizePhone(String(rawPhone || ''));
        const digits = normalized.replace(/\D/g, '');
        const preferredConversationId = digits ? `conv_wa_c_${digits}` : '';

        let existingConversation = preferredConversationId ? await getLocalConversationById(preferredConversationId) : null;
        let customer = existingConversation ? await getLocalCustomerById(existingConversation.customerId) : null;

        if (!customer) {
            customer = await ensureCustomerForPhone(rawPhone, options.customer || {});
        }
        if (!existingConversation) {
            existingConversation = await getLocalConversationByCustomerId(customer.id);
        }

        const unreadIncrement = Number(options.unreadIncrement || 0);
        const targetUnread =
            options.unreadCount !== undefined
                ? Number(options.unreadCount)
                : Number(existingConversation?.unreadCount || 0) + unreadIncrement;

        const nextStatus = options.status || existingConversation?.status || 'open';
        const nextOwnerId =
            options.ownerId !== undefined ? options.ownerId : existingConversation?.ownerId || customer.ownerId || null;
        const nextWhatsappAccountId =
            options.whatsappAccountId !== undefined
                ? resolveConversationAccountId(options.whatsappAccountId)
                : resolveConversationAccountId(existingConversation?.whatsappAccountId);

        const conversation = await upsertLocalConversation({
            id: existingConversation?.id || preferredConversationId || undefined,
            customerId: customer.id,
            whatsappAccountId: nextWhatsappAccountId,
            ownerId: nextOwnerId,
            status: nextStatus,
            lastMessageAt: options.lastMessageAt || nowIso(),
            unreadCount: Math.max(0, Number.isFinite(targetUnread) ? targetUnread : 0),
        });

        return { customer, conversation };
    }

    async function writeAuditLog({ actorUserId, entityType, entityId, action, details }) {
        try {
            await dbRunAsync(
                `INSERT INTO audit_logs (actor_user_id, entity_type, entity_id, action, details_json, created_at)
                 VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                    actorUserId ? String(actorUserId).trim() : null,
                    String(entityType || '').trim() || 'system',
                    entityId ? String(entityId).trim() : null,
                    String(action || '').trim() || 'unknown',
                    details ? JSON.stringify(details) : null,
                ]
            );
        } catch (error) {
            console.error('[Audit] Falha a gravar log:', error?.message || error);
        }
    }

    function normalizeTemplateKind(kind) {
        const value = String(kind || '').trim().toLowerCase();
        if (value === 'quick_reply') return 'quick_reply';
        return 'template';
    }

    function normalizeLocalTemplate(row) {
        if (!row) return null;
        return {
            id: String(row.id || '').trim(),
            name: String(row.name || '').trim() || 'Template',
            kind: normalizeTemplateKind(row.kind),
            content: String(row.content || '').trim(),
            metaTemplateName: String(row.meta_template_name || '').trim() || undefined,
            isActive: normalizeBoolean(row.is_active, true),
            updatedAt: String(row.updated_at || '').trim() || nowIso(),
        };
    }

    async function getLocalTemplates(kind = '') {
        const normalizedKind = normalizeTemplateKind(kind);
        const rows = kind
            ? await dbAllAsync(
                  `SELECT id, name, kind, content, meta_template_name, is_active, updated_at
                   FROM message_templates
                   WHERE kind = ?
                   ORDER BY datetime(updated_at) DESC`,
                  [normalizedKind]
              )
            : await dbAllAsync(
                  `SELECT id, name, kind, content, meta_template_name, is_active, updated_at
                   FROM message_templates
                   ORDER BY datetime(updated_at) DESC`
              );
        return rows.map(normalizeLocalTemplate).filter(Boolean);
    }

    async function upsertLocalTemplate(input) {
        const id = String(input.id || '').trim() || `tpl_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const name = String(input.name || '').trim() || 'Template';
        const kind = normalizeTemplateKind(input.kind);
        const content = String(input.content || '').trim();
        const metaTemplateName = String(input.metaTemplateName || '').trim();
        const isActive = normalizeBoolean(input.isActive, true);

        if (!content) throw new Error('Template precisa de conteúdo.');

        await dbRunAsync(
            `INSERT INTO message_templates (id, name, kind, content, meta_template_name, is_active, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               kind = excluded.kind,
               content = excluded.content,
               meta_template_name = excluded.meta_template_name,
               is_active = excluded.is_active,
               updated_at = CURRENT_TIMESTAMP`,
            [id, name, kind, content, metaTemplateName || null, isActive ? 1 : 0]
        );

        const row = await dbGetAsync(
            `SELECT id, name, kind, content, meta_template_name, is_active, updated_at
             FROM message_templates
             WHERE id = ?
             LIMIT 1`,
            [id]
        );
        return normalizeLocalTemplate(row);
    }

    function applyTemplateVariables(content, variables = {}) {
        const source = String(content || '');
        return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
            const value = variables[key];
            if (value === undefined || value === null) return '';
            return String(value);
        });
    }

    async function enqueueOutboundMessage(input) {
        const toNumber = String(input.toNumber || '').replace(/\D/g, '');
        if (!toNumber) throw new Error('Número de destino inválido para fila de envio.');

        const messageKind = String(input.messageKind || 'text').trim();
        const messageBody = String(input.messageBody || '').trim();
        const templateName = String(input.templateName || '').trim();
        const variables = input.variables && typeof input.variables === 'object' ? input.variables : {};
        const nextAttemptAt = input.nextAttemptAt || nowIso();
        const accountId = resolveConversationAccountId(input.accountId);

        const result = await dbRunAsync(
            `INSERT INTO outbound_queue (
                conversation_id, account_id, to_number, message_kind, message_body, template_name,
                variables_json, status, retry_count, next_attempt_at, created_by, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
                input.conversationId || null,
                accountId || null,
                toNumber,
                messageKind,
                messageBody || null,
                templateName || null,
                JSON.stringify(variables),
                nextAttemptAt,
                input.createdBy || null,
            ]
        );

        return Number(result.lastID || 0);
    }

    return {
        normalizeConversationStatus,
        sanitizeConversationId,
        normalizeLocalSqlConversation,
        getAllLocalConversations,
        getLocalConversationById,
        getLocalConversationByCustomerId,
        upsertLocalConversation,
        resolveConversationAccountId,
        resolveOutboundAccountIdForPhone,
        hasDifferentCustomerNamesForPhone,
        setConversationWhatsAppAccount,
        findLocalCustomerByPhone,
        ensureCustomerForPhone,
        ensureConversationForPhone,
        mergeConversationReferences,
        ensureCustomerPhoneForConversationReassign,
        writeAuditLog,
        normalizeTemplateKind,
        normalizeLocalTemplate,
        getLocalTemplates,
        upsertLocalTemplate,
        applyTemplateVariables,
        enqueueOutboundMessage,
    };
}

module.exports = { createConversationRepository };
