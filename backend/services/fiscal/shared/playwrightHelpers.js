'use strict';

const { cleanText, currentFiscalYear } = require('./textHelpers');

async function findFirstVisibleSelector(page, selectors, options = {}) {
    const waitTimeout = Math.max(500, Number(options?.waitTimeoutMs || 3000) || 3000);
    const maxMatchesPerSelector = Math.max(1, Number(options?.maxMatchesPerSelector || 8) || 8);
    for (const selector of Array.isArray(selectors) ? selectors : []) {
        try {
            const cleanedSelector = String(selector || '').trim();
            if (!cleanedSelector) continue;
            const candidates = page.locator(cleanedSelector);
            const totalMatches = await candidates.count();
            if (totalMatches <= 0) continue;
            const maxCandidates = Math.min(totalMatches, maxMatchesPerSelector);
            for (let index = 0; index < maxCandidates; index += 1) {
                const locator = candidates.nth(index);
                let visible = await locator.isVisible().catch(() => false);
                if (!visible) {
                    const perCandidateWait = totalMatches === 1 ? waitTimeout : Math.min(waitTimeout, 800);
                    await locator.waitFor({ state: 'visible', timeout: perCandidateWait }).catch(() => null);
                    visible = await locator.isVisible().catch(() => false);
                }
                if (!visible) continue;
                return cleanedSelector;
            }
        } catch (_) { /* ignora seletor inválido e tenta o próximo */ }
    }
    return null;
}

async function activateFinancasNifTab(page) {
    const candidates = [
        page.getByRole('tab', { name: /^NIF$/i }),
        page.getByRole('tab', { name: /NIF/i }),
        page.locator('button[role="tab"]', { hasText: /^NIF$/i }),
        page.locator('button[role="tab"]', { hasText: /NIF/i }),
        page.locator('[id$="-trigger-N"]'),
        page.locator('button', { hasText: /^NIF$/i }),
    ];

    const hasNifInputs = async () => {
        const checks = [
            'form[name="loginForm"] input[name="username"]',
            'form[name="loginForm"] input[name="password"]',
            'input[name="username"]',
        ];
        for (const selector of checks) {
            const input = page.locator(selector).first();
            if ((await input.count()) <= 0) continue;
            if (await input.isVisible().catch(() => false)) return true;
        }
        return false;
    };

    if (await hasNifInputs()) return true;

    for (const locator of candidates) {
        let count = 0;
        try { count = await locator.count(); } catch (_) { count = 0; }
        if (count <= 0) continue;

        const maxItems = Math.min(count, 5);
        for (let index = 0; index < maxItems; index += 1) {
            const tab = locator.nth(index);
            try {
                const visible = await tab.isVisible().catch(() => false);
                if (!visible) continue;
                const isSelected = String((await tab.getAttribute('aria-selected')) || '').trim().toLowerCase() === 'true';
                if (!isSelected) {
                    await tab.click({ timeout: 5000 });
                    await page.waitForTimeout(700);
                }
                if (await hasNifInputs()) return true;
            } catch (_) { /* ignora e tenta próximo candidato */ }
        }
    }

    return await hasNifInputs();
}

async function clickContinueLoginIf2faPrompt(page, timeoutMs = 8000) {
    const safeTimeout = Math.max(1000, Number(timeoutMs) || 8000);
    const deadline = Date.now() + safeTimeout;
    const selectors = [
        () => page.getByRole('button', { name: /continuar\s*login/i }).first(),
        () => page.locator('button', { hasText: /continuar\s*login/i }).first(),
        () => page.locator('input[type="submit"][value*="Continuar"]').first(),
        () => page.locator('a', { hasText: /continuar\s*login/i }).first(),
    ];

    while (Date.now() < deadline) {
        for (const buildLocator of selectors) {
            try {
                const locator = buildLocator();
                if ((await locator.count()) <= 0) continue;
                const visible = await locator.isVisible().catch(() => false);
                if (!visible) continue;
                await locator.click({ timeout: 3000 });
                await page.waitForTimeout(700);
                return true;
            } catch (_) { /* ignora e continua até timeout */ }
        }
        await page.waitForTimeout(250);
    }
    return false;
}

async function clickCookieConsentIfPresent(page, timeoutMs = 4000) {
    const safeTimeout = Math.max(500, Number(timeoutMs) || 4000);
    const deadline = Date.now() + safeTimeout;
    const selectors = [
        () => page.getByRole('button', { name: /^concordo$/i }).first(),
        () => page.getByRole('button', { name: /concordo/i }).first(),
        () => page.locator('button', { hasText: /^concordo$/i }).first(),
        () => page.locator('button', { hasText: /concordo/i }).first(),
        () => page.locator('a', { hasText: /^concordo$/i }).first(),
        () => page.locator('a', { hasText: /aceitar/i }).first(),
    ];

    while (Date.now() < deadline) {
        for (const buildLocator of selectors) {
            try {
                const locator = buildLocator();
                if ((await locator.count()) <= 0) continue;
                const visible = await locator.isVisible().catch(() => false);
                if (!visible) continue;
                await locator.click({ timeout: 2000 });
                await page.waitForTimeout(350);
                return true;
            } catch (_) { /* ignora e continua */ }
        }
        await page.waitForTimeout(200);
    }
    return false;
}

async function ensureSegSocialCredentialsFormVisible(page, timeoutMs = 10000) {
    const safeTimeout = Math.max(1000, Number(timeoutMs) || 10000);
    const deadline = Date.now() + safeTimeout;
    const usernameCheckSelectors = [
        'input[name="username"]', 'input[name="niss"]', 'input[id*="username" i]',
        'input[name*="user" i]', 'input[id*="utilizador" i]', 'input[name*="utilizador" i]',
        'input[id*="niss" i]', 'input[placeholder*="NISS" i]', 'input[autocomplete="username"]',
    ];
    const openFormActions = [
        () => page.getByRole('button', { name: /autenticar\s+com\s+utilizador/i }).first(),
        () => page.getByRole('link', { name: /autenticar\s+com\s+utilizador/i }).first(),
        () => page.locator('button', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
        () => page.locator('a', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
        () => page.getByText(/autenticar\s+com\s+utilizador/i).first(),
        () => page.locator('button, a, [role="button"], div, span', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
        () => page.locator('button, a, [role="button"], div, span, p', { hasText: /utilizador\s+da\s+seguran[cç]a\s+social/i }).first(),
        () => page.getByText(/utilizador\s+da\s+seguran[cç]a\s+social/i).first(),
    ];

    while (Date.now() < deadline) {
        const usernameSelector = await findFirstVisibleSelector(page, usernameCheckSelectors);
        if (usernameSelector) return true;

        for (const buildLocator of openFormActions) {
            try {
                const locator = buildLocator();
                if ((await locator.count()) <= 0) continue;
                const visible = await locator.isVisible().catch(() => false);
                if (!visible) continue;
                await locator.click({ timeout: 2000 });
                await page.waitForTimeout(500);
                break;
            } catch (_) { /* ignora e tenta próximo */ }
        }

        await clickCookieConsentIfPresent(page, 800);
        await page.waitForTimeout(250);
    }

    return false;
}

async function openSegSocialLoginEntryIfNeeded(page, timeoutMs = 10000) {
    const safeTimeout = Math.max(1000, Number(timeoutMs) || 10000);
    const deadline = Date.now() + safeTimeout;
    const loginCtaSelectors = [
        () => page.getByRole('button', { name: /iniciar\s*sess[aã]o/i }).first(),
        () => page.getByRole('link', { name: /iniciar\s*sess[aã]o/i }).first(),
        () => page.locator('button', { hasText: /iniciar\s*sess[aã]o/i }).first(),
        () => page.locator('a', { hasText: /iniciar\s*sess[aã]o/i }).first(),
        // "autenticar com utilizador" (forma longa)
        () => page.getByRole('button', { name: /autenticar\s+com\s+utilizador/i }).first(),
        () => page.getByRole('link', { name: /autenticar\s+com\s+utilizador/i }).first(),
        () => page.locator('button', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
        () => page.locator('a', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
        () => page.getByText(/autenticar\s+com\s+utilizador/i).first(),
        () => page.locator('button, a, [role="button"], div, span', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
        // "utilizador da segurança social" — texto alternativo usado na extensão Chrome
        () => page.locator('button, a, [role="button"], div, span, p', { hasText: /utilizador\s+da\s+seguran[cç]a\s+social/i }).first(),
        () => page.getByText(/utilizador\s+da\s+seguran[cç]a\s+social/i).first(),
    ];
    const usernameCheckSelectors = [
        'input[name="username"]', 'input[name="niss"]', 'input[id*="username" i]',
        'input[name*="user" i]', 'input[id*="utilizador" i]', 'input[name*="utilizador" i]',
        'input[autocomplete="username"]',
    ];

    while (Date.now() < deadline) {
        const usernameSelector = await findFirstVisibleSelector(page, usernameCheckSelectors);
        if (usernameSelector) return true;

        await clickCookieConsentIfPresent(page, 700);

        let clicked = false;
        for (const buildLocator of loginCtaSelectors) {
            try {
                const locator = buildLocator();
                if ((await locator.count()) <= 0) continue;
                const visible = await locator.isVisible().catch(() => false);
                if (!visible) continue;
                await locator.click({ timeout: 2500 });
                clicked = true;
                await Promise.race([
                    page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => null),
                    page.waitForTimeout(900),
                ]);
                break;
            } catch (_) { /* ignora e tenta próximo */ }
        }

        if (!clicked) await page.waitForTimeout(250);
    }

    return false;
}

async function clickContinueWithoutActivatingIfPrompt(page, timeoutMs = 12000) {
    const safeTimeout = Math.max(1000, Number(timeoutMs) || 12000);
    const deadline = Date.now() + safeTimeout;
    const selectors = [
        () => page.getByRole('button', { name: /continuar\s*sem\s*ativar/i }).first(),
        () => page.locator('button', { hasText: /continuar\s*sem\s*ativar/i }).first(),
        () => page.locator('input[type="submit"][value*="Continuar sem ativar"]').first(),
        () => page.locator('a', { hasText: /continuar\s*sem\s*ativar/i }).first(),
    ];

    while (Date.now() < deadline) {
        for (const buildLocator of selectors) {
            try {
                const locator = buildLocator();
                if ((await locator.count()) <= 0) continue;
                const visible = await locator.isVisible().catch(() => false);
                if (!visible) continue;
                await locator.click({ timeout: 3000 });
                await page.waitForTimeout(700);
                return true;
            } catch (_) { /* ignora e continua */ }
        }
        await page.waitForTimeout(250);
    }
    return false;
}

async function clickFinancasText(page, patterns, timeout = 2500) {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    for (const pattern of list) {
        try {
            const locator = page.locator('a,button,input[type="button"],input[type="submit"]').filter({ hasText: pattern }).first();
            if ((await locator.count()) > 0 && await locator.isVisible({ timeout: 700 }).catch(() => false)) {
                await locator.click({ timeout });
                await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null);
                return true;
            }
        } catch (_) { /* tenta o próximo */ }
        try {
            const locator = page.getByText(pattern).first();
            if ((await locator.count()) > 0 && await locator.isVisible({ timeout: 700 }).catch(() => false)) {
                await locator.click({ timeout });
                await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null);
                return true;
            }
        } catch (_) { /* continua */ }
    }
    return false;
}

async function clickSearchResultAccess(page, labels = []) {
    const cleanLabels = (Array.isArray(labels) ? labels : [labels]).map((label) => String(label || '').trim()).filter(Boolean);
    try {
        const clicked = await page.evaluate((rawLabels) => {
            const fold = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
            const labelsWithTokens = rawLabels.map((label) => ({
                label,
                tokens: fold(label).split(/[^a-z0-9]+/i).filter((token) => token && !['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o'].includes(token)),
            })).filter((item) => item.tokens.length > 0);
            const buttons = Array.from(document.querySelectorAll('a,button,input[type="button"],input[type="submit"]'))
                .filter((element) => /aceder|entrar|abrir/i.test(fold(element.innerText || element.value || element.getAttribute('aria-label') || '')));
            for (const { tokens } of labelsWithTokens) {
                for (const button of buttons) {
                    let node = button;
                    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
                        const text = fold(node.innerText || node.textContent || '');
                        if (tokens.every((token) => text.includes(token))) { button.click(); return true; }
                    }
                }
            }
            return false;
        }, cleanLabels);
        if (clicked) {
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
            await page.waitForTimeout(1200);
            return true;
        }
    } catch (_) { /* usa fallback xpath */ }
    const xpaths = [];
    for (const label of cleanLabels) {
        const escaped = label.replace(/"/g, '\\"');
        xpaths.push(`//*[contains(normalize-space(.), "${escaped}")]/following::a[contains(normalize-space(.), "Aceder")][1]`);
        xpaths.push(`//*[contains(normalize-space(.), "${escaped}")]/following::button[contains(normalize-space(.), "Aceder")][1]`);
    }
    for (const xpath of xpaths) {
        try {
            const locator = page.locator(`xpath=${xpath}`).first();
            if ((await locator.count()) > 0 && await locator.isVisible({ timeout: 700 }).catch(() => false)) {
                await locator.click({ timeout: 3000 });
                await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
                await page.waitForTimeout(1200);
                return true;
            }
        } catch (_) { /* continua */ }
    }
    return false;
}

async function clickIesSearchResultAccess(page) {
    return clickSearchResultAccess(page, ['Consultar Declaração', 'Obter Comprovativo']);
}

async function fillFinancasYear(page, year) {
    const yearText = String(year || currentFiscalYear());
    const selectors = [
        'select[name*="ano" i]', 'select[id*="ano" i]', 'select[class*="ano" i]',
        'input[name*="ano" i]', 'input[id*="ano" i]', 'input[placeholder*="ano" i]',
        'input[name*="year" i]', 'input[id*="year" i]',
    ];
    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if ((await locator.count()) <= 0 || !(await locator.isVisible().catch(() => false))) continue;
        const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
        try {
            if (tag === 'select') {
                await locator.selectOption(yearText, { timeout: 1500 }).catch(async () => locator.selectOption({ label: yearText }, { timeout: 1500 }));
            } else {
                await locator.fill(yearText, { timeout: 1500 });
            }
            return true;
        } catch (_) { /* continua */ }
    }
    // Fallback: qualquer <select> visível com opções de 4 dígitos (ano)
    const yearFilled = await page.evaluate((yr) => {
        for (const sel of Array.from(document.querySelectorAll('select'))) {
            const opts = Array.from(sel.options);
            if (!opts.some((o) => /^\d{4}$/.test((o.value || o.text).trim()))) continue;
            const s = window.getComputedStyle(sel);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
            const opt = opts.find((o) => (o.value === yr || o.text.trim() === yr));
            if (!opt) continue;
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            sel.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        }
        return false;
    }, yearText).catch(() => false);
    return yearFilled;
}

async function navigateFinancasYearUrlIfPresent(page, year) {
    const yearText = String(year || currentFiscalYear());
    const currentUrl = page.url();
    if (!/ano=\d{4}/i.test(currentUrl)) return false;
    const nextUrl = currentUrl.replace(/ano=\d{4}/i, `ano=${yearText}`);
    if (nextUrl === currentUrl) return false;
    await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 18000 }).catch(() => null);
    await page.waitForTimeout(800);
    return true;
}

module.exports = {
    findFirstVisibleSelector,
    activateFinancasNifTab,
    clickContinueLoginIf2faPrompt,
    clickCookieConsentIfPresent,
    ensureSegSocialCredentialsFormVisible,
    openSegSocialLoginEntryIfNeeded,
    clickContinueWithoutActivatingIfPrompt,
    clickFinancasText,
    clickSearchResultAccess,
    clickIesSearchResultAccess,
    fillFinancasYear,
    navigateFinancasYearUrlIfPresent,
};
