import { describe, expect, it } from 'vitest';
import type { Conversation, Customer, Task } from '../../types';
import { resolveTaskCustomer } from '../../services/taskCustomerUtils';

const customer = (id: string, name: string, phone = '+351910000000'): Customer => ({
  id,
  name,
  company: name,
  phone,
  ownerId: null,
  type: 'empresa' as Customer['type'],
  contacts: [],
  allowAutoResponses: true,
});

const conversation = (id: string, customerId: string): Conversation => ({
  id,
  customerId,
  ownerId: null,
  status: 'open' as Conversation['status'],
  lastMessageAt: '2026-07-13T12:00:00.000Z',
  unreadCount: 0,
});

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 't1',
  conversationId: 'conv1',
  title: 'Tarefa',
  status: 'open' as Task['status'],
  priority: 'normal' as Task['priority'],
  dueDate: '2026-07-31T00:00:00.000Z',
  assignedUserId: 'u1',
  ...overrides,
});

describe('resolveTaskCustomer', () => {
  it('resolve o cliente através da conversa', () => {
    const result = resolveTaskCustomer(
      task(),
      [conversation('conv1', 'c1')],
      [customer('c1', 'Cliente Um')],
    );
    expect(result).toMatchObject({ customerId: 'c1', customerName: 'Cliente Um' });
  });

  it('prefere o customerId gravado diretamente na tarefa', () => {
    const result = resolveTaskCustomer(
      task({ customerId: 'c2' }),
      [conversation('conv1', 'c1')],
      [customer('c1', 'Cliente Um'), customer('c2', 'Cliente Dois')],
    );
    expect(result).toMatchObject({ customerId: 'c2', customerName: 'Cliente Dois' });
  });

  it('mantém clientes distintos mesmo quando partilham o telefone', () => {
    const sharedPhone = '+351917203280';
    const customers = [
      customer('c1', 'Cybercentro', sharedPhone),
      customer('c2', 'Dias de Aventura', sharedPhone),
    ];
    const conversations = [conversation('conv1', 'c1'), conversation('conv2', 'c2')];

    expect(resolveTaskCustomer(task({ conversationId: 'conv1' }), conversations, customers).customerName)
      .toBe('Cybercentro');
    expect(resolveTaskCustomer(task({ conversationId: 'conv2' }), conversations, customers).customerName)
      .toBe('Dias de Aventura');
  });

  it('usa o nome fornecido pela API quando a lista de clientes ainda não o contém', () => {
    const result = resolveTaskCustomer(
      task({ customerId: 'c-remoto', customerName: 'Cliente Remoto' }),
      [],
      [],
    );
    expect(result).toEqual({
      customerId: 'c-remoto',
      customerName: 'Cliente Remoto',
      customer: undefined,
    });
  });

  it('devolve campos indefinidos para uma tarefa verdadeiramente órfã', () => {
    expect(resolveTaskCustomer(task(), [], [])).toEqual({
      customerId: undefined,
      customerName: undefined,
      customer: undefined,
    });
  });
});
