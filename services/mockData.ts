import { User, Role, Customer, Conversation, ConversationStatus, Message, Task, TaskStatus, Call, CustomerType, TaskPriority, AutoResponseTrigger } from '../types';
import {
  deleteChatConversation,
  deleteChatMessage,
  editChatMessage,
  fetchChatContacts,
  fetchChatConversationsLocal,
  fetchChatMessages,
  markChatConversationRead,
  sendChatMessage,
  setConversationWhatsAppAccount as apiSetConversationWhatsAppAccount,
  syncChatConversation,
} from './chatCoreApi';

// --- Initial Mock Data ---

const INITIAL_USERS: User[] = [
  { id: 'u1', name: 'Ana Silva', email: 'ana@company.com', password: '1234', role: Role.ADMIN, avatarUrl: 'https://picsum.photos/200/200?random=1' },
  { id: 'u2', name: 'João Santos', email: 'joao@company.com', password: '1234', role: Role.AGENT, avatarUrl: 'https://picsum.photos/200/200?random=2' },
  { id: 'u3', name: 'Maria Costa', email: 'maria@company.com', password: '1234', role: Role.AGENT, avatarUrl: 'https://picsum.photos/200/200?random=3' },
  { id: 'u4', name: 'Marco Rebelo', email: 'mpr@mpr.pt', password: '1234', role: Role.ADMIN, avatarUrl: 'https://ui-avatars.com/api/?name=Marco+Rebelo&background=random' },
];

export const USERS = [...INITIAL_USERS]; // Shared reference used by legacy views
export let CURRENT_USER_ID =
  typeof window !== 'undefined' && window.localStorage
    ? (window.localStorage.getItem('wa_pro_session_user_id') || '')
    : '';

const INITIAL_CUSTOMERS: Customer[] = [
  { 
    id: 'c1', 
    name: 'Carlos Ferreira', 
    company: 'Tech Solutions', 
    phone: '+351912345678', 
    ownerId: 'u1',
    type: CustomerType.ENTERPRISE,
    contacts: [{ name: 'Secretaria', phone: '+351210000000' }],
    allowAutoResponses: true
  },
  { 
    id: 'c2', 
    name: 'Sofia Martins', 
    company: 'Logística Lda', 
    phone: '+351961112233', 
    ownerId: 'u2',
    type: CustomerType.SUPPLIER,
    contacts: [],
    allowAutoResponses: false
  },
  { 
    id: 'c3', 
    name: 'Novo Cliente', 
    company: 'Startup Inc', 
    phone: '+351933334444', 
    ownerId: null,
    type: CustomerType.INDEPENDENT,
    contacts: [],
    allowAutoResponses: true
  },
];

const INITIAL_CONVERSATIONS: Conversation[] = [
  { id: 'conv1', customerId: 'c1', ownerId: 'u1', status: ConversationStatus.OPEN, lastMessageAt: new Date().toISOString(), unreadCount: 0 },
  { id: 'conv2', customerId: 'c2', ownerId: 'u2', status: ConversationStatus.WAITING, lastMessageAt: new Date(Date.now() - 3600000).toISOString(), unreadCount: 0 },
  { id: 'conv3', customerId: 'c3', ownerId: null, status: ConversationStatus.OPEN, lastMessageAt: new Date(Date.now() - 7200000).toISOString(), unreadCount: 0 },
];

const INITIAL_MESSAGES: Message[] = [
  { id: 'm1', conversationId: 'conv1', direction: 'in', body: 'Olá, preciso de ajuda com a fatura.', timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(), type: 'text', status: 'read' },
  { id: 'm2', conversationId: 'conv1', direction: 'out', body: 'Olá Carlos. Claro, qual é o número da fatura?', timestamp: new Date(Date.now() - 1000 * 60 * 28).toISOString(), type: 'text', status: 'read' },
  { id: 'm3', conversationId: 'conv1', direction: 'in', body: 'É a FT 2023/450.', timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(), type: 'text', status: 'read' },
  { id: 'm4', conversationId: 'conv3', direction: 'in', body: 'Boa tarde, gostaria de saber preços.', timestamp: new Date(Date.now() - 7200000).toISOString(), type: 'text', status: 'read' },
];

const INITIAL_TASKS: Task[] = [
  { id: 't1', conversationId: 'conv1', title: 'Verificar fatura no ERP', status: TaskStatus.OPEN, priority: TaskPriority.URGENT, dueDate: new Date(Date.now() + 86400000).toISOString(), assignedUserId: 'u1', notes: 'Verificar se o IVA está a 23%' },
  { id: 't2', conversationId: 'conv2', title: 'Agendar reunião', status: TaskStatus.DONE, priority: TaskPriority.NORMAL, dueDate: new Date().toISOString(), assignedUserId: 'u2' },
];

const INITIAL_CALLS: Call[] = [
  { id: 'call1', customerId: 'c1', userId: 'u1', startedAt: new Date(Date.now() - 86400000).toISOString(), durationSeconds: 120, notes: 'Dúvida rápida', source: 'manual' },
];

// Updated Triggers based on user requirements
const INITIAL_TRIGGERS: AutoResponseTrigger[] = [
  // 1. Confirmação de receção (Primeira msg do dia)
  { 
      id: 'tr1', 
      type: 'first_message_today',
      action: 'send_message',
      response: 'Olá 👋\nRecebemos a sua mensagem e já estamos a tratar.',
      isActive: true,
      audience: 'all',
      schedule: 'business_hours',
      level: 'essential'
  },
  // 2. Fora de horário
  { 
      id: 'tr2', 
      type: 'outside_hours',
      action: 'send_message',
      response: 'Olá, recebemos a sua mensagem fora do nosso horário de atendimento. Retomaremos o contacto no próximo dia útil.', 
      isActive: true,
      audience: 'all',
      schedule: 'outside_hours',
      level: 'essential'
  },
  // 5. Identificação Automática (Keyword -> Task) - IRS
  { 
      id: 'tr3', 
      type: 'keyword',
      action: 'create_task',
      keyword: 'irs',
      matchType: 'contains',
      taskTitleTemplate: 'IRS - Documentos Pendentes',
      isActive: true,
      audience: 'allowed_only',
      schedule: 'always',
      level: 'extra'
  },
  // 5. Identificação Automática (Keyword -> Task) - IVA
  { 
      id: 'tr4', 
      type: 'keyword',
      action: 'create_task',
      keyword: 'iva',
      matchType: 'contains',
      taskTitleTemplate: 'IVA - Envio Mensal',
      isActive: true,
      audience: 'allowed_only',
      schedule: 'always',
      level: 'extra'
  },
  // 10. Respostas Rápidas (Keyword -> Reply) - IBAN
  { 
      id: 'tr5', 
      type: 'keyword',
      action: 'send_message',
      keyword: 'iban',
      matchType: 'contains',
      response: 'O nosso IBAN para pagamentos é PT50 0000 0000 0000 0000 0000 0.',
      isActive: true,
      audience: 'allowed_only',
      schedule: 'always',
      level: 'essential'
  },
  // 6. Mensagem de Encerramento (Task Completed -> Reply)
  {
      id: 'tr6',
      type: 'task_completed',
      action: 'send_message',
      response: 'O seu pedido ficou concluído. Se precisar de algo adicional, estamos disponíveis.',
      isActive: false,
      audience: 'all',
      schedule: 'always',
      level: 'extra'
  },
  // NOVO: Gatilho de Contratação
  {
      id: 'tr7',
      type: 'keyword',
      action: 'create_task',
      keyword: 'empregar alguem',
      matchType: 'contains',
      taskTitleTemplate: 'Novo Funcionário',
      isActive: true,
      audience: 'allowed_only',
      schedule: 'always',
      level: 'extra'
  }
];

// --- Mock Service Class ---

const LOCAL_CUSTOMERS_KEY = 'wa_pro_local_customers_v1';
const LOCAL_USERS_KEY = 'wa_pro_local_users_v1';
const SESSION_USER_KEY = 'wa_pro_session_user_id';

class MockService {
  private users = USERS;
  private customers = [...INITIAL_CUSTOMERS];
  private conversations = [...INITIAL_CONVERSATIONS];
  private messages = [...INITIAL_MESSAGES];
  private tasks = [...INITIAL_TASKS];
  private calls = [...INITIAL_CALLS];
  private triggers = [...INITIAL_TRIGGERS];
  private supabaseImportPromise: Promise<void> | null = null;
  private supabaseImportDone = false;

  constructor() {
    this.loadLocalEntities();
    void this.ensureSupabaseImport();
  }

  private isBrowser(): boolean {
    return typeof window !== 'undefined' && !!window.localStorage;
  }

  private setSessionUserId(userId: string | null) {
    CURRENT_USER_ID = userId || '';
    if (!this.isBrowser()) return;

    if (CURRENT_USER_ID) {
      window.localStorage.setItem(SESSION_USER_KEY, CURRENT_USER_ID);
    } else {
      window.localStorage.removeItem(SESSION_USER_KEY);
    }
  }

  private ensureSessionIsValid() {
    if (!CURRENT_USER_ID) return;
    const exists = this.users.some(user => user.id === CURRENT_USER_ID);
    if (!exists) {
      this.setSessionUserId('');
    }
  }

  private loadLocalEntities() {
    if (!this.isBrowser()) return;

    try {
      const usersRaw = window.localStorage.getItem(LOCAL_USERS_KEY);
      if (usersRaw) {
        const parsedUsers = JSON.parse(usersRaw) as unknown[];
        if (Array.isArray(parsedUsers)) {
          const localUsers = parsedUsers.filter(user => this.isValidUser(user));
          this.mergeImportedUsers(localUsers);
        }
      }
    } catch (error) {
      console.warn('[Local users] erro ao carregar:', error);
    }

    try {
      const customersRaw = window.localStorage.getItem(LOCAL_CUSTOMERS_KEY);
      if (customersRaw) {
        const parsedCustomers = JSON.parse(customersRaw) as unknown[];
        if (Array.isArray(parsedCustomers)) {
          const localCustomers = parsedCustomers.filter(customer => this.isValidCustomer(customer));
          this.mergeImportedCustomers(localCustomers);
        }
      }
    } catch (error) {
      console.warn('[Local customers] erro ao carregar:', error);
    }

  }

  private persistLocalEntities() {
    if (!this.isBrowser()) return;

    try {
      const localUsers = this.users.filter(user => user.id.startsWith('local_'));
      window.localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(localUsers));
    } catch (error) {
      console.warn('[Local users] erro ao guardar:', error);
    }

    try {
      const localCustomers = this.customers.filter(customer => customer.id.startsWith('local_'));
      window.localStorage.setItem(LOCAL_CUSTOMERS_KEY, JSON.stringify(localCustomers));
    } catch (error) {
      console.warn('[Local customers] erro ao guardar:', error);
    }

  }

  private pruneOrphanConversationData() {
    const validCustomerIds = new Set(this.customers.map((customer) => customer.id));
    const validConversations = this.conversations.filter((conversation) => validCustomerIds.has(conversation.customerId));
    const validConversationIds = new Set(validConversations.map((conversation) => conversation.id));

    this.conversations = validConversations;
    this.messages = this.messages.filter((message) => validConversationIds.has(message.conversationId));
    this.tasks = this.tasks.filter((task) => validConversationIds.has(task.conversationId));
  }

  private normalizePhone(value: string): string {
    const digits = value.replace(/\D/g, '');
    if (!digits) return '';
    return value.trim().startsWith('+') ? `+${digits}` : `+${digits}`;
  }

  private isInternalChatPlaceholderUser(user: Pick<User, 'id' | 'name' | 'email'>): boolean {
    const id = String(user?.id || '').trim().toLowerCase();
    const name = String(user?.name || '').trim();
    const email = String(user?.email || '').trim().toLowerCase();
    if (!id && !name && !email) return false;
    if (email.endsWith('@sync.local')) return true;
    if (email.endsWith('@local.invalid') && id.startsWith('ext_u_')) return true;
    return /^Funcion[aá]rio\s+[a-f0-9]{6,}/i.test(name);
  }

  private userDedupScore(user: User, currentUserId: string): number {
    const normalizedId = String(user.id || '').trim();
    const normalizedRole = String(user.role || '').trim().toUpperCase();
    let score = 0;
    if (normalizedId && normalizedId === currentUserId) score += 1000;
    if (normalizedRole === Role.ADMIN) score += 200;
    if (normalizedId.startsWith('ext_u_')) score += 40;
    if (!normalizedId.startsWith('local_')) score += 10;
    if (String(user.avatarUrl || '').trim()) score += 5;
    if (String(user.password || '').trim()) score += 2;
    return score;
  }

  private getVisibleUsers(): User[] {
    const currentUserId = String(CURRENT_USER_ID || '').trim();
    const byEmail = new Map<string, User>();
    const withoutEmail: User[] = [];

    for (const user of this.users) {
      if (!this.isValidUser(user)) continue;
      if (this.isInternalChatPlaceholderUser(user)) continue;

      const normalizedEmail = String(user.email || '').trim().toLowerCase();
      if (!normalizedEmail) {
        withoutEmail.push(user);
        continue;
      }

      const existing = byEmail.get(normalizedEmail);
      if (!existing) {
        byEmail.set(normalizedEmail, user);
        continue;
      }

      const incomingScore = this.userDedupScore(user, currentUserId);
      const existingScore = this.userDedupScore(existing, currentUserId);
      if (incomingScore > existingScore) {
        byEmail.set(normalizedEmail, user);
      }
    }

    const merged = [...byEmail.values(), ...withoutEmail];
    const uniqueById = new Map<string, User>();
    merged.forEach((user) => {
      const id = String(user.id || '').trim();
      if (!id) return;
      if (!uniqueById.has(id)) uniqueById.set(id, user);
    });
    return Array.from(uniqueById.values());
  }

  private normalizePhoneDigits(value: string): string {
    return String(value || '').replace(/\D/g, '');
  }

  private extractPhoneDigitsFromConversationId(conversationId: string): string {
    const match = String(conversationId || '').match(/wa_c_(\d{6,})/);
    return match?.[1] || '';
  }

  private async alignConversationCustomerByIdPattern(conversation: Conversation): Promise<Conversation> {
    const digits = this.extractPhoneDigitsFromConversationId(conversation.id);
    if (!digits) return conversation;

    // Não forçar remapeamento quando a conversa já vem com customerId definido.
    // Isto evita sobrescrever associações válidas vindas do backend (ex.: ext_c_...).
    if (String(conversation.customerId || '').trim()) return conversation;

    const canonicalCustomerId = `wa_c_${digits}`;
    if (!this.customers.some((customer) => customer.id === canonicalCustomerId)) {
      this.ensureCustomerFromBackend(`+${digits}`, canonicalCustomerId);
    }

    const nextConversation: Conversation = { ...conversation, customerId: canonicalCustomerId };
    if (this.isBrowser()) {
      const persisted = await this.syncConversationToLocalSql(nextConversation);
      return persisted || nextConversation;
    }
    return nextConversation;
  }

  private parseTimestampToIso(value: string): string {
    if (!value) return new Date().toISOString();

    const direct = new Date(value);
    if (!Number.isNaN(direct.getTime())) return direct.toISOString();

    const fallback = new Date(String(value).replace(' ', 'T') + 'Z');
    if (!Number.isNaN(fallback.getTime())) return fallback.toISOString();

    return new Date().toISOString();
  }

  private mapDbStatus(status: string): 'sent' | 'delivered' | 'read' {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'read') return 'read';
    if (normalized === 'delivered') return 'delivered';
    return 'sent';
  }

  private resolveMessageToken(row: { id?: number | string | null; wa_id?: string | null }): string {
    const waId = String(row?.wa_id || '').trim();
    if (waId) return waId;
    const dbId = Number(row?.id || 0);
    if (Number.isFinite(dbId) && dbId > 0) return `db_${dbId}`;
    return `tmp_${Date.now()}`;
  }

  private buildMediaUrl(messageToken: string, download = false): string {
    const safeToken = encodeURIComponent(String(messageToken || '').trim());
    if (!safeToken) return '';
    return download
      ? `/api/chat/messages/${safeToken}/media?download=1`
      : `/api/chat/messages/${safeToken}/media`;
  }

  private inferMessageTypeFromRow(row: {
    body?: string | null;
    media_kind?: string | null;
  }): Message['type'] {
    const mediaKind = String(row?.media_kind || '').trim().toLowerCase();
    if (mediaKind === 'image') return 'image';
    if (mediaKind === 'document') return 'document';

    const body = String(row?.body || '').trim();
    if (body.startsWith('Template:')) return 'template';
    if (body.startsWith('[Imagem]')) return 'image';
    if (body.startsWith('[Documento]')) return 'document';
    return 'text';
  }

  private isOptimisticMessageId(messageId: string): boolean {
    const id = String(messageId || '').trim();
    return id.startsWith('q_') || id.startsWith('tmp_');
  }

  private mergeOptimisticMessages(conversationId: string, mappedMessages: Message[]): Message[] {
    const optimistic = this.messages
      .filter((message) => message.conversationId === conversationId && this.isOptimisticMessageId(message.id))
      .filter((message) => message.direction === 'out');

    if (optimistic.length === 0) return mappedMessages;

    const merged = [...mappedMessages];
    for (const optimisticMessage of optimistic) {
      const optimisticTs = new Date(optimisticMessage.timestamp).getTime();
      const hasEquivalent = mappedMessages.some((mapped) => {
        if (mapped.direction !== optimisticMessage.direction) return false;
        if (mapped.body !== optimisticMessage.body) return false;
        const mappedTs = new Date(mapped.timestamp).getTime();
        return Math.abs(mappedTs - optimisticTs) <= 180000;
      });
      if (!hasEquivalent) {
        merged.push(optimisticMessage);
      }
    }

    return merged.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
  }

  private findCustomerByPhone(phone: string): Customer | undefined {
    const target = this.normalizePhoneDigits(phone);
    if (!target) return undefined;

    return this.customers.find((customer) => {
      const candidate = this.normalizePhoneDigits(customer.phone || '');
      if (!candidate) return false;
      return candidate === target || candidate.endsWith(target) || target.endsWith(candidate);
    });
  }

  private shouldHydrateCustomerNameFromHint(customer: Customer): boolean {
    const name = String(customer?.name || '').trim();
    const phone = String(customer?.phone || '').trim();
    const company = String(customer?.company || '').trim().toLowerCase();
    if (!name) return true;
    if (phone && name === phone) return true;
    if (name.startsWith('+') && name.replace(/\D/g, '').length >= 6) return true;
    if (company === 'whatsapp') return true;
    return false;
  }

  private shouldHydrateCustomerCompanyFromHint(customer: Customer): boolean {
    const company = String(customer?.company || '').trim().toLowerCase();
    return !company || company === 'whatsapp';
  }

  private hydrateCustomerFromHints(
    customer: Customer,
    hints: { preferredName?: string; preferredCompany?: string } = {}
  ): Customer {
    const preferredName = String(hints.preferredName || '').trim();
    const preferredCompany = String(hints.preferredCompany || '').trim();
    const updateName = Boolean(preferredName && this.shouldHydrateCustomerNameFromHint(customer));
    const updateCompany = Boolean(preferredCompany && this.shouldHydrateCustomerCompanyFromHint(customer));
    if (!updateName && !updateCompany) return customer;

    const next: Customer = {
      ...customer,
      name: updateName ? preferredName : customer.name,
      company: updateCompany ? preferredCompany : customer.company,
    };
    const index = this.customers.findIndex((item) => item.id === customer.id);
    if (index >= 0) {
      this.customers[index] = next;
      return this.customers[index];
    }
    return next;
  }

  private ensureCustomerFromBackend(
    phone: string,
    preferredIdRaw?: string,
    hints: { preferredName?: string; preferredCompany?: string } = {}
  ): Customer {
    const preferredId = String(preferredIdRaw || '').trim();
    if (preferredId) {
      const byId = this.customers.find((customer) => customer.id === preferredId);
      if (byId) return this.hydrateCustomerFromHints(byId, hints);
    }

    const existing = this.findCustomerByPhone(phone);
    if (existing) {
      const hydratedExisting = this.hydrateCustomerFromHints(existing, hints);
      if (preferredId && existing.id !== preferredId) {
        const alias: Customer = {
          ...hydratedExisting,
          id: preferredId,
          contacts: Array.isArray(hydratedExisting.contacts)
            ? hydratedExisting.contacts.map((contact) => ({ ...contact }))
            : [],
        };
        this.customers.push(alias);
        return alias;
      }
      return hydratedExisting;
    }

    const digits = this.normalizePhoneDigits(phone);
    const normalizedPhone = digits ? `+${digits}` : '';
    const preferredName = String(hints.preferredName || '').trim();
    const preferredCompany = String(hints.preferredCompany || '').trim();

    const newCustomer: Customer = {
      id: preferredId || `wa_c_${digits || Date.now()}`,
      name: preferredName || normalizedPhone || 'Contacto WhatsApp',
      company: preferredCompany || 'WhatsApp',
      phone: normalizedPhone,
      ownerId: CURRENT_USER_ID || null,
      type: CustomerType.PRIVATE,
      contacts: [],
      allowAutoResponses: true,
    };

    this.customers.push(newCustomer);
    return newCustomer;
  }

  private ensureConversationForCustomer(customer: Customer, lastMessageAt?: string): Conversation {
    let conversation = this.conversations.find(
      (item) => item.customerId === customer.id && item.status !== ConversationStatus.CLOSED
    );

    if (!conversation) {
      conversation = {
        id: `wa_conv_${customer.id}`,
        customerId: customer.id,
        ownerId: customer.ownerId || CURRENT_USER_ID || null,
        status: ConversationStatus.OPEN,
        lastMessageAt: lastMessageAt || new Date().toISOString(),
        unreadCount: 0,
      };
      this.conversations.push(conversation);
      return conversation;
    }

    if (lastMessageAt && new Date(lastMessageAt).getTime() > new Date(conversation.lastMessageAt).getTime()) {
      conversation.lastMessageAt = lastMessageAt;
    }
    if (!conversation.ownerId) {
      conversation.ownerId = customer.ownerId || CURRENT_USER_ID || null;
    }

    return conversation;
  }

  private parseConversationTimestamp(value: string): number {
    const parsed = new Date(value || '').getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private getConversationSourceRank(id: string): number {
    const value = String(id || '');
    if (value.startsWith('conv_wa_c_')) return 30;
    if (value.startsWith('conv_wa_')) return 20;
    if (value.startsWith('wa_conv_')) return 1;
    return 10;
  }

  private getConversationDedupeKey(conversation: Conversation): string {
    const fromConversationId = this.extractPhoneDigitsFromConversationId(conversation.id);
    if (fromConversationId) return `phone:${fromConversationId}`;

    const customer = this.customers.find((item) => item.id === conversation.customerId);
    const fromCustomerPhone = this.normalizePhoneDigits(customer?.phone || '');
    if (fromCustomerPhone) return `phone:${fromCustomerPhone}`;

    return `customer:${conversation.customerId || conversation.id}`;
  }

  private shouldPreferConversation(candidate: Conversation, current: Conversation): boolean {
    const candidateRank = this.getConversationSourceRank(candidate.id);
    const currentRank = this.getConversationSourceRank(current.id);
    if (candidateRank !== currentRank) {
      return candidateRank > currentRank;
    }

    if (candidate.unreadCount !== current.unreadCount) {
      return candidate.unreadCount > current.unreadCount;
    }

    const candidateTs = this.parseConversationTimestamp(candidate.lastMessageAt);
    const currentTs = this.parseConversationTimestamp(current.lastMessageAt);
    if (candidateTs !== currentTs) {
      return candidateTs > currentTs;
    }

    return Boolean(candidate.ownerId) && !current.ownerId;
  }

  private dedupeConversations(): void {
    const byCustomer = new Map<string, Conversation>();
    this.conversations.forEach((conversation) => {
      const key = this.getConversationDedupeKey(conversation);
      const current = byCustomer.get(key);
      if (!current) {
        byCustomer.set(key, conversation);
        return;
      }
      if (this.shouldPreferConversation(conversation, current)) {
        byCustomer.set(key, conversation);
      }
    });
    this.conversations = Array.from(byCustomer.values());
  }

  private async syncConversationToLocalSql(conversation: Conversation): Promise<Conversation | null> {
    if (!this.isBrowser()) return null;
    return syncChatConversation<Conversation>(
      {
        id: conversation.id,
        customerId: conversation.customerId,
        whatsappAccountId: conversation.whatsappAccountId || null,
        ownerId: conversation.ownerId,
        status: conversation.status,
        lastMessageAt: conversation.lastMessageAt,
        unreadCount: conversation.unreadCount,
      },
      CURRENT_USER_ID || null
    );
  }

  private async syncConversationsFromBackend(): Promise<void> {
    if (!this.isBrowser()) return;

    try {
      const contacts = await fetchChatContacts();

      contacts.forEach((contact) => {
        const backendCustomerId = String(contact.customer_id || '').trim();
        const customer = this.ensureCustomerFromBackend(contact.from_number || '', backendCustomerId, {
          preferredName: String(contact.customer_name || '').trim(),
          preferredCompany: String(contact.customer_company || '').trim(),
        });
        const lastMessageAt = this.parseTimestampToIso(contact.last_msg_time || '');
        const backendConversationId = String(contact.conversation_id || '').trim();

        let conversation =
          (backendConversationId
            ? this.conversations.find((item) => item.id === backendConversationId)
            : undefined) ||
          this.conversations.find(
            (item) => item.customerId === customer.id && item.status !== ConversationStatus.CLOSED
          );

        if (!conversation) {
          conversation = {
            id: backendConversationId || `wa_conv_${customer.id}`,
            customerId: customer.id,
            ownerId: customer.ownerId || CURRENT_USER_ID || null,
            status: contact.status || ConversationStatus.OPEN,
            lastMessageAt,
            unreadCount: Math.max(0, Number(contact.unread_count || 0)),
          };
          this.conversations.push(conversation);
        } else if (backendConversationId && conversation.id !== backendConversationId) {
          const migrated = { ...conversation, id: backendConversationId };
          this.conversations = this.conversations.map((item) =>
            item.id === conversation!.id ? migrated : item
          );
          conversation = migrated;
        }

        conversation.customerId = backendCustomerId || customer.id;
        conversation.whatsappAccountId = String(contact.whatsapp_account_id || '').trim() || null;
        if (typeof contact.owner_id === 'string') {
          conversation.ownerId = contact.owner_id || null;
        } else if (!conversation.ownerId) {
          conversation.ownerId = customer.ownerId || CURRENT_USER_ID || null;
        }
        if (contact.status) {
          conversation.status = contact.status;
        }
        if (typeof contact.unread_count === 'number') {
          conversation.unreadCount = Math.max(0, contact.unread_count);
        }
        if (
          lastMessageAt &&
          this.parseConversationTimestamp(lastMessageAt) >=
            this.parseConversationTimestamp(conversation.lastMessageAt)
        ) {
          conversation.lastMessageAt = lastMessageAt;
        }
      });
      this.dedupeConversations();
    } catch (error) {
      console.warn('[Backend sync] contactos indisponíveis:', error);
    }
  }

  private mergeImportedUsers(importedUsers: User[]) {
    const existingByEmail = new Map<string, number>();
    this.users.forEach((user, index) => {
      const key = (user.email || '').toLowerCase();
      if (key) existingByEmail.set(key, index);
    });

    importedUsers.forEach((user) => {
      const emailKey = (user.email || '').toLowerCase();
      const existingIndex = emailKey ? existingByEmail.get(emailKey) : undefined;

      if (existingIndex !== undefined) {
        const existingUser = this.users[existingIndex];
        const mergedPrimary = { ...existingUser, ...user, id: existingUser.id };
        this.users[existingIndex] = mergedPrimary;

        // Mantém um alias com o ID externo quando o utilizador local já existe com o mesmo email.
        // Isto evita perder ownership de conversas guardadas com owner_id ext_u_...
        if (
          user.id &&
          user.id !== existingUser.id &&
          !this.users.some((existing) => existing.id === user.id)
        ) {
          this.users.push({ ...mergedPrimary, id: user.id });
        }
        return;
      }

      const hasSameId = this.users.some(existing => existing.id === user.id);
      const nextUser = hasSameId ? { ...user, id: `${user.id}_${Date.now()}` } : user;
      this.users.push(nextUser);
      if (emailKey) {
        existingByEmail.set(emailKey, this.users.length - 1);
      }
    });
  }

  private mergeImportedCustomers(importedCustomers: Customer[]) {
    const existingById = new Map<string, number>();
    this.customers.forEach((customer, index) => {
      if (customer.id) {
        existingById.set(customer.id, index);
      }
    });

    importedCustomers.forEach((customer) => {
      const existingIndex = existingById.get(customer.id);

      if (existingIndex !== undefined) {
        this.customers[existingIndex] = {
          ...this.customers[existingIndex],
          ...customer,
          id: customer.id,
        };
        existingById.set(customer.id, existingIndex);
        return;
      }

      const hasSameId = this.customers.some(existing => existing.id === customer.id);
      const nextCustomer = hasSameId ? { ...customer, id: `${customer.id}_${Date.now()}` } : customer;
      this.customers.push(nextCustomer);
      existingById.set(nextCustomer.id, this.customers.length - 1);
    });
  }

  private isValidUser(data: unknown): data is User {
    const candidate = data as User;
    return !!candidate && typeof candidate.id === 'string' && typeof candidate.name === 'string' && typeof candidate.email === 'string';
  }

  private isValidCustomer(data: unknown): data is Customer {
    const candidate = data as Customer;
    return !!candidate && typeof candidate.id === 'string' && typeof candidate.name === 'string' && typeof candidate.phone === 'string';
  }

  private async ensureSupabaseImport(): Promise<void> {
    if (this.supabaseImportDone) return;
    if (!this.supabaseImportPromise) {
      this.supabaseImportPromise = this.loadSupabaseImport();
    }
    await this.supabaseImportPromise;
  }

  private async loadSupabaseImport(): Promise<void> {
    try {
      const response = await fetch('/api/import/supabase', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        this.supabaseImportDone = true;
        return;
      }

      const payload = await response.json() as {
        users?: unknown[];
        customers?: unknown[];
        warnings?: string[];
      };

      const importedUsers = Array.isArray(payload.users) ? payload.users.filter(user => this.isValidUser(user)) : [];
      const importedCustomers = Array.isArray(payload.customers) ? payload.customers.filter(customer => this.isValidCustomer(customer)) : [];
      const externalUserIdToResolved = new Map<string, string>();

      if (importedUsers.length > 0) {
        const localUsers = this.users.filter(user => user.id.startsWith('local_'));
        const currentUser = this.users.find(user => user.id === CURRENT_USER_ID) || INITIAL_USERS.find(user => user.id === CURRENT_USER_ID);
        const baselineUsers = currentUser ? [currentUser, ...localUsers] : [...localUsers];
        this.users.splice(0, this.users.length, ...baselineUsers);
        this.mergeImportedUsers(importedUsers);
        if (localUsers.length > 0) {
          this.mergeImportedUsers(localUsers);
        }

        importedUsers.forEach((importedUser) => {
          const resolved = this.users.find(
            (user) => (user.email || '').toLowerCase() === (importedUser.email || '').toLowerCase()
          );
          externalUserIdToResolved.set(importedUser.id, resolved?.id || importedUser.id);
        });
      }

      if (importedCustomers.length > 0) {
        const remappedCustomers = importedCustomers.map((customer) => {
          if (!customer.ownerId) return customer;
          return {
            ...customer,
            ownerId: externalUserIdToResolved.get(customer.ownerId) || customer.ownerId,
          };
        });

        const localCustomers = this.customers.filter(customer => customer.id.startsWith('local_'));
        this.customers = [...localCustomers];
        this.mergeImportedCustomers(remappedCustomers);
        if (localCustomers.length > 0) {
          this.mergeImportedCustomers(localCustomers);
        }
      }

      // Remove dados de demonstração/órfãos quando já existem clientes reais importados.
      if (importedCustomers.length > 0) {
        this.pruneOrphanConversationData();
      }

      this.persistLocalEntities();
      this.ensureSessionIsValid();

      if (Array.isArray(payload.warnings) && payload.warnings.length > 0) {
        console.warn('[Supabase import] Avisos:', payload.warnings.join(' | '));
      }
    } catch (error) {
      console.warn('[Supabase import] indisponível:', error);
    } finally {
      this.supabaseImportDone = true;
      this.ensureSessionIsValid();
    }
  }

  // --- Auth ---
  isAuthenticated(): boolean {
    return !!CURRENT_USER_ID;
  }

  getCurrentUserId(): string {
    return CURRENT_USER_ID;
  }

  getCurrentUser(): User | undefined {
    return this.users.find(user => user.id === CURRENT_USER_ID);
  }

  async authenticateUser(email: string, password: string): Promise<{ success: boolean; error?: string }> {
    await this.ensureSupabaseImport();

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPassword = password.trim();

    const user = this.users.find(u => (u.email || '').toLowerCase() === normalizedEmail);
    if (!user) {
      return { success: false, error: 'Email não encontrado.' };
    }

    const storedPassword = String(user.password || '').trim();
    if (!storedPassword) {
      return { success: false, error: 'Este funcionário não tem palavra-passe definida.' };
    }

    if (storedPassword !== normalizedPassword) {
      return { success: false, error: 'Palavra-passe incorreta.' };
    }

    this.setSessionUserId(user.id);
    return { success: true };
  }

  logoutUser() {
    this.setSessionUserId('');
  }

  // --- Users ---
  async getUsers(): Promise<User[]> {
    await this.ensureSupabaseImport();
    const visibleUsers = this.getVisibleUsers();
    return new Promise(resolve => setTimeout(() => resolve([...visibleUsers]), 200));
  }

  private async saveUserToLocalSql(payload: {
    id?: string;
    sourceId?: string;
    previousEmail?: string;
    name?: string;
    email?: string;
    password?: string;
    role?: Role;
    avatarUrl?: string;
    isAiAssistant?: boolean;
    aiAllowedSites?: string[];
  }): Promise<User | null> {
    if (!this.isBrowser()) return null;

    const response = await fetch('/api/users/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => ({})) as {
      success?: boolean;
      user?: User;
      error?: unknown;
    };

    if (!response.ok || !result.success) {
      const errorText =
        typeof result.error === 'string'
          ? result.error
          : result.error
            ? JSON.stringify(result.error)
            : `Falha ao guardar funcionário (${response.status}).`;
      throw new Error(errorText);
    }

    return result.user && this.isValidUser(result.user) ? result.user : null;
  }

  async createUser(user: Omit<User, 'id' | 'avatarUrl'> & { password?: string; avatarUrl?: string }): Promise<User> {
    const normalizedEmail = String(user.email || '').trim().toLowerCase();
    const emailAlreadyExists = this.getVisibleUsers().some(
      (existing) => String(existing.email || '').trim().toLowerCase() === normalizedEmail
    );
    if (normalizedEmail && emailAlreadyExists) {
      throw new Error(`Já existe funcionário com o email ${normalizedEmail}.`);
    }

    const draftId = `local_u${Date.now()}`;
    const newUser: User = { 
        ...user, 
        id: draftId,
        password: user.password || '',
        avatarUrl: user.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&background=random`,
        isAiAssistant: !!user.isAiAssistant,
        aiAllowedSites: Array.isArray(user.aiAllowedSites) ? user.aiAllowedSites.map((site) => String(site || '').trim()).filter(Boolean) : [],
    };

    const savedUser = await this.saveUserToLocalSql({
      id: draftId,
      name: newUser.name,
      email: newUser.email,
      password: newUser.password || '',
      role: newUser.role,
      avatarUrl: newUser.avatarUrl,
      isAiAssistant: !!newUser.isAiAssistant,
      aiAllowedSites: Array.isArray(newUser.aiAllowedSites) ? newUser.aiAllowedSites : [],
    });

    const finalUser = savedUser
      ? { ...newUser, ...savedUser, avatarUrl: newUser.avatarUrl || savedUser.avatarUrl, id: savedUser.id || draftId }
      : newUser;

    const existingIndex = this.users.findIndex(existing => (existing.email || '').toLowerCase() === finalUser.email.toLowerCase());
    if (existingIndex >= 0) {
      this.users[existingIndex] = finalUser;
    } else {
      this.users.push(finalUser);
    }

    this.persistLocalEntities();
    return finalUser;
  }

  async updateUser(id: string, updates: Partial<User>): Promise<void> {
    const idx = this.users.findIndex(u => u.id === id);
    if (idx === -1) return;

    const currentUser = this.users[idx];
    const nextUser = { ...currentUser, ...updates };
    const normalizedNextEmail = String(nextUser.email || '').trim().toLowerCase();
    if (normalizedNextEmail) {
      const emailAlreadyInUse = this.getVisibleUsers().some(
        (existing) =>
          String(existing.email || '').trim().toLowerCase() === normalizedNextEmail &&
          String(existing.id || '').trim() !== String(currentUser.id || '').trim()
      );
      if (emailAlreadyInUse) {
        throw new Error(`Já existe funcionário com o email ${normalizedNextEmail}.`);
      }
    }

    if (this.isBrowser()) {
      const savedUser = await this.saveUserToLocalSql({
        id: currentUser.id,
        sourceId: currentUser.id.startsWith('ext_u_') ? currentUser.id.slice(6) : undefined,
        previousEmail: currentUser.email,
        name: nextUser.name,
        email: nextUser.email,
        password: nextUser.password || '',
        role: nextUser.role,
        avatarUrl: nextUser.avatarUrl || '',
        isAiAssistant: !!nextUser.isAiAssistant,
        aiAllowedSites: Array.isArray(nextUser.aiAllowedSites) ? nextUser.aiAllowedSites : [],
      });

      if (savedUser) {
        this.users[idx] = {
          ...nextUser,
          ...savedUser,
          avatarUrl: nextUser.avatarUrl || savedUser.avatarUrl,
          id: currentUser.id,
        };
      } else {
        this.users[idx] = nextUser;
      }
    } else {
      this.users[idx] = nextUser;
    }

    this.persistLocalEntities();
    this.ensureSessionIsValid();
  }

  async deleteUser(id: string, actorUserId?: string): Promise<void> {
    const targetId = String(id || '').trim();
    if (!targetId) return;
    if (!this.isBrowser()) {
      this.users = this.users.filter((user) => user.id !== targetId);
      this.persistLocalEntities();
      this.ensureSessionIsValid();
      return;
    }

    const primaryResponse = await fetch(`/api/users/${encodeURIComponent(targetId)}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actorUserId: String(actorUserId || this.getCurrentUserId() || '').trim(),
      }),
    });
    let response = primaryResponse;
    if (primaryResponse.status === 404) {
      // Compatibilidade com backend antigo sem endpoint dedicado.
      response = await fetch('/api/users/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: targetId,
          delete: true,
          actorUserId: String(actorUserId || this.getCurrentUserId() || '').trim(),
        }),
      });
    }

    const result = await response.json().catch(() => ({})) as {
      success?: boolean;
      error?: unknown;
    };
    if (!response.ok || !result.success) {
      const errorText =
        typeof result.error === 'string'
          ? result.error
          : result.error
            ? JSON.stringify(result.error)
            : `Falha ao eliminar funcionário (${response.status}).`;
      throw new Error(errorText);
    }

    this.users = this.users.filter((user) => user.id !== targetId);
    this.persistLocalEntities();
    this.ensureSessionIsValid();
  }

  // --- Customers ---
  async getCustomers(): Promise<Customer[]> {
    await this.ensureSupabaseImport();
    return [...this.customers];
  }

  async triggerFinancasAutologin(
    customerId: string,
    options?: { actorUserId?: string; headless?: boolean; closeAfterSubmit?: boolean }
  ): Promise<{ success: boolean; message: string; loginState?: string; headless?: boolean }> {
    if (!this.isBrowser()) {
      throw new Error('Autologin disponível apenas no browser.');
    }

    const targetId = String(customerId || '').trim();
    if (!targetId) {
      throw new Error('Cliente inválido para autologin.');
    }

    const response = await fetch(`/api/customers/${encodeURIComponent(targetId)}/autologin/financas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actorUserId: String(options?.actorUserId || this.getCurrentUserId() || '').trim() || null,
        headless: options?.headless ?? false,
        closeAfterSubmit: options?.closeAfterSubmit ?? false,
      }),
    });

    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      message?: unknown;
      error?: unknown;
      code?: unknown;
      loginState?: unknown;
      headless?: unknown;
    };

    if (!response.ok || !payload.success) {
      const errorText =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : `Falha no autologin Portal das Finanças (${response.status}).`;
      const enrichedError = new Error(errorText) as Error & { code?: string };
      if (payload.code !== undefined && payload.code !== null && String(payload.code).trim()) {
        enrichedError.code = String(payload.code).trim();
      }
      throw enrichedError;
    }

    return {
      success: true,
      message: String(payload.message || 'Autologin iniciado.'),
      loginState: payload.loginState ? String(payload.loginState) : undefined,
      headless: typeof payload.headless === 'boolean' ? payload.headless : undefined,
    };
  }

  async triggerSegSocialAutologin(
    customerId: string,
    options?: { actorUserId?: string; headless?: boolean; closeAfterSubmit?: boolean }
  ): Promise<{ success: boolean; message: string; loginState?: string; headless?: boolean }> {
    if (!this.isBrowser()) {
      throw new Error('Autologin disponível apenas no browser.');
    }

    const targetId = String(customerId || '').trim();
    if (!targetId) {
      throw new Error('Cliente inválido para autologin.');
    }

    const response = await fetch(`/api/customers/${encodeURIComponent(targetId)}/autologin/seg-social`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actorUserId: String(options?.actorUserId || this.getCurrentUserId() || '').trim() || null,
        headless: options?.headless ?? false,
        closeAfterSubmit: options?.closeAfterSubmit ?? false,
      }),
    });

    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      message?: unknown;
      error?: unknown;
      code?: unknown;
      loginState?: unknown;
      headless?: unknown;
    };

    if (!response.ok || !payload.success) {
      const errorText =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : `Falha no autologin Segurança Social Direta (${response.status}).`;
      const enrichedError = new Error(errorText) as Error & { code?: string };
      if (payload.code !== undefined && payload.code !== null && String(payload.code).trim()) {
        enrichedError.code = String(payload.code).trim();
      }
      throw enrichedError;
    }

    return {
      success: true,
      message: String(payload.message || 'Autologin iniciado.'),
      loginState: payload.loginState ? String(payload.loginState) : undefined,
      headless: typeof payload.headless === 'boolean' ? payload.headless : undefined,
    };
  }

  async createCustomer(
    customer: Omit<Customer, 'id' | 'allowAutoResponses'> & { allowAutoResponses?: boolean },
    options?: { syncToSupabase?: boolean }
  ): Promise<Customer> {
    const draftCustomer: Customer = { 
        ...customer, 
        id: `local_c${Date.now()}`,
        allowAutoResponses: customer.allowAutoResponses !== undefined ? customer.allowAutoResponses : true
    };

    const syncToSupabase = options?.syncToSupabase !== false;

    let savedCustomer = draftCustomer;
    if (this.isBrowser()) {
      const response = await fetch('/api/customers/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: draftCustomer.id,
          name: draftCustomer.name,
          contactName: draftCustomer.contactName || '',
          company: draftCustomer.company,
          phone: draftCustomer.phone,
          email: draftCustomer.email || '',
          ownerId: draftCustomer.ownerId,
          type: draftCustomer.type,
          contacts: draftCustomer.contacts,
          allowAutoResponses: draftCustomer.allowAutoResponses,
          documentsFolder: draftCustomer.documentsFolder || '',
          nif: draftCustomer.nif || '',
          niss: draftCustomer.niss || '',
          senhaFinancas: draftCustomer.senhaFinancas || '',
          senhaSegurancaSocial: draftCustomer.senhaSegurancaSocial || '',
          tipoIva: draftCustomer.tipoIva || '',
          morada: draftCustomer.morada || '',
          notes: draftCustomer.notes || '',
          certidaoPermanenteNumero: draftCustomer.certidaoPermanenteNumero || '',
          certidaoPermanenteValidade: draftCustomer.certidaoPermanenteValidade || '',
          rcbeNumero: draftCustomer.rcbeNumero || '',
          rcbeData: draftCustomer.rcbeData || '',
          dataConstituicao: draftCustomer.dataConstituicao || '',
          inicioAtividade: draftCustomer.inicioAtividade || '',
          caePrincipal: draftCustomer.caePrincipal || '',
          codigoReparticaoFinancas: draftCustomer.codigoReparticaoFinancas || '',
          tipoContabilidade: draftCustomer.tipoContabilidade || '',
          estadoCliente: draftCustomer.estadoCliente || '',
          contabilistaCertificado: draftCustomer.contabilistaCertificado || '',
          managers: Array.isArray(draftCustomer.managers) ? draftCustomer.managers : [],
          accessCredentials: Array.isArray(draftCustomer.accessCredentials) ? draftCustomer.accessCredentials : [],
          agregadoFamiliar: Array.isArray(draftCustomer.agregadoFamiliar) ? draftCustomer.agregadoFamiliar : [],
          fichasRelacionadas: Array.isArray(draftCustomer.fichasRelacionadas) ? draftCustomer.fichasRelacionadas : [],
          syncToSupabase,
        }),
      });

      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        customer?: Customer;
        error?: unknown;
      };

      if (!response.ok || !payload.success) {
        const errorText =
          typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha ao guardar cliente (${response.status}).`;
        throw new Error(errorText);
      }

      if (payload.customer && this.isValidCustomer(payload.customer)) {
        savedCustomer = payload.customer;
      }
    }

    const existingIndex = this.customers.findIndex((existing) => {
      if (existing.id === savedCustomer.id) return true;
      const samePhone =
        this.normalizePhoneDigits(existing.phone || '') &&
        this.normalizePhoneDigits(existing.phone || '') === this.normalizePhoneDigits(savedCustomer.phone || '');
      if (samePhone) return true;
      return (existing.email || '').toLowerCase() === (savedCustomer.email || '').toLowerCase();
    });

    if (existingIndex >= 0) this.customers[existingIndex] = savedCustomer;
    else this.customers.push(savedCustomer);
    this.persistLocalEntities();
    return savedCustomer;
  }

  async updateCustomer(id: string, updates: Partial<Customer>, options?: { syncToSupabase?: boolean }): Promise<void> {
      const idx = this.customers.findIndex(c => c.id === id);
      if(idx !== -1) {
          const nextCustomer = { ...this.customers[idx], ...updates };
          const syncToSupabase = options?.syncToSupabase !== false;
          if (this.isBrowser()) {
            const response = await fetch('/api/customers/sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: nextCustomer.id,
                sourceId: nextCustomer.id.startsWith('ext_c_') ? nextCustomer.id.slice(6) : undefined,
                name: nextCustomer.name,
                contactName: nextCustomer.contactName || '',
                company: nextCustomer.company,
                phone: nextCustomer.phone,
                email: nextCustomer.email || '',
                ownerId: nextCustomer.ownerId,
                type: nextCustomer.type,
                contacts: nextCustomer.contacts,
                allowAutoResponses: nextCustomer.allowAutoResponses,
                documentsFolder: nextCustomer.documentsFolder || '',
                nif: nextCustomer.nif || '',
                niss: nextCustomer.niss || '',
                senhaFinancas: nextCustomer.senhaFinancas || '',
                senhaSegurancaSocial: nextCustomer.senhaSegurancaSocial || '',
                tipoIva: nextCustomer.tipoIva || '',
                morada: nextCustomer.morada || '',
                notes: nextCustomer.notes || '',
                certidaoPermanenteNumero: nextCustomer.certidaoPermanenteNumero || '',
                certidaoPermanenteValidade: nextCustomer.certidaoPermanenteValidade || '',
                rcbeNumero: nextCustomer.rcbeNumero || '',
                rcbeData: nextCustomer.rcbeData || '',
                dataConstituicao: nextCustomer.dataConstituicao || '',
                inicioAtividade: nextCustomer.inicioAtividade || '',
                caePrincipal: nextCustomer.caePrincipal || '',
                codigoReparticaoFinancas: nextCustomer.codigoReparticaoFinancas || '',
                tipoContabilidade: nextCustomer.tipoContabilidade || '',
                estadoCliente: nextCustomer.estadoCliente || '',
                contabilistaCertificado: nextCustomer.contabilistaCertificado || '',
                managers: Array.isArray(nextCustomer.managers) ? nextCustomer.managers : [],
                accessCredentials: Array.isArray(nextCustomer.accessCredentials) ? nextCustomer.accessCredentials : [],
                agregadoFamiliar: Array.isArray(nextCustomer.agregadoFamiliar) ? nextCustomer.agregadoFamiliar : [],
                fichasRelacionadas: Array.isArray(nextCustomer.fichasRelacionadas) ? nextCustomer.fichasRelacionadas : [],
                syncToSupabase,
              }),
            });

            const payload = await response.json().catch(() => ({})) as {
              success?: boolean;
              customer?: Customer;
              error?: unknown;
            };

            if (!response.ok || !payload.success) {
              const errorText =
                typeof payload.error === 'string'
                  ? payload.error
                  : payload.error
                    ? JSON.stringify(payload.error)
                    : `Falha ao guardar cliente (${response.status}).`;
              throw new Error(errorText);
            }

            if (payload.customer && this.isValidCustomer(payload.customer)) {
              this.customers[idx] = payload.customer;
            } else {
              this.customers[idx] = nextCustomer;
            }

            // Recarrega após guardar para refletir atualizações espelho (relações bidirecionais)
            // feitas no backend em outras fichas além da que foi editada.
            try {
              this.supabaseImportDone = false;
              this.supabaseImportPromise = null;
              await this.ensureSupabaseImport();
            } catch (refreshError) {
              console.warn('[Customers] Falha ao recarregar lista após update:', refreshError);
            }
          } else {
            this.customers[idx] = nextCustomer;
          }
          this.persistLocalEntities();
      }
  }

  async getCustomerDocuments(customerId: string): Promise<{
    folderPath: string;
    storageFolderPath: string;
    configured: boolean;
    currentRelativePath: string;
    canGoUp: boolean;
    entries: Array<{ type: 'file' | 'directory'; name: string; relativePath: string; size?: number; updatedAt: string }>;
    files: Array<{ name: string; size: number; updatedAt: string; relativePath: string }>;
  }> {
    return this.getCustomerDocumentsAtPath(customerId, '');
  }

  async getCustomerDocumentsAtPath(customerId: string, relativePath = ''): Promise<{
    folderPath: string;
    storageFolderPath: string;
    configured: boolean;
    currentRelativePath: string;
    canGoUp: boolean;
    entries: Array<{ type: 'file' | 'directory'; name: string; relativePath: string; size?: number; updatedAt: string }>;
    files: Array<{ name: string; size: number; updatedAt: string; relativePath: string }>;
  }> {
    if (!this.isBrowser()) {
      return { folderPath: '', storageFolderPath: '', configured: false, currentRelativePath: '', canGoUp: false, entries: [], files: [] };
    }

    const query = new URLSearchParams();
    if (String(relativePath || '').trim()) query.set('path', String(relativePath || '').trim());
    const response = await fetch(`/api/customers/${encodeURIComponent(customerId)}/documents${query.toString() ? `?${query.toString()}` : ''}`, {
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      folderPath?: string;
      storageFolderPath?: string;
      configured?: boolean;
      currentRelativePath?: string;
      canGoUp?: boolean;
      entries?: Array<{ type?: string; name?: string; relativePath?: string; size?: number; updatedAt?: string }>;
      files?: Array<{ name?: string; size?: number; updatedAt?: string; relativePath?: string }>;
      error?: unknown;
    };

    if (!response.ok || !payload.success) {
      const errorText =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : `Falha ao listar documentos (${response.status}).`;
      throw new Error(errorText);
    }

    return {
      folderPath: String(payload.folderPath || ''),
      storageFolderPath: String(payload.storageFolderPath || ''),
      configured: !!payload.configured,
      currentRelativePath: String(payload.currentRelativePath || ''),
      canGoUp: !!payload.canGoUp,
      entries: Array.isArray(payload.entries)
        ? payload.entries
            .map((item) => ({
              type: String(item.type || '').trim() === 'directory' ? 'directory' : 'file',
              name: String(item.name || '').trim(),
              relativePath: String(item.relativePath || '').trim(),
              size: Number(item.size || 0) || undefined,
              updatedAt: String(item.updatedAt || '').trim() || new Date().toISOString(),
            }))
            .filter((item) => item.name && item.relativePath)
        : [],
      files: Array.isArray(payload.files)
        ? payload.files
            .map((item) => ({
              name: String(item.name || '').trim(),
              size: Number(item.size || 0),
              updatedAt: String(item.updatedAt || '').trim() || new Date().toISOString(),
              relativePath: String(item.relativePath || item.name || '').trim(),
            }))
            .filter((item) => item.name && item.relativePath)
        : [],
    };
  }

  async uploadCustomerDocument(customerId: string, file: File, relativePath = ''): Promise<{
    fileName: string;
    size: number;
    folderPath: string;
    relativePath: string;
    fullPath: string;
  }> {
    if (!this.isBrowser()) {
      throw new Error('Upload disponível apenas no browser.');
    }

    const contentBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Falha ao ler ficheiro local.'));
      reader.readAsDataURL(file);
    });

    const response = await fetch(`/api/customers/${encodeURIComponent(customerId)}/documents/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        contentBase64,
        path: String(relativePath || '').trim(),
      }),
    });

    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      fileName?: string;
      size?: number;
      folderPath?: string;
      relativePath?: string;
      fullPath?: string;
      error?: unknown;
    };

    if (!response.ok || !payload.success) {
      const errorText =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : `Falha ao guardar documento (${response.status}).`;
      throw new Error(errorText);
    }

    return {
      fileName: String(payload.fileName || file.name),
      size: Number(payload.size || file.size || 0),
      folderPath: String(payload.folderPath || ''),
      relativePath: String(payload.relativePath || file.name),
      fullPath: String(payload.fullPath || ''),
    };
  }

  async ingestCustomerDocumentWithAI(
    customerId: string,
    file: File,
    documentType:
      | 'certidao_permanente'
      | 'pacto_social'
      | 'inicio_atividade'
      | 'rcbe'
      | 'cartao_cidadao'
      | 'outros'
  ): Promise<{
    success: boolean;
    code?: string;
    error?: string;
    warnings?: string[];
    updatedFields?: string[];
    extraction?: Record<string, unknown>;
    savedDocument?: {
      fileName: string;
      relativePath: string;
      fullPath: string;
      folderPath: string;
    };
    customer?: Customer;
    existingCustomer?: { id: string; name: string; company?: string; nif?: string };
    suggestedCustomer?: Partial<Customer> & { nif?: string };
  }> {
    if (!this.isBrowser()) {
      throw new Error('Ação disponível apenas no browser.');
    }

    const contentBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Falha ao ler ficheiro local.'));
      reader.readAsDataURL(file);
    });

    const response = await fetch(`/api/customers/${encodeURIComponent(customerId)}/documents/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type || '',
        contentBase64,
        documentType,
        actorUserId: CURRENT_USER_ID || null,
      }),
    });

    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      code?: string;
      error?: unknown;
      warnings?: unknown;
      updatedFields?: unknown;
      extraction?: unknown;
      customer?: unknown;
      savedDocument?: unknown;
      existingCustomer?: unknown;
      suggestedCustomer?: unknown;
    };

    const structuredResult = {
      success: !!payload.success,
      code: String(payload.code || '').trim() || undefined,
      error:
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : undefined,
      warnings: Array.isArray(payload.warnings)
        ? payload.warnings.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      updatedFields: Array.isArray(payload.updatedFields)
        ? payload.updatedFields.map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      extraction: payload.extraction && typeof payload.extraction === 'object'
        ? (payload.extraction as Record<string, unknown>)
        : undefined,
      customer: payload.customer && this.isValidCustomer(payload.customer)
        ? (payload.customer as Customer)
        : undefined,
      savedDocument: payload.savedDocument && typeof payload.savedDocument === 'object'
        ? {
            fileName: String((payload.savedDocument as { fileName?: string }).fileName || '').trim(),
            relativePath: String((payload.savedDocument as { relativePath?: string }).relativePath || '').trim(),
            fullPath: String((payload.savedDocument as { fullPath?: string }).fullPath || '').trim(),
            folderPath: String((payload.savedDocument as { folderPath?: string }).folderPath || '').trim(),
          }
        : undefined,
      existingCustomer: payload.existingCustomer && typeof payload.existingCustomer === 'object'
        ? {
            id: String((payload.existingCustomer as { id?: string }).id || '').trim(),
            name: String((payload.existingCustomer as { name?: string }).name || '').trim(),
            company: String((payload.existingCustomer as { company?: string }).company || '').trim(),
            nif: String((payload.existingCustomer as { nif?: string }).nif || '').trim(),
          }
        : undefined,
      suggestedCustomer: payload.suggestedCustomer && typeof payload.suggestedCustomer === 'object'
        ? (payload.suggestedCustomer as Partial<Customer>)
        : undefined,
    };

    if (!response.ok && !structuredResult.code) {
      throw new Error(
        structuredResult.error || `Falha ao inserir documento (${response.status}).`
      );
    }

    return structuredResult;
  }

  async detectCustomerByDocumentAI(
    file: File,
    documentType:
      | 'certidao_permanente'
      | 'pacto_social'
      | 'inicio_atividade'
      | 'rcbe'
      | 'cartao_cidadao'
      | 'outros'
  ): Promise<{
    success: boolean;
    code?: string;
    error?: string;
    nif?: string;
    extraction?: Record<string, unknown>;
    customer?: {
      id: string;
      name: string;
      company?: string;
      nif?: string;
      documentsFolder?: string;
    };
    suggestedCustomer?: Partial<Customer>;
  }> {
    if (!this.isBrowser()) {
      throw new Error('Ação disponível apenas no browser.');
    }

    const contentBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Falha ao ler ficheiro local.'));
      reader.readAsDataURL(file);
    });

    const response = await fetch('/api/customers/documents/detect-target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type || '',
        contentBase64,
        documentType,
      }),
    });

    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      code?: string;
      error?: unknown;
      nif?: unknown;
      extraction?: unknown;
      customer?: unknown;
      suggestedCustomer?: unknown;
    };

    const result = {
      success: !!payload.success,
      code: String(payload.code || '').trim() || undefined,
      error:
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : undefined,
      nif: String(payload.nif || '').trim() || undefined,
      extraction: payload.extraction && typeof payload.extraction === 'object'
        ? (payload.extraction as Record<string, unknown>)
        : undefined,
      customer: payload.customer && typeof payload.customer === 'object'
        ? {
            id: String((payload.customer as { id?: string }).id || '').trim(),
            name: String((payload.customer as { name?: string }).name || '').trim(),
            company: String((payload.customer as { company?: string }).company || '').trim(),
            nif: String((payload.customer as { nif?: string }).nif || '').trim(),
            documentsFolder: String((payload.customer as { documentsFolder?: string }).documentsFolder || '').trim(),
          }
        : undefined,
      suggestedCustomer: payload.suggestedCustomer && typeof payload.suggestedCustomer === 'object'
        ? (payload.suggestedCustomer as Partial<Customer>)
        : undefined,
    };

    if (!response.ok && !result.code) {
      throw new Error(result.error || `Falha na deteção automática (${response.status}).`);
    }

    return result;
  }

  async importCustomerDocumentFromUrl(
    customerId: string,
    sourceUrl: string,
    fileName = '',
    relativePath = ''
  ): Promise<{
    fileName: string;
    size: number;
    folderPath: string;
    relativePath: string;
    fullPath: string;
  }> {
    if (!this.isBrowser()) {
      throw new Error('Importação disponível apenas no browser.');
    }

    const response = await fetch(`/api/customers/${encodeURIComponent(customerId)}/documents/import-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: String(sourceUrl || '').trim(),
        fileName: String(fileName || '').trim(),
        path: String(relativePath || '').trim(),
      }),
    });

    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      fileName?: string;
      size?: number;
      folderPath?: string;
      relativePath?: string;
      fullPath?: string;
      error?: unknown;
    };

    if (!response.ok || !payload.success) {
      const errorText =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : `Falha ao importar documento (${response.status}).`;
      throw new Error(errorText);
    }

    return {
      fileName: String(payload.fileName || fileName || 'documento'),
      size: Number(payload.size || 0),
      folderPath: String(payload.folderPath || ''),
      relativePath: String(payload.relativePath || fileName || 'documento'),
      fullPath: String(payload.fullPath || ''),
    };
  }

  async getCustomerDocumentShareLink(customerId: string, relativePath: string): Promise<{ url: string; fileName: string }> {
    if (!this.isBrowser()) {
      throw new Error('Ação disponível apenas no browser.');
    }
    const query = new URLSearchParams({ path: String(relativePath || '').trim() });
    const response = await fetch(`/api/customers/${encodeURIComponent(customerId)}/documents/share-link?${query.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      url?: string;
      fileName?: string;
      error?: unknown;
    };
    if (!response.ok || !payload.success) {
      const errorText =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : `Falha ao gerar link de ficheiro (${response.status}).`;
      throw new Error(errorText);
    }
    return {
      url: String(payload.url || '').trim(),
      fileName: String(payload.fileName || '').trim(),
    };
  }

  async requestSaftDocument(customerId: string, conversationId: string, documentType: 'declaracao_nao_divida' | 'ies' | 'modelo_22' | 'certidao_permanente' | 'certificado_pme' | 'crc'): Promise<{
    success: boolean;
    jobId?: number;
    status?: string;
    fileName?: string;
    message?: string;
    error?: string;
  }> {
    if (!this.isBrowser()) return { success: false, error: 'Ação disponível apenas no browser.' };

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch('/api/saft/fetch-and-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId,
          conversationId,
          documentType,
          requestedBy: CURRENT_USER_ID || null,
        }),
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        jobId?: number;
        status?: string;
        fileName?: string;
        message?: string;
        error?: unknown;
      };

      if (!response.ok || !payload.success) {
        const errorText =
          typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha no pedido SAFT (${response.status}).`;
        return {
          success: false,
          jobId: payload.jobId,
          status: typeof payload.status === 'string' ? payload.status : 'error',
          fileName: typeof payload.fileName === 'string' ? payload.fileName : undefined,
          message: typeof payload.message === 'string' ? payload.message : undefined,
          error: errorText,
        };
      }

      return {
        success: true,
        jobId: payload.jobId,
        status: payload.status,
        fileName: payload.fileName,
        message: typeof payload.message === 'string' ? payload.message : undefined,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { success: false, error: 'Pedido SAFT demorou demasiado tempo (20s). Verifique o robô/servidor.' };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Falha de rede no pedido SAFT.',
      };
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async syncSaftCompanyDocs(customerId: string, options?: {
    yearsBack?: number;
    force?: boolean;
    documentTypes?: Array<'declaracao_nao_divida' | 'ies' | 'modelo_22' | 'certidao_permanente' | 'certificado_pme' | 'crc'>;
  }): Promise<{
    success: boolean;
    syncedFiles?: number;
    skippedFiles?: number;
    warnings?: string[];
    error?: string;
  }> {
    if (!this.isBrowser()) return { success: false, error: 'Ação disponível apenas no browser.' };

    const response = await fetch('/api/saft/sync-company-docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId,
        yearsBack: Number(options?.yearsBack || 3),
        force: !!options?.force,
        documentTypes: Array.isArray(options?.documentTypes) && options?.documentTypes.length > 0 ? options.documentTypes : undefined,
        requestedBy: CURRENT_USER_ID || null,
      }),
    });

    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      syncedFiles?: number;
      skippedFiles?: number;
      warnings?: unknown;
      error?: unknown;
    };

    if (!response.ok || !payload.success) {
      const errorText =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : `Falha na recolha documental SAFT (${response.status}).`;
      return { success: false, error: errorText };
    }

    return {
      success: true,
      syncedFiles: Number(payload.syncedFiles || 0),
      skippedFiles: Number(payload.skippedFiles || 0),
      warnings: Array.isArray(payload.warnings) ? payload.warnings.map((item) => String(item || '').trim()).filter(Boolean) : [],
    };
  }

  async getSaftJobs(customerId: string): Promise<Array<{
    id: number;
    documentType: 'declaracao_nao_divida' | 'ies' | 'modelo_22' | 'certidao_permanente' | 'certificado_pme' | 'crc' | string;
    status: 'pending' | 'processing' | 'sent' | 'error' | string;
    fileName?: string;
    error?: string;
    updatedAt?: string;
    createdAt?: string;
  }>> {
    if (!this.isBrowser()) return [];

    const [jobsResponse, cacheResponse] = await Promise.all([
      fetch(`/api/saft/jobs/${encodeURIComponent(customerId)}`, {
        headers: { Accept: 'application/json' },
      }),
      fetch(`/api/saft/cache/${encodeURIComponent(customerId)}`, {
        headers: { Accept: 'application/json' },
      }).catch(() => null),
    ]);

    const jobsPayload = await jobsResponse.json().catch(() => ({})) as {
      success?: boolean;
      data?: Array<{
        id?: number;
        document_type?: string;
        status?: string;
        file_name?: string | null;
        error?: string | null;
        updated_at?: string;
        created_at?: string;
      }>;
      error?: unknown;
    };

    if (!jobsResponse.ok || !jobsPayload.success) {
      return [];
    }

    const cachePayload = cacheResponse
      ? await cacheResponse.json().catch(() => ({})) as {
          success?: boolean;
          data?: Array<{
            id?: number;
            documentType?: string;
            fileName?: string;
            fileExists?: boolean;
            updatedAt?: string;
          }>;
        }
      : { success: false, data: [] as Array<{
          id?: number;
          documentType?: string;
          fileName?: string;
          fileExists?: boolean;
          updatedAt?: string;
        }> };

    const rows = Array.isArray(jobsPayload.data) ? jobsPayload.data : [];
    const normalizedRows = rows.map((row) => ({
      id: Number(row.id || 0),
      documentType: String(row.document_type || '').trim(),
      status: String(row.status || '').trim(),
      fileName: String(row.file_name || '').trim() || undefined,
      error: String(row.error || '').trim() || undefined,
      updatedAt: String(row.updated_at || '').trim() || undefined,
      createdAt: String(row.created_at || '').trim() || undefined,
    }));

    const byType = new Map<string, {
      id: number;
      documentType: string;
      status: string;
      fileName?: string;
      error?: string;
      updatedAt?: string;
      createdAt?: string;
    }>();

    normalizedRows.forEach((row) => {
      const key = String(row.documentType || '').trim();
      if (!key || byType.has(key)) return;
      byType.set(key, row);
    });

    const cacheRows = Array.isArray(cachePayload?.data) ? cachePayload.data : [];
    cacheRows.forEach((cacheRow) => {
      const key = String(cacheRow.documentType || '').trim();
      if (!key || !cacheRow.fileExists) return;
      const current = byType.get(key);
      const currentStatus = String(current?.status || '').trim().toLowerCase();
      const shouldOverride = !current || ['error', 'missing'].includes(currentStatus);
      if (!shouldOverride) return;
      byType.set(key, {
        id: Number(cacheRow.id || 0),
        documentType: key,
        status: 'archived',
        fileName: String(cacheRow.fileName || '').trim() || undefined,
        updatedAt: String(cacheRow.updatedAt || '').trim() || undefined,
      });
    });

    return Array.from(byType.values());
  }

  // --- Conversations ---
  async getConversations(): Promise<Conversation[]> {
    await this.ensureSupabaseImport();
    await this.syncConversationsFromBackend();

    if (this.isBrowser()) {
      try {
        const backendConversations = await fetchChatConversationsLocal<Conversation>();
        if (Array.isArray(backendConversations)) {
          const byId = new Map<string, Conversation>();
          this.conversations.forEach((item) => byId.set(item.id, item));
          const validCustomerIds = new Set(this.customers.map((customer) => customer.id));
          backendConversations.forEach((item) => {
            const current = byId.get(item.id);
            const merged = { ...current, ...item };

            const incomingCustomerId = String(item.customerId || '');
            const currentCustomerId = String(current?.customerId || '');
            const incomingIsKnown = incomingCustomerId && validCustomerIds.has(incomingCustomerId);
            const currentIsKnown = currentCustomerId && validCustomerIds.has(currentCustomerId);

            if (!incomingIsKnown && currentIsKnown) {
              merged.customerId = currentCustomerId;
            }

            byId.set(item.id, merged);
          });
          this.conversations = Array.from(byId.values());
        }
      } catch (error) {
        console.warn('[Backend sync] conversas indisponíveis:', error);
      }
    }

    const alignedConversations: Conversation[] = [];
    for (const conversation of this.conversations) {
      alignedConversations.push(await this.alignConversationCustomerByIdPattern(conversation));
    }
    this.conversations = alignedConversations;

    this.dedupeConversations();
    this.pruneOrphanConversationData();

    return [...this.conversations];
  }

  async getConversationById(id: string): Promise<Conversation | undefined> {
    const direct = this.conversations.find(c => c.id === id);
    if (direct) return direct;
    if (id.startsWith('wa_conv_')) {
      const customerId = id.slice('wa_conv_'.length);
      return this.conversations.find(c => c.customerId === customerId);
    }
    return undefined;
  }

  async createConversation(customerId: string): Promise<Conversation> {
      const existing = this.conversations.find(c => c.customerId === customerId);
      if (existing) {
        if (existing.status !== ConversationStatus.CLOSED) return existing;

        const reopened: Conversation = {
          ...existing,
          status: ConversationStatus.OPEN,
          lastMessageAt: new Date().toISOString(),
          unreadCount: 0,
        };

        if (this.isBrowser()) {
          const persisted = await this.syncConversationToLocalSql(reopened);
          const finalConv = persisted || reopened;
          this.conversations = this.conversations.map((item) => (item.id === existing.id ? finalConv : item));
          return finalConv;
        }

        this.conversations = this.conversations.map((item) => (item.id === existing.id ? reopened : item));
        return reopened;
      }

      const newConv: Conversation = {
          id: `conv${Date.now()}`,
          customerId,
          ownerId: CURRENT_USER_ID,
          status: ConversationStatus.OPEN,
          lastMessageAt: new Date().toISOString(),
          unreadCount: 0
      };
      if (this.isBrowser()) {
        const persisted = await this.syncConversationToLocalSql(newConv);
        const finalConv = persisted || newConv;
        this.conversations.push(finalConv);
        return finalConv;
      }

      this.conversations.push(newConv);
      return newConv;
  }

  async updateConversationStatus(id: string, status: ConversationStatus): Promise<void> {
    const conversation = await this.getConversationById(id);
    const targetId = conversation?.id || id;
    const idx = this.conversations.findIndex(c => c.id === targetId);
    if (idx !== -1) {
      const nextConversation = { ...this.conversations[idx], status };
      if (this.isBrowser()) {
        const persisted = await this.syncConversationToLocalSql(nextConversation);
        this.conversations[idx] = persisted || nextConversation;
      } else {
        this.conversations[idx] = nextConversation;
      }
    }
  }

  async assignConversation(id: string, userId: string): Promise<void> {
    const conversation = await this.getConversationById(id);
    const targetId = conversation?.id || id;
    const idx = this.conversations.findIndex(c => c.id === targetId);
    if (idx !== -1) {
        const nextConversation = { ...this.conversations[idx], ownerId: userId };
        if (this.isBrowser()) {
          const persisted = await this.syncConversationToLocalSql(nextConversation);
          this.conversations[idx] = persisted || nextConversation;
        } else {
          this.conversations[idx] = nextConversation;
        }
    }
  }

  async reassignConversation(conversationId: string, newCustomerId: string): Promise<Conversation | null> {
     const conversation = await this.getConversationById(conversationId);
     const targetId = conversation?.id || conversationId;
     const idx = this.conversations.findIndex(c => c.id === targetId);
     if (idx !== -1) {
         const nextConversation = { ...this.conversations[idx], customerId: newCustomerId };
         let finalConversation: Conversation = nextConversation;
         if (this.isBrowser()) {
          const persisted = await this.syncConversationToLocalSql(nextConversation);
          finalConversation = persisted || nextConversation;
          this.conversations[idx] = finalConversation;
         } else {
         this.conversations[idx] = nextConversation;
         }
         this.dedupeConversations();
         this.pruneOrphanConversationData();
         return finalConversation;
     }
     return null;
  }

  async markConversationRead(conversationId: string): Promise<void> {
    const conversation = await this.getConversationById(conversationId);
    const targetId = conversation?.id || conversationId;
    const idx = this.conversations.findIndex((item) => item.id === targetId);
    if (idx !== -1) {
      this.conversations[idx] = { ...this.conversations[idx], unreadCount: 0 };
    }

    if (!this.isBrowser()) return;

    try {
      await markChatConversationRead(targetId);
    } catch (error) {
      // fallback para manter estado local consistente mesmo se endpoint específico falhar
      const conv = this.conversations.find((item) => item.id === targetId);
      if (!conv) return;
      await this.syncConversationToLocalSql({
        ...conv,
        unreadCount: 0,
      });
    }
  }

  async deleteConversation(
    conversationId: string,
    options?: { deleteMessages?: boolean; actorUserId?: string | null }
  ): Promise<void> {
    await this.ensureSupabaseImport();

    const conversation = await this.getConversationById(conversationId);
    const targetId = String(conversation?.id || conversationId || '').trim();
    if (!targetId) {
      throw new Error('Conversa inválida para eliminar.');
    }

    if (this.isBrowser()) {
      await deleteChatConversation(targetId, {
        deleteMessages: options?.deleteMessages !== false,
        actorUserId: options?.actorUserId || CURRENT_USER_ID || null,
      });
    }

    this.conversations = this.conversations.filter((item) => item.id !== targetId);
    this.messages = this.messages.filter((item) => item.conversationId !== targetId);
    this.tasks = this.tasks.filter((item) => item.conversationId !== targetId);
    this.dedupeConversations();
    this.pruneOrphanConversationData();
  }

  // --- Messages ---
  async getMessages(conversationId: string): Promise<Message[]> {
    await this.ensureSupabaseImport();

    const conversation = await this.getConversationById(conversationId);
    const targetConversationId = conversation?.id || conversationId;
    const customer = this.customers.find(item => item.id === conversation?.customerId);
    const digitsFromConversationId = this.extractPhoneDigitsFromConversationId(targetConversationId);
    const customerDigits = this.normalizePhoneDigits(customer?.phone || '');
    const phoneDigits = digitsFromConversationId || customerDigits;

    if (this.isBrowser() && phoneDigits) {
      try {
        // Modo multiconta unificado: mostramos o histórico do número em todas as linhas.
        const rows = await fetchChatMessages(phoneDigits, null);
        if (Array.isArray(rows)) {
          const mappedMessages: Message[] = rows.map((row) => {
            const messageToken = this.resolveMessageToken(row);
            const mediaKind = String(row.media_kind || '').trim() || undefined;
            const hasMedia = Boolean(mediaKind || row.media_path || row.media_remote_id || row.media_remote_url);
            return {
              id: messageToken,
              dbId: Number(row.id || 0) || undefined,
              conversationId: targetConversationId,
              direction: row.direction === 'outbound' ? 'out' : 'in',
              body: row.body || '',
              timestamp: this.parseTimestampToIso(row.timestamp),
              type: this.inferMessageTypeFromRow(row),
              status: this.mapDbStatus(row.status),
              mediaKind,
              mediaPath: String(row.media_path || '').trim() || undefined,
              mediaMimeType: String(row.media_mime_type || '').trim() || undefined,
              mediaFileName: String(row.media_file_name || '').trim() || undefined,
              mediaSize: Number.isFinite(Number(row.media_size)) ? Number(row.media_size) : null,
              mediaProvider: String(row.media_provider || '').trim() || undefined,
              mediaRemoteId: String(row.media_remote_id || '').trim() || undefined,
              mediaRemoteUrl: String(row.media_remote_url || '').trim() || undefined,
              mediaPreviewUrl: hasMedia ? this.buildMediaUrl(messageToken, false) : undefined,
              mediaDownloadUrl: hasMedia ? this.buildMediaUrl(messageToken, true) : undefined,
            };
          });

          const mergedMessages = this.mergeOptimisticMessages(targetConversationId, mappedMessages);

          this.messages = [
            ...this.messages.filter((msg) => msg.conversationId !== targetConversationId),
            ...mergedMessages,
          ];

          const lastTimestamp = mergedMessages[mergedMessages.length - 1]?.timestamp;
          if (conversation && lastTimestamp) {
            conversation.lastMessageAt = lastTimestamp;
          }
        }
      } catch (error) {
        console.warn('[Backend sync] mensagens indisponíveis:', error);
      }
    }

    return this.messages
      .filter(m => m.conversationId === targetConversationId)
      .sort((a,b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  async sendMessage(
    conversationId: string,
    text: string,
    type: 'text' | 'template' | 'image' | 'document' = 'text',
    options?: { templateId?: string; variables?: Record<string, string> }
  ): Promise<Message> {
    await this.ensureSupabaseImport();

    const conversation = await this.getConversationById(conversationId);
    const targetConversationId = conversation?.id || conversationId;
    const customer = this.customers.find(item => item.id === conversation?.customerId);
    const digitsFromConversationId = this.extractPhoneDigitsFromConversationId(targetConversationId);
    const customerDigits = this.normalizePhoneDigits(customer?.phone || '');
    const phoneDigits = digitsFromConversationId || customerDigits;

    if (!phoneDigits) {
      throw new Error('Cliente sem telefone válido para envio.');
    }

    if (this.isBrowser()) {
      const payload = await sendChatMessage({
        conversationId: targetConversationId,
        to: phoneDigits,
        message: text,
        type,
        templateId: options?.templateId,
        variables: options?.variables || {},
        accountId: conversation?.whatsappAccountId || null,
        createdBy: CURRENT_USER_ID || null,
      });

      const nowIso = new Date().toISOString();
      const newMessage: Message = {
        id: payload.messageId || `tmp_${Date.now()}`,
        conversationId: targetConversationId,
        direction: 'out',
        body: type === 'template' ? (text || 'Template enviado') : text,
        timestamp: nowIso,
        type,
        status: 'sent',
      };

      this.messages.push(newMessage);
      const convIdx = this.conversations.findIndex(c => c.id === targetConversationId);
      if (convIdx !== -1) {
        this.conversations[convIdx].lastMessageAt = nowIso;
        if (this.conversations[convIdx].status === ConversationStatus.CLOSED) {
          this.conversations[convIdx].status = ConversationStatus.OPEN;
        }
      }

      return newMessage;
    }

    // Fallback para execução sem browser (testes)
    const fallbackMessage: Message = {
      id: `m${Date.now()}`,
      conversationId,
      direction: 'out',
      body: text,
      timestamp: new Date().toISOString(),
      type,
      status: 'sent',
    };
    this.messages.push(fallbackMessage);
    return fallbackMessage;
  }

  async sendImageMessage(
    conversationId: string,
    input: { mediaPath: string; fileName?: string; mimeType?: string; caption?: string }
  ): Promise<Message> {
    await this.ensureSupabaseImport();
    const conversation = await this.getConversationById(conversationId);
    const targetConversationId = conversation?.id || conversationId;
    const customer = this.customers.find(item => item.id === conversation?.customerId);
    const digitsFromConversationId = this.extractPhoneDigitsFromConversationId(targetConversationId);
    const customerDigits = this.normalizePhoneDigits(customer?.phone || '');
    const phoneDigits = digitsFromConversationId || customerDigits;
    if (!phoneDigits) {
      throw new Error('Cliente sem telefone válido para envio.');
    }

    const caption = String(input.caption || '').trim();
    const fileName = String(input.fileName || '').trim() || 'imagem';
    const mediaPath = String(input.mediaPath || '').trim();
    if (!mediaPath) {
      throw new Error('Caminho da imagem inválido.');
    }

    if (this.isBrowser()) {
      const payload = await sendChatMessage({
        conversationId: targetConversationId,
        to: phoneDigits,
        message: caption,
        type: 'image',
        accountId: conversation?.whatsappAccountId || null,
        mediaPath,
        mediaMimeType: String(input.mimeType || '').trim() || undefined,
        mediaFileName: fileName,
        createdBy: CURRENT_USER_ID || null,
      });

      const nowIso = new Date().toISOString();
      const body = caption ? `[Imagem] ${fileName}\n${caption}` : `[Imagem] ${fileName}`;
      const messageToken = payload.messageId || `tmp_${Date.now()}`;
      const newMessage: Message = {
        id: messageToken,
        conversationId: targetConversationId,
        direction: 'out',
        body,
        timestamp: nowIso,
        type: 'image',
        status: 'sent',
        mediaKind: 'image',
        mediaPath,
        mediaMimeType: String(input.mimeType || '').trim() || undefined,
        mediaFileName: fileName,
        mediaPreviewUrl: this.buildMediaUrl(messageToken, false),
        mediaDownloadUrl: this.buildMediaUrl(messageToken, true),
      };

      this.messages.push(newMessage);
      const convIdx = this.conversations.findIndex(c => c.id === targetConversationId);
      if (convIdx !== -1) {
        this.conversations[convIdx].lastMessageAt = nowIso;
        if (this.conversations[convIdx].status === ConversationStatus.CLOSED) {
          this.conversations[convIdx].status = ConversationStatus.OPEN;
        }
      }

      return newMessage;
    }

    const fallbackMessage: Message = {
      id: `tmp_${Date.now()}`,
      conversationId: targetConversationId,
      direction: 'out',
      body: caption ? `[Imagem] ${fileName}\n${caption}` : `[Imagem] ${fileName}`,
      timestamp: new Date().toISOString(),
      type: 'image',
      status: 'sent',
      mediaKind: 'image',
      mediaPath,
      mediaMimeType: String(input.mimeType || '').trim() || undefined,
      mediaFileName: fileName,
    };
    this.messages.push(fallbackMessage);
    return fallbackMessage;
  }

  async sendDocumentMessage(
    conversationId: string,
    input: { mediaPath: string; fileName?: string; mimeType?: string; caption?: string }
  ): Promise<Message> {
    await this.ensureSupabaseImport();
    const conversation = await this.getConversationById(conversationId);
    const targetConversationId = conversation?.id || conversationId;
    const customer = this.customers.find(item => item.id === conversation?.customerId);
    const digitsFromConversationId = this.extractPhoneDigitsFromConversationId(targetConversationId);
    const customerDigits = this.normalizePhoneDigits(customer?.phone || '');
    const phoneDigits = digitsFromConversationId || customerDigits;
    if (!phoneDigits) {
      throw new Error('Cliente sem telefone válido para envio.');
    }

    const caption = String(input.caption || '').trim();
    const fileName = String(input.fileName || '').trim() || 'documento';
    const mediaPath = String(input.mediaPath || '').trim();
    if (!mediaPath) {
      throw new Error('Caminho do documento inválido.');
    }

    if (this.isBrowser()) {
      const payload = await sendChatMessage({
        conversationId: targetConversationId,
        to: phoneDigits,
        message: caption,
        type: 'document',
        accountId: conversation?.whatsappAccountId || null,
        mediaPath,
        mediaMimeType: String(input.mimeType || '').trim() || undefined,
        mediaFileName: fileName,
        createdBy: CURRENT_USER_ID || null,
      });

      const nowIso = new Date().toISOString();
      const body = caption ? `[Documento] ${fileName}\n${caption}` : `[Documento] ${fileName}`;
      const messageToken = payload.messageId || `tmp_${Date.now()}`;
      const newMessage: Message = {
        id: messageToken,
        conversationId: targetConversationId,
        direction: 'out',
        body,
        timestamp: nowIso,
        type: 'document',
        status: 'sent',
        mediaKind: 'document',
        mediaPath,
        mediaMimeType: String(input.mimeType || '').trim() || undefined,
        mediaFileName: fileName,
        mediaPreviewUrl: this.buildMediaUrl(messageToken, false),
        mediaDownloadUrl: this.buildMediaUrl(messageToken, true),
      };

      this.messages.push(newMessage);
      const convIdx = this.conversations.findIndex(c => c.id === targetConversationId);
      if (convIdx !== -1) {
        this.conversations[convIdx].lastMessageAt = nowIso;
        if (this.conversations[convIdx].status === ConversationStatus.CLOSED) {
          this.conversations[convIdx].status = ConversationStatus.OPEN;
        }
      }

      return newMessage;
    }

    const fallbackMessage: Message = {
      id: `tmp_${Date.now()}`,
      conversationId: targetConversationId,
      direction: 'out',
      body: caption ? `[Documento] ${fileName}\n${caption}` : `[Documento] ${fileName}`,
      timestamp: new Date().toISOString(),
      type: 'document',
      status: 'sent',
      mediaKind: 'document',
      mediaPath,
      mediaMimeType: String(input.mimeType || '').trim() || undefined,
      mediaFileName: fileName,
    };
    this.messages.push(fallbackMessage);
    return fallbackMessage;
  }

  async editMessage(conversationId: string, messageId: string, body: string): Promise<void> {
    const normalizedBody = String(body || '').trim();
    if (!normalizedBody) {
      throw new Error('Mensagem vazia.');
    }
    await this.ensureSupabaseImport();

    if (this.isBrowser()) {
      await editChatMessage(messageId, normalizedBody, CURRENT_USER_ID || null);
    }

    this.messages = this.messages.map((message) => {
      if (message.conversationId !== conversationId || message.id !== messageId) return message;
      return { ...message, body: normalizedBody };
    });
  }

  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    await this.ensureSupabaseImport();

    if (this.isBrowser()) {
      await deleteChatMessage(messageId, CURRENT_USER_ID || null);
    }

    this.messages = this.messages.map((message) => {
      if (message.conversationId !== conversationId || message.id !== messageId) return message;
      return { ...message, body: '[Mensagem apagada]' };
    });
  }

  async forwardMessage(targetConversationId: string, sourceMessageBody: string): Promise<Message> {
    const forwardBody = `Reencaminhada:\n${String(sourceMessageBody || '').trim()}`;
    return this.sendMessage(targetConversationId, forwardBody, 'text');
  }

  async setConversationWhatsAppAccount(
    conversationId: string,
    accountId?: string | null
  ): Promise<Conversation | null> {
    await this.ensureSupabaseImport();
    const current = await this.getConversationById(conversationId);
    const targetId = String(current?.id || conversationId || '').trim();
    if (!targetId) return null;

    const normalizedAccountId = String(accountId || '').trim() || null;
    if (this.isBrowser()) {
      const remote = await apiSetConversationWhatsAppAccount(targetId, normalizedAccountId);
      if (remote?.id) {
        const idx = this.conversations.findIndex((item) => item.id === targetId || item.id === remote.id);
        if (idx !== -1) {
          const merged: Conversation = {
            ...this.conversations[idx],
            id: remote.id,
            whatsappAccountId: remote.whatsappAccountId || null,
          };
          this.conversations[idx] = merged;
          return merged;
        }
      }
    }

    const idx = this.conversations.findIndex((item) => item.id === targetId);
    if (idx === -1) return null;
    const nextConversation: Conversation = {
      ...this.conversations[idx],
      whatsappAccountId: normalizedAccountId,
    };
    if (this.isBrowser()) {
      const persisted = await this.syncConversationToLocalSql(nextConversation);
      this.conversations[idx] = persisted || nextConversation;
      return this.conversations[idx];
    }
    this.conversations[idx] = nextConversation;
    return nextConversation;
  }

  // Private helper to process triggers
  private async runAutomations(message: Message) {
     const conversation = this.conversations.find(c => c.id === message.conversationId);
     if (!conversation) return;

     const customer = this.customers.find(c => c.id === conversation.customerId);
     
     // Filter active triggers
     const activeTriggers = this.triggers.filter(t => t.isActive);

     for (const trigger of activeTriggers) {
         // Check Keyword Triggers
         if (trigger.type === 'keyword' && trigger.keyword && message.body.toLowerCase().includes(trigger.keyword.toLowerCase())) {
             
             // ACTION: Create Task
             // Apply to BOTH 'in' and 'out' messages as requested for hiring/tasks
             if (trigger.action === 'create_task') {
                 await this.createTask({
                     conversationId: message.conversationId,
                     title: trigger.taskTitleTemplate || 'Nova Tarefa Automática',
                     status: TaskStatus.OPEN,
                     priority: TaskPriority.NORMAL,
                     dueDate: new Date(Date.now() + 86400000).toISOString(),
                     assignedUserId: conversation.ownerId || CURRENT_USER_ID,
                     notes: `Gerada automaticamente pelo gatilho: "${trigger.keyword}" na mensagem de ${message.direction === 'in' ? 'Cliente' : 'Agente'}.`
                 });
             }

             // ACTION: Send Message (Auto-reply)
             // ONLY apply to 'in' messages to avoid infinite loops of bot talking to itself
             if (trigger.action === 'send_message' && message.direction === 'in' && trigger.response) {
                 // Check audience permission
                 if (trigger.audience === 'allowed_only' && customer && !customer.allowAutoResponses) {
                     continue; // Skip if customer doesn't allow auto-responses
                 }
                 
                 // Send the auto-reply
                 this.messages.push({
                     id: `auto_${Date.now()}`,
                     conversationId: message.conversationId,
                     direction: 'out',
                     body: trigger.response,
                     timestamp: new Date(Date.now() + 1000).toISOString(), // 1 second delay
                     type: 'text',
                     status: 'sent'
                 });
             }
         }
     }
  }

  async getTemplateCountMonth(): Promise<number> {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      
      return this.messages.filter(m => 
          m.type === 'template' && 
          new Date(m.timestamp) >= startOfMonth
      ).length;
  }

  async getManagedTemplates(kind?: 'template' | 'quick_reply'): Promise<Array<{
    id: string;
    name: string;
    kind: 'template' | 'quick_reply';
    content: string;
    metaTemplateName?: string;
    isActive: boolean;
    updatedAt?: string;
  }>> {
    if (!this.isBrowser()) return [];

    const query = kind ? `?${new URLSearchParams({ kind }).toString()}` : '';
    const response = await fetch(`/api/templates${query}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      data?: Array<{
        id: string;
        name: string;
        kind: 'template' | 'quick_reply';
        content: string;
        metaTemplateName?: string;
        isActive: boolean;
        updatedAt?: string;
      }>;
    };

    if (!response.ok || !payload.success || !Array.isArray(payload.data)) {
      return [];
    }

    return payload.data;
  }

  async saveManagedTemplate(template: {
    id?: string;
    name: string;
    kind: 'template' | 'quick_reply';
    content: string;
    metaTemplateName?: string;
    isActive: boolean;
  }): Promise<void> {
    if (!this.isBrowser()) return;

    const response = await fetch('/api/templates/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...template,
        actorUserId: CURRENT_USER_ID || null,
      }),
    });

    const payload = await response.json().catch(() => ({})) as { success?: boolean; error?: unknown };
    if (!response.ok || !payload.success) {
      const errorText =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : `Falha ao guardar template (${response.status}).`;
      throw new Error(errorText);
    }
  }

  async deleteManagedTemplate(id: string): Promise<void> {
    if (!this.isBrowser()) return;

    const query = new URLSearchParams({ actorUserId: CURRENT_USER_ID || '' });
    const response = await fetch(`/api/templates/${encodeURIComponent(id)}?${query.toString()}`, {
      method: 'DELETE',
    });
    const payload = await response.json().catch(() => ({})) as { success?: boolean; error?: unknown };
    if (!response.ok || !payload.success) {
      const errorText =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : `Falha ao apagar template (${response.status}).`;
      throw new Error(errorText);
    }
  }

  async getDashboardMetrics(): Promise<{
    metrics: {
      totalConversations: number;
      openConversations: number;
      waitingConversations: number;
      closedConversations: number;
      pendingTasks: number;
      overdueTasks: number;
      avgResponseMinutes: number;
    };
    byAgent: Array<{ ownerId: string | null; agentName: string; total: number; active: number }>;
  } | null> {
    if (!this.isBrowser()) return null;
    const response = await fetch('/api/dashboard/metrics', { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      metrics?: {
        totalConversations: number;
        openConversations: number;
        waitingConversations: number;
        closedConversations: number;
        pendingTasks: number;
        overdueTasks: number;
        avgResponseMinutes: number;
      };
      byAgent?: Array<{ ownerId: string | null; agentName: string; total: number; active: number }>;
    };
    if (!response.ok || !payload.success || !payload.metrics) return null;
    return {
      metrics: payload.metrics,
      byAgent: Array.isArray(payload.byAgent) ? payload.byAgent : [],
    };
  }

  async getGlobalSearch(term: string): Promise<{
    customers: Array<{ id: string; name: string; company: string; phone: string; email?: string }>;
    messages: Array<{ id: number; from_number: string; body: string; direction: string; timestamp: string }>;
    tasks: Array<{ id: string; conversation_id: string; title: string; status: string; priority: string; due_date: string }>;
  }> {
    if (!this.isBrowser()) return { customers: [], messages: [], tasks: [] };
    const query = new URLSearchParams({ q: term.trim() });
    const response = await fetch(`/api/search/global?${query.toString()}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      customers?: Array<{ id: string; name: string; company: string; phone: string; email?: string }>;
      messages?: Array<{ id: number; from_number: string; body: string; direction: string; timestamp: string }>;
      tasks?: Array<{ id: string; conversation_id: string; title: string; status: string; priority: string; due_date: string }>;
    };
    if (!response.ok || !payload.success) return { customers: [], messages: [], tasks: [] };
    return {
      customers: Array.isArray(payload.customers) ? payload.customers : [],
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
    };
  }

  async getAlerts(unansweredHours = 6): Promise<{
    overdueTasks: Array<{ id: string; title: string; due_date: string; priority: string; status: string; customer_name?: string }>;
    unansweredConversations: Array<{ conversation_id: string; customer_name: string; phone?: string; last_inbound_at: string; last_outbound_at?: string }>;
  }> {
    if (!this.isBrowser()) return { overdueTasks: [], unansweredConversations: [] };
    const query = new URLSearchParams({ unansweredHours: String(unansweredHours) });
    const response = await fetch(`/api/alerts?${query.toString()}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      overdueTasks?: Array<{ id: string; title: string; due_date: string; priority: string; status: string; customer_name?: string }>;
      unansweredConversations?: Array<{ conversation_id: string; customer_name: string; phone?: string; last_inbound_at: string; last_outbound_at?: string }>;
    };
    if (!response.ok || !payload.success) return { overdueTasks: [], unansweredConversations: [] };
    return {
      overdueTasks: Array.isArray(payload.overdueTasks) ? payload.overdueTasks : [],
      unansweredConversations: Array.isArray(payload.unansweredConversations) ? payload.unansweredConversations : [],
    };
  }

  async getAuditLogs(limit = 100): Promise<Array<{
    id: number;
    actorUserId: string | null;
    entityType: string;
    entityId: string | null;
    action: string;
    details: unknown;
    createdAt: string;
  }>> {
    if (!this.isBrowser()) return [];
    const query = new URLSearchParams({ limit: String(limit) });
    const response = await fetch(`/api/audit/logs?${query.toString()}`, { headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      data?: Array<{
        id: number;
        actorUserId: string | null;
        entityType: string;
        entityId: string | null;
        action: string;
        details: unknown;
        createdAt: string;
      }>;
    };
    if (!response.ok || !payload.success || !Array.isArray(payload.data)) return [];
    return payload.data;
  }

  // --- Tasks ---
  async getTasks(conversationId?: string): Promise<Task[]> {
    if (this.isBrowser()) {
      const query = conversationId
        ? `?${new URLSearchParams({ conversationId }).toString()}`
        : '';
      const response = await fetch(`/api/tasks/local${query}`, {
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        data?: Task[];
      };

      if (response.ok && payload.success && Array.isArray(payload.data)) {
        this.tasks = payload.data;
      }
    }

    if (conversationId) {
      return this.tasks.filter(t => t.conversationId === conversationId);
    }
    return [...this.tasks];
  }

  async importTasksFromSupabase(input: {
    force?: boolean;
    actorUserId?: string;
    tasksTable?: string;
    usersTable?: string;
    customersTable?: string;
  } = {}): Promise<{
    success: boolean;
    summary?: {
      sourceTasks?: number;
      imported?: number;
      updated?: number;
      skippedExisting?: number;
      skippedNoTitle?: number;
      skippedNoCustomer?: number;
      failed?: number;
      createdConversations?: number;
      warnings?: string[];
    };
    error?: string;
  }> {
    if (!this.isBrowser()) return { success: false, error: 'Importação disponível apenas no browser.' };

    const response = await fetch('/api/tasks/import/supabase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        force: !!input.force,
        actorUserId: input.actorUserId || this.getCurrentUserId(),
        tasksTable: input.tasksTable || '',
        usersTable: input.usersTable || '',
        customersTable: input.customersTable || '',
      }),
    });

    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      summary?: {
        sourceTasks?: number;
        imported?: number;
        updated?: number;
        skippedExisting?: number;
        skippedNoTitle?: number;
        skippedNoCustomer?: number;
        failed?: number;
        createdConversations?: number;
        warnings?: string[];
      };
      error?: unknown;
    };

    if (!response.ok || !payload.success) {
      const errorText =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : `Falha ao importar tarefas (${response.status}).`;
      return { success: false, error: errorText };
    }

    return {
      success: true,
      summary: payload.summary || {},
    };
  }

  async createTask(task: Omit<Task, 'id'>): Promise<Task> {
    const newTask: Task = { ...task, id: `t${Date.now()}` };

    if (this.isBrowser()) {
      const response = await fetch('/api/tasks/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTask),
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        task?: Task;
        error?: unknown;
      };

      if (!response.ok || !payload.success) {
        const errorText =
          typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha ao guardar tarefa (${response.status}).`;
        throw new Error(errorText);
      }

      if (payload.task) {
        const existingIndex = this.tasks.findIndex(item => item.id === payload.task!.id);
        if (existingIndex >= 0) this.tasks[existingIndex] = payload.task;
        else this.tasks.push(payload.task);
        return payload.task;
      }
    }

    this.tasks.push(newTask);
    return newTask;
  }

  async updateTaskStatus(id: string, status: TaskStatus): Promise<void> {
    await this.updateTask(id, { status });
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<void> {
    const idx = this.tasks.findIndex(t => t.id === id);
    if (idx !== -1) {
        const nextTask = { ...this.tasks[idx], ...updates };
        if (this.isBrowser()) {
          const response = await fetch('/api/tasks/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(nextTask),
          });
          const payload = await response.json().catch(() => ({})) as {
            success?: boolean;
            task?: Task;
            error?: unknown;
          };

          if (!response.ok || !payload.success) {
            const errorText =
              typeof payload.error === 'string'
                ? payload.error
                : payload.error
                  ? JSON.stringify(payload.error)
                  : `Falha ao guardar tarefa (${response.status}).`;
            throw new Error(errorText);
          }

          this.tasks[idx] = payload.task || nextTask;
          return;
        }

        this.tasks[idx] = nextTask;
    }
  }

  async deleteTask(id: string, options?: { actorUserId?: string }): Promise<void> {
    const targetId = String(id || '').trim();
    if (!targetId) {
      throw new Error('Tarefa inválida.');
    }

    if (this.isBrowser()) {
      const query = new URLSearchParams();
      const actorUserId = String(options?.actorUserId || this.getCurrentUserId() || '').trim();
      if (actorUserId) query.set('actorUserId', actorUserId);

      const response = await fetch(
        `/api/tasks/${encodeURIComponent(targetId)}${query.toString() ? `?${query.toString()}` : ''}`,
        {
          method: 'DELETE',
          headers: { Accept: 'application/json' },
        }
      );

      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        error?: unknown;
      };

      if (!response.ok || !payload.success) {
        const errorText =
          typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha ao eliminar tarefa (${response.status}).`;
        throw new Error(errorText);
      }
    }

    this.tasks = this.tasks.filter((task) => String(task.id || '').trim() !== targetId);
  }

  // --- Calls ---
  async getCalls(customerId?: string): Promise<Call[]> {
     if (this.isBrowser()) {
        const query = customerId
          ? `?${new URLSearchParams({ customerId }).toString()}`
          : '';
        const response = await fetch(`/api/calls/local${query}`, {
          headers: { Accept: 'application/json' },
        });
        const payload = await response.json().catch(() => ({})) as {
          success?: boolean;
          data?: Call[];
        };
        if (response.ok && payload.success && Array.isArray(payload.data)) {
          this.calls = payload.data;
        }
     }

     if(customerId) {
        return this.calls.filter(c => c.customerId === customerId).sort((a,b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
     }
     return [...this.calls];
  }

  async createCall(call: Omit<Call, 'id'>): Promise<Call> {
    const newCall: Call = { ...call, id: `call${Date.now()}` };

    if (this.isBrowser()) {
      const response = await fetch('/api/calls/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCall),
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        call?: Call;
        error?: unknown;
      };

      if (!response.ok || !payload.success) {
        const errorText =
          typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha ao guardar chamada (${response.status}).`;
        throw new Error(errorText);
      }

      if (payload.call) {
        this.calls.push(payload.call);
        return payload.call;
      }
    }

    this.calls.push(newCall);
    return newCall;
  }

  async importCalls(csvData: string): Promise<{ imported: number, failed: number }> {
    const lines = csvData.split('\n');
    let imported = 0;
    let failed = 0;

    for (let i = 0; i < lines.length; i++) {
       const line = lines[i].trim();
       if (!line) continue;

       // Basic header check: if first line contains "data" or "date" (case insensitive), skip it
       if (i === 0 && (line.toLowerCase().includes('data') || line.toLowerCase().includes('date') || line.toLowerCase().includes('duracao'))) {
           continue;
       }

       const [dateStr, durationStr, phoneStr] = line.split(',').map(s => s.trim());
       if(!dateStr || !durationStr || !phoneStr) continue;

       // Find customer by partial phone match
       const customer = this.customers.find(c => c.phone.includes(phoneStr) || phoneStr.includes(c.phone));
       
       if(customer) {
           try {
             await this.createCall({
               customerId: customer.id,
               userId: null,
               startedAt: new Date(dateStr).toISOString(),
               durationSeconds: parseInt(durationStr),
               notes: 'Importado de operadora',
               source: 'import'
             });
             imported++;
           } catch (error) {
             failed++;
           }
       } else {
           failed++;
       }
    }
    return { imported, failed };
  }

  async collectDriObrigacoes(options?: {
    obrigacaoType?: 'dri' | 'dmr' | 'goff_dmr' | 'goff_dri' | 'saft' | 'goff_saft' | 'iva' | 'goff_iva' | 'm22' | 'ies' | 'm10' | 'relatorio_unico' | 'goff_m22' | 'goff_ies' | 'goff_m10' | 'goff_inventario' | 'goff_relatorio_unico';
    year?: number;
    month?: number;
    monthOffset?: number;
    usePreviousMonth?: boolean;
    dryRun?: boolean;
    force?: boolean;
    requestedBy?: string | null;
  }): Promise<{
    success: boolean;
    dryRun?: boolean;
    period?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
    updatePeriod?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
    obrigacao?: { id?: number; nome?: string; periodicidade?: string };
    result?: {
      totalRows?: number;
      matchedCustomers?: number;
      missingCustomers?: number;
      skippedAlreadyCollected?: number;
      skippedInvalidStatus?: number;
      skippedTypeUnknown?: number;
      localSaved?: number;
      recolhasSyncOk?: number;
      periodosUpdateOk?: number;
      syncErrors?: number;
    };
    warnings?: string[];
    missingCustomers?: Array<{ empresa?: string | null; nif?: string | null }>;
    errors?: Array<{ customerId?: string; nif?: string; step?: string; error?: string }>;
    error?: string;
  }> {
    if (!this.isBrowser()) {
      return { success: false, error: 'Ação disponível apenas no browser.' };
    }

    const controller = new AbortController();
    const obrigacaoType =
      options?.obrigacaoType === 'dmr'
        ? 'dmr'
        : options?.obrigacaoType === 'goff_dmr'
          ? 'goff/dmr'
          : options?.obrigacaoType === 'goff_dri'
            ? 'goff/dri'
        : options?.obrigacaoType === 'saft'
          ? 'saft'
          : options?.obrigacaoType === 'goff_saft'
            ? 'goff/saft'
          : options?.obrigacaoType === 'iva'
            ? 'iva'
            : options?.obrigacaoType === 'goff_iva'
              ? 'goff/iva'
            : options?.obrigacaoType === 'goff_m22'
              ? 'goff/m22'
              : options?.obrigacaoType === 'goff_ies'
                ? 'goff/ies'
                : options?.obrigacaoType === 'goff_m10'
                  ? 'goff/m10'
                  : options?.obrigacaoType === 'goff_inventario'
                    ? 'goff/inventario'
                  : options?.obrigacaoType === 'goff_relatorio_unico'
                    ? 'goff/relatorio-unico'
            : options?.obrigacaoType === 'm22'
              ? 'm22'
              : options?.obrigacaoType === 'ies'
                ? 'ies'
                : options?.obrigacaoType === 'm10'
                  ? 'm10'
                  : options?.obrigacaoType === 'relatorio_unico'
                    ? 'relatorio-unico'
          : 'dri';
    const timeoutMs = obrigacaoType === 'iva' || obrigacaoType === 'goff/iva' ? 900000 : 240000;
    const isGoffSaft = obrigacaoType === 'goff/saft';
    const isGoffMonthly = obrigacaoType === 'goff/saft' || obrigacaoType === 'goff/dmr' || obrigacaoType === 'goff/dri';
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    const normalizeWarnings = (raw: unknown): string[] =>
      Array.isArray(raw) ? raw.map((item) => String(item || '').trim()).filter(Boolean) : [];

    const normalizeMissingCustomers = (raw: unknown): Array<{ empresa?: string | null; nif?: string | null }> =>
      Array.isArray(raw) ? raw as Array<{ empresa?: string | null; nif?: string | null }> : [];

    const normalizeErrors = (
      raw: unknown,
    ): Array<{ customerId?: string; nif?: string; step?: string; error?: string }> =>
      Array.isArray(raw)
        ? raw as Array<{ customerId?: string; nif?: string; step?: string; error?: string }>
        : [];

    const mapPayloadResult = (
      payload: {
        success?: boolean;
        dryRun?: boolean;
        period?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
        updatePeriod?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
        obrigacao?: { id?: number; nome?: string; periodicidade?: string };
        result?: {
          totalRows?: number;
          matchedCustomers?: number;
          missingCustomers?: number;
          skippedTypeUnknown?: number;
          localSaved?: number;
          recolhasSyncOk?: number;
          periodosUpdateOk?: number;
          syncErrors?: number;
        };
        warnings?: unknown;
        missingCustomers?: unknown;
        errors?: unknown;
        error?: unknown;
      },
      statusCode: number,
      forceError?: string,
    ) => {
      const warnings = normalizeWarnings(payload.warnings);
      const missingCustomers = normalizeMissingCustomers(payload.missingCustomers);
      const errors = normalizeErrors(payload.errors);

      if (forceError || !payload.success) {
        const errorText =
          forceError ||
          (typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha na recolha ${obrigacaoType.toUpperCase()} (${statusCode}).`);
        return {
          success: false as const,
          dryRun: payload.dryRun,
          period: payload.period,
          updatePeriod: payload.updatePeriod,
          obrigacao: payload.obrigacao,
          result: payload.result,
          warnings,
          missingCustomers,
          errors,
          error: errorText,
        };
      }

      return {
        success: true as const,
        dryRun: payload.dryRun,
        period: payload.period,
        updatePeriod: payload.updatePeriod,
        obrigacao: payload.obrigacao,
        result: payload.result,
        warnings,
        missingCustomers,
        errors,
      };
    };

    try {
      const response = await fetch(`/api/import/obrigacoes/${obrigacaoType}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year: isGoffMonthly ? undefined : options?.year,
          month: isGoffMonthly ? undefined : options?.month,
          monthOffset: isGoffMonthly ? undefined : options?.monthOffset,
          usePreviousMonth: isGoffMonthly ? undefined : options?.usePreviousMonth,
          dryRun: options?.dryRun,
          force: isGoffMonthly ? undefined : options?.force,
          async: obrigacaoType === 'iva',
          requestedBy: options?.requestedBy ?? CURRENT_USER_ID ?? null,
        }),
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        dryRun?: boolean;
        period?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
        updatePeriod?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
        obrigacao?: { id?: number; nome?: string; periodicidade?: string };
        result?: {
          totalRows?: number;
          matchedCustomers?: number;
          missingCustomers?: number;
          skippedTypeUnknown?: number;
          localSaved?: number;
          recolhasSyncOk?: number;
          periodosUpdateOk?: number;
          syncErrors?: number;
        };
        warnings?: unknown;
        missingCustomers?: unknown;
        errors?: unknown;
        error?: unknown;
        async?: boolean;
        jobId?: string;
      };
      if (
        obrigacaoType === 'iva' &&
        response.status === 202 &&
        payload.success &&
        payload.async === true &&
        typeof payload.jobId === 'string' &&
        payload.jobId.trim()
      ) {
        const jobId = payload.jobId.trim();
        while (true) {
          await new Promise((resolve) => window.setTimeout(resolve, 2000));

          const jobResponse = await fetch(`/api/import/obrigacoes/iva/jobs/${encodeURIComponent(jobId)}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
          });
          const jobPayload = await jobResponse.json().catch(() => ({})) as {
            success?: boolean;
            job?: {
              status?: string;
              result?: {
                success?: boolean;
                dryRun?: boolean;
                period?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
                updatePeriod?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
                obrigacao?: { id?: number; nome?: string; periodicidade?: string };
                result?: {
                  totalRows?: number;
                  matchedCustomers?: number;
                  missingCustomers?: number;
                  localSaved?: number;
                  recolhasSyncOk?: number;
                  periodosUpdateOk?: number;
                  syncErrors?: number;
                };
                warnings?: unknown;
                missingCustomers?: unknown;
                errors?: unknown;
                error?: unknown;
              };
              error?: unknown;
            };
            error?: unknown;
          };

          if (!jobResponse.ok || !jobPayload.success || !jobPayload.job) {
            const endpointError =
              typeof jobPayload.error === 'string'
                ? jobPayload.error
                : `Falha ao consultar estado da recolha IVA (${jobResponse.status}).`;
            return mapPayloadResult({}, jobResponse.status, endpointError);
          }

          const jobStatus = String(jobPayload.job.status || '').trim().toLowerCase();
          if (jobStatus === 'queued' || jobStatus === 'running') {
            continue;
          }

          const jobResult = jobPayload.job.result || {};
          if (jobStatus === 'completed') {
            return mapPayloadResult(jobResult, 200);
          }

          const jobError =
            typeof jobPayload.job.error === 'string'
              ? jobPayload.job.error
              : 'Falha no processamento da recolha IVA.';
          return mapPayloadResult(jobResult, 500, jobError);
        }
      }

      return mapPayloadResult(payload, response.status);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return {
          success: false,
          error: `Recolha ${obrigacaoType.toUpperCase()} demorou demasiado tempo (${Math.round(timeoutMs / 1000)}s).`,
        };
      }
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : `Falha de rede na recolha ${obrigacaoType.toUpperCase()}.`,
      };
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async getObrigacoesAutoStatus(): Promise<{
    success: boolean;
    scheduler?: { enabled?: boolean; hour?: number; minute?: number; timezone?: string | null };
    state?: {
      enabled?: boolean;
      running?: boolean;
      lastRunAt?: string | null;
      lastFinishedAt?: string | null;
      nextRunAt?: string | null;
      lastError?: string | null;
      lastSummary?: {
        startedAt?: string;
        finishedAt?: string;
        ok?: number;
        failed?: number;
        jobs?: Array<{
          route?: string;
          success?: boolean;
          statusCode?: number | null;
          startedAt?: string;
          finishedAt?: string;
          error?: string | null;
        }>;
      } | null;
    };
    error?: string;
  }> {
    if (!this.isBrowser()) {
      return { success: false, error: 'Ação disponível apenas no browser.' };
    }

    try {
      const response = await fetch('/api/import/obrigacoes/auto/status', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        scheduler?: { enabled?: boolean; hour?: number; minute?: number; timezone?: string | null };
        state?: {
          enabled?: boolean;
          running?: boolean;
          lastRunAt?: string | null;
          lastFinishedAt?: string | null;
          nextRunAt?: string | null;
          lastError?: string | null;
          lastSummary?: {
            startedAt?: string;
            finishedAt?: string;
            ok?: number;
            failed?: number;
            jobs?: Array<{
              route?: string;
              success?: boolean;
              statusCode?: number | null;
              startedAt?: string;
              finishedAt?: string;
              error?: string | null;
            }>;
          } | null;
        };
        error?: unknown;
      };

      if (!response.ok || !payload.success) {
        const errorText =
          typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha ao carregar estado do scheduler (${response.status}).`;
        return { success: false, error: errorText };
      }

      return {
        success: true,
        scheduler: payload.scheduler,
        state: payload.state,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Falha de rede ao carregar scheduler automático.',
      };
    }
  }

  async runObrigacoesAutoNow(): Promise<{
    success: boolean;
    summary?: {
      startedAt?: string;
      finishedAt?: string;
      ok?: number;
      failed?: number;
      jobs?: Array<{
        route?: string;
        success?: boolean;
        statusCode?: number | null;
        startedAt?: string;
        finishedAt?: string;
        error?: string | null;
      }>;
    };
    state?: {
      running?: boolean;
      lastRunAt?: string | null;
      lastFinishedAt?: string | null;
      nextRunAt?: string | null;
      lastError?: string | null;
    };
    error?: string;
  }> {
    if (!this.isBrowser()) {
      return { success: false, error: 'Ação disponível apenas no browser.' };
    }

    try {
      const response = await fetch('/api/import/obrigacoes/auto/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        summary?: {
          startedAt?: string;
          finishedAt?: string;
          ok?: number;
          failed?: number;
          jobs?: Array<{
            route?: string;
            success?: boolean;
            statusCode?: number | null;
            startedAt?: string;
            finishedAt?: string;
            error?: string | null;
          }>;
        };
        state?: {
          running?: boolean;
          lastRunAt?: string | null;
          lastFinishedAt?: string | null;
          nextRunAt?: string | null;
          lastError?: string | null;
        };
        error?: unknown;
      };

      if (!response.ok || !payload.success) {
        const errorText =
          typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha na execução manual (${response.status}).`;
        return { success: false, error: errorText, state: payload.state };
      }

      return {
        success: true,
        summary: payload.summary,
        state: payload.state,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Falha de rede ao executar recolha automática.',
      };
    }
  }

  // --- Auto Responses (Triggers) ---
  async getTriggers(): Promise<AutoResponseTrigger[]> {
    return new Promise(resolve => setTimeout(() => resolve([...this.triggers]), 200));
  }

  async createTrigger(trigger: Omit<AutoResponseTrigger, 'id'>): Promise<AutoResponseTrigger> {
    const newTrigger = { ...trigger, id: `tr${Date.now()}` };
    this.triggers.push(newTrigger);
    return newTrigger;
  }

  async updateTrigger(id: string, updates: Partial<AutoResponseTrigger>): Promise<void> {
    const idx = this.triggers.findIndex(t => t.id === id);
    if (idx !== -1) {
      this.triggers[idx] = { ...this.triggers[idx], ...updates };
    }
  }

  async deleteTrigger(id: string): Promise<void> {
    this.triggers = this.triggers.filter(t => t.id !== id);
  }

  // --- Helpers ---
  async getCustomerById(id: string): Promise<Customer | undefined> {
    return this.customers.find(c => c.id === id);
  }
}

export const mockService = new MockService();
