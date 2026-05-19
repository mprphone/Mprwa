/**
 * SAFT Customer Sync Routes — extracted from localSyncSaftRoutes.js
 * Routes: /api/users/sync, /api/users/:id/delete, /api/customers/sync,
 *         /api/customers/sync/pull, /api/customers/:id/autologin/financas,
 *         /api/customers/:id/autologin/seg-social
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { collectFinancasAtProfileInOracle } = require('../services/financasAtProfileOracleService');

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function foldText(value) {
    return cleanText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function onlyDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeDateToIso(value) {
    const text = cleanText(value);
    if (!text) return '';
    let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (match) {
        const yyyy = match[1];
        const mm = String(match[2]).padStart(2, '0');
        const dd = String(match[3]).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }
    match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
    if (match) {
        const dd = String(match[1]).padStart(2, '0');
        const mm = String(match[2]).padStart(2, '0');
        const yyyy = String(match[3]).length === 2 ? `20${match[3]}` : match[3];
        return `${yyyy}-${mm}-${dd}`;
    }
    return text;
}

function todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
}

function isSegSocialCredential(entry) {
    const service = foldText(entry?.service);
    return service === 'ss' || service.includes('seguranca social') || service.includes('seg_social');
}

function isSegSocialSubUserCredential(entry) {
    if (!isSegSocialCredential(entry)) return false;
    const type = foldText(entry?.credentialType || entry?.credential_type || '');
    return type.includes('subutilizador') || type.includes('subconta') || type.includes('sub-user') || type.includes('sub user') || type === 'sub' || type.includes('sub');
}

function isUsableStatus(entry) {
    const status = foldText(entry?.status || 'active');
    const validUntil = cleanText(entry?.validUntil || entry?.valid_until || '');
    return status !== 'expired' && status !== 'inactive' && status !== 'error' && (!validUntil || validUntil >= todayIsoDate());
}

function isAtCredential(entry) {
    const service = foldText(entry?.service || '');
    return service === 'at' || service.includes('autoridade') || service.includes('financ');
}

function resolveAtCredentialFromCustomer(customer) {
    const credentials = Array.isArray(customer?.accessCredentials) ? customer.accessCredentials : [];
    const atCredential = credentials.find((entry) => isAtCredential(entry) && isUsableStatus(entry)) || null;
    const nif = onlyDigits(customer?.nif || '').slice(-9);
    return {
        username: cleanText(atCredential?.username || nif),
        password: cleanText(atCredential?.password || customer?.senhaFinancas || ''),
        nif,
        source: atCredential ? 'access_credentials' : 'senha_financas',
    };
}

function hasCompleteSegSocialSubUser(customer) {
    const credentials = Array.isArray(customer?.accessCredentials) ? customer.accessCredentials : [];
    return credentials.some((entry) => (
        isSegSocialSubUserCredential(entry) &&
        cleanText(entry?.username) &&
        cleanText(entry?.password) &&
        isUsableStatus(entry)
    ));
}

function isSegSocialPrincipalCredential(entry) {
    if (!isSegSocialCredential(entry)) return false;
    const type = foldText(entry?.credentialType || entry?.credential_type || '');
    return type === 'principal' || (!type && foldText(entry?.service) === 'ss');
}

function pickSaftField(fieldMap, candidates) {
    const source = fieldMap && typeof fieldMap === 'object' ? fieldMap : {};
    for (const candidate of candidates) {
        const target = foldText(candidate);
        if (!target) continue;
        if (Object.prototype.hasOwnProperty.call(source, target)) {
            const exact = cleanText(source[target]);
            if (exact) return exact;
        }
        for (const [key, value] of Object.entries(source)) {
            const foldedKey = foldText(key);
            if (foldedKey === target || foldedKey.includes(target)) {
                const text = cleanText(value);
                if (text) return text;
            }
        }
    }
    return '';
}

function buildSaftCredentialRecord(item) {
    const fields = {
        ...(item?.merged && typeof item.merged === 'object' ? item.merged : {}),
        ...(item?.tabs?.Contas && typeof item.tabs.Contas === 'object' ? item.tabs.Contas : {}),
    };
    const nif = onlyDigits(item?.nif || pickSaftField(fields, ['nif']));
    const ssUser = pickSaftField(fields, ['utilizador ss', 'niss']);
    const ssPassword = pickSaftField(fields, ['senha de utilizador ss', 'senha de acesso ss', 'senha ss']);
    const ssValidUntil = normalizeDateToIso(pickSaftField(fields, [
        'data de validade senha de acesso ss',
        'data validade senha de acesso ss',
        'validade senha de acesso ss',
        'data de validade utilizador ss',
        'validade utilizador ss',
        'validade password ss',
        'validade ss',
    ]));
    return {
        nif,
        name: cleanText(item?.empresa || item?.Nome || item?.nome || ''),
        ssUser: cleanText(ssUser),
        ssPassword: cleanText(ssPassword),
        ssValidUntil,
        detailUrl: cleanText(item?.detailUrl || item?.['URL Ficha'] || ''),
        error: cleanText(item?.error || ''),
    };
}

function runSaftEmpresasExportForNifs({ nifs, headless = true, maxPages = 80, timeoutMs = 30 * 60 * 1000 }) {
    const normalizedNifs = Array.from(new Set((Array.isArray(nifs) ? nifs : []).map(onlyDigits).filter((item) => item.length === 9)));
    if (normalizedNifs.length === 0) {
        return Promise.resolve({ rawPath: '', rows: [] });
    }

    const scriptPath = path.resolve(process.cwd(), 'scripts', 'saft-empresas-export.js');
    if (!fs.existsSync(scriptPath)) {
        return Promise.reject(new Error(`Script SAFT não encontrado: ${scriptPath}`));
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = path.resolve(process.cwd(), 'exports', 'saft-ss-sync');
    fs.mkdirSync(outDir, { recursive: true });
    const basePath = path.join(outDir, `saft_ss_sync_${stamp}`);
    const rawPath = `${basePath}.raw.json`;
    const args = [
        scriptPath,
        '--out-raw',
        rawPath,
        '--out-csv',
        `${basePath}.csv`,
        '--out-xlsx',
        `${basePath}.xlsx`,
        '--nifs',
        normalizedNifs.join(','),
        '--headless',
        headless ? 'true' : 'false',
        '--max-pages',
        String(maxPages),
    ];

    return new Promise((resolve, reject) => {
        const child = spawn('node', args, {
            cwd: process.cwd(),
            env: {
                ...process.env,
                SAFT_HEADLESS: headless ? 'true' : 'false',
            },
        });
        let stdout = '';
        let stderr = '';
        let killedByTimeout = false;
        const timer = setTimeout(() => {
            killedByTimeout = true;
            child.kill('SIGTERM');
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += String(chunk || '');
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk || '');
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (killedByTimeout) {
                reject(new Error('Exportação SAFT excedeu o tempo limite.'));
                return;
            }
            if (code !== 0) {
                reject(new Error(cleanText(stderr) || cleanText(stdout) || `Exportação SAFT terminou com código ${code}`));
                return;
            }
            try {
                const rows = fs.existsSync(rawPath) ? JSON.parse(fs.readFileSync(rawPath, 'utf8')) : [];
                resolve({ rawPath, rows: Array.isArray(rows) ? rows : [] });
            } catch (error) {
                reject(error);
            }
        });
    });
}

function upsertPrincipalSegSocialCredential(credentials, { ssUser, ssPassword, ssValidUntil }) {
    const nextCredentials = Array.isArray(credentials) ? credentials.map((entry) => ({ ...entry })) : [];
    const index = nextCredentials.findIndex(isSegSocialPrincipalCredential);
    const base = index >= 0 ? nextCredentials[index] : {};
    const nextValidUntil = cleanText(ssValidUntil || base.validUntil || base.valid_until || '');
    const next = {
        ...base,
        service: cleanText(base.service) || 'SS',
        credentialType: cleanText(base.credentialType || base.credential_type) || 'principal',
        username: cleanText(ssUser || base.username || ''),
        password: cleanText(ssPassword || base.password || ''),
        emailAssociado: cleanText(base.emailAssociado || base.email_associado || ''),
        validFrom: cleanText(base.validFrom || base.valid_from || ''),
        validUntil: nextValidUntil,
        status: 'active',
        observacoes: `Atualizado a partir do SAFTonline em ${todayIsoDate()}.`,
    };
    if (index >= 0) {
        nextCredentials[index] = next;
    } else {
        nextCredentials.unshift(next);
    }
    return nextCredentials;
}

function registerSaftCustomerSyncRoutes(context, helpers) {
    const {
        app, dbGetAsync, dbAllAsync, parseSourceId, sanitizeRoleValue, upsertLocalUser,
        writeAuditLog, parseCustomerSourceId, getLocalCustomerById,
        upsertLocalCustomer, fetchSupabaseTableColumns,
        SUPABASE_CLIENTS_SOURCE,
    } = context;
    const {
        deleteUserWithSafety, hasSupabaseCustomersSync,
        getLocalCustomerBySourceId, findSupabaseCustomerRow,
        normalizeSupabaseTimestamp, materializeSupabaseRowLocally,
        pushLocalCustomerToSupabase, syncBidirectionalCustomerLinksLocal,
        pullCustomersFromSupabaseIncremental, resolveSupabaseCustomerColumns,
        bumpCustomersSyncWatermark, buildSupabaseCustomerPayloadFromLocal,
        syncLocalCustomerCredentialsToSupabase,
        splitSelectorList, resolveAtCredentialForAutologin,
        launchFinancasBrowserWithFallback, activateFinancasNifTab,
        findFirstVisibleSelector, clickContinueLoginIf2faPrompt,
        resolveSsCredentialForAutologin, clickCookieConsentIfPresent,
        openSegSocialLoginEntryIfNeeded, ensureSegSocialCredentialsFormVisible,
        clickContinueWithoutActivatingIfPrompt,
        isFinancasAutologinRunningRef,
    } = helpers;

    /* --- replace isFinancasAutologinRunning with ref --- */
    const isFinancasAutologinRunning_get = () => isFinancasAutologinRunningRef.value;
    const isFinancasAutologinRunning_set = (v) => { isFinancasAutologinRunningRef.value = v; };

    app.post('/api/users/sync', async (req, res) => {
        const body = req.body || {};
        const userId = String(body.id || '').trim();
        const sourceId = String(body.sourceId || '').trim() || parseSourceId(userId, '');
        const previousEmail = String(body.previousEmail || '').trim().toLowerCase();
        const nextEmail = String(body.email || '').trim().toLowerCase();
        const nextName = String(body.name || '').trim();
        const nextRole = sanitizeRoleValue(body.role);
        const nextPassword =
            body.password === undefined || body.password === null ? undefined : String(body.password).trim();
        const nextAvatarUrl = String(body.avatarUrl || '').trim();
        const nextIsAiAssistant =
            body.isAiAssistant === undefined || body.isAiAssistant === null
                ? undefined
                : !!body.isAiAssistant;
        const nextAiAllowedSites = Array.isArray(body.aiAllowedSites)
            ? body.aiAllowedSites.map((site) => String(site || '').trim()).filter(Boolean)
            : undefined;
        const shouldDelete = body.delete === true || String(body.delete || '').trim().toLowerCase() === 'true';
    
        if (!userId && !sourceId && !previousEmail && !nextEmail) {
            return res.status(400).json({
                success: false,
                error: 'Informe id/sourceId ou email para atualizar funcionário local.',
            });
        }
    
        try {
            if (shouldDelete) {
                const deletion = await deleteUserWithSafety({
                    targetUserId: userId,
                    actorUserId: String(body.actorUserId || '').trim(),
                });
                if (!deletion.ok) {
                    return res.status(deletion.status || 400).json({
                        success: false,
                        error: deletion.error || 'Falha ao eliminar funcionário.',
                        refs: deletion.refs || undefined,
                    });
                }
                return res.json({
                    success: true,
                    storage: 'sqlite_local',
                    deletedUserId: deletion.deletedUserId,
                });
            }

            const normalized = await upsertLocalUser({
                id: userId,
                sourceId,
                email: nextEmail || previousEmail,
                name: nextName,
                role: nextRole,
                password: nextPassword,
                avatarUrl: nextAvatarUrl,
                isAiAssistant: nextIsAiAssistant,
                aiAllowedSites: nextAiAllowedSites,
            });
    
            if (!normalized) {
                return res.status(500).json({
                    success: false,
                    error: 'Não foi possível guardar funcionário no SQLite local.',
                });
            }
    
            await writeAuditLog({
                actorUserId: body.actorUserId || userId || null,
                entityType: 'user',
                entityId: normalized.id,
                action: 'upsert',
                details: {
                    email: normalized.email,
                    role: normalized.role,
                    isAiAssistant: !!normalized.isAiAssistant,
                    aiAllowedSitesCount: Array.isArray(normalized.aiAllowedSites) ? normalized.aiAllowedSites.length : 0,
                },
            });
    
            return res.json({
                success: true,
                storage: 'sqlite_local',
                user: normalized,
            });
            
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao atualizar funcionário:', details);
            return res.status(500).json({
                success: false,
                error: details,
            });
        }
    });

    app.post('/api/users/:id/delete', async (req, res) => {
        try {
            const deletion = await deleteUserWithSafety({
                targetUserId: String(req.params.id || '').trim(),
                actorUserId: String(req.body?.actorUserId || '').trim(),
            });
            if (!deletion.ok) {
                return res.status(deletion.status || 400).json({
                    success: false,
                    error: deletion.error || 'Falha ao eliminar funcionário.',
                    refs: deletion.refs || undefined,
                });
            }

            return res.json({ success: true, deletedUserId: deletion.deletedUserId });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao eliminar funcionário:', details);
            return res.status(500).json({
                success: false,
                error: details,
            });
        }
    });
    
    app.post('/api/customers/sync', async (req, res) => {
        const body = req.body || {};
        const customerId = String(body.id || '').trim();
        const sourceId = String(body.sourceId || '').trim() || parseCustomerSourceId(customerId, '');
        const syncToSupabase = body.syncToSupabase !== false;
        const forceLocalToSupabase = body.forceLocalToSupabase === true || body.forceLocalToSupabase === 'true';
    
        try {
            let conflictResolvedBySupabase = false;
            let warnings = [];
            let supabaseRow = null;
            let tableColumns = [];
            let columnsMeta = {};

            const existingLocalRow =
                (customerId ? await dbGetAsync('SELECT * FROM customers WHERE id = ? LIMIT 1', [customerId]) : null) ||
                (sourceId ? await getLocalCustomerBySourceId(sourceId) : null);
            const existingLocalCustomer =
                existingLocalRow?.id ? await getLocalCustomerById(String(existingLocalRow.id || '').trim()) : null;

            if (syncToSupabase && hasSupabaseCustomersSync()) {
                tableColumns = await fetchSupabaseTableColumns(SUPABASE_CLIENTS_SOURCE);
                const supabaseMatch = await findSupabaseCustomerRow({
                    columns: tableColumns,
                    sourceId,
                    nif: body.nif,
                    phone: body.phone,
                    email: body.email,
                });
                supabaseRow = supabaseMatch.row;
                columnsMeta = supabaseMatch.columnsMeta || {};

                if (supabaseRow && columnsMeta.updatedAtColumn) {
                    const remoteUpdatedAt = normalizeSupabaseTimestamp(supabaseRow[columnsMeta.updatedAtColumn]);
                    const localKnownSupabaseAt = normalizeSupabaseTimestamp(existingLocalRow?.supabase_updated_at);
                    if (
                        !forceLocalToSupabase &&
                        remoteUpdatedAt &&
                        localKnownSupabaseAt &&
                        new Date(remoteUpdatedAt).getTime() > new Date(localKnownSupabaseAt).getTime()
                    ) {
                        const canonical = await materializeSupabaseRowLocally(
                            supabaseRow,
                            customerId || String(existingLocalRow?.id || '').trim()
                        );
                        conflictResolvedBySupabase = true;
                        warnings.push('Conflito detetado: mantida a versão do Supabase.');
                        return res.json({
                            success: true,
                            storage: 'sqlite_local',
                            syncedToSupabase: syncToSupabase && hasSupabaseCustomersSync(),
                            conflictResolvedBySupabase,
                            warnings,
                            customer: canonical,
                        });
                    }
                }
            }

            const normalized = await upsertLocalCustomer({
                id: customerId,
                sourceId,
                name: body.name,
                contactName: body.contactName ?? body.contact_name,
                company: body.company,
                phone: body.phone,
                email: body.email,
                documentsFolder: body.documentsFolder,
                nif: body.nif,
                niss: body.niss,
                senhaFinancas: body.senhaFinancas,
                senhaSegurancaSocial: body.senhaSegurancaSocial,
                tipoIva: body.tipoIva,
                morada: body.morada,
                notes: body.notes,
                certidaoPermanenteNumero: body.certidaoPermanenteNumero,
                certidaoPermanenteValidade: body.certidaoPermanenteValidade,
                rcbeNumero: body.rcbeNumero,
                rcbeData: body.rcbeData,
                dataConstituicao: body.dataConstituicao,
                inicioAtividade: body.inicioAtividade,
                caePrincipal: body.caePrincipal,
                codigoReparticaoFinancas: body.codigoReparticaoFinancas,
                tipoContabilidade: body.tipoContabilidade,
                estadoCliente: body.estadoCliente,
                contabilistaCertificado: body.contabilistaCertificado,
                managers: body.managers,
                accessCredentials: body.accessCredentials,
                agregadoFamiliar: body.agregadoFamiliar,
                fichasRelacionadas: body.fichasRelacionadas,
                ownerId: body.ownerId,
                type: body.type,
                contacts: body.contacts,
                allowAutoResponses: body.allowAutoResponses,
            });
    
            if (!normalized) {
                return res.status(500).json({
                    success: false,
                    error: 'Não foi possível guardar cliente no SQLite local.',
                });
            }

            let canonicalCustomer = normalized;
            if (syncToSupabase && hasSupabaseCustomersSync()) {
                const pushMain = await pushLocalCustomerToSupabase(normalized, tableColumns);
                canonicalCustomer = pushMain.customer || normalized;
                if (Array.isArray(pushMain.warnings) && pushMain.warnings.length > 0) {
                    warnings.push(...pushMain.warnings);
                }
            }

            const mirrorSyncSummary = await syncBidirectionalCustomerLinksLocal({
                beforeCustomer: existingLocalCustomer,
                afterCustomer: canonicalCustomer || normalized,
            });
            if (mirrorSyncSummary.changed > 0) {
                warnings.push(`Relações bidirecionais atualizadas em ${mirrorSyncSummary.changed} ficha(s).`);
            }

            if (
                syncToSupabase &&
                hasSupabaseCustomersSync() &&
                Array.isArray(mirrorSyncSummary.updatedCustomers) &&
                mirrorSyncSummary.updatedCustomers.length > 0
            ) {
                for (const mirroredCustomer of mirrorSyncSummary.updatedCustomers) {
                    const mirroredPush = await pushLocalCustomerToSupabase(mirroredCustomer, tableColumns);
                    if (Array.isArray(mirroredPush.warnings) && mirroredPush.warnings.length > 0) {
                        const mirrorLabel = String(mirroredCustomer?.company || mirroredCustomer?.name || mirroredCustomer?.id || 'ficha relacionada').trim();
                        warnings.push(...mirroredPush.warnings.map((item) => `[${mirrorLabel}] ${item}`));
                    }
                }
            }

            await writeAuditLog({
                actorUserId: body.actorUserId || canonicalCustomer?.ownerId || normalized.ownerId || null,
                entityType: 'customer',
                entityId: canonicalCustomer?.id || normalized.id,
                action: 'upsert',
                details: {
                    name: canonicalCustomer?.name || normalized.name,
                    phone: canonicalCustomer?.phone || normalized.phone,
                    documentsFolder: canonicalCustomer?.documentsFolder || normalized.documentsFolder || null,
                    nif: canonicalCustomer?.nif || normalized.nif || null,
                    niss: canonicalCustomer?.niss || normalized.niss || null,
                    tipoIva: canonicalCustomer?.tipoIva || normalized.tipoIva || null,
                    morada: canonicalCustomer?.morada || normalized.morada || null,
                    ownerId: canonicalCustomer?.ownerId || normalized.ownerId,
                    mirroredRelationsUpdated: mirrorSyncSummary.changed,
                    conflictResolvedBySupabase,
                    forceLocalToSupabase,
                    warnings,
                },
            });
    
            return res.json({
                success: true,
                storage: 'sqlite_local',
                syncedToSupabase: syncToSupabase && hasSupabaseCustomersSync(),
                conflictResolvedBySupabase,
                warnings,
                customer: canonicalCustomer || normalized,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SQLite] Erro ao atualizar cliente:', details);
            return res.status(500).json({
                success: false,
                error: details,
            });
        }
    });

    app.post('/api/customers/sync/saft-ss-passwords', async (req, res) => {
        const body = req.body || {};
        const requestedCustomerId = String(body.customerId || '').trim();
        const actorUserId = String(body.actorUserId || '').trim() || null;
        const syncToSupabase = body.syncToSupabase !== false;
        const headless = body.headless !== false;
        const maxPages = Math.max(1, Math.min(200, Number(body.maxPages || process.env.SAFT_EMPRESAS_MAX_PAGES || 80) || 80));

        const summary = {
            requested: 0,
            eligible: 0,
            skippedWithSubuser: 0,
            skippedNonEnterprise: 0,
            skippedNoNif: 0,
            skippedNoSaftMatch: 0,
            skippedNoSegSocialPassword: 0,
            unchanged: 0,
            updated: 0,
            errors: [],
            warnings: [],
            updatedCustomers: [],
            rawPath: '',
        };
        const responseCustomers = [];

        try {
            let customers = [];
            if (requestedCustomerId) {
                const customer = await getLocalCustomerById(requestedCustomerId);
                if (!customer) {
                    return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
                }
                customers = [customer];
            } else {
                const rows = await dbAllAsync('SELECT id FROM customers ORDER BY COALESCE(company, name, nif, id)');
                customers = [];
                for (const row of rows || []) {
                    const customer = await getLocalCustomerById(String(row?.id || '').trim());
                    if (customer) customers.push(customer);
                }
            }

            summary.requested = customers.length;
            const eligibleCustomers = [];
            const nifs = [];

            customers.forEach((customer) => {
                const type = foldText(customer?.type || '');
                const nif = onlyDigits(customer?.nif || '');
                if (type && type !== 'empresa') {
                    summary.skippedNonEnterprise += 1;
                    return;
                }
                if (hasCompleteSegSocialSubUser(customer)) {
                    summary.skippedWithSubuser += 1;
                    return;
                }
                if (nif.length !== 9) {
                    summary.skippedNoNif += 1;
                    return;
                }
                eligibleCustomers.push(customer);
                nifs.push(nif);
            });

            summary.eligible = eligibleCustomers.length;
            if (eligibleCustomers.length === 0) {
                return res.json({
                    success: true,
                    message: 'Não há clientes elegíveis para atualizar a senha SS a partir do SAFTonline.',
                    summary,
                });
            }

            console.log(`[SAFT SS Sync] A exportar dados SAFT para ${nifs.length} NIF(s).`);
            const exportResult = await runSaftEmpresasExportForNifs({ nifs, headless, maxPages });
            summary.rawPath = exportResult.rawPath || '';
            const saftByNif = new Map();
            (exportResult.rows || []).forEach((item) => {
                const record = buildSaftCredentialRecord(item);
                if (record.nif) saftByNif.set(record.nif, record);
            });

            let tableColumns = [];
            if (syncToSupabase && hasSupabaseCustomersSync()) {
                try {
                    tableColumns = await fetchSupabaseTableColumns(SUPABASE_CLIENTS_SOURCE);
                } catch (error) {
                    summary.warnings.push(`Supabase não sincronizado: falha ao ler colunas (${error?.message || error}).`);
                }
            }

            for (const customer of eligibleCustomers) {
                const nif = onlyDigits(customer?.nif || '');
                const record = saftByNif.get(nif);
                const label = cleanText(customer?.company || customer?.name || nif || customer?.id);
                if (!record) {
                    summary.skippedNoSaftMatch += 1;
                    continue;
                }
                if (record.error) {
                    summary.errors.push(`${label}: erro na ficha SAFT (${record.error}).`);
                    continue;
                }
                if (!record.ssPassword) {
                    summary.skippedNoSegSocialPassword += 1;
                    continue;
                }

                const currentCredentials = Array.isArray(customer.accessCredentials) ? customer.accessCredentials : [];
                const currentPrincipal = currentCredentials.find(isSegSocialPrincipalCredential) || {};
                const currentUsername = cleanText(currentPrincipal.username || customer.niss || '');
                const currentPassword = cleanText(currentPrincipal.password || customer.senhaSegurancaSocial || '');
                const currentValidUntil = normalizeDateToIso(currentPrincipal.validUntil || '');
                const nextUsername = cleanText(record.ssUser || currentUsername);
                const nextValidUntil = cleanText(record.ssValidUntil || '');
                const nextCredentials = upsertPrincipalSegSocialCredential(currentCredentials, {
                    ssUser: nextUsername,
                    ssPassword: record.ssPassword,
                    ssValidUntil: nextValidUntil,
                });

                const hasPrincipalCredential = currentCredentials.some(isSegSocialPrincipalCredential);
                const unchanged =
                    hasPrincipalCredential &&
                    currentUsername === nextUsername &&
                    currentPassword === record.ssPassword &&
                    currentValidUntil === nextValidUntil &&
                    cleanText(customer.senhaSegurancaSocial || '') === record.ssPassword;

                if (unchanged) {
                    summary.unchanged += 1;
                    if (requestedCustomerId) {
                        responseCustomers.push(customer);
                    }
                    continue;
                }

                const saved = await upsertLocalCustomer({
                    id: customer.id,
                    niss: nextUsername || customer.niss || '',
                    senhaSegurancaSocial: record.ssPassword,
                    accessCredentials: nextCredentials,
                });

                let canonical = saved;
                if (syncToSupabase && hasSupabaseCustomersSync() && tableColumns.length > 0) {
                    try {
                        const pushed = await pushLocalCustomerToSupabase(saved, tableColumns);
                        canonical = pushed.customer || saved;
                        if (Array.isArray(pushed.warnings) && pushed.warnings.length > 0) {
                            summary.warnings.push(...pushed.warnings.map((warning) => `${label}: ${warning}`));
                        }
                        const credentialWarnings = await syncLocalCustomerCredentialsToSupabase(
                            canonical || saved,
                            parseCustomerSourceId((canonical || saved)?.id || '', (canonical || saved)?.sourceId || '')
                        );
                        if (Array.isArray(credentialWarnings) && credentialWarnings.length > 0) {
                            summary.warnings.push(...credentialWarnings.map((warning) => `${label}: ${warning}`));
                        }
                    } catch (error) {
                        summary.warnings.push(`${label}: guardado localmente, mas falhou sincronização Supabase (${error?.message || error}).`);
                    }
                }

                // A resposta materializada do Supabase pode vir sem a validade SS
                // quando a tabela remota só tem campos escalares antigos. Reaplicamos
                // a credencial lida do SAFT no SQLite para a ficha ficar correta.
                const canonicalCredentials = Array.isArray(canonical?.accessCredentials)
                    ? canonical.accessCredentials
                    : nextCredentials;
                const finalCredentials = upsertPrincipalSegSocialCredential(canonicalCredentials, {
                    ssUser: nextUsername,
                    ssPassword: record.ssPassword,
                    ssValidUntil: nextValidUntil,
                });
                canonical = await upsertLocalCustomer({
                    id: saved?.id || customer.id,
                    niss: nextUsername || customer.niss || '',
                    senhaSegurancaSocial: record.ssPassword,
                    accessCredentials: finalCredentials,
                }) || canonical || saved;

                if (syncToSupabase && hasSupabaseCustomersSync()) {
                    try {
                        const credentialWarnings = await syncLocalCustomerCredentialsToSupabase(
                            canonical,
                            parseCustomerSourceId(canonical?.id || saved?.id || customer.id, canonical?.sourceId || '')
                        );
                        if (Array.isArray(credentialWarnings) && credentialWarnings.length > 0) {
                            summary.warnings.push(...credentialWarnings.map((warning) => `${label}: ${warning}`));
                        }
                    } catch (error) {
                        summary.warnings.push(`${label}: validade SS guardada localmente, mas falhou sincronização das credenciais (${error?.message || error}).`);
                    }
                }

                summary.updated += 1;
                summary.updatedCustomers.push({
                    id: canonical?.id || saved?.id || customer.id,
                    name: cleanText(canonical?.company || canonical?.name || label),
                    nif,
                    niss: nextUsername,
                    validUntil: nextValidUntil,
                });
                if (canonical) responseCustomers.push(canonical);

                await writeAuditLog({
                    actorUserId,
                    entityType: 'customer',
                    entityId: canonical?.id || saved?.id || customer.id,
                    action: 'saft_ss_password_sync',
                    details: {
                        nif,
                        niss: nextUsername || null,
                        validUntil: nextValidUntil || null,
                        source: 'saftonline',
                        syncedToSupabase: syncToSupabase && hasSupabaseCustomersSync(),
                    },
                });
            }

            return res.json({
                success: true,
                message: `Atualização concluída: ${summary.updated} cliente(s) atualizado(s), ${summary.unchanged} já estavam iguais.`,
                summary,
                customers: responseCustomers,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SAFT SS Sync] Erro:', details);
            return res.status(500).json({
                success: false,
                error: details,
                summary,
            });
        }
    });

    app.post('/api/customers/sync/pull', async (req, res) => {
        const body = req.body || {};
        const full = !!body.full;
        const limit = Number(body.limit || 5000);
        try {
            if (!hasSupabaseCustomersSync()) {
                return res.status(400).json({
                    success: false,
                    error: 'Supabase não configurado para clientes.',
                });
            }
            const result = await pullCustomersFromSupabaseIncremental({ full, limit });
            return res.json({
                success: true,
                ...result,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Sync] Erro no pull incremental de clientes:', details);
            return res.status(500).json({
                success: false,
                error: details,
            });
        }
    });

    app.post('/api/customers/:id/update-from-at', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const body = req.body || {};
        const actorUserId = String(body.actorUserId || '').trim() || null;
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }
        if (isFinancasAutologinRunning_get()) {
            return res.status(409).json({
                success: false,
                error: 'Já existe uma recolha AT em execução. Aguarde alguns segundos e tente novamente.',
            });
        }

        isFinancasAutologinRunning_set(true);
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }
            const credentials = resolveAtCredentialFromCustomer(customer);
            if (!credentials.username || !credentials.password) {
                return res.status(400).json({ success: false, error: 'Este cliente não tem utilizador/senha AT completos na ficha.' });
            }

            const collected = await collectFinancasAtProfileInOracle(credentials, {
                timeoutMs: Number(body.timeoutMs || process.env.PORTAL_FINANCAS_TIMEOUT_MS || 120000) || 120000,
                profileCollectTimeoutMs: Number(body.profileCollectTimeoutMs || 45000) || 45000,
                headless: body.headless !== false,
            });
            const fields = collected?.fields && typeof collected.fields === 'object' ? collected.fields : {};
            const updates = {};
            ['morada', 'codigoPostal', 'dataNascimento', 'inicioAtividade', 'tipoIva', 'caePrincipal', 'codigoReparticaoFinancas'].forEach((key) => {
                const value = cleanText(fields[key]);
                if (value) updates[key] = value;
            });

            if (Object.keys(updates).length === 0) {
                return res.status(422).json({
                    success: false,
                    error: collected?.message || 'Login AT feito no Oracle, mas não encontrei dados fiscais para atualizar.',
                    sourceUrl: collected?.sourceUrl || '',
                    attempts: collected?.attempts || [],
                });
            }

            const saved = await upsertLocalCustomer({
                ...customer,
                ...updates,
                id: customer.id,
                sourceId: customer.sourceId,
            });
            let supabase = null;
            if (hasSupabaseCustomersSync()) {
                try {
                    const tableColumns = await fetchSupabaseTableColumns(SUPABASE_CLIENTS_SOURCE).catch(() => []);
                    supabase = await pushLocalCustomerToSupabase(saved, tableColumns);
                } catch (syncError) {
                    supabase = { success: false, warning: String(syncError?.message || syncError) };
                }
            }

            if (actorUserId) {
                await writeAuditLog({
                    actorUserId,
                    entityType: 'customer',
                    entityId: customer.id,
                    action: 'update_from_at',
                    details: { fields: updates, sourceUrl: collected?.sourceUrl || '' },
                }).catch(() => null);
            }

            return res.json({
                success: true,
                fields: updates,
                customer: saved,
                sourceUrl: collected?.sourceUrl || '',
                message: `Dados AT atualizados (${Object.keys(updates).length} campo(s)).`,
                supabase,
            });
        } catch (error) {
            const details = String(error?.message || error || 'Falha ao recolher dados da AT no Oracle.');
            console.error('[AT Profile] Erro na recolha Oracle:', details);
            return res.status(500).json({ success: false, error: details });
        } finally {
            isFinancasAutologinRunning_set(false);
        }
    });

    app.post('/api/customers/:id/autologin/financas', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const body = req.body || {};
        const actorUserId = String(body.actorUserId || '').trim() || null;

        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }
        if (isFinancasAutologinRunning_get()) {
            return res.status(409).json({
                success: false,
                error: 'Já existe um autologin em execução. Aguarde alguns segundos e tente novamente.',
            });
        }

        let playwright = null;
        try {
            playwright = require('playwright');
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: 'Playwright não instalado neste ambiente. Execute: npm i playwright && npx playwright install chromium',
            });
        }

        const loginUrl = String(process.env.PORTAL_FINANCAS_LOGIN_URL || 'https://www.acesso.gov.pt/v2/loginForm?partID=PFAP').trim();
        const targetUrl = String(process.env.PORTAL_FINANCAS_TARGET_URL || '').trim();
        const envHeadless = String(process.env.PORTAL_FINANCAS_HEADLESS || 'false').trim().toLowerCase() === 'true';
        const hasDesktopSession = Boolean(String(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '').trim());
        const bodyHeadless =
            body?.headless === true ? true : body?.headless === false ? false : null;
        const headless = bodyHeadless === null ? (hasDesktopSession ? envHeadless : true) : bodyHeadless;
        const forcedHeadlessByServer = bodyHeadless === null && !hasDesktopSession && !envHeadless;
        if (bodyHeadless === false && !hasDesktopSession) {
            return res.status(409).json({
                success: false,
                code: 'NO_GUI_SESSION',
                error: 'Este servidor não tem sessão gráfica ativa (X11/Wayland), por isso não consegue abrir browser visível aqui.',
                loginUrl,
            });
        }
        const envCloseAfterSubmit =
            String(process.env.PORTAL_FINANCAS_CLOSE_AFTER_SUBMIT || '').trim().toLowerCase() === 'true';
        const bodyCloseAfterSubmit =
            body?.closeAfterSubmit === true ? true : body?.closeAfterSubmit === false ? false : null;
        const closeBrowserAfterSubmit = bodyCloseAfterSubmit === null ? envCloseAfterSubmit : bodyCloseAfterSubmit;
        const timeoutMs = Math.max(
            20000,
            Math.min(180000, Number(process.env.PORTAL_FINANCAS_TIMEOUT_MS || 90000) || 90000)
        );

        const usernameSelectors = splitSelectorList(
            process.env.PORTAL_FINANCAS_USERNAME_SELECTOR,
            'form[name="loginForm"] input[name="username"], input[name="username"], input[placeholder*="Contribuinte"], input[aria-label*="Contribuinte"], input[name="representante"], input[name="nif"], input[type="text"]'
        );
        const passwordSelectors = splitSelectorList(
            process.env.PORTAL_FINANCAS_PASSWORD_SELECTOR,
            'form[name="loginForm"] input[name="password"], input[name="password"], input[placeholder*="Senha"], input[type="password"]'
        );
        const submitSelectors = splitSelectorList(
            process.env.PORTAL_FINANCAS_SUBMIT_SELECTOR,
            'form[name="loginForm"] button[type="submit"], form[name="loginForm"] input[type="submit"], button[type="submit"], input[type="submit"], button:has-text("Autenticar")'
        );
        const successSelectors = splitSelectorList(
            process.env.PORTAL_FINANCAS_SUCCESS_SELECTOR,
            'a[href*="logout"], a[href*="/v2/logout"], [data-testid="logout"], .logout'
        );

        let browser = null;
        let browserLauncherLabel = '';
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const resolvedAt = resolveAtCredentialForAutologin(customer);
            if (!resolvedAt.username || !resolvedAt.password) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem utilizador/senha AT completos na ficha.',
                });
            }

            isFinancasAutologinRunning_set(true);
            const launched = await launchFinancasBrowserWithFallback(playwright, {
                headless,
                args: headless ? [] : ['--start-maximized'],
            });
            browser = launched.browser;
            browserLauncherLabel = String(launched.launcherLabel || '').trim();

            const contextOptions = { acceptDownloads: false };
            if (!headless) {
                contextOptions.viewport = null;
            }
            const context = await browser.newContext(contextOptions);
            const page = await context.newPage();
            page.setDefaultTimeout(timeoutMs);

            await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
            await activateFinancasNifTab(page);

            const usernameSelector = await findFirstVisibleSelector(page, usernameSelectors);
            const passwordSelector = await findFirstVisibleSelector(page, passwordSelectors);
            const submitSelector = await findFirstVisibleSelector(page, submitSelectors);

            if (!usernameSelector || !passwordSelector || !submitSelector) {
                throw new Error('Não foi possível localizar os campos de login da AT. Verifique os seletores configurados.');
            }

            await page.fill(usernameSelector, resolvedAt.username);
            await page.fill(passwordSelector, resolvedAt.password);

            await Promise.allSettled([
                page.waitForLoadState('networkidle', { timeout: Math.min(30000, timeoutMs) }),
                page.locator(submitSelector).first().click(),
            ]);

            await clickContinueLoginIf2faPrompt(page, Math.min(12000, timeoutMs));

            if (targetUrl) {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
            }

            const matchedSuccessSelector = await findFirstVisibleSelector(page, successSelectors);
            const hasPasswordInputAfterSubmit = (await page.locator('input[type="password"]').count()) > 0;
            const loginState = matchedSuccessSelector
                ? 'logged_in'
                : hasPasswordInputAfterSubmit
                    ? 'needs_manual_validation'
                    : 'unknown';

            await writeAuditLog({
                actorUserId,
                entityType: 'customer',
                entityId: customer.id,
                action: 'autologin_financas',
                details: {
                    loginState,
                    headless,
                    browserLauncherLabel: browserLauncherLabel || null,
                    customerNif: resolvedAt.nif || null,
                    usernameMask: resolvedAt.username ? `***${resolvedAt.username.slice(-3)}` : null,
                    source: resolvedAt.source,
                },
            });

            const shouldCloseBrowser = headless || closeBrowserAfterSubmit;
            if (shouldCloseBrowser) {
                await browser.close().catch(() => null);
                browser = null;
            }

            return res.json({
                success: true,
                channel: 'portal_financas',
                headless,
                loginState,
                browserLauncherLabel: browserLauncherLabel || null,
                forcedHeadlessByServer,
                message: shouldCloseBrowser
                    ? 'Autologin executado. Browser fechado automaticamente.'
                    : 'Autologin iniciado. O browser foi aberto neste computador.',
                warning: forcedHeadlessByServer
                    ? 'Servidor sem sessão gráfica ativa: autologin executado em modo headless.'
                    : undefined,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[AT Autologin] Erro:', details);
            if (browser) {
                await browser.close().catch(() => null);
            }
            return res.status(500).json({
                success: false,
                error: details,
            });
        } finally {
            isFinancasAutologinRunning_set(false);
        }
    });

    app.post('/api/customers/:id/autologin/seg-social', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const body = req.body || {};
        const actorUserId = String(body.actorUserId || '').trim() || null;

        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }
        if (isFinancasAutologinRunning_get()) {
            return res.status(409).json({
                success: false,
                error: 'Já existe um autologin em execução. Aguarde alguns segundos e tente novamente.',
            });
        }

        let playwright = null;
        try {
            playwright = require('playwright');
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: 'Playwright não instalado neste ambiente. Execute: npm i playwright && npx playwright install chromium',
            });
        }

        const loginUrl = String(
            process.env.PORTAL_SEG_SOCIAL_LOGIN_URL || 'https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin'
        ).trim();
        const targetUrl = String(process.env.PORTAL_SEG_SOCIAL_TARGET_URL || '').trim();
        const envHeadless = String(process.env.PORTAL_SEG_SOCIAL_HEADLESS || 'false').trim().toLowerCase() === 'true';
        const hasDesktopSession = Boolean(String(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '').trim());
        const bodyHeadless =
            body?.headless === true ? true : body?.headless === false ? false : null;
        const headless = bodyHeadless === null ? (hasDesktopSession ? envHeadless : true) : bodyHeadless;
        const forcedHeadlessByServer = bodyHeadless === null && !hasDesktopSession && !envHeadless;
        if (bodyHeadless === false && !hasDesktopSession) {
            return res.status(409).json({
                success: false,
                code: 'NO_GUI_SESSION',
                error: 'Este servidor não tem sessão gráfica ativa (X11/Wayland), por isso não consegue abrir browser visível aqui.',
                loginUrl,
            });
        }
        const envCloseAfterSubmit =
            String(process.env.PORTAL_SEG_SOCIAL_CLOSE_AFTER_SUBMIT || '').trim().toLowerCase() === 'true';
        const bodyCloseAfterSubmit =
            body?.closeAfterSubmit === true ? true : body?.closeAfterSubmit === false ? false : null;
        const closeBrowserAfterSubmit = bodyCloseAfterSubmit === null ? envCloseAfterSubmit : bodyCloseAfterSubmit;
        const timeoutMs = Math.max(
            20000,
            Math.min(180000, Number(process.env.PORTAL_SEG_SOCIAL_TIMEOUT_MS || 90000) || 90000)
        );

        const usernameSelectors = splitSelectorList(
            process.env.PORTAL_SEG_SOCIAL_USERNAME_SELECTOR,
            'input[name="username"], input[name="niss"], input[id*="username" i], input[name*="user" i], input[id*="utilizador" i], input[name*="utilizador" i], input[id*="niss" i], input[placeholder*="NISS" i], input[autocomplete="username"]'
        );
        const passwordSelectors = splitSelectorList(
            process.env.PORTAL_SEG_SOCIAL_PASSWORD_SELECTOR,
            'input[name="password"], input[id*="password" i], input[placeholder*="senha" i], input[type="password"]'
        );
        const submitSelectors = splitSelectorList(
            process.env.PORTAL_SEG_SOCIAL_SUBMIT_SELECTOR,
            'button[type="submit"], input[type="submit"], button:has-text("Entrar"), button:has-text("Iniciar sessão"), button:has-text("Autenticar"), button:has-text("Continuar")'
        );
        const successSelectors = splitSelectorList(
            process.env.PORTAL_SEG_SOCIAL_SUCCESS_SELECTOR,
            'a[href*="logout"], a[href*="sair"], button:has-text("Terminar sessão"), button:has-text("Sair"), [data-testid*="logout"]'
        );

        let browser = null;
        let browserLauncherLabel = '';
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const resolvedSs = resolveSsCredentialForAutologin(customer);
            if (!resolvedSs.username || !resolvedSs.password) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem utilizador/senha SS Direta completos na ficha.',
                });
            }

            isFinancasAutologinRunning_set(true);
            const launched = await launchFinancasBrowserWithFallback(playwright, {
                headless,
                args: headless ? [] : ['--start-maximized'],
                browserExecutablePath: String(process.env.PORTAL_SEG_SOCIAL_BROWSER_EXECUTABLE || '').trim() || undefined,
            });
            browser = launched.browser;
            browserLauncherLabel = String(launched.launcherLabel || '').trim();

            const contextOptions = { acceptDownloads: false };
            if (!headless) {
                contextOptions.viewport = null;
            }
            const context = await browser.newContext(contextOptions);
            const page = await context.newPage();
            page.setDefaultTimeout(timeoutMs);

            await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
            await clickCookieConsentIfPresent(page, 2500);
            await openSegSocialLoginEntryIfNeeded(page, Math.min(12000, timeoutMs));
            await ensureSegSocialCredentialsFormVisible(page, Math.min(12000, timeoutMs));

            const usernameSelector = await findFirstVisibleSelector(page, usernameSelectors);
            const passwordSelector = await findFirstVisibleSelector(page, passwordSelectors);
            const submitSelector = await findFirstVisibleSelector(page, submitSelectors);

            if (!usernameSelector || !passwordSelector || !submitSelector) {
                throw new Error('Não foi possível localizar os campos de login da SS Direta. Verifique os seletores configurados.');
            }

            await page.fill(usernameSelector, resolvedSs.username);
            await page.fill(passwordSelector, resolvedSs.password);

            await Promise.allSettled([
                page.waitForLoadState('networkidle', { timeout: Math.min(30000, timeoutMs) }),
                page.locator(submitSelector).first().click(),
            ]);

            await clickContinueLoginIf2faPrompt(page, Math.min(12000, timeoutMs));
            await clickContinueWithoutActivatingIfPrompt(page, Math.min(18000, timeoutMs));

            if (targetUrl) {
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
            }

            const matchedSuccessSelector = await findFirstVisibleSelector(page, successSelectors);
            const hasPasswordInputAfterSubmit = (await page.locator('input[type="password"]').count()) > 0;
            const loginState = matchedSuccessSelector
                ? 'logged_in'
                : hasPasswordInputAfterSubmit
                    ? 'needs_manual_validation'
                    : 'unknown';

            await writeAuditLog({
                actorUserId,
                entityType: 'customer',
                entityId: customer.id,
                action: 'autologin_seg_social',
                details: {
                    loginState,
                    headless,
                    browserLauncherLabel: browserLauncherLabel || null,
                    customerNiss: resolvedSs.niss || null,
                    usernameMask: resolvedSs.username ? `***${resolvedSs.username.slice(-3)}` : null,
                    source: resolvedSs.source,
                },
            });

            const shouldCloseBrowser = headless || closeBrowserAfterSubmit;
            if (shouldCloseBrowser) {
                await browser.close().catch(() => null);
                browser = null;
            }

            return res.json({
                success: true,
                channel: 'seguranca_social_direta',
                headless,
                loginState,
                browserLauncherLabel: browserLauncherLabel || null,
                forcedHeadlessByServer,
                message: shouldCloseBrowser
                    ? 'Autologin executado. Browser fechado automaticamente.'
                    : 'Autologin iniciado. O browser foi aberto neste computador.',
                warning: forcedHeadlessByServer
                    ? 'Servidor sem sessão gráfica ativa: autologin executado em modo headless.'
                    : undefined,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SS Autologin] Erro:', details);
            if (browser) {
                await browser.close().catch(() => null);
            }
            return res.status(500).json({
                success: false,
                error: details,
            });
        } finally {
            isFinancasAutologinRunning_set(false);
        }
    });

    app.post('/api/customers/:id/seg-social/subuser/setup', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const body = req.body || {};
        const actorUserId = String(body.actorUserId || '').trim() || null;

        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }
        if (isFinancasAutologinRunning_get()) {
            return res.status(409).json({
                success: false,
                error: 'Já existe uma automação em execução. Aguarde alguns segundos e tente novamente.',
            });
        }

        let playwright = null;
        try {
            playwright = require('playwright');
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: 'Playwright não instalado neste ambiente. Execute: npm i playwright && npx playwright install chromium',
            });
        }

        const normalizeText = (value) => String(value || '')
            .trim()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
        const todayIso = () => new Date().toISOString().slice(0, 10);
        const addMonthsIso = (months) => {
            const date = new Date();
            date.setMonth(date.getMonth() + months);
            return date.toISOString().slice(0, 10);
        };
        const todayPt = () => {
            const [year, month, day] = todayIso().split('-');
            return `${day}/${month}/${year}`;
        };
        const isSegSocialCredential = (entry) => {
            const service = normalizeText(entry?.service);
            return service === 'ss' || service.includes('seguranca social') || service.includes('seg_social');
        };
        const isPrincipalCredential = (entry) => {
            const credentialType = normalizeText(entry?.credentialType || entry?.credential_type);
            return isSegSocialCredential(entry) && (credentialType === 'principal' || (!credentialType && !normalizeText(entry?.status).includes('sub')));
        };
        const randomPassword = () => {
            const crypto = require('crypto');
            const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
            const suffix = Array.from(crypto.randomBytes(8))
                .map((byte) => alphabet[byte % alphabet.length])
                .join('');
            return `Mpr${new Date().getFullYear()}!${suffix}`;
        };
        const upsertCredential = (credentials, next) => {
            const normalizedType = normalizeText(next.credentialType);
            const normalizedService = normalizeText(next.service);
            const normalizedEmail = normalizeText(next.emailAssociado);
            const normalizedUsername = normalizeText(next.username);
            const index = credentials.findIndex((entry) => (
                normalizeText(entry?.service) === normalizedService &&
                normalizeText(entry?.credentialType || entry?.credential_type) === normalizedType &&
                (
                    (normalizedEmail && normalizeText(entry?.emailAssociado || entry?.email_associado) === normalizedEmail) ||
                    (normalizedUsername && normalizeText(entry?.username) === normalizedUsername)
                )
            ));
            if (index >= 0) {
                credentials[index] = { ...credentials[index], ...next };
            } else {
                credentials.push(next);
            }
            return credentials;
        };
        const clickFirst = async (page, builders, timeoutMs = 2500) => {
            for (const build of builders) {
                try {
                    const locator = build().first();
                    if ((await locator.count()) <= 0) continue;
                    const visible = await locator.isVisible().catch(() => false);
                    if (!visible) continue;
                    await locator.click({ timeout: timeoutMs });
                    await page.waitForTimeout(700);
                    return true;
                } catch (error) {
                    // tenta próximo candidato
                }
            }
            return false;
        };
        const fillFirst = async (page, builders, value) => {
            for (const build of builders) {
                try {
                    const locator = build().first();
                    if ((await locator.count()) <= 0) continue;
                    const visible = await locator.isVisible().catch(() => false);
                    if (!visible) continue;
                    await locator.fill(String(value || ''), { timeout: 2500 });
                    return true;
                } catch (error) {
                    // tenta próximo candidato
                }
            }
            return false;
        };

        const loginUrl = String(
            process.env.PORTAL_SEG_SOCIAL_LOGIN_URL || 'https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin'
        ).trim();
        const envHeadless = String(process.env.PORTAL_SEG_SOCIAL_HEADLESS || 'false').trim().toLowerCase() === 'true';
        const hasDesktopSession = Boolean(String(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '').trim());
        const bodyHeadless = body?.headless === true ? true : body?.headless === false ? false : null;
        const headless = bodyHeadless === null ? (hasDesktopSession ? envHeadless : true) : bodyHeadless;
        const forcedHeadlessByServer = bodyHeadless === null && !hasDesktopSession && !envHeadless;
        if (bodyHeadless === false && !hasDesktopSession) {
            return res.status(409).json({
                success: false,
                code: 'NO_GUI_SESSION',
                error: 'Este servidor não tem sessão gráfica ativa (X11/Wayland), por isso não consegue abrir browser visível aqui.',
                loginUrl,
            });
        }
        const closeBrowserAfterSubmit = body?.closeAfterSubmit === true;
        const timeoutMs = Math.max(
            30000,
            Math.min(240000, Number(process.env.PORTAL_SEG_SOCIAL_TIMEOUT_MS || 120000) || 120000)
        );
        const usernameSelectors = splitSelectorList(
            process.env.PORTAL_SEG_SOCIAL_USERNAME_SELECTOR,
            'input[name="username"], input[name="niss"], input[id*="username" i], input[name*="user" i], input[id*="utilizador" i], input[name*="utilizador" i], input[id*="niss" i], input[placeholder*="NISS" i], input[autocomplete="username"]'
        );
        const passwordSelectors = splitSelectorList(
            process.env.PORTAL_SEG_SOCIAL_PASSWORD_SELECTOR,
            'input[name="password"], input[id*="password" i], input[placeholder*="senha" i], input[type="password"]'
        );
        const submitSelectors = splitSelectorList(
            process.env.PORTAL_SEG_SOCIAL_SUBMIT_SELECTOR,
            'button[type="submit"], input[type="submit"], button:has-text("Entrar"), button:has-text("Iniciar sessão"), button:has-text("Autenticar"), button:has-text("Continuar")'
        );

        let browser = null;
        let browserLauncherLabel = '';
        let shouldKeepBrowserOpen = false;
        let stage = 'started';
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const credentials = Array.isArray(customer.accessCredentials) ? customer.accessCredentials.map((entry) => ({ ...entry })) : [];
            const principal = credentials.find(isPrincipalCredential) || null;
            const niss = String(customer.niss || '').replace(/\D/g, '').trim();
            const principalUsername = String(principal?.username || niss || '').trim();
            const principalPassword = String(principal?.password || customer.senhaSegurancaSocial || '').trim();
            if (!principalUsername || !principalPassword) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente precisa de utilizador/senha principal da Segurança Social antes de criar subutilizador.',
                });
            }

            const subEmail = String(body.subEmail || process.env.SEG_SOCIAL_SUBUSER_EMAIL || 'geral@mpr.pt').trim().toLowerCase();
            const subUsername = niss ? `${niss}_1` : subEmail;
            const subPassword = randomPassword();
            const now = todayIso();
            const validUntil = addMonthsIso(6);
            const nextCredentials = upsertCredential(credentials, {
                service: 'Segurança Social',
                credentialType: 'subutilizador',
                username: subUsername,
                password: subPassword,
                emailAssociado: subEmail,
                validFrom: now,
                validUntil: '',
                status: 'pending',
                observacoes: 'Subutilizador criado/ativado pelo assistente. Confirmar no portal antes de usar em produção.',
            });
            upsertCredential(nextCredentials, {
                service: 'Segurança Social',
                credentialType: '2fa',
                username: subUsername,
                password: '',
                emailAssociado: subEmail,
                validFrom: now,
                validUntil: '',
                status: 'pending',
                observacoes: 'Ativar 2FA do subutilizador com código recebido por email.',
            });
            upsertCredential(nextCredentials, {
                service: 'Segurança Social',
                credentialType: 'chave_aplicacional',
                username: subUsername,
                password: '',
                emailAssociado: subEmail,
                validFrom: now,
                validUntil,
                status: 'pending',
                observacoes: 'Gerar a chave aplicacional no portal e copiar no momento em que aparece.',
            });

            await upsertLocalCustomer({
                ...customer,
                accessCredentials: nextCredentials,
            });

            isFinancasAutologinRunning_set(true);
            const launched = await launchFinancasBrowserWithFallback(playwright, {
                headless,
                args: headless ? [] : ['--start-maximized'],
                browserExecutablePath: String(process.env.PORTAL_SEG_SOCIAL_BROWSER_EXECUTABLE || '').trim() || undefined,
            });
            browser = launched.browser;
            browserLauncherLabel = String(launched.launcherLabel || '').trim();

            const contextOptions = { acceptDownloads: false };
            if (!headless) {
                contextOptions.viewport = null;
            }
            const context = await browser.newContext(contextOptions);
            const page = await context.newPage();
            page.setDefaultTimeout(timeoutMs);

            stage = 'login_principal';
            await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
            await clickCookieConsentIfPresent(page, 2500);
            await openSegSocialLoginEntryIfNeeded(page, Math.min(12000, timeoutMs));
            await ensureSegSocialCredentialsFormVisible(page, Math.min(12000, timeoutMs));

            const usernameSelector = await findFirstVisibleSelector(page, usernameSelectors);
            const passwordSelector = await findFirstVisibleSelector(page, passwordSelectors);
            const submitSelector = await findFirstVisibleSelector(page, submitSelectors);
            if (!usernameSelector || !passwordSelector || !submitSelector) {
                throw new Error('Não foi possível localizar os campos de login da SS Direta.');
            }
            await page.fill(usernameSelector, principalUsername);
            await page.fill(passwordSelector, principalPassword);
            await Promise.allSettled([
                page.waitForLoadState('networkidle', { timeout: Math.min(30000, timeoutMs) }),
                page.locator(submitSelector).first().click(),
            ]);
            await clickContinueLoginIf2faPrompt(page, Math.min(12000, timeoutMs));
            await clickContinueWithoutActivatingIfPrompt(page, Math.min(18000, timeoutMs));

            stage = 'gestao_acessos';
            await clickFirst(page, [
                () => page.getByRole('button', { name: /perfil|utilizador|área de acesso|area de acesso/i }),
                () => page.getByRole('link', { name: /perfil|utilizador|área de acesso|area de acesso/i }),
                () => page.locator('button, a, [role="button"]', { hasText: /perfil|utilizador|área de acesso|area de acesso/i }),
            ], 3500);
            await clickFirst(page, [
                () => page.getByRole('link', { name: /gest[aã]o de acessos?/i }),
                () => page.getByRole('button', { name: /gest[aã]o de acessos?/i }),
                () => page.locator('a, button, [role="button"]', { hasText: /gest[aã]o de acessos?/i }),
            ], 3500);
            await clickFirst(page, [
                () => page.getByRole('link', { name: /gerir subcontas|subcontas|subconta|utilizadores de empresa/i }),
                () => page.getByRole('button', { name: /gerir subcontas|subcontas|subconta|utilizadores de empresa/i }),
                () => page.locator('a, button, [role="button"]', { hasText: /gerir subcontas|subcontas|subconta|utilizadores de empresa/i }),
            ], 3500);
            await clickFirst(page, [
                () => page.getByRole('button', { name: /adicionar utilizador|adicionar subconta|adicionar/i }),
                () => page.getByRole('link', { name: /adicionar utilizador|adicionar subconta|adicionar/i }),
                () => page.locator('button, a, [role="button"]', { hasText: /adicionar utilizador|adicionar subconta|adicionar/i }),
            ], 3500);

            stage = 'preencher_subutilizador';
            await fillFirst(page, [
                () => page.getByLabel(/nome/i),
                () => page.locator('input[name*="nome" i], input[id*="nome" i], input[placeholder*="nome" i]'),
            ], customer.company || customer.name || 'MPR');
            await fillFirst(page, [
                () => page.getByLabel(/email|e-mail|correio/i),
                () => page.locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]'),
            ], subEmail);
            await fillFirst(page, [
                () => page.getByLabel(/data.*in[ií]cio|in[ií]cio/i),
                () => page.locator('input[name*="inicio" i], input[id*="inicio" i], input[placeholder*="início" i], input[placeholder*="inicio" i]'),
            ], todayPt());
            await fillFirst(page, [
                () => page.getByLabel(/data.*fim|fim/i),
                () => page.locator('input[name*="fim" i], input[id*="fim" i], input[placeholder*="fim" i]'),
            ], '');

            const clickedNext = await clickFirst(page, [
                () => page.getByRole('button', { name: /seguinte|continuar|pr[oó]ximo/i }),
                () => page.locator('button, input[type="submit"], a', { hasText: /seguinte|continuar|pr[oó]ximo/i }),
            ], 3500);
            if (clickedNext) {
                stage = 'confirmar_criacao';
                await clickFirst(page, [
                    () => page.getByRole('button', { name: /confirmar|submeter|criar|adicionar/i }),
                    () => page.locator('button, input[type="submit"], a', { hasText: /confirmar|submeter|criar|adicionar/i }),
                ], 3500);
            }

            await writeAuditLog({
                actorUserId,
                entityType: 'customer',
                entityId: customer.id,
                action: 'seg_social_subuser_setup',
                details: {
                    stage,
                    headless,
                    subEmail,
                    subUsername,
                    validUntil,
                    browserLauncherLabel: browserLauncherLabel || null,
                },
            });

            const shouldCloseBrowser = headless || closeBrowserAfterSubmit;
            shouldKeepBrowserOpen = !shouldCloseBrowser;
            if (shouldCloseBrowser) {
                await browser.close().catch(() => null);
                browser = null;
            }

            return res.json({
                success: true,
                channel: 'seguranca_social_direta',
                stage,
                headless,
                forcedHeadlessByServer,
                subEmail,
                subUsername,
                appKeyValidUntil: validUntil,
                message: shouldCloseBrowser
                    ? 'Assistente de subutilizador executado e credenciais pendentes guardadas.'
                    : 'Assistente iniciado. O browser ficou aberto para confirmares a criação, ativação, 2FA e chave aplicacional.',
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SS Subutilizador] Erro:', details);
            if (browser && !shouldKeepBrowserOpen) {
                await browser.close().catch(() => null);
            }
            return res.status(500).json({
                success: false,
                stage,
                error: details,
            });
        } finally {
            isFinancasAutologinRunning_set(false);
        }
    });
    
}

module.exports = { registerSaftCustomerSyncRoutes };
