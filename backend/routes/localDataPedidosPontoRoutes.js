'use strict';

const crypto = require('crypto');

/**
 * Internal Chat user tasks, Ponto (time tracking) & Pedidos (requests) routes.
 * Extracted from localDataRoutes.js for maintainability.
 */
function registerPedidosPontoRoutes(context, helpers) {
    const {
        app, dbRunAsync, dbGetAsync, dbAllAsync, writeAuditLog,
        SUPABASE_URL, SUPABASE_KEY,
        SUPABASE_FUNCIONARIOS_SOURCE,
        fetchSupabaseTable, fetchSupabaseTableWithFilters, resolveSupabaseTableName, nowIso,
        parseSourceId = (_id, explicitSourceId) => String(explicitSourceId || '').trim(),
    } = context;

    const {
        ensureDirectConversationBetweenUsers, sendInternalSystemMessage,
        upsertTrackedSupabasePedido,
        bootstrapSupabasePedidosStatusWatcher,
        processSupabasePedidosStatusChanges,
    } = helpers;

    app.get('/api/internal-chat/users/:userId/open-tasks', async (req, res) => {
        try {
            const userId = String(req.params.userId || '').trim();
            const viewerUserId = String(req.query.viewerUserId || req.query.actorUserId || userId).trim();
            const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50) || 50));
            if (!userId) {
                return res.status(400).json({ success: false, error: 'userId é obrigatório.' });
            }
            if (!viewerUserId) {
                return res.status(400).json({ success: false, error: 'viewerUserId é obrigatório.' });
            }

            const userExists = await dbGetAsync('SELECT id FROM users WHERE id = ? LIMIT 1', [userId]);
            if (!userExists) {
                return res.status(404).json({ success: false, error: 'Funcionário não encontrado.' });
            }

            const viewer = await dbGetAsync('SELECT id, email, role FROM users WHERE id = ? LIMIT 1', [viewerUserId]);
            if (!viewer) {
                return res.status(404).json({ success: false, error: 'Utilizador da sessão não encontrado.' });
            }

            if (viewerUserId !== userId) {
                const viewerRole = String(viewer?.role || '').trim().toUpperCase();
                const viewerEmail = String(viewer?.email || '').trim().toLowerCase();
                const canViewAll = viewerRole === 'ADMIN' || viewerEmail === 'mpr@mpr.pt';
                if (!canViewAll) {
                    return res.status(403).json({
                        success: false,
                        error: 'Sem permissão para visualizar tarefas de outros funcionários.',
                    });
                }
            }

            const rows = await dbAllAsync(
                `SELECT
                    t.id,
                    t.title,
                    t.status,
                    t.priority,
                    t.due_date,
                    t.notes,
                    t.conversation_id,
                    c.customer_id,
                    cu.name AS customer_name,
                    cu.company AS customer_company
                 FROM tasks t
                 LEFT JOIN conversations c ON c.id = t.conversation_id
                 LEFT JOIN customers cu ON cu.id = c.customer_id
                 WHERE t.assigned_user_id = ?
                   AND LOWER(COALESCE(t.status, '')) != 'done'
                 ORDER BY
                    CASE
                      WHEN t.due_date IS NULL OR TRIM(t.due_date) = '' THEN 1
                      ELSE 0
                    END ASC,
                    datetime(t.due_date) ASC,
                    datetime(t.updated_at) DESC
                 LIMIT ?`,
                [userId, limit]
            );

            const data = (Array.isArray(rows) ? rows : []).map((row) => ({
                id: String(row?.id || '').trim(),
                title: String(row?.title || '').trim(),
                status: String(row?.status || '').trim() || 'open',
                priority: String(row?.priority || '').trim() || 'normal',
                dueDate: String(row?.due_date || '').trim() || '',
                notes: String(row?.notes || '').trim() || '',
                conversationId: String(row?.conversation_id || '').trim() || '',
                customerId: String(row?.customer_id || '').trim() || '',
                customerName:
                    String(row?.customer_company || '').trim() ||
                    String(row?.customer_name || '').trim() ||
                    '',
            }));

            return res.json({ success: true, data });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao listar tarefas por funcionário:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    const normalizePinValue = (value) => String(value === undefined || value === null ? '' : value).replace(/\s+/g, '').trim();

    const FUNCIONARIOS_CACHE_TTL_MS = (() => {
        const raw = Number(process.env.SUPABASE_FUNCIONARIOS_CACHE_TTL_MS || 180000);
        if (!Number.isFinite(raw) || raw <= 0) return 0;
        return Math.max(30000, Math.min(15 * 60 * 1000, raw));
    })();
    const FUNCIONARIOS_FULL_SCAN_FALLBACK = String(process.env.SUPABASE_FUNCIONARIOS_FULL_SCAN_FALLBACK || '1')
        .trim()
        .toLowerCase() !== '0';
    const funcionarioLookupCache = new Map();
    const funcionariosListCache = {
        expiresAt: 0,
        rows: null,
        pending: null,
    };

    function getCacheEntry(cache, key) {
        if (!FUNCIONARIOS_CACHE_TTL_MS) return undefined;
        const entry = cache.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= Date.now()) {
            cache.delete(key);
            return undefined;
        }
        return entry.value;
    }

    function setCacheEntry(cache, key, value) {
        if (!FUNCIONARIOS_CACHE_TTL_MS) return;
        cache.set(key, { value, expiresAt: Date.now() + FUNCIONARIOS_CACHE_TTL_MS });
    }

    async function fetchFuncionariosRowsCached(tableName) {
        if (!FUNCIONARIOS_CACHE_TTL_MS || !tableName) {
            const rowsRaw = await fetchSupabaseTable(tableName);
            return Array.isArray(rowsRaw) ? rowsRaw : [];
        }
        const now = Date.now();
        if (funcionariosListCache.rows && funcionariosListCache.expiresAt > now) {
            return funcionariosListCache.rows;
        }
        if (funcionariosListCache.pending) {
            return funcionariosListCache.pending;
        }
        funcionariosListCache.pending = (async () => {
            try {
                const rowsRaw = await fetchSupabaseTable(tableName);
                const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
                funcionariosListCache.rows = rows;
                funcionariosListCache.expiresAt = Date.now() + FUNCIONARIOS_CACHE_TTL_MS;
                return rows;
            } finally {
                funcionariosListCache.pending = null;
            }
        })();
        return funcionariosListCache.pending;
    }

    async function fetchFuncionarioByFilter(tableName, column, value) {
        if (typeof fetchSupabaseTableWithFilters !== 'function') return null;
        const normalizedValue = String(value || '').trim();
        if (!normalizedValue) return null;
        const cacheKey = `${tableName}|${column}|${normalizedValue}`;
        const cached = getCacheEntry(funcionarioLookupCache, cacheKey);
        if (cached !== undefined) return cached;
        try {
            const rows = await fetchSupabaseTableWithFilters(
                tableName,
                { [column]: normalizedValue },
                { limit: 1 }
            );
            const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
            setCacheEntry(funcionarioLookupCache, cacheKey, row);
            return row;
        } catch (error) {
            setCacheEntry(funcionarioLookupCache, cacheKey, null);
            return null;
        }
    }

    const pickSupabaseFuncionarioPin = (funcionarioRow) => {
        const candidates = [
            funcionarioRow?.pin,
            funcionarioRow?.pin_pessoal,
            funcionarioRow?.pin_ponto,
            funcionarioRow?.password,
            funcionarioRow?.senha,
        ];
        for (const candidate of candidates) {
            const normalized = normalizePinValue(candidate);
            if (normalized) return normalized;
        }
        return '';
    };

    const USER_ID_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    function isUuid(value) {
        return USER_ID_UUID_REGEX.test(String(value || '').trim());
    }

    function isAliasUserId(value) {
        const normalizedValue = String(value || '').trim().toLowerCase();
        return normalizedValue.startsWith('ext_') || normalizedValue.startsWith('est_');
    }

    function localUserResolutionScore(userRow, requestedId) {
        const normalizedId = String(userRow?.id || '').trim();
        const normalizedRequestedId = String(requestedId || '').trim();
        let score = 0;
        if (!normalizedId) return score;
        if (normalizedId === normalizedRequestedId) score += 25;
        if (!isAliasUserId(normalizedId)) score += 120;
        if (isUuid(normalizedId)) score += 60;
        if (normalizedId.startsWith('local_')) score += 40;
        if (/^u\d+$/i.test(normalizedId)) score += 20;
        if (normalizedId.startsWith('ext_')) score -= 40;
        if (normalizedId.startsWith('est_')) score -= 80;
        if (String(userRow?.email || '').trim()) score += 5;
        return score;
    }

    async function resolveLocalUserRow(userIdOrAlias, fallbackEmail) {
        const requestedId = String(userIdOrAlias || '').trim();
        const normalizedEmail = String(fallbackEmail || '').trim().toLowerCase();
        const sourceCandidates = Array.from(
            new Set([
                String(parseSourceId(requestedId, '') || '').trim(),
                requestedId.startsWith('ext_u_') ? requestedId.slice('ext_u_'.length) : '',
                requestedId.startsWith('est_u_') ? requestedId.slice('est_u_'.length) : '',
                requestedId,
            ].filter(Boolean))
        );

        const candidates = [];
        const seenIds = new Set();
        const appendRows = (rows) => {
            if (!Array.isArray(rows)) return;
            rows.forEach((row) => {
                const id = String(row?.id || '').trim();
                if (!id || seenIds.has(id)) return;
                seenIds.add(id);
                candidates.push(row);
            });
        };

        if (requestedId) {
            appendRows(
                await dbAllAsync(
                    'SELECT id, source_id, name, email, password FROM users WHERE id = ?',
                    [requestedId]
                )
            );
        }

        if (sourceCandidates.length > 0) {
            const placeholders = sourceCandidates.map(() => '?').join(', ');
            appendRows(
                await dbAllAsync(
                    `SELECT id, source_id, name, email, password FROM users WHERE id IN (${placeholders})`,
                    sourceCandidates
                )
            );
            appendRows(
                await dbAllAsync(
                    `SELECT id, source_id, name, email, password FROM users WHERE source_id IN (${placeholders})`,
                    sourceCandidates
                )
            );
        }

        if (normalizedEmail) {
            appendRows(
                await dbAllAsync(
                    'SELECT id, source_id, name, email, password FROM users WHERE lower(email) = lower(?)',
                    [normalizedEmail]
                )
            );
        }

        if (candidates.length === 0) return null;
        candidates.sort(
            (a, b) => localUserResolutionScore(b, requestedId) - localUserResolutionScore(a, requestedId)
        );
        return candidates[0] || null;
    }

    async function resolveSupabaseFuncionarioContext(userIdOrAlias, fallbackEmail, errorMessages = {}) {
        const requestedId = String(userIdOrAlias || '').trim();
        const normalizedEmail = String(fallbackEmail || '').trim().toLowerCase();
        const {
            missingUserMessage = 'Identificador do funcionário é obrigatório.',
            localUserNotFoundMessage = 'Funcionário local não encontrado.',
            supabaseMapNotFoundMessage = 'Funcionário não mapeado no Supabase.',
        } = errorMessages;

        if (!requestedId && !normalizedEmail) {
            const missingError = new Error(missingUserMessage);
            missingError.statusCode = 400;
            throw missingError;
        }

        const localUser = await resolveLocalUserRow(requestedId, normalizedEmail);
        if (!localUser) {
            const notFoundError = new Error(localUserNotFoundMessage);
            notFoundError.statusCode = 404;
            notFoundError.details = {
                requestedUserId: requestedId || null,
                requestedEmail: normalizedEmail || null,
            };
            throw notFoundError;
        }

        const localUserId = String(localUser?.id || '').trim();
        const localEmail = String(localUser?.email || '').trim().toLowerCase();
        const resolvedSourceId = String(parseSourceId(localUserId, localUser?.source_id) || '').trim();
        const sourceCandidates = Array.from(
            new Set([
                resolvedSourceId,
                String(localUser?.source_id || '').trim(),
                String(parseSourceId(requestedId, '') || '').trim(),
                requestedId.startsWith('ext_u_') ? requestedId.slice('ext_u_'.length) : '',
                requestedId.startsWith('est_u_') ? requestedId.slice('est_u_'.length) : '',
                requestedId,
                localUserId,
            ].filter(Boolean))
        );

        const funcionariosTableRequested = String(SUPABASE_FUNCIONARIOS_SOURCE || 'funcionarios').trim();
        const funcionariosTable =
            typeof resolveSupabaseTableName === 'function'
                ? await resolveSupabaseTableName(funcionariosTableRequested, ['public.funcionarios', 'funcionarios'])
                : funcionariosTableRequested;

        const canFilterFuncionarios = typeof fetchSupabaseTableWithFilters === 'function';
        let funcionarioMatch = null;

        if (canFilterFuncionarios) {
            const lookups = [];
            if (localEmail) lookups.push({ column: 'email', value: localEmail });
            for (const candidate of sourceCandidates) {
                lookups.push({ column: 'source_id', value: candidate });
                lookups.push({ column: 'user_id', value: candidate });
                lookups.push({ column: 'local_user_id', value: candidate });
                lookups.push({ column: 'id', value: candidate });
            }

            const seen = new Set();
            for (const lookup of lookups) {
                if (!lookup?.value) continue;
                const key = `${lookup.column}:${lookup.value}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const row = await fetchFuncionarioByFilter(funcionariosTable, lookup.column, lookup.value);
                if (row) {
                    funcionarioMatch = row;
                    break;
                }
            }
        }

        if (!funcionarioMatch && (!canFilterFuncionarios || FUNCIONARIOS_FULL_SCAN_FALLBACK)) {
            const funcionariosRowsRaw = await fetchFuncionariosRowsCached(funcionariosTable).catch((err) => {
                throw new Error(`Falha ao ler funcionários no Supabase: ${err?.message || err}`);
            });
            const funcionariosRows = Array.isArray(funcionariosRowsRaw) ? funcionariosRowsRaw : [];

            const byEmail = localEmail
                ? funcionariosRows.find((row) => String(row?.email || '').trim().toLowerCase() === localEmail)
                : null;

            funcionarioMatch = byEmail || null;
            if (!funcionarioMatch && sourceCandidates.length > 0) {
                funcionarioMatch = funcionariosRows.find((row) => {
                    const rowCandidates = [
                        String(row?.user_id || '').trim(),
                        String(row?.source_id || '').trim(),
                        String(row?.local_user_id || '').trim(),
                        String(row?.id || '').trim(),
                    ].filter(Boolean);
                    return rowCandidates.some((candidate) => sourceCandidates.includes(candidate));
                });
            }
        }

        const funcionarioId = String(funcionarioMatch?.id || '').trim();
        if (!funcionarioId) {
            const mapError = new Error(supabaseMapNotFoundMessage);
            mapError.statusCode = 404;
            mapError.details = {
                requestedUserId: requestedId || null,
                localUserId: localUserId || null,
                localEmail: localEmail || null,
                funcionariosTable,
            };
            throw mapError;
        }

        return {
            localUser,
            localUserId,
            localEmail,
            resolvedSourceId,
            funcionarioRow: funcionarioMatch,
            funcionarioId,
            funcionariosTable,
        };
    }

    async function resolveSupabasePontoContext(actorUserId) {
        const context = await resolveSupabaseFuncionarioContext(actorUserId, '', {
            missingUserMessage: 'actorUserId é obrigatório.',
            localUserNotFoundMessage: 'Funcionário local não encontrado.',
            supabaseMapNotFoundMessage:
                'Funcionário não mapeado no Supabase. Verifique o email/ligação do funcionário antes de registar ponto.',
        });

        const registosPontoTableRequested = String(process.env.SUPABASE_REGISTOS_PONTO_SOURCE || 'registos_ponto').trim();
        const registosPontoTable =
            typeof resolveSupabaseTableName === 'function'
                ? await resolveSupabaseTableName(registosPontoTableRequested, ['public.registos_ponto', 'registos_ponto'])
                : registosPontoTableRequested;

        return {
            actorUser: context.localUser,
            actorEmail: context.localEmail,
            actorSourceId: context.resolvedSourceId,
            funcionarioRow: context.funcionarioRow,
            funcionarioPin: pickSupabaseFuncionarioPin(context.funcionarioRow),
            funcionarioId: context.funcionarioId,
            funcionariosTable: context.funcionariosTable,
            registosPontoTable,
        };
    }

    app.post('/api/internal-chat/ponto/supabase', async (req, res) => {
        try {
            const actorUserId = String(req.body?.actorUserId || '').trim();
            const pin = normalizePinValue(req.body?.pin);
            const origem = String(req.body?.origem || 'oracle').trim() || 'oracle';
            const tipoRaw = String(req.body?.tipo || '')
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim()
                .toUpperCase();

            let tipo = '';
            if (tipoRaw === 'ENTRADA') tipo = 'ENTRADA';
            if (tipoRaw === 'SAIDA') tipo = 'SAIDA';

            if (!actorUserId) {
                return res.status(400).json({ success: false, error: 'actorUserId é obrigatório.' });
            }
            if (!pin) {
                return res.status(400).json({ success: false, error: 'PIN é obrigatório para registar ponto.' });
            }
            if (!tipo) {
                return res.status(400).json({ success: false, error: 'Tipo inválido. Use ENTRADA ou SAIDA.' });
            }

            await dbRunAsync(
                `CREATE TABLE IF NOT EXISTS hr_registos_ponto (
                    id TEXT PRIMARY KEY,
                    funcionario_id TEXT NOT NULL,
                    tipo TEXT NOT NULL,
                    momento TEXT NOT NULL,
                    origem TEXT,
                    supabase_payload_json TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`
            );

            const localActorUser = await dbGetAsync('SELECT id, name, email FROM users WHERE id = ? LIMIT 1', [actorUserId]);
            if (!localActorUser?.id) return res.status(404).json({ success: false, error: 'Utilizador local não encontrado.' });
            const funcionario = await dbGetAsync(
                'SELECT id, nome, pin, activo FROM hr_funcionarios WHERE lower(email) = lower(?) LIMIT 1',
                [String(localActorUser.email || '').trim()]
            );
            if (!funcionario?.id) return res.status(404).json({ success: false, error: 'Funcionário não encontrado na ficha local.' });
            if (Number(funcionario.activo ?? 1) === 0) return res.status(403).json({ success: false, error: 'Funcionário inativo.' });
            const localExpectedPin = normalizePinValue(funcionario.pin);
            if (!localExpectedPin) return res.status(400).json({ success: false, error: 'PIN não configurado na ficha local do funcionário.' });
            if (pin !== localExpectedPin) return res.status(401).json({ success: false, error: `PIN inválido para ${String(localActorUser.name || 'utilizador')}.` });

            const localMomentoRaw = String(req.body?.momento || req.body?.timestamp || '').trim();
            const localParsedMoment = localMomentoRaw ? new Date(localMomentoRaw) : new Date();
            const localMomentoIso = !Number.isNaN(localParsedMoment.getTime()) ? localParsedMoment.toISOString() : new Date().toISOString();
            const id = typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `ponto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
            await dbRunAsync(
                `INSERT INTO hr_registos_ponto (id, funcionario_id, tipo, momento, origem, supabase_payload_json, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [id, String(funcionario.id), tipo, localMomentoIso, origem, JSON.stringify({ storage: 'local', actorUserId })]
            );
            await writeAuditLog({
                actorUserId,
                entityType: 'registo_ponto',
                entityId: id,
                action: 'create_local',
                details: { funcionarioId: String(funcionario.id), tipo, origem, momento: localMomentoIso },
            });
            return res.json({
                success: true,
                table: 'hr_registos_ponto',
                registo: { id, funcionarioId: String(funcionario.id), tipo, origem, momento: localMomentoIso },
            });

            let pontoContext;
            try {
                pontoContext = await resolveSupabasePontoContext(actorUserId);
            } catch (contextError) {
                const statusCode = Number(contextError?.statusCode || 500) || 500;
                return res.status(statusCode).json({
                    success: false,
                    error: contextError?.message || 'Falha ao preparar registo de ponto.',
                    details: contextError?.details || null,
                });
            }

            const actorUser = pontoContext.actorUser;

            const expectedSupabasePin = normalizePinValue(pontoContext?.funcionarioPin);
            const expectedPin = expectedSupabasePin;
            if (!expectedPin) {
                return res.status(400).json({
                    success: false,
                    error: 'PIN não configurado no funcionário no Supabase. Defina o PIN na ficha do funcionário.',
                });
            }
            if (pin !== expectedPin) {
                return res.status(401).json({
                    success: false,
                    error: `PIN inválido para ${String(actorUser?.name || 'utilizador')}.`,
                });
            }

            const funcionarioId = String(pontoContext.funcionarioId || '').trim();
            const registosPontoTable = String(pontoContext.registosPontoTable || '').trim();

            const momentoRaw = String(req.body?.momento || req.body?.timestamp || '').trim();
            const parsedMoment = momentoRaw ? new Date(momentoRaw) : new Date();
            const momentoIso = !Number.isNaN(parsedMoment.getTime()) ? parsedMoment.toISOString() : new Date().toISOString();

            const attemptColumns = ['momento', 'timestamp', null];
            const tipoCandidates = Array.from(new Set([tipo, tipo.toLowerCase()]));
            let lastFailure = null;

            let fatalFailure = false;
            for (const tipoCandidate of tipoCandidates) {
                let shouldTryNextTipo = false;
                for (const dateColumn of attemptColumns) {
                    const payload = {
                        funcionario_id: funcionarioId,
                        tipo: tipoCandidate,
                        origem,
                    };
                    if (dateColumn) payload[dateColumn] = momentoIso;

                    const response = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(registosPontoTable)}`, {
                        method: 'POST',
                        headers: {
                            apikey: SUPABASE_KEY,
                            Authorization: `Bearer ${SUPABASE_KEY}`,
                            'Content-Type': 'application/json',
                            Prefer: 'return=representation',
                        },
                        body: JSON.stringify(payload),
                    });

                    const responseJson = await response.json().catch(() => ({}));
                    if (response.ok) {
                        const createdRow = Array.isArray(responseJson) ? responseJson[0] || null : responseJson || null;
                        const createdAt =
                            String(createdRow?.momento || '').trim() ||
                            String(createdRow?.timestamp || '').trim() ||
                            momentoIso;
                        await writeAuditLog({
                            actorUserId: actorUserId || null,
                            entityType: 'registo_ponto',
                            entityId: createdRow?.id !== undefined && createdRow?.id !== null ? String(createdRow.id) : null,
                            action: 'create_supabase',
                            details: {
                                table: registosPontoTable,
                                funcionarioId,
                                tipo: tipoCandidate,
                                origem,
                                momento: createdAt,
                            },
                        });
                        return res.json({
                            success: true,
                            table: registosPontoTable,
                            registo: {
                                id:
                                    createdRow?.id !== undefined && createdRow?.id !== null
                                        ? String(createdRow.id)
                                        : null,
                                funcionarioId,
                                tipo,
                                origem,
                                momento: createdAt,
                            },
                        });
                    }

                    const errorText =
                        (typeof responseJson?.message === 'string' && responseJson.message) ||
                        (typeof responseJson?.error === 'string' && responseJson.error) ||
                        `HTTP ${response.status}`;
                    const lowerErrorText = String(errorText || '').toLowerCase();
                    const columnMissing =
                        dateColumn &&
                        (lowerErrorText.includes(`could not find the '${dateColumn}' column`) ||
                            lowerErrorText.includes(`column "${dateColumn}" does not exist`) ||
                            lowerErrorText.includes(`unknown field ${dateColumn}`));
                    const tipoRejected =
                        lowerErrorText.includes('registos_ponto_tipo_check') ||
                        lowerErrorText.includes('invalid input value for enum') ||
                        (lowerErrorText.includes('tipo') && lowerErrorText.includes('constraint'));

                    lastFailure = {
                        status: response.status,
                        errorText,
                        details: responseJson,
                        attemptedColumn: dateColumn || '(default)',
                        attemptedTipo: tipoCandidate,
                    };

                    if (columnMissing) {
                        continue;
                    }
                    if (tipoRejected) {
                        shouldTryNextTipo = true;
                        break;
                    }

                    fatalFailure = true;
                    break;
                }

                if (fatalFailure) break;
                if (shouldTryNextTipo) continue;
            }

            const statusCode = Number(lastFailure?.status || 500) || 500;
            return res.status(statusCode).json({
                success: false,
                error:
                    `Falha ao registar ponto no Supabase (${registosPontoTable}): ${lastFailure?.errorText || 'erro desconhecido'}`,
                details: lastFailure?.details || null,
                attemptedColumn: lastFailure?.attemptedColumn || null,
                attemptedTipo: lastFailure?.attemptedTipo || null,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao registar ponto no Supabase:', details);
            return res.status(500).json({
                success: false,
                error: `Falha ao registar ponto no Supabase: ${details}`,
            });
        }
    });

    app.get('/api/internal-chat/ponto/supabase/recent', async (req, res) => {
        try {
            const actorUserId = String(req.query.actorUserId || req.query.userId || '').trim();
            const limit = Math.min(10, Math.max(1, Number(req.query.limit || 2) || 2));
            if (!actorUserId) {
                return res.status(400).json({ success: false, error: 'actorUserId é obrigatório.' });
            }

            const actorUser = await dbGetAsync('SELECT id, email FROM users WHERE id = ? LIMIT 1', [actorUserId]);
            if (!actorUser?.id) return res.status(404).json({ success: false, error: 'Utilizador local não encontrado.' });
            const funcionario = await dbGetAsync(
                'SELECT id FROM hr_funcionarios WHERE lower(email) = lower(?) LIMIT 1',
                [String(actorUser.email || '').trim()]
            );
            if (!funcionario?.id) return res.json({ success: true, table: 'hr_registos_ponto', data: [] });
            const rows = await dbAllAsync(
                `SELECT id, funcionario_id, tipo, momento, origem
                 FROM hr_registos_ponto
                 WHERE funcionario_id = ?
                 ORDER BY datetime(momento) DESC
                 LIMIT ?`,
                [String(funcionario.id), limit]
            );
            return res.json({
                success: true,
                table: 'hr_registos_ponto',
                data: rows.map((row) => ({
                    id: String(row.id || ''),
                    funcionarioId: String(row.funcionario_id || ''),
                    tipo: String(row.tipo || '').toUpperCase() === 'SAIDA' ? 'SAIDA' : 'ENTRADA',
                    origem: String(row.origem || 'oracle'),
                    momento: String(row.momento || ''),
                })),
            });

            let pontoContext;
            try {
                pontoContext = await resolveSupabasePontoContext(actorUserId);
            } catch (contextError) {
                const statusCode = Number(contextError?.statusCode || 500) || 500;
                return res.status(statusCode).json({
                    success: false,
                    error: contextError?.message || 'Falha ao carregar registos de ponto.',
                    details: contextError?.details || null,
                });
            }

            const registosRowsRaw = await fetchSupabaseTable(String(pontoContext.registosPontoTable || '')).catch((err) => {
                throw new Error(`Falha ao ler registos de ponto no Supabase: ${err?.message || err}`);
            });
            const registosRows = Array.isArray(registosRowsRaw) ? registosRowsRaw : [];
            const funcionarioId = String(pontoContext.funcionarioId || '').trim();

            const parsedRows = registosRows
                .map((row) => {
                    const rowFuncionarioId = String(row?.funcionario_id || row?.funcionarioId || '').trim();
                    if (!rowFuncionarioId || rowFuncionarioId !== funcionarioId) return null;
                    const momentoRaw =
                        String(row?.momento || '').trim() ||
                        String(row?.timestamp || '').trim() ||
                        String(row?.created_at || '').trim();
                    const parsedDate = momentoRaw ? new Date(momentoRaw) : null;
                    const momentoIso =
                        parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : momentoRaw || '';
                    const tipoRaw = String(row?.tipo || '').trim().toUpperCase();
                    const tipo = tipoRaw === 'SAIDA' ? 'SAIDA' : 'ENTRADA';
                    return {
                        id:
                            row?.id === undefined || row?.id === null
                                ? null
                                : String(row.id),
                        funcionarioId: rowFuncionarioId,
                        tipo,
                        origem: String(row?.origem || 'oracle').trim() || 'oracle',
                        momento: momentoIso,
                        sortTime: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.getTime() : 0,
                    };
                })
                .filter(Boolean)
                .sort((a, b) => Number(b.sortTime || 0) - Number(a.sortTime || 0))
                .slice(0, limit)
                .map((row) => ({
                    id: row.id,
                    funcionarioId: row.funcionarioId,
                    tipo: row.tipo,
                    origem: row.origem,
                    momento: row.momento,
                }));

            return res.json({
                success: true,
                table: String(pontoContext.registosPontoTable || '').trim(),
                data: parsedRows,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao ler registos de ponto no Supabase:', details);
            return res.status(500).json({
                success: false,
                error: `Falha ao ler registos de ponto no Supabase: ${details}`,
            });
        }
    });

    app.post('/api/internal-chat/pedidos/supabase', async (req, res) => {
        try {
            const actorUserId = String(req.body?.actorUserId || '').trim();
            const actorNameRaw = String(req.body?.actorName || '').trim();
            const actorEmailRaw = String(req.body?.actorEmail || '').trim().toLowerCase();
            const responsibleUserIdRaw = String(
                req.body?.responsibleUserId || req.body?.funcionarioId || req.body?.funcionario_id || ''
            ).trim();
            const tipo = String(req.body?.tipo || req.body?.title || '').trim();
            const descricao = String(req.body?.descricao || req.body?.description || '').trim();
            const dataInicioInput = String(req.body?.dataInicio || req.body?.data_inicio || '').trim();
            const dataFimInput = String(req.body?.dataFim || req.body?.data_fim || '').trim();
            const status = 'PENDENTE';

            if (!tipo) {
                return res.status(400).json({ success: false, error: 'Tipo do pedido é obrigatório.' });
            }
            if (!responsibleUserIdRaw) {
                return res.status(400).json({ success: false, error: 'Funcionário responsável é obrigatório.' });
            }
            const actorUserRow = actorUserId || actorEmailRaw
                ? await resolveLocalUserRow(actorUserId, actorEmailRaw)
                : null;
            const actorTrackingUserId = String(actorUserRow?.id || actorUserId || '').trim();

            await dbRunAsync(
                `CREATE TABLE IF NOT EXISTS hr_pedidos (
                    id TEXT PRIMARY KEY,
                    funcionario_id TEXT,
                    atribuido_a TEXT,
                    tipo TEXT NOT NULL,
                    descricao TEXT,
                    data_inicio TEXT,
                    data_fim TEXT,
                    status TEXT NOT NULL DEFAULT 'PENDENTE',
                    resolucao TEXT,
                    supabase_payload_json TEXT,
                    supabase_created_at TEXT,
                    supabase_updated_at TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )`
            );
            let responsibleFuncionario = await dbGetAsync('SELECT id, nome, email FROM hr_funcionarios WHERE id = ? LIMIT 1', [responsibleUserIdRaw]);
            if (!responsibleFuncionario?.id) {
                const responsibleLocalUser = await dbGetAsync('SELECT id, email FROM users WHERE id = ? LIMIT 1', [responsibleUserIdRaw]);
                if (responsibleLocalUser?.email) {
                    responsibleFuncionario = await dbGetAsync(
                        'SELECT id, nome, email FROM hr_funcionarios WHERE lower(email) = lower(?) LIMIT 1',
                        [String(responsibleLocalUser.email || '').trim()]
                    );
                }
            }
            if (!responsibleFuncionario?.id && actorUserRow?.email) {
                responsibleFuncionario = await dbGetAsync(
                    'SELECT id, nome, email FROM hr_funcionarios WHERE lower(email) = lower(?) LIMIT 1',
                    [String(actorUserRow.email || actorEmailRaw || '').trim()]
                );
            }
            if (!responsibleFuncionario?.id) {
                return res.status(404).json({ success: false, error: 'Funcionário responsável não encontrado na ficha local.' });
            }

            const normalizeLocalDate = (value) => {
                const raw = String(value || '').trim();
                if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
                const parsed = raw ? new Date(raw) : null;
                return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
            };
            const dataInicioLocal = normalizeLocalDate(dataInicioInput) || new Date().toISOString().slice(0, 10);
            const dataFimLocal = normalizeLocalDate(dataFimInput) || dataInicioLocal;
            const pedidoId = typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `pedido_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
            const payloadLocal = {
                id: pedidoId,
                funcionario_id: String(responsibleFuncionario.id),
                atribuido_a: String(responsibleFuncionario.id),
                tipo,
                descricao,
                data_inicio: dataInicioLocal,
                data_fim: dataFimLocal,
                status,
                storage: 'local',
                requester_user_id: actorTrackingUserId,
            };
            await dbRunAsync(
                `INSERT INTO hr_pedidos (
                    id, funcionario_id, atribuido_a, tipo, descricao, data_inicio, data_fim, status,
                    resolucao, supabase_payload_json, supabase_created_at, supabase_updated_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, '', '', CURRENT_TIMESTAMP)`,
                [
                    pedidoId,
                    String(responsibleFuncionario.id),
                    String(responsibleFuncionario.id),
                    tipo,
                    descricao,
                    dataInicioLocal,
                    dataFimLocal,
                    status,
                    JSON.stringify(payloadLocal),
                ]
            );
            try {
                const managerLocalUser = await dbGetAsync('SELECT id, name, email FROM users WHERE lower(email) = lower(?) LIMIT 1', ['mpr@mpr.pt']);
                const managerLocalUserId = String(managerLocalUser?.id || '').trim();
                const actorName = actorNameRaw || String(actorUserRow?.name || responsibleFuncionario.nome || 'Funcionário').trim();
                if (managerLocalUserId) {
                    const conversationId = await ensureDirectConversationBetweenUsers({
                        userId: managerLocalUserId,
                        targetUserId: managerLocalUserId,
                        titleIfSelf: 'Notas e Avisos',
                    });
                    if (conversationId) {
                        await sendInternalSystemMessage({
                            conversationId,
                            senderUserId: actorTrackingUserId || managerLocalUserId,
                            recipientUserId: managerLocalUserId,
                            body: `O funcionário ${actorName} fez um novo pedido (${tipo}) de ${dataInicioLocal}${dataFimLocal !== dataInicioLocal ? ` a ${dataFimLocal}` : ''}.`,
                        });
                    }
                }
            } catch (notifyError) {
                console.error('[Internal Chat] Aviso: falha ao enviar notificação local de pedido:', notifyError?.message || notifyError);
            }
            await writeAuditLog({
                actorUserId: actorTrackingUserId || null,
                entityType: 'pedido',
                entityId: pedidoId,
                action: 'create_local',
                details: { tipo, responsibleUserId: String(responsibleFuncionario.id), status, dataInicio: dataInicioLocal, dataFim: dataFimLocal },
            });
            return res.json({
                success: true,
                table: 'hr_pedidos',
                pedido: { id: pedidoId, funcionarioId: String(responsibleFuncionario.id), tipo, descricao, dataInicio: dataInicioLocal, dataFim: dataFimLocal, status },
            });

            let actorFuncionarioId = '';
            if (actorUserRow?.id || actorEmailRaw) {
                try {
                    const actorSupabaseContext = await resolveSupabaseFuncionarioContext(
                        String(actorUserRow?.id || actorUserId || '').trim(),
                        actorEmailRaw || String(actorUserRow?.email || '').trim(),
                        {
                            localUserNotFoundMessage: 'Funcionário solicitante local não encontrado.',
                            supabaseMapNotFoundMessage: 'Funcionário solicitante não encontrado no Supabase.',
                        }
                    );
                    actorFuncionarioId = String(actorSupabaseContext?.funcionarioId || '').trim();
                } catch (actorResolveError) {
                    console.warn(
                        '[Pedidos] Aviso: não foi possível mapear o solicitante para UUID de funcionário:',
                        actorResolveError?.message || actorResolveError
                    );
                }
            }

            let responsibleUserId = String(responsibleUserIdRaw || '').trim();
            if (!isUuid(responsibleUserIdRaw)) {
                try {
                    const responsibleSupabaseContext = await resolveSupabaseFuncionarioContext(
                        responsibleUserIdRaw,
                        '',
                        {
                            missingUserMessage: 'Funcionário responsável é obrigatório.',
                            localUserNotFoundMessage: `ID de funcionário inválido ou não encontrado: ${responsibleUserIdRaw}`,
                            supabaseMapNotFoundMessage:
                                'Funcionário responsável não encontrado no Supabase. Verifique a correspondência de email/ID.',
                        }
                    );
                    responsibleUserId = String(responsibleSupabaseContext?.funcionarioId || '').trim();
                } catch (resolveError) {
                    const statusCode = Number(resolveError?.statusCode || 400) || 400;
                    return res.status(statusCode).json({
                        success: false,
                        error: resolveError?.message || 'Falha ao mapear o funcionário responsável.',
                        details: resolveError?.details || null,
                    });
                }
            }

            const managerEmail = String(process.env.SUPABASE_PEDIDOS_MANAGER_EMAIL || 'mpr@mpr.pt')
                .trim()
                .toLowerCase();

            const actorName = actorNameRaw || String(actorUserRow?.name || '').trim() || 'Funcionário';
            let managerLocalUser = null;
            if (managerEmail) {
                managerLocalUser = await dbGetAsync(
                    'SELECT id, name, email FROM users WHERE lower(email) = lower(?) LIMIT 1',
                    [managerEmail]
                );
            }
            if (!managerLocalUser) {
                managerLocalUser = await dbGetAsync(
                    "SELECT id, name, email FROM users WHERE role = 'ADMIN' ORDER BY datetime(updated_at) DESC LIMIT 1"
                );
            }
            const managerLocalUserId = String(managerLocalUser?.id || '').trim();

            const pedidosTableRequested = String(
                process.env.SUPABASE_PEDIDOS_SOURCE || 'pedidos'
            ).trim();
            const pedidosTable = typeof resolveSupabaseTableName === 'function'
                ? await resolveSupabaseTableName(pedidosTableRequested, ['public.pedidos', 'pedidos'])
                : pedidosTableRequested;

            const tipoColumn = String(process.env.SUPABASE_PEDIDOS_TYPE_COLUMN || 'tipo').trim();
            const descricaoColumn = String(process.env.SUPABASE_PEDIDOS_DESCRIPTION_COLUMN || 'descricao').trim();
            const statusColumn = String(process.env.SUPABASE_PEDIDOS_STATUS_COLUMN || 'status').trim();
            const funcionarioColumn = String(process.env.SUPABASE_PEDIDOS_ASSIGNEE_COLUMN || 'funcionario_id').trim();
            const dataInicioColumn = String(process.env.SUPABASE_PEDIDOS_START_DATE_COLUMN || 'data_inicio').trim();
            const dataFimColumn = String(process.env.SUPABASE_PEDIDOS_END_DATE_COLUMN || 'data_fim').trim();
            const requesterColumn = String(process.env.SUPABASE_PEDIDOS_REQUESTER_COLUMN || '').trim();
            const requesterLegacyColumn = String(process.env.SUPABASE_PEDIDOS_ASSIGNEE_LEGACY_COLUMN || '').trim();
            const originColumn = String(process.env.SUPABASE_PEDIDOS_ORIGIN_COLUMN || '').trim();

            const todayIso = new Date().toISOString().slice(0, 10);
            const dataInicio = /^\d{4}-\d{2}-\d{2}$/.test(dataInicioInput) ? dataInicioInput : todayIso;
            const dataFim = /^\d{4}-\d{2}-\d{2}$/.test(dataFimInput) ? dataFimInput : dataInicio;
            const normalizedDescricao = String(descricao || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
            // Regista o pedido no funcionário solicitante (ex.: férias no próprio registo).
            const pedidoOwnerFuncionarioId = responsibleUserId;

            const duplicateLookupUrl =
                `${SUPABASE_URL}/rest/v1/${encodeURIComponent(pedidosTable)}` +
                `?select=id,${encodeURIComponent(descricaoColumn)},${encodeURIComponent(statusColumn)}` +
                `,${encodeURIComponent(tipoColumn)},${encodeURIComponent(dataInicioColumn)},${encodeURIComponent(dataFimColumn)},${encodeURIComponent(funcionarioColumn)}` +
                `&${encodeURIComponent(statusColumn)}=eq.PENDENTE` +
                `&${encodeURIComponent(tipoColumn)}=eq.${encodeURIComponent(tipo)}` +
                `&${encodeURIComponent(dataInicioColumn)}=eq.${encodeURIComponent(dataInicio)}` +
                `&${encodeURIComponent(dataFimColumn)}=eq.${encodeURIComponent(dataFim)}` +
                `&${encodeURIComponent(funcionarioColumn)}=eq.${encodeURIComponent(pedidoOwnerFuncionarioId)}` +
                `&limit=50`;

            const duplicateLookupResponse = await fetch(duplicateLookupUrl, {
                method: 'GET',
                headers: {
                    apikey: SUPABASE_KEY,
                    Authorization: `Bearer ${SUPABASE_KEY}`,
                },
            });
            const duplicateRows = await duplicateLookupResponse.json().catch(() => []);
            if (duplicateLookupResponse.ok && Array.isArray(duplicateRows)) {
                const duplicateRow = duplicateRows.find((row) => {
                    const rowDescricao = String(row?.[descricaoColumn] || '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .toLowerCase();
                    return rowDescricao === normalizedDescricao;
                });
                if (duplicateRow) {
                    const duplicateSupabasePedidoId = String(duplicateRow?.id || '').trim();
                    if (duplicateSupabasePedidoId && actorTrackingUserId) {
                        await upsertTrackedSupabasePedido({
                            supabasePedidoId: duplicateSupabasePedidoId,
                            supabaseTable: pedidosTable,
                            requesterUserId: actorTrackingUserId,
                            requesterName: actorName,
                            managerUserId: managerLocalUserId || null,
                            tipo,
                            descricao,
                            statusLast: String(duplicateRow?.[statusColumn] || 'PENDENTE').trim(),
                        });
                    }
                    return res.json({
                        success: true,
                        storage: 'supabase',
                        table: pedidosTable,
                        duplicate: true,
                        pedido: duplicateRow,
                        message: 'Pedido já existente (evitado duplicado).',
                    });
                }
            }

            const payload = {};
            if (tipoColumn) payload[tipoColumn] = tipo;
            if (descricaoColumn) payload[descricaoColumn] = descricao || null;
            if (statusColumn) payload[statusColumn] = status;
            if (funcionarioColumn) payload[funcionarioColumn] = pedidoOwnerFuncionarioId;
            if (dataInicioColumn) payload[dataInicioColumn] = dataInicio;
            if (dataFimColumn) payload[dataFimColumn] = dataFim;

            const optionalPayloadColumnsByLower = new Map();
            const addOptionalPayloadColumn = (columnName, value) => {
                const normalizedColumn = String(columnName || '').trim();
                if (!normalizedColumn || normalizedColumn === funcionarioColumn) return;
                payload[normalizedColumn] = value;
                optionalPayloadColumnsByLower.set(normalizedColumn.toLowerCase(), normalizedColumn);
            };

            const requesterIdForPayload = String(actorFuncionarioId || responsibleUserId || '').trim();
            const requesterColumns = Array.from(
                new Set([requesterColumn, requesterLegacyColumn].map((item) => String(item || '').trim()).filter(Boolean))
            );

            if (requesterIdForPayload && requesterColumns.length > 0) {
                for (const columnName of requesterColumns) {
                    addOptionalPayloadColumn(columnName, requesterIdForPayload);
                }
            }
            if (originColumn) addOptionalPayloadColumn(originColumn, 'wa_pro_internal_chat');

            const extractMissingColumnName = (errorText) => {
                const text = String(errorText || '');
                const patterns = [
                    /could not find the '([^']+)' column/i,
                    /column "([^"]+)"(?: of relation "[^"]+")? does not exist/i,
                    /unknown field ([a-zA-Z0-9_]+)/i,
                ];
                for (const pattern of patterns) {
                    const match = text.match(pattern);
                    if (match?.[1]) return String(match[1]).trim().toLowerCase();
                }
                return '';
            };

            const droppedOptionalColumns = [];
            const maxInsertAttempts = Math.max(1, optionalPayloadColumnsByLower.size + 1);
            let response = null;
            let responseJson = {};
            for (let attempt = 0; attempt < maxInsertAttempts; attempt += 1) {
                response = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(pedidosTable)}`, {
                    method: 'POST',
                    headers: {
                        apikey: SUPABASE_KEY,
                        Authorization: `Bearer ${SUPABASE_KEY}`,
                        'Content-Type': 'application/json',
                        Prefer: 'return=representation',
                    },
                    body: JSON.stringify(payload),
                });

                responseJson = await response.json().catch(() => ({}));
                if (response.ok) break;

                const errorText =
                    (typeof responseJson?.message === 'string' && responseJson.message) ||
                    (typeof responseJson?.error === 'string' && responseJson.error) ||
                    '';
                const missingColumnNameLower = extractMissingColumnName(errorText);
                const optionalColumnName = missingColumnNameLower
                    ? optionalPayloadColumnsByLower.get(missingColumnNameLower)
                    : '';
                if (optionalColumnName && Object.prototype.hasOwnProperty.call(payload, optionalColumnName)) {
                    delete payload[optionalColumnName];
                    optionalPayloadColumnsByLower.delete(missingColumnNameLower);
                    droppedOptionalColumns.push(optionalColumnName);
                    continue;
                }
                break;
            }

            if (!response || !response.ok) {
                const errorText =
                    (typeof responseJson?.message === 'string' && responseJson.message) ||
                    (typeof responseJson?.error === 'string' && responseJson.error) ||
                    `HTTP ${response?.status || 500}`;
                return res.status(Number(response?.status || 500) || 500).json({
                    success: false,
                    error: `Falha ao criar pedido no Supabase (${pedidosTable}): ${errorText}`,
                    details: responseJson,
                    droppedOptionalColumns,
                    requiredConfig: {
                        SUPABASE_PEDIDOS_SOURCE: pedidosTableRequested,
                        SUPABASE_PEDIDOS_TYPE_COLUMN: tipoColumn,
                        SUPABASE_PEDIDOS_DESCRIPTION_COLUMN: descricaoColumn,
                        SUPABASE_PEDIDOS_STATUS_COLUMN: statusColumn,
                        SUPABASE_PEDIDOS_ASSIGNEE_COLUMN: funcionarioColumn,
                        SUPABASE_PEDIDOS_START_DATE_COLUMN: dataInicioColumn,
                        SUPABASE_PEDIDOS_END_DATE_COLUMN: dataFimColumn,
                        SUPABASE_PEDIDOS_MANAGER_EMAIL: managerEmail,
                        SUPABASE_PEDIDOS_REQUESTER_COLUMN: requesterColumn || '(opcional)',
                        SUPABASE_PEDIDOS_ASSIGNEE_LEGACY_COLUMN: requesterLegacyColumn || '(opcional)',
                        SUPABASE_PEDIDOS_ORIGIN_COLUMN: originColumn || '(opcional)',
                    },
                });
            }

            const createdRow = Array.isArray(responseJson) ? responseJson[0] || null : responseJson || null;
            const createdSupabasePedidoId = String(createdRow?.id || '').trim();
            if (createdSupabasePedidoId && actorTrackingUserId) {
                await upsertTrackedSupabasePedido({
                    supabasePedidoId: createdSupabasePedidoId,
                    supabaseTable: pedidosTable,
                    requesterUserId: actorTrackingUserId,
                    requesterName: actorName,
                    managerUserId: managerLocalUserId || null,
                    tipo,
                    descricao,
                    statusLast: String(createdRow?.[statusColumn] || status || 'PENDENTE').trim(),
                });
            }

            // Notifica a gerência no canal "Notas e Avisos" quando outro funcionário cria pedido.
            try {
                const actorIdNormalized = String(actorTrackingUserId || '').trim();
                const managerIdNormalized = String(managerLocalUserId || '').trim();
                if (managerIdNormalized && actorIdNormalized && actorIdNormalized !== managerIdNormalized) {
                    const senderUserId = actorUserRow?.id ? actorIdNormalized : managerIdNormalized;
                    const conversationId = await ensureDirectConversationBetweenUsers({
                        userId: managerIdNormalized,
                        targetUserId: managerIdNormalized,
                        titleIfSelf: 'Notas e Avisos',
                    });
                    if (conversationId) {
                        const body = `O funcionário ${actorName} fez um novo pedido (${tipo}) de ${dataInicio}${dataFim !== dataInicio ? ` a ${dataFim}` : ''}.`;
                        await sendInternalSystemMessage({
                            conversationId,
                            senderUserId,
                            recipientUserId: managerIdNormalized,
                            body,
                        });
                        await dbRunAsync(
                            `UPDATE internal_conversation_members
                             SET last_read_at = CURRENT_TIMESTAMP
                             WHERE conversation_id = ? AND user_id = ?`,
                            [conversationId, senderUserId]
                        );
                    }
                }
            } catch (notifyError) {
                console.error('[Internal Chat] Aviso: falha ao enviar notificação de pedido no chat:', notifyError?.message || notifyError);
            }

            await writeAuditLog({
                actorUserId: actorTrackingUserId || null,
                entityType: 'pedido',
                entityId: createdRow?.id ? String(createdRow.id) : null,
                action: 'create_supabase',
                details: {
                    table: pedidosTable,
                    tipo,
                    responsibleUserId: pedidoOwnerFuncionarioId || null,
                    status,
                    dataInicio,
                    dataFim,
                    managerEmail: managerEmail || null,
                    requesterUserId: actorTrackingUserId || null,
                },
            });

            return res.json({
                success: true,
                storage: 'supabase',
                table: pedidosTable,
                pedido: createdRow,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Internal Chat] Erro ao criar pedido no Supabase:', details);
            return res.status(500).json({
                success: false,
                error: `Falha ao criar pedido no Supabase: ${details}`,
            });
        }
    });

    app.post('/api/internal-chat/pedidos/supabase/status-sync', async (req, res) => {
        try {
            const summary = await processSupabasePedidosStatusChanges({ forceRun: true });
            return res.json({ success: true, summary });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Pedidos Sync] Erro no sync manual de status:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    bootstrapSupabasePedidosStatusWatcher();

}

module.exports = { registerPedidosPontoRoutes };
