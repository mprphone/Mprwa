#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function normalizeRoute(rawPath) {
    return String(rawPath || '')
        .split('?')[0]
        .replace(/\/(ext|est)_[a-z]_[^/]+/gi, '/:id')
        .replace(/\/local_[^/]+/gi, '/:id')
        .replace(/\/wa_c_[^/]+/gi, '/:id')
        .replace(/\/conv(?:_wa_c)?_[^/]+/gi, '/:id')
        .replace(/\/ichat(?:_sync)?_[^/]+/gi, '/:id')
        .replace(/\/[0-9a-fA-F]{8,}(?:-[0-9a-fA-F]{4,}){0,4}/g, '/:id')
        .replace(/\/\d+/g, '/:id');
}

function parseAuthEventLine(line) {
    const match = String(line || '').match(/^(\S+) \[([^\]]+)\] (\S+) (\S+)(?: (.*))?$/);
    if (!match) return null;
    const [, timestamp, kind, method, rawRoute, tail = ''] = match;
    const at = Date.parse(timestamp);
    if (!Number.isFinite(at)) return null;
    const fields = {};
    for (const token of tail.split(/\s+/)) {
        const index = token.indexOf('=');
        if (index <= 0) continue;
        fields[token.slice(0, index)] = token.slice(index + 1);
    }
    const legacyVia = String(fields.via || '');
    const via = legacyVia === 'externo(nginx)' ? 'external_proxy'
        : legacyVia === 'interno(local)' ? 'local_direct'
            : legacyVia || 'unknown';
    const source = fields.source || String(fields.xff || '').replace(/,$/, '') || fields.remote || '-';
    const internalKey = fields.internalKey === 'true' ? 'present_legacy'
        : fields.internalKey === 'false' ? 'absent'
            : fields.internalKey || 'unknown';
    return {
        timestamp,
        at,
        kind,
        method,
        route: normalizeRoute(rawRoute),
        via,
        source,
        clientUser: fields.clientUser || '-',
        sessionUser: fields.sessionUser || '-',
        internalKey,
        sessionToken: fields.sessionToken || 'unknown',
        uaHash: fields.uaHash || '-',
        origin: fields.origin || '-',
    };
}

function increment(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
}

function summarize(events) {
    const byKind = new Map();
    const byRoute = new Map();
    const bySource = new Map();
    const byClient = new Map();
    let localBypass = 0;
    let externalBypass = 0;
    for (const event of events) {
        increment(byKind, event.kind);
        increment(byRoute, `${event.kind} ${event.method} ${event.route}`);
        increment(bySource, `${event.kind} ${event.via} ${event.source}`);
        increment(byClient, `${event.kind} client=${event.clientUser} session=${event.sessionUser} ua=${event.uaHash}`);
        if (event.kind === 'bypass' && event.via === 'local_direct') localBypass += 1;
        if (event.kind === 'bypass' && event.via === 'external_proxy') externalBypass += 1;
    }
    return { byKind, byRoute, bySource, byClient, localBypass, externalBypass };
}

function topEntries(map, limit = 20) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function parseArgs(argv) {
    const options = { hours: 24, logPath: path.resolve(process.cwd(), 'logs', 'auth-events.log'), json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--json') options.json = true;
        else if (arg === '--hours' && argv[index + 1]) options.hours = Number(argv[++index]);
        else if (arg.startsWith('--hours=')) options.hours = Number(arg.slice('--hours='.length));
        else if (arg === '--log' && argv[index + 1]) options.logPath = path.resolve(argv[++index]);
        else if (arg.startsWith('--log=')) options.logPath = path.resolve(arg.slice('--log='.length));
    }
    if (!Number.isFinite(options.hours) || options.hours <= 0) options.hours = 24;
    return options;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(options.logPath)) {
        console.error(`Log não encontrado: ${options.logPath}`);
        process.exitCode = 1;
        return;
    }
    const cutoff = Date.now() - options.hours * 60 * 60 * 1000;
    const events = fs.readFileSync(options.logPath, 'utf8')
        .split(/\r?\n/)
        .map(parseAuthEventLine)
        .filter((event) => event && event.at >= cutoff);
    const summary = summarize(events);
    const result = {
        hours: options.hours,
        observations: events.length,
        localBypass: summary.localBypass,
        externalBypass: summary.externalBypass,
        readyToDisableBypass: summary.localBypass === 0 && summary.externalBypass === 0,
        byKind: Object.fromEntries(topEntries(summary.byKind, 50)),
        topRoutes: Object.fromEntries(topEntries(summary.byRoute)),
        topSources: Object.fromEntries(topEntries(summary.bySource)),
        topClients: Object.fromEntries(topEntries(summary.byClient)),
    };
    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    console.log(`Auditoria de autenticação — últimas ${options.hours}h`);
    console.log(`Observações deduplicadas: ${events.length}`);
    console.log(`Bypass local (robôs/processos): ${summary.localBypass}`);
    console.log(`Bypass externo (frontend): ${summary.externalBypass}`);
    console.log(`Pronto para desligar bypass: ${result.readyToDisableBypass ? 'SIM' : 'NÃO'}`);
    for (const [title, values] of [
        ['Modos', summary.byKind],
        ['Rotas principais', summary.byRoute],
        ['Origens principais', summary.bySource],
        ['Clientes identificados', summary.byClient],
    ]) {
        console.log(`\n${title}:`);
        for (const [key, count] of topEntries(values)) console.log(`${String(count).padStart(6)}  ${key}`);
    }
}

if (require.main === module) main();

module.exports = { normalizeRoute, parseAuthEventLine, summarize, parseArgs };
