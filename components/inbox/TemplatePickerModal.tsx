import React from 'react';

type ManagedTemplate = {
  id: string;
  name: string;
  content: string;
};

type TemplatePickerModalProps = {
  show: boolean;
  selectedTemplateId: string;
  templates: ManagedTemplate[];
  onTemplateChange: (templateId: string) => void;
  onCancel: () => void;
  onContinue: () => void;
};

const TemplatePickerModal: React.FC<TemplatePickerModalProps> = ({
  show,
  selectedTemplateId,
  templates,
  onTemplateChange,
  onCancel,
  onContinue,
}) => {
  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg w-full max-w-lg p-6 shadow-xl">
        <h3 className="text-lg font-bold mb-4">Selecionar Template</h3>

        <div className="space-y-3">
          <select
            className="w-full border rounded-md p-2 text-sm"
            value={selectedTemplateId}
            onChange={(event) => onTemplateChange(event.target.value)}
          >
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>

          <div className="border rounded-lg bg-gray-50 p-3 text-sm text-gray-700 min-h-[90px]">
            {templates.find((item) => item.id === selectedTemplateId)?.content || 'Selecione um template.'}
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onCancel} className="px-4 py-2 text-gray-600 text-sm font-medium">
            Cancelar
          </button>
          <button
            onClick={onContinue}
            className="px-4 py-2 bg-amber-500 text-white rounded-md text-sm font-medium hover:bg-amber-600"
          >
            Continuar
          </button>
        </div>
      </div>
    </div>
  );
};

export default TemplatePickerModal;
