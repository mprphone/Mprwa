'use strict';

const fs = require('fs');
const { buildFiscalDownloadPath, fileNameFromContentDisposition, uniquePath } = require('./documentNamingService');

function isPdfPortalResponse(response) {
    try {
        const headers = response.headers ? response.headers() : {};
        const contentType = String(headers['content-type'] || '').toLowerCase();
        const url = String(response.url ? response.url() : '').toLowerCase();
        return contentType.includes('application/pdf') || /\.pdf(?:[?#]|$)/i.test(url);
    } catch (_) { return false; }
}

async function saveFiscalDownload(download, customer, year, documentType = 'documento') {
    const suggested = await download.suggestedFilename().catch(() => '');
    const targetPath = uniquePath(buildFiscalDownloadPath(customer, year, documentType, suggested));
    await download.saveAs(targetPath);
    return targetPath;
}

async function saveFiscalPdfResponse(response, customer, year, documentType = 'documento') {
    if (!response) return '';
    const headers = response.headers ? response.headers() : {};
    const contentType = String(headers['content-type'] || '').toLowerCase();
    const buffer = await response.body().catch(() => null);
    if (!buffer || buffer.length < 20) return '';
    if (!contentType.includes('application/pdf') && !buffer.slice(0, 4).equals(Buffer.from('%PDF'))) return '';
    const suggested = fileNameFromContentDisposition(headers['content-disposition']) || 'documento.pdf';
    const targetPath = uniquePath(buildFiscalDownloadPath(customer, year, documentType, suggested));
    await fs.promises.writeFile(targetPath, buffer);
    return targetPath;
}

async function saveDownloadFromPopup(popup, customer, year, documentType = 'documento', timeoutMs = 12000) {
    if (!popup) return '';
    const download = await popup.waitForEvent('download', { timeout: timeoutMs }).catch(() => null);
    if (download) return saveFiscalDownload(download, customer, year, documentType);
    return '';
}

async function saveFiscalPagePdf(page, customer, year, documentType = 'documento') {
    const targetPath = uniquePath(buildFiscalDownloadPath(customer, year, documentType, 'pagina.pdf'));
    if (typeof page.pdf !== 'function') return '';
    await page.pdf({ path: targetPath, format: 'A4', printBackground: true });
    return targetPath;
}

module.exports = {
    isPdfPortalResponse,
    saveFiscalDownload,
    saveFiscalPdfResponse,
    saveDownloadFromPopup,
    saveFiscalPagePdf,
};
