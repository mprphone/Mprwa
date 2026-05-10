const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, shell, ipcMain, clipboard } = require('electron');
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

async function clickFirstVisibleLocator(page, builders, timeoutMs = 2500) {
  for (const build of Array.isArray(builders) ? builders : []) {
    try {
      const locator = build().first();
      if ((await locator.count()) <= 0) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      await locator.click({ timeout: timeoutMs });
      await page.waitForTimeout(350);
      return true;
    } catch (_) {
      // try next candidate
    }
  }
  return false;
}

async function fillFirstVisibleLocator(page, builders, value, timeoutMs = 2500) {
  for (const build of Array.isArray(builders) ? builders : []) {
    try {
      const locator = build().first();
      if ((await locator.count()) <= 0) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      await locator.fill(String(value || ''), { timeout: timeoutMs });
      return true;
    } catch (_) {
      // try next candidate
    }
  }
  return false;
}

async function pressFirstVisibleLocator(page, builders, key, timeoutMs = 2500) {
  for (const build of Array.isArray(builders) ? builders : []) {
    try {
      const locator = build().first();
      if ((await locator.count()) <= 0) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      await locator.press(String(key || 'Enter'), { timeout: timeoutMs });
      await page.waitForTimeout(350);
      return true;
    } catch (_) {
      // try next candidate
    }
  }
  return false;
}

async function getPageBodyText(page, timeoutMs = 1200) {
  return String(await page.locator('body').innerText({ timeout: timeoutMs }).catch(() => '') || '');
}

async function getSegSocialAllFrameText(page, timeoutMs = 1200) {
  const texts = [];
  for (const frame of page.frames()) {
    const text = await frame.locator('body').innerText({ timeout: timeoutMs }).catch(() => '');
    if (text) texts.push(String(text));
  }
  return texts.join('\n');
}

const SEG_SOCIAL_ACTIVATION_OFFER_TITLE_RE = /a[c]?tiva[cç][aã]o\s+da\s+autentica[cç][aã]o\s+de\s+dois\s+fatores/i;
const SEG_SOCIAL_CONTINUE_WITHOUT_ACTIVATING_RE = /continuar\s+sem\s+a[c]?tivar/i;
const SEG_SOCIAL_ENTERPRISE_SUBUSER_FLOW = 'seg_social_enterprise_subuser_setup';
const SEG_SOCIAL_LEGACY_SUBUSER_FLOW = 'seg_social_subuser_setup';
const SEG_SOCIAL_ACCESS_MANAGEMENT_URL = 'https://www.seg-social.pt/ptss/pssd/menu/gestao-de-acessos';
const SEG_SOCIAL_SUBACCOUNTS_URL = 'https://www.seg-social.pt/ptss/gus/gestao-utilizadores/consultar-utilizadores-subconta';

async function isSegSocialContinueIntermediatePage(page) {
  const url = String(page.url() || '').toLowerCase();
  const bodyText = await getPageBodyText(page, 1200);
  return (
    /seg-social\.pt\/sso\/login/.test(url) && /_eventid=continuar|execution=/.test(url) &&
    (
      /continuar\s+para\s+a\s+seguran[cç]a\s+social\s+direta/i.test(bodyText) ||
      /altere\s+a\s+sua\s+palavra-passe/i.test(bodyText) ||
      /palavra-passe\s+expira/i.test(bodyText)
    )
  );
}

async function detectSegSocialManualRequired(page) {
  const bodyText = await getPageBodyText(page, 1200);
  const hasVisibleCodeInput = await page.locator([
    'input[name*="codigo" i]',
    'input[id*="codigo" i]',
    'input[placeholder*="código" i]',
    'input[placeholder*="codigo" i]',
    'input[aria-label*="código" i]',
    'input[aria-label*="codigo" i]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
  ].join(',')).first().isVisible().catch(() => false);
  const hasStrongCodePrompt = /introduza\s+o\s+c[oó]digo|insira\s+o\s+c[oó]digo|c[oó]digo\s+de\s+(verifica[cç][aã]o|valida[cç][aã]o|seguran[cç]a)|recebeu\s+um\s+c[oó]digo/i.test(bodyText);
  const hasTwoFactorChallenge =
    hasVisibleCodeInput &&
    hasStrongCodePrompt &&
    /duplo\s+fator|duplo\s+factor|2fa|autentica[cç][aã]o|verifica[cç][aã]o|valida[cç][aã]o/i.test(bodyText);
  const manualPatterns = [
    { pattern: /captcha|recaptcha|n[aã]o\s+sou\s+um\s+rob[oô]|valida[cç][aã]o\s+humana/i, reason: 'Validação humana/CAPTCHA detetada.' },
  ];

  if (hasTwoFactorChallenge) {
    return { manualRequired: true, reason: 'Duplo fator de autenticação detetado.' };
  }

  for (const { pattern, reason } of manualPatterns) {
    if (pattern.test(bodyText)) {
      return { manualRequired: true, reason };
    }
  }

  return { manualRequired: false, reason: '' };
}

async function clickSegSocialContinueByDomText(page) {
  return await page.evaluate(() => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const wantedTexts = [
      'continuar para a seguranca social direta',
      'continuar para a seguranca social',
    ];
    const candidates = Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"]'));
    const target = candidates.find((element) => {
      const label = normalize([
        element.innerText,
        element.textContent,
        element.getAttribute('value'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
      ].filter(Boolean).join(' '));
      return wantedTexts.some((wanted) => label.includes(wanted));
    });
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }).catch(() => false);
}

async function waitForSegSocialPostLogin(page, successSelectors, timeoutMs = 120_000) {
  const deadline = Date.now() + Math.max(10_000, Number(timeoutMs) || 120_000);
  while (Date.now() < deadline) {
    const successTarget = await findFirstVisibleLocatorTarget(page, successSelectors, { waitTimeoutMs: 800 }).catch(() => null);
    if (successTarget) return true;
    const manualState = await detectSegSocialManualRequired(page).catch(() => ({ manualRequired: false }));
    if (manualState.manualRequired) return false;
    const continueResult = await clickContinueToSegSocialPrompt(page, 1200).catch((error) => {
      throw error;
    });
    if (continueResult?.manualRequired) return false;
    if (continueResult?.clicked) {
      await page.waitForTimeout(650);
      continue;
    }
    const hasPassword = (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
    const hasAccessArea = await page.locator('a, button, [role="button"]', { hasText: /gest[aã]o de acessos?|área de acesso|area de acesso|subcontas?/i }).first().isVisible().catch(() => false);
    const isIntermediate = await isSegSocialContinueIntermediatePage(page).catch(() => false);
    if (!isIntermediate && (!hasPassword || hasAccessArea)) return true;
    await clickContinueLoginIf2faPrompt(page, 1200).catch(() => false);
    await clickContinueWithoutActivatingIfPrompt(page, 1200).catch(() => false);
    await clickContinuePasswordExpiryPrompt(page, 1200).catch(() => false);
    await page.waitForTimeout(650);
  }
  return false;
}

async function waitForSegSocialAuthenticatedPage(page, timeoutMs = 10_000) {
  const deadline = Date.now() + Math.max(3000, Number(timeoutMs) || 10_000);
  let sawTwoFactorActivationPrompt = false;
  while (Date.now() < deadline) {
    const url = String(page.url() || '').toLowerCase();
    const isSsoLogin = /seg-social\.pt\/sso\/login/.test(url);
    const isPtssPage = /seg-social\.pt\/ptss\//.test(url);

    if (await isSegSocialTwoFactorActivationPrompt(page).catch(() => false)) {
      sawTwoFactorActivationPrompt = true;
      const clickedWithoutActivation = await clickContinueWithoutActivatingIfPrompt(page, 3500).catch(() => false);
      await Promise.race([
        page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => null),
        page.waitForTimeout(500),
      ]);
      if (!clickedWithoutActivation && await isSegSocialTwoFactorActivationPrompt(page).catch(() => false)) {
        return {
          ready: false,
          reason: 'Encontrei o aviso de autenticação de dois fatores, mas não consegui clicar automaticamente em "Continuar sem ativar". Clica no botão branco no browser aberto.',
        };
      }
      continue;
    }

    if (isPtssPage && !isSsoLogin) return { ready: true, reason: '' };

    const manualState = await detectSegSocialManualRequired(page).catch(() => ({ manualRequired: false, reason: '' }));
    if (manualState.manualRequired) {
      return { ready: false, reason: manualState.reason || 'Validação manual necessária.' };
    }

    if (await isSegSocialContinueIntermediatePage(page).catch(() => false)) {
      const continueResult = await clickContinueToSegSocialPrompt(page, 1800).catch(() => ({ clicked: false, manualRequired: false }));
      if (continueResult?.manualRequired) {
        return { ready: false, reason: continueResult.reason || 'Validação manual necessária.' };
      }
      await page.waitForTimeout(300);
      continue;
    }

    const hasPassword = await page.locator('input[type="password"]').first().isVisible({ timeout: 500 }).catch(() => false);
    if (!isSsoLogin && !hasPassword) return { ready: true, reason: '' };

    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 1000 }).catch(() => null),
      page.waitForTimeout(350),
    ]);
  }

  const url = String(page.url() || '').toLowerCase();
  const hasPassword = await page.locator('input[type="password"]').first().isVisible({ timeout: 500 }).catch(() => false);
  if (/seg-social\.pt\/sso\/login/.test(url) && hasPassword) {
    return { ready: false, reason: 'A Segurança Social voltou ao ecrã de login. Confirma se o utilizador/senha da conta principal estão corretos.' };
  }
  if (sawTwoFactorActivationPrompt || await isSegSocialTwoFactorActivationPrompt(page).catch(() => false)) {
    return {
      ready: false,
      reason: 'A Segurança Social continua no aviso de autenticação de dois fatores. Clica em "Continuar sem ativar" no browser aberto e repete o passo.',
    };
  }
  return { ready: false, reason: 'A Segurança Social ainda não terminou a entrada. Tenta novamente dentro de instantes.' };
}

async function dismissSegSocialActivationOfferForSubUser(page, timeoutMs = 8000) {
  const safeTimeout = Math.max(1000, Number(timeoutMs) || 8000);
  const deadline = Date.now() + safeTimeout;
  let sawPrompt = false;

  while (Date.now() < deadline) {
    if (await isSegSocialTwoFactorActivationPrompt(page).catch(() => false)) {
      sawPrompt = true;
      const clicked = await clickContinueWithoutActivatingIfPrompt(page, 3500).catch(() => false);
      await Promise.race([
        page.waitForLoadState('domcontentloaded', { timeout: 3500 }).catch(() => null),
        page.waitForTimeout(650),
      ]);
      const stillOnActivationOffer = await isSegSocialTwoFactorActivationPrompt(page).catch(() => false);
      if (clicked && !stillOnActivationOffer) {
        return true;
      }
      await page.waitForTimeout(300);
      continue;
    }

    if (sawPrompt) return true;
    return false;
  }

  return false;
}

async function hasSegSocialSubAccountsTarget(page) {
  const bodyText = await getPageBodyText(page, 1200);
  return /gerir\s+subcontas|subcontas\s+de\s+utilizadores|utilizadores\s+de\s+empresa|adicionar\s+(utilizador|subconta)/i.test(bodyText);
}

async function navigateSegSocialSubAccountsArea(page) {
  await dismissSegSocialActivationOfferForSubUser(page, 9000).catch(() => false);
  if (await hasSegSocialSubAccountsTarget(page).catch(() => false)) return true;

  await page.goto(SEG_SOCIAL_SUBACCOUNTS_URL, { waitUntil: 'domcontentloaded' }).catch(() => null);
  await page.waitForTimeout(500);
  await dismissSegSocialActivationOfferForSubUser(page, 5000).catch(() => false);
  if (await isSegSocialTwoFactorActivationPrompt(page).catch(() => false)) {
    await page.goto(SEG_SOCIAL_SUBACCOUNTS_URL, { waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.waitForTimeout(500);
  }
  if (await hasSegSocialSubAccountsTarget(page).catch(() => false)) return true;

  await page.goto(SEG_SOCIAL_ACCESS_MANAGEMENT_URL, { waitUntil: 'domcontentloaded' }).catch(() => null);
  await page.waitForTimeout(500);
  await dismissSegSocialActivationOfferForSubUser(page, 5000).catch(() => false);
  await clickFirstVisibleLocator(page, [
    () => page.getByRole('link', { name: /gerir subcontas|subcontas|utilizadores/i }),
    () => page.getByRole('button', { name: /gerir subcontas|subcontas|utilizadores/i }),
    () => page.locator('a, button, [role="button"]', { hasText: /gerir subcontas|subcontas|utilizadores/i }),
  ], 4000);
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => null),
    page.waitForTimeout(650),
  ]);
  if (await hasSegSocialSubAccountsTarget(page).catch(() => false)) return true;

  await page.goto(SEG_SOCIAL_SUBACCOUNTS_URL, { waitUntil: 'domcontentloaded' }).catch(() => null);
  await page.waitForTimeout(500);
  await dismissSegSocialActivationOfferForSubUser(page, 5000).catch(() => false);
  if (await hasSegSocialSubAccountsTarget(page).catch(() => false)) return true;

  await clickFirstVisibleLocator(page, [
    () => page.getByRole('button', { name: /área de acesso|area de acesso|perfil|utilizador|conta|menu/i }),
    () => page.getByRole('link', { name: /área de acesso|area de acesso|perfil|utilizador|conta|menu/i }),
    () => page.locator('button, a, [role="button"]', { hasText: /^[A-Z]{1,3}$/ }),
    () => page.locator('button[aria-label*="perfil" i], button[aria-label*="utilizador" i], button[aria-label*="conta" i]'),
  ], 3500);

  await clickFirstVisibleLocator(page, [
    () => page.getByRole('link', { name: /área de acesso|area de acesso/i }),
    () => page.getByRole('button', { name: /área de acesso|area de acesso/i }),
    () => page.locator('a, button, [role="button"]', { hasText: /área de acesso|area de acesso/i }),
  ], 3500);

  await clickFirstVisibleLocator(page, [
    () => page.getByRole('link', { name: /gest[aã]o de acessos?/i }),
    () => page.getByRole('button', { name: /gest[aã]o de acessos?/i }),
    () => page.locator('a, button, [role="button"]', { hasText: /gest[aã]o de acessos?/i }),
  ], 3500);

  await clickFirstVisibleLocator(page, [
    () => page.getByRole('link', { name: /gerir subcontas|subcontas|subconta|utilizadores de empresa/i }),
    () => page.getByRole('button', { name: /gerir subcontas|subcontas|subconta|utilizadores de empresa/i }),
    () => page.locator('a, button, [role="button"]', { hasText: /gerir subcontas|subcontas|subconta|utilizadores de empresa/i }),
  ], 3500);

  return await hasSegSocialSubAccountsTarget(page).catch(() => false);
}

async function fetchLatestSegSocialActivationCode(payload = {}) {
  const sinceIso = String(payload?.activationSinceIso || '').trim();
  const pollMs = Math.max(0, Number(payload?.emailPollMs || payload?.pollMs || 0) || 0);
  const pollIntervalMs = Math.max(1000, Number(payload?.emailPollIntervalMs || 4000) || 4000);
  const buildQuery = () => {
    const query = new URLSearchParams({
      sinceDays: String(Math.max(1, Number(payload?.sinceDays || 1) || 1)),
      maxMessages: String(Math.max(10, Number(payload?.maxMessages || 60) || 60)),
      activationOnly: payload?.activationOnly === false ? '0' : '1',
    });
    if (payload?.verificationOnly === true) {
      query.set('verificationOnly', '1');
      query.set('activationOnly', '0');
    }
    return query;
  };
  const queryWithSince = buildQuery(true);
  if (sinceIso) queryWithSince.set('sinceIso', sinceIso);
  const queries = [queryWithSince];
  if (sinceIso) {
    const queryWithoutSince = buildQuery(false);
    if (payload?.verificationOnly === true) {
      queryWithoutSince.set('verificationOnly', '1');
      queryWithoutSince.set('activationOnly', '0');
    }
    queries.push(queryWithoutSince);
  }

  const localPort = String(process.env.PORT || process.env.ELECTRON_LOCAL_PORT || DEFAULT_PORT || '').trim();
  const localApiBase = localPort ? `http://127.0.0.1:${localPort}` : '';
  const candidateBases = [
    payload?.apiBaseUrl,
    process.env.ELECTRON_API_BASE_URL,
    process.env.WA_PRO_API_BASE_URL,
    localApiBase,
    DEFAULT_CLOUD_URL.split('#')[0],
  ]
    .map((value) => normalizeBaseUrl(String(value || '').trim()))
    .filter((value) => /^https?:\/\//i.test(value));
  const uniqueBases = Array.from(new Set(candidateBases));
  const deadline = Date.now() + pollMs;

  do {
    for (const baseUrl of uniqueBases) {
      for (const query of queries) {
        try {
          const response = await requestJson(
            joinUrl(baseUrl, `/api/email/seg-social/latest-code?${query.toString()}`),
            18_000
          );
          const code = String(response?.result?.code || '').trim();
          if (response?.success && code) return code;
        } catch (error) {
          console.warn('[Electron] Não consegui ler código SS por IMAP:', error?.message || error);
        }
      }
    }
    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(250, deadline - Date.now()))));
    }
  } while (Date.now() < deadline);

  return '';
}

async function clickSegSocialButtonByText(page, pattern, timeoutMs = 6000) {
  return clickFirstVisibleLocator(page, [
    () => page.getByRole('button', { name: pattern }),
    () => page.getByRole('link', { name: pattern }),
    () => page.locator('button, a, input[type="submit"], input[type="button"]', { hasText: pattern }),
    () => page.locator('input[type="submit"], input[type="button"]').filter({ hasText: pattern }),
  ], timeoutMs);
}

async function fillSegSocialDescription(page, value = 'Contabilidade') {
  const filledByLocator = await fillFirstVisibleLocator(page, [
    () => page.getByLabel(/descri[cç][aã]o/i),
    () => page.locator('input[name*="descr" i], input[id*="descr" i], textarea[name*="descr" i], textarea[id*="descr" i]'),
    () => page.locator('input[type="text"], textarea, input:not([type])'),
  ], value, 5000);
  if (filledByLocator) return true;

  return await page.evaluate((description) => {
    const normalize = (text) => String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    const target = inputs.find((element) => {
      if (element.disabled || element.readOnly || element.type === 'hidden') return false;
      const label = [
        element.name,
        element.id,
        element.placeholder,
        element.getAttribute('aria-label'),
        element.labels ? Array.from(element.labels).map((item) => item.textContent || '').join(' ') : '',
      ].join(' ');
      return normalize(label).includes('descricao');
    }) || inputs.find((element) => !element.disabled && !element.readOnly && element.type !== 'hidden');
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.focus();
    target.value = String(description || '');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, value).catch(() => false);
}

function isLikelySegSocialTokenSecret(value) {
  const text = String(value || '').trim();
  return /\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}\b/.test(text) || /^[A-Za-z0-9._=-]{80,5000}$/.test(text);
}

function isLikelySegSocialApplicationAuthSecret(value) {
  const text = String(value || '').trim();
  const lower = text.toLowerCase();
  const rejectedWords = new Set([
    'function',
    'return',
    'const',
    'class',
    'undefined',
    'object',
    'string',
    'number',
    'boolean',
    'promise',
  ]);
  return text.length >= 12 &&
    text.length <= 128 &&
    /^[A-Za-z0-9._=-]+$/.test(text) &&
    !/^eyJ/i.test(text) &&
    !text.includes('.') &&
    !rejectedWords.has(lower) &&
    !/contabilidade|copiar|voltar|cria[cç][aã]o|autentica[cç][aã]o|token/i.test(text);
}

function isExpectedSegSocialGeneratedSecret(value, kind = 'token') {
  return kind === 'app'
    ? isLikelySegSocialApplicationAuthSecret(value)
    : isLikelySegSocialTokenSecret(value);
}

async function readSegSocialClipboardText(page) {
  const systemValue = String(clipboard.readText() || '').trim();
  if (systemValue) return systemValue;
  const pageValue = await page.evaluate(async () => {
    try {
      return String(await navigator.clipboard.readText() || '').trim();
    } catch {
      return '';
    }
  }).catch(() => '');
  return pageValue;
}

async function writeSegSocialClipboardMarker(page, marker) {
  clipboard.writeText(String(marker || ''));
}

async function readSegSocialClipboardCandidates(page) {
  const candidates = [
    String(clipboard.readText() || '').trim(),
    await page.evaluate(async () => {
      try {
        return String(await navigator.clipboard.readText() || '').trim();
      } catch {
        return '';
      }
    }).catch(() => ''),
  ];
  return Array.from(new Set(candidates.map((item) => String(item || '').trim()).filter(Boolean)));
}

async function clickSegSocialCopyGeneratedSecretButton(page, kind = 'token') {
  const isApp = kind === 'app';
  const pattern = isApp ? /copiar\s+autentica[cç][aã]o/i : /copiar\s+token/i;
  const clickedByRole = await clickSegSocialButtonByText(page, pattern, 5000).catch(() => false);
  if (clickedByRole) return true;

  return page.evaluate((isApplicationAuth) => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const wanted = isApplicationAuth ? 'copiar autenticacao' : 'copiar token';
    const candidates = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'));
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 5 &&
        rect.height > 5 &&
        !element.disabled;
    };
    const target = candidates.find((element) => {
      if (!isVisible(element)) return false;
      const label = normalize([
        element.textContent,
        element.getAttribute('value'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('name'),
      ].filter(Boolean).join(' '));
      return label.includes(wanted);
    });
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }, isApp).catch(() => false);
}

async function waitForSegSocialCopiedSecret(page, kind = 'token', marker = '', timeoutMs = 5000) {
  const secretKind = kind === 'app' ? 'app' : 'token';
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 5000);
  while (Date.now() < deadline) {
    const clipboardValues = await readSegSocialClipboardCandidates(page);
    for (const clipboardValue of clipboardValues) {
      if (
        clipboardValue &&
        clipboardValue !== marker &&
        isExpectedSegSocialGeneratedSecret(clipboardValue, secretKind)
      ) {
        return clipboardValue;
      }
    }
    await page.waitForTimeout(180);
  }
  return '';
}

async function extractVisibleSegSocialGeneratedSecret(page, kind = 'token') {
  return page.evaluate((secretKind) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 5 &&
        rect.height > 5 &&
        !element.disabled;
    };
    const isToken = (value) => /\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}\b/.test(value) || /^[A-Za-z0-9._=-]{80,5000}$/.test(value);
    const isApp = (value) => value.length >= 8 &&
      value.length <= 128 &&
      /^[A-Za-z0-9._=-]+$/.test(value) &&
      !/^eyJ/i.test(value) &&
      !value.includes('.') &&
      !/contabilidade|copiar|voltar|criacao|criação|autenticacao|autenticação|token/i.test(value);

    const elements = Array.from(document.querySelectorAll('input, textarea, pre, code, output, div, p, span'))
      .filter((element) => isVisible(element));
    const rawValues = elements.flatMap((element) => {
      const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : element.textContent;
      const text = normalize(value);
      if (!text) return [];
      const values = [text];
      const compactMatches = text.match(/[A-Za-z0-9._=-]{8,5000}/g) || [];
      return values.concat(compactMatches);
    })
      .map(normalize)
      .filter(Boolean);

    if (secretKind === 'token') {
      const jwt = rawValues.find((value) => /\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}\b/.test(value));
      if (jwt) return jwt.match(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}\b/)?.[0] || jwt;
      return rawValues.filter(isToken).sort((a, b) => b.length - a.length)[0] || '';
    }

    return rawValues.filter(isApp).sort((a, b) => a.length - b.length)[0] || '';
  }, kind === 'app' ? 'app' : 'token').catch(() => '');
}

async function extractSegSocialGeneratedSecret(page, kind = 'token') {
  const secretKind = kind === 'app' ? 'app' : 'token';
  const clipboardMarker = `__WA_PRO_COPY_${secretKind}_${Date.now()}__`;
  await writeSegSocialClipboardMarker(page, clipboardMarker).catch(() => null);

  const clickedCopy = await clickSegSocialCopyGeneratedSecretButton(page, secretKind).catch(() => false);
  if (clickedCopy) await page.waitForTimeout(350);

  const clipboardValue = await waitForSegSocialCopiedSecret(page, secretKind, clipboardMarker, 5000);
  if (clipboardValue) return clipboardValue;

  // A autenticação aplicacional deve vir do botão "Copiar autenticação".
  // Não usamos fallback visual aqui para evitar guardar textos da página como "function".
  if (secretKind === 'app') return '';

  const visibleValue = await extractVisibleSegSocialGeneratedSecret(page, secretKind);
  if (isExpectedSegSocialGeneratedSecret(visibleValue, secretKind)) return visibleValue;

  return '';
}

async function extractSegSocialValidityForDescription(page, description = 'Contabilidade') {
  const descriptionText = String(description || '').trim();
  return await page.evaluate((desc) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const rows = Array.from(document.querySelectorAll('tr, .row, div'));
    for (const row of rows) {
      const text = normalize(row.textContent || '');
      if (!desc || !text.toLowerCase().includes(desc.toLowerCase())) continue;
      const dates = text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
      if (dates.length >= 2) return dates[1];
      if (dates.length === 1) return dates[0];
    }
    return '';
  }, descriptionText).catch(() => '');
}

async function openSegSocialAuthManagement(page) {
  if (/\/ptss\/gus\/consultar-token/i.test(String(page.url() || ''))) return true;
  const isActivationSuccess = await isSegSocialTwoFactorActivationSuccessPage(page).catch(() => false);
  const clicked = await clickSegSocialButtonByText(
    page,
    /ir\s+para\s+a\s+[aá]rea\s+de\s+gest[aã]o\s+de\s+autentica[cç][aã]o/i,
    isActivationSuccess ? 2500 : 6000
  ).catch(() => false);
  if (clicked) {
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: isActivationSuccess ? 4000 : 8000 }).catch(() => null),
      page.waitForTimeout(isActivationSuccess ? 700 : 1500),
    ]);
  }
  const bodyText = await getPageBodyText(page, 1200);
  if (/gest[aã]o\s+de\s+autentica[cç][aã]o|m[eé]todos\s+de\s+autentica[cç][aã]o/i.test(bodyText)) return true;
  await page.goto('https://www.seg-social.pt/ptss/gus/consultar-tokens-ee', { waitUntil: 'domcontentloaded' }).catch(() => null);
  await page.waitForTimeout(isActivationSuccess ? 700 : 1500);
  return /gest[aã]o\s+de\s+autentica[cç][aã]o|m[eé]todos\s+de\s+autentica[cç][aã]o/i.test(await getPageBodyText(page, 1200));
}

async function isSegSocialTokenCreationPage(page) {
  const url = String(page.url() || '');
  const bodyText = await getPageBodyText(page, 1200);
  return /\/ptss\/gus\/criar-token/i.test(url) || /cria[cç][aã]o\s+do\s+token\s+de\s+acesso|descri[cç][aã]o\s+do\s+token/i.test(bodyText);
}

async function isSegSocialApplicationAuthCreationPage(page) {
  const url = String(page.url() || '');
  const bodyText = await getPageBodyText(page, 1200);
  return /\/ptss\/gus\/criar-token-aplicacional/i.test(url) || /cria[cç][aã]o\s+da\s+autentica[cç][aã]o\s+aplicacional|descri[cç][aã]o\s+da\s+autentica[cç][aã]o/i.test(bodyText);
}

async function clickSegSocialButtonByExactDomText(page, wantedPattern) {
  return await page.evaluate((patternSource) => {
    const pattern = new RegExp(patternSource, 'i');
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const candidates = Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"]'));
    const target = candidates.find((element) => {
      const label = normalize([
        element.textContent,
        element.getAttribute('value'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
      ].filter(Boolean).join(' '));
      return pattern.test(label);
    });
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }, String(wantedPattern?.source || wantedPattern || '')).catch(() => false);
}

async function showSegSocialAutomationHint(page, message) {
  const text = String(message || '').trim();
  if (!text) return false;
  return page.evaluate((hintText) => {
    const id = 'wa-pro-seg-social-automation-hint';
    document.getElementById(id)?.remove();
    const banner = document.createElement('div');
    banner.id = id;
    banner.textContent = hintText;
    banner.style.position = 'fixed';
    banner.style.zIndex = '2147483647';
    banner.style.left = '50%';
    banner.style.bottom = '24px';
    banner.style.transform = 'translateX(-50%)';
    banner.style.maxWidth = '720px';
    banner.style.padding = '14px 18px';
    banner.style.borderRadius = '10px';
    banner.style.border = '2px solid #f59e0b';
    banner.style.background = '#fffbeb';
    banner.style.color = '#111827';
    banner.style.font = '600 15px/1.4 Arial, sans-serif';
    banner.style.boxShadow = '0 16px 45px rgba(15, 23, 42, 0.28)';
    document.body.appendChild(banner);
    return true;
  }, text).catch(() => false);
}

async function isSegSocialTwoFactorActivationCompleted(page) {
  const bodyText = await getSegSocialAllFrameText(page, 1500);
  return /ativa[cç][aã]o\s+da\s+autentica[cç][aã]o\s+de\s+dois\s+fatores\s+conclu[ií]da|autentica[cç][aã]o\s+de\s+dois\s+fatores\s+conclu[ií]da|gest[aã]o\s+de\s+autentica[cç][aã]o|m[eé]todos\s+de\s+autentica[cç][aã]o/i.test(bodyText);
}

async function isSegSocialTwoFactorActivationSuccessPage(page) {
  const bodyText = await getSegSocialAllFrameText(page, 900);
  return /ativa[cç][aã]o\s+da\s+autentica[cç][aã]o\s+de\s+dois\s+fatores\s+conclu[ií]da|autentica[cç][aã]o\s+de\s+dois\s+fatores\s+conclu[ií]da/i.test(bodyText);
}

async function getSegSocialActivationCodeInputValue(page) {
  return page.locator([
    'input[name*="codigo" i]',
    'input[id*="codigo" i]',
    'input[placeholder*="código" i]',
    'input[placeholder*="codigo" i]',
    'input[aria-label*="código" i]',
    'input[aria-label*="codigo" i]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
  ].join(',')).evaluateAll((elements) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 5 && rect.height > 5 && !element.disabled;
    };
    const target = elements.find(visible);
    return target ? String(target.value || '').trim() : '';
  }).catch(() => '');
}

async function clickSegSocialActivateTwoFactorButton(page, timeoutMs = 5000) {
  return await clickSegSocialButtonByText(page, /ativar\s+autentica[cç][aã]o\s+de\s+dois\s+fatores/i, timeoutMs).catch(() => false) ||
    await clickSegSocialButtonByText(page, /confirmar|validar|continuar/i, Math.min(3000, Math.max(1000, timeoutMs))).catch(() => false);
}

async function waitForManualSegSocialTwoFactorCode(page, reason, timeoutMs = 120_000) {
  await showSegSocialAutomationHint(
    page,
    'WA PRO: não consegui ler o código automaticamente. Escreve o código recebido no email e deixa esta janela aberta; eu tento continuar sozinho.'
  );
  const deadline = Date.now() + Math.max(15_000, Number(timeoutMs) || 120_000);
  let clickedAfterManualCode = false;

  while (Date.now() < deadline) {
    if (await isSegSocialTwoFactorActivationCompleted(page).catch(() => false)) {
      return { activated: true, manualCodeUsed: true };
    }

    const pageText = await getSegSocialAllFrameText(page, 1200).catch(() => '');
    if (/captcha|recaptcha|n[aã]o\s+sou\s+um\s+rob[oô]|valida[cç][aã]o\s+humana/i.test(pageText)) {
      return {
        activated: false,
        manualRequired: true,
        stage: 'ativar_2fa_validacao_manual',
        reason: 'Foi detetada validação humana/CAPTCHA. Resolve manualmente no browser aberto.',
      };
    }

    const typedCode = await getSegSocialActivationCodeInputValue(page);
    if (!clickedAfterManualCode && /^[A-Za-z0-9-]{4,20}$/.test(typedCode)) {
      clickedAfterManualCode = await clickSegSocialActivateTwoFactorButton(page, 5000);
      await Promise.race([
        page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
        page.waitForTimeout(1200),
      ]);
      continue;
    }

    await page.waitForTimeout(800);
  }

  return {
    activated: false,
    manualRequired: true,
    stage: 'ativar_2fa_codigo_email',
    reason: reason || 'Não consegui ler o código no email. Insere o código no browser aberto e clica em "Ativar autenticação de dois fatores".',
  };
}

async function activateSegSocialTwoFactorIfPrompt(page, payload = {}) {
  const bodyText = await getSegSocialAllFrameText(page, 1500);
  if (/ativa[cç][aã]o\s+da\s+autentica[cç][aã]o\s+de\s+dois\s+fatores\s+conclu[ií]da/i.test(bodyText)) return { activated: true };
  if (!/ativa[cç][aã]o\s+da\s+autentica[cç][aã]o\s+de\s+dois\s+fatores/i.test(bodyText)) return { activated: false };

  const verificationRequestedAt = new Date(Date.now() - 2 * 60_000).toISOString();
  await clickSegSocialButtonByText(page, /continuar\s+para\s+ativar/i, 6000).catch(() => false);
  await page.waitForTimeout(1200);

  const code = await fetchLatestSegSocialActivationCode({
    ...payload,
    activationOnly: false,
    activationSinceIso: verificationRequestedAt,
    emailPollMs: Number(payload?.emailPollMs || 45_000) || 45_000,
    maxMessages: Number(payload?.maxMessages || 80) || 80,
  });
  if (!code) {
    return await waitForManualSegSocialTwoFactorCode(
      page,
      'Entrei com o subutilizador e pedi o código de verificação, mas não consegui ler o código no email geral@mpr.pt. Escreve o código no browser aberto; se o portal avançar, eu continuo para criar o token.',
      Number(payload?.manualCodeTimeoutMs || 120_000) || 120_000
    );
  }

  await fillSegSocialActivationCode(page, code);
  const clickedActivate = await clickSegSocialActivateTwoFactorButton(page, 6000);
  if (!clickedActivate) {
    return await waitForManualSegSocialTwoFactorCode(
      page,
      `Código de verificação preenchido: ${code}. Clica em "Ativar autenticação de dois fatores"; se o portal avançar, eu continuo para criar o token.`,
      Number(payload?.manualCodeTimeoutMs || 120_000) || 120_000
    );
  }
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => null),
    page.waitForTimeout(2000),
  ]);
  if (!(await isSegSocialTwoFactorActivationCompleted(page).catch(() => false))) {
    const manualResult = await waitForManualSegSocialTwoFactorCode(
      page,
      'Preenchi/submeti o código, mas o portal ainda não confirmou a ativação. Se houver erro no código, corrige no browser; se avançar, eu continuo para criar o token.',
      60_000
    );
    if (manualResult?.manualRequired) return manualResult;
  }
  const afterText = await getSegSocialAllFrameText(page, 1500);
  return {
    activated: /conclu[ií]da|gest[aã]o\s+de\s+autentica[cç][aã]o/i.test(afterText),
    activationCode: code,
  };
}

async function createSegSocialToken(page, description = 'Contabilidade') {
  if (!(await isSegSocialTokenCreationPage(page).catch(() => false))) {
    await openSegSocialAuthManagement(page);
    await clickSegSocialButtonByText(page, /tokens?\s+de\s+acesso/i, 3500).catch(() => false);
    await page.waitForTimeout(350);
    const createClicked = await clickSegSocialButtonByText(page, /criar\s+token\s+de\s+acesso/i, 6000);
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
      page.waitForTimeout(650),
    ]);
    if (!createClicked && !(await isSegSocialTokenCreationPage(page).catch(() => false))) {
      await clickSegSocialButtonByExactDomText(page, /criar\s+token\s+de\s+acesso/).catch(() => false);
      await Promise.race([
        page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
        page.waitForTimeout(650),
      ]);
    }
  }
  if (!(await isSegSocialTokenCreationPage(page).catch(() => false))) {
    return { stage: 'token_abrir_criacao', manualRequired: true, reason: 'Não encontrei o botão "Criar token de acesso".' };
  }
  const filledDescription = await fillSegSocialDescription(page, description);
  await page.waitForTimeout(150);
  if (!filledDescription) {
    return { stage: 'token_descricao', manualRequired: true, reason: 'Cheguei à criação do token, mas não consegui preencher a descrição. Escreve "Contabilidade" e clica em "Criar token".' };
  }
  const confirmClicked =
    await clickSegSocialButtonByText(page, /^criar\s+token$/i, 6000) ||
    await clickSegSocialButtonByExactDomText(page, /^criar\s+token$/i);
  if (!confirmClicked) {
    return { stage: 'token_confirmar_criacao', manualRequired: true, reason: 'Preenchi a descrição do token. Clica em "Criar token".' };
  }
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => null),
    page.waitForTimeout(900),
  ]);
  const token = await extractSegSocialGeneratedSecret(page, 'token');
  const backClicked = await clickSegSocialButtonByText(page, /voltar\s+para\s+a\s+[aá]rea\s+de\s+gest[aã]o\s+de\s+autentica[cç][aã]o/i, 6000).catch(() => false);
  if (backClicked) {
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
      page.waitForTimeout(650),
    ]);
  }
  const validUntil = await extractSegSocialValidityForDescription(page, description);
  return {
    stage: token ? 'token_criado' : 'token_copiar',
    manualRequired: !token,
    token: token || undefined,
    validUntil: validUntil || undefined,
    reason: token ? '' : 'Token criado, mas não consegui copiar o valor automaticamente. Copia o token para a ficha do cliente antes de voltar.',
  };
}

async function createSegSocialApplicationAuth(page, description = 'Contabilidade') {
  if (!(await isSegSocialApplicationAuthCreationPage(page).catch(() => false))) {
    await openSegSocialAuthManagement(page);
    await clickSegSocialButtonByText(page, /autentica[cç][aã]o\s+aplicacional/i, 5000).catch(() => false);
    await page.waitForTimeout(350);
    const createClicked = await clickSegSocialButtonByText(page, /criar\s+autentica[cç][aã]o\s+aplicacional/i, 6000);
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
      page.waitForTimeout(650),
    ]);
    if (!createClicked && !(await isSegSocialApplicationAuthCreationPage(page).catch(() => false))) {
      await clickSegSocialButtonByExactDomText(page, /criar\s+autenticacao\s+aplicacional/).catch(() => false);
      await Promise.race([
        page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
        page.waitForTimeout(650),
      ]);
    }
  }
  if (!(await isSegSocialApplicationAuthCreationPage(page).catch(() => false))) {
    return { stage: 'app_auth_abrir_criacao', manualRequired: true, reason: 'Não encontrei o botão "Criar autenticação aplicacional". Pode já existir uma autenticação ativa.' };
  }
  const filledDescription = await fillSegSocialDescription(page, description);
  await page.waitForTimeout(150);
  if (!filledDescription) {
    return { stage: 'app_auth_descricao', manualRequired: true, reason: 'Cheguei à criação da autenticação aplicacional, mas não consegui preencher a descrição. Escreve "Contabilidade" e clica em "Criar autenticação".' };
  }
  const confirmClicked =
    await clickSegSocialButtonByText(page, /^criar\s+autentica[cç][aã]o$/i, 6000) ||
    await clickSegSocialButtonByExactDomText(page, /^criar\s+autenticacao$/i);
  if (!confirmClicked) {
    return { stage: 'app_auth_confirmar_criacao', manualRequired: true, reason: 'Preenchi a descrição da autenticação aplicacional. Clica em "Criar autenticação".' };
  }
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => null),
    page.waitForTimeout(900),
  ]);
  const appAuth = await extractSegSocialGeneratedSecret(page, 'app');
  const backClicked = await clickSegSocialButtonByText(page, /voltar\s+para\s+a\s+[aá]rea\s+de\s+gest[aã]o\s+de\s+autentica[cç][aã]o/i, 6000).catch(() => false);
  if (backClicked) {
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
      page.waitForTimeout(650),
    ]);
  }
  await clickSegSocialButtonByText(page, /autentica[cç][aã]o\s+aplicacional/i, 3000).catch(() => false);
  const validUntil = await extractSegSocialValidityForDescription(page, description);
  return {
    stage: appAuth ? 'app_auth_criada' : 'app_auth_copiar',
    manualRequired: !appAuth,
    appAuth: appAuth || undefined,
    validUntil: validUntil || undefined,
    reason: appAuth ? '' : 'Autenticação aplicacional criada, mas não consegui copiar o valor automaticamente. Copia a autenticação para a ficha do cliente antes de voltar.',
  };
}

async function runSegSocialActivationTokenSetupFlow(page, payload = {}) {
  const description = String(payload?.tokenDescription || 'Contabilidade').trim() || 'Contabilidade';
  const twoFactor = await activateSegSocialTwoFactorIfPrompt(page, payload);
  if (twoFactor?.manualRequired) return twoFactor;

  const managementOpened = await openSegSocialAuthManagement(page);
  if (!managementOpened) {
    return {
      stage: 'gestao_autenticacao',
      manualRequired: true,
      reason: 'Ativei/entrei na conta, mas não consegui abrir a área de gestão de autenticação. Clica em "Ir para a área de gestão de autenticação".',
    };
  }

  const tokenResult = await createSegSocialToken(page, description);
  if (tokenResult?.manualRequired) return tokenResult;

  const appAuthResult = await createSegSocialApplicationAuth(page, description);
  return {
    stage: appAuthResult?.manualRequired ? appAuthResult.stage : 'token_e_app_auth_criados',
    success: !appAuthResult?.manualRequired,
    manualRequired: Boolean(appAuthResult?.manualRequired),
    reason: appAuthResult?.reason || '',
    token: tokenResult?.token,
    tokenValidUntil: tokenResult?.validUntil,
    appAuth: appAuthResult?.appAuth,
    appAuthValidUntil: appAuthResult?.validUntil,
  };
}

async function selectSegSocialSubAccountActivationOption(page) {
  const clicked = await clickFirstVisibleLocator(page, [
    () => page.getByLabel(/subcontas?\s+ou\s+outros/i),
    () => page.getByText(/subcontas?\s+ou\s+outros/i),
    () => page.locator('label', { hasText: /subcontas?\s+ou\s+outros/i }),
  ], 5000);
  if (clicked) return true;

  return await page.evaluate(() => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const labels = Array.from(document.querySelectorAll('label, div, span'));
    const target = labels.find((element) => normalize(element.textContent || '').includes('subcontas ou outros'));
    if (!target) return false;
    const inputId = target.getAttribute('for');
    const linkedInput = inputId ? document.getElementById(inputId) : null;
    const input = linkedInput || target.querySelector('input[type="radio"]') || target.closest('label')?.querySelector('input[type="radio"]');
    const clickable = input || target;
    clickable.scrollIntoView({ block: 'center', inline: 'center' });
    clickable.click();
    return true;
  }).catch(() => false);
}

async function fillSegSocialActivationCode(page, code) {
  const cleanCode = String(code || '').trim();
  if (!cleanCode) return false;
  return fillFirstVisibleLocator(page, [
    () => page.getByLabel(/c[oó]digo\s+de\s+verifica[cç][aã]o/i),
    () => page.locator('input[name*="codigo" i], input[id*="codigo" i], input[placeholder*="código" i], input[placeholder*="codigo" i]'),
    () => page.locator('input[type="text"], input:not([type])'),
  ], cleanCode, 5000);
}

async function isSegSocialEmailVerificationCodeChallenge(page) {
  const bodyText = await getSegSocialAllFrameText(page, 1200).catch(() => '');
  const hasStrongEmailCodePrompt = (
    /autentica[cç][aã]o\s+de\s+dois\s+fatores/i.test(bodyText) ||
    /c[oó]digo\s+de\s+verifica[cç][aã]o\s+de\s+e-?mail/i.test(bodyText) ||
    /vai\s+receber\s+um\s+c[oó]digo\s+de\s+verifica[cç][aã]o\s+no\s+seu\s+e-?mail/i.test(bodyText) ||
    /confirmar\s+c[oó]digo\s+de\s+verifica[cç][aã]o/i.test(bodyText)
  );
  if (!hasStrongEmailCodePrompt) return false;

  const hasCodeInput = await page.locator([
    'input[name*="codigo" i]',
    'input[id*="codigo" i]',
    'input[placeholder*="código" i]',
    'input[placeholder*="codigo" i]',
    'input[aria-label*="código" i]',
    'input[aria-label*="codigo" i]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[type="text"]',
    'input:not([type])',
  ].join(',')).first().isVisible({ timeout: 800 }).catch(() => false);

  return hasCodeInput;
}

async function clickSegSocialConfirmEmailVerificationCodeButton(page, timeoutMs = 6000) {
  const confirmPattern = /confirmar\s+c[oó]digo\s+de\s+verifica[cç][aã]o|ativar\s+autentica[cç][aã]o\s+de\s+dois\s+fatores?|ativar\s+autentica[cç][aã]o\s+de\s+dois\s+factores?|confirmar|validar|continuar/i;
  return await clickSegSocialButtonByText(page, confirmPattern, timeoutMs).catch(() => false) ||
    await clickSegSocialButtonByExactDomText(page, confirmPattern).catch(() => false) ||
    await page.evaluate((patternSource) => {
      const pattern = new RegExp(patternSource, 'i');
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 5 && rect.height > 5 && !element.disabled;
      };
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]'));
      const target = candidates.find((element) => {
        if (!isVisible(element)) return false;
        const label = normalize([
          element.innerText,
          element.textContent,
          element.getAttribute('value'),
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
        ].filter(Boolean).join(' '));
        return pattern.test(label);
      });
      if (!target) return false;
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return true;
    }, confirmPattern.source).catch(() => false) ||
    await page.locator([
      'input[name*="codigo" i]',
      'input[id*="codigo" i]',
      'input[placeholder*="código" i]',
      'input[placeholder*="codigo" i]',
      'input[inputmode="numeric"]',
      'input[type="tel"]',
    ].join(',')).first().press('Enter', { timeout: 2500 }).then(() => true).catch(() => false);
}

async function handleSegSocialEmailVerificationCodeChallenge(page, payload = {}, requestedSinceIso = '') {
  const waitUntil = Date.now() + Math.max(1000, Number(payload?.emailChallengeWaitMs || 5000) || 5000);
  while (Date.now() < waitUntil) {
    if (await isSegSocialEmailVerificationCodeChallenge(page).catch(() => false)) break;
    await page.waitForTimeout(350);
  }

  if (!(await isSegSocialEmailVerificationCodeChallenge(page).catch(() => false))) {
    return { handled: false, manualRequired: false, reason: '' };
  }

  const code = await fetchLatestSegSocialActivationCode({
    ...payload,
    activationOnly: false,
    verificationOnly: true,
    activationSinceIso: requestedSinceIso || payload.activationSinceIso,
    sinceDays: Number(payload?.sinceDays || 1) || 1,
    maxMessages: Number(payload?.maxMessages || 80) || 80,
    emailPollMs: Number(payload?.emailPollMs || 45_000) || 45_000,
    emailPollIntervalMs: Number(payload?.emailPollIntervalMs || 3000) || 3000,
  });

  if (!code) {
    await showSegSocialAutomationHint(
      page,
      'WA PRO: não consegui ler automaticamente o código do email. Escreve o código recebido e deixa esta janela aberta; eu tento continuar.'
    ).catch(() => false);
    return {
      handled: true,
      manualRequired: true,
      reason: 'A Segurança Social pediu código por email, mas não consegui ler o código automaticamente. Insere o código no browser aberto e clica em confirmar.',
    };
  }

  const filled = await fillSegSocialActivationCode(page, code);
  if (!filled) {
    await showSegSocialAutomationHint(
      page,
      `WA PRO: encontrei o código ${code}, mas não consegui preencher o campo. Escreve-o no browser e confirma.`
    ).catch(() => false);
    return {
      handled: true,
      manualRequired: true,
      reason: `Encontrei o código por email (${code}), mas não consegui preencher o campo automaticamente.`,
    };
  }

  const confirmed = await clickSegSocialConfirmEmailVerificationCodeButton(page, 7000);
  if (!confirmed) {
    await showSegSocialAutomationHint(
      page,
      `WA PRO: preenchi o código ${code}. Clica em "Ativar autenticação de dois fatores" para continuar.`
    ).catch(() => false);
    return {
      handled: true,
      manualRequired: true,
      reason: `Preenchi o código de email (${code}), mas não consegui clicar em "Ativar autenticação de dois fatores".`,
    };
  }

  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => null),
    page.waitForTimeout(1800),
  ]);

  return { handled: true, manualRequired: false, reason: '', code };
}

async function clickSegSocialLogout(page) {
  const openInitialsMenu = async () => {
    const openedByLocator = await clickFirstVisibleLocator(page, [
      () => page.getByRole('button', { name: /^[A-Z]{1,3}$/i }),
      () => page.getByRole('link', { name: /^[A-Z]{1,3}$/i }),
      () => page.locator('button, a, [role="button"]').filter({ hasText: /^[A-Z]{1,3}$/i }),
      () => page.locator('[aria-label*="perfil" i], [aria-label*="utilizador" i], [aria-label*="conta" i]'),
    ], 4000).catch(() => false);
    if (openedByLocator) return true;

    return await page.evaluate(() => {
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 10 && rect.height > 10;
      };
      const isLikelyInitials = (value) => /^[A-Z]{1,3}$/.test(normalize(value));
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
        .filter((element) => isVisible(element) && isLikelyInitials(element.textContent || element.getAttribute('aria-label') || ''))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const rightScore = window.innerWidth - rect.left;
          return { element, rect, score: rect.top * 10 + rightScore };
        })
        .filter(({ rect }) => rect.left > window.innerWidth * 0.45 && rect.top < window.innerHeight * 0.45)
        .sort((a, b) => a.score - b.score);
      const target = candidates[0]?.element;
      if (!target) return false;
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return true;
    }).catch(() => false);
  };

  const clickLogout = async () => clickFirstVisibleLocator(page, [
    () => page.getByRole('button', { name: /terminar\s+sess[aã]o|sair|logout/i }),
    () => page.getByRole('link', { name: /terminar\s+sess[aã]o|sair|logout/i }),
    () => page.locator('button, a, [role="button"]', { hasText: /terminar\s+sess[aã]o|sair|logout/i }),
  ], 5000);
  const clickLogoutByDom = async () => page.evaluate(() => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const target = Array.from(document.querySelectorAll('a, button, [role="button"], li, div'))
      .find((element) => normalize(element.textContent || element.getAttribute('aria-label') || '') === 'terminar sessao');
    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }).catch(() => false);

  if (await clickLogout().catch(() => false)) return true;
  if (await clickLogoutByDom()) return true;

  await openInitialsMenu();
  await page.waitForTimeout(350);

  if (await clickLogout().catch(() => false)) return true;
  return await clickLogoutByDom();
}

async function openSegSocialActivationFromLogin(page) {
  await page.goto('https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin', {
    waitUntil: 'domcontentloaded',
  }).catch(() => null);
  await page.waitForTimeout(650);

  let clicked = await clickFirstVisibleLocator(page, [
    () => page.getByRole('link', { name: /ativar\s+conta/i }),
    () => page.getByRole('button', { name: /ativar\s+conta/i }),
    () => page.locator('a, button, [role="button"]', { hasText: /ativar\s+conta/i }),
  ], 6000);
  if (!clicked) {
    clicked = await page.evaluate(() => {
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const target = Array.from(document.querySelectorAll('a, button, [role="button"]'))
        .find((element) => normalize(element.textContent || element.getAttribute('aria-label') || '').includes('ativar conta'));
      if (!target) return false;
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return true;
    }).catch(() => false);
  }
  if (clicked) {
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
      page.waitForTimeout(750),
    ]);
    const bodyText = await getPageBodyText(page, 1200);
    const url = String(page.url() || '');
    return /ativa[cç][aã]o\s+de\s+conta|c[oó]digo\s+de\s+verifica[cç][aã]o/i.test(bodyText) && !/\/errors\/401/i.test(url);
  }

  return false;
}

async function resetSegSocialBrowserSession(page, context) {
  await clickSegSocialLogout(page).catch(() => false);
  await page.waitForTimeout(500);
  await context?.clearCookies?.().catch(() => null);
  await page.evaluate(() => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // ignore
    }
  }).catch(() => null);
  await page.goto('about:blank').catch(() => null);
}

function normalizeSegSocialComparableText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractSegSocialEnterpriseTokens(value) {
  const ignoredTokens = new Set([
    'a',
    'as',
    'da',
    'das',
    'de',
    'do',
    'dos',
    'e',
    'empresa',
    'lda',
    'limitada',
    'sa',
    'sociedade',
    'unipessoal',
  ]);
  return normalizeSegSocialComparableText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !ignoredTokens.has(token));
}

function isExpectedSegSocialEnterpriseVisible(bodyText, payload = {}) {
  const normalizedPageText = normalizeSegSocialComparableText(bodyText);
  const pageDigits = String(bodyText || '').replace(/\D/g, '');
  const expectedDigits = [
    payload?.customerNiss,
    payload?.customerNif,
  ]
    .map((value) => String(value || '').replace(/\D/g, ''))
    .filter((value) => value.length >= 6);

  if (expectedDigits.some((digits) => pageDigits.includes(digits))) return true;

  const names = [
    payload?.customerCompany,
    payload?.customerName,
  ]
    .map((value) => String(value || '').trim())
    .filter((value) => value.length >= 3);

  for (const name of names) {
    const normalizedName = normalizeSegSocialComparableText(name);
    if (normalizedName && normalizedPageText.includes(normalizedName)) return true;

    const tokens = extractSegSocialEnterpriseTokens(name);
    if (tokens.length === 0) continue;
    const matchedTokens = tokens.filter((token) => normalizedPageText.includes(token));
    const minimumMatches = tokens.length === 1 ? 1 : Math.min(2, tokens.length);
    if (matchedTokens.length >= minimumMatches) return true;
  }

  return false;
}

function createSegSocialEnterpriseSubUserLogger(payload = {}) {
  const company = String(payload?.customerCompany || payload?.customerName || '').trim() || 'empresa';
  const runId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const prefix = `[SS Empresa Subconta ${runId}]`;
  const logs = [];

  const write = (level, message, extra = undefined) => {
    const entry = {
      at: new Date().toISOString(),
      level,
      company,
      message,
      extra: extra || null,
    };
    logs.push(entry);
    const line = `${prefix} ${message}`;
    if (level === 'error') console.error(line, extra || '');
    else if (level === 'warn') console.warn(line, extra || '');
    else console.log(line, extra || '');
  };

  return {
    logs,
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
  };
}

function buildSegSocialEnterpriseFailure({ stage, lastCompletedStep = 0, reason, error, logs }) {
  const lastStepText = Number(lastCompletedStep) > 0 ? `passo ${Number(lastCompletedStep)}` : 'nenhum passo';
  const detail = String(reason || error?.message || error || 'Erro inesperado.').trim();
  return {
    stage: stage || 'erro',
    success: false,
    manualRequired: true,
    lastCompletedStep: Number(lastCompletedStep) || 0,
    reason: `Não foi possível concluir. Último passo concluído: ${lastStepText}. ${detail}`,
    debugError: error ? String(error?.stack || error?.message || error) : undefined,
    logs: Array.isArray(logs) ? logs : undefined,
  };
}

async function getSegSocialVisiblePasswordInputCount(page) {
  return page.locator('input[type="password"]').evaluateAll((elements) => {
    return elements.filter((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 5 &&
        rect.height > 5 &&
        !element.disabled;
    }).length;
  }).catch(() => 0);
}

async function detectSegSocialEnterpriseBlockingState(page) {
  const bodyText = await getSegSocialAllFrameText(page, 1200);
  const normalizedText = normalizeSegSocialComparableText(bodyText);
  const url = String(page.url() || '').toLowerCase();

  const manualState = await detectSegSocialManualRequired(page).catch(() => ({ manualRequired: false, reason: '' }));
  if (manualState.manualRequired) {
    return manualState.reason || 'Validação manual necessária.';
  }

  const visiblePasswordCount = await getSegSocialVisiblePasswordInputCount(page);
  if (
    visiblePasswordCount >= 2 &&
    /nova\s+palavra\s+passe|confirmar\s+palavra\s+passe|alterar\s+palavra\s+passe|definir\s+palavra\s+passe|new\s+password/i.test(normalizedText)
  ) {
    return 'O portal pediu alteração/definição de palavra-passe. O processo parou para intervenção manual.';
  }

  const singlePasswordVisible = await page.locator('input[type="password"]').first().isVisible({ timeout: 500 }).catch(() => false);
  if (/seg-social\.pt\/sso\/login/.test(url) && singlePasswordVisible) {
    return 'O portal voltou ao ecrã de login. Confirma as credenciais e tenta novamente.';
  }

  if (/erro\s+\d{3}|n[aã]o\s+autorizado|acesso\s+negado|p[aá]gina\s+indispon[ií]vel|servi[cç]o\s+indispon[ií]vel|ocorreu\s+um\s+erro/i.test(bodyText)) {
    return 'O portal apresentou um erro ou redirecionou para uma página inesperada.';
  }

  return '';
}

async function waitForSegSocialEnterpriseStablePage(page, timeoutMs = 10_000) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 10_000);
  while (Date.now() < deadline) {
    const blockingReason = await detectSegSocialEnterpriseBlockingState(page).catch((error) => String(error?.message || error || ''));
    if (blockingReason) return { ready: false, reason: blockingReason };

    if (
      await isSegSocialTwoFactorActivationPrompt(page).catch(() => false) ||
      await isSegSocialContinueWithoutActivationOfferPage(page).catch(() => false)
    ) {
      return { ready: true, reason: '' };
    }

    if (await isSegSocialContinueIntermediatePage(page).catch(() => false)) {
      return { ready: true, reason: '' };
    }

    const url = String(page.url() || '').toLowerCase();
    const bodyText = await getSegSocialAllFrameText(page, 900).catch(() => '');
    if (/seg-social\.pt\/ptss\//.test(url) || /seguran[cç]a\s+social\s+direta|gest[aã]o\s+de\s+acessos/i.test(bodyText)) {
      return { ready: true, reason: '' };
    }

    await page.waitForTimeout(350);
  }

  return { ready: false, reason: 'A Segurança Social não terminou de carregar uma página reconhecida.' };
}

async function isSegSocialContinueWithoutActivationOfferPage(page) {
  const bodyText = await getSegSocialAllFrameText(page, 1200);
  const normalizedText = normalizeSegSocialComparableText(bodyText);
  return (
    normalizedText.includes('autenticacao de dois fatores') ||
    normalizedText.includes('autenticacao de dois factores')
  ) && (
    normalizedText.includes('continuar sem ativar') ||
    normalizedText.includes('continuar sem activar')
  );
}

async function isSegSocialEnterpriseAccessManagementPage(page) {
  const bodyText = await getSegSocialAllFrameText(page, 1200);
  return /gest[aã]o\s+de\s+acessos/i.test(bodyText) &&
    /gerir\s+subcontas|subcontas\s+de\s+utilizadores|utilizadores\s+de\s+empresa/i.test(bodyText);
}

async function isSegSocialEnterpriseSubAccountsPage(page) {
  const url = String(page.url() || '').toLowerCase();
  const bodyText = await getSegSocialAllFrameText(page, 1200);
  if (/\/ptss\/gus\/gestao-utilizadores\/consultar-utilizadores-subconta/i.test(url)) return true;

  if (/\/ptss\/pssd\/menu\/gestao-de-acessos/i.test(url)) {
    return /criar\s+subconta|subcontas\s+criadas|n[aã]o\s+existem\s+subcontas/i.test(bodyText);
  }

  const hasCreateSubAccountControl = await page.locator('button, a, [role="button"], input[type="submit"], input[type="button"]', {
    hasText: /^criar\s+subconta$/i,
  }).first().isVisible({ timeout: 500 }).catch(() => false);
  if (hasCreateSubAccountControl) return true;

  return /gerir\s+subcontas\s+de\s+utilizadores/i.test(bodyText) &&
    (/criar\s+subconta|subcontas\s+criadas|utilizador\s+da\s+subconta|n[aã]o\s+existem\s+subcontas/i.test(bodyText));
}

async function isSegSocialEnterpriseCreateSubAccountForm(page) {
  const bodyText = await getSegSocialAllFrameText(page, 1200);
  return /cria[cç][aã]o\s+da\s+subconta|dados\s+da\s+subconta|seguinte:\s*resumo/i.test(bodyText) &&
    /nome|email|e-mail/i.test(bodyText);
}

async function isSegSocialEnterpriseSubAccountSummary(page) {
  const bodyText = await getSegSocialAllFrameText(page, 1200);
  return /2\.\s*resumo|seguinte:\s*resumo|dados\s+de\s+utilizador\s*[>›]\s*resumo|resumo\s*[>›]\s*adicionar\s+utilizador/i.test(bodyText) ||
    (/dados\s+da\s+conta\s+principal/i.test(bodyText) && /dados\s+da\s+subconta/i.test(bodyText) && /criar\s+subconta/i.test(bodyText));
}

async function waitForSegSocialEnterpriseCondition(page, predicate, timeoutMs = 7000) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 7000);
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function clickSegSocialEnterpriseProfileMenu(page, payload = {}) {
  return clickFirstVisibleLocator(page, [
    () => page.getByRole('button', { name: /perfil|conta|utilizador|empresa/i }).first(),
    () => page.getByRole('link', { name: /perfil|conta|utilizador|empresa/i }).first(),
    () => page.locator('[aria-label*="perfil" i], [aria-label*="conta" i], [aria-label*="utilizador" i]').first(),
    () => page.locator('button, a, [role="button"]').filter({ hasText: /^[A-Z]{1,4}$/ }).first(),
  ], 4000);
}

async function openSegSocialEnterpriseAccessManagement(page, payload = {}, logger = null) {
  const openDirectUrl = async (url) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null);
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
      page.waitForTimeout(900),
    ]);
    const currentUrl = String(page.url() || '');
    if (currentUrl && currentUrl !== url && /\/ptss\/pssd\/home/i.test(currentUrl)) {
      await page.evaluate((targetUrl) => {
        window.location.assign(targetUrl);
      }, url).catch(() => null);
      await Promise.race([
        page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
        page.waitForTimeout(900),
      ]);
    }
  };

  if (await isSegSocialEnterpriseAccessManagementPage(page).catch(() => false)) return true;
  if (await isSegSocialEnterpriseSubAccountsPage(page).catch(() => false)) return true;

  logger?.info?.('Passo 5: abrir link direto de Gestão de acessos.', { url: SEG_SOCIAL_ACCESS_MANAGEMENT_URL });
  await openDirectUrl(SEG_SOCIAL_ACCESS_MANAGEMENT_URL);

  if (await isSegSocialEnterpriseAccessManagementPage(page).catch(() => false)) return true;
  if (await isSegSocialEnterpriseSubAccountsPage(page).catch(() => false)) return true;

  logger?.warn?.('Link direto não confirmou Gestão de acessos; a tentar método alternativo pelo perfil.');
  await clickSegSocialEnterpriseProfileMenu(page, payload).catch(() => false);
  await page.waitForTimeout(400);
  await clickFirstVisibleLocator(page, [
    () => page.getByRole('link', { name: /gest[aã]o\s+de\s+acessos?/i }).first(),
    () => page.getByRole('button', { name: /gest[aã]o\s+de\s+acessos?/i }).first(),
    () => page.locator('a, button, [role="button"]', { hasText: /gest[aã]o\s+de\s+acessos?/i }).first(),
  ], 5000);
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
    page.waitForTimeout(900),
  ]);

  if (await isSegSocialEnterpriseAccessManagementPage(page).catch(() => false)) return true;
  if (await isSegSocialEnterpriseSubAccountsPage(page).catch(() => false)) return true;

  logger?.warn?.('Método alternativo não abriu Gestão de acessos; a tentar abrir diretamente a página de subcontas.');
  await openDirectUrl(SEG_SOCIAL_SUBACCOUNTS_URL);
  return (await isSegSocialEnterpriseAccessManagementPage(page).catch(() => false)) ||
    (await isSegSocialEnterpriseSubAccountsPage(page).catch(() => false));
}

async function clickSegSocialEnterpriseCreateSubAccountModal(page) {
  const clickedByLocator = await clickFirstVisibleLocator(page, [
    () => page.getByRole('dialog').getByRole('button', { name: /^criar\s+subconta$/i }).first(),
    () => page.locator('[role="dialog"], .modal, .dialog').filter({ hasText: /criar\s+subconta/i }).getByRole('button', { name: /^criar\s+subconta$/i }).first(),
    () => page.locator('[role="dialog"], .modal, .dialog').filter({ hasText: /criar\s+subconta/i }).locator('button, input[type="submit"], input[type="button"]', { hasText: /^criar\s+subconta$/i }).first(),
  ], 5000);
  if (clickedByLocator) return true;

  return page.evaluate(() => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, .dialog'));
    const roots = dialogs.length ? dialogs : [document.body];
    for (const root of roots) {
      const rootText = normalize(root.textContent || '');
      if (!rootText.includes('criar subconta')) continue;
      const candidates = Array.from(root.querySelectorAll('button, input[type="submit"], input[type="button"], a'));
      const target = candidates.find((element) => {
        const label = normalize([
          element.textContent,
          element.getAttribute('value'),
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
        ].filter(Boolean).join(' '));
        return label === 'criar subconta';
      });
      if (!target) continue;
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return true;
    }
    return false;
  }).catch(() => false);
}

async function clickSegSocialEnterpriseSubAccountsLink(page) {
  const clickedByLocator = await clickFirstVisibleLocator(page, [
    () => page.getByRole('link', { name: /gerir\s+subcontas\s+de\s+utilizadores/i }).first(),
    () => page.getByRole('button', { name: /gerir\s+subcontas\s+de\s+utilizadores/i }).first(),
    () => page.getByRole('link', { name: /gerir\s+subcontas/i }).first(),
    () => page.getByRole('button', { name: /gerir\s+subcontas/i }).first(),
    () => page.getByText(/gerir\s+subcontas\s+de\s+utilizadores/i).first(),
    () => page.locator('a, button, [role="button"]', { hasText: /gerir\s+subcontas\s+de\s+utilizadores|gerir\s+subcontas/i }).first(),
  ], 7000);
  if (clickedByLocator) return true;

  return page.evaluate(() => {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const readableLabel = (element) => normalize([
      element.textContent,
      element.getAttribute?.('value'),
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
    ].filter(Boolean).join(' '));
    const matchesTarget = (label) => (
      label.includes('gerir subcontas de utilizadores') ||
      label.includes('gerir subcontas')
    );

    const clickableCandidates = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]'));
    let target = clickableCandidates.find((element) => {
      const label = normalize([
        element.textContent,
        element.getAttribute('value'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
      ].filter(Boolean).join(' '));
      return matchesTarget(label);
    });

    if (!target) {
      const textCandidates = Array.from(document.querySelectorAll('main *, section *, article *, div *, li *'))
        .filter((element) => {
          if (['HTML', 'BODY', 'SCRIPT', 'STYLE'].includes(element.tagName)) return false;
          const rect = element.getBoundingClientRect();
          if (!rect || rect.width < 20 || rect.height < 20) return false;
          const label = readableLabel(element);
          if (!matchesTarget(label)) return false;
          return label.length <= 180;
        })
        .sort((a, b) => {
          const aLabel = readableLabel(a);
          const bLabel = readableLabel(b);
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          return (aLabel.length - bLabel.length) || ((aRect.width * aRect.height) - (bRect.width * bRect.height));
        });

      for (const element of textCandidates) {
        target = element.closest('a, button, [role="button"]') || element;
        if (target) break;
      }
    }

    if (!target) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof target.click === 'function') {
      target.click();
    } else {
      const rect = target.getBoundingClientRect();
      const eventInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + (rect.width / 2),
        clientY: rect.top + (rect.height / 2),
      };
      target.dispatchEvent(new MouseEvent('pointerdown', eventInit));
      target.dispatchEvent(new MouseEvent('mousedown', eventInit));
      target.dispatchEvent(new MouseEvent('mouseup', eventInit));
      target.dispatchEvent(new MouseEvent('click', eventInit));
    }
    return true;
  }).catch(() => false);
}

async function waitForSegSocialEnterpriseSubAccountsPage(page, timeoutMs = 14_000) {
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: Math.min(Math.max(1500, timeoutMs), 8000) }).catch(() => null),
    page.waitForTimeout(600),
  ]);
  return waitForSegSocialEnterpriseCondition(page, () => isSegSocialEnterpriseSubAccountsPage(page), timeoutMs);
}

async function openSegSocialEnterpriseSubAccountsPage(page, logger = null) {
  if (await isSegSocialEnterpriseSubAccountsPage(page).catch(() => false)) return true;

  const clicked = await clickSegSocialEnterpriseSubAccountsLink(page);
  logger?.info?.('Passo 7: tentativa de clique em Gerir subcontas.', {
    clicked,
    url: String(page.url() || ''),
  });
  if (clicked && await waitForSegSocialEnterpriseSubAccountsPage(page, 16_000)) return true;

  logger?.warn?.('Passo 7: clique em Gerir subcontas não confirmou a página; vou abrir o URL direto de subcontas.');
  await page.goto(SEG_SOCIAL_SUBACCOUNTS_URL, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (await waitForSegSocialEnterpriseSubAccountsPage(page, 16_000)) return true;

  const currentUrl = String(page.url() || '');
  if (currentUrl && !/\/ptss\/gus\/gestao-utilizadores\/consultar-utilizadores-subconta/i.test(currentUrl)) {
    await page.evaluate((targetUrl) => {
      window.location.assign(targetUrl);
    }, SEG_SOCIAL_SUBACCOUNTS_URL).catch(() => null);
    if (await waitForSegSocialEnterpriseSubAccountsPage(page, 16_000)) return true;
  }

  return false;
}

async function fillSegSocialEnterpriseSubAccountFields(page, companyName, subEmail) {
  const filledName = await fillFirstVisibleLocator(page, [
    () => page.getByLabel(/^nome\*?$/i),
    () => page.getByLabel(/nome/i),
    () => page.locator('input[name*="nome" i], input[id*="nome" i], input[placeholder*="nome" i]'),
  ], companyName, 5000);
  const filledEmail = await fillFirstVisibleLocator(page, [
    () => page.getByLabel(/e-?mail|correio/i),
    () => page.locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]'),
  ], subEmail, 5000);
  return { filledName, filledEmail };
}

async function runSegSocialEnterpriseSubUserSetupFlow(page, payload = {}) {
  const logger = createSegSocialEnterpriseSubUserLogger(payload);
  const companyName = String(payload?.customerCompany || payload?.customerName || '').trim();
  const subEmail = String(payload?.subEmail || 'geral@mpr.pt').trim() || 'geral@mpr.pt';
  const expectedSubUsername = String(payload?.subUsername || '').trim();
  let lastCompletedStep = 1; // O login é feito antes de entrar neste fluxo.

  const fail = (stage, reason, error = null) => {
    logger.error(`${stage}: ${reason}`, error ? { error: String(error?.message || error) } : undefined);
    return buildSegSocialEnterpriseFailure({
      stage,
      lastCompletedStep,
      reason,
      error,
      logs: logger.logs,
    });
  };
  const complete = (step, stage, extra = undefined) => {
    lastCompletedStep = Math.max(lastCompletedStep, step);
    logger.info(`Passo ${step} concluído: ${stage}`, extra);
  };
  const stopIfBlocked = async (stage) => {
    const blockingReason = await detectSegSocialEnterpriseBlockingState(page).catch((error) => String(error?.message || error || ''));
    return blockingReason ? fail(stage, blockingReason) : null;
  };

  try {
    logger.info('Passo 1 concluído: login submetido com credenciais da empresa.');

    const stable = await waitForSegSocialEnterpriseStablePage(page, 4000);
    if (!stable.ready) {
      logger.warn('A página pós-login ainda não foi reconhecida; vou tentar tratar o aviso de dois fatores antes de falhar.', { reason: stable.reason });
    }

    logger.info('Passo 2: verificar aviso "Continuar sem ativar".');
    const mayHaveContinueWithoutActivation =
      await isSegSocialTwoFactorActivationPrompt(page).catch(() => false) ||
      await isSegSocialContinueWithoutActivationOfferPage(page).catch(() => false) ||
      !stable.ready;
    if (mayHaveContinueWithoutActivation) {
      const clicked = await clickContinueWithoutActivatingIfPrompt(page, 4500);
      await Promise.race([
        page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
        page.waitForTimeout(900),
      ]);
      const stillOnActivationOffer =
        await isSegSocialTwoFactorActivationPrompt(page).catch(() => false) ||
        await isSegSocialContinueWithoutActivationOfferPage(page).catch(() => false);
      if (!clicked && !stable.ready) {
        return fail('login_pos_submit', stable.reason);
      }
      if (stillOnActivationOffer) {
        return fail('continuar_sem_ativar', 'Apareceu o aviso de autenticação de dois fatores, mas não consegui clicar em "Continuar sem ativar".');
      }
    }
    complete(2, 'aviso de ativação tratado ou inexistente');

    logger.info('Passo 3: verificar pedido de palavra-passe/intermédio.');
    const continueResult = await clickContinueToSegSocialPrompt(page, 5000).catch((error) => {
      throw error;
    });
    if (continueResult?.manualRequired) {
      return fail('continuar_seg_social_direta', continueResult.reason || 'Validação manual necessária.');
    }
    if (!continueResult?.clicked) {
      const bodyText = await getSegSocialAllFrameText(page, 1200);
      if (/palavra-passe|senha|password|caduc|expir|alterar/i.test(bodyText)) {
        const blockedBeforePasswordClick = await stopIfBlocked('alteracao_palavra_passe');
        if (blockedBeforePasswordClick) return blockedBeforePasswordClick;
        await clickContinuePasswordExpiryPrompt(page, 5000).catch(() => false);
      }
    }
    const blockedAfterPasswordPrompt = await stopIfBlocked('continuar_seg_social_direta');
    if (blockedAfterPasswordPrompt) return blockedAfterPasswordPrompt;
    complete(3, 'pedido de palavra-passe tratado ou inexistente');

    logger.info('Passo 4: confirmar empresa selecionada.');
    const selectedCompanyText = await getSegSocialAllFrameText(page, 1600);
    if (!companyName || !isExpectedSegSocialEnterpriseVisible(selectedCompanyText, payload)) {
      return fail(
        'confirmar_empresa',
        `Não consegui confirmar no portal que a empresa selecionada é "${companyName || 'sem nome no programa'}". Seleciona a empresa correta no browser e volta a iniciar.`
      );
    }
    complete(4, 'empresa confirmada', { companyName });

    const accessOpened = await openSegSocialEnterpriseAccessManagement(page, payload, logger);
    const blockedAfterAccessOpen = await stopIfBlocked('gestao_acessos');
    if (blockedAfterAccessOpen) return blockedAfterAccessOpen;
    if (!accessOpened) {
      return fail('gestao_acessos', 'Não consegui abrir a página "Gestão de acessos" pelo link direto nem pelo menu do perfil.');
    }
    complete(5, 'Gestão de acessos aberta');
    complete(6, 'link direto validado ou método alternativo concluído');

    logger.info('Passo 7: clicar em "Gerir subcontas de utilizadores".');
    const openedSubAccounts = await openSegSocialEnterpriseSubAccountsPage(page, logger);
    const blockedAfterSubAccounts = await stopIfBlocked('gerir_subcontas');
    if (blockedAfterSubAccounts) return blockedAfterSubAccounts;
    if (!openedSubAccounts || !(await isSegSocialEnterpriseSubAccountsPage(page).catch(() => false))) {
      return fail('gerir_subcontas', 'Não consegui abrir "Gerir subcontas de utilizadores".');
    }
    complete(7, 'Gerir subcontas de utilizadores aberto');

    logger.info('Passo 8: clicar em "Criar subconta".');
    const clickedCreate = await clickFirstVisibleLocator(page, [
      () => page.getByRole('button', { name: /^criar\s+subconta$/i }).first(),
      () => page.getByRole('link', { name: /^criar\s+subconta$/i }).first(),
      () => page.locator('button, a, [role="button"], input[type="submit"], input[type="button"]', { hasText: /^criar\s+subconta$/i }).first(),
    ], 6000);
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
      page.waitForTimeout(900),
    ]);
    if (!clickedCreate) {
      return fail('abrir_modal_criar_subconta', 'Não encontrei o botão "Criar subconta".');
    }
    complete(8, 'primeiro botão Criar subconta clicado');

    logger.info('Passo 9: confirmar modal "Criar subconta".');
    if (!(await isSegSocialEnterpriseCreateSubAccountForm(page).catch(() => false))) {
      const clickedModal = await clickSegSocialEnterpriseCreateSubAccountModal(page);
      await Promise.race([
        page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => null),
        waitForSegSocialEnterpriseCondition(page, () => isSegSocialEnterpriseCreateSubAccountForm(page), 10_000),
        page.waitForTimeout(900),
      ]);
      if (!clickedModal) {
        return fail('confirmar_modal_criar_subconta', 'Abriu a confirmação, mas não consegui clicar no segundo botão "Criar subconta".');
      }
    }
    if (!(await isSegSocialEnterpriseCreateSubAccountForm(page).catch(() => false))) {
      return fail('abrir_formulario_subconta', 'O portal não abriu o formulário "Criação da subconta".');
    }
    complete(9, 'modal Criar subconta confirmado');

    logger.info('Passo 10: preencher Nome e Email da subconta.');
    const { filledName, filledEmail } = await fillSegSocialEnterpriseSubAccountFields(page, companyName, subEmail);
    if (!filledName || !filledEmail) {
      return fail('preencher_dados_subconta', `Não consegui preencher ${!filledName ? 'o nome' : ''}${!filledName && !filledEmail ? ' e ' : ''}${!filledEmail ? 'o email' : ''} da subconta.`);
    }
    complete(10, 'nome e email preenchidos', { companyName, subEmail });

    logger.info('Passo 11: clicar em "Seguinte: Resumo".');
    const clickedNext = await clickSegSocialButtonByText(page, /seguinte\s*:\s*resumo/i, 7000) ||
      await clickFirstVisibleLocator(page, [
        () => page.getByRole('button', { name: /seguinte|resumo/i }).first(),
        () => page.locator('button, input[type="submit"], input[type="button"], a', { hasText: /seguinte|resumo/i }).first(),
      ], 5000);
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => null),
      waitForSegSocialEnterpriseCondition(page, () => isSegSocialEnterpriseSubAccountSummary(page), 10_000),
      page.waitForTimeout(900),
    ]);
    const blockedAfterNext = await stopIfBlocked('seguinte_resumo');
    if (blockedAfterNext) return blockedAfterNext;
    if (!clickedNext || !(await isSegSocialEnterpriseSubAccountSummary(page).catch(() => false))) {
      return fail('seguinte_resumo', 'Preenchi nome e email, mas o portal não avançou para o resumo.');
    }
    complete(11, 'resumo aberto');

    logger.info('Passo 12: clicar em "Criar subconta" no resumo.');
    const clickedFinalCreate = await clickFirstVisibleLocator(page, [
      () => page.getByRole('button', { name: /^criar\s+subconta$/i }).first(),
      () => page.locator('button, input[type="submit"], input[type="button"], a', { hasText: /^criar\s+subconta$/i }).first(),
    ], 7000);
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => null),
      page.waitForTimeout(1500),
    ]);
    const blockedAfterCreate = await stopIfBlocked('criar_subconta');
    if (blockedAfterCreate) return blockedAfterCreate;
    if (!clickedFinalCreate) {
      return fail('criar_subconta', 'Cheguei ao resumo, mas não consegui clicar no botão final "Criar subconta".');
    }
    complete(12, 'criação submetida');

    const successText = await getSegSocialAllFrameText(page, 2000);
    const createdUsername =
      String(successText.match(/utilizador\s+desta\s+subconta\s+[ée]\s+([0-9-]+)/i)?.[1] || '').trim() ||
      expectedSubUsername;
    const success = /cria[cç][aã]o\s+da\s+subconta\s+conclu[ií]da|utilizador\s+foi\s+registado\s+com\s+sucesso|subconta.*criada|criada\s+com\s+sucesso/i.test(successText);
    if (!success) {
      return fail('confirmar_sucesso_subconta', 'Cliquei em "Criar subconta", mas não consegui confirmar a mensagem de sucesso no portal.');
    }

    complete(13, 'subconta criada com sucesso');
    return {
      stage: 'subconta_criada',
      success: true,
      manualRequired: false,
      lastCompletedStep,
      createdUsername: createdUsername || undefined,
      companyName,
      subEmail,
      reason: '',
      message: `Subconta criada com sucesso para ${companyName}`,
      logs: logger.logs,
    };
  } catch (error) {
    return fail('erro_inesperado', 'Erro inesperado durante o fluxo empresarial de criação da subconta.', error);
  }
}

async function continueSegSocialSubAccountActivation(page, payload = {}, createdUsername = '', activationSinceIso = '', context = null) {
  await resetSegSocialBrowserSession(page, context).catch(async () => {
    await clickSegSocialLogout(page).catch(() => false);
    await page.waitForTimeout(500);
  });

  const openedActivation = await openSegSocialActivationFromLogin(page).catch(() => false);
  if (!openedActivation) {
    return {
      stage: 'ativacao_abrir_login',
      manualRequired: true,
      createdUsername: createdUsername || undefined,
      reason: `Subconta criada${createdUsername ? ` (${createdUsername})` : ''}. Não consegui abrir a página pública "Ativar conta" sem erro 401. No browser, volta ao login da Segurança Social e clica em "Ativar conta".`,
    };
  }
  await page.waitForTimeout(650);
  await selectSegSocialSubAccountActivationOption(page).catch(() => false);
  await page.waitForTimeout(350);

  const code = await fetchLatestSegSocialActivationCode({ ...payload, activationSinceIso });
  if (!code) {
    return {
      stage: 'ativacao_aguarda_codigo_email',
      manualRequired: true,
      createdUsername: createdUsername || undefined,
      reason: `Subconta criada${createdUsername ? ` (${createdUsername})` : ''}. Abri a ativação e escolhi "Subcontas ou outros", mas não consegui ler o código no email geral@mpr.pt. Insere o código e resolve o CAPTCHA manualmente.`,
    };
  }

  const filled = await fillSegSocialActivationCode(page, code);
  const manualState = await detectSegSocialManualRequired(page).catch(() => ({ manualRequired: false, reason: '' }));
  return {
    stage: 'ativacao_manual_captcha',
    manualRequired: true,
    createdUsername: createdUsername || undefined,
    activationCode: code,
    reason: filled
      ? `Subconta criada${createdUsername ? ` (${createdUsername})` : ''}. Código de ativação preenchido: ${code}. Agora resolve o CAPTCHA e confirma a ativação no browser aberto.`
      : `Subconta criada${createdUsername ? ` (${createdUsername})` : ''}. Código encontrado no email: ${code}. Não consegui preencher o campo automaticamente; insere o código, resolve o CAPTCHA e confirma a ativação.`,
    captchaDetected: manualState.manualRequired || undefined,
  };
}

async function runSegSocialSubUserSetupFlow(page, payload = {}, context = null) {
  const companyName = String(payload?.customerCompany || payload?.customerName || 'MPR').trim();
  const subEmail = String(payload?.subEmail || 'geral@mpr.pt').trim();
  const expectedSubUsername = String(payload?.subUsername || '').trim();

  const reachedSubAccounts = await navigateSegSocialSubAccountsArea(page);
  if (!reachedSubAccounts) {
    if (await isSegSocialTwoFactorActivationPrompt(page).catch(() => false)) {
      return {
        stage: 'continuar_sem_ativar',
        manualRequired: true,
        reason: 'Estou no aviso de autenticação de dois fatores da conta principal. Para criar o subutilizador, clica em "Continuar sem ativar" e depois volta a iniciar o assistente.',
      };
    }
    return { stage: 'manual_area_acesso', manualRequired: true, reason: 'Entrou na Segurança Social. Abre Área de acesso > Gestão de acessos > Gerir subcontas de utilizadores de empresa.' };
  }

  const isCreateSubAccountForm = async () => {
    const bodyText = await getPageBodyText(page, 1200);
    return /cria[cç][aã]o\s+da\s+subconta|dados\s+da\s+subconta|dados\s+da\s+conta\s+principal|seguinte:\s*resumo/i.test(bodyText);
  };
  const isSubAccountSummaryStep = async () => {
    const bodyText = await getPageBodyText(page, 1200);
    return (
      /2\.\s*resumo|dados\s+de\s+utilizador\s*[>›]\s*resumo|resumo\s*[>›]\s*adicionar\s+utilizador/i.test(bodyText) ||
      (/cria[cç][aã]o\s+da\s+subconta/i.test(bodyText) && /dados\s+da\s+subconta/i.test(bodyText) && /criar\s+subconta/i.test(bodyText))
    );
  };
  const waitForSubAccountSummaryStep = async (timeoutMs = 7000) => {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 7000);
    while (Date.now() < deadline) {
      if (await isSubAccountSummaryStep().catch(() => false)) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  const confirmCreateSubAccountModal = async () => {
    const clickedInDialog = await clickFirstVisibleLocator(page, [
      () => page.getByRole('dialog', { name: /criar subconta/i }).getByRole('button', { name: /^criar subconta$/i }),
      () => page.locator('[role="dialog"], .modal, .dialog').filter({ hasText: /criar subconta/i }).getByRole('button', { name: /^criar subconta$/i }),
      () => page.locator('[role="dialog"], .modal, .dialog').filter({ hasText: /criar subconta/i }).locator('button', { hasText: /^criar subconta$/i }),
    ], 5000);
    if (clickedInDialog) return true;

    return await page.evaluate(() => {
      const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, .dialog'));
      const candidates = dialogs.length ? dialogs : [document.body];
      for (const root of candidates) {
        const rootText = normalize(root.textContent || '');
        if (!rootText.includes('criar subconta')) continue;
        const buttons = Array.from(root.querySelectorAll('button, input[type="submit"], input[type="button"], a'));
        const target = buttons.find((element) => {
          const label = normalize([
            element.textContent,
            element.getAttribute('value'),
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
          ].filter(Boolean).join(' '));
          return label === 'criar subconta';
        });
        if (target) {
          target.scrollIntoView({ block: 'center', inline: 'center' });
          target.click();
          return true;
        }
      }
      return false;
    }).catch(() => false);
  };

  const openedCreateModal = await clickFirstVisibleLocator(page, [
    () => page.getByRole('button', { name: /criar subconta|adicionar utilizador|adicionar subconta|adicionar/i }),
    () => page.getByRole('link', { name: /criar subconta|adicionar utilizador|adicionar subconta|adicionar/i }),
    () => page.locator('button, a, [role="button"]', { hasText: /criar subconta|adicionar utilizador|adicionar subconta|adicionar/i }),
  ], 6000);
  if (!openedCreateModal) {
    return { stage: 'abrir_criacao_subconta', manualRequired: true, reason: 'Não encontrei o botão "Criar subconta". Clica nele no browser aberto.' };
  }
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
    page.waitForTimeout(650),
  ]);

  if (!(await isCreateSubAccountForm().catch(() => false))) {
    const confirmedModal = await confirmCreateSubAccountModal();
    if (!confirmedModal) {
      return { stage: 'confirmar_modal_criacao', manualRequired: true, reason: 'Fiquei no aviso "Criar subconta". Clica no botão "Criar subconta" dentro do modal.' };
    }
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => null),
      page.waitForURL((url) => /registro-subconta|registo-subconta|criacao|cria/i.test(String(url || '')), { timeout: 10_000 }).catch(() => null),
      page.waitForTimeout(900),
    ]);
  }

  if (!(await isCreateSubAccountForm().catch(() => false))) {
    return { stage: 'abrir_formulario_subconta', manualRequired: true, reason: 'O modal foi tratado, mas não cheguei ao formulário "Criação da subconta". Continua no browser aberto.' };
  }

  await fillFirstVisibleLocator(page, [
    () => page.getByLabel(/nome/i),
    () => page.locator('input[name*="nome" i], input[id*="nome" i], input[placeholder*="nome" i]'),
  ], companyName);
  await fillFirstVisibleLocator(page, [
    () => page.getByLabel(/email|e-mail|correio/i),
    () => page.locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]'),
  ], subEmail);

  const advanced = await clickFirstVisibleLocator(page, [
    () => page.getByRole('button', { name: /seguinte|resumo|continuar|pr[oó]ximo/i }),
    () => page.locator('button, input[type="submit"], a', { hasText: /seguinte|resumo|continuar|pr[oó]ximo/i }),
  ], 6000);
  if (!advanced) {
    return { stage: 'preencher_subutilizador', manualRequired: true, reason: 'Preenchi os dados possíveis. Clica em "Seguinte: Resumo" no browser aberto.' };
  }
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
    waitForSubAccountSummaryStep(8000),
    page.waitForTimeout(1000),
  ]);

  const isSummaryStep = await waitForSubAccountSummaryStep(5000);
  if (!isSummaryStep) {
    return {
      stage: 'preencher_subutilizador',
      manualRequired: true,
      reason: 'Preenchi nome e email, mas o portal não avançou para o resumo. Mantive as datas por defeito; verifica os campos assinalados e clica em "Seguinte: Resumo".',
    };
  }

  const subAccountCreateRequestedAt = new Date(Date.now() - 15_000).toISOString();
  const confirmed = await clickFirstVisibleLocator(page, [
    () => page.getByRole('button', { name: /^criar subconta$/i }),
    () => page.getByRole('button', { name: /confirmar|submeter|criar|adicionar/i }),
    () => page.locator('button, input[type="submit"], a', { hasText: /^criar subconta$/i }),
    () => page.locator('button, input[type="submit"], a', { hasText: /confirmar|submeter|criar|adicionar/i }),
  ], 6000);
  if (!confirmed) {
    return { stage: 'confirmar_criacao', manualRequired: true, reason: 'Cheguei ao resumo. Clica em "Criar subconta" no browser aberto.' };
  }
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => null),
    page.waitForTimeout(1000),
  ]);

  const successText = await getPageBodyText(page, 2000);
  const createdUsername =
    String(successText.match(/utilizador\s+desta\s+subconta\s+[ée]\s+([0-9-]+)/i)?.[1] || '').trim() ||
    expectedSubUsername;
  const success = /cria[cç][aã]o\s+da\s+subconta\s+conclu[ií]da|utilizador\s+foi\s+registado\s+com\s+sucesso|subconta.*criada/i.test(successText);

  const baseResult = {
    stage: success ? 'subconta_criada' : 'confirmar_criacao',
    success,
    createdUsername: createdUsername || undefined,
    manualRequired: !success,
    reason: success ? '' : 'Não consegui confirmar automaticamente a criação da subconta. Verifica o browser aberto.',
  };
  if (!success) return baseResult;
  return await continueSegSocialSubAccountActivation(page, payload, createdUsername || expectedSubUsername, subAccountCreateRequestedAt, context).catch((error) => ({
    ...baseResult,
    stage: 'ativacao_conta',
    manualRequired: true,
    reason: `Subconta criada${createdUsername ? ` (${createdUsername})` : ''}, mas não consegui abrir/preencher a ativação automaticamente. ${String(error?.message || error || '')}`.trim(),
  }));
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
    () => page.locator('input[type="submit"][value*="Continuar login" i], input[type="button"][value*="Continuar login" i]').first(),
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

async function isSegSocialTwoFactorActivationPrompt(page) {
  const bodyText = await getSegSocialAllFrameText(page, 1200);
  const normalizedText = String(bodyText || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return (
    SEG_SOCIAL_ACTIVATION_OFFER_TITLE_RE.test(bodyText) ||
    normalizedText.includes('ativacao da autenticacao de dois fatores')
  ) && (
    /continuar\s+para\s+a[c]?tivar|confirmar\s+contactos|continuar\s+sem\s+a[c]?tivar/i.test(bodyText) ||
    normalizedText.includes('continuar para ativar') ||
    normalizedText.includes('continuar para activar') ||
    normalizedText.includes('confirmar contactos') ||
    normalizedText.includes('continuar sem ativar') ||
    normalizedText.includes('continuar sem activar')
  );
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
    () => page.getByRole('button', { name: SEG_SOCIAL_CONTINUE_WITHOUT_ACTIVATING_RE }).first(),
    () => page.getByText(SEG_SOCIAL_CONTINUE_WITHOUT_ACTIVATING_RE).first(),
    () => page.locator('button', { hasText: SEG_SOCIAL_CONTINUE_WITHOUT_ACTIVATING_RE }).first(),
    () => page.locator('input[type="submit"][value*="Continuar sem ativar" i], input[type="button"][value*="Continuar sem ativar" i], input[type="submit"][value*="Continuar sem activar" i], input[type="button"][value*="Continuar sem activar" i]').first(),
    () => page.locator('a', { hasText: SEG_SOCIAL_CONTINUE_WITHOUT_ACTIVATING_RE }).first(),
    () => page.locator('[role="button"]', { hasText: SEG_SOCIAL_CONTINUE_WITHOUT_ACTIVATING_RE }).first(),
    () => page.locator('button, a, input[type="submit"], input[type="button"], [role="button"]')
      .filter({ hasText: /sem\s*a[c]?tivar/i })
      .first(),
  ];

  const clickByDomText = async () => {
    for (const frame of page.frames()) {
      const clicked = await frame.evaluate(() => {
        const normalize = (value) => String(value || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        const textFor = (element) => normalize([
          element.innerText,
          element.textContent,
          element.getAttribute?.('value'),
          element.getAttribute?.('aria-label'),
          element.getAttribute?.('title'),
        ].filter(Boolean).join(' '));
        const roots = [document];
        const collectShadowRoots = (root) => {
          const elements = Array.from(root.querySelectorAll ? root.querySelectorAll('*') : []);
          for (const element of elements) {
            if (element.shadowRoot) {
              roots.push(element.shadowRoot);
              collectShadowRoots(element.shadowRoot);
            }
          }
        };
        collectShadowRoots(document);

        for (const root of roots) {
          const candidates = Array.from(root.querySelectorAll([
            'button',
            'a',
            'input[type="submit"]',
            'input[type="button"]',
            '[role="button"]',
            '[onclick]',
          ].join(',')));
          const target = candidates.find((element) => {
            const label = textFor(element);
            return label.includes('continuar sem ativar') ||
              label.includes('continuar sem activar') ||
              (label.includes('continuar') && (label.includes('sem ativar') || label.includes('sem activar')));
          });
          if (!target) continue;
          target.scrollIntoView?.({ block: 'center', inline: 'center' });
          target.click();
          return true;
        }
        return false;
      }).catch(() => false);
      if (clicked) return true;
    }
    return false;
  };

  while (Date.now() < deadline) {
    if (await clickByDomText()) {
      await page.waitForTimeout(450);
      return true;
    }
    for (const buildLocator of selectors) {
      try {
        const locator = buildLocator();
        if ((await locator.count()) <= 0) continue;
        const visible = await locator.isVisible().catch(() => false);
        if (!visible) continue;
        await locator.click({ timeout: 3000 });
        await page.waitForTimeout(450);
        return true;
      } catch (_) {
        try {
          const locator = buildLocator();
          if ((await locator.count()) <= 0) continue;
          await locator.click({ timeout: 3000, force: true });
          await page.waitForTimeout(450);
          return true;
        } catch (_) {
          // ignore and continue until timeout
        }
      }
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function clickContinuePasswordExpiryPrompt(page, timeoutMs = 10_000) {
  const safeTimeout = Math.max(1000, Number(timeoutMs) || 10_000);
  const deadline = Date.now() + safeTimeout;
  const selectors = [
    () => page.getByRole('button', { name: /^continuar$/i }).first(),
    () => page.getByRole('link', { name: /^continuar$/i }).first(),
    () => page.locator('button, a, input[type="submit"], input[type="button"]', { hasText: /^continuar$/i }).first(),
    () => page.locator('button, a, input[type="submit"], input[type="button"]', { hasText: /mais tarde|agora n[aã]o|n[aã]o alterar|ignorar/i }).first(),
    () => page.locator('input[type="submit"][value*="Continuar"], input[type="button"][value*="Continuar"]').first(),
  ];

  while (Date.now() < deadline) {
    if (await isSegSocialContinueIntermediatePage(page).catch(() => false)) {
      return false;
    }
    const pageText = await page.locator('body').innerText({ timeout: 1200 }).catch(() => '');
    const looksLikePasswordWarning = /senha|palavra-passe|password|caduc|expir|faltam|alterar/i.test(String(pageText || ''));
    for (const buildLocator of selectors) {
      try {
        const locator = buildLocator();
        if ((await locator.count()) <= 0) continue;
        const visible = await locator.isVisible().catch(() => false);
        if (!visible) continue;
        if (!looksLikePasswordWarning) {
          const label = `${await locator.innerText().catch(() => '')} ${await locator.getAttribute('value').catch(() => '')}`;
          if (!/continuar|mais tarde|agora n[aã]o|n[aã]o alterar|ignorar/i.test(label)) continue;
        }
        await locator.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        return true;
      } catch (_) {
        // keep trying
      }
    }

    await page.waitForTimeout(250);
  }
  return false;
}

async function clickContinueToSegSocialPrompt(page, timeoutMs = 12_000) {
  const safeTimeout = Math.max(1000, Number(timeoutMs) || 12_000);
  const deadline = Date.now() + safeTimeout;
  const selectors = [
    () => page.getByRole('button', { name: /continuar\s+para\s+a\s+seguran[cç]a\s+social\s+direta/i }).first(),
    () => page.getByRole('link', { name: /continuar\s+para\s+a\s+seguran[cç]a\s+social\s+direta/i }).first(),
    () => page.getByRole('button', { name: /continuar\s+para\s+a\s+seguran[cç]a\s+social/i }).first(),
    () => page.getByRole('link', { name: /continuar\s+para\s+a\s+seguran[cç]a\s+social/i }).first(),
    () => page.locator('button, a', { hasText: /continuar\s+para\s+a\s+seguran[cç]a\s+social\s+direta/i }).first(),
    () => page.locator('button, a', { hasText: /continuar\s+para\s+a\s+seguran[cç]a\s+social/i }).first(),
    () => page.locator('input[type="submit"][value*="Continuar para a Segurança Social Direta"], input[type="button"][value*="Continuar para a Segurança Social Direta"]').first(),
    () => page.locator('input[type="submit"][value*="Continuar para a Segurança Social"], input[type="button"][value*="Continuar para a Segurança Social"]').first(),
  ];

  let sawIntermediatePage = false;
  while (Date.now() < deadline) {
    const manualState = await detectSegSocialManualRequired(page).catch(() => ({ manualRequired: false, reason: '' }));
    if (manualState.manualRequired) {
      return { clicked: false, manualRequired: true, reason: manualState.reason || 'Validação manual necessária.' };
    }

    const isIntermediate = await isSegSocialContinueIntermediatePage(page).catch(() => false);
    sawIntermediatePage = sawIntermediatePage || isIntermediate;

    for (const buildLocator of selectors) {
      try {
        const locator = buildLocator();
        if ((await locator.count()) <= 0) continue;
        const visible = await locator.isVisible().catch(() => false);
        if (!visible) continue;
        const beforeUrl = String(page.url() || '');
        await locator.click({ timeout: 3000 });
        await Promise.race([
          page.waitForURL((url) => String(url || '') !== beforeUrl, { timeout: Math.min(15_000, Math.max(3000, safeTimeout)) }).catch(() => null),
          page.waitForLoadState('domcontentloaded', { timeout: Math.min(15_000, Math.max(3000, safeTimeout)) }).catch(() => null),
          page.waitForTimeout(1200),
        ]);
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null);
        await page.waitForTimeout(900);

        const manualAfterClick = await detectSegSocialManualRequired(page).catch(() => ({ manualRequired: false, reason: '' }));
        if (manualAfterClick.manualRequired) {
          return { clicked: true, manualRequired: true, reason: manualAfterClick.reason || 'Validação manual necessária.' };
        }

        const stillIntermediate = await isSegSocialContinueIntermediatePage(page).catch(() => false);
        if (!stillIntermediate) {
          return { clicked: true, manualRequired: false, reason: '' };
        }
      } catch (_) {
        // keep trying
      }
    }
    await page.waitForTimeout(250);
  }

  if (sawIntermediatePage) {
    throw new Error('Botão "Continuar para a Segurança Social Direta" não encontrado ou a página seguinte não carregou.');
  }
  return { clicked: false, manualRequired: false, reason: '' };
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
  const rawCredentialLabel = String(payload?.credentialLabel || '').trim();
  const rawLoginUrl = String(payload?.loginUrl || '').trim();
  const isSegSocialFlow =
    rawCredentialLabel.toUpperCase() === 'SS' ||
    /seg-social\.pt/i.test(rawLoginUrl) ||
    String(payload?.postLoginFlow || '').trim() === SEG_SOCIAL_ENTERPRISE_SUBUSER_FLOW ||
    String(payload?.postLoginFlow || '').trim() === SEG_SOCIAL_LEGACY_SUBUSER_FLOW ||
    String(payload?.postLoginFlow || '').trim() === 'seg_social_activation_token_setup';
  const credentialLabel = rawCredentialLabel || (isSegSocialFlow ? 'SS' : 'AT');
  const normalizedCredentialLabel = isSegSocialFlow ? 'SS' : credentialLabel.toUpperCase();
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
  const segSocialPostLoginFlow = String(payload?.postLoginFlow || '').trim();
  const isEnterpriseSubUserFlow = segSocialPostLoginFlow === SEG_SOCIAL_ENTERPRISE_SUBUSER_FLOW;
  const isLegacySubUserFlow = segSocialPostLoginFlow === SEG_SOCIAL_LEGACY_SUBUSER_FLOW;
  const isSegSocialActivationTokenFlow = segSocialPostLoginFlow === 'seg_social_activation_token_setup';
  const segSocialLoginVerificationSinceIso = new Date(Date.now() - 2 * 60_000).toISOString();

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
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'https://www.seg-social.pt',
    }).catch(() => null);
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

    const afterSubmitWait = () => (
      normalizedCredentialLabel === 'SS' && isEnterpriseSubUserFlow
        ? Promise.race([
          page.waitForLoadState('domcontentloaded', { timeout: Math.min(8000, timeoutMs) }).catch(() => null),
          page.waitForTimeout(1200),
        ])
        : page.waitForLoadState('networkidle', { timeout: Math.min(30_000, timeoutMs) }).catch(() => null)
    );

    if (submitTarget?.locator) {
      await Promise.allSettled([
        afterSubmitWait(),
        submitTarget.locator.click(),
      ]);
    } else {
      await Promise.allSettled([
        afterSubmitWait(),
        passwordTarget.locator.press('Enter'),
      ]);
    }

    let manualRequiredReason = '';
    const resolveSegSocialEmailCodeIfPresent = async () => {
      if (manualRequiredReason || normalizedCredentialLabel !== 'SS' || isEnterpriseSubUserFlow) {
        return { handled: false, manualRequired: false, reason: '' };
      }
      const result = await handleSegSocialEmailVerificationCodeChallenge(
        page,
        payload,
        segSocialLoginVerificationSinceIso
      ).catch((error) => ({
        handled: true,
        manualRequired: true,
        reason: `Não consegui tratar o código por email automaticamente: ${error?.message || error}`,
      }));
      if (result?.manualRequired) {
        manualRequiredReason = result.reason || 'Validação por código de email necessária.';
      }
      return result;
    };
    const activationTokenFlowReady = async () => (
      normalizedCredentialLabel === 'SS' &&
      isSegSocialActivationTokenFlow &&
      await isSegSocialTwoFactorActivationCompleted(page).catch(() => false)
    );

    await resolveSegSocialEmailCodeIfPresent();

    if (normalizedCredentialLabel === 'SS' && isEnterpriseSubUserFlow) {
      await Promise.race([
        page.waitForLoadState('domcontentloaded', { timeout: Math.min(8000, timeoutMs) }).catch(() => null),
        page.waitForTimeout(900),
      ]);
    } else if (normalizedCredentialLabel === 'SS' && isLegacySubUserFlow) {
      if (await isSegSocialTwoFactorActivationPrompt(page).catch(() => false)) {
        await clickContinueWithoutActivatingIfPrompt(page, Math.min(2500, timeoutMs));
      }
    } else {
      if (!manualRequiredReason && !(await activationTokenFlowReady())) {
        await clickContinueLoginIf2faPrompt(page, Math.min(12_000, timeoutMs));
        await resolveSegSocialEmailCodeIfPresent();
      }
    }
    if (normalizedCredentialLabel === 'SS' && !isEnterpriseSubUserFlow) {
      if (isLegacySubUserFlow && await isSegSocialTwoFactorActivationPrompt(page).catch(() => false)) {
        await clickContinueWithoutActivatingIfPrompt(page, Math.min(2500, timeoutMs));
      }
      await resolveSegSocialEmailCodeIfPresent();
      if (!manualRequiredReason && !(await activationTokenFlowReady())) {
        const firstContinueResult =
          isLegacySubUserFlow && !await isSegSocialContinueIntermediatePage(page).catch(() => false)
            ? { clicked: false, manualRequired: false }
            : await clickContinueToSegSocialPrompt(page, Math.min(12_000, timeoutMs));
        if (firstContinueResult?.manualRequired) {
          await resolveSegSocialEmailCodeIfPresent();
          if (!manualRequiredReason) {
            manualRequiredReason = firstContinueResult.reason || 'Validação manual necessária.';
          }
        }
      }
      if (isLegacySubUserFlow) {
        if (await isSegSocialTwoFactorActivationPrompt(page).catch(() => false)) {
          await clickContinueWithoutActivatingIfPrompt(page, Math.min(2500, timeoutMs));
        }
      } else if (!isSegSocialActivationTokenFlow) {
        await clickContinueWithoutActivatingIfPrompt(page, Math.min(18_000, timeoutMs));
      }
      if (await isSegSocialContinueIntermediatePage(page).catch(() => false)) {
        await clickContinuePasswordExpiryPrompt(page, Math.min(12_000, timeoutMs));
      }
      await resolveSegSocialEmailCodeIfPresent();
      if (!manualRequiredReason && !(await activationTokenFlowReady())) {
        const secondContinueResult =
          isLegacySubUserFlow && !await isSegSocialContinueIntermediatePage(page).catch(() => false)
            ? { clicked: false, manualRequired: false }
            : await clickContinueToSegSocialPrompt(page, Math.min(8_000, timeoutMs));
        if (secondContinueResult?.manualRequired) {
          await resolveSegSocialEmailCodeIfPresent();
          if (!manualRequiredReason) {
            manualRequiredReason = secondContinueResult.reason || 'Validação manual necessária.';
          }
        }
      }
      await resolveSegSocialEmailCodeIfPresent();
      if (!manualRequiredReason && !(await activationTokenFlowReady())) {
        const manualState = await detectSegSocialManualRequired(page).catch(() => ({ manualRequired: false, reason: '' }));
        if (manualState.manualRequired) {
          await resolveSegSocialEmailCodeIfPresent();
          if (!manualRequiredReason) {
            manualRequiredReason = manualState.reason || 'Validação manual necessária.';
          }
        }
      }
      if (!manualRequiredReason && !(await activationTokenFlowReady()) && await isSegSocialContinueIntermediatePage(page).catch(() => false)) {
        throw new Error('A Segurança Social ficou no ecrã "Continuar para a Segurança Social Direta"; o botão não foi clicado automaticamente.');
      }
    }

    let postLoginFlowResult = null;
    if (!manualRequiredReason && normalizedCredentialLabel === 'SS' && isLegacySubUserFlow) {
      await dismissSegSocialActivationOfferForSubUser(page, Math.min(10_000, timeoutMs)).catch(() => false);
    }

    if (!manualRequiredReason && normalizedCredentialLabel === 'SS' && isEnterpriseSubUserFlow) {
      postLoginFlowResult = await runSegSocialEnterpriseSubUserSetupFlow(page, payload);
      if (postLoginFlowResult?.manualRequired) {
        manualRequiredReason = postLoginFlowResult.reason || 'Intervenção manual necessária na Segurança Social.';
      }
    }

    if (!manualRequiredReason && normalizedCredentialLabel === 'SS' && isLegacySubUserFlow) {
      postLoginFlowResult = await runSegSocialSubUserSetupFlow(page, payload, context);
      if (postLoginFlowResult?.manualRequired) {
        manualRequiredReason = postLoginFlowResult.reason || 'Intervenção manual necessária na Segurança Social.';
      }
    }

    if (!manualRequiredReason && normalizedCredentialLabel === 'SS' && isSegSocialActivationTokenFlow) {
      postLoginFlowResult = await runSegSocialActivationTokenSetupFlow(page, payload);
      if (postLoginFlowResult?.manualRequired) {
        manualRequiredReason = postLoginFlowResult.reason || 'Intervenção manual necessária na Segurança Social.';
      }
    }

    if (!manualRequiredReason && targetUrl) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => null);
    }

    const matchedSuccessTarget = await findFirstVisibleLocatorTarget(page, successSelectors, {
      waitTimeoutMs: 1500,
    });
    const matchedSuccessSelector = matchedSuccessTarget?.selector || null;
    const hasPasswordInputAfterSubmit = (await page.locator('input[type="password"]').count()) > 0;
    const loginState = manualRequiredReason
      ? 'MANUAL_REQUIRED'
      : matchedSuccessSelector
      ? 'logged_in'
      : hasPasswordInputAfterSubmit
        ? 'needs_manual_validation'
        : 'unknown';

    if (closeAfterSubmit) {
      await browser.close().catch(() => null);
      return {
        success: true,
        loginState,
        manualRequiredReason: manualRequiredReason || undefined,
        postLoginFlow: postLoginFlowResult || undefined,
        message: 'Autologin local executado. Browser fechado automaticamente.',
      };
    }

    return {
      success: true,
      loginState,
      manualRequiredReason: manualRequiredReason || undefined,
      postLoginFlow: postLoginFlowResult || undefined,
      message:
        normalizedCredentialLabel === 'SS'
          ? `Autologin Segurança Social iniciado no desktop (${launcherLabel}).`
          : `Autologin local iniciado no desktop (${launcherLabel}).`,
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

  ipcMain.handle('wa:read-clipboard-text', async () => {
    return String(clipboard.readText() || '').trim();
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
