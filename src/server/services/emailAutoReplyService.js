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

function formatPtDate(value) {
    const normalized = normalizeDate(value);
    if (!normalized) return '';
    const [year, month, day] = normalized.split('-');
    return `${day}/${month}/${year}`;
}

const DEFAULT_SUBJECT = 'Ausência temporária';

const DEFAULT_TEMPLATE = [
    'Olá,',
    '',
    'Obrigada pelo seu email.',
    '',
    'Encontro-me ausente até ao dia {{data_fim}}, com acesso limitado ao email.',
    '',
    'Para assuntos urgentes, por favor contacte {{contacto_alternativo_email}}{{contacto_alternativo_telefone}}.',
    '',
    'Responderei assim que possível após o meu regresso.',
    '',
    'Obrigada,',
    '{{nome_funcionario}}',
].join('\n');

const SIMPLE_TEMPLATE = [
    'Olá,',
    '',
    'Obrigada pelo seu email.',
    '',
    'Encontro-me ausente de {{data_inicio}} a {{data_fim}}, com acesso limitado ao email.',
    '',
    'Em caso de urgência, contacte {{contacto_alternativo_email}}.',
    '',
    'Obrigada,',
    '{{nome_funcionario}}',
].join('\n');

function envText(name, fallback) {
    const value = process.env[name];
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    return String(value).replace(/\\n/g, '\n');
}

function normalizeMode(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'plesk_ssh' || raw === 'plesk-api') return raw.replace('-', '_');
    if (raw === 'plesk_api' || raw === 'manual' || raw === 'disabled') return raw;
    return 'manual';
}

function buildContext(input = {}) {
    const phone = String(input.contactoAlternativoTelefone || input.alternateContactPhone || '').trim();
    const email = String(input.contactoAlternativoEmail || input.alternateContactEmail || input.alternateContact || 'geral@mpr.pt').trim();
    const phoneWithPrefix = phone ? ` ou ${phone}` : '';
    return {
        nome_funcionario: String(input.nomeFuncionario || input.funcionarioNome || '').trim() || 'Equipa MPR',
        email_funcionario: String(input.emailFuncionario || input.email || '').trim(),
        data_inicio: formatPtDate(input.dataInicio || input.startDate),
        data_fim: formatPtDate(input.dataFim || input.endDate),
        contacto_alternativo_email: email,
        contacto_alternativo_telefone: phoneWithPrefix,
        motivo: String(input.motivo || 'ausência').trim() || 'ausência',
    };
}

function renderTemplate(template, input = {}) {
    const context = buildContext(input);
    return String(template || DEFAULT_TEMPLATE).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => {
        return context[key] !== undefined ? String(context[key]) : '';
    });
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
        const subject = String(input.subject || DEFAULT_SUBJECT).trim() || DEFAULT_SUBJECT;
        const message = String(input.message || '').trim();
        const endDate = normalizeDate(input.endDate);
        args.push('-subject', subject);
        if (message) args.push('-text', message);
        args.push('-format', 'plain', '-charset', 'UTF-8');
        if (endDate) args.push('-end-date', endDate);
    }

    return args;
}

class ManualAutoReplyProvider {
    constructor(config) {
        this.config = config;
    }

    async enable(input = {}) {
        return {
            ok: true,
            manual: true,
            mode: 'manual',
            actionRequired: 'activate',
            message: 'Ativação manual necessária. Copie a mensagem e configure o autoresponder no Plesk/Webmail.',
            manualUrl: this.config.manualUrl,
            subject: input.subject || this.config.defaultSubject,
            text: input.message || '',
        };
    }

    async disable() {
        return {
            ok: true,
            manual: true,
            mode: 'manual',
            actionRequired: 'deactivate',
            message: 'Desativação manual necessária. Desligue o autoresponder no Plesk/Webmail.',
            manualUrl: this.config.manualUrl,
        };
    }
}

class PleskSshAutoReplyProvider {
    constructor(config) {
        this.config = config;
    }

    async update(input = {}) {
        const email = String(input.email || '').trim().toLowerCase();
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            const error = new Error('Email inválido para configurar auto-reply.');
            error.code = 'INVALID_EMAIL';
            throw error;
        }
        if (!this.config.enabled || this.config.dryRun) {
            return {
                ok: true,
                dryRun: true,
                mode: 'plesk_ssh',
                command: this.previewCommand(input),
                stderr: this.config.enabled ? '' : 'HR_EMAIL_AUTOREPLY_ENABLED não está ativo.',
            };
        }

        const args = [...this.config.prefixArgs, ...buildAutoresponderArgs({ ...input, email })];
        const commandPreview = [this.config.command, ...args].join(' ');
        return new Promise((resolve, reject) => {
            const child = spawn(this.config.command, args, {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => {
                child.kill('SIGTERM');
                const error = new Error(`Timeout ao executar Plesk autoresponder após ${this.config.timeoutMs}ms.`);
                error.code = 'PLESK_AUTORESPONDER_TIMEOUT';
                error.command = commandPreview;
                reject(error);
            }, this.config.timeoutMs);

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
                    resolve({ ok: true, dryRun: false, mode: 'plesk_ssh', command: commandPreview, stdout, stderr });
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

    previewCommand(input = {}) {
        const args = [...this.config.prefixArgs, ...buildAutoresponderArgs(input)];
        return [this.config.command, ...args].join(' ');
    }

    enable(input = {}) {
        return this.update({ ...input, enabled: true });
    }

    disable(input = {}) {
        return this.update({ ...input, enabled: false });
    }
}

class PleskApiAutoReplyProvider {
    async enable() {
        const error = new Error('Provider Plesk API preparado, mas ainda não implementado neste servidor.');
        error.code = 'PLESK_API_NOT_IMPLEMENTED';
        throw error;
    }

    async disable() {
        const error = new Error('Provider Plesk API preparado, mas ainda não implementado neste servidor.');
        error.code = 'PLESK_API_NOT_IMPLEMENTED';
        throw error;
    }
}

class DisabledAutoReplyProvider {
    async enable() {
        return { ok: false, disabled: true, mode: 'disabled', message: 'Auto-reply desativado por configuração.' };
    }

    async disable() {
        return { ok: false, disabled: true, mode: 'disabled', message: 'Auto-reply desativado por configuração.' };
    }
}

function createEmailAutoReplyService(options = {}) {
    const mode = normalizeMode(options.mode || process.env.HR_EMAIL_AUTOREPLY_MODE || 'manual');
    const config = {
        mode,
        enabled: toBool(options.enabled ?? process.env.HR_EMAIL_AUTOREPLY_ENABLED, false),
        dryRun: toBool(options.dryRun ?? process.env.PLESK_AUTORESPONDER_DRY_RUN, false),
        command: String(options.command || process.env.PLESK_AUTORESPONDER_BIN || 'plesk').trim(),
        prefixArgs: Array.isArray(options.prefixArgs)
            ? options.prefixArgs
            : parseJsonArray(process.env.PLESK_AUTORESPONDER_PREFIX_ARGS_JSON || process.env.PLESK_AUTORESPONDER_PREFIX_ARGS),
        timeoutMs: Math.max(5000, Number(options.timeoutMs || process.env.PLESK_AUTORESPONDER_TIMEOUT_MS || 30000) || 30000),
        manualUrl: String(options.manualUrl || process.env.HR_EMAIL_AUTOREPLY_MANUAL_URL || process.env.PLESK_URL || 'https://plesk5100.is.cc:8443').trim(),
        defaultSubject: envText('HR_EMAIL_AUTOREPLY_DEFAULT_SUBJECT', DEFAULT_SUBJECT),
        defaultTemplate: envText('HR_EMAIL_AUTOREPLY_TEMPLATE', DEFAULT_TEMPLATE),
        simpleTemplate: envText('HR_EMAIL_AUTOREPLY_SIMPLE_TEMPLATE', SIMPLE_TEMPLATE),
    };

    const provider = mode === 'plesk_ssh'
        ? new PleskSshAutoReplyProvider(config)
        : mode === 'plesk_api'
            ? new PleskApiAutoReplyProvider(config)
            : mode === 'disabled'
                ? new DisabledAutoReplyProvider(config)
                : new ManualAutoReplyProvider(config);

    return {
        enable(input) {
            return provider.enable(input);
        },
        disable(input) {
            return provider.disable(input);
        },
        generate(input = {}) {
            const templateVariant = String(input.templateVariant || '').trim() === 'simple' ? 'simple' : 'default';
            const template = templateVariant === 'simple' ? config.simpleTemplate : config.defaultTemplate;
            return {
                subject: String(input.subject || config.defaultSubject || DEFAULT_SUBJECT).trim() || DEFAULT_SUBJECT,
                message: renderTemplate(template, input),
                templateVariant,
            };
        },
        getConfig() {
            return { ...config };
        },
    };
}

module.exports = {
    createEmailAutoReplyService,
    renderTemplate,
    DEFAULT_TEMPLATE,
    SIMPLE_TEMPLATE,
};
