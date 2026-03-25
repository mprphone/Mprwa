import React from 'react';

type CallLogModalProps = {
  show: boolean;
  callDuration: string;
  callNotes: string;
  onDurationChange: (value: string) => void;
  onNotesChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
};

const CallLogModal: React.FC<CallLogModalProps> = ({
  show,
  callDuration,
  callNotes,
  onDurationChange,
  onNotesChange,
  onClose,
  onSave,
}) => {
  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
      <div className="bg-white rounded-lg w-full max-w-sm p-6 shadow-xl">
        <h3 className="text-lg font-bold mb-4">Registar Chamada</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Duração (minutos)</label>
            <input
              type="number"
              value={callDuration}
              onChange={(event) => onDurationChange(event.target.value)}
              className="w-full border rounded-md p-2"
              placeholder="Ex: 5"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notas</label>
            <textarea
              value={callNotes}
              onChange={(event) => onNotesChange(event.target.value)}
              className="w-full border rounded-md p-2 h-24 resize-none"
              placeholder="Resumo da conversa..."
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-gray-600 text-sm">
              Cancelar
            </button>
            <button onClick={onSave} className="px-4 py-2 bg-whatsapp-600 text-white rounded-md text-sm">
              Guardar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CallLogModal;
