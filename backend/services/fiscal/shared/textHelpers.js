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

const PT_MONTHS = {
    janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
    julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

// Finds the date the certidão/declaração was actually issued, by reading it out of the
// document text — collection runs happen days/weeks after issuance, so "today" is not a
// valid stand-in for the issue date when computing validity windows.
function extractCertidaoIssueDate(text) {
    const cleaned = foldText(text);
    if (!cleaned) return '';

    const textualPatterns = [
        /emite[- ]se\s+a\s+presente\s+certidao\s+(?:em\s+)?(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/,
        /emitida?\s+(?:em|a)\s+(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/,
        /(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/,
    ];
    for (const pattern of textualPatterns) {
        const match = cleaned.match(pattern);
        if (match) {
            const day = Number(match[1]);
            const month = PT_MONTHS[match[2]];
            const year = Number(match[3]);
            if (month && day >= 1 && day <= 31) {
                return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            }
        }
    }

    const numericPatterns = [
        /data\s+de\s+emissao[:\s]+(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/,
        /emitida?\s+(?:em|a)\s+(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/,
    ];
    for (const pattern of numericPatterns) {
        const match = cleaned.match(pattern);
        if (match) {
            const day = Number(match[1]);
            const month = Number(match[2]);
            const yyyy = match[3].length === 2 ? `20${match[3]}` : match[3];
            if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                return `${yyyy}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            }
        }
    }

    return '';
}

function addMonthsToIsoDate(isoDate, months) {
    const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return '';
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    date.setUTCMonth(date.getUTCMonth() + months);
    return date.toISOString().slice(0, 10);
}

// Validity = issue date (parsed from the document) + months, falling back to "today" only
// when the issue date can't be found in the text (e.g. unexpected layout change).
function certidaoValidUntil(text, months) {
    const issueDate = extractCertidaoIssueDate(text);
    if (issueDate) return addMonthsToIsoDate(issueDate, months);
    const fallback = new Date();
    fallback.setMonth(fallback.getMonth() + months);
    return fallback.toISOString().slice(0, 10);
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
    extractCertidaoIssueDate, addMonthsToIsoDate, certidaoValidUntil,
    withTimeout, recentFiscalYears, financasSearchUrl,
    currentFiscalYear,
};
