import React from 'react';
import { Link as LinkIcon, Search } from 'lucide-react';
import { CustomerType } from '../../types';

type SearchCustomer = {
  id: string;
  name: string;
  company: string;
};

type NewCustomerForm = {
  name: string;
  company: string;
  email: string;
  type: CustomerType;
};

type LinkCustomerModalProps = {
  show: boolean;
  linkTab: 'existing' | 'new';
  linkSearchTerm: string;
  searchResults: SearchCustomer[];
  newCustomerForm: NewCustomerForm;
  selectedCustomerPhone?: string;
  onClose: () => void;
  onTabChange: (tab: 'existing' | 'new') => void;
  onSearchTermChange: (value: string) => void;
  onLinkToExisting: (customerId: string) => void;
  onCreateAndLink: (event: React.FormEvent) => void;
  onNewCustomerFieldChange: (field: keyof NewCustomerForm, value: string) => void;
};

const LinkCustomerModal: React.FC<LinkCustomerModalProps> = ({
  show,
  linkTab,
  linkSearchTerm,
  searchResults,
  newCustomerForm,
  selectedCustomerPhone,
  onClose,
  onTabChange,
  onSearchTermChange,
  onLinkToExisting,
  onCreateAndLink,
  onNewCustomerFieldChange,
}) => {
  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg w-full max-w-md p-6">
        <h3 className="text-lg font-bold mb-4">Associar Cliente</h3>

        <div className="flex gap-2 mb-4 p-1 bg-gray-100 rounded-lg">
          <button
            onClick={() => onTabChange('existing')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${linkTab === 'existing' ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Existente
          </button>
          <button
            onClick={() => onTabChange('new')}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors ${linkTab === 'new' ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Criar Novo
          </button>
        </div>

        {linkTab === 'existing' ? (
          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
              <input
                type="text"
                autoFocus
                className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm"
                placeholder="Procurar nome ou empresa..."
                value={linkSearchTerm}
                onChange={(event) => onSearchTermChange(event.target.value)}
              />
            </div>
            <div className="h-48 overflow-y-auto border rounded-lg divide-y">
              {searchResults.map((customer) => (
                <button
                  key={customer.id}
                  onClick={() => onLinkToExisting(customer.id)}
                  className="w-full text-left p-3 hover:bg-gray-50 flex justify-between items-center group"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-900">{customer.name}</p>
                    <p className="text-xs text-gray-500">{customer.company}</p>
                  </div>
                  <LinkIcon size={16} className="text-gray-300 group-hover:text-whatsapp-600" />
                </button>
              ))}
              {searchResults.length === 0 && <div className="p-4 text-center text-xs text-gray-400">Nenhum cliente encontrado.</div>}
            </div>
          </div>
        ) : (
          <form onSubmit={onCreateAndLink} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Nome</label>
              <input
                required
                type="text"
                className="w-full border rounded-md p-2 text-sm"
                value={newCustomerForm.name}
                onChange={(event) => onNewCustomerFieldChange('name', event.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Empresa</label>
              <input
                required
                type="text"
                className="w-full border rounded-md p-2 text-sm"
                value={newCustomerForm.company}
                onChange={(event) => onNewCustomerFieldChange('company', event.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Tipo</label>
                <select
                  className="w-full border rounded-md p-2 text-sm"
                  value={newCustomerForm.type}
                  onChange={(event) => onNewCustomerFieldChange('type', event.target.value)}
                >
                  {Object.values(CustomerType).map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  className="w-full border rounded-md p-2 text-sm"
                  value={newCustomerForm.email}
                  onChange={(event) => onNewCustomerFieldChange('email', event.target.value)}
                />
              </div>
            </div>
            <div className="bg-gray-50 p-2 rounded text-xs text-gray-600 mb-2">
              <span className="font-bold">Telefone associado:</span> {selectedCustomerPhone}
            </div>
            <button type="submit" className="w-full bg-whatsapp-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-whatsapp-700">
              Criar e Associar
            </button>
          </form>
        )}

        <div className="mt-4 pt-2 border-t flex justify-center">
          <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-700">
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
};

export default LinkCustomerModal;
