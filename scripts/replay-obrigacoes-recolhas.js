#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const axios = require('axios');
const {
  classifyDriCmpEnvStatus,
  classifyDmrProcessadoCertaStatus,
  classifySaftEnviadoStatus,
  classifyIvaProcessadoStatus,
  classifyM22ProcessadoStatus,
  classifyRelatorioUnicoStatus,
  parseDatePtToIso,
} = require('../src/server/utils/obrigacoes');

const args = process.argv.slice(2);
const getArg = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  const pref = `${name}=`;
  const found = args.find((arg) => arg.startsWith(pref));
  if (found) return found.slice(pref.length);
  return fallback;
};
const hasArg = (name) => args.includes(name);

const dryRun = hasArg('--dry-run');
const since = getArg('--since', '2026-03-01 00:00:00');
const limit = Number(getArg('--limit', '0')) || 0;
const dbPath = getArg('--db', path.resolve(__dirname, '..', 'whatsapp.db'));
const periodTable = getArg('--period-table', 'clientes_obrigacoes_periodos');
const syncRecolhas = !hasArg('--periodos-only');
const onlyUnsynced = hasArg('--only-unsynced');
const resyncBefore = getArg('--resync-before', '');

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_KEY || process.env.SUPABASE_KEY;
if (!dryRun && (!supabaseUrl || !supabaseKey)) {
  console.error('Faltam VITE_SUPABASE_URL/VITE_SUPABASE_KEY ou SUPABASE_URL/SUPABASE_KEY no .env');
  process.exit(1);
}

const headers = supabaseKey ? {
  apikey: supabaseKey,
  Authorization: `Bearer ${supabaseKey}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
} : {};

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this); }));
}
function clean(value) {
  return String(value || '').trim();
}
function normalizePeriod(row) {
  const tipo = clean(row.periodo_tipo || 'mensal').toLowerCase();
  return {
    tipo,
    ano: Number(row.periodo_ano || 0),
    mes: tipo === 'mensal' ? Number(row.periodo_mes || 0) : null,
    trimestre: tipo === 'trimestral' ? Number(row.periodo_trimestre || 0) : null,
  };
}
function parsePayload(row) {
  try { return row.payload_json ? JSON.parse(row.payload_json) : {}; } catch { return {}; }
}
function isSuccessRow(row) {
  const payload = parsePayload(row);
  const origem = clean(row.origem).toLowerCase();
  const estado = clean(row.estado_codigo || payload.estado || payload.status);
  const estadoAt = clean(payload.estadoAt || payload.estado_at || payload.estadoAT || payload['estado at']);
  const situacao = clean(payload.situacao || payload['situação']);
  const id = Number(row.obrigacao_id || 0);

  let check;
  if (id === 4 || origem.includes('dri')) check = classifyDriCmpEnvStatus(estado);
  else if (id === 3 || origem.includes('dmr')) check = classifyDmrProcessadoCertaStatus(estado, estadoAt);
  else if (id === 10 || id === 11 || origem.includes('iva')) check = classifyIvaProcessadoStatus(estado, situacao);
  else if (id === 20 || origem.includes('safts') || origem === 'goff_saft_robot') check = classifySaftEnviadoStatus(estado);
  else if (id === 18 || origem.includes('relatorio')) check = classifyRelatorioUnicoStatus(estado, estadoAt, payload);
  else if ([6, 8, 12, 13, 22].includes(id) || origem.includes('m22') || origem.includes('ies') || origem.includes('m10') || origem.includes('inventario')) check = classifyM22ProcessadoStatus(estado, estadoAt);
  else check = classifyM22ProcessadoStatus(estado, estadoAt);

  return { ok: !!check?.isSuccess, reason: check?.reason || 'unknown', normalized: check?.normalized || '', payload };
}
function tableUrl(table) {
  return `${supabaseUrl.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(table)}`;
}
function filterParams(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined) params.append(key, 'is.null');
    else params.append(key, `eq.${value}`);
  }
  return params.toString();
}
async function patchRows(table, filters, payload) {
  const url = `${tableUrl(table)}?${filterParams(filters)}`;
  const res = await axios.patch(url, payload, { headers, validateStatus: () => true });
  if (res.status >= 400) throw new Error(`${table} PATCH ${res.status}: ${JSON.stringify(res.data)}`);
  return Array.isArray(res.data) ? res.data.length : 0;
}
async function insertRow(table, payload) {
  const res = await axios.post(tableUrl(table), payload, { headers, validateStatus: () => true });
  if (res.status >= 400) {
    const msg = JSON.stringify(res.data);
    if (String(res.data?.code || '') === '23505' || /duplicate/i.test(msg)) return 0;
    throw new Error(`${table} INSERT ${res.status}: ${msg}`);
  }
  return Array.isArray(res.data) ? res.data.length : 1;
}
async function upsertPeriod(row) {
  const periodo = normalizePeriod(row);
  const filters = {
    cliente_id: clean(row.customer_source_id),
    obrigacao_modelo_id: Number(row.obrigacao_id || 0),
    ano: periodo.ano,
    mes: periodo.tipo === 'mensal' ? periodo.mes : null,
    trimestre: periodo.tipo === 'trimestral' ? periodo.trimestre : null,
  };
  const payload = { estado_id: 4 };
  let updated = await patchRows(periodTable, filters, payload);
  if (updated > 0) return { action: 'updated', count: updated };

  const inserted = await insertRow(periodTable, { ...filters, estado_id: 4 });
  return { action: inserted > 0 ? 'inserted' : 'already_exists', count: inserted };
}
async function upsertRecolhaEstado(row, success) {
  const periodo = normalizePeriod(row);
  const payloadRaw = success.payload || {};
  const entregaRaw = clean(row.data_comprovativo || row.data_recebido || payloadRaw.dataComprovativo || payloadRaw.dataRecebido || payloadRaw.data_recolha || payloadRaw.dataRecolha);
  const entregaParsed = entregaRaw ? parseDatePtToIso(entregaRaw) : null;
  const entrega = entregaParsed
    ? entregaParsed.slice(0, 10)
    : /^\d{4}-\d{2}-\d{2}/.test(entregaRaw)
      ? entregaRaw.slice(0, 10)
      : (periodo.tipo === 'anual' ? clean(row.updated_at || new Date().toISOString()).slice(0, 10) : null);
  const filters = {
    cliente_id: clean(row.customer_source_id),
    obrigacao_modelo_id: Number(row.obrigacao_id || 0),
    ano: periodo.ano,
    mes: periodo.tipo === 'mensal' ? periodo.mes : 0,
    trimestre: periodo.tipo === 'trimestral' ? periodo.trimestre : 0,
  };
  const payload = {
    nif: clean(row.nif),
    obrigacao_nome: clean(row.obrigacao_nome),
    data_entrega: entrega,
    updated_at: new Date().toISOString(),
  };
  let updated = await patchRows('recolhas_estado', filters, payload);
  if (updated > 0) return { action: 'updated', count: updated };
  const inserted = await insertRow('recolhas_estado', {
    ...filters,
    ...payload,
    created_at: new Date().toISOString(),
  });
  return { action: inserted > 0 ? 'inserted' : 'already_exists', count: inserted };
}

(async () => {
  if (!fs.existsSync(dbPath)) throw new Error(`SQLite não encontrado: ${dbPath}`);
  const db = new sqlite3.Database(dbPath);
  const rows = await dbAll(db, `
    SELECT *
    FROM obrigacoes_recolhas
    WHERE datetime(updated_at) >= datetime(?)
      AND customer_source_id IS NOT NULL
      AND TRIM(customer_source_id) <> ''
      ${onlyUnsynced ? "AND (synced_supabase_at IS NULL OR TRIM(synced_supabase_at) = '')" : ''}
      ${resyncBefore ? "AND (synced_supabase_at IS NULL OR synced_supabase_at < ?)" : ''}
      ${limit > 0 ? 'LIMIT ' + limit : ''}
  `, resyncBefore ? [since, resyncBefore] : [since]);

  const selected = [];
  const skipped = { invalid: 0, noPeriod: 0 };
  const byOb = new Map();
  for (const row of rows) {
    const success = isSuccessRow(row);
    const periodo = normalizePeriod(row);
    if (!success.ok) { skipped.invalid += 1; continue; }
    if (!periodo.ano) { skipped.noPeriod += 1; continue; }
    selected.push({ row, success, periodo });
    const key = `${row.obrigacao_id} ${row.obrigacao_nome || ''} ${periodo.ano}/${periodo.mes || 0}/${periodo.trimestre || 0}`;
    byOb.set(key, (byOb.get(key) || 0) + 1);
  }

  console.log(JSON.stringify({ dryRun, since, onlyUnsynced, resyncBefore, localRows: rows.length, toReplay: selected.length, skipped }, null, 2));
  console.table(Array.from(byOb.entries()).map(([periodo, total]) => ({ periodo, total })).slice(0, 50));

  if (dryRun) {
    db.close();
    return;
  }

  let periodUpdated = 0, periodInserted = 0, recolhasUpdated = 0, recolhasInserted = 0, errors = 0;
  const errorSamples = [];
  for (const item of selected) {
    try {
      const p = await upsertPeriod(item.row);
      if (p.action === 'updated') periodUpdated += p.count;
      else if (p.action === 'inserted') periodInserted += p.count;

      if (syncRecolhas) {
        const r = await upsertRecolhaEstado(item.row, item.success);
        if (r.action === 'updated') recolhasUpdated += r.count;
        else if (r.action === 'inserted') recolhasInserted += r.count;
      }

      await dbRun(db, `UPDATE obrigacoes_recolhas SET synced_supabase_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [new Date().toISOString(), item.row.id]);
    } catch (error) {
      errors += 1;
      if (errorSamples.length < 20) {
        errorSamples.push({ id: item.row.id, cliente: item.row.customer_source_id, obrigacao: item.row.obrigacao_id, error: String(error.message || error) });
      }
    }
  }
  console.log(JSON.stringify({ replayed: selected.length, periodUpdated, periodInserted, recolhasUpdated, recolhasInserted, errors, errorSamples }, null, 2));
  db.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
