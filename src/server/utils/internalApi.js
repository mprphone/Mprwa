'use strict';

// Header de autenticação para chamadas internas server->server à própria API.
// O middleware de auth (apiAuthMiddleware) aceita `x-internal-api-key` igual a
// INTERNAL_API_KEY. Enquanto ALLOW_LOCAL_API_WITHOUT_AUTH estiver ligado estas
// chamadas continuam a passar pelo bypass local e o header é simplesmente
// ignorado — fica pronto para quando o bypass for desligado, sem mudar
// comportamento nenhum entretanto.

const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';

function getInternalApiKey() {
    return String(process.env.INTERNAL_API_KEY || process.env.WA_INTERNAL_API_KEY || '').trim();
}

// Devolve os headers dados acrescidos da chave interna (se estiver configurada).
function internalApiHeaders(extraHeaders = {}) {
    const key = getInternalApiKey();
    if (!key) return { ...extraHeaders };
    return { ...extraHeaders, [INTERNAL_API_KEY_HEADER]: key };
}

module.exports = {
    INTERNAL_API_KEY_HEADER,
    getInternalApiKey,
    internalApiHeaders,
};
