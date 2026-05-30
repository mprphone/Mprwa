'use strict';

{
  const api = window.__waProPortalCommon;
  if (api) {
    async function activateNifTabIfPresent() {
      if (!/acesso\.gov\.pt|portaldasfinancas\.gov\.pt/i.test(window.location.hostname)) return false;
      const candidates = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="button"], li, div, span'))
        .filter((element) => {
          if (!api.visible(element)) return false;
          const text = api.textOf(element).toLowerCase();
          return text === 'nif' || /^nif\b/.test(text) || String(element.getAttribute('aria-label') || '').toLowerCase() === 'nif';
        })
        .map((element) => {
          const clickable = element.closest?.('button, a, [role="tab"], [role="button"], li') || element;
          const textLength = api.textOf(element).length;
          return { element: clickable, textLength };
        })
        .filter((entry, index, list) => entry.element && list.findIndex((item) => item.element === entry.element) === index)
        .sort((a, b) => a.textLength - b.textLength)
        .map((entry) => entry.element);
      const target = candidates.find((element) => {
        const text = api.textOf(element).toLowerCase();
        const selected = String(element.getAttribute('aria-selected') || '').toLowerCase();
        const classes = String(element.className || '').toLowerCase();
        return text.includes('nif') && selected !== 'true' && !classes.includes('active') && !classes.includes('selected');
      }) || candidates[0] || null;
      if (!target) return false;
      api.clickElement(target);
      await api.wait(700);
      const nifInput = api.findFirst([
        'input[placeholder*="Contribuinte" i]',
        'input[aria-label*="Contribuinte" i]',
        'input[name="username"]',
        'input[name="nif"]',
        'input[type="text"]',
      ]);
      if (!nifInput) {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        await api.wait(700);
      }
      return true;
    }

    async function activateNifTabUntilReady(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ready = api.findFirst([
          'input[placeholder*="Contribuinte" i]',
          'input[aria-label*="Contribuinte" i]',
          'input[name="username"]',
          'input[name="nif"]',
        ]);
        if (ready) return true;
        await activateNifTabIfPresent();
        await api.wait(350);
      }
      return false;
    }

    async function authorizeConsentIfPresent() {
      if (!/acesso\.gov\.pt/i.test(window.location.hostname)) return false;
      const bodyText = api.textOf(document.body).toLowerCase();
      if (!bodyText.includes('consentimento') && !bodyText.includes('autorizo')) return false;
      const target = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a, [role="button"]'))
        .find((element) => {
          if (!api.visible(element)) return false;
          const text = api.textOf(element).toLowerCase();
          return text.includes('autorizo') && !text.includes('não') && !text.includes('nao');
        }) || null;
      if (!target) return false;
      api.clickElement(target);
      await api.wait(500);
      return true;
    }

    async function waitForConsent(timeoutMs = 20_000) {
      if (!/acesso\.gov\.pt/i.test(window.location.hostname)) return false;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await authorizeConsentIfPresent()) return true;
        await api.wait(350);
      }
      return false;
    }

    api.register('AT', {
      selectors: {
        username: [
          'form[name="loginForm"] input[name="username"]',
          'input[name="username"]',
          'input[placeholder*="Contribuinte" i]',
          'input[aria-label*="Contribuinte" i]',
          'input[name="representante"]',
          'input[name="nif"]',
          'input[type="text"]',
        ],
        password: [
          'form[name="loginForm"] input[name="password"]',
          'input[name="password"]',
          'input[placeholder*="Senha" i]',
          'input[type="password"]',
        ],
        submit: [
          'form[name="loginForm"] button[type="submit"]',
          'form[name="loginForm"] input[type="submit"]',
          'button[type="submit"]',
          'input[type="submit"]',
        ],
      },
      async before(payload) {
        if (await authorizeConsentIfPresent()) {
          api.sendDone({ credentialLabel: 'AT' });
          return true;
        }
        // If AT credentials were already submitted in this flow (e.g. BPortugal redirect chain),
        // skip re-filling to avoid logging into Portal das Finanças instead of the target service.
        if (payload?.loginAttempted) return true;
        await activateNifTabUntilReady();
        return false;
      },
      async beforeEach() {
        await activateNifTabUntilReady(1200);
        return false;
      },
      async afterSubmit(payload) {
        if (payload.keepPendingAfterSubmit === true) {
          void waitForConsent().then(() => {
            api.sendDone({ credentialLabel: 'AT' });
          });
        }
      },
    });
  }
}
