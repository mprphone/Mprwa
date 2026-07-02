import React from 'react';
import { CustomerDocumentBrowser, type CustomerDocumentBrowserProps } from '../CustomerDocumentBrowser';
import { SOCIEDADE_BASE_PATH, SOCIEDADE_DOCUMENT_CATEGORIES } from '../customerHelpers';

// Separador "Sociedade" do modal de cliente. Extraído de Customers.tsx sem
// alterar lógica: escolhe a categoria e delega a listagem/upload ao
// CustomerDocumentBrowser (props reenviados em bloco via `browser`).
type Props = {
  customerId: string;
  categoryKey: string;
  onSelectCategory: (categoryKey: string) => void;
  browser: CustomerDocumentBrowserProps;
};

export const CustomerSociedadeTab: React.FC<Props> = ({ customerId, categoryKey, onSelectCategory, browser }) => (
  <div className="border rounded-lg p-4 space-y-3">
    {!customerId ? (
      <p className="text-sm text-gray-500">Guarde primeiro o cliente para ativar os documentos da sociedade.</p>
    ) : (
      <>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
          <div className="text-sm font-semibold text-slate-800">Documentos da Sociedade</div>
          <div className="text-xs text-slate-500">
            Guarda nesta vista os documentos societários, sempre dentro de <span className="font-mono">{SOCIEDADE_BASE_PATH}</span>.
          </div>
          <div className="flex flex-wrap gap-2">
            {SOCIEDADE_DOCUMENT_CATEGORIES.map((category) => {
              const isSelected = categoryKey === category.key;
              return (
                <button
                  key={category.key}
                  type="button"
                  onClick={() => onSelectCategory(category.key)}
                  className={`rounded-md border px-2.5 py-1 text-xs font-semibold transition ${
                    isSelected
                      ? 'border-blue-200 bg-white text-blue-700 shadow-sm'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {category.label}
                </button>
              );
            })}
          </div>
        </div>

        <CustomerDocumentBrowser {...browser} />
      </>
    )}
  </div>
);
