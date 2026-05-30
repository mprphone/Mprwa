'use strict';

const { updateAnnualFilings } = require('./fiscalSummaryUpdater');
const { currentFiscalYear } = require('../config/fiscalSummaryDefaults');

function applyIesFiling(current, fiscalCollection) {
    const targetYear = String(currentFiscalYear());
    const filings = Array.isArray(fiscalCollection.filings) && fiscalCollection.filings.length
        ? fiscalCollection.filings
        : fiscalCollection.filing ? [fiscalCollection.filing] : [];
    return updateAnnualFilings(current, 'ies', filings, targetYear);
}

module.exports = { applyIesFiling };
