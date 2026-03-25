import React, { useState, useEffect } from 'react';
import { mockService } from '../services/mockData';
import { AutoResponseTrigger, TriggerAudience, TriggerSchedule, TriggerType, TriggerAction, TriggerLevel } from '../types';
import { Plus, Search, Edit2, Trash2, Zap, ToggleLeft, ToggleRight, MessageSquare, Globe, Users, Clock, Briefcase, CheckSquare, Sun, Moon, CheckCircle, ShieldCheck, Sparkles } from 'lucide-react';

const AutoResponses: React.FC = () => {
  const [triggers, setTriggers] = useState<AutoResponseTrigger[]>([]);
  const [templates, setTemplates] = useState<Array<{
    id: string;
    name: string;
    kind: 'template' | 'quick_reply';
    content: string;
    metaTemplateName?: string;
    isActive: boolean;
  }>>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<AutoResponseTrigger | null>(null);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [templateSearch, setTemplateSearch] = useState('');

  const [templateForm, setTemplateForm] = useState<{
    name: string;
    kind: 'template' | 'quick_reply';
    content: string;
    metaTemplateName: string;
    isActive: boolean;
  }>({
    name: '',
    kind: 'template',
    content: '',
    metaTemplateName: '',
    isActive: true,
  });

  const [formData, setFormData] = useState<{
    type: TriggerType;
    action: TriggerAction;
    level: TriggerLevel;
    keyword: string;
    response: string;
    taskTitleTemplate: string;
    matchType: 'exact' | 'contains';
    isActive: boolean;
    audience: TriggerAudience;
    schedule: TriggerSchedule;
  }>({
    type: 'keyword',
    action: 'send_message',
    level: 'extra',
    keyword: '',
    response: '',
    taskTitleTemplate: '',
    matchType: 'contains',
    isActive: true,
    audience: 'all',
    schedule: 'always'
  });

  useEffect(() => {
    loadTriggers();
    loadTemplates();
  }, []);

  const loadTriggers = async () => {
    const data = await mockService.getTriggers();
    setTriggers(data);
  };

  const loadTemplates = async () => {
    const data = await mockService.getManagedTemplates();
    setTemplates(data);
  };

  const openModal = (trigger?: AutoResponseTrigger) => {
    if (trigger) {
      setEditingTrigger(trigger);
      setFormData({
        type: trigger.type,
        action: trigger.action,
        level: trigger.level || 'extra',
        keyword: trigger.keyword || '',
        response: trigger.response || '',
        taskTitleTemplate: trigger.taskTitleTemplate || '',
        matchType: trigger.matchType || 'contains',
        isActive: trigger.isActive,
        audience: trigger.audience || 'all',
        schedule: trigger.schedule || 'always'
      });
    } else {
      setEditingTrigger(null);
      setFormData({
        type: 'keyword',
        action: 'send_message',
        level: 'extra',
        keyword: '',
        response: '',
        taskTitleTemplate: '',
        matchType: 'contains',
        isActive: true,
        audience: 'all',
        schedule: 'always'
      });
    }
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload: any = { ...formData };
    
    // Clean up fields not relevant to current type/action
    if (formData.type !== 'keyword') {
        delete payload.keyword;
        delete payload.matchType;
    }
    if (formData.action === 'send_message') {
        delete payload.taskTitleTemplate;
    } else if (formData.action === 'create_task') {
        delete payload.response;
    }

    if (editingTrigger) {
      await mockService.updateTrigger(editingTrigger.id, payload);
    } else {
      await mockService.createTrigger(payload);
    }
    setShowModal(false);
    loadTriggers();
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('Tem a certeza que deseja eliminar este gatilho?')) {
      await mockService.deleteTrigger(id);
      loadTriggers();
    }
  };

  const toggleStatus = async (trigger: AutoResponseTrigger) => {
      await mockService.updateTrigger(trigger.id, { isActive: !trigger.isActive });
      loadTriggers();
  };

  const openTemplateModal = (template?: {
    id: string;
    name: string;
    kind: 'template' | 'quick_reply';
    content: string;
    metaTemplateName?: string;
    isActive: boolean;
  }) => {
    if (template) {
      setEditingTemplateId(template.id);
      setTemplateForm({
        name: template.name,
        kind: template.kind,
        content: template.content,
        metaTemplateName: template.metaTemplateName || '',
        isActive: template.isActive,
      });
    } else {
      setEditingTemplateId(null);
      setTemplateForm({
        name: '',
        kind: 'template',
        content: '',
        metaTemplateName: '',
        isActive: true,
      });
    }
    setShowTemplateModal(true);
  };

  const handleTemplateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await mockService.saveManagedTemplate({
      id: editingTemplateId || undefined,
      name: templateForm.name,
      kind: templateForm.kind,
      content: templateForm.content,
      metaTemplateName: templateForm.metaTemplateName || undefined,
      isActive: templateForm.isActive,
    });
    setShowTemplateModal(false);
    await loadTemplates();
  };

  const handleTemplateDelete = async (id: string) => {
    if (!window.confirm('Eliminar este template/resposta rápida?')) return;
    await mockService.deleteManagedTemplate(id);
    await loadTemplates();
  };

  const filteredTriggers = triggers.filter(t => 
    (t.keyword && t.keyword.toLowerCase().includes(searchTerm.toLowerCase())) || 
    (t.response && t.response.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (t.taskTitleTemplate && t.taskTitleTemplate.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  const filteredTemplates = templates.filter((template) => {
    const term = templateSearch.trim().toLowerCase();
    if (!term) return true;
    return (
      template.name.toLowerCase().includes(term) ||
      template.content.toLowerCase().includes(term) ||
      (template.metaTemplateName || '').toLowerCase().includes(term)
    );
  });

  const getScheduleLabel = (schedule: TriggerSchedule) => {
    switch(schedule) {
      case 'always': return 'Sempre';
      case 'business_hours': return 'H. Comercial';
      case 'outside_hours': return 'Fora Horas';
      default: return schedule;
    }
  };

  const getAudienceLabel = (audience: TriggerAudience) => {
    switch(audience) {
      case 'all': return 'Todos';
      case 'allowed_only': return 'Permitidos';
      default: return audience;
    }
  };

  const getTypeInfo = (type: TriggerType) => {
      switch(type) {
          case 'keyword': return { label: 'Palavra-chave', icon: MessageSquare, color: 'text-blue-600', bg: 'bg-blue-50' };
          case 'first_message_today': return { label: '1ª do Dia (Receção)', icon: Sun, color: 'text-orange-600', bg: 'bg-orange-50' };
          case 'outside_hours': return { label: 'Fora de Horário', icon: Moon, color: 'text-purple-600', bg: 'bg-purple-50' };
          case 'task_completed': return { label: 'Ao Concluir Tarefa', icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' };
          default: return { label: type, icon: Zap, color: 'text-gray-600', bg: 'bg-gray-50' };
      }
  };

  return (
    <div className="w-full space-y-4 p-4 md:p-6">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 text-white shadow-sm md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold md:text-2xl">Automação</h1>
            <p className="text-xs text-slate-200 md:text-sm">Automatize respostas, triagem e tarefas.</p>
          </div>
          <button
            onClick={() => openModal()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500 md:text-sm"
          >
            <Plus size={16} /> Nova Automação
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-4">
           <div className="relative max-w-md">
             <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
             <input 
                type="text" 
                placeholder="Procurar..." 
                className="w-full rounded-md border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm" 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
            />
           </div>
        </div>
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
             <tr>
               <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase w-20">Estado</th>
               <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase w-48">Gatilho (Quando)</th>
               <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ação (O que faz)</th>
               <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase w-40">Condições</th>
               <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase w-24">Ações</th>
             </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
             {filteredTriggers.map(trigger => {
               const typeInfo = getTypeInfo(trigger.type);
               const TypeIcon = typeInfo.icon;
               
               return (
               <tr key={trigger.id} className="hover:bg-gray-50">
                 <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex flex-col items-center">
                        <button onClick={() => toggleStatus(trigger)} className="focus:outline-none">
                            {trigger.isActive ? (
                                <ToggleRight size={28} className="text-whatsapp-600" />
                            ) : (
                                <ToggleLeft size={28} className="text-gray-300" />
                            )}
                        </button>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase mt-1 ${trigger.level === 'essential' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}`}>
                           {trigger.level === 'essential' ? 'Essencial' : 'Extra'}
                        </span>
                    </div>
                 </td>
                 <td className="px-6 py-4">
                    <div className="flex items-center gap-2 mb-1">
                        <div className={`p-1.5 rounded-md ${typeInfo.bg} ${typeInfo.color}`}>
                            <TypeIcon size={16} />
                        </div>
                        <span className="text-sm font-medium text-gray-900">{typeInfo.label}</span>
                    </div>
                    {trigger.type === 'keyword' && (
                        <div className="text-xs text-gray-500 ml-9">
                            Palavra: <span className="font-mono bg-gray-100 px-1 rounded">{trigger.keyword}</span>
                        </div>
                    )}
                 </td>
                 <td className="px-6 py-4">
                    {trigger.action === 'send_message' ? (
                        <div className="flex items-start gap-2">
                             <MessageSquare size={16} className="text-gray-400 mt-1 shrink-0" />
                             <span className="text-sm text-gray-600 line-clamp-2">{trigger.response}</span>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2">
                             <CheckSquare size={16} className="text-blue-500 shrink-0" />
                             <span className="text-sm text-gray-900 font-medium">Criar Tarefa: <span className="font-normal">{trigger.taskTitleTemplate}</span></span>
                        </div>
                    )}
                 </td>
                 <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1.5 text-xs text-gray-600" title="Público Alvo">
                            {trigger.audience === 'all' ? <Globe size={14} /> : <Users size={14} />}
                            {getAudienceLabel(trigger.audience)}
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-gray-600" title="Horário">
                            {trigger.schedule === 'always' ? <Clock size={14} /> : <Briefcase size={14} />}
                            {getScheduleLabel(trigger.schedule)}
                        </div>
                    </div>
                 </td>
                 <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div className="flex justify-end gap-2">
                        <button onClick={() => openModal(trigger)} className="text-gray-400 hover:text-whatsapp-600 p-1">
                            <Edit2 size={16} />
                        </button>
                        <button onClick={() => handleDelete(trigger.id)} className="text-gray-400 hover:text-red-600 p-1">
                            <Trash2 size={16} />
                        </button>
                    </div>
                 </td>
               </tr>
             )})}
             {filteredTriggers.length === 0 && (
                <tr>
                    <td colSpan={5} className="text-center py-8 text-gray-400">
                        Nenhuma automação encontrada.
                    </td>
                </tr>
             )}
          </tbody>
        </table>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 mt-6">
        <div className="p-4 border-b border-gray-200 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Templates e Respostas Rápidas</h2>
            <p className="text-xs text-gray-500">
              Conteúdos reutilizáveis com variáveis ({'{{nome}}'}, {'{{empresa}}'}, {'{{telefone}}'}).
            </p>
          </div>
          <div className="flex gap-2">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 text-gray-400" size={16} />
              <input
                type="text"
                placeholder="Pesquisar template..."
                className="pl-9 pr-3 py-2 text-sm border rounded-lg"
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
              />
            </div>
            <button
              onClick={() => openTemplateModal()}
              className="flex items-center gap-2 px-3 py-2 bg-whatsapp-600 text-white rounded-lg hover:bg-whatsapp-700 text-sm"
            >
              <Plus size={16} /> Novo
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Nome</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tipo</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Conteúdo</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Estado</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Ações</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredTemplates.map((template) => (
                <tr key={template.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 text-sm font-medium text-gray-900">{template.name}</td>
                  <td className="px-6 py-3 text-xs text-gray-600">
                    {template.kind === 'quick_reply' ? 'Resposta rápida' : 'Template'}
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-600 max-w-xl truncate" title={template.content}>
                    {template.content}
                  </td>
                  <td className="px-6 py-3 text-xs">
                    <span className={`px-2 py-1 rounded-full ${template.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {template.isActive ? 'Ativo' : 'Inativo'}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right text-sm">
                    <button onClick={() => openTemplateModal(template)} className="text-gray-400 hover:text-whatsapp-600 p-1">
                      <Edit2 size={16} />
                    </button>
                    <button onClick={() => handleTemplateDelete(template.id)} className="text-gray-400 hover:text-red-600 p-1">
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
              {filteredTemplates.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center py-6 text-sm text-gray-400">
                    Sem templates/respostas rápidas.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
           <div className="bg-white rounded-lg w-full max-w-lg p-6">
              <h2 className="text-lg font-bold mb-6 flex items-center gap-2">
                  <Zap size={20} className="text-whatsapp-600" />
                  {editingTrigger ? 'Editar Automação' : 'Nova Automação'}
              </h2>
              <form onSubmit={handleSubmit} className="space-y-5">
                 
                 {/* 1. GATILHO (WHEN) */}
                 <div className="bg-gray-50 p-3 rounded-lg border border-gray-100">
                     <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Quando acontece (Gatilho)</label>
                     <div className="grid grid-cols-2 gap-3">
                        <div className="col-span-2 sm:col-span-1">
                            <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de Evento</label>
                            <select 
                                className="w-full border rounded-md p-2 text-sm bg-white"
                                value={formData.type}
                                onChange={e => setFormData({...formData, type: e.target.value as TriggerType})}
                            >
                                <option value="keyword">Palavra-chave</option>
                                <option value="first_message_today">1ª Mensagem do Dia (Receção)</option>
                                <option value="outside_hours">Mensagem Fora de Horário</option>
                                <option value="task_completed">Ao Concluir Tarefa</option>
                            </select>
                        </div>

                        {formData.type === 'keyword' && (
                             <div className="col-span-2 sm:col-span-1">
                                <label className="block text-sm font-medium text-gray-700 mb-1">Palavra(s)</label>
                                <input 
                                    required 
                                    type="text" 
                                    placeholder="ex: irs, iban, preço"
                                    className="w-full border rounded-md p-2 text-sm" 
                                    value={formData.keyword} 
                                    onChange={e => setFormData({...formData, keyword: e.target.value})} 
                                />
                             </div>
                        )}

                        <div className="col-span-2">
                            <label className="block text-sm font-medium text-gray-700 mb-1">Nível de Importância</label>
                            <div className="flex gap-4">
                                <label className="flex items-center gap-2 cursor-pointer bg-white border p-2 rounded w-full hover:bg-gray-50">
                                    <input 
                                        type="radio" 
                                        name="level"
                                        checked={formData.level === 'essential'} 
                                        onChange={() => setFormData({...formData, level: 'essential'})}
                                        className="text-whatsapp-600 focus:ring-whatsapp-500"
                                    />
                                    <ShieldCheck size={16} className="text-green-600" />
                                    <div>
                                        <span className="text-sm font-medium block">Essencial</span>
                                        <span className="text-[10px] text-gray-500">Crítico para funcionamento</span>
                                    </div>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer bg-white border p-2 rounded w-full hover:bg-gray-50">
                                    <input 
                                        type="radio" 
                                        name="level"
                                        checked={formData.level === 'extra'} 
                                        onChange={() => setFormData({...formData, level: 'extra'})}
                                        className="text-whatsapp-600 focus:ring-whatsapp-500"
                                    />
                                    <Sparkles size={16} className="text-blue-600" />
                                    <div>
                                        <span className="text-sm font-medium block">Extra</span>
                                        <span className="text-[10px] text-gray-500">Melhoria de experiência</span>
                                    </div>
                                </label>
                            </div>
                        </div>
                     </div>
                 </div>

                 {/* 2. AÇÃO (WHAT) */}
                 <div className="bg-gray-50 p-3 rounded-lg border border-gray-100">
                     <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">O que fazer (Ação)</label>
                     
                     <div className="mb-3">
                        <div className="flex gap-4">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input 
                                    type="radio" 
                                    name="action"
                                    checked={formData.action === 'send_message'} 
                                    onChange={() => setFormData({...formData, action: 'send_message'})}
                                    className="text-whatsapp-600 focus:ring-whatsapp-500"
                                />
                                <span className="text-sm font-medium">Enviar Mensagem</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input 
                                    type="radio" 
                                    name="action"
                                    checked={formData.action === 'create_task'} 
                                    onChange={() => setFormData({...formData, action: 'create_task'})}
                                    className="text-whatsapp-600 focus:ring-whatsapp-500"
                                />
                                <span className="text-sm font-medium">Criar Tarefa Interna</span>
                            </label>
                        </div>
                     </div>

                     {formData.action === 'send_message' ? (
                         <div>
                            <textarea 
                                required 
                                rows={3}
                                className="w-full border rounded-md p-2 text-sm resize-none" 
                                placeholder="Olá, recebemos a sua mensagem..."
                                value={formData.response} 
                                onChange={e => setFormData({...formData, response: e.target.value})} 
                            />
                         </div>
                     ) : (
                         <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Nome da Tarefa</label>
                            <input 
                                required 
                                type="text" 
                                placeholder="ex: Tratar Pedido IRS"
                                className="w-full border rounded-md p-2 text-sm" 
                                value={formData.taskTitleTemplate} 
                                onChange={e => setFormData({...formData, taskTitleTemplate: e.target.value})} 
                            />
                            <p className="text-xs text-gray-500 mt-1">Será criada uma tarefa associada a esta conversa.</p>
                         </div>
                     )}
                 </div>

                 {/* 3. CONDIÇÕES (WHERE/WHO) */}
                 <div className="grid grid-cols-2 gap-3">
                     <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Público Alvo</label>
                        <select 
                            className="w-full border rounded-md p-2 text-sm bg-white"
                            value={formData.audience}
                            onChange={e => setFormData({...formData, audience: e.target.value as TriggerAudience})}
                        >
                            <option value="all">Todos</option>
                            <option value="allowed_only">Clientes Permitidos</option>
                        </select>
                     </div>
                     <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Horário</label>
                        <select 
                            className="w-full border rounded-md p-2 text-sm bg-white"
                            value={formData.schedule}
                            onChange={e => setFormData({...formData, schedule: e.target.value as TriggerSchedule})}
                        >
                            <option value="always">Sempre</option>
                            <option value="business_hours">Horário Comercial</option>
                            <option value="outside_hours">Fora de Horas</option>
                        </select>
                     </div>
                 </div>

                 <div className="flex items-center gap-2 pt-2 border-t">
                    <input 
                        type="checkbox" 
                        id="isActive"
                        checked={formData.isActive}
                        onChange={e => setFormData({...formData, isActive: e.target.checked})}
                        className="rounded text-whatsapp-600 focus:ring-whatsapp-500"
                    />
                    <label htmlFor="isActive" className="text-sm text-gray-700">Ativar imediatamente</label>
                 </div>

                 <div className="flex justify-end gap-2 mt-6">
                    <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-gray-600 text-sm">Cancelar</button>
                    <button type="submit" className="px-4 py-2 bg-whatsapp-600 text-white rounded-md text-sm hover:bg-whatsapp-700">Guardar</button>
                 </div>
              </form>
           </div>
        </div>
      )}

      {showTemplateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg w-full max-w-lg p-6">
            <h3 className="text-lg font-bold mb-4">
              {editingTemplateId ? 'Editar Template/Resposta' : 'Novo Template/Resposta'}
            </h3>
            <form onSubmit={handleTemplateSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nome</label>
                <input
                  required
                  type="text"
                  className="w-full border rounded-md p-2"
                  value={templateForm.name}
                  onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tipo</label>
                  <select
                    className="w-full border rounded-md p-2"
                    value={templateForm.kind}
                    onChange={(e) => setTemplateForm({ ...templateForm, kind: e.target.value as 'template' | 'quick_reply' })}
                  >
                    <option value="template">Template</option>
                    <option value="quick_reply">Resposta rápida</option>
                  </select>
                </div>
                <div className="flex items-end">
                  <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={templateForm.isActive}
                      onChange={(e) => setTemplateForm({ ...templateForm, isActive: e.target.checked })}
                    />
                    Ativo
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Conteúdo</label>
                <textarea
                  required
                  rows={4}
                  className="w-full border rounded-md p-2 resize-none"
                  value={templateForm.content}
                  onChange={(e) => setTemplateForm({ ...templateForm, content: e.target.value })}
                  placeholder="Ex: Olá {{nome}}, recebemos o seu pedido."
                />
                <p className="text-xs text-gray-500 mt-1">Variáveis suportadas: {`{{nome}}`} {`{{empresa}}`} {`{{telefone}}`}</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Meta Template Name (opcional)</label>
                <input
                  type="text"
                  className="w-full border rounded-md p-2"
                  value={templateForm.metaTemplateName}
                  onChange={(e) => setTemplateForm({ ...templateForm, metaTemplateName: e.target.value })}
                  placeholder="Ex: hello_world"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowTemplateModal(false)} className="px-4 py-2 text-gray-600">
                  Cancelar
                </button>
                <button type="submit" className="px-4 py-2 bg-whatsapp-600 text-white rounded-md">
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default AutoResponses;
