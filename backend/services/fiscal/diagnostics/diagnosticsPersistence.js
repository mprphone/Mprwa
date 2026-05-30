'use strict';

const fs = require('fs');
const path = require('path');

const DIAGNOSTICS_DIR = path.resolve(
    process.env.LOCAL_DOCS_ROOT || path.join(process.cwd(), 'customer_documents'),
    '_fiscal_diagnostics'
);

function ensureDiagnosticsDir() {
    try { fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true }); } catch (_) { /* ignore */ }
}

function diagnosticsFilePath(customerId, job) {
    const safeId = String(customerId || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
    const safeJob = String(job || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
    return path.join(DIAGNOSTICS_DIR, `${safeId}_${safeJob}.json`);
}

/**
 * Persists last failure diagnostics for a customer+job pair.
 * Overwrites any previous entry — only the last failure is kept.
 */
function saveFailureDiagnostics(customerId, job, data) {
    try {
        ensureDiagnosticsDir();
        const filePath = diagnosticsFilePath(customerId, job);
        const payload = {
            customerId: String(customerId || ''),
            job: String(job || ''),
            savedAt: new Date().toISOString(),
            ...data,
        };
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
        return filePath;
    } catch (error) {
        console.error('[FiscalDiagnostics] Falha ao guardar diagnóstico:', error?.message || error);
        return null;
    }
}

/**
 * Loads the last failure diagnostics for a customer+job pair.
 * Returns null if no record exists.
 */
function loadFailureDiagnostics(customerId, job) {
    try {
        const filePath = diagnosticsFilePath(customerId, job);
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

/**
 * Clears diagnostics for a customer+job (called after a successful run).
 */
function clearFailureDiagnostics(customerId, job) {
    try {
        const filePath = diagnosticsFilePath(customerId, job);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) { /* ignore */ }
}

/**
 * Lists all stored diagnostics entries.
 * Returns array of { customerId, job, savedAt, filePath }.
 */
function listFailureDiagnostics() {
    try {
        ensureDiagnosticsDir();
        return fs.readdirSync(DIAGNOSTICS_DIR)
            .filter((name) => name.endsWith('.json'))
            .map((name) => {
                const filePath = path.join(DIAGNOSTICS_DIR, name);
                try {
                    const raw = fs.readFileSync(filePath, 'utf8');
                    const data = JSON.parse(raw);
                    return { customerId: data.customerId, job: data.job, savedAt: data.savedAt, filePath };
                } catch (_) {
                    return null;
                }
            })
            .filter(Boolean);
    } catch (_) {
        return [];
    }
}

module.exports = {
    saveFailureDiagnostics,
    loadFailureDiagnostics,
    clearFailureDiagnostics,
    listFailureDiagnostics,
};
