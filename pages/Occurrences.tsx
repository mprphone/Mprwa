import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Eye,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import OccurrenceDetailModal, { OccurrenceDetailForm } from '../components/occurrences/OccurrenceDetailModal';
import {
  createEmptyProjectSupportDetail,
  isProjectSupportTypeName,
  normalizeProjectSupportDetail,
  ProjectSectionKey,
} from '../components/occurrences/projectSupportDetail';
import { mockService } from '../services/mockData';
import { Role } from '../types';
import {
  OccurrenceCustomer,
  OccurrenceRow,
  OccurrenceType,
  OccurrenceUser,
  deleteOccurrence,
  fetchOccurrenceById,
  fetchOccurrences,
  fetchOccurrencesMeta,
  importOccurrencesFromSupabase,
  saveOccurrence,
  uploadOccurrenceAttachment,
} from '../services/occurrencesApi';

type ModalState = OccurrenceDetailForm & {
  open: boolean;
  loading: boolean;
  saving: boolean;
};

const DEFAULT_MODAL: ModalState = {
  open: false,
  loading: false,
  saving: false,
  id: '',
  customerId: '',
  date: new Date().toISOString().slice(0, 10),
  dueDate: '',
  typeId: '',
  title: '',
  description: '',
  state: 'ABERTA',
  responsibleUserIds: [],
  resolution: '',
  attachments: [],
  projectSupport: createEmptyProjectSupportDetail(),
};

const Occurrences: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [types, setTypes] = useState<OccurrenceType[]>([]);
  const [users, setUsers] = useState<OccurrenceUser[]>([]);
  const [customers, setCustomers] = useState<OccurrenceCustomer[]>([]);
  const [rows, setRows] = useState<OccurrenceRow[]>([]);

  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('TODOS');
  const [typeFilter, setTypeFilter] = useState('');
  const [responsibleFilter, setResponsibleFilter] = useState('');

  const [modal, setModal] = useState<ModalState>(DEFAULT_MODAL);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [uploadAttachmentError, setUploadAttachmentError] = useState('');

  const currentUserId = String(mockService.getCurrentUserId() || '').trim();
  const currentUserRole = mockService.getCurrentUser()?.role;
  const isAdmin = currentUserRole === Role.ADMIN;
  const effectiveResponsibleFilter = isAdmin ? responsibleFilter : currentUserId;

  const selectedTypeName = useMemo(() => {
    const id = String(modal.typeId || '').trim();
    if (!id) return '';
    return String(types.find((item) => String(item.id) === id)?.name || '').trim();
  }, [modal.typeId, types]);

  const isProjectSupport = isProjectSupportTypeName(selectedTypeName);

  const loadMetaAndRows = async () => {
    setLoading(true);
    setError('');
    try {
      const [meta, list] = await Promise.all([
        fetchOccurrencesMeta(),
        fetchOccurrences({
          q: search,
          state: stateFilter,
          typeId: typeFilter,
          responsibleUserId: effectiveResponsibleFilter,
          limit: 1000,
        }),
      ]);
      setTypes(meta.types || []);
      setUsers(meta.users || []);
      setCustomers(meta.customers || []);
      setRows(list || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar ocorrências.');
    } finally {
      setLoading(false);
    }
  };

  const loadRowsOnly = async () => {
    setLoading(true);
    setError('');
    try {
      const list = await fetchOccurrences({
        q: search,
        state: stateFilter,
        typeId: typeFilter,
        responsibleUserId: effectiveResponsibleFilter,
        limit: 1000,
      });
      setRows(list || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar ocorrências.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadMetaAndRows();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadRowsOnly();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, stateFilter, typeFilter, effectiveResponsibleFilter]);

  const openCreateModal = () => {
    setModal({
      ...DEFAULT_MODAL,
      open: true,
      responsibleUserIds: currentUserId ? [currentUserId] : [],
      projectSupport: createEmptyProjectSupportDetail(),
    });
    setUploadAttachmentError('');
    setMessage('');
    setError('');
  };

  const openEditModal = async (row: OccurrenceRow) => {
    setError('');
    setMessage('');
    setUploadAttachmentError('');
    setModal((prev) => ({ ...prev, open: true, loading: true }));
    try {
      const detail = await fetchOccurrenceById(row.id);
      setModal({
        open: true,
        loading: false,
        saving: false,
        id: detail.id,
        customerId: detail.customerId,
        date: detail.date || new Date().toISOString().slice(0, 10),
        dueDate: detail.dueDate || '',
        typeId: detail.typeId ? String(detail.typeId) : '',
        title: detail.title || '',
        description: detail.description || '',
        state: detail.state || 'ABERTA',
        responsibleUserIds: Array.isArray(detail.responsibleUserIds)
          ? detail.responsibleUserIds.filter(Boolean)
          : detail.responsibleUserId
          ? [detail.responsibleUserId]
          : [],
        resolution: detail.resolution || '',
        attachments: detail.attachments || [],
        projectSupport: normalizeProjectSupportDetail(detail.projetoApoioDetalhe),
      });
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : 'Falha ao carregar detalhe da ocorrência.');
      setModal(DEFAULT_MODAL);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const targetOccurrenceId = String(params.get('occurrenceId') || '').trim();
    if (!targetOccurrenceId || rows.length === 0) return;

    const targetRow = rows.find((row) => String(row.id || '').trim() === targetOccurrenceId);
    if (!targetRow) return;

    void openEditModal(targetRow);

    params.delete('occurrenceId');
    navigate(
      {
        pathname: '/occurrences',
        search: params.toString() ? `?${params.toString()}` : '',
      },
      { replace: true }
    );
  }, [location.search, rows, navigate]);

  const closeModal = () => {
    if (modal.saving || uploadingAttachment) return;
    setUploadAttachmentError('');
    setModal(DEFAULT_MODAL);
  };

  const handleAddResponsible = (userId: string) => {
    setModal((prev) => {
      if (!userId || prev.responsibleUserIds.includes(userId)) return prev;
      return { ...prev, responsibleUserIds: [...prev.responsibleUserIds, userId] };
    });
  };

  const handleRemoveResponsible = (userId: string) => {
    setModal((prev) => ({
      ...prev,
      responsibleUserIds: prev.responsibleUserIds.filter((item) => item !== userId),
    }));
  };

  const handleSaveModal = async () => {
    if (!modal.customerId || !modal.title.trim()) {
      setError('Cliente e título são obrigatórios.');
      return;
    }

    setModal((prev) => ({ ...prev, saving: true }));
    setError('');
    setMessage('');

    try {
      const primaryResponsible = modal.responsibleUserIds[0] || '';
      const saved = await saveOccurrence({
        id: modal.id || undefined,
        customerId: modal.customerId,
        date: modal.date,
        dueDate: modal.dueDate || undefined,
        typeId: modal.typeId ? Number(modal.typeId) : null,
        title: modal.title.trim(),
        description: modal.description.trim() || undefined,
        state: modal.state,
        responsibleUserId: primaryResponsible || undefined,
        responsibleUserIds: modal.responsibleUserIds,
        resolution: modal.resolution.trim() || undefined,
        projetoApoioDetalhe: isProjectSupport ? modal.projectSupport : null,
        actorUserId: currentUserId || undefined,
      });

      if (!modal.id && saved?.id) {
        setModal((prev) => ({ ...prev, id: saved.id, saving: false, open: true }));
        setMessage('Ocorrência criada. Já pode anexar ficheiros.');
      } else {
        setModal(DEFAULT_MODAL);
        setMessage('Ocorrência guardada com sucesso.');
      }

      await loadRowsOnly();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Falha ao guardar ocorrência.');
      setModal((prev) => ({ ...prev, saving: false }));
    }
  };

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Falha ao ler ficheiro.'));
      reader.readAsDataURL(file);
    });

  const handleUploadAttachments = async (
    fileList: FileList | null,
    sectionKey: ProjectSectionKey = 'geral',
    options?: { dossieModel?: string; dossieItemKey?: string }
  ) => {
    if (!fileList || fileList.length === 0) return;

    if (!modal.id) {
      setUploadAttachmentError('Guarde a ocorrência primeiro para poder anexar ficheiros.');
      return;
    }

    setUploadingAttachment(true);
    setUploadAttachmentError('');
    setError('');

    try {
      let latestDetail: OccurrenceRow | null = null;
      for (const file of Array.from(fileList)) {
        const dataBase64 = await fileToBase64(file);
        latestDetail = await uploadOccurrenceAttachment({
          occurrenceId: modal.id,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          dataBase64,
          sectionKey,
          dossieModel: options?.dossieModel,
          dossieItemKey: options?.dossieItemKey,
          actorUserId: currentUserId || undefined,
        });
      }

      if (latestDetail) {
        setModal((prev) => ({ ...prev, attachments: latestDetail?.attachments || [] }));
      } else {
        const detail = await fetchOccurrenceById(modal.id);
        setModal((prev) => ({ ...prev, attachments: detail.attachments || [] }));
      }

      setMessage('Anexo(s) guardado(s) com sucesso.');
      await loadRowsOnly();
    } catch (uploadError) {
      setUploadAttachmentError(uploadError instanceof Error ? uploadError.message : 'Falha ao anexar ficheiro.');
    } finally {
      setUploadingAttachment(false);
    }
  };

  const handleDelete = async (row: OccurrenceRow) => {
    const confirmed = window.confirm(`Apagar ocorrência "${row.title}"?`);
    if (!confirmed) return;

    setError('');
    setMessage('');
    try {
      await deleteOccurrence(row.id, currentUserId || undefined);
      setMessage('Ocorrência apagada.');
      await loadRowsOnly();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Falha ao apagar ocorrência.');
    }
  };

  const handleQuickToggleState = async (row: OccurrenceRow) => {
    try {
      const detail = await fetchOccurrenceById(row.id);
      const nextState = String(detail.state || '').toUpperCase() === 'RESOLVIDA' ? 'ABERTA' : 'RESOLVIDA';
      await saveOccurrence({
        id: detail.id,
        customerId: detail.customerId,
        date: detail.date || new Date().toISOString().slice(0, 10),
        dueDate: detail.dueDate || undefined,
        typeId: detail.typeId || null,
        title: detail.title,
        description: detail.description || undefined,
        state: nextState,
        responsibleUserId: detail.responsibleUserId || undefined,
        responsibleUserIds: detail.responsibleUserIds || [],
        resolution: detail.resolution || undefined,
        projetoApoioDetalhe: detail.projetoApoioDetalhe || null,
        actorUserId: currentUserId || undefined,
      });
      setMessage(nextState === 'RESOLVIDA' ? 'Ocorrência fechada.' : 'Ocorrência reaberta.');
      await loadRowsOnly();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'Falha ao alterar estado.');
    }
  };

  const handleImportSupabase = async () => {
    const confirmed = window.confirm('Importar ocorrências do Supabase para SQLite local agora?');
    if (!confirmed) return;

    setImporting(true);
    setError('');
    setMessage('');
    try {
      const summary = await importOccurrencesFromSupabase(currentUserId || undefined);
      setMessage(
        `Importação concluída. Ocorrências: ${summary.importedOccurrences}/${summary.sourceOccurrences} | Anexos: ${summary.importedAttachments}.`
      );
      await loadMetaAndRows();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Falha na importação do Supabase.');
    } finally {
      setImporting(false);
    }
  };

  const getTypeLabel = (row: OccurrenceRow) => {
    if (row.typeName) return row.typeName;
    if (!row.typeId) return '--';
    const type = types.find((item) => item.id === row.typeId);
    return type?.name || `Tipo ${row.typeId}`;
  };

  const formatDate = (value: string | null | undefined) => {
    const raw = String(value || '').trim();
    if (!raw) return '--';
    const parsed = new Date(`${raw}T00:00:00`);
    if (!Number.isFinite(parsed.getTime())) return raw;
    return parsed.toLocaleDateString('pt-PT');
  };

  const visibleRows = useMemo(() => {
    const toDayNumber = (value: string | null | undefined, emptyValue: number) => {
      const raw = String(value || '').trim();
      if (!raw) return emptyValue;
      const parsed = new Date(`${raw}T00:00:00`).getTime();
      return Number.isFinite(parsed) ? parsed : emptyValue;
    };

    const stateOrder = (state: string | null | undefined) => {
      const normalized = String(state || '').trim().toUpperCase();
      return normalized === 'RESOLVIDA' ? 1 : 0;
    };

    const sortRows = (list: OccurrenceRow[]) =>
      [...list].sort((a, b) => {
        const stateDiff = stateOrder(a.state) - stateOrder(b.state);
        if (stateDiff !== 0) return stateDiff;

        const dueDiff = toDayNumber(a.dueDate, Number.MAX_SAFE_INTEGER) - toDayNumber(b.dueDate, Number.MAX_SAFE_INTEGER);
        if (dueDiff !== 0) return dueDiff;

        return toDayNumber(b.date, 0) - toDayNumber(a.date, 0);
      });

    if (isAdmin) return sortRows(rows);
    if (!currentUserId) return [];

    const filtered = rows.filter((row) => {
      const primary = String(row.responsibleUserId || '').trim();
      const many = Array.isArray(row.responsibleUserIds)
        ? row.responsibleUserIds.map((item) => String(item || '').trim()).filter(Boolean)
        : [];
      return primary === currentUserId || many.includes(currentUserId);
    });

    return sortRows(filtered);
  }, [rows, isAdmin, currentUserId]);

  const assignableUsers = useMemo(() => {
    if (isAdmin) return users;
    return users.filter((user) => user.id === currentUserId);
  }, [users, isAdmin, currentUserId]);

  const currentUserName = useMemo(() => {
    return users.find((user) => user.id === currentUserId)?.name || mockService.getCurrentUser()?.name || 'As minhas ocorrências';
  }, [users, currentUserId]);

  return (
    <div className="w-full space-y-4 p-4 md:p-6">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 text-white shadow-sm md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold md:text-2xl">Ocorrências</h1>
            <p className="text-xs text-slate-200 md:text-sm">Gestão operacional de ocorrências dos clientes.</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void handleImportSupabase()}
              disabled={importing}
              className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/20 disabled:opacity-50 md:text-sm"
            >
              <RefreshCw size={15} className={importing ? 'animate-spin' : ''} />
              Importar
            </button>
            <button
              onClick={openCreateModal}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500 md:text-sm"
            >
              <Plus size={16} />
              Nova Ocorrência
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="grid grid-cols-1 gap-2 border-b border-slate-200 p-3 md:grid-cols-4">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Pesquisar cliente, NIF, título..."
              className="w-full rounded-md border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm"
            />
          </div>

          <select
            value={stateFilter}
            onChange={(event) => setStateFilter(event.target.value)}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <option value="TODOS">Todos os estados</option>
            <option value="ABERTA">ABERTA</option>
            <option value="ATRASADA">ATRASADA</option>
            <option value="RESOLVIDA">FECHADA</option>
          </select>

          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">Todos os tipos</option>
            {types.map((type) => (
              <option key={type.id} value={String(type.id)}>
                {type.name}
              </option>
            ))}
          </select>

          <select
            value={isAdmin ? responsibleFilter : currentUserId}
            onChange={(event) => setResponsibleFilter(event.target.value)}
            disabled={!isAdmin}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-slate-100"
          >
            {isAdmin ? (
              <option value="">Todos os responsáveis</option>
            ) : (
              <option value={currentUserId}>{currentUserName}</option>
            )}
            {isAdmin && users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </div>

        {(error || message) && (
          <div className="space-y-2 border-b border-slate-100 px-3 py-2">
            {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            {message && <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{message}</div>}
          </div>
        )}

        <div className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500">
          {loading ? 'A carregar...' : `${visibleRows.length} ocorrência(s)`}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1220px] table-fixed">
            <thead className="bg-slate-100/80">
              <tr>
                <th className="w-[8%] px-3 py-3 text-left text-[11px] font-semibold uppercase text-slate-600">Data</th>
                <th className="w-[24%] px-3 py-3 text-left text-[11px] font-semibold uppercase text-slate-600">Cliente</th>
                <th className="w-[12%] px-3 py-3 text-left text-[11px] font-semibold uppercase text-slate-600">Tipo</th>
                <th className="w-[24%] px-3 py-3 text-left text-[11px] font-semibold uppercase text-slate-600">Título</th>
                <th className="w-[14%] px-3 py-3 text-left text-[11px] font-semibold uppercase text-slate-600">Responsável</th>
                <th className="w-[8%] px-3 py-3 text-left text-[11px] font-semibold uppercase text-slate-600">Limite</th>
                <th className="w-[6%] px-3 py-3 text-left text-[11px] font-semibold uppercase text-slate-600">Estado</th>
                <th className="w-[4%] px-3 py-3 text-right text-[11px] font-semibold uppercase text-slate-600">Ações</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const rowClosed = String(row.state || '').toUpperCase() === 'RESOLVIDA';
                return (
                  <tr
                    key={row.id}
                    className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                    onClick={() => void openEditModal(row)}
                  >
                    <td className="px-3 py-3 text-xs text-slate-700">{formatDate(row.date)}</td>
                    <td className="px-3 py-3 text-sm text-slate-900">
                      <div className="truncate font-semibold" title={row.customerCompany || row.customerName || '--'}>
                        {row.customerCompany || row.customerName || '--'}
                      </div>
                      <div className="text-xs text-slate-500">{row.customerNif ? `NIF ${row.customerNif}` : '--'}</div>
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-700">{getTypeLabel(row)}</td>
                    <td className="px-3 py-3 text-sm text-slate-900">
                      <div className="truncate font-semibold" title={row.title}>
                        {row.title}
                      </div>
                      {row.description ? <div className="truncate text-xs text-slate-500">{row.description}</div> : null}
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-700">{row.responsibleNames || row.responsibleUserName || '--'}</td>
                    <td className="px-3 py-3 text-xs text-slate-700">{formatDate(row.dueDate)}</td>
                    <td className="px-3 py-3">
                      <StateBadge state={row.state} />
                    </td>
                    <td className="px-3 py-3" onClick={(event) => event.stopPropagation()}>
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => void openEditModal(row)}
                          className="rounded border border-slate-200 p-1.5 text-slate-500 hover:bg-blue-50 hover:text-blue-700"
                          title="Ver"
                        >
                          <Eye size={14} />
                        </button>
                        <button
                          onClick={() => void handleQuickToggleState(row)}
                          className={`rounded border p-1.5 ${
                            rowClosed
                              ? 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'
                              : 'border-amber-300 text-amber-700 hover:bg-amber-50'
                          }`}
                          title={rowClosed ? 'Reabrir' : 'Fechar'}
                        >
                          <CheckCircle2 size={14} />
                        </button>
                        <button
                          onClick={() => void handleDelete(row)}
                          className="rounded border border-slate-200 p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-700"
                          title="Apagar"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {!loading && visibleRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                    Sem ocorrências para os filtros selecionados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <OccurrenceDetailModal
        open={modal.open}
        loading={modal.loading}
        saving={modal.saving}
        uploadingAttachment={uploadingAttachment}
        uploadAttachmentError={uploadAttachmentError}
        customers={customers}
        types={types}
        users={assignableUsers}
        form={modal}
        onClose={closeModal}
        onSave={() => void handleSaveModal()}
        onChange={(patch) => setModal((prev) => ({ ...prev, ...patch }))}
        onAddResponsible={handleAddResponsible}
        onRemoveResponsible={handleRemoveResponsible}
        onUploadFiles={(files, sectionKey, options) =>
          void handleUploadAttachments(files, sectionKey || 'geral', options)
        }
      />
    </div>
  );
};

const StateBadge: React.FC<{ state: string }> = ({ state }) => {
  const normalized = String(state || '').toUpperCase();
  if (normalized === 'RESOLVIDA') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-green-200 bg-green-100 px-2 py-1 text-xs font-medium text-green-700">
        FECHADA
      </span>
    );
  }
  if (normalized === 'ATRASADA') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-100 px-2 py-1 text-xs font-medium text-red-700">
        <AlertTriangle size={12} /> ATRASADA
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-yellow-200 bg-yellow-100 px-2 py-1 text-xs font-medium text-yellow-700">
      <Calendar size={12} /> ABERTA
    </span>
  );
};

export default Occurrences;
