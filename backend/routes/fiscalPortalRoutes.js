'use strict';

const { recipe, recipeUrl, recipeTimeout, recipeSelectors } = require('../services/autologin/portalRecipes');
const portalCredentials = require('../services/autologin/portalCredentials');
const { launchFinancasBrowserWithFallback } = require('../services/fiscal/shared/browserFactory');
const { findFirstVisibleSelector } = require('../services/fiscal/shared/playwrightHelpers');
const { loginToFinancas } = require('../services/fiscal/portals/financas/financasLoginService');
const { loginToSegSocial } = require('../services/fiscal/portals/seguranca-social/segurancaSocialLoginService');
const { collectCertidaoAtAfterFinancasLogin } = require('../services/fiscal/portals/financas/financasCertidaoService');
const { collectDomicilioFiscalAfterFinancasLogin } = require('../services/fiscal/portals/financas/financasDomicilioFiscalService');
const { collectIesAfterFinancasLogin, collectModelo22AfterFinancasLogin } = require('../services/fiscal/portals/financas/financasAnnualService');
const { collectCertidaoSsAfterSegSocialLogin, getSegSocialActivationBlock } = require('../services/fiscal/portals/seguranca-social/segurancaSocialCertificateService');
const { runFiscalCollector } = require('../services/fiscal');
const { withTimeout } = require('../services/fiscal/shared/textHelpers');
const { completedResponse, needsReviewResponse, loginFailedResponse, failedResponse } = require('../services/fiscal/shared/fiscalResponse');
const { saveFailureDiagnostics, clearFailureDiagnostics, loadFailureDiagnostics, listFailureDiagnostics } = require('../services/fiscal/diagnostics/diagnosticsPersistence');
const { capturePageSnapshot } = require('../services/fiscal/diagnostics/pageSnapshotService');
const { mergeFiscalSummaryData } = require('../services/fiscal/config/fiscalSummaryDefaults');
const { applyCertidaoAt } = require('../services/fiscal/summary/certidoesSummaryUpdater');
const { applyDomicilioFiscal } = require('../services/fiscal/summary/documentosSummaryUpdater');

function splitSelectorList(rawValue, fallbackValue) {
    const source = String(rawValue || fallbackValue || '').trim();
    return source.split(',').map((item) => String(item || '').trim()).filter(Boolean);
}

function hasDesktopSession() {
    return Boolean(String(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '').trim());
}

/** Converts old-style portal service result to standardized response */
function toFiscalResponse(result, type, year) {
    if (!result) return failedResponse({ message: 'Sem resultado da recolha.' });
    const filePath = result.ficheiroPdf || '';
    const status = result.status || 'needs_review';
    if (status === 'completed' && filePath) {
        return completedResponse({ filePath, type, year, message: result.message || '', raw: result });
    }
    return needsReviewResponse({ filePath, type, year, message: result.message || '', raw: result });
}

async function runFinancasJob(app, customerId, job, getLocalCustomerById, isRunningRef, bodyOptions = {}) {
    const financasRecipe = recipe('financas');
    const loginUrl = recipeUrl('financas');
    const targetUrl = recipeUrl('financas', 'target');
    const timeoutMs = recipeTimeout('financas');
    const selectors = recipeSelectors('financas', splitSelectorList);

    const customer = await getLocalCustomerById(customerId);
    if (!customer) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });

    const resolved = portalCredentials.resolvePortalCredential(customer, 'financas');
    if (!resolved.username || !resolved.password) {
        throw Object.assign(new Error('Este cliente não tem utilizador/senha AT completos na ficha.'), { statusCode: 400 });
    }

    if (isRunningRef.value) {
        throw Object.assign(new Error('Já existe uma recolha AT em execução. Aguarde alguns segundos.'), { statusCode: 409 });
    }

    let playwright;
    try { playwright = require('playwright'); }
    catch (_) { throw Object.assign(new Error('Playwright não instalado. Execute: npm i playwright && npx playwright install chromium'), { statusCode: 500 }); }

    const headless = bodyOptions.headless !== false;
    if (!headless && !hasDesktopSession()) {
        throw Object.assign(new Error('Servidor sem sessão gráfica ativa. Use headless:true ou aceda a partir de um computador com GUI.'), { statusCode: 409 });
    }

    isRunningRef.value = true;
    let browser = null;
    let page = null;
    try {
        const launched = await launchFinancasBrowserWithFallback(playwright, { headless });
        browser = launched.browser;
        const downloadableJobs = new Set(['ies', 'modelo22', 'irs', 'certidao_at', 'domicilio_fiscal']);
        const ctx = await browser.newContext({ acceptDownloads: downloadableJobs.has(job) });
        page = await ctx.newPage();
        page.setDefaultTimeout(timeoutMs);

        await loginToFinancas(page, {
            loginUrl, targetUrl,
            username: resolved.username, password: resolved.password,
            usernameSelectors: selectors.username,
            passwordSelectors: selectors.password,
            submitSelectors: selectors.submit,
            timeoutMs,
        });

        let result = null;
        const year = String(bodyOptions.year || bodyOptions.targetYear || '').trim();
        const jobTimeout = Math.min(110000, timeoutMs + 20000);

        if (job === 'certidao_at') {
            result = await withTimeout(
                collectCertidaoAtAfterFinancasLogin(page, customer, { atUsername: resolved.username, atPassword: resolved.password }),
                jobTimeout, 'Tempo limite na recolha Certidão AT.'
            );
        } else if (job === 'domicilio_fiscal') {
            result = await withTimeout(collectDomicilioFiscalAfterFinancasLogin(page, customer), jobTimeout, 'Tempo limite na recolha Domicílio Fiscal.');
        } else if (job === 'ies') {
            result = await withTimeout(collectIesAfterFinancasLogin(page, customer, { targetYear: year }), jobTimeout, 'Tempo limite na recolha IES.');
        } else if (job === 'modelo22') {
            result = await withTimeout(collectModelo22AfterFinancasLogin(page, customer, { targetYear: year }), jobTimeout, 'Tempo limite na recolha Modelo 22.');
        }

        const fiscalResult = toFiscalResponse(result, job, year);

        if (fiscalResult.status === 'completed') {
            clearFailureDiagnostics(customerId, job);
        } else {
            const snapshot = await capturePageSnapshot(page).catch(() => ({}));
            saveFailureDiagnostics(customerId, job, { result: fiscalResult, snapshot });
        }

        return { customer, result: fiscalResult, browserLauncherLabel: launched.launcherLabel };
    } finally {
        isRunningRef.value = false;
        if (browser) await browser.close().catch(() => null);
    }
}

async function runSegSocialJob(app, customerId, job, getLocalCustomerById, isRunningRef, bodyOptions = {}) {
    const loginUrl = recipeUrl('segurancaSocial');
    const targetUrl = recipeUrl('segurancaSocial', 'target');
    const timeoutMs = recipeTimeout('segurancaSocial');
    const selectors = recipeSelectors('segurancaSocial', splitSelectorList);

    const customer = await getLocalCustomerById(customerId);
    if (!customer) throw Object.assign(new Error('Cliente não encontrado.'), { statusCode: 404 });

    const resolvedSubUser = portalCredentials.resolvePortalCredential(customer, 'seg-social', { mode: 'subutilizador' });
    const resolvedPrincipal = portalCredentials.resolvePortalCredential(customer, 'seg-social');
    const resolved = (resolvedSubUser.username && resolvedSubUser.password) ? resolvedSubUser : resolvedPrincipal;
    if (!resolved.username || !resolved.password) {
        throw Object.assign(new Error('Este cliente não tem utilizador/senha SS Direta completos para recolha automática.'), { statusCode: 400 });
    }

    if (isRunningRef.value) {
        throw Object.assign(new Error('Já existe uma recolha SS em execução. Aguarde alguns segundos.'), { statusCode: 409 });
    }

    let playwright;
    try { playwright = require('playwright'); }
    catch (_) { throw Object.assign(new Error('Playwright não instalado.'), { statusCode: 500 }); }

    const headless = bodyOptions.headless !== false;
    if (!headless && !hasDesktopSession()) {
        throw Object.assign(new Error('Servidor sem sessão gráfica ativa.'), { statusCode: 409 });
    }

    isRunningRef.value = true;
    let browser = null;
    let page = null;
    try {
        const launched = await launchFinancasBrowserWithFallback(playwright, {
            headless,
            browserExecutablePath: String(process.env.PORTAL_SEG_SOCIAL_BROWSER_EXECUTABLE || '').trim() || undefined,
        });
        browser = launched.browser;
        const ctx = await browser.newContext({ acceptDownloads: job === 'certidao_ss' });
        page = await ctx.newPage();
        page.setDefaultTimeout(timeoutMs);

        await loginToSegSocial(page, {
            loginUrl, targetUrl,
            username: resolved.username, password: resolved.password,
            usernameSelectors: selectors.username,
            passwordSelectors: selectors.password,
            timeoutMs,
        });

        let result = null;
        const jobTimeout = Math.min(130000, timeoutMs + 40000);

        if (job === 'certidao_ss') {
            const activationBlock = await getSegSocialActivationBlock(page);
            result = activationBlock || await withTimeout(
                collectCertidaoSsAfterSegSocialLogin(page, customer, { ssUsername: resolved.username, ssPassword: resolved.password }),
                jobTimeout, 'Tempo limite na recolha Certidão SS.'
            );
        }

        const fiscalResult = toFiscalResponse(result, job, '');

        if (fiscalResult.status === 'completed') {
            clearFailureDiagnostics(customerId, job);
        } else {
            const snapshot = await capturePageSnapshot(page).catch(() => ({}));
            saveFailureDiagnostics(customerId, job, { result: fiscalResult, snapshot });
        }

        return { customer, result: fiscalResult, browserLauncherLabel: launched.launcherLabel };
    } finally {
        isRunningRef.value = false;
        if (browser) await browser.close().catch(() => null);
    }
}

function registerFiscalPortalRoutes(context, helpers) {
    const { app, getLocalCustomerById, writeAuditLog, dbRunAsync, dbGetAsync } = context;
    const { isFinancasAutologinRunningRef } = helpers;

    async function readSummary(customerId) {
        const row = await dbGetAsync('SELECT data FROM customer_fiscal_summary WHERE customer_id = ?', [customerId]).catch(() => null);
        try { return row ? JSON.parse(row.data) : {}; } catch (_) { return {}; }
    }
    async function writeSummary(customerId, updater) {
        const current = await readSummary(customerId);
        const patch = typeof updater === 'function' ? updater(current) : updater;
        const merged = mergeFiscalSummaryData({ ...current, ...(patch && typeof patch === 'object' ? patch : {}), updatedAt: new Date().toISOString() });
        await dbRunAsync(
            `INSERT INTO customer_fiscal_summary (customer_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(customer_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
            [customerId, JSON.stringify(merged), merged.updatedAt]
        );
        return merged;
    }

    function handleError(res, error) {
        const statusCode = error?.statusCode || 500;
        const message = String(error?.message || error || 'Erro interno.');
        console.error('[FiscalPortalRoutes]', message);
        return res.status(statusCode).json({ success: false, error: message });
    }

    // ── Login test — Finanças AT ─────────────────────────────────────────────
    app.post('/api/customers/:id/portals/financas/login-test', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        try {
            const timeoutMs = recipeTimeout('financas');
            const loginUrl = recipeUrl('financas');
            const selectors = recipeSelectors('financas', splitSelectorList);

            const customer = await getLocalCustomerById(customerId);
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            const resolved = portalCredentials.resolvePortalCredential(customer, 'financas');
            if (!resolved.username || !resolved.password) {
                return res.status(400).json({ success: false, error: 'Sem credenciais AT na ficha do cliente.' });
            }
            if (isFinancasAutologinRunningRef.value) {
                return res.status(409).json({ success: false, error: 'Já existe uma operação em execução.' });
            }
            let playwright;
            try { playwright = require('playwright'); } catch (_) {
                return res.status(500).json({ success: false, error: 'Playwright não instalado.' });
            }
            isFinancasAutologinRunningRef.value = true;
            let browser = null;
            try {
                const launched = await launchFinancasBrowserWithFallback(playwright, { headless: true });
                browser = launched.browser;
                const ctx = await browser.newContext();
                const page = await ctx.newPage();
                page.setDefaultTimeout(timeoutMs);
                await loginToFinancas(page, {
                    loginUrl, username: resolved.username, password: resolved.password,
                    usernameSelectors: selectors.username, passwordSelectors: selectors.password, submitSelectors: selectors.submit,
                    timeoutMs,
                });
                const successSelector = await findFirstVisibleSelector(page, selectors.success).catch(() => null);
                const hasPasswordInput = (await page.locator('input[type="password"]').count()) > 0;
                const loginState = successSelector ? 'logged_in' : hasPasswordInput ? 'needs_manual_validation' : 'unknown';
                return res.json({ success: true, portal: 'financas', loginState, message: `Teste de login AT: ${loginState}` });
            } finally {
                isFinancasAutologinRunningRef.value = false;
                if (browser) await browser.close().catch(() => null);
            }
        } catch (error) {
            return handleError(res, error);
        }
    });

    // ── Login test — Segurança Social ────────────────────────────────────────
    app.post('/api/customers/:id/portals/seg-social/login-test', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        try {
            const timeoutMs = recipeTimeout('segurancaSocial');
            const loginUrl = recipeUrl('segurancaSocial');
            const selectors = recipeSelectors('segurancaSocial', splitSelectorList);

            const customer = await getLocalCustomerById(customerId);
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            const resolvedSub = portalCredentials.resolvePortalCredential(customer, 'seg-social', { mode: 'subutilizador' });
            const resolvedMain = portalCredentials.resolvePortalCredential(customer, 'seg-social');
            const resolved = (resolvedSub.username && resolvedSub.password) ? resolvedSub : resolvedMain;
            if (!resolved.username || !resolved.password) {
                return res.status(400).json({ success: false, error: 'Sem credenciais SS Direta na ficha do cliente.' });
            }
            if (isFinancasAutologinRunningRef.value) {
                return res.status(409).json({ success: false, error: 'Já existe uma operação em execução.' });
            }
            let playwright;
            try { playwright = require('playwright'); } catch (_) {
                return res.status(500).json({ success: false, error: 'Playwright não instalado.' });
            }
            isFinancasAutologinRunningRef.value = true;
            let browser = null;
            try {
                const launched = await launchFinancasBrowserWithFallback(playwright, {
                    headless: true,
                    browserExecutablePath: String(process.env.PORTAL_SEG_SOCIAL_BROWSER_EXECUTABLE || '').trim() || undefined,
                });
                browser = launched.browser;
                const ctx = await browser.newContext();
                const page = await ctx.newPage();
                page.setDefaultTimeout(timeoutMs);
                await loginToSegSocial(page, {
                    loginUrl, username: resolved.username, password: resolved.password,
                    usernameSelectors: selectors.username, passwordSelectors: selectors.password,
                    timeoutMs,
                });
                const successSelector = await findFirstVisibleSelector(page, selectors.success).catch(() => null);
                const hasPasswordInput = (await page.locator('input[type="password"]').count()) > 0;
                const loginState = successSelector ? 'logged_in' : hasPasswordInput ? 'needs_manual_validation' : 'unknown';
                return res.json({ success: true, portal: 'seg-social', loginState, message: `Teste de login SS: ${loginState}` });
            } finally {
                isFinancasAutologinRunningRef.value = false;
                if (browser) await browser.close().catch(() => null);
            }
        } catch (error) {
            return handleError(res, error);
        }
    });

    // ── Finanças — Certidão AT ───────────────────────────────────────────────
    app.post('/api/customers/:id/fiscal/financas/certidao-at', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        try {
            const { customer, result } = await runFinancasJob(app, customerId, 'certidao_at', getLocalCustomerById, isFinancasAutologinRunningRef, req.body || {});
            if (result?.status === 'completed' && result?.document?.filePath) {
                const raw = result.raw || {};
                await writeSummary(customerId, (current) => applyCertidaoAt(current, {
                    ficheiroPdf: result.document.filePath,
                    dataValidade: raw.dataValidade || '',
                    valida: result.document.validated,
                    semDivida: Boolean(raw.semDivida),
                    comDivida: Boolean(raw.comDivida),
                })).catch((err) => console.error('[FiscalPortalRoutes] Erro ao atualizar certidão AT no resumo:', err));
            }
            return res.json({ success: true, job: 'certidao_at', customerId, result });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // ── Finanças — Domicílio Fiscal ──────────────────────────────────────────
    app.post('/api/customers/:id/fiscal/financas/domicilio-fiscal', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        try {
            const { result } = await runFinancasJob(app, customerId, 'domicilio_fiscal', getLocalCustomerById, isFinancasAutologinRunningRef, req.body || {});
            if (result?.status === 'completed' && result?.document?.filePath) {
                const raw = result.raw || {};
                await writeSummary(customerId, (current) => applyDomicilioFiscal(current, {
                    ficheiroPdf: result.document.filePath,
                    valida: result.document.validated,
                    morada: raw.morada || '',
                })).catch((err) => console.error('[FiscalPortalRoutes] Erro ao atualizar domicílio fiscal no resumo:', err));
            }
            return res.json({ success: true, job: 'domicilio_fiscal', customerId, result });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // ── Finanças — IES ───────────────────────────────────────────────────────
    app.post('/api/customers/:id/fiscal/financas/ies', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        try {
            const { result } = await runFinancasJob(app, customerId, 'ies', getLocalCustomerById, isFinancasAutologinRunningRef, req.body || {});
            return res.json({ success: true, job: 'ies', customerId, result });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // ── Finanças — Modelo 22 ─────────────────────────────────────────────────
    app.post('/api/customers/:id/fiscal/financas/modelo22', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        try {
            const { result } = await runFinancasJob(app, customerId, 'modelo22', getLocalCustomerById, isFinancasAutologinRunningRef, req.body || {});
            return res.json({ success: true, job: 'modelo22', customerId, result });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // ── Segurança Social — Certidão SS ───────────────────────────────────────
    app.post('/api/customers/:id/fiscal/seg-social/certidao', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        try {
            const { result } = await runSegSocialJob(app, customerId, 'certidao_ss', getLocalCustomerById, isFinancasAutologinRunningRef, req.body || {});
            return res.json({ success: true, job: 'certidao_ss', customerId, result });
        } catch (error) {
            return handleError(res, error);
        }
    });

    // ── Last failure diagnostics — GET ───────────────────────────────────────
    app.get('/api/customers/:id/fiscal/diagnostics/:job', (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const job = String(req.params.job || '').trim();
        if (!customerId || !job) return res.status(400).json({ success: false, error: 'Parâmetros inválidos.' });
        const data = loadFailureDiagnostics(customerId, job);
        return res.json({ success: true, customerId, job, diagnostics: data });
    });

    // ── List all failure diagnostics ─────────────────────────────────────────
    app.get('/api/fiscal/diagnostics', (req, res) => {
        return res.json({ success: true, entries: listFailureDiagnostics() });
    });

    // ── Collect (delegates to runFiscalCollector via existing machinery) ─────
    app.post('/api/customers/:id/fiscal/collect', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const body = req.body || {};
        const job = String(body.job || '').trim().toLowerCase();
        if (!customerId) return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        if (!job) return res.status(400).json({ success: false, error: 'Campo "job" obrigatório.' });
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            const result = await runFiscalCollector({ job, customer, body });
            return res.json({ success: true, job, customerId, result });
        } catch (error) {
            return handleError(res, error);
        }
    });
}

module.exports = { registerFiscalPortalRoutes };
