import { RULE_VERSIONS, SimulationResult, currentDateIso, roundMoney, safeNumber } from './common';

export type ImtInput = {
  price: number;
  propertyType: 'hpp' | 'secondary' | 'rustic';
  buyerAge: number;
  includeEstimatedFees: boolean;
};

const STAMP_DUTY_RATE = 0.008;
const PORTAL_FINANCAS_IMT_SOURCE = RULE_VERSIONS.imt.sources[0];
const PORTAL_FINANCAS_HOUSE_SOURCE = RULE_VERSIONS.imt.sources[1];

const IMT_HPP_BRACKETS = [
  { min: 0, max: 106346, rate: 0, deduction: 0 },
  { min: 106346, max: 145470, rate: 0.02, deduction: 2126.92 },
  { min: 145470, max: 198347, rate: 0.05, deduction: 6491.02 },
  { min: 198347, max: 330539, rate: 0.07, deduction: 10457.96 },
  { min: 330539, max: 660982, rate: 0.08, deduction: 13763.35 },
  { min: 660982, max: 1150853, rate: 0.06, deduction: 0 },
  { min: 1150853, max: Number.POSITIVE_INFINITY, rate: 0.075, deduction: 0 },
];

export function calculateImt(input: ImtInput): SimulationResult {
  const price = Math.max(0, safeNumber(input.price));
  const warnings: string[] = [];
  let imt = 0;

  if (input.propertyType === 'hpp') {
    const bracket = IMT_HPP_BRACKETS.find((item) => price > item.min && price <= item.max) || IMT_HPP_BRACKETS[0];
    imt = bracket.deduction > 0 ? price * bracket.rate - bracket.deduction : price * bracket.rate;
    if (input.buyerAge <= 35 && price <= 330539) {
      warnings.push('Comprador até 35 anos: pode existir isenção/redução jovem. Validar requisitos antes de concluir.');
    }
  } else if (input.propertyType === 'rustic') {
    imt = price * 0.05;
    warnings.push('Prédio rústico calculado com taxa única indicativa de 5%. Validar enquadramento.');
  } else {
    imt = price * 0.065;
    warnings.push('Habitação secundária calculada com taxa média indicativa de 6,5% nesta versão inicial.');
  }

  const stampDuty = roundMoney(price * STAMP_DUTY_RATE);
  const estimatedFees = input.includeEstimatedFees ? 1200 : 0;
  const total = roundMoney(Math.max(0, imt) + stampDuty + estimatedFees);

  return {
    simulatorId: 'imt',
    title: 'Simulador IMT',
    version: input.propertyType === 'hpp' ? RULE_VERSIONS.imt : { ...RULE_VERSIONS.imt, status: 'requires_validation' },
    summary: [
      { label: 'Total impostos e custos', value: total, tone: 'negative' },
      { label: 'IMT estimado', value: roundMoney(Math.max(0, imt)), tone: 'negative' },
      { label: 'Imposto do selo', value: stampDuty, tone: 'negative' },
      { label: 'Escritura e registos estimados', value: estimatedFees, tone: 'neutral' },
    ],
    details: [
      { label: 'Valor aquisição', value: price },
      { label: 'Base cálculo IMT', value: price },
      { label: 'Imposto do selo 0,8%', value: stampDuty },
      { label: 'Custos estimados opcionais', value: estimatedFees },
    ],
    basis: [
      {
        label: 'Escalões e taxas IMT',
        value: input.propertyType === 'hpp' ? 'Tabela HPP 2026 do artigo 17.º CIMT' : 'Taxa indicativa por tipo de imóvel',
        sourceLabel: PORTAL_FINANCAS_IMT_SOURCE.label,
        sourceUrl: PORTAL_FINANCAS_IMT_SOURCE.url,
        confidence: input.propertyType === 'hpp' ? 'updated' : 'requires_validation',
      },
      {
        label: 'Imposto do selo',
        value: '0,8% sobre o valor base',
        sourceLabel: PORTAL_FINANCAS_HOUSE_SOURCE.label,
        sourceUrl: PORTAL_FINANCAS_HOUSE_SOURCE.url,
        confidence: 'updated',
      },
      {
        label: 'Escritura e registos',
        value: input.includeEstimatedFees ? 'Estimativa operacional de 1 200 €' : 'Não incluído',
        sourceLabel: 'Configuração MPR Negócios',
        sourceUrl: 'https://www.mpr.pt',
        confidence: 'requires_validation',
      },
    ],
    assumptions: [
      `Tipo: ${input.propertyType}`,
      'Não substitui liquidação oficial da Autoridade Tributária.',
    ],
    warnings: [...RULE_VERSIONS.imt.notes, ...warnings],
    computedAt: currentDateIso(),
  };
}
