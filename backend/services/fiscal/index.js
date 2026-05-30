'use strict';

const { collectPortalFinancasJob } = require('./collectors/portalFinancasCollector');
const { collectSegurancaSocialJob } = require('./collectors/segurancaSocialCollector');
const { collectBancoPortugalJob } = require('./collectors/bancoPortugalCollector');
const { collectIapmeiJob } = require('./collectors/iapmeiCollector');
const { collectCertidaoPermanenteJob } = require('./collectors/certidaoPermanenteCollector');

async function runFiscalCollector(context) {
    const job = String(context?.job || '');
    if (['ies', 'modelo22', 'certidao_at', 'domicilio_fiscal'].includes(job)) {
        return collectPortalFinancasJob(context);
    }
    if (job === 'certidao_ss') return collectSegurancaSocialJob(context);
    if (job === 'bportugal') return collectBancoPortugalJob(context);
    if (job === 'pme') return collectIapmeiJob(context);
    if (job === 'certidao_permanente') return collectCertidaoPermanenteJob(context);
    throw new Error(`Recolha fiscal desconhecida: ${job}`);
}

module.exports = { runFiscalCollector };
