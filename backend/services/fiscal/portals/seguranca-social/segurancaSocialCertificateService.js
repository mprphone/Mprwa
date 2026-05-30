'use strict';

const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { cleanText } = require('../../shared/textHelpers');
const { buildFiscalDownloadPath, uniquePath } = require('../../documents/documentNamingService');

async function extractPdfText(filePath) {
    try {
        const { stdout } = await execFileAsync('pdftotext', [filePath, '-'], { timeout: 10000 });
        return stdout || '';
    } catch (_) { return ''; }
}

function isPdfBuffer(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.slice(0, 4).toString('latin1') === '%PDF';
}

function isValidCertidaoSsPdf(text) {
    if (!text || text.length < 50) return false;
    return /declara[cç][aã]o\s+de\s+situa[cç][aã]o\s+contributiva|situa[cç][aã]o\s+contributiva/i.test(text)
        && !/obrigat[oó]rio|campo\s+obrigat/i.test(text);
}

function detectSemDivida(text) {
    return /regularizada|n[aã]o\s+existem\s+d[ií]vidas|sem\s+d[ií]vidas/i.test(text);
}

async function saveSsPdf(buffer, customer, year) {
    const targetPath = uniquePath(buildFiscalDownloadPath(customer, year, 'certidao_ss', 'certidao.pdf'));
    await fs.writeFile(targetPath, buffer);
    return targetPath;
}

// --- PDF interceptor (context-level, catches PDF from any page or popup) ---
async function setupPdfInterceptor(page, customer, year) {
    let capturedPath = '';
    const context = page.context();
    const handler = async (route) => {
        try {
            const response = await route.fetch();
            const buffer = await response.body().catch(() => null);
            if (isPdfBuffer(buffer) && !capturedPath) {
                capturedPath = await saveSsPdf(buffer, customer, year).catch(() => '');
            }
            await route.fulfill({ response, body: buffer ?? undefined });
        } catch (_) {
            await route.continue().catch(() => null);
        }
    };
    await context.route('https://www.seg-social.pt/**', handler);
    return {
        getPath: () => capturedPath,
        cleanup: () => context.unroute('https://www.seg-social.pt/**', handler).catch(() => null),
    };
}

// --- Click helper that waits for networkidle after each step ---
async function navClick(page, locator, stepName) {
    console.error(`[CertidaoSS] step: ${stepName}`);
    console.error(`[CertidaoSS]   before: url=${page.url()}`);
    await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null),
        locator.click({ timeout: 10000 }),
    ]);
    await page.waitForTimeout(500);
    console.error(`[CertidaoSS]   after:  url=${page.url()}`);
    console.error(`[CertidaoSS]   title:  ${await page.title().catch(() => '')}`);
    const bodyText = cleanText(await page.locator('body').innerText({ timeout: 4000 }).catch(() => ''));
    console.error(`[CertidaoSS]   text:   ${bodyText.slice(0, 150)}`);
    return bodyText;
}

// --- Main collection function ---
async function collectCertidaoSsAfterSegSocialLogin(page, customer) {
    const year = String(new Date().getFullYear());
    const trace = (...args) => console.error('[CertidaoSS]', ...args);

    // Set up interceptor and download listener BEFORE any navigation
    const interceptor = await setupPdfInterceptor(page, customer, year);
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 }).catch(() => null);

    trace('=== START: navigating via real UI clicks ===');
    trace('initial url:', page.url());
    trace('title:', await page.title().catch(() => ''));

    // Guard: if still on the login page, the login failed — report immediately instead of wasting 10s timeout
    const currentUrl = page.url();
    const currentTitle = await page.title().catch(() => '');
    if (/sso\/login|autenticacao/i.test(currentUrl) || /autenticação|serviço de autenticação/i.test(currentTitle)) {
        await interceptor.cleanup();
        return {
            status: 'needs_review', ficheiroPdf: '', dataValidade: '', valida: false, semDivida: false,
            message: 'Login SS não concluído — a página ficou no formulário de autenticação. Verifique as credenciais e o código 2FA do subutilizador.',
            pageTextSample: (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).slice(0, 500),
        };
    }

    // Step 1: Pagamentos e dívidas
    const step1Loc = page.getByRole('link', { name: /pagamentos\s+e\s+d[ií]vidas/i })
        .or(page.getByText(/pagamentos\s+e\s+d[ií]vidas/i, { exact: false }))
        .first();
    await navClick(page, step1Loc, 'Pagamentos e dívidas');

    // Step 2: Situação Contributiva
    const step2Loc = page.getByRole('link', { name: /situa[cç][aã]o\s+contributiva/i })
        .or(page.getByText(/situa[cç][aã]o\s+contributiva/i, { exact: false }))
        .first();
    await navClick(page, step2Loc, 'Situação Contributiva');

    // Step 3: Declaração da situação contributiva
    const step3Loc = page.getByRole('link', { name: /declara[cç][aã]o\s+da\s+situa[cç][aã]o\s+contributiva/i })
        .or(page.getByText(/declara[cç][aã]o\s+da\s+situa[cç][aã]o\s+contributiva/i, { exact: false }))
        .first();
    await navClick(page, step3Loc, 'Declaração da situação contributiva');

    // Step 4: Consultar e obter declaração
    // This click may trigger a CAS redirect — just wait for it to complete fully
    const step4Loc = page.getByRole('link', { name: /consultar\s+e\s+obter\s+declara[cç][aã]o/i })
        .or(page.getByText(/consultar\s+e\s+obter\s+declara[cç][aã]o/i, { exact: false }))
        .first();
    trace('step: Consultar e obter declaração — may trigger CAS redirect, waiting up to 30s');
    await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null),
        step4Loc.click({ timeout: 10000 }).catch(() => null),
    ]);
    await page.waitForTimeout(1000);
    trace('after step4: url=', page.url());
    trace('after step4: text=', cleanText(await page.locator('body').innerText({ timeout: 4000 }).catch(() => '')).slice(0, 200));

    // Check we're on the pesquisa-entidade / declaração page
    const urlOk = /pesquisa.entidade|ascd/i.test(page.url());
    const textOk = /declaração\s+de\s+situação\s+contributiva|regularizada|obter\s+nova|ver\s+declar/i.test(
        cleanText(await page.locator('body').innerText({ timeout: 4000 }).catch(() => ''))
    );

    if (!urlOk && !textOk) {
        const pageText = cleanText(await page.locator('body').innerText({ timeout: 4000 }).catch(() => ''));
        trace('NOT on certidão page. url=', page.url(), 'text=', pageText.slice(0, 300));
        await interceptor.cleanup();
        return {
            status: 'needs_review', ficheiroPdf: '', dataValidade: '', valida: false, semDivida: false,
            message: 'Não foi possível aceder à página de certidão SS após navegação pelo menu.',
            pageTextSample: pageText.slice(0, 500),
        };
    }

    trace('=== ON certidão page ===');
    const pageText = cleanText(await page.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
    trace('page text:', pageText.slice(0, 200));

    // Collect metadata from page
    const semDividaPage = /regularizada/i.test(pageText);
    const numeroMatch = pageText.match(/n[ºo°]\s*declara[cç][aã]o[:\s]+([A-Z0-9]+)/i);

    // Step 5: "Obter nova declaração" if present (request a fresh one)
    const obterBtn = page.getByRole('button', { name: /obter\s+nova\s+declara[cç][aã]o/i })
        .or(page.getByText(/obter\s+nova\s+declara[cç][aã]o/i, { exact: false }))
        .first();
    const hasObter = await obterBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (hasObter) {
        trace('clicking "Obter nova declaração"');
        await Promise.all([
            page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null),
            obterBtn.click({ timeout: 8000 }),
        ]);
        // Wait ~5 seconds for the declaration to be registered
        await page.waitForTimeout(5000);
        trace('after "Obter nova": url=', page.url());
        trace('after "Obter nova": text=', cleanText(await page.locator('body').innerText({ timeout: 4000 }).catch(() => '')).slice(0, 150));
    } else {
        trace('"Obter nova declaração" not present — using existing declaration');
    }

    // Step 6: "Ver declaração" — click and capture PDF
    const verBtn = page.getByRole('button', { name: /ver\s+declara[cç][aã]o/i })
        .or(page.getByRole('link', { name: /ver\s+declara[cç][aã]o/i }))
        .or(page.getByText(/ver\s+declara[cç][aã]o/i, { exact: false }))
        .first();
    const hasVer = await verBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (!hasVer) {
        trace('"Ver declaração" button NOT found');
        await interceptor.cleanup();
        return {
            status: 'needs_review', ficheiroPdf: '', dataValidade: '', valida: false, semDivida: false,
            message: 'Botão "Ver declaração" não encontrado na página da certidão SS.',
            pageTextSample: pageText.slice(0, 500),
        };
    }

    trace('clicking "Ver declaração"');
    await verBtn.click({ timeout: 8000 }).catch((e) => trace('"Ver declaração" click error:', e?.message));

    // Wait for PDF (download event primary, route interceptor fallback)
    let ficheiroPdf = '';
    const download = await downloadPromise;
    if (download) {
        const suggested = (() => { try { return download.suggestedFilename() || 'certidao.pdf'; } catch (_) { return 'certidao.pdf'; } })();
        trace('download event received:', suggested);
        const targetPath = uniquePath(buildFiscalDownloadPath(customer, year, 'certidao_ss', suggested));
        await download.saveAs(targetPath).catch(() => null);
        ficheiroPdf = targetPath;
    } else {
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
        await page.waitForTimeout(1000);
    }

    await interceptor.cleanup();
    if (!ficheiroPdf) ficheiroPdf = interceptor.getPath();
    trace('PDF capturado:', ficheiroPdf || 'nenhum');

    if (ficheiroPdf) {
        const pdfText = await extractPdfText(ficheiroPdf);
        if (!isValidCertidaoSsPdf(pdfText)) {
            trace('PDF rejeitado (não é certidão válida):', pdfText.slice(0, 150));
            await fs.unlink(ficheiroPdf).catch(() => null);
            return {
                status: 'needs_review', ficheiroPdf: '', dataValidade: '', valida: false, semDivida: false,
                message: 'PDF capturado não é uma certidão SS válida.',
                pageTextSample: pageText.slice(0, 500),
            };
        }
        const semDivida = detectSemDivida(pdfText) || semDividaPage;
        const validUntil = new Date();
        validUntil.setMonth(validUntil.getMonth() + 4);
        return {
            status: 'completed',
            ficheiroPdf,
            dataValidade: validUntil.toISOString().slice(0, 10),
            valida: true,
            semDivida,
            numeroDeclaracao: numeroMatch?.[1] || '',
            message: semDivida ? 'Certidão SS — situação contributiva regularizada.' : 'Certidão SS obtida.',
            pageTextSample: pageText.slice(0, 500),
        };
    }

    return {
        status: 'needs_review', ficheiroPdf: '', dataValidade: '', valida: false, semDivida: false,
        message: 'Não foi possível capturar o PDF da certidão SS.',
        pageTextSample: pageText.slice(0, 500),
    };
}

// --- 2FA activation block detector ---
async function getSegSocialActivationBlock(page) {
    const text = cleanText(await page.locator('body').innerText({ timeout: 3000 }).catch(() => ''));
    if (!/ativa[cç][aã]o\s+da\s+autentica[cç][aã]o\s+de\s+dois\s+fatores/i.test(text)) return null;
    const emailMatch = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    return {
        status: 'needs_review',
        ficheiroPdf: '',
        dataValidade: '',
        valida: false,
        semDivida: false,
        message: emailMatch
            ? `Segurança Social exige ativação 2FA no email ${emailMatch[0]}. Ativar primeiro para permitir a recolha automática.`
            : 'Segurança Social exige ativação da autenticação de dois fatores antes da recolha automática.',
        pageTextSample: text.slice(0, 1000),
    };
}

module.exports = { collectCertidaoSsAfterSegSocialLogin, getSegSocialActivationBlock };
