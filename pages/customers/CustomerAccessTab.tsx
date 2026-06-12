'use strict';
import React, { useState } from 'react';
import { Check, Copy, Eye, EyeOff, ExternalLink, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Customer, CustomerAccessCredential } from '../../types';
import { SegSocialSubUserState } from './customerAccessUtils';

// ─── PasswordField ─────────────────────────────────────────────────────────────

function PasswordField({
  value, onChange, placeholder, isToken = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  isToken?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!value) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        // Fallback para contextos sem clipboard API (Electron sem HTTPS, etc.)
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* silent */ }
  };

  return (
    <div className="relative flex items-center">
      <input
        type={shown || isToken ? 'text' : 'password'}
        placeholder={placeholder || (isToken ? 'Token / chave' : 'Senha')}
        className={`w-full rounded-lg border border-slate-200 py-2 pl-3 pr-16 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 ${isToken ? 'font-mono text-xs' : 'font-mono'}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      <div className="absolute right-1 flex items-center gap-0.5">
        {!isToken && (
          <button type="button" tabIndex={-1} onClick={() => setShown((v) => !v)}
            className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors">
            {shown ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
        <button type="button" tabIndex={-1} onClick={handleCopy}
          className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors">
          {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
        </button>
      </div>
    </div>
  );
}

// ─── AccessIconGrid ─────────────────────────────────────────────────────────────

type AccessIconItem =
  | { kind: 'autologin'; src: string; label: string; shortLabel: string; onClick: () => void }
  | { kind: 'link'; src: string; label: string; shortLabel: string; href: string };

function AccessIconGrid({ customer, busy, triggerFinancasAutologin, triggerSegSocialSubUserLogin, triggerSegSocialInteroperabilityInfo }: {
  customer: Customer;
  busy: boolean;
  triggerFinancasAutologin: (c: Customer) => void;
  triggerSegSocialSubUserLogin: (c: Customer) => void;
  triggerSegSocialInteroperabilityInfo: (c: Customer, type: 'chave_aplicacional' | 'token') => void;
}) {
  const [busyPortals, setBusyPortals] = useState<Set<string>>(new Set());

  const certidaoUrl = (() => {
    const code = String((customer as Record<string, unknown>).certidaoPermanenteNumero || '').trim();
    const base = 'https://registo.justica.gov.pt/Empresas/Consultar-Certidao-Permanente/Iniciar';
    return code ? `${base}?codcertidao=${encodeURIComponent(code)}` : base;
  })();

  async function triggerPortalLogin(portal: string) {
    if (busyPortals.has(portal) || busy) return;
    setBusyPortals((prev) => new Set(prev).add(portal));
    try {
      await fetch(`/api/customers/${encodeURIComponent(customer.id)}/autologin/${portal}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ headless: true }),
      });
    } catch { /* silent */ } finally {
      setBusyPortals((prev) => { const s = new Set(prev); s.delete(portal); return s; });
    }
  }

  async function triggerBancoPortugalCrc() {
    if (busyPortals.has('bportugal') || busy) return;
    setBusyPortals((prev) => new Set(prev).add('bportugal'));
    try {
      const resp = await fetch(`/api/customers/${encodeURIComponent(customer.id)}/autologin/bportugal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ useExtension: true }),
      });
      const data = await resp.json().catch(() => ({}));
      if (data.useExtension && data.credentialForExtension) {
        const cred = data.credentialForExtension;
        window.postMessage({ source: 'WA_PRO', type: 'AUTLOGIN_REQUEST', requestId: `bp-crc-${Date.now()}`, payload: { username: cred.username, password: cred.password, loginUrl: cred.loginUrl, credentialLabel: cred.credentialLabel, keepPendingAfterSubmit: true, collectBpCrc: true, customerId: cred.customerId } }, window.location.origin);
      }
    } catch { /* silent */ } finally {
      setBusyPortals((prev) => { const s = new Set(prev); s.delete('bportugal'); return s; });
    }
  }

  const items: AccessIconItem[] = [
    { kind: 'autologin', src: '/icones_autologin/01_financas.png', label: 'Autoridade Tributária', shortLabel: 'Finanças', onClick: () => triggerFinancasAutologin(customer) },
    { kind: 'autologin', src: '/icones_autologin/03_subutilizador_ss.png', label: 'Sub SS (subutilizador)', shortLabel: 'Sub SS', onClick: () => triggerSegSocialSubUserLogin(customer) },
    { kind: 'autologin', src: '/icones_autologin/02_seguranca_social.png', label: 'SS Chave Aplicacional', shortLabel: 'Seg. Social', onClick: () => triggerSegSocialInteroperabilityInfo(customer, 'chave_aplicacional') },
    { kind: 'autologin', src: '/icones_autologin/04_banco_portugal.png', label: 'Banco de Portugal', shortLabel: 'Banco Portugal', onClick: () => void triggerBancoPortugalCrc() },
    { kind: 'link', src: '/icones_autologin/05_certidao_permanente.png', label: 'Certidão Permanente', shortLabel: 'Certidão Perm.', href: certidaoUrl },
    { kind: 'autologin', src: '/icones_autologin/06_iefp_online.png', label: 'IEFP Online', shortLabel: 'IEFP Online', onClick: () => void triggerPortalLogin('iefp') },
    { kind: 'link', src: '/icones_autologin/07_livro_reclamacoes.png', label: 'Livro de Reclamações', shortLabel: 'Reclamações', href: 'https://www.livroreclamacoes.pt/entrar' },
    { kind: 'link', src: '/icones_autologin/08_siliamb_apa.png', label: 'SILiAmb / APA', shortLabel: 'SILiAmb APA', href: 'https://siliamb.apambiente.pt/pages/public/login.xhtml' },
    { kind: 'autologin', src: '/icones_autologin/09_iapmei.png', label: 'IAPMEI PME', shortLabel: 'IAPMEI', onClick: () => void triggerPortalLogin('pme') },
    { kind: 'link', src: '/icones_autologin/10_balcao_empreendedor.png', label: 'Balcão do Empreendedor', shortLabel: 'Balcão Emp.', href: 'https://www2.gov.pt/inicio/balcao-do-empreendedor' },
    { kind: 'autologin', src: '/icones_autologin/11_viactt.png', label: 'ViaCTT', shortLabel: 'ViaCTT', onClick: () => void triggerPortalLogin('viactt') },
    { kind: 'link', src: '/icones_autologin/12_relatorio_unico.png', label: 'Relatório Único', shortLabel: 'Rel. Único', href: 'https://www.relatoriounico.pt/ru/login.seam' },
  ];

  const isBusy = (item: AccessIconItem) =>
    item.kind === 'autologin' && (busy || busyPortals.has(item.label === 'Banco de Portugal' ? 'bportugal' : item.label === 'IEFP Online' ? 'iefp' : item.label === 'IAPMEI PME' ? 'pme' : item.label === 'ViaCTT' ? 'viactt' : ''));

  return (
    <div className="grid grid-cols-3 gap-1.5">
      {items.map((item) => {
        const loading = isBusy(item);
        const base = 'group flex flex-col items-center gap-1 rounded-lg border border-slate-100 bg-slate-50/80 p-2 text-center transition-all hover:border-slate-200 hover:bg-white hover:shadow-sm';
        const content = (
          <>
            <div className="relative flex h-9 w-9 items-center justify-center">
              <img src={item.src} alt={item.shortLabel} className="h-8 w-8 object-contain" draggable={false} loading="lazy" />
              {loading && <div className="absolute inset-0 flex items-center justify-center rounded-full bg-white/70"><Loader2 size={14} className="animate-spin text-emerald-600" /></div>}
              {item.kind === 'link' && <ExternalLink size={9} className="absolute -right-0.5 -top-0.5 text-slate-400 opacity-0 group-hover:opacity-100" />}
            </div>
            <span className="text-[10px] font-medium leading-tight text-slate-600">{item.shortLabel}</span>
          </>
        );
        return item.kind === 'autologin' ? (
          <button key={item.label} type="button" title={item.label} disabled={loading} onClick={item.onClick} className={`${base} disabled:opacity-50`}>{content}</button>
        ) : (
          <a key={item.label} href={item.href} target="_blank" rel="noopener noreferrer" title={item.label} className={base}>{content}</a>
        );
      })}
    </div>
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────────

export type CustomerCredentialPreset = {
  key: string;
  label: string;
  icon: string;
  service: string;
  credentialType: string;
  usernameFallback: string;
  passwordFallback: string;
  validity: boolean;
};

type ImportedAccess = { label: string; value: string };

type Props = {
  editingCustomer: Customer | null;
  subUserState: SegSocialSubUserState;
  saftSsSyncBusy: boolean;
  autologinBusyCustomerId: string | null;
  segSocialAutologinBusyCustomerId: string | null;
  segSocialSubUserBusyCustomerId: string | null;
  segSocialActivationBusyCustomerId: string | null;
  credentialPresets: readonly CustomerCredentialPreset[];
  customAccessCredentialIndexes: Array<{ credential: CustomerAccessCredential; index: number }>;
  importedAccesses: ImportedAccess[];
  addAccessCredential: () => void;
  canUseSegSocialSubUserFlow: (customer: Customer) => boolean;
  credentialForPreset: (preset: CustomerCredentialPreset) => CustomerAccessCredential;
  findCredentialIndexForPreset: (preset: CustomerCredentialPreset) => number;
  formatDateTime: (value?: string | null) => string;
  removeAccessCredential: (index: number) => void;
  removeCredentialPreset: (preset: CustomerCredentialPreset) => void;
  syncSegSocialPasswordsFromSaft: (customer: Customer) => Promise<void> | void;
  triggerFinancasAutologin: (customer: Customer) => Promise<void> | void;
  triggerSegSocialActivationSetup: (customer: Customer) => Promise<void> | void;
  triggerSegSocialInteroperabilityInfo: (customer: Customer, preferredType: 'chave_aplicacional' | 'token') => Promise<void> | void;
  triggerSegSocialSubUserLogin: (customer: Customer) => Promise<void> | void;
  triggerSegSocialSubUserSetup: (customer: Customer) => Promise<void> | void;
  updateAccessCredential: (index: number, field: keyof CustomerAccessCredential, value: string) => void;
  updateCredentialPreset: (preset: CustomerCredentialPreset, field: keyof CustomerAccessCredential, value: string) => void;
};

// ─── Preset icon badge ──────────────────────────────────────────────────────────

function PresetBadge({ preset }: { preset: CustomerCredentialPreset }) {
  const colorMap: Record<string, string> = {
    at: 'bg-blue-50 text-blue-700 border-blue-100',
    ru: 'bg-lime-50 text-lime-700 border-lime-100',
    viactt: 'bg-red-50 text-red-700 border-red-100',
    iapmei: 'bg-sky-50 text-sky-700 border-sky-100',
  };
  const cls = colorMap[preset.key] || (preset.key.startsWith('ss') ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-slate-50 text-slate-600 border-slate-200');
  return (
    <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-[10px] font-black ${cls}`}>
      {preset.icon}
    </span>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────────

export function CustomerAccessTab({
  editingCustomer, subUserState, saftSsSyncBusy,
  autologinBusyCustomerId, segSocialAutologinBusyCustomerId, segSocialSubUserBusyCustomerId, segSocialActivationBusyCustomerId,
  credentialPresets, customAccessCredentialIndexes, importedAccesses,
  addAccessCredential, canUseSegSocialSubUserFlow, credentialForPreset, findCredentialIndexForPreset,
  formatDateTime, removeAccessCredential, removeCredentialPreset, syncSegSocialPasswordsFromSaft,
  triggerFinancasAutologin, triggerSegSocialActivationSetup, triggerSegSocialInteroperabilityInfo,
  triggerSegSocialSubUserLogin, triggerSegSocialSubUserSetup, updateAccessCredential, updateCredentialPreset,
}: Props) {
  const anyAutomationBusy = Boolean(autologinBusyCustomerId || segSocialAutologinBusyCustomerId || segSocialSubUserBusyCustomerId || segSocialActivationBusyCustomerId);

  const ssBg = subUserState === 'COM_SUBUTILIZADOR' ? 'border-emerald-200 bg-emerald-50' : subUserState === 'INCOMPLETO' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-slate-50';
  const ssTitleColor = subUserState === 'COM_SUBUTILIZADOR' ? 'text-emerald-800' : subUserState === 'INCOMPLETO' ? 'text-amber-800' : 'text-slate-700';
  const ssBodyColor = subUserState === 'COM_SUBUTILIZADOR' ? 'text-emerald-600' : subUserState === 'INCOMPLETO' ? 'text-amber-600' : 'text-slate-500';

  return (
    <div className="space-y-4">

      {/* ── Segurança Social — subutilizador ─────── */}
      {editingCustomer && (
        <div className={`rounded-xl border p-4 ${ssBg}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/70 text-xs font-black text-emerald-700 border border-emerald-100">SS</span>
              <div>
                <p className={`text-sm font-semibold ${ssTitleColor}`}>Segurança Social: subutilizador geral@mpr.pt</p>
                <p className={`text-xs mt-0.5 ${ssBodyColor}`}>
                  {subUserState === 'COM_SUBUTILIZADOR' ? 'Subutilizador criado com utilizador e senha guardados.' : subUserState === 'INCOMPLETO' ? 'Subutilizador preparado ou incompleto.' : 'Cria apenas a subconta empresarial; ativação/token ficam no botão seguinte.'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void syncSegSocialPasswordsFromSaft(editingCustomer)}
                disabled={Boolean(saftSsSyncBusy || subUserState === 'COM_SUBUTILIZADOR')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed">
                <RefreshCw size={12} className={saftSsSyncBusy ? 'animate-spin' : ''} />
                {saftSsSyncBusy ? 'A atualizar...' : 'Atualizar SS do SAFT'}
              </button>
              <button type="button" onClick={() => void triggerSegSocialSubUserSetup(editingCustomer)}
                disabled={Boolean(autologinBusyCustomerId || segSocialAutologinBusyCustomerId || segSocialSubUserBusyCustomerId)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed">
                <Plus size={12} />
                {segSocialSubUserBusyCustomerId === editingCustomer.id ? 'A iniciar...' : 'Criar subutilizador SS'}
              </button>
              <button type="button" onClick={() => void triggerSegSocialActivationSetup(editingCustomer)}
                disabled={anyAutomationBusy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 disabled:cursor-not-allowed">
                {segSocialActivationBusyCustomerId === editingCustomer.id ? 'A ativar...' : 'Ativar conta/token'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Credenciais + Acessos rápidos ─────────── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_240px]">

        {/* Credenciais */}
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <h3 className="text-sm font-bold text-slate-800">Credenciais</h3>
              <p className="text-[11px] text-slate-400 mt-0.5">Senhas e chaves ficam guardadas localmente. Um campo vazio não apaga um segredo já gravado.</p>
            </div>
            <button type="button" onClick={addAccessCredential}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
              <Plus size={12} /> Adicionar senha
            </button>
          </div>

          {/* Cabeçalho da tabela */}
          <div className="hidden lg:grid border-b border-slate-50 bg-slate-50/60 px-4 py-2" style={{ gridTemplateColumns: '220px 1fr 1fr 130px 36px' }}>
            {['ENTIDADE', 'UTILIZADOR / IDENTIFICADOR', 'SENHA / CHAVE', 'VALIDADE', 'AÇÕES'].map((h) => (
              <span key={h} className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{h}</span>
            ))}
          </div>

          <div className="divide-y divide-slate-50">
            {credentialPresets.map((preset) => {
              const credential = credentialForPreset(preset);
              const hasCredential = findCredentialIndexForPreset(preset) >= 0;
              const isToken = preset.key === 'ss_app' || preset.key === 'ss_interop';
              return (
                <div key={preset.key} className="grid grid-cols-1 gap-2 px-4 py-3 lg:items-center lg:gap-3" style={{ gridTemplateColumns: 'auto' }}>
                  <div className="hidden lg:grid lg:items-center lg:gap-3" style={{ gridTemplateColumns: '220px 1fr 1fr 130px 36px' }}>
                    {/* Entidade */}
                    <div className="flex items-center gap-2.5">
                      <PresetBadge preset={preset} />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-slate-800 truncate">{preset.label}</p>
                        <p className="text-[10px] text-slate-400">{preset.credentialType || 'principal'}</p>
                      </div>
                    </div>
                    {/* Username */}
                    <input type="text" placeholder="Username" className="h-9 rounded-lg border border-slate-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={credential.username || ''} onChange={(e) => updateCredentialPreset(preset, 'username', e.target.value)} />
                    {/* Password */}
                    <PasswordField value={credential.password || ''} onChange={(v) => updateCredentialPreset(preset, 'password', v)} isToken={isToken} />
                    {/* Validade */}
                    {preset.validity ? (
                      <input type="date" className="h-9 rounded-lg border border-slate-200 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500" value={credential.validUntil || ''} onChange={(e) => updateCredentialPreset(preset, 'validUntil', e.target.value)} />
                    ) : <div />}
                    {/* Ações */}
                    <button type="button" onClick={() => removeCredentialPreset(preset)} disabled={!hasCredential}
                      className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-100 text-red-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-25 disabled:cursor-not-allowed transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {/* Mobile layout */}
                  <div className="flex flex-col gap-2 lg:hidden">
                    <div className="flex items-center gap-2">
                      <PresetBadge preset={preset} />
                      <span className="text-sm font-semibold text-slate-800">{preset.label}</span>
                    </div>
                    <input type="text" placeholder="Username" className="h-9 w-full rounded-lg border border-slate-200 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={credential.username || ''} onChange={(e) => updateCredentialPreset(preset, 'username', e.target.value)} />
                    <PasswordField value={credential.password || ''} onChange={(v) => updateCredentialPreset(preset, 'password', v)} isToken={isToken} />
                    {preset.validity && <input type="date" className="h-9 rounded-lg border border-slate-200 px-2 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500" value={credential.validUntil || ''} onChange={(e) => updateCredentialPreset(preset, 'validUntil', e.target.value)} />}
                  </div>
                </div>
              );
            })}

            {/* Acessos personalizados */}
            {customAccessCredentialIndexes.length > 0 && (
              <div className="px-4 py-3 space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Acessos personalizados</p>
                {customAccessCredentialIndexes.map(({ credential, index }) => (
                  <div key={`custom-${index}`} className="rounded-lg border border-slate-100 bg-slate-50 p-3 space-y-2">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px_1fr_1fr_36px]">
                      <input type="text" placeholder="Serviço" className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={credential.service || ''} onChange={(e) => updateAccessCredential(index, 'service', e.target.value)} />
                      <select className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={credential.credentialType || ''} onChange={(e) => updateAccessCredential(index, 'credentialType', e.target.value)}>
                        <option value="">Tipo</option>
                        <option value="principal">Principal</option>
                        <option value="subutilizador">Subutilizador</option>
                        <option value="2fa">2FA</option>
                        <option value="chave_aplicacional">Chave apl.</option>
                        <option value="token">Token</option>
                        <option value="outro">Outro</option>
                      </select>
                      <input type="text" placeholder="Username" className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={credential.username || ''} onChange={(e) => updateAccessCredential(index, 'username', e.target.value)} />
                      <PasswordField value={credential.password || ''} onChange={(v) => updateAccessCredential(index, 'password', v)} placeholder="Password / token" />
                      <button type="button" onClick={() => removeAccessCredential(index)}
                        className="flex h-9 w-9 items-center justify-center rounded-lg border border-red-100 text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors">
                        <Trash2 size={13} />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_130px_100px_1fr]">
                      <input type="email" placeholder="Email associado" className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={credential.emailAssociado || ''} onChange={(e) => updateAccessCredential(index, 'emailAssociado', e.target.value)} />
                      <input type="date" className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500" value={credential.validUntil || ''} onChange={(e) => updateAccessCredential(index, 'validUntil', e.target.value)} />
                      <select className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={credential.status || 'active'} onChange={(e) => updateAccessCredential(index, 'status', e.target.value)}>
                        <option value="pending">Pendente</option>
                        <option value="active">Ativo</option>
                        <option value="expired">Expirado</option>
                        <option value="error">Erro</option>
                        <option value="inactive">Inativo</option>
                      </select>
                      <input type="text" placeholder="Observações" className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={credential.observacoes || ''} onChange={(e) => updateAccessCredential(index, 'observacoes', e.target.value)} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Última sincronização */}
          <div className="flex items-center justify-between border-t border-slate-50 bg-slate-50/40 px-4 py-2.5">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-slate-400">Última sincronização MPR Control</p>
              <p className="text-xs font-semibold text-slate-600 mt-0.5">{formatDateTime(editingCustomer?.supabaseUpdatedAt) || 'Nunca sincronizado'}</p>
            </div>
            <RefreshCw size={13} className="text-slate-300" />
          </div>
        </section>

        {/* Acessos rápidos */}
        <aside className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="flex items-center gap-1.5 border-b border-slate-100 px-4 py-3">
            <h3 className="text-sm font-bold text-slate-800">Acessos rápidos</h3>
          </div>
          <div className="p-3">
            {editingCustomer ? (
              <AccessIconGrid
                customer={editingCustomer}
                busy={anyAutomationBusy}
                triggerFinancasAutologin={triggerFinancasAutologin}
                triggerSegSocialSubUserLogin={triggerSegSocialSubUserLogin}
                triggerSegSocialInteroperabilityInfo={triggerSegSocialInteroperabilityInfo}
              />
            ) : (
              <p className="text-xs text-slate-400">Guarde o cliente primeiro.</p>
            )}
          </div>
        </aside>
      </div>

      {/* Acessos importados */}
      {importedAccesses.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-slate-600 hover:bg-slate-50 list-none flex items-center gap-1.5">
            <span className="text-slate-400">▶</span> Dados de acesso importados do Supabase
          </summary>
          <div className="border-t border-slate-100 grid grid-cols-1 md:grid-cols-2 gap-2 px-4 py-3">
            {importedAccesses.map((field) => (
              <div key={field.label} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-slate-400">{field.label}</p>
                <p className="text-xs font-mono text-slate-700 break-all mt-0.5">{field.value}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
