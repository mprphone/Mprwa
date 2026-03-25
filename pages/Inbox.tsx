import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ImagePlus, MessageCircle, Paperclip, Lock, Send, UserX, X } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Conversation, Message, Customer, Task, TaskAttachment, ConversationStatus, TaskStatus, TaskPriority, User as UserType, CustomerType } from '../types';
import { mockService, CURRENT_USER_ID, USERS } from '../services/mockData';
import { SaftDocumentType } from '../components/inbox/SaftPanel';
import ConversationListPanel, { InboxTab } from '../components/inbox/ConversationListPanel';
import MessageThread from '../components/inbox/MessageThread';
import ConversationDetailsSidebar from '../components/inbox/ConversationDetailsSidebar';
import CallLogModal from '../components/inbox/CallLogModal';
import TemplatePickerModal from '../components/inbox/TemplatePickerModal';
import TemplateConfirmModal from '../components/inbox/TemplateConfirmModal';
import NewChatModal from '../components/inbox/NewChatModal';
import LinkCustomerModal from '../components/inbox/LinkCustomerModal';
import {
  fetchChatContacts,
  ChatContactRow,
  blockChatContact,
  fetchWhatsAppAccounts,
  fetchWhatsAppHealth,
  WhatsAppAccountHealth,
  unblockChatContact,
} from '../services/chatCoreApi';
import { fetchOccurrences } from '../services/occurrencesApi';
import type { OccurrenceRow } from '../services/occurrencesApi';

const MESSAGE_UI_META_STORAGE_KEY = 'wa_pro_message_ui_meta_v1';
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

function normalizeNifDigits(rawValue: string): string {
  return String(rawValue || '').replace(/\D/g, '').slice(-9);
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
    .replace(/[\u0300-\u036f]/g, '');

  if (!compact) return null;

  if (
    compact.includes('helper local') ||
    compact.includes('automacao local') ||
    compact.includes('app desktop') ||
    compact.includes('nao encontrei o helper') ||
    compact.includes('browser de automacao') ||
    compact.includes('nao instalado') ||
    compact.includes('not installed') ||
    compact.includes('browsertype.launch') ||
    compact.includes('executable does') ||
    compact.includes('does not exist') ||
    compact.includes('playwright install') ||
    compact.includes('ms-playwright') ||
    compact.includes('chrome-win64') ||
    compact.includes('playwright nao instalado')
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

const Inbox: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selectedCustomerIdOverride, setSelectedCustomerIdOverride] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [openOccurrences, setOpenOccurrences] = useState<OccurrenceRow[]>([]);
  const [openOccurrencesLoading, setOpenOccurrencesLoading] = useState(false);
  const [openOccurrencesError, setOpenOccurrencesError] = useState<string | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [activeTab, setActiveTab] = useState<InboxTab>('waiting');
  const [templateCount, setTemplateCount] = useState(0);
  const [chatContacts, setChatContacts] = useState<ChatContactRow[]>([]);
  const [whatsappProviderMode, setWhatsappProviderMode] = useState<'cloud' | 'baileys' | 'unknown'>('baileys');
  const [whatsAppAccounts, setWhatsAppAccounts] = useState<WhatsAppAccountHealth[]>([]);
  const [isUpdatingWhatsAppAccount, setIsUpdatingWhatsAppAccount] = useState(false);
  const [startingContactId, setStartingContactId] = useState<string | null>(null);
  const [isContactBlockBusy, setIsContactBlockBusy] = useState(false);
  const [isDeletingConversation, setIsDeletingConversation] = useState(false);
  const [showContactsModal, setShowContactsModal] = useState(false);
  const [contactsSearchTerm, setContactsSearchTerm] = useState('');
  const [editingContactNameId, setEditingContactNameId] = useState<string | null>(null);
  const [editingContactNameValue, setEditingContactNameValue] = useState('');
  const [savingContactNameId, setSavingContactNameId] = useState<string | null>(null);
  
  // Call Log State
  const [showCallModal, setShowCallModal] = useState(false);
  const [callDuration, setCallDuration] = useState('');
  const [callNotes, setCallNotes] = useState('');

  // New Task State
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskPriority, setNewTaskPriority] = useState<TaskPriority>(TaskPriority.NORMAL);
  const [newTaskAssignee, setNewTaskAssignee] = useState<string>(CURRENT_USER_ID);
  const [newTaskAttachments, setNewTaskAttachments] = useState<TaskAttachment[]>([]);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  // Link Customer State
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkTab, setLinkTab] = useState<'existing' | 'new'>('existing');
  const [linkSearchTerm, setLinkSearchTerm] = useState('');
  const [newCustomerForm, setNewCustomerForm] = useState({
      name: '',
      company: '',
      email: '',
      type: CustomerType.ENTERPRISE
  });

  // New Conversation State
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [newChatSearch, setNewChatSearch] = useState('');

  // Template/24h Window State
  const [showTemplateConfirm, setShowTemplateConfirm] = useState(false);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [conversationSearch, setConversationSearch] = useState('');
  const [managedTemplates, setManagedTemplates] = useState<Array<{
    id: string;
    name: string;
    kind: 'template' | 'quick_reply';
    content: string;
    isActive: boolean;
    metaTemplateName?: string;
  }>>([]);
  const [customerDocuments, setCustomerDocuments] = useState<Array<{ type: 'file' | 'directory'; name: string; relativePath: string; size?: number; updatedAt: string }>>([]);
  const [customerDocumentsPath, setCustomerDocumentsPath] = useState('');
  const [customerDocumentsStoragePath, setCustomerDocumentsStoragePath] = useState('');
  const [customerDocumentsCurrentPath, setCustomerDocumentsCurrentPath] = useState('');
  const [canGoUpDocumentsPath, setCanGoUpDocumentsPath] = useState(false);
  const [customerDocsConfigured, setCustomerDocsConfigured] = useState(false);
  const [isDocumentsLoading, setIsDocumentsLoading] = useState(false);
  const [isUploadingDocument, setIsUploadingDocument] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [customerFolderHandles, setCustomerFolderHandles] = useState<Record<string, unknown>>({});
  const [saftLoadingType, setSaftLoadingType] = useState<string | null>(null);
  const [saftFeedback, setSaftFeedback] = useState<string>('');
  const [saftJobByType, setSaftJobByType] = useState<Record<string, { status: string; fileName?: string; error?: string; updatedAt?: string }>>({});
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<Message | null>(null);
  const [showForwardModal, setShowForwardModal] = useState(false);
  const [forwardSearch, setForwardSearch] = useState('');
  const [isSendingImage, setIsSendingImage] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [isCustomerProfileOpen, setIsCustomerProfileOpen] = useState(false);
  const [messageUiMetaByConversation, setMessageUiMetaByConversation] = useState<
    Record<string, { starredIds: string[]; pinnedId: string | null }>
  >({});
  const [detailsMessage, setDetailsMessage] = useState<Message | null>(null);
  const [financasAutologinBusyCustomerId, setFinancasAutologinBusyCustomerId] = useState<string | null>(null);
  const [segSocialAutologinBusyCustomerId, setSegSocialAutologinBusyCustomerId] = useState<string | null>(null);
  const [inboundToast, setInboundToast] = useState<{ from: string; body: string; convId: string } | null>(null);
  const inboundToastTimerRef = useRef<number | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageComposerRef = useRef<HTMLTextAreaElement | null>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const selectedConvRef = useRef<string | null>(null);
  const requestedConversationAppliedRef = useRef<string | null>(null);
  const lastDocumentsCustomerIdRef = useRef<string | null>(null);
  const loadDataRequestRef = useRef(0);
  const loadMessagesRequestRef = useRef(0);
  const loadTasksRequestRef = useRef(0);
  const realtimeRefreshTimerRef = useRef<number | null>(null);
  const markReadRequestRef = useRef(0);
  const conversationSnapshotRef = useRef<Record<string, { lastMessageAt: string; unreadCount: number }>>({});
  const notificationsPrimedRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const lastNotificationSoundAtRef = useRef(0);
  const messageSnapshotRef = useRef<Record<string, { lastInboundId: string; lastInboundAt: string }>>({});
  const chatContactsRef = useRef<ChatContactRow[]>([]);

  const selectedConversation = conversations.find(c => c.id === selectedConvId);
  const selectedCustomerId = selectedCustomerIdOverride || selectedConversation?.customerId || null;
  const selectedCustomer = selectedCustomerId
    ? customers.find(c => c.id === selectedCustomerId) || null
    : null;
  const selectedConversationWhatsAppAccountId = useMemo(() => {
    const fromConversation = String(selectedConversation?.whatsappAccountId || '').trim();
    if (fromConversation) return fromConversation;
    const defaultAccount = (Array.isArray(whatsAppAccounts) ? whatsAppAccounts : []).find((item) => item.isDefault);
    return String(defaultAccount?.accountId || '').trim() || null;
  }, [selectedConversation?.whatsappAccountId, whatsAppAccounts]);

  const ensureNotificationAudioContext = useCallback(() => {
    if (typeof window === 'undefined') return null;
    if (audioContextRef.current) return audioContextRef.current;

    const ContextCtor = (window.AudioContext || (window as any).webkitAudioContext) as
      | (new () => AudioContext)
      | undefined;
    if (!ContextCtor) return null;

    try {
      audioContextRef.current = new ContextCtor();
      return audioContextRef.current;
    } catch {
      return null;
    }
  }, []);

  const playIncomingNotificationSound = useCallback(() => {
    const nowMs = Date.now();
    if (nowMs - lastNotificationSoundAtRef.current < 700) return;

    const ctx = ensureNotificationAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => null);
      return;
    }

    try {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const now = ctx.currentTime;

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.09, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.2);
      lastNotificationSoundAtRef.current = nowMs;
    } catch {
      // sem bloqueio
    }
  }, [ensureNotificationAudioContext]);

  const syncConversationSnapshotAndNotify = useCallback((nextConversations: Conversation[]) => {
    const previous = conversationSnapshotRef.current;
    const next: Record<string, { lastMessageAt: string; unreadCount: number }> = {};
    let shouldPlay = false;

    (Array.isArray(nextConversations) ? nextConversations : []).forEach((conversation) => {
      const id = String(conversation.id || '').trim();
      if (!id) return;

      const lastMessageAt = String(conversation.lastMessageAt || '').trim();
      const unreadCount = Number(conversation.unreadCount || 0);
      next[id] = { lastMessageAt, unreadCount };

      const prev = previous[id];
      const prevUnread = Number(prev?.unreadCount || 0);
      const hasUnreadIncrease = unreadCount > prevUnread;
      const isNewConversationWithUnread = !prev && unreadCount > 0;
      const currentTs = Number(new Date(lastMessageAt).getTime()) || 0;
      const prevTs = Number(new Date(String(prev?.lastMessageAt || '')).getTime()) || 0;
      const hasAdvancedUnreadTimestamp = unreadCount > 0 && currentTs > prevTs;

      if (hasUnreadIncrease || isNewConversationWithUnread || hasAdvancedUnreadTimestamp) {
        shouldPlay = true;
      }
    });

    if (notificationsPrimedRef.current && shouldPlay) {
      playIncomingNotificationSound();
    }

    conversationSnapshotRef.current = next;
    notificationsPrimedRef.current = true;
  }, [playIncomingNotificationSound]);

  const syncMessageSnapshotAndNotify = useCallback((conversationId: string, nextMessages: Message[]) => {
    const id = String(conversationId || '').trim();
    if (!id) return;

    const latestInbound = [...(Array.isArray(nextMessages) ? nextMessages : [])]
      .reverse()
      .find((message) => String(message?.direction || '').trim() === 'in');

    const latestInboundId = String(latestInbound?.id || '').trim();
    const latestInboundAt = String(latestInbound?.timestamp || '').trim();
    const previous = messageSnapshotRef.current[id];

    if (previous && latestInboundId && latestInboundId !== previous.lastInboundId) {
      const currentTs = Number(new Date(latestInboundAt).getTime()) || 0;
      const prevTs = Number(new Date(String(previous.lastInboundAt || '')).getTime()) || 0;
      if (currentTs >= prevTs) {
        playIncomingNotificationSound();
      }
    }

    messageSnapshotRef.current[id] = {
      lastInboundId: latestInboundId,
      lastInboundAt: latestInboundAt,
    };
  }, [playIncomingNotificationSound]);

  useEffect(() => {
    if (selectedCustomer?.id) return;
    setIsCustomerProfileOpen(false);
  }, [selectedCustomer?.id]);

  useEffect(() => {
    conversationSnapshotRef.current = {};
    messageSnapshotRef.current = {};
    notificationsPrimedRef.current = false;
  }, []);

  useEffect(() => {
    chatContactsRef.current = chatContacts;
  }, [chatContacts]);

  useEffect(() => {
    const unlockAudio = () => {
      const ctx = ensureNotificationAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => null);
      }
    };

    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, [ensureNotificationAudioContext]);
  const currentMessageUiMeta = useMemo(() => {
    if (!selectedConvId) return { starredIds: [] as string[], pinnedId: null as string | null };
    return messageUiMetaByConversation[selectedConvId] || { starredIds: [], pinnedId: null };
  }, [messageUiMetaByConversation, selectedConvId]);

  const normalizePhoneDigits = (value?: string) => String(value || '').replace(/\D/g, '');
  const extractPhoneDigitsFromConversationId = (conversationId?: string | null) => {
    const match = String(conversationId || '').match(/(?:wa_c_|conv_wa_c_|conv_wa_)(\d{6,})/);
    return match?.[1] || '';
  };
  const formatPhoneFromDigits = (digitsRaw?: string | null) => {
    const digits = normalizePhoneDigits(digitsRaw || '');
    if (!digits) return '';
    return `+${digits}`;
  };
  const resolveConversationFallbackPhone = (conversation?: Conversation | null) => {
    if (!conversation) return '';
    const digitsFromId = extractPhoneDigitsFromConversationId(conversation.id);
    if (digitsFromId) return formatPhoneFromDigits(digitsFromId);

    const relatedContact = chatContacts.find((row) => {
      return String(row.conversation_id || '').trim() === String(conversation.id || '').trim();
    });
    const digitsFromContact = normalizePhoneDigits(String(relatedContact?.from_number || ''));
    return digitsFromContact ? formatPhoneFromDigits(digitsFromContact) : '';
  };
  const looksLikePhoneLabel = (value?: string | null) => {
    const raw = String(value || '').trim();
    if (!raw) return false;
    if (/^\+?\d[\d\s-]{5,}$/.test(raw)) return true;
    const digits = normalizePhoneDigits(raw);
    return digits.length >= 7 && digits.length >= Math.max(7, raw.length - 3);
  };
  const resolveCustomerPrimaryLabel = (customer?: Customer | null, fallbackPhone?: string | null) => {
    const contactName = String(customer?.contactName || '').trim();
    const name = String(customer?.name || '').trim();
    const company = String(customer?.company || '').trim();
    const phone = String(fallbackPhone || customer?.phone || '').trim();
    const hasCompany = company && !looksLikePhoneLabel(company);
    const hasName = name && !looksLikePhoneLabel(name);
    const hasContactName = contactName && !looksLikePhoneLabel(contactName);
    if (hasContactName && hasCompany && contactName.toLowerCase() !== company.toLowerCase()) return `${contactName} - ${company}`;
    if (hasName && hasCompany && name.toLowerCase() !== company.toLowerCase()) return `${name} - ${company}`;
    if (hasContactName) return contactName;
    if (hasName) return name;
    if (hasCompany) return company;
    if (phone) return phone;
    return contactName || name || company || '';
  };
  const resolveChatContactPrimaryLabel = (row?: ChatContactRow | null) => {
    const contactName = String(row?.customer_contact_name || '').trim();
    const customerName = String(row?.customer_name || '').trim();
    const company = String(row?.customer_company || '').trim();
    const phone = String(row?.from_number || '').trim();
    const hasCompany = company && !looksLikePhoneLabel(company);
    const hasCustomerName = customerName && !looksLikePhoneLabel(customerName);
    const hasContactName = contactName && !looksLikePhoneLabel(contactName);
    if (hasContactName && hasCompany && contactName.toLowerCase() !== company.toLowerCase()) return `${contactName} - ${company}`;
    if (hasCustomerName && hasCompany && customerName.toLowerCase() !== company.toLowerCase()) return `${customerName} - ${company}`;
    if (hasContactName) return contactName;
    if (hasCustomerName) return customerName;
    if (hasCompany) return company;
    return phone;
  };
  const resolveConversationDisplayLabel = (conversation?: Conversation | null) => {
    if (!conversation) return 'Selecione uma conversa';
    const relatedCustomer = customers.find((item) => item.id === conversation.customerId);
    const preferred = resolveCustomerPrimaryLabel(relatedCustomer, resolveConversationFallbackPhone(conversation));
    if (preferred) return preferred;
    return resolveConversationFallbackPhone(conversation) || 'Desconhecido';
  };
  const customerHasPhoneDigits = (customer: Customer, digits: string) => {
    if (!digits) return false;
    const mainDigits = normalizePhoneDigits(customer.phone);
    if (mainDigits && (mainDigits === digits || mainDigits.endsWith(digits) || digits.endsWith(mainDigits))) {
      return true;
    }
    const contacts = Array.isArray(customer.contacts) ? customer.contacts : [];
    return contacts.some((contact) => {
      const contactDigits = normalizePhoneDigits(contact?.phone);
      return contactDigits && (contactDigits === digits || contactDigits.endsWith(digits) || digits.endsWith(contactDigits));
    });
  };




  const relatedCustomersForSelectedNumber = useMemo(() => {
    if (!selectedConversation) return [] as Customer[];

    const currentCustomer = customers.find((item) => item.id === selectedConversation.customerId) || null;
    const conversationDigits = extractPhoneDigitsFromConversationId(selectedConversation.id);
    const currentDigits = conversationDigits || normalizePhoneDigits(currentCustomer?.phone);
    if (!currentDigits) return currentCustomer ? [currentCustomer] : [];

    const matches = customers.filter((customer) => customerHasPhoneDigits(customer, currentDigits));

    const unique = matches.filter(
      (customer, index, all) => all.findIndex((item) => item.id === customer.id) === index
    );

    unique.sort((left, right) => {
      const activeCustomerId = selectedCustomerIdOverride || selectedConversation.customerId;
      if (left.id === activeCustomerId) return -1;
      if (right.id === activeCustomerId) return 1;
      return left.name.localeCompare(right.name, 'pt', { sensitivity: 'base' });
    });

    return unique;
  }, [selectedConversation, customers, selectedCustomerIdOverride]);

  const requestedConversationIdFromUrl = useMemo(() => {
    try {
      const params = new URLSearchParams(location.search || '');
      const value = String(params.get('conversationId') || '').trim();
      return value || null;
    } catch (_) {
      return null;
    }
  }, [location.search]);

  useEffect(() => {
    loadData();
    loadTemplates();
    const interval = setInterval(() => {
      void loadData();
      const activeConversationId = selectedConvRef.current;
      if (activeConversationId) {
        void loadMessages(activeConversationId);
      }
    }, 1500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(MESSAGE_UI_META_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, { starredIds?: string[]; pinnedId?: string | null }>;
      if (!parsed || typeof parsed !== 'object') return;
      const normalized: Record<string, { starredIds: string[]; pinnedId: string | null }> = {};
      Object.entries(parsed).forEach(([conversationId, entry]) => {
        normalized[String(conversationId)] = {
          starredIds: Array.isArray(entry?.starredIds)
            ? entry.starredIds.map((id) => String(id || '').trim()).filter(Boolean)
            : [],
          pinnedId: entry?.pinnedId ? String(entry.pinnedId) : null,
        };
      });
      setMessageUiMetaByConversation(normalized);
    } catch (error) {
      console.warn('[Inbox] falha ao carregar meta de mensagens:', error);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(MESSAGE_UI_META_STORAGE_KEY, JSON.stringify(messageUiMetaByConversation));
    } catch (error) {
      console.warn('[Inbox] falha ao guardar meta de mensagens:', error);
    }
  }, [messageUiMetaByConversation]);

  useEffect(() => {
    selectedConvRef.current = selectedConvId;
  }, [selectedConvId]);

  const handleSelectConversation = useCallback((conversationId: string) => {
    const normalizedConversationId = String(conversationId || '').trim();
    if (!normalizedConversationId) return;
    selectedConvRef.current = normalizedConversationId;
    setSelectedCustomerIdOverride(null);
    setSelectedConvId(normalizedConversationId);
  }, []);

  const canMarkConversationAsRead = useCallback(() => {
    if (typeof document === 'undefined') return true;
    const isVisible = document.visibilityState === 'visible';
    const isFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    return isVisible && isFocused;
  }, []);

  const markSelectedConversationReadIfActive = useCallback(async () => {
    const conversationId = selectedConvRef.current;
    if (!conversationId) return;
    if (!canMarkConversationAsRead()) return;

    const requestId = ++markReadRequestRef.current;
    try {
      await mockService.markConversationRead(conversationId);
      if (requestId !== markReadRequestRef.current) return;
      await loadData();
    } catch (_) {
      // mantém a UI funcional mesmo se falhar a marcação remota
    }
  }, [canMarkConversationAsRead]);

  useEffect(() => {
    if (selectedConvId) {
      loadMessagesRequestRef.current += 1;
      loadTasksRequestRef.current += 1;
      setMessages([]);
      setTasks([]);
      void loadMessages(selectedConvId);
      void loadTasks(selectedConvId);
      void markSelectedConversationReadIfActive();
      setShowTaskForm(false);
      setReplyingTo(null);
      setEditingMessage(null);
      setSelectedCustomerIdOverride(null);
      
      const conv = conversations.find(c => c.id === selectedConvId);
      const cust = customers.find(c => c.id === conv?.customerId);
      setNewTaskAssignee(cust?.ownerId || conv?.ownerId || CURRENT_USER_ID);
    } else {
      setMessages([]);
      setTasks([]);
    }
    setSelectedMessageIds([]);
    setDetailsMessage(null);
  }, [selectedConvId, markSelectedConversationReadIfActive]);

  useEffect(() => {
    if (!selectedConvId) return;
    const validIds = new Set(messages.map((message) => message.id));
    setSelectedMessageIds((previous) => previous.filter((id) => validIds.has(id)));
    setMessageUiMetaByConversation((previous) => {
      const current = previous[selectedConvId] || { starredIds: [], pinnedId: null as string | null };
      const nextStarred = current.starredIds.filter((id) => validIds.has(id));
      const nextPinned = current.pinnedId && validIds.has(current.pinnedId) ? current.pinnedId : null;
      const unchanged =
        nextPinned === current.pinnedId &&
        nextStarred.length === current.starredIds.length &&
        nextStarred.every((id, index) => id === current.starredIds[index]);
      if (unchanged) return previous;
      return {
        ...previous,
        [selectedConvId]: {
          starredIds: nextStarred,
          pinnedId: nextPinned,
        },
      };
    });
  }, [messages, selectedConvId]);

  useEffect(() => {
    if (!selectedConvId) return;
    if (conversations.some((item) => item.id === selectedConvId)) return;

    const fallback = selectedConvId.startsWith('wa_conv_')
      ? conversations.find((item) => `wa_conv_${item.customerId}` === selectedConvId)
      : undefined;

    if (fallback) {
      setSelectedConvId(fallback.id);
      return;
    }

    setSelectedConvId(null);
    setSelectedCustomerIdOverride(null);
    setMessages([]);
    setTasks([]);
  }, [selectedConvId, conversations]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;

    let isClosed = false;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;

    const scheduleRefresh = () => {
      if (realtimeRefreshTimerRef.current !== null) {
        window.clearTimeout(realtimeRefreshTimerRef.current);
      }
      realtimeRefreshTimerRef.current = window.setTimeout(() => {
        void loadData();
        const activeConversationId = selectedConvRef.current;
        if (activeConversationId) {
          void loadMessages(activeConversationId);
          void markSelectedConversationReadIfActive();
        }
      }, 120);
    };

    const notifyDesktopInbound = (ssePayload: Record<string, unknown>) => {
      const eventConvId = String(ssePayload.conversationId || '').trim();
      if (document.visibilityState === 'visible' && eventConvId && eventConvId === selectedConvRef.current) return;
      const fromPhone = String(ssePayload.from || '').replace(/\D/g, '');
      const bodyText = String(ssePayload.body || '').trim();
      if (!bodyText) return;
      const contact = chatContactsRef.current.find((c) => {
        const contactPhone = String(c.from_number || '').replace(/\D/g, '');
        return (contactPhone && fromPhone.endsWith(contactPhone)) || contactPhone.endsWith(fromPhone);
      });
      const senderName =
        String(contact?.customer_contact_name || '').trim() ||
        String(contact?.customer_name || '').trim() ||
        String(contact?.customer_company || '').trim() ||
        fromPhone ||
        'Cliente';

      setInboundToast({ from: senderName, body: bodyText.slice(0, 200), convId: eventConvId });
      if (inboundToastTimerRef.current) window.clearTimeout(inboundToastTimerRef.current);
      inboundToastTimerRef.current = window.setTimeout(() => setInboundToast(null), 6000);
    };

    const connect = () => {
      source = new EventSource('/api/chat/stream');
      source.onmessage = (event) => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(event.data || '{}');
        } catch (error) {
          return;
        }
        const eventType = String(payload.type || '').trim();
        if (!eventType || eventType === 'heartbeat' || eventType === 'connected') return;
        if (eventType === 'inbound_received') {
          notifyDesktopInbound(payload);
        }
        scheduleRefresh();
      };
      source.onerror = () => {
        if (source) {
          source.close();
          source = null;
        }
        if (!isClosed) {
          reconnectTimer = window.setTimeout(connect, 2000);
        }
      };
    };

    connect();

    return () => {
      isClosed = true;
      if (source) source.close();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (realtimeRefreshTimerRef.current !== null) {
        window.clearTimeout(realtimeRefreshTimerRef.current);
        realtimeRefreshTimerRef.current = null;
      }
    };
  }, [markSelectedConversationReadIfActive]);

  useEffect(() => {
    if (!selectedConvId) return;

    const handleFocus = () => {
      void markSelectedConversationReadIfActive();
    };

    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      void markSelectedConversationReadIfActive();
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [selectedConvId, markSelectedConversationReadIfActive]);

  useEffect(() => {
    requestedConversationAppliedRef.current = null;
  }, [requestedConversationIdFromUrl]);

  useEffect(() => {
    const requestedId = requestedConversationIdFromUrl;
    if (!requestedId) return;
    if (requestedConversationAppliedRef.current === requestedId) return;

    const applyRequestedConversation = (conversationId: string) => {
      const normalizedConversationId = String(conversationId || '').trim();
      if (!normalizedConversationId) return;
      requestedConversationAppliedRef.current = requestedId;
      selectedConvRef.current = normalizedConversationId;
      setSelectedCustomerIdOverride(null);
      setSelectedConvId(normalizedConversationId);
    };

    const hasExactConversation = conversations.some((item) => item.id === requestedId);
    if (hasExactConversation) {
      applyRequestedConversation(requestedId);
      return;
    }

    if (requestedId.startsWith('wa_conv_')) {
      const fallback = conversations.find((item) => `wa_conv_${item.customerId}` === requestedId);
      if (fallback) {
        applyRequestedConversation(fallback.id);
      }
    }
  }, [requestedConversationIdFromUrl, conversations]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!selectedCustomer?.id) {
      setSaftJobByType({});
      return;
    }

    let cancelled = false;
    const loadJobs = async () => {
      const jobs = await mockService.getSaftJobs(selectedCustomer.id);
      if (cancelled) return;
      const nextMap: Record<string, { status: string; fileName?: string; error?: string; updatedAt?: string }> = {};
      jobs.forEach((job) => {
        const key = String(job.documentType || '').trim();
        if (!key) return;
        if (!nextMap[key]) {
          nextMap[key] = {
            status: String(job.status || ''),
            fileName: job.fileName,
            error: job.error,
            updatedAt: job.updatedAt,
          };
        }
      });
      setSaftJobByType(nextMap);
    };

    void loadJobs();
    const interval = setInterval(() => {
      void loadJobs();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedCustomer?.id]);

  useEffect(() => {
    const conversation = conversations.find((item) => item.id === selectedConvId);
    const customer = conversation ? customers.find((item) => item.id === conversation.customerId) : null;
    if (customer?.id) {
      if (lastDocumentsCustomerIdRef.current === customer.id) return;
      lastDocumentsCustomerIdRef.current = customer.id;
      void loadCustomerDocuments(customer.id);
      return;
    }
    lastDocumentsCustomerIdRef.current = null;
    setCustomerDocuments([]);
    setCustomerDocumentsPath('');
    setCustomerDocumentsStoragePath('');
    setCustomerDocumentsCurrentPath('');
    setCanGoUpDocumentsPath(false);
    setCustomerDocsConfigured(false);
    setDocsError(null);
  }, [selectedConvId, conversations, customers]);

  useEffect(() => {
    const customerId = String(selectedCustomer?.id || '').trim();
    if (!customerId) {
      setOpenOccurrences([]);
      setOpenOccurrencesLoading(false);
      setOpenOccurrencesError(null);
      return;
    }

    let cancelled = false;
    const run = async () => {
      setOpenOccurrencesLoading(true);
      setOpenOccurrencesError(null);
      try {
        const rows = await fetchOccurrences({ limit: 3000 });
        if (cancelled) return;
        const filtered = rows
          .filter((row) => String(row.customerId || '').trim() === customerId)
          .filter((row) => String(row.state || '').trim().toUpperCase() !== 'RESOLVIDA')
          .sort((left, right) => {
            const leftDate = String(left.dueDate || left.date || '').trim();
            const rightDate = String(right.dueDate || right.date || '').trim();
            if (leftDate && rightDate) return leftDate.localeCompare(rightDate);
            if (leftDate) return -1;
            if (rightDate) return 1;
            return String(left.title || '').localeCompare(String(right.title || ''), 'pt', { sensitivity: 'base' });
          });
        setOpenOccurrences(filtered);
      } catch (error) {
        if (cancelled) return;
        setOpenOccurrences([]);
        setOpenOccurrencesError(error instanceof Error ? error.message : 'Falha ao carregar ocorrências abertas.');
      } finally {
        if (!cancelled) setOpenOccurrencesLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [selectedCustomer?.id, selectedCustomer?.nif, selectedCustomer?.company, selectedCustomer?.name]);

  useEffect(() => {
    if (newTaskTitle.length > 3 && tasks.length > 0) {
      const match = tasks.find(t => 
        t.title.toLowerCase().includes(newTaskTitle.toLowerCase()) || 
        newTaskTitle.toLowerCase().includes(t.title.toLowerCase())
      );
      if (match) {
        setDuplicateWarning(`Possível duplicado: "${match.title}" (${match.status})`);
      } else {
        setDuplicateWarning(null);
      }
    } else {
      setDuplicateWarning(null);
    }
  }, [newTaskTitle, tasks]);

  const refreshChatContacts = useCallback(async () => {
    const contacts = await fetchChatContacts().catch(() => []);
    setChatContacts(Array.isArray(contacts) ? contacts : []);
  }, []);

  const handleSaveContactName = useCallback(async (customerId: string, newName: string) => {
    setSavingContactNameId(customerId);
    try {
      const res = await fetch(`/api/customers/${encodeURIComponent(customerId)}/contact-name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactName: newName }),
      });
      if (!res.ok) throw new Error('Falha ao guardar');
      setCustomers((prev) =>
        prev.map((c) => (c.id === customerId ? { ...c, contactName: newName } : c))
      );
    } catch (error) {
      console.error('[Contacts] Erro ao guardar nome:', error);
    } finally {
      setSavingContactNameId(null);
      setEditingContactNameId(null);
    }
  }, []);

  const loadData = async (): Promise<Conversation[]> => {
    const requestId = ++loadDataRequestRef.current;
    const [convs, custs, tCount, contacts, allTasksData, whatsappHealth, whatsappAccountsList] = await Promise.all([
      mockService.getConversations(),
      mockService.getCustomers(),
      mockService.getTemplateCountMonth(),
      fetchChatContacts().catch(() => []),
      mockService.getTasks(),
      fetchWhatsAppHealth().catch(() => null),
      fetchWhatsAppAccounts().catch(() => []),
    ]);
    if (requestId !== loadDataRequestRef.current) return [];

    syncConversationSnapshotAndNotify(convs);
    setConversations(convs);
    setCustomers(custs);
    setTemplateCount(tCount);
    setChatContacts(Array.isArray(contacts) ? contacts : []);
    setAllTasks(Array.isArray(allTasksData) ? allTasksData : []);
    const providerRaw = String(whatsappHealth?.provider || '').trim().toLowerCase();
    if (providerRaw === 'cloud') {
      setWhatsappProviderMode('cloud');
    } else if (providerRaw === 'baileys') {
      setWhatsappProviderMode('baileys');
    }
    const healthAccounts = Array.isArray(whatsappHealth?.accounts) ? whatsappHealth.accounts : [];
    const normalizedAccounts = (healthAccounts.length > 0 ? healthAccounts : whatsappAccountsList)
      .map((account) => ({
        accountId: String(account?.accountId || '').trim(),
        label: String(account?.label || account?.accountId || '').trim(),
        isDefault: account?.isDefault === true,
        provider: String(account?.provider || '').trim() || undefined,
        configured: account?.configured === true,
        status: String(account?.status || '').trim() || undefined,
        connected: account?.connected === true,
        connecting: account?.connecting === true,
        qrAvailable: account?.qrAvailable === true,
        qrUpdatedAt: String(account?.qrUpdatedAt || '').trim() || null,
        lastError: String(account?.lastError || '').trim() || null,
        meId: String(account?.meId || '').trim() || null,
        meName: String(account?.meName || '').trim() || null,
      }))
      .filter((account) => account.accountId);
    setWhatsAppAccounts(normalizedAccounts);
    return Array.isArray(convs) ? convs : [];
  };






  const loadTemplates = async () => {
    const templates = await mockService.getManagedTemplates('template');
    setManagedTemplates(templates.filter(item => item.isActive));
    if (!selectedTemplateId && templates.length > 0) {
      setSelectedTemplateId(templates[0].id);
    }
  };

  const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / Math.pow(1024, index);
    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  };

  const formatDateTimePt = (value?: string | null) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleString('pt-PT');
  };

  const loadCustomerDocuments = async (customerId: string, relativePath = '') => {
    setIsDocumentsLoading(true);
    setDocsError(null);
    try {
      const payload = await mockService.getCustomerDocumentsAtPath(customerId, relativePath);
      setCustomerDocuments(payload.entries);
      setCustomerDocumentsPath(payload.folderPath);
      setCustomerDocumentsStoragePath(payload.storageFolderPath || '');
      setCustomerDocumentsCurrentPath(payload.currentRelativePath);
      setCanGoUpDocumentsPath(payload.canGoUp);
      setCustomerDocsConfigured(payload.configured);
    } catch (error) {
      setCustomerDocuments([]);
      setCustomerDocumentsPath('');
      setCustomerDocumentsStoragePath('');
      setCustomerDocumentsCurrentPath('');
      setCanGoUpDocumentsPath(false);
      setCustomerDocsConfigured(false);
      setDocsError(error instanceof Error ? error.message : 'Falha ao carregar documentos.');
    } finally {
      setIsDocumentsLoading(false);
    }
  };

  const handleDocumentDownload = (relativePath: string) => {
    if (!selectedCustomer?.id) return;
    const query = new URLSearchParams({ path: relativePath });
    window.open(`/api/customers/${encodeURIComponent(selectedCustomer.id)}/documents/download?${query.toString()}`, '_blank');
  };

  const chooseCustomerFolder = async () => {
    if (!selectedCustomer?.id) return;
    const pickerFn = (window as unknown as { showDirectoryPicker?: (options?: Record<string, unknown>) => Promise<unknown> }).showDirectoryPicker;
    if (typeof pickerFn !== 'function') {
      setDocsError('Este browser não suporta seleção de pasta dedicada.');
      return;
    }
    try {
      const handle = await pickerFn({
        id: `customer-folder-${selectedCustomer.id}`,
        mode: 'read',
      });
      if (!handle) return;
      setCustomerFolderHandles((prev) => ({
        ...prev,
        [selectedCustomer.id]: handle,
      }));
      setDocsError(null);
    } catch (error) {
      const name = (error as { name?: string })?.name || '';
      if (name !== 'AbortError') {
        setDocsError('Não foi possível definir a pasta deste cliente.');
      }
    }
  };

  const uploadDocumentForSelectedCustomer = async (file: File, relativePath = customerDocumentsCurrentPath) => {
    if (!selectedCustomer?.id) return;

    setIsUploadingDocument(true);
    setDocsError(null);
    try {
      await mockService.uploadCustomerDocument(selectedCustomer.id, file, relativePath);
      await loadCustomerDocuments(selectedCustomer.id, relativePath);
      alert(`Documento "${file.name}" guardado em ${customerDocumentsPath || 'pasta do cliente'}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao guardar documento.';
      setDocsError(message);
      alert(`Erro ao guardar documento: ${message}`);
    } finally {
      setIsUploadingDocument(false);
    }
  };

  const triggerDocumentPicker = async () => {
    if (!selectedCustomer?.id) return;

    const pickerFn = (window as unknown as { showOpenFilePicker?: (options?: Record<string, unknown>) => Promise<Array<{ getFile: () => Promise<File> }>> }).showOpenFilePicker;
    const startInHandle = customerFolderHandles[selectedCustomer.id];

    if (typeof pickerFn === 'function') {
      try {
        const handles = await pickerFn({
          id: `customer-docs-${selectedCustomer.id}`,
          ...(startInHandle ? { startIn: startInHandle } : {}),
          multiple: false,
          types: [
            { description: 'Documentos', accept: { '*/*': ['.pdf', '.xml', '.doc', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png', '.txt'] } },
          ],
          excludeAcceptAllOption: false,
        });
        const file = await handles?.[0]?.getFile?.();
        if (file) {
          await uploadDocumentForSelectedCustomer(file, customerDocumentsCurrentPath);
        }
        return;
      } catch (error) {
        const name = (error as { name?: string })?.name || '';
        if (name !== 'AbortError') {
          console.warn('[Docs] showOpenFilePicker indisponível/erro, fallback input file:', error);
        } else {
          return;
        }
      }
    }

    documentInputRef.current?.click();
  };

  const handleDocumentUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await uploadDocumentForSelectedCustomer(file, customerDocumentsCurrentPath);
  };

  const openDocumentsFolder = async (relativePath: string) => {
    if (!selectedCustomer?.id) return;
    await loadCustomerDocuments(selectedCustomer.id, relativePath);
  };

  const goUpDocumentsFolder = async () => {
    if (!selectedCustomer?.id) return;
    const segments = String(customerDocumentsCurrentPath || '')
      .split('/')
      .filter(Boolean);
    segments.pop();
    await loadCustomerDocuments(selectedCustomer.id, segments.join('/'));
  };

  const handleDropLocalFilesToConversation = async (files: File[]) => {
    if (!selectedConvId || !selectedCustomer?.id || files.length === 0) return;
    if (!isWithin24hWindow) {
      alert('Janela de 24h fechada. Só é permitido template nesta fase.');
      return;
    }

    for (const file of files) {
      try {
        const uploaded = await mockService.uploadCustomerDocument(
          selectedCustomer.id,
          file,
          customerDocumentsCurrentPath
        );
        const isImage = String(file.type || '').startsWith('image/');
        if (isImage) {
          await mockService.sendImageMessage(selectedConvId, {
            mediaPath: uploaded.fullPath,
            fileName: uploaded.fileName || file.name,
            mimeType: file.type,
          });
        } else {
          await mockService.sendDocumentMessage(selectedConvId, {
            mediaPath: uploaded.fullPath,
            fileName: uploaded.fileName || file.name,
            mimeType: file.type,
          });
        }
      } catch (error) {
        alert(error instanceof Error ? error.message : `Falha ao processar ficheiro ${file.name}.`);
      }
    }

    await loadMessages(selectedConvId);
    await loadCustomerDocuments(selectedCustomer.id, customerDocumentsCurrentPath);
    await loadData();
  };

  const handleDropCustomerDocumentToConversation = async (relativePath: string, fileName: string) => {
    if (!selectedConvId || !selectedCustomer?.id) return;
    if (!isWithin24hWindow) {
      alert('Janela de 24h fechada. Só é permitido template nesta fase.');
      return;
    }
    try {
      const safeStorageRoot = String(customerDocumentsStoragePath || '').trim().replace(/[\\/]+$/, '');
      const safeRelativePath = String(relativePath || '').trim().replace(/^[/\\]+/, '');
      if (!safeStorageRoot || !safeRelativePath) {
        throw new Error('Pasta local do cliente não está disponível para envio de documento.');
      }
      const mediaPath = `${safeStorageRoot}/${safeRelativePath}`.replace(/\\/g, '/');
      const lowerName = String(fileName || safeRelativePath).toLowerCase();
      const mimeType =
        lowerName.endsWith('.pdf') ? 'application/pdf'
        : lowerName.endsWith('.xml') ? 'application/xml'
        : lowerName.endsWith('.doc') ? 'application/msword'
        : lowerName.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : lowerName.endsWith('.xls') ? 'application/vnd.ms-excel'
        : lowerName.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') ? 'image/jpeg'
        : lowerName.endsWith('.png') ? 'image/png'
        : 'application/octet-stream';
      if (mimeType.startsWith('image/')) {
        await mockService.sendImageMessage(selectedConvId, {
          mediaPath,
          fileName,
          mimeType,
        });
      } else {
        await mockService.sendDocumentMessage(selectedConvId, {
          mediaPath,
          fileName,
          mimeType,
        });
      }
      await loadMessages(selectedConvId);
      await loadData();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Falha ao enviar documento na conversa.');
    }
  };

  const extractFirstUrlFromText = (value: string) => {
    const match = String(value || '').match(/https?:\/\/[^\s]+/i);
    return match ? match[0].trim() : '';
  };

  const sanitizeDownloadFileName = (value: string) => {
    return String(value || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const guessFileNameFromMessage = (messageBody: string, sourceUrl: string) => {

    const lines = String(messageBody || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const firstNonUrlLine = lines.find((line) => !/^https?:\/\//i.test(line));
    if (firstNonUrlLine) {
      const candidate = sanitizeDownloadFileName(firstNonUrlLine.replace(/^📎\s*/, ''));
      if (candidate && /\.[a-z0-9]{2,8}$/i.test(candidate)) return candidate;
    }

    try {
      const parsed = new URL(sourceUrl);
      const byPath = sanitizeDownloadFileName(decodeURIComponent(parsed.pathname.split('/').pop() || ''));
      if (byPath) return byPath;
    } catch {
      // fallback below
    }

    return `mensagem_${Date.now()}.txt`;
  };

  const handleDropMessageToCurrentFolder = async (messageBody: string) => {
    if (!selectedCustomer?.id) return;
    const sourceUrl = extractFirstUrlFromText(messageBody);
    if (!sourceUrl) {
      setDocsError('Arraste uma mensagem que contenha um link de ficheiro.');
      return;
    }

    setIsUploadingDocument(true);
    setDocsError(null);
    try {
      const fileName = guessFileNameFromMessage(messageBody, sourceUrl);
      await mockService.importCustomerDocumentFromUrl(
        selectedCustomer.id,
        sourceUrl,
        fileName,
        customerDocumentsCurrentPath
      );
      await loadCustomerDocuments(selectedCustomer.id, customerDocumentsCurrentPath);
      alert(`Documento "${fileName}" guardado em ${customerDocumentsPath || 'pasta do cliente'}.`);
    } catch (error) {
      setDocsError(error instanceof Error ? error.message : 'Falha ao guardar ficheiro da conversa.');
    } finally {
      setIsUploadingDocument(false);
    }
  };

  const handleSaftRequest = async (documentType: SaftDocumentType) => {
    setSaftFeedback(`A iniciar pedido: ${documentType.replace('_', ' ')}...`);

    if (!selectedConvId) {
      setSaftFeedback('Selecione uma conversa antes de pedir documentos SAFT.');
      return;
    }

    const activeConversation = conversations.find((item) => item.id === selectedConvId);
    const activeCustomer =
      selectedCustomer ||
      customers.find((item) => item.id === activeConversation?.customerId) ||
      null;

    if (!activeCustomer?.id) {
      setSaftFeedback('Cliente desta conversa não encontrado. Atualize a página (Ctrl+F5).');
      return;
    }

    if (!activeCustomer.nif) {
      setSaftFeedback('Este cliente não tem NIF preenchido na ficha.');
      return;
    }

    if (!activeCustomer.phone) {
      setSaftFeedback('Este cliente não tem telefone válido para envio.');
      return;
    }

    setSaftLoadingType(documentType);
    setSaftFeedback('');
    try {
      const result = await mockService.requestSaftDocument(activeCustomer.id, selectedConvId, documentType);
      if (!result.success) {
        setSaftFeedback(result.error || 'Falha ao pedir documento SAFT.');
        setSaftJobByType((previous) => ({
          ...previous,
          [documentType]: { status: result.status || 'error', error: result.error || result.message },
        }));
        return;
      }
      if (result.status === 'pending') {
        setSaftFeedback(result.message || 'Pedido em recolha. Assim que o documento existir será enviado.');
        setSaftJobByType((previous) => ({
          ...previous,
          [documentType]: { status: 'pending' },
        }));
      } else if (result.status === 'sent') {
        setSaftFeedback(result.fileName ? `Enviado: ${result.fileName}` : 'Documento enviado com sucesso.');
      } else {
        setSaftFeedback(result.message || `Estado atual: ${result.status || 'desconhecido'}.`);
      }
      if (activeCustomer.id) {
        const jobs = await mockService.getSaftJobs(activeCustomer.id);
        const nextMap: Record<string, { status: string; fileName?: string; error?: string; updatedAt?: string }> = {};
        jobs.forEach((job) => {
          const key = String(job.documentType || '').trim();
          if (!key || nextMap[key]) return;
          nextMap[key] = {
            status: String(job.status || ''),
            fileName: job.fileName,
            error: job.error,
            updatedAt: job.updatedAt,
          };
        });
        setSaftJobByType(nextMap);
      }
      await loadMessages(selectedConvId);
    } catch (error) {
      setSaftFeedback(error instanceof Error ? error.message : 'Falha ao executar pedido SAFT.');
    } finally {
      setSaftLoadingType(null);
    }
  };

  const handleSyncCompanyDocs = async () => {
    if (!selectedConvId) {
      setSaftFeedback('Selecione uma conversa antes de iniciar a recolha do dossier.');
      return;
    }

    const activeConversation = conversations.find((item) => item.id === selectedConvId);
    const activeCustomer =
      selectedCustomer ||
      customers.find((item) => item.id === activeConversation?.customerId) ||
      null;

    if (!activeCustomer?.id) {
      setSaftFeedback('Cliente desta conversa não encontrado. Atualize a página (Ctrl+F5).');
      return;
    }

    if (!activeCustomer.nif) {
      setSaftFeedback('Este cliente não tem NIF preenchido na ficha.');
      return;
    }

    setSaftLoadingType('sync_company_docs');
    setSaftFeedback('A recolher documentos do dossier (dados_empresa)...');

    try {
      const result = await mockService.syncSaftCompanyDocs(activeCustomer.id, {
        yearsBack: 3,
        force: false,
      });

      if (!result.success) {
        setSaftFeedback(result.error || 'Falha na recolha documental do dossier.');
        return;
      }

      const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
      const warningText = warnings.length > 0 ? ` Avisos: ${warnings.slice(0, 2).join(' | ')}` : '';
      setSaftFeedback(
        `Recolha concluída: ${Number(result.syncedFiles || 0)} ficheiro(s) sincronizados, ${Number(result.skippedFiles || 0)} ignorado(s).${warningText}`
      );
      await loadCustomerDocuments(activeCustomer.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha na recolha documental do dossier.';
      setSaftFeedback(message);
    } finally {
      setSaftLoadingType(null);
    }
  };

  const loadMessages = async (id: string) => {
    const requestId = ++loadMessagesRequestRef.current;
    const msgs = await mockService.getMessages(id);
    if (requestId !== loadMessagesRequestRef.current) return;
    if (selectedConvRef.current !== id) return;
    syncMessageSnapshotAndNotify(id, msgs);
    setMessages((previous) => {
      if (previous.length !== msgs.length) return msgs;
      for (let index = 0; index < msgs.length; index += 1) {
        const prev = previous[index];
        const next = msgs[index];
        if (!prev || !next) return msgs;
        if (
          prev.id !== next.id ||
          prev.body !== next.body ||
          prev.timestamp !== next.timestamp ||
          prev.status !== next.status ||
          prev.direction !== next.direction ||
          prev.type !== next.type
        ) {
          return msgs;
        }
      }
      return previous;
    });
  };

  const loadTasks = async (convId: string) => {
    const requestId = ++loadTasksRequestRef.current;
    const tasksData = await mockService.getTasks(convId);
    if (requestId !== loadTasksRequestRef.current) return;
    if (selectedConvRef.current !== convId) return;
    setTasks(tasksData);
  };

  // Regra de janela 24h desativada por decisão operacional:
  // nesta fase a equipa não está a trabalhar com templates Meta.
  const enforce24hTemplateWindow = false;

  // 24 Hour Window Logic (Meta Cloud only). In Baileys we allow free text by default.
  const isWithin24hWindow = useMemo(() => {
      if (!enforce24hTemplateWindow) return true;
      // Find last message FROM CUSTOMER (direction: 'in') to start the 24h window
      // We must check 'in' messages specifically, not just the last message of the conversation.
      const inboundMessages = messages.filter(m => m.direction === 'in');
      if (!inboundMessages.length) return false; 
      
      // Get the very last inbound message
      const lastInMsg = inboundMessages[inboundMessages.length - 1];

      const lastMsgTime = new Date(lastInMsg.timestamp).getTime();
      const now = Date.now();
      const hoursDiff = (now - lastMsgTime) / (1000 * 60 * 60);
      return hoursDiff < 24;
  }, [messages, enforce24hTemplateWindow]);

  const focusMessageComposer = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      const input = messageComposerRef.current;
      if (!input || input.disabled) return;
      input.focus();
      const endPos = input.value.length;
      try {
        input.setSelectionRange(endPos, endPos);
      } catch {
        // sem bloqueio
      }
    });
  }, []);

  const handleSendClick = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!selectedConvId) return;

      if (editingMessage) {
        const nextText = newMessage.trim();
        if (!nextText) return;
        try {
          await mockService.editMessage(selectedConvId, editingMessage.id, nextText);
          setEditingMessage(null);
          setNewMessage('');
          await loadMessages(selectedConvId);
          focusMessageComposer();
        } catch (error) {
          alert(error instanceof Error ? error.message : 'Falha ao editar mensagem.');
        }
        return;
      }

      if (!newMessage.trim()) return;

      if (!isWithin24hWindow) {
          // Double check: UI should prevent this, but just in case
          setShowTemplateConfirm(true);
      } else {
          await performSendMessage('text');
      }
  };

  const performSendMessage = async (type: 'text' | 'template', templateId?: string) => {
    if (!selectedConvId) return;
    try {
      const activeTemplate = managedTemplates.find(item => item.id === templateId);
      const variables = {
        nome: selectedCustomer?.name || '',
        empresa: selectedCustomer?.company || '',
        telefone: selectedCustomer?.phone || '',
      };
      const payloadText =
        type === 'template'
          ? (activeTemplate?.content || newMessage || 'Template')
          : newMessage;
      const replyText = replyingTo
        ? `↪ Em resposta a: ${String(replyingTo.body || '').slice(0, 140)}\n`
        : '';
      const finalText = `${replyText}${payloadText}`.trim();

      const sentMessage = await mockService.sendMessage(
        selectedConvId,
        finalText,
        type,
        type === 'template'
          ? { templateId: templateId || selectedTemplateId || undefined, variables }
          : undefined
      );
      setMessages((prev) => {
        if (prev.some((msg) => msg.id === sentMessage.id)) return prev;
        return [...prev, sentMessage].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
      });
      setNewMessage('');
      setReplyingTo(null);
      setShowTemplateConfirm(false);
      setShowTemplatePicker(false);
      await loadData();
      await loadMessages(selectedConvId);
      focusMessageComposer();
      window.setTimeout(() => {
        if (selectedConvRef.current === selectedConvId) {
          void loadMessages(selectedConvId);
          focusMessageComposer();
        }
      }, 1200);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao enviar mensagem.';
      alert(`Erro no envio: ${message}`);
    }
  };

  const handleStatusChange = async (newStatus: ConversationStatus) => {
    if (!selectedConvId) return;
    await mockService.updateConversationStatus(selectedConvId, newStatus);
    loadData();
  };


  const handleTriggerFinancasAutologin = async () => {
    const customer = selectedCustomer;
    if (!customer?.id || financasAutologinBusyCustomerId || segSocialAutologinBusyCustomerId) return;

    const customerId = String(customer.id || '').trim();
    if (!customerId) return;

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

    setFinancasAutologinBusyCustomerId(customerId);
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
          if (bridgeResult?.success) return;
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
        await openLoginWithClipboard('O servidor não tem ambiente gráfico para abrir browser.');
      } else if (classifyAutologinFallbackReason(rawMessage) === 'automation_unavailable') {
        await openLoginWithClipboard(
          'Autologin automático indisponível neste computador (browser de automação não instalado).',
          isDesktopShell
        );
      } else if (classifyAutologinFallbackReason(rawMessage) === 'fields_not_found') {
        await showManualPasteHintWithoutOpening('Não consegui preencher automaticamente os campos de login neste ecrã da AT.');
      } else {
        window.alert(rawMessage);
      }
    } finally {
      setFinancasAutologinBusyCustomerId(null);
    }
  };

  const handleTriggerSegSocialAutologin = async () => {
    const customer = selectedCustomer;
    if (!customer?.id || segSocialAutologinBusyCustomerId || financasAutologinBusyCustomerId) return;

    const customerId = String(customer.id || '').trim();
    if (!customerId) return;

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
          if (bridgeResult?.success) return;
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
        await openLoginWithClipboard('O servidor não tem ambiente gráfico para abrir browser.');
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

  const readTaskAttachmentFile = (file: File): Promise<TaskAttachment> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result !== 'string') {
          reject(new Error('Falha ao ler anexo da tarefa.'));
          return;
        }
        resolve({
          id: 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: Number(file.size || 0),
          dataUrl: reader.result,
          createdAt: new Date().toISOString(),
        });
      };
      reader.onerror = () => reject(new Error('Falha ao ler anexo da tarefa.'));
      reader.readAsDataURL(file);
    });

  const handleTaskAttachmentsSelected = async (files: FileList | null) => {
    const list = Array.from(files || []);
    if (list.length === 0) return;

    try {
      const parsed = await Promise.all(
        list.map(async (file) => {
          const maxSize = 8 * 1024 * 1024;
          if (Number(file.size || 0) > maxSize) {
            throw new Error('O ficheiro "' + file.name + '" excede 8MB.');
          }
          return readTaskAttachmentFile(file);
        })
      );
      setNewTaskAttachments((prev) => [...prev, ...parsed].slice(0, 8));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao anexar ficheiro da tarefa.';
      alert(message);
    }
  };

  const handleRemoveTaskAttachment = (attachmentId: string) => {
    setNewTaskAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
  };

  const handleToggleTaskForm = () => {
    setShowTaskForm((prev) => !prev);
    setNewTaskAttachments([]);
  };

  const handleCancelTaskForm = () => {
    setShowTaskForm(false);
    setNewTaskAttachments([]);
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedConvId || !newTaskTitle) return;

    await mockService.createTask({
      conversationId: selectedConvId,
      title: newTaskTitle,
      status: TaskStatus.OPEN,
      priority: newTaskPriority,
      dueDate: new Date(Date.now() + 86400000).toISOString(),
      assignedUserId: newTaskAssignee,
      notes: '',
      attachments: newTaskAttachments,
    });
    setNewTaskTitle('');
    setNewTaskAttachments([]);
    setShowTaskForm(false);
    await loadTasks(selectedConvId);
    await loadData();
  };

  const handleToggleTaskStatus = async (task: Task) => {
    const nextStatus = task.status === TaskStatus.DONE ? TaskStatus.OPEN : TaskStatus.DONE;
    await mockService.updateTaskStatus(task.id, nextStatus);
    if (selectedConvId) {
      await loadTasks(selectedConvId);
    }
    await loadData();
  };

  const openCustomerProfileInCustomersPage = () => {
    if (!selectedCustomer?.id) return;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(OPEN_CUSTOMER_PROFILE_STORAGE_KEY, selectedCustomer.id);
      }
    } catch {
      // ignore localStorage failures
    }
    navigate('/customers');
  };

  const handleOpenCustomerProfile = () => {
    if (!selectedCustomer?.id) return;
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 1023px)').matches) {
      openCustomerProfileInCustomersPage();
      return;
    }
    setIsCustomerProfileOpen(true);
  };

  const handleSaveCustomerNotes = async (notes: string) => {
    if (!selectedCustomer?.id) return;
    await mockService.updateCustomer(selectedCustomer.id, { notes: String(notes || '').trim() });
    await loadData();
  };
  
  const handleCreateTaskFromMessage = (messageText: string) => {
      setNewTaskTitle(messageText);
      setNewTaskAttachments([]);
      setShowTaskForm(true);
  };

  const handleReplyMessage = (message: Message) => {
    setEditingMessage(null);
    setReplyingTo(message);
  };

  const handleEditMessage = (message: Message) => {
    setReplyingTo(null);
    setEditingMessage(message);
    setNewMessage(message.body);
  };

  const handleDeleteMessage = async (message: Message) => {
    if (!selectedConvId) return;
    const confirmed = window.confirm('Apagar esta mensagem nesta conversa?');
    if (!confirmed) return;
    try {
      await mockService.deleteMessage(selectedConvId, message.id);
      await loadMessages(selectedConvId);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Falha ao apagar mensagem.');
    }
  };

  const handleForwardMessage = (message: Message) => {
    setForwardingMessage(message);
    setForwardSearch('');
    setShowForwardModal(true);
  };

  const handleToggleSelectMessage = (message: Message) => {
    setSelectedMessageIds((previous) =>
      previous.includes(message.id)
        ? previous.filter((id) => id !== message.id)
        : [...previous, message.id]
    );
  };

  const handleToggleStarMessage = (message: Message) => {
    if (!selectedConvId) return;
    setMessageUiMetaByConversation((previous) => {
      const current = previous[selectedConvId] || { starredIds: [], pinnedId: null as string | null };
      const exists = current.starredIds.includes(message.id);
      const next = exists
        ? current.starredIds.filter((id) => id !== message.id)
        : [...current.starredIds, message.id];
      return {
        ...previous,
        [selectedConvId]: {
          ...current,
          starredIds: next,
        },
      };
    });
  };

  const handleTogglePinMessage = (message: Message) => {
    if (!selectedConvId) return;
    setMessageUiMetaByConversation((previous) => {
      const current = previous[selectedConvId] || { starredIds: [], pinnedId: null as string | null };
      return {
        ...previous,
        [selectedConvId]: {
          ...current,
          pinnedId: current.pinnedId === message.id ? null : message.id,
        },
      };
    });
  };

  const handleShowMessageDetails = (message: Message) => {
    setDetailsMessage(message);
  };

  const handleConfirmForward = async (targetConversationId: string) => {
    if (!forwardingMessage) return;
    try {
      await mockService.forwardMessage(targetConversationId, forwardingMessage.body);
      if (selectedConvId && targetConversationId === selectedConvId) {
        await loadMessages(selectedConvId);
      }
      await loadData();
      setShowForwardModal(false);
      setForwardingMessage(null);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Falha ao reencaminhar mensagem.');
    }
  };

  const triggerImagePicker = () => {
    if (selectedConversation?.status === ConversationStatus.CLOSED) return;
    imageInputRef.current?.click();
  };

  const sendImageFileToChat = async (file: File) => {
    if (!file || !selectedConvId || !selectedCustomer?.id) return;
    if (!String(file.type || '').toLowerCase().startsWith('image/')) {
      alert('Só é possível colar/enviar imagens nesta ação.');
      return;
    }
    if (!isWithin24hWindow) {
      alert('Janela de 24h fechada. Só é permitido template nesta fase.');
      return;
    }

    setIsSendingImage(true);
    try {
      const uploaded = await mockService.uploadCustomerDocument(selectedCustomer.id, file, customerDocumentsCurrentPath);
      const sent = await mockService.sendImageMessage(selectedConvId, {
        mediaPath: uploaded.fullPath,
        fileName: uploaded.fileName || file.name,
        mimeType: file.type,
        caption: newMessage.trim() || undefined,
      });
      setMessages((prev) => {
        if (prev.some((msg) => msg.id === sent.id)) return prev;
        return [...prev, sent].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
      });
      setNewMessage('');
      setReplyingTo(null);
      setEditingMessage(null);
      window.setTimeout(() => {
        if (selectedConvRef.current === selectedConvId) {
          void loadMessages(selectedConvId);
        }
      }, 900);
      await loadCustomerDocuments(selectedCustomer.id, customerDocumentsCurrentPath);
      await loadData();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Falha ao enviar imagem.');
    } finally {
      setIsSendingImage(false);
    }
  };

  const handleImageUploadForChat = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await sendImageFileToChat(file);
  };

  const handlePasteOnChatComposer = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItem = items.find((item) => item.kind === 'file' && String(item.type || '').toLowerCase().startsWith('image/'));
    if (!imageItem) return;
    const imageFile = imageItem.getAsFile();
    if (!imageFile) return;
    event.preventDefault();
    await sendImageFileToChat(imageFile);
  };

  const handleLogCall = async () => {
    if(!selectedConvId || !selectedCustomer) return;
    
    await mockService.createCall({
      customerId: selectedCustomer.id,
      userId: CURRENT_USER_ID,
      startedAt: new Date().toISOString(),
      durationSeconds: parseInt(callDuration) * 60,
      notes: callNotes,
      source: 'manual'
    });
    setShowCallModal(false);
    setCallDuration('');
    setCallNotes('');
    alert('Chamada registada!');
  };

  // --- New Chat Logic ---
  const handleStartNewChat = async (customerId: string) => {
      const targetCustomerId = String(customerId || '').trim();
      if (!targetCustomerId) return;
      try {
        const createdConversation = await mockService.createConversation(targetCustomerId);
        setShowNewChatModal(false);
        setNewChatSearch('');
        const refreshedConversations = await loadData(); // recarrega e obtém o ID final canónico
        const resolvedConversation =
          refreshedConversations.find((conversation) => String(conversation.customerId || '').trim() === targetCustomerId) ||
          refreshedConversations.find((conversation) => String(conversation.id || '').trim() === String(createdConversation.id || '').trim()) ||
          createdConversation;
        if (resolvedConversation?.id) {
          setSelectedConvId(String(resolvedConversation.id));
        }
      } catch (error) {
        alert(error instanceof Error ? error.message : 'Falha ao iniciar conversa.');
      }
  };

  const handleStartChatFromContacts = async (customerId: string) => {
    const targetId = String(customerId || '').trim();
    if (!targetId || startingContactId) return;

    setStartingContactId(targetId);
    try {
      await handleStartNewChat(targetId);
      setShowContactsModal(false);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Falha ao iniciar conversa.');
    } finally {
      setStartingContactId(null);
    }
  };

  const handleBlockSelectedContact = async () => {
    const info = selectedConversationContactInfo;
    if (!info?.contactKey) {
      alert('Não foi possível identificar o contacto desta conversa para bloquear.');
      return;
    }
    if (isContactBlockBusy) return;

    let reasonInput = '';
    try {
      const promptResult = window.prompt('Motivo do bloqueio (opcional):', info.blockedReason || '');
      if (promptResult === null) return;
      reasonInput = String(promptResult || '');
    } catch (_) {
      const shouldContinue = window.confirm('Confirmas bloquear este contacto?');
      if (!shouldContinue) return;
      reasonInput = '';
    }

    setIsContactBlockBusy(true);
    try {
      await blockChatContact({
        channel: info.channel,
        contactKey: info.contactKey,
        reason: String(reasonInput || '').trim(),
        actorUserId: CURRENT_USER_ID || null,
      });
      await refreshChatContacts();
      await loadData();
      setSelectedConvId(null);
      setSelectedCustomerIdOverride(null);
      setMessages([]);
      setTasks([]);
      alert('Contacto bloqueado. Novas mensagens deste contacto serão ignoradas.');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Falha ao bloquear contacto.');
    } finally {
      setIsContactBlockBusy(false);
    }
  };

  const handleUnblockSelectedContact = async () => {
    const info = selectedConversationContactInfo;
    if (!info?.contactKey && !info?.blockedId) {
      alert('Não foi possível identificar o contacto bloqueado para desbloquear.');
      return;
    }
    if (isContactBlockBusy) return;

    const shouldContinue = window.confirm('Confirmas desbloquear este contacto?');
    if (!shouldContinue) return;

    setIsContactBlockBusy(true);
    try {
      await unblockChatContact({
        id: info?.blockedId || undefined,
        channel: info?.channel,
        contactKey: info?.contactKey,
      });
      await refreshChatContacts();
      alert('Contacto desbloqueado.');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Falha ao desbloquear contacto.');
    } finally {
      setIsContactBlockBusy(false);
    }
  };

  const handleDeleteSelectedConversation = async () => {
    const conversation = selectedConversation;
    if (!conversation?.id || isDeletingConversation) return;

    const shouldContinue = window.confirm(
      'Queres eliminar esta conversa localmente? Isto remove mensagens e tarefas desta conversa.'
    );
    if (!shouldContinue) return;

    setIsDeletingConversation(true);
    try {
      await mockService.deleteConversation(conversation.id, {
        deleteMessages: true,
        actorUserId: CURRENT_USER_ID || null,
      });
      await refreshChatContacts();
      await loadData();
      setSelectedConvId(null);
      setSelectedCustomerIdOverride(null);
      setMessages([]);
      setTasks([]);
      alert('Conversa eliminada.');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Falha ao eliminar conversa.');
    } finally {
      setIsDeletingConversation(false);
    }
  };

  // --- Link Customer Handlers ---

  const openLinkModal = () => {
      setLinkTab('existing');
      setLinkSearchTerm('');
      setNewCustomerForm({ name: '', company: '', email: '', type: CustomerType.ENTERPRISE });
      setShowLinkModal(true);
  };

  const handleLinkToExisting = async (customerId: string) => {
      const activeConversationId = String(selectedConvId || '').trim();
      const targetCustomerId = String(customerId || '').trim();
      if (!activeConversationId || !targetCustomerId) return;
      try {
        const updated = await mockService.reassignConversation(activeConversationId, targetCustomerId);
        const refreshedConversations = await loadData();
        const targetConversation =
          refreshedConversations.find((conversation) => String(conversation.id || '').trim() === String(updated?.id || '').trim()) ||
          refreshedConversations.find((conversation) => String(conversation.customerId || '').trim() === targetCustomerId) ||
          null;
        if (targetConversation?.id) {
          setSelectedConvId(targetConversation.id);
        }
        setSelectedCustomerIdOverride(null);
        setShowLinkModal(false);
      } catch (error) {
        alert(error instanceof Error ? error.message : 'Falha ao associar cliente.');
      }
  };

  const handleSelectConversationCustomer = async (customerId: string) => {
    if (!selectedConvId) return;
    if ((selectedCustomerIdOverride || selectedConversation?.customerId) === customerId) return;

    setSelectedCustomerIdOverride(customerId);
    try {
      await loadCustomerDocuments(customerId, '');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Falha ao trocar ficha do cliente.');
    }
  };

  const handleSelectConversationWhatsAppAccount = async (accountId: string) => {
    const conversationId = String(selectedConvId || '').trim();
    const nextAccountId = String(accountId || '').trim();
    if (!conversationId || !nextAccountId || isUpdatingWhatsAppAccount) return;
    if (String(selectedConversationWhatsAppAccountId || '').trim() === nextAccountId) return;

    setIsUpdatingWhatsAppAccount(true);
    try {
      const updatedConversation = await mockService.setConversationWhatsAppAccount(conversationId, nextAccountId);
      if (updatedConversation?.id) {
        setConversations((previous) =>
          previous.map((conversation) => {
            if (conversation.id !== conversationId && conversation.id !== updatedConversation.id) return conversation;
            return {
              ...conversation,
              id: updatedConversation.id,
              whatsappAccountId: updatedConversation.whatsappAccountId || nextAccountId,
            };
          })
        );
        if (updatedConversation.id !== conversationId) {
          setSelectedConvId(updatedConversation.id);
        }
      }
      const activeConversationId = String(updatedConversation?.id || conversationId).trim();
      if (activeConversationId) {
        await loadMessages(activeConversationId);
      }
      await loadData();
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Falha ao trocar a linha WhatsApp desta conversa.');
    } finally {
      setIsUpdatingWhatsAppAccount(false);
    }
  };

  const handleCreateAndLink = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!selectedConvId || !selectedCustomer) return;
      try {
        const newCust = await mockService.createCustomer({
            name: newCustomerForm.name,
            company: newCustomerForm.company,
            email: newCustomerForm.email,
            phone: selectedCustomer.phone, // Use phone from current temp customer
            type: newCustomerForm.type,
            ownerId: CURRENT_USER_ID, // Auto-assign to me
            contacts: []
        });

        const updated = await mockService.reassignConversation(selectedConvId, newCust.id);
        const refreshedConversations = await loadData();
        const targetConversation =
          refreshedConversations.find((conversation) => String(conversation.id || '').trim() === String(updated?.id || '').trim()) ||
          refreshedConversations.find((conversation) => String(conversation.customerId || '').trim() === String(newCust.id || '').trim()) ||
          null;
        if (targetConversation?.id) {
          setSelectedConvId(targetConversation.id);
        }
        setSelectedCustomerIdOverride(null);
        setShowLinkModal(false);
      } catch (error) {
        alert(error instanceof Error ? error.message : 'Falha ao criar e associar cliente.');
      }
  };

  const openTasksForCustomer = useMemo(() => {
    const selectedId = String(selectedCustomer?.id || '').trim();
    if (!selectedId) return [] as Task[];

    const relatedCustomerIds = new Set<string>([selectedId]);
    relatedCustomersForSelectedNumber.forEach((customer) => {
      const id = String(customer.id || '').trim();
      if (id) relatedCustomerIds.add(id);
    });

    const relatedConversationIds = new Set<string>();
    conversations.forEach((conversation) => {
      if (relatedCustomerIds.has(String(conversation.customerId || '').trim())) {
        relatedConversationIds.add(String(conversation.id || '').trim());
      }
    });
    if (selectedConvId) relatedConversationIds.add(selectedConvId);

    const relevant = allTasks
      .filter((task) => relatedConversationIds.has(String(task.conversationId || '').trim()))
      .filter((task) => task.status !== TaskStatus.DONE)
      .sort((left, right) => {
        if (left.priority === TaskPriority.URGENT && right.priority !== TaskPriority.URGENT) return -1;
        if (left.priority !== TaskPriority.URGENT && right.priority === TaskPriority.URGENT) return 1;
        const leftDate = new Date(left.dueDate).getTime();
        const rightDate = new Date(right.dueDate).getTime();
        return leftDate - rightDate;
      });

    return relevant;
  }, [selectedCustomer?.id, relatedCustomersForSelectedNumber, conversations, selectedConvId, allTasks]);

  const conversationsWithMessages = useMemo(() => {
    const byConversationId = new Set<string>();
    const byCustomerId = new Set<string>();
    const byPhoneDigits = new Set<string>();

    chatContacts.forEach((contact) => {
      const conversationId = String(contact.conversation_id || '').trim();
      if (conversationId) byConversationId.add(conversationId);

      const customerId = String(contact.customer_id || '').trim();
      if (customerId) byCustomerId.add(customerId);

      const digits = normalizePhoneDigits(String(contact.from_number || ''));
      if (digits) byPhoneDigits.add(digits);
    });

    return { byConversationId, byCustomerId, byPhoneDigits };
  }, [chatContacts]);

  const conversationChannelById = useMemo(() => {
    const map: Record<string, 'whatsapp'> = {};
    conversations.forEach((conversation) => {
      const conversationId = String(conversation.id || '').trim();
      if (conversationId) map[conversationId] = 'whatsapp';
    });
    return map;
  }, [conversations]);

  const conversationDisplayNameById = useMemo(() => {
    const map: Record<string, string> = {};
    const scoreByConversation: Record<string, number> = {};

    chatContacts.forEach((row) => {
      const conversationId = String(row.conversation_id || '').trim();
      if (!conversationId) return;

      const label = String(resolveChatContactPrimaryLabel(row) || '').trim();
      if (!label) return;

      const contactName = String(row.customer_contact_name || '').trim();
      const customerName = String(row.customer_name || '').trim();
      const company = String(row.customer_company || '').trim();
      const score =
        (contactName && !looksLikePhoneLabel(contactName) ? 420 : 0) +
        (customerName && !looksLikePhoneLabel(customerName) && customerName.toLowerCase() !== company.toLowerCase() ? 260 : 0) +
        (customerName && !looksLikePhoneLabel(customerName) ? 140 : 0) +
        (company && !looksLikePhoneLabel(company) ? 80 : 0) +
        (String(row.from_number || '').trim() ? 20 : 0);

      if (!map[conversationId] || score > Number(scoreByConversation[conversationId] || 0)) {
        map[conversationId] = label;
        scoreByConversation[conversationId] = score;
      }
    });

    conversations.forEach((conversation) => {
      const conversationId = String(conversation.id || '').trim();
      if (!conversationId || map[conversationId]) return;
      const customer = customers.find((item) => item.id === conversation.customerId);
      const fallbackPhone = resolveConversationFallbackPhone(conversation);
      const label = String(resolveCustomerPrimaryLabel(customer, fallbackPhone) || '').trim();
      if (label) {
        map[conversationId] = label;
      }
    });

    return map;
  }, [chatContacts, conversations, customers]);

  const conversationContactNameById = useMemo(() => {
    const map: Record<string, string> = {};
    chatContacts.forEach((row) => {
      const conversationId = String(row.conversation_id || '').trim();
      if (!conversationId) return;

      const contactName = String(row.customer_contact_name || '').trim();
      const customerName = String(row.customer_name || '').trim();
      const company = String(row.customer_company || '').trim();

      if (contactName && !looksLikePhoneLabel(contactName)) {
        map[conversationId] = contactName;
        return;
      }
      if (
        customerName &&
        !looksLikePhoneLabel(customerName) &&
        (!company || customerName.toLowerCase() !== company.toLowerCase())
      ) {
        map[conversationId] = customerName;
      }
    });
    return map;
  }, [chatContacts]);

  const blockedConversationIds = useMemo(() => {
    const blockedRows = (Array.isArray(chatContacts) ? chatContacts : []).filter((row) => {
      const value = row?.is_blocked;
      return value === true || Number(value || 0) === 1;
    });
    if (!blockedRows.length) return new Set<string>();

    const blockedSignatures = blockedRows.map((row) => ({
      channel: 'whatsapp' as const,
      digits: normalizePhoneDigits(String(row.from_number || '')),
      conversationId: String(row.conversation_id || '').trim(),
    }));

    const blockedSet = new Set<string>();
    conversations.forEach((conversation) => {
      const conversationId = String(conversation.id || '').trim();
      if (!conversationId) return;
      const channel = 'whatsapp';
      const conversationDigits =
        extractPhoneDigitsFromConversationId(conversationId) ||
        normalizePhoneDigits(
          String(customers.find((customer) => customer.id === conversation.customerId)?.phone || '')
        );

      const isBlocked = blockedSignatures.some((entry) => {
        if (entry.conversationId && entry.conversationId === conversationId) return true;
        if (!entry.digits || !conversationDigits) return false;
        if (entry.channel !== channel) return false;
        return entry.digits === conversationDigits || entry.digits.endsWith(conversationDigits) || conversationDigits.endsWith(entry.digits);
      });

      if (isBlocked) blockedSet.add(conversationId);
    });

    return blockedSet;
  }, [chatContacts, conversations, conversationChannelById, customers]);

  const selectedConversationContactInfo = useMemo(() => {
    if (!selectedConversation) return null;

    const conversationId = String(selectedConversation.id || '').trim();
    const directContact = chatContacts.find((row) => {
      return String(row.conversation_id || '').trim() === conversationId;
    }) || null;

    const channel = 'whatsapp';
    const contactKey =
      normalizePhoneDigits(String(directContact?.from_number || '')) ||
      extractPhoneDigitsFromConversationId(conversationId) ||
      normalizePhoneDigits(String(selectedCustomer?.phone || ''));
    const blockedId = Number(directContact?.blocked_id || 0) || null;
    const blockedReason = String(directContact?.blocked_reason || '').trim() || null;
    const isBlocked =
      blockedConversationIds.has(conversationId) ||
      directContact?.is_blocked === true ||
      Number(directContact?.is_blocked || 0) === 1;

    return {
      channel,
      contactKey,
      blockedId,
      blockedReason,
      isBlocked,
    };
  }, [selectedConversation, chatContacts, conversationChannelById, selectedCustomer?.phone, blockedConversationIds]);

  const contactsRows = useMemo(() => {
    const blockedByDigits = new Map<string, { channel: 'whatsapp'; reason: string | null }>();
    chatContacts.forEach((contact) => {
      const isBlocked = contact?.is_blocked === true || Number(contact?.is_blocked || 0) === 1;
      if (!isBlocked) return;
      const digits = normalizePhoneDigits(String(contact.from_number || ''));
      if (!digits) return;
      const channel = 'whatsapp' as const;
      const reason = String(contact.blocked_reason || '').trim() || null;
      if (!blockedByDigits.has(digits)) {
        blockedByDigits.set(digits, { channel, reason });
      }
    });

    const rows = customers
      .map((customer) => {
        const customerId = String(customer.id || '').trim();
        const label = resolveCustomerPrimaryLabel(customer, customer.phone) || 'Sem nome';
        const rawPhone = String(customer.phone || '').trim();
        const hasPhone = Boolean(rawPhone);
        const ownerName = USERS.find((user) => user.id === customer.ownerId)?.name || '--';
        const normalizedPhone = normalizePhoneDigits(rawPhone);
        const blockedInfo = normalizedPhone ? blockedByDigits.get(normalizedPhone) : null;

        const companyRaw = String(customer.company || '').trim();
        const nameRaw = String(customer.name || '').trim();
        const contactNameRaw = String(customer.contactName || '').trim();
        const companyName = companyRaw || nameRaw || '--';
        const contactName = contactNameRaw || '';

        return {
          id: customerId,
          label,
          companyName,
          contactName,
          phone: rawPhone || '--',
          rawPhone,
          normalizedPhone,
          isBlocked: Boolean(blockedInfo),
          blockedChannel: blockedInfo?.channel || null,
          blockedReason: blockedInfo?.reason || null,
          ownerName,
          email: String(customer.email || '').trim(),
          nif: String(customer.nif || '').trim(),
        };
      })
      .filter((row) => row.rawPhone)
      .sort((left, right) => left.companyName.localeCompare(right.companyName, 'pt', { sensitivity: 'base' }));

    return rows;
  }, [customers, chatContacts]);

  const filteredContactsRows = useMemo(() => {
    const term = String(contactsSearchTerm || '').trim().toLowerCase();
    return contactsRows.filter((row) => {
      if (!term) return true;
      return (
        row.label.toLowerCase().includes(term) ||
        row.companyName.toLowerCase().includes(term) ||
        row.contactName.toLowerCase().includes(term) ||
        row.phone.toLowerCase().includes(term) ||
        row.rawPhone.toLowerCase().includes(term) ||
        row.ownerName.toLowerCase().includes(term) ||
        row.email.toLowerCase().includes(term) ||
        row.nif.toLowerCase().includes(term)
      );
    });
  }, [contactsRows, contactsSearchTerm]);

  const conversationHasRealMessages = (conversation: Conversation): boolean => {
    if (conversationsWithMessages.byConversationId.has(conversation.id)) return true;
    if (conversationsWithMessages.byCustomerId.has(conversation.customerId)) return true;

    const convDigits = extractPhoneDigitsFromConversationId(conversation.id);
    if (convDigits && conversationsWithMessages.byPhoneDigits.has(convDigits)) return true;

    return false;
  };

  const userOwnsConversation = (conversation: Conversation): boolean => {
    if (conversation.ownerId === CURRENT_USER_ID) return true;
    const currentUser = USERS.find((user) => user.id === CURRENT_USER_ID);
    if (!currentUser?.email) return false;
    const ownerUser = USERS.find((user) => user.id === conversation.ownerId);
    if (!ownerUser?.email) return false;
    return ownerUser.email.toLowerCase() === currentUser.email.toLowerCase();
  };

  // Filter Logic
  const filteredConversations = conversations.filter(c => {
    const conversationId = String(c.id || '').trim();
    if (blockedConversationIds.has(conversationId)) return false;
    if (activeTab === 'mine') return userOwnsConversation(c) && c.status !== ConversationStatus.CLOSED && conversationHasRealMessages(c);
    if (activeTab === 'triage') return c.ownerId === null && c.status !== ConversationStatus.CLOSED && conversationHasRealMessages(c);
    if (activeTab === 'waiting') return c.status !== ConversationStatus.CLOSED && conversationHasRealMessages(c);
    if (activeTab === 'closed') return c.status === ConversationStatus.CLOSED;
    return false;
  }).filter((conversation) => {
    const term = conversationSearch.trim().toLowerCase();
    if (!term) return true;
    const conversationId = String(conversation.id || '').trim();
    const customer = customers.find(item => item.id === conversation.customerId);
    const fallbackPhone = resolveConversationFallbackPhone(conversation);
    const preferredLabel = String(conversationDisplayNameById[conversationId] || '').trim().toLowerCase();
    return (
      preferredLabel.includes(term) ||
      (customer?.name || '').toLowerCase().includes(term) ||
      (customer?.company || '').toLowerCase().includes(term) ||
      (customer?.phone || '').toLowerCase().includes(term) ||
      (customer?.email || '').toLowerCase().includes(term) ||
      fallbackPhone.toLowerCase().includes(term)
    );
  }).sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());

  const loggedUser = USERS.find(u => u.id === CURRENT_USER_ID);
  const selectedConversationLabel = selectedConversation
    ? String(conversationDisplayNameById[String(selectedConversation.id || '').trim()] || '').trim() ||
      resolveConversationDisplayLabel(selectedConversation)
    : resolveConversationDisplayLabel(selectedConversation);
  const inboxUnreadTotal = filteredConversations.reduce((sum, conversation) => {
    return sum + Math.max(0, Number(conversation.unreadCount || 0));
  }, 0);
    
  const customerOwner = selectedCustomer 
    ? USERS.find(u => u.id === selectedCustomer.ownerId) 
    : null;
    
  // Check if customer is "unknown" (temp logic: if name equals phone or generic ID).
  // Phone stores chat_id in some legacy configurations.
  const isUnknownCustomer =
    !selectedCustomer ||
    (!false &&
      String(selectedCustomer.name || '').trim() === String(selectedCustomer.phone || '').trim());


  // Filter for Link Search
  const searchResults = customers.filter(c => 
      c.id !== selectedConversation?.customerId && // Exclude current
      (c.name.toLowerCase().includes(linkSearchTerm.toLowerCase()) || 
       c.company.toLowerCase().includes(linkSearchTerm.toLowerCase()) ||
       c.phone.includes(linkSearchTerm))
  );

  // Filter for New Chat Search
  const newChatResults = customers.filter(c =>
     c.name.toLowerCase().includes(newChatSearch.toLowerCase()) ||
     c.company.toLowerCase().includes(newChatSearch.toLowerCase()) ||
     c.phone.includes(newChatSearch)
  );

  const forwardTargets = conversations
    .filter((conversation) => conversation.id !== selectedConvId)
    .filter((conversation) => {
      const term = forwardSearch.trim().toLowerCase();
      if (!term) return true;
      const customer = customers.find((item) => item.id === conversation.customerId);
      return (
        (customer?.name || '').toLowerCase().includes(term) ||
        (customer?.company || '').toLowerCase().includes(term) ||
        (customer?.phone || '').toLowerCase().includes(term)
      );
    })
    .sort((left, right) => new Date(right.lastMessageAt).getTime() - new Date(left.lastMessageAt).getTime())
    .slice(0, 50);

  return (
    <div className="h-[calc(100vh-4rem)] w-full p-4 md:p-6 flex flex-col gap-4">
      {inboundToast && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            if (inboundToast.convId) {
              setSelectedConvId(inboundToast.convId);
            }
            setInboundToast(null);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (inboundToast.convId) setSelectedConvId(inboundToast.convId); setInboundToast(null); } }}
          className="fixed top-4 right-4 z-[9999] max-w-sm w-full animate-slide-in-right cursor-pointer rounded-xl border border-green-400/30 bg-gradient-to-r from-green-900/95 to-emerald-800/95 px-4 py-3 shadow-2xl backdrop-blur-sm transition-opacity hover:opacity-90"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-green-500/20 text-green-300">
              <MessageCircle size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-green-100 truncate">{inboundToast.from}</p>
              <p className="mt-0.5 text-xs text-green-200/80 line-clamp-2">{inboundToast.body}</p>
            </div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setInboundToast(null); }}
              className="ml-1 flex-shrink-0 text-green-300/60 hover:text-green-100"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 text-white shadow-sm md:p-5">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[320px_1fr_360px] md:items-center">
          <div>
            <h1 className="text-xl font-bold md:text-2xl">WhatsApp</h1>
            <p className="text-xs text-slate-200 md:text-sm">Comunicação WhatsApp com clientes.</p>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-slate-200">{loggedUser ? `Ligado como ${loggedUser.name}` : 'Sem utilizador ativo'}</p>
            <p className="truncate text-base font-semibold text-white md:text-lg">{selectedConversationLabel}</p>
          </div>
          <div className="flex items-center justify-between gap-3 md:justify-end">
            <button
              type="button"
              onClick={() => setShowContactsModal(true)}
              className="rounded-lg border border-white/30 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20"
              title="Ver lista de contactos"
            >
              Contactos
            </button>
            <span className="text-sm text-slate-100">Não lidas</span>
            <span className="inline-flex min-w-[28px] h-7 items-center justify-center rounded-full bg-white text-slate-900 text-sm font-bold px-2">
              {inboxUnreadTotal}
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
      <ConversationListPanel
        selectedConvId={selectedConvId}
        activeTab={activeTab}
        templateCount={templateCount}
        conversationSearch={conversationSearch}
        conversations={filteredConversations}
        conversationDisplayNameById={conversationDisplayNameById}
        conversationContactNameById={conversationContactNameById}
        conversationChannelById={conversationChannelById}
        blockedConversationIds={blockedConversationIds}
        customers={customers}
        users={USERS}
        currentUserId={CURRENT_USER_ID}
        onSelectConversation={handleSelectConversation}
        onOpenNewChat={() => setShowNewChatModal(true)}
        onConversationSearchChange={setConversationSearch}
        onTabChange={setActiveTab}
      />

      {/* Middle Column: Chat */}
      {selectedConvId ? (
        <div className="flex-1 min-w-0 flex flex-col bg-[#efeae2] relative">
          {relatedCustomersForSelectedNumber.length > 1 && (
            <div className="bg-white border-b border-gray-200 px-4 py-2">
              <div className="flex items-center gap-2 overflow-x-auto">
                <span className="text-[11px] font-semibold text-gray-500 whitespace-nowrap">
                  Fichas deste número:
                </span>
                {relatedCustomersForSelectedNumber.map((customer) => {
                  const isActive = (selectedCustomerIdOverride || selectedConversation?.customerId) === customer.id;
                  const customerLabel = resolveCustomerPrimaryLabel(customer, customer.phone) || customer.name || 'Sem nome';
                  return (
                    <button
                      key={customer.id}
                      onClick={() => { void handleSelectConversationCustomer(customer.id); }}
                      className={`px-2.5 py-1 rounded-full border text-xs whitespace-nowrap transition-colors ${
                        isActive
                          ? 'bg-whatsapp-100 border-whatsapp-300 text-whatsapp-800'
                          : 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100'
                      }`}
                      title={customerLabel}
                    >
                      {customerLabel}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <MessageThread
            messages={messages}
            loggedUser={loggedUser}
            messagesEndRef={messagesEndRef}
            onCreateTaskFromMessage={handleCreateTaskFromMessage}
            onReplyMessage={handleReplyMessage}
            onForwardMessage={handleForwardMessage}
            onEditMessage={handleEditMessage}
            onDeleteMessage={handleDeleteMessage}
            onDropLocalFiles={handleDropLocalFilesToConversation}
            onDropCustomerDocument={handleDropCustomerDocumentToConversation}
            selectedMessageIds={selectedMessageIds}
            starredMessageIds={currentMessageUiMeta.starredIds}
            pinnedMessageId={currentMessageUiMeta.pinnedId}
            onToggleSelectMessage={handleToggleSelectMessage}
            onToggleStarMessage={handleToggleStarMessage}
            onTogglePinMessage={handleTogglePinMessage}
            onShowMessageDetails={handleShowMessageDetails}
          />
          
          {/* Unknown Number Warning */}
          {isUnknownCustomer && (
              <div className="bg-red-50 p-2 text-center text-xs text-red-700 border-t border-red-100 flex items-center justify-center gap-2">
                  <UserX size={14} />
                  <span><strong>Número desconhecido.</strong> Salve o contacto para ativar automações e enviar templates.</span>
                  <button onClick={openLinkModal} className="underline font-bold">Salvar agora</button>
              </div>
          )}

          {/* Input Area */}
          <div className={`p-3 border-t ${!isWithin24hWindow && selectedConversation?.status !== ConversationStatus.CLOSED ? 'bg-gray-100 border-gray-200' : 'bg-white border-gray-200'}`}>
            
            {/* 24h Window Closed Banner */}
            {!isWithin24hWindow && selectedConversation?.status !== ConversationStatus.CLOSED && (
                <div className="flex items-center gap-2 text-xs text-amber-700 mb-2 px-1 justify-center">
                    <Lock size={12} />
                    <span className="font-bold">Janela de 24h fechada.</span>
                    <span>Texto livre bloqueado. Envie um Template para reabrir.</span>
                </div>
            )}
            
            {selectedConversation?.status === ConversationStatus.CLOSED ? (
                <div className="text-center text-sm text-gray-500 py-2">
                   Esta conversa está fechada. <button onClick={() => handleStatusChange(ConversationStatus.OPEN)} className="text-whatsapp-600 underline">Reabrir</button> para enviar mensagens.
                </div>
            ) : (
                <>
                {(replyingTo || editingMessage) && (
                  <div className={`rounded-lg border px-3 py-2 text-xs flex items-start justify-between gap-3 mb-2 ${editingMessage ? 'bg-amber-50 border-amber-200 text-amber-900' : 'bg-whatsapp-50 border-whatsapp-200 text-whatsapp-900'}`}>
                    <div className="min-w-0">
                      <p className="font-semibold mb-0.5">
                        {editingMessage ? 'A editar mensagem' : 'A responder a mensagem'}
                      </p>
                      <p className="truncate">
                        {String((editingMessage || replyingTo)?.body || '')}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setReplyingTo(null);
                        setEditingMessage(null);
                        setNewMessage('');
                      }}
                      className="p-1 hover:bg-white/70 rounded"
                      title="Cancelar"
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                <form onSubmit={handleSendClick} className="flex gap-2 items-end">
                   <button
                      type="button"
                      onClick={triggerDocumentPicker}
                      disabled={isUploadingDocument || !selectedCustomer?.id}
                      className="p-2 text-gray-400 hover:text-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Guardar ficheiro na pasta do cliente"
                    >
                      <Paperclip size={20} />
                   </button>
                   <button
                      type="button"
                      onClick={triggerImagePicker}
                      disabled={isSendingImage || !selectedCustomer?.id || !isWithin24hWindow}
                      className="p-2 text-gray-400 hover:text-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Enviar imagem"
                    >
                      <ImagePlus size={20} />
                   </button>
                   <div className="flex-1 bg-white rounded-lg p-2 border border-gray-200">
                      <textarea
                        ref={messageComposerRef}
                        rows={1}
                        disabled={!isWithin24hWindow && !editingMessage}
                        placeholder={
                          !isWithin24hWindow && !editingMessage
                            ? "Janela fechada. Use um Template."
                            : (editingMessage ? "Edite a mensagem..." : "Escreva uma mensagem... (Ctrl+V para colar imagem)")
                        }
                        className={`w-full bg-transparent border-none focus:outline-none resize-none text-sm max-h-32 ${!isWithin24hWindow && !editingMessage ? 'cursor-not-allowed text-gray-400' : ''}`}
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        onPaste={(event) => void handlePasteOnChatComposer(event)}
                        onKeyDown={(e) => {
                           if (e.key === 'Enter' && !e.shiftKey) {
                             e.preventDefault();
                             if ((isWithin24hWindow || editingMessage) && newMessage.trim()) {
                               void handleSendClick(e as unknown as React.FormEvent);
                             }
                           }
                        }}
                      />
                   </div>
                   
                   {!isWithin24hWindow && !editingMessage ? (
                       <button 
                        type="button"
                        onClick={() => {
                            if (isUnknownCustomer) {
                                alert("Salve o cliente antes de enviar um template.");
                                return;
                            }
                            if (managedTemplates.length === 0) {
                                alert("Sem templates ativos. Crie um em Automação.");
                                return;
                            }
                            setShowTemplatePicker(true);
                        }}
                        className="px-4 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 text-xs font-bold shadow-sm whitespace-nowrap"
                       >
                           Escolher Template ($)
                       </button>
                   ) : (
                       <button 
                        type="submit" 
                        disabled={!newMessage.trim()}
                        className={`p-2 text-white rounded-full disabled:opacity-50 disabled:cursor-not-allowed ${editingMessage ? 'bg-amber-500 hover:bg-amber-600' : 'bg-whatsapp-600 hover:bg-whatsapp-700'}`}
                       >
                          <Send size={20} />
                       </button>
                   )}
                </form>
                </>
            )}
            <input
              ref={documentInputRef}
              type="file"
              onChange={handleDocumentUpload}
              className="hidden"
            />
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageUploadForChat}
              className="hidden"
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 hidden md:flex items-center justify-center bg-gray-50 flex-col gap-4 text-gray-400">
          <MessageCircle size={64} className="opacity-20" />
          <p>Selecione uma conversa para começar</p>
        </div>
      )}

      {selectedConvId &&
        (isCustomerProfileOpen && selectedCustomer ? (
          <InboxCustomerProfilePanel
            customer={selectedCustomer}
            customerOwner={customerOwner}
            customers={customers}
            onClose={() => setIsCustomerProfileOpen(false)}
            onOpenFullProfile={openCustomerProfileInCustomersPage}
          />
        ) : (
          <ConversationDetailsSidebar
            selectedCustomer={selectedCustomer}
            conversationDisplayName={selectedConversationLabel}
            customerOwner={customerOwner}
            isUnknownCustomer={isUnknownCustomer}
            conversationChannel={selectedConversationContactInfo?.channel || 'whatsapp'}
            isContactBlocked={selectedConversationContactInfo?.isBlocked === true}
            blockedReason={selectedConversationContactInfo?.blockedReason || null}
            customerDocuments={customerDocuments}
            customerDocumentsPath={customerDocumentsPath}
            customerDocumentsCurrentPath={customerDocumentsCurrentPath}
            canGoUpDocumentsPath={canGoUpDocumentsPath}
            customerDocsConfigured={customerDocsConfigured}
            isDocumentsLoading={isDocumentsLoading}
            isUploadingDocument={isUploadingDocument}
            docsError={docsError}
            saftLoadingType={saftLoadingType}
            saftFeedback={saftFeedback}
            saftJobByType={saftJobByType}
            onOpenLinkModal={openLinkModal}
            onOpenCustomerProfile={handleOpenCustomerProfile}
            whatsAppAccounts={whatsAppAccounts}
            selectedWhatsAppAccountId={selectedConversationWhatsAppAccountId}
            onSelectWhatsAppAccount={(accountId) => {
              void handleSelectConversationWhatsAppAccount(accountId);
            }}
            isUpdatingWhatsAppAccount={isUpdatingWhatsAppAccount}
            onTriggerFinancasAutologin={() => {
              void handleTriggerFinancasAutologin();
            }}
            onTriggerSegSocialAutologin={() => {
              void handleTriggerSegSocialAutologin();
            }}
            isFinancasAutologinBusy={
              Boolean(selectedCustomer?.id) && financasAutologinBusyCustomerId === String(selectedCustomer?.id || '')
            }
            isSegSocialAutologinBusy={
              Boolean(selectedCustomer?.id) && segSocialAutologinBusyCustomerId === String(selectedCustomer?.id || '')
            }
            onSaveCustomerNotes={handleSaveCustomerNotes}
            onOpenCallModal={() => setShowCallModal(true)}
            onBlockContact={() => {
              void handleBlockSelectedContact();
            }}
            onUnblockContact={() => {
              void handleUnblockSelectedContact();
            }}
            isContactBlockBusy={isContactBlockBusy}
            onDeleteConversation={() => {
              void handleDeleteSelectedConversation();
            }}
            isDeletingConversation={isDeletingConversation}
            onRefreshDocuments={() => selectedCustomer?.id && loadCustomerDocuments(selectedCustomer.id, customerDocumentsCurrentPath)}
            onOpenDocumentsFolder={openDocumentsFolder}
            onGoUpDocumentsFolder={goUpDocumentsFolder}
            onUploadFileToCurrentFolder={(file) => {
              void uploadDocumentForSelectedCustomer(file, customerDocumentsCurrentPath);
            }}
            onDropMessageToCurrentFolder={(messageBody) => {
              void handleDropMessageToCurrentFolder(messageBody);
            }}
            onChooseCustomerFolder={chooseCustomerFolder}
            onTriggerDocumentPicker={triggerDocumentPicker}
            onDownloadDocument={handleDocumentDownload}
            onSaftRequest={handleSaftRequest}
            onSyncCompanyDocs={handleSyncCompanyDocs}
            formatBytes={formatBytes}
            users={USERS}
            tasks={openTasksForCustomer}
            showTaskForm={showTaskForm}
            newTaskTitle={newTaskTitle}
            newTaskAssignee={newTaskAssignee}
            newTaskPriority={newTaskPriority}
            newTaskAttachments={newTaskAttachments}
            duplicateWarning={duplicateWarning}
            onToggleTaskForm={handleToggleTaskForm}
            onCreateTask={handleCreateTask}
            onCancelTaskForm={handleCancelTaskForm}
            onTaskTitleChange={setNewTaskTitle}
            onTaskAssigneeChange={setNewTaskAssignee}
            onTaskPriorityChange={setNewTaskPriority}
            onTaskAttachmentsSelected={(files) => {
              void handleTaskAttachmentsSelected(files);
            }}
            onRemoveTaskAttachment={handleRemoveTaskAttachment}
            onToggleTaskStatus={handleToggleTaskStatus}
            openOccurrences={openOccurrences}
            openOccurrencesLoading={openOccurrencesLoading}
            openOccurrencesError={openOccurrencesError}
          />
        ))}
      </div>

      {detailsMessage && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-xl shadow-xl border border-gray-200">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">Detalhes da mensagem</h3>
              <button
                onClick={() => setDetailsMessage(null)}
                className="p-1 rounded hover:bg-gray-100 text-gray-500"
                title="Fechar"
              >
                <X size={16} />
              </button>
            </div>
            <div className="px-4 py-3 text-xs text-gray-700 space-y-2">
              <div><span className="font-semibold">ID:</span> {detailsMessage.id}</div>
              <div><span className="font-semibold">Direção:</span> {detailsMessage.direction === 'out' ? 'Enviada' : 'Recebida'}</div>
              <div><span className="font-semibold">Tipo:</span> {detailsMessage.type}</div>
              <div><span className="font-semibold">Estado:</span> {detailsMessage.status}</div>
              <div><span className="font-semibold">Data/Hora:</span> {new Date(detailsMessage.timestamp).toLocaleString('pt-PT')}</div>
              <div><span className="font-semibold">Estrela:</span> {currentMessageUiMeta.starredIds.includes(detailsMessage.id) ? 'Sim' : 'Não'}</div>
              <div><span className="font-semibold">Afixada:</span> {currentMessageUiMeta.pinnedId === detailsMessage.id ? 'Sim' : 'Não'}</div>
              <div className="pt-2 border-t border-gray-100">
                <p className="font-semibold mb-1">Conteúdo</p>
                <p className="whitespace-pre-wrap break-words bg-gray-50 p-2 rounded border border-gray-100">
                  {detailsMessage.body}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      <CallLogModal
        show={showCallModal}
        callDuration={callDuration}
        callNotes={callNotes}
        onDurationChange={setCallDuration}
        onNotesChange={setCallNotes}
        onClose={() => setShowCallModal(false)}
        onSave={handleLogCall}
      />

      <TemplatePickerModal
        show={showTemplatePicker}
        selectedTemplateId={selectedTemplateId}
        templates={managedTemplates}
        onTemplateChange={setSelectedTemplateId}
        onCancel={() => setShowTemplatePicker(false)}
        onContinue={() => {
          const selectedTemplate = managedTemplates.find((item) => item.id === selectedTemplateId);
          setNewMessage(selectedTemplate?.content || '');
          setShowTemplatePicker(false);
          setShowTemplateConfirm(true);
        }}
      />

      <TemplateConfirmModal
        show={showTemplateConfirm}
        selectedTemplateId={selectedTemplateId}
        templates={managedTemplates}
        onCancel={() => setShowTemplateConfirm(false)}
        onConfirm={() => performSendMessage('template', selectedTemplateId || undefined)}
      />

      <NewChatModal
        show={showNewChatModal}
        search={newChatSearch}
        results={newChatResults}
        onSearchChange={setNewChatSearch}
        onStart={handleStartNewChat}
        onClose={() => setShowNewChatModal(false)}
      />

      <LinkCustomerModal
        show={showLinkModal}
        linkTab={linkTab}
        linkSearchTerm={linkSearchTerm}
        searchResults={searchResults}
        newCustomerForm={newCustomerForm}
        selectedCustomerPhone={selectedCustomer?.phone}
        onClose={() => setShowLinkModal(false)}
        onTabChange={setLinkTab}
        onSearchTermChange={setLinkSearchTerm}
        onLinkToExisting={handleLinkToExisting}
        onCreateAndLink={handleCreateAndLink}
        onNewCustomerFieldChange={(field, value) => {
          setNewCustomerForm((previous) => ({
            ...previous,
            [field]: field === 'type' ? (value as CustomerType) : value,
          }));
        }}
      />

      {showForwardModal && forwardingMessage && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white rounded-lg shadow-xl border border-gray-200 max-h-[80vh] overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">Reencaminhar mensagem</h3>
              <button
                onClick={() => {
                  setShowForwardModal(false);
                  setForwardingMessage(null);
                }}
                className="p-1 rounded hover:bg-gray-100"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 border-b border-gray-100">
              <p className="text-xs text-gray-500 mb-2">Mensagem:</p>
              <p className="text-sm bg-gray-50 border border-gray-200 rounded p-2 break-words whitespace-pre-wrap">
                {forwardingMessage.body}
              </p>
              <input
                type="text"
                placeholder="Pesquisar conversa..."
                value={forwardSearch}
                onChange={(event) => setForwardSearch(event.target.value)}
                className="w-full mt-3 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
              />
            </div>
            <div className="max-h-[45vh] overflow-y-auto">
              {forwardTargets.map((conversation) => {
                const customer = customers.find((item) => item.id === conversation.customerId);
                const fallbackPhone = resolveConversationFallbackPhone(conversation);
                const primaryLabel = resolveCustomerPrimaryLabel(customer, fallbackPhone);
                return (
                  <button
                    key={conversation.id}
                    onClick={() => { void handleConfirmForward(conversation.id); }}
                    className="w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50"
                  >
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {primaryLabel || 'Sem nome'}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      {customer?.phone || customer?.company || fallbackPhone || 'Sem dados'}
                    </p>
                  </button>
                );
              })}
              {forwardTargets.length === 0 && (
                <p className="text-xs text-gray-500 px-4 py-6 text-center">
                  Nenhuma conversa encontrada.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {showContactsModal && (
        <div className="fixed inset-0 z-50 bg-black/35 flex items-center justify-center p-4">
          <div className="w-full max-w-5xl max-h-[85vh] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl">
            <div className="border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-gray-900">Contactos</h3>
                <p className="text-xs text-gray-500">
                  Lista de clientes com contacto WhatsApp.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowContactsModal(false)}
                  className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
                >
                  Fechar
                </button>
              </div>
            </div>

            <div className="border-b border-gray-100 px-4 py-3 flex flex-col md:flex-row md:items-center gap-2">
              <input
                type="text"
                value={contactsSearchTerm}
                onChange={(event) => setContactsSearchTerm(event.target.value)}
                placeholder="Pesquisar por nome, telefone, NIF ou responsável..."
                className="w-full md:flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-500"
              />
            </div>

            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full min-w-[860px]">
                <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                  <tr className="text-left">
                    <th className="px-4 py-2 text-[11px] uppercase tracking-wide text-gray-500">Empresa</th>
                    <th className="px-4 py-2 text-[11px] uppercase tracking-wide text-gray-500">Nome Contacto</th>
                    <th className="px-4 py-2 text-[11px] uppercase tracking-wide text-gray-500">Telefone</th>
                    <th className="px-4 py-2 text-[11px] uppercase tracking-wide text-gray-500">Bloqueado</th>
                    <th className="px-4 py-2 text-[11px] uppercase tracking-wide text-gray-500">Resp. interno</th>
                    <th className="px-4 py-2 text-[11px] uppercase tracking-wide text-gray-500 text-right">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredContactsRows.map((row) => (
                    <tr key={row.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-2 text-sm text-gray-900">{row.companyName}</td>
                      <td className="px-4 py-2 text-sm text-gray-700">
                        {editingContactNameId === row.id ? (
                          <form
                            className="flex items-center gap-1"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void handleSaveContactName(row.id, editingContactNameValue);
                            }}
                          >
                            <input
                              type="text"
                              autoFocus
                              value={editingContactNameValue}
                              onChange={(e) => setEditingContactNameValue(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Escape') setEditingContactNameId(null); }}
                              className="w-full rounded border border-gray-300 px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-whatsapp-500"
                              disabled={savingContactNameId === row.id}
                            />
                            <button
                              type="submit"
                              disabled={savingContactNameId === row.id}
                              className="rounded border border-whatsapp-200 bg-whatsapp-50 px-2 py-0.5 text-xs font-semibold text-whatsapp-700 hover:bg-whatsapp-100 disabled:opacity-50"
                            >
                              {savingContactNameId === row.id ? '...' : '✓'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingContactNameId(null)}
                              className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-100"
                            >
                              ✕
                            </button>
                          </form>
                        ) : (
                          <span
                            className="cursor-pointer hover:text-whatsapp-700 hover:underline"
                            title="Clique para editar"
                            onClick={() => {
                              setEditingContactNameId(row.id);
                              setEditingContactNameValue(row.contactName);
                            }}
                          >
                            {row.contactName || <span className="text-gray-400 italic">--</span>}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-sm font-mono text-gray-700">{row.phone}</td>
                      <td className="px-4 py-2 text-xs">
                        {row.isBlocked ? (
                          <span
                            className="inline-flex rounded-full border border-red-200 bg-red-50 px-2 py-0.5 font-semibold text-red-700"
                            title={row.blockedReason || 'Contacto bloqueado'}
                          >
                            WhatsApp
                          </span>
                        ) : (
                          <span className="inline-flex rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 font-semibold text-gray-600">
                            Não
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-sm text-gray-700">{row.ownerName}</td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => { void handleStartChatFromContacts(row.id); }}
                          disabled={Boolean(startingContactId)}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                            startingContactId === row.id
                              ? 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-400'
                              : 'border-whatsapp-200 bg-whatsapp-50 text-whatsapp-700 hover:bg-whatsapp-100'
                          }`}
                        >
                          {startingContactId === row.id ? 'A iniciar...' : 'Iniciar conversa'}
                        </button>
                      </td>
                    </tr>
                  ))}
                  {filteredContactsRows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-500">
                        Nenhum contacto encontrado para este filtro.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

const HOUSEHOLD_RELATION_LABELS: Record<string, string> = {
  conjuge: 'Cônjuge',
  esposa: 'Cônjuge',
  marido: 'Cônjuge',
  filho: 'Filho',
  pai: 'Pai',
  outro: 'Outro',
};

const RELATED_RECORD_LABELS: Record<string, string> = {
  funcionario: 'Funcionário',
  amigo: 'Amigo',
  familiar: 'Familiar',
  gerente: 'Gerente',
  socio: 'Sócio',
  outro: 'Outro',
};

const maskSecret = (value?: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  return '•'.repeat(Math.max(6, Math.min(16, raw.length)));
};

const resolveRelatedCustomerName = (customerId: string, customers: Customer[]) => {
  const id = String(customerId || '').trim();
  if (!id) return 'Ficha desconhecida';
  const customer = customers.find((item) => String(item.id || '').trim() === id);
  if (!customer) return id;
  const company = String(customer.company || '').trim();
  const name = String(customer.name || '').trim();
  const contactName = String(customer.contactName || '').trim();
  const label =
    (contactName && company && contactName.toLowerCase() !== company.toLowerCase() && `${contactName} - ${company}`) ||
    (name && company && name.toLowerCase() !== company.toLowerCase() && `${name} - ${company}`) ||
    contactName ||
    name ||
    company;
  if (!label) return id;
  const nif = String(customer.nif || '').trim();
  return nif ? `${label} (${nif})` : label;
};



type InboxCustomerProfilePanelProps = {
  customer: Customer;
  customerOwner: UserType | null;
  customers: Customer[];
  onClose: () => void;
  onOpenFullProfile: () => void;
};

const InboxCustomerProfilePanel: React.FC<InboxCustomerProfilePanelProps> = ({
  customer,
  customerOwner,
  customers,
  onClose,
  onOpenFullProfile,
}) => (
  <aside className="hidden lg:flex w-[34rem] min-w-[34rem] flex-col border-l border-gray-200 bg-white">
    <div className="border-b border-gray-100 bg-gray-50 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-gray-900">{customer.contactName || customer.name || customer.company || 'Cliente'}</h3>
          <p className="truncate text-xs text-gray-500">{customer.company || 'Sem empresa'}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenFullProfile}
            className="rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-100"
          >
            Ficha completa
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>

    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs">
        <ProfileField
          label={'Telefone'}
          value={customer.phone}
        />
        <ProfileField label="Email" value={customer.email} />
        <ProfileField label="NIF" value={customer.nif} />
        <ProfileField label="NISS" value={customer.niss} />
        <ProfileField label="Tipo" value={customer.type} />
        <ProfileField label="Responsável" value={customerOwner?.name || '—'} />
        <ProfileField className="col-span-2" label="Morada" value={customer.morada} />
      </div>

      <div className="mt-3 rounded-lg border border-gray-200 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Dados Corporativos</h4>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
          <ProfileField label="Estado" value={customer.estadoCliente} />
          <ProfileField label="Tipo IVA" value={customer.tipoIva} />
          <ProfileField label="CAE Principal" value={customer.caePrincipal} />
          <ProfileField label="Contabilidade" value={customer.tipoContabilidade} />
          <ProfileField label="RCBE nº" value={customer.rcbeNumero} />
          <ProfileField label="RCBE data" value={customer.rcbeData} />
          <ProfileField label="Certidão nº" value={customer.certidaoPermanenteNumero} />
          <ProfileField label="Certidão validade" value={customer.certidaoPermanenteValidade} />
          <ProfileField className="col-span-2" label="Pasta de documentos" value={customer.documentsFolder} />
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-gray-200 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Notas</h4>
        <p className="mt-2 whitespace-pre-wrap break-words rounded border border-gray-100 bg-gray-50 p-2 text-xs text-gray-700">
          {String(customer.notes || '').trim() || 'Sem notas.'}
        </p>
      </div>

      <div className="mt-3 rounded-lg border border-gray-200 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Gerência / Administração</h4>
        <div className="mt-2 space-y-2">
          {(customer.managers || []).length > 0 ? (
            (customer.managers || []).map((manager, idx) => (
              <div key={`${manager.name || 'm'}_${idx}`} className="rounded border border-gray-100 bg-gray-50 px-2 py-1.5 text-xs">
                <p className="font-semibold text-gray-800">{manager.name || 'Sem nome'}</p>
                <p className="text-gray-600">{manager.email || 'Sem email'}</p>
                <p className="text-gray-600">{manager.phone || 'Sem telefone'}</p>
              </div>
            ))
          ) : (
            <p className="text-xs text-gray-500">Sem gerentes definidos.</p>
          )}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-gray-200 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Contactos</h4>
        <div className="mt-2 space-y-2">
          {(customer.contacts || []).length > 0 ? (
            (customer.contacts || []).map((contact, idx) => (
              <div key={`${contact.name || 'c'}_${idx}`} className="rounded border border-gray-100 bg-gray-50 px-2 py-1.5 text-xs">
                <p className="font-semibold text-gray-800">{contact.name || 'Sem nome'}</p>
                <p className="text-gray-600">{contact.phone || 'Sem telefone'}</p>
              </div>
            ))
          ) : (
            <p className="text-xs text-gray-500">Sem contactos adicionais.</p>
          )}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-gray-200 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Dados de Acesso</h4>
        <div className="mt-2 space-y-2">
          {(customer.accessCredentials || []).length > 0 ? (
            (customer.accessCredentials || []).map((credential, idx) => (
              <div key={`${credential.service || 'a'}_${idx}`} className="rounded border border-gray-100 bg-gray-50 px-2 py-1.5 text-xs">
                <p className="font-semibold text-gray-800">{credential.service || 'Serviço'}</p>
                <p className="text-gray-600">Utilizador: {credential.username || '—'}</p>
                <p className="text-gray-600">Senha: {maskSecret(credential.password)}</p>
              </div>
            ))
          ) : (
            <p className="text-xs text-gray-500">Sem credenciais definidas.</p>
          )}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-gray-200 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Agregado Familiar</h4>
        <div className="mt-2 space-y-2">
          {(customer.agregadoFamiliar || []).length > 0 ? (
            (customer.agregadoFamiliar || []).map((relation, idx) => (
              <div key={`${relation.relatedCustomerId || 'h'}_${idx}`} className="rounded border border-gray-100 bg-gray-50 px-2 py-1.5 text-xs">
                <p className="font-semibold text-gray-800">
                  {resolveRelatedCustomerName(relation.relatedCustomerId, customers)}
                </p>
                <p className="text-gray-600">
                  Relação: {HOUSEHOLD_RELATION_LABELS[String(relation.relationType || '').trim().toLowerCase()] || 'Outro'}
                </p>
                {relation.note ? <p className="text-gray-600">{relation.note}</p> : null}
              </div>
            ))
          ) : (
            <p className="text-xs text-gray-500">Sem relações de agregado definidas.</p>
          )}
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-gray-200 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-600">Fichas Relacionadas</h4>
        <div className="mt-2 space-y-2">
          {(customer.fichasRelacionadas || []).length > 0 ? (
            (customer.fichasRelacionadas || []).map((relation, idx) => (
              <div key={`${relation.relatedCustomerId || 'r'}_${idx}`} className="rounded border border-gray-100 bg-gray-50 px-2 py-1.5 text-xs">
                <p className="font-semibold text-gray-800">
                  {resolveRelatedCustomerName(relation.relatedCustomerId, customers)}
                </p>
                <p className="text-gray-600">
                  Relação: {RELATED_RECORD_LABELS[String(relation.relationType || '').trim().toLowerCase()] || 'Outro'}
                </p>
                {relation.note ? <p className="text-gray-600">{relation.note}</p> : null}
              </div>
            ))
          ) : (
            <p className="text-xs text-gray-500">Sem fichas relacionadas definidas.</p>
          )}
        </div>
      </div>
    </div>
  </aside>
);

const ProfileField: React.FC<{ label: string; value?: string | null; className?: string }> = ({ label, value, className = '' }) => (
  <div className={className}>
    <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
    <p className="truncate text-xs text-gray-800">{String(value || '').trim() || '—'}</p>
  </div>
);

export default Inbox;
