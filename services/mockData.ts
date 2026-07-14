import { User, Role, Customer, Conversation, ConversationStatus, Message, Task, TaskStatus, Call, CustomerType, TaskPriority, AutoResponseTrigger, AgendaEvent } from '../types';
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
import {
  consultarSegSocialValoresApuradosMensalmenteApi,
  consultarSegSocialValoresComunicadosApi,
  enviarSegSocialValoresRemuneracaoApi,
  findLatestSegSocialSubUserPasswordApi,
  syncSegSocialPasswordsFromSaftApi,
  triggerFinancasAutologinApi,
  triggerSegSocialAutologinApi,
  triggerSegSocialSubUserSetupApi,
  type CustomerAutologinResult,
  type SaftSegSocialPasswordSyncResult,
  type SegSocialSubUserPasswordLookupResult,
  type SegSocialSubUserSetupResult,
} from './segSocialCustomerApi';
import {
  INITIAL_AGENDA_EVENTS,
  INITIAL_CALLS,
  INITIAL_CONVERSATIONS,
  INITIAL_CUSTOMERS,
  INITIAL_MESSAGES,
  INITIAL_TASKS,
  INITIAL_TRIGGERS,
  INITIAL_USERS,
} from './mockInitialData';
import { ObrigacoesApi } from './obrigacoesApi';
import { CustomerDocumentsApi } from './customerDocumentsApi';
import {
  deleteAgendaEventApi,
  deleteTaskApi,
  fetchAgendaEventsApi,
  fetchCallsApi,
  fetchTasksApi,
  importTasksApi,
  saveAgendaEventApi,
  saveCallApi,
  saveTaskApi,
  type TaskImportInput,
  type TaskImportResult,
} from './operationalDataApi';
import {
  isFilledValue,
  isValidAgendaEvent,
  isValidCustomer,
  isValidUser,
  mergeImportedCustomersInto,
  normalizeDigits,
  parseTimestampToIso,
} from './mockDataUtils';

export type {
  SaftSegSocialPasswordSyncResult,
  SaftSegSocialPasswordSyncSummary,
} from './segSocialCustomerApi';

// --- Initial Mock Data ---

export const USERS = [...INITIAL_USERS]; // Shared reference used by legacy views
export let CURRENT_USER_ID =
  typeof window !== 'undefined' && window.localStorage
    ? (window.localStorage.getItem('wa_pro_session_user_id') || '')
    : '';
// --- Mock Service Class ---

const LOCAL_CUSTOMERS_KEY = 'wa_pro_local_customers_v1';
const LOCAL_USERS_KEY = 'wa_pro_local_users_v1';
const LOCAL_AGENDA_EVENTS_KEY = 'wa_pro_local_agenda_events_v1';
const SESSION_USER_KEY = 'wa_pro_session_user_id';
const SESSION_DIAGNOSTIC_COOKIE = 'wa_pro_client_user';

class MockService {
  private users = USERS;
  private customers = [...INITIAL_CUSTOMERS];
  private conversations = [...INITIAL_CONVERSATIONS];
  private messages = [...INITIAL_MESSAGES];
  private tasks = [...INITIAL_TASKS];
  private calls = [...INITIAL_CALLS];
  private agendaEvents = [...INITIAL_AGENDA_EVENTS];
  private triggers = [...INITIAL_TRIGGERS];
  private supabaseImportPromise: Promise<void> | null = null;
  private supabaseImportDone = false;
  private readonly obrigacoesApi = new ObrigacoesApi(
    () => this.isBrowser(),
    () => CURRENT_USER_ID,
  );
  private readonly customerDocumentsApi = new CustomerDocumentsApi(
    () => this.isBrowser(),
    () => CURRENT_USER_ID,
  );

  constructor() {
    this.loadLocalEntities();
    // Identificador apenas diagnóstico: ajuda a descobrir que cliente ainda usa
    // o bypass durante a migração. Nunca é aceite pelo backend como autenticação.
    this.setSessionUserId(CURRENT_USER_ID);
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
      if (typeof document !== 'undefined') {
        const secure = window.location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = `${SESSION_DIAGNOSTIC_COOKIE}=${encodeURIComponent(CURRENT_USER_ID)}; Path=/; SameSite=Lax; Max-Age=31536000${secure}`;
      }
    } else {
      window.localStorage.removeItem(SESSION_USER_KEY);
      if (typeof document !== 'undefined') {
        document.cookie = `${SESSION_DIAGNOSTIC_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
      }
    }
  }

  private ensureSessionIsValid() {
    if (!CURRENT_USER_ID) return;
    const currentUser = this.users.find(user => user.id === CURRENT_USER_ID);
    if (!currentUser) {
      this.setSessionUserId('');
      return;
    }

    const normalizedEmail = String(currentUser.email || '').trim().toLowerCase();
    if (!normalizedEmail) return;

    const candidateUsers = this.users.filter(
      (user) => String(user.email || '').trim().toLowerCase() === normalizedEmail
    );
    const preferredUser = this.pickPreferredUser(candidateUsers, CURRENT_USER_ID);
    if (preferredUser?.id && preferredUser.id !== CURRENT_USER_ID) {
      this.setSessionUserId(preferredUser.id);
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

    try {
      const agendaRaw = window.localStorage.getItem(LOCAL_AGENDA_EVENTS_KEY);
      if (agendaRaw) {
        const parsedAgenda = JSON.parse(agendaRaw) as unknown[];
        if (Array.isArray(parsedAgenda)) {
          this.agendaEvents = parsedAgenda.filter((event): event is AgendaEvent => this.isValidAgendaEvent(event));
        }
      }
    } catch (error) {
      console.warn('[Local agenda] erro ao carregar:', error);
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

    try {
      window.localStorage.setItem(LOCAL_AGENDA_EVENTS_KEY, JSON.stringify(this.agendaEvents));
    } catch (error) {
      console.warn('[Local agenda] erro ao guardar:', error);
    }

  }

  private isValidAgendaEvent(value: unknown): value is AgendaEvent {
    return isValidAgendaEvent(value);
  }

  private pruneOrphanConversationData() {
    const validCustomerIds = new Set(this.customers.map((customer) => customer.id));
    const validConversations = this.conversations.filter((conversation) => validCustomerIds.has(conversation.customerId));
    const validConversationIds = new Set(validConversations.map((conversation) => conversation.id));

    this.conversations = validConversations;
    this.messages = this.messages.filter((message) => validConversationIds.has(message.conversationId));
    this.tasks = this.tasks.filter((task) => validConversationIds.has(task.conversationId));
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

  private isExternalAliasUserId(userId: string): boolean {
    const normalizedId = String(userId || '').trim().toLowerCase();
    return normalizedId.startsWith('ext_') || normalizedId.startsWith('est_');
  }

  private userDedupScore(user: User, currentUserId: string): number {
    const normalizedId = String(user.id || '').trim();
    const normalizedRole = String(user.role || '').trim().toUpperCase();
    const currentUserIsAlias = this.isExternalAliasUserId(currentUserId);
    let score = 0;
    if (normalizedId && normalizedId === currentUserId) score += currentUserIsAlias ? 20 : 1000;
    if (normalizedRole === Role.ADMIN) score += 200;
    if (!this.isExternalAliasUserId(normalizedId)) score += 120;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(normalizedId)) score += 80;
    if (normalizedId.startsWith('local_')) score += 40;
    if (/^u\d+$/i.test(normalizedId)) score += 20;
    if (normalizedId.startsWith('ext_u_')) score -= 40;
    if (normalizedId.startsWith('est_')) score -= 80;
    if (String(user.avatarUrl || '').trim()) score += 5;
    if (String(user.password || '').trim()) score += 2;
    return score;
  }

  private pickPreferredUser(candidates: User[], currentUserId = ''): User | undefined {
    return [...candidates]
      .filter(candidate => this.isValidUser(candidate))
      .sort((a, b) => this.userDedupScore(b, currentUserId) - this.userDedupScore(a, currentUserId))[0];
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
    return parseTimestampToIso(value);
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
    const seenOptimisticIds = new Set<string>();
    for (const optimisticMessage of optimistic) {
      const optimisticId = String(optimisticMessage.id || '').trim();
      if (!optimisticId || seenOptimisticIds.has(optimisticId)) continue;
      seenOptimisticIds.add(optimisticId);

      if (mappedMessages.some((mapped) => String(mapped.id || '').trim() === optimisticId)) {
        continue;
      }

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

    const uniqueById = new Map<string, Message>();
    for (const message of merged) {
      const messageId = String(message.id || '').trim();
      if (!messageId) continue;
      const current = uniqueById.get(messageId);
      if (!current) {
        uniqueById.set(messageId, message);
        continue;
      }
      // Preferimos manter a versão não otimista quando houver colisão de ID.
      const currentOptimistic = this.isOptimisticMessageId(current.id);
      const nextOptimistic = this.isOptimisticMessageId(message.id);
      if (currentOptimistic && !nextOptimistic) {
        uniqueById.set(messageId, message);
      }
    }

    return Array.from(uniqueById.values()).sort(
      (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
    );
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
            status: (contact.status as ConversationStatus) || ConversationStatus.OPEN,
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
          conversation.status = contact.status as ConversationStatus;
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

  private normalizeDigits(value: string): string {
    return normalizeDigits(value);
  }

  private isFilledValue(value: unknown): boolean {
    return isFilledValue(value);
  }

  private mergeImportedCustomers(importedCustomers: Customer[]) {
    mergeImportedCustomersInto(this.customers, importedCustomers);
  }

  private replaceCustomersFromServer(updatedCustomers: Customer[]) {
    (Array.isArray(updatedCustomers) ? updatedCustomers : [])
      .filter((customer) => this.isValidCustomer(customer))
      .forEach((customer) => {
        const normalizedNif = this.normalizeDigits(String(customer.nif || '')).slice(-9);
        const index = this.customers.findIndex((existing) => {
          if (customer.id && existing.id === customer.id) return true;
          if (!normalizedNif) return false;
          const existingNif = this.normalizeDigits(String(existing.nif || '')).slice(-9);
          return Boolean(existingNif && existingNif === normalizedNif);
        });
        if (index >= 0) {
          this.customers[index] = customer;
        } else {
          this.customers.push(customer);
        }
      });
  }

  private isValidUser(data: unknown): data is User {
    return isValidUser(data);
  }

  private isValidCustomer(data: unknown): data is Customer {
    return isValidCustomer(data);
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
        this.replaceCustomersFromServer(remappedCustomers);
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
    if (this.isBrowser()) {
      try {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const payload = await response.json().catch(() => ({})) as {
          success?: boolean;
          error?: string;
          user?: { id?: string };
        };
        if (response.ok && payload.success) {
          const userId = String(payload.user?.id || '').trim();
          if (userId) this.setSessionUserId(userId);
          return { success: true };
        }
        if (response.status === 401) {
          return { success: false, error: payload.error || 'Não foi possível autenticar.' };
        }
      } catch {
        // Compatibilidade com servidores antigos/desktop offline: cai no fluxo legado abaixo.
      }
    }

    await this.ensureSupabaseImport();

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPassword = password.trim();

    // Procurar por email e preferir o utilizador canónico em vez de aliases ext_/est_.
    const candidateUsers = this.users.filter(u => (u.email || '').toLowerCase() === normalizedEmail);
    if (candidateUsers.length === 0) {
      return { success: false, error: 'Email não encontrado.' };
    }

    const user = this.pickPreferredUser(candidateUsers);
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
    if (this.isBrowser()) {
      fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    }
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

  async refreshCustomersFromServer(): Promise<Customer[]> {
    this.customers = this.customers.filter(customer => customer.id.startsWith('local_'));
    this.supabaseImportDone = false;
    this.supabaseImportPromise = null;
    await this.ensureSupabaseImport();
    return [...this.customers];
  }

  async triggerFinancasAutologin(
    customerId: string,
    options?: { actorUserId?: string; headless?: boolean; closeAfterSubmit?: boolean }
  ): Promise<CustomerAutologinResult> {
    if (!this.isBrowser()) {
      throw new Error('Autologin disponível apenas no browser.');
    }

    const targetId = String(customerId || '').trim();
    if (!targetId) {
      throw new Error('Cliente inválido para autologin.');
    }

    return triggerFinancasAutologinApi(targetId, {
      actorUserId: String(options?.actorUserId || this.getCurrentUserId() || '').trim() || null,
      headless: options?.headless ?? false,
      closeAfterSubmit: options?.closeAfterSubmit ?? false,
    });
  }

  async triggerSegSocialAutologin(
    customerId: string,
    options?: { actorUserId?: string; headless?: boolean; closeAfterSubmit?: boolean }
  ): Promise<CustomerAutologinResult> {
    if (!this.isBrowser()) {
      throw new Error('Autologin disponível apenas no browser.');
    }

    const targetId = String(customerId || '').trim();
    if (!targetId) {
      throw new Error('Cliente inválido para autologin.');
    }

    return triggerSegSocialAutologinApi(targetId, {
      actorUserId: String(options?.actorUserId || this.getCurrentUserId() || '').trim() || null,
      headless: options?.headless ?? false,
      closeAfterSubmit: options?.closeAfterSubmit ?? false,
    });
  }

  async triggerSegSocialSubUserSetup(
    customerId: string,
    options?: { actorUserId?: string; headless?: boolean; closeAfterSubmit?: boolean; subEmail?: string }
  ): Promise<SegSocialSubUserSetupResult> {
    if (!this.isBrowser()) {
      throw new Error('Automação disponível apenas no browser.');
    }

    const targetId = String(customerId || '').trim();
    if (!targetId) {
      throw new Error('Cliente inválido para criação de subutilizador.');
    }

    return triggerSegSocialSubUserSetupApi(targetId, {
      actorUserId: String(options?.actorUserId || this.getCurrentUserId() || '').trim() || null,
      headless: options?.headless ?? false,
      closeAfterSubmit: options?.closeAfterSubmit ?? false,
      subEmail: String(options?.subEmail || 'geral@mpr.pt').trim(),
    });
  }

  async syncSegSocialPasswordsFromSaft(options?: {
    customerId?: string;
    actorUserId?: string;
    headless?: boolean;
    syncToSupabase?: boolean;
  }): Promise<SaftSegSocialPasswordSyncResult> {
    if (!this.isBrowser()) {
      throw new Error('Sincronização SAFT disponível apenas no browser.');
    }

    const result = await syncSegSocialPasswordsFromSaftApi({
      customerId: String(options?.customerId || '').trim() || undefined,
      actorUserId: String(options?.actorUserId || this.getCurrentUserId() || '').trim() || null,
      headless: options?.headless ?? true,
      syncToSupabase: options?.syncToSupabase ?? true,
    });

    this.supabaseImportDone = false;
    this.supabaseImportPromise = null;
    await this.ensureSupabaseImport();
    const updatedCustomers = Array.isArray(result.customers)
      ? result.customers.filter((customer) => this.isValidCustomer(customer))
      : [];
    if (updatedCustomers.length > 0) {
      this.replaceCustomersFromServer(updatedCustomers);
      this.persistLocalEntities();
    }

    return {
      ...result,
      customers: updatedCustomers,
    };
  }

  async findLatestSegSocialSubUserPassword(params?: {
    username?: string;
    email?: string;
    sinceDays?: number;
    maxMessages?: number;
    sinceIso?: string;
  }): Promise<SegSocialSubUserPasswordLookupResult> {
    if (!this.isBrowser()) {
      throw new Error('Leitura de email disponível apenas no browser.');
    }

    return findLatestSegSocialSubUserPasswordApi(params);
  }

  async enviarSegSocialValoresRemuneracao(customerId: string, payload: Record<string, unknown>, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.isBrowser()) {
      throw new Error('Interoperabilidade disponível apenas no browser.');
    }
    return enviarSegSocialValoresRemuneracaoApi(customerId, payload, params);
  }

  async consultarSegSocialValoresComunicados(customerId: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.isBrowser()) {
      throw new Error('Interoperabilidade disponível apenas no browser.');
    }
    return consultarSegSocialValoresComunicadosApi(customerId, params);
  }

  async consultarSegSocialValoresApuradosMensalmente(customerId: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.isBrowser()) {
      throw new Error('Interoperabilidade disponível apenas no browser.');
    }
    return consultarSegSocialValoresApuradosMensalmenteApi(customerId, params);
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
          sourceId: String((draftCustomer as Customer & { sourceId?: string }).sourceId || '').trim() || (draftCustomer.id.startsWith('ext_c_') ? draftCustomer.id.slice(6) : undefined),
          forceLocalToSupabase: syncToSupabase,
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
          codigoPostal: draftCustomer.codigoPostal || '',
          notes: draftCustomer.notes || '',
          certidaoPermanenteNumero: draftCustomer.certidaoPermanenteNumero || '',
          certidaoPermanenteValidade: draftCustomer.certidaoPermanenteValidade || '',
          rcbeNumero: draftCustomer.rcbeNumero || '',
          rcbeData: draftCustomer.rcbeData || '',
          dataConstituicao: draftCustomer.dataConstituicao || '',
          dataNascimento: draftCustomer.dataNascimento || '',
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


  async updateCustomerFromAt(customerId: string): Promise<{ customer?: Customer; fields?: Partial<Customer>; message?: string }> {
    if (!customerId) throw new Error('Cliente inválido.');
    if (this.isBrowser()) {
      const response = await fetch(`/api/customers/${encodeURIComponent(customerId)}/update-from-at`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        customer?: Customer;
        fields?: Partial<Customer>;
        message?: string;
        error?: unknown;
      };
      if (!response.ok || !payload.success) {
        const errorText =
          typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha ao atualizar dados pela AT (${response.status}).`;
        throw new Error(errorText);
      }
      if (payload.customer && this.isValidCustomer(payload.customer)) {
        const idx = this.customers.findIndex((customer) => customer.id === customerId || customer.id === payload.customer!.id);
        if (idx >= 0) this.customers[idx] = payload.customer;
        else this.customers.push(payload.customer);
        this.persistLocalEntities();
      }
      return { customer: payload.customer, fields: payload.fields || {}, message: payload.message || 'Dados AT atualizados.' };
    }
    throw new Error('Atualização pela AT só está disponível no servidor.');
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
                sourceId: String((nextCustomer as Customer & { sourceId?: string }).sourceId || '').trim() || (nextCustomer.id.startsWith('ext_c_') ? nextCustomer.id.slice(6) : undefined),
                forceLocalToSupabase: syncToSupabase,
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
                codigoPostal: nextCustomer.codigoPostal || '',
                notes: nextCustomer.notes || '',
                certidaoPermanenteNumero: nextCustomer.certidaoPermanenteNumero || '',
                certidaoPermanenteValidade: nextCustomer.certidaoPermanenteValidade || '',
                rcbeNumero: nextCustomer.rcbeNumero || '',
                rcbeData: nextCustomer.rcbeData || '',
                dataConstituicao: nextCustomer.dataConstituicao || '',
                dataNascimento: nextCustomer.dataNascimento || '',
                inicioAtividade: nextCustomer.inicioAtividade || '',
                caePrincipal: nextCustomer.caePrincipal || '',
                caeDescricao: nextCustomer.caeDescricao || '',
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

            // Marca para recarregar da SQLite local na próxima navegação.
            this.supabaseImportDone = false;
            this.supabaseImportPromise = null;
          } else {
            this.customers[idx] = nextCustomer;
          }
          this.persistLocalEntities();
      }
  }

  getCustomerDocuments(
    ...args: Parameters<CustomerDocumentsApi['getCustomerDocuments']>
  ): ReturnType<CustomerDocumentsApi['getCustomerDocuments']> {
    return this.customerDocumentsApi.getCustomerDocuments(...args);
  }

  getCustomerDocumentsAtPath(
    ...args: Parameters<CustomerDocumentsApi['getCustomerDocumentsAtPath']>
  ): ReturnType<CustomerDocumentsApi['getCustomerDocumentsAtPath']> {
    return this.customerDocumentsApi.getCustomerDocumentsAtPath(...args);
  }

  uploadCustomerDocument(
    ...args: Parameters<CustomerDocumentsApi['uploadCustomerDocument']>
  ): ReturnType<CustomerDocumentsApi['uploadCustomerDocument']> {
    return this.customerDocumentsApi.uploadCustomerDocument(...args);
  }

  organizeCustomerDocuments(
    ...args: Parameters<CustomerDocumentsApi['organizeCustomerDocuments']>
  ): ReturnType<CustomerDocumentsApi['organizeCustomerDocuments']> {
    return this.customerDocumentsApi.organizeCustomerDocuments(...args);
  }

  undoOrganizeCustomerDocuments(
    ...args: Parameters<CustomerDocumentsApi['undoOrganizeCustomerDocuments']>
  ): ReturnType<CustomerDocumentsApi['undoOrganizeCustomerDocuments']> {
    return this.customerDocumentsApi.undoOrganizeCustomerDocuments(...args);
  }

  uploadTemporaryChatMedia(
    ...args: Parameters<CustomerDocumentsApi['uploadTemporaryChatMedia']>
  ): ReturnType<CustomerDocumentsApi['uploadTemporaryChatMedia']> {
    return this.customerDocumentsApi.uploadTemporaryChatMedia(...args);
  }

  ingestCustomerDocumentWithAI(
    ...args: Parameters<CustomerDocumentsApi['ingestCustomerDocumentWithAI']>
  ): ReturnType<CustomerDocumentsApi['ingestCustomerDocumentWithAI']> {
    return this.customerDocumentsApi.ingestCustomerDocumentWithAI(...args);
  }

  detectCustomerByDocumentAI(
    ...args: Parameters<CustomerDocumentsApi['detectCustomerByDocumentAI']>
  ): ReturnType<CustomerDocumentsApi['detectCustomerByDocumentAI']> {
    return this.customerDocumentsApi.detectCustomerByDocumentAI(...args);
  }

  importCustomerDocumentFromUrl(
    ...args: Parameters<CustomerDocumentsApi['importCustomerDocumentFromUrl']>
  ): ReturnType<CustomerDocumentsApi['importCustomerDocumentFromUrl']> {
    return this.customerDocumentsApi.importCustomerDocumentFromUrl(...args);
  }

  getCustomerDocumentShareLink(
    ...args: Parameters<CustomerDocumentsApi['getCustomerDocumentShareLink']>
  ): ReturnType<CustomerDocumentsApi['getCustomerDocumentShareLink']> {
    return this.customerDocumentsApi.getCustomerDocumentShareLink(...args);
  }

  requestSaftDocument(
    ...args: Parameters<CustomerDocumentsApi['requestSaftDocument']>
  ): ReturnType<CustomerDocumentsApi['requestSaftDocument']> {
    return this.customerDocumentsApi.requestSaftDocument(...args);
  }

  syncSaftCompanyDocs(
    ...args: Parameters<CustomerDocumentsApi['syncSaftCompanyDocs']>
  ): ReturnType<CustomerDocumentsApi['syncSaftCompanyDocs']> {
    return this.customerDocumentsApi.syncSaftCompanyDocs(...args);
  }

  getSaftJobs(
    ...args: Parameters<CustomerDocumentsApi['getSaftJobs']>
  ): ReturnType<CustomerDocumentsApi['getSaftJobs']> {
    return this.customerDocumentsApi.getSaftJobs(...args);
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

  async deleteMessage(
    conversationId: string,
    messageId: string
  ): Promise<{ deletedForEveryone: boolean; warning?: string | null }> {
    let deleteResult: { deletedForEveryone: boolean; warning?: string | null } = {
      deletedForEveryone: false,
      warning: null,
    };
    await this.ensureSupabaseImport();

    if (this.isBrowser()) {
      const payload = await deleteChatMessage(messageId, CURRENT_USER_ID || null);
      deleteResult = {
        deletedForEveryone: payload.deletedForEveryone === true,
        warning: payload.warning || null,
      };
    }

    this.messages = this.messages.map((message) => {
      if (message.conversationId !== conversationId || message.id !== messageId) return message;
      return {
        ...message,
        body: '[Mensagem apagada]',
        type: 'text',
        mediaKind: undefined,
        mediaPath: undefined,
        mediaMimeType: undefined,
        mediaFileName: undefined,
        mediaSize: null,
        mediaProvider: undefined,
        mediaRemoteId: undefined,
        mediaRemoteUrl: undefined,
        mediaPreviewUrl: undefined,
        mediaDownloadUrl: undefined,
      };
    });

    return deleteResult;
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
      const uid = String(CURRENT_USER_ID || '').trim();
      const remoteTasks = await fetchTasksApi(conversationId, uid);
      if (remoteTasks) this.tasks = remoteTasks;
    }

    if (conversationId) {
      return this.tasks.filter(t => t.conversationId === conversationId);
    }
    return [...this.tasks];
  }

  async importTasksFromSupabase(input: TaskImportInput = {}): Promise<TaskImportResult> {
    if (!this.isBrowser()) return { success: false, error: 'Importação disponível apenas no browser.' };
    return importTasksApi(input, this.getCurrentUserId());
  }

  async createTask(task: Omit<Task, 'id'>): Promise<Task> {
    const newTask: Task = { ...task, id: `t${Date.now()}` };

    if (this.isBrowser()) {
      const savedTask = await saveTaskApi(newTask);
      if (savedTask) {
        const existingIndex = this.tasks.findIndex(item => item.id === savedTask.id);
        if (existingIndex >= 0) this.tasks[existingIndex] = savedTask;
        else this.tasks.push(savedTask);
        return savedTask;
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
    const existingTask = idx !== -1 ? this.tasks[idx] : null;
    const nextTask = { ...(existingTask || {}), ...updates, id } as Task;

    if (!nextTask.conversationId || !nextTask.title) {
      throw new Error('Não consegui guardar a tarefa: faltam dados base da tarefa.');
    }

    if (this.isBrowser()) {
      const savedTask = await saveTaskApi(nextTask) || nextTask;
      const existingIndex = this.tasks.findIndex(t => t.id === savedTask.id);
      if (existingIndex >= 0) this.tasks[existingIndex] = savedTask;
      else this.tasks.push(savedTask);
      return;
    }

    if (idx !== -1) this.tasks[idx] = nextTask;
    else this.tasks.push(nextTask);
  }

  async deleteTask(id: string, options?: { actorUserId?: string }): Promise<void> {
    const targetId = String(id || '').trim();
    if (!targetId) {
      throw new Error('Tarefa inválida.');
    }

    if (this.isBrowser()) {
      const actorUserId = String(options?.actorUserId || this.getCurrentUserId() || '').trim();
      await deleteTaskApi(targetId, actorUserId);
    }

    this.tasks = this.tasks.filter((task) => String(task.id || '').trim() !== targetId);
  }

  // --- Calls ---
  async getCalls(customerId?: string): Promise<Call[]> {
     if (this.isBrowser()) {
        const remoteCalls = await fetchCallsApi(customerId);
        if (remoteCalls) this.calls = remoteCalls;
     }

     if(customerId) {
        return this.calls.filter(c => c.customerId === customerId).sort((a,b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
     }
     return [...this.calls];
  }

  async createCall(call: Omit<Call, 'id'>): Promise<Call> {
    const newCall: Call = { ...call, id: `call${Date.now()}` };

    if (this.isBrowser()) {
      const savedCall = await saveCallApi(newCall);
      if (savedCall) {
        this.calls.push(savedCall);
        return savedCall;
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

  // --- Agenda ---
  async getAgendaEvents(): Promise<AgendaEvent[]> {
    if (this.isBrowser()) {
      const uid = String(CURRENT_USER_ID || '').trim();
      const remoteEvents = await fetchAgendaEventsApi(uid);
      if (remoteEvents) this.agendaEvents = remoteEvents;
    }
    return [...this.agendaEvents].sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime());
  }

  async createAgendaEvent(event: Omit<AgendaEvent, 'id' | 'createdAt' | 'updatedAt'>): Promise<AgendaEvent> {
    const now = new Date().toISOString();
    const normalized: AgendaEvent = {
      ...event,
      id: `ag${Date.now()}`,
      createdAt: now,
      updatedAt: now,
    };
    if (this.isBrowser()) {
      const savedEvent = await saveAgendaEventApi(normalized);
      const existingIndex = this.agendaEvents.findIndex((item) => item.id === savedEvent.id);
      if (existingIndex >= 0) this.agendaEvents[existingIndex] = savedEvent;
      else this.agendaEvents.push(savedEvent);
      return savedEvent;
    }
    this.agendaEvents.push(normalized);
    this.persistLocalEntities();
    return normalized;
  }

  async updateAgendaEvent(id: string, updates: Partial<AgendaEvent>): Promise<AgendaEvent> {
    const targetId = String(id || '').trim();
    const idx = this.agendaEvents.findIndex((event) => event.id === targetId);
    if (idx < 0) {
      throw new Error('Evento da agenda não encontrado.');
    }
    const nextEvent: AgendaEvent = {
      ...this.agendaEvents[idx],
      ...updates,
      id: targetId,
      updatedAt: new Date().toISOString(),
    };
    if (!this.isValidAgendaEvent(nextEvent)) {
      throw new Error('Evento da agenda inválido.');
    }
    if (this.isBrowser()) {
      const savedEvent = await saveAgendaEventApi(nextEvent);
      this.agendaEvents[idx] = savedEvent;
      return savedEvent;
    }
    this.agendaEvents[idx] = nextEvent;
    this.persistLocalEntities();
    return nextEvent;
  }

  async deleteAgendaEvent(id: string): Promise<void> {
    const targetId = String(id || '').trim();
    if (this.isBrowser() && targetId) {
      await deleteAgendaEventApi(targetId);
    }
    this.agendaEvents = this.agendaEvents.filter((event) => event.id !== targetId);
    this.persistLocalEntities();
  }

  collectDriObrigacoes(
    ...args: Parameters<ObrigacoesApi['collectDriObrigacoes']>
  ): ReturnType<ObrigacoesApi['collectDriObrigacoes']> {
    return this.obrigacoesApi.collectDriObrigacoes(...args);
  }

  getObrigacoesAutoStatus(): ReturnType<ObrigacoesApi['getObrigacoesAutoStatus']> {
    return this.obrigacoesApi.getObrigacoesAutoStatus();
  }

  runObrigacoesAutoNow(): ReturnType<ObrigacoesApi['runObrigacoesAutoNow']> {
    return this.obrigacoesApi.runObrigacoesAutoNow();
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
    if (this.isBrowser()) {
      const targetId = String(id || '').trim();
      if (!targetId) return undefined;
      const response = await fetch(`/api/customers/${encodeURIComponent(targetId)}/sync`, {
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        customer?: Customer;
        error?: unknown;
      };
      if (response.ok && payload.success && payload.customer && this.isValidCustomer(payload.customer)) {
        this.replaceCustomersFromServer([payload.customer]);
        return payload.customer;
      }
      if (response.status !== 404) {
        const errorText =
          typeof payload.error === 'string'
            ? payload.error
            : payload.error
              ? JSON.stringify(payload.error)
              : `Falha ao obter cliente (${response.status}).`;
        throw new Error(errorText);
      }
    }
    return this.customers.find(c => c.id === id);
  }
}

export const mockService = new MockService();
