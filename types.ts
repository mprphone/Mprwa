export enum Role {
  ADMIN = 'ADMIN',
  AGENT = 'AGENT',
}

export enum ConversationStatus {
  OPEN = 'open',
  WAITING = 'waiting',
  CLOSED = 'closed',
}

export enum TaskStatus {
  OPEN = 'open',
  IN_PROGRESS = 'in_progress',
  WAITING = 'waiting',
  DONE = 'done',
}

export enum TaskPriority {
  NORMAL = 'normal',
  URGENT = 'urgent',
}

export enum CustomerType {
  ENTERPRISE = 'Empresa',
  INDEPENDENT = 'Independente',
  SUPPLIER = 'Fornecedor',
  PRIVATE = 'Particular',
  PUBLIC_SERVICE = 'Serviços Públicos',
  OTHER = 'Outros',
  SPAM = 'Spam',
}

export interface User {
  id: string;
  name: string;
  email: string;
  password?: string;
  role: Role;
  avatarUrl: string;
  isAiAssistant?: boolean;
  aiAllowedSites?: string[];
}

export interface SubContact {
  name: string;
  phone: string;
}

export interface CustomerManager {
  name: string;
  email?: string;
  phone?: string;
}

export interface CustomerAccessCredential {
  service: string;
  username: string;
  password: string;
}

export interface CustomerHouseholdRelation {
  customerId?: string;
  customerSourceId?: string;
  relationType: 'conjuge' | 'filho' | 'pai' | 'outro';
  note?: string;
  customerName?: string;
  customerCompany?: string;
  customerNif?: string;
}

export interface CustomerRelatedRecord {
  customerId?: string;
  customerSourceId?: string;
  relationType: 'funcionario' | 'amigo' | 'familiar' | 'gerente' | 'socio' | 'outro';
  note?: string;
  customerName?: string;
  customerCompany?: string;
  customerNif?: string;
}

export interface Customer {
  id: string;
  sourceId?: string;
  name: string;
  company: string;
  contactName?: string;
  phone: string; // E.164 Main phone
  email?: string;
  documentsFolder?: string;
  nif?: string;
  niss?: string;
  senhaFinancas?: string;
  senhaSegurancaSocial?: string;
  tipoIva?: string;
  morada?: string;
  notes?: string;
  certidaoPermanenteNumero?: string;
  certidaoPermanenteValidade?: string;
  rcbeNumero?: string;
  rcbeData?: string;
  dataConstituicao?: string;
  inicioAtividade?: string;
  caePrincipal?: string;
  codigoReparticaoFinancas?: string;
  tipoContabilidade?: string;
  estadoCliente?: string;
  contabilistaCertificado?: string;
  managers?: CustomerManager[];
  accessCredentials?: CustomerAccessCredential[];
  agregadoFamiliar?: CustomerHouseholdRelation[];
  fichasRelacionadas?: CustomerRelatedRecord[];
  supabaseUpdatedAt?: string;
  supabasePayload?: Record<string, unknown>;
  ownerId: string | null; // ID of the responsible employee
  type: CustomerType;
  contacts: SubContact[]; // Multiple associated contacts
  allowAutoResponses: boolean; // Flag to enable/disable auto replies for this customer
}

export interface Message {
  id: string;
  dbId?: number;
  conversationId: string;
  direction: 'in' | 'out';
  body: string;
  timestamp: string; // ISO string
  type: 'text' | 'template' | 'image' | 'document';
  status: 'sent' | 'delivered' | 'read';
  mediaKind?: string;
  mediaPath?: string;
  mediaMimeType?: string;
  mediaFileName?: string;
  mediaSize?: number | null;
  mediaProvider?: string;
  mediaRemoteId?: string;
  mediaRemoteUrl?: string;
  mediaPreviewUrl?: string;
  mediaDownloadUrl?: string;
}

export interface Conversation {
  id: string;
  customerId: string;
  whatsappAccountId?: string | null;
  ownerId: string | null;
  status: ConversationStatus;
  lastMessageAt: string;
  unreadCount: number;
}

export interface Task {
  id: string;
  conversationId: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string;
  assignedUserId: string;
  notes?: string;
  attachments?: TaskAttachment[];
}

export interface TaskAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
  createdAt: string;
}

export interface Call {
  id: string;
  customerId: string;
  userId: string | null; // Null if imported without user mapping
  startedAt: string;
  durationSeconds: number;
  notes?: string;
  source: 'manual' | 'import';
}

export interface ReportMetrics {
  totalConversations: number;
  avgResponseTimeMinutes: number;
  tasksOpen: number;
  tasksClosed: number;
  callsTotalDurationMinutes: number;
}

export type TriggerAudience = 'all' | 'allowed_only';
export type TriggerSchedule = 'always' | 'business_hours' | 'outside_hours';

// New types for advanced automation
export type TriggerType = 'keyword' | 'first_message_today' | 'outside_hours' | 'task_completed';
export type TriggerAction = 'send_message' | 'create_task';
export type TriggerLevel = 'essential' | 'extra';

export interface AutoResponseTrigger {
  id: string;
  type: TriggerType; // Logic: When to fire
  action: TriggerAction; // Logic: What to do
  level: TriggerLevel; // Classification for reporting/importance
  
  // Criteria
  keyword?: string; // Only for type 'keyword'
  matchType?: 'exact' | 'contains'; // Only for type 'keyword'
  
  // Output
  response?: string; // Only for action 'send_message'
  taskTitleTemplate?: string; // Only for action 'create_task'

  // Settings
  isActive: boolean;
  audience: TriggerAudience;
  schedule: TriggerSchedule;
}
