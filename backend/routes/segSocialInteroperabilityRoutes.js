const {
    enviarValoresRemuneracao,
    consultarValoresComunicados,
    consultarValoresApuradosMensalmente,
    normalizeAuthType,
    resolveAuthType,
} = require('../../src/server/services/segSocialInteroperabilityService');

function normalizeText(value) {
    return String(value || '')
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/_/g, '-')
        .toLowerCase();
}

function isSegSocialCredential(credential) {
    const service = normalizeText(credential?.service);
    return service === 'ss' || service === 'seguranca social' || service.includes('seg-social');
}

function normalizeNissEe(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const subUserMatch = raw.match(/^(\d{9,12})-\d+$/);
    if (subUserMatch) return subUserMatch[1];
    return raw.replace(/\D/g, '');
}

function resolveCustomerNissEe(customer, requestValues = {}) {
    return normalizeNissEe(
        requestValues.nissEe ||
        requestValues.niss_ee ||
        requestValues['niss-ee'] ||
        customer?.niss ||
        customer?.numeroSegurancaSocial ||
        customer?.nissSegurancaSocial
    );
}

function hasSecret(value) {
    return Boolean(String(value || '').trim());
}

function credentialType(credential) {
    return normalizeText(credential?.credentialType || credential?.credential_type);
}

function isUsableSegSocialCredential(credential) {
    if (!isSegSocialCredential(credential)) return false;
    const status = normalizeText(credential?.status || 'active');
    return status !== 'inactive' && status !== 'expired' && status !== 'error';
}

function findSegSocialCredential(customer, matcher) {
    const credentials = Array.isArray(customer?.accessCredentials) ? customer.accessCredentials : [];
    return credentials.find((credential) => isUsableSegSocialCredential(credential) && matcher(credential)) || null;
}

function resolveSegSocialSubUserCredential(customer, requirePassword = true) {
    return findSegSocialCredential(customer, (credential) => {
        const type = credentialType(credential);
        if (!type.includes('sub')) return false;
        if (!hasSecret(credential?.username)) return false;
        return !requirePassword || hasSecret(credential?.password);
    });
}

function resolveSegSocialPrincipalCredential(customer, requirePassword = true) {
    return findSegSocialCredential(customer, (credential) => {
        const type = credentialType(credential);
        const service = normalizeText(credential?.service);
        const isPrincipal = type === 'principal' || (!type && service === 'ss');
        if (!isPrincipal) return false;
        if (!hasSecret(credential?.username)) return false;
        return !requirePassword || hasSecret(credential?.password);
    });
}

function resolveSegSocialTokenCredential(customer) {
    return findSegSocialCredential(customer, (credential) => {
        const type = credentialType(credential);
        return type === 'token' && hasSecret(credential?.password);
    });
}

function resolveSegSocialAppCredential(customer) {
    return findSegSocialCredential(customer, (credential) => {
        const type = credentialType(credential);
        return type.includes('chave-aplicacional') && hasSecret(credential?.password);
    });
}

function normalizePreferredType(req) {
    return normalizeText(req.query?.tipo || req.query?.type || req.body?.tipo || req.body?.type || '');
}

function resolveBearerAuth(customer, preferredType) {
    const credential = preferredType.includes('token')
        ? resolveSegSocialTokenCredential(customer)
        : resolveSegSocialAppCredential(customer);

    if (!credential) {
        const error = new Error(
            preferredType.includes('token')
                ? 'Este cliente não tem credencial Segurança Social do tipo token guardada.'
                : 'Este cliente não tem chave de autenticação aplicacional da Segurança Social guardada.'
        );
        error.code = 'SEG_SOCIAL_TOKEN_MISSING';
        throw error;
    }

    return {
        authType: 'bearer',
        credential,
        username: String(credential.username || '').trim(),
        token: String(credential.password || '').trim(),
    };
}

function resolveBasicAuth(customer, preferredType) {
    if (preferredType.includes('chave-aplicacional')) {
        const appCredential = resolveSegSocialAppCredential(customer);
        const subUser = resolveSegSocialSubUserCredential(customer, false);
        if (!appCredential?.password) {
            const error = new Error('Este cliente não tem chave de autenticação aplicacional da Segurança Social guardada.');
            error.code = 'SEG_SOCIAL_BASIC_AUTH_MISSING';
            throw error;
        }
        const username = String(appCredential.username || subUser?.username || '').trim();
        if (!username) {
            const error = new Error('A chave aplicacional precisa de utilizador/NISS associado para autenticação Basic.');
            error.code = 'SEG_SOCIAL_BASIC_AUTH_MISSING';
            throw error;
        }
        return {
            authType: 'basic',
            credential: appCredential,
            username,
            password: String(appCredential.password || '').trim(),
        };
    }

    const subUser = resolveSegSocialSubUserCredential(customer, true);
    if (!subUser) {
        const error = new Error('Este cliente não tem subutilizador da Segurança Social com utilizador e senha guardados para autenticação Basic.');
        error.code = 'SEG_SOCIAL_BASIC_AUTH_MISSING';
        throw error;
    }
    return {
        authType: 'basic',
        credential: subUser,
        username: String(subUser.username || '').trim(),
        password: String(subUser.password || '').trim(),
    };
}

function resolveSegSocialInteropCredential(customer, preferredType, serviceKey) {
    const preferred = normalizeText(preferredType || 'token');
    const resolvedAuth = resolveAuthType(serviceKey, preferred);
    const authType = normalizeAuthType(resolvedAuth.authType) || (preferred.includes('token') ? 'bearer' : 'basic');
    const auth = authType === 'basic'
        ? resolveBasicAuth(customer, preferred)
        : resolveBearerAuth(customer, preferred);

    return {
        ...auth,
        authType,
        authSource: resolvedAuth.source,
    };
}

function resolveSegSocialInteropToken(customer, preferredType) {
    const credential = preferredType && normalizeText(preferredType).includes('chave')
        ? resolveSegSocialAppCredential(customer)
        : resolveSegSocialTokenCredential(customer);
    return String(credential?.password || '').trim();
}

function sendInteropError(res, error) {
    const code = String(error?.code || '').trim();
    const status = Number(error?.status || 0);

    if (code === 'SEG_SOCIAL_SERVICE_NOT_AUTHORIZED') {
        return res.status(status || 403).json({
            success: false,
            code,
            error: 'A Segurança Social respondeu 403: o subutilizador/token não tem permissões para este serviço PSi ou para este NISS.',
            details: error?.message || '',
            response: error?.response,
        });
    }

    if (code === 'SEG_SOCIAL_AUTH_INVALID' || status === 401) {
        return res.status(status || 401).json({
            success: false,
            code: 'SEG_SOCIAL_AUTH_INVALID',
            error: 'A Segurança Social respondeu 401: token inválido/expirado/formato errado ou credencial Basic inválida.',
            details: error?.message || '',
        });
    }

    if (code === 'SEG_SOCIAL_TOKEN_MISSING') {
        return res.status(400).json({
            success: false,
            code,
            error: error?.message || 'Este cliente não tem token/chave da Segurança Social guardado.',
        });
    }

    if (code === 'SEG_SOCIAL_BASIC_AUTH_MISSING') {
        return res.status(400).json({
            success: false,
            code,
            error: error?.message || 'Falta utilizador/senha da Segurança Social para autenticação Basic.',
        });
    }

    if (code === 'SEG_SOCIAL_INTEROP_PARAM_MISSING') {
        return res.status(400).json({
            success: false,
            code,
            param: error?.param,
            error: error.message,
        });
    }

    if (code === 'SEG_SOCIAL_INTEROP_BASE_URL_MISSING' || code === 'SEG_SOCIAL_INTEROP_PATH_MISSING') {
        return res.status(503).json({
            success: false,
            code,
            envName: error?.envName,
            error: error.message,
        });
    }

    return res.status(status >= 400 ? status : 500).json({
        success: false,
        code: code || 'SEG_SOCIAL_INTEROP_ERROR',
        error: error?.message || 'Falha na interoperabilidade da Segurança Social.',
        response: error?.response,
    });
}

function registerSegSocialInteroperabilityRoutes(context) {
    const { app, getLocalCustomerById, writeAuditLog } = context;
    if (!app || typeof app.post !== 'function' || typeof app.get !== 'function') {
        throw new Error('registerSegSocialInteroperabilityRoutes: app inválida');
    }

    async function resolveCredentialFromRequest(req, res, serviceKey) {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) {
            res.status(400).json({ success: false, error: 'Cliente inválido.' });
            return null;
        }

        const customer = await getLocalCustomerById(customerId);
        if (!customer) {
            res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            return null;
        }

        const preferredType = normalizePreferredType(req) || 'token';
        const auth = resolveSegSocialInteropCredential(customer, preferredType, serviceKey);
        const nissEe = resolveCustomerNissEe(customer, { ...req.query, ...(req.body || {}) });
        if (!nissEe) {
            res.status(400).json({
                success: false,
                code: 'SEG_SOCIAL_INTEROP_PARAM_MISSING',
                param: 'niss-ee',
                error: 'NISS da entidade empregadora em falta para a API da Segurança Social.',
            });
            return null;
        }

        return { customer, customerId, auth, nissEe, preferredType };
    }

    function cleanInteropQuery(query) {
        const cleaned = { ...(query || {}) };
        delete cleaned.tipo;
        delete cleaned.type;
        return cleaned;
    }

    function authOptionsFromResolved(resolved) {
        return {
            authType: resolved.auth.authType,
            authSource: resolved.auth.authSource,
            username: resolved.auth.username,
            password: resolved.auth.password,
            token: resolved.auth.token,
            nissEe: resolved.nissEe,
        };
    }

    app.post('/api/customers/:id/seg-social/interoperabilidade/valores-remuneracao', async (req, res) => {
        const resolved = await resolveCredentialFromRequest(req, res, 'ENVIAR_VALORES_REMUNERACAO').catch((error) => {
            sendInteropError(res, error);
            return null;
        });
        if (!resolved) return;

        try {
            const result = await enviarValoresRemuneracao(req.body || {}, authOptionsFromResolved(resolved));
            await writeAuditLog?.({
                actorUserId: req.body?.actorUserId || null,
                entityType: 'customer',
                entityId: resolved.customerId,
                action: 'seg_social_enviar_valores_remuneracao',
                details: { status: result.status, authType: result.authType },
            }).catch(() => null);
            return res.json(result);
        } catch (error) {
            return sendInteropError(res, error);
        }
    });

    app.get('/api/customers/:id/seg-social/interoperabilidade/valores-comunicados', async (req, res) => {
        const resolved = await resolveCredentialFromRequest(req, res, 'CONSULTAR_VALORES_COMUNICADOS').catch((error) => {
            sendInteropError(res, error);
            return null;
        });
        if (!resolved) return;

        try {
            const result = await consultarValoresComunicados(
                { ...cleanInteropQuery(req.query), nissEe: resolved.nissEe },
                authOptionsFromResolved(resolved)
            );
            return res.json(result);
        } catch (error) {
            return sendInteropError(res, error);
        }
    });

    app.get('/api/customers/:id/seg-social/interoperabilidade/valores-apurados-mensalmente', async (req, res) => {
        const resolved = await resolveCredentialFromRequest(req, res, 'CONSULTAR_VALORES_APURADOS').catch((error) => {
            sendInteropError(res, error);
            return null;
        });
        if (!resolved) return;

        try {
            const result = await consultarValoresApuradosMensalmente(
                { ...cleanInteropQuery(req.query), nissEe: resolved.nissEe },
                authOptionsFromResolved(resolved)
            );
            return res.json(result);
        } catch (error) {
            return sendInteropError(res, error);
        }
    });
}

module.exports = {
    registerSegSocialInteroperabilityRoutes,
    resolveSegSocialInteropCredential,
    resolveSegSocialInteropToken,
};
