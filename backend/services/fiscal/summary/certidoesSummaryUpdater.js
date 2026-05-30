'use strict';

const { updateCertidao } = require('./fiscalSummaryUpdater');

function applyCertidaoAt(current, fiscalCollection) {
    return updateCertidao(current, 'Certidão Dívida AT', 'at', fiscalCollection);
}

function applyCertidaoSs(current, fiscalCollection) {
    return updateCertidao(current, 'Certidão Dívida SS', 'ss', fiscalCollection);
}

module.exports = { applyCertidaoAt, applyCertidaoSs };
