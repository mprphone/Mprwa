// Ponte de automação local/extensão para autologin (Finanças/AT) e recolha de
// perfil AT. Extraído de pages/Customers.tsx — funções module-level sem estado
// de React (falam com a extensão Chrome via postMessage e com o helper desktop
// via HTTP).
import type { CustomerFormState } from './customerFormState';

export const LOCAL_FINANCAS_AUTOMATION_BRIDGE_URL = String(
  import.meta.env?.VITE_LOCAL_AUTOMATION_BRIDGE_URL || 'http://127.0.0.1:30777/financas-autologin'
).trim();
export const LOCAL_FINANCAS_AT_PROFILE_BRIDGE_URL = String(
  import.meta.env?.VITE_LOCAL_AT_PROFILE_BRIDGE_URL || LOCAL_FINANCAS_AUTOMATION_BRIDGE_URL.replace(/\/financas-autologin\/?$/, '/financas-at-profile')
).trim();
export const LOCAL_CARTAO_ELETRONICO_BRIDGE_URL = String(
  import.meta.env?.VITE_LOCAL_CARTAO_ELETRONICO_BRIDGE_URL || LOCAL_FINANCAS_AUTOMATION_BRIDGE_URL.replace(/\/financas-autologin\/?$/, '/cartao-eletronico')
).trim();

export type LocalFinancasAutologinResponse = {
  success?: boolean;
  message?: unknown;
  error?: unknown;
  loginState?: unknown;
};

export type FinancasAtProfileFields = Partial<Pick<CustomerFormState,
  'morada' | 'codigoPostal' | 'dataNascimento' | 'dataConstituicao' | 'inicioAtividade' | 'tipoIva' | 'caePrincipal' | 'codigoReparticaoFinancas' | 'tipoContabilidade' | 'managers'
>>;

export type LocalFinancasAtProfileResponse = {
  success?: boolean;
  message?: unknown;
  error?: unknown;
  sourceUrl?: unknown;
  fields?: FinancasAtProfileFields;
};

export async function triggerChromeExtensionAutologin(params: {
  username: string;
  password: string;
  loginUrl?: string;
  credentialLabel?: string;
  usernameSelectors?: string[];
  passwordSelectors?: string[];
  submitSelectors?: string[];
  successSelectors?: string[];
  clickSubmit?: boolean;
  keepPendingAfterSubmit?: boolean;
  emailPollMs?: number;
}): Promise<boolean> {
  if (typeof window === 'undefined' || typeof window.postMessage !== 'function') return false;

  const requestId = `wa-pro-autologin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload = {
    username: String(params.username || '').trim(),
    password: String(params.password || '').trim(),
    loginUrl: String(params.loginUrl || '').trim() || undefined,
    credentialLabel: String(params.credentialLabel || '').trim() || undefined,
    usernameSelectors: Array.isArray(params.usernameSelectors) ? params.usernameSelectors : undefined,
    passwordSelectors: Array.isArray(params.passwordSelectors) ? params.passwordSelectors : undefined,
    submitSelectors: Array.isArray(params.submitSelectors) ? params.submitSelectors : undefined,
    successSelectors: Array.isArray(params.successSelectors) ? params.successSelectors : undefined,
    clickSubmit: params.clickSubmit !== false,
    keepPendingAfterSubmit: params.keepPendingAfterSubmit === true,
    emailPollMs: params.emailPollMs,
    createdAt: Date.now(),
    // apiBaseUrl não incluído — o background.js usa o default 'https://wa.mpr.pt'
    // (se incluirmos window.location.origin do Electron seria localhost e falharia a validação)
  };

  if (!payload.username || !payload.password || !payload.loginUrl) return false;

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timeoutId);
    };
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data || {};
      if (data.source !== 'WA_PRO_CHROME_EXTENSION' || data.type !== 'AUTLOGIN_RESPONSE') return;
      if (data.requestId !== requestId) return;
      const response = data.response || {};
      if (response.success) finish(true);
      else fail(new Error(String(response.error || 'A extensão Chrome recusou o pedido de autologin.')));
    };

    const timeoutId = window.setTimeout(() => finish(false), 700);
    window.addEventListener('message', onMessage);
    window.postMessage({
      source: 'WA_PRO',
      type: 'AUTLOGIN_REQUEST',
      requestId,
      payload,
    }, window.location.origin);
  });
}

export async function triggerLocalFinancasAutologinBridge(params: {
  username: string;
  password: string;
  loginUrl?: string;
  targetUrl?: string;
  timeoutMs?: number;
  closeAfterSubmit?: boolean;
  returnAfterSubmit?: boolean;
  credentialLabel?: string;
  usernameSelectors?: string[];
  passwordSelectors?: string[];
  submitSelectors?: string[];
  successSelectors?: string[];
  activateFinancasNifTab?: boolean;
  browserExecutablePath?: string;
}): Promise<{ success: boolean; message: string; loginState?: string }> {
  const response = await fetch(LOCAL_FINANCAS_AUTOMATION_BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: String(params.username || '').trim(),
      password: String(params.password || '').trim(),
      loginUrl: String(params.loginUrl || '').trim() || undefined,
      targetUrl: String(params.targetUrl || '').trim() || undefined,
      timeoutMs:
        typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
          ? Math.max(20000, Math.min(180000, Math.trunc(params.timeoutMs)))
          : undefined,
      closeAfterSubmit: params.closeAfterSubmit === true,
      returnAfterSubmit: params.returnAfterSubmit === true,
      credentialLabel: String(params.credentialLabel || '').trim() || undefined,
      usernameSelectors: Array.isArray(params.usernameSelectors) ? params.usernameSelectors : undefined,
      passwordSelectors: Array.isArray(params.passwordSelectors) ? params.passwordSelectors : undefined,
      submitSelectors: Array.isArray(params.submitSelectors) ? params.submitSelectors : undefined,
      successSelectors: Array.isArray(params.successSelectors) ? params.successSelectors : undefined,
      activateFinancasNifTab:
        typeof params.activateFinancasNifTab === 'boolean' ? params.activateFinancasNifTab : undefined,
      browserExecutablePath: String(params.browserExecutablePath || '').trim() || undefined,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as LocalFinancasAutologinResponse;
  if (!response.ok || !payload.success) {
    const errorText =
      typeof payload.error === 'string'
        ? payload.error
        : payload.error
          ? JSON.stringify(payload.error)
          : `Falha no autologin local (${response.status}).`;
    throw new Error(errorText);
  }

  return {
    success: true,
    message: String(payload.message || 'Autologin local iniciado no desktop.'),
    loginState: payload.loginState ? String(payload.loginState) : undefined,
  };
}

export async function triggerLocalFinancasAtProfileBridge(params: {
  username: string;
  password: string;
  loginUrl?: string;
  targetUrl?: string;
  timeoutMs?: number;
  closeAfterCollect?: boolean;
  activateFinancasNifTab?: boolean;
  browserExecutablePath?: string;
}): Promise<{ success: boolean; message: string; sourceUrl?: string; fields: FinancasAtProfileFields }> {
  const response = await fetch(LOCAL_FINANCAS_AT_PROFILE_BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: String(params.username || '').trim(),
      password: String(params.password || '').trim(),
      loginUrl: String(params.loginUrl || '').trim() || undefined,
      targetUrl: String(params.targetUrl || '').trim() || undefined,
      timeoutMs:
        typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
          ? Math.max(20000, Math.min(180000, Math.trunc(params.timeoutMs)))
          : undefined,
      closeAfterCollect: params.closeAfterCollect !== false,
      credentialLabel: 'AT',
      activateFinancasNifTab:
        typeof params.activateFinancasNifTab === 'boolean' ? params.activateFinancasNifTab : undefined,
      browserExecutablePath: String(params.browserExecutablePath || '').trim() || undefined,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as LocalFinancasAtProfileResponse;
  if (!response.ok || !payload.success) {
    const rawError =
      typeof payload.error === 'string'
        ? payload.error
        : payload.error
          ? JSON.stringify(payload.error)
          : `Falha ao recolher dados da AT (${response.status}).`;
    const errorText =
      response.status === 404 || rawError.toLowerCase().includes('endpoint local não encontrado')
        ? 'A app desktop ainda não tem a recolha AT instalada. Cria/publica uma nova versão desktop e atualiza este PC.'
        : rawError;
    throw new Error(errorText);
  }

  return {
    success: true,
    message: String(payload.message || 'Dados da AT recolhidos.'),
    sourceUrl: payload.sourceUrl ? String(payload.sourceUrl) : undefined,
    fields: payload.fields && typeof payload.fields === 'object' ? payload.fields : {},
  };
}
