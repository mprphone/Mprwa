const express = require('express');
const bodyParser = require('body-parser');

function getUnsafeRequestTargetReason(rawUrl) {
    const requestTarget = String(rawUrl || '');

    try {
        // Valida também sequências UTF-8 inválidas, como os overlong encodings
        // usados por scanners para tentar contornar a normalização de caminhos.
        decodeURI(requestTarget);
    } catch (error) {
        if (error instanceof URIError) return 'malformed_encoding';
        throw error;
    }

    const rawPath = requestTarget.split(/[?#]/, 1)[0];
    let decodedPath = '';
    try {
        decodedPath = decodeURIComponent(rawPath).replace(/\\/g, '/');
    } catch (error) {
        if (error instanceof URIError) return 'malformed_encoding';
        throw error;
    }

    if (decodedPath.includes('\0')) return 'null_byte';
    if (decodedPath.split('/').includes('..')) return 'path_traversal';
    return null;
}

function createApp() {
    const app = express();

    // Rejeita alvos malformados antes de body-parser, router e express.static.
    // A resposta curta evita stack traces repetidos no journal sem esconder
    // exceções reais das rotas da aplicação.
    app.use((req, res, next) => {
        const reason = getUnsafeRequestTargetReason(req.originalUrl || req.url);
        if (!reason) return next();
        return res.status(400).json({ success: false, error: 'URL inválida.' });
    });

    app.use(bodyParser.json({ limit: '25mb' }));
    // CORS para permitir chamadas de outros domínios (ex: MPR Control)
    app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key,X-Internal-API-Key');
        if (req.method === 'OPTIONS') { res.status(204).end(); return; }
        next();
    });
    return { app, express };
}

module.exports = {
    createApp,
    getUnsafeRequestTargetReason,
};
