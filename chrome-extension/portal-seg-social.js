'use strict';

{
  const api = window.__waProPortalCommon;
  if (api) {
    const LOG = (...args) => console.log('[WA-SS]', ...args);

    const selectors = {
      username: [
        'input[name="username"]',
        'input[name="niss"]',
        'input[id*="username" i]',
        'input[name*="user" i]',
        'input[id*="utilizador" i]',
        'input[name*="utilizador" i]',
        'input[id*="niss" i]',
        'input[placeholder*="NISS" i]',
        'input[autocomplete="username"]',
      ],
      password: [
        'input[name="password"]',
        'input[id*="password" i]',
        'input[placeholder*="senha" i]',
        'input[type="password"]',
      ],
      submit: [
        'form button[type="submit"]',
        'form input[type="submit"]',
        'button[type="submit"]',
        'input[type="submit"]',
      ],
    };

    function isTwoFactorPage() {
      if (!/seg-social\.pt/i.test(window.location.hostname)) return false;
      // If the login form is open (username + password visible), this is NOT a 2FA page.
      // The login page itself contains "Recebeu um código de verificação? Ativar conta"
      // which would otherwise cause a false positive.
      if (api.findFirst(selectors.username) && api.findFirst(selectors.password)) return false;
      // Se a página diz para aguardar (rate limit da SS), NÃO é uma página de 2FA activa.
      if (isWaitPage()) return false;
      const bodyText = api.textOf(document.body).toLowerCase();
      return bodyText.includes('autenticação de dois fatores') ||
        bodyText.includes('autenticacao de dois fatores') ||
        bodyText.includes('código de verificação') ||
        bodyText.includes('codigo de verificacao');
    }

    // Detecta página de rate-limit da SS ("já foi pedido... aguardar X minutos")
    function isWaitPage() {
      if (!/seg-social\.pt/i.test(window.location.hostname)) return false;
      const bodyText = api.textOf(document.body).toLowerCase();
      return bodyText.includes('aguardar') && (
        bodyText.includes('minuto') ||
        bodyText.includes('já foi pedido') ||
        bodyText.includes('ja foi pedido') ||
        bodyText.includes('já enviou') ||
        bodyText.includes('ja enviou') ||
        bodyText.includes('acesso bloqueado')
      );
    }

    function findTwoFactorInput() {
      return Array.from(document.querySelectorAll('input')).find((element) => {
        if (!api.visible(element)) return false;
        const haystack = `${element.name || ''} ${element.id || ''} ${element.placeholder || ''} ${element.getAttribute('aria-label') || ''}`.toLowerCase();
        return haystack.includes('code') || haystack.includes('codigo') || haystack.includes('código') || haystack.includes('verification');
      }) || api.findFirst(['input[type="text"]', 'input[type="tel"]', 'input:not([type])']);
    }

    async function fetchLatestCode() {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'WA_PRO_GET_SEG_SOCIAL_CODE' }, (reply) => resolve(reply || {}));
      });
      if (response?.success === false && response?.error) {
        throw new Error(String(response.error));
      }
      return response?.success && response?.found ? String(response.code || '').trim() : '';
    }

    async function fillTwoFactorIfPresent(payload) {
      if (!isTwoFactorPage()) return false;
      const input = findTwoFactorInput();
      if (!input) return false;
      LOG('2FA page detected, waiting for email code');
      const deadline = Date.now() + Number(payload?.emailPollMs || 25_000);
      while (Date.now() < deadline) {
        const code = await fetchLatestCode().catch((error) => {
          chrome.runtime.sendMessage({
            type: 'WA_PRO_AUTLOGIN_ERROR',
            error: `Não consegui consultar o email da Segurança Social: ${error?.message || error}`,
          });
          return '';
        });
        if (code) {
          LOG('2FA code found:', code);
          api.dispatchInput(input, code);
          await api.wait(150);
          const submit = api.findClickableByText(['confirmar código de verificação', 'confirmar codigo de verificacao', 'confirmar']);
          if (submit) api.clickElement(submit);
          else if (input.form?.requestSubmit) input.form.requestSubmit();
          api.sendDone({ credentialLabel: 'SS' });
          return true;
        }
        await api.wait(Number(payload?.emailPollIntervalMs || 1500));
      }
      chrome.runtime.sendMessage({
        type: 'WA_PRO_AUTLOGIN_ERROR',
        error: 'Código da Segurança Social não encontrado no email dentro do tempo esperado.',
      });
      return true;
    }

    async function waitForTwoFactor(payload, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (isTwoFactorPage()) return fillTwoFactorIfPresent(payload);
        await api.wait(500);
      }
      return false;
    }

    async function openUserLoginIfPresent() {
      if (api.findFirst(selectors.password)) {
        LOG('password field already visible, form is open');
        return false;
      }
      const allVisible = Array.from(document.querySelectorAll('button, a, [role="button"], div, span, p, h1, h2, h3'))
        .filter((el) => api.visible(el));
      LOG('visible interactive elements:', allVisible.length, 'url:', window.location.href);

      const candidates = allVisible.filter((element) => {
        const text = api.textOf(element).toLowerCase();
        if (text.includes('fechar')) return false;
        return text.includes('autenticar com utilizador') ||
          text.includes('utilizador da seguranca social') ||
          text.includes('utilizador da segurança social');
      });

      LOG('toggle candidates found:', candidates.length, candidates.map((el) => `${el.tagName}:"${api.textOf(el).slice(0, 60)}"`));

      const target = candidates.find((element) => /button|a/i.test(element.tagName) || element.getAttribute('role') === 'button') ||
        candidates[0]?.closest?.('button, a, [role="button"]') ||
        candidates[0] ||
        null;

      if (!target) {
        LOG('toggle button NOT found');
        return false;
      }

      LOG('clicking toggle:', target.tagName, api.textOf(target).slice(0, 80));
      api.clickElement(target);

      // Wait actively for password field to appear (up to 2s)
      const waitUntil = Date.now() + 2000;
      while (Date.now() < waitUntil) {
        await api.wait(150);
        if (api.findFirst(selectors.password)) {
          LOG('form opened successfully');
          return true;
        }
      }
      LOG('clicked toggle but password field still not visible after 2s');
      return true;
    }

    function findStartSessionTarget() {
      return Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .find((element) => {
          if (!api.visible(element)) return false;
          const text = api.textOf(element).toLowerCase();
          return text.includes('iniciar sessão') || text.includes('iniciar sessao');
        }) || null;
    }

    async function openLoginWhenLoggedOut(payload) {
      if (api.findFirst(selectors.password) || isTwoFactorPage()) return false;
      if (/\/sso\/login/i.test(window.location.pathname)) return false;
      const startSession = findStartSessionTarget();
      if (!startSession) {
        LOG('not on login page, no "iniciar sessão" button found, url:', window.location.href);
        return false;
      }
      LOG('redirecting to login page from:', window.location.href);
      window.location.href = String(payload.loginUrl || 'https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin');
      return true;
    }

    // Detectar erro CAS "A problem occurred restoring the flow execution"
    // e navegar para URL limpa para obter novo token de sessão
    function hasCasFlowException() {
      return /exception[._]message/i.test(window.location.search) ||
             /problem.*occurred.*restoring/i.test(window.location.search) ||
             /flow.*execution/i.test(window.location.search);
    }

    api.register('SS', {
      selectors,
      async afterFill(payload, commonApi, usernameInput, passwordInput) {
        LOG('afterFill called');
        usernameInput?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
        passwordInput?.focus?.();
        passwordInput?.dispatchEvent(new KeyboardEvent('keyup', { key: String(payload.password || '').slice(-1) || '0', bubbles: true, cancelable: true }));
        passwordInput?.blur?.();
        await api.wait(350);
      },
      findSubmit(payload, commonApi, passwordInput) {
        const passwordBox = passwordInput?.getBoundingClientRect?.() || null;
        const candidates = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"], [tabindex], div, span'))
          .map((element) => element.closest?.('button, input[type="submit"], input[type="button"], a, [role="button"], [tabindex]') || element)
          .filter((element, index, list) => element && api.visible(element) && list.indexOf(element) === index)
          .map((element, index) => {
            const rect = element.getBoundingClientRect();
            const text = api.textOf(element).toLowerCase();
            let score = index;
            if (text.trim() === 'entrar') score -= 1000;
            else if (text.includes('entrar')) score -= 700;
            else if (text.includes('iniciar sessão') || text.includes('iniciar sessao') || text.includes('autenticar')) score -= 350;
            if (passwordBox) {
              const verticalDistance = Math.abs(rect.top - passwordBox.bottom);
              const sameColumnPenalty = Math.abs(rect.left - passwordBox.left) > 220 ? 400 : 0;
              const belowPenalty = rect.top < passwordBox.top ? 500 : 0;
              const widthBonus = rect.width >= passwordBox.width * 0.7 ? -180 : 0;
              score += verticalDistance + sameColumnPenalty + belowPenalty + widthBonus;
            }
            return { element, score };
          })
          .filter((entry) => {
            const text = api.textOf(entry.element).toLowerCase();
            return text.includes('entrar') ||
              text.includes('iniciar sessão') ||
              text.includes('iniciar sessao') ||
              text.includes('autenticar');
          })
          .sort((a, b) => a.score - b.score);
        LOG('submit candidates:', candidates.slice(0, 3).map((c) => `"${api.textOf(c.element).slice(0, 40)}" score=${c.score}`));
        return candidates[0]?.element || null;
      },
      async afterSubmitClick(payload, commonApi, passwordInput, submit) {
        // Um único submit — múltiplos eventos causam rate-limit da SS ("aguardar X minutos")
        LOG('afterSubmitClick');
        await api.wait(250);
      },
      async before(payload) {
        LOG('before() url:', window.location.href, 'username:', payload?.username);
        // Página de rate-limit da SS — parar imediatamente com mensagem clara
        if (isWaitPage()) {
          LOG('SS wait/rate-limit page detected — stopping');
          chrome.runtime.sendMessage({ type: 'WA_PRO_AUTLOGIN_ERROR', error: 'A Segurança Social pediu para aguardar antes de tentar de novo (demasiadas tentativas). Aguarde alguns minutos e tente novamente.' });
          return true;
        }
        // Se o CAS devolveu erro de sessão expirada, recarregar com URL limpa
        if (hasCasFlowException()) {
          LOG('CAS flow exception detected — reloading with fresh login URL');
          const freshUrl = payload.loginUrl || 'https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin';
          window.location.href = freshUrl;
          return true;
        }
        if (await openLoginWhenLoggedOut(payload)) return true;
        if (await fillTwoFactorIfPresent(payload)) return true;
        await openUserLoginIfPresent();
        return false;
      },
      async beforeEach(payload) {
        // Página de rate-limit — parar imediatamente
        if (isWaitPage()) {
          LOG('SS wait/rate-limit page detected in beforeEach — stopping');
          chrome.runtime.sendMessage({ type: 'WA_PRO_AUTLOGIN_ERROR', error: 'A Segurança Social pediu para aguardar antes de tentar de novo. Aguarde alguns minutos e tente novamente.' });
          return true;
        }
        if (hasCasFlowException()) {
          const freshUrl = payload.loginUrl || 'https://www.seg-social.pt/sso/login?service=https%3A%2F%2Fwww.seg-social.pt%2Fptss%2Fcaslogin';
          window.location.href = freshUrl;
          return true;
        }
        if (await openLoginWhenLoggedOut(payload)) return true;
        await openUserLoginIfPresent();
        await fillTwoFactorIfPresent(payload);
        return false;
        return false;
      },
      async afterSubmit(payload) {
        LOG('afterSubmit, keepPendingAfterSubmit:', payload.keepPendingAfterSubmit);
        if (payload.keepPendingAfterSubmit === true) {
          void waitForTwoFactor(payload);
        }
      },
    });
  }
}
