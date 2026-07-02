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

    app.get('/api/import/supabase', async (_req, res) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

        const warnings = [];
        let localUsers = [];
        let localCustomers = [];

        try {
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

            // WA PRO é a única fonte de verdade. Supabase recebe dados DAQUI, nunca o contrário.
            // Não fazemos fetch ao Supabase no arranque — usamos apenas o SQLite local.
            const normalizedUsersPayload = normalizeUsers([]);
            const normalizedUsersRaw = mergeUsersWithLocalOverrides(normalizedUsersPayload.users, localUsers);
            const normalizedUsers = dedupeUsersByEmail(
                normalizedUsersRaw.filter((user) => !isInternalChatPlaceholderUser(user))
            );
            const normalizedCustomers = mergeCustomersWithLocalOverrides([], localCustomers);

            if (!normalizedUsers.length && !normalizedCustomers.length) {
                return res.status(502).json({
                    success: false,
                    error: 'Sem dados disponíveis no SQLite local.',
                    warnings,
                });
            }

            return res.json({
                success: true,
                warnings,
                users: normalizedUsers,
                customers: normalizedCustomers,
                source: {
                    localUsers: localUsers.length,
                    localCustomers: localCustomers.length,
                },
            });
        } catch (err) {
            throw err;
        }
    });
}

module.exports = {
    registerImportRoutes,
};
