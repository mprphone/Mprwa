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

function parseFieldsFromText(text) {
  const raw = compactSpaces(text);
  const normalized = stripAccents(raw);
  const fields = {};

  const firstMatch = (patterns) => {
    for (const pattern of patterns) {
      const match = raw.match(pattern) || normalized.match(pattern);
      if (match?.[1]) return cleanExtractedValue(match[1]);
    }
    return '';
  };

  const morada = firstMatch([
    /(?:Domic[ií]lio\s+Fiscal|Morada(?:\s+Fiscal)?)\s*[:\-–—]?\s*(.{8,180}?)(?=\s+(?:C[oó]digo|CAE|Atividade|Actividade|Regime|Servi[cç]o|Reparti[cç][aã]o|NIF|Nome)\b|$)/i,
  ]);
  if (morada) fields.morada = morada;

  const inicioAtividade = firstMatch([
    /(?:In[ií]cio\s+de\s+(?:Atividade|Actividade)|Data\s+de\s+In[ií]cio)\s*[:\-–—]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
  ]);
  if (inicioAtividade) fields.inicioAtividade = normalizeDateToIso(inicioAtividade);

  const tipoIva = firstMatch([
    /(?:Regime\s+de\s+IVA|Periodicidade\s+do?\s+IVA|Periodicidade\s+IVA|Tipo\s+de\s+IVA)\s*[:\-–—]?\s*([A-Za-zÀ-ÿ ]{4,60}?)(?=\s+(?:CAE|Atividade|Actividade|Servi[cç]o|Reparti[cç][aã]o|Data|Morada)\b|$)/i,
  ]);
  if (tipoIva) fields.tipoIva = normalizeTipoIva(tipoIva);

  const caePrincipal = firstMatch([
    /(?:CAE\s+Principal|CAE)\s*[:\-–—]?\s*(\d{5})\b/i,
  ]);
  if (caePrincipal) fields.caePrincipal = caePrincipal;

  const codigoReparticaoFinancas = firstMatch([
    /(?:C[oó]digo\s+(?:do\s+)?(?:Servi[cç]o|Reparti[cç][aã]o)\s+(?:de\s+)?Finan[cç]as|Reparti[cç][aã]o\s+de\s+Finan[cç]as|Servi[cç]o\s+de\s+Finan[cç]as)\s*[:\-–—]?\s*(\d{3,5})\b/i,
  ]);
  if (codigoReparticaoFinancas) fields.codigoReparticaoFinancas = codigoReparticaoFinancas;

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
    fields: { ...textFields, ...pairResult.fields },
    rawMatches: pairResult.rawMatches,
    textPreview: compactSpaces(text).slice(0, 500),
  };
}

async function collectFinancasAtProfile(page, options = {}) {
  const urls = resolveCandidateUrls(options);
  const attempts = [];

  const current = await tryReadCurrentPage(page);
  attempts.push({ url: page.url(), ...current });
  if (Object.keys(current.fields).length >= 2) {
    return { fields: current.fields, sourceUrl: page.url(), rawMatches: current.rawMatches, attempts };
  }

  for (const url of urls) {
    if (page.url().replace(/#.*$/, '') === url.replace(/#.*$/, '')) continue;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(options.navigationTimeoutMs || 30_000) || 30_000 });
      const result = await tryReadCurrentPage(page);
      attempts.push({ url: page.url(), ...result });
      if (Object.keys(result.fields).length >= 2) {
        return { fields: result.fields, sourceUrl: page.url(), rawMatches: result.rawMatches, attempts };
      }
    } catch (error) {
      attempts.push({ url, error: String(error?.message || error) });
    }
  }

  const best = attempts
    .filter((attempt) => attempt && attempt.fields)
    .sort((a, b) => Object.keys(b.fields || {}).length - Object.keys(a.fields || {}).length)[0];

  return {
    fields: best?.fields || {},
    sourceUrl: best?.url || page.url(),
    rawMatches: best?.rawMatches || [],
    attempts,
  };
}

module.exports = {
  collectFinancasAtProfile,
};
