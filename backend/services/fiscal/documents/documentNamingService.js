'use strict';

const fs = require('fs');
const path = require('path');
const { cleanText, onlyDigits, currentFiscalYear } = require('../shared/textHelpers');

const FISCAL_FALLBACK_DIR = path.resolve(
    process.env.LOCAL_DOCS_ROOT || path.join(process.cwd(), 'customer_documents'),
    '_recolhas_fiscais'
);

function safeFilePart(value, fallback = 'documento') {
    const clean = String(value || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return clean || fallback;
}

function sanitizeDocumentFileName(rawName) {
    const clean = String(rawName || '')
        .trim()
        .split(/[\\/]+/)
        .pop()
        .replace(/[<>:"/\\|?* -]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
    return clean || 'documento.pdf';
}

function isWindowsUncPath(value) {
    return /^\\\\[^\\]+\\[^\\]+/.test(String(value || '').trim());
}

function isWindowsDrivePath(value) {
    return /^[A-Za-z]:[\\/]/.test(String(value || '').trim());
}

function normalizeWindowsPathForCompare(value) {
    return String(value || '').trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
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
    return String(value || '').replace(/\\040/g, ' ').replace(/\\011/g, '\t').replace(/\\012/g, '\n').replace(/\\134/g, '\\');
}

function isLinuxMountPointMounted(mountPath) {
    try {
        const target = path.resolve(String(mountPath || '').trim());
        if (!target) return false;
        const mountsRaw = fs.readFileSync('/proc/mounts', 'utf8');
        return mountsRaw.split('\n').map((line) => line.trim()).filter(Boolean)
            .map((line) => line.split(/\s+/)).filter((parts) => parts.length >= 2)
            .map((parts) => path.resolve(decodeProcMountPath(parts[1])))
            .some((mountedPath) => mountedPath === target || target.startsWith(`${mountedPath}${path.sep}`));
    } catch (_) { return false; }
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
    const storedFolder = cleanText(customer?.documentsFolder || customer?.documents_folder || customer?.documentFolder || customer?.document_folder || '');
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

function fiscalDocumentTypeLabel(documentType) {
    const key = safeFilePart(documentType || 'documento').toLowerCase();
    const labels = {
        ies: 'IES', modelo22: 'Modelo 22', modelo_22: 'Modelo 22', irs: 'IRS',
        certidao_at: 'Certidão AT', certidao_ss: 'Certidão SS',
        certidao_permanente: 'Certidão Permanente', pme: 'Certificado PME',
        bportugal: 'Responsabilidades Banco de Portugal', domicilio_fiscal: 'Domicílio Fiscal',
    };
    return labels[key] || 'Documentos';
}

function buildFiscalDownloadPath(customer, year, documentType, suggestedFilename) {
    const rootFolder = resolveCustomerDocumentsFolder(customer);
    const typeLabel = fiscalDocumentTypeLabel(documentType);
    const targetFolder = path.join(rootFolder, 'Resumo Fiscal');
    fs.mkdirSync(targetFolder, { recursive: true });
    const suggested = sanitizeDocumentFileName(suggestedFilename || '');
    const ext = path.extname(suggested).toLowerCase() || '.pdf';
    const nif = onlyDigits(customer?.nif || customer?.NIF || '') || safeFilePart(customer?.id || 'cliente');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = sanitizeDocumentFileName(`${safeFilePart(typeLabel)}_${safeFilePart(nif)}_${safeFilePart(year || currentFiscalYear())}_${stamp}${ext}`);
    return path.join(targetFolder, filename);
}

function fileNameFromContentDisposition(value) {
    const header = String(value || '');
    const utfMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (utfMatch) { try { return decodeURIComponent(utfMatch[1]); } catch (_) { return utfMatch[1]; } }
    const simpleMatch = header.match(/filename="?([^";]+)"?/i);
    return simpleMatch ? simpleMatch[1] : '';
}

function uniquePath(targetPath) {
    if (!fs.existsSync(targetPath)) return targetPath;
    const dir = path.dirname(targetPath);
    const ext = path.extname(targetPath);
    const base = path.basename(targetPath, ext);
    for (let index = 2; index < 1000; index += 1) {
        const candidate = path.join(dir, `${base}_${index}${ext}`);
        if (!fs.existsSync(candidate)) return candidate;
    }
    return path.join(dir, `${base}_${Date.now()}${ext}`);
}

module.exports = {
    safeFilePart, sanitizeDocumentFileName,
    resolveCustomerDocumentsFolder, fiscalDocumentTypeLabel,
    buildFiscalDownloadPath, fileNameFromContentDisposition, uniquePath,
};
