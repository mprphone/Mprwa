'use strict';

{
  const api = window.__waProPortalCommon;
  if (api) {
    api.register('AT', {
      async before() {
        if (!/sts\.bportugal\.pt/i.test(window.location.hostname)) return false;
        const target = api.findClickableByText(['autenticação at', 'autenticacao at']);
        if (!target) return false;
        api.clickElement(target);
        await api.wait(500);
        api.sendDone({ credentialLabel: 'AT', keepPending: true });
        return true;
      },
    });
  }
}
