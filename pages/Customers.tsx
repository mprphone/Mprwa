import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { mockService } from '../services/mockData';
import { fetchOccurrences, OccurrenceRow } from '../services/occurrencesApi';
import {
  Customer,
  CustomerType,
  SubContact,
  CustomerManager,
  CustomerAccessCredential,
  CustomerHouseholdRelation,
  CustomerRelatedRecord,
} from '../types';
import { Plus, Search, Edit2, Trash2, FolderOpen, Eye, RefreshCw, Upload, FileText, Folder } from 'lucide-react';

const OPEN_CUSTOMER_PROFILE_STORAGE_KEY = 'wa_pro_open_customer_id';
const LOCAL_FINANCAS_AUTOMATION_BRIDGE_URL = String(
  import.meta.env?.VITE_LOCAL_AUTOMATION_BRIDGE_URL || 'http://127.0.0.1:30777/financas-autologin'
).trim();
const SEG_SOCIAL_LOGIN_URL = 'https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin';
const SEG_SOCIAL_USERNAME_SELECTORS = [
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
const SEG_SOCIAL_PASSWORD_SELECTORS = [
  'input[name="password"]',
  'input[id*="password" i]',
  'input[placeholder*="senha" i]',
  'input[type="password"]',
];
const SEG_SOCIAL_SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Entrar")',
  'button:has-text("Iniciar sessão")',
  'button:has-text("Autenticar")',
  'button:has-text("Continuar")',
];
const SEG_SOCIAL_SUCCESS_SELECTORS = [
  'a[href*="logout"]',
  'a[href*="sair"]',
  'button:has-text("Terminar sessão")',
  'button:has-text("Sair")',
  '[data-testid*="logout"]',
];

type LocalFinancasAutologinResponse = {
  success?: boolean;
  message?: unknown;
  error?: unknown;
  loginState?: unknown;
};

function isLocalAutomationBridgeUnavailable(rawMessage: string): boolean {
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

type AutologinFallbackReason = 'automation_unavailable' | 'fields_not_found' | null;

function classifyAutologinFallbackReason(rawMessage: string): AutologinFallbackReason {
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

async function triggerLocalFinancasAutologinBridge(params: {
  username: string;
  password: string;
  loginUrl?: string;
  targetUrl?: string;
  timeoutMs?: number;
  closeAfterSubmit?: boolean;
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

function normalizeImportedKey(value: string): string {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function buildImportedLookup(payload?: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!payload || typeof payload !== 'object') return map;
  Object.entries(payload).forEach(([key, value]) => {
    map.set(normalizeImportedKey(key), value);
  });
  return map;
}

function formatImportedValue(value: unknown): string {
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

function pickImportedValue(lookup: Map<string, unknown>, candidates: string[]): string {
  for (const candidate of candidates) {
    const raw = lookup.get(normalizeImportedKey(candidate));
    const formatted = formatImportedValue(raw);
    if (formatted) return formatted;
  }
  return '';
}

function normalizeStatus(raw: string): string {
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

function normalizeNifDigits(rawValue: string): string {
  return String(rawValue || '').replace(/\D/g, '').slice(-9);
}

function applyAtUsernameFallback(
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

function normalizeAccessService(value: string): string {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function resolveAtAccessFromCustomer(customer: Customer): { username: string; password: string } {
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

function normalizeNissDigits(rawValue: string): string {
  return String(rawValue || '').replace(/\D/g, '');
}

function resolveSsAccessFromCustomer(customer: Customer): { username: string; password: string } {
  const credentials = Array.isArray(customer.accessCredentials) ? customer.accessCredentials : [];
  const ssCredential =
    credentials.find((credential) => {
      const normalizedService = normalizeAccessService(String(credential?.service || ''));
      return (
        normalizedService === 'ss' ||
        normalizedService.includes('seguranca social') ||
        normalizedService.includes('seg_social')
      );
    }) || null;

  const fallbackUsername = normalizeNissDigits(String(customer.niss || ''));
  const username = String(ssCredential?.username || fallbackUsername || '').trim();
  const password = String(ssCredential?.password || customer.senhaSegurancaSocial || '').trim();

  return { username, password };
}

function isValidPortugueseNif(rawValue: string): boolean {
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

function dedupeCustomersForListing(items: Customer[]): Customer[] {
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

type CustomerDocumentEntry = {
  type: 'file' | 'directory';
  name: string;
  relativePath: string;
  size?: number;
  updatedAt: string;
};

type CustomerIngestDocumentType =
  | 'certidao_permanente'
  | 'pacto_social'
  | 'inicio_atividade'
  | 'rcbe'
  | 'cartao_cidadao'
  | 'outros';

const CUSTOMER_INGEST_TYPES: Array<{ value: CustomerIngestDocumentType; label: string }> = [
  { value: 'certidao_permanente', label: 'Certidão Permanente' },
  { value: 'pacto_social', label: 'Pacto Social' },
  { value: 'inicio_atividade', label: 'Início de Atividade' },
  { value: 'rcbe', label: 'RCBE' },
  { value: 'cartao_cidadao', label: 'Cartão de Cidadão' },
  { value: 'outros', label: 'Outros' },
];

type CustomerModalTab = 'dados' | 'acessos' | 'contactos' | 'relacoes' | 'atividade' | 'sociedade' | 'documentos';

type CustomerTaskSummary = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string;
  assignedUserName: string;
};

type CustomerOccurrenceSummary = {
  id: string;
  title: string;
  state: string;
  typeName: string;
  date: string;
  dueDate: string;
  responsibleNames: string;
};

const SOCIEDADE_BASE_PATH = 'Documentos Oficiais';
const DEFAULT_CUSTOMER_FOLDER_ROOT = '\\\\10.0.0.6\\OneDrive - MPR\\Documentos\\Contabilidades\\Empresas';
const SOCIEDADE_DOCUMENT_CATEGORIES: Array<{ key: string; label: string }> = [
  { key: 'certidao_permanente', label: 'Certidão Permanente' },
  { key: 'pacto_social', label: 'Pacto Social' },
  { key: 'inicio_atividade', label: 'Início da Atividade' },
  { key: 'cartao_cidadao', label: 'Cartão do Cidadão' },
  { key: 'licencas', label: 'Licenças' },
];

function sanitizeWindowsFolderSegment(rawValue: string): string {
  return String(rawValue || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 120);
}

function buildSuggestedCustomerFolderPath(customerName: string): string {
  const leaf = sanitizeWindowsFolderSegment(customerName) || `Cliente_${Date.now()}`;
  return `${DEFAULT_CUSTOMER_FOLDER_ROOT}\\${leaf}`;
}

function normalizeHouseholdRelationTypeValue(rawValue: string): CustomerHouseholdRelation['relationType'] {
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

const HOUSEHOLD_RELATION_OPTIONS: Array<{ value: CustomerHouseholdRelation['relationType']; label: string }> = [
  { value: 'conjuge', label: 'Cônjuge' },
  { value: 'filho', label: 'Filho' },
  { value: 'pai', label: 'Pai' },
  { value: 'outro', label: 'Outro' },
];

const RELATED_RECORD_OPTIONS: Array<{ value: CustomerRelatedRecord['relationType']; label: string }> = [
  { value: 'funcionario', label: 'Funcionário' },
  { value: 'amigo', label: 'Amigo' },
  { value: 'familiar', label: 'Familiar' },
  { value: 'gerente', label: 'Gerente' },
  { value: 'socio', label: 'Sócio' },
  { value: 'outro', label: 'Outro' },
];

type CustomerFormState = {
  name: string;
  contactName: string;
  company: string;
  phone: string;
  email: string;
  documentsFolder: string;
  nif: string;
  niss: string;
  senhaFinancas: string;
  senhaSegurancaSocial: string;
  tipoIva: string;
  morada: string;
  notes: string;
  certidaoPermanenteNumero: string;
  certidaoPermanenteValidade: string;
  rcbeNumero: string;
  rcbeData: string;
  dataConstituicao: string;
  inicioAtividade: string;
  caePrincipal: string;
  codigoReparticaoFinancas: string;
  tipoContabilidade: string;
  estadoCliente: string;
  contabilistaCertificado: string;
  managers: CustomerManager[];
  accessCredentials: CustomerAccessCredential[];
  agregadoFamiliar: CustomerHouseholdRelation[];
  fichasRelacionadas: CustomerRelatedRecord[];
  type: CustomerType;
  ownerId: string;
  contacts: SubContact[];
  allowAutoResponses: boolean;
};

type CustomerSortKey = 'nif' | 'name' | 'type' | 'email' | 'phone' | 'owner' | 'status';
type SortDirection = 'asc' | 'desc';

const emptyFormState = (): CustomerFormState => ({
  name: '',
  contactName: '',
  company: '',
  phone: '',
  email: '',
  documentsFolder: '',
  nif: '',
  niss: '',
  senhaFinancas: '',
  senhaSegurancaSocial: '',
  tipoIva: '',
  morada: '',
  notes: '',
  certidaoPermanenteNumero: '',
  certidaoPermanenteValidade: '',
  rcbeNumero: '',
  rcbeData: '',
  dataConstituicao: '',
  inicioAtividade: '',
  caePrincipal: '',
  codigoReparticaoFinancas: '',
  tipoContabilidade: '',
  estadoCliente: '',
  contabilistaCertificado: '',
  managers: [],
  accessCredentials: [],
  agregadoFamiliar: [],
  fichasRelacionadas: [],
  type: CustomerType.ENTERPRISE,
  ownerId: '',
  contacts: [],
  allowAutoResponses: true,
});

const Customers: React.FC = () => {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [stateFilter, setStateFilter] = useState('TODOS');
  const [typeFilter, setTypeFilter] = useState('TODOS');
  const [ownerFilter, setOwnerFilter] = useState('TODOS');
  const [sortKey, setSortKey] = useState<CustomerSortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [showModal, setShowModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [activeTab, setActiveTab] = useState<CustomerModalTab>('dados');

  const [formData, setFormData] = useState<CustomerFormState>(emptyFormState());

  const modalFileInputRef = useRef<HTMLInputElement | null>(null);
  const sociedadeFileInputRef = useRef<HTMLInputElement | null>(null);
  const ingestFileInputRef = useRef<HTMLInputElement | null>(null);
  const headerIngestFileInputRef = useRef<HTMLInputElement | null>(null);
  const [modalDocs, setModalDocs] = useState<CustomerDocumentEntry[]>([]);
  const [modalDocsPath, setModalDocsPath] = useState('');
  const [modalDocsCurrentPath, setModalDocsCurrentPath] = useState('');
  const [modalCanGoUp, setModalCanGoUp] = useState(false);
  const [modalDocsConfigured, setModalDocsConfigured] = useState(false);
  const [modalDocsLoading, setModalDocsLoading] = useState(false);
  const [modalDocsError, setModalDocsError] = useState<string | null>(null);
  const [modalUploadingDoc, setModalUploadingDoc] = useState(false);
  const [sociedadeDocs, setSociedadeDocs] = useState<CustomerDocumentEntry[]>([]);
  const [sociedadeDocsPath, setSociedadeDocsPath] = useState('');
  const [sociedadeCurrentPath, setSociedadeCurrentPath] = useState(SOCIEDADE_BASE_PATH);
  const [sociedadeCanGoUp, setSociedadeCanGoUp] = useState(false);
  const [sociedadeDocsConfigured, setSociedadeDocsConfigured] = useState(false);
  const [sociedadeDocsLoading, setSociedadeDocsLoading] = useState(false);
  const [sociedadeDocsError, setSociedadeDocsError] = useState<string | null>(null);
  const [sociedadeUploadingDoc, setSociedadeUploadingDoc] = useState(false);
  const [sociedadeCategoryKey, setSociedadeCategoryKey] = useState(SOCIEDADE_DOCUMENT_CATEGORIES[0].key);
  const [ingestDocumentType, setIngestDocumentType] = useState<CustomerIngestDocumentType>('certidao_permanente');
  const [ingestSelectedFile, setIngestSelectedFile] = useState<File | null>(null);
  const [ingestLoading, setIngestLoading] = useState(false);
  const [ingestStatus, setIngestStatus] = useState<string>('');
  const [ingestWarnings, setIngestWarnings] = useState<string[]>([]);
  const [showHeaderIngestModal, setShowHeaderIngestModal] = useState(false);
  const [headerIngestCustomerId, setHeaderIngestCustomerId] = useState('');
  const [headerIngestDocumentType, setHeaderIngestDocumentType] = useState<CustomerIngestDocumentType>('certidao_permanente');
  const [headerIngestSelectedFile, setHeaderIngestSelectedFile] = useState<File | null>(null);
  const [headerIngestPhoneInput, setHeaderIngestPhoneInput] = useState('');
  const [headerIngestLoading, setHeaderIngestLoading] = useState(false);
  const [headerIngestStatus, setHeaderIngestStatus] = useState('');
  const [headerIngestWarnings, setHeaderIngestWarnings] = useState<string[]>([]);
  const [agregadoSearchTerms, setAgregadoSearchTerms] = useState<Record<number, string>>({});
  const [fichasSearchTerms, setFichasSearchTerms] = useState<Record<number, string>>({});
  const [customerTasksSummary, setCustomerTasksSummary] = useState<CustomerTaskSummary[]>([]);
  const [customerOccurrencesSummary, setCustomerOccurrencesSummary] = useState<CustomerOccurrenceSummary[]>([]);
  const [customerActivityLoading, setCustomerActivityLoading] = useState(false);
  const [customerActivityError, setCustomerActivityError] = useState('');
  const [autologinBusyCustomerId, setAutologinBusyCustomerId] = useState<string | null>(null);
  const [segSocialAutologinBusyCustomerId, setSegSocialAutologinBusyCustomerId] = useState<string | null>(null);

  useEffect(() => {
    void loadCustomers();
    void loadUsers();
  }, []);

  useEffect(() => {
    if (!showModal || activeTab !== 'documentos' || !editingCustomer?.id) return;
    void loadModalDocuments(editingCustomer.id, '');
  }, [showModal, activeTab, editingCustomer?.id]);

  useEffect(() => {
    if (!showModal || activeTab !== 'sociedade' || !editingCustomer?.id) return;
    const basePath = String(sociedadeCurrentPath || SOCIEDADE_BASE_PATH).trim();
    void loadSociedadeDocuments(editingCustomer.id, basePath);
  }, [showModal, activeTab, editingCustomer?.id]);

  useEffect(() => {
    if (!showModal || activeTab !== 'atividade' || !editingCustomer?.id) return;
    void loadCustomerActivity(editingCustomer.id);
  }, [showModal, activeTab, editingCustomer?.id]);

  const loadCustomers = async () => {
    const data = await mockService.getCustomers();
    setCustomers(dedupeCustomersForListing(data));
  };

  const loadUsers = async () => {
    const data = await mockService.getUsers();
    setUsers(data);
  };

  const loadCustomerActivity = async (customerId: string) => {
    const normalizedCustomerId = String(customerId || '').trim();
    if (!normalizedCustomerId) return;

    setCustomerActivityLoading(true);
    setCustomerActivityError('');
    try {
      const [conversations, tasks, occurrences, usersForMap] = await Promise.all([
        mockService.getConversations(),
        mockService.getTasks(),
        fetchOccurrences({ limit: 5000 }),
        mockService.getUsers(),
      ]);

      const customerConversationIds = new Set(
        (Array.isArray(conversations) ? conversations : [])
          .filter((conversation) => String(conversation.customerId || '').trim() === normalizedCustomerId)
          .map((conversation) => String(conversation.id || '').trim())
          .filter(Boolean)
      );

      const userNameById = new Map(
        (Array.isArray(usersForMap) ? usersForMap : []).map((user) => [String(user.id || '').trim(), String(user.name || '').trim()])
      );

      const nextTasks: CustomerTaskSummary[] = (Array.isArray(tasks) ? tasks : [])
        .filter((task) => customerConversationIds.has(String(task.conversationId || '').trim()))
        .map((task) => ({
          id: String(task.id || '').trim(),
          title: String(task.title || '').trim() || 'Tarefa sem título',
          status: String(task.status || '').trim().toUpperCase(),
          priority: String(task.priority || '').trim().toUpperCase(),
          dueDate: String(task.dueDate || '').trim(),
          assignedUserName: userNameById.get(String(task.assignedUserId || '').trim()) || 'Sem responsável',
        }))
        .sort((a, b) => {
          const aClosed = a.status === 'DONE' ? 1 : 0;
          const bClosed = b.status === 'DONE' ? 1 : 0;
          if (aClosed !== bClosed) return aClosed - bClosed;
          return String(a.dueDate || '').localeCompare(String(b.dueDate || ''));
        });

      const nextOccurrences: CustomerOccurrenceSummary[] = (Array.isArray(occurrences) ? occurrences : [])
        .filter((item: OccurrenceRow) => String(item.customerId || '').trim() === normalizedCustomerId)
        .map((item: OccurrenceRow) => ({
          id: String(item.id || '').trim(),
          title: String(item.title || '').trim() || 'Ocorrência sem título',
          state: String(item.state || '').trim().toUpperCase(),
          typeName: String(item.typeName || '').trim() || '-',
          date: String(item.date || '').trim(),
          dueDate: String(item.dueDate || '').trim(),
          responsibleNames: String(item.responsibleNames || item.responsibleUserName || '').trim() || 'Sem responsável',
        }))
        .sort((a, b) => {
          const aClosed = a.state === 'RESOLVIDA' ? 1 : 0;
          const bClosed = b.state === 'RESOLVIDA' ? 1 : 0;
          if (aClosed !== bClosed) return aClosed - bClosed;
          return String(a.dueDate || a.date || '').localeCompare(String(b.dueDate || b.date || ''));
        });

      setCustomerTasksSummary(nextTasks);
      setCustomerOccurrencesSummary(nextOccurrences);
    } catch (error) {
      setCustomerActivityError(error instanceof Error ? error.message : 'Falha ao carregar tarefas e ocorrências deste cliente.');
      setCustomerTasksSummary([]);
      setCustomerOccurrencesSummary([]);
    } finally {
      setCustomerActivityLoading(false);
    }
  };

  const resetModalDocsState = () => {
    setModalDocs([]);
    setModalDocsPath('');
    setModalDocsCurrentPath('');
    setModalCanGoUp(false);
    setModalDocsConfigured(false);
    setModalDocsError(null);
    setModalUploadingDoc(false);
    setModalDocsLoading(false);
  };

  const resetSociedadeDocsState = () => {
    setSociedadeDocs([]);
    setSociedadeDocsPath('');
    setSociedadeCurrentPath(SOCIEDADE_BASE_PATH);
    setSociedadeCanGoUp(false);
    setSociedadeDocsConfigured(false);
    setSociedadeDocsError(null);
    setSociedadeUploadingDoc(false);
    setSociedadeDocsLoading(false);
    setSociedadeCategoryKey(SOCIEDADE_DOCUMENT_CATEGORIES[0].key);
  };

  const resetIngestState = () => {
    setIngestDocumentType('certidao_permanente');
    setIngestSelectedFile(null);
    setIngestLoading(false);
    setIngestStatus('');
    setIngestWarnings([]);
  };

  const resetHeaderIngestState = () => {
    setHeaderIngestDocumentType('certidao_permanente');
    setHeaderIngestSelectedFile(null);
    setHeaderIngestPhoneInput('');
    setHeaderIngestLoading(false);
    setHeaderIngestStatus('');
    setHeaderIngestWarnings([]);
  };

  const openHeaderIngestModal = () => {
    setHeaderIngestCustomerId('');
    resetHeaderIngestState();
    setShowHeaderIngestModal(true);
  };

const formStateFromCustomer = (customer: Customer): CustomerFormState => ({
  name: customer.name,
  contactName: customer.contactName || '',
  company: customer.company,
    phone: customer.phone,
    email: customer.email || '',
    documentsFolder: customer.documentsFolder || '',
    nif: customer.nif || '',
    niss: customer.niss || '',
    senhaFinancas: customer.senhaFinancas || '',
    senhaSegurancaSocial: customer.senhaSegurancaSocial || '',
    tipoIva: customer.tipoIva || '',
    morada: customer.morada || '',
    notes: customer.notes || '',
    certidaoPermanenteNumero: customer.certidaoPermanenteNumero || '',
    certidaoPermanenteValidade: customer.certidaoPermanenteValidade || '',
    rcbeNumero: customer.rcbeNumero || '',
    rcbeData: customer.rcbeData || '',
    dataConstituicao: customer.dataConstituicao || '',
    inicioAtividade: customer.inicioAtividade || '',
    caePrincipal: customer.caePrincipal || '',
    codigoReparticaoFinancas: customer.codigoReparticaoFinancas || '',
    tipoContabilidade: customer.tipoContabilidade || '',
    estadoCliente: customer.estadoCliente || '',
    contabilistaCertificado: customer.contabilistaCertificado || '',
    managers: Array.isArray(customer.managers) ? customer.managers.map((manager) => ({ ...manager })) : [],
    accessCredentials: applyAtUsernameFallback(
      Array.isArray(customer.accessCredentials)
        ? customer.accessCredentials.map((credential) => ({ ...credential }))
        : [],
      customer.nif || ''
    ),
    agregadoFamiliar: Array.isArray(customer.agregadoFamiliar)
      ? customer.agregadoFamiliar.map((item) => ({
          ...item,
          relationType: normalizeHouseholdRelationTypeValue(String(item?.relationType || '')),
        }))
      : [],
    fichasRelacionadas: Array.isArray(customer.fichasRelacionadas)
      ? customer.fichasRelacionadas.map((item) => ({ ...item }))
      : [],
    type: customer.type,
    ownerId: customer.ownerId || '',
    contacts: customer.contacts ? [...customer.contacts] : [],
    allowAutoResponses: customer.allowAutoResponses !== undefined ? customer.allowAutoResponses : true,
  });

  const formatDateTime = (value?: string): string => {
    const raw = String(value || '').trim();
    if (!raw) return 'Nunca sincronizado';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleString('pt-PT');
  };

  const formatDateOnly = (value?: string): string => {
    const raw = String(value || '').trim();
    if (!raw) return '-';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleDateString('pt-PT');
  };

  const formatTaskStatus = (status: string): string => {
    const normalized = String(status || '').trim().toUpperCase();
    if (normalized === 'DONE') return 'Fechada';
    if (normalized === 'IN_PROGRESS') return 'Em progresso';
    if (normalized === 'WAITING') return 'Aguardando';
    return 'Aberta';
  };

  const formatOccurrenceStatus = (status: string): string => {
    const normalized = String(status || '').trim().toUpperCase();
    if (normalized === 'RESOLVIDA') return 'Fechada';
    if (normalized === 'ATRASADA') return 'Atrasada';
    return 'Aberta';
  };

  const getTaskStatusBadgeClass = (status: string): string => {
    const normalized = String(status || '').trim().toUpperCase();
    if (normalized === 'DONE') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    if (normalized === 'IN_PROGRESS') return 'border-blue-200 bg-blue-50 text-blue-700';
    if (normalized === 'WAITING') return 'border-amber-200 bg-amber-50 text-amber-700';
    return 'border-slate-200 bg-slate-50 text-slate-700';
  };

  const getOccurrenceStatusBadgeClass = (status: string): string => {
    const normalized = String(status || '').trim().toUpperCase();
    if (normalized === 'RESOLVIDA') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    if (normalized === 'ATRASADA') return 'border-rose-200 bg-rose-50 text-rose-700';
    return 'border-blue-200 bg-blue-50 text-blue-700';
  };

  const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / Math.pow(1024, index);
    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  };

  const resolveSuggestedCustomerName = (suggested: Partial<Customer> | undefined, suggestedNif = ''): string => {
    const candidate = String(suggested?.company || suggested?.name || '').trim();
    if (candidate) return candidate;
    return `Cliente ${String(suggestedNif || '').trim() || 'novo'}`;
  };

  const resolveSuggestedCustomerFolder = (suggested: Partial<Customer> | undefined, suggestedName: string): string => {
    const fromSuggestion = String(suggested?.documentsFolder || '').trim();
    if (fromSuggestion) return fromSuggestion;
    return buildSuggestedCustomerFolderPath(suggestedName);
  };

  const buildRelationCustomerLabel = (customer?: Customer | null): string => {
    if (!customer) return '';
    const title = String(customer.company || customer.name || '').trim();
    const nif = String(customer.nif || '').trim();
    if (!title) return '';
    return nif ? `${title} (${nif})` : title;
  };

  const buildEntryRelationLabel = (
    entry: Pick<CustomerHouseholdRelation, 'customerName' | 'customerCompany' | 'customerNif'>,
    resolved?: Customer | null
  ): string => {
    const resolvedLabel = buildRelationCustomerLabel(resolved);
    if (resolvedLabel) return resolvedLabel;
    const title = String(entry.customerCompany || entry.customerName || '').trim();
    const nif = String(entry.customerNif || '').trim();
    if (!title) return '';
    return nif ? `${title} (${nif})` : title;
  };

  const filterRelationCustomers = (searchTermRaw: string): Customer[] => {
    const folded = String(searchTermRaw || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (!folded) return [];
    return selectableRelationCustomers
      .filter((customer) => {
        const haystack = [
          customer.name,
          customer.company,
          customer.nif || '',
          customer.email || '',
          customer.phone || '',
        ]
          .join(' ')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        return haystack.includes(folded);
      })
      .slice(0, 8);
  };

  const removeIndexedSearchTerm = (current: Record<number, string>, removedIndex: number): Record<number, string> => {
    const next: Record<number, string> = {};
    Object.entries(current).forEach(([key, value]) => {
      const index = Number(key);
      if (!Number.isInteger(index)) return;
      if (index < removedIndex) next[index] = value;
      if (index > removedIndex) next[index - 1] = value;
    });
    return next;
  };

  const loadModalDocuments = async (customerId: string, relativePath = '') => {
    setModalDocsLoading(true);
    setModalDocsError(null);
    try {
      const payload = await mockService.getCustomerDocumentsAtPath(customerId, relativePath);
      setModalDocs(payload.entries);
      setModalDocsPath(payload.folderPath || '');
      setModalDocsCurrentPath(payload.currentRelativePath || '');
      setModalCanGoUp(!!payload.canGoUp);
      setModalDocsConfigured(!!payload.configured);
    } catch (error) {
      setModalDocs([]);
      setModalDocsPath('');
      setModalDocsCurrentPath('');
      setModalCanGoUp(false);
      setModalDocsConfigured(false);
      setModalDocsError(error instanceof Error ? error.message : 'Falha ao carregar documentos.');
    } finally {
      setModalDocsLoading(false);
    }
  };

  const openModalDocumentsFolder = async (relativePath: string) => {
    if (!editingCustomer?.id) return;
    await loadModalDocuments(editingCustomer.id, relativePath);
  };

  const goUpModalDocumentsFolder = async () => {
    if (!editingCustomer?.id) return;
    const parts = String(modalDocsCurrentPath || '')
      .split('/')
      .filter(Boolean);
    parts.pop();
    await loadModalDocuments(editingCustomer.id, parts.join('/'));
  };

  const triggerModalDocumentPicker = () => {
    modalFileInputRef.current?.click();
  };

  const handleModalDocumentUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!editingCustomer?.id || !file) return;

    setModalUploadingDoc(true);
    setModalDocsError(null);
    try {
      await mockService.uploadCustomerDocument(editingCustomer.id, file, modalDocsCurrentPath);
      await loadModalDocuments(editingCustomer.id, modalDocsCurrentPath);
    } catch (error) {
      setModalDocsError(error instanceof Error ? error.message : 'Falha ao guardar documento.');
    } finally {
      setModalUploadingDoc(false);
    }
  };

  const loadSociedadeDocuments = async (customerId: string, relativePath = SOCIEDADE_BASE_PATH) => {
    const targetPath = String(relativePath || SOCIEDADE_BASE_PATH).trim();
    setSociedadeDocsLoading(true);
    setSociedadeDocsError(null);
    try {
      const payload = await mockService.getCustomerDocumentsAtPath(customerId, targetPath);
      setSociedadeDocs(payload.entries);
      setSociedadeDocsPath(payload.folderPath || '');
      setSociedadeCurrentPath(payload.currentRelativePath || targetPath);
      setSociedadeCanGoUp(!!payload.canGoUp);
      setSociedadeDocsConfigured(!!payload.configured);
    } catch (error) {
      setSociedadeDocs([]);
      setSociedadeDocsPath('');
      setSociedadeCurrentPath(targetPath);
      setSociedadeCanGoUp(false);
      setSociedadeDocsConfigured(false);
      setSociedadeDocsError(error instanceof Error ? error.message : 'Falha ao carregar documentos da sociedade.');
    } finally {
      setSociedadeDocsLoading(false);
    }
  };

  const openSociedadeFolder = async (relativePath: string) => {
    if (!editingCustomer?.id) return;
    await loadSociedadeDocuments(editingCustomer.id, relativePath);
  };

  const openSociedadeCategory = async (categoryKey: string) => {
    if (!editingCustomer?.id) return;
    setSociedadeCategoryKey(categoryKey);
    await loadSociedadeDocuments(editingCustomer.id, SOCIEDADE_BASE_PATH);
  };

  const goUpSociedadeFolder = async () => {
    if (!editingCustomer?.id) return;
    const base = SOCIEDADE_BASE_PATH;
    const current = String(sociedadeCurrentPath || base).trim();
    if (!current || current === base) {
      await loadSociedadeDocuments(editingCustomer.id, base);
      return;
    }
    const parts = current.split('/').filter(Boolean);
    parts.pop();
    const nextPath = parts.join('/');
    const safeNext = nextPath && (nextPath === base || nextPath.startsWith(`${base}/`)) ? nextPath : base;
    await loadSociedadeDocuments(editingCustomer.id, safeNext);
  };

  const triggerSociedadeDocumentPicker = () => {
    sociedadeFileInputRef.current?.click();
  };

  const handleSociedadeDocumentUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!editingCustomer?.id || !file) return;

    const targetPathRaw = String(sociedadeCurrentPath || SOCIEDADE_BASE_PATH).trim();
    const targetPath =
      targetPathRaw === SOCIEDADE_BASE_PATH || targetPathRaw.startsWith(`${SOCIEDADE_BASE_PATH}/`)
        ? targetPathRaw
        : SOCIEDADE_BASE_PATH;
    setSociedadeUploadingDoc(true);
    setSociedadeDocsError(null);
    try {
      await mockService.uploadCustomerDocument(editingCustomer.id, file, targetPath);
      await loadSociedadeDocuments(editingCustomer.id, targetPath);
    } catch (error) {
      setSociedadeDocsError(error instanceof Error ? error.message : 'Falha ao guardar documento da sociedade.');
    } finally {
      setSociedadeUploadingDoc(false);
    }
  };

  const triggerIngestPicker = () => {
    ingestFileInputRef.current?.click();
  };

  const triggerHeaderIngestPicker = () => {
    headerIngestFileInputRef.current?.click();
  };

  const handleIngestFileSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    setIngestSelectedFile(file);
    setIngestStatus('');
    setIngestWarnings([]);
  };

  const handleHeaderIngestFileSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    setHeaderIngestSelectedFile(file);
    setHeaderIngestStatus('');
    setHeaderIngestWarnings([]);
  };

  const runHeaderDocumentIngest = async () => {
    if (!headerIngestSelectedFile) {
      triggerHeaderIngestPicker();
      return;
    }

    setHeaderIngestLoading(true);
    setHeaderIngestStatus('');
    setHeaderIngestWarnings([]);

    try {
      let targetCustomerId = String(headerIngestCustomerId || '').trim();
      let createdCustomerFromDetection: Customer | null = null;
      if (!targetCustomerId) {
        const detected = await mockService.detectCustomerByDocumentAI(
          headerIngestSelectedFile,
          headerIngestDocumentType
        );
        if (!detected.success || !detected.customer?.id) {
          if (detected.code === 'NIF_NOT_DETECTED') {
            setHeaderIngestStatus('Não foi possível ler o NIF no documento. Selecione o cliente manualmente.');
          } else if (
            detected.code === 'NIF_NOT_FOUND' &&
            (headerIngestDocumentType === 'cartao_cidadao' || headerIngestDocumentType === 'certidao_permanente')
          ) {
            const suggested = detected.suggestedCustomer || {};
            const suggestedNif = String(detected.nif || '').trim();
            const suggestedName = resolveSuggestedCustomerName(suggested, suggestedNif);
            const suggestedFolder = resolveSuggestedCustomerFolder(suggested, suggestedName);
            const documentLabel = headerIngestDocumentType === 'cartao_cidadao' ? 'Cartão de Cidadão' : 'Certidão Permanente';
            const suggestedType =
              headerIngestDocumentType === 'cartao_cidadao'
                ? CustomerType.PRIVATE
                : CustomerType.ENTERPRISE;
            const shouldCreate = window.confirm(
              `NIF ${suggestedNif || '(não identificado)'} não encontrado na base local.\n\n` +
              `Deseja criar novo cliente a partir da ${documentLabel}?\n\n` +
              `Nome sugerido: ${suggestedName}\n` +
              `Pasta sugerida:\n${suggestedFolder}`
            );
            if (!shouldCreate) {
              setHeaderIngestStatus('Criação de novo cliente cancelada.');
              return;
            }

            const syncToSupabase = window.confirm(
              'Também quer criar este novo cliente no MPR Control (Supabase)?\n\nOK = Sim\nCancelar = Só local'
            );
            let phone = String(suggested.phone || '').trim();
            if (!phone) {
              phone = String(headerIngestPhoneInput || '').trim();
            }
            if (!phone) {
              setHeaderIngestStatus(
                'O documento não trouxe telefone. Preencha o campo "Telefone para novo cliente" e clique novamente em "Analisar + Guardar".'
              );
              return;
            }

            const currentUserId = String(mockService.getCurrentUser()?.id || '').trim();
            createdCustomerFromDetection = await mockService.createCustomer(
              {
                name: suggestedName,
                company: String(suggested.company || '').trim() || suggestedName,
                phone,
                email: String(suggested.email || '').trim(),
                ownerId: currentUserId || null,
                type: suggestedType,
                contacts: [],
                allowAutoResponses: true,
                documentsFolder: suggestedFolder,
                nif: suggestedNif || String(suggested.nif || '').trim(),
                niss: String(suggested.niss || '').trim(),
                morada: String(suggested.morada || '').trim(),
                caePrincipal: String(suggested.caePrincipal || '').trim(),
                certidaoPermanenteNumero: String(suggested.certidaoPermanenteNumero || '').trim(),
                certidaoPermanenteValidade: String(suggested.certidaoPermanenteValidade || '').trim(),
                inicioAtividade: String(suggested.inicioAtividade || '').trim(),
                rcbeNumero: String(suggested.rcbeNumero || '').trim(),
                rcbeData: String(suggested.rcbeData || '').trim(),
                managers: Array.isArray(suggested.managers)
                  ? suggested.managers.map((manager) => ({
                      name: String((manager as { name?: string }).name || '').trim(),
                      email: String((manager as { email?: string }).email || '').trim(),
                      phone: String((manager as { phone?: string }).phone || '').trim(),
                    }))
                  : [],
                accessCredentials: [],
                notes: '',
                tipoIva: '',
                senhaFinancas: '',
                senhaSegurancaSocial: '',
                tipoContabilidade: '',
                estadoCliente: '',
                contabilistaCertificado: '',
                codigoReparticaoFinancas: '',
                dataConstituicao: '',
              },
              { syncToSupabase }
            );
            targetCustomerId = createdCustomerFromDetection.id;
            setHeaderIngestCustomerId(targetCustomerId);
            setHeaderIngestStatus(`Novo cliente criado: ${suggestedName}. A processar documento...`);
          } else if (detected.code === 'NIF_NOT_FOUND') {
            setHeaderIngestStatus(
              `NIF ${detected.nif || '(não identificado)'} não encontrado na base local. Crie a ficha e tente de novo.`
            );
          } else {
            setHeaderIngestStatus(detected.error || 'Falha na deteção automática por NIF.');
          }
          if (!targetCustomerId) return;
        } else {
          targetCustomerId = detected.customer.id;
          setHeaderIngestCustomerId(targetCustomerId);
          setHeaderIngestStatus(
            `Cliente detetado automaticamente: ${detected.customer.company || detected.customer.name} (${detected.customer.nif || detected.nif || ''})`
          );
        }
      }

      const result = await mockService.ingestCustomerDocumentWithAI(
        targetCustomerId,
        headerIngestSelectedFile,
        headerIngestDocumentType
      );

      if (!result.success) {
        setHeaderIngestStatus(result.error || 'Falha na análise do documento.');
        return;
      }

      setHeaderIngestWarnings(Array.isArray(result.warnings) ? result.warnings : []);
      const createdPrefix = createdCustomerFromDetection ? 'Novo cliente criado e ' : '';
      setHeaderIngestStatus(
        `${createdPrefix}documento guardado: ${result.savedDocument?.fileName || headerIngestSelectedFile.name}${
          result.updatedFields?.length ? ` | Campos atualizados: ${result.updatedFields.join(', ')}` : ''
        }`
      );
      setHeaderIngestSelectedFile(null);
      await loadCustomers();

      const fallbackCustomer =
        (createdCustomerFromDetection && String(createdCustomerFromDetection.id || '').trim() === targetCustomerId
          ? createdCustomerFromDetection
          : null) || null;
      const customerToOpen = result.customer || fallbackCustomer;
      if (customerToOpen?.id) {
        setShowHeaderIngestModal(false);
        resetHeaderIngestState();
        openModal(customerToOpen);
      }
    } catch (error) {
      setHeaderIngestStatus(error instanceof Error ? error.message : 'Falha ao processar documento.');
    } finally {
      setHeaderIngestLoading(false);
    }
  };

  const runDocumentIngest = async () => {
    if (!editingCustomer?.id) return;
    if (!ingestSelectedFile) {
      triggerIngestPicker();
      return;
    }

    setIngestLoading(true);
    setIngestStatus('');
    setIngestWarnings([]);
    setModalDocsError(null);

    try {
      const result = await mockService.ingestCustomerDocumentWithAI(
        editingCustomer.id,
        ingestSelectedFile,
        ingestDocumentType
      );

      if (!result.success && result.code === 'CERTIDAO_NIF_BELONGS_OTHER_CUSTOMER' && result.existingCustomer?.id) {
        const shouldOpen = window.confirm(
          `Este NIF já existe no cliente "${result.existingCustomer.company || result.existingCustomer.name}".\n\nDeseja abrir essa ficha?`
        );
        if (shouldOpen) {
          const allCustomers = await mockService.getCustomers();
          const existingCustomer = allCustomers.find((item) => item.id === result.existingCustomer?.id);
          if (existingCustomer) {
            setShowModal(false);
            openModal(existingCustomer);
            return;
          }
        }
        setIngestStatus(result.error || 'NIF já associado a outra ficha.');
        return;
      }

      if (!result.success && result.code === 'CERTIDAO_NIF_NOT_FOUND') {
        const suggested = result.suggestedCustomer || {};
        const suggestedNif = String(suggested.nif || '').trim();
        const suggestedName = resolveSuggestedCustomerName(suggested, suggestedNif);
        const suggestedFolder = resolveSuggestedCustomerFolder(suggested, suggestedName);
        const shouldCreate = window.confirm(
          `A certidão indica NIF ${suggestedNif || '(não lido)'} que não coincide com esta ficha.\n\n` +
          `Deseja criar novo cliente com estes dados?\n\n` +
          `Pasta sugerida:\n${suggestedFolder}`
        );
        if (!shouldCreate) {
          setIngestStatus(result.error || 'Criação de novo cliente cancelada.');
          return;
        }

        const syncToSupabase = window.confirm(
          'Também quer criar este novo cliente no MPR Control (Supabase)?\n\nOK = Sim\nCancelar = Só local'
        );
        let phone = String(suggested.phone || '').trim();
        if (!phone) {
          setIngestStatus(
            'Não foi possível criar automaticamente: o documento não trouxe telefone. Crie/preencha a ficha com telefone e volte a analisar.'
          );
          return;
        }

        const createdCustomer = await mockService.createCustomer(
          {
            name: suggestedName,
            company: suggestedName,
            phone,
            email: String(suggested.email || '').trim(),
            ownerId: formData.ownerId || null,
            type: CustomerType.ENTERPRISE,
            contacts: [],
            allowAutoResponses: true,
            documentsFolder: suggestedFolder,
            nif: suggestedNif,
            niss: String(suggested.niss || '').trim(),
            morada: String(suggested.morada || '').trim(),
            caePrincipal: String(suggested.caePrincipal || '').trim(),
            certidaoPermanenteNumero: String(suggested.certidaoPermanenteNumero || '').trim(),
            certidaoPermanenteValidade: String(suggested.certidaoPermanenteValidade || '').trim(),
            inicioAtividade: String(suggested.inicioAtividade || '').trim(),
            rcbeNumero: String(suggested.rcbeNumero || '').trim(),
            rcbeData: String(suggested.rcbeData || '').trim(),
            managers: Array.isArray(suggested.managers)
              ? suggested.managers.map((manager) => ({
                  name: String((manager as { name?: string }).name || '').trim(),
                  email: String((manager as { email?: string }).email || '').trim(),
                  phone: String((manager as { phone?: string }).phone || '').trim(),
                }))
              : [],
            accessCredentials: [],
            notes: '',
            tipoIva: '',
            senhaFinancas: '',
            senhaSegurancaSocial: '',
            tipoContabilidade: '',
            estadoCliente: '',
            contabilistaCertificado: '',
            codigoReparticaoFinancas: '',
            dataConstituicao: '',
          },
          { syncToSupabase }
        );

        const reprocess = await mockService.ingestCustomerDocumentWithAI(
          createdCustomer.id,
          ingestSelectedFile,
          ingestDocumentType
        );
        if (!reprocess.success) {
          setIngestStatus(reprocess.error || 'Cliente criado, mas a ingestão no novo cliente falhou.');
          return;
        }

        await loadCustomers();
        const nextCustomer = reprocess.customer || createdCustomer;
        setEditingCustomer(nextCustomer);
        setFormData(formStateFromCustomer(nextCustomer));
        setIngestWarnings(Array.isArray(reprocess.warnings) ? reprocess.warnings : []);
        setIngestStatus(
          `Novo cliente criado e documento guardado em ${reprocess.savedDocument?.relativePath || 'Documentos Oficiais'}.`
        );
        setIngestSelectedFile(null);
        await loadModalDocuments(nextCustomer.id, 'Documentos Oficiais');
        return;
      }

      if (!result.success) {
        setIngestStatus(result.error || 'Falha na análise do documento.');
        return;
      }

      if (result.customer) {
        setEditingCustomer(result.customer);
        setFormData(formStateFromCustomer(result.customer));
      }
      await loadCustomers();
      setIngestWarnings(Array.isArray(result.warnings) ? result.warnings : []);
      setIngestStatus(
        `Documento guardado: ${result.savedDocument?.fileName || ingestSelectedFile.name}${result.updatedFields?.length ? ` | Campos atualizados: ${result.updatedFields.join(', ')}` : ''}`
      );
      setIngestSelectedFile(null);
      await loadModalDocuments(editingCustomer.id, 'Documentos Oficiais');
    } catch (error) {
      setIngestStatus(error instanceof Error ? error.message : 'Falha ao inserir documento.');
    } finally {
      setIngestLoading(false);
    }
  };

  const downloadCustomerDocument = (customerId: string, relativePath: string) => {
    if (!customerId) return;
    const query = new URLSearchParams({ path: relativePath });
    window.open(`/api/customers/${encodeURIComponent(customerId)}/documents/download?${query.toString()}`, '_blank');
  };

  const downloadModalDocument = (relativePath: string) => {
    if (!editingCustomer?.id) return;
    downloadCustomerDocument(editingCustomer.id, relativePath);
  };

  const triggerFinancasAutologin = async (customer: Customer) => {
    const customerId = String(customer?.id || '').trim();
    if (!customerId) return;
    if (autologinBusyCustomerId) return;
    const { username, password } = resolveAtAccessFromCustomer(customer);
    const loginUrl = 'https://www.acesso.gov.pt/v2/loginForm?partID=PFAP';
    const isDesktopShell = Boolean(window.waDesktop?.isDesktop);
    const hasDesktopAutologinApi = typeof window.waDesktop?.financasAutologin === 'function';
    const openLoginWithClipboard = async (messagePrefix: string, includeDesktopHint = false) => {
      window.open(loginUrl, '_blank', 'noopener,noreferrer');

      let clipboardCopied = false;
      if (username && password && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(`Utilizador AT: ${username}\nSenha AT: ${password}`);
          clipboardCopied = true;
        } catch {
          clipboardCopied = false;
        }
      }

      const desktopHint = includeDesktopHint
        ? ' Se estiveres na app WA PRO Desktop, atualiza/reabre a app para ativar o autologin local.'
        : '';

      window.alert(
        clipboardCopied
          ? `${messagePrefix}${desktopHint} Abri o Portal das Finanças no teu browser local e copiei as credenciais AT para colar (Ctrl+V).`
          : `${messagePrefix}${desktopHint} Abri o Portal das Finanças no teu browser local; usa as credenciais AT da ficha do cliente.`
      );
    };

    const showManualPasteHintWithoutOpening = async (messagePrefix: string) => {
      let clipboardCopied = false;
      if (username && password && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(`Utilizador AT: ${username}\nSenha AT: ${password}`);
          clipboardCopied = true;
        } catch {
          clipboardCopied = false;
        }
      }
      window.alert(
        clipboardCopied
          ? `${messagePrefix} O browser já foi aberto; copiei as credenciais AT para colar (Ctrl+V).`
          : `${messagePrefix} O browser já foi aberto; usa as credenciais AT da ficha do cliente.`
      );
    };

    setAutologinBusyCustomerId(customerId);
    try {
      if (!username || !password) {
        throw new Error('Este cliente não tem utilizador/senha AT completos na ficha.');
      }

      const localDesktopAutologin = hasDesktopAutologinApi ? window.waDesktop?.financasAutologin : undefined;
      if (localDesktopAutologin) {
        const desktopResult = await localDesktopAutologin({
          username,
          password,
          loginUrl,
          closeAfterSubmit: false,
        });
        if (!desktopResult?.success) {
          const desktopError = String(desktopResult?.error || 'Falha no autologin local.');
          const fallbackReason = classifyAutologinFallbackReason(desktopError);
          if (fallbackReason === 'automation_unavailable') {
            await openLoginWithClipboard(
              'Autologin automático indisponível neste computador (browser de automação não instalado).',
              isDesktopShell
            );
            return;
          }
          if (fallbackReason === 'fields_not_found') {
            await showManualPasteHintWithoutOpening(
              'Não consegui preencher automaticamente os campos de login neste ecrã da AT.'
            );
            return;
          }
          throw new Error(desktopError);
        }
        return;
      }

      if (username && password) {
        try {
          const bridgeResult = await triggerLocalFinancasAutologinBridge({
            username,
            password,
            loginUrl,
            closeAfterSubmit: false,
          });
          if (bridgeResult?.success) {
            return;
          }
        } catch (bridgeError) {
          const bridgeMessage = bridgeError instanceof Error ? bridgeError.message : String(bridgeError || '');
          if (!isLocalAutomationBridgeUnavailable(bridgeMessage)) {
            throw new Error(bridgeMessage || 'Falha no autologin local.');
          }
          await openLoginWithClipboard(
            isDesktopShell
              ? 'Não encontrei o helper local de automação (app desktop possivelmente desatualizada).'
              : 'Não encontrei o helper local de automação neste computador.',
            isDesktopShell
          );
          return;
        }
      }

      await mockService.triggerFinancasAutologin(customerId, {
        headless: false,
        closeAfterSubmit: false,
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Falha ao iniciar autologin do Portal das Finanças.';
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code || '').trim()
          : '';

      if (errorCode === 'NO_GUI_SESSION') {
        await openLoginWithClipboard(
          'O servidor não tem ambiente gráfico para abrir browser.'
        );
      } else if (classifyAutologinFallbackReason(rawMessage) === 'automation_unavailable') {
        await openLoginWithClipboard(
          'Autologin automático indisponível neste computador (browser de automação não instalado).',
          isDesktopShell
        );
      } else if (classifyAutologinFallbackReason(rawMessage) === 'fields_not_found') {
        await showManualPasteHintWithoutOpening(
          'Não consegui preencher automaticamente os campos de login neste ecrã da AT.'
        );
      } else {
        window.alert(rawMessage);
      }
    } finally {
      setAutologinBusyCustomerId(null);
    }
  };

  const triggerSegSocialAutologin = async (customer: Customer) => {
    const customerId = String(customer?.id || '').trim();
    if (!customerId) return;
    if (autologinBusyCustomerId || segSocialAutologinBusyCustomerId) return;
    const { username, password } = resolveSsAccessFromCustomer(customer);
    const loginUrl = SEG_SOCIAL_LOGIN_URL;
    const isDesktopShell = Boolean(window.waDesktop?.isDesktop);
    const hasDesktopAutologinApi = typeof window.waDesktop?.financasAutologin === 'function';
    const openLoginWithClipboard = async (messagePrefix: string, includeDesktopHint = false) => {
      window.open(loginUrl, '_blank', 'noopener,noreferrer');

      let clipboardCopied = false;
      if (username && password && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(`Utilizador SS: ${username}\nSenha SS: ${password}`);
          clipboardCopied = true;
        } catch {
          clipboardCopied = false;
        }
      }

      const desktopHint = includeDesktopHint
        ? ' Se estiveres na app WA PRO Desktop, atualiza/reabre a app para ativar o autologin local.'
        : '';

      window.alert(
        clipboardCopied
          ? `${messagePrefix}${desktopHint} Abri a Segurança Social Direta no teu browser local e copiei as credenciais SS para colar (Ctrl+V).`
          : `${messagePrefix}${desktopHint} Abri a Segurança Social Direta no teu browser local; usa as credenciais SS da ficha do cliente.`
      );
    };

    const showManualPasteHintWithoutOpening = async (messagePrefix: string) => {
      let clipboardCopied = false;
      if (username && password && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(`Utilizador SS: ${username}\nSenha SS: ${password}`);
          clipboardCopied = true;
        } catch {
          clipboardCopied = false;
        }
      }
      window.alert(
        clipboardCopied
          ? `${messagePrefix} O browser já foi aberto; copiei as credenciais SS para colar (Ctrl+V).`
          : `${messagePrefix} O browser já foi aberto; usa as credenciais SS da ficha do cliente.`
      );
    };

    setSegSocialAutologinBusyCustomerId(customerId);
    try {
      if (!username || !password) {
        throw new Error('Este cliente não tem utilizador/senha SS Direta completos na ficha.');
      }

      const localDesktopAutologin = hasDesktopAutologinApi ? window.waDesktop?.financasAutologin : undefined;
      if (localDesktopAutologin) {
        const desktopResult = await localDesktopAutologin({
          username,
          password,
          loginUrl,
          closeAfterSubmit: false,
          credentialLabel: 'SS',
          usernameSelectors: SEG_SOCIAL_USERNAME_SELECTORS,
          passwordSelectors: SEG_SOCIAL_PASSWORD_SELECTORS,
          submitSelectors: SEG_SOCIAL_SUBMIT_SELECTORS,
          successSelectors: SEG_SOCIAL_SUCCESS_SELECTORS,
          activateFinancasNifTab: false,
        });
        if (!desktopResult?.success) {
          const desktopError = String(desktopResult?.error || 'Falha no autologin local.');
          const fallbackReason = classifyAutologinFallbackReason(desktopError);
          if (fallbackReason === 'automation_unavailable') {
            await openLoginWithClipboard(
              'Autologin automático indisponível neste computador (browser de automação não instalado).',
              isDesktopShell
            );
            return;
          }
          if (fallbackReason === 'fields_not_found') {
            await showManualPasteHintWithoutOpening(
              'Não consegui preencher automaticamente os campos de login neste ecrã da Segurança Social Direta.'
            );
            return;
          }
          throw new Error(desktopError);
        }
        return;
      }

      if (username && password) {
        try {
          const bridgeResult = await triggerLocalFinancasAutologinBridge({
            username,
            password,
            loginUrl,
            closeAfterSubmit: false,
            credentialLabel: 'SS',
            usernameSelectors: SEG_SOCIAL_USERNAME_SELECTORS,
            passwordSelectors: SEG_SOCIAL_PASSWORD_SELECTORS,
            submitSelectors: SEG_SOCIAL_SUBMIT_SELECTORS,
            successSelectors: SEG_SOCIAL_SUCCESS_SELECTORS,
            activateFinancasNifTab: false,
          });
          if (bridgeResult?.success) {
            return;
          }
        } catch (bridgeError) {
          const bridgeMessage = bridgeError instanceof Error ? bridgeError.message : String(bridgeError || '');
          if (!isLocalAutomationBridgeUnavailable(bridgeMessage)) {
            throw new Error(bridgeMessage || 'Falha no autologin local.');
          }
          await openLoginWithClipboard(
            isDesktopShell
              ? 'Não encontrei o helper local de automação (app desktop possivelmente desatualizada).'
              : 'Não encontrei o helper local de automação neste computador.',
            isDesktopShell
          );
          return;
        }
      }

      await mockService.triggerSegSocialAutologin(customerId, {
        headless: false,
        closeAfterSubmit: false,
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Falha ao iniciar autologin da Segurança Social Direta.';
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code || '').trim()
          : '';

      if (errorCode === 'NO_GUI_SESSION') {
        await openLoginWithClipboard(
          'O servidor não tem ambiente gráfico para abrir browser.'
        );
      } else if (classifyAutologinFallbackReason(rawMessage) === 'automation_unavailable') {
        await openLoginWithClipboard(
          'Autologin automático indisponível neste computador (browser de automação não instalado).',
          isDesktopShell
        );
      } else if (classifyAutologinFallbackReason(rawMessage) === 'fields_not_found') {
        await showManualPasteHintWithoutOpening(
          'Não consegui preencher automaticamente os campos de login neste ecrã da Segurança Social Direta.'
        );
      } else {
        window.alert(rawMessage);
      }
    } finally {
      setSegSocialAutologinBusyCustomerId(null);
    }
  };

  const openModal = (customer?: Customer) => {
    setActiveTab('dados');
    resetModalDocsState();
    resetSociedadeDocsState();
    resetIngestState();
    setCustomerTasksSummary([]);
    setCustomerOccurrencesSummary([]);
    setCustomerActivityError('');
    setCustomerActivityLoading(false);
    setAgregadoSearchTerms({});
    setFichasSearchTerms({});

    if (customer) {
      setEditingCustomer(customer);
      setFormData(formStateFromCustomer(customer));
    } else {
      setEditingCustomer(null);
      setFormData(emptyFormState());
    }

    setShowModal(true);
  };

  useEffect(() => {
    if (customers.length === 0 || showModal) return;
    if (typeof window === 'undefined' || !window.localStorage) return;
    const requestedId = String(window.localStorage.getItem(OPEN_CUSTOMER_PROFILE_STORAGE_KEY) || '').trim();
    if (!requestedId) return;
    const target = customers.find((customer) => customer.id === requestedId);
    window.localStorage.removeItem(OPEN_CUSTOMER_PROFILE_STORAGE_KEY);
    if (target) {
      openModal(target);
    }
  }, [customers, showModal]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const currentCustomerId = String(editingCustomer?.id || '').trim();
    const currentCustomerSourceId = inferCustomerSourceId(editingCustomer);
    const normalizeNif = (value: string): string => normalizeNifDigits(value);

    const sanitizeHousehold = (entries: CustomerHouseholdRelation[]): CustomerHouseholdRelation[] => {
      const allowed = new Set(HOUSEHOLD_RELATION_OPTIONS.map((item) => item.value));
      const seen = new Set<string>();
      const normalized: CustomerHouseholdRelation[] = [];

      entries.forEach((entry) => {
        const resolved = resolveLinkedCustomerByEntry(entry);
        const customerId = String(resolved?.id || entry.customerId || '').trim();
        const customerSourceId = String(entry.customerSourceId || inferCustomerSourceId(resolved) || '').trim();
        const normalizedRelationType = normalizeHouseholdRelationTypeValue(String(entry.relationType || ''));
        const relationType = allowed.has(normalizedRelationType) ? normalizedRelationType : 'outro';
        const note = String(entry.note || '').trim();
        const customerName = String(entry.customerName || resolved?.name || '').trim();
        const customerCompany = String(entry.customerCompany || resolved?.company || '').trim();
        const customerNif = normalizeNif(String(entry.customerNif || resolved?.nif || ''));

        const selfById = currentCustomerId && customerId && currentCustomerId === customerId;
        const selfBySource = currentCustomerSourceId && customerSourceId && currentCustomerSourceId === customerSourceId;
        if (selfById || selfBySource) return;

        const keySeed =
          customerSourceId ||
          customerId ||
          customerNif ||
          `${customerName.toLowerCase()}::${customerCompany.toLowerCase()}`;
        if (!keySeed) return;
        const dedupeKey = `${relationType}::${keySeed}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);

        normalized.push({
          customerId: customerId || undefined,
          customerSourceId: customerSourceId || undefined,
          relationType,
          note: note || undefined,
          customerName: customerName || undefined,
          customerCompany: customerCompany || undefined,
          customerNif: customerNif || undefined,
        });
      });

      return normalized;
    };

    const sanitizeRelated = (entries: CustomerRelatedRecord[]): CustomerRelatedRecord[] => {
      const allowed = new Set(RELATED_RECORD_OPTIONS.map((item) => item.value));
      const seen = new Set<string>();
      const normalized: CustomerRelatedRecord[] = [];

      entries.forEach((entry) => {
        const resolved = resolveLinkedCustomerByEntry(entry);
        const customerId = String(resolved?.id || entry.customerId || '').trim();
        const customerSourceId = String(entry.customerSourceId || inferCustomerSourceId(resolved) || '').trim();
        const relationType = allowed.has(entry.relationType) ? entry.relationType : 'outro';
        const note = String(entry.note || '').trim();
        const customerName = String(entry.customerName || resolved?.name || '').trim();
        const customerCompany = String(entry.customerCompany || resolved?.company || '').trim();
        const customerNif = normalizeNif(String(entry.customerNif || resolved?.nif || ''));

        const selfById = currentCustomerId && customerId && currentCustomerId === customerId;
        const selfBySource = currentCustomerSourceId && customerSourceId && currentCustomerSourceId === customerSourceId;
        if (selfById || selfBySource) return;

        const keySeed =
          customerSourceId ||
          customerId ||
          customerNif ||
          `${customerName.toLowerCase()}::${customerCompany.toLowerCase()}`;
        if (!keySeed) return;
        const dedupeKey = `${relationType}::${keySeed}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);

        normalized.push({
          customerId: customerId || undefined,
          customerSourceId: customerSourceId || undefined,
          relationType,
          note: note || undefined,
          customerName: customerName || undefined,
          customerCompany: customerCompany || undefined,
          customerNif: customerNif || undefined,
        });
      });

      return normalized;
    };

    const agregadoFamiliar = sanitizeHousehold(Array.isArray(formData.agregadoFamiliar) ? formData.agregadoFamiliar : []);
    const fichasRelacionadas = sanitizeRelated(Array.isArray(formData.fichasRelacionadas) ? formData.fichasRelacionadas : []);
    const nextNif = normalizeNif(formData.nif || '');
    const currentNif = normalizeNif(String(editingCustomer?.nif || ''));

    if (nextNif && nextNif !== currentNif && !isValidPortugueseNif(nextNif)) {
      window.alert('NIF inválido. Introduza um NIF português válido com 9 dígitos.');
      return;
    }

    if (editingCustomer?.id && currentNif && isValidPortugueseNif(currentNif) && nextNif !== currentNif) {
      window.alert('Este cliente já tem um NIF válido gravado. O NIF está bloqueado e não pode ser alterado.');
      return;
    }

    const shouldCheckDuplicateNif = Boolean(nextNif && (!editingCustomer?.id || nextNif !== currentNif));
    if (shouldCheckDuplicateNif) {
      const duplicateCustomer = customers.find((customer) => {
        if (String(customer.id || '').trim() === currentCustomerId) return false;
        return normalizeNif(String(customer.nif || '')) === nextNif;
      });
      if (duplicateCustomer) {
        const duplicateLabel = String(duplicateCustomer.company || duplicateCustomer.name || duplicateCustomer.id || '').trim();
        window.alert(`NIF duplicado detetado (${nextNif}) na ficha "${duplicateLabel}".`);
        return;
      }
    }

    const payload = {
      ...formData,
      contactName: String(formData.contactName || '').trim(),
      nif: nextNif,
      ownerId: formData.ownerId || null,
      certidaoPermanenteNumero: String(formData.certidaoPermanenteNumero || '').trim(),
      certidaoPermanenteValidade: String(formData.certidaoPermanenteValidade || '').trim(),
      rcbeNumero: String(formData.rcbeNumero || '').trim(),
      rcbeData: String(formData.rcbeData || '').trim(),
      dataConstituicao: String(formData.dataConstituicao || '').trim(),
      inicioAtividade: String(formData.inicioAtividade || '').trim(),
      caePrincipal: String(formData.caePrincipal || '').trim(),
      codigoReparticaoFinancas: String(formData.codigoReparticaoFinancas || '').trim(),
      tipoContabilidade: String(formData.tipoContabilidade || '').trim(),
      estadoCliente: String(formData.estadoCliente || '').trim(),
      contabilistaCertificado: String(formData.contabilistaCertificado || '').trim(),
      notes: String(formData.notes || '').trim(),
      managers: (Array.isArray(formData.managers) ? formData.managers : [])
        .map((manager) => ({
          name: String(manager.name || '').trim(),
          email: String(manager.email || '').trim(),
          phone: String(manager.phone || '').trim(),
        }))
        .filter((manager) => manager.name || manager.email || manager.phone),
      accessCredentials: applyAtUsernameFallback(
        (Array.isArray(formData.accessCredentials) ? formData.accessCredentials : [])
          .map((credential) => ({
            service: String(credential.service || '').trim(),
            username: String(credential.username || '').trim(),
            password: String(credential.password || '').trim(),
          })),
        nextNif
      )
        .filter((credential) => credential.service || credential.username || credential.password),
      agregadoFamiliar,
      fichasRelacionadas,
    };

    if (editingCustomer) {
      await mockService.updateCustomer(editingCustomer.id, payload);
    } else {
      const syncToSupabase = window.confirm('Também quer adicionar este cliente no MPR Control (Supabase)?\n\nOK = Sim\nCancelar = Só local');
      await mockService.createCustomer(payload, { syncToSupabase });
    }

    setShowModal(false);
    setEditingCustomer(null);
    setFormData(emptyFormState());
    setAgregadoSearchTerms({});
    setFichasSearchTerms({});
    resetModalDocsState();
    resetIngestState();
    await loadCustomers();
  };

  const addSubContact = () => {
    setFormData({
      ...formData,
      contacts: [...formData.contacts, { name: '', phone: '' }],
    });
  };

  const updateSubContact = (index: number, field: keyof SubContact, value: string) => {
    const newContacts = [...formData.contacts];
    newContacts[index][field] = value;
    setFormData({ ...formData, contacts: newContacts });
  };

  const removeSubContact = (index: number) => {
    const newContacts = formData.contacts.filter((_, i) => i !== index);
    setFormData({ ...formData, contacts: newContacts });
  };

  const addManager = () => {
    setFormData({
      ...formData,
      managers: [...formData.managers, { name: '', email: '', phone: '' }],
    });
  };

  const updateManager = (index: number, field: keyof CustomerManager, value: string) => {
    const nextManagers = [...formData.managers];
    nextManagers[index] = { ...nextManagers[index], [field]: value };
    setFormData({ ...formData, managers: nextManagers });
  };

  const removeManager = (index: number) => {
    const nextManagers = formData.managers.filter((_, i) => i !== index);
    setFormData({ ...formData, managers: nextManagers });
  };

  const addAccessCredential = () => {
    setFormData({
      ...formData,
      accessCredentials: [...formData.accessCredentials, { service: '', username: '', password: '' }],
    });
  };

  const updateAccessCredential = (index: number, field: keyof CustomerAccessCredential, value: string) => {
    const nextCredentials = [...formData.accessCredentials];
    nextCredentials[index] = { ...nextCredentials[index], [field]: value };
    setFormData({ ...formData, accessCredentials: nextCredentials });
  };

  const removeAccessCredential = (index: number) => {
    const nextCredentials = formData.accessCredentials.filter((_, i) => i !== index);
    setFormData({ ...formData, accessCredentials: nextCredentials });
  };

  const inferCustomerSourceId = (customer?: Customer | null): string => {
    const explicit = String(customer?.sourceId || '').trim();
    if (explicit) return explicit;
    const id = String(customer?.id || '').trim();
    if (id.startsWith('ext_c_')) return id.slice(6);
    return '';
  };

  const resolveLinkedCustomerByEntry = (
    entry: Pick<CustomerHouseholdRelation, 'customerId' | 'customerSourceId'>
  ): Customer | null => {
    const byId = String(entry.customerId || '').trim();
    if (byId) {
      const direct = customers.find((customer) => customer.id === byId);
      if (direct) return direct;
      const idAsSource = byId.startsWith('ext_c_') ? byId.slice(6) : byId;
      const fromIdAsSource = customers.find((customer) => inferCustomerSourceId(customer) === idAsSource);
      if (fromIdAsSource) return fromIdAsSource;
    }

    const bySourceId = String(entry.customerSourceId || '').trim();
    if (!bySourceId) return null;
    return (
      customers.find((customer) => inferCustomerSourceId(customer) === bySourceId) || null
    );
  };

  const addAgregadoFamiliar = () => {
    setFormData((prev) => ({
      ...prev,
      agregadoFamiliar: [
        ...prev.agregadoFamiliar,
        { customerId: '', customerSourceId: '', relationType: 'conjuge', note: '' },
      ],
    }));
  };

  const updateAgregadoFamiliar = (
    index: number,
    field: keyof CustomerHouseholdRelation,
    value: string
  ) => {
    const nextItems = [...formData.agregadoFamiliar];
    const current = { ...(nextItems[index] || { relationType: 'conjuge' }) };

    if (field === 'customerId') {
      const selected = customers.find((customer) => customer.id === value) || null;
      if (!selected) {
        current.customerId = undefined;
        current.customerSourceId = undefined;
        current.customerName = undefined;
        current.customerCompany = undefined;
        current.customerNif = undefined;
      } else {
        current.customerId = value || undefined;
        current.customerSourceId = inferCustomerSourceId(selected) || undefined;
        current.customerName = selected?.name || undefined;
        current.customerCompany = selected?.company || undefined;
        current.customerNif = selected?.nif || undefined;
      }
    } else if (field === 'relationType') {
      current.relationType = normalizeHouseholdRelationTypeValue(value);
    } else if (field === 'note') {
      current.note = value || undefined;
    }

    nextItems[index] = current;
    setFormData({ ...formData, agregadoFamiliar: nextItems });
  };

  const removeAgregadoFamiliar = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      agregadoFamiliar: prev.agregadoFamiliar.filter((_, i) => i !== index),
    }));
    setAgregadoSearchTerms((prev) => removeIndexedSearchTerm(prev, index));
  };

  const addFichaRelacionada = () => {
    setFormData((prev) => ({
      ...prev,
      fichasRelacionadas: [
        ...prev.fichasRelacionadas,
        { customerId: '', customerSourceId: '', relationType: 'funcionario', note: '' },
      ],
    }));
  };

  const updateFichaRelacionada = (
    index: number,
    field: keyof CustomerRelatedRecord,
    value: string
  ) => {
    const nextItems = [...formData.fichasRelacionadas];
    const current = { ...(nextItems[index] || { relationType: 'funcionario' }) };

    if (field === 'customerId') {
      const selected = customers.find((customer) => customer.id === value) || null;
      if (!selected) {
        current.customerId = undefined;
        current.customerSourceId = undefined;
        current.customerName = undefined;
        current.customerCompany = undefined;
        current.customerNif = undefined;
      } else {
        current.customerId = value || undefined;
        current.customerSourceId = inferCustomerSourceId(selected) || undefined;
        current.customerName = selected?.name || undefined;
        current.customerCompany = selected?.company || undefined;
        current.customerNif = selected?.nif || undefined;
      }
    } else if (field === 'relationType') {
      current.relationType = (value as CustomerRelatedRecord['relationType']) || 'outro';
    } else if (field === 'note') {
      current.note = value || undefined;
    }

    nextItems[index] = current;
    setFormData({ ...formData, fichasRelacionadas: nextItems });
  };

  const removeFichaRelacionada = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      fichasRelacionadas: prev.fichasRelacionadas.filter((_, i) => i !== index),
    }));
    setFichasSearchTerms((prev) => removeIndexedSearchTerm(prev, index));
  };

  const openRelatedCustomerProfile = (customer: Customer | null) => {
    if (!customer?.id) return;
    if (editingCustomer?.id === customer.id) return;
    const customerLabel = buildRelationCustomerLabel(customer) || customer.id;
    const canSwitch = window.confirm(
      `Abrir a ficha de "${customerLabel}"?\n\nAs alterações não gravadas na ficha atual serão perdidas.`
    );
    if (!canSwitch) return;
    setEditingCustomer(customer);
    setFormData(formStateFromCustomer(customer));
    setActiveTab('relacoes');
    setAgregadoSearchTerms({});
    setFichasSearchTerms({});
  };

  const getTypeColor = (type: CustomerType) => {
    switch (type) {
      case CustomerType.ENTERPRISE:
        return 'bg-blue-100 text-blue-800';
      case CustomerType.INDEPENDENT:
        return 'bg-gray-200 text-gray-700';
      case CustomerType.SPAM:
        return 'bg-red-100 text-red-800';
      case CustomerType.SUPPLIER:
        return 'bg-purple-100 text-purple-800';
      case CustomerType.PRIVATE:
        return 'bg-amber-100 text-amber-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getCustomerStatus = (customer: Customer): string => {
    const lookup = buildImportedLookup((customer.supabasePayload as Record<string, unknown>) || undefined);
    const sourceStatus = pickImportedValue(lookup, ['estado', 'status']);
    return normalizeStatus(sourceStatus);
  };

  const filteredCustomers = customers.filter((customer) => {
    const term = searchTerm.trim().toLowerCase();
    if (term) {
      const matchesTerm =
        customer.name.toLowerCase().includes(term) ||
        customer.company.toLowerCase().includes(term) ||
        customer.phone.toLowerCase().includes(term) ||
        (customer.email || '').toLowerCase().includes(term) ||
        (customer.nif || '').toLowerCase().includes(term) ||
        (customer.niss || '').toLowerCase().includes(term) ||
        (customer.morada || '').toLowerCase().includes(term) ||
        (customer.documentsFolder || '').toLowerCase().includes(term);
      if (!matchesTerm) return false;
    }

    if (stateFilter !== 'TODOS' && getCustomerStatus(customer) !== stateFilter) return false;
    if (typeFilter !== 'TODOS' && String(customer.type) !== typeFilter) return false;
    if (ownerFilter !== 'TODOS' && String(customer.ownerId || '') !== ownerFilter) return false;

    return true;
  });

  const toggleSort = (nextKey: CustomerSortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(nextKey);
    setSortDirection('asc');
  };

  const sortIndicator = (key: CustomerSortKey): string => {
    if (sortKey !== key) return '↕';
    return sortDirection === 'asc' ? '▲' : '▼';
  };

  const sortedCustomers = useMemo(() => {
    const ownerNameById = new Map(users.map((user) => [user.id, user.name]));
    const normalizeText = (value: string) =>
      String(value || '')
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

    const compareText = (left: string, right: string) =>
      normalizeText(left).localeCompare(normalizeText(right), 'pt-PT', {
        sensitivity: 'base',
        numeric: true,
      });

    const sorted = [...filteredCustomers].sort((left, right) => {
      let comparison = 0;

      if (sortKey === 'nif') {
        const leftNif = String(left.nif || '').replace(/\D/g, '');
        const rightNif = String(right.nif || '').replace(/\D/g, '');
        comparison = compareText(leftNif, rightNif);
      } else if (sortKey === 'name') {
        comparison = compareText(left.company || left.name, right.company || right.name);
      } else if (sortKey === 'type') {
        comparison = compareText(left.type, right.type);
      } else if (sortKey === 'email') {
        comparison = compareText(left.email || '', right.email || '');
      } else if (sortKey === 'phone') {
        comparison = compareText(left.phone || '', right.phone || '');
      } else if (sortKey === 'owner') {
        comparison = compareText(ownerNameById.get(left.ownerId || '') || '', ownerNameById.get(right.ownerId || '') || '');
      } else if (sortKey === 'status') {
        comparison = compareText(getCustomerStatus(left), getCustomerStatus(right));
      }

      if (comparison === 0) {
        comparison = compareText(left.company || left.name, right.company || right.name);
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [filteredCustomers, getCustomerStatus, sortDirection, sortKey, users]);

  const selectableRelationCustomers = useMemo(() => {
    const currentId = String(editingCustomer?.id || '').trim();
    return customers.filter((customer) => String(customer.id || '').trim() !== currentId);
  }, [customers, editingCustomer?.id]);

  const editingCustomerDisplayName = useMemo(() => {
    const name = String(formData.name || editingCustomer?.name || '').trim();
    const company = String(formData.company || editingCustomer?.company || '').trim();
    if (name) return name;
    if (company) return company;
    const sourceId = String(editingCustomer?.sourceId || '').trim();
    const localId = String(editingCustomer?.id || '').trim();
    if (sourceId) return `ID ${sourceId}`;
    if (localId) return `ID ${localId}`;
    return 'Cliente sem identificação';
  }, [
    formData.name,
    formData.company,
    editingCustomer?.name,
    editingCustomer?.company,
    editingCustomer?.sourceId,
    editingCustomer?.id,
  ]);

  const lockedNif = useMemo(() => normalizeNifDigits(String(editingCustomer?.nif || '')), [editingCustomer?.nif]);
  const isNifLocked = useMemo(
    () => Boolean(editingCustomer?.id && lockedNif && isValidPortugueseNif(lockedNif)),
    [editingCustomer?.id, lockedNif]
  );

  const taskOpenCount = useMemo(
    () => customerTasksSummary.filter((task) => String(task.status || '').toUpperCase() !== 'DONE').length,
    [customerTasksSummary]
  );
  const taskClosedCount = customerTasksSummary.length - taskOpenCount;

  const occurrenceClosedCount = useMemo(
    () => customerOccurrencesSummary.filter((item) => String(item.state || '').toUpperCase() === 'RESOLVIDA').length,
    [customerOccurrencesSummary]
  );
  const occurrenceOpenCount = customerOccurrencesSummary.length - occurrenceClosedCount;

  const importedPayload = useMemo(() => {
    if (!editingCustomer?.supabasePayload || typeof editingCustomer.supabasePayload !== 'object') return undefined;
    return editingCustomer.supabasePayload as Record<string, unknown>;
  }, [editingCustomer]);

  const importedLookup = useMemo(() => buildImportedLookup(importedPayload), [importedPayload]);

  const importedFields = useMemo(() => {
    const fields = [
      { label: 'Morada', value: pickImportedValue(importedLookup, ['morada', 'address']) },
      { label: 'Código Postal', value: pickImportedValue(importedLookup, ['codigo_postal', 'cod_postal', 'cp']) },
      { label: 'Localidade', value: pickImportedValue(importedLookup, ['localidade']) },
      { label: 'Concelho', value: pickImportedValue(importedLookup, ['concelho']) },
      { label: 'Distrito', value: pickImportedValue(importedLookup, ['distrito']) },
      { label: 'Freguesia', value: pickImportedValue(importedLookup, ['freguesia']) },
      { label: 'CAE Principal', value: pickImportedValue(importedLookup, ['cae_principal', 'cae']) },
      { label: 'Data Constituição', value: pickImportedValue(importedLookup, ['data_constituicao']) },
      { label: 'Início Atividade', value: pickImportedValue(importedLookup, ['inicio_atividade', 'data_inicio_atividade']) },
      { label: 'Certidão Permanente (nº)', value: pickImportedValue(importedLookup, ['certidao_permanente_numero', 'certidao_permanente_n', 'certidao_permanente']) },
      { label: 'Certidão Permanente (validade)', value: pickImportedValue(importedLookup, ['certidao_permanente_validade', 'validade_certidao_permanente']) },
      { label: 'RCBE (nº)', value: pickImportedValue(importedLookup, ['rcbe_numero', 'rcbe_n', 'rcbe']) },
      { label: 'RCBE (data)', value: pickImportedValue(importedLookup, ['rcbe_data']) },
      { label: 'Código Repartição Finanças', value: pickImportedValue(importedLookup, ['codigo_reparticao_financas', 'reparticao_financas']) },
      { label: 'Tipo Entidade', value: pickImportedValue(importedLookup, ['tipo_entidade']) },
      { label: 'Tipo Contabilidade', value: pickImportedValue(importedLookup, ['tipo_contabilidade']) },
      { label: 'Estado', value: pickImportedValue(importedLookup, ['estado']) },
      { label: 'Contabilista Certificado', value: pickImportedValue(importedLookup, ['contabilista_certificado_nome', 'contabilista_certificado']) },
    ];
    return fields.filter((item) => item.value);
  }, [importedLookup]);

  const importedAccesses = useMemo(() => {
    const accesses = [
      { label: 'Utilizador AT', value: pickImportedValue(importedLookup, ['utilizador_at']) },
      { label: 'Password AT', value: pickImportedValue(importedLookup, ['password_at']) },
      { label: 'Utilizador SS', value: pickImportedValue(importedLookup, ['utilizador_ss']) },
      { label: 'Password SS', value: pickImportedValue(importedLookup, ['password_ss']) },
      { label: 'Utilizador RU', value: pickImportedValue(importedLookup, ['utilizador_ru']) },
      { label: 'Password RU', value: pickImportedValue(importedLookup, ['password_ru']) },
      { label: 'Utilizador ViaCTT', value: pickImportedValue(importedLookup, ['utilizador_viactt']) },
      { label: 'Password ViaCTT', value: pickImportedValue(importedLookup, ['password_viactt']) },
      { label: 'Utilizador IAPMEI', value: pickImportedValue(importedLookup, ['utilizador_iapmei']) },
      { label: 'Password IAPMEI', value: pickImportedValue(importedLookup, ['password_iapmei']) },
    ];
    return accesses.filter((item) => item.value);
  }, [importedLookup]);

  const importedRawEntries = useMemo(() => {
    if (!importedPayload) return [];
    return Object.entries(importedPayload)
      .map(([key, value]) => ({ key, value: formatImportedValue(value) }))
      .filter((entry) => entry.value);
  }, [importedPayload]);

  const StatusBadge = ({ status }: { status: string }) => {
    if (status === 'INATIVA' || status === 'ENCERRADA') {
      return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700">{status}</span>;
    }
    if (status === 'SUSPENSA') {
      return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-700">{status}</span>;
    }
    return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-700">ATIVA</span>;
  };

  const actionButtonBaseClass =
    'inline-flex items-center justify-center rounded-lg border transition-all duration-150 hover:-translate-y-[1px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';
  const actionButtonAutologinClass =
    `${actionButtonBaseClass} p-1.5 border-sky-200 bg-sky-100 text-sky-700 hover:bg-sky-200 hover:border-sky-300 focus-visible:ring-sky-300 disabled:opacity-50 disabled:cursor-not-allowed`;
  const actionButtonSsAutologinClass =
    `${actionButtonBaseClass} min-w-[34px] px-1.5 py-1.5 border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300 focus-visible:ring-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed`;
  const actionButtonAutologinImageClass = 'h-4 w-3.5 object-contain select-none';
  const actionButtonViewClass =
    `${actionButtonBaseClass} p-2 border-[#e7dcc9] bg-[#f8f2e8] text-slate-500 hover:text-blue-700 hover:bg-[#efe6d8] hover:border-[#dcc9ab] focus-visible:ring-blue-300`;
  const actionButtonEditClass =
    `${actionButtonBaseClass} p-2 border-[#e7dcc9] bg-[#f8f2e8] text-slate-500 hover:text-whatsapp-700 hover:bg-[#efe6d8] hover:border-[#dcc9ab] focus-visible:ring-green-300`;

  return (
    <div className="p-4 md:p-6 w-full space-y-4">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 md:p-5 text-white shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold">Clientes</h1>
            <p className="text-xs md:text-sm text-slate-200">Gestão e consulta da carteira de clientes.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={openHeaderIngestModal}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs md:text-sm font-semibold"
            >
              <Upload size={16} />
              Adicionar Documento
            </button>
            <button
              onClick={() => openModal()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs md:text-sm font-semibold"
            >
              <Plus size={16} />
              Novo Cliente
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-3 border-b border-slate-200 grid grid-cols-1 md:grid-cols-4 gap-2">
          <div className="relative md:col-span-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Nome ou NIF..."
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-md bg-slate-50 text-sm"
            />
          </div>

          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className="w-full py-2 px-3 border border-slate-200 rounded-md bg-white text-sm">
            <option value="TODOS">Todos os estados</option>
            <option value="ATIVA">Ativa</option>
            <option value="SUSPENSA">Suspensa</option>
            <option value="INATIVA">Inativa</option>
            <option value="ENCERRADA">Encerrada</option>
          </select>

          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="w-full py-2 px-3 border border-slate-200 rounded-md bg-white text-sm">
            <option value="TODOS">Todos os tipos</option>
            {Object.values(CustomerType).map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>

          <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} className="w-full py-2 px-3 border border-slate-200 rounded-md bg-white text-sm">
            <option value="TODOS">Todos</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>{user.name}</option>
            ))}
          </select>
        </div>

        <div className="px-3 py-2 text-xs text-slate-500 border-b border-slate-100">{sortedCustomers.length} cliente(s)</div>

        <div className="overflow-x-auto">
          <table className="min-w-[1100px] w-full table-fixed">
            <thead className="bg-slate-100/80">
              <tr>
                <th className="w-[8%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                  <button type="button" onClick={() => toggleSort('nif')} className="inline-flex items-center gap-1 hover:text-slate-900">
                    NIF <span className="text-[10px]">{sortIndicator('nif')}</span>
                  </button>
                </th>
                <th className="w-[27%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                  <button type="button" onClick={() => toggleSort('name')} className="inline-flex items-center gap-1 hover:text-slate-900">
                    Nome <span className="text-[10px]">{sortIndicator('name')}</span>
                  </button>
                </th>
                <th className="w-[9%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                  <button type="button" onClick={() => toggleSort('type')} className="inline-flex items-center gap-1 hover:text-slate-900">
                    Tipo <span className="text-[10px]">{sortIndicator('type')}</span>
                  </button>
                </th>
                <th className="w-[18%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                  <button type="button" onClick={() => toggleSort('email')} className="inline-flex items-center gap-1 hover:text-slate-900">
                    Email <span className="text-[10px]">{sortIndicator('email')}</span>
                  </button>
                </th>
                <th className="w-[12%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                  <button type="button" onClick={() => toggleSort('phone')} className="inline-flex items-center gap-1 hover:text-slate-900">
                    Telefone <span className="text-[10px]">{sortIndicator('phone')}</span>
                  </button>
                </th>
                <th className="w-[12%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                  <button type="button" onClick={() => toggleSort('owner')} className="inline-flex items-center gap-1 hover:text-slate-900">
                    Resp. interno <span className="text-[10px]">{sortIndicator('owner')}</span>
                  </button>
                </th>
                <th className="w-[8%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                  <button type="button" onClick={() => toggleSort('status')} className="inline-flex items-center gap-1 hover:text-slate-900">
                    Estado <span className="text-[10px]">{sortIndicator('status')}</span>
                  </button>
                </th>
                <th className="w-[6%] px-3 py-3 text-right text-[11px] uppercase text-slate-600 font-semibold">Ações</th>
              </tr>
            </thead>
            <tbody>
              {sortedCustomers.map((customer) => {
                const owner = users.find((u) => u.id === customer.ownerId);
                const status = getCustomerStatus(customer);
                return (
                  <tr key={customer.id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => openModal(customer)}>
                    <td className="px-3 py-3 text-xs font-mono text-slate-700">{customer.nif || '--'}</td>
                    <td className="px-3 py-3 text-sm text-slate-900">
                      <div className="font-semibold truncate" title={customer.company || customer.name}>{customer.company || customer.name}</div>
                      <div className="text-xs text-slate-500 truncate">{customer.name}</div>
                    </td>
                    <td className="px-3 py-3">
                      <span className={`px-2 py-0.5 inline-flex text-[11px] font-semibold rounded-full ${getTypeColor(customer.type)}`}>
                        {customer.type.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-700 truncate" title={customer.email || '--'}>{customer.email || '--'}</td>
                    <td className="px-3 py-3 text-xs text-slate-700 font-mono">{customer.phone || '--'}</td>
                    <td className="px-3 py-3 text-xs text-slate-700">{owner?.name || '--'}</td>
                    <td className="px-3 py-3"><StatusBadge status={status} /></td>
                    <td className="px-3 py-3">
                      <div className="flex justify-end items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => {
                            void triggerFinancasAutologin(customer);
                          }}
                          disabled={Boolean(autologinBusyCustomerId || segSocialAutologinBusyCustomerId)}
                          className={actionButtonAutologinClass}
                          title="Autologin Portal das Finanças"
                          aria-label="Autologin Portal das Finanças"
                        >
                          <img
                            src="/at-symbol.png"
                            alt="AT"
                            className={actionButtonAutologinImageClass}
                          />
                        </button>
                        <button
                          onClick={() => {
                            void triggerSegSocialAutologin(customer);
                          }}
                          disabled={Boolean(autologinBusyCustomerId || segSocialAutologinBusyCustomerId)}
                          className={actionButtonSsAutologinClass}
                          title="Autologin Segurança Social Direta"
                          aria-label="Autologin Segurança Social Direta"
                        >
                          <span className="text-[11px] font-semibold leading-none">SS</span>
                        </button>
                        <button
                          onClick={() => openModal(customer)}
                          className={actionButtonViewClass}
                          title="Ver"
                          aria-label="Ver cliente"
                        >
                          <Eye size={15} />
                        </button>
                        <button
                          onClick={() => openModal(customer)}
                          className={actionButtonEditClass}
                          title="Editar"
                          aria-label="Editar cliente"
                        >
                          <Edit2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {sortedCustomers.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-slate-500">Nenhum cliente encontrado para os filtros atuais.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showHeaderIngestModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Adicionar Documento (IA)</h2>
                <p className="text-xs text-slate-500">
                  Escolha o cliente e o tipo de documento para analisar e guardar em <span className="font-mono">Documentos Oficiais</span>.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowHeaderIngestModal(false);
                  resetHeaderIngestState();
                }}
                className="px-3 py-1.5 text-xs border rounded-md bg-white hover:bg-slate-50"
              >
                Fechar
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Cliente</label>
                <select
                  value={headerIngestCustomerId}
                  onChange={(e) => setHeaderIngestCustomerId(e.target.value)}
                  className="w-full border border-slate-200 rounded-md p-2 text-sm bg-white"
                >
                  <option value="">Deteção automática por NIF (IA)</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.company || customer.name} {customer.nif ? `(${customer.nif})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Tipo</label>
                <select
                  value={headerIngestDocumentType}
                  onChange={(e) => setHeaderIngestDocumentType(e.target.value as CustomerIngestDocumentType)}
                  className="w-full border border-slate-200 rounded-md p-2 text-sm bg-white"
                >
                  {CUSTOMER_INGEST_TYPES.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">Telefone para novo cliente (quando a IA não deteta)</label>
                <input
                  type="text"
                  value={headerIngestPhoneInput}
                  onChange={(e) => setHeaderIngestPhoneInput(e.target.value)}
                  placeholder="+3519..."
                  className="w-full border border-slate-200 rounded-md p-2 text-sm bg-white"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={triggerHeaderIngestPicker}
                  disabled={headerIngestLoading}
                  className="px-2 py-1.5 text-xs border rounded-md bg-white hover:bg-slate-100 disabled:opacity-50"
                >
                  Inserir documento
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runHeaderDocumentIngest();
                  }}
                  disabled={headerIngestLoading}
                  className="px-2 py-1.5 text-xs rounded-md bg-whatsapp-600 text-white hover:bg-whatsapp-700 disabled:opacity-50"
                >
                  {headerIngestLoading ? 'A analisar...' : 'Analisar + Guardar'}
                </button>
              </div>
              <div className="text-xs text-slate-600 mt-2">
                Ficheiro: {headerIngestSelectedFile ? <span className="font-medium">{headerIngestSelectedFile.name}</span> : 'Nenhum ficheiro selecionado.'}
              </div>
              {headerIngestStatus && (
                <div className="mt-2 text-xs text-slate-700 rounded-md border border-slate-200 bg-white px-2 py-1.5">
                  {headerIngestStatus}
                </div>
              )}
              {headerIngestWarnings.length > 0 && (
                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 space-y-1">
                  {headerIngestWarnings.map((warning, index) => (
                    <div key={`header-ingest-warning-${index}`}>- {warning}</div>
                  ))}
                </div>
              )}
              <input
                ref={headerIngestFileInputRef}
                type="file"
                className="hidden"
                onChange={handleHeaderIngestFileSelection}
              />
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 overflow-auto bg-black/45 p-2 md:p-3">
          <div className="mx-auto w-[min(98vw,1900px)] rounded-2xl border border-slate-200 bg-[#f3f6fb] shadow-2xl">
            <div className="mx-3 mt-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  ← Voltar
                </button>
                <div className="min-w-0 flex-1 text-center">
                  <h2 className="text-xl font-bold text-slate-900">{editingCustomer ? 'Editar Cliente' : 'Novo Cliente'}</h2>
                  {editingCustomer && (
                    <p className="mx-auto mt-0.5 max-w-[80vw] truncate text-sm font-semibold text-blue-700" title={editingCustomerDisplayName}>
                      {editingCustomerDisplayName}
                    </p>
                  )}
                  <p className="text-sm text-slate-500">
                    {editingCustomer
                      ? 'Edite os dados locais. Os contactos podem existir só aqui, sem existir no Supabase.'
                      : 'Ao criar, pode escolher se também quer sincronizar este cliente no MPR Control (Supabase).'}
                  </p>
                </div>
                <button
                  type="submit"
                  form="customer-detail-form"
                  className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
                >
                  Gravar
                </button>
              </div>
            </div>

            <div className="p-3 md:p-4">
              <form id="customer-detail-form" onSubmit={handleSubmit} className="space-y-4">
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="min-w-[280px] flex-1">
                      <label htmlFor="allowAuto" className="block text-sm font-medium text-gray-900 cursor-pointer">
                        Permitir Respostas Automáticas
                      </label>
                      <p className="text-xs text-gray-500">Se desativado, este cliente não receberá mensagens de gatilhos automáticos.</p>
                    </div>
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        id="allowAuto"
                        checked={formData.allowAutoResponses}
                        onChange={(e) => setFormData({ ...formData, allowAutoResponses: e.target.checked })}
                        className="w-5 h-5 text-whatsapp-600 rounded focus:ring-whatsapp-500 border-gray-300 cursor-pointer"
                      />
                    </div>
                    <div className="min-w-[220px] border-l border-slate-200 pl-3 text-right">
                      <div className="text-[11px] uppercase tracking-wide text-slate-500">Última sincronização</div>
                      <div className="text-sm font-semibold text-slate-700">{formatDateTime(editingCustomer?.supabaseUpdatedAt)}</div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab('dados')}
                    className={`rounded-xl px-3 py-1.5 text-sm font-semibold transition ${
                      activeTab === 'dados'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Dados
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('acessos')}
                    className={`rounded-xl px-3 py-1.5 text-sm font-semibold transition ${
                      activeTab === 'acessos'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Dados de Acesso
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('contactos')}
                    className={`rounded-xl px-3 py-1.5 text-sm font-semibold transition ${
                      activeTab === 'contactos'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Contactos
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('relacoes')}
                    className={`rounded-xl px-3 py-1.5 text-sm font-semibold transition ${
                      activeTab === 'relacoes'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Fichas Relacionadas
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('atividade')}
                    className={`rounded-xl px-3 py-1.5 text-sm font-semibold transition ${
                      activeTab === 'atividade'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Tarefas e Ocorrências
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('sociedade')}
                    className={`rounded-xl px-3 py-1.5 text-sm font-semibold transition ${
                      activeTab === 'sociedade'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Documentos da Sociedade
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('documentos')}
                    className={`rounded-xl px-3 py-1.5 text-sm font-semibold transition ${
                      activeTab === 'documentos'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Documentos da Pasta
                  </button>
                </div>

              {activeTab === 'dados' && (
                <div className="space-y-5">
                  <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                    <h3 className="text-base font-semibold text-slate-900">Identificação</h3>
                    <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Nome *</label>
                        <input
                          required
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.name}
                          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">NIF</label>
                        <input
                          type="text"
                          className={`mt-1 w-full border rounded-md p-2 font-mono ${isNifLocked ? 'bg-slate-100 text-slate-500 cursor-not-allowed' : ''}`}
                          value={formData.nif}
                          onChange={(e) => setFormData({ ...formData, nif: e.target.value })}
                          disabled={isNifLocked}
                          title={isNifLocked ? 'NIF bloqueado após validação. Para corrigir, criar nova ficha e migrar dados.' : 'Introduza um NIF válido'}
                        />
                        {isNifLocked && (
                          <p className="mt-1 text-xs text-slate-500">NIF validado e bloqueado para evitar alterações indevidas.</p>
                        )}
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">NISS</label>
                        <input
                          type="text"
                          className="mt-1 w-full border rounded-md p-2 font-mono"
                          value={formData.niss}
                          onChange={(e) => setFormData({ ...formData, niss: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Morada</label>
                        <input
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.morada}
                          onChange={(e) => setFormData({ ...formData, morada: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Email</label>
                        <input
                          type="email"
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.email}
                          onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Telefone (opcional)</label>
                        <input
                          type="text"
                          placeholder="+3519..."
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.phone}
                          onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-gray-700">Empresa</label>
                        <input
                          required
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.company}
                          onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-gray-700">Nome do Contacto (Telemóvel)</label>
                        <input
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          placeholder="Ex.: Marco Rebelo"
                          value={formData.contactName}
                          onChange={(e) => setFormData({ ...formData, contactName: e.target.value })}
                        />
                      </div>
                    </div>
                  </section>

                  <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                    <h3 className="text-base font-semibold text-slate-900">Dados Corporativos</h3>
                    <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Certidão Permanente (nº)</label>
                        <input
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.certidaoPermanenteNumero}
                          onChange={(e) => setFormData({ ...formData, certidaoPermanenteNumero: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Certidão Permanente (validade)</label>
                        <input
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          placeholder="dd/mm/aaaa"
                          value={formData.certidaoPermanenteValidade}
                          onChange={(e) => setFormData({ ...formData, certidaoPermanenteValidade: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">RCBE (nº)</label>
                        <input
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.rcbeNumero}
                          onChange={(e) => setFormData({ ...formData, rcbeNumero: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">RCBE (data)</label>
                        <input
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          placeholder="dd/mm/aaaa"
                          value={formData.rcbeData}
                          onChange={(e) => setFormData({ ...formData, rcbeData: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Data de constituição</label>
                        <input
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          placeholder="dd/mm/aaaa"
                          value={formData.dataConstituicao}
                          onChange={(e) => setFormData({ ...formData, dataConstituicao: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Início de atividade</label>
                        <input
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          placeholder="dd/mm/aaaa"
                          value={formData.inicioAtividade}
                          onChange={(e) => setFormData({ ...formData, inicioAtividade: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">CAE Principal</label>
                        <input
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.caePrincipal}
                          onChange={(e) => setFormData({ ...formData, caePrincipal: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Código Repartição Finanças</label>
                        <input
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.codigoReparticaoFinancas}
                          onChange={(e) => setFormData({ ...formData, codigoReparticaoFinancas: e.target.value })}
                        />
                      </div>
                      <div className="md:col-span-4">
                        <label className="block text-sm font-medium text-gray-700">Pasta de documentos (caminho)</label>
                        <div className="mt-1 relative">
                          <FolderOpen size={16} className="absolute left-3 top-2.5 text-gray-400" />
                          <input
                            type="text"
                            className="w-full border rounded-md p-2 pl-9 font-mono text-sm"
                            value={formData.documentsFolder}
                            onChange={(e) => setFormData({ ...formData, documentsFolder: e.target.value })}
                            placeholder="\\10.0.0.6\OneDrive - MPR\Documentos\Contabilidades\Empresas\Cliente"
                          />
                        </div>
                        {!formData.documentsFolder && pickImportedValue(importedLookup, ['pasta_documentos', 'documents_folder']) && (
                          <p className="mt-1 text-xs text-blue-600 break-all">
                            Pasta importada: {pickImportedValue(importedLookup, ['pasta_documentos', 'documents_folder'])}
                          </p>
                        )}
                      </div>
                      <div className="md:col-span-4">
                        <label className="block text-sm font-medium text-gray-700">Notas</label>
                        <textarea
                          className="mt-1 w-full border rounded-md p-2 min-h-[96px]"
                          placeholder="Notas internas do cliente..."
                          value={formData.notes}
                          onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                        />
                      </div>
                    </div>
                  </section>

                  <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                    <h3 className="text-base font-semibold text-slate-900">Enquadramento Fiscal</h3>
                    <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Tipo de entidade</label>
                        <select
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.type}
                          onChange={(e) => setFormData({ ...formData, type: e.target.value as CustomerType })}
                        >
                          {Object.values(CustomerType).map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Regime de IVA</label>
                        <select
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.tipoIva}
                          onChange={(e) => setFormData({ ...formData, tipoIva: e.target.value })}
                        >
                          <option value="">-- Selecionar --</option>
                          <option value="MENSAL">MENSAL</option>
                          <option value="TRIMESTRAL">TRIMESTRAL</option>
                          <option value="ANUAL">ANUAL</option>
                          <option value="ISENTO">ISENTO</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Tipo de contabilidade</label>
                        <select
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.tipoContabilidade}
                          onChange={(e) => setFormData({ ...formData, tipoContabilidade: e.target.value })}
                        >
                          <option value="">-- Selecionar --</option>
                          <option value="ORGANIZADA">ORGANIZADA</option>
                          <option value="SIMPLIFICADA">SIMPLIFICADA</option>
                          <option value="NAO_ORGANIZADA">NÃO ORGANIZADA</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Estado</label>
                        <select
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.estadoCliente}
                          onChange={(e) => setFormData({ ...formData, estadoCliente: e.target.value })}
                        >
                          <option value="">-- Selecionar --</option>
                          <option value="ACTIVA">ACTIVA</option>
                          <option value="SUSPENSA">SUSPENSA</option>
                          <option value="INATIVA">INATIVA</option>
                          <option value="ENCERRADA">ENCERRADA</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Responsável interno</label>
                        <select
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.ownerId}
                          onChange={(e) => setFormData({ ...formData, ownerId: e.target.value })}
                        >
                          <option value="">-- Selecionar --</option>
                          {users.map((u) => (
                            <option key={u.id} value={u.id}>{u.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Contabilista Certificado</label>
                        <input
                          type="text"
                          className="mt-1 w-full border rounded-md p-2"
                          value={formData.contabilistaCertificado}
                          onChange={(e) => setFormData({ ...formData, contabilistaCertificado: e.target.value })}
                        />
                      </div>
                    </div>
                  </section>

                  <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-base font-semibold text-slate-900">Gerência / Administração</h3>
                        <p className="text-xs text-slate-500">Adicionar gerentes com nome, email e telefone.</p>
                      </div>
                      <button
                        type="button"
                        onClick={addManager}
                        className="text-xs text-whatsapp-700 hover:underline inline-flex items-center gap-1"
                      >
                        <Plus size={14} /> Adicionar gerente
                      </button>
                    </div>
                    <div className="space-y-2">
                      {formData.managers.map((manager, index) => (
                        <div key={`manager-${index}`} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center border rounded-md p-2 bg-white">
                          <input
                            type="text"
                            placeholder="Nome"
                            className="md:col-span-4 text-sm border rounded-md p-2"
                            value={manager.name || ''}
                            onChange={(e) => updateManager(index, 'name', e.target.value)}
                          />
                          <input
                            type="email"
                            placeholder="Email"
                            className="md:col-span-4 text-sm border rounded-md p-2"
                            value={manager.email || ''}
                            onChange={(e) => updateManager(index, 'email', e.target.value)}
                          />
                          <input
                            type="text"
                            placeholder="Telefone"
                            className="md:col-span-3 text-sm border rounded-md p-2"
                            value={manager.phone || ''}
                            onChange={(e) => updateManager(index, 'phone', e.target.value)}
                          />
                          <button
                            type="button"
                            onClick={() => removeManager(index)}
                            className="md:col-span-1 text-red-600 text-xs hover:underline justify-self-start md:justify-self-end"
                          >
                            Remover
                          </button>
                        </div>
                      ))}
                      {formData.managers.length === 0 && (
                        <p className="text-xs text-gray-400 italic">Sem gerentes definidos nesta ficha.</p>
                      )}
                    </div>
                  </section>

                  {editingCustomer && (
                    <details className="rounded-xl border border-slate-200 bg-white p-3">
                      <summary className="cursor-pointer text-sm font-semibold text-slate-700">Campos importados do Supabase</summary>
                      <div className="mt-3 space-y-2">
                        {importedFields.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {importedFields.map((field) => (
                              <div key={field.label} className="border rounded-md p-2 bg-gray-50">
                                <div className="text-[11px] uppercase tracking-wide text-gray-500">{field.label}</div>
                                <div className="text-sm text-gray-800 break-words">{field.value}</div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-gray-400 italic">Sem campos extra importados para este cliente.</p>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {activeTab === 'acessos' && (
                <div className="border rounded-lg p-4 space-y-4">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800">Credenciais Locais</h3>
                    <p className="text-xs text-gray-500">Estes dados ficam editáveis nesta aplicação.</p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Senha Finanças</label>
                      <input
                        type="text"
                        className="mt-1 w-full border rounded-md p-2 font-mono"
                        value={formData.senhaFinancas}
                        onChange={(e) => setFormData({ ...formData, senhaFinancas: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Senha Segurança Social</label>
                      <input
                        type="text"
                        className="mt-1 w-full border rounded-md p-2 font-mono"
                        value={formData.senhaSegurancaSocial}
                        onChange={(e) => setFormData({ ...formData, senhaSegurancaSocial: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="border rounded-md p-3 space-y-3">
                    <div className="flex justify-between items-center">
                      <div className="text-sm font-semibold text-gray-800">Acessos adicionais</div>
                      <button
                        type="button"
                        onClick={addAccessCredential}
                        className="text-xs text-whatsapp-600 font-medium hover:underline flex items-center gap-1"
                      >
                        <Plus size={14} /> Adicionar acesso
                      </button>
                    </div>
                    <div className="space-y-2">
                      {formData.accessCredentials.map((credential, index) => (
                        <div key={`credential-${index}`} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center">
                          <input
                            type="text"
                            placeholder="Serviço (ex: ViaCTT, RU, IAPMEI)"
                            className="md:col-span-3 text-sm border rounded-md p-2"
                            value={credential.service || ''}
                            onChange={(e) => updateAccessCredential(index, 'service', e.target.value)}
                          />
                          <input
                            type="text"
                            placeholder="Utilizador"
                            className="md:col-span-4 text-sm border rounded-md p-2"
                            value={credential.username || ''}
                            onChange={(e) => updateAccessCredential(index, 'username', e.target.value)}
                          />
                          <input
                            type="text"
                            placeholder="Senha"
                            className="md:col-span-4 text-sm border rounded-md p-2 font-mono"
                            value={credential.password || ''}
                            onChange={(e) => updateAccessCredential(index, 'password', e.target.value)}
                          />
                          <button
                            type="button"
                            onClick={() => removeAccessCredential(index)}
                            className="md:col-span-1 text-red-600 text-xs hover:underline justify-self-start md:justify-self-end"
                          >
                            Remover
                          </button>
                        </div>
                      ))}
                      {formData.accessCredentials.length === 0 && (
                        <p className="text-xs text-gray-400 italic">Sem acessos adicionais definidos.</p>
                      )}
                    </div>
                  </div>

                  <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                    <div className="text-xs text-slate-500 uppercase tracking-wide">Última sincronização com MPR Control</div>
                    <div className="text-sm font-semibold text-slate-700 mt-1">{formatDateTime(editingCustomer?.supabaseUpdatedAt)}</div>
                  </div>

                  {importedAccesses.length > 0 ? (
                    <div className="border rounded-md p-3">
                      <div className="text-sm font-semibold text-gray-800 mb-2">Acessos Importados (Supabase)</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {importedAccesses.map((field) => (
                          <div key={field.label} className="text-sm">
                            <span className="text-gray-500">{field.label}:</span>{' '}
                            <span className="font-mono text-gray-800 break-all">{field.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400 italic">Sem dados de acesso importados para este cliente.</p>
                  )}
                </div>
              )}

              {activeTab === 'contactos' && (
                <div className="border rounded-lg p-4 space-y-3">
                  <div className="flex justify-between items-center mb-2">
                    <div>
                      <label className="block text-sm font-semibold text-gray-800">Contactos Associados</label>
                      <p className="text-xs text-gray-500">Estes contactos podem existir só nesta aplicação (não precisam existir no Supabase).</p>
                    </div>
                    <button type="button" onClick={addSubContact} className="text-xs text-whatsapp-600 font-medium hover:underline flex items-center gap-1">
                      <Plus size={14} /> Adicionar Contacto
                    </button>
                  </div>

                  <div className="space-y-2">
                    {formData.contacts.map((contact, idx) => (
                      <div key={idx} className="flex gap-2 items-center">
                        <input
                          type="text"
                          placeholder="Nome (ex: Secretaria)"
                          className="flex-1 text-sm border rounded-md p-2"
                          value={contact.name}
                          onChange={(e) => updateSubContact(idx, 'name', e.target.value)}
                        />
                        <input
                          type="text"
                          placeholder="Telefone"
                          className="w-40 text-sm border rounded-md p-2"
                          value={contact.phone}
                          onChange={(e) => updateSubContact(idx, 'phone', e.target.value)}
                        />
                        <button type="button" onClick={() => removeSubContact(idx)} className="text-gray-400 hover:text-red-500" title="Remover contacto">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                    {formData.contacts.length === 0 && <p className="text-xs text-gray-400 italic">Nenhum contacto extra associado.</p>}
                  </div>
                </div>
              )}

              {activeTab === 'relacoes' && (
                <div className="space-y-4">
                  <div className="rounded-lg border border-slate-200 p-4 space-y-3 bg-white">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-800">Agregado Familiar</h3>
                      <p className="text-xs text-gray-500">
                        Relacione esta ficha com cônjuge, filho ou outro elemento do agregado.
                      </p>
                    </div>

                    <div className="space-y-2">
                      {formData.agregadoFamiliar.map((entry, index) => {
                        const resolved = resolveLinkedCustomerByEntry(entry);
                        const baseLabel = buildEntryRelationLabel(entry, resolved);
                        const hasTypedValue = Object.prototype.hasOwnProperty.call(agregadoSearchTerms, index);
                        const typedValue = hasTypedValue ? String(agregadoSearchTerms[index] || '') : '';
                        const searchValue = hasTypedValue ? typedValue : baseLabel;
                        const suggestions = hasTypedValue && typedValue.trim().length > 0
                          ? filterRelationCustomers(typedValue)
                          : [];
                        return (
                          <div key={`agregado-${index}`} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center border rounded-md p-2 bg-slate-50">
                            <div className="md:col-span-5 space-y-1">
                              <input
                                type="text"
                                className="w-full text-sm border rounded-md p-2 bg-white"
                                placeholder="Escreva para sugerir ficha..."
                                value={searchValue}
                                onChange={(e) => {
                                  const nextValue = String(e.target.value || '');
                                  setAgregadoSearchTerms((prev) => ({ ...prev, [index]: nextValue }));
                                  if (!nextValue.trim()) {
                                    updateAgregadoFamiliar(index, 'customerId', '');
                                  }
                                }}
                                onBlur={() => {
                                  window.setTimeout(() => {
                                    setAgregadoSearchTerms((prev) => {
                                      const next = { ...prev };
                                      delete next[index];
                                      return next;
                                    });
                                  }, 120);
                                }}
                              />
                              {hasTypedValue && typedValue.trim().length > 0 && suggestions.length > 0 && (
                                <div className="max-h-40 overflow-auto rounded-md border border-slate-200 bg-white shadow-sm">
                                  {suggestions.map((customer) => (
                                    <button
                                      key={`agf-suggestion-${index}-${customer.id}`}
                                      type="button"
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        updateAgregadoFamiliar(index, 'customerId', customer.id);
                                        setAgregadoSearchTerms((prev) => {
                                          const next = { ...prev };
                                          delete next[index];
                                          return next;
                                        });
                                      }}
                                      className="w-full text-left px-2 py-1.5 text-xs hover:bg-slate-100"
                                    >
                                      {buildRelationCustomerLabel(customer)}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {resolved && (
                                <button
                                  type="button"
                                  onClick={() => openRelatedCustomerProfile(resolved)}
                                  className="text-xs text-blue-700 hover:underline"
                                >
                                  {buildRelationCustomerLabel(resolved)}
                                </button>
                              )}
                            </div>
                            <select
                              className="md:col-span-2 text-sm border rounded-md p-2 bg-white"
                              value={entry.relationType || 'outro'}
                              onChange={(e) => updateAgregadoFamiliar(index, 'relationType', e.target.value)}
                            >
                              {HOUSEHOLD_RELATION_OPTIONS.map((option) => (
                                <option key={`agf-rel-${option.value}`} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                            <input
                              type="text"
                              placeholder="Nota (opcional)"
                              className="md:col-span-4 text-sm border rounded-md p-2"
                              value={entry.note || ''}
                              onChange={(e) => updateAgregadoFamiliar(index, 'note', e.target.value)}
                            />
                            <button
                              type="button"
                              onClick={() => removeAgregadoFamiliar(index)}
                              className="md:col-span-1 text-red-600 text-xs hover:underline justify-self-start md:justify-self-end"
                            >
                              Remover
                            </button>
                          </div>
                        );
                      })}
                      {formData.agregadoFamiliar.length === 0 && <p className="text-xs text-gray-400 italic">Sem relações de agregado familiar definidas.</p>}
                      <button
                        type="button"
                        onClick={addAgregadoFamiliar}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center gap-1"
                      >
                        <Plus size={14} /> Adicionar linha
                      </button>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-200 p-4 space-y-3 bg-white">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-800">Fichas Relacionadas</h3>
                      <p className="text-xs text-gray-500">
                        Relacione com funcionário, amigo, familiar, gerente, sócio ou outro.
                      </p>
                    </div>

                    <div className="space-y-2">
                      {formData.fichasRelacionadas.length > 0 && (
                        <div className="hidden md:grid grid-cols-12 gap-2 px-1 text-xs font-semibold text-slate-600">
                          <div className="col-span-5">Ficha relacionada</div>
                          <div className="col-span-2">Tipo de relação</div>
                          <div className="col-span-4">Nota</div>
                          <div className="col-span-1" />
                        </div>
                      )}
                      {formData.fichasRelacionadas.map((entry, index) => {
                        const resolved = resolveLinkedCustomerByEntry(entry);
                        const baseLabel = buildEntryRelationLabel(entry, resolved);
                        const hasTypedValue = Object.prototype.hasOwnProperty.call(fichasSearchTerms, index);
                        const typedValue = hasTypedValue ? String(fichasSearchTerms[index] || '') : '';
                        const searchValue = hasTypedValue ? typedValue : baseLabel;
                        const suggestions = hasTypedValue && typedValue.trim().length > 0
                          ? filterRelationCustomers(typedValue)
                          : [];
                        return (
                          <div key={`relacionada-${index}`} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center border rounded-md p-2 bg-slate-50">
                            <div className="md:col-span-5 space-y-1">
                              <input
                                type="text"
                                className="w-full text-sm border rounded-md p-2 bg-white"
                                placeholder="Escreva para sugerir ficha..."
                                value={searchValue}
                                onChange={(e) => {
                                  const nextValue = String(e.target.value || '');
                                  setFichasSearchTerms((prev) => ({ ...prev, [index]: nextValue }));
                                  if (!nextValue.trim()) {
                                    updateFichaRelacionada(index, 'customerId', '');
                                  }
                                }}
                                onBlur={() => {
                                  window.setTimeout(() => {
                                    setFichasSearchTerms((prev) => {
                                      const next = { ...prev };
                                      delete next[index];
                                      return next;
                                    });
                                  }, 120);
                                }}
                              />
                              {hasTypedValue && typedValue.trim().length > 0 && suggestions.length > 0 && (
                                <div className="max-h-40 overflow-auto rounded-md border border-slate-200 bg-white shadow-sm">
                                  {suggestions.map((customer) => (
                                    <button
                                      key={`rel-suggestion-${index}-${customer.id}`}
                                      type="button"
                                      onMouseDown={(e) => {
                                        e.preventDefault();
                                        updateFichaRelacionada(index, 'customerId', customer.id);
                                        setFichasSearchTerms((prev) => {
                                          const next = { ...prev };
                                          delete next[index];
                                          return next;
                                        });
                                      }}
                                      className="w-full text-left px-2 py-1.5 text-xs hover:bg-slate-100"
                                    >
                                      {buildRelationCustomerLabel(customer)}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {resolved && (
                                <button
                                  type="button"
                                  onClick={() => openRelatedCustomerProfile(resolved)}
                                  className="text-xs text-blue-700 hover:underline"
                                >
                                  {buildRelationCustomerLabel(resolved)}
                                </button>
                              )}
                            </div>
                            <select
                              className="md:col-span-2 text-sm border rounded-md p-2 bg-white"
                              value={entry.relationType || 'outro'}
                              onChange={(e) => updateFichaRelacionada(index, 'relationType', e.target.value)}
                            >
                              {RELATED_RECORD_OPTIONS.map((option) => (
                                <option key={`rel-type-${option.value}`} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                            <input
                              type="text"
                              placeholder="Nota (opcional)"
                              className="md:col-span-4 text-sm border rounded-md p-2"
                              value={entry.note || ''}
                              onChange={(e) => updateFichaRelacionada(index, 'note', e.target.value)}
                            />
                            <button
                              type="button"
                              onClick={() => removeFichaRelacionada(index)}
                              className="md:col-span-1 text-red-600 text-xs hover:underline justify-self-start md:justify-self-end"
                            >
                              Remover
                            </button>
                          </div>
                        );
                      })}
                      {formData.fichasRelacionadas.length === 0 && <p className="text-xs text-gray-400 italic">Sem fichas relacionadas definidas.</p>}
                      <button
                        type="button"
                        onClick={addFichaRelacionada}
                        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center gap-1"
                      >
                        <Plus size={14} /> Adicionar linha
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'atividade' && (
                <div className="space-y-4">
                  {!editingCustomer?.id ? (
                    <p className="text-sm text-gray-500">Guarde primeiro o cliente para consultar tarefas e ocorrências.</p>
                  ) : (
                    <>
                      <div className="rounded-lg border border-slate-200 bg-white p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-sm font-semibold text-slate-800">Histórico operacional do cliente</div>
                            <div className="text-xs text-slate-500">Inclui abertas e fechadas.</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void loadCustomerActivity(editingCustomer.id)}
                            disabled={customerActivityLoading}
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          >
                            <RefreshCw size={13} />
                            {customerActivityLoading ? 'A atualizar...' : 'Atualizar'}
                          </button>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                          <div className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs text-blue-700">
                            Tarefas abertas: <span className="font-semibold">{taskOpenCount}</span>
                          </div>
                          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700">
                            Tarefas fechadas: <span className="font-semibold">{taskClosedCount}</span>
                          </div>
                          <div className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs text-blue-700">
                            Ocorrências abertas: <span className="font-semibold">{occurrenceOpenCount}</span>
                          </div>
                          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700">
                            Ocorrências fechadas: <span className="font-semibold">{occurrenceClosedCount}</span>
                          </div>
                        </div>
                      </div>

                      {customerActivityError && (
                        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                          {customerActivityError}
                        </div>
                      )}

                      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        <section className="rounded-lg border border-slate-200 bg-white p-3">
                          <h3 className="text-sm font-semibold text-slate-800">Tarefas ({customerTasksSummary.length})</h3>
                          <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
                            {!customerActivityLoading && customerTasksSummary.length === 0 && (
                              <p className="text-xs text-slate-500">Sem tarefas para este cliente.</p>
                            )}
                            {customerTasksSummary.map((task) => (
                              <button
                                key={`task-${task.id}`}
                                type="button"
                                onClick={() => {
                                  const taskId = String(task.id || '').trim();
                                  if (!taskId) return;
                                  setShowModal(false);
                                  navigate(`/tasks?taskId=${encodeURIComponent(taskId)}`);
                                }}
                                className="w-full rounded-md border border-slate-200 bg-slate-50 p-2 text-left hover:border-blue-200 hover:bg-blue-50/40"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold text-slate-800" title={task.title}>{task.title}</div>
                                    <div className="mt-0.5 text-xs text-slate-600">
                                      Prazo: {formatDateOnly(task.dueDate)} • Resp: {task.assignedUserName}
                                    </div>
                                  </div>
                                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getTaskStatusBadgeClass(task.status)}`}>
                                    {formatTaskStatus(task.status)}
                                  </span>
                                </div>
                              </button>
                            ))}
                          </div>
                        </section>

                        <section className="rounded-lg border border-slate-200 bg-white p-3">
                          <h3 className="text-sm font-semibold text-slate-800">Ocorrências ({customerOccurrencesSummary.length})</h3>
                          <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
                            {!customerActivityLoading && customerOccurrencesSummary.length === 0 && (
                              <p className="text-xs text-slate-500">Sem ocorrências para este cliente.</p>
                            )}
                            {customerOccurrencesSummary.map((occurrence) => (
                              <button
                                key={`occ-${occurrence.id}`}
                                type="button"
                                onClick={() => {
                                  const occurrenceId = String(occurrence.id || '').trim();
                                  if (!occurrenceId) return;
                                  setShowModal(false);
                                  navigate(`/occurrences?occurrenceId=${encodeURIComponent(occurrenceId)}`);
                                }}
                                className="w-full rounded-md border border-slate-200 bg-slate-50 p-2 text-left hover:border-blue-200 hover:bg-blue-50/40"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold text-slate-800" title={occurrence.title}>{occurrence.title}</div>
                                    <div className="mt-0.5 text-xs text-slate-600">
                                      Tipo: {occurrence.typeName} • Data: {formatDateOnly(occurrence.date)} • Prazo: {formatDateOnly(occurrence.dueDate)}
                                    </div>
                                    <div className="mt-0.5 text-xs text-slate-600">Resp: {occurrence.responsibleNames}</div>
                                  </div>
                                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getOccurrenceStatusBadgeClass(occurrence.state)}`}>
                                    {formatOccurrenceStatus(occurrence.state)}
                                  </span>
                                </div>
                              </button>
                            ))}
                          </div>
                        </section>
                      </div>
                    </>
                  )}
                </div>
              )}

              {activeTab === 'sociedade' && (
                <div className="border rounded-lg p-4 space-y-3">
                  {!editingCustomer?.id ? (
                    <p className="text-sm text-gray-500">Guarde primeiro o cliente para ativar os documentos da sociedade.</p>
                  ) : (
                    <>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                        <div className="text-sm font-semibold text-slate-800">Documentos da Sociedade</div>
                        <div className="text-xs text-slate-500">
                          Guarda nesta vista os documentos societários, sempre dentro de <span className="font-mono">{SOCIEDADE_BASE_PATH}</span>.
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {SOCIEDADE_DOCUMENT_CATEGORIES.map((category) => {
                            const isSelected = sociedadeCategoryKey === category.key;
                            return (
                              <button
                                key={category.key}
                                type="button"
                                onClick={() => {
                                  void openSociedadeCategory(category.key);
                                }}
                                className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition ${
                                  isSelected
                                    ? 'border-blue-200 bg-white text-blue-700 shadow-sm'
                                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                                }`}
                              >
                                {category.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-gray-800">Pasta da sociedade</div>
                          <div className="text-xs text-gray-500 break-all">{sociedadeDocsPath || formData.documentsFolder || 'Sem pasta definida na ficha do cliente.'}</div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => loadSociedadeDocuments(editingCustomer.id, sociedadeCurrentPath || SOCIEDADE_BASE_PATH)}
                            className="px-2 py-1 text-xs border rounded-md bg-white hover:bg-slate-50"
                            title="Atualizar"
                          >
                            <RefreshCw size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={goUpSociedadeFolder}
                            disabled={!sociedadeCanGoUp}
                            className="px-2 py-1 text-xs border rounded-md bg-white hover:bg-slate-50 disabled:opacity-40"
                            title="Subir pasta"
                          >
                            ..
                          </button>
                          <button
                            type="button"
                            onClick={triggerSociedadeDocumentPicker}
                            disabled={sociedadeUploadingDoc}
                            className="px-2 py-1 text-xs border rounded-md bg-whatsapp-50 text-whatsapp-700 hover:bg-whatsapp-100 disabled:opacity-40 inline-flex items-center gap-1"
                            title="Adicionar ficheiro"
                          >
                            <Upload size={13} />
                            {sociedadeUploadingDoc ? 'A guardar...' : 'Adicionar'}
                          </button>
                        </div>
                      </div>

                      <div className="text-xs text-gray-500">
                        Subpasta atual: <span className="font-mono">{sociedadeCurrentPath || SOCIEDADE_BASE_PATH}</span>
                        {!sociedadeDocsConfigured && (
                          <span className="ml-2 text-amber-600">Pasta automática ativa. Defina caminho específico na ficha para fixar.</span>
                        )}
                      </div>

                      {sociedadeDocsError && <div className="text-xs text-red-600">{sociedadeDocsError}</div>}

                      <div className="max-h-72 overflow-y-auto border rounded-md p-2 space-y-1 bg-slate-50">
                        {sociedadeDocsLoading && <div className="text-xs text-gray-500">A carregar documentos...</div>}
                        {!sociedadeDocsLoading && sociedadeDocs.length === 0 && <div className="text-xs text-gray-500">Sem ficheiros/subpastas neste local.</div>}

                        {!sociedadeDocsLoading && sociedadeDocs.map((entry) => (
                          <button
                            key={`sociedade-${entry.relativePath}:${entry.type}`}
                            type="button"
                            onClick={() => {
                              if (entry.type === 'directory') {
                                void openSociedadeFolder(entry.relativePath);
                                return;
                              }
                              downloadCustomerDocument(editingCustomer.id, entry.relativePath);
                            }}
                            className="w-full text-left border border-slate-200 rounded-md px-2 py-1.5 bg-white hover:bg-slate-100 flex items-center justify-between gap-2"
                          >
                            <span className="inline-flex items-center gap-2 min-w-0">
                              {entry.type === 'directory' ? <Folder size={14} className="text-amber-600 shrink-0" /> : <FileText size={14} className="text-blue-600 shrink-0" />}
                              <span className="truncate text-sm text-slate-800">{entry.name}</span>
                            </span>
                            <span className="text-[11px] text-slate-500 shrink-0">
                              {entry.type === 'directory' ? 'Pasta' : formatBytes(Number(entry.size || 0))}
                            </span>
                          </button>
                        ))}
                      </div>

                      <p className="text-xs text-gray-400">
                        Clique numa pasta para navegar e clique num ficheiro para descarregar.
                      </p>

                      <input
                        ref={sociedadeFileInputRef}
                        type="file"
                        className="hidden"
                        onChange={handleSociedadeDocumentUpload}
                      />
                    </>
                  )}
                </div>
              )}

              {activeTab === 'documentos' && (
                <div className="border rounded-lg p-4 space-y-3">
                  {!editingCustomer?.id ? (
                    <p className="text-sm text-gray-500">Guarde primeiro o cliente para ativar a gestão de documentos da pasta.</p>
                  ) : (
                    <>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div>
                            <div className="text-sm font-semibold text-slate-800">Inserir documentos (IA)</div>
                            <div className="text-xs text-slate-500">
                              Extrai dados automaticamente e guarda em <span className="font-mono">Documentos Oficiais</span>.
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <select
                              value={ingestDocumentType}
                              onChange={(e) => setIngestDocumentType(e.target.value as CustomerIngestDocumentType)}
                              className="text-xs border border-slate-300 rounded-md px-2 py-1.5 bg-white"
                            >
                              {CUSTOMER_INGEST_TYPES.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={triggerIngestPicker}
                              disabled={ingestLoading}
                              className="px-2 py-1.5 text-xs border rounded-md bg-white hover:bg-slate-100 disabled:opacity-50"
                            >
                              Inserir documento
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                void runDocumentIngest();
                              }}
                              disabled={ingestLoading}
                              className="px-2 py-1.5 text-xs rounded-md bg-whatsapp-600 text-white hover:bg-whatsapp-700 disabled:opacity-50"
                            >
                              {ingestLoading ? 'A analisar...' : 'Analisar + Guardar'}
                            </button>
                          </div>
                        </div>
                        <div className="text-xs text-slate-600">
                          Ficheiro: {ingestSelectedFile ? <span className="font-medium">{ingestSelectedFile.name}</span> : 'Nenhum ficheiro selecionado.'}
                        </div>
                        {ingestStatus && (
                          <div className="text-xs text-slate-700 rounded-md border border-slate-200 bg-white px-2 py-1.5">
                            {ingestStatus}
                          </div>
                        )}
                        {ingestWarnings.length > 0 && (
                          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 space-y-1">
                            {ingestWarnings.map((warning, index) => (
                              <div key={`ingest-warning-${index}`}>- {warning}</div>
                            ))}
                          </div>
                        )}
                        <input
                          ref={ingestFileInputRef}
                          type="file"
                          className="hidden"
                          onChange={handleIngestFileSelection}
                        />
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-gray-800">Documentos da pasta do cliente</div>
                          <div className="text-xs text-gray-500 break-all">{modalDocsPath || formData.documentsFolder || 'Sem pasta definida na ficha do cliente.'}</div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => loadModalDocuments(editingCustomer.id, modalDocsCurrentPath)}
                            className="px-2 py-1 text-xs border rounded-md bg-white hover:bg-slate-50"
                            title="Atualizar"
                          >
                            <RefreshCw size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={goUpModalDocumentsFolder}
                            disabled={!modalCanGoUp}
                            className="px-2 py-1 text-xs border rounded-md bg-white hover:bg-slate-50 disabled:opacity-40"
                            title="Subir pasta"
                          >
                            ..
                          </button>
                          <button
                            type="button"
                            onClick={triggerModalDocumentPicker}
                            disabled={modalUploadingDoc}
                            className="px-2 py-1 text-xs border rounded-md bg-whatsapp-50 text-whatsapp-700 hover:bg-whatsapp-100 disabled:opacity-40 inline-flex items-center gap-1"
                            title="Adicionar ficheiro"
                          >
                            <Upload size={13} />
                            {modalUploadingDoc ? 'A guardar...' : 'Adicionar'}
                          </button>
                        </div>
                      </div>

                      <div className="text-xs text-gray-500">
                        Subpasta atual: <span className="font-mono">{modalDocsCurrentPath || '/'}</span>
                        {!modalDocsConfigured && (
                          <span className="ml-2 text-amber-600">Pasta automática ativa. Defina caminho específico na ficha para fixar.</span>
                        )}
                      </div>

                      {modalDocsError && <div className="text-xs text-red-600">{modalDocsError}</div>}

                      <div className="max-h-72 overflow-y-auto border rounded-md p-2 space-y-1 bg-slate-50">
                        {modalDocsLoading && <div className="text-xs text-gray-500">A carregar documentos...</div>}
                        {!modalDocsLoading && modalDocs.length === 0 && <div className="text-xs text-gray-500">Sem ficheiros/subpastas neste local.</div>}

                        {!modalDocsLoading && modalDocs.map((entry) => (
                          <button
                            key={`${entry.relativePath}:${entry.type}`}
                            type="button"
                            onClick={() => {
                              if (entry.type === 'directory') {
                                void openModalDocumentsFolder(entry.relativePath);
                                return;
                              }
                              downloadModalDocument(entry.relativePath);
                            }}
                            className="w-full text-left border border-slate-200 rounded-md px-2 py-1.5 bg-white hover:bg-slate-100 flex items-center justify-between gap-2"
                          >
                            <span className="inline-flex items-center gap-2 min-w-0">
                              {entry.type === 'directory' ? <Folder size={14} className="text-amber-600 shrink-0" /> : <FileText size={14} className="text-blue-600 shrink-0" />}
                              <span className="truncate text-sm text-slate-800">{entry.name}</span>
                            </span>
                            <span className="text-[11px] text-slate-500 shrink-0">
                              {entry.type === 'directory' ? 'Pasta' : formatBytes(Number(entry.size || 0))}
                            </span>
                          </button>
                        ))}
                      </div>

                      <p className="text-xs text-gray-400">
                        Clique numa pasta para navegar e clique num ficheiro para descarregar.
                      </p>

                      <input
                        ref={modalFileInputRef}
                        type="file"
                        className="hidden"
                        onChange={handleModalDocumentUpload}
                      />
                    </>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 mt-6 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancelar
                </button>
                <button type="submit" className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500">
                  Gravar
                </button>
              </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Customers;
