'use strict';

const WA_ALLOWED_ORIGINS = new Set([
  'https://wa.mpr.pt',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3010',
  'http://127.0.0.1:3010',
]);

const TARGET_ALLOWED_HOSTS = [
  'www.acesso.gov.pt',
  'www.seg-social.pt',
  'www.portaldasfinancas.gov.pt',
  'sitfiscal.portaldasfinancas.gov.pt',
];

const SESSION_PREFIX = 'pendingLogin:';
const LAST_STATUS_KEY = 'lastStatus';
const CUSTOMER_CACHE_KEY = 'customerAccessCache';
const MAX_PENDING_AGE_MS = 2 * 60 * 1000;

function normalizeUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function senderOrigin(sender) {
  try {
    return new URL(sender?.url || sender?.tab?.url || '').origin;
  } catch (_) {
    return '';
  }
}

function isAllowedTarget(url) {
  if (!url || url.protocol !== 'https:') return false;
  return TARGET_ALLOWED_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

function sanitizePayload(payload) {
  const loginUrl = normalizeUrl(payload?.loginUrl);
  if (!isAllowedTarget(loginUrl)) {
    throw new Error('Destino de autologin não permitido pela extensão.');
  }

  const username = String(payload?.username || '').trim();
  const password = String(payload?.password || '').trim();
  if (!username || !password) {
    throw new Error('Credenciais incompletas.');
  }

  const sanitizeSelectors = (value) => Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 30)
    : undefined;

  return {
    username,
    password,
    loginUrl: loginUrl.href,
    credentialLabel: String(payload?.credentialLabel || '').trim().toUpperCase() || undefined,
    usernameSelectors: sanitizeSelectors(payload?.usernameSelectors),
    passwordSelectors: sanitizeSelectors(payload?.passwordSelectors),
    submitSelectors: sanitizeSelectors(payload?.submitSelectors),
    successSelectors: sanitizeSelectors(payload?.successSelectors),
    clickSubmit: payload?.clickSubmit !== false,
    createdAt: Date.now(),
  };
}

async function setLastStatus(status) {
  await chrome.storage.session.set({
    [LAST_STATUS_KEY]: {
      ...status,
      at: new Date().toISOString(),
    },
  });
}

async function storePendingLogin(tabId, payload) {
  await chrome.storage.session.set({ [`${SESSION_PREFIX}${tabId}`]: payload });
}

async function getPendingLogin(tabId) {
  const key = `${SESSION_PREFIX}${tabId}`;
  const data = await chrome.storage.session.get(key);
  const pending = data[key];
  if (!pending) return null;
  if (Date.now() - Number(pending.createdAt || 0) > MAX_PENDING_AGE_MS) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return pending;
}

async function clearPendingLogin(tabId) {
  await chrome.storage.session.remove(`${SESSION_PREFIX}${tabId}`);
}

async function readCustomerCache() {
  const data = await chrome.storage.local.get(CUSTOMER_CACHE_KEY);
  const cache = data[CUSTOMER_CACHE_KEY] || {};
  return {
    customers: Array.isArray(cache.customers) ? cache.customers : [],
    updatedAt: cache.updatedAt || '',
  };
}

async function writeCustomerCache(customers) {
  const safeCustomers = Array.isArray(customers) ? customers : [];
  const cache = { customers: safeCustomers, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [CUSTOMER_CACHE_KEY]: cache });
  return cache;
}

function waitForTabComplete(tabId, timeoutMs = 7000) {
  return new Promise((resolve) => {
    let done = false;
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function injectPortalAutofill(tabId) {
  try {
    await waitForTabComplete(tabId, 7000);
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['portal-autofill.js'],
    });
  } catch (error) {
    await setLastStatus({ ok: false, stage: 'inject_error', error: String(error?.message || error) });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'WA_PRO_AUTLOGIN_REQUEST') {
      const origin = senderOrigin(sender);
      const isExtensionPage = sender?.id === chrome.runtime.id && String(sender?.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`);
      if (!isExtensionPage && !WA_ALLOWED_ORIGINS.has(origin)) {
        throw new Error('Origem WA PRO não permitida pela extensão.');
      }

      const payload = sanitizePayload(message.payload || {});
      const tab = await chrome.tabs.create({ url: payload.loginUrl, active: true });
      await storePendingLogin(tab.id, payload);
      void injectPortalAutofill(tab.id);
      await setLastStatus({ ok: true, stage: 'opened', target: payload.credentialLabel || 'portal' });
      sendResponse({ success: true, tabId: tab.id, message: 'Autologin enviado para o Chrome.' });
      return;
    }

    if (message?.type === 'WA_PRO_PORTAL_READY') {
      const tabId = sender?.tab?.id;
      if (!tabId) {
        sendResponse({ success: false, error: 'Tab inválida.' });
        return;
      }
      const pending = await getPendingLogin(tabId);
      sendResponse({ success: true, payload: pending || null });
      return;
    }

    if (message?.type === 'WA_PRO_AUTLOGIN_DONE') {
      const tabId = sender?.tab?.id;
      if (tabId) await clearPendingLogin(tabId);
      await setLastStatus({ ok: true, stage: 'filled', target: message?.credentialLabel || 'portal' });
      sendResponse({ success: true });
      return;
    }

    if (message?.type === 'WA_PRO_AUTLOGIN_ERROR') {
      const tabId = sender?.tab?.id;
      if (tabId) await clearPendingLogin(tabId);
      await setLastStatus({ ok: false, stage: 'error', error: String(message?.error || 'Falha no autologin.') });
      sendResponse({ success: true });
      return;
    }


    if (message?.type === 'WA_PRO_POPUP_GET_CUSTOMERS') {
      const forceRefresh = message?.forceRefresh === true;
      const cached = await readCustomerCache();
      if (!forceRefresh && cached.customers.length > 0) {
        sendResponse({ success: true, customers: cached.customers, cached: true, updatedAt: cached.updatedAt });
        return;
      }

      const tabs = await chrome.tabs.query({});
      const waTabs = tabs.filter((tab) => {
        try {
          const origin = new URL(tab.url || '').origin;
          return WA_ALLOWED_ORIGINS.has(origin);
        } catch (_) {
          return false;
        }
      });

      for (const tab of waTabs) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { type: 'WA_PRO_COLLECT_CUSTOMERS' });
          if (response?.success && Array.isArray(response.customers) && response.customers.length > 0) {
            const cache = await writeCustomerCache(response.customers);
            sendResponse({ success: true, customers: cache.customers, cached: false, updatedAt: cache.updatedAt, sourceTabId: tab.id });
            return;
          }
        } catch (_) {
          // try next WA tab
        }
      }

      if (cached.customers.length > 0) {
        sendResponse({ success: true, customers: cached.customers, cached: true, stale: true, updatedAt: cached.updatedAt });
        return;
      }

      sendResponse({
        success: false,
        error: 'Abre/recarrega a WA PRO uma vez e clica em Atualizar acessos para carregar a extensão.',
      });
      return;
    }

    if (message?.type === 'WA_PRO_GET_STATUS') {
      const data = await chrome.storage.session.get(LAST_STATUS_KEY);
      sendResponse({ success: true, status: data[LAST_STATUS_KEY] || null });
      return;
    }

    sendResponse({ success: false, error: 'Mensagem desconhecida.' });
  })().catch((error) => {
    sendResponse({ success: false, error: String(error?.message || error) });
  });
  return true;
});
