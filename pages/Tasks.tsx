import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { mockService, CURRENT_USER_ID } from '../services/mockData';
import { Task, TaskAttachment, Customer, Conversation, User, TaskStatus, TaskPriority, ConversationStatus, Role } from '../types';
import { AlertTriangle, Edit3, Plus, Search, RefreshCw, Paperclip, Trash2, X } from 'lucide-react';

interface EnrichedTask extends Task {
  customerName?: string;
  ownerName?: string;
}

const Tasks: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<EnrichedTask[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('open');
  const [priorityFilter, setPriorityFilter] = useState<'all' | 'normal' | 'urgent'>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [selectedTask, setSelectedTask] = useState<EnrichedTask | null>(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [importingTasks, setImportingTasks] = useState(false);
  const [importSummary, setImportSummary] = useState('');
  const [importError, setImportError] = useState('');
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [isSavingTask, setIsSavingTask] = useState(false);
  const [isDeletingTask, setIsDeletingTask] = useState(false);
  const saveInFlightRef = useRef(false);

  // Form State
  const [editFormData, setEditFormData] = useState<{
      title: string;
      assignedUserId: string;
      priority: TaskPriority;
      dueDate: string;
      notes: string;
      status: TaskStatus;
      attachments: TaskAttachment[];
  }>({
      title: '',
      assignedUserId: '',
      priority: TaskPriority.NORMAL,
      dueDate: '',
      notes: '',
      status: TaskStatus.OPEN,
      attachments: []
  });

  // State specific for Creation
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [selectedCustomerQuery, setSelectedCustomerQuery] = useState<string>('');
  const taskAttachmentInputRef = useRef<HTMLInputElement>(null);

  const currentUserId = String(mockService.getCurrentUserId() || CURRENT_USER_ID || '').trim();
  const currentUserRole = users.find((user) => user.id === currentUserId)?.role || mockService.getCurrentUser()?.role;
  const isAdmin = currentUserRole === Role.ADMIN;

  const customerLabel = (customer: Customer) => {
    const name = String(customer?.name || '').trim();
    const company = String(customer?.company || '').trim();
    if (!company || company.toLowerCase() === name.toLowerCase()) return name;
    return `${name} (${company})`;
  };

  const normalizeSearch = (value: string) =>
    String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();

  const filteredCustomerSuggestions = useMemo(() => {
    const term = normalizeSearch(selectedCustomerQuery);
    const sorted = [...customers].sort((left, right) => customerLabel(left).localeCompare(customerLabel(right), 'pt'));
    if (!term) return sorted.slice(0, 120);
    return sorted
      .filter((customer) => {
        const label = normalizeSearch(customerLabel(customer));
        const name = normalizeSearch(customer.name || '');
        const company = normalizeSearch(customer.company || '');
        return label.includes(term) || name.includes(term) || company.includes(term);
      })
      .slice(0, 120);
  }, [customers, selectedCustomerQuery]);

  const selectedCustomerForCreate = useMemo(
    () => customers.find((customer) => customer.id === selectedCustomerId) || null,
    [customers, selectedCustomerId]
  );

  useEffect(() => {
    void fetchDataSafe();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const targetTaskId = String(params.get('taskId') || '').trim();
    if (!targetTaskId || tasks.length === 0) return;

    const targetTask = tasks.find((task) => String(task.id || '').trim() === targetTaskId);
    if (!targetTask) return;

    openEditModal(targetTask);
    setFilter('all');

    params.delete('taskId');
    const nextSearch = params.toString();
    navigate(
      {
        pathname: '/tasks',
        search: nextSearch ? `?${nextSearch}` : '',
      },
      { replace: true }
    );
  }, [location.search, tasks, navigate]);

  const fetchData = async () => {
      setIsLoadingTasks(true);
      setLoadError('');
      const [allTasks, convs, custs, allUsers] = await Promise.all([
        mockService.getTasks(),
        mockService.getConversations(),
        mockService.getCustomers(),
        mockService.getUsers()
      ]);

      setUsers(allUsers);
      setCustomers(custs);
      setConversations(convs);

      const enriched = allTasks.map(t => {
        const conv = convs.find(c => c.id === t.conversationId);
        const cust = custs.find(c => c.id === conv?.customerId);
        const owner = allUsers.find(u => u.id === t.assignedUserId);
        return {
          ...t,
          customerName: cust?.name,
          ownerName: owner?.name
        };
      });

      setTasks(enriched);
      setIsLoadingTasks(false);
  };

  const fetchDataSafe = async () => {
      try {
          await fetchData();
      } catch (error) {
          setLoadError(error instanceof Error ? error.message : 'Falha ao carregar tarefas.');
          setIsLoadingTasks(false);
      }
  };

  const openCreateModal = () => {
      setIsSavingTask(false);
      setIsDeletingTask(false);
      saveInFlightRef.current = false;
      setSelectedTask(null);
      setSelectedCustomerId('');
      setSelectedCustomerQuery('');
      setEditFormData({
          title: '',
          assignedUserId: currentUserId || CURRENT_USER_ID,
          priority: TaskPriority.NORMAL,
          dueDate: new Date(Date.now() + 86400000).toISOString().split('T')[0], // Tomorrow
          notes: '',
          status: TaskStatus.OPEN,
          attachments: []
      });
      setIsEditModalOpen(true);
  };

  const handleCustomerQueryChange = (value: string) => {
      setSelectedCustomerQuery(value);
      const normalized = normalizeSearch(value);
      if (!normalized) {
          setSelectedCustomerId('');
          return;
      }

      const exact = customers.find((customer) => {
          const label = normalizeSearch(customerLabel(customer));
          const name = normalizeSearch(customer.name || '');
          const company = normalizeSearch(customer.company || '');
          return label === normalized || name === normalized || company === normalized;
      });
      setSelectedCustomerId(exact?.id || '');
  };

  const openEditModal = (task: EnrichedTask) => {
      setIsSavingTask(false);
      setIsDeletingTask(false);
      saveInFlightRef.current = false;
      setSelectedTask(task);
      setEditFormData({
          title: task.title,
          assignedUserId: task.assignedUserId,
          priority: task.priority,
          dueDate: task.dueDate.split('T')[0], // Extract YYYY-MM-DD
          notes: task.notes || '',
          status: task.status === TaskStatus.DONE ? TaskStatus.DONE : TaskStatus.OPEN,
          attachments: Array.isArray(task.attachments) ? task.attachments : []
      });
      setIsEditModalOpen(true);
  };

  const readAttachmentFile = (file: File): Promise<TaskAttachment> =>
      new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
              if (typeof reader.result !== 'string') {
                  reject(new Error('Falha ao ler anexo.'));
                  return;
              }
              resolve({
                  id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                  name: file.name,
                  mimeType: file.type || 'application/octet-stream',
                  size: Number(file.size || 0),
                  dataUrl: reader.result,
                  createdAt: new Date().toISOString(),
              });
          };
          reader.onerror = () => reject(new Error('Falha ao ler anexo.'));
          reader.readAsDataURL(file);
      });

  const handleTaskAttachmentInput = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || []);
      event.currentTarget.value = '';
      if (files.length === 0) return;

      try {
          const nextAttachments = await Promise.all(
              files.map(async (file) => {
                  const maxSize = 8 * 1024 * 1024;
                  if (Number(file.size || 0) > maxSize) {
                      throw new Error(`O ficheiro "${file.name}" excede 8MB.`);
                  }
                  return readAttachmentFile(file);
              })
          );
          setEditFormData((prev) => ({
              ...prev,
              attachments: [...prev.attachments, ...nextAttachments].slice(0, 12),
          }));
      } catch (error) {
          const message = error instanceof Error ? error.message : 'Falha ao anexar ficheiro.';
          alert(message);
      }
  };

  const removeTaskAttachment = (attachmentId: string) => {
      setEditFormData((prev) => ({
          ...prev,
          attachments: prev.attachments.filter((attachment) => attachment.id !== attachmentId),
      }));
  };

  const handleSave = async (e: React.FormEvent) => {
      e.preventDefault();
      if (saveInFlightRef.current || isSavingTask || isDeletingTask) return;
      saveInFlightRef.current = true;
      setIsSavingTask(true);

      try {
          const nextTitle = String(editFormData.title || '').trim();
          if (!nextTitle) {
              alert('Preencha o assunto da tarefa.');
              return;
          }

          const nextDueIso = new Date(editFormData.dueDate).toISOString();

          if (selectedTask) {
              // UPDATE EXISTING
              await mockService.updateTask(selectedTask.id, {
                  title: nextTitle,
                  assignedUserId: editFormData.assignedUserId,
                  priority: editFormData.priority,
                  dueDate: nextDueIso,
                  notes: editFormData.notes,
                  status: editFormData.status,
                  attachments: editFormData.attachments
              });
          } else {
              // CREATE NEW
              if (!selectedCustomerId) {
                  alert('Por favor, selecione um cliente.');
                  return;
              }

              // Find appropriate conversation (Open preferred, or any)
              let targetConv = conversations.find(c => c.customerId === selectedCustomerId && c.status === ConversationStatus.OPEN);
              if (!targetConv) {
                  targetConv = conversations.find(c => c.customerId === selectedCustomerId);
              }

              if (!targetConv) {
                  // Create a conversation on the fly just to hold the task
                  targetConv = await mockService.createConversation(selectedCustomerId);
                  mockService.getConversations().then(setConversations);
              }

              const normalizedTitle = normalizeSearch(nextTitle);
              const normalizedNotes = normalizeSearch(editFormData.notes || '');
              const dueDateToken = String(editFormData.dueDate || '').trim();
              const duplicateTask = tasks.find((task) =>
                  String(task.conversationId || '').trim() === String(targetConv?.id || '').trim()
                  && normalizeSearch(task.title || '') === normalizedTitle
                  && String(task.assignedUserId || '').trim() === String(editFormData.assignedUserId || '').trim()
                  && String(task.priority || '').trim() === String(editFormData.priority || '').trim()
                  && String(task.status || '').trim() === String(editFormData.status || '').trim()
                  && String(task.dueDate || '').slice(0, 10) === dueDateToken
                  && normalizeSearch(task.notes || '') === normalizedNotes
              );
              if (duplicateTask) {
                  alert('Já existe uma tarefa igual para este cliente. Abri a tarefa existente para evitar duplicado.');
                  openEditModal(duplicateTask);
                  return;
              }

              await mockService.createTask({
                  conversationId: targetConv.id,
                  title: nextTitle,
                  assignedUserId: editFormData.assignedUserId,
                  priority: editFormData.priority,
                  dueDate: nextDueIso,
                  notes: editFormData.notes,
                  status: editFormData.status,
                  attachments: editFormData.attachments
              });
          }

          setIsEditModalOpen(false);
          await fetchDataSafe();
      } catch (error) {
          alert(error instanceof Error ? error.message : 'Falha ao guardar tarefa.');
      } finally {
          saveInFlightRef.current = false;
          setIsSavingTask(false);
      }
  };

  const handleDeleteTask = async () => {
      if (!selectedTask?.id || isSavingTask || isDeletingTask) return;
      const label = String(selectedTask.title || '').trim() || 'tarefa';
      const confirmed = window.confirm(`Eliminar a tarefa "${label}"? Esta ação não pode ser revertida.`);
      if (!confirmed) return;

      setIsDeletingTask(true);
      try {
          await mockService.deleteTask(selectedTask.id, {
              actorUserId: currentUserId || CURRENT_USER_ID,
          });
          setIsEditModalOpen(false);
          await fetchDataSafe();
      } catch (error) {
          alert(error instanceof Error ? error.message : 'Falha ao eliminar tarefa.');
      } finally {
          setIsDeletingTask(false);
      }
  };

  const handleImportTasks = async (force = false) => {
      setImportingTasks(true);
      setImportError('');
      setImportSummary('');
      try {
          const result = await mockService.importTasksFromSupabase({
              force,
              actorUserId: currentUserId || CURRENT_USER_ID,
          });

          if (!result.success) {
              setImportError(result.error || 'Falha ao importar tarefas.');
              return;
          }

          const summary = result.summary || {};
          setImportSummary(
            `Importadas: ${summary.imported || 0} | Atualizadas: ${summary.updated || 0} | Já existentes: ${summary.skippedExisting || 0} | Sem cliente: ${summary.skippedNoCustomer || 0} | Falhas: ${summary.failed || 0}`
          );

          await fetchDataSafe();
      } catch (error) {
          setImportError(error instanceof Error ? error.message : 'Falha ao importar tarefas.');
      } finally {
          setImportingTasks(false);
      }
  };

  const filteredTasks = tasks.filter(t => {
    // Status Filter
    const matchesStatus = 
        filter === 'all' ? true : 
        filter === 'open' ? t.status !== TaskStatus.DONE : 
        t.status === TaskStatus.DONE;

    const matchesPriority =
      priorityFilter === 'all' ? true :
      priorityFilter === 'urgent' ? t.priority === TaskPriority.URGENT :
      t.priority === TaskPriority.NORMAL;

    const matchesAssignee =
      assigneeFilter === 'all' ? true :
      t.assignedUserId === assigneeFilter;

    const matchesVisibility = isAdmin ? true : !!currentUserId && t.assignedUserId === currentUserId;
    
    // Search Filter
    const matchesSearch = 
        t.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (t.customerName && t.customerName.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (t.ownerName && t.ownerName.toLowerCase().includes(searchTerm.toLowerCase()));

    return matchesStatus && matchesPriority && matchesAssignee && matchesVisibility && matchesSearch;
  });

  const getCardTone = (taskId: string) => {
    const tones = [
      'bg-amber-100 border-amber-200',
      'bg-sky-100 border-sky-200',
      'bg-violet-100 border-violet-200',
      'bg-emerald-100 border-emerald-200',
      'bg-rose-100 border-rose-200',
    ];
    const index = taskId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % tones.length;
    return tones[index];
  };

  const statusLabel = (status: TaskStatus) => {
    if (status === TaskStatus.DONE) return 'Concluída';
    if (status === TaskStatus.IN_PROGRESS) return 'Em progresso';
    if (status === TaskStatus.WAITING) return 'A aguardar';
    return 'Pendente';
  };

  const statusBadgeClass = (status: TaskStatus) => {
    if (status === TaskStatus.DONE) return 'bg-emerald-200 text-emerald-800';
    if (status === TaskStatus.IN_PROGRESS) return 'bg-sky-200 text-sky-900';
    if (status === TaskStatus.WAITING) return 'bg-orange-200 text-orange-900';
    return 'bg-red-200 text-red-900';
  };

  const formatAttachmentSize = (bytes: number) => {
    const safeBytes = Number(bytes || 0);
    if (!Number.isFinite(safeBytes) || safeBytes <= 0) return '0 KB';
    if (safeBytes < 1024) return `${safeBytes} B`;
    const kb = safeBytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  };

  const handleQuickStatusToggle = async (task: EnrichedTask) => {
    const nextStatus = task.status === TaskStatus.DONE ? TaskStatus.OPEN : TaskStatus.DONE;
    await mockService.updateTaskStatus(task.id, nextStatus);
    await fetchDataSafe();
  };

  return (
    <div className="w-full space-y-4 p-4 md:p-6">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 text-white shadow-sm md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold md:text-2xl">Tarefas</h1>
            <p className="text-xs text-slate-200 md:text-sm">Gestão e acompanhamento de tarefas operacionais.</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleImportTasks(false)}
              disabled={importingTasks}
              className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/20 disabled:opacity-50 md:text-sm"
            >
              <RefreshCw size={15} className={importingTasks ? 'animate-spin' : ''} />
              {importingTasks ? 'A importar...' : 'Importar'}
            </button>
            <button
              onClick={openCreateModal}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500 md:text-sm"
            >
              <Plus size={16} />
              Nova Tarefa
            </button>
          </div>
        </div>
      </div>

      {importError ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {importError}
        </div>
      ) : null}
      {importSummary ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {importSummary}
        </div>
      ) : null}
      {loadError ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {loadError}
        </div>
      ) : null}

      <div className="rounded-2xl border border-[#d4d6be] bg-[#f0f1e5] p-4 shadow-sm">
        <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
          <div className="relative xl:col-span-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Pesquisar tarefa, cliente ou responsável..."
              className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <select
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            value={filter}
            onChange={(e) => setFilter(e.target.value as 'all' | 'open' | 'done')}
          >
            <option value="open">Pendente</option>
            <option value="done">Concluída</option>
            <option value="all">Todas</option>
          </select>
          <select
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as 'all' | 'normal' | 'urgent')}
          >
            <option value="all">Prioridade: todas</option>
            <option value="urgent">Prioridade: urgente</option>
            <option value="normal">Prioridade: normal</option>
          </select>
        </div>

        <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
          <select
            className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
          >
            <option value="all">{isAdmin ? 'Resp: todos' : 'As minhas tarefas'}</option>
            {(isAdmin ? users : users.filter((u) => u.id === currentUserId)).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>

        {isLoadingTasks ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white/70 p-10 text-center text-sm text-slate-500">
            <div className="inline-flex items-center gap-2">
              <RefreshCw size={15} className="animate-spin" />
              A carregar tarefas...
            </div>
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white/70 p-10 text-center text-sm text-slate-500">
            Nenhuma tarefa encontrada.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-5">
            {filteredTasks.map((task) => (
              <article
                key={task.id}
                className={`min-h-[260px] cursor-pointer rounded-xl border p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${getCardTone(task.id)}`}
                onClick={() => openEditModal(task)}
              >
                <div className="mb-3 flex items-start justify-between gap-2">
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      await handleQuickStatusToggle(task);
                    }}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition hover:brightness-95 ${statusBadgeClass(task.status)}`}
                    title="Clique rápido: alternar Aberta/Concluída"
                  >
                    {statusLabel(task.status)}
                  </button>
                  <span className="rounded-lg bg-white/80 px-2 py-1 text-[11px] font-semibold text-slate-600">
                    Editar
                  </span>
                </div>

                <h3 className="mb-3 line-clamp-2 text-xl font-semibold leading-tight text-slate-900">
                  {task.title}
                </h3>

                <div className="space-y-1.5 text-sm text-slate-800">
                  <p><span className="font-semibold">Cliente:</span> {task.customerName || '-'}</p>
                  <p><span className="font-semibold">Resp:</span> {task.ownerName || '-'}</p>
                  <p className="inline-flex items-center gap-1">
                    <span className="font-semibold">Prioridade:</span>
                    {task.priority === TaskPriority.URGENT ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-700">
                        <AlertTriangle size={11} /> URGENTE
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                        NORMAL
                      </span>
                    )}
                  </p>
                  <p className={`${new Date(task.dueDate) < new Date() && task.status !== TaskStatus.DONE ? 'font-semibold text-red-700' : ''}`}>
                    <span className="font-semibold">Prazo:</span> {new Date(task.dueDate).toLocaleDateString()}
                  </p>
                  {Array.isArray(task.attachments) && task.attachments.length > 0 && (
                    <p className="inline-flex items-center gap-1.5">
                      <Paperclip size={13} />
                      <span className="font-semibold">{task.attachments.length}</span>
                      <span>anexo(s)</span>
                    </p>
                  )}
                </div>

                {task.notes ? (
                  <div className="mt-4 rounded-lg bg-white/70 px-2.5 py-2 text-xs text-slate-700">
                    {task.notes}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </div>

      {/* Edit/Create Task Modal */}
      {isEditModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
           <div className="bg-white rounded-lg w-full max-w-lg p-6 shadow-xl">
              <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                 {selectedTask ? <Edit3 size={20} className="text-whatsapp-600" /> : <Plus size={20} className="text-whatsapp-600" />} 
                 {selectedTask ? 'Editar Tarefa' : 'Nova Tarefa'}
              </h2>
              <form onSubmit={handleSave} className="space-y-4">
                 
                 {/* Select Customer (Only when creating) */}
                 {!selectedTask && (
                     <div>
                        <label className="block text-sm font-medium text-gray-700">Cliente Associado</label>
                        <input
                            required
                            list="task-customer-suggestions"
                            className="mt-1 w-full border rounded-md p-2 bg-yellow-50 border-yellow-200"
                            value={selectedCustomerQuery}
                            onChange={(e) => handleCustomerQueryChange(e.target.value)}
                            placeholder="Escreva para sugerir cliente por nome..."
                        />
                        <datalist id="task-customer-suggestions">
                            {filteredCustomerSuggestions.map((customer) => (
                                <option key={customer.id} value={customerLabel(customer)} />
                            ))}
                        </datalist>
                        <p className="text-xs text-gray-500 mt-1">
                          {selectedCustomerForCreate
                            ? `Cliente selecionado: ${customerLabel(selectedCustomerForCreate)}`
                            : 'A tarefa ficará associada à conversa do cliente escolhido na sugestão.'}
                        </p>
                     </div>
                 )}

                 {selectedTask && (
                     <div className="bg-gray-50 p-2 rounded text-sm text-gray-600 mb-2">
                         <span className="font-bold">Cliente:</span> {selectedTask.customerName}
                     </div>
                 )}

                 <div>
                    <label className="block text-sm font-medium text-gray-700">Assunto</label>
                    <input 
                       required 
                       type="text" 
                       placeholder="Ex: Enviar orçamento retificado"
                       className="mt-1 w-full border rounded-md p-2" 
                       value={editFormData.title} 
                       onChange={e => setEditFormData({...editFormData, title: e.target.value})} 
                    />
                 </div>
                 
                 <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700">Responsável</label>
                        <select 
                            className="mt-1 w-full border rounded-md p-2"
                            value={editFormData.assignedUserId}
                            onChange={e => setEditFormData({...editFormData, assignedUserId: e.target.value})}
                        >
                            {(isAdmin ? users : users.filter((u) => u.id === currentUserId)).map(u => (
                                <option key={u.id} value={u.id}>{u.name}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700">Prioridade</label>
                        <select 
                            className="mt-1 w-full border rounded-md p-2"
                            value={editFormData.priority}
                            onChange={e => setEditFormData({...editFormData, priority: e.target.value as TaskPriority})}
                        >
                            <option value={TaskPriority.NORMAL}>Normal</option>
                            <option value={TaskPriority.URGENT}>Urgente</option>
                        </select>
                    </div>
                 </div>

                 <div className="grid grid-cols-2 gap-4">
                     <div>
                        <label className="block text-sm font-medium text-gray-700">Prazo</label>
                        <input 
                           type="date" 
                           className="mt-1 w-full border rounded-md p-2" 
                           value={editFormData.dueDate} 
                           onChange={e => setEditFormData({...editFormData, dueDate: e.target.value})} 
                        />
                     </div>
                     <div>
                        <label className="block text-sm font-medium text-gray-700">Estado</label>
                         <button
                           type="button"
                           onClick={() => setEditFormData({
                             ...editFormData,
                             status: editFormData.status === TaskStatus.DONE ? TaskStatus.OPEN : TaskStatus.DONE,
                           })}
                           className={`mt-1 w-full rounded-md border px-3 py-2 text-sm font-semibold transition ${editFormData.status === TaskStatus.DONE ? 'border-emerald-300 bg-emerald-100 text-emerald-900 hover:bg-emerald-200' : 'border-amber-300 bg-amber-100 text-amber-900 hover:bg-amber-200'}`}
                           title="Clique para alternar estado"
                         >
                           {editFormData.status === TaskStatus.DONE ? 'Concluída' : 'Aberta'}
                         </button>
                     </div>
                 </div>
                 <div>
                    <label className="block text-sm font-medium text-gray-700">Notas</label>
                    <textarea 
                       className="mt-1 w-full border rounded-md p-2 h-24 resize-none" 
                       placeholder="Detalhes adicionais..."
                       value={editFormData.notes}
                       onChange={e => setEditFormData({...editFormData, notes: e.target.value})}
                    />
                 </div>

                 <div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="block text-sm font-medium text-gray-700">Anexos</label>
                      <button
                        type="button"
                        onClick={() => taskAttachmentInputRef.current?.click()}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        <Paperclip size={14} />
                        Anexar
                      </button>
                    </div>
                    <input
                      ref={taskAttachmentInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip"
                      onChange={(event) => void handleTaskAttachmentInput(event)}
                    />
                    <p className="mt-1 text-xs text-gray-500">Máximo 12 anexos (até 8MB por ficheiro).</p>
                    {editFormData.attachments.length > 0 ? (
                      <div className="mt-2 max-h-36 space-y-1 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-2">
                        {editFormData.attachments.map((attachment) => (
                          <div key={attachment.id} className="flex items-center justify-between gap-2 rounded bg-white px-2 py-1.5 text-xs">
                            <a
                              href={attachment.dataUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate text-blue-700 hover:underline"
                              title={attachment.name}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {attachment.name}
                            </a>
                            <div className="flex items-center gap-2">
                              <span className="text-gray-500">{formatAttachmentSize(attachment.size)}</span>
                              <button
                                type="button"
                                onClick={() => removeTaskAttachment(attachment.id)}
                                className="text-red-600 hover:text-red-700"
                                title="Remover anexo"
                              >
                                <X size={14} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 rounded-md border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                        Sem anexos nesta tarefa.
                      </div>
                    )}
                 </div>

                 <div className="flex justify-end gap-2 mt-6">
                    {selectedTask ? (
                      <button
                        type="button"
                        onClick={() => void handleDeleteTask()}
                        disabled={isSavingTask || isDeletingTask}
                        className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Trash2 size={14} />
                        {isDeletingTask ? 'A eliminar...' : 'Eliminar'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setIsEditModalOpen(false)}
                      disabled={isSavingTask || isDeletingTask}
                      className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-md disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={isSavingTask || isDeletingTask}
                      className="px-4 py-2 bg-whatsapp-600 text-white rounded-md hover:bg-whatsapp-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSavingTask ? 'A guardar...' : 'Guardar'}
                    </button>
                 </div>
              </form>
           </div>
        </div>
      )}
    </div>
  );
};

export default Tasks;
