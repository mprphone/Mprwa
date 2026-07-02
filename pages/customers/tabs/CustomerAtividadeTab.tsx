import React from 'react';
import { RefreshCw } from 'lucide-react';
import {
  CustomerTaskSummary,
  CustomerOccurrenceSummary,
  formatDateOnly,
  formatTaskStatus,
  formatOccurrenceStatus,
  getTaskStatusBadgeClass,
  getOccurrenceStatusBadgeClass,
} from '../customerHelpers';

// Separador "Atividade" do modal de cliente (tarefas + ocorrências). Extraído de
// Customers.tsx sem alterar lógica: recebe os dados já calculados e callbacks de
// navegação/refresh via props.
type Props = {
  customerId: string;
  loading: boolean;
  error: string;
  taskOpenCount: number;
  taskClosedCount: number;
  occurrenceOpenCount: number;
  occurrenceClosedCount: number;
  tasks: CustomerTaskSummary[];
  occurrences: CustomerOccurrenceSummary[];
  onReload: () => void;
  onOpenTask: (taskId: string) => void;
  onOpenOccurrence: (occurrenceId: string) => void;
};

export const CustomerAtividadeTab: React.FC<Props> = ({
  customerId,
  loading,
  error,
  taskOpenCount,
  taskClosedCount,
  occurrenceOpenCount,
  occurrenceClosedCount,
  tasks,
  occurrences,
  onReload,
  onOpenTask,
  onOpenOccurrence,
}) => (
  <div className="space-y-4">
    {!customerId ? (
      <p className="text-sm text-gray-500">Guarde primeiro o cliente para consultar tarefas e ocorrências.</p>
    ) : (
      <>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-slate-800">Histórico operacional do cliente</div>
              <div className="text-xs text-slate-500">Inclui abertas e fechadas.</div>
            </div>
            <button
              type="button"
              onClick={onReload}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw size={13} />
              {loading ? 'A atualizar...' : 'Atualizar'}
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            <div className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs text-blue-700">
              Tarefas abertas: <span className="font-semibold">{taskOpenCount}</span>
            </div>
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700">
              Tarefas fechadas: <span className="font-semibold">{taskClosedCount}</span>
            </div>
            <div className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs text-blue-700">
              Ocorrências abertas: <span className="font-semibold">{occurrenceOpenCount}</span>
            </div>
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700">
              Ocorrências fechadas: <span className="font-semibold">{occurrenceClosedCount}</span>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="rounded-lg border border-slate-200 bg-white p-3">
            <h3 className="text-sm font-semibold text-slate-800">Tarefas ({tasks.length})</h3>
            <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
              {!loading && tasks.length === 0 && (
                <p className="text-xs text-slate-500">Sem tarefas para este cliente.</p>
              )}
              {tasks.map((task) => (
                <button
                  key={`task-${task.id}`}
                  type="button"
                  onClick={() => {
                    const taskId = String(task.id || '').trim();
                    if (!taskId) return;
                    onOpenTask(taskId);
                  }}
                  className="w-full rounded-md border border-slate-200 bg-slate-50 p-2 text-left hover:border-blue-200 hover:bg-blue-50/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-800" title={task.title}>{task.title}</div>
                      <div className="mt-0.5 text-xs text-slate-600">
                        Prazo: {formatDateOnly(task.dueDate)} • Resp: {task.assignedUserName}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getTaskStatusBadgeClass(task.status)}`}>
                      {formatTaskStatus(task.status)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-3">
            <h3 className="text-sm font-semibold text-slate-800">Ocorrências ({occurrences.length})</h3>
            <div className="mt-2 max-h-80 space-y-2 overflow-y-auto">
              {!loading && occurrences.length === 0 && (
                <p className="text-xs text-slate-500">Sem ocorrências para este cliente.</p>
              )}
              {occurrences.map((occurrence) => (
                <button
                  key={`occ-${occurrence.id}`}
                  type="button"
                  onClick={() => {
                    const occurrenceId = String(occurrence.id || '').trim();
                    if (!occurrenceId) return;
                    onOpenOccurrence(occurrenceId);
                  }}
                  className="w-full rounded-md border border-slate-200 bg-slate-50 p-2 text-left hover:border-blue-200 hover:bg-blue-50/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-800" title={occurrence.title}>{occurrence.title}</div>
                      <div className="mt-0.5 text-xs text-slate-600">
                        Tipo: {occurrence.typeName} • Data: {formatDateOnly(occurrence.date)} • Prazo: {formatDateOnly(occurrence.dueDate)}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-600">Resp: {occurrence.responsibleNames}</div>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${getOccurrenceStatusBadgeClass(occurrence.state)}`}>
                      {formatOccurrenceStatus(occurrence.state)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </div>
      </>
    )}
  </div>
);
