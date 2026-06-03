/**
 * SAFT Document Routes — extracted from localSyncSaftRoutes.js
 * Routes: /api/customers/:id/documents, /api/customers/:id/documents/upload,
 *         /api/customers/:id/documents/ingest, /api/customers/:id/documents/import-link,
 *         /api/customers/:id/documents/download, /api/customers/:id/documents/share-link
 */
const path = require('path');

function registerSaftDocumentRoutes(context, helpers) {
    const {
        app, dbRunAsync, dbGetAsync, dbAllAsync, writeAuditLog,
        getLocalCustomerById, resolveCustomerDocumentsFolder,
        fs, sanitizeDocumentFileName,
        nowIso, API_PUBLIC_BASE_URL,
        SUPABASE_CLIENTS_SOURCE,
        parseCustomerSourceId,
        upsertLocalCustomer,
        fetchSupabaseTableColumns,
        patchSupabaseTableWithFilters,
        upsertSupabaseRow,
    } = context;
    const {
        hasConfiguredCustomerFolder,
        normalizeRelativeFolderPath,
        resolveDocsTargetFolder,
        ensureWritableFolderTree,
        guessMimeType,
        normalizeCustomerIngestDocumentType,
        extractCustomerDocumentWithGemini,
        buildIngestDocumentFileName,
        findLocalCustomerByNifDigits,
        buildSuggestedCustomerFromExtraction,
        normalizeNifDigits,
        parseDateToIso,
        toPtDate,
        normalizeExtractionManagers,
        mergeManagers,
        buildPublicBaseUrl: buildPublicBaseUrlHelper,
        hasSupabaseCustomersSync,
        findSupabaseCustomerRow,
        materializeSupabaseRowLocally,
        bumpCustomersSyncWatermark,
        buildSupabaseCustomerPayloadFromLocal,
        CUSTOMER_INGEST_DOC_TYPES,
    } = helpers;

    app.get('/api/customers/:id/documents', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }
    
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.json({
                    success: true,
                    folderPath: '',
                    storageFolderPath: '',
                    configured: false,
                    files: [],
                    warning: 'Defina a pasta de documentos na ficha do cliente para listar ficheiros.',
                });
            }
            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            const { targetFolder, relativePath } = resolveDocsTargetFolder(folderPath, req.query.path || '');
            try {
                await fs.promises.access(targetFolder, fs.constants.R_OK);
            } catch (accessError) {
                const missingFolder = accessError?.code === 'ENOENT';
                return res.json({
                    success: true,
                    folderPath: configuredFolder || folderPath,
                    storageFolderPath: folderPath,
                    currentRelativePath: relativePath,
                    currentStoragePath: targetFolder,
                    canGoUp: !!relativePath,
                    entries: [],
                    configured: !!configuredFolder,
                    files: [],
                    warning: missingFolder
                        ? 'Esta pasta ainda não existe no armazenamento.'
                        : `Sem acesso de leitura a esta pasta: ${accessError?.message || accessError}`,
                });
            }

            const entries = await fs.promises.readdir(targetFolder, { withFileTypes: true });
            const items = [];
            const files = [];
            for (const entry of entries) {
                const fullPath = path.join(targetFolder, entry.name);
                const stat = await fs.promises.stat(fullPath);
                const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    items.push({
                        type: 'directory',
                        name: entry.name,
                        relativePath: childRelativePath,
                        updatedAt: stat.mtime.toISOString(),
                    });
                    continue;
                }
                if (!entry.isFile()) continue;
                const fileItem = {
                    type: 'file',
                    name: entry.name,
                    size: Number(stat.size || 0),
                    updatedAt: stat.mtime.toISOString(),
                    relativePath: childRelativePath,
                };
                items.push(fileItem);
                files.push({
                    name: entry.name,
                    size: Number(stat.size || 0),
                    updatedAt: stat.mtime.toISOString(),
                    relativePath: childRelativePath,
                });
            }

            items.sort((left, right) => {
                if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
                return String(left.name || '').localeCompare(String(right.name || ''), 'pt', { sensitivity: 'base' });
            });
            files.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
            return res.json({
                success: true,
                folderPath: configuredFolder || folderPath,
                storageFolderPath: folderPath,
                currentRelativePath: relativePath,
                currentStoragePath: targetFolder,
                canGoUp: !!relativePath,
                entries: items,
                configured: !!configuredFolder,
                files,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro ao listar documentos do cliente:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });
    
    app.post('/api/customers/:id/documents/upload', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }
    
        const body = req.body || {};
        const requestedFileName = sanitizeDocumentFileName(body.fileName);
        const contentBase64 = String(body.contentBase64 || '').trim();
        const relativePathRaw = String(body.path || '').trim();
    
        if (!requestedFileName || !contentBase64) {
            return res.status(400).json({ success: false, error: 'fileName e contentBase64 são obrigatórios.' });
        }
    
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem pasta definida. Preencha a pasta de documentos na ficha do cliente.',
                });
            }
            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            const { targetFolder, relativePath } = resolveDocsTargetFolder(folderPath, relativePathRaw);
            await ensureWritableFolderTree(folderPath, targetFolder);
    
            const cleanBase64 = contentBase64.includes(',') ? contentBase64.split(',')[1] : contentBase64;
            const fileBuffer = Buffer.from(cleanBase64, 'base64');
            if (!fileBuffer.length) {
                return res.status(400).json({ success: false, error: 'Conteúdo base64 inválido.' });
            }
    
            const fullPath = path.join(targetFolder, requestedFileName);
            await fs.promises.writeFile(fullPath, fileBuffer);
    
            await writeAuditLog({
                actorUserId: body.actorUserId || customer.ownerId || null,
                entityType: 'customer_document',
                entityId: customer.id,
                action: 'upload',
                details: {
                    fileName: requestedFileName,
                    size: fileBuffer.length,
                    folderPath: targetFolder,
                    relativePath,
                },
            });
    
            return res.json({
                success: true,
                fileName: requestedFileName,
                size: fileBuffer.length,
                relativePath: relativePath ? `${relativePath}/${requestedFileName}` : requestedFileName,
                folderPath: configuredFolder || folderPath,
                storageFolderPath: folderPath,
                currentStoragePath: targetFolder,
                fullPath,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro ao guardar documento do cliente:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/customers/:id/documents/ingest', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }

        const body = req.body || {};
        const documentType = normalizeCustomerIngestDocumentType(body.documentType);
        const sourceFileName = sanitizeDocumentFileName(body.fileName || '');
        const contentBase64Raw = String(body.contentBase64 || '').trim();
        const mimeType = guessMimeType(sourceFileName, body.mimeType);
        if (!documentType || !CUSTOMER_INGEST_DOC_TYPES.includes(documentType)) {
            return res.status(400).json({ success: false, error: 'Tipo de documento inválido.' });
        }
        if (!sourceFileName || !contentBase64Raw) {
            return res.status(400).json({ success: false, error: 'fileName e contentBase64 são obrigatórios.' });
        }

        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem pasta definida. Preencha a pasta de documentos na ficha do cliente.',
                });
            }

            const cleanBase64 = contentBase64Raw.includes(',') ? contentBase64Raw.split(',')[1] : contentBase64Raw;
            const fileBuffer = Buffer.from(cleanBase64, 'base64');
            if (!fileBuffer.length) {
                return res.status(400).json({ success: false, error: 'Conteúdo base64 inválido.' });
            }

            const extraction = await extractCustomerDocumentWithGemini({
                fileName: sourceFileName,
                mimeType,
                documentType,
                contentBase64: cleanBase64,
            });
            const warnings = [];
            const extractedNif = normalizeNifDigits(extraction?.nif || '');
            const currentNif = normalizeNifDigits(customer.nif || '');
            if (documentType === 'certidao_permanente' && extractedNif) {
                const existingByNif = await findLocalCustomerByNifDigits(extractedNif);
                if (existingByNif && String(existingByNif.id || '').trim() !== customerId) {
                    return res.status(409).json({
                        success: false,
                        code: 'CERTIDAO_NIF_BELONGS_OTHER_CUSTOMER',
                        error: `O NIF ${extractedNif} já existe noutra ficha (${existingByNif.company || existingByNif.name}).`,
                        existingCustomer: {
                            id: String(existingByNif.id || '').trim(),
                            name: String(existingByNif.name || '').trim(),
                            company: String(existingByNif.company || '').trim(),
                            nif: String(existingByNif.nif || '').trim(),
                        },
                        extraction,
                    });
                }

                if (currentNif && currentNif !== extractedNif) {
                    return res.status(409).json({
                        success: false,
                        code: 'CERTIDAO_NIF_NOT_FOUND',
                        error: `A certidão indica NIF ${extractedNif}, diferente da ficha atual (${currentNif}).`,
                        suggestedCustomer: buildSuggestedCustomerFromExtraction(extraction, customer),
                        extraction,
                    });
                }
            }

            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            const docsOficiaisFolder = path.join(folderPath, sanitizeDocumentFileName('Documentos Oficiais'));
            await ensureWritableFolderTree(folderPath, docsOficiaisFolder);

            const finalFileName = buildIngestDocumentFileName({
                documentType,
                sourceFileName,
                extracted: extraction,
                customer,
            });
            const fullPath = path.join(docsOficiaisFolder, finalFileName);
            await fs.promises.writeFile(fullPath, fileBuffer);

            const updatePayload = { id: customer.id };
            const updatedFields = [];
            if (documentType === 'certidao_permanente') {
                const validadeIso = parseDateToIso(extraction.certidaoPermanenteValidade);
                const validadePt = toPtDate(validadeIso);
                const hasValidDate = !!validadeIso;
                const validadeTs = hasValidDate ? new Date(`${validadeIso}T23:59:59Z`).getTime() : 0;
                const isValidNow = hasValidDate && validadeTs >= Date.now();

                // Preenche sempre os campos-base da certidão na ficha.
                if (extraction.certidaoPermanenteCodigo) {
                    updatePayload.certidaoPermanenteNumero = extraction.certidaoPermanenteCodigo;
                    updatedFields.push('certidaoPermanenteNumero');
                }
                if (validadePt) {
                    updatePayload.certidaoPermanenteValidade = validadePt;
                    updatedFields.push('certidaoPermanenteValidade');
                }

                if (!isValidNow) {
                    warnings.push('Certidão permanente sem validade futura. Foram atualizados número/validade, mas não os dados complementares.');
                } else {
                    if (extractedNif) {
                        updatePayload.nif = extractedNif;
                        updatePayload.allowNifOverwrite = true;
                        updatedFields.push('nif');
                    }
                    if (extraction.morada) {
                        updatePayload.morada = extraction.morada;
                        updatedFields.push('morada');
                    }
                    if (extraction.caePrincipal) {
                        updatePayload.caePrincipal = extraction.caePrincipal;
                        updatedFields.push('caePrincipal');
                    }
                    const incomingManagers = mergeManagers(
                        [],
                        [
                            ...normalizeExtractionManagers(extraction.managers),
                            ...(extraction.gerenteNome ? [{ name: extraction.gerenteNome, email: '', phone: '' }] : []),
                        ]
                    );
                    if (incomingManagers.length > 0) {
                        updatePayload.managers = mergeManagers(Array.isArray(customer.managers) ? customer.managers : [], incomingManagers);
                        updatedFields.push('managers');
                    }
                }
            } else if (documentType === 'inicio_atividade') {
                const inicioIso = parseDateToIso(extraction.inicioAtividade || extraction.dataDocumento || '');
                const inicioPt = toPtDate(inicioIso);
                if (inicioPt) {
                    updatePayload.inicioAtividade = inicioPt;
                    updatedFields.push('inicioAtividade');
                } else {
                    warnings.push('Data de início de atividade não identificada.');
                }
            } else if (documentType === 'rcbe') {
                if (extraction.rcbeNumero) {
                    updatePayload.rcbeNumero = extraction.rcbeNumero;
                    updatedFields.push('rcbeNumero');
                }
                const rcbeIsoFromDoc = parseDateToIso(extraction.rcbeData || extraction.dataDocumento || '');
                const rcbeIso = rcbeIsoFromDoc || nowIso().slice(0, 10);
                const rcbePt = toPtDate(rcbeIso);
                if (rcbePt) {
                    updatePayload.rcbeData = rcbePt;
                    updatedFields.push('rcbeData');
                }
                if (!rcbeIsoFromDoc) {
                    warnings.push('Data RCBE não identificada no documento. Foi usada a data de hoje.');
                }
            }

            const savedCustomer =
                updatedFields.length > 0
                    ? await upsertLocalCustomer(updatePayload)
                    : customer;

            let canonicalCustomer = savedCustomer;
            let syncedToSupabase = false;
            const syncWarnings = [];

            if (updatedFields.length > 0 && hasSupabaseCustomersSync()) {
                try {
                    const tableColumns = await fetchSupabaseTableColumns(SUPABASE_CLIENTS_SOURCE);
                    const effectiveSourceId = parseCustomerSourceId(
                        canonicalCustomer?.id || customer.id,
                        canonicalCustomer?.sourceId || customer.sourceId || ''
                    );
                    const supabaseMatch = await findSupabaseCustomerRow({
                        columns: tableColumns,
                        sourceId: effectiveSourceId,
                        nif: canonicalCustomer?.nif || customer.nif || '',
                        phone: canonicalCustomer?.phone || customer.phone || '',
                        email: canonicalCustomer?.email || customer.email || '',
                    });
                    const columnsMeta = supabaseMatch.columnsMeta || {};
                    const payload = buildSupabaseCustomerPayloadFromLocal(canonicalCustomer, tableColumns);

                    let returnedRows = [];
                    if (supabaseMatch?.row && columnsMeta?.idColumn && effectiveSourceId) {
                        returnedRows = await patchSupabaseTableWithFilters(
                            SUPABASE_CLIENTS_SOURCE,
                            payload,
                            { [columnsMeta.idColumn]: effectiveSourceId }
                        );
                    } else if (supabaseMatch?.row && columnsMeta?.nifColumn && canonicalCustomer?.nif) {
                        returnedRows = await patchSupabaseTableWithFilters(
                            SUPABASE_CLIENTS_SOURCE,
                            payload,
                            { [columnsMeta.nifColumn]: canonicalCustomer.nif }
                        );
                    } else {
                        const payloadForInsert = { ...payload };
                        if (columnsMeta?.idColumn && effectiveSourceId) {
                            payloadForInsert[columnsMeta.idColumn] = effectiveSourceId;
                        }
                        returnedRows = await upsertSupabaseRow(
                            SUPABASE_CLIENTS_SOURCE,
                            payloadForInsert,
                            columnsMeta?.idColumn && effectiveSourceId ? [columnsMeta.idColumn] : []
                        );
                    }

                    if ((!Array.isArray(returnedRows) || returnedRows.length === 0)) {
                        const freshMatch = await findSupabaseCustomerRow({
                            columns: tableColumns,
                            sourceId: effectiveSourceId,
                            nif: canonicalCustomer?.nif || customer.nif || '',
                            phone: canonicalCustomer?.phone || customer.phone || '',
                            email: canonicalCustomer?.email || customer.email || '',
                        });
                        if (freshMatch?.row) {
                            returnedRows = [freshMatch.row];
                        }
                    }

                    if (Array.isArray(returnedRows) && returnedRows.length > 0) {
                        canonicalCustomer = await materializeSupabaseRowLocally(returnedRows[0], canonicalCustomer.id);
                        if (columnsMeta?.updatedAtColumn) {
                            await bumpCustomersSyncWatermark(returnedRows, columnsMeta.updatedAtColumn);
                        }
                    }

                    syncedToSupabase = true;
                } catch (syncError) {
                    const errorMessage = String(syncError?.message || syncError);
                    const errorPayload = syncError?.response?.data;
                    const errorDetails =
                        errorPayload && typeof errorPayload === 'object'
                            ? JSON.stringify(errorPayload)
                            : String(errorPayload || '').trim();
                    syncWarnings.push(
                        `Falha a sincronizar no Supabase: ${errorMessage}${errorDetails ? ` | ${errorDetails}` : ''}`
                    );
                }
            }

            await writeAuditLog({
                actorUserId: body.actorUserId || customer.ownerId || null,
                entityType: 'customer_document',
                entityId: customer.id,
                action: 'ingest_ai',
                details: {
                    documentType,
                    sourceFileName,
                    storedFileName: finalFileName,
                    storedPath: fullPath,
                    updatedFields,
                    warnings: [...warnings, ...syncWarnings],
                    extractedNif: extractedNif || null,
                    syncedToSupabase,
                },
            });

            // Actualizar Resumo Fiscal "Outros Documentos" com o ficheiro guardado
            const FISCAL_DOC_LABELS = {
                certidao_permanente: 'Certidão Permanente',
                rcbe: 'RCBE',
                pacto_social: 'Pacto Social',
                inicio_atividade: 'Início de Atividade',
                cartao_cidadao: 'Cartão de Cidadão',
            };
            // Para CC: usar tipo único por sócio (cc_{nif})
            // Fallback para o NIF extraído pela IA se managerNif não foi enviado
            const managerNif = String(body.managerNif || (documentType === 'cartao_cidadao' ? extractedNif : '') || '').trim().replace(/\D+/g, '').slice(-9);
            const fiscalDocTipo = (documentType === 'cartao_cidadao' && managerNif)
                ? `cc_${managerNif}` : documentType;
            // Usar nome extraído pela IA se disponível (em vez do NIF)
            const extractedName = String(
                extraction.nomePessoa || extraction.raw?.nome_pessoa || extraction.raw?.nome_completo || extraction.raw?.nome || extraction.raw?.titular || ''
            ).trim().toUpperCase();
            const fiscalDocLabel = (documentType === 'cartao_cidadao')
                ? `CC — ${extractedName || managerNif || 'Cidadão'}`
                : (FISCAL_DOC_LABELS[documentType] || documentType);

            if (FISCAL_DOC_LABELS[documentType]) {
                try {
                    const { mergeFiscalSummaryData } = require('../services/fiscal/config/fiscalSummaryDefaults');
                    const row = await dbGetAsync('SELECT data FROM customer_fiscal_summary WHERE customer_id = ?', [customerId]);
                    const current = mergeFiscalSummaryData(row?.data ? JSON.parse(row.data) : {});
                    const docs = Array.isArray(current.documentos) ? [...current.documentos] : [];
                    const idx = docs.findIndex((d) => d?.tipo === fiscalDocTipo);
                    // Extrair validade e notas por tipo de documento
                    const entryDataValidade = (() => {
                        if (documentType === 'certidao_permanente')
                            return parseDateToIso(extraction.certidaoPermanenteValidade || '') || '';
                        if (documentType === 'cartao_cidadao') {
                            const raw = extraction.raw || {};
                            const rawDate = extraction.cartaoCidadaoValidade || raw.cartao_cidadao_validade ||
                                raw.cc_validade || raw.validade_cc || raw.data_validade ||
                                raw.data_fim_validade || raw.fim_validade || raw.expiry || '';
                            // Normalizar formato "28 11 2029" (espaços) → "28/11/2029"
                            const normalizedDate = String(rawDate).trim().replace(/^(\d{1,2})\s+(\d{1,2})\s+(\d{4})$/, '$1/$2/$3');
                            return parseDateToIso(normalizedDate) || '';
                        }
                        return '';
                    })();
                    const entryNotas = (() => {
                        if (documentType === 'rcbe') return extraction.rcbeNumero || '';
                        if (documentType === 'certidao_permanente') return extraction.certidaoPermanenteCodigo || '';
                        if (documentType === 'cartao_cidadao') {
                            const raw = extraction.raw || {};
                            // Número CC extraído pela IA, senão NIF do titular como fallback
                            return String(raw.cartao_cidadao_numero || raw.numero_cc || raw.cc_numero || raw.numero_documento || raw.nif || '').trim();
                        }
                        return '';
                    })();
                    const entry = {
                        tipo: fiscalDocTipo,
                        label: fiscalDocLabel,
                        ficheiroPdf: fullPath,
                        valida: true,
                        notas: entryNotas,
                        dataValidade: entryDataValidade,
                    };
                    if (idx >= 0) docs[idx] = { ...docs[idx], ...entry };
                    else docs.push(entry);
                    current.documentos = docs;
                    current.updatedAt = new Date().toISOString();
                    await dbRunAsync(
                        `INSERT INTO customer_fiscal_summary (customer_id, data, updated_at)
                         VALUES (?, ?, ?)
                         ON CONFLICT(customer_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
                        [customerId, JSON.stringify(current), current.updatedAt]
                    );
                } catch (summaryErr) {
                    console.error('[Ingest] Falha ao actualizar resumo fiscal:', summaryErr?.message);
                }
            }

            return res.json({
                success: true,
                documentType,
                savedDocument: {
                    fileName: finalFileName,
                    relativePath: `Documentos Oficiais/${finalFileName}`,
                    fullPath,
                    folderPath: configuredFolder || folderPath,
                },
                updatedFields,
                warnings: [...warnings, ...syncWarnings],
                extraction,
                syncedToSupabase,
                customer: canonicalCustomer || savedCustomer,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro no ingest de documento com IA:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/customers/:id/documents/import-link', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }

        const body = req.body || {};
        const sourceUrl = String(body.url || '').trim();
        const requestedFileName = sanitizeDocumentFileName(body.fileName);
        const relativePathRaw = String(body.path || '').trim();
        if (!sourceUrl) {
            return res.status(400).json({ success: false, error: 'url é obrigatório.' });
        }

        try {
            const parsedUrl = new URL(sourceUrl);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return res.status(400).json({ success: false, error: 'URL inválido (apenas http/https).' });
            }

            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem pasta definida. Preencha a pasta de documentos na ficha do cliente.',
                });
            }

            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            const { targetFolder, relativePath } = resolveDocsTargetFolder(folderPath, relativePathRaw);
            await ensureWritableFolderTree(folderPath, targetFolder);

            const upstreamResponse = await fetch(sourceUrl);
            if (!upstreamResponse.ok) {
                return res.status(502).json({
                    success: false,
                    error: `Falha ao descarregar documento (${upstreamResponse.status}).`,
                });
            }

            const arrayBuffer = await upstreamResponse.arrayBuffer();
            const fileBuffer = Buffer.from(arrayBuffer);
            if (!fileBuffer.length) {
                return res.status(400).json({ success: false, error: 'Conteúdo remoto vazio.' });
            }

            const contentDisposition = String(upstreamResponse.headers.get('content-disposition') || '');
            const contentDispositionMatch = contentDisposition.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
            const headerName = sanitizeDocumentFileName(contentDispositionMatch?.[1] || '');
            const urlName = sanitizeDocumentFileName(path.basename(parsedUrl.pathname || ''));
            const finalFileName = requestedFileName || headerName || urlName || `ficheiro_${Date.now()}.bin`;
            const fullPath = path.join(targetFolder, finalFileName);

            await fs.promises.writeFile(fullPath, fileBuffer);

            await writeAuditLog({
                actorUserId: body.actorUserId || customer.ownerId || null,
                entityType: 'customer_document',
                entityId: customer.id,
                action: 'import_link',
                details: {
                    fileName: finalFileName,
                    size: fileBuffer.length,
                    sourceUrl,
                    folderPath: targetFolder,
                    relativePath,
                },
            });

            return res.json({
                success: true,
                fileName: finalFileName,
                size: fileBuffer.length,
                relativePath: relativePath ? `${relativePath}/${finalFileName}` : finalFileName,
                folderPath: configuredFolder || folderPath,
                storageFolderPath: folderPath,
                currentStoragePath: targetFolder,
                fullPath,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro ao importar link para documento do cliente:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });
    
    app.get('/api/customers/:id/documents/download', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const requestedName = sanitizeDocumentFileName(req.query.name || '');
        const requestedPath = String(req.query.path || '').trim();
        if (!customerId || (!requestedName && !requestedPath)) {
            return res.status(400).json({ success: false, error: 'Parâmetros inválidos.' });
        }
    
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem pasta definida. Preencha a pasta de documentos na ficha do cliente.',
                });
            }
            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            let fullPath = '';
            let downloadName = requestedName;
            if (requestedPath) {
                const safeRelativePath = normalizeRelativeFolderPath(requestedPath);
                if (!safeRelativePath) {
                    return res.status(400).json({ success: false, error: 'Caminho inválido.' });
                }
                fullPath = path.resolve(folderPath, safeRelativePath);
                downloadName = sanitizeDocumentFileName(path.basename(safeRelativePath));
            } else {
                fullPath = path.resolve(folderPath, requestedName);
            }
            const folderNormalized = path.resolve(folderPath);
            if (!fullPath.startsWith(folderNormalized + path.sep) && fullPath !== path.join(folderNormalized, downloadName)) {
                return res.status(400).json({ success: false, error: 'Nome de ficheiro inválido.' });
            }
    
            await fs.promises.access(fullPath, fs.constants.R_OK);
            if (String(req.query.download || '').trim() === '1') {
                return res.download(fullPath, downloadName);
            }

            res.setHeader('Content-Type', guessMimeType(downloadName));
            res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(downloadName)}"`);
            return res.sendFile(fullPath);
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro ao descarregar documento do cliente:', details);
            return res.status(404).json({ success: false, error: 'Ficheiro não encontrado.' });
        }
    });

    app.get('/api/customers/:id/documents/share-link', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const requestedPath = String(req.query.path || '').trim();
        if (!customerId || !requestedPath) {
            return res.status(400).json({ success: false, error: 'Parâmetros inválidos.' });
        }

        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }
            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem pasta definida.',
                });
            }
            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            const safeRelativePath = normalizeRelativeFolderPath(requestedPath);
            const fullPath = path.resolve(folderPath, safeRelativePath);
            const folderNormalized = path.resolve(folderPath);
            if (fullPath !== folderNormalized && !fullPath.startsWith(`${folderNormalized}${path.sep}`)) {
                return res.status(400).json({ success: false, error: 'Caminho inválido.' });
            }
            await fs.promises.access(fullPath, fs.constants.R_OK);

            const baseUrl = buildPublicBaseUrlHelper(req);
            const query = new URLSearchParams({ path: safeRelativePath });
            const url = `${baseUrl}/api/customers/${encodeURIComponent(customer.id)}/documents/download?${query.toString()}`;
            return res.json({
                success: true,
                url,
                fileName: sanitizeDocumentFileName(path.basename(safeRelativePath)),
                relativePath: safeRelativePath,
            });
        } catch (error) {
            const details = error?.message || error;
            return res.status(500).json({ success: false, error: details });
        }
    });
    
}

module.exports = { registerSaftDocumentRoutes };
