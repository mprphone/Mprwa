'use strict';

const {
    hasYearSpecificNoDocument,
    extractAnnualDocumentStatusFromText,
    isWrongAnnualDocumentPage,
    isAnnualComprovativoPage,
} = require('./pdfValidationService');

module.exports = {
    hasYearSpecificNoDocument,
    extractAnnualDocumentStatusFromText,
    isWrongAnnualDocumentPage,
    isAnnualComprovativoPage,
};
