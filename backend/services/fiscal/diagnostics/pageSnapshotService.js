'use strict';

const { cleanText } = require('../shared/textHelpers');

async function capturePageSnapshot(page) {
    try {
        const url = page.url();
        const bodyText = cleanText(await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 600);
        const buttons = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"]'))
                .filter((el) => el.offsetParent !== null)
                .slice(0, 10)
                .map((el) => String(el.innerText || el.value || el.getAttribute('aria-label') || '').trim())
                .filter(Boolean);
        }).catch(() => []);
        const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href]'))
                .filter((el) => el.offsetParent !== null)
                .slice(0, 10)
                .map((el) => ({ text: String(el.innerText || '').trim(), href: String(el.getAttribute('href') || '').trim() }))
                .filter((item) => item.text || item.href);
        }).catch(() => []);
        return { url, text: bodyText, buttons, links };
    } catch (_) {
        return { url: '', text: '', buttons: [], links: [] };
    }
}

module.exports = { capturePageSnapshot };
