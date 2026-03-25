import React from 'react';
import { AlertTriangle, Check } from 'lucide-react';

type ManagedTemplate = {
  id: string;
  name: string;
};

type TemplateConfirmModalProps = {
  show: boolean;
  selectedTemplateId: string;
  templates: ManagedTemplate[];
  onCancel: () => void;
  onConfirm: () => void;
};

const TemplateConfirmModal: React.FC<TemplateConfirmModalProps> = ({
  show,
  selectedTemplateId,
  templates,
  onCancel,
  onConfirm,
}) => {
  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg w-full max-w-md p-6 shadow-xl border-l-8 border-red-500">
        <div className="flex items-start gap-4 mb-4">
          <div className="bg-red-100 p-3 rounded-full text-red-600 shrink-0">
            <AlertTriangle size={28} />
          </div>
          <div>
            <h3 className="text-xl font-bold text-gray-900">Confirmar Custo de Envio</h3>
            <p className="text-sm text-gray-600 mt-2 leading-relaxed">
              Atenção: A janela de 24h está <strong>FECHADA</strong> ou é uma nova conversa. O envio desta
              mensagem terá um custo cobrado pelo WhatsApp (Meta).
            </p>
            <div className="mt-3 bg-red-50 p-2 rounded border border-red-100 text-xs font-mono text-red-800">
              {selectedTemplateId && (
                <>
                  Template: {templates.find((item) => item.id === selectedTemplateId)?.name || selectedTemplateId}
                  <br />
                </>
              )}
              Categoria: MARKETING/UTILIDADE <br />
              Custo Estimado: € 0.05 - € 0.08
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6 border-t pt-4">
          <button onClick={onCancel} className="px-4 py-2 text-gray-600 text-sm font-medium hover:bg-gray-100 rounded-md">
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="px-6 py-2 bg-red-600 text-white rounded-md text-sm font-bold hover:bg-red-700 shadow-sm flex items-center gap-2"
          >
            <Check size={16} /> Aceitar Custo e Enviar
          </button>
        </div>
      </div>
    </div>
  );
};

export default TemplateConfirmModal;
