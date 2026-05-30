import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock, Edit3, Inbox, Mail, MapPin, Plus, RefreshCw, Search, Trash2, Users, X } from 'lucide-react';
import { mockService } from '../services/mockData';
import { AgendaEvent, AgendaEventType, Customer, Role, User } from '../types';

interface EnrichedAgendaEvent extends AgendaEvent {
  customerName?: string;
  assignedUserName?: string;
}

interface AssistantEntryRow {
  mailbox: string;
  uid: string;
  actionType: string;
  entityType: string;
  entityId: string;
  subject: string;
  fromEmail: string;
  status: string;
  error: string;
  rawText: string;
  parsedFields: Record<string, string>;
  reviewedFields: Record<string, string>;
  ignoredAt: string;
  processedAt: string;
}

interface AssistantEntrySummary {
  processed: number;
  pending: number;
  error: number;
  total: number;
}

const EVENT_TYPE_LABELS: Record<AgendaEventType, string> = {
  meeting: 'Reunião',
  visit: 'Visita',
  call: 'Chamada',
  other: 'Outro',
};

const EVENT_TYPE_STYLES: Record<AgendaEventType, string> = {
  meeting: 'border-blue-200 bg-blue-50 text-blue-800',
  visit: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  call: 'border-amber-200 bg-amber-50 text-amber-800',
  other: 'border-slate-200 bg-slate-50 text-slate-700',
};

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function isoDay(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function toDateInput(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return isoDay(date);
}

function toTimeInput(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function combineLocalDateTime(date: string, time: string) {
  return new Date(`${date}T${time || '09:00'}:00`).toISOString();
}

function formatTimeRange(event: AgendaEvent) {
  const starts = new Date(event.startsAt);
  const ends = new Date(event.endsAt);
  if (!Number.isFinite(starts.getTime())) return '';
  const startText = starts.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  const endText = Number.isFinite(ends.getTime())
    ? ends.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
    : '';
  return endText ? `${startText} - ${endText}` : startText;
}

function buildMonthCells(monthDate: Date) {
  const first = startOfMonth(monthDate);
  const firstWeekday = (first.getDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - firstWeekday);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });
}

function normalizeSearch(value: string) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

const Agenda: React.FC = () => {
  const currentUser = mockService.getCurrentUser();
  const currentUserId = String(mockService.getCurrentUserId() || currentUser?.id || '').trim();
  const [events, setEvents] = useState<EnrichedAgendaEvent[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [monthDate, setMonthDate] = useState(() => startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState(() => isoDay(new Date()));
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | AgendaEventType>('all');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'calendar' | 'assistant'>('calendar');
  const [assistantRows, setAssistantRows] = useState<AssistantEntryRow[]>([]);
  const [assistantSummary, setAssistantSummary] = useState<AssistantEntrySummary>({ processed: 0, pending: 0, error: 0, total: 0 });
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [assistantScanLoading, setAssistantScanLoading] = useState(false);
  const [assistantError, setAssistantError] = useState('');
  const [editingAssistantRow, setEditingAssistantRow] = useState<AssistantEntryRow | null>(null);
  const [assistantEditAction, setAssistantEditAction] = useState('agenda');
  const [assistantEditJson, setAssistantEditJson] = useState('{}');
  const [assistantEditSaving, setAssistantEditSaving] = useState(false);
  const [editingEvent, setEditingEvent] = useState<EnrichedAgendaEvent | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    type: 'meeting' as AgendaEventType,
    customerId: '',
    assignedUserId: currentUserId,
    date: selectedDay,
    startTime: '09:00',
    endTime: '10:00',
    location: '',
    notes: '',
  });

  const isAdmin = (users.find((user) => user.id === currentUserId)?.role || currentUser?.role) === Role.ADMIN;

  const customerLabel = (customer: Customer) => {
    const name = String(customer.name || '').trim();
    const company = String(customer.company || '').trim();
    if (!company || company.toLowerCase() === name.toLowerCase()) return name;
    return `${name} (${company})`;
  };

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [agendaEvents, allUsers, allCustomers] = await Promise.all([
        mockService.getAgendaEvents(),
        mockService.getUsers(),
        mockService.getCustomers(),
      ]);
      setUsers(allUsers);
      setCustomers(allCustomers);
      setEvents(agendaEvents.map((event) => {
        const customer = allCustomers.find((item) => item.id === event.customerId);
        const assignedUser = allUsers.find((item) => item.id === event.assignedUserId);
        return {
          ...event,
          customerName: customer ? customerLabel(customer) : '',
          assignedUserName: assignedUser?.name || '',
        };
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Falha ao carregar agenda.');
    } finally {
      setLoading(false);
    }
  };

  const loadAssistantEntry = async () => {
    setAssistantLoading(true);
    setAssistantError('');
    try {
      const response = await fetch('/api/agenda/assistant-entry?limit=100', {
        headers: { Accept: 'application/json' },
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        summary?: AssistantEntrySummary;
        data?: AssistantEntryRow[];
        error?: unknown;
      };
      if (!response.ok || !payload.success) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `Falha ao carregar entrada (${response.status}).`);
      }
      setAssistantSummary(payload.summary || { processed: 0, pending: 0, error: 0, total: 0 });
      setAssistantRows(Array.isArray(payload.data) ? payload.data : []);
    } catch (loadError) {
      setAssistantError(loadError instanceof Error ? loadError.message : 'Falha ao carregar Entrada Assistente.');
    } finally {
      setAssistantLoading(false);
    }
  };

  const scanAssistantMailbox = async () => {
    setAssistantScanLoading(true);
    setAssistantError('');
    try {
      const response = await fetch('/api/email/automation/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxMessages: 50 }),
      });
      const payload = await response.json().catch(() => ({})) as {
        success?: boolean;
        error?: unknown;
      };
      if (!response.ok || !payload.success) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `Falha ao ler mailbox (${response.status}).`);
      }
      await Promise.all([loadAssistantEntry(), loadData()]);
    } catch (scanError) {
      setAssistantError(scanError instanceof Error ? scanError.message : 'Falha ao ler mailbox da Agenda.');
    } finally {
      setAssistantScanLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    if (activeTab === 'assistant') {
      void loadAssistantEntry();
    }
  }, [activeTab]);

  const visibleEvents = useMemo(() => {
    const term = normalizeSearch(searchTerm);
    return events.filter((event) => {
      if (!isAdmin && event.assignedUserId !== currentUserId) return false;
      if (assigneeFilter !== 'all' && event.assignedUserId !== assigneeFilter) return false;
      if (typeFilter !== 'all' && event.type !== typeFilter) return false;
      if (!term) return true;
      return [event.title, event.customerName, event.assignedUserName, event.location, event.notes]
        .some((value) => normalizeSearch(String(value || '')).includes(term));
    });
  }, [assigneeFilter, currentUserId, events, isAdmin, searchTerm, typeFilter]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, EnrichedAgendaEvent[]>();
    visibleEvents.forEach((event) => {
      const key = toDateInput(event.startsAt);
      if (!key) return;
      map.set(key, [...(map.get(key) || []), event]);
    });
    map.forEach((items, key) => {
      map.set(key, [...items].sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime()));
    });
    return map;
  }, [visibleEvents]);

  const selectedDayEvents = eventsByDay.get(selectedDay) || [];
  const monthCells = useMemo(() => buildMonthCells(monthDate), [monthDate]);
  const today = isoDay(new Date());
  const monthTitle = monthDate.toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });

  const openCreateModal = (day = selectedDay) => {
    setEditingEvent(null);
    setFormData({
      title: '',
      type: 'meeting',
      customerId: '',
      assignedUserId: currentUserId || users[0]?.id || '',
      date: day,
      startTime: '09:00',
      endTime: '10:00',
      location: '',
      notes: '',
    });
    setIsModalOpen(true);
  };

  const openEditModal = (event: EnrichedAgendaEvent) => {
    setEditingEvent(event);
    setFormData({
      title: event.title,
      type: event.type,
      customerId: event.customerId || '',
      assignedUserId: event.assignedUserId,
      date: toDateInput(event.startsAt),
      startTime: toTimeInput(event.startsAt),
      endTime: toTimeInput(event.endsAt),
      location: event.location || '',
      notes: event.notes || '',
    });
    setIsModalOpen(true);
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    const startsAt = combineLocalDateTime(formData.date, formData.startTime);
    const endsAt = combineLocalDateTime(formData.date, formData.endTime);
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      alert('A hora de fim tem de ser posterior à hora de início.');
      return;
    }
    const payload = {
      title: formData.title.trim(),
      type: formData.type,
      customerId: formData.customerId || undefined,
      assignedUserId: formData.assignedUserId || currentUserId,
      startsAt,
      endsAt,
      location: formData.location.trim(),
      notes: formData.notes.trim(),
    };

    if (!payload.title) {
      alert('Preencha o assunto do evento.');
      return;
    }

    if (editingEvent) {
      await mockService.updateAgendaEvent(editingEvent.id, payload);
    } else {
      await mockService.createAgendaEvent(payload);
    }
    setSelectedDay(formData.date);
    setIsModalOpen(false);
    await loadData();
  };

  const handleDelete = async () => {
    if (!editingEvent) return;
    const confirmed = window.confirm(`Eliminar "${editingEvent.title}" da agenda?`);
    if (!confirmed) return;
    await mockService.deleteAgendaEvent(editingEvent.id);
    setIsModalOpen(false);
    await loadData();
  };

  const assistantActionLabel = (value: string) => {
    if (value === 'agenda') return 'Agenda';
    if (value === 'task') return 'Tarefa';
    if (value === 'occurrence') return 'Ocorrência';
    if (value === 'customer_note') return 'Nota';
    return 'Por classificar';
  };

  const assistantStatusTone = (status: string) => {
    if (status === 'processed') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
    if (status === 'error') return 'border-rose-200 bg-rose-50 text-rose-800';
    if (status === 'ignored') return 'border-slate-200 bg-slate-50 text-slate-600';
    return 'border-amber-200 bg-amber-50 text-amber-800';
  };

  const assistantStatusLabel = (status: string) => {
    if (status === 'processed') return 'A verde';
    if (status === 'error') return 'Erro';
    if (status === 'ignored') return 'Ignorado';
    return 'Pendente';
  };

  const openAssistantEdit = (row: AssistantEntryRow) => {
    const fields = Object.keys(row.reviewedFields || {}).length > 0
      ? row.reviewedFields
      : row.parsedFields || {};
    setEditingAssistantRow(row);
    setAssistantEditAction(row.actionType || 'agenda');
    setAssistantEditJson(JSON.stringify(fields, null, 2));
  };

  const reprocessAssistantEntry = async () => {
    if (!editingAssistantRow) return;
    setAssistantEditSaving(true);
    setAssistantError('');
    try {
      const fields = JSON.parse(assistantEditJson || '{}');
      const response = await fetch(`/api/email/automation/entries/${encodeURIComponent(editingAssistantRow.uid)}/reprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionType: assistantEditAction, fields }),
      });
      const payload = await response.json().catch(() => ({})) as { success?: boolean; error?: unknown };
      if (!response.ok || !payload.success) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `Falha ao reprocessar (${response.status}).`);
      }
      setEditingAssistantRow(null);
      await Promise.all([loadAssistantEntry(), loadData()]);
    } catch (saveError) {
      setAssistantError(saveError instanceof Error ? saveError.message : 'Falha ao reprocessar entrada.');
    } finally {
      setAssistantEditSaving(false);
    }
  };

  const ignoreAssistantEntry = async () => {
    if (!editingAssistantRow) return;
    setAssistantEditSaving(true);
    setAssistantError('');
    try {
      const response = await fetch(`/api/email/automation/entries/${encodeURIComponent(editingAssistantRow.uid)}/ignore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Ignorado manualmente na Entrada Assistente.' }),
      });
      const payload = await response.json().catch(() => ({})) as { success?: boolean; error?: unknown };
      if (!response.ok || !payload.success) {
        throw new Error(typeof payload.error === 'string' ? payload.error : `Falha ao ignorar (${response.status}).`);
      }
      setEditingAssistantRow(null);
      await loadAssistantEntry();
    } catch (ignoreError) {
      setAssistantError(ignoreError instanceof Error ? ignoreError.message : 'Falha ao ignorar entrada.');
    } finally {
      setAssistantEditSaving(false);
    }
  };

  return (
    <div className="w-full space-y-4 p-4 md:p-6">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-cyan-950 to-slate-800 p-4 text-white shadow-sm md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold md:text-2xl">Agenda</h1>
            <p className="text-xs text-slate-200 md:text-sm">Reuniões, visitas e compromissos com hora marcada.</p>
          </div>
          <button onClick={() => openCreateModal()} className="inline-flex items-center gap-2 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-semibold text-white hover:bg-cyan-500 md:text-sm">
            <Plus size={16} />
            Novo Evento
          </button>
        </div>
      </div>

      {error ? <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">{error}</div> : null}

      <div className="rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => setActiveTab('calendar')}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition ${activeTab === 'calendar' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            <CalendarDays size={16} />
            Calendário
          </button>
          <button
            onClick={() => setActiveTab('assistant')}
            className={`inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition ${activeTab === 'assistant' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            <Inbox size={16} />
            Entrada Assistente
          </button>
        </div>
      </div>

      {activeTab === 'calendar' ? (
        <>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
          <div className="relative xl:col-span-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Pesquisar assunto, cliente, local..." className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm" />
          </div>
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as 'all' | AgendaEventType)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="all">Tipo: todos</option>
            {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="all">{isAdmin ? 'Responsável: todos' : 'A minha agenda'}</option>
            {(isAdmin ? users : users.filter((user) => user.id === currentUserId)).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-3">
            <button onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1))} className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50" title="Mês anterior"><ChevronLeft size={18} /></button>
            <div className="text-center">
              <h2 className="text-lg font-bold capitalize text-slate-900">{monthTitle}</h2>
              <button onClick={() => { const now = new Date(); setMonthDate(startOfMonth(now)); setSelectedDay(isoDay(now)); }} className="text-xs font-semibold text-cyan-700 hover:text-cyan-800">Hoje</button>
            </div>
            <button onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1))} className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50" title="Mês seguinte"><ChevronRight size={18} /></button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-xs font-bold uppercase text-slate-500">
            {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((day) => <div key={day} className="py-2">{day}</div>)}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {monthCells.map((day) => {
              const key = isoDay(day);
              const dayEvents = eventsByDay.get(key) || [];
              const isCurrentMonth = day.getMonth() === monthDate.getMonth();
              const isSelected = selectedDay === key;
              return (
                <button key={key} onClick={() => setSelectedDay(key)} onDoubleClick={() => openCreateModal(key)} className={`min-h-[112px] rounded-xl border p-2 text-left transition hover:border-cyan-300 hover:bg-cyan-50/60 ${isSelected ? 'border-cyan-500 bg-cyan-50 shadow-sm' : 'border-slate-200 bg-white'} ${isCurrentMonth ? '' : 'opacity-45'}`}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold ${key === today ? 'bg-slate-900 text-white' : 'text-slate-700'}`}>{day.getDate()}</span>
                    {dayEvents.length > 0 ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">{dayEvents.length}</span> : null}
                  </div>
                  <div className="space-y-1">
                    {dayEvents.slice(0, 3).map((item) => <div key={item.id} className={`truncate rounded-md border px-2 py-1 text-[11px] font-semibold ${EVENT_TYPE_STYLES[item.type]}`}>{toTimeInput(item.startsAt)} {item.title}</div>)}
                    {dayEvents.length > 3 ? <div className="px-1 text-[11px] font-semibold text-slate-500">+{dayEvents.length - 3}</div> : null}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-slate-900">{new Date(`${selectedDay}T12:00:00`).toLocaleDateString('pt-PT', { day: '2-digit', month: 'long' })}</h2>
              <p className="text-xs text-slate-500">{selectedDayEvents.length} compromisso(s)</p>
            </div>
            <button onClick={() => openCreateModal(selectedDay)} className="rounded-lg border border-cyan-200 bg-cyan-50 p-2 text-cyan-700 hover:bg-cyan-100" title="Adicionar neste dia"><Plus size={17} /></button>
          </div>

          {loading ? <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">A carregar agenda...</div> : selectedDayEvents.length === 0 ? <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">Sem reuniões ou visitas neste dia.</div> : (
            <div className="space-y-3">
              {selectedDayEvents.map((event) => (
                <article key={event.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${EVENT_TYPE_STYLES[event.type]}`}>{EVENT_TYPE_LABELS[event.type]}</span>
                    <button onClick={() => openEditModal(event)} className="rounded-md p-1.5 text-slate-500 hover:bg-white hover:text-slate-900" title="Editar"><Edit3 size={14} /></button>
                  </div>
                  <h3 className="text-sm font-bold text-slate-900">{event.title}</h3>
                  <div className="mt-2 space-y-1.5 text-xs text-slate-600">
                    <p className="flex items-center gap-1.5"><Clock size={13} /> {formatTimeRange(event)}</p>
                    {event.customerName ? <p className="flex items-center gap-1.5"><Users size={13} /> {event.customerName}</p> : null}
                    {event.location ? <p className="flex items-center gap-1.5"><MapPin size={13} /> {event.location}</p> : null}
                    {event.assignedUserName ? <p>Resp: {event.assignedUserName}</p> : null}
                  </div>
                  {event.notes ? <p className="mt-2 rounded-lg bg-white px-2.5 py-2 text-xs text-slate-600">{event.notes}</p> : null}
                </article>
              ))}
            </div>
          )}
        </aside>
      </div>
        </>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase text-slate-500">Total</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">{assistantSummary.total}</p>
            </div>
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase text-emerald-700">A verde</p>
              <p className="mt-1 text-2xl font-bold text-emerald-900">{assistantSummary.processed}</p>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase text-amber-700">Pendentes</p>
              <p className="mt-1 text-2xl font-bold text-amber-900">{assistantSummary.pending}</p>
            </div>
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase text-rose-700">Erros</p>
              <p className="mt-1 text-2xl font-bold text-rose-900">{assistantSummary.error}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Entrada Assistente</h2>
                <p className="text-sm text-slate-500">Emails recebidos de agenda@mpr.pt, ações criadas e pendências para corrigir.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => void loadAssistantEntry()}
                  disabled={assistantLoading || assistantScanLoading}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  <RefreshCw size={15} className={assistantLoading ? 'animate-spin' : ''} />
                  Atualizar
                </button>
                <button
                  onClick={() => void scanAssistantMailbox()}
                  disabled={assistantScanLoading}
                  className="inline-flex items-center gap-2 rounded-lg bg-cyan-700 px-3 py-2 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-50"
                >
                  <Mail size={15} />
                  {assistantScanLoading ? 'A ler...' : 'Ler mailbox agora'}
                </button>
              </div>
            </div>

            {assistantError ? (
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {assistantError}
              </div>
            ) : null}

            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-col gap-2 text-sm text-slate-600 md:flex-row md:items-center md:justify-between">
                <span className="inline-flex items-center gap-2">
                  <CheckCircle2 size={15} className="text-emerald-600" />
                  Outlook: convite por email com ficheiro .ics ativo.
                </span>
                <span className="inline-flex items-center gap-2">
                  <AlertTriangle size={15} className="text-amber-600" />
                  Criação direta no calendário Microsoft 365 ainda precisa de ligação Graph/OAuth.
                </span>
              </div>
            </div>

            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
              <div className="grid grid-cols-[120px_minmax(160px,1fr)_120px_120px_140px_110px] gap-3 bg-slate-100 px-3 py-2 text-xs font-bold uppercase text-slate-500">
                <span>Estado</span>
                <span>Assunto</span>
                <span>Tipo</span>
                <span>Entidade</span>
                <span>Data</span>
                <span>Ação</span>
              </div>
              {assistantLoading ? (
                <div className="p-8 text-center text-sm text-slate-500">A carregar entrada...</div>
              ) : assistantRows.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">Ainda não há emails processados.</div>
              ) : (
                <div className="divide-y divide-slate-200 bg-white">
                  {assistantRows.map((row) => (
                    <article key={`${row.mailbox}_${row.uid}`} className="grid grid-cols-1 gap-2 px-3 py-3 text-sm md:grid-cols-[120px_minmax(160px,1fr)_120px_120px_140px_110px] md:gap-3">
                      <div>
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-bold ${assistantStatusTone(row.status)}`}>
                          {assistantStatusLabel(row.status)}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900">{row.subject || '(sem assunto)'}</p>
                        <p className="truncate text-xs text-slate-500">{row.fromEmail || row.mailbox}</p>
                        {row.error ? <p className="mt-1 text-xs text-amber-700">{row.error}</p> : null}
                      </div>
                      <p className="text-slate-700">{assistantActionLabel(row.actionType)}</p>
                      <p className="truncate text-slate-600">{row.entityType ? `${row.entityType} ${row.entityId}` : '-'}</p>
                      <p className="text-xs text-slate-500">{row.processedAt ? new Date(row.processedAt).toLocaleString('pt-PT') : '-'}</p>
                      <button
                        onClick={() => openAssistantEdit(row)}
                        className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Abrir
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {editingAssistantRow ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-3xl rounded-xl bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Rever Entrada Assistente</h2>
                <p className="text-sm text-slate-500">{editingAssistantRow.subject || '(sem assunto)'} · UID {editingAssistantRow.uid}</p>
              </div>
              <button onClick={() => setEditingAssistantRow(null)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" title="Fechar">
                <X size={18} />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700">Tipo</label>
                  <select
                    value={assistantEditAction}
                    onChange={(event) => setAssistantEditAction(event.target.value)}
                    className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm"
                  >
                    <option value="agenda">Agenda</option>
                    <option value="task">Tarefa</option>
                    <option value="occurrence">Ocorrência</option>
                    <option value="customer_note">Nota</option>
                  </select>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                  <p><span className="font-semibold">De:</span> {editingAssistantRow.fromEmail || '-'}</p>
                  <p><span className="font-semibold">Estado:</span> {assistantStatusLabel(editingAssistantRow.status)}</p>
                  {editingAssistantRow.error ? <p className="mt-2 text-amber-700">{editingAssistantRow.error}</p> : null}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700">JSON a processar</label>
                <textarea
                  value={assistantEditJson}
                  onChange={(event) => setAssistantEditJson(event.target.value)}
                  className="mt-1 h-80 w-full rounded-md border border-slate-300 p-3 font-mono text-xs"
                  spellCheck={false}
                />
              </div>
            </div>

            {editingAssistantRow.rawText ? (
              <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-slate-700">Ver texto original</summary>
                <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-slate-600">{editingAssistantRow.rawText}</pre>
              </details>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => void ignoreAssistantEntry()}
                disabled={assistantEditSaving}
                className="rounded-md border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                Ignorar
              </button>
              <button
                type="button"
                onClick={() => setEditingAssistantRow(null)}
                disabled={assistantEditSaving}
                className="rounded-md px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void reprocessAssistantEntry()}
                disabled={assistantEditSaving}
                className="rounded-md bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-50"
              >
                {assistantEditSaving ? 'A processar...' : 'Processar'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900"><CalendarDays size={20} className="text-cyan-700" />{editingEvent ? 'Editar Evento' : 'Novo Evento'}</h2>
              <button onClick={() => setIsModalOpen(false)} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" title="Fechar"><X size={18} /></button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700">Assunto</label>
                <input required value={formData.title} onChange={(event) => setFormData({ ...formData, title: event.target.value })} placeholder="Ex: Reunião de planeamento fiscal" className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm" />
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-slate-700">Tipo</label>
                  <select value={formData.type} onChange={(event) => setFormData({ ...formData, type: event.target.value as AgendaEventType })} className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm">
                    {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700">Responsável</label>
                  <select value={formData.assignedUserId} onChange={(event) => setFormData({ ...formData, assignedUserId: event.target.value })} className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm">
                    {(isAdmin ? users : users.filter((user) => user.id === currentUserId)).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <div><label className="block text-sm font-medium text-slate-700">Data</label><input required type="date" value={formData.date} onChange={(event) => setFormData({ ...formData, date: event.target.value })} className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm" /></div>
                <div><label className="block text-sm font-medium text-slate-700">Início</label><input required type="time" value={formData.startTime} onChange={(event) => setFormData({ ...formData, startTime: event.target.value })} className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm" /></div>
                <div><label className="block text-sm font-medium text-slate-700">Fim</label><input required type="time" value={formData.endTime} onChange={(event) => setFormData({ ...formData, endTime: event.target.value })} className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm" /></div>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-slate-700">Cliente</label>
                  <select value={formData.customerId} onChange={(event) => setFormData({ ...formData, customerId: event.target.value })} className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm">
                    <option value="">Sem cliente associado</option>
                    {customers.map((customer) => <option key={customer.id} value={customer.id}>{customerLabel(customer)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700">Local</label>
                  <input value={formData.location} onChange={(event) => setFormData({ ...formData, location: event.target.value })} placeholder="Escritório, Teams, morada do cliente..." className="mt-1 w-full rounded-md border border-slate-300 p-2 text-sm" />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700">Notas</label>
                <textarea value={formData.notes} onChange={(event) => setFormData({ ...formData, notes: event.target.value })} className="mt-1 h-24 w-full resize-none rounded-md border border-slate-300 p-2 text-sm" placeholder="Contexto útil para a reunião ou visita..." />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                {editingEvent ? <button type="button" onClick={() => void handleDelete()} className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-100"><Trash2 size={14} />Eliminar</button> : null}
                <button type="button" onClick={() => setIsModalOpen(false)} className="rounded-md px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100">Cancelar</button>
                <button type="submit" className="rounded-md bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-600">Guardar</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default Agenda;
