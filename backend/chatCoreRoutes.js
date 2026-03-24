const axios = require('axios');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');

function registerChatCoreRoutes(app, deps) {
  const {
    db,
    VERIFY_TOKEN,
    ENABLE_WEBHOOK_AUTOREPLY,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET,
    TELEGRAM_WEBHOOK_PATH,
    TELEGRAM_USER_API_ID,
    TELEGRAM_USER_API_HASH,
    TELEGRAM_USER_SESSION,
    TELEGRAM_USER_CHECK_INTERVAL_MS,
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
  } = deps;

  const normalizePath = (rawPath, fallback = '/webhook/telegram') => {
    const raw = String(rawPath || '').trim();
    if (!raw) return fallback;
    return raw.startsWith('/') ? raw : `/${raw}`;
  };

  const telegramWebhookPath = normalizePath(TELEGRAM_WEBHOOK_PATH, '/webhook/telegram');
  const telegramWebhookRoutes = Array.from(new Set(['/webhook/telegram', telegramWebhookPath]));
  const isCloudWhatsAppProvider = String(whatsappProvider || 'cloud').trim().toLowerCase() === 'cloud';
  const normalizeTelegramChatId = (value) => String(value ?? '').trim();
  const normalizeTelegramLookupPhone = (chatId) => String(chatId || '').replace(/\D/g, '');
  const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '');
  const extractOwnDigitsFromMeId = (rawMeId) => {
    const value = String(rawMeId || '').trim();
    if (!value) return '';
    const match = value.match(/(\d{6,})(?::\d+)?@/);
    if (match?.[1]) return normalizePhoneDigits(match[1]);
    const fallback = value.split('@')[0] || '';
    return normalizePhoneDigits(fallback.split(':')[0] || '');
  };
  const normalizeBlockedChannel = (rawValue) => {
    const value = String(rawValue || '').trim().toLowerCase();
    if (value.includes('telegram')) return 'telegram';
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
    const minComparableLength = channel === 'telegram' ? 6 : 7;
    if (left.length < minComparableLength || right.length < minComparableLength) return false;
    return left.endsWith(right) || right.endsWith(left);
  };
  const hasTelegramBot = () => Boolean(String(TELEGRAM_BOT_TOKEN || '').trim());
  const telegramUserApiId = Number(TELEGRAM_USER_API_ID || 0);
  const telegramUserApiHash = String(TELEGRAM_USER_API_HASH || '').trim();
  const telegramUserConfigured = Number.isFinite(telegramUserApiId) && telegramUserApiId > 0 && Boolean(telegramUserApiHash);
  const TELEGRAM_USER_SESSION_SYNC_KEY = 'telegram_user_session';
  const TELEGRAM_USER_CONTACTS_BATCH_LIMIT = 500;
  const TELEGRAM_USER_CHECK_DELAY_MS = Math.max(5000, Number(TELEGRAM_USER_CHECK_INTERVAL_MS || 5000));

  let telegramUserSessionCache = String(TELEGRAM_USER_SESSION || '').trim();
  let telegramUserSessionLoaded = false;
  let telegramContactStatusTableReady = false;
  let blockedContactsTableReady = false;
  let telegramPendingAuth = null;
  let telegramUserListenerClient = null;
  let telegramUserListenerActive = false;
  let telegramUserListenerStarting = false;
  let telegramUserListenerTimer = null;

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

  const describeTelegramUserError = (error) => {
    const rawMessage =
      String(error?.errorMessage || error?.message || error?.description || '').trim() || 'Erro desconhecido';

    if (rawMessage.startsWith('FLOOD_WAIT_')) {
      const waitSeconds = Number(rawMessage.replace(/\D+/g, '')) || 0;
      return waitSeconds > 0
        ? `Telegram limitou pedidos temporariamente. Aguarda ${waitSeconds}s e tenta novamente.`
        : 'Telegram limitou pedidos temporariamente. Aguarda um pouco e tenta novamente.';
    }
    if (rawMessage === 'PHONE_NUMBER_INVALID') return 'Número inválido no Telegram.';
    if (rawMessage === 'PHONE_NUMBER_BANNED') return 'Este número está bloqueado no Telegram.';
    if (rawMessage === 'PHONE_CODE_INVALID') return 'Código Telegram inválido.';
    if (rawMessage === 'PHONE_CODE_EXPIRED') return 'Código Telegram expirado. Pede um novo código.';
    if (rawMessage === 'SESSION_PASSWORD_NEEDED') return 'Esta conta exige palavra-passe 2FA.';
    if (rawMessage === 'PASSWORD_HASH_INVALID') return 'Palavra-passe 2FA inválida.';
    if (rawMessage === 'AUTH_KEY_UNREGISTERED') return 'Sessão Telegram inválida ou expirada.';
    if (rawMessage === 'API_ID_INVALID') return 'API ID/API Hash do Telegram inválidos.';
    if (rawMessage === 'PHONE_NUMBER_APP_SIGNUP_FORBIDDEN') return 'A tua API Telegram não permite login para este número.';

    return rawMessage;
  };

  const ensureTelegramContactStatusTable = async () => {
    if (telegramContactStatusTableReady) return;
    await dbRunAsync(
      `CREATE TABLE IF NOT EXISTS telegram_contact_status (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         customer_id TEXT,
         phone_e164 TEXT NOT NULL,
         phone_digits TEXT NOT NULL,
         has_telegram INTEGER NOT NULL DEFAULT 0,
         telegram_user_id TEXT,
         telegram_username TEXT,
         telegram_first_name TEXT,
         telegram_last_name TEXT,
         telegram_phone TEXT,
         source TEXT NOT NULL DEFAULT 'user_api',
         checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         raw_json TEXT
       )`
    );
    await dbRunAsync(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_contact_status_phone_digits
       ON telegram_contact_status(phone_digits)`
    );
    await dbRunAsync(
      `CREATE INDEX IF NOT EXISTS idx_telegram_contact_status_customer_id
       ON telegram_contact_status(customer_id)`
    );
    await dbRunAsync(
      `CREATE INDEX IF NOT EXISTS idx_telegram_contact_status_checked_at
       ON telegram_contact_status(checked_at DESC)`
    );
    telegramContactStatusTableReady = true;
  };

  const normalizeTelegramUserPhone = (value) => normalizePhone(String(value || '').trim());

  const resolveTelegramUserDisplayName = (user) => {
    if (!user || typeof user !== 'object') return '';
    const first = String(user.firstName || user.first_name || '').trim();
    const last = String(user.lastName || user.last_name || '').trim();
    const full = [first, last].filter(Boolean).join(' ').trim();
    if (full) return full;
    const username = String(user.username || '').trim();
    if (username) return `@${username}`;
    const phone = String(user.phone || '').trim();
    if (phone) return `+${phone.replace(/\D/g, '')}`;
    return '';
  };

  const normalizeTelegramUserRecord = (user, fallbackUserId = '') => {
    const userId = toLongString(user?.id || user?.userId || fallbackUserId);
    const username = String(user?.username || '').trim();
    const firstName = String(user?.firstName || user?.first_name || '').trim();
    const lastName = String(user?.lastName || user?.last_name || '').trim();
    const phoneRaw = String(user?.phone || '').trim();
    const phone = phoneRaw ? `+${phoneRaw.replace(/\D/g, '')}` : '';
    return {
      userId,
      username: username || '',
      firstName: firstName || '',
      lastName: lastName || '',
      phone: phone || '',
      displayName: resolveTelegramUserDisplayName(user),
    };
  };

  const loadTelegramUserSessionFromSyncState = async () => {
    if (telegramUserSessionLoaded) return;
    telegramUserSessionLoaded = true;

    try {
      const row = await dbGetAsync(
        `SELECT value
         FROM sync_state
         WHERE key = ?
         LIMIT 1`,
        [TELEGRAM_USER_SESSION_SYNC_KEY]
      );
      const persistedValue = String(row?.value || '').trim();
      if (!telegramUserSessionCache && persistedValue) {
        telegramUserSessionCache = persistedValue;
      }
    } catch (error) {
      const raw = String(error?.message || error || '').toLowerCase();
      if (!raw.includes('no such table')) {
        logChatCore?.('telegram_user_session_read_error', { error: String(error?.message || error) });
      }
    }
  };

  const saveTelegramUserSessionToSyncState = async (sessionValue) => {
    const normalizedValue = String(sessionValue || '').trim();
    telegramUserSessionCache = normalizedValue;
    telegramUserSessionLoaded = true;

    try {
      await dbRunAsync(
        `INSERT INTO sync_state (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = CURRENT_TIMESTAMP`,
        [TELEGRAM_USER_SESSION_SYNC_KEY, normalizedValue]
      );
    } catch (error) {
      const raw = String(error?.message || error || '').toLowerCase();
      if (raw.includes('no such table')) {
        await dbRunAsync(
          `CREATE TABLE IF NOT EXISTS sync_state (
             key TEXT PRIMARY KEY,
             value TEXT,
             updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
           )`
        );
        await dbRunAsync(
          `INSERT INTO sync_state (key, value, updated_at)
           VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = CURRENT_TIMESTAMP`,
          [TELEGRAM_USER_SESSION_SYNC_KEY, normalizedValue]
        );
      } else {
        throw error;
      }
    }
  };

  const clearTelegramUserSession = async () => {
    telegramUserSessionCache = '';
    telegramUserSessionLoaded = true;
    telegramPendingAuth = null;

    try {
      await dbRunAsync(
        `DELETE FROM sync_state
         WHERE key = ?`,
        [TELEGRAM_USER_SESSION_SYNC_KEY]
      );
    } catch (_) {
      // sem bloqueio
    }
  };

  const createTelegramUserClient = async (sessionOverride = '') => {
    if (!telegramUserConfigured) {
      throw new Error('Telegram User API não configurada (TELEGRAM_USER_API_ID / TELEGRAM_USER_API_HASH).');
    }

    await loadTelegramUserSessionFromSyncState();
    const sessionValue = String(sessionOverride || telegramUserSessionCache || '').trim();
    const client = new TelegramClient(new StringSession(sessionValue), telegramUserApiId, telegramUserApiHash, {
      connectionRetries: 5,
      useWSS: true,
    });
    await client.connect();
    return client;
  };

  const disconnectTelegramUserClient = async (client) => {
    if (!client) return;
    try {
      await client.disconnect();
    } catch (_) {
      // sem bloqueio
    }
  };

  const resolveTelegramUserAuthState = async () => {
    await loadTelegramUserSessionFromSyncState();

    const base = {
      configured: telegramUserConfigured,
      hasSession: Boolean(telegramUserSessionCache),
      authorized: false,
      checkIntervalMs: TELEGRAM_USER_CHECK_DELAY_MS,
      listenerActive: telegramUserListenerActive,
      pendingAuth: telegramPendingAuth
        ? {
            phoneNumber: telegramPendingAuth.phoneNumber,
            requiresPassword: telegramPendingAuth.requiresPassword === true,
            createdAt: telegramPendingAuth.createdAt,
          }
        : null,
      account: null,
    };

    if (!telegramUserConfigured || !telegramUserSessionCache) {
      return base;
    }

    let client;
    let shouldDisconnect = false;
    try {
      if (telegramUserListenerActive && telegramUserListenerClient?.connected) {
        client = telegramUserListenerClient;
      } else {
        client = await createTelegramUserClient();
        shouldDisconnect = true;
      }
      const authorized = await client.checkAuthorization();
      if (!authorized) return base;

      const me = await client.getMe();
      const normalized = normalizeTelegramUserRecord(me);
      const displayName = normalized.displayName || normalized.username || normalized.userId || 'Telegram';
      const savedSession = String(client.session.save() || '').trim();
      if (savedSession) {
        await saveTelegramUserSessionToSyncState(savedSession);
      }

      return {
        ...base,
        hasSession: Boolean(savedSession || telegramUserSessionCache),
        authorized: true,
        account: {
          userId: normalized.userId || null,
          username: normalized.username || null,
          firstName: normalized.firstName || null,
          lastName: normalized.lastName || null,
          phone: normalized.phone || null,
          displayName,
        },
      };
    } catch (error) {
      const message = describeTelegramUserError(error);
      logChatCore?.('telegram_user_auth_state_error', { error: message });
      return {
        ...base,
        authError: message,
      };
    } finally {
      if (shouldDisconnect) {
        await disconnectTelegramUserClient(client);
      }
    }
  };

  const prepareTelegramContactItems = (rawItems = []) => {
    const seenDigits = new Set();
    const prepared = [];

    (Array.isArray(rawItems) ? rawItems : []).forEach((item, index) => {
      const phoneRaw =
        typeof item === 'string'
          ? item
          : item?.phone || item?.phoneNumber || item?.rawPhone || item?.from_number || '';
      const phoneE164 = normalizeTelegramUserPhone(phoneRaw);
      const phoneDigits = normalizePhoneDigits(phoneE164);
      if (!phoneDigits) return;
      if (seenDigits.has(phoneDigits)) return;
      seenDigits.add(phoneDigits);

      const customerId = typeof item === 'string' ? '' : String(item?.customerId || '').trim();
      const firstNameRaw =
        typeof item === 'string'
          ? `Cliente ${index + 1}`
          : String(item?.firstName || item?.name || item?.label || `Cliente ${index + 1}`).trim();
      const firstName = firstNameRaw || 'Cliente';
      const lastName = typeof item === 'string' ? '' : String(item?.lastName || '').trim();

      prepared.push({
        customerId,
        phoneE164,
        phoneDigits,
        firstName,
        lastName,
      });
    });

    return prepared.slice(0, TELEGRAM_USER_CONTACTS_BATCH_LIMIT);
  };

  const upsertTelegramContactStatus = async (row) => {
    await ensureTelegramContactStatusTable();

    await dbRunAsync(
      `INSERT INTO telegram_contact_status (
         customer_id,
         phone_e164,
         phone_digits,
         has_telegram,
         telegram_user_id,
         telegram_username,
         telegram_first_name,
         telegram_last_name,
         telegram_phone,
         source,
         raw_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_api', ?)
       ON CONFLICT(phone_digits) DO UPDATE SET
         customer_id = CASE
           WHEN excluded.customer_id <> '' THEN excluded.customer_id
           ELSE telegram_contact_status.customer_id
         END,
         phone_e164 = excluded.phone_e164,
         has_telegram = excluded.has_telegram,
         telegram_user_id = excluded.telegram_user_id,
         telegram_username = excluded.telegram_username,
         telegram_first_name = excluded.telegram_first_name,
         telegram_last_name = excluded.telegram_last_name,
         telegram_phone = excluded.telegram_phone,
         source = 'user_api',
         checked_at = CURRENT_TIMESTAMP,
         raw_json = excluded.raw_json`,
      [
        String(row.customerId || '').trim(),
        String(row.phoneE164 || '').trim(),
        String(row.phoneDigits || '').trim(),
        row.hasTelegram ? 1 : 0,
        String(row.telegramUserId || '').trim() || null,
        String(row.telegramUsername || '').trim() || null,
        String(row.telegramFirstName || '').trim() || null,
        String(row.telegramLastName || '').trim() || null,
        String(row.telegramPhone || '').trim() || null,
        JSON.stringify(row.raw || null),
      ]
    );
  };

  const verifyTelegramContactsByPhone = async (rawItems, options = {}) => {
    if (!telegramUserConfigured) {
      throw new Error('Telegram User API não configurada (TELEGRAM_USER_API_ID / TELEGRAM_USER_API_HASH).');
    }

    const preparedItems = prepareTelegramContactItems(rawItems);
    if (!preparedItems.length) {
      return {
        success: true,
        total: 0,
        telegramCount: 0,
        results: [],
      };
    }

    const providedClient = options?.providedClient || null;
    const persist = options?.persist !== false;
    const enforceHumanDelay = options?.enforceHumanDelay !== false;
    const delayMs = enforceHumanDelay ? TELEGRAM_USER_CHECK_DELAY_MS : Math.max(0, Number(options?.delayMs || 0));

    let client = providedClient || (telegramUserListenerActive ? telegramUserListenerClient : null);
    const shouldDisconnect = !providedClient && client !== telegramUserListenerClient;
    try {
      if (!client) {
        client = await createTelegramUserClient();
      }

      const authorized = await client.checkAuthorization();
      if (!authorized) {
        throw new Error('A conta Telegram ainda não está autenticada. Liga primeiro a conta no botão Telegram.');
      }

      const responseRows = [];
      for (let index = 0; index < preparedItems.length; index += 1) {
        const item = preparedItems[index];
        const clientId = (BigInt(Date.now()) * 1000n + BigInt(index + 1)).toString();
        item.clientId = clientId;

        // Verificação "humana": 1 número por pedido, com pausa fixa entre pedidos.
        // Isto reduz risco de flood/abuso ao consultar presença no Telegram.
        // eslint-disable-next-line no-await-in-loop
        const result = await client.invoke(
          new Api.contacts.ImportContacts({
            contacts: [
              new Api.InputPhoneContact({
                clientId: BigInt(clientId),
                phone: item.phoneE164,
                firstName: item.firstName,
                lastName: item.lastName,
              }),
            ],
          })
        );

        const importedRows = Array.isArray(result?.imported) ? result.imported : [];
        let userId = '';
        importedRows.forEach((importedItem) => {
          const importedClientId = toLongString(importedItem?.clientId);
          if (importedClientId !== clientId) return;
          userId = toLongString(importedItem?.userId);
        });

        const users = Array.isArray(result?.users) ? result.users : [];
        let user = null;
        if (userId) {
          user =
            users.find((candidate) => toLongString(candidate?.id || candidate?.userId) === userId) || null;
        }
        const normalizedUser = normalizeTelegramUserRecord(user, userId);
        const hasTelegram = Boolean(userId);
        const row = {
          customerId: item.customerId || null,
          phoneE164: item.phoneE164,
          phoneDigits: item.phoneDigits,
          hasTelegram,
          telegramUserId: normalizedUser.userId || null,
          telegramUsername: normalizedUser.username || null,
          telegramFirstName: normalizedUser.firstName || null,
          telegramLastName: normalizedUser.lastName || null,
          telegramPhone: normalizedUser.phone || null,
          displayName: normalizedUser.displayName || null,
          checkedAt: nowIso(),
          raw: {
            hasTelegram,
            userId: normalizedUser.userId || null,
            username: normalizedUser.username || null,
            phone: normalizedUser.phone || null,
          },
        };

        if (persist) {
          // eslint-disable-next-line no-await-in-loop
          await upsertTelegramContactStatus(row);
        }

        responseRows.push(row);

        if (delayMs > 0 && index < preparedItems.length - 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(delayMs);
        }
      }

      return {
        success: true,
        total: preparedItems.length,
        telegramCount: responseRows.filter((item) => item.hasTelegram).length,
        rateLimit: {
          mode: enforceHumanDelay ? 'human' : 'custom',
          delayMs,
        },
        results: responseRows,
      };
    } finally {
      if (shouldDisconnect) {
        await disconnectTelegramUserClient(client);
      }
    }
  };

  const hasTelegramVerifiedForNumber = async (rawNumber) => {
    const digits = normalizePhoneDigits(rawNumber);
    if (!digits) return false;
    await ensureTelegramContactStatusTable();
    const row = await dbGetAsync(
      `SELECT has_telegram as hasTelegram
       FROM telegram_contact_status
       WHERE phone_digits = ?
       LIMIT 1`,
      [digits]
    );
    return Number(row?.hasTelegram || 0) === 1;
  };

  const listTelegramContactStatus = async () => {
    await ensureTelegramContactStatusTable();
    const rows = await dbAllAsync(
      `SELECT
         customer_id,
         phone_e164,
         phone_digits,
         has_telegram,
         telegram_user_id,
         telegram_username,
         telegram_first_name,
         telegram_last_name,
         telegram_phone,
         source,
         checked_at
       FROM telegram_contact_status
       ORDER BY datetime(checked_at) DESC`
    );
    return Array.isArray(rows) ? rows : [];
  };

  const resolveTelegramContactByUserId = async (rawUserId) => {
    const userId = toLongString(rawUserId);
    if (!userId) return null;
    await ensureTelegramContactStatusTable();
    const row = await dbGetAsync(
      `SELECT customer_id, phone_e164, phone_digits
       FROM telegram_contact_status
       WHERE telegram_user_id = ?
         AND has_telegram = 1
       ORDER BY datetime(checked_at) DESC
       LIMIT 1`,
      [userId]
    );
    if (!row) return null;
    return {
      customerId: String(row.customer_id || '').trim() || null,
      phoneE164: String(row.phone_e164 || '').trim() || null,
      phoneDigits: String(row.phone_digits || '').trim() || null,
    };
  };

  const resolveTelegramUserInboundText = (message) => {
    const text = String(message?.message || '').trim();
    if (text) return text;
    if (message?.photo) return '[Imagem Telegram]';
    if (message?.document) return '[Documento Telegram]';
    if (message?.video) return '[Vídeo Telegram]';
    if (message?.voice || message?.audio) return '[Áudio Telegram]';
    if (message?.sticker) return '[Sticker Telegram]';
    if (message?.contact) return '[Contacto Telegram]';
    if (message?.location) return '[Localização Telegram]';
    if (message?.poll) return '[Sondagem Telegram]';
    return '[Mensagem Telegram]';
  };

  const stopTelegramUserListener = async () => {
    telegramUserListenerActive = false;
    telegramUserListenerStarting = false;
    if (telegramUserListenerTimer) {
      clearInterval(telegramUserListenerTimer);
      telegramUserListenerTimer = null;
    }
    const currentClient = telegramUserListenerClient;
    telegramUserListenerClient = null;
    if (currentClient) {
      await disconnectTelegramUserClient(currentClient);
    }
  };

  const handleTelegramUserInboundEvent = async (event) => {
    const message = event?.message || null;
    if (!message) return;
    if (message?.out === true) return;

    const sender = await message.getSender().catch(() => null);
    const senderId =
      toLongString(sender?.id || sender?.userId) ||
      toLongString(message?.senderId) ||
      toLongString(message?.fromId?.userId);
    const normalizedSender = normalizeTelegramUserRecord(sender, senderId);

    const phoneDigits = normalizePhoneDigits(normalizedSender.phone);
    const mapped = !phoneDigits && senderId ? await resolveTelegramContactByUserId(senderId) : null;
    const mappedPhoneDigits = normalizePhoneDigits(mapped?.phoneDigits || mapped?.phoneE164 || '');
    const fromLookup = phoneDigits || mappedPhoneDigits || senderId;
    if (!fromLookup) return;
    const blockContactKey = normalizeBlockedContactKey(fromLookup);
    if (
      blockContactKey &&
      (await isBlockedContactSafe({
        channel: 'telegram',
        contactKey: blockContactKey,
      }))
    ) {
      emitChatEvent?.('inbound_blocked', {
        channel: 'telegram',
        from: fromLookup,
      });
      logChatCore?.('telegram_user_inbound_blocked', {
        senderId: normalizedSender.userId || senderId || null,
        contactKey: blockContactKey,
      });
      return;
    }

    const messageId = String(message?.id || Date.now()).trim();
    const waId = `tgu_in_${senderId || fromLookup}_${messageId}`;
    const body = resolveTelegramUserInboundText(message);

    const insertResult = await dbRunAsync(
      `INSERT OR IGNORE INTO messages (wa_id, from_number, body, direction, status)
       VALUES (?, ?, ?, 'inbound', 'received')`,
      [waId, fromLookup, body]
    );
    if (Number(insertResult?.changes || 0) <= 0) return;

    const preferredName = normalizedSender.displayName || `Telegram ${fromLookup}`;
    const ensured = await ensureConversationForPhone(fromLookup, {
      unreadIncrement: 1,
      status: 'open',
      lastMessageAt: nowIso(),
      customer: {
        preferredName,
        preferredCompany: 'Telegram',
      },
    });
    const conversationId = ensured?.conversation?.id || null;
    const customerId = ensured?.customer?.id || null;

    if (phoneDigits || mappedPhoneDigits) {
      const resolvedPhoneDigits = phoneDigits || mappedPhoneDigits;
      const resolvedPhoneE164 =
        normalizedSender.phone ||
        String(mapped?.phoneE164 || '').trim() ||
        (resolvedPhoneDigits ? `+${resolvedPhoneDigits}` : '');
      await upsertTelegramContactStatus({
        customerId,
        phoneE164: resolvedPhoneE164,
        phoneDigits: resolvedPhoneDigits,
        hasTelegram: true,
        telegramUserId: normalizedSender.userId || null,
        telegramUsername: normalizedSender.username || null,
        telegramFirstName: normalizedSender.firstName || null,
        telegramLastName: normalizedSender.lastName || null,
        telegramPhone: normalizedSender.phone || resolvedPhoneE164 || null,
        raw: {
          source: 'listener',
          userId: normalizedSender.userId || null,
          username: normalizedSender.username || null,
        },
      });
    }

    await writeAuditLog({
      actorUserId: null,
      entityType: 'message',
      entityId: waId,
      action: 'received_telegram_user',
      details: {
        channel: 'telegram_user',
        senderId: normalizedSender.userId || senderId || null,
        phoneDigits: phoneDigits || mappedPhoneDigits || null,
        conversationId,
      },
    });

    emitChatEvent?.('inbound_received', {
      channel: 'telegram_user',
      from: phoneDigits || mappedPhoneDigits || senderId || null,
      waId,
      conversationId,
      body: String(body || '').slice(0, 300),
    });
    logChatCore?.('telegram_user_inbound_saved', {
      messageId: waId,
      conversationId,
      senderId: normalizedSender.userId || senderId || null,
      phoneDigits: phoneDigits || mappedPhoneDigits || null,
    });

    void Promise.resolve()
      .then(() => sendMobilePushNotification?.({
        from: preferredName,
        preview: String(body || '').slice(0, 140),
        conversationId,
      }))
      .catch((pushError) => {
        console.warn('[MobilePush] Falha notificação Telegram User inbound:', pushError?.message || pushError);
      });
  };

  const startTelegramUserListener = async ({ force = false } = {}) => {
    if (!telegramUserConfigured) return false;
    await loadTelegramUserSessionFromSyncState();
    if (!telegramUserSessionCache) return false;
    if (telegramUserListenerActive && !force) return true;
    if (telegramUserListenerStarting) return false;

    telegramUserListenerStarting = true;
    let client;
    try {
      if (force) {
        await stopTelegramUserListener();
      }

      client = await createTelegramUserClient();
      const authorized = await client.checkAuthorization();
      if (!authorized) {
        await disconnectTelegramUserClient(client);
        return false;
      }

      client.addEventHandler(
        (event) => {
          void handleTelegramUserInboundEvent(event).catch((error) => {
            logChatCore?.('telegram_user_listener_event_error', {
              error: describeTelegramUserError(error),
            });
          });
        },
        new NewMessage({ incoming: true })
      );

      telegramUserListenerClient = client;
      telegramUserListenerActive = true;
      logChatCore?.('telegram_user_listener_started', {
        delayMs: TELEGRAM_USER_CHECK_DELAY_MS,
      });

      if (!telegramUserListenerTimer) {
        telegramUserListenerTimer = setInterval(() => {
          if (telegramUserListenerStarting) return;
          if (telegramUserListenerActive && telegramUserListenerClient?.connected) return;
          telegramUserListenerActive = false;
          void startTelegramUserListener().catch(() => null);
        }, 60000);
      }

      return true;
    } catch (error) {
      if (client) await disconnectTelegramUserClient(client);
      telegramUserListenerClient = null;
      telegramUserListenerActive = false;
      logChatCore?.('telegram_user_listener_start_error', {
        error: describeTelegramUserError(error),
      });
      return false;
    } finally {
      telegramUserListenerStarting = false;
    }
  };

  const resolveTelegramMessageText = (message) => {
    if (!message || typeof message !== 'object') return '';
    if (typeof message.text === 'string' && message.text.trim()) return message.text.trim();
    if (typeof message.caption === 'string' && message.caption.trim()) return message.caption.trim();

    if (message.photo) return '[Imagem Telegram]';
    if (message.document) return '[Documento Telegram]';
    if (message.video) return '[Vídeo Telegram]';
    if (message.audio || message.voice) return '[Áudio Telegram]';
    if (message.sticker) return '[Sticker Telegram]';
    if (message.contact) return '[Contacto Telegram]';
    if (message.location) return '[Localização Telegram]';
    if (message.poll) return '[Sondagem Telegram]';

    return '[Mensagem Telegram]';
  };

  const resolveTelegramSharedContact = (message) => {
    const contact = message?.contact;
    if (!contact || typeof contact !== 'object') return null;

    const sharedPhoneRaw = String(contact?.phone_number || '').trim();
    const sharedPhone = normalizePhone(sharedPhoneRaw);
    const sharedDigits = normalizePhoneDigits(sharedPhone);
    if (!sharedDigits) return null;

    const firstName = String(contact?.first_name || '').trim();
    const lastName = String(contact?.last_name || '').trim();
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
    const userId = String(contact?.user_id || '').trim();

    return {
      phone: sharedPhone,
      digits: sharedDigits,
      name: fullName || 'Contacto Telegram',
      userId: userId || null,
      source: 'telegram_contact',
    };
  };

  const resolveTelegramPhoneFromText = (rawText, fallbackName = 'Contacto Telegram') => {
    const candidate = String(rawText || '').trim();
    if (!candidate || /^\/\w+/.test(candidate)) return null;
    if (!/^\+?[\d\s().-]{7,22}$/.test(candidate)) return null;

    const normalizedPhone = normalizePhone(candidate);
    const digits = normalizePhoneDigits(normalizedPhone);
    if (!digits || digits.length < 9 || digits.length > 15) return null;

    return {
      phone: normalizedPhone,
      digits,
      name: String(fallbackName || '').trim() || 'Contacto Telegram',
      userId: null,
      source: 'typed_text',
    };
  };

  const resolveTelegramDisplayName = (message, chatId) => {
    const chat = message?.chat || {};
    const from = message?.from || {};
    const title = String(chat?.title || '').trim();
    if (title) return title;

    const firstName = String(chat?.first_name || from?.first_name || '').trim();
    const lastName = String(chat?.last_name || from?.last_name || '').trim();
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
    if (fullName) return fullName;

    const username = String(chat?.username || from?.username || '').trim();
    if (username) return `@${username}`;

    return `Telegram ${chatId}`;
  };

  const sendTelegramApiRequest = async (method, payload = {}) => {
    const token = String(TELEGRAM_BOT_TOKEN || '').trim();
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN não configurado.');
    }
    const endpoint = `https://api.telegram.org/bot${token}/${method}`;
    const { data } = await axios.post(endpoint, payload, { timeout: 20000 });
    if (!data?.ok) {
      const description = String(data?.description || 'Falha na API do Telegram.');
      throw new Error(description);
    }
    return data.result;
  };

  const isTelegramCustomerRecord = (customer) => {
    const company = String(customer?.company || '').trim().toLowerCase();
    if (company === 'telegram') return true;
    const name = String(customer?.name || '').trim().toLowerCase();
    return name.startsWith('telegram ');
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

  const hasTelegramTrafficForNumber = async (rawNumber) => {
    const digits = String(rawNumber || '').replace(/\D/g, '');
    if (!digits) return false;
    const row = await dbGetAsync(
      `SELECT 1 as ok
       FROM messages
       WHERE replace(replace(replace(ifnull(from_number, ''), '+', ''), ' ', ''), '-', '') = ?
         AND (wa_id LIKE 'tg_%' OR wa_id LIKE 'tgu_%')
       LIMIT 1`,
      [digits]
    );
    return Boolean(row);
  };

  const dispatchTelegramOutbound = async ({
    chatId,
    text,
    createdBy = null,
    parseMode = '',
    disableNotification = false,
    disableWebPagePreview,
    preferredName = '',
    conversationId = null,
    skipConversationEnsure = false,
  }) => {
    const normalizedChatId = normalizeTelegramChatId(chatId);
    const normalizedText = String(text || '').trim();
    if (!normalizedChatId) {
      throw new Error("chatId (ou 'to') é obrigatório.");
    }
    if (!normalizedText) {
      throw new Error("message (ou 'text') é obrigatório.");
    }
    const blockedContactKey = normalizeBlockedContactKey(normalizedChatId);
    if (
      blockedContactKey &&
      (await isBlockedContactSafe({
        channel: 'telegram',
        contactKey: blockedContactKey,
      }))
    ) {
      throw new Error('Este contacto Telegram está bloqueado para novas mensagens.');
    }

    const mode = String(parseMode || '').trim().toUpperCase();
    const payload = {
      chat_id: normalizedChatId,
      text: normalizedText,
      disable_notification: disableNotification === true,
    };
    if (['HTML', 'MARKDOWN', 'MARKDOWNV2'].includes(mode)) {
      payload.parse_mode = mode;
    }
    if (disableWebPagePreview === true || disableWebPagePreview === false) {
      payload.link_preview_options = { is_disabled: disableWebPagePreview === true };
    }

    const result = await sendTelegramApiRequest('sendMessage', payload);
    const lookupPhone = normalizeTelegramLookupPhone(normalizedChatId);
    let ensuredConversationId = String(conversationId || '').trim() || null;
    if (lookupPhone && !skipConversationEnsure) {
      const ensured = await ensureConversationForPhone(lookupPhone, {
        unreadCount: 0,
        status: 'open',
        lastMessageAt: nowIso(),
        customer: {
          preferredName: String(preferredName || '').trim() || `Telegram ${normalizedChatId}`,
          preferredCompany: 'Telegram',
        },
      });
      ensuredConversationId = ensured?.conversation?.id || ensuredConversationId;
    }

    const storedId = `tg_${normalizedChatId}_${result?.message_id || Date.now()}`;
    await dbRunAsync(
      `INSERT OR IGNORE INTO messages (wa_id, from_number, body, direction, status)
       VALUES (?, ?, ?, 'outbound', 'sent')`,
      [storedId, lookupPhone || normalizedChatId, normalizedText]
    );

    await writeAuditLog({
      actorUserId: String(createdBy || '').trim() || null,
      entityType: 'message',
      entityId: storedId,
      action: 'sent_telegram',
      details: {
        channel: 'telegram',
        chatId: normalizedChatId,
        conversationId: ensuredConversationId,
      },
    });

    emitChatEvent?.('outbound_sent', {
      channel: 'telegram',
      messageId: storedId,
      conversationId: ensuredConversationId,
      to: normalizedChatId,
    });
    logChatCore?.('telegram_outbound_sent', {
      messageId: storedId,
      conversationId: ensuredConversationId,
      to: normalizedChatId,
    });

    return {
      channel: 'telegram',
      messageId: storedId,
      conversationId: ensuredConversationId,
      telegram: result,
    };
  };

  const dispatchTelegramUserOutbound = async ({
    phone,
    text,
    createdBy = null,
    preferredName = '',
    conversationId = null,
    skipConversationEnsure = false,
  }) => {
    const normalizedPhone = normalizeTelegramUserPhone(phone);
    const phoneDigits = normalizePhoneDigits(normalizedPhone);
    const normalizedText = String(text || '').trim();

    if (!phoneDigits) {
      throw new Error("Número de destino inválido para Telegram.");
    }
    if (!normalizedText) {
      throw new Error("message (ou 'text') é obrigatório.");
    }
    if (
      await isBlockedContactSafe({
        channel: 'telegram',
        contactKey: phoneDigits,
      })
    ) {
      throw new Error('Este contacto Telegram está bloqueado para novas mensagens.');
    }
    if (!telegramUserConfigured) {
      throw new Error('Telegram User API não configurada (TELEGRAM_USER_API_ID / TELEGRAM_USER_API_HASH).');
    }

    let client = telegramUserListenerActive ? telegramUserListenerClient : null;
    const shouldDisconnect = !client;
    try {
      if (!client) {
        client = await createTelegramUserClient();
      }
      const authorized = await client.checkAuthorization();
      if (!authorized) {
        throw new Error('Conta Telegram não autenticada. Liga a conta Telegram User API primeiro.');
      }

      const verification = await verifyTelegramContactsByPhone(
        [
          {
            phone: normalizedPhone,
            label: String(preferredName || '').trim() || `Cliente ${phoneDigits}`,
          },
        ],
        {
          providedClient: client,
          persist: true,
          enforceHumanDelay: false,
        }
      );
      const verifiedContact = verification?.results?.[0] || null;
      if (!verifiedContact?.hasTelegram || !verifiedContact?.telegramUserId) {
        throw new Error('Este número não foi encontrado no Telegram com a conta autenticada.');
      }

      let peer;
      try {
        peer = await client.getEntity(verifiedContact.telegramUserId);
      } catch (_) {
        peer = null;
      }
      if (!peer) {
        throw new Error('Não foi possível resolver o destinatário Telegram para este número.');
      }

      const telegramMessage = await client.sendMessage(peer, { message: normalizedText });
      const telegramMessageId = String(telegramMessage?.id || Date.now()).trim();
      const waId = `tgu_${phoneDigits}_${telegramMessageId}`;

      let ensuredConversationId = String(conversationId || '').trim() || null;
      if (!ensuredConversationId && !skipConversationEnsure) {
        const ensured = await ensureConversationForPhone(phoneDigits, {
          unreadCount: 0,
          status: 'open',
          lastMessageAt: nowIso(),
          customer: {
            preferredName: String(preferredName || '').trim() || `Telegram ${phoneDigits}`,
            preferredCompany: 'Telegram',
          },
        });
        ensuredConversationId = ensured?.conversation?.id || ensuredConversationId;
      }

      await dbRunAsync(
        `INSERT OR IGNORE INTO messages (wa_id, from_number, body, direction, status)
         VALUES (?, ?, ?, 'outbound', 'sent')`,
        [waId, phoneDigits, normalizedText]
      );

      await writeAuditLog({
        actorUserId: String(createdBy || '').trim() || null,
        entityType: 'message',
        entityId: waId,
        action: 'sent_telegram_user',
        details: {
          channel: 'telegram_user',
          phone: normalizedPhone,
          phoneDigits,
          conversationId: ensuredConversationId,
          telegramUserId: verifiedContact.telegramUserId || null,
        },
      });

      emitChatEvent?.('outbound_sent', {
        channel: 'telegram_user',
        messageId: waId,
        conversationId: ensuredConversationId,
        to: normalizedPhone,
      });
      logChatCore?.('telegram_user_outbound_sent', {
        messageId: waId,
        conversationId: ensuredConversationId,
        to: normalizedPhone,
      });

      return {
        channel: 'telegram_user',
        messageId: waId,
        conversationId: ensuredConversationId,
        telegram: {
          messageId: telegramMessageId,
          userId: verifiedContact.telegramUserId || null,
          username: verifiedContact.telegramUsername || null,
          phone: normalizedPhone,
        },
      };
    } finally {
      if (shouldDisconnect) {
        await disconnectTelegramUserClient(client);
      }
    }
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
  app.get(['/webhook', '/webhook/whatsapp'], (req, res) => {
    if (!isCloudWhatsAppProvider) {
      return res.status(404).json({
        success: false,
        error: 'Webhook Meta indisponível quando WHATSAPP_PROVIDER=baileys.',
      });
    }
    if (
      req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VERIFY_TOKEN
    ) {
      res.send(req.query['hub.challenge']);
    } else {
      res.sendStatus(400);
    }
  });

  // Rota para Receber Mensagens (POST)
  app.post(['/webhook', '/webhook/whatsapp'], async (req, res) => {
    if (!isCloudWhatsAppProvider) {
      return res.sendStatus(200);
    }
    const body = req.body || {};
    const changeValue = body.entry?.[0]?.changes?.[0]?.value;
    const statuses = changeValue?.statuses;
    const msg = changeValue?.messages?.[0];
    const webhookContactName = String(changeValue?.contacts?.[0]?.profile?.name || '').trim();

    if (!body.object) {
      return res.sendStatus(200);
    }

    if (Array.isArray(statuses) && statuses.length > 0) {
      statuses.forEach((statusEvent) => {
        const msgId = statusEvent.id;
        const recipient = statusEvent.recipient_id || '';
        const status = statusEvent.status || 'unknown';
        const errorItem = statusEvent.errors?.[0];
        const errorCode = errorItem?.code || '';
        const errorTitle = errorItem?.title || errorItem?.message || '';

        if (msgId) {
          db.run('UPDATE messages SET status = ? WHERE wa_id = ?', [status, msgId], (err) => {
            if (err) console.error('Erro ao atualizar status da mensagem:', err.message);
          });

          db.run(
            `UPDATE outbound_queue
             SET status = ?, updated_at = CURRENT_TIMESTAMP, last_error = CASE WHEN ? = '' THEN NULL ELSE ? END
             WHERE wa_id = ?`,
            [errorCode ? 'failed' : status, errorTitle || '', errorTitle || '', msgId],
            (err) => {
              if (err) console.error('Erro ao atualizar status da fila:', err.message);
            }
          );

          db.get(
            `SELECT id, conversation_id
             FROM outbound_queue
             WHERE wa_id = ?
             ORDER BY id DESC
             LIMIT 1`,
            [msgId],
            (lookupError, row) => {
              if (lookupError) return;
              emitChatEvent?.('message_status', {
                waId: msgId,
                recipient,
                status,
                errorCode: errorCode || null,
                errorTitle: errorTitle || null,
                queueId: Number(row?.id || 0) || null,
                conversationId: String(row?.conversation_id || '').trim() || null,
              });
              logChatCore?.('webhook_message_status', {
                waId: msgId,
                recipient,
                status,
                errorCode: errorCode || null,
                errorTitle: errorTitle || null,
                queueId: Number(row?.id || 0) || null,
                conversationId: String(row?.conversation_id || '').trim() || null,
              });
            }
          );

          void writeAuditLog({
            actorUserId: null,
            entityType: 'message_status',
            entityId: msgId,
            action: status,
            details: {
              recipient,
              errorCode: errorCode || null,
              errorTitle: errorTitle || null,
            },
          });
        }
      });
    }

    if (!msg) {
      return res.sendStatus(200);
    }

    const from = msg.from || '';
    if (!from) {
      return res.sendStatus(200);
    }
    const blockedWhatsAppKey = normalizeBlockedContactKey(from);
    if (
      blockedWhatsAppKey &&
      (await isBlockedContactSafe({
        channel: 'whatsapp',
        contactKey: blockedWhatsAppKey,
      }))
    ) {
      emitChatEvent?.('inbound_blocked', {
        channel: 'whatsapp',
        from,
        waId: String(msg.id || '').trim() || null,
      });
      logChatCore?.('webhook_inbound_blocked', {
        channel: 'whatsapp',
        from,
        waId: String(msg.id || '').trim() || null,
      });
      return res.sendStatus(200);
    }

    const mediaPayload = resolveWebhookMediaPayload(msg);
    let text = '';
    if (msg.type === 'text') {
      text = msg.text?.body || '';
    } else if (msg.type === 'interactive' && msg.interactive?.button_reply) {
      text = msg.interactive.button_reply.title;
    } else if (mediaPayload?.kind === 'image') {
      text = mediaPayload.caption
        ? `[Imagem] ${mediaPayload.fileName}\n${mediaPayload.caption}`
        : `[Imagem] ${mediaPayload.fileName}`;
    } else if (mediaPayload?.kind === 'document') {
      text = mediaPayload.caption
        ? `[Documento] ${mediaPayload.fileName}\n${mediaPayload.caption}`
        : `[Documento] ${mediaPayload.fileName}`;
    } else if (mediaPayload?.caption) {
      text = mediaPayload.caption;
    } else {
      text = `[Midia/Outro: ${msg.type || 'unknown'}]`;
    }

    const waId = msg.id || null;

    db.run(
      `INSERT OR IGNORE INTO messages (
        wa_id, from_number, body, direction, status,
        media_kind, media_path, media_mime_type, media_file_name, media_size,
        media_provider, media_remote_id, media_remote_url, media_meta_json
      ) VALUES (?, ?, ?, 'inbound', 'received', ?, NULL, ?, ?, ?, 'cloud', ?, ?, ?)`,
      [
        waId,
        from,
        text,
        mediaPayload?.kind || null,
        mediaPayload?.mimeType || null,
        mediaPayload?.fileName || null,
        Number.isFinite(Number(mediaPayload?.size)) ? Number(mediaPayload.size) : null,
        mediaPayload?.remoteId || null,
        mediaPayload?.remoteUrl || null,
        mediaPayload ? JSON.stringify(mediaPayload.meta || null) : null,
      ],
      async function onMessageInsert(err) {
        if (err) {
          console.error('Erro ao salvar msg', err);
          return;
        }
        if (Number(this?.changes || 0) === 0) {
          emitChatEvent?.('inbound_duplicate', {
            from,
            waId: waId || null,
          });
          logChatCore?.('webhook_inbound_duplicate', {
            from,
            waId: waId || null,
          });
          return;
        }
        try {
          const { conversation } = await ensureConversationForPhone(from, {
            unreadIncrement: 1,
            status: 'open',
            lastMessageAt: nowIso(),
            customer: webhookContactName
              ? {
                  preferredName: webhookContactName,
                }
              : undefined,
          });
          await writeAuditLog({
            actorUserId: null,
            entityType: 'message',
            entityId: waId || null,
            action: 'received',
            details: { from, type: msg.type || 'unknown' },
          });
          emitChatEvent?.('inbound_received', {
            from,
            waId: waId || null,
            conversationId: conversation?.id || null,
            body: String(text || '').slice(0, 300),
          });
          logChatCore?.('webhook_inbound_saved', {
            from,
            waId: waId || null,
            conversationId: conversation?.id || null,
          });

          void Promise.resolve()
            .then(() => sendMobilePushNotification?.({
              from,
              preview: String(text || '').slice(0, 140),
              conversationId: conversation?.id || null,
            }))
            .catch((pushError) => {
              console.warn('[MobilePush] Falha ao enviar notificação inbound:', pushError?.message || pushError);
            });

          if (ENABLE_WEBHOOK_AUTOREPLY) {
            void handleInboundAutomationReply(from, text);
          }
        } catch (persistError) {
          console.error('[Webhook] Erro ao persistir mensagem recebida:', persistError?.message || persistError);
        }
      }
    );

    res.sendStatus(200);
  });

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

  app.get(['/api/telegram/health', '/api/chat/telegram/health'], (_req, res) => {
    return res.json({
      success: true,
      configured: hasTelegramBot(),
      userConfigured: telegramUserConfigured,
      userCheckIntervalMs: TELEGRAM_USER_CHECK_DELAY_MS,
      webhookPath: telegramWebhookPath,
      hasWebhookSecret: Boolean(String(TELEGRAM_WEBHOOK_SECRET || '').trim()),
    });
  });

  app.get(['/api/telegram/user/health', '/api/chat/telegram/user/health'], async (_req, res) => {
    const status = await resolveTelegramUserAuthState();
    if (status?.authorized) {
      void startTelegramUserListener().catch(() => null);
    }
    return res.json({
      success: true,
      ...status,
    });
  });

  app.post(['/api/telegram/user/auth/send-code', '/api/chat/telegram/user/auth/send-code'], async (req, res) => {
    if (!telegramUserConfigured) {
      return res.status(503).json({
        success: false,
        error: 'Telegram User API não configurada (TELEGRAM_USER_API_ID / TELEGRAM_USER_API_HASH).',
      });
    }

    const body = req.body || {};
    const phoneNumber = normalizeTelegramUserPhone(body.phoneNumber || body.phone || '');
    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber obrigatório.',
      });
    }

    let client;
    try {
      client = await createTelegramUserClient();
      const authorized = await client.checkAuthorization();
      if (authorized) {
        const authState = await resolveTelegramUserAuthState();
        void startTelegramUserListener().catch(() => null);
        return res.json({
          success: true,
          alreadyAuthorized: true,
          ...authState,
        });
      }

      const sendResult = await client.sendCode(
        { apiId: telegramUserApiId, apiHash: telegramUserApiHash },
        phoneNumber,
        body.forceSMS === true
      );
      const partialSession = String(client.session.save() || '').trim();
      telegramPendingAuth = {
        phoneNumber,
        phoneCodeHash: String(sendResult?.phoneCodeHash || '').trim(),
        requiresPassword: false,
        session: partialSession,
        createdAt: nowIso(),
      };
      if (partialSession) {
        await saveTelegramUserSessionToSyncState(partialSession);
      }

      return res.json({
        success: true,
        alreadyAuthorized: false,
        phoneNumber,
        isCodeViaApp: sendResult?.isCodeViaApp === true,
      });
    } catch (error) {
      const message = describeTelegramUserError(error);
      return res.status(500).json({
        success: false,
        error: message,
      });
    } finally {
      await disconnectTelegramUserClient(client);
    }
  });

  app.post(['/api/telegram/user/auth/verify-code', '/api/chat/telegram/user/auth/verify-code'], async (req, res) => {
    if (!telegramUserConfigured) {
      return res.status(503).json({
        success: false,
        error: 'Telegram User API não configurada (TELEGRAM_USER_API_ID / TELEGRAM_USER_API_HASH).',
      });
    }

    if (!telegramPendingAuth?.phoneCodeHash || !telegramPendingAuth?.phoneNumber) {
      return res.status(409).json({
        success: false,
        error: 'Não existe código pendente. Pede primeiro o código Telegram.',
      });
    }

    const body = req.body || {};
    const code = String(body.code || body.phoneCode || '').trim();
    const requestPhone = normalizeTelegramUserPhone(body.phoneNumber || body.phone || telegramPendingAuth.phoneNumber || '');
    if (!code) {
      return res.status(400).json({ success: false, error: 'code obrigatório.' });
    }
    if (!requestPhone || requestPhone !== telegramPendingAuth.phoneNumber) {
      return res.status(400).json({ success: false, error: 'phoneNumber não corresponde ao pedido de código pendente.' });
    }

    let client;
    try {
      client = await createTelegramUserClient(telegramPendingAuth.session || '');
      const signInResult = await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: telegramPendingAuth.phoneNumber,
          phoneCodeHash: telegramPendingAuth.phoneCodeHash,
          phoneCode: code,
        })
      );
      if (String(signInResult?.className || '').trim() === 'auth.AuthorizationSignUpRequired') {
        return res.status(400).json({
          success: false,
          error: 'Este número ainda não tem conta Telegram ativa.',
        });
      }

      const user = signInResult?.user || null;
      const normalizedUser = normalizeTelegramUserRecord(user);
      const sessionValue = String(client.session.save() || '').trim();
      if (sessionValue) {
        await saveTelegramUserSessionToSyncState(sessionValue);
      }
      telegramPendingAuth = null;
      void startTelegramUserListener({ force: true }).catch(() => null);

      return res.json({
        success: true,
        requiresPassword: false,
        authorized: true,
        account: {
          userId: normalizedUser.userId || null,
          username: normalizedUser.username || null,
          firstName: normalizedUser.firstName || null,
          lastName: normalizedUser.lastName || null,
          phone: normalizedUser.phone || null,
          displayName: normalizedUser.displayName || null,
        },
      });
    } catch (error) {
      const rawMessage = String(error?.errorMessage || error?.message || '').trim();
      if (rawMessage === 'SESSION_PASSWORD_NEEDED') {
        const partialSession = String(client?.session?.save?.() || telegramPendingAuth.session || '').trim();
        telegramPendingAuth = {
          ...telegramPendingAuth,
          requiresPassword: true,
          session: partialSession,
          createdAt: nowIso(),
        };
        if (partialSession) {
          await saveTelegramUserSessionToSyncState(partialSession);
        }
        return res.json({
          success: true,
          requiresPassword: true,
          authorized: false,
        });
      }

      const message = describeTelegramUserError(error);
      return res.status(500).json({
        success: false,
        error: message,
      });
    } finally {
      await disconnectTelegramUserClient(client);
    }
  });

  app.post(['/api/telegram/user/auth/verify-password', '/api/chat/telegram/user/auth/verify-password'], async (req, res) => {
    if (!telegramUserConfigured) {
      return res.status(503).json({
        success: false,
        error: 'Telegram User API não configurada (TELEGRAM_USER_API_ID / TELEGRAM_USER_API_HASH).',
      });
    }

    if (!telegramPendingAuth?.session) {
      return res.status(409).json({
        success: false,
        error: 'Não existe autenticação pendente com 2FA.',
      });
    }

    const body = req.body || {};
    const password = String(body.password || '').trim();
    if (!password) {
      return res.status(400).json({
        success: false,
        error: 'password obrigatório.',
      });
    }

    let client;
    try {
      client = await createTelegramUserClient(telegramPendingAuth.session || '');
      await client.signInWithPassword(
        { apiId: telegramUserApiId, apiHash: telegramUserApiHash },
        {
          password: async () => password,
          onError: async () => true,
        }
      );

      const me = await client.getMe();
      const normalizedUser = normalizeTelegramUserRecord(me);
      const sessionValue = String(client.session.save() || '').trim();
      if (sessionValue) {
        await saveTelegramUserSessionToSyncState(sessionValue);
      }
      telegramPendingAuth = null;
      void startTelegramUserListener({ force: true }).catch(() => null);

      return res.json({
        success: true,
        authorized: true,
        account: {
          userId: normalizedUser.userId || null,
          username: normalizedUser.username || null,
          firstName: normalizedUser.firstName || null,
          lastName: normalizedUser.lastName || null,
          phone: normalizedUser.phone || null,
          displayName: normalizedUser.displayName || null,
        },
      });
    } catch (error) {
      const message = describeTelegramUserError(error);
      return res.status(500).json({
        success: false,
        error: message,
      });
    } finally {
      await disconnectTelegramUserClient(client);
    }
  });

  app.post(['/api/telegram/user/auth/logout', '/api/chat/telegram/user/auth/logout'], async (_req, res) => {
    await stopTelegramUserListener();
    await clearTelegramUserSession();
    return res.json({ success: true, cleared: true });
  });

  app.get(['/api/telegram/user/contacts/status', '/api/chat/telegram/user/contacts/status'], async (_req, res) => {
    try {
      const [auth, rows] = await Promise.all([resolveTelegramUserAuthState(), listTelegramContactStatus()]);
      return res.json({
        success: true,
        auth,
        total: rows.length,
        data: rows.map((row) => ({
          customerId: String(row.customer_id || '').trim() || null,
          phoneE164: String(row.phone_e164 || '').trim(),
          phoneDigits: String(row.phone_digits || '').trim(),
          hasTelegram: Number(row.has_telegram || 0) === 1,
          telegramUserId: String(row.telegram_user_id || '').trim() || null,
          telegramUsername: String(row.telegram_username || '').trim() || null,
          telegramFirstName: String(row.telegram_first_name || '').trim() || null,
          telegramLastName: String(row.telegram_last_name || '').trim() || null,
          telegramPhone: String(row.telegram_phone || '').trim() || null,
          source: String(row.source || '').trim() || 'user_api',
          checkedAt: String(row.checked_at || '').trim() || null,
        })),
      });
    } catch (error) {
      const message = describeTelegramUserError(error);
      return res.status(500).json({
        success: false,
        error: message,
      });
    }
  });

  app.post(['/api/telegram/user/contacts/check', '/api/chat/telegram/user/contacts/check'], async (req, res) => {
    if (!telegramUserConfigured) {
      return res.status(503).json({
        success: false,
        error: 'Telegram User API não configurada (TELEGRAM_USER_API_ID / TELEGRAM_USER_API_HASH).',
      });
    }

    const body = req.body || {};
    let items = Array.isArray(body.items) ? body.items : [];
    if (!items.length && body.refreshAll === true) {
      const customerRows = await dbAllAsync(
        `SELECT id, name, company, phone
         FROM customers
         WHERE replace(replace(replace(ifnull(phone, ''), '+', ''), ' ', ''), '-', '') <> ''
         ORDER BY updated_at DESC`
      );
      items = (Array.isArray(customerRows) ? customerRows : []).map((row) => ({
        customerId: String(row.id || '').trim(),
        phone: String(row.phone || '').trim(),
        label: String(row.company || row.name || 'Cliente').trim(),
      }));
    }

    if (!items.length) {
      return res.status(400).json({
        success: false,
        error: 'Lista items vazia. Envia items com customerId + phone ou usa refreshAll=true.',
      });
    }
    if (items.length > TELEGRAM_USER_CONTACTS_BATCH_LIMIT) {
      return res.status(400).json({
        success: false,
        error: `Máximo ${TELEGRAM_USER_CONTACTS_BATCH_LIMIT} contactos por pedido.`,
      });
    }

    try {
      const result = await verifyTelegramContactsByPhone(items, { persist: true });
      return res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      const message = describeTelegramUserError(error);
      return res.status(500).json({
        success: false,
        error: message,
      });
    }
  });

  app.post(['/api/telegram/webhook/set', '/api/chat/telegram/webhook/set'], async (req, res) => {
    if (!hasTelegramBot()) {
      return res.status(503).json({
        success: false,
        error: 'TELEGRAM_BOT_TOKEN não configurado.',
      });
    }

    const body = req.body || {};
    const baseUrl = String(body.baseUrl || API_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    const rawPath = normalizePath(body.path || telegramWebhookPath, telegramWebhookPath);
    if (!baseUrl) {
      return res.status(400).json({
        success: false,
        error: 'baseUrl obrigatório (ou configure API_PUBLIC_BASE_URL no .env).',
      });
    }

    const webhookUrl = `${baseUrl}${rawPath}`;
    const payload = {
      url: webhookUrl,
      drop_pending_updates: body.dropPendingUpdates === true,
    };
    if (String(TELEGRAM_WEBHOOK_SECRET || '').trim()) {
      payload.secret_token = String(TELEGRAM_WEBHOOK_SECRET || '').trim();
    }

    try {
      const result = await sendTelegramApiRequest('setWebhook', payload);
      return res.json({
        success: true,
        webhookUrl,
        result,
      });
    } catch (error) {
      const details = error?.response?.data || error?.message || error;
      return res.status(500).json({
        success: false,
        error: details,
      });
    }
  });

  app.post(['/api/telegram/send', '/api/chat/telegram/send'], async (req, res) => {
    if (!hasTelegramBot()) {
      return res.status(503).json({
        success: false,
        error: 'TELEGRAM_BOT_TOKEN não configurado.',
      });
    }

    const body = req.body || {};
    const chatId = normalizeTelegramChatId(body.chatId ?? body.to);
    const text = String(body.message ?? body.text ?? '').trim();
    const parseMode = String(body.parseMode || '').trim();
    const createdBy = String(body.createdBy || '').trim() || null;

    try {
      const sent = await dispatchTelegramOutbound({
        chatId,
        text,
        createdBy,
        parseMode,
        disableNotification: body.disableNotification === true,
        disableWebPagePreview: body.disableWebPagePreview,
      });
      return res.json({ success: true, ...sent });
    } catch (error) {
      const details = error?.response?.data || error?.message || error;
      logChatCore?.('telegram_outbound_error', {
        to: chatId,
        error: typeof details === 'string' ? details : JSON.stringify(details),
      });
      return res.status(500).json({
        success: false,
        error: details,
      });
    }
  });

  app.post(['/api/telegram/user/send', '/api/chat/telegram/user/send'], async (req, res) => {
    if (!telegramUserConfigured) {
      return res.status(503).json({
        success: false,
        error: 'Telegram User API não configurada (TELEGRAM_USER_API_ID / TELEGRAM_USER_API_HASH).',
      });
    }

    const body = req.body || {};
    const phone = String(body.phone || body.to || '').trim();
    const text = String(body.message ?? body.text ?? '').trim();
    const createdBy = String(body.createdBy || '').trim() || null;

    try {
      const sent = await dispatchTelegramUserOutbound({
        phone,
        text,
        createdBy,
        preferredName: String(body.preferredName || '').trim() || '',
        conversationId: String(body.conversationId || '').trim() || null,
      });
      return res.json({ success: true, ...sent });
    } catch (error) {
      const message = describeTelegramUserError(error);
      return res.status(500).json({
        success: false,
        error: message,
      });
    }
  });

  app.post(['/api/telegram/request-contact', '/api/chat/telegram/request-contact'], async (req, res) => {
    if (!hasTelegramBot()) {
      return res.status(503).json({
        success: false,
        error: 'TELEGRAM_BOT_TOKEN não configurado.',
      });
    }

    const body = req.body || {};
    const chatId = normalizeTelegramChatId(body.chatId ?? body.to);
    const prompt = String(
      body.prompt ||
        'Para associarmos os teus dados de contacto, partilha o teu número usando o botão abaixo.'
    ).trim();
    const createdBy = String(body.createdBy || '').trim() || null;

    if (!chatId) {
      return res.status(400).json({
        success: false,
        error: "chatId (ou 'to') é obrigatório.",
      });
    }

    try {
      const result = await sendTelegramApiRequest('sendMessage', {
        chat_id: chatId,
        text: prompt,
        reply_markup: {
          keyboard: [[{ text: 'Partilhar contacto', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      });

      const lookupPhone = normalizeTelegramLookupPhone(chatId);
      const ensured = await ensureConversationForPhone(lookupPhone || chatId, {
        unreadCount: 0,
        status: 'open',
        lastMessageAt: nowIso(),
        customer: {
          preferredName: `Telegram ${chatId}`,
          preferredCompany: 'Telegram',
        },
      });

      const storedId = `tg_${chatId}_${result?.message_id || Date.now()}`;
      await dbRunAsync(
        `INSERT OR IGNORE INTO messages (wa_id, from_number, body, direction, status)
         VALUES (?, ?, ?, 'outbound', 'sent')`,
        [storedId, lookupPhone || chatId, `[Pedido de contacto Telegram]\n${prompt}`]
      );

      await writeAuditLog({
        actorUserId: createdBy,
        entityType: 'message',
        entityId: storedId,
        action: 'telegram_contact_request',
        details: {
          channel: 'telegram',
          chatId,
          conversationId: ensured?.conversation?.id || null,
        },
      });

      emitChatEvent?.('outbound_sent', {
        channel: 'telegram',
        messageId: storedId,
        conversationId: ensured?.conversation?.id || null,
        to: chatId,
      });

      return res.json({
        success: true,
        channel: 'telegram',
        messageId: storedId,
        conversationId: ensured?.conversation?.id || null,
        telegram: result,
      });
    } catch (error) {
      const details = error?.response?.data || error?.message || error;
      return res.status(500).json({
        success: false,
        error: details,
      });
    }
  });

  app.post(telegramWebhookRoutes, async (req, res) => {
    try {
      if (String(TELEGRAM_WEBHOOK_SECRET || '').trim()) {
        const headerSecret = String(req.headers['x-telegram-bot-api-secret-token'] || '').trim();
        if (headerSecret !== String(TELEGRAM_WEBHOOK_SECRET || '').trim()) {
          return res.status(403).json({ ok: false, error: 'secret_token inválido.' });
        }
      }

      const update = req.body || {};
      const message =
        update.message ||
        update.edited_message ||
        update.channel_post ||
        update.edited_channel_post ||
        null;

      if (!message) {
        return res.status(200).json({ ok: true, ignored: true });
      }

      const chatId = normalizeTelegramChatId(message?.chat?.id);
      if (!chatId) {
        return res.status(200).json({ ok: true, ignored: true });
      }

      const lookupPhone = normalizeTelegramLookupPhone(chatId);
      const blockedTelegramKey = normalizeBlockedContactKey(lookupPhone || chatId);
      if (
        blockedTelegramKey &&
        (await isBlockedContactSafe({
          channel: 'telegram',
          contactKey: blockedTelegramKey,
        }))
      ) {
        emitChatEvent?.('inbound_blocked', {
          channel: 'telegram',
          from: lookupPhone || chatId,
          waId: `tg_${chatId}_${String(message?.message_id || update?.update_id || '0')}`,
        });
        logChatCore?.('telegram_webhook_inbound_blocked', {
          chatId,
          contactKey: blockedTelegramKey,
        });
        return res.status(200).json({ ok: true, blocked: true });
      }
      const messageId = String(message?.message_id || update?.update_id || Date.now()).trim();
      const storedId = `tg_${chatId}_${messageId}`;
      const text = resolveTelegramMessageText(message);
      const displayName = resolveTelegramDisplayName(message, chatId);
      let sharedContact = resolveTelegramSharedContact(message);

      if (!sharedContact) {
        const typedPhoneContact = resolveTelegramPhoneFromText(text, displayName);
        if (typedPhoneContact) {
          const pendingPrompt = await dbGetAsync(
            `SELECT id
               FROM messages
              WHERE direction = 'outbound'
                AND from_number = ?
                AND body LIKE '[Pedido de contacto Telegram]%'
                AND timestamp >= datetime('now', '-3 days')
              ORDER BY id DESC
              LIMIT 1`,
            [lookupPhone || chatId]
          );
          if (pendingPrompt?.id) {
            sharedContact = typedPhoneContact;
          }
        }
      }

      const insertResult = await dbRunAsync(
        `INSERT OR IGNORE INTO messages (wa_id, from_number, body, direction, status)
         VALUES (?, ?, ?, 'inbound', 'received')`,
        [storedId, lookupPhone || chatId, text]
      );
      if (Number(insertResult?.changes || 0) <= 0) {
        return res.status(200).json({ ok: true, duplicate: true });
      }

      const ensured = await ensureConversationForPhone(lookupPhone || chatId, {
        unreadIncrement: 1,
        status: 'open',
        lastMessageAt: nowIso(),
        customer: {
          preferredName: displayName,
          preferredCompany: 'Telegram',
        },
      });
      const conversationId = ensured?.conversation?.id || null;
      let customerForConversation = ensured?.customer || null;

      if (sharedContact && customerForConversation?.id && typeof upsertLocalCustomer === 'function') {
        const currentContacts = Array.isArray(customerForConversation?.contacts)
          ? customerForConversation.contacts
          : [];
        const nextContacts = [...currentContacts];
        const alreadyHasPhone = nextContacts.some((item) => {
          return normalizePhoneDigits(item?.phone) === sharedContact.digits;
        });
        if (!alreadyHasPhone) {
          nextContacts.push({
            name: sharedContact.name,
            phone: sharedContact.phone,
          });
        }

        if (!alreadyHasPhone) {
          customerForConversation = await upsertLocalCustomer({
            id: customerForConversation.id,
            name: customerForConversation.name,
            company: customerForConversation.company,
            phone: customerForConversation.phone,
            contacts: nextContacts,
          });
        }

        await writeAuditLog({
          actorUserId: null,
          entityType: 'customer',
          entityId: customerForConversation?.id || null,
          action: 'telegram_contact_shared',
          details: {
            chatId,
            sharedPhone: sharedContact.phone,
            sharedContactName: sharedContact.name,
            source: sharedContact.source || 'unknown',
            conversationId,
          },
        });
      }

      await writeAuditLog({
        actorUserId: null,
        entityType: 'message',
        entityId: storedId,
        action: 'received_telegram',
        details: {
          channel: 'telegram',
          chatId,
          conversationId,
        },
      });

      emitChatEvent?.('inbound_received', {
        channel: 'telegram',
        from: chatId,
        waId: storedId,
        conversationId,
        body: String(text || '').slice(0, 300),
        sharedContactPhone: sharedContact?.phone || null,
      });
      logChatCore?.('telegram_inbound_saved', {
        chatId,
        messageId: storedId,
        conversationId,
      });

      void Promise.resolve()
        .then(() => sendMobilePushNotification?.({
          from: `Telegram ${chatId}`,
          preview: String(text || '').slice(0, 140),
          conversationId,
        }))
        .catch((pushError) => {
          console.warn('[MobilePush] Falha ao enviar notificação Telegram:', pushError?.message || pushError);
        });

      return res.status(200).json({ ok: true });
    } catch (error) {
      const details = error?.response?.data || error?.message || error;
      console.error('[Webhook Telegram] Erro ao processar update:', details);
      return res.status(200).json({ ok: false });
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
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM messages mtg
              WHERE replace(replace(replace(ifnull(mtg.from_number, ''), '+', ''), ' ', ''), '-', '') =
                    replace(replace(replace(ifnull(cu.phone, ''), '+', ''), ' ', ''), '-', '')
                AND (ifnull(mtg.wa_id, '') LIKE 'tg_%' OR ifnull(mtg.wa_id, '') LIKE 'tgu_%')
            ) THEN 'telegram'
            WHEN EXISTS (
              SELECT 1
              FROM telegram_contact_status tcs2
              WHERE tcs2.phone_digits = replace(replace(replace(ifnull(cu.phone, ''), '+', ''), ' ', ''), '-', '')
                AND tcs2.has_telegram = 1
            ) THEN 'telegram'
            ELSE 'whatsapp'
          END as channel,
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
        bc.updated_at as blocked_at,
        COALESCE(tcs.has_telegram, 0) as telegram_verified,
        tcs.checked_at as telegram_checked_at
      FROM ranked_contacts rc
      LEFT JOIN telegram_contact_status tcs ON tcs.phone_digits = rc.phone_digits
      LEFT JOIN blocked_contacts bc
        ON bc.is_active = 1
       AND bc.channel = rc.channel
       AND (
            bc.contact_key = rc.phone_digits
            OR (
              length(bc.contact_key) >= CASE WHEN rc.channel = 'telegram' THEN 6 ELSE 7 END
              AND length(rc.phone_digits) >= CASE WHEN rc.channel = 'telegram' THEN 6 ELSE 7 END
              AND (
                bc.contact_key LIKE ('%' || rc.phone_digits)
                OR rc.phone_digits LIKE ('%' || bc.contact_key)
              )
            )
          )
      WHERE rc.row_num = 1
      ORDER BY datetime(rc.last_msg_time) DESC`;

    try {
      await ensureTelegramContactStatusTable();
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

  app.get(['/api/telegram/customers', '/api/chat/telegram/customers'], async (_req, res) => {
    const sql = `
      WITH telegram_conversations AS (
        SELECT
          cv.id as conversation_id,
          cv.customer_id as customer_id,
          cv.last_message_at as last_message_at,
          cv.unread_count as unread_count,
          replace(substr(cv.id, length('conv_wa_c_') + 1), ' ', '') as chat_digits
        FROM conversations cv
        WHERE cv.id LIKE 'conv_wa_c_%'
      )
      SELECT
        tc.conversation_id,
        tc.customer_id,
        cu.name as customer_name,
        cu.company as customer_company,
        cu.phone as customer_phone,
        tc.chat_digits as telegram_chat_id,
        tc.last_message_at,
        tc.unread_count,
        (
          SELECT COUNT(1)
          FROM messages m
          WHERE replace(replace(replace(ifnull(m.from_number, ''), '+', ''), ' ', ''), '-', '') = tc.chat_digits
            AND (ifnull(m.wa_id, '') LIKE 'tg_%' OR ifnull(m.wa_id, '') LIKE 'tgu_%')
        ) as telegram_messages
      FROM telegram_conversations tc
      JOIN customers cu ON cu.id = tc.customer_id
      WHERE tc.chat_digits <> ''
        AND EXISTS (
          SELECT 1
          FROM messages m2
          WHERE replace(replace(replace(ifnull(m2.from_number, ''), '+', ''), ' ', ''), '-', '') = tc.chat_digits
            AND (ifnull(m2.wa_id, '') LIKE 'tg_%' OR ifnull(m2.wa_id, '') LIKE 'tgu_%')
        )
      ORDER BY datetime(tc.last_message_at) DESC
    `;

    try {
      const rows = await dbAllAsync(sql, []);
      return res.json({
        success: true,
        total: Array.isArray(rows) ? rows.length : 0,
        data: Array.isArray(rows) ? rows : [],
      });
    } catch (error) {
      const details = error?.message || error;
      return res.status(500).json({ success: false, error: details });
    }
  });

  // Rota para Listar Mensagens (Chat Específico)
  app.get(['/api/messages', '/api/chat/messages'], (req, res) => {
    const phone = req.query.phone;
    const accountId = String(req.query.accountId || req.query.account_id || '').trim();
    let sql = 'SELECT * FROM messages';
    const params = [];
    const where = [];

    if (phone) {
      where.push(`replace(replace(replace(ifnull(from_number, ''), '+', ''), ' ', ''), '-', '') = ?`);
      params.push(String(phone).replace(/\D/g, ''));
    }
    if (accountId) {
      where.push(`ifnull(account_id, '') = ?`);
      params.push(accountId);
    }
    if (where.length > 0) {
      sql += ` WHERE ${where.join(' AND ')}`;
    }

    sql += ' ORDER BY id DESC LIMIT 50';

    db.all(sql, params, (err, rows) => {
      if (err) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.json({ data: (rows || []).reverse() });
    });
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

      const isTelegramByCustomer = isTelegramCustomerRecord(customer);
      const isTelegramByHistory = await hasTelegramTrafficForNumber(formattedTo);
      const isTelegramByVerified = await hasTelegramVerifiedForNumber(formattedTo);
      let isTelegramAutoDetected = false;
      // Prioridade operacional: WhatsApp primeiro.
      // Só usamos Telegram automaticamente quando o próprio registo do cliente é Telegram.
      let isTelegramTarget = isTelegramByCustomer;
      const outboundChannel = isTelegramTarget ? 'telegram' : 'whatsapp';
      if (
        await isBlockedContactSafe({
          channel: outboundChannel,
          contactKey: formattedTo,
        })
      ) {
        const channelLabel = outboundChannel === 'telegram' ? 'Telegram' : 'WhatsApp';
        return res.status(403).json({
          success: false,
          error: `Contacto bloqueado no canal ${channelLabel}.`,
        });
      }

      const selectedType = String(type || 'text').trim().toLowerCase();
      let messageKind = 'text';
      let messageBody = String(message || '').trim();
      let templateName = '';
      const prefersMetaTemplates = String(whatsappProvider || 'cloud').trim().toLowerCase() === 'cloud';

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

      // Mesmo que existam sinais de Telegram (histórico/validação), mantemos WhatsApp como canal por defeito.

      if (isTelegramTarget) {
        if (selectedType === 'image' || selectedType === 'document') {
          return res.status(400).json({
            success: false,
            error: 'Envio de imagem/documento via Telegram ainda não disponível nesta caixa de entrada.',
          });
        }

        await dbRunAsync(
          `UPDATE outbound_queue
           SET status = 'dead_letter',
               last_error = 'Mensagem antiga movida: contacto identificado como Telegram.',
               updated_at = CURRENT_TIMESTAMP
           WHERE to_number = ?
             AND status IN ('queued', 'retry', 'processing')`,
          [formattedTo]
        );

        const useTelegramUserApi = telegramUserConfigured && (isTelegramByVerified || isTelegramAutoDetected || !hasTelegramBot());
        if (isTelegramByVerified && !telegramUserConfigured) {
          return res.status(503).json({
            success: false,
            error: 'Número marcado como Telegram por telefone, mas Telegram User API não está configurada.',
          });
        }

        let sent;
        if (useTelegramUserApi) {
          sent = await dispatchTelegramUserOutbound({
            phone: normalizePhone(formattedTo),
            text: messageBody,
            createdBy: String(createdBy || '').trim() || null,
            preferredName: String(customer?.name || '').trim() || `Telegram ${formattedTo}`,
            conversationId: conversation?.id || requestedConversationId || null,
            skipConversationEnsure: Boolean(conversation?.id || requestedConversationId),
          });
        } else {
          if (!hasTelegramBot()) {
            return res.status(503).json({
              success: false,
              error: 'Canal Telegram sem configuração. Defina TELEGRAM_BOT_TOKEN ou Telegram User API no .env.',
            });
          }

          sent = await dispatchTelegramOutbound({
            chatId: rawTo || formattedTo,
            text: messageBody,
            createdBy: String(createdBy || '').trim() || null,
            preferredName: String(customer?.name || '').trim() || `Telegram ${formattedTo}`,
            conversationId: conversation?.id || requestedConversationId || null,
            skipConversationEnsure: Boolean(conversation?.id || requestedConversationId),
          });
        }

        return res.json({
          success: true,
          queued: false,
          ...sent,
        });
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
             id, wa_id,
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
             id, wa_id,
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

  void startTelegramUserListener().catch(() => null);

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
