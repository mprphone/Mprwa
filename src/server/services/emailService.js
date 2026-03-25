function createEmailService(deps) {
    const {
        axios,
        nodemailer,
        SMTP_HOST,
        SMTP_PORT,
        SMTP_TLS,
        SMTP_USERNAME,
        SMTP_PASSWORD,
        SMTP_FROM_EMAIL,
        SMTP_FROM_NAME,
        RESEND_API_KEY,
        RESEND_FROM,
    } = deps;

    let smtpTransporter = null;

    function hasSmtpConfig() {
        return Boolean(SMTP_HOST && SMTP_USERNAME && SMTP_PASSWORD);
    }

    function hasEmailProvider() {
        return hasSmtpConfig() || Boolean(RESEND_API_KEY);
    }

    function getSmtpTransporter() {
        if (!hasSmtpConfig()) return null;
        if (smtpTransporter) return smtpTransporter;
        smtpTransporter = nodemailer.createTransport({
            host: SMTP_HOST,
            port: SMTP_PORT,
            secure: SMTP_TLS,
            auth: {
                user: SMTP_USERNAME,
                pass: SMTP_PASSWORD,
            },
            tls: {
                rejectUnauthorized: false,
            },
        });
        return smtpTransporter;
    }

    function formatSmtpFrom() {
        if (SMTP_FROM_EMAIL) {
            return SMTP_FROM_NAME ? `${SMTP_FROM_NAME} <${SMTP_FROM_EMAIL}>` : SMTP_FROM_EMAIL;
        }
        return SMTP_FROM_NAME ? `${SMTP_FROM_NAME} <${SMTP_USERNAME}>` : SMTP_USERNAME;
    }

    async function sendEmailDocumentLink({ to, cc, subject, documentLabel, url }) {
        const recipient = String(to || '').trim().toLowerCase();
        const ccEmail = String(cc || '').trim().toLowerCase();
        if (!recipient) {
            throw new Error('Email do cliente invalido.');
        }

        const safeSubject = String(subject || '').trim() || 'Documento disponivel';
        const safeLabel = String(documentLabel || 'Documento');
        const safeUrl = String(url || '').trim();
        if (!safeUrl) {
            throw new Error('Link do documento invalido para envio por email.');
        }

        const textBody = `${safeLabel}\n\nO seu documento esta disponivel em: ${safeUrl}\n\nCumprimentos,\nWA PRO`;
        const htmlBody =
            `<p>${safeLabel}</p>` +
            `<p>O seu documento esta disponivel em: <a href="${safeUrl}">${safeUrl}</a></p>` +
            '<p>Cumprimentos,<br/>WA PRO</p>';

        const ccList = ccEmail && ccEmail !== recipient ? [ccEmail] : [];

        if (hasSmtpConfig()) {
            const transporter = getSmtpTransporter();
            await transporter.sendMail({
                from: formatSmtpFrom(),
                to: recipient,
                cc: ccList.length > 0 ? ccList : undefined,
                subject: safeSubject,
                text: textBody,
                html: htmlBody,
            });
            return;
        }

        if (!RESEND_API_KEY) {
            throw new Error('Nenhum provedor de email configurado (SMTP/Resend).');
        }

        await axios({
            method: 'POST',
            url: 'https://api.resend.com/emails',
            headers: {
                Authorization: `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            data: {
                from: RESEND_FROM,
                to: [recipient],
                cc: ccList.length > 0 ? ccList : undefined,
                subject: safeSubject,
                text: textBody,
                html: htmlBody,
            },
            timeout: 30000,
        });
    }

    return {
        hasEmailProvider,
        sendEmailDocumentLink,
    };
}

module.exports = {
    createEmailService,
};
