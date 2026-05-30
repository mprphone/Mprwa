'use strict';

// Content script para clientebancario.bportugal.pt
// Depois do login via AT, na página CRC:
//   1. Marca o checkbox "Li e aceito..."
//   2. Intercepta a submissão do form via fetch
//   3. Captura o PDF como ArrayBuffer
//   4. Envia para o servidor WA PRO

{
  const api = window.__waProPortalCommon;
  if (api) {
    api.register('AT', {
      async before(payload, api) {
        if (!/clientebancario\.bportugal\.pt/i.test(window.location.hostname)) return false;
        if (!payload?.collectBpCrc) return false;

        const customerId = String(payload.customerId || '').trim();
        if (!customerId) return false;

        await api.wait(1500);

        // Verificar se estamos na página CRC (logado)
        const pageText = document.body?.innerText || '';
        if (/verificar se a liga|checking if the site/i.test(pageText)) return true; // CF - abortar silenciosamente

        // Marcar checkbox "Li e aceito..."
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        const cb = checkboxes.find((el) => {
          const label = document.querySelector(`label[for="${el.id}"]`) || el.closest('label');
          return /li e aceito|aceito|politica de dados|condicoes/i.test(
            (label?.innerText || label?.textContent || el.getAttribute('aria-label') || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
          );
        });
        if (cb && !cb.checked) {
          cb.click();
          await api.wait(400);
        }

        // Encontrar o form e o botão "Obter mapa"
        const form = document.querySelector('form');
        const obterBtn = Array.from(
          document.querySelectorAll('button, input[type="submit"], input[type="button"]')
        ).find((el) =>
          /obter\s+mapa|obter\s+relat/i.test(el.innerText || el.value || '')
        );

        if (!form || !obterBtn) {
          api.sendDone({ credentialLabel: 'BPortugal', keepPending: false });
          return true;
        }

        // Interceptar o submit do form para capturar o PDF via fetch
        let intercepted = false;
        const submitHandler = async (e) => {
          if (intercepted) return;
          intercepted = true;
          e.preventDefault();
          e.stopImmediatePropagation();

          try {
            const formData = new FormData(form);
            const resp = await fetch(form.action || window.location.href, {
              method: (form.method || 'POST').toUpperCase(),
              body: formData,
              credentials: 'include',
            });

            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

            const buffer = await resp.arrayBuffer();
            const bytes = new Uint8Array(buffer);

            // Verificar magic bytes %PDF
            if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
              // Não é PDF - deixar descarregar normalmente
              intercepted = false;
              form.removeEventListener('submit', submitHandler, true);
              obterBtn.click();
              return;
            }

            // Converter para base64
            let binary = '';
            const chunk = 8192;
            for (let i = 0; i < bytes.length; i += chunk) {
              binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            const base64 = btoa(binary);

            // Enviar para o servidor WA PRO
            const postResp = await fetch(
              `https://wa.mpr.pt/api/customers/${encodeURIComponent(customerId)}/fiscal/bportugal-pdf-callback`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ pdfBase64: base64 }),
                credentials: 'include',
              }
            );

            if (postResp.ok) {
              console.info('[WA PRO] BP CRC PDF enviado ao servidor com sucesso.');
            } else {
              console.warn('[WA PRO] Falha ao enviar PDF BP:', postResp.status);
            }
          } catch (err) {
            console.error('[WA PRO] Erro na recolha CRC BP:', err.message);
            // Fallback: clicar normalmente para o utilizador poder descarregar
            intercepted = false;
            form.removeEventListener('submit', submitHandler, true);
            obterBtn.click();
          } finally {
            api.sendDone({ credentialLabel: 'BPortugal', keepPending: false });
          }
        };

        form.addEventListener('submit', submitHandler, true);
        obterBtn.click(); // dispara o submit

        return true; // bloquear autofill normal
      },
    });
  }
}
