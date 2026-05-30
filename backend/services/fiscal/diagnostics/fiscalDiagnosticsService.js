'use strict';

const { capturePageSnapshot } = require('./pageSnapshotService');
const { saveScreenshot } = require('./screenshotService');

async function captureDiagnostics(page, context = {}) {
    const { customer, label = 'diagnostico' } = context;
    const [snapshot, screenshotPath] = await Promise.all([
        capturePageSnapshot(page),
        saveScreenshot(page, customer || {}, label),
    ]);
    return { ...snapshot, screenshotPath };
}

module.exports = { captureDiagnostics };
