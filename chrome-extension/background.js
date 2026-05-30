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
  'app.seg-social.pt',
  'extwww.seg-social.pt',
  'www.bportugal.pt',
  'clientebancario.bportugal.pt',
  'sts.bportugal.pt',
  'iefponline.iefp.pt',
  'webapps.iapmei.pt',
  'viactt.pt',
  'www.viactt.pt',
  'www.relatoriounico.pt',
  'www.portaldasfinancas.gov.pt',
  'sitfiscal.portaldasfinancas.gov.pt',
];

const AUTOFILL_ALLOWED_HOSTS = [
  'www.acesso.gov.pt',
  'www.seg-social.pt',
  'app.seg-social.pt',
  'extwww.seg-social.pt',
  'sts.bportugal.pt',
  'iefponline.iefp.pt',
  'webapps.iapmei.pt',
  'viactt.pt',
  'www.viactt.pt',
  'www.relatoriounico.pt',
  'www.portaldasfinancas.gov.pt',
  'sitfiscal.portaldasfinancas.gov.pt',
];

const SESSION_PREFIX = 'pendingLogin:';
const LAST_STATUS_KEY = 'lastStatus';
const CUSTOMER_CACHE_KEY = 'customerAccessCache';
const MAX_PENDING_AGE_MS = 7 * 60 * 1000;

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

function isAutofillTarget(url) {
  if (!url || url.protocol !== 'https:') return false;
  return AUTOFILL_ALLOWED_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

function portalAutofillFiles(url) {
  const hostname = String(url?.hostname || '').toLowerCase();
  let portalFile = 'portal-at.js';
  if (hostname === 'iefponline.iefp.pt') portalFile = 'portal-iefp.js';
  else if (hostname.endsWith('seg-social.pt')) portalFile = 'portal-seg-social.js';
  else if (hostname === 'sts.bportugal.pt') portalFile = 'portal-banco-portugal.js';
  else if (hostname === 'clientebancario.bportugal.pt') portalFile = 'portal-crc-bp.js';
  else if (hostname === 'webapps.iapmei.pt') portalFile = 'portal-iapmei.js';
  else if (hostname === 'viactt.pt' || hostname === 'www.viactt.pt') portalFile = 'portal-viactt.js';
  else if (hostname === 'www.relatoriounico.pt') portalFile = 'portal-relatorio-unico.js';
  return ['portal-common.js', portalFile, 'portal-autofill.js'];
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
    entityNif: String(payload?.entityNif || '').replace(/\D/g, '').slice(-9) || undefined,
    loginUrl: loginUrl.href,
    credentialLabel: String(payload?.credentialLabel || '').trim().toUpperCase() || undefined,
    usernameSelectors: sanitizeSelectors(payload?.usernameSelectors),
    passwordSelectors: sanitizeSelectors(payload?.passwordSelectors),
    submitSelectors: sanitizeSelectors(payload?.submitSelectors),
    successSelectors: sanitizeSelectors(payload?.successSelectors),
    clickSubmit: payload?.clickSubmit !== false,
    keepPendingAfterSubmit: payload?.keepPendingAfterSubmit === true,
    apiBaseUrl: String(payload?.apiBaseUrl || '').trim() || undefined,
    emailPollMs: Number(payload?.emailPollMs || 0) || undefined,
    collectBpCrc: payload?.collectBpCrc === true,
    customerId: String(payload?.customerId || '').trim() || undefined,
    emailPollIntervalMs: Number(payload?.emailPollIntervalMs || 0) || undefined,
    emailRequestTimeoutMs: Number(payload?.emailRequestTimeoutMs || 0) || undefined,
    forceFreshSession: payload?.forceFreshSession === true,
    logoutAttempted: payload?.logoutAttempted === true,
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

async function setAutologinBadge(active, label = '') {
  try {
    await chrome.action.setBadgeText({ text: active ? '...' : '' });
    if (active) {
      await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
      await chrome.action.setTitle({ title: label ? `WA PRO Auto Login - ${label}` : 'WA PRO Auto Login em curso' });
    } else {
      await chrome.action.setTitle({ title: 'WA PRO Auto Login' });
    }
  } catch (_) {
    // Badge updates are best-effort only.
  }
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

async function updatePendingLogin(tabId, patch) {
  const pending = await getPendingLogin(tabId);
  if (!pending) return;
  await chrome.storage.session.set({
    [`${SESSION_PREFIX}${tabId}`]: {
      ...pending,
      ...patch,
    },
  });
}

async function fetchSegSocialCodeFromWa(payload = {}) {
  const apiBaseUrl = normalizeUrl(payload?.apiBaseUrl || 'https://wa.mpr.pt');
  if (!apiBaseUrl || apiBaseUrl.origin !== 'https://wa.mpr.pt') {
    throw new Error('Origem de email não permitida.');
  }

  const sinceMs = Math.max(0, (Number(payload?.createdAt || Date.now()) || Date.now()) - 20_000);
  const query = new URLSearchParams({
    verificationOnly: '1',
    maxMessages: '30',
    sinceIso: new Date(sinceMs).toISOString(),
  });
  const response = await fetch(`${apiBaseUrl.origin}/api/email/seg-social/latest-code?${query.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'include',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body?.error || `Falha ao consultar email (${response.status}).`));
  }
  return body?.success && body?.found ? String(body?.result?.code || '').trim() : '';
}

async function readCustomerCache() {
  const data = await chrome.storage.session.get(CUSTOMER_CACHE_KEY);
  const cache = data[CUSTOMER_CACHE_KEY] || {};
  return {
    customers: Array.isArray(cache.customers) ? cache.customers : [],
    updatedAt: cache.updatedAt || '',
  };
}

async function writeCustomerCache(customers) {
  const safeCustomers = Array.isArray(customers) ? customers : [];
  const cache = { customers: safeCustomers, updatedAt: new Date().toISOString() };
  await chrome.storage.session.set({ [CUSTOMER_CACHE_KEY]: cache });
  return cache;
}

chrome.storage.local.remove(CUSTOMER_CACHE_KEY).catch(() => {});

async function waitForTabComplete(tabId, timeoutMs = 7000) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (current?.status === 'complete') return;
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

async function injectPortalAutofill(tabId, { waitForComplete = true } = {}) {
  try {
    if (waitForComplete) await waitForTabComplete(tabId, 7000);
    const tab = await chrome.tabs.get(tabId);
    const tabUrl = normalizeUrl(tab?.url);
    if (!isAutofillTarget(tabUrl)) return false;
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: portalAutofillFiles(tabUrl),
    });
    return true;
  } catch (error) {
    await setLastStatus({ ok: false, stage: 'inject_error', error: String(error?.message || error) });
    return false;
  }
}

function schedulePortalAutofill(tabId) {
  const delays = [0, 600, 1500, 3500, 7000];
  for (const delay of delays) {
    setTimeout(() => {
      getPendingLogin(tabId)
        .then((pending) => {
          if (pending) void injectPortalAutofill(tabId, { waitForComplete: false });
        })
        .catch(() => {});
    }, delay);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete' && !changeInfo.url) return;
  const tabUrl = normalizeUrl(tab?.url);
  if (!isAutofillTarget(tabUrl)) return;

  getPendingLogin(tabId)
    .then((pending) => {
      if (pending) void injectPortalAutofill(tabId, { waitForComplete: false });
    })
    .catch(() => {});
});

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
      await setAutologinBadge(true, payload.credentialLabel || 'portal');
      schedulePortalAutofill(tab.id);
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

    if (message?.type === 'WA_PRO_GET_SEG_SOCIAL_CODE') {
      const tabId = sender?.tab?.id;
      if (!tabId) {
        sendResponse({ success: false, error: 'Tab inválida.' });
        return;
      }
      const pending = await getPendingLogin(tabId);
      if (!pending || String(pending.credentialLabel || '').toUpperCase() !== 'SS') {
        sendResponse({ success: false, error: 'Pedido SS expirado ou inexistente.' });
        return;
      }
      const code = await fetchSegSocialCodeFromWa(pending);
      sendResponse({ success: true, found: Boolean(code), code });
      return;
    }

    if (message?.type === 'WA_PRO_AUTLOGIN_DONE') {
      const tabId = sender?.tab?.id;
      if (tabId && message?.keepPending === true) {
        if (message?.submitted === true) {
          await updatePendingLogin(tabId, {
            forceFreshSession: false,
            loginAttempted: true,
            createdAt: Number(message?.submittedAt || Date.now()) || Date.now(),
          });
        } else if (message?.logoutAttempted === true) {
          await updatePendingLogin(tabId, { logoutAttempted: true });
        }
      } else if (tabId) {
        await clearPendingLogin(tabId);
        await setAutologinBadge(false);
      }
      await setLastStatus({ ok: true, stage: 'filled', target: message?.credentialLabel || 'portal' });
      sendResponse({ success: true });
      return;
    }

    if (message?.type === 'WA_PRO_AUTLOGIN_ERROR') {
      const tabId = sender?.tab?.id;
      if (tabId) await clearPendingLogin(tabId);
      await setAutologinBadge(false);
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
