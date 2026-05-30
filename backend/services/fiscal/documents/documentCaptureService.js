'use strict';

const { cleanText } = require('../shared/textHelpers');
const { isPdfPortalResponse, saveFiscalDownload, saveFiscalPdfResponse, saveDownloadFromPopup, saveFiscalPagePdf } = require('./fileStorageService');
const { buildFiscalDownloadPath, uniquePath } = require('./documentNamingService');

async function tryDownloadIesComprovativo(page, customer, year, documentType = 'documento') {
    const candidateIndexes = await page.evaluate(() => {
        const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        return Array.from(document.querySelectorAll('a,button,input[type="button"],input[type="submit"]'))
            .map((element, index) => {
                const text = fold(element.innerText || element.textContent || element.value || element.getAttribute('title') || element.getAttribute('aria-label') || '');
                const href = fold(element.getAttribute('href') || '');
                const title = fold(element.getAttribute('title') || '');
                const navLike = /^(downloads?|menu)$|todos os servicos|entregar declaracao|consultar declaracao|download servicos|servicos relacionados/.test(text);
                const looksLikeDownload = /pdf|imprimir|descarregar|guardar|obter comprovativo|comprovativo/.test(`${text} ${href} ${title}`);
                return { index, text, href, title, visible: isVisible(element), navLike, looksLikeDownload };
            })
            .filter((item) => item.visible && item.looksLikeDownload && !item.navLike && item.text.length <= 90)
            .slice(0, 2).map((item) => item.index);
    }).catch(() => []);
    console.error('[FiscalAT Download]', documentType, year, 'candidates', candidateIndexes.length);
    for (const index of candidateIndexes) {
        const locator = page.locator('a,button,input[type="button"],input[type="submit"]').nth(index);
        if ((await locator.count()) <= 0 || !(await locator.isVisible().catch(() => false))) continue;
        const beforeUrl = page.url();
        try {
            const downloadPromise = page.waitForEvent('download', { timeout: 1500 });
            await locator.click({ timeout: 3000 });
            const download = await downloadPromise;
            return await saveFiscalDownload(download, customer, year, documentType);
        } catch (_) {
            await page.waitForLoadState('domcontentloaded', { timeout: 1200 }).catch(() => null);
            if (page.url() !== beforeUrl) {
                await page.goBack({ waitUntil: 'domcontentloaded', timeout: 3000 }).catch(() => null);
            }
        }
    }
    return '';
}

async function clickTextAndCaptureDocument(page, patterns, customer, year, documentType, evidenceFn, timeoutMs = 12000) {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    const matcherSpecs = list.map((pattern) => (
        pattern instanceof RegExp
            ? { type: 'regex', source: pattern.source, flags: pattern.flags }
            : { type: 'text', value: String(pattern || '') }
    ));
    const clickedHandle = await page.evaluateHandle((rawPatterns) => {
        const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const matchers = rawPatterns.map((item) => {
            if (item?.type === 'regex') {
                try { return { type: 'regex', regex: new RegExp(item.source, item.flags || 'i') }; } catch (_) { return null; }
            }
            return { type: 'text', value: fold(item?.value || '') };
        }).filter(Boolean);
        const isVisible = (element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const candidates = Array.from(document.querySelectorAll('a,button,input[type="button"],input[type="submit"],[role="button"],[onclick]'));
        for (const element of candidates) {
            if (!isVisible(element)) continue;
            const rawText = String(element.innerText || element.textContent || element.value || element.getAttribute('title') || element.getAttribute('aria-label') || '');
            const text = fold(rawText);
            if (!text) continue;
            if (matchers.some((matcher) => (
                matcher.type === 'regex' ? matcher.regex.test(rawText) || matcher.regex.test(text) : matcher.value && text.includes(matcher.value)
            ))) { return element; }
        }
        return null;
    }, matcherSpecs);
    const element = clickedHandle.asElement();
    if (!element) return '';
    const downloadPromise = page.waitForEvent('download', { timeout: timeoutMs }).then((download) => ({ type: 'download', download })).catch(() => null);
    const popupPromise = page.waitForEvent('popup', { timeout: timeoutMs }).then((popup) => ({ type: 'popup', popup })).catch(() => null);
    const pdfResponsePromise = page.waitForResponse((response) => isPdfPortalResponse(response), { timeout: timeoutMs }).then((response) => ({ type: 'pdf-response', response })).catch(() => null);
    await element.click({ timeout: Math.min(5000, timeoutMs) }).catch(async () => {
        await element.evaluate((node) => node.click()).catch(() => null);
    });
    const first = await Promise.race([downloadPromise, popupPromise, pdfResponsePromise, new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
    if (first?.type === 'download' && first.download) return saveFiscalDownload(first.download, customer, year, documentType);
    if (first?.type === 'pdf-response' && first.response) return saveFiscalPdfResponse(first.response, customer, year, documentType);
    const popup = first?.type === 'popup' ? first.popup : null;
    if (popup) {
        const popupPdfResponsePromise = popup.waitForResponse((response) => isPdfPortalResponse(response), { timeout: Math.min(6000, timeoutMs) })
            .then((response) => saveFiscalPdfResponse(response, customer, year, documentType)).catch(() => '');
        const popupDownloadPath = await Promise.race([
            saveDownloadFromPopup(popup, customer, year, documentType, Math.min(6000, timeoutMs)).catch(() => ''),
            popupPdfResponsePromise,
        ]).catch(() => '');
        if (popupDownloadPath) { await popup.close().catch(() => null); return popupDownloadPath; }
        await popup.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => null);
        await popup.waitForTimeout(1000).catch(() => null);
        const popupText = cleanText(await popup.locator('body').innerText({ timeout: 5000 }).catch(() => ''));
        if (typeof evidenceFn === 'function' && evidenceFn(popupText)) {
            const popupPdfPath = await saveFiscalPagePdf(popup, customer, year, documentType).catch(() => '');
            await popup.close().catch(() => null);
            return popupPdfPath;
        }
        await popup.close().catch(() => null);
        return '';
    }
    await page.waitForTimeout(1000);
    return '';
}

module.exports = { tryDownloadIesComprovativo, clickTextAndCaptureDocument };
