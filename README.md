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
