const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_DIR = path.resolve(process.env.SEG_SOCIAL_INTEROP_LOG_DIR || path.join(process.cwd(), 'logs'));

const SERVICE_CONFIG = {
    ENVIAR_VALORES_REMUNERACAO: {
        pathEnv: 'SEG_SOCIAL_INTEROP_ENVIAR_VALORES_REMUNERACAO_PATH',
        authEnv: 'SEG_SOCIAL_INTEROP_ENVIAR_VALORES_REMUNERACAO_AUTH_TYPE',
        openApiEnv: 'SEG_SOCIAL_INTEROP_ENVIAR_VALORES_REMUNERACAO_OPENAPI_PATH',
    },
    CONSULTAR_VALORES_COMUNICADOS: {
        pathEnv: 'SEG_SOCIAL_INTEROP_CONSULTAR_VALORES_COMUNICADOS_PATH',
        authEnv: 'SEG_SOCIAL_INTEROP_CONSULTAR_VALORES_COMUNICADOS_AUTH_TYPE',
        openApiEnv: 'SEG_SOCIAL_INTEROP_CONSULTAR_VALORES_COMUNICADOS_OPENAPI_PATH',
    },
    CONSULTAR_VALORES_APURADOS: {
        pathEnv: 'SEG_SOCIAL_INTEROP_CONSULTAR_VALORES_APURADOS_PATH',
        authEnv: 'SEG_SOCIAL_INTEROP_CONSULTAR_VALORES_APURADOS_AUTH_TYPE',
        openApiEnv: 'SEG_SOCIAL_INTEROP_CONSULTAR_VALORES_APURADOS_OPENAPI_PATH',
    },
};

function normalizeAuthType(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    if (['basic', 'http-basic', 'basic-auth', 'basica', 'básica'].includes(raw)) return 'basic';
    if (['bearer', 'http-bearer', 'bearer-auth', 'token', 'jwt'].includes(raw)) return 'bearer';
    return '';
}

function normalizeBaseUrl(value) {
    const normalized = String(value || '').trim().replace(/\/+$/, '');
    if (/^https:\/\/(?:app|extwww)\.seg-social\.pt$/i.test(normalized)) {
        return `${normalized}/ptss/rest`;
    }
    if (/^https:\/\/(?:app|extwww)\.seg-social\.pt\/ptss$/i.test(normalized)) {
        return `${normalized}/rest`;
    }
    return normalized;
}

function resolveBaseUrl() {
    const configured = normalizeBaseUrl(process.env.SEG_SOCIAL_INTEROP_BASE_URL);
    if (configured) return configured;

    const error = new Error(
        'Falta configurar SEG_SOCIAL_INTEROP_BASE_URL com o endereço base oficial da PSi da Segurança Social.'
    );
    error.code = 'SEG_SOCIAL_INTEROP_BASE_URL_MISSING';
    throw error;
}

function normalizePath(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw.startsWith('/') ? raw : `/${raw}`;
}

function resolveConfiguredPath(pathEnvName) {
    const endpointPath = normalizePath(process.env[pathEnvName]);
    if (endpointPath) return endpointPath;

    const error = new Error(
        `Falta configurar ${pathEnvName} com o path do serviço PSi indicado no YAML/OpenAPI.`
    );
    error.code = 'SEG_SOCIAL_INTEROP_PATH_MISSING';
    error.envName = pathEnvName;
    throw error;
}

function normalizeNissEe(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const subUserMatch = raw.match(/^(\d{9,12})-\d+$/);
    if (subUserMatch) return subUserMatch[1];
    return raw.replace(/\D/g, '');
}

function normalizeAnoMes(value, baseDate = new Date()) {
    const raw = String(value || '').trim();
    const compactMatch = raw.match(/^(\d{4})[-/]?(\d{2})$/);
    if (compactMatch) return `${compactMatch[1]}-${compactMatch[2]}`;

    const date = new Date(baseDate);
    date.setMonth(date.getMonth() - 1);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

function interpolatePath(pathTemplate, pathParams = {}) {
    return String(pathTemplate || '').replace(/\{([^}]+)\}/g, (_match, key) => {
        const value = pathParams[key] ?? pathParams[key.replace(/-/g, '_')];
        if (value === undefined || value === null || String(value).trim() === '') {
            const error = new Error(`Parâmetro obrigatório em falta para a API da Segurança Social: ${key}`);
            error.code = 'SEG_SOCIAL_INTEROP_PARAM_MISSING';
            error.param = key;
            throw error;
        }
        return encodeURIComponent(String(value).trim());
    });
}

function getServiceConfig(serviceKey) {
    const key = String(serviceKey || '').trim().toUpperCase();
    const config = SERVICE_CONFIG[key];
    if (!config) {
        const error = new Error(`Serviço PSi desconhecido: ${serviceKey}`);
        error.code = 'SEG_SOCIAL_INTEROP_SERVICE_UNKNOWN';
        throw error;
    }
    return config;
}

function resolveEndpoint(serviceKey, pathParams = {}) {
    const config = getServiceConfig(serviceKey);
    const baseUrl = resolveBaseUrl();
    const endpointPath = interpolatePath(resolveConfiguredPath(config.pathEnv), pathParams);
    return `${baseUrl}${endpointPath}`;
}

function removePathParams(params = {}, keys = []) {
    const cleaned = { ...(params || {}) };
    keys.forEach((key) => {
        delete cleaned[key];
        delete cleaned[key.replace(/-/g, '_')];
        delete cleaned[key.replace(/-([a-z])/g, (_, letter) => String(letter || '').toUpperCase())];
    });
    return cleaned;
}

function requireNissEe(params = {}, options = {}) {
    const nissEe = normalizeNissEe(
        params.nissEe ||
        params.niss_ee ||
        params['niss-ee'] ||
        options.nissEe ||
        options.niss_ee ||
        options['niss-ee']
    );
    if (!nissEe) {
        const error = new Error('NISS da entidade empregadora em falta para a API da Segurança Social.');
        error.code = 'SEG_SOCIAL_INTEROP_PARAM_MISSING';
        error.param = 'niss-ee';
        throw error;
    }
    return nissEe;
}

function detectAuthTypeFromOpenApiFile(filePath) {
    const resolvedPath = path.resolve(String(filePath || '').trim());
    if (!resolvedPath || !fs.existsSync(resolvedPath)) return '';

    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const compact = raw.toLowerCase();

    try {
        if (compact.trim().startsWith('{')) {
            const parsed = JSON.parse(raw);
            const schemes = parsed?.components?.securitySchemes || parsed?.securityDefinitions || {};
            const detected = Object.values(schemes)
                .map((scheme) => normalizeAuthType(scheme?.scheme || scheme?.type || ''))
                .filter(Boolean);
            const unique = [...new Set(detected)];
            return unique.length === 1 ? unique[0] : '';
        }
    } catch {
        // YAML or invalid JSON falls through to the lightweight text scan.
    }

    const hasBearer = /scheme\s*:\s*bearer\b/i.test(raw) || /bearerformat\s*:/i.test(raw);
    const hasBasic = /scheme\s*:\s*basic\b/i.test(raw);
    if (hasBearer && !hasBasic) return 'bearer';
    if (hasBasic && !hasBearer) return 'basic';
    return '';
}

function resolveAuthType(serviceKey, preferredType = '') {
    const config = getServiceConfig(serviceKey);
    const envAuthType = normalizeAuthType(process.env[config.authEnv] || process.env.SEG_SOCIAL_INTEROP_AUTH_TYPE);
    if (envAuthType) {
        return { authType: envAuthType, source: process.env[config.authEnv] ? config.authEnv : 'SEG_SOCIAL_INTEROP_AUTH_TYPE' };
    }

    const openApiPath = String(
        process.env[config.openApiEnv] ||
        process.env[config.openApiEnv.replace(/_OPENAPI_PATH$/, '_YAML_PATH')] ||
        process.env.SEG_SOCIAL_INTEROP_OPENAPI_PATH ||
        ''
    ).trim();
    const specAuthType = openApiPath ? detectAuthTypeFromOpenApiFile(openApiPath) : '';
    if (specAuthType) {
        return { authType: specAuthType, source: openApiPath };
    }

    const preferred = String(preferredType || '').trim().toLowerCase();
    return {
        authType: preferred.includes('token') ? 'bearer' : 'basic',
        source: preferred.includes('token') ? 'default-token' : 'default-basic',
    };
}

function getAuthHeaders(authOptions = {}) {
    const authType = normalizeAuthType(authOptions.authType || authOptions.type) || 'bearer';
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
    };

    if (authType === 'basic') {
        const username = String(authOptions.username || '').trim();
        const password = String(authOptions.password || authOptions.secret || '').trim();
        if (!username || !password) {
            const error = new Error('Utilizador/palavra-passe da Segurança Social em falta para autenticação Basic.');
            error.code = 'SEG_SOCIAL_BASIC_AUTH_MISSING';
            throw error;
        }
        headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
        return headers;
    }

    const token = String(authOptions.token || authOptions.password || authOptions.secret || '').trim();
    if (!token) {
        const error = new Error('Token Bearer da Segurança Social em falta.');
        error.code = 'SEG_SOCIAL_TOKEN_MISSING';
        throw error;
    }
    headers.Authorization = `Bearer ${token}`;
    return headers;
}

function sanitizeLogBody(bodyText) {
    const value = String(bodyText || '');
    if (value.length <= 8000) return value;
    return `${value.slice(0, 8000)}...[truncated]`;
}

async function guardarLogsResposta(response, bodyText = '') {
    const logEntry = {
        timestamp: new Date().toISOString(),
        service: 'seg_social_interoperabilidade',
        url: response?.url || '',
        status: Number(response?.status || 0),
        ok: Boolean(response?.ok),
        body: sanitizeLogBody(bodyText),
    };

    try {
        await fs.promises.mkdir(DEFAULT_LOG_DIR, { recursive: true });
        await fs.promises.appendFile(
            path.join(DEFAULT_LOG_DIR, 'seg-social-interoperabilidade.log'),
            `${JSON.stringify(logEntry)}\n`,
            'utf8'
        );
    } catch (error) {
        console.warn('[SegSocial Interop] Falha ao guardar log:', error?.message || error);
    }

    return logEntry;
}

function parseJsonSafely(text) {
    if (!String(text || '').trim()) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function extractResponseMessage(parsedBody = null) {
    if (typeof parsedBody === 'string') return parsedBody;
    return String(parsedBody?.message || parsedBody?.error || parsedBody?.descricao || parsedBody?.detail || '');
}

function tratarErroAutenticacao(response, parsedBody = null) {
    const status = Number(response?.status || 0);
    if (status === 401) {
        const error = new Error(
            extractResponseMessage(parsedBody) ||
            'Token/autenticação da Segurança Social inválido, expirado ou em formato errado.'
        );
        error.code = 'SEG_SOCIAL_AUTH_INVALID';
        error.status = status;
        error.response = parsedBody;
        return error;
    }

    if (status === 403) {
        const error = new Error(
            extractResponseMessage(parsedBody) ||
            'A Segurança Social recusou o acesso a este serviço PSi para este NISS/subutilizador/token.'
        );
        error.code = 'SEG_SOCIAL_SERVICE_NOT_AUTHORIZED';
        error.status = status;
        error.response = parsedBody;
        return error;
    }

    return null;
}

function buildUrlWithParams(url, params = {}) {
    const target = new URL(url);
    Object.entries(params || {}).forEach(([key, value]) => {
        if (value === undefined || value === null || String(value).trim() === '') return;
        if (Array.isArray(value)) {
            value.forEach((item) => {
                if (item !== undefined && item !== null && String(item).trim() !== '') {
                    target.searchParams.append(key, String(item));
                }
            });
            return;
        }
        target.searchParams.set(key, String(value));
    });
    return target.toString();
}

async function requestJson(url, requestOptions = {}, authOptions = {}) {
    const fetchImpl = authOptions.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        const error = new Error('Fetch indisponível neste ambiente para chamadas de interoperabilidade.');
        error.code = 'FETCH_UNAVAILABLE';
        throw error;
    }

    const response = await fetchImpl(url, {
        method: requestOptions.method || 'GET',
        headers: getAuthHeaders(authOptions),
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
    });

    const bodyText = await response.text().catch(() => '');
    await guardarLogsResposta(response, bodyText);
    const parsedBody = parseJsonSafely(bodyText);

    const authError = tratarErroAutenticacao(response, parsedBody);
    if (authError) throw authError;

    if (!response.ok) {
        const error = new Error(
            extractResponseMessage(parsedBody) || `Erro na API de interoperabilidade da Segurança Social (${response.status}).`
        );
        error.code = 'SEG_SOCIAL_INTEROP_ERROR';
        error.status = response.status;
        error.response = parsedBody;
        throw error;
    }

    return {
        success: true,
        status: response.status,
        authType: normalizeAuthType(authOptions.authType) || 'bearer',
        authSource: String(authOptions.authSource || '').trim() || undefined,
        data: parsedBody,
    };
}

async function enviarValoresRemuneracao(payload, options = {}) {
    const nissEe = requireNissEe({}, options);
    const url = resolveEndpoint('ENVIAR_VALORES_REMUNERACAO', { 'niss-ee': nissEe });
    return requestJson(url, { method: 'POST', body: payload }, options);
}

async function consultarValoresComunicados(params, options = {}) {
    const nissEe = requireNissEe(params, options);
    const url = resolveEndpoint('CONSULTAR_VALORES_COMUNICADOS', { 'niss-ee': nissEe });
    return requestJson(buildUrlWithParams(url, removePathParams(params, ['niss-ee'])), { method: 'GET' }, options);
}

async function consultarValoresApuradosMensalmente(params, options = {}) {
    const nissEe = requireNissEe(params, options);
    const anoMes = normalizeAnoMes(params.anoMes || params.ano_mes || params['ano-mes'] || options.anoMes || options.ano_mes || options['ano-mes']);
    const url = resolveEndpoint('CONSULTAR_VALORES_APURADOS', { 'niss-ee': nissEe, 'ano-mes': anoMes });
    return requestJson(buildUrlWithParams(url, removePathParams(params, ['niss-ee', 'ano-mes'])), { method: 'GET' }, options);
}

module.exports = {
    getAuthHeaders,
    normalizeAnoMes,
    normalizeAuthType,
    normalizeNissEe,
    resolveAuthType,
    resolveBaseUrl,
    enviarValoresRemuneracao,
    consultarValoresComunicados,
    consultarValoresApuradosMensalmente,
    tratarErroAutenticacao,
    guardarLogsResposta,
};
