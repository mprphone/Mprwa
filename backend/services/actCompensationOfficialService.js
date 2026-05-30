'use strict';

const ACT_COMPENSATION_URL =
  'https://portal.act.gov.pt/Pages/SimuladorCompensacaoCessacaoContratoTrabalho.aspx';

function compactSpaces(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

function formatDatePt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value || '').trim();
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

function parseEuroValue(value) {
  const raw = compactSpaces(value);
  // formato português: 1-3 dígitos iniciais + grupos de exatamente 3 (separados por . ou espaço) + ,XX
  // evita apanhar anos (ex: "2026") concatenados com o valor seguinte
  const match = raw.match(/(-?\d{1,3}(?:[.\s]\d{3})*,\d{2})\s*€/);
  if (!match) return null;
  const normalized = match[1].replace(/[\s.]/g, '').replace(',', '.');
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? Math.round((numeric + Number.EPSILON) * 100) / 100 : null;
}

function firstEuroAfter(text, labelPattern) {
  const source = compactSpaces(text);
  const match = source.match(labelPattern);
  if (!match || typeof match.index !== 'number') return null;
  return parseEuroValue(source.slice(match.index, match.index + 500));
}

function parseOfficialResults(bodyText) {
  const text = compactSpaces(bodyText);
  const compensation = firstEuroAfter(text, /Compensa[cç][aã]o\b/i);

  const vacationBlockMatch = text.match(/F[eé]rias\s+J[aá] gozadas[\s\S]{0,250}?Proporcionais no ano de cessa[cç][aã]o/i);
  const vacationBlock = vacationBlockMatch ? vacationBlockMatch[0] : text;
  const vacationValues = Array.from(vacationBlock.matchAll(/(-?\d[\d\s.]*,\d{2})\s*€/g))
    .map((match) => parseEuroValue(match[0]))
    .filter((value) => typeof value === 'number');

  const proportionalBlockMatch = text.match(/Proporcionais no ano de cessa[cç][aã]o[\s\S]{0,350}?Montante global/i);
  const proportionalBlock = proportionalBlockMatch ? proportionalBlockMatch[0] : text;
  const proportionalValues = Array.from(proportionalBlock.matchAll(/(-?\d[\d\s.]*,\d{2})\s*€/g))
    .map((match) => parseEuroValue(match[0]))
    .filter((value) => typeof value === 'number');

  const vacation = vacationValues[0] ?? null;
  const holidayAllowance = vacationValues[1] ?? null;
  const proportionalVacation = proportionalValues[0] ?? null;
  const proportionalHolidayAllowance = proportionalValues[1] ?? null;
  const proportionalChristmasAllowance = proportionalValues[2] ?? null;

  // Calcular o total como soma dos componentes — o parser de "Montante global" pode apanhar valores
  // errados quando o texto da página junta números adjacentes (ex: "26" + "951,48 €" → 26.951,48).
  const components = [compensation, vacation, holidayAllowance, proportionalVacation, proportionalHolidayAllowance, proportionalChristmasAllowance];
  const hasComponents = components.some((v) => typeof v === 'number');
  const total = hasComponents
    ? Math.round((components.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0) + Number.EPSILON) * 100) / 100
    : firstEuroAfter(text, /Montante global\b/i);

  return { compensation, vacation, holidayAllowance, proportionalVacation, proportionalHolidayAllowance, proportionalChristmasAllowance, total };
}

// encontra o primeiro elemento VISÍVEL com o texto (SharePoint tem duplicados escondidos no HTML)
async function waitForVisible(page, textPattern, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // procurar em tipos de elemento específicos para não apanhar containers pai
    const candidates = page.locator('td, th, label, span').filter({ hasText: textPattern });
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = candidates.nth(i);
      if (await el.isVisible().catch(() => false)) return el;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`Elemento "${String(textPattern)}" não encontrado visível na página ACT.`);
}

// preenche input via JS e dispara todos os eventos relevantes (incluindo jQuery)
async function fillInputByJs(page, input, value) {
  await input.evaluate((el, val) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (setter && setter.set) setter.set.call(el, val);
    else el.value = val;
    ['input', 'change', 'keyup', 'blur'].forEach((type) => {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    });
    // disparar via jQuery se disponível (o ACT usa jQuery para calcular Duração)
    if (typeof window.$ !== 'undefined') {
      try { window.$(el).trigger('change').trigger('blur'); } catch (_) {}
    }
  }, String(value ?? ''));
  await page.keyboard.press('Escape'); // fechar calendário/picker se aberto
  await page.waitForTimeout(400);
}

// Versão tolerante a falhas: usa timeout curto e não lança erro se o campo não existir.
async function tryFillFollowingInput(page, textPattern, value, timeout = 3000) {
  try {
    const anchor = await waitForVisible(page, textPattern, timeout);
    const input = anchor.locator('xpath=following::input[not(@type="hidden")][1]');
    await input.waitFor({ state: 'visible', timeout: 3000 });
    await input.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => null);
    await fillInputByJs(page, input, value);
    await input.press('Tab');
    await page.waitForTimeout(200);
  } catch (_) {}
}

async function fillFollowingInput(page, textPattern, value) {
  const anchor = await waitForVisible(page, textPattern);
  const input = anchor.locator('xpath=following::input[not(@type="hidden")][1]');
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => null);
  await fillInputByJs(page, input, value);
  await input.press('Tab');
  await page.waitForTimeout(300);
}

async function setFollowingCheckbox(page, textPattern, checked) {
  const anchor = await waitForVisible(page, textPattern);
  const checkbox = anchor.locator('xpath=following::input[@type="checkbox"][1]');
  const current = await checkbox.isChecked({ timeout: 5000 }).catch(() => false);
  if (current !== !!checked) {
    const label = anchor.locator('xpath=following::label[1]');
    const labelVisible = await label.isVisible({ timeout: 2000 }).catch(() => false);
    if (labelVisible) {
      await label.click({ timeout: 5000 });
    } else {
      await checkbox.click({ force: true, timeout: 5000 });
    }
  }
  await page.waitForTimeout(300);
}

async function selectFollowingOption(page, textPattern, optionPatterns) {
  const anchor = await waitForVisible(page, textPattern);
  const select = anchor.locator('xpath=following::select[1]');
  await select.waitFor({ state: 'visible', timeout: 10000 });
  const options = await select.locator('option').evaluateAll((items) =>
    items.map((option) => ({
      label: String(option.textContent || '').trim(),
      value: String(option.getAttribute('value') || ''),
    }))
  );
  const patterns = Array.isArray(optionPatterns) ? optionPatterns : [optionPatterns];
  const found = options.find((option) =>
    patterns.some((pattern) => pattern.test(`${option.label} ${option.value}`))
  );
  if (!found) {
    throw new Error(`Opção ACT não encontrada para ${String(textPattern)}.`);
  }
  await select.selectOption(found.value || { label: found.label });
  await select.press('Tab');
  await page.waitForTimeout(500);
}

async function clickSimulate(page) {
  const candidates = [
    page.getByRole('button', { name: /simular/i }).first(),
    page.locator('input[type="button"], input[type="submit"]').filter({ hasText: /simular/i }).first(),
    page.locator('input[value*="Simular"], button:has-text("Simular")').first(),
  ];

  for (const candidate of candidates) {
    if ((await candidate.count().catch(() => 0)) <= 0) continue;
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    await candidate.click({ timeout: 5000 });
    return true;
  }
  return false;
}

async function validateActCompensationWithOfficialSimulator(input, options = {}) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (_) {
    throw new Error('Playwright não instalado. Execute: npm i playwright && npx playwright install chromium');
  }

  const headless = options.headless !== false;
  const browser = await playwright.chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1440,900',
      '--start-maximized',
    ],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'pt-PT',
      timezoneId: 'Europe/Lisbon',
      extraHTTPHeaders: {
        'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-PT', 'pt', 'en'] });
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();
    await page.goto(ACT_COMPENSATION_URL, { waitUntil: 'load', timeout: 90000 });
    await page.waitForTimeout(2500 + Math.floor(Math.random() * 1000));

    const blockedText = compactSpaces(await page.locator('body').innerText({ timeout: 8000 }).catch(() => ''));
    if (/Web Page Blocked|URL you requested has been blocked|Attack ID/i.test(blockedText)) {
      throw new Error('O portal ACT bloqueou o acesso automático nesta máquina/rede.');
    }

    // preencher campos do contrato
    await selectFollowingOption(page, /Entidade que fez cessar o contrato/i, [
      input.endedBy === 'worker' ? /trabalhador/i : /empregador/i,
    ]);
    await setFollowingCheckbox(page, /Com Justa Causa/i, !!input.justCause);
    // ATENÇÃO: /term/i faz match em "inde*term*inado" — usar \btermo\b para só apanhar contratos a termo
    await selectFollowingOption(page, /Tipo de contrato/i, [
      input.contractType === 'fixed_term' ? /\btermo\b/i : /indeterminado|sem\s+termo/i,
    ]);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => null);

    await fillFollowingInput(page, /Data de in[ií]cio/i, formatDatePt(input.startDate));
    await fillFollowingInput(page, /Data de cessa[cç][aã]o/i, formatDatePt(input.endDate));
    await page.waitForTimeout(600);

    await fillFollowingInput(page, /Retribui[cç][aã]o base/i, input.monthlyBaseSalary);
    await fillFollowingInput(page, /Diuturnidades/i, input.diuturnities || 0);
    await fillFollowingInput(page, /Complementos/i, input.complements || 0);

    await fillFollowingInput(page, /J[aá] gozadas/i, input.vacationDaysTaken || 0);
    await fillFollowingInput(page, /J[aá] recebido/i, input.holidayAllowanceReceived || 0);

    // Campos proporcionais "já recebido" — opcionais (podem não existir em todas as versões do portal).
    await tryFillFollowingInput(page, /[Pp]rop[.\s]+[Ff][eé]rias[\s\S]{0,15}[Rr]ecebido/i, input.proportionalVacationReceived || 0);
    await tryFillFollowingInput(page, /[Pp]rop[.\s]+[Ss]ub[\s\S]{0,12}[Ff][eé]rias[\s\S]{0,15}[Rr]ecebido/i, input.proportionalHolidayReceived || 0);
    await tryFillFollowingInput(page, /[Pp]rop[.\s]+[Nn]atal[\s\S]{0,15}[Rr]ecebido/i, input.proportionalChristmasReceived || 0);

    const clicked = await clickSimulate(page);
    if (!clicked) throw new Error('Não encontrei o botão Simular no ACT.');

    await page.waitForTimeout(1200);
    const bodyText = await page.locator('body').innerText({ timeout: 10000 });
    const results = parseOfficialResults(bodyText);

    if (!Object.values(results).some((value) => typeof value === 'number')) {
      throw new Error('Não consegui ler resultados numéricos do simulador ACT.');
    }

    return {
      success: true,
      source: 'ACT',
      sourceUrl: ACT_COMPENSATION_URL,
      computedAt: new Date().toISOString(),
      results,
      rawTextSample: compactSpaces(bodyText).slice(0, 4000),
    };
  } finally {
    await browser.close().catch(() => null);
  }
}

module.exports = {
  ACT_COMPENSATION_URL,
  validateActCompensationWithOfficialSimulator,
  parseOfficialResults,
};
