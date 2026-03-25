const express = require('express');
const bodyParser = require('body-parser');

function createApp() {
    const app = express();
    app.use(bodyParser.json({ limit: '25mb' }));
    return { app, express };
}

module.exports = {
    createApp,
};
