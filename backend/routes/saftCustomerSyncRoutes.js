/**
 * SAFT Customer Sync Routes — extracted from localSyncSaftRoutes.js
 * Routes: /api/users/sync, /api/users/:id/delete, /api/customers/sync,
 *         /api/customers/sync/saft-ss-passwords, /api/customers/sync/pull
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const portalCredentials = require('../services/autologin/portalCredentials');

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function foldText(value) {
    return cleanText(value)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
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
    return portalCredentials.isSegSocialCredential(entry);
}

function hasCompleteSegSocialSubUser(customer) {
    return portalCredentials.hasCompleteSegSocialSubUser(customer);
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
        pullCustomersFromSupabaseIncremental,
        syncLocalCustomerCredentialsToSupabase,
    } = helpers;

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
                caeDescricao: body.caeDescricao,
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
}

module.exports = { registerSaftCustomerSyncRoutes };
