'use strict';

function currentFiscalYear() {
    return String(new Date().getFullYear() - 1);
}

function defaultFiscalSummaryData() {
    const year = currentFiscalYear();
    return {
        ies: [
            { ano: year, situacao: '', dataRecepcao: '' },
            { ano: String(Number(year) - 1), situacao: '', dataRecepcao: '' },
            { ano: String(Number(year) - 2), situacao: '', dataRecepcao: '' },
        ],
        modelo22: [
            { ano: year, situacao: '', dataRecepcao: '' },
            { ano: String(Number(year) - 1), situacao: '', dataRecepcao: '' },
            { ano: String(Number(year) - 2), situacao: '', dataRecepcao: '' },
        ],
        certidoes: [
            { tipo: 'Certidão Dívida AT', dataValidade: '', valida: false },
            { tipo: 'Certidão Dívida SS', dataValidade: '', valida: false },
        ],
        documentos: [
            { tipo: 'domicilio_fiscal', label: 'Domicílio Fiscal', valida: false },
            { tipo: 'certidao_permanente', label: 'Certidão Permanente', codigo: '', dataValidade: '', valida: false },
            { tipo: 'pacto_social', label: 'Pacto Social', dataValidade: '', valida: false },
            { tipo: 'inicio_atividade', label: 'Início de Atividade', dataValidade: '', valida: false },
            { tipo: 'rcbe', label: 'RCBE', dataValidade: '', valida: false },
            { tipo: 'pme', label: 'Certificado PME', dataValidade: '', valida: false },
            { tipo: 'bportugal', label: 'Responsabilidades Banco de Portugal', dataValidade: '', valida: false },
            { tipo: 'rebe', label: 'REBE', dataValidade: '', valida: false },
        ],
        dividas: [
            { entidade: 'at', montante: 0, semDivida: false },
            { entidade: 'ss', montante: 0, semDivida: false },
        ],
        collections: {},
        updatedAt: '',
    };
}

function mergeArrayByKey(existing, defaults, key) {
    // Deduplicar o array existente primeiro (manter o último de cada tipo)
    const seen = new Map();
    for (const item of existing) {
        const k = item?.[key];
        if (k !== undefined && k !== null) seen.set(k, item);
    }
    const result = [...seen.values()];
    // Adicionar defaults que não existem
    for (const item of defaults) {
        if (!seen.has(item[key])) result.push({ ...item });
    }
    return result;
}

function mergeFiscalSummaryData(rawData) {
    const defaults = defaultFiscalSummaryData();
    const data = rawData && typeof rawData === 'object' ? rawData : {};
    return {
        ...defaults,
        ...data,
        ies: Array.isArray(data.ies) && data.ies.length ? data.ies : defaults.ies,
        modelo22: Array.isArray(data.modelo22) && data.modelo22.length ? data.modelo22 : defaults.modelo22,
        certidoes: Array.isArray(data.certidoes) && data.certidoes.length
            ? mergeArrayByKey(data.certidoes, defaults.certidoes, 'tipo')
            : defaults.certidoes,
        documentos: Array.isArray(data.documentos) && data.documentos.length
            ? mergeArrayByKey(data.documentos, defaults.documentos, 'tipo')
            : defaults.documentos,
        dividas: Array.isArray(data.dividas) && data.dividas.length
            ? mergeArrayByKey(data.dividas, defaults.dividas, 'entidade')
            : defaults.dividas,
        collections: data.collections && typeof data.collections === 'object' ? data.collections : {},
    };
}

module.exports = { currentFiscalYear, defaultFiscalSummaryData, mergeFiscalSummaryData };
