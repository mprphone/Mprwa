'use strict';

const { postLocalJson } = require('./httpPost');
const { applyCertidaoSs } = require('../summary/certidoesSummaryUpdater');

async function collectSegurancaSocialJob(context) {
    const { customerId, port, log, updateSummary } = context;
    await log('info', 'A iniciar recolha Segurança Social.');
    const result = await postLocalJson(
        port,
        `/api/customers/${encodeURIComponent(customerId)}/autologin/seg-social`,
        { headless: true, closeAfterSubmit: true, fiscalCollectionJob: 'certidao_ss' },
        180000
    );
    if (result.statusCode < 200 || result.statusCode >= 300 || result.payload?.success === false) {
        throw new Error(result.payload?.error || `Autologin SS respondeu HTTP ${result.statusCode}.`);
    }
    await log('info', result.payload?.message || 'Autologin SS concluído.');
    const fiscalCollection = result.payload?.fiscalCollection || null;
    if (fiscalCollection?.status !== 'completed' && fiscalCollection?.pageTextSample) {
        await log('warn', '[Diagnóstico] Texto da página SS no momento da recolha:', { pageTextSample: fiscalCollection.pageTextSample.slice(0, 600) });
    }
    if (fiscalCollection?.ficheiroPdf && typeof updateSummary === 'function') {
        await updateSummary((current) => applyCertidaoSs(current, fiscalCollection));
        await log('info', 'Certidão SS atualizada no resumo fiscal.', { ficheiroPdf: fiscalCollection.ficheiroPdf });
    }
    return {
        status: fiscalCollection?.status === 'completed' ? 'completed' : 'needs_review',
        message: fiscalCollection?.message || 'Acesso Segurança Social executado. Extração da certidão fica pendente de validação.',
        details: result.payload,
    };
}

module.exports = { collectSegurancaSocialJob };
