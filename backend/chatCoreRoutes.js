const axios = require('axios');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

function registerChatCoreRoutes(app, deps) {
  const {
    db,
    VERIFY_TOKEN,
    ENABLE_WEBHOOK_AUTOREPLY,
    whatsappProvider,
    whatsappCloudToken,
    getWhatsAppHealth,
    getWhatsAppAccountsHealth,
    getWhatsAppQrPayload,
    connectWhatsAppProvider,
    disconnectWhatsAppProvider,
    setConversationWhatsAppAccount,
    API_PUBLIC_BASE_URL,
    writeAuditLog,
    ensureConversationForPhone,
    upsertLocalCustomer,
    nowIso,
    handleInboundAutomationReply,
    normalizePhone,
    dbGetAsync,
    dbRunAsync,
    normalizeLocalTemplate,
    applyTemplateVariables,
    enqueueOutboundMessage,
    processOutboundQueue,
    dbAllAsync,
    listBlockedContacts: listBlockedContactsDep,
    upsertBlockedContact: upsertBlockedContactDep,
    removeBlockedContact: removeBlockedContactDep,
    isBlockedContact: isBlockedContactDep,
    chatEvents,
    emitChatEvent,
    logChatCore,
    sendMobilePushNotification,
    fetchAvatarOnDemand,
    downloadInboundMediaStream,
  } = deps;

  const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');
  const extractOwnDigitsFromMeId = (rawMeId) => {
    const value = String(rawMeId || '').trim();
    if (!value) return '';
    const match = value.match(/(\d{6,})(?::\d+)?@/);
    if (match?.[1]) return normalizePhoneDigits(match[1]);
    const fallback = value.split('@')[0] || '';
    return normalizePhoneDigits(fallback.split(':')[0] || '');
  };
  const normalizeBlockedChannel = () => {
    return 'whatsapp';
  };
  const normalizeBlockedContactKey = (rawValue) => {
    return String(rawValue || '').replace(/\D/g, '');
  };
  const isSameBlockedContactKey = (leftValue, rightValue, rawChannel = 'whatsapp') => {
    const channel = normalizeBlockedChannel(rawChannel);
    const left = normalizeBlockedContactKey(leftValue);
    const right = normalizeBlockedContactKey(rightValue);
    if (!left || !right) return false;
    if (left === right) return true;
    const minComparableLength = 7;
    if (left.length < minComparableLength || right.length < minComparableLength) return false;
    return left.endsWith(right) || right.endsWith(left);
  };

  const toLongString = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
    if (typeof value === 'string') return value.trim();
    if (typeof value.toString === 'function') {
      try {
        return String(value.toString()).trim();
      } catch (_) {
        return '';
      }
    }
    return '';
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));

  let blockedContactsTableReady = false;

  const ensureBlockedContactsTable = async () => {
    if (blockedContactsTableReady) return;
    await dbRunAsync(
      `CREATE TABLE IF NOT EXISTS blocked_contacts (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         channel TEXT NOT NULL,
         contact_key TEXT NOT NULL,
         reason TEXT,
         created_by TEXT,
         is_active INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
         updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`
    );
    await dbRunAsync(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_blocked_contacts_unique
       ON blocked_contacts(channel, contact_key)`
    );
    await dbRunAsync(
      `CREATE INDEX IF NOT EXISTS idx_blocked_contacts_active
       ON blocked_contacts(is_active, channel, contact_key)`
    );
    blockedContactsTableReady = true;
  };

  const listBlockedContactsSafe = async (rawChannel = '') => {
    if (typeof listBlockedContactsDep === 'function') {
      const data = await Promise.resolve(listBlockedContactsDep(rawChannel));
      return Array.isArray(data) ? data : [];
    }

    await ensureBlockedContactsTable();
    const channel = String(rawChannel || '').trim()
      ? normalizeBlockedChannel(rawChannel)
      : '';
    const where = ['is_active = 1'];
    const params = [];
    if (channel) {
      where.push('channel = ?');
      params.push(channel);
    }
    const rows = await dbAllAsync(
      `SELECT id, channel, contact_key, reason, created_by, is_active, created_at, updated_at
       FROM blocked_contacts
       WHERE ${where.join(' AND ')}
       ORDER BY datetime(updated_at) DESC, id DESC`,
      params
    );

    return (Array.isArray(rows) ? rows : []).map((row) => ({
      id: Number(row.id || 0),
      channel: normalizeBlockedChannel(row.channel),
      contactKey: String(row.contact_key || '').trim(),
      reason: String(row.reason || '').trim() || null,
      createdBy: String(row.created_by || '').trim() || null,
      isActive: Number(row.is_active || 0) === 1,
      createdAt: String(row.created_at || '').trim() || null,
      updatedAt: String(row.updated_at || '').trim() || null,
    }));
  };

  const upsertBlockedContactSafe = async ({ channel = 'whatsapp', contactKey = '', reason = '', actorUserId = null } = {}) => {
    if (typeof upsertBlockedContactDep === 'function') {
      return Promise.resolve(
        upsertBlockedContactDep({
          channel,
          contactKey,
          reason,
          actorUserId,
        })
      );
    }

    await ensureBlockedContactsTable();
    const normalizedChannel = normalizeBlockedChannel(channel);
    const normalizedKey = normalizeBlockedContactKey(contactKey);
    if (!normalizedKey) {
      throw new Error('Contacto inválido para bloqueio.');
    }

    await dbRunAsync(
      `INSERT INTO blocked_contacts (channel, contact_key, reason, created_by, is_active, updated_at)
       VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(channel, contact_key) DO UPDATE SET
         reason = excluded.reason,
         created_by = COALESCE(excluded.created_by, blocked_contacts.created_by),
         is_active = 1,
         updated_at = CURRENT_TIMESTAMP`,
      [
        normalizedChannel,
        normalizedKey,
        String(reason || '').trim() || null,
        String(actorUserId || '').trim() || null,
      ]
    );

    const row = await dbGetAsync(
      `SELECT id, channel, contact_key, reason, created_by, is_active, created_at, updated_at
       FROM blocked_contacts
       WHERE channel = ? AND contact_key = ?
       LIMIT 1`,
      [normalizedChannel, normalizedKey]
    );

    if (!row) return null;
    return {
      id: Number(row.id || 0),
      channel: normalizeBlockedChannel(row.channel),
      contactKey: String(row.contact_key || '').trim(),
      reason: String(row.reason || '').trim() || null,
      createdBy: String(row.created_by || '').trim() || null,
      isActive: Number(row.is_active || 0) === 1,
      createdAt: String(row.created_at || '').trim() || null,
      updatedAt: String(row.updated_at || '').trim() || null,
    };
  };

  const removeBlockedContactSafe = async ({ id = null, channel = '', contactKey = '' } = {}) => {
    if (typeof removeBlockedContactDep === 'function') {
      return Promise.resolve(
        removeBlockedContactDep({
          id,
          channel,
          contactKey,
        })
      );
    }

    await ensureBlockedContactsTable();
    const normalizedId = Number(id || 0);
    if (Number.isFinite(normalizedId) && normalizedId > 0) {
      const result = await dbRunAsync(
        `UPDATE blocked_contacts
         SET is_active = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [normalizedId]
      );
      return Number(result?.changes || 0) > 0;
    }

    const normalizedChannel = normalizeBlockedChannel(channel);
    const normalizedKey = normalizeBlockedContactKey(contactKey);
    if (!normalizedKey) return false;
    const matches = await dbAllAsync(
      `SELECT id, contact_key
       FROM blocked_contacts
       WHERE channel = ?
         AND is_active = 1`,
      [normalizedChannel]
    );
    const matchedIds = (Array.isArray(matches) ? matches : [])
      .filter((row) => isSameBlockedContactKey(row?.contact_key, normalizedKey, normalizedChannel))
      .map((row) => Number(row?.id || 0))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (matchedIds.length === 0) return false;

    const placeholders = matchedIds.map(() => '?').join(', ');
    const result = await dbRunAsync(
      `UPDATE blocked_contacts
       SET is_active = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${placeholders})`,
      matchedIds
    );
    return Number(result?.changes || 0) > 0;
  };

  const isBlockedContactSafe = async ({ channel = 'whatsapp', contactKey = '' } = {}) => {
    if (typeof isBlockedContactDep === 'function') {
      return Promise.resolve(
        isBlockedContactDep({
          channel,
          contactKey,
        })
      );
    }

    await ensureBlockedContactsTable();
    const normalizedChannel = normalizeBlockedChannel(channel);
    const normalizedKey = normalizeBlockedContactKey(contactKey);
    if (!normalizedKey) return false;
    const rows = await dbAllAsync(
      `SELECT contact_key
       FROM blocked_contacts
       WHERE channel = ?
         AND is_active = 1`,
      [normalizedChannel]
    );
    return (Array.isArray(rows) ? rows : []).some((row) =>
      isSameBlockedContactKey(row?.contact_key, normalizedKey, normalizedChannel)
    );
  };

  const normalizePhoneForStorage = (rawDigits) => {
    const digits = normalizePhoneDigits(rawDigits);
    if (!digits) return '';
    if (digits.length === 9) return `+351${digits}`;
    return `+${digits}`;
  };

  // Conversas órfãs (sem customer válido) deixam de aparecer na lista de contactos.
  // Auto-reparação: tenta religar por telefone ou cria ficha mínima "wa_c_<digits>".
  const repairOrphanConversationCustomers = async () => {
    const orphanRows = await dbAllAsync(
      `SELECT cv.id, cv.customer_id
       FROM conversations cv
       LEFT JOIN customers cu ON cu.id = cv.customer_id
       WHERE ifnull(cv.customer_id, '') <> ''
         AND cu.id IS NULL
         AND cv.id LIKE 'conv_wa_c_%'`
    );

    for (const row of Array.isArray(orphanRows) ? orphanRows : []) {
      const conversationId = String(row?.id || '').trim();
      const preferredCustomerId = String(row?.customer_id || '').trim();
      const digits = normalizePhoneDigits(conversationId.replace(/^conv_wa_c_/i, ''));
      if (!conversationId || !digits) continue;

      const linkedCustomer = await dbGetAsync(
        `SELECT id
         FROM customers
         WHERE replace(replace(replace(ifnull(phone, ''), '+', ''), ' ', ''), '-', '') = ?
         ORDER BY
           CASE
             WHEN id = ? THEN 0
             WHEN ifnull(source_id, '') <> '' THEN 1
             ELSE 2
           END,
           datetime(updated_at) DESC
         LIMIT 1`,
        [digits, preferredCustomerId]
      );

      let nextCustomerId = String(linkedCustomer?.id || '').trim();
      if (!nextCustomerId) {
        nextCustomerId = preferredCustomerId || `wa_c_${digits}`;
        const fallbackPhone = normalizePhoneForStorage(digits);
        await dbRunAsync(
          `INSERT INTO customers (
             id, source_id, name, company, phone, email, owner_id, type, contacts_json, allow_auto_responses, updated_at
           ) VALUES (?, NULL, ?, 'WhatsApp', ?, NULL, NULL, 'Particular', '[]', 1, CURRENT_TIMESTAMP)
           ON CONFLICT(id) DO UPDATE SET
             name = CASE WHEN ifnull(customers.name, '') = '' THEN excluded.name ELSE customers.name END,
             company = CASE WHEN ifnull(customers.company, '') = '' THEN excluded.company ELSE customers.company END,
             phone = CASE WHEN ifnull(customers.phone, '') = '' THEN excluded.phone ELSE customers.phone END,
             type = CASE WHEN ifnull(customers.type, '') = '' THEN excluded.type ELSE customers.type END,
             contacts_json = CASE WHEN ifnull(customers.contacts_json, '') = '' THEN excluded.contacts_json ELSE customers.contacts_json END,
             updated_at = CURRENT_TIMESTAMP`,
          [nextCustomerId, fallbackPhone || 'Contacto WhatsApp', fallbackPhone || null]
        );
      }

      if (nextCustomerId) {
        await dbRunAsync(
          `UPDATE conversations
           SET customer_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [nextCustomerId, conversationId]
        );
      }
    }
  };

  const EXTENSION_TO_MIME = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv; charset=utf-8',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.opus': 'audio/ogg',
  };

  const MIME_TO_EXTENSION = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'text/plain': '.txt',
    'application/xml': '.xml',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
  };

  const safeJsonParse = (value, fallback = null) => {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'object') return value;
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  };

  const sanitizeDownloadFileName = (value, fallback = 'anexo') => {
    const candidate = String(value || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    return candidate || fallback;
  };

  const guessMimeType = ({ explicitMime = '', fileName = '', mediaKind = '' }) => {
    const normalizedMime = String(explicitMime || '').trim().toLowerCase();
    if (normalizedMime) return normalizedMime;

    const ext = String(path.extname(String(fileName || '')).toLowerCase() || '');
    if (ext && EXTENSION_TO_MIME[ext]) return EXTENSION_TO_MIME[ext];
    if (String(mediaKind || '').toLowerCase() === 'image') return 'image/jpeg';
    if (String(mediaKind || '').toLowerCase() === 'document') return 'application/octet-stream';
    if (String(mediaKind || '').toLowerCase() === 'video') return 'video/mp4';
    if (String(mediaKind || '').toLowerCase() === 'audio') return 'audio/mpeg';
    return 'application/octet-stream';
  };

  const guessExtensionFromMime = (mimeType = '') => {
    const normalized = String(mimeType || '').trim().toLowerCase();
    if (!normalized) return '';
    if (MIME_TO_EXTENSION[normalized]) return MIME_TO_EXTENSION[normalized];
    const base = normalized.split(';')[0].trim();
    if (MIME_TO_EXTENSION[base]) return MIME_TO_EXTENSION[base];
    return '';
  };

  const normalizeMediaKind = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return '';
    if (normalized.includes('image')) return 'image';
    if (normalized.includes('document')) return 'document';
    if (normalized.includes('video')) return 'video';
    if (normalized.includes('audio')) return 'audio';
    if (normalized.includes('sticker')) return 'sticker';
    return normalized;
  };

  const resolveWebhookMediaPayload = (message) => {
    const msgType = String(message?.type || '').trim().toLowerCase();
    if (!msgType) return null;

    const pickPayload = (kind, payload, fallbackName) => {
      if (!payload || typeof payload !== 'object') return null;
      const mimeType = String(payload?.mime_type || '').trim();
      const remoteId = String(payload?.id || '').trim();
      const caption = String(payload?.caption || '').trim();
      const fileNameRaw =
        String(payload?.filename || payload?.file_name || payload?.name || '').trim() || fallbackName;
      const extensionFromMime = guessExtensionFromMime(mimeType);
      const hasExtension = /\.[a-z0-9]{2,8}$/i.test(fileNameRaw);
      const fileName = hasExtension || !extensionFromMime ? fileNameRaw : `${fileNameRaw}${extensionFromMime}`;
      const sizeRaw = Number(payload?.file_size);
      return {
        kind: normalizeMediaKind(kind),
        mimeType: mimeType || guessMimeType({ fileName, mediaKind: kind }),
        fileName,
        size: Number.isFinite(sizeRaw) ? sizeRaw : null,
        remoteId: remoteId || null,
        remoteUrl: null,
        caption,
        meta: payload,
      };
    };

    if (msgType === 'image') return pickPayload('image', message?.image, 'imagem');
    if (msgType === 'document') return pickPayload('document', message?.document, 'documento');
    if (msgType === 'video') return pickPayload('video', message?.video, 'video');
    if (msgType === 'audio') return pickPayload('audio', message?.audio, 'audio');
    if (msgType === 'sticker') return pickPayload('sticker', message?.sticker, 'sticker');
    return null;
  };

  const toMessageMediaRecord = (row) => {
    if (!row || typeof row !== 'object') return null;
    const mediaKind = normalizeMediaKind(row.media_kind);
    const mediaPath = String(row.media_path || '').trim();
    const mediaMimeType = guessMimeType({
      explicitMime: row.media_mime_type,
      fileName: row.media_file_name,
      mediaKind,
    });
    const mediaFileName = sanitizeDownloadFileName(
      String(row.media_file_name || '').trim(),
      mediaKind === 'image' ? 'imagem' : 'anexo'
    );
    const mediaSizeValue = Number(row.media_size);
    return {
      waId: String(row.wa_id || '').trim() || null,
      fromNumber: String(row.from_number || '').trim() || null,
      accountId: String(row.account_id || '').trim() || null,
      mediaKind,
      mediaPath: mediaPath || null,
      mediaMimeType,
      mediaFileName,
      mediaSize: Number.isFinite(mediaSizeValue) ? mediaSizeValue : null,
      mediaProvider: String(row.media_provider || '').trim() || null,
      mediaRemoteId: String(row.media_remote_id || '').trim() || null,
      mediaRemoteUrl: String(row.media_remote_url || '').trim() || null,
      mediaMeta: safeJsonParse(row.media_meta_json, null),
    };
  };

  const toQueueMediaRecord = (row) => {
    if (!row || typeof row !== 'object') return null;
    const messageKind = normalizeMediaKind(row.message_kind);
    if (messageKind !== 'image' && messageKind !== 'document' && messageKind !== 'video' && messageKind !== 'audio') {
      return null;
    }
    const variables = safeJsonParse(row.variables_json, {});
    const key =
      messageKind === 'document'
        ? '__document'
        : messageKind === 'image'
          ? '__image'
          : messageKind === 'video'
            ? '__video'
            : '__audio';
    const payload = variables && typeof variables === 'object' ? variables[key] : null;
    if (!payload || typeof payload !== 'object') return null;

    const mediaPath = String(payload.path || '').trim();
    const mediaFileName = sanitizeDownloadFileName(
      String(payload.fileName || '').trim(),
      messageKind === 'image' ? 'imagem' : 'anexo'
    );
    return {
      mediaKind: messageKind,
      mediaPath: mediaPath || null,
      mediaMimeType: guessMimeType({
        explicitMime: payload.mimeType,
        fileName: mediaFileName,
        mediaKind: messageKind,
      }),
      mediaFileName,
      mediaSize: null,
      mediaProvider: String(whatsappProvider || '').trim() || null,
      mediaRemoteId: null,
      mediaRemoteUrl: null,
      mediaMeta: null,
    };
  };

  const loadConversationContextById = async (rawConversationId) => {
    const conversationId = String(rawConversationId || '').trim();
    if (!conversationId) return null;

    const row = await dbGetAsync(
      `SELECT cv.id as conversation_id,
              cv.customer_id as conversation_customer_id,
              cv.whatsapp_account_id as conversation_whatsapp_account_id,
              cv.owner_id as conversation_owner_id,
              cv.status as conversation_status,
              cv.last_message_at as conversation_last_message_at,
              cv.unread_count as conversation_unread_count,
              cu.id as customer_id,
              cu.name as customer_name,
              cu.company as customer_company,
              cu.phone as customer_phone
       FROM conversations cv
       LEFT JOIN customers cu ON cu.id = cv.customer_id
       WHERE cv.id = ?
       LIMIT 1`,
      [conversationId]
    );
    if (!row) return null;

    const conversation = {
      id: String(row.conversation_id || '').trim(),
      customerId: String(row.conversation_customer_id || '').trim(),
      whatsappAccountId: String(row.conversation_whatsapp_account_id || '').trim() || null,
      ownerId: String(row.conversation_owner_id || '').trim() || null,
      status: String(row.conversation_status || 'open').trim() || 'open',
      lastMessageAt: String(row.conversation_last_message_at || nowIso()).trim() || nowIso(),
      unreadCount: Number(row.conversation_unread_count || 0),
    };
    const customer = row.customer_id
      ? {
          id: String(row.customer_id || '').trim(),
          name: String(row.customer_name || '').trim(),
          company: String(row.customer_company || '').trim(),
          phone: String(row.customer_phone || '').trim(),
        }
      : null;

    return { conversation, customer };
  };

  const streamClients = new Set();
  const sendSse = (res, event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (error) {
      streamClients.delete(res);
    }
  };
  const broadcastSse = (event) => {
    streamClients.forEach((client) => sendSse(client, event));
  };
  if (chatEvents && typeof chatEvents.on === 'function') {
    chatEvents.on('chat_event', broadcastSse);
  }
  setInterval(() => {
    broadcastSse({ type: 'heartbeat', timestamp: nowIso() });
  }, 25000);

  app.get('/api/chat/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    streamClients.add(res);
    sendSse(res, { type: 'connected', timestamp: nowIso() });

    req.on('close', () => {
      streamClients.delete(res);
      res.end();
    });
  });

  // Rota de Verificação do Webhook (Exigido pela Meta)

  app.get(['/api/whatsapp/health', '/api/chat/whatsapp/health'], async (req, res) => {
    const accountId = String(req.query.accountId || req.query.account_id || '').trim();
    try {
      const fallback = {
        provider: String(whatsappProvider || 'cloud'),
        configured: true,
        status: 'unknown',
      };
      const payload =
        typeof getWhatsAppHealth === 'function'
          ? await Promise.resolve(getWhatsAppHealth({ accountId }))
          : fallback;
      return res.json({
        success: true,
        ...payload,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: String(error?.message || error),
      });
    }
  });

  app.get(['/api/whatsapp/qr', '/api/chat/whatsapp/qr'], async (req, res) => {
    const accountId = String(req.query.accountId || req.query.account_id || '').trim();
    try {
      if (typeof getWhatsAppQrPayload !== 'function') {
        return res.status(404).json({
          success: false,
          error: 'QR do WhatsApp não disponível neste provider.',
        });
      }
      const payload = await Promise.resolve(getWhatsAppQrPayload({ accountId }));
      return res.json({
        success: true,
        ...payload,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: String(error?.message || error),
      });
    }
  });

  app.get(['/api/whatsapp/qr/image', '/api/chat/whatsapp/qr/image'], async (req, res) => {
    const accountId = String(req.query.accountId || req.query.account_id || '').trim();
    try {
      if (typeof getWhatsAppQrPayload !== 'function') {
        return res.status(404).json({
          success: false,
          error: 'QR do WhatsApp não disponível neste provider.',
        });
      }
      const payload = await Promise.resolve(getWhatsAppQrPayload({ accountId }));
      const qrText = String(payload?.qrText || '').trim();
      if (!qrText) {
        return res.status(404).json({
          success: false,
          error: 'QR ainda não disponível. Liga primeiro o provider.',
        });
      }

      const imageRaw = await QRCode.toBuffer(qrText, {
        type: 'png',
        width: 360,
        margin: 1,
      });
      let imageBuffer = null;
      if (Buffer.isBuffer(imageRaw)) {
        imageBuffer = imageRaw;
      } else if (imageRaw instanceof Uint8Array) {
        imageBuffer = Buffer.from(imageRaw);
      } else if (typeof imageRaw === 'string') {
        imageBuffer = Buffer.from(imageRaw, 'binary');
      } else {
        throw new Error('Não foi possível gerar o QR em formato binário.');
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(imageBuffer.length));
      return res.end(imageBuffer);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: String(error?.message || error),
      });
    }
  });

  app.post(['/api/whatsapp/connect', '/api/chat/whatsapp/connect'], async (req, res) => {
    try {
      if (typeof connectWhatsAppProvider !== 'function') {
        return res.status(404).json({
          success: false,
          error: 'Ligação WhatsApp não disponível neste provider.',
        });
      }
      const body = req.body || {};
      const accountId = String(body.accountId || body.account_id || req.query.accountId || req.query.account_id || '').trim();
      const state = await Promise.resolve(connectWhatsAppProvider({ accountId }));
      return res.json({
        success: true,
        state,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: String(error?.message || error),
      });
    }
  });

  app.post(['/api/whatsapp/disconnect', '/api/chat/whatsapp/disconnect'], async (req, res) => {
    try {
      if (typeof disconnectWhatsAppProvider !== 'function') {
        return res.status(404).json({
          success: false,
          error: 'Desligar WhatsApp não disponível neste provider.',
        });
      }
      const body = req.body || {};
      const accountId = String(body.accountId || body.account_id || req.query.accountId || req.query.account_id || '').trim();
      const state = await Promise.resolve(
        disconnectWhatsAppProvider({
          accountId,
          logout: body.logout === true || String(body.logout || '').trim().toLowerCase() === 'true',
          clearAuth: body.clearAuth === true || String(body.clearAuth || '').trim().toLowerCase() === 'true',
        })
      );
      return res.json({
        success: true,
        state,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: String(error?.message || error),
      });
    }
  });

  app.get(['/api/whatsapp/accounts', '/api/chat/whatsapp/accounts'], async (_req, res) => {
    try {
      if (typeof getWhatsAppAccountsHealth === 'function') {
        const accounts = await Promise.resolve(getWhatsAppAccountsHealth());
        return res.json({
          success: true,
          provider: String(whatsappProvider || 'cloud'),
          data: Array.isArray(accounts) ? accounts : [],
        });
      }
      const fallback =
        typeof getWhatsAppHealth === 'function'
          ? await Promise.resolve(getWhatsAppHealth())
          : { provider: String(whatsappProvider || 'cloud'), configured: true };
      return res.json({
        success: true,
        provider: String(whatsappProvider || 'cloud'),
        data: [fallback],
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: String(error?.message || error),
      });
    }
  });

  app.post(['/api/chat/conversations/:id/whatsapp-account', '/api/conversations/:id/whatsapp-account'], async (req, res) => {
    const conversationId = String(req.params?.id || '').trim();
    const body = req.body || {};
    const accountId = String(body.accountId || body.account_id || '').trim();
    if (!conversationId) {
      return res.status(400).json({ success: false, error: 'Conversa inválida.' });
    }
    if (typeof setConversationWhatsAppAccount !== 'function') {
      return res.status(404).json({ success: false, error: 'Gestão de conta WhatsApp indisponível.' });
    }
    try {
      const conversation = await Promise.resolve(setConversationWhatsAppAccount(conversationId, accountId));
      if (!conversation) {
        return res.status(404).json({ success: false, error: 'Conversa não encontrada.' });
      }
      return res.json({ success: true, conversation });
    } catch (error) {
      return res.status(500).json({ success: false, error: String(error?.message || error) });
    }
  });


  // Rota para Listar Contatos (Sidebar)
  app.get(['/api/contacts', '/api/chat/contacts'], async (_req, res) => {
    const sql = `WITH ranked_contacts AS (
        SELECT
          cu.phone as from_number,
          cu.contact_name as customer_contact_name,
          cu.name as customer_name,
          cu.company as customer_company,
          cv.last_message_at as last_msg_time,
          cv.id as conversation_id,
          cv.customer_id as customer_id,
          cv.whatsapp_account_id as whatsapp_account_id,
          cv.owner_id as owner_id,
          cv.status as status,
          cv.unread_count as unread_count,
          replace(replace(replace(ifnull(cu.phone, ''), '+', ''), ' ', ''), '-', '') as phone_digits,
          (
            SELECT substr(trim(ifnull(m_in.body, '')), 1, 220)
            FROM messages m_in
            WHERE replace(replace(replace(ifnull(m_in.from_number, ''), '+', ''), ' ', ''), '-', '') =
                  replace(replace(replace(ifnull(cu.phone, ''), '+', ''), ' ', ''), '-', '')
              AND lower(ifnull(m_in.direction, 'inbound')) IN ('inbound', 'in')
            ORDER BY datetime(m_in.timestamp) DESC, m_in.id DESC
            LIMIT 1
          ) as last_inbound_preview,
          (
            SELECT substr(trim(ifnull(m_any.body, '')), 1, 220)
            FROM messages m_any
            WHERE replace(replace(replace(ifnull(m_any.from_number, ''), '+', ''), ' ', ''), '-', '') =
                  replace(replace(replace(ifnull(cu.phone, ''), '+', ''), ' ', ''), '-', '')
            ORDER BY datetime(m_any.timestamp) DESC, m_any.id DESC
            LIMIT 1
          ) as last_msg_preview,
          'whatsapp' as channel,
          CASE
            WHEN cv.id LIKE 'conv_wa_c_%' THEN 30
            WHEN cv.id LIKE 'conv_wa_%' THEN 20
            WHEN cv.id LIKE 'wa_conv_%' THEN 1
            ELSE 10
          END as source_rank,
          ROW_NUMBER() OVER (
            PARTITION BY replace(replace(replace(ifnull(cu.phone, ''), '+', ''), ' ', ''), '-', '')
            ORDER BY
              CASE
                WHEN cv.id LIKE 'conv_wa_c_%' THEN 30
                WHEN cv.id LIKE 'conv_wa_%' THEN 20
                WHEN cv.id LIKE 'wa_conv_%' THEN 1
                ELSE 10
              END DESC,
              cv.unread_count DESC,
              datetime(cv.last_message_at) DESC
          ) as row_num
        FROM conversations cv
        JOIN customers cu ON cu.id = cv.customer_id
        WHERE replace(replace(replace(ifnull(cu.phone, ''), '+', ''), ' ', ''), '-', '') <> ''
          AND EXISTS (
            SELECT 1
            FROM messages m
            WHERE replace(replace(replace(ifnull(m.from_number, ''), '+', ''), ' ', ''), '-', '') =
                  replace(replace(replace(ifnull(cu.phone, ''), '+', ''), ' ', ''), '-', '')
          )
      )
      SELECT
        rc.from_number,
        rc.customer_contact_name,
        rc.customer_name,
        rc.customer_company,
        rc.last_msg_time,
        rc.last_msg_preview,
        rc.last_inbound_preview,
        rc.conversation_id,
        rc.customer_id,
        rc.whatsapp_account_id,
        rc.owner_id,
        rc.status,
        rc.unread_count,
        rc.channel,
        COALESCE(bc.is_active, 0) as is_blocked,
        bc.id as blocked_id,
        bc.reason as blocked_reason,
        bc.updated_at as blocked_at
      FROM ranked_contacts rc
      LEFT JOIN blocked_contacts bc
        ON bc.is_active = 1
       AND bc.channel = 'whatsapp'
       AND (
            bc.contact_key = rc.phone_digits
            OR (
              length(bc.contact_key) >= 7
              AND length(rc.phone_digits) >= 7
              AND (
                bc.contact_key LIKE ('%' || rc.phone_digits)
                OR rc.phone_digits LIKE ('%' || bc.contact_key)
              )
            )
          )
      WHERE rc.row_num = 1
      ORDER BY datetime(rc.last_msg_time) DESC`;

    try {
      await ensureBlockedContactsTable();
      await repairOrphanConversationCustomers();
      const rows = await dbAllAsync(sql, []);
      let ownWhatsAppDigits = new Set();
      try {
        if (typeof getWhatsAppAccountsHealth === 'function') {
          const health = await Promise.resolve(getWhatsAppAccountsHealth());
          const accounts = Array.isArray(health) ? health : [];
          ownWhatsAppDigits = new Set(
            accounts
              .map((item) => extractOwnDigitsFromMeId(item?.meId))
              .filter((value) => value.length >= 7)
          );
        }
      } catch (_) {
        ownWhatsAppDigits = new Set();
      }

      const filteredRows = (Array.isArray(rows) ? rows : []).filter((row) => {
        const digits = normalizePhoneDigits(String(row?.from_number || ''));
        if (!digits) return true;
        if (!ownWhatsAppDigits.has(digits)) return true;
        return false;
      });

      return res.json({ data: filteredRows });
    } catch (error) {
      return res.status(400).json({ error: error?.message || error });
    }
  });

  app.get(['/api/contacts/blocked', '/api/chat/contacts/blocked'], async (req, res) => {
    try {
      const rawChannel = String(req.query.channel || '').trim();
      const rows = await listBlockedContactsSafe(rawChannel);
      return res.json({
        success: true,
        total: rows.length,
        data: rows,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: String(error?.message || error),
      });
    }
  });

  app.post(['/api/contacts/block', '/api/chat/contacts/block'], async (req, res) => {
    const body = req.body || {};
    const channel = normalizeBlockedChannel(body.channel || body.provider || 'whatsapp');
    const contactKey = normalizeBlockedContactKey(body.contactKey || body.phone || body.chatId || body.to);
    const reason = String(body.reason || '').trim();
    const actorUserId = String(body.actorUserId || body.createdBy || '').trim() || null;

    if (!contactKey) {
      return res.status(400).json({
        success: false,
        error: 'contactKey (ou phone/chatId) é obrigatório para bloquear.',
      });
    }

    try {
      const row = await upsertBlockedContactSafe({
        channel,
        contactKey,
        reason,
        actorUserId,
      });

      emitChatEvent?.('contact_blocked', {
        channel,
        contactKey,
        reason: reason || null,
      });
      logChatCore?.('contact_blocked', {
        channel,
        contactKey,
      });

      return res.json({
        success: true,
        data: row,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: String(error?.message || error),
      });
    }
  });

  app.post(['/api/contacts/unblock', '/api/chat/contacts/unblock'], async (req, res) => {
    const body = req.body || {};
    const id = Number(body.id || 0);
    const channel = normalizeBlockedChannel(body.channel || body.provider || 'whatsapp');
    const contactKey = normalizeBlockedContactKey(body.contactKey || body.phone || body.chatId || body.to);
    if (!(id > 0) && !contactKey) {
      return res.status(400).json({
        success: false,
        error: 'Envia id ou contactKey para desbloquear.',
      });
    }

    try {
      const removed = await removeBlockedContactSafe({
        id: id > 0 ? id : null,
        channel,
        contactKey,
      });

      emitChatEvent?.('contact_unblocked', {
        id: id > 0 ? id : null,
        channel,
        contactKey: contactKey || null,
      });
      logChatCore?.('contact_unblocked', {
        id: id > 0 ? id : null,
        channel,
        contactKey: contactKey || null,
      });

      return res.json({
        success: true,
        removed: removed === true,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: String(error?.message || error),
      });
    }
  });


  // Atualizar nome de contacto de um cliente
  app.patch(['/api/customers/:id/contact-name', '/api/chat/customers/:id/contact-name'], async (req, res) => {
    const customerId = String(req.params.id || '').trim();
    if (!customerId) {
      return res.status(400).json({ success: false, error: 'ID do cliente é obrigatório.' });
    }
    const body = req.body || {};
    const contactName = String(body.contactName ?? body.contact_name ?? '').trim();

    try {
      const existing = await dbGetAsync('SELECT id, name, company, contact_name FROM customers WHERE id = ? LIMIT 1', [customerId]);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
      }
      await dbRunAsync('UPDATE customers SET contact_name = ?, updated_at = ? WHERE id = ?', [contactName, nowIso(), customerId]);
      logChatCore?.('customer_contact_name_updated', { customerId, contactName });
      return res.json({ success: true, contactName });
    } catch (error) {
      return res.status(500).json({ success: false, error: String(error?.message || error) });
    }
  });

  // Servir avatar/foto de perfil do WhatsApp
  app.get(['/api/customers/:id/avatar', '/api/chat/customers/:id/avatar'], async (req, res) => {
    const customerId = String(req.params.id || '').trim();
    if (!customerId) return res.status(400).end();
    try {
      const customer = await dbGetAsync('SELECT phone FROM customers WHERE id = ? LIMIT 1', [customerId]);
      if (!customer?.phone) return res.status(404).end();
      const digits = String(customer.phone).replace(/\D/g, '');
      const avatarPath = require('path').join(process.cwd(), 'chat_media', 'avatars', `${digits}.jpg`);
      const fs = require('fs');
      try {
        await fs.promises.access(avatarPath, fs.constants.R_OK);
        res.set('Cache-Control', 'public, max-age=86400');
        res.set('Content-Type', 'image/jpeg');
        return fs.createReadStream(avatarPath).pipe(res);
      } catch (_) {
        return res.status(404).end();
      }
    } catch (error) {
      return res.status(500).end();
    }
  });

  // Servir avatar por número de telefone (para sidebar)
  app.get('/api/avatars/:phone', async (req, res) => {
    const digits = String(req.params.phone || '').replace(/\D/g, '');
    if (!digits || digits.length < 7) return res.status(400).end();
    const avatarPath = require('path').join(process.cwd(), 'chat_media', 'avatars', `${digits}.jpg`);
    const fs = require('fs');
    try {
      // Try local file first
      if (fs.existsSync(avatarPath)) {
        const stat = fs.statSync(avatarPath);
        if (stat.size > 0) {
          res.set('Cache-Control', 'public, max-age=86400');
          res.set('Content-Type', 'image/jpeg');
          return fs.createReadStream(avatarPath).pipe(res);
        }
      }
      // If not found locally, try to fetch on-demand from WhatsApp
      if (typeof fetchAvatarOnDemand === 'function') {
        const fetched = await fetchAvatarOnDemand(digits);
        if (fetched && fs.existsSync(fetched)) {
          res.set('Cache-Control', 'public, max-age=86400');
          res.set('Content-Type', 'image/jpeg');
          return fs.createReadStream(fetched).pipe(res);
        }
      }
    } catch (_) { /* ignore */ }
    return res.status(404).end();
  });

  // Rota para Listar Mensagens (Chat Específico)
  app.get(['/api/messages', '/api/chat/messages'], async (req, res) => {
    const phone = req.query.phone;
    const accountId = String(req.query.accountId || req.query.account_id || '').trim();
    let sql = 'SELECT * FROM messages';
    const params = [];
    const where = [];

    const phoneDigits = String(phone || '').replace(/\D/g, '');
    if (phoneDigits) {
      // Fast path: from_number já é guardado só com dígitos
      where.push(`ifnull(from_number, '') = ?`);
      params.push(phoneDigits);
    }
    if (accountId) {
      where.push(`account_id = ?`);
      params.push(accountId);
    }
    if (where.length > 0) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }

    sql += ' ORDER BY id DESC LIMIT 50';

    try {
      let rows = await dbAllAsync(sql, params);
      // Fallback lento para dados antigos com +/espaços no from_number
      if (phoneDigits && (!rows || rows.length === 0)) {
        let slowSql = 'SELECT * FROM messages WHERE replace(replace(replace(ifnull(from_number, \'\'), \'+\', \'\'), \' \', \'\'), \'-\', \'\') = ?';
        const slowParams = [phoneDigits];
        if (accountId) {
          slowSql += ' AND ifnull(account_id, \'\') = ?';
          slowParams.push(accountId);
        }
        slowSql += ' ORDER BY id DESC LIMIT 50';
        rows = await dbAllAsync(slowSql, slowParams);
      }
      res.json({ data: (Array.isArray(rows) ? rows : []).reverse() });
    } catch (error) {
      res.status(400).json({ error: error?.message || error });
    }
  });

  const buildConversationCandidateIds = (rawId) => {
    const normalizedId = String(rawId || '').trim();
    if (!normalizedId) return [];
    const candidates = [normalizedId];
    if (normalizedId.startsWith('wa_conv_')) {
      candidates.push(`conv_${normalizedId.slice('wa_conv_'.length)}`);
    } else if (normalizedId.startsWith('conv_wa_c_')) {
      candidates.push(`wa_conv_${normalizedId.slice('conv_'.length)}`);
    }
    return Array.from(new Set(candidates.filter(Boolean)));
  };

  const extractPhoneDigitsFromConversationId = (rawConversationId) => {
    const match = String(rawConversationId || '').match(/(?:wa_conv_|conv_wa_c_)(\d{6,})/i);
    return String(match?.[1] || '').trim();
  };

  app.post(['/api/chat/conversations/:id/read', '/api/conversations/:id/read'], async (req, res) => {
    const rawId = String(req.params?.id || '').trim();
    if (!rawId) {
      return res.status(400).json({ success: false, error: 'Conversa inválida.' });
    }

    const candidateIds = buildConversationCandidateIds(rawId);

    try {
      let updated = false;
      for (const candidate of candidateIds) {
        // eslint-disable-next-line no-await-in-loop
        const result = await dbRunAsync(
          `UPDATE conversations
           SET unread_count = 0, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [candidate]
        );
        if (Number(result?.changes || 0) > 0) {
          updated = true;
          // Limpa também todas as fichas com o mesmo número para evitar badge preso.
          // eslint-disable-next-line no-await-in-loop
          const row = await dbGetAsync(
            `SELECT cu.phone as phone
             FROM conversations cv
             JOIN customers cu ON cu.id = cv.customer_id
             WHERE cv.id = ?
             LIMIT 1`,
            [candidate]
          );
          const digits = String(row?.phone || '').replace(/\D/g, '');
          if (digits) {
            // eslint-disable-next-line no-await-in-loop
            await dbRunAsync(
              `UPDATE conversations
               SET unread_count = 0, updated_at = CURRENT_TIMESTAMP
               WHERE customer_id IN (
                 SELECT id
                 FROM customers
                 WHERE replace(replace(replace(ifnull(phone, ''), '+', ''), ' ', ''), '-', '') = ?
               )`,
              [digits]
            );
          }
          break;
        }
      }

      emitChatEvent?.('conversation_read', { conversationId: rawId });
      return res.json({ success: true, updated });
    } catch (error) {
      const details = error?.message || error;
      return res.status(500).json({ success: false, error: details });
    }
  });

  const deleteConversationHandler = async (req, res) => {
    const rawId = String(req.params?.id || '').trim();
    if (!rawId) {
      return res.status(400).json({ success: false, error: 'Conversa inválida.' });
    }

    const body = req.body || {};
    const actorUserId = String(body.actorUserId || body.createdBy || '').trim() || null;
    const deleteMessages = body.deleteMessages !== false;
    const candidateIds = buildConversationCandidateIds(rawId);
    if (candidateIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Conversa inválida.' });
    }

    try {
      let targetRow = null;
      for (const candidate of candidateIds) {
        // eslint-disable-next-line no-await-in-loop
        const row = await dbGetAsync(
          `SELECT cv.id,
                  cv.customer_id,
                  cv.owner_id,
                  cv.status,
                  cv.whatsapp_account_id,
                  cu.phone as customer_phone
             FROM conversations cv
             LEFT JOIN customers cu ON cu.id = cv.customer_id
            WHERE cv.id = ?
            LIMIT 1`,
          [candidate]
        );
        if (row) {
          targetRow = row;
          break;
        }
      }

      if (!targetRow) {
        return res.status(404).json({ success: false, error: 'Conversa não encontrada.' });
      }

      const targetConversationId = String(targetRow.id || rawId).trim() || rawId;
      if (!candidateIds.includes(targetConversationId)) {
        candidateIds.push(targetConversationId);
      }
      const placeholders = candidateIds.map(() => '?').join(', ');
      const phoneDigits =
        normalizePhoneDigits(String(targetRow.customer_phone || '')) ||
        extractPhoneDigitsFromConversationId(targetConversationId);

      const tasksResult = await dbRunAsync(
        `DELETE FROM tasks
         WHERE conversation_id IN (${placeholders})`,
        candidateIds
      );
      const queueResult = await dbRunAsync(
        `DELETE FROM outbound_queue
         WHERE conversation_id IN (${placeholders})
            OR (? <> '' AND replace(replace(replace(ifnull(to_number, ''), '+', ''), ' ', ''), '-', '') = ?)`,
        [...candidateIds, phoneDigits, phoneDigits]
      );
      const deadLetterResult = await dbRunAsync(
        `DELETE FROM outbound_dead_letter
         WHERE conversation_id IN (${placeholders})
            OR (? <> '' AND replace(replace(replace(ifnull(to_number, ''), '+', ''), ' ', ''), '-', '') = ?)`,
        [...candidateIds, phoneDigits, phoneDigits]
      );
      const conversationResult = await dbRunAsync(
        `DELETE FROM conversations
         WHERE id IN (${placeholders})`,
        candidateIds
      );

      let deletedMessages = 0;
      if (deleteMessages && phoneDigits) {
        const messageResult = await dbRunAsync(
          `DELETE FROM messages
           WHERE replace(replace(replace(ifnull(from_number, ''), '+', ''), ' ', ''), '-', '') = ?`,
          [phoneDigits]
        );
        deletedMessages = Number(messageResult?.changes || 0);
      }

      const deletedConversations = Number(conversationResult?.changes || 0);
      if (deletedConversations <= 0) {
        return res.status(404).json({ success: false, error: 'Conversa não encontrada.' });
      }

      await writeAuditLog({
        actorUserId,
        entityType: 'conversation',
        entityId: targetConversationId,
        action: 'delete',
        details: {
          candidateIds,
          phoneDigits: phoneDigits || null,
          deleteMessages,
          deletedConversations,
          deletedMessages,
          deletedTasks: Number(tasksResult?.changes || 0),
          deletedQueue: Number(queueResult?.changes || 0),
          deletedDeadLetter: Number(deadLetterResult?.changes || 0),
        },
      });

      emitChatEvent?.('conversation_deleted', {
        conversationId: targetConversationId,
        candidateIds,
        phoneDigits: phoneDigits || null,
        deletedMessages,
      });
      logChatCore?.('conversation_deleted', {
        conversationId: targetConversationId,
        candidateIds,
        phoneDigits: phoneDigits || null,
        deletedConversations,
        deletedMessages,
      });

      return res.json({
        success: true,
        deleted: true,
        deletedConversationId: targetConversationId,
        deletedConversations,
        deletedMessages,
      });
    } catch (error) {
      const details = error?.message || error;
      return res.status(500).json({ success: false, error: details });
    }
  };

  app.post(['/api/chat/conversations/:id/delete', '/api/conversations/:id/delete'], deleteConversationHandler);
  app.delete(['/api/chat/conversations/:id', '/api/chat/conversations/:id/delete', '/api/conversations/:id/delete'], deleteConversationHandler);

  // Rota para Enviar Mensagens (Frontend chama esta rota)
  app.post(['/api/send', '/api/chat/send'], async (req, res) => {
    const {
      to,
      message,
      type,
      templateId,
      variables,
      createdBy,
      mediaPath,
      mediaMimeType,
      mediaFileName,
      conversationId,
      accountId,
    } = req.body || {};
    if (!to) {
      return res.status(400).json({ success: false, error: "Numero de destino ('to') obrigatorio" });
    }

    const rawTo = String(to || '').trim();
    const formattedTo = rawTo.replace(/\D/g, '');
    if (!formattedTo) {
      return res.status(400).json({ success: false, error: 'Numero de destino invalido.' });
    }

    try {
      const requestedConversationId = String(conversationId || '').trim();
      const contextFromConversationId = requestedConversationId
        ? await loadConversationContextById(requestedConversationId)
        : null;

      let customer = contextFromConversationId?.customer || null;
      let conversation = contextFromConversationId?.conversation || null;

      if (!conversation || !customer) {
        const resolvedPhone = normalizePhone(formattedTo);
        const ensured = await ensureConversationForPhone(resolvedPhone, {
          unreadCount: 0,
          status: 'open',
          lastMessageAt: nowIso(),
        });
        customer = ensured?.customer || customer;
        conversation = ensured?.conversation || conversation;
      }

      const requestedAccountId = String(accountId || req.body?.account_id || '').trim();
      if (requestedAccountId && conversation?.id && typeof setConversationWhatsAppAccount === 'function') {
        const updatedConversation = await Promise.resolve(setConversationWhatsAppAccount(conversation.id, requestedAccountId));
        if (updatedConversation) {
          conversation = updatedConversation;
        }
      }
      const outboundAccountId = String(conversation?.whatsappAccountId || requestedAccountId || '').trim() || null;

      if (
        await isBlockedContactSafe({
          channel: 'whatsapp',
          contactKey: formattedTo,
        })
      ) {
        return res.status(403).json({
          success: false,
          error: 'Contacto bloqueado no WhatsApp.',
        });
      }

      const selectedType = String(type || 'text').trim().toLowerCase();
      let messageKind = 'text';
      let messageBody = String(message || '').trim();
      let templateName = '';
      const prefersMetaTemplates = false; // Baileys only - no Meta templates

      const templateVariables = variables && typeof variables === 'object' ? variables : {};
      const autoVariables = {
        nome: customer?.name || '',
        empresa: customer?.company || '',
        telefone: customer?.phone || '',
        ...templateVariables,
      };

      if (selectedType === 'template') {
        if (templateId) {
          const tplRow = await dbGetAsync(
            `SELECT id, name, kind, content, meta_template_name, is_active
             FROM message_templates
             WHERE id = ?
             LIMIT 1`,
            [String(templateId).trim()]
          );
          const template = normalizeLocalTemplate(tplRow);
          if (!template || !template.isActive) {
            return res.status(404).json({ success: false, error: 'Template nao encontrado ou inativo.' });
          }

          if (template.metaTemplateName && prefersMetaTemplates) {
            messageKind = 'meta_template';
            templateName = template.metaTemplateName;
            messageBody = applyTemplateVariables(template.content, autoVariables);
          } else {
            messageKind = 'text';
            messageBody = applyTemplateVariables(template.content, autoVariables);
          }
        } else {
          if (prefersMetaTemplates) {
            messageKind = 'meta_template';
            templateName = 'hello_world';
            messageBody = messageBody || 'Template: hello_world';
          } else {
            messageKind = 'text';
            messageBody = messageBody || 'Mensagem enviada a partir de template local.';
          }
        }
      } else if (!messageBody) {
        if (selectedType !== 'image' && selectedType !== 'document') {
          return res.status(400).json({ success: false, error: "Mensagem ('message') obrigatoria" });
        }
      }

      if (selectedType === 'image') {
        const localPath = String(mediaPath || '').trim();
        if (!localPath) {
          return res.status(400).json({ success: false, error: "Imagem invalida. Campo 'mediaPath' obrigatorio." });
        }
        messageKind = 'image';
        messageBody = String(messageBody || '').trim();
      } else if (selectedType === 'document') {
        const localPath = String(mediaPath || '').trim();
        if (!localPath) {
          return res.status(400).json({ success: false, error: "Documento invalido. Campo 'mediaPath' obrigatorio." });
        }
        messageKind = 'document';
        messageBody = String(messageBody || '').trim();
      }

      const outboundVariables =
        selectedType === 'image'
          ? {
              ...autoVariables,
              __image: {
                path: String(mediaPath || '').trim(),
                mimeType: String(mediaMimeType || '').trim() || null,
                fileName: String(mediaFileName || '').trim() || null,
              },
            }
          : selectedType === 'document'
            ? {
                ...autoVariables,
                __document: {
                  path: String(mediaPath || '').trim(),
                  mimeType: String(mediaMimeType || '').trim() || null,
                  fileName: String(mediaFileName || '').trim() || null,
                },
              }
          : autoVariables;

      const queueId = await enqueueOutboundMessage({
        conversationId: conversation?.id || null,
        accountId: outboundAccountId,
        toNumber: formattedTo,
        messageKind,
        messageBody,
        templateName,
        variables: outboundVariables,
        createdBy: String(createdBy || '').trim() || null,
      });

      await writeAuditLog({
        actorUserId: String(createdBy || '').trim() || null,
        entityType: 'outbound_queue',
        entityId: String(queueId),
        action: 'queued',
        details: {
          to: formattedTo,
          messageKind,
          templateName: templateName || null,
          conversationId: conversation?.id || null,
          accountId: outboundAccountId,
        },
      });
      emitChatEvent?.('outbound_queued', {
        queueId,
        conversationId: conversation?.id || null,
        accountId: outboundAccountId,
        to: formattedTo,
        messageKind,
      });
      logChatCore?.('queue_enqueued', {
        queueId,
        conversationId: conversation?.id || null,
        accountId: outboundAccountId,
        to: formattedTo,
        messageKind,
      });

      void processOutboundQueue(3);
      return res.json({
        success: true,
        queued: true,
        queueId,
        messageId: `q_${queueId}`,
        conversationId: conversation?.id || null,
      });
    } catch (error) {
      const errorData = error?.response?.data || error?.message || error;
      console.error('Erro ao enfileirar envio:', errorData);
      logChatCore?.('queue_enqueue_error', {
        to: formattedTo,
        error: typeof errorData === 'string' ? errorData : JSON.stringify(errorData),
      });
      return res.status(500).json({ success: false, error: errorData });
    }
  });

  const resolveMessageTarget = (rawId) => {
    const token = String(rawId || '').trim();
    if (!token) return null;

    if (token.startsWith('q_')) {
      const queueId = Number(token.slice(2));
      if (Number.isFinite(queueId) && queueId > 0) {
        return { kind: 'queue', queueId };
      }
      return null;
    }

    if (token.startsWith('db_')) {
      const dbId = Number(token.slice(3));
      if (Number.isFinite(dbId) && dbId > 0) {
        return { kind: 'db', dbId };
      }
      return null;
    }

    return { kind: 'wa', waId: token };
  };

  app.get('/api/chat/messages/:messageId/media', async (req, res) => {
    const target = resolveMessageTarget(req.params.messageId);
    const shouldDownload = ['1', 'true', 'yes'].includes(String(req.query.download || '').trim().toLowerCase());
    if (!target) {
      return res.status(400).json({ success: false, error: 'Mensagem inválida.' });
    }

    try {
      let media = null;

      if (target.kind === 'queue') {
        const queueRow = await dbGetAsync(
          `SELECT id, message_kind, variables_json
           FROM outbound_queue
           WHERE id = ?
           LIMIT 1`,
          [target.queueId]
        );
        media = toQueueMediaRecord(queueRow);
      } else if (target.kind === 'db') {
        const messageRow = await dbGetAsync(
          `SELECT
             id, wa_id, from_number, account_id,
             media_kind, media_path, media_mime_type, media_file_name, media_size,
             media_provider, media_remote_id, media_remote_url, media_meta_json
           FROM messages
           WHERE id = ?
           LIMIT 1`,
          [target.dbId]
        );
        media = toMessageMediaRecord(messageRow);
      } else {
        const messageRow = await dbGetAsync(
          `SELECT
             id, wa_id, from_number, account_id,
             media_kind, media_path, media_mime_type, media_file_name, media_size,
             media_provider, media_remote_id, media_remote_url, media_meta_json
           FROM messages
           WHERE wa_id = ?
           ORDER BY id DESC
           LIMIT 1`,
          [target.waId]
        );
        media = toMessageMediaRecord(messageRow);
      }

      if (!media || (!media.mediaPath && !media.mediaRemoteId && !media.mediaRemoteUrl)) {
        return res.status(404).json({ success: false, error: 'Esta mensagem não tem anexo disponível para pré-visualização.' });
      }

      const fallbackName =
        media.mediaKind === 'image'
          ? 'imagem'
          : media.mediaKind === 'document'
            ? 'documento'
            : 'anexo';
      const fileName = sanitizeDownloadFileName(media.mediaFileName, fallbackName);
      const dispositionType = shouldDownload ? 'attachment' : 'inline';
      const mimeType = guessMimeType({
        explicitMime: media.mediaMimeType,
        fileName,
        mediaKind: media.mediaKind,
      });

      res.setHeader('Cache-Control', 'private, max-age=60');
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `${dispositionType}; filename="${fileName.replace(/"/g, '')}"`);

      if (media.mediaPath) {
        const absolutePath = path.resolve(String(media.mediaPath || '').trim());
        try {
          const stat = await fs.promises.stat(absolutePath);
          if (!stat.isFile()) {
            throw new Error('Ficheiro inválido.');
          }
          res.setHeader('Content-Length', String(stat.size));
          fs.createReadStream(absolutePath)
            .on('error', (streamError) => {
              if (!res.headersSent) {
                res.status(500).json({ success: false, error: streamError?.message || streamError });
              } else {
                res.end();
              }
            })
            .pipe(res);
          return;
        } catch (_) {
          // fallback para media remoto, se existir
        }
      }

      if (
        media.mediaProvider === 'baileys' &&
        typeof downloadInboundMediaStream === 'function' &&
        media.mediaMeta &&
        media.fromNumber
      ) {
        try {
          const inboundStream = await downloadInboundMediaStream({
            accountId: media.accountId || '',
            waId: media.waId || '',
            fromNumber: media.fromNumber,
            mediaKind: media.mediaKind,
            mediaMeta: media.mediaMeta,
          });
          inboundStream
            .on('error', (streamError) => {
              if (!res.headersSent) {
                res.status(502).json({ success: false, error: streamError?.message || streamError });
              } else {
                res.end();
              }
            })
            .pipe(res);
          return;
        } catch (_) {
          // fallback para media remoto, se existir
        }
      }

      let remoteUrl = String(media.mediaRemoteUrl || '').trim();
      if (!remoteUrl && media.mediaRemoteId) {
        if (!whatsappCloudToken) {
          return res.status(503).json({
            success: false,
            error: 'Anexo remoto disponível, mas WHATSAPP_TOKEN não está configurado para obter pré-visualização.',
          });
        }
        const lookup = await axios({
          method: 'GET',
          url: `https://graph.facebook.com/v17.0/${encodeURIComponent(String(media.mediaRemoteId || '').trim())}`,
          headers: {
            Authorization: `Bearer ${whatsappCloudToken}`,
          },
          timeout: 15000,
        });
        remoteUrl = String(lookup?.data?.url || '').trim();
      }

      if (!remoteUrl) {
        return res.status(404).json({ success: false, error: 'Não foi possível localizar o anexo desta mensagem.' });
      }

      const remoteResponse = await axios({
        method: 'GET',
        url: remoteUrl,
        responseType: 'stream',
        headers: whatsappCloudToken
          ? {
              Authorization: `Bearer ${whatsappCloudToken}`,
            }
          : undefined,
        timeout: 45000,
      });

      const upstreamContentType = String(remoteResponse?.headers?.['content-type'] || '').trim();
      const upstreamLength = String(remoteResponse?.headers?.['content-length'] || '').trim();
      if (upstreamContentType) {
        res.setHeader('Content-Type', upstreamContentType);
      }
      if (upstreamLength) {
        res.setHeader('Content-Length', upstreamLength);
      }

      remoteResponse.data
        .on('error', (streamError) => {
          if (!res.headersSent) {
            res.status(502).json({ success: false, error: streamError?.message || streamError });
          } else {
            res.end();
          }
        })
        .pipe(res);
    } catch (error) {
      const details = error?.response?.data || error?.message || error;
      return res.status(500).json({ success: false, error: details });
    }
  });

  app.post('/api/chat/messages/:messageId/edit', async (req, res) => {
    const target = resolveMessageTarget(req.params.messageId);
    const nextBody = String(req.body?.body || '').trim();
    const actorUserId = String(req.body?.actorUserId || '').trim() || null;

    if (!target) {
      return res.status(400).json({ success: false, error: 'Mensagem inválida.' });
    }
    if (!nextBody) {
      return res.status(400).json({ success: false, error: 'Texto da mensagem vazio.' });
    }

    try {
      if (target.kind === 'queue') {
        const queueRow = await dbGetAsync(
          `SELECT id, status
           FROM outbound_queue
           WHERE id = ?
           LIMIT 1`,
          [target.queueId]
        );
        if (!queueRow) {
          return res.status(404).json({ success: false, error: 'Mensagem em fila não encontrada.' });
        }
        const status = String(queueRow.status || '').trim();
        if (!['queued', 'retry', 'processing'].includes(status)) {
          return res.status(409).json({ success: false, error: 'Mensagem já enviada. Não pode ser editada na fila.' });
        }
        await dbRunAsync(
          `UPDATE outbound_queue
           SET message_body = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [nextBody, target.queueId]
        );
        await writeAuditLog({
          actorUserId,
          entityType: 'outbound_queue',
          entityId: String(target.queueId),
          action: 'edit',
          details: { body: nextBody.slice(0, 500) },
        });
        emitChatEvent?.('message_edited', { queueId: target.queueId, body: nextBody.slice(0, 500) });
        return res.json({ success: true, edited: true, queueId: target.queueId });
      }

      const row =
        target.kind === 'db'
          ? await dbGetAsync(
              `SELECT id, wa_id, direction
               FROM messages
               WHERE id = ?
               LIMIT 1`,
              [target.dbId]
            )
          : await dbGetAsync(
              `SELECT id, wa_id, direction
               FROM messages
               WHERE wa_id = ?
               LIMIT 1`,
              [target.waId]
            );

      if (!row) {
        return res.status(404).json({ success: false, error: 'Mensagem não encontrada.' });
      }

      if (String(row.direction || '').trim() !== 'outbound') {
        return res.status(403).json({ success: false, error: 'Só é possível editar mensagens enviadas pela equipa.' });
      }

      await dbRunAsync(
        `UPDATE messages
         SET body = ?
         WHERE id = ?`,
        [nextBody, Number(row.id)]
      );

      await writeAuditLog({
        actorUserId,
        entityType: 'message',
        entityId: String(row.wa_id || `db_${row.id}`),
        action: 'edit',
        details: { body: nextBody.slice(0, 500) },
      });
      emitChatEvent?.('message_edited', {
        messageId: String(row.wa_id || `db_${row.id}`),
        dbId: Number(row.id),
        body: nextBody.slice(0, 500),
      });

      return res.json({ success: true, edited: true, messageId: String(row.wa_id || `db_${row.id}`) });
    } catch (error) {
      const details = error?.message || error;
      return res.status(500).json({ success: false, error: details });
    }
  });

  app.delete('/api/chat/messages/:messageId', async (req, res) => {
    const target = resolveMessageTarget(req.params.messageId);
    const actorUserId = String(req.body?.actorUserId || '').trim() || null;
    if (!target) {
      return res.status(400).json({ success: false, error: 'Mensagem inválida.' });
    }

    try {
      if (target.kind === 'queue') {
        const queueRow = await dbGetAsync(
          `SELECT id, status
           FROM outbound_queue
           WHERE id = ?
           LIMIT 1`,
          [target.queueId]
        );
        if (!queueRow) {
          return res.status(404).json({ success: false, error: 'Mensagem em fila não encontrada.' });
        }
        const status = String(queueRow.status || '').trim();
        if (!['queued', 'retry', 'processing'].includes(status)) {
          return res.status(409).json({ success: false, error: 'Mensagem já enviada. Só pode ser apagada localmente.' });
        }
        await dbRunAsync(
          `UPDATE outbound_queue
           SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [target.queueId]
        );
        await writeAuditLog({
          actorUserId,
          entityType: 'outbound_queue',
          entityId: String(target.queueId),
          action: 'cancelled',
          details: { reason: 'delete_from_ui' },
        });
        emitChatEvent?.('message_deleted', { queueId: target.queueId });
        return res.json({ success: true, deleted: true, queueId: target.queueId });
      }

      const row =
        target.kind === 'db'
          ? await dbGetAsync(
              `SELECT id, wa_id
               FROM messages
               WHERE id = ?
               LIMIT 1`,
              [target.dbId]
            )
          : await dbGetAsync(
              `SELECT id, wa_id
               FROM messages
               WHERE wa_id = ?
               LIMIT 1`,
              [target.waId]
            );

      if (!row) {
        return res.status(404).json({ success: false, error: 'Mensagem não encontrada.' });
      }

      await dbRunAsync(
        `UPDATE messages
         SET body = ?
         WHERE id = ?`,
        ['[Mensagem apagada]', Number(row.id)]
      );

      await writeAuditLog({
        actorUserId,
        entityType: 'message',
        entityId: String(row.wa_id || `db_${row.id}`),
        action: 'delete',
        details: { body: '[Mensagem apagada]' },
      });
      emitChatEvent?.('message_deleted', {
        messageId: String(row.wa_id || `db_${row.id}`),
        dbId: Number(row.id),
      });
      return res.json({ success: true, deleted: true, messageId: String(row.wa_id || `db_${row.id}`) });
    } catch (error) {
      const details = error?.message || error;
      return res.status(500).json({ success: false, error: details });
    }
  });

  app.get('/api/chat/health', async (req, res) => {
    try {
      const whatsappState =
        typeof getWhatsAppHealth === 'function'
          ? await Promise.resolve(getWhatsAppHealth())
          : {
              provider: String(whatsappProvider || 'cloud'),
              status: 'unknown',
            };
      const [queueRow, convRow] = await Promise.all([
        dbAllAsync(
          `SELECT
              SUM(CASE WHEN status IN ('queued','retry','processing') THEN 1 ELSE 0 END) as pending
           FROM outbound_queue`
        ).then((rows) => rows?.[0] || {}),
        dbAllAsync('SELECT COUNT(*) as total FROM conversations').then((rows) => rows?.[0] || {}),
      ]);
      let deadLetterTotal = 0;
      try {
        const deadLetterRows = await dbAllAsync(`SELECT COUNT(*) as total FROM outbound_dead_letter`);
        deadLetterTotal = Number(deadLetterRows?.[0]?.total || 0);
      } catch (error) {
        if (!String(error?.message || error).includes('no such table')) {
          throw error;
        }
      }
      return res.json({
        success: true,
        chatCore: {
          status: 'ok',
          whatsapp: whatsappState,
          conversations: Number(convRow.total || 0),
          queuePending: Number(queueRow.pending || 0),
          deadLetter: deadLetterTotal,
          streamClients: streamClients.size,
          webhookAutoReplyEnabled: ENABLE_WEBHOOK_AUTOREPLY,
        },
      });
    } catch (error) {
      const details = error?.message || error;
      return res.status(500).json({
        success: false,
        chatCore: { status: 'error' },
        error: details,
      });
    }
  });
}

module.exports = {
  registerChatCoreRoutes,
};
