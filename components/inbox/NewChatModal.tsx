import React from 'react';
import { MessageSquarePlus, Search } from 'lucide-react';
import { Customer } from '../../types';

type NewChatModalProps = {
  show: boolean;
  search: string;
  results: Customer[];
  onSearchChange: (value: string) => void;
  onStart: (customerId: string) => void;
  onClose: () => void;
};

const NewChatModal: React.FC<NewChatModalProps> = ({
  show,
  search,
  results,
  onSearchChange,
  onStart,
  onClose,
}) => {
  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg w-full max-w-md p-6">
        <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
          <MessageSquarePlus className="text-whatsapp-600" />
          Iniciar Nova Conversa
        </h3>

        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
            <input
              type="text"
              autoFocus
              className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm"
              placeholder="Procurar cliente..."
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>
          <div className="h-64 overflow-y-auto border rounded-lg divide-y">
            {results.map((customer) => (
              <button
                key={customer.id}
                type="button"
                onClick={() => onStart(customer.id)}
                className="w-full text-left p-3 hover:bg-gray-50 flex justify-between items-center group"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">{customer.name}</p>
                  <p className="text-xs text-gray-500">{customer.company}</p>
                </div>
                <span className="text-xs text-gray-400 group-hover:text-whatsapp-600">{customer.phone}</span>
              </button>
            ))}
            {results.length === 0 && (
              <div className="p-4 text-center text-xs text-gray-400">
                Nenhum cliente encontrado. <br /> Adicione o cliente no menu "Clientes" primeiro.
              </div>
            )}
          </div>
          <div className="flex justify-end pt-2">
            <button onClick={onClose} className="px-4 py-2 text-gray-600 text-sm">
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NewChatModal;
