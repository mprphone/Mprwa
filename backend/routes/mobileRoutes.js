function registerMobileRoutes(deps) {
    const {
        app,
        dbRunAsync,
        dbAllAsync,
        sendMobilePushNotification,
    } = deps;

    if (!app || typeof app.post !== 'function') {
        throw new Error('registerMobileRoutes: app inválida');
    }

    app.post('/api/mobile/push/register', async (req, res) => {
        const body = req.body || {};
        const token = String(body.token || '').trim();
        if (!token) {
            return res.status(400).json({ success: false, error: 'token é obrigatório.' });
        }

        const platform = String(body.platform || '').trim().toLowerCase() || null;
        const deviceId = String(body.deviceId || '').trim() || null;
        const deviceModel = String(body.deviceModel || '').trim() || null;
        const osVersion = String(body.osVersion || '').trim() || null;
        const appVersion = String(body.appVersion || '').trim() || null;
        const userId = String(body.userId || '').trim() || null;
        const metadata = body && typeof body.metadata === 'object' ? body.metadata : null;
        const metadataJson = metadata ? JSON.stringify(metadata) : null;

        try {
            await dbRunAsync(
                `INSERT INTO mobile_push_devices (
                    token, platform, device_id, device_model, os_version, app_version, user_id, is_active, metadata_json, last_seen_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT(token) DO UPDATE SET
                    platform = excluded.platform,
                    device_id = excluded.device_id,
                    device_model = excluded.device_model,
                    os_version = excluded.os_version,
                    app_version = excluded.app_version,
                    user_id = excluded.user_id,
                    is_active = 1,
                    metadata_json = excluded.metadata_json,
                    last_seen_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP`,
                [token, platform, deviceId, deviceModel, osVersion, appVersion, userId, metadataJson]
            );

            return res.json({ success: true });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: error?.message || error,
            });
        }
    });

    app.post('/api/mobile/push/unregister', async (req, res) => {
        const token = String(req.body?.token || '').trim();
        if (!token) {
            return res.status(400).json({ success: false, error: 'token é obrigatório.' });
        }

        try {
            await dbRunAsync(
                `UPDATE mobile_push_devices
                 SET is_active = 0, updated_at = CURRENT_TIMESTAMP
                 WHERE token = ?`,
                [token]
            );
            return res.json({ success: true });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: error?.message || error,
            });
        }
    });

    app.get('/api/mobile/push/devices', async (req, res) => {
        const userId = String(req.query?.userId || '').trim();
        const onlyActiveRaw = String(req.query?.active || '1').trim().toLowerCase();
        const onlyActive = !['0', 'false', 'no', 'off', 'nao', 'não'].includes(onlyActiveRaw);

        try {
            const whereParts = [];
            const params = [];

            if (onlyActive) {
                whereParts.push('is_active = 1');
            }

            if (userId) {
                whereParts.push('user_id = ?');
                params.push(userId);
            }

            const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
            const rows = await dbAllAsync(
                `SELECT id, token, platform, device_id as deviceId, device_model as deviceModel, os_version as osVersion,
                        app_version as appVersion, user_id as userId, is_active as isActive, last_seen_at as lastSeenAt,
                        created_at as createdAt, updated_at as updatedAt
                 FROM mobile_push_devices
                 ${whereSql}
                 ORDER BY datetime(last_seen_at) DESC`,
                params
            );
            return res.json({ success: true, data: rows || [] });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: error?.message || error,
            });
        }
    });

    app.post('/api/mobile/push/test', async (req, res) => {
        const title = String(req.body?.title || 'Teste WA PRO').trim() || 'Teste WA PRO';
        const body = String(req.body?.body || 'Notificação de teste enviada pelo backend.').trim();
        const route = String(req.body?.route || '/inbox').trim() || '/inbox';

        if (typeof sendMobilePushNotification !== 'function') {
            return res.status(503).json({
                success: false,
                error: 'Serviço de push não disponível neste ambiente.',
            });
        }

        try {
            const result = await sendMobilePushNotification({
                title,
                body,
                data: {
                    type: 'manual_test',
                    route,
                },
            });
            return res.json({ success: true, result });
        } catch (error) {
            return res.status(500).json({
                success: false,
                error: error?.message || error,
            });
        }
    });
}

module.exports = {
    registerMobileRoutes,
};
