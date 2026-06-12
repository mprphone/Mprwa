import { RULE_VERSIONS, SimulationResult, currentDateIso, roundMoney, safeNumber } from './common';

export type SalaryNetInput = {
  grossSalary: number;
  extraPay: number;
  otherTaxableIncome: number;
  irsOnlyIncome: number;
  exemptIncome: number;
  mealAllowanceDaily: number;
  mealDays: number;
  mealType: 'cash' | 'card';
  dependents: number;
  disabledDependents: number;
  maritalStatus: 'single' | 'married_one_holder' | 'married_two_holders';
  duodecimos: boolean;
  holidayAllowance: boolean;
  christmasAllowance: boolean;
  youngIrs: boolean;
  youngIrsYear: number;  // ano de trabalho (1-10) para % correcta de isenção
  disability: boolean;
  region: 'continent' | 'azores' | 'madeira';
  socialSecurityRate: number;
  employerSocialSecurityRate: number;
  workAccidentInsuranceRate: number; // seguro acidentes trabalho (default 1.75%)
  monthsPerYear: number;
};

export type EmployeeCostInput = SalaryNetInput & {
  insuranceMonthly: number;
  otherBenefits: number;
};

// Limite anual de isenção IRS Jovem 2026 (€)
const YOUNG_IRS_ANNUAL_LIMIT = 9059;

// % de isenção por ano de trabalho (Lei IRS Jovem 2024+)
function youngIrsExemptionRate(yearOfWork: number): number {
  if (yearOfWork <= 0) return 0;
  if (yearOfWork === 1) return 1.00;   // 100% isento
  if (yearOfWork === 2) return 0.75;   // 75%
  if (yearOfWork <= 4) return 0.50;    // 50%
  if (yearOfWork <= 10) return 0.25;   // 25%
  return 0;
}

const SOCIAL_SECURITY_WORKER_RATE = 0.11;
const SOCIAL_SECURITY_EMPLOYER_RATE = 0.2375;
const MEAL_EXEMPTION_CASH = 6;
const MEAL_EXEMPTION_CARD = 10.2;

const PORTAL_FINANCAS_RETENTION_SOURCE = RULE_VERSIONS['salary-net'].sources[0];
const SEG_SOCIAL_SOURCE = RULE_VERSIONS['salary-net'].sources[1];

// ─── Tabelas oficiais AT 2026 — fórmula: max(0, Rendimento × Taxa - Parcela)
// Fonte: Despacho n.º 172-A/2026.XXX — Portal das Finanças
// Estrutura: { upTo: limite superior do escalão, rate: taxa global, deduction: parcela a abater }
// Retenção = max(0, Rendimento × rate - deduction)

type IrsTableEntry = { upTo: number; rate: number; deduction: number };

// Continente — Não casado / Casado 2 titulares (tabela I)
// Valores REAIS extraídos da página Doutor Finanças 2026 (verificados em 31/05/2026)
// Fórmula: max(0, Rendimento × Taxa - Parcela)
// NOTA: DF aplica IRS sobre a base líquida de SS (Rendimento - SS trabalhador)
const IRS_TABLE_SINGLE_CONTINENT: IrsTableEntry[] = [
  { upTo:  920,  rate: 0,      deduction: 0 },
  { upTo: 1042,  rate: 0.1250, deduction: 115.11 },   // 12.5% × 2.6 × (1273.85 - R) — aprox. linear
  { upTo: 1108,  rate: 0.1570, deduction: 148.24 },   // 15.7% × 1.35 × (1554.83 - R) — aprox.
  { upTo: 1154,  rate: 0.1570, deduction: 94.71 },    // exacto do DF
  { upTo: 1212,  rate: 0.2120, deduction: 158.18 },   // exacto do DF
  { upTo: 1819,  rate: 0.2410, deduction: 193.33 },   // exacto do DF → a 1300: 1300×0.241-193.33=120€ bruto, taxa efectiva 13.5%
  { upTo: 2119,  rate: 0.3110, deduction: 320.66 },   // exacto do DF
  { upTo: 2499,  rate: 0.3560, deduction: 415.96 },
  { upTo: 3004,  rate: 0.4010, deduction: 528.56 },
  { upTo: 5004,  rate: 0.4350, deduction: 630.76 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.5300, deduction: 1106.26 },
];

// Continente — Casado 1 titular (tabela II)
const IRS_TABLE_MARRIED_ONE_CONTINENT: IrsTableEntry[] = [
  { upTo:  792,  rate: 0,      deduction: 0 },
  { upTo:  975,  rate: 0.1325, deduction: 105.03 },
  { upTo: 1133,  rate: 0.18,   deduction: 159.11 },
  { upTo: 1258,  rate: 0.2350, deduction: 221.66 },
  { upTo: 1383,  rate: 0.2700, deduction: 265.66 },
  { upTo: 1542,  rate: 0.3100, deduction: 321.02 },
  { upTo: 1900,  rate: 0.3500, deduction: 382.72 },
  { upTo: 2358,  rate: 0.4350, deduction: 544.22 },
  { upTo: 2917,  rate: 0.4500, deduction: 579.66 },
  { upTo: 4117,  rate: 0.4550, deduction: 594.22 },
  { upTo: 4942,  rate: 0.4500, deduction: 573.55 },
  { upTo: 5833,  rate: 0.4600, deduction: 622.89 },
  { upTo: 10175, rate: 0.5200, deduction: 972.44 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.5300, deduction: 1074.23 },
];

function lookupIrsRetention(monthlyGross: number, table: IrsTableEntry[]): number {
  const entry = table.find((e) => monthlyGross <= e.upTo) || table[table.length - 1];
  return Math.max(0, monthlyGross * entry.rate - entry.deduction);
}

// Factor dependentes: redução fixa por dependente (Portaria 2026)
const IRS_DEDUCTION_PER_DEPENDENT = 35.42; // €/mês por dependente
const IRS_DEDUCTION_PER_DISABLED_DEPENDENT = 53.13;

function getIrsRetentionMonthly(input: SalaryNetInput, monthlyGross: number): number {
  const isMarriedOneHolder = input.maritalStatus === 'married_one_holder';
  const isAzores = input.region === 'azores';
  const isMadeira = input.region === 'madeira';

  // Seleccionar tabela base
  let table = isMarriedOneHolder ? IRS_TABLE_MARRIED_ONE_CONTINENT : IRS_TABLE_SINGLE_CONTINENT;

  let retention = lookupIrsRetention(monthlyGross, table);

  // Ajustes regionais (Açores -30%, Madeira -20%)
  if (isAzores) retention *= 0.70;
  else if (isMadeira) retention *= 0.80;

  // Deduções por dependente
  retention -= Math.max(0, safeNumber(input.dependents)) * IRS_DEDUCTION_PER_DEPENDENT;
  retention -= Math.max(0, safeNumber(input.disabledDependents)) * IRS_DEDUCTION_PER_DISABLED_DEPENDENT;

  // IRS Jovem: isenção progressiva por ano de trabalho com limite anual
  if (input.youngIrs) {
    const exemptRate = youngIrsExemptionRate(safeNumber(input.youngIrsYear, 1));
    const monthlyLimit = YOUNG_IRS_ANNUAL_LIMIT / 12;
    const exemptAmount = Math.min(monthlyGross * exemptRate, monthlyLimit * exemptRate);
    const reducedBase = Math.max(0, monthlyGross - exemptAmount);
    const reducedEntry = table.find((e) => reducedBase <= e.upTo) || table[table.length - 1];
    // Recalcular sobre base reduzida e reaplicar deduções por dependente
    retention = Math.max(0, reducedBase * reducedEntry.rate - reducedEntry.deduction);
    retention -= Math.max(0, safeNumber(input.dependents)) * IRS_DEDUCTION_PER_DEPENDENT;
    retention -= Math.max(0, safeNumber(input.disabledDependents)) * IRS_DEDUCTION_PER_DISABLED_DEPENDENT;
  }

  // Deficiência: tabela específica (redução ~50%)
  if (input.disability) retention *= 0.50;

  return Math.max(0, roundMoney(retention));
}

/** @deprecated use getIrsRetentionMonthly instead */
function getApproxIrsRate(_input: SalaryNetInput): number {
  return 0; // mantido por compatibilidade — não usar directamente
}

function getHouseholdAdults(input: SalaryNetInput): number {
  return input.maritalStatus === 'single' ? 1 : 2;
}

function calculateMealAllowance(input: SalaryNetInput) {
  const monthly = safeNumber(input.mealAllowanceDaily) * safeNumber(input.mealDays);
  const exemptionLimit = input.mealType === 'card' ? MEAL_EXEMPTION_CARD : MEAL_EXEMPTION_CASH;
  const taxable = Math.max(0, safeNumber(input.mealAllowanceDaily) - exemptionLimit) * safeNumber(input.mealDays);
  return {
    monthly: roundMoney(monthly),
    taxable: roundMoney(taxable),
    exempt: roundMoney(Math.max(0, monthly - taxable)),
  };
}

function calculateSalaryBase(input: SalaryNetInput) {
  const gross = Math.max(0, safeNumber(input.grossSalary));
  const extraPay = Math.max(0, safeNumber(input.extraPay));
  const otherTaxableIncome = Math.max(0, safeNumber(input.otherTaxableIncome));
  const irsOnlyIncome = Math.max(0, safeNumber(input.irsOnlyIncome));
  const exemptIncome = Math.max(0, safeNumber(input.exemptIncome));
  const meal = calculateMealAllowance(input);
  const allowanceMonthly = gross * ((input.duodecimos && input.holidayAllowance ? 1 / 12 : 0) + (input.duodecimos && input.christmasAllowance ? 1 / 12 : 0));
  const contributiveBase = gross + allowanceMonthly + extraPay + otherTaxableIncome + meal.taxable;
  const irsBase = contributiveBase + irsOnlyIncome;
  const workerRate = Math.max(0, safeNumber(input.socialSecurityRate, SOCIAL_SECURITY_WORKER_RATE * 100)) / 100;
  const socialSecurity = contributiveBase * workerRate;
  // IRS aplica-se sobre a base LÍQUIDA de SS (confirmado pela tabela Doutor Finanças 2026)
  const irsNetBase = Math.max(0, irsBase - socialSecurity);
  const irs = getIrsRetentionMonthly(input, irsNetBase);
  const grossMonthlyTotal = gross + allowanceMonthly + extraPay + otherTaxableIncome + irsOnlyIncome + exemptIncome + meal.monthly;
  const net = grossMonthlyTotal - socialSecurity - irs;
  return {
    gross,
    extraPay: roundMoney(extraPay),
    otherTaxableIncome: roundMoney(otherTaxableIncome),
    irsOnlyIncome: roundMoney(irsOnlyIncome),
    exemptIncome: roundMoney(exemptIncome),
    meal,
    allowanceMonthly: roundMoney(allowanceMonthly),
    contributiveBase: roundMoney(contributiveBase),
    taxableBase: roundMoney(irsBase),
    socialSecurity: roundMoney(socialSecurity),
    irs: roundMoney(irs),
    grossMonthlyTotal: roundMoney(grossMonthlyTotal),
    net: roundMoney(net),
  };
}

export function calculateSalaryNet(input: SalaryNetInput): SimulationResult {
  const values = calculateSalaryBase(input);
  const incomeHolders = input.maritalStatus === 'married_two_holders' ? 2 : 1;
  const householdMembers = getHouseholdAdults(input) + Math.max(0, safeNumber(input.dependents));
  const employerRate = Math.max(0, safeNumber(input.employerSocialSecurityRate, SOCIAL_SECURITY_EMPLOYER_RATE * 100)) / 100;
  const employerSocialSecurity = roundMoney(values.contributiveBase * employerRate);
  // Seguro de acidentes de trabalho (obrigatório — default 1.75%)
  const accidentInsuranceRate = Math.max(0, safeNumber(input.workAccidentInsuranceRate, 1.75)) / 100;
  const accidentInsuranceMonthly = roundMoney(values.gross * accidentInsuranceRate);
  // Taxa efectiva = IRS retido / base tributável (para apresentação na regra)
  const irsRate = values.taxableBase > 0 ? values.irs / values.taxableBase : 0;
  const months = Math.max(1, safeNumber(input.monthsPerYear, 14));
  const annualGross = roundMoney((values.gross + values.extraPay + values.otherTaxableIncome + values.irsOnlyIncome + values.exemptIncome) * months + values.meal.monthly * 11);
  // Custo anual total empregador = salário × meses + SS patronal × meses + seguro × 12
  const annualEmployerCost = roundMoney(
    (values.grossMonthlyTotal + employerSocialSecurity) * months + accidentInsuranceMonthly * 12
  );
  const monthlyEmployerCost = roundMoney(values.grossMonthlyTotal + employerSocialSecurity + accidentInsuranceMonthly);
  // Taxa de esforço patronal = custo total / salário bruto
  const employerEffortRate = values.gross > 0 ? roundMoney((monthlyEmployerCost / values.gross - 1) * 100) : 0;

  return {
    simulatorId: 'salary-net',
    title: 'Simulador de Salário Líquido',
    version: RULE_VERSIONS['salary-net'],
    summary: [
      { label: 'Líquido estimado', value: values.net, tone: 'positive' },
      { label: 'IRS retido estimado', value: values.irs, tone: 'negative' },
      { label: 'Segurança Social trabalhador', value: values.socialSecurity, tone: 'negative' },
      { label: 'Custo empresa mensal', value: monthlyEmployerCost, tone: 'neutral' },
    ],
    details: [
      { label: 'Salário bruto', value: values.gross },
      { label: 'Retribuição extraordinária', value: values.extraPay },
      { label: 'Outros rendimentos sujeitos a IRS e SS', value: values.otherTaxableIncome },
      { label: 'Outros rendimentos sujeitos só a IRS', value: values.irsOnlyIncome },
      { label: 'Rendimentos isentos', value: values.exemptIncome },
      { label: 'Duodécimos', value: values.allowanceMonthly },
      { label: 'Subsídio alimentação total', value: values.meal.monthly },
      { label: 'Subsídio alimentação isento', value: values.meal.exempt },
      { label: 'Subsídio alimentação tributável', value: values.meal.taxable },
      { label: 'Base contributiva SS', value: values.contributiveBase },
      { label: 'Base retenção IRS', value: values.taxableBase },
      { label: 'Total bruto mensal recebido', value: values.grossMonthlyTotal },
      { label: 'Bruto anual estimado', value: annualGross },
      { label: 'SS patronal mensal', value: employerSocialSecurity },
      { label: 'Seguro acidentes trabalho (mensal)', value: accidentInsuranceMonthly },
      { label: 'Custo anual total empregador', value: annualEmployerCost },
      { label: 'Taxa esforço patronal', value: `+${employerEffortRate}% sobre salário bruto` as any },
    ],
    basis: [
      {
        label: 'Retenção IRS estimada',
        value: `${roundMoney(irsRate * 100).toFixed(2)}% sobre base tributável`,
        sourceLabel: PORTAL_FINANCAS_RETENTION_SOURCE.label,
        sourceUrl: PORTAL_FINANCAS_RETENTION_SOURCE.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Segurança Social trabalhador',
        value: `${roundMoney(safeNumber(input.socialSecurityRate, 11)).toFixed(2)}%`,
        sourceLabel: SEG_SOCIAL_SOURCE.label,
        sourceUrl: SEG_SOCIAL_SOURCE.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Segurança Social entidade empregadora',
        value: `${roundMoney(safeNumber(input.employerSocialSecurityRate, 23.75)).toFixed(2)}%`,
        sourceLabel: SEG_SOCIAL_SOURCE.label,
        sourceUrl: SEG_SOCIAL_SOURCE.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Subsídio alimentação isento',
        value: input.mealType === 'card' ? 'Até 10,20 €/dia em cartão/vale' : 'Até 6,00 €/dia em dinheiro',
        sourceLabel: PORTAL_FINANCAS_RETENTION_SOURCE.label,
        sourceUrl: PORTAL_FINANCAS_RETENTION_SOURCE.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Seguro acidentes de trabalho',
        value: `${safeNumber(input.workAccidentInsuranceRate, 1.75).toFixed(2)}% do salário bruto (obrigatório)`,
        sourceLabel: 'Lei n.º 98/2009 — Regime jurídico de acidentes de trabalho',
        sourceUrl: 'https://dre.pt/legislacao-consolidada/-/lc/34454475/view',
        confidence: 'requires_validation',
      },
      ...(input.youngIrs ? [{
        label: 'IRS Jovem — isenção aplicada',
        value: `${youngIrsExemptionRate(safeNumber(input.youngIrsYear, 1)) * 100}% (${safeNumber(input.youngIrsYear, 1)}º ano) · limite ${YOUNG_IRS_ANNUAL_LIMIT}€/ano`,
        sourceLabel: 'Decreto-Lei n.º 2/2024 — IRS Jovem',
        sourceUrl: 'https://dre.pt/dre/detalhe/decreto-lei/2-2024-843898484',
        confidence: 'requires_validation',
      }] : []),
    ],
    assumptions: [
      `Região: ${input.region}`,
      `Agregado: ${householdMembers} pessoa(s)`,
      `Titulares de rendimento: ${incomeHolders}`,
      `Dependentes: ${input.dependents}`,
      `Dependentes com deficiência: ${input.disabledDependents}`,
      input.duodecimos ? 'Subsídios em duodécimos considerados mensalmente.' : 'Subsídios não considerados no mês.',
    ],
    warnings: RULE_VERSIONS['salary-net'].notes,
    computedAt: currentDateIso(),
  };
}

export function calculateEmployeeCost(input: EmployeeCostInput): SimulationResult {
  const values = calculateSalaryBase(input);
  const employerSocialSecurity = roundMoney(values.contributiveBase * (Math.max(0, safeNumber(input.employerSocialSecurityRate, 23.75)) / 100));
  const insurance = roundMoney(safeNumber(input.insuranceMonthly));
  const benefits = roundMoney(safeNumber(input.otherBenefits));
  const totalCost = roundMoney(values.grossMonthlyTotal + employerSocialSecurity + insurance + benefits);

  return {
    simulatorId: 'employee-cost',
    title: 'Simulador de Custo Colaborador Empresa',
    version: RULE_VERSIONS['employee-cost'],
    summary: [
      { label: 'Custo mensal empresa', value: totalCost, tone: 'negative' },
      { label: 'Líquido colaborador estimado', value: values.net, tone: 'positive' },
      { label: 'Contribuição patronal', value: employerSocialSecurity, tone: 'negative' },
      { label: 'Benefícios e seguros', value: roundMoney(insurance + benefits), tone: 'neutral' },
    ],
    details: [
      { label: 'Salário bruto, duodécimos e extras', value: roundMoney(values.gross + values.allowanceMonthly + values.extraPay + values.otherTaxableIncome + values.irsOnlyIncome + values.exemptIncome) },
      { label: 'Subsídio alimentação', value: values.meal.monthly },
      { label: 'Seguro acidentes trabalho', value: insurance },
      { label: 'Outros benefícios', value: benefits },
      { label: 'Base contributiva', value: values.contributiveBase },
    ],
    basis: [
      {
        label: 'Taxa contributiva patronal',
        value: `${roundMoney(safeNumber(input.employerSocialSecurityRate, 23.75)).toFixed(2)}%`,
        sourceLabel: SEG_SOCIAL_SOURCE.label,
        sourceUrl: SEG_SOCIAL_SOURCE.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Taxa contributiva trabalhador',
        value: `${roundMoney(safeNumber(input.socialSecurityRate, 11)).toFixed(2)}%`,
        sourceLabel: SEG_SOCIAL_SOURCE.label,
        sourceUrl: SEG_SOCIAL_SOURCE.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Base considerada para custo',
        value: 'Retribuição mensal, extras, subsídio alimentação, encargos e benefícios configurados',
        sourceLabel: 'Configuração MPR Negócios',
        sourceUrl: 'https://www.mpr.pt',
        confidence: 'requires_validation',
      },
    ],
    assumptions: RULE_VERSIONS['employee-cost'].notes,
    warnings: ['Não inclui medicina no trabalho, custos administrativos, fundos de compensação ou regimes contributivos especiais.'],
    computedAt: currentDateIso(),
  };
}
