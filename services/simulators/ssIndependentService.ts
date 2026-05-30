import { RULE_VERSIONS, SimulationResult, currentDateIso, roundMoney, safeNumber } from './common';

export type SSIndependentInput = {
  activityType: 'services' | 'sales' | 'mixed';
  annualGrossIncome: number;
  annualSalesIncome: number; // só usado quando activityType === 'mixed'
  isFirstYear: boolean;
  adjustmentPercent: number; // -25% a +25% ajuste voluntário da base
};

const IAS = 522.50; // Indexante dos Apoios Sociais 2025 (validar para 2026)
const SS_RATE = 0.214; // 21,4% taxa geral independentes
const RELEVANT_RATE_SERVICES = 0.70;
const RELEVANT_RATE_SALES = 0.20;
const MIN_MONTHLY_BASE = IAS;
const MAX_MONTHLY_BASE = 12 * IAS;

const SOURCE = RULE_VERSIONS['ss-independent'].sources[0];

function nextQuarterPaymentDates(): { label: string; dueDate: string }[] {
  const now = new Date();
  const year = now.getFullYear();
  const quarters = [
    { label: 'Q1 (Jan–Mar)', month: 3, day: 20 },
    { label: 'Q2 (Abr–Jun)', month: 6, day: 20 },
    { label: 'Q3 (Jul–Set)', month: 9, day: 20 },
    { label: 'Q4 (Out–Dez)', month: 0, day: 20, nextYear: true },
  ];
  return quarters.map((q) => {
    const y = q.nextYear ? year + 1 : year;
    const date = new Date(y, q.month, q.day);
    return {
      label: q.label,
      dueDate: date.toLocaleDateString('pt-PT'),
    };
  });
}

export function calculateSSIndependent(input: SSIndependentInput): SimulationResult {
  const grossServices = input.activityType === 'sales'
    ? 0
    : input.activityType === 'mixed'
      ? Math.max(0, safeNumber(input.annualGrossIncome))
      : Math.max(0, safeNumber(input.annualGrossIncome));
  const grossSales = input.activityType === 'sales'
    ? Math.max(0, safeNumber(input.annualGrossIncome))
    : input.activityType === 'mixed'
      ? Math.max(0, safeNumber(input.annualSalesIncome))
      : 0;

  const relevantIncome = roundMoney(
    grossServices * RELEVANT_RATE_SERVICES + grossSales * RELEVANT_RATE_SALES
  );
  const calculatedMonthlyBase = roundMoney(relevantIncome / 12);

  // ajuste voluntário de -25% a +25%
  const adjustFactor = 1 + Math.max(-0.25, Math.min(0.25, safeNumber(input.adjustmentPercent) / 100));
  const adjustedBase = roundMoney(calculatedMonthlyBase * adjustFactor);

  // aplicar mínimo e máximo
  const effectiveMonthlyBase = input.isFirstYear
    ? 0
    : roundMoney(Math.max(MIN_MONTHLY_BASE, Math.min(MAX_MONTHLY_BASE, adjustedBase)));

  const monthlyContribution = roundMoney(effectiveMonthlyBase * SS_RATE);
  const quarterlyContribution = roundMoney(monthlyContribution * 3);
  const annualContribution = roundMoney(monthlyContribution * 12);

  const paymentDates = nextQuarterPaymentDates();

  return {
    simulatorId: 'ss-independent',
    title: 'SS Trimestral — Independentes',
    version: RULE_VERSIONS['ss-independent'],
    summary: [
      { label: 'Contribuição trimestral', value: quarterlyContribution, tone: 'positive' },
      { label: 'Contribuição mensal', value: monthlyContribution, tone: 'neutral' },
      { label: 'Contribuição anual', value: annualContribution, tone: 'neutral' },
      { label: 'Base de incidência mensal', value: effectiveMonthlyBase, tone: 'neutral' },
    ],
    details: [
      { label: 'Rendimento bruto serviços', value: grossServices },
      { label: 'Rendimento bruto vendas', value: grossSales },
      { label: 'Rendimento relevante anual (70%/20%)', value: relevantIncome },
      { label: 'Base calculada mensalmente', value: calculatedMonthlyBase },
      { label: 'Base após ajuste voluntário', value: adjustedBase },
      { label: 'Mínimo legal (1 × IAS)', value: MIN_MONTHLY_BASE },
      { label: 'Base de incidência efetiva', value: effectiveMonthlyBase },
      { label: 'Taxa SS independentes', value: SS_RATE * 100 },
      { label: 'Contribuição mensal', value: monthlyContribution },
      { label: 'Contribuição trimestral (×3)', value: quarterlyContribution },
      { label: 'Contribuição anual (×12)', value: annualContribution },
      ...paymentDates.map((d) => ({ label: `Vencimento ${d.label}`, value: d.dueDate as unknown as number })),
    ],
    basis: [
      {
        label: 'Taxa SS independentes',
        value: '21,4% sobre a base de incidência (art.º 168.º CRCSPSS)',
        sourceLabel: SOURCE.label,
        sourceUrl: SOURCE.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Base relevante serviços',
        value: '70% do rendimento bruto de prestação de serviços',
        sourceLabel: SOURCE.label,
        sourceUrl: SOURCE.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Base relevante vendas',
        value: '20% do rendimento bruto de venda de produtos',
        sourceLabel: SOURCE.label,
        sourceUrl: SOURCE.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Mínimo de contribuição',
        value: `Base mínima = 1 × IAS (${IAS.toFixed(2)} €)`,
        sourceLabel: SOURCE.label,
        sourceUrl: SOURCE.url,
        confidence: 'requires_validation',
      },
    ],
    assumptions: [
      `Atividade: ${input.activityType === 'services' ? 'Prestação de serviços' : input.activityType === 'sales' ? 'Venda de produtos' : 'Mista'}`,
      input.isFirstYear ? 'Primeiro ano de atividade: isento de contribuições.' : 'Atividade já iniciada.',
      'Pagamento trimestral até ao dia 20 do mês seguinte ao fim do trimestre.',
      'IAS 2025 utilizado (confirmar atualização para 2026).',
    ],
    warnings: RULE_VERSIONS['ss-independent'].notes,
    computedAt: currentDateIso(),
  };
}
