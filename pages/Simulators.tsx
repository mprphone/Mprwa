import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Calculator,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileText,
  History,
  Mail,
  Pencil,
  RefreshCw,
  Search,
  Share2,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { mockService } from '../services/mockData';
import { ActOfficialValidationResult, validateActCompensationOfficial } from '../services/simulators/actOfficialApi';
import { SalaryOfficialResult, validateSalaryOfficial } from '../services/simulators/salaryOfficialApi';
import {
  ActCompensationInput,
  ImtInput,
  RULE_VERSIONS,
  SalaryNetInput,
  SimulationResult,
  SimulatorId,
  calculateActCompensation,
  calculateImt,
  calculateSalaryNet,
  getRuleHealth,
} from '../services/simulators/engine';
import { SSActivityLine, SSIndependentInput, calculateSSIndependent, defaultSSActivities } from '../services/simulators/ssIndependentService';
import { LoanInput, LoanRow, LoanYearSummary, calculateLoan, computeLoanSchedule, defaultLoanInput, groupByYear } from '../services/simulators/loanService';
import { CarBenefitInput, calculateCarBenefit, defaultCarBenefitInput } from '../services/simulators/carBenefitService';
import { Customer } from '../types';

type SimulatorDefinition = {
  id: SimulatorId;
  phase: string;
  title: string;
  description: string;
  category: string;
};

type StoredSimulation = {
  id: string;
  customerName: string;
  customerId?: string;
  customerNif?: string;
  employeeName?: string;
  result: SimulationResult;
  actInput?: ActCompensationInput;
  salaryInput?: SalaryNetInput;
  imtInput?: ImtInput;
  ssInput?: SSIndependentInput;
  loanInput?: LoanInput;
  carBenefitInput?: CarBenefitInput;
  emailSentTo?: string;
  emailSentAt?: string;
  emailReadAt?: string;
};

const STORAGE_KEY = 'mpr_simulators_history_v1';

const SIMULATORS: SimulatorDefinition[] = [
  {
    id: 'salary-net',
    phase: 'Fase 1',
    title: 'Salário Líquido',
    description: 'Líquido, IRS, Segurança Social, subsídio de alimentação e duodécimos.',
    category: 'Laboral',
  },
  {
    id: 'imt',
    phase: 'Fase 1',
    title: 'IMT',
    description: 'IMT, imposto do selo e custos estimados de aquisição.',
    category: 'Fiscal',
  },
  {
    id: 'act-compensation',
    phase: 'Fase 1',
    title: 'Compensações ACT',
    description: 'Compensação indicativa, férias não gozadas e créditos de formação.',
    category: 'Laboral',
  },
  {
    id: 'ss-independent',
    phase: 'Fase 1',
    title: 'SS Independentes',
    description: 'Contribuições trimestrais de Segurança Social para recibos verdes.',
    category: 'Fiscal',
  },
  {
    id: 'loan',
    phase: 'Fase 1',
    title: 'Empréstimo',
    description: 'Plano de amortização completo com prestações, juros e pagamentos extra.',
    category: 'Financeiro',
  },
  {
    id: 'car-benefit',
    phase: 'Fase 1',
    title: 'Viatura Empresa',
    description: 'Imputação no recibo de vencimento pelo uso pessoal de viatura da empresa.',
    category: 'Laboral',
  },
];

const ROADMAP = [
  'Recibos Verdes / Independentes',
  'IRS',
  'Ajudas de Custo',
  'Viaturas Empresa',
  'Mais-Valias Imobiliárias',
];

async function fetchHistory(): Promise<StoredSimulation[]> {
  try {
    const res = await fetch('/api/simulators/history');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

async function persistSimulation(item: StoredSimulation): Promise<void> {
  const res = await fetch('/api/simulators/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erro ${res.status} ao guardar`);
  }
}

async function deleteSimulation(id: string): Promise<void> {
  await fetch(`/api/simulators/history/${id}`, { method: 'DELETE' });
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(Number(value) || 0);
}

function statusClasses(status: string): string {
  if (status === 'updated') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (status === 'outdated') return 'bg-rose-50 text-rose-700 border-rose-200';
  return 'bg-amber-50 text-amber-700 border-amber-200';
}

function statusLabel(status: string): string {
  if (status === 'updated') return 'Fonte validada';
  if (status === 'outdated') return 'Desatualizado';
  return 'A validar';
}

const Field: React.FC<{
  label: string;
  children: React.ReactNode;
}> = ({ label, children }) => (
  <label className="space-y-1.5">
    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</span>
    {children}
  </label>
);

const inputClass = 'w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none transition focus:border-whatsapp-500 focus:ring-2 focus:ring-whatsapp-100';
const compactInputClass = 'w-full min-w-[110px] rounded-md border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-900 outline-none transition focus:border-whatsapp-500 focus:ring-2 focus:ring-whatsapp-100';

type DuodecimosMode = 'none' | 'holiday' | 'christmas' | 'both';

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getIncomeHoldersLabel(status: SalaryNetInput['maritalStatus']): string {
  if (status === 'married_two_holders') return '2 titulares';
  if (status === 'married_one_holder') return '1 titular';
  return '1 titular';
}

function getHouseholdAdults(status: SalaryNetInput['maritalStatus']): number {
  return status === 'single' ? 1 : 2;
}

function getDuodecimosMode(input: SalaryNetInput): DuodecimosMode {
  if (!input.duodecimos) return 'none';
  if (input.holidayAllowance && input.christmasAllowance) return 'both';
  if (input.holidayAllowance) return 'holiday';
  if (input.christmasAllowance) return 'christmas';
  return 'none';
}

function duodecimosPatch(mode: DuodecimosMode): Pick<SalaryNetInput, 'duodecimos' | 'holidayAllowance' | 'christmasAllowance'> {
  return {
    duodecimos: mode !== 'none',
    holidayAllowance: mode === 'holiday' || mode === 'both',
    christmasAllowance: mode === 'christmas' || mode === 'both',
  };
}

function deriveActReason(input: Pick<ActCompensationInput, 'contractType' | 'endedBy'>): ActCompensationInput['reason'] {
  if (input.contractType === 'fixed_term') return 'fixed_term';
  if (input.endedBy === 'employer') return 'extinction';
  return 'initiative_employer';
}

const defaultSalaryInput: SalaryNetInput = {
  grossSalary: 1200,
  extraPay: 0,
  otherTaxableIncome: 0,
  irsOnlyIncome: 0,
  exemptIncome: 0,
  mealAllowanceDaily: 7.5,
  mealDays: 22,
  mealType: 'card',
  dependents: 0,
  disabledDependents: 0,
  maritalStatus: 'single',
  duodecimos: false,
  holidayAllowance: true,
  christmasAllowance: true,
  youngIrs: false,
  youngIrsYear: 1,
  disability: false,
  region: 'continent',
  socialSecurityRate: 11,
  employerSocialSecurityRate: 23.75,
  workAccidentInsuranceRate: 1.75,
  monthsPerYear: 14,
};

const defaultImtInput: ImtInput = {
  price: 250000,
  propertyType: 'hpp',
  buyerAge: 40,
  includeEstimatedFees: true,
};

const defaultActInput: ActCompensationInput = {
  monthlyBaseSalary: 1200,
  diuturnities: 0,
  complements: 0,
  startDate: '2022-01-01',
  endDate: new Date().toISOString().slice(0, 10),
  contractType: 'indefinite',
  endedBy: 'employer',
  justCause: false,
  reason: 'extinction',
  vacationDaysDue: 22,
  vacationDaysTaken: 0,
  holidayAllowanceReceived: 0,
  proportionalVacationReceived: 0,
  proportionalHolidayReceived: 0,
  proportionalChristmasReceived: 0,
  trainingHoursDue: 20,
};

const defaultSSIndependentInput: SSIndependentInput = {
  activities: defaultSSActivities(),
  isFirstYear: false,
  adjustmentPercent: 0,
};

const Simulators: React.FC = () => {
  const [activeId, setActiveId] = useState<SimulatorId>('salary-net');
  const [customerName, setCustomerName] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [query, setQuery] = useState('');
  const [salaryInput, setSalaryInput] = useState<SalaryNetInput>(defaultSalaryInput);
  const [imtInput, setImtInput] = useState<ImtInput>(defaultImtInput);
  const [actInput, setActInput] = useState<ActCompensationInput>(defaultActInput);
  const [ssInput, setSsInput] = useState<SSIndependentInput>(defaultSSIndependentInput);
  const [loanInput, setLoanInput] = useState<LoanInput>(defaultLoanInput);
  const [loanExpandedYears, setLoanExpandedYears] = useState<Set<number>>(new Set());
  const [carBenefitInput, setCarBenefitInput] = useState<CarBenefitInput>(defaultCarBenefitInput);
  const [euriborLoading, setEuriborLoading] = useState(false);
  const [euriborInfo, setEuriborInfo] = useState<{ period: string; fetchedAt: number } | null>(null);
  const [actEmployeeName, setActEmployeeName] = useState('');
  const [history, setHistory] = useState<StoredSimulation[]>([]);
  const [currentSimId, setCurrentSimId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'ok' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailSending, setEmailSending] = useState(false);
  const [emailOverrideTo, setEmailOverrideTo] = useState('');
  const [showValidation, setShowValidation] = useState(true);
  const [actOfficialValidation, setActOfficialValidation] = useState<ActOfficialValidationResult | null>(null);
  const [actOfficialLoading, setActOfficialLoading] = useState(false);
  const [actOfficialError, setActOfficialError] = useState('');
  const [salaryOfficialValidation, setSalaryOfficialValidation] = useState<SalaryOfficialResult | null>(null);
  const [salaryOfficialLoading, setSalaryOfficialLoading] = useState(false);
  const [salaryOfficialError, setSalaryOfficialError] = useState('');

  useEffect(() => {
    fetchHistory().then(setHistory);
  }, []);

  // Calcular automaticamente os dias de férias vencidas com base nas datas do contrato
  useEffect(() => {
    const start = new Date(actInput.startDate);
    const end = new Date(actInput.endDate);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return;

    // Contar meses em que o trabalhador esteve empregado (mês parcial conta como completo)
    const startYM = start.getFullYear() * 12 + start.getMonth();
    const endYM = end.getFullYear() * 12 + end.getMonth();
    const monthsWorked = endYM - startYM + 1;
    const isSubYear = monthsWorked < 12;

    const days = isSubYear
      ? Math.min(20, monthsWorked * 2)  // 2 dias/mês, máx 20 (1º ano)
      : 22;                              // direito anual completo

    setActInput((prev) => ({
      ...prev,
      vacationDaysDue: days,
      vacationDaysTaken: Math.min(prev.vacationDaysTaken, days),
    }));
  }, [actInput.startDate, actInput.endDate]);

  useEffect(() => {
    let active = true;
    mockService.getCustomers()
      .then((items) => {
        if (active) setCustomers(Array.isArray(items) ? items : []);
      })
      .catch(() => {
        if (active) setCustomers([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const activeDefinition = SIMULATORS.find((item) => item.id === activeId) || SIMULATORS[0];
  const selectedCustomer = customers.find((item) => String(item.id || '') === selectedCustomerId) || null;
  const customerSearchTerm = customerName.trim().toLowerCase();
  const customerMatches = useMemo(() => {
    if (!customerSearchTerm) return customers.slice(0, 8);
    return customers
      .filter((customer) => `${customer.name || ''} ${customer.company || ''} ${customer.nif || ''} ${customer.email || ''}`.toLowerCase().includes(customerSearchTerm))
      .slice(0, 8);
  }, [customerSearchTerm, customers]);

  const result = useMemo<SimulationResult>(() => {
    if (activeId === 'imt') return calculateImt(imtInput);
    if (activeId === 'act-compensation') return calculateActCompensation(actInput);
    if (activeId === 'ss-independent') return calculateSSIndependent(ssInput);
    if (activeId === 'loan') return calculateLoan(loanInput);
    if (activeId === 'car-benefit') return calculateCarBenefit(carBenefitInput);
    return calculateSalaryNet(salaryInput);
  }, [activeId, actInput, carBenefitInput, imtInput, loanInput, salaryInput, ssInput]);

  const loanSchedule = useMemo(
    () => activeId === 'loan' ? computeLoanSchedule(loanInput) : null,
    [activeId, loanInput]
  );
  const loanYears = useMemo(
    () => loanSchedule ? groupByYear(loanSchedule.rows) : [],
    [loanSchedule]
  );

  const filteredHistory = history.filter((item) => {
    const term = query.trim().toLowerCase();
    if (!term) return true;
    return `${item.customerName} ${item.result.title} ${item.result.version.id}`.toLowerCase().includes(term);
  });

  const health = getRuleHealth(result.version);

  const persistResult = async () => {
    setSaveStatus('saving');
    setSaveError('');
    const displayName = selectedCustomer
      ? (selectedCustomer.company || selectedCustomer.name || selectedCustomer.nif || 'Cliente sem nome')
      : customerName.trim();
    const id = currentSimId ?? `sim_${Date.now().toString(36)}`;
    const item: StoredSimulation = {
      id,
      customerName: displayName || 'Sem cliente associado',
      customerId: selectedCustomer?.id,
      customerNif: selectedCustomer?.nif,
      employeeName: actEmployeeName || undefined,
      result,
      actInput:    activeId === 'act-compensation' ? actInput    : undefined,
      salaryInput: activeId === 'salary-net'       ? salaryInput : undefined,
      imtInput:    activeId === 'imt'              ? imtInput    : undefined,
      ssInput:     activeId === 'ss-independent'   ? ssInput     : undefined,
      loanInput:       activeId === 'loan'         ? loanInput       : undefined,
      carBenefitInput: activeId === 'car-benefit'  ? carBenefitInput : undefined,
    };
    try {
      await persistSimulation(item);
      setCurrentSimId(id);
      setHistory((prev) => {
        const filtered = prev.filter((h) => h.id !== id);
        return [item, ...filtered].slice(0, 50);
      });
      setSaveStatus('ok');
      setTimeout(() => setSaveStatus('idle'), 2500);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : 'Erro ao guardar');
    }
  };

  const removeFromHistory = async (id: string) => {
    await deleteSimulation(id);
    setHistory((prev) => prev.filter((h) => h.id !== id));
    if (currentSimId === id) setCurrentSimId(null);
  };

  const loadFromHistory = (item: StoredSimulation) => {
    setActiveId(item.result.simulatorId);
    setCustomerName(item.customerName === 'Sem cliente associado' ? '' : item.customerName);
    setSelectedCustomerId(item.customerId || '');
    setActEmployeeName(item.employeeName || '');
    setCurrentSimId(item.id);
    if (item.actInput)    setActInput(item.actInput);
    if (item.salaryInput) setSalaryInput({ ...defaultSalaryInput, ...item.salaryInput });
    if (item.imtInput)    setImtInput({ ...defaultImtInput, ...item.imtInput });
    if (item.ssInput)     setSsInput({ ...defaultSSIndependentInput, ...item.ssInput, activities: item.ssInput.activities ?? defaultSSActivities() });
    if (item.loanInput)       setLoanInput({ ...defaultLoanInput, ...item.loanInput });
    if (item.carBenefitInput) setCarBenefitInput({ ...defaultCarBenefitInput, ...item.carBenefitInput });
    setSaveStatus('idle');
    setSaveError('');
  };

  const duplicateFromHistory = (item: StoredSimulation) => {
    setActiveId(item.result.simulatorId);
    setCustomerName(item.customerName === 'Sem cliente associado' ? '' : item.customerName);
    setSelectedCustomerId(item.customerId || '');
    setCurrentSimId(null); // novo ID → cria entrada nova
  };

  const exportPdf = async () => {
    try {
      const body = {
        result,
        customer: selectedCustomer || null,
        actValidation: actOfficialValidation || null,
        actInput: activeId === 'act-compensation' ? actInput : null,
        employeeName: actEmployeeName || null,
        generatedAt: new Date().toISOString(),
        loanSchedule: activeId === 'loan' ? loanSchedule : null,
        loanInput: activeId === 'loan' ? loanInput : null,
      };
      const res = await fetch('/api/simulators/export-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Falha ao gerar PDF');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `simulacao-${result.simulatorId}-${Date.now()}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Erro ao gerar PDF: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const fetchEuribor = async (tenor?: '3M' | '6M' | '12M') => {
    setEuriborLoading(true);
    try {
      const res = await fetch('/api/euribor');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Erro ao obter Euribor');
      const t = tenor ?? (loanInput.euriborReviewMonths === 3 ? '3M' : loanInput.euriborReviewMonths === 6 ? '6M' : '12M');
      const entry = data.rates?.[t];
      if (entry?.rate != null) {
        setLoanInput((p: LoanInput) => ({ ...p, euribor: entry.rate }));
        setEuriborInfo({ period: entry.period, fetchedAt: data.fetchedAt });
      }
    } catch (err) {
      alert('Não foi possível obter a Euribor: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setEuriborLoading(false);
    }
  };

  const shareSimulation = async () => {
    const text = `${result.title}\n${result.summary.map((line) => `${line.label}: ${formatCurrency(line.value)}`).join('\n')}\nVersão: ${result.version.id}`;
    await navigator.clipboard?.writeText(text).catch(() => null);
  };

  const sendSimulationEmail = async () => {
    const toEmail = emailOverrideTo.trim() || selectedCustomer?.email || '';
    if (!toEmail) { alert('Sem email do cliente definido.'); return; }
    if (!currentSimId) { alert('Guarda a simulação primeiro antes de enviar.'); return; }
    setEmailSending(true);
    try {
      // gerar PDF em base64
      const currentItem = history.find((h) => h.id === currentSimId);
      const resolvedEmployeeName = actEmployeeName || currentItem?.employeeName || null;
      const pdfPayload = {
        result, customer: selectedCustomer || null,
        actValidation: actOfficialValidation || null,
        actInput: activeId === 'act-compensation' ? actInput : null,
        employeeName: resolvedEmployeeName,
        generatedAt: new Date().toISOString(),
      };
      const pdfRes = await fetch('/api/simulators/export-pdf', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pdfPayload),
      });
      const pdfBlob = await pdfRes.blob();
      const pdfBase64 = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(pdfBlob);
      });

      const res = await fetch('/api/simulators/send-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          simId: currentSimId,
          toEmail,
          toName: selectedCustomer?.company || selectedCustomer?.name || '',
          pdfData: pdfBase64,
          employeeName: resolvedEmployeeName,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Falha ao enviar email');
      setHistory((prev) => prev.map((h) => h.id === currentSimId
        ? { ...h, emailSentTo: toEmail, emailSentAt: data.sentAt } : h));
      setShowEmailModal(false);
      setEmailOverrideTo('');
    } catch (err) {
      alert('Erro ao enviar: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setEmailSending(false);
    }
  };

  const validateSalaryOfficialFn = async () => {
    setSalaryOfficialLoading(true);
    setSalaryOfficialError('');
    setSalaryOfficialValidation(null);
    try {
      const validation = await validateSalaryOfficial(salaryInput);
      setSalaryOfficialValidation(validation);
    } catch (error) {
      setSalaryOfficialError(error instanceof Error ? error.message : 'Falha ao validar no Doutor Finanças.');
    } finally {
      setSalaryOfficialLoading(false);
    }
  };

  const validateActOfficial = async () => {
    setActOfficialLoading(true);
    setActOfficialError('');
    setActOfficialValidation(null);
    try {
      const validation = await validateActCompensationOfficial(actInput);
      setActOfficialValidation(validation);
    } catch (error) {
      setActOfficialError(error instanceof Error ? error.message : 'Falha ao validar no ACT.');
    } finally {
      setActOfficialLoading(false);
    }
  };

  const renderMoneyCell = (value: number, patchKey: keyof EmployeeCostInput, update: (patch: Partial<EmployeeCostInput>) => void, step = '0.01', options?: { max?: number }) => (
    <input
      className={compactInputClass}
      min={0}
      max={options?.max}
      type="number"
      step={step}
      value={Number(value) || 0}
      onChange={(event) => {
        const rawValue = Math.max(0, toNumber(event.target.value));
        const nextValue = typeof options?.max === 'number' ? Math.min(options.max, rawValue) : rawValue;
        update({ [patchKey]: nextValue } as Partial<EmployeeCostInput>);
      }}
    />
  );

  const renderSalaryFields = () => {
    const state = salaryInput;
    const householdAdults = getHouseholdAdults(state.maritalStatus);
    const householdMembers = householdAdults + Math.max(0, Number(state.dependents) || 0);
    const update = (patch: Partial<SalaryNetInput>) => {
      setSalaryInput((prev) => {
          const next = { ...prev, ...patch };
          next.dependents = Math.max(0, Math.round(toNumber(next.dependents)));
          next.disabledDependents = Math.min(next.dependents, Math.max(0, Math.round(toNumber(next.disabledDependents))));
          return next;
        });
    };

    return (
      <div className="space-y-4">
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Dados do agregado</th>
                <th className="px-3 py-2">Localização</th>
                <th className="px-3 py-2">Situação</th>
                <th className="px-3 py-2">Titulares</th>
                <th className="px-3 py-2">Filhos/dep.</th>
                <th className="px-3 py-2">Agregado</th>
                <th className="px-3 py-2">Dep. deficiência</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-slate-200">
                <td className="px-3 py-3 font-semibold text-slate-900">Enquadramento fiscal</td>
                <td className="px-3 py-3">
                  <select className={compactInputClass} value={state.region} onChange={(event) => update({ region: event.target.value as SalaryNetInput['region'] })}>
                    <option value="continent">Continente</option>
                    <option value="azores">Açores</option>
                    <option value="madeira">Madeira</option>
                  </select>
                </td>
                <td className="px-3 py-3">
                  <select className={compactInputClass} value={state.maritalStatus} onChange={(event) => update({ maritalStatus: event.target.value as SalaryNetInput['maritalStatus'] })}>
                    <option value="single">Não casado</option>
                    <option value="married_two_holders">Casado 2 titulares</option>
                    <option value="married_one_holder">Casado 1 titular</option>
                  </select>
                </td>
                <td className="px-3 py-3">
                  <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900">
                    {getIncomeHoldersLabel(state.maritalStatus)}
                  </div>
                </td>
                <td className="px-3 py-3">{renderMoneyCell(state.dependents, 'dependents', update, '1')}</td>
                <td className="px-3 py-3">
                  <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900">
                    {householdMembers} pessoa{householdMembers === 1 ? '' : 's'}
                    <span className="ml-2 text-xs font-normal text-slate-500">({householdAdults} adulto{householdAdults === 1 ? '' : 's'} + {Math.max(0, Number(state.dependents) || 0)} dep.)</span>
                  </div>
                </td>
                <td className="px-3 py-3">{renderMoneyCell(state.disabledDependents, 'disabledDependents', update, '1', { max: Math.max(0, Number(state.dependents) || 0) })}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-slate-900 text-left text-xs uppercase tracking-wide text-white">
              <tr>
                <th className="px-3 py-2">Rendimentos mensais</th>
                <th className="px-3 py-2">Vencimento base</th>
                <th className="px-3 py-2">Retrib. extra</th>
                <th className="px-3 py-2">Suj. IRS+SS</th>
                <th className="px-3 py-2">Suj. só IRS</th>
                <th className="px-3 py-2">Isentos</th>
                <th className="px-3 py-2">Pagamentos/ano</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-slate-200">
                <td className="px-3 py-3 font-semibold text-slate-900">Valores brutos</td>
                <td className="px-3 py-3">{renderMoneyCell(state.grossSalary, 'grossSalary', update)}</td>
                <td className="px-3 py-3">{renderMoneyCell(state.extraPay, 'extraPay', update)}</td>
                <td className="px-3 py-3">{renderMoneyCell(state.otherTaxableIncome, 'otherTaxableIncome', update)}</td>
                <td className="px-3 py-3">{renderMoneyCell(state.irsOnlyIncome, 'irsOnlyIncome', update)}</td>
                <td className="px-3 py-3">{renderMoneyCell(state.exemptIncome, 'exemptIncome', update)}</td>
                <td className="px-3 py-3">{renderMoneyCell(state.monthsPerYear, 'monthsPerYear', update, '1')}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Subsídios e descontos</th>
                <th className="px-3 py-2">Tipo alimentação</th>
                <th className="px-3 py-2">Valor/dia</th>
                <th className="px-3 py-2">Dias</th>
                <th className="px-3 py-2">SS trabalhador %</th>
                <th className="px-3 py-2">SS empresa %</th>
                <th className="px-3 py-2">Duodécimos</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-slate-200">
                <td className="px-3 py-3 font-semibold text-slate-900">Parâmetros</td>
                <td className="px-3 py-3">
                  <select className={compactInputClass} value={state.mealType} onChange={(event) => update({ mealType: event.target.value as SalaryNetInput['mealType'] })}>
                    <option value="card">Cartão / vale</option>
                    <option value="cash">Dinheiro</option>
                  </select>
                </td>
                <td className="px-3 py-3">{renderMoneyCell(state.mealAllowanceDaily, 'mealAllowanceDaily', update)}</td>
                <td className="px-3 py-3">{renderMoneyCell(state.mealDays, 'mealDays', update, '1')}</td>
                <td className="px-3 py-3">{renderMoneyCell(state.socialSecurityRate, 'socialSecurityRate', update)}</td>
                <td className="px-3 py-3">{renderMoneyCell(state.employerSocialSecurityRate, 'employerSocialSecurityRate', update)}</td>
                <td className="px-3 py-3">
                  <select className={compactInputClass} value={getDuodecimosMode(state)} onChange={(event) => update(duodecimosPatch(event.target.value as DuodecimosMode))}>
                    <option value="none">Não recebe</option>
                    <option value="both">Férias e Natal</option>
                    <option value="holiday">Só férias</option>
                    <option value="christmas">Só Natal</option>
                  </select>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(state.youngIrs)}
                onChange={(event) => update({ youngIrs: event.target.checked })}
              />
              IRS Jovem
            </label>
            {state.youngIrs && (
              <div className="mt-2">
                <label className="block text-xs font-medium text-slate-500 mb-1">Ano de trabalho (1-10)</label>
                <select
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  value={state.youngIrsYear ?? 1}
                  onChange={(e) => update({ youngIrsYear: Number(e.target.value) })}
                >
                  {[1,2,3,4,5,6,7,8,9,10].map((y) => (
                    <option key={y} value={y}>
                      {y}º ano — {y===1?'100%':y===2?'75%':y<=4?'50%':'25%'} isento
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={Boolean(state.disability)}
              onChange={(event) => update({ disability: event.target.checked })}
            />
            Deficiência
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Taxa SS Trabalhador (%)">
            <input className={inputClass} type="number" step="0.01" value={state.socialSecurityRate ?? 11} onChange={(e) => update({ socialSecurityRate: Number(e.target.value) })} />
          </Field>
          <Field label="Seguro Acidentes Trabalho (%)">
            <input className={inputClass} type="number" step="0.01" min="0" max="10" value={state.workAccidentInsuranceRate ?? 1.75} onChange={(e) => update({ workAccidentInsuranceRate: Number(e.target.value) })} />
          </Field>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-full bg-[radial-gradient(circle_at_top_left,#e6f7ef_0,#f3f6fa_34%,#e9eef5_100%)]">
      <div className="border-b border-emerald-100 bg-white/90 shadow-sm backdrop-blur">
        <div className="w-full px-4 py-6 md:px-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-sm font-semibold text-whatsapp-700">
                <ShieldCheck size={16} />
                MPR Negócios · Centro de simulação
              </div>
              <h1 className="mt-3 text-3xl font-black tracking-tight text-slate-950 md:text-4xl">Simuladores</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 md:text-base">
                Ferramentas empresariais com cálculo interno, fontes oficiais visíveis, pressupostos versionados e histórico por cliente.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Fase 1</div>
                <div className="mt-1 text-xl font-black text-slate-950">4</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Fontes</div>
                <div className="mt-1 text-xl font-black text-slate-950">{result.version.sources.length}</div>
              </div>
              <div className={`rounded-lg border px-4 py-3 shadow-sm ${statusClasses(health.status)}`}>
                <div className="text-[11px] font-bold uppercase tracking-wide">Estado</div>
                <div className="mt-1 flex items-center gap-1 text-sm font-black">
                  {health.status === 'updated' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                  {health.label}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid w-full grid-cols-1 gap-5 px-4 py-6 md:px-6 2xl:grid-cols-[280px_minmax(0,1fr)_330px]">
        <aside className="space-y-3 2xl:sticky 2xl:top-4 2xl:self-start">
          {SIMULATORS.map((item) => {
            const version = RULE_VERSIONS[item.id];
            const itemHealth = getRuleHealth(version);
            const active = item.id === activeId;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setActiveId(item.id);
                  setShowValidation(false);
                  setCurrentSimId(null);
                }}
                className={`w-full rounded-lg border p-3 text-left transition ${
                  active ? 'border-whatsapp-300 bg-white shadow-sm ring-2 ring-whatsapp-100' : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{item.phase} · {item.category}</div>
                    <div className="mt-1 font-semibold text-slate-950">{item.title}</div>
                  </div>
                  <Calculator size={18} className={active ? 'text-whatsapp-700' : 'text-slate-400'} />
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-500">{item.description}</p>
                <span className={`mt-3 inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${statusClasses(itemHealth.status)}`}>
                  {itemHealth.label}
                </span>
              </button>
            );
          })}
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Roadmap</div>
            <div className="mt-2 space-y-2">
              {ROADMAP.map((item) => (
                <div key={item} className="flex items-center gap-2 text-sm text-slate-600">
                  <Clock3 size={14} className="text-slate-400" />
                  {item}
                </div>
              ))}
            </div>
          </div>
        </aside>

        <section className="min-w-0 space-y-5">
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="text-sm font-semibold text-whatsapp-700">{activeDefinition.category}</div>
                <h2 className="mt-1 text-xl font-bold text-slate-950">{activeDefinition.title}</h2>
                <p className="mt-1 text-sm text-slate-600">{activeDefinition.description}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={persistResult}
                  disabled={saveStatus === 'saving'}
                  className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-60 ${saveStatus === 'ok' ? 'bg-emerald-600 hover:bg-emerald-700' : saveStatus === 'error' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-whatsapp-600 hover:bg-whatsapp-700'}`}
                  title={saveStatus === 'error' ? saveError : undefined}
                >
                  <History size={16} />
                  {saveStatus === 'saving' ? 'A guardar…' : saveStatus === 'ok' ? '✓ Guardado' : saveStatus === 'error' ? '✗ Erro' : 'Guardar'}
                </button>
                {activeId === 'act-compensation' && (
                  <button
                    onClick={validateActOfficial}
                    disabled={actOfficialLoading}
                    className="inline-flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 shadow-sm hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <ShieldCheck size={16} />
                    {actOfficialLoading ? 'A validar ACT...' : 'Validar no ACT'}
                  </button>
                )}
                {(activeId === 'salary-net' || activeId === 'employee-cost') && (
                  <button
                    disabled
                    title="Validacao automatica temporariamente indisponivel"
                    className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-400 shadow-sm cursor-not-allowed opacity-50"
                  >
                    <ShieldCheck size={16} />
                    Validar no Doutor Finanças
                  </button>
                )}
                <button onClick={exportPdf} className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50" title="Exportar PDF">
                  <Download size={16} />
                </button>
                <button onClick={shareSimulation} className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50" title="Partilhar">
                  <Share2 size={16} />
                </button>
                <button onClick={() => { setEmailOverrideTo(selectedCustomer?.email || ''); setShowEmailModal(true); }} className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50" title="Enviar por email">
                  <Mail size={16} />
                </button>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
              <Field label="Associar a cliente">
                <div className="relative">
                  <input
                    className={inputClass}
                    value={customerName}
                    onChange={(event) => {
                      setCustomerName(event.target.value);
                      setSelectedCustomerId('');
                    }}
                    placeholder="Nome, empresa, NIF ou email"
                  />
                  {customerName && !selectedCustomerId && customerMatches.length > 0 && (
                    <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                      {customerMatches.map((customer) => (
                        <button
                          key={customer.id}
                          type="button"
                          onClick={() => {
                            setSelectedCustomerId(customer.id);
                            setCustomerName(customer.company || customer.name || customer.nif || '');
                          }}
                          className="block w-full border-b border-slate-100 px-3 py-2 text-left text-sm hover:bg-emerald-50"
                        >
                          <span className="font-semibold text-slate-950">{customer.company || customer.name || 'Cliente sem nome'}</span>
                          <span className="ml-2 text-xs text-slate-500">{customer.nif || 'sem NIF'}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Field>
              <div className="flex items-end">
                <button
                  onClick={() => setShowValidation((prev) => !prev)}
                  className="inline-flex h-[38px] w-full items-center justify-center gap-2 rounded-md border border-slate-200 bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  <BadgeCheck size={16} />
                  Ver validação
                </button>
              </div>
            </div>
            {selectedCustomer && (
              <div className="mt-3 overflow-x-auto rounded-lg border border-emerald-200 bg-emerald-50/60">
                <table className="w-full text-sm">
                  <tbody>
                    <tr className="divide-x divide-emerald-200">
                      <td className="px-3 py-2"><span className="font-semibold text-emerald-900">Cliente</span><div>{selectedCustomer.company || selectedCustomer.name}</div></td>
                      <td className="px-3 py-2"><span className="font-semibold text-emerald-900">NIF</span><div>{selectedCustomer.nif || '-'}</div></td>
                      <td className="px-3 py-2"><span className="font-semibold text-emerald-900">Email</span><div>{selectedCustomer.email || '-'}</div></td>
                      <td className="px-3 py-2"><span className="font-semibold text-emerald-900">Tipo</span><div>{selectedCustomer.type || '-'}</div></td>
                      {(activeId === 'salary-net' || activeId === 'act-compensation') && (
                        <td className="px-3 py-2">
                          <span className="font-semibold text-emerald-900">Funcionário</span>
                          <input
                            type="text"
                            placeholder="Nome do funcionário"
                            value={actEmployeeName}
                            onChange={(e) => setActEmployeeName(e.target.value)}
                            className="mt-0.5 w-full rounded border border-emerald-200 bg-white px-2 py-1 text-sm text-slate-900 outline-none focus:border-emerald-400"
                          />
                        </td>
                      )}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-5">
              {activeId === 'salary-net' && renderSalaryFields()}
              {activeId === 'imt' && (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                  <Field label="Valor aquisição">
                    <input className={inputClass} type="number" value={imtInput.price} onChange={(event) => setImtInput((prev) => ({ ...prev, price: Number(event.target.value) }))} />
                  </Field>
                  <Field label="Tipo imóvel">
                    <select className={inputClass} value={imtInput.propertyType} onChange={(event) => setImtInput((prev) => ({ ...prev, propertyType: event.target.value as ImtInput['propertyType'] }))}>
                      <option value="hpp">Habitação própria permanente</option>
                      <option value="secondary">Habitação secundária</option>
                      <option value="rustic">Rústico</option>
                    </select>
                  </Field>
                  <Field label="Idade comprador">
                    <input className={inputClass} type="number" value={imtInput.buyerAge} onChange={(event) => setImtInput((prev) => ({ ...prev, buyerAge: Number(event.target.value) }))} />
                  </Field>
                  <label className="flex items-end gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                    <input type="checkbox" checked={imtInput.includeEstimatedFees} onChange={(event) => setImtInput((prev) => ({ ...prev, includeEstimatedFees: event.target.checked }))} />
                    Incluir escritura e registos
                  </label>
                </div>
              )}
              {activeId === 'ss-independent' && (
                <div className="space-y-3">
                  {/* Linhas de rendimento */}
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-900 text-left text-xs uppercase tracking-wide text-white">
                        <tr>
                          <th className="px-3 py-2">Descrição</th>
                          <th className="px-3 py-2">Tipo</th>
                          <th className="px-3 py-2">Rendimento bruto anual</th>
                          <th className="px-3 py-2 text-right">Coeficiente</th>
                          <th className="px-3 py-2 text-right">Relevante</th>
                          <th className="px-3 py-2 w-8"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(ssInput.activities ?? []).map((act, idx) => {
                          const rate = act.type === 'sales' ? 0.20 : 0.70;
                          const relevant = Math.round(act.annualAmount * rate * 100) / 100;
                          return (
                            <tr key={act.id} className="border-t border-slate-100">
                              <td className="px-3 py-2">
                                <input
                                  className={compactInputClass}
                                  type="text"
                                  placeholder="Ex: Consultoria, Vendas..."
                                  value={act.label ?? ''}
                                  onChange={(e) => setSsInput((p) => ({ ...p, activities: p.activities.map((a, i) => i === idx ? { ...a, label: e.target.value } : a) }))}
                                />
                              </td>
                              <td className="px-3 py-2">
                                <select className={compactInputClass} value={act.type}
                                  onChange={(e) => setSsInput((p) => ({ ...p, activities: p.activities.map((a, i) => i === idx ? { ...a, type: e.target.value as SSActivityLine['type'] } : a) }))}>
                                  <option value="services">Serviços (70%)</option>
                                  <option value="sales">Vendas (20%)</option>
                                </select>
                              </td>
                              <td className="px-3 py-2">
                                <input className={compactInputClass} type="number" min={0} value={act.annualAmount}
                                  onChange={(e) => setSsInput((p) => ({ ...p, activities: p.activities.map((a, i) => i === idx ? { ...a, annualAmount: Math.max(0, Number(e.target.value)) } : a) }))} />
                              </td>
                              <td className="px-3 py-2 text-right text-slate-500 font-mono text-xs">{(rate * 100).toFixed(0)}%</td>
                              <td className="px-3 py-2 text-right font-semibold text-slate-700">{relevant.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                              <td className="px-3 py-2 text-center">
                                {(ssInput.activities ?? []).length > 1 && (
                                  <button type="button" className="text-slate-300 hover:text-red-400 transition-colors text-base leading-none"
                                    onClick={() => setSsInput((p) => ({ ...p, activities: p.activities.filter((_, i) => i !== idx) }))}>×</button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Adicionar linha + opções globais */}
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <button type="button"
                      className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition-colors"
                      onClick={() => setSsInput((p) => ({ ...p, activities: [...(p.activities ?? []), { id: `act_${Date.now()}`, type: 'services', label: '', annualAmount: 0 }] }))}>
                      + Adicionar fonte de rendimento
                    </button>
                    <div className="flex items-center gap-4 flex-wrap">
                      <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer select-none">
                        <input type="checkbox" checked={ssInput.isFirstYear}
                          onChange={(e) => setSsInput((p) => ({ ...p, isFirstYear: e.target.checked }))} />
                        Isento — 1.º ano de atividade
                      </label>
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <span className="whitespace-nowrap">Ajuste voluntário</span>
                        <input className="w-20 rounded border border-slate-200 px-2 py-1 text-right text-sm" type="number"
                          min={-25} max={25} value={ssInput.adjustmentPercent}
                          onChange={(e) => setSsInput((p) => ({ ...p, adjustmentPercent: Math.max(-25, Math.min(25, Number(e.target.value))) }))} />
                        <span className="text-slate-400">% (−25 a +25)</span>
                      </div>
                    </div>
                  </div>

                  {/* Alerta de escalão inferior (calculado a partir do result) */}
                  {(() => {
                    const w = result.warnings?.find((ww) => ww.includes('escalão'));
                    return w ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                        <span className="font-semibold">Oportunidade de redução: </span>{w}
                      </div>
                    ) : null;
                  })()}
                </div>
              )}
              {activeId === 'loan' && (
                <div className="space-y-3">
                  {/* ── Inputs linha 1: montante + taxa ── */}
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-7">
                    <div className="md:col-span-2">
                      <Field label="Valor do empréstimo (€)">
                        <input className={inputClass} type="number" min={0} step={1000}
                          value={loanInput.loanAmount}
                          onChange={(e) => setLoanInput((p) => ({ ...p, loanAmount: Math.max(0, Number(e.target.value)) }))} />
                      </Field>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-600 mb-1">
                        Euribor (%)
                        {euriborInfo && (
                          <span className="ml-1.5 text-[10px] font-normal text-slate-400">
                            {euriborInfo.period} · {new Date(euriborInfo.fetchedAt).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </label>
                      <div className="flex gap-1">
                        <input className={inputClass + ' flex-1'} type="number" min={-5} max={20} step={0.001}
                          value={loanInput.euribor}
                          onChange={(e) => setLoanInput((p: LoanInput) => ({ ...p, euribor: Number(e.target.value) }))} />
                        <button type="button" title="Obter Euribor atual (ECB)"
                          className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-slate-500 hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-700 transition-colors disabled:opacity-40"
                          disabled={euriborLoading}
                          onClick={() => fetchEuribor()}>
                          <RefreshCw size={13} className={euriborLoading ? 'animate-spin' : ''} />
                        </button>
                      </div>
                    </div>
                    <Field label="Spread (%)">
                      <input className={inputClass} type="number" min={0} max={10} step={0.001}
                        value={loanInput.spread}
                        onChange={(e) => setLoanInput((p) => ({ ...p, spread: Math.max(0, Number(e.target.value)) }))} />
                    </Field>
                    <Field label={<span className="flex items-center gap-1">TAN <span className="text-emerald-600 font-bold">{((loanInput.euribor || 0) + (loanInput.spread || 0)).toFixed(3)}%</span></span>}>
                      <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm font-semibold">
                        {(['fixed', 'variable'] as const).map((t) => (
                          <button key={t} type="button"
                            className={`flex-1 py-2 transition-colors ${loanInput.rateType === t ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                            onClick={() => setLoanInput((p) => ({ ...p, rateType: t }))}>
                            {t === 'fixed' ? 'Fixa' : 'Variável'}
                          </button>
                        ))}
                      </div>
                    </Field>
                    {loanInput.rateType === 'variable' && (
                      <Field label="Revisão Euribor">
                        <select className={inputClass} value={loanInput.euriborReviewMonths}
                          onChange={(e) => setLoanInput((p) => ({ ...p, euriborReviewMonths: Number(e.target.value) as 6 | 12 }))}>
                          <option value={6}>6 meses</option>
                          <option value={12}>12 meses</option>
                        </select>
                      </Field>
                    )}
                    <Field label="Prazo (anos)">
                      <input className={inputClass} type="number" min={1} max={30} step={1}
                        value={loanInput.termYears}
                        onChange={(e) => setLoanInput((p) => ({ ...p, termYears: Math.min(30, Math.max(1, Number(e.target.value))) }))} />
                    </Field>
                  </div>
                  {/* ── Inputs linha 2: data + extra ── */}
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <Field label="Data de início">
                      <input className={inputClass} type="date"
                        value={loanInput.startDate}
                        onChange={(e) => setLoanInput((p) => ({ ...p, startDate: e.target.value }))} />
                    </Field>
                    <Field label="Pagamento extra/mês (€)">
                      <input className={inputClass} type="number" min={0} step={50}
                        value={loanInput.extraPaymentMonthly}
                        onChange={(e) => setLoanInput((p) => ({ ...p, extraPaymentMonthly: Math.max(0, Number(e.target.value)) }))} />
                    </Field>
                  </div>

                  {/* ── Poupança com extra payments ── */}
                  {loanSchedule && loanSchedule.interestSaved > 0 && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800 flex items-center gap-3 flex-wrap">
                      <span className="font-semibold">Com pagamentos extra:</span>
                      <span>poupa <strong>{loanSchedule.interestSaved.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</strong> em juros</span>
                      <span className="text-emerald-400">·</span>
                      <span>termina <strong>{loanSchedule.numScheduledPayments - loanSchedule.numActualPayments} meses</strong> mais cedo</span>
                    </div>
                  )}

                  {/* ── Tabela de amortização por ano (expansível) ── */}
                  {loanSchedule && loanSchedule.rows.length > 0 && (
                    <div className="rounded-lg border border-slate-200 overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-900 text-white text-left uppercase tracking-wide">
                          <tr>
                            <th className="px-3 py-2">Ano</th>
                            <th className="px-3 py-2 text-right">Capital início</th>
                            <th className="px-3 py-2 text-right">Total pago</th>
                            <th className="px-3 py-2 text-right">Amortização</th>
                            <th className="px-3 py-2 text-right">Juros</th>
                            <th className="px-3 py-2 text-right">Extra</th>
                            <th className="px-3 py-2 text-right">Saldo final</th>
                            <th className="px-2 py-2 w-7"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {loanYears.map((yr: LoanYearSummary) => {
                            const isOpen = loanExpandedYears.has(yr.year);
                            return (
                              <React.Fragment key={yr.year}>
                                <tr
                                  className="border-t border-slate-200 bg-slate-50 cursor-pointer hover:bg-slate-100 font-semibold"
                                  onClick={() => setLoanExpandedYears((prev) => {
                                    const next = new Set(prev);
                                    isOpen ? next.delete(yr.year) : next.add(yr.year);
                                    return next;
                                  })}
                                >
                                  <td className="px-3 py-2 text-slate-700">{yr.year}</td>
                                  <td className="px-3 py-2 text-right text-slate-500">{yr.rows[0].beginBalance.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                                  <td className="px-3 py-2 text-right">{yr.totalPaid.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                                  <td className="px-3 py-2 text-right text-emerald-700">{yr.totalPrincipal.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                                  <td className="px-3 py-2 text-right text-rose-600">{yr.totalInterest.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                                  <td className="px-3 py-2 text-right text-blue-600">{yr.totalExtra > 0 ? yr.totalExtra.toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €' : '—'}</td>
                                  <td className="px-3 py-2 text-right font-bold text-slate-800">{yr.endBalance.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                                  <td className="px-2 py-2 text-center text-slate-400 text-[10px]">{isOpen ? '▲' : '▼'}</td>
                                </tr>
                                {isOpen && yr.rows.map((row: LoanRow) => (
                                  <tr key={row.num} className="border-t border-slate-100 bg-white">
                                    <td className="pl-7 pr-3 py-1.5 text-slate-400">#{row.num}</td>
                                    <td className="px-3 py-1.5 text-right text-slate-400">{row.date}</td>
                                    <td className="px-3 py-1.5 text-right text-slate-600">{row.total.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                                    <td className="px-3 py-1.5 text-right text-emerald-600">{row.principal.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                                    <td className="px-3 py-1.5 text-right text-rose-500">{row.interest.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                                    <td className="px-3 py-1.5 text-right text-blue-500">{row.extra > 0 ? row.extra.toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €' : '—'}</td>
                                    <td className="px-3 py-1.5 text-right text-slate-700">{row.endBalance.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                                    <td></td>
                                  </tr>
                                ))}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                        <tfoot className="bg-slate-800 text-white font-bold text-xs">
                          <tr>
                            <td className="px-3 py-2" colSpan={2}>Total</td>
                            <td className="px-3 py-2 text-right">{loanSchedule.totalPaid.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                            <td className="px-3 py-2 text-right text-emerald-300">{loanInput.loanAmount.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                            <td className="px-3 py-2 text-right text-rose-300">{loanSchedule.totalInterest.toLocaleString('pt-PT', { minimumFractionDigits: 2 })} €</td>
                            <td className="px-3 py-2 text-right text-blue-300">{loanSchedule.totalExtraPayments > 0 ? loanSchedule.totalExtraPayments.toLocaleString('pt-PT', { minimumFractionDigits: 2 }) + ' €' : '—'}</td>
                            <td className="px-3 py-2 text-right">0,00 €</td>
                            <td></td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* ── VIATURA DA EMPRESA ──────────────────────────────────── */}
              {activeId === 'car-benefit' && (() => {
                const cb = carBenefitInput;
                const set = (patch: Partial<CarBenefitInput>) => setCarBenefitInput(p => ({ ...p, ...patch }));
                return (
                <div className="space-y-4">
                  {/* Tipo de viatura */}
                  <div className="flex gap-2">
                    {([['ice','Combustão','🔥'],['hybrid','Híbrido Plug-In','⚡🔥'],['electric','Elétrico','⚡']] as const).map(([v,label,icon]) => (
                      <button key={v} type="button"
                        className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${cb.vehicleType === v ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}
                        onClick={() => set({ vehicleType: v })}>
                        {icon} {label}
                      </button>
                    ))}
                  </div>

                  {/* Linha 1: nome + aquisição */}
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <div className="md:col-span-2">
                      <Field label="Modelo / Descrição da viatura">
                        <input className={inputClass} type="text" placeholder="Ex: Volkswagen Passat 2.0 TDI"
                          value={cb.vehicleName}
                          onChange={e => set({ vehicleName: e.target.value })} />
                      </Field>
                    </div>
                    <Field label="Forma de aquisição">
                      <div className="flex rounded-lg border border-slate-200 overflow-hidden text-sm font-semibold">
                        {([['purchase','Compra própria'],['lease','Renting / ALD']] as const).map(([v,label]) => (
                          <button key={v} type="button"
                            className={`flex-1 py-2 transition-colors ${cb.acquisitionMode === v ? 'bg-slate-800 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                            onClick={() => set({ acquisitionMode: v })}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </Field>
                    {cb.acquisitionMode === 'purchase' ? (
                      <Field label="Valor aquisição c/ IVA (€)">
                        <input className={inputClass} type="number" min={0} step={500}
                          value={cb.acquisitionValue}
                          onChange={e => set({ acquisitionValue: Math.max(0, Number(e.target.value)) })} />
                      </Field>
                    ) : (
                      <Field label="Custo mensal locação (€)">
                        <input className={inputClass} type="number" min={0} step={50}
                          value={cb.monthlyLeaseCost}
                          onChange={e => set({ monthlyLeaseCost: Math.max(0, Number(e.target.value)) })} />
                      </Field>
                    )}
                  </div>

                  {/* Linha 2: contribuição + IRS + meses + SS */}
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                    <Field label="Contribuição mensal trabalhador (€)">
                      <input className={inputClass} type="number" min={0} step={10}
                        value={cb.employeeContribution}
                        onChange={e => set({ employeeContribution: Math.max(0, Number(e.target.value)) })} />
                    </Field>
                    <Field label="Taxa retenção IRS (%)">
                      <input className={inputClass} type="number" min={0} max={60} step={0.5}
                        value={cb.irsRetentionRate}
                        onChange={e => set({ irsRetentionRate: Math.max(0, Number(e.target.value)) })} />
                    </Field>
                    <Field label="Meses no ano">
                      <input className={inputClass} type="number" min={1} max={12}
                        value={cb.monthsAssigned}
                        onChange={e => set({ monthsAssigned: Math.min(12, Math.max(1, Number(e.target.value))) })} />
                    </Field>
                    <Field label="SS trabalhador (%)">
                      <input className={inputClass} type="number" min={0} max={15} step={0.01}
                        value={cb.socialSecurityRate}
                        onChange={e => set({ socialSecurityRate: Math.max(0, Number(e.target.value)) })} />
                    </Field>
                    <div className="flex flex-col justify-end">
                      <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 cursor-pointer select-none h-[38px]">
                        <input type="checkbox" checked={cb.continuousAssignment}
                          onChange={e => set({ continuousAssignment: e.target.checked })} />
                        Atribuição contínua (SS)
                      </label>
                    </div>
                  </div>

                  {/* Info box para elétrico isento */}
                  {cb.vehicleType === 'electric' && cb.acquisitionMode === 'purchase' && cb.acquisitionValue <= 62500 && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                      <span className="font-semibold">⚡ Viatura elétrica isenta</span> — valor de aquisição ≤ 62.500 € → imputação = 0 € (CIRS art.º 2.º, n.º 3, b))
                    </div>
                  )}
                  {cb.vehicleType === 'electric' && cb.acquisitionMode === 'purchase' && cb.acquisitionValue > 62500 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      <span className="font-semibold">⚡ Viatura elétrica parcialmente tributada</span> — apenas o valor acima de 62.500 € é sujeito a imputação (taxa reduzida 0,375%/mês)
                    </div>
                  )}
                </div>
                );
              })()}

              {activeId === 'act-compensation' && (
                <div className="space-y-4">
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full min-w-[920px] text-sm">
                      <thead className="bg-slate-900 text-left text-xs uppercase tracking-wide text-white">
                        <tr>
                          <th className="px-3 py-2">Contrato</th>
                          <th className="px-3 py-2">Tipo</th>
                          <th className="px-3 py-2">Cessado por</th>
                          <th className="px-3 py-2">Justa causa</th>
                          <th className="px-3 py-2">Início</th>
                          <th className="px-3 py-2">Fim</th>
                          <th className="px-3 py-2">Enquadramento</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-t border-slate-200">
                          <td className="px-3 py-3 font-semibold text-slate-900">Cessação</td>
                          <td className="px-3 py-3">
                            <select
                              className={compactInputClass}
                              value={actInput.contractType}
                              onChange={(event) => {
                                const contractType = event.target.value as ActCompensationInput['contractType'];
                                setActInput((prev) => {
                                  const next = { ...prev, contractType };
                                  return { ...next, reason: deriveActReason(next) };
                                });
                              }}
                            >
                              <option value="indefinite">Sem termo</option>
                              <option value="fixed_term">Termo certo/incerto</option>
                            </select>
                          </td>
                          <td className="px-3 py-3">
                            <select
                              className={compactInputClass}
                              value={actInput.endedBy}
                              onChange={(event) => {
                                const endedBy = event.target.value as ActCompensationInput['endedBy'];
                                setActInput((prev) => {
                                  const next = { ...prev, endedBy };
                                  return { ...next, reason: deriveActReason(next) };
                                });
                              }}
                            >
                              <option value="employer">Empregador</option>
                              <option value="worker">Trabalhador</option>
                            </select>
                          </td>
                          <td className="px-3 py-3">
                            <label className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2">
                              <input type="checkbox" checked={actInput.justCause} onChange={(event) => setActInput((prev) => ({ ...prev, justCause: event.target.checked }))} />
                              Sim
                            </label>
                          </td>
                          <td className="px-3 py-3"><input className={compactInputClass} type="date" value={actInput.startDate} onChange={(event) => setActInput((prev) => ({ ...prev, startDate: event.target.value }))} /></td>
                          <td className="px-3 py-3"><input className={compactInputClass} type="date" value={actInput.endDate} onChange={(event) => setActInput((prev) => ({ ...prev, endDate: event.target.value }))} /></td>
                          <td className="px-3 py-3">
                            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900">
                              {actInput.contractType === 'fixed_term'
                                ? 'Caducidade de contrato a termo'
                                : actInput.endedBy === 'employer'
                                  ? 'Cessação por iniciativa do empregador'
                                  : 'Cessação por iniciativa do trabalhador'}
                            </div>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full min-w-[860px] text-sm">
                      <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-3 py-2">Retribuição</th>
                          <th className="px-3 py-2">Base</th>
                          <th className="px-3 py-2">Diuturnidades</th>
                          <th className="px-3 py-2">Complementos</th>
                          <th className="px-3 py-2">Formação em falta</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-t border-slate-200">
                          <td className="px-3 py-3 font-semibold text-slate-900">Mensal</td>
                          <td className="px-3 py-3"><input className={compactInputClass} min={0} type="number" value={actInput.monthlyBaseSalary} onChange={(event) => setActInput((prev) => ({ ...prev, monthlyBaseSalary: Math.max(0, toNumber(event.target.value)) }))} /></td>
                          <td className="px-3 py-3"><input className={compactInputClass} min={0} type="number" value={actInput.diuturnities} onChange={(event) => setActInput((prev) => ({ ...prev, diuturnities: Math.max(0, toNumber(event.target.value)) }))} /></td>
                          <td className="px-3 py-3"><input className={compactInputClass} min={0} type="number" value={actInput.complements} onChange={(event) => setActInput((prev) => ({ ...prev, complements: Math.max(0, toNumber(event.target.value)) }))} /></td>
                          <td className="px-3 py-3"><input className={compactInputClass} min={0} type="number" value={actInput.trainingHoursDue} onChange={(event) => setActInput((prev) => ({ ...prev, trainingHoursDue: Math.max(0, toNumber(event.target.value)) }))} /></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full min-w-[980px] text-sm">
                      <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-3 py-2">Férias e proporcionais</th>
                          <th className="px-3 py-2">Férias vencidas</th>
                          <th className="px-3 py-2">Já gozadas</th>
                          <th className="px-3 py-2">Sub. férias já recebido</th>
                          <th className="px-3 py-2">Prop. férias recebido</th>
                          <th className="px-3 py-2">Prop. sub. férias recebido</th>
                          <th className="px-3 py-2">Prop. Natal recebido</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="border-t border-slate-200">
                          <td className="px-3 py-3 font-semibold text-slate-900">Abatimentos</td>
                          <td className="px-3 py-3"><input className={compactInputClass} min={0} type="number" value={actInput.vacationDaysDue} onChange={(event) => setActInput((prev) => {
                            const vacationDaysDue = Math.max(0, toNumber(event.target.value));
                            return { ...prev, vacationDaysDue, vacationDaysTaken: Math.min(prev.vacationDaysTaken, vacationDaysDue) };
                          })} /></td>
                          <td className="px-3 py-3"><input className={compactInputClass} min={0} max={actInput.vacationDaysDue} type="number" value={actInput.vacationDaysTaken} onChange={(event) => setActInput((prev) => ({ ...prev, vacationDaysTaken: Math.min(prev.vacationDaysDue, Math.max(0, toNumber(event.target.value))) }))} /></td>
                          <td className="px-3 py-3"><input className={compactInputClass} min={0} type="number" value={actInput.holidayAllowanceReceived} onChange={(event) => setActInput((prev) => ({ ...prev, holidayAllowanceReceived: Math.max(0, toNumber(event.target.value)) }))} /></td>
                          <td className="px-3 py-3"><input className={compactInputClass} min={0} type="number" value={actInput.proportionalVacationReceived} onChange={(event) => setActInput((prev) => ({ ...prev, proportionalVacationReceived: Math.max(0, toNumber(event.target.value)) }))} /></td>
                          <td className="px-3 py-3"><input className={compactInputClass} min={0} type="number" value={actInput.proportionalHolidayReceived} onChange={(event) => setActInput((prev) => ({ ...prev, proportionalHolidayReceived: Math.max(0, toNumber(event.target.value)) }))} /></td>
                          <td className="px-3 py-3"><input className={compactInputClass} min={0} type="number" value={actInput.proportionalChristmasReceived} onChange={(event) => setActInput((prev) => ({ ...prev, proportionalChristmasReceived: Math.max(0, toNumber(event.target.value)) }))} /></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  {(actOfficialValidation?.results || actOfficialError) && (
                    <div className={`rounded-lg border p-4 text-sm ${actOfficialError ? 'border-amber-200 bg-amber-50 text-amber-950' : 'border-emerald-200 bg-emerald-50 text-emerald-950'}`}>
                      <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
                        <div>
                          <div className="font-bold">{actOfficialError ? 'Validação ACT indisponível' : 'Resultado oficial ACT'}</div>
                          <p className="mt-1">
                            {actOfficialError || `Lido em ${actOfficialValidation?.computedAt ? new Date(actOfficialValidation.computedAt).toLocaleString('pt-PT') : 'agora'}.`}
                          </p>
                        </div>
                        {actOfficialValidation?.sourceUrl && (
                          <a href={actOfficialValidation.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-emerald-800">
                            Abrir ACT <ExternalLink size={13} />
                          </a>
                        )}
                      </div>
                      {actOfficialValidation?.results && (
                        <div className="mt-3 overflow-x-auto rounded-md border border-emerald-200 bg-white">
                          <table className="w-full text-sm">
                            <tbody className="divide-y divide-emerald-100">
                              {[
                                ['Compensação', actOfficialValidation.results.compensation],
                                ['Férias', actOfficialValidation.results.vacation],
                                ['Subsídio de férias', actOfficialValidation.results.holidayAllowance],
                                ['Proporcional férias', actOfficialValidation.results.proportionalVacation],
                                ['Proporcional subsídio férias', actOfficialValidation.results.proportionalHolidayAllowance],
                                ['Proporcional subsídio Natal', actOfficialValidation.results.proportionalChristmasAllowance],
                                ['Montante global ACT', actOfficialValidation.results.total],
                              ].map(([label, value]) => (
                                <tr key={String(label)}>
                                  <td className="px-3 py-2 font-medium text-slate-600">{label}</td>
                                  <td className="px-3 py-2 text-right font-bold text-slate-950">{typeof value === 'number' ? formatCurrency(value) : '-'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {(activeId === 'salary-net' || activeId === 'employee-cost') && (salaryOfficialValidation?.results || salaryOfficialError) && (
                <div className={`mt-4 rounded-lg border p-4 text-sm ${salaryOfficialError ? 'border-amber-200 bg-amber-50 text-amber-950' : 'border-blue-200 bg-blue-50 text-blue-950'}`}>
                  <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="font-bold">{salaryOfficialError ? 'Validação Doutor Finanças indisponível' : 'Resultado oficial — Doutor Finanças'}</div>
                      <p className="mt-1 text-xs">{salaryOfficialError || `Lido em ${salaryOfficialValidation?.computedAt ? new Date(salaryOfficialValidation.computedAt).toLocaleString('pt-PT') : 'agora'}.`}</p>
                    </div>
                    {salaryOfficialValidation?.sourceUrl && (
                      <a href={salaryOfficialValidation.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-blue-800 shrink-0">
                        Abrir Doutor Finanças <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                  {salaryOfficialValidation?.results && (
                    <div className="mt-3 overflow-x-auto rounded-md border border-blue-200 bg-white">
                      <table className="w-full text-sm">
                        <tbody className="divide-y divide-blue-100">
                          {([
                            ['Salário líquido', salaryOfficialValidation.results.netSalary],
                            ['IRS retido', salaryOfficialValidation.results.irsRetention],
                            ['Segurança Social trabalhador', salaryOfficialValidation.results.socialSecurity],
                            ['Custo anual empregador', salaryOfficialValidation.results.employerCost],
                          ] as [string, number | null | undefined][]).filter(([, v]) => v != null).map(([label, value]) => (
                            <tr key={label}>
                              <td className="px-3 py-2 font-medium text-slate-600">{label}</td>
                              <td className="px-3 py-2 text-right font-bold text-slate-950">{typeof value === 'number' ? formatCurrency(value) : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm font-black text-slate-950">
                    <ShieldCheck size={17} className="text-whatsapp-700" />
                    Fontes desta simulação
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{result.version.id} · válida desde {result.version.validFrom} · revista em {result.version.lastReviewedAt}</p>
                </div>
                <div className={`inline-flex w-fit items-center gap-2 rounded-md border px-3 py-2 text-xs font-bold ${statusClasses(health.status)}`}>
                  {health.status === 'updated' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                  {health.label}
                </div>
              </div>
            </div>

            <div className="p-5">
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-900 text-left text-white">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Regra usada</th>
                      <th className="px-3 py-2 font-semibold">Valor aplicado</th>
                      <th className="px-3 py-2 font-semibold">Fonte</th>
                      <th className="px-3 py-2 text-right font-semibold">Estado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {result.basis.map((item) => (
                      <tr key={`${item.label}-${item.value}`}>
                        <td className="px-3 py-3 font-semibold text-slate-900">{item.label}</td>
                        <td className="px-3 py-3 text-slate-700">{item.value}</td>
                        <td className="px-3 py-3">
                          <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-whatsapp-700 hover:text-whatsapp-900">
                            {item.sourceLabel}
                            <ExternalLink size={13} />
                          </a>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <span className={`inline-flex rounded-md border px-2 py-1 text-xs font-bold ${statusClasses(item.confidence)}`}>
                            {statusLabel(item.confidence)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {showValidation && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                  <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                    <div>
                      <div className="font-bold">Notas de validação</div>
                      <p className="mt-1">{health.description}</p>
                      <p className="mt-2 text-amber-900">{result.version.notes.join(' ')}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {result.version.sources.map((source) => (
                        <a key={source.url} href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-md border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-amber-100">
                          <ExternalLink size={14} />
                          {source.label}
                        </a>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            {result.summary.map((line) => (
              <div key={line.label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-white/60">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{line.label}</div>
                <div className={`mt-3 text-3xl font-black tracking-tight ${line.tone === 'positive' ? 'text-emerald-700' : line.tone === 'negative' ? 'text-rose-700' : 'text-slate-950'}`}>
                  {formatCurrency(line.value)}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold text-slate-950">Detalhe da simulação</h3>
              <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-bold text-slate-600">
                {new Date(result.computedAt).toLocaleString('pt-PT')}
              </span>
            </div>
            <div className="mt-4 overflow-hidden rounded-md border border-slate-200">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-200">
                  {result.details.map((line) => (
                    <tr key={line.label}>
                      <td className="bg-slate-50 px-3 py-2 font-medium text-slate-600">{line.label}</td>
                      <td className="px-3 py-2 text-right font-semibold text-slate-950">{formatCurrency(line.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Simulação meramente indicativa. Deve ser validada de acordo com a legislação em vigor.
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-950">Histórico</h3>
              <History size={18} className="text-slate-400" />
            </div>
            <div className="relative mt-3">
              <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
              <input className={`${inputClass} pl-9`} placeholder="Pesquisar" value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <div className="mt-3 space-y-2">
              {filteredHistory.length === 0 && <div className="rounded-md border border-dashed border-slate-200 p-4 text-center text-sm text-slate-500">Sem simulações guardadas.</div>}
              {filteredHistory.map((item) => (
                <div key={item.id} className={`rounded-md border p-3 ${currentSimId === item.id ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200'}`}>
                  <div className="flex items-start justify-between gap-1">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-slate-950">{item.result.title}</div>
                      <div className="truncate text-xs text-slate-500">{item.customerName}</div>
                    </div>
                    <div className="flex shrink-0 gap-0.5">
                      <button onClick={() => loadFromHistory(item)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100" title="Editar">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => duplicateFromHistory(item)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100" title="Duplicar">
                        <Copy size={13} />
                      </button>
                      <button onClick={() => removeFromHistory(item.id)} className="rounded p-1.5 text-red-400 hover:bg-red-50" title="Apagar">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1.5 text-xs text-slate-400">{new Date(item.result.computedAt).toLocaleString('pt-PT')}</div>
                  {item.emailSentAt && (
                    <div className={`mt-1 flex items-center gap-1 text-xs font-medium ${item.emailReadAt ? 'text-emerald-600' : 'text-blue-500'}`}>
                      <Mail size={11} />
                      {item.emailReadAt
                        ? `Lido em ${new Date(item.emailReadAt).toLocaleString('pt-PT')}`
                        : `Enviado em ${new Date(item.emailSentAt).toLocaleString('pt-PT')}`}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-emerald-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-black text-slate-950">
              <BadgeCheck size={17} className="text-whatsapp-700" />
              Checklist de fiabilidade
            </div>
            <div className="mt-3 space-y-2">
              {[
                'Fonte oficial indicada',
                'Versão da regra guardada',
                'Data da última validação',
                'Aviso legal apresentado',
              ].map((item) => (
                <div key={item} className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
                  <CheckCircle2 size={15} />
                  {item}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950 p-5 text-white shadow-sm">
            <FileText size={20} className="text-whatsapp-300" />
            <h3 className="mt-3 font-bold">Preparado para crescer</h3>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              Cada simulador usa uma versão de regras, fontes e histórico de pressupostos. A próxima evolução natural é mover estas tabelas para BD e ativar PDF/email server-side.
            </p>
          </div>
        </aside>
      </div>

      {/* Modal de envio de email */}
      {showEmailModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
            <h3 className="mb-1 text-base font-bold text-slate-950">Enviar simulação por email</h3>
            <p className="mb-4 text-sm text-slate-500">O PDF será gerado e enviado como anexo de <strong>geral@mpr.pt</strong>.</p>
            <label className="mb-1 block text-xs font-semibold text-slate-700">Email do destinatário</label>
            <input
              type="email"
              value={emailOverrideTo}
              onChange={(e) => setEmailOverrideTo(e.target.value)}
              placeholder="cliente@empresa.pt"
              className="mb-4 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            />
            {!currentSimId && (
              <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">Guarda a simulação primeiro (botão Guardar) antes de enviar.</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={sendSimulationEmail}
                disabled={emailSending || !currentSimId || !emailOverrideTo.trim()}
                className="flex-1 rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {emailSending ? 'A enviar...' : 'Enviar'}
              </button>
              <button onClick={() => setShowEmailModal(false)} className="rounded-md border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Simulators;
