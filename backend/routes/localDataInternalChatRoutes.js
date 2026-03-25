'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INTERNAL_CHAT_MEDIA_ROOT = process.env.INTERNAL_CHAT_MEDIA_ROOT
    ? path.resolve(process.env.INTERNAL_CHAT_MEDIA_ROOT)
    : path.resolve(process.cwd(), 'internal_chat_media');
const MAX_INTERNAL_MEDIA_BYTES = 20 * 1024 * 1024;

/**
 * Internal Chat routes: conversations, messages, reactions, presence, media.
 * Extracted from localDataRoutes.js for maintainability.
 */
function registerInternalChatRoutes(context, helpers) {
    const {
        app, dbRunAsync, dbGetAsync, dbAllAsync, writeAuditLog,
        SUPABASE_URL, SUPABASE_KEY, nowIso,
    } = context;

    const {
        parseBoolean, mapInternalMessageRow,
        ensureInternalMediaRoot, resolveInternalMediaAbsolutePath,
        sanitizeInternalFileName,
        ensureInternalMessageReactionsSchema,
        touchInternalChatPresence, readInternalChatPresence,
        syncInternalChatHistoryFromSupabase,
        maybeQueueInternalAssistantReply,
        deleteInternalChatPlaceholderUserIfOrphan,
        internalChatSupabaseHistorySyncRunning_get,
        internalChatSupabaseHistorySyncRunning_set,
    } = helpers;

    app.get('/api/internal-chat/presence', async (req, res) => {
        try {
            const userId = String(req.query.userId || '').trim();
            const queryUserIds = Array.isArray(req.query.userIds)
                ? req.query.userIds
                : [req.query.userIds];
            const csvUserIds = queryUserIds
                .map((item) => String(item || '').trim())
                .filter(Boolean)
                .flatMap((item) => item.split(','))
                .map((item) => String(item || '').trim())
                .filter(Boolean);
            const onlineWindowSeconds = Math.max(15, Number(req.query.windowSeconds || 75) || 75);
            const touchRaw = String(req.query.touch ?? '1').trim().toLowerCase();
            const shouldTouch = !['0', 'false', 'no', 'off', 'nao', 'não'].includes(touchRaw);

            if (shouldTouch && userId) {
                const exists = await dbGetAsync('SELECT id FROM users WHERE id = ? LIMIT 1', [userId]);
                if (exists) {
                    await touchInternalChatPresence(userId, 'presence');
                }
            }

            const data = await readInternalChatPresence(csvUserIds, onlineWindowSeconds);
            return res.json({ success: true, data, onlineWindowSeconds });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao listar presença:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/internal-chat/history/supabase/import', async (req, res) => {
        try {
            if (!SUPABASE_URL || !SUPABASE_KEY) {
                return res.status(400).json({
                    success: false,
                    error: 'Supabase não configurado (SUPABASE_URL/SUPABASE_KEY).',
                });
            }

            if (internalChatSupabaseHistorySyncRunning_get()) {
                return res.status(202).json({
                    success: true,
                    running: true,
                    skipped: true,
                    reason: 'already_running',
                });
            }

            const actorUserId = String(
                req.body?.actorUserId || req.body?.userId || req.query?.actorUserId || req.query?.userId || ''
            ).trim();
            const forceFull = parseBoolean(req.body?.forceFull);
            const maxRows = Math.min(50000, Math.max(200, Number(req.body?.maxRows || 20000) || 20000));

            internalChatSupabaseHistorySyncRunning_set(true);
            try {
                const summary = await syncInternalChatHistoryFromSupabase({
                    actorUserId,
                    forceFull,
                    maxRows,
                });
                return res.json({
                    success: true,
                    running: false,
                    ...summary,
                });
            } finally {
                internalChatSupabaseHistorySyncRunning_set(false);
            }
        } catch (error) {
            internalChatSupabaseHistorySyncRunning_set(false);
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao importar histórico do Supabase:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/internal-chat/conversations', async (req, res) => {
        try {
            const userId = String(req.query.userId || '').trim();
            if (!userId) {
                return res.status(400).json({ success: false, error: 'userId é obrigatório.' });
            }

            const exists = await dbGetAsync('SELECT id FROM users WHERE id = ? LIMIT 1', [userId]);
            if (!exists) {
                return res.status(404).json({ success: false, error: 'Funcionário não encontrado.' });
            }

            await touchInternalChatPresence(userId, 'conversations').catch(() => null);

            const rows = await dbAllAsync(
                `SELECT
                    c.id,
                    c.type,
                    c.title,
                    c.last_message_at,
                    c.updated_at,
                    me.last_read_at,
                    (
                        SELECT COUNT(*)
                        FROM internal_conversation_members mem
                        WHERE mem.conversation_id = c.id
                    ) AS member_count,
                    (
                        SELECT m2.user_id
                        FROM internal_conversation_members m2
                        WHERE m2.conversation_id = c.id
                          AND m2.user_id <> ?
                        ORDER BY datetime(m2.joined_at) ASC
                        LIMIT 1
                    ) AS other_user_id,
                    (
                        SELECT u2.name
                        FROM users u2
                        WHERE u2.id = (
                            SELECT m2.user_id
                            FROM internal_conversation_members m2
                            WHERE m2.conversation_id = c.id
                              AND m2.user_id <> ?
                            ORDER BY datetime(m2.joined_at) ASC
                            LIMIT 1
                        )
                    ) AS other_user_name,
                    (
                        SELECT u2.email
                        FROM users u2
                        WHERE u2.id = (
                            SELECT m2.user_id
                            FROM internal_conversation_members m2
                            WHERE m2.conversation_id = c.id
                              AND m2.user_id <> ?
                            ORDER BY datetime(m2.joined_at) ASC
                            LIMIT 1
                        )
                    ) AS other_user_email,
                    (
                        SELECT u2.avatar_url
                        FROM users u2
                        WHERE u2.id = (
                            SELECT m2.user_id
                            FROM internal_conversation_members m2
                            WHERE m2.conversation_id = c.id
                              AND m2.user_id <> ?
                            ORDER BY datetime(m2.joined_at) ASC
                            LIMIT 1
                        )
                    ) AS other_user_avatar,
                    (
                        SELECT im.body
                        FROM internal_messages im
                        WHERE im.conversation_id = c.id
                          AND im.deleted_at IS NULL
                        ORDER BY im.id DESC
                        LIMIT 1
                    ) AS last_message_body,
                    (
                        SELECT im.sender_user_id
                        FROM internal_messages im
                        WHERE im.conversation_id = c.id
                          AND im.deleted_at IS NULL
                        ORDER BY im.id DESC
                        LIMIT 1
                    ) AS last_sender_user_id,
                    (
                        SELECT COUNT(*)
                        FROM internal_messages im
                        WHERE im.conversation_id = c.id
                          AND im.deleted_at IS NULL
                          AND im.sender_user_id <> ?
                          AND (
                            me.last_read_at IS NULL
                            OR datetime(im.created_at) > datetime(me.last_read_at)
                          )
                    ) AS unread_count
                 FROM internal_conversations c
                 JOIN internal_conversation_members me
                   ON me.conversation_id = c.id
                  AND me.user_id = ?
                 ORDER BY datetime(COALESCE(c.last_message_at, c.updated_at, c.created_at)) DESC`,
                [userId, userId, userId, userId, userId, userId]
            );

            const data = rows.map((row) => ({
                id: String(row.id || '').trim(),
                type: String(row.type || 'direct').trim(),
                title: String(
                    row.type === 'group'
                        ? row.title || 'Grupo interno'
                        : row.other_user_name || row.title || 'Conversa interna'
                ).trim(),
                lastMessageAt: String(row.last_message_at || row.updated_at || '').trim(),
                lastMessageBody: String(row.last_message_body || '').trim(),
                lastSenderUserId: String(row.last_sender_user_id || '').trim() || null,
                unreadCount: Number(row.unread_count || 0),
                otherUserId: String(row.other_user_id || '').trim() || null,
                otherUserName: String(row.other_user_name || '').trim() || null,
                otherUserEmail: String(row.other_user_email || '').trim() || null,
                otherUserAvatar: String(row.other_user_avatar || '').trim() || '',
                memberCount: Number(row.member_count || 0),
            }));

            return res.json({ success: true, data });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao listar conversas:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/internal-chat/conversations/direct', async (req, res) => {
        try {
            const userId = String(req.body?.userId || '').trim();
            const targetUserId = String(req.body?.targetUserId || '').trim();

            if (!userId || !targetUserId) {
                return res.status(400).json({ success: false, error: 'userId e targetUserId são obrigatórios.' });
            }
            const isSelfConversation = userId === targetUserId;
            const users = isSelfConversation
                ? await dbAllAsync('SELECT id, name FROM users WHERE id = ?', [userId])
                : await dbAllAsync('SELECT id, name FROM users WHERE id IN (?, ?)', [userId, targetUserId]);
            if (!Array.isArray(users) || users.length < (isSelfConversation ? 1 : 2)) {
                return res.status(404).json({ success: false, error: 'Funcionário não encontrado.' });
            }

            const directKey = [userId, targetUserId].sort().join(':');
            let conversation = await dbGetAsync(
                `SELECT id, type, title, last_message_at, updated_at
                 FROM internal_conversations
                 WHERE direct_key = ?
                 LIMIT 1`,
                [directKey]
            );

            if (!conversation) {
                const conversationId = `ichat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
                const targetUserName = String(users.find((u) => String(u.id || '').trim() === targetUserId)?.name || '').trim();
                await dbRunAsync(
                    `INSERT INTO internal_conversations (
                        id, type, title, direct_key, created_by, created_at, updated_at, last_message_at
                     ) VALUES (?, 'direct', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)`,
                    [
                        conversationId,
                        isSelfConversation ? 'Notas e Avisos' : targetUserName || 'Conversa interna',
                        directKey,
                        userId,
                    ]
                );

                await dbRunAsync(
                    `INSERT OR IGNORE INTO internal_conversation_members (conversation_id, user_id, joined_at, last_read_at)
                     VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                    [conversationId, userId]
                );
                if (!isSelfConversation) {
                    await dbRunAsync(
                        `INSERT OR IGNORE INTO internal_conversation_members (conversation_id, user_id, joined_at, last_read_at)
                         VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                        [conversationId, targetUserId]
                    );
                }

                conversation = await dbGetAsync(
                    `SELECT id, type, title, last_message_at, updated_at
                     FROM internal_conversations
                     WHERE id = ?
                     LIMIT 1`,
                    [conversationId]
                );
            }

            await writeAuditLog({
                actorUserId: userId,
                entityType: 'internal_conversation',
                entityId: String(conversation?.id || '').trim() || null,
                action: 'open_direct',
                details: { targetUserId, selfConversation: isSelfConversation },
            });

            return res.json({
                success: true,
                conversation: {
                    id: String(conversation?.id || '').trim(),
                    type: String(conversation?.type || 'direct').trim(),
                    title: String(conversation?.title || '').trim(),
                    lastMessageAt: String(conversation?.last_message_at || conversation?.updated_at || '').trim() || null,
                },
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao criar conversa direta:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/internal-chat/conversations/group', async (req, res) => {
        try {
            const userId = String(req.body?.userId || '').trim();
            const rawTitle = String(req.body?.title || '').trim();
            const title = rawTitle || 'Grupo interno';
            const memberUserIdsRaw = Array.isArray(req.body?.memberUserIds) ? req.body.memberUserIds : [];

            if (!userId) {
                return res.status(400).json({ success: false, error: 'userId é obrigatório.' });
            }

            const normalizedMembers = new Set(
                memberUserIdsRaw
                    .map((value) => String(value || '').trim())
                    .filter(Boolean)
            );
            normalizedMembers.add(userId);
            const memberUserIds = Array.from(normalizedMembers);

            if (memberUserIds.length < 2) {
                return res.status(400).json({ success: false, error: 'Grupo deve ter pelo menos 2 membros.' });
            }

            const placeholders = memberUserIds.map(() => '?').join(',');
            const users = await dbAllAsync(
                `SELECT id, name FROM users WHERE id IN (${placeholders})`,
                memberUserIds
            );
            if (!Array.isArray(users) || users.length !== memberUserIds.length) {
                return res.status(404).json({ success: false, error: 'Um ou mais funcionários não foram encontrados.' });
            }

            const conversationId = `ichat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            await dbRunAsync(
                `INSERT INTO internal_conversations (
                    id, type, title, direct_key, created_by, created_at, updated_at, last_message_at
                 ) VALUES (?, 'group', ?, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)`,
                [conversationId, title, userId]
            );

            for (const memberId of memberUserIds) {
                await dbRunAsync(
                    `INSERT OR IGNORE INTO internal_conversation_members (conversation_id, user_id, joined_at, last_read_at)
                     VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                    [conversationId, memberId]
                );
            }

            await writeAuditLog({
                actorUserId: userId,
                entityType: 'internal_conversation',
                entityId: conversationId,
                action: 'create_group',
                details: { title, memberCount: memberUserIds.length },
            });

            return res.json({
                success: true,
                conversation: {
                    id: conversationId,
                    type: 'group',
                    title,
                    lastMessageAt: null,
                },
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao criar grupo:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/internal-chat/conversations/:id/members', async (req, res) => {
        try {
            const conversationId = String(req.params.id || '').trim();
            const userId = String(req.query.userId || '').trim();
            if (!conversationId || !userId) {
                return res.status(400).json({ success: false, error: 'conversationId e userId são obrigatórios.' });
            }

            const membership = await dbGetAsync(
                `SELECT conversation_id FROM internal_conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
                [conversationId, userId]
            );
            if (!membership) {
                return res.status(403).json({ success: false, error: 'Sem acesso a esta conversa.' });
            }

            await touchInternalChatPresence(userId, 'members').catch(() => null);

            const rows = await dbAllAsync(
                `SELECT
                    m.user_id,
                    m.joined_at,
                    u.name,
                    u.email,
                    u.avatar_url
                 FROM internal_conversation_members m
                 LEFT JOIN users u ON u.id = m.user_id
                 WHERE m.conversation_id = ?
                 ORDER BY datetime(m.joined_at) ASC`,
                [conversationId]
            );

            const data = rows.map((row) => ({
                userId: String(row.user_id || '').trim(),
                name: String(row.name || '').trim() || 'Funcionário',
                email: String(row.email || '').trim() || '',
                avatarUrl: String(row.avatar_url || '').trim() || '',
                joinedAt: String(row.joined_at || '').trim() || null,
            }));

            return res.json({ success: true, data });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao listar membros:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/internal-chat/conversations/:id/members', async (req, res) => {
        try {
            const conversationId = String(req.params.id || '').trim();
            const userId = String(req.body?.userId || '').trim();
            const memberUserIdsRaw = Array.isArray(req.body?.memberUserIds) ? req.body.memberUserIds : [];

            if (!conversationId || !userId) {
                return res.status(400).json({ success: false, error: 'conversationId e userId são obrigatórios.' });
            }

            const conversation = await dbGetAsync(
                `SELECT id, type, created_by FROM internal_conversations WHERE id = ? LIMIT 1`,
                [conversationId]
            );
            if (!conversation) {
                return res.status(404).json({ success: false, error: 'Conversa não encontrada.' });
            }
            if (String(conversation.type || '').trim() !== 'group') {
                return res.status(400).json({ success: false, error: 'Só é possível adicionar membros em grupos.' });
            }

            const actorMembership = await dbGetAsync(
                `SELECT conversation_id FROM internal_conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
                [conversationId, userId]
            );
            if (!actorMembership) {
                return res.status(403).json({ success: false, error: 'Sem acesso a esta conversa.' });
            }

            const memberUserIds = Array.from(
                new Set(memberUserIdsRaw.map((value) => String(value || '').trim()).filter(Boolean))
            );
            if (memberUserIds.length === 0) {
                return res.status(400).json({ success: false, error: 'memberUserIds é obrigatório.' });
            }

            const placeholders = memberUserIds.map(() => '?').join(',');
            const users = await dbAllAsync(
                `SELECT id FROM users WHERE id IN (${placeholders})`,
                memberUserIds
            );
            if (!Array.isArray(users) || users.length !== memberUserIds.length) {
                return res.status(404).json({ success: false, error: 'Um ou mais funcionários não foram encontrados.' });
            }

            let addedCount = 0;
            for (const memberId of memberUserIds) {
                const result = await dbRunAsync(
                    `INSERT OR IGNORE INTO internal_conversation_members (conversation_id, user_id, joined_at, last_read_at)
                     VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                    [conversationId, memberId]
                );
                if (Number(result?.changes || 0) > 0) {
                    addedCount += 1;
                }
            }

            await writeAuditLog({
                actorUserId: userId,
                entityType: 'internal_conversation',
                entityId: conversationId,
                action: 'add_members',
                details: { addedCount, requested: memberUserIds.length },
            });

            return res.json({ success: true, addedCount });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao adicionar membros:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/internal-chat/conversations/:id/delete', async (req, res) => {
        try {
            const conversationId = String(req.params.id || '').trim();
            const userId = String(req.body?.userId || '').trim();
            const deleteOrphanPlaceholderUsers = parseBoolean(req.body?.deleteOrphanPlaceholderUsers);

            if (!conversationId || !userId) {
                return res.status(400).json({ success: false, error: 'conversationId e userId são obrigatórios.' });
            }

            const conversation = await dbGetAsync(
                `SELECT id, type, title
                 FROM internal_conversations
                 WHERE id = ?
                 LIMIT 1`,
                [conversationId]
            );
            if (!conversation) {
                return res.status(404).json({ success: false, error: 'Conversa não encontrada.' });
            }

            const membership = await dbGetAsync(
                `SELECT conversation_id
                 FROM internal_conversation_members
                 WHERE conversation_id = ?
                   AND user_id = ?
                 LIMIT 1`,
                [conversationId, userId]
            );
            if (!membership) {
                return res.status(403).json({ success: false, error: 'Sem acesso a esta conversa.' });
            }

            const memberRows = await dbAllAsync(
                `SELECT user_id
                 FROM internal_conversation_members
                 WHERE conversation_id = ?`,
                [conversationId]
            );
            const relatedUserIds = Array.from(
                new Set(
                    (Array.isArray(memberRows) ? memberRows : [])
                        .map((row) => String(row?.user_id || '').trim())
                        .filter(Boolean)
                )
            );

            await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
            try {
                await ensureInternalMessageReactionsSchema();
                await dbRunAsync(
                    `DELETE FROM internal_message_reactions
                     WHERE message_id IN (
                        SELECT id
                        FROM internal_messages
                        WHERE conversation_id = ?
                     )`,
                    [conversationId]
                );
                await dbRunAsync(
                    `DELETE FROM internal_messages
                     WHERE conversation_id = ?`,
                    [conversationId]
                );
                await dbRunAsync(
                    `DELETE FROM internal_conversation_members
                     WHERE conversation_id = ?`,
                    [conversationId]
                );
                await dbRunAsync(
                    `DELETE FROM internal_conversations
                     WHERE id = ?`,
                    [conversationId]
                );
                await dbRunAsync('COMMIT');
            } catch (transactionError) {
                await dbRunAsync('ROLLBACK').catch(() => null);
                throw transactionError;
            }

            let removedPlaceholderUsers = 0;
            if (deleteOrphanPlaceholderUsers) {
                for (const memberUserId of relatedUserIds) {
                    if (!memberUserId || memberUserId === userId) continue;
                    const removed = await deleteInternalChatPlaceholderUserIfOrphan(memberUserId);
                    if (removed) removedPlaceholderUsers += 1;
                }
            }

            await writeAuditLog({
                actorUserId: userId,
                entityType: 'internal_conversation',
                entityId: conversationId,
                action: 'delete',
                details: {
                    type: String(conversation?.type || '').trim(),
                    title: String(conversation?.title || '').trim(),
                    deleteOrphanPlaceholderUsers,
                    removedPlaceholderUsers,
                },
            });

            return res.json({
                success: true,
                deletedConversationId: conversationId,
                removedPlaceholderUsers,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao eliminar conversa:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/internal-chat/messages', async (req, res) => {
        try {
            const conversationId = String(req.query.conversationId || '').trim();
            const userId = String(req.query.userId || '').trim();
            const limitRaw = Number(req.query.limit || 200);
            const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 200;

            if (!conversationId || !userId) {
                return res.status(400).json({ success: false, error: 'conversationId e userId são obrigatórios.' });
            }

            const membership = await dbGetAsync(
                `SELECT conversation_id FROM internal_conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
                [conversationId, userId]
            );
            if (!membership) {
                return res.status(403).json({ success: false, error: 'Sem acesso a esta conversa.' });
            }

            await touchInternalChatPresence(userId, 'messages').catch(() => null);

            await ensureInternalMessageReactionsSchema();

            const rows = await dbAllAsync(
                `SELECT
                    m.id,
                    m.conversation_id,
                    m.sender_user_id,
                    u.name AS sender_name,
                    u.avatar_url AS sender_avatar,
                    m.body,
                    m.type,
                    m.reply_to_message_id,
                    m.edited_at,
                    m.deleted_at,
                    m.created_at,
                    m.media_path,
                    m.mime_type,
                    m.file_name,
                    m.file_size,
                    (
                        SELECT COUNT(*)
                        FROM internal_conversation_members cm
                        WHERE cm.conversation_id = m.conversation_id
                          AND cm.user_id <> m.sender_user_id
                    ) AS total_recipients,
                    (
                        SELECT COUNT(*)
                        FROM internal_conversation_members cm
                        WHERE cm.conversation_id = m.conversation_id
                          AND cm.user_id <> m.sender_user_id
                          AND cm.last_read_at IS NOT NULL
                          AND datetime(cm.last_read_at) >= datetime(m.created_at)
                    ) AS read_by_count
                 FROM internal_messages m
                 LEFT JOIN users u ON u.id = m.sender_user_id
                 WHERE m.conversation_id = ?
                 ORDER BY m.id DESC
                 LIMIT ?`,
                [conversationId, limit]
            );

            const memberRows = await dbAllAsync(
                `SELECT m.user_id, u.name AS user_name, m.last_read_at
                 FROM internal_conversation_members m
                 LEFT JOIN users u ON u.id = m.user_id
                 WHERE m.conversation_id = ?`,
                [conversationId]
            );

            const parseTimestampMs = (value) => {
                const raw = String(value || '').trim();
                if (!raw) return 0;
                const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
                const parsed = new Date(normalized);
                const ms = parsed.getTime();
                return Number.isFinite(ms) ? ms : 0;
            };

            const membersWithReadAt = (Array.isArray(memberRows) ? memberRows : []).map((row) => ({
                userId: String(row.user_id || '').trim(),
                userName: String(row.user_name || '').trim() || 'Funcionário',
                lastReadAtMs: parseTimestampMs(row.last_read_at),
            }));

            const messageIds = (Array.isArray(rows) ? rows : [])
                .map((row) => Number(row?.id || 0))
                .filter((id) => Number.isFinite(id) && id > 0);
            const reactionsByMessageId = new Map();
            if (messageIds.length > 0) {
                const placeholders = messageIds.map(() => '?').join(', ');
                const reactionRows = await dbAllAsync(
                    `SELECT
                        r.message_id,
                        r.emoji,
                        r.user_id,
                        u.name AS user_name
                     FROM internal_message_reactions r
                     LEFT JOIN users u ON u.id = r.user_id
                     WHERE r.message_id IN (${placeholders})
                     ORDER BY r.id ASC`,
                    messageIds
                );

                (Array.isArray(reactionRows) ? reactionRows : []).forEach((row) => {
                    const messageId = Number(row.message_id || 0);
                    const emoji = String(row.emoji || '').trim();
                    const userId = String(row.user_id || '').trim();
                    const userName = String(row.user_name || '').trim() || 'Funcionário';
                    if (!messageId || !emoji || !userId) return;

                    let byEmoji = reactionsByMessageId.get(messageId);
                    if (!byEmoji) {
                        byEmoji = new Map();
                        reactionsByMessageId.set(messageId, byEmoji);
                    }
                    let aggregate = byEmoji.get(emoji);
                    if (!aggregate) {
                        aggregate = {
                            emoji,
                            count: 0,
                            userIds: [],
                            userNames: [],
                        };
                        byEmoji.set(emoji, aggregate);
                    }
                    if (aggregate.userIds.includes(userId)) return;
                    aggregate.userIds.push(userId);
                    aggregate.userNames.push(userName);
                    aggregate.count += 1;
                });
            }

            const ordered = rows.reverse().map((row) => {
                const message = mapInternalMessageRow(row);
                const createdAtMs = parseTimestampMs(row.created_at);
                const senderUserId = String(row.sender_user_id || '').trim();
                const readByNames = membersWithReadAt
                    .filter((member) => member.userId && member.userId !== senderUserId && member.lastReadAtMs >= createdAtMs)
                    .map((member) => member.userName);

                const messageReactionsMap = reactionsByMessageId.get(Number(row.id || 0));
                const reactions = messageReactionsMap
                    ? Array.from(messageReactionsMap.values()).sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
                    : [];

                return {
                    ...message,
                    readByNames,
                    reactions,
                };
            });

            return res.json({ success: true, data: ordered });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao listar mensagens:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/internal-chat/messages', async (req, res) => {
        try {
            const conversationId = String(req.body?.conversationId || '').trim();
            const userId = String(req.body?.userId || '').trim();
            const body = String(req.body?.body || '').trim();
            const typeRaw = String(req.body?.type || 'text').trim().toLowerCase();
            const type = ['text', 'image', 'document'].includes(typeRaw) ? typeRaw : 'text';
            const replyToMessageId = Number(req.body?.replyToMessageId || 0) || null;
            const mediaPath = req.body?.mediaPath ? String(req.body.mediaPath).trim() : null;
            const mimeType = req.body?.mimeType ? String(req.body.mimeType).trim() : null;
            const fileName = req.body?.fileName ? sanitizeInternalFileName(req.body.fileName) : null;
            const fileSize = Number(req.body?.fileSize || 0) || null;

            if (!conversationId || !userId) {
                return res.status(400).json({ success: false, error: 'conversationId e userId são obrigatórios.' });
            }
            if (!body && !mediaPath) {
                return res.status(400).json({ success: false, error: 'Mensagem vazia.' });
            }

            const membership = await dbGetAsync(
                `SELECT conversation_id FROM internal_conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
                [conversationId, userId]
            );
            if (!membership) {
                return res.status(403).json({ success: false, error: 'Sem acesso a esta conversa.' });
            }

            await touchInternalChatPresence(userId, 'send').catch(() => null);

            const inserted = await dbRunAsync(
                `INSERT INTO internal_messages (
                    conversation_id, sender_user_id, body, type, reply_to_message_id, media_path, mime_type, file_name, file_size, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [conversationId, userId, body || '', type, replyToMessageId, mediaPath, mimeType, fileName, fileSize]
            );

            const messageId = Number(inserted?.lastID || 0);

            await dbRunAsync(
                `UPDATE internal_conversations
                 SET last_message_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [conversationId]
            );

            await dbRunAsync(
                `UPDATE internal_conversation_members
                 SET last_read_at = CURRENT_TIMESTAMP
                 WHERE conversation_id = ? AND user_id = ?`,
                [conversationId, userId]
            );

            const message = await dbGetAsync(
                `SELECT
                    m.id,
                    m.conversation_id,
                    m.sender_user_id,
                    u.name AS sender_name,
                    u.avatar_url AS sender_avatar,
                    m.body,
                    m.type,
                    m.reply_to_message_id,
                    m.edited_at,
                    m.deleted_at,
                    m.created_at,
                    m.media_path,
                    m.mime_type,
                    m.file_name,
                    m.file_size
                 FROM internal_messages m
                 LEFT JOIN users u ON u.id = m.sender_user_id
                 WHERE m.id = ?
                 LIMIT 1`,
                [messageId]
            );

            await writeAuditLog({
                actorUserId: userId,
                entityType: 'internal_message',
                entityId: String(messageId || '').trim() || null,
                action: 'create',
                details: { conversationId, replyToMessageId: replyToMessageId || null, type },
            });

            if (type === 'text' && body) {
                setTimeout(() => {
                    void maybeQueueInternalAssistantReply({
                        conversationId,
                        senderUserId: userId,
                        messageBody: body,
                        triggerMessageId: messageId || null,
                    }).catch((aiError) => {
                        const details = aiError?.message || aiError;
                        console.error('[Internal Chat] Erro na resposta do funcionário IA:', details);
                    });
                }, 0);
            }

            return res.json({
                success: true,
                message: mapInternalMessageRow(message || {
                    id: messageId,
                    conversation_id: conversationId,
                    sender_user_id: userId,
                    sender_name: '',
                    sender_avatar: '',
                    body: body || '',
                    type,
                    reply_to_message_id: replyToMessageId,
                    edited_at: null,
                    deleted_at: null,
                    created_at: new Date().toISOString(),
                    media_path: mediaPath,
                    mime_type: mimeType,
                    file_name: fileName,
                    file_size: fileSize,
                }),
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao enviar mensagem:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/internal-chat/messages/upload', async (req, res) => {
        try {
            const conversationId = String(req.body?.conversationId || '').trim();
            const userId = String(req.body?.userId || '').trim();
            const fileNameRaw = String(req.body?.fileName || '').trim();
            const mimeType = String(req.body?.mimeType || 'application/octet-stream').trim();
            const dataBase64 = String(req.body?.dataBase64 || '').trim();
            const caption = String(req.body?.caption || '').trim();
            const replyToMessageId = Number(req.body?.replyToMessageId || 0) || null;

            if (!conversationId || !userId || !fileNameRaw || !dataBase64) {
                return res.status(400).json({ success: false, error: 'conversationId, userId, fileName e dataBase64 são obrigatórios.' });
            }

            const membership = await dbGetAsync(
                `SELECT conversation_id FROM internal_conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
                [conversationId, userId]
            );
            if (!membership) {
                return res.status(403).json({ success: false, error: 'Sem acesso a esta conversa.' });
            }

            await touchInternalChatPresence(userId, 'upload').catch(() => null);

            const fileBuffer = Buffer.from(dataBase64, 'base64');
            if (!fileBuffer || fileBuffer.length === 0) {
                return res.status(400).json({ success: false, error: 'Conteúdo do ficheiro inválido.' });
            }
            if (fileBuffer.length > MAX_INTERNAL_MEDIA_BYTES) {
                return res.status(413).json({ success: false, error: 'Ficheiro excede o limite de 20MB.' });
            }

            await ensureInternalMediaRoot();
            const safeConversationId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
            const safeFileName = sanitizeInternalFileName(fileNameRaw);
            const folder = path.join(INTERNAL_CHAT_MEDIA_ROOT, safeConversationId);
            await fs.promises.mkdir(folder, { recursive: true });

            const randomPart = Math.random().toString(36).slice(2, 8);
            const storedName = `${Date.now()}_${randomPart}_${safeFileName}`;
            const absolutePath = path.join(folder, storedName);
            await fs.promises.writeFile(absolutePath, fileBuffer);

            const relativePath = path.posix.join(safeConversationId, storedName);
            const type = mimeType.toLowerCase().startsWith('image/') ? 'image' : 'document';

            const inserted = await dbRunAsync(
                `INSERT INTO internal_messages (
                    conversation_id, sender_user_id, body, type, reply_to_message_id, media_path, mime_type, file_name, file_size, created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [conversationId, userId, caption || safeFileName, type, replyToMessageId, relativePath, mimeType, safeFileName, fileBuffer.length]
            );

            const messageId = Number(inserted?.lastID || 0);

            await dbRunAsync(
                `UPDATE internal_conversations
                 SET last_message_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [conversationId]
            );
            await dbRunAsync(
                `UPDATE internal_conversation_members
                 SET last_read_at = CURRENT_TIMESTAMP
                 WHERE conversation_id = ? AND user_id = ?`,
                [conversationId, userId]
            );

            const message = await dbGetAsync(
                `SELECT
                    m.id,
                    m.conversation_id,
                    m.sender_user_id,
                    u.name AS sender_name,
                    u.avatar_url AS sender_avatar,
                    m.body,
                    m.type,
                    m.reply_to_message_id,
                    m.edited_at,
                    m.deleted_at,
                    m.created_at,
                    m.media_path,
                    m.mime_type,
                    m.file_name,
                    m.file_size
                 FROM internal_messages m
                 LEFT JOIN users u ON u.id = m.sender_user_id
                 WHERE m.id = ?
                 LIMIT 1`,
                [messageId]
            );

            await writeAuditLog({
                actorUserId: userId,
                entityType: 'internal_message',
                entityId: String(messageId || '').trim() || null,
                action: 'upload',
                details: { conversationId, fileName: safeFileName, mimeType, bytes: fileBuffer.length },
            });

            return res.json({ success: true, message: mapInternalMessageRow(message) });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro no upload de ficheiro:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/internal-chat/media/:messageId', async (req, res) => {
        try {
            const messageId = Number(req.params.messageId || 0);
            const userId = String(req.query.userId || '').trim();
            const forceDownload = String(req.query.download || '').trim() === '1';

            if (!messageId || !userId) {
                return res.status(400).json({ success: false, error: 'messageId e userId são obrigatórios.' });
            }

            const row = await dbGetAsync(
                `SELECT m.id, m.conversation_id, m.media_path, m.mime_type, m.file_name
                 FROM internal_messages m
                 WHERE m.id = ?
                 LIMIT 1`,
                [messageId]
            );
            if (!row || !row.media_path) {
                return res.status(404).json({ success: false, error: 'Ficheiro não encontrado.' });
            }

            const membership = await dbGetAsync(
                `SELECT conversation_id FROM internal_conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
                [String(row.conversation_id || '').trim(), userId]
            );
            if (!membership) {
                return res.status(403).json({ success: false, error: 'Sem acesso ao ficheiro.' });
            }

            const absolutePath = resolveInternalMediaAbsolutePath(String(row.media_path || '').trim());
            if (!fs.existsSync(absolutePath)) {
                return res.status(404).json({ success: false, error: 'Ficheiro não existe em disco.' });
            }

            const fileName = sanitizeInternalFileName(row.file_name || path.basename(absolutePath));
            const contentType = String(row.mime_type || '').trim() || 'application/octet-stream';
            res.setHeader('Content-Type', contentType);
            const encodedFileName = encodeURIComponent(fileName);
            if (forceDownload) {
                res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFileName}`);
            } else {
                res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedFileName}`);
            }
            return res.sendFile(absolutePath);
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao servir media:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/internal-chat/messages/:id/edit', async (req, res) => {
        try {
            const messageId = Number(req.params.id || 0);
            const userId = String(req.body?.userId || '').trim();
            const body = String(req.body?.body || '').trim();
            if (!messageId || !userId || !body) {
                return res.status(400).json({ success: false, error: 'messageId, userId e body são obrigatórios.' });
            }

            const message = await dbGetAsync(
                `SELECT id, conversation_id, sender_user_id, deleted_at
                 FROM internal_messages
                 WHERE id = ?
                 LIMIT 1`,
                [messageId]
            );
            if (!message) {
                return res.status(404).json({ success: false, error: 'Mensagem não encontrada.' });
            }
            if (String(message.sender_user_id || '').trim() !== userId) {
                return res.status(403).json({ success: false, error: 'Só o autor pode editar a mensagem.' });
            }
            if (message.deleted_at) {
                return res.status(400).json({ success: false, error: 'Mensagem já apagada.' });
            }

            await dbRunAsync(
                `UPDATE internal_messages SET body = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [body, messageId]
            );

            await writeAuditLog({
                actorUserId: userId,
                entityType: 'internal_message',
                entityId: String(messageId),
                action: 'edit',
                details: { conversationId: String(message.conversation_id || '').trim() },
            });

            return res.json({ success: true });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao editar mensagem:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/internal-chat/messages/:id/delete', async (req, res) => {
        try {
            const messageId = Number(req.params.id || 0);
            const userId = String(req.body?.userId || '').trim();
            if (!messageId || !userId) {
                return res.status(400).json({ success: false, error: 'messageId e userId são obrigatórios.' });
            }

            const message = await dbGetAsync(
                `SELECT id, conversation_id, sender_user_id, deleted_at, media_path, file_name
                 FROM internal_messages
                 WHERE id = ?
                 LIMIT 1`,
                [messageId]
            );
            if (!message) {
                return res.status(404).json({ success: false, error: 'Mensagem não encontrada.' });
            }

            const membership = await dbGetAsync(
                `SELECT conversation_id FROM internal_conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
                [String(message.conversation_id || '').trim(), userId]
            );
            if (!membership) {
                return res.status(403).json({ success: false, error: 'Sem acesso a esta conversa.' });
            }

            const conversationId = String(message.conversation_id || '').trim();
            const mediaPath = String(message.media_path || '').trim();
            const hadMedia = !!mediaPath;
            let mediaDeleted = false;

            await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
            try {
                await ensureInternalMessageReactionsSchema();
                await dbRunAsync(
                    `DELETE FROM internal_message_reactions
                     WHERE message_id = ?`,
                    [messageId]
                );
                await dbRunAsync(
                    `DELETE FROM internal_messages
                     WHERE id = ?`,
                    [messageId]
                );
                await dbRunAsync(
                    `UPDATE internal_conversations
                     SET last_message_at = (
                            SELECT MAX(created_at)
                            FROM internal_messages
                            WHERE conversation_id = ?
                         ),
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [conversationId, conversationId]
                );
                await dbRunAsync('COMMIT');
            } catch (transactionError) {
                await dbRunAsync('ROLLBACK').catch(() => null);
                throw transactionError;
            }

            if (hadMedia) {
                try {
                    const absolutePath = resolveInternalMediaAbsolutePath(mediaPath);
                    await fs.promises.unlink(absolutePath);
                    mediaDeleted = true;
                } catch (mediaError) {
                    if (mediaError?.code !== 'ENOENT') {
                        const details = mediaError?.message || mediaError;
                        console.warn('[Internal Chat] Aviso ao remover media de mensagem apagada:', details);
                    }
                }
            }

            await writeAuditLog({
                actorUserId: userId,
                entityType: 'internal_message',
                entityId: String(messageId),
                action: 'delete',
                details: {
                    conversationId,
                    hardDelete: true,
                    hadMedia,
                    mediaDeleted,
                    fileName: String(message.file_name || '').trim() || null,
                },
            });

            return res.json({ success: true, deletedMessageId: messageId, hardDelete: true });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao apagar mensagem:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/internal-chat/messages/:id/reactions', async (req, res) => {
        try {
            const messageId = Number(req.params.id || 0);
            const userId = String(req.body?.userId || '').trim();
            const emoji = String(req.body?.emoji || '').trim();
            if (!messageId || !userId || !emoji) {
                return res.status(400).json({ success: false, error: 'messageId, userId e emoji são obrigatórios.' });
            }
            if (emoji.length > 24) {
                return res.status(400).json({ success: false, error: 'Emoji inválido.' });
            }

            await ensureInternalMessageReactionsSchema();

            const message = await dbGetAsync(
                `SELECT id, conversation_id, deleted_at
                 FROM internal_messages
                 WHERE id = ?
                 LIMIT 1`,
                [messageId]
            );
            if (!message) {
                return res.status(404).json({ success: false, error: 'Mensagem não encontrada.' });
            }
            if (message.deleted_at) {
                return res.status(400).json({ success: false, error: 'Mensagem apagada. Não é possível reagir.' });
            }

            const conversationId = String(message.conversation_id || '').trim();
            const membership = await dbGetAsync(
                `SELECT conversation_id
                 FROM internal_conversation_members
                 WHERE conversation_id = ? AND user_id = ?
                 LIMIT 1`,
                [conversationId, userId]
            );
            if (!membership) {
                return res.status(403).json({ success: false, error: 'Sem acesso a esta conversa.' });
            }

            await touchInternalChatPresence(userId, 'reaction').catch(() => null);

            const existing = await dbGetAsync(
                `SELECT id
                 FROM internal_message_reactions
                 WHERE message_id = ? AND user_id = ? AND emoji = ?
                 LIMIT 1`,
                [messageId, userId, emoji]
            );

            let reacted = false;
            if (existing?.id) {
                await dbRunAsync(`DELETE FROM internal_message_reactions WHERE id = ?`, [Number(existing.id)]);
                reacted = false;
            } else {
                await dbRunAsync(
                    `INSERT INTO internal_message_reactions (message_id, user_id, emoji, created_at)
                     VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
                    [messageId, userId, emoji]
                );
                reacted = true;
            }

            await writeAuditLog({
                actorUserId: userId,
                entityType: 'internal_message',
                entityId: String(messageId),
                action: reacted ? 'reaction_add' : 'reaction_remove',
                details: { conversationId, emoji },
            });

            return res.json({ success: true, reacted, messageId, emoji });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao reagir à mensagem:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/internal-chat/conversations/:id/read', async (req, res) => {
        try {
            const conversationId = String(req.params.id || '').trim();
            const userId = String(req.body?.userId || '').trim();
            if (!conversationId || !userId) {
                return res.status(400).json({ success: false, error: 'conversationId e userId são obrigatórios.' });
            }

            const membership = await dbGetAsync(
                `SELECT conversation_id FROM internal_conversation_members WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
                [conversationId, userId]
            );
            if (!membership) {
                return res.status(403).json({ success: false, error: 'Sem acesso a esta conversa.' });
            }

            await touchInternalChatPresence(userId, 'read').catch(() => null);

            await dbRunAsync(
                `UPDATE internal_conversation_members
                 SET last_read_at = CURRENT_TIMESTAMP
                 WHERE conversation_id = ? AND user_id = ?`,
                [conversationId, userId]
            );

            return res.json({ success: true });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao marcar como lida:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

}

module.exports = { registerInternalChatRoutes };
