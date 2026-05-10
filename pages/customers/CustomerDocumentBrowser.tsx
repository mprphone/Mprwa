import React from 'react';
import { FileText, Folder, RefreshCw, Upload } from 'lucide-react';
import type { CustomerDocumentEntry } from './hooks/useCustomerDocuments';

type CustomerDocumentBrowserProps = {
  title: string;
  folderPath: string;
  fallbackFolderPath: string;
  currentPath: string;
  rootPathLabel: string;
  configured: boolean;
  loading: boolean;
  uploading: boolean;
  error: string | null;
  entries: CustomerDocumentEntry[];
  canGoUp: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  emptyFolderMessage?: string;
  itemKeyPrefix?: string;
  onRefresh: () => void;
  onGoUp: () => void;
  onTriggerUpload: () => void;
  onUpload: React.ChangeEventHandler<HTMLInputElement>;
  onOpenDirectory: (relativePath: string) => void;
  onOpenFile: (relativePath: string) => void;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function CustomerDocumentBrowser({
  title,
  folderPath,
  fallbackFolderPath,
  currentPath,
  rootPathLabel,
  configured,
  loading,
  uploading,
  error,
  entries,
  canGoUp,
  fileInputRef,
  emptyFolderMessage = 'Sem ficheiros/subpastas neste local.',
  itemKeyPrefix = 'document',
  onRefresh,
  onGoUp,
  onTriggerUpload,
  onUpload,
  onOpenDirectory,
  onOpenFile,
}: CustomerDocumentBrowserProps) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-gray-800">{title}</div>
          <div className="text-xs text-gray-500 break-all">{folderPath || fallbackFolderPath || 'Sem pasta definida na ficha do cliente.'}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            className="px-2 py-1 text-xs border rounded-md bg-white hover:bg-slate-50"
            title="Atualizar"
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            onClick={onGoUp}
            disabled={!canGoUp}
            className="px-2 py-1 text-xs border rounded-md bg-white hover:bg-slate-50 disabled:opacity-40"
            title="Subir pasta"
          >
            ..
          </button>
          <button
            type="button"
            onClick={onTriggerUpload}
            disabled={uploading}
            className="px-2 py-1 text-xs border rounded-md bg-whatsapp-50 text-whatsapp-700 hover:bg-whatsapp-100 disabled:opacity-40 inline-flex items-center gap-1"
            title="Adicionar ficheiro"
          >
            <Upload size={13} />
            {uploading ? 'A guardar...' : 'Adicionar'}
          </button>
        </div>
      </div>

      <div className="text-xs text-gray-500">
        Subpasta atual: <span className="font-mono">{currentPath || rootPathLabel}</span>
        {!configured && (
          <span className="ml-2 text-amber-600">Pasta automática ativa. Defina caminho específico na ficha para fixar.</span>
        )}
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}

      <div className="max-h-72 overflow-y-auto border rounded-md p-2 space-y-1 bg-slate-50">
        {loading && <div className="text-xs text-gray-500">A carregar documentos...</div>}
        {!loading && entries.length === 0 && <div className="text-xs text-gray-500">{emptyFolderMessage}</div>}

        {!loading && entries.map((entry) => (
          <button
            key={`${itemKeyPrefix}-${entry.relativePath}:${entry.type}`}
            type="button"
            onClick={() => {
              if (entry.type === 'directory') {
                onOpenDirectory(entry.relativePath);
                return;
              }
              onOpenFile(entry.relativePath);
            }}
            className="w-full text-left border border-slate-200 rounded-md px-2 py-1.5 bg-white hover:bg-slate-100 flex items-center justify-between gap-2"
          >
            <span className="inline-flex items-center gap-2 min-w-0">
              {entry.type === 'directory' ? <Folder size={14} className="text-amber-600 shrink-0" /> : <FileText size={14} className="text-blue-600 shrink-0" />}
              <span className="truncate text-sm text-slate-800">{entry.name}</span>
            </span>
            <span className="text-[11px] text-slate-500 shrink-0">
              {entry.type === 'directory' ? 'Pasta' : formatBytes(Number(entry.size || 0))}
            </span>
          </button>
        ))}
      </div>

      <p className="text-xs text-gray-400">
        Clique numa pasta para navegar e clique num ficheiro para abrir.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={onUpload}
      />
    </>
  );
}
