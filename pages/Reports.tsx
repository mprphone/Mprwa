import React, { useEffect, useState } from 'react';
import { mockService } from '../services/mockData';
import { Call, Customer } from '../types';
import { Search, AlertTriangle, Activity, Clock, Users, FileText } from 'lucide-react';

const Reports: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'general' | 'customers' | 'alerts' | 'search' | 'audit'>('general');
  const [dashboard, setDashboard] = useState<{
    metrics: {
      totalConversations: number;
      openConversations: number;
      waitingConversations: number;
      closedConversations: number;
      pendingTasks: number;
      overdueTasks: number;
      avgResponseMinutes: number;
    };
    byAgent: Array<{ ownerId: string | null; agentName: string; total: number; active: number }>;
  } | null>(null);

  const [customerStats, setCustomerStats] = useState<{ customer: Customer; totalDuration: number; callCount: number }[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerCalls, setCustomerCalls] = useState<Call[]>([]);

  const [alerts, setAlerts] = useState<{
    overdueTasks: Array<{ id: string; title: string; due_date: string; priority: string; status: string; customer_name?: string }>;
    unansweredConversations: Array<{ conversation_id: string; customer_name: string; phone?: string; last_inbound_at: string; last_outbound_at?: string }>;
  }>({ overdueTasks: [], unansweredConversations: [] });

  const [searchTerm, setSearchTerm] = useState('');
  const [searchResult, setSearchResult] = useState<{
    customers: Array<{ id: string; name: string; company: string; phone: string; email?: string }>;
    messages: Array<{ id: number; from_number: string; body: string; direction: string; timestamp: string }>;
    tasks: Array<{ id: string; conversation_id: string; title: string; status: string; priority: string; due_date: string }>;
  }>({ customers: [], messages: [], tasks: [] });

  const [auditLogs, setAuditLogs] = useState<Array<{
    id: number;
    actorUserId: string | null;
    entityType: string;
    entityId: string | null;
    action: string;
    details: unknown;
    createdAt: string;
  }>>([]);

  useEffect(() => {
    void loadDashboard();
    void loadCustomerData();
    void loadAlerts();
    void loadAudit();
  }, []);

  const loadDashboard = async () => {
    const metrics = await mockService.getDashboardMetrics();
    setDashboard(metrics);
  };

  const loadCustomerData = async () => {
    const customers = await mockService.getCustomers();
    const calls = await mockService.getCalls();

    const stats = customers
      .map((cust) => {
        const custCalls = calls.filter((c) => c.customerId === cust.id);
        const totalDuration = custCalls.reduce((acc, curr) => acc + curr.durationSeconds, 0);
        return {
          customer: cust,
          totalDuration: Math.round(totalDuration / 60),
          callCount: custCalls.length,
        };
      })
      .sort((a, b) => b.totalDuration - a.totalDuration);

    setCustomerStats(stats);
  };

  const handleSelectCustomer = async (customer: Customer) => {
    setSelectedCustomer(customer);
    const calls = await mockService.getCalls(customer.id);
    setCustomerCalls(calls);
  };

  const loadAlerts = async () => {
    const data = await mockService.getAlerts(6);
    setAlerts(data);
  };

  const loadAudit = async () => {
    const rows = await mockService.getAuditLogs(120);
    setAuditLogs(rows);
  };

  const runSearch = async () => {
    const term = searchTerm.trim();
    if (!term) {
      setSearchResult({ customers: [], messages: [], tasks: [] });
      return;
    }
    const result = await mockService.getGlobalSearch(term);
    setSearchResult(result);
  };

  const MetricCard: React.FC<{ label: string; value: string | number; tone?: 'default' | 'warn' | 'danger' }> = ({ label, value, tone = 'default' }) => {
    const toneClass =
      tone === 'danger' ? 'border-red-200 bg-red-50 text-red-700'
      : tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-700'
      : 'border-gray-200 bg-white text-gray-900';
    return (
      <div className={`rounded-xl border p-4 ${toneClass}`}>
        <p className="text-xs uppercase tracking-wide opacity-80">{label}</p>
        <p className="text-2xl font-bold mt-1">{value}</p>
      </div>
    );
  };

  return (
    <div className="w-full space-y-4 p-4 md:p-6">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 text-white shadow-sm md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold md:text-2xl">Relatórios</h1>
            <p className="text-xs text-slate-200 md:text-sm">Métricas operacionais, pesquisa e auditoria.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              { id: 'general', label: 'Operação' },
              { id: 'customers', label: 'Cliente' },
              { id: 'alerts', label: 'Alertas' },
              { id: 'search', label: 'Pesquisa' },
              { id: 'audit', label: 'Auditoria' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as typeof activeTab)}
                className={`rounded-lg px-3 py-2 text-xs font-semibold md:text-sm ${
                  activeTab === tab.id
                    ? 'bg-white text-slate-900'
                    : 'border border-white/30 bg-white/10 text-white hover:bg-white/20'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {activeTab === 'general' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <MetricCard label="Conversas (Total)" value={dashboard?.metrics.totalConversations || 0} />
            <MetricCard label="Conversas Abertas" value={dashboard?.metrics.openConversations || 0} tone="warn" />
            <MetricCard label="Tarefas Pendentes" value={dashboard?.metrics.pendingTasks || 0} tone="warn" />
            <MetricCard label="Tarefas em Atraso" value={dashboard?.metrics.overdueTasks || 0} tone="danger" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <MetricCard label="Aguardando" value={dashboard?.metrics.waitingConversations || 0} />
            <MetricCard label="Fechadas" value={dashboard?.metrics.closedConversations || 0} />
            <MetricCard label="SLA Resposta (min)" value={(dashboard?.metrics.avgResponseMinutes || 0).toFixed(1)} />
          </div>

          <div className="bg-white rounded-xl border border-gray-200">
            <div className="p-4 border-b border-gray-100 flex items-center gap-2">
              <Users size={16} className="text-gray-500" />
              <h3 className="font-semibold text-gray-900">Conversas por Agente</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Agente</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Ativas</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(dashboard?.byAgent || []).map((row) => (
                    <tr key={`${row.ownerId || 'none'}_${row.agentName}`}>
                      <td className="px-4 py-3 text-sm text-gray-800">{row.agentName}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{row.active}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{row.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'customers' && (
        <div className="flex flex-col lg:flex-row gap-6 h-[calc(100vh-12rem)]">
          <div className="lg:w-1/3 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col">
            <div className="p-4 border-b border-gray-100 bg-gray-50">
              <h3 className="font-semibold text-gray-700">Tempo Total de Chamadas</h3>
            </div>
            <div className="flex-1 overflow-y-auto">
              <table className="min-w-full divide-y divide-gray-100">
                <thead className="bg-white sticky top-0">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Cliente</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Total (min)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {customerStats.map((stat) => (
                    <tr
                      key={stat.customer.id}
                      onClick={() => handleSelectCustomer(stat.customer)}
                      className={`cursor-pointer hover:bg-gray-50 ${selectedCustomer?.id === stat.customer.id ? 'bg-whatsapp-50' : ''}`}
                    >
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-gray-900">{stat.customer.name}</div>
                        <div className="text-xs text-gray-500">{stat.callCount} chamadas</div>
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-600 font-mono">{stat.totalDuration} min</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="lg:w-2/3 bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col">
            {selectedCustomer ? (
              <>
                <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                  <div>
                    <h2 className="text-xl font-bold text-gray-900">{selectedCustomer.name}</h2>
                    <p className="text-sm text-gray-500">{selectedCustomer.company} • {selectedCustomer.phone}</p>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <table className="min-w-full divide-y divide-gray-100">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Data</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Origem</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Duração</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Notas</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-100">
                      {customerCalls.length > 0 ? customerCalls.map((call) => (
                        <tr key={call.id}>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                            {new Date(call.startedAt).toLocaleDateString()} {' '}
                            <span className="text-gray-400">{new Date(call.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{call.source}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-medium">
                            {Math.round(call.durationSeconds / 60)} min
                          </td>
                          <td className="px-6 py-4 text-sm text-gray-500">{call.notes || '-'}</td>
                        </tr>
                      )) : (
                        <tr><td colSpan={4} className="p-8 text-center text-gray-400">Sem registo de chamadas.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
                <FileText size={48} className="mb-4 opacity-20" />
                <p>Selecione um cliente para ver o extrato de chamadas.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'alerts' && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div className="bg-white border border-red-200 rounded-xl overflow-hidden">
            <div className="p-4 bg-red-50 border-b border-red-100 flex items-center gap-2">
              <AlertTriangle size={16} className="text-red-600" />
              <h3 className="font-semibold text-red-800">Tarefas em Atraso</h3>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {alerts.overdueTasks.length > 0 ? alerts.overdueTasks.map((task) => (
                <div key={task.id} className="p-4 border-b border-gray-100">
                  <p className="text-sm font-medium text-gray-900">{task.title}</p>
                  <p className="text-xs text-gray-500">{task.customer_name || 'Sem cliente'} • {new Date(task.due_date).toLocaleString()}</p>
                </div>
              )) : (
                <div className="p-6 text-sm text-gray-500">Sem tarefas em atraso.</div>
              )}
            </div>
          </div>

          <div className="bg-white border border-amber-200 rounded-xl overflow-hidden">
            <div className="p-4 bg-amber-50 border-b border-amber-100 flex items-center gap-2">
              <Clock size={16} className="text-amber-700" />
              <h3 className="font-semibold text-amber-800">Conversas sem resposta (&gt; 6h)</h3>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              {alerts.unansweredConversations.length > 0 ? alerts.unansweredConversations.map((item) => (
                <div key={item.conversation_id} className="p-4 border-b border-gray-100">
                  <p className="text-sm font-medium text-gray-900">{item.customer_name}</p>
                  <p className="text-xs text-gray-500">{item.phone || '--'}</p>
                  <p className="text-xs text-gray-500 mt-1">
                    Última entrada: {new Date(item.last_inbound_at).toLocaleString()}
                  </p>
                </div>
              )) : (
                <div className="p-6 text-sm text-gray-500">Sem conversas pendentes de resposta.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'search' && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 p-4 flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
              <input
                type="text"
                className="w-full pl-9 pr-4 py-2 border rounded-lg text-sm"
                placeholder="Pesquisar clientes, mensagens e tarefas..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
              />
            </div>
            <button onClick={() => void runSearch()} className="px-4 py-2 bg-whatsapp-600 text-white rounded-lg text-sm">
              Procurar
            </button>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="bg-white rounded-xl border border-gray-200">
              <div className="p-3 border-b text-sm font-semibold">Clientes ({searchResult.customers.length})</div>
              <div className="max-h-[360px] overflow-y-auto">
                {searchResult.customers.map((item) => (
                  <div key={item.id} className="p-3 border-b border-gray-100 text-sm">
                    <p className="font-medium text-gray-900">{item.name}</p>
                    <p className="text-xs text-gray-500">{item.company} • {item.phone}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200">
              <div className="p-3 border-b text-sm font-semibold">Mensagens ({searchResult.messages.length})</div>
              <div className="max-h-[360px] overflow-y-auto">
                {searchResult.messages.map((item) => (
                  <div key={item.id} className="p-3 border-b border-gray-100 text-sm">
                    <p className="text-gray-800 line-clamp-2">{item.body}</p>
                    <p className="text-xs text-gray-500">{item.from_number} • {new Date(item.timestamp).toLocaleString()}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200">
              <div className="p-3 border-b text-sm font-semibold">Tarefas ({searchResult.tasks.length})</div>
              <div className="max-h-[360px] overflow-y-auto">
                {searchResult.tasks.map((item) => (
                  <div key={item.id} className="p-3 border-b border-gray-100 text-sm">
                    <p className="font-medium text-gray-900">{item.title}</p>
                    <p className="text-xs text-gray-500">{item.status} • {new Date(item.due_date).toLocaleDateString()}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'audit' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="p-4 border-b border-gray-100 flex items-center gap-2">
            <Activity size={16} className="text-gray-500" />
            <h3 className="font-semibold text-gray-900">Histórico de Auditoria</h3>
          </div>
          <div className="overflow-x-auto max-h-[70vh]">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Data</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Entidade</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Ação</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Ator</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {auditLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">{new Date(log.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-3 text-xs text-gray-700">{log.entityType} {log.entityId ? `#${log.entityId}` : ''}</td>
                    <td className="px-4 py-3 text-xs text-gray-700">{log.action}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{log.actorUserId || 'system'}</td>
                  </tr>
                ))}
                {auditLogs.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-400">Sem registos.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default Reports;
