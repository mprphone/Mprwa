'use strict';

const fs = require('fs');
const path = require('path');
const { mergeFiscalSummaryData } = require('../services/fiscal/config/fiscalSummaryDefaults');
const { JOB_LABELS, VALID_JOBS, assessFiscalCollectionNeed } = require('../services/fiscal/config/fiscalCollectionPolicy');
const { runFiscalCollector } = require('../services/fiscal');

const FISCAL_FALLBACK_DIR = path.resolve(
    process.env.LOCAL_DOCS_ROOT || path.join(process.cwd(), 'customer_documents'),
    '_recolhas_fiscais'
);

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeJsonParse(value, fallback = {}) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch (_) {
        return fallback;
    }
}

function nowIso() {
    return new Date().toISOString();
}

function createJobId() {
    return `fiscal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeFilePart(value, fallback = 'documento') {
    const clean = String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return clean || fallback;
}

function isWindowsUncPath(value) {
    return /^\\\\[^\\]+\\[^\\]+/.test(String(value || '').trim());
}

function isWindowsDrivePath(value) {
    return /^[A-Za-z]:[\\/]/.test(String(value || '').trim());
}

function normalizeWindowsPathForCompare(value) {
    return String(value || '')
        .trim()
        .replace(/\//g, '\\')
        .replace(/\\+$/, '')
        .toLowerCase();
}

function compactWindowsPathForCompare(value) {
    return normalizeWindowsPathForCompare(value).replace(/[\\/]/g, '');
}

function getWindowsRelativePartAfterPrefix(stored, configuredPrefix) {
    const storedRaw = String(stored || '').trim();
    const prefixRaw = String(configuredPrefix || '').trim();
    const storedNormalized = normalizeWindowsPathForCompare(storedRaw);
    const prefixNormalized = normalizeWindowsPathForCompare(prefixRaw);
    if (storedNormalized === prefixNormalized) return '';
    if (storedNormalized.startsWith(`${prefixNormalized}\\`)) {
        return storedRaw.slice(prefixRaw.length).replace(/^[\\/]+/, '');
    }

    const compactPrefix = compactWindowsPathForCompare(prefixRaw);
    const compactStored = compactWindowsPathForCompare(storedRaw);
    if (!compactPrefix || !compactStored.startsWith(compactPrefix)) return null;

    let consumed = 0;
    let offset = 0;
    while (offset < storedRaw.length && consumed < compactPrefix.length) {
        const char = storedRaw[offset];
        if (char !== '\\' && char !== '/') consumed += 1;
        offset += 1;
    }
    return storedRaw.slice(offset).replace(/^[\\/]+/, '');
}

function decodeProcMountPath(value) {
    return String(value || '')
        .replace(/\\040/g, ' ')
        .replace(/\\011/g, '\t')
        .replace(/\\012/g, '\n')
        .replace(/\\134/g, '\\');
}

function isLinuxMountPointMounted(mountPath) {
    try {
        const target = path.resolve(String(mountPath || '').trim());
        if (!target) return false;
        const mountsRaw = fs.readFileSync('/proc/mounts', 'utf8');
        return mountsRaw
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.split(/\s+/))
            .filter((parts) => parts.length >= 2)
            .map((parts) => path.resolve(decodeProcMountPath(parts[1])))
            .some((mountedPath) => mountedPath === target || target.startsWith(`${mountedPath}${path.sep}`));
    } catch (_) {
        return false;
    }
}

function mapWindowsFolderToLinuxMount(rawFolder) {
    const stored = String(rawFolder || '').trim();
    if (!stored || (!isWindowsUncPath(stored) && !isWindowsDrivePath(stored))) return null;

    const windowsPrefix = normalizeWindowsPathForCompare(process.env.DOCS_WINDOWS_PREFIX);
    const linuxMount = String(process.env.DOCS_LINUX_MOUNT || '').trim();
    if (!windowsPrefix || !linuxMount || !isLinuxMountPointMounted(linuxMount)) return null;

    const relativePart = getWindowsRelativePartAfterPrefix(stored, process.env.DOCS_WINDOWS_PREFIX);
    if (relativePart === null) return null;

    const segments = relativePart.split(/[\\/]+/).filter(Boolean);
    return path.resolve(linuxMount, ...segments);
}

function resolveCustomerDocumentsFolder(customer) {
    const storedFolder = cleanText(customer?.documentsFolder || customer?.documents_folder || '');
    if (storedFolder) {
        if (storedFolder.startsWith('~')) {
            return path.resolve(process.env.HOME || process.cwd(), storedFolder.slice(1));
        }
        const mappedWindowsFolder = mapWindowsFolderToLinuxMount(storedFolder);
        if (mappedWindowsFolder) return mappedWindowsFolder;
        if (path.isAbsolute(storedFolder) && !isWindowsUncPath(storedFolder) && !isWindowsDrivePath(storedFolder)) {
            return path.normalize(storedFolder);
        }
    }
    return path.resolve(FISCAL_FALLBACK_DIR, safeFilePart(customer?.id || customer?.nif || 'cliente'));
}

function resolveFiscalFilePath(customer, requestedPath) {
    const raw = String(requestedPath || '').trim();
    if (!raw) return null;

    const rootFolder = resolveCustomerDocumentsFolder(customer);
    if (!rootFolder) return null;

    let candidate = null;
    if (isWindowsUncPath(raw) || isWindowsDrivePath(raw)) {
        candidate = mapWindowsFolderToLinuxMount(raw);
    } else if (path.isAbsolute(raw)) {
        candidate = path.normalize(raw);
    } else {
        candidate = path.resolve(rootFolder, raw);
    }
    if (!candidate) return null;

    const root = path.resolve(rootFolder);
    const resolved = path.resolve(candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
    return resolved;
}

function registerFiscalSummaryRoutes({ app, dbRunAsync, dbGetAsync, dbAllAsync, port, sendEmailWithAttachment, hasEmailProvider }) {
    let workerBootstrapped = false;
    let workerRunning = false;

    async function ensureTables() {
        await dbRunAsync(`
            CREATE TABLE IF NOT EXISTS customer_fiscal_summary (
                customer_id TEXT PRIMARY KEY,
                data        TEXT NOT NULL DEFAULT '{}',
                updated_at  TEXT NOT NULL
            )
        `);
        await dbRunAsync(`
            CREATE TABLE IF NOT EXISTS fiscal_collection_jobs (
                id              TEXT PRIMARY KEY,
                customer_id     TEXT NOT NULL,
                job             TEXT NOT NULL,
                status          TEXT NOT NULL,
                requested_at    TEXT NOT NULL,
                started_at      TEXT,
                finished_at     TEXT,
                next_attempt_at TEXT NOT NULL,
                attempts        INTEGER NOT NULL DEFAULT 0,
                force           INTEGER NOT NULL DEFAULT 0,
                message         TEXT,
                error           TEXT,
                result_json     TEXT,
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            )
        `);
        await dbRunAsync(`
            CREATE INDEX IF NOT EXISTS idx_fiscal_collection_jobs_status_next
            ON fiscal_collection_jobs(status, next_attempt_at)
        `);
        await dbRunAsync(`
            CREATE INDEX IF NOT EXISTS idx_fiscal_collection_jobs_customer
            ON fiscal_collection_jobs(customer_id, requested_at)
        `);
        await dbRunAsync(`
            CREATE TABLE IF NOT EXISTS fiscal_collection_logs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id      TEXT NOT NULL,
                customer_id TEXT NOT NULL,
                job         TEXT NOT NULL,
                level       TEXT NOT NULL,
                message     TEXT NOT NULL,
                details     TEXT,
                created_at  TEXT NOT NULL
            )
        `);
        await dbRunAsync(`
            CREATE TABLE IF NOT EXISTS fiscal_email_log (
                id TEXT PRIMARY KEY,
                customer_id TEXT NOT NULL,
                sent_to TEXT NOT NULL,
                subject TEXT,
                sent_at TEXT,
                read_at TEXT,
                token TEXT UNIQUE,
                attachment_count INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            )
        `);
    }

    const tablesReady = ensureTables().catch((err) => console.error('[FiscalSummary] Erro ao criar tabelas:', err));

    async function readSummary(customerId) {
        await tablesReady;
        const row = await dbGetAsync('SELECT data FROM customer_fiscal_summary WHERE customer_id = ?', [customerId]);
        return mergeFiscalSummaryData(safeJsonParse(row?.data, {}));
    }

    async function readCustomer(customerId) {
        await tablesReady;
        const row = await dbGetAsync(
            'SELECT id, name, nif, niss, type, documents_folder AS documentsFolder, customer_profile_json AS customerProfileJson FROM customers WHERE id = ?',
            [customerId]
        ).catch(() => null);
        if (!row) return null;
        let profile = {};
        try { profile = JSON.parse(row.customerProfileJson || '{}'); } catch (_) {}
        return { ...row, certidaoPermanenteNumero: profile.certidaoPermanenteNumero || '', customerProfileJson: undefined };
    }

    async function writeSummary(customerId, updater) {
        const current = await readSummary(customerId);
        const patch = typeof updater === 'function' ? updater(current) : updater;
        const merged = mergeFiscalSummaryData({
            ...current,
            ...(patch && typeof patch === 'object' ? patch : {}),
            updatedAt: nowIso(),
        });
        await dbRunAsync(
            `INSERT INTO customer_fiscal_summary (customer_id, data, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(customer_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
            [customerId, JSON.stringify(merged), merged.updatedAt]
        );
        return merged;
    }

    async function logJob(jobRow, level, message, details = null) {
        const at = nowIso();
        try {
            await dbRunAsync(
                `INSERT INTO fiscal_collection_logs (job_id, customer_id, job, level, message, details, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    jobRow.id,
                    jobRow.customer_id,
                    jobRow.job,
                    String(level || 'info'),
                    String(message || ''),
                    details ? JSON.stringify(details) : null,
                    at,
                ]
            );
        } catch (err) {
            console.error('[FiscalSummary] logJob falhou:', err?.message || err);
        }
    }

    async function enqueueFiscalJob({ customerId, job, force = false }) {
        await tablesReady;
        const existing = await dbGetAsync(
            `SELECT id, status, requested_at
             FROM fiscal_collection_jobs
             WHERE customer_id = ? AND job = ? AND status IN ('queued', 'processing')
             ORDER BY requested_at DESC LIMIT 1`,
            [customerId, job]
        );
        if (existing) {
            return { reused: true, jobId: existing.id, message: `${JOB_LABELS[job]} já está em fila ou em execução.` };
        }

        const id = createJobId();
        const at = nowIso();
        await dbRunAsync(
            `INSERT INTO fiscal_collection_jobs
             (id, customer_id, job, status, requested_at, next_attempt_at, attempts, force, message, created_at, updated_at)
             VALUES (?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?)`,
            [id, customerId, job, at, at, force ? 1 : 0, 'Em lista de espera.', at, at]
        );
        const row = { id, customer_id: customerId, job };
        await logJob(row, 'info', `${JOB_LABELS[job]} colocado em lista de espera.`, { force });
        return { reused: false, jobId: id, message: `${JOB_LABELS[job]} colocado em lista de espera.` };
    }

    async function processNextFiscalJob() {
        if (workerRunning) return;
        await tablesReady;
        const row = await dbGetAsync(
            `SELECT *
             FROM fiscal_collection_jobs
             WHERE status IN ('queued', 'retry')
               AND datetime(next_attempt_at) <= datetime('now')
             ORDER BY requested_at ASC
             LIMIT 1`
        );
        if (!row) return;

        workerRunning = true;
        const startedAt = nowIso();
        try {
            await dbRunAsync(
                `UPDATE fiscal_collection_jobs
                 SET status = 'processing', started_at = COALESCE(started_at, ?), attempts = attempts + 1,
                     message = ?, updated_at = ?
                 WHERE id = ?`,
                [startedAt, 'Recolha em execução.', startedAt, row.id]
            );
            await logJob(row, 'info', 'Recolha iniciada.');
            const summaryData = await readSummary(row.customer_id);
            const customer = await readCustomer(row.customer_id);
            const JOB_TIMEOUT_MS = 420_000;
            const result = await Promise.race([
                runFiscalCollector({
                    customerId: row.customer_id,
                    job: row.job,
                    port,
                    customer,
                    summaryData,
                    log: (level, message, details) => logJob(row, level, message, details),
                    updateSummary: (updater) => writeSummary(row.customer_id, updater),
                }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Job excedeu o tempo limite de recolha.')), JOB_TIMEOUT_MS)
                ),
            ]);

            const status = result?.status === 'completed' ? 'completed' : result?.status === 'skipped' ? 'skipped' : 'needs_review';
            const finishedAt = nowIso();
            await writeSummary(row.customer_id, (current) => ({
                ...current,
                collections: {
                    ...(current.collections || {}),
                    [row.job]: {
                        status,
                        requestedAt: row.requested_at,
                        startedAt,
                        completedAt: status === 'completed' || status === 'needs_review' ? finishedAt : current.collections?.[row.job]?.completedAt,
                        message: result?.message || '',
                        jobId: row.id,
                    },
                },
            }));
            await dbRunAsync(
                `UPDATE fiscal_collection_jobs
                 SET status = ?, finished_at = ?, message = ?, error = NULL, result_json = ?, updated_at = ?
                 WHERE id = ?`,
                [status, finishedAt, result?.message || 'Recolha concluída.', JSON.stringify(result || {}), finishedAt, row.id]
            );
            await logJob(row, status === 'completed' ? 'info' : 'warn', result?.message || 'Recolha concluída.');
        } catch (error) {
            const attempts = Number(row.attempts || 0) + 1;
            const canRetry = attempts < 3;
            const finishedAt = nowIso();
            const nextAttempt = new Date(Date.now() + Math.min(30, attempts * 5) * 60_000).toISOString();
            await dbRunAsync(
                `UPDATE fiscal_collection_jobs
                 SET status = ?, finished_at = ?, next_attempt_at = ?, message = ?, error = ?, updated_at = ?
                 WHERE id = ?`,
                [
                    canRetry ? 'retry' : 'failed',
                    finishedAt,
                    canRetry ? nextAttempt : finishedAt,
                    canRetry ? 'Falhou; nova tentativa agendada.' : 'Falhou definitivamente.',
                    String(error?.message || error),
                    finishedAt,
                    row.id,
                ]
            );
            await writeSummary(row.customer_id, (current) => ({
                ...current,
                collections: {
                    ...(current.collections || {}),
                    [row.job]: {
                        status: canRetry ? 'retry' : 'failed',
                        requestedAt: row.requested_at,
                        startedAt,
                        completedAt: '',
                        message: String(error?.message || error),
                        jobId: row.id,
                    },
                },
            }));
            await logJob(row, 'error', String(error?.message || error));
        } finally {
            workerRunning = false;
            setImmediate(() => void processNextFiscalJob().catch((err) => console.error('[FiscalSummary] Worker:', err?.message || err)));
        }
    }

    async function cleanupOldJobs() {
        try {
            await dbRunAsync(
                `DELETE FROM fiscal_collection_jobs
                 WHERE status IN ('completed', 'failed', 'skipped', 'needs_review')
                   AND datetime(updated_at) < datetime('now', '-30 days')`
            );
            await dbRunAsync(
                `DELETE FROM fiscal_collection_logs
                 WHERE datetime(created_at) < datetime('now', '-30 days')
                   AND job_id NOT IN (SELECT id FROM fiscal_collection_jobs)`
            );
        } catch (err) {
            console.error('[FiscalSummary] Limpeza de jobs antigos falhou:', err?.message || err);
        }
    }

    function bootstrapFiscalWorker() {
        if (workerBootstrapped) return;
        workerBootstrapped = true;
        setInterval(() => {
            void processNextFiscalJob().catch((error) => console.error('[FiscalSummary] Worker:', error?.message || error));
        }, 12_000);
        setInterval(() => void cleanupOldJobs(), 24 * 60 * 60_000);
        setTimeout(() => void processNextFiscalJob().catch(() => null), 3000);
    }

    bootstrapFiscalWorker();

    app.get('/api/customers/:id/fiscal-summary', async (req, res) => {
        try {
            res.setHeader('Cache-Control', 'no-store');
            const customerId = String(req.params.id || '').trim();
            if (!customerId) return res.status(400).json({ success: false, error: 'ID inválido.' });
            const data = await readSummary(customerId);
            const jobs = await dbAllAsync(
                `SELECT id, job, status, requested_at, started_at, finished_at, attempts, message, error, updated_at
                 FROM fiscal_collection_jobs
                 WHERE customer_id = ?
                 ORDER BY requested_at DESC
                 LIMIT 20`,
                [customerId]
            );
            return res.json({ success: true, data, jobs });
        } catch (err) {
            console.error('[FiscalSummary] GET error:', err);
            return res.status(500).json({ success: false, error: String(err?.message || err) });
        }
    });

    app.get('/api/customers/:id/fiscal-summary/logs', async (req, res) => {
        try {
            res.setHeader('Cache-Control', 'no-store');
            const customerId = String(req.params.id || '').trim();
            const rows = await dbAllAsync(
                `SELECT *
                 FROM fiscal_collection_logs
                 WHERE customer_id = ?
                 ORDER BY id DESC
                 LIMIT 100`,
                [customerId]
            );
            return res.json({ success: true, logs: rows });
        } catch (err) {
            return res.status(500).json({ success: false, error: String(err?.message || err) });
        }
    });

    app.get('/api/customers/:id/fiscal-summary/file', async (req, res) => {
        try {
            const customerId = String(req.params.id || '').trim();
            const requestedPath = String(req.query.path || req.query.file || '').trim();
            if (!customerId || !requestedPath) {
                return res.status(400).json({ success: false, error: 'Ficheiro fiscal inválido.' });
            }

            const customer = await readCustomer(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const fullPath = resolveFiscalFilePath(customer, requestedPath);
            if (!fullPath) {
                return res.status(400).json({ success: false, error: 'Ficheiro fora da pasta do cliente.' });
            }

            const stat = await fs.promises.stat(fullPath).catch(() => null);
            if (!stat || !stat.isFile()) {
                return res.status(404).json({ success: false, error: 'Ficheiro não encontrado.' });
            }

            const filename = path.basename(fullPath);
            const isPdf = filename.toLowerCase().endsWith('.pdf');
            const disposition = req.query.download === '1' ? 'attachment' : 'inline';
            res.setHeader('Content-Type', isPdf ? 'application/pdf' : 'application/octet-stream');
            res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(filename)}"`);
            return res.sendFile(fullPath);
        } catch (err) {
            console.error('[FiscalSummary] File error:', err);
            return res.status(500).json({ success: false, error: String(err?.message || err) });
        }
    });

    app.post('/api/customers/:id/fiscal-summary/recolher/:job', async (req, res) => {
        try {
            const customerId = String(req.params.id || '').trim();
            const job = String(req.params.job || '').trim();
            const force = req.body?.force === true || req.query.force === '1';
            if (!customerId || !VALID_JOBS.includes(job)) {
                return res.status(400).json({ success: false, error: 'Parâmetros inválidos.' });
            }

            const data = await readSummary(customerId);
            const customer = await readCustomer(customerId);
            const assessment = assessFiscalCollectionNeed(job, data, { customer });
            if (!force && assessment.requiresConfirmation) {
                return res.json({
                    success: false,
                    requiresConfirmation: true,
                    job,
                    message: assessment.reason,
                });
            }
            if (!force && assessment.shouldCollect === false) {
                return res.json({ success: true, skipped: true, job, message: assessment.reason });
            }

            const queued = await enqueueFiscalJob({ customerId, job, force });
            setTimeout(() => void processNextFiscalJob().catch((error) => {
                console.error('[FiscalSummary] Worker imediato:', error?.message || error);
            }), 100);
            return res.json({ success: true, queued: true, ...queued });
        } catch (err) {
            console.error('[FiscalSummary] Recolha error:', err);
            return res.status(500).json({ success: false, error: String(err?.message || err) });
        }
    });

    app.post('/api/customers/:id/fiscal-summary', async (req, res) => {
        try {
            const customerId = String(req.params.id || '').trim();
            if (!customerId) return res.status(400).json({ success: false, error: 'ID inválido.' });
            const incoming = req.body?.data;
            if (!incoming || typeof incoming !== 'object') {
                return res.status(400).json({ success: false, error: 'Dados inválidos.' });
            }
            const merged = await writeSummary(customerId, incoming);
            return res.json({ success: true, data: merged });
        } catch (err) {
            console.error('[FiscalSummary] POST error:', err);
            return res.status(500).json({ success: false, error: String(err?.message || err) });
        }
    });

    // Pixel de rastreio de leitura
    app.get('/api/fiscal-email-track/:token', async (req, res) => {
        const { token } = req.params;
        try {
            const readAt = new Date().toISOString();
            // Só registar na primeira abertura
            const existing = await dbGetAsync('SELECT id, customer_id, read_at FROM fiscal_email_log WHERE token = ?', [token]);
            if (existing && !existing.read_at) {
                await dbRunAsync(
                    `UPDATE fiscal_email_log SET read_at = ? WHERE token = ?`,
                    [readAt, token]
                );
                // Registar no log de recolhas
                const readAtPt = new Date(readAt).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
                await dbRunAsync(
                    `INSERT INTO fiscal_collection_logs (job_id, customer_id, job, level, message, details, created_at)
                     VALUES (?, ?, 'email', 'info', ?, ?, ?)`,
                    [
                        `read_${token.slice(0, 8)}`,
                        existing.customer_id,
                        `Email aberto pelo cliente`,
                        JSON.stringify({ token }),
                        readAt,
                    ]
                ).catch(() => null);
            }
        } catch (_) {}
        const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.setHeader('Content-Type', 'image/gif');
        res.setHeader('Cache-Control', 'no-store');
        return res.send(pixel);
    });

    // Histórico de emails enviados a um cliente
    app.get('/api/customers/:id/fiscal-summary/email-log', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false });
        try {
            const logs = await dbAllAsync(
                `SELECT id, sent_to, subject, sent_at, read_at, attachment_count FROM fiscal_email_log WHERE customer_id = ? ORDER BY sent_at DESC LIMIT 20`,
                [customerId]
            );
            return res.json({ success: true, logs });
        } catch (err) {
            return res.status(500).json({ success: false, error: String(err?.message) });
        }
    });

    // ── Enviar documentos ao cliente por email ────────────────────────────────
    app.post('/api/customers/:id/fiscal-summary/send-email', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) return res.status(400).json({ success: false, error: 'ID inválido.' });
        if (!hasEmailProvider || !hasEmailProvider()) {
            return res.status(503).json({ success: false, error: 'Serviço de email não configurado.' });
        }
        const { to, subject, html, attachmentPaths } = req.body || {};
        if (!to || !subject) return res.status(400).json({ success: false, error: 'Destinatário e assunto obrigatórios.' });

        try {
            const fsNode = require('fs');
            const pathNode = require('path');
            const crypto = require('crypto');

            // Verificar e carregar os PDFs (só paths absolutos com extensão .pdf)
            const attachments = [];
            if (Array.isArray(attachmentPaths)) {
                for (const filePath of attachmentPaths) {
                    const raw = String(filePath || '').trim();
                    if (!raw || !pathNode.isAbsolute(raw)) continue;
                    const safe = pathNode.normalize(raw);
                    if (!safe.endsWith('.pdf') && !safe.endsWith('.PDF')) continue;
                    if (!fsNode.existsSync(safe)) continue;
                    const content = fsNode.readFileSync(safe);
                    attachments.push({
                        filename: pathNode.basename(safe),
                        content,
                        contentType: 'application/pdf',
                    });
                }
            }

            // Token único para pixel de rastreio
            const token = crypto.randomBytes(16).toString('hex');
            const baseUrl = String(process.env.APP_BASE_URL || 'https://wa.mpr.pt').replace(/\/$/, '');
            const trackUrl = `${baseUrl}/api/fiscal-email-track/${token}`;

            // HTML com pixel de tracking (sem logo externo — bloqueado por alguns clientes de email)
            const htmlBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;max-width:600px">
                ${String(html || '').replace(/\n/g, '<br/>')}
                <br/><br/><hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0"/>
                <p style="font-size:11px;color:#94a3b8;margin:0">MPR Negócios, Lda · geral@mpr.pt</p>
                <img src="${trackUrl}" width="1" height="1" style="display:none" alt=""/>
            </div>`;

            await sendEmailWithAttachment({
                to: String(to).trim(),
                subject: String(subject).trim(),
                html: htmlBody,
                fromName: 'MPR Negócios, Lda',
                attachments,
            });

            // Guardar no log
            const logId = crypto.randomBytes(8).toString('hex');
            const sentAt = new Date().toISOString();
            await dbRunAsync(
                `INSERT INTO fiscal_email_log (id, customer_id, sent_to, subject, sent_at, token, attachment_count)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [logId, customerId, String(to).trim(), String(subject).trim(), sentAt, token, attachments.length]
            ).catch(() => null);

            // Registar no log de recolhas (visível no "Log Recente")
            const sentAtPt = new Date(sentAt).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            await dbRunAsync(
                `INSERT INTO fiscal_collection_logs (job_id, customer_id, job, level, message, details, created_at)
                 VALUES (?, ?, 'email', 'info', ?, ?, ?)`,
                [
                    logId,
                    customerId,
                    `Email enviado para ${String(to).trim()} (${attachments.length} anexo(s))`,
                    JSON.stringify({ to: String(to).trim(), subject: String(subject).trim(), attachmentCount: attachments.length, token }),
                    sentAt,
                ]
            ).catch(() => null);

            console.error(`[FiscalEmail] Email enviado para ${to} com ${attachments.length} anexo(s). Token: ${token}`);
            return res.json({ success: true, attachmentCount: attachments.length, sentAt, logId });
        } catch (err) {
            console.error('[FiscalEmail] Erro:', err?.message);
            return res.status(500).json({ success: false, error: String(err?.message || err) });
        }
    });
}

module.exports = { registerFiscalSummaryRoutes };
