'use strict';

const { currentFiscalYear } = require('./fiscalSummaryDefaults');
const { recentFiscalYears } = require('../shared/textHelpers');

const JOB_LABELS = {
    ies: 'IES',
    modelo22: 'Modelo 22',
    certidao_at: 'Certidão AT',
    certidao_ss: 'Certidão Segurança Social',
    certidao_permanente: 'Certidão Permanente',
    pme: 'Certificado PME',
    bportugal: 'Responsabilidades Banco de Portugal',
    domicilio_fiscal: 'Domicílio Fiscal',
};

const VALID_JOBS = Object.keys(JOB_LABELS);

function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function addDays(date, days) {
    const next = new Date(date.getTime());
    next.setDate(next.getDate() + Number(days || 0));
    return next;
}

function addMonths(date, months) {
    const next = new Date(date.getTime());
    next.setMonth(next.getMonth() + Number(months || 0));
    return next;
}

function sameYear(value, year = new Date().getFullYear()) {
    const date = parseDate(value);
    return Boolean(date && date.getFullYear() === Number(year));
}

function sameMonth(value, reference = new Date()) {
    const date = parseDate(value);
    return Boolean(date && date.getFullYear() === reference.getFullYear() && date.getMonth() === reference.getMonth());
}

function findCertidao(data, labelPart) {
    const needle = String(labelPart || '').toLowerCase();
    return (Array.isArray(data.certidoes) ? data.certidoes : []).find((entry) => (
        String(entry?.tipo || '').toLowerCase().includes(needle)
    )) || null;
}

function findDocumento(data, tipo) {
    return (Array.isArray(data.documentos) ? data.documentos : []).find((entry) => entry?.tipo === tipo) || null;
}

// Melhoria #8: função partilhada (era duplicada em IES e Modelo 22)
function isFilingYearComplete(year, rows) {
    const row = (Array.isArray(rows) ? rows : []).find((r) => String(r?.ano || '') === String(year));
    if (!row) return false;
    return /certa|entregue|aceite|validad/i.test(String(row.situacao || '')) && Boolean(row.comprovativoPath);
}

function hasFilingForYear(rows, year) {
    return (Array.isArray(rows) ? rows : []).some((row) => {
        if (String(row?.ano || '') !== String(year)) return false;
        return Boolean(row?.situacao || row?.dataRecepcao || row?.comprovativoPath);
    });
}

function collectionMeta(data, job) {
    return data?.collections && typeof data.collections === 'object' ? (data.collections[job] || {}) : {};
}

function normalizeCustomerType(value) {
    const text = String(value || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim();
    if (text.includes('particular')) return 'particular';
    if (text.includes('independente')) return 'particular';
    if (text.includes('empresa')) return 'empresa';
    return '';
}

function assessFiscalCollectionNeed(job, data, options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const targetYear = String(options.targetYear || currentFiscalYear());
    const meta = collectionMeta(data, job);
    const customerType = normalizeCustomerType(options.customerType || options.customer?.type || '');
    const isParticular = customerType === 'particular';
    const isEmpresa = customerType === 'empresa';

    if (job === 'ies') {
        if (isParticular) return { shouldCollect: false, requiresConfirmation: false, reason: 'IES não se aplica a particulares.' };
        const allComplete = recentFiscalYears(3).every((y) => isFilingYearComplete(y, data.ies));
        if (allComplete) return { shouldCollect: false, requiresConfirmation: true, reason: 'IES dos últimos 3 anos está completo. Quer recolher novamente?' };
        return { shouldCollect: true, requiresConfirmation: false, reason: 'IES com anos em falta ou incompletos.' };
    }

    if (job === 'modelo22') {
        const label = isParticular ? 'IRS' : 'Modelo 22';
        const allComplete = recentFiscalYears(3).every((y) => isFilingYearComplete(y, data.modelo22));
        if (allComplete) return { shouldCollect: false, requiresConfirmation: true, reason: `${label} dos últimos 3 anos está completo. Quer recolher novamente?` };
        return { shouldCollect: true, requiresConfirmation: false, reason: `${label} com anos em falta ou incompletos.` };
    }

    if (job === 'certidao_at' || job === 'certidao_ss') {
        const cert = findCertidao(data, job === 'certidao_at' ? 'AT' : 'SS');
        const validUntil = parseDate(cert?.dataValidade);
        if (validUntil && validUntil > addDays(now, 30)) return { shouldCollect: false, requiresConfirmation: true, reason: `${JOB_LABELS[job]} válida por mais de 1 mês. Quer recolher novamente?` };
        return { shouldCollect: true, requiresConfirmation: false, reason: `${JOB_LABELS[job]} sem validade suficiente.` };
    }

    if (job === 'domicilio_fiscal') {
        if (isEmpresa) return { shouldCollect: false, requiresConfirmation: false, reason: 'Domicílio fiscal está configurado só para particulares.' };
        const last = parseDate(meta.completedAt || meta.startedAt || meta.requestedAt);
        if (last && last > addMonths(now, -6)) return { shouldCollect: false, requiresConfirmation: true, reason: 'Domicílio fiscal recolhido há menos de 6 meses. Quer recolher novamente?' };
        return { shouldCollect: true, requiresConfirmation: false, reason: 'Domicílio fiscal sem recolha recente.' };
    }

    if (job === 'pme') {
        const doc = findDocumento(data, 'pme');
        const last = meta.completedAt || meta.startedAt || meta.requestedAt || doc?.dataValidade;
        if (sameYear(last, now.getFullYear())) return { shouldCollect: false, requiresConfirmation: true, reason: 'Certificado PME já consta neste ano. Quer recolher novamente?' };
        return { shouldCollect: true, requiresConfirmation: false, reason: 'Certificado PME deste ano em falta.' };
    }

    if (job === 'bportugal') {
        const last = meta.completedAt || meta.startedAt || meta.requestedAt || findDocumento(data, 'bportugal')?.dataValidade;
        if (sameMonth(last, now)) return { shouldCollect: false, requiresConfirmation: true, reason: 'Responsabilidades Banco de Portugal já recolhidas este mês. Quer recolher novamente?' };
        return { shouldCollect: true, requiresConfirmation: false, reason: 'Responsabilidades Banco de Portugal por recolher este mês.' };
    }

    if (job === 'certidao_permanente') {
        const doc = findDocumento(data, 'certidao_permanente');
        const validUntil = parseDate(doc?.dataValidade);
        const hasPdf = Boolean(doc?.ficheiroPdf);
        if (validUntil && validUntil > addDays(now, 30)) {
            if (hasPdf) return { shouldCollect: false, requiresConfirmation: true, reason: 'Certidão Permanente válida e com PDF. Quer recolher novamente?' };
            return { shouldCollect: true, requiresConfirmation: false, reason: 'Certidão Permanente válida mas sem PDF — a recolher.' };
        }
        return { shouldCollect: true, requiresConfirmation: false, reason: 'Certidão Permanente sem validade suficiente.' };
    }

    return { shouldCollect: true, requiresConfirmation: false, reason: 'Recolha permitida.' };
}

module.exports = { JOB_LABELS, VALID_JOBS, assessFiscalCollectionNeed, normalizeCustomerType };
