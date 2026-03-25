const crypto = require('crypto');

const CUSTOMER_SECRET_PREFIX = 'enc:v1:';
const CUSTOMER_SECRET_ALGORITHM = 'aes-256-gcm';
let customerSecretsKeyCache = null;
let customerSecretsNoKeyWarningShown = false;

function resolveCustomerSecretsRawKey() {
    return String(
        process.env.CUSTOMER_SECRETS_KEY ||
            process.env.CUSTOMER_CREDENTIALS_KEY ||
            process.env.MPR_CUSTOMER_SECRETS_KEY ||
            process.env.SUPABASE_KEY ||
            process.env.VITE_SUPABASE_KEY ||
            ''
    ).trim();
}

function getCustomerSecretsKey() {
    if (customerSecretsKeyCache !== null) return customerSecretsKeyCache;
    const raw = resolveCustomerSecretsRawKey();
    if (!raw) {
        if (!customerSecretsNoKeyWarningShown) {
            customerSecretsNoKeyWarningShown = true;
            console.warn('[Security] CUSTOMER_SECRETS_KEY não configurada. Cifragem local de credenciais desativada.');
        }
        customerSecretsKeyCache = undefined;
        return customerSecretsKeyCache;
    }
    customerSecretsKeyCache = crypto.createHash('sha256').update(raw, 'utf8').digest();
    return customerSecretsKeyCache;
}

function isEncryptedCustomerSecret(value) {
    return String(value || '').trim().startsWith(CUSTOMER_SECRET_PREFIX);
}

function encryptCustomerSecret(value) {
    const plain = String(value || '').trim();
    if (!plain) return '';
    if (isEncryptedCustomerSecret(plain)) return plain;
    const key = getCustomerSecretsKey();
    if (!key) return plain;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(CUSTOMER_SECRET_ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${CUSTOMER_SECRET_PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}

function decryptCustomerSecret(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (!isEncryptedCustomerSecret(raw)) return raw;
    const key = getCustomerSecretsKey();
    if (!key) return '';

    const payload = raw.slice(CUSTOMER_SECRET_PREFIX.length);
    const parts = payload.split('.');
    if (parts.length !== 3) return '';
    const [ivB64, tagB64, dataB64] = parts;
    try {
        const iv = Buffer.from(ivB64, 'base64');
        const tag = Buffer.from(tagB64, 'base64');
        const ciphertext = Buffer.from(dataB64, 'base64');
        const decipher = crypto.createDecipheriv(CUSTOMER_SECRET_ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted.toString('utf8').trim();
    } catch (error) {
        console.warn('[Security] Falha ao descodificar credencial local cifrada:', error?.message || error);
        return '';
    }
}

module.exports = {
    getCustomerSecretsKey,
    isEncryptedCustomerSecret,
    encryptCustomerSecret,
    decryptCustomerSecret
};