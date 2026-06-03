import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Clock3, FileText, Info, Loader2, Mail, RefreshCw, Shield, ThumbsDown, ThumbsUp, Trash2, Upload, XCircle } from 'lucide-react';
import { Customer } from '../../types';

// ─── Data model ───────────────────────────────────────────────────────────────

export type FiscalFiling = {
  ano: string;
  situacao: string;
  dataRecepcao: string;
  comprovativoPath?: string;
};

export type FiscalCertidao = {
  tipo: string;
  dataValidade: string;
  valida: boolean;
  ficheiroPdf?: string;
};

export type FiscalDocumento = {
  tipo: 'pme' | 'bportugal' | 'certidao_permanente' | 'rebe' | 'domicilio_fiscal';
  label: string;
  dataValidade?: string;
  valida?: boolean;
  ficheiroPdf?: string;
  notas?: string;
};

export type FiscalDivida = {
  entidade: 'at' | 'ss';
  montante: number;
  semDivida: boolean;
};

export type FiscalSummaryData = {
  ies: FiscalFiling[];
  modelo22: FiscalFiling[];
  certidoes: FiscalCertidao[];
  documentos: FiscalDocumento[];
  dividas: FiscalDivida[];
  collections?: Record<string, FiscalCollectionMeta>;
  updatedAt?: string;
};

export type FiscalCollectionMeta = {
  status?: string;
  requestedAt?: string;
  startedAt?: string;
  completedAt?: string;
  message?: string;
  jobId?: string;
};

export type FiscalCollectionJob = {
  id: string;
  job: RecolhaJob;
  status: string;
  requested_at: string;
  started_at?: string;
  finished_at?: string;
  attempts: number;
  message?: string;
  error?: string;
  updated_at: string;
};

export type FiscalCollectionLog = {
  id: number;
  job_id: string;
  job: RecolhaJob;
  level: 'info' | 'warn' | 'error' | string;
  message: string;
  created_at: string;
};

const DEFAULT_DATA: FiscalSummaryData = {
  ies: [
    { ano: '', situacao: '', dataRecepcao: '' },
    { ano: '', situacao: '', dataRecepcao: '' },
    { ano: '', situacao: '', dataRecepcao: '' },
  ],
  modelo22: [
    { ano: '', situacao: '', dataRecepcao: '' },
    { ano: '', situacao: '', dataRecepcao: '' },
    { ano: '', situacao: '', dataRecepcao: '' },
  ],
  certidoes: [
    { tipo: 'Certidão Dívida AT', dataValidade: '', valida: false },
    { tipo: 'Certidão Dívida SS', dataValidade: '', valida: false },
  ],
  documentos: [
    { tipo: 'domicilio_fiscal', label: 'Domicílio Fiscal', valida: false },
    { tipo: 'certidao_permanente', label: 'Certidão Permanente', dataValidade: '', valida: false },
    { tipo: 'pme', label: 'Certificado PME', dataValidade: '', valida: false },
    { tipo: 'bportugal', label: 'Responsabilidades Banco de Portugal', dataValidade: '', valida: false },
    { tipo: 'rebe', label: 'REBE', dataValidade: '', valida: false },
  ],
  dividas: [
    { entidade: 'at', montante: 0, semDivida: false },
    { entidade: 'ss', montante: 0, semDivida: false },
  ],
  collections: {},
};

type Props = {
  customer: Customer;
  anyAutomationBusy: boolean;
};

type RecolhaJob =
  | 'certidao_at' | 'certidao_ss' | 'certidao_permanente'
  | 'pme' | 'bportugal' | 'ies' | 'modelo22' | 'domicilio_fiscal';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isExpired(d: string) { return !!d && new Date(d) < new Date(); }

function formatDate(iso: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('pt-PT');
}

function formatDateTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function isRecentActivity(iso?: string, minutes = 15) {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() < minutes * 60 * 1000;
}

function formatEur(n: number) {
  return n.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function normalizeCustomerType(value?: string) {
  const text = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (text.includes('particular') || text.includes('independente')) return 'particular';
  if (text.includes('empresa')) return 'empresa';
  return '';
}

function jobStatusLabel(status?: string) {
  switch (status) {
    case 'queued': return 'Em fila';
    case 'processing': return 'A recolher';
    case 'retry': return 'Nova tentativa';
    case 'completed': return 'Concluída';
    case 'skipped': return 'Ignorada';
    case 'needs_review': return 'A rever';
    case 'failed': return 'Falhou';
    default: return 'Sem estado';
  }
}

function jobStatusClass(status?: string) {
  switch (status) {
    case 'queued': return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'processing': return 'border-blue-200 bg-blue-50 text-blue-700';
    case 'retry': return 'border-orange-200 bg-orange-50 text-orange-700';
    case 'completed': return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'skipped':
    case 'needs_review': return 'border-slate-200 bg-slate-50 text-slate-600';
    case 'failed': return 'border-red-200 bg-red-50 text-red-700';
    default: return 'border-slate-200 bg-white text-slate-500';
  }
}

function jobStatusIcon(status?: string) {
  if (status === 'processing') return <Loader2 size={13} className="animate-spin" />;
  if (status === 'queued' || status === 'retry') return <Clock3 size={13} />;
  if (status === 'completed') return <CheckCircle2 size={13} />;
  if (status === 'failed') return <XCircle size={13} />;
  return <AlertCircle size={13} />;
}

function fiscalFileUrl(customer: Customer, filePath?: string) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/api/')) return raw;
  // Bug #12: rejeitar paths com traversal (../) para prevenir path injection
  if (raw.includes('..') || raw.includes('\0')) return '';
  const params = new URLSearchParams({ path: raw });
  return `/api/customers/${encodeURIComponent((customer as any).id)}/fiscal-summary/file?${params.toString()}`;
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const CARD = 'overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm';
const CARD_HDR = 'bg-emerald-500 px-4 py-2.5';
const CARD_TITLE = 'text-xs font-bold uppercase tracking-widest text-white';
const TH = 'px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-emerald-600';
const TH_C = 'px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-emerald-600';
const CELL = 'text-xs text-slate-700';
const EMPTY = 'text-xs text-slate-300 select-none';

// ─── SectionCard ──────────────────────────────────────────────────────────────

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={CARD}>
      <div className={`${CARD_HDR} flex items-center`}>
        <span className={CARD_TITLE}>{title}</span>
      </div>
      {children}
    </div>
  );
}

// ─── StatusDot ────────────────────────────────────────────────────────────────

function StatusDot({ valida }: { valida: boolean }) {
  return (
    <span className={`inline-flex items-center justify-center rounded-full w-7 h-7 ${
      valida ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'
    }`}>
      {valida ? <ThumbsUp size={13} /> : <ThumbsDown size={13} />}
    </span>
  );
}

// ─── FilingTable ─────────────────────────────────────────────────────────────

function FilingTable({ rows, customer }: { rows: FiscalFiling[]; customer: Customer }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-100 bg-slate-50">
          <th className={TH} style={{ width: 64 }}>Ano</th>
          <th className={TH}>Situação</th>
          <th className={TH}>Data Recepção</th>
          <th className={TH_C}>Comprov.</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-slate-50 last:border-0 hover:bg-emerald-50/30 transition-colors">
            <td className="px-3 py-2.5 text-center">
              <span className="text-xs font-mono font-semibold text-slate-700">{row.ano || <span className={EMPTY}>—</span>}</span>
            </td>
            <td className="px-3 py-2.5">
              <span className={row.situacao ? CELL : EMPTY}>{row.situacao || '—'}</span>
            </td>
            <td className="px-3 py-2.5">
              <span className={row.dataRecepcao ? CELL : EMPTY}>{row.dataRecepcao ? formatDate(row.dataRecepcao) : '—'}</span>
            </td>
            <td className="px-2 py-2.5 text-center">
              {row.comprovativoPath
                ? <a href={fiscalFileUrl(customer, row.comprovativoPath)} target="_blank" rel="noopener noreferrer"
                    className="text-red-500 hover:text-red-600 transition-colors inline-flex">
                    <FileText size={15} />
                  </a>
                : <span className={EMPTY}>—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── CertidoesTable ──────────────────────────────────────────────────────────

function CertidoesTable({ rows, customer }: { rows: FiscalCertidao[]; customer: Customer }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-100 bg-slate-50">
          <th className={TH}>Certidão</th>
          <th className={TH}>Data Validade</th>
          <th className={TH_C}>Válida</th>
          <th className={TH_C}>Certidão</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className={`border-b border-slate-50 last:border-0 transition-colors ${
            row.valida ? 'bg-emerald-50/40' : 'hover:bg-slate-50/70'
          }`}>
            <td className="px-3 py-2.5">
              <span className="text-xs font-semibold text-slate-700">{row.tipo}</span>
            </td>
            <td className="px-3 py-2.5">
              {row.dataValidade
                ? <span className={`text-xs font-medium ${isExpired(row.dataValidade) ? 'text-red-600' : 'text-slate-700'}`}>
                    {formatDate(row.dataValidade)}
                    {isExpired(row.dataValidade) && (
                      <span className="ml-2 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-600">Expirada</span>
                    )}
                  </span>
                : <span className={EMPTY}>—</span>}
            </td>
            <td className="px-2 py-2.5 text-center">
              <StatusDot valida={row.valida} />
            </td>
            <td className="px-2 py-2.5 text-center">
              {row.ficheiroPdf
                ? <a href={fiscalFileUrl(customer, row.ficheiroPdf)} target="_blank" rel="noopener noreferrer"
                    className="rounded-md bg-red-50 p-1.5 text-red-500 hover:bg-red-100 transition-colors inline-flex" title="Ver PDF">
                    <FileText size={13} />
                  </a>
                : <span className={EMPTY}>—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── FilingBadge ──────────────────────────────────────────────────────────────

function FilingBadge({ situacao }: { situacao: string }) {
  const s = String(situacao || '');
  if (/certa|entregue|aceite|validad/i.test(s))
    return <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">{s}</span>;
  if (/sem\s+declara|não\s+dispon|indispon/i.test(s))
    return <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">Não disponível</span>;
  if (/erro|invalida|errada|anulad/i.test(s))
    return <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-600">{s}</span>;
  return <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">{s}</span>;
}

// ─── OutrosDocumentosTable ───────────────────────────────────────────────────

// Tipos que suportam upload directo (coincidem com CustomerIngestDocumentType no backend)
const UPLOADABLE_TIPOS = new Set(['certidao_permanente', 'pacto_social', 'inicio_atividade', 'rcbe', 'cartao_cidadao']);
// Tipos que não têm conceito de "expiração" — a data é de emissão/submissão
const NO_EXPIRY_TIPOS = new Set(['rcbe', 'pacto_social', 'inicio_atividade', 'bportugal', 'rebe', 'domicilio_fiscal']);

function OutrosDocumentosTable({
  rows, customer, onRefresh,
}: {
  rows: FiscalDocumento[];
  customer: Customer;
  onRefresh?: () => void;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [uploadingTipo, setUploadingTipo] = React.useState<string | null>(null);
  const pendingTipoRef = React.useRef<string | null>(null);

  // pendingTipo pode ser 'rcbe', 'pacto_social', ou 'cc_{nif}' para cartão de cidadão
  const [deletingTipo, setDeletingTipo] = React.useState<string | null>(null);

  const handleDeleteDocumento = async (tipo: string, label: string) => {
    if (!window.confirm(`Eliminar "${label}" do resumo fiscal?`)) return;
    setDeletingTipo(tipo);
    try {
      const res = await fetch(`/api/customers/${encodeURIComponent(customer.id)}/fiscal-summary/remove-documento`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo }),
      });
      const json = await res.json();
      if (json.success) await load();
    } catch (e) {
      console.error('Erro ao eliminar documento:', e);
    } finally {
      setDeletingTipo(null);
    }
  };

  const handleUploadClick = (tipo: string) => {
    pendingTipoRef.current = tipo;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const tipo = pendingTipoRef.current;
    if (!file || !tipo || !customer.id) return;
    setUploadingTipo(tipo);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      // Para CC: documentType='cartao_cidadao' + nif do sócio
      const isCc = tipo.startsWith('cc_');
      const documentType = isCc ? 'cartao_cidadao' : tipo;
      const managerNif = isCc ? tipo.replace('cc_', '') : undefined;
      const res = await fetch(`/api/customers/${encodeURIComponent(customer.id)}/documents/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentType, fileName: file.name, contentBase64: base64, managerNif }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Falha no upload.');
      onRefresh?.();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Erro ao guardar documento.');
    } finally {
      setUploadingTipo(null);
      pendingTipoRef.current = null;
    }
  };

  // Linhas CC por sócio (tipo 'cc_{nif}') — só adiciona se ainda não existir em rows
  const managers = (customer as any).managers as Array<{ name: string; nif?: string }> | undefined;
  const ccRows: FiscalDocumento[] = (managers || [])
    .filter((m) => m?.name)
    .flatMap((m) => {
      const nifClean = String(m.nif || '').replace(/\D+/g, '').slice(-9);
      const ccTipo = `cc_${nifClean || m.name.replace(/\s+/g, '_')}`;
      const nameUpper = m.name.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
      // Já existe em rows? Verificar por tipo OU por nome (case-insensitive, sem acentos)
      const alreadyInRows = rows.some((r) => {
        if (r.tipo === ccTipo) return true;
        if (!r.label?.startsWith('CC')) return false;
        const rowName = r.label.replace(/^CC\s*[—-]\s*/i, '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
        return rowName === nameUpper;
      });
      if (alreadyInRows) return [];
      return [{
        tipo: ccTipo,
        label: `CC — ${m.name}`,
        dataValidade: '',
        valida: false,
        ficheiroPdf: '',
        notas: nifClean || '',
      }];
    });

  return (
    <>
      <input ref={fileInputRef} type="file" accept=".pdf,.png,.jpg,.jpeg" className="hidden" onChange={handleFileChange} />
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 bg-slate-50">
            <th className={TH}>Documento</th>
            <th className={TH}>Data Validade</th>
            <th className={TH_C}>Válido</th>
            <th className={TH}>Notas / Código</th>
            <th className={TH_C}>Ficheiro</th>
          </tr>
        </thead>
        <tbody>
          {[...rows, ...ccRows].map((row, i) => {
            const canUpload = UPLOADABLE_TIPOS.has(row.tipo) || row.tipo.startsWith('cc_');
            const isUploading = uploadingTipo === row.tipo;
            return (
              <tr key={i} className={`border-b border-slate-50 last:border-0 transition-colors ${
                row.valida ? 'bg-emerald-50/40' : 'hover:bg-slate-50/70'
              }`}>
                <td className="px-3 py-2.5 text-xs font-semibold text-slate-700 whitespace-nowrap">{row.label}</td>
                <td className="px-3 py-2.5">
                  {row.dataValidade
                    ? <span className={`text-xs font-medium ${!NO_EXPIRY_TIPOS.has(row.tipo) && isExpired(row.dataValidade) ? 'text-red-600' : 'text-slate-700'}`}>
                        {formatDate(row.dataValidade)}
                        {!NO_EXPIRY_TIPOS.has(row.tipo) && isExpired(row.dataValidade) && (
                          <span className="ml-2 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-600">Expirado</span>
                        )}
                      </span>
                    : <span className={EMPTY}>—</span>}
                </td>
                <td className="px-2 py-2.5 text-center">
                  <StatusDot valida={Boolean(row.valida)} />
                </td>
                <td className="px-3 py-2.5">
                  <span className={row.notas ? CELL : EMPTY}>{row.notas || '—'}</span>
                </td>
                <td className="px-2 py-2.5 text-center">
                  <div className="inline-flex items-center gap-1">
                    {row.ficheiroPdf && (
                      <a href={fiscalFileUrl(customer, row.ficheiroPdf)} target="_blank" rel="noopener noreferrer"
                          className="rounded-md bg-red-50 p-1.5 text-red-500 hover:bg-red-100 transition-colors inline-flex" title="Ver ficheiro">
                        <FileText size={13} />
                      </a>
                    )}
                    {canUpload && (
                      <button type="button" title="Carregar ficheiro"
                        disabled={isUploading}
                        onClick={() => handleUploadClick(row.tipo)}
                        className="rounded-md bg-slate-100 p-1.5 text-slate-500 hover:bg-slate-200 transition-colors inline-flex disabled:opacity-50">
                        {isUploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                      </button>
                    )}
                    {(row.tipo.startsWith('cc_') || (row.ficheiroPdf && row.tipo !== 'domicilio_fiscal')) && (
                      <button type="button" title="Eliminar entrada"
                        disabled={deletingTipo === row.tipo}
                        onClick={() => handleDeleteDocumento(row.tipo, row.label)}
                        className="rounded-md bg-slate-100 p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500 transition-colors inline-flex disabled:opacity-50">
                        {deletingTipo === row.tipo ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      </button>
                    )}
                    {!row.ficheiroPdf && !canUpload && !row.tipo.startsWith('cc_') && <span className={EMPTY}>—</span>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// ─── DividaCard ──────────────────────────────────────────────────────────────

function DividaCard({ divida }: { divida: FiscalDivida }) {
  const icon = divida.entidade === 'at'
    ? '/icones_autologin/01_financas.png'
    : '/icones_autologin/02_seguranca_social.png';
  const label = divida.entidade === 'at' ? 'AT' : 'Seg. Social';
  const isGood = divida.semDivida;
  const isUnknown = !divida.semDivida && divida.montante === 0;

  return (
    <div className={`flex flex-1 items-center gap-3 rounded-xl border-2 px-4 py-3.5 transition-all ${
      isGood
        ? 'border-emerald-200 bg-gradient-to-br from-emerald-50 to-green-50 shadow-sm'
        : isUnknown
          ? 'border-slate-200 bg-slate-50 shadow-sm'
          : 'border-red-200 bg-gradient-to-br from-red-50 to-rose-50 shadow-sm'
    }`}>
      <img src={icon} alt={label}
        className="h-10 w-10 shrink-0 object-contain rounded-lg p-1 bg-white/60" />
      <p className={`flex-1 text-xs font-bold uppercase tracking-wide ${
        isGood ? 'text-emerald-700' : isUnknown ? 'text-slate-500' : 'text-red-700'
      }`}>
        {label}
      </p>
      <span className={`inline-flex items-center justify-center rounded-full w-7 h-7 ${
        isGood
          ? 'bg-emerald-100 text-emerald-600'
          : isUnknown
            ? 'bg-slate-100 text-slate-400'
            : 'bg-red-100 text-red-500'
      }`}>
        {isGood ? <ThumbsUp size={13} /> : isUnknown ? <AlertCircle size={13} /> : <ThumbsDown size={13} />}
      </span>
    </div>
  );
}

// ─── Recolha jobs ─────────────────────────────────────────────────────────────

// Jobs incluídos no botão "Atualizar dados" / "Forçar recolha"
const AUTO_JOBS: RecolhaJob[] = ['ies', 'modelo22', 'certidao_at', 'certidao_ss', 'certidao_permanente', 'pme'];

// Todos os jobs (para labels e status display)
const RECOLHA_JOBS: { job: RecolhaJob; label: string }[] = [
  { job: 'ies', label: 'IES' },
  { job: 'modelo22', label: 'Modelo 22' },
  { job: 'certidao_at', label: 'Certidão AT' },
  { job: 'certidao_ss', label: 'Certidão SS' },
  { job: 'certidao_permanente', label: 'Certidão Permanente' },
  { job: 'pme', label: 'Certificado PME' },
  { job: 'bportugal', label: 'CRC Bancos' },
  { job: 'domicilio_fiscal', label: 'Domicílio Fiscal' },
];

const JOB_LABELS: Record<string, string> = RECOLHA_JOBS.reduce<Record<string, string>>((acc, item) => {
  acc[item.job] = item.label;
  return acc;
}, { email: 'Email' });

// ─── Main component ───────────────────────────────────────────────────────────

export function CustomerFiscalSummaryTab({ customer, anyAutomationBusy }: Props) {
  const [data, setData] = useState<FiscalSummaryData>(DEFAULT_DATA);
  const [jobs, setJobs] = useState<FiscalCollectionJob[]>([]);
  const [logs, setLogs] = useState<FiscalCollectionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningJobs, setRunningJobs] = useState<Set<RecolhaJob>>(new Set());
  const [jobMessages, setJobMessages] = useState<Record<string, string>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/customers/${encodeURIComponent(customer.id)}/fiscal-summary?_=${Date.now()}`, {
        cache: 'no-store',
      });
      const json = await res.json();
      if (json.success && json.data && Object.keys(json.data).length > 0) {
        setData({ ...DEFAULT_DATA, ...json.data });
      }
      if (json.success && Array.isArray(json.jobs)) setJobs(json.jobs);
    } catch { /* use defaults */ } finally { setLoading(false); }
  }, [customer.id]);

  const loadLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/customers/${encodeURIComponent(customer.id)}/fiscal-summary/logs?_=${Date.now()}`, {
        cache: 'no-store',
      });
      const json = await res.json();
      if (json.success && Array.isArray(json.logs)) setLogs(json.logs);
    } catch { /* optional */ }
  }, [customer.id]);

  useEffect(() => { void load(); void loadLogs(); }, [load, loadLogs]);

  const activeJobs = useMemo(() => {
    const active = new Set<RecolhaJob>();
    jobs.forEach((job) => {
      if (job.status === 'queued' || job.status === 'processing' || job.status === 'retry') {
        active.add(job.job);
      }
    });
    return active;
  }, [jobs]);

  const hasRecentJobActivity = useMemo(() => (
    jobs.some((job) => (
      isRecentActivity(job.updated_at)
      || isRecentActivity(job.finished_at)
      || isRecentActivity(job.started_at)
      || isRecentActivity(job.requested_at)
    ))
  ), [jobs]);

  // Polling: só enquanto há jobs activos. Quando terminam, um refresh final e para.
  const prevActiveJobsRef = React.useRef(0);
  useEffect(() => {
    if (activeJobs.size === 0) {
      // Se havia jobs activos antes e agora não há → refresh final
      if (prevActiveJobsRef.current > 0) {
        void load();
        void loadLogs();
      }
      prevActiveJobsRef.current = 0;
      return;
    }
    prevActiveJobsRef.current = activeJobs.size;
    const timer = window.setInterval(() => {
      void load();
      void loadLogs();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeJobs.size, load, loadLogs]);

  async function postRecolha(job: RecolhaJob, force = false) {
    const res = await fetch(
      `/api/customers/${encodeURIComponent(customer.id)}/fiscal-summary/recolher/${job}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      }
    );
    return res.json();
  }

  // Dispara todos os jobs automáticos (excl. bportugal)
  // force=false → respeita política (skips se já completo ou se pede confirmação)
  // force=true  → força recolha de tudo
  // Usa Promise.allSettled: erros num job não bloqueiam os restantes
  async function triggerBatchRecolha(force = false) {
    if (batchBusy || anyAutomationBusy) return;
    setBatchBusy(true);
    try {
      const jobsToRun = AUTO_JOBS.filter((job) => {
        if (isParticular && job === 'ies') return false;
        if (isEmpresa && (job as string) === 'domicilio_fiscal') return false;
        return true;
      });
      await Promise.allSettled(
        jobsToRun.map(async (job) => {
          const json = await postRecolha(job, force);
          // Se pede confirmação e não é forçado → ignorar silenciosamente
          if (json.requiresConfirmation && !force) return;
        })
      );
      [800, 6000, 20000, 60000].forEach((delay) =>
        setTimeout(() => { void load(); void loadLogs(); }, delay)
      );
    } finally {
      setBatchBusy(false);
    }
  }

  async function triggerRecolha(job: RecolhaJob, force = false) {
    if (runningJobs.has(job) || activeJobs.has(job)) return;
    setRunningJobs((prev) => new Set(prev).add(job));
    setJobMessages((prev) => ({ ...prev, [job]: 'A preparar...' }));
    try {
      let json = await postRecolha(job, force);
      if (json.requiresConfirmation) {
        const ok = window.confirm(json.message || 'Já existe uma recolha válida. Quer avançar novamente?');
        if (!ok) {
          setJobMessages((prev) => ({ ...prev, [job]: 'Mantida a recolha existente' }));
          return;
        }
        json = await postRecolha(job, true);
      }
      setJobMessages((prev) => ({
        ...prev,
        [job]: json.message || (json.success ? 'Em fila' : (json.error || 'Erro')),
      }));
      [700, 6000, 20000, 60000, 180000].forEach((delay) => {
        setTimeout(() => { void load(); void loadLogs(); }, delay);
      });
    } catch {
      setJobMessages((prev) => ({ ...prev, [job]: 'Erro' }));
    } finally {
      setRunningJobs((prev) => { const s = new Set(prev); s.delete(job); return s; });
      setTimeout(() => setJobMessages((prev) => { const n = { ...prev }; delete n[job]; return n; }), 5000);
    }
  }

  const atIdx = data.dividas.findIndex((d) => d.entidade === 'at');
  const ssIdx = data.dividas.findIndex((d) => d.entidade === 'ss');
  const hasQueue = jobs.length > 0;
  const customerType = normalizeCustomerType((customer as any).type);
  const isParticular = customerType === 'particular';
  const isEmpresa = customerType === 'empresa';
  const robotBusy = activeJobs.size > 0;

  // Métricas para o card de situação geral
  const allFilings = [...data.ies, ...data.modelo22];
  const certasCount = allFilings.filter((f) => /certa|entregue|aceite/i.test(f.situacao || '')).length;
  const certidoesValidasCount = data.certidoes.filter((c) => c.valida).length;
  const semDeclaracaoItems = allFilings.filter((f) => /sem\s+declara|não\s+dispon/i.test(f.situacao || ''));
  const hasProblems = data.certidoes.some((c) => c.dataValidade && isExpired(c.dataValidade));
  const situacaoLabel = hasProblems ? 'Atenção' : certasCount >= 2 ? 'Regular' : 'Incompleto';
  const situacaoColor = hasProblems ? 'text-amber-600' : certasCount >= 2 ? 'text-emerald-600' : 'text-slate-500';
  const situacaoBg = hasProblems ? 'bg-amber-50 border-amber-200' : certasCount >= 2 ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200';

  // Alertas para anos sem submissão
  const alerts: string[] = [];
  data.ies.forEach((f) => { if (f.ano && /sem\s+declara|não\s+dispon/i.test(f.situacao || '')) alerts.push(`A IES de ${f.ano} ainda não tem submissão disponível.`); });
  data.modelo22.forEach((f) => { if (f.ano && /sem\s+declara|não\s+dispon/i.test(f.situacao || '')) alerts.push(`O Modelo 22 de ${f.ano} ainda não tem submissão disponível.`); });

  if (loading) return (
    <div className="flex items-center justify-center py-20 text-slate-400 text-sm gap-2">
      <Loader2 size={18} className="animate-spin" /> A carregar...
    </div>
  );

  return (
    <div className="space-y-5 pb-4">

      {/* ── Cabeçalho ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">Situação Fiscal e Declarativa</h2>
          <p className="text-xs text-slate-500 mt-0.5">Visão geral das obrigações fiscais, declarações e documentos</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Última recolha + robot status */}
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-500 shadow-sm">
            <Clock3 size={12} />
            {data.updatedAt ? <span>Última recolha: <strong className="text-slate-700">{formatDateTime(data.updatedAt)}</strong></span> : <span>Sem recolha</span>}
            <span className={`ml-1 inline-flex items-center gap-1 font-semibold ${robotBusy ? 'text-blue-600' : 'text-emerald-600'}`}>
              <span className={`h-2 w-2 rounded-full ${robotBusy ? 'bg-blue-500 animate-pulse' : 'bg-emerald-500'}`} />
              {robotBusy ? 'A recolher' : 'Robô ativo'}
            </span>
          </div>
          {/* Atualizar dados */}
          <button type="button" disabled={batchBusy || anyAutomationBusy}
            onClick={() => void triggerBatchRecolha(false)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold shadow-sm transition-all active:scale-95 disabled:opacity-50 ${batchBusy ? 'bg-emerald-100 text-emerald-700' : 'bg-emerald-500 text-white hover:bg-emerald-600'}`}>
            {batchBusy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Atualizar dados
          </button>
          {/* Forçar recolha */}
          <button type="button" disabled={batchBusy || anyAutomationBusy}
            onClick={() => void triggerBatchRecolha(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 transition-all disabled:opacity-50">
            {batchBusy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Forçar recolha
          </button>
          {/* Enviar ao cliente */}
          <button type="button" onClick={() => setShowEmailModal(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 transition-all">
            <Mail size={13} /> Enviar ao cliente
          </button>
          {/* CRC Bancos */}
          {(() => {
            const job: RecolhaJob = 'bportugal';
            const busy = runningJobs.has(job) || activeJobs.has(job);
            return (
              <button type="button" disabled={busy || anyAutomationBusy} onClick={() => void triggerRecolha(job)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-sm font-semibold shadow-sm transition-all disabled:opacity-50 ${busy ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-blue-200 bg-white text-blue-600 hover:bg-blue-50'}`}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                CRC Bancos
              </button>
            );
          })()}
          {/* Mais opções — Ver logs */}
          {hasQueue && (
            <button type="button" onClick={() => setShowLogs((v) => !v)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 shadow-sm hover:bg-slate-50 transition-all">
              {showLogs ? 'Menos' : 'Mais opções'} <ChevronDown size={13} className={`transition-transform ${showLogs ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {/* ── Logs (expandível) ──────────────────────────────────────── */}
      {hasQueue && showLogs && (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="grid gap-4 bg-slate-50/60 px-4 py-4 lg:grid-cols-[1.3fr_0.7fr]">
            <div className="space-y-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Lista de espera e últimas recolhas</p>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {jobs.slice(0, 6).map((job) => (
                  <div key={job.id} className={`rounded-lg border px-3 py-2 ${jobStatusClass(job.status)}`}>
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-xs font-bold">{JOB_LABELS[job.job] || job.job}</span>
                      <span className="inline-flex items-center gap-1 text-[11px] font-semibold whitespace-nowrap">{jobStatusIcon(job.status)} {jobStatusLabel(job.status)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-[10px] opacity-70">
                      <span>{formatDateTime(job.requested_at)}</span>
                      {job.attempts > 0 && <span>{job.attempts} tent.</span>}
                    </div>
                    {(job.message || job.error) && <p className="mt-0.5 truncate text-[10px] opacity-80">{job.error || job.message}</p>}
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Log recente</p>
              <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-50">
                {logs.slice(0, 5).length === 0
                  ? <p className="px-3 py-3 text-xs text-slate-400">Sem registos.</p>
                  : logs.slice(0, 5).map((log) => (
                    <div key={log.id} className="flex items-start gap-2 px-3 py-2">
                      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${log.level === 'error' ? 'bg-red-500' : log.level === 'warn' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-slate-700">{JOB_LABELS[log.job] || log.job}</p>
                        <p className="truncate text-[11px] text-slate-500">{log.message}</p>
                      </div>
                      <span className="shrink-0 text-[10px] text-slate-400">{formatDateTime(log.created_at)}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Card situação geral ────────────────────────────────────── */}
      <div className={`rounded-xl border p-4 ${situacaoBg}`}>
        <div className="flex flex-wrap items-center gap-4">
          <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${hasProblems ? 'bg-amber-100' : certasCount >= 2 ? 'bg-emerald-100' : 'bg-slate-100'}`}>
            {hasProblems ? <AlertTriangle size={22} className="text-amber-600" /> : certasCount >= 2 ? <CheckCircle2 size={22} className="text-emerald-600" /> : <AlertCircle size={22} className="text-slate-400" />}
          </div>
          <div>
            <p className="text-base font-bold text-slate-800">Situação geral: <span className={situacaoColor}>{situacaoLabel}</span></p>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
              {certasCount > 0 && <span className="flex items-center gap-1"><CheckCircle2 size={11} className="text-emerald-500" /> {certasCount} declarações certas</span>}
              {certidoesValidasCount > 0 && <span className="flex items-center gap-1"><Shield size={11} className="text-emerald-500" /> {certidoesValidasCount} certidões válidas</span>}
              {semDeclaracaoItems.length > 0 && <span className="flex items-center gap-1 text-slate-400"><Info size={11} /> {semDeclaracaoItems.length} {semDeclaracaoItems.length === 1 ? 'item' : 'itens'} sem declaração disponível</span>}
            </div>
          </div>
        </div>
      </div>

      {/* ── Grid 4 colunas ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">

        {/* IES */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
            <FileText size={14} className="text-emerald-600" />
            <span className="text-sm font-bold text-slate-800">IES</span>
          </div>
          <div className="divide-y divide-slate-50">
            <div className="grid grid-cols-4 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              <span>Ano</span><span>Situação</span><span>Receção</span><span className="text-right">PDF</span>
            </div>
            {data.ies.map((f, i) => (
              <div key={i} className="grid grid-cols-4 items-center px-4 py-2.5 text-xs hover:bg-slate-50/60">
                <span className="font-semibold text-slate-700">{f.ano || '—'}</span>
                <span>{f.situacao ? <FilingBadge situacao={f.situacao} /> : <span className="text-slate-300">—</span>}</span>
                <span className="text-slate-500">{f.dataRecepcao ? formatDate(f.dataRecepcao) : <span className="text-slate-300">—</span>}</span>
                <span className="text-right">
                  {f.comprovativoPath ? <a href={fiscalFileUrl(customer, f.comprovativoPath)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-emerald-600 hover:text-emerald-700 font-medium"><FileText size={11} /> Ver PDF</a> : <span className="text-slate-300">—</span>}
                </span>
              </div>
            ))}
          </div>
          <div className="border-t border-slate-50 px-4 py-2">
            <button className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1">Ver histórico completo <ChevronRight size={11} /></button>
          </div>
        </div>

        {/* Modelo 22 */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
            <FileText size={14} className="text-emerald-600" />
            <span className="text-sm font-bold text-slate-800">{isParticular ? 'IRS' : 'Modelo 22'}</span>
          </div>
          <div className="divide-y divide-slate-50">
            <div className="grid grid-cols-4 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              <span>Ano</span><span>Situação</span><span>Receção</span><span className="text-right">PDF</span>
            </div>
            {data.modelo22.map((f, i) => (
              <div key={i} className="grid grid-cols-4 items-center px-4 py-2.5 text-xs hover:bg-slate-50/60">
                <span className="font-semibold text-slate-700">{f.ano || '—'}</span>
                <span>{f.situacao ? <FilingBadge situacao={f.situacao} /> : <span className="text-slate-300">—</span>}</span>
                <span className="text-slate-500">{f.dataRecepcao ? formatDate(f.dataRecepcao) : <span className="text-slate-300">—</span>}</span>
                <span className="text-right">
                  {f.comprovativoPath ? <a href={fiscalFileUrl(customer, f.comprovativoPath)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-emerald-600 hover:text-emerald-700 font-medium"><FileText size={11} /> Ver PDF</a> : <span className="text-slate-300">—</span>}
                </span>
              </div>
            ))}
          </div>
          <div className="border-t border-slate-50 px-4 py-2">
            <button className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1">Ver histórico completo <ChevronRight size={11} /></button>
          </div>
        </div>

        {/* Certidões */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
            <Shield size={14} className="text-emerald-600" />
            <span className="text-sm font-bold text-slate-800">Certidões de Não Dívida</span>
          </div>
          <div className="divide-y divide-slate-50">
            <div className="grid grid-cols-4 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              <span className="col-span-1">Certidão</span><span>Situação</span><span>Validade</span><span className="text-right">PDF</span>
            </div>
            {data.certidoes.map((c, i) => (
              <div key={i} className="grid grid-cols-4 items-center px-4 py-2.5 text-xs hover:bg-slate-50/60">
                <span className="font-semibold text-slate-700 truncate">{c.tipo.replace('Certidão Dívida ', '')}</span>
                <span>{c.valida ? <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Válida</span> : <span className="inline-flex items-center gap-0.5 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">—</span>}</span>
                <span className={`text-[11px] ${c.dataValidade && isExpired(c.dataValidade) ? 'text-red-500' : 'text-slate-500'}`}>{c.dataValidade ? `até ${formatDate(c.dataValidade)}` : '—'}</span>
                <span className="text-right">
                  {c.ficheiroPdf ? <a href={fiscalFileUrl(customer, c.ficheiroPdf)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-emerald-600 hover:text-emerald-700 font-medium text-[11px]"><FileText size={11} /> Ver certidão</a> : <span className="text-slate-300">—</span>}
                </span>
              </div>
            ))}
          </div>
          <div className="border-t border-slate-50 px-4 py-2">
            <button className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1">Ver todas as certidões <ChevronRight size={11} /></button>
          </div>
        </div>

        {/* Dívidas */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
            <AlertCircle size={14} className="text-emerald-600" />
            <span className="text-sm font-bold text-slate-800">Dívidas</span>
          </div>
          <div className="divide-y divide-slate-50 px-4 py-2 space-y-2">
            {[data.dividas[atIdx] ?? DEFAULT_DATA.dividas[0], data.dividas[ssIdx] ?? DEFAULT_DATA.dividas[1]].map((d, i) => {
              const icon = d.entidade === 'at' ? '/icones_autologin/01_financas.png' : '/icones_autologin/02_seguranca_social.png';
              const label = d.entidade === 'at' ? 'AT' : 'Segurança Social';
              return (
                <div key={i} className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${d.semDivida ? 'border-emerald-100 bg-emerald-50' : 'border-slate-100 bg-slate-50'}`}>
                  <img src={icon} alt={label} className="h-8 w-8 shrink-0 rounded-md object-contain bg-white p-0.5" />
                  <span className="flex-1 text-xs font-semibold text-slate-700">{label}</span>
                  {d.semDivida
                    ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">Sem dívidas</span>
                    : <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-500">Por verificar</span>
                  }
                  <span className={d.semDivida ? 'text-emerald-500' : 'text-slate-400'}>{d.semDivida ? <ThumbsUp size={14} /> : <ThumbsDown size={14} />}</span>
                </div>
              );
            })}
          </div>
          <div className="border-t border-slate-50 px-4 py-2">
            <button className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1">Ver detalhe de dívidas <ChevronRight size={11} /></button>
          </div>
        </div>
      </div>

      {/* ── Alertas ────────────────────────────────────────────────── */}
      {alerts.slice(0, 2).map((alert, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle size={15} className="shrink-0 text-amber-500" />
          <p className="text-xs text-amber-800"><strong>Atenção:</strong> {alert}</p>
        </div>
      ))}

      {/* ── Outros Documentos + Sidebar ───────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_260px]">
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3">
            <span className="text-sm font-bold text-slate-800">Outros Documentos</span>
          </div>
          <OutrosDocumentosTable rows={data.documentos} customer={customer} onRefresh={() => { void load(); }} />
        </div>

        {/* Informações rápidas */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 px-4 py-3">
            <span className="text-sm font-bold text-slate-800">Informações rápidas</span>
          </div>
          <div className="divide-y divide-slate-50 px-4 py-2 text-xs">
            <div className="py-2.5 flex items-start gap-2">
              <span className="mt-0.5 text-slate-400"><Info size={12} /></span>
              <div><p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">Cliente</p>
              <p className="font-medium text-emerald-700">{(customer as any).company || customer.name}</p></div>
            </div>
            <div className="py-2.5 flex items-start gap-2">
              <span className="mt-0.5 text-slate-400"><CheckCircle2 size={12} /></span>
              <div><p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">Respostas automáticas</p>
              <p className={`font-semibold ${(customer as any).allowAutoResponses !== false ? 'text-emerald-600' : 'text-slate-400'}`}>
                {(customer as any).allowAutoResponses !== false ? '✓ Ativo' : '✗ Inativo'}
              </p></div>
            </div>
            <div className="py-2.5 flex items-start gap-2">
              <span className="mt-0.5 text-slate-400"><Clock3 size={12} /></span>
              <div><p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">Última sincronização</p>
              <p className="text-slate-600">{data.updatedAt ? formatDateTime(data.updatedAt) : '—'}</p></div>
            </div>
            <div className="py-2.5 flex items-start gap-2">
              <span className="mt-0.5 text-slate-400"><RefreshCw size={12} /></span>
              <div><p className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">Robô de recolhas</p>
              <p className={`flex items-center gap-1 font-semibold ${robotBusy ? 'text-blue-600' : 'text-emerald-600'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${robotBusy ? 'bg-blue-500 animate-pulse' : 'bg-emerald-500'}`} />
                {robotBusy ? 'A recolher...' : 'Ativo'}
              </p></div>
            </div>
            {hasQueue && (
              <div className="pt-2.5">
                <button type="button" onClick={() => setShowLogs((v) => !v)}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-all">
                  <FileText size={12} /> {showLogs ? 'Ocultar logs' : 'Ver logs'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal: Enviar ao cliente */}
      {showEmailModal && (
        <SendEmailModal customer={customer} data={data} onClose={() => setShowEmailModal(false)} />
      )}

    </div>
  );
}

// ─── SendEmailModal ───────────────────────────────────────────────────────────

type EmailLog = { id: string; sent_to: string; subject: string; sent_at: string; read_at: string | null; attachment_count: number };

function SendEmailModal({ customer, data, onClose }: { customer: Customer; data: FiscalSummaryData; onClose: () => void }) {
  const company = (customer as any).company || customer.name;
  const customerId = (customer as any).id;
  const [to, setTo] = React.useState(String((customer as any).email || ''));
  const [subject, setSubject] = React.useState(`Envio de Documentação Solicitada`);
  const [body, setBody] = React.useState(
    `Exmo.(a) Senhor(a),\n\nEsperamos que esta mensagem o(a) encontre bem.\n\nNa sequência do solicitado, remetemos em anexo a documentação requerida para os devidos efeitos.\n\nPermanecemos à disposição para prestar quaisquer esclarecimentos adicionais que considere necessários.\n\nCom os melhores cumprimentos,\n\nMPR Negócios, Lda`
  );
  const [sending, setSending] = React.useState(false);
  const [status, setStatus] = React.useState('');
  const [emailLog, setEmailLog] = React.useState<EmailLog[]>([]);

  React.useEffect(() => {
    fetch(`/api/customers/${encodeURIComponent(customerId)}/fiscal-summary/email-log`)
      .then((r) => r.json()).then((j) => { if (j.success) setEmailLog(j.logs || []); })
      .catch(() => null);
  }, [customerId]);

  // Recolher todos os PDFs disponíveis
  const availablePdfs = React.useMemo(() => {
    const pdfs: { label: string; path: string }[] = [];
    const addIfPdf = (label: string, path?: string) => {
      if (path && path.endsWith('.pdf')) pdfs.push({ label, path });
    };
    // IES
    (data.ies || []).forEach((f) => addIfPdf(`IES ${f.ano}`, f.comprovativoPath));
    // Modelo 22
    (data.modelo22 || []).forEach((f) => addIfPdf(`Modelo 22 — ${f.ano}`, f.comprovativoPath));
    // Certidões
    (data.certidoes || []).forEach((c) => addIfPdf(c.tipo, c.ficheiroPdf));
    // Outros documentos
    (data.documentos || []).forEach((d) => addIfPdf(d.label || d.tipo, d.ficheiroPdf));
    return pdfs;
  }, [data]);

  const [selected, setSelected] = React.useState<Set<string>>(
    new Set(availablePdfs.map((p) => p.path))
  );

  const toggleAll = (checked: boolean) =>
    setSelected(checked ? new Set(availablePdfs.map((p) => p.path)) : new Set());

  const handleSend = async () => {
    if (!to.trim()) { setStatus('Preencha o email do destinatário.'); return; }
    setSending(true);
    setStatus('');
    try {
      const res = await fetch(`/api/customers/${encodeURIComponent((customer as any).id)}/fiscal-summary/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: to.trim(),
          subject: subject.trim(),
          html: body.replace(/\n/g, '<br/>'),
          attachmentPaths: [...selected],
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Falha ao enviar.');
      setStatus(`✓ Email enviado com ${json.attachmentCount} anexo(s).`);
      // Refrescar o log
      const logRes = await fetch(`/api/customers/${encodeURIComponent(customerId)}/fiscal-summary/email-log`);
      const logJson = await logRes.json().catch(() => ({}));
      if (logJson.success) setEmailLog(logJson.logs || []);
      setTimeout(() => setStatus(''), 3000);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Erro ao enviar email.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2 font-semibold text-slate-800"><Mail size={16} className="text-emerald-600" /> Enviar ao cliente</div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><XCircle size={16} /></button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Email do cliente</label>
              <input value={to} onChange={(e) => setTo(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Assunto</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Mensagem</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-none" />
          </div>
          {availablePdfs.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <input type="checkbox" id="select-all"
                  checked={selected.size === availablePdfs.length}
                  onChange={(e) => toggleAll(e.target.checked)}
                  className="rounded" />
                <label htmlFor="select-all" className="text-xs font-medium text-slate-600 cursor-pointer">
                  Selecionar todos os anexos PDF
                </label>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {availablePdfs.map((pdf) => (
                  <label key={pdf.path} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                    <input type="checkbox"
                      checked={selected.has(pdf.path)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(pdf.path); else next.delete(pdf.path);
                        setSelected(next);
                      }}
                      className="rounded" />
                    {pdf.label}
                  </label>
                ))}
              </div>
            </div>
          )}
          {status && (
            <p className={`text-xs font-medium ${status.startsWith('✓') ? 'text-emerald-600' : 'text-red-600'}`}>{status}</p>
          )}

          {/* Histórico de envios */}
          {emailLog.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Histórico de envios</p>
              <div className="rounded-lg border border-slate-100 divide-y divide-slate-50 max-h-40 overflow-y-auto">
                {emailLog.map((log) => (
                  <div key={log.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-slate-700 truncate block">{log.sent_to}</span>
                      <span className="text-slate-400 truncate block">{log.subject}</span>
                    </div>
                    <div className="shrink-0 text-right space-y-0.5">
                      <div className="flex items-center gap-1 text-slate-500">
                        <Mail size={10} />
                        <span>{new Date(log.sent_at).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      {log.read_at
                        ? <div className="flex items-center gap-1 text-emerald-600 font-medium">
                            <CheckCircle2 size={10} />
                            <span>Aberto {new Date(log.read_at).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                        : <div className="text-slate-400">Não aberto</div>
                      }
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="border-t border-slate-100 px-5 py-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100">Cancelar</button>
          <button type="button" onClick={handleSend} disabled={sending}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
            Enviar ao cliente
          </button>
        </div>
      </div>
    </div>
  );
}
