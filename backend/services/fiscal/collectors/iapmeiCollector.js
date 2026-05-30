'use strict';

const { postLocalJson } = require('./httpPost');
const { applyPme } = require('../summary/documentosSummaryUpdater');

async function collectIapmeiJob(context) {
    const { customerId, port, log, updateSummary } = context;
    await log('info', 'A iniciar recolha IAPMEI/Certificado PME.');
    const result = await postLocalJson(
        port,
        `/api/customers/${encodeURIComponent(customerId)}/autologin/pme`,
        { headless: true, fiscalCollectionJob: 'pme' },
        180000
    );
    if (result.statusCode < 200 || result.statusCode >= 300 || result.payload?.success === false) {
        throw new Error(result.payload?.error || `IAPMEI respondeu HTTP ${result.statusCode}.`);
    }
    await log('info', result.payload?.message || 'IAPMEI concluído.');
    const fiscalCollection = result.payload?.fiscalCollection || null;
    if (fiscalCollection?.status !== 'completed' && fiscalCollection?.pageTextSample) {
        await log('warn', '[Diagnóstico] Texto da página PME no momento da recolha:', { pageTextSample: fiscalCollection.pageTextSample.slice(0, 600) });
    }
    if (fiscalCollection?.ficheiroPdf && typeof updateSummary === 'function') {
        await updateSummary((current) => applyPme(current, fiscalCollection));
        await log('info', 'Certificado PME atualizado no resumo fiscal.', { ficheiroPdf: fiscalCollection.ficheiroPdf });
    }
    return {
        status: fiscalCollection?.status === 'completed' ? 'completed' : 'needs_review',
        message: fiscalCollection?.message || 'Recolha IAPMEI executada. Confirmar certificado PME.',
        details: result.payload,
    };
}

module.exports = { collectIapmeiJob };
