'use strict';

{
  const api = window.__waProPortalCommon;
  if (api) {
    function findSegSocialImageTarget() {
      const images = Array.from(document.querySelectorAll('img')).filter(api.visible);
      const scored = images.map((img) => {
        const rect = img.getBoundingClientRect();
        const haystack = `${img.alt || ''} ${img.title || ''} ${img.src || ''} ${img.className || ''}`.toLowerCase();
        let score = 0;
        if (haystack.includes('segurança') || haystack.includes('seguranca')) score += 40;
        if (haystack.includes('social')) score += 35;
        if (haystack.includes('autenticacao') || haystack.includes('autentica')) score += 15;
        if (haystack.includes('gov')) score += 5;
        if (rect.width >= 120 && rect.width <= 420) score += 20;
        if (rect.height >= 30 && rect.height <= 120) score += 20;
        if (rect.left > window.innerWidth * 0.35 && rect.left < window.innerWidth * 0.75) score += 10;
        if (rect.top > window.innerHeight * 0.25 && rect.top < window.innerHeight * 0.65) score += 10;
        return { img, score };
      }).sort((a, b) => b.score - a.score);
      const best = scored.find((entry) => entry.score >= 40)?.img || null;
      return best?.closest?.('button, a, [role="button"], form, div') || best || null;
    }

    async function clickSegSocialIfPresent() {
      const confirm = api.findClickableByText(['confirmar']);
      if (confirm) {
        api.clickElement(confirm);
        await api.wait(700);
        return true;
      }

      const imageTarget = findSegSocialImageTarget();
      if (imageTarget) {
        api.clickElement(imageTarget);
        await api.wait(700);
        const afterConfirm = api.findClickableByText(['confirmar']);
        if (afterConfirm) {
          api.clickElement(afterConfirm);
          await api.wait(700);
        }
        return true;
      }

      const candidate = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a, [role="button"], img, div, span'))
        .find((element) => {
          if (!api.visible(element)) return false;
          const haystack = `${api.textOf(element)} ${element.getAttribute?.('alt') || ''} ${element.getAttribute?.('title') || ''} ${element.getAttribute?.('src') || ''} ${element.className || ''}`.toLowerCase();
          return haystack.includes('segurança social') ||
            haystack.includes('seguranca social') ||
            haystack.includes('seg-social') ||
            haystack.includes('segurancasocial') ||
            haystack.includes('ssd') ||
            haystack.includes('loginseg');
        }) || null;
      if (!candidate) return false;
      api.clickElement(candidate.closest?.('button, a, [role="button"], input[type="button"], input[type="submit"]') || candidate);
      await api.wait(700);
      return true;
    }

    api.register('SS', {
      async before() {
        if (!/iefponline\.iefp\.pt/i.test(window.location.hostname)) return false;
        const deadline = Date.now() + 12_000;
        while (Date.now() < deadline) {
          if (await clickSegSocialIfPresent()) {
            api.sendDone({ credentialLabel: 'SS', keepPending: true });
            return true;
          }
          await api.wait(400);
        }
        return false;
      },
    });
  }
}
