import React, { useEffect, useMemo, useState } from 'react';
import { CalendarCheck2, Copy, FileText, Plus, Receipt, Save, Wallet, X } from 'lucide-react';
import { mockService } from '../services/mockData';

type SaveState = {
  kind: 'ok' | 'error';
  message: string;
} | null;

type ManagedTemplate = {
  id: string;
  name: string;
  kind: 'template' | 'quick_reply';
  content: string;
  metaTemplateName?: string;
  isActive: boolean;
};

const ResponseForms: React.FC = () => {
  const [saveState, setSaveState] = useState<SaveState>(null);
  const [copyState, setCopyState] = useState<string>('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [customTemplates, setCustomTemplates] = useState<ManagedTemplate[]>([]);
  const [newForm, setNewForm] = useState({
    name: '',
    content: '',
    metaTemplateName: '',
    isActive: true,
  });

  const [invoiceForm, setInvoiceForm] = useState({
    retentionRule: 'Dispensa de retenção - art. 101.º-B',
    ivaRule: 'Isento art. 53.º',
  });

  const [closingForm, setClosingForm] = useState({
    company: '{{empresa}}',
    deadline: '{{data_limite}}',
  });

  const [taxForm, setTaxForm] = useState({
    taxType: '{{imposto}}',
    period: '{{periodo}}',
    deadline: '{{data_limite}}',
    entity: '{{entidade}}',
    reference: '{{referencia}}',
    amount: '{{montante}}',
  });

  const invoiceTemplate = useMemo(
    () => `*Assunto: Como emitir a sua Fatura-Recibo* 📄

Olá {{nome}}! Para emitir corretamente no Portal das Finanças:

1. Aceda a _Cidadãos > Serviços > Recibos Verdes > Emitir_.
2. Escolha a opção *Fatura-Recibo*.
3. Em *Data de Prestação*, indique a data do serviço.
4. Em *Tipo*, selecione _Pagamento de bens ou serviços_.
5. Em *Base de incidência em IRS*, use: ${invoiceForm.retentionRule}.
6. Em *IVA*, use: ${invoiceForm.ivaRule}.

*Nota:* guarde o PDF e envie-nos por este chat quando concluir.`,
    [invoiceForm]
  );

  const closingTemplate = useMemo(
    () => `*Assunto: Documentação para Encerramento de Exercício* 📅

Olá {{nome}}! Para fecharmos o ano contabilístico da *${closingForm.company}*, precisamos destes elementos até *${closingForm.deadline}*:

⬜ Extratos bancários (01/01 a 31/12)
⬜ Inventário de stock a 31/12 (se aplicável)
⬜ Quilometragem final + despesas de viaturas
⬜ Atas de assembleia geral do ano
⬜ Acordos de empréstimo/suprimentos

Pode enviar fotos ou PDFs diretamente por este chat.`,
    [closingForm]
  );

  const taxTemplate = useMemo(
    () => `*Assunto: Guia de Pagamento de Imposto* 🏦

Olá {{nome}}! Seguem os dados para o pagamento:

*Imposto:* ${taxForm.taxType}
*Período:* ${taxForm.period}
*Data Limite:* ${taxForm.deadline}

*Dados para Pagamento*
*Entidade:* ${taxForm.entity}
*Referência:* ${taxForm.reference}
*Montante:* ${taxForm.amount} €

Após pagamento, envie o comprovativo para darmos baixa no sistema. Obrigado!`,
    [taxForm]
  );

  const copyTemplate = async (key: string, content: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      }
      setCopyState(key);
      setTimeout(() => setCopyState(''), 1500);
    } catch (error) {
      setSaveState({
        kind: 'error',
        message: `Falha ao copiar template: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
      });
    }
  };

  const saveTemplate = async (payload: { id: string; name: string; content: string }) => {
    await mockService.saveManagedTemplate({
      id: payload.id,
      name: payload.name,
      kind: 'template',
      content: payload.content,
      isActive: true,
    });
  };

  const saveAllTemplates = async () => {
    try {
      await saveTemplate({
        id: 'faq_fatura_recibo',
        name: 'FAQ | Emissão de Fatura-Recibo',
        content: invoiceTemplate,
      });
      await saveTemplate({
        id: 'faq_encerramento_ano',
        name: 'FAQ | Encerramento de Ano',
        content: closingTemplate,
      });
      await saveTemplate({
        id: 'faq_pagamento_impostos',
        name: 'FAQ | Pagamento de Impostos',
        content: taxTemplate,
      });
      setSaveState({
        kind: 'ok',
        message: 'Os 3 formulários foram guardados nas Respostas Rápidas.',
      });
      await loadCustomTemplates();
    } catch (error) {
      setSaveState({
        kind: 'error',
        message: `Falha ao guardar formulários: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
      });
    }
  };

  const resetNewForm = () => {
    setNewForm({
      name: '',
      content: '',
      metaTemplateName: '',
      isActive: true,
    });
  };

  const slugify = (value: string) =>
    String(value || '')
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 40);

  const loadCustomTemplates = async () => {
    const templates = await mockService.getManagedTemplates('template');
    setCustomTemplates(templates);
  };

  useEffect(() => {
    void loadCustomTemplates();
  }, []);

  const handleCreateForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newForm.name.trim();
    const content = newForm.content.trim();

    if (!name || !content) {
      setSaveState({
        kind: 'error',
        message: 'Preencha nome e conteúdo para criar o formulário.',
      });
      return;
    }

    try {
      await mockService.saveManagedTemplate({
        id: `form_${slugify(name)}_${Date.now()}`,
        name,
        kind: 'template',
        content,
        metaTemplateName: newForm.metaTemplateName.trim() || undefined,
        isActive: newForm.isActive,
      });
      setSaveState({
        kind: 'ok',
        message: `Formulário "${name}" criado com sucesso.`,
      });
      setShowCreateModal(false);
      resetNewForm();
      await loadCustomTemplates();
    } catch (error) {
      setSaveState({
        kind: 'error',
        message: `Falha ao criar formulário: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
      });
    }
  };

  return (
    <div className="w-full space-y-4 p-4 md:p-6">
      <div className="rounded-2xl border border-slate-700/20 bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-900 p-4 text-white shadow-sm md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-bold md:text-2xl">Formulários</h1>
            <p className="text-xs text-slate-200 md:text-sm">
              Modelos prontos para dúvidas comuns, com variáveis e texto otimizado para WhatsApp.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setSaveState(null);
                setShowCreateModal(true);
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/20 md:text-sm"
            >
              <Plus size={16} /> Novo Formulário
            </button>
            <button
              onClick={saveAllTemplates}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500 md:text-sm"
            >
              <Save size={16} /> Guardar os 3 Formulários
            </button>
          </div>
        </div>
      </div>

      {saveState && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${
            saveState.kind === 'ok'
              ? 'bg-green-50 border-green-200 text-green-700'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}
        >
          {saveState.message}
        </div>
      )}

      <section className="bg-white border border-gray-200 rounded-xl p-5">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">Formulários Criados</h2>
        <div className="space-y-2 max-h-56 overflow-auto pr-1">
          {customTemplates.length === 0 && (
            <p className="text-sm text-gray-500">Ainda não existem formulários guardados.</p>
          )}
          {customTemplates.map((template) => (
            <div key={template.id} className="border border-gray-200 rounded-lg p-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900">{template.name}</p>
                <p className="text-xs text-gray-500 truncate">{template.content}</p>
              </div>
              <button
                onClick={() => copyTemplate(template.id, template.content)}
                className="shrink-0 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-gray-200 rounded-md hover:bg-gray-50"
              >
                <Copy size={12} /> {copyState === template.id ? 'Copiado' : 'Copiar'}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Receipt size={18} className="text-whatsapp-600" /> 1) Emissão de Fatura-Recibo
          </h2>
          <button
            onClick={() => copyTemplate('invoice', invoiceTemplate)}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 border border-gray-200 rounded-md hover:bg-gray-50"
          >
            <Copy size={14} /> {copyState === 'invoice' ? 'Copiado' : 'Copiar'}
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            type="text"
            className="border rounded-md px-3 py-2 text-sm"
            value={invoiceForm.retentionRule}
            onChange={(e) => setInvoiceForm((prev) => ({ ...prev, retentionRule: e.target.value }))}
            placeholder="Regra IRS"
          />
          <input
            type="text"
            className="border rounded-md px-3 py-2 text-sm"
            value={invoiceForm.ivaRule}
            onChange={(e) => setInvoiceForm((prev) => ({ ...prev, ivaRule: e.target.value }))}
            placeholder="Regra IVA"
          />
        </div>
        <textarea value={invoiceTemplate} readOnly rows={12} className="w-full border rounded-md p-3 text-sm bg-gray-50" />
      </section>

      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <CalendarCheck2 size={18} className="text-whatsapp-600" /> 2) Encerramento de Ano
          </h2>
          <button
            onClick={() => copyTemplate('closing', closingTemplate)}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 border border-gray-200 rounded-md hover:bg-gray-50"
          >
            <Copy size={14} /> {copyState === 'closing' ? 'Copiado' : 'Copiar'}
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            type="text"
            className="border rounded-md px-3 py-2 text-sm"
            value={closingForm.company}
            onChange={(e) => setClosingForm((prev) => ({ ...prev, company: e.target.value }))}
            placeholder="Empresa (ex: {{empresa}})"
          />
          <input
            type="text"
            className="border rounded-md px-3 py-2 text-sm"
            value={closingForm.deadline}
            onChange={(e) => setClosingForm((prev) => ({ ...prev, deadline: e.target.value }))}
            placeholder="Data limite (ex: {{data_limite}})"
          />
        </div>
        <textarea value={closingTemplate} readOnly rows={11} className="w-full border rounded-md p-3 text-sm bg-gray-50" />
      </section>

      <section className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <Wallet size={18} className="text-whatsapp-600" /> 3) Pagamento de Impostos
          </h2>
          <button
            onClick={() => copyTemplate('tax', taxTemplate)}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 border border-gray-200 rounded-md hover:bg-gray-50"
          >
            <Copy size={14} /> {copyState === 'tax' ? 'Copiado' : 'Copiar'}
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            type="text"
            className="border rounded-md px-3 py-2 text-sm"
            value={taxForm.taxType}
            onChange={(e) => setTaxForm((prev) => ({ ...prev, taxType: e.target.value }))}
            placeholder="Imposto"
          />
          <input
            type="text"
            className="border rounded-md px-3 py-2 text-sm"
            value={taxForm.period}
            onChange={(e) => setTaxForm((prev) => ({ ...prev, period: e.target.value }))}
            placeholder="Período"
          />
          <input
            type="text"
            className="border rounded-md px-3 py-2 text-sm"
            value={taxForm.deadline}
            onChange={(e) => setTaxForm((prev) => ({ ...prev, deadline: e.target.value }))}
            placeholder="Data limite"
          />
          <input
            type="text"
            className="border rounded-md px-3 py-2 text-sm"
            value={taxForm.entity}
            onChange={(e) => setTaxForm((prev) => ({ ...prev, entity: e.target.value }))}
            placeholder="Entidade"
          />
          <input
            type="text"
            className="border rounded-md px-3 py-2 text-sm"
            value={taxForm.reference}
            onChange={(e) => setTaxForm((prev) => ({ ...prev, reference: e.target.value }))}
            placeholder="Referência"
          />
          <input
            type="text"
            className="border rounded-md px-3 py-2 text-sm"
            value={taxForm.amount}
            onChange={(e) => setTaxForm((prev) => ({ ...prev, amount: e.target.value }))}
            placeholder="Montante"
          />
        </div>
        <textarea value={taxTemplate} readOnly rows={12} className="w-full border rounded-md p-3 text-sm bg-gray-50" />
      </section>

      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Novo Formulário</h3>
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  resetNewForm();
                }}
                className="p-1 text-gray-500 hover:text-gray-700"
                aria-label="Fechar"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleCreateForm} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nome</label>
                <input
                  required
                  type="text"
                  className="w-full border rounded-md px-3 py-2 text-sm"
                  value={newForm.name}
                  onChange={(e) => setNewForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="Ex: FAQ | Abertura de Atividade"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Conteúdo</label>
                <textarea
                  required
                  rows={10}
                  className="w-full border rounded-md px-3 py-2 text-sm resize-y"
                  value={newForm.content}
                  onChange={(e) => setNewForm((prev) => ({ ...prev, content: e.target.value }))}
                  placeholder={'Use variáveis como {{nome}}, {{empresa}}, {{telefone}}'}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Meta Template Name (opcional)</label>
                <input
                  type="text"
                  className="w-full border rounded-md px-3 py-2 text-sm"
                  value={newForm.metaTemplateName}
                  onChange={(e) => setNewForm((prev) => ({ ...prev, metaTemplateName: e.target.value }))}
                  placeholder="Ex: hello_world"
                />
              </div>

              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={newForm.isActive}
                  onChange={(e) => setNewForm((prev) => ({ ...prev, isActive: e.target.checked }))}
                />
                Ativo para uso imediato
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    resetNewForm();
                  }}
                  className="px-4 py-2 text-sm text-gray-700"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm bg-whatsapp-600 text-white rounded-md hover:bg-whatsapp-700"
                >
                  Criar Formulário
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ResponseForms;
