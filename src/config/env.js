const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

function toBool(value, defaultValue = false) {
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return defaultValue;
    if (['1', 'true', 'yes', 'on', 'sim'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off', 'nao', 'não'].includes(raw)) return false;
    return defaultValue;
}

function toInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function trim(value, fallback = '') {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
}

function loadEnvConfig() {
    const config = {
        WHATSAPP_PROVIDER: trim(process.env.WHATSAPP_PROVIDER, 'cloud').toLowerCase(),
        TOKEN: trim(process.env.WHATSAPP_TOKEN),
        VERIFY_TOKEN: trim(process.env.VERIFY_TOKEN),
        PHONE_NUMBER_ID: trim(process.env.PHONE_NUMBER_ID),
        WHATSAPP_BAILEYS_AUTH_DIR: path.resolve(process.env.WHATSAPP_BAILEYS_AUTH_DIR || path.join(process.cwd(), '.baileys_auth')),
        WHATSAPP_BAILEYS_ACCOUNTS_JSON: trim(process.env.WHATSAPP_BAILEYS_ACCOUNTS_JSON || process.env.WHATSAPP_BAILEYS_ACCOUNTS),
        WHATSAPP_BAILEYS_DEFAULT_ACCOUNT: trim(process.env.WHATSAPP_BAILEYS_DEFAULT_ACCOUNT, 'default'),
        WHATSAPP_BAILEYS_NAME_CONFLICT_ACCOUNT: trim(process.env.WHATSAPP_BAILEYS_NAME_CONFLICT_ACCOUNT),
        WHATSAPP_BAILEYS_PRINT_QR: toBool(process.env.WHATSAPP_BAILEYS_PRINT_QR, false),
        WHATSAPP_BAILEYS_AUTO_START: toBool(process.env.WHATSAPP_BAILEYS_AUTO_START, true),
        TELEGRAM_BOT_TOKEN: trim(process.env.TELEGRAM_BOT_TOKEN),
        TELEGRAM_WEBHOOK_SECRET: trim(process.env.TELEGRAM_WEBHOOK_SECRET),
        TELEGRAM_WEBHOOK_PATH: trim(process.env.TELEGRAM_WEBHOOK_PATH, '/webhook/telegram'),
        TELEGRAM_USER_API_ID: toInt(process.env.TELEGRAM_USER_API_ID || process.env.TELEGRAM_API_ID, 0),
        TELEGRAM_USER_API_HASH: trim(process.env.TELEGRAM_USER_API_HASH || process.env.TELEGRAM_API_HASH),
        TELEGRAM_USER_SESSION: trim(process.env.TELEGRAM_USER_SESSION),
        TELEGRAM_USER_CHECK_INTERVAL_MS: Math.max(5000, toInt(process.env.TELEGRAM_USER_CHECK_INTERVAL_MS, 5000)),

        SAFT_EMAIL: trim(process.env.EMAIL_SAFT || process.env.Email_saft),
        SAFT_PASSWORD: trim(process.env.SENHA_SAFT || process.env.Senha_saft),
        GOFF_EMAIL: trim(process.env.EMAIL_GOFF || process.env.Email_goff),
        GOFF_PASSWORD: trim(process.env.SENHA_GOFF || process.env.Senha_goff),

        SAFT_ROBOT_SCRIPT: trim(process.env.SAFT_ROBOT_SCRIPT),
        RESEND_API_KEY: trim(process.env.RESEND_API_KEY),
        RESEND_FROM: trim(process.env.RESEND_FROM || process.env.EMAIL_FROM || process.env.SAFT_EMAIL_FROM, 'WA PRO <onboarding@resend.dev>'),

        SMTP_HOST: trim(process.env.SMTP_HOST),
        SMTP_PORT: toInt(process.env.SMTP_PORT, 465),
        SMTP_USERNAME: trim(process.env.SMTP_USERNAME || process.env.SMTP_USER),
        SMTP_PASSWORD: trim(process.env.SMTP_PASSWORD || process.env.SMTP_PASS),
        SMTP_FROM_EMAIL: trim(process.env.SMTP_FROM_EMAIL || process.env.EMAIL_FROM || process.env.SAFT_EMAIL_FROM),
        SMTP_FROM_NAME: trim(process.env.SMTP_FROM_NAME, 'WA PRO'),
        SMTP_CC_FALLBACK: trim(process.env.SMTP_CC_FALLBACK, 'geral@mpr.pt').toLowerCase(),

        ENABLE_WEBHOOK_AUTOREPLY: toBool(process.env.ENABLE_WEBHOOK_AUTOREPLY, false),
        API_PUBLIC_BASE_URL: trim(process.env.API_PUBLIC_BASE_URL).replace(/\/+$/, ''),

        SUPABASE_URL: trim(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL).replace(/\/+$/, ''),
        SUPABASE_KEY: trim(process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY),
        SUPABASE_CLIENTS_SOURCE: trim(process.env.SUPABASE_CLIENTS_SOURCE, 'clientes'),
        SUPABASE_CLIENTS_UPDATED_AT_COLUMN: trim(process.env.SUPABASE_CLIENTS_UPDATED_AT_COLUMN, 'updated_at'),
        SUPABASE_FUNCIONARIOS_SOURCE: trim(process.env.SUPABASE_FUNCIONARIOS_SOURCE, 'funcionarios'),
        SUPABASE_TAREFAS_SOURCE: trim(process.env.SUPABASE_TAREFAS_SOURCE, 'tarefas'),
        SUPABASE_RECOLHAS_ESCOLHA: trim(process.env.SUPABASE_RECOLHAS_ESCOLHA, 'recolhas_estado'),
        SUPABASE_OBRIGACOES_MODELO: trim(process.env.SUPABASE_OBRIGACOES_MODELO, 'obrigacoes_modelo'),
        SUPABASE_OBRIGACOES_PERIODOS_PREFIX: trim(process.env.SUPABASE_OBRIGACOES_PERIODOS_PREFIX, 'clientes_obrigacoes_periodos_'),
        SUPABASE_OCORRENCIAS_SOURCE: trim(process.env.SUPABASE_OCORRENCIAS_SOURCE, 'ocorrencias'),
        SUPABASE_OCORRENCIAS_FOTOS_SOURCE: trim(process.env.SUPABASE_OCORRENCIAS_FOTOS_SOURCE, 'ocorrencias_fotos'),
        SUPABASE_OCORRENCIAS_DOCUMENTOS_SOURCE: trim(process.env.SUPABASE_OCORRENCIAS_DOCUMENTOS_SOURCE, 'ocorrencias_documentos'),
        SUPABASE_TIPOS_OCORRENCIA_SOURCE: trim(process.env.SUPABASE_TIPOS_OCORRENCIA_SOURCE, 'tipos_ocorrencia'),

        SAFT_OBRIGACOES_ROBOT_SCRIPT: trim(process.env.SAFT_OBRIGACOES_ROBOT_SCRIPT, 'scripts/saft-obligations-robot.js'),
        GOFF_OBRIGACOES_ROBOT_SCRIPT: trim(process.env.GOFF_OBRIGACOES_ROBOT_SCRIPT, 'scripts/goff-obrigacoes-robot.js'),

        DRI_OBRIGACAO_ID: toInt(process.env.DRI_OBRIGACAO_ID, 4),
        DMR_OBRIGACAO_ID: toInt(process.env.DMR_OBRIGACAO_ID, 3),
        SAFT_OBRIGACAO_ID: toInt(process.env.SAFT_OBRIGACAO_ID, 20),
        IVA_OBRIGACAO_ID_MENSAL: toInt(process.env.IVA_OBRIGACAO_ID_MENSAL || process.env.IVA_OBRIGACAO_ID, 10),
        IVA_OBRIGACAO_ID_TRIMESTRAL: toInt(process.env.IVA_OBRIGACAO_ID_TRIMESTRAL, 11),
        M22_OBRIGACAO_ID: toInt(process.env.M22_OBRIGACAO_ID, 13),
        IES_OBRIGACAO_ID: toInt(process.env.IES_OBRIGACAO_ID, 6),
        M10_OBRIGACAO_ID: toInt(process.env.M10_OBRIGACAO_ID, 12),
        INVENTARIO_OBRIGACAO_ID: toInt(process.env.INVENTARIO_OBRIGACAO_ID, 0),
        RELATORIO_UNICO_OBRIGACAO_ID: toInt(process.env.RELATORIO_UNICO_OBRIGACAO_ID, 18),

        OBRIGACOES_AUTO_ENABLED: toBool(process.env.OBRIGACOES_AUTO_ENABLED, true),
        OBRIGACOES_AUTO_HOUR: Math.min(23, Math.max(0, toInt(process.env.OBRIGACOES_AUTO_HOUR, 2))),
        OBRIGACOES_AUTO_MINUTE: Math.min(59, Math.max(0, toInt(process.env.OBRIGACOES_AUTO_MINUTE, 0))),
        OBRIGACOES_AUTO_TIMEZONE: trim(process.env.OBRIGACOES_AUTO_TIMEZONE, 'Europe/Lisbon'),
        CUSTOMERS_AUTO_PULL_ENABLED: toBool(process.env.CUSTOMERS_AUTO_PULL_ENABLED, true),
        CUSTOMERS_AUTO_PULL_INTERVAL_MINUTES: Math.min(
            1440,
            Math.max(1, toInt(process.env.CUSTOMERS_AUTO_PULL_INTERVAL_MINUTES, 15))
        ),
        CUSTOMERS_AUTO_PULL_STARTUP_DELAY_SECONDS: Math.min(
            600,
            Math.max(0, toInt(process.env.CUSTOMERS_AUTO_PULL_STARTUP_DELAY_SECONDS, 20))
        ),
        MAX_QUEUE_RETRIES: toInt(process.env.MAX_QUEUE_RETRIES, 5),

        APP_ROLE: trim(process.env.APP_ROLE, 'all').toLowerCase(),
        CHAT_CORE_INTERNAL_URL: trim(process.env.CHAT_CORE_INTERNAL_URL, 'http://127.0.0.1:3012').replace(/\/+$/, ''),

        LOCAL_DOCS_ROOT: path.resolve(process.env.LOCAL_DOCS_ROOT || path.join(process.cwd(), 'customer_documents')),
        DOCS_WINDOWS_PREFIX: trim(process.env.DOCS_WINDOWS_PREFIX),
        DOCS_LINUX_MOUNT: trim(process.env.DOCS_LINUX_MOUNT),
        SAFT_BUNKER_ROOT: path.resolve(
            process.env.SAFT_BUNKER_ROOT ||
            process.env.SAFT_BUNKER_PATH ||
            path.join(process.env.LOCAL_DOCS_ROOT || path.join(process.cwd(), 'customer_documents'), 'bunker_dados_financas')
        ),

        SMTP_TLS: false,
    };

    config.SMTP_TLS = toBool(process.env.SMTP_TLS, config.SMTP_PORT === 465);

    const warnings = [];
    if (!['cloud', 'baileys'].includes(config.WHATSAPP_PROVIDER)) {
        warnings.push(`WHATSAPP_PROVIDER inválido (${config.WHATSAPP_PROVIDER}). Será usado "cloud".`);
        config.WHATSAPP_PROVIDER = 'cloud';
    }
    if (config.WHATSAPP_PROVIDER === 'cloud') {
        if (!config.TOKEN) warnings.push('WHATSAPP_PROVIDER=cloud mas WHATSAPP_TOKEN não definido.');
        if (!config.PHONE_NUMBER_ID) warnings.push('WHATSAPP_PROVIDER=cloud mas PHONE_NUMBER_ID não definido.');
    }
    if (config.ENABLE_WEBHOOK_AUTOREPLY) {
        if (config.WHATSAPP_PROVIDER === 'cloud') {
            if (!config.TOKEN) warnings.push('ENABLE_WEBHOOK_AUTOREPLY=true mas WHATSAPP_TOKEN não definido.');
            if (!config.PHONE_NUMBER_ID) warnings.push('ENABLE_WEBHOOK_AUTOREPLY=true mas PHONE_NUMBER_ID não definido.');
        }
    }
    if (config.TELEGRAM_WEBHOOK_SECRET && !config.TELEGRAM_BOT_TOKEN) {
        warnings.push('TELEGRAM_WEBHOOK_SECRET definido mas TELEGRAM_BOT_TOKEN não configurado.');
    }
    if ((config.TELEGRAM_USER_API_ID && !config.TELEGRAM_USER_API_HASH) || (!config.TELEGRAM_USER_API_ID && config.TELEGRAM_USER_API_HASH)) {
        warnings.push('Configuração Telegram User API incompleta (TELEGRAM_USER_API_ID/TELEGRAM_USER_API_HASH devem estar ambos definidos).');
    }
    if (toInt(process.env.TELEGRAM_USER_CHECK_INTERVAL_MS, 5000) < 5000) {
        warnings.push('TELEGRAM_USER_CHECK_INTERVAL_MS abaixo do mínimo seguro; será usado 5000ms.');
    }
    if ((config.SUPABASE_URL && !config.SUPABASE_KEY) || (!config.SUPABASE_URL && config.SUPABASE_KEY)) {
        warnings.push('Configuração Supabase incompleta (SUPABASE_URL/SUPABASE_KEY devem estar ambos definidos).');
    }
    if ((config.DOCS_WINDOWS_PREFIX && !config.DOCS_LINUX_MOUNT) || (!config.DOCS_WINDOWS_PREFIX && config.DOCS_LINUX_MOUNT)) {
        warnings.push('Mapeamento de documentos incompleto (DOCS_WINDOWS_PREFIX e DOCS_LINUX_MOUNT devem estar ambos definidos).');
    }

    return { config, warnings };
}

module.exports = {
    loadEnvConfig,
};
