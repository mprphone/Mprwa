import React, { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, Download, Edit2, RefreshCw, Search, X } from 'lucide-react';
import {
  createHrEmpresaPeriodo,
  createHrHoliday,
  deleteHrEmpresaPeriodo,
  deleteHrHoliday,
  fetchHrEmpresaPeriodos,
  fetchHrFeriasSaldos,
  fetchHrFuncionarios,
  fetchHrHolidays,
  fetchHrPedidos,
  fetchHrSummary,
  HrEmpresaPeriodo,
  HrFeriasSaldo,
  HrFuncionario,
  HrHoliday,
  HrPedido,
  HrPedidoStatus,
  syncHrFromSupabase,
  updateHrFeriasSaldo,
  updateHrPedido,
} from '../services/hrApi';
import { mockService } from '../services/mockData';

type ViewMode = 'lista' | 'calendario';

const STATUS_STYLES: Record<HrPedidoStatus, string> = {
  PENDENTE: 'bg-amber-100 text-amber-800 border-amber-200',
  APROVADO: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  REJEITADO: 'bg-rose-100 text-rose-800 border-rose-200',
};

const CARD_STYLES: Record<HrPedidoStatus, { card: string; tape: string; accent: string; note: string }> = {
  PENDENTE: {
    card: 'border-amber-200 bg-[#fff7d6]',
    tape: 'bg-amber-200/70',
    accent: 'bg-amber-500',
    note: 'border-amber-200 bg-white/60 text-amber-950',
  },
  APROVADO: {
    card: 'border-emerald-200 bg-[#edfdf3]',
    tape: 'bg-emerald-200/70',
    accent: 'bg-emerald-500',
    note: 'border-emerald-200 bg-white/65 text-emerald-950',
  },
  REJEITADO: {
    card: 'border-rose-200 bg-[#fff1f2]',
    tape: 'bg-rose-200/75',
    accent: 'bg-rose-500',
    note: 'border-rose-200 bg-white/65 text-rose-950',
  },
};

const FUNCIONARIO_PALETTE = [
  { card: 'bg-[#fff7d6] border-[#f2cf72]', tape: 'bg-[#f5d46f]/75', accent: 'bg-[#d89b00]' },
  { card: 'bg-[#e9fbf1] border-[#8fd9b0]', tape: 'bg-[#9be6bc]/75', accent: 'bg-[#059669]' },
  { card: 'bg-[#eaf4ff] border-[#9fc9f3]', tape: 'bg-[#a7d4ff]/75', accent: 'bg-[#2563eb]' },
  { card: 'bg-[#fff0f6] border-[#f4a5c8]', tape: 'bg-[#f8b6d1]/75', accent: 'bg-[#db2777]' },
  { card: 'bg-[#f5f0ff] border-[#c4b5fd]', tape: 'bg-[#d2c5ff]/75', accent: 'bg-[#7c3aed]' },
  { card: 'bg-[#ecfeff] border-[#8bdde4]', tape: 'bg-[#9debf0]/75', accent: 'bg-[#0891b2]' },
  { card: 'bg-[#fff4e6] border-[#f5bd7a]', tape: 'bg-[#ffc985]/75', accent: 'bg-[#ea580c]' },
  { card: 'bg-[#f1f5f9] border-[#cbd5e1]', tape: 'bg-[#d8e0ea]/75', accent: 'bg-[#475569]' },
];

function hashText(value?: string) {
  return String(value || '').split('').reduce((acc, char) => ((acc * 31) + char.charCodeAt(0)) >>> 0, 7);
}

function funcionarioStyle(pedido: HrPedido) {
  return FUNCIONARIO_PALETTE[hashText(pedido.funcionarioId || pedido.funcionarioNome || pedido.id) % FUNCIONARIO_PALETTE.length];
}

function todayYear() {
  return new Date().getFullYear();
}

function isoDate(value?: string) {
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function formatDate(value?: string) {
  const raw = isoDate(value);
  if (!raw) return '-';
  const [year, month, day] = raw.split('-');
  return `${day}/${month}/${year}`;
}

function formatDateList(days: string[]) {
  return days.map(formatDate).join(', ');
}

function eachDate(start: string, end: string) {
  const out: string[] = [];
  const first = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end || start}T00:00:00Z`);
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime())) return out;
  for (let cursor = first; cursor <= last; cursor = new Date(cursor.getTime() + 86400000)) {
    out.push(cursor.toISOString().slice(0, 10));
  }
  return out;
}

function businessDays(start?: string, end?: string, holidays = new Set<string>()) {
  return eachDate(isoDate(start), isoDate(end || start)).filter((day) => {
    const weekDay = new Date(`${day}T00:00:00Z`).getUTCDay();
    return weekDay !== 0 && weekDay !== 6 && !holidays.has(day);
  }).length;
}

function businessDateList(start?: string, end?: string, holidays = new Set<string>()) {
  return eachDate(isoDate(start), isoDate(end || start)).filter((day) => {
    const weekDay = new Date(`${day}T00:00:00Z`).getUTCDay();
    return weekDay !== 0 && weekDay !== 6 && !holidays.has(day);
  });
}

function isVacation(tipo?: string) {
  const normalized = String(tipo || '').toUpperCase();
  return normalized.includes('FERIA') || normalized.includes('FÉRIA');
}

function isFolga(tipo?: string) {
  return String(tipo || '').toUpperCase().includes('FOLGA');
}

function monthGrid(year: number, monthIndex: number) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const startOffset = first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cells: Array<string | null> = [];
  for (let i = 0; i < startOffset; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(`${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

const Pedidos: React.FC = () => {
  const currentUser = mockService.getCurrentUser();
  const currentUserId = String(mockService.getCurrentUserId() || '').trim();
  const canManagePedidos = String(currentUser?.email || '').trim().toLowerCase() === 'mpr@mpr.pt';
  const [viewMode, setViewMode] = useState<ViewMode>('lista');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<any>(null);
  const [funcionarios, setFuncionarios] = useState<HrFuncionario[]>([]);
  const [pedidos, setPedidos] = useState<HrPedido[]>([]);
  const [holidays, setHolidays] = useState<HrHoliday[]>([]);
  const [saldos, setSaldos] = useState<HrFeriasSaldo[]>([]);
  const [periodosEmpresa, setPeriodosEmpresa] = useState<HrEmpresaPeriodo[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [funcionarioFilter, setFuncionarioFilter] = useState('');
  const [year, setYear] = useState(todayYear());
  const [month, setMonth] = useState(new Date().getMonth());
  const [resolutionDrafts, setResolutionDrafts] = useState<Record<string, string>>({});
  const [editingPedido, setEditingPedido] = useState<HrPedido | null>(null);
  const [editDraft, setEditDraft] = useState<{
    tipo: string;
    descricao: string;
    dataInicio: string;
    dataFim: string;
    status: HrPedidoStatus;
    resolucao: string;
  } | null>(null);
  const [newHoliday, setNewHoliday] = useState({ date: '', name: '' });
  const [companyPeriodDraft, setCompanyPeriodDraft] = useState({
    titulo: 'Férias da Empresa',
    descricao: '',
    dataInicio: '',
    dataFim: '',
  });
  const [showCompanyForm, setShowCompanyForm] = useState(false);
  const [savingPedidoId, setSavingPedidoId] = useState('');
  const holidaySet = useMemo(() => new Set(holidays.map((item) => item.date)), [holidays]);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [summaryData, funcs, pedidosData, holidayData, saldoData, periodosData] = await Promise.all([
        fetchHrSummary(currentUserId),
        fetchHrFuncionarios(currentUserId),
        fetchHrPedidos({ status: statusFilter, funcionarioId: funcionarioFilter, year, viewerUserId: currentUserId }),
        fetchHrHolidays(),
        fetchHrFeriasSaldos(year),
        fetchHrEmpresaPeriodos(),
      ]);
      setSummary(summaryData);
      setFuncionarios(funcs);
      setPedidos(pedidosData);
      setHolidays(holidayData);
      setSaldos(saldoData);
      setPeriodosEmpresa(periodosData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar pedidos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [statusFilter, funcionarioFilter, year]);

  const pedidosAprovados = useMemo(() => pedidos.filter((p) => p.status === 'APROVADO'), [pedidos]);

  const saldoRows = useMemo(() => {
    return funcionarios.map((funcionario) => {
      const saldo = saldos.find((item) => item.funcionarioId === funcionario.id);
      const feriasAprovadas = pedidosAprovados
        .filter((pedido) => pedido.funcionarioId === funcionario.id && isVacation(pedido.tipo))
        .reduce((sum, pedido) => sum + businessDays(pedido.dataInicio, pedido.dataFim, holidaySet), 0);
      const folgasAprovadas = pedidosAprovados
        .filter((pedido) => pedido.funcionarioId === funcionario.id && isFolga(pedido.tipo))
        .reduce((sum, pedido) => sum + businessDays(pedido.dataInicio, pedido.dataFim, holidaySet), 0);
      const feriasEmpresa = periodosEmpresa
        .filter((periodo) => !periodo.funcionariosAlvo || periodo.funcionariosAlvo.includes(funcionario.id))
        .reduce((sum, periodo) => sum + businessDays(periodo.dataInicio, periodo.dataFim, holidaySet), 0);
      const direito = Number(saldo?.diasDireito ?? 22);
      const extra = Number(saldo?.diasExtra ?? 0);
      const manual = Number(saldo?.diasUsadosManual ?? 0);
      const usado = feriasAprovadas + feriasEmpresa + manual;
      return {
        funcionario,
        saldo,
        direito,
        extra,
        manual,
        feriasAprovadas: feriasAprovadas + feriasEmpresa,
        folgasAprovadas,
        restante: direito + extra - usado,
      };
    });
  }, [funcionarios, saldos, pedidosAprovados, holidaySet, periodosEmpresa]);

  const calendarEvents = useMemo(() => {
    const map = new Map<string, Array<{ label: string; color: string }>>();
    const push = (date: string, label: string, color: string) => {
      if (!map.has(date)) map.set(date, []);
      map.get(date)?.push({ label, color });
    };
    for (const pedido of pedidosAprovados) {
      if (!isVacation(pedido.tipo) && !isFolga(pedido.tipo)) continue;
      eachDate(isoDate(pedido.dataInicio), isoDate(pedido.dataFim || pedido.dataInicio)).forEach((day) => {
        push(day, pedido.funcionarioNome || 'Funcionário', isVacation(pedido.tipo) ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800');
      });
    }
    for (const holiday of holidays) push(holiday.date, holiday.name, 'bg-rose-100 text-rose-800');
    for (const periodo of periodosEmpresa) {
      eachDate(periodo.dataInicio, periodo.dataFim).forEach((day) => push(day, periodo.titulo, 'bg-sky-100 text-sky-800'));
    }
    return map;
  }, [pedidosAprovados, holidays, periodosEmpresa]);

  const pedidosPorFuncionario = useMemo(() => {
    return funcionarios.map((funcionario) => {
      const rows = pedidos.filter((pedido) => pedido.funcionarioId === funcionario.id);
      return {
        funcionario,
        total: rows.length,
        pendentes: rows.filter((pedido) => pedido.status === 'PENDENTE').length,
        aprovados: rows.filter((pedido) => pedido.status === 'APROVADO').length,
        rejeitados: rows.filter((pedido) => pedido.status === 'REJEITADO').length,
        ultimos: rows.slice(0, 3),
      };
    }).filter((row) => row.total > 0);
  }, [funcionarios, pedidos]);

  const pedidosOrdenados = useMemo(() => {
    const statusRank: Record<HrPedidoStatus, number> = { PENDENTE: 0, APROVADO: 1, REJEITADO: 2 };
    return [...pedidos].sort((left, right) => {
      const rankDiff = statusRank[left.status] - statusRank[right.status];
      if (rankDiff !== 0) return rankDiff;
      const leftDate = isoDate(left.dataInicio) || String(left.createdAt || '').slice(0, 10);
      const rightDate = isoDate(right.dataInicio) || String(right.createdAt || '').slice(0, 10);
      return rightDate.localeCompare(leftDate);
    });
  }, [pedidos]);

  const handleSync = async () => {
    setSyncing(true);
    setError('');
    try {
      await syncHrFromSupabase();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao sincronizar.');
    } finally {
      setSyncing(false);
    }
  };

  const decidePedido = async (pedido: HrPedido, status: HrPedidoStatus) => {
    setSavingPedidoId(pedido.id);
    setError('');
    try {
      const updated = await updateHrPedido(pedido.id, {
        status,
        resolucao: resolutionDrafts[pedido.id] ?? pedido.resolucao ?? '',
        actorUserId: currentUserId,
      });
      setPedidos((current) => current.map((item) => (item.id === pedido.id ? updated : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao atualizar pedido.');
    } finally {
      setSavingPedidoId('');
    }
  };

  const openEditPedido = (pedido: HrPedido) => {
    setEditingPedido(pedido);
    setEditDraft({
      tipo: pedido.tipo || '',
      descricao: pedido.descricao || '',
      dataInicio: isoDate(pedido.dataInicio),
      dataFim: isoDate(pedido.dataFim || pedido.dataInicio),
      status: pedido.status,
      resolucao: pedido.resolucao || '',
    });
  };

  const saveEditPedido = async () => {
    if (!editingPedido || !editDraft) return;
    setSavingPedidoId(editingPedido.id);
    setError('');
    try {
      const updated = await updateHrPedido(editingPedido.id, { ...editDraft, actorUserId: currentUserId });
      setPedidos((current) => current.map((item) => (item.id === editingPedido.id ? updated : item)));
      setEditingPedido(null);
      setEditDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao editar pedido.');
    } finally {
      setSavingPedidoId('');
    }
  };

  const addHoliday = async () => {
    if (!newHoliday.date || !newHoliday.name.trim()) return;
    await createHrHoliday({ date: newHoliday.date, name: newHoliday.name.trim(), region: 'PT' });
    setNewHoliday({ date: '', name: '' });
    setHolidays(await fetchHrHolidays());
  };

  const addCompanyPeriod = async () => {
    if (!companyPeriodDraft.dataInicio || !companyPeriodDraft.dataFim) {
      setError('Preencha as datas das férias da empresa.');
      return;
    }
    if (companyPeriodDraft.dataFim < companyPeriodDraft.dataInicio) {
      setError('A data fim não pode ser anterior à data início.');
      return;
    }
    setError('');
    try {
      const created = await createHrEmpresaPeriodo({
        titulo: companyPeriodDraft.titulo.trim() || 'Férias da Empresa',
        descricao: companyPeriodDraft.descricao.trim(),
        dataInicio: companyPeriodDraft.dataInicio,
        dataFim: companyPeriodDraft.dataFim,
        funcionariosAlvo: null,
      });
      setPeriodosEmpresa((current) => [...current, created].sort((a, b) => a.dataInicio.localeCompare(b.dataInicio)));
      setCompanyPeriodDraft({ titulo: 'Férias da Empresa', descricao: '', dataInicio: '', dataFim: '' });
      setShowCompanyForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar férias da empresa.');
    }
  };

  const saveSaldo = async (row: typeof saldoRows[number]) => {
    const updated = await updateHrFeriasSaldo(row.funcionario.id, year, row.saldo || {
      funcionarioId: row.funcionario.id,
      ano: year,
      diasDireito: row.direito,
      diasExtra: row.extra,
      diasUsadosManual: row.manual,
    });
    setSaldos((current) => {
      const exists = current.some((item) => item.funcionarioId === updated.funcionarioId && item.ano === updated.ano);
      return exists ? current.map((item) => (item.funcionarioId === updated.funcionarioId && item.ano === updated.ano ? updated : item)) : [...current, updated];
    });
  };

  const printVacationMap = () => {
    const rows = saldoRows.map((row) => {
      const employeePedidos = pedidosAprovados.filter((pedido) => pedido.funcionarioId === row.funcionario.id && isVacation(pedido.tipo));
      const employeeCompanyPeriods = periodosEmpresa.filter((periodo) => !periodo.funcionariosAlvo || periodo.funcionariosAlvo.includes(row.funcionario.id));
      const periods = [
        ...employeePedidos.map((pedido) => ({
          start: isoDate(pedido.dataInicio),
          end: isoDate(pedido.dataFim || pedido.dataInicio),
        })),
        ...employeeCompanyPeriods.map((periodo) => ({
          start: isoDate(periodo.dataInicio),
          end: isoDate(periodo.dataFim),
        })),
      ].filter((periodo) => periodo.start && periodo.end);
      const exactDays = Array.from(new Set(periods.flatMap((periodo) => businessDateList(periodo.start, periodo.end, holidaySet)))).sort();
      return {
        nome: row.funcionario.nome,
        periodos: periods.map((periodo) => `${formatDate(periodo.start)} a ${formatDate(periodo.end)}`).join(' | ') || '-',
        diasExatos: exactDays.length ? formatDateList(exactDays) : '-',
        direito: row.direito + row.extra,
        gozados: row.feriasAprovadas + row.manual,
        restante: row.restante,
      };
    });

    const totals = rows.reduce(
      (acc, row) => ({
        direito: acc.direito + row.direito,
        gozados: acc.gozados + row.gozados,
        restante: acc.restante + row.restante,
      }),
      { direito: 0, gozados: 0, restante: 0 },
    );

    const html = `<!doctype html>
      <html lang="pt">
        <head>
          <meta charset="utf-8" />
          <title>Mapa de Férias Anual - ${year}</title>
          <style>
            @page { size: A4 landscape; margin: 14mm; }
            * { box-sizing: border-box; }
            body { font-family: Arial, sans-serif; color: #0f172a; margin: 0; font-size: 12px; }
            h1 { margin: 0 0 8px; font-size: 22px; }
            p { margin: 0 0 18px; color: #334155; font-size: 13px; }
            table { width: 100%; border-collapse: collapse; }
            th { text-align: left; font-size: 12px; padding: 9px 8px; border-bottom: 1px solid #cbd5e1; }
            td { vertical-align: top; padding: 9px 8px; border-bottom: 1px solid #e2e8f0; line-height: 1.45; }
            td:first-child { font-weight: 700; width: 17%; }
            th:nth-child(2), td:nth-child(2) { width: 18%; }
            th:nth-child(3), td:nth-child(3) { width: 31%; }
            th:nth-child(4), th:nth-child(5), th:nth-child(6),
            td:nth-child(4), td:nth-child(5), td:nth-child(6) { width: 11%; text-align: center; font-weight: 700; }
            tfoot td { border-top: 2px solid #cbd5e1; border-bottom: 0; font-weight: 800; }
          </style>
        </head>
        <body>
          <h1>Mapa de Férias Anual - ${year}</h1>
          <p>Resumo por funcionário para afixação interna, com os dias exatos de gozo aprovados. Emitido em ${new Date().toLocaleDateString('pt-PT')}.</p>
          <table>
            <thead>
              <tr>
                <th>Nome do Funcionário</th>
                <th>Períodos de Férias (Datas Exatas)</th>
                <th>Dias Exatos de Gozo</th>
                <th>Dias de Férias (Direito)</th>
                <th>Dias Gozados</th>
                <th>Dias por Gozar</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((row) => `
                <tr>
                  <td>${row.nome}</td>
                  <td>${row.periodos}</td>
                  <td>${row.diasExatos}</td>
                  <td>${row.direito.toFixed(1)}</td>
                  <td>${row.gozados.toFixed(1)}</td>
                  <td>${row.restante.toFixed(1)}</td>
                </tr>
              `).join('')}
            </tbody>
            <tfoot>
              <tr>
                <td>TOTAL</td>
                <td>-</td>
                <td>-</td>
                <td>${totals.direito.toFixed(1)}</td>
                <td>${totals.gozados.toFixed(1)}</td>
                <td>${totals.restante.toFixed(1)}</td>
              </tr>
            </tfoot>
          </table>
          <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 250); };</script>
        </body>
      </html>`;

    const existingFrame = document.getElementById('vacation-map-print-frame');
    existingFrame?.remove();

    const iframe = document.createElement('iframe');
    iframe.id = 'vacation-map-print-frame';
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.visibility = 'hidden';
    document.body.appendChild(iframe);

    const frameDoc = iframe.contentWindow?.document;
    if (!frameDoc) {
      setError('Não foi possível preparar a impressão.');
      iframe.remove();
      return;
    }

    frameDoc.open();
    frameDoc.write(html.replace('<script>window.onload = () => { window.print(); setTimeout(() => window.close(), 250); };</script>', ''));
    frameDoc.close();

    window.setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      window.setTimeout(() => iframe.remove(), 1000);
    }, 250);
  };

  return (
    <div className="w-full space-y-4 p-4 md:p-6">
      <section className="rounded-xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 text-white shadow-sm md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold md:text-2xl">Pedidos</h1>
            <p className="text-xs text-slate-200 md:text-sm">Férias, folgas, aprovações e mapa anual da equipa.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={printVacationMap} className="inline-flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-100">
              <Download size={16} />
              Imprimir mapa
            </button>
            <button onClick={() => setViewMode('lista')} className={`rounded-md px-3 py-2 text-sm font-semibold ${viewMode === 'lista' ? 'bg-white text-slate-900' : 'bg-white/10 text-white hover:bg-white/20'}`}>Lista</button>
            <button onClick={() => setViewMode('calendario')} className={`rounded-md px-3 py-2 text-sm font-semibold ${viewMode === 'calendario' ? 'bg-white text-slate-900' : 'bg-white/10 text-white hover:bg-white/20'}`}>Calendário</button>
            {canManagePedidos && (
              <button onClick={handleSync} disabled={syncing} className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
                <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
                Sincronizar
              </button>
            )}
          </div>
        </div>
      </section>

      {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      <section className="grid gap-3 md:grid-cols-4">
        <Metric label="Funcionários" value={summary?.funcionarios ?? funcionarios.length} />
        <Metric label="Pendentes" value={summary?.pedidos?.PENDENTE ?? pedidos.filter((p) => p.status === 'PENDENTE').length} tone="amber" />
        <Metric label="Aprovados" value={summary?.pedidos?.APROVADO ?? pedidos.filter((p) => p.status === 'APROVADO').length} tone="emerald" />
        <Metric label="Ponto" value={summary?.registosPonto ?? 0} />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <select value={funcionarioFilter} onChange={(e) => setFuncionarioFilter(e.target.value)} className="h-10 w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 text-sm">
              <option value="">Todos os funcionários</option>
              {funcionarios.map((funcionario) => <option key={funcionario.id} value={funcionario.id}>{funcionario.nome}</option>)}
            </select>
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm">
            <option value="">Todos os estados</option>
            <option value="PENDENTE">Pendentes</option>
            <option value="APROVADO">Aprovados</option>
            <option value="REJEITADO">Rejeitados</option>
          </select>
          <input type="number" value={year} onChange={(e) => setYear(Number(e.target.value || todayYear()))} className="h-10 w-28 rounded-md border border-slate-300 px-3 text-sm" />
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-900">Pedidos por funcionário</h2>
            <p className="text-xs text-slate-500">Clique num nome para filtrar a lista e ver os pedidos dessa pessoa.</p>
          </div>
          {funcionarioFilter && (
            <button onClick={() => setFuncionarioFilter('')} className="rounded-sm border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              Limpar filtro
            </button>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-1.5 md:grid-cols-4 xl:grid-cols-7">
          {pedidosPorFuncionario.map((row) => {
            const style = funcionarioStyle({ id: row.funcionario.id, funcionarioId: row.funcionario.id, funcionarioNome: row.funcionario.nome, tipo: '', status: 'PENDENTE' });
            return (
              <button
                key={row.funcionario.id}
                onClick={() => setFuncionarioFilter(row.funcionario.id)}
                className={`min-h-[82px] rounded-sm border p-2 text-left shadow-sm transition hover:-translate-y-0.5 ${style.card} ${funcionarioFilter === row.funcionario.id ? 'ring-2 ring-slate-900/20' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.accent}`} />
                  <span className="truncate text-xs font-black text-slate-900">{row.funcionario.nome}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] font-bold">
                  <span className="rounded bg-white/70 px-1 py-0.5">{row.total}</span>
                  <span className="rounded bg-emerald-100 px-1 py-0.5 text-emerald-800">{row.aprovados} ap.</span>
                  <span className="rounded bg-amber-100 px-1 py-0.5 text-amber-800">{row.pendentes} p.</span>
                  <span className="rounded bg-rose-100 px-1 py-0.5 text-rose-800">{row.rejeitados} r.</span>
                </div>
                <div className="mt-1.5 space-y-0.5">
                  {row.ultimos.slice(0, 2).map((pedido) => (
                    <p key={pedido.id} className="truncate text-[11px] text-slate-600">
                      {formatDate(pedido.dataInicio)} · {pedido.tipo.replace(/_/g, ' ')}
                    </p>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">A carregar...</div>
      ) : viewMode === 'lista' ? (
        <div className="grid gap-3 md:grid-cols-3 2xl:grid-cols-4">
          {pedidosOrdenados.map((pedido) => {
            const statusStyle = CARD_STYLES[pedido.status];
            const style = funcionarioStyle(pedido);
            const isPending = pedido.status === 'PENDENTE';
            const days = businessDays(pedido.dataInicio, pedido.dataFim, holidaySet);
            return (
              <article
                key={pedido.id}
                className={`relative min-h-[245px] overflow-hidden rounded-sm border p-3 shadow-[0_8px_18px_rgba(15,23,42,0.08)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_24px_rgba(15,23,42,0.12)] ${isPending ? 'border-amber-400 bg-[#fff3b0] ring-2 ring-amber-300/70' : style.card}`}
              >
                <div className={`absolute left-1/2 top-0 h-5 w-20 -translate-x-1/2 -translate-y-2 rotate-1 ${isPending ? 'bg-amber-300/90' : style.tape}`} />
                <div className={`absolute bottom-0 left-0 top-0 w-1.5 ${isPending ? 'bg-amber-600' : style.accent}`} />
                <div className="pl-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate text-sm font-black text-slate-950">{pedido.funcionarioNome || 'Desconhecido'}</h2>
                      <p className="mt-0.5 text-[11px] font-medium text-slate-500">{formatDate(pedido.createdAt?.slice(0, 10))}</p>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_STYLES[pedido.status]}`}>{pedido.status}</span>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <p className="truncate text-xs font-black uppercase tracking-normal text-slate-950">{pedido.tipo.replace(/_/g, ' ')}</p>
                    <span className="shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-bold text-slate-600">{days} dia{days === 1 ? '' : 's'}</span>
                  </div>

                  <p className="mt-2 line-clamp-3 min-h-[54px] text-xs leading-5 text-slate-800">{pedido.descricao || 'Sem descrição'}</p>

                  <div className="mt-3 rounded-sm bg-white/70 px-2.5 py-1.5 text-xs text-slate-900 shadow-inner">
                    <span className="font-bold">{formatDate(pedido.dataInicio)}</span>
                    <span className="mx-2 text-slate-400">a</span>
                    <span className="font-bold">{formatDate(pedido.dataFim)}</span>
                  </div>

                  {isPending && canManagePedidos ? (
                    <>
                      <textarea
                        value={resolutionDrafts[pedido.id] ?? pedido.resolucao ?? ''}
                        onChange={(e) => setResolutionDrafts((current) => ({ ...current, [pedido.id]: e.target.value }))}
                        placeholder="Observação de decisão"
                        className="mt-2 h-16 w-full resize-none rounded-sm border border-amber-200 bg-white/80 p-2 text-xs outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                      />
                      <div className="mt-2 flex justify-end gap-1.5">
                        <button onClick={() => openEditPedido(pedido)} className="inline-flex items-center gap-1 rounded-sm border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                          <Edit2 size={13} /> Editar
                        </button>
                        <button onClick={() => decidePedido(pedido, 'REJEITADO')} disabled={savingPedidoId === pedido.id} className="inline-flex items-center gap-1 rounded-sm border border-rose-200 bg-white px-2 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-60">
                          <X size={15} /> Rejeitar
                        </button>
                        <button onClick={() => decidePedido(pedido, 'APROVADO')} disabled={savingPedidoId === pedido.id} className="inline-flex items-center gap-1 rounded-sm bg-emerald-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
                          <Check size={15} /> Aprovar
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className={`mt-2 min-h-[54px] rounded-sm border px-2.5 py-1.5 text-xs leading-5 ${statusStyle.note}`}>
                      <p className="text-[10px] font-bold uppercase text-slate-500">Decisão</p>
                      <p className="mt-0.5 line-clamp-2">
                        {pedido.resolucao || (pedido.status === 'APROVADO' ? 'Aprovado' : pedido.status === 'REJEITADO' ? 'Rejeitado' : 'A aguardar decisão')}
                      </p>
                      {canManagePedidos && (
                        <div className="mt-1.5 flex justify-end">
                          <button onClick={() => openEditPedido(pedido)} className="inline-flex items-center gap-1 rounded-sm border border-slate-200 bg-white/80 px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-white">
                            <Edit2 size={13} /> Editar
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <button onClick={() => setMonth((current) => (current + 11) % 12)} className="rounded-md border border-slate-300 px-3 py-2 text-sm">Anterior</button>
              <h2 className="flex items-center gap-2 font-bold text-slate-900"><CalendarDays size={18} /> {new Date(year, month).toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' })}</h2>
              <button onClick={() => setMonth((current) => (current + 1) % 12)} className="rounded-md border border-slate-300 px-3 py-2 text-sm">Próximo</button>
            </div>
            <div className="grid grid-cols-7 border-l border-t border-slate-200 text-xs font-semibold text-slate-500">
              {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((label) => <div key={label} className="border-b border-r border-slate-200 bg-slate-50 p-2 text-center">{label}</div>)}
              {monthGrid(year, month).map((day, index) => (
                <div key={`${day || 'blank'}-${index}`} className="min-h-[105px] border-b border-r border-slate-200 bg-white p-2">
                  {day && <div className="mb-1 text-right text-xs font-semibold text-slate-700">{Number(day.slice(8, 10))}</div>}
                  {day && (calendarEvents.get(day) || []).slice(0, 4).map((event, eventIndex) => (
                    <div key={`${event.label}-${eventIndex}`} className={`mb-1 truncate rounded px-1.5 py-1 text-[11px] font-semibold ${event.color}`}>{event.label}</div>
                  ))}
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="font-bold text-slate-900">Férias da empresa</h2>
                <p className="text-sm text-slate-500">Períodos aplicados a todos os funcionários e contados no mapa.</p>
              </div>
              {canManagePedidos && (
                <button
                  onClick={() => setShowCompanyForm((current) => !current)}
                  className="rounded-sm bg-teal-700 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-800"
                >
                  {showCompanyForm ? 'Fechar' : 'Adicionar férias da empresa'}
                </button>
              )}
            </div>

            {showCompanyForm && canManagePedidos && (
              <div className="mt-4 grid gap-2 rounded-sm border border-teal-100 bg-teal-50 p-3 md:grid-cols-[1fr_1fr_150px_150px_auto]">
                <input
                  value={companyPeriodDraft.titulo}
                  onChange={(e) => setCompanyPeriodDraft((current) => ({ ...current, titulo: e.target.value }))}
                  placeholder="Título"
                  className="h-10 rounded-sm border border-slate-300 px-3 text-sm"
                />
                <input
                  value={companyPeriodDraft.descricao}
                  onChange={(e) => setCompanyPeriodDraft((current) => ({ ...current, descricao: e.target.value }))}
                  placeholder="Descrição"
                  className="h-10 rounded-sm border border-slate-300 px-3 text-sm"
                />
                <input
                  type="date"
                  value={companyPeriodDraft.dataInicio}
                  onChange={(e) => setCompanyPeriodDraft((current) => ({ ...current, dataInicio: e.target.value }))}
                  className="h-10 rounded-sm border border-slate-300 px-3 text-sm"
                />
                <input
                  type="date"
                  value={companyPeriodDraft.dataFim}
                  onChange={(e) => setCompanyPeriodDraft((current) => ({ ...current, dataFim: e.target.value }))}
                  className="h-10 rounded-sm border border-slate-300 px-3 text-sm"
                />
                <button onClick={addCompanyPeriod} className="h-10 rounded-sm bg-teal-700 px-3 text-sm font-semibold text-white hover:bg-teal-800">
                  Criar
                </button>
              </div>
            )}

            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {periodosEmpresa.length === 0 ? (
                <p className="text-sm text-slate-500">Sem períodos de férias da empresa.</p>
              ) : periodosEmpresa.map((periodo) => (
                <div key={periodo.id} className="rounded-sm border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-bold text-slate-900">{periodo.titulo}</p>
                      <p className="text-slate-600">{formatDate(periodo.dataInicio)} a {formatDate(periodo.dataFim)}</p>
                      <p className="text-xs text-slate-500">Todos os funcionários{periodo.descricao ? ` · ${periodo.descricao}` : ''}</p>
                    </div>
                    {canManagePedidos && (
                      <button
                        onClick={async () => {
                          await deleteHrEmpresaPeriodo(periodo.id);
                          setPeriodosEmpresa((current) => current.filter((item) => item.id !== periodo.id));
                        }}
                        className="rounded-sm bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                      >
                        Eliminar
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="font-bold text-slate-900">Feriados</h2>
            {canManagePedidos && (
              <div className="mt-3 flex gap-2">
                <input type="date" value={newHoliday.date} onChange={(e) => setNewHoliday((current) => ({ ...current, date: e.target.value }))} className="h-10 rounded-md border border-slate-300 px-3 text-sm" />
                <input value={newHoliday.name} onChange={(e) => setNewHoliday((current) => ({ ...current, name: e.target.value }))} placeholder="Nome do feriado" className="h-10 flex-1 rounded-md border border-slate-300 px-3 text-sm" />
                <button onClick={addHoliday} className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700">Guardar</button>
              </div>
            )}
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {holidays.map((holiday) => (
                <div key={holiday.date} className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm">
                  <span><strong>{holiday.name}</strong> <span className="text-slate-500">{formatDate(holiday.date)}</span></span>
                  {canManagePedidos && (
                    <button onClick={async () => { await deleteHrHoliday(holiday.date); setHolidays(await fetchHrHolidays()); }} className="rounded bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-700">Remover</button>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-200 p-4">
              <h2 className="font-bold text-slate-900">Saldo de Férias por Funcionário</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Funcionário</th>
                    <th className="px-4 py-3">Direito</th>
                    <th className="px-4 py-3">Extra</th>
                    <th className="px-4 py-3">Manual</th>
                    <th className="px-4 py-3">Férias aprov.</th>
                    <th className="px-4 py-3">Folgas aprov.</th>
                    <th className="px-4 py-3">Saldo</th>
                    {canManagePedidos && <th className="px-4 py-3">Ação</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {saldoRows.map((row) => (
                    <tr key={row.funcionario.id}>
                      <td className="px-4 py-3 font-semibold">{row.funcionario.nome}</td>
                      <td className="px-4 py-3">{row.direito}</td>
                      <td className="px-4 py-3">{row.extra}</td>
                      <td className="px-4 py-3">{row.manual}</td>
                      <td className="px-4 py-3 text-emerald-700 font-semibold">{row.feriasAprovadas}</td>
                      <td className="px-4 py-3 text-amber-700 font-semibold">{row.folgasAprovadas}</td>
                      <td className={`px-4 py-3 font-bold ${row.restante < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{row.restante}</td>
                      {canManagePedidos && (
                        <td className="px-4 py-3"><button onClick={() => saveSaldo(row)} className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white">Guardar</button></td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {editingPedido && editDraft && canManagePedidos && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4">
          <div className="w-full max-w-2xl rounded-md bg-white shadow-2xl">
            <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
              <div>
                <h2 className="text-lg font-bold text-slate-950">Editar pedido</h2>
                <p className="text-sm text-slate-500">{editingPedido.funcionarioNome || 'Funcionário'}</p>
              </div>
              <button
                onClick={() => { setEditingPedido(null); setEditDraft(null); }}
                className="rounded-sm border border-slate-200 px-2 py-1 text-sm font-semibold text-slate-600 hover:bg-slate-50"
              >
                Fechar
              </button>
            </div>

            <div className="grid gap-3 p-5 md:grid-cols-2">
              <label className="text-sm font-semibold text-slate-700">
                Tipo
                <input
                  value={editDraft.tipo}
                  onChange={(e) => setEditDraft((current) => current ? { ...current, tipo: e.target.value } : current)}
                  className="mt-1 h-10 w-full rounded-sm border border-slate-300 px-3 font-normal"
                />
              </label>
              <label className="text-sm font-semibold text-slate-700">
                Estado
                <select
                  value={editDraft.status}
                  onChange={(e) => setEditDraft((current) => current ? { ...current, status: e.target.value as HrPedidoStatus } : current)}
                  className="mt-1 h-10 w-full rounded-sm border border-slate-300 bg-white px-3 font-normal"
                >
                  <option value="PENDENTE">PENDENTE</option>
                  <option value="APROVADO">APROVADO</option>
                  <option value="REJEITADO">REJEITADO</option>
                </select>
              </label>
              <label className="text-sm font-semibold text-slate-700">
                Data início
                <input
                  type="date"
                  value={editDraft.dataInicio}
                  onChange={(e) => setEditDraft((current) => current ? { ...current, dataInicio: e.target.value } : current)}
                  className="mt-1 h-10 w-full rounded-sm border border-slate-300 px-3 font-normal"
                />
              </label>
              <label className="text-sm font-semibold text-slate-700">
                Data fim
                <input
                  type="date"
                  value={editDraft.dataFim}
                  onChange={(e) => setEditDraft((current) => current ? { ...current, dataFim: e.target.value } : current)}
                  className="mt-1 h-10 w-full rounded-sm border border-slate-300 px-3 font-normal"
                />
              </label>
              <label className="text-sm font-semibold text-slate-700 md:col-span-2">
                Descrição
                <textarea
                  value={editDraft.descricao}
                  onChange={(e) => setEditDraft((current) => current ? { ...current, descricao: e.target.value } : current)}
                  className="mt-1 h-24 w-full resize-none rounded-sm border border-slate-300 p-3 font-normal"
                />
              </label>
              <label className="text-sm font-semibold text-slate-700 md:col-span-2">
                Decisão / observação
                <textarea
                  value={editDraft.resolucao}
                  onChange={(e) => setEditDraft((current) => current ? { ...current, resolucao: e.target.value } : current)}
                  className="mt-1 h-20 w-full resize-none rounded-sm border border-slate-300 p-3 font-normal"
                />
              </label>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">
              <button
                onClick={() => { setEditingPedido(null); setEditDraft(null); }}
                className="rounded-sm border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                onClick={saveEditPedido}
                disabled={savingPedidoId === editingPedido.id}
                className="rounded-sm bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                Guardar alterações
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Metric: React.FC<{ label: string; value: number; tone?: 'emerald' | 'amber' }> = ({ label, value, tone }) => {
  const toneClass = tone === 'emerald' ? 'text-emerald-700' : tone === 'amber' ? 'text-amber-700' : 'text-slate-900';
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${toneClass}`}>{value}</p>
    </div>
  );
};

export default Pedidos;
