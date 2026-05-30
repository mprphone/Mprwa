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
  disability: boolean;
  region: 'continent' | 'azores' | 'madeira';
  socialSecurityRate: number;
  employerSocialSecurityRate: number;
  monthsPerYear: number;
};

export type EmployeeCostInput = SalaryNetInput & {
  insuranceMonthly: number;
  otherBenefits: number;
};

const SOCIAL_SECURITY_WORKER_RATE = 0.11;
const SOCIAL_SECURITY_EMPLOYER_RATE = 0.2375;
const MEAL_EXEMPTION_CASH = 6;
const MEAL_EXEMPTION_CARD = 10.2;

const PORTAL_FINANCAS_RETENTION_SOURCE = RULE_VERSIONS['salary-net'].sources[0];
const SEG_SOCIAL_SOURCE = RULE_VERSIONS['salary-net'].sources[1];

const IRS_APPROX_BRACKETS = [
  { upTo: 820, rate: 0 },
  { upTo: 1100, rate: 0.07 },
  { upTo: 1600, rate: 0.13 },
  { upTo: 2200, rate: 0.19 },
  { upTo: 3200, rate: 0.25 },
  { upTo: 5200, rate: 0.32 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.39 },
];

function getApproxIrsRate(input: SalaryNetInput): number {
  const monthlyReference = safeNumber(input.grossSalary) + safeNumber(input.extraPay) + safeNumber(input.otherTaxableIncome) + safeNumber(input.irsOnlyIncome);
  const bracket = IRS_APPROX_BRACKETS.find((item) => monthlyReference <= item.upTo) || IRS_APPROX_BRACKETS[IRS_APPROX_BRACKETS.length - 1];
  const incomeHolders = input.maritalStatus === 'married_two_holders' ? 2 : 1;
  let rate = bracket.rate;
  rate -= Math.min(0.04, Math.max(0, input.dependents) * 0.005);
  rate -= Math.min(0.03, Math.max(0, input.disabledDependents) * 0.01);
  if (input.maritalStatus === 'married_one_holder') rate -= 0.015;
  if (incomeHolders === 1 && input.maritalStatus !== 'single') rate -= 0.01;
  if (input.youngIrs) rate *= 0.65;
  if (input.disability) rate *= 0.5;
  if (input.region === 'azores') rate *= 0.8;
  if (input.region === 'madeira') rate *= 0.9;
  return Math.max(0, rate);
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
  const irs = irsBase * getApproxIrsRate(input);
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
  const irsRate = getApproxIrsRate(input);
  const annualGross = roundMoney((values.gross + values.extraPay + values.otherTaxableIncome + values.irsOnlyIncome + values.exemptIncome) * Math.max(1, safeNumber(input.monthsPerYear, 14)) + values.meal.monthly * 11);

  return {
    simulatorId: 'salary-net',
    title: 'Simulador de Salário Líquido',
    version: RULE_VERSIONS['salary-net'],
    summary: [
      { label: 'Líquido estimado', value: values.net, tone: 'positive' },
      { label: 'IRS retido estimado', value: values.irs, tone: 'negative' },
      { label: 'Segurança Social trabalhador', value: values.socialSecurity, tone: 'negative' },
      { label: 'Custo empresa base', value: roundMoney(values.grossMonthlyTotal + employerSocialSecurity), tone: 'neutral' },
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
      { label: 'Contribuição patronal estimada', value: employerSocialSecurity },
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
