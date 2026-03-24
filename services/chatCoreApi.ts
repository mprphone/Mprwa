export type ChatContactRow = {
  from_number: string;
  customer_contact_name?: string;
  customer_name?: string;
  customer_company?: string;
  last_msg_time: string;
  last_msg_preview?: string;
  last_inbound_preview?: string;
  conversation_id?: string;
  customer_id?: string;
  whatsapp_account_id?: string | null;
  owner_id?: string | null;
  status?: string;
  unread_count?: number;
  channel?: 'whatsapp' | 'telegram' | string;
  is_blocked?: number | boolean;
  blocked_id?: number | null;
  blocked_reason?: string | null;
  blocked_at?: string | null;
  telegram_verified?: number | boolean;
  telegram_checked_at?: string | null;
};

export type BlockedContactRow = {
  id: number;
  channel: 'whatsapp' | 'telegram' | string;
  contactKey: string;
  reason?: string | null;
  createdBy?: string | null;
  isActive?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ChatMessageRow = {
  id: number;
  wa_id?: string | null;
  from_number: string;
  body: string;
  direction: string;
  status: string;
  timestamp: string;
  media_kind?: string | null;
  media_path?: string | null;
  media_mime_type?: string | null;
  media_file_name?: string | null;
  media_size?: number | null;
  media_provider?: string | null;
  media_remote_id?: string | null;
  media_remote_url?: string | null;
  media_meta_json?: string | null;
};

export type TelegramUserAuthStatus = {
  configured: boolean;
  hasSession: boolean;
  authorized: boolean;
  pendingAuth?: {
    phoneNumber?: string;
    requiresPassword?: boolean;
    createdAt?: string;
  } | null;
  account?: {
    userId?: string | null;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
    displayName?: string | null;
  } | null;
  authError?: string;
};

export type TelegramContactStatusRow = {
  customerId?: string | null;
  phoneE164: string;
  phoneDigits: string;
  hasTelegram: boolean;
  telegramUserId?: string | null;
  telegramUsername?: string | null;
  telegramFirstName?: string | null;
  telegramLastName?: string | null;
  telegramPhone?: string | null;
  source?: string;
  checkedAt?: string | null;
};

export type WhatsAppProviderHealth = {
  provider: 'cloud' | 'baileys' | string;
  configured: boolean;
  accountId?: string | null;
  accounts?: WhatsAppAccountHealth[];
  status: string;
  connected: boolean;
  connecting?: boolean;
  qrAvailable?: boolean;
  qrUpdatedAt?: string | null;
  lastError?: string | null;
  phoneNumberId?: string | null;
  meId?: string | null;
  meName?: string | null;
};

export type WhatsAppAccountHealth = {
  accountId: string;
  label?: string;
  isDefault?: boolean;
  provider?: string;
  configured?: boolean;
  status?: string;
  connected?: boolean;
  connecting?: boolean;
  qrAvailable?: boolean;
  qrUpdatedAt?: string | null;
  lastError?: string | null;
  meId?: string | null;
  meName?: string | null;
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

export async function fetchChatContacts(): Promise<ChatContactRow[]> {
  const response = await fetch('/api/chat/contacts', { headers: { Accept: 'application/json' } });
  if (!response.ok) return [];
  const payload = await safeJson<{ data?: ChatContactRow[] }>(response);
  return Array.isArray(payload.data) ? payload.data : [];
}

export async function fetchBlockedChatContacts(channel?: string): Promise<BlockedContactRow[]> {
  const query = new URLSearchParams();
  const normalizedChannel = String(channel || '').trim();
  if (normalizedChannel) query.set('channel', normalizedChannel);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  const response = await fetch(`/api/chat/contacts/blocked${suffix}`, {
    headers: { Accept: 'application/json' },
  });
  const payload = await safeJson<{ success?: boolean; data?: BlockedContactRow[] }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao listar contactos bloqueados'));
  }
  return Array.isArray(payload.data) ? payload.data : [];
}

export async function blockChatContact(input: {
  channel?: string;
  contactKey: string;
  reason?: string;
  actorUserId?: string | null;
}): Promise<BlockedContactRow | null> {
  const response = await fetch('/api/chat/contacts/block', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: String(input.channel || '').trim() || undefined,
      contactKey: String(input.contactKey || '').trim(),
      reason: String(input.reason || '').trim() || undefined,
      actorUserId: String(input.actorUserId || '').trim() || undefined,
    }),
  });

  const payload = await safeJson<{ success?: boolean; data?: BlockedContactRow; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao bloquear contacto'));
  }
  return payload.data || null;
}

export async function unblockChatContact(input: {
  id?: number | null;
  channel?: string;
  contactKey?: string;
}): Promise<boolean> {
  const response = await fetch('/api/chat/contacts/unblock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: typeof input.id === 'number' ? input.id : undefined,
      channel: String(input.channel || '').trim() || undefined,
      contactKey: String(input.contactKey || '').trim() || undefined,
    }),
  });

  const payload = await safeJson<{ success?: boolean; removed?: boolean; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao desbloquear contacto'));
  }
  return payload.removed === true;
}

export async function fetchChatConversationsLocal<T>(): Promise<T[] | null> {
  const response = await fetch('/api/chat/conversations/local', { headers: { Accept: 'application/json' } });
  const payload = await safeJson<{ success?: boolean; data?: T[] }>(response);
  if (!response.ok || !payload.success || !Array.isArray(payload.data)) return null;
  return payload.data;
}

export async function syncChatConversation<T>(conversation: T, actorUserId: string | null): Promise<T | null> {
  const response = await fetch('/api/chat/conversations/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(conversation as Record<string, unknown>), actorUserId }),
  });

  const payload = await safeJson<{ success?: boolean; conversation?: T; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao guardar conversa'));
  }

  return payload.conversation || null;
}

export async function fetchChatMessages(phoneDigits: string, accountId?: string | null): Promise<ChatMessageRow[] | null> {
  const query = new URLSearchParams({ phone: phoneDigits });
  const normalizedAccount = String(accountId || '').trim();
  if (normalizedAccount) {
    query.set('accountId', normalizedAccount);
  }
  const response = await fetch(`/api/chat/messages?${query.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return null;
  const payload = await safeJson<{ data?: ChatMessageRow[] }>(response);
  return Array.isArray(payload.data) ? payload.data : [];
}

export async function markChatConversationRead(conversationId: string): Promise<void> {
  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  const payload = await safeJson<{ success?: boolean; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao marcar conversa como lida'));
  }
}

export async function deleteChatConversation(
  conversationId: string,
  options?: { deleteMessages?: boolean; actorUserId?: string | null }
): Promise<void> {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId) {
    throw new Error('Conversa inválida para eliminar.');
  }

  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(normalizedConversationId)}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deleteMessages: options?.deleteMessages !== false,
      actorUserId: String(options?.actorUserId || '').trim() || undefined,
    }),
  });

  const payload = await safeJson<{ success?: boolean; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao eliminar conversa'));
  }
}

export async function sendChatMessage(input: {
  conversationId?: string;
  to: string;
  message: string;
  type: 'text' | 'template' | 'image' | 'document';
  templateId?: string;
  variables?: Record<string, string>;
  mediaPath?: string;
  mediaMimeType?: string;
  mediaFileName?: string;
  accountId?: string | null;
  createdBy?: string | null;
}): Promise<{ messageId?: string | null }> {
  const response = await fetch('/api/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const payload = await safeJson<{ success?: boolean; messageId?: string | null; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha no envio'));
  }

  return { messageId: payload.messageId || null };
}

export async function editChatMessage(messageId: string, body: string, actorUserId?: string | null): Promise<void> {
  const response = await fetch(`/api/chat/messages/${encodeURIComponent(messageId)}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, actorUserId: actorUserId || null }),
  });

  const payload = await safeJson<{ success?: boolean; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao editar mensagem'));
  }
}

export async function deleteChatMessage(messageId: string, actorUserId?: string | null): Promise<void> {
  const response = await fetch(`/api/chat/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorUserId: actorUserId || null }),
  });

  const payload = await safeJson<{ success?: boolean; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao apagar mensagem'));
  }
}

export async function fetchTelegramUserHealth(): Promise<TelegramUserAuthStatus> {
  const response = await fetch('/api/chat/telegram/user/health', { headers: { Accept: 'application/json' } });
  const payload = await safeJson<{ success?: boolean } & TelegramUserAuthStatus & { error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao obter estado Telegram User API'));
  }
  return {
    configured: !!payload.configured,
    hasSession: !!payload.hasSession,
    authorized: !!payload.authorized,
    pendingAuth: payload.pendingAuth || null,
    account: payload.account || null,
    authError: payload.authError,
  };
}

export async function telegramUserSendCode(phoneNumber: string): Promise<{ alreadyAuthorized?: boolean; isCodeViaApp?: boolean }> {
  const response = await fetch('/api/chat/telegram/user/auth/send-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber }),
  });
  const payload = await safeJson<{ success?: boolean; alreadyAuthorized?: boolean; isCodeViaApp?: boolean; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao pedir código Telegram'));
  }
  return {
    alreadyAuthorized: !!payload.alreadyAuthorized,
    isCodeViaApp: payload.isCodeViaApp === true,
  };
}

export async function telegramUserVerifyCode(phoneNumber: string, code: string): Promise<{ requiresPassword?: boolean; authorized?: boolean }> {
  const response = await fetch('/api/chat/telegram/user/auth/verify-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber, code }),
  });
  const payload = await safeJson<{ success?: boolean; requiresPassword?: boolean; authorized?: boolean; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao validar código Telegram'));
  }
  return {
    requiresPassword: payload.requiresPassword === true,
    authorized: payload.authorized === true,
  };
}

export async function telegramUserVerifyPassword(password: string): Promise<void> {
  const response = await fetch('/api/chat/telegram/user/auth/verify-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const payload = await safeJson<{ success?: boolean; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao validar palavra-passe Telegram'));
  }
}

export async function fetchTelegramContactStatuses(): Promise<{
  auth: TelegramUserAuthStatus;
  data: TelegramContactStatusRow[];
}> {
  const response = await fetch('/api/chat/telegram/user/contacts/status', {
    headers: { Accept: 'application/json' },
  });
  const payload = await safeJson<{
    success?: boolean;
    auth?: TelegramUserAuthStatus;
    data?: TelegramContactStatusRow[];
    error?: unknown;
  }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao obter estados de contacto Telegram'));
  }
  return {
    auth: payload.auth || { configured: false, hasSession: false, authorized: false },
    data: Array.isArray(payload.data) ? payload.data : [],
  };
}

export async function checkTelegramContacts(items: Array<{ customerId?: string; phone: string; label?: string }>): Promise<{
  total: number;
  telegramCount: number;
  results: TelegramContactStatusRow[];
}> {
  const response = await fetch('/api/chat/telegram/user/contacts/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  const payload = await safeJson<{
    success?: boolean;
    total?: number;
    telegramCount?: number;
    results?: TelegramContactStatusRow[];
    error?: unknown;
  }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao verificar contactos Telegram'));
  }
  return {
    total: Number(payload.total || 0),
    telegramCount: Number(payload.telegramCount || 0),
    results: Array.isArray(payload.results) ? payload.results : [],
  };
}

export async function fetchWhatsAppHealth(accountId?: string | null): Promise<WhatsAppProviderHealth> {
  const query = new URLSearchParams();
  const normalizedAccount = String(accountId || '').trim();
  if (normalizedAccount) query.set('accountId', normalizedAccount);
  const url = query.toString() ? `/api/chat/whatsapp/health?${query.toString()}` : '/api/chat/whatsapp/health';
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const payload = await safeJson<{ success?: boolean; error?: unknown } & WhatsAppProviderHealth>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao obter estado WhatsApp'));
  }
  return {
    provider: String(payload.provider || 'cloud'),
    configured: !!payload.configured,
    accountId: String(payload.accountId || '').trim() || null,
    accounts: Array.isArray(payload.accounts) ? payload.accounts : [],
    status: String(payload.status || 'unknown'),
    connected: !!payload.connected,
    connecting: !!payload.connecting,
    qrAvailable: !!payload.qrAvailable,
    qrUpdatedAt: payload.qrUpdatedAt || null,
    lastError: payload.lastError || null,
    phoneNumberId: payload.phoneNumberId || null,
    meId: payload.meId || null,
    meName: payload.meName || null,
  };
}

export async function connectWhatsAppProvider(accountId?: string | null): Promise<WhatsAppProviderHealth> {
  const response = await fetch('/api/chat/whatsapp/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: String(accountId || '').trim() || undefined,
    }),
  });
  const payload = await safeJson<{ success?: boolean; state?: WhatsAppProviderHealth; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao ligar WhatsApp'));
  }
  return payload.state || {
    provider: 'cloud',
    configured: false,
    status: 'unknown',
    connected: false,
  };
}

export async function fetchWhatsAppAccounts(): Promise<WhatsAppAccountHealth[]> {
  const response = await fetch('/api/chat/whatsapp/accounts', { headers: { Accept: 'application/json' } });
  const payload = await safeJson<{ success?: boolean; data?: WhatsAppAccountHealth[]; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao obter contas WhatsApp'));
  }
  return Array.isArray(payload.data) ? payload.data : [];
}

export async function disconnectWhatsAppProvider(options?: { logout?: boolean; clearAuth?: boolean; accountId?: string | null }): Promise<WhatsAppProviderHealth> {
  const response = await fetch('/api/chat/whatsapp/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      logout: options?.logout === true,
      clearAuth: options?.clearAuth === true,
      accountId: String(options?.accountId || '').trim() || undefined,
    }),
  });
  const payload = await safeJson<{ success?: boolean; state?: WhatsAppProviderHealth; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao desligar WhatsApp'));
  }
  return payload.state || {
    provider: 'cloud',
    configured: false,
    status: 'unknown',
    connected: false,
  };
}

export async function fetchWhatsAppQr(accountId?: string | null): Promise<{
  provider: string;
  accountId?: string | null;
  hasQr: boolean;
  qrText: string | null;
  qrUpdatedAt?: string | null;
  status?: string;
  connected?: boolean;
  connecting?: boolean;
}> {
  const query = new URLSearchParams();
  const normalizedAccount = String(accountId || '').trim();
  if (normalizedAccount) query.set('accountId', normalizedAccount);
  const url = query.toString() ? `/api/chat/whatsapp/qr?${query.toString()}` : '/api/chat/whatsapp/qr';
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const payload = await safeJson<{
    success?: boolean;
    provider?: string;
    accountId?: string | null;
    hasQr?: boolean;
    qrText?: string | null;
    qrUpdatedAt?: string | null;
    status?: string;
    connected?: boolean;
    connecting?: boolean;
    error?: unknown;
  }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao obter QR do WhatsApp'));
  }
  return {
    provider: String(payload.provider || 'cloud'),
    accountId: String(payload.accountId || '').trim() || null,
    hasQr: payload.hasQr === true,
    qrText: payload.qrText ? String(payload.qrText) : null,
    qrUpdatedAt: payload.qrUpdatedAt || null,
    status: payload.status ? String(payload.status) : undefined,
    connected: payload.connected === true,
    connecting: payload.connecting === true,
  };
}

export async function setConversationWhatsAppAccount(
  conversationId: string,
  accountId?: string | null
): Promise<{ id: string; whatsappAccountId?: string | null } | null> {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId) return null;
  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(normalizedConversationId)}/whatsapp-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: String(accountId || '').trim() || undefined,
    }),
  });
  const payload = await safeJson<{
    success?: boolean;
    conversation?: { id?: string; whatsappAccountId?: string | null };
    error?: unknown;
  }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao atualizar conta WhatsApp da conversa'));
  }
  if (!payload.conversation?.id) return null;
  return {
    id: String(payload.conversation.id || '').trim(),
    whatsappAccountId: String(payload.conversation.whatsappAccountId || '').trim() || null,
  };
}
