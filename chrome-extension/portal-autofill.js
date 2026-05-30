'use strict';

{
  const RUN_KEY = '__waProPortalAutofillRunStarted';
  if (!window[RUN_KEY]) {
    const api = window.__waProPortalCommon;
    if (api) {
      api.requestPendingPayload().then((payload) => {
        if (!payload) return;
        if (window[RUN_KEY]) return;
        window[RUN_KEY] = true;
        api.run(payload).catch((error) => {
          chrome.runtime.sendMessage({
            type: 'WA_PRO_AUTLOGIN_ERROR',
            error: String(error?.message || error),
          });
        });
      });
    }
  }
}
