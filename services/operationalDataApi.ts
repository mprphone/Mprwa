import type { AgendaEvent, Call, Task } from '../types';

export interface TaskImportInput {
  force?: boolean;
  actorUserId?: string;
  tasksTable?: string;
  usersTable?: string;
  customersTable?: string;
}

export interface TaskImportSummary {
  sourceTasks?: number;
  imported?: number;
  updated?: number;
  skippedExisting?: number;
  skippedNoTitle?: number;
  skippedNoCustomer?: number;
  failed?: number;
  createdConversations?: number;
  warnings?: string[];
}

export interface TaskImportResult {
  success: boolean;
  summary?: TaskImportSummary;
  error?: string;
}

function payloadError(error: unknown, fallback: string): string {
  if (typeof error === 'string') return error;
  return error ? JSON.stringify(error) : fallback;
}

export async function fetchTasksApi(conversationId?: string, userId?: string): Promise<Task[] | null> {
  const params: Record<string, string> = {};
  if (conversationId) params.conversationId = conversationId;
  if (userId) params.userId = userId;
  const query = Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
  const response = await fetch(`/api/tasks/local${query}`, { headers: { Accept: 'application/json' } });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; data?: Task[] };
  return response.ok && payload.success && Array.isArray(payload.data) ? payload.data : null;
}

export async function importTasksApi(input: TaskImportInput, currentUserId: string): Promise<TaskImportResult> {
  const response = await fetch('/api/tasks/import/supabase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      force: !!input.force,
      actorUserId: input.actorUserId || currentUserId,
      tasksTable: input.tasksTable || '',
      usersTable: input.usersTable || '',
      customersTable: input.customersTable || '',
    }),
  });
  const payload = await response.json().catch(() => ({})) as {
    success?: boolean;
    summary?: TaskImportSummary;
    error?: unknown;
  };
  if (!response.ok || !payload.success) {
    return { success: false, error: payloadError(payload.error, `Falha ao importar tarefas (${response.status}).`) };
  }
  return { success: true, summary: payload.summary || {} };
}

export async function saveTaskApi(task: Task): Promise<Task | null> {
  const response = await fetch('/api/tasks/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; task?: Task; error?: unknown };
  if (!response.ok || !payload.success) {
    throw new Error(payloadError(payload.error, `Falha ao guardar tarefa (${response.status}).`));
  }
  return payload.task || null;
}

export async function deleteTaskApi(taskId: string, actorUserId?: string): Promise<void> {
  const query = new URLSearchParams();
  if (actorUserId) query.set('actorUserId', actorUserId);
  const response = await fetch(
    `/api/tasks/${encodeURIComponent(taskId)}${query.toString() ? `?${query.toString()}` : ''}`,
    { method: 'DELETE', headers: { Accept: 'application/json' } },
  );
  const payload = await response.json().catch(() => ({})) as { success?: boolean; error?: unknown };
  if (!response.ok || !payload.success) {
    throw new Error(payloadError(payload.error, `Falha ao eliminar tarefa (${response.status}).`));
  }
}

export async function fetchCallsApi(customerId?: string): Promise<Call[] | null> {
  const query = customerId ? `?${new URLSearchParams({ customerId }).toString()}` : '';
  const response = await fetch(`/api/calls/local${query}`, { headers: { Accept: 'application/json' } });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; data?: Call[] };
  return response.ok && payload.success && Array.isArray(payload.data) ? payload.data : null;
}

export async function saveCallApi(call: Call): Promise<Call | null> {
  const response = await fetch('/api/calls/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(call),
  });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; call?: Call; error?: unknown };
  if (!response.ok || !payload.success) {
    throw new Error(payloadError(payload.error, `Falha ao guardar chamada (${response.status}).`));
  }
  return payload.call || null;
}

export async function fetchAgendaEventsApi(userId?: string): Promise<AgendaEvent[] | null> {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  const response = await fetch(`/api/agenda/events${query}`, { headers: { Accept: 'application/json' } });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; data?: AgendaEvent[] };
  return response.ok && payload.success && Array.isArray(payload.data) ? payload.data : null;
}

export async function saveAgendaEventApi(event: AgendaEvent): Promise<AgendaEvent> {
  const response = await fetch('/api/agenda/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; data?: AgendaEvent; error?: unknown };
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(payloadError(payload.error, `Falha ao guardar evento (${response.status}).`));
  }
  return payload.data;
}

export async function deleteAgendaEventApi(eventId: string): Promise<void> {
  const response = await fetch(`/api/agenda/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; error?: unknown };
  if (!response.ok || !payload.success) {
    throw new Error(payloadError(payload.error, `Falha ao eliminar evento (${response.status}).`));
  }
}
