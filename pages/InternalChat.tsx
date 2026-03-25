import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check,
  Copy,
  FileText,
  Forward,
  Info,
  MessageSquarePlus,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  ExternalLink,
  Reply,
  Search,
  Send,
  Smile,
  Star,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { CURRENT_USER_ID, mockService } from '../services/mockData';
import { User } from '../types';
import {
  InternalConversationMember,
  InternalConversationRow,
  InternalMessageRow,
  InternalPresenceRow,
  InternalPontoRow,
  InternalUserTaskRow,
  createInternalPontoSupabase,
  fetchInternalPontoRecentSupabase,
  addInternalConversationMembers,
  createInternalPedidoSupabase,
  createInternalGroupConversation,
  deleteInternalConversation,
  deleteInternalMessage,
  editInternalMessage,
  ensureDirectInternalConversation,
  fetchInternalConversationMembers,
  fetchInternalConversations,
  fetchInternalPresence,
  fetchInternalUserOpenTasks,
  fetchInternalMessages,
  markInternalConversationAsRead,
  sendInternalMessage,
  toggleInternalMessageReaction,
  importInternalChatHistorySupabase,
  uploadInternalFileMessage,
} from '../services/internalChatApi';

type MessageContextMenuState = {
  x: number;
  y: number;
  message: InternalMessageRow;
} | null;

const PEDIDO_TIPOS = [
  'Ferias',
  'Ferias da Empresa',
  'Medico / Saude',
  'Folga / Horario Especial',
  'Aumento Salarial',
  'Premio',
  'Outro',
];
const QUICK_CHAT_EMOJIS = ['😀', '😂', '🙂', '😉', '😍', '🙏', '👍', '✅', '📌', '🎉', '🔥', '❤️'];
const QUICK_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '🙏', '🔥', '🎉', '✅', '👏', '👀'];
const INTERNAL_CHAT_HIDDEN_CONVERSATIONS_KEY = 'wa_pro_internal_chat_hidden_conversations_v1';
const INTERNAL_CHAT_SELECTED_CONV_KEY = 'wa_pro_internal_chat_selected_conv';

function loadHiddenConversationIdsForUser(userId: string): string[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return [];
  try {
    const raw = window.localStorage.getItem(INTERNAL_CHAT_HIDDEN_CONVERSATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const list = Array.isArray(parsed?.[normalizedUserId]) ? (parsed[normalizedUserId] as unknown[]) : [];
    return Array.from(new Set(list.map((item) => String(item || '').trim()).filter(Boolean)));
  } catch {
    return [];
  }
}

function saveHiddenConversationIdsForUser(userId: string, ids: string[]) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return;

  const normalizedIds = Array.from(new Set((Array.isArray(ids) ? ids : []).map((item) => String(item || '').trim()).filter(Boolean)));
  try {
    const raw = window.localStorage.getItem(INTERNAL_CHAT_HIDDEN_CONVERSATIONS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (normalizedIds.length > 0) {
      parsed[normalizedUserId] = normalizedIds;
    } else {
      delete parsed[normalizedUserId];
    }
    window.localStorage.setItem(INTERNAL_CHAT_HIDDEN_CONVERSATIONS_KEY, JSON.stringify(parsed));
  } catch {
    // sem bloqueio
  }
}

const InternalChat: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [conversations, setConversations] = useState<InternalConversationRow[]>([]);
  const [selectedConversationId, setSelectedConversationIdRaw] = useState<string>(() => {
    if (typeof window === 'undefined' || !window.localStorage) return '';
    return window.localStorage.getItem(INTERNAL_CHAT_SELECTED_CONV_KEY) || '';
  });
  const setSelectedConversationId = (id: string) => {
    setSelectedConversationIdRaw(id);
    try {
      if (id) window.localStorage.setItem(INTERNAL_CHAT_SELECTED_CONV_KEY, id);
      else window.localStorage.removeItem(INTERNAL_CHAT_SELECTED_CONV_KEY);
    } catch { /* sem bloqueio */ }
  };
  const [messages, setMessages] = useState<InternalMessageRow[]>([]);
  const [members, setMembers] = useState<InternalConversationMember[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isDeletingConversation, setIsDeletingConversation] = useState(false);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([]);
  const [isSubmittingGroup, setIsSubmittingGroup] = useState(false);
  const [isAddingMember, setIsAddingMember] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [replyToMessageId, setReplyToMessageId] = useState<number | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [forwardMessage, setForwardMessage] = useState<InternalMessageRow | null>(null);
  const [showForwardModal, setShowForwardModal] = useState(false);
  const [contextMenu, setContextMenu] = useState<MessageContextMenuState>(null);
  const [selectedByConversation, setSelectedByConversation] = useState<Record<string, number[]>>({});
  const [starredByConversation, setStarredByConversation] = useState<Record<string, number[]>>({});
  const [pinnedByConversation, setPinnedByConversation] = useState<Record<string, number | null>>({});
  const [error, setError] = useState<string>('');
  const [employeeTasks, setEmployeeTasks] = useState<InternalUserTaskRow[]>([]);
  const [employeeTasksLoading, setEmployeeTasksLoading] = useState(false);
  const [employeeTasksError, setEmployeeTasksError] = useState('');
  const [showPedidoModal, setShowPedidoModal] = useState(false);
  const [pedidoSubmitting, setPedidoSubmitting] = useState(false);
  const [pedidoError, setPedidoError] = useState('');
  const [pedidoFeedback, setPedidoFeedback] = useState('');
  const [pontoPin, setPontoPin] = useState('');
  const [pontoSubmittingType, setPontoSubmittingType] = useState<'ENTRADA' | 'SAIDA' | ''>('');
  const [pontoError, setPontoError] = useState('');
  const [pontoFeedback, setPontoFeedback] = useState('');
  const [pontoRecent, setPontoRecent] = useState<InternalPontoRow[]>([]);
  const [pontoRecentLoading, setPontoRecentLoading] = useState(false);
  const [pontoRecentError, setPontoRecentError] = useState('');
  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, InternalPresenceRow>>({});
  const [hiddenConversationIds, setHiddenConversationIds] = useState<string[]>([]);
  const [pedidoForm, setPedidoForm] = useState({
    responsibleUserId: '',
    tipo: '',
    descricao: '',
    status: 'PENDENTE',
    dataInicio: '',
    dataFim: '',
  });

  const endRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerContainerRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const searchEditedByUserRef = useRef(false);
  const conversationSnapshotRef = useRef<Record<string, { lastMessageAt: string; unreadCount: number; lastSenderUserId: string }>>({});
  const notificationsPrimedRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const lastNotificationSoundAtRef = useRef(0);
  const messageSnapshotRef = useRef<Record<string, { lastMessageId: number; lastSenderUserId: string; lastMessageAt: string }>>({});
  const navigate = useNavigate();
  const currentUserId = String(mockService.getCurrentUserId() || CURRENT_USER_ID || '').trim();
  const currentUser = users.find((user) => user.id === currentUserId) || null;
  const usersById = useMemo(() => {
    const map = new Map<string, User>();
    users.forEach((user) => {
      const id = String(user.id || '').trim();
      if (!id) return;
      map.set(id, user);
    });
    return map;
  }, [users]);

  const updateHiddenConversationIds = (updater: (prev: string[]) => string[]) => {
    setHiddenConversationIds((prev) => {
      const next = Array.from(new Set(updater(prev).map((item) => String(item || '').trim()).filter(Boolean)));
      saveHiddenConversationIdsForUser(currentUserId, next);
      return next;
    });
  };

  const hideConversationLocally = (conversationId: string) => {
    const normalizedId = String(conversationId || '').trim();
    if (!normalizedId) return;
    updateHiddenConversationIds((prev) => (prev.includes(normalizedId) ? prev : [...prev, normalizedId]));
  };

  const unhideConversationLocally = (conversationId: string) => {
    const normalizedId = String(conversationId || '').trim();
    if (!normalizedId) return;
    updateHiddenConversationIds((prev) => prev.filter((item) => item !== normalizedId));
  };

  const getPresence = (userId?: string | null): InternalPresenceRow | null => {
    const key = String(userId || '').trim();
    if (!key) return null;
    return presenceByUserId[key] || null;
  };

  const selectedConversation = useMemo(
    () => conversations.find((item) => item.id === selectedConversationId) || null,
    [conversations, selectedConversationId]
  );

  const selectedConversationPeer = useMemo(() => {
    const peerId = String(selectedConversation?.otherUserId || '').trim();
    if (!peerId) return null;
    return usersById.get(peerId) || null;
  }, [selectedConversation?.otherUserId, usersById]);

  const canViewAllTasks = useMemo(() => {
    const role = String(currentUser?.role || '').trim().toUpperCase();
    const email = String(currentUser?.email || '').trim().toLowerCase();
    return role === 'ADMIN' || email === 'mpr@mpr.pt';
  }, [currentUser]);

  const taskTargetUserId = useMemo(() => {
    if (canViewAllTasks && selectedConversation?.type === 'direct' && selectedConversation.otherUserId) {
      return String(selectedConversation.otherUserId || '').trim();
    }
    return currentUserId;
  }, [canViewAllTasks, selectedConversation, currentUserId]);

  const taskTargetUser = useMemo(
    () => users.find((user) => user.id === taskTargetUserId) || null,
    [users, taskTargetUserId]
  );

  const memberIdSet = useMemo(() => new Set(members.map((member) => member.userId)), [members]);

  const selectedMessageIds = useMemo(
    () => new Set(selectedByConversation[selectedConversationId] || []),
    [selectedByConversation, selectedConversationId]
  );
  const starredMessageIds = useMemo(
    () => new Set(starredByConversation[selectedConversationId] || []),
    [starredByConversation, selectedConversationId]
  );
  const pinnedMessageId = pinnedByConversation[selectedConversationId] || null;

  const replyMessage = useMemo(
    () => messages.find((item) => item.id === replyToMessageId) || null,
    [messages, replyToMessageId]
  );
  const editingMessage = useMemo(
    () => messages.find((item) => item.id === editingMessageId) || null,
    [messages, editingMessageId]
  );
  const messageById = useMemo(() => {
    const map = new Map<number, InternalMessageRow>();
    messages.forEach((item) => {
      const messageId = Number(item?.id || 0);
      if (!Number.isFinite(messageId) || messageId <= 0) return;
      map.set(messageId, item);
    });
    return map;
  }, [messages]);
  const errorSuggestion = useMemo(() => buildErrorSuggestionPtPt(error), [error]);

  const visibleConversations = useMemo(() => {
    if (hiddenConversationIds.length === 0) return conversations;
    const hiddenSet = new Set(hiddenConversationIds);
    return conversations.filter((conversation) => !hiddenSet.has(String(conversation.id || '').trim()));
  }, [conversations, hiddenConversationIds]);

  const filteredConversations = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return visibleConversations;
    return visibleConversations.filter((conversation) => {
      const haystack = [
        conversation.title,
        conversation.otherUserName || '',
        conversation.otherUserEmail || '',
        conversation.lastMessageBody || '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [visibleConversations, search]);

  const availableUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = users
      .slice()
      .sort((a, b) => {
        if (a.id === currentUserId) return -1;
        if (b.id === currentUserId) return 1;
        return String(a.name || '').localeCompare(String(b.name || ''), 'pt');
      });
    if (!term) return list;
    return list.filter((user) => {
      const haystack = `${user.name} ${user.email}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [users, search, currentUserId]);

  const groupedMessages = useMemo(() => {
    const groups: Array<{ type: 'day'; label: string } | { type: 'msg'; message: InternalMessageRow }> = [];
    let lastDayKey = '';
    messages.forEach((message) => {
      const date = new Date(message.createdAt);
      const dayKey = Number.isFinite(date.getTime())
        ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
        : 'unknown';
      if (dayKey !== lastDayKey) {
        lastDayKey = dayKey;
        groups.push({ type: 'day', label: formatDayLabel(message.createdAt) });
      }
      groups.push({ type: 'msg', message });
    });
    return groups;
  }, [messages]);

  const ensureNotificationAudioContext = () => {
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
  };

  const playIncomingNotificationSound = () => {
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
  };

  const syncConversationSnapshotAndNotify = (nextConversations: InternalConversationRow[]) => {
    const previous = conversationSnapshotRef.current;
    const next: Record<string, { lastMessageAt: string; unreadCount: number; lastSenderUserId: string }> = {};
    let shouldPlay = false;

    (Array.isArray(nextConversations) ? nextConversations : []).forEach((conversation) => {
      const id = String(conversation.id || '').trim();
      if (!id) return;

      const lastMessageAt = String(conversation.lastMessageAt || '').trim();
      const unreadCount = Number(conversation.unreadCount || 0);
      const lastSenderUserId = String(conversation.lastSenderUserId || '').trim();

      next[id] = {
        lastMessageAt,
        unreadCount,
        lastSenderUserId,
      };

      const prev = previous[id];
      const currentTs = Number(new Date(lastMessageAt).getTime()) || 0;
      const prevTs = Number(new Date(String(prev?.lastMessageAt || '')).getTime()) || 0;
      const isIncomingBySender = !!lastSenderUserId && lastSenderUserId !== currentUserId;
      const hasAdvancedTimeFromIncomingSender = isIncomingBySender && currentTs > prevTs;
      const hasUnreadIncrease = unreadCount > Number(prev?.unreadCount || 0);
      const isNewConversationWithUnread = !prev && unreadCount > 0;

      if (hasAdvancedTimeFromIncomingSender || hasUnreadIncrease || isNewConversationWithUnread) {
        shouldPlay = true;
      }
    });

    if (notificationsPrimedRef.current && shouldPlay) {
      playIncomingNotificationSound();
    }

    conversationSnapshotRef.current = next;
    notificationsPrimedRef.current = true;
  };

  const syncMessageSnapshotAndNotify = (conversationId: string, nextMessages: InternalMessageRow[]) => {
    const id = String(conversationId || '').trim();
    if (!id) return;

    const latestMessage = [...(Array.isArray(nextMessages) ? nextMessages : [])]
      .reverse()
      .find((message) => !message?.deletedAt);

    const latestMessageId = Number(latestMessage?.id || 0);
    const latestSenderUserId = String(latestMessage?.senderUserId || '').trim();
    const latestMessageAt = String(latestMessage?.createdAt || '').trim();
    const previous = messageSnapshotRef.current[id];

    if (previous && latestMessageId > 0) {
      const hasNewMessageId = latestMessageId !== Number(previous.lastMessageId || 0);
      const currentTs = Number(new Date(latestMessageAt).getTime()) || 0;
      const prevTs = Number(new Date(String(previous.lastMessageAt || '')).getTime()) || 0;
      const hasAdvancedTime = currentTs > prevTs;
      const isIncoming = !!latestSenderUserId && latestSenderUserId !== currentUserId;

      if (isIncoming && (hasNewMessageId || hasAdvancedTime)) {
        playIncomingNotificationSound();
      }
    }

    messageSnapshotRef.current[id] = {
      lastMessageId: latestMessageId,
      lastSenderUserId: latestSenderUserId,
      lastMessageAt: latestMessageAt,
    };
  };

  useEffect(() => {
    conversationSnapshotRef.current = {};
    messageSnapshotRef.current = {};
    notificationsPrimedRef.current = false;
  }, [currentUserId]);

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
  }, []);

  useEffect(() => {
    if (!showEmojiPicker) return;

    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (composerContainerRef.current?.contains(target)) return;
      setShowEmojiPicker(false);
    };

    document.addEventListener('mousedown', handleDocumentClick);
    return () => {
      document.removeEventListener('mousedown', handleDocumentClick);
    };
  }, [showEmojiPicker]);

  useEffect(() => {
    setShowEmojiPicker(false);
  }, [selectedConversationId]);

  const loadBase = async () => {
    if (!currentUserId) return;
    try {
      try {
        await importInternalChatHistorySupabase({ actorUserId: currentUserId });
      } catch (syncError) {
        console.warn('[Internal Chat] Falha no sync de histórico Supabase:', syncError);
      }

      const [loadedUsers, loadedConversations] = await Promise.all([
        mockService.getUsers(),
        fetchInternalConversations(currentUserId),
      ]);

      try {
        const presenceRows = await fetchInternalPresence({
          userId: currentUserId,
          userIds: loadedUsers.map((user) => String(user.id || '').trim()).filter(Boolean),
          windowSeconds: 75,
        });
        const map: Record<string, InternalPresenceRow> = {};
        presenceRows.forEach((row) => {
          const key = String(row.userId || '').trim();
          if (!key) return;
          map[key] = row;
        });
        setPresenceByUserId(map);
      } catch (presenceError) {
        console.warn('[Internal Chat] Falha ao carregar presença:', presenceError);
      }

      const hiddenSet = new Set(hiddenConversationIds);
      const visibleLoadedConversations = loadedConversations.filter(
        (conversation) => !hiddenSet.has(String(conversation.id || '').trim())
      );

      syncConversationSnapshotAndNotify(visibleLoadedConversations);
      setUsers(loadedUsers);
      setConversations(visibleLoadedConversations);

      if (!selectedConversationId && visibleLoadedConversations.length > 0) {
        setSelectedConversationId(visibleLoadedConversations[0].id);
      } else if (
        selectedConversationId &&
        !visibleLoadedConversations.some((conversation) => conversation.id === selectedConversationId)
      ) {
        setSelectedConversationId(visibleLoadedConversations[0]?.id || '');
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar chat interno.');
    }
  };

  const loadConversationMessages = async (conversationId: string) => {
    if (!conversationId || !currentUserId) {
      setMessages([]);
      return;
    }

    try {
      const loaded = await fetchInternalMessages({
        conversationId,
        userId: currentUserId,
        limit: 300,
      });
      syncMessageSnapshotAndNotify(conversationId, loaded);
      setMessages(loaded);
      await markInternalConversationAsRead(conversationId, currentUserId);
      const refreshedConversations = await fetchInternalConversations(currentUserId);
      const hiddenSet = new Set(hiddenConversationIds);
      setConversations(
        refreshedConversations.filter((conversation) => !hiddenSet.has(String(conversation.id || '').trim()))
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar mensagens.');
    }
  };

  const loadConversationMembers = async (conversationId: string) => {
    if (!conversationId || !currentUserId || selectedConversation?.type !== 'group') {
      setMembers([]);
      return;
    }
    try {
      const data = await fetchInternalConversationMembers({ conversationId, userId: currentUserId });
      setMembers(data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar membros.');
    }
  };

  useEffect(() => {
    setHiddenConversationIds(loadHiddenConversationIdsForUser(currentUserId));
  }, [currentUserId]);

  useEffect(() => {
    searchEditedByUserRef.current = false;
    setSearch('');

    // Alguns browsers repõem automaticamente o último valor do campo.
    // Este "double-check" limpa o autofill sem apagar escrita manual do utilizador.
    const timers = [80, 350, 1200].map((ms) =>
      window.setTimeout(() => {
        if (searchEditedByUserRef.current) return;
        setSearch('');
      }, ms)
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  useEffect(() => {
    if (!currentUserId) return;
    const hasRestoredConv = !!selectedConversationId;
    if (!hasRestoredConv) setIsLoading(true);
    void loadBase().finally(() => setIsLoading(false));

    const interval = window.setInterval(() => {
      void loadBase();
      if (selectedConversationId) {
        void loadConversationMessages(selectedConversationId);
      }
    }, 2000);

    return () => window.clearInterval(interval);
  }, [currentUserId, selectedConversationId, hiddenConversationIds]);

  useEffect(() => {
    if (!selectedConversationId) {
      setMessages([]);
      setMembers([]);
      return;
    }
    void loadConversationMessages(selectedConversationId);
  }, [selectedConversationId]);

  useEffect(() => {
    if (selectedConversation?.type === 'group' && selectedConversationId) {
      void loadConversationMembers(selectedConversationId);
      return;
    }
    setMembers([]);
  }, [selectedConversation?.type, selectedConversationId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!taskTargetUserId) {
      setEmployeeTasks([]);
      setEmployeeTasksError('');
      return;
    }
    let cancelled = false;
    setEmployeeTasksLoading(true);
    setEmployeeTasksError('');
    void fetchInternalUserOpenTasks(taskTargetUserId, currentUserId)
      .then((rows) => {
        if (cancelled) return;
        setEmployeeTasks(Array.isArray(rows) ? rows : []);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setEmployeeTasks([]);
        setEmployeeTasksError(loadError instanceof Error ? loadError.message : 'Falha ao carregar tarefas.');
      })
      .finally(() => {
        if (!cancelled) setEmployeeTasksLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [taskTargetUserId, selectedConversationId, currentUserId]);

  useEffect(() => {
    if (!currentUserId) {
      setPontoRecent([]);
      setPontoRecentError('');
      return;
    }
    let cancelled = false;
    setPontoRecentLoading(true);
    setPontoRecentError('');
    void fetchInternalPontoRecentSupabase({ actorUserId: currentUserId, limit: 2 })
      .then((rows) => {
        if (cancelled) return;
        setPontoRecent(Array.isArray(rows) ? rows : []);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setPontoRecent([]);
        setPontoRecentError(loadError instanceof Error ? loadError.message : 'Falha ao carregar últimos registos.');
      })
      .finally(() => {
        if (!cancelled) setPontoRecentLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [currentUserId]);

  useEffect(() => {
    const handleClose = () => setContextMenu(null);
    window.addEventListener('click', handleClose);
    return () => window.removeEventListener('click', handleClose);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    if (typeof window === 'undefined') return;
    const menu = contextMenuRef.current;
    if (!menu) return;

    const rect = menu.getBoundingClientRect();
    const padding = 10;
    let nextX = contextMenu.x;
    let nextY = contextMenu.y;

    if (rect.right > window.innerWidth - padding) {
      nextX = Math.max(padding, Math.round(window.innerWidth - rect.width - padding));
    }
    if (rect.bottom > window.innerHeight - padding) {
      nextY = Math.max(padding, Math.round(window.innerHeight - rect.height - padding));
    }
    if (rect.left < padding) {
      nextX = padding;
    }
    if (rect.top < padding) {
      nextY = padding;
    }

    if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
      setContextMenu((prev) => (prev ? { ...prev, x: nextX, y: nextY } : prev));
    }
  }, [contextMenu]);

  const openConversationWithUser = async (targetUser: User) => {
    if (!currentUserId || !targetUser?.id) return;

    setError('');
    try {
      const conversation = await ensureDirectInternalConversation(currentUserId, targetUser.id);
      unhideConversationLocally(conversation.id);
      const refreshedConversations = await fetchInternalConversations(currentUserId);
      const hiddenSet = new Set(hiddenConversationIds.filter((id) => id !== conversation.id));
      setConversations(
        refreshedConversations.filter((item) => !hiddenSet.has(String(item.id || '').trim()))
      );
      setSelectedConversationId(conversation.id);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Falha ao abrir conversa.');
    }
  };

  const toggleGroupMember = (userId: string) => {
    setGroupMemberIds((prev) => {
      if (prev.includes(userId)) {
        return prev.filter((id) => id !== userId);
      }
      return [...prev, userId];
    });
  };

  const handleCreateGroup = async () => {
    if (!currentUserId) return;
    if (groupMemberIds.length === 0) {
      setError('Selecione pelo menos um funcionário para criar o grupo.');
      return;
    }

    setIsSubmittingGroup(true);
    setError('');
    try {
      const conversation = await createInternalGroupConversation({
        userId: currentUserId,
        title: groupTitle.trim(),
        memberUserIds: groupMemberIds,
      });
      setGroupTitle('');
      setGroupMemberIds([]);
      setIsCreatingGroup(false);
      const refreshedConversations = await fetchInternalConversations(currentUserId);
      const hiddenSet = new Set(hiddenConversationIds);
      setConversations(
        refreshedConversations.filter((item) => !hiddenSet.has(String(item.id || '').trim()))
      );
      setSelectedConversationId(conversation.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Falha ao criar grupo.');
    } finally {
      setIsSubmittingGroup(false);
    }
  };

  const handleAddMemberToSelectedGroup = async (memberUserId: string) => {
    if (!selectedConversationId || !currentUserId || selectedConversation?.type !== 'group') return;
    if (memberIdSet.has(memberUserId)) return;

    setIsAddingMember(true);
    setError('');
    try {
      await addInternalConversationMembers({
        conversationId: selectedConversationId,
        userId: currentUserId,
        memberUserIds: [memberUserId],
      });
      await loadConversationMembers(selectedConversationId);
      const refreshedConversations = await fetchInternalConversations(currentUserId);
      const hiddenSet = new Set(hiddenConversationIds);
      setConversations(
        refreshedConversations.filter((item) => !hiddenSet.has(String(item.id || '').trim()))
      );
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'Falha ao adicionar membro.');
    } finally {
      setIsAddingMember(false);
    }
  };

  const handleDeleteSelectedConversation = async () => {
    if (!selectedConversationId || !currentUserId || !selectedConversation) return;

    const title = String(selectedConversation.title || 'Conversa interna').trim();
    const isPlaceholderPeer = String(selectedConversation.otherUserEmail || '').trim().toLowerCase().endsWith('@sync.local');
    const confirmText = isPlaceholderPeer
      ? `Eliminar a conversa "${title}" e limpar funcionário antigo órfão?`
      : `Eliminar a conversa "${title}"?`;
    if (!window.confirm(confirmText)) return;

    setIsDeletingConversation(true);
    setError('');
    try {
      const result = await deleteInternalConversation({
        conversationId: selectedConversationId,
        userId: currentUserId,
        deleteOrphanPlaceholderUsers: true,
      });
      hideConversationLocally(selectedConversationId);
      setSelectedConversationId('');
      setMessages([]);
      setMembers([]);
      if (result.hiddenLocalOnly) {
        setConversations((prev) => prev.filter((conversation) => conversation.id !== selectedConversationId));
      }
      await loadBase();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Falha ao eliminar conversa.');
    } finally {
      setIsDeletingConversation(false);
    }
  };

  const resetComposerState = () => {
    setReplyToMessageId(null);
    setEditingMessageId(null);
    setNewMessage('');
  };

  const handleSendText = async () => {
    if (!selectedConversationId || !currentUserId) return;
    const body = newMessage.trim();
    if (!body) return;

    setIsSending(true);
    setError('');
    try {
      if (editingMessageId) {
        await editInternalMessage({
          messageId: editingMessageId,
          userId: currentUserId,
          body,
        });
      } else {
        await sendInternalMessage({
          conversationId: selectedConversationId,
          userId: currentUserId,
          body,
          type: 'text',
          replyToMessageId,
        });
      }
      resetComposerState();
      await loadConversationMessages(selectedConversationId);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Falha ao enviar mensagem interna.');
    } finally {
      setIsSending(false);
    }
  };

  const handleUploadFile = async (file: File) => {
    if (!selectedConversationId || !currentUserId || !file) return;
    setIsUploading(true);
    setError('');
    try {
      await uploadInternalFileMessage({
        conversationId: selectedConversationId,
        userId: currentUserId,
        file,
        caption: newMessage.trim() || undefined,
        replyToMessageId,
      });
      resetComposerState();
      await loadConversationMessages(selectedConversationId);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Falha ao enviar ficheiro.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await handleUploadFile(file);
  };

  const handlePasteOnComposer = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items || []);
    const fileItem = items.find((item) => item.kind === 'file');
    if (!fileItem) return;
    const file = fileItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    await handleUploadFile(file);
  };

  const appendEmojiToComposer = (emoji: string) => {
    if (!emoji) return;
    setNewMessage((prev) => prev + emoji);
    setShowEmojiPicker(false);
    window.setTimeout(() => {
      composerTextareaRef.current?.focus();
    }, 0);
  };

  const toggleSelectedMessage = (messageId: number) => {
    setSelectedByConversation((prev) => {
      const current = prev[selectedConversationId] || [];
      const exists = current.includes(messageId);
      const next = exists ? current.filter((id) => id !== messageId) : [...current, messageId];
      return { ...prev, [selectedConversationId]: next };
    });
  };

  const toggleStarMessage = (messageId: number) => {
    setStarredByConversation((prev) => {
      const current = prev[selectedConversationId] || [];
      const exists = current.includes(messageId);
      const next = exists ? current.filter((id) => id !== messageId) : [...current, messageId];
      return { ...prev, [selectedConversationId]: next };
    });
  };

  const togglePinMessage = (messageId: number) => {
    setPinnedByConversation((prev) => {
      const current = prev[selectedConversationId] || null;
      return { ...prev, [selectedConversationId]: current === messageId ? null : messageId };
    });
  };

  const openContextMenu = (event: React.MouseEvent, message: InternalMessageRow) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, message });
  };

  const handleToggleReaction = async (message: InternalMessageRow, emoji: string) => {
    const messageId = Number(message?.id || 0);
    const normalizedEmoji = String(emoji || '').trim();
    if (!currentUserId || !messageId || !normalizedEmoji) return;

    setError('');
    try {
      await toggleInternalMessageReaction({
        messageId,
        userId: currentUserId,
        emoji: normalizedEmoji,
      });
      if (selectedConversationId) {
        await loadConversationMessages(selectedConversationId);
      }
    } catch (reactionError) {
      setError(reactionError instanceof Error ? reactionError.message : 'Falha ao reagir à mensagem.');
    }
  };

  const handleContextAction = async (action: string, message: InternalMessageRow) => {
    setContextMenu(null);

    if (action.startsWith('react:')) {
      const emoji = action.slice('react:'.length).trim();
      await handleToggleReaction(message, emoji);
      return;
    }

    if (action === 'copy') {
      if (message.body) {
        await navigator.clipboard.writeText(message.body).catch(() => null);
      }
      return;
    }

    if (action === 'reply') {
      setReplyToMessageId(message.id);
      setEditingMessageId(null);
      return;
    }

    if (action === 'edit') {
      if (message.senderUserId !== currentUserId || message.type !== 'text' || message.deletedAt) return;
      setEditingMessageId(message.id);
      setReplyToMessageId(null);
      setNewMessage(message.body || '');
      return;
    }

    if (action === 'forward') {
      setForwardMessage(message);
      setShowForwardModal(true);
      return;
    }

    if (action === 'pin') {
      togglePinMessage(message.id);
      return;
    }

    if (action === 'star') {
      toggleStarMessage(message.id);
      return;
    }

    if (action === 'select') {
      toggleSelectedMessage(message.id);
      return;
    }

    if (action === 'details') {
      const details = [
        `ID: ${message.id}`,
        `Tipo: ${message.type}`,
        `Autor: ${message.senderName}`,
        `Data: ${new Date(message.createdAt).toLocaleString('pt-PT')}`,
        `Editada: ${message.editedAt ? 'Sim' : 'Não'}`,
        `Apagada: ${message.deletedAt ? 'Sim' : 'Não'}`,
        `Ficheiro: ${message.fileName || '--'}`,
      ].join('\n');
      window.alert(details);
      return;
    }

    if (action === 'delete') {
      if (!window.confirm('Apagar esta mensagem na conversa interna?')) return;
      await deleteInternalMessage({ messageId: message.id, userId: currentUserId });
      if (selectedConversationId) {
        await loadConversationMessages(selectedConversationId);
      }
    }
  };

  const handleForwardToConversation = async (targetConversationId: string) => {
    if (!forwardMessage || !currentUserId) return;
    setError('');
    try {
      if (forwardMessage.mediaPath) {
        await sendInternalMessage({
          conversationId: targetConversationId,
          userId: currentUserId,
          body: `[Reencaminhado] ${forwardMessage.body || forwardMessage.fileName || 'Anexo'}`,
          type: forwardMessage.type === 'image' ? 'image' : 'document',
          mediaPath: forwardMessage.mediaPath,
          mimeType: forwardMessage.mimeType || null,
          fileName: forwardMessage.fileName || null,
          fileSize: forwardMessage.fileSize || null,
        });
      } else {
        await sendInternalMessage({
          conversationId: targetConversationId,
          userId: currentUserId,
          body: forwardMessage.body,
          type: 'text',
        });
      }
      setShowForwardModal(false);
      setForwardMessage(null);
      if (selectedConversationId) {
        await loadConversationMessages(selectedConversationId);
      }
      await loadBase();
    } catch (forwardError) {
      setError(forwardError instanceof Error ? forwardError.message : 'Falha ao reencaminhar mensagem.');
    }
  };

  const openPedidoModal = () => {
    setPedidoError('');
    setPedidoFeedback('');
    const todayIso = new Date().toISOString().slice(0, 10);
    setPedidoForm({
      responsibleUserId: currentUserId || '',
      tipo: 'Ferias',
      descricao: '',
      status: 'PENDENTE',
      dataInicio: todayIso,
      dataFim: todayIso,
    });
    setShowPedidoModal(true);
  };

  const submitPedido = async () => {
    if (!currentUserId) return;
    if (!pedidoForm.tipo.trim()) {
      setPedidoError('Indique o tipo do pedido.');
      return;
    }

    setPedidoSubmitting(true);
    setPedidoError('');
    try {
      const created = await createInternalPedidoSupabase({
        actorUserId: currentUserId,
        actorName: currentUser?.name || '',
        actorEmail: currentUser?.email || '',
        responsibleUserId: pedidoForm.responsibleUserId || taskTargetUserId || currentUserId,
        tipo: pedidoForm.tipo.trim(),
        descricao: pedidoForm.descricao.trim(),
        status: pedidoForm.status,
        dataInicio: pedidoForm.dataInicio || undefined,
        dataFim: pedidoForm.dataFim || undefined,
      });
      setShowPedidoModal(false);
      setPedidoFeedback(`Pedido criado no Supabase (${created.table || 'pedidos'}).`);
    } catch (submitError) {
      setPedidoError(submitError instanceof Error ? submitError.message : 'Falha ao criar pedido.');
    } finally {
      setPedidoSubmitting(false);
    }
  };

  const submitPonto = async (tipo: 'ENTRADA' | 'SAIDA') => {
    if (!currentUserId) return;
    if (!pontoPin.trim()) {
      setPontoError('Introduza o PIN para registar ponto.');
      return;
    }

    setPontoSubmittingType(tipo);
    setPontoError('');
    setPontoFeedback('');
    try {
      const result = await createInternalPontoSupabase({
        actorUserId: currentUserId,
        pin: pontoPin.trim(),
        tipo,
        origem: 'oracle',
      });
      const momento = String(result?.registo?.momento || '').trim();
      const whenLabel = momento ? new Date(momento).toLocaleString('pt-PT') : '';
      setPontoPin('');
      setPontoFeedback(
        `Registo de ${tipo === 'ENTRADA' ? 'entrada' : 'saída'} gravado${whenLabel ? ` em ${whenLabel}` : ''}.`
      );
      setPontoRecentLoading(true);
      setPontoRecentError('');
      try {
        const rows = await fetchInternalPontoRecentSupabase({ actorUserId: currentUserId, limit: 2 });
        setPontoRecent(Array.isArray(rows) ? rows : []);
      } catch (recentError) {
        setPontoRecentError(recentError instanceof Error ? recentError.message : 'Falha ao carregar últimos registos.');
      } finally {
        setPontoRecentLoading(false);
      }
    } catch (submitError) {
      setPontoError(submitError instanceof Error ? submitError.message : 'Falha ao registar ponto.');
    } finally {
      setPontoSubmittingType('');
    }
  };

  const pinnedMessage = useMemo(
    () => messages.find((message) => message.id === pinnedMessageId) || null,
    [messages, pinnedMessageId]
  );

  return (
    <div className="h-[calc(100vh-4rem)] w-full bg-gray-100 p-4 md:p-6 space-y-4 flex flex-col">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 text-white shadow-sm md:p-5">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[320px_1fr_360px] md:items-center">
          <div>
            <h1 className="text-xl font-bold md:text-2xl">Chat Interno</h1>
            <p className="text-xs text-slate-200 md:text-sm">Comunicação entre funcionários e equipas.</p>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-slate-200">{currentUser ? `Ligado como ${currentUser.name}` : 'Sem utilizador ativo'}</p>
            <p className="truncate text-base font-semibold text-white md:text-lg">
              {selectedConversation?.title || 'Selecione ou crie uma conversa'}
            </p>
            {selectedConversation?.type === 'direct' && selectedConversationPeer && (
              <p className="mt-0.5 text-[11px] text-slate-200">
                {formatPresenceLabel(getPresence(selectedConversationPeer.id))}
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => void handleDeleteSelectedConversation()}
              disabled={!selectedConversationId || isDeletingConversation}
              className="inline-flex items-center gap-1 rounded-lg border border-red-300/60 bg-red-500/15 px-3 py-2 text-xs font-semibold text-red-100 hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              title="Eliminar conversa selecionada"
            >
              <Trash2 size={14} />
              {isDeletingConversation ? 'A eliminar...' : 'Eliminar conversa'}
            </button>
            <button
              onClick={openPedidoModal}
              className="inline-flex items-center gap-1 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/20"
            >
              <Plus size={14} />
              Criar Pedido
            </button>
            <button
              onClick={() => setIsCreatingGroup((prev) => !prev)}
              className="inline-flex items-center gap-1 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/20"
            >
              <Users size={14} />
              Novo Grupo
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 grid grid-cols-[320px_1fr_380px]">
        <aside className="border-r border-gray-200 bg-white flex flex-col min-h-0">
          <div className="p-3 border-b border-gray-200">
            <label className="relative block">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={() => {
                  searchEditedByUserRef.current = true;
                }}
                onPaste={() => {
                  searchEditedByUserRef.current = true;
                }}
                placeholder="Pesquisar conversa ou funcionário"
                name={`internal_chat_search_${currentUserId || 'user'}`}
                autoComplete="new-password"
                spellCheck={false}
                className="w-full rounded-lg border border-gray-200 bg-gray-50 pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-200"
              />
              {search.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    searchEditedByUserRef.current = false;
                    setSearch('');
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  title="Limpar filtro"
                >
                  <X size={14} />
                </button>
              )}
            </label>
          </div>

          <div className="min-h-0 flex-1 flex flex-col">
            <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500 border-b border-gray-100">
              Conversas
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {filteredConversations.map((conversation) => {
                const isActive = conversation.id === selectedConversationId;
                const peerUser = conversation.otherUserId ? usersById.get(conversation.otherUserId) || null : null;
                const avatarName = String(
                  conversation.type === 'group'
                    ? conversation.title
                    : conversation.otherUserName || conversation.title || 'Funcionário'
                ).trim();
                const directAvatarUrl =
                  conversation.type === 'group'
                    ? ''
                    : resolveAvatarUrl(avatarName, conversation.otherUserAvatar || peerUser?.avatarUrl || '', 64);
                const directPresence = conversation.type === 'direct' ? getPresence(conversation.otherUserId) : null;
                return (
                  <button
                    key={conversation.id}
                    onClick={() => setSelectedConversationId(conversation.id)}
                    className={`w-full text-left px-4 py-3 border-b border-gray-100 transition ${
                      isActive ? 'bg-whatsapp-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="relative mt-0.5 h-9 w-9 shrink-0 overflow-hidden rounded-full border border-slate-200 bg-slate-100">
                        {conversation.type === 'group' ? (
                          <div className="flex h-full w-full items-center justify-center text-slate-600">
                            <Users size={14} />
                          </div>
                        ) : (
                          <img src={directAvatarUrl} alt={avatarName || 'Funcionário'} className="h-full w-full object-cover" />
                        )}
                        {conversation.type === 'direct' && (
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${
                              directPresence?.isOnline ? 'bg-emerald-500' : 'bg-slate-300'
                            }`}
                          />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <p className="text-sm font-semibold text-gray-900 truncate">{conversation.title || 'Conversa interna'}</p>
                          {conversation.type === 'group' && (
                            <span className="text-[10px] font-semibold px-2 py-[2px] rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                              Grupo
                            </span>
                          )}
                        </div>
                        {conversation.type === 'direct' && (
                          <p className="text-[11px] text-slate-500 mt-0.5">{formatPresenceLabel(directPresence)}</p>
                        )}
                        <p className="text-xs text-gray-500 truncate mt-1">{conversation.lastMessageBody || 'Sem mensagens ainda.'}</p>
                        {conversation.type === 'group' && (
                          <p className="text-[11px] text-gray-400 mt-1">{Math.max(0, Number(conversation.memberCount || 0))} membros</p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-[11px] text-gray-500">{formatTimeLabel(conversation.lastMessageAt)}</p>
                        {conversation.unreadCount > 0 && (
                          <span className="inline-flex mt-1 items-center justify-center min-w-[20px] h-5 px-1 rounded-full bg-whatsapp-500 text-white text-[11px] font-semibold">
                            {conversation.unreadCount}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
              {!isLoading && filteredConversations.length === 0 && (
                <div className="p-6 text-sm text-gray-500">Sem conversas internas.</div>
              )}
            </div>

            <div className="border-t border-gray-200">
              <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Funcionários
              </div>
              <div className="max-h-64 overflow-auto">
                {availableUsers.map((user) => {
                  const isSelected = selectedConversation?.otherUserId === user.id;
                  const isSelfUser = user.id === currentUserId;
                  const selectedInGroupDraft = groupMemberIds.includes(user.id);
                  const alreadyInSelectedGroup = selectedConversation?.type === 'group' && memberIdSet.has(user.id);
                  const userPresence = getPresence(user.id);
                  const avatarUrl = resolveAvatarUrl(user.name, user.avatarUrl || '', 56);

                  return (
                    <div key={user.id} className={`px-3 py-2 border-t border-gray-100 ${isSelected ? 'bg-whatsapp-50' : ''}`}>
                      <div className="flex items-start gap-2">
                        <div className="relative mt-0.5 h-9 w-9 shrink-0 overflow-hidden rounded-full border border-slate-200 bg-slate-100">
                          <img src={avatarUrl} alt={user.name || 'Funcionário'} className="h-full w-full object-cover" />
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${
                              userPresence?.isOnline ? 'bg-emerald-500' : 'bg-slate-300'
                            }`}
                          />
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-gray-900 truncate">
                            {user.name}
                            {isSelfUser ? (
                              <span className="ml-2 rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">
                                Eu
                              </span>
                            ) : null}
                          </div>
                          <div className="text-xs text-gray-500 truncate">{user.email}</div>
                          <div className="mt-0.5 text-[11px] text-slate-500">{formatPresenceLabel(userPresence)}</div>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-1 flex-wrap">
                        <button
                          onClick={() => void openConversationWithUser(user)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-200 text-xs text-gray-700 hover:bg-gray-50"
                        >
                          <MessageSquarePlus size={12} />
                          {isSelfUser ? 'Notas/Avisos' : 'Direto'}
                        </button>

                        {isCreatingGroup && !isSelfUser && (
                          <button
                            onClick={() => toggleGroupMember(user.id)}
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs border ${
                              selectedInGroupDraft
                                ? 'bg-whatsapp-100 border-whatsapp-300 text-whatsapp-800'
                                : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                            }`}
                          >
                            {selectedInGroupDraft ? <Check size={12} /> : <Plus size={12} />}
                            {selectedInGroupDraft ? 'Selecionado' : 'Selecionar'}
                          </button>
                        )}

                        {selectedConversation?.type === 'group' && !isSelfUser && !alreadyInSelectedGroup && (
                          <button
                            onClick={() => void handleAddMemberToSelectedGroup(user.id)}
                            disabled={isAddingMember}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-blue-200 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                          >
                            <Plus size={12} />
                            Adicionar
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </aside>

        <section className="flex flex-col min-h-0 bg-[#ece8df]">
          {pinnedMessage && (
            <div className="bg-blue-50 border-b border-blue-100 px-4 py-2 text-xs text-blue-800 flex items-center justify-between">
              <div className="truncate">
                <span className="font-semibold">Mensagem afixada:</span> {pinnedMessage.body || pinnedMessage.fileName || 'Sem texto'}
              </div>
              <button onClick={() => togglePinMessage(pinnedMessage.id)} className="px-2 py-1 border border-blue-200 rounded">Remover</button>
            </div>
          )}

          <div className="flex-1 overflow-auto px-6 py-4 space-y-2">
            {groupedMessages.map((item, index) => {
              if (item.type === 'day') {
                return (
                  <div key={`day_${index}`} className="flex justify-center py-2">
                    <span className="text-[11px] text-gray-600 bg-white/90 px-3 py-1 rounded-full border border-gray-200">
                      {item.label}
                    </span>
                  </div>
                );
              }

              const message = item.message;
              const isMine = message.senderUserId === currentUserId;
              const senderUser = usersById.get(String(message.senderUserId || '').trim()) || null;
              const senderName = String(
                isMine ? currentUser?.name || message.senderName || 'Eu' : message.senderName || senderUser?.name || 'Funcionário'
              ).trim();
              const senderAvatar = resolveAvatarUrl(senderName, message.senderAvatar || senderUser?.avatarUrl || '', 40);
              const mediaUrl = message.mediaUrl
                ? `${message.mediaUrl}?userId=${encodeURIComponent(currentUserId)}`
                : null;
              const backendTotalRecipients = Math.max(0, Number(message.totalRecipients || 0));
              const fallbackTotalRecipients = Math.max(0, Number(selectedConversation?.memberCount || 0) - 1);
              const totalRecipients = Math.max(backendTotalRecipients, fallbackTotalRecipients);
              const messageCreatedAtMs = parseDateToMs(message.createdAt);
              const readersAfterMessage = new Set(
                messages
                  .filter((candidate) => {
                    if (!candidate || candidate.deletedAt) return false;
                    const candidateSender = String(candidate.senderUserId || '').trim();
                    if (!candidateSender || candidateSender === String(message.senderUserId || '').trim()) return false;
                    return parseDateToMs(candidate.createdAt) > messageCreatedAtMs;
                  })
                  .map((candidate) => String(candidate.senderUserId || '').trim())
              );
              const readByCountRaw = Math.max(
                0,
                Math.max(Number(message.readByCount || 0), readersAfterMessage.size)
              );
              const readByCount = Math.min(totalRecipients, readByCountRaw);
              const readReceipt = getInternalReadReceipt(readByCount, totalRecipients);
              const readByNamesRaw = Array.isArray(message.readByNames) ? message.readByNames : [];
              const fallbackReadByNames = Array.from(readersAfterMessage)
                .map((userId) => usersById.get(userId)?.name || 'Funcionário')
                .filter(Boolean);
              const readByNames = Array.from(new Set([...readByNamesRaw, ...fallbackReadByNames]));
              const reactions = Array.isArray(message.reactions) ? message.reactions : [];
              const replyTargetId = Number(message.replyToMessageId || 0) || null;
              const repliedMessage = replyTargetId ? messageById.get(replyTargetId) || null : null;
              const repliedSenderName = repliedMessage
                ? String(
                    repliedMessage.senderUserId === currentUserId
                      ? currentUser?.name || repliedMessage.senderName || 'Eu'
                      : repliedMessage.senderName || usersById.get(String(repliedMessage.senderUserId || '').trim())?.name || 'Funcionário'
                  ).trim()
                : '';
              const replyPreview = buildQuotedMessagePreview(repliedMessage);

              return (
                <div key={message.id} className={`flex items-end gap-2 ${isMine ? 'justify-end' : 'justify-start'}`}>
                  {!isMine && (
                    <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full border border-slate-200 bg-slate-100">
                      <img src={senderAvatar} alt={senderName || 'Funcionário'} className="h-full w-full object-cover" />
                    </div>
                  )}
                  <div
                    onContextMenu={(event) => openContextMenu(event, message)}
                    className={`max-w-[72%] rounded-xl px-3 py-2 shadow-sm border ${
                      isMine ? 'bg-[#d9fdd3] border-green-100' : 'bg-white border-gray-100'
                    } ${selectedMessageIds.has(message.id) ? 'ring-2 ring-whatsapp-300' : ''}`}
                  >
                    {!isMine && (
                      <p className="text-[11px] font-semibold text-gray-700 mb-1">{senderName}</p>
                    )}

                    {starredMessageIds.has(message.id) && (
                      <p className="text-[11px] text-amber-600 mb-1">★ Com estrela</p>
                    )}

                    {replyTargetId && (
                      <div
                        className={`mb-2 rounded-md border-l-2 px-2 py-1 text-xs ${
                          isMine
                            ? 'border-emerald-400 bg-emerald-50/70 text-emerald-900'
                            : 'border-sky-400 bg-sky-50/80 text-sky-900'
                        }`}
                      >
                        <p className="text-[11px] font-semibold">
                          {repliedSenderName ? `Em resposta a ${repliedSenderName}` : 'Em resposta a uma mensagem'}
                        </p>
                        <p className="truncate">{replyPreview}</p>
                      </div>
                    )}

                    {message.type === 'image' && mediaUrl && (
                      <a href={mediaUrl} target="_blank" rel="noreferrer" className="block mb-2">
                        <img src={mediaUrl} alt={message.fileName || 'Imagem'} className="max-h-64 rounded-lg border border-gray-200" />
                      </a>
                    )}

                    {message.type === 'document' && mediaUrl && (
                      <div className="mb-2 rounded-lg border border-gray-200 bg-white/80 px-2 py-2 text-sm">
                        <div className="flex items-center gap-2">
                          <FileText size={16} className="text-gray-600" />
                          <span className="truncate flex-1">{message.fileName || 'Documento'}</span>
                        </div>
                        <div className="mt-2 flex gap-2">
                          <a
                            href={mediaUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-gray-50"
                          >
                            Abrir
                          </a>
                          <a
                            href={`${mediaUrl}&download=1`}
                            className="text-xs px-2 py-1 rounded border border-gray-200 hover:bg-gray-50"
                          >
                            Guardar
                          </a>
                        </div>
                      </div>
                    )}

                    <p className="text-sm text-gray-900 whitespace-pre-wrap break-words">
                      {message.deletedAt ? 'Mensagem apagada.' : message.body}
                    </p>
                    <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-gray-500">
                      <span>
                        {formatTimeLabel(message.createdAt)}
                        {message.editedAt ? ' · editada' : ''}
                      </span>
                      {isMine && (
                        <span
                          className={readReceipt.isFullyRead ? 'font-semibold text-sky-600' : 'text-gray-500'}
                          title={buildReadReceiptTitle(readByNames, readByCount, totalRecipients)}
                        >
                          {readReceipt.symbol}
                          {readReceipt.label ? ` ${readReceipt.label}` : ''}
                        </span>
                      )}
                    </div>

                    {reactions.length > 0 && (
                      <div className="mt-1 flex flex-wrap items-center justify-end gap-1">
                        {reactions.map((reaction) => {
                          const reactedByMe = Array.isArray(reaction.userIds) && reaction.userIds.includes(currentUserId);
                          const tooltipNames = Array.isArray(reaction.userNames) ? reaction.userNames.filter(Boolean) : [];
                          const tooltipText = tooltipNames.length > 0 ? tooltipNames.join(', ') : 'Sem detalhe';
                          return (
                            <button
                              key={`${message.id}_${reaction.emoji}`}
                              type="button"
                              onClick={() => void handleToggleReaction(message, reaction.emoji)}
                              className={`inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[11px] ${
                                reactedByMe
                                  ? 'border-whatsapp-300 bg-whatsapp-100 text-whatsapp-900'
                                  : 'border-gray-200 bg-white/80 text-gray-700'
                              }`}
                              title={tooltipText}
                            >
                              <span>{reaction.emoji}</span>
                              <span>{Math.max(1, Number(reaction.count || 0))}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>

          <footer className="bg-white border-t border-gray-200 px-4 py-3">
            {(replyMessage || editingMessage) && (
              <div className="mb-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 flex items-center justify-between gap-2">
                <div className="truncate">
                  <span className="font-semibold">{editingMessage ? 'A editar:' : 'Em resposta a:'}</span>{' '}
                  {editingMessage?.body || replyMessage?.body || replyMessage?.fileName || '--'}
                </div>
                <button
                  onClick={() => {
                    setReplyToMessageId(null);
                    setEditingMessageId(null);
                  }}
                  className="px-2 py-1 rounded border border-gray-200"
                >
                  Cancelar
                </button>
              </div>
            )}

            <div className="flex items-end gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={!selectedConversationId || isUploading}
                className="h-10 w-10 rounded-full border border-gray-200 text-gray-600 flex items-center justify-center disabled:opacity-50"
                title="Anexar ficheiro"
              >
                <Paperclip size={16} />
              </button>

              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
                onChange={(event) => void handleFileInput(event)}
              />

              <div className="relative" ref={composerContainerRef}>
                <button
                  onClick={() => setShowEmojiPicker((prev) => !prev)}
                  disabled={!selectedConversationId || isSending || isUploading}
                  className="h-10 w-10 rounded-full border border-gray-200 text-gray-600 flex items-center justify-center disabled:opacity-50"
                  title="Emojis"
                >
                  <Smile size={16} />
                </button>
                {showEmojiPicker && (
                  <div className="absolute bottom-12 left-0 z-20 w-52 rounded-xl border border-gray-200 bg-white p-2 shadow-xl">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Emojis</div>
                    <div className="grid grid-cols-6 gap-1">
                      {QUICK_CHAT_EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => appendEmojiToComposer(emoji)}
                          className="rounded-md px-1 py-1 text-lg leading-none hover:bg-gray-100"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <textarea
                ref={composerTextareaRef}
                rows={1}
                value={newMessage}
                onChange={(event) => setNewMessage(event.target.value)}
                onPaste={(event) => void handlePasteOnComposer(event)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleSendText();
                  }
                  if (event.key === 'Escape' && showEmojiPicker) {
                    setShowEmojiPicker(false);
                  }
                }}
                placeholder={selectedConversationId ? 'Escreva uma mensagem interna... (Ctrl+V para colar imagem)' : 'Selecione uma conversa'}
                disabled={!selectedConversationId || isSending || isUploading}
                className="flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-200 disabled:bg-gray-100"
              />

              <button
                onClick={() => void handleSendText()}
                disabled={!selectedConversationId || !newMessage.trim() || isSending || isUploading}
                className="h-10 w-10 rounded-full bg-whatsapp-500 text-white flex items-center justify-center disabled:opacity-50"
                title="Enviar"
              >
                <Send size={16} />
              </button>
            </div>

            {error && (
              <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                <p>{error}</p>
                {errorSuggestion && (
                  <p className="mt-1 text-red-800">
                    <span className="font-semibold">Sugestão:</span> {errorSuggestion}
                  </p>
                )}
              </div>
            )}
          </footer>
        </section>

        <aside className="border-l border-gray-200 bg-white min-h-0 flex flex-col p-3 gap-3 overflow-hidden">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Atalhos</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <a
                href="https://controle.mpr.pt/"
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-gradient-to-r from-emerald-500 to-green-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:from-emerald-600 hover:to-green-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-300"
              >
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/20">
                  <ExternalLink size={12} />
                </span>
                MPR Control
              </a>
              <a
                href="https://cmrmpr.vercel.app/"
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-gradient-to-r from-emerald-500 to-green-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:from-emerald-600 hover:to-green-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-300"
              >
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-white/20">
                  <ExternalLink size={12} />
                </span>
                MPR CMR
              </a>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Abre o MPR Control e o MPR CMR no browser (ou na app instalada, quando suportado).</p>
            {pedidoFeedback && <div className="mt-2 rounded-lg border border-green-200 bg-green-50 px-2 py-1.5 text-xs text-green-700">{pedidoFeedback}</div>}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="text-sm font-semibold text-slate-900">Registo de Ponto</div>
            <p className="mt-1 text-xs text-slate-500">Introduza o PIN pessoal para registar entrada ou saída.</p>
            <input
              type="password"
              value={pontoPin}
              onChange={(event) => {
                setPontoPin(event.target.value);
                if (pontoError) setPontoError('');
              }}
              placeholder="PIN"
              className="mt-2 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-whatsapp-200"
            />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => void submitPonto('ENTRADA')}
                disabled={!!pontoSubmittingType}
                className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-60"
              >
                {pontoSubmittingType === 'ENTRADA' ? 'A registar...' : 'ENTRADA'}
              </button>
              <button
                onClick={() => void submitPonto('SAIDA')}
                disabled={!!pontoSubmittingType}
                className="rounded-lg bg-rose-500 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-600 disabled:opacity-60"
              >
                {pontoSubmittingType === 'SAIDA' ? 'A registar...' : 'SAÍDA'}
              </button>
            </div>
            {pontoFeedback && (
              <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700">
                {pontoFeedback}
              </div>
            )}
            {pontoError && (
              <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
                {pontoError}
              </div>
            )}
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-2">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Últimos registos</div>
                <span className="text-[11px] text-slate-500">{pontoRecent.length}</span>
              </div>
              {pontoRecentError && <div className="mt-1 text-[11px] text-red-600">{pontoRecentError}</div>}
              <div className="mt-1 space-y-1">
                {pontoRecentLoading && <div className="text-[11px] text-slate-500">A carregar...</div>}
                {!pontoRecentLoading && pontoRecent.length === 0 && (
                  <div className="text-[11px] text-slate-500">Sem registos recentes.</div>
                )}
                {!pontoRecentLoading &&
                  pontoRecent.map((registo, idx) => (
                    <div
                      key={`${registo.id || 'r'}_${idx}`}
                      className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-2 py-1"
                    >
                      <span
                        className={`text-[11px] font-semibold ${
                          registo.tipo === 'ENTRADA' ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        {registo.tipo === 'ENTRADA' ? 'ENTRADA' : 'SAÍDA'}
                      </span>
                      <span className="text-[11px] text-slate-600">{formatPontoDateTime(registo.momento)}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          {isCreatingGroup && (
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-sm font-semibold text-slate-900">Novo grupo</div>
              <input
                value={groupTitle}
                onChange={(event) => setGroupTitle(event.target.value)}
                placeholder="Nome do grupo (opcional)"
                className="mt-2 w-full rounded border border-gray-200 bg-white px-2 py-2 text-sm"
              />
              <p className="text-[11px] text-gray-500 mt-2">Selecionados: {groupMemberIds.length}</p>
              <button
                onClick={() => void handleCreateGroup()}
                disabled={isSubmittingGroup || groupMemberIds.length === 0}
                className="mt-2 w-full rounded bg-whatsapp-500 text-white text-sm py-2 disabled:opacity-50"
              >
                {isSubmittingGroup ? 'A criar...' : 'Criar Grupo'}
              </button>
            </div>
          )}

          {selectedConversation?.type === 'group' && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-3">
              <p className="text-xs font-semibold text-blue-900 mb-2">Membros do grupo</p>
              <div className="flex flex-wrap gap-1">
                {members.map((member) => (
                  <span key={member.userId} className="text-[11px] px-2 py-1 rounded-full bg-white border border-blue-100 text-blue-800">
                    {member.name}
                  </span>
                ))}
                {members.length === 0 && <span className="text-[11px] text-gray-500">Sem membros carregados.</span>}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white p-3 flex-1 min-h-0 flex flex-col">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Tarefas</div>
                <div className="text-sm font-semibold text-slate-900 truncate">
                  {taskTargetUser ? taskTargetUser.name : 'Sem funcionário selecionado'}
                </div>
              </div>
              <span className="text-[11px] rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                {employeeTasks.length}
              </span>
            </div>

            {employeeTasksError && (
              <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
                {employeeTasksError}
              </div>
            )}

            <div className="mt-2 flex-1 min-h-0 overflow-auto space-y-2">
              {employeeTasksLoading && <div className="text-xs text-slate-500">A carregar tarefas...</div>}
              {!employeeTasksLoading && employeeTasks.length === 0 && (
                <div className="text-xs text-slate-500">Sem tarefas em aberto.</div>
              )}
              {!employeeTasksLoading &&
                employeeTasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => {
                      if (task.conversationId) setSelectedConversationId(task.conversationId);
                      const taskId = String(task.id || '').trim();
                      if (taskId) {
                        navigate(`/tasks?taskId=${encodeURIComponent(taskId)}`);
                        return;
                      }
                      navigate('/tasks');
                    }}
                    className={`w-full text-left rounded-lg border px-2 py-2 transition-colors ${getInternalTaskCardTone(
                      String(task.id || ''),
                      task.status
                    )}`}
                  >
                    <div className="text-xs font-semibold text-slate-900 truncate">{task.title || 'Tarefa sem título'}</div>
                    <div className="text-[11px] text-slate-600 truncate mt-0.5">{task.customerName || 'Sem cliente'}</div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                      <span
                        className={`rounded-full border px-1.5 py-0.5 font-medium ${getInternalTaskStatusBadgeClass(task.status)}`}
                      >
                        {formatInternalTaskStatus(task.status)}
                      </span>
                      <span className="text-slate-500">{formatTaskDate(task.dueDate)}</span>
                    </div>
                  </button>
                ))}
            </div>
          </div>
        </aside>
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg w-56 py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <ContextMenuItem icon={<Reply size={14} />} label="Responder" onClick={() => void handleContextAction('reply', contextMenu.message)} />
          <ContextMenuItem icon={<Copy size={14} />} label="Copiar" onClick={() => void handleContextAction('copy', contextMenu.message)} />
          <ContextMenuItem icon={<Forward size={14} />} label="Reencaminhar" onClick={() => void handleContextAction('forward', contextMenu.message)} />
          <ContextMenuItem icon={<Pin size={14} />} label="Afixar" onClick={() => void handleContextAction('pin', contextMenu.message)} />
          <ContextMenuItem icon={<Star size={14} />} label="Marcar com estrela" onClick={() => void handleContextAction('star', contextMenu.message)} />
          <ContextMenuItem icon={<Check size={14} />} label="Selecionar" onClick={() => void handleContextAction('select', contextMenu.message)} />
          <ContextMenuItem icon={<Info size={14} />} label="Detalhes" onClick={() => void handleContextAction('details', contextMenu.message)} />
          <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Reagir</div>
          <div className="grid grid-cols-5 gap-1 px-2 pb-2">
            {QUICK_REACTION_EMOJIS.map((emoji) => (
              <button
                key={`ctx_${emoji}`}
                type="button"
                onClick={() => void handleContextAction(`react:${emoji}`, contextMenu.message)}
                className="rounded-md border border-gray-200 bg-gray-50 px-1 py-1 text-base leading-none hover:bg-gray-100"
                title={`Reagir com ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
          {contextMenu.message.senderUserId === currentUserId && contextMenu.message.type === 'text' && !contextMenu.message.deletedAt && (
            <ContextMenuItem icon={<Pencil size={14} />} label="Editar" onClick={() => void handleContextAction('edit', contextMenu.message)} />
          )}
          <ContextMenuItem icon={<Trash2 size={14} />} label="Apagar" danger onClick={() => void handleContextAction('delete', contextMenu.message)} />
        </div>
      )}

      {showForwardModal && forwardMessage && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-white rounded-xl shadow-xl border border-gray-200 max-h-[80vh] overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">Reencaminhar mensagem</h3>
              <button
                onClick={() => {
                  setShowForwardModal(false);
                  setForwardMessage(null);
                }}
                className="px-2 py-1 text-sm border border-gray-200 rounded"
              >
                Fechar
              </button>
            </div>
            <div className="p-4 border-b border-gray-100 text-sm text-gray-700">
              {forwardMessage.body || forwardMessage.fileName || 'Mensagem'}
            </div>
            <div className="max-h-[50vh] overflow-auto">
              {conversations
                .filter((conversation) => conversation.id !== selectedConversationId)
                .map((conversation) => (
                  <button
                    key={conversation.id}
                    onClick={() => void handleForwardToConversation(conversation.id)}
                    className="w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50"
                  >
                    <p className="text-sm font-medium text-gray-900">{conversation.title}</p>
                    <p className="text-xs text-gray-500">{conversation.type === 'group' ? 'Grupo' : 'Direto'}</p>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}

      {showPedidoModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <h3 className="text-base font-semibold text-gray-900">Criar Pedido (Supabase)</h3>
              <button
                onClick={() => {
                  if (pedidoSubmitting) return;
                  setShowPedidoModal(false);
                }}
                className="rounded border border-gray-200 px-2 py-1 text-sm text-gray-700 hover:bg-gray-50"
              >
                Fechar
              </button>
            </div>

            <div className="space-y-3 px-4 py-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                  <div className="font-semibold text-slate-900">Solicitante</div>
                  <div className="mt-0.5">
                    {currentUser?.name || 'Utilizador atual'} {currentUser?.email ? `(${currentUser.email})` : ''}
                  </div>
                </div>
                <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  <div className="font-semibold">Destino</div>
                  <div className="mt-0.5">Gerência (mpr@mpr.pt)</div>
                  <div className="mt-1 text-[11px] text-blue-700">Estado inicial: PENDENTE</div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block text-xs text-gray-600">
                  Data início
                  <input
                    type="date"
                    value={pedidoForm.dataInicio}
                    onChange={(event) => setPedidoForm((prev) => ({ ...prev, dataInicio: event.target.value }))}
                    className="mt-1 w-full rounded border border-gray-200 px-2 py-2 text-sm"
                  />
                </label>

                <label className="block text-xs text-gray-600">
                  Data fim
                  <input
                    type="date"
                    value={pedidoForm.dataFim}
                    onChange={(event) => setPedidoForm((prev) => ({ ...prev, dataFim: event.target.value }))}
                    className="mt-1 w-full rounded border border-gray-200 px-2 py-2 text-sm"
                  />
                </label>
              </div>

              <label className="block text-xs text-gray-600">
                Tipo
                <select
                  value={pedidoForm.tipo}
                  onChange={(event) => setPedidoForm((prev) => ({ ...prev, tipo: event.target.value }))}
                  className="mt-1 w-full rounded border border-gray-200 px-2 py-2 text-sm"
                >
                  {PEDIDO_TIPOS.map((tipo) => (
                    <option key={tipo} value={tipo}>
                      {tipo}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-xs text-gray-600">
                Descrição
                <textarea
                  rows={5}
                  value={pedidoForm.descricao}
                  onChange={(event) => setPedidoForm((prev) => ({ ...prev, descricao: event.target.value }))}
                  placeholder="Detalhes do pedido"
                  className="mt-1 w-full resize-y rounded border border-gray-200 px-2 py-2 text-sm"
                />
              </label>

              {pedidoError && (
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {pedidoError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-4 py-3">
              <button
                onClick={() => setShowPedidoModal(false)}
                disabled={pedidoSubmitting}
                className="rounded border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={() => void submitPedido()}
                disabled={pedidoSubmitting}
                className="rounded bg-whatsapp-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-whatsapp-600 disabled:opacity-60"
              >
                {pedidoSubmitting ? 'A criar...' : 'Criar Pedido'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const ContextMenuItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}> = ({ icon, label, onClick, danger }) => (
  <button
    onClick={onClick}
    className={`w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-gray-50 ${danger ? 'text-red-600' : 'text-gray-700'}`}
  >
    {icon}
    <span>{label}</span>
  </button>
);

function formatTimeLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const deltaDays = Math.round((today - dayStart) / (1000 * 60 * 60 * 24));

  if (deltaDays === 0) return 'Hoje';
  if (deltaDays === 1) return 'Ontem';

  return date.toLocaleDateString('pt-PT', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function formatInternalTaskStatus(value: string): string {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'Pendente';
  if (['done', 'realizada', 'resolvida', 'closed', 'concluida', 'concluído'].includes(normalized)) return 'Concluída';
  if (['in_progress', 'em progresso', 'ongoing'].includes(normalized)) return 'Em progresso';
  if (['open', 'aberta', 'aberto', 'pendente'].includes(normalized)) return 'Pendente';
  return String(value || '').trim();
}

function normalizeInternalTaskStatus(value: string): 'pending' | 'in_progress' | 'done' {
  const normalized = String(value || '').trim().toLowerCase();
  if (['done', 'realizada', 'resolvida', 'closed', 'concluida', 'concluído'].includes(normalized)) return 'done';
  if (['in_progress', 'em progresso', 'ongoing'].includes(normalized)) return 'in_progress';
  return 'pending';
}

function getInternalTaskStatusBadgeClass(value: string): string {
  const status = normalizeInternalTaskStatus(value);
  if (status === 'done') return 'border-emerald-200 bg-emerald-100 text-emerald-800';
  if (status === 'in_progress') return 'border-sky-200 bg-sky-100 text-sky-800';
  return 'border-orange-200 bg-orange-100 text-orange-800';
}

function getInternalTaskCardTone(taskId: string, statusValue: string): string {
  const status = normalizeInternalTaskStatus(statusValue);
  if (status === 'done') return 'border-emerald-200 bg-emerald-50 hover:bg-emerald-100';
  if (status === 'in_progress') return 'border-sky-200 bg-sky-50 hover:bg-sky-100';

  const tones = [
    'border-amber-200 bg-amber-50 hover:bg-amber-100',
    'border-violet-200 bg-violet-50 hover:bg-violet-100',
    'border-rose-200 bg-rose-50 hover:bg-rose-100',
    'border-cyan-200 bg-cyan-50 hover:bg-cyan-100',
    'border-lime-200 bg-lime-50 hover:bg-lime-100',
  ];
  const safeId = String(taskId || '');
  const index = safeId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % tones.length;
  return tones[index];
}

function formatTaskDate(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '--';
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return raw;
  return date.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatPontoDateTime(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) return '--';
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return raw;
  return date.toLocaleString('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function resolveAvatarUrl(name: string, avatarUrl: string, size = 80): string {
  const rawAvatar = String(avatarUrl || '').trim();
  if (rawAvatar) {
    if (
      rawAvatar.startsWith('http://') ||
      rawAvatar.startsWith('https://') ||
      rawAvatar.startsWith('data:') ||
      rawAvatar.startsWith('blob:') ||
      rawAvatar.startsWith('/')
    ) {
      return rawAvatar;
    }
    return `/${rawAvatar.replace(/^\.?\//, '')}`;
  }

  const safeName = encodeURIComponent(String(name || 'Funcionário').trim() || 'Funcionário');
  const avatarSize = Number.isFinite(Number(size)) ? Math.max(32, Math.min(256, Number(size))) : 80;
  return `https://ui-avatars.com/api/?name=${safeName}&size=${avatarSize}&background=16a34a&color=ffffff`;
}

function getInternalReadReceipt(readByCount: number, totalRecipients: number): { symbol: string; label: string; isFullyRead: boolean } {
  const safeTotal = Math.max(0, Number(totalRecipients || 0));
  const safeRead = Math.max(0, Math.min(safeTotal, Number(readByCount || 0)));
  if (safeTotal <= 0) {
    return { symbol: '✓', label: '', isFullyRead: false };
  }
  if (safeRead >= safeTotal) {
    return { symbol: '✓✓', label: safeTotal > 1 ? `${safeRead}/${safeTotal}` : 'Lida', isFullyRead: true };
  }
  if (safeRead > 0) {
    return { symbol: '✓✓', label: safeTotal > 1 ? `${safeRead}/${safeTotal}` : '', isFullyRead: false };
  }
  return { symbol: '✓', label: '', isFullyRead: false };
}

function parseDateToMs(value: string): number {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function buildQuotedMessagePreview(message: InternalMessageRow | null): string {
  if (!message) return 'Mensagem original indisponível.';
  if (message.deletedAt) return 'Mensagem apagada.';

  const compactBody = String(message.body || '').replace(/\s+/g, ' ').trim();
  if (message.type === 'image') {
    if (compactBody) return `Imagem: ${compactBody}`;
    if (message.fileName) return `Imagem: ${message.fileName}`;
    return 'Imagem';
  }

  if (message.type === 'document') {
    if (message.fileName) return `Documento: ${message.fileName}`;
    if (compactBody) return `Documento: ${compactBody}`;
    return 'Documento';
  }

  if (compactBody) return compactBody;
  if (message.fileName) return message.fileName;
  return 'Mensagem sem texto.';
}

function buildReadReceiptTitle(readByNames: string[], readByCount: number, totalRecipients: number): string {
  const safeTotal = Math.max(0, Number(totalRecipients || 0));
  const safeRead = Math.max(0, Math.min(safeTotal, Number(readByCount || 0)));
  if (safeTotal <= 0) return 'Mensagem enviada.';
  if (safeRead === 0) return 'Enviada, ainda não lida.';
  if (safeRead >= safeTotal) {
    if (safeTotal === 1) {
      const first = Array.isArray(readByNames) ? readByNames.find(Boolean) : '';
      return first ? `Lida por ${first}.` : 'Lida.';
    }
    return `Lida por ${safeRead} de ${safeTotal} destinatários.`;
  }
  return `Lida por ${safeRead} de ${safeTotal} destinatários.`;
}

function buildErrorSuggestionPtPt(errorMessage: string): string | null {
  const message = String(errorMessage || '').trim();
  if (!message) return null;
  const normalized = message.toLowerCase();

  if (normalized.includes('obrigatóri') || normalized.includes('obrigatorio') || normalized.includes('mensagem vazia')) {
    return 'Preencha os campos em falta e confirme que a mensagem não está vazia antes de enviar.';
  }
  if (normalized.includes('sem acesso') || normalized.includes('403') || normalized.includes('permiss')) {
    return 'Verifique se está na conversa certa e se a sua sessão/utilizador tem permissões para esta ação.';
  }
  if (normalized.includes('não encontrada') || normalized.includes('nao encontrada') || normalized.includes('404')) {
    return 'Atualize a página e volte a abrir a conversa; o item pode ter sido removido ou movido.';
  }
  if (normalized.includes('excede o limite') || normalized.includes('20mb') || normalized.includes('413')) {
    return 'Reduza o tamanho do ficheiro (compressão/exportação) e tente novamente.';
  }
  if (normalized.includes('timeout') || normalized.includes('demorou demasiado') || normalized.includes('abort')) {
    return 'Tente novamente dentro de alguns segundos; se continuar, valide a ligação de rede e o estado do servidor.';
  }
  if (
    normalized.includes('network') ||
    normalized.includes('fetch failed') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('falha de rede')
  ) {
    return 'Confirme a ligação à internet/VPN e se o servidor local está ativo.';
  }
  if (normalized.includes('ficheiro') || normalized.includes('upload') || normalized.includes('media')) {
    return 'Valide o tipo e tamanho do ficheiro e repita o envio.';
  }

  return 'Atualize a conversa e tente novamente; se o problema persistir, partilhe este erro com a equipa técnica.';
}

function formatPresenceLabel(presence: InternalPresenceRow | null): string {
  if (presence?.isOnline) return 'Online';

  const lastSeen = String(presence?.lastSeenAt || '').trim();
  if (!lastSeen) return 'Offline';

  const lastSeenDate = new Date(lastSeen);
  if (!Number.isFinite(lastSeenDate.getTime())) return 'Offline';

  const diffMs = Date.now() - lastSeenDate.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return 'Visto agora';
  if (diffMinutes < 60) return `Visto há ${diffMinutes} min`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `Visto há ${diffHours} h`;

  return `Visto ${lastSeenDate.toLocaleDateString('pt-PT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })}`;
}

export default InternalChat;
