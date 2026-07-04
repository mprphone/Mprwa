import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Mail,
  MessageCircle,
  Paperclip,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Send,
  User,
  Users,
  X,
} from 'lucide-react';
import { mockService, CURRENT_USER_ID } from '../services/mockData';
import {
  ConversationStatus,
  TaskPriority,
  TaskStatus,
} from '../types';
import type {
  Conversation,
  Customer,
  Task,
  User as UserType,
} from '../types';
import {
  fetchInternalConversations,
  fetchInternalMessages,
  markInternalConversationAsRead,
  sendInternalMessage,
  InternalConversationRow,
  InternalMessageRow,
} from '../services/internalChatApi';
import {
  fetchOccurrenceById,
  fetchOccurrences,
  fetchOccurrencesMeta,
  saveOccurrence,
  OccurrenceMetaPayload,
  OccurrenceRow,
} from '../services/occurrencesApi';

type MobileTab = 'chat' | 'tasks' | 'occurrences' | 'customers';
type TaskFilter = 'open' | 'today' | 'overdue' | 'all';
type OccurrenceFilter = 'open' | 'late' | 'all';

type EnrichedTask = Task & {
  customer?: Customer | null;
  customerName?: string;
  assignedUserName?: string;
};

type CustomerDocumentEntry = {
  type: 'file' | 'directory';
  name: string;
  relativePath: string;
  size?: number;
  updatedAt: string;
};

type CustomerDocumentsState = {
  customer: Customer | null;
  folderPath: string;
  storageFolderPath: string;
  configured: boolean;
  currentRelativePath: string;
  canGoUp: boolean;
  entries: CustomerDocumentEntry[];
  loading: boolean;
  error: string;
};

type FiscalFiling = {
  ano?: string;
  situacao?: string;
  dataRecepcao?: string;
  comprovativoPath?: string;
};

type FiscalCertidao = {
  tipo?: string;
  dataValidade?: string;
  valida?: boolean;
  ficheiroPdf?: string;
};

type FiscalDocumento = {
  tipo?: string;
  label?: string;
  dataValidade?: string;
  valida?: boolean;
  ficheiroPdf?: string;
  notas?: string;
};

type FiscalDivida = {
  entidade?: 'at' | 'ss' | string;
  montante?: number;
  semDivida?: boolean;
};

type MobileFiscalSummary = {
  ies: FiscalFiling[];
  modelo22: FiscalFiling[];
  certidoes: FiscalCertidao[];
  documentos: FiscalDocumento[];
  dividas: FiscalDivida[];
  updatedAt?: string;
};

const MOBILE_TABS: Array<{ id: MobileTab; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = [
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'tasks', label: 'Tarefas', icon: CheckCircle2 },
  { id: 'occurrences', label: 'Ocorr.', icon: ClipboardList },
  { id: 'customers', label: 'Clientes', icon: Users },
];

function normalizeSearch(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function formatDate(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '--';
  const parsed = new Date(raw.includes('T') ? raw : `${raw}T00:00:00`);
  if (!Number.isFinite(parsed.getTime())) return raw;
  return parsed.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatTime(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return '';
  return parsed.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '--';
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return raw;
  return parsed.toLocaleString('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatCurrency(value: number | null | undefined): string {
  const amount = Number(value || 0);
  return amount.toLocaleString('pt-PT', { style: 'currency', currency: 'EUR' });
}

function formatFileSize(value: number | null | undefined): string {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function customerLabel(customer: Customer | null | undefined): string {
  if (!customer) return 'Sem cliente';
  const company = String(customer.company || '').trim();
  const name = String(customer.name || '').trim();
  if (company && name && company.toLowerCase() !== name.toLowerCase()) return `${company} - ${name}`;
  return company || name || 'Sem nome';
}

function customerSearchText(customer: Customer): string {
  return [
    customer.name,
    customer.company,
    customer.contactName,
    customer.nif,
    customer.niss,
    customer.phone,
    customer.email,
    customer.morada,
  ]
    .filter(Boolean)
    .join(' ');
}

function normalizeLooseKey(value: string): string {
  return String(value || '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function pickCustomerPayloadValue(customer: Customer, keys: string[]): string {
  const payload = (customer as Customer & { supabasePayload?: Record<string, unknown> }).supabasePayload;
  if (!payload || typeof payload !== 'object') return '';
  const lookup = new Map<string, unknown>();
  Object.entries(payload).forEach(([key, value]) => lookup.set(normalizeLooseKey(key), value));
  for (const key of keys) {
    const value = lookup.get(normalizeLooseKey(key));
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? 'Sim' : 'Nao';
  }
  return '';
}

function displayCustomerType(customer: Customer): string {
  const rawType = String(customer.type || '').trim();
  const normalizedType = normalizeSearch(rawType);
  const importedType = normalizeSearch(pickCustomerPayloadValue(customer, ['tipo_entidade', 'tipo', 'type', 'categoria']));
  const nif = String(customer.nif || '').replace(/\D+/g, '');
  const companyText = normalizeSearch(`${customer.company || ''} ${customer.name || ''}`).replace(/[^a-z0-9]+/g, ' ');
  const hasCorporateNumber = /^[569]/.test(nif);
  const hasCorporateName = /\b(lda|limitada|unipessoal|sa|s a|sgps|sociedade|sucursal|associacao|fundacao|cooperativa)\b/.test(companyText);
  const hasCorporateFields = Boolean(
    customer.dataConstituicao ||
    customer.certidaoPermanenteNumero ||
    customer.certidaoPermanenteValidade ||
    customer.rcbeNumero ||
    customer.rcbeData
  );

  if (importedType.includes('empresa') || importedType.includes('coletiv') || importedType.includes('colectiv') || importedType.includes('nipc')) return 'Empresa';
  if (hasCorporateNumber || hasCorporateName || hasCorporateFields) return 'Empresa';
  if (normalizedType.includes('empresa')) return 'Empresa';
  if (normalizedType.includes('independente')) return 'Independente';
  if (normalizedType.includes('assoc')) return 'Associacao';
  if (normalizedType.includes('fornecedor')) return 'Fornecedor';
  if (normalizedType.includes('particular')) return 'Particular';
  if (importedType.includes('particular')) return 'Particular';
  return rawType || '--';
}

function createEmptyDocumentsState(customer: Customer | null = null): CustomerDocumentsState {
  return {
    customer,
    folderPath: '',
    storageFolderPath: '',
    configured: false,
    currentRelativePath: '',
    canGoUp: false,
    entries: [],
    loading: false,
    error: '',
  };
}

function normalizeFiscalSummary(raw: unknown): MobileFiscalSummary {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Partial<MobileFiscalSummary>;
  return {
    ies: Array.isArray(data.ies) ? data.ies : [],
    modelo22: Array.isArray(data.modelo22) ? data.modelo22 : [],
    certidoes: Array.isArray(data.certidoes) ? data.certidoes : [],
    documentos: Array.isArray(data.documentos) ? data.documentos : [],
    dividas: Array.isArray(data.dividas) ? data.dividas : [],
    updatedAt: String(data.updatedAt || '').trim() || undefined,
  };
}

function hasFiscalSummaryData(summary: MobileFiscalSummary | null | undefined): boolean {
  if (!summary) return false;
  return summary.ies.length > 0 || summary.modelo22.length > 0 || summary.certidoes.length > 0 || summary.documentos.length > 0 || summary.dividas.length > 0;
}

function parentDocumentPath(relativePath: string): string {
  const parts = String(relativePath || '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function fiscalFileUrl(customer: Customer, filePath: string | null | undefined): string {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/api/')) return raw;
  if (raw.includes('..') || raw.includes('\0')) return '';
  const params = new URLSearchParams({ path: raw });
  const nif = String((customer as any).nif || '').replace(/\D+/g, '').slice(-9);
  if (nif) params.set('nif', nif);
  return `/api/customers/${encodeURIComponent(customer.id)}/fiscal-summary/file?${params.toString()}`;
}

function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Nao';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(formatDetailValue).filter(Boolean).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function humanizeDetailKey(value: string): string {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());
}

// Achata a estrutura aninhada do "projeto de apoio" (candidatura/acompanhamento/…)
// em linhas legíveis "Secção · Campo: valor", em vez de despejar JSON em bruto.
function flattenApoioEntries(value: unknown, prefix = ''): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      if (item && typeof item === 'object') {
        const line = Object.values(item as Record<string, unknown>).map(formatDetailValue).filter(Boolean).join(' — ');
        if (line) out.push({ label: `${prefix || 'Item'} ${idx + 1}`, value: line });
      } else {
        const s = formatDetailValue(item);
        if (s) out.push({ label: `${prefix || 'Item'} ${idx + 1}`, value: s });
      }
    });
    return out;
  }
  if (typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([k, v]) => {
      const fullLabel = prefix ? `${prefix} · ${humanizeDetailKey(k)}` : humanizeDetailKey(k);
      if (v && typeof v === 'object') {
        out.push(...flattenApoioEntries(v, fullLabel));
      } else {
        const s = formatDetailValue(v);
        if (s) out.push({ label: fullLabel, value: s });
      }
    });
    return out;
  }
  const s = formatDetailValue(value);
  if (s) out.push({ label: prefix || 'Valor', value: s });
  return out;
}

function taskStatusLabel(status: TaskStatus | string): string {
  if (status === TaskStatus.DONE) return 'Concluida';
  if (status === TaskStatus.IN_PROGRESS) return 'Em progresso';
  if (status === TaskStatus.WAITING) return 'A aguardar';
  return 'Pendente';
}

function taskStatusClass(status: TaskStatus | string): string {
  if (status === TaskStatus.DONE) return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  if (status === TaskStatus.IN_PROGRESS) return 'bg-sky-100 text-sky-800 border-sky-200';
  if (status === TaskStatus.WAITING) return 'bg-amber-100 text-amber-800 border-amber-200';
  return 'bg-orange-100 text-orange-800 border-orange-200';
}

function occurrenceStateClass(state: string): string {
  const normalized = normalizeSearch(state);
  if (normalized.includes('resol')) return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  if (normalized.includes('atras')) return 'bg-rose-100 text-rose-800 border-rose-200';
  return 'bg-blue-100 text-blue-800 border-blue-200';
}

function tabFromPath(pathname: string): MobileTab {
  const clean = String(pathname || '').replace(/^\/+/, '');
  const parts = clean.split('/');
  const candidate = parts[1] || parts[0];
  if (candidate === 'tasks') return 'tasks';
  if (candidate === 'occurrences') return 'occurrences';
  if (candidate === 'customers') return 'customers';
  return 'chat';
}

const MobileWorkspace: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = tabFromPath(location.pathname);
  const currentUser = mockService.getCurrentUser();
  const currentUserId = String(mockService.getCurrentUserId() || CURRENT_USER_ID || '').trim();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [users, setUsers] = useState<UserType[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [tasks, setTasks] = useState<EnrichedTask[]>([]);
  const [occurrenceMeta, setOccurrenceMeta] = useState<OccurrenceMetaPayload>({ types: [], users: [], customers: [] });
  const [occurrences, setOccurrences] = useState<OccurrenceRow[]>([]);
  const [internalConversations, setInternalConversations] = useState<InternalConversationRow[]>([]);
  const [messages, setMessages] = useState<InternalMessageRow[]>([]);

  const [chatSearch, setChatSearch] = useState('');
  const [selectedInternalConversationId, setSelectedInternalConversationId] = useState('');
  const [messageText, setMessageText] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [taskSearch, setTaskSearch] = useState('');
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('open');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [taskSheetOpen, setTaskSheetOpen] = useState(false);
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskForm, setTaskForm] = useState({
    title: '',
    customerId: '',
    customerQuery: '',
    priority: TaskPriority.NORMAL,
    dueDate: addDaysIso(1),
    notes: '',
  });

  const [occurrenceSearch, setOccurrenceSearch] = useState('');
  const [occurrenceFilter, setOccurrenceFilter] = useState<OccurrenceFilter>('open');
  const [selectedOccurrenceId, setSelectedOccurrenceId] = useState('');
  const [occurrenceSheetOpen, setOccurrenceSheetOpen] = useState(false);
  const [occurrenceSaving, setOccurrenceSaving] = useState(false);
  const [occurrenceForm, setOccurrenceForm] = useState({
    title: '',
    customerId: '',
    customerQuery: '',
    typeId: '',
    dueDate: addDaysIso(2),
    description: '',
  });

  const [customerSearch, setCustomerSearch] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [fiscalSummaryByCustomerId, setFiscalSummaryByCustomerId] = useState<Record<string, MobileFiscalSummary | null>>({});
  const [fiscalErrorsByCustomerId, setFiscalErrorsByCustomerId] = useState<Record<string, string>>({});
  const [fiscalLoadingCustomerId, setFiscalLoadingCustomerId] = useState('');
  const [documentsState, setDocumentsState] = useState<CustomerDocumentsState>(() => createEmptyDocumentsState());
  const [occurrenceDetailsById, setOccurrenceDetailsById] = useState<Record<string, OccurrenceRow>>({});
  const [occurrenceDetailLoadingId, setOccurrenceDetailLoadingId] = useState('');

  const customerById = useMemo(() => new Map(customers.map((customer) => [customer.id, customer])), [customers]);
  const userById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
  const conversationById = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations]
  );

  const selectedInternalConversation = useMemo(
    () => internalConversations.find((conversation) => conversation.id === selectedInternalConversationId) || null,
    [internalConversations, selectedInternalConversationId]
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) || null,
    [tasks, selectedTaskId]
  );
  const selectedOccurrence = useMemo(
    () => occurrenceDetailsById[selectedOccurrenceId] || occurrences.find((occurrence) => occurrence.id === selectedOccurrenceId) || null,
    [occurrenceDetailsById, occurrences, selectedOccurrenceId]
  );
  const selectedCustomer = useMemo(
    () => customers.find((customer) => customer.id === selectedCustomerId) || null,
    [customers, selectedCustomerId]
  );

  const enrichTasks = useCallback(
    (rawTasks: Task[], rawConversations: Conversation[], rawCustomers: Customer[], rawUsers: UserType[]): EnrichedTask[] => {
      const convById = new Map(rawConversations.map((conversation) => [conversation.id, conversation]));
      const custById = new Map(rawCustomers.map((customer) => [customer.id, customer]));
      const usrById = new Map(rawUsers.map((user) => [user.id, user]));
      return rawTasks.map((task) => {
        const conversation = convById.get(task.conversationId);
        const customer = conversation?.customerId ? custById.get(conversation.customerId) || null : null;
        const assignedUser = usrById.get(task.assignedUserId);
        return {
          ...task,
          customer,
          customerName: customerLabel(customer),
          assignedUserName: assignedUser?.name || '',
        };
      });
    },
    []
  );

  const loadAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setRefreshing(true);
    setError('');
    try {
      const [
        loadedCustomers,
        loadedUsers,
        loadedConversations,
        loadedTasks,
        loadedOccurrenceMeta,
        loadedOccurrences,
        loadedInternalConversations,
      ] = await Promise.all([
        mockService.getCustomers(),
        mockService.getUsers(),
        mockService.getConversations(),
        mockService.getTasks(),
        fetchOccurrencesMeta().catch(() => ({ types: [], users: [], customers: [] } as OccurrenceMetaPayload)),
        fetchOccurrences({ limit: 600 }).catch(() => [] as OccurrenceRow[]),
        currentUserId ? fetchInternalConversations(currentUserId).catch(() => [] as InternalConversationRow[]) : Promise.resolve([]),
      ]);

      setCustomers(loadedCustomers);
      setUsers(loadedUsers);
      setConversations(loadedConversations);
      setTasks(enrichTasks(loadedTasks, loadedConversations, loadedCustomers, loadedUsers));
      setOccurrenceMeta(loadedOccurrenceMeta);
      setOccurrences(loadedOccurrences);
      setInternalConversations(loadedInternalConversations);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar dados mobile.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentUserId, enrichTasks]);

  const loadInternalMessages = useCallback(async (conversationId: string) => {
    if (!conversationId || !currentUserId) {
      setMessages([]);
      return;
    }
    try {
      const loadedMessages = await fetchInternalMessages({ conversationId, userId: currentUserId, limit: 180 });
      setMessages(loadedMessages);
      await markInternalConversationAsRead(conversationId, currentUserId).catch(() => null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar mensagens.');
    }
  }, [currentUserId]);

  const loadFiscalSummary = useCallback(async (customerId: string) => {
    const id = String(customerId || '').trim();
    if (!id) return;
    setFiscalLoadingCustomerId(id);
    setFiscalErrorsByCustomerId((prev) => ({ ...prev, [id]: '' }));
    try {
      const response = await fetch(`/api/customers/${encodeURIComponent(id)}/fiscal-summary?_=${Date.now()}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({})) as { success?: boolean; data?: unknown; error?: unknown };
      if (!response.ok || !payload.success) {
        const message = typeof payload.error === 'string' ? payload.error : `Falha ao carregar resumo fiscal (${response.status}).`;
        throw new Error(message);
      }
      setFiscalSummaryByCustomerId((prev) => ({ ...prev, [id]: normalizeFiscalSummary(payload.data) }));
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Falha ao carregar resumo fiscal.';
      setFiscalSummaryByCustomerId((prev) => ({ ...prev, [id]: null }));
      setFiscalErrorsByCustomerId((prev) => ({ ...prev, [id]: message }));
    } finally {
      setFiscalLoadingCustomerId((current) => (current === id ? '' : current));
    }
  }, []);

  const openOccurrenceDetail = useCallback(async (occurrenceId: string) => {
    const id = String(occurrenceId || '').trim();
    if (!id) return;
    setSelectedOccurrenceId(id);
    setOccurrenceDetailLoadingId(id);
    try {
      const detail = await fetchOccurrenceById(id);
      setOccurrenceDetailsById((prev) => ({ ...prev, [id]: detail }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar detalhe da ocorrencia.');
    } finally {
      setOccurrenceDetailLoadingId((current) => (current === id ? '' : current));
    }
  }, []);

  const openCustomerDocuments = useCallback(async (customer: Customer, relativePath = '') => {
    setDocumentsState((prev) => ({
      ...prev,
      customer,
      loading: true,
      error: '',
      currentRelativePath: relativePath,
    }));
    try {
      const documents = await mockService.getCustomerDocumentsAtPath(customer.id, relativePath);
      setDocumentsState({
        customer,
        folderPath: documents.folderPath,
        storageFolderPath: documents.storageFolderPath,
        configured: documents.configured,
        currentRelativePath: documents.currentRelativePath,
        canGoUp: documents.canGoUp,
        entries: documents.entries,
        loading: false,
        error: '',
      });
    } catch (loadError) {
      setDocumentsState((prev) => ({
        ...prev,
        customer,
        loading: false,
        error: loadError instanceof Error ? loadError.message : 'Falha ao abrir pasta do cliente.',
      }));
    }
  }, []);

  const openDocumentFile = useCallback((entry: CustomerDocumentEntry) => {
    const customer = documentsState.customer;
    if (!customer || !entry.relativePath) return;
    const query = new URLSearchParams({ path: entry.relativePath });
    window.open(`/api/customers/${encodeURIComponent(customer.id)}/documents/download?${query.toString()}`, '_blank', 'noopener,noreferrer');
  }, [documentsState.customer]);

  useEffect(() => {
    if (location.pathname === '/mobile' || location.pathname === '/mobile/') {
      navigate('/mobile/chat', { replace: true });
    }
  }, [location.pathname, navigate]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!selectedInternalConversationId) return;
    void loadInternalMessages(selectedInternalConversationId);
  }, [selectedInternalConversationId, loadInternalMessages]);

  useEffect(() => {
    if (!selectedCustomerId) return;
    if (fiscalSummaryByCustomerId[selectedCustomerId] !== undefined || fiscalLoadingCustomerId === selectedCustomerId) return;
    void loadFiscalSummary(selectedCustomerId);
  }, [fiscalLoadingCustomerId, fiscalSummaryByCustomerId, loadFiscalSummary, selectedCustomerId]);

  useEffect(() => {
    if (activeTab !== 'chat') return;
    const interval = window.setInterval(() => {
      if (currentUserId) {
        fetchInternalConversations(currentUserId).then(setInternalConversations).catch(() => null);
      }
      if (selectedInternalConversationId) {
        void loadInternalMessages(selectedInternalConversationId);
      }
    }, 5000);
    return () => window.clearInterval(interval);
  }, [activeTab, currentUserId, loadInternalMessages, selectedInternalConversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, selectedInternalConversationId]);

  const filteredInternalConversations = useMemo(() => {
    const term = normalizeSearch(chatSearch);
    return internalConversations
      .filter((conversation) => {
        if (!term) return true;
        return normalizeSearch(`${conversation.title} ${conversation.otherUserName || ''} ${conversation.lastMessageBody || ''}`).includes(term);
      })
      .sort((a, b) => String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || '')));
  }, [chatSearch, internalConversations]);

  const filteredTasks = useMemo(() => {
    const term = normalizeSearch(taskSearch);
    const today = todayIso();
    return tasks
      .filter((task) => {
        const due = String(task.dueDate || '').slice(0, 10);
        if (taskFilter === 'open' && task.status === TaskStatus.DONE) return false;
        if (taskFilter === 'today' && due !== today) return false;
        if (taskFilter === 'overdue' && !(due && due < today && task.status !== TaskStatus.DONE)) return false;
        if (!term) return true;
        return normalizeSearch(`${task.title} ${task.customerName || ''} ${task.notes || ''} ${task.assignedUserName || ''}`).includes(term);
      })
      .sort((a, b) => {
        if (a.priority === TaskPriority.URGENT && b.priority !== TaskPriority.URGENT) return -1;
        if (b.priority === TaskPriority.URGENT && a.priority !== TaskPriority.URGENT) return 1;
        return String(a.dueDate || '').localeCompare(String(b.dueDate || ''));
      });
  }, [taskFilter, taskSearch, tasks]);

  const filteredOccurrences = useMemo(() => {
    const term = normalizeSearch(occurrenceSearch);
    return occurrences
      .filter((occurrence) => {
        const state = normalizeSearch(occurrence.state);
        if (occurrenceFilter === 'open' && state.includes('resol')) return false;
        if (occurrenceFilter === 'late' && !state.includes('atras')) return false;
        if (!term) return true;
        return normalizeSearch(
          `${occurrence.title} ${occurrence.customerCompany || ''} ${occurrence.customerName || ''} ${occurrence.typeName || ''} ${occurrence.description || ''}`
        ).includes(term);
      })
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }, [occurrenceFilter, occurrenceSearch, occurrences]);

  const filteredCustomers = useMemo(() => {
    const term = normalizeSearch(customerSearch);
    return customers
      .filter((customer) => !term || normalizeSearch(customerSearchText(customer)).includes(term))
      .sort((a, b) => customerLabel(a).localeCompare(customerLabel(b), 'pt-PT'))
      .slice(0, 200);
  }, [customerSearch, customers]);

  const taskCustomerMatches = useMemo(() => {
    const term = normalizeSearch(taskForm.customerQuery);
    const list = customers.filter((customer) => !term || normalizeSearch(customerSearchText(customer)).includes(term));
    return list.sort((a, b) => customerLabel(a).localeCompare(customerLabel(b), 'pt-PT')).slice(0, 8);
  }, [customers, taskForm.customerQuery]);

  const occurrenceCustomerMatches = useMemo(() => {
    const term = normalizeSearch(occurrenceForm.customerQuery);
    const list = customers.filter((customer) => !term || normalizeSearch(customerSearchText(customer)).includes(term));
    return list.sort((a, b) => customerLabel(a).localeCompare(customerLabel(b), 'pt-PT')).slice(0, 8);
  }, [customers, occurrenceForm.customerQuery]);

  const openTaskSheet = (customer?: Customer | null) => {
    setTaskForm({
      title: '',
      customerId: customer?.id || '',
      customerQuery: customer ? customerLabel(customer) : '',
      priority: TaskPriority.NORMAL,
      dueDate: addDaysIso(1),
      notes: '',
    });
    setTaskSheetOpen(true);
  };

  const openOccurrenceSheet = (customer?: Customer | null) => {
    setOccurrenceForm({
      title: '',
      customerId: customer?.id || '',
      customerQuery: customer ? customerLabel(customer) : '',
      typeId: occurrenceMeta.types[0]?.id ? String(occurrenceMeta.types[0].id) : '',
      dueDate: addDaysIso(2),
      description: '',
    });
    setOccurrenceSheetOpen(true);
  };

  const saveMobileTask = async () => {
    const title = taskForm.title.trim();
    if (!title) {
      setError('Preenche o assunto da tarefa.');
      return;
    }
    if (!taskForm.customerId) {
      setError('Escolhe o cliente da tarefa.');
      return;
    }
    setTaskSaving(true);
    setError('');
    try {
      let targetConversation =
        conversations.find((conversation) => conversation.customerId === taskForm.customerId && conversation.status === ConversationStatus.OPEN) ||
        conversations.find((conversation) => conversation.customerId === taskForm.customerId);
      if (!targetConversation) {
        targetConversation = await mockService.createConversation(taskForm.customerId);
      }
      await mockService.createTask({
        conversationId: targetConversation.id,
        title,
        status: TaskStatus.OPEN,
        priority: taskForm.priority,
        dueDate: new Date(`${taskForm.dueDate || todayIso()}T09:00:00`).toISOString(),
        assignedUserId: currentUserId || CURRENT_USER_ID,
        notes: taskForm.notes.trim(),
        attachments: [],
      });
      setTaskSheetOpen(false);
      await loadAll(true);
      navigate('/mobile/tasks');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Falha ao guardar tarefa.');
    } finally {
      setTaskSaving(false);
    }
  };

  const toggleTaskStatus = async (task: EnrichedTask) => {
    const nextStatus = task.status === TaskStatus.DONE ? TaskStatus.OPEN : TaskStatus.DONE;
    await mockService.updateTaskStatus(task.id, nextStatus);
    await loadAll(true);
  };

  const saveMobileOccurrence = async () => {
    const title = occurrenceForm.title.trim();
    if (!title) {
      setError('Preenche o assunto da ocorrencia.');
      return;
    }
    if (!occurrenceForm.customerId) {
      setError('Escolhe o cliente da ocorrencia.');
      return;
    }
    setOccurrenceSaving(true);
    setError('');
    try {
      const typeId = occurrenceForm.typeId ? Number(occurrenceForm.typeId) : null;
      await saveOccurrence({
        customerId: occurrenceForm.customerId,
        date: todayIso(),
        dueDate: occurrenceForm.dueDate || undefined,
        typeId,
        typeName: typeId ? occurrenceMeta.types.find((type) => String(type.id) === String(typeId))?.name : undefined,
        title,
        description: occurrenceForm.description.trim(),
        state: 'ABERTA',
        responsibleUserIds: currentUserId ? [currentUserId] : [],
        actorUserId: currentUserId,
      });
      setOccurrenceSheetOpen(false);
      const loaded = await fetchOccurrences({ limit: 600 });
      setOccurrences(loaded);
      navigate('/mobile/occurrences');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Falha ao guardar ocorrencia.');
    } finally {
      setOccurrenceSaving(false);
    }
  };

  const markOccurrenceResolved = async (occurrence: OccurrenceRow) => {
    try {
      const detail = await fetchOccurrenceById(occurrence.id).catch(() => occurrence);
      const saved = await saveOccurrence({
        id: detail.id,
        customerId: detail.customerId,
        date: detail.date || todayIso(),
        dueDate: detail.dueDate || undefined,
        typeId: detail.typeId || undefined,
        typeName: detail.typeName || undefined,
        title: detail.title,
        description: detail.description || '',
        state: normalizeSearch(detail.state).includes('resol') ? 'ABERTA' : 'RESOLVIDA',
        responsibleUserIds: Array.isArray(detail.responsibleUserIds) ? detail.responsibleUserIds : [],
        resolution: detail.resolution || '',
        actorUserId: currentUserId,
      });
      setOccurrenceDetailsById((prev) => ({ ...prev, [saved.id]: saved }));
      const loaded = await fetchOccurrences({ limit: 600 });
      setOccurrences(loaded);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Falha ao atualizar ocorrencia.');
    }
  };

  const sendMessage = async () => {
    const body = messageText.trim();
    if (!body || !selectedInternalConversationId || !currentUserId || sendingMessage) return;
    setSendingMessage(true);
    setError('');
    try {
      await sendInternalMessage({
        conversationId: selectedInternalConversationId,
        userId: currentUserId,
        body,
        type: 'text',
      });
      setMessageText('');
      await loadInternalMessages(selectedInternalConversationId);
      const loadedConversations = await fetchInternalConversations(currentUserId);
      setInternalConversations(loadedConversations);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Falha ao enviar mensagem.');
    } finally {
      setSendingMessage(false);
    }
  };

  const copyText = async (value: string) => {
    const text = String(value || '').trim();
    if (!text) return;
    await navigator.clipboard?.writeText(text).catch(() => null);
  };

  const headerTitle =
    activeTab === 'chat' ? 'Chat interno' : activeTab === 'tasks' ? 'Tarefas' : activeTab === 'occurrences' ? 'Ocorrencias' : 'Clientes';

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-slate-100 text-slate-950">
      <header className="shrink-0 border-b border-slate-200 bg-white px-4 pb-3 pt-[calc(env(safe-area-inset-top)+10px)]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">WA PRO Mobile</p>
            <h1 className="truncate text-xl font-bold leading-tight text-slate-950">{headerTitle}</h1>
            <p className="truncate text-sm text-slate-500">{currentUser?.name || 'Utilizador'}</p>
          </div>
          <button
            type="button"
            onClick={() => void loadAll(true)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-slate-700 active:scale-95"
            title="Atualizar"
          >
            <RefreshCw size={19} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <p className="min-w-0 flex-1">{error}</p>
            <button type="button" onClick={() => setError('')} className="shrink-0 rounded p-1">
              <X size={14} />
            </button>
          </div>
        )}
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">A carregar...</div>
        ) : activeTab === 'chat' ? (
          selectedInternalConversation ? (
            <ChatDetail
              conversation={selectedInternalConversation}
              messages={messages}
              currentUserId={currentUserId}
              messageText={messageText}
              sending={sendingMessage}
              onBack={() => setSelectedInternalConversationId('')}
              onMessageTextChange={setMessageText}
              onSend={() => void sendMessage()}
              endRef={messagesEndRef}
            />
          ) : (
            <ListScreen
              searchValue={chatSearch}
              searchPlaceholder="Pesquisar conversa"
              onSearchChange={setChatSearch}
              rightAction={null}
            >
              {filteredInternalConversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => setSelectedInternalConversationId(conversation.id)}
                  className="w-full border-b border-slate-100 bg-white px-4 py-4 text-left active:bg-emerald-50"
                >
                  <div className="flex items-start gap-3">
                    <Avatar label={conversation.title || conversation.otherUserName || 'Chat'} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-base font-semibold text-slate-950">{conversation.title || 'Conversa interna'}</p>
                        <span className="shrink-0 text-xs text-slate-400">{formatTime(conversation.lastMessageAt)}</span>
                      </div>
                      <p className="mt-1 truncate text-sm text-slate-500">{conversation.lastMessageBody || 'Sem mensagens.'}</p>
                    </div>
                    {conversation.unreadCount > 0 && (
                      <span className="mt-1 rounded-full bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">
                        {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                      </span>
                    )}
                  </div>
                </button>
              ))}
              {filteredInternalConversations.length === 0 && <EmptyState label="Sem conversas." />}
            </ListScreen>
          )
        ) : activeTab === 'tasks' ? (
          selectedTask ? (
            <TaskDetail
              task={selectedTask}
              onBack={() => setSelectedTaskId('')}
              onToggle={() => void toggleTaskStatus(selectedTask)}
            />
          ) : (
            <ListScreen
              searchValue={taskSearch}
              searchPlaceholder="Pesquisar tarefas"
              onSearchChange={setTaskSearch}
              rightAction={<FloatingMiniButton label="Nova" onClick={() => openTaskSheet()} />}
            >
              <SegmentedControl<TaskFilter>
                value={taskFilter}
                options={[
                  { value: 'open', label: 'Abertas' },
                  { value: 'today', label: 'Hoje' },
                  { value: 'overdue', label: 'Atraso' },
                  { value: 'all', label: 'Todas' },
                ]}
                onChange={setTaskFilter}
              />
              <div className="space-y-3 px-4 pb-4 pt-3">
                {filteredTasks.map((task) => (
                  <TaskCard key={task.id} task={task} onClick={() => setSelectedTaskId(task.id)} onToggle={() => void toggleTaskStatus(task)} />
                ))}
                {filteredTasks.length === 0 && <EmptyState label="Sem tarefas neste filtro." />}
              </div>
            </ListScreen>
          )
        ) : activeTab === 'occurrences' ? (
          selectedOccurrence ? (
            <OccurrenceDetail
              occurrence={selectedOccurrence}
              loading={occurrenceDetailLoadingId === selectedOccurrence.id}
              onBack={() => setSelectedOccurrenceId('')}
              onToggleResolved={() => void markOccurrenceResolved(selectedOccurrence)}
            />
          ) : (
            <ListScreen
              searchValue={occurrenceSearch}
              searchPlaceholder="Pesquisar ocorrencias"
              onSearchChange={setOccurrenceSearch}
              rightAction={<FloatingMiniButton label="Nova" onClick={() => openOccurrenceSheet()} />}
            >
              <SegmentedControl<OccurrenceFilter>
                value={occurrenceFilter}
                options={[
                  { value: 'open', label: 'Abertas' },
                  { value: 'late', label: 'Atraso' },
                  { value: 'all', label: 'Todas' },
                ]}
                onChange={setOccurrenceFilter}
              />
              <div className="space-y-3 px-4 pb-4 pt-3">
                {filteredOccurrences.map((occurrence) => (
                  <OccurrenceCard key={occurrence.id} occurrence={occurrence} onClick={() => void openOccurrenceDetail(occurrence.id)} />
                ))}
                {filteredOccurrences.length === 0 && <EmptyState label="Sem ocorrencias neste filtro." />}
              </div>
            </ListScreen>
          )
        ) : selectedCustomer ? (
          <CustomerDetail
            customer={selectedCustomer}
            onBack={() => setSelectedCustomerId('')}
            onCopy={copyText}
            onNewTask={() => openTaskSheet(selectedCustomer)}
            onNewOccurrence={() => openOccurrenceSheet(selectedCustomer)}
            onOpenDocuments={() => void openCustomerDocuments(selectedCustomer)}
            fiscalSummary={fiscalSummaryByCustomerId[selectedCustomer.id]}
            fiscalLoading={fiscalLoadingCustomerId === selectedCustomer.id || fiscalSummaryByCustomerId[selectedCustomer.id] === undefined}
            fiscalError={fiscalErrorsByCustomerId[selectedCustomer.id] || ''}
            onReloadFiscal={() => void loadFiscalSummary(selectedCustomer.id)}
          />
        ) : (
          <ListScreen
            searchValue={customerSearch}
            searchPlaceholder="Nome, NIF, telefone"
            onSearchChange={setCustomerSearch}
            rightAction={null}
          >
            <div className="space-y-3 px-4 pb-4 pt-3">
              {filteredCustomers.map((customer) => (
                <CustomerCard key={customer.id} customer={customer} onClick={() => setSelectedCustomerId(customer.id)} />
              ))}
              {filteredCustomers.length === 0 && <EmptyState label="Sem clientes encontrados." />}
            </div>
          </ListScreen>
        )}
      </main>

      <nav className="shrink-0 border-t border-slate-200 bg-white px-2 pb-[calc(env(safe-area-inset-bottom)+6px)] pt-2">
        <div className="grid grid-cols-4 gap-1">
          {MOBILE_TABS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSelectedInternalConversationId('');
                  setSelectedTaskId('');
                  setSelectedOccurrenceId('');
                  setSelectedCustomerId('');
                  navigate(`/mobile/${item.id}`);
                }}
                className={`flex min-h-[54px] flex-col items-center justify-center gap-1 rounded-2xl text-xs font-semibold ${
                  isActive ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 active:bg-slate-100'
                }`}
              >
                <Icon size={21} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {taskSheetOpen && (
        <BottomSheet title="Nova tarefa" onClose={() => setTaskSheetOpen(false)}>
          <FormField label="Assunto">
            <input
              value={taskForm.title}
              onChange={(event) => setTaskForm((prev) => ({ ...prev, title: event.target.value }))}
              className="mobile-input"
              placeholder="Ex: Validar documentos"
            />
          </FormField>
          <CustomerPicker
            query={taskForm.customerQuery}
            selectedId={taskForm.customerId}
            matches={taskCustomerMatches}
            onQueryChange={(value) => setTaskForm((prev) => ({ ...prev, customerQuery: value, customerId: '' }))}
            onSelect={(customer) => setTaskForm((prev) => ({ ...prev, customerId: customer.id, customerQuery: customerLabel(customer) }))}
          />
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Prazo">
              <input
                type="date"
                value={taskForm.dueDate}
                onChange={(event) => setTaskForm((prev) => ({ ...prev, dueDate: event.target.value }))}
                className="mobile-input"
              />
            </FormField>
            <FormField label="Prioridade">
              <select
                value={taskForm.priority}
                onChange={(event) => setTaskForm((prev) => ({ ...prev, priority: event.target.value as TaskPriority }))}
                className="mobile-input"
              >
                <option value={TaskPriority.NORMAL}>Normal</option>
                <option value={TaskPriority.URGENT}>Urgente</option>
              </select>
            </FormField>
          </div>
          <FormField label="Notas">
            <textarea
              value={taskForm.notes}
              onChange={(event) => setTaskForm((prev) => ({ ...prev, notes: event.target.value }))}
              className="mobile-input min-h-[92px] resize-none"
              placeholder="Detalhes"
            />
          </FormField>
          <button
            type="button"
            disabled={taskSaving}
            onClick={() => void saveMobileTask()}
            className="mt-2 h-12 w-full rounded-2xl bg-emerald-600 text-base font-bold text-white disabled:opacity-60"
          >
            {taskSaving ? 'A guardar...' : 'Guardar tarefa'}
          </button>
        </BottomSheet>
      )}

      {occurrenceSheetOpen && (
        <BottomSheet title="Nova ocorrencia" onClose={() => setOccurrenceSheetOpen(false)}>
          <FormField label="Assunto">
            <input
              value={occurrenceForm.title}
              onChange={(event) => setOccurrenceForm((prev) => ({ ...prev, title: event.target.value }))}
              className="mobile-input"
              placeholder="Ex: Pedido de cliente"
            />
          </FormField>
          <CustomerPicker
            query={occurrenceForm.customerQuery}
            selectedId={occurrenceForm.customerId}
            matches={occurrenceCustomerMatches}
            onQueryChange={(value) => setOccurrenceForm((prev) => ({ ...prev, customerQuery: value, customerId: '' }))}
            onSelect={(customer) => setOccurrenceForm((prev) => ({ ...prev, customerId: customer.id, customerQuery: customerLabel(customer) }))}
          />
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Tipo">
              <select
                value={occurrenceForm.typeId}
                onChange={(event) => setOccurrenceForm((prev) => ({ ...prev, typeId: event.target.value }))}
                className="mobile-input"
              >
                <option value="">Sem tipo</option>
                {occurrenceMeta.types.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Prazo">
              <input
                type="date"
                value={occurrenceForm.dueDate}
                onChange={(event) => setOccurrenceForm((prev) => ({ ...prev, dueDate: event.target.value }))}
                className="mobile-input"
              />
            </FormField>
          </div>
          <FormField label="Descricao">
            <textarea
              value={occurrenceForm.description}
              onChange={(event) => setOccurrenceForm((prev) => ({ ...prev, description: event.target.value }))}
              className="mobile-input min-h-[112px] resize-none"
              placeholder="Detalhes"
            />
          </FormField>
          <button
            type="button"
            disabled={occurrenceSaving}
            onClick={() => void saveMobileOccurrence()}
            className="mt-2 h-12 w-full rounded-2xl bg-emerald-600 text-base font-bold text-white disabled:opacity-60"
          >
            {occurrenceSaving ? 'A guardar...' : 'Guardar ocorrencia'}
          </button>
        </BottomSheet>
      )}

      {documentsState.customer && (
        <CustomerDocumentsSheet
          state={documentsState}
          onClose={() => setDocumentsState(createEmptyDocumentsState())}
          onOpenPath={(relativePath) => {
            if (documentsState.customer) void openCustomerDocuments(documentsState.customer, relativePath);
          }}
          onOpenFile={openDocumentFile}
        />
      )}
    </div>
  );
};

function ListScreen({
  searchValue,
  searchPlaceholder,
  onSearchChange,
  rightAction,
  children,
}: {
  searchValue: string;
  searchPlaceholder: string;
  onSearchChange: (value: string) => void;
  rightAction: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <label className="relative min-w-0 flex-1">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={searchValue}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={searchPlaceholder}
              className="h-11 w-full rounded-2xl border border-slate-200 bg-slate-50 pl-10 pr-3 text-base outline-none focus:border-emerald-300 focus:bg-white"
            />
          </label>
          {rightAction}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

function ChatDetail({
  conversation,
  messages,
  currentUserId,
  messageText,
  sending,
  onBack,
  onMessageTextChange,
  onSend,
  endRef,
}: {
  conversation: InternalConversationRow;
  messages: InternalMessageRow[];
  currentUserId: string;
  messageText: string;
  sending: boolean;
  onBack: () => void;
  onMessageTextChange: (value: string) => void;
  onSend: () => void;
  endRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#eee9df]">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3">
        <button type="button" onClick={onBack} className="flex h-11 w-11 items-center justify-center rounded-full active:bg-slate-100">
          <ArrowLeft size={22} />
        </button>
        <Avatar label={conversation.title || 'Chat'} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-bold text-slate-950">{conversation.title || 'Conversa interna'}</p>
          <p className="truncate text-xs text-slate-500">{conversation.type === 'group' ? `${conversation.memberCount} membros` : 'Chat interno'}</p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <div className="space-y-2">
          {messages.map((message) => {
            const isMine = message.senderUserId === currentUserId;
            const mediaUrl = message.mediaUrl ? `${message.mediaUrl}?userId=${encodeURIComponent(currentUserId)}` : '';
            return (
              <div key={message.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[86%] rounded-2xl border px-3 py-2 shadow-sm ${
                    isMine ? 'border-emerald-100 bg-[#d9fdd3]' : 'border-slate-100 bg-white'
                  }`}
                >
                  {!isMine && <p className="mb-1 text-xs font-semibold text-slate-600">{message.senderName || 'Funcionario'}</p>}
                  {message.type === 'image' && mediaUrl && (
                    <img src={mediaUrl} alt={message.fileName || 'Imagem'} className="mb-2 max-h-56 rounded-xl border border-slate-200 object-contain" />
                  )}
                  {message.type === 'document' && mediaUrl && (
                    <a href={mediaUrl} target="_blank" rel="noreferrer" className="mb-2 block rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700">
                      {message.fileName || 'Documento'}
                    </a>
                  )}
                  <p className="whitespace-pre-wrap break-words text-[16px] leading-relaxed text-slate-950">
                    {message.deletedAt ? 'Mensagem apagada.' : message.body}
                  </p>
                  <p className="mt-1 text-right text-xs text-slate-500">{formatTime(message.createdAt)}</p>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      </div>
      <div className="shrink-0 border-t border-slate-200 bg-white px-3 pb-[calc(env(safe-area-inset-bottom)+10px)] pt-2">
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            value={messageText}
            onChange={(event) => onMessageTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            placeholder="Mensagem"
            className="max-h-32 min-h-[48px] flex-1 resize-none rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base outline-none focus:border-emerald-300 focus:bg-white"
          />
          <button
            type="button"
            disabled={!messageText.trim() || sending}
            onClick={onSend}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white disabled:opacity-40"
          >
            <Send size={21} />
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskCard({ task, onClick, onToggle }: { task: EnrichedTask; onClick: () => void; onToggle: () => void }) {
  const overdue = String(task.dueDate || '').slice(0, 10) < todayIso() && task.status !== TaskStatus.DONE;
  return (
    <button type="button" onClick={onClick} className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm active:bg-slate-50">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${
            task.status === TaskStatus.DONE ? 'border-emerald-200 bg-emerald-100 text-emerald-700' : 'border-slate-200 bg-white text-slate-400'
          }`}
        >
          <CheckCircle2 size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold leading-snug text-slate-950">{task.title}</p>
          <p className="mt-1 text-sm leading-snug text-slate-600">{task.customerName || 'Sem cliente'}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${taskStatusClass(task.status)}`}>
              {taskStatusLabel(task.status)}
            </span>
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${overdue ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-600'}`}>
              {formatDate(task.dueDate)}
            </span>
            {task.priority === TaskPriority.URGENT && (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">Urgente</span>
            )}
          </div>
        </div>
        <ChevronRight size={18} className="mt-1 shrink-0 text-slate-300" />
      </div>
    </button>
  );
}

function TaskDetail({ task, onBack, onToggle }: { task: EnrichedTask; onBack: () => void; onToggle: () => void }) {
  return (
    <DetailShell title="Tarefa" subtitle={task.customerName || 'Sem cliente'} onBack={onBack}>
      <div className="space-y-4 p-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xl font-bold leading-snug text-slate-950">{task.title}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${taskStatusClass(task.status)}`}>{taskStatusLabel(task.status)}</span>
            <span className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700">{formatDate(task.dueDate)}</span>
            {task.priority === TaskPriority.URGENT && <span className="rounded-full bg-amber-100 px-3 py-1.5 text-sm font-semibold text-amber-800">Urgente</span>}
          </div>
          {task.notes && <p className="mt-4 whitespace-pre-wrap text-base leading-relaxed text-slate-700">{task.notes}</p>}
        </div>
        <button type="button" onClick={onToggle} className="h-12 w-full rounded-2xl bg-emerald-600 text-base font-bold text-white">
          {task.status === TaskStatus.DONE ? 'Reabrir tarefa' : 'Marcar concluida'}
        </button>
      </div>
    </DetailShell>
  );
}

function OccurrenceCard({ occurrence, onClick }: { occurrence: OccurrenceRow; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm active:bg-slate-50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold leading-snug text-slate-950">{occurrence.title}</p>
          <p className="mt-1 text-sm leading-snug text-slate-600">{occurrence.customerCompany || occurrence.customerName || 'Sem cliente'}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${occurrenceStateClass(occurrence.state)}`}>{occurrence.state || 'ABERTA'}</span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{formatDate(occurrence.dueDate || occurrence.date)}</span>
            {occurrence.typeName && <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-semibold text-violet-800">{occurrence.typeName}</span>}
          </div>
        </div>
        <ChevronRight size={18} className="mt-1 shrink-0 text-slate-300" />
      </div>
    </button>
  );
}

function OccurrenceDetail({
  occurrence,
  loading,
  onBack,
  onToggleResolved,
}: {
  occurrence: OccurrenceRow;
  loading: boolean;
  onBack: () => void;
  onToggleResolved: () => void;
}) {
  const isResolved = normalizeSearch(occurrence.state).includes('resol');
  const attachments = Array.isArray(occurrence.attachments) ? occurrence.attachments : [];
  const apoioSections = Object.entries(occurrence.projetoApoioDetalhe || {})
    .map(([sectionKey, sectionValue]) => ({
      section: humanizeDetailKey(sectionKey),
      rows: flattenApoioEntries(sectionValue),
    }))
    .filter((section) => section.rows.length > 0);
  return (
    <DetailShell title="Ocorrencia" subtitle={occurrence.customerCompany || occurrence.customerName || 'Sem cliente'} onBack={onBack}>
      <div className="space-y-4 p-4">
        {loading && (
          <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-700">
            A carregar detalhe completo...
          </div>
        )}
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xl font-bold leading-snug text-slate-950">{occurrence.title}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${occurrenceStateClass(occurrence.state)}`}>{occurrence.state}</span>
            <span className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700">{formatDate(occurrence.dueDate || occurrence.date)}</span>
            {occurrence.typeName && <span className="rounded-full bg-violet-100 px-3 py-1.5 text-sm font-semibold text-violet-800">{occurrence.typeName}</span>}
          </div>
          {occurrence.description && <p className="mt-4 whitespace-pre-wrap text-base leading-relaxed text-slate-700">{occurrence.description}</p>}
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Detalhes</p>
          <div className="space-y-2">
            <DetailRow label="Cliente" value={occurrence.customerCompany || occurrence.customerName || '--'} />
            <DetailRow label="NIF" value={occurrence.customerNif || '--'} />
            <DetailRow label="Data" value={formatDate(occurrence.date)} />
            <DetailRow label="Prazo" value={formatDate(occurrence.dueDate)} />
            <DetailRow label="Responsavel" value={occurrence.responsibleNames || occurrence.responsibleUserName || '--'} />
            <DetailRow label="Atualizada" value={formatDateTime(occurrence.updatedAt)} />
            {occurrence.syncOrigin && <DetailRow label="Origem" value={occurrence.syncOrigin} />}
          </div>
        </div>

        {(occurrence.resolution || isResolved) && (
          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-bold uppercase tracking-wide text-slate-500">Resolucao</p>
            <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed text-slate-700">{occurrence.resolution || 'Sem texto de resolucao.'}</p>
          </div>
        )}

        {apoioSections.length > 0 && (
          <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">Projeto de apoio</p>
            <div className="space-y-4">
              {apoioSections.map((section) => (
                <div key={section.section}>
                  <p className="mb-2 text-xs font-bold uppercase tracking-wide text-violet-600">{section.section}</p>
                  <div className="space-y-2">
                    {section.rows.map((item, idx) => (
                      <DetailRow key={`${section.section}-${item.label}-${idx}`} label={item.label} value={item.value} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-bold uppercase tracking-wide text-slate-500">Anexos</p>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-600">
              {attachments.length || occurrence.attachmentsCount || 0}
            </span>
          </div>
          {attachments.length > 0 ? (
            <div className="space-y-2">
              {attachments.map((attachment) => (
                <a
                  key={attachment.id}
                  href={`/api/occurrences/attachments/${encodeURIComponent(attachment.id)}/preview`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-[48px] items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-left active:bg-slate-100"
                >
                  <Paperclip size={18} className="shrink-0 text-slate-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-slate-900">{attachment.originalName || attachment.kind || 'Anexo'}</p>
                    <p className="truncate text-xs text-slate-500">{formatDateTime(attachment.createdAt)}</p>
                  </div>
                  <ExternalLink size={16} className="shrink-0 text-slate-400" />
                </a>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">Sem anexos associados.</p>
          )}
        </div>
        <button type="button" onClick={onToggleResolved} className="h-12 w-full rounded-2xl bg-emerald-600 text-base font-bold text-white">
          {isResolved ? 'Reabrir ocorrencia' : 'Marcar resolvida'}
        </button>
      </div>
    </DetailShell>
  );
}

function CustomerCard({ customer, onClick }: { customer: Customer; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-full rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm active:bg-slate-50">
      <div className="flex items-start gap-3">
        <Avatar label={customerLabel(customer)} />
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold leading-snug text-slate-950">{customerLabel(customer)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {customer.nif && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">NIF {customer.nif}</span>}
            {customer.phone && <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">{customer.phone}</span>}
          </div>
        </div>
        <ChevronRight size={18} className="mt-1 shrink-0 text-slate-300" />
      </div>
    </button>
  );
}

function CustomerDetail({
  customer,
  onBack,
  onCopy,
  onNewTask,
  onNewOccurrence,
  onOpenDocuments,
  fiscalSummary,
  fiscalLoading,
  fiscalError,
  onReloadFiscal,
}: {
  customer: Customer;
  onBack: () => void;
  onCopy: (value: string) => void;
  onNewTask: () => void;
  onNewOccurrence: () => void;
  onOpenDocuments: () => void;
  fiscalSummary?: MobileFiscalSummary | null;
  fiscalLoading: boolean;
  fiscalError: string;
  onReloadFiscal: () => void;
}) {
  return (
    <DetailShell title="Cliente" subtitle={customerLabel(customer)} onBack={onBack}>
      <div className="space-y-4 p-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xl font-bold leading-snug text-slate-950">{customerLabel(customer)}</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {customer.phone && (
              <a href={`tel:${customer.phone}`} className="flex h-11 items-center justify-center gap-2 rounded-2xl bg-emerald-600 text-sm font-bold text-white">
                <Phone size={17} />
                Ligar
              </a>
            )}
            {customer.email && (
              <a href={`mailto:${customer.email}`} className="flex h-11 items-center justify-center gap-2 rounded-2xl bg-slate-900 text-sm font-bold text-white">
                <Mail size={17} />
                Email
              </a>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenDocuments}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white text-sm font-bold text-slate-900 shadow-sm ring-1 ring-slate-200 active:bg-slate-50"
        >
          <FolderOpen size={18} />
          Abrir pasta / documentos
        </button>
        <InfoCard icon={<Building2 size={18} />} label="Empresa" value={customer.company || customer.name} />
        <InfoCard icon={<User size={18} />} label="Contacto" value={customer.contactName || customer.name} />
        <InfoCard icon={<Copy size={18} />} label="NIF" value={customer.nif || '--'} onClick={() => onCopy(customer.nif || '')} />
        <InfoCard icon={<CalendarDays size={18} />} label="Tipo" value={displayCustomerType(customer)} />
        {(customer.morada || customer.codigoPostal) && <InfoCard icon={<Building2 size={18} />} label="Morada" value={`${customer.morada || ''} ${customer.codigoPostal || ''}`.trim()} />}
        <CustomerFiscalSummaryCard
          customer={customer}
          summary={fiscalSummary}
          loading={fiscalLoading}
          error={fiscalError}
          onReload={onReloadFiscal}
        />
        {customer.notes && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notas</p>
            <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed text-slate-700">{customer.notes}</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <button type="button" onClick={onNewTask} className="h-12 rounded-2xl bg-emerald-600 text-sm font-bold text-white">
            Nova tarefa
          </button>
          <button type="button" onClick={onNewOccurrence} className="h-12 rounded-2xl bg-slate-900 text-sm font-bold text-white">
            Ocorrencia
          </button>
        </div>
      </div>
    </DetailShell>
  );
}

function CustomerFiscalSummaryCard({
  customer,
  summary,
  loading,
  error,
  onReload,
}: {
  customer: Customer;
  summary?: MobileFiscalSummary | null;
  loading: boolean;
  error: string;
  onReload: () => void;
}) {
  const hasData = hasFiscalSummaryData(summary);
  const filings = [
    ...(summary?.ies || []).map((item) => ({ ...item, label: 'IES' })),
    ...(summary?.modelo22 || []).map((item) => ({ ...item, label: 'Modelo 22' })),
  ]
    .filter((item) => item.ano || item.situacao || item.dataRecepcao || item.comprovativoPath)
    .sort((a, b) => String(b.ano || '').localeCompare(String(a.ano || '')))
    .slice(0, 3);

  const debts = ['at', 'ss'].map((entity) => {
    const debt = (summary?.dividas || []).find((item) => normalizeSearch(item.entidade) === entity);
    return {
      entity: entity.toUpperCase(),
      label: debt ? (debt.semDivida ? 'Sem divida' : formatCurrency(debt.montante || 0)) : '--',
      clear: !!debt?.semDivida,
    };
  });

  const documents = [
    ...(summary?.certidoes || []).map((item) => ({
      label: item.tipo || 'Certidao',
      valid: item.valida,
      date: item.dataValidade,
      file: item.ficheiroPdf,
    })),
    ...(summary?.documentos || []).map((item) => ({
      label: item.label || item.tipo || 'Documento',
      valid: item.valida,
      date: item.dataValidade,
      file: item.ficheiroPdf,
    })),
  ]
    .filter((item) => item.label || item.date || item.file)
    .slice(0, 6);

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold uppercase tracking-wide text-slate-500">Resumo fiscal</p>
          <p className="mt-1 text-xs text-slate-500">
            {summary?.updatedAt ? `Atualizado ${formatDateTime(summary.updatedAt)}` : 'Dados fiscais do cliente'}
          </p>
        </div>
        <button
          type="button"
          onClick={onReload}
          disabled={loading}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600 disabled:opacity-50"
        >
          <RefreshCw size={17} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && !summary ? (
        <p className="mt-4 rounded-2xl bg-slate-50 px-3 py-3 text-sm font-semibold text-slate-500">A carregar resumo fiscal...</p>
      ) : error ? (
        <p className="mt-4 rounded-2xl border border-rose-100 bg-rose-50 px-3 py-3 text-sm font-semibold text-rose-700">{error}</p>
      ) : !hasData ? (
        <p className="mt-4 rounded-2xl bg-slate-50 px-3 py-3 text-sm text-slate-500">Sem resumo fiscal recolhido para este cliente.</p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {debts.map((debt) => (
              <div key={debt.entity} className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                <p className="text-xs font-bold text-slate-500">{debt.entity}</p>
                <p className={`mt-1 text-sm font-bold ${debt.clear ? 'text-emerald-700' : 'text-slate-900'}`}>{debt.label}</p>
              </div>
            ))}
          </div>

          {filings.length > 0 && (
            <div className="space-y-2">
              {filings.map((filing, index) => {
                const fileUrl = fiscalFileUrl(customer, filing.comprovativoPath);
                return (
                  <div key={`${filing.label}-${filing.ano}-${index}`} className="rounded-2xl border border-slate-200 px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-900">{filing.label} {filing.ano || ''}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{filing.situacao || 'Sem estado'} {filing.dataRecepcao ? `- ${formatDate(filing.dataRecepcao)}` : ''}</p>
                      </div>
                      {fileUrl && (
                        <a href={fileUrl} target="_blank" rel="noreferrer" className="shrink-0 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700">
                          Abrir
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {documents.length > 0 && (
            <div className="space-y-2">
              {documents.map((document, index) => {
                const fileUrl = fiscalFileUrl(customer, document.file);
                const validClass = document.valid ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800';
                return (
                  <div key={`${document.label}-${index}`} className="flex items-center gap-3 rounded-2xl border border-slate-200 px-3 py-3">
                    <FileText size={18} className="shrink-0 text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-slate-900">{document.label}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${validClass}`}>{document.valid ? 'Valido' : 'A rever'}</span>
                        {document.date && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-600">{formatDate(document.date)}</span>}
                      </div>
                    </div>
                    {fileUrl && (
                      <a href={fileUrl} target="_blank" rel="noreferrer" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-600">
                        <ExternalLink size={16} />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CustomerDocumentsSheet({
  state,
  onClose,
  onOpenPath,
  onOpenFile,
}: {
  state: CustomerDocumentsState;
  onClose: () => void;
  onOpenPath: (relativePath: string) => void;
  onOpenFile: (entry: CustomerDocumentEntry) => void;
}) {
  const currentPath = state.currentRelativePath || 'Pasta principal';
  const canOpenNative = typeof (window as any).waDesktop?.openFolder === 'function' && !!(state.storageFolderPath || state.folderPath);

  return (
    <BottomSheet title="Documentos" onClose={onClose}>
      <div className="space-y-3">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Cliente</p>
          <p className="mt-1 truncate text-sm font-bold text-slate-950">{state.customer ? customerLabel(state.customer) : 'Cliente'}</p>
          <p className="mt-1 break-words text-xs text-slate-500">{currentPath}</p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!state.canGoUp || state.loading}
            onClick={() => onOpenPath(parentDocumentPath(state.currentRelativePath))}
            className="h-11 rounded-2xl border border-slate-200 bg-white text-sm font-bold text-slate-700 disabled:opacity-40"
          >
            Voltar pasta
          </button>
          <button
            type="button"
            disabled={!canOpenNative}
            onClick={() => {
              const opener = (window as any).waDesktop?.openFolder;
              if (typeof opener === 'function') void opener(state.storageFolderPath || state.folderPath);
            }}
            className="h-11 rounded-2xl border border-slate-200 bg-white text-sm font-bold text-slate-700 disabled:opacity-40"
          >
            Abrir no PC
          </button>
        </div>
      </div>

      {state.loading ? (
        <p className="rounded-2xl bg-slate-50 px-3 py-4 text-center text-sm font-semibold text-slate-500">A abrir pasta...</p>
      ) : state.error ? (
        <p className="rounded-2xl border border-rose-100 bg-rose-50 px-3 py-4 text-sm font-semibold text-rose-700">{state.error}</p>
      ) : !state.configured ? (
        <p className="rounded-2xl bg-slate-50 px-3 py-4 text-sm text-slate-500">Este cliente ainda nao tem pasta de documentos configurada.</p>
      ) : state.entries.length === 0 ? (
        <p className="rounded-2xl bg-slate-50 px-3 py-4 text-sm text-slate-500">Sem documentos nesta pasta.</p>
      ) : (
        <div className="space-y-2">
          {state.entries.map((entry) => {
            const isDirectory = entry.type === 'directory';
            return (
              <button
                key={entry.relativePath}
                type="button"
                onClick={() => (isDirectory ? onOpenPath(entry.relativePath) : onOpenFile(entry))}
                className="flex min-h-[58px] w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-left shadow-sm active:bg-slate-50"
              >
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${isDirectory ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                  {isDirectory ? <FolderOpen size={20} /> : <FileText size={20} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-slate-950">{entry.name}</p>
                  <p className="mt-0.5 truncate text-xs text-slate-500">
                    {isDirectory ? 'Pasta' : formatFileSize(entry.size)} {entry.updatedAt ? `- ${formatDate(entry.updatedAt)}` : ''}
                  </p>
                </div>
                {isDirectory ? <ChevronRight size={18} className="shrink-0 text-slate-300" /> : <Download size={18} className="shrink-0 text-slate-400" />}
              </button>
            );
          })}
        </div>
      )}
    </BottomSheet>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-2xl bg-slate-50 px-3 py-2.5">
      <span className="shrink-0 text-xs font-bold uppercase tracking-wide text-slate-500">{label}</span>
      <span className="min-w-0 break-words text-right text-sm font-semibold text-slate-800">{value || '--'}</span>
    </div>
  );
}

function DetailShell({ title, subtitle, onBack, children }: { title: string; subtitle?: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3">
        <button type="button" onClick={onBack} className="flex h-11 w-11 items-center justify-center rounded-full active:bg-slate-100">
          <ArrowLeft size={22} />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-bold text-slate-950">{title}</p>
          {subtitle && <p className="truncate text-xs text-slate-500">{subtitle}</p>}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-slate-100">{children}</div>
    </div>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="border-b border-slate-200 bg-white px-4 py-3">
      <div className="grid grid-flow-col auto-cols-fr gap-1 rounded-2xl bg-slate-100 p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`min-h-[40px] rounded-xl px-2 text-sm font-bold ${
              value === option.value ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function FloatingMiniButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-11 shrink-0 items-center gap-1.5 rounded-2xl bg-emerald-600 px-3 text-sm font-bold text-white">
      <Plus size={17} />
      {label}
    </button>
  );
}

function BottomSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/35">
      <div className="max-h-[88dvh] w-full overflow-hidden rounded-t-[28px] bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="text-lg font-bold text-slate-950">{title}</h2>
          <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-600">
            <X size={20} />
          </button>
        </div>
        <div className="max-h-[calc(88dvh-73px)] space-y-4 overflow-auto px-5 pb-[calc(env(safe-area-inset-bottom)+20px)] pt-4">
          {children}
        </div>
      </div>
    </div>
  );
}

function CustomerPicker({
  query,
  selectedId,
  matches,
  onQueryChange,
  onSelect,
}: {
  query: string;
  selectedId: string;
  matches: Customer[];
  onQueryChange: (value: string) => void;
  onSelect: (customer: Customer) => void;
}) {
  return (
    <div>
      <FormField label="Cliente">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className="mobile-input"
          placeholder="Pesquisar cliente"
        />
      </FormField>
      <div className="mt-2 max-h-44 space-y-2 overflow-auto">
        {matches.map((customer) => (
          <button
            key={customer.id}
            type="button"
            onClick={() => onSelect(customer)}
            className={`w-full rounded-2xl border px-3 py-2 text-left ${
              selectedId === customer.id ? 'border-emerald-300 bg-emerald-50' : 'border-slate-200 bg-white'
            }`}
          >
            <p className="truncate text-sm font-bold text-slate-900">{customerLabel(customer)}</p>
            {customer.nif && <p className="mt-0.5 text-xs text-slate-500">NIF {customer.nif}</p>}
          </button>
        ))}
      </div>
    </div>
  );
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-bold text-slate-700">{label}</span>
      {children}
    </label>
  );
}

function InfoCard({
  icon,
  label,
  value,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onClick?: () => void;
}) {
  const content = (
    <div className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-left">
      <div className="mt-0.5 text-slate-400">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
        <p className="mt-1 break-words text-base font-semibold text-slate-900">{value || '--'}</p>
      </div>
    </div>
  );
  if (!onClick) return content;
  return (
    <button type="button" onClick={onClick} className="block w-full">
      {content}
    </button>
  );
}

function Avatar({ label }: { label: string }) {
  const initials =
    String(label || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0] || '')
      .join('')
      .toUpperCase() || '?';
  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-bold text-emerald-700">
      {initials}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="px-4 py-10 text-center text-sm font-medium text-slate-500">{label}</div>;
}

export default MobileWorkspace;
