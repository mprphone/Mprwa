import { Customer, CustomerAccessCredential } from '../../types';

export type SegSocialSubUserState = 'COM_SUBUTILIZADOR' | 'INCOMPLETO' | 'SEM_SUBUTILIZADOR';

export function normalizeNifDigits(rawValue: string): string {
  return String(rawValue || '').replace(/\D/g, '').slice(-9);
}

export function normalizeNissDigits(rawValue: string): string {
  return String(rawValue || '').replace(/\D/g, '');
}

export function normalizeAccessService(value: string): string {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function normalizeAccessIdentity(value: string): string {
  return normalizeAccessService(value).replace(/_/g, '-');
}

export function isSegSocialCredential(credential?: CustomerAccessCredential | null): boolean {
  const normalizedService = normalizeAccessService(String(credential?.service || ''));
  return (
    normalizedService === 'ss' ||
    normalizedService.includes('seguranca social') ||
    normalizedService.includes('seg_social')
  );
}

export function normalizeStoredSegSocialUsername(username: string, fallbackNissRaw = ''): string {
  const raw = String(username || '').trim();
  const fallbackNiss = normalizeNissDigits(fallbackNissRaw);
  if (!raw) return raw;
  if (fallbackNiss && raw === `${fallbackNiss}_1`) return `${fallbackNiss}-1`;
  return raw.replace(/^(\d{11})_1$/, '$1-1');
}

export function applyAtUsernameFallback(
  credentials: CustomerAccessCredential[],
  fallbackNifRaw: string
): CustomerAccessCredential[] {
  const fallbackNif = normalizeNifDigits(fallbackNifRaw);
  return (Array.isArray(credentials) ? credentials : []).map((credential) => {
    const service = String(credential?.service || '').trim();
    const username = String(credential?.username || '').trim();
    if (service.toUpperCase() !== 'AT' || username || !fallbackNif) {
      return { ...credential };
    }
    return {
      ...credential,
      username: fallbackNif,
    };
  });
}

export function accessTypeMatchesPreset(rawCredentialType: string, rawPresetType: string): boolean {
  const credentialType = normalizeAccessIdentity(rawCredentialType);
  const presetType = normalizeAccessIdentity(rawPresetType);
  if (credentialType === presetType) return true;
  return presetType === 'principal' && !credentialType;
}

export function credentialsLookLikeSameSecret(
  a?: CustomerAccessCredential | null,
  b?: CustomerAccessCredential | null
): boolean {
  if (!a || !b) return false;
  const aService = normalizeAccessIdentity(String(a.service || ''));
  const bService = normalizeAccessIdentity(String(b.service || ''));
  if (aService !== bService) return false;

  const aType = normalizeAccessIdentity(String(a.credentialType || ''));
  const bType = normalizeAccessIdentity(String(b.credentialType || ''));
  if (aType !== bType) return false;

  const aUsername = normalizeAccessIdentity(String(a.username || ''));
  const bUsername = normalizeAccessIdentity(String(b.username || ''));
  if (aUsername && bUsername && aUsername === bUsername) return true;

  const aEmail = normalizeAccessIdentity(String(a.emailAssociado || ''));
  const bEmail = normalizeAccessIdentity(String(b.emailAssociado || ''));
  return Boolean(aEmail && bEmail && aEmail === bEmail);
}

export function preserveExistingCredentialSecrets(
  nextCredentials: CustomerAccessCredential[],
  previousCredentials: CustomerAccessCredential[],
  fallbackNissRaw = ''
): CustomerAccessCredential[] {
  return (Array.isArray(nextCredentials) ? nextCredentials : []).map((credential) => {
    const normalizedCredential: CustomerAccessCredential = {
      ...credential,
      username: isSegSocialCredential(credential)
        ? normalizeStoredSegSocialUsername(String(credential.username || ''), fallbackNissRaw)
        : String(credential.username || ''),
    };
    if (String(normalizedCredential.password || '').trim()) {
      return normalizedCredential;
    }
    const previous = (Array.isArray(previousCredentials) ? previousCredentials : []).find((candidate) =>
      credentialsLookLikeSameSecret(normalizedCredential, candidate)
    );
    const previousPassword = String(previous?.password || '').trim();
    return previousPassword ? { ...normalizedCredential, password: previousPassword } : normalizedCredential;
  });
}

export function isSegSocialLoginCredential(credential?: CustomerAccessCredential | null): boolean {
  const credentialType = normalizeAccessService(String(credential?.credentialType || ''));
  return isSegSocialCredential(credential) && !credentialType.includes('token') && !credentialType.includes('chave') && !credentialType.includes('2fa');
}

export function addMonthsIsoDate(months: number, baseDate = new Date()): string {
  const next = new Date(baseDate);
  next.setMonth(next.getMonth() + months);
  return next.toISOString().slice(0, 10);
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isCredentialUsable(credential?: CustomerAccessCredential | null): boolean {
  const status = normalizeAccessService(String(credential?.status || 'active'));
  const validUntil = String(credential?.validUntil || '').trim();
  return status !== 'expired' && status !== 'inactive' && status !== 'error' && (!validUntil || validUntil >= todayIsoDate());
}

export function resolveAtAccessFromCustomer(customer: Customer): { username: string; password: string } {
  const credentials = Array.isArray(customer.accessCredentials) ? customer.accessCredentials : [];
  const atCredential =
    credentials.find((credential) => {
      const normalizedService = normalizeAccessService(String(credential?.service || ''));
      return (
        normalizedService === 'at' ||
        normalizedService.includes('autoridade') ||
        normalizedService.includes('financ')
      );
    }) || null;

  const fallbackUsername = normalizeNifDigits(String(customer.nif || ''));
  const username = String(atCredential?.username || fallbackUsername || '').trim();
  const password = String(atCredential?.password || customer.senhaFinancas || '').trim();

  return { username, password };
}

export function resolveSsAccessFromCustomer(customer: Customer): { username: string; password: string } {
  const credentials = Array.isArray(customer.accessCredentials) ? customer.accessCredentials : [];
  const ssCredentials = credentials.filter(isSegSocialLoginCredential);
  const ssCredential =
    ssCredentials.find((credential) => normalizeAccessService(String(credential?.credentialType || '')).includes('sub') && isCredentialUsable(credential)) ||
    ssCredentials.find((credential) => isCredentialUsable(credential)) ||
    ssCredentials[0] ||
    null;

  const fallbackUsername = normalizeNissDigits(String(customer.niss || ''));
  const username = String(ssCredential?.username || ssCredential?.emailAssociado || fallbackUsername || '').trim();
  const password = String(ssCredential?.password || customer.senhaSegurancaSocial || '').trim();

  return { username, password };
}

export function resolveSsSubUserAccessFromCustomer(customer: Customer): {
  credential: CustomerAccessCredential | null;
  username: string;
  password: string;
  email: string;
} {
  const credentials = Array.isArray(customer.accessCredentials) ? customer.accessCredentials : [];
  const subCredentials = credentials.filter((credential) => (
    isSegSocialCredential(credential) &&
    normalizeAccessService(String(credential?.credentialType || '')).includes('sub')
  ));
  const subCredential =
    subCredentials.find((credential) => String(credential?.username || '').trim() && String(credential?.password || '').trim() && isCredentialUsable(credential)) ||
    subCredentials.find((credential) => String(credential?.username || '').trim() && String(credential?.password || '').trim()) ||
    subCredentials.find((credential) => String(credential?.username || '').trim()) ||
    subCredentials[0] ||
    null;
  const username = normalizeStoredSegSocialUsername(
    String(subCredential?.username || '').trim(),
    String(customer.niss || '')
  );
  const password = String(subCredential?.password || '').trim();
  const email = String(subCredential?.emailAssociado || 'geral@mpr.pt').trim() || 'geral@mpr.pt';

  return { credential: subCredential, username, password, email };
}

export function resolveSsPrincipalAccessFromCustomer(customer: Customer): { username: string; password: string } {
  const credentials = Array.isArray(customer.accessCredentials) ? customer.accessCredentials : [];
  const principalCredential =
    credentials.find((credential) => {
      const credentialType = normalizeAccessService(String(credential?.credentialType || ''));
      return isSegSocialCredential(credential) && (credentialType === 'principal' || (!credentialType && String(credential?.service || '').trim().toUpperCase() === 'SS'));
    }) || null;

  const fallbackUsername = normalizeNissDigits(String(customer.niss || ''));
  const username = String(principalCredential?.username || fallbackUsername || '').trim();
  const password = String(principalCredential?.password || customer.senhaSegurancaSocial || '').trim();

  return { username, password };
}

export function resolveSegSocialInteropAccessFromCustomer(
  customer: Customer,
  preferredType: 'chave_aplicacional' | 'token'
): { username: string; token: string; validUntil: string; label: string } {
  const credentials = Array.isArray(customer.accessCredentials) ? customer.accessCredentials : [];
  const preferredIdentity = normalizeAccessIdentity(preferredType);
  const candidates = credentials.filter((credential) => {
    if (!isSegSocialCredential(credential)) return false;
    const type = normalizeAccessIdentity(String(credential.credentialType || ''));
    if (preferredIdentity === 'token') return type.includes('token') || type.includes('interoperabilidade');
    return type.includes('chave-aplicacional');
  });
  const credential =
    candidates.find(isCredentialUsable) ||
    candidates[0] ||
    null;

  return {
    username: String(credential?.username || '').trim(),
    token: String(credential?.password || '').trim(),
    validUntil: String(credential?.validUntil || '').trim(),
    label: String(credential?.credentialType || preferredType).trim(),
  };
}

export function isSafeSegSocialApplicationAuthValue(value: string): boolean {
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

export function getSegSocialSubUserStateFromCredentials(
  credentials: CustomerAccessCredential[]
): SegSocialSubUserState {
  const subCredentials = credentials.filter((credential) => {
    if (!isSegSocialCredential(credential)) return false;
    const type = normalizeAccessIdentity(String(credential.credentialType || ''));
    return type.includes('subutilizador') || type.includes('subconta') || type.includes('sub-user') || type === 'sub';
  });

  if (!subCredentials.length) return 'SEM_SUBUTILIZADOR';

  const hasCompleteSubUser = subCredentials.some((credential) =>
    Boolean(
      String(credential.username || '').trim() &&
      String(credential.password || '').trim() &&
      isCredentialUsable(credential)
    )
  );
  if (hasCompleteSubUser) return 'COM_SUBUTILIZADOR';

  return 'INCOMPLETO';
}

export function getSegSocialSubUserState(customer: Customer): SegSocialSubUserState {
  return getSegSocialSubUserStateFromCredentials(
    Array.isArray(customer.accessCredentials) ? customer.accessCredentials : []
  );
}
