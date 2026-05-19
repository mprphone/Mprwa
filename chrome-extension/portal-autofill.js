'use strict';

const DEFAULTS = {
  AT: {
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
  SS: {
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
      'button[type="submit"]',
      'input[type="submit"]',
      'button',
      '[role="button"]',
    ],
  },
};

function visible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function findFirst(selectors) {
  for (const selector of selectors || []) {
    try {
      const candidates = Array.from(document.querySelectorAll(selector));
      const match = candidates.find(visible);
      if (match) return match;
    } catch (_) {
      // selector can be Playwright-only, keep trying native CSS selectors
    }
  }
  return null;
}

function dispatchInput(element, value) {
  element.focus();
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function findSubmit(selectors) {
  const direct = findFirst(selectors);
  if (direct) return direct;

  const labels = ['entrar', 'iniciar sessão', 'iniciar sessao', 'autenticar', 'continuar'];
  return Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a'))
    .find((element) => {
      if (!visible(element)) return false;
      const text = `${element.innerText || ''} ${element.value || ''} ${element.getAttribute('aria-label') || ''}`.toLowerCase();
      return labels.some((label) => text.includes(label));
    }) || null;
}

function textOf(element) {
  return String(`${element?.innerText || ''} ${element?.textContent || ''} ${element?.value || ''} ${element?.getAttribute?.('aria-label') || ''}`)
    .replace(/\s+/g, ' ')
    .trim();
}

async function activateAtNifTabIfPresent() {
  if (!/acesso\.gov\.pt|portaldasfinancas\.gov\.pt/i.test(window.location.hostname)) return false;

  const candidates = Array.from(document.querySelectorAll(
    'button, a, [role="tab"], [role="button"], li, div, span'
  )).filter((element) => {
    if (!visible(element)) return false;
    const text = textOf(element).toLowerCase();
    return text === 'nif' || /^nif\b/.test(text);
  });

  const target = candidates.find((element) => {
    const selected = String(element.getAttribute('aria-selected') || '').toLowerCase();
    const classes = String(element.className || '').toLowerCase();
    if (selected === 'true' || classes.includes('active') || classes.includes('selected')) return false;
    return true;
  }) || candidates[0] || null;

  if (!target) return false;
  target.click();
  await wait(500);
  return true;
}

async function openSegSocialUserLoginIfPresent() {
  if (!/seg-social\.pt/i.test(window.location.hostname)) return false;

  const hasPassword = Boolean(findFirst(DEFAULTS.SS.password));
  if (hasPassword) return false;

  const candidates = Array.from(document.querySelectorAll(
    'button, a, [role="button"], div, span, p, h1, h2, h3'
  )).filter((element) => {
    if (!visible(element)) return false;
    const text = textOf(element).toLowerCase();
    return (
      text.includes('autenticar com utilizador') ||
      text.includes('utilizador da seguranca social') ||
      text.includes('utilizador da segurança social')
    );
  });

  let target = candidates.find((element) => /button|a/i.test(element.tagName) || element.getAttribute('role') === 'button') || null;
  if (!target && candidates[0]) {
    target = candidates[0].closest('button, a, [role="button"]') || candidates[0];
  }

  if (!target) return false;
  target.click();
  await wait(800);
  return true;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAutofill(payload) {
  const label = String(payload?.credentialLabel || '').toUpperCase() === 'SS' ? 'SS' : 'AT';
  const defaults = DEFAULTS[label];
  const usernameSelectors = payload?.usernameSelectors?.length ? payload.usernameSelectors : defaults.username;
  const passwordSelectors = payload?.passwordSelectors?.length ? payload.passwordSelectors : defaults.password;
  const submitSelectors = payload?.submitSelectors?.length ? payload.submitSelectors : defaults.submit;

  if (label === 'AT') {
    await activateAtNifTabIfPresent();
  }
  if (label === 'SS') {
    await openSegSocialUserLoginIfPresent();
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const usernameInput = findFirst(usernameSelectors);
    const passwordInput = findFirst(passwordSelectors);
    if (label === 'AT' && (!usernameInput || !passwordInput)) {
      await activateAtNifTabIfPresent();
    }
    if (label === 'SS' && (!usernameInput || !passwordInput)) {
      await openSegSocialUserLoginIfPresent();
    }
    if (usernameInput && passwordInput) {
      dispatchInput(usernameInput, String(payload.username || ''));
      await wait(100);
      dispatchInput(passwordInput, String(payload.password || ''));
      await wait(150);

      if (payload.clickSubmit !== false) {
        const submit = findSubmit(submitSelectors);
        if (submit) {
          submit.click();
        } else if (passwordInput.form?.requestSubmit) {
          passwordInput.form.requestSubmit();
        } else {
          passwordInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          passwordInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        }
      }

      chrome.runtime.sendMessage({ type: 'WA_PRO_AUTLOGIN_DONE', credentialLabel: label });
      return;
    }
    await wait(400);
  }

  throw new Error('Não encontrei os campos de login visíveis neste portal.');
}

const shouldRunWaProAutofill = !window.__WA_PRO_AUTOFILL_RUNNING__;
if (shouldRunWaProAutofill) {
  window.__WA_PRO_AUTOFILL_RUNNING__ = true;
}

async function requestPendingPayloadWithRetry() {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'WA_PRO_PORTAL_READY' }, (reply) => resolve(reply || {}));
    });
    if (response?.payload) return response.payload;
    await wait(350);
  }
  return null;
}

if (shouldRunWaProAutofill) requestPendingPayloadWithRetry().then((payload) => {
  if (!payload) return;
  runAutofill(payload).catch((error) => {
    chrome.runtime.sendMessage({
      type: 'WA_PRO_AUTLOGIN_ERROR',
      error: String(error?.message || error),
    });
  });
});
