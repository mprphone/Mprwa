import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { usePageHero } from '../hooks/usePageHero';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmModal';
import '../styles/FuncionariosPage.css';
import {
  SLOT_META,
  clampCount,
  clampProgress,
  clampRangeToYear,
  clampWeight,
  combineDateAndTimeIso,
  createDefaultObjetivo,
  createDefaultRecompensaGlobal,
  escapeHtml,
  formatTimeInput,
  isMissingRelationError,
  iterateBusinessDates,
  isPedidoAprovado,
  isVacationType,
  normalizePedidoStatus,
  normalizePedidoTipo,
  normalizeIsoDate,
  normalizeObjetivoMetaTipo,
  safeNumber,
  sortByNome,
  type ObjetivoItem,
  type ObjetivosRecompensa,
  type PunchSlotKey,
  toIsoDate,
  createLocalId,
} from './funcionarios/funcionariosUtils';

type Funcionario = {
  id: string;
  nome: string;
  email: string;
  telefone: string | null;
  pin: string | null;
  activo: boolean;
  horario_trabalho?: string | null;
  local_trabalho?: string | null;
  data_nascimento?: string | null;
  objetivos?: string | null;
  premio_objetivos?: string | null;
  user_id?: string | null;
};

type RegistoPonto = {
  id: number;
  momento: string;
  tipo: string;
  origem: string | null;
  funcionario?: {
    id: string;
    nome: string;
  } | null;
};

type FormTab = 'informacao' | 'objetivos' | 'picagens' | 'ferias' | 'pedidos';

type FormPedido = {
  id: string;
  created_at: string;
  tipo: string;
  status: 'PENDENTE' | 'APROVADO' | 'REJEITADO';
  data_inicio: string | null;
  data_fim: string | null;
  descricao: string;
  resolucao: string | null;
};

type PunchDayGroup = {
  dateIso: string;
  dateLabel: string;
  slots: Record<PunchSlotKey, RegistoPonto | null>;
  extras: RegistoPonto[];
  all: RegistoPonto[];
};

type PunchDayMetrics = {
  workedMinutes: number;
  expectedMinutes: number | null;
  saldoMinutes: number | null;
  incomplete: boolean;
  openPairCount: number;
};

type FeriasResumoPeriodo = {
  inicio: string;
  fim: string;
  origem: string;
  diasUteis: number;
};

type FeriasResumo = {
  ano: number;
  diasDireito: number;
  diasExtra: number;
  diasUsadosManual: number;
  diasAprovados: number;
  diasUsadosTotal: number;
  diasRestantes: number;
  periodos: FeriasResumoPeriodo[];
};

function mapRegistoPonto(row: any): RegistoPonto {
  const funcionarioRaw = Array.isArray(row?.funcionario) ? row.funcionario[0] : row?.funcionario;
  return {
    id: Number(row?.id),
    momento: String(row?.momento ?? row?.timestamp ?? ''),
    tipo: String(row?.tipo || ''),
    origem: row?.origem ? String(row.origem) : null,
    funcionario: funcionarioRaw
      ? {
          id: String(funcionarioRaw.id),
          nome: String(funcionarioRaw.nome),
        }
      : null,
  };
}


function normalizeObjetivoItem(raw: any): ObjetivoItem {
  const legacyProgress = clampProgress(raw?.progresso);
  const legacyConcluido = Boolean(raw?.concluido) || legacyProgress >= 100;
  const metaTipo = normalizeObjetivoMetaTipo(raw?.metaTipo ?? raw?.meta_tipo ?? raw?.unidade_meta);
  const hasMeta = raw?.meta !== undefined && raw?.meta !== null;
  const hasAtingido = raw?.atingido !== undefined && raw?.atingido !== null;
  const hasPeso = raw?.peso !== undefined && raw?.peso !== null;
  const hasErros = raw?.erros !== undefined && raw?.erros !== null;

  const meta = hasMeta ? clampCount(raw.meta) : 100;
  let atingido = hasAtingido ? clampCount(raw.atingido) : legacyProgress;
  if (!hasAtingido && legacyConcluido) {
    atingido = meta > 0 ? meta : 100;
  }
  const peso = hasPeso ? clampWeight(raw.peso) : 0;
  const erros = hasErros ? clampCount(raw.erros) : 0;

  return {
    id: typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : createLocalId('obj'),
    titulo: typeof raw?.titulo === 'string' ? raw.titulo.trim() : '',
    metaTipo,
    meta,
    atingido,
    peso,
    erros,
    notas: typeof raw?.notas === 'string' ? raw.notas : '',
    deadline: typeof raw?.deadline === 'string' ? raw.deadline : '',
  };
}

function getObjetivoBasePercent(item: ObjetivoItem) {
  const meta = item.metaTipo === 'PERCENT' ? clampWeight(item.meta) : clampCount(item.meta);
  const atingido = item.metaTipo === 'PERCENT' ? clampWeight(item.atingido) : clampCount(item.atingido);
  if (meta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((atingido / meta) * 100)));
}

function getErroPenaltyFactor(erros: number) {
  if (erros >= 2) return 0;
  if (erros === 1) return 0.5;
  return 1;
}

function getObjetivoPercent(item: ObjetivoItem) {
  const base = getObjetivoBasePercent(item);
  const penalty = getErroPenaltyFactor(clampCount(item.erros));
  return Math.max(0, Math.min(100, Math.round(base * penalty)));
}

function isObjetivoAtingido(item: ObjetivoItem) {
  const meta = item.metaTipo === 'PERCENT' ? clampWeight(item.meta) : clampCount(item.meta);
  const atingido = item.metaTipo === 'PERCENT' ? clampWeight(item.atingido) : clampCount(item.atingido);
  if (meta <= 0) return false;
  return atingido >= meta && clampCount(item.erros) === 0;
}

function normalizeRecompensaGlobal(raw: any): ObjetivosRecompensa {
  const base = createDefaultRecompensaGlobal();
  const premioMaximo = Number(raw?.premioMaximo);
  return {
    patamar50: typeof raw?.patamar50 === 'string' && raw.patamar50.trim() ? raw.patamar50 : base.patamar50,
    patamar65: typeof raw?.patamar65 === 'string' && raw.patamar65.trim() ? raw.patamar65 : typeof raw?.recompensa80 === 'string' && raw.recompensa80.trim() ? raw.recompensa80 : base.patamar65,
    patamar80:
      typeof raw?.patamar80 === 'string' && raw.patamar80.trim()
        ? raw.patamar80
        : typeof raw?.recompensa100 === 'string' && raw.recompensa100.trim()
          ? raw.recompensa100
          : base.patamar80,
    premioMaximo: Number.isFinite(premioMaximo) && premioMaximo > 0 ? Math.round(premioMaximo) : base.premioMaximo,
    notasGerais: typeof raw?.notasGerais === 'string' ? raw.notasGerais : '',
  };
}

function hasRecompensaConfig(value: ObjetivosRecompensa) {
  return Boolean(
    value.patamar50.trim() ||
      value.patamar65.trim() ||
      value.patamar80.trim() ||
      value.premioMaximo > 0 ||
      value.notasGerais.trim(),
  );
}

function mergeLegacyRecompensaFromItems(rawItems: any[]): ObjetivosRecompensa {
  const reward = createDefaultRecompensaGlobal();

  for (const raw of rawItems) {
    const recompensa80 = typeof raw?.recompensa80 === 'string' ? raw.recompensa80.trim() : '';
    const recompensa100 = typeof raw?.recompensa100 === 'string' ? raw.recompensa100.trim() : '';

    if (recompensa80) reward.patamar65 = recompensa80;
    if (recompensa100) reward.patamar80 = recompensa100;
  }

  return reward;
}

function parseObjetivosFromStorage(
  rawObjetivos?: string | null,
  rawPremio?: string | null,
): { items: ObjetivoItem[]; recompensa: ObjetivosRecompensa } {
  const objetivosText = String(rawObjetivos || '').trim();
  const premioText = String(rawPremio || '').trim();

  if (objetivosText) {
    try {
      const parsed = JSON.parse(objetivosText);

      if (Array.isArray(parsed)) {
        const mapped = parsed.map((item) => normalizeObjetivoItem(item)).filter((item) => item.titulo);
        let recompensa = mergeLegacyRecompensaFromItems(parsed);
        if (!hasRecompensaConfig(recompensa) && premioText) {
          recompensa = { ...recompensa, patamar80: premioText };
        }
        return { items: mapped, recompensa };
      }

      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).items)) {
        const rawItems = (parsed as any).items;
        const mapped = rawItems.map((item: any) => normalizeObjetivoItem(item)).filter((item: ObjetivoItem) => item.titulo);
        const fromPayload = normalizeRecompensaGlobal((parsed as any).recompensa);
        const fromLegacyItems = mergeLegacyRecompensaFromItems(rawItems);
        let recompensa = hasRecompensaConfig(fromPayload) ? fromPayload : fromLegacyItems;
        if (!hasRecompensaConfig(recompensa) && premioText) {
          recompensa = { ...recompensa, patamar80: premioText };
        }
        return { items: mapped, recompensa };
      }
    } catch {
      return {
        items: [
          {
            ...createDefaultObjetivo(),
            titulo: objetivosText,
          },
        ],
        recompensa: premioText ? { ...createDefaultRecompensaGlobal(), patamar80: premioText } : createDefaultRecompensaGlobal(),
      };
    }

    return {
      items: [
        {
          ...createDefaultObjetivo(),
          titulo: objetivosText,
        },
      ],
      recompensa: premioText ? { ...createDefaultRecompensaGlobal(), patamar80: premioText } : createDefaultRecompensaGlobal(),
    };
  }

  if (premioText) {
    return {
      items: [],
      recompensa: { ...createDefaultRecompensaGlobal(), patamar80: premioText },
    };
  }

  return {
    items: [],
    recompensa: createDefaultRecompensaGlobal(),
  };
}

function serializeObjetivosForStorage(items: ObjetivoItem[], recompensaGlobal: ObjetivosRecompensa) {
  const clean = items
    .map((item) => normalizeObjetivoItem(item))
    .filter((item) => item.titulo)
    .map((item) => {
      const metaTipo = normalizeObjetivoMetaTipo(item.metaTipo);
      const meta = metaTipo === 'PERCENT' ? clampWeight(item.meta) : clampCount(item.meta);
      const atingido = metaTipo === 'PERCENT' ? clampWeight(item.atingido) : clampCount(item.atingido);
      const normalizedItem = { ...item, metaTipo, meta, atingido };
      return {
        ...normalizedItem,
        peso: clampWeight(item.peso),
        erros: clampCount(item.erros),
        progresso: getObjetivoPercent(normalizedItem),
        concluido: isObjetivoAtingido(normalizedItem),
        notas: item.notas.trim(),
        deadline: normalizeIsoDate(item.deadline) || '',
        titulo: item.titulo.trim(),
      };
    });

  const recompensa = normalizeRecompensaGlobal(recompensaGlobal);
  recompensa.patamar50 = recompensa.patamar50.trim();
  recompensa.patamar65 = recompensa.patamar65.trim();
  recompensa.patamar80 = recompensa.patamar80.trim();
  recompensa.premioMaximo = Math.max(0, Math.round(Number(recompensa.premioMaximo) || 0));
  recompensa.notasGerais = recompensa.notasGerais.trim();

  const hasReward = hasRecompensaConfig(recompensa);

  if (clean.length === 0 && !hasReward) {
    return {
      objetivos: null as string | null,
      premioObjetivos: null as string | null,
    };
  }

  const payload = JSON.stringify({
    version: 5,
    items: clean,
    recompensa,
  });

  const premioResumo = hasReward
    ? `Patamares | 50%: ${recompensa.patamar50} | 65%: ${recompensa.patamar65} | 80%: ${recompensa.patamar80} | Premio maximo: ${recompensa.premioMaximo} EUR`
    : null;

  return {
    objetivos: payload,
    premioObjetivos: premioResumo,
  };
}

function parseTimeToMinutes(value: string) {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function getExpectedMinutesFromHorario(horario?: string | null) {
  const value = String(horario || '').trim();
  if (!value) return null;

  const regex = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g;
  let total = 0;
  let hasSegment = false;

  for (const match of value.matchAll(regex)) {
    const start = parseTimeToMinutes(match[1]);
    const end = parseTimeToMinutes(match[2]);
    if (start === null || end === null || end <= start) continue;
    total += end - start;
    hasSegment = true;
  }

  return hasSegment ? total : null;
}

function diffMinutes(startIso: string, endIso: string) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.round((end - start) / 60000);
}

function calculateDayMetrics(day: PunchDayGroup, expectedMinutes: number | null): PunchDayMetrics {
  const ordered = [...day.all].sort((a, b) => new Date(a.momento).getTime() - new Date(b.momento).getTime());
  let workedMinutes = 0;
  let openEntrada: RegistoPonto | null = null;
  let incompleteCount = 0;

  for (const registo of ordered) {
    const tipo = String(registo.tipo).toUpperCase();
    const isEntrada = tipo.includes('ENTRADA');
    const isSaida = tipo.includes('SAIDA');

    if (isEntrada) {
      if (openEntrada) incompleteCount += 1;
      openEntrada = registo;
      continue;
    }

    if (isSaida) {
      if (!openEntrada) {
        incompleteCount += 1;
        continue;
      }
      workedMinutes += diffMinutes(openEntrada.momento, registo.momento);
      openEntrada = null;
    }
  }

  if (openEntrada) incompleteCount += 1;

  const saldoMinutes = expectedMinutes === null ? null : workedMinutes - expectedMinutes;
  return {
    workedMinutes,
    expectedMinutes,
    saldoMinutes,
    incomplete: incompleteCount > 0,
    openPairCount: incompleteCount,
  };
}

function formatMinutesAsHours(minutes: number) {
  const safe = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  const hh = Math.floor(safe / 60);
  const mm = safe % 60;
  return `${String(hh).padStart(2, '0')}h${String(mm).padStart(2, '0')}`;
}

function formatSignedMinutes(minutes: number) {
  const rounded = Math.round(minutes);
  const sign = rounded >= 0 ? '+' : '-';
  return `${sign}${formatMinutesAsHours(Math.abs(rounded))}`;
}

function normalizeIdToken(value: unknown) {
  return String(value ?? '')
    .trim()
    .replace(/[{}]/g, '')
    .toLowerCase();
}

const FuncionariosPage = () => {
  const toast = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const [funcionarios, setFuncionarios] = useState<Funcionario[]>([]);
  const [funcLoading, setFuncLoading] = useState(true);
  const [funcError, setFuncError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeFormTab, setActiveFormTab] = useState<FormTab>('informacao');

  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [telefone, setTelefone] = useState('');
  const [pin, setPin] = useState('');
  const [activo, setActivo] = useState(true);
  const [horarioTrabalho, setHorarioTrabalho] = useState('');
  const [localTrabalho, setLocalTrabalho] = useState('');
  const [dataNascimento, setDataNascimento] = useState('');
  const [objetivosLista, setObjetivosLista] = useState<ObjetivoItem[]>([]);
  const [recompensaGlobal, setRecompensaGlobal] = useState<ObjetivosRecompensa>(() => createDefaultRecompensaGlobal());
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [bulkObjetivosLoading, setBulkObjetivosLoading] = useState(false);

  const [currentUserEmail, setCurrentUserEmail] = useState<string>('');
  const canManageObjetivos = currentUserEmail.toLowerCase() === 'mpr@mpr.pt';
  const canRetificar = canManageObjetivos;

  const [formPicagens, setFormPicagens] = useState<RegistoPonto[]>([]);
  const [formPicagensLoading, setFormPicagensLoading] = useState(false);
  const [formPicagensError, setFormPicagensError] = useState<string | null>(null);
  const [slotTimeDrafts, setSlotTimeDrafts] = useState<Record<string, string>>({});
  const [picagensPeriodoInicio, setPicagensPeriodoInicio] = useState('');
  const [picagensPeriodoFim, setPicagensPeriodoFim] = useState('');

  const [formFeriasResumo, setFormFeriasResumo] = useState<FeriasResumo | null>(null);
  const [formFeriasLoading, setFormFeriasLoading] = useState(false);
  const [formFeriasError, setFormFeriasError] = useState<string | null>(null);
  const [formFeriasYear, setFormFeriasYear] = useState<number>(new Date().getFullYear());
  const [formPedidos, setFormPedidos] = useState<FormPedido[]>([]);
  const [formPedidosLoading, setFormPedidosLoading] = useState(false);
  const [formPedidosError, setFormPedidosError] = useState<string | null>(null);
  const [formPedidosYear, setFormPedidosYear] = useState<number>(new Date().getFullYear());

  const [pinInput, setPinInput] = useState('');
  const [clockMessage, setClockMessage] = useState<string | null>(null);
  const [clockError, setClockError] = useState<string | null>(null);
  const [clockLoading, setClockLoading] = useState(false);

  const [registos, setRegistos] = useState<RegistoPonto[]>([]);
  const [registosLoading, setRegistosLoading] = useState(true);

  const [selectedFuncionarioId, setSelectedFuncionarioId] = useState<'all' | string>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const getFuncionarioIdCandidates = (funcionarioId: string) => {
    const selected = funcionarios.find((f) => f.id === funcionarioId);
    const ids = new Set<string>([normalizeIdToken(funcionarioId)]);
    if (!selected) return ids;

    const nomeKey = selected.nome.trim().toLowerCase();
    const emailKey = String(selected.email || '').trim().toLowerCase();

    for (const func of funcionarios) {
      const sameNome = func.nome.trim().toLowerCase() === nomeKey;
      const sameEmail = emailKey && String(func.email || '').trim().toLowerCase() === emailKey;
      if (sameNome || sameEmail) {
        ids.add(normalizeIdToken(func.id));
      }
    }

    return ids;
  };
  useEffect(() => {
    void (async () => {
      const res = await supabase.auth.getUser();
      const email = res.data.user?.email || '';
      setCurrentUserEmail(email);
    })();
  }, []);

  useEffect(() => {
    const fetchFuncionarios = async () => {
      setFuncLoading(true);
      setFuncError(null);

      const { data, error } = await supabase.from('funcionarios').select('*').order('nome', { ascending: true });

      if (error) {
        console.error(error);
        setFuncError('Nao foi possivel carregar os funcionarios.');
      } else {
        setFuncionarios(sortByNome((data || []) as Funcionario[]));
      }

      setFuncLoading(false);
    };

    void fetchFuncionarios();
  }, []);

  const loadRecentRegistos = async () => {
    setRegistosLoading(true);

    const primary = await supabase
      .from('registos_ponto')
      .select(
        `
          id,
          momento,
          tipo,
          origem,
          funcionario:funcionarios(
            id,
            nome
          )
        `,
      )
      .order('momento', { ascending: false })
      .limit(10);

    if (!primary.error) {
      setRegistos((primary.data || []).map(mapRegistoPonto));
      setRegistosLoading(false);
      return;
    }

    const fallback = await supabase
      .from('registos_ponto')
      .select(
        `
          id,
          timestamp,
          tipo,
          origem,
          funcionario:funcionarios(
            id,
            nome
          )
        `,
      )
      .order('timestamp', { ascending: false })
      .limit(10);

    if (fallback.error) {
      console.error(fallback.error);
      setRegistos([]);
      setRegistosLoading(false);
      return;
    }

    const normalized = (fallback.data || []).map((row: any) => ({
      id: Number(row.id),
      momento: String(row.timestamp),
      tipo: String(row.tipo || ''),
      origem: row.origem ? String(row.origem) : null,
      funcionario: row.funcionario || null,
    }));
    setRegistos(normalized);
    setRegistosLoading(false);
  };

  useEffect(() => {
    void loadRecentRegistos();
  }, []);

  const resetForm = () => {
    setEditingId(null);
    setActiveFormTab('informacao');
    setNome('');
    setEmail('');
    setTelefone('');
    setPin('');
    setActivo(true);
    setHorarioTrabalho('');
    setLocalTrabalho('');
    setDataNascimento('');
    setObjetivosLista([]);
    setRecompensaGlobal(createDefaultRecompensaGlobal());
    setFormError(null);
    setFormPicagens([]);
    setFormPicagensError(null);
    setFormFeriasResumo(null);
    setFormFeriasError(null);
    setFormFeriasYear(new Date().getFullYear());
    setFormPedidos([]);
    setFormPedidosError(null);
    setFormPedidosYear(new Date().getFullYear());
    setSlotTimeDrafts({});
    setPicagensPeriodoInicio('');
    setPicagensPeriodoFim('');
  };

  const openCreateForm = () => {
    resetForm();
    setShowForm(true);
  };

  const handleEditFuncionario = (f: Funcionario) => {
    const hojeIso = toIsoDate(new Date());
    const inicioMesIso = `${hojeIso.slice(0, 8)}01`;

    setEditingId(f.id);
    setActiveFormTab('informacao');
    setNome(f.nome);
    setEmail(f.email);
    setTelefone(f.telefone ?? '');
    setPin(f.pin ?? '');
    setActivo(Boolean(f.activo));
    setHorarioTrabalho(f.horario_trabalho ?? '');
    setLocalTrabalho(f.local_trabalho ?? '');
    setDataNascimento(f.data_nascimento ?? '');
    const objetivosParsed = parseObjetivosFromStorage(f.objetivos, f.premio_objetivos);
    setObjetivosLista(objetivosParsed.items);
    setRecompensaGlobal(objetivosParsed.recompensa);
    setFormError(null);
    setFormPicagens([]);
    setFormPicagensError(null);
    setFormFeriasResumo(null);
    setFormFeriasError(null);
    setFormFeriasYear(new Date().getFullYear());
    setFormPedidos([]);
    setFormPedidosError(null);
    setFormPedidosYear(new Date().getFullYear());
    setSlotTimeDrafts({});
    setPicagensPeriodoInicio(inicioMesIso);
    setPicagensPeriodoFim(hojeIso);
    setShowForm(true);
  };

  const handleDeleteFuncionario = async (f: Funcionario) => {
    const ok = await confirm({
      title: 'Remover Funcionário',
      message: `Tem a certeza que pretende remover o funcionário "${f.nome}"?`,
      confirmLabel: 'Remover',
      variant: 'danger',
    });
    if (!ok) return;

    const { error } = await supabase.from('funcionarios').delete().eq('id', f.id);
    if (error) {
      console.error(error);
      toast.error('Não foi possível remover o funcionário.');
      return;
    }

    setFuncionarios((prev) => prev.filter((x) => x.id !== f.id));
    toast.success(`Funcionário "${f.nome}" removido.`);
  };

  const handleSaveFuncionario = async () => {
    setFormError(null);

    if (!nome.trim() || !email.trim() || !pin.trim()) {
      setFormError('Nome, email e PIN sao obrigatorios.');
      return;
    }

    if (canManageObjetivos) {
      const objetivosComTitulo = objetivosLista.map((item) => normalizeObjetivoItem(item)).filter((item) => item.titulo);
      const pesoTotal = objetivosComTitulo.reduce((acc, item) => acc + clampWeight(item.peso), 0);
      if (objetivosComTitulo.length > 0 && pesoTotal !== 100) {
        setFormError(`A soma dos pesos dos objetivos deve ser 100%. Atual: ${pesoTotal}%.`);
        return;
      }
    }

    setFormLoading(true);

    const objetivosStorage = serializeObjetivosForStorage(objetivosLista, recompensaGlobal);

    const payload = {
      nome: nome.trim(),
      email: email.trim(),
      telefone: telefone.trim() || null,
      pin: pin.trim(),
      activo,
      horario_trabalho: horarioTrabalho.trim() || null,
      local_trabalho: localTrabalho.trim() || null,
      data_nascimento: dataNascimento || null,
      objetivos: objetivosStorage.objetivos,
      premio_objetivos: objetivosStorage.premioObjetivos,
    };

    try {
      if (editingId) {
        const { data, error } = await supabase.from('funcionarios').update(payload).eq('id', editingId).select().single();
        if (error) throw error;
        if (data) {
          setFuncionarios((prev) => sortByNome(prev.map((item) => (item.id === editingId ? (data as Funcionario) : item))));
        }
      } else {
        const { data, error } = await supabase.from('funcionarios').insert([payload]).select().single();
        if (error) throw error;
        if (data) {
          setFuncionarios((prev) => sortByNome([...prev, data as Funcionario]));
        }
      }

      setShowForm(false);
      resetForm();
    } catch (error: any) {
      console.error(error);
      if (error.code === '23505') {
        if (error.message?.includes('funcionarios_email_key')) {
          setFormError('Ja existe um funcionario com esse email.');
        } else if (error.message?.includes('funcionarios_pin_key')) {
          setFormError('O PIN ja esta em uso por outro funcionario.');
        } else {
          setFormError('Dados duplicados. Verifique email e PIN.');
        }
      } else {
        setFormError('Nao foi possivel guardar o funcionario.');
      }
    } finally {
      setFormLoading(false);
    }
  };

  const handleAddObjetivo = () => {
    if (!canManageObjetivos) return;
    setObjetivosLista((prev) => {
      const pesoAtual = prev.reduce((acc, item) => acc + clampWeight(item.peso), 0);
      const restante = Math.max(0, 100 - pesoAtual);
      return [...prev, { ...createDefaultObjetivo(), peso: restante }];
    });
  };

  const handleDistribuirPesos = () => {
    if (!canManageObjetivos) return;
    setObjetivosLista((prev) => {
      if (prev.length === 0) return prev;

      const totalAtual = prev.reduce((acc, item) => acc + clampWeight(item.peso), 0);
      let novaLista = prev.map((item) => ({ ...item }));

      if (totalAtual <= 0) {
        const base = Math.floor(100 / novaLista.length);
        let restante = 100 - base * novaLista.length;
        novaLista = novaLista.map((item) => {
          const extra = restante > 0 ? 1 : 0;
          if (restante > 0) restante -= 1;
          return { ...item, peso: base + extra };
        });
        return novaLista;
      }

      let soma = 0;
      novaLista = novaLista.map((item) => {
        const pesoEscalado = Math.round((clampWeight(item.peso) / totalAtual) * 100);
        soma += pesoEscalado;
        return { ...item, peso: pesoEscalado };
      });

      let diff = 100 - soma;
      while (diff !== 0 && novaLista.length > 0) {
        let ajustou = false;
        for (let i = novaLista.length - 1; i >= 0; i -= 1) {
          if (diff > 0 && novaLista[i].peso < 100) {
            novaLista[i].peso += 1;
            diff -= 1;
            ajustou = true;
          } else if (diff < 0 && novaLista[i].peso > 0) {
            novaLista[i].peso -= 1;
            diff += 1;
            ajustou = true;
          }
          if (diff === 0) break;
        }
        if (!ajustou) break;
      }

      return novaLista;
    });
  };

  const handleRemoveObjetivo = (id: string) => {
    if (!canManageObjetivos) return;
    setObjetivosLista((prev) => prev.filter((item) => item.id !== id));
  };

  const handleUpdateObjetivo = (id: string, patch: Partial<ObjetivoItem>) => {
    if (!canManageObjetivos) return;
    setObjetivosLista((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;
        const previousMetaTipo = item.metaTipo;
        let merged = normalizeObjetivoItem({ ...item, ...patch });

        if (merged.metaTipo === 'PERCENT') {
          merged = {
            ...merged,
            meta: clampWeight(merged.meta),
            atingido: clampWeight(merged.atingido),
          };
          if (patch.metaTipo === 'PERCENT' && previousMetaTipo !== 'PERCENT' && merged.meta === 0) {
            merged.meta = 100;
          }
        }

        return merged;
      }),
    );
  };

  const handleUpdateRecompensaGlobal = (patch: Partial<ObjetivosRecompensa>) => {
    if (!canManageObjetivos) return;
    setRecompensaGlobal((prev) => normalizeRecompensaGlobal({ ...prev, ...patch }));
  };

  const handleApplyObjetivosToAll = async () => {
    if (!canManageObjetivos || bulkObjetivosLoading) return;
    setFormError(null);

    const objetivosComTitulo = objetivosLista.map((item) => normalizeObjetivoItem(item)).filter((item) => item.titulo);
    const pesoTotal = objetivosComTitulo.reduce((acc, item) => acc + clampWeight(item.peso), 0);
    if (objetivosComTitulo.length > 0 && pesoTotal !== 100) {
      setFormError(`A soma dos pesos dos objetivos deve ser 100%. Atual: ${pesoTotal}%.`);
      return;
    }

    if (funcionarios.length === 0) {
      setFormError('Nao existem funcionarios para aplicar objetivos.');
      return;
    }

    const confirmed = await confirm({
      title: 'Aplicar Objetivos a Todos',
      message: `Aplicar estes objetivos a ${funcionarios.length} funcionário(s)? Esta ação substitui os objetivos atuais de todos.`,
      confirmLabel: 'Aplicar',
      variant: 'warning',
    });
    if (!confirmed) return;

    setBulkObjetivosLoading(true);
    try {
      const objetivosStorage = serializeObjetivosForStorage(objetivosLista, recompensaGlobal);
      const targetIds = funcionarios.map((f) => f.id);
      const { data, error } = await supabase
        .from('funcionarios')
        .update({
          objetivos: objetivosStorage.objetivos,
          premio_objetivos: objetivosStorage.premioObjetivos,
        })
        .in('id', targetIds)
        .select('id, objetivos, premio_objetivos');

      if (error) throw error;

      if (data) {
        const byId = new Map<string, { objetivos: string | null; premio_objetivos: string | null }>();
        for (const row of data as Array<{ id: string; objetivos: string | null; premio_objetivos: string | null }>) {
          byId.set(row.id, { objetivos: row.objetivos, premio_objetivos: row.premio_objetivos });
        }
        setFuncionarios((prev) =>
          prev.map((f) => {
            const updated = byId.get(f.id);
            if (!updated) return f;
            return {
              ...f,
              objetivos: updated.objetivos,
              premio_objetivos: updated.premio_objetivos,
            };
          }),
        );
      }

      toast.success(`Objetivos aplicados a ${funcionarios.length} funcionário(s).`);
    } catch (error) {
      console.error(error);
      setFormError('Nao foi possivel aplicar os objetivos a todos os funcionarios.');
    } finally {
      setBulkObjetivosLoading(false);
    }
  };

  const fetchFormPicagens = async (funcionarioId: string) => {
    const primary = await supabase
      .from('registos_ponto')
      .select('id, momento, tipo, origem')
      .eq('funcionario_id', funcionarioId)
      .order('momento', { ascending: false })
      .limit(120);

    if (!primary.error) {
      return (primary.data || []).map(mapRegistoPonto);
    }

    const fallback = await supabase
      .from('registos_ponto')
      .select('id, timestamp, tipo, origem')
      .eq('funcionario_id', funcionarioId)
      .order('timestamp', { ascending: false })
      .limit(120);

    if (fallback.error) {
      throw fallback.error;
    }

    return (fallback.data || []).map(mapRegistoPonto);
  };

  const loadFormPicagens = async (funcionarioId: string) => {
    setFormPicagensLoading(true);
    setFormPicagensError(null);

    try {
      const rows = await fetchFormPicagens(funcionarioId);
      setFormPicagens(rows);

      const nextDrafts: Record<string, string> = {};
      for (const row of rows) {
        nextDrafts[String(row.id)] = formatTimeInput(row.momento);
      }
      setSlotTimeDrafts(nextDrafts);
    } catch (error) {
      console.error(error);
      setFormPicagensError('Nao foi possivel carregar as picagens deste funcionario.');
      setFormPicagens([]);
    } finally {
      setFormPicagensLoading(false);
    }
  };

  const loadFormFerias = async (funcionarioId: string, year: number) => {
    setFormFeriasLoading(true);
    setFormFeriasError(null);

    const ano = year;
    const yearStart = `${ano}-01-01`;
    const yearEnd = `${ano}-12-31`;

    const saldoRes = await supabase
      .from('ferias_saldos')
      .select('dias_direito, dias_extra, dias_usados_manual')
      .eq('funcionario_id', funcionarioId)
      .eq('ano', ano)
      .maybeSingle();

    if (saldoRes.error && isMissingRelationError(saldoRes.error)) {
      setFormFeriasResumo(null);
      setFormFeriasError('Tabela ferias_saldos nao existe ainda. Aplique a migration de ferias.');
      setFormFeriasLoading(false);
      return;
    }

    if (saldoRes.error) {
      console.error(saldoRes.error);
      setFormFeriasResumo(null);
      setFormFeriasError('Nao foi possivel carregar o saldo de ferias.');
      setFormFeriasLoading(false);
      return;
    }

    const holidayRes = await supabase.from('holidays').select('date');
    const holidaySet = new Set<string>();
    if (!holidayRes.error) {
      for (const row of holidayRes.data || []) {
        holidaySet.add(String((row as any).date));
      }
    }

    const pedidoColumns = 'id, tipo, status, data_inicio, data_fim, funcionario_id, atribuido_a, created_at';
    const pedidosRes = await supabase.from('pedidos').select(pedidoColumns).order('created_at', { ascending: false });
    if (pedidosRes.error && !isMissingRelationError(pedidosRes.error)) {
      console.error(pedidosRes.error);
    }

    const idCandidates = getFuncionarioIdCandidates(funcionarioId);
    const pedidosMap = new Map<string, any>();
    for (const row of pedidosRes.data || []) {
      const funcId = normalizeIdToken((row as any).funcionario_id);
      const atribId = normalizeIdToken((row as any).atribuido_a);
      if (!idCandidates.has(funcId) && !idCandidates.has(atribId)) continue;
      pedidosMap.set(String((row as any).id), row);
    }

    const periodosRes = await supabase
      .from('ferias_empresa_periodos')
      .select('id, titulo, data_inicio, data_fim, funcionarios_alvo')
      .lte('data_inicio', yearEnd)
      .gte('data_fim', yearStart)
      .order('data_inicio', { ascending: true });

    const diasFeriasSet = new Set<string>();
    const periodos: FeriasResumoPeriodo[] = [];
    const periodosKeys = new Set<string>();

    const appendPeriodo = (inicio: string, fim: string, origem: string) => {
      const clamped = clampRangeToYear(inicio, fim, ano);
      if (!clamped) return;
      const dates = iterateBusinessDates(clamped.start, clamped.end, holidaySet);
      for (const day of dates) diasFeriasSet.add(day);

      const key = `${origem}|${clamped.start}|${clamped.end}`;
      if (periodosKeys.has(key)) return;
      periodosKeys.add(key);
      periodos.push({ inicio: clamped.start, fim: clamped.end, origem, diasUteis: dates.length });
    };

    for (const pedido of pedidosMap.values()) {
      if (!isPedidoAprovado((pedido as any).status)) continue;
      const tipo = normalizePedidoTipo((pedido as any).tipo);
      if (!isVacationType(tipo)) continue;
      const startIso = normalizeIsoDate(pedido.data_inicio);
      const endIso = normalizeIsoDate(pedido.data_fim) || startIso;
      if (!startIso || !endIso) continue;
      appendPeriodo(startIso, endIso, tipo === 'FERIAS_EMPRESA' ? 'Ferias empresa (pedido)' : 'Ferias (pedido)');
    }

    if (!periodosRes.error) {
      for (const row of periodosRes.data || []) {
        const targets = Array.isArray((row as any).funcionarios_alvo)
          ? ((row as any).funcionarios_alvo as unknown[]).map((item) => String(item))
          : [];
        if (targets.length > 0 && !targets.includes(funcionarioId)) continue;

        const startIso = normalizeIsoDate(String((row as any).data_inicio));
        const endIso = normalizeIsoDate(String((row as any).data_fim)) || startIso;
        if (!startIso || !endIso) continue;
        appendPeriodo(startIso, endIso, 'Ferias empresa');
      }
    }

    periodos.sort((a, b) => a.inicio.localeCompare(b.inicio) || a.fim.localeCompare(b.fim));

    const diasDireito = safeNumber(saldoRes.data?.dias_direito, 22);
    const diasExtra = safeNumber(saldoRes.data?.dias_extra, 0);
    const diasUsadosManual = safeNumber(saldoRes.data?.dias_usados_manual, 0);
    const diasAprovados = diasFeriasSet.size;
    const diasUsadosTotal = diasUsadosManual + diasAprovados;
    const diasRestantes = diasDireito + diasExtra - diasUsadosTotal;

    setFormFeriasResumo({
      ano,
      diasDireito,
      diasExtra,
      diasUsadosManual,
      diasAprovados,
      diasUsadosTotal,
      diasRestantes,
      periodos,
    });

    setFormFeriasLoading(false);
  };

  const loadFormPedidos = async (funcionarioId: string, year: number) => {
    setFormPedidosLoading(true);
    setFormPedidosError(null);

    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const pedidoColumns = 'id, created_at, tipo, status, data_inicio, data_fim, descricao, resolucao, funcionario_id, atribuido_a';
    const pedidosRes = await supabase.from('pedidos').select(pedidoColumns).order('created_at', { ascending: false });

    if (pedidosRes.error) {
      if (!isMissingRelationError(pedidosRes.error)) {
        console.error(pedidosRes.error);
      }
      setFormPedidos([]);
      setFormPedidosError('Nao foi possivel carregar os pedidos deste funcionario.');
      setFormPedidosLoading(false);
      return;
    }

    const idCandidates = getFuncionarioIdCandidates(funcionarioId);
    const pedidosMap = new Map<string, any>();
    for (const row of pedidosRes.data || []) {
      const funcId = normalizeIdToken((row as any).funcionario_id);
      const atribId = normalizeIdToken((row as any).atribuido_a);
      if (!idCandidates.has(funcId) && !idCandidates.has(atribId)) continue;
      pedidosMap.set(String((row as any).id), row);
    }

    const rows = Array.from(pedidosMap.values())
      .map((row) => {
        const createdAt = String((row as any).created_at || '');
        const dataInicio = normalizeIsoDate((row as any).data_inicio);
        const dataFim = normalizeIsoDate((row as any).data_fim) || dataInicio;
        return {
          id: String((row as any).id),
          created_at: createdAt,
          tipo: normalizePedidoTipo((row as any).tipo),
          status: normalizePedidoStatus((row as any).status),
          data_inicio: dataInicio,
          data_fim: dataFim,
          descricao: String((row as any).descricao || '').trim(),
          resolucao: (row as any).resolucao ? String((row as any).resolucao) : null,
        } as FormPedido;
      })
      .filter((row) => {
        if (row.data_inicio && row.data_fim) {
          return row.data_inicio <= yearEnd && row.data_fim >= yearStart;
        }
        const createdIso = normalizeIsoDate(row.created_at);
        if (!createdIso) return false;
        return createdIso >= yearStart && createdIso <= yearEnd;
      })
      .sort((a, b) => {
        const aKey = a.data_inicio || normalizeIsoDate(a.created_at) || '';
        const bKey = b.data_inicio || normalizeIsoDate(b.created_at) || '';
        return bKey.localeCompare(aKey) || b.created_at.localeCompare(a.created_at);
      });

    setFormPedidos(rows);
    setFormPedidosLoading(false);
  };

  useEffect(() => {
    if (!showForm || !editingId) return;
    if (activeFormTab === 'picagens') void loadFormPicagens(editingId);
    if (activeFormTab === 'ferias') void loadFormFerias(editingId, formFeriasYear);
    if (activeFormTab === 'pedidos') void loadFormPedidos(editingId, formPedidosYear);
  }, [showForm, editingId, activeFormTab, formFeriasYear, formPedidosYear]);
  const groupedPicagens = useMemo<PunchDayGroup[]>(() => {
    const byDay = new Map<string, RegistoPonto[]>();

    for (const row of formPicagens) {
      const dateIso = toIsoDate(new Date(row.momento));
      if (!byDay.has(dateIso)) byDay.set(dateIso, []);
      byDay.get(dateIso)!.push(row);
    }

    const days: PunchDayGroup[] = [];
    for (const [dateIso, list] of byDay.entries()) {
      const sorted = [...list].sort((a, b) => new Date(a.momento).getTime() - new Date(b.momento).getTime());

      const entradas = sorted.filter((item) => String(item.tipo).toUpperCase().includes('ENTRADA'));
      const saidas = sorted.filter((item) => String(item.tipo).toUpperCase().includes('SAIDA'));

      const slots: Record<PunchSlotKey, RegistoPonto | null> = {
        entrada1: entradas[0] || null,
        saida1: saidas[0] || null,
        entrada2: entradas[1] || null,
        saida2: saidas[1] || null,
      };

      const used = new Set<number>();
      for (const slot of Object.values(slots)) {
        if (slot) used.add(slot.id);
      }

      const extras = sorted.filter((item) => !used.has(item.id));
      days.push({
        dateIso,
        dateLabel: new Date(`${dateIso}T00:00:00`).toLocaleDateString('pt-PT'),
        slots,
        extras,
        all: sorted,
      });
    }

    return days.sort((a, b) => b.dateIso.localeCompare(a.dateIso));
  }, [formPicagens]);

  const filteredGroupedPicagens = useMemo(() => {
    return groupedPicagens.filter((day) => {
      if (picagensPeriodoInicio && day.dateIso < picagensPeriodoInicio) return false;
      if (picagensPeriodoFim && day.dateIso > picagensPeriodoFim) return false;
      return true;
    });
  }, [groupedPicagens, picagensPeriodoInicio, picagensPeriodoFim]);

  const expectedWorkMinutes = useMemo(() => getExpectedMinutesFromHorario(horarioTrabalho), [horarioTrabalho]);

  const dayMetricsByDate = useMemo(() => {
    const metricsMap = new Map<string, PunchDayMetrics>();
    for (const day of filteredGroupedPicagens) {
      metricsMap.set(day.dateIso, calculateDayMetrics(day, expectedWorkMinutes));
    }
    return metricsMap;
  }, [filteredGroupedPicagens, expectedWorkMinutes]);

  const objetivosResumo = useMemo(() => {
    const total = objetivosLista.length;
    const concluidoCount = objetivosLista.filter((item) => isObjetivoAtingido(item)).length;
    const somaPercent = objetivosLista.reduce((acc, item) => acc + getObjetivoPercent(item), 0);
    const progressoMedio = total > 0 ? Math.round(somaPercent / total) : 0;
    const metaTotal = objetivosLista.reduce((acc, item) => acc + clampCount(item.meta), 0);
    const atingidoTotal = objetivosLista.reduce((acc, item) => acc + clampCount(item.atingido), 0);
    const errosTotal = objetivosLista.reduce((acc, item) => acc + clampCount(item.erros), 0);
    const comUmErro = objetivosLista.filter((item) => clampCount(item.erros) === 1).length;
    const comDoisOuMaisErros = objetivosLista.filter((item) => clampCount(item.erros) >= 2).length;

    const pesoTotal = objetivosLista.reduce((acc, item) => acc + clampWeight(item.peso), 0);
    const percentBrutaPonderadaSoma = objetivosLista.reduce((acc, item) => acc + getObjetivoBasePercent(item) * clampWeight(item.peso), 0);
    const percentFinalPonderadaSoma = objetivosLista.reduce((acc, item) => acc + getObjetivoPercent(item) * clampWeight(item.peso), 0);

    const percentagemBruta = pesoTotal > 0 ? Math.max(0, Math.min(100, Math.round(percentBrutaPonderadaSoma / 100))) : 0;
    const percentagemFinal = pesoTotal > 0 ? Math.max(0, Math.min(100, Math.round(percentFinalPonderadaSoma / 100))) : 0;
    const pesoGap = 100 - pesoTotal;
    const pesoValido = total === 0 || pesoTotal === 100;
    return {
      total,
      concluidoCount,
      progressoMedio,
      metaTotal,
      atingidoTotal,
      errosTotal,
      comUmErro,
      comDoisOuMaisErros,
      pesoTotal,
      pesoGap,
      pesoValido,
      percentagemBruta,
      percentagemFinal,
      todosAtingidos: total > 0 && concluidoCount === total,
    };
  }, [objetivosLista]);

  const incentivoResumo = useMemo(() => {
    const final = objetivosResumo.pesoValido ? objetivosResumo.percentagemFinal : 0;
    const premioMaximo = Math.max(0, Math.round(Number(recompensaGlobal.premioMaximo) || 0));
    const premioProporcional = final >= 80 ? Math.round((final / 100) * premioMaximo) : 0;
    const patamarAtingido =
      !objetivosResumo.pesoValido
        ? 'Pesos invalidos'
        : final >= 80
          ? '80%'
          : final >= 65
            ? '65%'
            : final >= 50
              ? '50%'
              : 'Sem patamar';
    const incentivoLabel =
      !objetivosResumo.pesoValido
        ? 'Ajuste os pesos para totalizar 100%'
        : final >= 80
          ? recompensaGlobal.patamar80
          : final >= 65
            ? recompensaGlobal.patamar65
            : final >= 50
              ? recompensaGlobal.patamar50
              : 'Abaixo de 50%';

    return {
      premioProporcional,
      patamarAtingido,
      incentivoLabel,
    };
  }, [objetivosResumo.percentagemFinal, objetivosResumo.pesoValido, recompensaGlobal]);

  const updateRegistoMomento = async (registoId: number, novoIso: string) => {
    const first = await supabase.from('registos_ponto').update({ momento: novoIso }).eq('id', registoId);
    if (!first.error) return;

    if (!/momento/i.test(String(first.error.message || ''))) {
      throw first.error;
    }

    const fallback = await supabase.from('registos_ponto').update({ timestamp: novoIso }).eq('id', registoId);
    if (fallback.error) throw fallback.error;
  };

  const insertRegisto = async (funcionarioId: string, tipo: 'entrada' | 'saida', novoIso: string) => {
    const first = await supabase.from('registos_ponto').insert({
      funcionario_id: funcionarioId,
      tipo,
      origem: 'retificacao_web',
      momento: novoIso,
    });

    if (!first.error) return;
    if (!/momento/i.test(String(first.error.message || ''))) {
      throw first.error;
    }

    const fallback = await supabase.from('registos_ponto').insert({
      funcionario_id: funcionarioId,
      tipo,
      origem: 'retificacao_web',
      timestamp: novoIso,
    });

    if (fallback.error) throw fallback.error;
  };

  const deleteRegisto = async (registoId: number) => {
    const res = await supabase.from('registos_ponto').delete().eq('id', registoId);
    if (res.error) throw res.error;
  };

  const handleSaveSlotTime = async (row: RegistoPonto) => {
    if (!editingId || !canRetificar) return;
    const draft = slotTimeDrafts[String(row.id)] || formatTimeInput(row.momento);
    const dayIso = toIsoDate(new Date(row.momento));
    const novoIso = combineDateAndTimeIso(dayIso, draft);

    try {
      await updateRegistoMomento(row.id, novoIso);
      await loadFormPicagens(editingId);
    } catch (error) {
      console.error(error);
      toast.error('Não foi possível guardar a retificação da picagem.');
    }
  };

  const handleDeleteSlot = async (row: RegistoPonto) => {
    if (!editingId || !canRetificar) return;
    const ok = await confirm({
      title: 'Apagar Picagem',
      message: 'Pretende apagar esta picagem?',
      confirmLabel: 'Apagar',
      variant: 'danger',
    });
    if (!ok) return;

    try {
      await deleteRegisto(row.id);
      await loadFormPicagens(editingId);
    } catch (error) {
      console.error(error);
      toast.error('Não foi possível apagar a picagem.');
    }
  };

  const handleAddSlot = async (dayIso: string, slotKey: PunchSlotKey) => {
    if (!editingId || !canRetificar) return;
    const meta = SLOT_META[slotKey];
    const novoIso = combineDateAndTimeIso(dayIso, meta.defaultTime);

    try {
      await insertRegisto(editingId, meta.tipo, novoIso);
      await loadFormPicagens(editingId);
    } catch (error) {
      console.error(error);
      toast.error('Não foi possível adicionar a picagem.');
    }
  };

  const handlePrintPicagensPdf = () => {
    if (!editingId) return;
    if (filteredGroupedPicagens.length === 0) {
      toast.warning('Não existem picagens para imprimir.');
      return;
    }

    const funcionarioNome = nome || funcionarios.find((f) => f.id === editingId)?.nome || 'Funcionario';
    const periodoLabel = `${picagensPeriodoInicio || '---'} ate ${picagensPeriodoFim || '---'}`;
    const rowsHtml = filteredGroupedPicagens
      .map((day) => {
        const e1 = day.slots.entrada1 ? formatTimeInput(day.slots.entrada1.momento) : '-';
        const s1 = day.slots.saida1 ? formatTimeInput(day.slots.saida1.momento) : '-';
        const e2 = day.slots.entrada2 ? formatTimeInput(day.slots.entrada2.momento) : '-';
        const s2 = day.slots.saida2 ? formatTimeInput(day.slots.saida2.momento) : '-';
        const metrics = dayMetricsByDate.get(day.dateIso) || calculateDayMetrics(day, expectedWorkMinutes);
        const horas = formatMinutesAsHours(metrics.workedMinutes);
        const saldo = metrics.saldoMinutes === null ? '-' : formatSignedMinutes(metrics.saldoMinutes);
        const alerta = metrics.incomplete ? `Incompleto (${metrics.openPairCount})` : 'OK';
        return `<tr><td>${escapeHtml(day.dateLabel)}</td><td>${e1}</td><td>${s1}</td><td>${e2}</td><td>${s2}</td><td>${horas}</td><td>${saldo}</td><td>${escapeHtml(alerta)}</td></tr>`;
      })
      .join('');

    const popup = window.open('', '_blank', 'width=1200,height=850');
    if (!popup) {
      toast.error('Não foi possível abrir a janela de impressão.');
      return;
    }

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Mapa de Picagens - ${escapeHtml(funcionarioNome)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #0f172a; }
    h1 { margin: 0 0 6px 0; font-size: 20px; }
    p { margin: 0 0 16px 0; font-size: 12px; color: #475569; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: center; font-size: 12px; }
    th { background: #f1f5f9; }
  </style>
</head>
<body>
  <h1>Mapa de Picagens</h1>
  <p>Funcionario: ${escapeHtml(funcionarioNome)} | Periodo: ${escapeHtml(periodoLabel)} | Emitido em ${new Date().toLocaleString('pt-PT')}</p>
  <table>
    <thead>
      <tr><th>Dia</th><th>Entrada 1</th><th>Saida 1</th><th>Entrada 2</th><th>Saida 2</th><th>Horas</th><th>Saldo</th><th>Estado</th></tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;

    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    popup.focus();
    popup.print();
  };
  const handleRegistoPonto = async (tipo: 'entrada' | 'saida') => {
    setClockError(null);
    setClockMessage(null);

    if (!pinInput.trim()) {
      setClockError('Introduza o PIN.');
      return;
    }

    setClockLoading(true);

    const { data: funcionario, error: funcErr } = await supabase.from('funcionarios').select('*').eq('pin', pinInput.trim()).maybeSingle();

    if (funcErr) {
      console.error(funcErr);
      setClockError('Erro ao procurar funcionario.');
      setClockLoading(false);
      return;
    }

    if (!funcionario) {
      setClockError('PIN invalido.');
      setClockLoading(false);
      return;
    }

    const { error: insertErr } = await supabase.from('registos_ponto').insert({
      funcionario_id: funcionario.id,
      tipo,
      origem: 'web',
    });

    if (insertErr) {
      console.error(insertErr);
      setClockError('Nao foi possivel registar o ponto.');
      setClockLoading(false);
      return;
    }

    setClockMessage(`${tipo === 'entrada' ? 'Entrada' : 'Saida'} registada para ${funcionario.nome}.`);
    setPinInput('');
    setClockLoading(false);
    void loadRecentRegistos();
  };

  const handleExportCsv = async () => {
    setExportLoading(true);
    setExportError(null);

    try {
      let query = supabase
        .from('registos_ponto')
        .select(
          `
          id,
          momento,
          tipo,
          origem,
          funcionario:funcionarios (
            id,
            nome
          )
        `,
        )
        .order('momento', { ascending: true });

      if (selectedFuncionarioId !== 'all') {
        query = query.eq('funcionario_id', selectedFuncionarioId);
      }
      if (dateFrom) {
        query = query.gte('momento', `${dateFrom}T00:00:00`);
      }
      if (dateTo) {
        query = query.lte('momento', `${dateTo}T23:59:59`);
      }

      const { data, error } = await query;

      if (error) {
        console.error(error);
        setExportError('Nao foi possivel exportar os registos.');
        setExportLoading(false);
        return;
      }

      if (!data || data.length === 0) {
        setExportError('Nao existem registos para os filtros selecionados.');
        setExportLoading(false);
        return;
      }

      type GroupKey = string;
      type GroupVal = {
        funcionario: string;
        dia: string;
        entradas: string[];
        saidas: string[];
      };

      const grupos = new Map<GroupKey, GroupVal>();

      (data || []).map(mapRegistoPonto).forEach((row) => {
        const dt = new Date(row.momento);
        const dia = dt.toLocaleDateString('pt-PT');
        const hora = dt.toLocaleTimeString('pt-PT', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });

        const funcNome = row.funcionario?.nome ?? '';
        const key = `${funcNome}__${dia}`;

        if (!grupos.has(key)) {
          grupos.set(key, { funcionario: funcNome, dia, entradas: [], saidas: [] });
        }

        const g = grupos.get(key)!;
        if (String(row.tipo).toLowerCase() === 'entrada') g.entradas.push(hora);
        else g.saidas.push(hora);
      });

      const header = ['Funcionario', 'Dia', 'Entrada 1', 'Saida 1', 'Entrada 2', 'Saida 2', 'Entrada 3', 'Saida 3'];
      const lines: string[] = [header.join(',')];

      for (const g of grupos.values()) {
        const row: string[] = [];
        row.push(`"${g.funcionario.replace(/"/g, '""')}"`);
        row.push(g.dia);
        for (let i = 0; i < 3; i += 1) {
          row.push(g.entradas[i] ?? '');
          row.push(g.saidas[i] ?? '');
        }
        lines.push(row.join(','));
      }

      const csvContent = lines.join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const hoje = new Date().toISOString().slice(0, 10);

      link.href = url;
      link.download = `registos_ponto_${hoje}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      setExportError('Erro inesperado ao exportar os registos.');
    } finally {
      setExportLoading(false);
    }
  };

  const getInitials = (name: string | null | undefined) => {
    if (!name) return '?';
    return name.trim().charAt(0).toUpperCase();
  };

  usePageHero(
    <button className="func-primary-btn" onClick={openCreateForm}>
      <span className="func-primary-btn-icon">+</span>
      <span>Novo funcionario</span>
    </button>,
    'right',
  );

  return (
    <div className="func-page">
      <div className="func-page-inner">
        <div className="func-layout">
          <section className="func-card func-team-card">
            <h2>Equipa interna</h2>

            {funcLoading ? (
              <p className="func-muted">A carregar funcionarios...</p>
            ) : funcError ? (
              <p className="func-error-text">{funcError}</p>
            ) : funcionarios.length === 0 ? (
              <p className="func-muted">Ainda nao existem funcionarios registados.</p>
            ) : (
              <div className="func-team-list">
                {funcionarios.map((f) => (
                  <div key={f.id} className="func-team-row">
                    <div className="func-team-row-left">
                      <div className="func-avatar">
                        <span>{getInitials(f.nome)}</span>
                      </div>
                      <div>
                        <div className="func-name">{f.nome}</div>
                        <div className="func-email">{f.email}</div>
                        <div className="func-meta-row">
                          <span>{f.activo ? 'Ativo' : 'Inativo'}</span>
                          <span>{f.local_trabalho || 'Sem local'}</span>
                        </div>
                      </div>
                    </div>
                    <div className="func-team-row-actions">
                      <button className="func-icon-btn" title="Editar" onClick={() => handleEditFuncionario(f)}>
                        Editar
                      </button>
                      <button className="func-icon-btn" title="Remover" onClick={() => handleDeleteFuncionario(f)}>
                        Remover
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          <div className="func-right-column">
            <section className="func-card func-clock-card">
              <div className="func-clock-header">
                <div className="func-clock-icon">P</div>
                <div>
                  <h2>Registo de Ponto</h2>
                  <p>Introduza o PIN pessoal para registar entrada ou saida.</p>
                </div>
              </div>

              <div className="func-clock-pin">
                <input type="password" value={pinInput} onChange={(e) => setPinInput(e.target.value)} maxLength={6} />
              </div>

              {clockError && <p className="func-error-text center">{clockError}</p>}
              {clockMessage && <p className="func-success-text center">{clockMessage}</p>}

              <div className="func-clock-actions">
                <button className="func-enter-btn" onClick={() => handleRegistoPonto('entrada')} disabled={clockLoading}>
                  ENTRADA
                </button>
                <button className="func-exit-btn" onClick={() => handleRegistoPonto('saida')} disabled={clockLoading}>
                  SAIDA
                </button>
              </div>
            </section>

            <section className="func-card func-export-card">
              <div className="func-export-header">
                <h3>Exportar Registos</h3>
              </div>

              <div className="func-export-filters">
                <div className="func-form-field">
                  <label>Funcionario</label>
                  <select value={selectedFuncionarioId} onChange={(e) => setSelectedFuncionarioId(e.target.value === 'all' ? 'all' : e.target.value)}>
                    <option value="all">Todos</option>
                    {funcionarios.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.nome}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="func-export-dates">
                  <div className="func-form-field">
                    <label>De</label>
                    <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                  </div>
                  <div className="func-form-field">
                    <label>Ate</label>
                    <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                  </div>
                </div>
              </div>

              {exportError && <p className="func-error-text">{exportError}</p>}

              <button className="func-export-btn" onClick={handleExportCsv} disabled={exportLoading}>
                {exportLoading ? 'A gerar ficheiro...' : 'Download Excel (CSV)'}
              </button>

              <h4 className="func-subtitle">Ultimos registos</h4>

              {registosLoading ? (
                <p className="func-muted">A carregar registos...</p>
              ) : registos.length === 0 ? (
                <p className="func-muted">Ainda nao existem registos de ponto.</p>
              ) : (
                <div className="func-registos-table-wrapper">
                  <table className="func-registos-table">
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Hora</th>
                        <th>Funcionario</th>
                        <th>Tipo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {registos.map((r) => {
                        const dt = new Date(r.momento);
                        return (
                          <tr key={r.id}>
                            <td>{dt.toLocaleDateString('pt-PT')}</td>
                            <td>{dt.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                            <td>{r.funcionario?.nome ?? ''}</td>
                            <td>{String(r.tipo).toLowerCase() === 'entrada' ? 'Entrada' : 'Saida'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
      {showForm && (
        <div className="func-modal-overlay" onClick={() => !formLoading && setShowForm(false)}>
          <div className="func-modal-window" onClick={(event) => event.stopPropagation()}>
            <div className="func-modal-header">
              <div>
                <h3>{editingId ? `Ficha detalhada: ${nome || 'Funcionario'}` : 'Adicionar funcionario'}</h3>
                <p>Janela completa para gerir dados pessoais, objetivos, picagens, ferias e pedidos.</p>
              </div>
              <button className="func-modal-close" onClick={() => !formLoading && setShowForm(false)}>
                Fechar
              </button>
            </div>

            <div className="func-form-tabs">
              <button className={`func-form-tab ${activeFormTab === 'informacao' ? 'active' : ''}`} onClick={() => setActiveFormTab('informacao')}>
                Informacao
              </button>
              <button className={`func-form-tab ${activeFormTab === 'objetivos' ? 'active' : ''}`} onClick={() => setActiveFormTab('objetivos')}>
                Objetivos
              </button>
              <button
                className={`func-form-tab ${activeFormTab === 'picagens' ? 'active' : ''}`}
                onClick={() => setActiveFormTab('picagens')}
                disabled={!editingId}
              >
                Picagens
              </button>
              <button
                className={`func-form-tab ${activeFormTab === 'ferias' ? 'active' : ''}`}
                onClick={() => setActiveFormTab('ferias')}
                disabled={!editingId}
              >
                Ferias
              </button>
              <button
                className={`func-form-tab ${activeFormTab === 'pedidos' ? 'active' : ''}`}
                onClick={() => setActiveFormTab('pedidos')}
                disabled={!editingId}
              >
                Pedidos
              </button>
            </div>

            {activeFormTab === 'informacao' && (
              <div className="func-tab-panel">
                <div className="func-form-grid">
                  <div className="func-form-field">
                    <label>Nome</label>
                    <input type="text" value={nome} onChange={(e) => setNome(e.target.value)} />
                  </div>
                  <div className="func-form-field">
                    <label>Email</label>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </div>
                  <div className="func-form-field">
                    <label>Telefone</label>
                    <input type="text" value={telefone} onChange={(e) => setTelefone(e.target.value)} />
                  </div>
                  <div className="func-form-field">
                    <label>PIN (4-6 digitos)</label>
                    <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} />
                  </div>
                  <div className="func-form-field">
                    <label>Horario de trabalho</label>
                    <input type="text" value={horarioTrabalho} onChange={(e) => setHorarioTrabalho(e.target.value)} placeholder="Ex: 09:00-18:00" />
                  </div>
                  <div className="func-form-field">
                    <label>Local de trabalho</label>
                    <input type="text" value={localTrabalho} onChange={(e) => setLocalTrabalho(e.target.value)} />
                  </div>
                  <div className="func-form-field">
                    <label>Data de nascimento</label>
                    <input type="date" value={dataNascimento} onChange={(e) => setDataNascimento(e.target.value)} />
                  </div>
                  <div className="func-form-field">
                    <label>Estado</label>
                    <select value={activo ? 'ATIVO' : 'INATIVO'} onChange={(e) => setActivo(e.target.value === 'ATIVO')}>
                      <option value="ATIVO">Ativo</option>
                      <option value="INATIVO">Inativo</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {activeFormTab === 'objetivos' && (
              <div className="func-tab-panel">
                <div className="func-objetivos-toolbar">
                  <div className="func-objetivos-toolbar-actions">
                    <button type="button" className="func-mini-btn" onClick={handleAddObjetivo} disabled={!canManageObjetivos || formLoading || bulkObjetivosLoading}>
                      + Adicionar objetivo
                    </button>
                    <button
                      type="button"
                      className="func-mini-btn"
                      onClick={handleDistribuirPesos}
                      disabled={!canManageObjetivos || objetivosLista.length === 0 || formLoading || bulkObjetivosLoading}
                    >
                      Distribuir 100%
                    </button>
                    <button
                      type="button"
                      className="func-mini-btn primary"
                      onClick={handleApplyObjetivosToAll}
                      disabled={!canManageObjetivos || formLoading || bulkObjetivosLoading}
                    >
                      {bulkObjetivosLoading ? 'A aplicar...' : 'Aplicar a todos'}
                    </button>
                  </div>
                  <span className="func-muted">
                    {canManageObjetivos
                      ? 'Objetivos individuais com uma recompensa unica para o conjunto.'
                      : 'Edicao e aplicacao de objetivos apenas para mpr@mpr.pt.'}
                  </span>
                </div>

                <div className="func-objetivos-summary">
                  <span className="func-day-stat">Objetivos: {objetivosResumo.total}</span>
                  <span className="func-day-stat">Atingidos: {objetivosResumo.concluidoCount}</span>
                  <span className={`func-day-stat ${objetivosResumo.pesoValido ? 'positive' : 'negative'}`}>Peso total: {objetivosResumo.pesoTotal}/100%</span>
                  <span className="func-day-stat">Meta total: {objetivosResumo.metaTotal}</span>
                  <span className="func-day-stat">Total atingido: {objetivosResumo.atingidoTotal}</span>
                  <span className={`func-day-stat ${objetivosResumo.percentagemBruta >= 80 ? 'positive' : objetivosResumo.percentagemBruta >= 50 ? '' : 'negative'}`}>
                    Bruta: {objetivosResumo.percentagemBruta}%
                  </span>
                  <span className={`func-day-stat ${objetivosResumo.percentagemFinal >= 100 ? 'positive' : objetivosResumo.percentagemFinal >= 80 ? '' : 'negative'}`}>
                    Percentagem final: {objetivosResumo.percentagemFinal}%
                  </span>
                  <span className="func-day-stat">Erros: {objetivosResumo.errosTotal}</span>
                  <span className="func-day-stat">1 erro (-50%): {objetivosResumo.comUmErro}</span>
                  <span className="func-day-stat">2+ erros (-100%): {objetivosResumo.comDoisOuMaisErros}</span>
                  {!objetivosResumo.pesoValido && (
                    <span className="func-day-stat negative">
                      Ajuste pesos ({objetivosResumo.pesoGap > 0 ? `faltam ${objetivosResumo.pesoGap}%` : `excesso de ${Math.abs(objetivosResumo.pesoGap)}%`})
                    </span>
                  )}
                  {objetivosResumo.todosAtingidos && <span className="func-day-stat positive">Todos os objetivos atingidos</span>}
                </div>

                <fieldset className="func-objetivos-fieldset" disabled={!canManageObjetivos || formLoading || bulkObjetivosLoading}>
                  {objetivosLista.length === 0 ? (
                    <p className="func-muted">Sem objetivos definidos para esta funcionaria.</p>
                  ) : (
                    <div className="func-objetivos-list">
                      <div className="func-objetivo-table-head">
                        <span>Objetivo</span>
                        <span>Data</span>
                        <span>Tipo</span>
                        <span>Meta</span>
                        <span>Atingido</span>
                        <span>Peso (%)</span>
                        <span>Erros</span>
                        <span>Cumprimento</span>
                        <span>Acoes</span>
                      </div>
                      {objetivosLista.map((item, index) => (
                        <div key={item.id} className="func-objetivo-line">
                          <div className="func-objetivo-title-wrap">
                            <span className="func-objetivo-index">{index + 1}</span>
                            <input
                              type="text"
                              value={item.titulo}
                              onChange={(e) => handleUpdateObjetivo(item.id, { titulo: e.target.value })}
                              placeholder="Ex: Fechar processamentos mensais sem pendencias"
                            />
                          </div>

                          <input type="date" value={item.deadline} onChange={(e) => handleUpdateObjetivo(item.id, { deadline: e.target.value })} />

                          <select
                            value={item.metaTipo}
                            onChange={(e) => handleUpdateObjetivo(item.id, { metaTipo: e.target.value === 'PERCENT' ? 'PERCENT' : 'QTD' })}
                          >
                            <option value="QTD">Qtd</option>
                            <option value="PERCENT">%</option>
                          </select>

                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={item.meta}
                            max={item.metaTipo === 'PERCENT' ? 100 : undefined}
                            onChange={(e) => {
                              const meta = item.metaTipo === 'PERCENT' ? clampWeight(e.target.value) : clampCount(e.target.value);
                              handleUpdateObjetivo(item.id, { meta });
                            }}
                          />

                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={item.atingido}
                            max={item.metaTipo === 'PERCENT' ? 100 : undefined}
                            onChange={(e) => {
                              const atingido = item.metaTipo === 'PERCENT' ? clampWeight(e.target.value) : clampCount(e.target.value);
                              handleUpdateObjetivo(item.id, { atingido });
                            }}
                          />

                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            value={item.peso}
                            onChange={(e) => {
                              const peso = clampWeight(e.target.value);
                              handleUpdateObjetivo(item.id, { peso });
                            }}
                          />

                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={item.erros}
                            onChange={(e) => {
                              const erros = clampCount(e.target.value);
                              handleUpdateObjetivo(item.id, { erros });
                            }}
                          />

                          <div className={`func-objetivo-kpi ${getObjetivoPercent(item) >= 80 ? 'ok' : getObjetivoPercent(item) >= 50 ? 'mid' : 'low'}`}>
                            {getObjetivoPercent(item)}%
                          </div>

                          <div className="func-objetivo-actions">
                            <button type="button" className="func-mini-btn danger" onClick={() => handleRemoveObjetivo(item.id)}>
                              Remover
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="func-form-field func-form-field-full">
                    <label>Notas gerais dos objetivos (resumo global da funcionaria)</label>
                    <textarea
                      className="func-form-textarea"
                      rows={3}
                      value={recompensaGlobal.notasGerais}
                      onChange={(e) => handleUpdateRecompensaGlobal({ notasGerais: e.target.value })}
                      placeholder="Notas finais sobre cumprimento global, bloqueios, justificacoes e contexto geral..."
                    />
                  </div>

                  <div className="func-recompensa-global-card">
                    <h4>Incentivos por patamares (globais)</h4>
                    <p className="func-muted">
                      Patamar atual: <strong>{incentivoResumo.patamarAtingido}</strong> | Incentivo: <strong>{incentivoResumo.incentivoLabel}</strong> | Premio proporcional:
                      <strong> {incentivoResumo.premioProporcional} EUR</strong>
                    </p>
                    <p className="func-muted">Regra de erros: 1 erro reduz 50% do objetivo; 2 ou mais erros anulam o objetivo (0%).</p>
                    <div className="func-objetivo-reward-grid">
                      <div className="func-form-field">
                        <label>Ao atingir 50%</label>
                        <input type="text" value={recompensaGlobal.patamar50} onChange={(e) => handleUpdateRecompensaGlobal({ patamar50: e.target.value })} />
                      </div>

                      <div className="func-form-field">
                        <label>Ao atingir 65%</label>
                        <input type="text" value={recompensaGlobal.patamar65} onChange={(e) => handleUpdateRecompensaGlobal({ patamar65: e.target.value })} />
                      </div>

                      <div className="func-form-field">
                        <label>Ao atingir 80%</label>
                        <input type="text" value={recompensaGlobal.patamar80} onChange={(e) => handleUpdateRecompensaGlobal({ patamar80: e.target.value })} />
                      </div>

                      <div className="func-form-field">
                        <label>Premio maximo (EUR)</label>
                        <input
                          type="number"
                          min={0}
                          step={50}
                          value={recompensaGlobal.premioMaximo}
                          onChange={(e) => handleUpdateRecompensaGlobal({ premioMaximo: Math.max(0, clampCount(e.target.value)) })}
                        />
                      </div>
                    </div>
                  </div>
                </fieldset>
              </div>
            )}
            {activeFormTab === 'picagens' && (
              <div className="func-tab-panel">
                {!editingId ? (
                  <p className="func-muted">Guarde o funcionario para gerir picagens.</p>
                ) : (
                  <>
                    <div className="func-tab-toolbar">
                      <div className="func-period-filters">
                        <div className="func-period-field">
                          <label>De</label>
                          <input type="date" value={picagensPeriodoInicio} onChange={(e) => setPicagensPeriodoInicio(e.target.value)} />
                        </div>
                        <div className="func-period-field">
                          <label>Ate</label>
                          <input type="date" value={picagensPeriodoFim} onChange={(e) => setPicagensPeriodoFim(e.target.value)} />
                        </div>
                        <button
                          className="func-mini-btn"
                          onClick={() => {
                            setPicagensPeriodoInicio('');
                            setPicagensPeriodoFim('');
                          }}
                          type="button"
                        >
                          Limpar
                        </button>
                      </div>
                      <button className="func-secondary-btn" onClick={handlePrintPicagensPdf} disabled={filteredGroupedPicagens.length === 0}>
                        Imprimir PDF
                      </button>
                      {canRetificar ? (
                        <span className="func-admin-chip">Retificacao ativa (mpr@mpr.pt)</span>
                      ) : (
                        <span className="func-muted">Retificacao apenas para mpr@mpr.pt</span>
                      )}
                    </div>

                    {formPicagensLoading ? (
                      <p className="func-muted">A carregar picagens...</p>
                    ) : formPicagensError ? (
                      <p className="func-error-text">{formPicagensError}</p>
                    ) : filteredGroupedPicagens.length === 0 ? (
                      <p className="func-muted">Sem picagens registadas para este funcionario.</p>
                    ) : (
                      <div className="func-day-list">
                        {filteredGroupedPicagens.map((day) => {
                          const metrics = dayMetricsByDate.get(day.dateIso) || calculateDayMetrics(day, expectedWorkMinutes);
                          return (
                            <div key={day.dateIso} className={`func-day-card ${metrics.incomplete ? 'anomaly' : ''}`}>
                              <div className="func-day-head">
                                <h4>{day.dateLabel}</h4>
                                <span>{day.all.length} registo(s)</span>
                              </div>

                              <div className="func-day-stats">
                                <span className="func-day-stat">Horas: {formatMinutesAsHours(metrics.workedMinutes)}</span>
                                <span className={`func-day-stat ${metrics.saldoMinutes === null ? '' : metrics.saldoMinutes >= 0 ? 'positive' : 'negative'}`}>
                                  Saldo: {metrics.saldoMinutes === null ? 'Sem horario definido' : formatSignedMinutes(metrics.saldoMinutes)}
                                </span>
                                {metrics.incomplete && (
                                  <span className="func-day-alert">Alerta: picagens incompletas ({metrics.openPairCount})</span>
                                )}
                              </div>

                              <div className="func-day-slots">
                                {(Object.keys(SLOT_META) as PunchSlotKey[]).map((slotKey) => {
                                  const slot = day.slots[slotKey];
                                  const slotMeta = SLOT_META[slotKey];
                                  return (
                                    <div key={`${day.dateIso}-${slotKey}`} className="func-day-slot">
                                      <label>{slotMeta.label}</label>
                                      {slot ? (
                                        <>
                                          <input
                                            type="time"
                                            value={slotTimeDrafts[String(slot.id)] || formatTimeInput(slot.momento)}
                                            onChange={(e) =>
                                              setSlotTimeDrafts((prev) => ({
                                                ...prev,
                                                [String(slot.id)]: e.target.value,
                                              }))
                                            }
                                            disabled={!canRetificar}
                                          />
                                          <div className="func-day-slot-actions">
                                            {canRetificar && (
                                              <>
                                                <button className="func-mini-btn" onClick={() => void handleSaveSlotTime(slot)}>
                                                  Guardar
                                                </button>
                                                <button className="func-mini-btn danger" onClick={() => void handleDeleteSlot(slot)}>
                                                  Apagar
                                                </button>
                                              </>
                                            )}
                                          </div>
                                        </>
                                      ) : canRetificar ? (
                                        <button className="func-mini-btn" onClick={() => void handleAddSlot(day.dateIso, slotKey)}>
                                          Adicionar
                                        </button>
                                      ) : (
                                        <div className="func-slot-empty">-</div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>

                              {day.extras.length > 0 && (
                                <div className="func-day-extras">
                                  <h5>Registos extra</h5>
                                  <table className="func-registos-table">
                                    <thead>
                                      <tr>
                                        <th>Hora</th>
                                        <th>Tipo</th>
                                        <th>Origem</th>
                                        {canRetificar && <th>Acoes</th>}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {day.extras.map((item) => (
                                        <tr key={item.id}>
                                          <td>{new Date(item.momento).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}</td>
                                          <td>{String(item.tipo).toUpperCase()}</td>
                                          <td>{item.origem || '-'}</td>
                                          {canRetificar && (
                                            <td>
                                              <button className="func-mini-btn danger" onClick={() => void handleDeleteSlot(item)}>
                                                Apagar
                                              </button>
                                            </td>
                                          )}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {activeFormTab === 'ferias' && (
              <div className="func-tab-panel">
                {editingId && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                    <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Ano</span>
                    <button
                      type="button"
                      className="func-mini-btn"
                      onClick={() => setFormFeriasYear((prev) => Math.max(2000, prev - 1))}
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={2000}
                      max={2200}
                      value={formFeriasYear}
                      onChange={(e) => {
                        const parsed = Number(e.target.value);
                        if (!Number.isFinite(parsed)) return;
                        const bounded = Math.max(2000, Math.min(2200, Math.round(parsed)));
                        setFormFeriasYear(bounded);
                      }}
                      style={{ width: '90px' }}
                    />
                    <button
                      type="button"
                      className="func-mini-btn"
                      onClick={() => setFormFeriasYear((prev) => Math.min(2200, prev + 1))}
                    >
                      +
                    </button>
                  </div>
                )}
                {!editingId ? (
                  <p className="func-muted">Guarde o funcionario para ver o resumo de ferias.</p>
                ) : formFeriasLoading ? (
                  <p className="func-muted">A carregar resumo de ferias...</p>
                ) : formFeriasError ? (
                  <p className="func-error-text">{formFeriasError}</p>
                ) : !formFeriasResumo ? (
                  <p className="func-muted">Sem dados de ferias para mostrar.</p>
                ) : (
                  <>
                    <div className="func-ferias-grid">
                      <div className="func-ferias-item">
                        <span>Direito anual</span>
                        <strong>{formFeriasResumo.diasDireito.toFixed(1)}</strong>
                      </div>
                      <div className="func-ferias-item">
                        <span>Dias extra</span>
                        <strong>{formFeriasResumo.diasExtra.toFixed(1)}</strong>
                      </div>
                      <div className="func-ferias-item">
                        <span>Dias aprovados ({formFeriasResumo.ano})</span>
                        <strong>{formFeriasResumo.diasAprovados.toFixed(1)}</strong>
                      </div>
                      <div className="func-ferias-item">
                        <span>Dias por gozar</span>
                        <strong className={formFeriasResumo.diasRestantes < 0 ? 'danger' : ''}>{formFeriasResumo.diasRestantes.toFixed(1)}</strong>
                      </div>
                    </div>

                    <div className="func-ferias-meta">
                      <span>Usados manualmente: {formFeriasResumo.diasUsadosManual.toFixed(1)}</span>
                      <span>Total usado: {formFeriasResumo.diasUsadosTotal.toFixed(1)}</span>
                    </div>

                    <h4 className="func-subtitle">Periodos marcados</h4>
                    {formFeriasResumo.periodos.length === 0 ? (
                      <p className="func-muted">Nao existem periodos de ferias aprovados para este ano.</p>
                    ) : (
                      <div className="func-registos-table-wrapper">
                        <table className="func-registos-table">
                          <thead>
                            <tr>
                              <th>Inicio</th>
                              <th>Fim</th>
                              <th>Origem</th>
                              <th>Dias uteis</th>
                            </tr>
                          </thead>
                          <tbody>
                            {formFeriasResumo.periodos.map((periodo) => (
                              <tr key={`${periodo.origem}-${periodo.inicio}-${periodo.fim}`}>
                                <td>{new Date(`${periodo.inicio}T00:00:00`).toLocaleDateString('pt-PT')}</td>
                                <td>{new Date(`${periodo.fim}T00:00:00`).toLocaleDateString('pt-PT')}</td>
                                <td>{periodo.origem}</td>
                                <td>{periodo.diasUteis}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {activeFormTab === 'pedidos' && (
              <div className="func-tab-panel">
                {editingId && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                    <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Ano</span>
                    <button
                      type="button"
                      className="func-mini-btn"
                      onClick={() => setFormPedidosYear((prev) => Math.max(2000, prev - 1))}
                    >
                      -
                    </button>
                    <input
                      type="number"
                      min={2000}
                      max={2200}
                      value={formPedidosYear}
                      onChange={(e) => {
                        const parsed = Number(e.target.value);
                        if (!Number.isFinite(parsed)) return;
                        const bounded = Math.max(2000, Math.min(2200, Math.round(parsed)));
                        setFormPedidosYear(bounded);
                      }}
                      style={{ width: '90px' }}
                    />
                    <button
                      type="button"
                      className="func-mini-btn"
                      onClick={() => setFormPedidosYear((prev) => Math.min(2200, prev + 1))}
                    >
                      +
                    </button>
                  </div>
                )}

                {!editingId ? (
                  <p className="func-muted">Guarde o funcionario para ver os pedidos.</p>
                ) : formPedidosLoading ? (
                  <p className="func-muted">A carregar pedidos...</p>
                ) : formPedidosError ? (
                  <p className="func-error-text">{formPedidosError}</p>
                ) : (
                  <>
                    <div className="func-ferias-grid">
                      <div className="func-ferias-item">
                        <span>Total de pedidos</span>
                        <strong>{formPedidos.length}</strong>
                      </div>
                      <div className="func-ferias-item">
                        <span>Aprovados</span>
                        <strong>{formPedidos.filter((p) => p.status === 'APROVADO').length}</strong>
                      </div>
                      <div className="func-ferias-item">
                        <span>Pendentes</span>
                        <strong>{formPedidos.filter((p) => p.status === 'PENDENTE').length}</strong>
                      </div>
                      <div className="func-ferias-item">
                        <span>Rejeitados</span>
                        <strong className={formPedidos.some((p) => p.status === 'REJEITADO') ? 'danger' : ''}>
                          {formPedidos.filter((p) => p.status === 'REJEITADO').length}
                        </strong>
                      </div>
                    </div>

                    {formPedidos.length === 0 ? (
                      <p className="func-muted">Nao existem pedidos neste ano.</p>
                    ) : (
                      <div className="func-registos-table-wrapper">
                        <table className="func-registos-table">
                          <thead>
                            <tr>
                              <th>Registo</th>
                              <th>Tipo</th>
                              <th>Periodo</th>
                              <th>Estado</th>
                              <th>Descricao</th>
                              <th>Decisao</th>
                            </tr>
                          </thead>
                          <tbody>
                            {formPedidos.map((pedido) => (
                              <tr key={pedido.id}>
                                <td>{new Date(pedido.created_at).toLocaleDateString('pt-PT')}</td>
                                <td>{pedido.tipo || '-'}</td>
                                <td>
                                  {pedido.data_inicio
                                    ? `${new Date(`${pedido.data_inicio}T00:00:00`).toLocaleDateString('pt-PT')} -> ${new Date(`${(pedido.data_fim || pedido.data_inicio)}T00:00:00`).toLocaleDateString('pt-PT')}`
                                    : '-'}
                                </td>
                                <td>{pedido.status}</td>
                                <td>{pedido.descricao || '-'}</td>
                                <td>{pedido.resolucao || '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="func-modal-footer">
              <div>{formError && <p className="func-error-text">{formError}</p>}</div>
              <div className="func-form-buttons">
                <button
                  className="func-secondary-btn"
                  onClick={() => {
                    if (!formLoading) {
                      setShowForm(false);
                      resetForm();
                    }
                  }}
                >
                  Cancelar
                </button>
                <button className="func-save-btn" onClick={handleSaveFuncionario} disabled={formLoading}>
                  {formLoading ? 'A guardar...' : editingId ? 'Guardar alteracoes' : 'Guardar'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog />
    </div>
  );
};

export default FuncionariosPage;
