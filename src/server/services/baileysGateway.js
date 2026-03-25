const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    Browsers,
    jidDecode,
    downloadMediaMessage,
} = require('@whiskeysockets/baileys');

function normalizeDigits(value) {
    return String(value || '').replace(/\D/g, '');
}

function toIsoTimestamp(value) {
    if (value === null || value === undefined) return new Date().toISOString();
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return new Date().toISOString();
    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return new Date(millis).toISOString();
}

function resolveMessageType(rawMessage) {
    const message = rawMessage?.message;
    if (!message || typeof message !== 'object') return 'unknown';
    const keys = Object.keys(message);
    return keys[0] || 'unknown';
}

function resolveInboundText(rawMessage) {
    const message = rawMessage?.message || {};
    if (typeof message.conversation === 'string' && message.conversation.trim()) {
        return message.conversation.trim();
    }
    if (message.extendedTextMessage?.text) {
        return String(message.extendedTextMessage.text).trim();
    }
    if (message.imageMessage?.caption) {
        return String(message.imageMessage.caption).trim();
    }
    if (message.documentMessage?.caption) {
        return String(message.documentMessage.caption).trim();
    }
    if (message.videoMessage?.caption) {
        return String(message.videoMessage.caption).trim();
    }
    if (message.templateButtonReplyMessage?.selectedDisplayText) {
        return String(message.templateButtonReplyMessage.selectedDisplayText).trim();
    }
    if (message.buttonsResponseMessage?.selectedDisplayText) {
        return String(message.buttonsResponseMessage.selectedDisplayText).trim();
    }
    if (message.listResponseMessage?.title) {
        return String(message.listResponseMessage.title).trim();
    }
    if (message.listResponseMessage?.description) {
        return String(message.listResponseMessage.description).trim();
    }
    if (message.listResponseMessage?.singleSelectReply?.selectedRowId) {
        return String(message.listResponseMessage.singleSelectReply.selectedRowId).trim();
    }
    if (message.reactionMessage?.text) {
        return String(message.reactionMessage.text).trim();
    }
    const messageType = resolveMessageType(rawMessage);
    return `[Midia/Outro: ${messageType}]`;
}

const MIME_TO_EXTENSION = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
};

function sanitizeFileName(value, fallback = 'anexo') {
    const candidate = String(value || '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
    return candidate || fallback;
}

function extensionFromMime(mimeType = '') {
    const normalized = String(mimeType || '').trim().toLowerCase().split(';')[0].trim();
    return MIME_TO_EXTENSION[normalized] || '';
}

function resolveInboundMediaPayload(rawMessage) {
    const message = rawMessage?.message || {};
    const withPayload = (kind, payload, fallbackName) => {
        if (!payload || typeof payload !== 'object') return null;
        const mimeType = String(payload.mimetype || payload.mime_type || '').trim();
        const fileNameRaw =
            String(payload.fileName || payload.filename || payload.name || '').trim() || fallbackName;
        const extension = extensionFromMime(mimeType);
        const hasExtension = /\.[a-z0-9]{2,8}$/i.test(fileNameRaw);
        const fileName = hasExtension || !extension ? fileNameRaw : `${fileNameRaw}${extension}`;
        const sizeValue = Number(payload.fileLength || payload.file_length || payload.fileSize || payload.file_size);
        const remoteUrl = String(payload.url || '').trim() || null;
        const remoteId = String(payload.directPath || payload.mediaKeyTimestamp || '').trim() || null;
        return {
            kind,
            mimeType: mimeType || '',
            fileName,
            size: Number.isFinite(sizeValue) ? sizeValue : null,
            remoteUrl,
            remoteId,
            meta: payload,
        };
    };

    if (message.imageMessage) return withPayload('image', message.imageMessage, 'imagem');
    if (message.documentMessage) return withPayload('document', message.documentMessage, 'documento');
    if (message.videoMessage) return withPayload('video', message.videoMessage, 'video');
    if (message.audioMessage) return withPayload('audio', message.audioMessage, 'audio');
    if (message.stickerMessage) return withPayload('sticker', message.stickerMessage, 'sticker');
    return null;
}

function resolveDisconnectCode(update) {
    const directCode = Number(update?.lastDisconnect?.error?.output?.statusCode);
    if (Number.isFinite(directCode)) return directCode;
    const fallbackCode = Number(update?.lastDisconnect?.error?.statusCode);
    if (Number.isFinite(fallbackCode)) return fallbackCode;
    return 0;
}

function isLoggedOutCode(code) {
    const expected = Number(DisconnectReason?.loggedOut || 401);
    return Number(code || 0) === expected;
}

function decodeJidParts(rawJid) {
    const jid = String(rawJid || '').trim();
    if (!jid) return { jid: '', user: '', server: '' };
    const decoded = typeof jidDecode === 'function' ? jidDecode(jid) : null;
    const user = normalizeDigits(decoded?.user || jid.split('@')[0] || '');
    const server = String(decoded?.server || jid.split('@')[1] || '').trim().toLowerCase();
    return { jid, user, server };
}

function resolveInboundAddress(rawMessage) {
    const key = rawMessage?.key || {};
    const candidates = [
        { value: key?.remoteJid, source: 'remoteJid', weight: 170 },
        { value: key?.participant, source: 'participant', weight: 150 },
        { value: key?.remoteJidAlt, source: 'remoteJidAlt', weight: 110 },
        { value: key?.participantAlt, source: 'participantAlt', weight: 90 },
    ];

    const ownDigits = normalizeDigits(rawMessage?.__ownDigits || '');
    const scored = [];
    for (const candidate of candidates) {
        const { jid, user, server } = decodeJidParts(candidate?.value);
        if (!jid || !user) continue;
        if (jid === 'status@broadcast') continue;
        if (server === 'g.us' || server === 'broadcast' || server === 'newsletter') continue;

        let score = Number(candidate?.weight || 0);
        if (server === 's.whatsapp.net' || server === 'c.us') score += 140;
        else if (server === 'lid') score -= 90;
        else if (server) score += 10;
        if (user.length >= 8 && user.length <= 15) score += 25;
        if (user.length > 15) score -= 15;
        if (ownDigits && normalizeDigits(user) === ownDigits) score -= 200;

        scored.push({
            jid,
            digits: user,
            server,
            source: candidate.source,
            score,
        });
    }

    scored.sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
    return scored[0] || null;
}

function extractOwnDigitsFromMeId(rawMeId) {
    const value = String(rawMeId || '').trim();
    if (!value) return '';
    const match = value.match(/(\d{6,})(?::\d+)?@/);
    if (match?.[1]) return normalizeDigits(match[1]);
    const decoded = decodeJidParts(value);
    return normalizeDigits(decoded?.user || '');
}

function createBaileysGateway(options = {}) {
    const authDir = path.resolve(String(options.authDir || path.resolve(process.cwd(), '.baileys_auth')).trim());
    const printQRInTerminal = Boolean(options.printQRInTerminal);
    const autoReconnect = options.autoReconnect !== false;
    const reconnectDelayMs = Math.max(1000, Number(options.reconnectDelayMs || 4000));

    const onInboundMessage = typeof options.onInboundMessage === 'function' ? options.onInboundMessage : null;
    const onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
    const onLog = typeof options.onLog === 'function' ? options.onLog : null;
    const inboundMediaDir = path.resolve(
        String(options.inboundMediaDir || path.resolve(process.cwd(), 'chat_media', 'inbound')).trim()
    );

    let socket = null;
    let saveCreds = async () => {};
    let connectPromise = null;
    let reconnectTimer = null;
    let manuallyStopped = false;

    const waiters = new Set();

    const state = {
        provider: 'baileys',
        status: 'idle',
        connected: false,
        connecting: false,
        qr: null,
        qrUpdatedAt: null,
        lastError: null,
        lastDisconnectAt: null,
        lastDisconnectCode: null,
        lastDisconnectReason: null,
        meId: null,
        meName: null,
    };

    const emitState = () => {
        if (!onStateChange) return;
        onStateChange(getHealth());
    };

    const log = (stage, payload = {}) => {
        onLog?.(stage, payload);
    };

    const clearReconnectTimer = () => {
        if (!reconnectTimer) return;
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    };

    const resolveWaiters = (error = null) => {
        const pending = Array.from(waiters);
        waiters.clear();
        pending.forEach((entry) => {
            try {
                clearTimeout(entry.timer);
                if (error) entry.reject(error);
                else entry.resolve(socket);
            } catch (_) {
                // sem bloqueio
            }
        });
    };

    const waitForConnected = (timeoutMs = 25000) => {
        if (state.connected && socket) return Promise.resolve(socket);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                waiters.delete(holder);
                reject(new Error('Timeout ao ligar WhatsApp (Baileys).'));
            }, Math.max(1000, Number(timeoutMs || 25000)));
            const holder = { resolve, reject, timer };
            waiters.add(holder);
        });
    };

    const toJid = (value) => {
        const digits = normalizeDigits(value);
        if (!digits) throw new Error('Número WhatsApp inválido.');
        return `${digits}@s.whatsapp.net`;
    };

    const persistInboundMediaToDisk = async ({ rawMessage, mediaPayload, waId }) => {
        if (!rawMessage?.message || !mediaPayload?.kind) return null;
        await fs.promises.mkdir(inboundMediaDir, { recursive: true });
        const baseName = sanitizeFileName(
            mediaPayload.fileName,
            mediaPayload.kind === 'image' ? 'imagem' : 'anexo'
        );
        const extFromName = path.extname(baseName);
        const ext = extFromName || extensionFromMime(mediaPayload.mimeType) || '.bin';
        const pureBase = extFromName ? baseName.slice(0, -extFromName.length) : baseName;
        const messageToken = sanitizeFileName(String(waId || Date.now()), `msg_${Date.now()}`);
        const finalName = `${Date.now()}_${messageToken}_${pureBase}${ext}`;
        const mediaPath = path.join(inboundMediaDir, finalName);

        const mediaStream = await downloadMediaMessage(
            rawMessage,
            'stream',
            {},
            {
                reuploadRequest: socket?.updateMediaMessage,
            }
        );

        await pipeline(mediaStream, fs.createWriteStream(mediaPath));
        const stats = await fs.promises.stat(mediaPath);
        return {
            mediaPath,
            mediaFileName: baseName,
            mediaMimeType: mediaPayload.mimeType || '',
            mediaSize: Number.isFinite(Number(stats?.size)) ? Number(stats.size) : null,
        };
    };

    const handleInboundUpsert = async (upsertEvent) => {
        const messages = Array.isArray(upsertEvent?.messages) ? upsertEvent.messages : [];
        for (const message of messages) {
            try {
                if (!message?.message) continue;
                const rawType = resolveMessageType(message);
                if (rawType === 'protocolMessage' || message?.message?.protocolMessage) {
                    log('baileys_inbound_ignored', {
                        reason: 'protocol_message',
                        waId: String(message?.key?.id || '').trim() || null,
                    });
                    continue;
                }
                const ownDigits = extractOwnDigitsFromMeId(state.meId || socket?.user?.id || '');
                const inboundAddress = resolveInboundAddress({
                    ...message,
                    __ownDigits: ownDigits,
                });
                const fromNumber = String(inboundAddress?.digits || '').trim();
                if (!fromNumber) continue;
                const fromServer = String(inboundAddress?.server || '').trim().toLowerCase();
                // IDs "...@lid" são identificadores internos do WhatsApp (não são telemóvel real).
                // Ignoramos para não criar contactos/conversas com número interno.
                if (fromServer === 'lid') {
                    log('baileys_inbound_ignored', {
                        reason: 'lid_internal_id',
                        waId: String(message?.key?.id || '').trim() || null,
                        from: fromNumber,
                        source: inboundAddress?.source || null,
                    });
                    continue;
                }
                if (ownDigits && normalizeDigits(fromNumber) === ownDigits) {
                    log('baileys_inbound_ignored', {
                        reason: 'self_number',
                        waId: String(message?.key?.id || '').trim() || null,
                        from: fromNumber,
                    });
                    continue;
                }
                const inboundMedia = resolveInboundMediaPayload(message);
                let persistedMedia = null;
                if (inboundMedia) {
                    try {
                        persistedMedia = await persistInboundMediaToDisk({
                            rawMessage: message,
                            mediaPayload: inboundMedia,
                            waId: message?.key?.id,
                        });
                    } catch (mediaError) {
                        log('baileys_inbound_media_error', {
                            error: String(mediaError?.message || mediaError),
                            waId: String(message?.key?.id || '').trim() || null,
                            kind: inboundMedia.kind,
                        });
                    }
                }

                const payload = {
                    waId: String(message?.key?.id || '').trim() || null,
                    fromMe: Boolean(message?.key?.fromMe),
                    fromNumber,
                    body: resolveInboundText(message),
                    rawType,
                    timestampIso: toIsoTimestamp(message?.messageTimestamp),
                    pushName: String(message?.pushName || '').trim() || null,
                    fromJid: inboundAddress?.jid || null,
                    fromServer: inboundAddress?.server || null,
                    fromSource: inboundAddress?.source || null,
                    mediaKind: inboundMedia?.kind || null,
                    mediaPath: persistedMedia?.mediaPath || null,
                    mediaMimeType: persistedMedia?.mediaMimeType || inboundMedia?.mimeType || null,
                    mediaFileName: persistedMedia?.mediaFileName || inboundMedia?.fileName || null,
                    mediaSize:
                        persistedMedia?.mediaSize ??
                        (Number.isFinite(Number(inboundMedia?.size)) ? Number(inboundMedia.size) : null),
                    mediaProvider: 'baileys',
                    mediaRemoteId: inboundMedia?.remoteId || null,
                    mediaRemoteUrl: inboundMedia?.remoteUrl || null,
                    mediaMeta: inboundMedia?.meta || null,
                    rawMessage: message,
                };
                if (onInboundMessage) {
                    await onInboundMessage(payload);
                }
            } catch (error) {
                log('baileys_inbound_error', {
                    error: String(error?.message || error),
                });
            }
        }
    };

    const scheduleReconnect = () => {
        if (!autoReconnect || manuallyStopped) return;
        clearReconnectTimer();
        reconnectTimer = setTimeout(() => {
            void start().catch((error) => {
                state.lastError = String(error?.message || error);
                emitState();
                log('baileys_reconnect_error', { error: state.lastError });
            });
        }, reconnectDelayMs);
    };

    const attachSocketListeners = (nextSocket) => {
        nextSocket.ev.on('creds.update', () => {
            void saveCreds().catch(() => null);
        });

        nextSocket.ev.on('messages.upsert', (event) => {
            void handleInboundUpsert(event);
        });

        nextSocket.ev.on('connection.update', (update) => {
            const connection = String(update?.connection || '').trim().toLowerCase();
            if (update?.qr) {
                state.qr = String(update.qr);
                state.qrUpdatedAt = new Date().toISOString();
                state.status = 'qr';
                state.connecting = true;
                state.connected = false;
                state.lastError = null;
                emitState();
            }

            if (connection === 'connecting') {
                state.status = 'connecting';
                state.connecting = true;
                state.connected = false;
                emitState();
                return;
            }

            if (connection === 'open') {
                state.status = 'connected';
                state.connecting = false;
                state.connected = true;
                state.lastError = null;
                state.lastDisconnectCode = null;
                state.lastDisconnectReason = null;
                state.qr = null;
                state.qrUpdatedAt = null;
                const meId = String(nextSocket?.user?.id || '').trim();
                state.meId = meId || null;
                state.meName = String(nextSocket?.user?.name || '').trim() || null;
                emitState();
                resolveWaiters(null);
                log('baileys_connected', {
                    meId: state.meId,
                    meName: state.meName,
                });
                return;
            }

            if (connection === 'close') {
                const code = resolveDisconnectCode(update);
                const loggedOut = isLoggedOutCode(code);

                state.status = loggedOut ? 'logged_out' : 'disconnected';
                state.connecting = false;
                state.connected = false;
                state.lastDisconnectAt = new Date().toISOString();
                state.lastDisconnectCode = Number.isFinite(code) && code > 0 ? code : null;
                state.lastDisconnectReason =
                    String(update?.lastDisconnect?.error?.message || '').trim() || (loggedOut ? 'logged_out' : 'disconnected');
                if (loggedOut) {
                    state.qr = null;
                    state.qrUpdatedAt = null;
                }
                emitState();
                resolveWaiters(new Error(state.lastDisconnectReason || 'Conexão WhatsApp fechada.'));
                socket = null;

                if (!manuallyStopped && !loggedOut) {
                    scheduleReconnect();
                }
            }
        });
    };

    async function start() {
        if (state.connected && socket) return getHealth();
        if (connectPromise) return connectPromise;

        manuallyStopped = false;
        clearReconnectTimer();
        state.connecting = true;
        state.status = 'connecting';
        state.lastError = null;
        emitState();

        connectPromise = (async () => {
            await fs.promises.mkdir(authDir, { recursive: true });
            const auth = await useMultiFileAuthState(authDir);
            saveCreds = auth.saveCreds;
            const latest = await fetchLatestBaileysVersion().catch(() => null);
            const resolvedVersion = Array.isArray(latest?.version) ? latest.version : undefined;

            const nextSocket = makeWASocket({
                auth: auth.state,
                printQRInTerminal,
                version: resolvedVersion,
                browser: Browsers?.macOS?.('WA PRO') || ['WA PRO', 'Desktop', '1.0.0'],
                syncFullHistory: false,
                shouldIgnoreJid: (jid) => String(jid || '').includes('@newsletter'),
            });

            socket = nextSocket;
            attachSocketListeners(nextSocket);
            return getHealth();
        })()
            .catch((error) => {
                state.connecting = false;
                state.connected = false;
                state.status = 'error';
                state.lastError = String(error?.message || error);
                emitState();
                resolveWaiters(error);
                throw error;
            })
            .finally(() => {
                connectPromise = null;
            });

        return connectPromise;
    }

    async function stop({ logout = false, clearAuth = false } = {}) {
        manuallyStopped = true;
        clearReconnectTimer();
        resolveWaiters(new Error('Conexão WhatsApp encerrada manualmente.'));

        if (socket) {
            try {
                if (logout && typeof socket.logout === 'function') {
                    await socket.logout();
                } else if (socket.ws?.close) {
                    socket.ws.close();
                }
            } catch (_) {
                // sem bloqueio
            }
        }

        socket = null;
        state.status = 'stopped';
        state.connected = false;
        state.connecting = false;
        state.qr = null;
        state.qrUpdatedAt = null;
        state.meId = null;
        state.meName = null;
        emitState();

        if (clearAuth) {
            try {
                await fs.promises.rm(authDir, { recursive: true, force: true });
            } catch (_) {
                // sem bloqueio
            }
        }
        return getHealth();
    }

    async function sendText(input) {
        const to = String(input?.to || '').trim();
        const body = String(input?.body || '').trim();
        if (!body) throw new Error('Mensagem de texto vazia.');
        await start();
        const activeSocket = await waitForConnected(30000);
        const result = await activeSocket.sendMessage(toJid(to), { text: body });
        return {
            waId: String(result?.key?.id || '').trim() || null,
        };
    }

    async function sendImage(input) {
        const to = String(input?.to || '').trim();
        const mediaPath = path.resolve(String(input?.path || '').trim());
        const caption = String(input?.caption || '').trim();
        if (!mediaPath) throw new Error('Imagem sem caminho.');
        await fs.promises.access(mediaPath, fs.constants.R_OK);
        await start();
        const activeSocket = await waitForConnected(30000);
        const payload = {
            image: { url: mediaPath },
        };
        if (caption) payload.caption = caption;
        const result = await activeSocket.sendMessage(toJid(to), payload);
        return {
            waId: String(result?.key?.id || '').trim() || null,
        };
    }

    async function sendDocument(input) {
        const to = String(input?.to || '').trim();
        const mediaPath = path.resolve(String(input?.path || '').trim());
        const fileName = String(input?.fileName || '').trim() || path.basename(mediaPath || 'documento.pdf');
        const mimeType = String(input?.mimeType || '').trim() || 'application/octet-stream';
        const caption = String(input?.caption || '').trim();
        if (!mediaPath) throw new Error('Documento sem caminho.');
        await fs.promises.access(mediaPath, fs.constants.R_OK);
        await start();
        const activeSocket = await waitForConnected(30000);
        const payload = {
            document: { url: mediaPath },
            fileName,
            mimetype: mimeType,
        };
        if (caption) payload.caption = caption;
        const result = await activeSocket.sendMessage(toJid(to), payload);
        return {
            waId: String(result?.key?.id || '').trim() || null,
        };
    }

    function getHealth() {
        return {
            provider: 'baileys',
            status: state.status,
            connected: state.connected,
            connecting: state.connecting,
            qrAvailable: Boolean(state.qr),
            qrUpdatedAt: state.qrUpdatedAt,
            lastError: state.lastError,
            lastDisconnectAt: state.lastDisconnectAt,
            lastDisconnectCode: state.lastDisconnectCode,
            lastDisconnectReason: state.lastDisconnectReason,
            meId: state.meId,
            meName: state.meName,
            authDir,
        };
    }

    function getQrPayload() {
        return {
            provider: 'baileys',
            hasQr: Boolean(state.qr),
            qrText: state.qr || null,
            qrUpdatedAt: state.qrUpdatedAt,
            connected: state.connected,
            connecting: state.connecting,
            status: state.status,
        };
    }

    return {
        start,
        stop,
        sendText,
        sendImage,
        sendDocument,
        getHealth,
        getQrPayload,
    };
}

module.exports = {
    createBaileysGateway,
};
