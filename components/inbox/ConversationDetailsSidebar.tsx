import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  FolderOpen,
  Hash,
  Phone,
  RefreshCw,
  Save,
  Shield,
  Trash2,
  UserPlus,
  Zap,
  ZapOff,
} from 'lucide-react';
import { Customer, Task, TaskAttachment, TaskPriority, User as UserType } from '../../types';
import type { OccurrenceRow } from '../../services/occurrencesApi';
import SaftPanel, { SaftDocumentType } from './SaftPanel';
import TasksPanel from './TasksPanel';

type CustomerDocument = {
  type: 'file' | 'directory';
  name: string;
  relativePath: string;
  size?: number;
  updatedAt: string;
};

type SaftJobState = Record<string, { status: string; fileName?: string; error?: string; updatedAt?: string }>;
type WhatsAppAccountOption = {
  accountId: string;
  label?: string;
  isDefault?: boolean;
  connected?: boolean;
  status?: string;
};

// Mantemos desativado por padrão para experiência "multiconta unificada":
// a equipa responde normalmente e o backend escolhe a melhor linha disponível.
const ENABLE_MANUAL_WHATSAPP_LINE_SELECTOR = false;

const normalizePhoneDigits = (value?: string | null) => String(value || '').replace(/\D/g, '');
const looksLikePhoneLabel = (value?: string | null) => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^\+?\d[\d\s-]{5,}$/.test(raw)) return true;
  const digits = normalizePhoneDigits(raw);
  return digits.length >= 7 && digits.length >= Math.max(7, raw.length - 3);
};

type ConversationDetailsSidebarProps = {
  selectedCustomer: Customer | null;
  conversationDisplayName?: string | null;
  customerOwner: UserType | null;
  isUnknownCustomer: boolean;
  isTelegramConversation?: boolean;
  conversationChannel?: 'whatsapp' | 'telegram';
  isContactBlocked?: boolean;
  blockedReason?: string | null;
  customerDocuments: CustomerDocument[];
  customerDocumentsPath: string;
  customerDocumentsCurrentPath: string;
  canGoUpDocumentsPath: boolean;
  customerDocsConfigured: boolean;
  isDocumentsLoading: boolean;
  isUploadingDocument: boolean;
  docsError: string | null;
  saftLoadingType: string | null;
  saftFeedback: string;
  saftJobByType: SaftJobState;
  onOpenLinkModal: () => void;
  onOpenCustomerProfile: () => void;
  whatsAppAccounts?: WhatsAppAccountOption[];
  selectedWhatsAppAccountId?: string | null;
  onSelectWhatsAppAccount?: (accountId: string) => void;
  isUpdatingWhatsAppAccount?: boolean;
  onTriggerFinancasAutologin?: () => void;
  isFinancasAutologinBusy?: boolean;
  onTriggerSegSocialAutologin?: () => void;
  isSegSocialAutologinBusy?: boolean;
  onSaveCustomerNotes: (notes: string) => Promise<void> | void;
  onOpenCallModal: () => void;
  onRequestTelegramContact?: () => void;
  onBlockContact?: () => void;
  onUnblockContact?: () => void;
  isContactBlockBusy?: boolean;
  onDeleteConversation?: () => void;
  isDeletingConversation?: boolean;
  onRefreshDocuments: () => void;
  onOpenDocumentsFolder: (relativePath: string) => void;
  onGoUpDocumentsFolder: () => void;
  onUploadFileToCurrentFolder: (file: File) => void;
  onDropMessageToCurrentFolder: (messageBody: string) => void | Promise<void>;
  onChooseCustomerFolder: () => void;
  onTriggerDocumentPicker: () => void;
  onDownloadDocument: (relativePath: string) => void;
  onSaftRequest: (documentType: SaftDocumentType) => void;
  onSyncCompanyDocs: () => void;
  formatBytes: (value: number) => string;
  users: UserType[];
  tasks: Task[];
  showTaskForm: boolean;
  newTaskTitle: string;
  newTaskAssignee: string;
  newTaskPriority: TaskPriority;
  newTaskAttachments: TaskAttachment[];
  duplicateWarning: string | null;
  onToggleTaskForm: () => void;
  onCreateTask: (event: React.FormEvent) => void;
  onCancelTaskForm: () => void;
  onTaskTitleChange: (value: string) => void;
  onTaskAssigneeChange: (value: string) => void;
  onTaskPriorityChange: (value: TaskPriority) => void;
  onTaskAttachmentsSelected: (files: FileList | null) => void;
  onRemoveTaskAttachment: (attachmentId: string) => void;
  onToggleTaskStatus: (task: Task) => void;
  openOccurrences: OccurrenceRow[];
  openOccurrencesLoading: boolean;
  openOccurrencesError: string | null;
};

const ConversationDetailsSidebar: React.FC<ConversationDetailsSidebarProps> = ({
  selectedCustomer,
  conversationDisplayName,
  customerOwner,
  isUnknownCustomer,
  isTelegramConversation = false,
  conversationChannel = 'whatsapp',
  isContactBlocked = false,
  blockedReason = null,
  customerDocuments,
  customerDocumentsPath,
  customerDocumentsCurrentPath,
  canGoUpDocumentsPath,
  customerDocsConfigured,
  isDocumentsLoading,
  isUploadingDocument,
  docsError,
  saftLoadingType,
  saftFeedback,
  saftJobByType,
  onOpenLinkModal,
  onOpenCustomerProfile,
  whatsAppAccounts = [],
  selectedWhatsAppAccountId = null,
  onSelectWhatsAppAccount,
  isUpdatingWhatsAppAccount = false,
  onTriggerFinancasAutologin,
  isFinancasAutologinBusy = false,
  onTriggerSegSocialAutologin,
  isSegSocialAutologinBusy = false,
  onSaveCustomerNotes,
  onOpenCallModal,
  onRequestTelegramContact,
  onBlockContact,
  onUnblockContact,
  isContactBlockBusy = false,
  onDeleteConversation,
  isDeletingConversation = false,
  onRefreshDocuments,
  onOpenDocumentsFolder,
  onGoUpDocumentsFolder,
  onUploadFileToCurrentFolder,
  onDropMessageToCurrentFolder,
  onChooseCustomerFolder,
  onTriggerDocumentPicker,
  onDownloadDocument,
  onSaftRequest,
  onSyncCompanyDocs,
  formatBytes,
  users,
  tasks,
  showTaskForm,
  newTaskTitle,
  newTaskAssignee,
  newTaskPriority,
  newTaskAttachments,
  duplicateWarning,
  onToggleTaskForm,
  onCreateTask,
  onCancelTaskForm,
  onTaskTitleChange,
  onTaskAssigneeChange,
  onTaskPriorityChange,
  onTaskAttachmentsSelected,
  onRemoveTaskAttachment,
  onToggleTaskStatus,
  openOccurrences,
  openOccurrencesLoading,
  openOccurrencesError,
}) => {
  const [isDocumentsExpanded, setIsDocumentsExpanded] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [isSavingNotes, setIsSavingNotes] = useState(false);
  const [notesFeedback, setNotesFeedback] = useState<string | null>(null);

  useEffect(() => {
    setIsDocumentsExpanded(false);
    setNotesDraft(String(selectedCustomer?.notes || ''));
    setNotesFeedback(null);
  }, [selectedCustomer?.id, selectedCustomer?.notes]);

  const managerName = useMemo(() => {
    const manager = Array.isArray(selectedCustomer?.managers)
      ? selectedCustomer.managers.find((item) => String(item?.name || '').trim())
      : null;
    if (manager?.name) return manager.name;
    if (customerOwner?.name) return customerOwner.name;
    return '—';
  }, [selectedCustomer?.managers, customerOwner?.name]);

  const isTelegramCustomer = useMemo(() => {
    const company = String(selectedCustomer?.company || '').trim().toLowerCase();
    if (company === 'telegram') return true;
    const name = String(selectedCustomer?.name || '').trim().toLowerCase();
    return name.startsWith('telegram ');
  }, [selectedCustomer?.company, selectedCustomer?.name]);

  const primaryContactValue = useMemo(() => {
    const raw = String(selectedCustomer?.phone || '').trim();
    if (!raw) return '';
    return isTelegramCustomer ? raw.replace(/^\+/, '') : raw;
  }, [isTelegramCustomer, selectedCustomer?.phone]);

  const normalizedConversationChannel = conversationChannel === 'telegram' ? 'telegram' : 'whatsapp';
  const showTelegramActions = isTelegramConversation || isTelegramCustomer || normalizedConversationChannel === 'telegram';
  const accountOptions = useMemo(() => {
    return (Array.isArray(whatsAppAccounts) ? whatsAppAccounts : [])
      .map((item) => ({
        accountId: String(item.accountId || '').trim(),
        label: String(item.label || item.accountId || '').trim(),
        connected: item.connected === true,
        isDefault: item.isDefault === true,
        status: String(item.status || '').trim(),
      }))
      .filter((item) => item.accountId);
  }, [whatsAppAccounts]);
  const showWhatsAppAccountSelector =
    ENABLE_MANUAL_WHATSAPP_LINE_SELECTOR &&
    !showTelegramActions &&
    accountOptions.length > 1 &&
    typeof onSelectWhatsAppAccount === 'function';
  const effectiveSelectedAccountId =
    String(selectedWhatsAppAccountId || '').trim() ||
    String(accountOptions.find((item) => item.isDefault)?.accountId || '').trim() ||
    String(accountOptions[0]?.accountId || '').trim() ||
    '';

  const customerDisplayName = useMemo(() => {
    const preferredConversationLabel = String(conversationDisplayName || '').trim();
    if (preferredConversationLabel && !looksLikePhoneLabel(preferredConversationLabel)) {
      return preferredConversationLabel;
    }
    const contactName = String(selectedCustomer?.contactName || '').trim();
    const company = String(selectedCustomer?.company || '').trim();
    const name = String(selectedCustomer?.name || '').trim();
    const phone = String(selectedCustomer?.phone || '').trim();
    const hasCompany = company && !looksLikePhoneLabel(company);
    const hasName = name && !looksLikePhoneLabel(name);
    const hasContactName = contactName && !looksLikePhoneLabel(contactName);
    if (hasContactName && hasCompany && contactName.toLowerCase() !== company.toLowerCase()) return `${contactName} - ${company}`;
    if (hasName && hasCompany && name.toLowerCase() !== company.toLowerCase()) return `${name} - ${company}`;
    if (hasContactName) return contactName;
    if (hasName) return name;
    if (hasCompany) return company;
    if (phone) return phone;
    return contactName || name || company || 'Cliente';
  }, [conversationDisplayName, selectedCustomer?.contactName, selectedCustomer?.company, selectedCustomer?.name, selectedCustomer?.phone]);

  const handleSaveNotes = async () => {
    if (!selectedCustomer?.id || isSavingNotes) return;
    setIsSavingNotes(true);
    setNotesFeedback(null);
    try {
      await onSaveCustomerNotes(notesDraft);
      setNotesFeedback('Notas guardadas.');
    } catch (error) {
      setNotesFeedback(error instanceof Error ? error.message : 'Falha ao guardar notas.');
    } finally {
      setIsSavingNotes(false);
    }
  };

  const handleDocsDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.files || []);
    const messageBody = event.dataTransfer.getData('application/x-wa-message-body');
    if (messageBody) {
      onDropMessageToCurrentFolder(messageBody);
      return;
    }
    if (files.length === 0) return;
    const first = files[0];
    if (first) onUploadFileToCurrentFolder(first);
  };

  return (
    <div className="w-[28rem] bg-white border-l border-gray-200 hidden lg:flex flex-col overflow-y-auto">
      <div className="p-4 border-b border-gray-100 bg-gray-50">
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {showWhatsAppAccountSelector && (
            <div className="mr-auto min-w-[180px]">
              <label className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-gray-500">
                Linha WhatsApp
              </label>
              <select
                value={effectiveSelectedAccountId}
                onChange={(event) => {
                  const nextAccountId = String(event.target.value || '').trim();
                  if (!nextAccountId || !onSelectWhatsAppAccount) return;
                  onSelectWhatsAppAccount(nextAccountId);
                }}
                disabled={isUpdatingWhatsAppAccount}
                className="w-full rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-800 focus:outline-none focus:ring-2 focus:ring-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {accountOptions.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.label || account.accountId}
                    {account.connected ? ' · ligado' : ' · desligado'}
                    {account.isDefault ? ' · padrão' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={onOpenCustomerProfile}
              disabled={!selectedCustomer?.id}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Abrir ficha do cliente"
            >
              <ExternalLink size={12} />
              Ver perfil
            </button>
            <button
              onClick={onTriggerFinancasAutologin}
              disabled={!selectedCustomer?.id || isFinancasAutologinBusy || isSegSocialAutologinBusy}
              className="inline-flex items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-700 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
              title="Login automático Portal das Finanças"
              aria-label="Login automático Portal das Finanças"
            >
              <Shield size={12} />
              {isFinancasAutologinBusy ? 'A abrir...' : 'AT Login'}
            </button>
            <button
              onClick={onTriggerSegSocialAutologin}
              disabled={!selectedCustomer?.id || isSegSocialAutologinBusy || isFinancasAutologinBusy}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
              title="Login automático Segurança Social Direta"
              aria-label="Login automático Segurança Social Direta"
            >
              <Shield size={12} />
              {isSegSocialAutologinBusy ? 'A abrir...' : 'SS Login'}
            </button>
            <button
              onClick={onOpenLinkModal}
              title="Associar a outro Cliente ou Novo"
              className="p-1.5 text-whatsapp-600 hover:bg-whatsapp-50 rounded-full transition-colors"
            >
              <UserPlus size={16} />
            </button>
            {isContactBlocked ? (
              <button
                onClick={onUnblockContact}
                disabled={isContactBlockBusy}
                className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                title="Desbloquear contacto"
              >
                <Ban size={12} />
                {isContactBlockBusy ? 'A desbloquear...' : 'Desbloquear'}
              </button>
            ) : (
              <button
                onClick={onBlockContact}
                disabled={isContactBlockBusy}
                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                title="Bloquear contacto"
              >
                <Ban size={12} />
                {isContactBlockBusy ? 'A bloquear...' : 'Bloquear'}
              </button>
            )}
            <button
              onClick={onDeleteConversation}
              disabled={!selectedCustomer?.id || isDeletingConversation}
              className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
              title="Eliminar conversa"
            >
              <Trash2 size={12} />
              {isDeletingConversation ? 'A eliminar...' : 'Eliminar conversa'}
            </button>
          </div>
        </div>

        <div className="mt-2">
          <h2 className="text-lg font-bold leading-tight text-gray-900 break-words">
            {customerDisplayName}
          </h2>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs px-2 py-0.5 bg-whatsapp-100 text-whatsapp-800 rounded-full border border-whatsapp-200">
            {selectedCustomer?.type || 'Sem Tipo'}
          </span>
          <span
            className={`text-xs px-2 py-0.5 rounded-full border ${
              normalizedConversationChannel === 'telegram'
                ? 'border-sky-200 bg-sky-50 text-sky-700'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
            }`}
            title="Origem da conversa"
          >
            {normalizedConversationChannel === 'telegram' ? 'Telegram' : 'WhatsApp'}
          </span>
          <span className="text-xs text-gray-500 font-mono flex items-center gap-1">
            {isTelegramCustomer ? <Hash size={12} /> : <Phone size={12} />}
            {primaryContactValue || (isTelegramCustomer ? 'Sem ID Telegram' : 'Sem telefone')}
          </span>
        </div>
        {isContactBlocked && (
          <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
            Contacto bloqueado para novas mensagens recebidas e enviadas.
            {blockedReason ? ` Motivo: ${blockedReason}` : ''}
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-gray-600">
          <p>
            <span className="font-semibold text-gray-700">NIF:</span> {selectedCustomer?.nif || '—'}
          </p>
          <p>
            <span className="font-semibold text-gray-700">NISS:</span> {selectedCustomer?.niss || '—'}
          </p>
          <p className="col-span-2">
            <span className="font-semibold text-gray-700">Gerente:</span> {managerName}
          </p>
        </div>

        <div className="mt-3 bg-white rounded border border-gray-200 p-2">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <p className="text-[11px] font-bold text-gray-600 uppercase">Notas</p>
            <button
              onClick={() => {
                void handleSaveNotes();
              }}
              disabled={isSavingNotes || !selectedCustomer?.id}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-white bg-whatsapp-600 rounded hover:bg-whatsapp-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save size={11} />
              {isSavingNotes ? 'A guardar...' : 'Guardar'}
            </button>
          </div>
          <textarea
            rows={3}
            value={notesDraft}
            onChange={(event) => {
              setNotesDraft(event.target.value);
              if (notesFeedback) setNotesFeedback(null);
            }}
            placeholder="Adicionar notas do cliente..."
            className="w-full rounded border border-gray-200 px-2 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-whatsapp-400"
          />
          {notesFeedback && <p className="mt-1 text-[11px] text-gray-500">{notesFeedback}</p>}
        </div>

        <div className="mt-3">
          <button
            onClick={() => setIsDocumentsExpanded((previous) => !previous)}
            className="w-full flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-100/80 px-3 py-2.5 text-sm font-semibold text-amber-900 shadow-sm transition hover:bg-amber-100"
          >
            <span className="min-w-0 text-left">
              <span className="inline-flex items-center gap-2">
                <FolderOpen size={14} />
                Documentos do cliente
              </span>
              <span className="block text-[11px] font-medium text-amber-800/90">
                {isDocumentsExpanded ? 'Clique para recolher' : 'Clique para expandir'}
              </span>
            </span>
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-amber-300 bg-amber-50">
              {isDocumentsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          </button>
        </div>

        {isDocumentsExpanded && (
          <div
            className="mt-2 rounded border border-amber-200 bg-amber-50/40 p-3 text-left"
            onDragOver={(event) => {
              event.preventDefault();
            }}
            onDrop={handleDocsDrop}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-[11px] font-bold text-gray-500 uppercase flex items-center gap-1">
                <FolderOpen size={12} />
                Documentos do Cliente
              </p>
              <div className="flex items-center gap-1">
                <button onClick={onRefreshDocuments} className="p-1 text-gray-500 hover:text-gray-700" title="Atualizar lista">
                  <RefreshCw size={13} />
                </button>
                <button
                  onClick={onChooseCustomerFolder}
                  disabled={!selectedCustomer?.id}
                  className="px-2 py-1 text-[10px] bg-gray-100 border border-gray-200 rounded hover:bg-gray-200 disabled:opacity-40"
                  title="Definir pasta base deste cliente no seu PC"
                >
                  Pasta
                </button>
                <button
                  onClick={onTriggerDocumentPicker}
                  disabled={isUploadingDocument || !selectedCustomer?.id}
                  className="px-2 py-1 text-[10px] bg-gray-100 border border-gray-200 rounded hover:bg-gray-200 disabled:opacity-40"
                  title="Guardar ficheiro (usa a última pasta escolhida para este cliente, quando suportado)"
                >
                  {isUploadingDocument ? 'A guardar...' : 'Guardar ficheiro'}
                </button>
              </div>
            </div>

            <p className="text-[10px] text-gray-500 break-all">
              {customerDocumentsPath || selectedCustomer?.documentsFolder || 'Sem pasta definida na ficha do cliente.'}
            </p>
            <div className="mt-1 flex items-center gap-1 text-[10px] text-gray-500">
              <span className="font-semibold">Subpasta:</span>
              <span className="truncate">{customerDocumentsCurrentPath || '/'}</span>
              {canGoUpDocumentsPath && (
                <button
                  onClick={onGoUpDocumentsFolder}
                  className="ml-auto px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 hover:bg-gray-100"
                  title="Subir pasta"
                >
                  ..
                </button>
              )}
            </div>
            {!customerDocsConfigured && (
              <p className="text-[10px] text-amber-600 mt-1">
                Pasta automática ativa. Defina a pasta na ficha do cliente para usar um caminho específico.
              </p>
            )}
            {docsError && <p className="text-[10px] text-red-600 mt-1">{docsError}</p>}
            <p className="text-[10px] text-gray-400 mt-1">
              Arraste ficheiros daqui para a conversa, ou arraste uma mensagem com link para guardar nesta pasta.
            </p>

            <div className="mt-2 max-h-44 overflow-auto space-y-1 pr-1">
              {isDocumentsLoading && <p className="text-[10px] text-gray-400">A carregar documentos...</p>}
              {!isDocumentsLoading && customerDocuments.length === 0 && (
                <p className="text-[10px] text-gray-400">Sem documentos nesta pasta.</p>
              )}
              {!isDocumentsLoading &&
                customerDocuments.map((doc) => (
                  <button
                    key={`${doc.relativePath}:${doc.type}`}
                    draggable={doc.type === 'file'}
                    onDragStart={(event) => {
                      if (doc.type !== 'file') return;
                      event.dataTransfer.setData('application/x-wa-doc-path', doc.relativePath);
                      event.dataTransfer.setData('application/x-wa-doc-name', doc.name);
                    }}
                    onClick={() => {
                      if (doc.type === 'directory') {
                        onOpenDocumentsFolder(doc.relativePath);
                        return;
                      }
                      onDownloadDocument(doc.relativePath);
                    }}
                    className="w-full flex items-center justify-between text-[10px] p-1.5 rounded hover:bg-gray-50 border border-gray-100"
                    title={doc.type === 'directory' ? 'Abrir pasta' : 'Descarregar'}
                  >
                    <span className="truncate pr-2 text-left">
                      {doc.type === 'directory' ? '📁 ' : '📄 '}
                      {doc.name}
                    </span>
                    <span className="shrink-0 text-gray-500 flex items-center gap-1">
                      {doc.type === 'directory' ? '' : formatBytes(Number(doc.size || 0))}
                      {doc.type === 'directory' ? <FolderOpen size={10} /> : <Download size={10} />}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        )}

        {isDocumentsExpanded && (
          <SaftPanel
            saftLoadingType={saftLoadingType}
            saftJobByType={saftJobByType}
            saftFeedback={saftFeedback}
            onRequest={onSaftRequest}
            onSyncCompanyDocs={onSyncCompanyDocs}
          />
        )}

        <div className="flex items-center justify-center gap-1 mt-2">
          {isUnknownCustomer ? (
            <span className="text-xs text-red-500 flex items-center gap-1 bg-red-50 px-2 py-1 rounded-full border border-red-100 font-bold">
              <AlertTriangle size={10} /> Não Salvo
            </span>
          ) : selectedCustomer?.allowAutoResponses ? (
            <span className="text-xs text-whatsapp-600 flex items-center gap-1 bg-whatsapp-50 px-2 py-1 rounded-full border border-whatsapp-100">
              <Zap size={10} /> Auto-Resp: ON
            </span>
          ) : (
            <span className="text-xs text-gray-400 flex items-center gap-1 bg-gray-100 px-2 py-1 rounded-full border border-gray-200">
              <ZapOff size={10} /> Auto-Resp: OFF
            </span>
          )}
        </div>

        {selectedCustomer?.contacts && selectedCustomer.contacts.length > 0 && (
          <div className="mt-4 text-left bg-white p-3 rounded border border-gray-200">
            <p className="text-xs font-bold text-gray-400 mb-2 uppercase">Outros Contactos</p>
            <div className="space-y-2">
              {selectedCustomer.contacts.map((contact, idx) => (
                <div key={idx} className="flex justify-between items-center text-xs">
                  <span className="text-gray-900">{contact.name}</span>
                  <span className="text-gray-500 font-mono">{contact.phone}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 mt-4">
          <button
            onClick={onOpenLinkModal}
            title="Associar a outro Cliente ou Novo"
            className="flex items-center justify-center gap-2 px-3 py-2 bg-white border border-gray-300 shadow-sm text-gray-700 rounded-md text-xs font-medium hover:bg-gray-50"
          >
            <UserPlus size={14} /> Associar Cliente
          </button>
          <button
            onClick={onOpenCallModal}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-white border border-gray-300 shadow-sm text-gray-700 rounded-md text-xs font-medium hover:bg-gray-50"
          >
            <Phone size={14} /> Registar Chamada
          </button>
          {showTelegramActions && onRequestTelegramContact && (
            <button
              onClick={onRequestTelegramContact}
              className="flex items-center justify-center gap-2 px-3 py-2 bg-sky-50 border border-sky-200 shadow-sm text-sky-700 rounded-md text-xs font-medium hover:bg-sky-100"
              title="Pedir ao cliente para partilhar o contacto no Telegram"
            >
              <Phone size={14} /> Pedir Contacto Telegram
            </button>
          )}
        </div>
      </div>

      <TasksPanel
        selectedCustomer={selectedCustomer}
        users={users}
        tasks={tasks}
        showTaskForm={showTaskForm}
        newTaskTitle={newTaskTitle}
        newTaskAssignee={newTaskAssignee}
        newTaskPriority={newTaskPriority}
        newTaskAttachments={newTaskAttachments}
        duplicateWarning={duplicateWarning}
        onToggleTaskForm={onToggleTaskForm}
        onCreateTask={onCreateTask}
        onCancelTaskForm={onCancelTaskForm}
        onTaskTitleChange={onTaskTitleChange}
        onTaskAssigneeChange={onTaskAssigneeChange}
        onTaskPriorityChange={onTaskPriorityChange}
        onTaskAttachmentsSelected={onTaskAttachmentsSelected}
        onRemoveTaskAttachment={onRemoveTaskAttachment}
        onToggleTaskStatus={onToggleTaskStatus}
        openOccurrences={openOccurrences}
        openOccurrencesLoading={openOccurrencesLoading}
        openOccurrencesError={openOccurrencesError}
      />
    </div>
  );
};

export default ConversationDetailsSidebar;
