import { describe, expect, it } from 'vitest';
import {
  isFilledValue,
  isValidAgendaEvent,
  isValidCustomer,
  isValidUser,
  mergeImportedCustomersInto,
  normalizeDigits,
  parseTimestampToIso,
} from '../../services/mockDataUtils';
import { CustomerType, type Customer } from '../../types';

const customer = (overrides: Partial<Customer> = {}): Customer => ({
  id: 'c1',
  name: 'Cliente',
  company: 'Empresa',
  phone: '+351910000000',
  ownerId: null,
  type: CustomerType.ENTERPRISE,
  contacts: [],
  allowAutoResponses: true,
  ...overrides,
});

describe('mockDataUtils', () => {
  it('normaliza telefone e NIF mantendo apenas algarismos', () => {
    expect(normalizeDigits('+351 912-345-678')).toBe('351912345678');
    expect(normalizeDigits('PT 501 234 567')).toBe('501234567');
  });

  it.each([
    [undefined, false],
    [null, false],
    ['', false],
    ['   ', false],
    [[], false],
    [{}, false],
    [0, true],
    [false, true],
    ['valor', true],
    [[1], true],
    [{ id: 1 }, true],
  ])('identifica valores preenchidos: %j', (value, expected) => {
    expect(isFilledValue(value)).toBe(expected);
  });

  it('aceita um evento de agenda completo e com datas válidas', () => {
    expect(isValidAgendaEvent({
      id: 'ag1',
      title: 'Reunião',
      assignedUserId: 'u1',
      startsAt: '2026-07-14T09:00:00.000Z',
      endsAt: '2026-07-14T10:00:00.000Z',
    })).toBe(true);
  });

  it('rejeita eventos sem responsável ou com datas inválidas', () => {
    expect(isValidAgendaEvent({
      id: 'ag1',
      title: 'Reunião',
      assignedUserId: '',
      startsAt: 'data-inválida',
      endsAt: '2026-07-14T10:00:00.000Z',
    })).toBe(false);
  });

  it('valida a forma mínima de utilizadores', () => {
    expect(isValidUser({ id: 'u1', name: 'Ana', email: 'ana@example.com' })).toBe(true);
    expect(isValidUser({ id: 'u1', name: 'Ana' })).toBe(false);
  });

  it('valida a forma mínima de clientes', () => {
    expect(isValidCustomer({ id: 'c1', name: 'Cliente', phone: '+351900000000' })).toBe(true);
    expect(isValidCustomer({ id: 'c1', name: 'Cliente' })).toBe(false);
  });

  it('interpreta timestamps SQLite como UTC', () => {
    expect(parseTimestampToIso('2026-07-13 12:30:45')).toBe('2026-07-13T12:30:45.000Z');
  });

  it('mantém timestamps ISO válidos', () => {
    expect(parseTimestampToIso('2026-07-13T12:30:45.000Z')).toBe('2026-07-13T12:30:45.000Z');
  });

  it('atualiza clientes sincronizados usando o ID como identidade', () => {
    const customers = [customer({ name: 'Nome antigo', email: 'antigo@example.com' })];
    mergeImportedCustomersInto(customers, [customer({ name: 'Nome novo', email: 'novo@example.com' })]);
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ name: 'Nome novo', email: 'novo@example.com' });
  });

  it('faz correspondência forte através do NIF', () => {
    const customers = [customer({ id: 'c-antigo', nif: '501234567', name: 'Antigo' })];
    mergeImportedCustomersInto(customers, [
      customer({ id: 'c-novo', nif: '501 234 567', name: 'Atualizado' }),
    ]);
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ id: 'c-novo', name: 'Atualizado' });
  });

  it('não funde clientes externos diferentes apenas por partilharem telefone', () => {
    const customers = [customer({ id: 'c1', sourceId: 'source-1', name: 'Cliente Um' })];
    mergeImportedCustomersInto(customers, [
      customer({ id: 'c2', sourceId: 'source-2', name: 'Cliente Dois' }),
    ]);
    expect(customers.map((item) => item.name)).toEqual(['Cliente Um', 'Cliente Dois']);
  });

  it('permite correspondência fraca por telefone quando não há NIF nem sourceId', () => {
    const customers = [customer({ id: 'legacy-1', sourceId: undefined, nif: undefined, name: 'Antigo' })];
    mergeImportedCustomersInto(customers, [
      customer({ id: 'legacy-2', sourceId: undefined, nif: undefined, name: 'Novo' }),
    ]);
    expect(customers).toHaveLength(1);
    expect(customers[0].name).toBe('Novo');
  });

  it('preserva campos preenchidos de clientes locais', () => {
    const customers = [customer({
      id: 'local_1',
      name: 'Nome local',
      email: 'local@example.com',
      notes: 'Nota local',
    })];
    mergeImportedCustomersInto(customers, [customer({
      id: 'local_1',
      name: 'Nome remoto',
      email: 'remoto@example.com',
      notes: '',
    })]);
    expect(customers[0]).toMatchObject({
      id: 'local_1',
      name: 'Nome local',
      email: 'local@example.com',
      notes: 'Nota local',
    });
  });
});
