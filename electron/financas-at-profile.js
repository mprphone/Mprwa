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
  let cleaned = cleanExtractedValue(value);
  cleaned = cleaned
    .replace(/^Av\.?\s*\/?\s*Rua\s+/i, '')
    .replace(/^Avenida\s*\/?\s*Rua\s+/i, '')
    .replace(/^R\s+RUA\s+/i, 'R ')
    .replace(/^RUA\s+RUA\s+/i, 'RUA ')
    .trim();
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


function normalizeNifValue(value) {
  const digits = String(value || '').replace(/\D+/g, '');
  if (digits.length < 9) return '';
  return digits.slice(-9);
}

function normalizeTipoContabilidade(value) {
  const raw = cleanExtractedValue(value);
  const normalized = normalizeSearchText(raw);
  if (!normalized) return '';
  if (normalized.includes('nao organizada') || normalized.includes('não organizada')) return 'NAO_ORGANIZADA';
  if (normalized.includes('organizada')) return 'ORGANIZADA';
  if (normalized.includes('regime simplificado') || normalized.includes('simplificada') || normalized.includes('simplificado')) return 'SIMPLIFICADO';
  return raw;
}

function normalizeManager(manager) {
  const nif = normalizeNifValue(manager?.nif || manager?.vat || manager?.taxId || '');
  const name = cleanExtractedValue(manager?.name || manager?.nome || '')
    .replace(/\b(?:NIF|Nome|Gerente|Administrador|Administra[cç][aã]o|S[oó]cio)\b/ig, '')
    .replace(/\b\d{9}\b/g, '')
    .trim();
  const email = String(manager?.email || '').trim().toLowerCase();
  const phone = String(manager?.phone || manager?.telefone || '').trim();
  if (!name && !nif && !email && !phone) return null;
  return { name, nif, email, phone };
}

function mergeManagers(existing = [], incoming = []) {
  const out = [];
  const upsert = (manager) => {
    const normalized = normalizeManager(manager);
    if (!normalized) return;
    const key = normalized.nif || normalizeSearchText(normalized.name);
    const foundIndex = out.findIndex((item) => {
      const itemKey = item.nif || normalizeSearchText(item.name);
      return itemKey && key && itemKey === key;
    });
    if (foundIndex >= 0) {
      out[foundIndex] = {
        ...out[foundIndex],
        ...Object.fromEntries(Object.entries(normalized).filter(([, value]) => String(value || '').trim())),
      };
    } else {
      out.push(normalized);
    }
  };
  (Array.isArray(existing) ? existing : []).forEach(upsert);
  (Array.isArray(incoming) ? incoming : []).forEach(upsert);
  return out;
}

function parseManagersFromText(text) {
  const raw = String(text || '');
  if (!/Ger[eê]ncia|Administra[cç][aã]o|Gerente|Administrador|Representante|[ÓO]rg[aã]o Social|Rela[cç][oõ]es Intersujeitos/i.test(raw)) return [];

  const relationRegex = /ger[eê]ncia|gerente|administra[cç][aã]o|administrador|representante|[óo]rg[aã]o social|s[oó]cio gerente|membro/i;
  const headerRegex = /^(NIF|NIPC|Nome|Denomina[cç][aã]o|Tipo|Rela[cç][aã]o|Data|In[ií]cio|Fim|Rela[cç][oõ]es Intersujeitos Passivos)$/i;
  const cleanNameCandidate = (value) => cleanExtractedValue(String(value || '')
    .replace(/\b\d{9}\b/g, '')
    .replace(/Ger[eê]ncia|Administra[cç][aã]o|Gerente|Administrador|Representante Legal|[ÓO]rg[aã]o Social|S[oó]cio Gerente|Membro/ig, '')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b(NIF|NIPC|Nome|Tipo|Rela[cç][aã]o|Data|In[ií]cio|Fim)\b/ig, '')
  );
  const isNameCandidate = (value) => {
    const text = cleanNameCandidate(value);
    if (!text || text.length < 3) return false;
    if (headerRegex.test(text)) return false;
    if (/^[-–—]+$/.test(text)) return false;
    if (/^\d+$/.test(text)) return false;
    return /[A-ZÀ-Ýa-zà-ý]{3,}/.test(text);
  };
  const hasRelationNearNif = (context, nif, maxDistance = 180) => {
    const text = String(context || '');
    const nifIndex = text.indexOf(nif);
    if (nifIndex < 0) return false;
    const windowText = text.slice(Math.max(0, nifIndex - maxDistance), nifIndex + nif.length + maxDistance);
    return relationRegex.test(windowText);
  };

  const managers = [];
  const lines = raw.split(/\n+/).map((line) => compactSpaces(line)).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const nifMatch = lines[index].match(/\b\d{9}\b/);
    if (!nifMatch) continue;
    const contextLines = lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 5));
    const context = contextLines.join(' ');
    if (!hasRelationNearNif(context, nifMatch[0])) continue;

    const nameLine = contextLines.find((line, offset) => {
      const absoluteIndex = Math.max(0, index - 3) + offset;
      if (absoluteIndex === index && line.replace(/\b\d{9}\b/g, '').trim().length < 3) return false;
      if (line.includes(nifMatch[0]) && !/[A-ZÀ-Ýa-zà-ý]{3,}/.test(line.replace(nifMatch[0], ''))) return false;
      if (relationRegex.test(line) && !line.includes(nifMatch[0])) return false;
      return isNameCandidate(line);
    });
    const manager = normalizeManager({ nif: nifMatch[0], name: cleanNameCandidate(nameLine || lines[index]) });
    if (manager) managers.push(manager);
  }

  const relationBlock = extractBlock(raw, /Rela[cç][oõ]es Intersujeitos Passivos/i, [/IBANs\b/i, /Ve[ií]culos\b/i, /Contactos\b/i, /Atividade\s+Exercida\b/i, /Actividade\s+Exercida\b/i]);
  const compact = compactSpaces(relationBlock || raw);
  for (const match of compact.matchAll(/\b\d{9}\b/g)) {
    const nif = match[0];
    const start = match.index || 0;
    const end = start + nif.length;
    const before = compact.slice(Math.max(0, start - 100), start);
    const after = compact.slice(end, Math.min(compact.length, end + 160));
    const context = `${before} ${after}`;
    if (!relationRegex.test(context)) continue;

    let name = firstRegexValue(after, [
      /^\s+([A-ZÀ-Ý][A-ZÀ-Ýa-zà-ý .'’`´,-]{3,}?)(?:\s+(?:Ger[eê]ncia|Gerente|Administra[cç][aã]o|Administrador|Representante|[ÓO]rg[aã]o Social|S[oó]cio Gerente|Membro)\b|\s+\d{4}-\d{1,2}-\d{1,2}|\s+Data\b|$)/i,
    ]);
    if (!name) {
      name = firstRegexValue(before, [
        /([A-ZÀ-Ý][A-ZÀ-Ýa-zà-ý .'’`´,-]{3,}?)\s+(?:NIF|NIPC|$)/i,
      ]);
    }
    const manager = normalizeManager({ nif, name: cleanNameCandidate(name) });
    if (manager) managers.push(manager);
  }

  return mergeManagers([], managers);
}

async function extractManagersFromDom(page) {
  const rows = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('tr')).map((row) =>
      Array.from(row.querySelectorAll('th,td')).map((cell) => normalize(cell.textContent)).filter(Boolean)
    ).filter((cells) => cells.length >= 2);
  }).catch(() => []);

  const managers = [];
  const relationRegex = /ger[eê]ncia|gerente|administra[cç][aã]o|administrador|representante|[óo]rg[aã]o social/i;
  for (const cells of rows) {
    const joined = cells.join(' ');
    if (!relationRegex.test(joined)) continue;
    const nif = normalizeNifValue(joined.match(/\b\d{9}\b/)?.[0] || '');
    if (!nif) continue;
    const candidates = cells.filter((cell) => {
      if (/\b\d{9}\b/.test(cell)) return false;
      if (/\b\d{4}-\d{2}-\d{2}\b/.test(cell)) return false;
      if (relationRegex.test(cell)) return false;
      if (/^(NIF|Nome|Tipo|Rela[cç][aã]o|Data|In[ií]cio|Fim)$/i.test(cell)) return false;
      return /[A-ZÀ-Ýa-zà-ý]{3,}/.test(cell);
    });
    const manager = normalizeManager({ nif, name: candidates[0] || '' });
    if (manager) managers.push(manager);
  }
  return mergeManagers([], managers);
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
  if (dataNascimento) {
    fields.dataNascimento = normalizeDateToIso(dataNascimento);
    fields.tipoEntidadeAt = 'PARTICULAR';
  }

  const dataConstituicao = firstRegexValue(raw, [
    /Data de Constitui[cç][aã]o da Sociedade\s+Data de Dissolu[cç][aã]o da Sociedade\s+Data de Cancelamento da Matr[ií]cula\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
    /Data de Constitui[cç][aã]o(?: da Sociedade)?\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
  ]);
  if (dataConstituicao) {
    fields.dataConstituicao = normalizeDateToIso(dataConstituicao);
    fields.tipoEntidadeAt = 'EMPRESA';
  }
  if (!fields.tipoEntidadeAt && /Dados da Entidade|Natureza Jur[ií]dica|Denomina[cç][aã]o/i.test(raw)) {
    fields.tipoEntidadeAt = 'EMPRESA';
  }

  const activitySource = /Dados Gerais de Atividade|C[oó]digos de Atividade|Atividade em IVA|Actividade em IVA/i.test(raw)
    ? extractBlock(raw, /Atividade Exercida|Actividade Exercida|Dados Gerais de Atividade/i, [/Rela[cç][oõ]es Intersujeitos/i, /IBANs\b/i, /Dados Gerais de Identifica[cç][aã]o/i]) || raw
    : '';

  const inicioAtividade = activitySource ? firstRegexValue(activitySource, [
    /Dados Gerais de Atividade\s+Data de In[ií]cio\s+Tipo de Sujeito Passivo\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
    /Dados Gerais de Atividade\s+Data de In[ií]cio\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
    /Data de In[ií]cio\s+Tipo de Sujeito Passivo\s+(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i,
  ]) : '';
  if (inicioAtividade) fields.inicioAtividade = normalizeDateToIso(inicioAtividade);

  const caePrincipal = activitySource ? firstRegexValue(activitySource, [
    /CAE\s+Principal\s+(\d{5})\b/i,
    /Principal\s+(\d{5})\s+[A-ZÀ-Ý]/i,
  ]) : '';
  if (caePrincipal) fields.caePrincipal = caePrincipal;

  const tipoIva = activitySource ? firstRegexValue(activitySource, [
    /Atividade\s+em\s+IVA\s+Enquadramento\s+Data\s+de\s+Enquadramento\s+Situa[cç][aã]o\s+(.+?)\s+\d{4}-\d{1,2}-\d{1,2}/i,
    /Enquadramento\s+Data\s+de\s+Enquadramento\s+Situa[cç][aã]o\s+(.+?)\s+\d{4}-\d{1,2}-\d{1,2}/i,
    /Atividade\s+em\s+IVA\s+Enquadramento\s+(.+?)\s+Data\s+de\s+Enquadramento/i,
    /Enquadramento\s+(.+?)\s+Data\s+de\s+Enquadramento/i,
  ]) : '';
  if (tipoIva) fields.tipoIva = normalizeTipoIva(tipoIva);

  const tipoContabilidade = activitySource ? firstRegexValue(activitySource, [
    /Contabilidade\s+Tipo de Contabilidade\s+Local de Centraliza[cç][aã]o\s+(.+?)\s+(?:Sede|N[aã]o possui|Morada|Contabilista Certificado|Operador Econ[oó]mico)/i,
    /Tipo de Contabilidade\s+(.+?)\s+Local de Centraliza[cç][aã]o/i,
  ]) : '';
  if (tipoContabilidade) fields.tipoContabilidade = normalizeTipoContabilidade(tipoContabilidade);

  const managers = parseManagersFromText(text);
  if (managers.length) fields.managers = managers;

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
  if (dataNascimento) {
    fields.dataNascimento = normalizeDateToIso(dataNascimento);
    fields.tipoEntidadeAt = 'PARTICULAR';
  }

  const dataConstituicao = findByLabels(['data de constituicao da sociedade', 'data de constituição da sociedade', 'data de constituicao']);
  if (dataConstituicao) {
    fields.dataConstituicao = normalizeDateToIso(dataConstituicao);
    fields.tipoEntidadeAt = 'EMPRESA';
  }

  const inicioAtividade = findByLabels(['inicio de atividade', 'inicio de actividade']);
  if (inicioAtividade) fields.inicioAtividade = normalizeDateToIso(inicioAtividade);

  const tipoIva = findByLabels(['regime de iva', 'periodicidade iva', 'periodicidade do iva', 'tipo de iva']);
  if (tipoIva) fields.tipoIva = normalizeTipoIva(tipoIva);

  const tipoContabilidade = findByLabels(['tipo de contabilidade', 'contabilidade']);
  if (tipoContabilidade) fields.tipoContabilidade = normalizeTipoContabilidade(tipoContabilidade);

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
    'https://sitfiscal.portaldasfinancas.gov.pt/integrada/presentation?queryStringS=targetScreen%3DecraIdentificacao',
    'https://sitfiscal.portaldasfinancas.gov.pt/integrada/presentation?queryStringS=targetScreen%3DecraActividade',
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
  const managersFromDom = await extractManagersFromDom(page).catch(() => []);
  const managers = mergeManagers([...(pairResult.fields?.managers || []), ...(textFields.managers || [])], managersFromDom);
  const fields = { ...pairResult.fields, ...textFields };
  if (managers.length) fields.managers = managers;

  return {
    fields,
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
    const nextDecoded = decoded.replace(/targetScreen=[^&]+/i, 'targetScreen=ecraActividade');
    url.searchParams.set('queryStringS', nextDecoded);
    return url.toString();
  } catch (_) {
    return raw.replace(/targetScreen%3D[^%&]+/i, 'targetScreen%3DecraActividade');
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

function buildIdentificationUrlFromCurrent(urlText) {
  const raw = String(urlText || '').trim();
  if (!raw || !/sitfiscal\.portaldasfinancas\.gov\.pt\/integrada\/presentation/i.test(raw)) return '';
  try {
    const url = new URL(raw);
    const queryString = url.searchParams.get('queryStringS') || '';
    if (!queryString) return '';
    const decoded = decodeURIComponent(queryString);
    if (!/targetScreen=/i.test(decoded)) return '';
    const nextDecoded = decoded.replace(/targetScreen=[^&]+/i, 'targetScreen=ecraIdentificacao');
    url.searchParams.set('queryStringS', nextDecoded);
    return url.toString();
  } catch (_) {
    return raw.replace(/targetScreen%3D[^%&]+/i, 'targetScreen%3DecraIdentificacao');
  }
}

async function navigateToIdentificationPage(page) {
  const directUrl = buildIdentificationUrlFromCurrent(page.url());
  if (directUrl && directUrl !== page.url()) {
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(900).catch(() => null);
    const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (/Dados Gerais de Identifica|Identifica[cç][aã]o do Contribuinte|Moradas|Servi[cç]o de Finan[cç]as Competente/i.test(text)) return true;
  }

  if (await clickIntegratedMenuItem(page, 'Dados Gerais de Identificação')) return true;
  if (await clickIntegratedMenuItem(page, 'Dados Gerais de Identificacao')) return true;
  if (await clickIntegratedMenuItem(page, 'Identificação')) return true;
  if (await clickIntegratedMenuItem(page, 'Identificacao')) return true;
  if (await clickIntegratedMenuItem(page, 'Resumo')) return true;
  return false;
}

async function navigateToActivityPage(page) {
  const looksLikeActivityPage = async () => {
    const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    return /Dados Gerais de Atividade|Atividade Exercida|Actividade Exercida|CAE Principal|Atividade em IVA/i.test(text);
  };

  const directUrl = buildActivityUrlFromCurrent(page.url());
  if (directUrl && directUrl !== page.url() && !/hmac%3D|hmac=/i.test(directUrl)) {
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(900).catch(() => null);
    if (await looksLikeActivityPage()) return true;
  }

  if (await clickIntegratedMenuItem(page, 'Atividade Exercida')) {
    if (await looksLikeActivityPage()) return true;
  }
  if (await clickIntegratedMenuItem(page, 'Actividade Exercida')) {
    if (await looksLikeActivityPage()) return true;
  }

  await page.goto('https://sitfiscal.portaldasfinancas.gov.pt/integrada/presentation', { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
  await page.waitForTimeout(700).catch(() => null);
  if (await clickIntegratedMenuItem(page, 'Atividade Exercida')) {
    if (await looksLikeActivityPage()) return true;
  }
  if (await clickIntegratedMenuItem(page, 'Actividade Exercida')) {
    if (await looksLikeActivityPage()) return true;
  }
  return false;
}

function buildRelationsUrlFromCurrent(urlText) {
  const raw = String(urlText || '').trim();
  if (!raw || !/sitfiscal\.portaldasfinancas\.gov\.pt\/integrada\/presentation/i.test(raw)) return '';
  try {
    const url = new URL(raw);
    const queryString = url.searchParams.get('queryStringS') || '';
    if (!queryString) return '';
    const decoded = decodeURIComponent(queryString);
    if (!/targetScreen=/i.test(decoded)) return '';
    const nextDecoded = decoded.replace(/targetScreen=[^&]+/i, 'targetScreen=ecraListaRelacoes');
    url.searchParams.set('queryStringS', nextDecoded);
    return url.toString();
  } catch (_) {
    return raw.replace(/targetScreen%3D[^%&]+/i, 'targetScreen%3DecraListaRelacoes');
  }
}

async function navigateToRelationsPage(page) {
  if (await clickIntegratedMenuItem(page, 'Relações Intersujeitos Passivos')) return true;
  if (await clickIntegratedMenuItem(page, 'Relacoes Intersujeitos Passivos')) return true;

  await page.goto('https://sitfiscal.portaldasfinancas.gov.pt/integrada/presentation', { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
  await page.waitForTimeout(700).catch(() => null);
  if (await clickIntegratedMenuItem(page, 'Relações Intersujeitos Passivos')) return true;
  if (await clickIntegratedMenuItem(page, 'Relacoes Intersujeitos Passivos')) return true;

  const directUrl = buildRelationsUrlFromCurrent(page.url());
  if (directUrl && directUrl !== page.url()) {
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
    await page.waitForTimeout(900).catch(() => null);
    const text = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    if (/Rela[cç][oõ]es Intersujeitos|Ger[eê]ncia|Administrador|Gerente/i.test(text)) return true;
  }
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
    if (key === 'managers') {
      const managers = mergeManagers(target.managers || [], Array.isArray(rawValue) ? rawValue : []);
      if (managers.length) target.managers = managers;
      return;
    }
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

  const tryIdentificationIfUseful = async () => {
    const isCollective = String(options.expectedEntityKind || '').toUpperCase() === 'EMPRESA' || ['5', '6', '9'].includes(String(options.nif || '')[0] || '');
    const needsBirthDate = !isCollective && !mergedFields.dataNascimento;
    const needsConstitutionDate = isCollective && !mergedFields.dataConstituicao;
    const needsIdentification = !mergedFields.morada || !mergedFields.codigoPostal || !mergedFields.codigoReparticaoFinancas || needsBirthDate || needsConstitutionDate;
    if (!needsIdentification) return;
    const moved = await navigateToIdentificationPage(page).catch(() => false);
    if (moved) await readAndMerge('identification');
  };

  const tryRelationsIfUseful = async () => {
    const isCollective = String(options.expectedEntityKind || '').toUpperCase() === 'EMPRESA' || ['5', '6', '9'].includes(String(options.nif || '')[0] || '');
    if (!isCollective || (Array.isArray(mergedFields.managers) && mergedFields.managers.length > 0)) return;
    const moved = await navigateToRelationsPage(page).catch(() => false);
    if (moved) await readAndMerge('relations');
  };

  await readAndMerge('current');
  await tryIdentificationIfUseful();
  await tryActivityIfUseful();
  await tryRelationsIfUseful();
  await tryIdentificationIfUseful();

  // If the browser landed elsewhere after login, try the explicit candidates.
  if (countCollectedFields(mergedFields) === 0) {
    for (const url of urls) {
      if (page.url().replace(/#.*$/, '') === url.replace(/#.*$/, '')) continue;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(options.navigationTimeoutMs || 30_000) || 30_000 });
        await readAndMerge(`candidate:${url}`);
        await tryIdentificationIfUseful();
        await tryActivityIfUseful();
        await tryRelationsIfUseful();
        await tryIdentificationIfUseful();
        if (countCollectedFields(mergedFields) > 0 && mergedFields.morada && mergedFields.codigoReparticaoFinancas) break;
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
    await tryIdentificationIfUseful();
    await tryActivityIfUseful();
    await tryRelationsIfUseful();
  }

  // If we only got one side of the fiscal profile, do one last pass through both screens.
  if (countCollectedFields(mergedFields) > 0) {
    await tryIdentificationIfUseful();
    await tryActivityIfUseful();
    await tryRelationsIfUseful();
    await tryIdentificationIfUseful();
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
