'use strict';

const fs = require('fs');
const path = require('path');
const { safeFilePart } = require('../documents/documentNamingService');

async function saveScreenshot(page, customer, label = 'screenshot') {
    try {
        const dir = path.resolve(
            process.env.LOCAL_DOCS_ROOT || path.join(process.cwd(), 'customer_documents'),
            '_fiscal_diagnostics'
        );
        fs.mkdirSync(dir, { recursive: true });
        const nif = safeFilePart(customer?.nif || customer?.id || 'cliente');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${safeFilePart(label)}_${nif}_${stamp}.png`;
        const targetPath = path.join(dir, filename);
        await page.screenshot({ path: targetPath, fullPage: false });
        return targetPath;
    } catch (_) {
        return '';
    }
}

module.exports = { saveScreenshot };
