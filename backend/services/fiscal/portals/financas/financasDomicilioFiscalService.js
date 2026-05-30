'use strict';

const { cleanText, financasSearchUrl } = require('../../shared/textHelpers');
const { clickFinancasText, clickSearchResultAccess } = require('../../shared/playwrightHelpers');
const { looksLikeDomicilioFiscalDocument } = require('../../documents/pdfValidationService');
const { tryDownloadIesComprovativo, clickTextAndCaptureDocument } = require('../../documents/documentCaptureService');
const { saveFiscalPagePdf } = require('../../documents/fileStorageService');

async function collectDomicilioFiscalAfterFinancasLogin(page, customer) {
    const year = String(new Date().getFullYear());
    const readText = async () => cleanText(await page.locator('body').innerText({ timeout: 7000 }).catch(() => ''));

    const urls = String(process.env.PORTAL_FINANCAS_DOMICILIO_FISCAL_URLS || [
        financasSearchUrl('certidões pedir certidões'),
    ].join(',')).split(',').map((url) => url.trim()).filter(Boolean);

    let pageText = '';
    for (const url of urls) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null);
        await page.waitForTimeout(1200);
        pageText = await readText();
        if (/certid[oõ]es|pedir\s+certid/i.test(pageText)) break;
    }

    await clickSearchResultAccess(page, ['Certidões > Pedir Certidão', 'Pedir Certidão', 'Pedir certidões']).catch(() => false);
    await clickFinancasText(page, [/Pedir\s+Certid/i, /Certid[oõ]es/i], 3000).catch(() => false);
    await page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => null);
    await page.waitForTimeout(1000);

    const selected = await page.evaluate(() => {
        const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const wanted = ['domicilio fiscal', 'domicilio', 'morada'];
        const selects = Array.from(document.querySelectorAll('select'));
        for (const select of selects) {
            const options = Array.from(select.options || []);
            const option = options.find((item) => wanted.some((token) => fold(item.textContent || item.value).includes(token)));
            if (!option) continue;
            select.value = option.value;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
        const radios = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
        for (const input of radios) {
            let node = input;
            let text = '';
            for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
                text += ` ${node.innerText || node.textContent || ''}`;
            }
            if (wanted.some((token) => fold(text).includes(token))) { input.click(); return true; }
        }
        return false;
    }).catch(() => false);

    if (selected) await page.waitForTimeout(700);
    let ficheiroPdf = '';
    await clickFinancasText(page, [/Confirmar/i, /Continuar/i], 4000).catch(() => false);
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(1200);

    ficheiroPdf = await clickTextAndCaptureDocument(
        page,
        [/Obter/i, /Emitir/i, /Imprimir/i, /Download/i, /Descarregar/i],
        customer, year, 'domicilio_fiscal', looksLikeDomicilioFiscalDocument, 15000
    ).catch(() => '');

    if (!ficheiroPdf) {
        await clickFinancasText(page, [/Obter/i, /Emitir/i, /Imprimir/i, /Download/i, /Descarregar/i], 4000).catch(() => false);
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(1200);

    pageText = await readText();
    if (!ficheiroPdf) {
        ficheiroPdf = await tryDownloadIesComprovativo(page, customer, year, 'domicilio_fiscal').catch(() => '');
    }
    const moradaMatch = pageText.match(/morada[:\s]+(.{5,120}?)(?:\n|NIF|NIPC|data|v[áa]lid)/i);
    return {
        status: ficheiroPdf ? 'completed' : 'needs_review',
        ficheiroPdf,
        valida: Boolean(ficheiroPdf),
        morada: moradaMatch ? cleanText(moradaMatch[1]) : '',
        message: ficheiroPdf
            ? 'Domicílio Fiscal guardado na pasta do cliente.'
            : 'Não encontrei o Domicílio Fiscal final. A página atual parece ser menu/consulta.',
        pageTextSample: cleanText(pageText).slice(0, 1000),
    };
}

module.exports = { collectDomicilioFiscalAfterFinancasLogin };
