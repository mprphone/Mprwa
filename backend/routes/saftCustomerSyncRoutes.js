/**
 * SAFT Customer Sync Routes — extracted from localSyncSaftRoutes.js
 * Routes: /api/users/sync, /api/users/:id/delete, /api/customers/sync,
 *         /api/customers/sync/pull, /api/customers/:id/autologin/financas,
 *         /api/customers/:id/autologin/seg-social
 */
function registerSaftCustomerSyncRoutes(context, helpers) {
    const {
        app, dbGetAsync, parseSourceId, sanitizeRoleValue, upsertLocalUser,
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
    
}

module.exports = { registerSaftCustomerSyncRoutes };
