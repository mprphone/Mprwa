'use strict';

async function fillSegSocialCredential(page, selector, value) {
    const locator = page.locator(selector).first();
    await locator.click({ timeout: 5000 }).catch(() => null);
    await locator.fill('', { timeout: 3000 }).catch(() => null);
    await locator.fill(String(value || ''), { timeout: 5000 });
}

async function clickSegSocialCredentialSubmit(page, passwordSelector) {
    // Um único submit: tenta o botão "Entrar" visível; se não encontrar, usa Enter no campo password.
    // Não repetir cliques nem disparar múltiplos eventos — a SS bloqueia por excesso de submits.
    const submitSelectors = [
        () => page.locator('button').filter({ hasText: /^Entrar$/i }).first(),
        () => page.locator('button').filter({ hasText: /entrar/i }).first(),
        () => page.getByRole('button', { name: /entrar|iniciar\s+sess[aã]o|autenticar/i }).first(),
        () => page.locator('button[type="submit"]').first(),
        () => page.locator('input[type="submit"]').first(),
    ];
    let submitted = false;
    for (const buildLocator of submitSelectors) {
        try {
            const locator = buildLocator();
            if ((await locator.count()) <= 0) continue;
            const visible = await locator.isVisible().catch(() => false);
            if (!visible) continue;
            await locator.click({ timeout: 4000 });
            submitted = true;
            break;
        } catch { /* continua para o próximo seletor */ }
    }
    if (!submitted) {
        // Fallback: Enter direto no campo de password
        await page.locator(passwordSelector).first().press('Enter', { timeout: 3000 }).catch(() => null);
    }
    return true;
}

async function clickSegSocialActivate2faIfRequired(page, timeoutMs = 15000) {
    const safeTimeout = Math.max(1500, Number(timeoutMs) || 15000);
    const deadline = Date.now() + safeTimeout;
    const activateSelectors = [
        () => page.getByRole('button', { name: /ativar\s+autentica[cç][aã]o\s+de\s+dois\s+fatores/i }).first(),
        () => page.locator('button', { hasText: /ativar\s+autentica[cç][aã]o\s+de\s+dois\s+fatores/i }).first(),
        () => page.locator('button', { hasText: /ativar\s+2fa/i }).first(),
        () => page.getByRole('button', { name: /enviar\s+c[oó]digo/i }).first(),
        () => page.locator('button', { hasText: /enviar\s+c[oó]digo/i }).first(),
    ];
    while (Date.now() < deadline) {
        for (const buildLocator of activateSelectors) {
            try {
                const locator = buildLocator();
                if ((await locator.count()) <= 0) continue;
                const visible = await locator.isVisible().catch(() => false);
                if (!visible) continue;
                await locator.click({ timeout: 3000 });
                await page.waitForTimeout(600);
                return true;
            } catch { /* continue */ }
        }
        await page.waitForTimeout(300);
    }
    return false;
}

function fetchEmailCodeFromLocal(sinceIso) {
    return new Promise((resolve) => {
        const http = require('http');
        const port = Number(process.env.PORT || 3010);
        const qs = `sinceIso=${encodeURIComponent(sinceIso || '')}&verificationOnly=true`;
        const req = http.get(
            { hostname: '127.0.0.1', port, path: `/api/email/seg-social/latest-code?${qs}` },
            (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(data)?.result?.code || null); }
                    catch { resolve(null); }
                });
            }
        );
        req.on('error', () => resolve(null));
        req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    });
}

async function completeSegSocialEmailCodeIfPresent(page, sinceIso, timeoutMs = 45000) {
    const check1 = await page.locator('text=/c[oó]digo de verifica[cç][aã]o/i').isVisible({ timeout: 3000 }).catch(() => false);
    const check2 = await page.locator('text=/autentica[cç][aã]o de dois fatores/i').isVisible({ timeout: 1000 }).catch(() => false);
    const check3 = await page.locator('input[autocomplete="one-time-code"]').isVisible({ timeout: 1000 }).catch(() => false);
    const is2FaPage = check1 || check2 || check3;
    console.error('[SS 2FA] is2FaPage:', is2FaPage, '| checks:', check1, check2, check3, '| url:', page.url());
    if (!is2FaPage) return false;

    const deadline = Date.now() + Math.max(10000, Number(timeoutMs) || 45000);
    let code = null;
    while (Date.now() < deadline && !code) {
        code = await fetchEmailCodeFromLocal(sinceIso);
        console.error('[SS 2FA] fetchEmailCode result:', code, '| sinceIso:', sinceIso);
        if (!code) await page.waitForTimeout(3000);
    }
    if (!code) { console.error('[SS 2FA] timeout — código não encontrado'); return false; }

    // Preencher o campo do código (múltiplos seletores como o Electron usa)
    const codeInput = page.locator([
        'input[autocomplete="one-time-code"]',
        'input[inputmode="numeric"]',
        'input[type="tel"]',
        'input[name*="codigo" i]',
        'input[id*="codigo" i]',
        'input[placeholder*="código" i]',
        'input[type="text"]',
        'input[type="number"]',
        'input:not([type])',
    ].join(', ')).first();
    if (await codeInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await codeInput.fill(String(code));
        await page.waitForTimeout(300);
    }

    // Clicar no botão de confirmação com fallback via evaluate() (como Electron)
    const btnClicked = await page.evaluate((codeVal) => {
        const normalize = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
        const pattern = /confirmar|validar|confirmar codigo|autenticar/i;
        const isVisible = (el) => { const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el); return r.width > 5 && r.height > 5 && s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled; };
        const btn = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]'))
            .find((el) => isVisible(el) && pattern.test(normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '')));
        if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
        // Fallback: submeter o form que contém o código
        const input = document.querySelector('input[inputmode="numeric"], input[type="tel"], input[name*="codigo" i], input[type="text"]');
        const form = input?.closest('form');
        if (form) { try { form.requestSubmit(); return true; } catch (_) { form.submit(); return true; } }
        return false;
    }, code).catch(() => false);
    console.error('[SS 2FA] confirmBtn clicked via evaluate:', btnClicked);

    await Promise.allSettled([
        page.waitForLoadState('networkidle', { timeout: 30000 }),
        page.waitForTimeout(500),
    ]).catch(() => null);
    return true;
}

async function handleSegSocialEmailTwoFactor(page, sinceIso, timeoutMs = 60000) {
    const is2FaPage = await page.locator('text=/c[oó]digo de verifica[cç][aã]o/i').isVisible({ timeout: 4000 }).catch(() => false)
        || await page.locator('text=/autentica[cç][aã]o de dois fatores/i').isVisible({ timeout: 1000 }).catch(() => false);
    if (!is2FaPage) return false;

    const deadline = Date.now() + Math.max(15000, Number(timeoutMs) || 60000);
    let code = null;
    while (Date.now() < deadline && !code) {
        code = await fetchEmailCodeFromLocal(sinceIso);
        if (!code) await page.waitForTimeout(3000);
    }

    if (!code) {
        console.warn('[SS 2FA] Nenhum código de verificação recebido por email antes do timeout.');
        return false;
    }

    const codeInput = page.locator('input[type="text"]:visible, input[type="number"]:visible, input:not([type]):visible').first();
    if (await codeInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await codeInput.fill(String(code));
    }

    const confirmBtn = page.locator('button:has-text("Confirmar"), button:has-text("Confirmar código"), button:has-text("Ativar autenticação de dois fatores")').first();
    if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await Promise.allSettled([
            page.waitForLoadState('networkidle', { timeout: 30000 }),
            confirmBtn.click(),
        ]);
    }

    return true;
}

module.exports = {
    fillSegSocialCredential,
    clickSegSocialCredentialSubmit,
    clickSegSocialActivate2faIfRequired,
    completeSegSocialEmailCodeIfPresent,
    handleSegSocialEmailTwoFactor,
};
