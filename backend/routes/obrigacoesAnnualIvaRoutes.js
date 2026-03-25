/**
 * Obrigações Annual & IVA Routes — extracted from importObrigacoesRoutes.js
 * Routes: M22, IES, M10, Inventário, Relatório Único, IVA robot, IVA jobs
 */
function registerObrigacoesAnnualIvaRoutes(context) {
    const {
        app, axios,
        M22_OBRIGACAO_ID, IES_OBRIGACAO_ID, M10_OBRIGACAO_ID,
        INVENTARIO_OBRIGACAO_ID, RELATORIO_UNICO_OBRIGACAO_ID,
        IVA_OBRIGACAO_ID_MENSAL, IVA_OBRIGACAO_ID_TRIMESTRAL,
        SUPABASE_URL, SUPABASE_KEY, SUPABASE_OBRIGACOES_MODELO,
        SUPABASE_CLIENTS_SOURCE, PORT,
        normalizeBoolean, normalizeIntValue, resolveMonthYear, nowIso,
        fetchSupabaseTable, resolveObrigacaoModeloRow, pickFirstValue,
        normalizeIvaPeriodicidade, resolveObrigacaoPeriod,
        loadSupabaseCustomerLookup, findCustomerRowForObrigacao,
        resolveSupabaseCustomerIdFromLocalRow, loadLocalCollectedSets,
        loadSupabaseCollectedSourceIds, upsertLocalObrigacaoRecolha,
        syncRecolhaEstadoSupabase, updateObrigacaoPeriodoSupabase,
        markLocalObrigacaoRecolhaSynced, writeAuditLog,
        classifyM22ProcessadoStatus, classifyRelatorioUnicoStatus,
        classifyIvaProcessadoStatus,
        normalizeDigits, parseDatePtToIso, parseIvaPeriodFromValue,
        normalizeLookupText,
        createIvaJobId, setIvaImportJob, ivaImportJobs,
        materializeLocalCustomerFromSupabase,
        runSaftObrigacoesRobotM22, runSaftObrigacoesRobotIes,
        runSaftObrigacoesRobotM10, runSaftObrigacoesRobotRelatorioUnico,
        runSaftObrigacoesRobotIva,
        runGoffObrigacoesRobotM22, runGoffObrigacoesRobotIes,
        runGoffObrigacoesRobotM10, runGoffObrigacoesRobotInventario,
        runGoffObrigacoesRobotRelatorioUnico,
    } = context;

    app.post('/api/import/obrigacoes/m22', async (req, res) => {
        const body = req.body || {};
        const dryRun = normalizeBoolean(body.dryRun, false);
        const force = normalizeBoolean(body.force, false);
        const targetYear =
            body.year !== undefined
                ? normalizeIntValue(body.year, new Date().getUTCFullYear() - 1)
                : new Date().getUTCFullYear() - 1;
    
        const warnings = [];
        const startedAt = nowIso();
        let robotPayload;
    
        try {
            robotPayload = await runSaftObrigacoesRobotM22({ year: targetYear });
        } catch (error) {
            const details = error?.message || error;
            return res.status(500).json({
                success: false,
                error: `Falha no robô M22: ${details}`,
                period: { tipo: 'anual', ano: targetYear, mes: null, trimestre: null },
            });
        }
    
        const rows = Array.isArray(robotPayload?.rows) ? robotPayload.rows : [];
        let modeloRow = null;
        let obrigacaoId = M22_OBRIGACAO_ID;
        let obrigacaoNome = 'Modelo 22';
        let periodicidade = 'anual';
    
        if (SUPABASE_URL && SUPABASE_KEY) {
            try {
                const modeloRows = await fetchSupabaseTable(SUPABASE_OBRIGACOES_MODELO);
                modeloRow = resolveObrigacaoModeloRow(modeloRows, M22_OBRIGACAO_ID, [
                    'modelo 22',
                    'mod. 22',
                    'mod 22',
                    'm22',
                ]);
                if (modeloRow) {
                    obrigacaoId = normalizeIntValue(
                        pickFirstValue(modeloRow, ['id', 'obrigacao_id', 'codigo', 'codigo_obrigacao', 'modelo_id']),
                        M22_OBRIGACAO_ID
                    );
                    obrigacaoNome =
                        String(
                            pickFirstValue(modeloRow, ['nome', 'designacao', 'descricao', 'obrigacao_nome', 'titulo']) ||
                                'Modelo 22'
                        ).trim() || 'Modelo 22';
                    periodicidade =
                        String(
                            pickFirstValue(modeloRow, [
                                'periodicidade',
                                'frequencia',
                                'tipo_periodicidade',
                                'periodo_tipo',
                                'periodo',
                            ]) || 'anual'
                        ).trim() || 'anual';
                } else {
                    warnings.push(
                        `Obrigação M22 (${M22_OBRIGACAO_ID}) não encontrada em ${SUPABASE_OBRIGACOES_MODELO}; a usar anual por defeito.`
                    );
                }
            } catch (error) {
                warnings.push(`Falha a carregar ${SUPABASE_OBRIGACOES_MODELO}. A usar configuração anual por defeito.`);
            }
        } else {
            warnings.push('Supabase não configurado. Será gravado apenas em SQL local.');
        }
    
        const periodo = {
            tipo: 'anual',
            ano: Number(targetYear),
            mes: null,
            trimestre: null,
        };
        const periodoAtualizacao = {
            tipo: 'anual',
            ano: Number(targetYear) + 1,
            mes: null,
            trimestre: null,
        };
        warnings.push(`M22 ${periodo.ano}: atualização de obrigações aplicada ao ano ${periodoAtualizacao.ano}.`);
        const result = {
            totalRows: rows.length,
            matchedCustomers: 0,
            missingCustomers: 0,
            syncedCustomersFromSupabase: 0,
            skippedAlreadyCollected: 0,
            skippedInvalidStatus: 0,
            localSaved: 0,
            recolhasSyncOk: 0,
            periodosUpdateOk: 0,
            syncErrors: 0,
        };
        const missing = [];
        const errors = [];
        let supabaseCustomerLookup = null;
        let localCollectedSets = { localCustomerIds: new Set(), sourceCustomerIds: new Set() };
        let supabaseCollectedSourceIds = new Set();
    
        if (SUPABASE_URL && SUPABASE_KEY) {
            try {
                supabaseCustomerLookup = await loadSupabaseCustomerLookup();
            } catch (error) {
                warnings.push(`Falha ao carregar lookup de clientes (${SUPABASE_CLIENTS_SOURCE}) para match por NIF.`);
                console.error('[M22] Erro lookup clientes Supabase:', error?.message || error);
            }
        }
    
            try {
                localCollectedSets = await loadLocalCollectedSets({
                    obrigacaoId,
                    periodo,
                    statusClassifier: (estado, estadoAt) => classifyM22ProcessadoStatus(estado, estadoAt),
            });
        } catch (error) {
            warnings.push('Falha ao carregar recolhas locais já processadas para este período.');
        }
    
        if (!dryRun && SUPABASE_URL && SUPABASE_KEY) {
            try {
                const loaded = await loadSupabaseCollectedSourceIds({
                    obrigacaoId,
                    periodo: periodoAtualizacao,
                });
                supabaseCollectedSourceIds = loaded.sourceIds;
            } catch (error) {
                warnings.push('Falha ao carregar estados já recolhidos no Supabase para este período.');
            }
        }
    
        for (const row of rows) {
            const rowEmpresa = String(pickFirstValue(row, ['empresa', 'company', 'nome', 'name']) || '').trim();
            const rowNif = normalizeDigits(pickFirstValue(row, ['nif', 'NIF', 'vat']) || '');
            const rowEstado = String(pickFirstValue(row, ['estado', 'status']) || '').trim();
            const rowEstadoAt = String(pickFirstValue(row, ['estadoAt', 'estado_at', 'estadoAT', 'estado at']) || '').trim();
            const rowIdentificacao = String(
                pickFirstValue(row, ['codigo', 'idFicheiro', 'id_ficheiro', 'identificacao', 'identificação', 'id']) || ''
            ).trim();
            const rowDataRecebidoRaw = String(
                pickFirstValue(row, [
                    'dataRecebido',
                    'data_recebido',
                    'dataRecolha',
                    'data_recolha',
                    'dataEntrega',
                    'data_entrega',
                    'data',
                    'dataStatus',
                    'data_status',
                ]) || ''
            ).trim();
            const rowDataComprovativoRaw = String(
                pickFirstValue(row, ['dataComprovativo', 'data_comprovativo', 'data comprovativo']) || ''
            ).trim();
    
            let customerMatch;
            try {
                customerMatch = await findCustomerRowForObrigacao(rowNif, rowEmpresa, supabaseCustomerLookup);
            } catch (error) {
                result.syncErrors += 1;
                if (errors.length < 50) {
                    errors.push({
                        nif: rowNif || null,
                        step: 'customer_match',
                        error: String(error?.message || error),
                    });
                }
                continue;
            }
    
            const customerRow = customerMatch?.customerRow || null;
            if (!customerRow) {
                result.missingCustomers += 1;
                if (missing.length < 50) {
                    missing.push({ empresa: rowEmpresa || null, nif: rowNif || null });
                }
                continue;
            }
    
            result.matchedCustomers += 1;
            if (customerMatch?.syncedFromSupabase) {
                result.syncedCustomersFromSupabase += 1;
            }
            const customerId = String(customerRow.id || '').trim();
            const customerSourceId = resolveSupabaseCustomerIdFromLocalRow(customerRow);
    
            const alreadyLocal =
                localCollectedSets.localCustomerIds.has(customerId) ||
                (customerSourceId && localCollectedSets.sourceCustomerIds.has(customerSourceId));
            const alreadySupabase = customerSourceId && supabaseCollectedSourceIds.has(customerSourceId);
            const shouldSkip = !force && (Boolean(alreadySupabase) || (!customerSourceId && alreadyLocal));
            if (shouldSkip) {
                result.skippedAlreadyCollected += 1;
                continue;
            }
    
            const normalizedRowData = {
                empresa: rowEmpresa || String(customerRow.company || customerRow.name || '').trim(),
                nif: rowNif || normalizeDigits(customerRow.nif || ''),
                estado: rowEstado || null,
                estadoAt: rowEstadoAt || null,
                identificacao: rowIdentificacao || null,
                dataRecebidoRaw: rowDataRecebidoRaw || null,
                dataRecebidoIso: parseDatePtToIso(rowDataRecebidoRaw),
                dataComprovativoRaw: rowDataComprovativoRaw || null,
                dataComprovativoIso: parseDatePtToIso(rowDataComprovativoRaw),
                raw: row,
            };
    
            try {
                await upsertLocalObrigacaoRecolha({
                    customerId,
                    customerSourceId,
                    obrigacaoId,
                    obrigacaoCodigo: String(obrigacaoId),
                    obrigacaoNome,
                    periodoTipo: periodo.tipo,
                    periodoAno: periodo.ano,
                    periodoMes: periodo.mes,
                    periodoTrimestre: periodo.trimestre,
                    estadoCodigo: normalizedRowData.estado,
                    identificacao: normalizedRowData.identificacao,
                    dataRecebido: normalizedRowData.dataRecebidoIso || normalizedRowData.dataRecebidoRaw,
                    dataComprovativo: normalizedRowData.dataComprovativoIso || normalizedRowData.dataComprovativoRaw,
                    empresa: normalizedRowData.empresa,
                    nif: normalizedRowData.nif,
                    payload: normalizedRowData.raw,
                    origem: 'saft_m22_robot',
                    syncedSupabaseAt: null,
                });
                result.localSaved += 1;
                localCollectedSets.localCustomerIds.add(customerId);
                if (customerSourceId) localCollectedSets.sourceCustomerIds.add(customerSourceId);
            } catch (error) {
                result.syncErrors += 1;
                if (errors.length < 50) {
                    errors.push({
                        customerId,
                        nif: normalizedRowData.nif,
                        step: 'local_upsert',
                        error: String(error?.message || error),
                    });
                }
                continue;
            }
    
            const statusCheck = classifyM22ProcessadoStatus(normalizedRowData.estado, normalizedRowData.estadoAt);
            if (!statusCheck.isSuccess) {
                result.skippedInvalidStatus += 1;
                if (warnings.length < 50) {
                    warnings.push(
                        `M22 ignorado (${normalizedRowData.nif || 'sem NIF'}): estado "${normalizedRowData.estado || '-'}"${
                            normalizedRowData.estadoAt ? ` / AT "${normalizedRowData.estadoAt}"` : ''
                        } (necessário: Processado).`
                    );
                }
                continue;
            }
    
            if (dryRun || !(SUPABASE_URL && SUPABASE_KEY)) {
                continue;
            }
            if (!customerSourceId) {
                result.syncErrors += 1;
                if (errors.length < 50) {
                    errors.push({
                        customerId,
                        nif: normalizedRowData.nif,
                        step: 'customer_source_id',
                        error: 'Cliente sem source_id para sincronizar no Supabase.',
                    });
                }
                continue;
            }
    
            try {
                await syncRecolhaEstadoSupabase({
                    customerSourceId,
                    obrigacaoId,
                    obrigacaoNome,
                    periodo: periodoAtualizacao,
                    rowData: normalizedRowData,
                });
                result.recolhasSyncOk += 1;
            } catch (error) {
                result.syncErrors += 1;
                if (errors.length < 50) {
                    errors.push({
                        customerId,
                        customerSourceId,
                        nif: normalizedRowData.nif,
                        step: 'recolhas_estados',
                        error: String(error?.message || error),
                    });
                }
            }
    
            try {
                const updateInfo = await updateObrigacaoPeriodoSupabase({
                    customerSourceId,
                    obrigacaoId,
                    periodo: periodoAtualizacao,
                    estadoFinal: 4,
                });
                if (Number(updateInfo.updatedRows || 0) > 0) {
                    result.periodosUpdateOk += 1;
                    await markLocalObrigacaoRecolhaSynced({
                        customerId,
                        obrigacaoId,
                        periodo,
                    });
                } else {
                    warnings.push(
                        `Sem linhas atualizadas em ${updateInfo.table} para cliente ${customerSourceId} (obrigação ${obrigacaoId}).`
                    );
                }
            } catch (error) {
                result.syncErrors += 1;
                if (errors.length < 50) {
                    errors.push({
                        customerId,
                        customerSourceId,
                        nif: normalizedRowData.nif,
                        step: 'clientes_obrigacoes_periodos',
                        error: String(error?.message || error),
                    });
                }
            }
        }
    
        await writeAuditLog({
            actorUserId: String(body.requestedBy || '').trim() || null,
            entityType: 'obrigacao_m22_recolha',
            entityId: String(periodo.ano),
            action: 'sync',
            details: {
                dryRun,
                force,
                period: periodo,
                updatePeriod: periodoAtualizacao,
                obrigacaoId,
                obrigacaoNome,
                startedAt,
                endedAt: nowIso(),
                result,
                warnings,
                errors: errors.slice(0, 20),
            },
        });
    
        return res.json({
            success: true,
            dryRun,
            force,
            period: periodo,
            updatePeriod: periodoAtualizacao,
            obrigacao: {
                id: obrigacaoId,
                nome: obrigacaoNome,
                periodicidade,
            },
            startedAt,
            finishedAt: nowIso(),
            result,
            warnings,
            missingCustomers: missing.slice(0, 50),
            errors,
        });
    });
    
    app.post('/api/import/obrigacoes/ies', async (req, res) => {
        return handleAnnualSaftObrigacaoImport(req, res, {
            routeTag: 'IES',
            runRobot: runSaftObrigacoesRobotIes,
            defaultObrigacaoId: IES_OBRIGACAO_ID,
            defaultObrigacaoNome: 'IES',
            labelHints: ['ies'],
            origem: 'saft_ies_robot',
            auditEntityType: 'obrigacao_ies_recolha',
            successLabel: 'Processado',
            statusClassifier: (estado, estadoAt) => classifyM22ProcessadoStatus(estado, estadoAt),
        });
    });

    app.post('/api/import/obrigacoes/goff/m22', async (req, res) => {
        return handleAnnualSaftObrigacaoImport(req, res, {
            routeTag: 'GOFF M22',
            runRobot: runGoffObrigacoesRobotM22,
            defaultObrigacaoId: M22_OBRIGACAO_ID,
            defaultObrigacaoNome: 'Modelo 22',
            labelHints: ['modelo 22', 'mod. 22', 'mod 22', 'm22'],
            origem: 'goff_m22_robot',
            auditEntityType: 'obrigacao_goff_m22_recolha',
            successLabel: 'Processado',
            statusClassifier: (estado, estadoAt) => classifyM22ProcessadoStatus(estado, estadoAt),
        });
    });

    app.post('/api/import/obrigacoes/goff/ies', async (req, res) => {
        return handleAnnualSaftObrigacaoImport(req, res, {
            routeTag: 'GOFF IES',
            runRobot: runGoffObrigacoesRobotIes,
            defaultObrigacaoId: IES_OBRIGACAO_ID,
            defaultObrigacaoNome: 'IES',
            labelHints: ['ies'],
            origem: 'goff_ies_robot',
            auditEntityType: 'obrigacao_goff_ies_recolha',
            successLabel: 'Processado',
            statusClassifier: (estado, estadoAt) => classifyM22ProcessadoStatus(estado, estadoAt),
        });
    });
    
    app.post('/api/import/obrigacoes/m10', async (req, res) => {
        return handleAnnualSaftObrigacaoImport(req, res, {
            routeTag: 'M10',
            runRobot: runSaftObrigacoesRobotM10,
            defaultObrigacaoId: M10_OBRIGACAO_ID,
            defaultObrigacaoNome: 'Modelo 10',
            labelHints: ['modelo 10', 'mod. 10', 'mod 10', 'm10'],
            origem: 'saft_m10_robot',
            auditEntityType: 'obrigacao_m10_recolha',
            successLabel: 'Processado',
            statusClassifier: (estado, estadoAt) => classifyM22ProcessadoStatus(estado, estadoAt),
        });
    });

    app.post('/api/import/obrigacoes/goff/m10', async (req, res) => {
        return handleAnnualSaftObrigacaoImport(req, res, {
            routeTag: 'GOFF M10',
            runRobot: runGoffObrigacoesRobotM10,
            defaultObrigacaoId: M10_OBRIGACAO_ID,
            defaultObrigacaoNome: 'Modelo 10',
            labelHints: ['modelo 10', 'mod. 10', 'mod 10', 'm10'],
            origem: 'goff_m10_robot',
            auditEntityType: 'obrigacao_goff_m10_recolha',
            successLabel: 'Processado',
            statusClassifier: (estado, estadoAt) => classifyM22ProcessadoStatus(estado, estadoAt),
        });
    });

    app.post('/api/import/obrigacoes/goff/inventario', async (req, res) => {
        return handleAnnualSaftObrigacaoImport(req, res, {
            routeTag: 'GOFF Inventário',
            runRobot: runGoffObrigacoesRobotInventario,
            defaultObrigacaoId: INVENTARIO_OBRIGACAO_ID,
            defaultObrigacaoNome: 'Inventário',
            labelHints: ['inventário', 'inventario', 'inv'],
            origem: 'goff_inventario_robot',
            auditEntityType: 'obrigacao_goff_inventario_recolha',
            successLabel: 'Ficheiro entregue ou Processado',
            statusClassifier: (estado, estadoAt, payload) => {
                const byEstado = classifyM22ProcessadoStatus(estado, estadoAt);
                if (byEstado.isSuccess) return byEstado;

                const dataEntrega = String(
                    payload?.dataEntrega || payload?.data_entrega || payload?.dataRecebido || payload?.data_recolha || ''
                ).trim();
                const nomeFicheiro = String(
                    payload?.nomeFicheiro || payload?.nome_ficheiro || payload?.ficheiro || payload?.fileName || ''
                ).trim();
                const hasDelivery = Boolean(parseDatePtToIso(dataEntrega) || dataEntrega);
                const hasFile = Boolean(nomeFicheiro);

                if (hasDelivery || hasFile) {
                    return { isSuccess: true, reason: 'inventory_delivered', normalized: `${dataEntrega} | ${nomeFicheiro}`.trim() };
                }

                return byEstado;
            },
        });
    });
    
    app.post('/api/import/obrigacoes/relatorio-unico', async (req, res) => {
        return handleAnnualSaftObrigacaoImport(req, res, {
            routeTag: 'Relatório Único',
            runRobot: runSaftObrigacoesRobotRelatorioUnico,
            defaultObrigacaoId: RELATORIO_UNICO_OBRIGACAO_ID,
            defaultObrigacaoNome: 'Relatório Único',
            labelHints: ['relatório único', 'relatorio unico', 'ru'],
            origem: 'saft_relatorio_unico_robot',
            auditEntityType: 'obrigacao_relatorio_unico_recolha',
            successLabel: 'Processado ou documento recolhido',
            statusClassifier: (estado, estadoAt, payload) => classifyRelatorioUnicoStatus(estado, estadoAt, payload),
        });
    });

    app.post('/api/import/obrigacoes/goff/relatorio-unico', async (req, res) => {
        return handleAnnualSaftObrigacaoImport(req, res, {
            routeTag: 'GOFF Relatório Único',
            runRobot: runGoffObrigacoesRobotRelatorioUnico,
            defaultObrigacaoId: RELATORIO_UNICO_OBRIGACAO_ID,
            defaultObrigacaoNome: 'Relatório Único',
            labelHints: ['relatório único', 'relatorio unico', 'ru'],
            origem: 'goff_relatorio_unico_robot',
            auditEntityType: 'obrigacao_goff_relatorio_unico_recolha',
            successLabel: 'Processado ou documento recolhido',
            statusClassifier: (estado, estadoAt, payload) => classifyRelatorioUnicoStatus(estado, estadoAt, payload),
        });
    });
    
    app.post('/api/import/obrigacoes/iva', async (req, res) => {
        const body = req.body || {};
        const asyncMode = normalizeBoolean(body.async, false);
        const dryRun = normalizeBoolean(body.dryRun, false);
        const force = normalizeBoolean(body.force, false);
        const includeQuarterly = normalizeBoolean(body.includeQuarterly, true);
        if (asyncMode) {
            const jobId = createIvaJobId();
            const createdAt = nowIso();
            ivaImportJobs.set(jobId, {
                id: jobId,
                status: 'queued',
                createdAt,
                updatedAt: createdAt,
                request: {
                    year: body.year,
                    month: body.month,
                    dryRun,
                    force,
                    includeQuarterly,
                },
            });
    
            setImmediate(async () => {
                setIvaImportJob(jobId, { status: 'running', startedAt: nowIso() });
                try {
                    const internalResponse = await axios.post(
                        `http://127.0.0.1:${PORT}/api/import/obrigacoes/iva`,
                        { ...body, async: false },
                        {
                            headers: { 'Content-Type': 'application/json' },
                            timeout: 0,
                            validateStatus: () => true,
                        }
                    );
    
                    if (internalResponse.status >= 200 && internalResponse.status < 300) {
                        setIvaImportJob(jobId, {
                            status: 'completed',
                            finishedAt: nowIso(),
                            result: internalResponse.data,
                        });
                    } else {
                        setIvaImportJob(jobId, {
                            status: 'failed',
                            finishedAt: nowIso(),
                            error:
                                internalResponse?.data?.error ||
                                `Falha na recolha IVA (${internalResponse.status}).`,
                            result: internalResponse.data,
                        });
                    }
                } catch (error) {
                    setIvaImportJob(jobId, {
                        status: 'failed',
                        finishedAt: nowIso(),
                        error: String(error?.response?.data?.error || error?.message || error),
                    });
                }
            });
    
            return res.status(202).json({
                success: true,
                async: true,
                jobId,
                status: 'queued',
                createdAt,
            });
        }
    
        const monthOffset = Number.isFinite(Number(body.monthOffset))
            ? Number(body.monthOffset)
            : (normalizeBoolean(body.usePreviousMonth, false) ? -1 : 0);
    
        let targetPeriod;
        if (body.year !== undefined && body.month !== undefined) {
            targetPeriod = {
                year: normalizeIntValue(body.year, new Date().getUTCFullYear()),
                month: normalizeIntValue(body.month, new Date().getUTCMonth() + 1),
            };
        } else {
            targetPeriod = resolveMonthYear(new Date(), monthOffset);
        }
        const isQuarterFilter = targetPeriod.month >= 101 && targetPeriod.month <= 104;
        if (targetPeriod.month < 0 || targetPeriod.month > 104 || (targetPeriod.month > 12 && !isQuarterFilter)) {
            return res.status(400).json({
                success: false,
                error: 'Filtro inválido. Use 0 (Todos), 1..12 (mês) ou 101..104 (1º..4º trimestre).',
            });
        }
    
        const warnings = [];
        const startedAt = nowIso();
        let robotPayload;
    
        try {
            robotPayload = await runSaftObrigacoesRobotIva({
                year: targetPeriod.year,
                month: targetPeriod.month,
            });
        } catch (error) {
            const details = error?.message || error;
            return res.status(500).json({
                success: false,
                error: `Falha no robô IVA: ${details}`,
                period: targetPeriod,
            });
        }
    
        let rows = Array.isArray(robotPayload?.rows) ? [...robotPayload.rows] : [];
        if (includeQuarterly && targetPeriod.month >= 1 && targetPeriod.month <= 12 && targetPeriod.month % 3 === 0) {
            let hasQuarterlyForTargetMonth = false;
            for (const row of rows) {
                const rowPeriodoRaw = String(pickFirstValue(row, ['periodo', 'período', 'mes']) || '').trim();
                const rowPeriodo = parseIvaPeriodFromValue(rowPeriodoRaw, targetPeriod.year);
                if (!rowPeriodo) continue;
                if (rowPeriodo.tipo === 'trimestral' && Number(rowPeriodo.ano) === Number(targetPeriod.year) && Number(rowPeriodo.mes || 0) === Number(targetPeriod.month)) {
                    hasQuarterlyForTargetMonth = true;
                    break;
                }
            }
    
            if (!hasQuarterlyForTargetMonth) {
                try {
                    const quarterlyPayload = await runSaftObrigacoesRobotIva({
                        year: targetPeriod.year,
                        month: 0,
                    });
                    const quarterlyRows = Array.isArray(quarterlyPayload?.rows) ? quarterlyPayload.rows : [];
                    const supplemental = quarterlyRows.filter((row) => {
                        const rowPeriodoRaw = String(pickFirstValue(row, ['periodo', 'período', 'mes']) || '').trim();
                        const rowPeriodo = parseIvaPeriodFromValue(rowPeriodoRaw, targetPeriod.year);
                        if (!rowPeriodo) return false;
                        return (
                            rowPeriodo.tipo === 'trimestral' &&
                            Number(rowPeriodo.ano) === Number(targetPeriod.year) &&
                            Number(rowPeriodo.mes || 0) === Number(targetPeriod.month)
                        );
                    });
    
                    if (supplemental.length > 0) {
                        const seen = new Set(
                            rows.map((row) => {
                                const empresa = String(pickFirstValue(row, ['empresa', 'company', 'nome', 'name']) || '').trim();
                                const nif = normalizeDigits(pickFirstValue(row, ['nif', 'NIF', 'vat']) || '');
                                const periodoRaw = String(pickFirstValue(row, ['periodo', 'período', 'mes']) || '').trim().toUpperCase();
                                return `${nif}|${periodoRaw}|${empresa.toLowerCase()}`;
                            })
                        );
                        supplemental.forEach((row) => {
                            const empresa = String(pickFirstValue(row, ['empresa', 'company', 'nome', 'name']) || '').trim();
                            const nif = normalizeDigits(pickFirstValue(row, ['nif', 'NIF', 'vat']) || '');
                            const periodoRaw = String(pickFirstValue(row, ['periodo', 'período', 'mes']) || '').trim().toUpperCase();
                            const key = `${nif}|${periodoRaw}|${empresa.toLowerCase()}`;
                            if (seen.has(key)) return;
                            seen.add(key);
                            rows.push(row);
                        });
                        warnings.push(`IVA trimestral complementado com ${supplemental.length} registos do filtro "Todos".`);
                    }
                } catch (error) {
                    warnings.push(`Falha ao complementar IVA trimestral (Todos): ${String(error?.message || error)}`);
                }
            }
        }
        let modeloRow = null;
        let obrigacaoId = IVA_OBRIGACAO_ID_MENSAL;
        let obrigacaoNome = 'IVA';
        let periodicidade = 'mensal';
        const ivaObrigacoesByTipo = {
            mensal: {
                id: IVA_OBRIGACAO_ID_MENSAL,
                nome: 'Iva Mensal',
                periodicidade: 'MENSAL',
            },
            trimestral: {
                id: IVA_OBRIGACAO_ID_TRIMESTRAL,
                nome: 'Iva Trimestral',
                periodicidade: 'TRIMESTRAL',
            },
            anual: null,
        };
        const usedObrigacoes = new Map();
        const resolvePeriodicidadeTipo = (value) => {
            const token = normalizeLookupText(value);
            if (token.includes('trimes')) return 'trimestral';
            if (token.includes('anual')) return 'anual';
            return 'mensal';
        };
    
        if (SUPABASE_URL && SUPABASE_KEY) {
            try {
                const modeloRows = await fetchSupabaseTable(SUPABASE_OBRIGACOES_MODELO);
                const ivaRows = (Array.isArray(modeloRows) ? modeloRows : []).filter((row) => {
                    const label = String(
                        pickFirstValue(row, ['nome', 'designacao', 'descricao', 'obrigacao_nome', 'titulo']) || ''
                    )
                        .trim()
                        .toLowerCase();
                    return label.includes('iva');
                });
    
                for (const row of ivaRows) {
                    const rowId = normalizeIntValue(
                        pickFirstValue(row, ['id', 'obrigacao_id', 'codigo', 'codigo_obrigacao', 'modelo_id']),
                        0
                    );
                    if (!rowId) continue;
                    const rowNome =
                        String(
                            pickFirstValue(row, ['nome', 'designacao', 'descricao', 'obrigacao_nome', 'titulo']) || 'IVA'
                        ).trim() || 'IVA';
                    const rowPeriodicidade =
                        String(
                            pickFirstValue(row, [
                                'periodicidade',
                                'frequencia',
                                'tipo_periodicidade',
                                'periodo_tipo',
                                'periodo',
                            ]) || 'mensal'
                        ).trim() || 'mensal';
                    const rowTipo = resolvePeriodicidadeTipo(rowPeriodicidade);
                    if (!ivaObrigacoesByTipo[rowTipo]) {
                        ivaObrigacoesByTipo[rowTipo] = { id: rowId, nome: rowNome, periodicidade: rowPeriodicidade };
                    }
                }
    
                const modeloByLabel = ivaRows.length > 0 ? ivaRows[0] : null;
                const modeloById = resolveObrigacaoModeloRow(modeloRows, IVA_OBRIGACAO_ID_MENSAL, []);
                modeloRow = modeloById && ivaRows.includes(modeloById) ? modeloById : (modeloByLabel || modeloById);
                if (modeloRow) {
                    obrigacaoId = normalizeIntValue(
                        pickFirstValue(modeloRow, ['id', 'obrigacao_id', 'codigo', 'codigo_obrigacao', 'modelo_id']),
                        IVA_OBRIGACAO_ID_MENSAL
                    );
                    obrigacaoNome =
                        String(
                            pickFirstValue(modeloRow, ['nome', 'designacao', 'descricao', 'obrigacao_nome', 'titulo']) ||
                                'IVA'
                        ).trim() || 'IVA';
                    periodicidade =
                        String(
                            pickFirstValue(modeloRow, [
                                'periodicidade',
                                'frequencia',
                                'tipo_periodicidade',
                                'periodo_tipo',
                                'periodo',
                            ]) || 'mensal'
                        ).trim() || 'mensal';
                    const fallbackTipo = resolvePeriodicidadeTipo(periodicidade);
                    if (!ivaObrigacoesByTipo[fallbackTipo]) {
                        ivaObrigacoesByTipo[fallbackTipo] = {
                            id: obrigacaoId,
                            nome: obrigacaoNome,
                            periodicidade,
                        };
                    }
                    if (modeloByLabel && modeloById && modeloByLabel !== modeloById && warnings.length < 50) {
                        warnings.push(
                            `IVA encontrado por nome em ${SUPABASE_OBRIGACOES_MODELO}; IVA_OBRIGACAO_ID_MENSAL (${IVA_OBRIGACAO_ID_MENSAL}) aponta para outro registo.`
                        );
                    }
                } else {
                    warnings.push(
                        `Obrigação IVA mensal (${IVA_OBRIGACAO_ID_MENSAL}) não encontrada em ${SUPABASE_OBRIGACOES_MODELO}; a usar defaults mensal/trimestral.`
                    );
                }
            } catch (error) {
                warnings.push(`Falha a carregar ${SUPABASE_OBRIGACOES_MODELO}. A usar configuração mensal por defeito.`);
            }
        } else {
            warnings.push('Supabase não configurado. Será gravado apenas em SQL local.');
        }
    
        const result = {
            totalRows: rows.length,
            matchedCustomers: 0,
            missingCustomers: 0,
            syncedCustomersFromSupabase: 0,
            skippedAlreadyCollected: 0,
            skippedInvalidStatus: 0,
            skippedPeriodInvalid: 0,
            localSaved: 0,
            recolhasSyncOk: 0,
            periodosUpdateOk: 0,
            syncErrors: 0,
        };
        const missing = [];
        const errors = [];
        let supabaseCustomerLookup = null;
        const localSetsByPeriodKey = new Map();
        const supabaseSetsByPeriodKey = new Map();
    
        if (SUPABASE_URL && SUPABASE_KEY) {
            try {
                supabaseCustomerLookup = await loadSupabaseCustomerLookup();
            } catch (error) {
                warnings.push(`Falha ao carregar lookup de clientes (${SUPABASE_CLIENTS_SOURCE}) para match por NIF.`);
                console.error('[IVA] Erro lookup clientes Supabase:', error?.message || error);
            }
        }
    
        for (const row of rows) {
            const rowEmpresa = String(pickFirstValue(row, ['empresa', 'company', 'nome', 'name']) || '').trim();
            const rowNif = normalizeDigits(pickFirstValue(row, ['nif', 'NIF', 'vat']) || '');
            const rowEstado = String(pickFirstValue(row, ['estado', 'status']) || '').trim();
            const rowSituacao = String(pickFirstValue(row, ['situacao', 'situação']) || '').trim();
            const rowPeriodoRaw = String(pickFirstValue(row, ['periodo', 'período', 'mes']) || '').trim();
            const rowIdentificacao = String(
                pickFirstValue(row, ['idFicheiro', 'id_ficheiro', 'identificacao', 'identificação', 'id']) || ''
            ).trim();
            const rowDataRecebidoRaw = String(
                pickFirstValue(row, [
                    'dataRecebido',
                    'data_recebido',
                    'dataRecolha',
                    'data_recolha',
                    'data',
                    'dataStatus',
                    'data_status',
                ]) || ''
            ).trim();
            const rowDataComprovativoRaw = String(
                pickFirstValue(row, ['dataComprovativo', 'data_comprovativo', 'data comprovativo']) || ''
            ).trim();
    
            const rowPeriodo = parseIvaPeriodFromValue(rowPeriodoRaw, targetPeriod.year);
            if (!rowPeriodo || !rowPeriodo.ano || (rowPeriodo.tipo !== 'anual' && !rowPeriodo.mes)) {
                result.skippedPeriodInvalid += 1;
                if (warnings.length < 50) {
                    warnings.push(`IVA ignorado (${rowNif || 'sem NIF'}): período inválido "${rowPeriodoRaw || '-'}".`);
                }
                continue;
            }
    
            const periodo = {
                tipo: rowPeriodo.tipo || resolveObrigacaoPeriod(periodicidade, targetPeriod.year, targetPeriod.month || 1).tipo,
                ano: Number(rowPeriodo.ano),
                mes: rowPeriodo.tipo === 'mensal' ? Number(rowPeriodo.mes || 0) : 0,
                trimestre: rowPeriodo.tipo === 'trimestral' ? Number(rowPeriodo.trimestre || Math.ceil(Number(rowPeriodo.mes || 1) / 3)) : null,
            };
            const rowObrigacao =
                ivaObrigacoesByTipo[periodo.tipo] ||
                ivaObrigacoesByTipo.mensal ||
                ivaObrigacoesByTipo.trimestral ||
                ivaObrigacoesByTipo.anual || {
                    id: obrigacaoId,
                    nome: obrigacaoNome,
                    periodicidade,
                };
            const rowObrigacaoId = Number(rowObrigacao.id || obrigacaoId);
            const rowObrigacaoNome = String(rowObrigacao.nome || obrigacaoNome || 'IVA').trim() || 'IVA';
            usedObrigacoes.set(String(rowObrigacaoId), {
                id: rowObrigacaoId,
                nome: rowObrigacaoNome,
                periodicidade: String(rowObrigacao.periodicidade || periodicidade || '').trim() || null,
            });
            const periodKey = `${rowObrigacaoId}|${periodo.tipo}|${periodo.ano}|${periodo.mes || 0}|${periodo.trimestre || 0}`;
    
            let customerMatch;
            try {
                customerMatch = await findCustomerRowForObrigacao(rowNif, rowEmpresa, supabaseCustomerLookup);
            } catch (error) {
                result.syncErrors += 1;
                if (errors.length < 50) {
                    errors.push({
                        nif: rowNif || null,
                        step: 'customer_match',
                        error: String(error?.message || error),
                    });
                }
                continue;
            }
    
            const customerRow = customerMatch?.customerRow || null;
            if (!customerRow) {
                result.missingCustomers += 1;
                if (missing.length < 50) {
                    missing.push({ empresa: rowEmpresa || null, nif: rowNif || null });
                }
                continue;
            }
    
            result.matchedCustomers += 1;
            if (customerMatch?.syncedFromSupabase) {
                result.syncedCustomersFromSupabase += 1;
            }
            const customerId = String(customerRow.id || '').trim();
            const customerSourceId = resolveSupabaseCustomerIdFromLocalRow(customerRow);
    
            if (!localSetsByPeriodKey.has(periodKey)) {
                try {
                    const localSets = await loadLocalCollectedSets({
                        obrigacaoId: rowObrigacaoId,
                        periodo,
                        statusClassifier: (estado, _estadoAt, payload) =>
                            classifyIvaProcessadoStatus(estado, payload?.situacao),
                    });
                    localSetsByPeriodKey.set(periodKey, localSets);
                } catch (error) {
                    localSetsByPeriodKey.set(periodKey, { localCustomerIds: new Set(), sourceCustomerIds: new Set() });
                }
            }
            if (!dryRun && SUPABASE_URL && SUPABASE_KEY && !supabaseSetsByPeriodKey.has(periodKey)) {
                try {
                    const loaded = await loadSupabaseCollectedSourceIds({
                        obrigacaoId: rowObrigacaoId,
                        periodo,
                    });
                    supabaseSetsByPeriodKey.set(periodKey, loaded.sourceIds);
                } catch (error) {
                    supabaseSetsByPeriodKey.set(periodKey, new Set());
                }
            }
    
            const localSets = localSetsByPeriodKey.get(periodKey) || { localCustomerIds: new Set(), sourceCustomerIds: new Set() };
            const alreadyLocal =
                localSets.localCustomerIds.has(customerId) ||
                (customerSourceId && localSets.sourceCustomerIds.has(customerSourceId));
            if (!force && alreadyLocal) {
                result.skippedAlreadyCollected += 1;
                continue;
            }
    
            const normalizedRowData = {
                empresa: rowEmpresa || String(customerRow.company || customerRow.name || '').trim(),
                nif: rowNif || normalizeDigits(customerRow.nif || ''),
                estado: rowEstado || null,
                situacao: rowSituacao || null,
                identificacao: rowIdentificacao || null,
                periodoRaw: rowPeriodoRaw || null,
                estadoAt: null,
                dataRecebidoRaw: rowDataRecebidoRaw || null,
                dataRecebidoIso: parseDatePtToIso(rowDataRecebidoRaw),
                dataComprovativoRaw: rowDataComprovativoRaw || null,
                dataComprovativoIso: parseDatePtToIso(rowDataComprovativoRaw),
                raw: row,
            };
    
            try {
                await upsertLocalObrigacaoRecolha({
                    customerId,
                    customerSourceId,
                    obrigacaoId: rowObrigacaoId,
                    obrigacaoCodigo: String(rowObrigacaoId),
                    obrigacaoNome: rowObrigacaoNome,
                    periodoTipo: periodo.tipo,
                    periodoAno: periodo.ano,
                    periodoMes: periodo.mes,
                    periodoTrimestre: periodo.trimestre,
                    estadoCodigo: normalizedRowData.estado,
                    identificacao: normalizedRowData.identificacao,
                    dataRecebido: normalizedRowData.dataRecebidoIso || normalizedRowData.dataRecebidoRaw,
                    dataComprovativo: normalizedRowData.dataComprovativoIso || normalizedRowData.dataComprovativoRaw,
                    empresa: normalizedRowData.empresa,
                    nif: normalizedRowData.nif,
                    payload: normalizedRowData.raw,
                    origem: 'saft_iva_robot',
                    syncedSupabaseAt: null,
                });
                result.localSaved += 1;
                localSets.localCustomerIds.add(customerId);
                if (customerSourceId) localSets.sourceCustomerIds.add(customerSourceId);
            } catch (error) {
                result.syncErrors += 1;
                if (errors.length < 50) {
                    errors.push({
                        customerId,
                        nif: normalizedRowData.nif,
                        step: 'local_upsert',
                        error: String(error?.message || error),
                    });
                }
                continue;
            }
    
            const statusCheck = classifyIvaProcessadoStatus(normalizedRowData.estado, normalizedRowData.situacao);
            if (!statusCheck.isSuccess) {
                result.skippedInvalidStatus += 1;
                if (warnings.length < 50) {
                    warnings.push(
                        `IVA ignorado (${normalizedRowData.nif || 'sem NIF'}): estado "${normalizedRowData.estado || '-'}"${
                            normalizedRowData.situacao ? ` / situação "${normalizedRowData.situacao}"` : ''
                        } (necessário: Processado).`
                    );
                }
                continue;
            }
    
            if (dryRun || !(SUPABASE_URL && SUPABASE_KEY)) {
                continue;
            }
            if (!customerSourceId) {
                result.syncErrors += 1;
                if (errors.length < 50) {
                    errors.push({
                        customerId,
                        nif: normalizedRowData.nif,
                        step: 'customer_source_id',
                        error: 'Cliente sem source_id para sincronizar no Supabase.',
                    });
                }
                continue;
            }
    
            try {
                await syncRecolhaEstadoSupabase({
                    customerSourceId,
                    obrigacaoId: rowObrigacaoId,
                    obrigacaoNome: rowObrigacaoNome,
                    periodo,
                    rowData: normalizedRowData,
                });
                result.recolhasSyncOk += 1;
            } catch (error) {
                result.syncErrors += 1;
                if (errors.length < 50) {
                    errors.push({
                        customerId,
                        customerSourceId,
                        nif: normalizedRowData.nif,
                        step: 'recolhas_estados',
                        error: String(error?.message || error),
                    });
                }
            }
    
            try {
                const updateInfo = await updateObrigacaoPeriodoSupabase({
                    customerSourceId,
                    obrigacaoId: rowObrigacaoId,
                    periodo,
                    estadoFinal: 4,
                });
                if (Number(updateInfo.updatedRows || 0) > 0) {
                    result.periodosUpdateOk += 1;
                    await markLocalObrigacaoRecolhaSynced({
                        customerId,
                        obrigacaoId: rowObrigacaoId,
                        periodo,
                    });
                } else {
                    warnings.push(
                        `Sem linhas atualizadas em ${updateInfo.table} para cliente ${customerSourceId} (obrigação ${rowObrigacaoId}).`
                    );
                }
            } catch (error) {
                result.syncErrors += 1;
                if (errors.length < 50) {
                    errors.push({
                        customerId,
                        customerSourceId,
                        nif: normalizedRowData.nif,
                        step: 'clientes_obrigacoes_periodos',
                        error: String(error?.message || error),
                    });
                }
            }
        }
    
        const obrigacoesUsadas = Array.from(usedObrigacoes.values());
        const obrigacaoResumo =
            obrigacoesUsadas.length === 1
                ? obrigacoesUsadas[0]
                : {
                    id: obrigacaoId,
                    nome: obrigacaoNome,
                    periodicidade: obrigacoesUsadas.length > 1 ? 'MISTA' : periodicidade,
                };
    
        await writeAuditLog({
            actorUserId: String(body.requestedBy || '').trim() || null,
            entityType: 'obrigacao_iva_recolha',
            entityId: `${targetPeriod.year}-${String(targetPeriod.month || 0).padStart(2, '0')}`,
            action: 'sync',
            details: {
                dryRun,
                force,
                obrigacaoId: obrigacaoResumo.id,
                obrigacaoNome: obrigacaoResumo.nome,
                obrigacoesUsadas,
                startedAt,
                endedAt: nowIso(),
                result,
                warnings,
                errors: errors.slice(0, 20),
            },
        });
    
        return res.json({
            success: true,
            dryRun,
            force,
            period: {
                tipo: 'mixed',
                ano: targetPeriod.year,
                mes: targetPeriod.month >= 1 && targetPeriod.month <= 12 ? targetPeriod.month : null,
                trimestre: targetPeriod.month >= 101 && targetPeriod.month <= 104 ? targetPeriod.month - 100 : null,
            },
            obrigacao: {
                id: obrigacaoResumo.id,
                nome: obrigacaoResumo.nome,
                periodicidade: obrigacaoResumo.periodicidade,
            },
            obrigacoesUsadas,
            startedAt,
            finishedAt: nowIso(),
            result,
            warnings,
            missingCustomers: missing.slice(0, 50),
            errors,
        });
    });
    
    app.get('/api/import/obrigacoes/iva/jobs/:jobId', async (req, res) => {
        const jobId = String(req.params.jobId || '').trim();
        if (!jobId) {
            return res.status(400).json({ success: false, error: 'jobId inválido.' });
        }
    
        const job = ivaImportJobs.get(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job IVA não encontrado.' });
        }
    
        return res.json({
            success: true,
            job,
        });
    });
}

module.exports = { registerObrigacoesAnnualIvaRoutes };
