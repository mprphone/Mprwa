﻿const { createApp } = require('./src/app');
const { loadEnvConfig } = require('./src/config/env');
const { openDatabase, createDbHelpers } = require('./src/db');
const { initializeSchema } = require('./src/db/schema');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { createBaileysGateway } = require('./src/server/services/baileysGateway');
const { createWhatsAppService } = require('./src/server/services/whatsappService');
const { createSupabaseClient } = require('./src/server/services/supabaseClient');
const { createRobotService } = require('./src/server/services/robotService');
const { createEmailService } = require('./src/server/services/emailService');
const { createQueueWorker } = require('./src/server/jobs/queueWorker');
const { createAutoPullWorker } = require('./src/server/jobs/autoPullWorker');
const { createUserRepository } = require('./src/server/repositories/userRepository');
const { createCustomerRepository } = require('./src/server/repositories/customerRepository');
const { createCustomerMergeService } = require('./src/server/services/customerMergeService');
const { registerChatCoreRoutes } = require('./backend/chatCoreRoutes');
const { registerLocalDataRoutes } = require('./backend/routes/localDataRoutes');
const { registerOccurrencesRoutes } = require('./backend/routes/occurrencesRoutes');
const { registerImportRoutes } = require('./backend/routes/importRoutes');
const { registerImportObrigacoesRoutes } = require('./backend/routes/importObrigacoesRoutes');
const { registerLocalSyncSaftRoutes } = require('./backend/routes/localSyncSaftRoutes');
const { registerObrigacoesAutoRoutes } = require('./backend/routes/obrigacoesAutoRoutes');
const { registerMobileRoutes } = require('./backend/routes/mobileRoutes');
const { registerDesktopRoutes } = require('./backend/routes/desktopRoutes');
const { registerFrontendRoutes } = require('./backend/routes/frontendRoutes');
const { createMobilePushService } = require('./backend/services/mobilePushService');
const { startServerLifecycle } = require('./backend/jobs/startServerLifecycle');
const {
    normalizeDigits,
    normalizeLookupText,
    classifyObrigacaoEstado,
    classifyDriCmpEnvStatus,
    classifyDmrProcessadoCertaStatus,
    classifySaftEnviadoStatus,
    classifyGoffSaftStatus,
    normalizeIvaPeriodicidade,
    classifyGoffIvaStatus,
    classifyIvaProcessadoStatus,
    classifyM22ProcessadoStatus,
    classifyRelatorioUnicoStatus,
    normalizeIntValue,
    parseDatePtToIso,
    resolveMonthYear,
    resolveObrigacaoPeriod,
    parseIvaPeriodFromValue,
    resolveShiftedYearMonth,
    computeNextDailyRunAt,
} = require('./src/server/utils/obrigacoes');
const { getCustomerSecretsKey, encryptCustomerSecret, decryptCustomerSecret } = require('./src/server/utils/crypto');
const { createMappers } = require('./src/server/utils/mappers');
const { createTaskRepository } = require('./src/server/repositories/taskRepository');
const { createConversationRepository } = require('./src/server/repositories/conversationRepository');
const { createMessageService } = require('./src/server/services/messageService');
const { createSaftService } = require('./src/server/services/saftService');
const { createObrigacoesWorker } = require('./src/server/jobs/obrigacoesWorker');
const { app, express } = createApp();

// --- 1. Banco de Dados Minimalista (SQLite) ---
const dbPath = path.resolve(process.env.WA_DB_PATH || path.join(process.cwd(), 'whatsapp.db'));
const db = openDatabase(dbPath);
const { dbRunAsync, dbGetAsync, dbAllAsync, dbExecAsync } = createDbHelpers(db);

const CUSTOMER_SECRET_MIGRATION_STATE_KEY = 'customers_secret_encryption_v1';

const dbReadyPromise = initializeSchema({ dbRunAsync, dbGetAsync, dbAllAsync, dbExecAsync })
    .then(async () => {
        await ensureCustomerSecretsEncryptedAtRest();
        return true;
    })
    .catch((error) => {
        console.error('[DB] Falha na inicialização de schema/migrations:', error?.message || error);
        return false;
    });

// --- 2. Configurações WhatsApp Cloud API ---
const { config: envConfig, warnings: envWarnings } = loadEnvConfig();
envWarnings.forEach((warning) => {
    console.warn(`[ENV] ${warning}`);
});

const {
    WHATSAPP_PROVIDER,
    TOKEN,
    VERIFY_TOKEN,
    PHONE_NUMBER_ID,
    WHATSAPP_BAILEYS_AUTH_DIR,
    WHATSAPP_BAILEYS_ACCOUNTS_JSON,
    WHATSAPP_BAILEYS_DEFAULT_ACCOUNT,
    WHATSAPP_BAILEYS_NAME_CONFLICT_ACCOUNT,
    WHATSAPP_BAILEYS_PRINT_QR,
    WHATSAPP_BAILEYS_AUTO_START,
    SAFT_EMAIL,
    SAFT_PASSWORD,
    GOFF_EMAIL,
    GOFF_PASSWORD,
    SAFT_ROBOT_SCRIPT,
    RESEND_API_KEY,
    RESEND_FROM,
    SMTP_HOST,
    SMTP_PORT,
    SMTP_TLS,
    SMTP_USERNAME,
    SMTP_PASSWORD,
    SMTP_FROM_EMAIL,
    SMTP_FROM_NAME,
    SMTP_CC_FALLBACK,
    ENABLE_WEBHOOK_AUTOREPLY,
    API_PUBLIC_BASE_URL,
    SUPABASE_URL,
    SUPABASE_KEY,
    SUPABASE_CLIENTS_SOURCE,
    SUPABASE_CLIENTS_UPDATED_AT_COLUMN,
    SUPABASE_FUNCIONARIOS_SOURCE,
    SUPABASE_TAREFAS_SOURCE,
    SUPABASE_RECOLHAS_ESCOLHA,
    SUPABASE_OBRIGACOES_MODELO,
    SUPABASE_OBRIGACOES_PERIODOS_PREFIX,
    SUPABASE_OCORRENCIAS_SOURCE,
    SUPABASE_OCORRENCIAS_FOTOS_SOURCE,
    SUPABASE_OCORRENCIAS_DOCUMENTOS_SOURCE,
    SUPABASE_TIPOS_OCORRENCIA_SOURCE,
    SAFT_OBRIGACOES_ROBOT_SCRIPT,
    GOFF_OBRIGACOES_ROBOT_SCRIPT,
    DRI_OBRIGACAO_ID,
    DMR_OBRIGACAO_ID,
    SAFT_OBRIGACAO_ID,
    IVA_OBRIGACAO_ID_MENSAL,
    IVA_OBRIGACAO_ID_TRIMESTRAL,
    M22_OBRIGACAO_ID,
    IES_OBRIGACAO_ID,
    M10_OBRIGACAO_ID,
    INVENTARIO_OBRIGACAO_ID,
    RELATORIO_UNICO_OBRIGACAO_ID,
    OBRIGACOES_AUTO_ENABLED,
    OBRIGACOES_AUTO_HOUR,
    OBRIGACOES_AUTO_MINUTE,
    OBRIGACOES_AUTO_TIMEZONE,
    CUSTOMERS_AUTO_PULL_ENABLED,
    CUSTOMERS_AUTO_PULL_INTERVAL_MINUTES,
    CUSTOMERS_AUTO_PULL_STARTUP_DELAY_SECONDS,
    MAX_QUEUE_RETRIES,
    APP_ROLE,
    CHAT_CORE_INTERNAL_URL,
    LOCAL_DOCS_ROOT,
    DOCS_WINDOWS_PREFIX,
    DOCS_LINUX_MOUNT,
    SAFT_BUNKER_ROOT,
} = envConfig;

const IS_CHAT_CORE_ONLY = APP_ROLE === 'chat_core';
const IS_BACKOFFICE_ONLY = APP_ROLE === 'backoffice';
const PORT = process.env.PORT || 3000;
const ACTIVE_WHATSAPP_PROVIDER = String(WHATSAPP_PROVIDER || 'cloud').trim().toLowerCase() === 'baileys'
    ? 'baileys'
    : 'cloud';

const chatEvents = new EventEmitter();
chatEvents.setMaxListeners(200);
const ivaImportJobs = new Map();

const DEFAULT_AVATAR = 'https://ui-avatars.com/api/?name=User&background=random';
const SAFT_BUNKER_FALLBACK_ROOT = path.resolve(path.join(LOCAL_DOCS_ROOT, '_saft_bunker'));
const CUSTOMER_TYPES = {
    ENTERPRISE: 'Empresa',
    INDEPENDENT: 'Independente',
    SUPPLIER: 'Fornecedor',
    PRIVATE: 'Particular',
    PUBLIC_SERVICE: 'Serviços Públicos',
    OTHER: 'Outros',
    SPAM: 'Spam',
};

function createIvaJobId() {
    return `iva_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function setIvaImportJob(jobId, patch) {
    const current = ivaImportJobs.get(jobId) || {};
    const next = {
        ...current,
        ...patch,
        updatedAt: nowIso(),
    };
    ivaImportJobs.set(jobId, next);
    return next;
}

function isChatCorePath(pathname = '') {
    const path = String(pathname || '').trim();
    if (!path) return false;
    if (path === '/webhook' || path === '/webhook/whatsapp') return true;
    if (path.startsWith('/api/chat')) return true;
    if (path.startsWith('/api/avatars/')) return true;
    if (path === '/api/contacts' || path === '/api/messages' || path === '/api/send') return true;
    if (path === '/api/conversations/local' || path === '/api/conversations/sync') return true;
    return false;
}

async function proxyToChatCore(req, res) {
    const targetUrl = `${CHAT_CORE_INTERNAL_URL}${req.originalUrl}`;
    const requestHeaders = { ...req.headers };
    delete requestHeaders.host;
    delete requestHeaders.connection;
    delete requestHeaders['content-length'];

    const isStreamRequest = req.path === '/api/chat/stream';
    const isMediaProxyRequest =
        /^\/api\/chat\/messages\/[^/]+\/media$/i.test(req.path) ||
        /^\/api\/messages\/[^/]+\/media$/i.test(req.path);
    const isAvatarRequest = /^\/api\/avatars\//.test(req.path) || /\/avatar$/.test(req.path);
    const isBinaryRequest =
        req.path === '/api/chat/whatsapp/qr/image' ||
        req.path === '/api/whatsapp/qr/image' ||
        isMediaProxyRequest ||
        isAvatarRequest;
    const method = String(req.method || 'GET').toUpperCase();

    try {
        if (isStreamRequest) {
            const response = await axios({
                method,
                url: targetUrl,
                headers: requestHeaders,
                responseType: 'stream',
                timeout: 0,
                validateStatus: () => true,
            });

            res.status(response.status);
            Object.entries(response.headers || {}).forEach(([key, value]) => {
                if (value === undefined) return;
                if (['transfer-encoding', 'connection'].includes(String(key).toLowerCase())) return;
                res.setHeader(key, value);
            });
            response.data.pipe(res);
            req.on('close', () => {
                response.data.destroy?.();
            });
            return;
        }

        const requestData =
            method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? undefined : req.body;
        const response = await axios({
            method,
            url: targetUrl,
            headers: requestHeaders,
            data: requestData,
            responseType: isBinaryRequest ? 'arraybuffer' : undefined,
            timeout: 30000,
            validateStatus: () => true,
        });

        res.status(response.status);
        if (response.headers?.['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }
        if (response.headers?.['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }
        if (isBinaryRequest) {
            const raw = response.data;
            if (!raw) return res.end();
            if (Buffer.isBuffer(raw)) return res.end(raw);
            if (raw instanceof ArrayBuffer) return res.end(Buffer.from(raw));
            if (ArrayBuffer.isView(raw)) {
                return res.end(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
            }
            if (typeof raw === 'string') return res.end(Buffer.from(raw, 'binary'));
            return res.end(Buffer.from(String(raw)));
        }
        if (typeof response.data === 'object') {
            return res.send(response.data);
        }
        return res.send(String(response.data || ''));
    } catch (error) {
        const details = error?.response?.data || error?.message || error;
        console.error('[Backoffice Proxy] Erro a encaminhar para chat-core:', details);
        return res.status(502).json({
            success: false,
            error: 'Chat core indisponível no proxy interno.',
            details: typeof details === 'string' ? details : JSON.stringify(details),
        });
    }
}

// --- Mappers (extracted) ---
const mapperDeps = {
    normalizePhone,
    normalizeDigits,
    pickFirstValue,
    decryptCustomerSecret,
    encryptCustomerSecret,
};
const {
    parseManagersArray,
    parseAccessCredentialsArray,
    serializeAccessCredentialsForStorage,
    applyDefaultAccessCredentialUsernames,
    parseCustomerProfile,
    buildCustomerProfileFromInput,
    serializeCustomerProfile,
    parseJsonObject,
    parseJsonArray,
    parseAgregadoFamiliarArray,
    parseFichasRelacionadasArray,
    extractManagersFromRawRow,
    extractAccessCredentialsFromRawRow,
    foldText,
} = createMappers(mapperDeps);

const {
    normalizeLocalSqlUser,
    sanitizeRoleValue,
    parseSourceId,
    getAllLocalUsers,
    upsertLocalUser,
    mergeUsersWithLocalOverrides,
} = createUserRepository({
    dbAllAsync,
    dbGetAsync,
    dbRunAsync,
    normalizeBoolean,
    parseJsonArray,
    normalizeRole,
    defaultAvatar: DEFAULT_AVATAR,
});

const {
    sanitizeCustomerId,
    parseCustomerSourceId,
    normalizeCustomerNif,
    isValidPortugueseNif,
    parseContactsArray,
    normalizeLocalSqlCustomer,
    getAllLocalCustomers,
    upsertLocalCustomer,
    getLocalCustomerById,
} = createCustomerRepository({
    dbAllAsync,
    dbGetAsync,
    dbRunAsync,
    normalizePhone,
    normalizeDigits,
    normalizeBoolean,
    normalizeCustomerType,
    parseManagersArray,
    parseAccessCredentialsArray,
    applyDefaultAccessCredentialUsernames,
    serializeAccessCredentialsForStorage,
    parseCustomerProfile,
    buildCustomerProfileFromInput,
    serializeCustomerProfile,
    parseJsonObject,
    parseJsonArray,
    parseAgregadoFamiliarArray,
    parseFichasRelacionadasArray,
    encryptCustomerSecret,
    decryptCustomerSecret,
});

const { mergeCustomersWithLocalOverrides } = createCustomerMergeService({
    parseCustomerSourceId,
    normalizeCustomerNif,
    normalizeBoolean,
});

// Bind lazy deps for mappers (breaks circular dependency with customerRepository)
mapperDeps.normalizeCustomerNif = normalizeCustomerNif;
mapperDeps.parseCustomerSourceId = parseCustomerSourceId;

// --- Task Repository (extracted) ---
const {
    normalizeTaskStatus,
    normalizeTaskPriority,
    parseTaskAttachmentsArray,
    normalizeLocalSqlTask,
    getLocalTasks,
    upsertLocalTask,
    normalizeCallSource,
    normalizeLocalSqlCall,
    getLocalCalls,
    upsertLocalCall,
} = createTaskRepository({
    dbAllAsync,
    dbGetAsync,
    dbRunAsync,
    parseJsonArray,
});


async function ensureCustomerSecretsEncryptedAtRest() {
    const key = getCustomerSecretsKey();
    if (!key) return;

    const stateValue = await getSyncStateValue(CUSTOMER_SECRET_MIGRATION_STATE_KEY).catch(() => '');
    if (String(stateValue || '').trim()) return;

    const rows = await dbAllAsync(
        `SELECT id, senha_financas, senha_seg_social, access_credentials_json
         FROM customers`
    );

    let changedRows = 0;
    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        for (const row of rows) {
            const currentSenhaFinancas = String(row?.senha_financas || '').trim();
            const currentSenhaSegSocial = String(row?.senha_seg_social || '').trim();
            const currentAccessJson = String(row?.access_credentials_json || '').trim();

            const nextSenhaFinancas = (() => {
                const runtime = decryptCustomerSecret(currentSenhaFinancas);
                return runtime ? encryptCustomerSecret(runtime) : '';
            })();
            const nextSenhaSegSocial = (() => {
                const runtime = decryptCustomerSecret(currentSenhaSegSocial);
                return runtime ? encryptCustomerSecret(runtime) : '';
            })();

            let nextAccessJson = currentAccessJson;
            if (!currentAccessJson) {
                nextAccessJson = '';
            } else {
                const parsedCredentials = parseAccessCredentialsArray(currentAccessJson);
                if (parsedCredentials.length > 0 || currentAccessJson === '[]') {
                    nextAccessJson = serializeAccessCredentialsForStorage(parsedCredentials);
                }
            }

            if (
                nextSenhaFinancas !== currentSenhaFinancas ||
                nextSenhaSegSocial !== currentSenhaSegSocial ||
                nextAccessJson !== currentAccessJson
            ) {
                await dbRunAsync(
                    `UPDATE customers
                     SET senha_financas = ?,
                         senha_seg_social = ?,
                         access_credentials_json = ?,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [
                        nextSenhaFinancas || null,
                        nextSenhaSegSocial || null,
                        nextAccessJson || null,
                        String(row?.id || '').trim(),
                    ]
                );
                changedRows += 1;
            }
        }

        await dbRunAsync('COMMIT');
    } catch (error) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        throw error;
    }

    await setSyncStateValue(
        CUSTOMER_SECRET_MIGRATION_STATE_KEY,
        `ok:${nowIso()}:updated=${changedRows}`
    ).catch(() => null);

    console.log(`[Security] Cifragem local de credenciais concluída. Registos atualizados=${changedRows}`);
}


function nowIso() {
    return new Date().toISOString();
}

function logChatCore(stage, payload = {}) {
    try {
        console.log(
            JSON.stringify({
                scope: 'chat_core',
                stage,
                timestamp: nowIso(),
                ...payload,
            })
        );
    } catch (error) {
        console.log('[chat_core]', stage, payload);
    }
}

function emitChatEvent(type, payload = {}) {
    const event = {
        type: String(type || 'event').trim() || 'event',
        timestamp: nowIso(),
        ...payload,
    };
    chatEvents.emit('chat_event', event);
    return event;
}

const mobilePushService = createMobilePushService({
    dbAllAsync,
    dbRunAsync,
    logChatCore,
});

function parseBaileysAccountsConfig(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((entry) => {
                if (!entry || typeof entry !== 'object') return null;
                const id = sanitizeIdPart(entry.id || entry.accountId || '', '');
                if (!id) return null;
                const authDirRaw = String(entry.authDir || '').trim();
                const authDir = authDirRaw
                    ? path.resolve(authDirRaw)
                    : path.resolve(process.cwd(), `.baileys_auth_${id}`);
                return {
                    id,
                    label: String(entry.label || id).trim() || id,
                    authDir,
                    autoStart: entry.autoStart === undefined ? WHATSAPP_BAILEYS_AUTO_START : normalizeBoolean(entry.autoStart, WHATSAPP_BAILEYS_AUTO_START),
                    printQRInTerminal:
                        entry.printQRInTerminal === undefined
                            ? WHATSAPP_BAILEYS_PRINT_QR
                            : normalizeBoolean(entry.printQRInTerminal, WHATSAPP_BAILEYS_PRINT_QR),
                };
            })
            .filter(Boolean);
    } catch (_) {
        return [];
    }
}

const configuredBaileysAccounts = parseBaileysAccountsConfig(WHATSAPP_BAILEYS_ACCOUNTS_JSON);
const defaultSingleAccountId = sanitizeIdPart(WHATSAPP_BAILEYS_DEFAULT_ACCOUNT || 'default', 'default');
const BAILEYS_ACCOUNT_CONFIGS =
    configuredBaileysAccounts.length > 0
        ? configuredBaileysAccounts
        : [
              {
                  id: defaultSingleAccountId,
                  label: 'WhatsApp Principal',
                  authDir: path.resolve(String(WHATSAPP_BAILEYS_AUTH_DIR || path.resolve(process.cwd(), '.baileys_auth')).trim()),
                  autoStart: WHATSAPP_BAILEYS_AUTO_START,
                  printQRInTerminal: WHATSAPP_BAILEYS_PRINT_QR,
              },
          ];
const BAILEYS_ACCOUNTS_BY_ID = new Map(BAILEYS_ACCOUNT_CONFIGS.map((account) => [account.id, account]));
const ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID = BAILEYS_ACCOUNTS_BY_ID.has(defaultSingleAccountId)
    ? defaultSingleAccountId
    : BAILEYS_ACCOUNT_CONFIGS[0]?.id || 'default';
const nameConflictAccountCandidate = sanitizeIdPart(WHATSAPP_BAILEYS_NAME_CONFLICT_ACCOUNT || '', '');
const ACTIVE_BAILEYS_NAME_CONFLICT_ACCOUNT_ID =
    nameConflictAccountCandidate && BAILEYS_ACCOUNTS_BY_ID.has(nameConflictAccountCandidate)
        ? nameConflictAccountCandidate
        : BAILEYS_ACCOUNTS_BY_ID.has('linha2')
            ? 'linha2'
            : ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID;
const baileysGateways = new Map();
let baileysGateway = null;

const {
    isBaileysProviderEnabled,
    resolveWhatsAppAccountId,
    getBaileysGatewayForAccount,
    pickBaileysGatewayForOutbound,
    getWhatsAppAccountsHealth,
    getWhatsAppHealth,
    connectWhatsAppProvider,
    disconnectWhatsAppProvider,
    getWhatsAppQrPayload,
    sendWhatsAppDocumentLink,
    sendWhatsAppTextMessage,
    sendWhatsAppMenuMessage,
    downloadInboundMediaStream,
} = createWhatsAppService({
    activeProvider: ACTIVE_WHATSAPP_PROVIDER,
    accountConfigs: BAILEYS_ACCOUNT_CONFIGS,
    accountsById: BAILEYS_ACCOUNTS_BY_ID,
    defaultAccountId: ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID,
    baileysGateways,
    resolveOutboundAccountIdForPhone: (...args) => resolveOutboundAccountIdForPhone(...args),
});

function pickFirstValue(row, keys) {
    for (const key of keys) {
        if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
            return row[key];
        }
    }
    return '';
}

function sanitizeIdPart(value, fallback) {
    const cleaned = String(value ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    return cleaned || fallback;
}

function normalizePhone(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return '';

    const digits = raw.replace(/\D/g, '');
    if (!digits) return '';

    if (raw.startsWith('+')) return `+${digits}`;
    if (digits.length === 9) return `+351${digits}`;
    return `+${digits}`;
}

function normalizeBlockedChannel(rawValue) {
    return 'whatsapp';
}

function normalizeBlockedContactKey(rawValue, rawChannel = 'whatsapp') {
    const channel = normalizeBlockedChannel(rawChannel);
    const digits = String(rawValue || '').replace(/\D/g, '');
    if (!digits) return '';
    return digits;
}

function isSameBlockedContactKey(leftValue, rightValue, rawChannel = 'whatsapp') {
    const channel = normalizeBlockedChannel(rawChannel);
    const left = String(leftValue || '').replace(/\D/g, '');
    const right = String(rightValue || '').replace(/\D/g, '');
    if (!left || !right) return false;
    if (left === right) return true;

    // Aceita variações com/sem indicativo internacional (ex.: 9 dígitos vs 12+ dígitos).
    // Evita falsos positivos com chaves muito curtas.
    const minComparableLength = 7;
    if (left.length < minComparableLength || right.length < minComparableLength) return false;
    return left.endsWith(right) || right.endsWith(left);
}

async function listBlockedContacts(rawChannel = '') {
    const channel = String(rawChannel || '').trim() ? normalizeBlockedChannel(rawChannel) : '';
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
}

async function upsertBlockedContact({ channel = 'whatsapp', contactKey = '', reason = '', actorUserId = null } = {}) {
    const normalizedChannel = normalizeBlockedChannel(channel);
    const normalizedContactKey = normalizeBlockedContactKey(contactKey, normalizedChannel);
    if (!normalizedContactKey) {
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
            normalizedContactKey,
            String(reason || '').trim() || null,
            String(actorUserId || '').trim() || null,
        ]
    );

    const row = await dbGetAsync(
        `SELECT id, channel, contact_key, reason, created_by, is_active, created_at, updated_at
         FROM blocked_contacts
         WHERE channel = ? AND contact_key = ?
         LIMIT 1`,
        [normalizedChannel, normalizedContactKey]
    );

    return row
        ? {
              id: Number(row.id || 0),
              channel: normalizeBlockedChannel(row.channel),
              contactKey: String(row.contact_key || '').trim(),
              reason: String(row.reason || '').trim() || null,
              createdBy: String(row.created_by || '').trim() || null,
              isActive: Number(row.is_active || 0) === 1,
              createdAt: String(row.created_at || '').trim() || null,
              updatedAt: String(row.updated_at || '').trim() || null,
          }
        : null;
}

async function removeBlockedContact({ id = null, channel = '', contactKey = '' } = {}) {
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
    const normalizedContactKey = normalizeBlockedContactKey(contactKey, normalizedChannel);
    if (!normalizedContactKey) return false;

    const matches = await dbAllAsync(
        `SELECT id, contact_key
         FROM blocked_contacts
         WHERE channel = ?
           AND is_active = 1`,
        [normalizedChannel]
    );
    const matchedIds = (Array.isArray(matches) ? matches : [])
        .filter((row) => isSameBlockedContactKey(row?.contact_key, normalizedContactKey, normalizedChannel))
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
}

async function isBlockedContact({ channel = 'whatsapp', contactKey = '' } = {}) {
    const normalizedChannel = normalizeBlockedChannel(channel);
    const normalizedContactKey = normalizeBlockedContactKey(contactKey, normalizedChannel);
    if (!normalizedContactKey) return false;
    const rows = await dbAllAsync(
        `SELECT contact_key
         FROM blocked_contacts
         WHERE channel = ?
           AND is_active = 1`,
        [normalizedChannel]
    );
    return (Array.isArray(rows) ? rows : []).some((row) =>
        isSameBlockedContactKey(row?.contact_key, normalizedContactKey, normalizedChannel)
    );
}

function normalizeBoolean(rawValue, fallback = true) {
    if (rawValue === undefined || rawValue === null || rawValue === '') return fallback;
    if (typeof rawValue === 'boolean') return rawValue;
    if (typeof rawValue === 'number') return rawValue !== 0;

    const value = String(rawValue).toLowerCase().trim();
    if (['1', 'true', 'yes', 'sim', 'ativo', 'active'].includes(value)) return true;
    if (['0', 'false', 'no', 'nao', 'não', 'inativo', 'inactive'].includes(value)) return false;
    return fallback;
}

if (isBaileysProviderEnabled() && !IS_BACKOFFICE_ONLY) {
    const AVATARS_DIR = path.resolve(process.cwd(), 'chat_media', 'avatars');
    fs.mkdirSync(AVATARS_DIR, { recursive: true });

    // Own WhatsApp numbers to exclude from contact name sync
    const getOwnWhatsAppDigits = () => {
        const ownDigits = new Set();
        for (const [, gw] of baileysGateways) {
            try {
                const health = gw.getHealth?.();
                const meId = String(health?.meId || '').trim();
                const digits = meId.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') || '';
                if (digits.length >= 7) ownDigits.add(digits);
            } catch (_) { /* ignore */ }
        }
        return ownDigits;
    };

    const BUSINESS_PROFILE_NAMES = new Set(['mpr negocios', 'mpr negócios', 'mpr geral', 'mpr']);

    const handleContactsUpsert = async (contacts, accountId, gateway) => {
        const ownDigits = getOwnWhatsAppDigits();
        for (const contact of contacts) {
            try {
                const digits = String(contact.jid || '').split('@')[0].replace(/\D/g, '');
                if (!digits || digits.length < 7) continue;
                // Skip our own WhatsApp numbers
                if (ownDigits.has(digits)) continue;
                const phone = normalizePhone(digits);
                if (!phone) continue;

                const savedName = contact.savedName || '';
                // Skip if name is a business profile name
                if (savedName && !BUSINESS_PROFILE_NAMES.has(savedName.toLowerCase().trim())) {
                    const existing = await dbGetAsync(
                        `SELECT id, contact_name FROM customers WHERE replace(replace(replace(ifnull(phone,''),'+',''),' ',''),'-','') = ? LIMIT 1`,
                        [digits]
                    );
                    if (existing && !existing.contact_name) {
                        await dbRunAsync('UPDATE customers SET contact_name = ?, updated_at = ? WHERE id = ?', [savedName, nowIso(), existing.id]);
                        logChatCore('contact_name_from_whatsapp', { customerId: existing.id, savedName, accountId });
                    }
                }

                // Fetch and save profile picture
                const avatarPath = path.join(AVATARS_DIR, `${digits}.jpg`);
                try {
                    const stat = await fs.promises.stat(avatarPath).catch(() => null);
                    const isStale = !stat || (Date.now() - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000); // refresh weekly
                    if (isStale && gateway?.fetchProfilePictureUrl) {
                        const picUrl = await gateway.fetchProfilePictureUrl(digits);
                        if (picUrl) {
                            const https = require('https');
                            const http = require('http');
                            const fetcher = picUrl.startsWith('https') ? https : http;
                            await new Promise((resolve, reject) => {
                                fetcher.get(picUrl, (res) => {
                                    if (res.statusCode !== 200) { res.resume(); return resolve(null); }
                                    const ws = fs.createWriteStream(avatarPath);
                                    res.pipe(ws);
                                    ws.on('finish', resolve);
                                    ws.on('error', reject);
                                }).on('error', () => resolve(null));
                            });
                        }
                    }
                } catch (_avatarErr) { /* non-critical */ }
            } catch (err) {
                logChatCore('contacts_upsert_process_error', { error: String(err?.message || err), accountId });
            }
        }
    };

    // Fetch avatar on-demand: tries all connected gateways
    const fetchAvatarOnDemand = async (phoneDigits) => {
        const digits = String(phoneDigits || '').replace(/\D/g, '');
        if (!digits || digits.length < 7) return null;
        const avatarPath = path.join(AVATARS_DIR, `${digits}.jpg`);
        try {
            const stat = await fs.promises.stat(avatarPath).catch(() => null);
            const isStale = !stat || (Date.now() - stat.mtimeMs > 7 * 24 * 60 * 60 * 1000);
            if (!isStale) return avatarPath;
        } catch (_) { /* continue to fetch */ }
        // Try each connected gateway to fetch the profile picture
        for (const [, gw] of baileysGateways) {
            try {
                if (!gw?.fetchProfilePictureUrl) continue;
                const picUrl = await gw.fetchProfilePictureUrl(digits);
                if (!picUrl) continue;
                const https = require('https');
                const http = require('http');
                const fetcher = picUrl.startsWith('https') ? https : http;
                await new Promise((resolve, reject) => {
                    fetcher.get(picUrl, (res) => {
                        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
                        const ws = fs.createWriteStream(avatarPath);
                        res.pipe(ws);
                        ws.on('finish', resolve);
                        ws.on('error', reject);
                    }).on('error', () => resolve(null));
                });
                // Check the file was actually written
                const written = await fs.promises.stat(avatarPath).catch(() => null);
                if (written && written.size > 0) return avatarPath;
            } catch (_) { /* try next gateway */ }
        }
        return null;
    };

    BAILEYS_ACCOUNT_CONFIGS.forEach((account) => {
        const gateway = createBaileysGateway({
            authDir: account.authDir,
            printQRInTerminal: account.printQRInTerminal,
            autoReconnect: true,
            reconnectDelayMs: 4000,
            onContactsUpsert: (contacts) => {
                void handleContactsUpsert(contacts, account.id, gateway).catch((err) => {
                    logChatCore('contacts_upsert_error', { error: String(err?.message || err), accountId: account.id });
                });
            },
            onInboundMessage: async (payload) => {
                const isOutbound = Boolean(payload?.fromMe);
                await persistInboundWhatsAppMessage({
                    fromNumber: payload?.fromNumber,
                    body: payload?.body,
                    waId: payload?.waId,
                    rawType: payload?.rawType || 'unknown',
                    direction: isOutbound ? 'outbound' : 'inbound',
                    preferredName: isOutbound ? '' : (payload?.pushName || ''),
                    mediaKind: payload?.mediaKind || '',
                    mediaPath: payload?.mediaPath || '',
                    mediaMimeType: payload?.mediaMimeType || '',
                    mediaFileName: payload?.mediaFileName || '',
                    mediaSize: payload?.mediaSize ?? null,
                    mediaProvider: payload?.mediaProvider || 'baileys',
                    accountId: account.id,
                    mediaRemoteId: payload?.mediaRemoteId || '',
                    mediaRemoteUrl: payload?.mediaRemoteUrl || '',
                    mediaMeta: payload?.mediaMeta || null,
                });
            },
            onLog: (stage, payload) => {
                logChatCore(stage, {
                    accountId: account.id,
                    ...payload,
                });
            },
        });
        baileysGateways.set(account.id, gateway);
    });

    baileysGateway = getBaileysGatewayForAccount(ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID).gateway || null;

    BAILEYS_ACCOUNT_CONFIGS.forEach((account) => {
        if (!account.autoStart) return;
        void connectWhatsAppProvider({ accountId: account.id }).catch((error) => {
            logChatCore('baileys_startup_error', {
                accountId: account.id,
                error: String(error?.message || error),
            });
        });
    });
}

const { hasEmailProvider, sendEmailDocumentLink } = createEmailService({
    axios,
    nodemailer: require('nodemailer'),
    SMTP_HOST,
    SMTP_PORT,
    SMTP_TLS,
    SMTP_USERNAME,
    SMTP_PASSWORD,
    SMTP_FROM_EMAIL,
    SMTP_FROM_NAME,
    RESEND_API_KEY,
    RESEND_FROM,
});

function normalizeRole(rawValue) {
    const value = String(rawValue || '').toLowerCase();
    if (
        value.includes('admin') ||
        value.includes('gestor') ||
        value.includes('manager') ||
        value.includes('owner')
    ) {
        return 'ADMIN';
    }
    return 'AGENT';
}

function normalizeCustomerType(rawValue) {
    const value = String(rawValue || '').toLowerCase();
    if (value.includes('forn') || value.includes('supplier')) return CUSTOMER_TYPES.SUPPLIER;
    if (value.includes('part') || value.includes('private')) return CUSTOMER_TYPES.PRIVATE;
    if (value.includes('public') || value.includes('servi')) return CUSTOMER_TYPES.PUBLIC_SERVICE;
    if (value.includes('spam')) return CUSTOMER_TYPES.SPAM;
    if (
        value.includes('indep') ||
        value.includes('individual') ||
        value.includes('eni') ||
        value.includes('nome individual')
    ) {
        return CUSTOMER_TYPES.INDEPENDENT;
    }
    if (value.includes('outro') || value.includes('other')) return CUSTOMER_TYPES.OTHER;
    return CUSTOMER_TYPES.ENTERPRISE;
}

const {
    sanitizeTableName,
    fetchSupabaseTable,
    fetchSupabaseTableSince,
    fetchSupabaseTableWithFilters,
    fetchSupabaseTableSample,
    pickExistingColumn,
    patchSupabaseTable,
    fetchSupabaseOpenApiSchema,
    fetchSupabaseTableNamesFromOpenApi,
    resolveSupabaseTableName,
    parseTableColumnsFromOpenApi,
    fetchSupabaseTableColumns,
    pickColumnByCandidates,
    buildPayloadWithExistingColumns,
    patchSupabaseTableWithFilters,
    insertSupabaseRow,
    upsertSupabaseRow,
} = createSupabaseClient({
    axios,
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
});

async function getSyncStateValue(key) {
    const row = await dbGetAsync(
        `SELECT value
         FROM sync_state
         WHERE key = ?
         LIMIT 1`,
        [String(key || '').trim()]
    );
    return String(row?.value || '').trim();
}

async function setSyncStateValue(key, value) {
    await dbRunAsync(
        `INSERT INTO sync_state (key, value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = CURRENT_TIMESTAMP`,
        [String(key || '').trim(), String(value || '').trim()]
    );
}

const RECOLHAS_ESTADO_FALLBACK_COLUMNS = [
    'id',
    'cliente_id',
    'obrigacao_modelo_id',
    'nif',
    'obrigacao_nome',
    'ano',
    'mes',
    'trimestre',
    'data_entrega',
    'created_by',
    'created_at',
    'updated_at',
];


// --- Conversation Repository (extracted) ---
const {
    normalizeConversationStatus,
    sanitizeConversationId,
    normalizeLocalSqlConversation,
    getAllLocalConversations,
    getLocalConversationById,
    getLocalConversationByCustomerId,
    upsertLocalConversation,
    resolveConversationAccountId,
    hasDifferentCustomerNamesForPhone,
    resolveOutboundAccountIdForPhone,
    setConversationWhatsAppAccount,
    findLocalCustomerByPhone,
    ensureCustomerForPhone,
    ensureConversationForPhone,
    writeAuditLog,
    normalizeTemplateKind,
    normalizeLocalTemplate,
    getLocalTemplates,
    upsertLocalTemplate,
    applyTemplateVariables,
    enqueueOutboundMessage,
} = createConversationRepository({
    dbAllAsync,
    dbGetAsync,
    dbRunAsync,
    normalizePhone,
    normalizeDigits,
    normalizeBoolean,
    normalizeLocalSqlCustomer,
    sanitizeIdPart,
    isBaileysProviderEnabled,
    BAILEYS_ACCOUNTS_BY_ID,
    ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID,
    ACTIVE_BAILEYS_NAME_CONFLICT_ACCOUNT_ID,
    logChatCore,
    nowIso,
    getLocalCustomerById,
    upsertLocalCustomer,
    parseContactsArray,
    CUSTOMER_TYPES,
    normalizeCustomerType,
});

// --- Message Service (extracted) ---
const {
    handleInboundAutomationReply,
    persistInboundWhatsAppMessage,
    moveQueueToDeadLetter,
    markQueueAsFailed,
    processQueueJobViaBaileys,
    processQueueJob,
} = createMessageService({
    db,
    dbRunAsync,
    dbGetAsync,
    dbAllAsync,
    ENABLE_WEBHOOK_AUTOREPLY,
    ACTIVE_WHATSAPP_PROVIDER,
    MAX_QUEUE_RETRIES,
    sendWhatsAppTextMessage,
    sendWhatsAppMenuMessage,
    isBlockedContact,
    emitChatEvent,
    logChatCore,
    nowIso,
    resolveConversationAccountId,
    ensureConversationForPhone,
    writeAuditLog,
    mobilePushService,
    pickBaileysGatewayForOutbound,
    resolveOutboundAccountIdForPhone,
});

// --- SAFT Service (extracted) ---
const {
    sanitizeDocumentFileName,
    mapWindowsFolderToLinuxMount,
    resolveCustomerDocumentsFolder,
    resolveSaftBunkerFolder,
    ensureWritableSaftBunkerFolder,
    buildBunkerFileName,
    getCachedSaftDocument,
    upsertSaftDocumentCache,
    normalizeSaftDocumentType,
    saftDocumentLabel,
    getSaftSearchTokens,
    findLatestDocumentMatch,
    findDocumentMatches,
    extractYearFromFileName,
    selectModelo22Files,
    runSaftRobotFetch,
    runSaftDossierMetadata,
    findLocalCustomerRowByNifOrCompany,
    normalizeSupabaseCustomerCandidate,
    loadSupabaseCustomerLookup,
    materializeLocalCustomerFromSupabase,
    findCustomerRowForObrigacao,
    resolveSupabaseCustomerIdFromLocalRow,
    upsertLocalObrigacaoRecolha,
    markLocalObrigacaoRecolhaSynced,
    resolveObrigacaoModeloRow,
    syncRecolhaEstadoSupabase,
    updateObrigacaoPeriodoSupabase,
    resolveObrigacoesPeriodTableName,
    loadLocalCollectedSets,
    loadSupabaseCollectedSourceIds,
} = createSaftService({
    fs,
    path,
    spawn,
    dbGetAsync,
    dbRunAsync,
    dbAllAsync,
    axios,
    nowIso,
    sanitizeIdPart,
    normalizePhone,
    normalizeDigits,
    normalizeCustomerType,
    normalizeLookupText,
    pickFirstValue,
    extractManagersFromRawRow,
    parseAgregadoFamiliarArray,
    parseFichasRelacionadasArray,
    extractAccessCredentialsFromRawRow,
    upsertLocalCustomer,
    parseCustomerSourceId,
    normalizeCustomerNif,
    fetchSupabaseTable,
    fetchSupabaseTableColumns,
    fetchSupabaseTableWithFilters,
    upsertSupabaseRow,
    patchSupabaseTableWithFilters,
    insertSupabaseRow,
    resolveSupabaseTableName,
    pickColumnByCandidates,
    buildPayloadWithExistingColumns,
    normalizeIntValue,
    parseDatePtToIso,
    classifyObrigacaoEstado,
    baseDir: __dirname,
    SAFT_EMAIL,
    SAFT_PASSWORD,
    SAFT_ROBOT_SCRIPT,
    SAFT_BUNKER_ROOT,
    SAFT_BUNKER_FALLBACK_ROOT,
    LOCAL_DOCS_ROOT,
    DOCS_WINDOWS_PREFIX,
    DOCS_LINUX_MOUNT,
    SUPABASE_URL,
    SUPABASE_KEY,
    SUPABASE_CLIENTS_SOURCE,
    SUPABASE_CLIENTS_UPDATED_AT_COLUMN,
    SUPABASE_RECOLHAS_ESCOLHA,
    SUPABASE_OBRIGACOES_PERIODOS_PREFIX,
    RECOLHAS_ESTADO_FALLBACK_COLUMNS,
});

const {
    runSaftObrigacoesRobot,
    runGoffObrigacoesRobot,
    runGoffObrigacoesRobotSaft,
    runGoffObrigacoesRobotIva,
    runGoffObrigacoesRobotDmrAt,
    runGoffObrigacoesRobotDmrSs,
    runGoffObrigacoesRobotM22,
    runGoffObrigacoesRobotIes,
    runGoffObrigacoesRobotM10,
    runGoffObrigacoesRobotRelatorioUnico,
    runGoffObrigacoesRobotInventario,
    runSaftObrigacoesRobotDri,
    runSaftObrigacoesRobotDmr,
    runSaftObrigacoesRobotSaft,
    runSaftObrigacoesRobotIva,
    runSaftObrigacoesRobotM22,
    runSaftObrigacoesRobotIes,
    runSaftObrigacoesRobotM10,
    runSaftObrigacoesRobotRelatorioUnico,
} = createRobotService({
    fs,
    path,
    spawn,
    baseDir: __dirname,
    saftEmail: SAFT_EMAIL,
    saftPassword: SAFT_PASSWORD,
    goffEmail: GOFF_EMAIL,
    goffPassword: GOFF_PASSWORD,
    saftObrigacoesRobotScript: SAFT_OBRIGACOES_ROBOT_SCRIPT,
    goffObrigacoesRobotScript: GOFF_OBRIGACOES_ROBOT_SCRIPT,
});

function normalizeUsers(rows) {
    const users = [];
    const bySourceId = new Map();
    const byEmail = new Map();
    const byName = new Map();

    rows.forEach((row, index) => {
        const sourceId = pickFirstValue(row, ['id', 'user_id', 'funcionario_id', 'uuid']);
        const id = `ext_u_${sanitizeIdPart(sourceId, String(index + 1))}`;
        const name =
            String(pickFirstValue(row, ['name', 'nome', 'full_name', 'funcionario', 'display_name']) || '').trim() ||
            `Funcionário ${index + 1}`;
        const email = String(pickFirstValue(row, ['email', 'mail', 'user_email']) || '').trim().toLowerCase() || `${id}@local.invalid`;
        const role = normalizeRole(pickFirstValue(row, ['role', 'cargo', 'perfil', 'tipo']));
        const avatarUrl = String(pickFirstValue(row, ['avatar_url', 'avatar', 'foto', 'image_url']) || '').trim() || DEFAULT_AVATAR;
        const password = String(pickFirstValue(row, ['password', 'senha', 'pin', 'passcode']) || '').trim();
        const isAiAssistant = normalizeBoolean(
            pickFirstValue(row, ['is_ai_assistant', 'ia_assistente', 'assistant_ai', 'ai_assistant']),
            false
        );
        const aiAllowedSites = parseJsonArray(
            pickFirstValue(row, ['ai_allowed_sites_json', 'ai_allowed_sites', 'ia_sites', 'sites_ia'])
        )
            .map((site) => String(site || '').trim())
            .filter(Boolean);

        const normalizedUser = {
            id,
            name,
            email,
            role,
            avatarUrl,
            password: password || undefined,
            isAiAssistant,
            aiAllowedSites,
        };
        users.push(normalizedUser);

        bySourceId.set(String(sourceId || '').trim(), id);
        byEmail.set(email, id);
        byName.set(name.toLowerCase(), id);
    });

    return { users, bySourceId, byEmail, byName };
}

function resolveOwnerId(row, userMaps) {
    const ownerSource = String(
        pickFirstValue(row, [
            'owner_id',
            'funcionario_id',
            'responsavel_id',
            'responsavel_interno_id',
            'contabilista_id',
            'resp_contabilidade',
            'resp_salarios',
            'resp_saft',
            'resp_administrativo',
            'user_id',
            'assigned_to',
        ])
    ).trim();
    if (ownerSource && userMaps.bySourceId.has(ownerSource)) {
        return userMaps.bySourceId.get(ownerSource);
    }

    const ownerEmail = String(
        pickFirstValue(row, [
            'owner_email',
            'responsavel_email',
            'funcionario_email',
            'email_responsavel',
            'resp_contabilidade_email',
            'resp_salarios_email',
            'resp_saft_email',
            'resp_administrativo_email',
        ])
    ).trim().toLowerCase();
    if (ownerEmail && userMaps.byEmail.has(ownerEmail)) {
        return userMaps.byEmail.get(ownerEmail);
    }

    const ownerName = String(
        pickFirstValue(row, [
            'owner_name',
            'responsavel_nome',
            'funcionario_nome',
            'responsavel',
            'resp_contabilidade_nome',
            'resp_salarios_nome',
            'resp_saft_nome',
            'resp_administrativo_nome',
        ])
    ).trim().toLowerCase();
    if (ownerName && userMaps.byName.has(ownerName)) {
        return userMaps.byName.get(ownerName);
    }

    return null;
}

function normalizeCustomers(rows, userMaps) {
    const customers = [];

    rows.forEach((row, index) => {
        const sourceId = pickFirstValue(row, ['id', 'cliente_id', 'uuid']);
        const id = `ext_c_${sanitizeIdPart(sourceId, String(index + 1))}`;
        const name = String(pickFirstValue(row, ['name', 'nome', 'cliente', 'full_name']) || '').trim();
        const company = String(pickFirstValue(row, ['company', 'empresa', 'organization', 'entidade']) || '').trim();
        const phone = normalizePhone(
            pickFirstValue(row, ['phone', 'telefone', 'telemovel', 'celular', 'whatsapp', 'numero', 'contacto'])
        );

        if (!name && !phone) {
            return;
        }

        const contactName = String(pickFirstValue(row, ['contact_name', 'nome_contacto', 'contacto_nome']) || '').trim();
        const contactPhone = normalizePhone(
            pickFirstValue(row, ['contact_phone', 'telefone_contacto', 'contacto_telefone'])
        );

        const contacts = [];
        if (contactName || contactPhone) {
            contacts.push({
                name: contactName || 'Contacto',
                phone: contactPhone || phone,
            });
        }

        const email = String(pickFirstValue(row, ['email', 'mail']) || '').trim().toLowerCase();
        const documentsFolder = String(
            pickFirstValue(row, ['documents_folder', 'pasta_documentos', 'document_folder', 'docs_folder'])
        ).trim();
        const nif = String(
            pickFirstValue(row, ['nif', 'vat', 'tax_id', 'numero_contribuinte', 'contribuinte'])
        ).trim();
        const niss = String(
            pickFirstValue(row, ['niss', 'numero_seguranca_social', 'seg_social_numero', 'social_security_number'])
        ).trim();
        const senhaFinancas = String(
            pickFirstValue(row, [
                'senha_financas',
                'senha_portal_financas',
                'password_financas',
                'financas_password',
                'portal_financas_password',
            ])
        ).trim();
        const senhaSegurancaSocial = String(
            pickFirstValue(row, [
                'senha_seguranca_social',
                'senha_seg_social',
                'password_seguranca_social',
                'password_seg_social',
                'seg_social_password',
            ])
        ).trim();
        const tipoIva = String(
            pickFirstValue(row, [
                'tipo_iva',
                'tipoiva',
                'iva_tipo',
                'regime_iva',
                'periodicidade_iva',
                'iva_periodicidade',
            ])
        ).trim();
        const morada = String(pickFirstValue(row, ['morada', 'address', 'endereco']) || '').trim();
        const notes = String(pickFirstValue(row, ['notes', 'notas', 'observacoes', 'obs']) || '').trim();
        const certidaoPermanenteNumero = String(
            pickFirstValue(row, ['certidao_permanente_numero', 'certidao_permanente_n', 'certidao_permanente'])
        ).trim();
        const certidaoPermanenteValidade = String(
            pickFirstValue(row, ['certidao_permanente_validade', 'validade_certidao_permanente'])
        ).trim();
        const rcbeNumero = String(pickFirstValue(row, ['rcbe_numero', 'rcbe_n', 'rcbe'])).trim();
        const rcbeData = String(pickFirstValue(row, ['rcbe_data'])).trim();
        const dataConstituicao = String(pickFirstValue(row, ['data_constituicao'])).trim();
        const inicioAtividade = String(pickFirstValue(row, ['inicio_atividade', 'data_inicio_atividade'])).trim();
        const caePrincipal = String(pickFirstValue(row, ['cae_principal', 'cae'])).trim();
        const codigoReparticaoFinancas = String(
            pickFirstValue(row, ['codigo_reparticao_financas', 'reparticao_financas'])
        ).trim();
        const tipoContabilidade = String(pickFirstValue(row, ['tipo_contabilidade'])).trim();
        const estadoCliente = String(pickFirstValue(row, ['estado_cliente', 'estado'])).trim();
        const contabilistaCertificado = String(
            pickFirstValue(row, ['contabilista_certificado_nome', 'contabilista_certificado'])
        ).trim();
        const managers = extractManagersFromRawRow(row);
        const accessCredentials = extractAccessCredentialsFromRawRow(row, {
            senhaFinancas,
            senhaSegurancaSocial,
        });
        const agregadoFamiliar = parseAgregadoFamiliarArray(
            pickFirstValue(row, ['agregado_familiar_json', 'agregadofamiliar_json', 'agregado_familiar'])
        );
        const fichasRelacionadas = parseFichasRelacionadasArray(
            pickFirstValue(row, ['fichas_relacionadas_json', 'fichasrelacionadas_json', 'fichas_relacionadas'])
        );
        const allowAutoResponses = normalizeBoolean(
            pickFirstValue(row, ['allow_auto_responses', 'allow_auto', 'auto_reply', 'resposta_automatica']),
            true
        );

        customers.push({
            id,
            name: name || company || phone || `Cliente ${index + 1}`,
            company: company || name || 'Sem empresa',
            contactName: contactName || undefined,
            phone: phone || '',
            email: email || undefined,
            ownerId: resolveOwnerId(row, userMaps),
            type: normalizeCustomerType(pickFirstValue(row, ['type', 'tipo', 'categoria', 'tipo_entidade'])),
            contacts,
            documentsFolder: documentsFolder || undefined,
            nif: nif || undefined,
            niss: niss || undefined,
            senhaFinancas: senhaFinancas || undefined,
            senhaSegurancaSocial: senhaSegurancaSocial || undefined,
            tipoIva: tipoIva || undefined,
            morada: morada || undefined,
            notes: notes || undefined,
            certidaoPermanenteNumero: certidaoPermanenteNumero || undefined,
            certidaoPermanenteValidade: certidaoPermanenteValidade || undefined,
            rcbeNumero: rcbeNumero || undefined,
            rcbeData: rcbeData || undefined,
            dataConstituicao: dataConstituicao || undefined,
            inicioAtividade: inicioAtividade || undefined,
            caePrincipal: caePrincipal || undefined,
            codigoReparticaoFinancas: codigoReparticaoFinancas || undefined,
            tipoContabilidade: tipoContabilidade || undefined,
            estadoCliente: estadoCliente || undefined,
            contabilistaCertificado: contabilistaCertificado || undefined,
            managers,
            accessCredentials,
            agregadoFamiliar,
            fichasRelacionadas,
            supabasePayload: row && typeof row === 'object' ? row : undefined,
            supabaseUpdatedAt: String(pickFirstValue(row, [SUPABASE_CLIENTS_UPDATED_AT_COLUMN, 'updated_at']) || '').trim() || undefined,
            allowAutoResponses,
        });
    });

    return customers;
}

async function seedDefaultTemplates() {
    try {
        const countRow = await dbGetAsync('SELECT COUNT(*) as total FROM message_templates');
        const total = Number(countRow?.total || 0);
        if (total > 0) return;

        await upsertLocalTemplate({
            id: 'tpl_boas_vindas',
            name: 'Boas-vindas',
            kind: 'template',
            content: 'Olá {{nome}}, obrigado pelo contacto. Em que podemos ajudar?',
            isActive: true,
        });
        await upsertLocalTemplate({
            id: 'tpl_retorno',
            name: 'Retomar Conversa',
            kind: 'template',
            content: 'Olá {{nome}}, podemos retomar este assunto agora?',
            isActive: true,
        });
        await upsertLocalTemplate({
            id: 'qr_documentos',
            name: 'Pedir Documentos',
            kind: 'quick_reply',
            content: 'Pode enviar os documentos por aqui, por favor?',
            isActive: true,
        });
    } catch (error) {
        console.error('[Templates] Erro ao fazer seed:', error?.message || error);
    }
}

const { processOutboundQueue, bootstrapQueueWorker } = createQueueWorker({
    dbAllAsync,
    dbRunAsync,
    processQueueJob,
    isProviderReady: () => baileysGateways.size > 0,
    onError: (error) => {
        console.error('[Queue] Erro no worker:', error?.message || error);
    },
    pollIntervalMs: 4000,
});

// --- Obrigacoes Worker (extracted) ---
const {
    obrigacoesAutoState,
    processPendingSaftJobs,
    bootstrapSaftWorker,
    runObrigacoesAutoCollection,
    scheduleNextObrigacoesAutoRun,
    bootstrapObrigacoesAutoScheduler,
} = createObrigacoesWorker({
    axios,
    dbAllAsync,
    nowIso,
    writeAuditLog,
    resolveShiftedYearMonth,
    computeNextDailyRunAt,
    OBRIGACOES_AUTO_ENABLED,
    OBRIGACOES_AUTO_HOUR,
    OBRIGACOES_AUTO_MINUTE,
    OBRIGACOES_AUTO_TIMEZONE,
});


let customersAutoPullRunning = false;
let customersAutoPullBootstrapped = false;
let customersAutoPullTimer = null;
const customersAutoPullState = {
    enabled: CUSTOMERS_AUTO_PULL_ENABLED,
    intervalMinutes: CUSTOMERS_AUTO_PULL_INTERVAL_MINUTES,
    startupDelaySeconds: CUSTOMERS_AUTO_PULL_STARTUP_DELAY_SECONDS,
    running: false,
    lastRunAt: null,
    lastFinishedAt: null,
    nextRunAt: null,
    lastSummary: null,
    lastError: null,
};

async function runCustomersAutoPull(localPort, options = {}) {
    if (customersAutoPullRunning) return null;
    if (!SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_CLIENTS_SOURCE) {
        customersAutoPullState.lastError = 'Supabase clientes não configurado.';
        return null;
    }

    const full = !!options.full;
    const limit = Number(options.limit || 5000);

    customersAutoPullRunning = true;
    customersAutoPullState.running = true;
    customersAutoPullState.lastRunAt = nowIso();
    customersAutoPullState.lastError = null;

    try {
        const response = await axios({
            method: 'POST',
            url: `http://127.0.0.1:${localPort}/api/customers/sync/pull`,
            headers: { 'Content-Type': 'application/json' },
            data: { full, limit },
            timeout: 5 * 60 * 1000,
            validateStatus: () => true,
        });
        const payload = response?.data || {};
        const success = response.status >= 200 && response.status < 300 && payload?.success === true;

        const summary = {
            startedAt: customersAutoPullState.lastRunAt,
            finishedAt: nowIso(),
            statusCode: response.status,
            success,
            full,
            limit,
            result: payload,
            error: success ? null : (payload?.error || `HTTP ${response.status}`),
        };

        customersAutoPullState.lastSummary = summary;
        if (!success) {
            customersAutoPullState.lastError = String(summary.error || 'Falha na sincronização automática de clientes.');
            return summary;
        }

        await writeAuditLog({
            actorUserId: null,
            entityType: 'customers_auto_sync',
            entityId: summary.startedAt,
            action: 'completed',
            details: summary,
        });
        return summary;
    } catch (error) {
        const details = String(error?.message || error);
        customersAutoPullState.lastError = details;
        const summary = {
            startedAt: customersAutoPullState.lastRunAt,
            finishedAt: nowIso(),
            statusCode: null,
            success: false,
            full,
            limit,
            result: null,
            error: details,
        };
        customersAutoPullState.lastSummary = summary;
        await writeAuditLog({
            actorUserId: null,
            entityType: 'customers_auto_sync',
            entityId: summary.startedAt,
            action: 'failed',
            details: summary,
        });
        return summary;
    } finally {
        customersAutoPullRunning = false;
        customersAutoPullState.running = false;
        customersAutoPullState.lastFinishedAt = nowIso();
    }
}

function scheduleNextCustomersAutoPull(localPort, delayMs = null) {
    if (!CUSTOMERS_AUTO_PULL_ENABLED) return;
    if (customersAutoPullTimer) {
        clearTimeout(customersAutoPullTimer);
        customersAutoPullTimer = null;
    }

    const intervalMs = Math.max(60 * 1000, Number(CUSTOMERS_AUTO_PULL_INTERVAL_MINUTES || 15) * 60 * 1000);
    const hasCustomDelay = delayMs !== null && delayMs !== undefined && String(delayMs).trim() !== '';
    const waitMs = hasCustomDelay && Number.isFinite(Number(delayMs))
        ? Math.max(1000, Number(delayMs))
        : intervalMs;
    const nextRun = new Date(Date.now() + waitMs);
    customersAutoPullState.nextRunAt = nextRun.toISOString();

    console.log(
        `[Auto Clientes] Próxima sincronização incremental em ${Math.round(waitMs / 1000)}s (${nextRun.toISOString()})`
    );

    customersAutoPullTimer = setTimeout(async () => {
        try {
            const summary = await runCustomersAutoPull(localPort, { full: false, limit: 5000 });
            if (summary?.success) {
                const synced = Number(summary?.result?.synced || 0);
                const fetched = Number(summary?.result?.fetched || 0);
                console.log(`[Auto Clientes] Concluído. Sincronizados=${synced} | Lidos=${fetched}`);
            } else if (summary) {
                console.warn(`[Auto Clientes] Falha: ${summary.error || 'erro desconhecido'}`);
            }
        } catch (error) {
            customersAutoPullState.lastError = String(error?.message || error);
            console.error('[Auto Clientes] Falha no agendamento:', error?.message || error);
        } finally {
            scheduleNextCustomersAutoPull(localPort);
        }
    }, waitMs);
}

function bootstrapCustomersAutoPullScheduler(localPort) {
    if (customersAutoPullBootstrapped) return;
    customersAutoPullBootstrapped = true;

    if (!CUSTOMERS_AUTO_PULL_ENABLED) {
        console.log('[Auto Clientes] Scheduler desativado (CUSTOMERS_AUTO_PULL_ENABLED=false).');
        return;
    }
    if (!SUPABASE_URL || !SUPABASE_KEY || !SUPABASE_CLIENTS_SOURCE) {
        console.log('[Auto Clientes] Scheduler não iniciado: Supabase clientes não configurado.');
        return;
    }

    const startupDelayMs = Math.max(0, Number(CUSTOMERS_AUTO_PULL_STARTUP_DELAY_SECONDS || 20) * 1000);
    scheduleNextCustomersAutoPull(localPort, startupDelayMs);
}

async function bootstrapConversationsFromMessages() {
    try {
        const [countRow] = await dbAllAsync('SELECT COUNT(*) as total FROM conversations');
        const totalConversations = Number(countRow?.total || 0);
        if (totalConversations > 0) return;

        const rows = await dbAllAsync(
            `SELECT from_number, MAX(timestamp) as last_ts
             FROM messages
             GROUP BY from_number
             ORDER BY datetime(last_ts) DESC`
        );

        for (const row of rows) {
            await ensureConversationForPhone(String(row.from_number || ''), {
                status: 'open',
                unreadCount: 0,
                lastMessageAt: String(row.last_ts || nowIso()),
            });
        }

        if (rows.length > 0) {
            console.log(`[Bootstrap] Conversas criadas a partir do histórico: ${rows.length}`);
        }
    } catch (error) {
        console.error('[Bootstrap] Erro ao criar conversas do histórico:', error?.message || error);
    }
}

console.log("--- Diagnóstico de Arranque ---");
console.log("WhatsApp Provider:", ACTIVE_WHATSAPP_PROVIDER);
console.log(
    "Baileys Contas:",
    BAILEYS_ACCOUNT_CONFIGS.map((account) =>
        `${account.id}${account.id === ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID ? ' (default)' : ''} -> ${account.authDir}`
    ).join(' | ')
);
console.log("Supabase:", SUPABASE_URL ? "Configurado (URL OK)" : "Não configurado");
console.log("APP_ROLE:", APP_ROLE || 'all');
console.log("-------------------------------");

if (IS_CHAT_CORE_ONLY) {
    app.use((req, res, next) => {
        if (isChatCorePath(req.path)) {
            return next();
        }
        return res.status(404).json({
            success: false,
            error: 'Endpoint indisponível neste processo (chat_core).',
        });
    });
}

if (IS_BACKOFFICE_ONLY) {
    app.use((req, res, next) => {
        if (!isChatCorePath(req.path)) {
            return next();
        }
        void proxyToChatCore(req, res);
    });
}

// --- 3. Rotas da API ---

registerImportRoutes({
    app,
    SUPABASE_URL,
    SUPABASE_KEY,
    SUPABASE_FUNCIONARIOS_SOURCE,
    SUPABASE_CLIENTS_SOURCE,
    getAllLocalUsers,
    getAllLocalCustomers,
    fetchSupabaseTable,
    normalizeUsers,
    normalizeCustomers,
    mergeUsersWithLocalOverrides,
    mergeCustomersWithLocalOverrides,
});

registerImportObrigacoesRoutes({
    app,
    axios,
    DRI_OBRIGACAO_ID,
    DMR_OBRIGACAO_ID,
    SAFT_OBRIGACAO_ID,
    IVA_OBRIGACAO_ID_MENSAL,
    IVA_OBRIGACAO_ID_TRIMESTRAL,
    M22_OBRIGACAO_ID,
    IES_OBRIGACAO_ID,
    M10_OBRIGACAO_ID,
    INVENTARIO_OBRIGACAO_ID,
    RELATORIO_UNICO_OBRIGACAO_ID,
    SUPABASE_URL,
    SUPABASE_KEY,
    SUPABASE_OBRIGACOES_MODELO,
    SUPABASE_CLIENTS_SOURCE,
    PORT,
    normalizeBoolean,
    normalizeIntValue,
    resolveMonthYear,
    nowIso,
    runGoffObrigacoesRobotDmrSs,
    runSaftObrigacoesRobotDri,
    fetchSupabaseTable,
    resolveObrigacaoModeloRow,
    pickFirstValue,
    normalizeIvaPeriodicidade,
    resolveObrigacaoPeriod,
    loadSupabaseCustomerLookup,
    findCustomerRowForObrigacao,
    resolveSupabaseCustomerIdFromLocalRow,
    loadLocalCollectedSets,
    loadSupabaseCollectedSourceIds,
    upsertLocalObrigacaoRecolha,
    syncRecolhaEstadoSupabase,
    updateObrigacaoPeriodoSupabase,
    markLocalObrigacaoRecolhaSynced,
    writeAuditLog,
    classifyDriCmpEnvStatus,
    classifyDmrProcessadoCertaStatus,
    classifySaftEnviadoStatus,
    classifyGoffSaftStatus,
    classifyGoffIvaStatus,
    classifyIvaProcessadoStatus,
    classifyM22ProcessadoStatus,
    classifyRelatorioUnicoStatus,
    normalizeDigits,
    parseDatePtToIso,
    parseIvaPeriodFromValue,
    normalizeLookupText,
    createIvaJobId,
    setIvaImportJob,
    ivaImportJobs,
    runSaftObrigacoesRobotDmr,
    runSaftObrigacoesRobotSaft,
    runGoffObrigacoesRobotSaft,
    runGoffObrigacoesRobotDmrAt,
    runGoffObrigacoesRobotIva,
    runGoffObrigacoesRobotM22,
    runGoffObrigacoesRobotIes,
    runGoffObrigacoesRobotM10,
    runGoffObrigacoesRobotInventario,
    runGoffObrigacoesRobotRelatorioUnico,
    runSaftObrigacoesRobotIva,
    runSaftObrigacoesRobotM22,
    runSaftObrigacoesRobotIes,
    runSaftObrigacoesRobotM10,
    runSaftObrigacoesRobotRelatorioUnico,
    materializeLocalCustomerFromSupabase,
});

registerLocalSyncSaftRoutes({
    app,
    db,
    dbRunAsync,
    dbGetAsync,
    dbAllAsync,
    SUPABASE_URL,
    SUPABASE_KEY,
    SUPABASE_CLIENTS_SOURCE,
    SUPABASE_CLIENTS_UPDATED_AT_COLUMN,
    API_PUBLIC_BASE_URL,
    SMTP_CC_FALLBACK,
    parseSourceId,
    sanitizeRoleValue,
    upsertLocalUser,
    writeAuditLog,
    parseCustomerSourceId,
    parseAgregadoFamiliarArray,
    parseFichasRelacionadasArray,
    upsertLocalCustomer,
    fetchSupabaseTable,
    fetchSupabaseTableColumns,
    fetchSupabaseTableWithFilters,
    upsertSupabaseRow,
    patchSupabaseTableWithFilters,
    getSyncStateValue,
    setSyncStateValue,
    fetchSupabaseTableSince,
    normalizeSupabaseCustomerCandidate,
    resolveCustomerDocumentsFolder,
    fs,
    path,
    sanitizeDocumentFileName,
    getLocalCustomerById,
    ensureWritableSaftBunkerFolder,
    getSaftSearchTokens,
    getCachedSaftDocument,
    upsertSaftDocumentCache,
    buildBunkerFileName,
    nowIso,
    findDocumentMatches,
    selectModelo22Files,
    runSaftRobotFetch,
    runSaftDossierMetadata,
    normalizeSaftDocumentType,
    saftDocumentLabel,
    sendWhatsAppDocumentLink,
    hasEmailProvider,
    sendEmailDocumentLink,
});

registerLocalDataRoutes({
    app,
    dbRunAsync,
    dbGetAsync,
    dbAllAsync,
    writeAuditLog,
    getLocalTasks,
    upsertLocalTask,
    getLocalCalls,
    upsertLocalCall,
    getAllLocalConversations,
    upsertLocalConversation,
    getLocalTemplates,
    upsertLocalTemplate,
    SUPABASE_URL,
    SUPABASE_KEY,
    SUPABASE_TAREFAS_SOURCE,
    SUPABASE_FUNCIONARIOS_SOURCE,
    SUPABASE_CLIENTS_SOURCE,
    fetchSupabaseTable,
    fetchSupabaseTableWithFilters,
    resolveSupabaseTableName,
    normalizeDigits,
    normalizeLookupText,
    parseSourceId,
    parseCustomerSourceId,
    nowIso,
});

registerOccurrencesRoutes({
    app,
    dbRunAsync,
    dbGetAsync,
    dbAllAsync,
    writeAuditLog,
    SUPABASE_URL,
    SUPABASE_KEY,
    SUPABASE_OCORRENCIAS_SOURCE,
    SUPABASE_OCORRENCIAS_FOTOS_SOURCE,
    SUPABASE_OCORRENCIAS_DOCUMENTOS_SOURCE,
    SUPABASE_TIPOS_OCORRENCIA_SOURCE,
    SUPABASE_CLIENTS_SOURCE,
    SUPABASE_FUNCIONARIOS_SOURCE,
    fetchSupabaseTable,
    resolveSupabaseTableName,
    normalizeDigits,
    nowIso,
    resolveCustomerDocumentsFolder,
    sanitizeDocumentFileName,
});

registerObrigacoesAutoRoutes({
    app,
    getSchedulerConfig: () => ({
        enabled: OBRIGACOES_AUTO_ENABLED,
        hour: OBRIGACOES_AUTO_HOUR,
        minute: OBRIGACOES_AUTO_MINUTE,
        timezone: OBRIGACOES_AUTO_TIMEZONE || null,
    }),
    getState: () => obrigacoesAutoState,
    isRunning: () => obrigacoesAutoState.running,
    runNow: async () => {
        const localPort = Number(process.env.PORT || PORT || 3000);
        const summary = await runObrigacoesAutoCollection(localPort);
        obrigacoesAutoState.lastSummary = summary;
        return summary;
    },
});

app.get('/api/customers/sync/auto/status', async (req, res) => {
    return res.json({
        success: true,
        scheduler: {
            enabled: CUSTOMERS_AUTO_PULL_ENABLED,
            intervalMinutes: CUSTOMERS_AUTO_PULL_INTERVAL_MINUTES,
            startupDelaySeconds: CUSTOMERS_AUTO_PULL_STARTUP_DELAY_SECONDS,
        },
        state: customersAutoPullState,
    });
});

app.post('/api/customers/sync/auto/run', async (req, res) => {
    if (customersAutoPullRunning) {
        return res.status(409).json({
            success: false,
            error: 'Sincronização automática de clientes já está em execução.',
            state: customersAutoPullState,
        });
    }

    const body = req.body || {};
    const summary = await runCustomersAutoPull(Number(process.env.PORT || PORT || 3000), {
        full: !!body.full,
        limit: Number(body.limit || 5000),
    });

    return res.json({
        success: !!summary?.success,
        summary,
        state: customersAutoPullState,
    });
});

registerMobileRoutes({
    app,
    dbRunAsync,
    dbAllAsync,
    sendMobilePushNotification: (payload) => mobilePushService.sendNotificationToActiveDevices(payload),
});

registerDesktopRoutes({
    app,
    path,
    baseDir: __dirname,
});

if (!IS_BACKOFFICE_ONLY) {
    registerChatCoreRoutes(app, {
        db,
        VERIFY_TOKEN,
        ENABLE_WEBHOOK_AUTOREPLY,
        whatsappProvider: ACTIVE_WHATSAPP_PROVIDER,
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
        listBlockedContacts,
        upsertBlockedContact,
        removeBlockedContact,
        isBlockedContact,
        chatEvents,
        emitChatEvent,
        logChatCore,
        sendMobilePushNotification: (payload) => mobilePushService.sendInboundMessageNotification(payload),
        fetchAvatarOnDemand: typeof fetchAvatarOnDemand === 'function' ? fetchAvatarOnDemand : null,
        downloadInboundMediaStream: typeof downloadInboundMediaStream === 'function' ? downloadInboundMediaStream : null,
    });
}

if (!IS_CHAT_CORE_ONLY) {
    registerFrontendRoutes({
        app,
        express,
        path,
        baseDir: __dirname,
    });
}

startServerLifecycle({
    app,
    port: PORT,
    dbReadyPromise,
    isBackofficeOnly: IS_BACKOFFICE_ONLY,
    isChatCoreOnly: IS_CHAT_CORE_ONLY,
    appRole: APP_ROLE,
    seedDefaultTemplates,
    bootstrapConversationsFromMessages,
    bootstrapQueueWorker,
    processOutboundQueue,
    bootstrapSaftWorker,
    processPendingSaftJobs,
    bootstrapObrigacoesAutoScheduler,
    bootstrapCustomersAutoPullScheduler,
});
