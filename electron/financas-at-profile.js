function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function compactSpaces(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

function normalizeSearchText(value) {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanExtractedValue(value) {
  const cleaned = compactSpaces(value)
    .replace(/^[:\-–—]+\s*/, '')
    .replace(/\s+[:\-–—]+\s*$/, '')
    .trim();
  if (!cleaned || cleaned === '-' || cleaned === '—') return '';
  return cleaned;
}

function normalizeDateToIso(value) {
  const raw = compactSpaces(value);
  const isoMatch = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  const match = raw.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/);
  if (!match) return raw;
  const day = match[1].padStart(2, '0');
  const month = match[2].padStart(2, '0');
  return `${match[3]}-${month}-${day}`;
}

function normalizeTipoIva(value) {
  const raw = cleanExtractedValue(value);
  const normalized = normalizeSearchText(raw);
  if (!normalized) return '';
  if (normalized.includes('mensal')) return 'MENSAL';
  if (normalized.includes('trimestral')) return 'TRIMESTRAL';
  if (normalized.includes('isento') || normalized.includes('isen')) return 'ISENTO';
  if (normalized.includes('nao sujeito') || normalized.includes('não sujeito')) return 'NAO_SUJEITO';
  return raw;
}

function uniqueList(values) {
  return Array.from(new Set(values.map(cleanExtractedValue).filter(Boolean)));
}

function firstRegexValue(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return cleanExtractedValue(match[1]);
  }
  return '';
}

function parseFieldsFromText(text) {
  const raw = compactSpaces(text);
  const normalized = stripAccents(raw);
  const fields = {};

  const codigoReparticaoFinancas = firstRegexValue(normalized, [
    /Servico de Financas Competente\s+(\d{3,5})(?:\s+[A-ZÀ-Ý0-9-]+)?/i,
    /(?:Codigo\s+)?(?:do\s+)?Servico\s+de\s+Financas\s+(\d{3,5})\b/i,
  ]);
  if (codigoReparticaoFinancas) fields.codigoReparticaoFinancas = codigoReparticaoFinancas;

  const morada = firstRegexValue(raw, [
    /(?:Resid[eê]ncia\s*\([^)]*\)|Sede\s+ou\s+Estabelecimento\s+Est[aá]vel\s*\([^)]*\))\s+Morada\s+(.+?)\s+Localidade\s+/i,
    /Morada\s+(.+?)\s+Localidade\s+/i,
  ]);
  if (morada) {
    const localidade = firstRegexValue(raw, [/Localidade\s+(.+?)\s+C[oó]digo Postal\s+/i]);
    const codigoPostal = firstRegexValue(raw, [/C[oó]digo Postal\s+(.+?)\s+Distrito\s+/i]);
    fields.morada = [morada, localidade, codigoPostal].filter(Boolean).join(', ');
  }

  const inicioAtividade = firstRegexValue(raw, [
    /Dados Gerais de Atividade\s+Data de In[ií]cio\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
    /Data de In[ií]cio\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
  ]);
  if (inicioAtividade) fields.inicioAtividade = normalizeDateToIso(inicioAtividade);

  const caePrincipal = firstRegexValue(raw, [
    /CAE\s+Principal\s+(\d{5})\b/i,
  ]);
  if (caePrincipal) fields.caePrincipal = caePrincipal;

  const tipoIva = firstRegexValue(raw, [
    /Atividade\s+em\s+IVA\s+Enquadramento\s+(.+?)\s+Data\s+de\s+Enquadramento/i,
    /Enquadramento\s+(.+?)\s+Data\s+de\s+Enquadramento/i,
  ]);
  if (tipoIva) fields.tipoIva = normalizeTipoIva(tipoIva);

  return fields;
}

async function extractLabelValuePairs(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    const rows = [];

    document.querySelectorAll('tr').forEach((row) => {
      const cells = Array.from(row.querySelectorAll('th,td')).map((cell) => normalize(cell.textContent));
      if (cells.length >= 2) {
        rows.push({ label: cells[0], value: cells.slice(1).join(' ') });
      }
    });

    document.querySelectorAll('dt').forEach((dt) => {
      let dd = dt.nextElementSibling;
      while (dd && dd.tagName.toLowerCase() !== 'dd') dd = dd.nextElementSibling;
      if (dd) rows.push({ label: normalize(dt.textContent), value: normalize(dd.textContent) });
    });

    document.querySelectorAll('label').forEach((label) => {
      const labelText = normalize(label.textContent);
      const forId = label.getAttribute('for');
      let value = '';
      if (forId) {
        const target = document.getElementById(forId);
        value = normalize((target && ('value' in target ? target.value : target.textContent)) || '');
      }
      if (!value) {
        const wrapper = label.parentElement;
        if (wrapper) {
          const clone = wrapper.cloneNode(true);
          clone.querySelectorAll('label,script,style,button').forEach((node) => node.remove());
          value = normalize(clone.textContent);
        }
      }
      if (labelText && value) rows.push({ label: labelText, value });
    });

    document.querySelectorAll('[aria-label],[data-label],[title]').forEach((node) => {
      const label = normalize(node.getAttribute('aria-label') || node.getAttribute('data-label') || node.getAttribute('title'));
      const value = normalize(('value' in node ? node.value : node.textContent) || '');
      if (label && value && label !== value) rows.push({ label, value });
    });

    return rows;
  });
}

function mapPairsToFields(pairs) {
  const fields = {};
  const rawMatches = [];
  const findByLabels = (labels) => {
    for (const pair of pairs) {
      const label = normalizeSearchText(pair.label);
      if (!label) continue;
      if (labels.some((candidate) => label.includes(normalizeSearchText(candidate)))) {
        const value = cleanExtractedValue(pair.value);
        if (value) {
          rawMatches.push({ label: pair.label, value });
          return value;
        }
      }
    }
    return '';
  };

  const morada = findByLabels(['domicilio fiscal', 'morada fiscal', 'morada']);
  if (morada) fields.morada = morada;

  const inicioAtividade = findByLabels(['inicio de atividade', 'inicio de actividade', 'data de inicio']);
  if (inicioAtividade) fields.inicioAtividade = normalizeDateToIso(inicioAtividade);

  const tipoIva = findByLabels(['regime de iva', 'periodicidade iva', 'periodicidade do iva', 'tipo de iva']);
  if (tipoIva) fields.tipoIva = normalizeTipoIva(tipoIva);

  const caePrincipal = findByLabels(['cae principal', 'cae']);
  const caeMatch = String(caePrincipal || '').match(/\b\d{5}\b/);
  if (caeMatch) fields.caePrincipal = caeMatch[0];

  const reparticao = findByLabels(['codigo reparticao financas', 'codigo do servico financas', 'servico de financas', 'reparticao de financas']);
  const repMatch = String(reparticao || '').match(/\b\d{3,5}\b/);
  if (repMatch) fields.codigoReparticaoFinancas = repMatch[0];

  return { fields, rawMatches };
}

function resolveCandidateUrls(options = {}) {
  const fromPayload = Array.isArray(options.profileUrls) ? options.profileUrls : [];
  const fromSingle = String(options.profileUrl || options.targetUrl || '').trim() ? [String(options.profileUrl || options.targetUrl).trim()] : [];
  const fromEnv = String(process.env.PORTAL_FINANCAS_AT_PROFILE_URLS || '')
    .split(/[\n,;]+/)
    .map((url) => url.trim())
    .filter(Boolean);

  return uniqueList([
    ...fromPayload,
    ...fromSingle,
    ...fromEnv,
    'https://sitfiscal.portaldasfinancas.gov.pt/integrada/presentation?queryStringS=targetScreen%3DdecrIdentificacao',
    'https://sitfiscal.portaldasfinancas.gov.pt/integrada/presentation?queryStringS=targetScreen%3DdecrActividade',
    'https://www.portaldasfinancas.gov.pt/pt/main.jsp',
  ]).filter((url) => /^https?:\/\//i.test(url));
}

async function tryReadCurrentPage(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null);
  await page.waitForTimeout(700).catch(() => null);

  const pairs = await extractLabelValuePairs(page).catch(() => []);
  const pairResult = mapPairsToFields(Array.isArray(pairs) ? pairs : []);
  const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const textFields = parseFieldsFromText(text);

  return {
    fields: { ...pairResult.fields, ...textFields },
    rawMatches: pairResult.rawMatches,
    textPreview: compactSpaces(text).slice(0, 500),
  };
}


function buildActivityUrlFromCurrent(urlText) {
  const raw = String(urlText || '').trim();
  if (!raw || !/sitfiscal\.portaldasfinancas\.gov\.pt\/integrada\/presentation/i.test(raw)) return '';
  try {
    const url = new URL(raw);
    const queryString = url.searchParams.get('queryStringS') || '';
    if (!queryString) return '';
    const decoded = decodeURIComponent(queryString);
    if (!/targetScreen=/i.test(decoded)) return '';
    const nextDecoded = decoded.replace(/targetScreen=[^&]+/i, 'targetScreen=decrActividade');
    url.searchParams.set('queryStringS', nextDecoded);
    return url.toString();
  } catch (_) {
    return raw.replace(/targetScreen%3D[^%&]+/i, 'targetScreen%3DdecrActividade');
  }
}

async function clickIntegratedMenuItem(page, label) {
  const candidates = [
    `a:has-text("${label}")`,
    `button:has-text("${label}")`,
    `text=${label}`,
  ];
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible({ timeout: 1200 }).catch(() => false);
    if (!visible) continue;
    await Promise.allSettled([
      page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
      locator.click({ timeout: 2500 }),
    ]);
    await page.waitForTimeout(700).catch(() => null);
    return true;
  }
  return false;
}

async function navigateToActivityPage(page) {
  const directUrl = buildActivityUrlFromCurrent(page.url());
  if (directUrl && directUrl !== page.url()) {
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(900).catch(() => null);
    const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (/Atividade Exercida|Actividade Exercida|CAE Principal|Atividade em IVA/i.test(text)) return true;
  }

  if (await clickIntegratedMenuItem(page, 'Atividade Exercida')) return true;
  if (await clickIntegratedMenuItem(page, 'Actividade Exercida')) return true;
  return false;
}


function countCollectedFields(fields) {
  return Object.values(fields || {}).filter((value) => String(value || '').trim()).length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectFinancasAtProfile(page, options = {}) {
  const urls = resolveCandidateUrls(options);
  const attempts = [];
  const mergedFields = {};
  let sourceUrl = page.url();
  let rawMatches = [];

  const readAndMerge = async (stage) => {
    const result = await tryReadCurrentPage(page);
    attempts.push({ stage, url: page.url(), ...result });
    Object.assign(mergedFields, result.fields || {});
    rawMatches = [...rawMatches, ...(result.rawMatches || [])];
    sourceUrl = page.url();
    return result;
  };

  const tryActivityIfUseful = async () => {
    const needsActivity = !mergedFields.inicioAtividade || !mergedFields.caePrincipal || !mergedFields.tipoIva;
    if (!needsActivity) return;
    const moved = await navigateToActivityPage(page).catch(() => false);
    if (moved) await readAndMerge('activity');
  };

  await readAndMerge('current');
  await tryActivityIfUseful();

  // If the browser landed elsewhere after login, try the explicit candidates.
  if (countCollectedFields(mergedFields) === 0) {
    for (const url of urls) {
      if (page.url().replace(/#.*$/, '') === url.replace(/#.*$/, '')) continue;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(options.navigationTimeoutMs || 30_000) || 30_000 });
        await readAndMerge(`candidate:${url}`);
        await tryActivityIfUseful();
        if (countCollectedFields(mergedFields) > 0) break;
      } catch (error) {
        attempts.push({ url, error: String(error?.message || error) });
      }
    }
  }

  // Last safety net: AT pages can load slowly or the user may click the menu manually.
  // Keep watching briefly instead of failing while the correct page is already open.
  const collectTimeoutMs = Math.max(10_000, Math.min(90_000, Number(options.profileCollectTimeoutMs || 45_000) || 45_000));
  const deadline = Date.now() + collectTimeoutMs;
  while (countCollectedFields(mergedFields) === 0 && Date.now() < deadline) {
    await sleep(1500);
    await readAndMerge('watch-current');
    await tryActivityIfUseful();
  }

  // If we only got identification data, do one last activity attempt; for particulares this may legitimately add nothing.
  if (countCollectedFields(mergedFields) > 0) {
    await tryActivityIfUseful();
  }

  return {
    fields: mergedFields,
    sourceUrl,
    rawMatches,
    attempts,
  };
}

module.exports = {
  collectFinancasAtProfile,
};
