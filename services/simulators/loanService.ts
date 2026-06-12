import { RULE_VERSIONS, SimulationResult, currentDateIso, roundMoney, safeNumber } from './common';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LoanRateType = 'fixed' | 'variable';

export type LoanInput = {
  loanAmount: number;
  euribor: number;              // % e.g. 3.264
  spread: number;               // % e.g. 1.5
  rateType: LoanRateType;       // taxa fixa ou variável
  euriborReviewMonths: 6 | 12;  // revisão euribor (só variável)
  termYears: number;
  startDate: string;            // YYYY-MM-DD
  extraPaymentMonthly: number;
};

export type LoanRow = {
  num: number;
  date: string;
  beginBalance: number;
  scheduled: number;
  extra: number;
  total: number;
  principal: number;
  interest: number;
  endBalance: number;
};

export type LoanSchedule = {
  rows: LoanRow[];
  scheduledMonthly: number;
  numScheduledPayments: number;
  numActualPayments: number;
  totalExtraPayments: number;
  totalInterest: number;
  totalPaid: number;
  interestSaved: number;
  annualRatePct: number;        // euribor + spread
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function pmt(monthlyRate: number, nper: number, pv: number): number {
  if (nper <= 0) return 0;
  if (monthlyRate < 0.000001) return roundMoney(pv / nper); // evita perda de precisão com taxas próximas de 0
  const factor = Math.pow(1 + monthlyRate, nper);
  return roundMoney(pv * (monthlyRate * factor) / (factor - 1));
}

function addMonths(dateStr: string, n: number): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr + 'T00:00:00');
    d.setMonth(d.getMonth() + n);
    return d.toISOString().slice(0, 10);
  } catch { return ''; }
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  try { return new Date(iso + 'T00:00:00').toLocaleDateString('pt-PT'); } catch { return iso; }
}

// ── Core schedule computation ─────────────────────────────────────────────────

export function computeLoanSchedule(input: LoanInput): LoanSchedule {
  const P      = Math.max(0, safeNumber(input.loanAmount));
  const annualRate = Math.max(0, safeNumber(input.euribor)) + Math.max(0, safeNumber(input.spread));
  const r      = annualRate / 100 / 12;
  const nTotal = Math.min(360, Math.max(1, Math.round(safeNumber(input.termYears) * 12)));
  const extra  = Math.max(0, safeNumber(input.extraPaymentMonthly));

  const scheduled = pmt(r, nTotal, P);

  // Baseline interest without extra (for savings calc) — acumular em raw para evitar erro de arredondamento
  let baselineInterestRaw = 0;
  {
    let bal = P;
    for (let i = 0; i < nTotal && bal > 0.005; i++) {
      const int  = bal * r;                                      // raw, não arredondado
      const prin = Math.min(bal, scheduled - roundMoney(int));
      baselineInterestRaw += int;
      bal = Math.max(0, bal - prin);
    }
  }
  const baselineInterest = roundMoney(baselineInterestRaw);

  const rows: LoanRow[] = [];
  let balance     = P;
  let totalExtra  = 0;
  let totalInterest = 0;

  while (balance > 0.005 && rows.length < nTotal + 1) {
    const num          = rows.length + 1;
    const beginBalance = balance;
    const interest     = roundMoney(beginBalance * r);
    const principalBase = roundMoney(scheduled - interest);

    // Last payment
    if (balance + interest <= scheduled + extra + 0.005) {
      const lastInterest = roundMoney(balance * r);
      const lastTotal    = roundMoney(balance + lastInterest);
      rows.push({
        num,
        date: fmtDate(addMonths(input.startDate, num - 1)),
        beginBalance,
        scheduled: lastTotal,
        extra: 0,
        total: lastTotal,
        principal: balance,
        interest: lastInterest,
        endBalance: 0,
      });
      totalInterest += lastInterest;
      break;
    }

    const extraThisMonth = Math.min(extra, Math.max(0, balance - principalBase));
    const principal      = roundMoney(principalBase + extraThisMonth);
    const total          = roundMoney(scheduled + extraThisMonth);
    const endBalance     = roundMoney(Math.max(0, balance - principal));

    rows.push({
      num,
      date: fmtDate(addMonths(input.startDate, num - 1)),
      beginBalance,
      scheduled,
      extra: extraThisMonth,
      total,
      principal,
      interest,
      endBalance,
    });

    totalInterest += interest;
    totalExtra    += extraThisMonth;
    balance        = endBalance;
  }

  return {
    rows,
    scheduledMonthly: scheduled,
    numScheduledPayments: nTotal,
    numActualPayments: rows.length,
    totalExtraPayments: roundMoney(totalExtra),
    totalInterest: roundMoney(totalInterest),
    totalPaid: roundMoney(rows.reduce((s, r) => s + r.total, 0)),
    interestSaved: roundMoney(Math.max(0, baselineInterest - totalInterest)),
    annualRatePct: annualRate,
  };
}

// ── Annual grouping ───────────────────────────────────────────────────────────

export type LoanYearSummary = {
  year: number;
  payments: number;
  totalPaid: number;
  totalPrincipal: number;
  totalInterest: number;
  totalExtra: number;
  endBalance: number;
  rows: LoanRow[];
};

export function groupByYear(rows: LoanRow[]): LoanYearSummary[] {
  const map = new Map<number, LoanRow[]>();
  for (const row of rows) {
    const parts = row.date.split('/');
    const year = parts.length === 3 ? parseInt(parts[2]) : 0;
    if (!map.has(year)) map.set(year, []);
    map.get(year)!.push(row);
  }
  return Array.from(map.entries()).map(([year, yr]) => ({
    year,
    payments: yr.length,
    totalPaid: roundMoney(yr.reduce((s, r) => s + r.total, 0)),
    totalPrincipal: roundMoney(yr.reduce((s, r) => s + r.principal, 0)),
    totalInterest: roundMoney(yr.reduce((s, r) => s + r.interest, 0)),
    totalExtra: roundMoney(yr.reduce((s, r) => s + r.extra, 0)),
    endBalance: yr[yr.length - 1].endBalance,
    rows: yr,
  }));
}

// ── SimulationResult wrapper ──────────────────────────────────────────────────

export function calculateLoan(input: LoanInput): SimulationResult {
  const sch = computeLoanSchedule(input);
  const annualRate = sch.annualRatePct;
  const isVariable = input.rateType === 'variable';

  return {
    simulatorId: 'loan',
    title: 'Simulador de Empréstimo',
    version: RULE_VERSIONS.loan,
    summary: [
      { label: 'Prestação mensal',  value: sch.scheduledMonthly,   tone: 'positive' },
      { label: 'Total pago',        value: sch.totalPaid,          tone: 'neutral' },
      { label: 'Juros total',       value: sch.totalInterest,      tone: 'neutral' },
      { label: 'Nº prestações',     value: sch.numActualPayments as unknown as number, tone: 'neutral' },
    ],
    details: [
      { label: 'Valor do empréstimo',          value: safeNumber(input.loanAmount) },
      { label: 'Euribor',                      value: `${safeNumber(input.euribor).toFixed(3)}%` as unknown as number },
      { label: 'Spread',                       value: `${safeNumber(input.spread).toFixed(3)}%` as unknown as number },
      { label: 'Taxa nominal anual (TAN)',      value: `${annualRate.toFixed(3)}%` as unknown as number },
      { label: 'Taxa nominal mensal',          value: `${(annualRate / 12).toFixed(4)}%` as unknown as number },
      { label: 'Tipo de taxa',                 value: isVariable ? `Variável (revisão ${input.euriborReviewMonths} meses)` as unknown as number : 'Fixa' as unknown as number },
      { label: 'Prazo',                        value: `${safeNumber(input.termYears)} anos (${sch.numScheduledPayments} meses)` as unknown as number },
      { label: 'Prestação mensal programada',  value: sch.scheduledMonthly },
      { label: 'Pagamento extra mensal',       value: safeNumber(input.extraPaymentMonthly) },
      { label: 'Nº prestações programadas',    value: sch.numScheduledPayments as unknown as number },
      { label: 'Nº prestações reais',          value: sch.numActualPayments as unknown as number },
      { label: 'Total amortização capital',    value: roundMoney(safeNumber(input.loanAmount)) },
      { label: 'Total pagamentos extra',       value: sch.totalExtraPayments },
      { label: 'Total juros pagos',            value: sch.totalInterest },
      { label: 'Total pago',                   value: sch.totalPaid },
      ...(sch.interestSaved > 0 ? [
        { label: 'Juros poupados c/ extra', value: sch.interestSaved },
        { label: 'Meses antecipados',       value: (sch.numScheduledPayments - sch.numActualPayments) as unknown as number },
      ] : []),
    ],
    basis: [
      {
        label: 'Método de amortização',
        value: 'Francês — prestação constante, juros calculados sobre saldo em dívida',
        sourceLabel: RULE_VERSIONS.loan.sources[0].label,
        sourceUrl: RULE_VERSIONS.loan.sources[0].url,
        confidence: 'updated',
      },
    ],
    assumptions: [
      `Empréstimo de ${safeNumber(input.loanAmount).toLocaleString('pt-PT')} €`,
      `TAN: ${annualRate.toFixed(3)}% (Euribor ${safeNumber(input.euribor).toFixed(3)}% + Spread ${safeNumber(input.spread).toFixed(3)}%)`,
      `Taxa ${isVariable ? `variável — revisão Euribor a cada ${input.euriborReviewMonths} meses` : 'fixa — não sofre revisão'}`,
      `Prazo: ${safeNumber(input.termYears)} anos | Início: ${input.startDate}`,
      safeNumber(input.extraPaymentMonthly) > 0
        ? `Pagamento extra: ${safeNumber(input.extraPaymentMonthly).toLocaleString('pt-PT')} €/mês`
        : 'Sem pagamentos extra',
    ],
    warnings: [
      ...RULE_VERSIONS.loan.notes,
      ...(isVariable ? [`Taxa variável: prestação calculada com Euribor atual (${safeNumber(input.euribor).toFixed(3)}%). Alterações futuras da Euribor modificarão o valor da prestação a cada ${input.euriborReviewMonths} meses.`] : []),
    ],
    computedAt: currentDateIso(),
  };
}

export const defaultLoanInput: LoanInput = {
  loanAmount: 180000,
  euribor: 2.599,
  spread: 1.5,
  rateType: 'variable',
  euriborReviewMonths: 12,
  termYears: 15,
  startDate: new Date().toISOString().slice(0, 10),
  extraPaymentMonthly: 0,
};
