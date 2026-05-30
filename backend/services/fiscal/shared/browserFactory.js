'use strict';

async function launchFinancasBrowserWithFallback(playwright, options = {}) {
    const headless = options?.headless === true;
    const baseLaunch = {
        headless,
        args: Array.isArray(options?.args) ? options.args : headless ? [] : ['--start-maximized'],
    };

    const explicitExecutablePath = String(
        options?.browserExecutablePath || process.env.PORTAL_FINANCAS_BROWSER_EXECUTABLE || ''
    ).trim();

    const attempts = [];
    if (explicitExecutablePath) {
        attempts.push({ label: 'executável configurado', launchOptions: { ...baseLaunch, executablePath: explicitExecutablePath } });
    }
    attempts.push({ label: 'Microsoft Edge', launchOptions: { ...baseLaunch, channel: 'msedge' } });
    attempts.push({ label: 'Google Chrome', launchOptions: { ...baseLaunch, channel: 'chrome' } });
    attempts.push({ label: 'Chromium (Playwright)', launchOptions: { ...baseLaunch } });

    let lastError = null;
    for (const attempt of attempts) {
        try {
            const browser = await playwright.chromium.launch(attempt.launchOptions);
            return { browser, launcherLabel: attempt.label };
        } catch (error) {
            lastError = error;
            console.warn(`[FiscalBrowser] Falha ao abrir browser (${attempt.label}):`, error?.message || error);
        }
    }

    const details = String(lastError?.message || lastError || '').trim();
    throw new Error(
        `Não foi possível abrir um browser local para autologin. Verifique se o Microsoft Edge ou Google Chrome estão instalados neste computador.${details ? ` Detalhe: ${details}` : ''}`
    );
}

module.exports = { launchFinancasBrowserWithFallback };
