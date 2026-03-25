const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INTERNAL_CHAT_MEDIA_ROOT = process.env.INTERNAL_CHAT_MEDIA_ROOT
    ? path.resolve(process.env.INTERNAL_CHAT_MEDIA_ROOT)
    : path.resolve(process.cwd(), 'internal_chat_media');
const MAX_INTERNAL_MEDIA_BYTES = 20 * 1024 * 1024;
const INTERNAL_AI_MAX_SITES = 4;
const INTERNAL_AI_MAX_SUBPAGES_PER_SITE = 1;
const INTERNAL_AI_SITE_EXCERPT_CHARS = 2200;
const INTERNAL_AI_RESPONSE_MAX_CHARS = 2800;
const INTERNAL_AI_DEFAULT_TRUSTED_SOURCES = [
    'https://www.portaldasfinancas.gov.pt/',
    'https://info.portaldasfinancas.gov.pt/',
    'https://diariodarepublica.pt/',
    'https://www.occ.pt/',
    'https://www.seg-social.pt/',
    'https://eur-lex.europa.eu/',
];
let supabasePedidosStatusWatcherTimer = null;
let supabasePedidosStatusWatcherBootstrapped = false;
let supabasePedidosStatusWatcherRunning = false;
let supabasePedidosTrackingSchemaReady = false;
let supabasePedidosLegacyBootstrapDone = false;
let supabasePedidosLegacyBootstrapAtMs = 0;
let internalChatPresenceSchemaReady = false;
let softwareLinksSchemaReady = false;
let internalChatSupabaseSyncSchemaReady = false;
let internalChatReactionsSchemaReady = false;
let internalChatSupabaseHistorySyncRunning = false;

function registerLocalDataRoutes(context) {
    const {
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
        normalizeDigits = (value) => String(value || '').replace(/\D+/g, ''),
        normalizeLookupText = (value) =>
            String(value || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, ' ')
                .trim(),
        parseSourceId = (_id, explicitSourceId) => String(explicitSourceId || '').trim(),
        parseCustomerSourceId = (_id, explicitSourceId) => String(explicitSourceId || '').trim(),
        nowIso = () => new Date().toISOString(),
    } = context;

    function sanitizeInternalFileName(inputName) {
        const raw = String(inputName || '').trim();
        const normalized = raw
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .trim();
        return normalized || 'ficheiro';
    }

    async function ensureInternalMediaRoot() {
        await fs.promises.mkdir(INTERNAL_CHAT_MEDIA_ROOT, { recursive: true });
    }

    function resolveInternalMediaAbsolutePath(relativePath) {
        const safeRelative = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const resolved = path.resolve(INTERNAL_CHAT_MEDIA_ROOT, safeRelative);
        const rootWithSep = INTERNAL_CHAT_MEDIA_ROOT.endsWith(path.sep)
            ? INTERNAL_CHAT_MEDIA_ROOT
            : `${INTERNAL_CHAT_MEDIA_ROOT}${path.sep}`;
        if (resolved !== INTERNAL_CHAT_MEDIA_ROOT && !resolved.startsWith(rootWithSep)) {
            throw new Error('Caminho de media inválido.');
        }
        return resolved;
    }

    function mapInternalMessageRow(row) {
        const messageId = Number(row.id || 0);
        const readByCount = Math.max(0, Number(row.read_by_count || 0));
        const totalRecipients = Math.max(0, Number(row.total_recipients || 0));
        return {
            id: messageId,
            conversationId: String(row.conversation_id || '').trim(),
            senderUserId: String(row.sender_user_id || '').trim(),
            senderName: String(row.sender_name || '').trim() || 'Funcionário',
            senderAvatar: String(row.sender_avatar || '').trim() || '',
            body: row.deleted_at ? '' : String(row.body || ''),
            type: String(row.type || 'text').trim(),
            replyToMessageId: row.reply_to_message_id ? Number(row.reply_to_message_id) : null,
            editedAt: row.edited_at ? String(row.edited_at) : null,
            deletedAt: row.deleted_at ? String(row.deleted_at) : null,
            createdAt: String(row.created_at || '').trim(),
            mediaPath: String(row.media_path || '').trim() || null,
            mimeType: String(row.mime_type || '').trim() || null,
            fileName: String(row.file_name || '').trim() || null,
            fileSize: Number(row.file_size || 0) || null,
            mediaUrl: row.media_path ? `/api/internal-chat/media/${messageId}` : null,
            readByCount,
            totalRecipients,
            readByNames: Array.isArray(row.read_by_names) ? row.read_by_names : [],
            reactions: Array.isArray(row.reactions) ? row.reactions : [],
        };
    }

    function normalizeSourceTaskStatus(rawStatus) {
        const value = String(rawStatus || '').trim().toLowerCase();
        if (!value) return 'open';
        if (['realizada', 'resolvida', 'resolvido', 'executado', 'done', 'concluida', 'concluído'].includes(value)) {
            return 'done';
        }
        if (['em progresso', 'em_andamento', 'in_progress', 'progresso'].includes(value)) {
            return 'in_progress';
        }
        if (['aguarda', 'aguardar', 'waiting'].includes(value)) {
            return 'waiting';
        }
        return 'open';
    }

    function normalizeSourceTaskPriority(rawType, rawStatus) {
        const typeValue = String(rawType || '').trim().toLowerCase();
        const statusValue = String(rawStatus || '').trim().toLowerCase();
        if (typeValue.includes('urgent') || typeValue.includes('urgente') || statusValue.includes('atrasad')) {
            return 'urgent';
        }
        return 'normal';
    }

    function toIsoDateTime(value) {
        const raw = String(value || '').trim();
        if (!raw) return nowIso();

        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
            return `${raw}T12:00:00.000Z`;
        }

        if (/^\d{2}\/\d{2}\/\d{4}$/.test(raw)) {
            const [day, month, year] = raw.split('/');
            return `${year}-${month}-${day}T12:00:00.000Z`;
        }

        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }

        return nowIso();
    }

    function buildFallbackTaskSourceId(row) {
        const seed = [
            row?.titulo,
            row?.title,
            row?.cliente,
            row?.prazo,
            row?.data_inicio,
            row?.created_at,
            row?.notas,
        ]
            .map((value) => String(value || '').trim())
            .join('|');
        const hash = crypto.createHash('sha1').update(seed || nowIso()).digest('hex').slice(0, 20);
        return `legacy_${hash}`;
    }

    function extractNifCandidates(value) {
        const text = String(value || '').trim();
        if (!text) return [];

        const directDigits = normalizeDigits(text);
        const candidates = [];
        if (directDigits.length === 9) {
            candidates.push(directDigits);
        }

        const regexMatches = text.match(/\b\d{9}\b/g) || [];
        regexMatches.forEach((item) => candidates.push(String(item)));

        return Array.from(new Set(candidates));
    }

    function appendLookupIndex(map, key, payload) {
        if (!key) return;
        const current = map.get(key);
        if (current) {
            current.push(payload);
            return;
        }
        map.set(key, [payload]);
    }

    function parseBoolean(value) {
        const normalized = String(value ?? '').trim().toLowerCase();
        if (!normalized) return false;
        return ['1', 'true', 'yes', 'on', 'sim'].includes(normalized);
    }

    async function ensureInternalChatPresenceSchema() {
        if (internalChatPresenceSchemaReady) return;
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS internal_chat_presence (
                user_id TEXT PRIMARY KEY,
                last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                source TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        await dbRunAsync(
            `CREATE INDEX IF NOT EXISTS idx_internal_chat_presence_last_seen
             ON internal_chat_presence(last_seen_at)`
        );
        internalChatPresenceSchemaReady = true;
    }

    async function ensureInternalMessageReactionsSchema() {
        if (internalChatReactionsSchemaReady) return;
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS internal_message_reactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL,
                user_id TEXT NOT NULL,
                emoji TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        await dbRunAsync(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_message_reactions_unique
             ON internal_message_reactions(message_id, user_id, emoji)`
        );
        await dbRunAsync(
            `CREATE INDEX IF NOT EXISTS idx_internal_message_reactions_message
             ON internal_message_reactions(message_id, created_at)`
        );
        internalChatReactionsSchemaReady = true;
    }

    function normalizePresenceDate(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const isoLike = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
        const parsed = new Date(isoLike);
        if (!Number.isFinite(parsed.getTime())) return '';
        return parsed.toISOString();
    }

    async function touchInternalChatPresence(userId, source = '') {
        const normalizedUserId = String(userId || '').trim();
        if (!normalizedUserId) return;
        await ensureInternalChatPresenceSchema();
        await dbRunAsync(
            `INSERT INTO internal_chat_presence (user_id, last_seen_at, source, updated_at)
             VALUES (?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(user_id) DO UPDATE SET
                last_seen_at = CURRENT_TIMESTAMP,
                source = excluded.source,
                updated_at = CURRENT_TIMESTAMP`,
            [normalizedUserId, String(source || '').trim() || null]
        );
    }

    async function readInternalChatPresence(userIds = [], onlineWindowSeconds = 75) {
        await ensureInternalChatPresenceSchema();
        const normalizedIds = Array.from(
            new Set((Array.isArray(userIds) ? userIds : []).map((item) => String(item || '').trim()).filter(Boolean))
        );

        let rows = [];
        if (normalizedIds.length > 0) {
            const placeholders = normalizedIds.map(() => '?').join(', ');
            rows = await dbAllAsync(
                `SELECT
                    u.id AS user_id,
                    u.name AS name,
                    p.last_seen_at AS last_seen_at
                 FROM users u
                 LEFT JOIN internal_chat_presence p ON p.user_id = u.id
                 WHERE u.id IN (${placeholders})`,
                normalizedIds
            );
        } else {
            rows = await dbAllAsync(
                `SELECT
                    u.id AS user_id,
                    u.name AS name,
                    p.last_seen_at AS last_seen_at
                 FROM users u
                 LEFT JOIN internal_chat_presence p ON p.user_id = u.id`
            );
        }

        const onlineWindowMs = Math.max(15, Number(onlineWindowSeconds || 75)) * 1000;
        const nowMs = Date.now();
        return rows.map((row) => {
            const lastSeenAt = normalizePresenceDate(row?.last_seen_at);
            const isOnline = !!lastSeenAt && (nowMs - new Date(lastSeenAt).getTime()) <= onlineWindowMs;
            return {
                userId: String(row?.user_id || '').trim(),
                name: String(row?.name || '').trim(),
                lastSeenAt: lastSeenAt || null,
                isOnline,
            };
        });
    }

    async function ensureSoftwareLinksSchema() {
        if (softwareLinksSchemaReady) return;
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS software_links (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                url TEXT,
                image_url TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_by TEXT
            )`
        );
        const columns = await dbAllAsync(`PRAGMA table_info(software_links)`);
        const hasImageUrl = Array.isArray(columns)
            && columns.some((column) => String(column?.name || '').trim().toLowerCase() === 'image_url');
        if (!hasImageUrl) {
            await dbRunAsync('ALTER TABLE software_links ADD COLUMN image_url TEXT');
        }
        await dbRunAsync(
            `CREATE INDEX IF NOT EXISTS idx_software_links_sort
             ON software_links(sort_order, name)`
        );
        softwareLinksSchemaReady = true;
    }

    async function ensureColumnIfMissing(tableName, columnName, alterSql) {
        const rows = await dbAllAsync(`PRAGMA table_info(${tableName})`);
        const hasColumn = Array.isArray(rows)
            && rows.some((row) => String(row?.name || '').trim().toLowerCase() === String(columnName || '').trim().toLowerCase());
        if (!hasColumn) {
            await dbRunAsync(alterSql);
        }
    }

    async function ensureInternalChatSupabaseSyncSchema() {
        if (internalChatSupabaseSyncSchemaReady) return;

        await ensureColumnIfMissing(
            'internal_conversations',
            'source_id',
            'ALTER TABLE internal_conversations ADD COLUMN source_id TEXT'
        );
        await ensureColumnIfMissing(
            'internal_conversations',
            'source_origin',
            'ALTER TABLE internal_conversations ADD COLUMN source_origin TEXT'
        );
        await ensureColumnIfMissing(
            'internal_conversations',
            'source_updated_at',
            'ALTER TABLE internal_conversations ADD COLUMN source_updated_at TEXT'
        );

        await ensureColumnIfMissing(
            'internal_messages',
            'source_id',
            'ALTER TABLE internal_messages ADD COLUMN source_id TEXT'
        );
        await ensureColumnIfMissing(
            'internal_messages',
            'source_origin',
            'ALTER TABLE internal_messages ADD COLUMN source_origin TEXT'
        );
        await ensureColumnIfMissing(
            'internal_messages',
            'source_updated_at',
            'ALTER TABLE internal_messages ADD COLUMN source_updated_at TEXT'
        );

        await dbRunAsync(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_conversations_source_id
             ON internal_conversations(source_id)
             WHERE source_id IS NOT NULL AND source_id <> ''`
        );
        await dbRunAsync(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_messages_source_id
             ON internal_messages(source_id)
             WHERE source_id IS NOT NULL AND source_id <> ''`
        );
        await dbRunAsync(
            `CREATE INDEX IF NOT EXISTS idx_internal_messages_source_updated
             ON internal_messages(source_updated_at)`
        );

        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );

        internalChatSupabaseSyncSchemaReady = true;
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

    function normalizeIsoDateTime(inputValue) {
        const raw = String(inputValue || '').trim();
        if (!raw) return '';

        const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
        const parsed = new Date(normalized);
        if (!Number.isFinite(parsed.getTime())) return '';
        return parsed.toISOString();
    }

    function pickFirstDefined(row, candidates = []) {
        if (!row || typeof row !== 'object') return undefined;
        for (const candidate of candidates) {
            if (!candidate) continue;
            if (row[candidate] !== undefined && row[candidate] !== null) {
                return row[candidate];
            }
        }
        return undefined;
    }

    function buildSupabaseDirectConversationSourceId(sourceUserA, sourceUserB) {
        const first = String(sourceUserA || '').trim();
        const second = String(sourceUserB || '').trim();
        if (!first || !second) return '';
        return `supabase_dm:${[first, second].sort().join(':')}`;
    }

    function parseSupabaseUserAliasMap(rawValue) {
        const text = String(rawValue || '').trim();
        if (!text) return new Map();

        const map = new Map();
        const entries = text
            .split(/[,\n\r;]+/)
            .map((item) => String(item || '').trim())
            .filter(Boolean);

        for (const entry of entries) {
            const normalized = entry.replace(/\s+/g, '');
            const separator = normalized.includes('=') ? '=' : normalized.includes('->') ? '->' : ':';
            const parts = normalized.split(separator).map((item) => String(item || '').trim()).filter(Boolean);
            if (parts.length < 2) continue;
            const legacy = parts[0];
            const canonical = parts[1];
            if (!legacy || !canonical || legacy === canonical) continue;
            map.set(legacy, canonical);
        }
        return map;
    }

    function resolveSourceAlias(sourceId, aliasMap) {
        let current = String(sourceId || '').trim();
        if (!current) return '';
        const seen = new Set();
        while (aliasMap instanceof Map && aliasMap.has(current) && !seen.has(current)) {
            seen.add(current);
            const next = String(aliasMap.get(current) || '').trim();
            if (!next || next === current) break;
            current = next;
        }
        return current;
    }

    function buildSupabaseUserAliasMapFromMessages(rows = []) {
        const votesByLegacy = new Map();
        const addVote = (legacyRaw, canonicalRaw) => {
            const legacy = String(legacyRaw || '').trim();
            const canonical = String(canonicalRaw || '').trim();
            if (!legacy || !canonical || legacy === canonical) return;
            let voteMap = votesByLegacy.get(legacy);
            if (!voteMap) {
                voteMap = new Map();
                votesByLegacy.set(legacy, voteMap);
            }
            voteMap.set(canonical, Number(voteMap.get(canonical) || 0) + 1);
        };

        (Array.isArray(rows) ? rows : []).forEach((row) => {
            addVote(
                pickFirstDefined(row, ['sender_user_id', 'senderUserId']),
                pickFirstDefined(row, ['sender_id', 'senderId'])
            );
            addVote(
                pickFirstDefined(row, ['receiver_user_id', 'receiverUserId']),
                pickFirstDefined(row, ['receiver_id', 'receiverId'])
            );
        });

        const resolved = new Map();
        for (const [legacy, voteMap] of votesByLegacy.entries()) {
            const sorted = Array.from(voteMap.entries()).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
            const top = sorted[0];
            if (!top?.[0]) continue;
            resolved.set(legacy, top[0]);
        }
        return resolved;
    }

    async function fetchSupabaseRowsPaginated({
        tableName,
        sinceColumn = '',
        sinceIso = '',
        orderColumn = '',
        maxRows = 20000,
        batchSize = 1000,
    }) {
        const normalizedTable = String(tableName || '').trim();
        if (!normalizedTable) {
            throw new Error('Tabela Supabase inválida para sincronização de histórico.');
        }

        const rows = [];
        const maxAllowed = Math.min(50000, Math.max(1, Number(maxRows || 20000)));
        const pageSize = Math.min(2000, Math.max(100, Number(batchSize || 1000)));
        const orderBy = String(orderColumn || '').trim();
        const filterColumn = String(sinceColumn || '').trim();
        const filterIso = String(sinceIso || '').trim();

        for (let offset = 0; offset < maxAllowed; offset += pageSize) {
            const params = new URLSearchParams();
            params.set('select', '*');
            params.set('limit', String(pageSize));
            params.set('offset', String(offset));
            if (orderBy) {
                params.set('order', `${orderBy}.asc`);
            }
            if (filterColumn && filterIso) {
                params.set(filterColumn, `gt.${filterIso}`);
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 25000);
            let response;
            try {
                response = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(normalizedTable)}?${params.toString()}`, {
                    method: 'GET',
                    headers: {
                        apikey: SUPABASE_KEY,
                        Authorization: `Bearer ${SUPABASE_KEY}`,
                        Accept: 'application/json',
                    },
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timer);
            }

            if (!response.ok) {
                const details = await response.text().catch(() => '');
                throw new Error(
                    `Falha ao consultar Supabase (${normalizedTable}) [${response.status}]${details ? `: ${details}` : ''}`
                );
            }

            const payload = await response.json().catch(() => []);
            const chunk = Array.isArray(payload) ? payload : [];
            if (chunk.length === 0) break;
            rows.push(...chunk);

            if (chunk.length < pageSize) break;
            if (rows.length >= maxAllowed) break;
        }

        return rows.slice(0, maxAllowed);
    }

    async function syncInternalChatHistoryFromSupabase({
        actorUserId = '',
        forceFull = false,
        maxRows = 20000,
    } = {}) {
        await ensureInternalChatSupabaseSyncSchema();

        const defaultSyncIntervalMs = Math.min(
            10 * 60 * 1000,
            Math.max(10_000, Number(process.env.INTERNAL_CHAT_SUPABASE_SYNC_MIN_INTERVAL_MS || 45_000))
        );
        const nowMs = Date.now();
        const lastRunAtIso = await getSyncStateValue('internal_chat_supabase_history_last_run_at');
        const lastRunAtMs = lastRunAtIso ? new Date(lastRunAtIso).getTime() : 0;
        if (!forceFull && Number.isFinite(lastRunAtMs) && lastRunAtMs > 0 && (nowMs - lastRunAtMs) < defaultSyncIntervalMs) {
            return {
                skipped: true,
                reason: 'cooldown',
                cooldownMsRemaining: defaultSyncIntervalMs - (nowMs - lastRunAtMs),
                importedMessages: 0,
                linkedMessages: 0,
                skippedMessages: 0,
                createdConversations: 0,
                createdUsers: 0,
                totalFetched: 0,
                table: null,
                lastCursor: await getSyncStateValue('internal_chat_supabase_messages_cursor'),
            };
        }

        const mensagensTableRequested = String(process.env.SUPABASE_INTERNAL_CHAT_MESSAGES_SOURCE || 'mensagens').trim();
        const mensagensTable = typeof resolveSupabaseTableName === 'function'
            ? await resolveSupabaseTableName(mensagensTableRequested, ['public.mensagens', 'mensagens'])
            : mensagensTableRequested;
        const sourceCreatedAtColumn = String(process.env.SUPABASE_INTERNAL_CHAT_MESSAGES_CURSOR_COLUMN || 'created_at').trim();

        const previousCursorIso = forceFull
            ? ''
            : await getSyncStateValue('internal_chat_supabase_messages_cursor');
        const sinceIso = normalizeIsoDateTime(previousCursorIso);

        const stats = {
            skipped: false,
            reason: '',
            importedMessages: 0,
            linkedMessages: 0,
            skippedMessages: 0,
            createdConversations: 0,
            createdUsers: 0,
            reconciledAliasUsers: 0,
            totalFetched: 0,
            table: mensagensTable,
            lastCursor: previousCursorIso || '',
        };

        const userRows = await dbAllAsync('SELECT id, source_id, name, email FROM users');
        const usersByLocalId = new Map();
        const usersBySourceId = new Map();
        const usersByEmail = new Map();
        (Array.isArray(userRows) ? userRows : []).forEach((row) => {
            const localId = String(row?.id || '').trim();
            if (!localId) return;
            usersByLocalId.set(localId, row);
            const sourceId = String(row?.source_id || '').trim();
            if (sourceId) usersBySourceId.set(sourceId, localId);
            const email = String(row?.email || '').trim().toLowerCase();
            if (email) usersByEmail.set(email, localId);
        });

        const knownMessageSourceRows = await dbAllAsync(
            `SELECT id, source_id
             FROM internal_messages
             WHERE source_id IS NOT NULL AND source_id <> ''`
        );
        const localMessageIdBySourceId = new Map();
        (Array.isArray(knownMessageSourceRows) ? knownMessageSourceRows : []).forEach((row) => {
            const sourceId = String(row?.source_id || '').trim();
            if (!sourceId) return;
            localMessageIdBySourceId.set(sourceId, Number(row?.id || 0) || 0);
        });

        const createdAtCandidates = [sourceCreatedAtColumn, 'created_at', 'updated_at'];
        const messageRowsRaw = await fetchSupabaseRowsPaginated({
            tableName: mensagensTable,
            sinceColumn: sourceCreatedAtColumn,
            sinceIso,
            orderColumn: sourceCreatedAtColumn || 'created_at',
            maxRows,
            batchSize: Math.min(2000, Math.max(200, Number(process.env.INTERNAL_CHAT_SUPABASE_BATCH_SIZE || 1200))),
        });
        stats.totalFetched = Array.isArray(messageRowsRaw) ? messageRowsRaw.length : 0;
        if (!Array.isArray(messageRowsRaw) || messageRowsRaw.length === 0) {
            await setSyncStateValue('internal_chat_supabase_history_last_run_at', new Date().toISOString());
            return stats;
        }

        const aliasMap = new Map();
        const manualAliasMap = parseSupabaseUserAliasMap(process.env.INTERNAL_CHAT_SUPABASE_USER_ALIASES);
        manualAliasMap.forEach((canonical, legacy) => {
            if (!legacy || !canonical || legacy === canonical) return;
            aliasMap.set(legacy, canonical);
        });
        const autoAliasMap = buildSupabaseUserAliasMapFromMessages(messageRowsRaw);
        autoAliasMap.forEach((canonical, legacy) => {
            if (!legacy || !canonical || legacy === canonical) return;
            if (!aliasMap.has(legacy)) {
                aliasMap.set(legacy, canonical);
            }
        });

        const resolveOrCreateLocalUserId = async ({
            sourceUserId,
            fallbackName,
            fallbackEmail,
        }) => {
            const sourceId = String(sourceUserId || '').trim();
            if (!sourceId) return '';

            if (usersBySourceId.has(sourceId)) {
                return usersBySourceId.get(sourceId);
            }

            const maybeExtId = `ext_u_${sourceId}`;
            if (usersByLocalId.has(maybeExtId)) {
                usersBySourceId.set(sourceId, maybeExtId);
                return maybeExtId;
            }

            const normalizedEmail = String(fallbackEmail || '').trim().toLowerCase();
            if (normalizedEmail && usersByEmail.has(normalizedEmail)) {
                const existingLocalId = usersByEmail.get(normalizedEmail);
                usersBySourceId.set(sourceId, existingLocalId);
                await dbRunAsync(
                    `UPDATE users
                     SET source_id = COALESCE(NULLIF(source_id, ''), ?),
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [sourceId, existingLocalId]
                );
                return existingLocalId;
            }

            const localId = maybeExtId;
            const displayName = String(fallbackName || '').trim() || `Funcionário ${sourceId.slice(0, 8)}`;
            const placeholderEmail = normalizedEmail || `${sourceId.replace(/[^a-z0-9]+/gi, '').slice(0, 24).toLowerCase()}@sync.local`;
            const placeholderAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=10b981&color=fff`;
            await dbRunAsync(
                `INSERT INTO users (id, source_id, name, email, role, avatar_url, updated_at)
                 VALUES (?, ?, ?, ?, 'AGENT', ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(id) DO UPDATE SET
                    source_id = excluded.source_id,
                    name = excluded.name,
                    email = excluded.email,
                    avatar_url = excluded.avatar_url,
                    updated_at = CURRENT_TIMESTAMP`,
                [localId, sourceId, displayName, placeholderEmail, placeholderAvatar]
            );
            usersByLocalId.set(localId, {
                id: localId,
                source_id: sourceId,
                name: displayName,
                email: placeholderEmail,
            });
            usersBySourceId.set(sourceId, localId);
            usersByEmail.set(placeholderEmail, localId);
            stats.createdUsers += 1;
            return localId;
        };

        const reconcileInternalChatUserAlias = async ({
            legacySourceId,
            canonicalSourceId,
        }) => {
            const fromSource = String(legacySourceId || '').trim();
            const toSource = String(canonicalSourceId || '').trim();
            if (!fromSource || !toSource || fromSource === toSource) return false;

            const fromLocalId = String(usersBySourceId.get(fromSource) || '').trim();
            const toLocalId = String(usersBySourceId.get(toSource) || '').trim();
            if (!fromLocalId || !toLocalId || fromLocalId === toLocalId) return false;

            await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
            try {
                await dbRunAsync(
                    `UPDATE internal_messages
                     SET sender_user_id = ?
                     WHERE sender_user_id = ?`,
                    [toLocalId, fromLocalId]
                );
                await dbRunAsync(
                    `UPDATE internal_conversations
                     SET created_by = ?
                     WHERE created_by = ?`,
                    [toLocalId, fromLocalId]
                );
                await dbRunAsync(
                    `UPDATE internal_conversation_members
                     SET user_id = ?
                     WHERE user_id = ?
                       AND conversation_id NOT IN (
                         SELECT conversation_id
                         FROM internal_conversation_members
                         WHERE user_id = ?
                       )`,
                    [toLocalId, fromLocalId, toLocalId]
                );
                await dbRunAsync(
                    `DELETE FROM internal_conversation_members
                     WHERE user_id = ?`,
                    [fromLocalId]
                );

                const directRows = await dbAllAsync(
                    `SELECT id
                     FROM internal_conversations
                     WHERE type = 'direct'`
                );
                for (const row of (Array.isArray(directRows) ? directRows : [])) {
                    const conversationId = String(row?.id || '').trim();
                    if (!conversationId) continue;

                    const memberRows = await dbAllAsync(
                        `SELECT user_id
                         FROM internal_conversation_members
                         WHERE conversation_id = ?
                         ORDER BY user_id ASC`,
                        [conversationId]
                    );
                    const members = Array.from(
                        new Set((Array.isArray(memberRows) ? memberRows : []).map((item) => String(item?.user_id || '').trim()).filter(Boolean))
                    );
                    if (members.length < 2) continue;
                    const desiredDirectKey = [members[0], members[1]].sort().join(':');
                    if (!desiredDirectKey) continue;

                    const duplicate = await dbGetAsync(
                        `SELECT id
                         FROM internal_conversations
                         WHERE type = 'direct'
                           AND direct_key = ?
                           AND id <> ?
                         LIMIT 1`,
                        [desiredDirectKey, conversationId]
                    );

                    if (duplicate?.id) {
                        const targetConversationId = String(duplicate.id || '').trim();
                        if (!targetConversationId) continue;
                        await dbRunAsync(
                            `UPDATE internal_messages
                             SET conversation_id = ?
                             WHERE conversation_id = ?`,
                            [targetConversationId, conversationId]
                        );
                        await dbRunAsync(
                            `INSERT OR IGNORE INTO internal_conversation_members (conversation_id, user_id, joined_at, last_read_at)
                             SELECT ?, user_id, joined_at, last_read_at
                             FROM internal_conversation_members
                             WHERE conversation_id = ?`,
                            [targetConversationId, conversationId]
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
                        await dbRunAsync(
                            `UPDATE internal_conversations
                             SET last_message_at = (
                                    SELECT MAX(created_at)
                                    FROM internal_messages
                                    WHERE conversation_id = ?
                                 ),
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = ?`,
                            [targetConversationId, targetConversationId]
                        );
                        continue;
                    }

                    await dbRunAsync(
                        `UPDATE internal_conversations
                         SET direct_key = ?,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [desiredDirectKey, conversationId]
                    );
                }

                const remainingRefs = await dbGetAsync(
                    `SELECT
                        (SELECT COUNT(*) FROM internal_messages WHERE sender_user_id = ?) AS msg_count,
                        (SELECT COUNT(*) FROM internal_conversation_members WHERE user_id = ?) AS member_count,
                        (SELECT COUNT(*) FROM tasks WHERE assigned_user_id = ?) AS task_count`,
                    [fromLocalId, fromLocalId, fromLocalId]
                );
                const canDeleteLegacyUser =
                    Number(remainingRefs?.msg_count || 0) === 0
                    && Number(remainingRefs?.member_count || 0) === 0
                    && Number(remainingRefs?.task_count || 0) === 0;
                if (canDeleteLegacyUser) {
                    await dbRunAsync(
                        `DELETE FROM users
                         WHERE id = ?
                           AND source_id = ?`,
                        [fromLocalId, fromSource]
                    );
                    usersByLocalId.delete(fromLocalId);
                    const fromEmail = Array.from(usersByEmail.entries()).find(([, localId]) => localId === fromLocalId)?.[0];
                    if (fromEmail) usersByEmail.delete(fromEmail);
                }

                usersBySourceId.set(fromSource, toLocalId);
                await dbRunAsync('COMMIT');
                return true;
            } catch (error) {
                await dbRunAsync('ROLLBACK').catch(() => null);
                throw error;
            }
        };

        if (aliasMap.size > 0) {
            for (const [legacyRaw, canonicalRaw] of aliasMap.entries()) {
                const legacySourceId = String(legacyRaw || '').trim();
                const canonicalSourceId = resolveSourceAlias(canonicalRaw, aliasMap);
                if (!legacySourceId || !canonicalSourceId || legacySourceId === canonicalSourceId) continue;

                if (!usersBySourceId.has(canonicalSourceId)) {
                    await resolveOrCreateLocalUserId({
                        sourceUserId: canonicalSourceId,
                        fallbackName: '',
                        fallbackEmail: '',
                    });
                }

                const reconciled = await reconcileInternalChatUserAlias({
                    legacySourceId,
                    canonicalSourceId,
                });
                if (reconciled) {
                    stats.reconciledAliasUsers += 1;
                }
            }
        }

        const ensureDirectConversation = async ({
            senderLocalUserId,
            receiverLocalUserId,
            senderSourceUserId,
            receiverSourceUserId,
            messageAtIso,
        }) => {
            const firstLocal = String(senderLocalUserId || '').trim();
            const secondLocal = String(receiverLocalUserId || '').trim();
            if (!firstLocal || !secondLocal) return '';

            const directKey = [firstLocal, secondLocal].sort().join(':');
            const sourceConversationId = buildSupabaseDirectConversationSourceId(senderSourceUserId, receiverSourceUserId);
            let conversation = null;
            if (sourceConversationId) {
                conversation = await dbGetAsync(
                    `SELECT id
                     FROM internal_conversations
                     WHERE source_id = ?
                     LIMIT 1`,
                    [sourceConversationId]
                );
            }
            if (!conversation) {
                conversation = await dbGetAsync(
                    `SELECT id
                     FROM internal_conversations
                     WHERE direct_key = ?
                     LIMIT 1`,
                    [directKey]
                );
            }

            const messageTimestamp = normalizeIsoDateTime(messageAtIso) || new Date().toISOString();
            let conversationId = String(conversation?.id || '').trim();
            if (!conversationId) {
                conversationId = `ichat_sync_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
                await dbRunAsync(
                    `INSERT INTO internal_conversations (
                        id, type, title, direct_key, created_by, created_at, updated_at, last_message_at, source_id, source_origin, source_updated_at
                     ) VALUES (?, 'direct', ?, ?, ?, ?, ?, ?, ?, 'supabase_mensagens', ?)`,
                    [
                        conversationId,
                        'Conversa interna',
                        directKey,
                        firstLocal,
                        messageTimestamp,
                        messageTimestamp,
                        messageTimestamp,
                        sourceConversationId || null,
                        messageTimestamp,
                    ]
                );
                stats.createdConversations += 1;
            } else {
                await dbRunAsync(
                    `UPDATE internal_conversations
                     SET source_id = COALESCE(NULLIF(source_id, ''), ?),
                         source_origin = COALESCE(NULLIF(source_origin, ''), 'supabase_mensagens'),
                         source_updated_at = CASE
                            WHEN source_updated_at IS NULL OR source_updated_at = '' OR datetime(source_updated_at) < datetime(?) THEN ?
                            ELSE source_updated_at
                         END,
                         last_message_at = CASE
                            WHEN last_message_at IS NULL OR datetime(last_message_at) < datetime(?) THEN ?
                            ELSE last_message_at
                         END,
                         updated_at = CASE
                            WHEN datetime(updated_at) < datetime(?) THEN ?
                            ELSE updated_at
                         END
                     WHERE id = ?`,
                    [
                        sourceConversationId || null,
                        messageTimestamp,
                        messageTimestamp,
                        messageTimestamp,
                        messageTimestamp,
                        messageTimestamp,
                        messageTimestamp,
                        conversationId,
                    ]
                );
            }

            await dbRunAsync(
                `INSERT OR IGNORE INTO internal_conversation_members (conversation_id, user_id, joined_at, last_read_at)
                 VALUES (?, ?, ?, NULL)`,
                [conversationId, firstLocal, messageTimestamp]
            );
            await dbRunAsync(
                `INSERT OR IGNORE INTO internal_conversation_members (conversation_id, user_id, joined_at, last_read_at)
                 VALUES (?, ?, ?, NULL)`,
                [conversationId, secondLocal, messageTimestamp]
            );

            return conversationId;
        };

        let maxCursorIso = sinceIso;
        for (const rawRow of messageRowsRaw) {
            const sourceMessageId = String(pickFirstDefined(rawRow, ['id', 'message_id', 'uuid']) || '').trim();
            const senderSourceRaw = String(
                pickFirstDefined(rawRow, ['sender_id', 'sender_user_id', 'from_id', 'from_user_id']) || ''
            ).trim();
            const receiverSourceRaw = String(
                pickFirstDefined(rawRow, ['receiver_id', 'receiver_user_id', 'to_id', 'to_user_id']) || ''
            ).trim();
            const senderSourceUserId = resolveSourceAlias(senderSourceRaw, aliasMap);
            const receiverSourceUserId = resolveSourceAlias(receiverSourceRaw, aliasMap);
            if (!sourceMessageId || !senderSourceUserId || !receiverSourceUserId) {
                stats.skippedMessages += 1;
                continue;
            }

            const messageAtIso = normalizeIsoDateTime(pickFirstDefined(rawRow, createdAtCandidates)) || new Date().toISOString();
            if (!maxCursorIso || new Date(messageAtIso).getTime() > new Date(maxCursorIso).getTime()) {
                maxCursorIso = messageAtIso;
            }

            const senderLocalUserId = await resolveOrCreateLocalUserId({
                sourceUserId: senderSourceUserId,
                fallbackName: String(rawRow?.sender_name || rawRow?.sender || '').trim(),
                fallbackEmail: String(rawRow?.sender_email || '').trim().toLowerCase(),
            });
            const receiverLocalUserId = await resolveOrCreateLocalUserId({
                sourceUserId: receiverSourceUserId,
                fallbackName: String(rawRow?.receiver_name || rawRow?.receiver || '').trim(),
                fallbackEmail: String(rawRow?.receiver_email || '').trim().toLowerCase(),
            });
            if (!senderLocalUserId || !receiverLocalUserId) {
                stats.skippedMessages += 1;
                continue;
            }

            const conversationId = await ensureDirectConversation({
                senderLocalUserId,
                receiverLocalUserId,
                senderSourceUserId,
                receiverSourceUserId,
                messageAtIso,
            });
            if (!conversationId) {
                stats.skippedMessages += 1;
                continue;
            }

            const fileUrl = String(pickFirstDefined(rawRow, ['file_url', 'media_url', 'attachment_url']) || '').trim();
            const fileType = String(pickFirstDefined(rawRow, ['file_type', 'mime_type']) || '').trim();
            const contentRaw = pickFirstDefined(rawRow, ['content', 'body', 'text', 'message']);
            let body = String(contentRaw || '').trim();
            if (fileUrl) {
                const fileLabel = fileType ? `[Anexo ${fileType}]` : '[Anexo]';
                body = body ? `${body}\n${fileLabel} ${fileUrl}` : `${fileLabel} ${fileUrl}`;
            }

            const replySourceId = String(pickFirstDefined(rawRow, ['reply_to', 'reply_to_message_id']) || '').trim();
            let replyToMessageId = null;
            if (replySourceId) {
                if (localMessageIdBySourceId.has(replySourceId)) {
                    replyToMessageId = Number(localMessageIdBySourceId.get(replySourceId) || 0) || null;
                } else {
                    const replyRow = await dbGetAsync(
                        `SELECT id
                         FROM internal_messages
                         WHERE source_id = ?
                         LIMIT 1`,
                        [replySourceId]
                    );
                    if (replyRow?.id) {
                        replyToMessageId = Number(replyRow.id || 0) || null;
                        if (replyToMessageId) {
                            localMessageIdBySourceId.set(replySourceId, replyToMessageId);
                        }
                    }
                }
            }

            let localMessageId = Number(localMessageIdBySourceId.get(sourceMessageId) || 0) || 0;
            if (!localMessageId) {
                const existingBySource = await dbGetAsync(
                    `SELECT id
                     FROM internal_messages
                     WHERE source_id = ?
                     LIMIT 1`,
                    [sourceMessageId]
                );
                localMessageId = Number(existingBySource?.id || 0) || 0;
                if (localMessageId) {
                    localMessageIdBySourceId.set(sourceMessageId, localMessageId);
                }
            }

            if (!localMessageId) {
                const fuzzyRow = await dbGetAsync(
                    `SELECT id
                     FROM internal_messages
                     WHERE (source_id IS NULL OR source_id = '')
                       AND conversation_id = ?
                       AND sender_user_id = ?
                       AND type = 'text'
                       AND COALESCE(body, '') = ?
                       AND datetime(created_at) = datetime(?)
                     LIMIT 1`,
                    [conversationId, senderLocalUserId, body, messageAtIso]
                );
                if (fuzzyRow?.id) {
                    localMessageId = Number(fuzzyRow.id || 0) || 0;
                    if (localMessageId) {
                        await dbRunAsync(
                            `UPDATE internal_messages
                             SET source_id = ?,
                                 source_origin = 'supabase_mensagens',
                                 source_updated_at = ?,
                                 updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
                             WHERE id = ?`,
                            [sourceMessageId, messageAtIso, localMessageId]
                        );
                        localMessageIdBySourceId.set(sourceMessageId, localMessageId);
                        stats.linkedMessages += 1;
                    }
                }
            }

            if (!localMessageId) {
                const inserted = await dbRunAsync(
                    `INSERT INTO internal_messages (
                        conversation_id,
                        sender_user_id,
                        body,
                        type,
                        reply_to_message_id,
                        created_at,
                        updated_at,
                        source_id,
                        source_origin,
                        source_updated_at
                     ) VALUES (?, ?, ?, 'text', ?, ?, ?, ?, 'supabase_mensagens', ?)`,
                    [
                        conversationId,
                        senderLocalUserId,
                        body,
                        replyToMessageId,
                        messageAtIso,
                        messageAtIso,
                        sourceMessageId,
                        messageAtIso,
                    ]
                );
                localMessageId = Number(inserted?.lastID || 0) || 0;
                if (localMessageId) {
                    localMessageIdBySourceId.set(sourceMessageId, localMessageId);
                }
                stats.importedMessages += 1;
            } else {
                stats.skippedMessages += 1;
            }

            const readAtIso = normalizeIsoDateTime(pickFirstDefined(rawRow, ['read_at']));
            if (readAtIso) {
                await dbRunAsync(
                    `UPDATE internal_conversation_members
                     SET last_read_at = CASE
                        WHEN last_read_at IS NULL OR datetime(last_read_at) < datetime(?) THEN ?
                        ELSE last_read_at
                     END
                     WHERE conversation_id = ? AND user_id = ?`,
                    [readAtIso, readAtIso, conversationId, receiverLocalUserId]
                );
            }
        }

        if (maxCursorIso) {
            stats.lastCursor = maxCursorIso;
            await setSyncStateValue('internal_chat_supabase_messages_cursor', maxCursorIso);
        }
        await setSyncStateValue('internal_chat_supabase_history_last_run_at', new Date().toISOString());

        if (actorUserId) {
            await writeAuditLog({
                actorUserId: String(actorUserId || '').trim(),
                entityType: 'internal_chat',
                entityId: null,
                action: 'import_supabase_history',
                details: {
                    table: mensagensTable,
                    fetched: stats.totalFetched,
                    importedMessages: stats.importedMessages,
                    linkedMessages: stats.linkedMessages,
                    skippedMessages: stats.skippedMessages,
                    createdConversations: stats.createdConversations,
                    createdUsers: stats.createdUsers,
                    reconciledAliasUsers: stats.reconciledAliasUsers,
                    cursor: stats.lastCursor,
                    forceFull: !!forceFull,
                },
            }).catch(() => null);
        }

        return stats;
    }

    function normalizePedidoStatus(value) {
        return String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toUpperCase();
    }

    function isPedidoApprovedStatus(value) {
        const status = normalizePedidoStatus(value);
        return ['APROVADO', 'APROVADA', 'APPROVED', 'ACEITE', 'ACEITA'].includes(status);
    }

    function isPedidoRejectedStatus(value) {
        const status = normalizePedidoStatus(value);
        return ['REJEITADO', 'REJEITADA', 'REJECTED', 'RECUSADO', 'RECUSADA'].includes(status);
    }

    function isPedidoFinalStatus(value, notifyRejected) {
        if (isPedidoApprovedStatus(value)) return true;
        return notifyRejected && isPedidoRejectedStatus(value);
    }

    function extractRequesterUserIdFromLegacyDescricao(value) {
        const text = String(value || '').trim();
        if (!text) return '';
        const markerMatch = text.match(/\[WA_PRO_REQ:([^:\]]+)(?::|\])/i);
        if (!markerMatch?.[1]) return '';
        const rawToken = String(markerMatch[1] || '').trim();
        if (!rawToken) return '';

        const token = rawToken.toLowerCase();
        if (token.startsWith('ext_u_')) return token;
        if (token.startsWith('u_')) return `ext_${token}`;
        return token;
    }

    function extractRequesterNameFromLegacyDescricao(value) {
        const text = String(value || '').trim();
        if (!text) return '';
        const nameMatch = text.match(/Solicitante:\s*([^<\n\r]+?)(?:\s*<|$)/i);
        return nameMatch?.[1] ? String(nameMatch[1]).trim() : '';
    }

    function stripLegacyRequestTag(value) {
        return String(value || '')
            .replace(/\[WA_PRO_REQ:[^\]]+\]\s*/gi, '')
            .replace(/Solicitante:\s*[^\n\r]+/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function extractPedidoDecisionReason(row) {
        if (!row || typeof row !== 'object') return '';
        const candidates = [
            row.resolucao,
            row.resolução,
            row.decisao,
            row.decisão,
            row.motivo,
            row.motivo_rejeicao,
            row.motivo_rejeição,
            row.obs_decisao,
            row.observacoes_decisao,
            row.observacoes,
        ];
        for (const item of candidates) {
            const text = String(item || '').trim();
            if (text) return text;
        }
        return '';
    }

    async function ensureDirectConversationBetweenUsers({ userId, targetUserId, titleIfSelf = 'Notas e Avisos' }) {
        const sourceUserId = String(userId || '').trim();
        const otherUserId = String(targetUserId || '').trim();
        if (!sourceUserId || !otherUserId) {
            throw new Error('IDs de utilizador inválidos para abrir conversa.');
        }

        const isSelfConversation = sourceUserId === otherUserId;
        const users = isSelfConversation
            ? await dbAllAsync('SELECT id, name FROM users WHERE id = ?', [sourceUserId])
            : await dbAllAsync('SELECT id, name FROM users WHERE id IN (?, ?)', [sourceUserId, otherUserId]);
        if (!Array.isArray(users) || users.length < (isSelfConversation ? 1 : 2)) {
            throw new Error('Funcionário não encontrado para abrir conversa.');
        }

        const directKey = [sourceUserId, otherUserId].sort().join(':');
        let conversation = await dbGetAsync(
            `SELECT id, title
             FROM internal_conversations
             WHERE direct_key = ?
             LIMIT 1`,
            [directKey]
        );

        if (!conversation) {
            const conversationId = `ichat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            const targetUserName = String(users.find((u) => String(u.id || '').trim() === otherUserId)?.name || '').trim();
            await dbRunAsync(
                `INSERT INTO internal_conversations (
                    id, type, title, direct_key, created_by, created_at, updated_at, last_message_at
                 ) VALUES (?, 'direct', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)`,
                [
                    conversationId,
                    isSelfConversation ? titleIfSelf : targetUserName || 'Conversa interna',
                    directKey,
                    sourceUserId,
                ]
            );
            await dbRunAsync(
                `INSERT OR IGNORE INTO internal_conversation_members (conversation_id, user_id, joined_at, last_read_at)
                 VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [conversationId, sourceUserId]
            );
            if (!isSelfConversation) {
                await dbRunAsync(
                    `INSERT OR IGNORE INTO internal_conversation_members (conversation_id, user_id, joined_at, last_read_at)
                     VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                    [conversationId, otherUserId]
                );
            }
            conversation = { id: conversationId };
        }

        return String(conversation?.id || '').trim();
    }

    async function sendInternalSystemMessage({
        conversationId,
        senderUserId,
        recipientUserId,
        body,
    }) {
        const normalizedConversationId = String(conversationId || '').trim();
        const normalizedSenderId = String(senderUserId || '').trim();
        const normalizedRecipientId = String(recipientUserId || '').trim();
        const normalizedBody = String(body || '').trim();
        if (!normalizedConversationId || !normalizedSenderId || !normalizedRecipientId || !normalizedBody) {
            return;
        }

        await dbRunAsync(
            `INSERT INTO internal_messages (
                conversation_id, sender_user_id, body, type, reply_to_message_id, created_at
             ) VALUES (?, ?, ?, 'text', NULL, CURRENT_TIMESTAMP)`,
            [normalizedConversationId, normalizedSenderId, normalizedBody]
        );
        await dbRunAsync(
            `UPDATE internal_conversations
             SET last_message_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [normalizedConversationId]
        );
        await dbRunAsync(
            `INSERT OR IGNORE INTO internal_conversation_members (conversation_id, user_id, joined_at, last_read_at)
             VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [normalizedConversationId, normalizedRecipientId]
        );
    }

    function isInternalChatPlaceholderUser(row) {
        if (!row || typeof row !== 'object') return false;
        const email = String(row.email || '').trim().toLowerCase();
        const name = String(row.name || '').trim();
        return email.endsWith('@sync.local') || /^Funcion[aá]rio\s+/i.test(name);
    }

    async function deleteInternalChatPlaceholderUserIfOrphan(userId) {
        const normalizedUserId = String(userId || '').trim();
        if (!normalizedUserId) return false;

        const userRow = await dbGetAsync(
            `SELECT id, source_id, name, email
             FROM users
             WHERE id = ?
             LIMIT 1`,
            [normalizedUserId]
        );
        if (!userRow || !isInternalChatPlaceholderUser(userRow)) {
            return false;
        }

        const refs = await dbGetAsync(
            `SELECT
                (SELECT COUNT(*) FROM internal_messages WHERE sender_user_id = ?) AS msg_count,
                (SELECT COUNT(*) FROM internal_conversation_members WHERE user_id = ?) AS member_count,
                (SELECT COUNT(*) FROM tasks WHERE assigned_user_id = ?) AS task_count,
                (SELECT COUNT(*) FROM calls WHERE user_id = ?) AS call_count,
                (SELECT COUNT(*) FROM customers WHERE owner_id = ?) AS customer_count`,
            [normalizedUserId, normalizedUserId, normalizedUserId, normalizedUserId, normalizedUserId]
        );

        const hasReferences =
            Number(refs?.msg_count || 0) > 0
            || Number(refs?.member_count || 0) > 0
            || Number(refs?.task_count || 0) > 0
            || Number(refs?.call_count || 0) > 0
            || Number(refs?.customer_count || 0) > 0;
        if (hasReferences) return false;

        await dbRunAsync(
            `DELETE FROM users
             WHERE id = ?`,
            [normalizedUserId]
        );
        return true;
    }

    async function ensureSupabasePedidosTrackingSchema() {
        if (supabasePedidosTrackingSchemaReady) return;
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS supabase_pedidos_tracking (
                supabase_pedido_id TEXT PRIMARY KEY,
                supabase_table TEXT NOT NULL DEFAULT 'pedidos',
                requester_user_id TEXT NOT NULL,
                requester_name TEXT,
                manager_user_id TEXT,
                tipo TEXT,
                descricao TEXT,
                status_last TEXT NOT NULL DEFAULT 'PENDENTE',
                status_notified TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                closed_at DATETIME
            )`
        );
        const currentColumns = await dbAllAsync('PRAGMA table_info(supabase_pedidos_tracking)');
        const currentColumnNames = new Set(
            (Array.isArray(currentColumns) ? currentColumns : [])
                .map((col) => String(col?.name || '').trim().toLowerCase())
                .filter(Boolean)
        );
        if (!currentColumnNames.has('decision_reason_notified')) {
            await dbRunAsync('ALTER TABLE supabase_pedidos_tracking ADD COLUMN decision_reason_notified TEXT');
        }
        await dbRunAsync(
            'CREATE INDEX IF NOT EXISTS idx_supabase_pedidos_tracking_requester ON supabase_pedidos_tracking(requester_user_id, status_last)'
        );
        await dbRunAsync(
            'CREATE INDEX IF NOT EXISTS idx_supabase_pedidos_tracking_open ON supabase_pedidos_tracking(closed_at, updated_at DESC)'
        );
        supabasePedidosTrackingSchemaReady = true;
    }

    async function upsertTrackedSupabasePedido({
        supabasePedidoId,
        supabaseTable,
        requesterUserId,
        requesterName,
        managerUserId,
        tipo,
        descricao,
        statusLast,
    }) {
        const pedidoId = String(supabasePedidoId || '').trim();
        const requesterId = String(requesterUserId || '').trim();
        if (!pedidoId || !requesterId) return;
        await ensureSupabasePedidosTrackingSchema();

        const normalizedStatus = normalizePedidoStatus(statusLast || 'PENDENTE') || 'PENDENTE';
        await dbRunAsync(
            `INSERT INTO supabase_pedidos_tracking (
                supabase_pedido_id,
                supabase_table,
                requester_user_id,
                requester_name,
                manager_user_id,
                tipo,
                descricao,
                status_last,
                status_notified,
                created_at,
                updated_at,
                closed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
             ON CONFLICT(supabase_pedido_id) DO UPDATE SET
                supabase_table = excluded.supabase_table,
                requester_user_id = excluded.requester_user_id,
                requester_name = excluded.requester_name,
                manager_user_id = excluded.manager_user_id,
                tipo = excluded.tipo,
                descricao = excluded.descricao,
                status_last = excluded.status_last,
                updated_at = CURRENT_TIMESTAMP,
                closed_at = CASE
                    WHEN excluded.status_last IN ('APROVADO', 'APROVADA', 'APPROVED', 'ACEITE', 'ACEITA', 'REJEITADO', 'REJEITADA', 'REJECTED', 'RECUSADO', 'RECUSADA')
                         AND COALESCE(supabase_pedidos_tracking.status_notified, '') <> ''
                    THEN COALESCE(supabase_pedidos_tracking.closed_at, CURRENT_TIMESTAMP)
                    ELSE NULL
                END`,
            [
                pedidoId,
                String(supabaseTable || 'pedidos').trim() || 'pedidos',
                requesterId,
                String(requesterName || '').trim() || null,
                String(managerUserId || '').trim() || null,
                String(tipo || '').trim() || null,
                String(descricao || '').trim() || null,
                normalizedStatus,
                null,
            ]
        );
    }

    function isLikelyPrivateHost(hostname = '') {
        const host = String(hostname || '').trim().toLowerCase();
        if (!host) return true;
        if (host === 'localhost' || host.endsWith('.local')) return true;
        if (host === '::1') return true;
        if (host.includes(':') && host.startsWith('fe80:')) return true;
        if (host.includes(':') && host.startsWith('fc')) return true;
        if (host.includes(':') && host.startsWith('fd')) return true;
        if (host.includes(':')) return false;

        const ipv4 = host.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
        if (!ipv4) return false;
        const parts = host.split('.').map((n) => Number(n));
        if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
        const [a, b] = parts;
        if (a === 10 || a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        return false;
    }

    function normalizeAiAllowedSites(rawValue) {
        let list = [];
        if (Array.isArray(rawValue)) {
            list = rawValue.map((item) => String(item || '').trim());
        } else if (typeof rawValue === 'string') {
            const text = rawValue.trim();
            if (!text) return [];
            try {
                const parsed = JSON.parse(text);
                if (Array.isArray(parsed)) {
                    list = parsed.map((item) => String(item || '').trim());
                } else {
                    list = text.split(/\r?\n|,/g).map((item) => String(item || '').trim());
                }
            } catch {
                list = text.split(/\r?\n|,/g).map((item) => String(item || '').trim());
            }
        }

        const normalized = [];
        for (const candidate of list) {
            if (!candidate) continue;
            const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
            try {
                const parsed = new URL(withProtocol);
                if (!['http:', 'https:'].includes(parsed.protocol)) continue;
                if (isLikelyPrivateHost(parsed.hostname)) continue;
                const url = `${parsed.protocol}//${parsed.host}${parsed.pathname || '/'}`.replace(/\/+$/, '/');
                normalized.push(url);
            } catch {
                continue;
            }
        }

        return Array.from(new Set(normalized)).slice(0, 40);
    }

    function stripHtmlToText(html) {
        return String(html || '')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/\s+/g, ' ')
            .trim();
    }

    function extractRelevantLinks(baseUrl, html, question = '') {
        const base = String(baseUrl || '').trim();
        const text = String(html || '');
        if (!base || !text) return [];

        const questionTerms = String(question || '')
            .toLowerCase()
            .split(/[^a-z0-9à-ú]+/i)
            .map((item) => item.trim())
            .filter((item) => item.length >= 4)
            .slice(0, 8);
        const defaultHints = ['iva', 'vinculativa', 'parecer', 'fiscal', 'tribut', 'faq', 'legisl'];
        const hints = Array.from(new Set([...questionTerms, ...defaultHints]));

        const links = [];
        const anchorRegex = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
        let match = anchorRegex.exec(text);
        while (match) {
            const hrefRaw = String(match[1] || '').trim();
            try {
                const full = new URL(hrefRaw, base);
                if (!['http:', 'https:'].includes(full.protocol)) {
                    match = anchorRegex.exec(text);
                    continue;
                }
                const hrefText = `${full.pathname}${full.search}`.toLowerCase();
                if (!hints.some((hint) => hrefText.includes(hint))) {
                    match = anchorRegex.exec(text);
                    continue;
                }
                links.push(`${full.protocol}//${full.host}${full.pathname}${full.search}`);
            } catch {
                // ignore invalid link
            }
            match = anchorRegex.exec(text);
        }
        return Array.from(new Set(links)).slice(0, INTERNAL_AI_MAX_SUBPAGES_PER_SITE);
    }

    async function fetchUrlWithTimeout(url, timeoutMs = 10000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                signal: controller.signal,
                headers: {
                    'User-Agent': 'WA-PRO-Internal-AI/1.0',
                    Accept: 'text/html,application/xhtml+xml,application/xml,text/plain;q=0.9,*/*;q=0.8',
                },
            });
        } finally {
            clearTimeout(timer);
        }
    }

    async function collectAiWebsiteContext(allowedSites = [], question = '') {
        const excerpts = [];
        for (const site of allowedSites.slice(0, INTERNAL_AI_MAX_SITES)) {
            try {
                const response = await fetchUrlWithTimeout(site, 9000);
                if (!response.ok) {
                    continue;
                }
                const contentType = String(response.headers.get('content-type') || '').toLowerCase();
                if (!contentType.includes('text') && !contentType.includes('html') && !contentType.includes('json')) {
                    continue;
                }
                const rawText = await response.text();
                const plainText = stripHtmlToText(rawText).slice(0, INTERNAL_AI_SITE_EXCERPT_CHARS);
                if (!plainText) continue;
                excerpts.push({
                    url: site,
                    text: plainText,
                });

                const subLinks = extractRelevantLinks(site, rawText, question);
                for (const subUrl of subLinks) {
                    try {
                        const subResponse = await fetchUrlWithTimeout(subUrl, 8000);
                        if (!subResponse.ok) continue;
                        const subContentType = String(subResponse.headers.get('content-type') || '').toLowerCase();
                        if (!subContentType.includes('text') && !subContentType.includes('html') && !subContentType.includes('json')) {
                            continue;
                        }
                        const subRaw = await subResponse.text();
                        const subPlain = stripHtmlToText(subRaw).slice(0, INTERNAL_AI_SITE_EXCERPT_CHARS);
                        if (!subPlain) continue;
                        excerpts.push({
                            url: subUrl,
                            text: subPlain,
                        });
                    } catch {
                        continue;
                    }
                }
            } catch {
                continue;
            }
        }
        return excerpts;
    }

    function parseGeminiAnswerText(payload) {
        const candidate = payload?.candidates?.[0];
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        const text = parts
            .map((part) => String(part?.text || '').trim())
            .filter(Boolean)
            .join('\n')
            .trim();
        return text;
    }

    function isWeakAssistantAnswer(answerText, triggerMessageId = null) {
        const text = String(answerText || '').trim();
        if (!text) return true;
        if (/^\d+$/.test(text)) {
            if (triggerMessageId && text === String(triggerMessageId)) return true;
            if (text.length <= 4) return true;
        }
        const words = text.split(/\s+/).filter(Boolean);
        if (words.length <= 2) return true;
        return false;
    }

    function isStructuredTechnicalAnswer(answerText) {
        const text = String(answerText || '').trim();
        if (!text) return false;
        const normalized = text.toLowerCase();
        const hasAllSections =
            normalized.includes('1) enquadramento legal') &&
            normalized.includes('2) solução proposta') &&
            normalized.includes('3) pareceres / informações vinculativas') &&
            normalized.includes('4) legislação aplicável') &&
            normalized.includes('fontes consultadas');
        if (!hasAllSections) return false;
        if (text.length < 450) return false;
        return true;
    }

    function isGenericTemplateAnswer(answerText) {
        const text = String(answerText || '').trim().toLowerCase();
        if (!text) return true;
        const genericMarkers = [
            'a resposta depende do enquadramento factual',
            'dados em falta para fechar parecer objetivo',
            'não foi possível produzir resposta técnica fiável',
            'questão analisada:',
        ];
        const hitCount = genericMarkers.filter((marker) => text.includes(marker)).length;
        return hitCount >= 2;
    }

    function normalizeConversationHistoryRows(rows = [], aiUserId = '', maxItems = 10) {
        return (Array.isArray(rows) ? rows : [])
            .slice(-maxItems)
            .map((row) => {
                const sender = String(row?.sender_user_id || '').trim();
                const role = sender && sender === aiUserId ? 'assistente' : 'utilizador';
                const body = String(row?.body || '').replace(/\s+/g, ' ').trim();
                if (!body) return null;
                return {
                    role,
                    text: body.slice(0, 500),
                };
            })
            .filter(Boolean);
    }

    function formatConversationHistoryForPrompt(history = []) {
        const items = Array.isArray(history) ? history : [];
        if (!items.length) return 'Sem histórico relevante.';
        return items
            .map((item, index) => `${index + 1}. [${item.role}] ${item.text}`)
            .join('\n');
    }

    function isQuestionAboutUsedCarsVat(question) {
        const text = String(question || '').toLowerCase();
        return (
            (text.includes('viatura') || text.includes('carro') || text.includes('automóvel')) &&
            text.includes('usad') &&
            text.includes('iva')
        );
    }

    function buildGenericProfessionalFallbackAnswer({ question = '', trustedSites = [] } = {}) {
        const questionText = String(question || '').trim() || 'Questão fiscal/jurídica';
        const sourcesBlock = (Array.isArray(trustedSites) ? trustedSites : [])
            .filter(Boolean)
            .map((site) => `- ${site}`)
            .join('\n') || '- Fontes oficiais não disponíveis neste momento';

        return [
            'Olá, sou a sua assistente. Analisei a questão e segue a resposta técnica inicial.',
            '',
            `Questão analisada: ${questionText}`,
            '',
            '1) Enquadramento legal',
            '- A resposta depende do enquadramento factual exato (tipo de operação, intervenientes, natureza do bem/serviço, datas e documentação de suporte).',
            '- Em matéria fiscal, a qualificação jurídica correta dos factos é determinante para definir incidência, base tributável, taxa aplicável e obrigações acessórias.',
            '',
            '2) Solução proposta',
            '- Reunir os factos essenciais da operação e validar o regime materialmente aplicável.',
            '- Confirmar documentação de suporte (contratos, faturas, origem da operação e evidência contabilística).',
            '- Emitir posição técnica com base em norma legal, doutrina administrativa e entendimento profissional aplicável.',
            '',
            '3) Pareceres / Informações vinculativas',
            '- Validação recomendada no Portal das Finanças para identificar informações vinculativas específicas sobre a matéria em análise.',
            '- Validar também notas técnicas e pareceres profissionais relevantes da OCC para aplicação prática e contabilística.',
            '',
            '4) Legislação aplicável',
            '- Identificar diploma especial aplicável ao caso concreto e respetivos artigos.',
            '- Em paralelo, validar regime geral do CIVA/CIRC/CIRS/LGT/CPPT conforme o tipo de operação.',
            '',
            'Dados em falta para fechar parecer objetivo:',
            '- descrição factual completa da operação,',
            '- documentos principais (fatura/contrato),',
            '- data da operação e enquadramento do sujeito passivo.',
            '',
            'Fontes consultadas:',
            sourcesBlock,
        ].join('\n');
    }

    function buildUsedCarsVatFallbackAnswer({ allowedSites = [] } = {}) {
        const sourcesBlock = (Array.isArray(allowedSites) ? allowedSites : [])
            .filter(Boolean)
            .map((site) => `- ${site}`)
            .join('\n') || '- (sem fontes configuradas)';

        return [
            'Olá, sou a sua assistente. Analisei a questão e segue a resposta técnica.',
            '',
            'O regime de IVA na venda de viaturas usadas em Portugal exige distinguir, logo na origem da aquisição, entre o **Regime Especial da Margem** e o **Regime Geral**.',
            '',
            '1) Enquadramento legal',
            '- Regra prática: quando o revendedor adquire viatura sem direito a dedução de IVA na origem (ex.: particular), tende a aplicar-se o regime especial da margem.',
            '- Quando a viatura é adquirida em circuito com IVA dedutível na origem (ex.: fornecedor sujeito passivo com regime normal), aplica-se em regra o regime geral.',
            '- Na faturação do regime da margem, a menção específica do regime é obrigatória e o IVA não é destacado como no regime geral.',
            '',
            '2) Solução proposta',
            '- Confirmar documentalmente a origem fiscal da viatura (quem vendeu e em que regime).',
            '- Separar stocks/processos por regime para evitar erros em inspeção.',
            '- Validar cada compra intracomunitária antes da venda em PT, para confirmar se veio em margem ou em regime normal.',
            '- Emitir fatura com menções corretas do regime aplicável e manter dossiê de prova.',
            '',
            '3) Pareceres / Informações vinculativas',
            '- Existem entendimentos da AT e notas técnicas da OCC que reforçam a necessidade de prova documental da origem do regime e a correta menção em fatura.',
            '- Se pretender, posso preparar uma grelha de validação por documento (compra, fatura, declaração do fornecedor, menções obrigatórias) para reduzir risco de correção inspetiva.',
            '- Validação recomendada: confirmar no Portal das Finanças as informações vinculativas de IVA sobre bens em segunda mão aplicáveis ao caso concreto.',
            '',
            '4) Legislação aplicável',
            '- Regime especial de bens em segunda mão (tributação da margem), no quadro legal português aplicável.',
            '- Regras gerais do Código do IVA sobre incidência, base tributável, direito à dedução e faturação.',
            '',
            'Fontes consultadas:',
            sourcesBlock,
        ].join('\n');
    }

    function ensureFormalAssistantIntro(answerText) {
        const text = String(answerText || '').trim();
        if (!text) return text;
        const lower = text.toLowerCase();
        if (lower.startsWith('olá, sou a sua assistente') || lower.startsWith('ola, sou a sua assistente')) {
            return text;
        }
        return `Olá, sou a sua assistente. Analisei a questão e segue a resposta técnica.\n\n${text}`;
    }

    async function generateInternalAssistantAnswer({
        question,
        assistantName,
        allowedSites,
        conversationHistory,
    }) {
        const trimmedQuestion = String(question || '').trim();
        if (!trimmedQuestion) return 'Não recebi a pergunta.';

        const envTrustedSources = String(process.env.INTERNAL_AI_TRUSTED_SOURCES || '')
            .split(',')
            .map((item) => String(item || '').trim())
            .filter(Boolean);
        const trustedSourcesBase = envTrustedSources.length ? envTrustedSources : INTERNAL_AI_DEFAULT_TRUSTED_SOURCES;
        const trustedSources = normalizeAiAllowedSites(trustedSourcesBase);
        const profileSites = normalizeAiAllowedSites(allowedSites);
        const safeSites = Array.from(new Set([...trustedSources, ...profileSites])).slice(0, 40);
        const fetchSites = safeSites.slice(0, INTERNAL_AI_MAX_SITES);

        const websiteContext = await collectAiWebsiteContext(fetchSites, trimmedQuestion);
        const sourceUrlsActuallyUsed = Array.from(
            new Set(websiteContext.map((item) => String(item.url || '').trim()).filter(Boolean))
        ).slice(0, 8);
        const contextText = websiteContext.length
            ? websiteContext
                .map((item, idx) => `Fonte ${idx + 1}: ${item.url}\nConteúdo:\n${item.text}`)
                .join('\n\n')
            : 'Sem contexto recolhido por scraping neste momento. Usa conhecimento técnico consolidado e indica validação recomendada com fontes oficiais.';

        const configuredModel = String(process.env.GEMINI_MODEL || 'gemini-flash-latest').trim();
        const fallbackModels = String(process.env.GEMINI_MODEL_FALLBACKS || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        const models = Array.from(new Set([configuredModel, 'gemini-2.5-flash', 'gemini-flash-latest', ...fallbackModels]));
        const keys = Array.from(
            new Set(
                [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_BACKUP]
                    .map((item) => String(item || '').trim())
                    .filter(Boolean)
            )
        );

        if (!keys.length) {
            if (isQuestionAboutUsedCarsVat(trimmedQuestion)) {
                return buildUsedCarsVatFallbackAnswer({ allowedSites: sourceUrlsActuallyUsed.length ? sourceUrlsActuallyUsed : safeSites });
            }
            return buildGenericProfessionalFallbackAnswer({ question: trimmedQuestion, trustedSites: safeSites });
        }

        const domainHint = isQuestionAboutUsedCarsVat(trimmedQuestion)
            ? [
                'Contexto técnico prioritário para esta pergunta:',
                '- Distinguir regime normal de IVA e regime especial de tributação da margem de bens em segunda mão.',
                '- Explicar quando se aplica (sujeito passivo revendedor), base tributável e menções na fatura.',
                '- Explicar impacto da dedução do IVA suportado na aquisição.',
                '- Indicar riscos de enquadramento incorreto e validações práticas.',
                '',
            ].join('\n')
            : '';

        const historyText = formatConversationHistoryForPrompt(conversationHistory);

        const prompt = [
            `És o funcionário IA "${assistantName || 'Assistente IA'}" no chat interno de uma empresa de contabilidade em Portugal.`,
            'Atua com perfil técnico de: fiscalista + auditor + jurista (direito fiscal/tributário).',
            'Responde em português de Portugal com linguagem natural, profissional e útil (estilo consultor sénior).',
            'Nunca inventes artigos, ofícios, pareceres, informações vinculativas ou normas.',
            'Prioriza fontes oficiais e fidedignas (AT, Diário da República, OCC, Segurança Social, EUR-Lex).',
            'Se faltar informação nas fontes recolhidas, complementa com conhecimento técnico fiscal consolidado e indica claramente "Validação recomendada".',
            'Se a pergunta estiver ambígua, faz 1-3 perguntas de clarificação no fim.',
            'Não escrevas resposta genérica; adapta ao caso concreto da pergunta.',
            `Pergunta: ${trimmedQuestion}`,
            '',
            'Histórico recente da conversa:',
            historyText,
            '',
            domainHint,
            'Fontes de referência (prioritárias):',
            safeSites.map((site) => `- ${site}`).join('\n'),
            '',
            'Conteúdo recolhido das fontes:',
            contextText,
            '',
            'Regras de formatação:',
            '- Começar com 2-4 linhas de resposta direta ao caso.',
            '- Depois usar secções curtas: Enquadramento, Solução prática, Riscos/validações, Base legal.',
            '- Em "Pareceres / Informações vinculativas", só citar se tiveres confirmação nas fontes; caso contrário indicar explicitamente que é necessário validar.',
            '- No fim, adicionar "Fontes consultadas:" com a lista de URLs efetivamente usadas.',
            '- Não responder só com número, palavra isolada ou frase curta sem contexto técnico.',
            '- Evitar respostas em "template vazio" ou repetitivas.',
            '- O estilo deve parecer resposta de consultor sénior (fiscalista/auditor/revisor oficial de contas).',
        ].join('\n');

        let bestCandidate = '';

        for (const key of keys) {
            for (const model of models) {
                for (const attempt of [1, 2]) {
                    const attemptPrompt = attempt === 1
                        ? prompt
                        : [
                            prompt,
                            '',
                            'REVISÃO OBRIGATÓRIA:',
                            '- Reescreve a resposta para ficar completa e tecnicamente aplicável ao caso.',
                            '- Garante conteúdo prático em cada secção.',
                            '- Evita frases meta (ex.: "como IA...").',
                            '- Não devolvas resposta curta nem vazia.',
                        ].join('\n');
                    try {
                        const response = await fetch(
                            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
                            {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    contents: [{ role: 'user', parts: [{ text: attemptPrompt }] }],
                                    generationConfig: {
                                        temperature: 0.15,
                                        maxOutputTokens: 1200,
                                    },
                                }),
                            }
                        );
                        const payload = await response.json().catch(() => ({}));
                        if (!response.ok) {
                            const errorText = String(payload?.error?.message || '').toLowerCase();
                            if (errorText.includes('leaked') || errorText.includes('api key')) {
                                continue;
                            }
                            continue;
                        }
                        const answer = parseGeminiAnswerText(payload);
                        const trimmedAnswer = String(answer || '').trim();
                        if (!trimmedAnswer) continue;

                        if (!bestCandidate || trimmedAnswer.length > bestCandidate.length) {
                            bestCandidate = trimmedAnswer;
                        }

                        if (!isWeakAssistantAnswer(trimmedAnswer) && !isGenericTemplateAnswer(trimmedAnswer) && (trimmedAnswer.length >= 220 || isStructuredTechnicalAnswer(trimmedAnswer))) {
                            return trimmedAnswer.slice(0, INTERNAL_AI_RESPONSE_MAX_CHARS);
                        }
                    } catch {
                        continue;
                    }
                }
            }
        }

        if (bestCandidate && !isWeakAssistantAnswer(bestCandidate) && !isGenericTemplateAnswer(bestCandidate)) {
            return bestCandidate.slice(0, INTERNAL_AI_RESPONSE_MAX_CHARS);
        }

        if (isQuestionAboutUsedCarsVat(trimmedQuestion)) {
            return buildUsedCarsVatFallbackAnswer({ allowedSites: sourceUrlsActuallyUsed.length ? sourceUrlsActuallyUsed : safeSites }).slice(0, INTERNAL_AI_RESPONSE_MAX_CHARS);
        }

        return buildGenericProfessionalFallbackAnswer({
            question: trimmedQuestion,
            trustedSites: sourceUrlsActuallyUsed.length ? sourceUrlsActuallyUsed : safeSites,
        }).slice(0, INTERNAL_AI_RESPONSE_MAX_CHARS);
    }

    async function maybeQueueInternalAssistantReply({
        conversationId,
        senderUserId,
        messageBody,
        triggerMessageId,
    }) {
        const conversation = await dbGetAsync(
            `SELECT id, type FROM internal_conversations WHERE id = ? LIMIT 1`,
            [conversationId]
        );
        if (!conversation || String(conversation.type || '').trim() !== 'direct') return;

        const members = await dbAllAsync(
            `SELECT u.id, u.name, u.is_ai_assistant, u.ai_allowed_sites_json
             FROM internal_conversation_members m
             JOIN users u ON u.id = m.user_id
             WHERE m.conversation_id = ?`,
            [conversationId]
        );
        if (!Array.isArray(members) || members.length < 2) return;

        const senderRow = members.find((item) => String(item.id || '').trim() === senderUserId);
        if (parseBoolean(senderRow?.is_ai_assistant)) return;

        const aiMember = members.find(
            (item) => parseBoolean(item?.is_ai_assistant) && String(item.id || '').trim() !== senderUserId
        );
        if (!aiMember) return;

        const aiUserId = String(aiMember.id || '').trim();
        const aiName = String(aiMember.name || '').trim() || 'Assistente IA';
        const aiSites = normalizeAiAllowedSites(aiMember.ai_allowed_sites_json);

        const recentRows = await dbAllAsync(
            `SELECT id, sender_user_id, body, type, created_at
             FROM internal_messages
             WHERE conversation_id = ?
               AND deleted_at IS NULL
             ORDER BY id DESC
             LIMIT 12`,
            [conversationId]
        );
        const orderedHistory = Array.isArray(recentRows) ? recentRows.slice().reverse() : [];
        const conversationHistory = normalizeConversationHistoryRows(orderedHistory, aiUserId, 10);

        const processingBody = 'Olá, sou a sua assistente. Vou analisar a melhor resposta técnica para esta questão...';
        const processingInsert = await dbRunAsync(
            `INSERT INTO internal_messages (
                conversation_id, sender_user_id, body, type, reply_to_message_id, media_path, mime_type, file_name, file_size, created_at
            ) VALUES (?, ?, ?, 'text', ?, NULL, NULL, NULL, NULL, CURRENT_TIMESTAMP)`,
            [conversationId, aiUserId, processingBody, triggerMessageId || null]
        );
        const processingMessageId = Number(processingInsert?.lastID || 0);

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
            [conversationId, aiUserId]
        );

        const answer = await generateInternalAssistantAnswer({
            question: messageBody,
            assistantName: aiName,
            allowedSites: aiSites,
            conversationHistory,
        });
        let finalAnswer = String(answer || '').trim();
        if (isWeakAssistantAnswer(finalAnswer, triggerMessageId || null)) {
            finalAnswer = [
                '1) Enquadramento legal',
                'Não foi possível produzir resposta técnica fiável com as fontes consultadas neste momento.',
                '',
                '2) Solução proposta',
                'Reformule a pergunta com mais contexto (tipo de operação, regime aplicável, datas e enquadramento fiscal) para emitir parecer técnico.',
                '',
                '3) Pareceres / Informações vinculativas',
                'Não identificado nas fontes consultadas.',
                '',
                '4) Legislação aplicável',
                'Não identificado nas fontes consultadas.',
                '',
                'Fontes consultadas:',
                aiSites.map((site) => `- ${site}`).join('\n') || '- (sem fontes disponíveis)',
            ].join('\n');
        }
        finalAnswer = ensureFormalAssistantIntro(finalAnswer);
        if (!finalAnswer) return;

        await dbRunAsync(
            `UPDATE internal_messages
             SET body = ?, edited_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [finalAnswer, processingMessageId]
        );

        await writeAuditLog({
            actorUserId: aiUserId,
            entityType: 'internal_message',
            entityId: String(processingMessageId || '').trim() || null,
            action: 'create_ai_reply',
            details: {
                conversationId,
                replyToMessageId: triggerMessageId || null,
                sites: aiSites,
            },
        });
    }

    function formatDateYmdToPt(value) {
        const raw = String(value || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
        const [year, month, day] = raw.split('-');
        return `${day}/${month}/${year}`;
    }

    function buildPedidoStatusNotificationMessage({
        status,
        tipo,
        descricao,
        dataInicio,
        dataFim,
        motivo,
    }) {
        const normalizedStatus = normalizePedidoStatus(status);
        const tipoText = String(tipo || 'Pedido').trim() || 'Pedido';
        const descricaoText = stripLegacyRequestTag(descricao || '');
        const motivoText = String(motivo || '').trim();
        const inicio = formatDateYmdToPt(dataInicio);
        const fim = formatDateYmdToPt(dataFim);
        const hasPeriod = Boolean(inicio);
        const periodText = hasPeriod
            ? inicio && fim && inicio !== fim
                ? ` (${inicio} -> ${fim})`
                : ` (${inicio || fim})`
            : '';
        const descricaoBlock = descricaoText ? `\n\nDescrição do pedido:\n${descricaoText}` : '';
        const motivoBlock = motivoText ? `\n\nMotivo da decisão:\n${motivoText}` : '';

        if (isPedidoApprovedStatus(normalizedStatus)) {
            return `✅ O seu pedido "${tipoText}" foi APROVADO${periodText}.${descricaoBlock}${motivoBlock}`;
        }
        if (isPedidoRejectedStatus(normalizedStatus)) {
            return `❌ O seu pedido "${tipoText}" foi REJEITADO${periodText}.${descricaoBlock}${motivoBlock}`;
        }
        return `ℹ️ O seu pedido "${tipoText}" mudou de estado para ${normalizedStatus || 'ATUALIZADO'}${periodText}.${descricaoBlock}${motivoBlock}`;
    }

    async function resolveFallbackSenderUserId(preferredUserId, requesterUserId) {
        const preferred = String(preferredUserId || '').trim();
        if (preferred) {
            const exists = await dbGetAsync('SELECT id FROM users WHERE id = ? LIMIT 1', [preferred]);
            if (exists?.id) return String(exists.id).trim();
        }

        const admin = await dbGetAsync(
            "SELECT id FROM users WHERE role = 'ADMIN' ORDER BY datetime(updated_at) DESC LIMIT 1"
        );
        if (admin?.id) return String(admin.id).trim();

        return String(requesterUserId || '').trim();
    }

    async function readSupabasePedidoRow({
        pedidosTable,
        pedidoId,
    }) {
        const url =
            `${SUPABASE_URL}/rest/v1/${encodeURIComponent(pedidosTable)}` +
            `?select=*&id=eq.${encodeURIComponent(String(pedidoId || '').trim())}&limit=1`;

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
        });
        const payload = await response.json().catch(() => []);
        if (!response.ok) {
            const errorText =
                (typeof payload?.message === 'string' && payload.message) ||
                (typeof payload?.error === 'string' && payload.error) ||
                `HTTP ${response.status}`;
            throw new Error(errorText);
        }
        if (!Array.isArray(payload) || payload.length === 0) return null;
        return payload[0] || null;
    }

    async function bootstrapSupabasePedidosTrackingFromLegacySupabase({
        pedidosTable,
        funcionariosTable,
        statusColumn,
        tipoColumn,
        descricaoColumn,
        force = false,
    }) {
        const nowMs = Date.now();
        const cooldownMs = 60 * 1000;
        if (!force && supabasePedidosLegacyBootstrapDone && nowMs - supabasePedidosLegacyBootstrapAtMs < cooldownMs) {
            return;
        }

        const trackedRows = await dbAllAsync('SELECT supabase_pedido_id FROM supabase_pedidos_tracking');
        const trackedIds = new Set(
            (Array.isArray(trackedRows) ? trackedRows : [])
                .map((row) => String(row?.supabase_pedido_id || '').trim())
                .filter(Boolean)
        );

        const localUsers = await dbAllAsync('SELECT id, name, email FROM users');
        const localById = new Map(
            (Array.isArray(localUsers) ? localUsers : [])
                .map((user) => [String(user?.id || '').trim(), user])
                .filter(([id]) => Boolean(id))
        );
        const localByEmail = new Map(
            (Array.isArray(localUsers) ? localUsers : [])
                .map((user) => [String(user?.email || '').trim().toLowerCase(), user])
                .filter(([email]) => Boolean(email))
        );

        const supabaseFuncionariosById = new Map();
        if (funcionariosTable) {
            const funcUrl = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(funcionariosTable)}?select=id,email&limit=2000`;
            const funcResponse = await fetch(funcUrl, {
                method: 'GET',
                headers: {
                    apikey: SUPABASE_KEY,
                    Authorization: `Bearer ${SUPABASE_KEY}`,
                },
            });
            const funcPayload = await funcResponse.json().catch(() => []);
            if (funcResponse.ok && Array.isArray(funcPayload)) {
                for (const item of funcPayload) {
                    const id = String(item?.id || '').trim().toLowerCase();
                    if (!id) continue;
                    supabaseFuncionariosById.set(id, {
                        id,
                        email: String(item?.email || '').trim().toLowerCase(),
                    });
                }
            }
        }

        const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(pedidosTable)}?select=*&limit=2000`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
            },
        });
        const payload = await response.json().catch(() => []);
        if (!response.ok) {
            const errorText =
                (typeof payload?.message === 'string' && payload.message) ||
                (typeof payload?.error === 'string' && payload.error) ||
                `HTTP ${response.status}`;
            throw new Error(`Falha no bootstrap de pedidos legados: ${errorText}`);
        }
        if (!Array.isArray(payload) || payload.length === 0) {
            supabasePedidosLegacyBootstrapDone = true;
            supabasePedidosLegacyBootstrapAtMs = Date.now();
            return;
        }

        for (const row of payload) {
            const pedidoId = String(row?.id || '').trim();
            if (!pedidoId || trackedIds.has(pedidoId)) continue;

            const descricao = String(row?.[descricaoColumn] || '').trim();
            let requesterUserId = extractRequesterUserIdFromLegacyDescricao(descricao);
            let requesterName = extractRequesterNameFromLegacyDescricao(descricao) || null;

            if (!requesterUserId) {
                const sourceFuncionarioId = String(row?.funcionario_id || row?.atribuido_a || '').trim().toLowerCase();
                if (sourceFuncionarioId) {
                    const localIdGuess = `ext_u_${sourceFuncionarioId}`;
                    const localByExactId = localById.get(localIdGuess);
                    if (localByExactId?.id) {
                        requesterUserId = String(localByExactId.id).trim();
                        requesterName = requesterName || String(localByExactId.name || '').trim() || null;
                    } else {
                        const supaFuncionario = supabaseFuncionariosById.get(sourceFuncionarioId);
                        const localByEmailMatch = supaFuncionario?.email
                            ? localByEmail.get(String(supaFuncionario.email || '').trim().toLowerCase())
                            : null;
                        if (localByEmailMatch?.id) {
                            requesterUserId = String(localByEmailMatch.id).trim();
                            requesterName = requesterName || String(localByEmailMatch.name || '').trim() || null;
                        }
                    }
                }
            }

            if (!requesterUserId) continue;
            const requesterExists = await dbGetAsync('SELECT id FROM users WHERE id = ? LIMIT 1', [requesterUserId]);
            if (!requesterExists?.id) continue;

            await upsertTrackedSupabasePedido({
                supabasePedidoId: pedidoId,
                supabaseTable: pedidosTable,
                requesterUserId,
                requesterName,
                managerUserId: null,
                tipo: String(row?.[tipoColumn] || '').trim(),
                descricao,
                statusLast: String(row?.[statusColumn] || 'PENDENTE').trim(),
            });
            trackedIds.add(pedidoId);
        }

        supabasePedidosLegacyBootstrapDone = true;
        supabasePedidosLegacyBootstrapAtMs = Date.now();
    }

    async function processSupabasePedidosStatusChanges({ forceRun = false } = {}) {
        if (supabasePedidosStatusWatcherRunning && !forceRun) {
            return { processed: 0, notified: 0, skipped: 0 };
        }
        if (!SUPABASE_URL || !SUPABASE_KEY) {
            return { processed: 0, notified: 0, skipped: 0 };
        }
        await ensureSupabasePedidosTrackingSchema();

        supabasePedidosStatusWatcherRunning = true;
        const notifyRejectedRaw = String(process.env.SUPABASE_PEDIDOS_NOTIFY_REJECTED ?? '').trim();
        const notifyRejected = notifyRejectedRaw ? parseBoolean(notifyRejectedRaw) : true;

        let processed = 0;
        let notified = 0;
        let skipped = 0;
        try {
            const pedidosTableRequested = String(process.env.SUPABASE_PEDIDOS_SOURCE || 'pedidos').trim();
            const pedidosTable = typeof resolveSupabaseTableName === 'function'
                ? await resolveSupabaseTableName(pedidosTableRequested, ['public.pedidos', 'pedidos'])
                : pedidosTableRequested;
            const funcionariosTableRequested = String(SUPABASE_FUNCIONARIOS_SOURCE || 'funcionarios').trim();
            const funcionariosTable = typeof resolveSupabaseTableName === 'function'
                ? await resolveSupabaseTableName(funcionariosTableRequested, ['public.funcionarios', 'funcionarios'])
                : funcionariosTableRequested;

            const statusColumn = String(process.env.SUPABASE_PEDIDOS_STATUS_COLUMN || 'status').trim();
            const tipoColumn = String(process.env.SUPABASE_PEDIDOS_TYPE_COLUMN || 'tipo').trim();
            const descricaoColumn = String(process.env.SUPABASE_PEDIDOS_DESCRIPTION_COLUMN || 'descricao').trim();
            const dataInicioColumn = String(process.env.SUPABASE_PEDIDOS_START_DATE_COLUMN || 'data_inicio').trim();
            const dataFimColumn = String(process.env.SUPABASE_PEDIDOS_END_DATE_COLUMN || 'data_fim').trim();

            await bootstrapSupabasePedidosTrackingFromLegacySupabase({
                pedidosTable,
                funcionariosTable,
                statusColumn,
                tipoColumn,
                descricaoColumn,
                force: forceRun,
            });

            const trackedRows = await dbAllAsync(
                `SELECT
                    supabase_pedido_id,
                    requester_user_id,
                    requester_name,
                    manager_user_id,
                    tipo,
                    descricao,
                    status_last,
                    status_notified,
                    decision_reason_notified
                 FROM supabase_pedidos_tracking
                 WHERE closed_at IS NULL
                 ORDER BY datetime(updated_at) ASC
                 LIMIT 200`
            );
            if (!Array.isArray(trackedRows) || trackedRows.length === 0) {
                return { processed, notified, skipped };
            }

            for (const tracked of trackedRows) {
                processed += 1;
                const pedidoId = String(tracked?.supabase_pedido_id || '').trim();
                const requesterUserId = String(tracked?.requester_user_id || '').trim();
                if (!pedidoId || !requesterUserId) {
                    skipped += 1;
                    continue;
                }

                let row;
                try {
                    row = await readSupabasePedidoRow({
                        pedidosTable,
                        pedidoId,
                    });
                } catch (readError) {
                    console.error('[Pedidos Sync] Falha ao ler estado no Supabase:', {
                        pedidoId,
                        error: readError?.message || readError,
                    });
                    skipped += 1;
                    continue;
                }

                if (!row) {
                    skipped += 1;
                    continue;
                }

                const statusRaw = String(row?.[statusColumn] || '').trim();
                const normalizedStatus = normalizePedidoStatus(statusRaw);
                const normalizedLastStatus = normalizePedidoStatus(tracked?.status_last || '');
                const normalizedNotified = normalizePedidoStatus(tracked?.status_notified || '');

                const tipo = String(row?.[tipoColumn] || tracked?.tipo || '').trim();
                const descricao = String(row?.[descricaoColumn] || tracked?.descricao || '').trim();
                const dataInicio = String(row?.[dataInicioColumn] || '').trim();
                const dataFim = String(row?.[dataFimColumn] || '').trim();
                const motivo = extractPedidoDecisionReason(row);
                const motivoNotificado = String(tracked?.decision_reason_notified || '').trim();

                const finalStatus = isPedidoFinalStatus(normalizedStatus, notifyRejected);
                const reasonChangedAfterStatus = finalStatus
                    && normalizedStatus === normalizedNotified
                    && motivo
                    && motivo !== motivoNotificado;
                const shouldNotify = finalStatus
                    && (normalizedStatus !== normalizedNotified || reasonChangedAfterStatus);
                let notificationSent = false;

                if (shouldNotify) {
                    try {
                        const recipientExists = await dbGetAsync('SELECT id FROM users WHERE id = ? LIMIT 1', [requesterUserId]);
                        if (!recipientExists?.id) {
                            skipped += 1;
                        } else {
                            const senderUserId = await resolveFallbackSenderUserId(tracked?.manager_user_id, requesterUserId);
                            const conversationId = await ensureDirectConversationBetweenUsers({
                                userId: requesterUserId,
                                targetUserId: requesterUserId,
                                titleIfSelf: 'Notas e Avisos',
                            });
                            const body = buildPedidoStatusNotificationMessage({
                                status: normalizedStatus,
                                tipo,
                                descricao,
                                dataInicio,
                                dataFim,
                                motivo,
                            });
                            await sendInternalSystemMessage({
                                conversationId,
                                senderUserId,
                                recipientUserId: requesterUserId,
                                body,
                            });
                            notified += 1;
                            notificationSent = true;
                        }
                    } catch (notifyError) {
                        console.error('[Pedidos Sync] Falha ao notificar funcionário no chat:', {
                            pedidoId,
                            error: notifyError?.message || notifyError,
                        });
                        skipped += 1;
                    }
                }

                const finalStatusReached = isPedidoApprovedStatus(normalizedStatus)
                    || isPedidoRejectedStatus(normalizedStatus);
                const markClosed = finalStatusReached && (notificationSent || !shouldNotify);

                await dbRunAsync(
                    `UPDATE supabase_pedidos_tracking
                     SET status_last = ?,
                         tipo = ?,
                         descricao = ?,
                         status_notified = CASE
                            WHEN ? THEN ?
                            ELSE status_notified
                         END,
                         decision_reason_notified = CASE
                            WHEN ? THEN ?
                            ELSE decision_reason_notified
                         END,
                         updated_at = CURRENT_TIMESTAMP,
                         closed_at = CASE
                            WHEN ? THEN COALESCE(closed_at, CURRENT_TIMESTAMP)
                            ELSE NULL
                         END
                     WHERE supabase_pedido_id = ?`,
                    [
                        normalizedStatus || normalizedLastStatus || 'PENDENTE',
                        tipo || null,
                        descricao || null,
                        notificationSent ? 1 : 0,
                        notificationSent ? normalizedStatus : null,
                        notificationSent ? 1 : 0,
                        notificationSent ? motivo : null,
                        markClosed ? 1 : 0,
                        pedidoId,
                    ]
                );
            }

            return { processed, notified, skipped };
        } finally {
            supabasePedidosStatusWatcherRunning = false;
        }
    }

    function bootstrapSupabasePedidosStatusWatcher() {
        if (supabasePedidosStatusWatcherBootstrapped) return;
        supabasePedidosStatusWatcherBootstrapped = true;
        if (!SUPABASE_URL || !SUPABASE_KEY) return;

        const intervalRaw = Number(process.env.SUPABASE_PEDIDOS_STATUS_POLL_MS || 45000);
        const intervalMs = Number.isFinite(intervalRaw)
            ? Math.max(15000, Math.min(10 * 60 * 1000, intervalRaw))
            : 45000;

        setTimeout(() => {
            void processSupabasePedidosStatusChanges().catch((error) => {
                console.error('[Pedidos Sync] Falha na verificação inicial:', error?.message || error);
            });
        }, 12000);

        supabasePedidosStatusWatcherTimer = setInterval(() => {
            void processSupabasePedidosStatusChanges().catch((error) => {
                console.error('[Pedidos Sync] Falha na verificação periódica:', error?.message || error);
            });
        }, intervalMs);
    }

    // ── Sub-module delegation ──────────────────────────────────────
    const helpers = {
        parseBoolean,
        normalizeSourceTaskStatus,
        normalizeSourceTaskPriority,
        toIsoDateTime,
        buildFallbackTaskSourceId,
        extractNifCandidates,
        appendLookupIndex,
        ensureSoftwareLinksSchema,
        mapInternalMessageRow,
        ensureInternalMediaRoot,
        resolveInternalMediaAbsolutePath,
        sanitizeInternalFileName,
        ensureInternalMessageReactionsSchema,
        touchInternalChatPresence,
        readInternalChatPresence,
        syncInternalChatHistoryFromSupabase,
        maybeQueueInternalAssistantReply,
        deleteInternalChatPlaceholderUserIfOrphan,
        ensureDirectConversationBetweenUsers,
        internalChatSupabaseHistorySyncRunning_get: () => internalChatSupabaseHistorySyncRunning,
        internalChatSupabaseHistorySyncRunning_set: (v) => { internalChatSupabaseHistorySyncRunning = v; },
        sendInternalSystemMessage,
        upsertTrackedSupabasePedido,
        bootstrapSupabasePedidosStatusWatcher,
        processSupabasePedidosStatusChanges,
    };

    const { registerTasksCallsRoutes } = require('./localDataTasksCallsRoutes');
    const { registerInternalChatRoutes } = require('./localDataInternalChatRoutes');
    const { registerPedidosPontoRoutes } = require('./localDataPedidosPontoRoutes');
    const { registerAnalyticsRoutes } = require('./localDataAnalyticsRoutes');

    registerTasksCallsRoutes(context, helpers);
    registerInternalChatRoutes(context, helpers);
    registerPedidosPontoRoutes(context, helpers);
    registerAnalyticsRoutes(context);
}

module.exports = {
    registerLocalDataRoutes,
};
