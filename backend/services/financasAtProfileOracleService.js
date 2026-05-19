const fs = require('fs');
const path = require('path');
const { collectFinancasAtProfile } = require('./financasAtProfileParser');

const DEFAULT_LOGIN_URL = 'https://www.acesso.gov.pt/v2/loginForm?partID=PFAP';
const DEFAULT_HOME_URL = 'https://www.portaldasfinancas.gov.pt/pt/home.action';

function splitSelectorList(rawValue, fallbackValue) {
  const source = String(rawValue || fallbackValue || '').trim();
  return source.split(',').map((item) => item.trim()).filter(Boolean);
}

async function clickCookieConsentIfPresent(page, timeoutMs = 1500) {
  const selectors = [
    'button:has-text("Aceitar")',
    'button:has-text("Concordo")',
    'button:has-text("Permitir")',
    'button:has-text("OK")',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible({ timeout: Math.min(timeoutMs, 700) }).catch(() => false);
    if (!visible) continue;
    await locator.click({ timeout: 1200 }).catch(() => null);
    await page.waitForTimeout(300).catch(() => null);
    return true;
  }
  return false;
}

async function findFirstVisible(page, selectors, timeoutMs = 2500) {
  for (const selector of selectors) {
    const locator = await findFirstActuallyVisible(page, selector, timeoutMs);
    if (locator) return locator;
  }
  return null;
}

async function findFirstActuallyVisible(page, selector, timeoutMs = 1500) {
  const all = page.locator(selector);
  const count = Math.min(await all.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    const locator = all.nth(index);
    const visible = await locator.isVisible({ timeout: index === 0 ? timeoutMs : 250 }).catch(() => false);
    if (visible) return locator;
  }
  return null;
}

async function activateFinancasNifTab(page) {
  const selectors = [
    'button:has-text("NIF")',
    'a:has-text("NIF")',
    'label:has-text("NIF")',
    '[role="tab"]:has-text("NIF")',
    'text=NIF',
  ];
  for (const selector of selectors) {
    const locator = await findFirstActuallyVisible(page, selector, 1000);
    if (!locator) continue;
    await locator.click({ timeout: 1500 }).catch(() => null);
    await page.waitForTimeout(600).catch(() => null);
    return true;
  }
  return false;
}


async function continueFinancasLoginIfPrompted(page) {
  const text = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '');
  if (!/Continuar Login|Segundo Fator|2FA|Aderir/i.test(text || '')) return false;

  const clicked = await clickFirstText(page, [
    'Continuar Login',
    'Continuar login',
    'Continuar',
    'Nao aderir',
    'Não aderir',
    'Mais tarde',
  ], 3500).catch(() => false);
  if (!clicked) return false;

  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(1200).catch(() => null);
  return true;
}

async function submitFinancasLogin(page, credentials, options = {}) {
  const usernameSelectors = splitSelectorList(
    options.usernameSelectors || process.env.PORTAL_FINANCAS_USERNAME_SELECTOR,
    'form[name="loginForm"] input[name="username"], input[name="username"], input[placeholder*="Contribuinte"], input[aria-label*="Contribuinte"], input[name="representante"], input[name="nif"], input[type="text"]'
  );
  const passwordSelectors = splitSelectorList(
    options.passwordSelectors || process.env.PORTAL_FINANCAS_PASSWORD_SELECTOR,
    'form[name="loginForm"] input[name="password"], input[name="password"], input[placeholder*="Senha"], input[type="password"]'
  );
  const submitSelectors = splitSelectorList(
    options.submitSelectors || process.env.PORTAL_FINANCAS_SUBMIT_SELECTOR,
    'form[name="loginForm"] button[type="submit"], form[name="loginForm"] input[type="submit"], button[type="submit"], input[type="submit"], button:has-text("Autenticar"), button:has-text("Entrar")'
  );

  await activateFinancasNifTab(page);
  const usernameInput = await findFirstVisible(page, usernameSelectors, 2500);
  const passwordInput = await findFirstVisible(page, passwordSelectors, 2500);
  if (!usernameInput || !passwordInput) {
    throw new Error('Nao foi possivel localizar os campos de login AT no Oracle.');
  }
  await usernameInput.fill(String(credentials.username || '').trim());
  await passwordInput.fill(String(credentials.password || '').trim());
  const submit = await findFirstVisible(page, submitSelectors, 1200);
  if (submit) {
    await Promise.allSettled([
      page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null),
      submit.click({ timeout: 2500 }),
    ]);
  } else {
    await Promise.allSettled([
      page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null),
      passwordInput.press('Enter'),
    ]);
  }
  await page.waitForTimeout(1000).catch(() => null);
  await continueFinancasLoginIfPrompted(page).catch(() => false);
}

async function clickFirstText(page, labels, timeoutMs = 2500) {
  const list = Array.isArray(labels) ? labels : [labels];
  for (const label of list) {
    const selectors = [
      `a:has-text("${label}")`,
      `button:has-text("${label}")`,
      `text=${label}`,
    ];
    for (const selector of selectors) {
      const locator = await findFirstActuallyVisible(page, selector, Math.min(timeoutMs, 1200));
      if (!locator) continue;
      await Promise.allSettled([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null),
        locator.click({ timeout: timeoutMs }),
      ]);
      await page.waitForTimeout(900).catch(() => null);
      return true;
    }
  }
  return false;
}

async function hasPasswordForm(page) {
  return page.locator('input[type="password"], input[name="password"]').first().isVisible({ timeout: 800 }).catch(() => false);
}

async function debugSnapshot(page, stage) {
  try {
    const dir = path.join(process.cwd(), 'logs', 'at-profile');
    fs.mkdirSync(dir, { recursive: true });
    const safeStage = String(stage || 'stage').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
    const stamp = new Date().toISOString().replace(/[^0-9TZ]+/g, '');
    const base = path.join(dir, `${stamp}-${safeStage}`);
    const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    fs.writeFileSync(`${base}.txt`, `URL: ${page.url()}\n\n${text}`, 'utf8');
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => null);
    console.log(`[AT Profile] snapshot ${stage}: ${page.url()} -> ${base}`);
  } catch (error) {
    console.warn('[AT Profile] snapshot falhou:', error?.message || error);
  }
}

async function submitSearch(page, query) {
  const inputSelectors = [
    'input[placeholder*="pretende efetuar" i]',
    'input[placeholder*="pretende" i]',
    'input[type="search"]',
    'input[name="q"]',
    'input[type="text"]',
  ];
  const input = await findFirstVisible(page, inputSelectors, 1500);
  if (!input) return false;
  await input.fill(query);
  const button = await findFirstVisible(page, [
    'button:has-text("Pesquisar")',
    'button[aria-label*="Pesquisar" i]',
    'button[type="submit"]',
    'input[type="submit"]',
  ], 1000);
  await Promise.allSettled([
    page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => null),
    button ? button.click({ timeout: 2000 }) : input.press('Enter'),
  ]);
  await page.waitForTimeout(1200).catch(() => null);
  return true;
}

async function searchFiscalIntegratedArea(page) {
  const queries = ['situação fiscal integrada', 'situacao fiscal integrada'];
  for (const query of queries) {
    const searched = await submitSearch(page, query).catch(() => false);
    if (!searched) continue;
    if (await clickFirstText(page, ['Situação fiscal integrada', 'Situacao fiscal integrada'], 3500).catch(() => false)) return true;
    if (await clickFirstText(page, ['Aceder', 'Consultar', 'Entrar'], 2500).catch(() => false)) return true;
  }
  return false;
}

async function openFiscalIntegratedArea(page, credentials, options = {}) {
  const readBody = async () => String(await page.locator('body').innerText({ timeout: 3000 }).catch(() => '') || '');
  const isFiscalPage = (text) => /Dados Gerais de Identifica|Atividade Exercida|Actividade Exercida|Situa[cç][aã]o Fiscal Integrada/i.test(text || '')
    && /NIF|Moradas|CAE|Servi[cç]o de Finan[cç]as|Atividade em IVA/i.test(text || '');

  let body = await readBody();
  if (isFiscalPage(body)) return true;

  await debugSnapshot(page, 'after-login-before-sfi');

  await continueFinancasLoginIfPrompted(page).catch(() => false);
  body = await readBody();
  if (isFiscalPage(body)) return true;

  await clickFirstText(page, ['Situação fiscal integrada', 'Situacao fiscal integrada'], 3500).catch(() => false);
  body = await readBody();
  if (isFiscalPage(body)) return true;

  // If the public portal/search page appears, use AT's own search box instead of guessing signed URLs.
  await searchFiscalIntegratedArea(page).catch(() => false);
  body = await readBody();
  if (isFiscalPage(body)) return true;

  if (await hasPasswordForm(page)) {
    await submitFinancasLogin(page, credentials, options);
  } else {
    const clickedLogin = await clickFirstText(page, ['Iniciar Sessão', 'Iniciar Sessao'], 2500).catch(() => false);
    if (clickedLogin && await hasPasswordForm(page)) {
      await submitFinancasLogin(page, credentials, options);
    }
  }

  body = await readBody();
  if (isFiscalPage(body)) return true;
  await clickFirstText(page, ['Situação fiscal integrada', 'Situacao fiscal integrada'], 3500).catch(() => false);
  body = await readBody();
  if (isFiscalPage(body)) return true;

  await searchFiscalIntegratedArea(page).catch(() => false);
  body = await readBody();
  if (isFiscalPage(body)) return true;

  await debugSnapshot(page, 'sfi-not-found');
  return false;
}

async function launchOracleBrowser(playwright, options = {}) {
  const headless = options.headless !== false;
  const baseLaunch = {
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };
  const explicitExecutablePath = String(options.browserExecutablePath || process.env.PORTAL_FINANCAS_BROWSER_EXECUTABLE || '').trim();
  const attempts = [];
  if (explicitExecutablePath) attempts.push({ label: 'executavel configurado', launchOptions: { ...baseLaunch, executablePath: explicitExecutablePath } });
  attempts.push({ label: 'Chromium Playwright', launchOptions: baseLaunch });
  attempts.push({ label: 'Google Chrome', launchOptions: { ...baseLaunch, channel: 'chrome' } });
  attempts.push({ label: 'Microsoft Edge', launchOptions: { ...baseLaunch, channel: 'msedge' } });

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const browser = await playwright.chromium.launch(attempt.launchOptions);
      return { browser, launcherLabel: attempt.label };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Nao foi possivel abrir browser no Oracle para AT.${lastError?.message ? ` Detalhe: ${lastError.message}` : ''}`);
}

async function collectFinancasAtProfileInOracle(credentials, options = {}) {
  const username = String(credentials?.username || '').trim();
  const password = String(credentials?.password || '').trim();
  if (!username || !password) throw new Error('Credenciais AT incompletas.');

  let playwright = null;
  try {
    playwright = require('playwright');
  } catch (_) {
    throw new Error('Playwright nao instalado no Oracle. Execute: npm i playwright && npx playwright install chromium');
  }

  const timeoutMs = Math.max(30000, Math.min(180000, Number(options.timeoutMs || process.env.PORTAL_FINANCAS_TIMEOUT_MS || 120000) || 120000));
  const { browser, launcherLabel } = await launchOracleBrowser(playwright, options);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    await page.goto(String(options.loginUrl || process.env.PORTAL_FINANCAS_LOGIN_URL || DEFAULT_LOGIN_URL).trim(), { waitUntil: 'domcontentloaded' });
    await clickCookieConsentIfPresent(page);
    await submitFinancasLogin(page, { username, password }, options);
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(15000, timeoutMs) }).catch(() => null);

    await openFiscalIntegratedArea(page, { username, password }, options).catch(() => false);
    const body = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (/Bem-vindo ao Portal das Finan/i.test(body) && !/Situa[cç][aã]o Fiscal Integrada/i.test(body)) {
      await page.goto(DEFAULT_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      await openFiscalIntegratedArea(page, { username, password }, options).catch(() => false);
    }

    const collected = await collectFinancasAtProfile(page, {
      ...options,
      profileCollectTimeoutMs: options.profileCollectTimeoutMs || 45000,
    });
    if (!Object.keys(collected.fields || {}).length) {
      await debugSnapshot(page, 'no-fields-after-collect');
    }
    return {
      success: true,
      fields: collected.fields || {},
      sourceUrl: collected.sourceUrl || page.url(),
      attempts: collected.attempts || [],
      message: Object.keys(collected.fields || {}).length
        ? `Dados da AT recolhidos no Oracle (${launcherLabel}).`
        : `Login AT feito no Oracle, mas nao encontrei campos fiscais (${launcherLabel}).`,
    };
  } finally {
    await browser.close().catch(() => null);
  }
}

module.exports = {
  collectFinancasAtProfileInOracle,
};
