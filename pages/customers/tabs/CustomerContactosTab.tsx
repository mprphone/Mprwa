import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { SubContact } from '../../../types';

// Separador "Contactos" do modal de cliente. Extraído de Customers.tsx sem
// alterar lógica: recebe os contactos e os handlers via props.
type Props = {
  contacts: SubContact[];
  onAdd: () => void;
  onUpdate: (index: number, field: keyof SubContact, value: string) => void;
  onRemove: (index: number) => void;
};

export const CustomerContactosTab: React.FC<Props> = ({ contacts, onAdd, onUpdate, onRemove }) => (
  <div className="border rounded-lg p-4 space-y-3">
    <div className="flex justify-between items-center mb-2">
      <div>
        <label className="block text-sm font-semibold text-gray-800">Contactos Associados</label>
        <p className="text-xs text-gray-500">Estes contactos podem existir só nesta aplicação (não precisam existir no Supabase).</p>
      </div>
      <button type="button" onClick={onAdd} className="text-xs text-whatsapp-600 font-medium hover:underline flex items-center gap-1">
        <Plus size={14} /> Adicionar Contacto
      </button>
    </div>

    <div className="space-y-2">
      {contacts.map((contact, idx) => (
        <div key={idx} className="flex gap-2 items-center">
          <input
            type="text"
            placeholder="Nome (ex: Secretaria)"
            className="flex-1 text-sm border rounded-md p-2"
            value={contact.name}
            onChange={(e) => onUpdate(idx, 'name', e.target.value)}
          />
          <input
            type="text"
            placeholder="Telefone"
            className="w-40 text-sm border rounded-md p-2"
            value={contact.phone}
            onChange={(e) => onUpdate(idx, 'phone', e.target.value)}
          />
          <button type="button" onClick={() => onRemove(idx)} className="text-gray-400 hover:text-red-500" title="Remover contacto">
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      {contacts.length === 0 && <p className="text-xs text-gray-400 italic">Nenhum contacto extra associado.</p>}
    </div>
  </div>
);
