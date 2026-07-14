import http from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createApp, getUnsafeRequestTargetReason } = require('../../src/app');

describe('request target security', () => {
    let server;
    let port;

    beforeAll(async () => {
        const { app } = createApp();
        app.get('/', (_req, res) => res.json({ success: true }));
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    });

    afterAll(async () => {
        if (!server) return;
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });

    function requestRawPath(path) {
        return new Promise((resolve, reject) => {
            const request = http.request({ host: '127.0.0.1', port, path }, (response) => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { body += chunk; });
                response.on('end', () => resolve({ status: response.statusCode, body }));
            });
            request.on('error', reject);
            request.end();
        });
    }

    it('classifies malformed UTF-8 path encodings', () => {
        expect(getUnsafeRequestTargetReason('/..%c0%af..%c0%afetc/passwd')).toBe('malformed_encoding');
    });

    it('classifies encoded path traversal', () => {
        expect(getUnsafeRequestTargetReason('/safe/%2e%2e/%2e%2e/etc/passwd')).toBe('path_traversal');
    });

    it('allows normal paths and encoded query values', () => {
        expect(getUnsafeRequestTargetReason('/api/customers?name=Jos%C3%A9')).toBeNull();
    });

    it('returns a small 400 response without a stack trace', async () => {
        const response = await requestRawPath('/..%c0%af..%c0%afetc/passwd');
        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ success: false, error: 'URL inválida.' });
        expect(response.body).not.toContain('URIError');
    });
});
