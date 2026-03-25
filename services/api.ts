import { Conversation, Customer, Message, User } from '../types';

const API_URL = '/api'; // O IIS Reverse Proxy vai tratar disto

export const apiService = {
  // --- Conversations ---
  async getConversations(): Promise<Conversation[]> {
    const res = await fetch(`${API_URL}/conversations`);
    return await res.json();
  },

  // --- Messages ---
  async getMessages(conversationId: string): Promise<Message[]> {
    const res = await fetch(`${API_URL}/conversations/${conversationId}/messages`);
    return await res.json();
  },

  async sendMessage(conversationId: string, text: string): Promise<Message> {
    const res = await fetch(`${API_URL}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    return await res.json();
  },

  // --- Customers ---
  async getCustomers(): Promise<Customer[]> {
    const res = await fetch(`${API_URL}/customers`);
    return await res.json();
  },

  // --- Users ---
  // (Adicione outros métodos conforme necessário seguindo este padrão)
};
