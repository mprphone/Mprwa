import React, { useState, useEffect } from 'react';
import { mockService } from '../services/mockData';
import { User, Role } from '../types';
import { Plus, Search, Mail, Shield, Edit2, Sparkles, Trash2, X, Clock, CalendarDays, Download, Printer, Save, PlusCircle, Copy, ExternalLink, CheckCircle } from 'lucide-react';
import { fetchInternalPresence, InternalPresenceRow } from '../services/internalChatApi';
import {
  fetchHrFuncionarios,
  fetchHrPedidos,
  fetchHrRegistosPonto,
  createHrRegistoPonto,
  updateHrRegistoPonto,
  deleteHrRegistoPonto,
  fetchHrObjetivos,
  saveHrObjetivos,
  applyHrObjetivosToAll,
  fetchHrEmailAutoReplies,
  saveHrEmailAutoReply,
  updateHrEmailAutoReply,
  runHrEmailAutoReply,
  HrFuncionario,
  HrPedido,
  HrRegistoPonto,
  HrObjetivo,
  HrObjetivosConfig,
  HrEmailAutoReplySchedule,
  syncHrFromSupabase,
  updateHrFuncionario,
} from '../services/hrApi';

type HrFichaTab = 'informacao' | 'objetivos' | 'picagens' | 'ferias' | 'pedidos';
type EmployeesTab = 'utilizadores' | 'fichas' | 'ponto';

const Employees: React.FC = () => {
  const [employees, setEmployees] = useState<User[]>([]);
  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, InternalPresenceRow>>({});
  const [showModal, setShowModal] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [deletingUserId, setDeletingUserId] = useState('');
  const [hrFuncionarios, setHrFuncionarios] = useState<HrFuncionario[]>([]);
  const [selectedHrId, setSelectedHrId] = useState('');
  const [hrPedidos, setHrPedidos] = useState<HrPedido[]>([]);
  const [hrRegistosPonto, setHrRegistosPonto] = useState<HrRegistoPonto[]>([]);
  const [hrLoading, setHrLoading] = useState(false);
  const [hrSyncing, setHrSyncing] = useState(false);
  const [hrError, setHrError] = useState('');
  const [hrEditDraft, setHrEditDraft] = useState<Partial<HrFuncionario>>({});
  const [showHrFicha, setShowHrFicha] = useState(false);
  const [activeHrTab, setActiveHrTab] = useState<HrFichaTab>('informacao');
  const [employeesTab, setEmployeesTab] = useState<EmployeesTab>('utilizadores');
  const [pontoFuncionarioFilter, setPontoFuncionarioFilter] = useState('all');
  const [pontoStartDate, setPontoStartDate] = useState(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
  });
  const [pontoEndDate, setPontoEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [pontoGestaoRows, setPontoGestaoRows] = useState<HrRegistoPonto[]>([]);
  const [pontoGestaoLoading, setPontoGestaoLoading] = useState(false);
  const [pontoGestaoError, setPontoGestaoError] = useState('');
  const [pontoTimeDrafts, setPontoTimeDrafts] = useState<Record<string, string>>({});
  const [objetivosItems, setObjetivosItems] = useState<HrObjetivo[]>([]);
  const [objetivosConfig, setObjetivosConfig] = useState<HrObjetivosConfig>({ patamar50: '', patamar65: '', patamar80: '', premioMaximo: 0, notasGerais: '' });
  const [objetivosLoading, setObjetivosLoading] = useState(false);
  const [objetivosSaving, setObjetivosSaving] = useState(false);
  const [objetivosError, setObjetivosError] = useState('');
  const [emailAutoReplies, setEmailAutoReplies] = useState<HrEmailAutoReplySchedule[]>([]);
  const [emailAutoReplyLoading, setEmailAutoReplyLoading] = useState(false);
  const [emailAutoReplySaving, setEmailAutoReplySaving] = useState(false);
  const [emailAutoReplyError, setEmailAutoReplyError] = useState('');
  const [showEmailAutoReplyModal, setShowEmailAutoReplyModal] = useState(false);
  const [emailAutoReplyDraft, setEmailAutoReplyDraft] = useState<Partial<HrEmailAutoReplySchedule>>({});
  const [emailAutoReplyCopyId, setEmailAutoReplyCopyId] = useState('');
  const [formData, setFormData] = useState({ 
    name: '', 
    email: '', 
    password: '', 
    role: Role.AGENT,
    avatarUrl: '',
    isAiAssistant: false,
    aiAllowedSitesText: '',
  });

  const currentUserId = String(mockService.getCurrentUserId() || '').trim();
  const currentUser = mockService.getCurrentUser();
  const canManageHr = String(currentUser?.email || '').trim().toLowerCase() === 'mpr@mpr.pt';

  useEffect(() => {
    loadEmployees();
    void loadHrFuncionarios();
  }, []);

  useEffect(() => {
    if (!selectedHrId) {
      setHrPedidos([]);
      setHrRegistosPonto([]);
      setEmailAutoReplies([]);
      return;
    }
    void loadHrPedidos(selectedHrId);
    void loadHrRegistosPonto(selectedHrId);
    void loadObjetivos(selectedHrId);
    void loadEmailAutoReplies(selectedHrId);
  }, [selectedHrId]);

  useEffect(() => {
    if (employeesTab !== 'ponto') return;
    void loadPontoGestao();
  }, [employeesTab, pontoFuncionarioFilter, pontoStartDate, pontoEndDate, currentUserId]);

  useEffect(() => {
    if (canManageHr || hrFuncionarios.length === 0) return;
    setPontoFuncionarioFilter(hrFuncionarios[0].id);
  }, [canManageHr, hrFuncionarios]);

  useEffect(() => {
    let cancelled = false;

    const loadPresence = async () => {
      const userIds = employees
        .map((user) => String(user?.id || '').trim())
        .filter(Boolean);
      if (!currentUserId || userIds.length === 0) {
        if (!cancelled) setPresenceByUserId({});
        return;
      }

      try {
        const rows = await fetchInternalPresence({
          userId: currentUserId,
          userIds,
          windowSeconds: 75,
          touch: false,
        });
        if (cancelled) return;
        const nextMap: Record<string, InternalPresenceRow> = {};
        (Array.isArray(rows) ? rows : []).forEach((row) => {
          const key = String(row?.userId || '').trim();
          if (!key) return;
          nextMap[key] = row;
        });
        setPresenceByUserId(nextMap);
      } catch (_) {
        if (!cancelled) setPresenceByUserId({});
      }
    };

    void loadPresence();
    const interval = window.setInterval(() => {
      void loadPresence();
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [employees, currentUserId]);

  const loadEmployees = async () => {
    const data = await mockService.getUsers();
    setEmployees(data);
  };

  const loadHrFuncionarios = async () => {
    setHrLoading(true);
    setHrError('');
    try {
      const data = await fetchHrFuncionarios(currentUserId);
      setHrFuncionarios(data);
      setSelectedHrId((current) => current || '');
    } catch (error) {
      setHrError(error instanceof Error ? error.message : 'Falha ao carregar ficha RH.');
    } finally {
      setHrLoading(false);
    }
  };

  const loadHrPedidos = async (funcionarioId: string) => {
    try {
      const data = await fetchHrPedidos({ funcionarioId, year: new Date().getFullYear(), viewerUserId: currentUserId });
      setHrPedidos(data);
    } catch (_) {
      setHrPedidos([]);
    }
  };

  const loadHrRegistosPonto = async (funcionarioId: string) => {
    try {
      const data = await fetchHrRegistosPonto({ funcionarioId, year: new Date().getFullYear(), viewerUserId: currentUserId });
      setHrRegistosPonto(data);
    } catch (_) {
      setHrRegistosPonto([]);
    }
  };

  const loadPontoGestao = async () => {
    setPontoGestaoLoading(true);
    setPontoGestaoError('');
    try {
      const rows = await fetchHrRegistosPonto({
        funcionarioId: pontoFuncionarioFilter === 'all' ? undefined : pontoFuncionarioFilter,
        startDate: pontoStartDate,
        endDate: pontoEndDate,
        viewerUserId: currentUserId,
      });
      setPontoGestaoRows(rows);
      setPontoTimeDrafts({});
    } catch (error) {
      setPontoGestaoRows([]);
      setPontoGestaoError(error instanceof Error ? error.message : 'Falha ao carregar picagens.');
    } finally {
      setPontoGestaoLoading(false);
    }
  };

  const loadObjetivos = async (funcionarioId: string) => {
    setObjetivosLoading(true);
    setObjetivosError('');
    try {
      const data = await fetchHrObjetivos(funcionarioId, currentUserId);
      setObjetivosItems(Array.isArray(data.items) ? data.items : []);
      setObjetivosConfig(data.config || { patamar50: '', patamar65: '', patamar80: '', premioMaximo: 0, notasGerais: '' });
    } catch (error) {
      setObjetivosItems([]);
      setObjetivosError(error instanceof Error ? error.message : 'Falha ao carregar objetivos.');
    } finally {
      setObjetivosLoading(false);
    }
  };

  const loadEmailAutoReplies = async (funcionarioId: string) => {
    setEmailAutoReplyLoading(true);
    setEmailAutoReplyError('');
    try {
      const data = await fetchHrEmailAutoReplies({ funcionarioId, viewerUserId: currentUserId });
      setEmailAutoReplies(data);
    } catch (error) {
      setEmailAutoReplies([]);
      setEmailAutoReplyError(error instanceof Error ? error.message : 'Falha ao carregar avisos automáticos.');
    } finally {
      setEmailAutoReplyLoading(false);
    }
  };

  const handleHrSync = async () => {
    if (!canManageHr) return;
    setHrSyncing(true);
    setHrError('');
    try {
      await syncHrFromSupabase();
      await loadHrFuncionarios();
    } catch (error) {
      setHrError(error instanceof Error ? error.message : 'Falha ao sincronizar RH.');
    } finally {
      setHrSyncing(false);
    }
  };

  const saveHrFuncionario = async () => {
    const selected = hrFuncionarios.find((item) => item.id === selectedHrId);
    if (!selected) return;
    if (!canManageHr) {
      setHrError('Só a conta mpr@mpr.pt pode editar fichas dos funcionários.');
      return;
    }
    setHrError('');
    try {
      const updated = await updateHrFuncionario(selected.id, {
        ...selected,
        ...hrEditDraft,
        actorUserId: currentUserId,
      });
      setHrFuncionarios((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setHrEditDraft({});
    } catch (error) {
      setHrError(error instanceof Error ? error.message : 'Falha ao guardar ficha RH.');
    }
  };


  const compressImageToDataUrl = async (file: File): Promise<string> => {
    const rawDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
          return;
        }
        reject(new Error('Falha ao ler imagem.'));
      };
      reader.onerror = () => reject(new Error('Falha ao ler imagem.'));
      reader.readAsDataURL(file);
    });

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Falha ao processar imagem.'));
      img.src = rawDataUrl;
    });

    const targetSize = 512;
    const cropSize = Math.max(1, Math.min(image.width, image.height));
    const sourceX = Math.max(0, Math.floor((image.width - cropSize) / 2));
    const sourceY = Math.max(0, Math.floor((image.height - cropSize) / 2));
    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Falha ao preparar imagem.');

    // Normaliza para quadrado para evitar imagens achatadas no avatar.
    ctx.drawImage(image, sourceX, sourceY, cropSize, cropSize, 0, 0, targetSize, targetSize);

    // Alvo pequeno para evitar erro 413 em uploads.
    const maxBytes = 350 * 1024;
    let quality = 0.82;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (quality > 0.45) {
      const approxBytes = Math.ceil((dataUrl.length * 3) / 4);
      if (approxBytes <= maxBytes) break;
      quality -= 0.08;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }

    return dataUrl;
  };

  const openModal = (user?: User) => {
      if (user) {
          setEditingUser(user);
          setFormData({
              name: user.name,
              email: user.email,
              password: user.password || '',
              role: user.role,
              avatarUrl: user.avatarUrl || '',
              isAiAssistant: !!user.isAiAssistant,
              aiAllowedSitesText: Array.isArray(user.aiAllowedSites) ? user.aiAllowedSites.join('\n') : '',
          });
      } else {
          setEditingUser(null);
          setFormData({ name: '', email: '', password: '', role: Role.AGENT, avatarUrl: '', isAiAssistant: false, aiAllowedSitesText: '' });
      }
      setShowModal(true);
  };

  const handlePhotoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Selecione um ficheiro de imagem válido.');
      return;
    }

    try {
      const compressedDataUrl = await compressImageToDataUrl(file);
      setFormData(prev => ({ ...prev, avatarUrl: compressedDataUrl }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível processar a imagem.';
      alert(message);
    } finally {
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const aiAllowedSites = formData.aiAllowedSitesText
        .split(/\r?\n|,/g)
        .map((item) => item.trim())
        .filter(Boolean);

      if (editingUser) {
          await mockService.updateUser(editingUser.id, {
              name: formData.name,
              email: formData.email,
              role: formData.role,
              password: formData.password,
              avatarUrl: formData.avatarUrl,
              isAiAssistant: formData.isAiAssistant,
              aiAllowedSites,
          });
      } else {
          await mockService.createUser({
              name: formData.name,
              email: formData.email,
              password: formData.password,
              role: formData.role,
              avatarUrl: formData.avatarUrl,
              isAiAssistant: formData.isAiAssistant,
              aiAllowedSites,
          });
      }

      setShowModal(false);
      await loadEmployees();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao guardar funcionário.';
      alert(message);
    }
  };

  const handleDeleteEmployee = async (user: User) => {
    const targetId = String(user?.id || '').trim();
    if (!targetId) return;
    if (targetId === currentUserId) {
      alert('Não pode eliminar o seu próprio utilizador.');
      return;
    }

    const targetName = String(user?.name || 'Funcionário').trim();
    if (!window.confirm(`Eliminar o funcionário \"${targetName}\"?`)) return;

    setDeletingUserId(targetId);
    try {
      await mockService.deleteUser(targetId, currentUserId);
      await loadEmployees();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao eliminar funcionário.';
      alert(message);
    } finally {
      setDeletingUserId('');
    }
  };

  const formatPresenceLabel = (presence: InternalPresenceRow | null): string => {
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
  };

  const selectedHrFuncionario = hrFuncionarios.find((item) => item.id === selectedHrId) || null;
  const hrValue = (key: keyof HrFuncionario) => String((hrEditDraft[key] ?? selectedHrFuncionario?.[key] ?? '') as string);
  const hrBoolValue = (key: keyof HrFuncionario) => Boolean(hrEditDraft[key] ?? selectedHrFuncionario?.[key]);
  const hrNumberValue = (key: keyof HrFuncionario) => Number(hrEditDraft[key] ?? selectedHrFuncionario?.[key] ?? 0) || 0;
  const inputClass = 'mt-1 h-10 w-full rounded-md border border-slate-300 px-3 disabled:bg-slate-100 disabled:text-slate-600';
  const formatDate = (value?: string) => {
    const raw = String(value || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '-';
    const [year, month, day] = raw.split('-');
    return `${day}/${month}/${year}`;
  };
  const formatDateTime = (value?: string) => {
    const date = new Date(String(value || ''));
    if (!Number.isFinite(date.getTime())) return '-';
    return date.toLocaleString('pt-PT', {
      timeZone: 'Europe/Lisbon',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };
  const isVacationPedido = (pedido: HrPedido) => pedido.tipo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes('FERIA');
  const approvedVacationPedidos = hrPedidos.filter((pedido) => pedido.status === 'APROVADO' && isVacationPedido(pedido));
  const formatAutoReplyMessage = (funcionarioNome: string, startDate?: string, endDate?: string, alternateEmail = 'geral@mpr.pt', alternatePhone = '+351 253 561 548', variant: 'default' | 'simple' = 'default') => {
    if (variant === 'simple') {
      return [
        'Olá,',
        '',
        'Obrigada pelo seu email.',
        '',
        `Encontro-me ausente de ${formatDate(startDate)} a ${formatDate(endDate)}, com acesso limitado ao email.`,
        '',
        `Em caso de urgência, contacte ${alternateEmail}.`,
        '',
        'Obrigada,',
        funcionarioNome || 'Equipa MPR',
      ].join('\n');
    }
    return [
    'Olá,',
    '',
    'Obrigada pelo seu email.',
    '',
    `Encontro-me ausente até ao dia ${formatDate(endDate)}, com acesso limitado ao email.`,
    '',
      `Para assuntos urgentes, por favor contacte ${alternateEmail}${alternatePhone ? ` ou ${alternatePhone}` : ''}.`,
    '',
    'Responderei assim que possível após o meu regresso.',
    '',
    'Obrigada,',
    funcionarioNome || 'Equipa MPR',
    ].join('\n');
  };
  const getEmailAutoReplyForPedido = (pedidoId: string) => emailAutoReplies.find((item) => item.pedidoId === pedidoId);
  const getEmailAutoReplyStatusMeta = (status?: HrEmailAutoReplySchedule['status']) => {
    if (status === 'ativo') return { label: 'Ativo', className: 'border-emerald-200 bg-emerald-100 text-emerald-800' };
    if (status === 'desativado') return { label: 'Desativado', className: 'border-slate-200 bg-slate-100 text-slate-700' };
    if (status === 'erro') return { label: 'Erro', className: 'border-rose-200 bg-rose-100 text-rose-800' };
    if (status === 'agendado') return { label: 'Agendado', className: 'border-blue-200 bg-blue-100 text-blue-800' };
    return { label: 'Ativação manual necessária', className: 'border-amber-200 bg-amber-100 text-amber-800' };
  };
  const openEmailAutoReplyModal = (pedido: HrPedido) => {
    if (!selectedHrFuncionario) return;
    const existing = getEmailAutoReplyForPedido(pedido.id);
    const alternateContactEmail = existing?.alternateContactEmail || 'geral@mpr.pt';
    const alternateContactPhone = existing?.alternateContactPhone || '+351 253 561 548';
    const templateVariant = existing?.templateVariant || 'default';
    setEmailAutoReplyError('');
    setEmailAutoReplyDraft(existing || {
      pedidoId: pedido.id,
      funcionarioId: selectedHrFuncionario.id,
      funcionarioNome: selectedHrFuncionario.nome,
      email: selectedHrFuncionario.email || '',
      enabled: true,
      subject: 'Ausência temporária',
      alternateContact: `${alternateContactEmail} ou ${alternateContactPhone}`,
      alternateContactEmail,
      alternateContactPhone,
      templateVariant,
      startDate: String(pedido.dataInicio || '').slice(0, 10),
      endDate: String(pedido.dataFim || pedido.dataInicio || '').slice(0, 10),
      deactivateDate: '',
      status: 'manual_necessario',
      mode: 'manual',
      manualUrl: 'https://plesk5100.is.cc:8443',
      message: formatAutoReplyMessage(selectedHrFuncionario.nome, pedido.dataInicio, pedido.dataFim || pedido.dataInicio, alternateContactEmail, alternateContactPhone, templateVariant),
    });
    setShowEmailAutoReplyModal(true);
  };
  const saveEmailAutoReply = async () => {
    if (!selectedHrFuncionario || !canManageHr) return;
    const draft = emailAutoReplyDraft;
    setEmailAutoReplySaving(true);
    setEmailAutoReplyError('');
    try {
      const saved = draft.id
        ? await updateHrEmailAutoReply(draft.id, { ...draft, actorUserId: currentUserId })
        : await saveHrEmailAutoReply({
          ...draft,
          funcionarioId: selectedHrFuncionario.id,
          funcionarioNome: selectedHrFuncionario.nome,
          actorUserId: currentUserId,
        });
      setEmailAutoReplies((current) => {
        const exists = current.some((item) => item.id === saved.id);
        return exists ? current.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...current];
      });
      setShowEmailAutoReplyModal(false);
    } catch (error) {
      setEmailAutoReplyError(error instanceof Error ? error.message : 'Falha ao guardar aviso automático.');
    } finally {
      setEmailAutoReplySaving(false);
    }
  };
  const copyEmailAutoReplyMessage = async (schedule: HrEmailAutoReplySchedule) => {
    const text = String(schedule.message || '').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setEmailAutoReplyCopyId(schedule.id);
      window.setTimeout(() => setEmailAutoReplyCopyId((current) => (current === schedule.id ? '' : current)), 1800);
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setEmailAutoReplyCopyId(schedule.id);
      window.setTimeout(() => setEmailAutoReplyCopyId((current) => (current === schedule.id ? '' : current)), 1800);
    }
  };
  const openEmailAutoReplyManualUrl = (schedule: HrEmailAutoReplySchedule) => {
    const url = String(schedule.manualUrl || 'https://plesk5100.is.cc:8443').trim();
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };
  const runEmailAutoReplyNow = async (schedule: HrEmailAutoReplySchedule, action: 'activate' | 'deactivate' | 'mark_activated' | 'mark_deactivated') => {
    if (!canManageHr) return;
    setEmailAutoReplySaving(true);
    setEmailAutoReplyError('');
    try {
      const updated = await runHrEmailAutoReply(schedule.id, { action, actorUserId: currentUserId });
      setEmailAutoReplies((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      setEmailAutoReplyError(error instanceof Error ? error.message : 'Falha ao sincronizar com Plesk.');
    } finally {
      setEmailAutoReplySaving(false);
    }
  };
  const regenerateEmailAutoReplyDraft = () => {
    setEmailAutoReplyDraft((current) => ({
      ...current,
      subject: current.subject || 'Ausência temporária',
      alternateContact: `${current.alternateContactEmail || 'geral@mpr.pt'}${current.alternateContactPhone ? ` ou ${current.alternateContactPhone}` : ''}`,
      message: formatAutoReplyMessage(
        selectedHrFuncionario?.nome || current.funcionarioNome || 'Equipa MPR',
        current.startDate,
        current.endDate,
        current.alternateContactEmail || 'geral@mpr.pt',
        current.alternateContactPhone || '',
        current.templateVariant || 'default',
      ),
    }));
  };
  const openHrFicha = (funcionario: HrFuncionario) => {
    setSelectedHrId(funcionario.id);
    setHrEditDraft({});
    setEmailAutoReplyDraft({});
    setShowEmailAutoReplyModal(false);
    setActiveHrTab('informacao');
    setShowHrFicha(true);
  };
  const hrTabs: Array<{ id: HrFichaTab; label: string }> = [
    { id: 'informacao', label: 'Informação' },
    { id: 'objetivos', label: 'Objetivos' },
    { id: 'picagens', label: 'Picagens' },
    { id: 'ferias', label: 'Férias' },
    { id: 'pedidos', label: 'Pedidos' },
  ];
  const employeesTabs: Array<{ id: EmployeesTab; label: string }> = [
    { id: 'utilizadores', label: 'Utilizadores' },
    { id: 'fichas', label: 'Fichas' },
    { id: 'ponto', label: 'Pica-ponto' },
  ];
  const PORTUGAL_TIME_ZONE = 'Europe/Lisbon';
  const getPortugalDateParts = (value?: string | Date) => {
    const date = value instanceof Date ? value : new Date(String(value || ''));
    if (!Number.isFinite(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: PORTUGAL_TIME_ZONE,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(date);
    return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])) as Record<string, string>;
  };
  const getPortugalDateValue = (value?: string) => {
    const parts = getPortugalDateParts(value);
    if (!parts) return '';
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const getTimeValue = (value?: string) => {
    const parts = getPortugalDateParts(value);
    if (!parts) return '';
    return `${parts.hour}:${parts.minute}`;
  };
  const getTimeZoneOffsetMs = (timeZone: string, utcMs: number) => {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])) as Record<string, string>;
    return Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    ) - utcMs;
  };
  const buildMoment = (date: string, time: string) => {
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    if (![year, month, day, hour, minute].every(Number.isFinite)) return `${date}T${time}:00.000Z`;
    const portugalWallTimeAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    let utcMs = portugalWallTimeAsUtc - getTimeZoneOffsetMs(PORTUGAL_TIME_ZONE, portugalWallTimeAsUtc);
    utcMs = portugalWallTimeAsUtc - getTimeZoneOffsetMs(PORTUGAL_TIME_ZONE, utcMs);
    return new Date(utcMs).toISOString();
  };
  const pontoGroups = (() => {
    const map = new Map<string, { key: string; funcionarioId: string; funcionarioNome: string; date: string; rows: HrRegistoPonto[] }>();
    pontoGestaoRows.forEach((row) => {
      const date = getPortugalDateValue(row.momento);
      if (!date) return;
      const funcionario = hrFuncionarios.find((item) => item.id === row.funcionarioId);
      const key = `${row.funcionarioId}-${date}`;
      const current = map.get(key) || {
        key,
        funcionarioId: row.funcionarioId,
        funcionarioNome: row.funcionarioNome || funcionario?.nome || 'Funcionário',
        date,
        rows: [],
      };
      current.rows.push(row);
      map.set(key, current);
    });
    return Array.from(map.values())
      .map((group) => ({
        ...group,
        rows: group.rows.sort((a, b) => String(a.momento).localeCompare(String(b.momento))),
      }))
      .sort((a, b) => `${b.date}-${b.funcionarioNome}`.localeCompare(`${a.date}-${a.funcionarioNome}`));
  })();
  const fichaPontoGroups = (() => {
    const map = new Map<string, { key: string; funcionarioId: string; funcionarioNome: string; date: string; rows: HrRegistoPonto[] }>();
    hrRegistosPonto.forEach((row) => {
      const date = getPortugalDateValue(row.momento);
      if (!date) return;
      const key = `${row.funcionarioId}-${date}`;
      const current = map.get(key) || {
        key,
        funcionarioId: row.funcionarioId,
        funcionarioNome: row.funcionarioNome || selectedHrFuncionario?.nome || 'Funcionário',
        date,
        rows: [],
      };
      current.rows.push(row);
      map.set(key, current);
    });
    return Array.from(map.values())
      .map((group) => ({
        ...group,
        rows: group.rows.sort((a, b) => String(a.momento).localeCompare(String(b.momento))),
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  })();
  const getPontoSlot = (rows: HrRegistoPonto[], tipo: 'ENTRADA' | 'SAIDA', index: number) =>
    rows.filter((row) => (row.tipo === 'SAIDA' ? 'SAIDA' : 'ENTRADA') === tipo)[index] || null;
  const timeToMinutes = (time?: string) => {
    const match = String(time || '').match(/^(\d{2}):(\d{2})/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const diffMinutesLabel = (minutes: number) => {
    const sign = minutes >= 0 ? '+' : '-';
    const abs = Math.abs(Math.round(minutes));
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}h${String(abs % 60).padStart(2, '0')}`;
  };
  const getFuncionarioSchedule = (funcionarioId?: string) => {
    const funcionario = hrFuncionarios.find((item) => item.id === funcionarioId) || selectedHrFuncionario;
    return {
      entrada: funcionario?.horaEntradaPrevista || '09:00',
      saida: funcionario?.horaSaidaPrevista || '18:00',
      almocoInicio: funcionario?.pausaAlmocoInicio || '',
      almocoFim: funcionario?.pausaAlmocoFim || '',
      toleranciaEntrada: Number(funcionario?.toleranciaEntradaMin || 0),
      toleranciaSaida: Number(funcionario?.toleranciaSaidaMin || 0),
      horasDia: Number(funcionario?.horasDiariasPrevistas || 8),
    };
  };
  const getPontoDiaResumo = (group: { funcionarioId: string; rows: HrRegistoPonto[] }) => {
    const entrada1 = getPontoSlot(group.rows, 'ENTRADA', 0);
    const saida1 = getPontoSlot(group.rows, 'SAIDA', 0);
    const entrada2 = getPontoSlot(group.rows, 'ENTRADA', 1);
    const saida2 = getPontoSlot(group.rows, 'SAIDA', 1);
    const missing = [entrada1, saida1, entrada2, saida2].filter((item) => !item).length;
    const schedule = getFuncionarioSchedule(group.funcionarioId);
    const workedPairs = [[entrada1, saida1], [entrada2, saida2]].reduce((acc, [inRow, outRow]) => {
      if (!inRow || !outRow) return acc;
      const start = new Date(inRow.momento).getTime();
      const end = new Date(outRow.momento).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return acc;
      return acc + (end - start) / 60000;
    }, 0);
    const expected = schedule.horasDia * 60;
    const balance = workedPairs ? workedPairs - expected : -expected;
    const firstEntry = entrada1 ? timeToMinutes(getTimeValue(entrada1.momento)) : null;
    const expectedEntry = timeToMinutes(schedule.entrada);
    const late = firstEntry !== null && expectedEntry !== null && firstEntry > expectedEntry + schedule.toleranciaEntrada;
    const status = missing ? 'Incompleto' : late ? 'Atraso' : balance < -schedule.toleranciaSaida ? 'Saldo negativo' : 'OK';
    return { missing, workedMinutes: workedPairs, expectedMinutes: expected, balance, late, status };
  };
  const setPontoDraft = (key: string, value: string) => {
    setPontoTimeDrafts((current) => ({ ...current, [key]: value }));
  };
  const clampObjetivoNumber = (value: unknown, max = 999999) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(max, number));
  };
  const objetivoBasePercent = (item: HrObjetivo) => {
    const meta = clampObjetivoNumber(item.meta);
    if (meta <= 0) return 0;
    const atingido = clampObjetivoNumber(item.atingido);
    const percent = item.metaTipo === 'PERCENT' ? atingido : (atingido / meta) * 100;
    return Math.round(Math.max(0, Math.min(100, percent)));
  };
  const objetivoPercent = (item: HrObjetivo) => {
    const base = objetivoBasePercent(item);
    const erros = Math.round(clampObjetivoNumber(item.erros, 999));
    if (erros >= 2) return 0;
    if (erros === 1) return Math.round(base * 0.5);
    return base;
  };
  const objetivosResumo = (() => {
    const total = objetivosItems.length;
    const pesoTotal = objetivosItems.reduce((acc, item) => acc + clampObjetivoNumber(item.peso, 100), 0);
    const percentBruta = pesoTotal > 0 ? Math.round(objetivosItems.reduce((acc, item) => acc + objetivoBasePercent(item) * clampObjetivoNumber(item.peso, 100), 0) / 100) : 0;
    const percentFinal = pesoTotal > 0 ? Math.round(objetivosItems.reduce((acc, item) => acc + objetivoPercent(item) * clampObjetivoNumber(item.peso, 100), 0) / 100) : 0;
    return {
      total,
      atingidos: objetivosItems.filter((item) => objetivoPercent(item) >= 100).length,
      pesoTotal,
      pesoValido: total === 0 || pesoTotal === 100,
      metaTotal: objetivosItems.reduce((acc, item) => acc + clampObjetivoNumber(item.meta), 0),
      atingidoTotal: objetivosItems.reduce((acc, item) => acc + clampObjetivoNumber(item.atingido), 0),
      errosTotal: objetivosItems.reduce((acc, item) => acc + Math.round(clampObjetivoNumber(item.erros, 999)), 0),
      umErro: objetivosItems.filter((item) => Math.round(clampObjetivoNumber(item.erros, 999)) === 1).length,
      doisErros: objetivosItems.filter((item) => Math.round(clampObjetivoNumber(item.erros, 999)) >= 2).length,
      percentBruta,
      percentFinal,
    };
  })();
  const updateObjetivo = (id: string, patch: Partial<HrObjetivo>) => {
    if (!canManageHr) return;
    setObjetivosItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };
  const addObjetivo = () => {
    if (!canManageHr) return;
    const pesoAtual = objetivosItems.reduce((acc, item) => acc + clampObjetivoNumber(item.peso, 100), 0);
    setObjetivosItems((current) => [
      ...current,
      {
        id: `obj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        titulo: '',
        deadline: `${new Date().getFullYear()}-12-31`,
        metaTipo: 'QTD',
        meta: 1,
        atingido: 0,
        peso: Math.max(0, 100 - pesoAtual),
        erros: 0,
      },
    ]);
  };
  const distributeObjetivos = () => {
    if (!canManageHr || objetivosItems.length === 0) return;
    const base = Math.floor(100 / objetivosItems.length);
    const rest = 100 - base * objetivosItems.length;
    setObjetivosItems((current) => current.map((item, index) => ({ ...item, peso: base + (index < rest ? 1 : 0) })));
  };
  const saveObjetivos = async () => {
    if (!selectedHrFuncionario || !canManageHr) return;
    if (objetivosItems.length > 0 && objetivosResumo.pesoTotal !== 100) {
      setObjetivosError(`A soma dos pesos deve ser 100%. Atual: ${objetivosResumo.pesoTotal}%.`);
      return;
    }
    setObjetivosSaving(true);
    setObjetivosError('');
    try {
      const data = await saveHrObjetivos(selectedHrFuncionario.id, { items: objetivosItems, config: objetivosConfig, actorUserId: currentUserId });
      setObjetivosItems(data.items || []);
      setObjetivosConfig(data.config || objetivosConfig);
      await loadHrFuncionarios();
    } catch (error) {
      setObjetivosError(error instanceof Error ? error.message : 'Falha ao guardar objetivos.');
    } finally {
      setObjetivosSaving(false);
    }
  };
  const applyObjetivosAll = async () => {
    if (!canManageHr) return;
    if (!window.confirm('Aplicar estes objetivos a todos os funcionários? Isto substitui os objetivos atuais de todos.')) return;
    setObjetivosSaving(true);
    setObjetivosError('');
    try {
      await applyHrObjetivosToAll({ items: objetivosItems, config: objetivosConfig, actorUserId: currentUserId });
      await loadHrFuncionarios();
    } catch (error) {
      setObjetivosError(error instanceof Error ? error.message : 'Falha ao aplicar objetivos a todos.');
    } finally {
      setObjetivosSaving(false);
    }
  };
  const savePontoSlot = async (group: { funcionarioId: string; date: string }, tipo: 'ENTRADA' | 'SAIDA', key: string, registo?: HrRegistoPonto | null) => {
    if (!canManageHr) return;
    const time = String(pontoTimeDrafts[key] ?? (registo ? getTimeValue(registo.momento) : '')).trim();
    if (!/^\d{2}:\d{2}$/.test(time)) {
      setPontoGestaoError('Indique uma hora válida para guardar a picagem.');
      return;
    }
    setPontoGestaoError('');
    try {
      if (registo) {
        await updateHrRegistoPonto(registo.id, { tipo, momento: buildMoment(group.date, time), origem: registo.origem || 'manual', actorUserId: currentUserId });
      } else {
        await createHrRegistoPonto({ funcionarioId: group.funcionarioId, tipo, momento: buildMoment(group.date, time), origem: 'manual', actorUserId: currentUserId });
      }
      await loadPontoGestao();
    } catch (error) {
      setPontoGestaoError(error instanceof Error ? error.message : 'Falha ao guardar picagem.');
    }
  };
  const saveFichaPontoSlot = async (group: { funcionarioId: string; date: string }, tipo: 'ENTRADA' | 'SAIDA', key: string, registo?: HrRegistoPonto | null) => {
    if (!canManageHr || !selectedHrId) return;
    const time = String(pontoTimeDrafts[key] ?? (registo ? getTimeValue(registo.momento) : '')).trim();
    if (!/^\d{2}:\d{2}$/.test(time)) {
      setObjetivosError('');
      setHrError('Indique uma hora válida para guardar a picagem.');
      return;
    }
    try {
      if (registo) {
        await updateHrRegistoPonto(registo.id, { tipo, momento: buildMoment(group.date, time), origem: registo.origem || 'manual', actorUserId: currentUserId });
      } else {
        await createHrRegistoPonto({ funcionarioId: group.funcionarioId, tipo, momento: buildMoment(group.date, time), origem: 'manual', actorUserId: currentUserId });
      }
      await loadHrRegistosPonto(selectedHrId);
    } catch (error) {
      setHrError(error instanceof Error ? error.message : 'Falha ao guardar picagem.');
    }
  };
  const removeFichaPontoSlot = async (registo: HrRegistoPonto) => {
    if (!canManageHr || !selectedHrId) return;
    if (!window.confirm('Apagar esta picagem?')) return;
    try {
      await deleteHrRegistoPonto(registo.id, currentUserId);
      await loadHrRegistosPonto(selectedHrId);
    } catch (error) {
      setHrError(error instanceof Error ? error.message : 'Falha ao apagar picagem.');
    }
  };
  const removePontoSlot = async (registo: HrRegistoPonto) => {
    if (!canManageHr) return;
    if (!window.confirm('Apagar esta picagem?')) return;
    setPontoGestaoError('');
    try {
      await deleteHrRegistoPonto(registo.id, currentUserId);
      await loadPontoGestao();
    } catch (error) {
      setPontoGestaoError(error instanceof Error ? error.message : 'Falha ao apagar picagem.');
    }
  };
  const downloadPontoCsv = () => {
    const lines = [
      ['Funcionário', 'Data', 'Entrada 1', 'Saída 1', 'Entrada 2', 'Saída 2', 'Estado'],
      ...pontoGroups.map((group) => {
        const entrada1 = getPontoSlot(group.rows, 'ENTRADA', 0);
        const saida1 = getPontoSlot(group.rows, 'SAIDA', 0);
        const entrada2 = getPontoSlot(group.rows, 'ENTRADA', 1);
        const saida2 = getPontoSlot(group.rows, 'SAIDA', 1);
        const missing = [entrada1, saida1, entrada2, saida2].filter((item) => !item).length;
        return [
          group.funcionarioNome,
          formatDate(group.date),
          entrada1 ? getTimeValue(entrada1.momento) : '',
          saida1 ? getTimeValue(saida1.momento) : '',
          entrada2 ? getTimeValue(entrada2.momento) : '',
          saida2 ? getTimeValue(saida2.momento) : '',
          missing ? `Faltam ${missing} picagem(ns)` : 'Completo',
        ];
      }),
    ];
    const csv = lines.map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(';')).join('\n');
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `pica-ponto-${pontoStartDate}-a-${pontoEndDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const printPontoMap = () => {
    const rowsHtml = pontoGroups.map((group) => {
      const entrada1 = getPontoSlot(group.rows, 'ENTRADA', 0);
      const saida1 = getPontoSlot(group.rows, 'SAIDA', 0);
      const entrada2 = getPontoSlot(group.rows, 'ENTRADA', 1);
      const saida2 = getPontoSlot(group.rows, 'SAIDA', 1);
      const missing = [entrada1, saida1, entrada2, saida2].filter((item) => !item).length;
      return `<tr>
        <td>${group.funcionarioNome}</td>
        <td>${formatDate(group.date)}</td>
        <td>${entrada1 ? getTimeValue(entrada1.momento) : '-'}</td>
        <td>${saida1 ? getTimeValue(saida1.momento) : '-'}</td>
        <td>${entrada2 ? getTimeValue(entrada2.momento) : '-'}</td>
        <td>${saida2 ? getTimeValue(saida2.momento) : '-'}</td>
        <td>${missing ? `Faltam ${missing}` : 'Completo'}</td>
      </tr>`;
    }).join('');
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow?.document;
    if (!doc) return;
    doc.open();
    doc.write(`<!doctype html><html><head><title>Mapa de Pica-ponto</title><style>
      @page { size: A4 landscape; margin: 14mm; }
      body { font-family: Arial, sans-serif; color: #0f172a; }
      h1 { font-size: 20px; margin: 0 0 6px; }
      p { margin: 0 0 16px; color: #475569; font-size: 12px; }
      table { width: 100%; border-collapse: collapse; font-size: 11px; }
      th, td { border-bottom: 1px solid #cbd5e1; padding: 7px 8px; text-align: left; }
      th { background: #f1f5f9; font-size: 10px; text-transform: uppercase; }
    </style></head><body>
      <h1>Mapa de Pica-ponto</h1>
      <p>Período: ${formatDate(pontoStartDate)} a ${formatDate(pontoEndDate)}. Emitido em ${new Date().toLocaleDateString('pt-PT')}.</p>
      <table><thead><tr><th>Funcionário</th><th>Data</th><th>Entrada 1</th><th>Saída 1</th><th>Entrada 2</th><th>Saída 2</th><th>Estado</th></tr></thead><tbody>${rowsHtml}</tbody></table>
    </body></html>`);
    doc.close();
    iframe.onload = () => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      window.setTimeout(() => iframe.remove(), 1000);
    };
  };

  return (
    <div className="w-full space-y-4 p-4 md:p-6">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 text-white shadow-sm md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold md:text-2xl">Funcionários</h1>
            <p className="text-xs text-slate-200 md:text-sm">Gestão e permissões da equipa interna.</p>
          </div>
          <button
            onClick={() => openModal()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500 md:text-sm"
          >
            <Plus size={16} />
            Novo Funcionário
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        {employeesTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setEmployeesTab(tab.id)}
            className={`rounded-xl px-4 py-2 text-sm font-semibold ${
              employeesTab === tab.id
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {employeesTab === 'utilizadores' && (
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-3">
           <div className="relative max-w-md">
             <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
             <input type="text" placeholder="Procurar funcionário..." className="w-full rounded-md border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm" />
           </div>
        </div>
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
             <tr>
               <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Funcionário</th>
               <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Email</th>
               <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Função</th>
               <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Estado</th>
               <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Ações</th>
             </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
             {employees.map(user => {
               const presence = presenceByUserId[String(user?.id || '').trim()] || null;
               return (
               <tr 
                 key={user.id} 
                 className="hover:bg-gray-50 cursor-pointer"
                 onClick={() => openModal(user)}
               >
                 <td className="px-6 py-4 whitespace-nowrap">
                   <div className="flex items-center gap-3">
                      <img src={user.avatarUrl} className="w-8 h-8 rounded-full bg-gray-200 object-cover" alt="" />
                      <div className="text-sm font-medium text-gray-900">{user.name}</div>
                   </div>
                 </td>
                 <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 flex items-center gap-2">
                    <Mail size={14} /> {user.email}
                 </td>
                 <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-1 inline-flex items-center gap-1 text-xs leading-5 font-semibold rounded-full ${user.role === Role.ADMIN ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'}`}>
                          <Shield size={12} /> {user.role}
                      </span>
                      {user.isAiAssistant && (
                        <span className="px-2 py-1 inline-flex items-center gap-1 text-xs leading-5 font-semibold rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                          <Sparkles size={12} />
                          IA
                        </span>
                      )}
                    </div>
                 </td>
                 <td className="px-6 py-4 whitespace-nowrap">
                    <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700">
                      <span className={`h-2 w-2 rounded-full ${presence?.isOnline ? 'bg-emerald-500' : 'bg-slate-300'}`}></span>
                      {formatPresenceLabel(presence)}
                    </div>
                 </td>
                 <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button 
                        onClick={(e) => { e.stopPropagation(); openModal(user); }} 
                        className="text-gray-400 hover:text-whatsapp-600 p-2"
                        title="Editar funcionário"
                    >
                        <Edit2 size={16} />
                    </button>
                    <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteEmployee(user);
                        }}
                        disabled={deletingUserId === user.id || user.id === currentUserId}
                        className="text-gray-400 hover:text-red-600 p-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        title={user.id === currentUserId ? 'Não pode eliminar o seu utilizador' : 'Eliminar funcionário'}
                    >
                        <Trash2 size={16} />
                    </button>
                 </td>
               </tr>
             )})}
          </tbody>
        </table>
      </div>
      )}

      {employeesTab === 'fichas' && (
      <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Fichas dos funcionários</h2>
            <p className="text-sm text-slate-500">Abra uma ficha para ver informação, objetivos, picagens, férias e pedidos.</p>
          </div>
          {canManageHr && (
            <button
              onClick={handleHrSync}
              disabled={hrSyncing}
              className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {hrSyncing ? 'A sincronizar...' : 'Sincronizar Supabase'}
            </button>
          )}
        </div>

        {hrError && <div className="m-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{hrError}</div>}

        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {hrLoading ? (
            <p className="text-sm text-slate-500">A carregar fichas...</p>
          ) : hrFuncionarios.length === 0 ? (
            <p className="text-sm text-slate-500">Sem fichas RH locais. Sincronize primeiro.</p>
          ) : hrFuncionarios.map((funcionario) => (
            <button
              key={funcionario.id}
              onClick={() => openHrFicha(funcionario)}
              className="group flex min-h-[92px] items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-left transition hover:border-blue-200 hover:bg-blue-50"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-bold text-blue-700">
                  {funcionario.nome.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold text-slate-900">{funcionario.nome}</span>
                  <span className="block truncate text-xs text-slate-500">{funcionario.email || 'Sem email'}</span>
                  <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${funcionario.activo ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'}`}>
                    {funcionario.activo ? 'Ativo' : 'Inativo'}
                  </span>
                </span>
              </div>
              <span className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 group-hover:border-blue-200 group-hover:text-blue-700">
                Abrir ficha
              </span>
            </button>
          ))}
        </div>
      </section>
      )}

      {employeesTab === 'ponto' && (
        <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Gestão de pica-ponto</h2>
              <p className="text-sm text-slate-500">Picagens agrupadas por dia para corrigir horas, preencher faltas, exportar e imprimir.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={downloadPontoCsv}
                disabled={pontoGroups.length === 0}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <Download size={16} />
                Excel CSV
              </button>
              <button
                onClick={printPontoMap}
                disabled={pontoGroups.length === 0}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              >
                <Printer size={16} />
                Imprimir ACT
              </button>
            </div>
          </div>

          <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 md:grid-cols-[1fr_180px_180px_auto]">
            <label className="text-sm">
              <span className="font-semibold text-slate-700">Funcionário</span>
              <select
                value={pontoFuncionarioFilter}
                onChange={(e) => setPontoFuncionarioFilter(e.target.value)}
                className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3"
              >
                {canManageHr && <option value="all">Todos os funcionários</option>}
                {hrFuncionarios.map((funcionario) => (
                  <option key={funcionario.id} value={funcionario.id}>{funcionario.nome}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="font-semibold text-slate-700">De</span>
              <input type="date" value={pontoStartDate} onChange={(e) => setPontoStartDate(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3" />
            </label>
            <label className="text-sm">
              <span className="font-semibold text-slate-700">Até</span>
              <input type="date" value={pontoEndDate} onChange={(e) => setPontoEndDate(e.target.value)} className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3" />
            </label>
            <div className="flex items-end">
              <button onClick={loadPontoGestao} className="h-10 rounded-md bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700">
                Atualizar
              </button>
            </div>
          </div>

          {pontoGestaoError && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{pontoGestaoError}</div>}

          <div className="space-y-3">
            {pontoGestaoLoading ? (
              <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">A carregar picagens...</p>
            ) : pontoGroups.length === 0 ? (
              <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">Sem picagens no intervalo selecionado.</p>
            ) : pontoGroups.map((group) => {
              const slots = [
                { label: 'Entrada 1', tipo: 'ENTRADA' as const, registo: getPontoSlot(group.rows, 'ENTRADA', 0), index: 0 },
                { label: 'Saída 1', tipo: 'SAIDA' as const, registo: getPontoSlot(group.rows, 'SAIDA', 0), index: 1 },
                { label: 'Entrada 2', tipo: 'ENTRADA' as const, registo: getPontoSlot(group.rows, 'ENTRADA', 1), index: 2 },
                { label: 'Saída 2', tipo: 'SAIDA' as const, registo: getPontoSlot(group.rows, 'SAIDA', 1), index: 3 },
              ];
              const missing = slots.filter((slot) => !slot.registo).length;
              const pontoResumo = getPontoDiaResumo(group);
              return (
                <div key={group.key} className={`rounded-xl border p-4 ${missing ? 'border-amber-200 bg-amber-50/60' : 'border-slate-200 bg-white'}`}>
                  <div className="mb-3 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h3 className="font-bold text-slate-900">{group.funcionarioNome}</h3>
                      <p className="text-sm text-slate-500">
                        {formatDate(group.date)} · Trabalhadas {diffMinutesLabel(pontoResumo.workedMinutes).replace('+', '')} · Saldo {diffMinutesLabel(pontoResumo.balance)}
                      </p>
                    </div>
                    <span className={`w-fit rounded-full px-2.5 py-1 text-xs font-bold ${pontoResumo.status === 'OK' ? 'bg-emerald-100 text-emerald-800' : pontoResumo.status === 'Atraso' ? 'bg-orange-100 text-orange-800' : 'bg-amber-100 text-amber-800'}`}>
                      {pontoResumo.status}
                    </span>
                  </div>
                  <div className="grid gap-3 md:grid-cols-4">
                    {slots.map((slot) => {
                      const key = slot.registo?.id || `${group.key}-${slot.index}`;
                      const value = pontoTimeDrafts[key] ?? (slot.registo ? getTimeValue(slot.registo.momento) : '');
                      return (
                        <div key={key} className="rounded-lg border border-slate-200 bg-white p-3">
                          <label className="text-xs font-bold uppercase text-slate-500">{slot.label}</label>
                          <input
                            type="time"
                            value={value}
                            onChange={(e) => setPontoDraft(key, e.target.value)}
                            disabled={!canManageHr}
                            className="mt-2 h-10 w-full rounded-md border border-slate-300 px-3 text-sm disabled:bg-slate-100"
                          />
                          <div className="mt-2 flex gap-2">
                            {canManageHr && (
                              <button
                                onClick={() => savePontoSlot(group, slot.tipo, key, slot.registo)}
                                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-emerald-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                              >
                                {slot.registo ? <Save size={13} /> : <PlusCircle size={13} />}
                                {slot.registo ? 'Guardar' : 'Adicionar'}
                              </button>
                            )}
                            {canManageHr && slot.registo && (
                              <button
                                onClick={() => removePontoSlot(slot.registo!)}
                                className="rounded-md border border-rose-200 px-2 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                              >
                                <Trash2 size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {showHrFicha && selectedHrFuncionario && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 p-4 backdrop-blur-sm">
          <div className="flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Ficha detalhada: {selectedHrFuncionario.nome}</h2>
                <p className="mt-1 text-sm text-slate-500">Dados pessoais, objetivos, picagens, férias e histórico de pedidos.</p>
              </div>
              <button
                onClick={() => setShowHrFicha(false)}
                className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                title="Fechar"
              >
                <X size={18} />
              </button>
            </div>

            <div className="border-b border-slate-200 px-5 py-3">
              <div className="flex flex-wrap gap-2">
                {hrTabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveHrTab(tab.id)}
                    className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${
                      activeHrTab === tab.id
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-auto bg-slate-50/70 p-5">
              {activeHrTab === 'informacao' && (
                <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
                  <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <h3 className="text-sm font-bold text-slate-900">Dados pessoais</h3>
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      <label className="text-sm"><span className="font-semibold text-slate-700">Nome</span><input value={hrValue('nome')} onChange={(e) => setHrEditDraft((c) => ({ ...c, nome: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Email</span><input value={hrValue('email')} onChange={(e) => setHrEditDraft((c) => ({ ...c, email: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Telefone</span><input value={hrValue('telefone')} onChange={(e) => setHrEditDraft((c) => ({ ...c, telefone: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Data de nascimento</span><input type="date" value={hrValue('dataNascimento').slice(0, 10)} onChange={(e) => setHrEditDraft((c) => ({ ...c, dataNascimento: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Estado civil</span><input value={hrValue('estadoCivil')} onChange={(e) => setHrEditDraft((c) => ({ ...c, estadoCivil: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Filhos</span><select value={hrBoolValue('temFilhos') ? '1' : '0'} onChange={(e) => setHrEditDraft((c) => ({ ...c, temFilhos: e.target.value === '1' }))} disabled={!canManageHr} className={inputClass}><option value="0">Não</option><option value="1">Sim</option></select></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">N.º de filhos</span><input type="number" value={hrNumberValue('numeroFilhos')} onChange={(e) => setHrEditDraft((c) => ({ ...c, numeroFilhos: Number(e.target.value) || 0 }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm md:col-span-2"><span className="font-semibold text-slate-700">Contacto de emergência</span><input value={hrValue('contactoEmergencia')} onChange={(e) => setHrEditDraft((c) => ({ ...c, contactoEmergencia: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm md:col-span-2"><span className="font-semibold text-slate-700">Morada</span><input value={hrValue('morada')} onChange={(e) => setHrEditDraft((c) => ({ ...c, morada: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Código postal</span><input value={hrValue('codigoPostal')} onChange={(e) => setHrEditDraft((c) => ({ ...c, codigoPostal: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm md:col-span-3"><span className="font-semibold text-slate-700">Fotografia URL</span><input value={hrValue('fotoUrl')} onChange={(e) => setHrEditDraft((c) => ({ ...c, fotoUrl: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                    </div>
                  </section>

                  <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <h3 className="text-sm font-bold text-slate-900">Dados administrativos</h3>
                    <div className="mt-3 grid gap-3 md:grid-cols-4">
                      <label className="text-sm"><span className="font-semibold text-slate-700">N.º colaborador</span><input value={hrValue('numeroColaborador')} onChange={(e) => setHrEditDraft((c) => ({ ...c, numeroColaborador: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">NIF</span><input value={hrValue('nif')} onChange={(e) => setHrEditDraft((c) => ({ ...c, nif: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">NISS</span><input value={hrValue('niss')} onChange={(e) => setHrEditDraft((c) => ({ ...c, niss: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Cartão de Cidadão</span><input value={hrValue('cartaoCidadao')} onChange={(e) => setHrEditDraft((c) => ({ ...c, cartaoCidadao: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm md:col-span-2"><span className="font-semibold text-slate-700">IBAN</span><input value={hrValue('iban')} onChange={(e) => setHrEditDraft((c) => ({ ...c, iban: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Cargo</span><input value={hrValue('cargo')} onChange={(e) => setHrEditDraft((c) => ({ ...c, cargo: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Responsável direto</span><input value={hrValue('responsavelDireto')} onChange={(e) => setHrEditDraft((c) => ({ ...c, responsavelDireto: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Tipo de vínculo</span><select value={hrValue('tipoVinculo')} onChange={(e) => setHrEditDraft((c) => ({ ...c, tipoVinculo: e.target.value }))} disabled={!canManageHr} className={inputClass}><option value="">-</option><option>Efetivo</option><option>Termo certo</option><option>Prestação de serviços</option><option>Estágio</option><option>Temporário</option></select></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Data de admissão</span><input type="date" value={hrValue('dataAdmissao').slice(0, 10)} onChange={(e) => setHrEditDraft((c) => ({ ...c, dataAdmissao: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Data de saída</span><input type="date" value={hrValue('dataSaida').slice(0, 10)} onChange={(e) => setHrEditDraft((c) => ({ ...c, dataSaida: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Estado RH</span><select value={hrValue('estadoRh')} onChange={(e) => setHrEditDraft((c) => ({ ...c, estadoRh: e.target.value }))} disabled={!canManageHr} className={inputClass}><option value="">-</option><option>Ativo</option><option>Inativo</option><option>Suspenso</option><option>Em férias</option><option>Baixa</option><option>Cessado</option></select></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Estado sistema</span><select value={hrBoolValue('activo') ? '1' : '0'} onChange={(e) => setHrEditDraft((c) => ({ ...c, activo: e.target.value === '1' }))} disabled={!canManageHr} className={inputClass}><option value="1">Ativo</option><option value="0">Inativo</option></select></label>
                      <label className="text-sm md:col-span-4"><span className="font-semibold text-slate-700">Observações internas</span><textarea value={hrValue('observacoesInternas')} onChange={(e) => setHrEditDraft((c) => ({ ...c, observacoesInternas: e.target.value }))} disabled={!canManageHr} rows={3} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 disabled:bg-slate-100 disabled:text-slate-600" /></label>
                    </div>
                  </section>

                  <section className="rounded-xl border border-blue-100 bg-blue-50/50 p-4">
                    <h3 className="text-sm font-bold text-slate-900">Regras de pica-ponto</h3>
                    <div className="mt-3 grid gap-3 md:grid-cols-4">
                      <label className="text-sm"><span className="font-semibold text-slate-700">PIN</span><input value={hrValue('pin')} onChange={(e) => setHrEditDraft((c) => ({ ...c, pin: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Tipo de horário</span><select value={hrValue('tipoHorario')} onChange={(e) => setHrEditDraft((c) => ({ ...c, tipoHorario: e.target.value }))} disabled={!canManageHr} className={inputClass}><option value="">-</option><option>Fixo</option><option>Flexível</option><option>Turnos</option><option>Rotativo</option><option>Isenção</option></select></label>
                      <label className="text-sm md:col-span-2"><span className="font-semibold text-slate-700">Modelo semanal / dias de trabalho</span><input value={hrValue('diasTrabalho')} onChange={(e) => setHrEditDraft((c) => ({ ...c, diasTrabalho: e.target.value }))} placeholder="Segunda a sexta" disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Entrada prevista</span><input type="time" value={hrValue('horaEntradaPrevista')} onChange={(e) => setHrEditDraft((c) => ({ ...c, horaEntradaPrevista: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Saída prevista</span><input type="time" value={hrValue('horaSaidaPrevista')} onChange={(e) => setHrEditDraft((c) => ({ ...c, horaSaidaPrevista: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Almoço início</span><input type="time" value={hrValue('pausaAlmocoInicio')} onChange={(e) => setHrEditDraft((c) => ({ ...c, pausaAlmocoInicio: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Almoço fim</span><input type="time" value={hrValue('pausaAlmocoFim')} onChange={(e) => setHrEditDraft((c) => ({ ...c, pausaAlmocoFim: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Tolerância entrada (min)</span><input type="number" value={hrNumberValue('toleranciaEntradaMin')} onChange={(e) => setHrEditDraft((c) => ({ ...c, toleranciaEntradaMin: Number(e.target.value) || 0 }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Tolerância saída (min)</span><input type="number" value={hrNumberValue('toleranciaSaidaMin')} onChange={(e) => setHrEditDraft((c) => ({ ...c, toleranciaSaidaMin: Number(e.target.value) || 0 }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Horas diárias</span><input type="number" step="0.25" value={hrNumberValue('horasDiariasPrevistas') || 8} onChange={(e) => setHrEditDraft((c) => ({ ...c, horasDiariasPrevistas: Number(e.target.value) || 0 }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Horas semanais</span><input type="number" step="0.25" value={hrNumberValue('horasSemanaisContratadas') || 40} onChange={(e) => setHrEditDraft((c) => ({ ...c, horasSemanaisContratadas: Number(e.target.value) || 0 }))} disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm md:col-span-2"><span className="font-semibold text-slate-700">Horário de trabalho</span><input value={hrValue('horarioTrabalho')} onChange={(e) => setHrEditDraft((c) => ({ ...c, horarioTrabalho: e.target.value }))} placeholder="Ex: 09:00 às 18:00" disabled={!canManageHr} className={inputClass} /></label>
                      <label className="text-sm md:col-span-2"><span className="font-semibold text-slate-700">Local habitual de trabalho</span><input value={hrValue('localTrabalho')} onChange={(e) => setHrEditDraft((c) => ({ ...c, localTrabalho: e.target.value }))} disabled={!canManageHr} className={inputClass} /></label>
                    </div>
                  </section>
                </div>
              )}

              {activeHrTab === 'objetivos' && (
                <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="flex flex-wrap gap-2">
                      {canManageHr && (
                        <>
                          <button onClick={addObjetivo} className="rounded-md border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">+ Adicionar objetivo</button>
                          <button onClick={distributeObjetivos} className="rounded-md border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Distribuir 100%</button>
                          <button onClick={applyObjetivosAll} disabled={objetivosSaving} className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50">Aplicar a todos</button>
                        </>
                      )}
                    </div>
                    <p className="text-sm font-semibold text-slate-400">Objetivos em SQL local, mensuráveis por meta, peso e erros.</p>
                  </div>

                  {objetivosError && <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{objetivosError}</div>}

                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-semibold">Objetivos: {objetivosResumo.total}</span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-semibold">Atingidos: {objetivosResumo.atingidos}</span>
                    <span className={`rounded-full border px-2.5 py-1 font-semibold ${objetivosResumo.pesoValido ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>Peso total: {objetivosResumo.pesoTotal}/100%</span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-semibold">Meta total: {objetivosResumo.metaTotal}</span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-semibold">Total atingido: {objetivosResumo.atingidoTotal}</span>
                    <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 font-semibold text-rose-700">Bruta: {objetivosResumo.percentBruta}%</span>
                    <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 font-semibold text-rose-700">Final: {objetivosResumo.percentFinal}%</span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-semibold">Erros: {objetivosResumo.errosTotal}</span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-semibold">1 erro (-50%): {objetivosResumo.umErro}</span>
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 font-semibold">2+ erros (-100%): {objetivosResumo.doisErros}</span>
                  </div>

                  {objetivosLoading ? (
                    <p className="text-sm text-slate-500">A carregar objetivos...</p>
                  ) : (
                    <div className="space-y-2">
                      <div className="hidden grid-cols-[minmax(260px,1fr)_140px_110px_110px_110px_100px_120px_44px] gap-2 px-2 text-xs font-bold uppercase text-slate-500 xl:grid">
                        <span>Objetivo</span><span>Data</span><span>Tipo</span><span>Meta</span><span>Atingido</span><span>Peso</span><span>Erros</span><span>Ações</span>
                      </div>
                      {objetivosItems.length === 0 ? (
                        <p className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">Sem objetivos definidos.</p>
                      ) : objetivosItems.map((item, index) => (
                        <div key={item.id} className="grid gap-2 rounded-xl border border-blue-100 bg-blue-50/40 p-3 xl:grid-cols-[minmax(260px,1fr)_140px_110px_110px_110px_100px_120px_44px]">
                          <div className="flex items-center gap-2">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-blue-200 bg-blue-100 text-xs font-bold text-blue-700">{index + 1}</span>
                            <input value={item.titulo} onChange={(e) => updateObjetivo(item.id, { titulo: e.target.value })} disabled={!canManageHr} className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm disabled:bg-slate-100" />
                          </div>
                          <input type="date" value={String(item.deadline || '').slice(0, 10)} onChange={(e) => updateObjetivo(item.id, { deadline: e.target.value })} disabled={!canManageHr} className="h-10 rounded-md border border-slate-300 px-3 text-sm disabled:bg-slate-100" />
                          <select value={item.metaTipo} onChange={(e) => updateObjetivo(item.id, { metaTipo: e.target.value === 'PERCENT' ? 'PERCENT' : 'QTD' })} disabled={!canManageHr} className="h-10 rounded-md border border-slate-300 px-3 text-sm disabled:bg-slate-100">
                            <option value="QTD">Qtd</option>
                            <option value="PERCENT">%</option>
                          </select>
                          <input type="number" value={item.meta} onChange={(e) => updateObjetivo(item.id, { meta: clampObjetivoNumber(e.target.value) })} disabled={!canManageHr} className="h-10 rounded-md border border-slate-300 px-3 text-sm disabled:bg-slate-100" />
                          <input type="number" value={item.atingido} onChange={(e) => updateObjetivo(item.id, { atingido: clampObjetivoNumber(e.target.value) })} disabled={!canManageHr} className="h-10 rounded-md border border-slate-300 px-3 text-sm disabled:bg-slate-100" />
                          <input type="number" value={item.peso} onChange={(e) => updateObjetivo(item.id, { peso: clampObjetivoNumber(e.target.value, 100) })} disabled={!canManageHr} className="h-10 rounded-md border border-slate-300 px-3 text-sm disabled:bg-slate-100" />
                          <div className="flex gap-2">
                            <input type="number" value={item.erros} onChange={(e) => updateObjetivo(item.id, { erros: Math.round(clampObjetivoNumber(e.target.value, 999)) })} disabled={!canManageHr} className="h-10 min-w-0 flex-1 rounded-md border border-slate-300 px-3 text-sm disabled:bg-slate-100" />
                            <span className={`flex h-10 w-16 items-center justify-center rounded-md border text-sm font-bold ${objetivoPercent(item) >= 80 ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>{objetivoPercent(item)}%</span>
                          </div>
                          {canManageHr && (
                            <button
                              onClick={() => setObjetivosItems((current) => current.filter((row) => row.id !== item.id))}
                              className="flex h-10 w-10 items-center justify-center rounded-md border border-rose-200 text-rose-700 hover:bg-rose-50"
                              title="Remover objetivo"
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <label className="block text-sm">
                    <span className="font-semibold text-slate-700">Notas gerais dos objetivos</span>
                    <textarea value={objetivosConfig.notasGerais} onChange={(e) => setObjetivosConfig((current) => ({ ...current, notasGerais: e.target.value }))} disabled={!canManageHr} rows={3} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-100" />
                  </label>

                  <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4">
                    <h4 className="font-bold text-slate-900">Incentivos por patamares</h4>
                    <p className="mt-1 text-sm text-slate-500">Regra: 1 erro reduz 50% do objetivo; 2 ou mais erros anulam o objetivo.</p>
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <label className="text-sm"><span className="font-semibold text-slate-700">Ao atingir 50%</span><input value={objetivosConfig.patamar50} onChange={(e) => setObjetivosConfig((current) => ({ ...current, patamar50: e.target.value }))} disabled={!canManageHr} className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 disabled:bg-slate-100" /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Ao atingir 65%</span><input value={objetivosConfig.patamar65} onChange={(e) => setObjetivosConfig((current) => ({ ...current, patamar65: e.target.value }))} disabled={!canManageHr} className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 disabled:bg-slate-100" /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Ao atingir 80%</span><input value={objetivosConfig.patamar80} onChange={(e) => setObjetivosConfig((current) => ({ ...current, patamar80: e.target.value }))} disabled={!canManageHr} className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 disabled:bg-slate-100" /></label>
                      <label className="text-sm"><span className="font-semibold text-slate-700">Prémio máximo (EUR)</span><input type="number" value={objetivosConfig.premioMaximo} onChange={(e) => setObjetivosConfig((current) => ({ ...current, premioMaximo: clampObjetivoNumber(e.target.value) }))} disabled={!canManageHr} className="mt-1 h-10 w-full rounded-md border border-slate-300 px-3 disabled:bg-slate-100" /></label>
                    </div>
                  </div>
                </div>
              )}

              {activeHrTab === 'picagens' && (
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800">
                    <Clock size={16} />
                    Picagens de {new Date().getFullYear()}
                  </div>
                  {hrRegistosPonto.length === 0 ? (
                    <p className="text-sm text-slate-500">Sem picagens neste ano.</p>
                  ) : (
                    <div className="space-y-3">
                      {fichaPontoGroups.map((group) => {
                        const slots = [
                          { label: 'Entrada 1', tipo: 'ENTRADA' as const, registo: getPontoSlot(group.rows, 'ENTRADA', 0), index: 0 },
                          { label: 'Saída 1', tipo: 'SAIDA' as const, registo: getPontoSlot(group.rows, 'SAIDA', 0), index: 1 },
                          { label: 'Entrada 2', tipo: 'ENTRADA' as const, registo: getPontoSlot(group.rows, 'ENTRADA', 1), index: 2 },
                          { label: 'Saída 2', tipo: 'SAIDA' as const, registo: getPontoSlot(group.rows, 'SAIDA', 1), index: 3 },
                        ];
                        const missing = slots.filter((slot) => !slot.registo).length;
                        const pontoResumo = getPontoDiaResumo(group);
                        return (
                          <div key={group.key} className={`rounded-xl border p-3 ${missing ? 'border-amber-200 bg-amber-50/60' : 'border-slate-200 bg-slate-50'}`}>
                            <div className="mb-2 flex items-center justify-between">
                              <div>
                                <h3 className="font-bold text-slate-900">{formatDate(group.date)}</h3>
                                <p className="text-xs text-slate-500">Trabalhadas {diffMinutesLabel(pontoResumo.workedMinutes).replace('+', '')} · Saldo {diffMinutesLabel(pontoResumo.balance)}</p>
                              </div>
                              <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${pontoResumo.status === 'OK' ? 'bg-emerald-100 text-emerald-800' : pontoResumo.status === 'Atraso' ? 'bg-orange-100 text-orange-800' : 'bg-amber-100 text-amber-800'}`}>
                                {pontoResumo.status}
                              </span>
                            </div>
                            <div className="grid gap-2 md:grid-cols-4">
                              {slots.map((slot) => {
                                const key = slot.registo?.id || `ficha-${group.key}-${slot.index}`;
                                const value = pontoTimeDrafts[key] ?? (slot.registo ? getTimeValue(slot.registo.momento) : '');
                                return (
                                  <div key={key} className="rounded-lg border border-slate-200 bg-white p-2">
                                    <label className="text-[11px] font-bold uppercase text-slate-500">{slot.label}</label>
                                    <input
                                      type="time"
                                      value={value}
                                      onChange={(e) => setPontoDraft(key, e.target.value)}
                                      disabled={!canManageHr}
                                      className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-sm disabled:bg-slate-100"
                                    />
                                    {canManageHr && (
                                      <div className="mt-2 flex gap-1">
                                        <button onClick={() => saveFichaPontoSlot(group, slot.tipo, key, slot.registo)} className="flex h-8 flex-1 items-center justify-center rounded-md bg-emerald-600 text-xs font-semibold text-white hover:bg-emerald-700">
                                          {slot.registo ? 'Guardar' : 'Adicionar'}
                                        </button>
                                        {slot.registo && (
                                          <button onClick={() => removeFichaPontoSlot(slot.registo!)} className="flex h-8 w-8 items-center justify-center rounded-md border border-rose-200 text-rose-700 hover:bg-rose-50" title="Apagar picagem">
                                            <Trash2 size={14} />
                                          </button>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                      {hrRegistosPonto.length > fichaPontoGroups.reduce((acc, group) => acc + group.rows.length, 0) && (
                        <p className="text-xs text-slate-500">Existem picagens adicionais fora do agrupamento apresentado.</p>
                      )}
                      <div className="rounded-lg border border-slate-200 bg-white p-3">
                        <p className="text-xs font-bold uppercase text-slate-500">Registos extra do ano</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {hrRegistosPonto.slice(0, 120).map((registo) => (
                            <span key={registo.id} className={`rounded-full px-2 py-1 text-xs font-semibold ${registo.tipo.includes('SA') ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>
                              {formatDateTime(registo.momento)} · {registo.tipo}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeHrTab === 'ferias' && (
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800">
                    <CalendarDays size={16} />
                    Férias aprovadas
                  </div>
                  {approvedVacationPedidos.length === 0 ? (
                    <p className="text-sm text-slate-500">Sem férias aprovadas neste ano.</p>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      {approvedVacationPedidos.map((pedido) => {
                        const existingSchedule = getEmailAutoReplyForPedido(pedido.id);
                        const schedule = existingSchedule || {
                          id: `draft-${pedido.id}`,
                          pedidoId: pedido.id,
                          funcionarioId: selectedHrFuncionario.id,
                          funcionarioNome: selectedHrFuncionario.nome,
                          email: selectedHrFuncionario.email || '',
                          enabled: true,
                          subject: 'Ausência temporária',
                          message: formatAutoReplyMessage(selectedHrFuncionario.nome, pedido.dataInicio, pedido.dataFim || pedido.dataInicio),
                          alternateContactEmail: 'geral@mpr.pt',
                          alternateContactPhone: '+351 253 561 548',
                          templateVariant: 'default' as const,
                          mode: 'manual' as const,
                          manualUrl: 'https://plesk5100.is.cc:8443',
                          startDate: String(pedido.dataInicio || '').slice(0, 10),
                          endDate: String(pedido.dataFim || pedido.dataInicio || '').slice(0, 10),
                          deactivateDate: '',
                          status: 'manual_necessario' as const,
                        };
                        const statusMeta = getEmailAutoReplyStatusMeta(schedule?.status);
                        return (
                          <div key={pedido.id} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <p className="font-bold text-emerald-900">{formatDate(pedido.dataInicio)} a {formatDate(pedido.dataFim)}</p>
                                <p className="mt-1 text-emerald-800">{pedido.descricao || 'Férias'}</p>
                              </div>
                              {schedule && (
                                <span className={`rounded-full border px-2 py-1 text-xs font-bold ${statusMeta.className}`}>
                                  {statusMeta.label}
                                </span>
                              )}
                            </div>
                            {pedido.resolucao && <p className="mt-1 text-xs text-emerald-700">Decisão: {pedido.resolucao}</p>}
                            <div className="mt-3 rounded-lg border border-amber-200 bg-white p-3">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                  <p className="text-xs font-bold uppercase text-slate-500">Aviso de email</p>
                                  <p className="mt-1 font-semibold text-slate-900">{schedule.subject}</p>
                                </div>
                                <span className={`rounded-full border px-2 py-1 text-xs font-bold ${statusMeta.className}`}>
                                  {statusMeta.label}
                                </span>
                              </div>
                              {schedule.mode === 'manual' && schedule.status !== 'ativo' && schedule.status !== 'desativado' && (
                                <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                                  Ativação manual necessária. Este servidor não permite automação por SSH/API. Copie a mensagem abaixo e configure manualmente o autoresponder no Plesk.
                                </p>
                              )}
                              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">{schedule.message}</pre>
                              {schedule?.lastError && <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700">{schedule.lastError}</p>}
                              {emailAutoReplyCopyId === schedule.id && <p className="mt-2 text-xs font-semibold text-emerald-700">Mensagem copiada.</p>}
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                onClick={() => copyEmailAutoReplyMessage(schedule)}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                              >
                                <Copy size={13} />
                                Copiar mensagem
                              </button>
                              <button
                                onClick={() => openEmailAutoReplyManualUrl(schedule)}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                              >
                                <ExternalLink size={13} />
                                Abrir Plesk/Webmail
                              </button>
                              {canManageHr && (
                                <button
                                  onClick={() => openEmailAutoReplyModal(pedido)}
                                  className="rounded-md border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                                >
                                  {existingSchedule ? 'Editar aviso' : 'Guardar aviso'}
                                </button>
                              )}
                              {canManageHr && existingSchedule && schedule.status !== 'ativo' && (
                                <button
                                  onClick={() => runEmailAutoReplyNow(schedule, 'mark_activated')}
                                  disabled={emailAutoReplySaving}
                                  className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                                >
                                  <CheckCircle size={13} />
                                  Marcar como ativado manualmente
                                </button>
                              )}
                              {canManageHr && existingSchedule && schedule.status !== 'desativado' && (
                                <button
                                  onClick={() => runEmailAutoReplyNow(schedule, 'mark_deactivated')}
                                  disabled={emailAutoReplySaving}
                                  className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                                >
                                  Marcar como desativado manualmente
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {emailAutoReplyLoading && <p className="mt-3 text-xs text-slate-500">A carregar avisos automáticos...</p>}
                  {emailAutoReplyError && <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{emailAutoReplyError}</p>}
                </div>
              )}

              {activeHrTab === 'pedidos' && (
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-3 grid gap-3 md:grid-cols-4">
                    <div className="rounded-lg border border-slate-200 p-3">
                      <p className="text-xs uppercase text-slate-500">Total</p>
                      <p className="text-2xl font-bold">{hrPedidos.length}</p>
                    </div>
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <p className="text-xs uppercase text-emerald-700">Aprovados</p>
                      <p className="text-2xl font-bold text-emerald-800">{hrPedidos.filter((p) => p.status === 'APROVADO').length}</p>
                    </div>
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <p className="text-xs uppercase text-amber-700">Pendentes</p>
                      <p className="text-2xl font-bold text-amber-800">{hrPedidos.filter((p) => p.status === 'PENDENTE').length}</p>
                    </div>
                    <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
                      <p className="text-xs uppercase text-rose-700">Rejeitados</p>
                      <p className="text-2xl font-bold text-rose-800">{hrPedidos.filter((p) => p.status === 'REJEITADO').length}</p>
                    </div>
                  </div>
                  <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
                    {hrPedidos.length === 0 ? (
                      <p className="p-4 text-sm text-slate-500">Sem pedidos neste ano.</p>
                    ) : hrPedidos.map((pedido) => (
                      <div key={pedido.id} className="grid gap-2 p-4 text-sm md:grid-cols-[150px_1fr_120px] md:items-center">
                        <div>
                          <p className="font-bold uppercase text-slate-800">{pedido.tipo.replace(/_/g, ' ')}</p>
                          <p className="text-xs text-slate-500">{formatDate(pedido.dataInicio)} a {formatDate(pedido.dataFim)}</p>
                        </div>
                        <p className="text-slate-700">{pedido.descricao || 'Sem descrição'}{pedido.resolucao ? ` | ${pedido.resolucao}` : ''}</p>
                        <span className={`rounded-full px-2 py-1 text-center text-xs font-bold ${
                          pedido.status === 'APROVADO' ? 'bg-emerald-100 text-emerald-800' :
                          pedido.status === 'REJEITADO' ? 'bg-rose-100 text-rose-800' :
                          'bg-amber-100 text-amber-800'
                        }`}>
                          {pedido.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 bg-white px-5 py-4">
              <button onClick={() => setShowHrFicha(false)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                Cancelar
              </button>
              {canManageHr && (
                <button onClick={saveHrFuncionario} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
                  Guardar alterações
                </button>
              )}
              {canManageHr && activeHrTab === 'objetivos' && (
                <button onClick={saveObjetivos} disabled={objetivosSaving} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
                  {objetivosSaving ? 'A guardar...' : 'Guardar objetivos'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showEmailAutoReplyModal && selectedHrFuncionario && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Aviso automático de email</h2>
                <p className="mt-1 text-sm text-slate-500">Agendamento do auto-reply no servidor de email para {selectedHrFuncionario.nome}.</p>
              </div>
              <button
                onClick={() => setShowEmailAutoReplyModal(false)}
                className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                title="Fechar"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-auto bg-slate-50/70 p-5">
              {emailAutoReplyError && (
                <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {emailAutoReplyError}
                </div>
              )}
              <label className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">
                <input
                  type="checkbox"
                  checked={emailAutoReplyDraft.enabled !== false}
                  onChange={(e) => setEmailAutoReplyDraft((current) => ({ ...current, enabled: e.target.checked }))}
                  className="h-4 w-4"
                />
                Ativar resposta automática neste período
              </label>

              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-sm">
                  <span className="font-semibold text-slate-700">Email da funcionária</span>
                  <input
                    value={String(emailAutoReplyDraft.email || '')}
                    onChange={(e) => setEmailAutoReplyDraft((current) => ({ ...current, email: e.target.value }))}
                    className={inputClass}
                  />
                </label>
                <label className="text-sm">
                  <span className="font-semibold text-slate-700">Contacto alternativo email</span>
                  <input
                    value={String(emailAutoReplyDraft.alternateContactEmail || '')}
                    onChange={(e) => setEmailAutoReplyDraft((current) => ({
                      ...current,
                      alternateContactEmail: e.target.value,
                      alternateContact: `${e.target.value}${current.alternateContactPhone ? ` ou ${current.alternateContactPhone}` : ''}`,
                    }))}
                    className={inputClass}
                  />
                </label>
                <label className="text-sm">
                  <span className="font-semibold text-slate-700">Contacto alternativo telefone</span>
                  <input
                    value={String(emailAutoReplyDraft.alternateContactPhone || '')}
                    onChange={(e) => setEmailAutoReplyDraft((current) => ({
                      ...current,
                      alternateContactPhone: e.target.value,
                      alternateContact: `${current.alternateContactEmail || 'geral@mpr.pt'}${e.target.value ? ` ou ${e.target.value}` : ''}`,
                    }))}
                    className={inputClass}
                  />
                </label>
                <label className="text-sm">
                  <span className="font-semibold text-slate-700">Data início</span>
                  <input
                    type="date"
                    value={String(emailAutoReplyDraft.startDate || '').slice(0, 10)}
                    onChange={(e) => setEmailAutoReplyDraft((current) => ({ ...current, startDate: e.target.value }))}
                    className={inputClass}
                  />
                </label>
                <label className="text-sm">
                  <span className="font-semibold text-slate-700">Data fim</span>
                  <input
                    type="date"
                    value={String(emailAutoReplyDraft.endDate || '').slice(0, 10)}
                    onChange={(e) => setEmailAutoReplyDraft((current) => ({ ...current, endDate: e.target.value }))}
                    className={inputClass}
                  />
                </label>
                <label className="text-sm md:col-span-2">
                  <span className="font-semibold text-slate-700">Modelo da mensagem</span>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <select
                      value={emailAutoReplyDraft.templateVariant || 'default'}
                      onChange={(e) => setEmailAutoReplyDraft((current) => ({ ...current, templateVariant: e.target.value === 'simple' ? 'simple' : 'default' }))}
                      className="h-10 flex-1 rounded-md border border-slate-300 px-3"
                    >
                      <option value="default">Completa</option>
                      <option value="simple">Simples</option>
                    </select>
                    <button
                      type="button"
                      onClick={regenerateEmailAutoReplyDraft}
                      className="rounded-md border border-blue-200 bg-blue-50 px-3 text-sm font-semibold text-blue-700 hover:bg-blue-100"
                    >
                      Gerar novamente
                    </button>
                  </div>
                </label>
                <label className="text-sm md:col-span-2">
                  <span className="font-semibold text-slate-700">Assunto</span>
                  <input
                    value={String(emailAutoReplyDraft.subject || '')}
                    onChange={(e) => setEmailAutoReplyDraft((current) => ({ ...current, subject: e.target.value }))}
                    className={inputClass}
                  />
                </label>
                <label className="text-sm md:col-span-2">
                  <span className="font-semibold text-slate-700">Mensagem automática</span>
                  <textarea
                    value={String(emailAutoReplyDraft.message || '')}
                    onChange={(e) => setEmailAutoReplyDraft((current) => ({ ...current, message: e.target.value }))}
                    rows={10}
                    className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
                <p><span className="font-semibold text-slate-800">Ativação:</span> no primeiro dia das férias.</p>
                <p className="mt-1"><span className="font-semibold text-slate-800">Desativação:</span> no dia seguinte ao fim das férias, ou na data configurada no Plesk.</p>
                {emailAutoReplyDraft.status && (
                  <p className="mt-1"><span className="font-semibold text-slate-800">Estado atual:</span> {getEmailAutoReplyStatusMeta(emailAutoReplyDraft.status).label}</p>
                )}
                {emailAutoReplyDraft.lastError && (
                  <p className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-700">{emailAutoReplyDraft.lastError}</p>
                )}
              </div>

              {Array.isArray(emailAutoReplyDraft.logs) && emailAutoReplyDraft.logs.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <h3 className="text-sm font-bold text-slate-900">Últimos logs</h3>
                  <div className="mt-2 space-y-2">
                    {emailAutoReplyDraft.logs.slice(0, 5).map((log) => (
                      <div key={log.id} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                        <span className="font-semibold text-slate-800">{formatDateTime(log.createdAt)}</span>
                        {' · '}
                        <span className="font-semibold">{log.action}</span>
                        {' · '}
                        {log.message}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 bg-white px-5 py-4">
              <button
                onClick={() => setShowEmailAutoReplyModal(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                onClick={saveEmailAutoReply}
                disabled={emailAutoReplySaving}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {emailAutoReplySaving ? 'A guardar...' : 'Guardar aviso'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
           <div className="bg-white rounded-lg w-full max-w-md p-6">
              <h2 className="text-lg font-bold mb-4">
                  {editingUser ? 'Editar Funcionário' : 'Novo Funcionário'}
              </h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                 <div>
                    <label className="block text-sm font-medium text-gray-700">Foto</label>
                    <div className="mt-2 flex items-center gap-4">
                      <img
                        src={formData.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(formData.name || 'User')}&background=random`}
                        className="w-14 h-14 rounded-full bg-gray-200 object-cover"
                        alt="Foto do funcionário"
                      />
                      <div className="flex-1">
                        <input
                          type="file"
                          accept="image/*"
                          className="block w-full text-xs text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200"
                          onChange={handlePhotoFileChange}
                        />
                      </div>
                    </div>
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700">Nome</label>
                    <input required type="text" className="mt-1 w-full border rounded-md p-2" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700">Email</label>
                    <input required type="email" className="mt-1 w-full border rounded-md p-2" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} />
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700">Palavra-passe</label>
                    <input
                      required
                      type="password"
                      className="mt-1 w-full border rounded-md p-2"
                      value={formData.password}
                      onChange={e => setFormData({...formData, password: e.target.value})}
                    />
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700">Função</label>
                    <select 
                       className="mt-1 w-full border rounded-md p-2"
                       value={formData.role}
                       onChange={e => setFormData({...formData, role: e.target.value as Role})}
                    >
                       <option value={Role.AGENT}>Agente</option>
                       <option value={Role.ADMIN}>Administrador</option>
                    </select>
                 </div>
                 <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                    <label className="inline-flex items-center gap-2 text-sm font-medium text-emerald-900">
                      <input
                        type="checkbox"
                        checked={formData.isAiAssistant}
                        onChange={(e) => setFormData({ ...formData, isAiAssistant: e.target.checked })}
                      />
                      Funcionário IA (responde no Chat Interno)
                    </label>
                    <p className="mt-1 text-xs text-emerald-800">Sites permitidos (um por linha). A IA consulta apenas estes domínios.</p>
                    <textarea
                      rows={4}
                      value={formData.aiAllowedSitesText}
                      onChange={(e) => setFormData({ ...formData, aiAllowedSitesText: e.target.value })}
                      placeholder="https://www.portaldasfinancas.gov.pt\nhttps://eportugal.gov.pt"
                      className="mt-2 w-full border rounded-md p-2 text-sm"
                    />
                  </div>
                 <div className="flex justify-end gap-2 mt-6">
                    <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-gray-600">Cancelar</button>
                    <button type="submit" className="px-4 py-2 bg-whatsapp-600 text-white rounded-md">Guardar</button>
                 </div>
              </form>
           </div>
        </div>
      )}
    </div>
  );
};

export default Employees;
