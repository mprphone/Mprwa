/**
 * Obrigações Core Routes — extracted from importObrigacoesRoutes.js
 * Routes: DRI, DMR, SAFT core import + GOFF proxies (SAFT/DMR/DRI/IVA)
 */
function registerObrigacoesCoreRoutes(context) {
    const {
        app, axios, DRI_OBRIGACAO_ID, DMR_OBRIGACAO_ID, SAFT_OBRIGACAO_ID,
        IVA_OBRIGACAO_ID_MENSAL, IVA_OBRIGACAO_ID_TRIMESTRAL,
        SUPABASE_URL, SUPABASE_KEY, SUPABASE_OBRIGACOES_MODELO,
        SUPABASE_CLIENTS_SOURCE, PORT,
        normalizeBoolean, normalizeIntValue, resolveMonthYear, nowIso,
        runGoffObrigacoesRobotDmrSs, runSaftObrigacoesRobotDri,
        fetchSupabaseTable, resolveObrigacaoModeloRow, pickFirstValue,
        normalizeIvaPeriodicidade, resolveObrigacaoPeriod,
        loadSupabaseCustomerLookup, findCustomerRowForObrigacao,
        resolveSupabaseCustomerIdFromLocalRow, loadLocalCollectedSets,
        loadSupabaseCollectedSourceIds, upsertLocalObrigacaoRecolha,
        syncRecolhaEstadoSupabase, updateObrigacaoPeriodoSupabase,
        markLocalObrigacaoRecolhaSynced, writeAuditLog,
        classifyDriCmpEnvStatus, classifyDmrProcessadoCertaStatus,
        classifySaftEnviadoStatus, classifyGoffSaftStatus,
        classifyGoffIvaStatus,
        normalizeDigits, parseDatePtToIso, normalizeLookupText,
        materializeLocalCustomerFromSupabase,
        runSaftObrigacoesRobotDmr, runSaftObrigacoesRobotSaft,
        runGoffObrigacoesRobotSaft, runGoffObrigacoesRobotDmrAt,
        runGoffObrigacoesRobotIva,
    } = context;

    app.post('/api/import/obrigacoes/dri', async (req, res) => {
        const body = req.body || {};
        const dryRun = normalizeBoolean(body.dryRun, false);
        const force = normalizeBoolean(body.force, false);
        const source = String(body.source || 'saftonline').trim().toLowerCase();
        const isGoffSource = source === 'goff';
        const monthOffset = isGoffSource
            ? -1
            : (Number.isFinite(Number(body.monthOffset))
                ? Number(body.monthOffset)
                : (normalizeBoolean(body.usePreviousMonth, false) ? -1 : 0));
    
        let targetPeriod;
        if (!isGoffSource && body.year !== undefined && body.month !== undefined) {
            targetPeriod = {
                year: normalizeIntValue(body.year, new Date().getUTCFullYear()),
                month: normalizeIntValue(body.month, new Date().getUTCMonth() + 1),
            };
        } else {
            targetPeriod = resolveMonthYear(new Date(), monthOffset);
        }
        if (targetPeriod.month < 1 || targetPeriod.month > 12) {
            return res.status(400).json({ success: false, error: 'Mês inválido. Use valores entre 1 e 12.' });
        }
    
        const warnings = [];
        if (isGoffSource && (body.year !== undefined || body.month !== undefined || body.monthOffset !== undefined)) {
            warnings.push('GOFF DMR SS usa sempre o mês anterior (year/month/monthOffset foram ignorados).');
        }
        const startedAt = nowIso();
        let robotPayload;
    
        try {
            if (isGoffSource) {
                robotPayload = await runGoffObrigacoesRobotDmrSs({
                    year: targetPeriod.year,
                    month: targetPeriod.month,
                    nif: String(body.nif || '').trim(),
                    nome: String(body.nome || '').trim(),
                });
            } else {
                robotPayload = await runSaftObrigacoesRobotDri({
                    year: targetPeriod.year,
                    month: targetPeriod.month,
                });
            }
        } catch (error) {
            const details = error?.message || error;
            return res.status(500).json({
                success: false,
                error: `Falha no robô ${isGoffSource ? 'GOFF DMR SS' : 'DRI'}: ${details}`,
                period: targetPeriod,
            });
        }
    
        const rows = Array.isArray(robotPayload?.rows) ? robotPayload.rows : [];
        let modeloRow = null;
        let obrigacaoId = DRI_OBRIGACAO_ID;
        let obrigacaoNome = 'DRI';
        let periodicidade = 'mensal';
    
        if (SUPABASE_URL && SUPABASE_KEY) {
            try {
                const modeloRows = await fetchSupabaseTable(SUPABASE_OBRIGACOES_MODELO);
                modeloRow = resolveObrigacaoModeloRow(modeloRows, DRI_OBRIGACAO_ID);
                if (modeloRow) {
                    obrigacaoId = normalizeIntValue(
                        pickFirstValue(modeloRow, ['id', 'obrigacao_id', 'codigo', 'codigo_obrigacao', 'modelo_id']),
                        DRI_OBRIGACAO_ID
                    );
                    obrigacaoNome =
                        String(
                            pickFirstValue(modeloRow, ['nome', 'designacao', 'descricao', 'obrigacao_nome', 'titulo']) ||
                                'DRI'
                        ).trim() || 'DRI';
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
                } else {
                    warnings.push(
                        `Obrigação DRI (${DRI_OBRIGACAO_ID}) não encontrada em ${SUPABASE_OBRIGACOES_MODELO}; a usar mensal por defeito.`
                    );
                }
            } catch (error) {
                warnings.push(`Falha a carregar ${SUPABASE_OBRIGACOES_MODELO}. A usar configuração mensal por defeito.`);
            }
        } else {
            warnings.push('Supabase não configurado. Será gravado apenas em SQL local.');
        }
    
        const periodo = resolveObrigacaoPeriod(periodicidade, targetPeriod.year, targetPeriod.month);
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
                console.error('[DRI] Erro lookup clientes Supabase:', error?.message || error);
            }
        }
    
        try {
            localCollectedSets = await loadLocalCollectedSets({
                obrigacaoId,
                periodo,
                statusClassifier: (estado, _estadoAt, payload) =>
                    isGoffSource ? classifyGoffIvaStatus(estado, payload?.situacao) : classifyDriCmpEnvStatus(estado),
            });
        } catch (error) {
            warnings.push('Falha ao carregar recolhas locais já processadas para este período.');
        }
    
        if (!dryRun && SUPABASE_URL && SUPABASE_KEY) {
            try {
                const loaded = await loadSupabaseCollectedSourceIds({
                    obrigacaoId,
                    periodo,
                });
                supabaseCollectedSourceIds = loaded.sourceIds;
            } catch (error) {
                warnings.push('Falha ao carregar estados já recolhidos no Supabase para este período.');
            }
        }
    
        for (const row of rows) {
            const rowEmpresa = String(pickFirstValue(row, ['empresa', 'company', 'nome', 'name']) || '').trim();
            const rowNif = normalizeDigits(pickFirstValue(row, ['nif', 'NIF', 'vat', 'cliente_NIF']) || '');
            const rowEstado = String(pickFirstValue(row, ['estado', 'status', 'situacao', 'situação']) || '').trim();
            const rowIdentificacao = String(pickFirstValue(row, ['identificacao', 'identificação', 'id']) || '').trim();
            const rowDataRecebidoRaw = String(
                pickFirstValue(row, ['dataRecebido', 'data_recebido', 'data recebido', 'dataEntrega', 'data']) || ''
            ).trim();
            const rowDataComprovativoRaw = String(
                pickFirstValue(row, ['dataComprovativo', 'data_comprovativo', 'data comprovativo', 'dataEntrega', 'data']) || ''
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
                estadoAt: String(pickFirstValue(row, ['estadoAt', 'estado_at', 'estadoAT', 'estado at']) || '').trim() || null,
                situacao: String(pickFirstValue(row, ['situacao', 'situação']) || '').trim() || null,
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
                    origem: isGoffSource ? 'goff_dri_ss_robot' : 'saft_dri_robot',
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
    
            const statusCheck = isGoffSource
                ? classifyGoffIvaStatus(normalizedRowData.estado, normalizedRowData.situacao)
                : classifyDriCmpEnvStatus(normalizedRowData.estado);
            if (!statusCheck.isSuccess) {
                result.skippedInvalidStatus += 1;
                if (warnings.length < 50) {
                    warnings.push(
                        isGoffSource
                            ? `GOFF DMR SS ignorado (${normalizedRowData.nif || 'sem NIF'}): estado/situação "${normalizedRowData.estado || '-'}" (necessário: Submetida/Integrado/Processado).`
                            : `DRI ignorado (${normalizedRowData.nif || 'sem NIF'}): estado "${normalizedRowData.estado || '-'}" (necessário: CMP-Env).`
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
                    obrigacaoId,
                    periodo,
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
            entityType: 'obrigacao_dri_recolha',
            entityId: `${periodo.ano}-${String(periodo.mes || 0).padStart(2, '0')}`,
            action: 'sync',
            details: {
                dryRun,
                source: isGoffSource ? 'goff' : 'saftonline',
                period: periodo,
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
            source: isGoffSource ? 'goff' : 'saftonline',
            period: periodo,
            obrigacao: {
                id: obrigacaoId,
                nome: obrigacaoNome,
                periodicidade,
            },
            startedAt,
            finishedAt: nowIso(),
            result,
            robotStats: robotPayload?.stats || null,
            warnings,
            missingCustomers: missing.slice(0, 50),
            errors,
        });
    });
    
    app.post('/api/import/obrigacoes/dmr', async (req, res) => {
        const body = req.body || {};
        const dryRun = normalizeBoolean(body.dryRun, false);
        const force = normalizeBoolean(body.force, false);
        const source = String(body.source || 'saftonline').trim().toLowerCase();
        const isGoffSource = source === 'goff';
        const monthOffset = isGoffSource
            ? -1
            : (Number.isFinite(Number(body.monthOffset))
                ? Number(body.monthOffset)
                : (normalizeBoolean(body.usePreviousMonth, false) ? -1 : 0));
    
        let targetPeriod;
        if (!isGoffSource && body.year !== undefined && body.month !== undefined) {
            targetPeriod = {
                year: normalizeIntValue(body.year, new Date().getUTCFullYear()),
                month: normalizeIntValue(body.month, new Date().getUTCMonth() + 1),
            };
        } else {
            targetPeriod = resolveMonthYear(new Date(), monthOffset);
        }
        if (targetPeriod.month < 1 || targetPeriod.month > 12) {
            return res.status(400).json({ success: false, error: 'Mês inválido. Use valores entre 1 e 12.' });
        }
    
        const warnings = [];
        if (isGoffSource && (body.year !== undefined || body.month !== undefined || body.monthOffset !== undefined)) {
            warnings.push('GOFF DMR AT usa sempre o mês anterior (year/month/monthOffset foram ignorados).');
        }
        const startedAt = nowIso();
        let robotPayload;
    
        try {
            if (isGoffSource) {
                robotPayload = await runGoffObrigacoesRobotDmrAt({
                    year: targetPeriod.year,
                    month: targetPeriod.month,
                    nif: String(body.nif || '').trim(),
                    nome: String(body.nome || '').trim(),
                });
            } else {
                robotPayload = await runSaftObrigacoesRobotDmr({
                    year: targetPeriod.year,
                    month: targetPeriod.month,
                });
            }
        } catch (error) {
            const details = error?.message || error;
            return res.status(500).json({
                success: false,
                error: `Falha no robô ${isGoffSource ? 'GOFF DMR AT' : 'DMR'}: ${details}`,
                period: targetPeriod,
            });
        }
    
        const rows = Array.isArray(robotPayload?.rows) ? robotPayload.rows : [];
        let modeloRow = null;
        let obrigacaoId = DMR_OBRIGACAO_ID;
        let obrigacaoNome = 'DMR';
        let periodicidade = 'mensal';
    
        if (SUPABASE_URL && SUPABASE_KEY) {
            try {
                const modeloRows = await fetchSupabaseTable(SUPABASE_OBRIGACOES_MODELO);
                modeloRow = resolveObrigacaoModeloRow(modeloRows, DMR_OBRIGACAO_ID, ['dmr']);
                if (modeloRow) {
                    obrigacaoId = normalizeIntValue(
                        pickFirstValue(modeloRow, ['id', 'obrigacao_id', 'codigo', 'codigo_obrigacao', 'modelo_id']),
                        DMR_OBRIGACAO_ID
                    );
                    obrigacaoNome =
                        String(
                            pickFirstValue(modeloRow, ['nome', 'designacao', 'descricao', 'obrigacao_nome', 'titulo']) ||
                                'DMR'
                        ).trim() || 'DMR';
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
                } else {
                    warnings.push(
                        `Obrigação DMR (${DMR_OBRIGACAO_ID}) não encontrada em ${SUPABASE_OBRIGACOES_MODELO}; a usar mensal por defeito.`
                    );
                }
            } catch (error) {
                warnings.push(`Falha a carregar ${SUPABASE_OBRIGACOES_MODELO}. A usar configuração mensal por defeito.`);
            }
        } else {
            warnings.push('Supabase não configurado. Será gravado apenas em SQL local.');
        }
    
        const periodo = resolveObrigacaoPeriod(periodicidade, targetPeriod.year, targetPeriod.month);
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
                console.error('[DMR] Erro lookup clientes Supabase:', error?.message || error);
            }
        }
    
        try {
            localCollectedSets = await loadLocalCollectedSets({
                obrigacaoId,
                periodo,
                statusClassifier: (estado, estadoAt, payload) =>
                    isGoffSource
                        ? classifyGoffIvaStatus(estado, payload?.situacao)
                        : classifyDmrProcessadoCertaStatus(estado, estadoAt),
            });
        } catch (error) {
            warnings.push('Falha ao carregar recolhas locais já processadas para este período.');
        }
    
        if (!dryRun && SUPABASE_URL && SUPABASE_KEY) {
            try {
                const loaded = await loadSupabaseCollectedSourceIds({
                    obrigacaoId,
                    periodo,
                });
                supabaseCollectedSourceIds = loaded.sourceIds;
            } catch (error) {
                warnings.push('Falha ao carregar estados já recolhidos no Supabase para este período.');
            }
        }
    
        for (const row of rows) {
            const rowEmpresa = String(pickFirstValue(row, ['empresa', 'company', 'nome', 'name']) || '').trim();
            const rowNif = normalizeDigits(pickFirstValue(row, ['nif', 'NIF', 'vat', 'cliente_NIF']) || '');
            const rowEstado = String(pickFirstValue(row, ['estado', 'status', 'situacao', 'situação']) || '').trim();
            const rowIdentificacao = String(
                pickFirstValue(row, ['identificacao', 'identificação', 'idFicheiro', 'id_ficheiro', 'id']) || ''
            ).trim();
            const rowDataRecebidoRaw = String(
                pickFirstValue(row, ['dataStatus', 'data_status', 'dataRecebido', 'data_recebido', 'data recebido', 'dataEntrega', 'data']) || ''
            ).trim();
            const rowDataComprovativoRaw = String(
                pickFirstValue(row, ['dataComprovativo', 'data_comprovativo', 'data comprovativo', 'dataEntrega', 'data']) || ''
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
                identificacao: rowIdentificacao || null,
                estadoAt: String(pickFirstValue(row, ['estadoAt', 'estado_at', 'estadoAT', 'estado at']) || '').trim() || null,
                situacao: String(pickFirstValue(row, ['situacao', 'situação']) || '').trim() || null,
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
                    origem: isGoffSource ? 'goff_dmr_at_robot' : 'saft_dmr_robot',
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
    
            const statusCheck = isGoffSource
                ? classifyGoffIvaStatus(normalizedRowData.estado, normalizedRowData.situacao)
                : classifyDmrProcessadoCertaStatus(normalizedRowData.estado, normalizedRowData.estadoAt);
            if (!statusCheck.isSuccess) {
                result.skippedInvalidStatus += 1;
                if (warnings.length < 50) {
                    warnings.push(
                        isGoffSource
                            ? `GOFF DMR AT ignorado (${normalizedRowData.nif || 'sem NIF'}): estado/situação "${normalizedRowData.estado || '-'}" (necessário: Submetida/Integrado/Processado).`
                            : `DMR ignorado (${normalizedRowData.nif || 'sem NIF'}): estado "${normalizedRowData.estado || '-'}"${
                                normalizedRowData.estadoAt ? ` / AT "${normalizedRowData.estadoAt}"` : ''
                            } (necessário: Processado + CERTA).`
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
    
            let recolhaSyncSuccess = false;
            try {
                await syncRecolhaEstadoSupabase({
                    customerSourceId,
                    obrigacaoId,
                    obrigacaoNome,
                    periodo,
                    rowData: normalizedRowData,
                });
                result.recolhasSyncOk += 1;
                recolhaSyncSuccess = true;
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
                    periodo,
                    estadoFinal: 4,
                });
                if (Number(updateInfo.updatedRows || 0) > 0) {
                    result.periodosUpdateOk += 1;
                    if (recolhaSyncSuccess) {
                        await markLocalObrigacaoRecolhaSynced({
                            customerId,
                            obrigacaoId,
                            periodo,
                        });
                    } else if (warnings.length < 50) {
                        warnings.push(
                            `Período atualizado sem recolha_estado (${customerSourceId}, obrigação ${obrigacaoId}). Vai voltar a tentar na próxima recolha.`
                        );
                    }
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
            entityType: 'obrigacao_dmr_recolha',
            entityId: `${periodo.ano}-${String(periodo.mes || 0).padStart(2, '0')}`,
            action: 'sync',
            details: {
                dryRun,
                source: isGoffSource ? 'goff' : 'saftonline',
                period: periodo,
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
            source: isGoffSource ? 'goff' : 'saftonline',
            period: periodo,
            obrigacao: {
                id: obrigacaoId,
                nome: obrigacaoNome,
                periodicidade,
            },
            startedAt,
            finishedAt: nowIso(),
            result,
            robotStats: robotPayload?.stats || null,
            warnings,
            missingCustomers: missing.slice(0, 50),
            errors,
        });
    });
    
    app.post('/api/import/obrigacoes/saft', async (req, res) => {
        const body = req.body || {};
        const dryRun = normalizeBoolean(body.dryRun, false);
        const force = normalizeBoolean(body.force, false);
        const source = String(body.source || 'saftonline').trim().toLowerCase();
        const isGoffSource = source === 'goff';
        const monthOffset = isGoffSource
            ? -1
            : (Number.isFinite(Number(body.monthOffset))
                ? Number(body.monthOffset)
                : (normalizeBoolean(body.usePreviousMonth, false) ? -1 : 0));
    
        let targetPeriod;
        if (!isGoffSource && body.year !== undefined && body.month !== undefined) {
            targetPeriod = {
                year: normalizeIntValue(body.year, new Date().getUTCFullYear()),
                month: normalizeIntValue(body.month, new Date().getUTCMonth() + 1),
            };
        } else {
            targetPeriod = resolveMonthYear(new Date(), monthOffset);
        }
        if (targetPeriod.month < 1 || targetPeriod.month > 12) {
            return res.status(400).json({ success: false, error: 'Mês inválido. Use valores entre 1 e 12.' });
        }
    
        const warnings = [];
        if (isGoffSource && (body.year !== undefined || body.month !== undefined || body.monthOffset !== undefined)) {
            warnings.push('GOFF SAFT usa sempre o mês anterior (year/month/monthOffset foram ignorados).');
        }
        const startedAt = nowIso();
        let robotPayload;
    
        try {
            if (isGoffSource) {
                robotPayload = await runGoffObrigacoesRobotSaft({
                    year: targetPeriod.year,
                    month: targetPeriod.month,
                    nif: String(body.nif || '').trim(),
                    nome: String(body.nome || '').trim(),
                });
            } else {
                robotPayload = await runSaftObrigacoesRobotSaft({
                    year: targetPeriod.year,
                    month: targetPeriod.month,
                });
            }
        } catch (error) {
            const details = error?.message || error;
            return res.status(500).json({
                success: false,
                error: `Falha no robô ${isGoffSource ? 'GOFF SAFT' : 'SAFT'}: ${details}`,
                period: targetPeriod,
            });
        }
    
        const rows = Array.isArray(robotPayload?.rows) ? robotPayload.rows : [];
        let modeloRow = null;
        let obrigacaoId = SAFT_OBRIGACAO_ID;
        let obrigacaoNome = 'SAFT';
        let periodicidade = 'mensal';
    
        if (SUPABASE_URL && SUPABASE_KEY) {
            try {
                const modeloRows = await fetchSupabaseTable(SUPABASE_OBRIGACOES_MODELO);
                modeloRow = resolveObrigacaoModeloRow(modeloRows, SAFT_OBRIGACAO_ID, ['saft']);
                if (modeloRow) {
                    obrigacaoId = normalizeIntValue(
                        pickFirstValue(modeloRow, ['id', 'obrigacao_id', 'codigo', 'codigo_obrigacao', 'modelo_id']),
                        SAFT_OBRIGACAO_ID
                    );
                    obrigacaoNome =
                        String(
                            pickFirstValue(modeloRow, ['nome', 'designacao', 'descricao', 'obrigacao_nome', 'titulo']) ||
                                'SAFT'
                        ).trim() || 'SAFT';
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
                } else {
                    warnings.push(
                        `Obrigação SAFT (${SAFT_OBRIGACAO_ID}) não encontrada em ${SUPABASE_OBRIGACOES_MODELO}; a usar mensal por defeito.`
                    );
                }
            } catch (error) {
                warnings.push(`Falha a carregar ${SUPABASE_OBRIGACOES_MODELO}. A usar configuração mensal por defeito.`);
            }
        } else {
            warnings.push('Supabase não configurado. Será gravado apenas em SQL local.');
        }
    
        const periodo = resolveObrigacaoPeriod(periodicidade, targetPeriod.year, targetPeriod.month);
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
                console.error('[SAFT] Erro lookup clientes Supabase:', error?.message || error);
            }
        }
    
        try {
            localCollectedSets = await loadLocalCollectedSets({
                obrigacaoId,
                periodo,
                statusClassifier: (estado) => classifySaftEnviadoStatus(estado),
            });
        } catch (error) {
            warnings.push('Falha ao carregar recolhas locais já processadas para este período.');
        }
    
        if (!dryRun && SUPABASE_URL && SUPABASE_KEY) {
            try {
                const loaded = await loadSupabaseCollectedSourceIds({
                    obrigacaoId,
                    periodo,
                });
                supabaseCollectedSourceIds = loaded.sourceIds;
            } catch (error) {
                warnings.push('Falha ao carregar estados já recolhidos no Supabase para este período.');
            }
        }
    
        for (const row of rows) {
            const rowEmpresa = String(pickFirstValue(row, ['empresa', 'company', 'nome', 'name']) || '').trim();
            const rowNif = normalizeDigits(pickFirstValue(row, ['nif', 'NIF', 'vat']) || '');
            const rowSituacao = String(pickFirstValue(row, ['situacao', 'situação']) || '').trim();
            const rowEstado = String(pickFirstValue(row, ['estado', 'status']) || rowSituacao).trim();
            const rowIdentificacao = String(
                pickFirstValue(row, ['idFicheiro', 'id_ficheiro', 'identificacao', 'identificação', 'id']) || ''
            ).trim();
            const rowDataRecebidoRaw = String(
                pickFirstValue(row, [
                    'dataEntrega',
                    'data_entrega',
                    'data',
                    'dataStatus',
                    'data_status',
                    'dataRecebido',
                    'data_recebido',
                    'data recebido',
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
                situacao: rowSituacao || null,
                identificacao: rowIdentificacao || null,
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
                    origem: isGoffSource ? 'goff_saft_robot' : 'saft_safts_robot',
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
    
            const statusCheck = isGoffSource
                ? classifyGoffSaftStatus(normalizedRowData.estado, normalizedRowData.situacao)
                : classifySaftEnviadoStatus(normalizedRowData.estado);
            if (!statusCheck.isSuccess) {
                result.skippedInvalidStatus += 1;
                if (warnings.length < 50) {
                    warnings.push(
                        isGoffSource
                            ? `GOFF SAFT ignorado (${normalizedRowData.nif || 'sem NIF'}): estado/situação "${normalizedRowData.estado || '-'}" (necessário: Integrado com sucesso/Processado/Enviado).`
                            : `SAFT ignorado (${normalizedRowData.nif || 'sem NIF'}): estado "${normalizedRowData.estado || '-'}" (necessário: Enviado ou EnviadoInex).`
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
                    obrigacaoId,
                    periodo,
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
            entityType: 'obrigacao_saft_recolha',
            entityId: `${periodo.ano}-${String(periodo.mes || 0).padStart(2, '0')}`,
            action: 'sync',
            details: {
                dryRun,
                source: isGoffSource ? 'goff' : 'saftonline',
                period: periodo,
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
            period: periodo,
            obrigacao: {
                id: obrigacaoId,
                nome: obrigacaoNome,
                periodicidade,
            },
            startedAt,
            finishedAt: nowIso(),
            result,
            source: isGoffSource ? 'goff' : 'saftonline',
            robotStats: robotPayload?.stats || null,
            warnings,
            missingCustomers: missing.slice(0, 50),
            errors,
        });
    });
    
    app.post('/api/import/obrigacoes/goff/saft', async (req, res) => {
        const body = req.body || {};
        const payload = {
            ...body,
            source: 'goff',
        };
        delete payload.year;
        delete payload.month;
        delete payload.monthOffset;
        delete payload.usePreviousMonth;
    
        try {
            const internalResponse = await axios.post(
                `http://127.0.0.1:${PORT}/api/import/obrigacoes/saft`,
                payload,
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10 * 60 * 1000,
                    validateStatus: () => true,
                }
            );
    
            return res.status(internalResponse.status).json(internalResponse.data);
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: String(error?.response?.data?.error || error?.message || error),
            });
        }
    });
    
    app.post('/api/import/obrigacoes/goff/dmr', async (req, res) => {
        const body = req.body || {};
        const payload = {
            ...body,
            source: 'goff',
        };
        delete payload.year;
        delete payload.month;
        delete payload.monthOffset;
        delete payload.usePreviousMonth;
    
        try {
            const internalResponse = await axios.post(
                `http://127.0.0.1:${PORT}/api/import/obrigacoes/dmr`,
                payload,
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10 * 60 * 1000,
                    validateStatus: () => true,
                }
            );
    
            return res.status(internalResponse.status).json(internalResponse.data);
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: String(error?.response?.data?.error || error?.message || error),
            });
        }
    });
    
    app.post('/api/import/obrigacoes/goff/dri', async (req, res) => {
        const body = req.body || {};
        const payload = {
            ...body,
            source: 'goff',
        };
        delete payload.year;
        delete payload.month;
        delete payload.monthOffset;
        delete payload.usePreviousMonth;
    
        try {
            const internalResponse = await axios.post(
                `http://127.0.0.1:${PORT}/api/import/obrigacoes/dri`,
                payload,
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10 * 60 * 1000,
                    validateStatus: () => true,
                }
            );
    
            return res.status(internalResponse.status).json(internalResponse.data);
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: String(error?.response?.data?.error || error?.message || error),
            });
        }
    });
    
    app.post('/api/import/obrigacoes/goff/iva', async (req, res) => {
        const body = req.body || {};
        const dryRun = normalizeBoolean(body.dryRun, false);
        const force = normalizeBoolean(body.force, false);
        const monthOffset = Number.isFinite(Number(body.monthOffset))
            ? Number(body.monthOffset)
            : (normalizeBoolean(body.usePreviousMonth, false) ? -1 : -2);
    
        let targetPeriod;
        if (body.year !== undefined && body.month !== undefined) {
            targetPeriod = {
                year: normalizeIntValue(body.year, new Date().getUTCFullYear()),
                month: normalizeIntValue(body.month, new Date().getUTCMonth() + 1),
            };
        } else {
            targetPeriod = resolveMonthYear(new Date(), monthOffset);
        }
    
        if (targetPeriod.month < 1 || targetPeriod.month > 12) {
            return res.status(400).json({
                success: false,
                error: 'Mês inválido. Use valores entre 1 e 12.',
            });
        }
    
        const warnings = [];
        const startedAt = nowIso();
        let robotPayload;
    
        try {
            robotPayload = await runGoffObrigacoesRobotIva({
                year: targetPeriod.year,
                month: targetPeriod.month,
                nif: String(body.nif || '').trim(),
                nome: String(body.nome || '').trim(),
            });
        } catch (error) {
            const details = error?.message || error;
            return res.status(500).json({
                success: false,
                error: `Falha no robô GOFF IVA: ${details}`,
                period: targetPeriod,
            });
        }
    
        const rows = Array.isArray(robotPayload?.rows) ? robotPayload.rows : [];
        const result = {
            totalRows: rows.length,
            matchedCustomers: 0,
            missingCustomers: 0,
            syncedCustomersFromSupabase: 0,
            skippedAlreadyCollected: 0,
            skippedInvalidStatus: 0,
            skippedPeriodInvalid: 0,
            skippedTypeUnknown: 0,
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
        const usedObrigacoes = new Map();
    
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
        };
    
        if (SUPABASE_URL && SUPABASE_KEY) {
            try {
                const modeloRows = await fetchSupabaseTable(SUPABASE_OBRIGACOES_MODELO);
                const ivaRows = (Array.isArray(modeloRows) ? modeloRows : []).filter((row) => {
                    const label = String(
                        pickFirstValue(row, ['nome', 'designacao', 'descricao', 'obrigacao_nome', 'titulo']) || ''
                    ).trim().toLowerCase();
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
                            ]) || ''
                        ).trim();
                    const rowTipo = normalizeIvaPeriodicidade(rowPeriodicidade);
                    if ((rowTipo === 'mensal' || rowTipo === 'trimestral') && !ivaObrigacoesByTipo[rowTipo]?.id) {
                        ivaObrigacoesByTipo[rowTipo] = {
                            id: rowId,
                            nome: rowNome,
                            periodicidade: rowPeriodicidade || (rowTipo === 'mensal' ? 'MENSAL' : 'TRIMESTRAL'),
                        };
                    }
                }
            } catch (error) {
                warnings.push(`Falha a carregar ${SUPABASE_OBRIGACOES_MODELO}. A usar IDs IVA defaults 10/11.`);
            }
        } else {
            warnings.push('Supabase não configurado. Será gravado apenas em SQL local.');
        }
    
        if (SUPABASE_URL && SUPABASE_KEY) {
            try {
                supabaseCustomerLookup = await loadSupabaseCustomerLookup();
            } catch (error) {
                warnings.push(`Falha ao carregar lookup de clientes (${SUPABASE_CLIENTS_SOURCE}) para match por NIF.`);
                console.error('[GOFF IVA] Erro lookup clientes Supabase:', error?.message || error);
            }
        }
    
        for (const row of rows) {
            const rowEmpresa = String(pickFirstValue(row, ['empresa', 'company', 'nome', 'name']) || '').trim();
            const rowNif = normalizeDigits(pickFirstValue(row, ['nif', 'NIF', 'vat', 'cliente_NIF']) || '');
            const rowEstado = String(pickFirstValue(row, ['estado', 'status', 'situacao', 'situação']) || '').trim();
            const rowSituacao = String(pickFirstValue(row, ['situacao', 'situação', 'tipoSituacao']) || '').trim();
            const rowIdentificacao = String(
                pickFirstValue(row, ['idFicheiro', 'id_ficheiro', 'identificacao', 'identificação', 'id', 'numeroDeclaracao'])
                    || ''
            ).trim();
            const rowDataRecebidoRaw = String(
                pickFirstValue(row, ['dataRececao', 'data_rececao', 'dataRecebido', 'data_recebido', 'dataEntrega', 'data'])
                    || ''
            ).trim();
    
            const rowYear = normalizeIntValue(pickFirstValue(row, ['ano']), targetPeriod.year);
            const rowMonth = normalizeIntValue(pickFirstValue(row, ['mes', 'periodo']), targetPeriod.month);
            if (!rowYear || !rowMonth || rowMonth < 1 || rowMonth > 12) {
                result.skippedPeriodInvalid += 1;
                if (warnings.length < 50) {
                    warnings.push(`GOFF IVA ignorado (${rowNif || 'sem NIF'}): período inválido ano=${rowYear} mês=${rowMonth}.`);
                }
                continue;
            }
    
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
    
            let customerRow = customerMatch?.customerRow || null;
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
    
            let customerTipoIva = normalizeIvaPeriodicidade(
                pickFirstValue(customerRow, ['tipo_iva', 'tipoIva', 'tipo iva'])
            );
            if (!customerTipoIva && rowNif && supabaseCustomerLookup?.byNif instanceof Map) {
                const candidate = (supabaseCustomerLookup.byNif.get(rowNif) || []).find((item) =>
                    normalizeIvaPeriodicidade(item?.tipoIva)
                );
                if (candidate) {
                    try {
                        const synced = await materializeLocalCustomerFromSupabase(candidate);
                        if (synced) {
                            customerRow = synced;
                            customerTipoIva = normalizeIvaPeriodicidade(
                                pickFirstValue(synced, ['tipo_iva', 'tipoIva', 'tipo iva'])
                            );
                            result.syncedCustomersFromSupabase += 1;
                        }
                    } catch (error) {
                        // ignore fallback sync errors
                    }
                }
            }
    
            if (customerTipoIva !== 'mensal' && customerTipoIva !== 'trimestral') {
                result.skippedTypeUnknown += 1;
                if (warnings.length < 50) {
                    warnings.push(
                        `GOFF IVA ignorado (${rowNif || 'sem NIF'}): tipo IVA do cliente não definido (necessário Mensal/Trimestral).`
                    );
                }
                continue;
            }
    
            const rowObrigacao = ivaObrigacoesByTipo[customerTipoIva] || (
                customerTipoIva === 'trimestral'
                    ? { id: IVA_OBRIGACAO_ID_TRIMESTRAL, nome: 'Iva Trimestral', periodicidade: 'TRIMESTRAL' }
                    : { id: IVA_OBRIGACAO_ID_MENSAL, nome: 'Iva Mensal', periodicidade: 'MENSAL' }
            );
            const rowObrigacaoId = Number(rowObrigacao.id || 0);
            const rowObrigacaoNome = String(rowObrigacao.nome || 'IVA').trim() || 'IVA';
            usedObrigacoes.set(String(rowObrigacaoId), {
                id: rowObrigacaoId,
                nome: rowObrigacaoNome,
                periodicidade: rowObrigacao.periodicidade || null,
                tipo: customerTipoIva,
            });
    
            const periodo = resolveObrigacaoPeriod(
                customerTipoIva === 'trimestral' ? 'trimestral' : 'mensal',
                rowYear,
                rowMonth
            );
            const periodKey = `${rowObrigacaoId}|${periodo.tipo}|${periodo.ano}|${periodo.mes || 0}|${periodo.trimestre || 0}`;
    
            const customerId = String(customerRow.id || '').trim();
            const customerSourceId = resolveSupabaseCustomerIdFromLocalRow(customerRow);
    
            if (!localSetsByPeriodKey.has(periodKey)) {
                try {
                    const localSets = await loadLocalCollectedSets({
                        obrigacaoId: rowObrigacaoId,
                        periodo,
                        statusClassifier: (estado, _estadoAt, payload) =>
                            classifyGoffIvaStatus(estado, payload?.situacao),
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
            const supabaseSet = supabaseSetsByPeriodKey.get(periodKey) || new Set();
            const alreadySupabase = customerSourceId && supabaseSet.has(customerSourceId);
            if (!force && (alreadyLocal || alreadySupabase)) {
                result.skippedAlreadyCollected += 1;
                continue;
            }
    
            const normalizedRowData = {
                empresa: rowEmpresa || String(customerRow.company || customerRow.name || '').trim(),
                nif: rowNif || normalizeDigits(customerRow.nif || ''),
                estado: rowEstado || null,
                situacao: rowSituacao || null,
                identificacao: rowIdentificacao || null,
                estadoAt: null,
                dataRecebidoRaw: rowDataRecebidoRaw || null,
                dataRecebidoIso: parseDatePtToIso(rowDataRecebidoRaw),
                dataComprovativoRaw: null,
                dataComprovativoIso: null,
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
                    dataComprovativo: null,
                    empresa: normalizedRowData.empresa,
                    nif: normalizedRowData.nif,
                    payload: normalizedRowData.raw,
                    origem: 'goff_iva_robot',
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
    
            const statusCheck = classifyGoffIvaStatus(normalizedRowData.estado, normalizedRowData.situacao);
            if (!statusCheck.isSuccess) {
                result.skippedInvalidStatus += 1;
                if (warnings.length < 50) {
                    warnings.push(
                        `GOFF IVA ignorado (${normalizedRowData.nif || 'sem NIF'}): estado/situação "${normalizedRowData.estado || '-'}" (necessário: Submetida/Integrado/Processado).`
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
                    id: null,
                    nome: 'IVA',
                    periodicidade: obrigacoesUsadas.length > 1 ? 'MISTA' : null,
                };
    
        await writeAuditLog({
            actorUserId: String(body.requestedBy || '').trim() || null,
            entityType: 'obrigacao_goff_iva_recolha',
            entityId: `${targetPeriod.year}-${String(targetPeriod.month || 0).padStart(2, '0')}`,
            action: 'sync',
            details: {
                dryRun,
                force,
                source: 'goff',
                period: targetPeriod,
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
            source: 'goff',
            period: {
                tipo: 'mixed',
                ano: targetPeriod.year,
                mes: targetPeriod.month,
                trimestre: null,
            },
            obrigacao: {
                id: obrigacaoResumo.id || undefined,
                nome: obrigacaoResumo.nome || 'IVA',
                periodicidade: obrigacaoResumo.periodicidade || undefined,
            },
            obrigacoesUsadas,
            startedAt,
            finishedAt: nowIso(),
            result,
            robotStats: robotPayload?.stats || null,
            warnings,
            missingCustomers: missing.slice(0, 50),
            errors,
        });
    });
    
    async function handleAnnualSaftObrigacaoImport(req, res, options = {}) {
        const body = req.body || {};
        const dryRun = normalizeBoolean(body.dryRun, false);
        const force = normalizeBoolean(body.force, false);
        const targetYear =
            body.year !== undefined
                ? normalizeIntValue(body.year, new Date().getUTCFullYear() - 1)
                : new Date().getUTCFullYear() - 1;
    
        const routeTag = String(options.routeTag || 'ANUAL').trim();
        const routeTagUpper = routeTag.toUpperCase();
        const defaultObrigacaoId = Number(options.defaultObrigacaoId || 0);
        const defaultObrigacaoNome = String(options.defaultObrigacaoNome || routeTagUpper || 'Obrigação').trim();
        const labelHints = Array.isArray(options.labelHints) ? options.labelHints : [routeTag.toLowerCase()];
        const origem = String(options.origem || `saft_${routeTag.toLowerCase()}_robot`).trim();
        const auditEntityType = String(options.auditEntityType || `obrigacao_${routeTag.toLowerCase()}_recolha`).trim();
        const successLabel = String(options.successLabel || 'Processado').trim();
        const statusClassifier =
            typeof options.statusClassifier === 'function'
                ? options.statusClassifier
                : (estado, estadoAt) => classifyM22ProcessadoStatus(estado, estadoAt);
        const runRobot = typeof options.runRobot === 'function' ? options.runRobot : null;
    
        if (!runRobot) {
            return res.status(500).json({
                success: false,
                error: `Configuração inválida para ${routeTagUpper}: runRobot não definido.`,
                period: { tipo: 'anual', ano: targetYear, mes: null, trimestre: null },
            });
        }
    
        const warnings = [];
        const startedAt = nowIso();
        let robotPayload;
    
        try {
            robotPayload = await runRobot({ year: targetYear });
        } catch (error) {
            const details = error?.message || error;
            return res.status(500).json({
                success: false,
                error: `Falha no robô ${routeTagUpper}: ${details}`,
                period: { tipo: 'anual', ano: targetYear, mes: null, trimestre: null },
            });
        }
    
        const rows = Array.isArray(robotPayload?.rows) ? robotPayload.rows : [];
        let obrigacaoId = defaultObrigacaoId;
        let obrigacaoNome = defaultObrigacaoNome;
        let periodicidade = 'anual';
    
        if (SUPABASE_URL && SUPABASE_KEY) {
            try {
                const modeloRows = await fetchSupabaseTable(SUPABASE_OBRIGACOES_MODELO);
                const modeloRow = resolveObrigacaoModeloRow(modeloRows, defaultObrigacaoId, labelHints);
                if (modeloRow) {
                    obrigacaoId = normalizeIntValue(
                        pickFirstValue(modeloRow, ['id', 'obrigacao_id', 'codigo', 'codigo_obrigacao', 'modelo_id']),
                        defaultObrigacaoId
                    );
                    obrigacaoNome =
                        String(
                            pickFirstValue(modeloRow, ['nome', 'designacao', 'descricao', 'obrigacao_nome', 'titulo']) ||
                                defaultObrigacaoNome
                        ).trim() || defaultObrigacaoNome;
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
                        `Obrigação ${routeTagUpper} (${defaultObrigacaoId}) não encontrada em ${SUPABASE_OBRIGACOES_MODELO}; a usar anual por defeito.`
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
        warnings.push(`${routeTagUpper} ${periodo.ano}: atualização de obrigações aplicada ao ano ${periodoAtualizacao.ano}.`);
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
                console.error(`[${routeTagUpper}] Erro lookup clientes Supabase:`, error?.message || error);
            }
        }
    
        try {
            localCollectedSets = await loadLocalCollectedSets({
                obrigacaoId,
                periodo,
                statusClassifier,
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
                pickFirstValue(row, [
                    'codigo',
                    'numeroDeclaracao',
                    'numero_declaracao',
                    'numero declaracao',
                    'nDeclaracao',
                    'idFicheiro',
                    'id_ficheiro',
                    'identificacao',
                    'identificação',
                    'id',
                ]) || ''
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
                    origem,
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
    
            const statusCheck = statusClassifier(normalizedRowData.estado, normalizedRowData.estadoAt, normalizedRowData.raw);
            if (!statusCheck.isSuccess) {
                result.skippedInvalidStatus += 1;
                if (warnings.length < 50) {
                    warnings.push(
                        `${routeTagUpper} ignorado (${normalizedRowData.nif || 'sem NIF'}): estado "${normalizedRowData.estado || '-'}"${
                            normalizedRowData.estadoAt ? ` / AT "${normalizedRowData.estadoAt}"` : ''
                        } (necessário: ${successLabel}).`
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
            entityType: auditEntityType,
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
    }
    
}

module.exports = { registerObrigacoesCoreRoutes };
