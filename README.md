# WhatsApp Manager (MVP)

Aplicação minimalista para envio e recebimento de mensagens do WhatsApp Business API com Node.js e SQLite.

## Guias por sistema operativo
- Windows: `WINDOWS_INSTALL_GUIDE.md`
- Ubuntu/Oracle Linux: `UBUNTU_MIGRATION_GUIDE.md`
- Mobile nativo (Capacitor): `docs/MOBILE_NATIVE_SETUP.md`

## Estrutura
- **Backend:** Node.js + Express (Porta 3000)
- **Banco de Dados:** SQLite (`whatsapp.db`)
- **Frontend:** React + Tailwind (na pasta `src`, compilado para `dist`)

## Configuração Inicial
1. Instale as dependências:
   ```bash
   npm ci
   ```
2. Configure o arquivo `.env` com o provider de WhatsApp:
   - Cloud API (atual): `WHATSAPP_PROVIDER=cloud`, `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`
   - Baileys (novo): `WHATSAPP_PROVIDER=baileys`

### WhatsApp Provider (Cloud ou Baileys)
Variáveis úteis no `.env`:
- `WHATSAPP_PROVIDER=cloud|baileys`
- `WHATSAPP_TOKEN=...` (obrigatório só em `cloud`)
- `PHONE_NUMBER_ID=...` (obrigatório só em `cloud`)
- `WHATSAPP_BAILEYS_AUTH_DIR=.baileys_auth` (opcional)
- `WHATSAPP_BAILEYS_PRINT_QR=false` (opcional)
- `WHATSAPP_BAILEYS_AUTO_START=true` (opcional)

Endpoints de controlo:
- `GET /api/chat/whatsapp/health`
- `GET /api/chat/whatsapp/qr`
- `GET /api/chat/whatsapp/qr/image` (PNG pronto para scan)
- `POST /api/chat/whatsapp/connect`
- `POST /api/chat/whatsapp/disconnect`

## Autenticação da API (Segurança)

A API tem autenticação por sessão (login server-side + cookie HttpOnly assinado com HMAC).
Está desenhada em **duas fases** para poder ser ativada sem interromper o serviço.

O acesso externo entra sempre pelo **nginx** (serviço systemd `mprwa-backend` →
`proxy_pass http://127.0.0.1:3010`). Continua a poder abrir-se de qualquer parte do
mundo pelo endereço público — a autenticação **só acrescenta o login, não retira acesso**.

### Variáveis de ambiente (`.env`)
- `REQUIRE_API_AUTH=true` — liga o middleware de auth (default no código: `true`).
- `ALLOW_LOCAL_API_WITHOUT_AUTH` — se `true`, pedidos vindos de `127.0.0.1` saltam a auth.
  **Como o nginx encaminha de localhost, com isto a `true` todo o tráfego externo continua
  a passar sem login** (estado da Fase 1). Pôr a `false` é o que ativa a proteção real.
- `AUTH_SECRET` — segredo que assina os tokens de sessão. Tem de ser aleatório, forte e
  fixo (já definido). Sem ele, cai num fallback previsível e os tokens ficam forjáveis.
- `INTERNAL_API_KEY` — chave para chamadas internas server→server (workers, obrigações,
  notificações, proxy chat-core, script batch). Enviada no header `x-internal-api-key`
  (helper `src/server/utils/internalApi.js`).

### Fase 1 — EM OBSERVAÇÃO (deploy sem impacto)
- Endpoints `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
- `AUTH_SECRET` e `INTERNAL_API_KEY` no `.env`.
- Os chamadores internos conhecidos enviam a `INTERNAL_API_KEY`, incluindo os
  coletores fiscais através de `backend/services/fiscal/collectors/httpPost.js`.
- `ALLOW_LOCAL_API_WITHOUT_AUTH=true` → nada mudou para os utilizadores; o login **ainda não
  é obrigatório** e o leak anónimo (ex.: `/api/import/supabase` com senhas dos clientes)
  ainda **não está fechado**.

O roteiro completo, critérios de avanço, matriz de testes e rollback estão em
[`SECURITY_AUTH_MIGRATION.md`](SECURITY_AUTH_MIGRATION.md). Não ativar a Fase 2
apenas com base nesta secção resumida.

### Fase 2 — ATIVAR A PROTEÇÃO (só depois de testar a Fase 1)
1. No `.env`: `ALLOW_LOCAL_API_WITHOUT_AUTH=false`
2. `sudo systemctl restart mprwa-backend`
3. A partir daqui o login passa a ser **obrigatório**. Testar:
   - Login web/desktop de fora (deve funcionar após autenticar; acesso mundial mantém-se).
   - Pedido sem sessão a um endpoint protegido (ex.: `/api/import/supabase`) → **401**.
   - Fluxos internos: sincronização de clientes, obrigações (SAF-T/DMR/DRI/IVA),
     notificações (`/api/chat/send`), proxy chat-core.
   - Script `scripts/batch-saft-m22-ies-all.js` (precisa da `INTERNAL_API_KEY` no ambiente).

Se um fluxo interno falhar com 401, confirmar que o processo tem a `INTERNAL_API_KEY`
correta e que envia o header `x-internal-api-key`.

### Log de eventos de auth (`logs/auth-events.log`)
Registado automaticamente pelo middleware. Serve de rede de segurança para a transição:
- `[bypass] ... via=local_direct internalKey=absent` → chamador interno que **partiria**
  na Fase 2 (não está a enviar a `INTERNAL_API_KEY`). Corrigir **antes** de avançar.
- `[bypass] ... via=external_proxy sessionToken=false` → utilizador externo que passará a
  precisar de login (comportamento esperado).
- Depois do flip da Fase 2, as linhas `[reject]` mostram os 401 reais.

Verificação rápida antes de fechar o bypass (não deve devolver nada):
```bash
npm run auth:usage -- --hours=24
```
Se aparecer algum endpoint interno aqui, ainda não está pronto para a Fase 2.

Configurável: `AUTH_EVENTS_LOG` (caminho do ficheiro) e `AUTH_EVENTS_DEDUPE_MS`
(intervalo de deduplicação por rota; default 10 min).

Complemento recomendado: ligar o `:3010` só a `127.0.0.1` (o nginx é a porta de entrada),
removendo o acesso direto pela LAN que contornaria a auth.

## Como Rodar
1. Compile o Frontend (necessário sempre que alterar arquivos em `src`):
   ```bash
   npm run build
   ```
2. Inicie o Servidor:
   ```bash
   node server.js
   ```
3. Acesse no navegador:
   - **URL:** http://localhost:3000

## Recebimento de Mensagens (Webhook)
Para receber mensagens em localhost (teste) no Ubuntu:
1. Baixe o **cloudflared-linux-arm64** ou **cloudflared-linux-amd64** (conforme a máquina):
   - https://github.com/cloudflare/cloudflared/releases/latest
2. Dê permissão de execução ao binário:
   ```bash
   chmod +x ./cloudflared
   ```
3. Inicie o túnel:
   ```bash
   ./cloudflared tunnel --url http://localhost:3000
   ```
4. Copie a URL gerada (ex: `https://random-name.trycloudflare.com`).
5. No painel da Meta (WhatsApp > Configuration), configure o Webhook:
   - **Callback URL:** Cole a URL do Cloudflare e adicione `/webhook/whatsapp` no final.
   - **Verify Token:** O mesmo definido no seu `.env`.

## API Telegram (novo)
Configuração no `.env`:
- `TELEGRAM_BOT_TOKEN=<token do BotFather>`
- `TELEGRAM_WEBHOOK_SECRET=<segredo opcional>`
- `TELEGRAM_WEBHOOK_PATH=/webhook/telegram` (opcional)
- `API_PUBLIC_BASE_URL=https://o-seu-dominio` (necessário para auto-configurar webhook)

Endpoints:
- `GET /api/telegram/health` -> estado da integração
- `POST /api/telegram/send` -> envio de mensagem
- `POST /api/telegram/webhook/set` -> regista webhook no Telegram
- `POST /webhook/telegram` -> receção de mensagens inbound

Exemplo de envio:
```bash
curl -X POST http://localhost:3000/api/telegram/send \
  -H "Content-Type: application/json" \
  -d '{"chatId":"123456789","message":"Olá via Telegram!"}'
```
# Mprwa
