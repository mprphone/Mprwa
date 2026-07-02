#!/usr/bin/env node
'use strict';

/**
 * Relatório de tamanho do bundle de produção (Vite).
 *
 * Uso:
 *   node scripts/perf/bundle-report.js            # build + relatório
 *   node scripts/perf/bundle-report.js --no-build # usa o dist/ existente
 *   node scripts/perf/bundle-report.js --save      # grava snapshot em scripts/perf/.snapshots
 *   node scripts/perf/bundle-report.js --diff      # compara com o último snapshot
 *
 * Objetivo: medir o payload de arranque (o que o browser tem de descarregar
 * antes de a app ficar interativa) e detetar regressões de tamanho.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'dist');
const ASSETS_DIR = path.join(DIST_DIR, 'assets');
const SNAP_DIR = path.join(__dirname, '.snapshots');

const args = new Set(process.argv.slice(2));
const shouldBuild = !args.has('--no-build');
const shouldSave = args.has('--save');
const shouldDiff = args.has('--diff');

function kb(bytes) {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

function gzipSize(filePath) {
  return zlib.gzipSync(fs.readFileSync(filePath)).length;
}

function collectAssets() {
  if (!fs.existsSync(ASSETS_DIR)) {
    throw new Error(`Pasta de assets não encontrada: ${ASSETS_DIR}. Corra o build primeiro.`);
  }
  const files = fs.readdirSync(ASSETS_DIR).filter((f) => /\.(js|css)$/.test(f));
  return files
    .map((name) => {
      const full = path.join(ASSETS_DIR, name);
      const raw = fs.statSync(full).size;
      const gzip = gzipSize(full);
      // Um chunk "eager" é o que carrega no arranque: entry + css.
      // Chunks lazy têm hash mas não são referenciados no index.html.
      const kind = name.endsWith('.css') ? 'css' : 'js';
      return { name, kind, raw, gzip };
    })
    .sort((a, b) => b.raw - a.raw);
}

function readIndexHtml() {
  const indexPath = path.join(DIST_DIR, 'index.html');
  return fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
}

function classifyEager(assets, html) {
  // Assets referenciados diretamente no index.html carregam no arranque.
  return assets.map((a) => ({ ...a, eager: html.includes(a.name) }));
}

function totals(assets) {
  const sum = (arr, key) => arr.reduce((acc, a) => acc + a[key], 0);
  const eager = assets.filter((a) => a.eager);
  return {
    files: assets.length,
    rawAll: sum(assets, 'raw'),
    gzipAll: sum(assets, 'gzip'),
    rawEager: sum(eager, 'raw'),
    gzipEager: sum(eager, 'gzip'),
    jsChunks: assets.filter((a) => a.kind === 'js').length,
  };
}

function printReport(assets, t) {
  console.log('\n── Relatório de bundle ───────────────────────────────');
  console.log(`${'ficheiro'.padEnd(34)} ${'tipo'.padEnd(5)} ${'raw'.padStart(11)} ${'gzip'.padStart(11)}  arranque`);
  console.log('─'.repeat(78));
  for (const a of assets) {
    console.log(
      `${a.name.padEnd(34)} ${a.kind.padEnd(5)} ${kb(a.raw).padStart(11)} ${kb(a.gzip).padStart(11)}  ${a.eager ? '●' : '·'}`
    );
  }
  console.log('─'.repeat(78));
  console.log(`Total ficheiros: ${t.files} (${t.jsChunks} chunks JS)`);
  console.log(`Payload de ARRANQUE (●):  ${kb(t.rawEager)} raw · ${kb(t.gzipEager)} gzip`);
  console.log(`Payload total (todos):    ${kb(t.rawAll)} raw · ${kb(t.gzipAll)} gzip`);
  console.log('──────────────────────────────────────────────────────\n');
}

function snapshotPath() {
  return path.join(SNAP_DIR, 'bundle-latest.json');
}

function saveSnapshot(assets, t) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const payload = { timestamp: new Date().toISOString(), totals: t, assets };
  fs.writeFileSync(snapshotPath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Snapshot gravado em ${path.relative(ROOT, snapshotPath())}`);
}

function diffSnapshot(t) {
  const p = snapshotPath();
  if (!fs.existsSync(p)) {
    console.log('Sem snapshot anterior para comparar (corra com --save primeiro).');
    return;
  }
  const prev = JSON.parse(fs.readFileSync(p, 'utf8'));
  const pt = prev.totals;
  const delta = (now, before) => {
    const d = now - before;
    const sign = d > 0 ? '+' : '';
    const pct = before ? ((d / before) * 100).toFixed(1) : '0.0';
    return `${sign}${kb(d)} (${sign}${pct}%)`;
  };
  console.log('── Comparação com snapshot anterior ──────────────────');
  console.log(`De: ${prev.timestamp}`);
  console.log(`Arranque gzip: ${kb(pt.gzipEager)} → ${kb(t.gzipEager)}   ${delta(t.gzipEager, pt.gzipEager)}`);
  console.log(`Total gzip:    ${kb(pt.gzipAll)} → ${kb(t.gzipAll)}   ${delta(t.gzipAll, pt.gzipAll)}`);
  console.log(`Chunks JS:     ${pt.jsChunks} → ${t.jsChunks}`);
  console.log('──────────────────────────────────────────────────────\n');
}

function main() {
  if (shouldBuild) {
    console.log('A compilar (vite build)…');
    const start = Date.now();
    execSync('node ./node_modules/vite/bin/vite.js build', { cwd: ROOT, stdio: 'inherit' });
    console.log(`Build concluído em ${((Date.now() - start) / 1000).toFixed(2)}s`);
  }
  const html = readIndexHtml();
  const assets = classifyEager(collectAssets(), html);
  const t = totals(assets);
  printReport(assets, t);
  if (shouldDiff) diffSnapshot(t);
  if (shouldSave) saveSnapshot(assets, t);
}

main();
