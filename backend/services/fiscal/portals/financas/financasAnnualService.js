'use strict';

const { currentFiscalYear, recentFiscalYears, financasSearchUrl, cleanText, withTimeout } = require('../../shared/textHelpers');
const { clickFinancasText, clickSearchResultAccess, fillFinancasYear, navigateFinancasYearUrlIfPresent } = require('../../shared/playwrightHelpers');
const { hasYearSpecificNoDocument, extractAnnualDocumentStatusFromText, isAnnualComprovativoPage, isWrongAnnualDocumentPage } = require('../../documents/pdfValidationService');
const { tryDownloadIesComprovativo, clickTextAndCaptureDocument } = require('../../documents/documentCaptureService');
const { saveFiscalPagePdf } = require('../../documents/fileStorageService');

// Captura PDF via intercepção de route no contexto do browser.
// Usado quando o portal abre o PDF inline no browser (não dispara download event).
// Exemplo: Modelo 22 abre em irc.portaldasfinancas.gov.pt/mod22/obter-comprovativo/ID
async function captureViaPdfRouteInterception(page, customer, year, documentType, interceptDomain, trace) {
    const fsNode = require('fs/promises');
    const pathNode = require('path');
    const { buildFiscalDownloadPath, uniquePath } = require('../../documents/documentNamingService');
    const context = page.context();
    let savedPath = '';

    const handler = async (route) => {
        try {
            const response = await route.fetch();
            const headers = response.headers();
            const ct = (headers['content-type'] || '').toLowerCase();
            const url = route.request().url();
            if (trace) trace('captureViaPdfRoute: intercept url:', url.slice(0, 120), '| ct:', ct.slice(0, 40));
            if (!savedPath && (ct.includes('pdf') || ct.includes('octet-stream') || ct.includes('application/download'))) {
                const buffer = await response.body().catch(() => null);
                if (buffer && buffer.length > 100 && buffer.slice(0, 4).toString('latin1') === '%PDF') {
                    const dest = uniquePath(buildFiscalDownloadPath(customer, year, documentType, 'comprovativo.pdf'));
                    await fsNode.mkdir(pathNode.dirname(dest), { recursive: true }).catch(() => null);
                    await fsNode.writeFile(dest, buffer);
                    savedPath = dest;
                    if (trace) trace('captureViaPdfRoute: PDF guardado', dest);
                    await route.fulfill({ response, body: buffer }).catch(() => null);
                    return;
                }
            }
            await route.fulfill({ response }).catch(() => route.continue().catch(() => null));
        } catch (_) {
            await route.continue().catch(() => null);
        }
    };

    const routePattern = `https://${interceptDomain}/**`;
    await context.route(routePattern, handler);

    const formUrl = page.url().split('#')[0]; // URL base do formulário (sem hash)

    // Listener de download como backup (para portais que usam Content-Disposition: attachment)
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);

    try {
        // Clicar no botão OBTER dentro da tabela de resultados (NÃO o item de navegação)
        const clicked = await page.evaluate(() => {
            const isDownloadBtn = (el) => {
                const txt = (el.innerText || el.value || '').trim();
                return /^\s*OBTER\s*$/i.test(txt) ||
                       /^obter\s+comprovativo$/i.test(txt) ||
                       /^obter\s+documento$/i.test(txt);
            };
            const isNavItem = (el) => Boolean(el.closest(
                'nav, [role="navigation"], header, aside, menu, ' +
                '[class*="menu"], [class*="nav-item"], [class*="sidebar"], [class*="o-at-nav"]'
            ));

            // 1ª tentativa: botão dentro de tabela ou linha de resultados
            const inTable = Array.from(document.querySelectorAll('table a, table button, td a, td button, tr a, tr button, tbody a, tbody button, [class*="result"] a, [class*="result"] button'))
                .find((el) => isDownloadBtn(el) && !isNavItem(el));
            if (inTable) { inTable.scrollIntoView({ block: 'center' }); inTable.click(); return 'table:' + inTable.tagName; }

            // 2ª tentativa: qualquer botão que não seja navegação
            const anyBtn = Array.from(document.querySelectorAll('a, button, input[type="submit"]'))
                .find((el) => isDownloadBtn(el) && !isNavItem(el));
            if (anyBtn) { anyBtn.scrollIntoView({ block: 'center' }); anyBtn.click(); return 'any:' + anyBtn.tagName; }

            return null;
        });
        if (trace) trace('captureViaPdfRoute: OBTER clicked via evaluate:', clicked || 'null');

        if (clicked) {
            // Aguardar até 15s para o route handler OU download event capturar o PDF
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline && !savedPath) {
                await page.waitForTimeout(400);
            }

            // Fallback via download event
            if (!savedPath) {
                const dl = await Promise.race([downloadPromise, page.waitForTimeout(2000).then(() => null)]);
                if (dl) {
                    try {
                        const suggested = (() => { try { return dl.suggestedFilename() || 'comprovativo.pdf'; } catch (_) { return 'comprovativo.pdf'; } })();
                        const dest = uniquePath(buildFiscalDownloadPath(customer, year, documentType, suggested));
                        await fsNode.mkdir(pathNode.dirname(dest), { recursive: true }).catch(() => null);
                        await dl.saveAs(dest);
                        savedPath = dest;
                        if (trace) trace('captureViaPdfRoute: PDF via download event:', dest);
                    } catch (e) { if (trace) trace('captureViaPdfRoute: download event error:', e?.message); }
                }
            }

            // Voltar ao form APENAS se PDF foi capturado (para os anos seguintes funcionarem)
            // Se não capturou, mantém na página de resultados para tryDownloadIesComprovativo tentar
            if (savedPath) {
                const currentUrl = page.url();
                if (currentUrl !== formUrl && !currentUrl.includes(formUrl.replace(/^https?:\/\/[^/]+/, ''))) {
                    if (trace) trace('captureViaPdfRoute: a navegar de volta ao form:', formUrl);
                    await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
                    await page.waitForTimeout(800);
                }
            }
        }
    } finally {
        await context.unroute(routePattern, handler).catch(() => null);
    }

    return savedPath;
}

async function collectAnnualFinancasDocument(page, customer, options = {}) {
    const years = Array.isArray(options.targetYears) && options.targetYears.length
        ? options.targetYears.map((year) => String(year || '').trim()).filter(Boolean)
        : options.targetYear
            ? [String(options.targetYear)]
            : recentFiscalYears(3);
    const label = String(options.label || 'Documento').trim();
    const urls = String(options.urls || '').split(',').map((url) => url.trim()).filter(Boolean);
    const trace = (...args) => {
        console.error('[FiscalAT]', label, ...args);
        if (typeof options.traceLog === 'function') options.traceLog(label, ...args);
    };

    let lastText = '';
    for (const url of urls) {
        trace('goto', url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch((error) => {
            trace('goto failed', cleanText(error?.message || error).slice(0, 220));
            return null;
        });
        await page.waitForTimeout(1200);
        lastText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        trace('after goto', page.url(), cleanText(lastText).slice(0, 140));
        if (options.contextPattern?.test(lastText)) break;
    }

    if (options.useSearchAccess) {
        trace('click search access');
        await clickSearchResultAccess(page, options.searchResultLabels || ['Obter Comprovativo']);
    }
    if (Array.isArray(options.entryTextPatterns) && options.entryTextPatterns.length) {
        trace('click entry text');
        await clickFinancasText(page, options.entryTextPatterns);
    }
    await page.waitForTimeout(1000);

    const filings = [];
    let acceptedCount = 0;
    let savedDownloads = 0;
    let sampleText = '';
    for (const year of years) {
        trace('year start', year, page.url());
        const changedYearByUrl = await navigateFinancasYearUrlIfPresent(page, year);
        if (changedYearByUrl) trace('year url changed', year, page.url());

        // Para portais com popup ou tabs por ano (ex: IES): re-abrir e seleccionar o ano
        if (options.reopenEntryForEachYear && Array.isArray(options.entryTextPatterns) && options.entryTextPatterns.length) {
            await clickFinancasText(page, options.entryTextPatterns).catch(() => null);
            await page.waitForTimeout(600);
            trace('year entry reopened', year);

            // Dump diagnóstico de todos os inputs/selects/buttons da página
            const diagInputs = await page.evaluate(() =>
                Array.from(document.querySelectorAll('input, select, button, [role="combobox"], [role="listbox"]'))
                    .map((el) => {
                        const r = el.getBoundingClientRect();
                        const s = window.getComputedStyle(el);
                        return {
                            tag: el.tagName, type: el.type || '', name: el.name || '', id: el.id || '',
                            cls: (el.className || '').toString().slice(0, 40),
                            value: el.value?.slice(0, 20) || '',
                            text: (el.innerText || el.textContent || '').trim().slice(0, 30),
                            placeholder: el.placeholder || '',
                            w: Math.round(r.width), h: Math.round(r.height),
                            display: s.display, visibility: s.visibility,
                        };
                    }).filter((e) => e.w > 0 || e.text.length > 0)
            ).catch(() => []);
            trace(`year diag inputs [${year}]:`, JSON.stringify(diagInputs.slice(0, 20)));

            // Tentar clicar o botão custom de selecção de ano (ex: IES usa <button class="o-at-input o-at-select">)
            const oatYearSelected = await (async () => {
                const selBtn = page.locator('button[class*="o-at-select"], button[class*="o-at-input"]').first();
                const hasSelBtn = await selBtn.isVisible({ timeout: 1000 }).catch(() => false);
                if (!hasSelBtn) return false;
                await selBtn.click({ timeout: 2000 });
                await page.waitForTimeout(400);
                // Após abrir o dropdown, clicar na opção do ano pretendido
                const yearClicked = await page.evaluate((yr) => {
                    const candidates = Array.from(document.querySelectorAll(
                        '[role="option"], [role="listitem"], li, button, span, div'
                    ));
                    for (const el of candidates) {
                        const txt = (el.innerText || el.textContent || '').trim();
                        if (txt !== yr) continue;
                        const r = el.getBoundingClientRect();
                        if (r.width === 0 && r.height === 0) continue;
                        el.scrollIntoView({ block: 'nearest' });
                        el.click();
                        return true;
                    }
                    return false;
                }, String(year));
                return yearClicked;
            })();
            if (oatYearSelected) {
                await page.waitForTimeout(500);
                trace('year selected via o-at-select dropdown:', year);
            } else {
                // Fallback: clicar por texto exacto do ano em tabs/links
                const yearClickedInList = await page.evaluate((yr) => {
                    const candidates = Array.from(document.querySelectorAll(
                        '[role="tab"], [role="option"], [role="listitem"], a, button, li, td, span, div'
                    ));
                    for (const el of candidates) {
                        const txt = (el.innerText || el.textContent || '').trim();
                        if (txt !== yr) continue;
                        const r = el.getBoundingClientRect();
                        if (r.width === 0 && r.height === 0) continue;
                        const s = window.getComputedStyle(el);
                        if (s.display === 'none' || s.visibility === 'hidden') continue;
                        el.scrollIntoView({ block: 'nearest' });
                        el.click();
                        return true;
                    }
                    return false;
                }, String(year));
                if (yearClickedInList) {
                    await page.waitForTimeout(800);
                    trace('year clicked in list/tab:', year);
                }
            }
        }

        await withTimeout(fillFinancasYear(page, year), 4000, `Tempo limite ao preencher ano ${year}.`).catch((error) => {
            trace('year fill skipped', year, cleanText(error?.message || error));
            return false;
        });
        trace('year filled', year);
        if (!changedYearByUrl) {
            // Usar selector específico se definido (ex: IES tem botão o-at-button distinto do search bar)
            let submitted = false;
            if (options.pesquisarLocator) {
                const pesquisarBtn = page.locator(options.pesquisarLocator).first();
                if (await pesquisarBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
                    await pesquisarBtn.click({ timeout: 3000 }).catch(() => null);
                    submitted = true;
                }
            }
            if (!submitted) {
                await clickFinancasText(page, [/Pesquisar/i, /Consultar/i, /Procurar/i]);
            }
            trace('year submitted', year);

            // Para SPAs (ex: IES): aguardar resposta da API + extrair dados de filing directamente do JSON
            if (options.waitForApiPattern) {
                const apiRes = await page.waitForResponse(
                    (res) => options.waitForApiPattern.test(res.url()),
                    { timeout: 6000 }
                ).catch(() => null);
                if (apiRes && typeof options.parseApiResponseFiling === 'function') {
                    try {
                        const json = await apiRes.json().catch(() => null);
                        if (trace) trace('IES API JSON keys:', json ? JSON.stringify(Object.keys(json)).slice(0, 200) : 'null');
                        if (trace && json) trace('IES API JSON sample:', JSON.stringify(json).slice(0, 500));
                        if (json) options._lastApiFilingData = options.parseApiResponseFiling(json, year);
                        if (trace) trace('IES parsed filing:', JSON.stringify(options._lastApiFilingData));
                    } catch (_) {}
                }
                await page.waitForTimeout(800);
            }
        } else {
            trace('year submitted skipped url-driven', year);
        }
        await page.waitForTimeout(1800);

        lastText = await page.locator('body').innerText({ timeout: 8000 }).catch(() => lastText);
        if (Array.isArray(options.openResultPatterns) && options.openResultPatterns.length) {
            const clickedResult = await clickFinancasText(page, options.openResultPatterns, 2500).catch(() => false);
            if (clickedResult) {
                trace('result opened', year);
                await page.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => null);
                await page.waitForTimeout(1200);
                lastText = await page.locator('body').innerText({ timeout: 8000 }).catch(() => lastText);
            }
        }
        sampleText = sampleText || lastText;
        const isComprovativoPage = isAnnualComprovativoPage(lastText, year, options.noDocumentPatterns || []);
        const targetYear = String(year || currentFiscalYear());
        const hasYearContext = new RegExp(`ano\\s+(?:de\\s+)?${targetYear}|exerc[ií]cio\\s+(?:de\\s+)?${targetYear}|\\b${targetYear}\\b`, 'i').test(lastText);
        const noDocumentForYear = hasYearSpecificNoDocument(lastText, targetYear, options.noDocumentPatterns || []);
        const isDocumentPage = isComprovativoPage || Boolean(options.documentEvidencePattern?.test(lastText) && hasYearContext && !isWrongAnnualDocumentPage(lastText));
        trace('year result', year, isDocumentPage ? 'document-page' : 'wrong-page', cleanText(lastText).slice(0, 180));
        let filing = isDocumentPage
            ? extractAnnualDocumentStatusFromText(lastText, year, options.noDocumentPatterns || [])
            : { ano: String(year), situacao: '', dataRecepcao: '' };
        // Para SPAs com API JSON (ex: IES): sobrescrever com dados directamente da API se mais completos
        if (options._lastApiFilingData && options._lastApiFilingData.ano === String(year)) {
            const api = options._lastApiFilingData;
            if (api.situacao && !filing.situacao) filing = { ...filing, ...api };
            else if (api.situacao) filing.situacao = api.situacao;
            if (api.dataRecepcao && !filing.dataRecepcao) filing.dataRecepcao = api.dataRecepcao;
            options._lastApiFilingData = null; // limpar para o próximo ano
        }
        let comprovativoPath = '';
        if (isDocumentPage && !noDocumentForYear) {
            const docType = options.documentType || 'documento';

            // Verificar se já existe comprovativo para este ano e tipo (evitar duplicados)
            const existingPath = await (async () => {
                try {
                    const { buildFiscalDownloadPath } = require('../../documents/documentNamingService');
                    const fsNode = require('fs/promises');
                    const pathNode = require('path');
                    const samplePath = buildFiscalDownloadPath(customer, year, docType, 'x.pdf');
                    const baseDir = pathNode.dirname(samplePath);
                    // Prefixo específico: "IES_505168634_2024_" (tipo + NIF + ano)
                    const sampleName = pathNode.basename(samplePath); // IES_NIF_2024_timestamp.pdf
                    const prefix = sampleName.replace(/_[^_]+\.pdf$/, '_'); // "IES_NIF_2024_"
                    const files = await fsNode.readdir(baseDir).catch(() => []);
                    const existing = files.find((f) => f.startsWith(prefix) && f.endsWith('.pdf'));
                    return existing ? pathNode.join(baseDir, existing) : '';
                } catch (_) { return ''; }
            })();
            if (existingPath) {
                trace('comprovativo já existe para', year, '— a usar:', existingPath);
                comprovativoPath = existingPath;
            } else if (options.routeInterceptDomain) {
                // Captura PDF via intercepção de route no contexto (para portais que abrem PDF inline)
                comprovativoPath = await captureViaPdfRouteInterception(
                    page, customer, year, docType, options.routeInterceptDomain, trace
                );
            }
            if (!comprovativoPath) {
                comprovativoPath = await tryDownloadIesComprovativo(page, customer, year, docType);
            }
        }
        if (!comprovativoPath && options.allowPagePdfFallback && isDocumentPage && !noDocumentForYear && (filing.situacao || options.savePagePdfOnEvidence)) {
            filing.comprovativoPath = await saveFiscalPagePdf(page, customer, year, options.documentType || 'documento').catch(() => '');
        }
        if (comprovativoPath) trace('download saved', year, comprovativoPath);
        if (comprovativoPath) { filing.comprovativoPath = comprovativoPath; savedDownloads += 1; }
        if (!comprovativoPath && filing.comprovativoPath) { trace('page pdf saved', year, filing.comprovativoPath); savedDownloads += 1; }
        filings.push(filing);

        const isExpectedContext = options.contextPattern ? options.contextPattern.test(lastText) : true;
        const isSearchResults = /Resultados da Pesquisa|Resultados da pesquisa/i.test(lastText);
        const foundEvidence = Boolean(isExpectedContext && isDocumentPage && (filing.situacao || filing.dataRecepcao || filing.comprovativoPath));
        if (foundEvidence && !isSearchResults) acceptedCount += 1;
    }

    return {
        status: acceptedCount > 0 ? 'completed' : 'needs_review',
        filing: filings[0] || null,
        filings,
        comprovativoPath: filings.find((item) => item.comprovativoPath)?.comprovativoPath || '',
        message: acceptedCount > 0
            ? `${label} consultado para ${acceptedCount}/${years.length} exercício(s)${savedDownloads ? `, ${savedDownloads} comprovativo(s) guardado(s)` : ''}.`
            : `Não consegui confirmar ${label} automaticamente. Validar navegação do portal.`,
        pageTextSample: cleanText(lastText || sampleText).slice(0, 1000),
    };
}

async function collectIesAfterFinancasLogin(page, customer, options = {}) {
    return collectAnnualFinancasDocument(page, customer, {
        ...options,
        label: 'IES',
        documentType: 'ies',
        urls: String(process.env.PORTAL_FINANCAS_IES_URLS || [
            financasSearchUrl('IES obter comprovativo'),
            financasSearchUrl('IES'),
        ].join(',')),
        contextPattern: /IES|Informa[cç][aã]o\s+Empresarial|Declara[cç][aã]o\s+Anual/i,
        useSearchAccess: true,
        searchResultLabels: ['IES > Obter Comprovativo', 'IES IRC > Obter Comprovativo'],
        entryTextPatterns: [/Obter\s+[Cc]omprovativo/i],
        noDocumentPatterns: [
            /n[aã]o\s+h[áa]\s+comprovativo\s+dispon[ií]vel/i,
            /n[aã]o\s+possui\s+declara[cç][oõ]es/i,
            /n[aã]o\s+existem\s+declara[cç][oõ]es/i,
            /sem\s+declara[cç][aã]o\s+dispon[ií]vel/i,
            /declara[cç][aã]o\s+n[aã]o\s+dispon[ií]vel/i,
            /n[aã]o\s+foram\s+encontrados\s+resultados/i,
        ],
        // PDF abre inline no browser — interceptar via route handler
        routeInterceptDomain: 'oa.portaldasfinancas.gov.pt',
        // O popup IES fecha/muda após cada pesquisa — reabrir antes de cada ano
        reopenEntryForEachYear: true,
        // IES usa botão custom para PESQUISAR (evitar clicar no submit da barra de pesquisa global)
        pesquisarLocator: 'button[class*="o-at-button"]:not([class*="main-search"])',
        // Aguardar resposta da API JSON antes de ler o texto (a SPA React carrega dados async)
        waitForApiPattern: /obterComprovativoPorAno/,
        // Extrair estado/data directamente do JSON da API
        // Estrutura real: { declsModelList: [{ situacao, dataSubmissao, ... }], situacaoVigenteModelList: [...] }
        parseApiResponseFiling: (json, year) => {
            const decls = json?.declsModelList;
            if (!Array.isArray(decls) || decls.length === 0) return null;
            const best = decls[0]; // Todos os resultados são para o ano solicitado
            const situacao = String(best.situacao || '').trim();
            // dataSubmissao = "2025-07-16 11:21:11" → pegar só a data
            const dataRecepcao = String(best.dataSubmissao || '').slice(0, 10);
            return situacao || dataRecepcao ? { ano: String(year), situacao, dataRecepcao } : null;
        },
    });
}

async function collectModelo22AfterFinancasLogin(page, customer, options = {}) {
    return collectAnnualFinancasDocument(page, customer, {
        ...options,
        label: 'Modelo 22',
        documentType: 'modelo22',
        urls: String(process.env.PORTAL_FINANCAS_MODELO22_URLS || [
            financasSearchUrl('modelo 22 obter comprovativo'),
            financasSearchUrl('modelo 22'),
        ].join(',')),
        contextPattern: /Modelo\s+22|IRC|Imposto\s+sobre\s+o\s+Rendimento\s+das\s+Pessoas\s+Coletivas/i,
        useSearchAccess: true,
        // Específico para Modelo 22 — evita clicar no Aceder da IES ou de outro documento
        searchResultLabels: ['Modelo 22 de IRC > Obter Comprovativo', 'Modelo 22 IRC > Obter Comprovativo', 'Modelo 22 > Obter Comprovativo'],
        entryTextPatterns: [/Obter\s+[Cc]omprovativo/i],
        noDocumentPatterns: [/n[aã]o\s+h[áa]\s+comprovativo\s+dispon[ií]vel/i, /n[aã]o\s+possui\s+declara[cç][oõ]es/i, /n[aã]o\s+existem\s+declara[cç][oõ]es/i],
        // O PDF do Modelo 22 abre inline no browser — interceptar via route handler
        routeInterceptDomain: 'irc.portaldasfinancas.gov.pt',
    });
}

function looksLikeModelo22Document(rawText) {
    if (!rawText || rawText.length < 30) return false;
    const text = rawText.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    // Deve conter referência a Modelo 22 / IRC e NIF/NIPC + dados de período
    return /modelo\s*22|irc|imposto\s+sobre\s+o\s+rendimento.*coletivas/.test(text) &&
        /nif|nipc/.test(text) &&
        /per[ií]odo|exerc[ií]cio|data\s+de\s+recep|situacao|certa|entregue|rececionad/.test(text);
}

async function collectIrsAfterFinancasLogin(page, customer, options = {}) {
    return collectAnnualFinancasDocument(page, customer, {
        ...options,
        label: 'IRS',
        documentType: 'irs',
        urls: String(process.env.PORTAL_FINANCAS_IRS_URLS || [
            financasSearchUrl('irs obter comprovativo'),
            'https://www.portaldasfinancas.gov.pt/pt/menu.action?pai=384',
        ].join(',')),
        contextPattern: /IRS|Modelo\s+3|Imposto\s+sobre\s+o\s+Rendimento\s+das\s+Pessoas\s+Singulares/i,
        useSearchAccess: true,
        searchResultLabels: ['IRS > Obter Comprovativo', 'Modelo 3 > Obter Comprovativo', 'Obter Comprovativo'],
        entryTextPatterns: [/Obter\s+[Cc]omprovativo/i],
        noDocumentPatterns: [/n[aã]o\s+h[áa]\s+comprovativo\s+dispon[ií]vel/i, /n[aã]o\s+possui\s+declara[cç][oõ]es/i, /n[aã]o\s+existem\s+declara[cç][oõ]es/i],
    });
}

module.exports = { collectAnnualFinancasDocument, collectIesAfterFinancasLogin, collectModelo22AfterFinancasLogin, collectIrsAfterFinancasLogin };
