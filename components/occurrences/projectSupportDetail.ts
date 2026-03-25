export type ProjectSupportListItem = {
  designacao: string;
  valor: string;
  data: string;
};

export type ProjectSupportTrackedItem = {
  designacao: string;
  valor: string;
  data: string;
  realizado: string;
};

export type ProjectSupportEmployeeItem = {
  nome: string;
  dataContratacao: string;
  dataFim: string;
};

export type ProjectSupportRefundItem = {
  data: string;
  designacao: string;
  montante: string;
  estado: string;
};

export type ProjectSupportDetail = {
  candidatura: {
    fase: string;
    faturado: string;
    valorAcordado: string;
    avisoNumero: string;
    dataPrevistaInicio: string;
    dataPrevistaFim: string;
    investimento: ProjectSupportListItem[];
    objetivosAviso: ProjectSupportListItem[];
    objetivosProjeto: ProjectSupportListItem[];
    observacoes: string;
  };
  acompanhamento: {
    projetoNumero: string;
    designacaoProjeto: string;
    entidadeGestora: string;
    nomeGestor: string;
    contactoGestor: string;
    dataSubmissao: string;
    dataInicio: string;
    dataEncerramento: string;
    investimentoAprovado: string;
    apoioAprovado: string;
    percentagemApoio: string;
    objetivosAviso: ProjectSupportTrackedItem[];
    objetivosProjeto: ProjectSupportTrackedItem[];
    investimento: ProjectSupportTrackedItem[];
    funcionariosApoiados: ProjectSupportEmployeeItem[];
    pedidosReembolso: ProjectSupportRefundItem[];
    observacoes: string;
  };
  encerramento: {
    licenca: string;
    provasCumprimento: string;
    relatorio: string;
    notas: string;
  };
  dossieEletronico: {
    modelo: string;
    naoAplicavelPorItem: Record<string, boolean>;
    documentosNecessarios: string;
    notas: string;
  };
};

export type ProjectSectionKey = 'geral' | 'candidatura' | 'acompanhamento' | 'encerramento' | 'dossie_eletronico';

function toText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeSimpleList(value: unknown): ProjectSupportListItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        designacao: toText(row.designacao),
        valor: toText(row.valor),
        data: toText(row.data),
      };
    })
    .filter((item) => item.designacao || item.valor || item.data);
}

function normalizeTrackedList(value: unknown): ProjectSupportTrackedItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        designacao: toText(row.designacao),
        valor: toText(row.valor),
        data: toText(row.data),
        realizado: toText(row.realizado),
      };
    })
    .filter((item) => item.designacao || item.valor || item.data || item.realizado);
}

function normalizeEmployeesList(value: unknown): ProjectSupportEmployeeItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        nome: toText(row.nome),
        dataContratacao: toText(row.dataContratacao),
        dataFim: toText(row.dataFim),
      };
    })
    .filter((item) => item.nome || item.dataContratacao || item.dataFim);
}

function normalizeRefundList(value: unknown): ProjectSupportRefundItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
      return {
        data: toText(row.data),
        designacao: toText(row.designacao),
        montante: toText(row.montante),
        estado: toText(row.estado),
      };
    })
    .filter((item) => item.data || item.designacao || item.montante || item.estado);
}

function makeTrackedKey(item: { designacao?: string; valor?: string; data?: string }): string {
  return [toText(item.designacao).toLowerCase(), toText(item.valor).toLowerCase(), toText(item.data).toLowerCase()].join('||');
}

export function syncTrackedListFromBase(
  source: ProjectSupportListItem[],
  currentTracked: ProjectSupportTrackedItem[]
): ProjectSupportTrackedItem[] {
  const byKey = new Map<string, ProjectSupportTrackedItem>();
  for (const row of currentTracked || []) {
    byKey.set(makeTrackedKey(row), row);
  }

  // Acompanhamento espelha sempre a lista base da candidatura.
  // Mantemos apenas o campo "realizado" para as linhas que continuam a existir.
  const synced: ProjectSupportTrackedItem[] = [];
  for (const row of source || []) {
    const key = makeTrackedKey(row);
    const current = byKey.get(key);
    synced.push({
      designacao: toText(row.designacao),
      valor: toText(row.valor),
      data: toText(row.data),
      realizado: toText(current?.realizado),
    });
  }

  return synced;
}

export function createEmptyProjectSupportDetail(): ProjectSupportDetail {
  return {
    candidatura: {
      fase: 'Candidatura',
      faturado: 'NAO',
      valorAcordado: '',
      avisoNumero: '',
      dataPrevistaInicio: '',
      dataPrevistaFim: '',
      investimento: [],
      objetivosAviso: [],
      objetivosProjeto: [],
      observacoes: '',
    },
    acompanhamento: {
      projetoNumero: '',
      designacaoProjeto: '',
      entidadeGestora: '',
      nomeGestor: '',
      contactoGestor: '',
      dataSubmissao: '',
      dataInicio: '',
      dataEncerramento: '',
      investimentoAprovado: '',
      apoioAprovado: '',
      percentagemApoio: '',
      objetivosAviso: [],
      objetivosProjeto: [],
      investimento: [],
      funcionariosApoiados: [],
      pedidosReembolso: [],
      observacoes: '',
    },
    encerramento: {
      licenca: '',
      provasCumprimento: '',
      relatorio: '',
      notas: '',
    },
    dossieEletronico: {
      modelo: 'IAPMEI',
      naoAplicavelPorItem: {},
      documentosNecessarios: '',
      notas: '',
    },
  };
}

export function normalizeProjectSupportDetail(input: unknown): ProjectSupportDetail {
  const empty = createEmptyProjectSupportDetail();
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  const candidaturaRaw = (src.candidatura && typeof src.candidatura === 'object'
    ? src.candidatura
    : {}) as Record<string, unknown>;
  const acompanhamentoRaw = (src.acompanhamento && typeof src.acompanhamento === 'object'
    ? src.acompanhamento
    : {}) as Record<string, unknown>;
  const encerramentoRaw = (src.encerramento && typeof src.encerramento === 'object'
    ? src.encerramento
    : {}) as Record<string, unknown>;
  const dossieRaw = (src.dossieEletronico && typeof src.dossieEletronico === 'object'
    ? src.dossieEletronico
    : {}) as Record<string, unknown>;

  const candidaturaInvestimento = normalizeSimpleList(candidaturaRaw.investimento);
  const candidaturaObjetivosAviso = normalizeSimpleList(candidaturaRaw.objetivosAviso);
  const candidaturaObjetivosProjeto = normalizeSimpleList(candidaturaRaw.objetivosProjeto);

  if (candidaturaInvestimento.length === 0 && toText(candidaturaRaw.investimento)) {
    candidaturaInvestimento.push({ designacao: toText(candidaturaRaw.investimento), valor: '', data: '' });
  }
  if (candidaturaObjetivosAviso.length === 0 && toText(candidaturaRaw.objetivos)) {
    candidaturaObjetivosAviso.push({ designacao: toText(candidaturaRaw.objetivos), valor: '', data: '' });
  }

  const candidatura = {
    fase: toText(candidaturaRaw.fase) || empty.candidatura.fase,
    faturado: toText(candidaturaRaw.faturado).toUpperCase() || empty.candidatura.faturado,
    valorAcordado: toText(candidaturaRaw.valorAcordado),
    avisoNumero: toText(candidaturaRaw.avisoNumero),
    dataPrevistaInicio: toText(candidaturaRaw.dataPrevistaInicio),
    dataPrevistaFim: toText(candidaturaRaw.dataPrevistaFim),
    investimento: candidaturaInvestimento,
    objetivosAviso: candidaturaObjetivosAviso,
    objetivosProjeto: candidaturaObjetivosProjeto,
    observacoes: toText(candidaturaRaw.observacoes),
  };

  const acompanhamentoObjetivosAviso = syncTrackedListFromBase(
    candidatura.objetivosAviso,
    normalizeTrackedList(acompanhamentoRaw.objetivosAviso)
  );
  const acompanhamentoObjetivosProjeto = syncTrackedListFromBase(
    candidatura.objetivosProjeto,
    normalizeTrackedList(acompanhamentoRaw.objetivosProjeto)
  );
  const acompanhamentoInvestimento = syncTrackedListFromBase(
    candidatura.investimento,
    normalizeTrackedList(acompanhamentoRaw.investimento)
  );

  const acompanhamento = {
    projetoNumero: toText(acompanhamentoRaw.projetoNumero),
    designacaoProjeto: toText(acompanhamentoRaw.designacaoProjeto),
    entidadeGestora: toText(acompanhamentoRaw.entidadeGestora),
    nomeGestor: toText(acompanhamentoRaw.nomeGestor),
    contactoGestor: toText(acompanhamentoRaw.contactoGestor),
    dataSubmissao: toText(acompanhamentoRaw.dataSubmissao),
    dataInicio: toText(acompanhamentoRaw.dataInicio),
    dataEncerramento: toText(acompanhamentoRaw.dataEncerramento),
    investimentoAprovado: toText(acompanhamentoRaw.investimentoAprovado),
    apoioAprovado: toText(acompanhamentoRaw.apoioAprovado),
    percentagemApoio: toText(acompanhamentoRaw.percentagemApoio),
    objetivosAviso: acompanhamentoObjetivosAviso,
    objetivosProjeto: acompanhamentoObjetivosProjeto,
    investimento: acompanhamentoInvestimento,
    funcionariosApoiados: normalizeEmployeesList(acompanhamentoRaw.funcionariosApoiados),
    pedidosReembolso: normalizeRefundList(acompanhamentoRaw.pedidosReembolso),
    observacoes: toText(acompanhamentoRaw.observacoes) || toText(acompanhamentoRaw.comprovativos) || toText(acompanhamentoRaw.evidencias),
  };

  return {
    candidatura,
    acompanhamento,
    encerramento: {
      licenca: toText(encerramentoRaw.licenca),
      provasCumprimento: toText(encerramentoRaw.provasCumprimento),
      relatorio: toText(encerramentoRaw.relatorio),
      notas: toText(encerramentoRaw.notas),
    },
    dossieEletronico: {
      modelo: toText(dossieRaw.modelo) || 'IAPMEI',
      naoAplicavelPorItem:
        dossieRaw.naoAplicavelPorItem && typeof dossieRaw.naoAplicavelPorItem === 'object'
          ? Object.fromEntries(
              Object.entries(dossieRaw.naoAplicavelPorItem).map(([key, value]) => [
                String(key || '').trim(),
                Boolean(value),
              ])
            )
          : {},
      documentosNecessarios: toText(dossieRaw.documentosNecessarios),
      notas: toText(dossieRaw.notas),
    },
  };
}

export function isProjectSupportTypeName(typeName: string): boolean {
  const normalized = String(typeName || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return normalized.includes('projeto') || normalized.includes('medidas de apoio') || normalized.includes('medida de apoio');
}
