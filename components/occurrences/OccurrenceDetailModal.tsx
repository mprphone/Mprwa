import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Paperclip, Plus, Save, Upload } from 'lucide-react';
import {
  createDossieItem,
  DossieItemTemplate,
  fetchDossieItems,
  linkOccurrenceAttachmentToDossie,
  OccurrenceCustomer,
  OccurrenceType,
  OccurrenceUser,
  reorderDossieItems,
} from '../../services/occurrencesApi';
import {
  createEmptyProjectSupportDetail,
  isProjectSupportTypeName,
  ProjectSectionKey,
  ProjectSupportDetail,
  ProjectSupportEmployeeItem,
  ProjectSupportListItem,
  ProjectSupportRefundItem,
  syncTrackedListFromBase,
} from './projectSupportDetail';

export type OccurrenceDetailAttachment = {
  id: string;
  kind: string;
  sourceTable?: string | null;
  fileUrl?: string | null;
  storagePath?: string | null;
  localFilePath?: string | null;
  originalName?: string | null;
  createdAt?: string | null;
  sectionKey?: string | null;
  dossieModel?: string | null;
  dossieItemKey?: string | null;
};

export type OccurrenceDetailForm = {
  id: string;
  customerId: string;
  date: string;
  dueDate: string;
  typeId: string;
  title: string;
  description: string;
  state: string;
  responsibleUserIds: string[];
  resolution: string;
  attachments: OccurrenceDetailAttachment[];
  projectSupport: ProjectSupportDetail;
};

type Props = {
  open: boolean;
  loading: boolean;
  saving: boolean;
  uploadingAttachment: boolean;
  uploadAttachmentError: string;
  customers: OccurrenceCustomer[];
  types: OccurrenceType[];
  users: OccurrenceUser[];
  form: OccurrenceDetailForm;
  onClose: () => void;
  onSave: () => void;
  onChange: (patch: Partial<OccurrenceDetailForm>) => void;
  onAddResponsible: (userId: string) => void;
  onRemoveResponsible: (userId: string) => void;
  onUploadFiles: (
    files: FileList | null,
    sectionKey?: ProjectSectionKey,
    options?: { dossieModel?: string; dossieItemKey?: string }
  ) => void;
};

type TabKey = 'details' | 'candidatura' | 'acompanhamento' | 'encerramento' | 'dossie';
type CandidaturaListKey = 'investimento' | 'objetivosAviso' | 'objetivosProjeto';

type AcompanhamentoTrackedListKey = 'investimento' | 'objetivosAviso' | 'objetivosProjeto';

const TAB_TO_SECTION: Record<TabKey, ProjectSectionKey> = {
  details: 'geral',
  candidatura: 'candidatura',
  acompanhamento: 'acompanhamento',
  encerramento: 'encerramento',
  dossie: 'dossie_eletronico',
};

const PHASE_OPTIONS = ['Candidatura', 'Em Analise', 'Aprovado', 'Encerrado', 'Reprovado'];
const BILLING_OPTIONS = [
  { label: 'Não', value: 'NAO' },
  { label: 'Sim', value: 'SIM' },
];

const REFUND_STATUS_OPTIONS = ['Pedido', 'Pago'];

const DOSSIE_MODEL_OPTIONS = ['IAPMEI', 'IEFP', 'CIM', 'OUTROS'];

const IAPMEI_DOSSIE_ITEMS = [
  { key: '1_1_comunicacao_convite', principal: '1.Candidatura', nivel2: '1.1 Candidatura', designacao: 'Comunicação do convite à apresentação da candidatura' },
  { key: '1_1_formulario_candidatura', principal: '1.Candidatura', nivel2: '1.1 Candidatura', designacao: 'Formulário de candidatura e respetivos anexos submetidos' },
  { key: '1_1_comprovativo_envio', principal: '1.Candidatura', nivel2: '1.1 Candidatura', designacao: 'Comprovativo de envio e da receção da candidatura' },
  { key: '1_2_comprovativos_elegibilidade', principal: '1.Candidatura', nivel2: '1.2 Comprovativos dos Critérios de Elegibilidade', designacao: 'Comprovativos dos critérios de Elegibilidade dos Beneficiários e do Projeto' },
  { key: '1_3_correspondencia', principal: '1.Candidatura', nivel2: '1.3 Correspondência Trocada', designacao: 'Correspondência com o Beneficiário Intermediário, relativa ao pedido de elementos e esclarecimentos' },
  { key: '2_1_condicionantes_pre_contratuais', principal: '2.Decisão', nivel2: '2.1 Comprovativos das Condicionantes Pré Contratuais', designacao: 'Comprovativos das Condicionantes Pré Contratuais' },
  { key: '2_2_termo_aceitacao', principal: '2.Decisão', nivel2: '2.2 Termo de Aceitação', designacao: 'Termo de Aceitação / Contrato Consórcio / Anexos / Outros' },
  { key: '2_3_pedidos_ate_termo', principal: '2.Decisão', nivel2: '2.3 Pedidos de Alteração (até ao Termo de Aceitação)', designacao: 'Pedidos de alteração e respetiva documentação de suporte' },
  { key: '2_4_correspondencia_decisao', principal: '2.Decisão', nivel2: '2.4 Correspondência Trocada', designacao: 'Correspondência com o Beneficiário Intermediário relativa a notificação da proposta de decisão e decisão final' },
  { key: '3_1_adenda_termo', principal: '3.Pedidos de Alteração', nivel2: '3.1 Adenda ao Termo de Aceitação', designacao: 'Adenda ao Termo de Aceitação e eventuais anexos' },
  { key: '3_2_pedidos_pos_termo', principal: '3.Pedidos de Alteração', nivel2: '3.2 Pedidos de Alteração (após o Termo de Aceitação)', designacao: 'Pedidos de alteração, documentação de suporte e correspondência' },
  { key: '4_1_acompanhamento_visita', principal: '4.Ações de Acompanhamento e Controlo', nivel2: '4.1 Acompanhamento / Visita', designacao: 'Correspondência, relatórios e outros documentos' },
  { key: '4_2_controlo_auditoria', principal: '4.Ações de Acompanhamento e Controlo', nivel2: '4.2 Controlo / Auditoria', designacao: 'Correspondência, relatórios e outros documentos' },
  { key: '5_1_relatorios_intercalares', principal: '5.Execução', nivel2: '5.1 Relatórios Intercalar de Progresso (Trimestral)', designacao: 'Relatórios Intercalar de Progresso (Trimestral)' },
  { key: '5_2_auditorias_intercalares', principal: '5.Execução', nivel2: '5.2 Auditorias técnico científicas intercalares', designacao: 'Auditorias técnico científicas intercalares' },
  { key: '5_3_pedidos_pagamento_intercalares', principal: '5.Execução', nivel2: '5.3 Pedidos de Pagamento Intercalares', designacao: 'Pedidos de Pagamento Intercalares' },
  { key: '5_4_pedido_pagamento_final', principal: '5.Execução', nivel2: '5.4 Pedido de Pagamento Final', designacao: 'Pedido de Pagamento Final' },
  { key: '5_5_encerramento_projeto', principal: '5.Execução', nivel2: '5.5 Encerramento projeto', designacao: 'Encerramento projeto' },
  { key: '5_6_avaliacao_metas', principal: '5.Execução', nivel2: '5.6 Avaliação de Metas', designacao: 'Avaliação de Metas' },
  { key: '5_7_comprovantes_investimento', principal: '5.Execução', nivel2: '5.7 Comprovantes de Investimento', designacao: 'Comprovantes de Investimento' },
  { key: '5_8_evidencias_divulgacao', principal: '5.Execução', nivel2: '5.8 Evidências da Divulgação de Resultados', designacao: 'Evidências da Divulgação de Resultados' },
  { key: '5_9_outros_documentos', principal: '5.Execução', nivel2: '5.9 Outros Documentos', designacao: 'Outros Documentos' },
  { key: '6_1_publicitacao_apoio', principal: '6.Publicitação de Apoio', nivel2: '6.1 A cumprir pelo Beneficiário (web/cartaz/ecrã eletrónico)', designacao: 'Elementos de publicitação de apoio' },
  { key: '7_1_contratacao_publica', principal: '7.Contratação Pública', nivel2: '7.1 Procedimentos de Contratação Pública', designacao: 'Procedimentos de Contratação Pública' },
];

const IEFP_DOSSIE_ITEMS = [
  { key: 'iefp_candidatura_eletronica', principal: '1.Candidatura', nivel2: 'Candidatura Eletrónica', designacao: 'Formulário de candidatura submetido no IEFP Online' },
  { key: 'iefp_identificacao_empresa', principal: '1.Candidatura', nivel2: 'Identificação da Empresa', designacao: 'Certidão permanente e registo de beneficiário (Segurança Social)' },
  { key: 'iefp_contrato_trabalho', principal: '2.Execução', nivel2: 'Contrato de Trabalho', designacao: 'Cópia do contrato sem termo celebrado (com data de início)' },
  { key: 'iefp_inscricao_trabalhador', principal: '2.Execução', nivel2: 'Inscrição do Trabalhador', designacao: 'Prova de inscrição do desempregado no IEFP' },
  { key: 'iefp_regularizacao_at_ss', principal: '1.Candidatura', nivel2: 'Situação Regularizada', designacao: 'Regularidade perante Autoridade Tributária e Segurança Social' },
  { key: 'iefp_recuperacao_aplicavel', principal: '1.Candidatura', nivel2: 'Declarações', designacao: 'Declaração de não se encontrar em processo de recuperação (se aplicável)' },
  { key: 'iefp_majoracoes', principal: '1.Candidatura', nivel2: 'Majorações', designacao: 'Atestado multiuso / comprovativos de residência (se aplicável)' },
  { key: 'iefp_plano_formacao', principal: '2.Execução', nivel2: 'Plano de Formação', designacao: 'Plano de formação na empresa (quando exigido)' },
];

const OccurrenceDetailModal: React.FC<Props> = ({
  open,
  loading,
  saving,
  uploadingAttachment,
  uploadAttachmentError,
  customers,
  types,
  users,
  form,
  onClose,
  onSave,
  onChange,
  onAddResponsible,
  onRemoveResponsible,
  onUploadFiles,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dossieFileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('details');
  const [pendingDossieItemKey, setPendingDossieItemKey] = useState('');
  const [dossieItemsRemote, setDossieItemsRemote] = useState<DossieItemTemplate[]>([]);
  const [dossieItemsLoading, setDossieItemsLoading] = useState(false);
  const [dossieActionError, setDossieActionError] = useState('');
  const [linkingAttachmentId, setLinkingAttachmentId] = useState('');
  const [dragOverDossieKey, setDragOverDossieKey] = useState('');
  const [newSeparatorPrincipal, setNewSeparatorPrincipal] = useState('');
  const [newSeparatorNivel2, setNewSeparatorNivel2] = useState('');
  const [newSeparatorDesignacao, setNewSeparatorDesignacao] = useState('');
  const [creatingSeparator, setCreatingSeparator] = useState(false);
  const [reorderingSeparators, setReorderingSeparators] = useState(false);
  const [draggingSeparatorKey, setDraggingSeparatorKey] = useState('');

  const isClosed = String(form.state || '').toUpperCase() === 'RESOLVIDA';
  const selectedUsers = useMemo(
    () => users.filter((user) => form.responsibleUserIds.includes(user.id)),
    [users, form.responsibleUserIds]
  );

  const selectedTypeName = useMemo(() => {
    const id = String(form.typeId || '').trim();
    if (!id) return '';
    const found = types.find((item) => String(item.id) === id);
    return String(found?.name || '').trim();
  }, [types, form.typeId]);

  const isProjectSupport = isProjectSupportTypeName(selectedTypeName);
  const projectSupport = form.projectSupport || createEmptyProjectSupportDetail();
  const selectedDossieModel = String(projectSupport.dossieEletronico?.modelo || 'IAPMEI').toUpperCase();
  const fallbackDossieCatalog =
    selectedDossieModel === 'IAPMEI'
      ? IAPMEI_DOSSIE_ITEMS
      : selectedDossieModel === 'IEFP' || selectedDossieModel === 'CIM' || selectedDossieModel === 'OUTROS'
      ? IEFP_DOSSIE_ITEMS
      : [];

  const dossieItemCatalog = useMemo(() => {
    if (dossieItemsRemote.length > 0) {
      return dossieItemsRemote
        .map((item) => {
          const key = String(item.key || '').trim();
          if (!key) return null;
          return {
            ...item,
            key,
            principal: String(item.principal || '').trim(),
            nivel2: String(item.nivel2 || '').trim(),
            designacao: String(item.designacao || item.nivel2 || '').trim(),
          };
        })
        .filter((item): item is DossieItemTemplate => Boolean(item));
    }

    return fallbackDossieCatalog
      .map((item) => {
        const key = String(item.key || '').trim();
        if (!key) return null;
        return {
          key,
          principal: String(item.principal || '').trim(),
          nivel2: String(item.nivel2 || '').trim(),
          designacao: String(item.designacao || item.nivel2 || '').trim(),
          source: 'builtin' as const,
        };
      })
      .filter((item): item is DossieItemTemplate => Boolean(item));
  }, [fallbackDossieCatalog, dossieItemsRemote]);

  const dossieCatalogByKey = useMemo(() => {
    const map = new Map<string, DossieItemTemplate>();
    for (const item of dossieItemCatalog) {
      const key = String(item.key || '').trim();
      if (!key) continue;
      map.set(key, item);
    }
    return map;
  }, [dossieItemCatalog]);

  useEffect(() => {
    if (!isProjectSupport && activeTab !== 'details') {
      setActiveTab('details');
    }
  }, [isProjectSupport, activeTab]);

  useEffect(() => {
    let cancelled = false;

    if (!open || !isProjectSupport) {
      setDossieItemsRemote([]);
      setDossieActionError('');
      return () => {
        cancelled = true;
      };
    }

    setDossieItemsLoading(true);
    fetchDossieItems(selectedDossieModel)
      .then((items) => {
        if (cancelled) return;
        setDossieItemsRemote(Array.isArray(items) ? items : []);
      })
      .catch((error) => {
        if (cancelled) return;
        setDossieActionError(error instanceof Error ? error.message : 'Falha ao carregar separadores do dossiê.');
      })
      .finally(() => {
        if (cancelled) return;
        setDossieItemsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, isProjectSupport, selectedDossieModel]);

  const associatedDossieAttachments = useMemo(() => {
    return [...form.attachments]
      .filter((item) => {
        const key = String(item.dossieItemKey || '').trim();
        if (!key) return false;
        const model = String(item.dossieModel || '').trim().toUpperCase();
        return !model || model === selectedDossieModel;
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }, [form.attachments, selectedDossieModel]);

  const unassociatedDossieAttachments = useMemo(() => {
    return [...form.attachments]
      .filter((item) => !String(item.dossieItemKey || '').trim())
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }, [form.attachments]);

  const getAttachmentPreviewUrl = (item: OccurrenceDetailAttachment) => {
    const remote = String(item.fileUrl || '').trim();
    if (remote) return remote;
    return `/api/occurrences/attachments/${encodeURIComponent(item.id)}/preview`;
  };

  const currentSectionKey = TAB_TO_SECTION[activeTab];

  const attachmentsForView = useMemo(() => {
    if (!isProjectSupport || activeTab === 'details') return form.attachments;
    return form.attachments.filter((item) => {
      const section = String(item.sectionKey || 'geral').trim() || 'geral';
      return section === currentSectionKey;
    });
  }, [form.attachments, isProjectSupport, activeTab, currentSectionKey]);

  const dossieAttachmentsByItem = useMemo(() => {
    const map = new Map<string, OccurrenceDetailAttachment[]>();
    form.attachments
      .filter((item) => String(item.sectionKey || '').trim() === 'dossie_eletronico')
      .forEach((item) => {
        const model = String(item.dossieModel || '').trim().toUpperCase();
        if (model && model !== selectedDossieModel) return;
        const key = String(item.dossieItemKey || '').trim();
        if (!key) return;
        const list = map.get(key) || [];
        list.push(item);
        map.set(key, list);
      });
    return map;
  }, [form.attachments, selectedDossieModel]);

  const sectionCounters = useMemo(() => {
    const counts: Record<ProjectSectionKey, number> = {
      geral: 0,
      candidatura: 0,
      acompanhamento: 0,
      encerramento: 0,
      dossie_eletronico: 0,
    };
    for (const item of form.attachments) {
      const section = (String(item.sectionKey || 'geral').trim() || 'geral') as ProjectSectionKey;
      if (counts[section] !== undefined) counts[section] += 1;
    }
    return counts;
  }, [form.attachments]);

  const patchProjectSupport = (next: ProjectSupportDetail) => {
    onChange({ projectSupport: next });
  };

  const syncAcompanhamentoLists = (
    candidatura: ProjectSupportDetail['candidatura'],
    acompanhamento: ProjectSupportDetail['acompanhamento']
  ): ProjectSupportDetail['acompanhamento'] => {
    return {
      ...acompanhamento,
      investimento: syncTrackedListFromBase(candidatura.investimento, acompanhamento.investimento),
      objetivosAviso: syncTrackedListFromBase(candidatura.objetivosAviso, acompanhamento.objetivosAviso),
      objetivosProjeto: syncTrackedListFromBase(candidatura.objetivosProjeto, acompanhamento.objetivosProjeto),
    };
  };

  const updateCandidaturaField = (field: keyof ProjectSupportDetail['candidatura'], value: string) => {
    const nextCandidatura = { ...projectSupport.candidatura, [field]: value };
    const nextAcompanhamento = syncAcompanhamentoLists(nextCandidatura, projectSupport.acompanhamento);
    patchProjectSupport({ ...projectSupport, candidatura: nextCandidatura, acompanhamento: nextAcompanhamento });
  };

  const updateCandidaturaListItem = (
    listKey: CandidaturaListKey,
    index: number,
    field: keyof ProjectSupportListItem,
    value: string
  ) => {
    const list = [...projectSupport.candidatura[listKey]];
    list[index] = { ...list[index], [field]: value };
    const nextCandidatura = { ...projectSupport.candidatura, [listKey]: list };
    const nextAcompanhamento = syncAcompanhamentoLists(nextCandidatura, projectSupport.acompanhamento);
    patchProjectSupport({ ...projectSupport, candidatura: nextCandidatura, acompanhamento: nextAcompanhamento });
  };

  const addCandidaturaListItem = (listKey: CandidaturaListKey) => {
    const nextList = [...projectSupport.candidatura[listKey], { designacao: '', valor: '', data: '' }];
    const nextCandidatura = { ...projectSupport.candidatura, [listKey]: nextList };
    const nextAcompanhamento = syncAcompanhamentoLists(nextCandidatura, projectSupport.acompanhamento);
    patchProjectSupport({ ...projectSupport, candidatura: nextCandidatura, acompanhamento: nextAcompanhamento });
  };

  const removeCandidaturaListItem = (listKey: CandidaturaListKey, index: number) => {
    const nextList = projectSupport.candidatura[listKey].filter((_, i) => i !== index);
    const nextCandidatura = { ...projectSupport.candidatura, [listKey]: nextList };
    const nextAcompanhamento = syncAcompanhamentoLists(nextCandidatura, projectSupport.acompanhamento);
    patchProjectSupport({ ...projectSupport, candidatura: nextCandidatura, acompanhamento: nextAcompanhamento });
  };

  const updateAcompanhamentoField = (field: keyof ProjectSupportDetail['acompanhamento'], value: string) => {
    patchProjectSupport({
      ...projectSupport,
      acompanhamento: { ...projectSupport.acompanhamento, [field]: value },
    });
  };

  const parseLocaleNumber = (value: string): number | null => {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const cleaned = raw.replace(/[^\d,.-]/g, '');
    if (!cleaned) return null;

    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    const decimalIndex = Math.max(lastComma, lastDot);

    let intPart = cleaned;
    let fracPart = '';

    if (decimalIndex >= 0) {
      intPart = cleaned.slice(0, decimalIndex);
      fracPart = cleaned.slice(decimalIndex + 1);
    }

    intPart = intPart.replace(/[^\d-]/g, '');
    fracPart = fracPart.replace(/[^\d]/g, '');

    const normalized = fracPart ? `${intPart}.${fracPart}` : intPart;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const formatEuroText = (value: string): string => {
    const numberValue = parseLocaleNumber(value);
    if (numberValue === null) return '';
    const formatted = new Intl.NumberFormat('pt-PT', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(numberValue);
    return `${formatted} €`;
  };

  const formatPercentText = (value: string): string => {
    const numberValue = parseLocaleNumber(value);
    if (numberValue === null) return '';
    const formatted = new Intl.NumberFormat('pt-PT', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(numberValue);
    return `${formatted}%`;
  };

  const normalizeMoneyInputText = (value: string) => String(value || '').replace(/[€]/g, '').trimStart();

  const normalizePercentInputText = (value: string) => String(value || '').replace(/[%]/g, '').trimStart();

  const updateAcompanhamentoMoneyField = (field: 'investimentoAprovado' | 'apoioAprovado', rawValue: string) => {
    updateAcompanhamentoField(field, normalizeMoneyInputText(rawValue));
  };

  const commitAcompanhamentoMoneyField = (field: 'investimentoAprovado' | 'apoioAprovado') => {
    updateAcompanhamentoField(field, formatEuroText(projectSupport.acompanhamento[field] || ''));
  };

  const updateAcompanhamentoPercentField = (rawValue: string) => {
    updateAcompanhamentoField('percentagemApoio', normalizePercentInputText(rawValue));
  };

  const commitAcompanhamentoPercentField = () => {
    updateAcompanhamentoField('percentagemApoio', formatPercentText(projectSupport.acompanhamento.percentagemApoio || ''));
  };

  const updateTrackedRealizado = (listKey: AcompanhamentoTrackedListKey, index: number, value: string) => {
    const list = [...projectSupport.acompanhamento[listKey]];
    list[index] = { ...list[index], realizado: value };
    patchProjectSupport({
      ...projectSupport,
      acompanhamento: { ...projectSupport.acompanhamento, [listKey]: list },
    });
  };

  const addApoiado = () => {
    patchProjectSupport({
      ...projectSupport,
      acompanhamento: {
        ...projectSupport.acompanhamento,
        funcionariosApoiados: [...projectSupport.acompanhamento.funcionariosApoiados, { nome: '', dataContratacao: '', dataFim: '' }],
      },
    });
  };

  const updateApoiado = (index: number, field: keyof ProjectSupportEmployeeItem, value: string) => {
    const list = [...projectSupport.acompanhamento.funcionariosApoiados];
    list[index] = { ...list[index], [field]: value };
    patchProjectSupport({
      ...projectSupport,
      acompanhamento: {
        ...projectSupport.acompanhamento,
        funcionariosApoiados: list,
      },
    });
  };

  const removeApoiado = (index: number) => {
    const list = projectSupport.acompanhamento.funcionariosApoiados.filter((_, i) => i !== index);
    patchProjectSupport({
      ...projectSupport,
      acompanhamento: {
        ...projectSupport.acompanhamento,
        funcionariosApoiados: list,
      },
    });
  };

  const addPedidoReembolso = () => {
    patchProjectSupport({
      ...projectSupport,
      acompanhamento: {
        ...projectSupport.acompanhamento,
        pedidosReembolso: [...projectSupport.acompanhamento.pedidosReembolso, { data: '', designacao: '', montante: '', estado: 'Pedido' }],
      },
    });
  };

  const updatePedidoReembolso = (index: number, field: keyof ProjectSupportRefundItem, value: string) => {
    const list = [...projectSupport.acompanhamento.pedidosReembolso];
    list[index] = { ...list[index], [field]: value };
    patchProjectSupport({
      ...projectSupport,
      acompanhamento: {
        ...projectSupport.acompanhamento,
        pedidosReembolso: list,
      },
    });
  };

  const updatePedidoReembolsoMontanteInput = (index: number, rawValue: string) => {
    updatePedidoReembolso(index, 'montante', normalizeMoneyInputText(rawValue));
  };

  const commitPedidoReembolsoMontante = (index: number) => {
    const current = String(projectSupport.acompanhamento.pedidosReembolso[index]?.montante || '');
    updatePedidoReembolso(index, 'montante', formatEuroText(current));
  };

  const removePedidoReembolso = (index: number) => {
    const list = projectSupport.acompanhamento.pedidosReembolso.filter((_, i) => i !== index);
    patchProjectSupport({
      ...projectSupport,
      acompanhamento: {
        ...projectSupport.acompanhamento,
        pedidosReembolso: list,
      },
    });
  };

  const updateEncerramentoField = (field: keyof ProjectSupportDetail['encerramento'], value: string) => {
    patchProjectSupport({
      ...projectSupport,
      encerramento: { ...projectSupport.encerramento, [field]: value },
    });
  };

  const updateDossieField = (field: keyof ProjectSupportDetail['dossieEletronico'], value: unknown) => {
    patchProjectSupport({
      ...projectSupport,
      dossieEletronico: { ...projectSupport.dossieEletronico, [field]: value },
    });
  };

  const updateDossieModel = (model: string) => {
    const normalized = String(model || '').trim().toUpperCase() || 'IAPMEI';
    patchProjectSupport({
      ...projectSupport,
      dossieEletronico: {
        ...projectSupport.dossieEletronico,
        modelo: normalized,
      },
    });
  };

  const toggleDossieItemNotApplicable = (itemKey: string, checked: boolean) => {
    const current = projectSupport.dossieEletronico.naoAplicavelPorItem || {};
    const next = { ...current, [itemKey]: !!checked };
    patchProjectSupport({
      ...projectSupport,
      dossieEletronico: {
        ...projectSupport.dossieEletronico,
        naoAplicavelPorItem: next,
      },
    });
  };

  const openDossieItemUpload = (itemKey: string) => {
    setPendingDossieItemKey(itemKey);
    dossieFileInputRef.current?.click();
  };

  const applyAttachmentUpdateFromApi = (updated: { attachments?: OccurrenceDetailAttachment[] } | null | undefined) => {
    if (!updated || !Array.isArray(updated.attachments)) return;
    onChange({ attachments: updated.attachments });
  };

  const associateAttachmentToDossieItem = async (attachmentId: string, dossieItemKey: string) => {
    const key = String(dossieItemKey || '').trim();
    if (!form.id || !attachmentId || !key) return;

    try {
      setDossieActionError('');
      setLinkingAttachmentId(attachmentId);
      const updated = await linkOccurrenceAttachmentToDossie({
        attachmentId,
        occurrenceId: form.id,
        dossieModel: selectedDossieModel,
        dossieItemKey: key,
      });
      applyAttachmentUpdateFromApi(updated);
    } catch (error) {
      setDossieActionError(error instanceof Error ? error.message : 'Falha ao associar documento ao separador.');
    } finally {
      setLinkingAttachmentId('');
    }
  };

  const clearAttachmentDossieAssociation = async (attachmentId: string) => {
    if (!form.id || !attachmentId) return;

    try {
      setDossieActionError('');
      setLinkingAttachmentId(attachmentId);
      const updated = await linkOccurrenceAttachmentToDossie({
        attachmentId,
        occurrenceId: form.id,
        dossieModel: selectedDossieModel,
        dossieItemKey: '',
      });
      applyAttachmentUpdateFromApi(updated);
    } catch (error) {
      setDossieActionError(error instanceof Error ? error.message : 'Falha ao remover associação do documento.');
    } finally {
      setLinkingAttachmentId('');
    }
  };

  const persistDossieSeparatorOrder = async (orderedKeys: string[]) => {
    const keys = orderedKeys.map((item) => String(item || '').trim()).filter(Boolean);
    if (!keys.length) return;
    await reorderDossieItems({ model: selectedDossieModel, orderedKeys: keys });
  };

  const reorderDossieSeparator = async (fromKey: string, toKey: string) => {
    const source = String(fromKey || '').trim();
    const target = String(toKey || '').trim();
    if (!source || !target || source === target) return;

    const ordered = dossieItemCatalog.map((item) => String(item.key || '').trim()).filter(Boolean);
    const fromIndex = ordered.indexOf(source);
    const toIndex = ordered.indexOf(target);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const next = [...ordered];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);

    try {
      setReorderingSeparators(true);
      setDossieActionError('');
      await persistDossieSeparatorOrder(next);
      const reloaded = await fetchDossieItems(selectedDossieModel);
      setDossieItemsRemote(Array.isArray(reloaded) ? reloaded : []);
    } catch (error) {
      setDossieActionError(error instanceof Error ? error.message : 'Falha ao reordenar separadores do dossiê.');
    } finally {
      setReorderingSeparators(false);
    }
  };

  const handleDropAttachmentOnSeparator = async (event: React.DragEvent<HTMLDivElement>, separatorKey: string) => {
    event.preventDefault();
    setDragOverDossieKey('');
    const draggedSeparatorKey = String(event.dataTransfer.getData('application/x-dossie-separator-key') || '').trim();
    if (draggedSeparatorKey) {
      setDraggingSeparatorKey('');
      await reorderDossieSeparator(draggedSeparatorKey, separatorKey);
      return;
    }

    const attachmentId = String(
      event.dataTransfer.getData('application/x-occurrence-attachment-id') || event.dataTransfer.getData('text/plain') || ''
    ).trim();
    if (!attachmentId) return;
    await associateAttachmentToDossieItem(attachmentId, separatorKey);
  };

  const handleCreateGlobalSeparator = async () => {
    const principal = String(newSeparatorPrincipal || '').trim();
    const nivel2 = String(newSeparatorNivel2 || '').trim();
    const designacao = String(newSeparatorDesignacao || '').trim();

    if (!principal || !nivel2) {
      setDossieActionError('Preencha Principal e Nível 2 para criar o separador.');
      return;
    }

    try {
      setCreatingSeparator(true);
      setDossieActionError('');
      await createDossieItem({
        model: 'GLOBAL',
        principal,
        nivel2,
        designacao: designacao || nivel2,
      });
      const reloaded = await fetchDossieItems(selectedDossieModel);
      setDossieItemsRemote(Array.isArray(reloaded) ? reloaded : []);
      setNewSeparatorPrincipal('');
      setNewSeparatorNivel2('');
      setNewSeparatorDesignacao('');
    } catch (error) {
      setDossieActionError(error instanceof Error ? error.message : 'Falha ao criar separador global.');
    } finally {
      setCreatingSeparator(false);
    }
  };

  const resetAcompanhamentoFromCandidatura = () => {
    const nextAcompanhamento = syncAcompanhamentoLists(projectSupport.candidatura, projectSupport.acompanhamento);
    patchProjectSupport({ ...projectSupport, acompanhamento: nextAcompanhamento });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-black/45 p-2 md:p-3">
      <div className="mx-auto w-[min(98vw,1900px)] rounded-2xl border border-slate-200 bg-[#f3f6fb] shadow-2xl">
        <div className="mx-3 mt-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              ← Voltar
            </button>
            <div className="text-center">
              <h2 className="text-xl font-bold text-slate-900">{form.id ? 'Editar Ocorrência' : 'Nova Ocorrência'}</h2>
              <p className="text-sm text-slate-500">Atualize os dados e anexe ficheiros.</p>
            </div>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || uploadingAttachment || loading}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Save size={15} />
              {saving ? 'A guardar...' : 'Gravar'}
            </button>
          </div>
        </div>

        <div className="p-3 md:p-4">
          {loading ? (
            <div className="rounded-xl border border-slate-200 bg-white py-16 text-center text-slate-500">A carregar detalhe...</div>
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_390px]">
              <div className="space-y-4">
                <section className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="mb-4 flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
                    <div>
                      <h3 className="text-xl font-semibold text-slate-900">Detalhes</h3>
                      <p className="text-sm text-slate-500">Campos essenciais primeiro. O resto é opcional.</p>
                    </div>
                    <div className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5">
                      <button
                        type="button"
                        onClick={() => onChange({ state: isClosed ? 'ABERTA' : 'RESOLVIDA' })}
                        className={`rounded-full px-3 py-1 text-sm font-semibold transition ${
                          isClosed ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'bg-blue-600 text-white hover:bg-blue-500'
                        }`}
                        title="Clique para alternar estado"
                      >
                        {isClosed ? 'Fechada' : 'Aberta'}
                      </button>
                    </div>
                  </div>

                  <div className="mb-4 flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
                    <TabButton active={activeTab === 'details'} onClick={() => setActiveTab('details')}>
                      Detalhes
                    </TabButton>
                    {isProjectSupport && (
                      <>
                        <TabButton active={activeTab === 'candidatura'} onClick={() => setActiveTab('candidatura')}>
                          Candidatura
                        </TabButton>
                        <TabButton active={activeTab === 'acompanhamento'} onClick={() => setActiveTab('acompanhamento')}>
                          Acompanhamento
                        </TabButton>
                        <TabButton active={activeTab === 'encerramento'} onClick={() => setActiveTab('encerramento')}>
                          Encerramento
                        </TabButton>
                        <TabButton active={activeTab === 'dossie'} onClick={() => setActiveTab('dossie')}>
                          Dossie Eletronico
                        </TabButton>
                      </>
                    )}
                  </div>

                  {activeTab === 'details' && (
                    <>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <Field label="Cliente *">
                          <select
                            value={form.customerId}
                            onChange={(event) => onChange({ customerId: event.target.value })}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          >
                            <option value="">Selecione...</option>
                            {customers.map((customer) => (
                              <option key={customer.id} value={customer.id}>
                                {customer.company || customer.name} {customer.nif ? `(${customer.nif})` : ''}
                              </option>
                            ))}
                          </select>
                        </Field>

                        <Field label="Data limite">
                          <input
                            type="date"
                            value={form.dueDate}
                            onChange={(event) => onChange({ dueDate: event.target.value })}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          />
                        </Field>

                        <Field label="Tipo *">
                          <select
                            value={form.typeId}
                            onChange={(event) => onChange({ typeId: event.target.value })}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          >
                            <option value="">Selecione...</option>
                            {types.map((type) => (
                              <option key={type.id} value={String(type.id)}>
                                {type.name}
                              </option>
                            ))}
                          </select>
                        </Field>

                        <Field label="Data">
                          <input
                            type="date"
                            value={form.date}
                            onChange={(event) => onChange({ date: event.target.value })}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          />
                        </Field>
                      </div>

                      <div className="mt-4">
                        <Field label="Responsáveis">
                          <select
                            onChange={(event) => {
                              const value = String(event.target.value || '').trim();
                              if (value) onAddResponsible(value);
                              event.target.value = '';
                            }}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          >
                            <option value="">+ Adicionar responsável...</option>
                            {users
                              .filter((user) => !form.responsibleUserIds.includes(user.id))
                              .map((user) => (
                                <option key={user.id} value={user.id}>
                                  {user.name}
                                </option>
                              ))}
                          </select>
                        </Field>

                        <div className="mt-2 flex flex-wrap gap-2">
                          {selectedUsers.length === 0 ? (
                            <p className="text-xs text-slate-500">Sem responsáveis selecionados.</p>
                          ) : (
                            selectedUsers.map((user) => (
                              <span
                                key={user.id}
                                className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-sm font-medium text-blue-800"
                              >
                                {user.name}
                                <button
                                  type="button"
                                  onClick={() => onRemoveResponsible(user.id)}
                                  className="text-blue-700 hover:text-blue-900"
                                  title="Remover"
                                >
                                  ×
                                </button>
                              </span>
                            ))
                          )}
                        </div>
                      </div>

                      <div className="mt-4">
                        <Field label="Título *">
                          <input
                            type="text"
                            value={form.title}
                            onChange={(event) => onChange({ title: event.target.value })}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                            placeholder="Título da ocorrência"
                          />
                        </Field>
                      </div>

                      <div className="mt-4">
                        <Field label="Descrição">
                          <textarea
                            rows={7}
                            value={form.description}
                            onChange={(event) => onChange({ description: event.target.value })}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          />
                        </Field>
                      </div>

                      <div className="mt-4">
                        <Field label="Resolução / Notas finais">
                          <textarea
                            rows={4}
                            value={form.resolution}
                            onChange={(event) => onChange({ resolution: event.target.value })}
                            className="w-full rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900"
                          />
                        </Field>
                      </div>
                    </>
                  )}

                  {activeTab === 'candidatura' && isProjectSupport && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        <Field label="Fase">
                          <select
                            value={projectSupport.candidatura.fase}
                            onChange={(e) => updateCandidaturaField('fase', e.target.value)}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          >
                            {PHASE_OPTIONS.map((item) => (
                              <option key={item} value={item}>{item}</option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Faturado">
                          <select
                            value={projectSupport.candidatura.faturado}
                            onChange={(e) => updateCandidaturaField('faturado', e.target.value)}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          >
                            <option value="">--</option>
                            {BILLING_OPTIONS.map((item) => (
                              <option key={item.value} value={item.value}>{item.label}</option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Valor acordado">
                          <input
                            type="text"
                            value={projectSupport.candidatura.valorAcordado}
                            onChange={(e) => updateCandidaturaField('valorAcordado', e.target.value)}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          />
                        </Field>
                        <Field label="Aviso n.º">
                          <input
                            type="text"
                            value={projectSupport.candidatura.avisoNumero}
                            onChange={(e) => updateCandidaturaField('avisoNumero', e.target.value)}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          />
                        </Field>
                        <Field label="Data prevista início">
                          <input
                            type="date"
                            value={projectSupport.candidatura.dataPrevistaInicio}
                            onChange={(e) => updateCandidaturaField('dataPrevistaInicio', e.target.value)}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          />
                        </Field>
                        <Field label="Data prevista fim">
                          <input
                            type="date"
                            value={projectSupport.candidatura.dataPrevistaFim}
                            onChange={(e) => updateCandidaturaField('dataPrevistaFim', e.target.value)}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          />
                        </Field>
                      </div>

                      <SimpleListEditor
                        title="Investimento"
                        rows={projectSupport.candidatura.investimento}
                        onAdd={() => addCandidaturaListItem('investimento')}
                        onRemove={(index) => removeCandidaturaListItem('investimento', index)}
                        onChange={(index, field, value) => updateCandidaturaListItem('investimento', index, field, value)}
                      />

                      <SimpleListEditor
                        title="Objetivos do aviso"
                        rows={projectSupport.candidatura.objetivosAviso}
                        onAdd={() => addCandidaturaListItem('objetivosAviso')}
                        onRemove={(index) => removeCandidaturaListItem('objetivosAviso', index)}
                        onChange={(index, field, value) => updateCandidaturaListItem('objetivosAviso', index, field, value)}
                      />

                      <SimpleListEditor
                        title="Objetivos do projeto"
                        rows={projectSupport.candidatura.objetivosProjeto}
                        onAdd={() => addCandidaturaListItem('objetivosProjeto')}
                        onRemove={(index) => removeCandidaturaListItem('objetivosProjeto', index)}
                        onChange={(index, field, value) => updateCandidaturaListItem('objetivosProjeto', index, field, value)}
                      />

                      <Field label="Observações">
                        <textarea
                          rows={4}
                          value={projectSupport.candidatura.observacoes}
                          onChange={(e) => updateCandidaturaField('observacoes', e.target.value)}
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                        />
                      </Field>
                    </div>
                  )}

                  {activeTab === 'acompanhamento' && isProjectSupport && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          onClick={resetAcompanhamentoFromCandidatura}
                          className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                        >
                          Sincronizar listas da candidatura
                        </button>
                      </div>

                      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        <Field label="Projeto n.º">
                          <input type="text" value={projectSupport.acompanhamento.projetoNumero} onChange={(e) => updateAcompanhamentoField('projetoNumero', e.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm" />
                        </Field>
                        <Field label="Designação Projeto">
                          <input type="text" value={projectSupport.acompanhamento.designacaoProjeto} onChange={(e) => updateAcompanhamentoField('designacaoProjeto', e.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm" />
                        </Field>
                      </div>

                      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        <Field label="Entidade gestora">
                          <input type="text" value={projectSupport.acompanhamento.entidadeGestora} onChange={(e) => updateAcompanhamentoField('entidadeGestora', e.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm" />
                        </Field>
                        <Field label="Nome do gestor">
                          <input type="text" value={projectSupport.acompanhamento.nomeGestor} onChange={(e) => updateAcompanhamentoField('nomeGestor', e.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm" />
                        </Field>
                        <Field label="Contacto">
                          <input type="text" value={projectSupport.acompanhamento.contactoGestor} onChange={(e) => updateAcompanhamentoField('contactoGestor', e.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm" />
                        </Field>
                      </div>

                      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        <Field label="Data submissão">
                          <input type="date" value={projectSupport.acompanhamento.dataSubmissao} onChange={(e) => updateAcompanhamentoField('dataSubmissao', e.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm" />
                        </Field>
                        <Field label="Data início">
                          <input type="date" value={projectSupport.acompanhamento.dataInicio} onChange={(e) => updateAcompanhamentoField('dataInicio', e.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm" />
                        </Field>
                        <Field label="Data encerramento">
                          <input type="date" value={projectSupport.acompanhamento.dataEncerramento} onChange={(e) => updateAcompanhamentoField('dataEncerramento', e.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm" />
                        </Field>
                      </div>

                      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        <Field label="Investimento aprovado (€)">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={projectSupport.acompanhamento.investimentoAprovado}
                            onChange={(e) => updateAcompanhamentoMoneyField('investimentoAprovado', e.target.value)}
                            onBlur={() => commitAcompanhamentoMoneyField('investimentoAprovado')}
                            placeholder="0,00 €"
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-right text-sm"
                          />
                        </Field>
                        <Field label="Apoio aprovado (€)">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={projectSupport.acompanhamento.apoioAprovado}
                            onChange={(e) => updateAcompanhamentoMoneyField('apoioAprovado', e.target.value)}
                            onBlur={() => commitAcompanhamentoMoneyField('apoioAprovado')}
                            placeholder="0,00 €"
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-right text-sm"
                          />
                        </Field>
                        <Field label="% apoio">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={projectSupport.acompanhamento.percentagemApoio}
                            onChange={(e) => updateAcompanhamentoPercentField(e.target.value)}
                            onBlur={commitAcompanhamentoPercentField}
                            placeholder="0%"
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-right text-sm"
                          />
                        </Field>
                      </div>

                      <TrackedListView
                        title="Objetivos do aviso (importado da candidatura + realizado)"
                        rows={projectSupport.acompanhamento.objetivosAviso}
                        onChangeRealizado={(index, value) => updateTrackedRealizado('objetivosAviso', index, value)}
                      />

                      <TrackedListView
                        title="Objetivos do projeto (importado da candidatura + realizado)"
                        rows={projectSupport.acompanhamento.objetivosProjeto}
                        onChangeRealizado={(index, value) => updateTrackedRealizado('objetivosProjeto', index, value)}
                      />

                      <TrackedListView
                        title="Investimento (importado da candidatura + realizado)"
                        rows={projectSupport.acompanhamento.investimento}
                        onChangeRealizado={(index, value) => updateTrackedRealizado('investimento', index, value)}
                      />

                      <EmployeesListEditor
                        rows={projectSupport.acompanhamento.funcionariosApoiados}
                        onAdd={addApoiado}
                        onChange={updateApoiado}
                        onRemove={removeApoiado}
                      />

                      <RefundsListEditor
                        rows={projectSupport.acompanhamento.pedidosReembolso}
                        onAdd={addPedidoReembolso}
                        onChange={updatePedidoReembolso}
                        onMontanteChange={updatePedidoReembolsoMontanteInput}
                        onMontanteBlur={commitPedidoReembolsoMontante}
                        onRemove={removePedidoReembolso}
                      />

                      <Field label="Observações">
                        <textarea
                          rows={4}
                          value={projectSupport.acompanhamento.observacoes}
                          onChange={(e) => updateAcompanhamentoField('observacoes', e.target.value)}
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                        />
                      </Field>
                    </div>
                  )}

                  {activeTab === 'encerramento' && isProjectSupport && (
                    <div className="space-y-4">
                      <Field label="Licença">
                        <textarea
                          rows={3}
                          value={projectSupport.encerramento.licenca}
                          onChange={(e) => updateEncerramentoField('licenca', e.target.value)}
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                        />
                      </Field>
                      <Field label="Provas de cumprimento">
                        <textarea
                          rows={4}
                          value={projectSupport.encerramento.provasCumprimento}
                          onChange={(e) => updateEncerramentoField('provasCumprimento', e.target.value)}
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                        />
                      </Field>
                      <Field label="Relatório">
                        <textarea
                          rows={4}
                          value={projectSupport.encerramento.relatorio}
                          onChange={(e) => updateEncerramentoField('relatorio', e.target.value)}
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                        />
                      </Field>
                      <Field label="Notas finais de encerramento">
                        <textarea
                          rows={4}
                          value={projectSupport.encerramento.notas}
                          onChange={(e) => updateEncerramentoField('notas', e.target.value)}
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                        />
                      </Field>
                    </div>
                  )}

                  {activeTab === 'dossie' && isProjectSupport && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <Field label="Modelo de Dossiê">
                          <select
                            value={selectedDossieModel}
                            onChange={(e) => updateDossieModel(e.target.value)}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          >
                            {DOSSIE_MODEL_OPTIONS.map((item) => (
                              <option key={item} value={item}>
                                {item}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Notas do Dossiê">
                          <textarea
                            rows={3}
                            value={projectSupport.dossieEletronico.notas}
                            onChange={(e) => updateDossieField('notas', e.target.value)}
                            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                          />
                        </Field>
                      </div>

                      <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <h4 className="text-sm font-semibold text-emerald-900">Adicionar separador global</h4>
                          <span className="text-xs text-emerald-700">Fica disponível para todos os dossiês</span>
                        </div>
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
                          <input
                            type="text"
                            placeholder="Principal (ex: 8.Anexos)"
                            value={newSeparatorPrincipal}
                            onChange={(e) => setNewSeparatorPrincipal(e.target.value)}
                            className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm"
                          />
                          <input
                            type="text"
                            placeholder="Nível 2"
                            value={newSeparatorNivel2}
                            onChange={(e) => setNewSeparatorNivel2(e.target.value)}
                            className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm"
                          />
                          <input
                            type="text"
                            placeholder="Descrição do documento"
                            value={newSeparatorDesignacao}
                            onChange={(e) => setNewSeparatorDesignacao(e.target.value)}
                            className="rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => void handleCreateGlobalSeparator()}
                            disabled={creatingSeparator}
                            className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {creatingSeparator ? 'A adicionar...' : 'Adicionar separador'}
                          </button>
                        </div>
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-white p-3">
                        <h4 className="text-sm font-semibold text-slate-900">Documentos associados ({associatedDossieAttachments.length})</h4>
                        <p className="mb-2 text-xs text-slate-500">Estes já estão ligados a um separador do dossiê.</p>
                        {associatedDossieAttachments.length === 0 ? (
                          <p className="text-xs text-slate-500">Sem documentos associados neste modelo.</p>
                        ) : (
                          <div className="space-y-1.5">
                            {associatedDossieAttachments.map((attachment) => {
                              const key = String(attachment.dossieItemKey || '').trim();
                              const separator = dossieCatalogByKey.get(key);
                              const label = attachment.originalName || attachment.storagePath || attachment.localFilePath || '--';
                              return (
                                <div key={`assoc-${attachment.id}`} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                                  <span className="truncate text-slate-800" title={label}>{label}</span>
                                  <span className="ml-auto shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                                    {separator ? `${separator.principal} • ${separator.nivel2}` : key}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => window.open(getAttachmentPreviewUrl(attachment), '_blank', 'noopener,noreferrer')}
                                    className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                                  >
                                    Ver
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void clearAttachmentDossieAssociation(attachment.id)}
                                    disabled={linkingAttachmentId === attachment.id}
                                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                                  >
                                    {linkingAttachmentId === attachment.id ? 'A remover...' : 'Desassociar'}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                        <h4 className="text-sm font-semibold text-amber-900">Documentos não associados ({unassociatedDossieAttachments.length})</h4>
                        <p className="mb-2 text-xs text-amber-800">Arraste um documento para cima de um separador da grelha para o associar.</p>
                        {unassociatedDossieAttachments.length === 0 ? (
                          <p className="text-xs text-slate-500">Sem documentos pendentes de associação.</p>
                        ) : (
                          <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                            {unassociatedDossieAttachments.map((attachment) => {
                              const label = attachment.originalName || attachment.storagePath || attachment.localFilePath || '--';
                              return (
                                <div
                                  key={`pending-${attachment.id}`}
                                  draggable
                                  onDragStart={(event) => {
                                    event.dataTransfer.setData('application/x-occurrence-attachment-id', attachment.id);
                                    event.dataTransfer.setData('text/plain', attachment.id);
                                    event.dataTransfer.effectAllowed = 'move';
                                  }}
                                  className="flex cursor-grab items-center gap-2 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm active:cursor-grabbing"
                                  title="Arraste para um separador"
                                >
                                  <span className="truncate text-slate-800" title={label}>{label}</span>
                                  <button
                                    type="button"
                                    onClick={() => window.open(getAttachmentPreviewUrl(attachment), '_blank', 'noopener,noreferrer')}
                                    className="ml-auto rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                                  >
                                    Ver
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      {dossieItemsLoading && (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                          A carregar separadores do dossiê...
                        </div>
                      )}
                      {!dossieItemsLoading && dossieItemCatalog.length > 1 && (
                        <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                          Reordenar separadores: arraste uma linha da grelha e largue sobre outra.
                        </div>
                      )}
                      {reorderingSeparators && (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                          A guardar nova ordem dos separadores...
                        </div>
                      )}

                      {dossieItemCatalog.length > 0 ? (
                        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                          <div className="overflow-x-auto">
                            <div className="min-w-[980px]">
                              <div className="grid grid-cols-[240px_minmax(0,1fr)_120px_260px] gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                                <span>Separador</span>
                                <span>Documento</span>
                                <span>Estado</span>
                                <span>Ações</span>
                              </div>
                              {dossieItemCatalog.map((item) => {
                                const files = dossieAttachmentsByItem.get(item.key) || [];
                                const naoAplicavel = Boolean(projectSupport.dossieEletronico.naoAplicavelPorItem?.[item.key]);
                                const concluido = naoAplicavel || files.length > 0;
                                return (
                                  <div
                                    key={item.key}
                                    draggable
                                    onDragStart={(event) => {
                                      event.dataTransfer.setData('application/x-dossie-separator-key', item.key);
                                      event.dataTransfer.effectAllowed = 'move';
                                      setDraggingSeparatorKey(item.key);
                                    }}
                                    onDragEnd={() => setDraggingSeparatorKey('')}
                                    onDragOver={(event) => {
                                      event.preventDefault();
                                      setDragOverDossieKey(item.key);
                                    }}
                                    onDragLeave={() => setDragOverDossieKey((current) => (current === item.key ? '' : current))}
                                    onDrop={(event) => void handleDropAttachmentOnSeparator(event, item.key)}
                                    className={
                                      'grid grid-cols-[240px_minmax(0,1fr)_120px_260px] gap-2 border-b border-slate-100 px-3 py-2 text-sm last:border-b-0 cursor-move ' +
                                      (concluido ? 'bg-emerald-50/60' : 'bg-white') +
                                      (dragOverDossieKey === item.key ? ' ring-2 ring-blue-300 ring-inset' : '') +
                                      (draggingSeparatorKey === item.key ? ' opacity-70' : '')
                                    }
                                  >
                                    <div className="truncate text-xs text-slate-600" title={`${item.principal} • ${item.nivel2}`}>
                                      ↕ {item.principal} • {item.nivel2}
                                    </div>
                                    <div className="min-w-0">
                                      <p className="truncate font-medium text-slate-900" title={item.designacao}>
                                        {item.designacao}
                                      </p>
                                      {files.length > 0 ? (
                                        <ul className="mt-1 space-y-0.5 text-xs text-blue-700">
                                          {files.map((file) => {
                                            const fileLabel = String(file.originalName || file.storagePath || file.localFilePath || '--');
                                            return (
                                              <li key={`${item.key}-${file.id}`} className="truncate" title={fileLabel}>
                                                • {fileLabel}
                                              </li>
                                            );
                                          })}
                                        </ul>
                                      ) : (
                                        <p className="text-xs text-slate-500">{naoAplicavel ? 'Não aplicável' : 'Sem ficheiro'}</p>
                                      )}
                                    </div>
                                    <div>
                                      <span
                                        className={
                                          'inline-flex rounded-full px-2 py-1 text-xs font-semibold ' +
                                          (concluido ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600')
                                        }
                                      >
                                        {concluido ? 'Concluído' : 'Pendente'}
                                      </span>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        type="button"
                                        onClick={() => openDossieItemUpload(item.key)}
                                        disabled={uploadingAttachment || !form.id}
                                        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                                      >
                                        Anexar
                                      </button>
                                      <label className="inline-flex items-center gap-1.5 text-xs text-slate-700">
                                        <input
                                          type="checkbox"
                                          checked={naoAplicavel}
                                          onChange={(e) => toggleDossieItemNotApplicable(item.key, e.target.checked)}
                                        />
                                        N/A
                                      </label>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                          Modelo {selectedDossieModel}: sem separadores disponíveis.
                        </div>
                      )}

                      {dossieActionError && (
                        <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          {dossieActionError}
                        </div>
                      )}

                      <Field label="Documentos necessários (notas livres)">
                        <textarea
                          rows={4}
                          value={projectSupport.dossieEletronico.documentosNecessarios}
                          onChange={(e) => updateDossieField('documentosNecessarios', e.target.value)}
                          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm"
                        />
                      </Field>

                      <input
                        ref={dossieFileInputRef}
                        type="file"
                        className="hidden"
                        onChange={(event) => {
                          onUploadFiles(event.target.files, 'dossie_eletronico', {
                            dossieModel: selectedDossieModel,
                            dossieItemKey: pendingDossieItemKey || undefined,
                          });
                          event.currentTarget.value = '';
                          setPendingDossieItemKey('');
                        }}
                      />
                    </div>
                  )}

                </section>
              </div>

              <div>
                <section className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="mb-3 flex items-center justify-between border-b border-slate-200 pb-3">
                    <div className="flex items-center gap-2">
                      <Paperclip size={16} className="text-slate-500" />
                      <div>
                        <h3 className="text-xl font-semibold text-slate-900">Anexos</h3>
                        <p className="text-sm text-slate-500">Imagens ou PDF. Arrasta e larga ou clica.</p>
                      </div>
                    </div>
                    <span className="rounded-full bg-blue-100 px-2.5 py-1 text-sm font-semibold text-blue-700">
                      {attachmentsForView.length}
                    </span>
                  </div>

                  {isProjectSupport && (
                    <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
                      <SectionPill label="Geral" count={sectionCounters.geral} active={currentSectionKey === 'geral'} />
                      <SectionPill label="Candidatura" count={sectionCounters.candidatura} active={currentSectionKey === 'candidatura'} />
                      <SectionPill label="Acompanhamento" count={sectionCounters.acompanhamento} active={currentSectionKey === 'acompanhamento'} />
                      <SectionPill label="Encerramento" count={sectionCounters.encerramento} active={currentSectionKey === 'encerramento'} />
                      <SectionPill label="Dossie" count={sectionCounters.dossie_eletronico} active={currentSectionKey === 'dossie_eletronico'} />
                    </div>
                  )}

                  <div
                    className={`rounded-2xl border-2 border-dashed p-8 text-center transition ${
                      dragOver ? 'border-blue-400 bg-blue-50' : 'border-slate-300 bg-slate-50'
                    }`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragOver(false);
                      onUploadFiles(
                        event.dataTransfer.files,
                        currentSectionKey,
                        currentSectionKey === 'dossie_eletronico' ? { dossieModel: selectedDossieModel } : undefined
                      );
                    }}
                  >
                    <Upload size={26} className="mx-auto mb-3 text-blue-500" />
                    <p className="text-lg font-semibold text-slate-900">Arraste ficheiros aqui</p>
                    <p className="text-sm text-slate-600">ou clique para selecionar (PDF/Imagem)</p>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingAttachment || !form.id}
                      className="mt-4 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {uploadingAttachment ? 'A enviar...' : 'Selecionar ficheiros'}
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(event) => {
                        onUploadFiles(
                          event.target.files,
                          currentSectionKey,
                          currentSectionKey === 'dossie_eletronico' ? { dossieModel: selectedDossieModel } : undefined
                        );
                        event.currentTarget.value = '';
                      }}
                    />
                  </div>

                  {!form.id && (
                    <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Guarde a ocorrência primeiro para permitir anexos.
                    </p>
                  )}

                  {uploadAttachmentError && (
                    <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      {uploadAttachmentError}
                    </p>
                  )}

                  <p className="mt-3 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                    Dica: os ficheiros ficam em <strong>Ocorrencias/Tipo/Título</strong> na pasta do cliente.
                  </p>

                  <div className="mt-3 space-y-1.5">
                    {attachmentsForView.length === 0 ? (
                      <p className="text-sm text-slate-500">Sem anexos neste separador.</p>
                    ) : (
                      attachmentsForView.map((item) => {
                        const label = item.originalName || item.storagePath || item.localFilePath || '--';
                        const previewUrl = getAttachmentPreviewUrl(item);
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => window.open(previewUrl, '_blank', 'noopener,noreferrer')}
                            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left hover:bg-slate-100"
                            title="Clique para pré-visualizar"
                          >
                            <div className="flex items-center gap-2">
                              <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800" title={label}>
                                {label}
                              </p>
                              <Eye size={16} className="shrink-0 text-blue-600" aria-hidden="true" />
                              <span className="sr-only">Pré-visualizar</span>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </section>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block">
    <span className="mb-1 block text-sm font-semibold text-slate-800">{label}</span>
    {children}
  </label>
);

const TabButton: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`rounded-xl px-3 py-1.5 text-sm font-semibold ${
      active ? 'border border-blue-200 bg-blue-50 text-blue-700' : 'border border-transparent text-slate-600 hover:bg-slate-200'
    }`}
  >
    {children}
  </button>
);

const SectionPill: React.FC<{ label: string; count: number; active: boolean }> = ({ label, count, active }) => (
  <span className={`rounded-full border px-2.5 py-1 text-center ${active ? 'border-blue-200 bg-blue-50 text-blue-700' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>
    {label}: {count}
  </span>
);

const SimpleListEditor: React.FC<{
  title: string;
  rows: ProjectSupportListItem[];
  onAdd: () => void;
  onRemove: (index: number) => void;
  onChange: (index: number, field: keyof ProjectSupportListItem, value: string) => void;
}> = ({ title, rows, onAdd, onRemove, onChange }) => (
  <div className="rounded-xl border border-slate-200 p-3">
    <div className="mb-2 flex items-center justify-between">
      <h4 className="text-sm font-semibold text-slate-800">{title}</h4>
      <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50">
        <Plus size={12} /> Adicionar
      </button>
    </div>
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={`${title}-${index}`} className="grid grid-cols-1 gap-2 md:grid-cols-12">
          <input
            type="text"
            placeholder="Designação"
            value={row.designacao}
            onChange={(e) => onChange(index, 'designacao', e.target.value)}
            className="md:col-span-6 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="text"
            placeholder="Valor"
            value={row.valor}
            onChange={(e) => onChange(index, 'valor', e.target.value)}
            className="md:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="date"
            value={row.data}
            onChange={(e) => onChange(index, 'data', e.target.value)}
            className="md:col-span-3 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button type="button" onClick={() => onRemove(index)} className="md:col-span-1 rounded-lg border border-red-200 px-2 py-2 text-xs text-red-700 hover:bg-red-50">
            Remover
          </button>
        </div>
      ))}
      {rows.length === 0 && <p className="text-xs text-slate-500">Sem linhas.</p>}
    </div>
  </div>
);

const TrackedListView: React.FC<{
  title: string;
  rows: Array<{ designacao: string; valor: string; data: string; realizado: string }>;
  onChangeRealizado: (index: number, value: string) => void;
}> = ({ title, rows, onChangeRealizado }) => (
  <div className="rounded-xl border border-slate-200 p-3">
    <h4 className="mb-2 text-sm font-semibold text-slate-800">{title}</h4>
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={`${title}-${index}`} className="grid grid-cols-1 gap-2 md:grid-cols-12">
          <input type="text" value={row.designacao} readOnly className="md:col-span-5 rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm" />
          <input type="text" value={row.valor} readOnly className="md:col-span-2 rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm" />
          <input type="date" value={row.data} readOnly className="md:col-span-2 rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm" />
          <input
            type="text"
            placeholder="Realizado"
            value={row.realizado}
            onChange={(e) => onChangeRealizado(index, e.target.value)}
            className="md:col-span-3 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          />
        </div>
      ))}
      {rows.length === 0 && <p className="text-xs text-slate-500">Sem linhas importadas da candidatura.</p>}
    </div>
  </div>
);

const EmployeesListEditor: React.FC<{
  rows: ProjectSupportEmployeeItem[];
  onAdd: () => void;
  onChange: (index: number, field: keyof ProjectSupportEmployeeItem, value: string) => void;
  onRemove: (index: number) => void;
}> = ({ rows, onAdd, onChange, onRemove }) => (
  <div className="rounded-xl border border-slate-200 p-3">
    <div className="mb-2 flex items-center justify-between">
      <h4 className="text-sm font-semibold text-slate-800">Funcionários apoiados</h4>
      <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50">
        <Plus size={12} /> Adicionar
      </button>
    </div>
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={`apo-${index}`} className="grid grid-cols-1 gap-2 md:grid-cols-12">
          <input type="text" placeholder="Nome" value={row.nome} onChange={(e) => onChange(index, 'nome', e.target.value)} className="md:col-span-5 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <input type="date" value={row.dataContratacao} onChange={(e) => onChange(index, 'dataContratacao', e.target.value)} className="md:col-span-3 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <input type="date" value={row.dataFim} onChange={(e) => onChange(index, 'dataFim', e.target.value)} className="md:col-span-3 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button type="button" onClick={() => onRemove(index)} className="md:col-span-1 rounded-lg border border-red-200 px-2 py-2 text-xs text-red-700 hover:bg-red-50">Remover</button>
        </div>
      ))}
      {rows.length === 0 && <p className="text-xs text-slate-500">Sem funcionários apoiados.</p>}
    </div>
  </div>
);

const RefundsListEditor: React.FC<{
  rows: ProjectSupportRefundItem[];
  onAdd: () => void;
  onChange: (index: number, field: keyof ProjectSupportRefundItem, value: string) => void;
  onMontanteChange?: (index: number, value: string) => void;
  onMontanteBlur?: (index: number) => void;
  onRemove: (index: number) => void;
}> = ({ rows, onAdd, onChange, onMontanteChange, onMontanteBlur, onRemove }) => (
  <div className="rounded-xl border border-slate-200 p-3">
    <div className="mb-2 flex items-center justify-between">
      <h4 className="text-sm font-semibold text-slate-800">Pedidos de reembolso</h4>
      <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50">
        <Plus size={12} /> Adicionar
      </button>
    </div>
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={`reb-${index}`} className="grid grid-cols-1 gap-2 md:grid-cols-12">
          <input type="date" value={row.data} onChange={(e) => onChange(index, 'data', e.target.value)} className="md:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <input type="text" placeholder="Designação" value={row.designacao} onChange={(e) => onChange(index, 'designacao', e.target.value)} className="md:col-span-5 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <input
            type="text"
            inputMode="decimal"
            placeholder="0,00 €"
            value={row.montante}
            onChange={(e) => (onMontanteChange ? onMontanteChange(index, e.target.value) : onChange(index, 'montante', e.target.value))}
            onBlur={() => onMontanteBlur?.(index)}
            className="md:col-span-2 rounded-lg border border-slate-300 px-3 py-2 text-right text-sm"
          />
          <select value={row.estado} onChange={(e) => onChange(index, 'estado', e.target.value)} className="md:col-span-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">--</option>
            {REFUND_STATUS_OPTIONS.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <button type="button" onClick={() => onRemove(index)} className="md:col-span-1 rounded-lg border border-red-200 px-2 py-2 text-xs text-red-700 hover:bg-red-50">Remover</button>
        </div>
      ))}
      {rows.length === 0 && <p className="text-xs text-slate-500">Sem pedidos de reembolso.</p>}
    </div>
  </div>
);

export default OccurrenceDetailModal;
