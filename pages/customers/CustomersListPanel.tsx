import React from 'react';
import { Edit2, Eye, RefreshCw, Search } from 'lucide-react';
import { Customer, CustomerType } from '../../types';
import { CustomerSortKey } from './customerFormState';
import { SegSocialSubUserState, getSegSocialSubUserState, resolveSsSubUserAccessFromCustomer } from './customerAccessUtils';

type UserOption = { id: string; name: string };

type CustomersListPanelProps = {
  customers: Customer[];
  users: UserOption[];
  searchTerm: string;
  stateFilter: string;
  typeFilter: string;
  ownerFilter: string;
  subUserFilter: 'TODOS' | SegSocialSubUserState;
  segSocialSubUserCounts: Record<SegSocialSubUserState, number>;
  autologinBusyCustomerId: string | null;
  segSocialAutologinBusyCustomerId: string | null;
  segSocialSubUserBusyCustomerId: string | null;
  segSocialActivationBusyCustomerId: string | null;
  setSearchTerm: (value: string) => void;
  setStateFilter: (value: string) => void;
  setTypeFilter: (value: string) => void;
  setOwnerFilter: (value: string) => void;
  setSubUserFilter: (value: 'TODOS' | SegSocialSubUserState) => void;
  toggleSort: (key: CustomerSortKey) => void;
  sortIndicator: (key: CustomerSortKey) => string;
  getCustomerStatus: (customer: Customer) => string;
  openCustomer: (customer: Customer) => void;
  triggerFinancasAutologin: (customer: Customer) => Promise<void> | void;
  triggerSegSocialSubUserLogin: (customer: Customer) => Promise<void> | void;
};

function getTypeColor(type: CustomerType) {
  switch (type) {
    case CustomerType.ENTERPRISE:
      return 'bg-blue-100 text-blue-800';
    case CustomerType.INDEPENDENT:
      return 'bg-gray-200 text-gray-700';
    case CustomerType.SPAM:
      return 'bg-red-100 text-red-800';
    case CustomerType.SUPPLIER:
      return 'bg-purple-100 text-purple-800';
    case CustomerType.PRIVATE:
      return 'bg-amber-100 text-amber-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'INATIVA' || status === 'ENCERRADA') {
    return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-100 text-red-700">{status}</span>;
  }
  if (status === 'SUSPENSA') {
    return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-700">{status}</span>;
  }
  return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-100 text-green-700">ATIVA</span>;
}

function SegSocialSubUserBadge({ state }: { state: SegSocialSubUserState }) {
  if (state === 'COM_SUBUTILIZADOR') {
    return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-700">Com sub</span>;
  }
  if (state === 'INCOMPLETO') {
    return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-700">Incompleto</span>;
  }
  return <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600">Sem sub</span>;
}

const actionButtonBaseClass =
  'inline-flex h-7 w-7 items-center justify-center rounded-md transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-1 disabled:opacity-35 disabled:cursor-not-allowed';
const actionButtonAutologinClass = `${actionButtonBaseClass} text-slate-400 hover:text-slate-700 hover:bg-slate-100`;
const actionButtonSsAutologinClass = `${actionButtonBaseClass} text-slate-400 hover:text-emerald-700 hover:bg-emerald-50`;
const actionButtonViewClass = `${actionButtonBaseClass} text-slate-300 hover:text-slate-600 hover:bg-slate-100`;
const actionButtonEditClass = `${actionButtonBaseClass} text-slate-300 hover:text-slate-600 hover:bg-slate-100`;

export function CustomersListPanel({
  customers,
  users,
  searchTerm,
  stateFilter,
  typeFilter,
  ownerFilter,
  subUserFilter,
  segSocialSubUserCounts,
  autologinBusyCustomerId,
  segSocialAutologinBusyCustomerId,
  segSocialSubUserBusyCustomerId,
  segSocialActivationBusyCustomerId,
  setSearchTerm,
  setStateFilter,
  setTypeFilter,
  setOwnerFilter,
  setSubUserFilter,
  toggleSort,
  sortIndicator,
  getCustomerStatus,
  openCustomer,
  triggerFinancasAutologin,
  triggerSegSocialSubUserLogin,
}: CustomersListPanelProps) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="p-3 border-b border-slate-200 grid grid-cols-1 md:grid-cols-5 gap-2">
        <div className="relative md:col-span-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Nome ou NIF..."
            className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-md bg-slate-50 text-sm"
          />
        </div>

        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className="w-full py-2 px-3 border border-slate-200 rounded-md bg-white text-sm">
          <option value="TODOS">Todos os estados</option>
          <option value="ATIVA">Ativa</option>
          <option value="SUSPENSA">Suspensa</option>
          <option value="INATIVA">Inativa</option>
          <option value="ENCERRADA">Encerrada</option>
        </select>

        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="w-full py-2 px-3 border border-slate-200 rounded-md bg-white text-sm">
          <option value="TODOS">Todos os tipos</option>
          {Object.values(CustomerType).map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>

        <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} className="w-full py-2 px-3 border border-slate-200 rounded-md bg-white text-sm">
          <option value="TODOS">Todos</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>{user.name}</option>
          ))}
        </select>

        <select value={subUserFilter} onChange={(e) => setSubUserFilter(e.target.value as 'TODOS' | SegSocialSubUserState)} className="w-full py-2 px-3 border border-slate-200 rounded-md bg-white text-sm">
          <option value="TODOS">Todos os subutilizadores</option>
          <option value="COM_SUBUTILIZADOR">Com subutilizador</option>
          <option value="SEM_SUBUTILIZADOR">Sem subutilizador</option>
          <option value="INCOMPLETO">Subutilizador incompleto</option>
        </select>
      </div>

      <div className="px-3 py-2 text-xs text-slate-500 border-b border-slate-100 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{customers.length} cliente(s)</span>
        <span className="text-emerald-700 font-semibold">{segSocialSubUserCounts.COM_SUBUTILIZADOR} com subutilizador</span>
        <span className="text-slate-500 font-semibold">{segSocialSubUserCounts.SEM_SUBUTILIZADOR} sem subutilizador</span>
        {segSocialSubUserCounts.INCOMPLETO > 0 && (
          <span className="text-amber-700 font-semibold">{segSocialSubUserCounts.INCOMPLETO} incompleto(s)</span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-[1220px] w-full table-fixed">
          <thead className="bg-slate-100/80">
            <tr>
              <th className="w-[8%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                <button type="button" onClick={() => toggleSort('nif')} className="inline-flex items-center gap-1 hover:text-slate-900">
                  NIF <span className="text-[10px]">{sortIndicator('nif')}</span>
                </button>
              </th>
              <th className="w-[24%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                <button type="button" onClick={() => toggleSort('name')} className="inline-flex items-center gap-1 hover:text-slate-900">
                  Nome <span className="text-[10px]">{sortIndicator('name')}</span>
                </button>
              </th>
              <th className="w-[9%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                <button type="button" onClick={() => toggleSort('type')} className="inline-flex items-center gap-1 hover:text-slate-900">
                  Tipo <span className="text-[10px]">{sortIndicator('type')}</span>
                </button>
              </th>
              <th className="w-[16%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                <button type="button" onClick={() => toggleSort('email')} className="inline-flex items-center gap-1 hover:text-slate-900">
                  Email <span className="text-[10px]">{sortIndicator('email')}</span>
                </button>
              </th>
              <th className="w-[11%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                <button type="button" onClick={() => toggleSort('phone')} className="inline-flex items-center gap-1 hover:text-slate-900">
                  Telefone <span className="text-[10px]">{sortIndicator('phone')}</span>
                </button>
              </th>
              <th className="w-[11%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                <button type="button" onClick={() => toggleSort('owner')} className="inline-flex items-center gap-1 hover:text-slate-900">
                  Resp. interno <span className="text-[10px]">{sortIndicator('owner')}</span>
                </button>
              </th>
              <th className="w-[8%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                <button type="button" onClick={() => toggleSort('status')} className="inline-flex items-center gap-1 hover:text-slate-900">
                  Estado <span className="text-[10px]">{sortIndicator('status')}</span>
                </button>
              </th>
              <th className="w-[9%] px-3 py-3 text-left text-[11px] uppercase text-slate-600 font-semibold">
                <button type="button" onClick={() => toggleSort('subuser')} className="inline-flex items-center gap-1 hover:text-slate-900">
                  Subutilizador <span className="text-[10px]">{sortIndicator('subuser')}</span>
                </button>
              </th>
              <th className="w-[6%] px-3 py-3 text-right text-[11px] uppercase text-slate-600 font-semibold">Ações</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => {
              const owner = users.find((u) => u.id === customer.ownerId);
              const status = getCustomerStatus(customer);
              const subUserState = getSegSocialSubUserState(customer);
              const ssSubUserAccess = resolveSsSubUserAccessFromCustomer(customer);
              const hasSsSubUserLogin = Boolean(String(ssSubUserAccess.username || '').trim());
              const isThisSsSubUserBusy = segSocialAutologinBusyCustomerId === customer.id;
              return (
                <tr key={customer.id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => openCustomer(customer)}>
                  <td className="px-3 py-3 text-xs font-mono text-slate-700">{customer.nif || '--'}</td>
                  <td className="px-3 py-3 text-sm text-slate-900">
                    <div className="font-semibold truncate" title={customer.company || customer.name}>{customer.company || customer.name}</div>
                    <div className="text-xs text-slate-500 truncate">{customer.name}</div>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`px-2 py-0.5 inline-flex text-[11px] font-semibold rounded-full ${getTypeColor(customer.type)}`}>
                      {customer.type.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-700 truncate" title={customer.email || '--'}>{customer.email || '--'}</td>
                  <td className="px-3 py-3 text-xs text-slate-700 font-mono">{customer.phone || '--'}</td>
                  <td className="px-3 py-3 text-xs text-slate-700">{owner?.name || '--'}</td>
                  <td className="px-3 py-3"><StatusBadge status={status} /></td>
                  <td className="px-3 py-3"><SegSocialSubUserBadge state={subUserState} /></td>
                  <td className="px-3 py-3">
                    <div className="flex justify-end items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => void triggerFinancasAutologin(customer)}
                        disabled={Boolean(autologinBusyCustomerId || segSocialAutologinBusyCustomerId || segSocialSubUserBusyCustomerId)}
                        className={actionButtonAutologinClass}
                        title="Autologin Portal das Finanças"
                      >
                        {autologinBusyCustomerId === customer.id
                          ? <RefreshCw size={11} className="animate-spin" />
                          : <span className="text-[10px] font-bold tracking-wide">AT</span>}
                      </button>
                      <button
                        onClick={() => void triggerSegSocialSubUserLogin(customer)}
                        disabled={Boolean(autologinBusyCustomerId || segSocialAutologinBusyCustomerId || segSocialSubUserBusyCustomerId || segSocialActivationBusyCustomerId || !hasSsSubUserLogin)}
                        className={actionButtonSsAutologinClass}
                        title={hasSsSubUserLogin ? 'Entrar na Segurança Social (subutilizador)' : 'Sem subutilizador SS configurado'}
                      >
                        {isThisSsSubUserBusy
                          ? <RefreshCw size={11} className="animate-spin" />
                          : <span className="text-[10px] font-bold tracking-wide">SS</span>}
                      </button>
                      <button onClick={() => openCustomer(customer)} className={actionButtonViewClass} title="Ver detalhes">
                        <Eye size={13} />
                      </button>
                      <button onClick={() => openCustomer(customer)} className={actionButtonEditClass} title="Editar cliente">
                        <Edit2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}

            {customers.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-sm text-slate-500">Nenhum cliente encontrado para os filtros atuais.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
