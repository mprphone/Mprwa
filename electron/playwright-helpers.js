'use strict';

function splitSelectorList(rawValue, fallbackValue) {
  if (Array.isArray(rawValue)) {
    return rawValue
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  const source = String(rawValue || fallbackValue || '').trim();
  return source
    .split(',')
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function resolveSelectorListFromPayload(payloadValue, envValue, fallbackValue) {
  const payloadSelectors = splitSelectorList(payloadValue, '');
  if (payloadSelectors.length > 0) return payloadSelectors;
  return splitSelectorList(envValue, fallbackValue);
}

async function findFirstVisibleLocatorTarget(page, selectors, options = {}) {
  const waitTimeout = Math.max(500, Number(options?.waitTimeoutMs || 3000) || 3000);
  const includeFrames = options?.includeFrames !== false;
  const maxMatchesPerSelector = Math.max(1, Number(options?.maxMatchesPerSelector || 8) || 8);
  const selectorList = Array.isArray(selectors) ? selectors : [];
  const candidateFrames = includeFrames
    ? [page.mainFrame(), ...page.frames().filter((frame) => frame !== page.mainFrame())]
    : [page.mainFrame()];

  for (const selector of selectorList) {
    const cleanedSelector = String(selector || '').trim();
    if (!cleanedSelector) continue;

    for (const frame of candidateFrames) {
      try {
        const candidates = frame.locator(cleanedSelector);
        const totalMatches = await candidates.count();
        if (totalMatches <= 0) continue;

        const maxCandidates = Math.min(totalMatches, maxMatchesPerSelector);
        for (let index = 0; index < maxCandidates; index += 1) {
          const locator = candidates.nth(index);
          let visible = await locator.isVisible().catch(() => false);
          if (!visible) {
            const perCandidateWait = totalMatches === 1 ? waitTimeout : Math.min(waitTimeout, 800);
            await locator.waitFor({ state: 'visible', timeout: perCandidateWait }).catch(() => null);
            visible = await locator.isVisible().catch(() => false);
          }
          if (!visible) continue;

          return {
            selector: cleanedSelector,
            locator,
            frame,
            frameUrl: String(frame.url() || '').trim(),
            inIframe: frame !== page.mainFrame(),
          };
        }
      } catch (_) {
        // ignore invalid selector/frame mismatch and keep trying
      }
    }
  }

  return null;
}

async function findLikelyUsernameNearPasswordTarget(passwordTarget) {
  if (!passwordTarget?.frame || !passwordTarget?.locator) return null;
  const frame = passwordTarget.frame;
  const passwordBox = await passwordTarget.locator.boundingBox().catch(() => null);
  const candidates = frame.locator('input:not([type="password"]):not([type="hidden"]):not([disabled])');
  const maxCandidates = Math.min(await candidates.count().catch(() => 0), 40);

  let bestLocator = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < maxCandidates; index += 1) {
    const locator = candidates.nth(index);
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await locator.boundingBox().catch(() => null);
    if (!box) continue;

    let score = index + 1;
    if (passwordBox) {
      const sameColumnPenalty = Math.abs(box.x - passwordBox.x) > 260 ? 600 : 0;
      const verticalDistance = Math.abs((passwordBox.y || 0) - (box.y || 0));
      const expectedAbovePenalty = box.y > passwordBox.y + 35 ? 420 : 0;
      const widthPenalty = Math.abs((box.width || 0) - (passwordBox.width || 0)) / 40;
      score = verticalDistance + sameColumnPenalty + expectedAbovePenalty + widthPenalty;
    }

    if (score < bestScore) {
      bestScore = score;
      bestLocator = locator;
    }
  }

  if (!bestLocator) return null;
  return {
    selector: 'heuristic:ss-username-near-password',
    locator: bestLocator,
    frame,
    frameUrl: String(frame.url() || '').trim(),
    inIframe: frame !== frame.page().mainFrame(),
  };
}

async function findLikelySubmitNearPasswordTarget(passwordTarget) {
  if (!passwordTarget?.frame || !passwordTarget?.locator) return null;
  const frame = passwordTarget.frame;
  const passwordBox = await passwordTarget.locator.boundingBox().catch(() => null);
  const candidates = frame.locator(
    'button, input[type="submit"], input[type="button"], [role="button"], a'
  );
  const maxCandidates = Math.min(await candidates.count().catch(() => 0), 60);

  let bestLocator = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < maxCandidates; index += 1) {
    const locator = candidates.nth(index);
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    const text = String((await locator.innerText().catch(() => '')) || '').trim();
    const value = String((await locator.getAttribute('value').catch(() => '')) || '').trim();
    const label = `${text} ${value}`.toLowerCase();
    if (!label.includes('entrar') && !label.includes('iniciar sess') && !label.includes('autenticar')) continue;

    const box = await locator.boundingBox().catch(() => null);
    if (!box) continue;

    let score = index + 1;
    if (passwordBox) {
      const sameColumnPenalty = Math.abs(box.x - passwordBox.x) > 320 ? 500 : 0;
      const belowPenalty = box.y < passwordBox.y - 40 ? 550 : 0;
      const verticalDistance = Math.abs((box.y || 0) - (passwordBox.y || 0));
      score = verticalDistance + sameColumnPenalty + belowPenalty;
    }

    if (score < bestScore) {
      bestScore = score;
      bestLocator = locator;
    }
  }

  if (!bestLocator) return null;
  return {
    selector: 'heuristic:ss-submit-near-password',
    locator: bestLocator,
    frame,
    frameUrl: String(frame.url() || '').trim(),
    inIframe: frame !== frame.page().mainFrame(),
  };
}

async function findFirstVisibleSelector(page, selectors, options = {}) {
  const match = await findFirstVisibleLocatorTarget(page, selectors, options);
  return match?.selector || null;
}

async function clickFirstVisibleLocator(page, builders, timeoutMs = 2500) {
  for (const build of Array.isArray(builders) ? builders : []) {
    try {
      const locator = build().first();
      if ((await locator.count()) <= 0) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      await locator.click({ timeout: timeoutMs });
      await page.waitForTimeout(350);
      return true;
    } catch (_) {
      // try next candidate
    }
  }
  return false;
}

async function fillFirstVisibleLocator(page, builders, value, timeoutMs = 2500) {
  for (const build of Array.isArray(builders) ? builders : []) {
    try {
      const locator = build().first();
      if ((await locator.count()) <= 0) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      await locator.fill(String(value || ''), { timeout: timeoutMs });
      return true;
    } catch (_) {
      // try next candidate
    }
  }
  return false;
}

async function pressFirstVisibleLocator(page, builders, key, timeoutMs = 2500) {
  for (const build of Array.isArray(builders) ? builders : []) {
    try {
      const locator = build().first();
      if ((await locator.count()) <= 0) continue;
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      await locator.press(String(key || 'Enter'), { timeout: timeoutMs });
      await page.waitForTimeout(350);
      return true;
    } catch (_) {
      // try next candidate
    }
  }
  return false;
}

async function getPageBodyText(page, timeoutMs = 1200) {
  return String(await page.locator('body').innerText({ timeout: timeoutMs }).catch(() => '') || '');
}

module.exports = {
  splitSelectorList,
  resolveSelectorListFromPayload,
  findFirstVisibleLocatorTarget,
  findLikelyUsernameNearPasswordTarget,
  findLikelySubmitNearPasswordTarget,
  findFirstVisibleSelector,
  clickFirstVisibleLocator,
  fillFirstVisibleLocator,
  pressFirstVisibleLocator,
  getPageBodyText,
};
