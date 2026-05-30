'use strict';

{
  const KEY = '__waProPortalCommon';
  if (!window[KEY]) {
    const api = {
      handlers: {},
      register(label, handler) {
        api.handlers[String(label || '').toUpperCase()] = handler || {};
      },
      visible(element) {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      },
      findFirst(selectors) {
        for (const selector of selectors || []) {
          try {
            const match = Array.from(document.querySelectorAll(selector)).find(api.visible);
            if (match) return match;
          } catch (_) {
            // Keep trying; some selectors are intentionally broad across portals.
          }
        }
        return null;
      },
      dispatchInput(element, value) {
        element.focus();
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor?.set) descriptor.set.call(element, value);
        else element.value = value;
        try {
          element.setAttribute('value', value);
        } catch (_) {
          // Some inputs reject setAttribute; the property setter above is enough.
        }
        try {
          element.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            composed: true,
            data: String(value || ''),
            inputType: 'insertText',
          }));
        } catch (_) {
          element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
        }
        element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true, cancelable: false, composed: true }));
      },
      textOf(element) {
        return String(`${element?.innerText || ''} ${element?.textContent || ''} ${element?.value || ''} ${element?.getAttribute?.('aria-label') || ''}`)
          .replace(/\s+/g, ' ')
          .trim();
      },
      findClickableByText(labels) {
        const normalized = labels.map((label) => String(label || '').toLowerCase());
        return Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a, [role="button"], div, span'))
          .find((element) => api.visible(element) && normalized.some((label) => api.textOf(element).toLowerCase().includes(label))) || null;
      },
      clickElement(element) {
        if (!element) return false;
        try {
          element.scrollIntoView({ block: 'center', inline: 'center' });
        } catch (_) {
          // Keep going.
        }
        const rect = element.getBoundingClientRect();
        const clientX = Math.round(rect.left + rect.width / 2);
        const clientY = Math.round(rect.top + rect.height / 2);
        try {
          if (typeof PointerEvent === 'function') {
            element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, view: window, clientX, clientY, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
            element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window, clientX, clientY, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
            element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window, clientX, clientY, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          }
          element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window, clientX, clientY }));
          element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX, clientY }));
          element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX, clientY }));
        } catch (_) {
          // Native click below is the important fallback.
        }
        if (typeof element.click === 'function') element.click();
        return true;
      },
      findSubmit(selectors) {
        const direct = api.findFirst(selectors);
        if (direct) return direct;
        return api.findClickableByText(['entrar', 'iniciar sessão', 'iniciar sessao', 'autenticar', 'continuar']);
      },
      wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
      sendDone(message = {}) {
        chrome.runtime.sendMessage({ type: 'WA_PRO_AUTLOGIN_DONE', ...message });
      },
      async requestPendingPayload() {
        const deadline = Date.now() + 4_000;
        while (Date.now() < deadline) {
          const response = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'WA_PRO_PORTAL_READY' }, (reply) => resolve(reply || {}));
          });
          if (response?.payload) return response.payload;
          await api.wait(350);
        }
        return null;
      },
      async run(payload) {
        const requested = String(payload?.credentialLabel || '').toUpperCase();
        const handler = api.handlers[requested] || api.handlers.AT;
        if (!handler) throw new Error('Portal sem handler de autologin.');

        if (await handler.before?.(payload, api)) return;

        const selectors = handler.selectors || {};
        const deadline = Date.now() + Number(handler.timeoutMs || 10_000);
        while (Date.now() < deadline) {
          if (await handler.beforeEach?.(payload, api)) return;
          await handler.extraFill?.(payload, api);

          const usernameInput = api.findFirst(payload?.usernameSelectors?.length ? payload.usernameSelectors : selectors.username);
          const passwordInput = api.findFirst(payload?.passwordSelectors?.length ? payload.passwordSelectors : selectors.password);

          if (usernameInput && passwordInput) {
            api.dispatchInput(usernameInput, String(payload.username || ''));
            await api.wait(100);
            api.dispatchInput(passwordInput, String(payload.password || ''));
            await handler.afterFill?.(payload, api, usernameInput, passwordInput);
            await api.wait(250);

            if (payload.clickSubmit !== false) {
              const submit = await handler.findSubmit?.(payload, api, passwordInput) ||
                api.findSubmit(payload?.submitSelectors?.length ? payload.submitSelectors : selectors.submit);
              if (submit) {
                api.clickElement(submit);
                await handler.afterSubmitClick?.(payload, api, passwordInput, submit);
              }
              else if (passwordInput.form?.requestSubmit) passwordInput.form.requestSubmit();
              else {
                passwordInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                passwordInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
              }
            }

            const submittedAt = Date.now();
            payload.createdAt = submittedAt;
            api.sendDone({
              credentialLabel: requested,
              keepPending: payload.keepPendingAfterSubmit === true,
              submitted: true,
              submittedAt,
            });
            await handler.afterSubmit?.(payload, api);
            return;
          }
          await api.wait(400);
        }

        throw new Error(`Não encontrei os campos de login visíveis para ${requested || 'este portal'}.`);
      },
    };

    window[KEY] = api;
  }
}
