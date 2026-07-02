#!/usr/bin/env node
'use strict';

/**
 * Benchmark de latência dos endpoints "quentes" (polling).
 *
 * Estes endpoints são chamados repetidamente pelo frontend:
 *   - InternalChat: /api/internal-chat/conversations + /presence  a cada 2s
 *   - Inbox:        /api/chat/conversations/local + /api/chat/messages  a cada 10s
 *   - Employees:    /api/internal-chat/presence  a cada 15s
 *
 * Uso:
 *   node scripts/perf/endpoint-bench.js
 *   BENCH_BASE=http://localhost:3010 BENCH_ITERATIONS=50 node scripts/perf/endpoint-bench.js
 *   node scripts/perf/endpoint-bench.js --user <userId>   # p/ endpoints que pedem userId
 *
 * Mede p50/p95/max e o tamanho médio da resposta (payload que viaja na rede
 * a cada poll). Não faz asserções — é um instrumento de diagnóstico.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE = process.env.BENCH_BASE || 'http://localhost:3010';
const ITERATIONS = Number(process.env.BENCH_ITERATIONS || 30);
const argv = process.argv.slice(2);
const userIdx = argv.indexOf('--user');
const USER_ID = userIdx >= 0 ? argv[userIdx + 1] : (process.env.BENCH_USER || '');

const endpoints = [
  { label: 'chat/conversations/local', path: '/api/chat/conversations/local' },
  { label: 'chat/contacts', path: '/api/chat/contacts' },
  { label: 'internal-chat/conversations', path: `/api/internal-chat/conversations${USER_ID ? `?userId=${encodeURIComponent(USER_ID)}` : ''}` },
  { label: 'internal-chat/presence', path: '/api/internal-chat/presence' },
  { label: 'import/supabase', path: '/api/import/supabase' },
];

function request(urlString) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const start = process.hrtime.bigint();
    const req = lib.get(u, { headers: { Accept: 'application/json' } }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        resolve({ ms, bytes, status: res.statusCode });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function benchEndpoint(ep) {
  const times = [];
  let bytes = 0;
  let status = 0;
  let error = null;
  // warm-up
  try { await request(BASE + ep.path); } catch (e) { /* ignore warm-up */ }
  for (let i = 0; i < ITERATIONS; i += 1) {
    try {
      const r = await request(BASE + ep.path);
      times.push(r.ms);
      bytes = r.bytes;
      status = r.status;
    } catch (e) {
      error = e.message;
      break;
    }
  }
  times.sort((a, b) => a - b);
  return {
    label: ep.label,
    status,
    error,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    max: times[times.length - 1] || 0,
    bytes,
    samples: times.length,
  };
}

async function main() {
  console.log(`\nBenchmark de endpoints — ${BASE} — ${ITERATIONS} iterações\n`);
  console.log(`${'endpoint'.padEnd(32)} ${'http'.padStart(5)} ${'p50'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)}  ${'payload'.padStart(9)}`);
  console.log('─'.repeat(84));
  for (const ep of endpoints) {
    const r = await benchEndpoint(ep);
    if (r.error) {
      console.log(`${r.label.padEnd(32)} ${'ERR'.padStart(5)}  ${r.error}`);
      continue;
    }
    const kb = `${(r.bytes / 1024).toFixed(1)}kB`;
    console.log(
      `${r.label.padEnd(32)} ${String(r.status).padStart(5)} ${r.p50.toFixed(1).padStart(7)}ms ${r.p95.toFixed(1).padStart(7)}ms ${r.max.toFixed(1).padStart(7)}ms  ${kb.padStart(9)}`
    );
  }
  console.log('─'.repeat(84));
  console.log('Nota: payload = bytes transferidos por chamada. Multiplique pela');
  console.log('frequência de polling e nº de clientes para estimar a carga real.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
