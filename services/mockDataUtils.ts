import type { AgendaEvent, Customer, User } from '../types';

export function normalizeDigits(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

export function isFilledValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return typeof value === 'boolean' || typeof value === 'number';
}

export function isValidAgendaEvent(value: unknown): value is AgendaEvent {
  const event = value as Partial<AgendaEvent>;
  if (!event || typeof event !== 'object') return false;
  const id = String(event.id || '').trim();
  const title = String(event.title || '').trim();
  const assignedUserId = String(event.assignedUserId || '').trim();
  const startsAt = String(event.startsAt || '').trim();
  const endsAt = String(event.endsAt || '').trim();
  return Boolean(
    id &&
    title &&
    assignedUserId &&
    Number.isFinite(Date.parse(startsAt)) &&
    Number.isFinite(Date.parse(endsAt)),
  );
}

export function isValidUser(value: unknown): value is User {
  const candidate = value as User;
  return Boolean(
    candidate &&
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.email === 'string',
  );
}

export function isValidCustomer(value: unknown): value is Customer {
  const candidate = value as Customer;
  return Boolean(
    candidate &&
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.phone === 'string',
  );
}

export function mergeImportedCustomersInto(
  customers: Customer[],
  importedCustomers: Customer[],
): void {
  const existingById = new Map<string, number>();
  customers.forEach((customer, index) => {
    if (customer.id) existingById.set(customer.id, index);
  });

  importedCustomers.forEach((customer) => {
    const normalizedPhone = normalizeDigits(String(customer.phone || ''));
    const normalizedEmail = String(customer.email || '').trim().toLowerCase();
    const normalizedNif = normalizeDigits(String(customer.nif || '')).slice(-9);
    const incomingSourceId = String(customer.sourceId || '').trim();
    const allowWeakIdentityMatch = !incomingSourceId && !normalizedNif;

    let existingIndex = existingById.get(customer.id);
    if (existingIndex === undefined) {
      existingIndex = customers.findIndex((existing) => {
        if (customer.id && existing.id === customer.id) return true;
        if (normalizedNif) {
          const existingNif = normalizeDigits(String(existing.nif || '')).slice(-9);
          if (existingNif && existingNif === normalizedNif) return true;
        }
        if (!allowWeakIdentityMatch) return false;
        if (normalizedPhone) {
          const existingPhone = normalizeDigits(String(existing.phone || ''));
          const existingNif = normalizeDigits(String(existing.nif || '')).slice(-9);
          const existingSourceId = String(existing.sourceId || '').trim();
          if (!existingNif && !existingSourceId && existingPhone === normalizedPhone) return true;
        }
        if (normalizedEmail) {
          const existingEmail = String(existing.email || '').trim().toLowerCase();
          const existingNif = normalizeDigits(String(existing.nif || '')).slice(-9);
          const existingSourceId = String(existing.sourceId || '').trim();
          if (!existingNif && !existingSourceId && existingEmail === normalizedEmail) return true;
        }
        return false;
      });
    }

    if (existingIndex !== undefined && existingIndex !== -1) {
      const existingCustomer = customers[existingIndex];
      const existingIsLocalOnly = String(existingCustomer.id || '').startsWith('local_');
      if (!existingIsLocalOnly) {
        const mergedCustomer = { ...existingCustomer, ...customer, id: customer.id || existingCustomer.id };
        customers[existingIndex] = mergedCustomer;
        if (mergedCustomer.id) existingById.set(mergedCustomer.id, existingIndex);
        return;
      }

      const mergedCustomer = { ...customer, ...existingCustomer, id: existingCustomer.id || customer.id };
      Object.keys(existingCustomer).forEach((key) => {
        const existingValue = existingCustomer[key as keyof Customer];
        if (isFilledValue(existingValue)) {
          mergedCustomer[key as keyof Customer] = existingValue as never;
        }
      });
      customers[existingIndex] = mergedCustomer;
      if (mergedCustomer.id) existingById.set(mergedCustomer.id, existingIndex);
      return;
    }

    const hasSameId = customers.some((existing) => existing.id === customer.id);
    const nextCustomer = hasSameId ? { ...customer, id: `${customer.id}_${Date.now()}` } : customer;
    customers.push(nextCustomer);
    existingById.set(nextCustomer.id, customers.length - 1);
  });
}

export function parseTimestampToIso(value: string): string {
  if (!value) return new Date().toISOString();
  const raw = String(value || '').trim();
  if (!raw) return new Date().toISOString();

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    const sqliteUtc = new Date(raw.replace(' ', 'T') + 'Z');
    if (!Number.isNaN(sqliteUtc.getTime())) return sqliteUtc.toISOString();
  }

  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const fallback = new Date(raw.replace(' ', 'T') + 'Z');
  return Number.isNaN(fallback.getTime()) ? new Date().toISOString() : fallback.toISOString();
}
