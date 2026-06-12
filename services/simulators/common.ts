export type SimulatorStatus = 'updated' | 'requires_validation' | 'outdated';

export type SimulatorId =
  | 'salary-net'
  | 'employee-cost'
  | 'imt'
  | 'act-compensation'
  | 'ss-independent'
  | 'loan'
  | 'car-benefit';

export type RuleSource = {
  label: string;
  url: string;
};

export type RuleVersion = {
  id: string;
  label: string;
  validFrom: string;
  lastReviewedAt: string;
  status: SimulatorStatus;
  sources: RuleSource[];
  notes: string[];
};

export type MoneyLine = {
  label: string;
  value: number;
  tone?: 'positive' | 'negative' | 'neutral';
};

export type CalculationBasis = {
  label: string;
  value: string;
  sourceLabel: string;
  sourceUrl: string;
  confidence: SimulatorStatus;
};

export type SimulationResult = {
  simulatorId: SimulatorId;
  title: string;
  version: RuleVersion;
  summary: MoneyLine[];
  details: MoneyLine[];
  basis: CalculationBasis[];
  assumptions: string[];
  warnings: string[];
  computedAt: string;
};

export const RULE_VERSIONS: Record<SimulatorId, RuleVersion> = {
  'salary-net': {
    id: 'pt-salary-2026.1-indicative',
    label: 'Portugal 2026 - trabalho dependente',
    validFrom: '2026-01-01',
    lastReviewedAt: '2026-05-21',
    status: 'requires_validation',
    sources: [
      {
        label: 'Portal das Finanças - Tabelas de retenção IRS 2026',
        url: 'https://info.portaldasfinancas.gov.pt/pt/destaques/Paginas/Despacho-SEAF-2026-01-05-novas-tabela-RF-IRS-2026.aspx',
      },
      {
        label: 'Segurança Social - taxas contributivas',
        url: 'https://www.seg-social.pt',
      },
      {
        label: 'OCC',
        url: 'https://www.occ.pt',
      },
    ],
    notes: [
      'A retenção de IRS usa uma aproximação parametrizada e deve ser validada contra a tabela oficial aplicável ao agregado.',
      'Taxa geral de Segurança Social considerada: 11% trabalhador e 23,75% entidade empregadora.',
    ],
  },
  'employee-cost': {
    id: 'pt-employee-cost-2026.1',
    label: 'Portugal 2026 - custo colaborador',
    validFrom: '2026-01-01',
    lastReviewedAt: '2026-05-21',
    status: 'requires_validation',
    sources: [
      {
        label: 'Segurança Social',
        url: 'https://www.seg-social.pt',
      },
      {
        label: 'Portal das Finanças',
        url: 'https://info.portaldasfinancas.gov.pt',
      },
    ],
    notes: [
      'Custo patronal calculado com taxa geral de 23,75%. Regimes especiais devem ser configurados em versões futuras.',
    ],
  },
  imt: {
    id: 'pt-imt-2026.1',
    label: 'Portugal 2026 - IMT e imposto do selo',
    validFrom: '2026-01-01',
    lastReviewedAt: '2026-05-21',
    status: 'updated',
    sources: [
      {
        label: 'Código do IMT - artigo 17',
        url: 'https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/codigos_tributarios/cimt/Pages/cimt17.aspx',
      },
      {
        label: 'Portal das Finanças - compra da casa',
        url: 'https://info.portaldasfinancas.gov.pt/pt/apoio_ao_contribuinte/Cidadaos/Casa_e_propriedades/Compra_da_casa/Paginas/default.aspx',
      },
    ],
    notes: [
      'Escalões HPP 2026 conforme artigo 17 do CIMT. Imposto do selo considerado a 0,8%.',
      'A isenção jovem e condições específicas carecem de validação formal.',
    ],
  },
  'ss-independent': {
    id: 'pt-ss-independent-2025.1',
    label: 'Portugal 2025 — SS Independentes',
    validFrom: '2025-01-01',
    lastReviewedAt: '2026-05-22',
    status: 'requires_validation',
    sources: [
      {
        label: 'Segurança Social — regime independentes',
        url: 'https://www.seg-social.pt/trabalhadores-independentes',
      },
    ],
    notes: [
      'Cálculo indicativo baseado no regime geral de independentes (art.º 168.º CRCSPSS). Confirmar IAS aplicável e eventuais regimes especiais antes de comunicar ao cliente.',
    ],
  },
  loan: {
    id: 'loan-2026.1',
    label: 'Simulador de empréstimos',
    validFrom: '2026-01-01',
    lastReviewedAt: '2026-05-31',
    status: 'updated',
    sources: [
      { label: 'Método francês de amortização (prestações constantes)', url: 'https://www.bportugal.pt/page/credito-habitacao' },
    ],
    notes: ['Cálculo baseado no método francês (prestação constante). Confirmar com banco condições exactas de spread, comissões e seguros.'],
  },
  'car-benefit': {
    id: 'pt-car-benefit-2025.1',
    label: 'Portugal 2025 — Viatura da empresa',
    validFrom: '2025-01-01',
    lastReviewedAt: '2026-05-31',
    status: 'requires_validation',
    sources: [
      { label: 'CIRS art.º 2.º n.º 3 b) — Rendimentos em espécie', url: 'https://info.portaldasfinancas.gov.pt/pt/informacao_fiscal/codigos_tributarios/cirs_rep/Pages/irs-artigo-2.aspx' },
      { label: 'Portaria n.º 467/2010 — Limites dedução viatura', url: 'https://dre.pt/application/conteudo/281916' },
    ],
    notes: [
      'Cálculo indicativo com base no art.º 2.º do CIRS. Confirmar com contabilista as isenções aplicáveis a viaturas elétricas e híbridas para o ano fiscal corrente.',
    ],
  },
  'act-compensation': {
    id: 'pt-act-2026.1-indicative',
    label: 'Portugal 2026 - compensações laborais',
    validFrom: '2026-01-01',
    lastReviewedAt: '2026-05-21',
    status: 'requires_validation',
    sources: [
      {
        label: 'ACT - simuladores',
        url: 'https://portal.act.gov.pt/Pages/simuladores-todos.aspx',
      },
    ],
    notes: [
      'Modelo indicativo para triagem interna. Deve ser confirmado no simulador ACT ou por técnico laboral antes de comunicar ao cliente.',
    ],
  },
};

export const currentDateIso = () => new Date().toISOString();

export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function safeNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function getRuleHealth(version: RuleVersion): { label: string; status: SimulatorStatus; description: string } {
  const reviewed = new Date(version.lastReviewedAt);
  const daysSinceReview = Number.isFinite(reviewed.getTime())
    ? Math.floor((Date.now() - reviewed.getTime()) / 86400000)
    : 9999;
  if (version.status === 'updated' && daysSinceReview <= 120) {
    return { label: 'Atualizado', status: 'updated', description: `Validado em ${version.lastReviewedAt}.` };
  }
  if (daysSinceReview > 365) {
    return { label: 'Desatualizado', status: 'outdated', description: 'A ultima validação tem mais de 12 meses.' };
  }
  return { label: 'Requer validação', status: 'requires_validation', description: 'Existem pressupostos que devem ser confirmados antes de uso definitivo.' };
}
