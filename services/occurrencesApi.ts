export type OccurrenceType = {
  id: number;
  name: string;
  sourceId?: string | null;
};

export type OccurrenceUser = {
  id: string;
  name: string;
  email: string;
};

export type OccurrenceCustomer = {
  id: string;
  name: string;
  company: string;
  nif?: string | null;
};

export type OccurrenceAttachment = {
  id: string;
  kind: string;
  sourceTable?: string | null;
  fileUrl?: string | null;
  storagePath?: string | null;
  localFilePath?: string | null;
  originalName?: string | null;
  createdAt?: string | null;
  sectionKey?: string | null;
  dossieModel?: string | null;
  dossieItemKey?: string | null;
};

export type OccurrenceRow = {
  id: string;
  sourceId?: string | null;
  customerId: string;
  customerName?: string;
  customerCompany?: string;
  customerNif?: string | null;
  date: string | null;
  typeId?: number | null;
  typeName?: string | null;
  title: string;
  description?: string;
  state: 'ABERTA' | 'ATRASADA' | 'RESOLVIDA' | string;
  dueDate?: string | null;
  responsibleUserId?: string | null;
  responsibleUserIds?: string[];
  responsibleNames?: string | null;
  responsibleUserName?: string | null;
  responsibleUserEmail?: string | null;
  resolution?: string;
  projetoApoioDetalhe?: Record<string, unknown> | null;
  syncOrigin?: string;
  lastSyncedAt?: string | null;
  updatedAt?: string | null;
  attachmentsCount?: number;
  attachments?: OccurrenceAttachment[];
};

export type OccurrenceMetaPayload = {
  types: OccurrenceType[];
  users: OccurrenceUser[];
  customers: OccurrenceCustomer[];
};

function parseError(payload: unknown, status: number, fallback: string): string {
  const data = payload as { error?: unknown };
  if (typeof data?.error === 'string' && data.error.trim()) return data.error;
  if (data?.error) return JSON.stringify(data.error);
  return `${fallback} (${status}).`;
}

async function safeJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  return payload as T;
}

export async function fetchOccurrencesMeta(): Promise<OccurrenceMetaPayload> {
  const response = await fetch('/api/occurrences/meta', { headers: { Accept: 'application/json' } });
  const payload = await safeJson<{ success?: boolean; data?: OccurrenceMetaPayload; error?: unknown }>(response);
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(parseError(payload, response.status, 'Falha ao carregar meta de ocorrências'));
  }
  return payload.data;
}

export async function fetchOccurrences(filters: {
  q?: string;
  state?: string;
  typeId?: string | number;
  responsibleUserId?: string;
  limit?: number;
} = {}): Promise<OccurrenceRow[]> {
  const query = new URLSearchParams();
  if (filters.q) query.set('q', String(filters.q));
  if (filters.state) query.set('state', String(filters.state));
  if (filters.typeId !== undefined && filters.typeId !== null && String(filters.typeId).trim()) {
    query.set('typeId', String(filters.typeId));
  }
  if (filters.responsibleUserId) query.set('responsibleUserId', String(filters.responsibleUserId));
  if (filters.limit) query.set('limit', String(filters.limit));

  const response = await fetch(`/api/occurrences?${query.toString()}`, { headers: { Accept: 'application/json' } });
  const payload = await safeJson<{ success?: boolean; data?: OccurrenceRow[]; error?: unknown }>(response);
  if (!response.ok || !payload.success || !Array.isArray(payload.data)) {
    throw new Error(parseError(payload, response.status, 'Falha ao carregar ocorrências'));
  }
  return payload.data;
}

export async function fetchOccurrenceById(id: string): Promise<OccurrenceRow> {
  const response = await fetch(`/api/occurrences/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
  const payload = await safeJson<{ success?: boolean; data?: OccurrenceRow; error?: unknown }>(response);
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(parseError(payload, response.status, 'Falha ao carregar ocorrência'));
  }
  return payload.data;
}

export async function saveOccurrence(input: {
  id?: string;
  customerId: string;
  date: string;
  dueDate?: string;
  typeId?: number | null;
  typeName?: string;
  title: string;
  description?: string;
  state?: string;
  responsibleUserId?: string;
  responsibleUserIds?: string[];
  resolution?: string;
  projetoApoioDetalhe?: Record<string, unknown> | null;
  actorUserId?: string;
}): Promise<OccurrenceRow> {
  const response = await fetch('/api/occurrences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await safeJson<{ success?: boolean; data?: OccurrenceRow; error?: unknown }>(response);
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(parseError(payload, response.status, 'Falha ao guardar ocorrência'));
  }
  return payload.data;
}

export async function deleteOccurrence(id: string, actorUserId?: string): Promise<void> {
  const query = new URLSearchParams();
  if (actorUserId) query.set('actorUserId', actorUserId);

  const response = await fetch(
    `/api/occurrences/${encodeURIComponent(id)}${query.toString() ? `?${query.toString()}` : ''}`,
    { method: 'DELETE' }
  );
  const payload = await safeJson<{ success?: boolean; error?: unknown }>(response);
  if (!response.ok || !payload.success) {
    throw new Error(parseError(payload, response.status, 'Falha ao apagar ocorrência'));
  }
}

export async function uploadOccurrenceAttachment(input: {
  occurrenceId: string;
  fileName: string;
  mimeType: string;
  dataBase64: string;
  actorUserId?: string;
  caption?: string;
  sectionKey?: string;
  dossieModel?: string;
  dossieItemKey?: string;
}): Promise<OccurrenceRow> {
  const response = await fetch(`/api/occurrences/${encodeURIComponent(input.occurrenceId)}/attachments/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await safeJson<{ success?: boolean; data?: OccurrenceRow; error?: unknown }>(response);
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(parseError(payload, response.status, 'Falha ao enviar anexo da ocorrência'));
  }
  return payload.data;
}

export async function importOccurrencesFromSupabase(actorUserId?: string): Promise<{
  occurrencesTable: string;
  photosTable: string;
  docsTable: string;
  sourceOccurrences: number;
  sourcePhotos: number;
  sourceDocuments: number;
  importedOccurrences: number;
  importedAttachments: number;
  importedAttachmentsToLocal?: number;
  skippedWithoutCustomer: number;
  skippedAttachmentWithoutOccurrence: number;
  skippedAttachmentWithoutFolder?: number;
  failedAttachmentDownloads?: number;
}> {
  const response = await fetch('/api/occurrences/import/supabase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorUserId: actorUserId || '' }),
  });
  const payload = await safeJson<{
    success?: boolean;
    summary?: {
      occurrencesTable: string;
      photosTable: string;
      docsTable: string;
      sourceOccurrences: number;
      sourcePhotos: number;
      sourceDocuments: number;
      importedOccurrences: number;
      importedAttachments: number;
      importedAttachmentsToLocal?: number;
      skippedWithoutCustomer: number;
      skippedAttachmentWithoutOccurrence: number;
      skippedAttachmentWithoutFolder?: number;
      failedAttachmentDownloads?: number;
    };
    error?: unknown;
  }>(response);

  if (!response.ok || !payload.success || !payload.summary) {
    throw new Error(parseError(payload, response.status, 'Falha na importação de ocorrências'));
  }
  return payload.summary;
}

export type DossieItemTemplate = {
  id?: string | null;
  key: string;
  principal: string;
  nivel2: string;
  designacao: string;
  model?: string | null;
  source?: 'builtin' | 'custom' | string;
};

export async function fetchDossieItems(model?: string): Promise<DossieItemTemplate[]> {
  const query = new URLSearchParams();
  if (model) query.set('model', String(model));
  const response = await fetch(`/api/occurrences/dossie-items${query.toString() ? `?${query.toString()}` : ''}`, {
    headers: { Accept: 'application/json' },
  });
  const payload = await safeJson<{ success?: boolean; data?: DossieItemTemplate[]; error?: unknown }>(response);
  if (!response.ok || !payload.success || !Array.isArray(payload.data)) {
    throw new Error(parseError(payload, response.status, 'Falha ao carregar separadores do dossiê'));
  }
  return payload.data;
}

export async function createDossieItem(input: {
  principal: string;
  nivel2: string;
  designacao?: string;
  model?: string;
  key?: string;
  actorUserId?: string;
}): Promise<DossieItemTemplate> {
  const response = await fetch('/api/occurrences/dossie-items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await safeJson<{ success?: boolean; data?: DossieItemTemplate; error?: unknown }>(response);
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(parseError(payload, response.status, 'Falha ao criar separador do dossiê'));
  }
  return payload.data;
}

export async function linkOccurrenceAttachmentToDossie(input: {
  attachmentId: string;
  occurrenceId?: string;
  dossieModel?: string;
  dossieItemKey?: string;
  actorUserId?: string;
}): Promise<OccurrenceRow> {
  const response = await fetch(`/api/occurrences/attachments/${encodeURIComponent(input.attachmentId)}/dossie-link`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await safeJson<{ success?: boolean; data?: OccurrenceRow; error?: unknown }>(response);
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(parseError(payload, response.status, 'Falha ao associar anexo ao dossiê'));
  }
  return payload.data;
}

export async function reorderDossieItems(input: {
  model: string;
  orderedKeys: string[];
}): Promise<{ model: string; total: number }> {
  const response = await fetch('/api/occurrences/dossie-items/order', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const payload = await safeJson<{ success?: boolean; data?: { model: string; total: number }; error?: unknown }>(response);
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(parseError(payload, response.status, 'Falha ao reordenar separadores do dossiê'));
  }
  return payload.data;
}
