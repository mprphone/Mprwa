#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const XLSX = require('xlsx');
require('dotenv').config();

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

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function csvEscape(value, delimiter) {
  const text = String(value ?? '');
  if (text.includes('"') || text.includes('\n') || text.includes('\r') || text.includes(delimiter)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

const OUTPUT_COLUMNS = [
  'Nome',
  'NIF',
  'PasswordAT',
  'NISS',
  'PasswordSS',
  'UtilizadorRU',
  'PasswordRU',
  'TipoIVA',
  'Mês Inicio Exercício',
  'N. Colaboradores',
  'Equipas',
  'Utilizadores Info (emails separados por ;)',
  'Gestores Cliente (emails separados por ;)',
  'Idioma Notificações PT',
  'Mails Artificiais (separados por ;)',
  'Referência Interna',
  'NIF Contabilista Certificado',
  'NISS Responsável Seg. Social',
  'Alterar Automaticamente Password Sec. Social quando password expirar',
  'Data Inicio Atividade',
  'Código Certidão Permanente',
  'ViaCTT power2014',
  'Password ViaCTT',
  'IAPMEI',
  'Password IAPMEI',
  'Valor Avença',
  'Tempo Resposta Mensal',
  'Observações',
  'Executante',
  'Verificador',
  'Email Lista',
  'Telemóvel Lista',
  'URL Ficha',
];

function normalizeRowsForColumns(rows, columns) {
  return rows.map((row) => {
    const normalized = {};
    columns.forEach((column) => {
      normalized[column] = row && Object.prototype.hasOwnProperty.call(row, column) ? row[column] : '';
    });
    return normalized;
  });
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
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) continue;
      if (!(await locator.isVisible())) continue;
      await Promise.allSettled([
        page.waitForLoadState('networkidle').catch(() => {}),
        locator.click(),
      ]);
      await page.waitForTimeout(900);
      if (page.url() !== beforeUrl) return true;
      return true;
    } catch (error) {
      // continue
    }
  }
  return false;
}

async function loginSaft(page, { loginUrl, email, password, timeoutMs }) {
  page.setDefaultTimeout(timeoutMs);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  const emailSelector = await firstSelector(page, ['#Email', 'input[name="Email"]', 'input[type="email"]']);
  const passwordSelector = await firstSelector(page, ['#Password', 'input[name="Password"]', 'input[type="password"]']);
  const submitSelector = await firstSelector(page, ['button[type="submit"]', 'input[type="submit"]']);
  if (!emailSelector || !passwordSelector || !submitSelector) {
    throw new Error('Seletores de login SAFT não encontrados.');
  }

  await page.fill(emailSelector, email);
  await page.fill(passwordSelector, password);
  await Promise.allSettled([
    page.waitForLoadState('networkidle').catch(() => {}),
    page.locator(submitSelector).first().click(),
  ]);
  await page.waitForTimeout(1200);
}

async function extractEmpresaRows(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const fold = (value) =>
      clean(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const toAbs = (href) => {
      if (!href) return '';
      try {
        return new URL(href, window.location.href).toString();
      } catch (error) {
        return href;
      }
    };

    const tables = Array.from(document.querySelectorAll('table'));
    let target = null;
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('thead th')).map((th) => fold(th.textContent));
      const signature = headers.join('|');
      if (signature.includes('nif') && signature.includes('empresa')) {
        target = table;
        break;
      }
    }
    if (!target) return [];

    const headers = Array.from(target.querySelectorAll('thead th')).map((th) => clean(th.textContent));
    const headerIndex = (candidates) => {
      const list = candidates.map((x) => fold(x));
      return headers.findIndex((h) => {
        const key = fold(h);
        return list.some((token) => key.includes(token));
      });
    };

    const idxNif = headerIndex(['nif']);
    const idxEmpresa = headerIndex(['empresa']);
    const idxCodigo = headerIndex(['codigo', 'código']);
    const idxExecutante = headerIndex(['executante']);
    const idxVerificador = headerIndex(['verificador']);
    const idxEmail = headerIndex(['email']);
    const idxTelemovel = headerIndex(['telemovel', 'telemóvel']);

    const rows = Array.from(target.querySelectorAll('tbody tr'));
    return rows
      .map((row) => {
        const cells = Array.from(row.querySelectorAll('td'));
        const get = (idx) => (idx >= 0 && cells[idx] ? clean(cells[idx].textContent) : '');
        const detailLinkEl = row.querySelector('a[href*="/empresas/Details/"], a[href*="/empresas/details/"]');
        const anyLinkEl = row.querySelector('a[href]');
        const detailUrl = detailLinkEl ? toAbs(detailLinkEl.getAttribute('href')) : '';
        const fallbackUrl = !detailUrl && anyLinkEl ? toAbs(anyLinkEl.getAttribute('href')) : '';
        return {
          nif: get(idxNif),
          empresa: get(idxEmpresa),
          codigo: get(idxCodigo),
          executante: get(idxExecutante),
          verificador: get(idxVerificador),
          emailLista: get(idxEmail),
          telemovelLista: get(idxTelemovel),
          detailUrl: detailUrl || fallbackUrl,
        };
      })
      .filter((item) => item.nif || item.empresa);
  });
}

async function clickTabIfExists(page, tabLabel) {
  const variants = [
    `a.nav-link:has-text("${tabLabel}")`,
    `a:has-text("${tabLabel}")`,
  ];
  for (const selector of variants) {
    try {
      const tab = page.locator(selector).first();
      if ((await tab.count()) === 0) continue;
      await tab.click();
      await page.waitForTimeout(500);
      return true;
    } catch (error) {
      // continue
    }
  }
  return false;
}

async function extractActiveTabFields(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const fold = (value) =>
      clean(value)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

    const activePane =
      document.querySelector('.tab-pane.active') ||
      document.querySelector('.tab-content .tab-pane') ||
      document.body;

    const controls = Array.from(activePane.querySelectorAll('input, select, textarea')).filter((el) => {
      const type = clean(el.getAttribute('type')).toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button') return false;
      return true;
    });

    const fields = {};
    for (const control of controls) {
      const id = clean(control.id);
      let label = '';
      if (id) {
        const byFor = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (byFor) label = clean(byFor.textContent);
      }
      if (!label) {
        const parent = control.closest('.form-group, .col-md-2, .col-md-3, .col-md-4, .col-md-6, .col-md-8, .col-md-12, .row, td');
        if (parent) {
          const localLabel = parent.querySelector('label');
          if (localLabel) label = clean(localLabel.textContent);
        }
      }
      if (!label) {
        label = clean(control.getAttribute('name') || control.getAttribute('id') || '');
      }
      if (!label) continue;

      let value = '';
      const tag = control.tagName.toLowerCase();
      const type = clean(control.getAttribute('type')).toLowerCase();

      if (tag === 'select') {
        const option = control.options[control.selectedIndex];
        value = clean(option ? option.textContent : control.value);
      } else if (type === 'checkbox' || type === 'radio') {
        value = control.checked ? 'Sim' : 'Não';
      } else {
        value = clean(control.value);
      }

      fields[label] = value;
      fields[fold(label)] = value;
    }

    return fields;
  });
}

function parseNifFromText(value) {
  const text = String(value || '');
  const match = text.match(/\((\d{9})\)/);
  if (match) return match[1];
  const digits = text.replace(/\D/g, '');
  return digits.length === 9 ? digits : '';
}

function normalizeYearMonth(dateText) {
  const text = sanitize(dateText);
  if (!text) return '';
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return Number(match[2] || '0') || '';
  }
  return '';
}

function pickField(fieldMap, candidates) {
  for (const candidate of candidates) {
    const token = fold(candidate);
    if (Object.prototype.hasOwnProperty.call(fieldMap, token)) {
      const value = sanitize(fieldMap[token]);
      if (value) return value;
    }
    for (const [key, value] of Object.entries(fieldMap)) {
      if (fold(key).includes(token)) {
        const text = sanitize(value);
        if (text) return text;
      }
    }
  }
  return '';
}

function buildExcelRow(listRow, mergedFields) {
  const nome = listRow.empresa || pickField(mergedFields, ['empresa']) || '';
  const nif = listRow.nif || pickField(mergedFields, ['nif']) || '';
  const dataInicioAtividade = pickField(mergedFields, ['data de inicio de atividade', 'data inicio de atividade']);
  const tipoIva = pickField(mergedFields, ['tipo iva']);
  const contabilista = pickField(mergedFields, ['contabilista certificado']);
  const nifContabilista = parseNifFromText(contabilista);

  const ruUser = pickField(mergedFields, ['utilizador relatorio unico', 'utilizador relatório único']);
  const ruPass = pickField(mergedFields, [
    'senha de utilizador relatorio unico',
    'senha de utilizador relatório único',
    'senha de acesso relatorio unico',
    'senha de acesso relatório único',
  ]);
  const ssUser = pickField(mergedFields, ['utilizador ss', 'niss']);
  const ssPass = pickField(mergedFields, [
    'senha de utilizador ss',
    'senha de acesso ss',
    'senha ss',
  ]);
  const atPass = pickField(mergedFields, [
    'senha de utilizador at',
    'senha de acesso at',
    'senha at',
  ]);
  const viaCttUser = pickField(mergedFields, ['utilizador viactt', 'viactt']);
  const viaCttPass = pickField(mergedFields, [
    'senha de utilizador viactt',
    'senha de acesso viactt',
    'senha viactt',
  ]);
  const iapmeiUser = pickField(mergedFields, ['utilizador iapmei']);
  const iapmeiPass = pickField(mergedFields, [
    'senha de utilizador iapmei',
    'senha de acesso iapmei',
    'senha iapmei',
  ]);

  const monthStart = pickField(mergedFields, ['mes de inicio de exercicio', 'mês de início de exercício']) || normalizeYearMonth(dataInicioAtividade);
  const colaboradores = pickField(mergedFields, ['n colaboradores', 'nº colaboradores', 'numero de colaboradores']);
  const equipas = pickField(mergedFields, ['equipas']);
  const idiomaNot = pickField(mergedFields, ['idioma notificacoes', 'idioma notificações']);
  const refInterna = pickField(mergedFields, ['referencia interna', 'referência interna']);
  const certidao = pickField(mergedFields, ['codigo da certidao permanente', 'código da certidão permanente']);
  const autoChangeSs = pickField(mergedFields, ['alterar automaticamente password seg social', 'alterar automaticamente password sec social']);
  const emailGestao = pickField(mergedFields, ['email de gestao', 'email de gestão']);
  const observacoes = pickField(mergedFields, ['observacoes', 'observações']);
  const userExec = pickField(mergedFields, ['utilizador de execucao', 'utilizador de execução']);
  const userVerif = pickField(mergedFields, ['utilizador de verificacao', 'utilizador de verificação']);
  const emailGeral = pickField(mergedFields, ['email geral']);

  const infoUsers = [emailGeral, userExec, userVerif].map((x) => sanitize(x)).filter(Boolean);
  const gestores = [emailGestao, userExec, userVerif, listRow.executante, listRow.verificador]
    .map((x) => sanitize(x))
    .filter(Boolean);
  const uniq = (arr) => Array.from(new Set(arr));

  return {
    Nome: nome,
    NIF: nif,
    PasswordAT: atPass,
    NISS: ssUser,
    PasswordSS: ssPass,
    UtilizadorRU: ruUser,
    PasswordRU: ruPass,
    TipoIVA: tipoIva,
    'Mês Inicio Exercício': monthStart,
    'N. Colaboradores': colaboradores,
    Equipas: equipas,
    'Utilizadores Info (emails separados por ;)': uniq(infoUsers).join(';'),
    'Gestores Cliente (emails separados por ;)': uniq(gestores).join(';'),
    'Idioma Notificações PT': idiomaNot,
    'Mails Artificiais (separados por ;)': '',
    'Referência Interna': refInterna || listRow.codigo || '',
    'NIF Contabilista Certificado': nifContabilista,
    'NISS Responsável Seg. Social': '',
    'Alterar Automaticamente Password Sec. Social quando password expirar': autoChangeSs || 'Não',
    'Data Inicio Atividade': dataInicioAtividade,
    'Código Certidão Permanente': certidao,
    'ViaCTT power2014': viaCttUser,
    'Password ViaCTT': viaCttPass,
    IAPMEI: iapmeiUser,
    'Password IAPMEI': iapmeiPass,
    'Valor Avença': '',
    'Tempo Resposta Mensal': '',
    Observações: observacoes,
    Executante: listRow.executante || '',
    Verificador: listRow.verificador || '',
    'Email Lista': listRow.emailLista || '',
    'Telemóvel Lista': listRow.telemovelLista || '',
    'URL Ficha': listRow.detailUrl || '',
  };
}

function writeCsv(filePath, rows, delimiter = ';') {
  if (!rows.length) {
    fs.writeFileSync(filePath, '\uFEFF', 'utf8');
    return;
  }
  const headers = OUTPUT_COLUMNS;
  const normalizedRows = normalizeRowsForColumns(rows, headers);
  const lines = [headers.map((h) => csvEscape(h, delimiter)).join(delimiter)];
  for (const row of normalizedRows) {
    lines.push(headers.map((h) => csvEscape(row[h] || '', delimiter)).join(delimiter));
  }
  fs.writeFileSync(filePath, `\uFEFF${lines.join('\n')}\n`, 'utf8');
}

function resolvePathLocal(value) {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function writeXlsx(filePath, rows, options = {}) {
  const templatePath = options.templatePath ? resolvePathLocal(options.templatePath) : '';
  const requestedSheet = sanitize(options.templateSheetName || '');
  const workbook = templatePath ? XLSX.readFile(templatePath) : XLSX.utils.book_new();
  const defaultSheetName = requestedSheet || (workbook.SheetNames[0] || 'Empresas');
  const sheetName = workbook.Sheets[defaultSheetName]
    ? defaultSheetName
    : (requestedSheet && workbook.SheetNames[0]) || defaultSheetName;

  let headers = OUTPUT_COLUMNS;
  if (workbook.Sheets[sheetName]) {
    const existingAoa = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      blankrows: false,
      defval: '',
    });
    const firstRow = Array.isArray(existingAoa[0]) ? existingAoa[0].map((item) => sanitize(item)) : [];
    const hasHeaders = firstRow.some(Boolean);
    if (hasHeaders) headers = firstRow;
  }

  const normalizedRows = normalizeRowsForColumns(rows, headers);
  const aoa = [headers];
  normalizedRows.forEach((row) => {
    aoa.push(headers.map((header) => row[header] || ''));
  });

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet['!cols'] = headers.map((header) => {
    const headerLen = String(header || '').length;
    const maxCellLen = normalizedRows.reduce((max, row) => {
      const len = String(row[header] || '').length;
      return len > max ? len : max;
    }, headerLen);
    return { wch: Math.min(Math.max(maxCellLen + 2, 10), 60) };
  });

  workbook.Sheets[sheetName] = sheet;
  if (!workbook.SheetNames.includes(sheetName)) {
    workbook.SheetNames.push(sheetName);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  XLSX.writeFile(workbook, filePath, { compression: true });
  return { sheetName, headers };
}

async function main() {
  const loginUrl = process.env.SAFT_LOGIN_URL || 'https://app.saftonline.pt/conta/inss?ReturnUrl=%2Fdossier%2Fdossier';
  const empresasUrl = process.env.SAFT_EMPRESAS_URL || 'https://app.saftonline.pt/empresas';
  const email = getArg('--email') || process.env.SAFT_EMAIL || process.env.Email_saft || '';
  const password = getArg('--password') || process.env.SAFT_PASSWORD || process.env.Senha_saft || '';
  const headless = String(getArg('--headless', process.env.SAFT_HEADLESS || 'true')).toLowerCase() !== 'false';
  const maxPages = Math.max(1, normalizeInt(getArg('--max-pages', process.env.SAFT_EMPRESAS_MAX_PAGES || '50'), 50));
  const limit = Math.max(0, normalizeInt(getArg('--limit', process.env.SAFT_EMPRESAS_LIMIT || '0'), 0));
  const timeoutMs = Math.max(30000, normalizeInt(process.env.SAFT_TIMEOUT_MS || '90000', 90000));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = getArg('--out-dir', path.resolve(process.cwd(), 'exports'));
  const outArg = getArg('--out', '');
  const rawArg = getArg('--out-raw', '');
  const csvArg = getArg('--out-csv', '');
  const xlsxArg = getArg('--out-xlsx', '');
  const templatePath = getArg('--template', process.env.SAFT_EMPRESAS_TEMPLATE || '');
  const templateSheet = getArg('--template-sheet', process.env.SAFT_EMPRESAS_TEMPLATE_SHEET || '');
  const defaultBase = path.join(outDir, `saft_empresas_${stamp}`);

  let outCsv = csvArg;
  let outXlsx = xlsxArg;
  let baseForRaw = outArg || defaultBase;
  if (outArg) {
    const ext = path.extname(outArg).toLowerCase();
    if (ext === '.csv') {
      outCsv = outArg;
      outXlsx = outXlsx || outArg.replace(/\.csv$/i, '.xlsx');
      baseForRaw = outArg.replace(/\.csv$/i, '');
    } else if (ext === '.xlsx') {
      outXlsx = outArg;
      outCsv = outCsv || outArg.replace(/\.xlsx$/i, '.csv');
      baseForRaw = outArg.replace(/\.xlsx$/i, '');
    } else {
      outCsv = outCsv || `${outArg}.csv`;
      outXlsx = outXlsx || `${outArg}.xlsx`;
      baseForRaw = outArg;
    }
  }
  if (!outCsv) outCsv = `${defaultBase}.csv`;
  if (!outXlsx) outXlsx = `${defaultBase}.xlsx`;
  const rawOut = rawArg || `${baseForRaw}.raw.json`;

  outCsv = resolvePathLocal(outCsv);
  outXlsx = resolvePathLocal(outXlsx);
  const resolvedRawOut = resolvePathLocal(rawOut);
  const resolvedTemplatePath = templatePath ? resolvePathLocal(templatePath) : '';

  if (!email || !password) {
    throw new Error('Credenciais SAFT não configuradas (Email_saft/Senha_saft).');
  }
  if (resolvedTemplatePath && !fs.existsSync(resolvedTemplatePath)) {
    throw new Error(`Template XLSX não encontrado: ${resolvedTemplatePath}`);
  }

  fs.mkdirSync(path.dirname(outCsv), { recursive: true });
  fs.mkdirSync(path.dirname(outXlsx), { recursive: true });
  fs.mkdirSync(path.dirname(resolvedRawOut), { recursive: true });

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  const companies = [];
  const seen = new Set();
  const raw = [];

  try {
    await loginSaft(page, { loginUrl, email, password, timeoutMs });
    await page.goto(empresasUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    for (let i = 0; i < maxPages; i += 1) {
      const rows = await extractEmpresaRows(page);
      let added = 0;
      for (const row of rows) {
        const key = row.detailUrl || `${row.nif}|${row.empresa}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        companies.push(row);
        added += 1;
        if (limit > 0 && companies.length >= limit) break;
      }
      if (limit > 0 && companies.length >= limit) break;
      if (added === 0) break;

      const moved = await goToNextPage(page, readPageConfig(page.url()));
      if (!moved) break;
    }

    for (let idx = 0; idx < companies.length; idx += 1) {
      const company = companies[idx];
      process.stdout.write(`[${idx + 1}/${companies.length}] ${company.nif} ${company.empresa}\n`);
      if (!company.detailUrl) {
        raw.push({ ...company, tabs: {}, merged: {} });
        continue;
      }

      const detailPage = await context.newPage();
      detailPage.setDefaultTimeout(timeoutMs);
      try {
        await detailPage.goto(company.detailUrl, { waitUntil: 'domcontentloaded' });
        await detailPage.waitForTimeout(900);

        const tabNames = ['Dados', 'Configurações', 'Contas', 'Avançadas', 'Outros'];
        const tabs = {};
        for (const tab of tabNames) {
          await clickTabIfExists(detailPage, tab);
          const fields = await extractActiveTabFields(detailPage);
          tabs[tab] = fields;
        }

        const merged = {};
        for (const tab of tabNames) {
          const fields = tabs[tab] || {};
          Object.entries(fields).forEach(([k, v]) => {
            const key = fold(k);
            if (!key) return;
            if (!merged[key] && sanitize(v)) merged[key] = sanitize(v);
            if (!merged[k] && sanitize(v)) merged[k] = sanitize(v);
          });
        }

        raw.push({ ...company, tabs, merged });
      } catch (error) {
        raw.push({ ...company, tabs: {}, merged: {}, error: String(error?.message || error) });
      } finally {
        await detailPage.close();
      }
    }

    const rows = raw.map((item) => buildExcelRow(item, item.merged || {}));
    writeCsv(outCsv, rows, ';');
    const xlsxMeta = writeXlsx(outXlsx, rows, {
      templatePath: resolvedTemplatePath,
      templateSheetName: templateSheet,
    });
    fs.writeFileSync(resolvedRawOut, JSON.stringify(raw, null, 2), 'utf8');

    process.stdout.write(
      JSON.stringify(
        {
          success: true,
          totalCompanies: companies.length,
          csv: outCsv,
          xlsx: outXlsx,
          raw: resolvedRawOut,
          template: resolvedTemplatePath || null,
          sheet: xlsxMeta.sheetName,
        },
        null,
        2
      ) + '\n'
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exit(1);
});
