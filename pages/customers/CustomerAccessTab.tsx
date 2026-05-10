import React from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Customer, CustomerAccessCredential } from '../../types';
import { SegSocialSubUserState } from './customerAccessUtils';

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

type ImportedAccess = {
  label: string;
  value: string;
};

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
  triggerSegSocialInteroperabilityInfo: (
    customer: Customer,
    preferredType: 'chave_aplicacional' | 'token'
  ) => Promise<void> | void;
  triggerSegSocialSubUserLogin: (customer: Customer) => Promise<void> | void;
  triggerSegSocialSubUserSetup: (customer: Customer) => Promise<void> | void;
  updateAccessCredential: (index: number, field: keyof CustomerAccessCredential, value: string) => void;
  updateCredentialPreset: (
    preset: CustomerCredentialPreset,
    field: keyof CustomerAccessCredential,
    value: string
  ) => void;
};

function subUserContainerClass(state: SegSocialSubUserState): string {
  const tone =
    state === 'COM_SUBUTILIZADOR'
      ? 'border-emerald-200 bg-emerald-50'
      : state === 'INCOMPLETO'
        ? 'border-amber-200 bg-amber-50'
        : 'border-slate-200 bg-slate-50';
  return `flex flex-col gap-3 rounded-xl border p-3 lg:flex-row lg:items-center lg:justify-between ${tone}`;
}

function subUserTextClass(state: SegSocialSubUserState, kind: 'title' | 'body'): string {
  if (state === 'COM_SUBUTILIZADOR') return kind === 'title' ? 'text-emerald-900' : 'text-emerald-700';
  if (state === 'INCOMPLETO') return kind === 'title' ? 'text-amber-900' : 'text-amber-700';
  return kind === 'title' ? 'text-slate-800' : 'text-slate-500';
}

function presetIconClass(preset: CustomerCredentialPreset): string {
  return [
    'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[11px] font-black',
    preset.key.startsWith('ss') ? 'bg-emerald-50 text-emerald-700' : '',
    preset.key === 'at' ? 'bg-blue-50 text-blue-700' : '',
    preset.key === 'ru' ? 'bg-lime-50 text-lime-700' : '',
    preset.key === 'viactt' ? 'bg-red-50 text-red-700' : '',
    preset.key === 'iapmei' ? 'bg-sky-50 text-sky-700' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function CustomerAccessTab({
  editingCustomer,
  subUserState,
  saftSsSyncBusy,
  autologinBusyCustomerId,
  segSocialAutologinBusyCustomerId,
  segSocialSubUserBusyCustomerId,
  segSocialActivationBusyCustomerId,
  credentialPresets,
  customAccessCredentialIndexes,
  importedAccesses,
  addAccessCredential,
  canUseSegSocialSubUserFlow,
  credentialForPreset,
  findCredentialIndexForPreset,
  formatDateTime,
  removeAccessCredential,
  removeCredentialPreset,
  syncSegSocialPasswordsFromSaft,
  triggerFinancasAutologin,
  triggerSegSocialActivationSetup,
  triggerSegSocialInteroperabilityInfo,
  triggerSegSocialSubUserLogin,
  triggerSegSocialSubUserSetup,
  updateAccessCredential,
  updateCredentialPreset,
}: Props) {
  const anyAutomationBusy = Boolean(
    autologinBusyCustomerId ||
    segSocialAutologinBusyCustomerId ||
    segSocialSubUserBusyCustomerId ||
    segSocialActivationBusyCustomerId
  );

  return (
    <div className="space-y-4">
      {editingCustomer && (
        <div className={subUserContainerClass(subUserState)}>
          <div>
            <div className={`text-sm font-semibold ${subUserTextClass(subUserState, 'title')}`}>
              Segurança Social: subutilizador geral@mpr.pt
            </div>
            <p className={`text-xs ${subUserTextClass(subUserState, 'body')}`}>
              {subUserState === 'COM_SUBUTILIZADOR'
                ? 'Subutilizador criado com utilizador e senha guardados.'
                : subUserState === 'INCOMPLETO'
                  ? 'Subutilizador preparado ou incompleto. Só fica verde depois de confirmar utilizador e senha.'
                  : 'Cria apenas a subconta empresarial; ativação/token ficam no botão seguinte.'}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => void syncSegSocialPasswordsFromSaft(editingCustomer)}
              disabled={Boolean(saftSsSyncBusy || subUserState === 'COM_SUBUTILIZADOR')}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-cyan-200 bg-white px-3 py-2 text-sm font-semibold text-cyan-800 hover:bg-cyan-50 disabled:cursor-not-allowed disabled:opacity-60"
              title={subUserState === 'COM_SUBUTILIZADOR' ? 'Clientes com subutilizador completo não são atualizados pela senha principal do SAFT.' : 'Atualiza a senha e validade da conta principal SS a partir do SAFTonline.'}
            >
              <RefreshCw size={16} className={saftSsSyncBusy ? 'animate-spin' : ''} />
              {saftSsSyncBusy ? 'A atualizar...' : 'Atualizar SS do SAFT'}
            </button>
            <button
              type="button"
              onClick={() => void triggerSegSocialSubUserSetup(editingCustomer)}
              disabled={Boolean(autologinBusyCustomerId || segSocialAutologinBusyCustomerId || segSocialSubUserBusyCustomerId)}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              title={!canUseSegSocialSubUserFlow(editingCustomer) ? `Fluxo disponível apenas para empresas e independentes. Tipo atual: ${editingCustomer.type}` : 'Criar subutilizador na Segurança Social.'}
            >
              <Plus size={16} />
              {segSocialSubUserBusyCustomerId === editingCustomer.id ? 'A iniciar...' : 'Criar subutilizador SS'}
            </button>
            <button
              type="button"
              onClick={() => void triggerSegSocialActivationSetup(editingCustomer)}
              disabled={anyAutomationBusy}
              className="inline-flex items-center justify-center rounded-md border border-emerald-300 bg-white px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
              title="Usa apenas o subutilizador ja criado e com senha guardada. Nao cria subconta nem usa a conta principal."
            >
              {segSocialActivationBusyCustomerId === editingCustomer.id ? 'A ativar...' : 'Ativar conta/token'}
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Credenciais</h3>
                <p className="text-xs text-slate-500">Senhas e chaves ficam guardadas localmente. Um campo vazio nao apaga um segredo ja gravado.</p>
              </div>
              <button
                type="button"
                onClick={addAccessCredential}
                className="inline-flex items-center justify-center gap-1 rounded-md border border-blue-200 bg-white px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50"
              >
                <Plus size={14} /> Adicionar senha
              </button>
            </div>
          </div>

          <div className="divide-y divide-slate-100 p-3">
            {credentialPresets.map((preset) => {
              const credential = credentialForPreset(preset);
              const hasCredential = findCredentialIndexForPreset(preset) >= 0;
              return (
                <div key={preset.key} className="grid grid-cols-1 gap-3 py-3 lg:grid-cols-[260px_minmax(180px,220px)_minmax(0,1fr)_140px_44px] lg:items-center">
                  <div className="flex items-center gap-3">
                    <span className={presetIconClass(preset)}>{preset.icon}</span>
                    <div>
                      <div className="text-sm font-medium text-slate-800">{preset.label}</div>
                      <div className="text-[11px] text-slate-400">{preset.credentialType || 'principal'}</div>
                    </div>
                  </div>
                  <input
                    type="text"
                    placeholder="Username"
                    className="h-11 rounded-md border border-slate-200 bg-white px-3 text-sm"
                    value={credential.username || ''}
                    onChange={(event) => updateCredentialPreset(preset, 'username', event.target.value)}
                  />
                  <input
                    type="text"
                    placeholder={preset.key === 'ss_app' || preset.key === 'ss_interop' ? 'Token / chave' : 'Password'}
                    className="h-11 rounded-md border border-slate-200 bg-white px-3 font-mono text-sm"
                    value={credential.password || ''}
                    onChange={(event) => updateCredentialPreset(preset, 'password', event.target.value)}
                  />
                  {preset.validity ? (
                    <input
                      type="date"
                      className="h-11 rounded-md border border-slate-200 bg-white px-3 text-sm"
                      value={credential.validUntil || ''}
                      onChange={(event) => updateCredentialPreset(preset, 'validUntil', event.target.value)}
                      title="Data validade"
                    />
                  ) : (
                    <div className="hidden lg:block" />
                  )}
                  <button
                    type="button"
                    onClick={() => removeCredentialPreset(preset)}
                    disabled={!hasCredential}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-red-100 bg-white text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-30"
                    title="Limpar esta credencial"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}

            {customAccessCredentialIndexes.length > 0 && (
              <div className="space-y-3 py-4">
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Acessos personalizados</h4>
                  <p className="text-xs text-slate-400">Senhas especificas deste cliente que nao fazem parte dos acessos base.</p>
                </div>
                {customAccessCredentialIndexes.map(({ credential, index }) => (
                  <div key={`custom-credential-${index}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(160px,1fr)_150px_minmax(160px,1fr)_minmax(180px,1fr)_44px]">
                      <input
                        type="text"
                        placeholder="Serviço"
                        className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
                        value={credential.service || ''}
                        onChange={(event) => updateAccessCredential(index, 'service', event.target.value)}
                      />
                      <select
                        className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
                        value={credential.credentialType || ''}
                        onChange={(event) => updateAccessCredential(index, 'credentialType', event.target.value)}
                      >
                        <option value="">Tipo</option>
                        <option value="principal">Principal</option>
                        <option value="subutilizador">Subutilizador</option>
                        <option value="2fa">2FA</option>
                        <option value="chave_aplicacional">Chave aplicacional</option>
                        <option value="token">Token/chave</option>
                        <option value="outro">Outro</option>
                      </select>
                      <input
                        type="text"
                        placeholder="Username"
                        className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
                        value={credential.username || ''}
                        onChange={(event) => updateAccessCredential(index, 'username', event.target.value)}
                      />
                      <input
                        type="text"
                        placeholder="Password / token"
                        className="h-10 rounded-md border border-slate-200 bg-white px-3 font-mono text-sm"
                        value={credential.password || ''}
                        onChange={(event) => updateAccessCredential(index, 'password', event.target.value)}
                      />
                      <button
                        type="button"
                        onClick={() => removeAccessCredential(index)}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-red-100 bg-white text-red-500 hover:bg-red-50"
                        title="Remover credencial"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-[minmax(160px,1fr)_150px_150px_minmax(180px,1fr)]">
                      <input
                        type="email"
                        placeholder="Email associado"
                        className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
                        value={credential.emailAssociado || ''}
                        onChange={(event) => updateAccessCredential(index, 'emailAssociado', event.target.value)}
                      />
                      <input
                        type="date"
                        className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
                        value={credential.validUntil || ''}
                        onChange={(event) => updateAccessCredential(index, 'validUntil', event.target.value)}
                        title="Data validade"
                      />
                      <select
                        className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
                        value={credential.status || 'active'}
                        onChange={(event) => updateAccessCredential(index, 'status', event.target.value)}
                      >
                        <option value="pending">Pendente</option>
                        <option value="active">Ativo</option>
                        <option value="expired">Expirado</option>
                        <option value="error">Erro</option>
                        <option value="inactive">Inativo</option>
                      </select>
                      <input
                        type="text"
                        placeholder="Observações"
                        className="h-10 rounded-md border border-slate-200 bg-white px-3 text-sm"
                        value={credential.observacoes || ''}
                        onChange={(event) => updateAccessCredential(index, 'observacoes', event.target.value)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-900">Login Automático</h3>
          </div>
          <div className="space-y-3 p-4">
            {editingCustomer ? (
              <>
                <button
                  type="button"
                  onClick={() => void triggerFinancasAutologin(editingCustomer)}
                  disabled={anyAutomationBusy}
                  className="flex w-full items-center justify-between rounded-lg border border-blue-100 bg-blue-50 px-3 py-3 text-left text-sm font-semibold text-blue-800 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Autoridade Tributária
                  <span className="text-xs">{autologinBusyCustomerId === editingCustomer.id ? 'A abrir...' : 'Abrir'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void triggerSegSocialSubUserLogin(editingCustomer)}
                  disabled={anyAutomationBusy}
                  className="flex w-full items-center justify-between rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-3 text-left text-sm font-semibold text-emerald-800 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                  title="Entra na Segurança Social com o subutilizador guardado. Se faltar senha, tenta ler a senha recebida no email."
                >
                  Entrar com subutilizador
                  <span className="text-xs">{segSocialAutologinBusyCustomerId === editingCustomer.id ? 'A entrar...' : 'Entrar'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void triggerSegSocialInteroperabilityInfo(editingCustomer, 'chave_aplicacional')}
                  disabled={anyAutomationBusy}
                  className="flex w-full items-center justify-between rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-3 text-left text-sm font-semibold text-emerald-800 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Seg. Social Aplicacional
                  <span className="text-xs">{segSocialAutologinBusyCustomerId === editingCustomer.id ? 'A testar...' : 'Testar'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void triggerSegSocialInteroperabilityInfo(editingCustomer, 'token')}
                  disabled={anyAutomationBusy}
                  className="flex w-full items-center justify-between rounded-lg border border-emerald-100 bg-white px-3 py-3 text-left text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Seg. Social Token
                  <span className="text-xs">{segSocialAutologinBusyCustomerId === editingCustomer.id ? 'A testar...' : 'Testar'}</span>
                </button>
              </>
            ) : (
              <p className="text-sm text-slate-500">Guarde o cliente primeiro para usar o login automático.</p>
            )}
          </div>
        </aside>
      </div>

      <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">Última sincronização com MPR Control</div>
          <div className="mt-1 text-sm font-semibold text-slate-700">{formatDateTime(editingCustomer?.supabaseUpdatedAt)}</div>
        </div>
      </div>

      {importedAccesses.length > 0 ? (
        <div className="border rounded-md p-3">
          <div className="text-sm font-semibold text-gray-800 mb-2">Acessos Importados (Supabase)</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {importedAccesses.map((field) => (
              <div key={field.label} className="text-sm">
                <span className="text-gray-500">{field.label}:</span>{' '}
                <span className="font-mono text-gray-800 break-all">{field.value}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-400 italic">Sem dados de acesso importados para este cliente.</p>
      )}
    </div>
  );
}
