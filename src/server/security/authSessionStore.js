'use strict';

const crypto = require('crypto');

function createAuthSessionStore(options) {
    const {
        dbRunAsync,
        dbGetAsync,
        secret,
        ttlMs,
        now = () => Date.now(),
        cacheTtlMs = 60 * 1000,
        touchIntervalMs = 5 * 60 * 1000,
    } = options;
    const normalizedSecret = String(secret || '').trim();
    if (!normalizedSecret) throw new Error('AUTH_SECRET é obrigatório para sessões persistentes.');

    const cache = new Map();
    const lastTouched = new Map();

    function sign(value) {
        return crypto.createHmac('sha256', normalizedSecret).update(String(value || '')).digest('base64url');
    }

    function safeEqual(left, right) {
        const leftBuffer = Buffer.from(String(left || ''), 'utf8');
        const rightBuffer = Buffer.from(String(right || ''), 'utf8');
        return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
    }

    function hashSessionId(sessionId) {
        return crypto.createHash('sha256').update(String(sessionId || ''), 'utf8').digest('hex');
    }

    function parseToken(rawToken) {
        const token = String(rawToken || '').trim();
        const [version, sessionId, signature] = token.split('.');
        if (version !== 'v2' || !sessionId || !signature) return null;
        const signedValue = `${version}.${sessionId}`;
        if (!safeEqual(sign(signedValue), signature)) return null;
        return { sessionId, tokenHash: hashSessionId(sessionId) };
    }

    function normalizeRow(row) {
        if (!row) return null;
        return {
            userId: String(row.user_id || '').trim(),
            email: String(row.email || '').trim().toLowerCase(),
            role: String(row.role || '').trim(),
            expiresAt: Number(row.expires_at_ms || 0),
        };
    }

    async function cleanup() {
        const cutoff = now() - 24 * 60 * 60 * 1000;
        await dbRunAsync(
            `DELETE FROM auth_sessions
             WHERE expires_at_ms < ?
                OR (revoked_at IS NOT NULL AND CAST(strftime('%s', revoked_at) AS INTEGER) * 1000 < ?)`,
            [now(), cutoff]
        );
    }

    async function create(user) {
        const sessionId = crypto.randomBytes(32).toString('base64url');
        const tokenHash = hashSessionId(sessionId);
        const expiresAt = now() + Number(ttlMs || 0);
        const session = {
            userId: String(user?.id || '').trim(),
            email: String(user?.email || '').trim().toLowerCase(),
            role: String(user?.role || '').trim(),
            expiresAt,
        };
        if (!session.userId || !Number.isFinite(expiresAt) || expiresAt <= now()) {
            throw new Error('Dados inválidos para criar sessão.');
        }
        await dbRunAsync(
            `INSERT INTO auth_sessions (
                token_hash, user_id, email, role, expires_at_ms, created_at, last_seen_at, revoked_at
             ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)`,
            [tokenHash, session.userId, session.email || null, session.role || null, expiresAt]
        );
        cache.set(tokenHash, { session, cachedAt: now() });
        lastTouched.set(tokenHash, now());
        void cleanup().catch(() => undefined);
        const signedValue = `v2.${sessionId}`;
        return { token: `${signedValue}.${sign(signedValue)}`, session: { ...session } };
    }

    async function get(rawToken) {
        const parsed = parseToken(rawToken);
        if (!parsed) return null;
        const currentTime = now();
        const cached = cache.get(parsed.tokenHash);
        if (cached && currentTime - cached.cachedAt <= cacheTtlMs) {
            if (cached.session.expiresAt <= currentTime) {
                cache.delete(parsed.tokenHash);
                return null;
            }
            return { ...cached.session };
        }
        const row = await dbGetAsync(
            `SELECT user_id, email, role, expires_at_ms
             FROM auth_sessions
             WHERE token_hash = ?
               AND revoked_at IS NULL
               AND expires_at_ms > ?
             LIMIT 1`,
            [parsed.tokenHash, currentTime]
        );
        const session = normalizeRow(row);
        if (!session?.userId) {
            cache.delete(parsed.tokenHash);
            return null;
        }
        cache.set(parsed.tokenHash, { session, cachedAt: currentTime });
        const previousTouch = lastTouched.get(parsed.tokenHash) || 0;
        if (currentTime - previousTouch >= touchIntervalMs) {
            lastTouched.set(parsed.tokenHash, currentTime);
            void dbRunAsync(
                `UPDATE auth_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ?`,
                [parsed.tokenHash]
            ).catch(() => undefined);
        }
        return { ...session };
    }

    async function revoke(rawToken) {
        const parsed = parseToken(rawToken);
        if (!parsed) return false;
        cache.delete(parsed.tokenHash);
        lastTouched.delete(parsed.tokenHash);
        const result = await dbRunAsync(
            `UPDATE auth_sessions
             SET revoked_at = CURRENT_TIMESTAMP
             WHERE token_hash = ? AND revoked_at IS NULL`,
            [parsed.tokenHash]
        );
        return Number(result?.changes || 0) > 0;
    }

    return {
        create,
        get,
        revoke,
        cleanup,
        parseToken,
        hashSessionId,
    };
}

module.exports = { createAuthSessionStore };
