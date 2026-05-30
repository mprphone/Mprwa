'use strict';

{
  const api = window.__waProPortalCommon;
  if (api) {
    const loginUrl = 'https://www.viactt.pt/fevia/app/auth/checkUser.jspx';

    api.register('VIACTT', {
      selectors: {
        username: [
          'input[name="username"]',
          'input[id*="username" i]',
          'input[name*="user" i]',
          'input[id*="user" i]',
          'input[name*="utilizador" i]',
          'input[id*="utilizador" i]',
          'input[name*="email" i]',
          'input[id*="email" i]',
          'input[name*="nif" i]',
          'input[id*="nif" i]',
          'input[type="email"]',
          'input[type="text"]',
        ],
        password: [
          'input[name="password"]',
          'input[id*="password" i]',
          'input[name*="pass" i]',
          'input[id*="pass" i]',
          'input[name*="senha" i]',
          'input[id*="senha" i]',
          'input[type="password"]',
        ],
        submit: [
          'button[type="submit"]',
          'input[type="submit"]',
          'input[type="button"]',
          'input[type="image"]',
          'button',
          'a',
          '[role="button"]',
        ],
      },
      async before() {
        if (window.location.hostname === 'viactt.pt') {
          window.location.href = `https://www.viactt.pt${window.location.pathname}${window.location.search || ''}${window.location.hash || ''}`;
          return true;
        }
        if (/\/fevpe\//i.test(window.location.pathname)) {
          window.location.href = loginUrl;
          return true;
        }
        return false;
      },
      async beforeEach() {
        if (window.location.hostname === 'viactt.pt') {
          window.location.href = `https://www.viactt.pt${window.location.pathname}${window.location.search || ''}${window.location.hash || ''}`;
          return true;
        }
        if (/\/fevpe\//i.test(window.location.pathname)) {
          window.location.href = loginUrl;
          return true;
        }
        return false;
      },
      findSubmit(payload, commonApi, passwordInput) {
        const candidates = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], a, [role="button"]'))
          .filter(api.visible);
        const loginBox = passwordInput?.closest?.('form, table, fieldset, div') || null;
        const inLoginBox = (element) => loginBox && (loginBox === element || loginBox.contains(element));
        const score = (element) => {
          let value = inLoginBox(element) ? 20 : 0;
          const text = api.textOf(element).toLowerCase();
          const title = String(element.getAttribute('title') || element.getAttribute('alt') || element.getAttribute('value') || '').toLowerCase();
          const haystack = `${text} ${title}`;
          if (haystack.includes('continuar')) value += 30;
          if (haystack.includes('entrar')) value += 15;
          if (element.type === 'image') value += 5;
          return value;
        };
        const ranked = candidates
          .map((element) => ({ element, score: score(element) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score);
        if (ranked[0]) return ranked[0].element;
        return candidates.find((element) => {
          const text = api.textOf(element).toLowerCase();
          const title = String(element.getAttribute('title') || element.getAttribute('alt') || element.getAttribute('value') || '').toLowerCase();
          return text.includes('continuar') || title.includes('continuar');
        }) || candidates.find((element) => {
          const text = api.textOf(element).toLowerCase();
          const title = String(element.getAttribute('title') || element.getAttribute('alt') || element.getAttribute('value') || '').toLowerCase();
          return text.includes('entrar') || title.includes('entrar');
        }) || null;
      },
    });
  }
}
