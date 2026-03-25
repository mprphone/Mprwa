import React, { useEffect, useState, useRef } from 'react';
import {
  UploadCloud,
  CheckCircle,
  AlertCircle,
  FileSpreadsheet,
  Download,
  FileText,
  X,
  Database,
  RefreshCw,
  CalendarDays,
} from 'lucide-react';
import { mockService } from '../services/mockData';

type DriResultPayload = {
  success: boolean;
  dryRun?: boolean;
  period?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
  updatePeriod?: { tipo?: string; ano?: number; mes?: number | null; trimestre?: number | null };
  obrigacao?: { id?: number; nome?: string; periodicidade?: string };
    result?: {
      totalRows?: number;
      matchedCustomers?: number;
      missingCustomers?: number;
      skippedAlreadyCollected?: number;
      skippedInvalidStatus?: number;
      skippedPeriodInvalid?: number;
      skippedTypeUnknown?: number;
      localSaved?: number;
      recolhasSyncOk?: number;
      periodosUpdateOk?: number;
      syncErrors?: number;
    };
  warnings?: string[];
  missingCustomers?: Array<{ empresa?: string | null; nif?: string | null }>;
  errors?: Array<{ customerId?: string; nif?: string; step?: string; error?: string }>;
  error?: string;
};

type AutoObrigacoesStatusPayload = {
  success: boolean;
  scheduler?: { enabled?: boolean; hour?: number; minute?: number; timezone?: string | null };
  state?: {
    running?: boolean;
    lastRunAt?: string | null;
    lastFinishedAt?: string | null;
    nextRunAt?: string | null;
    lastError?: string | null;
    lastSummary?: {
      startedAt?: string;
      finishedAt?: string;
      ok?: number;
      failed?: number;
      jobs?: Array<{
        route?: string;
        success?: boolean;
        statusCode?: number | null;
        startedAt?: string;
        finishedAt?: string;
        error?: string | null;
      }>;
    } | null;
  };
  error?: string;
};

function getPreviousMonthPeriod() {
  const base = new Date();
  base.setUTCDate(1);
  base.setUTCMonth(base.getUTCMonth() - 1);
  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
  };
}

const CallImport: React.FC = () => {
  const previousPeriod = getPreviousMonthPeriod();
  const [obrigacaoType, setObrigacaoType] = useState<'dri' | 'dmr' | 'goff_dmr' | 'goff_dri' | 'saft' | 'goff_saft' | 'iva' | 'goff_iva' | 'm22' | 'ies' | 'm10' | 'relatorio_unico' | 'goff_m22' | 'goff_ies' | 'goff_m10' | 'goff_inventario' | 'goff_relatorio_unico'>('dri');
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState<{ imported: number, failed: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [driYear, setDriYear] = useState(previousPeriod.year);
  const [driMonth, setDriMonth] = useState(previousPeriod.month);
  const [driDryRun, setDriDryRun] = useState(false);
  const [driForce, setDriForce] = useState(false);
  const [driLoading, setDriLoading] = useState(false);
  const [driResult, setDriResult] = useState<DriResultPayload | null>(null);
  const [driError, setDriError] = useState<string>('');
  const [autoStatus, setAutoStatus] = useState<AutoObrigacoesStatusPayload | null>(null);
  const [autoLoading, setAutoLoading] = useState(false);
  const [autoRunningNow, setAutoRunningNow] = useState(false);
  const [autoError, setAutoError] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isGoffSaft = obrigacaoType === 'goff_saft';
  const isGoffDmr = obrigacaoType === 'goff_dmr';
  const isGoffDri = obrigacaoType === 'goff_dri';
  const isGoffIva = obrigacaoType === 'goff_iva';
  const isGoffM22 = obrigacaoType === 'goff_m22';
  const isGoffIes = obrigacaoType === 'goff_ies';
  const isGoffM10 = obrigacaoType === 'goff_m10';
  const isGoffInventario = obrigacaoType === 'goff_inventario';
  const isGoffRelatorioUnico = obrigacaoType === 'goff_relatorio_unico';
  const isGoffSource = obrigacaoType.startsWith('goff_');
  const selectedSourceLabel = isGoffSource ? 'GOFF' : 'SAFT Online';
  const isGoffLockedPeriod = isGoffSaft || isGoffDmr || isGoffDri;
  const isAnnualObrigacao =
    obrigacaoType === 'm22' ||
    obrigacaoType === 'ies' ||
    obrigacaoType === 'm10' ||
    obrigacaoType === 'relatorio_unico' ||
    isGoffM22 ||
    isGoffIes ||
    isGoffM10 ||
    isGoffInventario ||
    isGoffRelatorioUnico;

  const handleDownloadTemplate = () => {
    // CSV content for Excel
    const csvContent = "Data (AAAA-MM-DD HH:mm),Duracao (segundos),Numero\n2023-10-01 14:30,120,+351912345678\n2023-10-01 15:45,300,+351961112233";
    
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'modelo_importacao_chamadas.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile && (droppedFile.type === 'text/csv' || droppedFile.name.endsWith('.csv'))) {
      setFile(droppedFile);
      setStatus(null);
    } else {
      alert('Por favor, carregue um ficheiro CSV.');
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
        setFile(e.target.files[0]);
        setStatus(null);
    }
  };

  const processFile = () => {
    if (!file) return;
    setLoading(true);
    
    const reader = new FileReader();
    reader.onload = async (e) => {
      const text = e.target?.result as string;
      if (text) {
          // Simulate network delay
          setTimeout(async () => {
            const result = await mockService.importCalls(text);
            setStatus(result);
            setLoading(false);
            setFile(null); // Clear file after success
          }, 800);
      }
    };
    reader.readAsText(file);
  };

  const setCurrentMonth = () => {
    const now = new Date();
    if (isAnnualObrigacao) {
      setDriYear(now.getUTCFullYear() - 1);
      setDriMonth(0);
      return;
    }
    setDriYear(now.getUTCFullYear());
    setDriMonth(now.getUTCMonth() + 1);
  };

  const setPreviousMonth = () => {
    if (isAnnualObrigacao) {
      const now = new Date();
      setDriYear(now.getUTCFullYear() - 2);
      setDriMonth(0);
      return;
    }
    const target = getPreviousMonthPeriod();
    setDriYear(target.year);
    setDriMonth(target.month);
  };

  const handleCollectDri = async () => {
    setDriLoading(true);
    setDriError('');
    setDriResult(null);

    const result = await mockService.collectDriObrigacoes({
      obrigacaoType,
      year: driYear,
      month: driMonth,
      dryRun: driDryRun,
      force: isGoffLockedPeriod ? false : driForce,
    });

    setDriResult(result);
    if (!result.success) {
      setDriError(result.error || `Falha na recolha ${obrigacaoType.toUpperCase()}.`);
    }
    setDriLoading(false);
  };

  const handleObrigacaoTypeChange = (nextType: 'dri' | 'dmr' | 'goff_dmr' | 'goff_dri' | 'saft' | 'goff_saft' | 'iva' | 'goff_iva' | 'm22' | 'ies' | 'm10' | 'relatorio_unico' | 'goff_m22' | 'goff_ies' | 'goff_m10' | 'goff_inventario' | 'goff_relatorio_unico') => {
    setObrigacaoType(nextType);
    if (nextType === 'goff_saft' || nextType === 'goff_dmr' || nextType === 'goff_dri') {
      const target = getPreviousMonthPeriod();
      setDriYear(target.year);
      setDriMonth(target.month);
      setDriForce(false);
      return;
    }
    if (nextType === 'goff_iva') {
      const target = getPreviousMonthPeriod();
      setDriYear(target.year);
      setDriMonth(target.month);
      return;
    }
    if (nextType === 'm22' || nextType === 'ies' || nextType === 'm10' || nextType === 'relatorio_unico' || nextType === 'goff_m22' || nextType === 'goff_ies' || nextType === 'goff_m10' || nextType === 'goff_inventario' || nextType === 'goff_relatorio_unico') {
      if (driMonth !== 0) setDriMonth(0);
      return;
    }
    if (nextType !== 'iva' && driMonth === 0) {
      setDriMonth(previousPeriod.month);
    }
  };

  const obrigacaoLabel =
    obrigacaoType === 'dri'
      ? 'DRI (Obrigação 4)'
      : obrigacaoType === 'dmr'
        ? 'DMR AT'
        : obrigacaoType === 'saft'
          ? 'SAFT'
          : obrigacaoType === 'goff_saft'
            ? 'GOFF SAFT'
            : obrigacaoType === 'goff_dmr'
              ? 'GOFF DMR AT'
              : obrigacaoType === 'goff_dri'
                ? 'GOFF DMR SS'
            : obrigacaoType === 'goff_iva'
              ? 'GOFF IVA'
          : obrigacaoType === 'm22'
            ? 'Modelo 22'
            : obrigacaoType === 'ies'
              ? 'IES'
              : obrigacaoType === 'm10'
                ? 'Modelo 10'
                : obrigacaoType === 'relatorio_unico'
                  ? 'Relatório Único'
                  : obrigacaoType === 'goff_m22'
                    ? 'GOFF Modelo 22'
                    : obrigacaoType === 'goff_ies'
                      ? 'GOFF IES'
                      : obrigacaoType === 'goff_m10'
                        ? 'GOFF M10'
                        : obrigacaoType === 'goff_inventario'
                          ? 'GOFF Inventário'
                          : obrigacaoType === 'goff_relatorio_unico'
                          ? 'GOFF Relatório Único'
            : 'IVA';

  const periodLabel =
    driResult?.period?.mes && Number(driResult.period.mes) > 0
      ? `${driResult.period?.ano}/${String(driResult.period?.mes || '').padStart(2, '0')}`
      : driResult?.period?.trimestre && Number(driResult.period.trimestre) > 0
        ? `${driResult?.period?.ano || '-'} / T${driResult.period.trimestre}`
        : `${driResult?.period?.ano || '-'}${driResult?.period?.tipo === 'anual' ? '' : ' / Todos'}`;

  const formatDateTime = (value?: string | null) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('pt-PT');
  };

  const loadAutoStatus = async (silent = false) => {
    if (!silent) {
      setAutoLoading(true);
      setAutoError('');
    }
    const status = await mockService.getObrigacoesAutoStatus();
    if (!status.success) {
      if (!silent) setAutoError(status.error || 'Falha ao carregar estado do agendamento.');
    } else {
      setAutoStatus(status);
      if (!silent) setAutoError('');
    }
    if (!silent) setAutoLoading(false);
  };

  const runAutoNow = async () => {
    setAutoRunningNow(true);
    setAutoError('');
    const result = await mockService.runObrigacoesAutoNow();
    if (!result.success) {
      setAutoError(result.error || 'Falha ao executar recolha automática.');
      setAutoRunningNow(false);
      await loadAutoStatus(true);
      return;
    }
    setAutoRunningNow(false);
    await loadAutoStatus(true);
  };

  useEffect(() => {
    void loadAutoStatus();
    const intervalId = window.setInterval(() => {
      void loadAutoStatus(true);
    }, 30000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return (
    <div className="w-full space-y-4 p-4 md:p-6">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 text-white shadow-sm md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold md:text-2xl">Importar e Sincronizar</h1>
            <p className="text-xs text-slate-200 md:text-sm">Importações locais e recolhas automáticas SAFT/GOFF.</p>
          </div>
          <button
            onClick={handleDownloadTemplate}
            className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/20 md:text-sm"
          >
            <Download size={16} />
            Baixar Modelo Excel
          </button>
        </div>
      </div>

      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Database size={18} className="text-whatsapp-600" />
          <h2 className="text-lg font-semibold text-gray-900">
            Recolha Automática
          </h2>
        </div>

        <p className="text-sm text-gray-600 mb-4">
          Fonte ativa: <strong>{selectedSourceLabel}</strong>. Recolhe metadados, grava localmente e sincroniza com Supabase (`recolhas_estados` + `clientes_obrigacoes_periodos_ano` estado 4).
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-2">SAFT Online</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'dri'} onChange={() => handleObrigacaoTypeChange('dri')} />
                DRI SS
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'dmr'} onChange={() => handleObrigacaoTypeChange('dmr')} />
                DMR AT
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'saft'} onChange={() => handleObrigacaoTypeChange('saft')} />
                SAFT
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'iva'} onChange={() => handleObrigacaoTypeChange('iva')} />
                IVA
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'm22'} onChange={() => handleObrigacaoTypeChange('m22')} />
                Modelo 22
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'ies'} onChange={() => handleObrigacaoTypeChange('ies')} />
                IES
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'm10'} onChange={() => handleObrigacaoTypeChange('m10')} />
                M10
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'relatorio_unico'} onChange={() => handleObrigacaoTypeChange('relatorio_unico')} />
                Relatório Único
              </label>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-2">GOFF</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'goff_saft'} onChange={() => handleObrigacaoTypeChange('goff_saft')} />
                SAFT
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'goff_dmr'} onChange={() => handleObrigacaoTypeChange('goff_dmr')} />
                DMR AT
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'goff_dri'} onChange={() => handleObrigacaoTypeChange('goff_dri')} />
                DMR SS
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'goff_iva'} onChange={() => handleObrigacaoTypeChange('goff_iva')} />
                IVA
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'goff_m22'} onChange={() => handleObrigacaoTypeChange('goff_m22')} />
                Modelo 22
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'goff_ies'} onChange={() => handleObrigacaoTypeChange('goff_ies')} />
                IES
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'goff_m10'} onChange={() => handleObrigacaoTypeChange('goff_m10')} />
                M10
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'goff_inventario'} onChange={() => handleObrigacaoTypeChange('goff_inventario')} />
                Inventário
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="obrigacaoType" checked={obrigacaoType === 'goff_relatorio_unico'} onChange={() => handleObrigacaoTypeChange('goff_relatorio_unico')} />
                Relatório Único
              </label>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Ano</label>
            <input
              type="number"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={driYear}
              onChange={(e) => setDriYear(Number(e.target.value || 0))}
              disabled={isGoffLockedPeriod}
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{isAnnualObrigacao ? 'Período' : 'Mês'}</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={driMonth}
              onChange={(e) => setDriMonth(Number(e.target.value))}
              disabled={isGoffLockedPeriod}
            >
              {isAnnualObrigacao && (
                <option value={0}>Anual</option>
              )}
              {obrigacaoType === 'iva' && (
                <option value={0}>Todos</option>
              )}
              {obrigacaoType === 'iva' && (
                <>
                  <option value={101}>1º Trimestre</option>
                  <option value={102}>2º Trimestre</option>
                  <option value={103}>3º Trimestre</option>
                  <option value={104}>4º Trimestre</option>
                </>
              )}
              {!isAnnualObrigacao &&
                Array.from({ length: 12 }, (_, index) => (
                  <option key={index + 1} value={index + 1}>
                    {String(index + 1).padStart(2, '0')}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              onClick={setCurrentMonth}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              disabled={isGoffLockedPeriod}
            >
              {isAnnualObrigacao ? 'Ano Corrente - 1' : 'Mês Corrente'}
            </button>
          </div>
          <div className="flex items-end">
            <button
              onClick={setPreviousMonth}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
              disabled={isGoffLockedPeriod}
            >
              {isAnnualObrigacao ? 'Ano Corrente - 2' : 'Mês Anterior'}
            </button>
          </div>
        </div>

        {isGoffSaft && (
          <p className="mb-4 text-xs text-amber-700">
            GOFF SAFT usa sempre o mês anterior e ignora seleção manual de ano/mês.
          </p>
        )}
        {isGoffDmr && (
          <p className="mb-4 text-xs text-amber-700">
            GOFF DMR AT usa sempre o mês anterior e ignora seleção manual de ano/mês.
          </p>
        )}
        {isGoffDri && (
          <p className="mb-4 text-xs text-amber-700">
            GOFF DMR SS usa sempre o mês anterior e ignora seleção manual de ano/mês.
          </p>
        )}
        {isGoffIva && (
          <p className="mb-4 text-xs text-amber-700">
            GOFF IVA distingue mensal/trimestral pelo Tipo IVA da ficha do cliente.
          </p>
        )}

        <div className="flex items-center gap-4 mb-4">
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={driDryRun}
              onChange={(e) => setDriDryRun(e.target.checked)}
            />
            Dry run (não sincroniza no Supabase)
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={driForce}
              onChange={(e) => setDriForce(e.target.checked)}
              disabled={isGoffLockedPeriod}
            />
            Forçar reprocessamento (ignora já recolhidos)
          </label>
          <button
            onClick={handleCollectDri}
            disabled={driLoading}
            className="inline-flex items-center gap-2 px-4 py-2 bg-whatsapp-600 text-white rounded-lg hover:bg-whatsapp-700 disabled:opacity-60"
          >
            {driLoading ? <RefreshCw size={16} className="animate-spin" /> : <CalendarDays size={16} />}
            {driLoading ? 'A recolher...' : `Recolher ${obrigacaoLabel} e Sincronizar`}
          </button>
        </div>

        {driError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {driError}
          </div>
        )}

        {driResult?.success && (
          <div className="rounded-lg border border-gray-200 p-4 bg-gray-50 space-y-3">
            <div className="text-sm text-gray-700">
              Obrigação: <strong>{driResult.obrigacao?.nome || obrigacaoLabel}</strong>
              {' · '}
              Período: <strong>{periodLabel}</strong>
              {driResult?.updatePeriod?.ano ? (
                <>
                  {' · '}
                  Atualiza Ano: <strong>{driResult.updatePeriod.ano}</strong>
                </>
              ) : null}
              {' · '}
              Tipo: <strong>{driResult.period?.tipo || '-'}</strong>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
              <div className="rounded bg-white border border-gray-200 px-3 py-2">
                <p className="text-gray-500">Linhas SAFT</p>
                <p className="font-semibold">{driResult.result?.totalRows || 0}</p>
              </div>
              <div className="rounded bg-white border border-gray-200 px-3 py-2">
                <p className="text-gray-500">Clientes encontrados</p>
                <p className="font-semibold">{driResult.result?.matchedCustomers || 0}</p>
              </div>
              <div className="rounded bg-white border border-gray-200 px-3 py-2">
                <p className="text-gray-500">Guardados local</p>
                <p className="font-semibold">{driResult.result?.localSaved || 0}</p>
              </div>
              <div className="rounded bg-white border border-gray-200 px-3 py-2">
                <p className="text-gray-500">Já recolhidos</p>
                <p className="font-semibold">{driResult.result?.skippedAlreadyCollected || 0}</p>
              </div>
              <div className="rounded bg-white border border-gray-200 px-3 py-2">
                <p className="text-gray-500">Estado 4 atualizados</p>
                <p className="font-semibold">{driResult.result?.periodosUpdateOk || 0}</p>
              </div>
            </div>

            {!!driResult.warnings?.length && (
              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {driResult.warnings.slice(0, 5).map((warning, index) => (
                  <p key={`${warning}-${index}`}>• {warning}</p>
                ))}
              </div>
            )}

            {!!driResult.errors?.length && (
              <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {driResult.errors.slice(0, 5).map((item, index) => (
                  <p key={`${item.step || 'step'}-${index}`}>
                    • {item.step || 'erro'}: {item.error || 'sem detalhe'}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-900">Agendamento Automático (02:00)</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void loadAutoStatus()}
              disabled={autoLoading || autoRunningNow}
              className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              <RefreshCw size={14} className={autoLoading ? 'animate-spin' : ''} />
              Atualizar
            </button>
            <button
              onClick={runAutoNow}
              disabled={autoRunningNow || autoStatus?.state?.running}
              className="inline-flex items-center gap-2 px-3 py-2 bg-whatsapp-600 text-white rounded-lg text-sm hover:bg-whatsapp-700 disabled:opacity-60"
            >
              {autoRunningNow ? <RefreshCw size={14} className="animate-spin" /> : <CalendarDays size={14} />}
              {autoRunningNow ? 'A executar...' : 'Executar agora'}
            </button>
          </div>
        </div>

        <p className="text-sm text-gray-600 mb-3">
          Regras: mensais no mês anterior, IVA 2 meses atrás, anuais no ano anterior.
        </p>

        {autoError && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {autoError}
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <div className="rounded bg-gray-50 border border-gray-200 px-3 py-2">
            <p className="text-gray-500">Ativo</p>
            <p className="font-semibold">{autoStatus?.scheduler?.enabled ? 'Sim' : 'Não'}</p>
          </div>
          <div className="rounded bg-gray-50 border border-gray-200 px-3 py-2">
            <p className="text-gray-500">A correr</p>
            <p className="font-semibold">{autoStatus?.state?.running ? 'Sim' : 'Não'}</p>
          </div>
          <div className="rounded bg-gray-50 border border-gray-200 px-3 py-2">
            <p className="text-gray-500">Próxima execução</p>
            <p className="font-semibold">{formatDateTime(autoStatus?.state?.nextRunAt)}</p>
          </div>
          <div className="rounded bg-gray-50 border border-gray-200 px-3 py-2">
            <p className="text-gray-500">Última execução</p>
            <p className="font-semibold">{formatDateTime(autoStatus?.state?.lastFinishedAt || autoStatus?.state?.lastRunAt)}</p>
          </div>
        </div>

        {!!autoStatus?.state?.lastSummary && (
          <div className="mt-3 rounded border border-gray-200 bg-gray-50 px-3 py-3 text-sm">
            <p className="text-gray-700">
              Último ciclo: <strong>OK {autoStatus.state.lastSummary.ok || 0}</strong> ·{' '}
              <strong>Falhas {autoStatus.state.lastSummary.failed || 0}</strong> · Início:{' '}
              <strong>{formatDateTime(autoStatus.state.lastSummary.startedAt)}</strong>
            </p>
            {!!autoStatus.state.lastSummary.jobs?.length && (
              <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                {autoStatus.state.lastSummary.jobs.slice(0, 8).map((job, idx) => (
                  <div key={`${job.route || 'job'}-${idx}`} className="rounded border border-gray-200 bg-white px-2 py-1">
                    <span className="font-medium">{(job.route || '-').toUpperCase()}</span>{' '}
                    <span className={job.success ? 'text-green-700' : 'text-red-700'}>
                      {job.success ? 'OK' : 'Erro'}
                    </span>
                    {job.statusCode ? <span className="text-gray-500"> ({job.statusCode})</span> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-200">
        
        {!file ? (
            <div 
                className={`border-2 border-dashed rounded-xl p-10 flex flex-col items-center justify-center text-center cursor-pointer transition-colors ${isDragging ? 'border-whatsapp-500 bg-whatsapp-50' : 'border-gray-300 hover:border-whatsapp-400 hover:bg-gray-50'}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
            >
                <input 
                    type="file" 
                    ref={fileInputRef} 
                    className="hidden" 
                    accept=".csv"
                    onChange={handleFileSelect}
                />
                <div className="w-16 h-16 bg-whatsapp-100 text-whatsapp-600 rounded-full flex items-center justify-center mb-4">
                    <FileSpreadsheet size={32} />
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mb-1">Carregue o seu ficheiro CSV</h3>
                <p className="text-sm text-gray-500 mb-4">Arraste e solte aqui, ou clique para selecionar</p>
                <p className="text-xs text-gray-400">Suporta apenas ficheiros .csv (Excel)</p>
            </div>
        ) : (
            <div className="border border-gray-200 rounded-xl p-6">
                <div className="flex justify-between items-center mb-6">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-whatsapp-100 text-whatsapp-600 rounded-lg flex items-center justify-center">
                            <FileText size={20} />
                        </div>
                        <div>
                            <p className="font-medium text-gray-900">{file.name}</p>
                            <p className="text-xs text-gray-500">{(file.size / 1024).toFixed(2)} KB</p>
                        </div>
                    </div>
                    <button onClick={() => setFile(null)} className="text-gray-400 hover:text-red-500">
                        <X size={20} />
                    </button>
                </div>
                
                <div className="flex justify-end">
                    <button
                        onClick={processFile}
                        disabled={loading}
                        className="flex items-center gap-2 px-6 py-2 bg-whatsapp-600 text-white rounded-lg hover:bg-whatsapp-700 disabled:opacity-70 transition-colors"
                    >
                        {loading ? (
                            <>Processando...</>
                        ) : (
                            <>
                                <UploadCloud size={20} /> Processar Importação
                            </>
                        )}
                    </button>
                </div>
            </div>
        )}

      </div>

      {status && (
        <div className="mt-6 flex gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="flex-1 bg-green-50 p-4 rounded-lg border border-green-200 flex items-center gap-3">
             <CheckCircle className="text-green-600" size={24} />
             <div>
               <p className="font-bold text-green-800">{status.imported} Chamadas Importadas</p>
               <p className="text-sm text-green-600">Associadas a clientes com sucesso.</p>
             </div>
          </div>
          <div className="flex-1 bg-red-50 p-4 rounded-lg border border-red-200 flex items-center gap-3">
             <AlertCircle className="text-red-600" size={24} />
             <div>
               <p className="font-bold text-red-800">{status.failed} Falhas</p>
               <p className="text-sm text-red-600">Números não encontrados na base.</p>
             </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CallImport;
