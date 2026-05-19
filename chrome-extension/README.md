# WA PRO Auto Login — Chrome Extension

Extensão MV3 para autologin assistido a partir da WA PRO.

## Instalar em modo developer

1. Abrir `chrome://extensions`.
2. Ativar **Modo de programador**.
3. Clicar **Carregar expandida**.
4. Escolher a pasta `chrome-extension` deste projeto.
5. Abrir/recarregar a WA PRO no Chrome.

## Como funciona

- A página WA PRO envia um pedido local via `window.postMessage`.
- A extensão só aceita pedidos vindos de `https://wa.mpr.pt`, `localhost` ou `127.0.0.1`.
- A extensão abre o portal permitido e guarda as credenciais apenas em `chrome.storage.session`.
- O content script no portal preenche utilizador/senha e apaga o pedido quando termina.

## Portais permitidos

- Autoridade Tributária: `www.acesso.gov.pt`, `*.portaldasfinancas.gov.pt`
- Segurança Social: `www.seg-social.pt`

Não usa armazenamento persistente para senhas.
