'use strict';

/**
 * Internal Chat user tasks, Ponto (time tracking) & Pedidos (requests) routes.
 * Extracted from localDataRoutes.js for maintainability.
 */
function registerPedidosPontoRoutes(context, helpers) {
    const {
        app, dbRunAsync, dbGetAsync, dbAllAsync, writeAuditLog,
        SUPABASE_URL, SUPABASE_KEY,
        SUPABASE_FUNCIONARIOS_SOURCE,
        fetchSupabaseTable, resolveSupabaseTableName, nowIso,
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

    async function resolveSupabasePontoContext(actorUserId) {
        const actorId = String(actorUserId || '').trim();
        if (!actorId) {
            throw new Error('actorUserId é obrigatório.');
        }

        const actorUser = await dbGetAsync(
            'SELECT id, source_id, name, email, password FROM users WHERE id = ? LIMIT 1',
            [actorId]
        );
        if (!actorUser) {
            const notFoundError = new Error('Funcionário local não encontrado.');
            notFoundError.statusCode = 404;
            throw notFoundError;
        }

        const funcionariosTableRequested = String(SUPABASE_FUNCIONARIOS_SOURCE || 'funcionarios').trim();
        const funcionariosTable =
            typeof resolveSupabaseTableName === 'function'
                ? await resolveSupabaseTableName(funcionariosTableRequested, ['public.funcionarios', 'funcionarios'])
                : funcionariosTableRequested;

        const registosPontoTableRequested = String(process.env.SUPABASE_REGISTOS_PONTO_SOURCE || 'registos_ponto').trim();
        const registosPontoTable =
            typeof resolveSupabaseTableName === 'function'
                ? await resolveSupabaseTableName(registosPontoTableRequested, ['public.registos_ponto', 'registos_ponto'])
                : registosPontoTableRequested;

        const funcionariosRowsRaw = await fetchSupabaseTable(funcionariosTable).catch((err) => {
            throw new Error(`Falha ao ler funcionários no Supabase: ${err?.message || err}`);
        });
        const funcionariosRows = Array.isArray(funcionariosRowsRaw) ? funcionariosRowsRaw : [];

        const actorEmail = String(actorUser?.email || '').trim().toLowerCase();
        const actorSourceId = String(parseSourceId(actorId, actorUser?.source_id) || '').trim();
        const sourceCandidates = Array.from(
            new Set([actorSourceId, String(actorUser?.source_id || '').trim(), actorId].filter(Boolean))
        );

        const byEmail = actorEmail
            ? funcionariosRows.find((row) => String(row?.email || '').trim().toLowerCase() === actorEmail)
            : null;

        let funcionarioMatch = byEmail || null;
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

        const funcionarioId = String(funcionarioMatch?.id || '').trim();
        if (!funcionarioId) {
            const mapError = new Error(
                'Funcionário não mapeado no Supabase. Verifique o email/ligação do funcionário antes de registar ponto.'
            );
            mapError.statusCode = 404;
            mapError.details = {
                localUserId: actorId,
                localEmail: actorEmail || null,
                funcionariosTable,
            };
            throw mapError;
        }

        return {
            actorUser,
            actorEmail,
            actorSourceId,
            funcionarioRow: funcionarioMatch,
            funcionarioPin: pickSupabaseFuncionarioPin(funcionarioMatch),
            funcionarioId,
            funcionariosTable,
            registosPontoTable,
        };
    }

    app.post('/api/internal-chat/ponto/supabase', async (req, res) => {
        try {
            if (!SUPABASE_URL || !SUPABASE_KEY) {
                return res.status(400).json({
                    success: false,
                    error: 'Supabase não configurado (SUPABASE_URL/SUPABASE_KEY).',
                });
            }
            if (typeof fetchSupabaseTable !== 'function') {
                return res.status(400).json({
                    success: false,
                    error: 'Sync Supabase indisponível no servidor (fetchSupabaseTable).',
                });
            }

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
            if (!SUPABASE_URL || !SUPABASE_KEY) {
                return res.status(400).json({
                    success: false,
                    error: 'Supabase não configurado (SUPABASE_URL/SUPABASE_KEY).',
                });
            }
            if (typeof fetchSupabaseTable !== 'function') {
                return res.status(400).json({
                    success: false,
                    error: 'Sync Supabase indisponível no servidor (fetchSupabaseTable).',
                });
            }

            const actorUserId = String(req.query.actorUserId || req.query.userId || '').trim();
            const limit = Math.min(10, Math.max(1, Number(req.query.limit || 2) || 2));
            if (!actorUserId) {
                return res.status(400).json({ success: false, error: 'actorUserId é obrigatório.' });
            }

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
            if (!SUPABASE_URL || !SUPABASE_KEY) {
                return res.status(400).json({
                    success: false,
                    error: 'Supabase não configurado (SUPABASE_URL/SUPABASE_KEY).',
                });
            }

            const actorUserId = String(req.body?.actorUserId || '').trim();
            const actorNameRaw = String(req.body?.actorName || '').trim();
            const responsibleUserId = String(
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
            if (!responsibleUserId) {
                return res.status(400).json({ success: false, error: 'Funcionário responsável é obrigatório.' });
            }

            const managerEmail = String(process.env.SUPABASE_PEDIDOS_MANAGER_EMAIL || 'mpr@mpr.pt')
                .trim()
                .toLowerCase();
            const managerFuncionarioIdEnv = String(process.env.SUPABASE_PEDIDOS_MANAGER_ID || '').trim();

            const actorUserRow = actorUserId
                ? await dbGetAsync('SELECT id, name, email FROM users WHERE id = ? LIMIT 1', [actorUserId])
                : null;
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
            const originColumn = String(process.env.SUPABASE_PEDIDOS_ORIGIN_COLUMN || '').trim();
            const funcionariosTableRequested = String(SUPABASE_FUNCIONARIOS_SOURCE || 'funcionarios').trim();
            const funcionariosTable = typeof resolveSupabaseTableName === 'function'
                ? await resolveSupabaseTableName(funcionariosTableRequested, ['public.funcionarios', 'funcionarios'])
                : funcionariosTableRequested;

            const todayIso = new Date().toISOString().slice(0, 10);
            const dataInicio = /^\d{4}-\d{2}-\d{2}$/.test(dataInicioInput) ? dataInicioInput : todayIso;
            const dataFim = /^\d{4}-\d{2}-\d{2}$/.test(dataFimInput) ? dataFimInput : dataInicio;
            const normalizedDescricao = String(descricao || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();

            let managerFuncionarioId = managerFuncionarioIdEnv;
            if (managerEmail) {
                const managerLookupResponse = await fetch(
                    `${SUPABASE_URL}/rest/v1/${encodeURIComponent(funcionariosTable)}?select=id,email&email=ilike.${encodeURIComponent(managerEmail)}&limit=1`,
                    {
                        method: 'GET',
                        headers: {
                            apikey: SUPABASE_KEY,
                            Authorization: `Bearer ${SUPABASE_KEY}`,
                        },
                    }
                );
                const managerLookupJson = await managerLookupResponse.json().catch(() => []);
                if (managerLookupResponse.ok && Array.isArray(managerLookupJson) && managerLookupJson[0]?.id) {
                    managerFuncionarioId = String(managerLookupJson[0].id || '').trim();
                }
            }
            const pedidoOwnerFuncionarioId = managerFuncionarioId || responsibleUserId;

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
                    if (duplicateSupabasePedidoId && actorUserId) {
                        await upsertTrackedSupabasePedido({
                            supabasePedidoId: duplicateSupabasePedidoId,
                            supabaseTable: pedidosTable,
                            requesterUserId: actorUserId,
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
            if (requesterColumn && actorUserId) payload[requesterColumn] = actorUserId;
            if (originColumn) payload[originColumn] = 'wa_pro_internal_chat';

            const response = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(pedidosTable)}`, {
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
            if (!response.ok) {
                const errorText =
                    (typeof responseJson?.message === 'string' && responseJson.message) ||
                    (typeof responseJson?.error === 'string' && responseJson.error) ||
                    `HTTP ${response.status}`;
                return res.status(response.status).json({
                    success: false,
                    error: `Falha ao criar pedido no Supabase (${pedidosTable}): ${errorText}`,
                    details: responseJson,
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
                        SUPABASE_PEDIDOS_ORIGIN_COLUMN: originColumn || '(opcional)',
                    },
                });
            }

            const createdRow = Array.isArray(responseJson) ? responseJson[0] || null : responseJson || null;
            const createdSupabasePedidoId = String(createdRow?.id || '').trim();
            if (createdSupabasePedidoId && actorUserId) {
                await upsertTrackedSupabasePedido({
                    supabasePedidoId: createdSupabasePedidoId,
                    supabaseTable: pedidosTable,
                    requesterUserId: actorUserId,
                    requesterName: actorName,
                    managerUserId: managerLocalUserId || null,
                    tipo,
                    descricao,
                    statusLast: String(createdRow?.[statusColumn] || status || 'PENDENTE').trim(),
                });
            }

            // Notifica a gerência no canal "Notas e Avisos" quando outro funcionário cria pedido.
            try {
                const actorIdNormalized = String(actorUserId || '').trim();
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
                actorUserId: actorUserId || null,
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
                    requesterUserId: actorUserId || null,
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
