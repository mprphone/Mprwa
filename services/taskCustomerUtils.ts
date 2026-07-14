import type { Conversation, Customer, Task } from '../types';

type TaskCustomerFields = Pick<
  Task,
  'conversationId' | 'customerId' | 'customerName' | 'customerCompany'
>;

export interface ResolvedTaskCustomer {
  customerId?: string;
  customerName?: string;
  customer?: Customer;
}

export function resolveTaskCustomer(
  task: TaskCustomerFields,
  conversations: Conversation[],
  customers: Customer[],
): ResolvedTaskCustomer {
  const conversation = conversations.find((item) => item.id === task.conversationId);
  const customerId = String(task.customerId || conversation?.customerId || '').trim();
  const customer = customerId
    ? customers.find((item) => item.id === customerId)
    : undefined;
  const customerName = String(
    customer?.name || task.customerName || task.customerCompany || '',
  ).trim();

  return {
    customerId: customerId || undefined,
    customerName: customerName || undefined,
    customer,
  };
}
