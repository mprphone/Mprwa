function normalizeDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function normalizeLookupText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function normalizeEstadoToken(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function normalizeBoolean(rawValue, fallback = true) {
    if (rawValue === undefined || rawValue === null || rawValue === '') return fallback;
    if (typeof rawValue === 'boolean') return rawValue;
    const normalized = String(rawValue).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on', 'sim'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off', 'nao', 'não'].includes(normalized)) return false;
    return fallback;
}

function classifyObrigacaoEstado(estado, estadoAt) {
    const joined = [normalizeEstadoToken(estado), normalizeEstadoToken(estadoAt)].filter(Boolean).join(' ');
    const hasToken = (tokens) => tokens.some((token) => joined.includes(token));

    const failureTokens = [
        'erro',
        'rejeitad',
        'recusad',
        'anulad',
        'invalid',
        'falha',
        'nao aceite',
        'incerta',
    ];
    if (hasToken(failureTokens)) {
        return { isSuccess: false, reason: 'error_or_rejected', normalized: joined };
    }

    const successTokens = [
        'processad',
        'cmp env',
        'cmpenv',
        'enviado',
        'aceite',
        'certa',
        'entregue',
        'submetid',
        'validad',
        'regularizad',
        'ok',
    ];
    if (hasToken(successTokens)) {
        return { isSuccess: true, reason: 'accepted', normalized: joined };
    }

    const pendingTokens = ['pendente', 'aguardar', 'analise', 'em tratamento', 'processamento'];
    if (hasToken(pendingTokens)) {
        return { isSuccess: false, reason: 'pending', normalized: joined };
    }

    return { isSuccess: false, reason: 'unknown', normalized: joined };
}

function classifyDriCmpEnvStatus(estado) {
    const token = normalizeEstadoToken(estado);
    const isCmpEnv = token.includes('cmp env') || token.includes('cmpenv');
    return {
        isSuccess: isCmpEnv,
        reason: isCmpEnv ? 'cmp_env' : 'not_cmp_env',
        normalized: token,
    };
}

function classifyDmrProcessadoCertaStatus(estado, estadoAt) {
    const estadoToken = normalizeEstadoToken(estado);
    const estadoAtToken = normalizeEstadoToken(estadoAt);
    const isProcessado = estadoToken.includes('processad');
    const isCerta = estadoAtToken.includes('certa');
    return {
        isSuccess: isProcessado && isCerta,
        reason: isProcessado && isCerta ? 'processado_certa' : 'not_processado_certa',
        normalized: `${estadoToken} | ${estadoAtToken}`.trim(),
    };
}

function classifySaftEnviadoStatus(estado) {
    const token = normalizeEstadoToken(estado);
    const compact = token.replace(/\s+/g, '');
    const isSuccess = compact === 'enviado' || compact === 'enviadoinex';
    return {
        isSuccess,
        reason: isSuccess ? 'enviado' : 'not_enviado',
        normalized: token,
    };
}

function classifyGoffSaftStatus(estado, situacao) {
    const estadoToken = normalizeEstadoToken(estado);
    const situacaoToken = normalizeEstadoToken(situacao);
    const joined = `${estadoToken} ${situacaoToken}`.trim();

    const hasFailure = ['rejeitad', 'erro', 'falha', 'anulad', 'recusad', 'inval'].some((token) =>
        joined.includes(token)
    );
    if (hasFailure) {
        return { isSuccess: false, reason: 'error_or_rejected', normalized: joined };
    }

    const hasSuccess = [
        'integrado com sucesso',
        'integrado',
        'processad',
        'enviado',
        'entregue',
        'aceite',
        'certa',
        'validad',
    ].some((token) => joined.includes(token));

    return {
        isSuccess: hasSuccess,
        reason: hasSuccess ? 'integrated_or_processed' : 'not_success',
        normalized: joined,
    };
}

function normalizeIvaPeriodicidade(value) {
    const token = normalizeLookupText(value);
    if (!token) return '';
    if (token.includes('trimes')) return 'trimestral';
    if (token.includes('mens')) return 'mensal';
    if (token.includes('anual')) return 'anual';
    if (token === 't') return 'trimestral';
    if (token === 'm') return 'mensal';
    return '';
}

function classifyGoffIvaStatus(estado, situacao) {
    const estadoToken = normalizeEstadoToken(estado);
    const situacaoToken = normalizeEstadoToken(situacao);
    const joined = `${estadoToken} ${situacaoToken}`.trim();

    const hasFailure = ['rejeitad', 'erro', 'falha', 'anulad', 'recusad', 'inval'].some((token) =>
        joined.includes(token)
    );
    if (hasFailure) {
        return { isSuccess: false, reason: 'error_or_rejected', normalized: joined };
    }

    const hasSuccess = ['submetid', 'integrado', 'processad', 'entregue', 'aceite', 'certa', 'validad'].some((token) =>
        joined.includes(token)
    );
    return {
        isSuccess: hasSuccess,
        reason: hasSuccess ? 'submitted_or_processed' : 'not_success',
        normalized: joined,
    };
}

function classifyIvaProcessadoStatus(estado, situacao) {
    const estadoToken = normalizeEstadoToken(estado);
    const situacaoToken = normalizeEstadoToken(situacao);
    const joined = `${estadoToken} ${situacaoToken}`.trim();

    const hasFailure = ['erro', 'rejeitad', 'recusad', 'anulad', 'falha', 'inval'].some((token) =>
        joined.includes(token)
    );
    if (hasFailure) {
        return { isSuccess: false, reason: 'error_or_rejected', normalized: joined };
    }

    const hasSuccess = ['processad', 'entregue', 'validad'].some((token) => joined.includes(token));
    if (hasSuccess) {
        return { isSuccess: true, reason: 'processed', normalized: joined };
    }

    return { isSuccess: false, reason: 'unknown', normalized: joined };
}

function classifyM22ProcessadoStatus(estado, estadoAt) {
    const estadoToken = normalizeEstadoToken(estado);
    const estadoAtToken = normalizeEstadoToken(estadoAt);
    const joined = `${estadoToken} ${estadoAtToken}`.trim();

    const hasFailure = ['erro', 'rejeitad', 'recusad', 'anulad', 'falha', 'inval', 'incerta'].some((token) =>
        joined.includes(token)
    );
    if (hasFailure) {
        return { isSuccess: false, reason: 'error_or_rejected', normalized: joined };
    }

    const hasSuccess = estadoToken.includes('processad');
    if (hasSuccess) {
        return { isSuccess: true, reason: 'processed', normalized: joined };
    }

    return { isSuccess: false, reason: 'unknown', normalized: joined };
}

function classifyRelatorioUnicoStatus(estado, estadoAt, payload) {
    const estadoToken = normalizeEstadoToken(estado);
    const estadoAtToken = normalizeEstadoToken(estadoAt);
    const joined = `${estadoToken} ${estadoAtToken}`.trim();

    const hasFailure = ['erro', 'rejeitad', 'recusad', 'anulad', 'falha', 'inval', 'incerta'].some((token) =>
        joined.includes(token)
    );
    if (hasFailure) {
        return { isSuccess: false, reason: 'error_or_rejected', normalized: joined };
    }

    if (estadoToken.includes('processad')) {
        return { isSuccess: true, reason: 'processed', normalized: joined };
    }

    const dataRecolha = String(payload?.dataRecolha || payload?.data_recolha || payload?.dataRecebido || '').trim();
    const hasDownloads =
        normalizeBoolean(payload?.temDownloads, false) ||
        normalizeBoolean(payload?.temFicheiro, false) ||
        normalizeBoolean(payload?.temComprovativo, false) ||
        Number(payload?.downloadCount || 0) > 0;

    if (dataRecolha || hasDownloads) {
        return { isSuccess: true, reason: 'documents_collected', normalized: joined || 'documents_collected' };
    }

    return { isSuccess: false, reason: 'unknown', normalized: joined };
}

function normalizeIntValue(value, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.trunc(number);
}

function parseDatePtToIso(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const direct = new Date(raw);
    if (!Number.isNaN(direct.getTime())) return direct.toISOString();

    const match = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!match) return null;
    const [, dd, mm, yyyy, hh = '00', min = '00', ss = '00'] = match;
    const iso = new Date(
        Date.UTC(
            Number(yyyy),
            Math.max(0, Number(mm) - 1),
            Number(dd),
            Number(hh),
            Number(min),
            Number(ss)
        )
    );
    if (Number.isNaN(iso.getTime())) return null;
    return iso.toISOString();
}

function resolveMonthYear(nowDate, offsetMonths = 0) {
    const reference = new Date(nowDate.getTime());
    reference.setUTCDate(1);
    reference.setUTCMonth(reference.getUTCMonth() + Number(offsetMonths || 0));
    return {
        year: reference.getUTCFullYear(),
        month: reference.getUTCMonth() + 1,
    };
}

function resolveObrigacaoPeriod(periodicidade, targetYear, targetMonth) {
    const normalized = String(periodicidade || '').toLowerCase().trim();
    if (normalized.includes('trimes')) {
        return {
            tipo: 'trimestral',
            ano: Number(targetYear),
            mes: null,
            trimestre: Math.ceil(Number(targetMonth) / 3),
        };
    }
    if (normalized.includes('anual')) {
        return {
            tipo: 'anual',
            ano: Number(targetYear),
            mes: null,
            trimestre: null,
        };
    }
    return {
        tipo: 'mensal',
        ano: Number(targetYear),
        mes: Number(targetMonth),
        trimestre: null,
    };
}

function parseIvaPeriodFromValue(rawValue, fallbackYear) {
    const raw = String(rawValue || '').trim().toUpperCase();
    if (!raw) {
        return null;
    }

    const compact = raw.replace(/\s+/g, '');
    const digits = compact.replace(/\D/g, '');
    const suffix = compact.replace(/\d/g, '');
    const fallbackYearNumber = normalizeIntValue(fallbackYear, new Date().getUTCFullYear());
    const fallbackCentury = Math.floor(fallbackYearNumber / 100) * 100;

    let year = fallbackYearNumber;
    let month = null;

    if (digits.length >= 4) {
        const yy = Number(digits.slice(0, 2));
        const mm = Number(digits.slice(2, 4));
        if (Number.isFinite(yy) && Number.isFinite(mm) && mm >= 1 && mm <= 12) {
            year = fallbackCentury + yy;
            month = mm;
        }
    } else if (digits.length >= 2) {
        const mm = Number(digits.slice(-2));
        if (Number.isFinite(mm) && mm >= 1 && mm <= 12) {
            month = mm;
        }
    }

    let tipo = 'mensal';
    if (suffix.includes('T')) tipo = 'trimestral';
    else if (suffix.includes('A')) tipo = 'anual';
    else if (suffix.includes('M')) tipo = 'mensal';

    const trimestre = tipo === 'trimestral' ? Math.ceil(Number(month || 1) / 3) : null;

    return {
        tipo,
        ano: Number(year),
        mes: tipo === 'mensal' ? Number(month || 0) : month ? Number(month) : null,
        trimestre,
        raw,
    };
}

function resolveShiftedYearMonth(baseDate, monthOffsetBack = 1) {
    const shifted = new Date(baseDate.getFullYear(), baseDate.getMonth() - Number(monthOffsetBack || 0), 1);
    return {
        year: shifted.getFullYear(),
        month: shifted.getMonth() + 1,
    };
}

function computeNextDailyRunAt(hour, minute, timezone) {
    const now = new Date();
    if (!timezone) {
        const next = new Date(now);
        next.setHours(Number(hour || 0), Number(minute || 0), 0, 0);
        if (next <= now) {
            next.setDate(next.getDate() + 1);
        }
        return next;
    }

    const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const nextInTz = new Date(nowInTz);
    nextInTz.setHours(Number(hour || 0), Number(minute || 0), 0, 0);
    if (nextInTz <= nowInTz) {
        nextInTz.setDate(nextInTz.getDate() + 1);
    }
    const delayMs = nextInTz.getTime() - nowInTz.getTime();
    return new Date(now.getTime() + Math.max(1000, delayMs));
}

module.exports = {
    normalizeDigits,
    normalizeLookupText,
    normalizeEstadoToken,
    classifyObrigacaoEstado,
    classifyDriCmpEnvStatus,
    classifyDmrProcessadoCertaStatus,
    classifySaftEnviadoStatus,
    classifyGoffSaftStatus,
    normalizeIvaPeriodicidade,
    classifyGoffIvaStatus,
    classifyIvaProcessadoStatus,
    classifyM22ProcessadoStatus,
    classifyRelatorioUnicoStatus,
    normalizeIntValue,
    parseDatePtToIso,
    resolveMonthYear,
    resolveObrigacaoPeriod,
    parseIvaPeriodFromValue,
    resolveShiftedYearMonth,
    computeNextDailyRunAt,
};
