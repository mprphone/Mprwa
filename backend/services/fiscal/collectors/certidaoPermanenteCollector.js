'use strict';

const { collectCertidaoPermanenteProfile } = require('../../certidaoPermanenteService');
const { applyCertidaoPermanente } = require('../summary/documentosSummaryUpdater');

function findCertidaoPermanente(data) {
    return (Array.isArray(data.documentos) ? data.documentos : []).find((doc) => doc?.tipo === 'certidao_permanente') || null;
}

async function collectCertidaoPermanenteJob(context) {
    const { summaryData, customer, log, updateSummary, customerId } = context;
    const doc = findCertidaoPermanente(summaryData);

    // Tentar obter o código de múltiplas fontes por ordem de fiabilidade
    const code = String(
        doc?.codigo
        || customer?.certidaoPermanenteNumero
        || customer?.profile?.certidaoPermanenteNumero
        || doc?.notas
        || ''
    ).trim();

    if (!code) {
        await log('warn', `Sem código da Certidão Permanente. doc.codigo="${doc?.codigo}" customer.cp="${customer?.certidaoPermanenteNumero}"`);
        return { status: 'skipped', message: 'Sem código da Certidão Permanente. Preencha o campo Código no documento.' };
    }
    await log('info', `A consultar Certidão Permanente com código ${code}.`);
    const result = await collectCertidaoPermanenteProfile(code, { headless: true, customer });
    const validUntil = result?.fields?.certidaoPermanenteValidade || result?.fields?.validade || result?.fields?.dataValidade || '';
    if (validUntil && typeof updateSummary === 'function') {
        await updateSummary((current) => applyCertidaoPermanente(current, code, result));
    }
    return {
        status: validUntil ? 'completed' : 'needs_review',
        message: validUntil ? `Certidão Permanente válida até ${validUntil}.` : 'Certidão consultada, mas validade não foi detetada.',
        details: result,
    };
}

module.exports = { collectCertidaoPermanenteJob };
