import { RULE_VERSIONS, SimulationResult, currentDateIso, roundMoney, safeNumber } from './common';

export type ActCompensationInput = {
  monthlyBaseSalary: number;
  diuturnities: number;
  complements: number;
  startDate: string;
  endDate: string;
  contractType: 'indefinite' | 'fixed_term';
  endedBy: 'employer' | 'worker';
  justCause: boolean;
  reason: 'collective' | 'extinction' | 'fixed_term' | 'initiative_employer';
  vacationDaysDue: number;
  vacationDaysTaken: number;
  holidayAllowanceReceived: number;
  proportionalVacationReceived: number;
  proportionalHolidayReceived: number;
  proportionalChristmasReceived: number;
  trainingHoursDue: number;
};

const ACT_SOURCE = RULE_VERSIONS['act-compensation'].sources[0];

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function maxDate(left: Date, right: Date): Date {
  return left.getTime() > right.getTime() ? left : right;
}

function minDate(left: Date, right: Date): Date {
  return left.getTime() < right.getTime() ? left : right;
}

function calendarDiffInclusive(start: Date, end: Date): { years: number; months: number; days: number } {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end.getTime() < start.getTime()) {
    return { years: 0, months: 0, days: 0 };
  }

  const inclusiveEnd = addDays(end, 1);
  let years = inclusiveEnd.getFullYear() - start.getFullYear();
  let months = inclusiveEnd.getMonth() - start.getMonth();
  let days = inclusiveEnd.getDate() - start.getDate();

  if (days < 0) {
    months -= 1;
    days += new Date(inclusiveEnd.getFullYear(), inclusiveEnd.getMonth(), 0).getDate();
  }

  if (months < 0) {
    years -= 1;
    months += 12;
  }

  return {
    years: Math.max(0, years),
    months: Math.max(0, months),
    days: Math.max(0, days),
  };
}

function compensationYearFactor(start: Date, end: Date): number {
  const diff = calendarDiffInclusive(start, end);
  return diff.years + (diff.months / 12) + (diff.days / 360);
}

// For sub-year contracts, proportionals are counted from the contract start date, not Jan 1.
// For multi-year contracts, the relevant period is Jan 1 of the cessation year to end.
function cessationYearProportionalFactor(start: Date, end: Date): number {
  if (!Number.isFinite(end.getTime())) return 0;
  const yearStart = new Date(end.getFullYear(), 0, 1);
  const effectiveStart = start.getTime() > yearStart.getTime() ? start : yearStart;
  const dur = calendarDiffInclusive(effectiveStart, end);
  return Math.min(1, Math.max(0, dur.months / 12 + dur.days / 365));
}

export function calculateActCompensation(input: ActCompensationInput): SimulationResult {
  const monthlyBase = Math.max(0, safeNumber(input.monthlyBaseSalary));
  const diuturnities = Math.max(0, safeNumber(input.diuturnities));
  const complements = Math.max(0, safeNumber(input.complements));
  const compensationSalary = monthlyBase + diuturnities;
  const vacationSalary = monthlyBase + diuturnities + complements;
  const start = new Date(input.startDate);
  const end = new Date(input.endDate);
  const duration = calendarDiffInclusive(start, end);
  const years = duration.years + (duration.months / 12) + (duration.days / 365);
  const compensationDailySalary = compensationSalary / 30;
  const vacationDailySalary = vacationSalary / 22;
  const hasCompensation = input.endedBy === 'employer' && !input.justCause;
  const isFixedTerm = input.contractType === 'fixed_term' || input.reason === 'fixed_term';
  // Contratos sem termo: transição Mai 2023 (Lei n.º 13/2023) de 12 → 14 dias/ano
  const transitionDate = new Date(2023, 4, 1);
  const preTransitionEnd = new Date(2023, 3, 30);
  // Contratos a termo: transição Out 2013 (Lei n.º 69/2013) de 24 → 18 dias/ano
  const ftTransitionDate = new Date(2013, 9, 1);
  const ftPreTransitionEnd = new Date(2013, 8, 30);
  let compensationDays = 0;

  if (hasCompensation && isFixedTerm) {
    // Pré-Out 2013: 24 dias/ano (Lei n.º 23/2012 transitório)
    if (start.getTime() <= ftPreTransitionEnd.getTime()) {
      compensationDays += 24 * compensationYearFactor(start, minDate(end, ftPreTransitionEnd));
    }
    // Pós-Out 2013: 18 dias/ano (Lei n.º 69/2013)
    if (end.getTime() >= ftTransitionDate.getTime()) {
      compensationDays += 18 * compensationYearFactor(maxDate(start, ftTransitionDate), end);
    }
  } else if (hasCompensation) {
    if (start.getTime() <= preTransitionEnd.getTime()) {
      compensationDays += 12 * compensationYearFactor(start, minDate(end, preTransitionEnd));
    }
    if (end.getTime() >= transitionDate.getTime()) {
      compensationDays += 14 * compensationYearFactor(maxDate(start, transitionDate), end);
    }
  }

  const compensation = compensationDailySalary * compensationDays;
  // Sub-year contracts (< 12 months): no vested previous-year entitlements, everything is proportional.
  const isSubYearContract = duration.years === 0;
  const proportionalFactor = cessationYearProportionalFactor(start, end);
  const vacationDaysOutstanding = Math.max(0, safeNumber(input.vacationDaysDue, 22) - safeNumber(input.vacationDaysTaken));
  // For sub-year contracts, use the proportional-factor formula (matches official ACT); deduct taken days at daily rate.
  const vacationCredits = isSubYearContract
    ? Math.max(0, vacationSalary * proportionalFactor - vacationDailySalary * safeNumber(input.vacationDaysTaken))
    : vacationDailySalary * vacationDaysOutstanding;
  // Sub-year: subsídio de férias is proportional (no previous full year vested).
  const holidayAllowanceDue = Math.max(0, (isSubYearContract ? vacationSalary * proportionalFactor : vacationSalary) - safeNumber(input.holidayAllowanceReceived));
  // Sub-year: vacation and holiday proportionals are already covered above; only Christmas remains separate.
  const proportionalVacation = isSubYearContract ? 0 : Math.max(0, vacationSalary * proportionalFactor - safeNumber(input.proportionalVacationReceived));
  const proportionalHoliday = isSubYearContract ? 0 : Math.max(0, vacationSalary * proportionalFactor - safeNumber(input.proportionalHolidayReceived));
  const proportionalChristmas = Math.max(0, vacationSalary * proportionalFactor - safeNumber(input.proportionalChristmasReceived));
  const trainingCredits = (vacationSalary / 173) * Math.max(0, safeNumber(input.trainingHoursDue));
  const actComparableSubtotal = roundMoney(compensation + vacationCredits + holidayAllowanceDue + proportionalVacation + proportionalHoliday + proportionalChristmas);
  const total = roundMoney(actComparableSubtotal + trainingCredits);

  return {
    simulatorId: 'act-compensation',
    title: 'Simulador de Compensações ACT',
    version: RULE_VERSIONS['act-compensation'],
    summary: [
      { label: 'Total com formação', value: total, tone: 'positive' },
      { label: 'Subtotal sem formação', value: actComparableSubtotal, tone: 'neutral' },
      { label: 'Compensação cessação', value: roundMoney(compensation), tone: 'neutral' },
      { label: 'Férias e subsídios', value: roundMoney(vacationCredits + holidayAllowanceDue + proportionalVacation + proportionalHoliday + proportionalChristmas), tone: 'neutral' },
      { label: 'Créditos formação', value: roundMoney(trainingCredits), tone: 'neutral' },
    ],
    details: [
      { label: 'Antiguidade em anos', value: roundMoney(years) },
      { label: 'Retribuição mensal compensação', value: roundMoney(compensationSalary) },
      { label: 'Retribuição mensal férias/subsídios', value: roundMoney(vacationSalary) },
      { label: 'Retribuição diária compensação', value: roundMoney(compensationDailySalary) },
      { label: 'Retribuição diária férias', value: roundMoney(vacationDailySalary) },
      { label: 'Dias de compensação apurados', value: roundMoney(compensationDays) },
      { label: 'Compensação cessação', value: roundMoney(compensation) },
      { label: 'Férias vencidas em falta', value: roundMoney(vacationCredits) },
      { label: 'Subsídio de férias vencido', value: roundMoney(holidayAllowanceDue) },
      { label: 'Proporcional férias ano cessação', value: roundMoney(proportionalVacation) },
      { label: 'Proporcional subsídio férias', value: roundMoney(proportionalHoliday) },
      { label: 'Proporcional subsídio Natal', value: roundMoney(proportionalChristmas) },
      { label: 'Subtotal comparável ao ACT', value: actComparableSubtotal },
      { label: 'Horas formação em falta', value: safeNumber(input.trainingHoursDue) },
      { label: 'Crédito formação', value: roundMoney(trainingCredits) },
    ],
    basis: [
      {
        label: 'Compensação base',
        value: hasCompensation
          ? (isFixedTerm ? '18 dias/ano por caducidade de contrato a termo (Lei n.º 69/2013)' : '12 dias/ano até 2023-04-30 e 14 dias/ano desde 2023-05-01')
          : 'Sem compensação configurada para estes pressupostos',
        sourceLabel: ACT_SOURCE.label,
        sourceUrl: ACT_SOURCE.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Férias vencidas',
        value: `${roundMoney(vacationDaysOutstanding)} dias em falta + subsídio vencido`,
        sourceLabel: ACT_SOURCE.label,
        sourceUrl: ACT_SOURCE.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Proporcionais',
        value: isSubYearContract
          ? `${roundMoney(proportionalFactor * 100).toFixed(2)}% do contrato (início no próprio ano)`
          : `${roundMoney(proportionalFactor * 100).toFixed(2)}% do ano de cessação`,
        sourceLabel: ACT_SOURCE.label,
        sourceUrl: ACT_SOURCE.url,
        confidence: 'requires_validation',
      },
      {
        label: 'Créditos de formação',
        value: `${Math.max(0, safeNumber(input.trainingHoursDue))} horas indicadas pelo utilizador`,
        sourceLabel: ACT_SOURCE.label,
        sourceUrl: ACT_SOURCE.url,
        confidence: 'requires_validation',
      },
    ],
    assumptions: [
      `Motivo: ${input.reason}`,
      `Contrato: ${input.contractType}`,
      `Cessação por: ${input.endedBy}`,
      'Férias, proporcionais, subsídios e aviso prévio devem ser revistos com o contrato e situação concreta.',
    ],
    warnings: RULE_VERSIONS['act-compensation'].notes,
    computedAt: currentDateIso(),
  };
}
