/**
 * SAFT Operations Routes — extracted from localSyncSaftRoutes.js
 * Routes: /api/saft/fetch-and-send, /api/saft/sync-company-docs,
 *         /api/saft/jobs/:customerId, /api/saft/cache/:customerId
 */
const fs = require('fs');
const path = require('path');

function registerSaftOperationsRoutes(context, helpers) {
    const {
        app, dbRunAsync, dbGetAsync, dbAllAsync, writeAuditLog,
        getLocalCustomerById, resolveCustomerDocumentsFolder,
        ensureWritableSaftBunkerFolder, getSaftSearchTokens,
        getCachedSaftDocument, upsertSaftDocumentCache, buildBunkerFileName,
        nowIso, findDocumentMatches, selectModelo22Files, runSaftRobotFetch,
        runSaftDossierMetadata, normalizeSaftDocumentType, saftDocumentLabel,
        sendWhatsAppDocumentLink, hasEmailProvider, sendEmailDocumentLink,
        SMTP_CC_FALLBACK,
    } = context;
    const {
        hasConfiguredCustomerFolder, normalizeNifDigits, parseDateToIso,
        toPtDate, toDateToken, extractDateToken,
        extractYearFromFileName, isValidAnnualObrigacaoYear,
        classifyDeclarationVariant, classifyCrcVariant,
        buildSaftArchivePlacement, selectLatestFilesPerYear,
        copyToCustomerStructuredFolder, selectSaftFilesForDelivery,
        registerSaftSyncJobState, appendSaftSyncLogFile,
        buildPublicBaseUrl,
        SAFT_COMPANY_DOC_TYPES, FOUR_MONTHS_MS,
    } = helpers;

    app.post('/api/saft/fetch-and-send', async (req, res) => {
        const body = req.body || {};
        const customerId = String(body.customerId || '').trim();
        const conversationId = String(body.conversationId || '').trim();
        const requestedBy = String(body.requestedBy || '').trim() || null;
        const documentType = normalizeSaftDocumentType(body.documentType);
        const existingJobId = Number(body.jobId || 0);
        let jobId = 0;
        let shouldSupersedeSiblings = false;
    
        if (!customerId || !documentType) {
            return res.status(400).json({
                success: false,
                error: 'customerId e documentType são obrigatórios.',
            });
        }
    
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            if (!hasConfiguredCustomerFolder(customer)) {
                return res.status(400).json({
                    success: false,
                    error: 'Cliente sem pasta de documentos definida. Configure a pasta na ficha do cliente antes de recolher/enviar.',
                });
            }

            if (!customer.phone) {
                return res.status(400).json({ success: false, error: 'Cliente sem telefone para envio.' });
            }

            if (documentType === 'declaracao_nao_divida') {
                try {
                    const metadata = await runSaftDossierMetadata({ customer });
                    const atOk = isRegularizadaStatus(metadata?.situacaoFiscalAt);
                    const ssOk = isRegularizadaStatus(metadata?.situacaoFiscalSs);
                    if (!atOk || !ssOk) {
                        return res.status(409).json({
                            success: false,
                            error: `Declaração de Não Dívida bloqueada: estado atual AT="${metadata?.situacaoFiscalAt || '-'}", SS="${metadata?.situacaoFiscalSs || '-'}". É necessário "Regularizada" em ambos.`,
                        });
                    }
                } catch (metaError) {
                    return res.status(500).json({
                        success: false,
                        error: `Falha ao validar situação AT/SS no Dossier SAFT: ${String(metaError?.message || metaError)}`,
                    });
                }
            }
    
            if (existingJobId > 0) {
                const existingJob = await dbGetAsync(
                    `SELECT id, customer_id
                     FROM saft_jobs
                     WHERE id = ?
                     LIMIT 1`,
                    [existingJobId]
                );
                if (!existingJob || String(existingJob.customer_id || '').trim() !== customerId) {
                    return res.status(404).json({ success: false, error: 'Job SAFT não encontrado para este cliente.' });
                }
                jobId = existingJobId;
                await dbRunAsync(
                    `UPDATE saft_jobs
                     SET status = 'processing', error = NULL, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [jobId]
                );
            } else {
                shouldSupersedeSiblings = true;
                // Evita duplicar pedidos iguais quando o utilizador clica várias vezes.
                const activeJob = await dbGetAsync(
                    `SELECT id
                     FROM saft_jobs
                     WHERE customer_id = ?
                       AND document_type = ?
                       AND status IN ('pending', 'processing')
                     ORDER BY id DESC
                     LIMIT 1`,
                    [customerId, documentType]
                );
                if (activeJob?.id) {
                    jobId = Number(activeJob.id || 0);
                    await dbRunAsync(
                        `UPDATE saft_jobs
                         SET status = 'processing', error = NULL, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [jobId]
                    );
                } else {
                    const jobInsert = await dbRunAsync(
                        `INSERT INTO saft_jobs (customer_id, conversation_id, document_type, status, requested_by, created_at, updated_at)
                         VALUES (?, ?, ?, 'processing', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                        [customerId, conversationId || null, documentType, requestedBy]
                    );
                    jobId = Number(jobInsert.lastID || 0);
                }
            }
            if (shouldSupersedeSiblings && jobId > 0) {
                await dbRunAsync(
                    `UPDATE saft_jobs
                     SET status = 'superseded',
                         error = ?,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE customer_id = ?
                       AND document_type = ?
                       AND id <> ?
                       AND status IN ('pending', 'processing')`,
                    [`Substituído pelo pedido #${jobId}.`, customerId, documentType, jobId]
                );
            }
    
            const folderPath = resolveCustomerDocumentsFolder(customer.id, customer.documentsFolder || '');
            await ensureWritableFolderTree(folderPath, folderPath);
    
            const bunkerTarget = await ensureWritableSaftBunkerFolder(customer, documentType);
            const bunkerFolderPath = bunkerTarget.folderPath;
    
            const searchFilters = getSaftSearchTokens(documentType, customer);
            const cachedDoc = await getCachedSaftDocument(customer.id, documentType);
            const candidateFiles = [];
            const seenCandidatePaths = new Set();
            const pushCandidate = (item, source) => {
                const fullPath = path.resolve(String(item?.fullPath || ''));
                const fileName = String(item?.fileName || '').trim();
                if (!fullPath || !fileName) return;
                const key = fullPath.toLowerCase();
                if (seenCandidatePaths.has(key)) return;
                seenCandidatePaths.add(key);
                candidateFiles.push({
                    fileName,
                    fullPath,
                    updatedAt: String(item?.updatedAt || nowIso()),
                    source: String(source || 'local'),
                });
            };
    
            if (cachedDoc) {
                pushCandidate(
                    {
                        fileName: cachedDoc.fileName,
                        fullPath: cachedDoc.filePath,
                        updatedAt: cachedDoc.updatedAt,
                    },
                    'cache'
                );
            }
    
            const bunkerMatches = await findDocumentMatches(bunkerFolderPath, searchFilters);
            bunkerMatches.forEach((match) => pushCandidate(match, 'local'));
            const customerMatches = await findDocumentMatches(folderPath, searchFilters);
            customerMatches.forEach((match) => pushCandidate(match, 'local'));
    
            const yearsToKeepForSend = ['modelo_22', 'ies'].includes(String(documentType || '').trim()) ? 3 : 1;
            let filesToDeliver = await selectSaftFilesForDelivery({
                documentType,
                candidateFiles,
                yearsToKeep: yearsToKeepForSend,
            });
    
            // Pedido inicial: responder rápido para evitar 502 e deixar o worker tentar recolha.
            if (filesToDeliver.length === 0 && !existingJobId) {
                await dbRunAsync(
                    `UPDATE saft_jobs
                     SET status = 'pending', error = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    ['Documento não encontrado no dossiê e sem ficheiro devolvido pelo robô SAFT.', jobId]
                );
                return res.json({
                    success: true,
                    status: 'pending',
                    message: 'Pedido em recolha. Documento ainda não disponível.',
                    jobId,
                });
            }
    
            // Reprocessamento (worker): tenta robô quando ainda não encontrou ficheiros.
            if (filesToDeliver.length === 0) {
                try {
                    const filePathsFromRobot = await runSaftRobotFetch({
                        customer,
                        documentType,
                        folderPath: bunkerFolderPath,
                    });
                    for (const filePathFromRobot of filePathsFromRobot) {
                        pushCandidate(
                            {
                                fileName: path.basename(filePathFromRobot),
                                fullPath: filePathFromRobot,
                                updatedAt: nowIso(),
                            },
                            'robot'
                        );
                    }
                } catch (robotError) {
                    await dbRunAsync(
                        `UPDATE saft_jobs
                         SET status = 'error', error = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [String(robotError?.message || robotError || 'Falha no robô SAFT').slice(0, 1000), jobId]
                    );
                    return res.status(500).json({
                        success: false,
                        error: `Falha no robô SAFT: ${robotError?.message || robotError}`,
                        jobId,
                    });
                }
    
                const refreshedBunkerMatches = await findDocumentMatches(bunkerFolderPath, searchFilters);
                refreshedBunkerMatches.forEach((match) => pushCandidate(match, 'local'));
                const refreshedCustomerMatches = await findDocumentMatches(folderPath, searchFilters);
                refreshedCustomerMatches.forEach((match) => pushCandidate(match, 'local'));
                filesToDeliver = await selectSaftFilesForDelivery({
                    documentType,
                    candidateFiles,
                    yearsToKeep: yearsToKeepForSend,
                });
            }
    
            if (filesToDeliver.length === 0) {
                await dbRunAsync(
                    `UPDATE saft_jobs
                     SET status = 'pending', error = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    ['Documento não encontrado no dossiê e sem ficheiro devolvido pelo robô SAFT.', jobId]
                );
                return res.json({
                    success: true,
                    status: 'pending',
                    message: 'Documento ainda não disponível. Pedido ficou pendente.',
                    jobId,
                });
            }
    
            const cacheHit = filesToDeliver.some((file) => file.source === 'cache');
            const preparedFiles = [];
            for (const matchedFile of filesToDeliver) {
                const resolvedMatchedPath = path.resolve(String(matchedFile.fullPath || ''));
                let bunkerFileName = sanitizeDocumentFileName(matchedFile.fileName || path.basename(resolvedMatchedPath));
                if (!bunkerFileName) {
                    bunkerFileName = buildBunkerFileName(documentType, `${documentType}.pdf`);
                }
                let bunkerFilePath = path.join(bunkerFolderPath, bunkerFileName);
                const bunkerRootNormalized = path.resolve(bunkerFolderPath);
                const isInsideBunker =
                    resolvedMatchedPath === bunkerFilePath ||
                    resolvedMatchedPath.startsWith(`${bunkerRootNormalized}${path.sep}`);
    
                if (!isInsideBunker) {
                    bunkerFileName = buildBunkerFileName(documentType, bunkerFileName);
                    bunkerFilePath = path.join(bunkerFolderPath, bunkerFileName);
                    await fs.promises.copyFile(resolvedMatchedPath, bunkerFilePath);
                } else {
                    bunkerFilePath = resolvedMatchedPath;
                    bunkerFileName = path.basename(bunkerFilePath);
                }
    
                await upsertSaftDocumentCache({
                    customerId: customer.id,
                    customerNif: customer.nif,
                    documentType,
                    fileName: bunkerFileName,
                    filePath: bunkerFilePath,
                    source:
                        matchedFile.source === 'cache'
                            ? 'cache'
                            : (bunkerTarget.usingFallback ? 'collected_fallback' : 'collected'),
                });
    
                // Mantém cópia no dossiê do cliente para link/download externo.
                const customerDeliveryPath = path.join(folderPath, bunkerFileName);
                const sourceForDelivery = path.resolve(bunkerFilePath);
                if (path.resolve(customerDeliveryPath) !== sourceForDelivery) {
                    await fs.promises.copyFile(sourceForDelivery, customerDeliveryPath);
                }
                const structuredDeliveryPath = await copyToCustomerStructuredFolder({
                    customerFolderPath: folderPath,
                    documentType,
                    fileName: bunkerFileName,
                    sourcePath: sourceForDelivery,
                });

                preparedFiles.push({
                    fileName: bunkerFileName,
                    filePath: bunkerFilePath,
                    structuredPath: structuredDeliveryPath,
                });
            }
    
            if (!API_PUBLIC_BASE_URL) {
                const firstPrepared = preparedFiles[0] || {};
                await dbRunAsync(
                    `UPDATE saft_jobs
                     SET status = 'error', file_name = ?, file_path = ?, error = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [
                        firstPrepared.fileName || null,
                        firstPrepared.filePath || null,
                        'API_PUBLIC_BASE_URL não configurado no .env para envio de documentos por link.',
                        jobId,
                    ]
                );
                return res.status(500).json({
                    success: false,
                    error: 'Defina API_PUBLIC_BASE_URL no .env para enviar documentos no WhatsApp.',
                    jobId,
                    fileName: firstPrepared.fileName || null,
                    filePath: firstPrepared.filePath || null,
                });
            }
    
            const documentLabel = saftDocumentLabel(documentType);
            const deliveredChannels = new Set();
            const deliveredFiles = [];
            const deliveryErrors = [];
    
            const customerEmail = String(customer.email || '').trim().toLowerCase();
            let ownerEmail = '';
            if (customer.ownerId) {
                const ownerRow = await dbGetAsync(
                    `SELECT email
                     FROM users
                     WHERE id = ?
                     LIMIT 1`,
                    [String(customer.ownerId || '').trim()]
                );
                ownerEmail = String(ownerRow?.email || '').trim().toLowerCase();
            }
            const ccEmail = ownerEmail || SMTP_CC_FALLBACK || '';
            const canTryEmail = Boolean(customerEmail && hasEmailProvider());
            for (const prepared of preparedFiles) {
                const downloadUrl = `${API_PUBLIC_BASE_URL}/api/customers/${encodeURIComponent(
                    customer.id
                )}/documents/download?name=${encodeURIComponent(prepared.fileName)}`;
                const caption = `${documentLabel} (${customer.nif || 'sem NIF'})`;
                const fileDeliveredChannels = [];
    
                try {
                    await sendWhatsAppDocumentLink({
                        to: customer.phone,
                        url: downloadUrl,
                        filename: prepared.fileName,
                        caption,
                    });
                    deliveredChannels.add('whatsapp');
                    fileDeliveredChannels.push('whatsapp');
                    db.run(
                        "INSERT INTO messages (from_number, body, direction, status) VALUES (?, ?, 'outbound', 'sent')",
                        [String(customer.phone || '').replace(/\D/g, ''), `[SAFT] ${documentLabel}: ${prepared.fileName}`]
                    );
                } catch (whatsError) {
                    deliveryErrors.push(`WhatsApp (${prepared.fileName}): ${String(whatsError?.message || whatsError)}`);
                }
    
                if (canTryEmail) {
                    try {
                        await sendEmailDocumentLink({
                            to: customerEmail,
                            cc: ccEmail || undefined,
                            subject: `${documentLabel} - ${customer.company || customer.name || 'Cliente'}`,
                            documentLabel: `${documentLabel} (${customer.nif || 'sem NIF'}) - ${prepared.fileName}`,
                            url: downloadUrl,
                        });
                        deliveredChannels.add('email');
                        fileDeliveredChannels.push('email');
                    } catch (emailError) {
                        deliveryErrors.push(`Email (${prepared.fileName}): ${String(emailError?.message || emailError)}`);
                    }
                }
    
                if (fileDeliveredChannels.length > 0) {
                    deliveredFiles.push(prepared);
                }
            }
    
            if (deliveredFiles.length === 0) {
                const composedError = [
                    deliveryErrors.length ? deliveryErrors.join(' | ') : 'Nenhum canal de envio disponível.',
                    !customerEmail ? 'Cliente sem email para envio.' : '',
                    !hasEmailProvider() ? 'SMTP/Resend não configurado para envio por email.' : '',
                ]
                    .filter(Boolean)
                    .join(' ');
                await dbRunAsync(
                    `UPDATE saft_jobs
                     SET status = 'error', file_name = ?, file_path = ?, error = ?, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [preparedFiles[0]?.fileName || null, preparedFiles[0]?.filePath || null, composedError.slice(0, 1000), jobId]
                );
                return res.status(500).json({
                    success: false,
                    status: 'error',
                    error: composedError || 'Falha no envio do documento.',
                    jobId,
                    fileName: preparedFiles[0]?.fileName || null,
                    channels: Array.from(deliveredChannels),
                });
            }
    
            const sentFileNames = deliveredFiles.map((item) => item.fileName).filter(Boolean);
            const sentFilePaths = deliveredFiles.map((item) => item.filePath).filter(Boolean);
    
            await dbRunAsync(
                `UPDATE saft_jobs
                 SET status = 'sent', file_name = ?, file_path = ?, error = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [
                    sentFileNames.join(', ').slice(0, 1000),
                    sentFilePaths.join('; ').slice(0, 1000),
                    deliveryErrors.length > 0 ? deliveryErrors.join(' | ').slice(0, 1000) : null,
                    jobId,
                ]
            );
    
            await writeAuditLog({
                actorUserId: requestedBy,
                entityType: 'saft_job',
                entityId: String(jobId),
                action: 'sent',
                details: {
                    customerId,
                    conversationId: conversationId || null,
                    documentType,
                    fileNames: sentFileNames,
                    structuredPaths: deliveredFiles.map((item) => item.structuredPath).filter(Boolean),
                    cacheHit,
                    bunkerFallback: bunkerTarget.usingFallback,
                    channels: Array.from(deliveredChannels),
                    deliveryWarnings: deliveryErrors,
                },
            });
    
            return res.json({
                success: true,
                jobId,
                status: 'sent',
                documentType,
                fileName: sentFileNames[0] || null,
                files: sentFileNames,
                cacheHit,
                storagePath: sentFilePaths[0] || null,
                storagePaths: sentFilePaths,
                structuredPaths: deliveredFiles.map((item) => item.structuredPath).filter(Boolean),
                bunkerFallback: bunkerTarget.usingFallback,
                channels: Array.from(deliveredChannels),
                warnings: deliveryErrors,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SAFT] Erro ao recolher/enviar documento:', details);
            if (jobId > 0) {
                try {
                    await dbRunAsync(
                        `UPDATE saft_jobs
                         SET status = 'error', error = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [String(details).slice(0, 1000), jobId]
                    );
                } catch (updateError) {
                    console.error('[SAFT] Erro ao atualizar job com falha:', updateError?.message || updateError);
                }
            }
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/saft/sync-company-docs', async (req, res) => {
        const body = req.body || {};
        const customerId = String(body.customerId || '').trim();
        const force = !!body.force;
        const yearsBack = Math.max(1, Math.min(5, Number(body.yearsBack || 3)));
        const requestedTypes = Array.isArray(body.documentTypes) ? body.documentTypes : SAFT_COMPANY_DOC_TYPES;
        const normalizedTypes = Array.from(
            new Set(
                requestedTypes
                    .map((item) => normalizeSaftDocumentType(item))
                    .filter((item) => SAFT_COMPANY_DOC_TYPES.includes(item))
            )
        );

        if (!customerId) {
            return res.status(400).json({ success: false, error: 'customerId é obrigatório.' });
        }
        if (normalizedTypes.length === 0) {
            return res.status(400).json({ success: false, error: 'documentTypes inválido.' });
        }

        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            if (!hasConfiguredCustomerFolder(customer)) {
                return res.status(400).json({
                    success: false,
                    error: 'Cliente sem pasta de documentos definida. Configure a pasta na ficha do cliente antes da recolha documental.',
                });
            }

            const folderPath = resolveCustomerDocumentsFolder(customer.id, customer.documentsFolder || '');
            await ensureWritableFolderTree(folderPath, folderPath);

            const summary = {
                customerId,
                customerName: customer.company || customer.name || '',
                yearsBack,
                totalTypes: normalizedTypes.length,
                syncedFiles: 0,
                skippedFiles: 0,
                notFound: 0,
                warnings: [],
                details: [],
            };
            let declaracaoStatus = null;
            let dossierMetadata = null;
            const ensureDossierMetadata = async () => {
                if (dossierMetadata) return dossierMetadata;
                dossierMetadata = await runSaftDossierMetadata({ customer });
                return dossierMetadata;
            };

            for (const documentType of normalizedTypes) {
                const bunkerTarget = await ensureWritableSaftBunkerFolder(customer, documentType);
                const bunkerFolderPath = bunkerTarget.folderPath;
                const searchFilters = getSaftSearchTokens(documentType, customer);
                const candidateFiles = [];
                const seenCandidatePaths = new Set();
                const pushCandidate = (item, source) => {
                    const fullPath = path.resolve(String(item?.fullPath || ''));
                    const fileName = String(item?.fileName || '').trim();
                    if (!fullPath || !fileName || !fs.existsSync(fullPath)) return;
                    const key = fullPath.toLowerCase();
                    if (seenCandidatePaths.has(key)) return;
                    seenCandidatePaths.add(key);
                    candidateFiles.push({
                        fileName,
                        fullPath,
                        updatedAt: String(item?.updatedAt || nowIso()),
                        source: String(source || 'local'),
                    });
                };

                const cached = await getCachedSaftDocument(customer.id, documentType);
                if (cached) {
                    pushCandidate(
                        {
                            fileName: cached.fileName,
                            fullPath: cached.filePath,
                            updatedAt: cached.updatedAt,
                        },
                        'cache'
                    );
                }
                const bunkerMatches = await findDocumentMatches(bunkerFolderPath, searchFilters);
                bunkerMatches.forEach((match) => pushCandidate(match, 'bunker'));
                const customerMatches = await findDocumentMatches(folderPath, searchFilters);
                customerMatches.forEach((match) => pushCandidate(match, 'customer'));

                const shouldFetchRobot = force || candidateFiles.length === 0;
                if (shouldFetchRobot) {
                    try {
                        const filePathsFromRobot = await runSaftRobotFetch({
                            customer,
                            documentType,
                            folderPath: bunkerFolderPath,
                        });
                        for (const filePathFromRobot of filePathsFromRobot) {
                            pushCandidate(
                                {
                                    fileName: path.basename(filePathFromRobot),
                                    fullPath: filePathFromRobot,
                                    updatedAt: nowIso(),
                                },
                                'robot'
                            );
                        }
                        const refreshedBunkerMatches = await findDocumentMatches(bunkerFolderPath, searchFilters);
                        refreshedBunkerMatches.forEach((match) => pushCandidate(match, 'bunker'));
                    } catch (robotError) {
                        summary.warnings.push(
                            `${saftDocumentLabel(documentType)}: falha no robô (${String(robotError?.message || robotError)}).`
                        );
                    }
                }

                let selected = await selectSaftFilesForDelivery({
                    documentType,
                    candidateFiles,
                    yearsToKeep: yearsBack,
                });

                if (documentType === 'declaracao_nao_divida' && !force) {
                    if (!declaracaoStatus) {
                        try {
                            declaracaoStatus = await ensureDossierMetadata();
                        } catch (metaError) {
                            summary.warnings.push(
                                `Declaração de Não Dívida: falha ao validar estado AT/SS (${String(metaError?.message || metaError)}).`
                            );
                            declaracaoStatus = { situacaoFiscalAt: '', situacaoFiscalSs: '' };
                        }
                    }
                    const atOk = isRegularizadaStatus(declaracaoStatus?.situacaoFiscalAt);
                    const ssOk = isRegularizadaStatus(declaracaoStatus?.situacaoFiscalSs);
                    if (!atOk || !ssOk) {
                        summary.warnings.push(
                            `Declaração de Não Dívida ignorada: estado AT="${declaracaoStatus?.situacaoFiscalAt || '-'}", SS="${declaracaoStatus?.situacaoFiscalSs || '-'}" (necessário Regularizada em ambos).`
                        );
                        selected = [];
                    }

                    if (selected.length > 0) {
                        const freshOnly = selected.filter((item) => {
                            const ageMs = Date.now() - new Date(item.updatedAt || 0).getTime();
                            return Number.isFinite(ageMs) && ageMs <= FOUR_MONTHS_MS;
                        });
                        if (freshOnly.length === 0) {
                            summary.warnings.push(
                                'Declaração de Não Dívida sem ficheiro recente (<= 4 meses). Não foi sincronizada neste ciclo.'
                            );
                            selected = [];
                        } else {
                            selected = freshOnly;
                        }
                    }
                }

                if (selected.length === 0) {
                    summary.skippedFiles += 1;
                    summary.notFound += 1;
                    const missingReason = 'Sem ficheiros elegíveis';
                    summary.details.push({
                        documentType,
                        label: saftDocumentLabel(documentType),
                        synced: 0,
                        skipped: true,
                        reason: missingReason,
                    });
                    await registerSaftSyncJobState({
                        customerId: customer.id,
                        documentType,
                        status: 'missing',
                        error: missingReason,
                        requestedBy: String(body.requestedBy || '').trim() || null,
                    });
                    continue;
                }

                let syncedThisType = 0;
                for (const matchedFile of selected) {
                    const resolvedMatchedPath = path.resolve(String(matchedFile.fullPath || ''));
                    let sourceUpdatedAt = String(matchedFile.updatedAt || '').trim();
                    if (!sourceUpdatedAt) {
                        try {
                            const stat = await fs.promises.stat(resolvedMatchedPath);
                            sourceUpdatedAt = stat.mtime.toISOString();
                        } catch (statError) {
                            sourceUpdatedAt = nowIso();
                        }
                    }
                    if (!dossierMetadata && ['declaracao_nao_divida', 'certidao_permanente', 'certificado_pme', 'crc'].includes(documentType)) {
                        try {
                            dossierMetadata = await ensureDossierMetadata();
                        } catch (metaError) {
                            summary.warnings.push(
                                `${saftDocumentLabel(documentType)}: sem metadados completos (${String(metaError?.message || metaError)}).`
                            );
                            dossierMetadata = dossierMetadata || {};
                        }
                    }
                    const placement = buildSaftArchivePlacement({
                        documentType,
                        customer,
                        sourceFileName: matchedFile.fileName || path.basename(resolvedMatchedPath),
                        sourceUpdatedAt,
                        dossierMetadata,
                    });

                    let bunkerFileName = sanitizeDocumentFileName(placement.fileName || matchedFile.fileName || path.basename(resolvedMatchedPath));
                    if (!bunkerFileName) {
                        bunkerFileName = buildBunkerFileName(documentType, `${documentType}.pdf`);
                    }
                    let bunkerFilePath = path.join(bunkerFolderPath, bunkerFileName);
                    const resolvedBunkerTarget = path.resolve(bunkerFilePath);
                    if (resolvedMatchedPath !== resolvedBunkerTarget) {
                        await fs.promises.copyFile(resolvedMatchedPath, resolvedBunkerTarget);
                    }
                    bunkerFilePath = resolvedBunkerTarget;

                    await upsertSaftDocumentCache({
                        customerId: customer.id,
                        customerNif: customer.nif,
                        documentType,
                        fileName: bunkerFileName,
                        filePath: bunkerFilePath,
                        source:
                            matchedFile.source === 'cache'
                                ? 'cache'
                                : (bunkerTarget.usingFallback ? 'collected_fallback' : 'collected'),
                    });

                    const customerDeliveryPath = path.join(folderPath, bunkerFileName);
                    const sourceForDelivery = path.resolve(bunkerFilePath);
                    if (path.resolve(customerDeliveryPath) !== sourceForDelivery) {
                        await fs.promises.copyFile(sourceForDelivery, customerDeliveryPath);
                    }
                    const structuredPath = await copyToCustomerStructuredFolder({
                        customerFolderPath: folderPath,
                        folderParts: placement.folderParts,
                        fileName: bunkerFileName,
                        sourcePath: sourceForDelivery,
                    });

                    syncedThisType += 1;
                    summary.syncedFiles += 1;
                    summary.details.push({
                        documentType,
                        label: saftDocumentLabel(documentType),
                        fileName: bunkerFileName,
                        storagePath: sourceForDelivery,
                        customerPath: customerDeliveryPath,
                        structuredPath,
                        archiveFolder: Array.isArray(placement.folderParts) ? placement.folderParts.join('/') : '',
                    });
                }

                if (syncedThisType === 0) {
                    summary.skippedFiles += 1;
                    await registerSaftSyncJobState({
                        customerId: customer.id,
                        documentType,
                        status: 'missing',
                        error: 'Sem ficheiros elegíveis',
                        requestedBy: String(body.requestedBy || '').trim() || null,
                    });
                } else {
                    const lastSyncedForType = [...summary.details]
                        .reverse()
                        .find((item) => item.documentType === documentType && !!item.fileName);
                    await registerSaftSyncJobState({
                        customerId: customer.id,
                        documentType,
                        status: 'archived',
                        fileName: String(lastSyncedForType?.fileName || '').trim() || null,
                        filePath: String(lastSyncedForType?.structuredPath || lastSyncedForType?.customerPath || '').trim() || null,
                        requestedBy: String(body.requestedBy || '').trim() || null,
                    });
                }
            }

            await appendSaftSyncLogFile(folderPath, {
                executedAt: nowIso(),
                customerId: customer.id,
                customerName: customer.company || customer.name || '',
                customerNif: String(customer.nif || '').replace(/\D/g, '') || null,
                yearsBack,
                force: !!force,
                summary: {
                    syncedFiles: summary.syncedFiles,
                    skippedFiles: summary.skippedFiles,
                    notFound: summary.notFound,
                    totalTypes: summary.totalTypes,
                },
                details: summary.details,
                warnings: summary.warnings,
            });

            await writeAuditLog({
                actorUserId: String(body.requestedBy || '').trim() || null,
                entityType: 'saft_company_docs_sync',
                entityId: String(customer.id),
                action: 'sync',
                details: summary,
            });

            return res.json({
                success: true,
                ...summary,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SAFT] Erro na sincronização de dados_empresa:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });
    
    app.get('/api/saft/jobs/:customerId', async (req, res) => {
        const customerId = String(req.params.customerId || '').trim();
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }
    
        try {
            const rows = await dbAllAsync(
                `SELECT id, customer_id, conversation_id, document_type, status, file_name, file_path, error, requested_by, created_at, updated_at
                 FROM saft_jobs
                 WHERE customer_id = ?
                   AND status <> 'superseded'
                 ORDER BY datetime(updated_at) DESC, id DESC
                 LIMIT 30`,
                [customerId]
            );
            return res.json({ success: true, data: rows });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SAFT] Erro ao listar jobs:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });
    
    app.get('/api/saft/cache/:customerId', async (req, res) => {
        const customerId = String(req.params.customerId || '').trim();
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }
    
        try {
            const rows = await dbAllAsync(
                `SELECT id, customer_id, customer_nif, document_type, file_name, file_path, source, created_at, updated_at, last_requested_at
                 FROM saft_documents_cache
                 WHERE customer_id = ?
                 ORDER BY datetime(updated_at) DESC`,
                [customerId]
            );
            const data = rows.map((row) => ({
                id: Number(row.id || 0),
                customerId: String(row.customer_id || '').trim(),
                customerNif: String(row.customer_nif || '').trim() || null,
                documentType: String(row.document_type || '').trim(),
                fileName: String(row.file_name || '').trim(),
                filePath: String(row.file_path || '').trim(),
                source: String(row.source || '').trim() || null,
                createdAt: String(row.created_at || '').trim() || null,
                updatedAt: String(row.updated_at || '').trim() || null,
                lastRequestedAt: String(row.last_requested_at || '').trim() || null,
                fileExists: fs.existsSync(String(row.file_path || '').trim()),
            }));
            return res.json({ success: true, data });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SAFT] Erro ao listar cache:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });
}

module.exports = { registerSaftOperationsRoutes };
