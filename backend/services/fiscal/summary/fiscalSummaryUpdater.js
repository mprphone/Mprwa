'use strict';

function updateAnnualFilings(current, key, filings, targetYear) {
    const rows = Array.isArray(current[key]) ? [...current[key]] : [];
    filings.forEach((entry) => {
        if (!entry?.situacao && !entry?.dataRecepcao && !entry?.comprovativoPath) return;
        const filing = {
            ano: String(entry.ano || targetYear),
            situacao: String(entry.situacao || ''),
            dataRecepcao: String(entry.dataRecepcao || ''),
            comprovativoPath: entry.comprovativoPath || '',
        };
        const idx = rows.findIndex((row) => String(row?.ano || '') === filing.ano);
        if (idx >= 0) rows[idx] = { ...rows[idx], ...filing };
        else rows.unshift(filing);
    });
    rows.sort((a, b) => Number(b.ano || 0) - Number(a.ano || 0));
    return { ...current, [key]: rows.slice(0, 5) };
}

function updateCertidao(current, tipoLabel, entidade, fiscalCollection) {
    const rows = Array.isArray(current.certidoes) ? [...current.certidoes] : [];
    const next = {
        tipo: tipoLabel,
        dataValidade: String(fiscalCollection.dataValidade || ''),
        valida: Boolean(fiscalCollection.valida),
        ficheiroPdf: fiscalCollection.ficheiroPdf,
    };
    const idx = rows.findIndex((row) => String(row?.tipo || '').toLowerCase().includes(entidade.toLowerCase()));
    if (idx >= 0) rows[idx] = { ...rows[idx], ...next };
    else rows.push(next);

    const dividas = Array.isArray(current.dividas) ? [...current.dividas] : [];
    const dividaIdx = dividas.findIndex((row) => row?.entidade === entidade);
    const dividaNext = {
        entidade,
        montante: fiscalCollection.semDivida ? 0 : Number(current.dividas?.[dividaIdx]?.montante || 0),
        semDivida: Boolean(fiscalCollection.semDivida),
    };
    if (dividaIdx >= 0) dividas[dividaIdx] = { ...dividas[dividaIdx], ...dividaNext };
    else dividas.push(dividaNext);

    return { ...current, certidoes: rows, dividas };
}

function updateDocumento(current, tipo, nextFields) {
    const rows = Array.isArray(current.documentos) ? [...current.documentos] : [];
    const idx = rows.findIndex((row) => row?.tipo === tipo);
    if (idx >= 0) rows[idx] = { ...rows[idx], ...nextFields };
    else rows.push(nextFields);
    return { ...current, documentos: rows };
}

module.exports = { updateAnnualFilings, updateCertidao, updateDocumento };
