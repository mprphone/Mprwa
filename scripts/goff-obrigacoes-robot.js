#!/usr/bin/env node

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function getArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return String(process.argv[index + 1] || fallback).trim();
}

function normalizeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

async function firstSelector(page, selectors) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0) return selector;
    } catch (error) {
      // continue
    }
  }
  return '';
}

function normalizeRow(row) {
  return {
    id: row?.id ?? null,
    idCliente: row?.idCliente ?? null,
    idFirma: row?.idFirma ?? null,
    nif: String(row?.cliente_NIF || '').trim(),
    nome: String(row?.cliente_Nome || '').trim(),
    referenciaExterna: String(row?.cliente_ReferenciaExterna || '').trim(),
    ano: Number(row?.ano || 0) || null,
    mes: Number(row?.mes || 0) || null,
    anoMes: String(row?.anoMes || '').trim(),
    tipo: String(row?.tipo || '').trim(),
    dataEntrega: String(row?.dataEntrega || '').trim(),
    situacao: String(row?.situacao || '').trim(),
    numeroDocumentos: row?.numeroDocumentos ?? null,
    totalCreditos: row?.totalCreditos ?? null,
    totalDebitos: row?.totalDebitos ?? null,
    idFicheiro: row?.idFicheiro ?? null,
    nomeFicheiro: String(row?.nomeFicheiro || '').trim(),
    gestoresCliente: row?.gestoresCliente ?? null,
    raw: row,
  };
}

async function fillIfExists(page, selectors, value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim();
  const selector = await firstSelector(page, selectors);
  if (!selector) return false;
  await page.fill(selector, text);
  return true;
}

async function setSelectOrInput(page, selectors, value) {
  if (value === undefined || value === null || value === '') return false;
  const selector = await firstSelector(page, selectors);
  if (!selector) return false;
  const locator = page.locator(selector).first();
  const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  if (tag === 'select') {
    const target = String(value).trim();
    try {
      await locator.selectOption({ value: target });
      return true;
    } catch (error) {
      try {
        await locator.selectOption({ label: target });
        return true;
      } catch (error2) {
        return false;
      }
    }
  }
  await locator.fill(String(value).trim());
  return true;
}

async function main() {
  const mode = getArg('--mode', 'saft').toLowerCase();
  if (!['saft', 'iva', 'dmrat', 'dmrss', 'm22', 'm10', 'ies', 'ru', 'inventario'].includes(mode)) {
    throw new Error(`Modo GOFF não suportado: ${mode}. (suportado: saft, iva, dmrat, dmrss, m22, m10, ies, ru, inventario)`);
  }

  const loginUrl =
    process.env.GOFF_LOGIN_URL ||
    process.env.GOFF_URL_LOGIN ||
    'https://goff.sendys.pt/Identity/Account/Login?ReturnUrl=%2F';
  const saftUrl =
    process.env.GOFF_SAFT_URL ||
    process.env.GOFF_URL_SAFT ||
    'https://goff.sendys.pt/Obrigacoes/SAFT';
  const ivaUrl =
    process.env.GOFF_IVA_URL ||
    process.env.GOFF_URL_IVA ||
    'https://goff.sendys.pt/Obrigacoes/IVA';
  const dmratUrl =
    process.env.GOFF_DMRAT_URL ||
    process.env.GOFF_URL_DMRAT ||
    'https://goff.sendys.pt/Obrigacoes/DMRAT';
  const dmrssUrl =
    process.env.GOFF_DMRSS_URL ||
    process.env.GOFF_URL_DMRSS ||
    'https://goff.sendys.pt/Obrigacoes/DMRSS';
  const m22Url =
    process.env.GOFF_M22_URL ||
    process.env.GOFF_URL_M22 ||
    'https://goff.sendys.pt/Obrigacoes/M22';
  const m10Url =
    process.env.GOFF_M10_URL ||
    process.env.GOFF_URL_M10 ||
    'https://goff.sendys.pt/Obrigacoes/M10';
  const iesUrl =
    process.env.GOFF_IES_URL ||
    process.env.GOFF_URL_IES ||
    'https://goff.sendys.pt/Obrigacoes/IES';
  const ruUrl =
    process.env.GOFF_RU_URL ||
    process.env.GOFF_URL_RU ||
    'https://goff.sendys.pt/Obrigacoes/RU';
  const inventarioUrl =
    process.env.GOFF_INVENTARIO_URL ||
    process.env.GOFF_URL_INVENTARIO ||
    'https://goff.sendys.pt/Obrigacoes/INV';
  const urlByMode = {
    saft: saftUrl,
    iva: ivaUrl,
    dmrat: dmratUrl,
    dmrss: dmrssUrl,
    m22: m22Url,
    m10: m10Url,
    ies: iesUrl,
    ru: ruUrl,
    inventario: inventarioUrl,
  };
  const targetUrl = urlByMode[mode];
  const email = getArg('--email') || process.env.Email_goff || process.env.EMAIL_GOFF || '';
  const password = getArg('--password') || process.env.Senha_goff || process.env.SENHA_GOFF || '';
  const headless = String(getArg('--headless', process.env.GOFF_HEADLESS || 'true')).toLowerCase() !== 'false';
  const timeoutMs = Math.max(30000, normalizeInt(process.env.GOFF_TIMEOUT_MS || '90000', 90000));
  const yearRaw = getArg('--year', process.env.GOFF_YEAR || '');
  const monthRaw = getArg('--month', process.env.GOFF_MONTH || '');
  const year = yearRaw ? normalizeInt(yearRaw, 0) : null;
  const month = monthRaw ? normalizeInt(monthRaw, 0) : null;
  const nif = getArg('--nif', process.env.GOFF_FILTER_NIF || '');
  const nome = getArg('--nome', process.env.GOFF_FILTER_NOME || '');
  const maxPages = Math.max(1, normalizeInt(getArg('--max-pages', process.env.GOFF_MAX_PAGES || '80'), 80));
  const pageLength = Math.max(10, normalizeInt(getArg('--page-length', process.env.GOFF_PAGE_LENGTH || '100'), 100));
  const outFile = getArg('--out', '');

  if (!email || !password) {
    throw new Error('Credenciais GOFF não configuradas (Email_goff/Senha_goff).');
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  const dataBatches = [];
  const drawSeen = new Set();
  page.on('response', async (response) => {
    try {
      if (response.request().method() !== 'POST') return;
      if (!response.url().startsWith(targetUrl)) return;
      const json = await response.json();
      if (!json || !Array.isArray(json.data)) return;
      const draw = Number(json.draw || 0);
      if (drawSeen.has(draw) && draw > 0) return;
      if (draw > 0) drawSeen.add(draw);
      dataBatches.push({
        draw,
        recordsTotal: Number(json.recordsTotal || 0),
        recordsFiltered: Number(json.recordsFiltered || 0),
        data: json.data.map(normalizeRow),
      });
    } catch (error) {
      // ignore non-json/other responses
    }
  });

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    const emailSelector = await firstSelector(page, ['#Email', 'input[name=\"Email\"]', 'input[type=\"email\"]']);
    const passSelector = await firstSelector(page, ['#Password', 'input[name=\"Password\"]', 'input[type=\"password\"]']);
    const submitSelector = await firstSelector(page, ['button:has-text(\"Entrar\")', 'button[type=\"submit\"]', 'input[type=\"submit\"]']);
    if (!emailSelector || !passSelector || !submitSelector) {
      throw new Error('Seletores de login GOFF não encontrados.');
    }

    await page.fill(emailSelector, email);
    await page.fill(passSelector, password);
    await Promise.allSettled([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.locator(submitSelector).first().click(),
    ]);
    await page.waitForTimeout(1200);

    if (page.url().includes('/Identity/Account/Login')) {
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      if (/invalid login attempt|tentativa de login invalida/i.test(bodyText)) {
        throw new Error('GOFF login inválido.');
      }
    }

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);

    // optional filters
    await fillIfExists(page, ['#NIF', 'input[name=\"NIF\"]'], nif);
    await fillIfExists(page, ['#Nome', 'input[name=\"Nome\"]'], nome);
    if (year !== null && year > 0) {
      await setSelectOrInput(page, ['#Ano', 'select[name=\"Ano\"]', 'input[name=\"Ano\"]'], String(year));
    }
    if (month !== null && month >= 0) {
      await setSelectOrInput(page, ['#Mes', 'select[name=\"Mes\"]', 'input[name=\"Mes\"]'], String(month));
    }
    await setSelectOrInput(page, ['select[name$=\"_length\"]'], String(pageLength));

    // trigger reload with page action button
    dataBatches.length = 0;
    drawSeen.clear();
    const applySelector = await firstSelector(page, ['#btnApplyFilters', 'button:has-text(\"Aplicar\")']);
    if (applySelector) {
      await page.locator(applySelector).first().click();
    } else {
      const inputForEnter = await firstSelector(page, ['#NIF', 'input[name=\"NIF\"]', '#Nome', 'input[name=\"Nome\"]']);
      if (inputForEnter) {
        await page.focus(inputForEnter);
      }
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(1800);

    // paginate through datatable
    for (let i = 0; i < maxPages; i += 1) {
      const nextSelector = await firstSelector(page, [
        '.dataTables_paginate .next:not(.disabled) a',
        '.dataTables_paginate li.next:not(.disabled) a',
        'a.paginate_button.next:not(.disabled)',
      ]);
      if (!nextSelector) break;
      const beforeCount = dataBatches.length;
      await Promise.allSettled([
        page.waitForTimeout(200),
        page.locator(nextSelector).first().click(),
      ]);
      await page.waitForTimeout(1500);
      if (dataBatches.length === beforeCount) break;
    }

    const dedup = new Map();
    dataBatches.forEach((batch) => {
      batch.data.forEach((row) => {
        const key = row.id || `${row.nif}|${row.anoMes}|${row.tipo}|${row.dataEntrega}|${row.situacao}`;
        if (!dedup.has(key)) dedup.set(key, row);
      });
    });

    const rows = Array.from(dedup.values());
    const recordsFiltered = dataBatches.length > 0 ? dataBatches[dataBatches.length - 1].recordsFiltered : rows.length;
    const recordsTotal = dataBatches.length > 0 ? dataBatches[dataBatches.length - 1].recordsTotal : rows.length;

    const result = {
      success: true,
      source: 'goff',
      mode,
      filters: { year, month, nif, nome },
      rows,
      stats: {
        rows: rows.length,
        recordsFiltered,
        recordsTotal,
        batches: dataBatches.length,
      },
    };

    if (outFile) {
      const resolvedOut = path.isAbsolute(outFile) ? outFile : path.resolve(process.cwd(), outFile);
      fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
      fs.writeFileSync(resolvedOut, JSON.stringify(result, null, 2), 'utf8');
      process.stdout.write(
        JSON.stringify(
          {
            success: true,
            out: resolvedOut,
            stats: result.stats,
            filters: result.filters,
          },
          null,
          2
        )
      );
    } else {
      process.stdout.write(JSON.stringify(result, null, 2));
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exit(1);
});
