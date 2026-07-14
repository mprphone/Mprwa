import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgendaEvent, Call, Task } from '../../types';
import {
  deleteAgendaEventApi,
  deleteTaskApi,
  fetchAgendaEventsApi,
  fetchCallsApi,
  fetchTasksApi,
  importTasksApi,
  saveAgendaEventApi,
  saveCallApi,
  saveTaskApi,
} from '../../services/operationalDataApi';

const task: Task = {
  id: 't1',
  conversationId: 'conv1',
  customerId: 'c1',
  customerName: 'Cliente Um',
  title: 'Tarefa',
  status: 'open' as Task['status'],
  priority: 'normal' as Task['priority'],
  dueDate: '2026-07-31T00:00:00.000Z',
  assignedUserId: 'u1',
};

const call: Call = {
  id: 'call1',
  customerId: 'c1',
  userId: 'u1',
  startedAt: '2026-07-13T12:00:00.000Z',
  durationSeconds: 60,
  source: 'manual',
};

const agendaEvent: AgendaEvent = {
  id: 'ag1',
  title: 'Reunião',
  type: 'meeting',
  assignedUserId: 'u1',
  startsAt: '2026-07-14T09:00:00.000Z',
  endsAt: '2026-07-14T10:00:00.000Z',
  createdAt: '2026-07-13T12:00:00.000Z',
  updatedAt: '2026-07-13T12:00:00.000Z',
};

function response(body: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('operationalDataApi', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carrega tarefas com filtros de conversa e utilizador', async () => {
    fetchMock.mockResolvedValue(response({ success: true, data: [task] }));
    await expect(fetchTasksApi('conv 1', 'u1')).resolves.toEqual([task]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/local?conversationId=conv+1&userId=u1',
      { headers: { Accept: 'application/json' } },
    );
  });

  it('devolve null quando a listagem de tarefas falha', async () => {
    fetchMock.mockResolvedValue(response({ success: false }, { ok: false, status: 500 }));
    await expect(fetchTasksApi()).resolves.toBeNull();
  });

  it('envia os parâmetros da importação de tarefas', async () => {
    fetchMock.mockResolvedValue(response({ success: true, summary: { imported: 2 } }));
    await expect(importTasksApi({ force: true, tasksTable: 'tarefas' }, 'u1')).resolves.toEqual({
      success: true,
      summary: { imported: 2 },
    });
    const request = fetchMock.mock.calls[0][1];
    expect(JSON.parse(request.body)).toMatchObject({ force: true, actorUserId: 'u1', tasksTable: 'tarefas' });
  });

  it('normaliza erros da importação de tarefas', async () => {
    fetchMock.mockResolvedValue(response({ success: false, error: 'Import desativado' }, { ok: false, status: 410 }));
    await expect(importTasksApi({}, 'u1')).resolves.toEqual({ success: false, error: 'Import desativado' });
  });

  it('guarda e devolve a tarefa recebida da API', async () => {
    fetchMock.mockResolvedValue(response({ success: true, task }));
    await expect(saveTaskApi(task)).resolves.toEqual(task);
  });

  it('lança erro quando não consegue guardar uma tarefa', async () => {
    fetchMock.mockResolvedValue(response({ success: false, error: 'Falha de escrita' }, { ok: false, status: 500 }));
    await expect(saveTaskApi(task)).rejects.toThrow('Falha de escrita');
  });

  it('elimina uma tarefa com ID e autor codificados', async () => {
    fetchMock.mockResolvedValue(response({ success: true }));
    await deleteTaskApi('tarefa/1', 'user 1');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tasks/tarefa%2F1?actorUserId=user+1');
  });

  it('carrega chamadas filtradas por cliente', async () => {
    fetchMock.mockResolvedValue(response({ success: true, data: [call] }));
    await expect(fetchCallsApi('cliente 1')).resolves.toEqual([call]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/calls/local?customerId=cliente+1');
  });

  it('guarda uma chamada e aceita resposta sem objeto', async () => {
    fetchMock.mockResolvedValueOnce(response({ success: true, call }));
    await expect(saveCallApi(call)).resolves.toEqual(call);
    fetchMock.mockResolvedValueOnce(response({ success: true }));
    await expect(saveCallApi(call)).resolves.toBeNull();
  });

  it('carrega a agenda filtrada por utilizador', async () => {
    fetchMock.mockResolvedValue(response({ success: true, data: [agendaEvent] }));
    await expect(fetchAgendaEventsApi('user 1')).resolves.toEqual([agendaEvent]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/agenda/events?userId=user%201');
  });

  it('exige um evento válido na resposta de gravação da agenda', async () => {
    fetchMock.mockResolvedValue(response({ success: true }));
    await expect(saveAgendaEventApi(agendaEvent)).rejects.toThrow('Falha ao guardar evento');
  });

  it('elimina um evento com o ID codificado', async () => {
    fetchMock.mockResolvedValue(response({ success: true }));
    await deleteAgendaEventApi('agenda/1');
    expect(fetchMock).toHaveBeenCalledWith('/api/agenda/events/agenda%2F1', {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
  });
});
