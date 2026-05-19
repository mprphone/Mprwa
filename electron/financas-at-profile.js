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


function normalizeAddressValue(value) {
  const cleaned = cleanExtractedValue(value);
  const folded = normalizeSearchText(cleaned);
  if (!cleaned) return '';
  if (folded === 'av rua' || folded === 'av rua rua' || folded === 'avenida rua') return '';
  if (/^av\.?\s*\/?\s*rua\b/i.test(cleaned) && !/\d/.test(cleaned)) return '';
  if (folded === 'morada' || folded === 'localidade' || folded === 'codigo postal') return '';
  if (/^av\.?\s*\/\s*rua$/i.test(cleaned)) return '';
  if (cleaned.length < 5) return '';
  return cleaned;
}

function normalizePostalCodeValue(value) {
  const cleaned = cleanExtractedValue(value);
  if (!cleaned) return '';
  const match = cleaned.match(/\b(\d{4})\s*[- ]\s*(\d{3})(?:\s+(.+))?/);
  if (match) {
    const locality = compactSpaces(match[3] || '');
    return locality ? `${match[1]}-${match[2]} ${locality}` : `${match[1]}-${match[2]}`;
  }
  return /^[-–—]+$/.test(cleaned) ? '' : cleaned;
}


function extractBlock(rawText, startPattern, endPatterns = []) {
  const source = compactSpaces(rawText);
  const startMatch = source.match(startPattern);
  if (!startMatch) return '';
  const startIndex = startMatch.index || 0;
  let endIndex = source.length;
  for (const pattern of endPatterns) {
    const rest = source.slice(startIndex + startMatch[0].length);
    const endMatch = rest.match(pattern);
    if (endMatch && typeof endMatch.index === 'number') {
      endIndex = Math.min(endIndex, startIndex + startMatch[0].length + endMatch.index);
    }
  }
  return source.slice(startIndex, endIndex).trim();
}

function parseAddressFieldsFromText(rawText) {
  const fields = {};
  const block = extractBlock(rawText, /Moradas\b/i, [/Contactos\b/i, /ViaCTT\b/i, /Atividade\s+Exercida\b/i, /Actividade\s+Exercida\b/i]);
  const source = block || rawText;
  const morada = normalizeAddressValue(firstRegexValue(source, [
    /(?:Resid[eê]ncia\s*\([^)]*\)|Sede\s+ou\s+Estabelecimento\s+Est[aá]vel\s*\([^)]*\))\s+Morada\s+(.+?)\s+Localidade\b/i,
    /Morada\s+(.+?)\s+Localidade\b/i,
  ]));
  const postalMatch = source.match(/\b(\d{4})\s*[- ]\s*(\d{3})(?:\s+([A-ZÀ-Ý][A-ZÀ-Ý0-9ªº .,'()\-]+?))?(?=\s+(?:Distrito|Concelho|Freguesia|Data\s+de\s+Produ[cç][aã]o|Contactos|ViaCTT|$))/i);
  const codigoPostal = postalMatch ? normalizePostalCodeValue(postalMatch[0]) : '';

  let localidade = cleanExtractedValue(firstRegexValue(source, [
    /Localidade\s+C[oó]digo Postal\s+(.+?)\s+\d{4}\s*[- ]\s*\d{3}/i,
    /Localidade\s+(.+?)\s+C[oó]digo Postal\s+/i,
    /Localidade\s+(.+?)\s+\d{4}\s*[- ]\s*\d{3}/i,
  ]));
  localidade = localidade.replace(/\bC[oó]digo Postal\b/ig, '').trim();
  if (/^(Distrito|Concelho|Freguesia)$/i.test(localidade)) localidade = '';

  if (morada) fields.morada = [morada, localidade].filter(Boolean).join(', ');
  if (codigoPostal) fields.codigoPostal = codigoPostal;
  return fields;
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
    /Servico de Financas Competente\s+(?:NIF\s+IVA[^0-9]+)?(?:NIF\s+no[^0-9]+)?(\d{3,5})\b/i,
    /Servico de Financas Competente(?:\s+[A-Z][A-Za-z ]+){0,8}\s+(\d{3,5})\b/i,
    /(?:Codigo\s+)?(?:do\s+)?Servico\s+de\s+Financas\s+(\d{3,5})\b/i,
  ]);
  if (codigoReparticaoFinancas) fields.codigoReparticaoFinancas = codigoReparticaoFinancas;

  Object.assign(fields, parseAddressFieldsFromText(raw));

  const dataNascimento = firstRegexValue(raw, [
    /Data de Nascimento\s+Sexo\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
    /Data de Nascimento\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
  ]);
  if (dataNascimento) fields.dataNascimento = normalizeDateToIso(dataNascimento);

  const inicioAtividade = firstRegexValue(raw, [
    /Dados Gerais de Atividade\s+Data de In[ií]cio\s+Tipo de Sujeito Passivo\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
    /Dados Gerais de Atividade\s+Data de In[ií]cio\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
    /Data de In[ií]cio\s+Tipo de Sujeito Passivo\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
    /Data de In[ií]cio\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
  ]);
  if (inicioAtividade) fields.inicioAtividade = normalizeDateToIso(inicioAtividade);

  const caePrincipal = firstRegexValue(raw, [
    /CAE\s+Principal\s+(\d{5})\b/i,
  ]);
  if (caePrincipal) fields.caePrincipal = caePrincipal;

  const tipoIva = firstRegexValue(raw, [
    /Atividade\s+em\s+IVA\s+Enquadramento\s+Data\s+de\s+Enquadramento\s+Situa[cç][aã]o\s+(.+?)\s+\d{4}-\d{1,2}-\d{1,2}/i,
    /Enquadramento\s+Data\s+de\s+Enquadramento\s+Situa[cç][aã]o\s+(.+?)\s+\d{4}-\d{1,2}-\d{1,2}/i,
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

  const morada = normalizeAddressValue(findByLabels(['domicilio fiscal', 'morada fiscal', 'morada']));
  if (morada) fields.morada = morada;

  const codigoPostal = normalizePostalCodeValue(findByLabels(['codigo postal', 'cod postal', 'cp']));
  if (codigoPostal) fields.codigoPostal = codigoPostal;

  const dataNascimento = findByLabels(['data de nascimento', 'nascimento']);
  if (dataNascimento) fields.dataNascimento = normalizeDateToIso(dataNascimento);

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
    'https://sitfiscal.portaldasfinancas.gov.pt/integrada/presentation?queryStringS=targetScreen%3DecrIdentificacao',
    'https://sitfiscal.portaldasfinancas.gov.pt/integrada/presentation?queryStringS=targetScreen%3DecrActividade',
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
    const nextDecoded = decoded.replace(/targetScreen=[^&]+/i, 'targetScreen=ecrActividade');
    url.searchParams.set('queryStringS', nextDecoded);
    return url.toString();
  } catch (_) {
    return raw.replace(/targetScreen%3D[^%&]+/i, 'targetScreen%3DecrActividade');
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



function fieldQuality(key, value) {
  const text = cleanExtractedValue(value);
  if (!text) return 0;
  if (key === 'morada') {
    const address = normalizeAddressValue(text);
    if (!address) return 0;
    let score = address.length;
    if (/\d/.test(address)) score += 20;
    if (/\b(rua|r\.?|avenida|av\.?|travessa|largo|praca|praça|estrada|edificio|n[ºo])\b/i.test(address)) score += 15;
    return score;
  }
  if (key === 'codigoPostal') {
    return /\b\d{4}\s*[- ]\s*\d{3}\b/.test(text) ? 100 + text.length : 0;
  }
  return text.length;
}

function mergeCollectedFields(target, incoming) {
  Object.entries(incoming || {}).forEach(([key, rawValue]) => {
    const value = cleanExtractedValue(rawValue);
    if (!value) return;
    if (key === 'morada') {
      const address = normalizeAddressValue(value);
      if (!address) return;
      if (fieldQuality(key, address) > fieldQuality(key, target[key])) target[key] = address;
      return;
    }
    if (key === 'codigoPostal') {
      const postal = normalizePostalCodeValue(value);
      if (!postal) return;
      if (fieldQuality(key, postal) >= fieldQuality(key, target[key])) target[key] = postal;
      return;
    }
    if (!target[key]) target[key] = value;
  });
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
    mergeCollectedFields(mergedFields, result.fields || {});
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
