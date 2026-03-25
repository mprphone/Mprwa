#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.DB_PATH || 'whatsapp.db';
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:3010';
const FORCE = String(process.env.FORCE || 'false').toLowerCase() === 'true';
const YEARS_BACK = Number(process.env.YEARS_BACK || 3);
const DOC_TYPES = (process.env.DOC_TYPES || 'modelo_22,ies')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const START_INDEX = Math.max(0, Number(process.env.START_INDEX || 0));
const LIMIT = Number(process.env.LIMIT || 0);

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
const outDir = path.resolve('exports');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const logPath = path.join(outDir, `saft_batch_${stamp}.log`);
const noFolderJsonPath = path.join(outDir, `saft_clients_without_folder_${stamp}.json`);
const noFolderCsvPath = path.join(outDir, `saft_clients_without_folder_${stamp}.csv`);
const summaryPath = path.join(outDir, `saft_batch_summary_${stamp}.json`);

function log(line) {
  const message = `[${new Date().toISOString()}] ${line}`;
  fs.appendFileSync(logPath, `${message}\n`);
  process.stdout.write(`${message}\n`);
}

function openDb() {
  return new sqlite3.Database(DB_PATH);
}

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function postJson(urlPath, body) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(`${API_BASE}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

function toCsv(rows) {
  const header = ['id', 'nif', 'name', 'company', 'phone', 'email'];
  const esc = (v) => {
    const s = String(v ?? '');
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  return [header.join(','), ...rows.map((r) => header.map((k) => esc(r[k])).join(','))].join('\n');
}

(async () => {
  const db = openDb();
  try {
    const customers = await dbAll(
      db,
      `select id, source_id, name, company, nif, phone, email, documents_folder
       from customers
       order by coalesce(company, name) collate nocase`
    );

    const noFolder = customers.filter((c) => !String(c.documents_folder || '').trim());
    const withFolderAll = customers.filter((c) => String(c.documents_folder || '').trim());

    fs.writeFileSync(noFolderJsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), total: noFolder.length, rows: noFolder }, null, 2));
    fs.writeFileSync(noFolderCsvPath, toCsv(noFolder));

    let withFolder = withFolderAll.slice(START_INDEX);
    if (LIMIT > 0) withFolder = withFolder.slice(0, LIMIT);

    log(`Total clientes: ${customers.length}`);
    log(`Com pasta: ${withFolderAll.length} | Sem pasta: ${noFolder.length}`);
    log(`Relatório sem pasta: ${noFolderJsonPath}`);
    log(`Lote de execução: ${withFolder.length} (start=${START_INDEX}, limit=${LIMIT || 'ALL'})`);
    log(`Tipos: ${DOC_TYPES.join(', ')} | yearsBack=${YEARS_BACK} | force=${FORCE}`);

    const summary = {
      startedAt: new Date().toISOString(),
      totalCustomers: customers.length,
      withFolderTotal: withFolderAll.length,
      withoutFolderTotal: noFolder.length,
      processed: 0,
      ok: 0,
      failed: 0,
      skippedNoNif: 0,
      totalSyncedFiles: 0,
      failures: [],
      noNif: [],
      outputs: { logPath, noFolderJsonPath, noFolderCsvPath },
    };

    for (let i = 0; i < withFolder.length; i += 1) {
      const c = withFolder[i];
      const label = `${c.company || c.name || c.id} [${c.id}]`;
      const nif = String(c.nif || '').replace(/\D/g, '');

      if (!nif) {
        summary.processed += 1;
        summary.skippedNoNif += 1;
        summary.noNif.push({ id: c.id, name: c.name, company: c.company, phone: c.phone });
        log(`${i + 1}/${withFolder.length} SKIP sem NIF: ${label}`);
        continue;
      }

      const t0 = Date.now();
      let result;
      try {
        result = await postJson('/api/saft/sync-company-docs', {
          customerId: c.id,
          documentTypes: DOC_TYPES,
          yearsBack: YEARS_BACK,
          force: FORCE,
        });

        if (!result.ok && result.status >= 500) {
          await new Promise((r) => setTimeout(r, 1500));
          result = await postJson('/api/saft/sync-company-docs', {
            customerId: c.id,
            documentTypes: DOC_TYPES,
            yearsBack: YEARS_BACK,
            force: FORCE,
          });
        }
      } catch (err) {
        result = { ok: false, status: 0, data: { error: String(err?.message || err) } };
      }

      const ms = Date.now() - t0;
      summary.processed += 1;

      if (result.ok) {
        summary.ok += 1;
        const syncedFiles = Number(result.data?.syncedFiles || 0);
        summary.totalSyncedFiles += syncedFiles;
        const warnCount = Array.isArray(result.data?.warnings) ? result.data.warnings.length : 0;
        log(`${i + 1}/${withFolder.length} OK ${label} | synced=${syncedFiles} warn=${warnCount} t=${ms}ms`);
      } else {
        summary.failed += 1;
        const error = String(result.data?.error || `HTTP ${result.status}`);
        summary.failures.push({ id: c.id, nif, name: c.name, company: c.company, status: result.status, error });
        log(`${i + 1}/${withFolder.length} FAIL ${label} | status=${result.status} | ${error} | t=${ms}ms`);
      }

      if ((i + 1) % 10 === 0) {
        fs.writeFileSync(summaryPath, JSON.stringify({ ...summary, updatedAt: new Date().toISOString() }, null, 2));
      }
    }

    summary.finishedAt = new Date().toISOString();
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    log(`FIM | processed=${summary.processed} ok=${summary.ok} failed=${summary.failed} semNif=${summary.skippedNoNif} synced=${summary.totalSyncedFiles}`);
    log(`Resumo: ${summaryPath}`);
  } catch (error) {
    log(`ERRO FATAL: ${String(error?.message || error)}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();
