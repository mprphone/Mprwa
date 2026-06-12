'use strict';

const fs = require('fs');
const path = require('path');
const { collectFinancasAtProfileInOracle } = require('../services/financasAtProfileOracleService');
const { collectCertidaoPermanenteProfile, normalizeCertidaoCode } = require('../services/certidaoPermanenteService');
const portalCredentials = require('../services/autologin/portalCredentials');
const { recipe, recipeUrl, recipeTimeout, recipeSelectors } = require('../services/autologin/portalRecipes');
const { collectIesAfterFinancasLogin, collectModelo22AfterFinancasLogin, collectIrsAfterFinancasLogin } = require('../services/fiscal/portals/financas/financasAnnualService');
const { collectCertidaoAtAfterFinancasLogin } = require('../services/fiscal/portals/financas/financasCertidaoService');
const { collectDomicilioFiscalAfterFinancasLogin } = require('../services/fiscal/portals/financas/financasDomicilioFiscalService');
const { collectCertidaoSsAfterSegSocialLogin, getSegSocialActivationBlock } = require('../services/fiscal/portals/seguranca-social/segurancaSocialCertificateService');
const { collectPmeCertificateAfterIapmeiLogin } = require('../services/fiscal/portals/iapmei/iapmeiPmeCertificateService');
const { cleanText, withTimeout } = require('../services/fiscal/shared/textHelpers');
const { loginToFinancas } = require('../services/fiscal/portals/financas/financasLoginService');
const { loginToSegSocial } = require('../services/fiscal/portals/seguranca-social/segurancaSocialLoginService');

function resolveAtCredentialFromCustomer(customer) {
    return portalCredentials.resolveAtCredential(customer);
}

function resolveIapmeiCredentialFromCustomer(customer) {
    return portalCredentials.resolveIapmeiCredential(customer);
}

function registerAutologinRoutes(context, helpers) {
    const {
        app, writeAuditLog, getLocalCustomerById, upsertLocalCustomer,
        dbGetAsync, dbAllAsync, fetchSupabaseTableColumns, SUPABASE_CLIENTS_SOURCE,
    } = context;
    const {
        hasSupabaseCustomersSync, pushLocalCustomerToSupabase,
        syncLocalCustomerCredentialsToSupabase, parseCustomerSourceId,
        splitSelectorList, resolveAtCredentialForAutologin,
        launchFinancasBrowserWithFallback, activateFinancasNifTab,
        findFirstVisibleSelector, clickContinueLoginIf2faPrompt,
        fillSegSocialCredential, clickSegSocialCredentialSubmit,
        clickSegSocialActivate2faIfRequired, completeSegSocialEmailCodeIfPresent,
        handleSegSocialEmailTwoFactor,
        resolveSsCredentialForAutologin, clickCookieConsentIfPresent,
        openSegSocialLoginEntryIfNeeded, ensureSegSocialCredentialsFormVisible,
        clickContinueWithoutActivatingIfPrompt,
        isFinancasAutologinRunningRef,
    } = helpers;

    const isFinancasAutologinRunning_get = () => isFinancasAutologinRunningRef.value;
    const isFinancasAutologinRunning_set = (v) => { isFinancasAutologinRunningRef.value = v; };

    // ── update-from-at ───────────────────────────────────────────────────────
    app.post('/api/customers/:id/update-from-at', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const body = req.body || {};
        const actorUserId = String(body.actorUserId || '').trim() || null;
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        if (isFinancasAutologinRunning_get()) {
            return res.status(409).json({ success: false, error: 'Já existe uma recolha AT em execução. Aguarde alguns segundos e tente novamente.' });
        }
        isFinancasAutologinRunning_set(true);
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            const credentials = resolveAtCredentialFromCustomer(customer);
            if (!credentials.username || !credentials.password) {
                return res.status(400).json({ success: false, error: 'Este cliente não tem utilizador/senha AT completos na ficha.' });
            }
            const customerNif = cleanText(customer.nif || credentials.username);
            const isCollectiveNif = /^[569]/.test(customerNif);
            const collected = await collectFinancasAtProfileInOracle(credentials, {
                timeoutMs: Number(body.timeoutMs || process.env.PORTAL_FINANCAS_TIMEOUT_MS || 120000) || 120000,
                profileCollectTimeoutMs: Number(body.profileCollectTimeoutMs || 45000) || 45000,
                headless: body.headless !== false,
                nif: customerNif,
                expectedEntityKind: isCollectiveNif ? 'EMPRESA' : 'PARTICULAR',
            });
            const fields = collected?.fields && typeof collected.fields === 'object' ? { ...collected.fields } : {};
            const atProfileWarnings = [];
            const hadExistingManagers = Array.isArray(customer.managers) && customer.managers.length > 0;
            let certidaoFallback = null;
            const certidaoCode = normalizeCertidaoCode(customer.certidaoPermanenteNumero || fields.certidaoPermanenteNumero || '');
            const needsCertidaoManagers = isCollectiveNif && !hadExistingManagers && certidaoCode && !(Array.isArray(fields.managers) && fields.managers.length > 0);
            if (needsCertidaoManagers) {
                try {
                    certidaoFallback = await collectCertidaoPermanenteProfile(certidaoCode, {
                        headless: true,
                        loadTimeoutMs: Number(body.certidaoTimeoutMs || 15000) || 15000,
                    });
                    const certidaoFields = certidaoFallback?.fields && typeof certidaoFallback.fields === 'object' ? certidaoFallback.fields : {};
                    Object.entries(certidaoFields).forEach(([key, value]) => {
                        if (key === 'managers') { if (Array.isArray(value) && value.length > 0) fields.managers = value; return; }
                        if (!cleanText(fields[key]) && cleanText(value)) fields[key] = value;
                    });
                } catch (certidaoError) {
                    certidaoFallback = { success: false, warning: String(certidaoError?.message || certidaoError) };
                }
            }
            if (isCollectiveNif && !hadExistingManagers && !(Array.isArray(fields.managers) && fields.managers.length > 0)) {
                if (certidaoCode) atProfileWarnings.push('Gerência não encontrada na AT; confirme se a Certidão Permanente registada está válida.');
                else atProfileWarnings.push('Gerência não encontrada na AT e sem Certidão Permanente registada para segunda fonte.');
            } else if (needsCertidaoManagers && Array.isArray(fields.managers) && fields.managers.length > 0) {
                atProfileWarnings.push('Gerência obtida pela Certidão Permanente.');
            }
            const updates = {};
            ['morada', 'codigoPostal', 'dataNascimento', 'dataConstituicao', 'inicioAtividade', 'tipoIva', 'caePrincipal', 'caeDescricao', 'caeSecundarios', 'infoAtividades', 'codigoReparticaoFinancas', 'tipoContabilidade', 'certidaoPermanenteValidade'].forEach((key) => {
                const value = cleanText(fields[key]);
                if (value) updates[key] = value;
            });
            const normalizeNif = (value) => { const digits = String(value || '').replace(/\D+/g, ''); return digits.length >= 9 ? digits.slice(-9) : ''; };
            const normalizeManager = (manager) => {
                const name = cleanText(manager?.name || manager?.nome);
                const nif = normalizeNif(manager?.nif || manager?.vat || manager?.taxId || manager?.tax_id);
                const email = String(manager?.email || '').trim().toLowerCase();
                const phone = String(manager?.phone || manager?.telefone || '').trim();
                if (!name && !nif && !email && !phone) return null;
                return { name, nif, email, phone };
            };
            const mergeManagers = (existing = [], incoming = []) => {
                const merged = [];
                const upsert = (manager) => {
                    const normalized = normalizeManager(manager);
                    if (!normalized) return;
                    const key = normalized.nif || cleanText(normalized.name).toLowerCase();
                    const index = merged.findIndex((item) => { const itemKey = item.nif || cleanText(item.name).toLowerCase(); return key && itemKey === key; });
                    const filled = Object.fromEntries(Object.entries(normalized).filter(([, value]) => cleanText(value)));
                    if (index >= 0) merged[index] = { ...merged[index], ...filled };
                    else merged.push(normalized);
                };
                (Array.isArray(existing) ? existing : []).forEach(upsert);
                (Array.isArray(incoming) ? incoming : []).forEach(upsert);
                return merged;
            };
            const collectedManagers = Array.isArray(fields.managers) ? fields.managers : [];
            if (collectedManagers.length > 0) {
                const managers = mergeManagers(customer.managers || [], collectedManagers);
                if (managers.length > 0) updates.managers = managers;
            }
            if (Object.keys(updates).length === 0) {
                return res.status(422).json({ success: false, error: collected?.message || 'Login AT feito, mas não encontrei dados fiscais para atualizar.', sourceUrl: collected?.sourceUrl || '', attempts: collected?.attempts || [] });
            }
            const saved = await upsertLocalCustomer({ ...customer, ...updates, id: customer.id, sourceId: customer.sourceId });
            let supabase = null;
            if (hasSupabaseCustomersSync && hasSupabaseCustomersSync()) {
                try {
                    const tableColumns = await fetchSupabaseTableColumns(SUPABASE_CLIENTS_SOURCE).catch(() => []);
                    supabase = await pushLocalCustomerToSupabase(saved, tableColumns);
                } catch (syncError) {
                    supabase = { success: false, warning: String(syncError?.message || syncError) };
                }
            }
            if (actorUserId) {
                await writeAuditLog({ actorUserId, entityType: 'customer', entityId: customer.id, action: 'update_from_at', details: { fields: updates, sourceUrl: collected?.sourceUrl || '', certidaoSourceUrl: certidaoFallback?.sourceUrl || '' } }).catch(() => null);
            }
            const messageSuffix = atProfileWarnings.length ? ` ${atProfileWarnings.join(' ')}` : '';
            return res.json({ success: true, fields: updates, customer: saved, sourceUrl: collected?.sourceUrl || '', certidaoSourceUrl: certidaoFallback?.sourceUrl || '', warnings: atProfileWarnings, message: `Dados AT atualizados (${Object.keys(updates).length} campo(s)).${messageSuffix}`, supabase });
        } catch (error) {
            console.error('[AT Profile] Erro na recolha:', String(error?.message || error));
            return res.status(500).json({ success: false, error: String(error?.message || error || 'Falha ao recolher dados da AT.') });
        } finally {
            isFinancasAutologinRunning_set(false);
        }
    });

    // ── autologin/financas ───────────────────────────────────────────────────
    app.post('/api/customers/:id/autologin/financas', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const body = req.body || {};
        const actorUserId = String(body.actorUserId || '').trim() || null;
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        if (isFinancasAutologinRunning_get()) {
            return res.status(409).json({ success: false, error: 'Já existe um autologin em execução. Aguarde alguns segundos e tente novamente.' });
        }
        let playwright = null;
        try { playwright = require('playwright'); } catch (error) {
            return res.status(500).json({ success: false, error: 'Playwright não instalado neste ambiente. Execute: npm i playwright && npx playwright install chromium' });
        }
        const financasRecipe = recipe('financas');
        const loginUrl = recipeUrl('financas');
        const targetUrl = recipeUrl('financas', 'target');
        const envHeadless = String(process.env[financasRecipe.headlessEnv] || 'false').trim().toLowerCase() === 'true';
        const hasDesktopSession = Boolean(String(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '').trim());
        const bodyHeadless = body?.headless === true ? true : body?.headless === false ? false : null;
        const headless = bodyHeadless === null ? (hasDesktopSession ? envHeadless : true) : bodyHeadless;
        const forcedHeadlessByServer = bodyHeadless === null && !hasDesktopSession && !envHeadless;
        if (bodyHeadless === false && !hasDesktopSession) {
            return res.status(409).json({ success: false, code: 'NO_GUI_SESSION', error: 'Este servidor não tem sessão gráfica ativa (X11/Wayland), por isso não consegue abrir browser visível aqui.', loginUrl });
        }
        const envCloseAfterSubmit = String(process.env[financasRecipe.closeAfterSubmitEnv] || '').trim().toLowerCase() === 'true';
        const bodyCloseAfterSubmit = body?.closeAfterSubmit === true ? true : body?.closeAfterSubmit === false ? false : null;
        const closeBrowserAfterSubmit = bodyCloseAfterSubmit === null ? envCloseAfterSubmit : bodyCloseAfterSubmit;
        const fiscalCollectionJob = String(body.fiscalCollectionJob || '').trim().toLowerCase();
        const fiscalCollectionYear = String(body.fiscalCollectionYear || body.targetYear || '').trim();
        const timeoutMs = recipeTimeout('financas');
        const financasSelectors = recipeSelectors('financas', splitSelectorList);
        const usernameSelectors = financasSelectors.username;
        const passwordSelectors = financasSelectors.password;
        const submitSelectors = financasSelectors.submit;
        const successSelectors = financasSelectors.success;
        let browser = null;
        let browserLauncherLabel = '';
        let fiscalCollection = null;
        const fiscalTrace = [];
        const traceAt = (...args) => {
            const scope = fiscalCollectionJob ? `fiscal:${fiscalCollectionJob}` : 'autologin';
            console.error('[FiscalAT Login]', scope, ...args);
            fiscalTrace.push(cleanText([scope, ...args].map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')).slice(0, 260));
            if (fiscalTrace.length > 40) fiscalTrace.shift();
        };
        const traceFiscalStep = (...args) => {
            fiscalTrace.push(cleanText(args.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')).slice(0, 260));
            if (fiscalTrace.length > 40) fiscalTrace.shift();
        };
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            const resolvedAt = portalCredentials.resolvePortalCredential(customer, 'financas');
            if (!resolvedAt.username || !resolvedAt.password) {
                return res.status(400).json({ success: false, error: 'Este cliente não tem utilizador/senha AT completos na ficha.' });
            }
            isFinancasAutologinRunning_set(true);
            traceAt('launch browser', { headless, closeBrowserAfterSubmit });
            const launched = await launchFinancasBrowserWithFallback(playwright, { headless, args: headless ? [] : ['--start-maximized'] });
            browser = launched.browser;
            browserLauncherLabel = String(launched.launcherLabel || '').trim();
            const downloadableFiscalJobs = new Set(['ies', 'modelo22', 'irs', 'certidao_at', 'domicilio_fiscal']);
            const contextOptions = { acceptDownloads: downloadableFiscalJobs.has(fiscalCollectionJob) };
            if (!headless) contextOptions.viewport = null;
            const context = await browser.newContext(contextOptions);
            const page = await context.newPage();
            page.setDefaultTimeout(timeoutMs);
            traceAt('start login', loginUrl);
            await loginToFinancas(page, {
                loginUrl, targetUrl,
                username: resolvedAt.username, password: resolvedAt.password,
                usernameSelectors, passwordSelectors, submitSelectors,
                timeoutMs,
            });
            traceAt('login done', page.url());
            if (fiscalCollectionJob === 'ies') {
                traceAt('start fiscal collection');
                fiscalCollection = await withTimeout(collectIesAfterFinancasLogin(page, customer, { targetYears: body.fiscalCollectionYears, targetYear: fiscalCollectionYear, traceLog: traceFiscalStep }), Math.min(110000, timeoutMs + 20000), 'Tempo limite na recolha IES.');
            } else if (fiscalCollectionJob === 'modelo22') {
                traceAt('start fiscal collection');
                fiscalCollection = await withTimeout(collectModelo22AfterFinancasLogin(page, customer, { targetYears: body.fiscalCollectionYears, targetYear: fiscalCollectionYear, traceLog: traceFiscalStep }), Math.min(110000, timeoutMs + 20000), 'Tempo limite na recolha Modelo 22.');
            } else if (fiscalCollectionJob === 'irs') {
                traceAt('start fiscal collection');
                fiscalCollection = await withTimeout(collectIrsAfterFinancasLogin(page, customer, { targetYears: body.fiscalCollectionYears, targetYear: fiscalCollectionYear, traceLog: traceFiscalStep }), Math.min(110000, timeoutMs + 20000), 'Tempo limite na recolha IRS.');
            } else if (fiscalCollectionJob === 'certidao_at') {
                traceAt('start fiscal collection');
                fiscalCollection = await withTimeout(collectCertidaoAtAfterFinancasLogin(page, customer, { atUsername: resolvedAt.username, atPassword: resolvedAt.password }), Math.min(110000, timeoutMs + 20000), 'Tempo limite na recolha Certidão AT.');
            } else if (fiscalCollectionJob === 'domicilio_fiscal') {
                traceAt('start fiscal collection');
                fiscalCollection = await withTimeout(collectDomicilioFiscalAfterFinancasLogin(page, customer), Math.min(110000, timeoutMs + 20000), 'Tempo limite na recolha Domicílio Fiscal.');
            }
            if (fiscalCollectionJob) traceAt('fiscal collection result', fiscalCollection?.status || 'none', fiscalCollection?.message || '');
            const matchedSuccessSelector = await findFirstVisibleSelector(page, successSelectors);
            const hasPasswordInputAfterSubmit = (await page.locator('input[type="password"]').count()) > 0;
            const loginState = matchedSuccessSelector ? 'logged_in' : hasPasswordInputAfterSubmit ? 'needs_manual_validation' : 'unknown';
            await writeAuditLog({ actorUserId, entityType: 'customer', entityId: customer.id, action: 'autologin_financas', details: { loginState, headless, browserLauncherLabel: browserLauncherLabel || null, customerNif: resolvedAt.nif || null, usernameMask: resolvedAt.username ? `***${resolvedAt.username.slice(-3)}` : null, source: resolvedAt.source, fiscalCollectionJob: fiscalCollectionJob || null, fiscalCollectionStatus: fiscalCollection?.status || null } });
            const shouldCloseBrowser = headless || closeBrowserAfterSubmit;
            if (shouldCloseBrowser) { await browser.close().catch(() => null); browser = null; }
            return res.json({ success: true, channel: 'portal_financas', headless, loginState, browserLauncherLabel: browserLauncherLabel || null, forcedHeadlessByServer, fiscalCollection, message: shouldCloseBrowser ? (fiscalCollection?.message || 'Autologin executado. Browser fechado automaticamente.') : 'Autologin iniciado. O browser foi aberto neste computador.', warning: forcedHeadlessByServer ? 'Servidor sem sessão gráfica ativa: autologin executado em modo headless.' : undefined });
        } catch (error) {
            const lastTrace = fiscalTrace.slice(-8).filter(Boolean).join(' | ');
            const details = `${error?.message || error}${lastTrace ? ` Último passo: ${lastTrace}` : ''}`;
            console.error('[AT Autologin] Erro:', details);
            if (browser) await browser.close().catch(() => null);
            return res.status(500).json({ success: false, error: details });
        } finally {
            isFinancasAutologinRunning_set(false);
        }
    });

    // ── autologin/seg-social ─────────────────────────────────────────────────
    app.post('/api/customers/:id/autologin/seg-social', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const body = req.body || {};
        const actorUserId = String(body.actorUserId || '').trim() || null;
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        if (isFinancasAutologinRunning_get()) {
            return res.status(409).json({ success: false, error: 'Já existe um autologin em execução. Aguarde alguns segundos e tente novamente.' });
        }
        let playwright = null;
        try { playwright = require('playwright'); } catch (error) {
            return res.status(500).json({ success: false, error: 'Playwright não instalado neste ambiente. Execute: npm i playwright && npx playwright install chromium' });
        }
        const segSocialRecipe = recipe('segurancaSocial');
        const loginUrl = recipeUrl('segurancaSocial');
        const targetUrl = recipeUrl('segurancaSocial', 'target');
        const envHeadless = String(process.env[segSocialRecipe.headlessEnv] || 'false').trim().toLowerCase() === 'true';
        const hasDesktopSession = Boolean(String(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '').trim());
        const bodyHeadless = body?.headless === true ? true : body?.headless === false ? false : null;
        const headless = bodyHeadless === null ? (hasDesktopSession ? envHeadless : true) : bodyHeadless;
        const forcedHeadlessByServer = bodyHeadless === null && !hasDesktopSession && !envHeadless;
        if (bodyHeadless === false && !hasDesktopSession) {
            return res.status(409).json({ success: false, code: 'NO_GUI_SESSION', error: 'Este servidor não tem sessão gráfica ativa (X11/Wayland), por isso não consegue abrir browser visível aqui.', loginUrl });
        }
        const envCloseAfterSubmit = String(process.env[segSocialRecipe.closeAfterSubmitEnv] || '').trim().toLowerCase() === 'true';
        const bodyCloseAfterSubmit = body?.closeAfterSubmit === true ? true : body?.closeAfterSubmit === false ? false : null;
        const closeBrowserAfterSubmit = bodyCloseAfterSubmit === null ? envCloseAfterSubmit : bodyCloseAfterSubmit;
        const timeoutMs = recipeTimeout('segurancaSocial');
        const fiscalCollectionJob = String(body.fiscalCollectionJob || '').trim().toLowerCase();
        const segSocialSelectors = recipeSelectors('segurancaSocial', splitSelectorList);
        const usernameSelectors = segSocialSelectors.username;
        const passwordSelectors = segSocialSelectors.password;
        const submitSelectors = segSocialSelectors.submit;
        const successSelectors = segSocialSelectors.success;
        let browser = null;
        let browserLauncherLabel = '';
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            const resolvedPrincipalSs = portalCredentials.resolvePortalCredential(customer, 'seg-social');
            const resolvedSubUserSs = portalCredentials.resolvePortalCredential(customer, 'seg-social', { mode: 'subutilizador' });
            // For certidao_ss: prefer subutilizador (has email configured for 2FA); fallback to principal
            const resolvedSs = (resolvedSubUserSs.username && resolvedSubUserSs.password)
                ? resolvedSubUserSs
                : resolvedPrincipalSs;
            console.error('[SS Autologin] usando credencial:', resolvedSs === resolvedSubUserSs ? 'subutilizador' : 'principal', '| user:', resolvedSs.username ? `***${resolvedSs.username.slice(-4)}` : 'N/A');
            if (!resolvedSs.username || !resolvedSs.password) {
                return res.status(400).json({ success: false, error: fiscalCollectionJob ? 'Este cliente não tem subutilizador/senha SS Direta completos para recolha automática.' : 'Este cliente não tem utilizador/senha SS Direta completos na ficha.' });
            }
            isFinancasAutologinRunning_set(true);
            const launched = await launchFinancasBrowserWithFallback(playwright, { headless, args: headless ? [] : ['--start-maximized'], browserExecutablePath: String(process.env.PORTAL_SEG_SOCIAL_BROWSER_EXECUTABLE || '').trim() || undefined });
            browser = launched.browser;
            browserLauncherLabel = String(launched.launcherLabel || '').trim();
            const contextOptions = { acceptDownloads: fiscalCollectionJob === 'certidao_ss' };
            if (!headless) contextOptions.viewport = null;
            const context = await browser.newContext(contextOptions);
            const page = await context.newPage();
            page.setDefaultTimeout(timeoutMs);
            await loginToSegSocial(page, {
                loginUrl, targetUrl,
                username: resolvedSs.username, password: resolvedSs.password,
                usernameSelectors, passwordSelectors,
                timeoutMs,
            });
            let fiscalCollection = null;
            const activationBlock = await getSegSocialActivationBlock(page);
            if (fiscalCollectionJob === 'certidao_ss') {
                fiscalCollection = activationBlock || await withTimeout(collectCertidaoSsAfterSegSocialLogin(page, customer, { ssUsername: resolvedSs.username, ssPassword: resolvedSs.password }), Math.min(130000, timeoutMs + 40000), 'Tempo limite na recolha Certidão SS.');
            }
            const matchedSuccessSelector = await findFirstVisibleSelector(page, successSelectors);
            const hasPasswordInputAfterSubmit = (await page.locator('input[type="password"]').count()) > 0;
            const loginState = matchedSuccessSelector ? 'logged_in' : hasPasswordInputAfterSubmit ? 'needs_manual_validation' : 'unknown';
            await writeAuditLog({ actorUserId, entityType: 'customer', entityId: customer.id, action: 'autologin_seg_social', details: { loginState, headless, browserLauncherLabel: browserLauncherLabel || null, customerNiss: resolvedSs.niss || null, usernameMask: resolvedSs.username ? `***${resolvedSs.username.slice(-3)}` : null, source: resolvedSs.source, fiscalCollectionJob: fiscalCollectionJob || null, fiscalCollectionStatus: fiscalCollection?.status || null } });
            const shouldCloseBrowser = headless || closeBrowserAfterSubmit;
            if (shouldCloseBrowser) { await browser.close().catch(() => null); browser = null; }
            return res.json({ success: true, channel: 'seguranca_social_direta', headless, loginState, browserLauncherLabel: browserLauncherLabel || null, forcedHeadlessByServer, fiscalCollection, message: shouldCloseBrowser ? (fiscalCollection?.message || 'Autologin executado. Browser fechado automaticamente.') : 'Autologin iniciado. O browser foi aberto neste computador.', warning: forcedHeadlessByServer ? 'Servidor sem sessão gráfica ativa: autologin executado em modo headless.' : undefined });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SS Autologin] Erro:', details);
            if (browser) await browser.close().catch(() => null);
            return res.status(500).json({ success: false, error: details });
        } finally {
            isFinancasAutologinRunning_set(false);
        }
    });

    // ── seg-social/subuser/setup ─────────────────────────────────────────────
    app.post('/api/customers/:id/seg-social/subuser/setup', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const body = req.body || {};
        const actorUserId = String(body.actorUserId || '').trim() || null;
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        if (isFinancasAutologinRunning_get()) {
            return res.status(409).json({ success: false, error: 'Já existe uma automação em execução. Aguarde alguns segundos e tente novamente.' });
        }
        let playwright = null;
        try { playwright = require('playwright'); } catch (error) {
            return res.status(500).json({ success: false, error: 'Playwright não instalado neste ambiente. Execute: npm i playwright && npx playwright install chromium' });
        }
        const normalizeText = (value) => String(value || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const todayIso = () => new Date().toISOString().slice(0, 10);
        const addMonthsIso = (months) => { const date = new Date(); date.setMonth(date.getMonth() + months); return date.toISOString().slice(0, 10); };
        const todayPt = () => { const [year, month, day] = todayIso().split('-'); return `${day}/${month}/${year}`; };
        const isSegSocialCredentialLocal = (entry) => { const service = normalizeText(entry?.service); return service === 'ss' || service.includes('seguranca social') || service.includes('seg_social'); };
        const isPrincipalCredential = (entry) => { const credentialType = normalizeText(entry?.credentialType || entry?.credential_type); return isSegSocialCredentialLocal(entry) && (credentialType === 'principal' || (!credentialType && !normalizeText(entry?.status).includes('sub'))); };
        const randomPassword = () => { const crypto = require('crypto'); const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; const suffix = Array.from(crypto.randomBytes(8)).map((byte) => alphabet[byte % alphabet.length]).join(''); return `Mpr${new Date().getFullYear()}!${suffix}`; };
        const upsertCredential = (credentials, next) => {
            const normalizedType = normalizeText(next.credentialType);
            const normalizedService = normalizeText(next.service);
            const normalizedEmail = normalizeText(next.emailAssociado);
            const normalizedUsername = normalizeText(next.username);
            const index = credentials.findIndex((entry) => normalizeText(entry?.service) === normalizedService && normalizeText(entry?.credentialType || entry?.credential_type) === normalizedType && ((normalizedEmail && normalizeText(entry?.emailAssociado || entry?.email_associado) === normalizedEmail) || (normalizedUsername && normalizeText(entry?.username) === normalizedUsername)));
            if (index >= 0) credentials[index] = { ...credentials[index], ...next };
            else credentials.push(next);
            return credentials;
        };
        const clickFirst = async (page, builders, timeoutMs = 2500) => {
            for (const build of builders) {
                try {
                    const locator = build().first();
                    if ((await locator.count()) <= 0) continue;
                    if (!(await locator.isVisible().catch(() => false))) continue;
                    await locator.click({ timeout: timeoutMs });
                    await page.waitForTimeout(700);
                    return true;
                } catch { /* continua */ }
            }
            return false;
        };
        const fillFirst = async (page, builders, value) => {
            for (const build of builders) {
                try {
                    const locator = build().first();
                    if ((await locator.count()) <= 0) continue;
                    if (!(await locator.isVisible().catch(() => false))) continue;
                    await locator.fill(String(value || ''), { timeout: 2500 });
                    return true;
                } catch { /* continua */ }
            }
            return false;
        };
        const loginUrl = String(process.env.PORTAL_SEG_SOCIAL_LOGIN_URL || 'https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin').trim();
        const envHeadless = String(process.env.PORTAL_SEG_SOCIAL_HEADLESS || 'false').trim().toLowerCase() === 'true';
        const hasDesktopSession = Boolean(String(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '').trim());
        const bodyHeadless = body?.headless === true ? true : body?.headless === false ? false : null;
        const headless = bodyHeadless === null ? (hasDesktopSession ? envHeadless : true) : bodyHeadless;
        const forcedHeadlessByServer = bodyHeadless === null && !hasDesktopSession && !envHeadless;
        if (bodyHeadless === false && !hasDesktopSession) {
            return res.status(409).json({ success: false, code: 'NO_GUI_SESSION', error: 'Este servidor não tem sessão gráfica ativa (X11/Wayland), por isso não consegue abrir browser visível aqui.', loginUrl });
        }
        const closeBrowserAfterSubmit = body?.closeAfterSubmit === true;
        const timeoutMs = Math.max(30000, Math.min(240000, Number(process.env.PORTAL_SEG_SOCIAL_TIMEOUT_MS || 120000) || 120000));
        const usernameSelectors = splitSelectorList(process.env.PORTAL_SEG_SOCIAL_USERNAME_SELECTOR, 'input[name="username"], input[name="niss"], input[id*="username" i], input[name*="user" i], input[id*="utilizador" i], input[name*="utilizador" i], input[id*="niss" i], input[placeholder*="NISS" i], input[autocomplete="username"]');
        const passwordSelectors = splitSelectorList(process.env.PORTAL_SEG_SOCIAL_PASSWORD_SELECTOR, 'input[name="password"], input[id*="password" i], input[placeholder*="senha" i], input[type="password"]');
        const submitSelectors = splitSelectorList(process.env.PORTAL_SEG_SOCIAL_SUBMIT_SELECTOR, 'button[type="submit"], input[type="submit"], button:has-text("Entrar"), button:has-text("Iniciar sessão"), button:has-text("Autenticar"), button:has-text("Continuar")');
        let browser = null;
        let browserLauncherLabel = '';
        let shouldKeepBrowserOpen = false;
        let stage = 'started';
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            const credentials = Array.isArray(customer.accessCredentials) ? customer.accessCredentials.map((entry) => ({ ...entry })) : [];
            const principal = credentials.find(isPrincipalCredential) || null;
            const niss = String(customer.niss || '').replace(/\D/g, '').trim();
            const principalUsername = String(principal?.username || niss || '').trim();
            const principalPassword = String(principal?.password || customer.senhaSegurancaSocial || '').trim();
            if (!principalUsername || !principalPassword) {
                return res.status(400).json({ success: false, error: 'Este cliente precisa de utilizador/senha principal da Segurança Social antes de criar subutilizador.' });
            }
            const subEmail = String(body.subEmail || process.env.SEG_SOCIAL_SUBUSER_EMAIL || 'geral@mpr.pt').trim().toLowerCase();
            const subUsername = niss ? `${niss}_1` : subEmail;
            const subPassword = randomPassword();
            const now = todayIso();
            const validUntil = addMonthsIso(6);
            const nextCredentials = upsertCredential(credentials, { service: 'Segurança Social', credentialType: 'subutilizador', username: subUsername, password: subPassword, emailAssociado: subEmail, validFrom: now, validUntil: '', status: 'pending', observacoes: 'Subutilizador criado/ativado pelo assistente. Confirmar no portal antes de usar em produção.' });
            upsertCredential(nextCredentials, { service: 'Segurança Social', credentialType: '2fa', username: subUsername, password: '', emailAssociado: subEmail, validFrom: now, validUntil: '', status: 'pending', observacoes: 'Ativar 2FA do subutilizador com código recebido por email.' });
            upsertCredential(nextCredentials, { service: 'Segurança Social', credentialType: 'chave_aplicacional', username: subUsername, password: '', emailAssociado: subEmail, validFrom: now, validUntil, status: 'pending', observacoes: 'Gerar a chave aplicacional no portal e copiar no momento em que aparece.' });
            await upsertLocalCustomer({ ...customer, accessCredentials: nextCredentials });
            isFinancasAutologinRunning_set(true);
            const launched = await launchFinancasBrowserWithFallback(playwright, { headless, args: headless ? [] : ['--start-maximized'], browserExecutablePath: String(process.env.PORTAL_SEG_SOCIAL_BROWSER_EXECUTABLE || '').trim() || undefined });
            browser = launched.browser;
            browserLauncherLabel = String(launched.launcherLabel || '').trim();
            const contextOptions = { acceptDownloads: false };
            if (!headless) contextOptions.viewport = null;
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
            if (!usernameSelector || !passwordSelector || !submitSelector) throw new Error('Não foi possível localizar os campos de login da SS Direta.');
            await page.fill(usernameSelector, principalUsername);
            await page.fill(passwordSelector, principalPassword);
            const twoFaSinceIso2 = new Date(Date.now() - 2 * 60 * 1000).toISOString();
            await Promise.allSettled([page.waitForLoadState('networkidle', { timeout: Math.min(30000, timeoutMs) }), page.locator(submitSelector).first().click()]);
            await clickContinueLoginIf2faPrompt(page, Math.min(12000, timeoutMs));
            await handleSegSocialEmailTwoFactor(page, twoFaSinceIso2, 120000);
            await clickContinueWithoutActivatingIfPrompt(page, Math.min(18000, timeoutMs));
            stage = 'gestao_acessos';
            await clickFirst(page, [() => page.getByRole('button', { name: /perfil|utilizador|área de acesso|area de acesso/i }), () => page.getByRole('link', { name: /perfil|utilizador|área de acesso|area de acesso/i }), () => page.locator('button, a, [role="button"]', { hasText: /perfil|utilizador|área de acesso|area de acesso/i })], 3500);
            await clickFirst(page, [() => page.getByRole('link', { name: /gest[aã]o de acessos?/i }), () => page.getByRole('button', { name: /gest[aã]o de acessos?/i }), () => page.locator('a, button, [role="button"]', { hasText: /gest[aã]o de acessos?/i })], 3500);
            await clickFirst(page, [() => page.getByRole('link', { name: /gerir subcontas|subcontas|subconta|utilizadores de empresa/i }), () => page.getByRole('button', { name: /gerir subcontas|subcontas|subconta|utilizadores de empresa/i }), () => page.locator('a, button, [role="button"]', { hasText: /gerir subcontas|subcontas|subconta|utilizadores de empresa/i })], 3500);
            await clickFirst(page, [() => page.getByRole('button', { name: /adicionar utilizador|adicionar subconta|adicionar/i }), () => page.getByRole('link', { name: /adicionar utilizador|adicionar subconta|adicionar/i }), () => page.locator('button, a, [role="button"]', { hasText: /adicionar utilizador|adicionar subconta|adicionar/i })], 3500);
            stage = 'preencher_subutilizador';
            await fillFirst(page, [() => page.getByLabel(/nome/i), () => page.locator('input[name*="nome" i], input[id*="nome" i], input[placeholder*="nome" i]')], customer.company || customer.name || 'MPR');
            await fillFirst(page, [() => page.getByLabel(/email|e-mail|correio/i), () => page.locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]')], subEmail);
            await fillFirst(page, [() => page.getByLabel(/data.*in[ií]cio|in[ií]cio/i), () => page.locator('input[name*="inicio" i], input[id*="inicio" i], input[placeholder*="início" i], input[placeholder*="inicio" i]')], todayPt());
            await fillFirst(page, [() => page.getByLabel(/data.*fim|fim/i), () => page.locator('input[name*="fim" i], input[id*="fim" i], input[placeholder*="fim" i]')], '');
            const clickedNext = await clickFirst(page, [() => page.getByRole('button', { name: /seguinte|continuar|pr[oó]ximo/i }), () => page.locator('button, input[type="submit"], a', { hasText: /seguinte|continuar|pr[oó]ximo/i })], 3500);
            if (clickedNext) {
                stage = 'confirmar_criacao';
                await clickFirst(page, [() => page.getByRole('button', { name: /confirmar|submeter|criar|adicionar/i }), () => page.locator('button, input[type="submit"], a', { hasText: /confirmar|submeter|criar|adicionar/i })], 3500);
            }
            await writeAuditLog({ actorUserId, entityType: 'customer', entityId: customer.id, action: 'seg_social_subuser_setup', details: { stage, headless, subEmail, subUsername, validUntil, browserLauncherLabel: browserLauncherLabel || null } });
            const shouldCloseBrowser = headless || closeBrowserAfterSubmit;
            shouldKeepBrowserOpen = !shouldCloseBrowser;
            if (shouldCloseBrowser) { await browser.close().catch(() => null); browser = null; }
            return res.json({ success: true, channel: 'seguranca_social_direta', stage, headless, forcedHeadlessByServer, subEmail, subUsername, appKeyValidUntil: validUntil, message: shouldCloseBrowser ? 'Assistente de subutilizador executado e credenciais pendentes guardadas.' : 'Assistente iniciado. O browser ficou aberto para confirmares a criação, ativação, 2FA e chave aplicacional.' });
        } catch (error) {
            const details = error?.message || error;
            console.error('[SS Subutilizador] Erro:', details);
            if (browser && !shouldKeepBrowserOpen) await browser.close().catch(() => null);
            return res.status(500).json({ success: false, stage, error: details });
        } finally {
            isFinancasAutologinRunning_set(false);
        }
    });

    // ── autologin/iefp ───────────────────────────────────────────────────────
    app.post('/api/customers/:id/autologin/iefp', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        if (isFinancasAutologinRunning_get()) return res.status(409).json({ success: false, error: 'Já existe um autologin em execução. Aguarde e tente novamente.' });
        let playwright = null;
        try { playwright = require('playwright'); } catch { return res.status(500).json({ success: false, error: 'Playwright não instalado.' }); }
        const timeoutMs = recipeTimeout('iefp');
        const iefpUrl = recipeUrl('iefp');
        const iefpSelectors = recipeSelectors('iefp', splitSelectorList);
        const usernameSelectors = iefpSelectors.username;
        const passwordSelectors = iefpSelectors.password;
        const submitSelectors = iefpSelectors.submit;
        let browser = null;
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            const resolvedSs = portalCredentials.resolvePortalCredential(customer, 'iefp');
            if (!resolvedSs.username || !resolvedSs.password) return res.status(400).json({ success: false, error: 'Cliente sem credenciais SS Direta.' });
            isFinancasAutologinRunning_set(true);
            const launched = await launchFinancasBrowserWithFallback(playwright, { headless: true, args: [] });
            browser = launched.browser;
            const context = await browser.newContext({ acceptDownloads: false });
            const page = await context.newPage();
            page.setDefaultTimeout(timeoutMs);
            await page.goto(iefpUrl, { waitUntil: 'domcontentloaded' });
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
            const ssSelectors = ['img[alt*="Segurança Social" i]', 'img[src*="seguranca_social" i]', 'img[src*="logoss" i]', 'a:has-text("Segurança Social")', 'button:has-text("Segurança Social")'];
            for (const sel of ssSelectors) {
                const el = page.locator(sel).first();
                if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
                    const parent = await el.evaluate((node) => node.closest('a, button, [role="button"]')?.tagName || '');
                    if (parent) await page.locator(`${parent.toLowerCase()}:has(${sel})`).first().click().catch(() => el.click());
                    else await el.click();
                    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);
                    break;
                }
            }
            if (/seg-social\.pt/i.test(page.url())) {
                await clickCookieConsentIfPresent(page, 2500);
                await openSegSocialLoginEntryIfNeeded(page, 12000);
                await ensureSegSocialCredentialsFormVisible(page, 12000);
                const usernameSelector = await findFirstVisibleSelector(page, usernameSelectors);
                const passwordSelector = await findFirstVisibleSelector(page, passwordSelectors);
                const submitSelector = await findFirstVisibleSelector(page, submitSelectors);
                if (usernameSelector && passwordSelector && submitSelector) {
                    await page.fill(usernameSelector, resolvedSs.username);
                    await page.fill(passwordSelector, resolvedSs.password);
                    const twoFaSince = new Date(Date.now() - 2 * 60 * 1000).toISOString();
                    await Promise.allSettled([page.waitForLoadState('networkidle', { timeout: 30000 }), page.locator(submitSelector).first().click()]);
                    await clickContinueLoginIf2faPrompt(page, 12000);
                    await handleSegSocialEmailTwoFactor(page, twoFaSince, 120000);
                    await clickContinueWithoutActivatingIfPrompt(page, 18000);
                }
            }
            await browser.close().catch(() => null);
            browser = null;
            return res.json({ success: true, message: 'IEFP: acesso iniciado em segundo plano.' });
        } catch (error) {
            if (browser) await browser.close().catch(() => null);
            console.error('[IEFP Autologin] Erro:', error?.message || error);
            return res.status(500).json({ success: false, error: String(error?.message || error) });
        } finally {
            isFinancasAutologinRunning_set(false);
        }
    });

    // ── autologin/viactt ─────────────────────────────────────────────────────
    app.post('/api/customers/:id/autologin/viactt', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        if (isFinancasAutologinRunning_get()) return res.status(409).json({ success: false, error: 'Já existe um autologin em execução. Aguarde e tente novamente.' });
        let playwright = null;
        try { playwright = require('playwright'); } catch { return res.status(500).json({ success: false, error: 'Playwright não instalado.' }); }
        const timeoutMs = recipeTimeout('viactt');
        const viacttUrl = recipeUrl('viactt');
        let browser = null;
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            const viacttCred = portalCredentials.resolvePortalCredential(customer, 'viactt');
            if (!viacttCred.username || !viacttCred.password) return res.status(400).json({ success: false, error: 'Cliente sem credenciais ViaCTT na ficha.' });
            isFinancasAutologinRunning_set(true);
            const launched = await launchFinancasBrowserWithFallback(playwright, { headless: true, args: [] });
            browser = launched.browser;
            const context = await browser.newContext({ acceptDownloads: false });
            const page = await context.newPage();
            page.setDefaultTimeout(timeoutMs);
            await page.goto(viacttUrl, { waitUntil: 'domcontentloaded' });
            const viacttSelectors = recipeSelectors('viactt', splitSelectorList);
            const usernameSelector = await findFirstVisibleSelector(page, viacttSelectors.username);
            const passwordSelector = await findFirstVisibleSelector(page, viacttSelectors.password);
            const submitSelector = await findFirstVisibleSelector(page, viacttSelectors.submit);
            if (usernameSelector && passwordSelector && submitSelector) {
                await page.fill(usernameSelector, String(viacttCred.username));
                await page.fill(passwordSelector, String(viacttCred.password));
                await Promise.allSettled([page.waitForLoadState('networkidle', { timeout: 30000 }), page.locator(submitSelector).first().click()]);
            }
            await browser.close().catch(() => null);
            browser = null;
            return res.json({ success: true, message: 'ViaCTT: acesso iniciado em segundo plano.' });
        } catch (error) {
            if (browser) await browser.close().catch(() => null);
            console.error('[ViaCTT Autologin] Erro:', error?.message || error);
            return res.status(500).json({ success: false, error: String(error?.message || error) });
        } finally {
            isFinancasAutologinRunning_set(false);
        }
    });

    // ── autologin/bportugal – callback da extensão Chrome (recebe PDF) ────────
    app.post('/api/customers/:id/fiscal/bportugal-pdf-callback', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        const { pdfBase64 } = req.body || {};
        if (!pdfBase64) return res.status(400).json({ success: false, error: 'PDF em falta.' });
        try {
            const pdfBuffer = Buffer.from(pdfBase64, 'base64');
            if (pdfBuffer.slice(0, 4).toString('latin1') !== '%PDF') {
                return res.status(400).json({ success: false, error: 'Ficheiro não é PDF válido.' });
            }
            const customer = await getLocalCustomerById(customerId);
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            const year = String(new Date().getFullYear());
            const { buildFiscalDownloadPath, uniquePath } = require('../services/fiscal/documents/documentNamingService');
            const { applyBancoPortugal } = require('../services/fiscal/summary/documentosSummaryUpdater');
            const dest = uniquePath(buildFiscalDownloadPath(customer, year, 'bportugal', 'responsabilidades.pdf'));
            const fsNode = require('fs/promises');
            const pathNode = require('path');
            await fsNode.mkdir(pathNode.dirname(dest), { recursive: true }).catch(() => null);
            await fsNode.writeFile(dest, pdfBuffer);
            // Guardar registo no ficheiro de estado para o fiscal robot reconhecer na próxima execução
            const markerPath = dest.replace(/\.pdf$/i, '.ext_collected.json');
            await fsNode.writeFile(markerPath, JSON.stringify({
                ficheiroPdf: dest, collectedAt: new Date().toISOString(), source: 'chrome_extension',
            })).catch(() => null);
            console.error('[BPortugal Callback] PDF guardado:', dest);
            return res.json({ success: true, ficheiroPdf: dest });
        } catch (err) {
            console.error('[BPortugal Callback] Erro:', err?.message);
            return res.status(500).json({ success: false, error: String(err?.message || err) });
        }
    });

    // ── autologin/bportugal ──────────────────────────────────────────────────
    app.post('/api/customers/:id/autologin/bportugal', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        const body = req.body || {};
        const trace = (...args) => console.error('[BPortugal]', ...args);
        const bportalUrl = 'https://clientebancario.bportugal.pt/pt-pt/responsabilidades-de-credito';

        // Modo extensão Chrome: resolver credenciais e devolvê-las para o frontend acionar a extensão
        if (body.useExtension) {
            try {
                const customer = await getLocalCustomerById(customerId);
                if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
                const resolvedAt = portalCredentials.resolvePortalCredential(customer, 'bportugal');
                if (!resolvedAt.username || !resolvedAt.password) {
                    return res.status(400).json({ success: false, error: 'Cliente sem credenciais Banco Portugal.' });
                }
                return res.json({
                    success: true,
                    useExtension: true,
                    credentialForExtension: {
                        username: resolvedAt.username,
                        password: resolvedAt.password,
                        loginUrl: bportalUrl,
                        credentialLabel: 'BPortugal',
                        collectBpCrc: true,
                        customerId,
                        keepPendingAfterSubmit: true,
                    },
                });
            } catch (err) {
                return res.status(500).json({ success: false, error: String(err?.message || err) });
            }
        }

        if (isFinancasAutologinRunning_get()) return res.status(409).json({ success: false, error: 'Já existe um autologin em execução. Aguarde e tente novamente.' });
        let playwright = null;
        try { playwright = require('playwright'); } catch { return res.status(500).json({ success: false, error: 'Playwright não instalado.' }); }
        const bportugalSelectors = recipeSelectors('bportugal', splitSelectorList);
        const usernameSelectors = bportugalSelectors.username;
        const passwordSelectors = bportugalSelectors.password;
        const submitSelectors = bportugalSelectors.submit;
        let browser = null;
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            const resolvedAt = portalCredentials.resolvePortalCredential(customer, 'bportugal');
            if (!resolvedAt.username || !resolvedAt.password) return res.status(400).json({ success: false, error: 'Cliente sem credenciais Banco Portugal.' });
            isFinancasAutologinRunning_set(true);
            // playwright-extra + stealth para ultrapassar Cloudflare em clientebancario.bportugal.pt
            let chromium;
            try {
                const { chromium: pwExtraChromium } = require('playwright-extra');
                const stealthPlugin = require('puppeteer-extra-plugin-stealth');
                pwExtraChromium.use(stealthPlugin());
                chromium = pwExtraChromium;
            } catch (_) {
                chromium = playwright.chromium;
            }
            browser = await chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
            });
            const context = await browser.newContext({
                acceptDownloads: true,
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                viewport: { width: 1366, height: 768 },
                extraHTTPHeaders: { 'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8' },
            });
            const page = await context.newPage();
            page.setDefaultTimeout(90000);

            // Step 1: ir directamente à página CRC
            trace('a navegar para CRC:', bportalUrl);
            await page.goto(bportalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);
            trace('url após goto:', page.url());

            // Cloudflare challenge — se presente, abortar imediatamente (IP do servidor é bloqueado)
            const bodyText0 = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
            if (/verificar se a liga|checking if the site connection is secure/i.test(bodyText0)) {
                trace('Cloudflare challenge detectado — IP do servidor bloqueado. A abortar.');
                await browser.close().catch(() => null);
                browser = null;
                return res.status(503).json({
                    success: false,
                    error: 'O portal Banco de Portugal bloqueou o acesso automático (Cloudflare). Use o botão de acesso directo para abrir no seu browser.',
                });
            }

            // Step 2: STS bportugal — clicar "Autenticação AT"
            if (/sts\.bportugal\.pt|login\.bportugal\.pt/i.test(page.url())) {
                trace('em STS bportugal — a procurar botão Autenticação AT');
                for (const sel of [
                    'button:has-text("Autenticação AT")', 'a:has-text("Autenticação AT")',
                    'button:has-text("Autenticação.Gov")', 'a:has-text("Autenticação.Gov")',
                    '[data-idp="at"]', 'button[id*="AT"]',
                ]) {
                    const btn = page.locator(sel).first();
                    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
                        trace('a clicar botão AT:', sel);
                        await btn.click();
                        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);
                        break;
                    }
                }
                trace('url após STS click:', page.url());
            }

            // Step 3: acesso.gov.pt — preencher NIF e password
            if (/acesso\.gov\.pt/i.test(page.url())) {
                trace('em acesso.gov.pt — a preencher credenciais');
                await activateFinancasNifTab(page);
                const usernameSelector = await findFirstVisibleSelector(page, usernameSelectors);
                const passwordSelector = await findFirstVisibleSelector(page, passwordSelectors);
                const submitSelector = await findFirstVisibleSelector(page, submitSelectors);
                trace('selectors encontrados — user:', usernameSelector, '| pass:', passwordSelector, '| submit:', submitSelector);
                if (usernameSelector && passwordSelector && submitSelector) {
                    await page.fill(usernameSelector, resolvedAt.username);
                    await page.fill(passwordSelector, resolvedAt.password);
                    await Promise.allSettled([
                        page.waitForLoadState('networkidle', { timeout: 30000 }),
                        page.locator(submitSelector).first().click(),
                    ]);
                    await clickContinueLoginIf2faPrompt(page, 12000);
                }
                trace('url após login acesso.gov:', page.url());
            }

            // Step 4: garantir que estamos na página CRC (pode ter sido redireccionado após login)
            await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => null);
            await page.waitForTimeout(1500);
            trace('url após login completo:', page.url());

            if (!/clientebancario\.bportugal\.pt.*responsabilidades/i.test(page.url())) {
                trace('não está na CRC — a navegar de volta');
                await page.goto(bportalUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
                await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
                await page.waitForTimeout(1000);
                trace('url após re-navegar CRC:', page.url());
            }

            let pageText = cleanText(await page.locator('body').innerText({ timeout: 8000 }).catch(() => ''));
            trace('texto CRC (300):', pageText.slice(0, 300));

            // Clicar num elemento pelo texto (inline, sem depender de clickFinancasText)
            const clickByText = async (patterns, timeoutMs = 5000) => {
                const result = await page.evaluate((pats) => {
                    const fold = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
                    const matchers = pats.map((p) => p.type === 'regex' ? new RegExp(p.source, p.flags) : null);
                    const textM = pats.filter((p) => p.type === 'text').map((p) => p.value.toLowerCase());
                    for (const sel of ['a,button,input[type="button"],input[type="submit"],label', 'span,div,td,li']) {
                        let best = null;
                        for (const el of Array.from(document.querySelectorAll(sel))) {
                            const r = el.getBoundingClientRect();
                            if (r.width === 0 && r.height === 0) continue;
                            const s = window.getComputedStyle(el);
                            if (s.display === 'none' || s.visibility === 'hidden') continue;
                            const txt = fold(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '');
                            const matched = matchers.some((re) => re && re.test(txt)) || textM.some((t) => txt.includes(t));
                            if (!matched) continue;
                            if (!best || txt.length < best.len) best = { el, len: txt.length };
                        }
                        if (best) { best.el.scrollIntoView({ block: 'center' }); best.el.click(); return true; }
                    }
                    return false;
                }, patterns.map((p) => p instanceof RegExp ? { type: 'regex', source: p.source, flags: p.flags } : { type: 'text', value: String(p) })).catch(() => false);
                if (result) await Promise.race([page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }), page.waitForTimeout(timeoutMs)]).catch(() => null);
                return result;
            };

            // Step 5: marcar checkbox "Li e aceito..."
            const checkboxClicked = await page.evaluate(() => {
                const inputs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
                const cb = inputs.find((el) => {
                    const label = document.querySelector(`label[for="${el.id}"]`) || el.closest('label');
                    const text = (label?.innerText || label?.textContent || el.getAttribute('aria-label') || '').toLowerCase();
                    return /li e aceito|aceito as condi|politica de dados/i.test(text);
                });
                if (cb && !cb.checked) { cb.click(); return true; }
                if (cb && cb.checked) return true;
                return false;
            }).catch(() => false);
            trace('checkbox clicked via input:', checkboxClicked);

            if (!checkboxClicked) {
                await clickByText([/Li\s+e\s+aceito/i, /aceito\s+as\s+condi[cç][oõ]es/i, /pol[ií]tica\s+de\s+dados/i]);
                trace('checkbox clicked via texto fallback');
            }
            await page.waitForTimeout(800);
            pageText = cleanText(await page.locator('body').innerText({ timeout: 8000 }).catch(() => ''));
            trace('texto após checkbox (200):', pageText.slice(0, 200));

            // Step 6: clicar "Obter mapa" e capturar download
            let ficheiroPdf = '';
            const year = String(new Date().getFullYear());
            try {
                const downloadPromise = context.waitForEvent('download', { timeout: 40000 });
                await clickByText([/Obter\s+Mapa/i, /Obter\s+Relat[oó]rio/i, /Descarregar\s+Mapa/i]);
                trace('a aguardar download...');
                const download = await downloadPromise;
                ficheiroPdf = await saveFiscalDownload(download, customer, year, 'bportugal');
                trace('PDF guardado:', ficheiroPdf);
            } catch (dlErr) {
                trace('download falhou:', dlErr?.message);
            }

            const fiscalCollection = {
                status: ficheiroPdf ? 'completed' : 'needs_review',
                ficheiroPdf,
                dataValidade: '',
                valida: Boolean(ficheiroPdf),
                message: ficheiroPdf
                    ? 'Mapa de Responsabilidades BPortugal guardado na pasta do cliente.'
                    : 'Não foi possível descarregar o Mapa de Responsabilidades. Validar acesso manual ao portal.',
                pageTextSample: pageText.slice(0, 500),
            };
            await browser.close().catch(() => null);
            browser = null;
            return res.json({ success: true, message: fiscalCollection.message, fiscalCollection });
        } catch (error) {
            if (browser) await browser.close().catch(() => null);
            console.error('[BPortugal Autologin] Erro:', error?.message || error);
            return res.status(500).json({ success: false, error: String(error?.message || error) });
        } finally {
            isFinancasAutologinRunning_set(false);
        }
    });

    // ── autologin/pme ────────────────────────────────────────────────────────
    app.post('/api/customers/:id/autologin/pme', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const body = req.body || {};
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        if (isFinancasAutologinRunning_get()) return res.status(409).json({ success: false, error: 'Já existe um autologin em execução. Aguarde e tente novamente.' });
        let playwright = null;
        try { playwright = require('playwright'); } catch { return res.status(500).json({ success: false, error: 'Playwright não instalado.' }); }
        const timeoutMs = recipeTimeout('iapmei');
        const iapmeiUrl = recipeUrl('iapmei');
        let browser = null;
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            const resolvedIapmei = portalCredentials.resolvePortalCredential(customer, 'iapmei');
            if (!resolvedIapmei.username || !resolvedIapmei.password) return res.status(400).json({ success: false, error: 'Cliente sem credenciais IAPMEI/PME.' });
            isFinancasAutologinRunning_set(true);
            const launched = await launchFinancasBrowserWithFallback(playwright, { headless: body.headless !== false, args: [] });
            browser = launched.browser;
            const context = await browser.newContext({ acceptDownloads: true });
            const page = await context.newPage();
            page.setDefaultTimeout(timeoutMs);
            await page.goto(iapmeiUrl, { waitUntil: 'domcontentloaded' });
            await clickCookieConsentIfPresent(page, 2500);
            const iapmeiSelectors = recipeSelectors('iapmei', splitSelectorList);
            const nifSelector = await findFirstVisibleSelector(page, iapmeiSelectors.username);
            const passSelector = await findFirstVisibleSelector(page, iapmeiSelectors.password);
            const submitSelector = await findFirstVisibleSelector(page, iapmeiSelectors.submit);
            if (nifSelector && passSelector && submitSelector) {
                const nif = resolvedIapmei.nif || resolvedIapmei.username;
                await page.fill(nifSelector, nif);
                await page.fill(passSelector, resolvedIapmei.password);
                await Promise.allSettled([page.waitForLoadState('networkidle', { timeout: 30000 }), page.locator(submitSelector).first().click()]);
            }
            const fiscalCollection = await collectPmeCertificateAfterIapmeiLogin(page, customer).catch((error) => ({ status: 'needs_review', message: `PME: ${cleanText(error?.message || error)}`, ficheiroPdf: '' }));
            await browser.close().catch(() => null);
            browser = null;
            return res.json({ success: true, message: fiscalCollection?.message || 'IAPMEI PME: recolha concluída.', fiscalCollection });
        } catch (error) {
            if (browser) await browser.close().catch(() => null);
            console.error('[IAPMEI PME Autologin] Erro:', error?.message || error);
            return res.status(500).json({ success: false, error: String(error?.message || error) });
        } finally {
            isFinancasAutologinRunning_set(false);
        }
    });
}

module.exports = { registerAutologinRoutes };
