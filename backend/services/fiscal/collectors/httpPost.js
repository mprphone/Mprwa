'use strict';

const http = require('http');

function postLocalJson(port, path, bodyObj, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(bodyObj || {});
        const req = http.request({
            hostname: '127.0.0.1',
            port: Number(port || process.env.PORT || 3000),
            path,
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let payload = {};
                try { payload = raw ? JSON.parse(raw) : {}; } catch (_) { payload = { raw }; }
                resolve({ statusCode: res.statusCode || 0, payload });
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

module.exports = { postLocalJson };
