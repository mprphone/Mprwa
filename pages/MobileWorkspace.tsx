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
  Mail,
  MessageCircle,
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
    () => occurrences.find((occurrence) => occurrence.id === selectedOccurrenceId) || null,
    [occurrences, selectedOccurrenceId]
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
      await saveOccurrence({
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
                  <OccurrenceCard key={occurrence.id} occurrence={occurrence} onClick={() => setSelectedOccurrenceId(occurrence.id)} />
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
  onBack,
  onToggleResolved,
}: {
  occurrence: OccurrenceRow;
  onBack: () => void;
  onToggleResolved: () => void;
}) {
  const isResolved = normalizeSearch(occurrence.state).includes('resol');
  return (
    <DetailShell title="Ocorrencia" subtitle={occurrence.customerCompany || occurrence.customerName || 'Sem cliente'} onBack={onBack}>
      <div className="space-y-4 p-4">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xl font-bold leading-snug text-slate-950">{occurrence.title}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${occurrenceStateClass(occurrence.state)}`}>{occurrence.state}</span>
            <span className="rounded-full bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-700">{formatDate(occurrence.dueDate || occurrence.date)}</span>
          </div>
          {occurrence.description && <p className="mt-4 whitespace-pre-wrap text-base leading-relaxed text-slate-700">{occurrence.description}</p>}
          {occurrence.responsibleNames && <p className="mt-4 text-sm font-semibold text-slate-500">{occurrence.responsibleNames}</p>}
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
}: {
  customer: Customer;
  onBack: () => void;
  onCopy: (value: string) => void;
  onNewTask: () => void;
  onNewOccurrence: () => void;
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
        <InfoCard icon={<Building2 size={18} />} label="Empresa" value={customer.company || customer.name} />
        <InfoCard icon={<User size={18} />} label="Contacto" value={customer.contactName || customer.name} />
        <InfoCard icon={<Copy size={18} />} label="NIF" value={customer.nif || '--'} onClick={() => onCopy(customer.nif || '')} />
        <InfoCard icon={<CalendarDays size={18} />} label="Tipo" value={customer.type || '--'} />
        {(customer.morada || customer.codigoPostal) && <InfoCard icon={<Building2 size={18} />} label="Morada" value={`${customer.morada || ''} ${customer.codigoPostal || ''}`.trim()} />}
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
