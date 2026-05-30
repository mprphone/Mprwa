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
- A extensão abre o portal permitido e guarda os pedidos de login apenas em `chrome.storage.session`.
- O content script no portal preenche utilizador/senha e apaga o pedido quando termina.
- A lista de clientes usada pelo popup é mantida só em memória de sessão da extensão.

## Portais permitidos

- Autoridade Tributária: `www.acesso.gov.pt`, `www.portaldasfinancas.gov.pt`, `sitfiscal.portaldasfinancas.gov.pt`
- Segurança Social: `www.seg-social.pt`, `app.seg-social.pt`, `extwww.seg-social.pt`
- Banco de Portugal: `www.bportugal.pt`, `clientebancario.bportugal.pt`, `sts.bportugal.pt`
- IEFP Online: `iefponline.iefp.pt`
- IAPMEI: `webapps.iapmei.pt`
- ViaCTT: `www.viactt.pt`
- Relatório Único: `www.relatoriounico.pt`

Não usa armazenamento persistente para senhas.
