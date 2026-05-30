'use strict';

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function foldText(value) {
    return cleanText(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function onlyDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function todayIsoDate() {
    return new Date().toISOString().slice(0, 10);
}

function isUsableStatus(entry) {
    const status = foldText(entry?.status || 'active');
    const validUntil = cleanText(entry?.validUntil || entry?.valid_until || '');
    return status !== 'expired' && status !== 'inactive' && status !== 'error' && (!validUntil || validUntil >= todayIsoDate());
}

function isAtCredential(entry) {
    const service = foldText(entry?.service || '');
    return service === 'at' || service.includes('autoridade') || service.includes('financ');
}

function isSegSocialCredential(entry) {
    const service = foldText(entry?.service || '');
    return service === 'ss' || service.includes('seguranca social') || service.includes('seg_social');
}

function isSegSocialSubUserCredential(entry) {
    if (!isSegSocialCredential(entry)) return false;
    const type = foldText(entry?.credentialType || entry?.credential_type || '');
    return type.includes('subutilizador') || type.includes('subconta') || type.includes('sub-user') || type.includes('sub user') || type === 'sub' || type.includes('sub');
}

function isSegSocialPrincipalCredential(entry) {
    if (!isSegSocialCredential(entry)) return false;
    const type = foldText(entry?.credentialType || entry?.credential_type || '');
    return type === 'principal' || (!type && foldText(entry?.service) === 'ss');
}

function isIapmeiCredential(entry) {
    const service = foldText(entry?.service || '');
    return service.includes('iapmei') || service.includes('pme');
}

function isViaCttCredential(entry) {
    const service = foldText(entry?.service || '');
    return service === 'viactt' || service.includes('viactt') || service.includes('via ctt') || service.includes('ctt');
}

function getCredentials(customer) {
    return Array.isArray(customer?.accessCredentials) ? customer.accessCredentials : [];
}

function resolveAtCredential(customer) {
    const atCredential = getCredentials(customer).find((entry) => isAtCredential(entry) && isUsableStatus(entry)) || null;
    const nif = onlyDigits(customer?.nif || '').slice(-9);
    return {
        username: cleanText(atCredential?.username || nif),
        password: cleanText(atCredential?.password || customer?.senhaFinancas || ''),
        nif,
        source: atCredential ? 'access_credentials' : 'senha_financas',
    };
}

function resolveSegSocialPrincipalCredential(customer) {
    const ssCredential = getCredentials(customer).find((entry) => isSegSocialPrincipalCredential(entry) && isUsableStatus(entry)) ||
        getCredentials(customer).find((entry) => isSegSocialCredential(entry) && isUsableStatus(entry)) ||
        null;
    const niss = onlyDigits(customer?.niss || '');
    return {
        username: cleanText(ssCredential?.username || niss),
        password: cleanText(ssCredential?.password || customer?.senhaSegurancaSocial || ''),
        niss,
        emailAssociado: cleanText(ssCredential?.emailAssociado || ssCredential?.email_associado || ''),
        source: ssCredential ? 'access_credentials' : 'senha_seg_social',
    };
}

function resolveSegSocialSubUserCredential(customer) {
    const subCredential = getCredentials(customer).find((entry) => (
        isSegSocialSubUserCredential(entry) &&
        cleanText(entry?.username) &&
        cleanText(entry?.password) &&
        isUsableStatus(entry)
    )) || null;
    const niss = onlyDigits(customer?.niss || '');
    return {
        username: cleanText(subCredential?.username || ''),
        password: cleanText(subCredential?.password || ''),
        niss,
        emailAssociado: cleanText(subCredential?.emailAssociado || subCredential?.email_associado || ''),
        source: subCredential ? 'subutilizador' : 'missing',
    };
}

function resolveIapmeiCredential(customer) {
    const iapmeiCredential = getCredentials(customer).find((entry) => isIapmeiCredential(entry) && isUsableStatus(entry)) || null;
    const nif = onlyDigits(customer?.nif || '').slice(-9);
    return {
        username: cleanText(iapmeiCredential?.username || nif),
        password: cleanText(iapmeiCredential?.password || ''),
        nif,
        source: iapmeiCredential ? 'access_credentials' : 'missing',
    };
}

function resolveViaCttCredential(customer) {
    const viacttCredential = getCredentials(customer).find((entry) => isViaCttCredential(entry) && isUsableStatus(entry)) || null;
    return {
        username: cleanText(viacttCredential?.username || ''),
        password: cleanText(viacttCredential?.password || ''),
        source: viacttCredential ? 'access_credentials' : 'missing',
    };
}

function hasCompleteSegSocialSubUser(customer) {
    return getCredentials(customer).some((entry) => (
        isSegSocialSubUserCredential(entry) &&
        cleanText(entry?.username) &&
        cleanText(entry?.password) &&
        isUsableStatus(entry)
    ));
}

function resolvePortalCredential(customer, portal, options = {}) {
    const key = foldText(portal);
    if (key === 'financas' || key === 'at' || key === 'bportugal') return resolveAtCredential(customer);
    if (key === 'seg-social' || key === 'seguranca-social' || key === 'ss') {
        if (options.mode === 'subutilizador') return resolveSegSocialSubUserCredential(customer);
        if (options.mode === 'fiscal') {
            const sub = resolveSegSocialSubUserCredential(customer);
            return sub.username && sub.password ? sub : resolveSegSocialPrincipalCredential(customer);
        }
        return resolveSegSocialPrincipalCredential(customer);
    }
    if (key === 'iefp') return resolveSegSocialPrincipalCredential(customer);
    if (key === 'iapmei' || key === 'pme') return resolveIapmeiCredential(customer);
    if (key === 'viactt' || key === 'via-ctt') return resolveViaCttCredential(customer);
    return { username: '', password: '', source: 'unknown' };
}

module.exports = {
    cleanText,
    foldText,
    onlyDigits,
    isUsableStatus,
    isAtCredential,
    isSegSocialCredential,
    isSegSocialSubUserCredential,
    isSegSocialPrincipalCredential,
    isIapmeiCredential,
    isViaCttCredential,
    resolveAtCredential,
    resolveSegSocialPrincipalCredential,
    resolveSegSocialSubUserCredential,
    resolveIapmeiCredential,
    resolveViaCttCredential,
    resolvePortalCredential,
    hasCompleteSegSocialSubUser,
};
