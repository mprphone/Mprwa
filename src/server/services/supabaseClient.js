function createSupabaseClient(deps) {
    const {
        axios,
        supabaseUrl,
        supabaseKey,
    } = deps;

    const supabaseColumnsCache = new Map();
    const supabaseTablesCache = {
        loaded: false,
        names: new Set(),
    };
    const supabaseResolvedTableCache = new Map();

    function sanitizeTableName(rawTableName) {
        const table = String(rawTableName || '').trim();
        if (!table) return null;
        if (!/^[a-zA-Z0-9_.]+$/.test(table)) return null;
        return table;
    }

    async function fetchSupabaseTable(rawTableName) {
        const tableName = sanitizeTableName(rawTableName);
        if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);

        const response = await axios.get(`${supabaseUrl}/rest/v1/${tableName}?select=*&limit=5000`, {
            headers: {
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`,
            },
            timeout: 15000,
        });

        if (!Array.isArray(response.data)) return [];
        return response.data;
    }

    async function fetchSupabaseTableSince(rawTableName, updatedAtColumn, sinceIso) {
        const tableName = sanitizeTableName(rawTableName);
        if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);
        const safeUpdatedColumn = sanitizeTableName(updatedAtColumn);
        if (!safeUpdatedColumn) throw new Error(`Coluna updated_at inválida: ${updatedAtColumn}`);

        const since = String(sinceIso || '').trim();
        if (!since) return fetchSupabaseTable(tableName);

        const params = new URLSearchParams();
        params.set('select', '*');
        params.set(safeUpdatedColumn, `gt.${since}`);
        params.set('order', `${safeUpdatedColumn}.asc`);
        params.set('limit', '5000');

        const response = await axios.get(`${supabaseUrl}/rest/v1/${tableName}?${params.toString()}`, {
            headers: {
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`,
            },
            timeout: 20000,
        });

        if (!Array.isArray(response.data)) return [];
        return response.data;
    }

    async function fetchSupabaseTableWithFilters(rawTableName, filters = {}, options = {}) {
        const tableName = sanitizeTableName(rawTableName);
        if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);
        const params = new URLSearchParams();
        params.set('select', String(options.select || '*'));
        Object.entries(filters || {}).forEach(([column, value]) => {
            const safeColumn = sanitizeTableName(column);
            if (!safeColumn || value === undefined || value === null || value === '') return;
            params.set(safeColumn, `eq.${String(value).trim()}`);
        });
        if (options.orderBy) {
            const safeOrderBy = sanitizeTableName(options.orderBy);
            if (safeOrderBy) {
                params.set('order', `${safeOrderBy}.${String(options.orderDirection || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc'}`);
            }
        }
        if (Number.isFinite(Number(options.limit)) && Number(options.limit) > 0) {
            params.set('limit', String(Math.min(10000, Math.max(1, Number(options.limit)))));
        }

        const response = await axios.get(`${supabaseUrl}/rest/v1/${tableName}?${params.toString()}`, {
            headers: {
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`,
            },
            timeout: 20000,
        });

        if (!Array.isArray(response.data)) return [];
        return response.data;
    }

    async function fetchSupabaseTableSample(rawTableName) {
        const tableName = sanitizeTableName(rawTableName);
        if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);

        const response = await axios.get(`${supabaseUrl}/rest/v1/${tableName}?select=*&limit=1`, {
            headers: {
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`,
            },
            timeout: 15000,
        });

        if (!Array.isArray(response.data)) return [];
        return response.data;
    }

    function pickExistingColumn(columns, candidates, fallback) {
        for (const candidate of candidates) {
            if (columns.includes(candidate)) return candidate;
        }
        return fallback;
    }

    async function patchSupabaseTable(rawTableName, payload, filterColumn, filterValue) {
        const tableName = sanitizeTableName(rawTableName);
        if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);

        const params = new URLSearchParams();
        params.set('select', '*');
        params.set(filterColumn, `eq.${String(filterValue || '').trim()}`);

        const response = await axios.patch(`${supabaseUrl}/rest/v1/${tableName}?${params.toString()}`, payload, {
            headers: {
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`,
                Prefer: 'return=representation',
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        });

        return Array.isArray(response.data) ? response.data : [];
    }

    async function fetchSupabaseOpenApiSchema() {
        const response = await axios.get(`${supabaseUrl}/rest/v1/`, {
            headers: {
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`,
                Accept: 'application/openapi+json',
            },
            timeout: 20000,
        });
        return response?.data && typeof response.data === 'object' ? response.data : {};
    }

    async function fetchSupabaseTableNamesFromOpenApi() {
        if (supabaseTablesCache.loaded) return supabaseTablesCache.names;

        const names = new Set();
        try {
            const openApi = await fetchSupabaseOpenApiSchema();
            const paths = openApi?.paths || {};
            Object.keys(paths).forEach((rawPath) => {
                const normalized = String(rawPath || '').trim().replace(/^\/+/, '');
                if (!normalized) return;
                if (normalized.startsWith('rpc/')) return;
                if (!sanitizeTableName(normalized)) return;
                names.add(normalized);
            });
        } catch (error) {
            // segue sem cache de tabelas
        }

        supabaseTablesCache.loaded = true;
        supabaseTablesCache.names = names;
        return names;
    }

    async function resolveSupabaseTableName(primaryTableName, fallbackTableNames = []) {
        const normalizedPrimary = sanitizeTableName(primaryTableName);
        if (!normalizedPrimary) {
            throw new Error(`Nome de tabela inválido: ${primaryTableName}`);
        }

        const cacheKey = [normalizedPrimary, ...fallbackTableNames.map((item) => String(item || '').trim())].join('|');
        if (supabaseResolvedTableCache.has(cacheKey)) {
            return supabaseResolvedTableCache.get(cacheKey);
        }

        const candidates = Array.from(
            new Set([normalizedPrimary, ...fallbackTableNames].map((item) => sanitizeTableName(item)).filter(Boolean))
        );

        if (supabaseUrl && supabaseKey) {
            const availableTables = await fetchSupabaseTableNamesFromOpenApi();
            if (availableTables.size > 0) {
                for (const candidate of candidates) {
                    if (availableTables.has(candidate)) {
                        supabaseResolvedTableCache.set(cacheKey, candidate);
                        return candidate;
                    }
                }
            }
        }

        supabaseResolvedTableCache.set(cacheKey, normalizedPrimary);
        return normalizedPrimary;
    }

    function parseTableColumnsFromOpenApi(openApi, tableName) {
        if (!openApi || typeof openApi !== 'object') return [];

        const schemas = openApi.components?.schemas || {};
        if (schemas && typeof schemas === 'object') {
            for (const [schemaName, schemaDef] of Object.entries(schemas)) {
                if (schemaName === tableName || schemaName.endsWith(`.${tableName}`)) {
                    const props = schemaDef?.properties;
                    if (props && typeof props === 'object') {
                        return Object.keys(props);
                    }
                }
            }
        }

        const paths = openApi.paths || {};
        const tablePath = Object.keys(paths).find((key) => key === `/${tableName}` || key.endsWith(`/${tableName}`));
        if (!tablePath) return [];

        const getDef = paths[tablePath]?.get;
        const params = Array.isArray(getDef?.parameters) ? getDef.parameters : [];
        const selectParam = params.find((item) => item?.name === 'select');
        const sampleColumns = String(selectParam?.schema?.default || '').trim();
        if (!sampleColumns || sampleColumns === '*') return [];
        return sampleColumns
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }

    async function fetchSupabaseTableColumns(rawTableName) {
        const tableName = sanitizeTableName(rawTableName);
        if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);
        if (supabaseColumnsCache.has(tableName)) {
            return supabaseColumnsCache.get(tableName);
        }

        let columns = [];
        try {
            const sampleRows = await fetchSupabaseTableSample(tableName);
            if (Array.isArray(sampleRows) && sampleRows.length > 0) {
                columns = Object.keys(sampleRows[0] || {});
            }
        } catch (error) {
            // segue fallback OpenAPI
        }

        if (!columns.length) {
            try {
                const openApi = await fetchSupabaseOpenApiSchema();
                columns = parseTableColumnsFromOpenApi(openApi, tableName);
            } catch (error) {
                // segue sem cache de colunas
            }
        }

        const normalizedColumns = Array.from(new Set(columns.map((item) => String(item || '').trim()).filter(Boolean)));
        supabaseColumnsCache.set(tableName, normalizedColumns);
        return normalizedColumns;
    }

    function pickColumnByCandidates(columns, candidates, fallback = '') {
        if (!Array.isArray(columns) || columns.length === 0) return fallback || '';
        for (const candidate of candidates) {
            if (columns.includes(candidate)) return candidate;
        }
        return fallback || '';
    }

    function buildPayloadWithExistingColumns(columns, payloadMap) {
        const payload = {};
        Object.entries(payloadMap || {}).forEach(([key, value]) => {
            if (value === undefined) return;
            if (Array.isArray(columns) && columns.length > 0 && !columns.includes(key)) return;
            payload[key] = value;
        });
        return payload;
    }

    async function patchSupabaseTableWithFilters(rawTableName, payload, filters = {}) {
        const tableName = sanitizeTableName(rawTableName);
        if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);

        const params = new URLSearchParams();
        params.set('select', '*');
        Object.entries(filters || {}).forEach(([column, value]) => {
            if (value === undefined || value === null || value === '') return;
            params.set(column, `eq.${String(value).trim()}`);
        });

        const response = await axios.patch(`${supabaseUrl}/rest/v1/${tableName}?${params.toString()}`, payload, {
            headers: {
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`,
                Prefer: 'return=representation',
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        });

        return Array.isArray(response.data) ? response.data : [];
    }

    async function insertSupabaseRow(rawTableName, payload) {
        const tableName = sanitizeTableName(rawTableName);
        if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);

        const response = await axios.post(`${supabaseUrl}/rest/v1/${tableName}`, payload, {
            headers: {
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`,
                Prefer: 'return=representation',
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        });

        return Array.isArray(response.data) ? response.data : [];
    }

    async function upsertSupabaseRow(rawTableName, payload, onConflictColumns = []) {
        const tableName = sanitizeTableName(rawTableName);
        if (!tableName) throw new Error(`Nome de tabela inválido: ${rawTableName}`);

        const params = new URLSearchParams();
        const normalizedConflicts = Array.from(
            new Set((Array.isArray(onConflictColumns) ? onConflictColumns : []).map((item) => String(item || '').trim()).filter(Boolean))
        );
        if (normalizedConflicts.length > 0) {
            params.set('on_conflict', normalizedConflicts.join(','));
        }

        const response = await axios.post(
            `${supabaseUrl}/rest/v1/${tableName}${params.toString() ? `?${params.toString()}` : ''}`,
            payload,
            {
                headers: {
                    apikey: supabaseKey,
                    Authorization: `Bearer ${supabaseKey}`,
                    Prefer: 'resolution=merge-duplicates,return=representation',
                    'Content-Type': 'application/json',
                },
                timeout: 15000,
            }
        );

        return Array.isArray(response.data) ? response.data : [];
    }

    return {
        sanitizeTableName,
        fetchSupabaseTable,
        fetchSupabaseTableSince,
        fetchSupabaseTableWithFilters,
        fetchSupabaseTableSample,
        pickExistingColumn,
        patchSupabaseTable,
        fetchSupabaseOpenApiSchema,
        fetchSupabaseTableNamesFromOpenApi,
        resolveSupabaseTableName,
        parseTableColumnsFromOpenApi,
        fetchSupabaseTableColumns,
        pickColumnByCandidates,
        buildPayloadWithExistingColumns,
        patchSupabaseTableWithFilters,
        insertSupabaseRow,
        upsertSupabaseRow,
    };
}

module.exports = {
    createSupabaseClient,
};
