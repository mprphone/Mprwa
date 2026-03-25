function registerImportRoutes(context) {
    const {
        app,
        SUPABASE_URL,
        SUPABASE_KEY,
        SUPABASE_FUNCIONARIOS_SOURCE,
        SUPABASE_CLIENTS_SOURCE,
        getAllLocalUsers,
        getAllLocalCustomers,
        fetchSupabaseTable,
        normalizeUsers,
        normalizeCustomers,
        mergeUsersWithLocalOverrides,
        mergeCustomersWithLocalOverrides,
    } = context;

    function isInternalChatPlaceholderUser(user) {
        if (!user || typeof user !== 'object') return false;
        const id = String(user.id || '').trim().toLowerCase();
        const name = String(user.name || '').trim();
        const email = String(user.email || '').trim().toLowerCase();
        if (!id && !name && !email) return false;
        if (email.endsWith('@sync.local')) return true;
        if (email.endsWith('@local.invalid') && id.startsWith('ext_u_')) return true;
        return /^Funcion[aá]rio\s+[a-f0-9]{6,}/i.test(name);
    }

    function dedupeUsersByEmail(users) {
        if (!Array.isArray(users) || users.length === 0) return [];
        const byEmail = new Map();
        const withoutEmail = [];

        users.forEach((user) => {
            const email = String(user?.email || '').trim().toLowerCase();
            if (!email) {
                withoutEmail.push(user);
                return;
            }
            if (!byEmail.has(email)) {
                byEmail.set(email, user);
                return;
            }

            const existing = byEmail.get(email) || {};
            const existingRole = String(existing.role || '').trim().toUpperCase();
            const incomingRole = String(user?.role || '').trim().toUpperCase();
            const existingId = String(existing.id || '').trim();
            const incomingId = String(user?.id || '').trim();

            const existingScore =
                (existingRole === 'ADMIN' ? 100 : 0) +
                (existingId.startsWith('ext_u_') ? 20 : 0) +
                (existingId.startsWith('local_') ? 0 : 5);
            const incomingScore =
                (incomingRole === 'ADMIN' ? 100 : 0) +
                (incomingId.startsWith('ext_u_') ? 20 : 0) +
                (incomingId.startsWith('local_') ? 0 : 5);
            if (incomingScore > existingScore) {
                byEmail.set(email, user);
            }
        });

        const combined = [...byEmail.values(), ...withoutEmail];
        const seenIds = new Set();
        return combined.filter((user) => {
            const id = String(user?.id || '').trim();
            if (!id) return false;
            if (seenIds.has(id)) return false;
            seenIds.add(id);
            return true;
        });
    }

    app.get('/api/import/supabase', async (req, res) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        const warnings = [];
        let localUsers = [];
        let localCustomers = [];
        let sourceUsers = [];
        let sourceCustomers = [];

        try {
            localUsers = await getAllLocalUsers();
        } catch (error) {
            warnings.push('Falha a carregar funcionários locais do SQLite.');
            console.error('[SQLite] Erro users:', error?.message || error);
        }

        try {
            localCustomers = await getAllLocalCustomers();
        } catch (error) {
            warnings.push('Falha a carregar clientes locais do SQLite.');
            console.error('[SQLite] Erro customers:', error?.message || error);
        }

        if (SUPABASE_URL && SUPABASE_KEY) {
            const [usersResult, customersResult] = await Promise.allSettled([
                fetchSupabaseTable(SUPABASE_FUNCIONARIOS_SOURCE),
                fetchSupabaseTable(SUPABASE_CLIENTS_SOURCE),
            ]);

            if (usersResult.status === 'fulfilled') {
                sourceUsers = usersResult.value;
            } else {
                warnings.push(`Falha a importar funcionários (${SUPABASE_FUNCIONARIOS_SOURCE}).`);
                console.error('[Supabase] Erro funcionários:', usersResult.reason?.message || usersResult.reason);
            }

            if (customersResult.status === 'fulfilled') {
                sourceCustomers = customersResult.value;
            } else {
                warnings.push(`Falha a importar clientes (${SUPABASE_CLIENTS_SOURCE}).`);
                console.error('[Supabase] Erro clientes:', customersResult.reason?.message || customersResult.reason);
            }
        } else {
            warnings.push('Supabase não configurado. A usar apenas dados locais (SQLite).');
        }

        const normalizedUsersPayload = normalizeUsers(sourceUsers);
        const normalizedCustomersSupabase = normalizeCustomers(sourceCustomers, normalizedUsersPayload);
        const normalizedUsersRaw = mergeUsersWithLocalOverrides(normalizedUsersPayload.users, localUsers);
        const normalizedUsers = dedupeUsersByEmail(
            normalizedUsersRaw.filter((user) => !isInternalChatPlaceholderUser(user))
        );
        const normalizedCustomers = mergeCustomersWithLocalOverrides(normalizedCustomersSupabase, localCustomers);

        if (!normalizedUsers.length && !normalizedCustomers.length) {
            return res.status(502).json({
                success: false,
                error: 'Sem dados disponíveis (nem Supabase nem SQLite local).',
                warnings,
            });
        }

        console.log(
            `[Import] Funcionários: ${normalizedUsers.length}/${normalizedUsersRaw.length} (local=${localUsers.length}) | Clientes: ${normalizedCustomers.length} (local=${localCustomers.length})`
        );

        return res.json({
            success: true,
            warnings,
            users: normalizedUsers,
            customers: normalizedCustomers,
            source: {
                usersTable: SUPABASE_FUNCIONARIOS_SOURCE,
                customersTable: SUPABASE_CLIENTS_SOURCE,
                localUsers: localUsers.length,
                localCustomers: localCustomers.length,
            },
        });
    });
}

module.exports = {
    registerImportRoutes,
};
