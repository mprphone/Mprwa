function createMessageService(deps) {
    const {
        db,
        dbRunAsync,
        dbGetAsync,
        dbAllAsync,
        ENABLE_WEBHOOK_AUTOREPLY,
        ACTIVE_WHATSAPP_PROVIDER,
        MAX_QUEUE_RETRIES,
        sendWhatsAppMenuMessage,
        sendWhatsAppTextMessage,
        isBlockedContact,
        emitChatEvent,
        logChatCore,
        nowIso,
        resolveConversationAccountId,
        resolveOutboundAccountIdForPhone,
        ensureConversationForPhone,
        writeAuditLog,
        mobilePushService,
        pickBaileysGatewayForOutbound,
    } = deps;

    async function handleInboundAutomationReply(from, text) {
        if (!ENABLE_WEBHOOK_AUTOREPLY) return;

        const lowerText = String(text || '').toLowerCase();
        if (!lowerText) return;

        try {
            if (lowerText.match(/(oi|olá|ola|menu|teste)/)) {
                await sendWhatsAppMenuMessage(from);
                db.run(
                    "INSERT INTO messages (from_number, body, direction, status) VALUES (?, ?, 'outbound', 'replied')",
                    [from, '🤖 [Menu Enviado]'],
                    () => {}
                );
                return;
            }

            if (lowerText === 'ver status') {
                const reply = '✅ O sistema está operacional e online!';
                await sendWhatsAppTextMessage({ to: from, body: reply });
                db.run(
                    "INSERT INTO messages (from_number, body, direction, status) VALUES (?, ?, 'outbound', 'replied')",
                    [from, reply],
                    () => {}
                );
                return;
            }

            if (lowerText === 'falar com suporte') {
                const reply = '📞 Um atendente humano irá falar consigo em breve.';
                await sendWhatsAppTextMessage({ to: from, body: reply });
                db.run(
                    "INSERT INTO messages (from_number, body, direction, status) VALUES (?, ?, 'outbound', 'replied')",
                    [from, reply],
                    () => {}
                );
            }
        } catch (error) {
            const details = error?.response?.data || error?.message || error;
            console.error('[Chat Automation] Erro ao responder automaticamente:', details);
        }
    }

    async function persistInboundWhatsAppMessage({
        fromNumber,
        body,
        waId,
        rawType = 'unknown',
        direction = 'inbound',
        preferredName = '',
        mediaKind = '',
        mediaPath = '',
        mediaMimeType = '',
        mediaFileName = '',
        mediaSize = null,
        mediaProvider = 'baileys',
        accountId = '',
        mediaRemoteId = '',
        mediaRemoteUrl = '',
        mediaMeta = null,
    }) {
        const from = String(fromNumber || '').replace(/\D/g, '');
        if (!from) return;
        const normalizedDirection = String(direction || '')
            .trim()
            .toLowerCase() === 'outbound'
            ? 'outbound'
            : 'inbound';
        const normalizedStatus = normalizedDirection === 'outbound' ? 'sent' : 'received';
        if (normalizedDirection === 'inbound') {
            const shouldIgnoreInbound = await isBlockedContact({
                channel: 'whatsapp',
                contactKey: from,
            });
            if (shouldIgnoreInbound) {
                emitChatEvent('inbound_blocked', {
                    channel: 'whatsapp',
                    from,
                    waId: String(waId || '').trim() || null,
                });
                logChatCore('inbound_blocked', {
                    provider: ACTIVE_WHATSAPP_PROVIDER,
                    channel: 'whatsapp',
                    from,
                    waId: String(waId || '').trim() || null,
                });
                return;
            }
        }
        const rawText = String(body || '').trim() || `[Midia/Outro: ${String(rawType || 'unknown')}]`;
        const messageId = String(waId || '').trim() || null;
        const normalizedPreferredName = String(preferredName || '').trim();

        try {
            const normalizedMediaKind = String(mediaKind || '').trim().toLowerCase() || null;
            const normalizedMediaPath = String(mediaPath || '').trim() || null;
            const normalizedMediaMimeType = String(mediaMimeType || '').trim() || null;
            const normalizedMediaFileName = String(mediaFileName || '').trim() || null;
            const normalizedMediaRemoteId = String(mediaRemoteId || '').trim() || null;
            const normalizedMediaRemoteUrl = String(mediaRemoteUrl || '').trim() || null;
            const normalizedMediaProvider = String(mediaProvider || '').trim() || ACTIVE_WHATSAPP_PROVIDER;
            const normalizedAccountId = resolveConversationAccountId(accountId);
            const normalizedMediaSize = Number.isFinite(Number(mediaSize)) ? Number(mediaSize) : null;
            const normalizedMediaMeta =
                mediaMeta && typeof mediaMeta === 'object' ? JSON.stringify(mediaMeta) : null;
            let normalizedText = rawText;
            if ((normalizedMediaKind === 'image' || normalizedMediaKind === 'document') && /^\[midia\/outro:/i.test(normalizedText)) {
                const defaultName = normalizedMediaKind === 'image' ? 'imagem' : 'documento';
                const mediaLabel = normalizedMediaFileName || defaultName;
                normalizedText =
                    normalizedMediaKind === 'image'
                        ? `[Imagem] ${mediaLabel}`
                        : `[Documento] ${mediaLabel}`;
            }

            const inserted = await dbRunAsync(
                `INSERT OR IGNORE INTO messages (
                    wa_id, account_id, from_number, body, direction, status,
                    media_kind, media_path, media_mime_type, media_file_name, media_size,
                    media_provider, media_remote_id, media_remote_url, media_meta_json
                )
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    messageId,
                    normalizedAccountId,
                    from,
                    normalizedText,
                    normalizedDirection,
                    normalizedStatus,
                    normalizedMediaKind,
                    normalizedMediaPath,
                    normalizedMediaMimeType,
                    normalizedMediaFileName,
                    normalizedMediaSize,
                    normalizedMediaProvider || null,
                    normalizedMediaRemoteId,
                    normalizedMediaRemoteUrl,
                    normalizedMediaMeta,
                ]
            );

            if (Number(inserted?.changes || 0) === 0) {
                const duplicateEvent = normalizedDirection === 'outbound' ? 'outbound_duplicate' : 'inbound_duplicate';
                emitChatEvent(duplicateEvent, {
                    from,
                    waId: messageId,
                    accountId: normalizedAccountId,
                    provider: ACTIVE_WHATSAPP_PROVIDER,
                });
                logChatCore(`${normalizedDirection}_duplicate`, {
                    provider: ACTIVE_WHATSAPP_PROVIDER,
                    from,
                    waId: messageId,
                    accountId: normalizedAccountId,
                });
                return;
            }

            const { conversation } = await ensureConversationForPhone(from, {
                ...(normalizedDirection === 'inbound' ? { unreadIncrement: 1 } : { unreadCount: 0 }),
                status: 'open',
                lastMessageAt: nowIso(),
                whatsappAccountId: normalizedAccountId,
                customer: {
                    preferredName: normalizedPreferredName || undefined,
                },
            });

            await writeAuditLog({
                actorUserId: null,
                entityType: 'message',
                entityId: messageId,
                action: normalizedDirection === 'inbound' ? 'received' : 'sent',
                details: {
                    from,
                    type: String(rawType || 'unknown'),
                    provider: ACTIVE_WHATSAPP_PROVIDER,
                    accountId: normalizedAccountId,
                    preferredName: normalizedPreferredName || null,
                    direction: normalizedDirection,
                },
            });

            if (normalizedDirection === 'outbound') {
                emitChatEvent('outbound_sent', {
                    to: from,
                    waId: messageId,
                    conversationId: conversation?.id || null,
                    body: String(normalizedText).slice(0, 300),
                    provider: ACTIVE_WHATSAPP_PROVIDER,
                    accountId: normalizedAccountId,
                    source: 'baileys_mobile',
                });
                logChatCore('outbound_saved', {
                    provider: ACTIVE_WHATSAPP_PROVIDER,
                    to: from,
                    waId: messageId,
                    accountId: normalizedAccountId,
                    conversationId: conversation?.id || null,
                    source: 'baileys_mobile',
                });
            } else {
                emitChatEvent('inbound_received', {
                    from,
                    waId: messageId,
                    conversationId: conversation?.id || null,
                    body: String(normalizedText).slice(0, 300),
                    provider: ACTIVE_WHATSAPP_PROVIDER,
                    accountId: normalizedAccountId,
                });
                logChatCore('inbound_saved', {
                    provider: ACTIVE_WHATSAPP_PROVIDER,
                    from,
                    waId: messageId,
                    accountId: normalizedAccountId,
                    conversationId: conversation?.id || null,
                });

                void Promise.resolve()
                    .then(() =>
                        mobilePushService.sendInboundMessageNotification({
                            from,
                            preview: String(normalizedText || '').slice(0, 140),
                            conversationId: conversation?.id || null,
                        })
                    )
                    .catch((pushError) => {
                        console.warn('[MobilePush] Falha ao enviar notificação inbound:', pushError?.message || pushError);
                    });

                if (ENABLE_WEBHOOK_AUTOREPLY) {
                    void handleInboundAutomationReply(from, normalizedText);
                }
            }
        } catch (error) {
            console.error('[WhatsApp inbound] Falha ao persistir mensagem:', error?.message || error);
        }
    }

    async function moveQueueToDeadLetter(job, message, retryCount) {
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS outbound_dead_letter (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                queue_id INTEGER NOT NULL UNIQUE,
                conversation_id TEXT,
                account_id TEXT,
                to_number TEXT NOT NULL,
                message_kind TEXT NOT NULL,
                message_body TEXT,
                template_name TEXT,
                variables_json TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                created_by TEXT,
                failed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        await dbRunAsync(`CREATE INDEX IF NOT EXISTS idx_outbound_dead_letter_failed_at ON outbound_dead_letter(failed_at DESC)`);

        await dbRunAsync(
            `INSERT INTO outbound_dead_letter (
                queue_id, conversation_id, account_id, to_number, message_kind, message_body, template_name,
                variables_json, retry_count, last_error, created_by, failed_at, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(queue_id) DO UPDATE SET
               retry_count = excluded.retry_count,
               last_error = excluded.last_error,
               failed_at = CURRENT_TIMESTAMP`,
            [
                Number(job.id || 0),
                job.conversation_id || null,
                resolveConversationAccountId(job.account_id) || null,
                String(job.to_number || '').replace(/\D/g, ''),
                String(job.message_kind || 'text').trim(),
                String(job.message_body || '').trim() || null,
                String(job.template_name || '').trim() || null,
                String(job.variables_json || '').trim() || null,
                Number(retryCount || 0),
                String(message || '').slice(0, 2000),
                job.created_by || null,
            ]
        );
    }

    async function markQueueAsFailed(job, message, willRetry) {
        const queueId = Number(job.id || 0);
        const conversationId = String(job.conversation_id || '').trim() || null;
        const to = String(job.to_number || '').replace(/\D/g, '');
        const messageKind = String(job.message_kind || 'text').trim();
        const accountId = resolveConversationAccountId(job.account_id);
        const retryCount = Number(job.retry_count || 0) + 1;
        const delayMinutes = Math.min(30, Math.pow(2, Math.min(retryCount, MAX_QUEUE_RETRIES)));
        const nextAttemptAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
        const status = willRetry ? 'queued' : 'dead_letter';

        await dbRunAsync(
            `UPDATE outbound_queue
             SET status = ?, retry_count = ?, last_error = ?, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [status, retryCount, String(message || '').slice(0, 2000), nextAttemptAt, queueId]
        );

        if (willRetry) {
            emitChatEvent('queue_retry_scheduled', {
                queueId,
                conversationId,
                accountId,
                to,
                messageKind,
                retryCount,
                error: String(message || '').slice(0, 500),
            });
            logChatCore('queue_retry_scheduled', {
                queueId,
                conversationId,
                accountId,
                to,
                messageKind,
                retryCount,
                error: String(message || '').slice(0, 500),
            });
            return;
        }

        await moveQueueToDeadLetter(job, message, retryCount);
        emitChatEvent('queue_dead_letter', {
            queueId,
            conversationId,
            accountId,
            to,
            messageKind,
            retryCount,
            error: String(message || '').slice(0, 500),
        });
        logChatCore('queue_dead_letter', {
            queueId,
            conversationId,
            accountId,
            to,
            messageKind,
            retryCount,
            error: String(message || '').slice(0, 500),
        });
    }

    async function processQueueJobViaBaileys({
        job,
        queueId,
        conversationId,
        messageKind,
        toNumber,
        queueVariables,
        accountId,
    }) {
        const resolved = pickBaileysGatewayForOutbound(accountId);
        if (!resolved.gateway) {
            const retryAllowed = Number(job.retry_count || 0) < MAX_QUEUE_RETRIES;
            await markQueueAsFailed(job, `Conta Baileys não inicializada (${resolved.accountId}).`, retryAllowed);
            return;
        }

        if (resolved.fallbackFrom) {
            logChatCore('queue_account_fallback', {
                queueId,
                conversationId,
                fromAccountId: resolved.fallbackFrom,
                toAccountId: resolved.accountId,
                connected: resolved.connected === true,
            });
        }

        if (messageKind === 'meta_template') {
            await markQueueAsFailed(
                job,
                'Templates Meta não são suportados no modo Baileys. Envie como texto/template local.',
                false
            );
            logChatCore('queue_template_not_supported_baileys', {
                queueId,
                conversationId,
                accountId: resolved.accountId,
                to: toNumber,
            });
            return;
        }

        let sent = null;
        const caption = String(job.message_body || '').trim();

        try {
            if (messageKind === 'image') {
                const image = queueVariables?.__image || {};
                const imagePath = String(image.path || '').trim();
                if (!imagePath) {
                    await markQueueAsFailed(job, 'Mensagem de imagem sem caminho do ficheiro.', false);
                    return;
                }
                sent = await resolved.gateway.sendImage({
                    to: toNumber,
                    path: imagePath,
                    caption,
                });
            } else if (messageKind === 'document') {
                const document = queueVariables?.__document || {};
                const documentPath = String(document.path || '').trim();
                if (!documentPath) {
                    await markQueueAsFailed(job, 'Mensagem de documento sem caminho do ficheiro.', false);
                    return;
                }
                sent = await resolved.gateway.sendDocument({
                    to: toNumber,
                    path: documentPath,
                    fileName: String(document.fileName || '').trim() || null,
                    mimeType: String(document.mimeType || '').trim() || null,
                    caption,
                });
            } else {
                const text = String(job.message_body || '').trim();
                if (!text) {
                    await markQueueAsFailed(job, 'Mensagem vazia para envio de texto.', false);
                    return;
                }
                sent = await resolved.gateway.sendText({
                    to: toNumber,
                    body: text,
                });
            }
        } catch (error) {
            const details = error?.response?.data || error?.message || error;
            const message = typeof details === 'string' ? details : JSON.stringify(details);
            const isPermanent =
                /enoent|eacces|sem caminho|invalido|inválido|not found|invalid/i.test(message);
            const retryAllowed = !isPermanent && Number(job.retry_count || 0) < MAX_QUEUE_RETRIES;
            await markQueueAsFailed(job, `Baileys: ${message}`, retryAllowed);
            logChatCore('queue_baileys_send_error', {
                queueId,
                conversationId,
                accountId: resolved.accountId,
                to: toNumber,
                messageKind,
                retryAllowed,
                error: String(message).slice(0, 500),
            });
            return;
        }

        const waId = String(sent?.waId || '').trim() || null;
        const bodyForLog =
            messageKind === 'image'
                ? `[Imagem] ${String(queueVariables?.__image?.fileName || 'imagem')}${caption ? `\n${caption}` : ''}`
                : messageKind === 'document'
                    ? `[Documento] ${String(queueVariables?.__document?.fileName || 'documento')}${caption ? `\n${caption}` : ''}`
                    : String(job.message_body || '').trim();
        const mediaKindForInsert =
            messageKind === 'image' || messageKind === 'document' ? messageKind : null;
        const mediaPathForInsert =
            messageKind === 'image'
                ? String(queueVariables?.__image?.path || '').trim() || null
                : messageKind === 'document'
                    ? String(queueVariables?.__document?.path || '').trim() || null
                    : null;
        const mediaMimeTypeForInsert =
            messageKind === 'image'
                ? String(queueVariables?.__image?.mimeType || '').trim() || null
                : messageKind === 'document'
                    ? String(queueVariables?.__document?.mimeType || '').trim() || null
                    : null;
        const mediaFileNameForInsert =
            messageKind === 'image'
                ? String(queueVariables?.__image?.fileName || '').trim() || null
                : messageKind === 'document'
                    ? String(queueVariables?.__document?.fileName || '').trim() || null
                    : null;

        await dbRunAsync(
            `INSERT OR IGNORE INTO messages (
                wa_id, account_id, from_number, body, direction, status,
                media_kind, media_path, media_mime_type, media_file_name, media_provider
            ) VALUES (?, ?, ?, ?, 'outbound', 'submitted', ?, ?, ?, ?, 'baileys')`,
            [
                waId,
                resolved.accountId,
                toNumber,
                bodyForLog,
                mediaKindForInsert,
                mediaPathForInsert,
                mediaMimeTypeForInsert,
                mediaFileNameForInsert,
            ]
        );

        await dbRunAsync(
            `UPDATE outbound_queue
             SET status = 'sent', wa_id = ?, last_error = NULL, sent_at = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [waId, nowIso(), job.id]
        );

        await ensureConversationForPhone(toNumber, {
            unreadCount: 0,
            status: 'open',
            lastMessageAt: nowIso(),
            whatsappAccountId: resolved.accountId,
        });

        await writeAuditLog({
            actorUserId: job.created_by || null,
            entityType: 'outbound_queue',
            entityId: String(job.id),
            action: 'sent',
            details: {
                queueId,
                to: toNumber,
                kind: messageKind,
                waId,
                conversationId,
                provider: 'baileys',
                accountId: resolved.accountId,
            },
        });

        emitChatEvent('outbound_sent', {
            queueId,
            conversationId,
            to: toNumber,
            waId: waId || null,
            messageKind,
            provider: 'baileys',
            accountId: resolved.accountId,
        });
        logChatCore('queue_sent', {
            queueId,
            conversationId,
            to: toNumber,
            waId: waId || null,
            messageKind,
            provider: 'baileys',
            accountId: resolved.accountId,
        });
    }

    async function processQueueJob(job) {
        const queueId = Number(job.id || 0);
        const conversationId = String(job.conversation_id || '').trim() || null;
        const messageKind = String(job.message_kind || 'text').trim();
        const toNumber = String(job.to_number || '').replace(/\D/g, '');
        const accountId = await resolveOutboundAccountIdForPhone(toNumber, job.account_id);
        logChatCore('queue_processing', {
            queueId,
            conversationId,
            accountId,
            messageKind,
            to: toNumber,
            retryCount: Number(job.retry_count || 0),
        });

        if (!toNumber) {
            await markQueueAsFailed(job, 'Destino inválido', false);
            logChatCore('queue_invalid_destination', {
                queueId,
                conversationId,
                accountId,
                messageKind,
            });
            return;
        }

        let queueVariables = {};
        try {
            const rawVariables = String(job.variables_json || '').trim();
            if (rawVariables) {
                const parsed = JSON.parse(rawVariables);
                if (parsed && typeof parsed === 'object') {
                    queueVariables = parsed;
                }
            }
        } catch (error) {
            queueVariables = {};
        }

        // Envio exclusivo via Baileys (removido suporte à API da Meta)
        await processQueueJobViaBaileys({
            job,
            queueId,
            conversationId,
            messageKind,
            toNumber,
            queueVariables,
            accountId,
        });
    }

    return {
        handleInboundAutomationReply,
        persistInboundWhatsAppMessage,
        processQueueJob,
    };
}

module.exports = { createMessageService };
