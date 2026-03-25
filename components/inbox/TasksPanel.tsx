import React from 'react';
import { AlertTriangle, Paperclip, X } from 'lucide-react';
import { Customer, Task, TaskAttachment, TaskPriority, TaskStatus, User } from '../../types';
import type { OccurrenceRow } from '../../services/occurrencesApi';

type TasksPanelProps = {
  selectedCustomer: Customer | null;
  users: User[];
  tasks: Task[];
  showTaskForm: boolean;
  newTaskTitle: string;
  newTaskAssignee: string;
  newTaskPriority: TaskPriority;
  newTaskAttachments: TaskAttachment[];
  duplicateWarning: string | null;
  onToggleTaskForm: () => void;
  onCreateTask: (event: React.FormEvent) => void;
  onCancelTaskForm: () => void;
  onTaskTitleChange: (value: string) => void;
  onTaskAssigneeChange: (value: string) => void;
  onTaskPriorityChange: (value: TaskPriority) => void;
  onTaskAttachmentsSelected: (files: FileList | null) => void;
  onRemoveTaskAttachment: (attachmentId: string) => void;
  onToggleTaskStatus: (task: Task) => void;
  openOccurrences: OccurrenceRow[];
  openOccurrencesLoading: boolean;
  openOccurrencesError: string | null;
};

const TasksPanel: React.FC<TasksPanelProps> = ({
  selectedCustomer,
  users,
  tasks,
  showTaskForm,
  newTaskTitle,
  newTaskAssignee,
  newTaskPriority,
  newTaskAttachments,
  duplicateWarning,
  onToggleTaskForm,
  onCreateTask,
  onCancelTaskForm,
  onTaskTitleChange,
  onTaskAssigneeChange,
  onTaskPriorityChange,
  onTaskAttachmentsSelected,
  onRemoveTaskAttachment,
  onToggleTaskStatus,
  openOccurrences,
  openOccurrencesLoading,
  openOccurrencesError,
}) => {
  const taskAttachmentInputRef = React.useRef<HTMLInputElement>(null);

  const formatDate = (value?: string | null) => {
    const raw = String(value || '').trim();
    if (!raw) return 'Sem data';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleDateString('pt-PT');
  };

  return (
    <div className="p-4 flex-1">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold text-sm text-gray-700">Tarefas / Assuntos</h3>
        <button onClick={onToggleTaskForm} className="text-whatsapp-600 text-xs font-medium hover:underline">
          + Nova
        </button>
      </div>

      {showTaskForm && (
        <div className="mb-4 bg-gray-50 p-3 rounded-lg border border-gray-200 shadow-sm">
          <form onSubmit={onCreateTask}>
            <input
              type="text"
              autoFocus
              className="w-full text-sm border border-gray-300 rounded p-1 mb-2 focus:ring-1 focus:ring-whatsapp-500 focus:outline-none"
              placeholder="Assunto da tarefa..."
              value={newTaskTitle}
              onChange={(event) => onTaskTitleChange(event.target.value)}
            />

            <div className="grid grid-cols-2 gap-2 mb-2">
              <select
                value={newTaskAssignee}
                onChange={(event) => onTaskAssigneeChange(event.target.value)}
                className="text-xs border border-gray-300 rounded p-1 bg-white"
              >
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name} {user.id === selectedCustomer?.ownerId ? '(Resp.)' : ''}
                  </option>
                ))}
              </select>
              <select
                value={newTaskPriority}
                onChange={(event) => onTaskPriorityChange(event.target.value as TaskPriority)}
                className={`text-xs border border-gray-300 rounded p-1 bg-white ${newTaskPriority === TaskPriority.URGENT ? 'text-red-600 font-bold' : ''}`}
              >
                <option value={TaskPriority.NORMAL}>Normal</option>
                <option value={TaskPriority.URGENT}>Urgente</option>
              </select>
            </div>

            {duplicateWarning && (
              <div className="flex items-start gap-1 text-xs text-yellow-600 mb-2 bg-yellow-50 p-1.5 rounded">
                <AlertTriangle size={12} className="mt-0.5" />
                <span>{duplicateWarning}</span>
              </div>
            )}

            <div className="mb-2">
              <input
                ref={taskAttachmentInputRef}
                type="file"
                multiple
                className="hidden"
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip"
                onChange={(event) => {
                  onTaskAttachmentsSelected(event.target.files);
                  event.currentTarget.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => taskAttachmentInputRef.current?.click()}
                className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
              >
                <Paperclip size={12} />
                Anexar
              </button>
              {newTaskAttachments.length > 0 && (
                <div className="mt-2 space-y-1 rounded border border-gray-200 bg-white p-2">
                  {newTaskAttachments.map((attachment) => (
                    <div key={attachment.id} className="flex items-center justify-between gap-2 text-[11px] text-gray-700">
                      <span className="truncate" title={attachment.name}>{attachment.name}</span>
                      <button
                        type="button"
                        onClick={() => onRemoveTaskAttachment(attachment.id)}
                        className="text-red-600 hover:text-red-700"
                        title="Remover anexo"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onCancelTaskForm}
                className="text-xs text-gray-500 px-2 py-1 hover:bg-gray-200 rounded"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={!newTaskTitle}
                className="text-xs bg-whatsapp-600 text-white px-3 py-1 rounded hover:bg-whatsapp-700"
              >
                Guardar
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="space-y-3">
        {tasks.length > 0 ? (
          tasks.map((task) => (
            <div
              key={task.id}
              className={`p-3 border rounded-lg ${task.status === TaskStatus.DONE ? 'bg-green-50 border-green-200' : 'bg-gray-50'} ${task.priority === TaskPriority.URGENT && task.status !== TaskStatus.DONE ? 'border-red-200 bg-red-50' : 'border-gray-200'}`}
            >
              <div className="flex justify-between items-start mb-1">
                <div className="flex-1">
                  <span
                    className={`text-xs font-medium ${task.priority === TaskPriority.URGENT && task.status !== TaskStatus.DONE ? 'text-red-800' : 'text-gray-900'} ${task.status === TaskStatus.DONE ? 'text-green-700' : ''}`}
                  >
                    {task.title}
                  </span>
                  {task.priority === TaskPriority.URGENT && task.status !== TaskStatus.DONE && (
                    <span className="ml-2 text-[8px] bg-red-200 text-red-800 px-1 rounded">URGENTE</span>
                  )}
                  {Array.isArray(task.attachments) && task.attachments.length > 0 && (
                    <div className="mt-1 inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-1.5 py-0.5 text-[10px] text-gray-600">
                      <Paperclip size={10} />
                      {task.attachments.length}
                    </div>
                  )}
                </div>
                <input
                  type="checkbox"
                  checked={task.status === TaskStatus.DONE}
                  onChange={() => onToggleTaskStatus(task)}
                  className="mt-0.5 rounded text-whatsapp-600 focus:ring-whatsapp-500"
                  title="Marcar como concluída"
                />
              </div>
              <div className="flex justify-between items-center mt-2">
                <div className="flex items-center gap-1">
                  <div
                    className={`w-4 h-4 rounded-full text-[8px] flex items-center justify-center ${task.status === TaskStatus.DONE ? 'bg-green-200 text-green-700' : 'bg-gray-300 text-gray-600'}`}
                    title="Responsável"
                  >
                    {users.find((user) => user.id === task.assignedUserId)?.name.charAt(0)}
                  </div>
                  <span className="text-[10px] text-gray-500">
                    {users.find((user) => user.id === task.assignedUserId)?.name.split(' ')[0]}
                  </span>
                </div>
                <p className="text-[10px] text-gray-500">{new Date(task.dueDate).toLocaleDateString()}</p>
              </div>
            </div>
          ))
        ) : (
          <p className="text-xs text-gray-400 italic text-center py-4">Sem tarefas abertas.</p>
        )}
      </div>

      <div className="mt-5 pt-4 border-t border-gray-200">
        <h4 className="font-semibold text-sm text-gray-700 mb-3">Ocorrências Abertas</h4>
        {openOccurrencesError && (
          <p className="text-xs text-red-600 mb-2">{openOccurrencesError}</p>
        )}
        {openOccurrencesLoading ? (
          <p className="text-xs text-gray-400 italic">A carregar ocorrências...</p>
        ) : openOccurrences.length === 0 ? (
          <p className="text-xs text-gray-400 italic">Sem ocorrências abertas para este cliente.</p>
        ) : (
          <div className="space-y-2">
            {openOccurrences.map((occurrence) => {
              const isDelayed = String(occurrence.state || '').toUpperCase() === 'ATRASADA';
              return (
                <div
                  key={occurrence.id}
                  className={`p-2.5 rounded border text-xs ${isDelayed ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-800 truncate">{occurrence.title}</p>
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${isDelayed ? 'bg-amber-200 text-amber-900' : 'bg-blue-100 text-blue-800'}`}>
                      {occurrence.state || 'ABERTA'}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-600">
                    <span>{occurrence.typeName || 'Sem tipo'}</span>
                    <span>Limite: {formatDate(occurrence.dueDate || occurrence.date)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default TasksPanel;
