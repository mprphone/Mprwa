import { RULE_VERSIONS, SimulationResult, currentDateIso, roundMoney, safeNumber } from './common';

// ── Types ─────────────────────────────────────────────────────────────────────

export type VehicleType = 'ice' | 'hybrid' | 'electric';
export type AcquisitionMode = 'purchase' | 'lease';

export type CarBenefitInput = {
  vehicleType: VehicleType;
  vehicleName: string;
  acquisitionMode: AcquisitionMode;
  acquisitionValue: number;      // valor de aquisição com IVA (se compra)
  monthlyLeaseCost: number;      // custo mensal locação (se renting/ALD)
  employeeContribution: number;  // renda mensal paga pelo trabalhador
  monthsAssigned: number;        // meses de atribuição no ano fiscal
  continuousAssignment: boolean; // atribuição com carácter de continuidade (SS)
  irsRetentionRate: number;      // taxa retenção IRS do trabalhador (%)
  socialSecurityRate: number;    // taxa SS trabalhador (%) — normalmente 11%
  employerSSRate: number;        // taxa SS entidade patronal (%) — normalmente 23.75%
};

// ── Regras fiscais Portugal 2025 (CIRS art.º 2.º, n.º 3, b)) ─────────────────

// Taxa mensal de imputação sobre o valor de aquisição (veículo próprio)
const MONTHLY_RATE_ICE      = 0.0075;  // 0,75% — viaturas combustão (CIRS)
const MONTHLY_RATE_HYBRID   = 0.0075 * 0.50; // 50% redução — híbridos plug-in
// Elétrico: isento até €62.500; acima disso, 0,75% × 50% sobre o excedente
const EV_EXEMPTION_LIMIT    = 62500;
const MONTHLY_RATE_EV_ABOVE = 0.0075 * 0.50;

// Taxa de imputação para locação/renting (sobre custo mensal)
const LEASE_BENEFIT_RATE    = 0.25;    // 25% do custo mensal de locação

const SS_EMPLOYEE  = 0.11;
const SS_EMPLOYER  = 0.2375;

const SOURCE1 = RULE_VERSIONS['car-benefit'].sources[0];
const SOURCE2 = RULE_VERSIONS['car-benefit'].sources[1];

// ── Helpers ───────────────────────────────────────────────────────────────────

function vehicleLabel(t: VehicleType): string {
  if (t === 'hybrid') return 'Híbrido plug-in';
  if (t === 'electric') return 'Elétrico';
  return 'Combustão';
}

function monthlyBenefitGross(input: CarBenefitInput): { amount: number; ruleLabel: string } {
  const { vehicleType, acquisitionMode, acquisitionValue, monthlyLeaseCost } = input;
  const acqV = Math.max(0, safeNumber(acquisitionValue));
  const leaseMo = Math.max(0, safeNumber(monthlyLeaseCost));

  if (acquisitionMode === 'lease') {
    const amount = roundMoney(leaseMo * LEASE_BENEFIT_RATE);
    return { amount, ruleLabel: `25% × ${leaseMo.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €/mês (locação)` };
  }

  // Compra — validar valor
  if (acqV <= 0) {
    return { amount: 0, ruleLabel: 'Valor de aquisição não definido (≤ 0 €)' };
  }

  if (vehicleType === 'electric') {
    if (acqV <= EV_EXEMPTION_LIMIT) {
      return { amount: 0, ruleLabel: `Isento — viatura elétrica ≤ ${EV_EXEMPTION_LIMIT.toLocaleString('pt-PT')} €` };
    }
    const taxableBase = acqV - EV_EXEMPTION_LIMIT;
    const amount = roundMoney(taxableBase * MONTHLY_RATE_EV_ABOVE);
    return { amount, ruleLabel: `0,375% × (${acqV.toLocaleString('pt-PT', { minimumFractionDigits: 0 })} − ${EV_EXEMPTION_LIMIT.toLocaleString('pt-PT')}) € — elétrico acima do limite` };
  }

  if (vehicleType === 'hybrid') {
    const amount = roundMoney(acqV * MONTHLY_RATE_HYBRID);
    return { amount, ruleLabel: `0,375% × ${acqV.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} € — híbrido (50% redução)` };
  }

  // ICE
  const amount = roundMoney(acqV * MONTHLY_RATE_ICE);
  return { amount, ruleLabel: `0,75% × ${acqV.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} € — CIRS art.º 2.º` };
}

// ── Calculator ────────────────────────────────────────────────────────────────

export function calculateCarBenefit(input: CarBenefitInput): SimulationResult {
  const months       = Math.min(12, Math.max(1, Math.round(safeNumber(input.monthsAssigned))));
  const empContrib   = Math.max(0, safeNumber(input.employeeContribution));
  const irsRate      = Math.max(0, Math.min(1, safeNumber(input.irsRetentionRate) / 100));
  const ssEmpRate    = safeNumber(input.socialSecurityRate, 11) / 100;
  const ssPatRate    = safeNumber(input.employerSSRate, 23.75) / 100;
  const continuous   = input.continuousAssignment !== false;

  const { amount: grossBenefit, ruleLabel } = monthlyBenefitGross(input);

  // Benefício tributável = máximo(0, benefício bruto − contribuição trabalhador)
  const taxableBenefit = roundMoney(Math.max(0, grossBenefit - empContrib));

  // SS (apenas se atribuição com carácter de continuidade)
  const ssEmployee  = continuous ? roundMoney(taxableBenefit * ssEmpRate) : 0;
  const ssEmployer  = continuous ? roundMoney(taxableBenefit * ssPatRate) : 0;

  // Retenção IRS adicional mensal (estimativa)
  const irsWithholding = roundMoney(taxableBenefit * irsRate);

  // Custo líquido mensal para o trabalhador (o que perde efetivamente do salário líquido)
  const netCostEmployee = roundMoney(ssEmployee + irsWithholding);

  // Anuais (× meses de atribuição)
  const annualTaxableBenefit = roundMoney(taxableBenefit * months);
  const annualSSEmployee     = roundMoney(ssEmployee * months);
  const annualSSEmployer     = roundMoney(ssEmployer * months);
  const annualIRS            = roundMoney(irsWithholding * months);
  const annualNetCost        = roundMoney(netCostEmployee * months);

  const typeLabel   = vehicleLabel(input.vehicleType);
  const acqLabel    = input.acquisitionMode === 'lease' ? 'Renting/ALD' : 'Compra própria';
  const vehicleName = input.vehicleName?.trim() || 'Viatura empresa';

  return {
    simulatorId: 'car-benefit',
    title: `Viatura Empresa — ${vehicleName}`,
    version: RULE_VERSIONS['car-benefit'],
    summary: [
      { label: 'Imputação mensal',         value: taxableBenefit,   tone: 'neutral'  },
      { label: 'SS trabalhador mensal',     value: ssEmployee,       tone: 'neutral'  },
      { label: 'Retenção IRS adicional',    value: irsWithholding,   tone: 'neutral'  },
      { label: 'Custo líquido/mês trabalhador', value: netCostEmployee, tone: 'negative' },
    ],
    details: [
      { label: 'Veículo',                         value: `${vehicleName} (${typeLabel}, ${acqLabel})` as unknown as number },
      { label: 'Valor de aquisição c/ IVA',        value: input.acquisitionMode === 'purchase' ? safeNumber(input.acquisitionValue) : 0 },
      { label: 'Custo mensal locação',             value: input.acquisitionMode === 'lease' ? safeNumber(input.monthlyLeaseCost) : 0 },
      { label: 'Benefício bruto mensal',           value: grossBenefit },
      { label: 'Contribuição mensal trabalhador',  value: empContrib },
      { label: 'Benefício tributável mensal',      value: taxableBenefit },
      { label: 'SS trabalhador (mensal)',           value: ssEmployee },
      { label: 'Retenção IRS adicional (mensal)',  value: irsWithholding },
      { label: 'Custo líquido mensal trabalhador', value: netCostEmployee },
      { label: '─── Anual (' + months + ' meses) ───', value: '' as unknown as number },
      { label: 'Benefício tributável anual',       value: annualTaxableBenefit },
      { label: 'SS trabalhador anual',             value: annualSSEmployee },
      { label: 'SS entidade patronal anual',       value: annualSSEmployer },
      { label: 'Retenção IRS anual',               value: annualIRS },
      { label: 'Custo líquido anual trabalhador',  value: annualNetCost },
    ],
    basis: [
      {
        label: 'Taxa de imputação',
        value: ruleLabel,
        sourceLabel: SOURCE1.label, sourceUrl: SOURCE1.url,
        confidence: 'requires_validation',
      },
      {
        label: input.acquisitionMode === 'lease' ? 'Base locação' : 'Base aquisição',
        value: input.acquisitionMode === 'lease'
          ? '25% do custo mensal de locação (CIRS art.º 2.º, n.º 3, b))'
          : '0,75%/mês sobre valor de aquisição c/ IVA (CIRS art.º 2.º, n.º 3, b))',
        sourceLabel: SOURCE1.label, sourceUrl: SOURCE1.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Viaturas elétricas',
        value: `Isenção até ${EV_EXEMPTION_LIMIT.toLocaleString('pt-PT')} € de valor de aquisição; acima aplicam-se 0,375%/mês sobre o excedente`,
        sourceLabel: SOURCE1.label, sourceUrl: SOURCE1.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Viaturas híbridas plug-in',
        value: '50% de redução sobre a taxa geral (0,375%/mês)',
        sourceLabel: SOURCE2.label, sourceUrl: SOURCE2.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Segurança Social',
        value: continuous
          ? `Sujeito a SS (atribuição contínua): ${(ssEmpRate * 100).toFixed(2)}% trabalhador + ${(ssPatRate * 100).toFixed(2)}% entidade`
          : 'Não sujeito a SS (atribuição não contínua)',
        sourceLabel: SOURCE1.label, sourceUrl: SOURCE1.url,
        confidence: 'requires_validation',
      },
    ],
    assumptions: [
      `Veículo: ${vehicleName} — ${typeLabel} — ${acqLabel}`,
      `Imputação mensal bruta calculada com base nas regras do CIRS 2025`,
      `Taxa de retenção IRS aplicada: ${(irsRate * 100).toFixed(1)}%`,
      `Meses de atribuição considerados: ${months}`,
      continuous ? 'Atribuição com carácter de continuidade — sujeito a SS' : 'Atribuição ocasional — não sujeito a SS',
    ],
    warnings: RULE_VERSIONS['car-benefit'].notes,
    computedAt: currentDateIso(),
  };
}

export const defaultCarBenefitInput: CarBenefitInput = {
  vehicleType: 'ice',
  vehicleName: '',
  acquisitionMode: 'purchase',
  acquisitionValue: 35000,
  monthlyLeaseCost: 500,
  employeeContribution: 0,
  monthsAssigned: 12,
  continuousAssignment: true,
  irsRetentionRate: 25,
  socialSecurityRate: 11,
  employerSSRate: 23.75,
};
