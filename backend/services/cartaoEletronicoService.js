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

    const url = 'https://registo.justica.gov.pt/Empresas/Consultar-Cartao-de-Empresa-ou-Pessoa-Coletiva/iniciar';

    const browser = await playwright.chromium.launch({ headless: options.headless !== false });
    try {
        const page = await browser.newPage({ viewport: { width: 1365, height: 1600 } });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(options.navigationTimeoutMs || 30000) });
        await page.waitForTimeout(1000);

        // Passo 1: clicar "Iniciar"
        const iniciarBtn = page.locator('button:has-text("Iniciar"), a:has-text("Iniciar"), input[value*="Iniciar"]').first();
        await iniciarBtn.click({ timeout: 10000 }).catch(async () => {
            // Tentar submit do form directamente
            await page.locator('form').first().evaluate(f => f.requestSubmit()).catch(() => null);
        });
        await page.waitForTimeout(1500);

        // Passo 2: preencher o código
        const codeInput = page.locator('input[placeholder*="0000"], input[id*="odigo"], input[name*="odigo"], input[type="text"]').first();
        await codeInput.fill(normalizedCode, { timeout: 8000 }).catch(() => null);
        await page.waitForTimeout(500);

        // Passo 3: submeter
        const obterBtn = page.locator('button:has-text("Obter"), button:has-text("Consultar"), button[type="submit"]').first();
        await obterBtn.click({ timeout: 8000 }).catch(async () => {
            await page.keyboard.press('Enter');
        });
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
    const fields = { cartaoEletronicoNumero: code };

    // NIPC (9 dígitos)
    const nipcMatch = raw.match(/NIPC\s*(\d{9})/i) || raw.match(/\b([25]\d{8})\b/);
    if (nipcMatch) fields.nif = nipcMatch[1];

    // Nome / denominação
    const nomeMatch = raw.match(/Nome\s+([A-ZÁÉÍÓÚÀÂÊÔÃÕÇ][^\n]{3,80})/i)
        || raw.match(/Denomina[cç][aã]o\s*[:\-]?\s*([^\n\r]{3,80})/i);
    if (nomeMatch) fields.company = nomeMatch[1].trim();

    // Natureza Jurídica
    const natMatch = raw.match(/Natureza Jur[ií]dica\s+([^\n]{3,60})/i);
    if (natMatch) fields.naturezaJuridica = natMatch[1].trim();

    // Sede — Código Postal
    const cpMatch = raw.match(/(\d{4})\s*[—\-]\s*(\d{3})/);
    if (cpMatch) fields.codigoPostal = `${cpMatch[1]}-${cpMatch[2]}`;

    // Localidade
    const locMatch = raw.match(/Localidade\s+([A-ZÁÉÍÓÚÀÂÊÔÃÕÇ][^\n]{2,50})/i);
    if (locMatch) fields.localidade = locMatch[1].trim();

    // Data de constituição
    const dataMatch = raw.match(/Data de constitui[cç][aã]o\s+(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/i)
        || raw.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
    if (dataMatch) fields.dataConstituicao = `${dataMatch[3]}-${dataMatch[2].padStart(2,'0')}-${dataMatch[1].padStart(2,'0')}`;

    // CAE principal
    const caeMatch = raw.match(/CAE principal\s+(\d{4,5})/i);
    if (caeMatch) fields.caePrincipal = caeMatch[1];

    return fields;
}

module.exports = { collectCartaoEletronicoProfile, normalizeCartaoCode };
