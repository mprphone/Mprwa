const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

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

function splitSelectorList(rawValue, fallbackValue) {
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  const source = String(rawValue || fallbackValue || '').trim();
  return source
    .split(',')
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function resolveSelectorListFromPayload(payloadValue, envValue, fallbackValue) {
  const payloadSelectors = splitSelectorList(payloadValue, '');
  if (payloadSelectors.length > 0) return payloadSelectors;
  return splitSelectorList(envValue, fallbackValue);
}

async function findFirstVisibleLocatorTarget(page, selectors, options = {}) {
  const waitTimeout = Math.max(500, Number(options?.waitTimeoutMs || 3000) || 3000);
  const includeFrames = options?.includeFrames !== false;
  const maxMatchesPerSelector = Math.max(1, Number(options?.maxMatchesPerSelector || 8) || 8);
  const selectorList = Array.isArray(selectors) ? selectors : [];
  const candidateFrames = includeFrames
    ? [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())]
    : [page.mainFrame()];

  for (const selector of selectorList) {
    const cleanedSelector = String(selector || '').trim();
    if (!cleanedSelector) continue;

    for (const frame of candidateFrames) {
      try {
        const candidates = frame.locator(cleanedSelector);
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

          return {
            selector: cleanedSelector,
            locator,
            frame,
            frameUrl: String(frame.url() || '').trim(),
            inIframe: frame !== page.mainFrame(),
          };
        }
      } catch (_) {
        // ignore invalid selector/frame mismatch and keep trying
      }
    }
  }

  return null;
}

async function findLikelyUsernameNearPasswordTarget(passwordTarget) {
  if (!passwordTarget?.frame || !passwordTarget?.locator) return null;
  const frame = passwordTarget.frame;
  const passwordBox = await passwordTarget.locator.boundingBox().catch(() => null);
  const candidates = frame.locator('input:not([type="password"]):not([type="hidden"]):not([disabled])');
  const maxCandidates = Math.min(await candidates.count().catch(() => 0), 40);

  let bestLocator = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < maxCandidates; index += 1) {
    const locator = candidates.nth(index);
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await locator.boundingBox().catch(() => null);
    if (!box) continue;

    let score = index + 1;
    if (passwordBox) {
      const sameColumnPenalty = Math.abs(box.x - passwordBox.x) > 260 ? 600 : 0;
      const verticalDistance = Math.abs((passwordBox.y || 0) - (box.y || 0));
      const expectedAbovePenalty = box.y > passwordBox.y + 35 ? 420 : 0;
      const widthPenalty = Math.abs((box.width || 0) - (passwordBox.width || 0)) / 40;
      score = verticalDistance + sameColumnPenalty + expectedAbovePenalty + widthPenalty;
    }

    if (score < bestScore) {
      bestScore = score;
      bestLocator = locator;
    }
  }

  if (!bestLocator) return null;
  return {
    selector: 'heuristic:ss-username-near-password',
    locator: bestLocator,
    frame,
    frameUrl: String(frame.url() || '').trim(),
    inIframe: frame !== frame.page().mainFrame(),
  };
}

async function findLikelySubmitNearPasswordTarget(passwordTarget) {
  if (!passwordTarget?.frame || !passwordTarget?.locator) return null;
  const frame = passwordTarget.frame;
  const passwordBox = await passwordTarget.locator.boundingBox().catch(() => null);
  const candidates = frame.locator(
    'button, input[type="submit"], input[type="button"], [role="button"], a'
  );
  const maxCandidates = Math.min(await candidates.count().catch(() => 0), 60);

  let bestLocator = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < maxCandidates; index += 1) {
    const locator = candidates.nth(index);
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    const text = String((await locator.innerText().catch(() => '')) || '').trim();
    const value = String((await locator.getAttribute('value').catch(() => '')) || '').trim();
    const label = `${text} ${value}`.toLowerCase();
    if (!label.includes('entrar') && !label.includes('iniciar sess') && !label.includes('autenticar')) continue;

    const box = await locator.boundingBox().catch(() => null);
    if (!box) continue;

    let score = index + 1;
    if (passwordBox) {
      const sameColumnPenalty = Math.abs(box.x - passwordBox.x) > 320 ? 500 : 0;
      const belowPenalty = box.y < passwordBox.y - 40 ? 550 : 0;
      const verticalDistance = Math.abs((box.y || 0) - (passwordBox.y || 0));
      score = verticalDistance + sameColumnPenalty + belowPenalty;
    }

    if (score < bestScore) {
      bestScore = score;
      bestLocator = locator;
    }
  }

  if (!bestLocator) return null;
  return {
    selector: 'heuristic:ss-submit-near-password',
    locator: bestLocator,
    frame,
    frameUrl: String(frame.url() || '').trim(),
    inIframe: frame !== frame.page().mainFrame(),
  };
}

async function findFirstVisibleSelector(page, selectors, options = {}) {
  const match = await findFirstVisibleLocatorTarget(page, selectors, options);
  return match?.selector || null;
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
    try {
      count = await locator.count();
    } catch (_) {
      count = 0;
    }
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
      } catch (_) {
        // ignore and continue
      }
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
      } catch (_) {
        // ignore and keep checking until timeout
      }
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
      } catch (_) {
        // ignore and continue trying
      }
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function ensureSegSocialCredentialsFormVisible(page, timeoutMs = 10_000) {
  const safeTimeout = Math.max(1000, Number(timeoutMs) || 10_000);
  const deadline = Date.now() + safeTimeout;
  const usernameCheckSelectors = [
    'input[name="username"]',
    'input[name="niss"]',
    'input[id*="username" i]',
    'input[name*="user" i]',
    'input[id*="utilizador" i]',
    'input[name*="utilizador" i]',
    'input[id*="niss" i]',
    'input[placeholder*="NISS" i]',
    'input[autocomplete="username"]',
  ];

  const openFormActions = [
    () => page.getByRole('button', { name: /autenticar\s+com\s+utilizador/i }).first(),
    () => page.getByRole('link', { name: /autenticar\s+com\s+utilizador/i }).first(),
    () => page.locator('button', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
    () => page.locator('a', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
    () => page.getByText(/autenticar\s+com\s+utilizador/i).first(),
    () => page.locator('button, a, [role="button"], div, span', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
  ];

  while (Date.now() < deadline) {
    const usernameTarget = await findFirstVisibleLocatorTarget(page, usernameCheckSelectors, {
      waitTimeoutMs: 700,
    });
    if (usernameTarget) return true;

    for (const buildLocator of openFormActions) {
      try {
        const locator = buildLocator();
        if ((await locator.count()) <= 0) continue;
        const visible = await locator.isVisible().catch(() => false);
        if (!visible) continue;
        await locator.click({ timeout: 2000 });
        await page.waitForTimeout(500);
        break;
      } catch (_) {
        // ignore and keep trying
      }
    }

    await clickCookieConsentIfPresent(page, 800);
    await page.waitForTimeout(250);
  }

  return false;
}

async function openSegSocialLoginEntryIfNeeded(page, timeoutMs = 10_000) {
  const safeTimeout = Math.max(1000, Number(timeoutMs) || 10_000);
  const deadline = Date.now() + safeTimeout;
  const loginCtaSelectors = [
    () => page.getByRole('button', { name: /iniciar\s*sess[aã]o/i }).first(),
    () => page.getByRole('link', { name: /iniciar\s*sess[aã]o/i }).first(),
    () => page.locator('button', { hasText: /iniciar\s*sess[aã]o/i }).first(),
    () => page.locator('a', { hasText: /iniciar\s*sess[aã]o/i }).first(),
    () => page.getByRole('button', { name: /autenticar\s+com\s+utilizador/i }).first(),
    () => page.getByRole('link', { name: /autenticar\s+com\s+utilizador/i }).first(),
    () => page.locator('button', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
    () => page.locator('a', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
    () => page.getByText(/autenticar\s+com\s+utilizador/i).first(),
    () => page.locator('button, a, [role="button"], div, span', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
  ];
  const usernameCheckSelectors = [
    'input[name="username"]',
    'input[name="niss"]',
    'input[id*="username" i]',
    'input[name*="user" i]',
    'input[id*="utilizador" i]',
    'input[name*="utilizador" i]',
    'input[autocomplete="username"]',
  ];

  while (Date.now() < deadline) {
    const usernameTarget = await findFirstVisibleLocatorTarget(page, usernameCheckSelectors, {
      waitTimeoutMs: 700,
    });
    if (usernameTarget) return true;

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
      } catch (_) {
        // ignore and continue
      }
    }

    if (!clicked) {
      await page.waitForTimeout(250);
    }
  }
  return false;
}

async function clickContinueWithoutActivatingIfPrompt(page, timeoutMs = 12_000) {
  const safeTimeout = Math.max(1000, Number(timeoutMs) || 12_000);
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
      } catch (_) {
        // ignore and continue until timeout
      }
    }
    await page.waitForTimeout(250);
  }
  return false;
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

  for (const candidate of executableCandidatesByPlatform()) {
    pushExecutableAttempt(attempts, seenAttemptKeys, candidate.label, candidate.path);
  }

  // Ordem preferida no Windows: Edge -> Chrome -> Chromium do Playwright.
  // Assim evitamos depender de ms-playwright em cada utilizador.
  pushChannelAttempt(attempts, seenAttemptKeys, 'Microsoft Edge', 'msedge');
  pushChannelAttempt(attempts, seenAttemptKeys, 'Google Chrome', 'chrome');
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

async function performDesktopFinancasAutologin(payload = {}) {
  const username = String(payload?.username || '').trim();
  const password = String(payload?.password || '').trim();
  const credentialLabel = String(payload?.credentialLabel || 'AT').trim() || 'AT';
  const normalizedCredentialLabel = credentialLabel.toUpperCase();
  if (!username || !password) {
    throw new Error(`Credenciais ${credentialLabel} incompletas para autologin local.`);
  }

  let playwright = null;
  try {
    playwright = require('playwright');
  } catch (_) {
    throw new Error('Módulo de automação indisponível nesta instalação do desktop. Reinstale/atualize a WA PRO Desktop.');
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

  const loginUrl = String(payload?.loginUrl || defaultLoginUrl).trim();
  const targetUrl = String(payload?.targetUrl || defaultTargetUrl).trim();
  const timeoutMs = Math.max(20_000, Math.min(180_000, Number(payload?.timeoutMs || defaultTimeoutMs) || 90_000));
  const closeAfterSubmit = payload?.closeAfterSubmit === true;

  const usernameSelectors = resolveSelectorListFromPayload(
    payload?.usernameSelectors,
    normalizedCredentialLabel === 'SS'
      ? process.env.PORTAL_SEG_SOCIAL_USERNAME_SELECTOR
      : process.env.PORTAL_FINANCAS_USERNAME_SELECTOR,
    normalizedCredentialLabel === 'SS'
      ? 'input[name="username"], input[name="niss"], input[id*="username" i], input[name*="user" i], input[id*="utilizador" i], input[name*="utilizador" i], input[id*="niss" i], input[placeholder*="NISS" i], input[autocomplete="username"]'
      : 'form[name="loginForm"] input[name="username"], input[name="username"], input[placeholder*="Contribuinte"], input[aria-label*="Contribuinte"], input[name="representante"], input[name="nif"], input[type="text"]'
  );
  const passwordSelectors = resolveSelectorListFromPayload(
    payload?.passwordSelectors,
    normalizedCredentialLabel === 'SS'
      ? process.env.PORTAL_SEG_SOCIAL_PASSWORD_SELECTOR
      : process.env.PORTAL_FINANCAS_PASSWORD_SELECTOR,
    normalizedCredentialLabel === 'SS'
      ? 'input[name="password"], input[id*="password" i], input[placeholder*="senha" i], input[type="password"]'
      : 'form[name="loginForm"] input[name="password"], input[name="password"], input[placeholder*="Senha"], input[type="password"]'
  );
  const submitSelectors = resolveSelectorListFromPayload(
    payload?.submitSelectors,
    normalizedCredentialLabel === 'SS'
      ? process.env.PORTAL_SEG_SOCIAL_SUBMIT_SELECTOR
      : process.env.PORTAL_FINANCAS_SUBMIT_SELECTOR,
    normalizedCredentialLabel === 'SS'
      ? 'button[type="submit"], input[type="submit"], button:has-text("Entrar"), button:has-text("Iniciar sessão"), button:has-text("Autenticar"), button:has-text("Continuar")'
      : 'form[name="loginForm"] button[type="submit"], form[name="loginForm"] input[type="submit"], button[type="submit"], input[type="submit"], button:has-text("Autenticar")'
  );
  const successSelectors = resolveSelectorListFromPayload(
    payload?.successSelectors,
    normalizedCredentialLabel === 'SS'
      ? process.env.PORTAL_SEG_SOCIAL_SUCCESS_SELECTOR
      : process.env.PORTAL_FINANCAS_SUCCESS_SELECTOR,
    normalizedCredentialLabel === 'SS'
      ? 'a[href*="logout"], a[href*="sair"], button:has-text("Terminar sessão"), button:has-text("Sair"), [data-testid*="logout"]'
      : 'a[href*="logout"], a[href*="/v2/logout"], [data-testid="logout"], .logout'
  );
  const shouldActivateFinancasNifTab = payload?.activateFinancasNifTab !== false;
  const fallbackExecutablePath =
    normalizedCredentialLabel === 'SS'
      ? String(process.env.PORTAL_SEG_SOCIAL_BROWSER_EXECUTABLE || '').trim()
      : String(process.env.PORTAL_FINANCAS_BROWSER_EXECUTABLE || '').trim();

  const { browser, launcherLabel } = await launchDesktopAutomationBrowser(playwright, {
    ...payload,
    browserExecutablePath: String(payload?.browserExecutablePath || fallbackExecutablePath).trim() || undefined,
  });

  try {
    const context = await browser.newContext({
      viewport: null,
      acceptDownloads: false,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await clickCookieConsentIfPresent(page, 2500);

    if (normalizedCredentialLabel === 'SS') {
      await openSegSocialLoginEntryIfNeeded(page, Math.min(12_000, timeoutMs));
      await ensureSegSocialCredentialsFormVisible(page, Math.min(12_000, timeoutMs));
    }

    if (shouldActivateFinancasNifTab) {
      await activateFinancasNifTab(page);
    }

    let usernameTarget = await findFirstVisibleLocatorTarget(page, usernameSelectors);
    const passwordTarget = await findFirstVisibleLocatorTarget(page, passwordSelectors);
    let submitTarget = await findFirstVisibleLocatorTarget(page, submitSelectors);

    if (normalizedCredentialLabel === 'SS' && !usernameTarget && passwordTarget) {
      usernameTarget = await findLikelyUsernameNearPasswordTarget(passwordTarget);
    }
    if (normalizedCredentialLabel === 'SS' && !submitTarget && passwordTarget) {
      submitTarget = await findLikelySubmitNearPasswordTarget(passwordTarget);
    }

    if (!usernameTarget || !passwordTarget) {
      throw new Error(`Não foi possível localizar os campos de login de ${credentialLabel} no desktop.`);
    }

    await usernameTarget.locator.fill(username);
    await passwordTarget.locator.fill(password);

    if (submitTarget?.locator) {
      await Promise.allSettled([
        page.waitForLoadState('networkidle', { timeout: Math.min(30_000, timeoutMs) }),
        submitTarget.locator.click(),
      ]);
    } else {
      await Promise.allSettled([
        page.waitForLoadState('networkidle', { timeout: Math.min(30_000, timeoutMs) }),
        passwordTarget.locator.press('Enter'),
      ]);
    }

    await clickContinueLoginIf2faPrompt(page, Math.min(12_000, timeoutMs));
    if (normalizedCredentialLabel === 'SS') {
      await clickContinueWithoutActivatingIfPrompt(page, Math.min(18_000, timeoutMs));
    }

    if (targetUrl) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
    }

    const matchedSuccessTarget = await findFirstVisibleLocatorTarget(page, successSelectors, {
      waitTimeoutMs: 1500,
    });
    const matchedSuccessSelector = matchedSuccessTarget?.selector || null;
    const hasPasswordInputAfterSubmit = (await page.locator('input[type="password"]').count()) > 0;
    const loginState = matchedSuccessSelector
      ? 'logged_in'
      : hasPasswordInputAfterSubmit
        ? 'needs_manual_validation'
        : 'unknown';

    if (closeAfterSubmit) {
      await browser.close().catch(() => null);
      return {
        success: true,
        loginState,
        message: 'Autologin local executado. Browser fechado automaticamente.',
      };
    }

    return {
      success: true,
      loginState,
      message: `Autologin local iniciado no desktop (${launcherLabel}).`,
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
    if (req.method !== 'POST' || pathname !== '/financas-autologin') {
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
        const result = await performDesktopFinancasAutologin(payload || {});
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
    width: 1520,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
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
