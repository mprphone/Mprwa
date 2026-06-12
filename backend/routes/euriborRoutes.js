'use strict';

// Cache em memória: { rates, fetchedAt }
let _cache = null;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

const ECB_BASE = 'https://data-api.ecb.europa.eu/service/data/FM';
const SERIES = {
  '3M':  'M.U2.EUR.RT.MM.EURIBOR3MD_.HSTA',
  '6M':  'M.U2.EUR.RT.MM.EURIBOR6MD_.HSTA',
  '12M': 'M.U2.EUR.RT.MM.EURIBOR1YD_.HSTA',
};

// Headers que imitam um browser para evitar bloqueio da ECB
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/vnd.sdmx.data+json, application/json',
  'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
  'Referer': 'https://www.ecb.europa.eu/',
  'Cache-Control': 'no-cache',
};

async function fetchEcbRate(tenor, key) {
  const url = `${ECB_BASE}/${key}?lastNObservations=1&format=jsondata`;
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`ECB HTTP ${res.status}`);
  const json = await res.json();

  const seriesKey = Object.keys(json.dataSets[0].series)[0];
  const obs = json.dataSets[0].series[seriesKey].observations;
  const obsKeys = Object.keys(obs).sort((a, b) => Number(a) - Number(b));
  const lastIdx = obsKeys[obsKeys.length - 1];
  const rate = obs[lastIdx]?.[0];
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new Error(`ECB devolveu taxa inválida: ${JSON.stringify(rate)}`);
  }
  if (rate < -5 || rate > 50) {
    throw new Error(`ECB taxa fora de intervalo razoável: ${rate}%`);
  }
  const periodValues = json.structure.dimensions.observation[0].values;
  const period = periodValues[Number(lastIdx)]?.id || '';

  return { rate: Math.round(rate * 1000) / 1000, period };
}

// Fallback: scrape euribor-rates.eu
async function fetchFallbackRates() {
  const url = 'https://www.euribor-rates.eu/en/current-euribor-rates/2/euribor-rate-12-months.aspx';
  const res = await fetch(url, {
    headers: { ...BROWSER_HEADERS, Referer: 'https://www.euribor-rates.eu/' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`euribor-rates.eu HTTP ${res.status}`);
  const html = await res.text();

  // Extract rate from table: looks like "2,599 %" or "2.599"
  const match = html.match(/>\s*(-?\d+[,.]?\d*)\s*%?\s*<\/td>/);
  if (!match) throw new Error('Não encontrou taxa em euribor-rates.eu');

  const raw = match[1].replace(',', '.');
  const rate12m = Math.round(Number(raw) * 1000) / 1000;
  const today = new Date().toISOString().slice(0, 7); // YYYY-MM

  return {
    '3M':  { rate: null, period: null, ok: false, error: 'Apenas 12M disponível no fallback' },
    '6M':  { rate: null, period: null, ok: false, error: 'Apenas 12M disponível no fallback' },
    '12M': { rate: rate12m, period: today, ok: true },
  };
}

async function fetchAllRates() {
  const results = await Promise.all(
    Object.entries(SERIES).map(async ([tenor, key]) => {
      try {
        const data = await fetchEcbRate(tenor, key);
        return [tenor, { rate: data.rate, period: data.period, ok: true, source: 'ECB' }];
      } catch (err) {
        console.error(`[Euribor] ECB ${tenor} falhou:`, err.message);
        return [tenor, { rate: null, period: null, ok: false, error: err.message }];
      }
    })
  );
  const ratesObj = Object.fromEntries(results);

  // Se ECB falhou em tudo, tentar fallback
  if (Object.values(ratesObj).every((r) => !r.ok)) {
    console.warn('[Euribor] ECB falhou em todas as taxas, a tentar fallback...');
    try {
      const fallback = await fetchFallbackRates();
      // Merge: usar fallback apenas onde ECB falhou
      for (const t of Object.keys(ratesObj)) {
        if (!ratesObj[t].ok && fallback[t]?.ok) {
          ratesObj[t] = { ...fallback[t], source: 'euribor-rates.eu (fallback)' };
        }
      }
    } catch (fbErr) {
      console.error('[Euribor] Fallback também falhou:', fbErr.message);
    }
  }

  return ratesObj;
}

function registerEuriborRoutes(context) {
  const { app } = context;

  app.get('/api/euribor', async (req, res) => {
    try {
      const now = Date.now();
      if (_cache && (now - _cache.fetchedAt) < CACHE_TTL_MS) {
        return res.json({ success: true, rates: _cache.rates, fetchedAt: _cache.fetchedAt, cached: true });
      }
      const rates = await fetchAllRates();
      _cache = { rates, fetchedAt: now };
      return res.json({ success: true, rates, fetchedAt: now, cached: false });
    } catch (err) {
      console.error('[Euribor] Erro geral:', err.message);
      if (_cache) {
        return res.json({ success: true, rates: _cache.rates, fetchedAt: _cache.fetchedAt, cached: true, stale: true });
      }
      return res.status(502).json({ success: false, error: err.message });
    }
  });

  // Forçar actualização (ignora cache)
  app.post('/api/euribor/refresh', async (req, res) => {
    try {
      const rates = await fetchAllRates();
      _cache = { rates, fetchedAt: Date.now() };
      return res.json({ success: true, rates: _cache.rates, fetchedAt: _cache.fetchedAt });
    } catch (err) {
      return res.status(502).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registerEuriborRoutes };
