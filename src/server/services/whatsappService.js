function createWhatsAppService(deps) {
    const {
        activeProvider,
        accountConfigs,
        accountsById,
        defaultAccountId,
        baileysGateways,
        resolveOutboundAccountIdForPhone,
    } = deps;

    function isBaileysProviderEnabled() {
        return activeProvider === 'baileys';
    }

    function resolveWhatsAppAccountId(accountId) {
        const candidate = String(accountId || '').trim();
        if (candidate && accountsById.has(candidate)) return candidate;
        return defaultAccountId;
    }

    function getBaileysGatewayForAccount(accountId) {
        const resolvedAccountId = resolveWhatsAppAccountId(accountId);
        const gateway = baileysGateways.get(resolvedAccountId) || null;
        const config = accountsById.get(resolvedAccountId) || null;
        return {
            accountId: resolvedAccountId,
            gateway,
            config,
        };
    }

    function isBaileysGatewayConnected(gateway) {
        const health = gateway?.getHealth?.();
        return Boolean(health && health.connected === true);
    }

    function listBaileysAccountCandidates(preferredAccountId) {
        const preferred = resolveWhatsAppAccountId(preferredAccountId);
        const ordered = [];
        const seen = new Set();
        const pushCandidate = (candidate) => {
            const normalized = resolveWhatsAppAccountId(candidate);
            if (!normalized || seen.has(normalized)) return;
            seen.add(normalized);
            ordered.push(normalized);
        };

        pushCandidate(preferred);
        pushCandidate(defaultAccountId);
        accountConfigs.forEach((account) => pushCandidate(account.id));
        return ordered;
    }

    function pickBaileysGatewayForOutbound(preferredAccountId) {
        const preferred = resolveWhatsAppAccountId(preferredAccountId);
        const candidates = listBaileysAccountCandidates(preferred);
        let firstAvailable = null;

        for (const candidateId of candidates) {
            const gateway = baileysGateways.get(candidateId) || null;
            if (!gateway) continue;
            if (!firstAvailable) {
                firstAvailable = { accountId: candidateId, gateway };
            }
            if (isBaileysGatewayConnected(gateway)) {
                return {
                    accountId: candidateId,
                    gateway,
                    fallbackFrom: candidateId !== preferred ? preferred : null,
                    connected: true,
                };
            }
        }

        if (firstAvailable) {
            return {
                accountId: firstAvailable.accountId,
                gateway: firstAvailable.gateway,
                fallbackFrom: firstAvailable.accountId !== preferred ? preferred : null,
                connected: false,
            };
        }

        const fallback = getBaileysGatewayForAccount(preferred);
        return {
            accountId: fallback.accountId,
            gateway: fallback.gateway || null,
            fallbackFrom: null,
            connected: false,
        };
    }

    function getWhatsAppAccountsHealth() {
        return accountConfigs.map((account) => {
            const state = baileysGateways.get(account.id)?.getHealth?.() || {
                provider: 'baileys',
                status: 'not_initialized',
                connected: false,
                connecting: false,
                qrAvailable: false,
            };
            return {
                accountId: account.id,
                label: account.label,
                isDefault: account.id === defaultAccountId,
                ...state,
            };
        });
    }

    function getWhatsAppHealth(options = {}) {
        const { accountId, gateway } = getBaileysGatewayForAccount(options?.accountId);
        const state = gateway?.getHealth?.() || {
            provider: 'baileys',
            status: 'not_initialized',
            connected: false,
            connecting: false,
            qrAvailable: false,
        };
        return {
            provider: 'baileys',
            configured: true,
            cloudConfigured: false,
            accountId,
            accounts: getWhatsAppAccountsHealth(),
            ...state,
        };
    }

    async function connectWhatsAppProvider(options = {}) {
        const { accountId, gateway } = getBaileysGatewayForAccount(options?.accountId);
        if (!gateway) throw new Error(`Conta WhatsApp não inicializada: ${accountId}`);
        await gateway.start();
        return getWhatsAppHealth({ accountId });
    }

    async function disconnectWhatsAppProvider({ logout = false, clearAuth = false, accountId = '' } = {}) {
        const resolved = getBaileysGatewayForAccount(accountId);
        if (!resolved.gateway) throw new Error(`Conta WhatsApp não inicializada: ${resolved.accountId}`);
        await resolved.gateway.stop({ logout: Boolean(logout), clearAuth: Boolean(clearAuth) });
        return getWhatsAppHealth({ accountId: resolved.accountId });
    }

    function getWhatsAppQrPayload(options = {}) {
        const { accountId, gateway } = getBaileysGatewayForAccount(options?.accountId);
        const payload = gateway?.getQrPayload?.() || {
            provider: 'baileys',
            hasQr: false,
            qrText: null,
            connected: false,
            status: 'not_initialized',
        };
        return {
            accountId,
            ...payload,
        };
    }

    async function sendWhatsAppDocumentLink({ to, url, filename, caption, accountId = '' }) {
        const toDigits = String(to || '').replace(/\D/g, '');
        if (!toDigits) throw new Error('Destino WhatsApp inválido.');

        const outboundAccountId = await resolveOutboundAccountIdForPhone(toDigits, accountId);
        const resolved = pickBaileysGatewayForOutbound(outboundAccountId);
        if (!resolved.gateway) throw new Error(`Conta WhatsApp não inicializada: ${resolved.accountId}`);
        const safeCaption = String(caption || '').trim();
        const safeUrl = String(url || '').trim();
        const textBody = [safeCaption, safeUrl].filter(Boolean).join('\n');
        await resolved.gateway.sendText({
            to: toDigits,
            body: textBody || safeUrl || 'Documento disponivel.',
        });
    }

    async function sendWhatsAppTextMessage({ to, body, accountId = '' }) {
        const toDigits = String(to || '').replace(/\D/g, '');
        if (!toDigits) throw new Error('Destino WhatsApp inválido.');
        const safeBody = String(body || '').trim();
        if (!safeBody) throw new Error('Mensagem vazia.');

        const outboundAccountId = await resolveOutboundAccountIdForPhone(toDigits, accountId);
        const resolved = pickBaileysGatewayForOutbound(outboundAccountId);
        if (!resolved.gateway) throw new Error(`Conta WhatsApp não inicializada: ${resolved.accountId}`);
        await resolved.gateway.sendText({
            to: toDigits,
            body: safeBody,
        });
    }

    async function sendWhatsAppMenuMessage(to, accountId = '') {
        const toDigits = String(to || '').replace(/\D/g, '');
        if (!toDigits) throw new Error('Destino WhatsApp inválido.');

        const outboundAccountId = await resolveOutboundAccountIdForPhone(toDigits, accountId);
        const resolved = pickBaileysGatewayForOutbound(outboundAccountId);
        if (!resolved.gateway) throw new Error(`Conta WhatsApp não inicializada: ${resolved.accountId}`);
        const plainMenu =
            'Ola! Como posso ajudar?\n' +
            '1) Ver Status\n' +
            '2) Falar com Suporte\n\n' +
            'Escreve uma das opcoes acima.';
        await resolved.gateway.sendText({
            to: toDigits,
            body: plainMenu,
        });
    }

    return {
        isBaileysProviderEnabled,
        resolveWhatsAppAccountId,
        getBaileysGatewayForAccount,
        pickBaileysGatewayForOutbound,
        getWhatsAppAccountsHealth,
        getWhatsAppHealth,
        connectWhatsAppProvider,
        disconnectWhatsAppProvider,
        getWhatsAppQrPayload,
        sendWhatsAppDocumentLink,
        sendWhatsAppTextMessage,
        sendWhatsAppMenuMessage,
    };
}

module.exports = {
    createWhatsAppService,
};
