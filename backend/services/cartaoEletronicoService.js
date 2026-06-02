'use strict';

function compactSpaces(value) {
    return String(value || '').replace(/ /g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
}

function normalizeCartaoCode(value) {
    const raw = String(value || '').trim();
    // Aceitar formatos: XXXX-XXXX-XXXX ou 12 dígitos
    const grouped = raw.match(/\b(\d{4})\s*[- ]\s*(\d{4})\s*[- ]\s*(\d{4})\b/);
    if (grouped) return `${grouped[1]}-${grouped[2]}-${grouped[3]}`;
    const digits = raw.replace(/\D+/g, '');
    if (digits.length === 12) return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}`;
    return raw;
}

async function collectCartaoEletronicoProfile(code, options = {}) {
    const normalizedCode = normalizeCartaoCode(code);
    if (!normalizedCode) return { fields: {}, sourceUrl: '', textPreview: '', ficheiroPdf: '', message: 'Código do cartão eletrónico em falta.' };

    let playwright;
    try {
        playwright = require('playwright');
    } catch (error) {
        return { fields: {}, sourceUrl: '', textPreview: '', ficheiroPdf: '', message: 'Playwright não está disponível.' };
    }

    // Portal IRN - mesmo domínio que a certidão permanente (não bloqueado por WAF)
    const url = `https://registo.justica.gov.pt/Empresas/Cartao-Empresa/Iniciar?codigocartao=${encodeURIComponent(normalizedCode)}`;

    const browser = await playwright.chromium.launch({ headless: options.headless !== false });
    try {
        const page = await browser.newPage({ viewport: { width: 1365, height: 1600 } });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(options.navigationTimeoutMs || 30000) });
        await page.waitForTimeout(Number(options.settleMs || 3000));

        let text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');

        const fields = parseCartaoEletronicoText(text, normalizedCode);

        // Guardar PDF
        let ficheiroPdf = '';
        if (options.customer) {
            try {
                const { buildFiscalDownloadPath, uniquePath } = require('./fiscal/documents/documentNamingService');
                const fs = require('fs/promises');
                const year = String(new Date().getFullYear());
                const dest = uniquePath(buildFiscalDownloadPath(options.customer, year, 'cartao_eletronico', 'cartao_eletronico.pdf'));
                await fs.mkdir(require('path').dirname(dest), { recursive: true });
                await page.pdf({ path: dest, format: 'A4', printBackground: true });
                ficheiroPdf = dest;
            } catch (pdfErr) {
                console.warn('[CartaoEletronico] Não guardou PDF:', pdfErr?.message);
            }
        }

        return {
            fields,
            sourceUrl: page.url(),
            textPreview: compactSpaces(text).slice(0, 500),
            ficheiroPdf,
            message: ficheiroPdf ? `Cartão eletrónico ${normalizedCode} consultado e PDF guardado.` : `Cartão eletrónico ${normalizedCode} consultado.`,
        };
    } finally {
        await browser.close().catch(() => null);
    }
}

function parseCartaoEletronicoText(text, code) {
    const raw = compactSpaces(text);
    const fields = {};

    // Extrair NIF
    const nifMatch = raw.match(/\b(\d{9})\b/);
    if (nifMatch) fields.nif = nifMatch[1];

    // Extrair denominação/empresa
    const denomMatch = raw.match(/Denomina[cç][aã]o\s*[:\-]?\s*([^\n\r]+)/i);
    if (denomMatch) fields.company = denomMatch[1].trim();

    // Extrair data de registo/constituição
    const dataMatch = raw.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
    if (dataMatch) fields.dataRegisto = `${dataMatch[3]}-${dataMatch[2].padStart(2,'0')}-${dataMatch[1].padStart(2,'0')}`;

    // Guardar código
    fields.cartaoEletronicoNumero = code;

    return fields;
}

module.exports = { collectCartaoEletronicoProfile, normalizeCartaoCode };
