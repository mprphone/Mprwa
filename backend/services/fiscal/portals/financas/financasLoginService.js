'use strict';

const { activateFinancasNifTab, findFirstVisibleSelector, clickContinueLoginIf2faPrompt } = require('../../shared/playwrightHelpers');
const { withTimeout } = require('../../shared/textHelpers');

/**
 * Performs the AT/Finanças login flow on an already-created page.
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {string} opts.loginUrl
 * @param {string} [opts.targetUrl]
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {string[]} opts.usernameSelectors
 * @param {string[]} opts.passwordSelectors
 * @param {string[]} opts.submitSelectors
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ loginState: string }>}
 */
async function loginToFinancas(page, opts = {}) {
    const {
        loginUrl, targetUrl,
        username, password,
        usernameSelectors, passwordSelectors, submitSelectors,
        timeoutMs = 90000,
    } = opts;

    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(30000, timeoutMs) });
    await withTimeout(activateFinancasNifTab(page), Math.min(12000, timeoutMs), 'Tempo limite ao ativar separador NIF da AT.');

    const usernameSelector = await findFirstVisibleSelector(page, usernameSelectors);
    const passwordSelector = await findFirstVisibleSelector(page, passwordSelectors);
    const submitSelector = await findFirstVisibleSelector(page, submitSelectors);

    if (!usernameSelector || !passwordSelector || !submitSelector) {
        throw new Error('Não foi possível localizar os campos de login da AT. Verifique os seletores configurados.');
    }

    await page.fill(usernameSelector, username);
    await page.fill(passwordSelector, password);

    await Promise.allSettled([
        page.waitForLoadState('networkidle', { timeout: Math.min(30000, timeoutMs) }),
        page.locator(submitSelector).first().click(),
    ]);

    await clickContinueLoginIf2faPrompt(page, Math.min(12000, timeoutMs));

    if (targetUrl) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
    }

    return { loginState: 'logged_in' };
}

module.exports = { loginToFinancas };
