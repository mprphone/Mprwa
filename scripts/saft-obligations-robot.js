#!/usr/bin/env node

const { chromium } = require('playwright');

function getArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return String(process.argv[index + 1] || fallback).trim();
}

function fail(message, code = 1) {
  if (message) process.stderr.write(String(message));
  process.exit(code);
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
      const count = await locator.count();
      if (count > 0) return selector;
    } catch (error) {
      // continue
    }
  }
  return '';
}

async function trySelectValue(locator, target) {
  const normalizedTarget = String(target || '').trim();
  if (!normalizedTarget) return false;
  try {
    await locator.selectOption({ value: normalizedTarget });
    return true;
  } catch (error) {
    // ignore
  }

  try {
    const options = await locator.locator('option').allTextContents();
    const matching = options.find((item) => String(item || '').trim() === normalizedTarget);
    if (matching) {
      await locator.selectOption({ label: matching });
      return true;
    }
  } catch (error) {
    // ignore
  }

  return false;
}

async function trySelectLabelContains(locator, fragments = []) {
  const normalizedFragments = fragments
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  if (normalizedFragments.length === 0) return false;

  try {
    const options = await locator.locator('option').allTextContents();
    const match = options.find((text) => {
      const value = String(text || '').trim().toLowerCase();
      return normalizedFragments.some((fragment) => value.includes(fragment));
    });
    if (!match) return false;
    await locator.selectOption({ label: match });
    return true;
  } catch (error) {
    return false;
  }
}

async function discoverSelects(page) {
  return page.evaluate(() => {
    const toText = (value) => String(value || '').trim();
    const selects = Array.from(document.querySelectorAll('select'));
    return selects.map((select, index) => {
      const options = Array.from(select.options || []).map((opt) => ({
        value: toText(opt.value),
        text: toText(opt.textContent),
      }));
      return {
        index,
        id: toText(select.id),
        name: toText(select.getAttribute('name')),
        className: toText(select.className),
        options,
      };
    });
  });
}

function detectYearSelectIndex(selects, year) {
  const target = String(year);
  const scored = selects
    .map((select) => {
      const hasYearOption = select.options.some((opt) => opt.value === target || opt.text === target);
      if (!hasYearOption) return { index: select.index, score: -1 };
      let score = 10;
      const hint = `${select.id} ${select.name} ${select.className}`.toLowerCase();
      if (hint.includes('ano') || hint.includes('year')) score += 20;
      if (hint.includes('mes') || hint.includes('month')) score -= 5;
      return { index: select.index, score };
    })
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 ? scored[0].index : -1;
}

function detectMonthSelectIndex(selects, month) {
  if (Number(month) >= 101 && Number(month) <= 104) {
    const quarter = Number(month) - 100;
    const scoredQuarter = selects
      .map((select) => {
        const hasQuarterOption = select.options.some((opt) => {
          const value = String(opt.value || '').trim().toLowerCase();
          const text = String(opt.text || '').trim().toLowerCase();
          return (
            text.includes('trimestre') &&
            (text.includes(String(quarter)) || value === String(month) || value === String(quarter))
          );
        });
        if (!hasQuarterOption) return { index: select.index, score: -1 };
        let score = 10;
        const hint = `${select.id} ${select.name} ${select.className}`.toLowerCase();
        if (hint.includes('mes') || hint.includes('month')) score += 20;
        if (hint.includes('ano') || hint.includes('year')) score -= 5;
        return { index: select.index, score };
      })
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score);

    return scoredQuarter.length > 0 ? scoredQuarter[0].index : -1;
  }

  if (Number(month) === 0) {
    const scoredAll = selects
      .map((select) => {
        const hasAllOption = select.options.some((opt) => {
          const value = String(opt.value || '').trim().toLowerCase();
          const text = String(opt.text || '').trim().toLowerCase();
          return text.includes('todos') || text.includes('all') || value === '0' || value === '';
        });
        if (!hasAllOption) return { index: select.index, score: -1 };
        let score = 10;
        const hint = `${select.id} ${select.name} ${select.className}`.toLowerCase();
        if (hint.includes('mes') || hint.includes('month')) score += 20;
        if (hint.includes('ano') || hint.includes('year')) score -= 5;
        return { index: select.index, score };
      })
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score);

    return scoredAll.length > 0 ? scoredAll[0].index : -1;
  }

  const monthValue = String(month);
  const monthTexts = [
    monthValue,
    monthValue.padStart(2, '0'),
    ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][month - 1] || '',
  ].filter(Boolean);

  const scored = selects
    .map((select) => {
      const hasMonthOption = select.options.some((opt) => {
        const value = String(opt.value || '').trim().toLowerCase();
        const text = String(opt.text || '').trim().toLowerCase();
        return monthTexts.some((token) => value === token.toLowerCase() || text === token.toLowerCase());
      });
      if (!hasMonthOption) return { index: select.index, score: -1 };
      let score = 10;
      const hint = `${select.id} ${select.name} ${select.className}`.toLowerCase();
      if (hint.includes('mes') || hint.includes('month')) score += 20;
      if (hint.includes('ano') || hint.includes('year')) score -= 5;
      const monthRange = select.options.filter((opt) => {
        const n = Number(String(opt.value || '').replace(/\D/g, ''));
        return Number.isFinite(n) && n >= 1 && n <= 12;
      }).length;
      if (monthRange >= 10) score += 8;
      return { index: select.index, score };
    })
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 ? scored[0].index : -1;
}

async function setFilters(page, year, month) {
  const selects = await discoverSelects(page);
  const yearIndex = detectYearSelectIndex(selects, year);
  const monthIndex = detectMonthSelectIndex(selects, month);

  if (yearIndex >= 0) {
    const yearLocator = page.locator('select').nth(yearIndex);
    await trySelectValue(yearLocator, String(year));
    await Promise.race([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.waitForTimeout(1200),
    ]);
  }

  if (monthIndex >= 0) {
    const monthLocator = page.locator('select').nth(monthIndex);
    let selected = false;
    if (Number(month) >= 101 && Number(month) <= 104) {
      const quarter = Number(month) - 100;
      selected =
        (await trySelectValue(monthLocator, String(month))) ||
        (await trySelectLabelContains(monthLocator, [
          `${quarter}ºtrimestre`,
          `${quarter}º trimestre`,
          `${quarter} trimestre`,
          `${quarter}. trimestre`,
        ]));
    } else if (Number(month) === 0) {
      selected =
        (await trySelectValue(monthLocator, '0')) ||
        (await trySelectValue(monthLocator, 'Todos'));
    } else {
      selected = await trySelectValue(monthLocator, String(month));
    }
    if (!selected && Number(month) === 0) {
      await trySelectValue(monthLocator, 'All');
    }
    await Promise.race([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.waitForTimeout(1200),
    ]);
  }

  await page.waitForTimeout(1000);

  return { yearIndex, monthIndex };
}

function normalizeRowKey(row) {
  const nif = String(row?.nif || '').replace(/\D/g, '');
  const empresa = String(row?.empresa || '').trim().toLowerCase();
  const periodo = String(row?.periodo || row?.mes || '').trim().toUpperCase();
  const estado = String(row?.estado || '').trim().toLowerCase();
  const data = String(row?.dataRecebido || row?.dataStatus || row?.dataComprovativo || '').trim();
  return `${nif}|${empresa}|${periodo}|${estado}|${data}`;
}

function readPageConfig(urlText) {
  try {
    const url = new URL(urlText);
    const entries = Array.from(url.searchParams.entries());
    const pageEntry = entries.find(([key, value]) => /page/i.test(key) && /^\d+$/.test(String(value || '')));
    if (!pageEntry) return null;
    const rowsEntry = entries.find(([key]) => /rows/i.test(key));
    return {
      pageKey: pageEntry[0],
      page: Number(pageEntry[1] || 1),
      rowsKey: rowsEntry ? rowsEntry[0] : null,
      rows: rowsEntry ? String(rowsEntry[1] || '') : '',
      url,
    };
  } catch (error) {
    return null;
  }
}

async function goToNextPage(page, currentConfig) {
  if (currentConfig && currentConfig.pageKey) {
    const nextPage = currentConfig.page + 1;
    const nextUrl = new URL(currentConfig.url.toString());
    nextUrl.searchParams.set(currentConfig.pageKey, String(nextPage));
    await page.goto(nextUrl.toString(), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    const afterConfig = readPageConfig(page.url());
    if (afterConfig && Number(afterConfig.page || 0) !== Number(currentConfig.page || 0)) {
      return true;
    }
  }

  const nextSelectors = [
    'a[aria-label*="next" i]:not(.disabled)',
    'button[aria-label*="next" i]:not([disabled])',
    'a[aria-label*="seguinte" i]:not(.disabled)',
    'button[aria-label*="seguinte" i]:not([disabled])',
    'a:has-text("›"):not(.disabled)',
    'button:has-text("›"):not([disabled])',
    'a:has-text(">"):not(.disabled)',
    'button:has-text(">"):not([disabled])',
    'a:has-text("»"):not(.disabled)',
    'button:has-text("»"):not([disabled])',
  ];

  const beforeUrl = page.url();
  for (const selector of nextSelectors) {
    const locator = page.locator(selector).first();
    try {
      const count = await locator.count();
      if (count === 0) continue;
      if (!(await locator.isVisible())) continue;
      await Promise.allSettled([
        page.waitForLoadState('networkidle').catch(() => {}),
        locator.click(),
      ]);
      await page.waitForTimeout(900);
      const afterUrl = page.url();
      if (afterUrl !== beforeUrl) return true;
      return true;
    } catch (error) {
      // tenta próximo seletor
    }
  }

  return false;
}

async function extractAllObrigacaoRows(page, { rowsPerPage = 100 } = {}) {
  const maxPages = Math.max(1, normalizeInt(process.env.SAFT_MAX_PAGES, 200));
  const allRows = [];
  const seenRows = new Set();
  const seenPages = new Set();

  let pageConfig = readPageConfig(page.url());
  if (pageConfig && pageConfig.rowsKey && Number(rowsPerPage) > 0) {
    const nextUrl = new URL(pageConfig.url.toString());
    nextUrl.searchParams.set(pageConfig.rowsKey, String(rowsPerPage));
    nextUrl.searchParams.set(pageConfig.pageKey, '1');
    if (nextUrl.toString() !== page.url()) {
      await page.goto(nextUrl.toString(), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      pageConfig = readPageConfig(page.url());
    }
  }

  for (let i = 0; i < maxPages; i += 1) {
    const rows = await extractObrigacaoRows(page);
    if (!Array.isArray(rows) || rows.length === 0) break;
    let addedCount = 0;
    rows.forEach((row) => {
      const key = normalizeRowKey(row);
      if (seenRows.has(key)) return;
      seenRows.add(key);
      allRows.push(row);
      addedCount += 1;
    });
    if (addedCount === 0) break;

    const currentConfig = readPageConfig(page.url());

    const pageSignature = currentConfig
      ? `${currentConfig.pageKey}:${currentConfig.page}`
      : `no-url-page:${i}`;
    if (seenPages.has(pageSignature)) break;
    seenPages.add(pageSignature);
    const moved = await goToNextPage(page, currentConfig);
    if (!moved) break;
  }

  return allRows;
}

async function extractObrigacaoRows(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const fold = (value) =>
      normalize(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

    const allTables = Array.from(document.querySelectorAll('table'));
    let targetTable = null;

    for (const table of allTables) {
      const headers = Array.from(table.querySelectorAll('thead th')).map((th) => fold(th.textContent));
      const signature = headers.join('|');
      const looksStandardObrigacao =
        signature.includes('nif') &&
        signature.includes('estado') &&
        (signature.includes('mes') || signature.includes('periodo') || signature.includes('codigo') || signature.includes('data entrega'));
      const looksRelatorioUnico =
        signature.includes('nif') &&
        signature.includes('empresa') &&
        signature.includes('data recolha') &&
        (signature.includes('anexo') || signature.includes('certificado') || signature.includes('balanco'));
      if (
        looksStandardObrigacao ||
        looksRelatorioUnico
      ) {
        targetTable = table;
        break;
      }
    }

    if (!targetTable) return [];

    const headers = Array.from(targetTable.querySelectorAll('thead th')).map((th) => normalize(th.textContent));
    const headerIndex = (candidates, options = {}) => {
      const lowerCandidates = candidates.map((item) => fold(item));
      const excludeIndexes = new Set(
        Array.isArray(options.excludeIndexes)
          ? options.excludeIndexes.filter((idx) => Number.isInteger(idx) && idx >= 0)
          : []
      );
      const rejectFragments = Array.isArray(options.rejectFragments)
        ? options.rejectFragments.map((item) => fold(item)).filter(Boolean)
        : [];
      return headers.findIndex((header, idx) => {
        if (excludeIndexes.has(idx)) return false;
        const text = fold(header);
        if (rejectFragments.some((fragment) => text.includes(fragment))) return false;
        return lowerCandidates.some((candidate) => text.includes(candidate));
      });
    };

    const idxEmpresa = headerIndex(['empresa', 'entidade', 'cliente']);
    const idxNif = headerIndex(['nif']);
    const idxAno = headerIndex(['ano']);
    const idxMes = headerIndex(['mes']);
    const idxPeriodo = headerIndex(['periodo', 'período']);
    const idxEstadoAt = headerIndex(['estado at', 'estadoat', 'estado_at']);
    const idxEstado = headerIndex(['estado'], {
      excludeIndexes: idxEstadoAt >= 0 ? [idxEstadoAt] : [],
      rejectFragments: ['estado at', 'estadoat', 'estado_at'],
    });
    const idxSituacao = headerIndex(['situacao', 'situação']);
    const idxDescricao = headerIndex(['descricao', 'descrição']);
    const idxImportancia = headerIndex(['importancia', 'importância']);
    const idxIdent = headerIndex(['identificacao', 'identificação', 'id', 'nº declaracao', 'no declaracao', 'numero declaracao']);
    const idxDataRecebido = headerIndex(['data recebido', 'data recebid', 'data recebida', 'data status', 'data']);
    const idxDataStatus = headerIndex(['data status']);
    const idxDataComp = headerIndex(['data comprovativo']);
    const idxDataRecolha = headerIndex(['data recolha']);
    const idxIdFicheiro = headerIndex(['id. ficheiro', 'id ficheiro', 'id_ficheiro']);
    const idxFicheiro = headerIndex(['ficheiro']);
    const idxDuc = headerIndex(['duc']);
    const idxComprovativo = headerIndex(['comprovativo']);

    const rows = Array.from(targetTable.querySelectorAll('tbody tr'));
    return rows.map((row) => {
      const cells = Array.from(row.querySelectorAll('td'));
      const indexOffset = headers.length === cells.length + 1 ? -1 : 0;
      const resolveIndex = (index) => (index < 0 ? -1 : index + indexOffset);
      const get = (index) => {
        const finalIndex = resolveIndex(index);
        return finalIndex >= 0 && cells[finalIndex] ? normalize(cells[finalIndex].textContent) : '';
      };
      const hasDownload = (index) => {
        const finalIndex = resolveIndex(index);
        if (finalIndex < 0 || !cells[finalIndex]) return false;
        const cell = cells[finalIndex];
        return !!cell.querySelector('a[href], input[type="image"], button, i[class*="download"], i[class*="file"]');
      };
      const downloadCount = cells.reduce((count, cell) => {
        const hasIcon = !!cell.querySelector('a[href], input[type="image"], button, i[class*="download"], i[class*="file"]');
        return count + (hasIcon ? 1 : 0);
      }, 0);

      return {
        empresa: get(idxEmpresa),
        nif: get(idxNif),
        ano: get(idxAno),
        mes: get(idxMes),
        periodo: get(idxPeriodo),
        estado: get(idxEstado),
        situacao: get(idxSituacao),
        descricao: get(idxDescricao),
        importancia: get(idxImportancia),
        estadoAt: get(idxEstadoAt),
        identificacao: get(idxIdent),
        idFicheiro: get(idxIdFicheiro),
        dataRecebido: get(idxDataRecebido),
        dataRecolha: get(idxDataRecolha) || get(idxDataRecebido),
        dataStatus: get(idxDataStatus),
        dataComprovativo: get(idxDataComp),
        temFicheiro: hasDownload(idxFicheiro),
        temDuc: hasDownload(idxDuc),
        temComprovativo: hasDownload(idxComprovativo),
        temDownloads: downloadCount > 0,
        downloadCount,
      };
    }).filter((item) => item.nif || item.empresa);
  });
}

async function main() {
  const mode = getArg('--mode', 'dri').toLowerCase();
  if (!['dri', 'dmr', 'saft', 'iva', 'm22', 'ies', 'm10', 'relatorio-unico'].includes(mode)) {
    fail(`Modo não suportado: ${mode}`, 2);
  }

  const year = normalizeInt(getArg('--year'), new Date().getUTCFullYear());
  const requestedMonth = normalizeInt(getArg('--month'), new Date().getUTCMonth() + 1);
  const month = ['m22', 'ies', 'm10', 'relatorio-unico'].includes(mode) ? 0 : requestedMonth;
  const allowsAllMonths = mode === 'iva';
  const ignoresMonth = ['m22', 'ies', 'm10', 'relatorio-unico'].includes(mode);
  const isQuarterCode = allowsAllMonths && month >= 101 && month <= 104;
  if (!ignoresMonth && (month < 0 || month > 104 || (!allowsAllMonths && month === 0) || (allowsAllMonths && month > 12 && !isQuarterCode))) {
    fail(allowsAllMonths ? 'Mês inválido. Use 0..12 ou 101..104.' : 'Mês inválido. Use 1..12.', 2);
  }

  const loginUrl = process.env.SAFT_LOGIN_URL || 'https://app.saftonline.pt/conta/inss?ReturnUrl=%2Fdossier%2Fdossier';
  const driUrl = process.env.SAFT_DRI_URL || 'https://app.saftonline.pt/dmrss';
  const dmrUrl = process.env.SAFT_DMR_URL || 'https://app.saftonline.pt/dmrat';
  const saftsUrl = process.env.SAFT_SAFTS_URL || process.env.SAFT_SAFT_URL || 'https://app.saftonline.pt/safts';
  const ivaUrl = process.env.SAFT_IVA_URL || 'https://app.saftonline.pt/iva';
  const m22Url = process.env.SAFT_M22_URL || 'https://app.saftonline.pt/m22';
  const iesUrl = process.env.SAFT_IES_URL || 'https://app.saftonline.pt/ies';
  const m10Url = process.env.SAFT_M10_URL || 'https://app.saftonline.pt/m10';
  const relatorioUnicoUrl = process.env.SAFT_RELATORIO_UNICO_URL || 'https://app.saftonline.pt/relunico';
  const targetUrl =
    mode === 'dmr'
      ? dmrUrl
      : mode === 'saft'
        ? saftsUrl
        : mode === 'iva'
          ? ivaUrl
          : mode === 'm22'
            ? m22Url
            : mode === 'ies'
            ? iesUrl
            : mode === 'm10'
              ? m10Url
              : mode === 'relatorio-unico'
                ? relatorioUnicoUrl
          : driUrl;
  const email = getArg('--email') || process.env.SAFT_EMAIL || process.env.Email_saft || '';
  const password = getArg('--password') || process.env.SAFT_PASSWORD || process.env.Senha_saft || '';
  const headless = String(process.env.SAFT_HEADLESS || 'true').trim().toLowerCase() !== 'false';
  const timeoutMs = Number(process.env.SAFT_TIMEOUT_MS || 90000);

  if (!email || !password) {
    fail('Credenciais SAFT não configuradas.', 2);
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    page.setDefaultTimeout(timeoutMs);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    const emailSelector = await firstSelector(page, ['#Email', 'input[name="Email"]', 'input[type="email"]']);
    const passwordSelector = await firstSelector(page, ['#Password', 'input[name="Password"]', 'input[type="password"]']);
    const submitSelector = await firstSelector(page, ['button[type="submit"]', 'input[type="submit"]']);

    if (!emailSelector || !passwordSelector || !submitSelector) {
      fail('Seletores de login SAFT não encontrados.', 3);
    }

    await page.fill(emailSelector, email);
    await page.fill(passwordSelector, password);
    await Promise.allSettled([
      page.waitForLoadState('networkidle'),
      page.locator(submitSelector).first().click(),
    ]);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    const filterResult = await setFilters(page, year, month);
    const rowsPerPage = Number(process.env.SAFT_ROWS_PER_PAGE || 100);
    const rows = await extractAllObrigacaoRows(page, { rowsPerPage });

    const payload = {
      mode,
      year,
      month,
      rows,
      filters: filterResult,
      capturedAt: new Date().toISOString(),
    };

    process.stdout.write(JSON.stringify(payload));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  fail(String(error?.message || error), 1);
});
