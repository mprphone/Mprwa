# Chat Core Architecture (MPR WA)

## Objetivo
Isolar o canal crítico de comunicação (WhatsApp) das restantes funcionalidades para reduzir risco de regressões e indisponibilidade.

## Processos PM2
- `whatsapp-chat-core` (porta `3012`, `APP_ROLE=chat_core`)
  - Webhook, envio/receção, fila, dead-letter, stream em tempo real.
- `whatsapp-manager` (porta `3010`, `APP_ROLE=backoffice`)
  - UI, SAFT, relatórios, importações e restantes módulos.
  - Encaminha `/webhook` e `/api/chat/*` internamente para `http://127.0.0.1:3012`.

## Princípios
- Chat primeiro: envio/receção nunca deve depender de SAFT, automações, relatórios ou importações.
- Isolamento por namespace: funcionalidades críticas usam `/api/chat/*`.
- Falha controlada: automações não podem bloquear webhook nem envio manual.
- Persistência local: mensagens, conversas e fila mantidas em SQLite local.

## API crítica
- `GET /api/chat/health`
- `GET /api/chat/contacts`
- `GET /api/chat/messages?phone=<digits>`
- `POST /api/chat/send`
- `GET /api/chat/conversations/local`
- `POST /api/chat/conversations/sync`
- `GET|POST /webhook/whatsapp`

## Separação operacional
- Chat Core:
  - webhook de entrada
  - fila de saída (`outbound_queue`)
  - dead-letter para falhas definitivas (`outbound_dead_letter`)
  - estado de entrega (`messages.status`, `outbound_queue.status`)
  - stream tempo real (`/api/chat/stream`) para atualizar Inbox sem polling agressivo
  - idempotência por `wa_id` único em `messages`
  - módulo dedicado: `backend/chatCoreRoutes.js`
  - UI dedicada: `components/inbox/ConversationListPanel.tsx`, `components/inbox/ChatHeaderBar.tsx`, `components/inbox/MessageThread.tsx`
  - Painel isolado: `components/inbox/ConversationDetailsSidebar.tsx`, `components/inbox/TasksPanel.tsx`
  - Modais isolados: `components/inbox/CallLogModal.tsx`, `components/inbox/TemplatePickerModal.tsx`, `components/inbox/TemplateConfirmModal.tsx`, `components/inbox/NewChatModal.tsx`, `components/inbox/LinkCustomerModal.tsx`
- Não-core (isolado):
  - SAFT e robô de recolha
  - métricas, alertas, auditoria
  - importações sincronizadas
  - automações opcionais

## Flags de segurança
- `ENABLE_WEBHOOK_AUTOREPLY=false` (recomendado em produção)
  - Quando `false`, o webhook só persiste e atualiza conversa.
  - Respostas automáticas não são executadas no caminho crítico.
- `MAX_QUEUE_RETRIES=5` (default)
  - Após exceder tentativas, mensagem vai para `outbound_dead_letter`.

## Regras para novas features
- Não adicionar chamadas externas (SAFT/email/AI) dentro de `/webhook` e `/api/chat/send`.
- Qualquer automação deve correr assíncrona e opcional.
- Qualquer funcionalidade nova deve expor endpoint fora de `/api/chat/*`.
