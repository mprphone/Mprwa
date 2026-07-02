import React from 'react';
import { Plus } from 'lucide-react';
import { Customer, CustomerHouseholdRelation, CustomerRelatedRecord } from '../../../types';
import { HOUSEHOLD_RELATION_OPTIONS, RELATED_RECORD_OPTIONS } from '../customerHelpers';

// Separador "Relações" do modal de cliente (agregado familiar + fichas
// relacionadas). Movido verbatim de Customers.tsx — recebe dados, estado de
// pesquisa e handlers via props (sem alterar lógica).
type Props = {
  agregadoFamiliar: CustomerHouseholdRelation[];
  fichasRelacionadas: CustomerRelatedRecord[];
  agregadoSearchTerms: Record<number, string>;
  fichasSearchTerms: Record<number, string>;
  setAgregadoSearchTerms: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  setFichasSearchTerms: React.Dispatch<React.SetStateAction<Record<number, string>>>;
  updateAgregadoFamiliar: (index: number, field: keyof CustomerHouseholdRelation, value: string) => void;
  updateFichaRelacionada: (index: number, field: keyof CustomerRelatedRecord, value: string) => void;
  removeAgregadoFamiliar: (index: number) => void;
  removeFichaRelacionada: (index: number) => void;
  addAgregadoFamiliar: () => void;
  addFichaRelacionada: () => void;
  resolveLinkedCustomerByEntry: (entry: Pick<CustomerHouseholdRelation, 'customerId' | 'customerSourceId'>) => Customer | null;
  buildEntryRelationLabel: (
    entry: Pick<CustomerHouseholdRelation, 'customerName' | 'customerCompany' | 'customerNif'>,
    resolved?: Customer | null,
  ) => string;
  filterRelationCustomers: (searchTermRaw: string) => Customer[];
  buildRelationCustomerLabel: (customer?: Customer | null) => string;
  openRelatedCustomerProfile: (customer: Customer | null) => void;
};

export const CustomerRelacoesTab: React.FC<Props> = ({
  agregadoFamiliar,
  fichasRelacionadas,
  agregadoSearchTerms,
  fichasSearchTerms,
  setAgregadoSearchTerms,
  setFichasSearchTerms,
  updateAgregadoFamiliar,
  updateFichaRelacionada,
  removeAgregadoFamiliar,
  removeFichaRelacionada,
  addAgregadoFamiliar,
  addFichaRelacionada,
  resolveLinkedCustomerByEntry,
  buildEntryRelationLabel,
  filterRelationCustomers,
  buildRelationCustomerLabel,
  openRelatedCustomerProfile,
}) => (
  <div className="space-y-4">
    <div className="rounded-lg border border-slate-200 p-4 space-y-3 bg-white">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">Agregado Familiar</h3>
        <p className="text-xs text-gray-500">
          Relacione esta ficha com cônjuge, filho ou outro elemento do agregado.
        </p>
      </div>

      <div className="space-y-2">
        {agregadoFamiliar.map((entry, index) => {
          const resolved = resolveLinkedCustomerByEntry(entry);
          const baseLabel = buildEntryRelationLabel(entry, resolved);
          const hasTypedValue = Object.prototype.hasOwnProperty.call(agregadoSearchTerms, index);
          const typedValue = hasTypedValue ? String(agregadoSearchTerms[index] || '') : '';
          const searchValue = hasTypedValue ? typedValue : baseLabel;
          const suggestions = hasTypedValue && typedValue.trim().length > 0
            ? filterRelationCustomers(typedValue)
            : [];
          return (
            <div key={`agregado-${index}`} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center border rounded-md p-2 bg-slate-50">
              <div className="md:col-span-5 space-y-1">
                <input
                  type="text"
                  className="w-full text-sm border rounded-md p-2 bg-white"
                  placeholder="Escreva para sugerir ficha..."
                  value={searchValue}
                  onChange={(e) => {
                    const nextValue = String(e.target.value || '');
                    setAgregadoSearchTerms((prev) => ({ ...prev, [index]: nextValue }));
                    if (!nextValue.trim()) {
                      updateAgregadoFamiliar(index, 'customerId', '');
                    }
                  }}
                  onBlur={() => {
                    window.setTimeout(() => {
                      setAgregadoSearchTerms((prev) => {
                        const next = { ...prev };
                        delete next[index];
                        return next;
                      });
                    }, 120);
                  }}
                />
                {hasTypedValue && typedValue.trim().length > 0 && suggestions.length > 0 && (
                  <div className="max-h-40 overflow-auto rounded-md border border-slate-200 bg-white shadow-sm">
                    {suggestions.map((customer) => (
                      <button
                        key={`agf-suggestion-${index}-${customer.id}`}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          updateAgregadoFamiliar(index, 'customerId', customer.id);
                          setAgregadoSearchTerms((prev) => {
                            const next = { ...prev };
                            delete next[index];
                            return next;
                          });
                        }}
                        className="w-full text-left px-2 py-1.5 text-xs hover:bg-slate-100"
                      >
                        {buildRelationCustomerLabel(customer)}
                      </button>
                    ))}
                  </div>
                )}
                {resolved && (
                  <button
                    type="button"
                    onClick={() => openRelatedCustomerProfile(resolved)}
                    className="text-xs text-blue-700 hover:underline"
                  >
                    {buildRelationCustomerLabel(resolved)}
                  </button>
                )}
              </div>
              <select
                className="md:col-span-2 text-sm border rounded-md p-2 bg-white"
                value={entry.relationType || 'outro'}
                onChange={(e) => updateAgregadoFamiliar(index, 'relationType', e.target.value)}
              >
                {HOUSEHOLD_RELATION_OPTIONS.map((option) => (
                  <option key={`agf-rel-${option.value}`} value={option.value}>{option.label}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Nota (opcional)"
                className="md:col-span-4 text-sm border rounded-md p-2"
                value={entry.note || ''}
                onChange={(e) => updateAgregadoFamiliar(index, 'note', e.target.value)}
              />
              <button
                type="button"
                onClick={() => removeAgregadoFamiliar(index)}
                className="md:col-span-1 text-red-600 text-xs hover:underline justify-self-start md:justify-self-end"
              >
                Remover
              </button>
            </div>
          );
        })}
        {agregadoFamiliar.length === 0 && <p className="text-xs text-gray-400 italic">Sem relações de agregado familiar definidas.</p>}
        <button
          type="button"
          onClick={addAgregadoFamiliar}
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center gap-1"
        >
          <Plus size={14} /> Adicionar linha
        </button>
      </div>
    </div>

    <div className="rounded-lg border border-slate-200 p-4 space-y-3 bg-white">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">Fichas Relacionadas</h3>
        <p className="text-xs text-gray-500">
          Relacione com funcionário, amigo, familiar, gerente, sócio ou outro.
        </p>
      </div>

      <div className="space-y-2">
        {fichasRelacionadas.length > 0 && (
          <div className="hidden md:grid grid-cols-12 gap-2 px-1 text-xs font-semibold text-slate-600">
            <div className="col-span-5">Ficha relacionada</div>
            <div className="col-span-2">Tipo de relação</div>
            <div className="col-span-4">Nota</div>
            <div className="col-span-1" />
          </div>
        )}
        {fichasRelacionadas.map((entry, index) => {
          const resolved = resolveLinkedCustomerByEntry(entry);
          const baseLabel = buildEntryRelationLabel(entry, resolved);
          const hasTypedValue = Object.prototype.hasOwnProperty.call(fichasSearchTerms, index);
          const typedValue = hasTypedValue ? String(fichasSearchTerms[index] || '') : '';
          const searchValue = hasTypedValue ? typedValue : baseLabel;
          const suggestions = hasTypedValue && typedValue.trim().length > 0
            ? filterRelationCustomers(typedValue)
            : [];
          return (
            <div key={`relacionada-${index}`} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-center border rounded-md p-2 bg-slate-50">
              <div className="md:col-span-5 space-y-1">
                <input
                  type="text"
                  className="w-full text-sm border rounded-md p-2 bg-white"
                  placeholder="Escreva para sugerir ficha..."
                  value={searchValue}
                  onChange={(e) => {
                    const nextValue = String(e.target.value || '');
                    setFichasSearchTerms((prev) => ({ ...prev, [index]: nextValue }));
                    if (!nextValue.trim()) {
                      updateFichaRelacionada(index, 'customerId', '');
                    }
                  }}
                  onBlur={() => {
                    window.setTimeout(() => {
                      setFichasSearchTerms((prev) => {
                        const next = { ...prev };
                        delete next[index];
                        return next;
                      });
                    }, 120);
                  }}
                />
                {hasTypedValue && typedValue.trim().length > 0 && suggestions.length > 0 && (
                  <div className="max-h-40 overflow-auto rounded-md border border-slate-200 bg-white shadow-sm">
                    {suggestions.map((customer) => (
                      <button
                        key={`rel-suggestion-${index}-${customer.id}`}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          updateFichaRelacionada(index, 'customerId', customer.id);
                          setFichasSearchTerms((prev) => {
                            const next = { ...prev };
                            delete next[index];
                            return next;
                          });
                        }}
                        className="w-full text-left px-2 py-1.5 text-xs hover:bg-slate-100"
                      >
                        {buildRelationCustomerLabel(customer)}
                      </button>
                    ))}
                  </div>
                )}
                {resolved && (
                  <button
                    type="button"
                    onClick={() => openRelatedCustomerProfile(resolved)}
                    className="text-xs text-blue-700 hover:underline"
                  >
                    {buildRelationCustomerLabel(resolved)}
                  </button>
                )}
              </div>
              <select
                className="md:col-span-2 text-sm border rounded-md p-2 bg-white"
                value={entry.relationType || 'outro'}
                onChange={(e) => updateFichaRelacionada(index, 'relationType', e.target.value)}
              >
                {RELATED_RECORD_OPTIONS.map((option) => (
                  <option key={`rel-type-${option.value}`} value={option.value}>{option.label}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Nota (opcional)"
                className="md:col-span-4 text-sm border rounded-md p-2"
                value={entry.note || ''}
                onChange={(e) => updateFichaRelacionada(index, 'note', e.target.value)}
              />
              <button
                type="button"
                onClick={() => removeFichaRelacionada(index)}
                className="md:col-span-1 text-red-600 text-xs hover:underline justify-self-start md:justify-self-end"
              >
                Remover
              </button>
            </div>
          );
        })}
        {fichasRelacionadas.length === 0 && <p className="text-xs text-gray-400 italic">Sem fichas relacionadas definidas.</p>}
        <button
          type="button"
          onClick={addFichaRelacionada}
          className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 inline-flex items-center justify-center gap-1"
        >
          <Plus size={14} /> Adicionar linha
        </button>
      </div>
    </div>
  </div>
);
