'use strict';

const { updateAnnualFilings } = require('./fiscalSummaryUpdater');
const { currentFiscalYear } = require('../config/fiscalSummaryDefaults');

function applyModelo22Filing(current, fiscalCollection) {
    const targetYear = String(currentFiscalYear());
    const filings = Array.isArray(fiscalCollection.filings) && fiscalCollection.filings.length
        ? fiscalCollection.filings
        : fiscalCollection.filing ? [fiscalCollection.filing] : [];
    return updateAnnualFilings(current, 'modelo22', filings, targetYear);
}

module.exports = { applyModelo22Filing };
