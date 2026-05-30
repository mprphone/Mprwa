'use strict';

const { FISCAL_STATUS } = require('./fiscalStatus');

/**
 * Builds a standardized fiscal collection response.
 *
 * Rules:
 *  - status = 'completed' ONLY when filePath is set AND validated = true
 *  - Any call with filePath but validated = false → status = 'needs_review'
 */
function buildFiscalResponse({ status, filePath, validated, type, year, message, diagnostics, raw } = {}) {
    const hasFile = Boolean(filePath && String(filePath).trim());
    const isValidated = hasFile && validated === true;
    const resolvedStatus = hasFile && !isValidated ? FISCAL_STATUS.NEEDS_REVIEW : (status || FISCAL_STATUS.FAILED);
    const finalStatus = (resolvedStatus === FISCAL_STATUS.COMPLETED && !isValidated)
        ? FISCAL_STATUS.NEEDS_REVIEW
        : resolvedStatus;

    return {
        status: finalStatus,
        document: {
            filePath: hasFile ? String(filePath).trim() : '',
            validated: isValidated,
            type: String(type || '').trim(),
            year: String(year || '').trim(),
        },
        message: String(message || '').trim(),
        diagnostics: diagnostics && typeof diagnostics === 'object' ? diagnostics : undefined,
        ...(raw && typeof raw === 'object' ? { raw } : {}),
    };
}

function completedResponse({ filePath, type, year, message, raw } = {}) {
    return buildFiscalResponse({
        status: FISCAL_STATUS.COMPLETED,
        filePath,
        validated: true,
        type,
        year,
        message: message || 'Documento recolhido e validado com sucesso.',
        raw,
    });
}

function needsReviewResponse({ filePath, type, year, message, diagnostics, raw } = {}) {
    return buildFiscalResponse({
        status: FISCAL_STATUS.NEEDS_REVIEW,
        filePath: filePath || '',
        validated: false,
        type,
        year,
        message: message || 'Recolha necessita de revisão manual.',
        diagnostics,
        raw,
    });
}

function loginFailedResponse({ message, diagnostics } = {}) {
    return buildFiscalResponse({
        status: FISCAL_STATUS.LOGIN_FAILED,
        message: message || 'Falha no login ao portal.',
        diagnostics,
    });
}

function notAvailableResponse({ message } = {}) {
    return buildFiscalResponse({
        status: FISCAL_STATUS.NOT_AVAILABLE,
        message: message || 'Documento não disponível neste portal.',
    });
}

function failedResponse({ message, diagnostics } = {}) {
    return buildFiscalResponse({
        status: FISCAL_STATUS.FAILED,
        message: message || 'Falha durante a recolha.',
        diagnostics,
    });
}

module.exports = {
    buildFiscalResponse,
    completedResponse,
    needsReviewResponse,
    loginFailedResponse,
    notAvailableResponse,
    failedResponse,
};
