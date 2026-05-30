const tls = require('tls');

function createImapEmailService(config = {}) {
    const {
        host,
        port = 993,
        secure = true,
        username,
        password,
        mailbox = 'INBOX',
    } = config;

    const quote = (value) => `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

    function hasImapConfig() {
        return Boolean(host && username && password);
    }

    function decodeMimeWords(value) {
        return String(value || '').replace(/=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi, (_all, charset, encoding, text) => {
            try {
                const enc = String(encoding || '').toUpperCase();
                const raw = enc === 'B'
                    ? Buffer.from(String(text || ''), 'base64')
                    : Buffer.from(String(text || '').replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary');
                return raw.toString(/utf-?8/i.test(String(charset || '')) ? 'utf8' : 'latin1');
            } catch {
                return String(text || '');
            }
        });
    }

    function extractHeaders(rawMessage) {
        const head = String(rawMessage || '').split(/\r?\n\r?\n/)[0] || '';
        const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
        const get = (name) => {
            const match = unfolded.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
            return decodeMimeWords(match?.[1] || '').trim();
        };
        return {
            from: get('From'),
            subject: get('Subject'),
            date: get('Date'),
        };
    }

    function extractActivationCode(rawMessage) {
        const normalized = String(rawMessage || '')
            .replace(/=\r?\n/g, '')
            .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ');
        const patterns = [
            /\b([A-Z0-9]{3,4}-[A-Z0-9]{3,4}-[A-Z0-9]{3,4})\b/i,
            /c[oó]digo\s+de\s+ativa[cç][aã]o[^\w]{0,40}([A-Z0-9-]{8,20})/i,
            /(?:c[oó]digo|codigo|code|valida[cç][aã]o|ativ[aá]?[cç][aã]o)[^\d]{0,40}(\d{4,8})/i,
            /\b(\d{6})\b/,
            /\b(\d{5})\b/,
            /\b(\d{4})\b/,
        ];
        for (const pattern of patterns) {
            const match = normalized.match(pattern);
            if (match?.[1]) return match[1];
        }
        return '';
    }

    function decodeHtmlEntities(value) {
        return String(value || '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/gi, "'")
            .replace(/&#(\d+);/g, (_all, code) => {
                const parsed = Number(code);
                return Number.isFinite(parsed) ? String.fromCharCode(parsed) : '';
            })
            .replace(/&#x([0-9a-f]+);/gi, (_all, code) => {
                const parsed = parseInt(code, 16);
                return Number.isFinite(parsed) ? String.fromCharCode(parsed) : '';
            });
    }

    function decodeTransferText(value, encoding = '') {
        const raw = String(value || '').trim();
        const normalizedEncoding = String(encoding || '').trim().toLowerCase();
        if (normalizedEncoding === 'base64') {
            try {
                return Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
            } catch (_) {
                return raw;
            }
        }
        return raw
            .replace(/=\r?\n/g, '')
            .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }

    function extractMimeTextParts(rawMessage) {
        const raw = String(rawMessage || '');
        const parts = [];
        const pattern = /Content-Type:\s*text\/(plain|html)[^\n]*[\s\S]*?Content-Transfer-Encoding:\s*(base64|quoted-printable|7bit|8bit)[^\n]*\r?\n\r?\n([\s\S]*?)(?=\r?\n--[^\r\n]+|\r?\n[A-Z]\d{4}\s|$)/gi;
        let match;
        while ((match = pattern.exec(raw))) {
            const kind = String(match[1] || '').toLowerCase();
            const encoding = String(match[2] || '').toLowerCase();
            const body = decodeTransferText(match[3] || '', encoding);
            if (body.trim()) parts.push({ kind, body });
        }
        return parts;
    }

    function htmlToText(value) {
        return String(value || '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
            .replace(/<[^>]+>/g, ' ');
    }

    function cleanupPlainText(value) {
        return decodeHtmlEntities(
            String(value || '')
                .replace(/=\r?\n/g, '')
                .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
                .replace(/\r/g, '\n')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
        ).trim();
    }

    function messageToPlainText(rawMessage) {
        const parts = extractMimeTextParts(rawMessage);
        const plainPart = parts.find((part) => part.kind === 'plain');
        if (plainPart) return cleanupPlainText(plainPart.body);
        const htmlPart = parts.find((part) => part.kind === 'html');
        if (htmlPart) return cleanupPlainText(htmlToText(htmlPart.body));
        return cleanupPlainText(htmlToText(String(rawMessage || '')));
    }

    function isLikelyPasswordCandidate(value) {
        const candidate = String(value || '').trim();
        if (candidate.length < 6 || candidate.length > 80) return false;
        if (/\s/.test(candidate)) return false;
        if (/^https?:\/\//i.test(candidate) || /^www\./i.test(candidate)) return false;
        if (/seg-social|seguranca|segurança|utilizador|password|senha|palavra/i.test(candidate)) return false;
        if (/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(candidate)) return false;
        if (/^\d{4,12}$/.test(candidate)) return false;
        if (!/[A-Za-z]/.test(candidate)) return false;
        return /^[A-Za-z0-9@#$%&*!?.+\-_=,:;()[\]{}]+$/.test(candidate);
    }

    function cleanPasswordCandidate(value) {
        const candidate = String(value || '')
            .trim()
            .replace(/^["'“”‘’]+|["'“”‘’.,;:]+$/g, '');
        return isLikelyPasswordCandidate(candidate) ? candidate : '';
    }

    function extractSegSocialSubUserPassword(rawMessage, options = {}) {
        const plainText = messageToPlainText(rawMessage);
        const haystack = plainText
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
        const username = String(options.username || '').trim();
        const email = String(options.email || '').trim().toLowerCase();
        const candidates = [];

        const addCandidate = (value, score, context = '') => {
            const password = cleanPasswordCandidate(value);
            if (!password) return;
            const duplicate = candidates.find((item) => item.password === password);
            const nextScore = Number(score || 0) + (username && haystack.includes(username.toLowerCase()) ? 3 : 0) + (email && haystack.includes(email) ? 1 : 0);
            if (duplicate) {
                duplicate.score = Math.max(duplicate.score, nextScore);
                return;
            }
            candidates.push({ password, score: nextScore, context });
        };

        const inlinePatterns = [
            /(?:palavra[-\s]*passe|senha|password)(?:\s+(?:provis[oó]ria|inicial|de\s+acesso))?\s*[:\-–—]?\s*([A-Za-z0-9@#$%&*!?.+\-_=,:;()[\]{}]{6,80})/gi,
            /(?:nova\s+senha|nova\s+palavra[-\s]*passe)\s*[:\-–—]?\s*([A-Za-z0-9@#$%&*!?.+\-_=,:;()[\]{}]{6,80})/gi,
        ];
        inlinePatterns.forEach((pattern) => {
            let match;
            while ((match = pattern.exec(plainText))) {
                addCandidate(match[1], 30, 'inline');
            }
        });

        const lines = plainText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
        lines.forEach((line, index) => {
            const normalizedLine = line
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '');
            if (!/(palavra[-\s]*passe|senha|password)/i.test(normalizedLine)) return;

            const afterSeparator = line.split(/[:\-–—]/).slice(1).join('-').trim();
            addCandidate(afterSeparator, 40, 'line');
            for (let offset = 1; offset <= 3; offset += 1) {
                addCandidate(lines[index + offset], 25 - offset, 'near-line');
            }
        });

        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.password || '';
    }

    async function withImapSession(callback) {
        if (!hasImapConfig()) {
            throw new Error('IMAP não configurado para leitura de email.');
        }

        return new Promise((resolve, reject) => {
            const socket = tls.connect({
                host,
                port: Number(port) || 993,
                servername: host,
                rejectUnauthorized: false,
            });
            let buffer = '';
            let tagCounter = 0;
            let settled = false;

            const cleanup = () => {
                socket.removeAllListeners();
                socket.end();
                socket.destroy();
            };
            const fail = (error) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error instanceof Error ? error : new Error(String(error || 'Erro IMAP.')));
            };
            const done = (value) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(value);
            };

            const waitFor = (tag) => new Promise((res, rej) => {
                const started = Date.now();
                const check = () => {
                    const pattern = new RegExp(`(^|\\r?\\n)${tag} (OK|NO|BAD)`, 'i');
                    const match = buffer.match(pattern);
                    if (match) {
                        const output = buffer;
                        buffer = '';
                        if (String(match[2]).toUpperCase() === 'OK') res(output);
                        else rej(new Error(`Comando IMAP falhou: ${output.split(/\r?\n/).slice(-3).join(' ')}`));
                        return;
                    }
                    if (Date.now() - started > 30000) {
                        rej(new Error('Timeout a aguardar resposta IMAP.'));
                        return;
                    }
                    setTimeout(check, 80);
                };
                check();
            });

            const command = async (raw) => {
                const tag = `A${String(++tagCounter).padStart(4, '0')}`;
                socket.write(`${tag} ${raw}\r\n`);
                return waitFor(tag);
            };

            socket.on('data', (chunk) => {
                buffer += chunk.toString('binary');
            });
            socket.on('error', fail);
            socket.on('secureConnect', async () => {
                try {
                    await new Promise((res) => setTimeout(res, 250));
                    buffer = '';
                    await command(`LOGIN ${quote(username)} ${quote(password)}`);
                    await command(`SELECT ${quote(mailbox)}`);
                    const value = await callback({ command });
                    await command('LOGOUT').catch(() => null);
                    done(value);
                } catch (error) {
                    fail(error);
                }
            });
            socket.setTimeout(45000, () => fail(new Error('Timeout na ligação IMAP.')));
        });
    }

    async function findLatestSegSocialCode({ sinceDays = 7, maxMessages = 25, activationOnly = false, verificationOnly = false, sinceIso = '' } = {}) {
        const since = new Date();
        since.setDate(since.getDate() - Math.max(1, Number(sinceDays) || 7));
        const sinceTimestamp = Date.parse(String(sinceIso || ''));
        const imapDate = since.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

        return withImapSession(async ({ command }) => {
            const searchOutput = await command(`UID SEARCH SINCE ${imapDate}`);
            const uidLine = searchOutput.split(/\r?\n/).find((line) => /^\* SEARCH /i.test(line)) || '';
            const uids = uidLine.replace(/^\* SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean);
            const recentUids = uids.slice(-Math.max(1, Number(maxMessages) || 25)).reverse();

            for (const uid of recentUids) {
                const output = await command(`UID FETCH ${uid} (BODY.PEEK[])`);
                const headers = extractHeaders(output);
                const messageTimestamp = Date.parse(headers.date || '');
                if (Number.isFinite(sinceTimestamp) && Number.isFinite(messageTimestamp) && messageTimestamp < sinceTimestamp) {
                    continue;
                }
                const haystack = `${headers.from} ${headers.subject} ${output}`.toLowerCase();
                if (
                    !haystack.includes('segurança social') &&
                    !haystack.includes('seguranca social') &&
                    !haystack.includes('seg-social') &&
                    !haystack.includes('instituto da informática') &&
                    !haystack.includes('instituto da informatica')
                ) {
                    continue;
                }
                if (activationOnly) {
                    const looksLikeActivationEmail =
                        /registo\s+de\s+utilizador/i.test(`${headers.subject} ${output}`) ||
                        /c[oó]digo\s+de\s+ativa[cç][aã]o/i.test(output);
                    if (!looksLikeActivationEmail) continue;
                }
                if (verificationOnly) {
                    const normalizedVerificationText = `${headers.subject} ${output}`
                        .normalize('NFD')
                        .replace(/[\u0300-\u036f]/g, '');
                    const looksLikeVerificationEmail =
                        /codigo\s+de\s+verificacao/i.test(normalizedVerificationText) ||
                        /autenticacao\s+de\s+dois\s+fatores/i.test(normalizedVerificationText);
                    if (!looksLikeVerificationEmail) continue;
                }
                const code = extractActivationCode(output);
                if (!code) continue;
                if (activationOnly && !/^[A-Z0-9]{3,4}-[A-Z0-9]{3,4}-[A-Z0-9]{3,4}$/i.test(code)) {
                    continue;
                }
                if (verificationOnly && !/^\d{4,8}$/.test(code)) {
                    continue;
                }
                return {
                    code,
                    uid,
                    from: headers.from,
                    subject: headers.subject,
                    date: headers.date,
                };
            }
            return null;
        });
    }

    async function findLatestSegSocialSubUserPassword({ sinceDays = 14, maxMessages = 50, sinceIso = '', username = '', email = '' } = {}) {
        const since = new Date();
        since.setDate(since.getDate() - Math.max(1, Number(sinceDays) || 14));
        const sinceTimestamp = Date.parse(String(sinceIso || ''));
        const imapDate = since.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
        const usernameNeedle = String(username || '').trim().toLowerCase();
        const emailNeedle = String(email || '').trim().toLowerCase();

        return withImapSession(async ({ command }) => {
            const searchOutput = await command(`UID SEARCH SINCE ${imapDate}`);
            const uidLine = searchOutput.split(/\r?\n/).find((line) => /^\* SEARCH /i.test(line)) || '';
            const uids = uidLine.replace(/^\* SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean);
            const recentUids = uids.slice(-Math.max(1, Number(maxMessages) || 50)).reverse();

            for (const uid of recentUids) {
                const output = await command(`UID FETCH ${uid} (BODY.PEEK[])`);
                const headers = extractHeaders(output);
                const messageTimestamp = Date.parse(headers.date || '');
                if (Number.isFinite(sinceTimestamp) && Number.isFinite(messageTimestamp) && messageTimestamp < sinceTimestamp) {
                    continue;
                }

                const plainText = messageToPlainText(output);
                const haystack = `${headers.from} ${headers.subject} ${plainText}`.toLowerCase();
                if (
                    !haystack.includes('segurança social') &&
                    !haystack.includes('seguranca social') &&
                    !haystack.includes('seg-social') &&
                    !haystack.includes('instituto da informática') &&
                    !haystack.includes('instituto da informatica')
                ) {
                    continue;
                }
                if (!/(subconta|subutilizador|utilizador|palavra[-\s]*passe|senha|password)/i.test(plainText)) {
                    continue;
                }
                if (usernameNeedle && !haystack.includes(usernameNeedle) && !haystack.includes(usernameNeedle.replace(/-/g, '_'))) {
                    const hasStrongPasswordSignal = /(palavra[-\s]*passe|senha|password)/i.test(plainText);
                    if (!hasStrongPasswordSignal) continue;
                }
                if (emailNeedle && !haystack.includes(emailNeedle)) {
                    const hasStrongPasswordSignal = /(palavra[-\s]*passe|senha|password)/i.test(plainText);
                    if (!hasStrongPasswordSignal) continue;
                }

                const passwordValue = extractSegSocialSubUserPassword(output, { username, email });
                if (!passwordValue) continue;
                return {
                    password: passwordValue,
                    uid,
                    from: headers.from,
                    subject: headers.subject,
                    date: headers.date,
                };
            }
            return null;
        });
    }

    async function listRecentMessages({ sinceDays = 14, maxMessages = 50 } = {}) {
        const since = new Date();
        since.setDate(since.getDate() - Math.max(1, Number(sinceDays) || 14));
        const imapDate = since.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');

        return withImapSession(async ({ command }) => {
            const searchOutput = await command(`UID SEARCH SINCE ${imapDate}`);
            const uidLine = searchOutput.split(/\r?\n/).find((line) => /^\* SEARCH /i.test(line)) || '';
            const uids = uidLine.replace(/^\* SEARCH\s*/i, '').trim().split(/\s+/).filter(Boolean);
            const recentUids = uids.slice(-Math.max(1, Number(maxMessages) || 50)).reverse();
            const messages = [];

            for (const uid of recentUids) {
                const output = await command(`UID FETCH ${uid} (BODY.PEEK[])`);
                const headers = extractHeaders(output);
                messages.push({
                    uid,
                    from: headers.from,
                    subject: headers.subject,
                    date: headers.date,
                    plainText: messageToPlainText(output),
                    raw: output,
                });
            }

            return messages;
        });
    }

    return {
        hasImapConfig,
        findLatestSegSocialCode,
        findLatestSegSocialSubUserPassword,
        listRecentMessages,
    };
}

module.exports = {
    createImapEmailService,
};
