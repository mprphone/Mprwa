const firebaseAdmin = require('firebase-admin');

function toBool(value, defaultValue = false) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return defaultValue;
    if (['1', 'true', 'yes', 'on', 'sim'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off', 'nao', 'não'].includes(raw)) return false;
    return defaultValue;
}

function parseServiceAccountFromEnv() {
    const rawJson = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (rawJson) {
        try {
            return JSON.parse(rawJson);
        } catch (_) {
            return null;
        }
    }

    const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
    const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
    const privateKeyRaw = String(process.env.FIREBASE_PRIVATE_KEY || '').trim();
    const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) return null;
    return {
        projectId,
        clientEmail,
        privateKey,
    };
}

function createMobilePushService({ dbAllAsync, dbRunAsync, logChatCore }) {
    let initialized = false;
    let enabled = false;

    function initIfNeeded() {
        if (initialized) return enabled;
        initialized = true;

        const explicitEnabled = toBool(process.env.FIREBASE_PUSH_ENABLED, true);
        const serviceAccount = parseServiceAccountFromEnv();
        if (!explicitEnabled || !serviceAccount) {
            enabled = false;
            return false;
        }

        try {
            if (!firebaseAdmin.apps.length) {
                firebaseAdmin.initializeApp({
                    credential: firebaseAdmin.credential.cert(serviceAccount),
                });
            }
            enabled = true;
            return true;
        } catch (error) {
            enabled = false;
            console.warn('[MobilePush] Falha ao iniciar Firebase Admin:', error?.message || error);
            return false;
        }
    }

    async function fetchActiveTokens(limit = 3000) {
        const rows = await dbAllAsync(
            `SELECT token
             FROM mobile_push_devices
             WHERE is_active = 1
               AND token <> ''
             ORDER BY datetime(last_seen_at) DESC
             LIMIT ?`,
            [Math.max(1, Number(limit) || 3000)]
        );
        return (rows || [])
            .map((row) => String(row?.token || '').trim())
            .filter(Boolean);
    }

    async function deactivateToken(token) {
        const cleanToken = String(token || '').trim();
        if (!cleanToken) return;
        await dbRunAsync(
            `UPDATE mobile_push_devices
             SET is_active = 0, updated_at = CURRENT_TIMESTAMP
             WHERE token = ?`,
            [cleanToken]
        );
    }

    async function sendNotificationToActiveDevices({ title, body, data }) {
        if (!initIfNeeded()) {
            return { success: false, skipped: true, reason: 'firebase_not_configured' };
        }

        const tokens = await fetchActiveTokens();
        if (tokens.length === 0) {
            return { success: true, skipped: true, reason: 'no_active_tokens' };
        }

        const payload = {
            notification: {
                title: String(title || 'WA PRO'),
                body: String(body || '').slice(0, 240),
            },
            data: Object.entries(data || {}).reduce((acc, [key, value]) => {
                acc[String(key)] = String(value ?? '');
                return acc;
            }, {}),
            tokens,
            android: {
                priority: 'high',
                notification: {
                    channelId: 'wa_messages',
                    clickAction: 'OPEN_INBOX',
                    sound: 'default',
                },
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                        badge: 1,
                    },
                },
            },
        };

        const response = await firebaseAdmin.messaging().sendEachForMulticast(payload);
        let invalidCount = 0;
        for (let i = 0; i < response.responses.length; i += 1) {
            const item = response.responses[i];
            if (item?.success) continue;
            const code = String(item?.error?.code || '').trim();
            if (
                code === 'messaging/registration-token-not-registered' ||
                code === 'messaging/invalid-registration-token'
            ) {
                invalidCount += 1;
                // eslint-disable-next-line no-await-in-loop
                await deactivateToken(tokens[i]);
            }
        }

        logChatCore?.('mobile_push_dispatch', {
            attempted: tokens.length,
            successCount: response.successCount,
            failureCount: response.failureCount,
            invalidCount,
            title: String(title || '').slice(0, 80),
        });

        return {
            success: response.failureCount === 0,
            attempted: tokens.length,
            successCount: response.successCount,
            failureCount: response.failureCount,
            invalidCount,
        };
    }

    async function sendInboundMessageNotification({ from, preview, conversationId }) {
        const fromLabel = String(from || '').trim() || 'Cliente';
        const shortPreview = String(preview || '').trim();
        const body = shortPreview
            ? `${fromLabel}: ${shortPreview.slice(0, 140)}`
            : `${fromLabel} enviou uma nova mensagem.`;

        return sendNotificationToActiveDevices({
            title: 'Nova mensagem WhatsApp',
            body,
            data: {
                type: 'chat_message',
                route: '/inbox',
                conversationId: String(conversationId || ''),
                from: fromLabel,
            },
        });
    }

    return {
        isEnabled: () => initIfNeeded(),
        sendNotificationToActiveDevices,
        sendInboundMessageNotification,
    };
}

module.exports = {
    createMobilePushService,
};
