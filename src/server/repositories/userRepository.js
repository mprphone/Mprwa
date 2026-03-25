function createUserRepository(deps) {
    const {
        dbAllAsync,
        dbGetAsync,
        dbRunAsync,
        normalizeBoolean,
        parseJsonArray,
        normalizeRole,
        defaultAvatar,
    } = deps;

    function normalizeLocalSqlUser(row) {
        if (!row) return null;

        const id = String(row.id || '').trim();
        const name = String(row.name || '').trim();
        const email = String(row.email || '').trim().toLowerCase();
        if (!id || !name || !email) return null;

        return {
            id,
            name,
            email,
            role: normalizeRole(row.role),
            avatarUrl: String(row.avatar_url || '').trim() || defaultAvatar,
            password: String(row.password || '').trim() || undefined,
            isAiAssistant: normalizeBoolean(row.is_ai_assistant, false),
            aiAllowedSites: (() => {
                const parsed = parseJsonArray(row.ai_allowed_sites_json)
                    .map((site) => String(site || '').trim())
                    .filter(Boolean);
                return parsed;
            })(),
        };
    }

    function sanitizeRoleValue(value) {
        const normalized = normalizeRole(value);
        return normalized === 'ADMIN' ? 'ADMIN' : 'AGENT';
    }

    function sanitizeUserId(rawId, rawEmail) {
        const candidate = String(rawId || '').trim();
        if (candidate) return candidate;

        const emailSeed = String(rawEmail || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');

        return emailSeed ? `local_u_${emailSeed}` : `local_u_${Date.now()}`;
    }

    function parseSourceId(userId, explicitSourceId) {
        const source = String(explicitSourceId || '').trim();
        if (source) return source;

        const id = String(userId || '').trim();
        if (id.startsWith('ext_u_')) return id.slice(6);
        return '';
    }

    async function getAllLocalUsers() {
        const rows = await dbAllAsync(
            `SELECT id, source_id, name, email, role, password, avatar_url, is_ai_assistant, ai_allowed_sites_json
             FROM users
             ORDER BY datetime(updated_at) DESC`
        );
        return rows.map(normalizeLocalSqlUser).filter(Boolean);
    }

    async function upsertLocalUser(userInput) {
        const incomingId = sanitizeUserId(userInput.id, userInput.email);
        const incomingSourceId = parseSourceId(incomingId, userInput.sourceId);
        const incomingEmail = String(userInput.email || '').trim().toLowerCase();
        const incomingName = String(userInput.name || '').trim();
        const incomingRole = sanitizeRoleValue(userInput.role);
        const incomingPassword = userInput.password === undefined ? undefined : String(userInput.password || '').trim();
        const incomingAvatar = String(userInput.avatarUrl || '').trim();
        const incomingIsAiAssistant =
            userInput.isAiAssistant === undefined ? undefined : normalizeBoolean(userInput.isAiAssistant, false);
        const incomingAiAllowedSites = Array.isArray(userInput.aiAllowedSites)
            ? userInput.aiAllowedSites.map((site) => String(site || '').trim()).filter(Boolean)
            : undefined;

        const existingById = incomingId
            ? await dbGetAsync('SELECT * FROM users WHERE id = ? LIMIT 1', [incomingId])
            : null;
        const existingByEmail =
            !existingById && incomingEmail
                ? await dbGetAsync('SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1', [incomingEmail])
                : null;
        const existingBySource =
            !existingById && !existingByEmail && incomingSourceId
                ? await dbGetAsync('SELECT * FROM users WHERE source_id = ? LIMIT 1', [incomingSourceId])
                : null;

        const existing = existingById || existingByEmail || existingBySource;

        const finalId = existing?.id || incomingId;
        const finalSourceId = incomingSourceId || String(existing?.source_id || '').trim();
        const finalEmail = incomingEmail || String(existing?.email || '').trim().toLowerCase();
        const finalName = incomingName || String(existing?.name || '').trim();
        const finalRole = sanitizeRoleValue(incomingRole || existing?.role || 'AGENT');
        const finalPassword = incomingPassword !== undefined ? incomingPassword : String(existing?.password || '').trim();
        const finalAvatar = incomingAvatar || String(existing?.avatar_url || '').trim() || defaultAvatar;
        const finalIsAiAssistant =
            incomingIsAiAssistant !== undefined
                ? incomingIsAiAssistant
                : normalizeBoolean(existing?.is_ai_assistant, false);
        const finalAiAllowedSitesRaw =
            incomingAiAllowedSites !== undefined
                ? incomingAiAllowedSites
                : parseJsonArray(existing?.ai_allowed_sites_json)
                      .map((site) => String(site || '').trim())
                      .filter(Boolean);
        const finalAiAllowedSites = Array.from(new Set(finalAiAllowedSitesRaw)).slice(0, 40);
        const finalAiAllowedSitesJson = finalAiAllowedSites.length > 0 ? JSON.stringify(finalAiAllowedSites) : null;

        if (!finalEmail || !finalName) {
            throw new Error('Nome e email sao obrigatorios para guardar funcionario localmente.');
        }

        const duplicateByEmail = await dbGetAsync(
            `SELECT id, name
             FROM users
             WHERE lower(email) = lower(?)
               AND id <> ?
             LIMIT 1`,
            [finalEmail, finalId]
        );
        if (duplicateByEmail?.id) {
            const duplicateName = String(duplicateByEmail.name || '').trim() || String(duplicateByEmail.id || '').trim();
            throw new Error(`Ja existe funcionario com este email (${finalEmail}) na ficha "${duplicateName}".`);
        }

        await dbRunAsync(
            `INSERT INTO users (id, source_id, name, email, role, password, avatar_url, is_ai_assistant, ai_allowed_sites_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
               source_id = excluded.source_id,
               name = excluded.name,
               email = excluded.email,
               role = excluded.role,
               password = excluded.password,
               avatar_url = excluded.avatar_url,
               is_ai_assistant = excluded.is_ai_assistant,
               ai_allowed_sites_json = excluded.ai_allowed_sites_json,
               updated_at = CURRENT_TIMESTAMP`,
            [
                finalId,
                finalSourceId || null,
                finalName,
                finalEmail,
                finalRole,
                finalPassword,
                finalAvatar,
                finalIsAiAssistant ? 1 : 0,
                finalAiAllowedSitesJson,
            ]
        );

        const savedRow = await dbGetAsync('SELECT * FROM users WHERE id = ? LIMIT 1', [finalId]);
        return normalizeLocalSqlUser(savedRow);
    }

    function mergeUsersWithLocalOverrides(sourceUsers, localUsers) {
        if (!Array.isArray(sourceUsers) || sourceUsers.length === 0) {
            return Array.isArray(localUsers) ? [...localUsers] : [];
        }
        if (!Array.isArray(localUsers) || localUsers.length === 0) {
            return [...sourceUsers];
        }

        const merged = [];
        const usedLocalIndexes = new Set();

        sourceUsers.forEach((sourceUser) => {
            const sourceEmail = String(sourceUser.email || '').toLowerCase();
            const localIndex = localUsers.findIndex((localUser, idx) => {
                if (usedLocalIndexes.has(idx)) return false;
                if (localUser.id === sourceUser.id) return true;
                return !!sourceEmail && String(localUser.email || '').toLowerCase() === sourceEmail;
            });

            if (localIndex >= 0) {
                usedLocalIndexes.add(localIndex);
                merged.push({
                    ...sourceUser,
                    ...localUsers[localIndex],
                    id: sourceUser.id,
                });
                return;
            }

            merged.push(sourceUser);
        });

        localUsers.forEach((localUser, idx) => {
            if (usedLocalIndexes.has(idx)) return;
            const exists = merged.some((user) => {
                if (user.id === localUser.id) return true;
                return String(user.email || '').toLowerCase() === String(localUser.email || '').toLowerCase();
            });
            if (!exists) merged.push(localUser);
        });

        return merged;
    }

    return {
        normalizeLocalSqlUser,
        sanitizeRoleValue,
        parseSourceId,
        getAllLocalUsers,
        upsertLocalUser,
        mergeUsersWithLocalOverrides,
    };
}

module.exports = {
    createUserRepository,
};
