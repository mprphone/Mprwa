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
const nodemailer = require('nodemailer');
const { createBaileysGateway } = require('./src/server/services/baileysGateway');
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
const { app, express } = createApp();

// --- 1. Banco de Dados Minimalista (SQLite) ---
const dbPath = path.resolve(process.env.WA_DB_PATH || path.join(process.cwd(), 'whatsapp.db'));
const db = openDatabase(dbPath);
const { dbRunAsync, dbGetAsync, dbAllAsync, dbExecAsync } = createDbHelpers(db);

const CUSTOMER_SECRET_PREFIX = 'enc:v1:';
const CUSTOMER_SECRET_MIGRATION_STATE_KEY = 'customers_secret_encryption_v1';
const CUSTOMER_SECRET_ALGORITHM = 'aes-256-gcm';
let customerSecretsKeyCache = null;
let customerSecretsNoKeyWarningShown = false;

function resolveCustomerSecretsRawKey() {
    const raw = String(
        process.env.CUSTOMER_SECRETS_KEY ||
            process.env.CUSTOMER_CREDENTIALS_KEY ||
            process.env.MPR_CUSTOMER_SECRETS_KEY ||
            process.env.SUPABASE_KEY ||
            process.env.VITE_SUPABASE_KEY ||
            ''
    ).trim();
    return raw;
}

function getCustomerSecretsKey() {
    if (customerSecretsKeyCache !== null) return customerSecretsKeyCache;
    const raw = resolveCustomerSecretsRawKey();
    if (!raw) {
        if (!customerSecretsNoKeyWarningShown) {
            customerSecretsNoKeyWarningShown = true;
            console.warn(
                '[Security] CUSTOMER_SECRETS_KEY não configurada. Cifragem local de credenciais desativada.'
            );
        }
        customerSecretsKeyCache = undefined;
        return customerSecretsKeyCache;
    }
    customerSecretsKeyCache = crypto.createHash('sha256').update(raw, 'utf8').digest();
    return customerSecretsKeyCache;
}

function isEncryptedCustomerSecret(value) {
    return String(value || '').trim().startsWith(CUSTOMER_SECRET_PREFIX);
}

function encryptCustomerSecret(value) {
    const plain = String(value || '').trim();
    if (!plain) return '';
    if (isEncryptedCustomerSecret(plain)) return plain;
    const key = getCustomerSecretsKey();
    if (!key) return plain;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(CUSTOMER_SECRET_ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CUSTOMER_SECRET_PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

function decryptCustomerSecret(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (!isEncryptedCustomerSecret(raw)) return raw;
    const key = getCustomerSecretsKey();
    if (!key) return '';

    const payload = raw.slice(CUSTOMER_SECRET_PREFIX.length);
    const parts = payload.split('.');
    if (parts.length !== 3) return '';
    const [ivB64, tagB64, dataB64] = parts;
    try {
        const iv = Buffer.from(ivB64, 'base64');
        const tag = Buffer.from(tagB64, 'base64');
        const ciphertext = Buffer.from(dataB64, 'base64');
        const decipher = crypto.createDecipheriv(CUSTOMER_SECRET_ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted.toString('utf8').trim();
    } catch (error) {
        console.warn('[Security] Falha ao descodificar credencial local cifrada:', error?.message || error);
        return '';
    }
}

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
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET,
    TELEGRAM_WEBHOOK_PATH,
    TELEGRAM_USER_API_ID,
    TELEGRAM_USER_API_HASH,
    TELEGRAM_USER_SESSION,
    TELEGRAM_USER_CHECK_INTERVAL_MS,
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
    if (path === '/webhook/telegram') return true;
    if (path.startsWith('/api/chat')) return true;
    if (path.startsWith('/api/telegram')) return true;
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
    const isBinaryRequest =
        req.path === '/api/chat/whatsapp/qr/image' ||
        req.path === '/api/whatsapp/qr/image' ||
        isMediaProxyRequest;
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

function normalizeLocalSqlUser(row) {
    if (!row) return null;

    const id = String(row.id || '').trim();
    const name = String(row.name || '').trim();
    const email = String(row.email || '').trim().toLowerCase();
    if (!id || !name || !email) return null;

    return {
        id,
        name,
        email,
        role: normalizeRole(row.role),
        avatarUrl: String(row.avatar_url || '').trim() || DEFAULT_AVATAR,
        password: String(row.password || '').trim() || undefined,
        isAiAssistant: normalizeBoolean(row.is_ai_assistant, false),
        aiAllowedSites: (() => {
            const parsed = parseJsonArray(row.ai_allowed_sites_json)
                .map((site) => String(site || '').trim())
                .filter(Boolean);
            return parsed;
        })(),
    };
}

function sanitizeRoleValue(value) {
    const normalized = normalizeRole(value);
    return normalized === 'ADMIN' ? 'ADMIN' : 'AGENT';
}

function sanitizeUserId(rawId, rawEmail) {
    const candidate = String(rawId || '').trim();
    if (candidate) return candidate;

    const emailSeed = String(rawEmail || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

    return emailSeed ? `local_u_${emailSeed}` : `local_u_${Date.now()}`;
}

function parseSourceId(userId, explicitSourceId) {
    const source = String(explicitSourceId || '').trim();
    if (source) return source;

    const id = String(userId || '').trim();
    if (id.startsWith('ext_u_')) return id.slice(6);
    return '';
}

async function getAllLocalUsers() {
    const rows = await dbAllAsync(
        `SELECT id, source_id, name, email, role, password, avatar_url, is_ai_assistant, ai_allowed_sites_json
         FROM users
         ORDER BY datetime(updated_at) DESC`
    );
    return rows.map(normalizeLocalSqlUser).filter(Boolean);
}

async function upsertLocalUser(userInput) {
    const incomingId = sanitizeUserId(userInput.id, userInput.email);
    const incomingSourceId = parseSourceId(incomingId, userInput.sourceId);
    const incomingEmail = String(userInput.email || '').trim().toLowerCase();
    const incomingName = String(userInput.name || '').trim();
    const incomingRole = sanitizeRoleValue(userInput.role);
    const incomingPassword = userInput.password === undefined ? undefined : String(userInput.password || '').trim();
    const incomingAvatar = String(userInput.avatarUrl || '').trim();
    const incomingIsAiAssistant =
        userInput.isAiAssistant === undefined ? undefined : normalizeBoolean(userInput.isAiAssistant, false);
    const incomingAiAllowedSites = Array.isArray(userInput.aiAllowedSites)
        ? userInput.aiAllowedSites.map((site) => String(site || '').trim()).filter(Boolean)
        : undefined;

    const existingById = incomingId
        ? await dbGetAsync('SELECT * FROM users WHERE id = ? LIMIT 1', [incomingId])
        : null;
    const existingByEmail =
        !existingById && incomingEmail
            ? await dbGetAsync('SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1', [incomingEmail])
            : null;
    const existingBySource =
        !existingById && !existingByEmail && incomingSourceId
            ? await dbGetAsync('SELECT * FROM users WHERE source_id = ? LIMIT 1', [incomingSourceId])
            : null;

    const existing = existingById || existingByEmail || existingBySource;

    const finalId = existing?.id || incomingId;
    const finalSourceId = incomingSourceId || String(existing?.source_id || '').trim();
    const finalEmail = incomingEmail || String(existing?.email || '').trim().toLowerCase();
    const finalName = incomingName || String(existing?.name || '').trim();
    const finalRole = sanitizeRoleValue(incomingRole || existing?.role || 'AGENT');
    const finalPassword = incomingPassword !== undefined ? incomingPassword : String(existing?.password || '').trim();
    const finalAvatar = incomingAvatar || String(existing?.avatar_url || '').trim() || DEFAULT_AVATAR;
    const finalIsAiAssistant =
        incomingIsAiAssistant !== undefined
            ? incomingIsAiAssistant
            : normalizeBoolean(existing?.is_ai_assistant, false);
    const finalAiAllowedSitesRaw =
        incomingAiAllowedSites !== undefined
            ? incomingAiAllowedSites
            : parseJsonArray(existing?.ai_allowed_sites_json).map((site) => String(site || '').trim()).filter(Boolean);
    const finalAiAllowedSites = Array.from(new Set(finalAiAllowedSitesRaw)).slice(0, 40);
    const finalAiAllowedSitesJson = finalAiAllowedSites.length > 0 ? JSON.stringify(finalAiAllowedSites) : null;

    if (!finalEmail || !finalName) {
        throw new Error('Nome e email são obrigatórios para guardar funcionário localmente.');
    }

    const duplicateByEmail = await dbGetAsync(
        `SELECT id, name
         FROM users
         WHERE lower(email) = lower(?)
           AND id <> ?
         LIMIT 1`,
        [finalEmail, finalId]
    );
    if (duplicateByEmail?.id) {
        const duplicateName = String(duplicateByEmail.name || '').trim() || String(duplicateByEmail.id || '').trim();
        throw new Error(`Já existe funcionário com este email (${finalEmail}) na ficha "${duplicateName}".`);
    }

    await dbRunAsync(
        `INSERT INTO users (id, source_id, name, email, role, password, avatar_url, is_ai_assistant, ai_allowed_sites_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           source_id = excluded.source_id,
           name = excluded.name,
           email = excluded.email,
           role = excluded.role,
           password = excluded.password,
           avatar_url = excluded.avatar_url,
           is_ai_assistant = excluded.is_ai_assistant,
           ai_allowed_sites_json = excluded.ai_allowed_sites_json,
           updated_at = CURRENT_TIMESTAMP`,
        [
            finalId,
            finalSourceId || null,
            finalName,
            finalEmail,
            finalRole,
            finalPassword,
            finalAvatar,
            finalIsAiAssistant ? 1 : 0,
            finalAiAllowedSitesJson,
        ]
    );

    const savedRow = await dbGetAsync('SELECT * FROM users WHERE id = ? LIMIT 1', [finalId]);
    return normalizeLocalSqlUser(savedRow);
}

function mergeUsersWithLocalOverrides(sourceUsers, localUsers) {
    if (!Array.isArray(sourceUsers) || sourceUsers.length === 0) {
        return Array.isArray(localUsers) ? [...localUsers] : [];
    }
    if (!Array.isArray(localUsers) || localUsers.length === 0) {
        return [...sourceUsers];
    }

    const merged = [];
    const usedLocalIndexes = new Set();

    sourceUsers.forEach((sourceUser) => {
        const sourceEmail = String(sourceUser.email || '').toLowerCase();
        const localIndex = localUsers.findIndex((localUser, idx) => {
            if (usedLocalIndexes.has(idx)) return false;
            if (localUser.id === sourceUser.id) return true;
            return !!sourceEmail && String(localUser.email || '').toLowerCase() === sourceEmail;
        });

        if (localIndex >= 0) {
            usedLocalIndexes.add(localIndex);
            merged.push({
                ...sourceUser,
                ...localUsers[localIndex],
                id: sourceUser.id,
            });
            return;
        }

        merged.push(sourceUser);
    });

    localUsers.forEach((localUser, idx) => {
        if (usedLocalIndexes.has(idx)) return;
        const exists = merged.some((user) => {
            if (user.id === localUser.id) return true;
            return String(user.email || '').toLowerCase() === String(localUser.email || '').toLowerCase();
        });
        if (!exists) merged.push(localUser);
    });

    return merged;
}

function sanitizeCustomerId(rawId, rawPhone) {
    const candidate = String(rawId || '').trim();
    if (candidate) return candidate;

    const phoneSeed = normalizePhone(String(rawPhone || ''))
        .replace('+', '')
        .trim();
    return phoneSeed ? `local_c_${phoneSeed}` : `local_c_${Date.now()}`;
}

function parseCustomerSourceId(customerId, explicitSourceId) {
    const source = String(explicitSourceId || '').trim();
    if (source) return source;

    const id = String(customerId || '').trim();
    if (id.startsWith('ext_c_')) return id.slice(6);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return id;
    return '';
}

function normalizeCustomerNif(value) {
    return normalizeDigits(String(value || '')).slice(-9);
}

function isValidPortugueseNif(value) {
    const nif = normalizeCustomerNif(value);
    if (!/^[0-9]{9}$/.test(nif)) return false;

    const firstDigit = Number(nif[0]);
    const allowedFirstDigits = new Set([1, 2, 3, 5, 6, 8, 9]);
    if (!allowedFirstDigits.has(firstDigit)) return false;

    let total = 0;
    for (let i = 0; i < 8; i += 1) {
        total += Number(nif[i]) * (9 - i);
    }
    const modulo = total % 11;
    const checkDigit = modulo < 2 ? 0 : 11 - modulo;
    return checkDigit === Number(nif[8]);
}

function parseContactsArray(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue
            .map((item) => ({
                name: String(item?.name || '').trim() || 'Contacto',
                phone: normalizePhone(String(item?.phone || '')),
            }))
            .filter((item) => item.name || item.phone);
    }

    if (typeof rawValue === 'string' && rawValue.trim()) {
        try {
            return parseContactsArray(JSON.parse(rawValue));
        } catch (error) {
            return [];
        }
    }

    return [];
}

function parseManagersArray(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue
            .map((item) => ({
                name: String(item?.name || '').trim(),
                email: String(item?.email || '').trim().toLowerCase(),
                phone: normalizePhone(String(item?.phone || '')),
            }))
            .filter((item) => item.name || item.email || item.phone);
    }

    if (typeof rawValue === 'string' && rawValue.trim()) {
        try {
            return parseManagersArray(JSON.parse(rawValue));
        } catch (error) {
            return [];
        }
    }

    return [];
}

function parseAccessCredentialsArray(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue
            .map((item) => ({
                service: String(item?.service || '').trim(),
                username: String(item?.username || '').trim(),
                password: decryptCustomerSecret(String(item?.password || '').trim()),
            }))
            .filter((item) => item.service || item.username || item.password);
    }

    if (typeof rawValue === 'string' && rawValue.trim()) {
        try {
            return parseAccessCredentialsArray(JSON.parse(rawValue));
        } catch (error) {
            return [];
        }
    }

    return [];
}

function serializeAccessCredentialsForStorage(rawCredentials) {
    const credentials = parseAccessCredentialsArray(rawCredentials);
    const normalized = credentials
        .map((item) => ({
            service: String(item?.service || '').trim(),
            username: String(item?.username || '').trim(),
            password: encryptCustomerSecret(String(item?.password || '').trim()),
        }))
        .filter((item) => item.service || item.username || item.password);
    return JSON.stringify(normalized);
}

function applyDefaultAccessCredentialUsernames(rawCredentials, fallbackNif = '') {
    const credentials = parseAccessCredentialsArray(rawCredentials);
    const normalizedNif = normalizeCustomerNif(fallbackNif);
    if (!normalizedNif || credentials.length === 0) return credentials;

    return credentials.map((item) => {
        const service = String(item?.service || '').trim();
        const username = String(item?.username || '').trim();
        if (service.toUpperCase() !== 'AT' || username) {
            return { ...item };
        }
        return {
            ...item,
            username: normalizedNif,
        };
    });
}

const HOUSEHOLD_RELATION_TYPES = new Set(['conjuge', 'filho', 'pai', 'outro']);
const RELATED_RECORD_RELATION_TYPES = new Set(['funcionario', 'amigo', 'familiar', 'gerente', 'socio', 'outro']);

function foldText(value) {
    return String(value || '')
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function normalizeRelationType(value, allowedTypes) {
    const folded = foldText(value);
    if (!folded) return allowedTypes.has('outro') ? 'outro' : '';
    if (allowedTypes.has(folded)) return folded;

    if (allowedTypes === HOUSEHOLD_RELATION_TYPES) {
        if (
            folded.startsWith('espos') ||
            folded.startsWith('marid') ||
            folded.includes('conjuge') ||
            folded.includes('wife') ||
            folded.includes('husband')
        ) {
            return 'conjuge';
        }
        if (folded.startsWith('filh')) return 'filho';
        if (folded === 'pai' || folded === 'mae' || folded.startsWith('progenitor') || folded.startsWith('parent')) return 'pai';
        return 'outro';
    }

    if (allowedTypes === RELATED_RECORD_RELATION_TYPES) {
        if (folded.startsWith('funcion')) return 'funcionario';
        if (folded.startsWith('amig')) return 'amigo';
        if (folded.startsWith('famil')) return 'familiar';
        if (folded.startsWith('gerent') || folded.startsWith('admin')) return 'gerente';
        if (folded.startsWith('soci')) return 'socio';
        return 'outro';
    }

    return '';
}

function parseCustomerRelationLinksArray(rawValue, allowedTypes) {
    if (Array.isArray(rawValue)) {
        const seen = new Set();
        const normalized = [];

        rawValue.forEach((item) => {
            const pickText = (...values) => {
                for (const value of values) {
                    if (value === undefined || value === null) continue;
                    const text = String(value).trim();
                    if (!text) continue;
                    const folded = foldText(text);
                    if (folded === 'undefined' || folded === 'null' || folded === 'nan') continue;
                    return text;
                }
                return '';
            };

            const relationType = normalizeRelationType(
                pickText(
                    item?.relationType,
                    item?.relation,
                    item?.tipo,
                    item?.type,
                    item?.tipo_relacao,
                    item?.tipoRelacao,
                    item?.relation_type
                ),
                allowedTypes
            );
            if (!relationType) return;

            const customerId = pickText(
                item?.customerId,
                item?.linkedCustomerId,
                item?.relatedCustomerId,
                item?.fichaId,
                item?.clienteId,
                item?.ficha_relacionada_id,
                item?.fichaRelacionadaId,
                item?.id_ficha_relacionada,
                item?.cliente_id,
                item?.id_cliente
            );
            const explicitSourceId = pickText(
                item?.customerSourceId,
                item?.sourceId,
                item?.linkedCustomerSourceId,
                item?.relatedCustomerSourceId,
                item?.fichaSourceId,
                item?.clienteSourceId,
                item?.ficha_relacionada_source_id,
                item?.fichaRelacionadaSourceId,
                item?.source_id_ficha_relacionada,
                item?.cliente_source_id,
                item?.source_id_cliente
            );
            const customerSourceId = explicitSourceId || parseCustomerSourceId(customerId, '');
            const customerName = pickText(
                item?.customerName,
                item?.name,
                item?.nome,
                item?.ficha_relacionada_nome,
                item?.fichaRelacionadaNome,
                item?.nome_ficha_relacionada,
                item?.cliente_nome,
                item?.nome_cliente,
                item?.ficha_relacionada
            );
            const customerCompany = pickText(
                item?.customerCompany,
                item?.company,
                item?.empresa,
                item?.ficha_relacionada_empresa,
                item?.fichaRelacionadaEmpresa,
                item?.empresa_ficha_relacionada,
                item?.cliente_empresa,
                item?.empresa_cliente
            );
            const customerNif = normalizeDigits(
                pickText(
                    item?.customerNif,
                    item?.nif,
                    item?.ficha_relacionada_nif,
                    item?.fichaRelacionadaNif,
                    item?.nif_ficha_relacionada,
                    item?.cliente_nif,
                    item?.nif_cliente
                )
            ).slice(-9);
            const note = pickText(item?.note, item?.notes, item?.observacao, item?.obs, item?.nota, item?.observacoes);

            const relationKeySeed =
                customerSourceId ||
                customerId ||
                customerNif ||
                `${customerName.toLowerCase()}::${customerCompany.toLowerCase()}`;
            if (!relationKeySeed) return;

            const dedupeKey = `${relationType}::${relationKeySeed}`;
            if (seen.has(dedupeKey)) return;
            seen.add(dedupeKey);

            normalized.push({
                customerId: customerId || undefined,
                customerSourceId: customerSourceId || undefined,
                relationType,
                note: note || undefined,
                customerName: customerName || undefined,
                customerCompany: customerCompany || undefined,
                customerNif: customerNif || undefined,
            });
        });

        return normalized;
    }

    if (typeof rawValue === 'string' && rawValue.trim()) {
        try {
            return parseCustomerRelationLinksArray(JSON.parse(rawValue), allowedTypes);
        } catch (error) {
            return [];
        }
    }

    return [];
}

function parseAgregadoFamiliarArray(rawValue) {
    return parseCustomerRelationLinksArray(rawValue, HOUSEHOLD_RELATION_TYPES);
}

function parseFichasRelacionadasArray(rawValue) {
    return parseCustomerRelationLinksArray(rawValue, RELATED_RECORD_RELATION_TYPES);
}

function extractManagersFromRawRow(rawRow) {
    if (!rawRow || typeof rawRow !== 'object') return [];

    const parsed = parseManagersArray(
        pickFirstValue(rawRow, [
            'managers_json',
            'gerentes_json',
            'gerencia_administracao_json',
            'gerencia_admin_json',
            'administracao_json',
        ])
    );

    if (parsed.length > 0) return parsed;

    const managerName = String(pickFirstValue(rawRow, ['gerente', 'manager', 'administrador', 'nome_gerente']) || '').trim();
    const managerEmail = String(pickFirstValue(rawRow, ['email_gerente', 'manager_email']) || '').trim().toLowerCase();
    const managerPhone = normalizePhone(String(pickFirstValue(rawRow, ['telefone_gerente', 'manager_phone']) || ''));

    if (managerName || managerEmail || managerPhone) {
        return [{ name: managerName, email: managerEmail, phone: managerPhone }];
    }

    return [];
}

function extractAccessCredentialsFromRawRow(rawRow, fallback = {}) {
    if (!rawRow || typeof rawRow !== 'object') {
        return parseAccessCredentialsArray(fallback?.accessCredentials || []);
    }

    const credentials = parseAccessCredentialsArray(
        pickFirstValue(rawRow, [
            'access_credentials_json',
            'acessos_json',
            'dados_acesso_json',
            'dados_de_acesso_json',
            'credenciais_json',
        ])
    );

    const pushIfAny = (service, usernameRaw, passwordRaw) => {
        const username = String(usernameRaw || '').trim();
        const password = String(passwordRaw || '').trim();
        if (!username && !password) return;
        credentials.push({ service: String(service || '').trim(), username, password });
    };

    pushIfAny(
        'AT',
        pickFirstValue(rawRow, ['utilizador_at', 'username_at', 'user_at']),
        pickFirstValue(rawRow, ['password_at', 'senha_at']) || fallback?.senhaFinancas
    );
    pushIfAny(
        'SS',
        pickFirstValue(rawRow, ['utilizador_ss', 'username_ss', 'user_ss']),
        pickFirstValue(rawRow, ['password_ss', 'senha_ss']) || fallback?.senhaSegurancaSocial
    );
    pushIfAny(
        'RU',
        pickFirstValue(rawRow, ['utilizador_ru', 'username_ru', 'user_ru']),
        pickFirstValue(rawRow, ['password_ru', 'senha_ru'])
    );
    pushIfAny(
        'ViaCTT',
        pickFirstValue(rawRow, ['utilizador_viactt', 'username_viactt', 'user_viactt']),
        pickFirstValue(rawRow, ['password_viactt', 'senha_viactt'])
    );
    pushIfAny(
        'IAPMEI',
        pickFirstValue(rawRow, ['utilizador_iapmei', 'username_iapmei', 'user_iapmei']),
        pickFirstValue(rawRow, ['password_iapmei', 'senha_iapmei'])
    );

    const deduped = [];
    const seen = new Set();
    credentials.forEach((item) => {
        const service = String(item?.service || '').trim();
        const username = String(item?.username || '').trim();
        const password = String(item?.password || '').trim();
        if (!service && !username && !password) return;
        const key = service.toLowerCase() + '::' + username.toLowerCase() + '::' + password;
        if (seen.has(key)) return;
        seen.add(key);
        deduped.push({ service, username, password });
    });

    const fallbackNif = normalizeCustomerNif(
        fallback?.nif ||
            pickFirstValue(rawRow, ['nif', 'vat', 'tax_id', 'numero_contribuinte', 'contribuinte']) ||
            ''
    );
    return applyDefaultAccessCredentialUsernames(deduped, fallbackNif);
}


function parseCustomerProfile(rawValue) {
    const base = {
        certidaoPermanenteNumero: '',
        certidaoPermanenteValidade: '',
        rcbeNumero: '',
        rcbeData: '',
        dataConstituicao: '',
        inicioAtividade: '',
        caePrincipal: '',
        codigoReparticaoFinancas: '',
        tipoContabilidade: '',
        estadoCliente: '',
        contabilistaCertificado: '',
        notes: '',
    };

    const parsed = parseJsonObject(rawValue);
    if (!parsed) return base;

    Object.keys(base).forEach((key) => {
        base[key] = String(parsed[key] || '').trim();
    });

    return base;
}

function buildCustomerProfileFromInput(input, existingRawValue) {
    const existing = parseCustomerProfile(existingRawValue);
    const nested = parseCustomerProfile(input?.customerProfile || null);

    const pick = (fieldName, aliases = []) => {
        if (input && Object.prototype.hasOwnProperty.call(input, fieldName)) {
            if (input[fieldName] !== undefined) {
                return String(input[fieldName] || '').trim();
            }
        }
        for (const alias of aliases) {
            if (input && Object.prototype.hasOwnProperty.call(input, alias)) {
                if (input[alias] !== undefined) {
                    return String(input[alias] || '').trim();
                }
            }
        }
        return nested[fieldName] || existing[fieldName] || '';
    };

    return {
        certidaoPermanenteNumero: pick('certidaoPermanenteNumero', ['certidao_permanente_numero']),
        certidaoPermanenteValidade: pick('certidaoPermanenteValidade', ['certidao_permanente_validade']),
        rcbeNumero: pick('rcbeNumero', ['rcbe_numero']),
        rcbeData: pick('rcbeData', ['rcbe_data']),
        dataConstituicao: pick('dataConstituicao', ['data_constituicao']),
        inicioAtividade: pick('inicioAtividade', ['inicio_atividade']),
        caePrincipal: pick('caePrincipal', ['cae_principal']),
        codigoReparticaoFinancas: pick('codigoReparticaoFinancas', ['codigo_reparticao_financas']),
        tipoContabilidade: pick('tipoContabilidade', ['tipo_contabilidade']),
        estadoCliente: pick('estadoCliente', ['estado_cliente', 'estado']),
        contabilistaCertificado: pick('contabilistaCertificado', ['contabilista_certificado']),
        notes: pick('notes', ['notas', 'observacoes', 'obs']),
    };
}

function serializeCustomerProfile(profile) {
    if (!profile || typeof profile !== 'object') return null;
    const cleaned = {};
    Object.entries(profile).forEach(([key, value]) => {
        const text = String(value || '').trim();
        if (text) cleaned[key] = text;
    });
    return Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned) : null;
}

function parseJsonObject(rawValue) {
    if (rawValue === undefined || rawValue === null || rawValue === '') return null;
    if (typeof rawValue === 'object' && !Array.isArray(rawValue)) return rawValue;
    try {
        const parsed = JSON.parse(String(rawValue || '').trim());
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
        return null;
    }
}

function parseJsonArray(rawValue) {
    if (rawValue === undefined || rawValue === null || rawValue === '') return [];
    if (Array.isArray(rawValue)) return rawValue;
    try {
        const parsed = JSON.parse(String(rawValue || '').trim());
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function normalizeLocalSqlCustomer(row) {
    if (!row) return null;

    const id = String(row.id || '').trim();
    const name = String(row.name || '').trim();
    const company = String(row.company || '').trim();
    if (!id || !name || !company) return null;

    const profile = parseCustomerProfile(row.customer_profile_json);

    return {
        id,
        sourceId: String(row.source_id || '').trim() || undefined,
        name,
        company,
        contactName: String(row.contact_name || '').trim() || undefined,
        phone: normalizePhone(String(row.phone || '')),
        email: String(row.email || '').trim().toLowerCase() || undefined,
        documentsFolder: String(row.documents_folder || '').trim() || undefined,
        nif: String(row.nif || '').trim() || undefined,
        niss: String(row.niss || '').trim() || undefined,
        senhaFinancas: decryptCustomerSecret(String(row.senha_financas || '').trim()) || undefined,
        senhaSegurancaSocial: decryptCustomerSecret(String(row.senha_seg_social || '').trim()) || undefined,
        tipoIva: String(row.tipo_iva || '').trim() || undefined,
        morada: String(row.morada || '').trim() || undefined,
        certidaoPermanenteNumero: profile.certidaoPermanenteNumero || undefined,
        certidaoPermanenteValidade: profile.certidaoPermanenteValidade || undefined,
        rcbeNumero: profile.rcbeNumero || undefined,
        rcbeData: profile.rcbeData || undefined,
        dataConstituicao: profile.dataConstituicao || undefined,
        inicioAtividade: profile.inicioAtividade || undefined,
        caePrincipal: profile.caePrincipal || undefined,
        codigoReparticaoFinancas: profile.codigoReparticaoFinancas || undefined,
        tipoContabilidade: profile.tipoContabilidade || undefined,
        estadoCliente: profile.estadoCliente || undefined,
        contabilistaCertificado: profile.contabilistaCertificado || undefined,
        notes: profile.notes || undefined,
        managers: parseManagersArray(row.managers_json),
        accessCredentials: applyDefaultAccessCredentialUsernames(
            parseAccessCredentialsArray(row.access_credentials_json),
            String(row.nif || '').trim()
        ),
        agregadoFamiliar: parseAgregadoFamiliarArray(row.agregado_familiar_json),
        fichasRelacionadas: parseFichasRelacionadasArray(row.fichas_relacionadas_json),
        supabasePayload: parseJsonObject(row.supabase_payload_json) || undefined,
        supabaseUpdatedAt: String(row.supabase_updated_at || '').trim() || undefined,
        ownerId: String(row.owner_id || '').trim() || null,
        type: normalizeCustomerType(row.type),
        contacts: parseContactsArray(row.contacts_json),
        allowAutoResponses: normalizeBoolean(row.allow_auto_responses, true),
    };
}

async function getAllLocalCustomers() {
    const rows = await dbAllAsync(
        `SELECT id, source_id, name, company, contact_name, phone, email, owner_id, type, contacts_json, allow_auto_responses, documents_folder, nif, niss, senha_financas, senha_seg_social, tipo_iva, morada, customer_profile_json, managers_json, access_credentials_json, agregado_familiar_json, fichas_relacionadas_json, supabase_payload_json, supabase_updated_at
         FROM customers
         ORDER BY datetime(updated_at) DESC`
    );
    return rows.map(normalizeLocalSqlCustomer).filter(Boolean);
}

async function upsertLocalCustomer(input) {
    const incomingId = sanitizeCustomerId(input.id, input.phone);
    const incomingSourceId = parseCustomerSourceId(incomingId, input.sourceId);
    const incomingName = String(input.name || '').trim();
    const incomingCompany = String(input.company || '').trim();
    const hasIncomingContactName =
        input && (
            Object.prototype.hasOwnProperty.call(input, 'contactName') ||
            Object.prototype.hasOwnProperty.call(input, 'contact_name')
        );
    const incomingContactName = String(input.contactName ?? input.contact_name ?? '').trim();
    const incomingPhone = normalizePhone(String(input.phone || ''));
    const incomingEmail = String(input.email || '').trim().toLowerCase();
    const incomingOwnerId = String(input.ownerId || '').trim();
    const hasIncomingType =
        Object.prototype.hasOwnProperty.call(input || {}, 'type') &&
        input?.type !== undefined &&
        input?.type !== null &&
        String(input?.type || '').trim() !== '';
    const incomingType = hasIncomingType ? normalizeCustomerType(input.type) : '';
    const incomingContacts = parseContactsArray(input.contacts);
    const incomingAllowAuto = normalizeBoolean(input.allowAutoResponses, true);
    const incomingDocumentsFolder = String(input.documentsFolder || '').trim();
    const rawIncomingNif = String(input.nif || '').trim();
    const incomingNif = normalizeCustomerNif(rawIncomingNif);
    const incomingNiss = String(input.niss || '').trim();
    const incomingSenhaFinancas = decryptCustomerSecret(String(input.senhaFinancas || '').trim());
    const incomingSenhaSegSocial = decryptCustomerSecret(String(input.senhaSegurancaSocial || '').trim());
    const incomingTipoIva = String(input.tipoIva || '').trim();
    const incomingMorada = String(input.morada || '').trim();
    const incomingManagers = parseManagersArray(input.managers);
    const incomingAccessCredentials = parseAccessCredentialsArray(input.accessCredentials);
    const hasIncomingAgregadoFamiliar =
        input && (
            Object.prototype.hasOwnProperty.call(input, 'agregadoFamiliar') ||
            Object.prototype.hasOwnProperty.call(input, 'agregado_familiar') ||
            Object.prototype.hasOwnProperty.call(input, 'agregado_familiar_json')
        );
    const hasIncomingFichasRelacionadas =
        input && (
            Object.prototype.hasOwnProperty.call(input, 'fichasRelacionadas') ||
            Object.prototype.hasOwnProperty.call(input, 'fichas_relacionadas') ||
            Object.prototype.hasOwnProperty.call(input, 'fichas_relacionadas_json')
        );
    const incomingAgregadoFamiliar = parseAgregadoFamiliarArray(
        input.agregadoFamiliar ?? input.agregado_familiar ?? input.agregado_familiar_json
    );
    const incomingFichasRelacionadas = parseFichasRelacionadasArray(
        input.fichasRelacionadas ?? input.fichas_relacionadas ?? input.fichas_relacionadas_json
    );
    const incomingSupabaseUpdatedAt = String(input.supabaseUpdatedAt || '').trim();
    const allowNifOverwrite = normalizeBoolean(input.allowNifOverwrite, false);
    let incomingSupabasePayloadJson = '';
    if (input.supabasePayload !== undefined) {
        try {
            incomingSupabasePayloadJson = JSON.stringify(input.supabasePayload || {});
        } catch (error) {
            incomingSupabasePayloadJson = '';
        }
    }

    const existingById = incomingId
        ? await dbGetAsync('SELECT * FROM customers WHERE id = ? LIMIT 1', [incomingId])
        : null;
    const existingBySource =
        !existingById && incomingSourceId
            ? await dbGetAsync('SELECT * FROM customers WHERE source_id = ? LIMIT 1', [incomingSourceId])
            : null;
    const allowWeakIdentityMatch = !incomingSourceId && !incomingNif;
    const existingByEmail =
        allowWeakIdentityMatch && !existingById && !existingBySource && incomingEmail
            ? await dbGetAsync('SELECT * FROM customers WHERE lower(email) = lower(?) LIMIT 1', [incomingEmail])
            : null;
    const existingByPhone =
        allowWeakIdentityMatch && !existingById && !existingBySource && !existingByEmail && incomingPhone
            ? await dbGetAsync('SELECT * FROM customers WHERE phone = ? LIMIT 1', [incomingPhone])
            : null;

    const existing = existingById || existingBySource || existingByEmail || existingByPhone;

    const finalId = existing?.id || incomingId;
    const finalSourceId = incomingSourceId || String(existing?.source_id || '').trim();
    const finalName = incomingName || String(existing?.name || '').trim();
    const finalCompany = incomingCompany || String(existing?.company || '').trim() || finalName;
    const finalContactName = hasIncomingContactName
        ? incomingContactName
        : String(existing?.contact_name || '').trim();
    const finalPhone = incomingPhone || normalizePhone(String(existing?.phone || ''));
    const finalEmail = incomingEmail || String(existing?.email || '').trim().toLowerCase();
    const finalOwnerId = incomingOwnerId || String(existing?.owner_id || '').trim();
    const finalType = hasIncomingType
        ? (incomingType || normalizeCustomerType(existing?.type))
        : normalizeCustomerType(existing?.type);
    const finalContacts = incomingContacts.length > 0 ? incomingContacts : parseContactsArray(existing?.contacts_json);
    const finalAllowAutoBase =
        input.allowAutoResponses !== undefined
            ? normalizeBoolean(input.allowAutoResponses, true)
            : normalizeBoolean(existing?.allow_auto_responses, true);
    const finalAllowAuto = finalPhone ? finalAllowAutoBase : false;
    const finalDocumentsFolder =
        input.documentsFolder !== undefined
            ? incomingDocumentsFolder
            : String(existing?.documents_folder || '').trim();
    const finalNif = input.nif !== undefined
        ? incomingNif
        : (normalizeCustomerNif(String(existing?.nif || '').trim()) || String(existing?.nif || '').trim());
    const finalNiss = input.niss !== undefined ? incomingNiss : String(existing?.niss || '').trim();
    const finalSenhaFinancas =
        input.senhaFinancas !== undefined
            ? incomingSenhaFinancas
            : decryptCustomerSecret(String(existing?.senha_financas || '').trim());
    const finalSenhaSegSocial =
        input.senhaSegurancaSocial !== undefined
            ? incomingSenhaSegSocial
            : decryptCustomerSecret(String(existing?.senha_seg_social || '').trim());
    const finalTipoIva =
        input.tipoIva !== undefined
            ? incomingTipoIva
            : String(existing?.tipo_iva || '').trim();
    const finalMorada =
        input.morada !== undefined
            ? incomingMorada
            : String(existing?.morada || '').trim();
    const finalCustomerProfile = buildCustomerProfileFromInput(input, existing?.customer_profile_json);
    const finalCustomerProfileJson = serializeCustomerProfile(finalCustomerProfile);
    const finalManagers =
        input.managers !== undefined
            ? incomingManagers
            : parseManagersArray(existing?.managers_json);
    const finalAccessCredentialsBase =
        input.accessCredentials !== undefined
            ? incomingAccessCredentials
            : parseAccessCredentialsArray(existing?.access_credentials_json);
    const finalAccessCredentials = applyDefaultAccessCredentialUsernames(finalAccessCredentialsBase, finalNif);
    const finalAgregadoFamiliar =
        hasIncomingAgregadoFamiliar
            ? incomingAgregadoFamiliar
            : parseAgregadoFamiliarArray(existing?.agregado_familiar_json);
    const finalFichasRelacionadas =
        hasIncomingFichasRelacionadas
            ? incomingFichasRelacionadas
            : parseFichasRelacionadasArray(existing?.fichas_relacionadas_json);
    const finalAgregadoFamiliarJson = finalAgregadoFamiliar.length > 0 ? JSON.stringify(finalAgregadoFamiliar) : null;
    const finalFichasRelacionadasJson = finalFichasRelacionadas.length > 0 ? JSON.stringify(finalFichasRelacionadas) : null;
    const finalSupabasePayloadJson =
        input.supabasePayload !== undefined
            ? incomingSupabasePayloadJson
            : String(existing?.supabase_payload_json || '').trim();
    const finalSupabaseUpdatedAt =
        input.supabaseUpdatedAt !== undefined
            ? incomingSupabaseUpdatedAt
            : String(existing?.supabase_updated_at || '').trim();
    const storedSenhaFinancas = finalSenhaFinancas ? encryptCustomerSecret(finalSenhaFinancas) : null;
    const storedSenhaSegSocial = finalSenhaSegSocial ? encryptCustomerSecret(finalSenhaSegSocial) : null;
    const storedAccessCredentialsJson = serializeAccessCredentialsForStorage(finalAccessCredentials || []);

    if (input.nif !== undefined) {
        const existingNifNormalized = normalizeCustomerNif(existing?.nif || '');
        const incomingNifNormalized = normalizeCustomerNif(incomingNif || '');
        if (incomingNifNormalized && incomingNifNormalized !== existingNifNormalized && !isValidPortugueseNif(incomingNifNormalized)) {
            throw new Error('NIF inválido. Introduza um NIF português válido com 9 dígitos.');
        }
        if (existingNifNormalized && incomingNifNormalized && existingNifNormalized !== incomingNifNormalized) {
            throw new Error('NIF é imutável neste sistema. Alteração bloqueada.');
        }
        if (!allowNifOverwrite && existingNifNormalized && !incomingNifNormalized) {
            throw new Error('NIF é obrigatório e não pode ser removido.');
        }
    }

    if (finalNif) {
        const nifNormalizedExpr = `
            replace(
                replace(
                    replace(
                        replace(
                            replace(lower(ifnull(nif, '')), 'pt', ''),
                        ' ', ''),
                    '-', ''),
                '.', ''),
            '/', '')
        `;
        const conflictRow = await dbGetAsync(
            `SELECT id, source_id, nif, name, company
             FROM customers
             WHERE id <> ?
               AND ${nifNormalizedExpr} <> ''
               AND (${nifNormalizedExpr} = ? OR substr(${nifNormalizedExpr}, -9) = ?)
             LIMIT 1`,
            [finalId, finalNif, finalNif]
        );
        if (conflictRow) {
            throw new Error(
                `NIF duplicado detetado (${finalNif}) entre clientes "${finalName}" e "${conflictRow.company || conflictRow.name || conflictRow.id}".`
            );
        }
    }

    if (!finalName) {
        throw new Error('Nome do cliente é obrigatório.');
    }

    await dbRunAsync(
        `INSERT INTO customers (
            id, source_id, name, company, contact_name, phone, email, owner_id, type, contacts_json, allow_auto_responses, documents_folder, nif, niss, senha_financas, senha_seg_social, tipo_iva, morada, customer_profile_json, managers_json, access_credentials_json, agregado_familiar_json, fichas_relacionadas_json, supabase_payload_json, supabase_updated_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           source_id = excluded.source_id,
           name = excluded.name,
           company = excluded.company,
           contact_name = excluded.contact_name,
           phone = excluded.phone,
           email = excluded.email,
           owner_id = excluded.owner_id,
           type = excluded.type,
           contacts_json = excluded.contacts_json,
           allow_auto_responses = excluded.allow_auto_responses,
           documents_folder = excluded.documents_folder,
           nif = excluded.nif,
           niss = excluded.niss,
           senha_financas = excluded.senha_financas,
           senha_seg_social = excluded.senha_seg_social,
           tipo_iva = excluded.tipo_iva,
           morada = excluded.morada,
           customer_profile_json = excluded.customer_profile_json,
           managers_json = excluded.managers_json,
           access_credentials_json = excluded.access_credentials_json,
           agregado_familiar_json = excluded.agregado_familiar_json,
           fichas_relacionadas_json = excluded.fichas_relacionadas_json,
           supabase_payload_json = excluded.supabase_payload_json,
           supabase_updated_at = excluded.supabase_updated_at,
           updated_at = CURRENT_TIMESTAMP`,
        [
            finalId,
            finalSourceId || null,
            finalName,
            finalCompany,
            finalContactName || null,
            finalPhone || '',
            finalEmail || null,
            finalOwnerId || null,
            finalType,
            JSON.stringify(finalContacts),
            finalAllowAuto ? 1 : 0,
            finalDocumentsFolder || null,
            finalNif || null,
            finalNiss || null,
            storedSenhaFinancas,
            storedSenhaSegSocial,
            finalTipoIva || null,
            finalMorada || null,
            finalCustomerProfileJson,
            JSON.stringify(finalManagers || []),
            storedAccessCredentialsJson,
            finalAgregadoFamiliarJson,
            finalFichasRelacionadasJson,
            finalSupabasePayloadJson || null,
            finalSupabaseUpdatedAt || null,
        ]
    );

    const savedRow = await dbGetAsync('SELECT * FROM customers WHERE id = ? LIMIT 1', [finalId]);
    return normalizeLocalSqlCustomer(savedRow);
}

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

function mergeCustomersWithLocalOverrides(sourceCustomers, localCustomers) {
    if (!Array.isArray(sourceCustomers) || sourceCustomers.length === 0) {
        return Array.isArray(localCustomers) ? [...localCustomers] : [];
    }
    if (!Array.isArray(localCustomers) || localCustomers.length === 0) {
        return [...sourceCustomers];
    }

    const localById = new Map();
    const localBySourceId = new Map();

    localCustomers.forEach((localCustomer) => {
        const localId = String(localCustomer?.id || '').trim();
        const localSourceId = parseCustomerSourceId(localId, localCustomer?.sourceId);
        if (localId) localById.set(localId, localCustomer);
        if (localSourceId) localBySourceId.set(localSourceId, localCustomer);
    });

    const merged = sourceCustomers.map((sourceCustomer) => {
        const sourceId = parseCustomerSourceId(sourceCustomer?.id, sourceCustomer?.sourceId);
        const localMatch = localById.get(sourceCustomer.id) || (sourceId ? localBySourceId.get(sourceId) : null);
        if (!localMatch) {
            return sourceCustomer;
        }

        const mergedCustomer = {
            ...sourceCustomer,
            id: sourceCustomer.id,
            sourceId,
        };

        const applyLocalFallback = (fieldName) => {
            const sourceValue = mergedCustomer[fieldName];
            const localValue = localMatch[fieldName];
            const sourceMissing =
                sourceValue === undefined ||
                sourceValue === null ||
                (typeof sourceValue === 'string' && sourceValue.trim() === '');
            const localPresent =
                localValue !== undefined &&
                localValue !== null &&
                (typeof localValue !== 'string' || localValue.trim() !== '');
            if (sourceMissing && localPresent) {
                mergedCustomer[fieldName] = localValue;
            }
        };

        [
            'contactName',
            'nif',
            'niss',
            'type',
            'senhaFinancas',
            'senhaSegurancaSocial',
            'tipoIva',
            'morada',
            'certidaoPermanenteNumero',
            'certidaoPermanenteValidade',
            'rcbeNumero',
            'rcbeData',
            'dataConstituicao',
            'inicioAtividade',
            'caePrincipal',
            'codigoReparticaoFinancas',
            'tipoContabilidade',
            'estadoCliente',
            'contabilistaCertificado',
            'notes',
        ].forEach(applyLocalFallback);

        // Tipo de entidade: quando existir valor local, ele prevalece na listagem.
        // Isto evita regressão para "Empresa" quando o remoto não transporta tipo explícito.
        if (localMatch.type) {
            mergedCustomer.type = localMatch.type;
        }

        if (!mergedCustomer.documentsFolder && localMatch.documentsFolder) {
            mergedCustomer.documentsFolder = localMatch.documentsFolder;
        }
        if ((!Array.isArray(mergedCustomer.contacts) || mergedCustomer.contacts.length === 0) && Array.isArray(localMatch.contacts) && localMatch.contacts.length > 0) {
            mergedCustomer.contacts = localMatch.contacts;
        }
        if (localMatch.allowAutoResponses !== undefined) {
            mergedCustomer.allowAutoResponses = normalizeBoolean(localMatch.allowAutoResponses, true);
        }
        if ((!Array.isArray(mergedCustomer.managers) || mergedCustomer.managers.length === 0) && Array.isArray(localMatch.managers) && localMatch.managers.length > 0) {
            mergedCustomer.managers = localMatch.managers;
        }
        if ((!Array.isArray(mergedCustomer.accessCredentials) || mergedCustomer.accessCredentials.length === 0) && Array.isArray(localMatch.accessCredentials) && localMatch.accessCredentials.length > 0) {
            mergedCustomer.accessCredentials = localMatch.accessCredentials;
        }
        if ((!Array.isArray(mergedCustomer.agregadoFamiliar) || mergedCustomer.agregadoFamiliar.length === 0) && Array.isArray(localMatch.agregadoFamiliar) && localMatch.agregadoFamiliar.length > 0) {
            mergedCustomer.agregadoFamiliar = localMatch.agregadoFamiliar;
        }
        if ((!Array.isArray(mergedCustomer.fichasRelacionadas) || mergedCustomer.fichasRelacionadas.length === 0) && Array.isArray(localMatch.fichasRelacionadas) && localMatch.fichasRelacionadas.length > 0) {
            mergedCustomer.fichasRelacionadas = localMatch.fichasRelacionadas;
        }
        if (!mergedCustomer.supabasePayload && sourceCustomer.supabasePayload) {
            mergedCustomer.supabasePayload = sourceCustomer.supabasePayload;
        }
        if (!mergedCustomer.supabaseUpdatedAt && sourceCustomer.supabaseUpdatedAt) {
            mergedCustomer.supabaseUpdatedAt = sourceCustomer.supabaseUpdatedAt;
        }
        return mergedCustomer;
    });

    localCustomers.forEach((localCustomer) => {
        const localId = String(localCustomer?.id || '').trim();
        const localSourceId = parseCustomerSourceId(localId, localCustomer?.sourceId);
        const exists = merged.some((customer) => {
            const customerId = String(customer?.id || '').trim();
            if (localId && customerId === localId) return true;
            const customerSourceId = parseCustomerSourceId(customerId, customer?.sourceId);
            return !!(localSourceId && customerSourceId && localSourceId === customerSourceId);
        });
        if (!exists) {
            merged.push(localCustomer);
        }
    });

    const deduped = [];
    const byNif = new Map();

    const isFilled = (value) => {
        if (value === undefined || value === null) return false;
        if (typeof value === 'string') return value.trim() !== '';
        if (Array.isArray(value)) return value.length > 0;
        return true;
    };

    const completenessScore = (customer) => {
        if (!customer || typeof customer !== 'object') return 0;
        let score = 0;
        if (parseCustomerSourceId(customer?.id, customer?.sourceId)) score += 6;
        if (String(customer?.id || '').startsWith('ext_c_')) score += 2;
        if (isFilled(customer?.phone)) score += 1;
        if (isFilled(customer?.email)) score += 1;
        if (isFilled(customer?.ownerId)) score += 1;
        if (isFilled(customer?.documentsFolder)) score += 1;
        if (isFilled(customer?.niss)) score += 1;
        if (isFilled(customer?.morada)) score += 1;
        if (isFilled(customer?.managers)) score += 1;
        if (isFilled(customer?.accessCredentials)) score += 1;
        if (isFilled(customer?.agregadoFamiliar)) score += 1;
        if (isFilled(customer?.fichasRelacionadas)) score += 1;
        return score;
    };

    const mergeMissingFields = (primary, secondary) => {
        const mergedCustomer = { ...primary };
        Object.entries(secondary || {}).forEach(([key, value]) => {
            if (!isFilled(mergedCustomer[key]) && isFilled(value)) {
                mergedCustomer[key] = value;
            }
        });
        return mergedCustomer;
    };

    merged.forEach((customer) => {
        const nifKey = normalizeCustomerNif(customer?.nif || '');
        if (!nifKey) {
            deduped.push(customer);
            return;
        }

        const existingIndex = byNif.get(nifKey);
        if (existingIndex === undefined) {
            byNif.set(nifKey, deduped.length);
            deduped.push(customer);
            return;
        }

        const current = deduped[existingIndex];
        const keepCurrent = completenessScore(current) >= completenessScore(customer);
        const preferred = keepCurrent ? current : customer;
        const fallback = keepCurrent ? customer : current;
        deduped[existingIndex] = mergeMissingFields(preferred, fallback);
    });

    return deduped;
}

function normalizeTaskStatus(value) {
    const candidate = String(value || '').trim().toLowerCase();
    if (candidate === 'done') return 'done';
    if (candidate === 'in_progress') return 'in_progress';
    if (candidate === 'waiting') return 'waiting';
    return 'open';
}

function normalizeTaskPriority(value) {
    const candidate = String(value || '').trim().toLowerCase();
    return candidate === 'urgent' ? 'urgent' : 'normal';
}

function parseTaskAttachmentsArray(rawValue) {
    return parseJsonArray(rawValue)
        .map((item) => ({
            id: String(item?.id || '').trim(),
            name: String(item?.name || '').trim(),
            mimeType: String(item?.mimeType || item?.type || '').trim() || 'application/octet-stream',
            size: Number(item?.size || 0),
            dataUrl: String(item?.dataUrl || item?.url || '').trim(),
            createdAt: String(item?.createdAt || '').trim() || new Date().toISOString(),
        }))
        .filter((item) => item.id && item.name && item.dataUrl);
}

function normalizeLocalSqlTask(row) {
    if (!row) return null;
    const id = String(row.id || '').trim();
    const conversationId = String(row.conversation_id || '').trim();
    const title = String(row.title || '').trim();
    const dueDateRaw = String(row.due_date || '').trim();
    if (!id || !conversationId || !title || !dueDateRaw) return null;

    return {
        id,
        conversationId,
        title,
        status: normalizeTaskStatus(row.status),
        priority: normalizeTaskPriority(row.priority),
        dueDate: dueDateRaw,
        assignedUserId: String(row.assigned_user_id || '').trim() || '',
        notes: String(row.notes || '').trim() || undefined,
        attachments: parseTaskAttachmentsArray(row.attachments_json),
    };
}

async function getLocalTasks(conversationId) {
    const query = conversationId
        ? {
              sql: `SELECT id, conversation_id, title, status, priority, due_date, assigned_user_id, notes, attachments_json
                    FROM tasks WHERE conversation_id = ? ORDER BY datetime(updated_at) DESC`,
              params: [conversationId],
          }
        : {
              sql: `SELECT id, conversation_id, title, status, priority, due_date, assigned_user_id, notes, attachments_json
                    FROM tasks ORDER BY datetime(updated_at) DESC`,
              params: [],
          };

    const rows = await dbAllAsync(query.sql, query.params);
    return rows.map(normalizeLocalSqlTask).filter(Boolean);
}

async function upsertLocalTask(input) {
    const taskId = String(input.id || '').trim() || `t${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const existing = await dbGetAsync('SELECT * FROM tasks WHERE id = ? LIMIT 1', [taskId]);

    const conversationId = String(input.conversationId || existing?.conversation_id || '').trim();
    const title = String(input.title || existing?.title || '').trim();
    const dueDate = String(input.dueDate || existing?.due_date || '').trim() || new Date().toISOString();
    const status = normalizeTaskStatus(input.status || existing?.status);
    const priority = normalizeTaskPriority(input.priority || existing?.priority);
    const assignedUserId = String(input.assignedUserId || existing?.assigned_user_id || '').trim();
    const notes = input.notes !== undefined ? String(input.notes || '').trim() : String(existing?.notes || '').trim();
    const attachments =
        input.attachments !== undefined
            ? parseTaskAttachmentsArray(input.attachments)
            : parseTaskAttachmentsArray(existing?.attachments_json);
    const attachmentsJson = attachments.length > 0 ? JSON.stringify(attachments) : null;

    if (!conversationId || !title) {
        throw new Error('Tarefa requer conversationId e title.');
    }

    await dbRunAsync(
        `INSERT INTO tasks (
            id, conversation_id, title, status, priority, due_date, assigned_user_id, notes, attachments_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           title = excluded.title,
           status = excluded.status,
           priority = excluded.priority,
           due_date = excluded.due_date,
           assigned_user_id = excluded.assigned_user_id,
           notes = excluded.notes,
           attachments_json = excluded.attachments_json,
           updated_at = CURRENT_TIMESTAMP`,
        [taskId, conversationId, title, status, priority, dueDate, assignedUserId || null, notes || null, attachmentsJson]
    );

    const savedRow = await dbGetAsync('SELECT * FROM tasks WHERE id = ? LIMIT 1', [taskId]);
    return normalizeLocalSqlTask(savedRow);
}

function normalizeCallSource(value) {
    const source = String(value || '').trim().toLowerCase();
    return source === 'import' ? 'import' : 'manual';
}

function normalizeLocalSqlCall(row) {
    if (!row) return null;

    const id = String(row.id || '').trim();
    const customerId = String(row.customer_id || '').trim();
    const startedAt = String(row.started_at || '').trim();
    if (!id || !customerId || !startedAt) return null;

    return {
        id,
        customerId,
        userId: String(row.user_id || '').trim() || null,
        startedAt,
        durationSeconds: Number(row.duration_seconds || 0),
        notes: String(row.notes || '').trim() || undefined,
        source: normalizeCallSource(row.source),
    };
}

async function getLocalCalls(customerId) {
    const query = customerId
        ? {
              sql: `SELECT id, customer_id, user_id, started_at, duration_seconds, notes, source
                    FROM calls WHERE customer_id = ? ORDER BY datetime(started_at) DESC`,
              params: [customerId],
          }
        : {
              sql: `SELECT id, customer_id, user_id, started_at, duration_seconds, notes, source
                    FROM calls ORDER BY datetime(started_at) DESC`,
              params: [],
          };

    const rows = await dbAllAsync(query.sql, query.params);
    return rows.map(normalizeLocalSqlCall).filter(Boolean);
}

async function upsertLocalCall(input) {
    const callId = String(input.id || '').trim() || `call${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const existing = await dbGetAsync('SELECT * FROM calls WHERE id = ? LIMIT 1', [callId]);

    const customerId = String(input.customerId || existing?.customer_id || '').trim();
    const userId = String(input.userId || existing?.user_id || '').trim();
    const startedAt = String(input.startedAt || existing?.started_at || '').trim() || new Date().toISOString();
    const durationSeconds = Number(input.durationSeconds ?? existing?.duration_seconds ?? 0);
    const notes = input.notes !== undefined ? String(input.notes || '').trim() : String(existing?.notes || '').trim();
    const source = normalizeCallSource(input.source || existing?.source);

    if (!customerId) {
        throw new Error('Chamada requer customerId.');
    }

    await dbRunAsync(
        `INSERT INTO calls (
            id, customer_id, user_id, started_at, duration_seconds, notes, source, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(id) DO UPDATE SET
           customer_id = excluded.customer_id,
           user_id = excluded.user_id,
           started_at = excluded.started_at,
           duration_seconds = excluded.duration_seconds,
           notes = excluded.notes,
           source = excluded.source`,
        [callId, customerId, userId || null, startedAt, Number.isFinite(durationSeconds) ? durationSeconds : 0, notes || null, source]
    );

    const savedRow = await dbGetAsync('SELECT * FROM calls WHERE id = ? LIMIT 1', [callId]);
    return normalizeLocalSqlCall(savedRow);
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

function isBaileysProviderEnabled() {
    return ACTIVE_WHATSAPP_PROVIDER === 'baileys';
}

function isCloudProviderEnabled() {
    return ACTIVE_WHATSAPP_PROVIDER === 'cloud';
}

function isWhatsAppCloudConfigured() {
    return Boolean(TOKEN && PHONE_NUMBER_ID);
}

function resolveWhatsAppAccountId(accountId) {
    const candidate = sanitizeIdPart(accountId || '', '');
    if (candidate && BAILEYS_ACCOUNTS_BY_ID.has(candidate)) return candidate;
    return ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID;
}

function getBaileysGatewayForAccount(accountId) {
    const resolvedAccountId = resolveWhatsAppAccountId(accountId);
    const gateway = baileysGateways.get(resolvedAccountId) || null;
    const config = BAILEYS_ACCOUNTS_BY_ID.get(resolvedAccountId) || null;
    return {
        accountId: resolvedAccountId,
        gateway,
        config,
    };
}

function isBaileysGatewayConnected(gateway) {
    const health = gateway?.getHealth?.();
    return Boolean(health && health.connected === true);
}

function listBaileysAccountCandidates(preferredAccountId) {
    const preferred = resolveWhatsAppAccountId(preferredAccountId);
    const ordered = [];
    const seen = new Set();
    const pushCandidate = (candidate) => {
        const normalized = resolveWhatsAppAccountId(candidate);
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        ordered.push(normalized);
    };

    pushCandidate(preferred);
    pushCandidate(ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID);
    BAILEYS_ACCOUNT_CONFIGS.forEach((account) => pushCandidate(account.id));
    return ordered;
}

function pickBaileysGatewayForOutbound(preferredAccountId) {
    const preferred = resolveWhatsAppAccountId(preferredAccountId);
    const candidates = listBaileysAccountCandidates(preferred);
    let firstAvailable = null;

    for (const candidateId of candidates) {
        const gateway = baileysGateways.get(candidateId) || null;
        if (!gateway) continue;
        if (!firstAvailable) {
            firstAvailable = { accountId: candidateId, gateway };
        }
        if (isBaileysGatewayConnected(gateway)) {
            return {
                accountId: candidateId,
                gateway,
                fallbackFrom: candidateId !== preferred ? preferred : null,
                connected: true,
            };
        }
    }

    if (firstAvailable) {
        return {
            accountId: firstAvailable.accountId,
            gateway: firstAvailable.gateway,
            fallbackFrom: firstAvailable.accountId !== preferred ? preferred : null,
            connected: false,
        };
    }

    const fallback = getBaileysGatewayForAccount(preferred);
    return {
        accountId: fallback.accountId,
        gateway: fallback.gateway || null,
        fallbackFrom: null,
        connected: false,
    };
}

function getWhatsAppAccountsHealth() {
    if (!isBaileysProviderEnabled()) {
        return [
            {
                accountId: 'cloud',
                label: 'WhatsApp Cloud',
                isDefault: true,
                provider: 'cloud',
                configured: isWhatsAppCloudConfigured(),
                connected: isWhatsAppCloudConfigured(),
                status: isWhatsAppCloudConfigured() ? 'ready' : 'missing_config',
                qrAvailable: false,
            },
        ];
    }

    return BAILEYS_ACCOUNT_CONFIGS.map((account) => {
        const state = baileysGateways.get(account.id)?.getHealth?.() || {
            provider: 'baileys',
            status: 'not_initialized',
            connected: false,
            connecting: false,
            qrAvailable: false,
        };
        return {
            accountId: account.id,
            label: account.label,
            isDefault: account.id === ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID,
            ...state,
        };
    });
}

function getWhatsAppHealth(options = {}) {
    if (isBaileysProviderEnabled()) {
        const { accountId, gateway } = getBaileysGatewayForAccount(options?.accountId);
        const state = gateway?.getHealth?.() || {
            provider: 'baileys',
            status: 'not_initialized',
            connected: false,
            connecting: false,
            qrAvailable: false,
        };
        return {
            provider: 'baileys',
            configured: true,
            cloudConfigured: isWhatsAppCloudConfigured(),
            accountId,
            accounts: getWhatsAppAccountsHealth(),
            ...state,
        };
    }

    return {
        provider: 'cloud',
        configured: isWhatsAppCloudConfigured(),
        cloudConfigured: isWhatsAppCloudConfigured(),
        accountId: 'cloud',
        accounts: getWhatsAppAccountsHealth(),
        status: isWhatsAppCloudConfigured() ? 'ready' : 'missing_config',
        connected: isWhatsAppCloudConfigured(),
        connecting: false,
        qrAvailable: false,
        phoneNumberId: PHONE_NUMBER_ID || null,
    };
}

async function connectWhatsAppProvider(options = {}) {
    if (isBaileysProviderEnabled()) {
        const { accountId, gateway } = getBaileysGatewayForAccount(options?.accountId);
        if (!gateway) throw new Error(`Conta WhatsApp não inicializada: ${accountId}`);
        await gateway.start();
        return getWhatsAppHealth({ accountId });
    }
    if (!isWhatsAppCloudConfigured()) {
        throw new Error('WhatsApp Cloud API não configurada (WHATSAPP_TOKEN/PHONE_NUMBER_ID).');
    }
    return getWhatsAppHealth();
}

async function disconnectWhatsAppProvider({ logout = false, clearAuth = false, accountId = '' } = {}) {
    if (isBaileysProviderEnabled()) {
        const resolved = getBaileysGatewayForAccount(accountId);
        if (!resolved.gateway) throw new Error(`Conta WhatsApp não inicializada: ${resolved.accountId}`);
        await resolved.gateway.stop({ logout: Boolean(logout), clearAuth: Boolean(clearAuth) });
        return getWhatsAppHealth({ accountId: resolved.accountId });
    }
    return getWhatsAppHealth();
}

function getWhatsAppQrPayload(options = {}) {
    if (!isBaileysProviderEnabled()) {
        return {
            provider: 'cloud',
            accountId: 'cloud',
            hasQr: false,
            qrText: null,
            connected: isWhatsAppCloudConfigured(),
            status: isWhatsAppCloudConfigured() ? 'ready' : 'missing_config',
        };
    }
    const { accountId, gateway } = getBaileysGatewayForAccount(options?.accountId);
    const payload = gateway?.getQrPayload?.() || {
        provider: 'baileys',
        hasQr: false,
        qrText: null,
        connected: false,
        status: 'not_initialized',
    };
    return {
        accountId,
        ...payload,
    };
}

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

    // Preferimos sempre a conversa solicitada por ID para que "Associar Cliente"
    // atualize a conversa aberta no ecrã.
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
        // Race-safe fallback: update existing row by customer_id when another insert won the unique key.
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
    if (['whatsapp', 'contacto whatsapp', 'contato whatsapp', 'telegram'].includes(lowered)) {
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
    const value = String(rawValue || '').trim().toLowerCase();
    if (value.includes('telegram')) return 'telegram';
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
    const minComparableLength = channel === 'telegram' ? 6 : 7;
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

function sanitizeDocumentFileName(rawName) {
    const base = path.basename(String(rawName || '').trim());
    return base.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 180);
}

function isWindowsUncPath(value) {
    return /^\\\\[^\\]+\\[^\\]+/.test(String(value || '').trim());
}

function isWindowsDrivePath(value) {
    return /^[A-Za-z]:[\\/]/.test(String(value || '').trim());
}

function normalizeWindowsPathForCompare(value) {
    return String(value || '')
        .trim()
        .replace(/\//g, '\\')
        .replace(/\\+$/, '')
        .toLowerCase();
}

function decodeProcMountPath(value) {
    return String(value || '')
        .replace(/\\040/g, ' ')
        .replace(/\\011/g, '\t')
        .replace(/\\012/g, '\n')
        .replace(/\\134/g, '\\');
}

function isLinuxMountPointMounted(mountPath) {
    try {
        const target = path.resolve(String(mountPath || '').trim());
        if (!target) return false;
        const mountsRaw = fs.readFileSync('/proc/mounts', 'utf8');
        const mountedTargets = mountsRaw
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.split(/\s+/))
            .filter((parts) => parts.length >= 2)
            .map((parts) => path.resolve(decodeProcMountPath(parts[1])));
        return mountedTargets.some((mountedPath) => {
            if (mountedPath === target) return true;
            return target.startsWith(`${mountedPath}${path.sep}`);
        });
    } catch (error) {
        return false;
    }
}

function mapWindowsFolderToLinuxMount(rawFolder) {
    const stored = String(rawFolder || '').trim();
    if (!stored || (!isWindowsUncPath(stored) && !isWindowsDrivePath(stored))) {
        return null;
    }

    const windowsPrefix = normalizeWindowsPathForCompare(DOCS_WINDOWS_PREFIX);
    const linuxMount = String(DOCS_LINUX_MOUNT || '').trim();
    if (!windowsPrefix || !linuxMount) {
        throw new Error(
            'Pasta Windows/UNC detetada na ficha do cliente, mas sem mapeamento no Oracle. Defina DOCS_WINDOWS_PREFIX e DOCS_LINUX_MOUNT no .env.'
        );
    }
    if (!isLinuxMountPointMounted(linuxMount)) {
        throw new Error(
            `DOCS_LINUX_MOUNT (${linuxMount}) não está montado no Oracle. Monte a partilha SMB antes de usar esta pasta do cliente.`
        );
    }

    const storedNormalized = normalizeWindowsPathForCompare(stored);
    if (storedNormalized !== windowsPrefix && !storedNormalized.startsWith(`${windowsPrefix}\\`)) {
        throw new Error(
            `Pasta "${stored}" fora do prefixo configurado em DOCS_WINDOWS_PREFIX ("${DOCS_WINDOWS_PREFIX}").`
        );
    }

    const relativePart = stored
        .trim()
        .slice(DOCS_WINDOWS_PREFIX.trim().length)
        .replace(/^[\\/]+/, '');
    const segments = relativePart.split(/[\\/]+/).filter(Boolean);
    return path.resolve(linuxMount, ...segments);
}

function resolveCustomerDocumentsFolder(customerId, storedFolder = '') {
    const trimmed = String(storedFolder || '').trim();
    if (trimmed) {
        if (trimmed.startsWith('~')) {
            return path.resolve(process.env.HOME || __dirname, trimmed.slice(1));
        }
        const mappedWindowsFolder = mapWindowsFolderToLinuxMount(trimmed);
        if (mappedWindowsFolder) {
            return mappedWindowsFolder;
        }
        if (path.isAbsolute(trimmed)) {
            return path.normalize(trimmed);
        }
        return path.resolve(LOCAL_DOCS_ROOT, trimmed);
    }

    const fallback = sanitizeIdPart(customerId || Date.now(), `cliente_${Date.now()}`);
    return path.resolve(LOCAL_DOCS_ROOT, fallback);
}

function resolveSaftBunkerFolder(customer, documentType = '') {
    const nif = String(customer?.nif || '').replace(/\D/g, '') || 'sem_nif';
    const customerPart = sanitizeIdPart(customer?.id || 'cliente', 'cliente');
    const docPart = sanitizeIdPart(documentType || 'geral', 'geral');
    return path.resolve(SAFT_BUNKER_ROOT, nif, customerPart, docPart);
}

async function ensureWritableSaftBunkerFolder(customer, documentType = '') {
    const preferredFolder = resolveSaftBunkerFolder(customer, documentType);
    try {
        await fs.promises.mkdir(preferredFolder, { recursive: true });
        return { folderPath: preferredFolder, usingFallback: false };
    } catch (error) {
        const fallbackFolder = path.resolve(
            SAFT_BUNKER_FALLBACK_ROOT,
            String(customer?.nif || 'sem_nif').replace(/\D/g, '') || 'sem_nif',
            sanitizeIdPart(customer?.id || 'cliente', 'cliente'),
            sanitizeIdPart(documentType || 'geral', 'geral')
        );
        await fs.promises.mkdir(fallbackFolder, { recursive: true });
        console.warn(
            `[SAFT] Sem acesso ao bunker principal (${preferredFolder}). A usar fallback: ${fallbackFolder}. Erro:`,
            error?.message || error
        );
        return { folderPath: fallbackFolder, usingFallback: true };
    }
}

function buildBunkerFileName(documentType, originalName = '') {
    const ext = path.extname(String(originalName || '').trim()) || '.pdf';
    const base = path.basename(String(originalName || '').trim(), ext) || documentType || 'documento';
    const safeBase = sanitizeDocumentFileName(`${documentType}_${base}`).replace(/\.[^.]+$/, '');
    return `${safeBase}${ext}`;
}

async function getCachedSaftDocument(customerId, documentType) {
    const row = await dbGetAsync(
        `SELECT id, customer_id, customer_nif, document_type, file_name, file_path, source, created_at, updated_at
         FROM saft_documents_cache
         WHERE customer_id = ? AND document_type = ?
         LIMIT 1`,
        [customerId, documentType]
    );

    if (!row) return null;
    const filePath = String(row.file_path || '').trim();
    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }

    await dbRunAsync(
        `UPDATE saft_documents_cache
         SET last_requested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [row.id]
    );

    return {
        id: Number(row.id || 0),
        customerId: String(row.customer_id || '').trim(),
        customerNif: String(row.customer_nif || '').trim() || null,
        documentType: String(row.document_type || '').trim(),
        fileName: String(row.file_name || '').trim() || path.basename(filePath),
        filePath,
        source: String(row.source || '').trim() || 'cache',
        updatedAt: String(row.updated_at || '').trim() || nowIso(),
    };
}

async function upsertSaftDocumentCache({ customerId, customerNif, documentType, fileName, filePath, source }) {
    const normalizedCustomerId = String(customerId || '').trim();
    const normalizedDocType = normalizeSaftDocumentType(documentType);
    const normalizedFileName = sanitizeDocumentFileName(fileName || path.basename(String(filePath || '')));
    const normalizedFilePath = path.resolve(String(filePath || '').trim());

    if (!normalizedCustomerId || !normalizedDocType || !normalizedFileName || !normalizedFilePath) {
        throw new Error('Dados inválidos para cache SAFT.');
    }

    await dbRunAsync(
        `INSERT INTO saft_documents_cache (
            customer_id, customer_nif, document_type, file_name, file_path, source, created_at, updated_at, last_requested_at
         ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(customer_id, document_type) DO UPDATE SET
           customer_nif = excluded.customer_nif,
           file_name = excluded.file_name,
           file_path = excluded.file_path,
           source = excluded.source,
           updated_at = CURRENT_TIMESTAMP,
           last_requested_at = CURRENT_TIMESTAMP`,
        [
            normalizedCustomerId,
            String(customerNif || '').replace(/\D/g, '') || null,
            normalizedDocType,
            normalizedFileName,
            normalizedFilePath,
            String(source || 'collected').trim() || 'collected',
        ]
    );

    return dbGetAsync(
        `SELECT id, customer_id, customer_nif, document_type, file_name, file_path, source, created_at, updated_at
         FROM saft_documents_cache
         WHERE customer_id = ? AND document_type = ?
         LIMIT 1`,
        [normalizedCustomerId, normalizedDocType]
    );
}

async function getLocalCustomerById(customerId) {
    const normalizedId = String(customerId || '').trim();
    if (!normalizedId) return null;

    let row = await dbGetAsync(
        `SELECT id, source_id, name, company, contact_name, phone, email, owner_id, type, contacts_json, allow_auto_responses, documents_folder, nif, niss, senha_financas, senha_seg_social, tipo_iva, morada, customer_profile_json, managers_json, access_credentials_json, agregado_familiar_json, fichas_relacionadas_json, supabase_payload_json, supabase_updated_at
         FROM customers
         WHERE id = ?
         LIMIT 1`,
        [normalizedId]
    );

    if (!row) {
        const sourceCandidates = Array.from(
            new Set([parseCustomerSourceId(normalizedId, ''), normalizedId].map((item) => String(item || '').trim()).filter(Boolean))
        );
        for (const sourceId of sourceCandidates) {
            row = await dbGetAsync(
                `SELECT id, source_id, name, company, contact_name, phone, email, owner_id, type, contacts_json, allow_auto_responses, documents_folder, nif, niss, senha_financas, senha_seg_social, tipo_iva, morada, customer_profile_json, managers_json, access_credentials_json, agregado_familiar_json, fichas_relacionadas_json, supabase_payload_json, supabase_updated_at
                 FROM customers
                 WHERE source_id = ?
                 LIMIT 1`,
                [sourceId]
            );
            if (row) break;
        }
    }

    return normalizeLocalSqlCustomer(row);
}

function normalizeSaftDocumentType(rawType) {
    const value = String(rawType || '').trim().toLowerCase();
    if (['declaracao_nao_divida', 'nao_divida', 'declaracao'].includes(value)) return 'declaracao_nao_divida';
    if (['ies'].includes(value)) return 'ies';
    if (['modelo_22', 'modelo22', 'm22'].includes(value)) return 'modelo_22';
    if (['certidao_permanente', 'certidao', 'cp'].includes(value)) return 'certidao_permanente';
    if (['certificado_pme', 'pme'].includes(value)) return 'certificado_pme';
    if (['crc', 'bdc'].includes(value)) return 'crc';
    return '';
}

function saftDocumentLabel(type) {
    if (type === 'declaracao_nao_divida') return 'Declaração de Não Dívida';
    if (type === 'ies') return 'IES';
    if (type === 'modelo_22') return 'Modelo 22';
    if (type === 'certidao_permanente') return 'Certidão Permanente';
    if (type === 'certificado_pme') return 'Certificado PME';
    if (type === 'crc') return 'CRC';
    return type;
}

function getSaftSearchTokens(documentType, customer) {
    const nif = String(customer?.nif || '').replace(/\D/g, '');
    const base = {
        declaracao_nao_divida: ['nao_divida', 'nao-divida', 'declaracao', 'divida', 'at', 'ss'],
        ies: ['ies'],
        modelo_22: ['modelo22', 'modelo_22', 'modelo 22', 'modelo-22', 'm22'],
        certidao_permanente: ['certidao', 'permanente', 'cp'],
        certificado_pme: ['certificado', 'pme'],
        crc: ['crc', 'bdc'],
    }[documentType] || [documentType];

    return {
        keywords: base.map((item) => String(item || '').toLowerCase()).filter(Boolean),
        nif,
    };
}

async function findLatestDocumentMatch(folderPath, filters) {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const nameLower = entry.name.toLowerCase();
        const hasKeyword = (filters.keywords || []).some((token) => nameLower.includes(token));
        const hasNif = !filters.nif || nameLower.includes(filters.nif);
        if (!hasKeyword || !hasNif) continue;
        const fullPath = path.join(folderPath, entry.name);
        const stat = await fs.promises.stat(fullPath);
        files.push({
            fileName: entry.name,
            fullPath,
            updatedAt: stat.mtime.toISOString(),
        });
    }

    files.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return files[0] || null;
}

async function findDocumentMatches(folderPath, filters) {
    const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const nameLower = entry.name.toLowerCase();
        const hasKeyword = (filters.keywords || []).some((token) => nameLower.includes(token));
        const hasNif = !filters.nif || nameLower.includes(filters.nif);
        if (!hasKeyword || !hasNif) continue;
        const fullPath = path.join(folderPath, entry.name);
        const stat = await fs.promises.stat(fullPath);
        files.push({
            fileName: entry.name,
            fullPath,
            updatedAt: stat.mtime.toISOString(),
        });
    }

    files.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return files;
}

function extractYearFromFileName(fileName) {
    const matches = String(fileName || '').match(/(20\d{2})/g);
    if (!matches || matches.length === 0) return null;
    const year = Number(matches[matches.length - 1]);
    return Number.isFinite(year) ? year : null;
}

function selectModelo22Files(files) {
    const byYear = new Map();
    const withoutYear = [];

    for (const file of files) {
        const year = extractYearFromFileName(file.fileName);
        if (!year) {
            withoutYear.push(file);
            continue;
        }
        if (!byYear.has(year)) {
            byYear.set(year, file);
        }
    }

    const yearsSorted = Array.from(byYear.keys()).sort((a, b) => a - b);
    const yearlyFiles = yearsSorted.map((year) => byYear.get(year)).filter(Boolean);
    return [...yearlyFiles, ...withoutYear.slice(0, 1)];
}

async function runSaftRobotFetch({ customer, documentType, folderPath }) {
    if (!SAFT_ROBOT_SCRIPT) return [];
    if (!SAFT_EMAIL || !SAFT_PASSWORD) {
        throw new Error('Email_saft/Senha_saft não configurados no .env.');
    }

    const scriptPath = path.isAbsolute(SAFT_ROBOT_SCRIPT)
        ? SAFT_ROBOT_SCRIPT
        : path.resolve(__dirname, SAFT_ROBOT_SCRIPT);

    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Script SAFT não encontrado: ${scriptPath}`);
    }

    const args = [
        scriptPath,
        '--email',
        SAFT_EMAIL,
        '--password',
        SAFT_PASSWORD,
        '--nif',
        String(customer?.nif || ''),
        '--document',
        documentType,
        '--outDir',
        folderPath,
    ];

    const result = await new Promise((resolve, reject) => {
        const child = spawn('node', args, { cwd: __dirname });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += String(chunk || '');
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk || '');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(stderr || `Script SAFT terminou com código ${code}`));
                return;
            }
            resolve(stdout.trim());
        });
    });

    const raw = String(result || '');
    if (!raw) return [];

    // Esperado: JSON {"filePath":"..."} | {"filePaths":[...]} ou linha com caminho absoluto.
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.filePaths)) {
            return parsed.filePaths
                .map((item) => path.resolve(String(item || '').trim()))
                .filter((item) => item && fs.existsSync(item));
        }
        if (parsed?.filePath) {
            const resolvedPath = path.resolve(String(parsed.filePath).trim());
            return fs.existsSync(resolvedPath) ? [resolvedPath] : [];
        }
    } catch (error) {
        // segue fallback de texto simples
    }

    if (raw.includes('\n')) {
        const lastLine = raw.split('\n').filter(Boolean).pop() || '';
        const resolvedPath = path.resolve(lastLine);
        return fs.existsSync(resolvedPath) ? [resolvedPath] : [];
    }
    const resolvedPath = path.resolve(raw);
    return fs.existsSync(resolvedPath) ? [resolvedPath] : [];
}

async function runSaftDossierMetadata({ customer }) {
    if (!SAFT_ROBOT_SCRIPT) return { situacaoFiscalAt: '', situacaoFiscalSs: '' };
    if (!SAFT_EMAIL || !SAFT_PASSWORD) {
        throw new Error('Email_saft/Senha_saft não configurados no .env.');
    }

    const scriptPath = path.isAbsolute(SAFT_ROBOT_SCRIPT)
        ? SAFT_ROBOT_SCRIPT
        : path.resolve(__dirname, SAFT_ROBOT_SCRIPT);

    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Script SAFT não encontrado: ${scriptPath}`);
    }

    const args = [
        scriptPath,
        '--email',
        SAFT_EMAIL,
        '--password',
        SAFT_PASSWORD,
        '--nif',
        String(customer?.nif || ''),
        '--document',
        'declaracao_nao_divida',
        '--metadataOnly',
        'true',
        '--outDir',
        path.resolve(process.cwd(), '.tmp', 'saft-metadata'),
    ];

    const result = await new Promise((resolve, reject) => {
        const child = spawn('node', args, { cwd: __dirname });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += String(chunk || '');
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk || '');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(stderr || `Script SAFT terminou com código ${code}`));
                return;
            }
            resolve(stdout.trim());
        });
    });

    try {
        const parsed = JSON.parse(String(result || '{}'));
        const metadata = parsed?.metadata || {};
        return {
            situacaoFiscalAt: String(metadata?.situacaoFiscalAt || '').trim(),
            situacaoFiscalSs: String(metadata?.situacaoFiscalSs || '').trim(),
            certidaoPermanenteCodigo: String(metadata?.certidaoPermanenteCodigo || '').trim(),
            certidaoPermanenteValidade: String(metadata?.certidaoPermanenteValidade || '').trim(),
            dataPedidoAt: String(metadata?.dataPedidoAt || '').trim(),
            dataPedidoSs: String(metadata?.dataPedidoSs || '').trim(),
            dataRecolhaAt: String(metadata?.dataRecolhaAt || '').trim(),
            dataRecolhaSs: String(metadata?.dataRecolhaSs || '').trim(),
            dataPedidos: Array.isArray(metadata?.dataPedidos)
                ? metadata.dataPedidos.map((item) => String(item || '').trim()).filter(Boolean)
                : [],
            dataRecolhas: Array.isArray(metadata?.dataRecolhas)
                ? metadata.dataRecolhas.map((item) => String(item || '').trim()).filter(Boolean)
                : [],
        };
    } catch (error) {
        return {
            situacaoFiscalAt: '',
            situacaoFiscalSs: '',
            certidaoPermanenteCodigo: '',
            certidaoPermanenteValidade: '',
            dataPedidoAt: '',
            dataPedidoSs: '',
            dataRecolhaAt: '',
            dataRecolhaSs: '',
            dataPedidos: [],
            dataRecolhas: [],
        };
    }
}

async function sendWhatsAppCloudRequest(payload, timeoutMs = 15000) {
    if (!isCloudProviderEnabled()) {
        throw new Error('WHATSAPP_PROVIDER não está em modo cloud.');
    }
    if (!TOKEN || !PHONE_NUMBER_ID) {
        throw new Error('WhatsApp Cloud API não configurada.');
    }
    await axios({
        method: 'POST',
        url: `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
        },
        data: payload,
        timeout: Math.max(3000, Number(timeoutMs || 15000)),
    });
}

async function sendWhatsAppDocumentLink({ to, url, filename, caption, accountId = '' }) {
    const toDigits = String(to || '').replace(/\D/g, '');
    if (!toDigits) throw new Error('Destino WhatsApp inválido.');

    if (isBaileysProviderEnabled()) {
        const outboundAccountId = await resolveOutboundAccountIdForPhone(toDigits, accountId);
        const resolved = pickBaileysGatewayForOutbound(outboundAccountId);
        if (!resolved.gateway) throw new Error(`Conta WhatsApp não inicializada: ${resolved.accountId}`);
        const safeCaption = String(caption || '').trim();
        const safeUrl = String(url || '').trim();
        const textBody = [safeCaption, safeUrl].filter(Boolean).join('\n');
        await resolved.gateway.sendText({
            to: toDigits,
            body: textBody || safeUrl || 'Documento disponível.',
        });
        return;
    }

    await sendWhatsAppCloudRequest({
        messaging_product: 'whatsapp',
        to: toDigits,
        type: 'document',
        document: {
            link: url,
            filename: filename || 'documento.pdf',
            caption: caption || '',
        },
    }, 30000);
}

async function sendWhatsAppTextMessage({ to, body, accountId = '' }) {
    const toDigits = String(to || '').replace(/\D/g, '');
    if (!toDigits) throw new Error('Destino WhatsApp inválido.');
    const safeBody = String(body || '').trim();
    if (!safeBody) throw new Error('Mensagem vazia.');

    if (isBaileysProviderEnabled()) {
        const outboundAccountId = await resolveOutboundAccountIdForPhone(toDigits, accountId);
        const resolved = pickBaileysGatewayForOutbound(outboundAccountId);
        if (!resolved.gateway) throw new Error(`Conta WhatsApp não inicializada: ${resolved.accountId}`);
        await resolved.gateway.sendText({
            to: toDigits,
            body: safeBody,
        });
        return;
    }

    await sendWhatsAppCloudRequest({
        messaging_product: 'whatsapp',
        to: toDigits,
        text: { body: safeBody },
    }, 15000);
}

async function sendWhatsAppMenuMessage(to, accountId = '') {
    const toDigits = String(to || '').replace(/\D/g, '');
    if (!toDigits) throw new Error('Destino WhatsApp inválido.');

    if (isBaileysProviderEnabled()) {
        const outboundAccountId = await resolveOutboundAccountIdForPhone(toDigits, accountId);
        const resolved = pickBaileysGatewayForOutbound(outboundAccountId);
        if (!resolved.gateway) throw new Error(`Conta WhatsApp não inicializada: ${resolved.accountId}`);
        const plainMenu =
            'Ola! Como posso ajudar?\n' +
            '1) Ver Status\n' +
            '2) Falar com Suporte\n\n' +
            'Escreve uma das opcoes acima.';
        await resolved.gateway.sendText({
            to: toDigits,
            body: plainMenu,
        });
        return;
    }

    await sendWhatsAppCloudRequest({
        messaging_product: 'whatsapp',
        to: toDigits,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: '🤖 Olá! Como posso ajudar?' },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'btn_status', title: 'Ver Status' } },
                    { type: 'reply', reply: { id: 'btn_suporte', title: 'Falar com Suporte' } },
                ],
            },
        },
    }, 15000);
}

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

if (isBaileysProviderEnabled() && !IS_BACKOFFICE_ONLY) {
    BAILEYS_ACCOUNT_CONFIGS.forEach((account) => {
        const gateway = createBaileysGateway({
            authDir: account.authDir,
            printQRInTerminal: account.printQRInTerminal,
            autoReconnect: true,
            reconnectDelayMs: 4000,
            onInboundMessage: async (payload) => {
                await persistInboundWhatsAppMessage({
                    fromNumber: payload?.fromNumber,
                    body: payload?.body,
                    waId: payload?.waId,
                    rawType: payload?.rawType || 'unknown',
                    direction: payload?.fromMe ? 'outbound' : 'inbound',
                    preferredName: payload?.pushName || '',
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

let smtpTransporter = null;

function hasSmtpConfig() {
    return Boolean(SMTP_HOST && SMTP_USERNAME && SMTP_PASSWORD);
}

function hasEmailProvider() {
    return hasSmtpConfig() || Boolean(RESEND_API_KEY);
}

function getSmtpTransporter() {
    if (!hasSmtpConfig()) return null;
    if (smtpTransporter) return smtpTransporter;
    smtpTransporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_TLS,
        auth: {
            user: SMTP_USERNAME,
            pass: SMTP_PASSWORD,
        },
        tls: {
            rejectUnauthorized: false,
        },
    });
    return smtpTransporter;
}

function formatSmtpFrom() {
    if (SMTP_FROM_EMAIL) {
        return SMTP_FROM_NAME ? `${SMTP_FROM_NAME} <${SMTP_FROM_EMAIL}>` : SMTP_FROM_EMAIL;
    }
    return SMTP_FROM_NAME ? `${SMTP_FROM_NAME} <${SMTP_USERNAME}>` : SMTP_USERNAME;
}

async function sendEmailDocumentLink({ to, cc, subject, documentLabel, url }) {
    const recipient = String(to || '').trim().toLowerCase();
    const ccEmail = String(cc || '').trim().toLowerCase();
    if (!recipient) {
        throw new Error('Email do cliente inválido.');
    }

    const safeSubject = String(subject || '').trim() || 'Documento disponível';
    const safeLabel = String(documentLabel || 'Documento');
    const safeUrl = String(url || '').trim();
    if (!safeUrl) {
        throw new Error('Link do documento inválido para envio por email.');
    }

    const textBody = `${safeLabel}\n\nO seu documento está disponível em: ${safeUrl}\n\nCumprimentos,\nWA PRO`;
    const htmlBody =
        `<p>${safeLabel}</p>` +
        `<p>O seu documento está disponível em: <a href="${safeUrl}">${safeUrl}</a></p>` +
        `<p>Cumprimentos,<br/>WA PRO</p>`;

    const ccList = ccEmail && ccEmail !== recipient ? [ccEmail] : [];

    if (hasSmtpConfig()) {
        const transporter = getSmtpTransporter();
        await transporter.sendMail({
            from: formatSmtpFrom(),
            to: recipient,
            cc: ccList.length > 0 ? ccList : undefined,
            subject: safeSubject,
            text: textBody,
            html: htmlBody,
        });
        return;
    }

    if (!RESEND_API_KEY) {
        throw new Error('Nenhum provedor de email configurado (SMTP/Resend).');
    }

    await axios({
        method: 'POST',
        url: 'https://api.resend.com/emails',
        headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        data: {
            from: RESEND_FROM,
            to: [recipient],
            cc: ccList.length > 0 ? ccList : undefined,
            subject: safeSubject,
            text: textBody,
            html: htmlBody,
        },
        timeout: 30000,
    });
}

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

function sanitizeTableName(rawTableName) {
    const table = String(rawTableName || '').trim();
    if (!table) return null;
    if (!/^[a-zA-Z0-9_.]+$/.test(table)) return null;
    return table;
}

async function fetchSupabaseTable(rawTableName) {
    const tableName = sanitizeTableName(rawTableName);
    if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);

    const response = await axios.get(`${SUPABASE_URL}/rest/v1/${tableName}?select=*&limit=5000`, {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        timeout: 15000,
    });

    if (!Array.isArray(response.data)) return [];
    return response.data;
}

async function fetchSupabaseTableSince(rawTableName, updatedAtColumn, sinceIso) {
    const tableName = sanitizeTableName(rawTableName);
    if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);
    const safeUpdatedColumn = sanitizeTableName(updatedAtColumn);
    if (!safeUpdatedColumn) throw new Error(`Coluna updated_at inválida: ${updatedAtColumn}`);

    const since = String(sinceIso || '').trim();
    if (!since) return fetchSupabaseTable(tableName);

    const params = new URLSearchParams();
    params.set('select', '*');
    params.set(safeUpdatedColumn, `gt.${since}`);
    params.set('order', `${safeUpdatedColumn}.asc`);
    params.set('limit', '5000');

    const response = await axios.get(`${SUPABASE_URL}/rest/v1/${tableName}?${params.toString()}`, {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        timeout: 20000,
    });

    if (!Array.isArray(response.data)) return [];
    return response.data;
}

async function fetchSupabaseTableWithFilters(rawTableName, filters = {}, options = {}) {
    const tableName = sanitizeTableName(rawTableName);
    if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);
    const params = new URLSearchParams();
    params.set('select', String(options.select || '*'));
    Object.entries(filters || {}).forEach(([column, value]) => {
        const safeColumn = sanitizeTableName(column);
        if (!safeColumn || value === undefined || value === null || value === '') return;
        params.set(safeColumn, `eq.${String(value).trim()}`);
    });
    if (options.orderBy) {
        const safeOrderBy = sanitizeTableName(options.orderBy);
        if (safeOrderBy) {
            params.set('order', `${safeOrderBy}.${String(options.orderDirection || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc'}`);
        }
    }
    if (Number.isFinite(Number(options.limit)) && Number(options.limit) > 0) {
        params.set('limit', String(Math.min(10000, Math.max(1, Number(options.limit)))));
    }

    const response = await axios.get(`${SUPABASE_URL}/rest/v1/${tableName}?${params.toString()}`, {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        timeout: 20000,
    });

    if (!Array.isArray(response.data)) return [];
    return response.data;
}

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

async function fetchSupabaseTableSample(rawTableName) {
    const tableName = sanitizeTableName(rawTableName);
    if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);

    const response = await axios.get(`${SUPABASE_URL}/rest/v1/${tableName}?select=*&limit=1`, {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
        },
        timeout: 15000,
    });

    if (!Array.isArray(response.data)) return [];
    return response.data;
}

function pickExistingColumn(columns, candidates, fallback) {
    for (const candidate of candidates) {
        if (columns.includes(candidate)) return candidate;
    }
    return fallback;
}

async function patchSupabaseTable(rawTableName, payload, filterColumn, filterValue) {
    const tableName = sanitizeTableName(rawTableName);
    if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);

    const params = new URLSearchParams();
    params.set('select', '*');
    params.set(filterColumn, `eq.${String(filterValue || '').trim()}`);

    const response = await axios.patch(`${SUPABASE_URL}/rest/v1/${tableName}?${params.toString()}`, payload, {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Prefer: 'return=representation',
            'Content-Type': 'application/json',
        },
        timeout: 15000,
    });

    return Array.isArray(response.data) ? response.data : [];
}

const supabaseColumnsCache = new Map();
const supabaseTablesCache = {
    loaded: false,
    names: new Set(),
};
const supabaseResolvedTableCache = new Map();
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

async function fetchSupabaseOpenApiSchema() {
    const response = await axios.get(`${SUPABASE_URL}/rest/v1/`, {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Accept: 'application/openapi+json',
        },
        timeout: 20000,
    });
    return response?.data && typeof response.data === 'object' ? response.data : {};
}

async function fetchSupabaseTableNamesFromOpenApi() {
    if (supabaseTablesCache.loaded) return supabaseTablesCache.names;

    const names = new Set();
    try {
        const openApi = await fetchSupabaseOpenApiSchema();
        const paths = openApi?.paths || {};
        Object.keys(paths).forEach((rawPath) => {
            const normalized = String(rawPath || '').trim().replace(/^\/+/, '');
            if (!normalized) return;
            if (normalized.startsWith('rpc/')) return;
            if (!sanitizeTableName(normalized)) return;
            names.add(normalized);
        });
    } catch (error) {
        // segue sem cache de tabelas
    }

    supabaseTablesCache.loaded = true;
    supabaseTablesCache.names = names;
    return names;
}

async function resolveSupabaseTableName(primaryTableName, fallbackTableNames = []) {
    const normalizedPrimary = sanitizeTableName(primaryTableName);
    if (!normalizedPrimary) {
        throw new Error(`Nome de tabela inválido: ${primaryTableName}`);
    }

    const cacheKey = [normalizedPrimary, ...fallbackTableNames.map((item) => String(item || '').trim())].join('|');
    if (supabaseResolvedTableCache.has(cacheKey)) {
        return supabaseResolvedTableCache.get(cacheKey);
    }

    const candidates = Array.from(
        new Set([normalizedPrimary, ...fallbackTableNames].map((item) => sanitizeTableName(item)).filter(Boolean))
    );

    if (SUPABASE_URL && SUPABASE_KEY) {
        const availableTables = await fetchSupabaseTableNamesFromOpenApi();
        if (availableTables.size > 0) {
            for (const candidate of candidates) {
                if (availableTables.has(candidate)) {
                    supabaseResolvedTableCache.set(cacheKey, candidate);
                    return candidate;
                }
            }
        }
    }

    // Fallback: tenta usar a primária mesmo sem mapa OpenAPI
    supabaseResolvedTableCache.set(cacheKey, normalizedPrimary);
    return normalizedPrimary;
}

function parseTableColumnsFromOpenApi(openApi, tableName) {
    if (!openApi || typeof openApi !== 'object') return [];

    const schemas = openApi.components?.schemas || {};
    if (schemas && typeof schemas === 'object') {
        for (const [schemaName, schemaDef] of Object.entries(schemas)) {
            if (schemaName === tableName || schemaName.endsWith(`.${tableName}`)) {
                const props = schemaDef?.properties;
                if (props && typeof props === 'object') {
                    return Object.keys(props);
                }
            }
        }
    }

    const paths = openApi.paths || {};
    const tablePath = Object.keys(paths).find((key) => key === `/${tableName}` || key.endsWith(`/${tableName}`));
    if (!tablePath) return [];

    const getDef = paths[tablePath]?.get;
    const params = Array.isArray(getDef?.parameters) ? getDef.parameters : [];
    const selectParam = params.find((item) => item?.name === 'select');
    const sampleColumns = String(selectParam?.schema?.default || '').trim();
    if (!sampleColumns || sampleColumns === '*') return [];
    return sampleColumns
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

async function fetchSupabaseTableColumns(rawTableName) {
    const tableName = sanitizeTableName(rawTableName);
    if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);
    if (supabaseColumnsCache.has(tableName)) {
        return supabaseColumnsCache.get(tableName);
    }

    let columns = [];
    try {
        const sampleRows = await fetchSupabaseTableSample(tableName);
        if (Array.isArray(sampleRows) && sampleRows.length > 0) {
            columns = Object.keys(sampleRows[0] || {});
        }
    } catch (error) {
        // segue fallback OpenAPI
    }

    if (!columns.length) {
        try {
            const openApi = await fetchSupabaseOpenApiSchema();
            columns = parseTableColumnsFromOpenApi(openApi, tableName);
        } catch (error) {
            // segue sem cache de colunas
        }
    }

    const normalizedColumns = Array.from(new Set(columns.map((item) => String(item || '').trim()).filter(Boolean)));
    supabaseColumnsCache.set(tableName, normalizedColumns);
    return normalizedColumns;
}

function pickColumnByCandidates(columns, candidates, fallback = '') {
    if (!Array.isArray(columns) || columns.length === 0) return fallback || '';
    for (const candidate of candidates) {
        if (columns.includes(candidate)) return candidate;
    }
    return fallback || '';
}

function buildPayloadWithExistingColumns(columns, payloadMap) {
    const payload = {};
    Object.entries(payloadMap || {}).forEach(([key, value]) => {
        if (value === undefined) return;
        if (Array.isArray(columns) && columns.length > 0 && !columns.includes(key)) return;
        payload[key] = value;
    });
    return payload;
}

async function patchSupabaseTableWithFilters(rawTableName, payload, filters = {}) {
    const tableName = sanitizeTableName(rawTableName);
    if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);

    const params = new URLSearchParams();
    params.set('select', '*');
    Object.entries(filters || {}).forEach(([column, value]) => {
        if (value === undefined || value === null || value === '') return;
        params.set(column, `eq.${String(value).trim()}`);
    });

    const response = await axios.patch(`${SUPABASE_URL}/rest/v1/${tableName}?${params.toString()}`, payload, {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Prefer: 'return=representation',
            'Content-Type': 'application/json',
        },
        timeout: 15000,
    });

    return Array.isArray(response.data) ? response.data : [];
}

async function insertSupabaseRow(rawTableName, payload) {
    const tableName = sanitizeTableName(rawTableName);
    if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);

    const response = await axios.post(`${SUPABASE_URL}/rest/v1/${tableName}`, payload, {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Prefer: 'return=representation',
            'Content-Type': 'application/json',
        },
        timeout: 15000,
    });

    return Array.isArray(response.data) ? response.data : [];
}

async function upsertSupabaseRow(rawTableName, payload, onConflictColumns = []) {
    const tableName = sanitizeTableName(rawTableName);
    if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);

    const params = new URLSearchParams();
    const normalizedConflicts = Array.from(
        new Set((Array.isArray(onConflictColumns) ? onConflictColumns : []).map((item) => String(item || '').trim()).filter(Boolean))
    );
    if (normalizedConflicts.length > 0) {
        params.set('on_conflict', normalizedConflicts.join(','));
    }

    const response = await axios.post(
        `${SUPABASE_URL}/rest/v1/${tableName}${params.toString() ? `?${params.toString()}` : ''}`,
        payload,
        {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                Prefer: 'resolution=merge-duplicates,return=representation',
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        }
    );

    return Array.isArray(response.data) ? response.data : [];
}

async function findLocalCustomerRowByNifOrCompany(nif, company) {
    const normalizedNif = normalizeDigits(nif);
    if (normalizedNif) {
        const nifNormalizedExpr = `
            replace(
                replace(
                    replace(
                        replace(
                            replace(lower(ifnull(nif, '')), 'pt', ''),
                        ' ', ''),
                    '-', ''),
                '.', ''),
            '/', '')
        `;
        const lastNine = normalizedNif.slice(-9);
        const byNif = await dbGetAsync(
            `SELECT id, source_id, name, company, nif, tipo_iva
             FROM customers
             WHERE ${nifNormalizedExpr} = ?
                OR (${nifNormalizedExpr} <> '' AND substr(${nifNormalizedExpr}, -9) = ?)
             LIMIT 1`,
            [normalizedNif, lastNine]
        );
        if (byNif) return byNif;
        return null;
    }

    const companyLike = String(company || '').trim();
    if (!companyLike) return null;
    return dbGetAsync(
        `SELECT id, source_id, name, company, nif, tipo_iva
         FROM customers
         WHERE lower(company) = lower(?)
            OR lower(name) = lower(?)
         LIMIT 1`,
        [companyLike, companyLike]
    );
}

function normalizeSupabaseCustomerCandidate(rawRow, index = 0) {
    const sourceId = String(pickFirstValue(rawRow, ['id', 'cliente_id', 'uuid']) || '').trim();
    const name = String(pickFirstValue(rawRow, ['name', 'nome', 'cliente', 'full_name']) || '').trim();
    const company = String(pickFirstValue(rawRow, ['company', 'empresa', 'organization', 'entidade']) || '').trim();
    const phone = normalizePhone(
        pickFirstValue(rawRow, ['phone', 'telefone', 'telemovel', 'celular', 'whatsapp', 'numero', 'contacto'])
    );
    const email = String(pickFirstValue(rawRow, ['email', 'mail']) || '').trim().toLowerCase();
    const nif = normalizeDigits(
        pickFirstValue(rawRow, ['nif', 'vat', 'tax_id', 'numero_contribuinte', 'contribuinte']) || ''
    );
    const niss = String(
        pickFirstValue(rawRow, ['niss', 'numero_seguranca_social', 'seg_social_numero', 'social_security_number']) || ''
    ).trim();
    const senhaFinancas = String(
        pickFirstValue(rawRow, [
            'senha_financas',
            'senha_portal_financas',
            'password_financas',
            'financas_password',
            'portal_financas_password',
        ]) || ''
    ).trim();
    const senhaSegurancaSocial = String(
        pickFirstValue(rawRow, [
            'senha_seguranca_social',
            'senha_seg_social',
            'password_seguranca_social',
            'password_seg_social',
            'seg_social_password',
        ]) || ''
    ).trim();
    const ownerSource = String(
        pickFirstValue(rawRow, ['owner_id', 'funcionario_id', 'responsavel_id', 'responsavel_interno_id']) || ''
    ).trim();
    const documentsFolder = String(
        pickFirstValue(rawRow, ['pasta_documentos', 'documents_folder', 'document_folder', 'docs_folder']) || ''
    ).trim();
    const tipoIva = String(
        pickFirstValue(rawRow, [
            'tipo_iva',
            'tipoiva',
            'iva_tipo',
            'regime_iva',
            'periodicidade_iva',
            'iva_periodicidade',
        ]) || ''
    ).trim();
    const morada = String(
        pickFirstValue(rawRow, ['morada', 'address', 'endereco']) || ''
    ).trim();
    const notes = String(
        pickFirstValue(rawRow, ['notes', 'notas', 'observacoes', 'obs']) || ''
    ).trim();
    const certidaoPermanenteNumero = String(
        pickFirstValue(rawRow, ['certidao_permanente_numero', 'certidao_permanente_n', 'certidao_permanente']) || ''
    ).trim();
    const certidaoPermanenteValidade = String(
        pickFirstValue(rawRow, ['certidao_permanente_validade', 'validade_certidao_permanente']) || ''
    ).trim();
    const rcbeNumero = String(pickFirstValue(rawRow, ['rcbe_numero', 'rcbe_n', 'rcbe']) || '').trim();
    const rcbeData = String(pickFirstValue(rawRow, ['rcbe_data']) || '').trim();
    const dataConstituicao = String(pickFirstValue(rawRow, ['data_constituicao']) || '').trim();
    const inicioAtividade = String(pickFirstValue(rawRow, ['inicio_atividade', 'data_inicio_atividade']) || '').trim();
    const caePrincipal = String(pickFirstValue(rawRow, ['cae_principal', 'cae']) || '').trim();
    const codigoReparticaoFinancas = String(
        pickFirstValue(rawRow, ['codigo_reparticao_financas', 'reparticao_financas']) || ''
    ).trim();
    const tipoContabilidade = String(pickFirstValue(rawRow, ['tipo_contabilidade']) || '').trim();
    const estadoCliente = String(pickFirstValue(rawRow, ['estado_cliente', 'estado']) || '').trim();
    const contabilistaCertificado = String(
        pickFirstValue(rawRow, ['contabilista_certificado_nome', 'contabilista_certificado']) || ''
    ).trim();
    const managers = extractManagersFromRawRow(rawRow);
    const accessCredentials = extractAccessCredentialsFromRawRow(rawRow, {
        senhaFinancas,
        senhaSegurancaSocial,
    });
    const agregadoFamiliar = parseAgregadoFamiliarArray(
        pickFirstValue(rawRow, ['agregado_familiar_json', 'agregadofamiliar_json', 'agregado_familiar'])
    );
    const fichasRelacionadas = parseFichasRelacionadasArray(
        pickFirstValue(rawRow, ['fichas_relacionadas_json', 'fichasrelacionadas_json', 'fichas_relacionadas'])
    );

    return {
        sourceId,
        localId: sourceId ? `ext_c_${sanitizeIdPart(sourceId, String(index + 1))}` : '',
        name: name || company || `Cliente ${index + 1}`,
        company: company || name || `Cliente ${index + 1}`,
        phone,
        email,
        nif,
        niss,
        senhaFinancas,
        senhaSegurancaSocial,
        documentsFolder,
        tipoIva,
        morada,
        notes,
        certidaoPermanenteNumero,
        certidaoPermanenteValidade,
        rcbeNumero,
        rcbeData,
        dataConstituicao,
        inicioAtividade,
        caePrincipal,
        codigoReparticaoFinancas,
        tipoContabilidade,
        estadoCliente,
        contabilistaCertificado,
        managers,
        accessCredentials,
        agregadoFamiliar,
        fichasRelacionadas,
        ownerId: ownerSource ? `ext_u_${sanitizeIdPart(ownerSource, ownerSource)}` : null,
        type: normalizeCustomerType(pickFirstValue(rawRow, ['type', 'tipo', 'categoria', 'tipo_entidade'])),
        supabaseUpdatedAt: String(pickFirstValue(rawRow, [SUPABASE_CLIENTS_UPDATED_AT_COLUMN, 'updated_at']) || '').trim(),
        raw: rawRow,
    };
}

async function loadSupabaseCustomerLookup() {
    if (!(SUPABASE_URL && SUPABASE_KEY)) {
        return null;
    }

    const rows = await fetchSupabaseTable(SUPABASE_CLIENTS_SOURCE);
    const byNif = new Map();
    const byCompany = new Map();

    rows.forEach((row, index) => {
        const candidate = normalizeSupabaseCustomerCandidate(row, index);
        if (candidate.nif) {
            if (!byNif.has(candidate.nif)) byNif.set(candidate.nif, []);
            byNif.get(candidate.nif).push(candidate);
        }

        const companyKey = normalizeLookupText(candidate.company || candidate.name);
        if (companyKey) {
            if (!byCompany.has(companyKey)) byCompany.set(companyKey, []);
            byCompany.get(companyKey).push(candidate);
        }
    });

    return {
        totalRows: rows.length,
        byNif,
        byCompany,
    };
}

async function materializeLocalCustomerFromSupabase(candidate) {
    if (!candidate) return null;
    if (!candidate.nif) return null;

    const saved = await upsertLocalCustomer({
        id: candidate.localId || undefined,
        sourceId: candidate.sourceId || undefined,
        name: candidate.name,
        company: candidate.company,
        phone: candidate.phone,
        email: candidate.email || undefined,
        ownerId: candidate.ownerId || undefined,
        type: candidate.type,
        contacts: [],
        documentsFolder: candidate.documentsFolder || undefined,
        nif: candidate.nif || undefined,
        niss: candidate.niss || undefined,
        senhaFinancas: candidate.senhaFinancas || undefined,
        senhaSegurancaSocial: candidate.senhaSegurancaSocial || undefined,
        tipoIva: candidate.tipoIva || undefined,
        morada: candidate.morada || undefined,
        notes: candidate.notes || undefined,
        certidaoPermanenteNumero: candidate.certidaoPermanenteNumero || undefined,
        certidaoPermanenteValidade: candidate.certidaoPermanenteValidade || undefined,
        rcbeNumero: candidate.rcbeNumero || undefined,
        rcbeData: candidate.rcbeData || undefined,
        dataConstituicao: candidate.dataConstituicao || undefined,
        inicioAtividade: candidate.inicioAtividade || undefined,
        caePrincipal: candidate.caePrincipal || undefined,
        codigoReparticaoFinancas: candidate.codigoReparticaoFinancas || undefined,
        tipoContabilidade: candidate.tipoContabilidade || undefined,
        estadoCliente: candidate.estadoCliente || undefined,
        contabilistaCertificado: candidate.contabilistaCertificado || undefined,
        managers: Array.isArray(candidate.managers) ? candidate.managers : [],
        accessCredentials: Array.isArray(candidate.accessCredentials) ? candidate.accessCredentials : [],
        agregadoFamiliar: Array.isArray(candidate.agregadoFamiliar) ? candidate.agregadoFamiliar : [],
        fichasRelacionadas: Array.isArray(candidate.fichasRelacionadas) ? candidate.fichasRelacionadas : [],
        supabasePayload: candidate.raw || {},
        supabaseUpdatedAt: candidate.supabaseUpdatedAt || undefined,
        allowNifOverwrite: true,
        allowAutoResponses: true,
    });

    const savedId = String(saved?.id || candidate.localId || '').trim();
    if (savedId) {
        const rowById = await dbGetAsync(
            `SELECT id, source_id, name, company, nif, tipo_iva
             FROM customers
             WHERE id = ?
             LIMIT 1`,
            [savedId]
        );
        if (rowById) return rowById;
    }

    if (candidate.sourceId) {
        return dbGetAsync(
            `SELECT id, source_id, name, company, nif, tipo_iva
             FROM customers
             WHERE source_id = ?
             LIMIT 1`,
            [candidate.sourceId]
        );
    }

    return null;
}

async function findCustomerRowForObrigacao(nif, company, supabaseLookup) {
    const normalizedNif = normalizeDigits(nif).slice(-9);
    if (!normalizedNif) {
        return {
            customerRow: null,
            matchedBy: 'none',
            syncedFromSupabase: false,
        };
    }

    const localRow = await findLocalCustomerRowByNifOrCompany(normalizedNif, '');
    if (localRow) {
        return {
            customerRow: localRow,
            matchedBy: 'local_nif',
            syncedFromSupabase: false,
        };
    }

    if (!supabaseLookup) {
        return {
            customerRow: null,
            matchedBy: 'none',
            syncedFromSupabase: false,
        };
    }

    const candidate = (supabaseLookup.byNif.get(normalizedNif) || [])[0] || null;

    if (!candidate) {
        return {
            customerRow: null,
            matchedBy: 'none',
            syncedFromSupabase: false,
        };
    }

    const syncedRow = await materializeLocalCustomerFromSupabase(candidate);
    return {
        customerRow: syncedRow || null,
        matchedBy: normalizedNif ? 'supabase_nif' : 'supabase_company',
        syncedFromSupabase: !!syncedRow,
    };
}

function resolveSupabaseCustomerIdFromLocalRow(localRow) {
    const sourceId = String(localRow?.source_id || '').trim();
    if (sourceId) return sourceId;
    const localId = String(localRow?.id || '').trim();
    if (localId.startsWith('ext_c_')) return localId.slice(6);
    return localId || '';
}

async function upsertLocalObrigacaoRecolha(input) {
    const payloadJson = input.payload ? JSON.stringify(input.payload) : null;
    await dbRunAsync(
        `INSERT INTO obrigacoes_recolhas (
            customer_id, customer_source_id, obrigacao_id, obrigacao_codigo, obrigacao_nome,
            periodo_tipo, periodo_ano, periodo_mes, periodo_trimestre,
            estado_codigo, identificacao, data_recebido, data_comprovativo, empresa, nif,
            payload_json, origem, synced_supabase_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(customer_id, obrigacao_id, periodo_ano, periodo_mes, periodo_trimestre)
         DO UPDATE SET
            customer_source_id = excluded.customer_source_id,
            obrigacao_codigo = excluded.obrigacao_codigo,
            obrigacao_nome = excluded.obrigacao_nome,
            periodo_tipo = excluded.periodo_tipo,
            estado_codigo = excluded.estado_codigo,
            identificacao = excluded.identificacao,
            data_recebido = excluded.data_recebido,
            data_comprovativo = excluded.data_comprovativo,
            empresa = excluded.empresa,
            nif = excluded.nif,
            payload_json = excluded.payload_json,
            origem = excluded.origem,
            synced_supabase_at = excluded.synced_supabase_at,
            updated_at = CURRENT_TIMESTAMP`,
        [
            String(input.customerId || '').trim(),
            String(input.customerSourceId || '').trim() || null,
            Number(input.obrigacaoId || 0),
            String(input.obrigacaoCodigo || '').trim() || null,
            String(input.obrigacaoNome || '').trim() || null,
            String(input.periodoTipo || 'mensal').trim(),
            Number(input.periodoAno || 0),
            input.periodoMes === null || input.periodoMes === undefined ? 0 : Number(input.periodoMes),
            input.periodoTrimestre === null || input.periodoTrimestre === undefined ? 0 : Number(input.periodoTrimestre),
            String(input.estadoCodigo || '').trim() || null,
            String(input.identificacao || '').trim() || null,
            String(input.dataRecebido || '').trim() || null,
            String(input.dataComprovativo || '').trim() || null,
            String(input.empresa || '').trim() || null,
            String(input.nif || '').trim() || null,
            payloadJson,
            String(input.origem || 'saft_dri_robot').trim(),
            input.syncedSupabaseAt ? String(input.syncedSupabaseAt).trim() : null,
        ]
    );
}

async function markLocalObrigacaoRecolhaSynced({ customerId, obrigacaoId, periodo }) {
    if (!customerId || !obrigacaoId || !periodo?.ano) return;

    let query = `
        UPDATE obrigacoes_recolhas
        SET synced_supabase_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE customer_id = ?
          AND obrigacao_id = ?
          AND periodo_ano = ?
    `;
    const params = [nowIso(), String(customerId).trim(), Number(obrigacaoId), Number(periodo.ano)];

    if (periodo.tipo === 'mensal') {
        query += ' AND periodo_mes = ?';
        params.push(Number(periodo.mes || 0));
    } else if (periodo.tipo === 'trimestral') {
        query += ' AND periodo_trimestre = ?';
        params.push(Number(periodo.trimestre || 0));
    }

    await dbRunAsync(query, params);
}

async function runSaftObrigacoesRobot({ mode = 'dri', year, month }) {
    if (!SAFT_EMAIL || !SAFT_PASSWORD) {
        throw new Error('Email_saft/Senha_saft não configurados no .env.');
    }
    const normalizedMode = String(mode || '').trim().toLowerCase();
    if (!['dri', 'dmr', 'saft', 'iva', 'm22', 'ies', 'm10', 'relatorio-unico'].includes(normalizedMode)) {
        throw new Error(`Modo de robô inválido: ${mode}`);
    }

    const scriptPath = path.isAbsolute(SAFT_OBRIGACOES_ROBOT_SCRIPT)
        ? SAFT_OBRIGACOES_ROBOT_SCRIPT
        : path.resolve(__dirname, SAFT_OBRIGACOES_ROBOT_SCRIPT);

    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Script de obrigações SAFT não encontrado: ${scriptPath}`);
    }

    const args = [
        scriptPath,
        '--mode',
        normalizedMode,
        '--year',
        String(year),
        '--month',
        String(month),
        '--email',
        SAFT_EMAIL,
        '--password',
        SAFT_PASSWORD,
    ];

    const rawResult = await new Promise((resolve, reject) => {
        const child = spawn('node', args, { cwd: __dirname });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += String(chunk || '');
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk || '');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(stderr || `Robot SAFT (${normalizedMode.toUpperCase()}) terminou com código ${code}`));
                return;
            }
            resolve(String(stdout || '').trim());
        });
    });

    const parsed = JSON.parse(String(rawResult || '{}'));
    if (!Array.isArray(parsed?.rows)) {
        throw new Error(`Robot SAFT (${normalizedMode.toUpperCase()}) devolveu payload inválido.`);
    }
    return {
        year: Number(parsed.year || year),
        month: Number(parsed.month || month),
        rows: parsed.rows,
    };
}

async function runGoffObrigacoesRobot({ mode = 'saft', year, month, nif = '', nome = '' }) {
    if (!GOFF_EMAIL || !GOFF_PASSWORD) {
        throw new Error('Email_goff/Senha_goff não configurados no .env.');
    }
    const normalizedMode = String(mode || '').trim().toLowerCase();
    if (!['saft', 'iva', 'dmrat', 'dmrss', 'm22', 'm10', 'ies', 'ru', 'inventario'].includes(normalizedMode)) {
        throw new Error(`Modo de robô GOFF inválido: ${mode}`);
    }

    const scriptPath = path.isAbsolute(GOFF_OBRIGACOES_ROBOT_SCRIPT)
        ? GOFF_OBRIGACOES_ROBOT_SCRIPT
        : path.resolve(__dirname, GOFF_OBRIGACOES_ROBOT_SCRIPT);
    if (!fs.existsSync(scriptPath)) {
        throw new Error(`Script de obrigações GOFF não encontrado: ${scriptPath}`);
    }

    const args = [
        scriptPath,
        '--mode',
        normalizedMode,
        '--email',
        GOFF_EMAIL,
        '--password',
        GOFF_PASSWORD,
    ];
    if (year !== undefined && year !== null) {
        args.push('--year', String(year));
    }
    if (month !== undefined && month !== null) {
        args.push('--month', String(month));
    }
    if (String(nif || '').trim()) {
        args.push('--nif', String(nif || '').trim());
    }
    if (String(nome || '').trim()) {
        args.push('--nome', String(nome || '').trim());
    }

    const rawResult = await new Promise((resolve, reject) => {
        const child = spawn('node', args, { cwd: __dirname });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += String(chunk || '');
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk || '');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(stderr || `Robot GOFF ${normalizedMode.toUpperCase()} terminou com código ${code}`));
                return;
            }
            resolve(String(stdout || '').trim());
        });
    });

    const parsed = JSON.parse(String(rawResult || '{}'));
    if (!Array.isArray(parsed?.rows)) {
        throw new Error(`Robot GOFF ${normalizedMode.toUpperCase()} devolveu payload inválido.`);
    }

    return {
        year: year !== undefined && year !== null ? Number(year) : null,
        month: month !== undefined && month !== null ? Number(month) : null,
        rows: parsed.rows,
        stats: parsed.stats || null,
        filters: parsed.filters || null,
    };
}

async function runGoffObrigacoesRobotSaft({ year, month, nif = '', nome = '' }) {
    return runGoffObrigacoesRobot({ mode: 'saft', year, month, nif, nome });
}

async function runGoffObrigacoesRobotIva({ year, month, nif = '', nome = '' }) {
    return runGoffObrigacoesRobot({ mode: 'iva', year, month, nif, nome });
}

async function runGoffObrigacoesRobotDmrAt({ year, month, nif = '', nome = '' }) {
    return runGoffObrigacoesRobot({ mode: 'dmrat', year, month, nif, nome });
}

async function runGoffObrigacoesRobotDmrSs({ year, month, nif = '', nome = '' }) {
    return runGoffObrigacoesRobot({ mode: 'dmrss', year, month, nif, nome });
}

async function runGoffObrigacoesRobotM22({ year, nif = '', nome = '' }) {
    return runGoffObrigacoesRobot({ mode: 'm22', year, month: 0, nif, nome });
}

async function runGoffObrigacoesRobotIes({ year, nif = '', nome = '' }) {
    return runGoffObrigacoesRobot({ mode: 'ies', year, month: 0, nif, nome });
}

async function runGoffObrigacoesRobotM10({ year, nif = '', nome = '' }) {
    return runGoffObrigacoesRobot({ mode: 'm10', year, month: 0, nif, nome });
}

async function runGoffObrigacoesRobotRelatorioUnico({ year, nif = '', nome = '' }) {
    return runGoffObrigacoesRobot({ mode: 'ru', year, month: 0, nif, nome });
}

async function runGoffObrigacoesRobotInventario({ year, nif = '', nome = '' }) {
    return runGoffObrigacoesRobot({ mode: 'inventario', year, month: 0, nif, nome });
}

async function runSaftObrigacoesRobotDri({ year, month }) {
    return runSaftObrigacoesRobot({ mode: 'dri', year, month });
}

async function runSaftObrigacoesRobotDmr({ year, month }) {
    return runSaftObrigacoesRobot({ mode: 'dmr', year, month });
}

async function runSaftObrigacoesRobotSaft({ year, month }) {
    return runSaftObrigacoesRobot({ mode: 'saft', year, month });
}

async function runSaftObrigacoesRobotIva({ year, month }) {
    return runSaftObrigacoesRobot({ mode: 'iva', year, month });
}

async function runSaftObrigacoesRobotM22({ year }) {
    return runSaftObrigacoesRobot({ mode: 'm22', year, month: 0 });
}

async function runSaftObrigacoesRobotIes({ year }) {
    return runSaftObrigacoesRobot({ mode: 'ies', year, month: 0 });
}

async function runSaftObrigacoesRobotM10({ year }) {
    return runSaftObrigacoesRobot({ mode: 'm10', year, month: 0 });
}

async function runSaftObrigacoesRobotRelatorioUnico({ year }) {
    return runSaftObrigacoesRobot({ mode: 'relatorio-unico', year, month: 0 });
}

function resolveObrigacaoModeloRow(rows, targetObrigacaoId, labelHints = ['dri']) {
    const list = Array.isArray(rows) ? rows : [];
    const targetId = Number(targetObrigacaoId || 0);
    for (const row of list) {
        const directId = normalizeIntValue(
            pickFirstValue(row, ['id', 'obrigacao_id', 'codigo', 'codigo_obrigacao', 'modelo_id']),
            0
        );
        if (targetId > 0 && directId === targetId) return row;
    }
    for (const row of list) {
        const label = String(
            pickFirstValue(row, ['nome', 'designacao', 'descricao', 'obrigacao_nome', 'titulo']) || ''
        )
            .trim()
            .toLowerCase();
        if (Array.isArray(labelHints) && labelHints.some((token) => token && label.includes(String(token).toLowerCase()))) {
            return row;
        }
    }
    return null;
}

async function syncRecolhaEstadoSupabase({
    customerSourceId,
    obrigacaoId,
    obrigacaoNome,
    periodo,
    rowData,
}) {
    const tableName = await resolveSupabaseTableName(SUPABASE_RECOLHAS_ESCOLHA, [
        'recolhas_estado',
        'recolhas_estados',
    ]);
    const discoveredColumns = await fetchSupabaseTableColumns(tableName);
    const tableColumns =
        Array.isArray(discoveredColumns) && discoveredColumns.length > 0
            ? discoveredColumns
            : tableName === 'recolhas_estado'
                ? RECOLHAS_ESTADO_FALLBACK_COLUMNS
                : discoveredColumns;
    const now = nowIso();
    const entregaSource =
        rowData.dataComprovativoIso ||
        rowData.dataComprovativoRaw ||
        rowData.dataRecebidoIso ||
        rowData.dataRecebidoRaw ||
        '';
    const entregaIso = parseDatePtToIso(entregaSource) || String(entregaSource || '').trim() || null;
    const entregaDate = entregaIso
        ? String(entregaIso).slice(0, 10)
        : (periodo?.tipo === 'anual' ? String(now).slice(0, 10) : null);
    const payload = buildPayloadWithExistingColumns(tableColumns, {
        cliente_id: customerSourceId,
        customer_id: customerSourceId,
        id_cliente: customerSourceId,
        obrigacao_id: obrigacaoId,
        obrigacao_modelo_id: obrigacaoId,
        modelo_id: obrigacaoId,
        id_obrigacao: obrigacaoId,
        codigo_obrigacao: obrigacaoId,
        obrigacao_codigo: obrigacaoId,
        obrigacao_nome: obrigacaoNome,
        nome_obrigacao: obrigacaoNome,
        periodo_tipo: periodo.tipo,
        periodicidade: periodo.tipo,
        ano: periodo.ano,
        year: periodo.ano,
        mes:
            periodo.tipo === 'mensal'
                ? Number(periodo.mes || 0)
                : periodo.tipo === 'trimestral'
                    ? 0
                    : 0,
        month:
            periodo.tipo === 'mensal'
                ? Number(periodo.mes || 0)
                : periodo.tipo === 'trimestral'
                    ? 0
                    : 0,
        trimestre: periodo.tipo === 'trimestral' ? Number(periodo.trimestre || 0) : 0,
        quarter: periodo.tipo === 'trimestral' ? Number(periodo.trimestre || 0) : 0,
        estado: rowData.estado || null,
        estado_codigo: rowData.estado || null,
        status: rowData.estado || null,
        identificacao: rowData.identificacao || null,
        identificador: rowData.identificacao || null,
        data_entrega: entregaDate,
        data_recebido: rowData.dataRecebidoIso || rowData.dataRecebidoRaw || null,
        data_comprovativo: rowData.dataComprovativoIso || rowData.dataComprovativoRaw || null,
        empresa: rowData.empresa || null,
        nif: rowData.nif || null,
        origem: 'saft_dri_robot',
        payload_json: JSON.stringify(rowData.raw || {}),
        atualizado_em: now,
        updated_at: now,
        synced_at: now,
        synced_supabase_at: now,
    });

    const customerCol = pickColumnByCandidates(tableColumns, ['cliente_id', 'customer_id', 'id_cliente'], 'cliente_id');
    const obrigacaoCol = pickColumnByCandidates(
        tableColumns,
        ['obrigacao_modelo_id', 'obrigacao_id', 'id_obrigacao', 'codigo_obrigacao', 'obrigacao_codigo', 'modelo_id'],
        'obrigacao_id'
    );
    const anoCol = pickColumnByCandidates(tableColumns, ['ano', 'year'], 'ano');
    const mesCol = pickColumnByCandidates(tableColumns, ['mes', 'month'], 'mes');
    const trimestreCol = pickColumnByCandidates(tableColumns, ['trimestre', 'quarter'], 'trimestre');

    const filters = {
        [customerCol]: customerSourceId,
        [obrigacaoCol]: obrigacaoId,
        [anoCol]: periodo.ano,
    };
    if (periodo.tipo === 'mensal') {
        filters[mesCol] = periodo.mes;
    } else if (periodo.tipo === 'trimestral') {
        filters[trimestreCol] = periodo.trimestre;
    } else if (periodo.tipo === 'anual') {
        filters[mesCol] = 0;
        filters[trimestreCol] = 0;
    }

    const conflictColumns = Object.keys(filters || {}).filter(Boolean);
    try {
        const upserted = await upsertSupabaseRow(tableName, payload, conflictColumns);
        return { action: 'upserted', row: upserted?.[0] || null };
    } catch (error) {
        const updated = await patchSupabaseTableWithFilters(tableName, payload, filters);
        if (Array.isArray(updated) && updated.length > 0) {
            return { action: 'updated', row: updated[0] };
        }

        const inserted = await insertSupabaseRow(tableName, payload);
        return { action: 'inserted', row: inserted?.[0] || null };
    }
}

async function updateObrigacaoPeriodoSupabase({
    customerSourceId,
    obrigacaoId,
    periodo,
    estadoFinal,
}) {
    const periodTableName = await resolveObrigacoesPeriodTableName(periodo);
    const tableColumns = await fetchSupabaseTableColumns(periodTableName);

    const customerCol = pickColumnByCandidates(tableColumns, ['cliente_id', 'customer_id', 'id_cliente'], 'cliente_id');
    const obrigacaoCol = pickColumnByCandidates(
        tableColumns,
        ['obrigacao_modelo_id', 'obrigacao_id', 'id_obrigacao', 'codigo_obrigacao', 'obrigacao_codigo', 'modelo_id'],
        'obrigacao_id'
    );
    const estadoCol = pickColumnByCandidates(
        tableColumns,
        ['estado', 'estado_id', 'status', 'situacao', 'estado_codigo'],
        'estado'
    );
    const anoCol = pickColumnByCandidates(tableColumns, ['ano', 'year'], 'ano');
    const mesCol = pickColumnByCandidates(tableColumns, ['mes', 'month'], 'mes');
    const trimestreCol = pickColumnByCandidates(tableColumns, ['trimestre', 'quarter'], 'trimestre');

    const payload = buildPayloadWithExistingColumns(tableColumns, {
        [estadoCol]: Number(estadoFinal),
        atualizado_em: nowIso(),
        updated_at: nowIso(),
    });

    const filters = {
        [customerCol]: customerSourceId,
        [obrigacaoCol]: obrigacaoId,
        [anoCol]: periodo.ano,
    };
    if (periodo.tipo === 'mensal') {
        filters[mesCol] = periodo.mes;
    } else if (periodo.tipo === 'trimestral') {
        filters[trimestreCol] = periodo.trimestre;
    }

    const updated = await patchSupabaseTableWithFilters(periodTableName, payload, filters);
    const updatedRows = Array.isArray(updated) ? updated.length : 0;
    if (updatedRows > 0) {
        return {
            table: periodTableName,
            updatedRows,
            action: 'updated',
        };
    }

    const insertPayload = buildPayloadWithExistingColumns(tableColumns, {
        [customerCol]: customerSourceId,
        [obrigacaoCol]: obrigacaoId,
        [anoCol]: periodo.ano,
        [mesCol]: periodo.tipo === 'mensal' ? Number(periodo.mes || 0) : null,
        [trimestreCol]: periodo.tipo === 'trimestral' ? Number(periodo.trimestre || 0) : null,
        [estadoCol]: Number(estadoFinal),
        atualizado_em: nowIso(),
        updated_at: nowIso(),
    });

    const inserted = await insertSupabaseRow(periodTableName, insertPayload);
    return {
        table: periodTableName,
        updatedRows: Array.isArray(inserted) ? inserted.length : 0,
        action: 'inserted',
    };
}

async function resolveObrigacoesPeriodTableName(periodo) {
    const yearSuffixTable = `${SUPABASE_OBRIGACOES_PERIODOS_PREFIX}${periodo.ano}`;
    const basePeriodTable = SUPABASE_OBRIGACOES_PERIODOS_PREFIX.endsWith('_')
        ? SUPABASE_OBRIGACOES_PERIODOS_PREFIX.slice(0, -1)
        : SUPABASE_OBRIGACOES_PERIODOS_PREFIX;
    return resolveSupabaseTableName(yearSuffixTable, [
        basePeriodTable,
        'clientes_obrigacoes_periodos',
        'clientes_obrigacoes_periodos_old',
    ]);
}

async function loadLocalCollectedSets({ obrigacaoId, periodo, statusClassifier }) {
    let query = `
        SELECT customer_id, customer_source_id, estado_codigo, payload_json
        FROM obrigacoes_recolhas
        WHERE obrigacao_id = ?
          AND periodo_ano = ?
          AND synced_supabase_at IS NOT NULL
    `;
    const params = [Number(obrigacaoId), Number(periodo.ano)];

    if (periodo.tipo === 'mensal') {
        query += ' AND periodo_mes = ?';
        params.push(Number(periodo.mes || 0));
    } else if (periodo.tipo === 'trimestral') {
        query += ' AND periodo_trimestre = ?';
        params.push(Number(periodo.trimestre || 0));
    }

    const rows = await dbAllAsync(query, params);
    const localCustomerIds = new Set();
    const sourceCustomerIds = new Set();
    rows.forEach((row) => {
        let payload = null;
        let estadoAt = '';
        try {
            payload = row?.payload_json ? JSON.parse(String(row.payload_json || '{}')) : null;
            estadoAt = String(payload?.estadoAt || payload?.estado_at || '').trim();
        } catch (error) {
            payload = null;
            estadoAt = '';
        }
        const classifier =
            typeof statusClassifier === 'function'
                ? statusClassifier
                : (estado, estadoAtLocal) => classifyObrigacaoEstado(estado, estadoAtLocal);
        const statusCheck = classifier(row?.estado_codigo, estadoAt, payload);
        if (!statusCheck.isSuccess) return;

        const localId = String(row?.customer_id || '').trim();
        if (localId) localCustomerIds.add(localId);
        const sourceId = String(row?.customer_source_id || '').trim();
        if (sourceId) sourceCustomerIds.add(sourceId);
    });
    return { localCustomerIds, sourceCustomerIds };
}

async function loadSupabaseCollectedSourceIds({ obrigacaoId, periodo }) {
    const tableName = await resolveObrigacoesPeriodTableName(periodo);
    const tableColumns = await fetchSupabaseTableColumns(tableName);
    const customerCol = pickColumnByCandidates(tableColumns, ['cliente_id', 'customer_id', 'id_cliente'], 'cliente_id');
    const obrigacaoCol = pickColumnByCandidates(
        tableColumns,
        ['obrigacao_modelo_id', 'obrigacao_id', 'id_obrigacao', 'codigo_obrigacao', 'obrigacao_codigo', 'modelo_id'],
        'obrigacao_modelo_id'
    );
    const estadoCol = pickColumnByCandidates(
        tableColumns,
        ['estado_id', 'estado', 'status', 'situacao', 'estado_codigo'],
        'estado_id'
    );
    const anoCol = pickColumnByCandidates(tableColumns, ['ano', 'year'], 'ano');
    const mesCol = pickColumnByCandidates(tableColumns, ['mes', 'month'], 'mes');
    const trimestreCol = pickColumnByCandidates(tableColumns, ['trimestre', 'quarter'], 'trimestre');

    const sourceIds = new Set();
    const pageSize = 1000;
    let offset = 0;

    while (true) {
        const params = new URLSearchParams();
        params.set('select', customerCol);
        params.set(obrigacaoCol, `eq.${Number(obrigacaoId)}`);
        params.set(anoCol, `eq.${Number(periodo.ano)}`);
        params.set(estadoCol, 'eq.4');
        if (periodo.tipo === 'mensal') {
            params.set(mesCol, `eq.${Number(periodo.mes || 0)}`);
        } else if (periodo.tipo === 'trimestral') {
            params.set(trimestreCol, `eq.${Number(periodo.trimestre || 0)}`);
        }
        params.set('limit', String(pageSize));
        params.set('offset', String(offset));

        const response = await axios.get(`${SUPABASE_URL}/rest/v1/${tableName}?${params.toString()}`, {
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
            timeout: 15000,
        });

        const rows = Array.isArray(response.data) ? response.data : [];
        rows.forEach((row) => {
            const sourceId = String(row?.[customerCol] || '').trim();
            if (sourceId) sourceIds.add(sourceId);
        });

        if (rows.length < pageSize) break;
        offset += pageSize;
    }

    return { tableName, sourceIds };
}

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

    if (isBaileysProviderEnabled()) {
        await processQueueJobViaBaileys({
            job,
            queueId,
            conversationId,
            messageKind,
            toNumber,
            queueVariables,
            accountId,
        });
        return;
    }

    let requestBody = {
        messaging_product: 'whatsapp',
        to: toNumber,
    };

    const uploadWhatsappMediaFile = async (input) => {
        const mediaPath = path.resolve(String(input.path || '').trim());
        if (!mediaPath) {
            throw new Error('Ficheiro sem caminho no servidor.');
        }
        await fs.promises.access(mediaPath, fs.constants.R_OK);
        const stats = await fs.promises.stat(mediaPath);
        if (!stats.isFile()) {
            throw new Error(`Ficheiro inválido: ${mediaPath}`);
        }

        const detectedFileName = String(input.fileName || '').trim() || path.basename(mediaPath);
        const mimeType = String(input.mimeType || '').trim() || (String(input.kind || '') === 'document' ? 'application/octet-stream' : 'image/jpeg');
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', mimeType);
        form.append('file', fs.createReadStream(mediaPath), {
            filename: detectedFileName,
            contentType: mimeType,
        });

        const uploadResponse = await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/media`,
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                ...form.getHeaders(),
            },
            data: form,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 45000,
        });

        const mediaId = String(uploadResponse?.data?.id || '').trim();
        if (!mediaId) {
            throw new Error('Meta não devolveu media id.');
        }

        return {
            mediaId,
            fileName: detectedFileName,
            mimeType,
            mediaPath,
        };
    };

    let uploadedMediaInfo = null;

    if (messageKind === 'meta_template') {
        requestBody.type = 'template';
        requestBody.template = {
            name: String(job.template_name || 'hello_world').trim() || 'hello_world',
            language: { code: 'en_US' },
        };
    } else if (messageKind === 'image' || messageKind === 'document') {
        const mediaPayloadKey = messageKind === 'document' ? '__document' : '__image';
        const mediaPayload = queueVariables && typeof queueVariables === 'object' ? queueVariables[mediaPayloadKey] : null;
        const mediaPath = String(mediaPayload?.path || '').trim();
        if (!mediaPath) {
            await markQueueAsFailed(job, messageKind === 'document' ? 'Mensagem de documento sem caminho do ficheiro.' : 'Mensagem de imagem sem caminho do ficheiro.', false);
            logChatCore(messageKind === 'document' ? 'queue_document_missing_path' : 'queue_image_missing_path', {
                queueId,
                conversationId,
                to: toNumber,
            });
            return;
        }
        try {
            uploadedMediaInfo = await uploadWhatsappMediaFile({
                path: mediaPath,
                fileName: String(mediaPayload?.fileName || '').trim(),
                mimeType: String(mediaPayload?.mimeType || '').trim(),
                kind: messageKind,
            });
        } catch (uploadError) {
            const message = uploadError?.response?.data || uploadError?.message || uploadError;
            const errorText = typeof message === 'string' ? message : JSON.stringify(message);
            const isPermanent =
                /enoent|eacces|inválido|invalido|sem caminho|is not a file|invalid/i.test(errorText);
            const retryAllowed = !isPermanent && Number(job.retry_count || 0) < MAX_QUEUE_RETRIES;
            await markQueueAsFailed(job, messageKind === 'document' ? `Falha upload documento: ${errorText}` : `Falha upload imagem: ${errorText}`, retryAllowed);
            logChatCore(messageKind === 'document' ? 'queue_document_upload_error' : 'queue_image_upload_error', {
                queueId,
                conversationId,
                to: toNumber,
                retryAllowed,
                error: String(errorText || '').slice(0, 500),
            });
            return;
        }

        const caption = String(job.message_body || '').trim();
        if (messageKind === 'document') {
            requestBody.type = 'document';
            requestBody.document = {
                id: uploadedMediaInfo.mediaId,
                filename: String(uploadedMediaInfo.fileName || '').trim() || undefined,
            };
            if (caption) {
                requestBody.document.caption = caption.slice(0, 1024);
            }
        } else {
            requestBody.type = 'image';
            requestBody.image = {
                id: uploadedMediaInfo.mediaId,
            };
            if (caption) {
                requestBody.image.caption = caption.slice(0, 1024);
            }
        }
    } else {
        requestBody.type = 'text';
        requestBody.text = {
            body: String(job.message_body || '').trim(),
        };
    }

    if (requestBody.type === 'text' && !requestBody.text.body) {
        await markQueueAsFailed(job, 'Mensagem vazia para envio de texto', false);
        logChatCore('queue_empty_message', {
            queueId,
            conversationId,
            messageKind,
            to: toNumber,
        });
        return;
    }

    try {
        const response = await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v17.0/${PHONE_NUMBER_ID}/messages`,
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                'Content-Type': 'application/json',
            },
            data: requestBody,
            timeout: 15000,
        });

        const waId = response.data?.messages?.[0]?.id || null;
        const bodyForLog =
            requestBody.type === 'template'
                ? `Template: ${requestBody.template?.name || 'meta_template'}`
                : requestBody.type === 'image'
                    ? `[Imagem] ${String(uploadedMediaInfo?.fileName || 'imagem')}${requestBody.image?.caption ? `\n${String(requestBody.image.caption)}` : ''}`
                    : requestBody.type === 'document'
                        ? `[Documento] ${String(uploadedMediaInfo?.fileName || 'documento')}${requestBody.document?.caption ? `\n${String(requestBody.document.caption)}` : ''}`
                    : requestBody.text.body;
        const mediaKindForInsert =
            requestBody.type === 'image' || requestBody.type === 'document' ? requestBody.type : null;
        const mediaPathForInsert = String(uploadedMediaInfo?.mediaPath || '').trim() || null;
        const mediaMimeTypeForInsert = String(uploadedMediaInfo?.mimeType || '').trim() || null;
        const mediaFileNameForInsert = String(uploadedMediaInfo?.fileName || '').trim() || null;
        const mediaRemoteIdForInsert = String(uploadedMediaInfo?.mediaId || '').trim() || null;

        await dbRunAsync(
            `INSERT OR IGNORE INTO messages (
                wa_id, account_id, from_number, body, direction, status,
                media_kind, media_path, media_mime_type, media_file_name, media_provider, media_remote_id
            ) VALUES (?, ?, ?, ?, 'outbound', 'submitted', ?, ?, ?, ?, 'cloud', ?)`,
            [
                waId,
                accountId || null,
                toNumber,
                bodyForLog,
                mediaKindForInsert,
                mediaPathForInsert,
                mediaMimeTypeForInsert,
                mediaFileNameForInsert,
                mediaRemoteIdForInsert,
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
            whatsappAccountId: accountId,
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
                accountId,
            },
        });

        emitChatEvent('outbound_sent', {
            queueId,
            conversationId,
            to: toNumber,
            waId: waId || null,
            messageKind,
            accountId,
        });
        logChatCore('queue_sent', {
            queueId,
            conversationId,
            to: toNumber,
            waId: waId || null,
            messageKind,
            accountId,
        });
    } catch (error) {
        const details = error?.response?.data || error?.message || error;
        const message = typeof details === 'string' ? details : JSON.stringify(details);
        const retryCount = Number(job.retry_count || 0);
        const willRetry = retryCount < MAX_QUEUE_RETRIES;
        await markQueueAsFailed(job, message, willRetry);
        await writeAuditLog({
            actorUserId: job.created_by || null,
            entityType: 'outbound_queue',
            entityId: String(job.id),
            action: willRetry ? 'retry_scheduled' : 'failed',
            details: {
                queueId,
                to: toNumber,
                kind: messageKind,
                error: message,
                retryCount: retryCount + 1,
                conversationId,
                accountId,
            },
        });
    }
}

let queueWorkerRunning = false;
let queueWorkerBootstrapped = false;

async function processOutboundQueue(limit = 5) {
    if (queueWorkerRunning) return;
    if (isCloudProviderEnabled() && !isWhatsAppCloudConfigured()) return;
    if (isBaileysProviderEnabled() && baileysGateways.size === 0) return;

    queueWorkerRunning = true;
    try {
        const jobs = await dbAllAsync(
            `SELECT id, conversation_id, to_number, message_kind, message_body, template_name,
                    account_id, variables_json, status, retry_count, next_attempt_at, created_by
             FROM outbound_queue
             WHERE status IN ('queued', 'retry')
               AND datetime(next_attempt_at) <= datetime('now')
             ORDER BY id ASC
             LIMIT ?`,
            [limit]
        );

        for (const job of jobs) {
            await dbRunAsync(
                `UPDATE outbound_queue
                 SET status = 'processing', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [job.id]
            );
            await processQueueJob(job);
        }
    } catch (error) {
        console.error('[Queue] Erro no worker:', error?.message || error);
    } finally {
        queueWorkerRunning = false;
    }
}

function bootstrapQueueWorker() {
    if (queueWorkerBootstrapped) return;
    queueWorkerBootstrapped = true;

    setInterval(() => {
        void processOutboundQueue();
    }, 4000);
}

let saftWorkerRunning = false;
let saftWorkerBootstrapped = false;

async function processPendingSaftJobs(localPort, limit = 3) {
    if (saftWorkerRunning) return;
    if (!localPort) return;

    saftWorkerRunning = true;
    try {
        const jobs = await dbAllAsync(
            `SELECT id, customer_id, conversation_id, document_type, requested_by
             FROM saft_jobs
             WHERE status = 'pending'
               AND datetime(updated_at) <= datetime('now', '-2 minutes')
             ORDER BY id ASC
             LIMIT ?`,
            [limit]
        );
        for (const job of jobs) {
            try {
                await axios({
                    method: 'POST',
                    url: `http://127.0.0.1:${localPort}/api/saft/fetch-and-send`,
                    headers: { 'Content-Type': 'application/json' },
                    data: {
                        customerId: String(job.customer_id || '').trim(),
                        conversationId: String(job.conversation_id || '').trim(),
                        documentType: String(job.document_type || '').trim(),
                        requestedBy: String(job.requested_by || '').trim() || null,
                        jobId: Number(job.id || 0),
                    },
                    timeout: 45000,
                    validateStatus: () => true,
                });
            } catch (error) {
                console.error('[SAFT Worker] Erro ao reprocessar job pendente:', error?.message || error);
            }
        }
    } catch (error) {
        console.error('[SAFT Worker] Falha no ciclo:', error?.message || error);
    } finally {
        saftWorkerRunning = false;
    }
}

function bootstrapSaftWorker(localPort) {
    if (saftWorkerBootstrapped) return;
    saftWorkerBootstrapped = true;
    setInterval(() => {
        void processPendingSaftJobs(localPort);
    }, 30000);
}

let obrigacoesAutoRunning = false;
let obrigacoesAutoBootstrapped = false;
let obrigacoesAutoTimer = null;
const obrigacoesAutoState = {
    enabled: OBRIGACOES_AUTO_ENABLED,
    hour: OBRIGACOES_AUTO_HOUR,
    minute: OBRIGACOES_AUTO_MINUTE,
    timezone: OBRIGACOES_AUTO_TIMEZONE || null,
    running: false,
    lastRunAt: null,
    lastFinishedAt: null,
    nextRunAt: null,
    lastSummary: null,
    lastError: null,
};

async function runObrigacoesAutoCollection(localPort) {
    if (obrigacoesAutoRunning) return null;
    obrigacoesAutoRunning = true;
    obrigacoesAutoState.running = true;
    obrigacoesAutoState.lastRunAt = nowIso();
    obrigacoesAutoState.lastError = null;

    const runStartedAt = new Date();
    const previousMonth = resolveShiftedYearMonth(runStartedAt, 1);
    const ivaMonth = resolveShiftedYearMonth(runStartedAt, 2);
    const annualYear = runStartedAt.getFullYear() - 1;
    const monthlyPayload = {
        dryRun: false,
        force: false,
    };
    const annualPayload = {
        year: annualYear,
        dryRun: false,
        force: false,
    };

    const jobs = [
        { route: 'dri', payload: { ...monthlyPayload, year: previousMonth.year, month: previousMonth.month }, timeoutMs: 8 * 60 * 1000 },
        { route: 'dmr', payload: { ...monthlyPayload, year: previousMonth.year, month: previousMonth.month }, timeoutMs: 8 * 60 * 1000 },
        { route: 'saft', payload: { ...monthlyPayload, year: previousMonth.year, month: previousMonth.month }, timeoutMs: 8 * 60 * 1000 },
        { route: 'iva', payload: { ...monthlyPayload, year: ivaMonth.year, month: ivaMonth.month, async: false }, timeoutMs: 25 * 60 * 1000 },
        { route: 'm22', payload: annualPayload, timeoutMs: 12 * 60 * 1000 },
        { route: 'ies', payload: annualPayload, timeoutMs: 12 * 60 * 1000 },
        { route: 'm10', payload: annualPayload, timeoutMs: 12 * 60 * 1000 },
        { route: 'relatorio-unico', payload: annualPayload, timeoutMs: 12 * 60 * 1000 },
    ];

    const summary = {
        startedAt: nowIso(),
        rules: {
            monthlyYear: previousMonth.year,
            monthlyMonth: previousMonth.month,
            ivaYear: ivaMonth.year,
            ivaMonth: ivaMonth.month,
            annualYear,
        },
        jobs: [],
        ok: 0,
        failed: 0,
    };

    try {
        for (const job of jobs) {
            const startedAt = nowIso();
            try {
                const response = await axios({
                    method: 'POST',
                    url: `http://127.0.0.1:${localPort}/api/import/obrigacoes/${job.route}`,
                    headers: { 'Content-Type': 'application/json' },
                    data: job.payload,
                    timeout: job.timeoutMs,
                    validateStatus: () => true,
                });
                const payload = response?.data || {};
                const success = response.status >= 200 && response.status < 300 && payload?.success === true;
                if (success) {
                    summary.ok += 1;
                } else {
                    summary.failed += 1;
                }
                summary.jobs.push({
                    route: job.route,
                    payload: job.payload,
                    statusCode: response.status,
                    success,
                    startedAt,
                    finishedAt: nowIso(),
                    result: payload?.result || null,
                    error: success ? null : payload?.error || `HTTP ${response.status}`,
                });
            } catch (error) {
                summary.failed += 1;
                summary.jobs.push({
                    route: job.route,
                    payload: job.payload,
                    statusCode: null,
                    success: false,
                    startedAt,
                    finishedAt: nowIso(),
                    result: null,
                    error: String(error?.message || error),
                });
            }
        }
        summary.finishedAt = nowIso();
        await writeAuditLog({
            actorUserId: null,
            entityType: 'obrigacoes_auto_scheduler',
            entityId: summary.startedAt,
            action: summary.failed > 0 ? 'completed_with_errors' : 'completed',
            details: summary,
        });
        return summary;
    } catch (error) {
        const details = String(error?.message || error);
        obrigacoesAutoState.lastError = details;
        await writeAuditLog({
            actorUserId: null,
            entityType: 'obrigacoes_auto_scheduler',
            entityId: nowIso(),
            action: 'failed',
            details: { error: details, partialSummary: summary },
        });
        return {
            ...summary,
            finishedAt: nowIso(),
            failed: summary.failed + 1,
            fatalError: details,
        };
    } finally {
        obrigacoesAutoRunning = false;
        obrigacoesAutoState.running = false;
        obrigacoesAutoState.lastFinishedAt = nowIso();
    }
}

function scheduleNextObrigacoesAutoRun(localPort) {
    if (!OBRIGACOES_AUTO_ENABLED) return;
    if (obrigacoesAutoTimer) {
        clearTimeout(obrigacoesAutoTimer);
        obrigacoesAutoTimer = null;
    }

    const nextRunAt = computeNextDailyRunAt(OBRIGACOES_AUTO_HOUR, OBRIGACOES_AUTO_MINUTE, OBRIGACOES_AUTO_TIMEZONE || undefined);
    obrigacoesAutoState.nextRunAt = nextRunAt.toISOString();
    const delayMs = Math.max(1000, nextRunAt.getTime() - Date.now());

    console.log(
        `[Auto Obrigações] Próxima recolha agendada para ${nextRunAt.toISOString()}${
            OBRIGACOES_AUTO_TIMEZONE ? ` (${OBRIGACOES_AUTO_TIMEZONE})` : ''
        }`
    );

    obrigacoesAutoTimer = setTimeout(async () => {
        try {
            const summary = await runObrigacoesAutoCollection(localPort);
            obrigacoesAutoState.lastSummary = summary;
            if (summary?.failed > 0) {
                console.warn(`[Auto Obrigações] Concluído com falhas. OK=${summary.ok} Falhas=${summary.failed}`);
            } else {
                console.log(`[Auto Obrigações] Concluído com sucesso. Jobs OK=${summary?.ok || 0}`);
            }
        } catch (error) {
            const details = String(error?.message || error);
            obrigacoesAutoState.lastError = details;
            console.error('[Auto Obrigações] Falha no agendamento:', details);
        } finally {
            scheduleNextObrigacoesAutoRun(localPort);
        }
    }, delayMs);
}

function bootstrapObrigacoesAutoScheduler(localPort) {
    if (obrigacoesAutoBootstrapped) return;
    obrigacoesAutoBootstrapped = true;

    if (!OBRIGACOES_AUTO_ENABLED) {
        console.log('[Auto Obrigações] Scheduler desativado (OBRIGACOES_AUTO_ENABLED=false).');
        return;
    }
    scheduleNextObrigacoesAutoRun(localPort);
}

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
if (isCloudProviderEnabled()) {
    console.log("Token:", TOKEN ? "Carregado (OK)" : "❌ VAZIO");
    console.log("Phone ID:", PHONE_NUMBER_ID || "❌ VAZIO");
} else {
    console.log(
        "Baileys Contas:",
        BAILEYS_ACCOUNT_CONFIGS.map((account) =>
            `${account.id}${account.id === ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID ? ' (default)' : ''} -> ${account.authDir}`
        ).join(' | ')
    );
}
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
    isRunning: () => obrigacoesAutoRunning,
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
        TELEGRAM_BOT_TOKEN,
        TELEGRAM_WEBHOOK_SECRET,
        TELEGRAM_WEBHOOK_PATH,
        TELEGRAM_USER_API_ID,
        TELEGRAM_USER_API_HASH,
        TELEGRAM_USER_SESSION,
        TELEGRAM_USER_CHECK_INTERVAL_MS,
        whatsappProvider: ACTIVE_WHATSAPP_PROVIDER,
        whatsappCloudToken: TOKEN,
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
