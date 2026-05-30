'use strict';

const { currentFiscalYear } = require('../config/fiscalSummaryDefaults');

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function foldText(value) {
    return cleanText(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function onlyDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeDateToIso(value) {
    const text = cleanText(value);
    if (!text) return '';
    let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (match) return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
    match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
    if (match) {
        const yyyy = String(match[3]).length === 2 ? `20${match[3]}` : match[3];
        return `${yyyy}-${String(match[2]).padStart(2, '0')}-${String(match[1]).padStart(2, '0')}`;
    }
    return text;
}

function withTimeout(promise, timeoutMs, message = 'Tempo limite excedido.') {
    let timer = null;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), Math.max(1000, Number(timeoutMs) || 1000));
        }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
}

function recentFiscalYears(count = 3) {
    const start = Number(currentFiscalYear());
    return Array.from({ length: Math.max(1, Number(count) || 3) }, (_, i) => String(start - i));
}

function financasSearchUrl(query) {
    return `https://sitfiscal.portaldasfinancas.gov.pt/geral/search?appName=info&query=${encodeURIComponent(query)}`;
}

module.exports = {
    cleanText, foldText, onlyDigits, normalizeDateToIso,
    withTimeout, recentFiscalYears, financasSearchUrl,
    currentFiscalYear,
};
