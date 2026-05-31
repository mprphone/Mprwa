'use strict';

const { postLocalJson } = require('./httpPost');
const { currentFiscalYear } = require('../config/fiscalSummaryDefaults');
const { normalizeCustomerType } = require('../config/fiscalCollectionPolicy');
const { recentFiscalYears } = require('../shared/textHelpers');
const { applyIesFiling } = require('../summary/iesSummaryUpdater');
const { applyModelo22Filing } = require('../summary/modelo22SummaryUpdater');
const { applyCertidaoAt } = require('../summary/certidoesSummaryUpdater');
const { applyDomicilioFiscal } = require('../summary/documentosSummaryUpdater');

const JOB_TARGETS = {
    ies: 'ies',
    modelo22: 'modelo22',
    certidao_at: 'certidao_at',
    domicilio_fiscal: 'domicilio_fiscal',
};

// Um ano está completo se tem estado Certa/Entregue E comprovativo PDF
function isFilingComplete(rows, year) {
    const row = (Array.isArray(rows) ? rows : []).find((r) => String(r?.ano || '') === String(year));
    if (!row) return false;
    const isCerta = /certa|entregue|aceite|validad/i.test(String(row.situacao || ''));
    return isCerta && Boolean(row.comprovativoPath);
}

async function collectPortalFinancasJob(context) {
    const { customerId, job, port, log, updateSummary, summaryData } = context;
    const customerType = normalizeCustomerType(context.customer?.type);
    const target = job === 'modelo22' && customerType === 'particular' ? 'irs' : (JOB_TARGETS[job] || job);
    const targetYear = String(currentFiscalYear());
    const allRecentYears = recentFiscalYears(3);

    // Para IES e Modelo 22: só recolher anos em falta (sem Certa + PDF)
    let targetYears;
    if (job === 'ies' || job === 'modelo22') {
        const filingRows = summaryData?.[job === 'ies' ? 'ies' : 'modelo22'];
        const today = new Date();
        // Antes de 15 de Abril: o ano fiscal mais recente (index 0) ainda não foi entregue — ignorar se vazio
        const isBeforeApril15 = today.getMonth() < 3 || (today.getMonth() === 3 && today.getDate() < 15);

        // Ano de início de actividade — não faz sentido pedir IES/M22 de anos anteriores
        const inicioRaw = String(context.customer?.inicioAtividade || '').trim();
        const inicioYear = inicioRaw
            ? Number(inicioRaw.match(/\b(\d{4})\b/)?.[1] || 0)
            : 0;

        const missingYears = allRecentYears.filter((y, index) => {
            // Ignorar anos anteriores ao início de actividade
            if (inicioYear > 0 && Number(y) < inicioYear) return false;

            if (isBeforeApril15 && index === 0) {
                // Antes de 15/Abr: o ano mais recente vazio é esperado, não recolher
                const row = (Array.isArray(filingRows) ? filingRows : []).find((r) => String(r?.ano || '') === String(y));
                const isEmpty = !row || (!row.situacao && !row.dataRecepcao && !row.comprovativoPath);
                const isSemDecl = /sem\s+declara/i.test(String(row?.situacao || ''));
                if (isEmpty || isSemDecl) return false;
            }
            return !isFilingComplete(filingRows, y);
        });

        if (missingYears.length === 0) {
            await log('info', `${job.toUpperCase()} dos últimos 3 anos já está completo (Certa + PDF). Recolha ignorada.`);
            return { status: 'skipped', message: `${job.toUpperCase()} dos últimos 3 anos já está completo.` };
        }
        targetYears = missingYears;
        await log('info', `A iniciar recolha AT: ${target}. Anos em falta: ${missingYears.join(', ')}.`);
    } else {
        targetYears = [targetYear];
        await log('info', `A iniciar recolha AT: ${target}.`);
    }
    const result = await postLocalJson(
        port,
        `/api/customers/${encodeURIComponent(customerId)}/autologin/financas`,
        { headless: true, closeAfterSubmit: true, fiscalCollectionJob: target, fiscalCollectionYear: targetYear, fiscalCollectionYears: targetYears },
        300000
    );
    // Bug #1: statusCode pode ser undefined em caso de timeout/falha de rede
    const statusCode = result.statusCode;
    if (!statusCode || statusCode < 200 || statusCode >= 300 || result.payload?.success === false) {
        throw new Error(result.payload?.error || `Autologin AT respondeu HTTP ${statusCode ?? 'sem resposta'}.`);
    }
    await log('info', result.payload?.message || 'Autologin AT concluído.');
    const fiscalCollection = result.payload?.fiscalCollection || null;
    if (fiscalCollection?.status !== 'completed' && fiscalCollection?.pageTextSample) {
        await log('warn', '[Diagnóstico] Texto da página AT no momento da recolha:', {
            pageUrl: fiscalCollection.pageUrl || '',
            // Bug #5: null check antes de slice
            pageTextSample: String(fiscalCollection.pageTextSample || '').slice(0, 600),
        });
    }
    if (fiscalCollection?.status !== 'completed' && fiscalCollection?.diagLinks?.length) {
        await log('warn', '[Diagnóstico] Links certidão encontrados na página AT:', { diagLinks: fiscalCollection.diagLinks });
    }
    if ((job === 'ies' || job === 'modelo22') && fiscalCollection?.status === 'completed' && typeof updateSummary === 'function') {
        const applyFn = job === 'ies' ? applyIesFiling : applyModelo22Filing;
        await updateSummary((current) => applyFn(current, fiscalCollection));
        const filingCount = (fiscalCollection.filings?.length || 0) || (fiscalCollection.filing ? 1 : 0);
        await log('info', `Resumo ${job === 'ies' ? 'IES' : target === 'irs' ? 'IRS' : 'Modelo 22'} atualizado para ${filingCount} exercício(s).`);
    }
    if (job === 'certidao_at' && fiscalCollection?.ficheiroPdf && typeof updateSummary === 'function') {
        await updateSummary((current) => applyCertidaoAt(current, fiscalCollection));
        await log('info', 'Certidão AT atualizada no resumo fiscal.', { ficheiroPdf: fiscalCollection.ficheiroPdf });
    }
    if (job === 'domicilio_fiscal' && fiscalCollection?.status === 'completed' && typeof updateSummary === 'function') {
        await updateSummary((current) => applyDomicilioFiscal(current, fiscalCollection));
        await log('info', 'Domicílio Fiscal atualizado no resumo fiscal.');
    }
    if (fiscalCollection) {
        return { status: fiscalCollection.status === 'completed' ? 'completed' : 'needs_review', message: fiscalCollection.message || 'Recolha AT executada.', details: result.payload };
    }
    return { status: 'needs_review', message: 'Acesso AT executado. Extração específica fica pendente de validação nesta recolha.', details: result.payload };
}

module.exports = { collectPortalFinancasJob };
