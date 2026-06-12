'use strict';

const {
    findFirstVisibleSelector,
    clickContinueLoginIf2faPrompt,
    clickCookieConsentIfPresent,
    openSegSocialLoginEntryIfNeeded,
    ensureSegSocialCredentialsFormVisible,
    clickContinueWithoutActivatingIfPrompt,
} = require('../../shared/playwrightHelpers');
const {
    fillSegSocialCredential,
    clickSegSocialCredentialSubmit,
    clickSegSocialActivate2faIfRequired,
    completeSegSocialEmailCodeIfPresent,
    handleSegSocialEmailTwoFactor,
} = require('../../shared/ssLoginHelpers');

/**
 * Performs the Segurança Social Direta login flow on an already-created page.
 *
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {string} opts.loginUrl
 * @param {string} [opts.targetUrl]
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {string[]} opts.usernameSelectors
 * @param {string[]} opts.passwordSelectors
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ loginState: string }>}
 */
async function loginToSegSocial(page, opts = {}) {
    const {
        loginUrl, targetUrl,
        username, password,
        usernameSelectors, passwordSelectors,
        timeoutMs = 90000,
    } = opts;

    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await clickCookieConsentIfPresent(page, 2500);
    await openSegSocialLoginEntryIfNeeded(page, Math.min(12000, timeoutMs));
    await ensureSegSocialCredentialsFormVisible(page, Math.min(12000, timeoutMs));

    const usernameSelector = await findFirstVisibleSelector(page, usernameSelectors);
    const passwordSelector = await findFirstVisibleSelector(page, passwordSelectors);
    console.error('[SS Login] url após abrir form:', page.url());
    console.error('[SS Login] username selector encontrado:', usernameSelector || 'NÃO ENCONTRADO');
    console.error('[SS Login] password selector encontrado:', passwordSelector || 'NÃO ENCONTRADO');

    if (!usernameSelector || !passwordSelector) {
        throw new Error('Não foi possível localizar os campos de login da SS Direta. Verifique os seletores configurados.');
    }

    await fillSegSocialCredential(page, usernameSelector, username);
    await fillSegSocialCredential(page, passwordSelector, password);

    // sinceIso 2 minutos antes — emails SS chegam com atraso e podem chegar ao mesmo segundo do login
    const twoFaSinceIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    console.error('[SS Login] a submeter formulário...');
    await clickSegSocialCredentialSubmit(page, passwordSelector);
    await page.waitForLoadState('networkidle', { timeout: Math.min(30000, timeoutMs) }).catch(() => null);
    await page.waitForTimeout(800);
    console.error('[SS Login] url após submit:', page.url());
    console.error('[SS Login] title após submit:', await page.title().catch(() => ''));
    console.error('[SS Login] texto da página:', (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).replace(/\s+/g, ' ').slice(0, 400));

    // Detetar "Acesso Bloqueado" — a SS bloqueia após muitas tentativas falhadas
    const pageBodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (/acesso\s+bloqueado/i.test(pageBodyText)) {
        console.error('[SS Login] Acesso Bloqueado pela SS Direta. URL:', page.url());
        throw new Error('Acesso Bloqueado pela Segurança Social Direta. A conta foi bloqueada por demasiadas tentativas. Aguarde e tente mais tarde ou desbloqueie manualmente no portal.');
    }

    // Se ainda está na página de login após o submit, o login falhou (credenciais erradas,
    // sessão anterior conflituosa, etc.) — falhar imediatamente em vez de ficar em loop nos 2FA.
    const urlAfterSubmit = page.url();
    const stillOnLoginPage = /\/sso\/login|\/login/i.test(urlAfterSubmit);
    const hasPasswordInputAfterSubmit = (await page.locator('input[type="password"]').count()) > 0;
    if (stillOnLoginPage && hasPasswordInputAfterSubmit) {
        console.error('[SS Login] Login falhou — ainda na página de login após submit. URL:', urlAfterSubmit);
        throw new Error('Login SS falhou: credenciais rejeitadas ou sessão anterior conflituosa. Verifique utilizador/senha e tente novamente.');
    }

    await clickSegSocialActivate2faIfRequired(page, Math.min(30000, timeoutMs));
    await completeSegSocialEmailCodeIfPresent(page, twoFaSinceIso, 120000); // 2min — email pode demorar
    await clickContinueLoginIf2faPrompt(page, Math.min(12000, timeoutMs));
    await handleSegSocialEmailTwoFactor(page, twoFaSinceIso, 120000); // 2min
    await clickSegSocialActivate2faIfRequired(page, Math.min(15000, timeoutMs));
    await completeSegSocialEmailCodeIfPresent(page, twoFaSinceIso, 90000);
    await clickContinueWithoutActivatingIfPrompt(page, Math.min(18000, timeoutMs));

    if (targetUrl) {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
    }

    return { loginState: 'logged_in' };
}

module.exports = { loginToSegSocial };
