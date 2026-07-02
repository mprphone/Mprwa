import React from 'react';
import { User, Building2, Copy, FolderOpen, Shield, Users, Plus } from 'lucide-react';
import { Customer, CustomerType, CustomerManager } from '../../../types';
import { CustomerFormState } from '../customerFormState';
import { normalizeNifDigits } from '../customerAccessUtils';
import { pickImportedValue } from '../customerHelpers';

// Separador "Dados" do modal de cliente (identificação, dados corporativos,
// enquadramento fiscal, gerência, campos importados). Movido verbatim de
// Customers.tsx — recebe formData/setFormData e handlers via props.
type Props = {
  formData: CustomerFormState;
  setFormData: React.Dispatch<React.SetStateAction<CustomerFormState>>;
  isNifLocked: boolean;
  folderEditMode: boolean;
  setFolderEditMode: React.Dispatch<React.SetStateAction<boolean>>;
  users: { id: string; name: string }[];
  editingCustomer: Customer | null;
  importedLookup: Map<string, unknown>;
  importedFields: { label: string; value: string }[];
  copyCustomerNif: () => void;
  openCustomerDocumentsFolder: () => void;
  addManager: () => void;
  updateManager: (index: number, field: keyof CustomerManager, value: string) => void;
  removeManager: (index: number) => void;
};

export const CustomerDadosTab: React.FC<Props> = ({
  formData,
  setFormData,
  isNifLocked,
  folderEditMode,
  setFolderEditMode,
  users,
  editingCustomer,
  importedLookup,
  importedFields,
  copyCustomerNif,
  openCustomerDocumentsFolder,
  addManager,
  updateManager,
  removeManager,
}) => (
                <div className="space-y-4">

                  {/* ── Identificação ─────────────────────────────── */}
                  <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                    <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-3.5">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100"><User size={14} className="text-emerald-600" /></span>
                      <h3 className="text-sm font-bold text-slate-800">Identificação</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-x-4 gap-y-3 px-5 py-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Nome *</label>
                        <input required type="text" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} />
                      </div>
                      <div className="max-w-[260px]">
                        <label className="block text-xs font-medium text-slate-500 mb-1">NIF</label>
                        <div className="flex items-center gap-1.5">
                          <input type="text" className={`min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 ${isNifLocked ? 'bg-slate-50 text-slate-400 cursor-not-allowed' : ''}`} value={formData.nif} onChange={(e) => setFormData({ ...formData, nif: e.target.value })} disabled={isNifLocked} title={isNifLocked ? 'NIF bloqueado após validação.' : ''} />
                          <button
                            type="button"
                            onClick={() => { void copyCustomerNif(); }}
                            disabled={!normalizeNifDigits(formData.nif || '')}
                            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
                            title="Copiar NIF"
                            aria-label="Copiar NIF"
                          >
                            <Copy size={14} />
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">NISS</label>
                        <input type="text" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.niss} onChange={(e) => setFormData({ ...formData, niss: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Data de nascimento</label>
                        <input type="date" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.dataNascimento} onChange={(e) => setFormData({ ...formData, dataNascimento: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Morada</label>
                        <input type="text" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.morada} onChange={(e) => setFormData({ ...formData, morada: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Código Postal</label>
                        <input type="text" placeholder="0000-000 Localidade" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.codigoPostal} onChange={(e) => setFormData({ ...formData, codigoPostal: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Email</label>
                        <input type="email" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.email} onChange={(e) => setFormData({ ...formData, email: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Telefone (opcional)</label>
                        <input type="text" placeholder="+351..." className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: e.target.value })} />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs font-medium text-slate-500 mb-1">Empresa</label>
                        <input required type="text" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.company} onChange={(e) => setFormData({ ...formData, company: e.target.value })} />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs font-medium text-slate-500 mb-1">Nome do Contacto (Telemóvel)</label>
                        <input type="text" placeholder="Ex.: Marco Rebelo" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.contactName} onChange={(e) => setFormData({ ...formData, contactName: e.target.value })} />
                      </div>
                    </div>
                  </section>

                  {/* ── Dados Corporativos ────────────────────────── */}
                  <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                    <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-3.5">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100"><Building2 size={14} className="text-emerald-600" /></span>
                      <h3 className="text-sm font-bold text-slate-800">Dados Corporativos</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-x-4 gap-y-3 px-5 py-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Certidão Permanente (nº)</label>
                        <input type="text" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.certidaoPermanenteNumero} onChange={(e) => setFormData({ ...formData, certidaoPermanenteNumero: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Certidão Permanente (validade)</label>
                        <div className="flex items-center gap-2">
                          <input type="date" className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.certidaoPermanenteValidade} onChange={(e) => setFormData({ ...formData, certidaoPermanenteValidade: e.target.value })} />
                          {formData.certidaoPermanenteValidade && new Date(formData.certidaoPermanenteValidade) > new Date() && (
                            <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">Válida</span>
                          )}
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">RCBE (nº)</label>
                        <input type="text" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.rcbeNumero} onChange={(e) => setFormData({ ...formData, rcbeNumero: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">RCBE (data)</label>
                        <input type="date" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.rcbeData} onChange={(e) => setFormData({ ...formData, rcbeData: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Data de constituição</label>
                        <input type="date" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.dataConstituicao} onChange={(e) => setFormData({ ...formData, dataConstituicao: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Início de atividade</label>
                        <input type="date" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.inicioAtividade} onChange={(e) => setFormData({ ...formData, inicioAtividade: e.target.value })} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Código Repartição Finanças</label>
                        <input type="text" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.codigoReparticaoFinancas} onChange={(e) => setFormData({ ...formData, codigoReparticaoFinancas: e.target.value })} />
                      </div>
                      {/* Lista unificada de CAEs — Principal + Secundários */}
                      <div className="md:col-span-4 mt-1 border-t border-slate-100 pt-3">
                        <label className="block text-xs font-medium text-slate-500 mb-1">Atividades Exercidas (CAEs)</label>
                        {(() => {
                          let secCaes: {codigo: string; descricao: string}[] = [];
                          try {
                            const raw = formData.infoAtividades;
                            if (raw && raw.startsWith('[')) secCaes = JSON.parse(raw);
                            else if (raw) {
                              secCaes = raw.split('\n').filter(l => /secund/i.test(l))
                                .map(l => { const m = l.match(/:\s*(\d{5})\s*[—-]\s*(.*)/); return m ? { codigo: m[1], descricao: m[2].trim() } : null; })
                                .filter(Boolean) as {codigo: string; descricao: string}[];
                            }
                          } catch {}
                          const saveSecCaes = (next: {codigo: string; descricao: string}[]) =>
                            setFormData(p => ({ ...p, infoAtividades: JSON.stringify(next), caeSecundarios: next.map(c => c.codigo).join(', ') }));
                          return (
                            <div className="rounded-lg border border-slate-200 overflow-hidden">
                              {/* Cabeçalho tabela */}
                              <div className="grid bg-slate-800 text-white text-[10px] font-bold uppercase tracking-wide px-3 py-1.5" style={{gridTemplateColumns:'80px 72px 1fr 24px'}}>
                                <span>Tipo</span><span>Código</span><span>Descrição</span><span></span>
                              </div>
                              {/* CAE Principal */}
                              <div className="grid items-center gap-2 px-2 py-1.5 border-b border-slate-100 bg-emerald-50" style={{gridTemplateColumns:'80px 72px 1fr 24px'}}>
                                <span className="text-[10px] font-bold text-emerald-700">Principal</span>
                                <input type="text" placeholder="Código" className="rounded border border-slate-200 px-1.5 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-emerald-400 bg-white"
                                  value={formData.caePrincipal} onChange={e => setFormData(p => ({ ...p, caePrincipal: e.target.value }))} />
                                <input type="text" placeholder="Descrição" className="rounded border border-slate-200 px-1.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-400 bg-white"
                                  value={formData.caeDescricao} onChange={e => setFormData(p => ({ ...p, caeDescricao: e.target.value }))} />
                                <span></span>
                              </div>
                              {/* CAEs Secundários */}
                              {secCaes.map((cae, idx) => (
                                <div key={idx} className="grid items-center gap-2 px-2 py-1.5 border-b border-slate-100 hover:bg-slate-50" style={{gridTemplateColumns:'80px 72px 1fr 24px'}}>
                                  <span className="text-[10px] text-slate-500">Sec. {idx + 1}</span>
                                  <input type="text" placeholder="Código" className="rounded border border-slate-200 px-1.5 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-slate-400"
                                    value={cae.codigo} onChange={e => { const n=[...secCaes]; n[idx]={...n[idx],codigo:e.target.value}; saveSecCaes(n); }} />
                                  <input type="text" placeholder="Descrição" className="rounded border border-slate-200 px-1.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-slate-400"
                                    value={cae.descricao} onChange={e => { const n=[...secCaes]; n[idx]={...n[idx],descricao:e.target.value}; saveSecCaes(n); }} />
                                  <button type="button" className="text-slate-300 hover:text-red-400 text-base leading-none"
                                    onClick={() => saveSecCaes(secCaes.filter((_, i) => i !== idx))}>×</button>
                                </div>
                              ))}
                              {/* Linha adicionar */}
                              <div className="px-3 py-1.5">
                                <button type="button"
                                  className="text-xs font-medium text-slate-400 hover:text-emerald-600 transition-colors"
                                  onClick={() => saveSecCaes([...secCaes, { codigo: '', descricao: '' }])}>
                                  + Adicionar CAE secundário
                                </button>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                      <div className="md:col-span-4">
                        {/* Pasta de documentos — bloqueada por defeito, botão Editar para desbloquear */}
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="text-xs font-medium text-slate-500">Pasta de documentos (caminho)</label>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => { void openCustomerDocumentsFolder(); }}
                                disabled={!String(formData.documentsFolder || '').trim() || typeof window.waDesktop?.openFolder !== 'function'}
                                className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-500 transition-colors hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-40"
                                title={
                                  !String(formData.documentsFolder || '').trim()
                                    ? 'Pasta não definida'
                                    : typeof window.waDesktop?.openFolder === 'function'
                                      ? 'Abrir pasta no explorador'
                                      : 'Atualize o WA PRO desktop para ativar'
                                }
                              >
                                <FolderOpen size={12} /> Abrir pasta
                              </button>
                              <button type="button"
                                onClick={() => setFolderEditMode(m => !m)}
                                className={`text-xs font-semibold px-2 py-0.5 rounded transition-colors ${folderEditMode ? 'bg-amber-100 text-amber-700 hover:bg-amber-200' : 'text-slate-400 hover:text-slate-600 border border-slate-200 hover:border-slate-300'}`}>
                                {folderEditMode ? 'Bloquear' : '✎ Editar'}
                              </button>
                            </div>
                          </div>
                          <div className="relative">
                            <FolderOpen size={14} className="absolute left-3 top-2.5 text-slate-400" />
                            <input type="text"
                              readOnly={!folderEditMode}
                              className={`w-full rounded-lg border pl-9 pr-3 py-2 text-sm font-mono focus:outline-none ${folderEditMode ? 'border-amber-300 bg-white focus:ring-2 focus:ring-amber-200' : 'border-slate-200 bg-slate-50 text-slate-600 cursor-default select-all'}`}
                              value={formData.documentsFolder}
                              onChange={(e) => folderEditMode && setFormData({ ...formData, documentsFolder: e.target.value })}
                              placeholder="\\10.0.0.6\OneDrive - MPR\Documentos\Contabilidades\Empresas\Cliente" />
                          </div>
                          {!formData.documentsFolder && pickImportedValue(importedLookup, ['pasta_documentos', 'documents_folder']) && (
                            <p className="mt-1 text-xs text-blue-600 break-all">Pasta importada: {pickImportedValue(importedLookup, ['pasta_documentos', 'documents_folder'])}</p>
                          )}
                        </div>
                      </div>
                      <div className="md:col-span-4">
                        <label className="block text-xs font-medium text-slate-500 mb-1">Notas</label>
                        <textarea className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[80px] resize-y" placeholder="Notas internas do cliente..." value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} />
                      </div>
                    </div>
                  </section>

                  {/* ── Enquadramento Fiscal ──────────────────────── */}
                  <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                    <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-3.5">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100"><Shield size={14} className="text-emerald-600" /></span>
                      <h3 className="text-sm font-bold text-slate-800">Enquadramento Fiscal</h3>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-x-4 gap-y-3 px-5 py-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Tipo de entidade</label>
                        <select className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.type} onChange={(e) => setFormData({ ...formData, type: e.target.value as CustomerType })}>
                          {Object.values(CustomerType).map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Regime de IVA</label>
                        <select className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.tipoIva} onChange={(e) => setFormData({ ...formData, tipoIva: e.target.value })}>
                          <option value="">-- Selecionar --</option>
                          <option value="MENSAL">MENSAL</option>
                          <option value="TRIMESTRAL">TRIMESTRAL</option>
                          <option value="ANUAL">ANUAL</option>
                          <option value="ISENTO">ISENTO</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Tipo de contabilidade</label>
                        <select className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.tipoContabilidade} onChange={(e) => setFormData({ ...formData, tipoContabilidade: e.target.value })}>
                          <option value="">-- Selecionar --</option>
                          <option value="ORGANIZADA">ORGANIZADA</option>
                          <option value="SIMPLIFICADO">SIMPLIFICADA</option>
                          <option value="NAO_ORGANIZADA">NÃO ORGANIZADA</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Estado</label>
                        <select className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.estadoCliente} onChange={(e) => setFormData({ ...formData, estadoCliente: e.target.value })}>
                          <option value="">-- Selecionar --</option>
                          <option value="ACTIVA">ACTIVA</option>
                          <option value="SUSPENSA">SUSPENSA</option>
                          <option value="INATIVA">INATIVA</option>
                          <option value="ENCERRADA">ENCERRADA</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Responsável interno</label>
                        <select className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.ownerId} onChange={(e) => setFormData({ ...formData, ownerId: e.target.value })}>
                          <option value="">-- Selecionar --</option>
                          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Contabilista Certificado</label>
                        <input type="text" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" value={formData.contabilistaCertificado} onChange={(e) => setFormData({ ...formData, contabilistaCertificado: e.target.value })} />
                      </div>
                    </div>
                  </section>

                  {/* ── Gerência / Administração ──────────────────── */}
                  <section className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                    <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-100"><Users size={14} className="text-emerald-600" /></span>
                        <div>
                          <h3 className="text-sm font-bold text-slate-800">Gerência / Administração</h3>
                          <p className="text-[11px] text-slate-400">Adicionar gerentes com NIF, nome, email e telefone.</p>
                        </div>
                      </div>
                      <button type="button" onClick={addManager} className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-700">
                        <Plus size={13} /> Adicionar gerente
                      </button>
                    </div>
                    <div className="px-5 py-3">
                      {formData.managers.length > 0 && (
                        <div
                          className="mb-1 hidden min-w-[920px] grid-cols-[130px_minmax(260px,1.25fr)_minmax(220px,1fr)_150px_86px] gap-2 px-2 text-[10px] font-bold uppercase tracking-wide text-slate-400 lg:grid"
                        >
                          <span>NIF</span>
                          <span>Nome</span>
                          <span>Email</span>
                          <span>Telefone</span>
                          <span className="text-right">Ações</span>
                        </div>
                      )}
                      <div className="space-y-1.5 overflow-x-auto">
                      {formData.managers.map((manager, index) => (
                        <div
                          key={`manager-${index}`}
                          className="grid min-w-[920px] grid-cols-[130px_minmax(260px,1.25fr)_minmax(220px,1fr)_150px_86px] items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/60 px-2 py-1.5"
                        >
                          <input type="text" placeholder="NIF" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white" value={manager.nif || ''} onChange={(e) => updateManager(index, 'nif', e.target.value)} />
                          <input type="text" placeholder="Nome" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white" value={manager.name || ''} onChange={(e) => updateManager(index, 'name', e.target.value)} />
                          <input type="email" placeholder="Email" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white" value={manager.email || ''} onChange={(e) => updateManager(index, 'email', e.target.value)} />
                          <input type="text" placeholder="Telefone" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white" value={manager.phone || ''} onChange={(e) => updateManager(index, 'phone', e.target.value)} />
                          <button type="button" onClick={() => removeManager(index)} className="justify-self-end rounded-md px-2 py-1 text-xs font-semibold text-red-500 hover:bg-red-50 hover:text-red-700">Remover</button>
                        </div>
                      ))}
                      </div>
                      {formData.managers.length === 0 && (
                        <p className="text-xs text-slate-400 italic py-1">Sem gerentes definidos nesta ficha.</p>
                      )}
                    </div>
                  </section>

                  {/* ── Campos importados ─────────────────────────── */}
                  {editingCustomer && (
                    <details className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                      <summary className="cursor-pointer px-5 py-3.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors list-none flex items-center gap-2">
                        <span className="flex h-5 w-5 items-center justify-center rounded text-slate-400 text-xs">▶</span>
                        Campos importados do Supabase
                      </summary>
                      <div className="border-t border-slate-100 px-5 py-4">
                        {importedFields.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {importedFields.map((field) => (
                              <div key={field.label} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                                <div className="text-[10px] uppercase tracking-wider text-slate-400">{field.label}</div>
                                <div className="text-sm text-slate-700 break-words mt-0.5">{field.value}</div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-slate-400 italic">Sem campos extra importados para este cliente.</p>
                        )}
                      </div>
                    </details>
                  )}
                </div>
);
