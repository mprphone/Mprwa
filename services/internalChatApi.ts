export type InternalConversationRow = {
  id: string;
  type: 'direct' | 'group' | string;
  title: string;
  lastMessageAt: string;
  lastMessageBody: string;
  lastSenderUserId: string | null;
  unreadCount: number;
  otherUserId: string | null;
  otherUserName: string | null;
  otherUserEmail: string | null;
  otherUserAvatar: string;
  memberCount: number;
};

export type InternalMessageRow = {
  id: number;
  conversationId: string;
  senderUserId: string;
  senderName: string;
  senderAvatar: string;
  body: string;
  type: string;
  replyToMessageId: number | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  mediaPath?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  mediaUrl?: string | null;
  readByCount?: number;
  totalRecipients?: number;
  readByNames?: string[];
  reactions?: InternalMessageReactionRow[];
};

export type InternalMessageReactionRow = {
  emoji: string;
  count: number;
  userIds: string[];
  userNames: string[];
};

export type InternalConversationMember = {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string;
  joinedAt: string | null;
};

export type InternalUserTaskRow = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string;
  notes: string;
  conversationId: string;
  customerId: string;
  customerName: string;
};

export type InternalPresenceRow = {
  userId: string;
  name: string;
  lastSeenAt: string | null;
  isOnline: boolean;
};

export type InternalPontoRow = {
  id: string | null;
  funcionarioId: string;
  tipo: 'ENTRADA' | 'SAIDA';
  origem: string;
  momento: string;
};

export type InternalHistorySyncSummary = {
  skipped?: boolean;
  reason?: string;
  importedMessages?: number;
  linkedMessages?: number;
  skippedMessages?: number;
  createdConversations?: number;
  createdUsers?: number;
  totalFetched?: number;
  table?: string | null;
  lastCursor?: string;
};

async function safeJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  return payload as T;
}

function parseError(payload: unknown, status: number, fallback: string): string {
  const anyPayload = payload as { error?: unknown };
  if (typeof anyPayload?.error === 'string') return anyPayload.error;
  if (anyPayload?.error) return JSON.stringify(anyPayload.error);
  return `${fallback} (${status}).`;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIndex = result.indexOf(',');
      if (commaIndex < 0) {
        reject(new Error('Falha ao codificar ficheiro.'));
        return;
      }
      resolve(result.slice(commaIndex + 1));
    };
    reader.onerror = () => reject(reader.error || new Error('Falha na leitura do ficheiro.'));
    reader.readAsDataURL(file);
  });
}

export async function fetchInternalConversations(userId: string): Promise<InternalConversationRow[]> {
  const query = new URLSearchParams({ userId: String(userId || '').trim() });
  const response = await fetch(`/api/internal-chat/conversations?${query.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  const payload = await safeJson<{ success?: boolean; data?: InternalConversationRow[]; error?: unknown }>(response);
  if (!response.ok || !payload.success || !Array.isArray(payload.data)) {
    if (!response.ok) {
      throw new Error(parseError(payload, response.status, 'Falha ao carregar conversas internas'));
    }
    return [];
  }
  return payload.data;
}

export async function fetchInternalPresence(params: {
  userId: string;
  userIds?: string[];
  windowSeconds?: number;
  touch?: boolean;
}): Promise<InternalPresenceRow[]> {
  const query = new URLSearchParams({ userId: String(params.userId || '').trim() });
  const userIds = Array.isArray(params.userIds)
    ? Array.from(new Set(params.userIds.map((item) => String(item || '').trim()).filter(Boolean)))
    : [];
  if (userIds.length > 0) {
    query.set('userIds', userIds.join(','));
  }
  if (Number.isFinite(Number(params.windowSeconds || 0)) && Number(params.windowSeconds || 0) > 0) {
    query.set('windowSeconds', String(Number(params.windowSeconds)));
  }
  if (typeof params.touch === 'boolean') {
    query.set('touch', params.touch ? '1' : '0');
  }

  const response = await fetch(`/api/internal-chat/presence?${query.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  const payload = await safeJson<{ success?: boolean; data?: InternalPresenceRow[]; error?: unknown }>(response);
  if (!response.ok || !payload.success || !Array.isArray(payload.data)) {
    if (!response.ok) {
      throw new Error(parseError(payload, response.status, 'Falha ao carregar presença'));
    }
    return [];
  }
  return payload.data;
}

export async function ensureDirectInternalConversation(userId: string, targetUserId: string): Promise<InternalConversationRow> {
  const response = await fetch('/api/internal-chat/conversations/direct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, targetUserId }),
  });

  const payload = await safeJson<{
    success?: boolean;
    conversation?: Partial<InternalConversationRow>;
    error?: unknown;
  }>(response);

  if (!response.ok || !payload.success || !payload.conversation?.id) {
    throw new Error(parseError(payload, response.status, 'Falha ao abrir conversa interna'));
  }

  return {
    id: String(payload.conversation.id || '').trim(),
    type: String(payload.conversation.type || 'direct').trim(),
    title: String(payload.conversation.title || 'Conversa interna').trim(),
    lastMessageAt: String(payload.conversation.lastMessageAt || '').trim(),
    lastMessageBody: '',
    lastSenderUserId: null,
    unreadCount: 0,
    otherUserId: null,
    otherUserName: null,
    otherUserEmail: null,
    otherUserAvatar: '',
    memberCount: 2,
  };
}

export async function createInternalGroupConversation(input: {
  userId: string;
  title: string;
  memberUserIds: string[];
}): Promise<InternalConversationRow> {
  const response = await fetch('/api/internal-chat/conversations/group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const payload = await safeJson<{
    success?: boolean;
    conversation?: Partial<InternalConversationRow>;
    error?: unknown;
  }>(response);

  if (!response.ok || !payload.success || !payload.conversation?.id) {
    throw new Error(parseError(payload, response.status, 'Falha ao criar grupo interno'));
  }

  return {
    id: String(payload.conversation.id || '').trim(),
    type: String(payload.conversation.type || 'group').trim(),
    title: String(payload.conversation.title || 'Grupo interno').trim(),
    lastMessageAt: String(payload.conversation.lastMessageAt || '').trim(),
    lastMessageBody: '',
    lastSenderUserId: null,
    unreadCount: 0,
    otherUserId: null,
    otherUserName: null,
    otherUserEmail: null,
    otherUserAvatar: '',
    memberCount: Math.max(2, (input.memberUserIds || []).length + 1),
  };
}

export async function fetchInternalConversationMembers(params: {
  conversationId: string;
  userId: string;
}): Promise<InternalConversationMember[]> {
  const query = new URLSearchParams({ userId: String(params.userId || '').trim() });
  const response = await fetch(
    `/api/internal-chat/conversations/${encodeURIComponent(params.conversationId)}/members?${query.toString()}`,
    { headers: { Accept: 'application/json' } }
  );
  const payload = await safeJson<{ success?: boolean; data?: InternalConversationMember[]; error?: unknown }>(response);
  if (!response.ok || !payload.success || !Array.isArray(payload.data)) {
    if (!response.ok) {
      throw new Error(parseError(payload, response.status, 'Falha ao carregar membros do grupo'));
    }
    return [];
  }
  return payload.data;
}

export async function addInternalConversationMembers(input: {
  conversationId: string;
  userId: string;
  memberUserIds: string[];
}): Promise<number> {
  const response = await fetch(`/api/internal-chat/conversations/${encodeURIComponent(input.conversationId)}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: input.userId, memberUserIds: input.memberUserIds }),
  });

  const payload = await safeJson<{ success?: boolean; addedCount?: number; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao adicionar membros'));
  }
  return Number(payload.addedCount || 0);
}

export async function deleteInternalConversation(input: {
  conversationId: string;
  userId: string;
  deleteOrphanPlaceholderUsers?: boolean;
}): Promise<{ deletedConversationId: string; removedPlaceholderUsers: number; hiddenLocalOnly?: boolean }> {
  const response = await fetch(`/api/internal-chat/conversations/${encodeURIComponent(input.conversationId)}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: input.userId,
      deleteOrphanPlaceholderUsers: !!input.deleteOrphanPlaceholderUsers,
    }),
  });

  const payload = await safeJson<{
    success?: boolean;
    deletedConversationId?: string;
    removedPlaceholderUsers?: number;
    error?: unknown;
  }>(response);
  if (!response.ok || !payload.success || !payload.deletedConversationId) {
    if (response.status === 404) {
      // Compatibilidade com backend antigo sem endpoint dedicado.
      try {
        const legacyMessages = await fetchInternalMessages({
          conversationId: input.conversationId,
          userId: input.userId,
          limit: 500,
        });
        for (const message of legacyMessages) {
          if (!message?.id || message.deletedAt) continue;
          await deleteInternalMessage({
            messageId: Number(message.id),
            userId: input.userId,
          }).catch(() => null);
        }
        await markInternalConversationAsRead(input.conversationId, input.userId).catch(() => null);
        return {
          deletedConversationId: String(input.conversationId || '').trim(),
          removedPlaceholderUsers: 0,
          hiddenLocalOnly: true,
        };
      } catch (_) {
        // se também falhar, continua erro normal
      }
    }
    throw new Error(parseError(payload, response.status, 'Falha ao eliminar conversa'));
  }
  return {
    deletedConversationId: String(payload.deletedConversationId || '').trim(),
    removedPlaceholderUsers: Number(payload.removedPlaceholderUsers || 0),
    hiddenLocalOnly: false,
  };
}

export async function fetchInternalMessages(params: {
  conversationId: string;
  userId: string;
  limit?: number;
}): Promise<InternalMessageRow[]> {
  const query = new URLSearchParams({
    conversationId: String(params.conversationId || '').trim(),
    userId: String(params.userId || '').trim(),
    limit: String(params.limit || 200),
  });

  const response = await fetch(`/api/internal-chat/messages?${query.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  const payload = await safeJson<{ success?: boolean; data?: InternalMessageRow[]; error?: unknown }>(response);
  if (!response.ok || !payload.success || !Array.isArray(payload.data)) {
    if (!response.ok) {
      throw new Error(parseError(payload, response.status, 'Falha ao carregar mensagens internas'));
    }
    return [];
  }
  return payload.data;
}

export async function sendInternalMessage(input: {
  conversationId: string;
  userId: string;
  body: string;
  type?: 'text' | 'image' | 'document';
  replyToMessageId?: number | null;
  mediaPath?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
}): Promise<InternalMessageRow> {
  const response = await fetch('/api/internal-chat/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const payload = await safeJson<{ success?: boolean; message?: InternalMessageRow; error?: unknown }>(response);
  if (!response.ok || !payload.success || !payload.message?.id) {
    throw new Error(parseError(payload, response.status, 'Falha ao enviar mensagem interna'));
  }
  return payload.message;
}

export async function uploadInternalFileMessage(input: {
  conversationId: string;
  userId: string;
  file: File;
  caption?: string;
  replyToMessageId?: number | null;
}): Promise<InternalMessageRow> {
  const dataBase64 = await fileToBase64(input.file);

  const response = await fetch('/api/internal-chat/messages/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: input.conversationId,
      userId: input.userId,
      fileName: input.file.name,
      mimeType: input.file.type || 'application/octet-stream',
      dataBase64,
      caption: input.caption || '',
      replyToMessageId: input.replyToMessageId || null,
    }),
  });

  const payload = await safeJson<{ success?: boolean; message?: InternalMessageRow; error?: unknown }>(response);
  if (!response.ok || !payload.success || !payload.message?.id) {
    throw new Error(parseError(payload, response.status, 'Falha ao enviar ficheiro interno'));
  }
  return payload.message;
}

export async function editInternalMessage(input: {
  messageId: number;
  userId: string;
  body: string;
}): Promise<void> {
  const response = await fetch(`/api/internal-chat/messages/${encodeURIComponent(String(input.messageId))}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: input.userId, body: input.body }),
  });

  const payload = await safeJson<{ success?: boolean; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao editar mensagem interna'));
  }
}

export async function deleteInternalMessage(input: {
  messageId: number;
  userId: string;
}): Promise<void> {
  const response = await fetch(`/api/internal-chat/messages/${encodeURIComponent(String(input.messageId))}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: input.userId }),
  });

  const payload = await safeJson<{ success?: boolean; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao apagar mensagem interna'));
  }
}

export async function markInternalConversationAsRead(conversationId: string, userId: string): Promise<void> {
  const response = await fetch(`/api/internal-chat/conversations/${encodeURIComponent(conversationId)}/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });

  const payload = await safeJson<{ success?: boolean; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao marcar conversa interna como lida'));
  }
}

export async function toggleInternalMessageReaction(input: {
  messageId: number;
  userId: string;
  emoji: string;
}): Promise<{ reacted: boolean; messageId: number; emoji: string }> {
  const response = await fetch(`/api/internal-chat/messages/${encodeURIComponent(String(input.messageId))}/reactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: input.userId, emoji: input.emoji }),
  });

  const payload = await safeJson<{
    success?: boolean;
    reacted?: boolean;
    messageId?: number;
    emoji?: string;
    error?: unknown;
  }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao reagir à mensagem interna'));
  }
  return {
    reacted: !!payload.reacted,
    messageId: Number(payload.messageId || 0),
    emoji: String(payload.emoji || '').trim(),
  };
}

export async function fetchInternalUserOpenTasks(userId: string, viewerUserId?: string): Promise<InternalUserTaskRow[]> {
  const query = new URLSearchParams({ limit: '80' });
  const viewer = String(viewerUserId || '').trim();
  if (viewer) {
    query.set('viewerUserId', viewer);
  }
  const response = await fetch(
    `/api/internal-chat/users/${encodeURIComponent(String(userId || '').trim())}/open-tasks?${query.toString()}`,
    {
      headers: { Accept: 'application/json' },
    }
  );

  const payload = await safeJson<{ success?: boolean; data?: InternalUserTaskRow[]; error?: unknown }>(response);
  if (!response.ok || !payload.success || !Array.isArray(payload.data)) {
    if (!response.ok) {
      throw new Error(parseError(payload, response.status, 'Falha ao carregar tarefas do funcionário'));
    }
    return [];
  }
  return payload.data;
}

export async function createInternalPedidoSupabase(input: {
  actorUserId: string;
  actorName?: string;
  actorEmail?: string;
  responsibleUserId: string;
  tipo: string;
  descricao?: string;
  dataInicio?: string;
  dataFim?: string;
  status?: 'PENDENTE' | 'APROVADO' | 'REJEITADO' | string;
}): Promise<{ table?: string; pedido?: Record<string, unknown> | null }> {
  const response = await fetch('/api/internal-chat/pedidos/supabase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const payload = await safeJson<{
    success?: boolean;
    table?: string;
    pedido?: Record<string, unknown> | null;
    error?: unknown;
  }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao criar pedido no Supabase'));
  }
  return {
    table: payload.table,
    pedido: payload.pedido || null,
  };
}

export async function createInternalPontoSupabase(input: {
  actorUserId: string;
  pin: string;
  tipo: 'ENTRADA' | 'SAIDA';
  origem?: string;
  momento?: string;
}): Promise<{ table?: string; registo?: InternalPontoRow | null }> {
  const response = await fetch('/api/internal-chat/ponto/supabase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const payload = await safeJson<{
    success?: boolean;
    table?: string;
    registo?: InternalPontoRow | null;
    error?: unknown;
  }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao registar ponto no Supabase'));
  }
  return {
    table: payload.table,
    registo: payload.registo || null,
  };
}

export async function fetchInternalPontoRecentSupabase(input: {
  actorUserId: string;
  limit?: number;
}): Promise<InternalPontoRow[]> {
  const actorUserId = String(input.actorUserId || '').trim();
  const limit = Math.min(10, Math.max(1, Number(input.limit || 2) || 2));
  const query = new URLSearchParams({
    actorUserId,
    limit: String(limit),
  });

  const response = await fetch(`/api/internal-chat/ponto/supabase/recent?${query.toString()}`, {
    headers: { Accept: 'application/json' },
  });

  const payload = await safeJson<{
    success?: boolean;
    data?: InternalPontoRow[];
    error?: unknown;
  }>(response);
  if (!response.ok || !payload.success || !Array.isArray(payload.data)) {
    if (!response.ok) {
      throw new Error(parseError(payload, response.status, 'Falha ao carregar registos de ponto'));
    }
    return [];
  }
  return payload.data;
}

export async function importInternalChatHistorySupabase(input: {
  actorUserId: string;
  forceFull?: boolean;
  maxRows?: number;
}): Promise<InternalHistorySyncSummary> {
  const response = await fetch('/api/internal-chat/history/supabase/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      actorUserId: String(input.actorUserId || '').trim(),
      forceFull: !!input.forceFull,
      maxRows: Number.isFinite(Number(input.maxRows || 0)) ? Number(input.maxRows) : undefined,
    }),
  });

  const payload = await safeJson<{
    success?: boolean;
    skipped?: boolean;
    reason?: string;
    importedMessages?: number;
    linkedMessages?: number;
    skippedMessages?: number;
    createdConversations?: number;
    createdUsers?: number;
    totalFetched?: number;
    table?: string | null;
    lastCursor?: string;
    error?: unknown;
  }>(response);

  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao importar histórico do Supabase'));
  }

  return {
    skipped: !!payload.skipped,
    reason: payload.reason,
    importedMessages: Number(payload.importedMessages || 0),
    linkedMessages: Number(payload.linkedMessages || 0),
    skippedMessages: Number(payload.skippedMessages || 0),
    createdConversations: Number(payload.createdConversations || 0),
    createdUsers: Number(payload.createdUsers || 0),
    totalFetched: Number(payload.totalFetched || 0),
    table: payload.table || null,
    lastCursor: String(payload.lastCursor || '').trim(),
  };
}
