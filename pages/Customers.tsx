import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { mockService } from '../services/mockData';
import { fetchOccurrences, OccurrenceRow } from '../services/occurrencesApi';
import {
  Customer,
  CustomerType,
  SubContact,
  CustomerManager,
  CustomerAccessCredential,
  CustomerHouseholdRelation,
  CustomerRelatedRecord,
} from '../types';
import { Plus, Trash2, FolderOpen, RefreshCw, Upload, User, Building2, Shield, Users, ArrowDownToLine, Copy } from 'lucide-react';
import { CustomerAccessTab, type CustomerCredentialPreset } from './customers/CustomerAccessTab';
import { CustomerFiscalSummaryTab } from './customers/CustomerFiscalSummaryTab';
import { CustomerDocumentBrowser } from './customers/CustomerDocumentBrowser';
import { CustomersListPanel } from './customers/CustomersListPanel';
import { useCustomerDocuments } from './customers/hooks/useCustomerDocuments';
import {
  SegSocialSubUserState,
  accessTypeMatchesPreset,
  addMonthsIsoDate,
  applyAtUsernameFallback,
  getSegSocialSubUserState,
  getSegSocialSubUserStateFromCredentials,
  isSafeSegSocialApplicationAuthValue,
  isSegSocialCredential,
  normalizeAccessIdentity,
  normalizeAccessService,
  normalizeNifDigits,
  normalizeNissDigits,
  normalizeStoredSegSocialUsername,
  preserveExistingCredentialSecrets,
  resolveAtAccessFromCustomer,
  resolveSegSocialInteropAccessFromCustomer,
  resolveSsAccessFromCustomer,
  resolveSsPrincipalAccessFromCustomer,
  resolveSsSubUserAccessFromCustomer,
  todayIsoDate,
} from './customers/customerAccessUtils';
import {
  SEG_SOCIAL_LOGIN_URL,
  SEG_SOCIAL_ACTIVATE_URL,
  SEG_SOCIAL_USERNAME_SELECTORS,
  SEG_SOCIAL_PASSWORD_SELECTORS,
  SEG_SOCIAL_SUBMIT_SELECTORS,
  SEG_SOCIAL_SUCCESS_SELECTORS,
  SOCIEDADE_BASE_PATH,
  DEFAULT_CUSTOMER_FOLDER_ROOT,
  SOCIEDADE_DOCUMENT_CATEGORIES,
  CUSTOMER_INGEST_TYPES,
  HOUSEHOLD_RELATION_OPTIONS,
  RELATED_RECORD_OPTIONS,
  isLocalAutomationBridgeUnavailable,
  classifyAutologinFallbackReason,
  normalizeImportedKey,
  buildImportedLookup,
  formatImportedValue,
  pickImportedValue,
  normalizeStatus,
  previousMonthAnoMes,
  generateSegSocialPassword,
  isValidPortugueseNif,
  normalizeCustomerTypeForSubUserFlow,
  canUseSegSocialSubUserFlow,
  dedupeCustomersForListing,
  sanitizeWindowsFolderSegment,
  buildSuggestedCustomerFolderPath,
  normalizeHouseholdRelationTypeValue,
  type AutologinFallbackReason,
  type CustomerIngestDocumentType,
  type CustomerModalTab,
  type CustomerTaskSummary,
  type CustomerOccurrenceSummary,
  formatDateOnly,
  formatTaskStatus,
  formatOccurrenceStatus,
  getTaskStatusBadgeClass,
  getOccurrenceStatusBadgeClass,
} from './customers/customerHelpers';
import {
  CustomerFormState,
  CustomerSortKey,
  SortDirection,
  emptyFormState,
  formStateFromCustomer,
  serializeCustomerFormState,
} from './customers/customerFormState';
import {
  LOCAL_CARTAO_ELETRONICO_BRIDGE_URL,
  triggerChromeExtensionAutologin,
  triggerLocalFinancasAutologinBridge,
  triggerLocalFinancasAtProfileBridge,
  type FinancasAtProfileFields,
} from './customers/customerAutomationBridge';
import { CustomerContactosTab } from './customers/tabs/CustomerContactosTab';
import { CustomerAtividadeTab } from './customers/tabs/CustomerAtividadeTab';
import { CustomerSociedadeTab } from './customers/tabs/CustomerSociedadeTab';
import { CustomerRelacoesTab } from './customers/tabs/CustomerRelacoesTab';
import { CustomerDadosTab } from './customers/tabs/CustomerDadosTab';

const OPEN_CUSTOMER_PROFILE_STORAGE_KEY = 'wa_pro_open_customer_id';

const Customers: React.FC = () => {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [stateFilter, setStateFilter] = useState('TODOS');
  const [typeFilter, setTypeFilter] = useState('TODOS');
  const [ownerFilter, setOwnerFilter] = useState('TODOS');
  const [subUserFilter, setSubUserFilter] = useState<'TODOS' | SegSocialSubUserState>('TODOS');
  const [sortKey, setSortKey] = useState<CustomerSortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [showModal, setShowModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [activeTab, setActiveTab] = useState<CustomerModalTab>('dados');

  const [formData, setFormData] = useState<CustomerFormState>(emptyFormState());
  const [savedFormSnapshot, setSavedFormSnapshot] = useState('');
  const [formSavedNotice, setFormSavedNotice] = useState('');
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);

  const modalFileInputRef = useRef<HTMLInputElement | null>(null);
  const sociedadeFileInputRef = useRef<HTMLInputElement | null>(null);
  const ingestFileInputRef = useRef<HTMLInputElement | null>(null);
  const headerIngestFileInputRef = useRef<HTMLInputElement | null>(null);
  const modalDocuments = useCustomerDocuments();
  const sociedadeDocuments = useCustomerDocuments({
    initialPath: SOCIEDADE_BASE_PATH,
    basePath: SOCIEDADE_BASE_PATH,
    loadErrorMessage: 'Falha ao carregar documentos da sociedade.',
    uploadErrorMessage: 'Falha ao guardar documento da sociedade.',
  });
  const modalDocs = modalDocuments.state.entries;
  const modalDocsPath = modalDocuments.state.folderPath;
  const modalDocsCurrentPath = modalDocuments.state.currentPath;
  const modalCanGoUp = modalDocuments.state.canGoUp;
  const modalDocsConfigured = modalDocuments.state.configured;
  const modalDocsLoading = modalDocuments.state.loading;
  const modalDocsError = modalDocuments.state.error;
  const modalUploadingDoc = modalDocuments.state.uploading;
  const [modalOrganizingDocs, setModalOrganizingDocs] = useState(false);
  const [modalOrganizerStatus, setModalOrganizerStatus] = useState('');
  const [modalOrganizerWarnings, setModalOrganizerWarnings] = useState<string[]>([]);
  const [modalOrganizerUndoAvailable, setModalOrganizerUndoAvailable] = useState(false);
  const [modalOrganizerUndoing, setModalOrganizerUndoing] = useState(false);
  const [modalOrganizerPreview, setModalOrganizerPreview] = useState<Array<{ from: string; to: string; reason: string; type: string }> | null>(null);
  const sociedadeDocs = sociedadeDocuments.state.entries;
  const sociedadeDocsPath = sociedadeDocuments.state.folderPath;
  const sociedadeCurrentPath = sociedadeDocuments.state.currentPath;
  const sociedadeCanGoUp = sociedadeDocuments.state.canGoUp;
  const sociedadeDocsConfigured = sociedadeDocuments.state.configured;
  const sociedadeDocsLoading = sociedadeDocuments.state.loading;
  const sociedadeDocsError = sociedadeDocuments.state.error;
  const sociedadeUploadingDoc = sociedadeDocuments.state.uploading;
  const [sociedadeCategoryKey, setSociedadeCategoryKey] = useState(SOCIEDADE_DOCUMENT_CATEGORIES[0].key);
  const [ingestDocumentType, setIngestDocumentType] = useState<CustomerIngestDocumentType>('certidao_permanente');
  const [ingestSelectedFile, setIngestSelectedFile] = useState<File | null>(null);
  const [ingestSelectedFile2, setIngestSelectedFile2] = useState<File | null>(null);
  const [ingestCodigo, setIngestCodigo] = useState('');
  const [ingestLoading, setIngestLoading] = useState(false);
  const [fiscalSummaryRefreshKey, setFiscalSummaryRefreshKey] = useState(0);
  const [ingestStatus, setIngestStatus] = useState<string>('');
  const [ingestWarnings, setIngestWarnings] = useState<string[]>([]);
  const [showHeaderIngestModal, setShowHeaderIngestModal] = useState(false);
  const [headerIngestCustomerId, setHeaderIngestCustomerId] = useState('');
  const [headerIngestDocumentType, setHeaderIngestDocumentType] = useState<CustomerIngestDocumentType>('certidao_permanente');
  const [headerIngestSelectedFile, setHeaderIngestSelectedFile] = useState<File | null>(null);
  const [headerIngestPhoneInput, setHeaderIngestPhoneInput] = useState('');
  const [headerIngestCodigo, setHeaderIngestCodigo] = useState('');
  const [headerIngestPendingCreate, setHeaderIngestPendingCreate] = React.useState<{nif: string; name: string; fields: Record<string,any>} | null>(null);
  const [headerIngestLoading, setHeaderIngestLoading] = useState(false);
  const [headerIngestStatus, setHeaderIngestStatus] = useState('');
  const [headerIngestWarnings, setHeaderIngestWarnings] = useState<string[]>([]);
  const [agregadoSearchTerms, setAgregadoSearchTerms] = useState<Record<number, string>>({});
  const [fichasSearchTerms, setFichasSearchTerms] = useState<Record<number, string>>({});
  const [customerTasksSummary, setCustomerTasksSummary] = useState<CustomerTaskSummary[]>([]);
  const [customerOccurrencesSummary, setCustomerOccurrencesSummary] = useState<CustomerOccurrenceSummary[]>([]);
  const [customerActivityLoading, setCustomerActivityLoading] = useState(false);
  const [customerActivityError, setCustomerActivityError] = useState('');
  const customerActivityRequestRef = useRef(0);
  const [autologinBusyCustomerId, setAutologinBusyCustomerId] = useState<string | null>(null);
  const [atProfileBusy, setAtProfileBusy] = useState(false);
  const [segSocialAutologinBusyCustomerId, setSegSocialAutologinBusyCustomerId] = useState<string | null>(null);
  const [segSocialSubUserBusyCustomerId, setSegSocialSubUserBusyCustomerId] = useState<string | null>(null);
  const [segSocialActivationBusyCustomerId, setSegSocialActivationBusyCustomerId] = useState<string | null>(null);
  const [saftSsSyncBusy, setSaftSsSyncBusy] = useState(false);

  useEffect(() => {
    void loadCustomers();
    void loadUsers();
  }, []);

  useEffect(() => {
    if (!showModal || activeTab !== 'documentos' || !editingCustomer?.id) return;
    setModalOrganizerStatus('');
    setModalOrganizerWarnings([]);
    setModalOrganizerUndoAvailable(false);
    setModalOrganizerPreview(null);
    void loadModalDocuments(editingCustomer.id, '');
  }, [showModal, activeTab, editingCustomer?.id]);

  useEffect(() => {
    if (!showModal || activeTab !== 'sociedade' || !editingCustomer?.id) return;
    const basePath = String(sociedadeCurrentPath || SOCIEDADE_BASE_PATH).trim();
    void loadSociedadeDocuments(editingCustomer.id, basePath);
  }, [showModal, activeTab, editingCustomer?.id]);

  useEffect(() => {
    if (!showModal || activeTab !== 'atividade' || !editingCustomer?.id) return;
    void loadCustomerActivity(editingCustomer.id);
  }, [showModal, activeTab, editingCustomer?.id]);

  useEffect(() => {
    if (!showModal || !formSavedNotice) return;
    if (savedFormSnapshot && serializeCustomerFormState(formData) !== savedFormSnapshot) {
      setFormSavedNotice('');
    }
  }, [formData, formSavedNotice, savedFormSnapshot, showModal]);

  const loadCustomers = async () => {
    const data = await mockService.getCustomers();
    const deduped = dedupeCustomersForListing(data);
    setCustomers(deduped);
    return deduped;
  };

  const loadUsers = async () => {
    const data = await mockService.getUsers();
    setUsers(data);
  };

  const loadCustomerActivity = async (customerId: string) => {
    const normalizedCustomerId = String(customerId || '').trim();
    if (!normalizedCustomerId) return;

    const requestId = customerActivityRequestRef.current + 1;
    customerActivityRequestRef.current = requestId;
    const isCurrentActivityRequest = () => customerActivityRequestRef.current === requestId;

    setCustomerActivityLoading(true);
    setCustomerActivityError('');
    try {
      const [conversations, tasks, occurrences, usersForMap] = await Promise.all([
        mockService.getConversations(),
        mockService.getTasks(),
        fetchOccurrences({ limit: 5000 }),
        mockService.getUsers(),
      ]);

      if (!isCurrentActivityRequest()) return;

      const customerConversationIds = new Set(
        (Array.isArray(conversations) ? conversations : [])
          .filter((conversation) => String(conversation.customerId || '').trim() === normalizedCustomerId)
          .map((conversation) => String(conversation.id || '').trim())
          .filter(Boolean)
      );

      const userNameById = new Map(
        (Array.isArray(usersForMap) ? usersForMap : []).map((user) => [String(user.id || '').trim(), String(user.name || '').trim()])
      );

      const nextTasks: CustomerTaskSummary[] = (Array.isArray(tasks) ? tasks : [])
        .filter((task) => customerConversationIds.has(String(task.conversationId || '').trim()))
        .map((task) => ({
          id: String(task.id || '').trim(),
          title: String(task.title || '').trim() || 'Tarefa sem título',
          status: String(task.status || '').trim().toUpperCase(),
          priority: String(task.priority || '').trim().toUpperCase(),
          dueDate: String(task.dueDate || '').trim(),
          assignedUserName: userNameById.get(String(task.assignedUserId || '').trim()) || 'Sem responsável',
        }))
        .sort((a, b) => {
          const aClosed = a.status === 'DONE' ? 1 : 0;
          const bClosed = b.status === 'DONE' ? 1 : 0;
          if (aClosed !== bClosed) return aClosed - bClosed;
          return String(a.dueDate || '').localeCompare(String(b.dueDate || ''));
        });

      const nextOccurrences: CustomerOccurrenceSummary[] = (Array.isArray(occurrences) ? occurrences : [])
        .filter((item: OccurrenceRow) => String(item.customerId || '').trim() === normalizedCustomerId)
        .map((item: OccurrenceRow) => ({
          id: String(item.id || '').trim(),
          title: String(item.title || '').trim() || 'Ocorrência sem título',
          state: String(item.state || '').trim().toUpperCase(),
          typeName: String(item.typeName || '').trim() || '-',
          date: String(item.date || '').trim(),
          dueDate: String(item.dueDate || '').trim(),
          responsibleNames: String(item.responsibleNames || item.responsibleUserName || '').trim() || 'Sem responsável',
        }))
        .sort((a, b) => {
          const aClosed = a.state === 'RESOLVIDA' ? 1 : 0;
          const bClosed = b.state === 'RESOLVIDA' ? 1 : 0;
          if (aClosed !== bClosed) return aClosed - bClosed;
          return String(a.dueDate || a.date || '').localeCompare(String(b.dueDate || b.date || ''));
        });

      setCustomerTasksSummary(nextTasks);
      setCustomerOccurrencesSummary(nextOccurrences);
    } catch (error) {
      if (!isCurrentActivityRequest()) return;
      setCustomerActivityError(error instanceof Error ? error.message : 'Falha ao carregar tarefas e ocorrências deste cliente.');
      setCustomerTasksSummary([]);
      setCustomerOccurrencesSummary([]);
    } finally {
      if (isCurrentActivityRequest()) {
        setCustomerActivityLoading(false);
      }
    }
  };

  const resetModalDocsState = () => {
    modalDocuments.reset();
  };

  const resetSociedadeDocsState = () => {
    sociedadeDocuments.reset();
    setSociedadeCategoryKey(SOCIEDADE_DOCUMENT_CATEGORIES[0].key);
  };

  const resetIngestState = () => {
    setIngestDocumentType('certidao_permanente');
    setIngestSelectedFile(null);
    setIngestLoading(false);
    setIngestStatus('');
    setIngestWarnings([]);
  };

  const resetHeaderIngestState = () => {
    setHeaderIngestDocumentType('certidao_permanente');
    setHeaderIngestSelectedFile(null);
    setHeaderIngestPhoneInput('');
    setHeaderIngestCodigo('');
    setHeaderIngestPendingCreate(null);
    setHeaderIngestLoading(false);
    setHeaderIngestStatus('');
    setHeaderIngestWarnings([]);
  };

  const openHeaderIngestModal = () => {
    setHeaderIngestCustomerId('');
    resetHeaderIngestState();
    setShowHeaderIngestModal(true);
  };

  const formatDateTime = (value?: string): string => {
    const raw = String(value || '').trim();
    if (!raw) return 'Nunca sincronizado';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleString('pt-PT');
  };

  const resolveSuggestedCustomerName = (suggested: Partial<Customer> | undefined, suggestedNif = ''): string => {
    const candidate = String(suggested?.company || suggested?.name || '').trim();
    if (candidate) return candidate;
    return `Cliente ${String(suggestedNif || '').trim() || 'novo'}`;
  };

  const resolveSuggestedCustomerFolder = (suggested: Partial<Customer> | undefined, suggestedName: string): string => {
    const fromSuggestion = String(suggested?.documentsFolder || '').trim();
    if (fromSuggestion) return fromSuggestion;
    return buildSuggestedCustomerFolderPath(suggestedName);
  };

  const buildRelationCustomerLabel = (customer?: Customer | null): string => {
    if (!customer) return '';
    const title = String(customer.company || customer.name || '').trim();
    const nif = String(customer.nif || '').trim();
    if (!title) return '';
    return nif ? `${title} (${nif})` : title;
  };

  const buildEntryRelationLabel = (
    entry: Pick<CustomerHouseholdRelation, 'customerName' | 'customerCompany' | 'customerNif'>,
    resolved?: Customer | null
  ): string => {
    const resolvedLabel = buildRelationCustomerLabel(resolved);
    if (resolvedLabel) return resolvedLabel;
    const title = String(entry.customerCompany || entry.customerName || '').trim();
    const nif = String(entry.customerNif || '').trim();
    if (!title) return '';
    return nif ? `${title} (${nif})` : title;
  };

  const filterRelationCustomers = (searchTermRaw: string): Customer[] => {
    const folded = String(searchTermRaw || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (!folded) return [];
    return selectableRelationCustomers
      .filter((customer) => {
        const haystack = [
          customer.name,
          customer.company,
          customer.nif || '',
          customer.email || '',
          customer.phone || '',
        ]
          .join(' ')
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        return haystack.includes(folded);
      })
      .slice(0, 8);
  };

  const removeIndexedSearchTerm = (current: Record<number, string>, removedIndex: number): Record<number, string> => {
    const next: Record<number, string> = {};
    Object.entries(current).forEach(([key, value]) => {
      const index = Number(key);
      if (!Number.isInteger(index)) return;
      if (index < removedIndex) next[index] = value;
      if (index > removedIndex) next[index - 1] = value;
    });
    return next;
  };

  const loadModalDocuments = async (customerId: string, relativePath = '') => {
    await modalDocuments.load(customerId, relativePath);
  };

  const openModalDocumentsFolder = async (relativePath: string) => {
    if (!editingCustomer?.id) return;
    await loadModalDocuments(editingCustomer.id, relativePath);
  };

  const goUpModalDocumentsFolder = async () => {
    if (!editingCustomer?.id) return;
    await modalDocuments.goUp(editingCustomer.id);
  };

  const triggerModalDocumentPicker = () => {
    modalFileInputRef.current?.click();
  };

  const handleModalDocumentUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!editingCustomer?.id || !file) return;

    await modalDocuments.upload(editingCustomer.id, file, modalDocsCurrentPath);
  };

  const organizeModalDocumentsWithAi = async () => {
    if (!editingCustomer?.id || modalOrganizingDocs) return;

    setModalOrganizingDocs(true);
    setModalOrganizerStatus('A analisar documentos (pré-visualização)...');
    setModalOrganizerWarnings([]);
    setModalOrganizerUndoAvailable(false);
    setModalOrganizerPreview(null);

    try {
      const preview = await mockService.organizeCustomerDocuments(editingCustomer.id, {
        maxAiDocuments: 1,
        maxFiles: 40,
        maxLegacyFolders: 2,
        maxEmptyFolders: 25,
        maxFilesPerLegacyFolder: 10,
        compareExistingDuplicates: true,
        dryRun: true,
      });

      setModalOrganizingDocs(false);

      if (preview.wouldMove.length === 0 && preview.movedLegacyFoldersCount === 0) {
        setModalOrganizerStatus('Pasta já está organizada. Nenhuma alteração necessária.');
        setModalOrganizerWarnings(preview.warnings.slice(0, 10));
        return;
      }

      setModalOrganizerPreview(preview.wouldMove);
      setModalOrganizerStatus(
        `Pré-visualização: ${preview.wouldMove.length} ficheiro(s) serão movidos/renomeados` +
        (preview.truncated ? ` (mais ficheiros existem — organização irá correr em rondas)` : '') +
        `. Confirma?`
      );
      setModalOrganizerWarnings(preview.warnings.slice(0, 10));
    } catch (error) {
      setModalOrganizingDocs(false);
      setModalOrganizerStatus('');
      setModalOrganizerWarnings([error instanceof Error ? error.message : 'Falha na pré-visualização.']);
    }
  };

  const confirmOrganizeModalDocuments = async () => {
    if (!editingCustomer?.id || modalOrganizingDocs) return;

    setModalOrganizingDocs(true);
    setModalOrganizerPreview(null);
    setModalOrganizerWarnings([]);
    setModalOrganizerUndoAvailable(false);

    try {
      const totals = {
        scannedCount: 0,
        movedCount: 0,
        repeatedCount: 0,
        expiredCount: 0,
        aiReadCount: 0,
        aiCacheHitCount: 0,
        aiRenamedCount: 0,
        movedLegacyFoldersCount: 0,
        removedEmptyFoldersCount: 0,
        fiscalUpdatesCount: 0,
      };
      const warnings: string[] = [];
      const maxRounds = 12;
      const aiBatchSize = 1;
      const filesPerRound = 40;
      for (let round = 1; round <= maxRounds; round += 1) {
        setModalOrganizerStatus(`A organizar documentos... ronda ${round}/${maxRounds}`);
        const result = await mockService.organizeCustomerDocuments(editingCustomer.id, {
          maxAiDocuments: aiBatchSize,
          maxFiles: filesPerRound,
          maxLegacyFolders: 2,
          maxEmptyFolders: 25,
          maxFilesPerLegacyFolder: 10,
          compareExistingDuplicates: true,
        });
        totals.scannedCount = Math.max(totals.scannedCount, result.scannedCount);
        totals.movedCount += result.movedCount;
        totals.repeatedCount += result.repeatedCount;
        totals.expiredCount += result.expiredCount;
        totals.aiReadCount += result.aiReadCount;
        totals.aiCacheHitCount += result.aiCacheHitCount;
        totals.aiRenamedCount += result.aiRenamedCount;
        totals.movedLegacyFoldersCount += result.movedLegacyFoldersCount;
        totals.removedEmptyFoldersCount += result.removedEmptyFoldersCount;
        totals.fiscalUpdatesCount += result.fiscalUpdates.length;
        warnings.push(...result.warnings);
        if (result.undoAvailable) setModalOrganizerUndoAvailable(true);

        const didWork =
          result.movedCount > 0 ||
          result.aiReadCount > 0 ||
          result.aiRenamedCount > 0 ||
          result.movedLegacyFoldersCount > 0 ||
          result.removedEmptyFoldersCount > 0;
        if (!didWork) break;
        const stillCleaningFolders =
          result.movedLegacyFoldersCount > 0 ||
          result.removedEmptyFoldersCount > 0;
        if (!stillCleaningFolders && result.scannedCount < filesPerRound && result.aiReadCount < aiBatchSize) break;
      }
      const fiscalText = totals.fiscalUpdatesCount > 0
        ? ` Atualizou resumo fiscal em ${totals.fiscalUpdatesCount} documento(s).`
        : '';
      setModalOrganizerStatus(
        `Concluído. Analisados ${totals.scannedCount} ficheiro(s), movidos ${totals.movedCount}. ` +
        `IA leu ${totals.aiReadCount} (cache: ${totals.aiCacheHitCount}), renomeou ${totals.aiRenamedCount}. ` +
        `Repetidos ${totals.repeatedCount}. Caducados ${totals.expiredCount}. ` +
        `Pastas antigas ${totals.movedLegacyFoldersCount}. Pastas vazias ${totals.removedEmptyFoldersCount}.${fiscalText}`
      );
      setModalOrganizerWarnings(Array.from(new Set(warnings)).slice(0, 20));
      await loadModalDocuments(editingCustomer.id, modalDocsCurrentPath);
      setFiscalSummaryRefreshKey((value) => value + 1);
      void loadCustomers();
    } catch (error) {
      setModalOrganizerStatus('');
      setModalOrganizerWarnings([error instanceof Error ? error.message : 'Falha ao organizar documentos.']);
    } finally {
      setModalOrganizingDocs(false);
    }
  };

  const undoOrganizeModalDocuments = async () => {
    if (!editingCustomer?.id || modalOrganizerUndoing) return;
    setModalOrganizerUndoing(true);
    setModalOrganizerWarnings([]);
    try {
      const result = await mockService.undoOrganizeCustomerDocuments(editingCustomer.id);
      setModalOrganizerUndoAvailable(false);
      setModalOrganizerStatus(
        `Anulado. Revertidos ${result.revertedCount} ficheiro(s)` +
        (result.skippedCount > 0 ? `, ${result.skippedCount} não revertido(s).` : '.')
      );
      setModalOrganizerWarnings([...result.warnings, ...result.skipped.map((s) => `Não revertido: ${s.to || s.from} — ${s.reason}`)].slice(0, 10));
      await loadModalDocuments(editingCustomer.id, modalDocsCurrentPath);
    } catch (error) {
      setModalOrganizerWarnings([error instanceof Error ? error.message : 'Falha ao anular organização.']);
    } finally {
      setModalOrganizerUndoing(false);
    }
  };

  const loadSociedadeDocuments = async (customerId: string, relativePath = SOCIEDADE_BASE_PATH) => {
    const targetPath = String(relativePath || SOCIEDADE_BASE_PATH).trim();
    await sociedadeDocuments.load(customerId, targetPath);
  };

  const openSociedadeFolder = async (relativePath: string) => {
    if (!editingCustomer?.id) return;
    await loadSociedadeDocuments(editingCustomer.id, relativePath);
  };

  const openSociedadeCategory = async (categoryKey: string) => {
    if (!editingCustomer?.id) return;
    setSociedadeCategoryKey(categoryKey);
    await loadSociedadeDocuments(editingCustomer.id, SOCIEDADE_BASE_PATH);
  };

  const goUpSociedadeFolder = async () => {
    if (!editingCustomer?.id) return;
    await sociedadeDocuments.goUp(editingCustomer.id);
  };

  const triggerSociedadeDocumentPicker = () => {
    sociedadeFileInputRef.current?.click();
  };

  const handleSociedadeDocumentUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!editingCustomer?.id || !file) return;

    const targetPathRaw = String(sociedadeCurrentPath || SOCIEDADE_BASE_PATH).trim();
    const targetPath =
      targetPathRaw === SOCIEDADE_BASE_PATH || targetPathRaw.startsWith(`${SOCIEDADE_BASE_PATH}/`)
        ? targetPathRaw
        : SOCIEDADE_BASE_PATH;
    await sociedadeDocuments.upload(editingCustomer.id, file, targetPath);
  };

  const triggerIngestPicker = () => {
    ingestFileInputRef.current?.click();
  };

  const triggerHeaderIngestPicker = () => {
    headerIngestFileInputRef.current?.click();
  };

  const fileToBase64 = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(f);
    });

  const handleIngestFileSelection = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileArray = Array.from(event.target.files || []);
    event.target.value = '';
    if (fileArray.length === 0) return;
    setIngestWarnings([]);

    const isImage = (f: File) => f.type.startsWith('image/');

    if (fileArray.length >= 2 && ingestDocumentType === 'cartao_cidadao' && fileArray.every(isImage)) {
      setIngestStatus('A gerar PDF frente+verso...');
      try {
        const [b1, b2] = await Promise.all([fileToBase64(fileArray[0]), fileToBase64(fileArray[1])]);
        const resp = await fetch('/api/cc/images-to-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image1: b1, image2: b2 }),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error);
        const pdfBytes = Uint8Array.from(atob(data.pdfBase64), c => c.charCodeAt(0));
        const pdfFile = new File([pdfBytes], 'cc_frente_verso.pdf', { type: 'application/pdf' });
        setIngestSelectedFile(pdfFile);
        setIngestSelectedFile2(null);
        setIngestStatus(`PDF gerado: ${fileArray[0].name} + ${fileArray[1].name}`);
      } catch (e) {
        setIngestSelectedFile(fileArray[0]);
        setIngestStatus(`Erro ao gerar PDF: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      setIngestSelectedFile(fileArray[0]);
      setIngestSelectedFile2(null);
      setIngestStatus('');
    }
  };

  const handleHeaderIngestFileSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] || null;
    event.target.value = '';
    setHeaderIngestSelectedFile(file);
    setHeaderIngestStatus('');
    setHeaderIngestWarnings([]);
  };

  const runHeaderDocumentIngest = async () => {
    const codigoCertidao = String(headerIngestCodigo || '').trim();

    const headerIsCodigoType = headerIngestDocumentType === 'certidao_permanente' || headerIngestDocumentType === 'cartao_eletronico';
    const headerIsCartao = headerIngestDocumentType === 'cartao_eletronico';
    const headerApiEndpoint = headerIsCartao ? LOCAL_CARTAO_ELETRONICO_BRIDGE_URL : '/api/certidao-permanente/consultar';

    // Fluxo por código — sem ficheiro (Certidão ou Cartão Eletrónico)
    if (!headerIngestSelectedFile && codigoCertidao && headerIsCodigoType) {
      setHeaderIngestLoading(true);
      setHeaderIngestStatus(`A consultar ${headerIsCartao ? 'cartão eletrónico (PC local)' : 'certidão'} online...`);
      setHeaderIngestWarnings([]);
      try {
        const res = await fetch(headerApiEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: codigoCertidao, codigo: codigoCertidao, customerId: headerIngestCustomerId || undefined }),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Erro na consulta');

        const f = data.fields || {};
        const nifFromCert = String(f.nif || '').trim();
        const nameFromCert = String(f.company || f.name || '').trim();

        // Determinar o cliente alvo (seleccionado, existente por NIF, ou criar novo)
        let targetId = headerIngestCustomerId;

        if (!targetId && nifFromCert) {
          const existingCustomer = customers.find(c => String(c.nif || '').trim() === nifFromCert);
          if (existingCustomer) {
            targetId = existingCustomer.id;
            setHeaderIngestStatus(`A actualizar cliente existente: ${existingCustomer.company || existingCustomer.name}...`);
          }
        }

        if (!targetId && nifFromCert && nameFromCert) {
          // Mostrar confirmação inline — não usar window.confirm (perde foco no Electron)
          setHeaderIngestPendingCreate({ nif: nifFromCert, name: nameFromCert, fields: f });
          setHeaderIngestLoading(false);
          return; // esperar confirmação do utilizador
        }

        if (!targetId && nifFromCert && nameFromCert) {
          // Mostrar confirmação inline (o botão "Sim" trata da criação)
          setHeaderIngestStatus('');
          const phone = String(headerIngestPhoneInput || '').trim() || '+351000000000';
          const managers = Array.isArray(f.managers) ? f.managers : [];
          const newCustomer = await mockService.createCustomer({
            name: nameFromCert,
            company: nameFromCert,
            phone,
            nif: nifFromCert,
            niss: '',
            type: 'Empresa',
            allowAutoResponses: true,
            morada: f.morada || '',
            codigoPostal: f.codigoPostal || '',
            caePrincipal: f.caePrincipal || '',
            dataConstituicao: f.dataConstituicao || '',
            inicioAtividade: f.inicioAtividade || '',
            certidaoPermanenteNumero: codigoCertidao,
            certidaoPermanenteValidade: f.certidaoPermanenteValidade || '',
            managers,
            contacts: [],
            accessCredentials: [],
            agregadoFamiliar: [],
            fichasRelacionadas: [],
          } as any, { syncToSupabase: false });
          targetId = newCustomer.id;
          const refreshed = await loadCustomers();
          setHeaderIngestStatus(`✓ Cliente criado: ${nameFromCert}`);
        }

        // Re-consultar com o cliente agora definido para guardar PDF e actualizar resumo
        if (targetId && targetId !== headerIngestCustomerId) {
          if (headerIsCartao) {
            await fetch('/api/cartao-eletronico/finalizar', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ codigo: codigoCertidao, customerId: targetId, ficheiroPdf: data.ficheiroPdf || '', fields: f }),
            }).catch(() => null);
            setHeaderIngestStatus(
              `✓ Cartão eletrónico gravado para ${nameFromCert} (${nifFromCert}).${data.ficheiroPdf ? ' PDF guardado.' : ''} Resumo fiscal actualizado.`
            );
            await mockService.updateCustomer(targetId, { cartaoEletronicoNumero: codigoCertidao } as any, { syncToSupabase: false });
          } else {
            const res2 = await fetch('/api/certidao-permanente/consultar', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ codigo: codigoCertidao, customerId: targetId }),
            });
            const data2 = await res2.json();
            setHeaderIngestStatus(
              `✓ Certidão gravada para ${nameFromCert} (${nifFromCert}).${data2.ficheiroPdf ? ' PDF guardado.' : ''} Resumo fiscal actualizado.`
            );
            await mockService.updateCustomer(targetId, {
              certidaoPermanenteNumero: codigoCertidao,
              certidaoPermanenteValidade: f.certidaoPermanenteValidade || '',
            } as any, { syncToSupabase: false });
          }
          await loadCustomers();
        } else if (targetId) {
          if (headerIsCartao) {
            await fetch('/api/cartao-eletronico/finalizar', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ codigo: codigoCertidao, customerId: targetId, ficheiroPdf: data.ficheiroPdf || '', fields: f }),
            }).catch(() => null);
            setHeaderIngestStatus(`✓ Cartão eletrónico actualizado.${data.ficheiroPdf ? ' PDF guardado.' : ''}`);
            await mockService.updateCustomer(targetId, { cartaoEletronicoNumero: codigoCertidao } as any, { syncToSupabase: false });
          } else {
            setHeaderIngestStatus(`✓ Certidão actualizada.${data.ficheiroPdf ? ' PDF guardado.' : ''}`);
            await mockService.updateCustomer(targetId, {
              certidaoPermanenteNumero: codigoCertidao,
              certidaoPermanenteValidade: f.certidaoPermanenteValidade || '',
            } as any, { syncToSupabase: false });
          }
          await loadCustomers();
        } else {
          setHeaderIngestStatus(`✓ ${headerIsCartao ? 'Cartão eletrónico' : 'Certidão'} consultado mas NIF não encontrado.`);
        }
      } catch (err) {
        setHeaderIngestStatus(`Erro: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setHeaderIngestLoading(false);
      }
      return;
    }

    if (!headerIngestSelectedFile) {
      triggerHeaderIngestPicker();
      return;
    }

    setHeaderIngestLoading(true);
    setHeaderIngestStatus('');
    setHeaderIngestWarnings([]);

    try {
      let targetCustomerId = String(headerIngestCustomerId || '').trim();
      let createdCustomerFromDetection: Customer | null = null;
      if (!targetCustomerId) {
        const detected = await mockService.detectCustomerByDocumentAI(
          headerIngestSelectedFile,
          headerIngestDocumentType
        );
        if (!detected.success || !detected.customer?.id) {
          if (detected.code === 'NIF_NOT_DETECTED') {
            setHeaderIngestStatus('Não foi possível ler o NIF no documento. Selecione o cliente manualmente.');
          } else if (
            detected.code === 'NIF_NOT_FOUND' &&
            (headerIngestDocumentType === 'cartao_cidadao' || headerIngestDocumentType === 'certidao_permanente')
          ) {
            const suggested = detected.suggestedCustomer || {};
            const suggestedNif = String(detected.nif || '').trim();
            const suggestedName = resolveSuggestedCustomerName(suggested, suggestedNif);
            const suggestedFolder = resolveSuggestedCustomerFolder(suggested, suggestedName);
            const documentLabel = headerIngestDocumentType === 'cartao_cidadao' ? 'Cartão de Cidadão' : 'Certidão Permanente';
            const suggestedType =
              headerIngestDocumentType === 'cartao_cidadao'
                ? CustomerType.PRIVATE
                : CustomerType.ENTERPRISE;
            const shouldCreate = window.confirm(
              `NIF ${suggestedNif || '(não identificado)'} não encontrado na base local.\n\n` +
              `Deseja criar novo cliente a partir da ${documentLabel}?\n\n` +
              `Nome sugerido: ${suggestedName}\n` +
              `Pasta sugerida:\n${suggestedFolder}`
            );
            if (!shouldCreate) {
              setHeaderIngestStatus('Criação de novo cliente cancelada.');
              return;
            }

            const syncToSupabase = window.confirm(
              'Também quer criar este novo cliente no MPR Control (Supabase)?\n\nOK = Sim\nCancelar = Só local'
            );
            let phone = String(suggested.phone || '').trim();
            if (!phone) {
              phone = String(headerIngestPhoneInput || '').trim();
            }
            if (!phone) {
              setHeaderIngestStatus(
                'O documento não trouxe telefone. Preencha o campo "Telefone para novo cliente" e clique novamente em "Analisar + Guardar".'
              );
              return;
            }

            const currentUserId = String(mockService.getCurrentUser()?.id || '').trim();
            createdCustomerFromDetection = await mockService.createCustomer(
              {
                name: suggestedName,
                company: String(suggested.company || '').trim() || suggestedName,
                phone,
                email: String(suggested.email || '').trim(),
                ownerId: currentUserId || null,
                type: suggestedType,
                contacts: [],
                allowAutoResponses: true,
                documentsFolder: suggestedFolder,
                nif: suggestedNif || String(suggested.nif || '').trim(),
                niss: String(suggested.niss || '').trim(),
                morada: String(suggested.morada || '').trim(),
                caePrincipal: String(suggested.caePrincipal || '').trim(),
                caeDescricao: String((suggested as Customer).caeDescricao || '').trim(),
                certidaoPermanenteNumero: String(suggested.certidaoPermanenteNumero || '').trim(),
                certidaoPermanenteValidade: String(suggested.certidaoPermanenteValidade || '').trim(),
                inicioAtividade: String(suggested.inicioAtividade || '').trim(),
                rcbeNumero: String(suggested.rcbeNumero || '').trim(),
                rcbeData: String(suggested.rcbeData || '').trim(),
                managers: Array.isArray(suggested.managers)
                  ? suggested.managers.map((manager) => ({
                      name: String((manager as { name?: string }).name || '').trim(),
                      nif: String((manager as { nif?: string }).nif || '').trim(),
                      email: String((manager as { email?: string }).email || '').trim(),
                      phone: String((manager as { phone?: string }).phone || '').trim(),
                    }))
                  : [],
                accessCredentials: [],
                notes: '',
                tipoIva: '',
                senhaFinancas: '',
                senhaSegurancaSocial: '',
                tipoContabilidade: '',
                estadoCliente: '',
                contabilistaCertificado: '',
                codigoReparticaoFinancas: '',
                dataConstituicao: '',
              },
              { syncToSupabase }
            );
            targetCustomerId = createdCustomerFromDetection.id;
            setHeaderIngestCustomerId(targetCustomerId);
            setHeaderIngestStatus(`Novo cliente criado: ${suggestedName}. A processar documento...`);
          } else if (detected.code === 'NIF_NOT_FOUND') {
            setHeaderIngestStatus(
              `NIF ${detected.nif || '(não identificado)'} não encontrado na base local. Crie a ficha e tente de novo.`
            );
          } else {
            setHeaderIngestStatus(detected.error || 'Falha na deteção automática por NIF.');
          }
          if (!targetCustomerId) return;
        } else {
          targetCustomerId = detected.customer.id;
          setHeaderIngestCustomerId(targetCustomerId);
          setHeaderIngestStatus(
            `Cliente detetado automaticamente: ${detected.customer.company || detected.customer.name} (${detected.customer.nif || detected.nif || ''})`
          );
        }
      }

      const result = await mockService.ingestCustomerDocumentWithAI(
        targetCustomerId,
        headerIngestSelectedFile,
        headerIngestDocumentType
      );

      if (!result.success) {
        setHeaderIngestStatus(result.error || 'Falha na análise do documento.');
        return;
      }

      setHeaderIngestWarnings(Array.isArray(result.warnings) ? result.warnings : []);
      const createdPrefix = createdCustomerFromDetection ? 'Novo cliente criado e ' : '';
      setHeaderIngestStatus(
        `${createdPrefix}documento guardado: ${result.savedDocument?.fileName || headerIngestSelectedFile.name}${
          result.updatedFields?.length ? ` | Campos atualizados: ${result.updatedFields.join(', ')}` : ''
        }`
      );
      setHeaderIngestSelectedFile(null);
      await loadCustomers();

      const fallbackCustomer =
        (createdCustomerFromDetection && String(createdCustomerFromDetection.id || '').trim() === targetCustomerId
          ? createdCustomerFromDetection
          : null) || null;
      const customerToOpen = result.customer || fallbackCustomer;
      if (customerToOpen?.id) {
        setShowHeaderIngestModal(false);
        resetHeaderIngestState();
        openModal(customerToOpen);
      }
    } catch (error) {
      setHeaderIngestStatus(error instanceof Error ? error.message : 'Falha ao processar documento.');
    } finally {
      setHeaderIngestLoading(false);
    }
  };

  const runDocumentIngest = async () => {
    if (!editingCustomer?.id) return;
    const codigoCert = String(ingestCodigo || '').trim();
    const isCodigoType = ingestDocumentType === 'certidao_permanente' || ingestDocumentType === 'cartao_eletronico';
    const isCartao = ingestDocumentType === 'cartao_eletronico';
    const apiEndpoint = isCartao ? LOCAL_CARTAO_ELETRONICO_BRIDGE_URL : '/api/certidao-permanente/consultar';

    // Fluxo por código — sem ficheiro, Certidão ou Cartão Eletrónico
    if (!ingestSelectedFile && codigoCert && isCodigoType) {
      setIngestLoading(true);
      setIngestStatus(isCartao ? 'A consultar cartão eletrónico (PC local)...' : 'A consultar certidão online...');
      setIngestWarnings([]);
      try {
        const bridgeBody: Record<string, unknown> = { code: codigoCert, codigo: codigoCert, customerId: editingCustomer.id };
        if (isCartao && editingCustomer.documentsFolder) {
          bridgeBody.documentsFolder = editingCustomer.documentsFolder;
        }
        const res = await fetch(apiEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bridgeBody),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Erro na consulta');
        const f = data.fields || {};

        if (isCartao) {
          // Registar no resumo fiscal via servidor
          const finRes = await fetch('/api/cartao-eletronico/finalizar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ codigo: codigoCert, customerId: editingCustomer.id, ficheiroPdf: data.ficheiroPdf || '', fields: f }),
          }).catch(e => ({ ok: false, _err: e }));
          const finData = finRes && 'ok' in finRes && finRes.ok ? await (finRes as Response).json().catch(() => ({})) : {};
          if (finData?.error) console.warn('[CartaoEletronico] finalizar error:', finData.error);
          setFiscalSummaryRefreshKey(k => k + 1);
        }

        // Actualizar campos do cliente
        const updates: Partial<Customer> = isCartao
          ? { cartaoEletronicoNumero: codigoCert } as any
          : { certidaoPermanenteNumero: codigoCert, certidaoPermanenteValidade: f.certidaoPermanenteValidade || '' } as any;
        if (f.morada && !formData.morada) (updates as any).morada = f.morada;
        if (f.caePrincipal && !formData.caePrincipal) (updates as any).caePrincipal = f.caePrincipal;
        await mockService.updateCustomer(editingCustomer.id, updates, { syncToSupabase: false });
        const refreshed = await loadCustomers();
        const updated = refreshed.find(c => c.id === editingCustomer.id);
        if (updated) {
          const next = formStateFromCustomer(updated);
          setEditingCustomer(updated);
          setFormData(next);
          setSavedFormSnapshot(serializeCustomerFormState(next));
        }
        setFiscalSummaryRefreshKey(k => k + 1);
        const docLabel = isCartao ? 'Cartão eletrónico' : `Certidão ${codigoCert}`;
        setIngestStatus(`✓ ${docLabel} consultado.${data.ficheiroPdf ? ' PDF guardado em Resumo Fiscal.' : ''} Resumo fiscal actualizado.`);
      } catch (err) {
        setIngestStatus(`Erro: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setIngestLoading(false);
      }
      return;
    }

    if (!ingestSelectedFile) {
      triggerIngestPicker();
      return;
    }

    setIngestLoading(true);
    setIngestStatus('');
    setIngestWarnings([]);

    try {
      const result = await mockService.ingestCustomerDocumentWithAI(
        editingCustomer.id,
        ingestSelectedFile,
        ingestDocumentType
      );

      if (!result.success && result.code === 'CERTIDAO_NIF_BELONGS_OTHER_CUSTOMER' && result.existingCustomer?.id) {
        const shouldOpen = window.confirm(
          `Este NIF já existe no cliente "${result.existingCustomer.company || result.existingCustomer.name}".\n\nDeseja abrir essa ficha?`
        );
        if (shouldOpen) {
          const allCustomers = await mockService.getCustomers();
          const existingCustomer = allCustomers.find((item) => item.id === result.existingCustomer?.id);
          if (existingCustomer) {
            setShowModal(false);
            openModal(existingCustomer);
            return;
          }
        }
        setIngestStatus(result.error || 'NIF já associado a outra ficha.');
        return;
      }

      if (!result.success && result.code === 'CERTIDAO_NIF_NOT_FOUND') {
        const suggested = result.suggestedCustomer || {};
        const suggestedNif = String(suggested.nif || '').trim();
        const suggestedName = resolveSuggestedCustomerName(suggested, suggestedNif);
        const suggestedFolder = resolveSuggestedCustomerFolder(suggested, suggestedName);
        const shouldCreate = window.confirm(
          `A certidão indica NIF ${suggestedNif || '(não lido)'} que não coincide com esta ficha.\n\n` +
          `Deseja criar novo cliente com estes dados?\n\n` +
          `Pasta sugerida:\n${suggestedFolder}`
        );
        if (!shouldCreate) {
          setIngestStatus(result.error || 'Criação de novo cliente cancelada.');
          return;
        }

        const syncToSupabase = window.confirm(
          'Também quer criar este novo cliente no MPR Control (Supabase)?\n\nOK = Sim\nCancelar = Só local'
        );
        let phone = String(suggested.phone || '').trim();
        if (!phone) {
          setIngestStatus(
            'Não foi possível criar automaticamente: o documento não trouxe telefone. Crie/preencha a ficha com telefone e volte a analisar.'
          );
          return;
        }

        const createdCustomer = await mockService.createCustomer(
          {
            name: suggestedName,
            company: suggestedName,
            phone,
            email: String(suggested.email || '').trim(),
            ownerId: formData.ownerId || null,
            type: CustomerType.ENTERPRISE,
            contacts: [],
            allowAutoResponses: true,
            documentsFolder: suggestedFolder,
            nif: suggestedNif,
            niss: String(suggested.niss || '').trim(),
            morada: String(suggested.morada || '').trim(),
            caePrincipal: String(suggested.caePrincipal || '').trim(),
            certidaoPermanenteNumero: String(suggested.certidaoPermanenteNumero || '').trim(),
            certidaoPermanenteValidade: String(suggested.certidaoPermanenteValidade || '').trim(),
            inicioAtividade: String(suggested.inicioAtividade || '').trim(),
            rcbeNumero: String(suggested.rcbeNumero || '').trim(),
            rcbeData: String(suggested.rcbeData || '').trim(),
            managers: Array.isArray(suggested.managers)
              ? suggested.managers.map((manager) => ({
                  name: String((manager as { name?: string }).name || '').trim(),
                  nif: String((manager as { nif?: string }).nif || '').trim(),
                  email: String((manager as { email?: string }).email || '').trim(),
                  phone: String((manager as { phone?: string }).phone || '').trim(),
                }))
              : [],
            accessCredentials: [],
            notes: '',
            tipoIva: '',
            senhaFinancas: '',
            senhaSegurancaSocial: '',
            tipoContabilidade: '',
            estadoCliente: '',
            contabilistaCertificado: '',
            codigoReparticaoFinancas: '',
            dataConstituicao: '',
          },
          { syncToSupabase }
        );

        const reprocess = await mockService.ingestCustomerDocumentWithAI(
          createdCustomer.id,
          ingestSelectedFile,
          ingestDocumentType
        );
        if (!reprocess.success) {
          setIngestStatus(reprocess.error || 'Cliente criado, mas a ingestão no novo cliente falhou.');
          return;
        }

        await loadCustomers();
        const nextCustomer = reprocess.customer || createdCustomer;
        setEditingCustomer(nextCustomer);
        setFormData(formStateFromCustomer(nextCustomer));
        setIngestWarnings(Array.isArray(reprocess.warnings) ? reprocess.warnings : []);
        setIngestStatus(
          `Novo cliente criado e documento guardado em ${reprocess.savedDocument?.relativePath || 'Documentos Oficiais'}.`
        );
        setIngestSelectedFile(null);
        await loadModalDocuments(nextCustomer.id, 'Documentos Oficiais');
        return;
      }

      if (!result.success) {
        setIngestStatus(result.error || 'Falha na análise do documento.');
        return;
      }

      if (result.customer) {
        setEditingCustomer(result.customer);
        setFormData(formStateFromCustomer(result.customer));
      }
      await loadCustomers();
      setIngestWarnings(Array.isArray(result.warnings) ? result.warnings : []);
      setIngestStatus(
        `Documento guardado: ${result.savedDocument?.fileName || ingestSelectedFile.name}${result.updatedFields?.length ? ` | Campos atualizados: ${result.updatedFields.join(', ')}` : ''}`
      );
      setIngestSelectedFile(null);
      await loadModalDocuments(editingCustomer.id, 'Documentos Oficiais');
    } catch (error) {
      setIngestStatus(error instanceof Error ? error.message : 'Falha ao inserir documento.');
    } finally {
      setIngestLoading(false);
    }
  };

  const buildWindowsDocumentPath = (rootFolder: string, relativePath: string): string => {
    const root = String(rootFolder || '').trim().replace(/[\\/]+$/g, '');
    const relative = String(relativePath || '').trim().replace(/^[/\\]+/g, '').replace(/\//g, '\\');
    if (!root || !relative) return '';
    return `${root}\\${relative}`;
  };

  const toFileUri = (windowsPath: string): string => {
    const raw = String(windowsPath || '').trim();
    if (/^\\\\[^\\]+\\[^\\]+/.test(raw)) {
      const parts = raw.replace(/^\\\\/, '').split('\\').filter(Boolean);
      const host = parts.shift() || '';
      return `file://${host}/${parts.map((part) => encodeURIComponent(part)).join('/')}`;
    }
    const normalized = raw.replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(normalized)) {
      return `file:///${normalized.split('/').map((part, index) => (index === 0 ? part : encodeURIComponent(part))).join('/')}`;
    }
    return '';
  };

  const officeProtocolForFile = (relativePath: string): string => {
    const extension = String(relativePath || '').split('.').pop()?.toLowerCase() || '';
    if (['doc', 'docx', 'docm', 'rtf'].includes(extension)) return 'ms-word';
    if (['xls', 'xlsx', 'xlsm', 'csv'].includes(extension)) return 'ms-excel';
    if (['ppt', 'pptx', 'pptm'].includes(extension)) return 'ms-powerpoint';
    return '';
  };

  const openCustomerDocument = (customerId: string, relativePath: string, rootFolder = '') => {
    if (!customerId) return;
    const officeProtocol = officeProtocolForFile(relativePath);
    const windowsPath = buildWindowsDocumentPath(rootFolder, relativePath);
    const fileUri = officeProtocol ? toFileUri(windowsPath) : '';
    if (officeProtocol && fileUri) {
      window.location.href = `${officeProtocol}:ofe|u|${fileUri}`;
      return;
    }

    const query = new URLSearchParams({ path: relativePath });
    window.open(`/api/customers/${encodeURIComponent(customerId)}/documents/download?${query.toString()}`, '_blank');
  };

  const openModalDocument = (relativePath: string) => {
    if (!editingCustomer?.id) return;
    openCustomerDocument(editingCustomer.id, relativePath, modalDocsPath || formData.documentsFolder);
  };

  const triggerFinancasAutologin = async (customer: Customer) => {
    const customerId = String(customer?.id || '').trim();
    if (!customerId) return;
    if (autologinBusyCustomerId) return;
    const { username, password } = resolveAtAccessFromCustomer(customer);
    const loginUrl = 'https://www.acesso.gov.pt/v2/loginForm?partID=PFAP';
    const isDesktopShell = Boolean(window.waDesktop?.isDesktop);
    const hasDesktopAutologinApi = typeof window.waDesktop?.financasAutologin === 'function';
    const openLoginWithClipboard = async (messagePrefix: string, includeDesktopHint = false) => {
      window.open(loginUrl, '_blank', 'noopener,noreferrer');

      let clipboardCopied = false;
      if (username && password && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(`Utilizador AT: ${username}\nSenha AT: ${password}`);
          clipboardCopied = true;
        } catch {
          clipboardCopied = false;
        }
      }

      const desktopHint = includeDesktopHint
        ? ' Se estiveres na app WA PRO Desktop, atualiza/reabre a app para ativar o autologin local.'
        : '';

      window.alert(
        clipboardCopied
          ? `${messagePrefix}${desktopHint} Abri o Portal das Finanças no teu browser local e copiei as credenciais AT para colar (Ctrl+V).`
          : `${messagePrefix}${desktopHint} Abri o Portal das Finanças no teu browser local; usa as credenciais AT da ficha do cliente.`
      );
    };

    const showManualPasteHintWithoutOpening = async (messagePrefix: string) => {
      let clipboardCopied = false;
      if (username && password && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(`Utilizador AT: ${username}\nSenha AT: ${password}`);
          clipboardCopied = true;
        } catch {
          clipboardCopied = false;
        }
      }
      window.alert(
        clipboardCopied
          ? `${messagePrefix} O browser já foi aberto; copiei as credenciais AT para colar (Ctrl+V).`
          : `${messagePrefix} O browser já foi aberto; usa as credenciais AT da ficha do cliente.`
      );
    };

    setAutologinBusyCustomerId(customerId);
    try {
      if (!username || !password) {
        throw new Error('Este cliente não tem utilizador/senha AT completos na ficha.');
      }

      const chromeExtensionHandled = await triggerChromeExtensionAutologin({
        username,
        password,
        loginUrl,
        credentialLabel: 'AT',
      });
      if (chromeExtensionHandled) return;

      const localDesktopAutologin = hasDesktopAutologinApi ? window.waDesktop?.financasAutologin : undefined;
      if (localDesktopAutologin) {
        const desktopResult = await localDesktopAutologin({
          username,
          password,
          loginUrl,
          closeAfterSubmit: false,
        });
        if (!desktopResult?.success) {
          const desktopError = String(desktopResult?.error || 'Falha no autologin local.');
          const fallbackReason = classifyAutologinFallbackReason(desktopError);
          if (fallbackReason === 'automation_unavailable') {
            await openLoginWithClipboard(
              'Autologin automático indisponível neste computador (browser de automação não instalado).',
              isDesktopShell
            );
            return;
          }
          if (fallbackReason === 'fields_not_found') {
            await showManualPasteHintWithoutOpening(
              'Não consegui preencher automaticamente os campos de login neste ecrã da AT.'
            );
            return;
          }
          throw new Error(desktopError);
        }
        return;
      }

      if (username && password) {
        try {
          const bridgeResult = await triggerLocalFinancasAutologinBridge({
            username,
            password,
            loginUrl,
            closeAfterSubmit: false,
          });
          if (bridgeResult?.success) {
            return;
          }
        } catch (bridgeError) {
          const bridgeMessage = bridgeError instanceof Error ? bridgeError.message : String(bridgeError || '');
          if (!isLocalAutomationBridgeUnavailable(bridgeMessage)) {
            throw new Error(bridgeMessage || 'Falha no autologin local.');
          }
          await openLoginWithClipboard(
            isDesktopShell
              ? 'Não encontrei o helper local de automação (app desktop possivelmente desatualizada).'
              : 'Não encontrei o helper local de automação neste computador.',
            isDesktopShell
          );
          return;
        }
      }

      await mockService.triggerFinancasAutologin(customerId, {
        headless: false,
        closeAfterSubmit: false,
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Falha ao iniciar autologin do Portal das Finanças.';
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code || '').trim()
          : '';

      if (errorCode === 'NO_GUI_SESSION') {
        await openLoginWithClipboard(
          'O servidor não tem ambiente gráfico para abrir browser.'
        );
      } else if (classifyAutologinFallbackReason(rawMessage) === 'automation_unavailable') {
        await openLoginWithClipboard(
          'Autologin automático indisponível neste computador (browser de automação não instalado).',
          isDesktopShell
        );
      } else if (classifyAutologinFallbackReason(rawMessage) === 'fields_not_found') {
        await showManualPasteHintWithoutOpening(
          'Não consegui preencher automaticamente os campos de login neste ecrã da AT.'
        );
      } else {
        window.alert(rawMessage);
      }
    } finally {
      setAutologinBusyCustomerId(null);
    }
  };

  const handleUpdateCustomerFromAt = async () => {
    if (atProfileBusy) return;
    if (!editingCustomer?.id) {
      window.alert('Guarda primeiro o cliente antes de atualizar pela AT.');
      return;
    }

    setAtProfileBusy(true);
    setFormSavedNotice('A consultar dados na AT pelo Oracle...');
    try {
      const result = await mockService.updateCustomerFromAt(editingCustomer.id);
      const updatedCustomer = result.customer;
      const fields = (result.fields || {}) as FinancasAtProfileFields;
      const updates: FinancasAtProfileFields = {};
      const assignIfFilled = <K extends keyof FinancasAtProfileFields>(key: K) => {
        const value = String(fields[key] || (updatedCustomer as Customer | undefined)?.[key] || '').trim();
        if (value) updates[key] = value as never;
      };
      assignIfFilled('morada');
      assignIfFilled('codigoPostal');
      assignIfFilled('dataNascimento');
      assignIfFilled('dataConstituicao');
      assignIfFilled('inicioAtividade');
      assignIfFilled('tipoIva');
      assignIfFilled('caePrincipal');
      assignIfFilled('caeDescricao');
      assignIfFilled('caeSecundarios');
      assignIfFilled('infoAtividades');
      assignIfFilled('codigoReparticaoFinancas');
      assignIfFilled('tipoContabilidade');
      if (Array.isArray(fields.managers) && fields.managers.length > 0) {
        updates.managers = fields.managers;
      }

      if (updatedCustomer) {
        setEditingCustomer(updatedCustomer);
        setFormData(formStateFromCustomer(updatedCustomer));
        setSavedFormSnapshot(JSON.stringify(formStateFromCustomer(updatedCustomer)));
      } else if (Object.keys(updates).length) {
        setFormData((previous) => ({ ...previous, ...updates }));
      }

      const updatedKeys = Object.keys(updates);
      setFormSavedNotice(
        result.message ||
        (updatedKeys.length
          ? `Dados AT atualizados (${updatedKeys.length} campo(s)).`
          : 'Consulta AT concluída.')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || 'Falha ao atualizar dados pela AT.');
      setFormSavedNotice('');
      window.alert(message);
    } finally {
      setAtProfileBusy(false);
    }
  };

  const triggerSegSocialAutologin = async (customer: Customer) => {
    const customerId = String(customer?.id || '').trim();
    if (!customerId) return;
    if (autologinBusyCustomerId || segSocialAutologinBusyCustomerId) return;
    const { username, password } = resolveSsAccessFromCustomer(customer);
    const loginUrl = SEG_SOCIAL_LOGIN_URL;
    const isDesktopShell = Boolean(window.waDesktop?.isDesktop);
    const hasDesktopAutologinApi = typeof window.waDesktop?.financasAutologin === 'function';
    const openLoginWithClipboard = async (messagePrefix: string, includeDesktopHint = false) => {
      window.open(loginUrl, '_blank', 'noopener,noreferrer');

      let clipboardCopied = false;
      if (username && password && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(`Utilizador SS: ${username}\nSenha SS: ${password}`);
          clipboardCopied = true;
        } catch {
          clipboardCopied = false;
        }
      }

      const desktopHint = includeDesktopHint
        ? ' Se estiveres na app WA PRO Desktop, atualiza/reabre a app para ativar o autologin local.'
        : '';

      window.alert(
        clipboardCopied
          ? `${messagePrefix}${desktopHint} Abri a Segurança Social Direta no teu browser local e copiei as credenciais SS para colar (Ctrl+V).`
          : `${messagePrefix}${desktopHint} Abri a Segurança Social Direta no teu browser local; usa as credenciais SS da ficha do cliente.`
      );
    };

    const showManualPasteHintWithoutOpening = async (messagePrefix: string) => {
      let clipboardCopied = false;
      if (username && password && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(`Utilizador SS: ${username}\nSenha SS: ${password}`);
          clipboardCopied = true;
        } catch {
          clipboardCopied = false;
        }
      }
      window.alert(
        clipboardCopied
          ? `${messagePrefix} O browser já foi aberto; copiei as credenciais SS para colar (Ctrl+V).`
          : `${messagePrefix} O browser já foi aberto; usa as credenciais SS da ficha do cliente.`
      );
    };

    setSegSocialAutologinBusyCustomerId(customerId);
    try {
      if (!username || !password) {
        throw new Error('Este cliente não tem utilizador/senha SS Direta completos na ficha.');
      }


      const chromeExtensionHandled = await triggerChromeExtensionAutologin({
        username,
        password,
        loginUrl,
        credentialLabel: 'SS',
        usernameSelectors: SEG_SOCIAL_USERNAME_SELECTORS,
        passwordSelectors: SEG_SOCIAL_PASSWORD_SELECTORS,
        submitSelectors: SEG_SOCIAL_SUBMIT_SELECTORS,
        successSelectors: SEG_SOCIAL_SUCCESS_SELECTORS,
      });
      if (chromeExtensionHandled) return;
      const localDesktopAutologin = hasDesktopAutologinApi ? window.waDesktop?.financasAutologin : undefined;
      if (localDesktopAutologin) {
        const desktopResult = await localDesktopAutologin({
          username,
          password,
          loginUrl,
          closeAfterSubmit: false,
          credentialLabel: 'SS',
          apiBaseUrl: window.location.origin,
          usernameSelectors: SEG_SOCIAL_USERNAME_SELECTORS,
          passwordSelectors: SEG_SOCIAL_PASSWORD_SELECTORS,
          submitSelectors: SEG_SOCIAL_SUBMIT_SELECTORS,
          successSelectors: SEG_SOCIAL_SUCCESS_SELECTORS,
          activateFinancasNifTab: false,
          timeoutMs: 180000,
        });
        if (!desktopResult?.success) {
          const desktopError = String(desktopResult?.error || 'Falha no autologin local.');
          const fallbackReason = classifyAutologinFallbackReason(desktopError);
          if (fallbackReason === 'automation_unavailable') {
            await openLoginWithClipboard(
              'Autologin automático indisponível neste computador (browser de automação não instalado).',
              isDesktopShell
            );
            return;
          }
          if (fallbackReason === 'fields_not_found') {
            await showManualPasteHintWithoutOpening(
              'Não consegui preencher automaticamente os campos de login neste ecrã da Segurança Social Direta.'
            );
            return;
          }
          throw new Error(desktopError);
        }
        return;
      }

      if (username && password) {
        try {
          const bridgeResult = await triggerLocalFinancasAutologinBridge({
            username,
            password,
            loginUrl,
            closeAfterSubmit: false,
            credentialLabel: 'SS',
            usernameSelectors: SEG_SOCIAL_USERNAME_SELECTORS,
            passwordSelectors: SEG_SOCIAL_PASSWORD_SELECTORS,
            submitSelectors: SEG_SOCIAL_SUBMIT_SELECTORS,
            successSelectors: SEG_SOCIAL_SUCCESS_SELECTORS,
            activateFinancasNifTab: false,
          });
          if (bridgeResult?.success) {
            return;
          }
        } catch (bridgeError) {
          const bridgeMessage = bridgeError instanceof Error ? bridgeError.message : String(bridgeError || '');
          if (!isLocalAutomationBridgeUnavailable(bridgeMessage)) {
            throw new Error(bridgeMessage || 'Falha no autologin local.');
          }
          await openLoginWithClipboard(
            isDesktopShell
              ? 'Não encontrei o helper local de automação (app desktop possivelmente desatualizada).'
              : 'Não encontrei o helper local de automação neste computador.',
            isDesktopShell
          );
          return;
        }
      }

      await mockService.triggerSegSocialAutologin(customerId, {
        headless: false,
        closeAfterSubmit: false,
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Falha ao iniciar autologin da Segurança Social Direta.';
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code || '').trim()
          : '';

      if (errorCode === 'NO_GUI_SESSION') {
        await openLoginWithClipboard(
          'O servidor não tem ambiente gráfico para abrir browser.'
        );
      } else if (classifyAutologinFallbackReason(rawMessage) === 'automation_unavailable') {
        await openLoginWithClipboard(
          'Autologin automático indisponível neste computador (browser de automação não instalado).',
          isDesktopShell
        );
      } else if (classifyAutologinFallbackReason(rawMessage) === 'fields_not_found') {
        await showManualPasteHintWithoutOpening(
          'Não consegui preencher automaticamente os campos de login neste ecrã da Segurança Social Direta.'
        );
      } else {
        window.alert(rawMessage);
      }
    } finally {
      setSegSocialAutologinBusyCustomerId(null);
    }
  };

  const triggerSegSocialSubUserLogin = async (customer: Customer) => {
    const customerId = String(customer?.id || '').trim();
    if (!customerId) return;
    if (autologinBusyCustomerId || segSocialAutologinBusyCustomerId || segSocialSubUserBusyCustomerId || segSocialActivationBusyCustomerId) return;

    const { credential: subCredential, username, password, email } = resolveSsSubUserAccessFromCustomer(customer);
    if (!subCredential || !username) {
      window.alert('Este cliente ainda não tem subutilizador SS na ficha. Primeiro cria a subconta/subutilizador.');
      return;
    }

    const loginUrl = SEG_SOCIAL_LOGIN_URL;
    const isDesktopShell = Boolean(window.waDesktop?.isDesktop);
    const hasDesktopAutologinApi = typeof window.waDesktop?.financasAutologin === 'function';
    let resolvedPassword = String(password || '').trim();

    const saveSubUserPassword = async (nextPassword: string) => {
      const trimmedPassword = String(nextPassword || '').trim();
      if (!trimmedPassword) return;
      const nextCredentials = [...(Array.isArray(customer.accessCredentials) ? customer.accessCredentials : [])];
      const subIndex = nextCredentials.findIndex((credential) => (
        isSegSocialCredential(credential) &&
        normalizeAccessService(String(credential.credentialType || '')).includes('sub')
      ));
      const nextCredential: CustomerAccessCredential = {
        ...(subIndex >= 0 ? nextCredentials[subIndex] : {
          service: 'Segurança Social',
          credentialType: 'subutilizador',
          username,
          emailAssociado: email || 'geral@mpr.pt',
        }),
        service: 'Segurança Social',
        credentialType: 'subutilizador',
        username,
        password: trimmedPassword,
        emailAssociado: email || 'geral@mpr.pt',
        status: 'active',
        observacoes: 'Senha do subutilizador obtida automaticamente por email da Segurança Social.',
      };
      if (subIndex >= 0) nextCredentials[subIndex] = nextCredential;
      else nextCredentials.push(nextCredential);
      const guardedCredentials = preserveExistingCredentialSecrets(nextCredentials, customer.accessCredentials || [], customer.niss || '');
      await mockService.updateCustomer(customerId, { accessCredentials: guardedCredentials }, { syncToSupabase: false });
      setFormData((current) => ({ ...current, accessCredentials: guardedCredentials }));
      setEditingCustomer((current) => current && current.id === customerId ? { ...current, accessCredentials: guardedCredentials } : current);
    };

    const openLoginWithClipboard = async (messagePrefix: string, includeDesktopHint = false) => {
      window.open(loginUrl, '_blank', 'noopener,noreferrer');
      let clipboardCopied = false;
      if (username && resolvedPassword && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(`Subutilizador SS: ${username}\nSenha SS: ${resolvedPassword}`);
          clipboardCopied = true;
        } catch {
          clipboardCopied = false;
        }
      }
      const desktopHint = includeDesktopHint
        ? ' Se estiveres na app WA PRO Desktop, atualiza/reabre a app para ativar o autologin local.'
        : '';
      window.alert(
        clipboardCopied
          ? `${messagePrefix}${desktopHint} Abri a Segurança Social e copiei o subutilizador/senha para colar.`
          : `${messagePrefix}${desktopHint} Abri a Segurança Social; usa o subutilizador da ficha do cliente.`
      );
    };

    const showManualPasteHintWithoutOpening = async (messagePrefix: string) => {
      let clipboardCopied = false;
      if (username && resolvedPassword && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(`Subutilizador SS: ${username}\nSenha SS: ${resolvedPassword}`);
          clipboardCopied = true;
        } catch {
          clipboardCopied = false;
        }
      }
      window.alert(
        clipboardCopied
          ? `${messagePrefix} O browser já foi aberto; copiei o subutilizador/senha para colar.`
          : `${messagePrefix} O browser já foi aberto; usa o subutilizador da ficha do cliente.`
      );
    };

    setSegSocialAutologinBusyCustomerId(customerId);
    try {
      if (!resolvedPassword) {
        const emailResult = await mockService.findLatestSegSocialSubUserPassword({
          username,
          email,
          sinceDays: 30,
          maxMessages: 80,
        });
        if (!emailResult.found || !emailResult.password) {
          throw new Error('Não encontrei no email recente a senha do subutilizador SS. Grava a senha na ficha ou confirma se o email chegou ao geral@mpr.pt.');
        }
        resolvedPassword = emailResult.password;
        await saveSubUserPassword(resolvedPassword);
      }


      const chromeExtensionHandled = await triggerChromeExtensionAutologin({
        username,
        password: resolvedPassword,
        loginUrl,
        credentialLabel: 'SS',
        usernameSelectors: SEG_SOCIAL_USERNAME_SELECTORS,
        passwordSelectors: SEG_SOCIAL_PASSWORD_SELECTORS,
        submitSelectors: SEG_SOCIAL_SUBMIT_SELECTORS,
        successSelectors: SEG_SOCIAL_SUCCESS_SELECTORS,
        keepPendingAfterSubmit: true,
        emailPollMs: 60000,
      });
      if (chromeExtensionHandled) return;
      const localDesktopAutologin = hasDesktopAutologinApi ? window.waDesktop?.financasAutologin : undefined;
      if (localDesktopAutologin) {
        const desktopResult = await localDesktopAutologin({
          username,
          password: resolvedPassword,
          loginUrl,
          closeAfterSubmit: false,
          returnAfterSubmit: false,  // false = espera pelo flow completo incl. 2FA por email
          credentialLabel: 'SS',
          apiBaseUrl: window.location.origin,
          usernameSelectors: SEG_SOCIAL_USERNAME_SELECTORS,
          passwordSelectors: SEG_SOCIAL_PASSWORD_SELECTORS,
          submitSelectors: SEG_SOCIAL_SUBMIT_SELECTORS,
          successSelectors: SEG_SOCIAL_SUCCESS_SELECTORS,
          activateFinancasNifTab: false,
          timeoutMs: 180000,
        });
        if (!desktopResult?.success) {
          const desktopError = String(desktopResult?.error || 'Falha no autologin local.');
          const fallbackReason = classifyAutologinFallbackReason(desktopError);
          if (fallbackReason === 'automation_unavailable') {
            await openLoginWithClipboard(
              'Autologin automático indisponível neste computador (browser de automação não instalado).',
              isDesktopShell
            );
            return;
          }
          if (fallbackReason === 'fields_not_found') {
            await showManualPasteHintWithoutOpening(
              'Não consegui preencher automaticamente os campos de login neste ecrã da Segurança Social Direta.'
            );
            return;
          }
          throw new Error(desktopError);
        }
        return;
      }

      try {
        const bridgeResult = await triggerLocalFinancasAutologinBridge({
          username,
          password: resolvedPassword,
          loginUrl,
          closeAfterSubmit: false,
          returnAfterSubmit: true,
          credentialLabel: 'SS',
          usernameSelectors: SEG_SOCIAL_USERNAME_SELECTORS,
          passwordSelectors: SEG_SOCIAL_PASSWORD_SELECTORS,
          submitSelectors: SEG_SOCIAL_SUBMIT_SELECTORS,
          successSelectors: SEG_SOCIAL_SUCCESS_SELECTORS,
          activateFinancasNifTab: false,
        });
        if (bridgeResult?.success) return;
      } catch (bridgeError) {
        const bridgeMessage = bridgeError instanceof Error ? bridgeError.message : String(bridgeError || '');
        if (!isLocalAutomationBridgeUnavailable(bridgeMessage)) {
          throw new Error(bridgeMessage || 'Falha no autologin local.');
        }
      }

      await openLoginWithClipboard(
        isDesktopShell
          ? 'Não encontrei o helper local de automação.'
          : 'Não encontrei o helper local de automação neste computador.',
        isDesktopShell
      );
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Falha ao entrar com subutilizador SS.';
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code || '').trim()
          : '';

      if (errorCode === 'NO_GUI_SESSION') {
        await openLoginWithClipboard('O servidor não tem ambiente gráfico para abrir browser.');
      } else {
        window.alert(rawMessage);
      }
    } finally {
      setSegSocialAutologinBusyCustomerId(null);
    }
  };

  const triggerSegSocialInteroperabilityInfo = async (
    customer: Customer,
    preferredType: 'chave_aplicacional' | 'token'
  ) => {
    const { username, token, validUntil, label } = resolveSegSocialInteropAccessFromCustomer(customer, preferredType);
    if (!token) {
      window.alert(
        preferredType === 'token'
          ? 'Este cliente ainda não tem token da Plataforma de Interoperabilidade da Segurança Social guardado.'
          : 'Este cliente ainda não tem chave de autenticação aplicacional da Segurança Social guardada.'
      );
      return;
    }

    const usernameNissMatch = String(username || '').trim().match(/^(\d{9,12})-\d+$/);
    const nissEe = normalizeNissDigits(String(customer.niss || '')) || (usernameNissMatch ? usernameNissMatch[1] : normalizeNissDigits(username));
    if (!nissEe) {
      window.alert('Este cliente tem a credencial guardada, mas falta o NISS da entidade empregadora para chamar a API da Segurança Social.');
      return;
    }

    setSegSocialAutologinBusyCustomerId(customer.id);
    try {
      const anoMes = previousMonthAnoMes();
      const result =
        preferredType === 'token'
          ? await mockService.consultarSegSocialValoresApuradosMensalmente(customer.id, { tipo: preferredType, nissEe, anoMes })
          : await mockService.consultarSegSocialValoresComunicados(customer.id, { tipo: preferredType, nissEe });
      const statusText =
        result && typeof result === 'object' && 'status' in result
          ? `\nEstado HTTP: ${String((result as { status?: unknown }).status || '')}`
          : '';
      const validityText = validUntil ? `\nValidade: ${validUntil}` : '';
      const operationText =
        preferredType === 'token'
          ? `\nServiço: Valores apurados mensalmente (${anoMes})`
          : '\nServiço: Valores comunicados por processar';
      window.alert(
        `Chamada direta à API da Segurança Social concluída com sucesso.\n\nTipo: ${label || preferredType}\nUtilizador: ${username || '(sem utilizador associado)'}\nNISS EE: ${nissEe}${operationText}${validityText}${statusText}`
      );
    } catch (error) {
      const typedError = error as Error & { code?: string };
      const code = String(typedError.code || '').trim();
      if (code === 'SEG_SOCIAL_INTEROP_BASE_URL_MISSING') {
        window.alert(
          'A credencial está guardada, mas falta configurar SEG_SOCIAL_INTEROP_BASE_URL no backend com o endereço base oficial da PSi.'
        );
      } else if (code === 'SEG_SOCIAL_INTEROP_PATH_MISSING') {
        window.alert(
          'A credencial está guardada, mas falta configurar no .env o path do serviço PSi que este botão deve testar.\n\nUsa a variável indicada na mensagem do backend/YAML do serviço.'
        );
      } else if (code === 'SEG_SOCIAL_INTEROP_PARAM_MISSING') {
        window.alert(typedError.message || 'Falta um parâmetro obrigatório para a chamada à API da Segurança Social.');
      } else if (code === 'SEG_SOCIAL_SERVICE_NOT_AUTHORIZED') {
        window.alert(
          'A Segurança Social respondeu 403.\n\nIsto significa que o subutilizador/token não tem permissões para este serviço PSi ou para este NISS. Confirma no portal se a subconta tem acesso ao serviço de interoperabilidade que estás a testar.'
        );
      } else if (code === 'SEG_SOCIAL_AUTH_INVALID') {
        window.alert(
          'A Segurança Social respondeu 401.\n\nO token/credencial Basic está inválido, expirado ou com formato errado. Não vou abrir login web nem pedir 2FA; é preciso renovar ou corrigir a credencial.'
        );
      } else {
        window.alert(typedError.message || 'Falha na chamada direta à API da Segurança Social.');
      }
    } finally {
      setSegSocialAutologinBusyCustomerId(null);
    }
  };

  const openSegSocialManualFallback = async (customer: Customer) => {
    const { username, password } = resolveSsPrincipalAccessFromCustomer(customer);
    window.open(SEG_SOCIAL_LOGIN_URL, '_blank', 'noopener,noreferrer');
    let clipboardCopied = false;
    if (username && password && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(`Utilizador SS: ${username}\nSenha SS: ${password}`);
        clipboardCopied = true;
      } catch {
        clipboardCopied = false;
      }
    }
    window.alert(
      clipboardCopied
        ? 'Abri a Segurança Social para uso manual e copiei as credenciais principais para colar. Este botão não faz login automático nem tenta 2FA.'
        : 'Abri a Segurança Social para uso manual. Este botão não faz login automático nem tenta 2FA.'
    );
  };

  const triggerSegSocialSubUserSetup = async (customer: Customer) => {
    const customerId = String(customer?.id || '').trim();
    if (!customerId) return;
    if (autologinBusyCustomerId || segSocialAutologinBusyCustomerId || segSocialSubUserBusyCustomerId) return;

    if (!canUseSegSocialSubUserFlow(customer)) {
      window.alert('Este assistente está disponível apenas para empresas e independentes.');
      return;
    }

    const confirmed = window.confirm(
      'Vou abrir a Segurança Social Direta com a conta principal deste cliente e criar apenas a subconta geral@mpr.pt. Continuar?'
    );
    if (!confirmed) return;

    setSegSocialSubUserBusyCustomerId(customerId);
    try {
      const desktopSetup = window.waDesktop?.financasAutologin;
      if (typeof desktopSetup === 'function') {
        const { username, password } = resolveSsPrincipalAccessFromCustomer(customer);
        if (!username || !password) {
          throw new Error('Este cliente precisa de utilizador/senha principal da Segurança Social antes de criar subutilizador.');
        }
        const niss = normalizeNissDigits(String(customer.niss || ''));
        const subUsername = niss ? `${niss}-1` : 'geral@mpr.pt';
        const validFrom = todayIsoDate();
        const nextCredentials = [...(Array.isArray(customer.accessCredentials) ? customer.accessCredentials : [])];
        const upsertLocalCredential = (next: CustomerAccessCredential) => {
          const service = normalizeAccessService(String(next.service || ''));
          const type = normalizeAccessService(String(next.credentialType || ''));
          const usernameKey = normalizeAccessService(String(next.username || ''));
          const emailKey = normalizeAccessService(String(next.emailAssociado || ''));
          const index = nextCredentials.findIndex((credential) => (
            normalizeAccessService(String(credential.service || '')) === service &&
            normalizeAccessService(String(credential.credentialType || '')) === type &&
            (
              (usernameKey && normalizeAccessService(String(credential.username || '')) === usernameKey) ||
              (emailKey && normalizeAccessService(String(credential.emailAssociado || '')) === emailKey)
            )
          ));
          if (index >= 0) {
            nextCredentials[index] = {
              ...nextCredentials[index],
              ...next,
              password: String(next.password || '').trim() || nextCredentials[index].password || '',
              username: isSegSocialCredential(next)
                ? normalizeStoredSegSocialUsername(String(next.username || nextCredentials[index].username || ''), niss)
                : next.username,
            };
          }
          else nextCredentials.push(next);
        };

        upsertLocalCredential({
          service: 'Segurança Social',
          credentialType: 'subutilizador',
          username: subUsername,
          password: '',
          emailAssociado: 'geral@mpr.pt',
          validFrom,
          validUntil: '',
          status: 'pending',
          observacoes: 'Subconta empresarial preparada pelo assistente local. A senha só deve ser preenchida depois da ativação real.',
        });

        const guardedCredentials = preserveExistingCredentialSecrets(nextCredentials, customer.accessCredentials || [], customer.niss || '');
        await mockService.updateCustomer(customerId, { accessCredentials: guardedCredentials }, { syncToSupabase: false });
        setFormData((current) => ({ ...current, accessCredentials: guardedCredentials }));
        setEditingCustomer((current) => (
          current && current.id === customerId
            ? { ...current, accessCredentials: guardedCredentials }
            : current
        ));

        const desktopResult = await desktopSetup({
          username,
          password,
          loginUrl: SEG_SOCIAL_LOGIN_URL,
          closeAfterSubmit: false,
          credentialLabel: 'SS',
          postLoginFlow: 'seg_social_enterprise_subuser_setup',
          apiBaseUrl: window.location.origin,
          customerName: customer.name,
          customerCompany: customer.company || customer.name,
          customerNif: customer.nif,
          customerNiss: customer.niss,
          subEmail: 'geral@mpr.pt',
          subUsername,
          usernameSelectors: SEG_SOCIAL_USERNAME_SELECTORS,
          passwordSelectors: SEG_SOCIAL_PASSWORD_SELECTORS,
          submitSelectors: SEG_SOCIAL_SUBMIT_SELECTORS,
          successSelectors: SEG_SOCIAL_SUCCESS_SELECTORS,
          activateFinancasNifTab: false,
        });
        if (!desktopResult?.success) {
          throw new Error(String(desktopResult?.error || 'Falha ao abrir automação local da Segurança Social.'));
        }
        const flow = (desktopResult?.postLoginFlow || {}) as {
          createdUsername?: unknown;
          stage?: unknown;
          message?: unknown;
          reason?: unknown;
          success?: unknown;
          lastCompletedStep?: unknown;
        };
        const createdUsername = String(flow.createdUsername || subUsername).trim();
        const createdStage = String(flow.stage || '').trim();
        const flowSucceeded = createdStage === 'subconta_criada' || flow.success === true;
        if (flowSucceeded) {
          const confirmedCredentials = guardedCredentials.map((credential) => {
            const credentialType = normalizeAccessService(String(credential.credentialType || ''));
            if (!isSegSocialCredential(credential) || credentialType !== 'subutilizador') {
              return credential;
            }
            return {
              ...credential,
              username: createdUsername || credential.username,
              password: '',
              status: 'pending_activation',
              observacoes: 'Subconta empresarial criada na Segurança Social. Falta ativar a conta e definir palavra-passe.',
            };
          });
          await mockService.updateCustomer(customerId, { accessCredentials: confirmedCredentials }, { syncToSupabase: false });
          setFormData((current) => ({ ...current, accessCredentials: confirmedCredentials }));
          setEditingCustomer((current) => (
            current && current.id === customerId
              ? { ...current, accessCredentials: confirmedCredentials }
              : current
          ));
        }
        await loadCustomers();
        if (flowSucceeded) {
          window.alert(String(flow.message || `Subconta criada com sucesso para ${customer.company || customer.name}`));
        } else if (String(desktopResult?.loginState || '').trim() === 'MANUAL_REQUIRED') {
          window.alert(String(desktopResult?.manualRequiredReason || flow.reason || 'A Segurança Social pediu intervenção manual. Continua no browser aberto.'));
        } else if (createdStage) {
          window.alert(String(flow.reason || `Não foi possível concluir. Último passo concluído: ${flow.lastCompletedStep ? `passo ${flow.lastCompletedStep}` : 'não identificado'}.`));
        } else {
          window.alert(String(desktopResult?.message || 'Abri a Segurança Social no teu PC e iniciei o assistente empresarial de subconta.'));
        }
        return;
      }

      throw new Error('A criação automática empresarial de subconta requer a app desktop atualizada. Não vou usar o fluxo antigo do servidor para evitar misturar particulares/empresas.');
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'Falha ao iniciar criação de subutilizador SS.';
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code || '').trim()
          : '';
      if (errorCode === 'NO_GUI_SESSION') {
        window.alert('Não vou executar este fluxo em segundo plano no servidor. A criação empresarial da subconta deve correr no browser visível da app desktop para poderes intervir se o portal pedir validação.');
        return;
      }
      window.alert(rawMessage);
    } finally {
      setSegSocialSubUserBusyCustomerId(null);
    }
  };

  const triggerSegSocialActivationSetup = async (customer: Customer) => {
    const customerId = String(customer?.id || '').trim();
    if (!customerId) return;
    if (autologinBusyCustomerId || segSocialAutologinBusyCustomerId || segSocialSubUserBusyCustomerId || segSocialActivationBusyCustomerId) return;

    const credentials = Array.isArray(customer.accessCredentials) ? customer.accessCredentials : [];
    const { credential: subCredential, username, password, email } = resolveSsSubUserAccessFromCustomer(customer);

    if (!subCredential || !username) {
      window.alert('Primeiro cria a subconta empresarial. Este botão não cria subcontas; só ativa/gera token para um subutilizador já existente.');
      return;
    }

    const desktopSetup = window.waDesktop?.financasAutologin;
    if (typeof desktopSetup !== 'function') {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(`Subutilizador Segurança Social: ${username || '(por ativar)'}\nEmail: ${email}`);
        }
      } catch {
        // clipboard is only a convenience
      }
      window.open(SEG_SOCIAL_ACTIVATE_URL, '_blank', 'noopener,noreferrer');
      window.alert(
        username
          ? `Abri a ativação da conta. O subutilizador é ${username}. A partir do CAPTCHA continua manualmente.`
          : 'Abri a ativação da conta. A partir do CAPTCHA continua manualmente.'
      );
      return;
    }

    if (!password) {
      window.alert('A subconta ainda não tem senha guardada. Ativa a conta/define a senha do subutilizador e grava essa senha na ficha antes de usar "Ativar conta/token".');
      return;
    }

    const confirmed = window.confirm(
      'Vou usar apenas o subutilizador já criado para ativar/gerar token e autenticação aplicacional. Este processo não cria subconta nem usa a conta principal. Continuar?'
    );
    if (!confirmed) return;

    setSegSocialActivationBusyCustomerId(customerId);
    try {
      const desktopResult = await desktopSetup({
        username,
        password,
        loginUrl: SEG_SOCIAL_LOGIN_URL,
        closeAfterSubmit: false,
        credentialLabel: 'SS',
        postLoginFlow: 'seg_social_activation_token_setup',
        apiBaseUrl: window.location.origin,
        tokenDescription: 'Contabilidade',
        usernameSelectors: SEG_SOCIAL_USERNAME_SELECTORS,
        passwordSelectors: SEG_SOCIAL_PASSWORD_SELECTORS,
        submitSelectors: SEG_SOCIAL_SUBMIT_SELECTORS,
        successSelectors: SEG_SOCIAL_SUCCESS_SELECTORS,
        activateFinancasNifTab: false,
        timeoutMs: 180000,
      } as Parameters<NonNullable<typeof window.waDesktop>['financasAutologin']>[0]);
      if (!desktopResult?.success) {
        throw new Error(String(desktopResult?.error || 'Falha ao iniciar ativação/token da Segurança Social.'));
      }

      const flow = desktopResult.postLoginFlow || {};
      const token = String((flow as { token?: unknown }).token || '').trim();
      const tokenValidUntil = String((flow as { tokenValidUntil?: unknown }).tokenValidUntil || '').trim() || addMonthsIsoDate(12);
      const rawAppAuth = String((flow as { appAuth?: unknown }).appAuth || '').trim();
      let appAuth = isSafeSegSocialApplicationAuthValue(rawAppAuth) ? rawAppAuth : '';
      if (!appAuth && typeof window.waDesktop?.readClipboardText === 'function') {
        const clipboardText = String(await window.waDesktop.readClipboardText().catch(() => '') || '').trim();
        if (isSafeSegSocialApplicationAuthValue(clipboardText)) {
          appAuth = clipboardText;
        }
      }
      const appAuthValidUntil = String((flow as { appAuthValidUntil?: unknown }).appAuthValidUntil || '').trim() || addMonthsIsoDate(6);

      if (token || appAuth) {
        const nextCredentials = [...credentials];
        const upsertCredential = (next: CustomerAccessCredential) => {
          const service = normalizeAccessService(String(next.service || ''));
          const type = normalizeAccessService(String(next.credentialType || ''));
          const index = nextCredentials.findIndex((credential) => (
            normalizeAccessService(String(credential.service || '')) === service &&
            normalizeAccessService(String(credential.credentialType || '')) === type
          ));
          if (index >= 0) {
            nextCredentials[index] = {
              ...nextCredentials[index],
              ...next,
              password: String(next.password || '').trim() || nextCredentials[index].password || '',
            };
          } else {
            nextCredentials.push(next);
          }
        };

        if (token) {
          upsertCredential({
            service: 'Segurança Social',
            credentialType: 'token',
            username,
            password: token,
            emailAssociado: email,
            validFrom: todayIsoDate(),
            validUntil: tokenValidUntil,
            status: 'active',
            observacoes: 'Token de acesso criado automaticamente na gestão de autenticação da Segurança Social.',
          });
        }
        if (appAuth) {
          upsertCredential({
            service: 'Segurança Social',
            credentialType: 'chave_aplicacional',
            username,
            password: appAuth,
            emailAssociado: email,
            validFrom: todayIsoDate(),
            validUntil: appAuthValidUntil,
            status: 'active',
            observacoes: 'Autenticação aplicacional criada automaticamente na gestão de autenticação da Segurança Social.',
          });
        }

        const guardedCredentials = preserveExistingCredentialSecrets(nextCredentials, customer.accessCredentials || [], customer.niss || '');
        await mockService.updateCustomer(customerId, { accessCredentials: guardedCredentials }, { syncToSupabase: false });
        setFormData((current) => ({ ...current, accessCredentials: guardedCredentials }));
        await loadCustomers();
      }

      if (String(desktopResult.loginState || '') === 'MANUAL_REQUIRED') {
        window.alert(String(desktopResult.manualRequiredReason || (flow as { reason?: unknown }).reason || 'A Segurança Social pediu continuação manual no browser aberto.'));
      } else if (token && appAuth) {
        window.alert('Token de acesso e autenticação aplicacional criados e guardados na ficha do cliente.');
      } else if (token) {
        window.alert('Token de acesso guardado. A autenticação aplicacional ficou pendente no browser aberto.');
      } else {
        window.alert(String((flow as { reason?: unknown }).reason || desktopResult.message || 'Assistente de ativação/token iniciado no browser aberto.'));
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Falha ao ativar conta/token da Segurança Social.');
    } finally {
      setSegSocialActivationBusyCustomerId(null);
    }
  };

  const formatSaftSegSocialSyncMessage = (message: string, summary: {
    requested?: number;
    eligible?: number;
    updated?: number;
    unchanged?: number;
    skippedWithSubuser?: number;
    skippedNonEnterprise?: number;
    skippedNoNif?: number;
    skippedNoSaftMatch?: number;
    skippedNoSegSocialPassword?: number;
    errors?: string[];
    warnings?: string[];
  }): string => {
    const lines = [
      message || 'Sincronização SAFT concluída.',
      '',
      `Atualizados: ${Number(summary.updated || 0)}`,
      `Já estavam iguais: ${Number(summary.unchanged || 0)}`,
      `Ignorados com subutilizador: ${Number(summary.skippedWithSubuser || 0)}`,
      `Ignorados sem NIF: ${Number(summary.skippedNoNif || 0)}`,
      `Não encontrados no SAFT: ${Number(summary.skippedNoSaftMatch || 0)}`,
      `Sem senha SS no SAFT: ${Number(summary.skippedNoSegSocialPassword || 0)}`,
    ];
    if (Number(summary.skippedNonEnterprise || 0) > 0) {
      lines.push(`Ignorados por não serem empresa: ${Number(summary.skippedNonEnterprise || 0)}`);
    }
    const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
    if (warnings.length > 0) {
      lines.push('', `Avisos: ${warnings.slice(0, 5).join(' | ')}${warnings.length > 5 ? ` (+${warnings.length - 5})` : ''}`);
    }
    const errors = Array.isArray(summary.errors) ? summary.errors : [];
    if (errors.length > 0) {
      lines.push('', `Erros: ${errors.slice(0, 5).join(' | ')}${errors.length > 5 ? ` (+${errors.length - 5})` : ''}`);
    }
    return lines.join('\n');
  };

  const syncSegSocialPasswordsFromSaft = async (customer?: Customer) => {
    if (saftSsSyncBusy) return;
    const targetLabel = customer ? (customer.company || customer.name || customer.nif || 'este cliente') : 'todos os clientes empresa sem subutilizador';
    const confirmed = window.confirm(
      customer
        ? `Vou buscar ao SAFTonline a senha da Segurança Social e a validade para ${targetLabel}. Se este cliente já tiver subutilizador completo, não será alterado. Continuar?`
        : 'Vou buscar ao SAFTonline as senhas da Segurança Social e validades para empresas sem subutilizador completo. Pode demorar alguns minutos. Continuar?'
    );
    if (!confirmed) return;

    setSaftSsSyncBusy(true);
    try {
      const result = await mockService.syncSegSocialPasswordsFromSaft({
        customerId: customer?.id,
        headless: true,
        syncToSupabase: true,
      });
      const nextCustomers = await loadCustomers();
      if (customer && showModal) {
        const refreshed =
          (Array.isArray(result.customers) ? result.customers : []).find((item) => item.id === customer.id) ||
          nextCustomers.find((item) => item.id === customer.id);
        if (refreshed) {
          const nextFormState = formStateFromCustomer(refreshed);
          setEditingCustomer(refreshed);
          setFormData(nextFormState);
          setSavedFormSnapshot(serializeCustomerFormState(nextFormState));
          setFormSavedNotice('Dados SS atualizados a partir do SAFTonline.');
        }
      }
      window.alert(formatSaftSegSocialSyncMessage(result.message, result.summary));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Falha ao atualizar senha SS a partir do SAFTonline.');
    } finally {
      setSaftSsSyncBusy(false);
    }
  };

  const openModal = (customer?: Customer) => {
    customerActivityRequestRef.current += 1;
    setActiveTab('dados');
    resetModalDocsState();
    resetSociedadeDocsState();
    resetIngestState();
    setCustomerTasksSummary([]);
    setCustomerOccurrencesSummary([]);
    setCustomerActivityError('');
    setCustomerActivityLoading(false);
    setAgregadoSearchTerms({});
    setFichasSearchTerms({});
    setFormSavedNotice('');

    if (customer) {
      const nextFormState = formStateFromCustomer(customer);
      const initialSnapshot = serializeCustomerFormState(nextFormState);
      setEditingCustomer(customer);
      setFormData(nextFormState);
      setSavedFormSnapshot(initialSnapshot);

      // Ao abrir uma ficha, força uma leitura fresca do servidor.
      // Assim, se outro PC acabou de gravar uma senha/dado, este ecrã não fica preso ao snapshot antigo.
      void (async () => {
        try {
          const directCustomer = await mockService.getCustomerById(customer.id);
          if (directCustomer) {
            const directFormState = formStateFromCustomer(directCustomer);
            const directSnapshot = serializeCustomerFormState(directFormState);
            setEditingCustomer((current) => {
              if (!current) return current;
              return String(current.id || '').trim() === String(customer.id || '').trim() ? directCustomer : current;
            });
            setFormData((current) => (
              serializeCustomerFormState(current) === initialSnapshot ? directFormState : current
            ));
            setSavedFormSnapshot((current) => (
              current === initialSnapshot ? directSnapshot : current
            ));
          }

          const refreshedList = await mockService.refreshCustomersFromServer();
          const deduped = dedupeCustomersForListing(refreshedList);
          setCustomers(deduped);

          const targetId = String(customer.id || '').trim();
          const targetSourceId = String((customer as Customer & { sourceId?: string }).sourceId || '').trim();
          const targetNif = String(customer.nif || '').replace(/\D/g, '').slice(-9);
          const refreshed = deduped.find((item) => {
            if (targetId && String(item.id || '').trim() === targetId) return true;
            if (targetSourceId && String((item as Customer & { sourceId?: string }).sourceId || '').trim() === targetSourceId) return true;
            if (targetNif && String(item.nif || '').replace(/\D/g, '').slice(-9) === targetNif) return true;
            return false;
          });
          if (!refreshed) return;

          const refreshedFormState = formStateFromCustomer(refreshed);
          const refreshedSnapshot = serializeCustomerFormState(refreshedFormState);

          setEditingCustomer((current) => {
            if (!current) return current;
            const currentId = String(current.id || '').trim();
            const currentSourceId = String((current as Customer & { sourceId?: string }).sourceId || '').trim();
            const currentNif = String(current.nif || '').replace(/\D/g, '').slice(-9);
            if (
              (targetId && currentId === targetId) ||
              (targetSourceId && currentSourceId === targetSourceId) ||
              (targetNif && currentNif === targetNif)
            ) {
              return refreshed;
            }
            return current;
          });
          setFormData((current) => (
            serializeCustomerFormState(current) === initialSnapshot ? refreshedFormState : current
          ));
          setSavedFormSnapshot((current) => (
            current === initialSnapshot ? refreshedSnapshot : current
          ));
        } catch (error) {
          console.warn('[Customers] Falha ao refrescar ficha ao abrir:', error);
        }
      })();
    } else {
      const nextFormState = emptyFormState();
      setEditingCustomer(null);
      setFormData(nextFormState);
      setSavedFormSnapshot(serializeCustomerFormState(nextFormState));
    }

    setShowModal(true);
  };

  const doCloseCustomerModal = () => {
    customerActivityRequestRef.current += 1;
    setShowModal(false);
    setShowUnsavedConfirm(false);
    setEditingCustomer(null);
    setFormData(emptyFormState());
    setSavedFormSnapshot('');
    setFormSavedNotice('');
    setSaftSSBusy(false);
    setSupabasePushBusy(false);
    setAgregadoSearchTerms({});
    setFichasSearchTerms({});
    resetModalDocsState();
    resetSociedadeDocsState();
    resetIngestState();
  };

  const closeCustomerModal = (confirmUnsaved = true): boolean => {
    const hasUnsavedChanges = Boolean(
      showModal &&
      savedFormSnapshot &&
      serializeCustomerFormState(formData) !== savedFormSnapshot
    );
    if (confirmUnsaved && hasUnsavedChanges) {
      // Usar diálogo React em vez de window.confirm (que no Electron perde o foco)
      setShowUnsavedConfirm(true);
      return false;
    }
    doCloseCustomerModal();
    return true;
  };

  useEffect(() => {
    if (customers.length === 0 || showModal) return;
    if (typeof window === 'undefined' || !window.localStorage) return;
    const requestedId = String(window.localStorage.getItem(OPEN_CUSTOMER_PROFILE_STORAGE_KEY) || '').trim();
    if (!requestedId) return;
    const target = customers.find((customer) => customer.id === requestedId);
    window.localStorage.removeItem(OPEN_CUSTOMER_PROFILE_STORAGE_KEY);
    if (target) {
      openModal(target);
    }
  }, [customers, showModal]);

  const [supabasePushBusy, setSupabasePushBusy] = React.useState(false);
  const [supabasePushMsg, setSupabasePushMsg] = React.useState('');
  const [saftSSBusy, setSaftSSBusy] = React.useState(false);
  const [saftSSMsg, setSaftSSMsg] = React.useState('');
  const [saftReadBusy, setSaftReadBusy] = React.useState(false);
  const [saftReadMsg, setSaftReadMsg] = React.useState('');
  const [folderEditMode, setFolderEditMode] = React.useState(false);

  const handleReadCredsFromSaft = async () => {
    if (!editingCustomer?.id) return;
    setSaftReadBusy(true);
    setSaftReadMsg('');
    try {
      const res = await fetch(`/api/customers/${encodeURIComponent(editingCustomer.id)}/saftonline/read-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Erro');
      setSaftReadMsg(`✓ ${data.savedCount} importadas`);
      // Forçar reload da BD (bypass cache) para mostrar as novas credenciais
      const refreshed = await mockService.refreshCustomersFromServer();
      setCustomers(dedupeCustomersForListing(refreshed));
      const updated = refreshed.find((c) => String(c.id) === String(editingCustomer.id));
      if (updated) {
        const nextState = formStateFromCustomer(updated);
        setEditingCustomer(updated);
        setFormData(nextState);
        setSavedFormSnapshot(serializeCustomerFormState(nextState));
      }
      setTimeout(() => setSaftReadMsg(''), 4000);
    } catch (err) {
      setSaftReadMsg(err instanceof Error ? err.message.slice(0, 60) : 'Erro');
    } finally {
      setSaftReadBusy(false);
    }
  };

  const handleWriteSSToSaft = async () => {
    if (!editingCustomer?.id) return;
    setSaftSSBusy(true);
    setSaftSSMsg('');
    try {
      const res = await fetch(`/api/customers/${encodeURIComponent(editingCustomer.id)}/saftonline/write-ss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Erro');
      setSaftSSMsg(`✓ ${data.ssUser}`);
      setTimeout(() => setSaftSSMsg(''), 4000);
    } catch (err) {
      setSaftSSMsg(err instanceof Error ? err.message.slice(0, 60) : 'Erro');
    } finally {
      setSaftSSBusy(false);
    }
  };

  // Envia os dados locais para o Supabase — local é master, Supabase só recebe
  const handlePushToSupabase = async () => {
    if (!editingCustomer?.id) return;
    setSupabasePushBusy(true);
    setSupabasePushMsg('');
    try {
      // Usa forceLocalToSupabase=true — envia o que está guardado localmente
      // sem alterar nada no local com base na resposta do Supabase
      await mockService.updateCustomer(editingCustomer.id, {
        ...editingCustomer,
      }, { syncToSupabase: true });
      setSupabasePushMsg('Enviado para Supabase.');
      setTimeout(() => setSupabasePushMsg(''), 3000);
    } catch (err) {
      setSupabasePushMsg(err instanceof Error ? err.message : 'Erro ao enviar');
    } finally {
      setSupabasePushBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const currentCustomerId = String(editingCustomer?.id || '').trim();
    const currentCustomerSourceId = inferCustomerSourceId(editingCustomer);
    const normalizeNif = (value: string): string => normalizeNifDigits(value);

    const sanitizeHousehold = (entries: CustomerHouseholdRelation[]): CustomerHouseholdRelation[] => {
      const allowed = new Set(HOUSEHOLD_RELATION_OPTIONS.map((item) => item.value));
      const seen = new Set<string>();
      const normalized: CustomerHouseholdRelation[] = [];

      entries.forEach((entry) => {
        const resolved = resolveLinkedCustomerByEntry(entry);
        const customerId = String(resolved?.id || entry.customerId || '').trim();
        const customerSourceId = String(entry.customerSourceId || inferCustomerSourceId(resolved) || '').trim();
        const normalizedRelationType = normalizeHouseholdRelationTypeValue(String(entry.relationType || ''));
        const relationType = allowed.has(normalizedRelationType) ? normalizedRelationType : 'outro';
        const note = String(entry.note || '').trim();
        const customerName = String(entry.customerName || resolved?.name || '').trim();
        const customerCompany = String(entry.customerCompany || resolved?.company || '').trim();
        const customerNif = normalizeNif(String(entry.customerNif || resolved?.nif || ''));

        const selfById = currentCustomerId && customerId && currentCustomerId === customerId;
        const selfBySource = currentCustomerSourceId && customerSourceId && currentCustomerSourceId === customerSourceId;
        if (selfById || selfBySource) return;

        const keySeed =
          customerSourceId ||
          customerId ||
          customerNif ||
          `${customerName.toLowerCase()}::${customerCompany.toLowerCase()}`;
        if (!keySeed) return;
        const dedupeKey = `${relationType}::${keySeed}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);

        normalized.push({
          customerId: customerId || undefined,
          customerSourceId: customerSourceId || undefined,
          relationType,
          note: note || undefined,
          customerName: customerName || undefined,
          customerCompany: customerCompany || undefined,
          customerNif: customerNif || undefined,
        });
      });

      return normalized;
    };

    const sanitizeRelated = (entries: CustomerRelatedRecord[]): CustomerRelatedRecord[] => {
      const allowed = new Set(RELATED_RECORD_OPTIONS.map((item) => item.value));
      const seen = new Set<string>();
      const normalized: CustomerRelatedRecord[] = [];

      entries.forEach((entry) => {
        const resolved = resolveLinkedCustomerByEntry(entry);
        const customerId = String(resolved?.id || entry.customerId || '').trim();
        const customerSourceId = String(entry.customerSourceId || inferCustomerSourceId(resolved) || '').trim();
        const relationType = allowed.has(entry.relationType) ? entry.relationType : 'outro';
        const note = String(entry.note || '').trim();
        const customerName = String(entry.customerName || resolved?.name || '').trim();
        const customerCompany = String(entry.customerCompany || resolved?.company || '').trim();
        const customerNif = normalizeNif(String(entry.customerNif || resolved?.nif || ''));

        const selfById = currentCustomerId && customerId && currentCustomerId === customerId;
        const selfBySource = currentCustomerSourceId && customerSourceId && currentCustomerSourceId === customerSourceId;
        if (selfById || selfBySource) return;

        const keySeed =
          customerSourceId ||
          customerId ||
          customerNif ||
          `${customerName.toLowerCase()}::${customerCompany.toLowerCase()}`;
        if (!keySeed) return;
        const dedupeKey = `${relationType}::${keySeed}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);

        normalized.push({
          customerId: customerId || undefined,
          customerSourceId: customerSourceId || undefined,
          relationType,
          note: note || undefined,
          customerName: customerName || undefined,
          customerCompany: customerCompany || undefined,
          customerNif: customerNif || undefined,
        });
      });

      return normalized;
    };

    const agregadoFamiliar = sanitizeHousehold(Array.isArray(formData.agregadoFamiliar) ? formData.agregadoFamiliar : []);
    const fichasRelacionadas = sanitizeRelated(Array.isArray(formData.fichasRelacionadas) ? formData.fichasRelacionadas : []);
    const nextNif = normalizeNif(formData.nif || '');
    const currentNif = normalizeNif(String(editingCustomer?.nif || ''));

    if (nextNif && nextNif !== currentNif && !isValidPortugueseNif(nextNif)) {
      window.alert('NIF inválido. Introduza um NIF português válido com 9 dígitos.');
      return;
    }

    if (editingCustomer?.id && currentNif && isValidPortugueseNif(currentNif) && nextNif !== currentNif) {
      window.alert('Este cliente já tem um NIF válido gravado. O NIF está bloqueado e não pode ser alterado.');
      return;
    }

    const shouldCheckDuplicateNif = Boolean(nextNif && (!editingCustomer?.id || nextNif !== currentNif));
    if (shouldCheckDuplicateNif) {
      const duplicateCustomer = customers.find((customer) => {
        if (String(customer.id || '').trim() === currentCustomerId) return false;
        return normalizeNif(String(customer.nif || '')) === nextNif;
      });
      if (duplicateCustomer) {
        const duplicateLabel = String(duplicateCustomer.company || duplicateCustomer.name || duplicateCustomer.id || '').trim();
        window.alert(`NIF duplicado detetado (${nextNif}) na ficha "${duplicateLabel}".`);
        return;
      }
    }

    const payload = {
      ...formData,
      contactName: String(formData.contactName || '').trim(),
      nif: nextNif,
      ownerId: formData.ownerId || null,
      certidaoPermanenteNumero: String(formData.certidaoPermanenteNumero || '').trim(),
      certidaoPermanenteValidade: String(formData.certidaoPermanenteValidade || '').trim(),
      rcbeNumero: String(formData.rcbeNumero || '').trim(),
      rcbeData: String(formData.rcbeData || '').trim(),
      dataConstituicao: String(formData.dataConstituicao || '').trim(),
      dataNascimento: String(formData.dataNascimento || '').trim(),
      inicioAtividade: String(formData.inicioAtividade || '').trim(),
      caePrincipal: String(formData.caePrincipal || '').trim(),
      caeDescricao: String(formData.caeDescricao || '').trim(),
      caeSecundarios: String(formData.caeSecundarios || '').trim(),
      infoAtividades: String(formData.infoAtividades || '').trim(),
      codigoReparticaoFinancas: String(formData.codigoReparticaoFinancas || '').trim(),
      codigoPostal: String(formData.codigoPostal || '').trim(),
      tipoContabilidade: String(formData.tipoContabilidade || '').trim(),
      estadoCliente: String(formData.estadoCliente || '').trim(),
      contabilistaCertificado: String(formData.contabilistaCertificado || '').trim(),
      notes: String(formData.notes || '').trim(),
      managers: (Array.isArray(formData.managers) ? formData.managers : [])
        .map((manager) => ({
          name: String(manager.name || '').trim(),
          nif: String(manager.nif || '').trim(),
          email: String(manager.email || '').trim(),
          phone: String(manager.phone || '').trim(),
        }))
        .filter((manager) => manager.name || manager.nif || manager.email || manager.phone),
      accessCredentials: preserveExistingCredentialSecrets(
        applyAtUsernameFallback(
          (Array.isArray(formData.accessCredentials) ? formData.accessCredentials : [])
            .map((credential) => ({
              service: String(credential.service || '').trim(),
              username: String(credential.username || '').trim(),
              password: String(credential.password || '').trim(),
              credentialType: String(credential.credentialType || '').trim(),
              emailAssociado: String(credential.emailAssociado || '').trim(),
              validFrom: String(credential.validFrom || '').trim(),
              validUntil: String(credential.validUntil || '').trim(),
              status: String(credential.status || '').trim(),
              observacoes: String(credential.observacoes || '').trim(),
            })),
          nextNif
        )
          .filter((credential) => credential.service || credential.username || credential.password || credential.emailAssociado || credential.validUntil),
        Array.isArray(editingCustomer?.accessCredentials) ? editingCustomer.accessCredentials : [],
        formData.niss || editingCustomer?.niss || ''
      ),
      agregadoFamiliar,
      fichasRelacionadas,
    };

    let savedCustomer: Customer | null = null;
    if (editingCustomer) {
      await mockService.updateCustomer(editingCustomer.id, payload);
      const refreshedCustomers = await loadCustomers();
      savedCustomer =
        refreshedCustomers.find((customer) => String(customer.id || '') === String(editingCustomer.id || '')) ||
        ({ ...editingCustomer, ...payload } as Customer);
    } else {
      const syncToSupabase = window.confirm('Também quer adicionar este cliente no MPR Control (Supabase)?\n\nOK = Sim\nCancelar = Só local');
      const createdCustomer = await mockService.createCustomer(payload, { syncToSupabase });
      const refreshedCustomers = await loadCustomers();
      savedCustomer =
        refreshedCustomers.find((customer) => String(customer.id || '') === String(createdCustomer.id || '')) ||
        createdCustomer;
    }

    if (savedCustomer) {
      const nextFormState = formStateFromCustomer(savedCustomer);
      setEditingCustomer(savedCustomer);
      setFormData(nextFormState);
      setSavedFormSnapshot(serializeCustomerFormState(nextFormState));
      setFormSavedNotice('Guardado. Pode continuar a editar a ficha.');
    }
  };

  const addSubContact = () => {
    setFormData({
      ...formData,
      contacts: [...formData.contacts, { name: '', phone: '' }],
    });
  };

  const updateSubContact = (index: number, field: keyof SubContact, value: string) => {
    const newContacts = [...formData.contacts];
    newContacts[index][field] = value;
    setFormData({ ...formData, contacts: newContacts });
  };

  const removeSubContact = (index: number) => {
    const newContacts = formData.contacts.filter((_, i) => i !== index);
    setFormData({ ...formData, contacts: newContacts });
  };

  const addManager = () => {
    setFormData({
      ...formData,
      managers: [...formData.managers, { name: '', nif: '', email: '', phone: '' }],
    });
  };

  const updateManager = (index: number, field: keyof CustomerManager, value: string) => {
    const nextManagers = [...formData.managers];
    nextManagers[index] = { ...nextManagers[index], [field]: value };
    setFormData({ ...formData, managers: nextManagers });
  };

  const removeManager = (index: number) => {
    const nextManagers = formData.managers.filter((_, i) => i !== index);
    setFormData({ ...formData, managers: nextManagers });
  };

  const copyCustomerNif = async () => {
    const nif = normalizeNifDigits(formData.nif || '');
    if (!nif) return;

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(nif);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = nif;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setFormSavedNotice('NIF copiado.');
    } catch {
      window.alert('Não foi possível copiar o NIF.');
    }
  };

  const openCustomerDocumentsFolder = async () => {
    const folderPath = String(formData.documentsFolder || '').trim();
    if (!folderPath) {
      window.alert('Esta ficha não tem pasta de documentos definida.');
      return;
    }
    if (typeof window.waDesktop?.openFolder !== 'function') {
      window.alert('Para abrir a pasta no explorador, atualize o WA PRO desktop e volte a abrir a aplicação.');
      return;
    }

    const result = await window.waDesktop.openFolder(folderPath).catch((error) => ({
      success: false,
      error: error instanceof Error ? error.message : 'Não foi possível abrir a pasta.',
    }));
    if (!result?.success) {
      window.alert(result?.error || 'Não foi possível abrir a pasta.');
    }
  };

  const addAccessCredential = () => {
    setFormData((current) => ({
      ...current,
      accessCredentials: [...current.accessCredentials, { service: '', username: '', password: '', credentialType: '', emailAssociado: '', validFrom: '', validUntil: '', status: 'active', observacoes: '' }],
    }));
  };

  const addSegSocialCredential = (credentialType: 'principal' | 'subutilizador') => {
    const isSubUser = credentialType === 'subutilizador';
    const validFrom = todayIsoDate();
    setFormData({
      ...formData,
      accessCredentials: [
        ...formData.accessCredentials,
        {
          service: 'Segurança Social',
          credentialType,
          username: isSubUser ? formData.email || '' : formData.niss || '',
          password: '',
          emailAssociado: isSubUser ? formData.email || '' : '',
          validFrom,
          validUntil: isSubUser ? addMonthsIsoDate(6) : '',
          status: isSubUser ? 'pending' : 'active',
          observacoes: isSubUser ? 'Subutilizador Segurança Social com validade de 6 meses.' : '',
        },
      ],
    });
  };

  const addSegSocialSecurityCredential = (credentialType: '2fa' | 'chave_aplicacional') => {
    const validFrom = todayIsoDate();
    setFormData({
      ...formData,
      accessCredentials: [
        ...formData.accessCredentials,
        {
          service: 'Segurança Social',
          credentialType,
          username: credentialType === 'chave_aplicacional' ? 'niss-1' : '',
          password: '',
          emailAssociado: 'geral@mpr.pt',
          validFrom,
          validUntil: credentialType === 'chave_aplicacional' ? addMonthsIsoDate(6) : '',
          status: credentialType === '2fa' ? 'pending' : 'active',
          observacoes:
            credentialType === '2fa'
              ? 'Estado do duplo fator de autenticação do subutilizador.'
              : 'Chave de autenticação aplicacional válida por 6 meses.',
        },
      ],
    });
  };

  const updateAccessCredential = (index: number, field: keyof CustomerAccessCredential, value: string) => {
    setFormData((current) => {
      const nextCredentials = [...current.accessCredentials];
      if (!nextCredentials[index]) return current;
      nextCredentials[index] = { ...nextCredentials[index], [field]: value };
      return { ...current, accessCredentials: nextCredentials };
    });
  };

  const removeAccessCredential = (index: number) => {
    setFormData((current) => ({
      ...current,
      accessCredentials: current.accessCredentials.filter((_, i) => i !== index),
    }));
  };

  const credentialPresets: readonly CustomerCredentialPreset[] = [
    { key: 'at', label: 'Autoridade Tributária', icon: 'AT', service: 'AT', credentialType: 'principal', usernameFallback: formData.nif || '', passwordFallback: formData.senhaFinancas || '', validity: false },
    { key: 'ss_principal', label: 'Seg. Social conta principal', icon: 'SS', service: 'SS', credentialType: 'principal', usernameFallback: formData.niss || '', passwordFallback: formData.senhaSegurancaSocial || '', validity: true },
    { key: 'ss_sub', label: 'Seg. Social Autenticação Utilizador', icon: 'SS', service: 'Segurança Social', credentialType: 'subutilizador', usernameFallback: formData.niss ? `${normalizeNissDigits(formData.niss)}-1` : '', passwordFallback: '', validity: false },
    { key: 'ss_2fa', label: 'Seg. Social Duplo Fator', icon: 'SS', service: 'Segurança Social', credentialType: '2fa', usernameFallback: formData.niss ? `${normalizeNissDigits(formData.niss)}-1` : '', passwordFallback: '', validity: false },
    { key: 'ss_app', label: 'Seg. Social Autenticação Aplicacional', icon: 'SS', service: 'Segurança Social', credentialType: 'chave_aplicacional', usernameFallback: formData.niss ? `${normalizeNissDigits(formData.niss)}-1` : '', passwordFallback: '', validity: true },
    { key: 'ru', label: 'Relatório Único', icon: 'RU', service: 'RU', credentialType: '', usernameFallback: '', passwordFallback: '', validity: false },
    { key: 'viactt', label: 'Via CTT', icon: 'CTT', service: 'ViaCTT', credentialType: '', usernameFallback: '', passwordFallback: '', validity: false },
    { key: 'iapmei', label: 'IAPMEI', icon: 'IP', service: 'IAPMEI', credentialType: '', usernameFallback: formData.nif || '', passwordFallback: '', validity: false },
    { key: 'ss_interop', label: 'Seg. Social Plataforma Interoperabilidade', icon: 'SS', service: 'Segurança Social', credentialType: 'token', usernameFallback: formData.niss ? `${normalizeNissDigits(formData.niss)}-1` : '', passwordFallback: '', validity: true },
    { key: 'iefp', label: 'IEFP Online', icon: 'IEFP', service: 'IEFP', credentialType: 'principal', usernameFallback: '', passwordFallback: '', validity: false },
    { key: 'balcao2020', label: 'Balcão 2020', icon: 'B20', service: 'Balcão 2020', credentialType: 'principal', usernameFallback: formData.nif || '', passwordFallback: '', validity: false },
    { key: 'ine', label: 'INE', icon: 'INE', service: 'INE', credentialType: 'principal', usernameFallback: '', passwordFallback: '', validity: false },
    { key: 'siliamb', label: 'SILIAMB', icon: 'SLB', service: 'SILIAMB', credentialType: 'principal', usernameFallback: formData.nif || '', passwordFallback: '', validity: false },
    { key: 'livrorec', label: 'Livro de Reclamações', icon: 'LR', service: 'Livro de Reclamações', credentialType: 'principal', usernameFallback: '', passwordFallback: '', validity: false },
    { key: 'act', label: 'ACT', icon: 'ACT', service: 'ACT', credentialType: 'principal', usernameFallback: '', passwordFallback: '', validity: false },
  ];

  const credentialMatchesPresetService = (
    credential: CustomerAccessCredential,
    preset: CustomerCredentialPreset
  ): boolean => {
    const presetService = normalizeAccessService(String(preset.service || ''));
    const credentialService = normalizeAccessService(String(credential.service || ''));
    if (presetService === 'ss' || presetService.includes('seguranca social') || presetService.includes('seg_social')) {
      return isSegSocialCredential(credential);
    }
    if (presetService === 'at' || presetService.includes('autoridade') || presetService.includes('financ')) {
      return credentialService === 'at' || credentialService.includes('autoridade') || credentialService.includes('financ');
    }
    return normalizeAccessIdentity(String(credential.service || '')) === normalizeAccessIdentity(preset.service);
  };

  const findCredentialIndexForPreset = (preset: CustomerCredentialPreset) => {
    return formData.accessCredentials.findIndex((credential) => (
      credentialMatchesPresetService(credential, preset) &&
      accessTypeMatchesPreset(String(credential.credentialType || ''), preset.credentialType)
    ));
  };

  const credentialForPreset = (preset: CustomerCredentialPreset): CustomerAccessCredential => {
    const index = findCredentialIndexForPreset(preset);
    if (index >= 0) return formData.accessCredentials[index];
    return {
      service: preset.service,
      credentialType: preset.credentialType,
      username: preset.usernameFallback,
      password: preset.passwordFallback,
      emailAssociado: '',
      validFrom: '',
      validUntil: '',
      status: 'active',
      observacoes: '',
    };
  };

  const updateCredentialPreset = (
    preset: CustomerCredentialPreset,
    field: keyof CustomerAccessCredential,
    value: string
  ) => {
    const index = findCredentialIndexForPreset(preset);
    const nextCredentials = [...formData.accessCredentials];
    const current = index >= 0 ? nextCredentials[index] : credentialForPreset(preset);
    const nextCredential = {
      ...current,
      service: preset.service,
      credentialType: preset.credentialType,
      [field]: value,
    };
    if (index >= 0) nextCredentials[index] = nextCredential;
    else nextCredentials.push(nextCredential);

    setFormData({
      ...formData,
      accessCredentials: nextCredentials,
      senhaFinancas: preset.key === 'at' && field === 'password' ? value : formData.senhaFinancas,
      senhaSegurancaSocial: preset.key === 'ss_principal' && field === 'password' ? value : formData.senhaSegurancaSocial,
      nif: preset.key === 'at' && field === 'username' ? value : formData.nif,
      niss: preset.key === 'ss_principal' && field === 'username' ? value : formData.niss,
    });
  };

  const removeCredentialPreset = (preset: CustomerCredentialPreset) => {
    const index = findCredentialIndexForPreset(preset);
    if (index < 0) return;
    const nextCredentials = formData.accessCredentials.filter((_, i) => i !== index);
    setFormData({ ...formData, accessCredentials: nextCredentials });
  };

  const isCredentialCoveredByPreset = (credential: CustomerAccessCredential) => credentialPresets.some((preset) => (
    credentialMatchesPresetService(credential, preset) &&
    accessTypeMatchesPreset(String(credential.credentialType || ''), preset.credentialType)
  ));

  const customAccessCredentialIndexes = formData.accessCredentials
    .map((credential, index) => ({ credential, index }))
    .filter(({ credential }) => !isCredentialCoveredByPreset(credential));

  const inferCustomerSourceId = (customer?: Customer | null): string => {
    const explicit = String(customer?.sourceId || '').trim();
    if (explicit) return explicit;
    const id = String(customer?.id || '').trim();
    if (id.startsWith('ext_c_')) return id.slice(6);
    return '';
  };

  const resolveLinkedCustomerByEntry = (
    entry: Pick<CustomerHouseholdRelation, 'customerId' | 'customerSourceId'>
  ): Customer | null => {
    const byId = String(entry.customerId || '').trim();
    if (byId) {
      const direct = customers.find((customer) => customer.id === byId);
      if (direct) return direct;
      const idAsSource = byId.startsWith('ext_c_') ? byId.slice(6) : byId;
      const fromIdAsSource = customers.find((customer) => inferCustomerSourceId(customer) === idAsSource);
      if (fromIdAsSource) return fromIdAsSource;
    }

    const bySourceId = String(entry.customerSourceId || '').trim();
    if (!bySourceId) return null;
    return (
      customers.find((customer) => inferCustomerSourceId(customer) === bySourceId) || null
    );
  };

  const addAgregadoFamiliar = () => {
    setFormData((prev) => ({
      ...prev,
      agregadoFamiliar: [
        ...prev.agregadoFamiliar,
        { customerId: '', customerSourceId: '', relationType: 'conjuge', note: '' },
      ],
    }));
  };

  const updateAgregadoFamiliar = (
    index: number,
    field: keyof CustomerHouseholdRelation,
    value: string
  ) => {
    const nextItems = [...formData.agregadoFamiliar];
    const current = { ...(nextItems[index] || { relationType: 'conjuge' }) };

    if (field === 'customerId') {
      const selected = customers.find((customer) => customer.id === value) || null;
      if (!selected) {
        current.customerId = undefined;
        current.customerSourceId = undefined;
        current.customerName = undefined;
        current.customerCompany = undefined;
        current.customerNif = undefined;
      } else {
        current.customerId = value || undefined;
        current.customerSourceId = inferCustomerSourceId(selected) || undefined;
        current.customerName = selected?.name || undefined;
        current.customerCompany = selected?.company || undefined;
        current.customerNif = selected?.nif || undefined;
      }
    } else if (field === 'relationType') {
      current.relationType = normalizeHouseholdRelationTypeValue(value);
    } else if (field === 'note') {
      current.note = value || undefined;
    }

    nextItems[index] = current;
    setFormData({ ...formData, agregadoFamiliar: nextItems });
  };

  const removeAgregadoFamiliar = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      agregadoFamiliar: prev.agregadoFamiliar.filter((_, i) => i !== index),
    }));
    setAgregadoSearchTerms((prev) => removeIndexedSearchTerm(prev, index));
  };

  const addFichaRelacionada = () => {
    setFormData((prev) => ({
      ...prev,
      fichasRelacionadas: [
        ...prev.fichasRelacionadas,
        { customerId: '', customerSourceId: '', relationType: 'funcionario', note: '' },
      ],
    }));
  };

  const updateFichaRelacionada = (
    index: number,
    field: keyof CustomerRelatedRecord,
    value: string
  ) => {
    const nextItems = [...formData.fichasRelacionadas];
    const current = { ...(nextItems[index] || { relationType: 'funcionario' }) };

    if (field === 'customerId') {
      const selected = customers.find((customer) => customer.id === value) || null;
      if (!selected) {
        current.customerId = undefined;
        current.customerSourceId = undefined;
        current.customerName = undefined;
        current.customerCompany = undefined;
        current.customerNif = undefined;
      } else {
        current.customerId = value || undefined;
        current.customerSourceId = inferCustomerSourceId(selected) || undefined;
        current.customerName = selected?.name || undefined;
        current.customerCompany = selected?.company || undefined;
        current.customerNif = selected?.nif || undefined;
      }
    } else if (field === 'relationType') {
      current.relationType = (value as CustomerRelatedRecord['relationType']) || 'outro';
    } else if (field === 'note') {
      current.note = value || undefined;
    }

    nextItems[index] = current;
    setFormData({ ...formData, fichasRelacionadas: nextItems });
  };

  const removeFichaRelacionada = (index: number) => {
    setFormData((prev) => ({
      ...prev,
      fichasRelacionadas: prev.fichasRelacionadas.filter((_, i) => i !== index),
    }));
    setFichasSearchTerms((prev) => removeIndexedSearchTerm(prev, index));
  };

  const openRelatedCustomerProfile = (customer: Customer | null) => {
    if (!customer?.id) return;
    if (editingCustomer?.id === customer.id) return;
    const customerLabel = buildRelationCustomerLabel(customer) || customer.id;
    const canSwitch = window.confirm(
      `Abrir a ficha de "${customerLabel}"?\n\nAs alterações não gravadas na ficha atual serão perdidas.`
    );
    if (!canSwitch) return;
    setEditingCustomer(customer);
    setFormData(formStateFromCustomer(customer));
    setActiveTab('relacoes');
    setAgregadoSearchTerms({});
    setFichasSearchTerms({});
  };

  const getCustomerStatus = (customer: Customer): string => {
    const lookup = buildImportedLookup((customer.supabasePayload as Record<string, unknown>) || undefined);
    const sourceStatus = pickImportedValue(lookup, ['estado', 'status']);
    return normalizeStatus(sourceStatus);
  };

  const segSocialSubUserCounts = useMemo(() => {
    return customers.reduce(
      (acc, customer) => {
        acc[getSegSocialSubUserState(customer)] += 1;
        return acc;
      },
      {
        COM_SUBUTILIZADOR: 0,
        INCOMPLETO: 0,
        SEM_SUBUTILIZADOR: 0,
      } as Record<SegSocialSubUserState, number>
    );
  }, [customers]);

  const filteredCustomers = customers.filter((customer) => {
    const term = searchTerm.trim().toLowerCase();
    if (term) {
      const matchesTerm =
        customer.name.toLowerCase().includes(term) ||
        customer.company.toLowerCase().includes(term) ||
        customer.phone.toLowerCase().includes(term) ||
        (customer.email || '').toLowerCase().includes(term) ||
        (customer.nif || '').toLowerCase().includes(term) ||
        (customer.niss || '').toLowerCase().includes(term) ||
        (customer.morada || '').toLowerCase().includes(term) ||
        (customer.documentsFolder || '').toLowerCase().includes(term);
      if (!matchesTerm) return false;
    }

    if (stateFilter !== 'TODOS' && getCustomerStatus(customer) !== stateFilter) return false;
    if (typeFilter !== 'TODOS' && String(customer.type) !== typeFilter) return false;
    if (ownerFilter !== 'TODOS' && String(customer.ownerId || '') !== ownerFilter) return false;
    if (subUserFilter !== 'TODOS' && getSegSocialSubUserState(customer) !== subUserFilter) return false;

    return true;
  });

  const toggleSort = (nextKey: CustomerSortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(nextKey);
    setSortDirection('asc');
  };

  const sortIndicator = (key: CustomerSortKey): string => {
    if (sortKey !== key) return '↕';
    return sortDirection === 'asc' ? '▲' : '▼';
  };

  const sortedCustomers = useMemo(() => {
    const ownerNameById = new Map(users.map((user) => [user.id, user.name]));
    const normalizeText = (value: string) =>
      String(value || '')
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

    const compareText = (left: string, right: string) =>
      normalizeText(left).localeCompare(normalizeText(right), 'pt-PT', {
        sensitivity: 'base',
        numeric: true,
      });

    const sorted = [...filteredCustomers].sort((left, right) => {
      let comparison = 0;

      if (sortKey === 'nif') {
        const leftNif = String(left.nif || '').replace(/\D/g, '');
        const rightNif = String(right.nif || '').replace(/\D/g, '');
        comparison = compareText(leftNif, rightNif);
      } else if (sortKey === 'name') {
        comparison = compareText(left.company || left.name, right.company || right.name);
      } else if (sortKey === 'type') {
        comparison = compareText(left.type, right.type);
      } else if (sortKey === 'email') {
        comparison = compareText(left.email || '', right.email || '');
      } else if (sortKey === 'phone') {
        comparison = compareText(left.phone || '', right.phone || '');
      } else if (sortKey === 'owner') {
        comparison = compareText(ownerNameById.get(left.ownerId || '') || '', ownerNameById.get(right.ownerId || '') || '');
      } else if (sortKey === 'status') {
        comparison = compareText(getCustomerStatus(left), getCustomerStatus(right));
      } else if (sortKey === 'subuser') {
        comparison = compareText(getSegSocialSubUserState(left), getSegSocialSubUserState(right));
      }

      if (comparison === 0) {
        comparison = compareText(left.company || left.name, right.company || right.name);
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return sorted;
  }, [filteredCustomers, getCustomerStatus, getSegSocialSubUserState, sortDirection, sortKey, users]);

  const selectableRelationCustomers = useMemo(() => {
    const currentId = String(editingCustomer?.id || '').trim();
    return customers.filter((customer) => String(customer.id || '').trim() !== currentId);
  }, [customers, editingCustomer?.id]);

  const editingCustomerDisplayName = useMemo(() => {
    const name = String(formData.name || editingCustomer?.name || '').trim();
    const company = String(formData.company || editingCustomer?.company || '').trim();
    if (name) return name;
    if (company) return company;
    const sourceId = String(editingCustomer?.sourceId || '').trim();
    const localId = String(editingCustomer?.id || '').trim();
    if (sourceId) return `ID ${sourceId}`;
    if (localId) return `ID ${localId}`;
    return 'Cliente sem identificação';
  }, [
    formData.name,
    formData.company,
    editingCustomer?.name,
    editingCustomer?.company,
    editingCustomer?.sourceId,
    editingCustomer?.id,
  ]);

  const lockedNif = useMemo(() => normalizeNifDigits(String(editingCustomer?.nif || '')), [editingCustomer?.nif]);
  const isNifLocked = useMemo(
    () => Boolean(editingCustomer?.id && lockedNif && isValidPortugueseNif(lockedNif)),
    [editingCustomer?.id, lockedNif]
  );

  const taskOpenCount = useMemo(
    () => customerTasksSummary.filter((task) => String(task.status || '').toUpperCase() !== 'DONE').length,
    [customerTasksSummary]
  );
  const taskClosedCount = customerTasksSummary.length - taskOpenCount;

  const occurrenceClosedCount = useMemo(
    () => customerOccurrencesSummary.filter((item) => String(item.state || '').toUpperCase() === 'RESOLVIDA').length,
    [customerOccurrencesSummary]
  );
  const occurrenceOpenCount = customerOccurrencesSummary.length - occurrenceClosedCount;

  const importedPayload = useMemo(() => {
    if (!editingCustomer?.supabasePayload || typeof editingCustomer.supabasePayload !== 'object') return undefined;
    return editingCustomer.supabasePayload as Record<string, unknown>;
  }, [editingCustomer]);

  const editingSegSocialSubUserState = useMemo(
    () => getSegSocialSubUserStateFromCredentials(Array.isArray(formData.accessCredentials) ? formData.accessCredentials : []),
    [formData.accessCredentials]
  );

  const importedLookup = useMemo(() => buildImportedLookup(importedPayload), [importedPayload]);

  const importedFields = useMemo(() => {
    const fields = [
      { label: 'Morada', value: pickImportedValue(importedLookup, ['morada', 'address']) },
      { label: 'Código Postal', value: pickImportedValue(importedLookup, ['codigo_postal', 'cod_postal', 'cp']) },
      { label: 'Localidade', value: pickImportedValue(importedLookup, ['localidade']) },
      { label: 'Concelho', value: pickImportedValue(importedLookup, ['concelho']) },
      { label: 'Distrito', value: pickImportedValue(importedLookup, ['distrito']) },
      { label: 'Freguesia', value: pickImportedValue(importedLookup, ['freguesia']) },
      { label: 'CAE Principal', value: pickImportedValue(importedLookup, ['cae_principal', 'cae']) },
      { label: 'Data Constituição', value: pickImportedValue(importedLookup, ['data_constituicao']) },
      { label: 'Início Atividade', value: pickImportedValue(importedLookup, ['inicio_atividade', 'data_inicio_atividade']) },
      { label: 'Certidão Permanente (nº)', value: pickImportedValue(importedLookup, ['certidao_permanente_numero', 'certidao_permanente_n', 'certidao_permanente']) },
      { label: 'Certidão Permanente (validade)', value: pickImportedValue(importedLookup, ['certidao_permanente_validade', 'validade_certidao_permanente']) },
      { label: 'RCBE (nº)', value: pickImportedValue(importedLookup, ['rcbe_numero', 'rcbe_n', 'rcbe']) },
      { label: 'RCBE (data)', value: pickImportedValue(importedLookup, ['rcbe_data']) },
      { label: 'Código Repartição Finanças', value: pickImportedValue(importedLookup, ['codigo_reparticao_financas', 'reparticao_financas']) },
      { label: 'Tipo Entidade', value: pickImportedValue(importedLookup, ['tipo_entidade']) },
      { label: 'Tipo Contabilidade', value: pickImportedValue(importedLookup, ['tipo_contabilidade']) },
      { label: 'Estado', value: pickImportedValue(importedLookup, ['estado']) },
      { label: 'Contabilista Certificado', value: pickImportedValue(importedLookup, ['contabilista_certificado_nome', 'contabilista_certificado']) },
    ];
    return fields.filter((item) => item.value);
  }, [importedLookup]);

  const importedAccesses = useMemo(() => {
    const accesses = [
      { label: 'Utilizador AT', value: pickImportedValue(importedLookup, ['utilizador_at']) },
      { label: 'Password AT', value: pickImportedValue(importedLookup, ['password_at']) },
      { label: 'Utilizador SS', value: pickImportedValue(importedLookup, ['utilizador_ss']) },
      { label: 'Password SS', value: pickImportedValue(importedLookup, ['password_ss']) },
      { label: 'Utilizador RU', value: pickImportedValue(importedLookup, ['utilizador_ru']) },
      { label: 'Password RU', value: pickImportedValue(importedLookup, ['password_ru']) },
      { label: 'Utilizador ViaCTT', value: pickImportedValue(importedLookup, ['utilizador_viactt']) },
      { label: 'Password ViaCTT', value: pickImportedValue(importedLookup, ['password_viactt']) },
      { label: 'Utilizador IAPMEI', value: pickImportedValue(importedLookup, ['utilizador_iapmei']) },
      { label: 'Password IAPMEI', value: pickImportedValue(importedLookup, ['password_iapmei']) },
    ];
    return accesses.filter((item) => item.value);
  }, [importedLookup]);

  const importedRawEntries = useMemo(() => {
    if (!importedPayload) return [];
    return Object.entries(importedPayload)
      .map(([key, value]) => ({ key, value: formatImportedValue(value) }))
      .filter((entry) => entry.value);
  }, [importedPayload]);

  return (
    <div className="p-4 md:p-6 w-full space-y-4">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 md:p-5 text-white shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h1 className="text-xl md:text-2xl font-bold">Clientes</h1>
            <p className="text-xs md:text-sm text-slate-200">Gestão e consulta da carteira de clientes.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void syncSegSocialPasswordsFromSaft()}
              disabled={saftSsSyncBusy}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60 text-white text-xs md:text-sm font-semibold"
            >
              <RefreshCw size={16} className={saftSsSyncBusy ? 'animate-spin' : ''} />
              {saftSsSyncBusy ? 'A atualizar SS...' : 'Atualizar SS SAFT'}
            </button>
            <button
              onClick={openHeaderIngestModal}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs md:text-sm font-semibold"
            >
              <Upload size={16} />
              Adicionar Documento
            </button>
            <button
              onClick={() => openModal()}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs md:text-sm font-semibold"
            >
              <Plus size={16} />
              Novo Cliente
            </button>
          </div>
        </div>
      </div>

      <CustomersListPanel
        customers={sortedCustomers}
        users={users}
        searchTerm={searchTerm}
        stateFilter={stateFilter}
        typeFilter={typeFilter}
        ownerFilter={ownerFilter}
        subUserFilter={subUserFilter}
        segSocialSubUserCounts={segSocialSubUserCounts}
        autologinBusyCustomerId={autologinBusyCustomerId}
        segSocialAutologinBusyCustomerId={segSocialAutologinBusyCustomerId}
        segSocialSubUserBusyCustomerId={segSocialSubUserBusyCustomerId}
        segSocialActivationBusyCustomerId={segSocialActivationBusyCustomerId}
        setSearchTerm={setSearchTerm}
        setStateFilter={setStateFilter}
        setTypeFilter={setTypeFilter}
        setOwnerFilter={setOwnerFilter}
        setSubUserFilter={setSubUserFilter}
        toggleSort={toggleSort}
        sortIndicator={sortIndicator}
        getCustomerStatus={getCustomerStatus}
        openCustomer={openModal}
        triggerFinancasAutologin={triggerFinancasAutologin}
        triggerSegSocialSubUserLogin={triggerSegSocialSubUserLogin}
      />

      {showHeaderIngestModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Adicionar Documento (IA)</h2>
                <p className="text-xs text-slate-500">
                  Escolha o cliente e o tipo de documento para analisar e guardar em <span className="font-mono">Documentos Oficiais</span>.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowHeaderIngestModal(false);
                  resetHeaderIngestState();
                }}
                className="px-3 py-1.5 text-xs border rounded-md bg-white hover:bg-slate-50"
              >
                Fechar
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Cliente</label>
                <select
                  value={headerIngestCustomerId}
                  onChange={(e) => setHeaderIngestCustomerId(e.target.value)}
                  className="w-full border border-slate-200 rounded-md p-2 text-sm bg-white"
                >
                  <option value="">Deteção automática por NIF (IA)</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.company || customer.name} {customer.nif ? `(${customer.nif})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Tipo</label>
                <select
                  value={headerIngestDocumentType}
                  onChange={(e) => setHeaderIngestDocumentType(e.target.value as CustomerIngestDocumentType)}
                  className="w-full border border-slate-200 rounded-md p-2 text-sm bg-white"
                >
                  {CUSTOMER_INGEST_TYPES.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
              {/* Código — Certidão Permanente ou Cartão Eletrónico */}
              {(headerIngestDocumentType === 'certidao_permanente' || headerIngestDocumentType === 'cartao_eletronico') && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Código da Certidão Permanente
                    <span className="ml-1 font-normal text-slate-400">(alternativa ao ficheiro)</span>
                  </label>
                  <input
                    type="text"
                    value={headerIngestCodigo}
                    onChange={(e) => setHeaderIngestCodigo(e.target.value)}
                    placeholder={headerIngestDocumentType === 'cartao_eletronico' ? 'Código do cartão: XXXX-XXXX-XXXX' : 'XXXX-XXXX-XXXX'}
                    className="w-full border border-slate-200 rounded-md p-2 text-sm bg-white font-mono"
                  />
                  {headerIngestCodigo.trim() && (
                    <p className="text-[10px] text-emerald-600 mt-0.5">
                      ✓ Com código: consulta online, extrai dados, guarda PDF e actualiza resumo fiscal
                    </p>
                  )}
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Telefone para novo cliente (quando a IA não deteta)</label>
                <input
                  type="text"
                  value={headerIngestPhoneInput}
                  onChange={(e) => setHeaderIngestPhoneInput(e.target.value)}
                  placeholder="+3519..."
                  className="w-full border border-slate-200 rounded-md p-2 text-sm bg-white"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={triggerHeaderIngestPicker}
                  disabled={headerIngestLoading}
                  className="px-2 py-1.5 text-xs border rounded-md bg-white hover:bg-slate-100 disabled:opacity-50"
                >
                  Inserir documento
                </button>
                <button
                  type="button"
                  onClick={() => { void runHeaderDocumentIngest(); }}
                  disabled={headerIngestLoading}
                  className="px-2 py-1.5 text-xs rounded-md bg-whatsapp-600 text-white hover:bg-whatsapp-700 disabled:opacity-50"
                >
                  {headerIngestLoading ? 'A consultar...' : (headerIngestCodigo.trim() && headerIngestDocumentType === 'certidao_permanente' && !headerIngestSelectedFile ? 'Consultar + Guardar' : 'Analisar + Guardar')}
                </button>
              </div>
              <div className="text-xs text-slate-600">
                Ficheiro: {headerIngestSelectedFile ? <span className="font-medium">{headerIngestSelectedFile.name}</span> : 'Nenhum ficheiro selecionado.'}
              </div>
              {/* Confirmação de criação de novo cliente */}
              {headerIngestPendingCreate && (
                <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 p-3 space-y-2">
                  <p className="text-sm font-semibold text-blue-800">Criar novo cliente?</p>
                  <p className="text-xs text-blue-700">
                    <strong>{headerIngestPendingCreate.name}</strong> · NIF: {headerIngestPendingCreate.nif}
                    {headerIngestPendingCreate.fields.morada ? <><br/>{headerIngestPendingCreate.fields.morada}</> : ''}
                  </p>
                  <div className="flex gap-2">
                    <button type="button"
                      className="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-500"
                      onClick={async () => {
                        const pending = headerIngestPendingCreate;
                        if (!pending) return;
                        setHeaderIngestPendingCreate(null);
                        setHeaderIngestLoading(true);
                        const codigoCert = String(headerIngestCodigo || '').trim();
                        setHeaderIngestStatus(`A criar cliente: ${pending.name}...`);
                        try {
                          const phone = String(headerIngestPhoneInput || '').trim() || '+351000000000';
                          const managers = Array.isArray(pending.fields.managers) ? pending.fields.managers : [];
                          const suggestedFolder = buildSuggestedCustomerFolderPath(pending.name);
                          const newCustomer = await mockService.createCustomer({
                            name: pending.name, company: pending.name, phone, nif: pending.nif, niss: '',
                            type: 'Empresa', allowAutoResponses: true,
                            documentsFolder: suggestedFolder,
                            morada: pending.fields.morada || '', codigoPostal: pending.fields.codigoPostal || '',
                            caePrincipal: pending.fields.caePrincipal || '', dataConstituicao: pending.fields.dataConstituicao || '',
                            inicioAtividade: pending.fields.inicioAtividade || '',
                            certidaoPermanenteNumero: codigoCert, certidaoPermanenteValidade: pending.fields.certidaoPermanenteValidade || '',
                            managers, contacts: [], accessCredentials: [], agregadoFamiliar: [], fichasRelacionadas: [],
                          } as any, { syncToSupabase: false });
                          await loadCustomers();
                          setHeaderIngestStatus(`✓ Cliente criado. A guardar certidão...`);
                          // Re-consultar com ID real para PDF + resumo fiscal
                          const res2 = await fetch('/api/certidao-permanente/consultar', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ codigo: codigoCert, customerId: newCustomer.id }),
                          });
                          const d2 = await res2.json();
                          await mockService.updateCustomer(newCustomer.id, {
                            certidaoPermanenteNumero: codigoCert,
                            certidaoPermanenteValidade: pending.fields.certidaoPermanenteValidade || '',
                          } as any, { syncToSupabase: false });
                          await loadCustomers();
                          setHeaderIngestStatus(`✓ Cliente criado e certidão guardada: ${pending.name} (${pending.nif}).${d2.ficheiroPdf ? ' PDF guardado.' : ''}`);
                        } catch(e) {
                          setHeaderIngestStatus(`Erro: ${e instanceof Error ? e.message : String(e)}`);
                        } finally {
                          setHeaderIngestLoading(false);
                        }
                      }}
                    >
                      Sim, criar cliente
                    </button>
                    <button type="button"
                      className="px-3 py-1.5 text-xs rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      onClick={() => { setHeaderIngestPendingCreate(null); setHeaderIngestStatus('Criação cancelada.'); }}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
              {headerIngestStatus && (
                <div className="mt-2 text-xs text-slate-700 rounded-md border border-slate-200 bg-white px-2 py-1.5">
                  {headerIngestStatus}
                </div>
              )}
              {headerIngestWarnings.length > 0 && (
                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 space-y-1">
                  {headerIngestWarnings.map((warning, index) => (
                    <div key={`header-ingest-warning-${index}`}>- {warning}</div>
                  ))}
                </div>
              )}
              <input
                ref={headerIngestFileInputRef}
                type="file"
                className="hidden"
                onChange={handleHeaderIngestFileSelection}
              />
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div className="customer-modal-shell fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/45 p-2 md:p-4">
          <style>{`
            .customer-detail-modal {
              width: min(1800px, calc(100vw - 48px));
              max-height: calc(100vh - 48px);
            }
            .customer-detail-modal input:not([type="checkbox"]),
            .customer-detail-modal select {
              min-height: 32px;
              padding: 0.38rem 0.58rem !important;
              border-radius: 0.5rem !important;
              font-size: 0.8125rem !important;
            }
            .customer-detail-modal textarea {
              min-height: 54px !important;
              padding: 0.45rem 0.62rem !important;
              border-radius: 0.5rem !important;
              font-size: 0.8125rem !important;
            }
            .customer-detail-modal label {
              margin-bottom: 0.18rem !important;
              font-size: 0.72rem !important;
              line-height: 1.1rem !important;
            }
            .customer-modal-body {
              scrollbar-gutter: stable;
            }
            .customer-modal-body > div {
              row-gap: 0.65rem !important;
            }
            .customer-modal-body section,
            .customer-modal-body details {
              border-radius: 0.72rem !important;
            }
            .customer-modal-body section > div:first-child,
            .customer-modal-body details > summary {
              padding: 0.58rem 0.85rem !important;
              min-height: 42px;
            }
            .customer-modal-body section > div:nth-child(2),
            .customer-modal-body details > div {
              padding: 0.72rem 0.85rem !important;
            }
            .customer-modal-body .grid {
              gap: 0.55rem 0.75rem !important;
            }
            .customer-modal-body .md\\:grid-cols-4 {
              grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
            }
            .customer-modal-body .md\\:col-span-2 {
              grid-column: span 2 / span 2;
            }
            .customer-modal-body .md\\:col-span-4 {
              grid-column: 1 / -1;
            }
            .customer-modal-body .rounded-lg {
              border-radius: 0.5rem !important;
            }
            .customer-modal-body .space-y-2 > :not([hidden]) ~ :not([hidden]) {
              margin-top: 0.4rem !important;
            }
            .customer-modal-body .min-h-\\[80px\\] {
              min-height: 56px !important;
            }
            .customer-modal-body [style*="grid-template-columns"] {
              min-width: 560px;
            }
            @media (max-width: 900px) {
              .customer-detail-modal {
                width: calc(100vw - 16px);
                max-height: calc(100vh - 16px);
              }
              .customer-modal-body .md\\:grid-cols-4 {
                grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
              }
              .customer-modal-body .md\\:col-span-2,
              .customer-modal-body .md\\:col-span-4 {
                grid-column: 1 / -1;
              }
              .customer-modal-body [style*="grid-template-columns"] {
                min-width: 620px;
              }
            }
            @media (max-width: 640px) {
              .customer-modal-body .md\\:grid-cols-4 {
                grid-template-columns: 1fr !important;
              }
            }
          `}</style>
          <div className="customer-detail-modal flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-[#f3f6fb] shadow-2xl">
            {/* Confirmação de saída sem gravar — inline para não perder foco no Electron */}
            {showUnsavedConfirm && (
              <div className="mx-3 mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-amber-800">⚠️ Alterações não gravadas. Sair mesmo assim?</span>
                <div className="flex gap-2 shrink-0">
                  <button type="button" onClick={() => setShowUnsavedConfirm(false)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                    Cancelar
                  </button>
                  <button type="button" onClick={doCloseCustomerModal}
                    className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-500">
                    Sair sem gravar
                  </button>
                </div>
              </div>
            )}
            <div className="mx-3 mt-3 shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <button
                  type="button"
                  onClick={() => closeCustomerModal(true)}
                  className="self-start rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  ← Sair
                </button>
                <div className="min-w-0 flex-1 text-center">
                  <h2 className="text-lg font-bold text-slate-900">{editingCustomer ? 'Editar Cliente' : 'Novo Cliente'}</h2>
                  {editingCustomer && (
                    <p className="mx-auto max-w-[80vw] truncate text-sm font-semibold text-blue-700" title={editingCustomerDisplayName}>
                      {editingCustomerDisplayName}
                    </p>
                  )}
                  <p className="text-xs text-slate-500">
                    {editingCustomer
                      ? 'Edite os dados locais. Os contactos podem existir só aqui, sem existir no Supabase.'
                      : 'Ao criar, pode escolher se também quer sincronizar este cliente no MPR Control (Supabase).'}
                  </p>
                  {formSavedNotice && (
                    <p className="mt-1 text-xs font-semibold text-emerald-700">{formSavedNotice}</p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  {editingCustomer && (
                    <button
                      type="button"
                      onClick={() => {
                        void handleUpdateCustomerFromAt();
                      }}
                      disabled={atProfileBusy}
                      className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 shadow-sm hover:bg-emerald-100 disabled:cursor-wait disabled:opacity-60"
                      title="Entrar na AT e preencher morada, início de atividade, regime IVA, CAE e repartição"
                    >
                      <RefreshCw size={15} className={atProfileBusy ? 'animate-spin' : ''} />
                      {atProfileBusy ? 'A consultar AT...' : 'Atualizar pela AT'}
                    </button>
                  )}
                  {editingCustomer && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handlePushToSupabase}
                        disabled={supabasePushBusy}
                        title="Forçar envio dos dados locais para o Supabase — local é sempre a fonte de verdade"
                        className="inline-flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-700 shadow-sm hover:bg-violet-100 disabled:cursor-wait disabled:opacity-60"
                      >
                        <ArrowDownToLine size={15} className={`rotate-180 ${supabasePushBusy ? 'animate-bounce' : ''}`} />
                        {supabasePushBusy ? 'A enviar...' : '→ Supabase'}
                      </button>
                      {supabasePushMsg && (
                        <span className={`text-xs font-medium ${supabasePushMsg.includes('Erro') ? 'text-red-500' : 'text-violet-600'}`}>
                          {supabasePushMsg}
                        </span>
                      )}
                      {/* Importar credenciais do SAFTonline */}
                      <button
                        type="button"
                        onClick={handleReadCredsFromSaft}
                        disabled={saftReadBusy}
                        title="Importar todas as credenciais do SAFTonline para esta ficha"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-200 bg-cyan-50 px-3 py-1.5 text-xs font-semibold text-cyan-700 shadow-sm hover:bg-cyan-100 disabled:cursor-wait disabled:opacity-60"
                      >
                        <ArrowDownToLine size={13} className={saftReadBusy ? 'animate-bounce' : ''} />
                        {saftReadBusy ? 'SAFT...' : '← SAFT'}
                      </button>
                      {saftReadMsg && (
                        <span className={`text-xs font-medium ${saftReadMsg.startsWith('✓') ? 'text-cyan-600' : 'text-red-500'}`}>
                          {saftReadMsg}
                        </span>
                      )}
                      {/* Enviar credenciais SS para SAFTonline (útil na renovação do token) */}
                      <button
                        type="button"
                        onClick={handleWriteSSToSaft}
                        disabled={saftSSBusy}
                        title="Gravar subutilizador SS + chave + token no SAFTonline (renovação)"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 shadow-sm hover:bg-emerald-100 disabled:cursor-wait disabled:opacity-60"
                      >
                        <RefreshCw size={13} className={saftSSBusy ? 'animate-spin' : ''} />
                        {saftSSBusy ? 'SAFT...' : 'SS → SAFT'}
                      </button>
                      {saftSSMsg && (
                        <span className={`text-xs font-medium ${saftSSMsg.startsWith('✓') ? 'text-emerald-600' : 'text-red-500'}`}>
                          {saftSSMsg}
                        </span>
                      )}
                    </div>
                  )}
                  <button
                    type="submit"
                    form="customer-detail-form"
                    className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
                  >
                    Gravar
                  </button>
                </div>
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col p-2 md:p-3">
              <form id="customer-detail-form" onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-2">
                <div className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2">
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="min-w-[280px] flex-1">
                      <label htmlFor="allowAuto" className="block text-xs font-semibold text-gray-900 cursor-pointer">
                        Permitir Respostas Automáticas
                      </label>
                      <p className="text-xs text-gray-500">Se desativado, este cliente não receberá mensagens de gatilhos automáticos.</p>
                    </div>
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        id="allowAuto"
                        checked={formData.allowAutoResponses}
                        onChange={(e) => setFormData({ ...formData, allowAutoResponses: e.target.checked })}
                        className="h-4 w-4 cursor-pointer rounded border-gray-300 text-whatsapp-600 focus:ring-whatsapp-500"
                      />
                    </div>
                    <div className="min-w-[190px] border-l border-slate-200 pl-3 text-right">
                      <div className="text-[11px] uppercase tracking-wide text-slate-500">Última sincronização</div>
                      <div className="text-xs font-semibold text-slate-700">{formatDateTime(editingCustomer?.supabaseUpdatedAt)}</div>
                    </div>
                  </div>
                </div>

                <div className="shrink-0 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-1.5">
                  <div className="flex min-w-max gap-1.5">
                  <button
                    type="button"
                    onClick={() => setActiveTab('dados')}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      activeTab === 'dados'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Dados
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('acessos')}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      activeTab === 'acessos'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Dados de Acesso
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('contactos')}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      activeTab === 'contactos'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Contactos
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('relacoes')}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      activeTab === 'relacoes'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Fichas Relacionadas
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('atividade')}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      activeTab === 'atividade'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Tarefas e Ocorrências
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('sociedade')}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      activeTab === 'sociedade'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Documentos da Sociedade
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('documentos')}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      activeTab === 'documentos'
                        ? 'border border-blue-200 bg-white text-blue-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Documentos da Pasta
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('fiscal')}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      activeTab === 'fiscal'
                        ? 'border border-green-300 bg-white text-green-700 shadow-sm'
                        : 'text-slate-700 hover:bg-white'
                    }`}
                  >
                    Resumo Fiscal
                  </button>
                  </div>
                </div>

                <div className="customer-modal-body min-h-0 flex-1 overflow-y-auto pr-1">
              {activeTab === 'dados' && (
                <CustomerDadosTab
                  formData={formData}
                  setFormData={setFormData}
                  isNifLocked={isNifLocked}
                  folderEditMode={folderEditMode}
                  setFolderEditMode={setFolderEditMode}
                  users={users}
                  editingCustomer={editingCustomer}
                  importedLookup={importedLookup}
                  importedFields={importedFields}
                  copyCustomerNif={copyCustomerNif}
                  openCustomerDocumentsFolder={openCustomerDocumentsFolder}
                  addManager={addManager}
                  updateManager={updateManager}
                  removeManager={removeManager}
                />
              )}

              {activeTab === 'acessos' && (
                <CustomerAccessTab
                  editingCustomer={editingCustomer}
                  subUserState={editingSegSocialSubUserState}
                  saftSsSyncBusy={saftSsSyncBusy}
                  autologinBusyCustomerId={autologinBusyCustomerId}
                  segSocialAutologinBusyCustomerId={segSocialAutologinBusyCustomerId}
                  segSocialSubUserBusyCustomerId={segSocialSubUserBusyCustomerId}
                  segSocialActivationBusyCustomerId={segSocialActivationBusyCustomerId}
                  credentialPresets={credentialPresets}
                  customAccessCredentialIndexes={customAccessCredentialIndexes}
                  importedAccesses={importedAccesses}
                  addAccessCredential={addAccessCredential}
                  canUseSegSocialSubUserFlow={canUseSegSocialSubUserFlow}
                  credentialForPreset={credentialForPreset}
                  findCredentialIndexForPreset={findCredentialIndexForPreset}
                  formatDateTime={formatDateTime}
                  removeAccessCredential={removeAccessCredential}
                  removeCredentialPreset={removeCredentialPreset}
                  syncSegSocialPasswordsFromSaft={syncSegSocialPasswordsFromSaft}
                  triggerFinancasAutologin={triggerFinancasAutologin}
                  triggerSegSocialActivationSetup={triggerSegSocialActivationSetup}
                  triggerSegSocialInteroperabilityInfo={triggerSegSocialInteroperabilityInfo}
                  triggerSegSocialSubUserLogin={triggerSegSocialSubUserLogin}
                  triggerSegSocialSubUserSetup={triggerSegSocialSubUserSetup}
                  updateAccessCredential={updateAccessCredential}
                  updateCredentialPreset={updateCredentialPreset}
                />
              )}

              {activeTab === 'contactos' && (
                <CustomerContactosTab
                  contacts={formData.contacts}
                  onAdd={addSubContact}
                  onUpdate={updateSubContact}
                  onRemove={removeSubContact}
                />
              )}

              {activeTab === 'relacoes' && (
                <CustomerRelacoesTab
                  agregadoFamiliar={formData.agregadoFamiliar}
                  fichasRelacionadas={formData.fichasRelacionadas}
                  agregadoSearchTerms={agregadoSearchTerms}
                  fichasSearchTerms={fichasSearchTerms}
                  setAgregadoSearchTerms={setAgregadoSearchTerms}
                  setFichasSearchTerms={setFichasSearchTerms}
                  updateAgregadoFamiliar={updateAgregadoFamiliar}
                  updateFichaRelacionada={updateFichaRelacionada}
                  removeAgregadoFamiliar={removeAgregadoFamiliar}
                  removeFichaRelacionada={removeFichaRelacionada}
                  addAgregadoFamiliar={addAgregadoFamiliar}
                  addFichaRelacionada={addFichaRelacionada}
                  resolveLinkedCustomerByEntry={resolveLinkedCustomerByEntry}
                  buildEntryRelationLabel={buildEntryRelationLabel}
                  filterRelationCustomers={filterRelationCustomers}
                  buildRelationCustomerLabel={buildRelationCustomerLabel}
                  openRelatedCustomerProfile={openRelatedCustomerProfile}
                />
              )}

              {activeTab === 'atividade' && (
                <CustomerAtividadeTab
                  customerId={editingCustomer?.id || ''}
                  loading={customerActivityLoading}
                  error={customerActivityError}
                  taskOpenCount={taskOpenCount}
                  taskClosedCount={taskClosedCount}
                  occurrenceOpenCount={occurrenceOpenCount}
                  occurrenceClosedCount={occurrenceClosedCount}
                  tasks={customerTasksSummary}
                  occurrences={customerOccurrencesSummary}
                  onReload={() => { if (editingCustomer?.id) void loadCustomerActivity(editingCustomer.id); }}
                  onOpenTask={(taskId) => { setShowModal(false); navigate(`/tasks?taskId=${encodeURIComponent(taskId)}`); }}
                  onOpenOccurrence={(occurrenceId) => { setShowModal(false); navigate(`/occurrences?occurrenceId=${encodeURIComponent(occurrenceId)}`); }}
                />
              )}

              {activeTab === 'sociedade' && (
                <CustomerSociedadeTab
                  customerId={editingCustomer?.id || ''}
                  categoryKey={sociedadeCategoryKey}
                  onSelectCategory={(key) => { void openSociedadeCategory(key); }}
                  browser={{
                    title: 'Pasta da sociedade',
                    folderPath: sociedadeDocsPath,
                    fallbackFolderPath: formData.documentsFolder,
                    currentPath: sociedadeCurrentPath,
                    rootPathLabel: SOCIEDADE_BASE_PATH,
                    configured: sociedadeDocsConfigured,
                    loading: sociedadeDocsLoading,
                    uploading: sociedadeUploadingDoc,
                    error: sociedadeDocsError,
                    entries: sociedadeDocs,
                    canGoUp: sociedadeCanGoUp,
                    fileInputRef: sociedadeFileInputRef,
                    itemKeyPrefix: 'sociedade',
                    onRefresh: () => loadSociedadeDocuments(editingCustomer?.id || '', sociedadeCurrentPath || SOCIEDADE_BASE_PATH),
                    onGoUp: goUpSociedadeFolder,
                    onTriggerUpload: triggerSociedadeDocumentPicker,
                    onUpload: handleSociedadeDocumentUpload,
                    onOpenDirectory: (relativePath) => { void openSociedadeFolder(relativePath); },
                    onOpenFile: (relativePath) => { openCustomerDocument(editingCustomer?.id || '', relativePath, sociedadeDocsPath || formData.documentsFolder); },
                  }}
                />
              )}

              {activeTab === 'documentos' && (
                <div className="border rounded-lg p-4 space-y-3">
                  {!editingCustomer?.id ? (
                    <p className="text-sm text-gray-500">Guarde primeiro o cliente para ativar a gestão de documentos da pasta.</p>
                  ) : (
                    <>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div>
                            <div className="text-sm font-semibold text-slate-800">Inserir documentos (IA)</div>
                            <div className="text-xs text-slate-500">
                              Extrai dados automaticamente e guarda em <span className="font-mono">Documentos Oficiais</span>.
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <select
                              value={ingestDocumentType}
                              onChange={(e) => { setIngestDocumentType(e.target.value as CustomerIngestDocumentType); setIngestCodigo(''); }}
                              className="text-xs border border-slate-300 rounded-md px-2 py-1.5 bg-white"
                            >
                              {CUSTOMER_INGEST_TYPES.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={triggerIngestPicker}
                              disabled={ingestLoading}
                              className="px-2 py-1.5 text-xs border rounded-md bg-white hover:bg-slate-100 disabled:opacity-50"
                            >
                              Inserir documento
                            </button>
                            <button
                              type="button"
                              onClick={() => { void runDocumentIngest(); }}
                              disabled={ingestLoading}
                              className="px-2 py-1.5 text-xs rounded-md bg-whatsapp-600 text-white hover:bg-whatsapp-700 disabled:opacity-50"
                            >
                              {ingestLoading ? 'A consultar...' : (ingestCodigo.trim() && ingestDocumentType === 'certidao_permanente' && !ingestSelectedFile ? 'Consultar + Guardar' : 'Analisar + Guardar')}
                            </button>
                          </div>
                        </div>
                        {/* Campo código — Certidão Permanente ou Cartão Eletrónico */}
                        {(ingestDocumentType === 'certidao_permanente' || ingestDocumentType === 'cartao_eletronico') && (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={ingestCodigo}
                              onChange={(e) => setIngestCodigo(e.target.value)}
                              placeholder={ingestDocumentType === 'cartao_eletronico' ? 'Código do cartão: XXXX-XXXX-XXXX' : 'Código da certidão: XXXX-XXXX-XXXX'}
                              className="flex-1 border border-slate-200 rounded-md px-2 py-1.5 text-xs font-mono bg-white focus:outline-none focus:ring-1 focus:ring-emerald-400"
                            />
                            {ingestCodigo.trim() && <span className="text-[10px] text-emerald-600 shrink-0">Sem ficheiro → consulta online</span>}
                          </div>
                        )}
                        <div className="text-xs text-slate-600">
                          Ficheiro: {ingestSelectedFile ? <span className="font-medium">{ingestSelectedFile.name}</span> : 'Nenhum ficheiro selecionado.'}
                          {ingestDocumentType === 'cartao_cidadao' && !ingestSelectedFile && (
                            <span className="ml-1 text-slate-400">— pode selecionar 2 imagens (frente+verso)</span>
                          )}
                        </div>
                        {ingestStatus && (
                          <div className="text-xs text-slate-700 rounded-md border border-slate-200 bg-white px-2 py-1.5">
                            {ingestStatus}
                          </div>
                        )}
                        {ingestWarnings.length > 0 && (
                          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-700 space-y-1">
                            {ingestWarnings.map((warning, index) => (
                              <div key={`ingest-warning-${index}`}>- {warning}</div>
                            ))}
                          </div>
                        )}
                        <input
                          ref={ingestFileInputRef}
                          type="file"
                          className="hidden"
                          multiple={ingestDocumentType === 'cartao_cidadao'}
                          accept={ingestDocumentType === 'cartao_cidadao' ? 'image/*,application/pdf,.pdf' : undefined}
                          onChange={handleIngestFileSelection}
                        />
                      </div>

                      <CustomerDocumentBrowser
                        title="Documentos da pasta do cliente"
                        folderPath={modalDocsPath}
                        fallbackFolderPath={formData.documentsFolder}
                        currentPath={modalDocsCurrentPath}
                        rootPathLabel="/"
                        configured={modalDocsConfigured}
                        loading={modalDocsLoading}
                        uploading={modalUploadingDoc}
                        organizing={modalOrganizingDocs}
                        error={modalDocsError}
                        entries={modalDocs}
                        canGoUp={modalCanGoUp}
                        fileInputRef={modalFileInputRef}
                        onRefresh={() => loadModalDocuments(editingCustomer.id, modalDocsCurrentPath)}
                        onGoUp={goUpModalDocumentsFolder}
                        onOrganize={modalOrganizerPreview ? undefined : () => { void organizeModalDocumentsWithAi(); }}
                        onTriggerUpload={triggerModalDocumentPicker}
                        onUpload={handleModalDocumentUpload}
                        onOpenDirectory={(relativePath) => {
                          void openModalDocumentsFolder(relativePath);
                        }}
                        onOpenFile={openModalDocument}
                      />
                      {modalOrganizerPreview && (
                        <div className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-slate-700 space-y-2">
                          <div className="font-semibold text-violet-800">{modalOrganizerStatus}</div>
                          <div className="max-h-48 overflow-y-auto space-y-0.5">
                            {modalOrganizerPreview.slice(0, 50).map((m, i) => (
                              <div key={`preview-${i}`} className="font-mono text-[11px] text-slate-600">
                                <span className="text-red-500">{m.from}</span>
                                {' → '}
                                <span className="text-green-700">{m.to}</span>
                                {m.reason ? <span className="ml-1 text-slate-400">({m.reason})</span> : null}
                              </div>
                            ))}
                            {modalOrganizerPreview.length > 50 && (
                              <div className="text-slate-400">… e mais {modalOrganizerPreview.length - 50} ficheiro(s)</div>
                            )}
                          </div>
                          {modalOrganizerWarnings.length > 0 && (
                            <div className="space-y-0.5 text-amber-700">
                              {modalOrganizerWarnings.slice(0, 4).map((w, i) => (
                                <div key={`pw-${i}`}>- {w}</div>
                              ))}
                            </div>
                          )}
                          <div className="flex gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => { void confirmOrganizeModalDocuments(); }}
                              className="px-3 py-1 text-xs rounded-md bg-violet-600 text-white hover:bg-violet-700"
                            >
                              Confirmar e organizar
                            </button>
                            <button
                              type="button"
                              onClick={() => { setModalOrganizerPreview(null); setModalOrganizerStatus(''); setModalOrganizerWarnings([]); }}
                              className="px-3 py-1 text-xs rounded-md bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
                            >
                              Cancelar
                            </button>
                          </div>
                        </div>
                      )}
                      {!modalOrganizerPreview && (modalOrganizerStatus || modalOrganizerWarnings.length > 0) && (
                        <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 space-y-1">
                          {modalOrganizerStatus && <div className="font-medium text-slate-800">{modalOrganizerStatus}</div>}
                          {modalOrganizerUndoAvailable && (
                            <button
                              type="button"
                              disabled={modalOrganizerUndoing}
                              onClick={() => { void undoOrganizeModalDocuments(); }}
                              className="px-2 py-0.5 text-xs rounded border border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                            >
                              {modalOrganizerUndoing ? 'A anular...' : 'Anular organização'}
                            </button>
                          )}
                          {modalOrganizerWarnings.length > 0 && (
                            <div className="space-y-0.5 text-amber-700">
                              {modalOrganizerWarnings.slice(0, 6).map((warning, index) => (
                                <div key={`organizer-warning-${index}`}>- {warning}</div>
                              ))}
                              {modalOrganizerWarnings.length > 6 && (
                                <div>- Mais {modalOrganizerWarnings.length - 6} aviso(s).</div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {activeTab === 'fiscal' && editingCustomer?.id && (
                <CustomerFiscalSummaryTab
                  key={fiscalSummaryRefreshKey}
                  customer={editingCustomer}
                  anyAutomationBusy={Boolean(
                    autologinBusyCustomerId ||
                    segSocialAutologinBusyCustomerId ||
                    segSocialSubUserBusyCustomerId ||
                    segSocialActivationBusyCustomerId
                  )}
                  triggerFinancasAutologin={triggerFinancasAutologin}
                  triggerSegSocialSubUserLogin={triggerSegSocialSubUserLogin}
                  triggerSegSocialInteroperabilityInfo={triggerSegSocialInteroperabilityInfo}
                />
              )}
                </div>

              <div className="flex shrink-0 justify-end gap-2 border-t border-slate-200 pt-2">
                <button
                  type="button"
                  onClick={() => closeCustomerModal(true)}
                  className="rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Sair
                </button>
                <button type="submit" className="rounded-lg bg-blue-600 px-5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500">
                  Gravar
                </button>
              </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Customers;
