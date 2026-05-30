'use strict';

const { cleanText, normalizeDateToIso } = require('../../shared/textHelpers');
const { buildFiscalDownloadPath, uniquePath } = require('../../documents/documentNamingService');
const fs = require('fs/promises');
const path = require('path');

async function collectPmeCertificateAfterIapmeiLogin(page, customer) {
    const year = String(new Date().getFullYear());
    const trace = (...args) => console.error('[FiscalIAPMEI PME]', ...args);
    const readFullText = async () => cleanText(await page.locator('body').innerText({ timeout: 8000 }).catch(() => ''));
    const wait = (ms) => page.waitForTimeout(ms);

    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
    await wait(1500);

    // Capturar PDF via intercepção de route + evento download
    const captureDownload = async (clickFn) => {
        let captured = '';
        const context = page.context();
        const handler = async (route) => {
            try {
                const response = await route.fetch();
                const buffer = await response.body().catch(() => null);
                if (!buffer) { await route.continue().catch(() => null); return; }
                const isPdf = buffer.length > 4 && buffer.slice(0, 4).toString('latin1') === '%PDF';
                if (isPdf && !captured) {
                    const dest = uniquePath(buildFiscalDownloadPath(customer, year, 'pme', 'certificado_pme.pdf'));
                    await fs.mkdir(path.dirname(dest), { recursive: true }).catch(() => null);
                    await fs.writeFile(dest, buffer).catch(() => null);
                    captured = dest;
                    trace('PDF gravado via route:', dest);
                }
                await route.fulfill({ response, body: buffer });
            } catch (_) { await route.continue().catch(() => null); }
        };
        await context.route('https://webapps.iapmei.pt/**', handler);
        const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
        await clickFn();
        const dl = await downloadPromise;
        if (dl && !captured) {
            try {
                const suggested = (() => { try { return dl.suggestedFilename() || 'certidao_pme.pdf'; } catch (_) { return 'certidao_pme.pdf'; } })();
                const dest = uniquePath(buildFiscalDownloadPath(customer, year, 'pme', suggested));
                await fs.mkdir(path.dirname(dest), { recursive: true }).catch(() => null);
                await dl.saveAs(dest);
                captured = dest;
                trace('PDF gravado via download event:', dest);
            } catch (e) { trace('ERRO save download:', e?.message); }
        }
        await context.unroute('https://webapps.iapmei.pt/**', handler).catch(() => null);
        return captured;
    };

    // Clicar num elemento com force:true (ultrapassa display:none / dimensões 0)
    const forceClickText = async (patterns, label) => {
        const patternSpecs = patterns.map((p) =>
            p instanceof RegExp ? { type: 'regex', source: p.source, flags: p.flags } : { type: 'text', value: String(p) }
        );

        // Playwright locator com force:true — funciona mesmo em elementos ocultos
        for (const spec of patternSpecs) {
            if (spec.type !== 'text') continue;
            for (const loc of [
                page.getByRole('link', { name: new RegExp('^' + spec.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }).first(),
                page.locator(`text="${spec.value}"`).first(),
            ]) {
                const n = await loc.count().catch(() => 0);
                if (!n) continue;
                try {
                    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => null);
                    await loc.click({ timeout: 4000, force: true });
                    trace(`forceClickText [${label}]: locator OK ("${spec.value}")`);
                    return true;
                } catch (_) {}
            }
        }

        // Fallback evaluate — sem filtro isVisible, inclui hidden
        const clicked = await page.evaluate((specs) => {
            const matchers = specs.map((s) => s.type === 'regex' ? new RegExp(s.source, s.flags) : null);
            const textMatchers = specs.filter((s) => s.type === 'text').map((s) => s.value.toLowerCase());
            const fold = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
            const skip = (t) => /obter certifica|renovac|alterac|formulario|preenchimento|relatorio/i.test(t);
            let best = null;
            for (const selector of ['a,button,input[type="button"],input[type="submit"]', 'li,td,span,div']) {
                for (const el of Array.from(document.querySelectorAll(selector))) {
                    const ownText = fold(
                        el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
                            ? el.childNodes[0].textContent
                            : el.innerText || el.textContent || el.value || el.getAttribute('title') || el.getAttribute('aria-label') || ''
                    );
                    const matched = matchers.some((re) => re && re.test(ownText)) || textMatchers.some((t) => ownText.includes(t));
                    if (!matched || skip(ownText)) continue;
                    if (!best || ownText.length < best.text.length) best = { el, text: ownText };
                }
                if (best) break;
            }
            if (!best) return null;
            best.el.scrollIntoView({ block: 'center' });
            best.el.click();
            return best.text;
        }, patternSpecs).catch(() => null);
        trace(`forceClickText [${label}] evaluate:`, clicked);
        return !!clicked;
    };

    // Dump completo de <a> (inclui hidden) para diagnóstico
    const dumpAllLinks = async (label) => {
        const links = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a')).map((el) => {
                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);
                return {
                    text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
                    href: el.getAttribute('href') || '',
                    w: Math.round(r.width), h: Math.round(r.height),
                    display: s.display, vis: s.visibility,
                };
            }).filter((e) => e.text.length > 0 || e.href.length > 0)
        ).catch(() => []);
        trace(`ALL <a> [${label}]:`, JSON.stringify(links));
        return links;
    };

    // ===========================================================================
    // FLUXO PME (baseado no manual e HTML inspeccionado):
    //   Default.aspx → ProcessoEmpresa.aspx → Certificado.aspx → PDF
    // ===========================================================================
    trace('=== início do fluxo PME ===');
    trace('url inicial:', page.url());

    // ------------------------------------------------------------------
    // Step 1: Navegar para ProcessoEmpresa.aspx
    // O menu lateral tem uma seta pequena (14×17px) com href="ProcessoEmpresa.aspx"
    // Clicar directamente nesse link é mais fiável que clicar no texto do menu
    // ------------------------------------------------------------------
    const step1Link = page.locator('a[href="ProcessoEmpresa.aspx"], a[href*="ProcessoEmpresa"]').first();
    const hasStep1 = await step1Link.isVisible({ timeout: 3000 }).catch(() => false);
    if (hasStep1) {
        trace('step1: clicar seta ProcessoEmpresa.aspx');
        await step1Link.click({ timeout: 8000 });
    } else {
        trace('step1: navegar directamente para ProcessoEmpresa.aspx');
        const baseUrl = page.url().replace(/\/[^/]*$/, '/');
        await page.goto(baseUrl + 'ProcessoEmpresa.aspx', { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);
    }
    await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 10000 }),
        wait(4000),
    ]).catch(() => null);
    await wait(1000);

    trace('url após step1:', page.url());
    const text1 = await readFullText();
    trace('texto step1 (1500):', text1.slice(0, 1500));
    await dumpAllLinks('step1-ProcessoEmpresa');

    // ------------------------------------------------------------------
    // Step 2: Clicar botão "Certificado" na tabela do histórico
    // São <input type="image" src="bt_certificado2_up.gif"> com onclick doPostBack
    // O primeiro com onclick é a linha mais recente (o header não tem onclick)
    // ------------------------------------------------------------------
    const certImgBtn = page.locator('input[type="image"][src*="bt_certificado2_up.gif"][onclick*="doPostBack"]').first();
    const hasCertImg = await certImgBtn.isVisible({ timeout: 3000 }).catch(() => false);
    trace('step2: certImgBtn visível:', hasCertImg);
    if (hasCertImg) {
        await certImgBtn.click({ timeout: 8000 });
    } else {
        // Fallback: forçar clique mesmo que getBoundingClientRect dê 0
        await certImgBtn.click({ timeout: 8000, force: true }).catch(async () => {
            // Último recurso: disparar onclick via evaluate
            await page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('input[type="image"]'))
                    .find((el) => /bt_certificado2_up/.test(el.src) && el.getAttribute('onclick'));
                if (btn) btn.click();
            });
        });
    }
    await Promise.race([
        page.waitForLoadState('networkidle', { timeout: 12000 }),
        wait(6000),
    ]).catch(() => null);
    await wait(1500);

    trace('url após step2:', page.url());
    const text2 = await readFullText();
    trace('texto step2 (600):', text2.slice(0, 600));
    const links2 = await dumpAllLinks('step2-Certificado');

    // ------------------------------------------------------------------
    // Step 3: capturar PDF via "certificado (pdf)" ou intercepção de route
    // ------------------------------------------------------------------
    const downloaded = await captureDownload(async () => {
        // Tentar input[type=image] com "certificado" no src (página Certificado.aspx)
        const pdfImgBtn = page.locator('input[type="image"][src*="certificado"][onclick*="doPostBack"]').first();
        const hasPdfBtn = await pdfImgBtn.isVisible({ timeout: 2000 }).catch(() => false);
        if (hasPdfBtn) {
            trace('step3: clicar botão PDF certificado');
            await pdfImgBtn.click({ timeout: 8000 });
            await wait(3000);
            return;
        }

        // Tentar pelo href
        const pdfHref = links2.find((l) => /\.pdf|certificado.*pdf|pdf.*certificado/i.test(l.href + l.text));
        if (pdfHref) {
            const pdfUrl = pdfHref.href.startsWith('http')
                ? pdfHref.href
                : 'https://webapps.iapmei.pt/PME/' + pdfHref.href.replace(/^\.?\//, '');
            trace('step3: navegar via href PDF:', pdfUrl);
            await page.goto(pdfUrl, { timeout: 15000, waitUntil: 'domcontentloaded' }).catch(() => null);
            await wait(2000);
            return;
        }

        // Clique por texto
        await forceClickText([
            /certificado\s*\(?pdf\)?/i,
            /\bPDF\b/i,
            /Descarregar/i,
            /Download/i,
            /Imprimir/i,
        ], 'certificado(pdf)');
        await wait(3000);
    });
    trace('PDF capturado:', downloaded || 'nenhum');

    const finalText = await readFullText();
    trace('texto final (400):', finalText.slice(0, 400));
    const dateMatch = finalText.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{1,2}-\d{1,2})\b/);
    const typeMatch = finalText.match(/\b(Microempresa|Pequena\s+Empresa|M[eé]dia\s+Empresa|PME\s+L[ií]der|PME\s+Excel[eê]ncia)\b/i);

    return {
        status: downloaded ? 'completed' : 'needs_review',
        ficheiroPdf: downloaded || '',
        dataValidade: '',
        dataEfeito: dateMatch ? normalizeDateToIso(dateMatch[1]) : '',
        notas: typeMatch ? cleanText(typeMatch[1]) : '',
        message: downloaded
            ? 'Certificado PME guardado na pasta do cliente.'
            : 'Não encontrei o link do certificado PME (pdf). Verifica se está disponível no portal IAPMEI.',
        pageTextSample: cleanText(finalText).slice(0, 1000),
    };
}

module.exports = { collectPmeCertificateAfterIapmeiLogin };
