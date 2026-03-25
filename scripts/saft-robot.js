#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function fail(message, exitCode = 1) {
  if (message) process.stderr.write(String(message));
  process.exit(exitCode);
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return '';
  return String(process.argv[index + 1] || '').trim();
}

function splitSelectors(rawValue) {
  return String(rawValue || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function firstSelector(page, selectors) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      const count = await locator.count();
      if (count > 0) return selector;
    } catch (error) {
      // ignore invalid selector and continue
    }
  }
  return '';
}

function isTruthyValue(value) {
  return ['1', 'true', 'yes', 'on', 'sim'].includes(String(value || '').trim().toLowerCase());
}

async function extractDossierMetadata(page) {
  try {
    return await page.evaluate(() => {
      const normalize = (value) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim();
      const fold = (value) =>
        normalize(value)
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();

      const readFieldValue = (labelEl) => {
        if (!labelEl) return '';
        const forId = String(labelEl.getAttribute('for') || '').trim();
        if (forId) {
          const byId = document.getElementById(forId);
          if (byId) {
            const direct = normalize(byId.value || byId.textContent || '');
            if (direct) return direct;
          }
        }

        const parent = labelEl.parentElement;
        if (parent) {
          const field = parent.querySelector('input, textarea, select');
          if (field) {
            const direct = normalize(field.value || field.textContent || '');
            if (direct) return direct;
          }
        }

        let next = labelEl.nextElementSibling;
        while (next) {
          if (next.matches('input, textarea, select')) {
            const direct = normalize(next.value || next.textContent || '');
            if (direct) return direct;
          }
          if (next.matches('label')) break;
          next = next.nextElementSibling;
        }

        return '';
      };

      const labelNodes = Array.from(document.querySelectorAll('label, .control-label'));
      const pairs = labelNodes
        .map((labelEl) => ({
          labelRaw: normalize(labelEl.textContent),
          labelFold: fold(labelEl.textContent),
          value: readFieldValue(labelEl),
        }))
        .filter((item) => item.labelFold && item.value);

      const pickByLabel = (needle) => {
        const key = fold(needle);
        const match = pairs.find((item) => item.labelFold.includes(key));
        return match ? normalize(match.value) : '';
      };

      const pickAllByLabel = (needle) => {
        const key = fold(needle);
        return pairs
          .filter((item) => item.labelFold.includes(key))
          .map((item) => normalize(item.value))
          .filter(Boolean);
      };

      const pickNthByLabel = (needle, index = 0) => {
        const all = pickAllByLabel(needle);
        if (all.length === 0) return '';
        const safeIndex = Math.max(0, Math.min(index, all.length - 1));
        return all[safeIndex] || '';
      };

      const dataPedidos = pickAllByLabel('data pedido');
      const dataRecolhas = pickAllByLabel('data recolha');

      return {
        situacaoFiscalAt: pickByLabel('situacao fiscal at'),
        situacaoFiscalSs: pickByLabel('situacao fiscal ss'),
        certidaoPermanenteCodigo: pickNthByLabel('certidao permanente', 0),
        certidaoPermanenteValidade: pickByLabel('data de validade'),
        dataPedidoAt: dataPedidos[0] || '',
        dataPedidoSs: dataPedidos[1] || '',
        dataRecolhaAt: dataRecolhas[0] || '',
        dataRecolhaSs: dataRecolhas[1] || '',
        dataPedidos,
        dataRecolhas,
      };
    });
  } catch (error) {
    return {
      situacaoFiscalAt: '',
      situacaoFiscalSs: '',
      certidaoPermanenteCodigo: '',
      certidaoPermanenteValidade: '',
      dataPedidoAt: '',
      dataPedidoSs: '',
      dataRecolhaAt: '',
      dataRecolhaSs: '',
      dataPedidos: [],
      dataRecolhas: [],
    };
  }
}

function resolveDocActionSelectors(documentType) {
  const key = String(documentType || '').trim().toUpperCase();
  const map = {
    DECLARACAO_NAO_DIVIDA: process.env.SAFT_ACTION_SELECTOR_DECLARACAO_NAO_DIVIDA || '',
    IES: process.env.SAFT_ACTION_SELECTOR_IES || '',
    MODELO_22: process.env.SAFT_ACTION_SELECTOR_MODELO_22 || '',
    CERTIDAO_PERMANENTE: process.env.SAFT_ACTION_SELECTOR_CERTIDAO_PERMANENTE || '',
    CERTIFICADO_PME: process.env.SAFT_ACTION_SELECTOR_CERTIFICADO_PME || '',
    CRC: process.env.SAFT_ACTION_SELECTOR_CRC || '',
  };

  const configured = splitSelectors(map[key] || process.env.SAFT_ACTION_SELECTOR || '');
  if (configured.length > 0) return configured;

  if (key === 'MODELO_22') {
    const currentYear = new Date().getUTCFullYear();
    const years = [currentYear - 3, currentYear - 2, currentYear - 1];
    const selectors = [];
    for (const year of years) {
      selectors.push(`text=/Modelo\\s*22\\s*${year}/i >> xpath=following::a[contains(@class,'download')][1]`);
      selectors.push(`text=/Modelo\\s*22\\s*${year}/i >> xpath=following::button[contains(@class,'download')][1]`);
      selectors.push(`text=/Modelo\\s*22\\s*${year}/i >> xpath=following::input[@type='image'][1]`);
      selectors.push(`text=/Modelo\\s*22\\s*${year}/i >> xpath=following::a[1]`);
      selectors.push(`text=/Modelo\\s*22\\s*${year}/i >> xpath=following::button[1]`);
    }
    selectors.push('form[action*="/m22/download"] input[type="image"]');
    selectors.push('a:has(i[class*="download"])');
    selectors.push('button:has(i[class*="download"])');
    return selectors;
  }

  if (key === 'IES') {
    const currentYear = new Date().getUTCFullYear();
    const years = [currentYear - 3, currentYear - 2, currentYear - 1];
    const selectors = [];
    for (const year of years) {
      selectors.push(`text=/IES\\s*${year}/i >> xpath=following::a[contains(@class,'download')][1]`);
      selectors.push(`text=/IES\\s*${year}/i >> xpath=following::button[contains(@class,'download')][1]`);
      selectors.push(`text=/IES\\s*${year}/i >> xpath=following::input[@type='image'][1]`);
      selectors.push(`text=/IES\\s*${year}/i >> xpath=following::a[1]`);
    }
    selectors.push('form[action*="/ies/download"] input[type="image"]');
    selectors.push('a:has(i[class*="download"])');
    selectors.push('button:has(i[class*="download"])');
    return selectors;
  }

  if (key === 'DECLARACAO_NAO_DIVIDA') {
    return [
      'text=/Certid[aã]o\\s*AT/i >> xpath=following::a[contains(@class,\'download\')][1]',
      'text=/Certid[aã]o\\s*AT/i >> xpath=following::button[contains(@class,\'download\')][1]',
      'text=/Certid[aã]o\\s*AT/i >> xpath=following::input[@type=\'image\'][1]',
      'text=/Certid[aã]o\\s*SS/i >> xpath=following::a[contains(@class,\'download\')][1]',
      'text=/Certid[aã]o\\s*SS/i >> xpath=following::button[contains(@class,\'download\')][1]',
      'text=/Certid[aã]o\\s*SS/i >> xpath=following::input[@type=\'image\'][1]',
      'a[href*="certidao"]:has(i[class*="download"])',
      'button[data-original-title*="Download"]',
      'a:has(i[class*="download"])',
      'button:has(i[class*="download"])',
    ];
  }

  if (key === 'CERTIDAO_PERMANENTE') {
    return [
      'text=/Certid[aã]o\\s*Permanente/i >> xpath=following::a[contains(@class,\'download\')][1]',
      'text=/Certid[aã]o\\s*Permanente/i >> xpath=following::button[contains(@class,\'download\')][1]',
      'text=/Certid[aã]o\\s*Permanente/i >> xpath=following::input[@type=\'image\'][1]',
      'a[href*="permanente"]:has(i[class*="download"])',
      'a:has(i[class*="download"])',
      'button:has(i[class*="download"])',
    ];
  }

  if (key === 'CERTIFICADO_PME') {
    return [
      'text=/Certificado\\s*PME/i >> xpath=following::a[contains(@class,\'download\')][1]',
      'text=/Certificado\\s*PME/i >> xpath=following::button[contains(@class,\'download\')][1]',
      'text=/Certificado\\s*PME/i >> xpath=following::input[@type=\'image\'][1]',
      'a[href*="pme"]:has(i[class*="download"])',
      'a:has(i[class*="download"])',
      'button:has(i[class*="download"])',
    ];
  }

  if (key === 'CRC') {
    return [
      'text=/CRC/i >> xpath=following::a[contains(@class,\'download\')][1]',
      'text=/CRC/i >> xpath=following::button[contains(@class,\'download\')][1]',
      'text=/CRC/i >> xpath=following::input[@type=\'image\'][1]',
      'text=/BDC/i >> xpath=following::a[contains(@class,\'download\')][1]',
      'text=/BDC/i >> xpath=following::button[contains(@class,\'download\')][1]',
      'a:has(i[class*="download"])',
      'button:has(i[class*="download"])',
    ];
  }

  return [];
}

function targetFileName(documentType, nif, fallbackName = '', suffix = '') {
  const extension = path.extname(fallbackName || '') || '.pdf';
  const safeDoc = String(documentType || 'documento').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeNif = String(nif || 'sem_nif').replace(/\D/g, '') || 'sem_nif';
  return `${safeDoc}_${safeNif}${suffix}${extension}`;
}

function extractYearFromText(value) {
  const matches = String(value || '').match(/(20\d{2})/g);
  if (!matches || matches.length === 0) return '';
  return String(matches[matches.length - 1] || '').trim();
}

async function trySaveFileFromPopup(popup, context, outDir, documentType, nif, suffix = '') {
  try {
    await popup.waitForLoadState('domcontentloaded', { timeout: 10000 });
  } catch (error) {
    // ignore
  }

  const popupUrl = String(popup.url() || '').trim();
  if (!popupUrl || popupUrl === 'about:blank') {
    try { await popup.close(); } catch {}
    return '';
  }

  try {
    const response = await context.request.get(popupUrl, { timeout: 20000 });
    if (!response.ok()) {
      try { await popup.close(); } catch {}
      return '';
    }
    const headers = response.headers();
    const contentType = String(headers['content-type'] || '').toLowerCase();
    const contentDisposition = String(headers['content-disposition'] || '').toLowerCase();
    const likelyPdf = contentType.includes('pdf') || contentDisposition.includes('.pdf');
    if (!likelyPdf) {
      try { await popup.close(); } catch {}
      return '';
    }
    const fileName = targetFileName(documentType, nif, 'documento.pdf', suffix);
    const targetPath = path.join(outDir, fileName);
    await fs.promises.writeFile(targetPath, await response.body());
    try { await popup.close(); } catch {}
    return targetPath;
  } catch (error) {
    try { await popup.close(); } catch {}
    return '';
  }
}

async function main() {
  const outDir = getArg('--outDir') || process.cwd();
  const documentType = getArg('--document') || 'documento';
  const nif = getArg('--nif') || '';
  const stubFile = getArg('--stubFile') || process.env.SAFT_ROBOT_STUB_FILE || '';

  await fs.promises.mkdir(outDir, { recursive: true });

  // Placeholder:
  // If a local stub file is provided, copy it to outDir and return its path.
  if (stubFile && fs.existsSync(stubFile)) {
    const extension = path.extname(stubFile) || '.pdf';
    const targetName = `${documentType}_${nif || 'sem_nif'}${extension}`;
    const targetPath = path.join(outDir, targetName);
    await fs.promises.copyFile(stubFile, targetPath);
    process.stdout.write(JSON.stringify({ filePath: targetPath, filePaths: [targetPath] }));
    return;
  }

  let playwright = null;
  try {
    playwright = require('playwright');
  } catch (error) {
    fail('Playwright não instalado. Execute: npm i playwright && npx playwright install chromium', 2);
  }

  const loginUrl =
    process.env.SAFT_LOGIN_URL ||
    'https://app.saftonline.pt/conta/inss?ReturnUrl=%2Fdossier%2Fdossier';
  const dossierUrl = process.env.SAFT_DOSSIER_URL || 'https://app.saftonline.pt/dossier/dossier';
  const email = getArg('--email') || process.env.SAFT_EMAIL || process.env.Email_saft || '';
  const password = getArg('--password') || process.env.SAFT_PASSWORD || process.env.Senha_saft || '';
  const headless = String(process.env.SAFT_HEADLESS || 'true').trim().toLowerCase() !== 'false';
  const timeoutMs = Number(process.env.SAFT_TIMEOUT_MS || 90000);
  const metadataOnly = isTruthyValue(getArg('--metadataOnly') || process.env.SAFT_METADATA_ONLY || 'false');

  if (!email || !password) {
    fail('Credenciais SAFT não configuradas.', 2);
  }

  const emailSelectors = splitSelectors(
    process.env.SAFT_EMAIL_SELECTOR || '#Email, input[name="Email"], input[type="email"]'
  );
  const passwordSelectors = splitSelectors(
    process.env.SAFT_PASSWORD_SELECTOR || '#Password, input[name="Password"], input[type="password"]'
  );
  const submitSelectors = splitSelectors(
    process.env.SAFT_SUBMIT_SELECTOR || 'button[type="submit"], input[type="submit"]'
  );
  const searchSelectors = splitSelectors(
    process.env.SAFT_SEARCH_SELECTOR ||
      '#ConsultaPesquisa, input[type="search"], input[placeholder*="Pesquisar"], input[placeholder*="nome"]'
  );
  const detailsSelectors = splitSelectors(
    process.env.SAFT_DETAILS_SELECTOR ||
      'a[href*="/dossier/detalhes"], a:has(i[class*="eye"]), button:has(i[class*="eye"])'
  );
  const openDetailsAfterSearch = String(process.env.SAFT_OPEN_DETAILS || 'true').trim().toLowerCase() !== 'false';
  const actionSelectors = resolveDocActionSelectors(documentType);
  const allowMultipleDownloads =
    String(process.env.SAFT_MULTI_DOWNLOAD || '').trim().toLowerCase() === 'true' ||
    ['modelo_22', 'declaracao_nao_divida', 'ies'].includes(String(documentType || '').trim().toLowerCase());
  const annualDocType = ['modelo_22', 'ies'].includes(String(documentType || '').trim().toLowerCase());
  const isValidAnnualYear = (yearValue) => {
    const year = Number(String(yearValue || '').trim());
    if (!Number.isFinite(year) || year < 2000) return false;
    const currentYear = new Date().getUTCFullYear();
    return year <= (currentYear - 1);
  };

  const browser = await playwright.chromium.launch({ headless });
  const context = await browser.newContext({
    acceptDownloads: true,
  });
  const page = await context.newPage();
  let activePage = page;

  try {
    page.setDefaultTimeout(timeoutMs);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

    const emailSelector = await firstSelector(activePage, emailSelectors);
    const passwordSelector = await firstSelector(activePage, passwordSelectors);
    const submitSelector = await firstSelector(activePage, submitSelectors);

    if (!emailSelector || !passwordSelector || !submitSelector) {
      fail('Seletores de login SAFT não encontrados.', 3);
    }

    await activePage.fill(emailSelector, email);
    await activePage.fill(passwordSelector, password);

    await Promise.allSettled([
      activePage.waitForLoadState('networkidle'),
      activePage.locator(submitSelector).first().click(),
    ]);

    await activePage.goto(dossierUrl, { waitUntil: 'domcontentloaded' });

    if (nif) {
      const searchSelector = await firstSelector(activePage, searchSelectors);
      if (searchSelector) {
        await activePage.fill(searchSelector, nif);
        await activePage.keyboard.press('Enter');
        await activePage.waitForTimeout(1200);
      }
    }
    if (openDetailsAfterSearch) {
      let detailsLocator = null;
      if (nif) {
        const rowByNif = activePage.locator('table tbody tr', { hasText: nif }).first();
        if ((await rowByNif.count()) > 0) {
          const fromRow = rowByNif
            .locator('a[href*="/dossier/detalhes"], a:has(i.pe-7s-look), a:has(i[class*="look"])')
            .first();
          if ((await fromRow.count()) > 0) {
            detailsLocator = fromRow;
          }
        }
      }

      if (!detailsLocator) {
        const detailsSelector = await firstSelector(activePage, detailsSelectors);
        if (detailsSelector) {
          detailsLocator = activePage.locator(detailsSelector).first();
        }
      }

      if (detailsLocator) {
        const popupPromise = activePage.waitForEvent('popup', { timeout: 4000 }).catch(() => null);
        await detailsLocator.click();
        const popup = await popupPromise;
        if (popup) {
          await popup.waitForLoadState('domcontentloaded');
          activePage = popup;
        } else {
          await activePage.waitForLoadState('domcontentloaded');
        }
        await activePage.waitForTimeout(900);
      }
    }

    const dossierMetadata = await extractDossierMetadata(activePage);

    if (metadataOnly) {
      process.stdout.write(
        JSON.stringify({
          filePath: '',
          filePaths: [],
          metadata: dossierMetadata,
        })
      );
      return;
    }

    if (!actionSelectors.length) {
      fail('Seletores de ação SAFT não configurados para este documento.', 3);
    }

    const downloadedPaths = [];
    const downloadedYears = new Set();
    for (const selector of actionSelectors) {
      const availableSelector = await firstSelector(activePage, [selector]);
      if (!availableSelector) continue;
      const selectorYear = extractYearFromText(availableSelector);
      if (annualDocType && selectorYear && !isValidAnnualYear(selectorYear)) {
        continue;
      }
      if (annualDocType && selectorYear && downloadedYears.has(selectorYear)) {
        continue;
      }
      if (annualDocType && downloadedPaths.length > 0 && !selectorYear) {
        continue;
      }
      try {
        const suffix = selectorYear
          ? `_${selectorYear}`
          : (allowMultipleDownloads ? `_${downloadedPaths.length + 1}` : '');
        const downloadAttempt = activePage
          .waitForEvent('download', { timeout: 12000 })
          .then(async (download) => {
            const suggested = await download.suggestedFilename();
            const suggestedYear = extractYearFromText(suggested);
            const finalSuffix = selectorYear
              ? `_${selectorYear}`
              : (suggestedYear && isValidAnnualYear(suggestedYear) ? `_${suggestedYear}` : suffix);
            const targetPath = path.join(outDir, targetFileName(documentType, nif, suggested, finalSuffix));
            await download.saveAs(targetPath);
            return targetPath;
          })
          .catch(() => '');

        const popupAttempt = activePage
          .waitForEvent('popup', { timeout: 12000 })
          .then((popup) => trySaveFileFromPopup(popup, context, outDir, documentType, nif, suffix))
          .catch(() => '');

        await activePage.locator(availableSelector).first().click({ timeout: 10000 });
        const targetPath = (await Promise.race([downloadAttempt, popupAttempt])) || '';
        if (!targetPath) continue;
        downloadedPaths.push(targetPath);
        const downloadedYear = extractYearFromText(path.basename(targetPath));
        if (annualDocType && downloadedYear) {
          downloadedYears.add(downloadedYear);
        }
        if (!allowMultipleDownloads) break;
      } catch (error) {
        // try next selector
      }
    }

    if (downloadedPaths.length === 0) {
      if (String(process.env.SAFT_DEBUG || '').trim().toLowerCase() === 'true') {
        const stamp = Date.now();
        const screenshotPath = path.join(outDir, `saft_debug_${stamp}.png`);
        const htmlPath = path.join(outDir, `saft_debug_${stamp}.html`);
        await activePage.screenshot({ path: screenshotPath, fullPage: true });
        await fs.promises.writeFile(htmlPath, await activePage.content(), 'utf8');
      }
      process.stdout.write(JSON.stringify({ filePath: '', filePaths: [], metadata: dossierMetadata }));
      return;
    }

    process.stdout.write(
      JSON.stringify({ filePath: downloadedPaths[0], filePaths: downloadedPaths, metadata: dossierMetadata })
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(String(error?.message || error));
  process.exit(1);
});
