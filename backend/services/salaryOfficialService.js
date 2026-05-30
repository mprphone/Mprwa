'use strict';

const DF_SALARY_URL = 'https://doutorfinancas.pt/ferramentas/simulador-salario-liquido-2026/';

function compactSpaces(v) {
  return String(v || '').replace(/ /g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
}

function parseEuroValue(text) {
  const raw = compactSpaces(text);
  const match = raw.match(/(-?\d{1,3}(?:[.\s]\d{3})*,\d{2})\s*€?/);
  if (!match) {
    // tentar formato simples ex: "1031,12" ou "1.031,12"
    const simple = raw.match(/(-?\d[\d.,]*\d),(\d{2})(?:\s*€)?/);
    if (!simple) return null;
    const n = Number(simple[0].replace(/[^\d,]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null;
  }
  const normalized = match[1].replace(/[\s.]/g, '').replace(',', '.');
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null;
}

function mapMaritalStatus(status) {
  if (status === 'married_one_holder' || status === 'married_two_holders') return 'married';
  return 'single'; // 'single' → Não casado
}

function mapRegion(region) {
  if (region === 'azores') return 'azores';
  if (region === 'madeira') return 'madeira';
  return 'continent';
}

async function validateSalaryWithDoutorFinancas(input) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (_) {
    throw new Error('Playwright não instalado.');
  }

  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'pt-PT',
      timezoneId: 'Europe/Lisbon',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });

    const page = await context.newPage();
    await page.goto(DF_SALARY_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // aceitar cookies se aparecer
    await page.locator('button').filter({ hasText: /aceitar|accept|concordo/i }).first().click({ timeout: 3000 }).catch(() => null);
    await page.waitForTimeout(500);

    // helper: preencher input pelo label
    async function fillByLabel(labelPattern, value) {
      const label = page.locator('label, span, div').filter({ hasText: labelPattern }).filter({ visible: true }).first();
      const input = label.locator('xpath=following::input[not(@type="hidden")][1]');
      await input.waitFor({ state: 'visible', timeout: 6000 }).catch(() => null);
      await input.evaluate((el, val) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (setter?.set) setter.set.call(el, val);
        else el.value = val;
        ['input', 'change', 'blur'].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
        if (typeof window.$ !== 'undefined') try { window.$(el).trigger('change'); } catch (_) {}
      }, String(value));
      await page.waitForTimeout(300);
    }

    // helper: seleccionar opção pelo label
    async function selectByLabel(labelPattern, optionPattern) {
      const candidates = page.locator('select:visible, [role="combobox"]:visible, [role="listbox"]:visible').filter({ visible: true });
      const count = await candidates.count();
      for (let i = 0; i < count; i++) {
        const el = candidates.nth(i);
        const parent = el.locator('xpath=ancestor::*[5]');
        const parentText = await parent.innerText({ timeout: 2000 }).catch(() => '');
        if (!labelPattern.test(parentText)) continue;
        const tagName = await el.evaluate((n) => n.tagName.toLowerCase());
        if (tagName === 'select') {
          const options = await el.locator('option').evaluateAll((opts) =>
            opts.map((o) => ({ v: o.value, t: o.textContent || '' }))
          );
          const found = options.find((o) => optionPattern.test(o.t));
          if (found) { await el.selectOption(found.v); await page.waitForTimeout(400); }
          return;
        }
        // custom select: clicar e escolher opção
        await el.click({ timeout: 3000 });
        await page.waitForTimeout(300);
        await page.locator('[role="option"], li').filter({ hasText: optionPattern }).first().click({ timeout: 3000 }).catch(() => null);
        await page.waitForTimeout(400);
        return;
      }
    }

    // preencher localização
    const regionLabel = mapRegion(input.region) === 'azores' ? /Açores/i
      : mapRegion(input.region) === 'madeira' ? /Madeira/i : /Continente/i;
    await selectByLabel(/localiza[cç][aã]o/i, regionLabel);

    // situação matrimonial
    const maritalLabel = mapMaritalStatus(input.maritalStatus) === 'married' ? /[Cc]asado/i : /[Nn][aã]o casado/i;
    await selectByLabel(/situa[cç][aã]o/i, maritalLabel);

    // dependentes
    await fillByLabel(/[Nn][uú]mero.*dependentes|dependentes/i, input.dependents || 0);

    // rendimento base
    await fillByLabel(/[Rr]endimento base|[Vv]encimento/i, input.grossSalary || 0);

    // taxa SS trabalhador
    await fillByLabel(/[Ss]egurança [Ss]ocial.*%|[Tt]axa SS/i, input.socialSecurityRate ?? 11);

    // duodécimos
    if (input.duodecimos) {
      const duoSelect = page.locator('select:visible').filter({ visible: true });
      const count = await duoSelect.count();
      for (let i = 0; i < count; i++) {
        const el = duoSelect.nth(i);
        const parent = await el.locator('xpath=ancestor::*[4]').innerText({ timeout: 1000 }).catch(() => '');
        if (/duod[eé]cimos/i.test(parent)) {
          await el.selectOption({ index: 1 }).catch(() => null);
          await page.waitForTimeout(300);
          break;
        }
      }
    }

    // subsídio alimentação
    if ((input.mealAllowanceDaily || 0) > 0) {
      await fillByLabel(/valor.*dia|alimenta[cç][aã]o.*valor/i, input.mealAllowanceDaily);
      await fillByLabel(/[Dd]ias/i, input.mealDays || 22);
    }

    await page.waitForTimeout(1500);

    // ler resultados
    const bodyText = compactSpaces(await page.locator('body').innerText({ timeout: 8000 }));

    // tentar extrair valores principais
    function extractAfter(pattern) {
      const m = bodyText.match(pattern);
      if (!m || typeof m.index !== 'number') return null;
      const slice = bodyText.slice(m.index, m.index + 300);
      return parseEuroValue(slice);
    }

    const netSalary = extractAfter(/[Ss]al[aá]rio l[ií]quido\b/);
    // IRS: a página mostra "Retenção IRS (Rendimentos + Duodécimos) 0,00 €"
    const irsRetention = extractAfter(/[Rr]eten[cç][aã]o IRS\b/);
    // SS trabalhador: "Contribuição segurança social XX,XX €" (não confundir com "Tipo de Segurança Social" no form)
    const socialSecurity = extractAfter(/Contribui[cç][aã]o segurança social\b/);
    const grossAnnual = extractAfter(/sal[aá]rio bruto anual\b/i);
    const employerCost = extractAfter(/custo anual.*empregador|empregador.*custo anual/i);

    if (!netSalary) {
      throw new Error('Não consegui ler o salário líquido do Doutor Finanças. A página pode ter mudado de estrutura.');
    }

    return {
      success: true,
      source: 'Doutor Finanças',
      sourceUrl: DF_SALARY_URL,
      computedAt: new Date().toISOString(),
      results: {
        netSalary,
        irsRetention,
        socialSecurity,
        grossAnnual,
        employerCost,
      },
    };
  } finally {
    await browser.close().catch(() => null);
  }
}

module.exports = { validateSalaryWithDoutorFinancas, DF_SALARY_URL };
