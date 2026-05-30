'use strict';

const { postLocalJson } = require('./httpPost');
const { applyBancoPortugal } = require('../summary/documentosSummaryUpdater');
const fs = require('fs/promises');
const path = require('path');

// Verificar se a extensão Chrome recolheu o PDF recentemente (nas últimas 24h)
async function findExtCollectedPdf(customer) {
    try {
        const year = String(new Date().getFullYear());
        const { buildFiscalDownloadPath } = require('../documents/documentNamingService');
        const pdfPath = buildFiscalDownloadPath(customer, year, 'bportugal', 'responsabilidades.pdf');
        const dir = path.dirname(pdfPath);
        const files = await fs.readdir(dir).catch(() => []);
        for (const f of files.filter((n) => n.endsWith('.ext_collected.json'))) {
            const markerPath = path.join(dir, f);
            const stat = await fs.stat(markerPath).catch(() => null);
            if (!stat || Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) continue;
            let marker = {};
            try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); } catch (_) { continue; }
            if (!marker?.ficheiroPdf) continue;
            const pdfStat = await fs.stat(marker.ficheiroPdf).catch(() => null);
            if (pdfStat) return marker.ficheiroPdf;
        }
    } catch (_) {}
    return null;
}

async function collectBancoPortugalJob(context) {
    const { customerId, port, log, updateSummary, customer } = context;
    await log('info', 'A iniciar recolha Banco de Portugal.');

    // Verificar se a extensão Chrome já recolheu o PDF recentemente
    if (customer) {
        const extPdf = await findExtCollectedPdf(customer);
        if (extPdf) {
            await log('info', 'PDF das Responsabilidades BP já recolhido pela extensão Chrome.');
            const fiscalCollection = {
                ficheiroPdf: extPdf, dataValidade: '', valida: true,
                status: 'completed', message: 'Responsabilidades BP recolhidas via extensão Chrome.',
            };
            if (typeof updateSummary === 'function') {
                await updateSummary((current) => applyBancoPortugal(current, fiscalCollection));
                await log('info', 'Responsabilidades Banco de Portugal atualizadas no resumo fiscal.', { ficheiroPdf: extPdf });
            }
            return { status: 'completed', message: fiscalCollection.message };
        }
    }

    const result = await postLocalJson(port, `/api/customers/${encodeURIComponent(customerId)}/autologin/bportugal`, { headless: true }, 180000);
    if (result.statusCode < 200 || result.statusCode >= 300 || result.payload?.success === false) {
        throw new Error(result.payload?.error || `Banco de Portugal respondeu HTTP ${result.statusCode}.`);
    }
    await log('info', result.payload?.message || 'Banco de Portugal concluído.');
    const fiscalCollection = result.payload?.fiscalCollection || null;
    if (fiscalCollection?.status !== 'completed' && fiscalCollection?.pageTextSample) {
        await log('warn', '[Diagnóstico] Texto da página BPortugal no momento da recolha:', { pageTextSample: fiscalCollection.pageTextSample.slice(0, 600) });
    }
    if (fiscalCollection?.ficheiroPdf && typeof updateSummary === 'function') {
        await updateSummary((current) => applyBancoPortugal(current, fiscalCollection));
        await log('info', 'Responsabilidades Banco de Portugal atualizadas no resumo fiscal.', { ficheiroPdf: fiscalCollection.ficheiroPdf });
    }
    return {
        status: fiscalCollection?.status === 'completed' ? 'completed' : 'needs_review',
        message: fiscalCollection?.message || 'Recolha Banco de Portugal executada. Confirmar ficheiro/valores.',
        details: result.payload,
    };
}

module.exports = { collectBancoPortugalJob };
