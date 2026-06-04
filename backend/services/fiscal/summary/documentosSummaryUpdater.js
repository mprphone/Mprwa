'use strict';

const { updateDocumento } = require('./fiscalSummaryUpdater');

function applyDomicilioFiscal(current, fiscalCollection) {
    return updateDocumento(current, 'domicilio_fiscal', {
        tipo: 'domicilio_fiscal',
        label: 'Domicílio Fiscal',
        valida: Boolean(fiscalCollection.valida),
        ficheiroPdf: fiscalCollection.ficheiroPdf || '',
        notas: fiscalCollection.morada || fiscalCollection.notas || '',
    });
}

function applyBancoPortugal(current, fiscalCollection) {
    return updateDocumento(current, 'bportugal', {
        tipo: 'bportugal',
        label: 'Responsabilidades Banco de Portugal',
        dataValidade: fiscalCollection.dataValidade || '',
        valida: true,
        ficheiroPdf: fiscalCollection.ficheiroPdf,
        notas: fiscalCollection.notas || '',
    });
}

function applyPme(current, fiscalCollection) {
    return updateDocumento(current, 'pme', {
        tipo: 'pme',
        label: 'Certificado PME',
        dataValidade: fiscalCollection.dataValidade || '',
        valida: true,
        ficheiroPdf: fiscalCollection.ficheiroPdf,
        notas: fiscalCollection.notas || fiscalCollection.dataEfeito || '',
    });
}

function applyCertidaoPermanente(current, code, result) {
    const validUntil = result?.fields?.certidaoPermanenteValidade || result?.fields?.validade || result?.fields?.dataValidade || '';
    // Actualizar sempre que haja código, mesmo sem data de validade
    if (!code && !validUntil && !result?.ficheiroPdf) return current;
    return updateDocumento(current, 'certidao_permanente', {
        tipo: 'certidao_permanente',
        label: 'Certidão Permanente',
        codigo: code,
        dataValidade: validUntil,
        valida: !!validUntil,
        ficheiroPdf: result?.ficheiroPdf || '',
        detalhes: result?.fields || {},
    });
}

function applyCartaoEletronico(current, code, result) {
    return updateDocumento(current, 'cartao_eletronico', {
        tipo: 'cartao_eletronico',
        label: 'Cartão Eletrónico da Empresa',
        codigo: code,
        dataValidade: result?.fields?.dataRegisto || '',
        valida: true,
        ficheiroPdf: result?.ficheiroPdf || '',
        detalhes: result?.fields || {},
    });
}

module.exports = { applyDomicilioFiscal, applyBancoPortugal, applyPme, applyCertidaoPermanente, applyCartaoEletronico };
