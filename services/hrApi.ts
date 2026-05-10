export type HrPedidoStatus = 'PENDENTE' | 'APROVADO' | 'REJEITADO';

export interface HrFuncionario {
  id: string;
  userId?: string;
  nome: string;
  email?: string;
  telefone?: string;
  pin?: string;
  activo: boolean;
  horarioTrabalho?: string;
  localTrabalho?: string;
  dataNascimento?: string;
  numeroColaborador?: string;
  nif?: string;
  niss?: string;
  cartaoCidadao?: string;
  morada?: string;
  codigoPostal?: string;
  estadoCivil?: string;
  temFilhos?: boolean;
  numeroFilhos?: number;
  contactoEmergencia?: string;
  iban?: string;
  cargo?: string;
  responsavelDireto?: string;
  tipoVinculo?: string;
  dataAdmissao?: string;
  dataSaida?: string;
  observacoesInternas?: string;
  fotoUrl?: string;
  estadoRh?: string;
  tipoHorario?: string;
  horaEntradaPrevista?: string;
  horaSaidaPrevista?: string;
  pausaAlmocoInicio?: string;
  pausaAlmocoFim?: string;
  toleranciaEntradaMin?: number;
  toleranciaSaidaMin?: number;
  horasDiariasPrevistas?: number;
  horasSemanaisContratadas?: number;
  diasTrabalho?: string;
  objetivos?: string;
  premioObjetivos?: string;
  updatedAt?: string;
}

export interface HrPedido {
  id: string;
  funcionarioId: string;
  funcionarioNome?: string;
  tipo: string;
  descricao?: string;
  dataInicio?: string;
  dataFim?: string;
  status: HrPedidoStatus;
  resolucao?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface HrRegistoPonto {
  id: string;
  funcionarioId: string;
  funcionarioNome?: string;
  tipo: string;
  momento: string;
  origem?: string;
}

export interface HrHoliday {
  date: string;
  name: string;
  region?: string;
}

export interface HrFeriasSaldo {
  id: string;
  funcionarioId: string;
  ano: number;
  diasDireito: number;
  diasExtra: number;
  diasUsadosManual: number;
  observacoes?: string;
}

export interface HrEmpresaPeriodo {
  id: string;
  titulo: string;
  descricao?: string;
  dataInicio: string;
  dataFim: string;
  funcionariosAlvo: string[] | null;
  createdBy?: string;
}

export interface HrObjetivo {
  id: string;
  funcionarioId?: string;
  titulo: string;
  deadline?: string;
  metaTipo: 'QTD' | 'PERCENT';
  meta: number;
  atingido: number;
  peso: number;
  erros: number;
  ordem?: number;
}

export interface HrObjetivosConfig {
  funcionarioId?: string;
  patamar50: string;
  patamar65: string;
  patamar80: string;
  premioMaximo: number;
  notasGerais: string;
}

export type HrEmailAutoReplyStatus = 'manual_necessario' | 'agendado' | 'ativo' | 'desativado' | 'erro';

export interface HrEmailAutoReplyLog {
  id: string;
  scheduleId: string;
  action: string;
  status: string;
  message?: string;
  command?: string;
  details?: any;
  createdAt?: string;
}

export interface HrEmailAutoReplySchedule {
  id: string;
  pedidoId?: string;
  funcionarioId: string;
  funcionarioNome?: string;
  email: string;
  enabled: boolean;
  subject: string;
  message: string;
  alternateContact?: string;
  alternateContactEmail?: string;
  alternateContactPhone?: string;
  templateVariant?: 'default' | 'simple';
  mode?: 'manual' | 'plesk_ssh' | 'plesk_api' | 'disabled';
  manualUrl?: string;
  startDate: string;
  endDate: string;
  deactivateDate: string;
  status: HrEmailAutoReplyStatus;
  lastAction?: string;
  lastError?: string;
  activatedAt?: string;
  deactivatedAt?: string;
  activationAlertAt?: string;
  deactivationAlertAt?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  logs?: HrEmailAutoReplyLog[];
}

async function safeJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { success: false, error: 'Resposta inválida do servidor. Reinicie o backend para carregar as rotas de RH.' } as T;
  }
}

function parseError(payload: any, fallback: string) {
  return String(payload?.error || payload?.message || fallback);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await safeJson<{ success?: boolean; data?: T; summary?: T; error?: unknown }>(response);
  if (!response.ok || payload.success !== true) {
    throw new Error(parseError(payload, `Falha no pedido ${url}`));
  }
  return (payload.data ?? payload.summary ?? payload) as T;
}

export async function syncHrFromSupabase() {
  return request<any>('/api/hr/sync', { method: 'POST' });
}

export async function fetchHrSummary(viewerUserId?: string) {
  const qs = viewerUserId ? `?viewerUserId=${encodeURIComponent(viewerUserId)}` : '';
  return request<{
    funcionarios: number;
    pedidos: Partial<Record<HrPedidoStatus, number>>;
    registosPonto: number;
    lastSync: string;
  }>(`/api/hr/summary${qs}`);
}

export async function fetchHrFuncionarios(viewerUserId?: string) {
  const qs = viewerUserId ? `?viewerUserId=${encodeURIComponent(viewerUserId)}` : '';
  const data = await request<HrFuncionario[]>(`/api/hr/funcionarios${qs}`);
  return Array.isArray(data) ? data : [];
}

export async function updateHrFuncionario(id: string, input: Partial<HrFuncionario> & { actorUserId?: string }) {
  return request<HrFuncionario>(`/api/hr/funcionarios/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function fetchHrPedidos(filters: { status?: string; funcionarioId?: string; year?: number | string; viewerUserId?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.funcionarioId) params.set('funcionarioId', filters.funcionarioId);
  if (filters.year) params.set('year', String(filters.year));
  if (filters.viewerUserId) params.set('viewerUserId', filters.viewerUserId);
  const qs = params.toString();
  const data = await request<HrPedido[]>(`/api/hr/pedidos${qs ? `?${qs}` : ''}`);
  return Array.isArray(data) ? data : [];
}

export async function fetchHrRegistosPonto(filters: {
  funcionarioId?: string;
  year?: number | string;
  startDate?: string;
  endDate?: string;
  viewerUserId?: string;
} = {}) {
  const params = new URLSearchParams();
  if (filters.funcionarioId) params.set('funcionarioId', filters.funcionarioId);
  if (filters.year) params.set('year', String(filters.year));
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  if (filters.viewerUserId) params.set('viewerUserId', filters.viewerUserId);
  const qs = params.toString();
  const data = await request<HrRegistoPonto[]>(`/api/hr/registos-ponto${qs ? `?${qs}` : ''}`);
  return Array.isArray(data) ? data : [];
}

export async function createHrRegistoPonto(input: {
  funcionarioId: string;
  tipo: 'ENTRADA' | 'SAIDA';
  momento: string;
  origem?: string;
  actorUserId?: string;
}) {
  return request<HrRegistoPonto>('/api/hr/registos-ponto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function updateHrRegistoPonto(id: string, input: {
  tipo?: 'ENTRADA' | 'SAIDA';
  momento?: string;
  origem?: string;
  actorUserId?: string;
}) {
  return request<HrRegistoPonto>(`/api/hr/registos-ponto/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deleteHrRegistoPonto(id: string, actorUserId?: string) {
  const params = new URLSearchParams();
  if (actorUserId) params.set('actorUserId', actorUserId);
  const qs = params.toString();
  return request<void>(`/api/hr/registos-ponto/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
}

export async function fetchHrObjetivos(funcionarioId: string, viewerUserId?: string) {
  const params = new URLSearchParams({ funcionarioId });
  if (viewerUserId) params.set('viewerUserId', viewerUserId);
  return request<{ items: HrObjetivo[]; config: HrObjetivosConfig }>(`/api/hr/objetivos?${params.toString()}`);
}

export async function saveHrObjetivos(funcionarioId: string, input: { items: HrObjetivo[]; config: HrObjetivosConfig; actorUserId?: string }) {
  return request<{ items: HrObjetivo[]; config: HrObjetivosConfig }>(`/api/hr/objetivos/${encodeURIComponent(funcionarioId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function applyHrObjetivosToAll(input: { items: HrObjetivo[]; config: HrObjetivosConfig; actorUserId?: string }) {
  return request<{ count: number }>('/api/hr/objetivos/apply-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function fetchHrEmailAutoReplies(filters: { funcionarioId?: string; pedidoId?: string; viewerUserId?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.funcionarioId) params.set('funcionarioId', filters.funcionarioId);
  if (filters.pedidoId) params.set('pedidoId', filters.pedidoId);
  if (filters.viewerUserId) params.set('viewerUserId', filters.viewerUserId);
  const qs = params.toString();
  const data = await request<HrEmailAutoReplySchedule[]>(`/api/hr/email-autoreplies${qs ? `?${qs}` : ''}`);
  return Array.isArray(data) ? data : [];
}

export async function saveHrEmailAutoReply(input: Partial<HrEmailAutoReplySchedule> & {
  pedidoId?: string;
  funcionarioId: string;
  actorUserId?: string;
}) {
  return request<HrEmailAutoReplySchedule>('/api/hr/email-autoreplies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function updateHrEmailAutoReply(id: string, input: Partial<HrEmailAutoReplySchedule> & { actorUserId?: string }) {
  return request<HrEmailAutoReplySchedule>(`/api/hr/email-autoreplies/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function runHrEmailAutoReply(id: string, input: { action: 'activate' | 'deactivate' | 'mark_activated' | 'mark_deactivated'; actorUserId?: string }) {
  return request<HrEmailAutoReplySchedule>(`/api/hr/email-autoreplies/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function runDueHrEmailAutoReplies(input: { actorUserId?: string; today?: string } = {}) {
  return request<any>('/api/hr/email-autoreplies/run-due', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function updateHrPedido(id: string, input: Partial<Pick<HrPedido, 'tipo' | 'descricao' | 'dataInicio' | 'dataFim' | 'status' | 'resolucao'>> & { actorUserId?: string }) {
  const updated = await request<HrPedido>(`/api/hr/pedidos/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return updated;
}

export async function fetchHrHolidays() {
  const data = await request<HrHoliday[]>('/api/hr/holidays');
  return Array.isArray(data) ? data : [];
}

export async function createHrHoliday(input: HrHoliday) {
  return request<HrHoliday>('/api/hr/holidays', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deleteHrHoliday(date: string) {
  return request<void>(`/api/hr/holidays/${encodeURIComponent(date)}`, { method: 'DELETE' });
}

export async function fetchHrFeriasSaldos(year: number | string) {
  const data = await request<HrFeriasSaldo[]>(`/api/hr/ferias-saldos?year=${encodeURIComponent(String(year))}`);
  return Array.isArray(data) ? data : [];
}

export async function updateHrFeriasSaldo(funcionarioId: string, year: number | string, input: Partial<HrFeriasSaldo>) {
  return request<HrFeriasSaldo>(`/api/hr/ferias-saldos/${encodeURIComponent(funcionarioId)}/${encodeURIComponent(String(year))}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function fetchHrEmpresaPeriodos() {
  const data = await request<HrEmpresaPeriodo[]>('/api/hr/ferias-empresa-periodos');
  return Array.isArray(data) ? data : [];
}

export async function createHrEmpresaPeriodo(input: {
  titulo: string;
  descricao?: string;
  dataInicio: string;
  dataFim: string;
  funcionariosAlvo?: string[] | null;
}) {
  return request<HrEmpresaPeriodo>('/api/hr/ferias-empresa-periodos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deleteHrEmpresaPeriodo(id: string) {
  return request<void>(`/api/hr/ferias-empresa-periodos/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
