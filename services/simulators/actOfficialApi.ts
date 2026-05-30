import { ActCompensationInput } from './actCompensationService';

export type ActOfficialValidationResult = {
  success: boolean;
  source?: string;
  sourceUrl?: string;
  computedAt?: string;
  results?: {
    compensation?: number | null;
    vacation?: number | null;
    holidayAllowance?: number | null;
    proportionalVacation?: number | null;
    proportionalHolidayAllowance?: number | null;
    proportionalChristmasAllowance?: number | null;
    total?: number | null;
  };
  error?: string;
};

export async function validateActCompensationOfficial(input: ActCompensationInput): Promise<ActOfficialValidationResult> {
  const requestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  };

  let response = await fetch('/api/simulators/act-compensation/validate-official', requestInit);
  if (response.status === 404 && typeof window !== 'undefined' && window.location.port === '5173') {
    response = await fetch('http://127.0.0.1:3000/api/simulators/act-compensation/validate-official', requestInit);
  }

  const payload = await response.json().catch(() => ({})) as ActOfficialValidationResult;
  if (!response.ok || payload.success === false) {
    const restartHint = response.status === 404
      ? ' Rota não encontrada: reinicie o servidor/backend para carregar a validação ACT.'
      : '';
    throw new Error(String(payload.error || `Falha ao validar no ACT (${response.status}).${restartHint}`));
  }
  return payload;
}
