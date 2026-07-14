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

// Tabelas oficiais de retenção IRS 2026, Continente (Despacho n.º 233-A/2026).
// Fórmula: max(0, R × taxa marginal - parcela - parcela dependente × n.º dependentes).
// R é a remuneração mensal sujeita a IRS, antes da dedução da Segurança Social.

type IrsTableEntry = {
  upTo: number;
  rate: number;
  deduction: number | ((monthlyGross: number) => number);
  dependentDeduction: number;
};

function rDeduction(multiplier: number, factor: number, reference: number) {
  return (monthlyGross: number) => multiplier * factor * (reference - monthlyGross);
}

// Tabela I — Não casado sem dependentes ou casado dois titulares.
const IRS_TABLE_SINGLE_CONTINENT: IrsTableEntry[] = [
  { upTo: 920, rate: 0, deduction: 0, dependentDeduction: 0 },
  { upTo: 1042, rate: 0.1250, deduction: rDeduction(0.1250, 2.60, 1273.85), dependentDeduction: 21.43 },
  { upTo: 1108, rate: 0.1570, deduction: rDeduction(0.1570, 1.35, 1554.83), dependentDeduction: 21.43 },
  { upTo: 1154, rate: 0.1570, deduction: 94.71, dependentDeduction: 21.43 },
  { upTo: 1212, rate: 0.2120, deduction: 158.18, dependentDeduction: 21.43 },
  { upTo: 1819, rate: 0.2410, deduction: 193.33, dependentDeduction: 21.43 },
  { upTo: 2119, rate: 0.3110, deduction: 320.66, dependentDeduction: 21.43 },
  { upTo: 2499, rate: 0.3490, deduction: 401.19, dependentDeduction: 21.43 },
  { upTo: 3305, rate: 0.3836, deduction: 487.66, dependentDeduction: 21.43 },
  { upTo: 5547, rate: 0.3969, deduction: 531.62, dependentDeduction: 21.43 },
  { upTo: 20221, rate: 0.4495, deduction: 823.40, dependentDeduction: 21.43 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.4717, deduction: 1272.31, dependentDeduction: 21.43 },
];

// Tabela II — Não casado com um ou mais dependentes.
const IRS_TABLE_SINGLE_WITH_DEPENDENTS_CONTINENT: IrsTableEntry[] = IRS_TABLE_SINGLE_CONTINENT.map((entry) => ({
  ...entry,
  dependentDeduction: entry.upTo === 920 ? 0 : 34.29,
}));

// Tabela III — Casado, único titular.
const IRS_TABLE_MARRIED_ONE_CONTINENT: IrsTableEntry[] = [
  { upTo: 991, rate: 0, deduction: 0, dependentDeduction: 0 },
  { upTo: 1042, rate: 0.1250, deduction: rDeduction(0.1250, 2.60, 1372.15), dependentDeduction: 42.86 },
  { upTo: 1108, rate: 0.1250, deduction: rDeduction(0.1250, 1.35, 1677.85), dependentDeduction: 42.86 },
  { upTo: 1119, rate: 0.1250, deduction: 96.17, dependentDeduction: 42.86 },
  { upTo: 1432, rate: 0.1272, deduction: 98.64, dependentDeduction: 42.86 },
  { upTo: 1962, rate: 0.1570, deduction: 141.32, dependentDeduction: 42.86 },
  { upTo: 2240, rate: 0.1938, deduction: 213.53, dependentDeduction: 42.86 },
  { upTo: 2773, rate: 0.2277, deduction: 289.47, dependentDeduction: 42.86 },
  { upTo: 3389, rate: 0.2570, deduction: 370.72, dependentDeduction: 42.86 },
  { upTo: 5965, rate: 0.2881, deduction: 476.12, dependentDeduction: 42.86 },
  { upTo: 20265, rate: 0.3843, deduction: 1049.96, dependentDeduction: 42.86 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.4717, deduction: 2821.13, dependentDeduction: 42.86 },
];

// Tabelas IV a VII — titular com deficiência.
const IRS_TABLE_DISABLED_SINGLE_OR_MARRIED_TWO_NO_DEPENDENTS_CONTINENT: IrsTableEntry[] = [
  { upTo: 1694, rate: 0, deduction: 0, dependentDeduction: 0 },
  { upTo: 2063, rate: 0.2120, deduction: 359.13, dependentDeduction: 0 },
  { upTo: 2492, rate: 0.3110, deduction: 563.37, dependentDeduction: 0 },
  { upTo: 4487, rate: 0.3490, deduction: 658.07, dependentDeduction: 0 },
  { upTo: 4753, rate: 0.3836, deduction: 813.33, dependentDeduction: 0 },
  { upTo: 6687, rate: 0.3969, deduction: 876.55, dependentDeduction: 0 },
  { upTo: 20468, rate: 0.4495, deduction: 1228.29, dependentDeduction: 0 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.4717, deduction: 1682.68, dependentDeduction: 0 },
];

const IRS_TABLE_DISABLED_SINGLE_WITH_DEPENDENTS_CONTINENT: IrsTableEntry[] = [
  { upTo: 1938, rate: 0, deduction: 0, dependentDeduction: 0 },
  { upTo: 2063, rate: 0.2132, deduction: 413.19, dependentDeduction: 42.86 },
  { upTo: 2854, rate: 0.3110, deduction: 614.96, dependentDeduction: 42.86 },
  { upTo: 4504, rate: 0.3490, deduction: 723.42, dependentDeduction: 42.86 },
  { upTo: 6826, rate: 0.3836, deduction: 879.26, dependentDeduction: 42.86 },
  { upTo: 7048, rate: 0.3969, deduction: 970.05, dependentDeduction: 42.86 },
  { upTo: 20468, rate: 0.4495, deduction: 1340.78, dependentDeduction: 42.86 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.4717, deduction: 1795.17, dependentDeduction: 42.86 },
];

const IRS_TABLE_DISABLED_MARRIED_TWO_WITH_DEPENDENTS_CONTINENT: IrsTableEntry[] = [
  { upTo: 1668, rate: 0, deduction: 0, dependentDeduction: 0 },
  { upTo: 2068, rate: 0.2049, deduction: 341.78, dependentDeduction: 21.43 },
  { upTo: 2497, rate: 0.2410, deduction: 416.44, dependentDeduction: 21.43 },
  { upTo: 3107, rate: 0.3110, deduction: 591.23, dependentDeduction: 21.43 },
  { upTo: 4504, rate: 0.3490, deduction: 709.30, dependentDeduction: 21.43 },
  { upTo: 6826, rate: 0.3836, deduction: 865.14, dependentDeduction: 21.43 },
  { upTo: 7048, rate: 0.3969, deduction: 955.93, dependentDeduction: 21.43 },
  { upTo: 20468, rate: 0.4495, deduction: 1326.66, dependentDeduction: 21.43 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.4717, deduction: 1781.05, dependentDeduction: 21.43 },
];

const IRS_TABLE_DISABLED_MARRIED_ONE_CONTINENT: IrsTableEntry[] = [
  { upTo: 2325, rate: 0, deduction: 0, dependentDeduction: 0 },
  { upTo: 3494, rate: 0.2277, deduction: 529.41, dependentDeduction: 42.86 },
  { upTo: 3761, rate: 0.2570, deduction: 631.79, dependentDeduction: 42.86 },
  { upTo: 6687, rate: 0.2881, deduction: 748.76, dependentDeduction: 42.86 },
  { upTo: 20468, rate: 0.4244, deduction: 1660.20, dependentDeduction: 42.86 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.4717, deduction: 2628.34, dependentDeduction: 42.86 },
];

function resolveDeduction(entry: IrsTableEntry, monthlyGross: number): number {
  return typeof entry.deduction === 'function' ? entry.deduction(monthlyGross) : entry.deduction;
}

function lookupIrsRetention(monthlyGross: number, table: IrsTableEntry[], input: SalaryNetInput): number {
  const entry = table.find((e) => monthlyGross <= e.upTo) || table[table.length - 1];
  const dependents = Math.max(0, safeNumber(input.dependents));
  const disabledDependents = Math.max(0, Math.min(dependents, safeNumber(input.disabledDependents)));
  const disabledDependentExtra = input.maritalStatus === 'married_two_holders' ? 42.41 : 84.82;
  const rate = dependents >= 3 ? Math.max(0, entry.rate - 0.01) : entry.rate;
  return Math.max(
    0,
    monthlyGross * rate
      - resolveDeduction(entry, monthlyGross)
      - entry.dependentDeduction * dependents
      - disabledDependentExtra * disabledDependents,
  );
}

function getIrsRetentionMonthly(input: SalaryNetInput, monthlyGross: number): number {
  const isMarriedOneHolder = input.maritalStatus === 'married_one_holder';
  const isAzores = input.region === 'azores';
  const isMadeira = input.region === 'madeira';
  const dependents = Math.max(0, safeNumber(input.dependents));

  let table: IrsTableEntry[];
  if (input.disability) {
    if (isMarriedOneHolder) table = IRS_TABLE_DISABLED_MARRIED_ONE_CONTINENT;
    else if (input.maritalStatus === 'married_two_holders' && dependents > 0) table = IRS_TABLE_DISABLED_MARRIED_TWO_WITH_DEPENDENTS_CONTINENT;
    else if (dependents > 0) table = IRS_TABLE_DISABLED_SINGLE_WITH_DEPENDENTS_CONTINENT;
    else table = IRS_TABLE_DISABLED_SINGLE_OR_MARRIED_TWO_NO_DEPENDENTS_CONTINENT;
  } else if (isMarriedOneHolder) {
    table = IRS_TABLE_MARRIED_ONE_CONTINENT;
  } else if (input.maritalStatus === 'single' && dependents > 0) {
    table = IRS_TABLE_SINGLE_WITH_DEPENDENTS_CONTINENT;
  } else {
    table = IRS_TABLE_SINGLE_CONTINENT;
  }

  let retention = lookupIrsRetention(monthlyGross, table, input);

  // Ajustes regionais (Açores -30%, Madeira -20%)
  if (isAzores) retention *= 0.70;
  else if (isMadeira) retention *= 0.80;

  // IRS Jovem: isenção progressiva por ano de trabalho com limite anual
  if (input.youngIrs) {
    const exemptRate = youngIrsExemptionRate(safeNumber(input.youngIrsYear, 1));
    const monthlyLimit = YOUNG_IRS_ANNUAL_LIMIT / 14;
    const exemptAmount = Math.min(monthlyGross * exemptRate, monthlyLimit * exemptRate);
    const reducedBase = Math.max(0, monthlyGross - exemptAmount);
    retention = lookupIrsRetention(reducedBase, table, input);
    if (isAzores) retention *= 0.70;
    else if (isMadeira) retention *= 0.80;
  }

  return Math.max(0, Math.floor(retention));
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
  const irs = getIrsRetentionMonthly(input, irsBase);
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
        confidence: 'requires_validation' as const,
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
