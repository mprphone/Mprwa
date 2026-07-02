// Helpers puros, constantes e tipos extraídos de pages/Customers.tsx.
// Nada aqui depende do estado do componente React — são funções e dados
// autocontidos, o que os torna testáveis isoladamente e mantém o Customers.tsx
// focado na UI.
import {
  Customer,
  CustomerType,
  CustomerHouseholdRelation,
  CustomerRelatedRecord,
} from '../../types';
import { normalizeNifDigits } from './customerAccessUtils';

// ── Automação Segurança Social (seletores usados pela extensão/bridge) ──────────
export const SEG_SOCIAL_LOGIN_URL = 'https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin';
export const SEG_SOCIAL_ACTIVATE_URL = 'https://www.seg-social.pt/ptss/gus/atribuir-palavra-chave/codigo-verificacao';
export const SEG_SOCIAL_USERNAME_SELECTORS = [
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
export const SEG_SOCIAL_PASSWORD_SELECTORS = [
  'input[name="password"]',
  'input[id*="password" i]',
  'input[placeholder*="senha" i]',
  'input[type="password"]',
];
export const SEG_SOCIAL_SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Entrar")',
  'button:has-text("Iniciar sessão")',
  'button:has-text("Autenticar")',
  'button:has-text("Continuar")',
];
export const SEG_SOCIAL_SUCCESS_SELECTORS = [
  'a[href*="logout"]',
  'a[href*="sair"]',
  'button:has-text("Terminar sessão")',
  'button:has-text("Sair")',
  '[data-testid*="logout"]',
];

// ── Pastas de documentos (Windows/NAS) ─────────────────────────────────────────
export const SOCIEDADE_BASE_PATH = 'Documentos Oficiais';
export const DEFAULT_CUSTOMER_FOLDER_ROOT = '\\\\10.0.0.6\\OneDrive - MPR\\Documentos\\Contabilidades\\Empresas';
export const SOCIEDADE_DOCUMENT_CATEGORIES: Array<{ key: string; label: string }> = [
  { key: 'certidao_permanente', label: 'Certidão Permanente' },
  { key: 'pacto_social', label: 'Pacto Social' },
  { key: 'inicio_atividade', label: 'Início da Atividade' },
  { key: 'cartao_cidadao', label: 'Cartão do Cidadão' },
  { key: 'licencas', label: 'Licenças' },
];

// ── Tipos ───────────────────────────────────────────────────────────────────
export type AutologinFallbackReason = 'automation_unavailable' | 'fields_not_found' | null;

export type CustomerIngestDocumentType =
  | 'cartao_eletronico'
  | 'certidao_permanente'
  | 'pacto_social'
  | 'inicio_atividade'
  | 'rcbe'
  | 'cartao_cidadao'
  | 'outros';

export const CUSTOMER_INGEST_TYPES: Array<{ value: CustomerIngestDocumentType; label: string }> = [
  { value: 'cartao_eletronico', label: 'Cartão Eletrónico da Empresa' },
  { value: 'certidao_permanente', label: 'Certidão Permanente' },
  { value: 'pacto_social', label: 'Pacto Social' },
  { value: 'inicio_atividade', label: 'Início de Atividade' },
  { value: 'rcbe', label: 'RCBE' },
  { value: 'cartao_cidadao', label: 'Cartão de Cidadão' },
  { value: 'outros', label: 'Outros' },
];

export type CustomerModalTab = 'dados' | 'acessos' | 'contactos' | 'relacoes' | 'atividade' | 'sociedade' | 'documentos' | 'fiscal';

export type CustomerTaskSummary = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string;
  assignedUserName: string;
};

export type CustomerOccurrenceSummary = {
  id: string;
  title: string;
  state: string;
  typeName: string;
  date: string;
  dueDate: string;
  responsibleNames: string;
};

export const HOUSEHOLD_RELATION_OPTIONS: Array<{ value: CustomerHouseholdRelation['relationType']; label: string }> = [
  { value: 'conjuge', label: 'Cônjuge' },
  { value: 'filho', label: 'Filho' },
  { value: 'pai', label: 'Pai' },
  { value: 'outro', label: 'Outro' },
];

export const RELATED_RECORD_OPTIONS: Array<{ value: CustomerRelatedRecord['relationType']; label: string }> = [
  { value: 'funcionario', label: 'Funcionário' },
  { value: 'amigo', label: 'Amigo' },
  { value: 'familiar', label: 'Familiar' },
  { value: 'gerente', label: 'Gerente' },
  { value: 'socio', label: 'Sócio' },
  { value: 'outro', label: 'Outro' },
];

// ── Deteção de falhas do bridge de automação local ─────────────────────────────
export function isLocalAutomationBridgeUnavailable(rawMessage: string): boolean {
  const message = String(rawMessage || '').trim().toLowerCase();
  if (!message) return true;
  return (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('err_connection_refused') ||
    message.includes('err_failed') ||
    message.includes('mixed content') ||
    message.includes('cors') ||
    message.includes('load failed')
  );
}

export function classifyAutologinFallbackReason(rawMessage: string): AutologinFallbackReason {
  const compact = String(rawMessage || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, "'");

  if (!compact) return null;

  if (
    compact.includes('browsertype.launch') ||
    compact.includes('executable does') ||
    compact.includes('does not exist') ||
    compact.includes('playwright install') ||
    compact.includes('ms-playwright') ||
    compact.includes('chrome-win64') ||
    compact.includes('browser de automacao') ||
    compact.includes('playwright nao instalado') ||
    compact.includes('nao instalado') ||
    compact.includes('not installed') ||
    compact.includes('helper local') ||
    compact.includes('automacao local') ||
    compact.includes('nao encontrei o helper')
  ) {
    return 'automation_unavailable';
  }

  if (
    compact.includes('nao foi possivel localizar os campos de login') ||
    compact.includes('campos de login')
  ) {
    return 'fields_not_found';
  }

  return null;
}

// ── Normalização de dados importados ───────────────────────────────────────────
export function normalizeImportedKey(value: string): string {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

export function buildImportedLookup(payload?: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!payload || typeof payload !== 'object') return map;
  Object.entries(payload).forEach(([key, value]) => {
    map.set(normalizeImportedKey(key), value);
  });
  return map;
}

export function formatImportedValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        try {
          return JSON.stringify(item);
        } catch {
          return String(item ?? '');
        }
      })
      .filter(Boolean)
      .join(' | ');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function pickImportedValue(lookup: Map<string, unknown>, candidates: string[]): string {
  for (const candidate of candidates) {
    const raw = lookup.get(normalizeImportedKey(candidate));
    const formatted = formatImportedValue(raw);
    if (formatted) return formatted;
  }
  return '';
}

export function normalizeStatus(raw: string): string {
  const value = String(raw || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!value) return 'ATIVA';
  if (value.includes('INAT')) return 'INATIVA';
  if (value.includes('SUSP')) return 'SUSPENSA';
  if (value.includes('ENCERR')) return 'ENCERRADA';
  return 'ATIVA';
}

export function previousMonthAnoMes(baseDate = new Date()): string {
  const date = new Date(baseDate);
  date.setMonth(date.getMonth() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function generateSegSocialPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(8);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    bytes.forEach((_, index) => {
      bytes[index] = Math.floor(Math.random() * 255);
    });
  }
  const suffix = Array.from(bytes).map((byte) => alphabet[byte % alphabet.length]).join('');
  return `Mpr${new Date().getFullYear()}!${suffix}`;
}

export function isValidPortugueseNif(rawValue: string): boolean {
  const nif = normalizeNifDigits(rawValue);
  if (!/^\d{9}$/.test(nif)) return false;
  if (!/^[1235689]/.test(nif)) return false;

  let total = 0;
  for (let i = 0; i < 8; i += 1) {
    total += Number(nif[i]) * (9 - i);
  }
  const modulo = total % 11;
  const checkDigit = modulo < 2 ? 0 : 11 - modulo;
  return checkDigit === Number(nif[8]);
}

// Normaliza o tipo de cliente para o fluxo de sub-utilizador da Seg. Social.
// Importante: não adivinhar só pela label mostrada. O valor real vem de
// CustomerType, mas registos antigos/importados podem ter EMPRESA,
// INDEPENDENTE ou Trabalhador Independente.
export function normalizeCustomerTypeForSubUserFlow(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const SEG_SOCIAL_SUBUSER_ALLOWED_CUSTOMER_TYPES = new Set(
  [CustomerType.ENTERPRISE, CustomerType.INDEPENDENT, 'empresa', 'empresas', 'enterprise', 'independente', 'independent', 'trabalhador_independente']
    .map(normalizeCustomerTypeForSubUserFlow)
);

export function canUseSegSocialSubUserFlow(customer: Customer): boolean {
  const customerType = normalizeCustomerTypeForSubUserFlow(customer.type);
  if (!customerType) return false;
  if (SEG_SOCIAL_SUBUSER_ALLOWED_CUSTOMER_TYPES.has(customerType)) return true;
  return customerType.includes('empresa') || customerType.includes('enterprise') || customerType.includes('independent') || customerType.includes('independente');
}

export function dedupeCustomersForListing(items: Customer[]): Customer[] {
  const list = Array.isArray(items) ? [...items] : [];
  const byNif = new Map<string, number>();
  const deduped: Customer[] = [];

  const sourceIdFor = (customer: Customer): string => {
    const explicit = String((customer as Customer & { sourceId?: string }).sourceId || '').trim();
    if (explicit) return explicit;
    const id = String(customer.id || '').trim();
    if (id.startsWith('ext_c_')) return id.slice(6);
    return '';
  };

  const score = (customer: Customer): number => {
    let total = 0;
    if (String(customer.id || '').startsWith('local_')) total += 10;
    if (sourceIdFor(customer)) total += 6;
    if (String(customer.id || '').startsWith('ext_c_')) total += 2;
    if (String(customer.phone || '').trim()) total += 1;
    if (String(customer.email || '').trim()) total += 1;
    if (String(customer.documentsFolder || '').trim()) total += 1;
    return total;
  };

  const fillMissing = (primary: Customer, secondary: Customer): Customer => {
    const merged = { ...primary } as Customer;
    (Object.keys(secondary) as Array<keyof Customer>).forEach((key) => {
      const currentValue = merged[key];
      const incomingValue = secondary[key];
      const currentEmpty =
        currentValue === undefined ||
        currentValue === null ||
        (typeof currentValue === 'string' && currentValue.trim() === '') ||
        (Array.isArray(currentValue) && currentValue.length === 0);
      const incomingFilled =
        incomingValue !== undefined &&
        incomingValue !== null &&
        (!(typeof incomingValue === 'string') || incomingValue.trim() !== '') &&
        (!Array.isArray(incomingValue) || incomingValue.length > 0);
      if (currentEmpty && incomingFilled) {
        merged[key] = incomingValue as never;
      }
    });
    return merged;
  };

  list.forEach((customer) => {
    const nif = normalizeNifDigits(String(customer.nif || ''));
    if (!nif) {
      deduped.push(customer);
      return;
    }

    const existingIndex = byNif.get(nif);
    if (existingIndex === undefined) {
      byNif.set(nif, deduped.length);
      deduped.push(customer);
      return;
    }

    const current = deduped[existingIndex];
    const keepCurrent = score(current) >= score(customer);
    const preferred = keepCurrent ? current : customer;
    const fallback = keepCurrent ? customer : current;
    deduped[existingIndex] = fillMissing(preferred, fallback);
  });

  return deduped;
}

export function sanitizeWindowsFolderSegment(rawValue: string): string {
  return String(rawValue || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
}

export function buildSuggestedCustomerFolderPath(customerName: string): string {
  const leaf = sanitizeWindowsFolderSegment(customerName) || `Cliente_${Date.now()}`;
  return `${DEFAULT_CUSTOMER_FOLDER_ROOT}\\${leaf}`;
}

export function normalizeHouseholdRelationTypeValue(rawValue: string): CustomerHouseholdRelation['relationType'] {
  const folded = String(rawValue || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!folded) return 'outro';
  if (folded === 'conjuge') return 'conjuge';
  if (folded === 'esposa' || folded === 'marido') return 'conjuge';
  if (folded.startsWith('espos') || folded.startsWith('marid')) return 'conjuge';
  if (folded.startsWith('filh')) return 'filho';
  if (folded === 'pai' || folded === 'mae' || folded.startsWith('progenitor')) return 'pai';
  if (folded === 'outro') return 'outro';
  return 'outro';
}

// ── Formatação de datas/estados (usado no separador de atividade) ───────────────
export function formatDateOnly(value?: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '-';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString('pt-PT');
}

export function formatTaskStatus(status: string): string {
  const normalized = String(status || '').trim().toUpperCase();
  if (normalized === 'DONE') return 'Fechada';
  if (normalized === 'IN_PROGRESS') return 'Em progresso';
  if (normalized === 'WAITING') return 'Aguardando';
  return 'Aberta';
}

export function formatOccurrenceStatus(status: string): string {
  const normalized = String(status || '').trim().toUpperCase();
  if (normalized === 'RESOLVIDA') return 'Fechada';
  if (normalized === 'ATRASADA') return 'Atrasada';
  return 'Aberta';
}

export function getTaskStatusBadgeClass(status: string): string {
  const normalized = String(status || '').trim().toUpperCase();
  if (normalized === 'DONE') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (normalized === 'IN_PROGRESS') return 'border-blue-200 bg-blue-50 text-blue-700';
  if (normalized === 'WAITING') return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-slate-200 bg-slate-50 text-slate-700';
}

export function getOccurrenceStatusBadgeClass(status: string): string {
  const normalized = String(status || '').trim().toUpperCase();
  if (normalized === 'RESOLVIDA') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (normalized === 'ATRASADA') return 'border-rose-200 bg-rose-50 text-rose-700';
  return 'border-blue-200 bg-blue-50 text-blue-700';
}
