# WA PRO Mobile (Capacitor)

Esta base cria uma app nativa separada da versão desktop (Electron), sem impactar o fluxo do PC.

## O que foi preparado

- Projeto Android nativo em `android/`
- Config Capacitor em `capacitor.config.ts`
- Registo de token push no backend:
  - `POST /api/mobile/push/register`
  - `POST /api/mobile/push/unregister`
  - `POST /api/mobile/push/test`
  - `GET /api/mobile/push/devices`
- Tabela SQLite de dispositivos push: `mobile_push_devices`
- Inicialização automática no frontend: `services/mobileNative.ts`

## Comandos

```bash
npm run mobile:build
npm run mobile:sync
npm run mobile:open:android
npm run mobile:run:android
```

Se precisares iOS (num Mac):

```bash
npm run mobile:add:ios
npm run mobile:open:ios
```

## Push em background (FCM)

Para notificações reais com a app em background/fechada, configura Firebase Admin no backend.

Variáveis de ambiente:

- `FIREBASE_PUSH_ENABLED=true`
- `FIREBASE_PROJECT_ID=...`
- `FIREBASE_CLIENT_EMAIL=...`
- `FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n`

Alternativa (JSON completo):

- `FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}`

## Teste rápido de push

1. Instalar e abrir app Android.
2. Garantir permissões de notificação.
3. Enviar teste:

```bash
curl -X POST http://localhost:3000/api/mobile/push/test \
  -H "Content-Type: application/json" \
  -d '{"title":"Teste","body":"Push OK","route":"/inbox"}'
```

## Notas importantes

- Sem credenciais Firebase, o sistema continua funcional mas não envia push em background.
- O desktop Electron não usa esta stack e mantém-se inalterado.
