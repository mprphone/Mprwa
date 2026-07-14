import {
  AgendaEvent,
  AutoResponseTrigger,
  Call,
  Conversation,
  ConversationStatus,
  Customer,
  CustomerType,
  Message,
  Role,
  Task,
  TaskPriority,
  TaskStatus,
  User,
} from '../types';

export const INITIAL_USERS: User[] = [
  { id: 'u1', name: 'Ana Silva', email: 'ana@company.com', password: '1234', role: Role.ADMIN, avatarUrl: 'https://picsum.photos/200/200?random=1' },
  { id: 'u2', name: 'João Santos', email: 'joao@company.com', password: '1234', role: Role.AGENT, avatarUrl: 'https://picsum.photos/200/200?random=2' },
  { id: 'u3', name: 'Maria Costa', email: 'maria@company.com', password: '1234', role: Role.AGENT, avatarUrl: 'https://picsum.photos/200/200?random=3' },
  { id: 'u4', name: 'Marco Rebelo', email: 'mpr@mpr.pt', password: '1234', role: Role.ADMIN, avatarUrl: 'https://ui-avatars.com/api/?name=Marco+Rebelo&background=random' },
];


export const INITIAL_CUSTOMERS: Customer[] = [
  { 
    id: 'c1', 
    name: 'Carlos Ferreira', 
    company: 'Tech Solutions', 
    phone: '+351912345678', 
    ownerId: 'u1',
    type: CustomerType.ENTERPRISE,
    contacts: [{ name: 'Secretaria', phone: '+351210000000' }],
    allowAutoResponses: true
  },
  { 
    id: 'c2', 
    name: 'Sofia Martins', 
    company: 'Logística Lda', 
    phone: '+351961112233', 
    ownerId: 'u2',
    type: CustomerType.SUPPLIER,
    contacts: [],
    allowAutoResponses: false
  },
  { 
    id: 'c3', 
    name: 'Novo Cliente', 
    company: 'Startup Inc', 
    phone: '+351933334444', 
    ownerId: null,
    type: CustomerType.INDEPENDENT,
    contacts: [],
    allowAutoResponses: true
  },
];

export const INITIAL_CONVERSATIONS: Conversation[] = [
  { id: 'conv1', customerId: 'c1', ownerId: 'u1', status: ConversationStatus.OPEN, lastMessageAt: new Date().toISOString(), unreadCount: 0 },
  { id: 'conv2', customerId: 'c2', ownerId: 'u2', status: ConversationStatus.WAITING, lastMessageAt: new Date(Date.now() - 3600000).toISOString(), unreadCount: 0 },
  { id: 'conv3', customerId: 'c3', ownerId: null, status: ConversationStatus.OPEN, lastMessageAt: new Date(Date.now() - 7200000).toISOString(), unreadCount: 0 },
];

export const INITIAL_MESSAGES: Message[] = [
  { id: 'm1', conversationId: 'conv1', direction: 'in', body: 'Olá, preciso de ajuda com a fatura.', timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(), type: 'text', status: 'read' },
  { id: 'm2', conversationId: 'conv1', direction: 'out', body: 'Olá Carlos. Claro, qual é o número da fatura?', timestamp: new Date(Date.now() - 1000 * 60 * 28).toISOString(), type: 'text', status: 'read' },
  { id: 'm3', conversationId: 'conv1', direction: 'in', body: 'É a FT 2023/450.', timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(), type: 'text', status: 'read' },
  { id: 'm4', conversationId: 'conv3', direction: 'in', body: 'Boa tarde, gostaria de saber preços.', timestamp: new Date(Date.now() - 7200000).toISOString(), type: 'text', status: 'read' },
];

export const INITIAL_TASKS: Task[] = [
  { id: 't1', conversationId: 'conv1', title: 'Verificar fatura no ERP', status: TaskStatus.OPEN, priority: TaskPriority.URGENT, dueDate: new Date(Date.now() + 86400000).toISOString(), assignedUserId: 'u1', notes: 'Verificar se o IVA está a 23%' },
  { id: 't2', conversationId: 'conv2', title: 'Agendar reunião', status: TaskStatus.DONE, priority: TaskPriority.NORMAL, dueDate: new Date().toISOString(), assignedUserId: 'u2' },
];

export const INITIAL_CALLS: Call[] = [
  { id: 'call1', customerId: 'c1', userId: 'u1', startedAt: new Date(Date.now() - 86400000).toISOString(), durationSeconds: 120, notes: 'Dúvida rápida', source: 'manual' },
];

export const INITIAL_AGENDA_EVENTS: AgendaEvent[] = [
  {
    id: 'ag1',
    title: 'Reunião de fecho mensal',
    type: 'meeting',
    customerId: 'c1',
    assignedUserId: 'u1',
    startsAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    endsAt: new Date(Date.now() + 2 * 86400000 + 60 * 60000).toISOString(),
    location: 'Escritório',
    notes: 'Validar documentação em falta e próximos prazos.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'ag2',
    title: 'Visita ao cliente',
    type: 'visit',
    customerId: 'c2',
    assignedUserId: 'u2',
    startsAt: new Date(Date.now() + 4 * 86400000 + 2 * 3600000).toISOString(),
    endsAt: new Date(Date.now() + 4 * 86400000 + 3 * 3600000).toISOString(),
    location: 'Instalações do cliente',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

// Updated Triggers based on user requirements
export const INITIAL_TRIGGERS: AutoResponseTrigger[] = [
  // 1. Confirmação de receção (Primeira msg do dia)
  { 
      id: 'tr1', 
      type: 'first_message_today',
      action: 'send_message',
      response: 'Olá 👋\nRecebemos a sua mensagem e já estamos a tratar.',
      isActive: true,
      audience: 'all',
      schedule: 'business_hours',
      level: 'essential'
  },
  // 2. Fora de horário
  { 
      id: 'tr2', 
      type: 'outside_hours',
      action: 'send_message',
      response: 'Olá, recebemos a sua mensagem fora do nosso horário de atendimento. Retomaremos o contacto no próximo dia útil.', 
      isActive: true,
      audience: 'all',
      schedule: 'outside_hours',
      level: 'essential'
  },
  // 5. Identificação Automática (Keyword -> Task) - IRS
  { 
      id: 'tr3', 
      type: 'keyword',
      action: 'create_task',
      keyword: 'irs',
      matchType: 'contains',
      taskTitleTemplate: 'IRS - Documentos Pendentes',
      isActive: true,
      audience: 'allowed_only',
      schedule: 'always',
      level: 'extra'
  },
  // 5. Identificação Automática (Keyword -> Task) - IVA
  { 
      id: 'tr4', 
      type: 'keyword',
      action: 'create_task',
      keyword: 'iva',
      matchType: 'contains',
      taskTitleTemplate: 'IVA - Envio Mensal',
      isActive: true,
      audience: 'allowed_only',
      schedule: 'always',
      level: 'extra'
  },
  // 10. Respostas Rápidas (Keyword -> Reply) - IBAN
  { 
      id: 'tr5', 
      type: 'keyword',
      action: 'send_message',
      keyword: 'iban',
      matchType: 'contains',
      response: 'O nosso IBAN para pagamentos é PT50 0000 0000 0000 0000 0000 0.',
      isActive: true,
      audience: 'allowed_only',
      schedule: 'always',
      level: 'essential'
  },
  // 6. Mensagem de Encerramento (Task Completed -> Reply)
  {
      id: 'tr6',
      type: 'task_completed',
      action: 'send_message',
      response: 'O seu pedido ficou concluído. Se precisar de algo adicional, estamos disponíveis.',
      isActive: false,
      audience: 'all',
      schedule: 'always',
      level: 'extra'
  },
  // NOVO: Gatilho de Contratação
  {
      id: 'tr7',
      type: 'keyword',
      action: 'create_task',
      keyword: 'empregar alguem',
      matchType: 'contains',
      taskTitleTemplate: 'Novo Funcionário',
      isActive: true,
      audience: 'allowed_only',
      schedule: 'always',
      level: 'extra'
  }
];
