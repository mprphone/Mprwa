function compactSpaces(value) {
    return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t\r\n]+/g, ' ')
        .trim();
}

function cleanText(value) {
    const text = compactSpaces(value).replace(/^[:\-–—]+\s*/, '').replace(/\s+[:\-–—]+\s*$/, '').trim();
    if (!text || text === '-' || text === '—') return '';
    return text;
}

function normalizeDateToIso(value) {
    const text = cleanText(value);
    let match = text.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (match) return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
    match = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
    if (match) return `${match[3]}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
    return text;
}

function normalizeCertidaoCode(value) {
    const raw = String(value || '').trim();
    const grouped = raw.match(/\b(\d{4})\s*[- ]\s*(\d{4})\s*[- ]\s*(\d{4})\b/);
    if (grouped) return `${grouped[1]}-${grouped[2]}-${grouped[3]}`;
    const digits = raw.replace(/\D+/g, '');
    if (digits.length === 12) return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}`;
    return raw;
}

function normalizePostalCodeValue(value) {
    const match = String(value || '').match(/\b(\d{4})\s*[- ]\s*(\d{3})(?:\s+([^\n\r]+))?/);
    if (!match) return '';
    const locality = cleanText(match[3] || '');
    return locality ? `${match[1]}-${match[2]} ${locality}` : `${match[1]}-${match[2]}`;
}

function normalizeManager(manager) {
    const nif = String(manager?.nif || '').replace(/\D+/g, '').slice(-9);
    const name = cleanText(manager?.name || '')
        .replace(/\b(?:NIF|NIPC|Nome|Cargo|Gerente|Administrador)\b/ig, '')
        .replace(/\b\d{9}\b/g, '')
        .trim();
    const email = String(manager?.email || '').trim().toLowerCase();
    const phone = String(manager?.phone || '').trim();
    if (!name && !nif && !email && !phone) return null;
    return { name, nif, email, phone };
}

function mergeManagers(existing = [], incoming = []) {
    const out = [];
    const upsert = (manager) => {
        const normalized = normalizeManager(manager);
        if (!normalized) return;
        const key = normalized.nif || normalized.name.toLocaleLowerCase('pt-PT');
        const index = out.findIndex((item) => (item.nif || String(item.name || '').toLocaleLowerCase('pt-PT')) === key);
        const filled = Object.fromEntries(Object.entries(normalized).filter(([, value]) => cleanText(value)));
        if (index >= 0) out[index] = { ...out[index], ...filled };
        else out.push(normalized);
    };
    (Array.isArray(existing) ? existing : []).forEach(upsert);
    (Array.isArray(incoming) ? incoming : []).forEach(upsert);
    return out;
}

function parseCertidaoPermanenteText(rawText) {
    const text = String(rawText || '').replace(/\u00a0/g, ' ');
    const fields = {};
    if (!text || !/Certid[aã]o de Registo|Matr[ií]cula|NIF\/NIPC|[ÓO]rg[aã]os Sociais/i.test(text)) {
        return { fields, rawText: text };
    }

    const validade = text.match(/V[aá]lida at[eé]:\s*([^\n\r]+)/i)?.[1];
    if (validade) fields.certidaoPermanenteValidade = normalizeDateToIso(validade);

    const nif = text.match(/NIF\/NIPC:\s*(\d{9})/i)?.[1];
    if (nif) fields.nif = nif;

    const firma = text.match(/Firma:\s*([^\n\r]+)/i)?.[1];
    if (firma) fields.company = cleanText(firma);

    const caePrincipal = text.match(/CAE\s+Principal:\s*(\d{5})\b/i)?.[1];
    if (caePrincipal) fields.caePrincipal = caePrincipal;

    const constitutionDate = text.match(/AP\.\s*\d+\/(\d{8})\b/i)?.[1];
    if (constitutionDate) {
        fields.dataConstituicao = `${constitutionDate.slice(0, 4)}-${constitutionDate.slice(4, 6)}-${constitutionDate.slice(6, 8)}`;
    }

    const sedeMatch = text.match(/Sede:\s*([^\n\r]+)(?:\n|\r\n?)Distrito:/i);
    if (sedeMatch) fields.morada = cleanText(sedeMatch[1]);
    const postalMatch = text.match(/\b\d{4}\s*[- ]\s*\d{3}\s+[^\n\r]+/i);
    if (postalMatch) fields.codigoPostal = normalizePostalCodeValue(postalMatch[0]);

    const managers = [];
    const managerBlock = (() => {
        const match = text.match(/[ÓO]rg[aã]os Sociais[\s\S]+?(?=Conservat[oó]ria onde|Inscri[cç][oõ]es|$)/i);
        return match ? match[0] : text;
    })();

    const managerRegex = /Nome:\s*([^\n\r]+)[\s\S]{0,180}?NIF\/?NIPC:\s*(\d{9})[\s\S]{0,140}?Cargo:\s*([^\n\r]+)/gi;
    for (const match of managerBlock.matchAll(managerRegex)) {
        const cargo = cleanText(match[3]);
        if (!/ger[eê]ncia|gerente|administrador|administra[cç][aã]o|gestor|liquidat[aá]rio/i.test(cargo)) continue;
        const manager = normalizeManager({ name: match[1], nif: match[2] });
        if (manager) managers.push(manager);
    }

    if (managers.length > 0) fields.managers = mergeManagers([], managers);
    return { fields, rawText: text };
}

async function collectCertidaoPermanenteProfile(code, options = {}) {
    const normalizedCode = normalizeCertidaoCode(code);
    if (!normalizedCode) return { fields: {}, sourceUrl: '', textPreview: '', ficheiroPdf: '', message: 'Código da certidão permanente em falta.' };

    let playwright;
    try {
        playwright = require('playwright');
    } catch (error) {
        return { fields: {}, sourceUrl: '', textPreview: '', ficheiroPdf: '', message: 'Playwright não está disponível para consultar a certidão permanente.' };
    }

    const browser = await playwright.chromium.launch({ headless: options.headless !== false });
    try {
        const page = await browser.newPage({ viewport: { width: 1365, height: 1600 } });
        const url = `https://registo.justica.gov.pt/Empresas/Consultar-Certidao-Permanente/Iniciar?codcertidao=${encodeURIComponent(normalizedCode)}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(options.navigationTimeoutMs || 30000) || 30000 });
        await page.waitForFunction(() => {
            const text = document.body?.innerText || '';
            return /Certid[aã]o de Registo|certid[aã]o que tentou consultar|estado inv[aá]lido/i.test(text);
        }, { timeout: Number(options.loadTimeoutMs || 12000) || 12000 }).catch(() => null);
        await page.waitForTimeout(Number(options.settleMs || 1200) || 1200).catch(() => null);

        let text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        if (!/Certid[aã]o de Registo|Matr[ií]cula/i.test(text)) {
            const codeInput = page.locator('#dnn_ctr1679_View_Textbox_1679_8').first();
            if (await codeInput.isVisible({ timeout: 1000 }).catch(() => false)) {
                await codeInput.fill(normalizedCode).catch(() => null);
            }
            const nextButton = page.locator('#PageBreak_1679_16_next, input.button-next:visible, input[value="Seguinte"]').first();
            if (await nextButton.isVisible({ timeout: 1000 }).catch(() => false)) {
                await nextButton.click({ timeout: 3000 }).catch(() => null);
                await page.waitForTimeout(3000).catch(() => null);
                text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => text);
            }
        }

        // Guardar PDF se a certidão foi lida com sucesso e temos o customer
        let ficheiroPdf = '';
        const hasContent = /Certid[aã]o de Registo|Matr[ií]cula/i.test(text);
        if (hasContent && options.customer) {
            try {
                const { buildFiscalDownloadPath, uniquePath } = require('./fiscal/documents/documentNamingService');
                const fs = require('fs/promises');
                const path = require('path');
                const year = String(new Date().getFullYear());
                const dest = uniquePath(buildFiscalDownloadPath(options.customer, year, 'certidao_permanente', 'certidao_permanente.pdf'));
                await fs.mkdir(path.dirname(dest), { recursive: true }).catch(() => null);
                await page.pdf({ path: dest, format: 'A4', printBackground: true });
                ficheiroPdf = dest;
            } catch (pdfErr) {
                console.error('[CertidaoPermanente] Erro ao guardar PDF:', pdfErr?.message);
            }
        }

        const parsed = parseCertidaoPermanenteText(text);
        return {
            fields: parsed.fields,
            sourceUrl: page.url(),
            textPreview: compactSpaces(text).slice(0, 600),
            ficheiroPdf,
            message: Object.keys(parsed.fields || {}).length ? '' : 'Não encontrei dados úteis na certidão permanente.',
        };
    } finally {
        await browser.close().catch(() => null);
    }
}

module.exports = {
    collectCertidaoPermanenteProfile,
    normalizeCertidaoCode,
    parseCertidaoPermanenteText,
};
