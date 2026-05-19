'use strict';

const SEG_SOCIAL_LOGIN_URL = 'https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin';
const AT_LOGIN_URL = 'https://www.acesso.gov.pt/v2/loginForm?partID=PFAP';

const SEG_SOCIAL_USERNAME_SELECTORS = [
  'input[name="username"]', 'input[name="niss"]', 'input[id*="username" i]',
  'input[name*="user" i]', 'input[id*="utilizador" i]', 'input[name*="utilizador" i]',
  'input[id*="niss" i]', 'input[placeholder*="NISS" i]', 'input[autocomplete="username"]',
];
const SEG_SOCIAL_PASSWORD_SELECTORS = [
  'input[name="password"]', 'input[id*="password" i]', 'input[placeholder*="senha" i]', 'input[type="password"]',
];
const SEG_SOCIAL_SUBMIT_SELECTORS = [
  'button[type="submit"]', 'input[type="submit"]', 'button:has-text("Entrar")',
  'button:has-text("Iniciar sessão")', 'button:has-text("Autenticar")', 'button:has-text("Continuar")',
];

let customers = [];
let selected = null;

const el = {
  search: document.getElementById('search'),
  results: document.getElementById('results'),
  selected: document.getElementById('selected'),
  status: document.getElementById('status'),
  refresh: document.getElementById('refresh'),
  openWa: document.getElementById('openWa'),
};

function normalize(value) {
  return String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function digits(value) { return String(value || '').replace(/\D/g, ''); }
function normalizeNif(value) { return digits(value).slice(-9); }
function normalizeNiss(value) { return digits(value); }
function service(value) { return normalize(value).replace(/_/g, '-'); }
function isSegSocialCredential(credential) {
  const s = service(credential?.service);
  return s === 'ss' || s.includes('seguranca social') || s.includes('seg-social');
}
function isUsable(credential) {
  const status = service(credential?.status || 'active');
  const validUntil = String(credential?.validUntil || '').trim();
  const today = new Date().toISOString().slice(0, 10);
  return !['expired', 'inactive', 'error'].includes(status) && (!validUntil || validUntil >= today);
}
function normalizeSsUsername(username, fallbackNiss = '') {
  const raw = String(username || '').trim();
  const niss = normalizeNiss(fallbackNiss);
  if (niss && raw === `${niss}_1`) return `${niss}-1`;
  return raw.replace(/^(\d{11})_1$/, '$1-1');
}
function resolveAtAccess(customer) {
  const credentials = Array.isArray(customer?.accessCredentials) ? customer.accessCredentials : [];
  const cred = credentials.find((c) => {
    const s = service(c?.service);
    return s === 'at' || s.includes('autoridade') || s.includes('financ');
  }) || null;
  return {
    username: String(cred?.username || normalizeNif(customer?.nif) || '').trim(),
    password: String(cred?.password || customer?.senhaFinancas || '').trim(),
  };
}
function resolveSsPrincipal(customer) {
  const credentials = Array.isArray(customer?.accessCredentials) ? customer.accessCredentials : [];
  const cred = credentials.find((c) => {
    const type = service(c?.credentialType || '');
    return isSegSocialCredential(c) && (type === 'principal' || (!type && String(c?.service || '').trim().toUpperCase() === 'SS'));
  }) || null;
  return {
    username: String(cred?.username || normalizeNiss(customer?.niss) || '').trim(),
    password: String(cred?.password || customer?.senhaSegurancaSocial || '').trim(),
  };
}
function resolveSsSub(customer) {
  const credentials = Array.isArray(customer?.accessCredentials) ? customer.accessCredentials : [];
  const subs = credentials.filter((c) => isSegSocialCredential(c) && service(c?.credentialType || '').includes('sub'));
  const cred = subs.find((c) => String(c?.username || '').trim() && String(c?.password || '').trim() && isUsable(c)) ||
    subs.find((c) => String(c?.username || '').trim() && String(c?.password || '').trim()) ||
    subs.find((c) => String(c?.username || '').trim()) || subs[0] || null;
  return {
    username: normalizeSsUsername(String(cred?.username || '').trim(), customer?.niss),
    password: String(cred?.password || '').trim(),
  };
}
function customerLabel(customer) {
  return String(customer?.company || customer?.name || customer?.nif || 'Cliente').trim();
}
function searchableText(customer) {
  return normalize([
    customer?.name, customer?.company, customer?.nif, customer?.niss, customer?.email, customer?.phone,
  ].filter(Boolean).join(' '));
}

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(response || {})));
}

async function callWaProDesktopBridge(payload) {
  const response = await fetch('http://127.0.0.1:30777/financas-autologin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.success) {
    throw new Error(String(body?.error || `Bridge local respondeu ${response.status}.`));
  }
  return body;
}

function buildAutologinPayload(label, access) {
  const isSegSocial = label === 'SS';
  return {
    username: access.username,
    password: access.password,
    loginUrl: isSegSocial ? SEG_SOCIAL_LOGIN_URL : AT_LOGIN_URL,
    closeAfterSubmit: false,
    returnAfterSubmit: label === 'AT',
    browserChannel: 'chrome',
    credentialLabel: label,
    apiBaseUrl: 'https://wa.mpr.pt',
    usernameSelectors: isSegSocial ? SEG_SOCIAL_USERNAME_SELECTORS : undefined,
    passwordSelectors: isSegSocial ? SEG_SOCIAL_PASSWORD_SELECTORS : undefined,
    submitSelectors: isSegSocial ? SEG_SOCIAL_SUBMIT_SELECTORS : undefined,
    activateFinancasNifTab: !isSegSocial,
    timeoutMs: isSegSocial ? 180000 : 90000,
    emailChallengeWaitMs: isSegSocial ? 2500 : undefined,
    emailPollMs: isSegSocial ? 25000 : undefined,
    emailPollIntervalMs: isSegSocial ? 1500 : undefined,
    emailRequestTimeoutMs: isSegSocial ? 3500 : undefined,
  };
}

async function fetchCustomersFromWaApi() {
  const bases = [
    'https://wa.mpr.pt',
    'http://127.0.0.1:3010',
    'http://localhost:3010',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ];

  for (const base of bases) {
    try {
      const response = await fetch(`${base}/api/import/supabase`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'include',
      });
      if (!response.ok) continue;
      const payload = await response.json().catch(() => ({}));
      const list = Array.isArray(payload.customers) ? payload.customers : [];
      if (list.length > 0) return list;
    } catch (_) {
      // try next base
    }
  }

  return [];
}

async function loadCustomers(forceRefresh = false) {
  el.status.textContent = forceRefresh ? 'A atualizar acessos a partir da WA PRO...' : 'A ler acessos guardados...';
  let response = await sendMessage({ type: 'WA_PRO_POPUP_GET_CUSTOMERS', forceRefresh });
  let list = response.success && Array.isArray(response.customers) ? response.customers : [];

  if (list.length === 0) {
    list = await fetchCustomersFromWaApi();
  }

  customers = Array.isArray(list) ? list.filter((customer) => customer?.id) : [];
  customers.sort((a, b) => customerLabel(a).localeCompare(customerLabel(b), 'pt'));
  el.status.textContent = customers.length
    ? `${customers.length} cliente(s) carregado(s).`
    : 'Sem acessos carregados. Abre/recarrega a WA PRO uma vez e clica em Atualizar acessos.';
  if (response?.cached && customers.length > 0) {
    const suffix = response.updatedAt ? ` · ${new Date(response.updatedAt).toLocaleString('pt-PT')}` : '';
    el.status.textContent = `${customers.length} cliente(s) carregado(s) da extensão${suffix}.`;
  }
  renderResults();
}

function renderResults() {
  const q = normalize(el.search.value);
  const parts = q.split(/\s+/).filter(Boolean);
  const list = customers
    .filter((customer) => !parts.length || parts.every((part) => searchableText(customer).includes(part)))
    .slice(0, 8);
  el.results.innerHTML = '';
  list.forEach((customer) => {
    const btn = document.createElement('button');
    btn.className = `result${selected?.id === customer.id ? ' active' : ''}`;
    btn.innerHTML = `<strong>${escapeHtml(customerLabel(customer))}</strong><span>${escapeHtml(customer.nif || 'sem NIF')} · ${escapeHtml(customer.name || '')}</span>`;
    btn.addEventListener('click', () => {
      selected = customer;
      renderResults();
      renderSelected();
    });
    el.results.appendChild(btn);
  });
}

function renderSelected() {
  if (!selected) {
    el.selected.hidden = true;
    return;
  }
  const at = resolveAtAccess(selected);
  const ss = resolveSsPrincipal(selected);
  const sub = resolveSsSub(selected);
  el.selected.hidden = false;
  el.selected.innerHTML = `
    <div class="entity">${escapeHtml(customerLabel(selected))}</div>
    <div class="meta">NIF: ${escapeHtml(selected.nif || '—')} · NISS: ${escapeHtml(selected.niss || '—')}</div>
    <div class="access-title">Acessos:</div>
    <div class="buttons">
      <button id="btnAt" class="access at" ${at.username && at.password ? '' : 'disabled'} title="Portal das Finanças">
        <img class="icon-img" src="access-icons/financas.png" alt="Finanças" />
      </button>
      <button id="btnSs" class="access ss" ${ss.username && ss.password ? '' : 'disabled'} title="Segurança Social principal">
        <img class="icon-img" src="access-icons/ss.png" alt="Segurança Social Principal" />
      </button>
      <button id="btnSub" class="access sub" ${sub.username && sub.password ? '' : 'disabled'} title="Subutilizador Segurança Social">
        <img class="icon-img" src="access-icons/sub_ss.png" alt="Subutilizador Segurança Social" />
      </button>
    </div>
  `;
  document.getElementById('btnAt')?.addEventListener('click', () => openAccess('AT', at));
  document.getElementById('btnSs')?.addEventListener('click', () => openAccess('SS', ss, false));
  document.getElementById('btnSub')?.addEventListener('click', () => openAccess('SS', sub, true));
}

async function openAccess(label, access, isSub = false) {
  if (!access?.username || !access?.password) return;
  const accessLabel = `${label}${isSub ? ' subutilizador' : ''}`;
  const payload = buildAutologinPayload(label, access);

  try {
    el.status.textContent = `A usar automação WA PRO Desktop para ${accessLabel}...`;
    const result = await callWaProDesktopBridge(payload);
    el.status.textContent = String(result.message || `Autologin ${accessLabel} iniciado pela WA PRO Desktop.`);
    return;
  } catch (bridgeError) {
    const message = String(bridgeError?.message || bridgeError || '').toLowerCase();
    const bridgeUnavailable =
      message.includes('failed to fetch') ||
      message.includes('connection') ||
      message.includes('network') ||
      message.includes('fetch') ||
      message.includes('já existe um autologin') ||
      message.includes('ja existe um autologin') ||
      message.includes('autologin local em execucao') ||
      message.includes('autologin local em execução');
    if (!bridgeUnavailable) {
      el.status.innerHTML = `<span class="error">${escapeHtml(String(bridgeError?.message || bridgeError))}</span>`;
      return;
    }
  }

  el.status.textContent = `WA PRO Desktop ocupado/indisponível; a tentar preenchimento simples no Chrome para ${accessLabel}...`;
  const response = await sendMessage({
    type: 'WA_PRO_AUTLOGIN_REQUEST',
    payload: {
      ...payload,
      clickSubmit: true,
    },
  });
  if (!response.success) throw new Error(response.error || 'Falha ao abrir autologin.');
  el.status.textContent = 'Portal aberto. A extensão vai preencher quando encontrar o formulário.';
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

el.search.addEventListener('input', renderResults);
el.refresh.textContent = 'Atualizar acessos';
el.refresh.addEventListener('click', () => loadCustomers(true).catch((error) => { el.status.innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`; }));
el.openWa.addEventListener('click', () => chrome.tabs.create({ url: 'https://wa.mpr.pt/#/customers' }));

document.addEventListener('DOMContentLoaded', () => {
  loadCustomers().catch((error) => {
    el.status.innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`;
  });
  el.search.focus();
});
