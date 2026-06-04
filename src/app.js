const express = require('express');
const bodyParser = require('body-parser');

function createApp() {
    const app = express();
    app.use(bodyParser.json({ limit: '25mb' }));
    // CORS para permitir chamadas de outros domínios (ex: MPR Control)
    app.use((req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-API-Key');
        if (req.method === 'OPTIONS') { res.status(204).end(); return; }
        next();
    });
    return { app, express };
}

module.exports = {
    createApp,
};
