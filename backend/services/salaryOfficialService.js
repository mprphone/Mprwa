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

    // helper: preencher input pelo label — usa .fill() do Playwright (suporta React)
    async function fillByLabel(labelPattern, value) {
      const label = page.locator('label, span, div').filter({ hasText: labelPattern }).filter({ visible: true }).first();
      const input = label.locator('xpath=following::input[not(@type="hidden")][1]');
      const visible = await input.isVisible({ timeout: 4000 }).catch(() => false);
      if (!visible) return false;
      try {
        // Usar .fill() que dispara correctamente os eventos React/Vue/Angular
        await input.click({ timeout: 2000 });
        await input.fill(String(value), { timeout: 3000 });
        // Pressionar Tab para confirmar o valor e mover para o próximo campo
        await input.press('Tab');
        await page.waitForTimeout(200);
        return true;
      } catch (_) {
        // fallback via evaluate para casos edge
        await input.evaluate((el, val) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
          if (setter?.set) setter.set.call(el, val);
          else el.value = val;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: val }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, String(value)).catch(() => null);
        await page.waitForTimeout(300);
        return false;
      }
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

    // rendimento base — tentar múltiplos padrões e fallback por selector directo
    const salaryFilled = await fillByLabel(/[Rr]endimento base|[Vv]encimento base|[Ss]al[aá]rio bruto/i, input.grossSalary || 0);
    if (!salaryFilled) {
      // fallback: preencher todos os inputs numéricos principais pela ordem (1º campo = salário)
      const numericInputs = await page.locator('input[type="number"]:visible, input[type="text"]:visible').all();
      for (const inp of numericInputs) {
        const val = await inp.inputValue().catch(() => '');
        // campo que tem valor numérico parecido com um salário
        if (/^\d{3,5}([.,]\d{0,2})?$/.test(val.trim()) || val.trim() === '') {
          await inp.evaluate((el, v) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            if (setter?.set) setter.set.call(el, v); else el.value = v;
            ['input','change','blur'].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
          }, String(input.grossSalary || 0));
          await page.waitForTimeout(300);
          break;
        }
      }
    }
    await page.waitForTimeout(500);
    const salaryCheck = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    console.error('[DF Salary] salary field filled, page has gross:', salaryCheck.match(/Sal[aá]rio bruto[\s\S]{0,50}/)?.[0] || 'not found');

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

    await page.waitForTimeout(800);

    // Remover cookie overlay e outros overlays que bloqueiam cliques
    await page.evaluate(() => {
      // Remover classe cookie-overlay do body
      document.body.classList.remove('cookie-overlay');
      // Remover qualquer overlay/modal de cookies via CSS
      const overlays = document.querySelectorAll('[class*="cookie"], [class*="overlay"], [class*="modal"], [id*="cookie"], [id*="consent"]');
      overlays.forEach((el) => {
        const style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'absolute') {
          el.style.display = 'none';
        }
      });
    }).catch(() => null);

    // Aceitar cookies se ainda visível
    await page.locator('button').filter({ hasText: /aceitar|accept|concordo|ok/i }).first().click({ timeout: 2000, force: true }).catch(() => null);
    await page.waitForTimeout(300);

    // Clicar no botão "Simular" — obrigatório para calcular os resultados
    const simularBtn = page.locator('button').filter({ hasText: /^[Ss]imular$/ }).first();
    const btnVisible = await simularBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (btnVisible || await simularBtn.count().then((c) => c > 0).catch(() => false)) {
      console.error('[DF Salary] a clicar botão Simular (force)...');
      await simularBtn.click({ timeout: 5000, force: true });
    } else {
      // fallback: evaluate click directo por texto
      const clicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => /^simular$/i.test((b.textContent || '').trim()));
        if (btn) { btn.click(); return true; }
        return false;
      });
      console.error('[DF Salary] Simular evaluate click:', clicked);
    }
    // Aguardar que os resultados actualizem
    await page.waitForTimeout(3000);

    // ler resultados
    const bodyText = compactSpaces(await page.locator('body').innerText({ timeout: 8000 }));

    // tentar extrair valores principais
    function extractAfter(pattern) {
      const m = bodyText.match(pattern);
      if (!m || typeof m.index !== 'number') return null;
      const slice = bodyText.slice(m.index, m.index + 300);
      return parseEuroValue(slice);
    }

    // Log parcial do texto para diagnóstico
    console.error('[DF Salary] bodyText (500):', bodyText.slice(0, 500));
    // Encontrar secção de resultados
    const resultsIdx = bodyText.search(/[Ss]al[aá]rio l[ií]quido/);
    if (resultsIdx >= 0) console.error('[DF Salary] results section (800):', bodyText.slice(resultsIdx, resultsIdx + 800));

    // Ler resultados do banner principal (actualizado após Simular)
    // O banner mostra "O que irá receber mensalmente: X€" — este é o valor correcto
    const netSalaryBanner = extractAfter(/[Oo] que ir[aá] receber mensalmente[:\s]|mensalmente[:\s]/);

    // Ler da secção de simulação (donut chart) — depois do banner
    // Procurar a secção que contém "Retenção IRS (Rendimentos" para garantir resultados actualizados
    const irsIdx = bodyText.indexOf('Reten');
    const resultSlice = irsIdx >= 0 ? bodyText.slice(Math.max(0, irsIdx - 200), irsIdx + 600) : bodyText;
    function extractFromSlice(pattern) {
      const m = resultSlice.match(pattern);
      if (!m || typeof m.index !== 'number') return null;
      return parseEuroValue(resultSlice.slice(m.index, m.index + 200));
    }

    // Salário líquido — preferir o banner (mais fiável), senão secção de simulação
    const netFromSimul = extractFromSlice(/[Ss]al[aá]rio l[ií]quido/);
    const netSalary = netSalaryBanner || netFromSimul || extractAfter(/[Ss]al[aá]rio l[ií]quido\b/);

    // IRS — procurar na secção de resultados actualizados
    const irsRetention = extractFromSlice(/[Rr]eten[cç][aã]o IRS/)
                      || extractAfter(/[Rr]eten[cç][aã]o IRS.*[Rr]endimentos|[Rr]eten[cç][aã]o IRS\b/);

    // SS trabalhador — na secção de resultados
    const socialSecurity = extractFromSlice(/[Cc]ontribui[cç][aã]o segurança social|[Ss]egurança.*[Ss]ocial.*\d/)
                        || extractAfter(/Contribui[cç][aã]o segurança social\b/);

    const grossAnnual = extractAfter(/sal[aá]rio bruto anual\b/i);
    const employerCost = extractAfter(/custo anual.*empregador|empregador.*custo anual/i)
                      || (() => {
                          const m = bodyText.match(/[Cc]usto anual.*empregador[\s\S]{0,10}([\d.,]+€?)/);
                          return m ? parseEuroValue(m[1]) : null;
                        })();

    console.error('[DF Salary] netBanner:', netSalaryBanner, '| netSimul:', netFromSimul, '| irs:', irsRetention, '| ss:', socialSecurity);

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
