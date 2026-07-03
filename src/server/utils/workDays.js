'use strict';

// Determina se uma data é dia de trabalho a partir do campo livre `dias_trabalho`.
// Aceita vários formatos usados na app:
//   - vazio                    → Segunda a Sexta (default)
//   - CSV numérico "1,2,3,4,5" → 0=dom..6=sab (também aceita 1=seg..7=dom)
//   - intervalo "Segunda a Sexta" / "Segunda-feira a Sexta-feira"
//   - lista de nomes "Segunda, Quarta, Sexta"

const DAY_NAMES = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

function stripAccents(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isWorkDay(diasTrabalho, date = new Date()) {
    const dow = date.getDay(); // 0=dom..6=sab
    const raw = stripAccents(diasTrabalho).trim().toLowerCase();
    if (!raw) return dow >= 1 && dow <= 5;

    if (/^[0-7,\s]+$/.test(raw)) {
        const nums = raw.split(/[,\s]+/).map(Number).filter((n) => !Number.isNaN(n));
        return nums.includes(dow) || nums.includes(dow === 0 ? 7 : dow);
    }

    // Dias mencionados pelo nome completo (ordem crescente 0..6).
    const mentioned = [];
    DAY_NAMES.forEach((name, idx) => { if (raw.includes(name)) mentioned.push(idx); });
    if (mentioned.length === 0) return dow >= 1 && dow <= 5;

    const looksLikeRange = /(^|\W)(a|ate)(\W|$)/.test(raw) || raw.includes('-');
    if (looksLikeRange && mentioned.length >= 2) {
        const start = mentioned[0];
        const end = mentioned[mentioned.length - 1];
        let i = start;
        for (let k = 0; k < 7; k += 1) {
            if (i === dow) return true;
            if (i === end) break;
            i = (i + 1) % 7;
        }
        return false;
    }

    return mentioned.includes(dow);
}

module.exports = { isWorkDay };
