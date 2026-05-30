'use strict';

const SEG_SOCIAL_LOGIN_URL = 'https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin';
const AT_LOGIN_URL = 'https://www.acesso.gov.pt/v2/loginForm?partID=PFAP';
const BANCO_PORTUGAL_CRC_PARTICULAR_URL = 'https://clientebancario.bportugal.pt/pt-pt/responsabilidades-de-credito';
const BANCO_PORTUGAL_EMPRESA_URL = 'https://www.bportugal.pt/login/adfs';
const IEFP_LOGIN_URL = 'https://iefponline.iefp.pt/IEFP/authentication/loginUser.jsp#';
const IAPMEI_CERTIFICATION_LOGIN_URL = 'https://webapps.iapmei.pt/PME/Account/Login.aspx';
const VIACTT_LOGIN_URL = 'https://www.viactt.pt/fevia/app/auth/checkUser.jspx';
const RELATORIO_UNICO_LOGIN_URL = 'https://www.relatoriounico.pt/ru/login.seam';

const DIRECT_ACCESS_CONFIG = [
  {
    key: 'crc',
    label: 'Banco de Portugal',
    meta: (customer) => bancoPortugalAccessContext(customer).meta,
    icon: 'access-icons/04_banco_portugal.png',
    url: (customer) => bancoPortugalAccessContext(customer).url,
    title: (customer) => `${bancoPortugalAccessContext(customer).title} Usa autenticação com credenciais do Portal das Finanças.`,
  },
  {
    key: 'certidao',
    label: 'Certidão Permanente',
    icon: 'access-icons/05_certidao_permanente.png',
    meta: (customer) => customer.certidaoPermanenteNumero ? `Código ${customer.certidaoPermanenteNumero}` : 'Consulta',
    url: (customer) => {
      const code = String(customer.certidaoPermanenteNumero || '').trim();
      const base = 'https://registo.justica.gov.pt/Empresas/Consultar-Certidao-Permanente/Iniciar';
      return code ? `${base}?codcertidao=${encodeURIComponent(code)}` : base;
    },
    title: (customer) => customer.certidaoPermanenteNumero
      ? 'Abre a consulta com o código da certidão guardado na ficha.'
      : 'Abre a consulta da certidão permanente. Sem código guardado nesta ficha.',
  },
  {
    key: 'iefp',
    label: 'IEFP Online',
    meta: (customer) => isPrivateCustomer(customer) ? 'Particular · SS' : 'Empregador · SS',
    icon: 'access-icons/06_iefp_online.png',
    url: () => IEFP_LOGIN_URL,
    title: () => 'IEFP Online. Usa autenticação por Segurança Social Direta.',
  },
  {
    key: 'lre',
    label: 'Livro Reclamações',
    meta: 'Operador',
    icon: 'access-icons/07_livro_reclamacoes.png',
    url: () => 'https://www.livroreclamacoes.pt/entrar',
    title: () => 'Livro de Reclamações Eletrónico para operador económico.',
  },
  {
    key: 'siliamb',
    label: 'SILiAmb / APA',
    meta: 'Credenciais próprias',
    icon: 'access-icons/08_siliamb_apa.png',
    url: () => 'https://siliamb.apambiente.pt/pages/public/login.xhtml',
    title: () => 'SILiAmb / APA. Usa as credenciais próprias do portal.',
  },
  {
    key: 'iapmei',
    label: 'IAPMEI',
    meta: 'Processo PME',
    icon: 'access-icons/09_iapmei.png',
    url: () => IAPMEI_CERTIFICATION_LOGIN_URL,
    title: () => 'Entra diretamente no processo de Certificação PME.',
  },
  {
    key: 'balcao',
    label: 'Balcão Empreendedor',
    icon: 'access-icons/10_balcao_empreendedor.png',
    meta: (customer) => customer.caePrincipal ? `CAE ${customer.caePrincipal}` : 'Licenciamentos',
    url: () => 'https://www2.gov.pt/inicio/balcao-do-empreendedor',
    title: (customer) => customer.caePrincipal
      ? `Consulta licenciamento pelo CAE ${customer.caePrincipal}.`
      : 'Consulta licenciamentos e serviços por atividade económica/CAE.',
  },
  {
    key: 'viactt',
    label: 'ViaCTT',
    meta: 'Credenciais próprias',
    icon: 'access-icons/11_viactt.png',
    url: () => VIACTT_LOGIN_URL,
    title: () => 'ViaCTT. Usa as credenciais próprias do portal.',
  },
  {
    key: 'relatorio-unico',
    label: 'Relatório Único',
    meta: 'Credenciais próprias',
    icon: 'access-icons/12_relatorio_unico.png',
    url: () => RELATORIO_UNICO_LOGIN_URL,
    title: () => 'Relatório Único. Usa as credenciais próprias do portal.',
  },
];

const SEG_SOCIAL_USERNAME_SELECTORS = [
  'input[name="username"]', 'input[name="niss"]', 'input[id*="username" i]',
  'input[name*="user" i]', 'input[id*="utilizador" i]', 'input[name*="utilizador" i]',
  'input[id*="niss" i]', 'input[placeholder*="NISS" i]', 'input[autocomplete="username"]',
];
const SEG_SOCIAL_PASSWORD_SELECTORS = [
  'input[name="password"]', 'input[id*="password" i]', 'input[placeholder*="senha" i]', 'input[type="password"]',
];
const SEG_SOCIAL_SUBMIT_SELECTORS = [
  'form button[type="submit"]', 'form input[type="submit"]',
  'button[type="submit"]', 'input[type="submit"]',
];

let customers = [];
let selected = null;
let visibleResults = [];
let focusedResultIndex = -1;
let lastCustomersUpdatedAt = '';
let statusTimer = null;

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
function isPersonalNif(value) {
  return /^[123]/.test(normalizeNif(value));
}
function isPrivateCustomer(customer) {
  const type = service(customer?.type || '');
  if (type.includes('particular') || type.includes('independente')) return true;
  if (type.includes('empresa') || type.includes('fornecedor') || type.includes('servicos publicos')) return false;
  return isPersonalNif(customer?.nif);
}
function bancoPortugalAccessContext(customer) {
  const particular = isPrivateCustomer(customer);
  return particular
    ? {
      mode: 'particular',
      meta: 'Particular · AT',
      title: 'Abre a CRC para particulares.',
      url: BANCO_PORTUGAL_CRC_PARTICULAR_URL,
    }
    : {
      mode: 'empresa',
      meta: 'Empresa · AT',
      title: 'Abre a Área de Empresa do Banco de Portugal.',
      url: BANCO_PORTUGAL_EMPRESA_URL,
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
function resolveIapmeiAccess(customer) {
  return resolvePortalCredential(customer, ['iapmei'], normalizeNif(customer?.nif));
}
function resolveViaCttAccess(customer) {
  return resolvePortalCredential(customer, ['viactt', 'via ctt', 'via-ctt'], normalizeNif(customer?.nif));
}
function resolveRelatorioUnicoAccess(customer) {
  return resolvePortalCredential(customer, ['relatorio unico', 'relatório único', 'relatorio-unico', 'ru'], normalizeNif(customer?.nif));
}
function resolvePortalCredential(customer, serviceNames, fallbackUsername = '') {
  const credentials = Array.isArray(customer?.accessCredentials) ? customer.accessCredentials : [];
  const normalizedNames = serviceNames.map(service);
  const cred = credentials.find((c) => {
    const s = service(c?.service);
    const label = service(`${c?.label || ''} ${c?.name || ''} ${c?.description || ''}`);
    return normalizedNames.some((name) => s === name || s.includes(name) || label.includes(name));
  }) || null;
  return {
    username: String(cred?.username || fallbackUsername || '').trim(),
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

function directAccessItems(customer) {
  return DIRECT_ACCESS_CONFIG.map((item) => ({
    ...item,
    url: item.url(customer),
    metaText: typeof item.meta === 'function' ? item.meta(customer) : item.meta,
    titleText: typeof item.title === 'function' ? item.title(customer) : item.title,
  }));
}

function renderAccessButton({ key, label, meta, icon, title, disabled = false, state = 'manual' }) {
  return `
      <button class="quick-link ${escapeHtml(state)}" data-access-key="${escapeHtml(key)}" ${disabled ? 'disabled' : ''} title="${escapeHtml(title)}">
        <img class="quick-icon" src="${escapeHtml(icon)}" alt="" />
        <span>
          <span class="quick-label">${escapeHtml(label)}</span>
          <span class="quick-meta">${escapeHtml(meta)}</span>
        </span>
      </button>
    `;
}

function showStatus(message, { error = false, autoHide = !error } = {}) {
  if (statusTimer) clearTimeout(statusTimer);
  el.status.hidden = false;
  el.status.innerHTML = error
    ? `<span class="error">${escapeHtml(message)}</span>`
    : escapeHtml(message);
  if (autoHide) {
    statusTimer = setTimeout(() => {
      el.status.hidden = true;
      el.status.textContent = '';
    }, 6000);
  }
}

function formatRelativeTime(iso) {
  const then = Date.parse(String(iso || ''));
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'agora mesmo';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  return `há ${days} d`;
}

function renderAccessButtons(customer, at, ss, sub) {
  const iapmei = resolveIapmeiAccess(customer);
  const viactt = resolveViaCttAccess(customer);
  const relatorioUnico = resolveRelatorioUnicoAccess(customer);
  const ownPortalAccess = { iapmei, viactt, 'relatorio-unico': relatorioUnico };
  const primary = [
    {
      key: 'at',
      label: 'Finanças',
      meta: at.username && at.password ? 'Autologin' : 'Sem credenciais',
      icon: 'access-icons/01_financas.png',
      title: 'Portal das Finanças',
      disabled: !(at.username && at.password),
      state: at.username && at.password ? 'ready' : 'missing',
    },
    {
      key: 'ss',
      label: 'Seg. Social',
      meta: ss.username && ss.password ? 'Autologin' : 'Sem credenciais',
      icon: 'access-icons/02_seguranca_social.png',
      title: 'Segurança Social principal',
      disabled: !(ss.username && ss.password),
      state: ss.username && ss.password ? 'ready' : 'missing',
    },
    {
      key: 'sub',
      label: 'Sub SS',
      meta: sub.username && sub.password ? 'Autologin sub' : 'Sem credenciais',
      icon: 'access-icons/03_subutilizador_ss.png',
      title: 'Subutilizador Segurança Social',
      disabled: !(sub.username && sub.password),
      state: sub.username && sub.password ? 'ready' : 'missing',
    },
  ];
  const direct = directAccessItems(customer).map((item) => ({
    key: item.key,
    label: item.label,
    meta: ownPortalAccess[item.key]
      ? (ownPortalAccess[item.key].username && ownPortalAccess[item.key].password ? 'Autologin' : 'Sem credenciais')
      : item.key === 'crc'
        ? (at.username && at.password ? item.metaText : 'Abre apenas')
        : item.metaText,
    icon: item.icon,
    title: item.titleText,
    state: ownPortalAccess[item.key]
      ? (ownPortalAccess[item.key].username && ownPortalAccess[item.key].password ? 'ready' : 'missing')
      : item.key === 'crc' && at.username && at.password
        ? 'ready'
        : 'manual',
  }));
  return [...primary, ...direct].map(renderAccessButton).join('');
}

async function openBancoPortugalAccess() {
  if (!selected) return;
  el.status.hidden = false;
  const context = bancoPortugalAccessContext(selected);
  const at = resolveAtAccess(selected);

  if (!at.username || !at.password) {
    chrome.tabs.create({ url: context.url, active: true });
    showStatus(`Abri Banco de Portugal (${context.mode}), mas este cliente não tem credenciais AT completas.`);
    return;
  }

  const response = await sendMessage({
    type: 'WA_PRO_AUTLOGIN_REQUEST',
    payload: {
      ...buildAutologinPayload('AT', at, {
        loginUrl: context.url,
        returnAfterSubmit: false,
        keepPendingAfterSubmit: true,
      }),
      clickSubmit: true,
    },
  });
  if (!response.success) throw new Error(response.error || 'Falha ao abrir Banco de Portugal.');
  showStatus(`Banco de Portugal aberto em modo ${context.mode}. Quando surgir o Portal das Finanças, a extensão tenta preencher o login AT.`);
}

function resolveIefpAccess(customer) {
  const principal = resolveSsPrincipal(customer);
  const sub = resolveSsSub(customer);
  if (!isPrivateCustomer(customer) && sub.username && sub.password) {
    return { access: sub, mode: 'empregador' };
  }
  return { access: principal, mode: isPrivateCustomer(customer) ? 'particular' : 'empregador' };
}

async function openIefpAccess() {
  if (!selected) return;
  el.status.hidden = false;
  const { access, mode } = resolveIefpAccess(selected);

  if (!access.username || !access.password) {
    chrome.tabs.create({ url: IEFP_LOGIN_URL, active: true });
    showStatus(`Abri IEFP Online (${mode}), mas este cliente não tem credenciais SS Direta completas.`);
    return;
  }

  const response = await sendMessage({
    type: 'WA_PRO_AUTLOGIN_REQUEST',
    payload: {
      ...buildAutologinPayload('SS', access, {
        loginUrl: IEFP_LOGIN_URL,
        returnAfterSubmit: false,
        keepPendingAfterSubmit: true,
      }),
      clickSubmit: true,
    },
  });
  if (!response.success) throw new Error(response.error || 'Falha ao abrir IEFP Online.');
  showStatus(`IEFP Online aberto em modo ${mode}. Quando surgir a Segurança Social Direta, a extensão tenta preencher o login SS.`);
}

async function openIapmeiAccess() {
  if (!selected) return;
  el.status.hidden = false;
  const access = resolveIapmeiAccess(selected);

  if (!access.username || !access.password) {
    chrome.tabs.create({ url: IAPMEI_CERTIFICATION_LOGIN_URL, active: true });
    showStatus('Abri Certificação PME, mas este cliente não tem credenciais IAPMEI completas.');
    return;
  }

  const response = await sendMessage({
    type: 'WA_PRO_AUTLOGIN_REQUEST',
    payload: {
      ...buildAutologinPayload('IAPMEI', access, {
        loginUrl: IAPMEI_CERTIFICATION_LOGIN_URL,
        returnAfterSubmit: false,
      }),
      clickSubmit: true,
    },
  });
  if (!response.success) throw new Error(response.error || 'Falha ao abrir Certificação PME.');
  showStatus('Certificação PME aberta. A extensão vai tentar preencher o login IAPMEI.');
}

async function openOwnCredentialsPortal({ key, label, loginUrl, credentialLabel, resolveAccess }) {
  if (!selected) return;
  el.status.hidden = false;
  const access = resolveAccess(selected);

  if (!access.username || !access.password) {
    chrome.tabs.create({ url: loginUrl, active: true });
    showStatus(`Abri ${label}, mas este cliente não tem credenciais completas para este portal.`);
    return;
  }

  const response = await sendMessage({
    type: 'WA_PRO_AUTLOGIN_REQUEST',
    payload: {
      ...buildAutologinPayload(credentialLabel, access, {
        loginUrl,
        returnAfterSubmit: false,
      }),
      entityNif: credentialLabel === 'RELATORIO_UNICO' ? normalizeNif(selected?.nif) : undefined,
      clickSubmit: true,
    },
  });
  if (!response.success) throw new Error(response.error || `Falha ao abrir ${label}.`);
  showStatus(`${label} aberto. A extensão vai tentar preencher o login.`);
}

async function refreshLastStatus() {
  const response = await sendMessage({ type: 'WA_PRO_GET_STATUS' });
  const status = response?.status || null;
  if (!status || status.ok !== false) return;
  const at = Date.parse(status.at || '');
  if (Number.isFinite(at) && Date.now() - at > 2 * 60_000) return;
  el.status.hidden = false;
  showStatus(status.error || 'Falha no último autologin.', { error: true });
}

function openDirectAccess(key) {
  el.status.hidden = false;
  if (key === 'crc') {
    openBancoPortugalAccess().catch((error) => {
      showStatus(String(error?.message || error), { error: true });
    });
    return;
  }
  if (key === 'iefp') {
    openIefpAccess().catch((error) => {
      showStatus(String(error?.message || error), { error: true });
    });
    return;
  }
  if (key === 'iapmei') {
    openIapmeiAccess().catch((error) => {
      showStatus(String(error?.message || error), { error: true });
    });
    return;
  }
  if (key === 'viactt') {
    openOwnCredentialsPortal({
      key,
      label: 'ViaCTT',
      loginUrl: VIACTT_LOGIN_URL,
      credentialLabel: 'VIACTT',
      resolveAccess: resolveViaCttAccess,
    }).catch((error) => {
      showStatus(String(error?.message || error), { error: true });
    });
    return;
  }
  if (key === 'relatorio-unico') {
    openOwnCredentialsPortal({
      key,
      label: 'Relatório Único',
      loginUrl: RELATORIO_UNICO_LOGIN_URL,
      credentialLabel: 'RELATORIO_UNICO',
      resolveAccess: resolveRelatorioUnicoAccess,
    }).catch((error) => {
      showStatus(String(error?.message || error), { error: true });
    });
    return;
  }
  const item = directAccessItems(selected || {}).find((entry) => entry.key === key);
  if (!item?.url) return;
  chrome.tabs.create({ url: item.url, active: true });
  showStatus(`Abri ${item.label}.`);
}

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(response || {})));
}

async function callWaProDesktopBridge(payload) {
  // fetch throws immediately if port is closed (no AbortController needed for that case).
  // AbortController only guards against a hung connection — use a generous timeout
  // so the bridge has time to open the browser, fill the form and respond.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch('http://127.0.0.1:30777/financas-autologin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.success) {
      throw new Error(String(body?.error || `Bridge local respondeu ${response.status}.`));
    }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('failed to fetch');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildAutologinPayload(label, access, options = {}) {
  const isSegSocial = label === 'SS';
  const isAt = label === 'AT';
  return {
    username: access.username,
    password: access.password,
    loginUrl: options.loginUrl || (isSegSocial ? SEG_SOCIAL_LOGIN_URL : AT_LOGIN_URL),
    closeAfterSubmit: false,
    returnAfterSubmit: options.returnAfterSubmit ?? isAt,
    keepPendingAfterSubmit: options.keepPendingAfterSubmit ?? isSegSocial,
    forceFreshSession: options.forceFreshSession === true,
    browserChannel: 'chrome',
    credentialLabel: label,
    apiBaseUrl: 'https://wa.mpr.pt',
    usernameSelectors: isSegSocial ? SEG_SOCIAL_USERNAME_SELECTORS : undefined,
    passwordSelectors: isSegSocial ? SEG_SOCIAL_PASSWORD_SELECTORS : undefined,
    submitSelectors: isSegSocial ? SEG_SOCIAL_SUBMIT_SELECTORS : undefined,
    activateFinancasNifTab: isAt,
    timeoutMs: isSegSocial ? 180000 : 90000,
    emailChallengeWaitMs: isSegSocial ? 2500 : undefined,
    emailPollMs: isSegSocial ? 120000 : undefined,
    emailPollIntervalMs: isSegSocial ? 2500 : undefined,
    emailRequestTimeoutMs: isSegSocial ? 6000 : undefined,
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
  showStatus(forceRefresh ? 'A atualizar acessos a partir da WA PRO...' : 'A ler acessos guardados...', { autoHide: false });
  let response = await sendMessage({ type: 'WA_PRO_POPUP_GET_CUSTOMERS', forceRefresh });
  let list = response.success && Array.isArray(response.customers) ? response.customers : [];

  if (list.length === 0) {
    list = await fetchCustomersFromWaApi();
    if (Array.isArray(list) && list.length > 0 && !response?.updatedAt) {
      response = { ...response, updatedAt: new Date().toISOString() };
    }
  }

  customers = Array.isArray(list) ? list.filter((customer) => customer?.id) : [];
  lastCustomersUpdatedAt = response?.updatedAt || (customers.length ? new Date().toISOString() : '');
  customers.sort((a, b) => customerLabel(a).localeCompare(customerLabel(b), 'pt'));
  el.status.hidden = customers.length > 0;
  el.status.textContent = customers.length
    ? ''
    : 'Sem acessos carregados. Abre/recarrega a WA PRO uma vez e clica em Atualizar acessos.';
  if (response?.cached && customers.length > 0) {
    el.status.hidden = true;
    el.status.textContent = '';
  }
  renderResults();
}

function renderResults() {
  const q = normalize(el.search.value);
  const parts = q.split(/\s+/).filter(Boolean);
  const shouldHideResults = Boolean(selected) && parts.length === 0;
  visibleResults = customers
    .filter((customer) => !parts.length || parts.every((part) => searchableText(customer).includes(part)))
    .slice(0, 4);
  if (visibleResults.length === 0) {
    focusedResultIndex = -1;
  } else if (focusedResultIndex < 0 || focusedResultIndex >= visibleResults.length) {
    focusedResultIndex = 0;
  }
  el.results.innerHTML = '';
  el.results.hidden = shouldHideResults || visibleResults.length === 0;
  if (el.results.hidden) return;
  visibleResults.forEach((customer, index) => {
    const btn = document.createElement('button');
    btn.className = `result${focusedResultIndex === index ? ' active' : ''}`;
    btn.type = 'button';
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', focusedResultIndex === index ? 'true' : 'false');
    btn.innerHTML = `<strong>${escapeHtml(customerLabel(customer))}</strong><span>${escapeHtml(customer.nif || 'sem NIF')} · ${escapeHtml(customer.name || '')}</span>`;
    btn.addEventListener('click', () => {
      selectCustomer(customer, index);
    });
    el.results.appendChild(btn);
  });
  scrollFocusedResultIntoView();
}

function selectCustomer(customer, index = visibleResults.findIndex((entry) => entry.id === customer?.id)) {
  if (!customer) return;
  selected = customer;
  focusedResultIndex = index >= 0 ? index : focusedResultIndex;
  el.search.value = '';
  renderResults();
  renderSelected();
}

function moveResultFocus(direction) {
  if (!visibleResults.length) return;
  focusedResultIndex = (focusedResultIndex + direction + visibleResults.length) % visibleResults.length;
  renderResults();
}

function scrollFocusedResultIntoView() {
  if (el.results.hidden) return;
  if (focusedResultIndex < 0) return;
  const button = el.results.querySelectorAll('.result')[focusedResultIndex];
  button?.scrollIntoView({ block: 'nearest' });
}

function clearSearchOrFocus() {
  if (el.search.value) {
    el.search.value = '';
    focusedResultIndex = 0;
    renderResults();
    return;
  }
  focusedResultIndex = selected
    ? visibleResults.findIndex((customer) => customer.id === selected.id)
    : 0;
  renderResults();
}

function renderSelected() {
  if (!selected) {
    el.selected.hidden = true;
    return;
  }
  const at = resolveAtAccess(selected);
  const ss = resolveSsPrincipal(selected);
  const sub = resolveSsSub(selected);
  const updatedText = formatRelativeTime(lastCustomersUpdatedAt);
  el.selected.hidden = false;
  el.selected.innerHTML = `
    <div class="entity">${escapeHtml(customerLabel(selected))}</div>
    <div class="meta-line">
      <span>NIF: ${escapeHtml(selected.nif || '—')} · NISS: ${escapeHtml(selected.niss || '—')}${updatedText ? ` · Atualizado ${escapeHtml(updatedText)}` : ''}</span>
      <span class="copy-actions">
        <button class="mini-action" data-copy-value="${escapeHtml(selected.nif || '')}" ${selected.nif ? '' : 'disabled'}>NIF</button>
        <button class="mini-action" data-copy-value="${escapeHtml(selected.niss || '')}" ${selected.niss ? '' : 'disabled'}>NISS</button>
      </span>
    </div>
    <div class="quick-links">
      ${renderAccessButtons(selected, at, ss, sub)}
    </div>
  `;
  document.querySelectorAll('[data-copy-value]').forEach((button) => {
    button.addEventListener('click', async () => {
      const value = button.getAttribute('data-copy-value') || '';
      if (!value) return;
      await navigator.clipboard.writeText(value);
      showStatus(`${button.textContent} copiado.`);
    });
  });
  document.querySelectorAll('[data-access-key]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.getAttribute('data-access-key');
      if (key === 'at') return void openAccess('AT', at);
      if (key === 'ss') return void openAccess('SS', ss, false);
      if (key === 'sub') return void openAccess('SS', sub, true);
      return openDirectAccess(key);
    });
  });
}

async function openAccess(label, access, isSub = false) {
  if (!access?.username || !access?.password) return;
  el.status.hidden = false;
  const accessLabel = `${label}${isSub ? ' subutilizador' : ''}`;
  const payload = buildAutologinPayload(label, access);

  if (label === 'SS' || label === 'AT') {
    showStatus(`A abrir ${accessLabel} numa aba normal do Chrome...`, { autoHide: false });
    const initiatedAt = Date.now();
    const response = await sendMessage({
      type: 'WA_PRO_AUTLOGIN_REQUEST',
      payload: {
        ...payload,
        clickSubmit: true,
        forceFreshSession: payload.forceFreshSession,
      },
    });
    if (!response.success) throw new Error(response.error || 'Falha ao abrir autologin.');
    const portalName = label === 'SS' ? 'Segurança Social' : 'Portal das Finanças';
    showStatus(`${portalName} a abrir. A aguardar preenchimento...`, { autoHide: false });
    const deadline = initiatedAt + 30_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const statusResp = await sendMessage({ type: 'WA_PRO_GET_STATUS' }).catch(() => ({}));
      const s = statusResp?.status;
      if (!s || Date.parse(s.at || '') < initiatedAt - 500) continue;
      if (s.ok === false && s.stage === 'error') {
        showStatus(s.error || 'Erro no preenchimento automático.', { error: true });
        return;
      }
      if (s.ok === true && s.stage === 'filled') {
        showStatus(`${portalName} preenchido com sucesso.`);
        return;
      }
    }
    showStatus(`${portalName} aberto. A extensão vai preencher quando encontrar o formulário.`);
    return;
  }

  try {
    showStatus(`A usar automação WA PRO Desktop para ${accessLabel}...`, { autoHide: false });
    const result = await callWaProDesktopBridge({ ...payload, returnAfterSubmit: true });
    showStatus(String(result.message || `Autologin ${accessLabel} iniciado pela WA PRO Desktop.`));
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
      showStatus(String(bridgeError?.message || bridgeError), { error: true });
      return;
    }
  }

  showStatus(`WA PRO Desktop ocupado/indisponível; a tentar preenchimento simples no Chrome para ${accessLabel}...`, { autoHide: false });
  const response = await sendMessage({
    type: 'WA_PRO_AUTLOGIN_REQUEST',
    payload: {
      ...payload,
      clickSubmit: true,
    },
  });
  if (!response.success) throw new Error(response.error || 'Falha ao abrir autologin.');
  showStatus('Portal aberto. A extensão vai preencher quando encontrar o formulário.');
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

el.search.addEventListener('input', () => {
  focusedResultIndex = 0;
  renderResults();
});
el.search.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveResultFocus(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveResultFocus(-1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    selectCustomer(visibleResults[focusedResultIndex]);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    clearSearchOrFocus();
  }
});
el.refresh.textContent = 'Atualizar acessos';
el.refresh.addEventListener('click', () => loadCustomers(true).catch((error) => { showStatus(error.message, { error: true }); }));
el.openWa.addEventListener('click', () => chrome.tabs.create({ url: 'https://wa.mpr.pt/#/customers' }));

document.addEventListener('DOMContentLoaded', () => {
  loadCustomers().catch((error) => {
    showStatus(error.message, { error: true });
  }).finally(() => refreshLastStatus().catch(() => {}));
  el.search.focus();
});
