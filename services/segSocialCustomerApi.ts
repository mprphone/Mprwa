import { Customer } from '../types';

export type SaftSegSocialPasswordSyncSummary = {
  requested: number;
  eligible: number;
  skippedWithSubuser: number;
  skippedNonEnterprise: number;
  skippedNoNif: number;
  skippedNoSaftMatch: number;
  skippedNoSegSocialPassword: number;
  unchanged: number;
  updated: number;
  errors: string[];
  warnings: string[];
  updatedCustomers: Array<{ id: string; name: string; nif: string; niss: string; validUntil: string }>;
  rawPath?: string;
};

export type SaftSegSocialPasswordSyncResult = {
  success: boolean;
  message: string;
  summary: SaftSegSocialPasswordSyncSummary;
  customers?: Customer[];
};

export type CustomerAutologinResult = {
  success: boolean;
  message: string;
  loginState?: string;
  headless?: boolean;
};

export type SegSocialSubUserSetupResult = {
  success: boolean;
  message: string;
  stage?: string;
  headless?: boolean;
};

export type SegSocialSubUserPasswordLookupResult = {
  found: boolean;
  password: string;
  uid?: string;
  from?: string;
  subject?: string;
  date?: string;
};

function assertBrowser(message: string): void {
  if (typeof window === 'undefined') {
    throw new Error(message);
  }
}

function parseErrorPayload(payload: { error?: unknown }, fallback: string): string {
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error) return JSON.stringify(payload.error);
  return fallback;
}

function buildQuery(params?: Record<string, unknown>): string {
  const search = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || String(value).trim() === '') return;
    search.set(key, String(value));
  });
  return search.toString() ? `?${search.toString()}` : '';
}

function normalizeSaftSummary(summary: Partial<SaftSegSocialPasswordSyncSummary> = {}): SaftSegSocialPasswordSyncSummary {
  return {
    requested: Number(summary.requested || 0),
    eligible: Number(summary.eligible || 0),
    skippedWithSubuser: Number(summary.skippedWithSubuser || 0),
    skippedNonEnterprise: Number(summary.skippedNonEnterprise || 0),
    skippedNoNif: Number(summary.skippedNoNif || 0),
    skippedNoSaftMatch: Number(summary.skippedNoSaftMatch || 0),
    skippedNoSegSocialPassword: Number(summary.skippedNoSegSocialPassword || 0),
    unchanged: Number(summary.unchanged || 0),
    updated: Number(summary.updated || 0),
    errors: Array.isArray(summary.errors) ? summary.errors.map(String) : [],
    warnings: Array.isArray(summary.warnings) ? summary.warnings.map(String) : [],
    updatedCustomers: Array.isArray(summary.updatedCustomers)
      ? summary.updatedCustomers.map((item) => ({
          id: String(item?.id || ''),
          name: String(item?.name || ''),
          nif: String(item?.nif || ''),
          niss: String(item?.niss || ''),
          validUntil: String(item?.validUntil || ''),
        }))
      : [],
    rawPath: String(summary.rawPath || ''),
  };
}

async function postAutologin(
  url: string,
  payload: Record<string, unknown>,
  fallbackError: string
): Promise<CustomerAutologinResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({})) as {
    success?: boolean;
    message?: unknown;
    error?: unknown;
    code?: unknown;
    loginState?: unknown;
    headless?: unknown;
  };

  if (!response.ok || !body.success) {
    const enrichedError = new Error(parseErrorPayload(body, fallbackError)) as Error & { code?: string };
    if (body.code !== undefined && body.code !== null && String(body.code).trim()) {
      enrichedError.code = String(body.code).trim();
    }
    throw enrichedError;
  }

  return {
    success: true,
    message: String(body.message || 'Autologin iniciado.'),
    loginState: body.loginState ? String(body.loginState) : undefined,
    headless: typeof body.headless === 'boolean' ? body.headless : undefined,
  };
}

export async function triggerFinancasAutologinApi(
  customerId: string,
  options?: { actorUserId?: string | null; headless?: boolean; closeAfterSubmit?: boolean }
): Promise<CustomerAutologinResult> {
  assertBrowser('Autologin disponível apenas no browser.');
  const targetId = String(customerId || '').trim();
  if (!targetId) throw new Error('Cliente inválido para autologin.');

  return postAutologin(
    `/api/customers/${encodeURIComponent(targetId)}/autologin/financas`,
    {
      actorUserId: String(options?.actorUserId || '').trim() || null,
      headless: options?.headless ?? false,
      closeAfterSubmit: options?.closeAfterSubmit ?? false,
    },
    'Falha no autologin Portal das Finanças.'
  );
}

export async function triggerSegSocialAutologinApi(
  customerId: string,
  options?: { actorUserId?: string | null; headless?: boolean; closeAfterSubmit?: boolean }
): Promise<CustomerAutologinResult> {
  assertBrowser('Autologin disponível apenas no browser.');
  const targetId = String(customerId || '').trim();
  if (!targetId) throw new Error('Cliente inválido para autologin.');

  return postAutologin(
    `/api/customers/${encodeURIComponent(targetId)}/autologin/seg-social`,
    {
      actorUserId: String(options?.actorUserId || '').trim() || null,
      headless: options?.headless ?? false,
      closeAfterSubmit: options?.closeAfterSubmit ?? false,
    },
    'Falha no autologin Segurança Social Direta.'
  );
}

export async function triggerSegSocialSubUserSetupApi(
  customerId: string,
  options?: { actorUserId?: string | null; headless?: boolean; closeAfterSubmit?: boolean; subEmail?: string }
): Promise<SegSocialSubUserSetupResult> {
  assertBrowser('Automação disponível apenas no browser.');
  const targetId = String(customerId || '').trim();
  if (!targetId) throw new Error('Cliente inválido para criação de subutilizador.');

  const response = await fetch(`/api/customers/${encodeURIComponent(targetId)}/seg-social/subuser/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actorUserId: String(options?.actorUserId || '').trim() || null,
      headless: options?.headless ?? false,
      closeAfterSubmit: options?.closeAfterSubmit ?? false,
      subEmail: String(options?.subEmail || 'geral@mpr.pt').trim(),
    }),
  });

  const body = await response.json().catch(() => ({})) as {
    success?: boolean;
    message?: unknown;
    error?: unknown;
    code?: unknown;
    stage?: unknown;
    headless?: unknown;
  };

  if (!response.ok || !body.success) {
    const enrichedError = new Error(
      parseErrorPayload(body, `Falha ao iniciar criação de subutilizador SS (${response.status}).`)
    ) as Error & { code?: string };
    if (body.code !== undefined && body.code !== null && String(body.code).trim()) {
      enrichedError.code = String(body.code).trim();
    }
    throw enrichedError;
  }

  return {
    success: true,
    message: String(body.message || 'Assistente de subutilizador iniciado.'),
    stage: body.stage ? String(body.stage) : undefined,
    headless: typeof body.headless === 'boolean' ? body.headless : undefined,
  };
}

export async function syncSegSocialPasswordsFromSaftApi(options?: {
  customerId?: string;
  actorUserId?: string | null;
  headless?: boolean;
  syncToSupabase?: boolean;
}): Promise<SaftSegSocialPasswordSyncResult> {
  assertBrowser('Sincronização SAFT disponível apenas no browser.');

  const response = await fetch('/api/customers/sync/saft-ss-passwords', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerId: String(options?.customerId || '').trim() || undefined,
      actorUserId: String(options?.actorUserId || '').trim() || null,
      headless: options?.headless ?? true,
      syncToSupabase: options?.syncToSupabase ?? true,
    }),
  });

  const body = await response.json().catch(() => ({})) as {
    success?: boolean;
    message?: unknown;
    summary?: Partial<SaftSegSocialPasswordSyncSummary>;
    customers?: Customer[];
    error?: unknown;
  };

  if (!response.ok || !body.success) {
    throw new Error(
      parseErrorPayload(body, `Falha ao sincronizar senhas SS a partir do SAFTonline (${response.status}).`)
    );
  }

  return {
    success: true,
    message: String(body.message || 'Sincronização SAFT concluída.'),
    summary: normalizeSaftSummary(body.summary || {}),
    customers: Array.isArray(body.customers) ? body.customers : [],
  };
}

export async function findLatestSegSocialSubUserPasswordApi(params?: {
  username?: string;
  email?: string;
  sinceDays?: number;
  maxMessages?: number;
  sinceIso?: string;
}): Promise<SegSocialSubUserPasswordLookupResult> {
  assertBrowser('Leitura de email disponível apenas no browser.');

  const search = new URLSearchParams();
  if (params?.username) search.set('username', String(params.username).trim());
  if (params?.email) search.set('email', String(params.email).trim());
  if (params?.sinceIso) search.set('sinceIso', String(params.sinceIso).trim());
  search.set('sinceDays', String(Math.max(1, Number(params?.sinceDays || 14) || 14)));
  search.set('maxMessages', String(Math.max(1, Number(params?.maxMessages || 50) || 50)));

  const response = await fetch(`/api/email/seg-social/latest-subuser-password?${search.toString()}`);
  const body = await response.json().catch(() => ({})) as {
    success?: boolean;
    found?: boolean;
    error?: unknown;
    result?: {
      password?: unknown;
      uid?: unknown;
      from?: unknown;
      subject?: unknown;
      date?: unknown;
    } | null;
  };

  if (!response.ok || !body.success) {
    throw new Error(parseErrorPayload(body, `Falha ao consultar email da Segurança Social (${response.status}).`));
  }

  const result = body.result || null;
  return {
    found: Boolean(body.found && result?.password),
    password: String(result?.password || '').trim(),
    uid: result?.uid !== undefined ? String(result.uid || '') : undefined,
    from: result?.from !== undefined ? String(result.from || '') : undefined,
    subject: result?.subject !== undefined ? String(result.subject || '') : undefined,
    date: result?.date !== undefined ? String(result.date || '') : undefined,
  };
}

export async function enviarSegSocialValoresRemuneracaoApi(
  customerId: string,
  payload: Record<string, unknown>,
  params?: Record<string, unknown>
): Promise<unknown> {
  assertBrowser('Interoperabilidade disponível apenas no browser.');
  const targetId = String(customerId || '').trim();
  if (!targetId) throw new Error('Cliente inválido para interoperabilidade da Segurança Social.');

  const response = await fetch(
    `/api/customers/${encodeURIComponent(targetId)}/seg-social/interoperabilidade/valores-remuneracao${buildQuery(params)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }
  );
  return parseSegSocialInteroperabilityResponse(response);
}

export async function consultarSegSocialValoresComunicadosApi(
  customerId: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  assertBrowser('Interoperabilidade disponível apenas no browser.');
  const targetId = String(customerId || '').trim();
  if (!targetId) throw new Error('Cliente inválido para interoperabilidade da Segurança Social.');

  const response = await fetch(
    `/api/customers/${encodeURIComponent(targetId)}/seg-social/interoperabilidade/valores-comunicados${buildQuery(params)}`
  );
  return parseSegSocialInteroperabilityResponse(response);
}

export async function consultarSegSocialValoresApuradosMensalmenteApi(
  customerId: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  assertBrowser('Interoperabilidade disponível apenas no browser.');
  const targetId = String(customerId || '').trim();
  if (!targetId) throw new Error('Cliente inválido para interoperabilidade da Segurança Social.');

  const response = await fetch(
    `/api/customers/${encodeURIComponent(targetId)}/seg-social/interoperabilidade/valores-apurados-mensalmente${buildQuery(params)}`
  );
  return parseSegSocialInteroperabilityResponse(response);
}

export async function parseSegSocialInteroperabilityResponse(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => ({})) as {
    success?: boolean;
    error?: unknown;
    code?: unknown;
    data?: unknown;
  };
  if (!response.ok || !body.success) {
    const enrichedError = new Error(
      parseErrorPayload(body, `Falha na interoperabilidade da Segurança Social (${response.status}).`)
    ) as Error & { code?: string };
    if (body.code !== undefined && body.code !== null && String(body.code).trim()) {
      enrichedError.code = String(body.code).trim();
    }
    throw enrichedError;
  }
  return body;
}
