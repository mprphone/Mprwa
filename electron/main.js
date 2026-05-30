const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, shell, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (_) {
  autoUpdater = null;
}

const {
  resolveSelectorListFromPayload,
  findFirstVisibleLocatorTarget,
  findLikelyUsernameNearPasswordTarget,
  findLikelySubmitNearPasswordTarget,
} = require('./playwright-helpers');
const {
  SEG_SOCIAL_ENTERPRISE_SUBUSER_FLOW,
  SEG_SOCIAL_LEGACY_SUBUSER_FLOW,
  activateFinancasNifTab,
  clickCookieConsentIfPresent,
} = require('./seg-social');
const {
  prepareSegSocialCredentialsPage,
  runDesktopAutologinPostSubmitFlow,
} = require('./seg-social-login-flow');
const { collectFinancasAtProfile } = require('./financas-at-profile');


const APP_ID = 'pt.mpr.wapro.desktop';
const APP_NAME = 'WA PRO';
const APP_VERSION = app.getVersion();
const APP_DISPLAY_NAME = `${APP_NAME} v${APP_VERSION}`;
const DEFAULT_PORT = Number(process.env.ELECTRON_LOCAL_PORT || 3010);
const DEFAULT_CLOUD_URL = 'https://wa.mpr.pt/#/inbox';
const HEALTH_PATH = '/api/chat/health';
const CONTACTS_PATH = '/api/chat/contacts';
const UNREAD_REMINDER_ENABLED = !['0', 'false', 'no', 'off', 'nao', 'não'].includes(
  String(process.env.ELECTRON_UNREAD_REMINDER_ENABLED || 'true').trim().toLowerCase()
);
const UNREAD_REMINDER_DELAY_MS = Math.max(
  15_000,
  Number(process.env.ELECTRON_UNREAD_REMINDER_DELAY_MS || 60_000) || 60_000
);
const UNREAD_REMINDER_REPEAT_MS = Math.max(
  0,
  Number(process.env.ELECTRON_UNREAD_REMINDER_REPEAT_MS || 0) || 0
);
const NEW_MESSAGE_NOTIFICATION_DURATION_MS = Math.max(
  1500,
  Number(process.env.ELECTRON_NEW_MESSAGE_NOTIFICATION_DURATION_MS || 3000) || 3000
);
const DESKTOP_UPDATE_FEED_URL = String(
  process.env.ELECTRON_UPDATE_FEED_URL || 'https://wa.mpr.pt/api/desktop/updates'
).trim();

let mainWindow = null;
let tray = null;
let backendProcess = null;
let backendManagedByElectron = false;
let pollingTimer = null;
let isQuitting = false;
let unreadSnapshot = new Map();
let messageTimestampSnapshot = new Map();
let rendererUnreadState = {
  total: null,
  updatedAt: 0,
};
let rendererOverlayState = {
  count: null,
  dataUrl: '',
  updatedAt: 0,
};
let desktopFinancasAutologinRunning = false;
let localAutomationBridgeServer = null;
let unreadReminderState = {
  activeSince: 0,
  lastReminderAt: 0,
  lastTotal: 0,
};
let updateState = {
  checking: false,
  downloaded: false,
  version: '',
};

function resolveAppRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app.asar') : path.resolve(__dirname, '..');
}

function resolveRuntimeCwd() {
  if (app.isPackaged) {
    if (process.resourcesPath && fs.existsSync(process.resourcesPath)) {
      return process.resourcesPath;
    }
    return path.dirname(app.getPath('exe'));
  }
  return path.resolve(__dirname, '..');
}

function resolveServerEntry() {
  return path.join(resolveAppRoot(), 'server.js');
}

function resolveLogoPath() {
  const appRoot = resolveAppRoot();
  const candidates = [
    path.join(appRoot, 'public', 'Logo.png'),
    path.join(appRoot, 'public', 'logo.png'),
    path.join(__dirname, 'Logo.png'),
  ];

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) return filePath;
    } catch (_) {
      // ignore
    }
  }

  return '';
}

function applyDotenvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const parsed = dotenv.parse(fs.readFileSync(filePath));
    Object.entries(parsed).forEach(([key, value]) => {
      if (!process.env[key] || String(process.env[key]).trim() === '') {
        process.env[key] = String(value || '');
      }
    });
  } catch (error) {
    console.warn(`[Electron] Falha a carregar ${filePath}:`, error?.message || error);
  }
}

function ensureProtocol(urlText) {
  const raw = String(urlText || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function normalizeBaseUrl(urlText) {
  return ensureProtocol(urlText).replace(/\/+$/, '');
}

function normalizeCloudAppUrl(urlText) {
  let value = ensureProtocol(urlText || DEFAULT_CLOUD_URL);
  if (!value) value = DEFAULT_CLOUD_URL;
  if (!value.includes('#')) {
    value = `${value.replace(/\/+$/, '')}/#/inbox`;
  }
  return value;
}

function joinUrl(base, pathText) {
  const cleanBase = String(base || '').replace(/\/+$/, '');
  const cleanPath = String(pathText || '').startsWith('/') ? String(pathText || '') : `/${String(pathText || '')}`;
  return `${cleanBase}${cleanPath}`;
}

function parseRequestJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        reject(new Error('Payload demasiado grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('JSON inválido no pedido local.'));
      }
    });
    req.on('error', reject);
  });
}

function setBridgeCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

function isLocalRequest(req) {
  const remoteAddress = String(req.socket?.remoteAddress || '').trim();
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

async function launchDesktopAutomationBrowser(playwright, payload = {}) {
  const launchBase = {
    headless: false,
    args: ['--start-maximized'],
  };

  const pushExecutableAttempt = (attempts, seenKeys, label, executablePath) => {
    const rawPath = String(executablePath || '').trim();
    if (!rawPath) return;
    const normalizedKey = rawPath.toLowerCase();
    if (seenKeys.has(normalizedKey)) return;
    seenKeys.add(normalizedKey);

    try {
      if (!fs.existsSync(rawPath)) return;
    } catch (_) {
      return;
    }

    attempts.push({
      label,
      options: {
        ...launchBase,
        executablePath: rawPath,
      },
    });
  };

  const pushChannelAttempt = (attempts, seenKeys, label, channel) => {
    const key = `channel:${String(channel || '').trim().toLowerCase()}`;
    if (!channel || seenKeys.has(key)) return;
    seenKeys.add(key);
    attempts.push({
      label,
      options: {
        ...launchBase,
        channel,
      },
    });
  };

  const preferredBrowserChannel = String(payload?.browserChannel || payload?.preferredBrowser || '').trim().toLowerCase();

  const sortBrowserCandidates = (candidates) => {
    if (!preferredBrowserChannel) return candidates;
    const wantsChrome = preferredBrowserChannel.includes('chrome');
    const wantsEdge = preferredBrowserChannel.includes('edge') || preferredBrowserChannel.includes('msedge');
    if (!wantsChrome && !wantsEdge) return candidates;
    return [...candidates].sort((a, b) => {
      const aLabel = String(a.label || '').toLowerCase();
      const bLabel = String(b.label || '').toLowerCase();
      const aScore = wantsChrome
        ? (aLabel.includes('chrome') ? 0 : aLabel.includes('edge') ? 1 : 2)
        : (aLabel.includes('edge') ? 0 : aLabel.includes('chrome') ? 1 : 2);
      const bScore = wantsChrome
        ? (bLabel.includes('chrome') ? 0 : bLabel.includes('edge') ? 1 : 2)
        : (bLabel.includes('edge') ? 0 : bLabel.includes('chrome') ? 1 : 2);
      return aScore - bScore;
    });
  };

  const executableCandidatesByPlatform = () => {
    if (process.platform === 'win32') {
      const programFiles = String(process.env.PROGRAMFILES || 'C:\\Program Files').trim();
      const programFilesX86 = String(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)').trim();
      const localAppData = String(process.env.LOCALAPPDATA || '').trim();
      return [
        { label: 'Microsoft Edge (Program Files)', path: path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
        { label: 'Microsoft Edge (Program Files x86)', path: path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
        { label: 'Microsoft Edge (LocalAppData)', path: localAppData ? path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '' },
        { label: 'Google Chrome (Program Files)', path: path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') },
        { label: 'Google Chrome (Program Files x86)', path: path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
        { label: 'Google Chrome (LocalAppData)', path: localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '' },
      ];
    }

    if (process.platform === 'darwin') {
      return [
        { label: 'Microsoft Edge (macOS)', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
        { label: 'Google Chrome (macOS)', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      ];
    }

    return [
      { label: 'Microsoft Edge (Linux)', path: '/usr/bin/microsoft-edge' },
      { label: 'Google Chrome (Linux)', path: '/usr/bin/google-chrome' },
      { label: 'Chromium (Linux)', path: '/usr/bin/chromium-browser' },
      { label: 'Chromium (Linux)', path: '/usr/bin/chromium' },
    ];
  };

  const explicitExecutablePath = String(
    payload?.browserExecutablePath || process.env.PORTAL_FINANCAS_BROWSER_EXECUTABLE || ''
  ).trim();

  const attempts = [];
  const seenAttemptKeys = new Set();

  if (explicitExecutablePath) {
    pushExecutableAttempt(attempts, seenAttemptKeys, 'executável configurado', explicitExecutablePath);
  }

  for (const candidate of sortBrowserCandidates(executableCandidatesByPlatform())) {
    pushExecutableAttempt(attempts, seenAttemptKeys, candidate.label, candidate.path);
  }

  // Ordem preferida por defeito no Windows: Edge -> Chrome -> Chromium do Playwright.
  // Quando vem da extensão Chrome, respeitamos browserChannel='chrome'.
  if (preferredBrowserChannel.includes('chrome')) {
    pushChannelAttempt(attempts, seenAttemptKeys, 'Google Chrome', 'chrome');
    pushChannelAttempt(attempts, seenAttemptKeys, 'Microsoft Edge', 'msedge');
  } else {
    pushChannelAttempt(attempts, seenAttemptKeys, 'Microsoft Edge', 'msedge');
    pushChannelAttempt(attempts, seenAttemptKeys, 'Google Chrome', 'chrome');
  }
  attempts.push({
    label: 'Chromium (Playwright)',
    options: {
      ...launchBase,
    },
  });

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const browser = await playwright.chromium.launch(attempt.options);
      return {
        browser,
        launcherLabel: attempt.label,
      };
    } catch (error) {
      lastError = error;
      console.warn(
        `[Electron] Falha ao abrir browser para autologin (${attempt.label}):`,
        error?.message || error
      );
    }
  }

  const details = String(lastError?.message || lastError || '').trim();
  throw new Error(
    `Não foi possível abrir um browser local para autologin. Verifique se o Microsoft Edge ou Google Chrome estão instalados neste computador.${details ? ` Detalhe: ${details}` : ''}`
  );
}

function resolveDesktopAutologinConfig(payload = {}) {
  const username = String(payload?.username || '').trim();
  const password = String(payload?.password || '').trim();
  const rawCredentialLabel = String(payload?.credentialLabel || '').trim();
  const rawLoginUrl = String(payload?.loginUrl || '').trim();
  const postLoginFlow = String(payload?.postLoginFlow || '').trim();
  const isSegSocialFlow =
    rawCredentialLabel.toUpperCase() === 'SS' ||
    /seg-social\.pt/i.test(rawLoginUrl) ||
    postLoginFlow === SEG_SOCIAL_ENTERPRISE_SUBUSER_FLOW ||
    postLoginFlow === SEG_SOCIAL_LEGACY_SUBUSER_FLOW ||
    postLoginFlow === 'seg_social_activation_token_setup';
  const credentialLabel = rawCredentialLabel || (isSegSocialFlow ? 'SS' : 'AT');
  const normalizedCredentialLabel = isSegSocialFlow ? 'SS' : credentialLabel.toUpperCase();

  if (!username || !password) {
    throw new Error(`Credenciais ${credentialLabel} incompletas para autologin local.`);
  }

  const defaultLoginUrl =
    normalizedCredentialLabel === 'SS'
      ? String(process.env.PORTAL_SEG_SOCIAL_LOGIN_URL || 'https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin').trim()
      : String(process.env.PORTAL_FINANCAS_LOGIN_URL || 'https://www.acesso.gov.pt/v2/loginForm?partID=PFAP').trim();
  const defaultTargetUrl =
    normalizedCredentialLabel === 'SS'
      ? String(process.env.PORTAL_SEG_SOCIAL_TARGET_URL || '').trim()
      : String(process.env.PORTAL_FINANCAS_TARGET_URL || '').trim();
  const defaultTimeoutMs =
    normalizedCredentialLabel === 'SS'
      ? Number(process.env.PORTAL_SEG_SOCIAL_TIMEOUT_MS || 90_000) || 90_000
      : Number(process.env.PORTAL_FINANCAS_TIMEOUT_MS || 90_000) || 90_000;
  const fallbackExecutablePath =
    normalizedCredentialLabel === 'SS'
      ? String(process.env.PORTAL_SEG_SOCIAL_BROWSER_EXECUTABLE || '').trim()
      : String(process.env.PORTAL_FINANCAS_BROWSER_EXECUTABLE || '').trim();

  return {
    username,
    password,
    credentialLabel,
    normalizedCredentialLabel,
    loginUrl: String(payload?.loginUrl || defaultLoginUrl).trim(),
    targetUrl: String(payload?.targetUrl || defaultTargetUrl).trim(),
    timeoutMs: Math.max(20_000, Math.min(180_000, Number(payload?.timeoutMs || defaultTimeoutMs) || 90_000)),
    closeAfterSubmit: payload?.closeAfterSubmit === true,
    returnAfterSubmit: payload?.returnAfterSubmit === true,
    postLoginFlow,
    isEnterpriseSubUserFlow: postLoginFlow === SEG_SOCIAL_ENTERPRISE_SUBUSER_FLOW,
    isLegacySubUserFlow: postLoginFlow === SEG_SOCIAL_LEGACY_SUBUSER_FLOW,
    isSegSocialActivationTokenFlow: postLoginFlow === 'seg_social_activation_token_setup',
    shouldActivateFinancasNifTab: payload?.activateFinancasNifTab !== false,
    browserExecutablePath: String(payload?.browserExecutablePath || fallbackExecutablePath).trim() || undefined,
    browserChannel: String(payload?.browserChannel || '').trim() || undefined,
    segSocialLoginVerificationSinceIso: '',
  };
}

function resolveDesktopAutologinSelectors(payload, config) {
  const { normalizedCredentialLabel } = config;
  const isSegSocial = normalizedCredentialLabel === 'SS';

  return {
    usernameSelectors: resolveSelectorListFromPayload(
      payload?.usernameSelectors,
      isSegSocial ? process.env.PORTAL_SEG_SOCIAL_USERNAME_SELECTOR : process.env.PORTAL_FINANCAS_USERNAME_SELECTOR,
      isSegSocial
        ? 'input[name="username"], input[name="niss"], input[id*="username" i], input[name*="user" i], input[id*="utilizador" i], input[name*="utilizador" i], input[id*="niss" i], input[placeholder*="NISS" i], input[autocomplete="username"]'
        : 'form[name="loginForm"] input[name="username"], input[name="username"], input[placeholder*="Contribuinte"], input[aria-label*="Contribuinte"], input[name="representante"], input[name="nif"], input[type="text"]'
    ),
    passwordSelectors: resolveSelectorListFromPayload(
      payload?.passwordSelectors,
      isSegSocial ? process.env.PORTAL_SEG_SOCIAL_PASSWORD_SELECTOR : process.env.PORTAL_FINANCAS_PASSWORD_SELECTOR,
      isSegSocial
        ? 'input[name="password"], input[id*="password" i], input[placeholder*="senha" i], input[type="password"]'
        : 'form[name="loginForm"] input[name="password"], input[name="password"], input[placeholder*="Senha"], input[type="password"]'
    ),
    submitSelectors: resolveSelectorListFromPayload(
      payload?.submitSelectors,
      isSegSocial ? process.env.PORTAL_SEG_SOCIAL_SUBMIT_SELECTOR : process.env.PORTAL_FINANCAS_SUBMIT_SELECTOR,
      isSegSocial
        ? 'button[type="submit"], input[type="submit"], button:has-text("Entrar"), button:has-text("Iniciar sessão"), button:has-text("Autenticar"), button:has-text("Continuar")'
        : 'form[name="loginForm"] button[type="submit"], form[name="loginForm"] input[type="submit"], button[type="submit"], input[type="submit"], button:has-text("Autenticar")'
    ),
    successSelectors: resolveSelectorListFromPayload(
      payload?.successSelectors,
      isSegSocial ? process.env.PORTAL_SEG_SOCIAL_SUCCESS_SELECTOR : process.env.PORTAL_FINANCAS_SUCCESS_SELECTOR,
      isSegSocial
        ? 'a[href*="logout"], a[href*="sair"], button:has-text("Terminar sessão"), button:has-text("Sair"), [data-testid*="logout"]'
        : 'a[href*="logout"], a[href*="/v2/logout"], [data-testid="logout"], .logout'
    ),
  };
}

function requirePlaywrightForDesktopAutologin() {
  try {
    return require('playwright');
  } catch (_) {
    throw new Error('Módulo de automação indisponível nesta instalação do desktop. Reinstale/atualize a WA PRO Desktop.');
  }
}

async function createDesktopAutologinPage(browser, config) {
  const context = await browser.newContext({
    viewport: null,
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'https://www.seg-social.pt',
  }).catch(() => null);

  const page = await context.newPage();
  page.setDefaultTimeout(config.timeoutMs);
  attachDesktopPdfDownloadHandler(context, page);
  return { context, page };
}

function safeDesktopDownloadFileName(value, fallback = 'documento.pdf') {
  const cleaned = path.basename(String(value || '').trim() || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function uniqueDesktopDownloadPath(folder, fileName) {
  const parsed = path.parse(fileName);
  const base = parsed.name || 'documento';
  const ext = parsed.ext || '.pdf';
  let candidate = path.join(folder, `${base}${ext}`);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(folder, `${base} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}

function fileNameFromContentDisposition(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const encodedMatch = raw.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (encodedMatch) {
    try {
      return decodeURIComponent(encodedMatch[1].replace(/^"|"$/g, ''));
    } catch (_) {
      return encodedMatch[1].replace(/^"|"$/g, '');
    }
  }
  const plainMatch = raw.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plainMatch ? plainMatch[1] : '';
}

function fileNameFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const base = path.basename(url.pathname || '');
    return base && /\.[a-z0-9]{2,8}$/i.test(base) ? base : '';
  } catch (_) {
    return '';
  }
}

function attachDesktopPdfDownloadHandler(context, page) {
  const downloadsFolder = app.getPath('downloads');
  const openedPdfKeys = new Set();

  const saveAndOpenPdfBuffer = async (buffer, fileName, sourceKey) => {
    if (!buffer?.length) return;
    const key = String(sourceKey || fileName || '').trim();
    if (key && openedPdfKeys.has(key)) return;
    if (key) openedPdfKeys.add(key);

    const safeName = safeDesktopDownloadFileName(fileName, 'documento-seguranca-social.pdf');
    const pdfName = /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`;
    const targetPath = uniqueDesktopDownloadPath(downloadsFolder, pdfName);
    await fs.promises.writeFile(targetPath, buffer);
    await shell.openPath(targetPath).catch(() => null);
  };

  const openDownload = async (download) => {
    try {
      const suggested = safeDesktopDownloadFileName(await download.suggestedFilename(), 'documento-seguranca-social.pdf');
      const targetPath = uniqueDesktopDownloadPath(downloadsFolder, suggested);
      await download.saveAs(targetPath);
      if (/\.pdf$/i.test(targetPath)) {
        await shell.openPath(targetPath).catch(() => null);
      }
    } catch (error) {
      console.warn('[Electron] Falha ao guardar/abrir PDF do autologin:', error?.message || error);
    }
  };

  const openPdfResponse = async (response) => {
    try {
      const headers = response.headers();
      const contentType = String(headers['content-type'] || '').toLowerCase();
      const responseUrl = response.url();
      const isPdf = contentType.includes('application/pdf') || /\.pdf(?:[?#]|$)/i.test(responseUrl);
      if (!isPdf || response.status() >= 400) return;

      const fileName =
        fileNameFromContentDisposition(headers['content-disposition']) ||
        fileNameFromUrl(responseUrl) ||
        'documento-seguranca-social.pdf';
      const buffer = await response.body().catch(() => null);
      await saveAndOpenPdfBuffer(buffer, fileName, responseUrl);
    } catch (error) {
      console.warn('[Electron] Falha ao capturar PDF inline do autologin:', error?.message || error);
    }
  };

  const attachToPage = (targetPage) => {
    targetPage.on('download', openDownload);
    targetPage.on('response', openPdfResponse);
  };

  attachToPage(page);
  context.on('page', attachToPage);
}

async function prepareDesktopAutologinLoginPage(page, config) {
  await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded' });
  await clickCookieConsentIfPresent(page, 2500);

  if (config.normalizedCredentialLabel === 'SS') {
    await prepareSegSocialCredentialsPage(page, config);
  }

  if (config.shouldActivateFinancasNifTab) {
    await activateFinancasNifTab(page);
  }
}

async function findDesktopAutologinFormTargets(page, selectors, config) {
  let usernameTarget = await findFirstVisibleLocatorTarget(page, selectors.usernameSelectors);
  const passwordTarget = await findFirstVisibleLocatorTarget(page, selectors.passwordSelectors);
  let submitTarget = await findFirstVisibleLocatorTarget(page, selectors.submitSelectors);

  if (config.normalizedCredentialLabel === 'SS' && !usernameTarget && passwordTarget) {
    usernameTarget = await findLikelyUsernameNearPasswordTarget(passwordTarget);
  }
  if (config.normalizedCredentialLabel === 'SS' && !submitTarget && passwordTarget) {
    submitTarget = await findLikelySubmitNearPasswordTarget(passwordTarget);
  }

  if (!usernameTarget || !passwordTarget) {
    throw new Error(`Não foi possível localizar os campos de login de ${config.credentialLabel} no desktop.`);
  }

  return { usernameTarget, passwordTarget, submitTarget };
}

async function submitDesktopAutologinCredentials(page, targets, config) {
  await targets.usernameTarget.locator.fill(config.username);
  await targets.passwordTarget.locator.fill(config.password);
  if (config.normalizedCredentialLabel === 'SS') {
    config.segSocialLoginVerificationSinceIso = new Date().toISOString();
  }

  const afterSubmitWait = () => (
    config.normalizedCredentialLabel === 'SS' && config.isEnterpriseSubUserFlow
      ? Promise.race([
        page.waitForLoadState('domcontentloaded', { timeout: Math.min(8000, config.timeoutMs) }).catch(() => null),
        page.waitForTimeout(1200),
      ])
      : page.waitForLoadState('networkidle', { timeout: Math.min(30_000, config.timeoutMs) }).catch(() => null)
  );

  if (targets.submitTarget?.locator) {
    await Promise.allSettled([
      afterSubmitWait(),
      targets.submitTarget.locator.click(),
    ]);
    return;
  }

  await Promise.allSettled([
    afterSubmitWait(),
    targets.passwordTarget.locator.press('Enter'),
  ]);
}


async function findFirstActuallyVisibleLocator(page, selector, timeoutMs = 1500) {
  const all = page.locator(selector);
  const count = Math.min(await all.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    const locator = all.nth(index);
    const visible = await locator.isVisible({ timeout: index === 0 ? timeoutMs : 250 }).catch(() => false);
    if (visible) return locator;
  }
  return null;
}

async function clickFirstFinancasTextLink(page, labels, timeoutMs = 2500) {
  const list = Array.isArray(labels) ? labels : [labels];
  for (const label of list) {
    const selectors = [
      `a:has-text("${label}")`,
      `button:has-text("${label}")`,
      `text=${label}`,
    ];
    for (const selector of selectors) {
      const locator = await findFirstActuallyVisibleLocator(page, selector, Math.min(timeoutMs, 1500));
      if (!locator) continue;
      await Promise.allSettled([
        page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => null),
        locator.click({ timeout: timeoutMs }),
      ]);
      await page.waitForTimeout(900).catch(() => null);
      return true;
    }
  }
  return false;
}

async function hasFinancasPasswordForm(page) {
  const selectors = [
    'form[name="loginForm"] input[name="password"]',
    'input[name="password"]',
    'input[type="password"]',
  ];
  for (const selector of selectors) {
    const visible = await page.locator(selector).first().isVisible({ timeout: 700 }).catch(() => false);
    if (visible) return true;
  }
  return false;
}

async function ensureFinancasFiscalIntegratedPage(page, selectors, config) {
  const readBody = async () => String(await page.locator('body').innerText({ timeout: 3000 }).catch(() => '') || '');
  const isFiscalPage = (text) => /Dados Gerais de Identifica|Atividade Exercida|Actividade Exercida|Situa[cç][aã]o Fiscal Integrada/i.test(text || '')
    && /NIF|Moradas|CAE|Servi[cç]o de Finan[cç]as|Atividade em IVA/i.test(text || '');

  await page.waitForLoadState('domcontentloaded', { timeout: Math.min(12_000, config.timeoutMs) }).catch(() => null);
  let body = await readBody();
  if (isFiscalPage(body)) return;

  // The AT often drops the session on the public homepage first. Use the real signed link from that page.
  await clickFirstFinancasTextLink(page, ['Situação fiscal integrada', 'Situacao fiscal integrada']).catch(() => false);
  body = await readBody();
  if (isFiscalPage(body)) return;

  // If the signed link sent us to a login form, authenticate again and return through the same real link.
  if (await hasFinancasPasswordForm(page)) {
    const targets = await findDesktopAutologinFormTargets(page, selectors, config);
    await submitDesktopAutologinCredentials(page, targets, config);
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(12_000, config.timeoutMs) }).catch(() => null);
    await page.waitForTimeout(1000).catch(() => null);
  } else {
    const clickedLogin = await clickFirstFinancasTextLink(page, ['Iniciar Sessão', 'Iniciar Sessao'], 2500).catch(() => false);
    if (clickedLogin && await hasFinancasPasswordForm(page)) {
      const targets = await findDesktopAutologinFormTargets(page, selectors, config);
      await submitDesktopAutologinCredentials(page, targets, config);
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(12_000, config.timeoutMs) }).catch(() => null);
      await page.waitForTimeout(1000).catch(() => null);
    }
  }

  body = await readBody();
  if (isFiscalPage(body)) return;
  await clickFirstFinancasTextLink(page, ['Situação fiscal integrada', 'Situacao fiscal integrada']).catch(() => false);
  await page.waitForLoadState('domcontentloaded', { timeout: Math.min(12_000, config.timeoutMs) }).catch(() => null);
  await page.waitForTimeout(1000).catch(() => null);
}

async function resolveDesktopAutologinCompletion(page, selectors, controller) {
  const matchedSuccessTarget = await findFirstVisibleLocatorTarget(page, selectors.successSelectors, {
    waitTimeoutMs: 1500,
  });
  const matchedSuccessSelector = matchedSuccessTarget?.selector || null;
  const hasPasswordInputAfterSubmit = (await page.locator('input[type="password"]').count()) > 0;
  const loginState = controller.manualRequiredReason
    ? 'MANUAL_REQUIRED'
    : matchedSuccessSelector
      ? 'logged_in'
      : hasPasswordInputAfterSubmit
        ? 'needs_manual_validation'
        : 'unknown';

  return {
    loginState,
    manualRequiredReason: controller.manualRequiredReason || undefined,
    postLoginFlow: controller.postLoginFlowResult || undefined,
  };
}

function buildDesktopAutologinResponse(completion, config, launcherLabel) {
  return {
    success: true,
    ...completion,
    message: config.closeAfterSubmit
      ? 'Autologin local executado. Browser fechado automaticamente.'
      : config.normalizedCredentialLabel === 'SS'
        ? `Autologin Segurança Social iniciado no desktop (${launcherLabel}).`
        : `Autologin local iniciado no desktop (${launcherLabel}).`,
  };
}

async function performDesktopFinancasAutologin(payload = {}) {
  const config = resolveDesktopAutologinConfig(payload);
  const selectors = resolveDesktopAutologinSelectors(payload, config);
  const playwright = requirePlaywrightForDesktopAutologin();
  const { browser, launcherLabel } = await launchDesktopAutomationBrowser(playwright, {
    ...payload,
    browserExecutablePath: config.browserExecutablePath,
    browserChannel: config.browserChannel,
  });

  try {
    const { context, page } = await createDesktopAutologinPage(browser, config);
    await prepareDesktopAutologinLoginPage(page, config);
    const targets = await findDesktopAutologinFormTargets(page, selectors, config);
    await submitDesktopAutologinCredentials(page, targets, config);

    if (config.returnAfterSubmit) {
      return buildDesktopAutologinResponse({ loginState: 'submitted' }, config, launcherLabel);
    }

    const controller = await runDesktopAutologinPostSubmitFlow(page, context, payload, config);
    const completion = await resolveDesktopAutologinCompletion(page, selectors, controller);

    if (config.closeAfterSubmit) {
      await browser.close().catch(() => null);
    }

    return buildDesktopAutologinResponse(completion, config, launcherLabel);
  } catch (error) {
    await browser.close().catch(() => null);
    throw error;
  }
}

async function performDesktopFinancasAtProfile(payload = {}) {
  const config = resolveDesktopAutologinConfig({
    ...payload,
    credentialLabel: 'AT',
    returnAfterSubmit: false,
    closeAfterSubmit: false,
  });
  const selectors = resolveDesktopAutologinSelectors(payload, config);
  const playwright = requirePlaywrightForDesktopAutologin();
  const { browser, launcherLabel } = await launchDesktopAutomationBrowser(playwright, {
    ...payload,
    browserExecutablePath: config.browserExecutablePath,
    browserChannel: config.browserChannel,
  });

  try {
    const { context, page } = await createDesktopAutologinPage(browser, config);
    await prepareDesktopAutologinLoginPage(page, config);
    const targets = await findDesktopAutologinFormTargets(page, selectors, config);
    await submitDesktopAutologinCredentials(page, targets, config);
    await runDesktopAutologinPostSubmitFlow(page, context, payload, config).catch(() => ({}));
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(12_000, config.timeoutMs) }).catch(() => null);
    await ensureFinancasFiscalIntegratedPage(page, selectors, config).catch(() => null);

    const collected = await collectFinancasAtProfile(page, payload || {});
    const fields = collected?.fields && typeof collected.fields === 'object' ? collected.fields : {};
    if (payload?.closeAfterCollect !== false) {
      await browser.close().catch(() => null);
    }

    return {
      success: true,
      fields,
      sourceUrl: collected?.sourceUrl || page.url(),
      rawMatches: collected?.rawMatches || [],
      message: Object.keys(fields).length
        ? `Dados da AT recolhidos no desktop (${launcherLabel}).`
        : `Login AT feito, mas não encontrei campos fiscais na página atual (${launcherLabel}).`,
    };
  } catch (error) {
    await browser.close().catch(() => null);
    throw error;
  }
}

function startLocalAutomationBridge() {
  if (localAutomationBridgeServer) return;
  const bridgePort = Number(process.env.ELECTRON_LOCAL_AUTOMATION_PORT || 30777) || 30777;

  localAutomationBridgeServer = http.createServer(async (req, res) => {
    setBridgeCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (!isLocalRequest(req)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ success: false, error: 'Acesso permitido apenas a localhost.' }));
      return;
    }

    const pathname = String(req.url || '').split('?')[0].trim();
    const isFinancasAutologin = pathname === '/financas-autologin';
    const isFinancasAtProfile = pathname === '/financas-at-profile';
    if (req.method !== 'POST' || (!isFinancasAutologin && !isFinancasAtProfile)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, error: 'Endpoint local não encontrado.' }));
      return;
    }

    try {
      const payload = await parseRequestJsonBody(req);
      if (desktopFinancasAutologinRunning) {
        res.statusCode = 409;
        res.end(JSON.stringify({ success: false, error: 'Já existe um autologin local em execução.' }));
        return;
      }

      desktopFinancasAutologinRunning = true;
      try {
        const result = isFinancasAtProfile
          ? await performDesktopFinancasAtProfile(payload || {})
          : await performDesktopFinancasAutologin(payload || {});
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (error) {
        res.statusCode = 500;
        res.end(JSON.stringify({ success: false, error: String(error?.message || error || 'Falha no autologin local.') }));
      } finally {
        desktopFinancasAutologinRunning = false;
      }
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: String(error?.message || error || 'Pedido inválido.') }));
    }
  });

  localAutomationBridgeServer.on('error', (error) => {
    console.warn('[Electron] Bridge local de automação indisponível:', error?.message || error);
  });

  localAutomationBridgeServer.listen(bridgePort, '127.0.0.1', () => {
    if (!app.isPackaged) {
      console.log(`[Electron] Bridge local de automação ativo em http://127.0.0.1:${bridgePort}`);
    }
  });
}

async function stopLocalAutomationBridge() {
  if (!localAutomationBridgeServer) return;
  const server = localAutomationBridgeServer;
  localAutomationBridgeServer = null;
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function buildRuntimeConfig() {
  const exeDir = path.dirname(app.getPath('exe'));
  const userDataDir = app.getPath('userData');
  const appRoot = resolveAppRoot();
  const runtimeCwd = resolveRuntimeCwd();

  applyDotenvFile(path.join(exeDir, '.env'));
  applyDotenvFile(path.join(userDataDir, '.env'));
  applyDotenvFile(path.join(runtimeCwd, '.env'));
  if (!app.isPackaged) {
    applyDotenvFile(path.join(appRoot, '.env'));
  }

  const rawMode = String(process.env.ELECTRON_MODE || 'cloud').trim().toLowerCase();
  const mode = rawMode === 'local' ? 'local' : 'cloud';

  if (mode === 'local') {
    const finalPort = Number(process.env.PORT || process.env.ELECTRON_LOCAL_PORT || DEFAULT_PORT) || DEFAULT_PORT;
    process.env.PORT = String(finalPort);

    if (!process.env.WA_DB_PATH) {
      process.env.WA_DB_PATH = path.join(userDataDir, 'whatsapp.db');
    }

    if (!process.env.LOCAL_DOCS_ROOT) {
      process.env.LOCAL_DOCS_ROOT = path.join(userDataDir, 'customer_documents');
    }

    if (!process.env.APP_ROLE) {
      process.env.APP_ROLE = 'all';
    }

    const appUrl = `http://127.0.0.1:${finalPort}/#/inbox`;
    const apiBaseUrl = `http://127.0.0.1:${finalPort}`;
    return {
      mode,
      port: finalPort,
      appUrl,
      apiBaseUrl,
      internalOrigin: 'http://127.0.0.1',
    };
  }

  const appUrl = normalizeCloudAppUrl(process.env.ELECTRON_CLOUD_URL || DEFAULT_CLOUD_URL);
  const appUrlNoHash = appUrl.split('#')[0] || appUrl;
  const appUrlObj = new URL(appUrlNoHash);
  const internalOrigin = appUrlObj.origin;
  const apiBaseUrl = normalizeBaseUrl(process.env.ELECTRON_API_BASE_URL || internalOrigin);

  return {
    mode,
    port: null,
    appUrl,
    apiBaseUrl,
    internalOrigin,
  };
}

function requestJson(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;

    const req = client.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: 'GET',
        timeout: timeoutMs,
        headers: { Accept: 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`HTTP ${res.statusCode || 500}: ${raw.slice(0, 200)}`));
            return;
          }

          try {
            const parsed = raw ? JSON.parse(raw) : {};
            resolve(parsed);
          } catch (error) {
            reject(new Error(`JSON inválido: ${error?.message || error}`));
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function isBackendHealthy(apiBaseUrl) {
  try {
    const payload = await requestJson(joinUrl(apiBaseUrl, HEALTH_PATH), 5000);
    return payload && payload.success === true;
  } catch (_) {
    return false;
  }
}

function spawnBackend(port) {
  const serverEntry = resolveServerEntry();
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`server.js não encontrado em ${serverEntry}`);
  }

  const env = {
    ...process.env,
    PORT: String(port),
    ELECTRON_RUN_AS_NODE: '1',
  };

  const runtimeCwd = resolveRuntimeCwd();
  const backendBinary = fs.existsSync(process.execPath) ? process.execPath : app.getPath('exe');

  backendProcess = spawn(backendBinary, [serverEntry], {
    cwd: runtimeCwd,
    env,
    windowsHide: true,
    stdio: app.isPackaged ? 'ignore' : 'pipe',
  });
  backendManagedByElectron = true;

  backendProcess.on('error', (error) => {
    console.error('[Electron] Falha ao arrancar backend:', error?.message || error);
  });

  if (!app.isPackaged && backendProcess.stdout && backendProcess.stderr) {
    backendProcess.stdout.on('data', (data) => {
      process.stdout.write(`[backend] ${data}`);
    });
    backendProcess.stderr.on('data', (data) => {
      process.stderr.write(`[backend] ${data}`);
    });
  }

  backendProcess.on('exit', (code, signal) => {
    if (!isQuitting) {
      console.warn(`[Electron] Backend terminou (code=${code}, signal=${signal})`);
      showDesktopNotification('Backend parado', 'O serviço local foi interrompido.');
    }
    backendProcess = null;
  });
}

async function ensureLocalBackendRunning(port, apiBaseUrl) {
  const alreadyUp = await isBackendHealthy(apiBaseUrl);
  if (alreadyUp) return;

  spawnBackend(port);

  const startedAt = Date.now();
  const timeoutMs = 45_000;
  while (Date.now() - startedAt < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const healthy = await isBackendHealthy(apiBaseUrl);
    if (healthy) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error('Timeout ao iniciar backend local.');
}

function isInternalUrl(urlText, runtimeConfig) {
  try {
    const target = new URL(urlText);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    return target.origin === runtimeConfig.internalOrigin;
  } catch (_) {
    return false;
  }
}

function createMainWindow(runtimeConfig) {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 840,
    minWidth: 980,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    title: APP_DISPLAY_NAME,
    icon: resolveLogoPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(runtimeConfig.appUrl);

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.setZoomFactor(0.95);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url, runtimeConfig)) {
      return { action: 'allow' };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === 'about:blank') return;
    if (!isInternalUrl(url, runtimeConfig)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });
}

function checkForDesktopUpdates(source = 'auto') {
  if (!autoUpdater) {
    if (source === 'manual') {
      showDesktopNotification('Atualizações WA PRO', 'Módulo de atualização indisponível nesta instalação.');
    }
    return;
  }
  if (!app.isPackaged) {
    if (source === 'manual') {
      showDesktopNotification('Atualizações WA PRO', 'Atualizações automáticas só funcionam na app instalada.');
    }
    return;
  }
  if (updateState.checking) return;

  updateState.checking = true;
  autoUpdater.checkForUpdates().catch((error) => {
    console.warn('[Electron] Falha ao procurar atualizações:', error?.message || error);
    if (source === 'manual') {
      showDesktopNotification('Atualizações WA PRO', String(error?.message || 'Falha ao procurar atualizações.'));
    }
  }).finally(() => {
    updateState.checking = false;
  });
}

function initAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;

  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = console;
    if (DESKTOP_UPDATE_FEED_URL) {
      autoUpdater.setFeedURL({ provider: 'generic', url: DESKTOP_UPDATE_FEED_URL });
    }

    autoUpdater.on('checking-for-update', () => {
      updateState.checking = true;
    });
    autoUpdater.on('update-available', (info) => {
      updateState.version = String(info?.version || '').trim();
      showDesktopNotification(
        'Atualização WA PRO disponível',
        updateState.version ? `A descarregar versão ${updateState.version}...` : 'A descarregar nova versão...'
      );
    });
    autoUpdater.on('update-not-available', () => {
      updateState.checking = false;
    });
    autoUpdater.on('error', (error) => {
      updateState.checking = false;
      console.warn('[Electron] Erro no auto-update:', error?.message || error);
    });
    autoUpdater.on('update-downloaded', async (info) => {
      updateState = {
        checking: false,
        downloaded: true,
        version: String(info?.version || updateState.version || '').trim(),
      };

      const versionText = updateState.version ? ` versão ${updateState.version}` : '';
      showDesktopNotification('Atualização WA PRO pronta', `A atualização${versionText} está pronta para instalar.`);

      const response = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Reiniciar agora', 'Mais tarde'],
        defaultId: 0,
        cancelId: 1,
        title: 'Atualização WA PRO pronta',
        message: `A atualização${versionText} foi descarregada.`,
        detail: 'Queres reiniciar a WA PRO agora para aplicar a atualização?',
      }).catch(() => ({ response: 1 }));

      if (response.response === 0) {
        isQuitting = true;
        autoUpdater.quitAndInstall(false, true);
      }
    });

    setTimeout(() => checkForDesktopUpdates('auto'), 12_000);
    setInterval(() => checkForDesktopUpdates('auto'), 6 * 60 * 60 * 1000);
  } catch (error) {
    console.warn('[Electron] Auto-updater indisponível:', error?.message || error);
  }
}

function createTray() {
  const iconPath = resolveLogoPath();
  const trayIcon = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(trayIcon);
  tray.setToolTip(APP_DISPLAY_NAME);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Mostrar',
      click: () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: 'Esconder',
      click: () => {
        mainWindow?.hide();
      },
    },
    { type: 'separator' },
    {
      label: updateState.downloaded ? 'Instalar atualização' : 'Procurar atualizações',
      click: () => {
        if (updateState.downloaded && autoUpdater) {
          isQuitting = true;
          autoUpdater.quitAndInstall(false, true);
          return;
        }
        checkForDesktopUpdates('manual');
      },
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function showDesktopNotification(title, body, options = {}) {
  if (!Notification.isSupported()) return;

  const icon = resolveLogoPath();
  const durationMs = Math.max(
    1500,
    Number(options?.durationMs || NEW_MESSAGE_NOTIFICATION_DURATION_MS) || NEW_MESSAGE_NOTIFICATION_DURATION_MS
  );
  const notification = new Notification({
    title,
    body,
    icon: icon || undefined,
    silent: false,
    timeoutType: 'never',
  });

  notification.on('click', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  });

  notification.show();
  const closeTimer = setTimeout(() => {
    try {
      notification.close();
    } catch (_) {
      // sem bloqueio
    }
  }, durationMs);
  notification.on('close', () => {
    clearTimeout(closeTimer);
  });
}

function createUnreadOverlayIcon(count) {
  const safeCount = Math.max(0, Number(count) || 0);
  if (safeCount <= 0) return null;

  const rendererCount = Number(rendererOverlayState.count);
  const rendererOverlayIsFresh =
    Number.isFinite(rendererCount) &&
    rendererCount === safeCount &&
    Date.now() - Number(rendererOverlayState.updatedAt || 0) < 30_000 &&
    typeof rendererOverlayState.dataUrl === 'string' &&
    rendererOverlayState.dataUrl.startsWith('data:image/');

  if (rendererOverlayIsFresh) {
    const rendererImage = nativeImage.createFromDataURL(rendererOverlayState.dataUrl);
    if (rendererImage && !rendererImage.isEmpty()) {
      return rendererImage.resize({ width: 16, height: 16, quality: 'best' });
    }
  }

  const text = safeCount > 99 ? '99+' : String(safeCount);
  const fontSize = text.length >= 3 ? 14 : 18;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
      <circle cx="32" cy="32" r="28" fill="#e11d48"/>
      <text x="32" y="41" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${text}</text>
    </svg>
  `;
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const image = nativeImage.createFromDataURL(dataUrl);
  if (!image || image.isEmpty()) return null;
  return image.resize({ width: 16, height: 16, quality: 'best' });
}

function evaluateUnreadReminder(unreadTotal) {
  if (!UNREAD_REMINDER_ENABLED) return;

  const total = Math.max(0, Number(unreadTotal) || 0);
  const now = Date.now();
  const previousTotal = Math.max(0, Number(unreadReminderState.lastTotal) || 0);

  if (total <= 0) {
    unreadReminderState = {
      activeSince: 0,
      lastReminderAt: 0,
      lastTotal: 0,
    };
    return;
  }

  if (previousTotal <= 0 || total > previousTotal) {
    unreadReminderState.activeSince = now;
    unreadReminderState.lastReminderAt = 0;
  }

  if (unreadReminderState.activeSince <= 0) {
    unreadReminderState.activeSince = now;
  }

  const elapsedMs = now - Number(unreadReminderState.activeSince || 0);
  const hasReminder = Number(unreadReminderState.lastReminderAt || 0) > 0;
  const shouldRepeat =
    hasReminder &&
    UNREAD_REMINDER_REPEAT_MS > 0 &&
    now - Number(unreadReminderState.lastReminderAt || 0) >= UNREAD_REMINDER_REPEAT_MS;

  if (elapsedMs >= UNREAD_REMINDER_DELAY_MS && (!hasReminder || shouldRepeat)) {
    const minutes = Math.max(1, Math.round(UNREAD_REMINDER_DELAY_MS / 60_000));
    showDesktopNotification(
      'Lembrete WA PRO',
      `Tem ${total} mensagem(ns) por ler há mais de ${minutes} minuto(s).`
    );
    unreadReminderState.lastReminderAt = now;
  }

  unreadReminderState.lastTotal = total;
}

function updateUnreadIndicators(unreadTotal) {
  const total = Math.max(0, Number(unreadTotal) || 0);
  const windowTitle = total > 0 ? `(${total}) ${APP_DISPLAY_NAME}` : APP_DISPLAY_NAME;

  if (tray) {
    tray.setToolTip(total > 0 ? `${APP_DISPLAY_NAME} (${total} por ler)` : APP_DISPLAY_NAME);
  }

  if (typeof app.setBadgeCount === 'function') {
    app.setBadgeCount(total);
  }

  if (mainWindow && typeof mainWindow.setOverlayIcon === 'function') {
    mainWindow.setTitle(windowTitle);

    if (total > 0) {
      const overlayIcon = createUnreadOverlayIcon(total);
      if (overlayIcon) {
        mainWindow.setOverlayIcon(overlayIcon, `${total} mensagens por ler`);
      }
      if (typeof mainWindow.flashFrame === 'function') {
        mainWindow.flashFrame(true);
      }
    } else {
      mainWindow.setOverlayIcon(null, '');
      if (typeof mainWindow.flashFrame === 'function') {
        mainWindow.flashFrame(false);
      }
    }
  }

  if (mainWindow && typeof mainWindow.setProgressBar === 'function') {
    // Fallback visual para Windows quando overlay/badge está desativado no sistema.
    if (total > 0) {
      mainWindow.setProgressBar(2);
    } else {
      mainWindow.setProgressBar(-1);
    }
  }

  evaluateUnreadReminder(total);
}

function getUnreadFromWindowTitle() {
  if (!mainWindow || typeof mainWindow.getTitle !== 'function') return null;
  const title = String(mainWindow.getTitle() || '').trim();
  const match = title.match(/^\((\d+)\)\s+/);
  if (!match) return null;
  return Math.max(0, Number(match[1]) || 0);
}

function isWindowInBackground() {
  if (!mainWindow) return true;
  if (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed()) return true;
  const visible = typeof mainWindow.isVisible === 'function' ? mainWindow.isVisible() : true;
  const minimized = typeof mainWindow.isMinimized === 'function' ? mainWindow.isMinimized() : false;
  const focused = typeof mainWindow.isFocused === 'function' ? mainWindow.isFocused() : false;
  return !visible || minimized || !focused;
}

function parseMessageTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function looksLikePhoneLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^\+?\d[\d\s-]{5,}$/.test(raw)) return true;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 7 && digits.length >= Math.max(7, raw.length - 3);
}

const recentSseNotifications = new Map();
const SSE_NOTIFICATION_SUPPRESS_MS = 15_000;

function resolveNotificationSender(row) {
  const contactName = String(row?.customer_contact_name || '').trim();
  const customerName = String(row?.customer_name || '').trim();
  const customerCompany = String(row?.customer_company || '').trim();
  const fromNumber = String(row?.from_number || '').trim();

  if (contactName && !looksLikePhoneLabel(contactName)) return contactName;
  if (
    customerName &&
    !looksLikePhoneLabel(customerName) &&
    (!customerCompany || customerName.toLowerCase() !== customerCompany.toLowerCase())
  ) {
    return customerName;
  }
  if (customerCompany && !looksLikePhoneLabel(customerCompany)) return customerCompany;
  if (customerName && !looksLikePhoneLabel(customerName)) return customerName;
  return fromNumber || 'cliente';
}

function resolveNotificationPreview(row) {
  const raw = String(row?.last_inbound_preview || row?.last_msg_preview || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
}

async function pollUnreadNotifications(apiBaseUrl) {
  try {
    const payload = await requestJson(joinUrl(apiBaseUrl, CONTACTS_PATH), 7000);
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    let unreadTotal = 0;

    const currentKeys = new Set();
    rows.forEach((row) => {
      const key = String(row?.conversation_id || row?.from_number || '').trim();
      if (!key) return;
      currentKeys.add(key);

      const unread = Number(row?.unread_count || 0);
      unreadTotal += Math.max(0, unread);
      const previousUnread = Number(unreadSnapshot.get(key) || 0);
      const lastMsgTs = parseMessageTimestamp(row?.last_msg_time);
      const previousLastMsgTs = Number(messageTimestampSnapshot.get(key) || 0);
      const hasUnreadIncrease = unread > previousUnread && unread > 0;
      const hasBackgroundMessage =
        !hasUnreadIncrease &&
        unread > 0 &&
        lastMsgTs > 0 &&
        lastMsgTs > previousLastMsgTs &&
        isWindowInBackground();

      if (hasUnreadIncrease || hasBackgroundMessage) {
        const from = resolveNotificationSender(row);
        const sseTs = recentSseNotifications.get(from);
        if (sseTs && Date.now() - sseTs < SSE_NOTIFICATION_SUPPRESS_MS) {
          recentSseNotifications.delete(from);
        } else {
          const delta = hasUnreadIncrease ? unread - previousUnread : 1;
          const preview = resolveNotificationPreview(row);
          const body = preview
            ? `${from}: ${preview}${delta > 1 ? ` (+${delta - 1})` : ''}`
            : `${from} enviou ${delta} nova(s) mensagem(ns).`;
          showDesktopNotification('Nova mensagem WhatsApp', body, {
            durationMs: NEW_MESSAGE_NOTIFICATION_DURATION_MS,
          });
        }
      }

      unreadSnapshot.set(key, unread);
      messageTimestampSnapshot.set(key, lastMsgTs);
    });

    for (const key of unreadSnapshot.keys()) {
      if (!currentKeys.has(key)) unreadSnapshot.delete(key);
    }
    for (const key of messageTimestampSnapshot.keys()) {
      if (!currentKeys.has(key)) messageTimestampSnapshot.delete(key);
    }

    const rendererTotal = Number(rendererUnreadState.total);
    const rendererIsFresh =
      Number.isFinite(rendererTotal) &&
      rendererTotal >= 0 &&
      Date.now() - Number(rendererUnreadState.updatedAt || 0) < 30_000;

    // Fonte principal: polling local (Inbox). Se o renderer estiver fresco, inclui também Chat Interno.
    const effectiveUnread = rendererIsFresh
      ? Math.max(unreadTotal, rendererTotal)
      : unreadTotal;

    updateUnreadIndicators(effectiveUnread);
  } catch (error) {
    const titleUnread = getUnreadFromWindowTitle();
    const rendererTotal = Number(rendererUnreadState.total);
    const rendererIsFresh =
      Number.isFinite(rendererTotal) &&
      rendererTotal >= 0 &&
      Date.now() - Number(rendererUnreadState.updatedAt || 0) < 30_000;

    const effectiveUnread = rendererIsFresh
      ? rendererTotal
      : (Number.isFinite(titleUnread) && titleUnread !== null ? titleUnread : 0);

    updateUnreadIndicators(effectiveUnread);
    if (!app.isPackaged) {
      console.warn('[Electron] Falha no polling de notificações:', error?.message || error);
    }
  }
}

function startUnreadWatcher(apiBaseUrl) {
  if (pollingTimer) clearInterval(pollingTimer);
  unreadSnapshot = new Map();
  messageTimestampSnapshot = new Map();
  void pollUnreadNotifications(apiBaseUrl);
  pollingTimer = setInterval(() => {
    void pollUnreadNotifications(apiBaseUrl);
  }, 10_000);
}

async function stopBackendIfManaged() {
  if (!backendManagedByElectron || !backendProcess) return;

  const proc = backendProcess;
  backendProcess = null;

  try {
    proc.kill('SIGTERM');
  } catch (_) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {
        // ignore
      }
      resolve();
    }, 4000);

    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function bootstrap() {
  app.setAppUserModelId(APP_ID);

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  ipcMain.on('wa:notify-inbound-message', (_event, payload) => {
    const from = String(payload?.from || '').trim() || 'Cliente';
    const body = String(payload?.body || '').trim();
    if (!body) return;
    const text = `${from}: ${body.slice(0, 200)}`;
    showDesktopNotification('Nova mensagem WhatsApp', text, {
      durationMs: NEW_MESSAGE_NOTIFICATION_DURATION_MS,
    });
    recentSseNotifications.set(from, Date.now());
  });

  ipcMain.on('wa:set-unread-total', (_event, totalRaw) => {
    const total = Math.max(0, Number(totalRaw) || 0);
    rendererUnreadState = {
      total,
      updatedAt: Date.now(),
    };
    updateUnreadIndicators(total);
  });

  ipcMain.on('wa:set-unread-overlay', (_event, payload) => {
    const nextCount = Math.max(0, Number(payload?.count) || 0);
    const nextDataUrl = String(payload?.dataUrl || '').trim();
    rendererOverlayState = {
      count: nextCount,
      dataUrl: nextDataUrl,
      updatedAt: Date.now(),
    };
    if (Number.isFinite(nextCount)) {
      updateUnreadIndicators(nextCount);
    }
  });

  ipcMain.handle('wa:read-clipboard-text', async () => {
    return String(clipboard.readText() || '').trim();
  });

  ipcMain.handle('wa:open-as-app', async (_event, url) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(String(url || ''));
    } catch (_) {
      return;
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') return;

    if (process.platform === 'win32') {
      const pf = String(process.env.PROGRAMFILES || 'C:\\Program Files').trim();
      const pfx86 = String(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)').trim();
      const local = String(process.env.LOCALAPPDATA || '').trim();
      const candidates = [
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        local && path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ].filter(Boolean);
      const browserExe = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
      if (browserExe) {
        spawn(browserExe, [`--app=${parsedUrl.href}`], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
    }
    void shell.openExternal(parsedUrl.href);
  });

  ipcMain.handle('wa:financas-autologin', async (_event, payload) => {
    if (desktopFinancasAutologinRunning) {
      return {
        success: false,
        error: 'Já existe um autologin local em execução.',
      };
    }

    desktopFinancasAutologinRunning = true;
    try {
      const result = await performDesktopFinancasAutologin(payload || {});
      return {
        success: true,
        ...result,
      };
    } catch (error) {
      return {
        success: false,
        error: String(error?.message || error || 'Falha no autologin local.'),
      };
    } finally {
      desktopFinancasAutologinRunning = false;
    }
  });

  ipcMain.handle('wa:financas-at-profile', async (_event, payload) => {
    if (desktopFinancasAutologinRunning) {
      return {
        success: false,
        error: 'Já existe um autologin local em execução.',
      };
    }

    desktopFinancasAutologinRunning = true;
    try {
      const result = await performDesktopFinancasAtProfile(payload || {});
      return {
        success: true,
        ...result,
      };
    } catch (error) {
      return {
        success: false,
        error: String(error?.message || error || 'Falha ao recolher dados da AT.'),
      };
    } finally {
      desktopFinancasAutologinRunning = false;
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
    void stopLocalAutomationBridge();
  });

  app.on('window-all-closed', (event) => {
    event.preventDefault();
  });

  await app.whenReady();
  startLocalAutomationBridge();

  const runtimeConfig = buildRuntimeConfig();

  if (runtimeConfig.mode === 'local') {
    try {
      await ensureLocalBackendRunning(runtimeConfig.port, runtimeConfig.apiBaseUrl);
    } catch (error) {
      showDesktopNotification('Erro ao iniciar WA PRO', String(error?.message || error));
      throw error;
    }
  }

  createMainWindow(runtimeConfig);
  createTray();
  startUnreadWatcher(runtimeConfig.apiBaseUrl);
  initAutoUpdater();

  app.on('activate', () => {
    if (!mainWindow) {
      createMainWindow(runtimeConfig);
      return;
    }
    mainWindow.show();
    mainWindow.focus();
  });
}

bootstrap().catch(async (error) => {
  console.error('[Electron] Falha no arranque:', error?.message || error);
  await stopLocalAutomationBridge();
  await stopBackendIfManaged();
  app.quit();
});

app.on('quit', async () => {
  await stopLocalAutomationBridge();
  await stopBackendIfManaged();
});
