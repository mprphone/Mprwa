'use strict';

const { spawn } = require('child_process');

function toBool(value, defaultValue = false) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return defaultValue;
    if (['1', 'true', 'yes', 'on', 'sim'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off', 'nao', 'não'].includes(raw)) return false;
    return defaultValue;
}

function parseJsonArray(value) {
    const raw = String(value || '').trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
    } catch (_) {
        return raw.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    }
}

function normalizeDate(value) {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return '';
}

function buildAutoresponderArgs(input = {}) {
    const email = String(input.email || '').trim().toLowerCase();
    const enabled = Boolean(input.enabled);
    const args = [
        'bin',
        process.env.PLESK_AUTORESPONDER_UTILITY || 'autoresponder',
        '--update',
        '-mail',
        email,
        '-status',
        enabled ? 'true' : 'false',
    ];

    if (enabled) {
        const subject = String(input.subject || 'Ausência temporária').trim() || 'Ausência temporária';
        const message = String(input.message || '').trim();
        const endDate = normalizeDate(input.endDate);
        args.push('-subject', subject);
        if (message) args.push('-text', message);
        args.push('-format', 'plain', '-charset', 'UTF-8');
        if (endDate) args.push('-end-date', endDate);
    }

    return args;
}

function createPleskAutoresponderService(options = {}) {
    const logger = options.logger || console;
    const command = String(options.command || process.env.PLESK_AUTORESPONDER_BIN || 'plesk').trim();
    const prefixArgs = Array.isArray(options.prefixArgs)
        ? options.prefixArgs
        : parseJsonArray(process.env.PLESK_AUTORESPONDER_PREFIX_ARGS_JSON || process.env.PLESK_AUTORESPONDER_PREFIX_ARGS);
    const timeoutMs = Math.max(5000, Number(options.timeoutMs || process.env.PLESK_AUTORESPONDER_TIMEOUT_MS || 30000) || 30000);
    const dryRun = toBool(options.dryRun ?? process.env.PLESK_AUTORESPONDER_DRY_RUN, false);
    const enabled = toBool(options.enabled ?? process.env.HR_EMAIL_AUTOREPLY_ENABLED, false);

    async function update(input = {}) {
        const email = String(input.email || '').trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            const error = new Error('Email inválido para configurar auto-reply.');
            error.code = 'INVALID_EMAIL';
            throw error;
        }

        const args = [...prefixArgs, ...buildAutoresponderArgs({ ...input, email })];
        const commandPreview = [command, ...args].join(' ');

        if (!enabled || dryRun) {
            logger.info?.('[HR AutoReply] Dry-run Plesk autoresponder', { enabled, dryRun, command: commandPreview });
            return {
                ok: true,
                dryRun: true,
                command: commandPreview,
                stdout: '',
                stderr: enabled ? '' : 'HR_EMAIL_AUTOREPLY_ENABLED não está ativo.',
            };
        }

        return new Promise((resolve, reject) => {
            const child = spawn(command, args, {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                child.kill('SIGTERM');
                const error = new Error(`Timeout ao executar Plesk autoresponder após ${timeoutMs}ms.`);
                error.code = 'PLESK_AUTORESPONDER_TIMEOUT';
                error.command = commandPreview;
                reject(error);
            }, timeoutMs);

            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
            });
            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            child.on('error', (error) => {
                clearTimeout(timer);
                error.command = commandPreview;
                reject(error);
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve({ ok: true, dryRun: false, command: commandPreview, stdout, stderr });
                    return;
                }
                const error = new Error(`Plesk autoresponder terminou com código ${code}: ${stderr || stdout || 'sem detalhe'}`);
                error.code = 'PLESK_AUTORESPONDER_FAILED';
                error.command = commandPreview;
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            });
        });
    }

    return {
        update,
        enable(input) {
            return update({ ...input, enabled: true });
        },
        disable(input) {
            return update({ ...input, enabled: false });
        },
        getConfig() {
            return { enabled, dryRun, command, prefixArgs, timeoutMs };
        },
    };
}

module.exports = {
    createPleskAutoresponderService,
};
