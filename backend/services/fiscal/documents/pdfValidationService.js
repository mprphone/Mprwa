'use strict';

const { cleanText, currentFiscalYear } = require('../shared/textHelpers');

function hasYearSpecificNoDocument(rawText, year, noDocumentPatterns = []) {
    const text = cleanText(rawText);
    const targetYear = String(year || currentFiscalYear());
    const explicitYearNoDocument = new RegExp(`(?:ano|exerc[ií]cio)\\s+(?:de\\s+)?${targetYear}.{0,260}(?:n[aã]o\\s+h[áa]\\s+comprovativo|n[aã]o\\s+possui\\s+declara[cç][oõ]es|n[aã]o\\s+existem\\s+declara[cç][oõ]es)`, 'i');
    if (explicitYearNoDocument.test(text)) return true;
    const aroundYear = new RegExp(`(.{0,80}${targetYear}.{0,180})`, 'i');
    const chunk = text.match(aroundYear)?.[1] || '';
    return Boolean(chunk && noDocumentPatterns.some((pattern) => pattern.test(chunk)));
}

function extractAnnualDocumentStatusFromText(rawText, year, noDocumentPatterns = []) {
    const text = cleanText(rawText);
    const targetYear = String(year || currentFiscalYear());
    const aroundYear = new RegExp(`(.{0,160}${targetYear}.{0,260})`, 'i');
    const chunk = text.match(aroundYear)?.[1] || text;
    const noDocument = hasYearSpecificNoDocument(text, targetYear, noDocumentPatterns);
    const statusMatch = noDocument ? { 1: 'Sem declaração disponível' } : chunk.match(/\b(Entregue|Rececionad[ao]|Recebid[ao]|Validada?|Certa|Aceite|Submetida?|Liquidada?|Com\s+erros|Anulada?)\b/i);
    const dateMatch = chunk.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{4}-\d{1,2}-\d{1,2})\b/);
    return {
        ano: targetYear,
        situacao: statusMatch ? cleanText(statusMatch[1]) : '',
        dataRecepcao: dateMatch ? require('../shared/textHelpers').normalizeDateToIso(dateMatch[1]) : '',
    };
}

function isWrongAnnualDocumentPage(rawText) {
    const text = cleanText(rawText);
    return /Download\s+Preparação\s+de\s+declarações|aplica[cç][aã]o\s+offline|IESv20\d{2}|Sistemas\s+Unix|Windows\s+\(32\s*Bits\)|Mac\s+OS/i.test(text);
}

function isAnnualComprovativoPage(rawText, year, noDocumentPatterns = []) {
    const text = cleanText(rawText);
    if (!text || isWrongAnnualDocumentPage(text)) return false;
    const targetYear = String(year || currentFiscalYear());
    const hasComprovativoContext = /Obter\s+Comprovativo|Comprovativos?\s+da\s+situa[cç][aã]o|Declara[cç][oõ]es\s+que\s+contribuem|comprovativo\s+dispon[ií]vel/i.test(text);
    const hasYearContext = new RegExp(`ano\\s+(?:de\\s+)?${targetYear}|exerc[ií]cio\\s+(?:de\\s+)?${targetYear}|\\b${targetYear}\\b`, 'i').test(text);
    const hasNoDocumentMessage = hasYearSpecificNoDocument(text, targetYear, noDocumentPatterns);
    return hasComprovativoContext && (hasYearContext || hasNoDocumentMessage);
}

function looksLikeCertidaoAtDocument(rawText) {
    const text = cleanText(rawText);
    if (!text) return false;
    if (/Portal\s+das\s+Finan[cç]as\s+-\s+Obter|Os\s+Seus\s+Servi[cç]os|Consultar\s+Certid[oõ]es|Pedir\s+Certid[aã]o/i.test(text)) return false;
    return /Certid[aã]o/i.test(text) &&
        (/D[ií]vida\s+e\s+N[aã]o\s+D[ií]vida|n[aã]o\s+d[ií]vida|situa[cç][aã]o\s+tribut[aá]ria|Autoridade\s+Tribut[aá]ria/i.test(text)) &&
        (/NIF|NIPC|n[uú]mero\s+de\s+identifica[cç][aã]o\s+fiscal|valid[ae]|emitid[ao]|certifica/i.test(text));
}

function looksLikeCertidaoSsDocument(rawText) {
    const text = cleanText(rawText);
    if (!text) return false;
    if (/autentica[cç][aã]o\s+com\s+o\s+seu\s+utilizador|autenticar\s+com\s+utilizador|precisa\s+de\s+ajuda|declara[cç][aã]o\s+de\s+acessibilidade/i.test(text)) return false;
    return /Declara[cç][aã]o\s+de\s+situa[cç][aã]o\s+contributiva/i.test(text) &&
        (/regularizada|n[aã]o\s+existem\s+d[ií]vidas|situa[cç][aã]o\s+contributiva/i.test(text)) &&
        (/NISS|NIF|NIPC|N[ºo]\s*declara[cç][aã]o|validade|emitid[ao]/i.test(text));
}

function looksLikeDomicilioFiscalDocument(rawText) {
    const text = cleanText(rawText);
    if (!text) return false;
    if (/Portal\s+das\s+Finan[cç]as\s+-\s+Obter|Pedir\s+Certid[aã]o|Consultar\s+Certid[oõ]es/i.test(text)) return false;
    return /Domic[ií]lio\s+Fiscal/i.test(text) &&
        (/NIF|NIPC|morada|n[uú]mero\s+de\s+identifica[cç][aã]o\s+fiscal|valid[ae]|emitid[ao]/i.test(text));
}

function looksLikePmeCertificateDocument(rawText) {
    const text = cleanText(rawText);
    if (!text) return false;
    if (/Obter\s+certifica[cç][aã]o|Atualizar\s+ficha|Consultar\s+processo|Consultas\s+de\s+terceiros|Se\s+pretender\s+renovar/i.test(text)) return false;
    return /Certifica[cç][aã]o\s+PME|Certificado\s+PME|Situa[cç][aã]o\s+da\s+certifica[cç][aã]o|IAPMEI/i.test(text) &&
        (/certificad[ao]|certifica(?:-se)?|microempresa|micro|pequena\s+empresa|m[eé]dia\s+empresa|PME/i.test(text)) &&
        (/NIF|NIPC|Estatuto\s+Atribu[ií]do|Situa[cç][aã]o\s+Desde\s+At[eé]|v[aá]lid[ao]|data\s+de\s+emiss[aã]o|ano/i.test(text));
}

function looksLikeBancoPortugalDocument(rawText) {
    const text = cleanText(rawText);
    if (!text) return false;
    return /Banco\s+de\s+Portugal/i.test(text) &&
        (/NIF|NIPC|n[uú]mero\s+de\s+identifica[cç][aã]o\s+fiscal/i.test(text)) &&
        (/data\s+(?:de\s+)?consulta|responsabilidades|emitid[ao]|consultad[ao]/i.test(text));
}

module.exports = {
    hasYearSpecificNoDocument,
    extractAnnualDocumentStatusFromText,
    isWrongAnnualDocumentPage,
    isAnnualComprovativoPage,
    looksLikeCertidaoAtDocument,
    looksLikeCertidaoSsDocument,
    looksLikeDomicilioFiscalDocument,
    looksLikePmeCertificateDocument,
    looksLikeBancoPortugalDocument,
};
