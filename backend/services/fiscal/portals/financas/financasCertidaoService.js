'use strict';

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { cleanText, normalizeDateToIso } = require('../../shared/textHelpers');
const { buildFiscalDownloadPath, uniquePath } = require('../../documents/documentNamingService');

async function extractPdfText(filePath) {
    try {
        const { stdout } = await execFileAsync('pdftotext', [filePath, '-'], { timeout: 10000 });
        return stdout || '';
    } catch (_) {
        return '';
    }
}

function detectSemDivida(text) {
    return /situa[cç][aã]o\s+tribut[aá]ria\s+regularizada|n[aã]o\s+existem\s+d[ií]vidas|n[aã]o\s+tem\s+d[ií]vidas/i.test(text);
}

function detectComDivida(text) {
    return /tem\s+d[ií]vidas?|existem\s+d[ií]vidas?|d[ií]vida[s]?\s+em\s+aberto|n[aã]o\s+regularizada/i.test(text);
}

function isValidCertidaoPdf(text) {
    if (!text || text.length < 50) return false;
    // Must contain certidão keyword and NOT be an error/form page
    const hasCertidao = /certid[aã]o/i.test(text);
    const isErrorPage = /obrigat[oó]rio|preencha|campo\s+obrigat|nif.*\binv[aá]lido\b|\bpesquisa\b.*\bcritério/i.test(text);
    return hasCertidao && !isErrorPage;
}

async function saveFiscalBufferPdf(buffer, customer, year, type) {
    const targetPath = uniquePath(buildFiscalDownloadPath(customer, year, type, 'certidao.pdf'));
    await fs.writeFile(targetPath, buffer);
    return targetPath;
}

function isPdfBuffer(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.slice(0, 4).toString('latin1') === '%PDF';
}

async function clickFirst(page, selectors, timeout = 5000) {
    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        const exists = await locator.count().then((n) => n > 0).catch(() => false);
        if (!exists) continue;

        await locator.click({ timeout }).catch(async () => {
            await locator.evaluate((el) => el.click()).catch(() => null);
        });
        return true;
    }
    return false;
}

// page.route() intercepta o pedido ANTES de o Chromium consumir a resposta,
// permitindo capturar o buffer do PDF de navegação (response.body() falha nesses casos).
async function interceptObterPdf(page, customer, year) {
    let capturedPath = '';
    const context = page.context();

    const routeHandler = async (route) => {
        const req = route.request();
        const method = req.method();
        const url = req.url().toLowerCase();

        // Only inspect POST requests or URLs that look like certidão generation;
        // pass everything else through immediately to avoid doubling non-PDF traffic
        if (method !== 'POST' && !url.includes('certidao') && !url.includes('consulta')) {
            await route.continue().catch(() => null);
            return;
        }

        try {
            const response = await route.fetch();
            const contentType = (response.headers()['content-type'] || '').toLowerCase();
            if (contentType.includes('application/pdf')) {
                const buffer = await response.body().catch(() => null);
                if (isPdfBuffer(buffer) && !capturedPath) {
                    capturedPath = await saveFiscalBufferPdf(buffer, customer, year, 'certidao_at').catch(() => '');
                }
            }
            await route.fulfill({ response });
        } catch (_) {
            await route.continue().catch(() => null);
        }
    };

    // Use context-level route so popups opened after OBTER click are also intercepted
    await context.route('https://www.portaldasfinancas.gov.pt/**', routeHandler);
    return {
        getPath: () => capturedPath,
        cleanup: () => context.unroute('https://www.portaldasfinancas.gov.pt/**', routeHandler).catch(() => null),
    };
}

async function selectDividaENaoDivida(page) {
    return page.evaluate(() => {
        const fold = (value) => String(value || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const wanted = 'divida e nao divida';

        for (const select of Array.from(document.querySelectorAll('select'))) {
            const option = Array.from(select.options || [])
                .find((item) => fold(item.textContent || item.value).includes(wanted));

            if (!option) continue;

            select.value = option.value;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));

            return {
                ok: true,
                type: 'select',
                value: option.value,
                text: option.textContent || ''
            };
        }

        for (const input of Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'))) {
            let node = input;
            let text = '';

            for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
                text += ` ${node.innerText || node.textContent || ''}`;
            }

            if (fold(text).includes(wanted)) {
                input.click();
                return {
                    ok: true,
                    type: input.type,
                    value: input.value || '',
                    text
                };
            }
        }

        return { ok: false };
    }).catch(() => ({ ok: false }));
}

// --- Consulta-based approach (simpler: NIF is pre-filled, just select type and get active certidão) ---
async function collectCertidaoAtViaConsulta(page, customer, year, trace) {
    const consultaUrl = 'https://www.portaldasfinancas.gov.pt/pt/consultaCertidoesForm.action';
    trace('consulta: navigating to', consultaUrl);

    await page.goto(consultaUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
    await page.waitForTimeout(1000);
    trace('consulta: URL after goto:', page.url());

    if (!/consultaCertidoes/i.test(page.url())) {
        return null; // Not on expected page (not logged in or redirected)
    }

    // Select "Dívida e Não Dívida" from the Certidão dropdown, Estado "Activa"
    const setupOk = await page.evaluate(() => {
        const fold = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const wanted = 'divida e nao divida';
        let certidaoSet = false;

        for (const select of document.querySelectorAll('select')) {
            // Try certidão type dropdown
            const certOpt = Array.from(select.options).find((o) => fold(o.textContent || o.value).includes(wanted));
            if (certOpt && !certidaoSet) {
                select.value = certOpt.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                certidaoSet = true;
                continue;
            }
            // Try Estado dropdown → set to Activa
            const activaOpt = Array.from(select.options).find((o) => {
                const t = fold(o.textContent || o.value);
                return t === 'activa' || t === 'ativa' || o.value === 'A';
            });
            if (activaOpt) {
                select.value = activaOpt.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
        return certidaoSet;
    }).catch(() => false);

    trace('consulta: certidão type selected:', setupOk);
    if (!setupOk) return null;

    // Click CONTINUAR
    await clickFirst(page, [
        'input[value="CONTINUAR"]',
        'input[value="Continuar"]',
        'button:has-text("Continuar")',
        'input[type="submit"]',
    ], 5000);

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(1000);
    trace('consulta: after CONTINUAR, URL:', page.url());

    // Set up PDF interceptor and popup listener before clicking Obter
    const popupPromise = page.waitForEvent('popup', { timeout: 20000 }).catch(() => null);
    const interceptor = await interceptObterPdf(page, customer, year);

    // Find "Obter" link in the certidão results table (row must contain "Activa" status)
    // Exclude navigation sidebar links that also say "Obter" but point to menu.action
    const clickedObter = await page.evaluate(() => {
        const fold = (v) => String(v || '').trim().toLowerCase();

        for (const row of document.querySelectorAll('tr')) {
            const rowText = fold(row.textContent || '');
            // Row must have "activa" text (the Estado column) but NOT be a nav/header only row
            if (!rowText.includes('activa') && !rowText.includes('ativa')) continue;
            // Skip rows that are only navigation (contains many menu-like links)
            const anchors = Array.from(row.querySelectorAll('a'));
            const certidaoAnchors = anchors.filter((a) => {
                const href = (a.href || '').toLowerCase();
                const text = fold(a.innerText || a.textContent || '');
                // Must NOT be a navigation menu link
                if (href.includes('menu.action') || href.includes('inicio.action') || href.includes('home.action')) return false;
                // Must look like a certidão action link or just have "obter" text inside a data row
                return (text === 'obter' || text.startsWith('obter'));
            });

            if (certidaoAnchors.length > 0) {
                // Re-enable disabled fields so the form POST includes NIF
                document.querySelectorAll('[disabled]').forEach((el) => { el.disabled = false; });
                certidaoAnchors[0].click();
                return { clicked: true, tag: 'A', href: certidaoAnchors[0].href || '' };
            }

            // Also check submit buttons in the row
            for (const el of row.querySelectorAll('input[type="submit"], button')) {
                const text = fold(el.value || el.innerText || el.textContent || '');
                if (text === 'obter' || text.startsWith('obter')) {
                    if (el.disabled) el.disabled = false;
                    el.click();
                    return { clicked: true, tag: el.tagName, href: '' };
                }
            }
        }
        return { clicked: false };
    }).catch(() => ({ clicked: false }));

    trace('consulta: clickedObter:', JSON.stringify(clickedObter));

    if (!clickedObter.clicked) {
        await interceptor.cleanup();
        await popupPromise.then((p) => p && p.close().catch(() => null)).catch(() => null);
        return null; // No active certidão found in table → caller should do emissão
    }

    const popup = await popupPromise;
    if (popup) {
        trace('consulta: popup opened, URL:', popup.url());
        await popup.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);
        await popup.waitForTimeout(1500);
        trace('consulta: popup after load, URL:', popup.url());
        await popup.close().catch(() => null);
    } else {
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
        await page.waitForTimeout(1000);
    }

    await interceptor.cleanup();
    const ficheiroPdf = interceptor.getPath();
    trace('consulta: PDF capturado:', ficheiroPdf || 'none');
    if (!ficheiroPdf) return null;

    const pdfText = await extractPdfText(ficheiroPdf);
    if (!isValidCertidaoPdf(pdfText)) {
        trace('consulta: PDF rejeitado (não é certidão válida):', pdfText.slice(0, 150));
        await fs.unlink(ficheiroPdf).catch(() => null);
        return null;
    }
    return ficheiroPdf;
}

// --- Emissão flow: creates a new certidão ---
async function emitirNovaCertidao(page, trace) {
    const emissaoUrl = 'https://www.portaldasfinancas.gov.pt/pt/emissaoCertidaoForm.action';
    trace('emissao: navigating to', emissaoUrl);

    await page.goto(emissaoUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
    await page.waitForTimeout(1000);
    trace('emissao: URL:', page.url());

    if (!/emissaoCertidaoForm/i.test(page.url())) return false;

    const selected = await selectDividaENaoDivida(page);
    trace('emissao: type selected:', JSON.stringify(selected));
    if (!selected.ok) return false;

    await page.waitForTimeout(700);

    // Continuar
    await clickFirst(page, ['input[value="Continuar"]', 'button:has-text("Continuar")', 'input[type="submit"]'], 5000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(1200);

    // Confirmar (submits the certidão request)
    const confirmed = await page.evaluate(() => {
        const fold = (v) => String(v || '').trim().toLowerCase();
        for (const el of document.querySelectorAll('input[type="submit"], input[type="button"], button[type="submit"], button')) {
            const text = fold(el.value || el.innerText || el.textContent || '');
            if (text === 'confirmar' || text === 'confirmar pedido') {
                el.click();
                return true;
            }
        }
        return false;
    }).catch(() => false);

    trace('emissao: Confirmar clicked:', confirmed);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(1000);
    return confirmed;
}

async function collectCertidaoAtAfterFinancasLogin(page, customer, options = {}) {
    const year = String(new Date().getFullYear());
    const readText = async () => cleanText(await page.locator('body').innerText({ timeout: 7000 }).catch(() => ''));
    const trace = (...args) => console.error('[CertidaoAT]', ...args);

    const atUsername = String(options.atUsername || '').trim();
    const atPassword = String(options.atPassword || '').trim();

    const pfinLoginUrl = String(
        process.env.PORTAL_FINANCAS_PFIN_LOGIN_URL ||
        'https://www.acesso.gov.pt/loginRedirectForm?path=emissaoCertidaoForm.action&partID=PFIN'
    );

    let ficheiroPdf = '';
    let pageText = '';
    let lastStep = 'start';

    trace('PFIN goto:', pfinLoginUrl);
    await page.goto(pfinLoginUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
    await page.waitForTimeout(1200);
    trace('after PFIN goto, URL:', page.url());

    if (!/emissaoCertidaoForm/i.test(page.url()) && atUsername && atPassword) {
        lastStep = 'login';
        trace('filling PFIN credentials');

        await clickFirst(page, [
            'li:has-text("NIF")',
            'a:has-text("NIF")',
            'button:has-text("NIF")',
            '[data-tab="nif"]',
            '[id*="nif" i]'
        ], 3000).catch(() => null);

        await page.locator(
            'input[name="username"], input[id*="username" i], input[id*="nif" i], input[name*="nif" i], input[autocomplete="username"]'
        )
            .first()
            .fill(atUsername, { timeout: 5000 })
            .catch(() => null);

        await page.locator('input[type="password"]')
            .first()
            .fill(atPassword, { timeout: 5000 })
            .catch(() => null);

        await clickFirst(page, [
            'button[type="submit"]',
            'input[type="submit"]'
        ], 5000).catch(() => null);

        await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => null);
        await page.waitForTimeout(1500);

        trace('after PFIN submit, URL:', page.url());
    }

    await clickFirst(page, [
        'button:has-text("Continuar")',
        'a:has-text("Continuar")',
        'button:has-text("Continue")'
    ], 5000).catch(() => null);

    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(1000);

    if (!/emissaoCertidaoForm/i.test(page.url())) {
        lastStep = 'open-emissao-form';
        trace('opening emissão de certidão form');

        const opened = await clickFirst(page, [
            'a:has-text("Efectuar Pedido")',
            'a:has-text("Efetuar Pedido")',
            'a[href*="emissaoCertidaoForm"]:not([href*="#"])'
        ], 5000).catch(() => false);

        if (!opened) {
            await page.goto('https://www.portaldasfinancas.gov.pt/pt/emissaoCertidaoForm.action', {
                waitUntil: 'domcontentloaded',
                timeout: 25000
            }).catch(() => null);
        }

        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
        await page.waitForTimeout(1500);

        trace('after opening form, URL:', page.url());
    }

    // Primary approach: consulta page (NIF pre-filled, select type → CONTINUAR → Obter active certidão)
    lastStep = 'consulta';
    trace('trying consulta approach...');
    const consultaPdf = await collectCertidaoAtViaConsulta(page, customer, year, trace);

    if (consultaPdf) {
        pageText = await readText();
        const pdfText = await extractPdfText(consultaPdf);
        const semDivida = detectSemDivida(pdfText);
        const comDivida = detectComDivida(pdfText);
        trace('PDF text semDivida:', semDivida, 'comDivida:', comDivida);
        const validUntil = new Date();
        validUntil.setMonth(validUntil.getMonth() + 4);
        const dataValidade = validUntil.toISOString().slice(0, 10);
        return {
            status: 'completed',
            ficheiroPdf: consultaPdf,
            dataValidade,
            valida: true,
            semDivida,
            comDivida,
            message: semDivida
                ? 'Certidão AT — situação tributária regularizada.'
                : comDivida
                    ? 'Certidão AT — contribuinte tem dívidas.'
                    : 'Certidão AT obtida via consulta.',
            pageUrl: page.url(),
            pageTextSample: cleanText(pageText).slice(0, 1000),
            lastStep
        };
    }

    // Fallback: no active certidão found → emit a new one then retry consulta
    lastStep = 'emissao';
    trace('no active certidão via consulta, emitting new one...');
    const emitted = await emitirNovaCertidao(page, trace);
    trace('emissão result:', emitted);

    if (emitted) {
        await page.waitForTimeout(4000); // Give AT portal time to register the new certidão
        lastStep = 'consulta-retry';
        trace('retrying consulta after emissão...');
        const retryPdf = await collectCertidaoAtViaConsulta(page, customer, year, trace);
        if (retryPdf) {
            pageText = await readText();
            const pdfText = await extractPdfText(retryPdf);
            const semDivida = detectSemDivida(pdfText);
            const comDivida = detectComDivida(pdfText);
            const validUntilRetry = new Date();
            validUntilRetry.setMonth(validUntilRetry.getMonth() + 4);
            return {
                status: 'completed',
                ficheiroPdf: retryPdf,
                dataValidade: validUntilRetry.toISOString().slice(0, 10),
                valida: true,
                semDivida,
                comDivida,
                message: semDivida
                    ? 'Certidão AT — situação tributária regularizada.'
                    : comDivida
                        ? 'Certidão AT — contribuinte tem dívidas.'
                        : 'Certidão AT emitida e obtida via consulta.',
                pageUrl: page.url(),
                pageTextSample: cleanText(pageText).slice(0, 1000),
                lastStep
            };
        }
    }

    pageText = await readText();
    return {
        status: 'needs_review',
        ficheiroPdf,
        dataValidade: '',
        valida: false,
        semDivida: false,
        message: emitted
            ? 'Certidão emitida mas não foi possível obter o PDF via consulta.'
            : 'Não foi possível emitir ou encontrar a certidão AT.',
        pageUrl: page.url(),
        pageTextSample: cleanText(pageText).slice(0, 1000),
        lastStep
    };
}

module.exports = { collectCertidaoAtAfterFinancasLogin };
