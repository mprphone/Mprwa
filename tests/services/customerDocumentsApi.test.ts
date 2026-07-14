import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerDocumentsApi } from '../../services/customerDocumentsApi';

function response(body: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('CustomerDocumentsApi', () => {
  const fetchMock = vi.fn();
  const api = new CustomerDocumentsApi(() => true, () => 'u1');

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('devolve uma lista vazia fora do browser', async () => {
    const serverApi = new CustomerDocumentsApi(() => false, () => '');
    await expect(serverApi.getCustomerDocumentsAtPath('c1')).resolves.toEqual({
      folderPath: '',
      storageFolderPath: '',
      configured: false,
      currentRelativePath: '',
      canGoUp: false,
      entries: [],
      files: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normaliza a listagem de documentos e codifica o caminho', async () => {
    fetchMock.mockResolvedValue(response({
      success: true,
      folderPath: '/clientes/c1',
      storageFolderPath: '/storage/c1',
      configured: true,
      currentRelativePath: 'Fiscal/2026',
      canGoUp: true,
      entries: [
        { type: 'directory', name: 'IVA', relativePath: 'Fiscal/2026/IVA', updatedAt: '2026-07-13T10:00:00.000Z' },
        { type: 'file', name: 'doc.pdf', relativePath: 'Fiscal/2026/doc.pdf', size: 123, updatedAt: '2026-07-13T11:00:00.000Z' },
        { type: 'file', name: '', relativePath: '' },
      ],
      files: [
        { name: 'doc.pdf', relativePath: 'Fiscal/2026/doc.pdf', size: 123, updatedAt: '2026-07-13T11:00:00.000Z' },
      ],
    }));

    const result = await api.getCustomerDocumentsAtPath('cliente/1', 'Fiscal/2026');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/customers/cliente%2F1/documents?path=Fiscal%2F2026');
    expect(result).toMatchObject({ configured: true, canGoUp: true });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].type).toBe('directory');
    expect(result.files[0]).toMatchObject({ name: 'doc.pdf', size: 123 });
  });

  it('importa um documento por URL com os campos normalizados', async () => {
    fetchMock.mockResolvedValue(response({
      success: true,
      fileName: 'fatura.pdf',
      size: 456,
      folderPath: '/clientes/c1',
      relativePath: 'Fiscal/fatura.pdf',
      fullPath: '/clientes/c1/Fiscal/fatura.pdf',
    }));

    await expect(api.importCustomerDocumentFromUrl(
      'c1',
      ' https://example.com/fatura.pdf ',
      ' fatura.pdf ',
      ' Fiscal ',
    )).resolves.toMatchObject({ fileName: 'fatura.pdf', size: 456 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      url: 'https://example.com/fatura.pdf',
      fileName: 'fatura.pdf',
      path: 'Fiscal',
    });
  });

  it('gera um link partilhável e propaga erros do servidor', async () => {
    fetchMock.mockResolvedValueOnce(response({ success: true, url: '/share/abc', fileName: 'doc.pdf' }));
    await expect(api.getCustomerDocumentShareLink('c1', 'Fiscal/doc.pdf')).resolves.toEqual({
      url: '/share/abc',
      fileName: 'doc.pdf',
    });

    fetchMock.mockResolvedValueOnce(response(
      { success: false, error: 'Ficheiro não encontrado' },
      { ok: false, status: 404 },
    ));
    await expect(api.getCustomerDocumentShareLink('c1', 'missing.pdf'))
      .rejects.toThrow('Ficheiro não encontrado');
  });

  it('limita opções de organização e normaliza o resultado', async () => {
    fetchMock.mockResolvedValue(response({
      success: true,
      dryRun: true,
      scannedCount: 4,
      wouldMoveCount: 2,
      movedLegacyFolders: [{ from: 'Antiga', to: 'Arquivo' }],
      wouldMove: [{ from: 'a.pdf', to: 'Fiscal/a.pdf', reason: 'classificação', type: 'fiscal' }],
      warnings: ['revisão necessária'],
    }));

    const result = await api.organizeCustomerDocuments('c1', {
      maxAiDocuments: 999,
      maxFiles: 9999,
      maxLegacyFolders: -1,
      dryRun: true,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ maxAiDocuments: 25, maxFiles: 500, maxLegacyFolders: 0, dryRun: true });
    expect(result).toMatchObject({ dryRun: true, scannedCount: 4, movedCount: 2 });
    expect(result.wouldMove).toHaveLength(1);
  });

  it('envia a sincronização SAF-T com o utilizador atual', async () => {
    fetchMock.mockResolvedValue(response({
      success: true,
      syncedFiles: 3,
      skippedFiles: 1,
      warnings: ['um aviso'],
    }));

    await expect(api.syncSaftCompanyDocs('c1', { yearsBack: 5, force: true }))
      .resolves.toEqual({ success: true, syncedFiles: 3, skippedFiles: 1, warnings: ['um aviso'] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      customerId: 'c1',
      yearsBack: 5,
      force: true,
      requestedBy: 'u1',
    });
  });

  it('combina jobs com ficheiros arquivados em cache', async () => {
    fetchMock
      .mockResolvedValueOnce(response({
        success: true,
        data: [
          { id: 1, document_type: 'ies', status: 'sent', file_name: 'ies.pdf' },
          { id: 2, document_type: 'crc', status: 'error', error: 'falhou' },
        ],
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: [
          { id: 20, documentType: 'crc', fileName: 'crc.pdf', fileExists: true, updatedAt: '2026-07-13' },
          { id: 30, documentType: 'modelo_22', fileName: 'm22.pdf', fileExists: true },
        ],
      }));

    const jobs = await api.getSaftJobs('c1');
    expect(jobs.find((item) => item.documentType === 'ies')).toMatchObject({ status: 'sent', fileName: 'ies.pdf' });
    expect(jobs.find((item) => item.documentType === 'crc')).toMatchObject({ status: 'archived', fileName: 'crc.pdf' });
    expect(jobs.find((item) => item.documentType === 'modelo_22')).toMatchObject({ status: 'archived', fileName: 'm22.pdf' });
  });
});
