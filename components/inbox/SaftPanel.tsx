import React from 'react';

export type SaftDocumentType =
  | 'declaracao_nao_divida'
  | 'ies'
  | 'modelo_22'
  | 'certidao_permanente'
  | 'certificado_pme'
  | 'crc';

type SaftStatusMap = Record<string, { status: string; fileName?: string; error?: string; updatedAt?: string }>;

type SaftPanelProps = {
  saftLoadingType: string | null;
  saftJobByType: SaftStatusMap;
  saftFeedback: string;
  onRequest: (documentType: SaftDocumentType) => void;
  onSyncCompanyDocs?: () => void;
};

const ITEMS: Array<{ key: SaftDocumentType; label: string }> = [
  { key: 'declaracao_nao_divida', label: 'Declaração de Não Dívida' },
  { key: 'ies', label: 'IES' },
  { key: 'modelo_22', label: 'Modelo 22' },
  { key: 'certidao_permanente', label: 'Certidão Permanente' },
  { key: 'certificado_pme', label: 'Certificado PME' },
  { key: 'crc', label: 'CRC' },
];

const SaftPanel: React.FC<SaftPanelProps> = ({ saftLoadingType, saftJobByType, saftFeedback, onRequest, onSyncCompanyDocs }) => {
  const isSyncingCompanyDocs = saftLoadingType === 'sync_company_docs';
  return (
    <div className="mt-3 text-left bg-white p-3 rounded border border-gray-200">
      <p className="text-[11px] font-bold text-gray-500 uppercase mb-2">SAFT Online</p>
      {onSyncCompanyDocs && (
        <button
          type="button"
          onClick={onSyncCompanyDocs}
          disabled={!!saftLoadingType}
          className="mb-2 w-full rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-center text-[11px] text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
        >
          {isSyncingCompanyDocs ? 'Recolha Dossier em curso...' : 'Recolha Dossier (dados_empresa)'}
        </button>
      )}
      <div className="grid grid-cols-1 gap-1.5">
        {ITEMS.map((item) => {
          const jobStatus = saftJobByType[item.key]?.status;
          const isPending = jobStatus === 'pending' || jobStatus === 'processing';
          const isArchived = jobStatus === 'archived';
          const isSent = jobStatus === 'sent';
          const isError = jobStatus === 'error';
          const isMissing = jobStatus === 'missing';
          const isAvailable = isArchived || isSent;
          const buttonLabel =
            saftLoadingType === item.key
              ? 'Em recolha...'
              : isPending
                ? `${item.label} (Em recolha)`
                : isArchived
                  ? `${item.label} (Em arquivo)`
                : isSent
                  ? `${item.label} (Enviado)`
                  : isMissing
                    ? `${item.label} (Não existente)`
                  : isError
                    ? `${item.label} (Erro)`
                    : item.label;

          const buttonClassName = isAvailable
            ? 'text-[11px] text-left px-2 py-1.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50'
            : isMissing
              ? 'text-[11px] text-left px-2 py-1.5 rounded border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-50'
              : isError
                ? 'text-[11px] text-left px-2 py-1.5 rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-50'
              : 'text-[11px] text-left px-2 py-1.5 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-50';

          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onRequest(item.key)}
              disabled={!!saftLoadingType}
              className={buttonClassName}
            >
              {buttonLabel}
            </button>
          );
        })}
      </div>
      {saftFeedback && <p className="text-[10px] text-gray-600 mt-2">{saftFeedback}</p>}
    </div>
  );
};

export default SaftPanel;
