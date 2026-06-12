import { RULE_VERSIONS, SimulationResult, currentDateIso, roundMoney, safeNumber } from './common';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SSActivityLine = {
  id: string;
  type: 'services' | 'sales';
  label?: string;
  annualAmount: number;
};

export type SSIndependentInput = {
  activities: SSActivityLine[];
  isFirstYear: boolean;
  adjustmentPercent: number; // -25 a +25 (ajuste voluntário)
  // legacy fields kept for backwards compat with saved simulations
  activityType?: 'services' | 'sales' | 'mixed';
  annualGrossIncome?: number;
  annualSalesIncome?: number;
};

// ── Constants ─────────────────────────────────────────────────────────────────

// IAS por ano — actualizar quando publicado em Diário da República
const IAS_TABLE: Record<number, number> = { 2023: 480.43, 2024: 509.26, 2025: 522.50, 2026: 522.50 };
const IAS = IAS_TABLE[new Date().getFullYear()] ?? 522.50;
const SS_RATE = 0.214;        // 21,4% art.º 168.º CRCSPSS
const RATE_SERVICES = 0.70;   // 70% para prestação de serviços
const RATE_SALES    = 0.20;   // 20% para venda de produtos
const MIN_BASE = IAS;         // mínimo = 1 × IAS
const MAX_BASE = 12 * IAS;    // máximo = 12 × IAS

const SOURCE = RULE_VERSIONS['ss-independent'].sources[0];

// Escala IAS: passos de 0,5 × IAS de 1 até 12
const IAS_SCALE = Array.from({ length: 23 }, (_, i) => roundMoney((i + 2) * 0.5 * IAS));
// [522.50, 783.75, 1045.00, 1307.50, 1570.00, 1832.50, 2095.00, ... 6270.00]

// ── Helpers ───────────────────────────────────────────────────────────────────

function bracketBelow(base: number): number {
  const candidates = IAS_SCALE.filter((b) => b <= base);
  return candidates.length ? candidates[candidates.length - 1] : IAS_SCALE[0];
}

function bracketAbove(base: number): number {
  const candidates = IAS_SCALE.filter((b) => b > base);
  return candidates.length ? candidates[0] : IAS_SCALE[IAS_SCALE.length - 1];
}

function iasMultiple(base: number): string {
  return (base / IAS).toFixed(2) + ' × IAS';
}

/** Converte input no formato antigo (pre-multi-actividade) */
function normalizeLegacy(input: SSIndependentInput): SSActivityLine[] {
  if (input.activities?.length) return input.activities;
  const legacy = input as any;
  const type = legacy.activityType ?? 'services';
  if (!['services', 'sales', 'mixed'].includes(type)) {
    console.warn(`[SS-Independent] activityType desconhecido "${type}", a usar "services"`);
  }
  const gross = Math.max(0, safeNumber(legacy.annualGrossIncome));
  const sales = Math.max(0, safeNumber(legacy.annualSalesIncome));
  if (type === 'mixed') {
    return [
      { id: 'leg_srv', type: 'services', label: 'Prestação de serviços', annualAmount: gross },
      { id: 'leg_sal', type: 'sales',    label: 'Venda de produtos',       annualAmount: sales },
    ];
  }
  return [
    { id: 'leg_1', type: type === 'sales' ? 'sales' : 'services', annualAmount: gross },
  ];
}

function nextQuarterPaymentDates(): { label: string; dueDate: string }[] {
  const now = new Date();
  const year = now.getFullYear();
  const quarters = [
    { label: 'Q1 (Jan–Mar)', month: 3,  day: 20 },
    { label: 'Q2 (Abr–Jun)', month: 6,  day: 20 },
    { label: 'Q3 (Jul–Set)', month: 9,  day: 20 },
    { label: 'Q4 (Out–Dez)', month: 12, day: 20, nextYear: true },
  ];
  return quarters.map((q) => {
    const y = (q as any).nextYear ? year + 1 : year;
    const d = new Date(y, q.month - 1, q.day);
    return { label: q.label, dueDate: d.toLocaleDateString('pt-PT') };
  });
}

// ── Calculator ────────────────────────────────────────────────────────────────

export function calculateSSIndependent(input: SSIndependentInput): SimulationResult {
  const activities = normalizeLegacy(input);

  const totalServices = activities
    .filter((a) => a.type === 'services')
    .reduce((s, a) => s + Math.max(0, safeNumber(a.annualAmount)), 0);
  const totalSales = activities
    .filter((a) => a.type === 'sales')
    .reduce((s, a) => s + Math.max(0, safeNumber(a.annualAmount)), 0);

  const relevantAnnual   = roundMoney(totalServices * RATE_SERVICES + totalSales * RATE_SALES);
  const naturalMonthlyBase = roundMoney(relevantAnnual / 12);

  const adjustFactor   = 1 + Math.max(-0.25, Math.min(0.25, safeNumber(input.adjustmentPercent) / 100));
  const adjustedBase   = roundMoney(naturalMonthlyBase * adjustFactor);

  // Base efetiva (mínimo IAS, máximo 12×IAS; isento no 1.º ano)
  const effectiveBase = input.isFirstYear
    ? 0
    : roundMoney(Math.max(MIN_BASE, Math.min(MAX_BASE, adjustedBase)));

  const monthlyContrib   = roundMoney(effectiveBase * SS_RATE);
  const quarterlyContrib = roundMoney(monthlyContrib * 3);
  const annualContrib    = roundMoney(monthlyContrib * 12);

  // ── Análise de escalão IAS ────────────────────────────────────────────────
  const lower = bracketBelow(effectiveBase);
  const upper = bracketAbove(effectiveBase);
  const isExactBracket = effectiveBase === lower;
  const pctToLower = effectiveBase > 0
    ? roundMoney(((effectiveBase - lower) / naturalMonthlyBase) * 100)
    : 0;
  const canGoLower = !isExactBracket && lower >= MIN_BASE && pctToLower <= 25;

  const lowerMonthly = roundMoney(lower * SS_RATE);
  const savingsMonthly = roundMoney(monthlyContrib - lowerMonthly);
  const savingsAnnual = roundMoney(savingsMonthly * 12);

  const paymentDates = nextQuarterPaymentDates();

  // ── Linhas de detalhe ─────────────────────────────────────────────────────
  const activityLines = activities.map((a) => {
    const relevant = roundMoney(safeNumber(a.annualAmount) * (a.type === 'sales' ? RATE_SALES : RATE_SERVICES));
    return {
      label: a.label || (a.type === 'services' ? 'Serviços' : 'Vendas'),
      type: a.type,
      gross: safeNumber(a.annualAmount),
      relevant,
    };
  });

  return {
    simulatorId: 'ss-independent',
    title: 'SS Trimestral — Independentes',
    version: RULE_VERSIONS['ss-independent'],
    summary: [
      { label: 'Contribuição trimestral', value: quarterlyContrib, tone: 'positive' },
      { label: 'Contribuição mensal',     value: monthlyContrib,   tone: 'neutral' },
      { label: 'Contribuição anual',      value: annualContrib,    tone: 'neutral' },
      { label: 'Base incidência mensal',  value: effectiveBase,    tone: 'neutral' },
    ],
    details: [
      ...activityLines.map((l) => ({ label: `  ${l.label} (bruto anual)`, value: l.gross })),
      ...activityLines.map((l) => ({ label: `  Rendimento relevante ${l.label} (${l.type === 'sales' ? '20' : '70'}%)`, value: l.relevant })),
      { label: 'Rendimento relevante total (anual)', value: relevantAnnual },
      { label: 'Base natural mensal (÷ 12)', value: naturalMonthlyBase },
      { label: `Base após ajuste voluntário (${input.adjustmentPercent > 0 ? '+' : ''}${input.adjustmentPercent}%)`, value: adjustedBase },
      { label: 'Mínimo legal (1 × IAS)', value: MIN_BASE },
      { label: 'Base de incidência efetiva', value: effectiveBase },
      { label: `Base em escala IAS`, value: `${iasMultiple(effectiveBase)}` as unknown as number },
      ...(canGoLower ? [
        { label: `↓ Escalão inferior (${iasMultiple(lower)})`, value: lower },
        { label: '  Poupança mensal no escalão inferior', value: savingsMonthly },
        { label: '  Poupança anual no escalão inferior', value: savingsAnnual },
        { label: `  Ajuste necessário (−${pctToLower.toFixed(1)}%)`, value: `−${pctToLower.toFixed(1)}%` as unknown as number },
      ] : []),
      { label: 'Taxa SS independentes', value: `${(SS_RATE * 100).toFixed(1)}%` as unknown as number },
      { label: 'Contribuição mensal', value: monthlyContrib },
      { label: 'Contribuição trimestral (×3)', value: quarterlyContrib },
      { label: 'Contribuição anual (×12)', value: annualContrib },
      ...paymentDates.map((d) => ({ label: `Vencimento ${d.label}`, value: d.dueDate as unknown as number })),
    ],
    basis: [
      {
        label: 'Taxa SS independentes',
        value: '21,4% sobre a base de incidência (art.º 168.º CRCSPSS)',
        sourceLabel: SOURCE.label, sourceUrl: SOURCE.url, confidence: 'requires_validation',
      },
      {
        label: 'Base relevante serviços',
        value: '70% do rendimento bruto de prestação de serviços',
        sourceLabel: SOURCE.label, sourceUrl: SOURCE.url, confidence: 'requires_validation',
      },
      {
        label: 'Base relevante vendas',
        value: '20% do rendimento bruto de venda de produtos',
        sourceLabel: SOURCE.label, sourceUrl: SOURCE.url, confidence: 'requires_validation',
      },
      {
        label: 'Mínimo de contribuição',
        value: `1 × IAS = ${IAS.toFixed(2)} €`,
        sourceLabel: SOURCE.label, sourceUrl: SOURCE.url, confidence: 'requires_validation',
      },
      {
        label: 'Ajuste voluntário',
        value: '±25% sobre a base natural (art.º 168.º CRCSPSS)',
        sourceLabel: SOURCE.label, sourceUrl: SOURCE.url, confidence: 'requires_validation',
      },
    ],
    assumptions: [
      `${activities.length} fonte(s) de rendimento`,
      input.isFirstYear ? 'Primeiro ano de atividade: isento de contribuições.' : 'Atividade já iniciada.',
      'Pagamento trimestral até ao dia 20 do mês seguinte ao fim do trimestre.',
      `IAS utilizado: ${IAS.toFixed(2)} € (confirmar valor para 2026).`,
    ],
    warnings: [
      ...(RULE_VERSIONS['ss-independent'].notes || []),
      ...(canGoLower ? [`Pode reduzir a base ao escalão ${iasMultiple(lower)} (−${pctToLower.toFixed(1)}%), poupando ${savingsAnnual.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €/ano. Comunique à SS até 30 de abril.`] : []),
    ],
    computedAt: currentDateIso(),
  };
}

export function defaultSSActivities(): SSActivityLine[] {
  return [{ id: `act_${Date.now()}`, type: 'services', label: '', annualAmount: 24000 }];
}
