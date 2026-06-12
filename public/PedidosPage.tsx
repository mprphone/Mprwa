import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmModal';
import { Skeleton } from '../components';
import {
  COMPANY_PERIOD_DEFAULT_TITLE,
  clampRangeToYear,
  getDefaultSaldoDraft,
  isFolgaType,
  isMissingRelationError,
  isPedidoAprovado,
  isVacationType,
  isWeekend,
  iterateBusinessDates,
  normalizeIsoDate,
  normalizePedidoDescricao,
  normalizePedidoStatus,
  normalizePedidoTipo,
  normalizePeriodTargets,
  safeNumber,
  type FeriasSaldo,
  type SaldoDraft,
} from './pedidos/pedidosUtils';
import { usePageHero } from '../hooks/usePageHero';

type PedidoStatus = 'PENDENTE' | 'APROVADO' | 'REJEITADO';

type Pedido = {
  id: string;
  created_at: string;
  tipo: string;
  descricao: string;
  data_inicio: string;
  data_fim: string;
  status: PedidoStatus;
  funcionario_id?: string;
  atribuido_a?: string;
  funcionario_nome?: string;
  resolucao?: string;
};

type Funcionario = {
  id: string;
  nome: string;
  email?: string;
};

type Holiday = {
  date: string;
  name: string;
};

type FeriasEmpresaPeriodo = {
  id: string;
  titulo: string;
  descricao: string | null;
  data_inicio: string;
  data_fim: string;
  funcionarios_alvo: string[] | null;
  created_by: string | null;
  created_at: string;
};

type MeResolution = {
  id: string | null;
  viaRpc: boolean;
};

export default function PedidosPage() {
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [funcionarios, setFuncionarios] = useState<Funcionario[]>([]);
  const [loading, setLoading] = useState(true);
  const [isManager, setIsManager] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [authLinkWarning, setAuthLinkWarning] = useState<string | null>(null);

  const [filterStatus, setFilterStatus] = useState('');
  const [filterFuncionario, setFilterFuncionario] = useState('');

  const [viewMode, setViewMode] = useState<'LIST' | 'CALENDAR'>('LIST');
  const [currentDate, setCurrentDate] = useState(new Date());

  const [editingPedido, setEditingIdPedido] = useState<Pedido | null>(null);
  const [editForm, setEditForm] = useState<{
    tipo: string;
    data_inicio: string;
    data_fim: string;
    descricao: string;
    resolucao: string;
    status: PedidoStatus;
  } | null>(null);

  const [holidays, setHolidays] = useState<Set<string>>(new Set());
  const [holidayList, setHolidayList] = useState<Holiday[]>([]);
  const [newHoliday, setNewHoliday] = useState({ date: '', name: '' });

  const [managementYear, setManagementYear] = useState<number>(new Date().getFullYear());
  const [feriasSaldos, setFeriasSaldos] = useState<FeriasSaldo[]>([]);
  const [empresaPeriodos, setEmpresaPeriodos] = useState<FeriasEmpresaPeriodo[]>([]);
  const [saldoDrafts, setSaldoDrafts] = useState<Record<string, SaldoDraft>>({});
  const [savingSaldoFor, setSavingSaldoFor] = useState<string | null>(null);

  const [managementSchemaReady, setManagementSchemaReady] = useState(true);
  const [managementError, setManagementError] = useState<string | null>(null);
  const [newCompanyPeriod, setNewCompanyPeriod] = useState({
    titulo: COMPANY_PERIOD_DEFAULT_TITLE,
    descricao: '',
    data_inicio: '',
    data_fim: '',
    aplicar_todos: true,
  });
  const [companyTargets, setCompanyTargets] = useState<string[]>([]);

  const resolveMyFuncionario = useCallback(async (user: { id: string; email?: string | null } | null): Promise<MeResolution> => {
    if (!user) return { id: null, viaRpc: false };

    const rpc = await supabase.rpc('get_my_funcionario_id');
    if (!rpc.error && rpc.data) {
      return { id: String(rpc.data), viaRpc: true };
    }

    const byUserId = await supabase
      .from('funcionarios')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!byUserId.error && byUserId.data?.id) {
      return { id: String(byUserId.data.id), viaRpc: false };
    }

    if (user.email) {
      const byEmail = await supabase
        .from('funcionarios')
        .select('id')
        .ilike('email', user.email.trim())
        .maybeSingle();

      if (!byEmail.error && byEmail.data?.id) {
        return { id: String(byEmail.data.id), viaRpc: false };
      }
    }

    return { id: null, viaRpc: false };
  }, []);

  const checkUser = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const me = await resolveMyFuncionario({ id: user.id, email: user.email });
    setCurrentUserId(me.id);

    if (user.email === 'mpr@mpr.pt') {
      setIsManager(true);
      setAuthLinkWarning(null);
      return;
    }

    if (!me.id) {
      setAuthLinkWarning('Conta sem ligacao ao funcionario. O administrador deve associar funcionarios.user_id a este login.');
      return;
    }

    if (!me.viaRpc) {
      setAuthLinkWarning('Conta encontrada por fallback (email/user_id), mas sem ligacao valida via RPC. Isso pode bloquear pedidos por RLS.');
      return;
    }

    setAuthLinkWarning(null);
  }, [resolveMyFuncionario]);

  const fetchHolidays = useCallback(async () => {
    const { data, error } = await supabase
      .from('holidays')
      .select('date, name')
      .order('date', { ascending: true });

    if (error) {
      console.error('Erro ao carregar feriados:', error);
      return;
    }

    const rows = (data || []) as Holiday[];
    setHolidayList(rows);
    setHolidays(new Set(rows.map((h) => h.date)));
  }, []);

  const fetchFeriasManagementData = useCallback(
    async (year: number) => {
      const yearStart = `${year}-01-01`;
      const yearEnd = `${year}-12-31`;

      const [saldosRes, periodosRes] = await Promise.all([
        supabase
          .from('ferias_saldos')
          .select('id, funcionario_id, ano, dias_direito, dias_extra, dias_usados_manual, observacoes')
          .eq('ano', year)
          .order('funcionario_id', { ascending: true }),
        supabase
          .from('ferias_empresa_periodos')
          .select('id, titulo, descricao, data_inicio, data_fim, funcionarios_alvo, created_by, created_at')
          .lte('data_inicio', yearEnd)
          .gte('data_fim', yearStart)
          .order('data_inicio', { ascending: true }),
      ]);

      if (isMissingRelationError(saldosRes.error) || isMissingRelationError(periodosRes.error)) {
        setManagementSchemaReady(false);
        setManagementError(
          'Tabelas de gestao de ferias ainda nao existem. Aplique a migration nova antes de usar esta funcionalidade.',
        );
        setFeriasSaldos([]);
        setEmpresaPeriodos([]);
        return;
      }

      if (saldosRes.error || periodosRes.error) {
        const msg = saldosRes.error?.message || periodosRes.error?.message || 'Erro a carregar dados de ferias.';
        setManagementError(msg);
        return;
      }

      const saldos = ((saldosRes.data || []) as FeriasSaldo[]).map((row) => ({
        ...row,
        dias_direito: safeNumber(row.dias_direito, 22),
        dias_extra: safeNumber(row.dias_extra, 0),
        dias_usados_manual: safeNumber(row.dias_usados_manual, 0),
      }));
      const periodos = ((periodosRes.data || []) as any[]).map((row) => ({
        id: String(row.id),
        titulo: String(row.titulo || COMPANY_PERIOD_DEFAULT_TITLE),
        descricao: row.descricao ? String(row.descricao) : null,
        data_inicio: String(row.data_inicio),
        data_fim: String(row.data_fim),
        funcionarios_alvo: normalizePeriodTargets(row.funcionarios_alvo),
        created_by: row.created_by ? String(row.created_by) : null,
        created_at: String(row.created_at),
      }));

      setManagementSchemaReady(true);
      setManagementError(null);
      setFeriasSaldos(saldos);
      setEmpresaPeriodos(periodos);
    },
    [],
  );

  const fetchDados = useCallback(async () => {
    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    const isMgr = user?.email === 'mpr@mpr.pt';

    const { data: funcs } = await supabase
      .from('funcionarios')
      .select('id, nome, email')
      .order('nome');

    const funcionariosRows = (funcs || []) as Funcionario[];
    setFuncionarios(funcionariosRows);

    let pedidosData: any[] | null = null;
    let error: any = null;

    if (user && !isMgr) {
      const me = await resolveMyFuncionario({ id: user.id, email: user.email });

      if (!me.id) {
        setPedidos([]);
        setAuthLinkWarning('Nao foi possivel identificar o funcionario desta conta.');
        setLoading(false);
        return;
      }

      setCurrentUserId(me.id);
      if (!me.viaRpc) {
        setAuthLinkWarning(
          'A conta da utilizadora nao esta ligada por user_id. Corrigir no Supabase para RLS permitir leitura dos pedidos.',
        );
      }

      const primary = await supabase
        .from('pedidos')
        .select('*')
        .eq('funcionario_id', me.id)
        .order('created_at', { ascending: false });

      pedidosData = primary.data;
      error = primary.error;

      if (error && /funcionario_id/i.test(error.message || '')) {
        const fallback = await supabase
          .from('pedidos')
          .select('*')
          .eq('atribuido_a', me.id)
          .order('created_at', { ascending: false });

        pedidosData = fallback.data;
        error = fallback.error;
      }
    } else {
      const all = await supabase
        .from('pedidos')
        .select('*')
        .order('created_at', { ascending: false });

      pedidosData = all.data;
      error = all.error;
    }

    if (error) {
      console.error('Erro ao carregar pedidos:', error);
    }

    if (pedidosData) {
      const pedidosComNomes = pedidosData.map((p: any) => ({
        ...p,
        tipo: normalizePedidoTipo(p.tipo),
        status: normalizePedidoStatus(p.status),
        descricao: normalizePedidoDescricao(p.descricao),
        funcionario_nome:
          funcionariosRows.find((f) => f.id === (p.funcionario_id || p.atribuido_a))?.nome || 'Desconhecido',
      }));
      setPedidos(pedidosComNomes);
    }

    setLoading(false);
  }, [resolveMyFuncionario]);

  useEffect(() => {
    void checkUser();
    void fetchDados();
    void fetchHolidays();
  }, [checkUser, fetchDados, fetchHolidays]);

  useEffect(() => {
    void fetchFeriasManagementData(managementYear);
  }, [fetchFeriasManagementData, managementYear]);

  useEffect(() => {
    const nextDrafts: Record<string, SaldoDraft> = {};
    for (const func of funcionarios) {
      const row = feriasSaldos.find((s) => s.funcionario_id === func.id && s.ano === managementYear);
      nextDrafts[func.id] = getDefaultSaldoDraft(row);
    }
    setSaldoDrafts(nextDrafts);
  }, [funcionarios, feriasSaldos, managementYear]);

  const periodAppliesToFuncionario = useCallback((periodo: FeriasEmpresaPeriodo, funcionarioId: string | null) => {
    if (!funcionarioId) return true;
    if (!periodo.funcionarios_alvo || periodo.funcionarios_alvo.length === 0) return true;
    return periodo.funcionarios_alvo.includes(funcionarioId);
  }, []);

  const countBusinessDays = useCallback(
    (start?: string, end?: string) => {
      const startIso = normalizeIsoDate(start);
      const endIso = normalizeIsoDate(end) || startIso;
      if (!startIso || !endIso || endIso < startIso) return 0;
      return iterateBusinessDates(startIso, endIso, holidays).length;
    },
    [holidays],
  );

  const approvedPedidos = useMemo(() => pedidos.filter((p) => isPedidoAprovado(p.status)), [pedidos]);

  const feriasResumo = useMemo(() => {
    return funcionarios.map((funcionario) => {
      const draft = saldoDrafts[funcionario.id] || getDefaultSaldoDraft();
      const diasDireito = safeNumber(draft.dias_direito, 22);
      const diasExtra = safeNumber(draft.dias_extra, 0);
      const diasUsadosManual = safeNumber(draft.dias_usados_manual, 0);

      const feriasDates = new Set<string>();
      const folgaDates = new Set<string>();

      for (const pedido of approvedPedidos) {
        const pedidoFuncionarioId = pedido.funcionario_id || pedido.atribuido_a;
        if (pedidoFuncionarioId !== funcionario.id) continue;

        const startIso = normalizeIsoDate(pedido.data_inicio);
        const endIso = normalizeIsoDate(pedido.data_fim) || startIso;
        if (!startIso || !endIso) continue;

        const clamped = clampRangeToYear(startIso, endIso, managementYear);
        if (!clamped) continue;

        const businessDays = iterateBusinessDates(clamped.start, clamped.end, holidays);
        if (isVacationType(pedido.tipo)) {
          businessDays.forEach((iso) => feriasDates.add(iso));
        } else if (isFolgaType(pedido.tipo)) {
          businessDays.forEach((iso) => folgaDates.add(iso));
        }
      }

      for (const periodo of empresaPeriodos) {
        if (!periodAppliesToFuncionario(periodo, funcionario.id)) continue;

        const startIso = normalizeIsoDate(periodo.data_inicio);
        const endIso = normalizeIsoDate(periodo.data_fim) || startIso;
        if (!startIso || !endIso) continue;

        const clamped = clampRangeToYear(startIso, endIso, managementYear);
        if (!clamped) continue;

        iterateBusinessDates(clamped.start, clamped.end, holidays).forEach((iso) => feriasDates.add(iso));
      }

      const diasFeriasAprovadas = feriasDates.size;
      const diasFolgaAprovadas = folgaDates.size;
      const diasTotais = diasDireito + diasExtra;
      const diasUsados = diasFeriasAprovadas + diasUsadosManual;
      const diasRestantes = diasTotais - diasUsados;

      return {
        funcionarioId: funcionario.id,
        funcionarioNome: funcionario.nome,
        diasDireito,
        diasExtra,
        diasUsadosManual,
        diasFeriasAprovadas,
        diasFolgaAprovadas,
        diasTotais,
        diasUsados,
        diasRestantes,
      };
    });
  }, [funcionarios, saldoDrafts, approvedPedidos, managementYear, holidays, empresaPeriodos, periodAppliesToFuncionario]);

  const feriasDetalheAfixacao = useMemo(() => {
    const map = new Map<string, { periodos: Array<{ start: string; end: string }>; diasExatos: string[] }>();
    const periodKeyMap = new Map<string, Set<string>>();

    for (const funcionario of funcionarios) {
      map.set(funcionario.id, { periodos: [], diasExatos: [] });
      periodKeyMap.set(funcionario.id, new Set<string>());
    }

    const addPeriodo = (funcionarioId: string, startIso: string, endIso: string) => {
      const clamped = clampRangeToYear(startIso, endIso, managementYear);
      if (!clamped) return;

      const periodKey = `${clamped.start}|${clamped.end}`;
      const keys = periodKeyMap.get(funcionarioId);
      const detail = map.get(funcionarioId);
      if (!keys || !detail) return;
      if (keys.has(periodKey)) return;

      keys.add(periodKey);
      detail.periodos.push({ start: clamped.start, end: clamped.end });
    };

    for (const pedido of approvedPedidos) {
      if (!isVacationType(pedido.tipo)) continue;
      const funcionarioId = pedido.funcionario_id || pedido.atribuido_a;
      if (!funcionarioId || !map.has(funcionarioId)) continue;

      const startIso = normalizeIsoDate(pedido.data_inicio);
      const endIso = normalizeIsoDate(pedido.data_fim) || startIso;
      if (!startIso || !endIso) continue;
      addPeriodo(funcionarioId, startIso, endIso);
    }

    for (const periodo of empresaPeriodos) {
      const startIso = normalizeIsoDate(periodo.data_inicio);
      const endIso = normalizeIsoDate(periodo.data_fim) || startIso;
      if (!startIso || !endIso) continue;

      for (const funcionario of funcionarios) {
        if (!periodAppliesToFuncionario(periodo, funcionario.id)) continue;
        addPeriodo(funcionario.id, startIso, endIso);
      }
    }

    for (const funcionario of funcionarios) {
      const detail = map.get(funcionario.id);
      if (!detail) continue;

      detail.periodos.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));

      const daysSet = new Set<string>();
      for (const periodo of detail.periodos) {
        iterateBusinessDates(periodo.start, periodo.end, holidays).forEach((day) => daysSet.add(day));
      }

      detail.diasExatos = Array.from(daysSet).sort((a, b) => a.localeCompare(b));
    }

    return map;
  }, [funcionarios, approvedPedidos, empresaPeriodos, managementYear, holidays, periodAppliesToFuncionario]);

  const formatDatePt = useCallback((iso: string) => {
    return new Date(`${iso}T00:00:00`).toLocaleDateString('pt-PT');
  }, []);

  const handleStatus = async (id: string, novoStatus: 'APROVADO' | 'REJEITADO') => {
    const ok = await confirm({
      title: `Marcar como ${novoStatus}`,
      message: `Tem a certeza que deseja marcar este pedido como ${novoStatus}?`,
      confirmLabel: novoStatus === 'APROVADO' ? 'Aprovar' : 'Rejeitar',
      variant: novoStatus === 'REJEITADO' ? 'danger' : 'warning',
    });
    if (!ok) return;
    const resolucaoNota = prompt('Escreva a sua decisao/observacao (opcional):') || '';

    const { error } = await supabase
      .from('pedidos')
      .update({ status: novoStatus, resolucao: resolucaoNota })
      .eq('id', id);

    if (error) {
      toast.error('Erro ao atualizar pedido');
      return;
    }

    setPedidos((prev) => prev.map((p) => (p.id === id ? { ...p, status: novoStatus } : p)));
    toast.success(`Pedido marcado como ${novoStatus}`);
  };

  const handleAddHoliday = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isManager) return;
    if (!newHoliday.date || !newHoliday.name.trim()) {
      toast.warning('Preencha a data e o nome do feriado.');
      return;
    }

    const { error } = await supabase.from('holidays').upsert(
      {
        date: newHoliday.date,
        name: newHoliday.name.trim(),
      } as any,
      { onConflict: 'date' },
    );

    if (error) {
      toast.error('Erro ao guardar feriado: ' + error.message);
      return;
    }

    setNewHoliday({ date: '', name: '' });
    await fetchHolidays();
  };

  const handleDeleteHoliday = async (date: string) => {
    if (!isManager) return;
    const ok = await confirm({
      title: 'Remover feriado',
      message: 'Tem a certeza que pretende remover este feriado?',
      confirmLabel: 'Remover',
      variant: 'danger',
    });
    if (!ok) return;

    const { error } = await supabase.from('holidays').delete().eq('date', date);
    if (error) {
      toast.error('Erro ao remover feriado: ' + error.message);
      return;
    }
    await fetchHolidays();
  };

  const handleCreateCompanyPeriod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isManager) return;
    if (!managementSchemaReady) {
      toast.warning('A migration da gestao de ferias ainda nao foi aplicada.');
      return;
    }

    const startIso = normalizeIsoDate(newCompanyPeriod.data_inicio);
    const endIso = normalizeIsoDate(newCompanyPeriod.data_fim) || startIso;
    if (!startIso || !endIso) {
      toast.warning('Preencha as datas do periodo.');
      return;
    }
    if (endIso < startIso) {
      toast.warning('A data fim nao pode ser anterior a data inicio.');
      return;
    }
    if (!newCompanyPeriod.aplicar_todos && companyTargets.length === 0) {
      toast.warning('Escolha pelo menos um funcionario ou marque "Aplicar a todos".');
      return;
    }

    const payload = {
      titulo: (newCompanyPeriod.titulo || COMPANY_PERIOD_DEFAULT_TITLE).trim(),
      descricao: newCompanyPeriod.descricao.trim() || null,
      data_inicio: startIso,
      data_fim: endIso,
      funcionarios_alvo: newCompanyPeriod.aplicar_todos ? null : companyTargets,
      created_by: currentUserId,
    };

    const { error } = await supabase.from('ferias_empresa_periodos').insert(payload as any);
    if (error) {
      toast.error('Erro ao criar periodo de ferias da empresa: ' + error.message);
      return;
    }

    setNewCompanyPeriod({
      titulo: COMPANY_PERIOD_DEFAULT_TITLE,
      descricao: '',
      data_inicio: '',
      data_fim: '',
      aplicar_todos: true,
    });
    setCompanyTargets([]);
    await fetchFeriasManagementData(managementYear);
  };

  const handleDeleteCompanyPeriod = async (periodId: string) => {
    if (!isManager) return;
    const ok = await confirm({
      title: 'Eliminar periodo',
      message: 'Eliminar este periodo de ferias da empresa?',
      confirmLabel: 'Eliminar',
      variant: 'danger',
    });
    if (!ok) return;

    const { error } = await supabase.from('ferias_empresa_periodos').delete().eq('id', periodId);
    if (error) {
      toast.error('Erro ao eliminar periodo: ' + error.message);
      return;
    }
    await fetchFeriasManagementData(managementYear);
  };

  const updateSaldoDraft = (funcionarioId: string, field: keyof SaldoDraft, value: string) => {
    setSaldoDrafts((prev) => ({
      ...prev,
      [funcionarioId]: {
        ...(prev[funcionarioId] || getDefaultSaldoDraft()),
        [field]: value,
      },
    }));
  };

  const handleSaveSaldo = async (funcionarioId: string) => {
    if (!isManager) return;
    if (!managementSchemaReady) {
      toast.warning('A migration da gestao de ferias ainda nao foi aplicada.');
      return;
    }

    const draft = saldoDrafts[funcionarioId] || getDefaultSaldoDraft();
    const payload = {
      funcionario_id: funcionarioId,
      ano: managementYear,
      dias_direito: Math.max(0, safeNumber(draft.dias_direito, 22)),
      dias_extra: safeNumber(draft.dias_extra, 0),
      dias_usados_manual: Math.max(0, safeNumber(draft.dias_usados_manual, 0)),
      observacoes: draft.observacoes.trim() || null,
    };

    setSavingSaldoFor(funcionarioId);
    const { error } = await supabase
      .from('ferias_saldos')
      .upsert(payload as any, { onConflict: 'funcionario_id,ano' });
    setSavingSaldoFor(null);

    if (error) {
      toast.error('Erro ao guardar saldo: ' + error.message);
      return;
    }
    await fetchFeriasManagementData(managementYear);
  };

  const openEditPedido = (pedido: Pedido) => {
    setEditingIdPedido(pedido);
    setEditForm({
      tipo: pedido.tipo || '',
      data_inicio: pedido.data_inicio || '',
      data_fim: pedido.data_fim || '',
      descricao: pedido.descricao || '',
      resolucao: pedido.resolucao || '',
      status: pedido.status,
    });
  };

  const handleSaveEditPedido = async () => {
    if (!editingPedido || !editForm) return;

    const payload = {
      tipo: editForm.tipo.trim(),
      data_inicio: editForm.data_inicio || null,
      data_fim: editForm.data_fim || null,
      descricao: editForm.descricao.trim(),
      resolucao: editForm.resolucao.trim(),
      status: editForm.status,
    };

    const { error } = await supabase.from('pedidos').update(payload).eq('id', editingPedido.id);

    if (error) {
      toast.error('Erro ao atualizar pedido');
      return;
    }

    toast.success('Pedido atualizado com sucesso');
    setPedidos((prev) => prev.map((p) => (p.id === editingPedido.id ? { ...p, ...payload } : p)));
    setEditingIdPedido(null);
    setEditForm(null);
  };

  const filteredPedidos = useMemo(() => {
    return pedidos.filter((p) => {
      const matchStatus = filterStatus ? p.status === filterStatus : true;
      const pedidoFuncionarioId = p.funcionario_id || p.atribuido_a;
      const matchFunc = filterFuncionario ? pedidoFuncionarioId === filterFuncionario : true;
      return matchStatus && matchFunc;
    });
  }, [pedidos, filterStatus, filterFuncionario]);

  const changeMonth = (offset: number) => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + offset, 1));
  };

  const renderCalendar = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDayOfWeek = new Date(year, month, 1).getDay();
    const monthName = currentDate.toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });

    const selectedFuncionarioId = filterFuncionario || null;
    const holidayByDate = new Map(holidayList.map((h) => [h.date, h.name]));

    const approvedVacationPedidos = approvedPedidos.filter(
      (p) =>
        isVacationType(p.tipo) &&
        (!selectedFuncionarioId || (p.funcionario_id || p.atribuido_a) === selectedFuncionarioId),
    );
    const approvedFolgaPedidos = approvedPedidos.filter(
      (p) => isFolgaType(p.tipo) && (!selectedFuncionarioId || (p.funcionario_id || p.atribuido_a) === selectedFuncionarioId),
    );
    const visibleCompanyPeriods = empresaPeriodos.filter((periodo) =>
      periodAppliesToFuncionario(periodo, selectedFuncionarioId),
    );

    const days: React.ReactNode[] = [];
    for (let i = 0; i < firstDayOfWeek; i++) {
      days.push(
        <div
          key={`empty-${i}`}
          style={{ background: '#f8fafc', border: '1px solid #e2e8f0', minHeight: '106px' }}
        />,
      );
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const dateObj = new Date(dateStr);
      const weekend = isWeekend(dateObj);
      const holidayName = holidayByDate.get(dateStr) || null;
      const isBusiness = !weekend && !holidayName;

      const vacationEvents = isBusiness
        ? approvedVacationPedidos.filter((p) => {
            const start = normalizeIsoDate(p.data_inicio);
            const end = normalizeIsoDate(p.data_fim) || start;
            if (!start || !end) return false;
            return dateStr >= start && dateStr <= end;
          })
        : [];

      const folgaEvents = isBusiness
        ? approvedFolgaPedidos.filter((p) => {
            const start = normalizeIsoDate(p.data_inicio);
            const end = normalizeIsoDate(p.data_fim) || start;
            if (!start || !end) return false;
            return dateStr >= start && dateStr <= end;
          })
        : [];

      const companyEvents = isBusiness
        ? visibleCompanyPeriods.filter((periodo) => dateStr >= periodo.data_inicio && dateStr <= periodo.data_fim)
        : [];

      const uniqueVacationNames = Array.from(new Set(vacationEvents.map((ev) => ev.funcionario_nome || 'Funcionario')));
      const uniqueFolgaNames = Array.from(new Set(folgaEvents.map((ev) => ev.funcionario_nome || 'Funcionario')));

      days.push(
        <div
          key={d}
          style={{
            background: holidayName ? '#fff1f2' : weekend ? '#f8fafc' : 'white',
            border: '1px solid #e2e8f0',
            minHeight: '106px',
            padding: '6px',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: '4px', color: '#475569', textAlign: 'right' }}>{d}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {holidayName && (
              <div
                style={{
                  background: '#fce7f3',
                  color: '#9d174d',
                  padding: '2px 5px',
                  borderRadius: '4px',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                }}
                title={holidayName}
              >
                Feriado
              </div>
            )}

            {companyEvents.length > 0 && (
              <div
                style={{
                  background: '#fee2e2',
                  color: '#991b1b',
                  padding: '2px 5px',
                  borderRadius: '4px',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                }}
                title={companyEvents.map((evt) => evt.titulo).join(', ')}
              >
                Empresa
              </div>
            )}

            {uniqueVacationNames.map((name) => (
              <div
                key={`vac-${d}-${name}`}
                style={{
                  background: '#dcfce7',
                  color: '#166534',
                  padding: '2px 5px',
                  borderRadius: '4px',
                  fontSize: '0.7rem',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={`Ferias: ${name}`}
              >
                {name}
              </div>
            ))}

            {uniqueFolgaNames.map((name) => (
              <div
                key={`fol-${d}-${name}`}
                style={{
                  background: '#ffedd5',
                  color: '#9a3412',
                  padding: '2px 5px',
                  borderRadius: '4px',
                  fontSize: '0.7rem',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={`Folga: ${name}`}
              >
                Folga: {name}
              </div>
            ))}
          </div>
        </div>,
      );
    }

    return (
      <div className="ferias-calendar-print-area" style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', marginTop: '20px' }}>
        <div style={{ marginBottom: '8px', color: '#64748b', fontSize: '0.9rem' }}>
          Mapa mensal de ferias e folgas. Dias de fim de semana e feriados nao contam para o total.
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px', fontSize: '0.8rem' }}>
          <span style={{ background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: '99px', fontWeight: 700 }}>Ferias</span>
          <span style={{ background: '#ffedd5', color: '#9a3412', padding: '2px 8px', borderRadius: '99px', fontWeight: 700 }}>Folga</span>
          <span style={{ background: '#fee2e2', color: '#991b1b', padding: '2px 8px', borderRadius: '99px', fontWeight: 700 }}>Ferias Empresa</span>
          <span style={{ background: '#fce7f3', color: '#9d174d', padding: '2px 8px', borderRadius: '99px', fontWeight: 700 }}>Feriado</span>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <button onClick={() => changeMonth(-1)} style={{ background: 'none', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer' }}>
            Anterior
          </button>
          <h3 style={{ margin: 0, textTransform: 'capitalize', color: '#1e293b' }}>{monthName}</h3>
          <button onClick={() => changeMonth(1)} style={{ background: 'none', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer' }}>
            Proximo
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', border: '1px solid #e2e8f0', borderBottom: 'none' }}>
          {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'].map((day) => (
            <div
              key={day}
              style={{ padding: '10px', background: '#f1f5f9', textAlign: 'center', fontWeight: 700, color: '#475569', borderBottom: '1px solid #e2e8f0', borderRight: '1px solid #e2e8f0' }}
            >
              {day}
            </div>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>{days}</div>
      </div>
    );
  };

  const printVacationMap = () => {
    window.print();
  };

  const renderManagementPanels = () => {
    if (!isManager || viewMode !== 'CALENDAR') return null;

    return (
      <div className="no-print" style={{ display: 'grid', gap: '16px', marginTop: '20px' }}>
        <div style={{ background: 'white', borderRadius: '12px', border: '1px solid #e2e8f0', padding: '16px' }}>
          <h3 style={{ margin: '0 0 12px 0', color: '#1e293b' }}>Feriados</h3>
          <form onSubmit={handleAddHoliday} style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: '8px', marginBottom: '10px' }}>
            <input
              type="date"
              value={newHoliday.date}
              onChange={(e) => setNewHoliday((prev) => ({ ...prev, date: e.target.value }))}
              required
              style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
            />
            <input
              type="text"
              value={newHoliday.name}
              onChange={(e) => setNewHoliday((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="Nome do feriado"
              required
              style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
            />
            <button type="submit" style={{ padding: '8px 12px', borderRadius: '6px', border: 'none', background: '#2563eb', color: 'white', fontWeight: 700, cursor: 'pointer' }}>
              Guardar
            </button>
          </form>

          <div style={{ maxHeight: '180px', overflow: 'auto', borderTop: '1px solid #e2e8f0', paddingTop: '10px' }}>
            {holidayList.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '0.9rem' }}>Sem feriados.</div>
            ) : (
              holidayList.map((holiday) => (
                <div key={holiday.date} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{holiday.name}</div>
                    <div style={{ fontSize: '0.82rem', color: '#64748b' }}>{new Date(holiday.date).toLocaleDateString('pt-PT')}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteHoliday(holiday.date)}
                    style={{ border: 'none', background: '#fee2e2', color: '#991b1b', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', fontWeight: 700 }}
                  >
                    Remover
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div style={{ background: 'white', borderRadius: '12px', border: '1px solid #e2e8f0', padding: '16px' }}>
          <h3 style={{ margin: '0 0 12px 0', color: '#1e293b' }}>Periodo de Ferias da Empresa</h3>
          {managementSchemaReady ? (
            <form onSubmit={handleCreateCompanyPeriod} style={{ display: 'grid', gap: '10px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr 1fr', gap: '8px' }}>
                <input
                  type="text"
                  value={newCompanyPeriod.titulo}
                  onChange={(e) => setNewCompanyPeriod((prev) => ({ ...prev, titulo: e.target.value }))}
                  placeholder="Titulo"
                  style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                  required
                />
                <input
                  type="text"
                  value={newCompanyPeriod.descricao}
                  onChange={(e) => setNewCompanyPeriod((prev) => ({ ...prev, descricao: e.target.value }))}
                  placeholder="Descricao"
                  style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                />
                <input
                  type="date"
                  value={newCompanyPeriod.data_inicio}
                  onChange={(e) => setNewCompanyPeriod((prev) => ({ ...prev, data_inicio: e.target.value }))}
                  style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                  required
                />
                <input
                  type="date"
                  value={newCompanyPeriod.data_fim}
                  onChange={(e) => setNewCompanyPeriod((prev) => ({ ...prev, data_fim: e.target.value }))}
                  style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                  required
                />
              </div>

              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem', color: '#334155' }}>
                <input
                  type="checkbox"
                  checked={newCompanyPeriod.aplicar_todos}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setNewCompanyPeriod((prev) => ({ ...prev, aplicar_todos: checked }));
                    if (checked) setCompanyTargets([]);
                  }}
                />
                Aplicar a todos os funcionarios
              </label>

              {!newCompanyPeriod.aplicar_todos && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '6px', maxHeight: '140px', overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '8px' }}>
                  {funcionarios.map((f) => (
                    <label key={f.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.86rem', color: '#334155' }}>
                      <input
                        type="checkbox"
                        checked={companyTargets.includes(f.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setCompanyTargets((prev) => [...prev, f.id]);
                          } else {
                            setCompanyTargets((prev) => prev.filter((id) => id !== f.id));
                          }
                        }}
                      />
                      {f.nome}
                    </label>
                  ))}
                </div>
              )}

              <div>
                <button type="submit" style={{ padding: '8px 12px', borderRadius: '6px', border: 'none', background: '#0f766e', color: 'white', fontWeight: 700, cursor: 'pointer' }}>
                  Criar Periodo
                </button>
              </div>
            </form>
          ) : (
            <div style={{ color: '#9a3412', background: '#fff7ed', border: '1px solid #fdba74', borderRadius: '8px', padding: '10px' }}>
              {managementError || 'A migration da gestao de ferias ainda nao foi aplicada.'}
            </div>
          )}

          <div style={{ marginTop: '12px', borderTop: '1px solid #e2e8f0', paddingTop: '10px', maxHeight: '220px', overflow: 'auto' }}>
            {empresaPeriodos.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '0.9rem' }}>Sem periodos de ferias da empresa.</div>
            ) : (
              empresaPeriodos.map((periodo) => {
                const alvoLabel =
                  !periodo.funcionarios_alvo || periodo.funcionarios_alvo.length === 0
                    ? 'Todos os funcionarios'
                    : `${periodo.funcionarios_alvo.length} funcionario(s)`;
                return (
                  <div key={periodo.id} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '8px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{periodo.titulo}</div>
                        <div style={{ fontSize: '0.84rem', color: '#334155' }}>
                          {new Date(periodo.data_inicio).toLocaleDateString('pt-PT')} ate {new Date(periodo.data_fim).toLocaleDateString('pt-PT')}
                        </div>
                        <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                          {alvoLabel}
                          {periodo.descricao ? ` - ${periodo.descricao}` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteCompanyPeriod(periodo.id)}
                        style={{ border: 'none', background: '#fee2e2', color: '#991b1b', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', fontWeight: 700, height: 'fit-content' }}
                      >
                        Eliminar
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div style={{ background: 'white', borderRadius: '12px', border: '1px solid #e2e8f0', padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
            <h3 style={{ margin: 0, color: '#1e293b' }}>Saldo de Ferias por Funcionario</h3>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '0.9rem', color: '#334155' }}>
              Ano:
              <input
                type="number"
                min={2000}
                max={2200}
                value={managementYear}
                onChange={(e) => setManagementYear(safeNumber(e.target.value, new Date().getFullYear()))}
                style={{ width: '90px', padding: '6px 8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
              />
            </label>
          </div>

          {managementError && (
            <div style={{ marginBottom: '8px', color: '#9a3412', background: '#fff7ed', border: '1px solid #fdba74', borderRadius: '8px', padding: '8px' }}>
              {managementError}
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.86rem' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Funcionario</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Dias Base</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Dias Extra</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Usados Manual</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Ferias Aprov.</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Folgas Aprov.</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Saldo</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Obs.</th>
                  <th style={{ textAlign: 'left', padding: '8px', borderBottom: '1px solid #e2e8f0' }}>Acao</th>
                </tr>
              </thead>
              <tbody>
                {feriasResumo.map((row) => {
                  const draft = saldoDrafts[row.funcionarioId] || getDefaultSaldoDraft();
                  return (
                    <tr key={row.funcionarioId}>
                      <td style={{ padding: '8px', borderBottom: '1px solid #f1f5f9', fontWeight: 700 }}>{row.funcionarioNome}</td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #f1f5f9' }}>
                        <input
                          type="number"
                          step="0.5"
                          value={draft.dias_direito}
                          onChange={(e) => updateSaldoDraft(row.funcionarioId, 'dias_direito', e.target.value)}
                          style={{ width: '74px', padding: '4px 6px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                        />
                      </td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #f1f5f9' }}>
                        <input
                          type="number"
                          step="0.5"
                          value={draft.dias_extra}
                          onChange={(e) => updateSaldoDraft(row.funcionarioId, 'dias_extra', e.target.value)}
                          style={{ width: '74px', padding: '4px 6px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                        />
                      </td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #f1f5f9' }}>
                        <input
                          type="number"
                          step="0.5"
                          value={draft.dias_usados_manual}
                          onChange={(e) => updateSaldoDraft(row.funcionarioId, 'dias_usados_manual', e.target.value)}
                          style={{ width: '92px', padding: '4px 6px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                        />
                      </td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #f1f5f9', color: '#166534', fontWeight: 700 }}>{row.diasFeriasAprovadas}</td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #f1f5f9', color: '#9a3412', fontWeight: 700 }}>{row.diasFolgaAprovadas}</td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #f1f5f9', fontWeight: 700, color: row.diasRestantes >= 0 ? '#166534' : '#b91c1c' }}>
                        {row.diasRestantes.toFixed(1)}
                      </td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #f1f5f9' }}>
                        <input
                          type="text"
                          value={draft.observacoes}
                          onChange={(e) => updateSaldoDraft(row.funcionarioId, 'observacoes', e.target.value)}
                          style={{ width: '200px', padding: '4px 6px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                          placeholder="Notas"
                        />
                      </td>
                      <td style={{ padding: '8px', borderBottom: '1px solid #f1f5f9' }}>
                        <button
                          type="button"
                          onClick={() => handleSaveSaldo(row.funcionarioId)}
                          disabled={!managementSchemaReady || savingSaldoFor === row.funcionarioId}
                          style={{ border: 'none', background: '#2563eb', color: 'white', borderRadius: '6px', padding: '6px 10px', cursor: 'pointer', fontWeight: 700 }}
                        >
                          {savingSaldoFor === row.funcionarioId ? 'A guardar...' : 'Guardar'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  const renderSummaryPrint = () => {
    const totalDireito = feriasResumo.reduce((acc, row) => acc + row.diasTotais, 0);
    const totalGozado = feriasResumo.reduce((acc, row) => acc + row.diasUsados, 0);
    const totalPorGozar = feriasResumo.reduce((acc, row) => acc + row.diasRestantes, 0);

    return (
      <div className="ferias-summary-print-area" style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', marginTop: '14px' }}>
        <h3 style={{ marginTop: 0, marginBottom: '6px', color: '#1e293b' }}>Mapa de Ferias Anual - {managementYear}</h3>
        <div style={{ color: '#64748b', fontSize: '0.84rem', marginBottom: '8px' }}>
          Resumo por funcionario para afixacao interna, com os dias exatos de gozo aprovados. Emitido em {new Date().toLocaleDateString('pt-PT')}.
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem', tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '7px', borderBottom: '1px solid #cbd5e1' }}>Nome do Funcionario</th>
              <th style={{ textAlign: 'left', padding: '7px', borderBottom: '1px solid #cbd5e1' }}>Periodos de Ferias (Datas Exatas)</th>
              <th style={{ textAlign: 'left', padding: '7px', borderBottom: '1px solid #cbd5e1' }}>Dias Exatos de Gozo</th>
              <th style={{ textAlign: 'left', padding: '7px', borderBottom: '1px solid #cbd5e1' }}>Dias de Ferias (Direito)</th>
              <th style={{ textAlign: 'left', padding: '7px', borderBottom: '1px solid #cbd5e1' }}>Dias Gozados</th>
              <th style={{ textAlign: 'left', padding: '7px', borderBottom: '1px solid #cbd5e1' }}>Dias por Gozar</th>
            </tr>
          </thead>
          <tbody>
            {feriasResumo.map((row) => {
              const detalhe = feriasDetalheAfixacao.get(row.funcionarioId) || { periodos: [], diasExatos: [] };
              const periodosText =
                detalhe.periodos.length > 0
                  ? detalhe.periodos
                      .map((p) => `${formatDatePt(p.start)} a ${formatDatePt(p.end)}`)
                      .join(' | ')
                  : '-';
              const diasText =
                detalhe.diasExatos.length > 0
                  ? detalhe.diasExatos.map((d) => formatDatePt(d)).join(', ')
                  : '-';

              return (
                <tr key={`print-${row.funcionarioId}`}>
                  <td style={{ padding: '7px', borderBottom: '1px solid #e2e8f0', fontWeight: 700, verticalAlign: 'top' }}>{row.funcionarioNome}</td>
                  <td style={{ padding: '7px', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top', minWidth: '240px', wordBreak: 'break-word' }}>{periodosText}</td>
                  <td style={{ padding: '7px', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top', minWidth: '300px', wordBreak: 'break-word' }}>{diasText}</td>
                  <td style={{ padding: '7px', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top' }}>{row.diasTotais.toFixed(1)}</td>
                  <td style={{ padding: '7px', borderBottom: '1px solid #e2e8f0', verticalAlign: 'top' }}>{row.diasUsados.toFixed(1)}</td>
                  <td style={{ padding: '7px', borderBottom: '1px solid #e2e8f0', fontWeight: 700, verticalAlign: 'top' }}>{row.diasRestantes.toFixed(1)}</td>
                </tr>
              );
            })}
            <tr>
              <td style={{ padding: '7px', borderTop: '2px solid #cbd5e1', fontWeight: 700 }}>TOTAL</td>
              <td style={{ padding: '7px', borderTop: '2px solid #cbd5e1', fontWeight: 700 }}>-</td>
              <td style={{ padding: '7px', borderTop: '2px solid #cbd5e1', fontWeight: 700 }}>-</td>
              <td style={{ padding: '7px', borderTop: '2px solid #cbd5e1', fontWeight: 700 }}>{totalDireito.toFixed(1)}</td>
              <td style={{ padding: '7px', borderTop: '2px solid #cbd5e1', fontWeight: 700 }}>{totalGozado.toFixed(1)}</td>
              <td style={{ padding: '7px', borderTop: '2px solid #cbd5e1', fontWeight: 700 }}>{totalPorGozar.toFixed(1)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  };

  usePageHero(
    <div className="no-print" style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
      <button onClick={() => setViewMode('LIST')} style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #ccc', background: viewMode === 'LIST' ? '#e2e8f0' : 'white', cursor: 'pointer', fontWeight: viewMode === 'LIST' ? 700 : 400 }}>
        Lista
      </button>
      <button onClick={() => setViewMode('CALENDAR')} style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #ccc', background: viewMode === 'CALENDAR' ? '#e2e8f0' : 'white', cursor: 'pointer', fontWeight: viewMode === 'CALENDAR' ? 700 : 400 }}>
        Calendario Ferias
      </button>
      {viewMode === 'CALENDAR' && (
        <button onClick={printVacationMap} style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #1d4ed8', background: '#dbeafe', color: '#1e3a8a', cursor: 'pointer', fontWeight: 700 }}>
          Imprimir Mapa de Afixacao (PDF)
        </button>
      )}
    </div>,
    'right',
  );

  return (
    <div style={{ padding: '20px', maxWidth: '1280px', margin: '0 auto' }}>
      <style>{`
        @page {
          size: A4 landscape;
          margin: 10mm;
        }
        @media print {
          body * {
            visibility: hidden !important;
          }
          .ferias-map-print-wrap, .ferias-map-print-wrap * {
            visibility: visible !important;
          }
          .ferias-map-print-wrap {
            position: absolute !important;
            left: 0;
            top: 0;
            width: 100%;
            padding: 0;
            margin: 0;
          }
          .no-print {
            display: none !important;
          }
          .ferias-calendar-print-area,
          .ferias-summary-print-area {
            box-shadow: none !important;
            border-radius: 0 !important;
            margin-top: 0 !important;
            page-break-inside: avoid;
          }
          .ferias-calendar-print-area {
            display: none !important;
          }
          .ferias-summary-print-area {
            display: block !important;
            width: 100% !important;
            padding-top: 0 !important;
          }
        }
      `}</style>

      {authLinkWarning && (
        <div style={{ marginBottom: '16px', padding: '10px 12px', borderRadius: '8px', background: '#fff7ed', border: '1px solid #fdba74', color: '#9a3412', fontSize: '0.9rem' }}>
          {authLinkWarning}
        </div>
      )}

      <div className="no-print" style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
        {viewMode === 'LIST' && (
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ padding: '8px', borderRadius: '6px', border: '1px solid #ccc' }}>
            <option value="">Todos os Estados</option>
            <option value="PENDENTE">Pendentes</option>
            <option value="APROVADO">Aprovados</option>
            <option value="REJEITADO">Rejeitados</option>
          </select>
        )}

        <select value={filterFuncionario} onChange={(e) => setFilterFuncionario(e.target.value)} style={{ padding: '8px', borderRadius: '6px', border: '1px solid #ccc' }}>
          <option value="">Todos os Funcionarios</option>
          {funcionarios.map((f) => (
            <option key={f.id} value={f.id}>
              {f.nome}
            </option>
          ))}
        </select>

        {viewMode === 'CALENDAR' && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', color: '#334155', fontSize: '0.9rem' }}>
            Ano do mapa:
            <input
              type="number"
              value={managementYear}
              min={2000}
              max={2200}
              onChange={(e) => setManagementYear(safeNumber(e.target.value, new Date().getFullYear()))}
              style={{ width: '86px', padding: '6px 8px', borderRadius: '6px', border: '1px solid #cbd5e1' }}
            />
          </label>
        )}
      </div>
      {loading ? (
        <Skeleton variant="table" rows={6} columns={4} />
      ) : viewMode === 'CALENDAR' ? (
        <>
          <div className="ferias-map-print-wrap">
            {renderCalendar()}
            {renderSummaryPrint()}
          </div>
          {renderManagementPanels()}
        </>
      ) : (
        <div style={{ display: 'grid', gap: '20px', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
          {filteredPedidos.map((pedido) => (
            <div
              key={pedido.id}
              style={{
                background: 'white',
                padding: '20px',
                borderRadius: '12px',
                boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
                borderLeft: `5px solid ${
                  pedido.status === 'APROVADO' ? '#22c55e' : pedido.status === 'REJEITADO' ? '#ef4444' : '#f59e0b'
                }`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                <span style={{ fontWeight: 700, color: '#334155' }}>{pedido.funcionario_nome}</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                <span style={{ fontSize: '0.8rem', color: '#64748b' }}>{new Date(pedido.created_at).toLocaleDateString('pt-PT')}</span>
              </div>

              <h3 style={{ margin: '0 0 10px 0', color: '#0f172a' }}>{pedido.tipo}</h3>
              <p style={{ color: '#475569', fontSize: '0.95rem', marginBottom: '15px' }}>{pedido.descricao || 'Sem descricao'}</p>

              {(pedido.data_inicio || pedido.data_fim) && (
                <div style={{ background: '#f8fafc', padding: '8px', borderRadius: '6px', fontSize: '0.85rem', marginBottom: '15px' }}>
                  {pedido.data_inicio ? new Date(pedido.data_inicio).toLocaleDateString('pt-PT') : '...'} {' -> '}{' '}
                  {pedido.data_fim ? new Date(pedido.data_fim).toLocaleDateString('pt-PT') : '...'}
                  {(isVacationType(pedido.tipo) || isFolgaType(pedido.tipo)) && (
                    <div style={{ marginTop: '4px', fontWeight: 700, color: '#166534' }}>
                      Dias uteis: {countBusinessDays(pedido.data_inicio, pedido.data_fim)}
                    </div>
                  )}
                </div>
              )}

              {pedido.resolucao && (
                <div style={{ marginTop: '10px', fontSize: '0.85rem', color: '#64748b', fontStyle: 'italic', borderTop: '1px solid #eee', paddingTop: '5px' }}>
                  <strong>Decisao:</strong> {pedido.resolucao}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto' }}>
                <span
                  style={{
                    padding: '4px 10px',
                    borderRadius: '99px',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    background: pedido.status === 'APROVADO' ? '#dcfce7' : pedido.status === 'REJEITADO' ? '#fee2e2' : '#fff7ed',
                    color: pedido.status === 'APROVADO' ? '#166534' : pedido.status === 'REJEITADO' ? '#991b1b' : '#9a3412',
                  }}
                >
                  {pedido.status}
                </span>

                {isManager && (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => openEditPedido(pedido)} style={{ background: '#3b82f6', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700 }}>
                      Editar
                    </button>
                    {pedido.status === 'PENDENTE' && (
                      <>
                        <button onClick={() => handleStatus(pedido.id, 'APROVADO')} style={{ background: '#22c55e', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700 }}>
                          Aprovar
                        </button>
                        <button onClick={() => handleStatus(pedido.id, 'REJEITADO')} style={{ background: '#ef4444', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: 700 }}>
                          Rejeitar
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
          {filteredPedidos.length === 0 && <p style={{ color: '#64748b' }}>Nenhum pedido encontrado.</p>}
        </div>
      )}

      {editingPedido && editForm && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '18px',
          }}
          onClick={() => setEditingIdPedido(null)}
        >
          <div
            style={{
              width: 'min(500px, 96vw)',
              background: '#ffffff',
              borderRadius: '12px',
              boxShadow: '0 18px 40px rgba(15, 23, 42, 0.25)',
              border: '1px solid #dbe3ee',
              display: 'flex',
              flexDirection: 'column',
              padding: '20px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 16px 0', color: '#1e293b' }}>Editar Pedido</h3>
            
            <div style={{ display: 'grid', gap: '12px', marginBottom: '20px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Tipo</label>
                <input type="text" value={editForm.tipo} onChange={e => setEditForm(f => ({ ...f!, tipo: e.target.value }))} style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', width: '100%', boxSizing: 'border-box' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Data Início</label>
                  <input type="date" value={editForm.data_inicio} onChange={e => setEditForm(f => ({ ...f!, data_inicio: e.target.value }))} style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', width: '100%', boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Data Fim</label>
                  <input type="date" value={editForm.data_fim} onChange={e => setEditForm(f => ({ ...f!, data_fim: e.target.value }))} style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', width: '100%', boxSizing: 'border-box' }} />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Estado</label>
                <select value={editForm.status} onChange={e => setEditForm(f => ({ ...f!, status: e.target.value as PedidoStatus }))} style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', width: '100%', boxSizing: 'border-box' }}>
                  <option value="PENDENTE">PENDENTE</option>
                  <option value="APROVADO">APROVADO</option>
                  <option value="REJEITADO">REJEITADO</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Descrição</label>
                <textarea value={editForm.descricao} onChange={e => setEditForm(f => ({ ...f!, descricao: e.target.value }))} style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' }} rows={3} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#475569', marginBottom: '4px' }}>Decisão / Resolução</label>
                <textarea value={editForm.resolucao} onChange={e => setEditForm(f => ({ ...f!, resolucao: e.target.value }))} style={{ padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' }} rows={2} />
              </div>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button onClick={() => setEditingIdPedido(null)} style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #cbd5e1', background: 'white', cursor: 'pointer', fontWeight: 600, color: '#475569' }}>Cancelar</button>
              <button onClick={handleSaveEditPedido} style={{ padding: '8px 16px', borderRadius: '6px', border: 'none', background: '#0f766e', color: 'white', cursor: 'pointer', fontWeight: 700 }}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog />
    </div>
  );
}
