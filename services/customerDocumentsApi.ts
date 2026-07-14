import type { Customer } from '../types';
import { uploadChatTempMedia } from './chatCoreApi';
import { isValidCustomer } from './mockDataUtils';

export class CustomerDocumentsApi {
  constructor(
    private readonly browserAvailable: () => boolean,
    private readonly currentUserId: () => string,
  ) {}

  private isBrowser(): boolean {
    return this.browserAvailable();
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
              type: String(item.type || '').trim() === 'directory' ? ('directory' as const) : ('file' as const),
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

  async organizeCustomerDocuments(customerId: string, options: {
    maxAiDocuments?: number;
    maxFiles?: number;
    maxLegacyFolders?: number;
    maxEmptyFolders?: number;
    maxFilesPerLegacyFolder?: number;
    compareExistingDuplicates?: boolean;
    dryRun?: boolean;
    renameOnly?: boolean;
  } = {}): Promise<{
    dryRun: boolean;
    scannedCount: number;
    truncated: boolean;
    movedCount: number;
    repeatedCount: number;
    expiredCount: number;
    aiReadCount: number;
    aiCacheHitCount: number;
    aiRenamedCount: number;
    movedLegacyFoldersCount: number;
    movedLegacyFolders: string[];
    removedEmptyFoldersCount: number;
    removedEmptyFolders: string[];
    fiscalUpdates: Array<{ file: string; fields: string[] }>;
    moved: Array<{ from: string; to: string; reason: string; type: string }>;
    wouldMove: Array<{ from: string; to: string; reason: string; type: string }>;
    undoAvailable: boolean;
    warnings: string[];
  }> {
    if (!this.isBrowser()) {
      throw new Error('Organização disponível apenas no browser.');
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 120000);
    let response: Response;
    try {
      response = await fetch(`/api/customers/${encodeURIComponent(customerId)}/documents/organize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          maxAiDocuments: Math.max(0, Math.min(25, Number(options.maxAiDocuments ?? 3) || 0)),
          maxFiles: Math.max(1, Math.min(500, Number(options.maxFiles ?? 40) || 40)),
          maxLegacyFolders: Math.max(0, Math.min(10, Number(options.maxLegacyFolders ?? 2) || 0)),
          maxEmptyFolders: Math.max(0, Math.min(200, Number(options.maxEmptyFolders ?? 25) || 0)),
          maxFilesPerLegacyFolder: Math.max(1, Math.min(40, Number(options.maxFilesPerLegacyFolder ?? 10) || 10)),
          compareExistingDuplicates: options.compareExistingDuplicates !== false,
          dryRun: options.dryRun === true,
          renameOnly: options.renameOnly === true,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('A organização demorou demasiado e foi interrompida. Tenta novamente; os documentos já analisados ficam em cache.');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      dryRun?: boolean;
      scannedCount?: number;
      truncated?: boolean;
      movedCount?: number;
      wouldMoveCount?: number;
      repeatedCount?: number;
      expiredCount?: number;
      aiReadCount?: number;
      aiCacheHitCount?: number;
      aiRenamedCount?: number;
      movedLegacyFoldersCount?: number;
      movedLegacyFolders?: Array<{ from?: string; to?: string; reason?: string } | string>;
      removedEmptyFoldersCount?: number;
      removedEmptyFolders?: string[];
      fiscalUpdates?: Array<{ file?: string; fields?: string[] }>;
      moved?: Array<{ from?: string; to?: string; reason?: string; type?: string }>;
      wouldMove?: Array<{ from?: string; to?: string; reason?: string; type?: string }>;
      undoAvailable?: boolean;
      warnings?: string[];
      error?: unknown;
    };

    if (!response.ok || !payload.success) {
      const errorText =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : `Falha ao organizar documentos (${response.status}).`;
      throw new Error(errorText);
    }

    const normalizeMovements = (arr: unknown): Array<{ from: string; to: string; reason: string; type: string }> =>
      Array.isArray(arr)
        ? arr.map((item) => ({
            from: String((item as { from?: string }).from || ''),
            to: String((item as { to?: string }).to || ''),
            reason: String((item as { reason?: string }).reason || ''),
            type: String((item as { type?: string }).type || ''),
          })).filter((m) => m.from || m.to)
        : [];

    return {
      dryRun: Boolean(payload.dryRun),
      scannedCount: Number(payload.scannedCount || 0),
      truncated: Boolean(payload.truncated),
      movedCount: Number(payload.movedCount ?? payload.wouldMoveCount ?? 0),
      repeatedCount: Number(payload.repeatedCount || 0),
      expiredCount: Number(payload.expiredCount || 0),
      aiReadCount: Number(payload.aiReadCount || 0),
      aiCacheHitCount: Number(payload.aiCacheHitCount || 0),
      aiRenamedCount: Number(payload.aiRenamedCount || 0),
      movedLegacyFoldersCount: Number(payload.movedLegacyFoldersCount || 0),
      movedLegacyFolders: Array.isArray(payload.movedLegacyFolders)
        ? payload.movedLegacyFolders.map((item) => {
            if (typeof item === 'string') return item;
            return `${String(item.from || '')} → ${String(item.to || '')}`.trim();
          }).filter(Boolean)
        : [],
      removedEmptyFoldersCount: Number(payload.removedEmptyFoldersCount || 0),
      removedEmptyFolders: Array.isArray(payload.removedEmptyFolders) ? payload.removedEmptyFolders.map((item) => String(item || '')).filter(Boolean) : [],
      fiscalUpdates: Array.isArray(payload.fiscalUpdates)
        ? payload.fiscalUpdates.map((item) => ({
            file: String(item.file || ''),
            fields: Array.isArray(item.fields) ? item.fields.map((field) => String(field || '')).filter(Boolean) : [],
          }))
        : [],
      moved: normalizeMovements(payload.moved),
      wouldMove: normalizeMovements(payload.wouldMove ?? payload.moved),
      undoAvailable: Boolean(payload.undoAvailable),
      warnings: Array.isArray(payload.warnings) ? payload.warnings.map((item) => String(item || '')).filter(Boolean) : [],
    };
  }

  async undoOrganizeCustomerDocuments(customerId: string): Promise<{
    revertedCount: number;
    skippedCount: number;
    reverted: Array<{ from: string; to: string }>;
    skipped: Array<{ from?: string; to?: string; reason: string }>;
    warnings: string[];
  }> {
    if (!this.isBrowser()) {
      throw new Error('Anulação disponível apenas no browser.');
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 60000);
    let response: Response;
    try {
      response = await fetch(`/api/customers/${encodeURIComponent(customerId)}/documents/organize/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({}),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('A anulação demorou demasiado e foi interrompida.');
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
    const payload = await response.json().catch(() => ({})) as {
      success?: boolean;
      revertedCount?: number;
      skippedCount?: number;
      reverted?: Array<{ from?: string; to?: string }>;
      skipped?: Array<{ from?: string; to?: string; reason?: string }>;
      warnings?: string[];
      error?: unknown;
    };
    if (!response.ok || !payload.success) {
      const errorText =
        typeof payload.error === 'string'
          ? payload.error
          : payload.error
            ? JSON.stringify(payload.error)
            : `Falha ao anular organização (${response.status}).`;
      throw new Error(errorText);
    }
    return {
      revertedCount: Number(payload.revertedCount || 0),
      skippedCount: Number(payload.skippedCount || 0),
      reverted: Array.isArray(payload.reverted)
        ? payload.reverted.map((r) => ({ from: String(r.from || ''), to: String(r.to || '') }))
        : [],
      skipped: Array.isArray(payload.skipped)
        ? payload.skipped.map((s) => ({ from: String(s.from || ''), to: String(s.to || ''), reason: String(s.reason || '') }))
        : [],
      warnings: Array.isArray(payload.warnings) ? payload.warnings.map((w) => String(w || '')).filter(Boolean) : [],
    };
  }

  async uploadTemporaryChatMedia(
    file: File,
    mediaKind: 'image' | 'document' = 'document'
  ): Promise<{
    fileName: string;
    storedFileName: string;
    size: number;
    mimeType: string;
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

    const uploaded = await uploadChatTempMedia({
      fileName: file.name,
      contentBase64,
      mimeType: file.type || undefined,
      mediaKind,
      actorUserId: this.currentUserId() || null,
    });

    if (!String(uploaded.fullPath || '').trim()) {
      throw new Error('O servidor não devolveu caminho válido para o anexo.');
    }

    return uploaded;
  }

  async ingestCustomerDocumentWithAI(
    customerId: string,
    file: File,
    documentType:
      | 'cartao_eletronico'
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
        actorUserId: this.currentUserId() || null,
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
      customer: payload.customer && isValidCustomer(payload.customer)
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
      | 'cartao_eletronico'
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
          requestedBy: this.currentUserId() || null,
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
        requestedBy: this.currentUserId() || null,
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

}
