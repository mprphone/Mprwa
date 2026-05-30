import { SalaryNetInput } from './salaryService';

export type SalaryOfficialResult = {
  success: boolean;
  source?: string;
  sourceUrl?: string;
  computedAt?: string;
  results?: {
    netSalary?: number | null;
    irsRetention?: number | null;
    socialSecurity?: number | null;
    grossAnnual?: number | null;
    employerCost?: number | null;
  };
  error?: string;
};

export async function validateSalaryOfficial(input: SalaryNetInput): Promise<SalaryOfficialResult> {
  const requestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  };

  let response = await fetch('/api/simulators/salary/validate-official', requestInit);
  if (response.status === 404 && typeof window !== 'undefined' && window.location.port === '5173') {
    response = await fetch('http://127.0.0.1:3010/api/simulators/salary/validate-official', requestInit);
  }

  const payload = await response.json().catch(() => ({})) as SalaryOfficialResult;
  if (!response.ok || payload.success === false) {
    throw new Error(String(payload.error || `Falha ao validar no Doutor Finanças (${response.status}).`));
  }
  return payload;
}
