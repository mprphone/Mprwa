/**
 * SAFT Document Routes — extracted from localSyncSaftRoutes.js
 * Routes: /api/customers/:id/documents, /api/customers/:id/documents/upload,
 *         /api/customers/:id/documents/ingest, /api/customers/:id/documents/import-link,
 *         /api/customers/:id/documents/download, /api/customers/:id/documents/share-link
 */
const path = require('path');
const crypto = require('crypto');

const ORGANIZER_CORE_FOLDERS = new Set([
    'documentos oficiais',
    'resumo fiscal',
    'ocorrencias',
    'ocorrências',
]);

const ORGANIZER_SPECIAL_FOLDERS = new Set([
    'documentos repetidos',
    'documentos caducados',
]);

// Pastas geridas por outros programas externos (ex.: o programa Stands lê os
// ficheiros da pasta STOCKS). O organizador nunca deve mover, renomear ou
// apagar nada dentro destas pastas.
const ORGANIZER_EXTERNALLY_MANAGED_FOLDERS = new Set([
    'stocks',
]);
const ORGANIZER_DEFAULT_AI_LIMIT = 3;
const ORGANIZER_GEMINI_TIMEOUT_MS = 8000;

const ORGANIZER_STANDARD_FOLDERS = [
    'Documentos Oficiais',
    'Resumo Fiscal',
    'Obrigações Fiscais',
    'Encerramento de contas',
    'Ocorrencias',
    'Livro de Actas',
    'Recursos Humanos',
    'Bancos',
    'SAFT',
    'Correspondência',
    'Pagamentos',
    'Outros Documentos',
];
const ORGANIZER_STANDARD_FOLDER_FOLDS = new Set(ORGANIZER_STANDARD_FOLDERS.map((name) => organizerFold(name)));
const ORGANIZER_STANDARD_FOLDER_BY_FOLD = new Map(ORGANIZER_STANDARD_FOLDERS.map((name) => [organizerFold(name), name]));

const ORGANIZER_FOLDER_ALIASES = new Map([
    ['actas', { folder: 'Livro de Actas', theme: 'Acta', useYear: true }],
    ['atas', { folder: 'Livro de Actas', theme: 'Acta', useYear: true }],
    ['livro actas', { folder: 'Livro de Actas', theme: 'Acta', useYear: true }],
    ['livro de actas', { folder: 'Livro de Actas', theme: 'Acta', useYear: true }],
    ['financas', { folder: 'Obrigações Fiscais', theme: 'Fiscal', useYear: true }],
    ['fiscal', { folder: 'Obrigações Fiscais', theme: 'Fiscal', useYear: true }],
    ['modelo 10', { folder: 'Obrigações Fiscais', theme: 'Modelo 10', useYear: true }],
    ['modelo10', { folder: 'Obrigações Fiscais', theme: 'Modelo 10', useYear: true }],
    ['modelo 22', { folder: 'Obrigações Fiscais', theme: 'Modelo 22', useYear: true }],
    ['modelo22', { folder: 'Obrigações Fiscais', theme: 'Modelo 22', useYear: true }],
    ['declaracoes', { folder: 'Obrigações Fiscais', theme: 'Fiscal', useYear: true }],
    ['declaracoes fiscais', { folder: 'Obrigações Fiscais', theme: 'Fiscal', useYear: true }],
    ['certidoes', { folder: 'Obrigações Fiscais', theme: 'Fiscal', useYear: true }],
    ['certidoes nao divida', { folder: 'Obrigações Fiscais', theme: 'Fiscal', useYear: true }],
    ['certidoes de nao divida', { folder: 'Obrigações Fiscais', theme: 'Fiscal', useYear: true }],
    ['declaracoes nao divida', { folder: 'Obrigações Fiscais', theme: 'Fiscal', useYear: true }],
    ['encerramento contas', { folder: 'Encerramento de contas', theme: 'Encerramento', useYear: true }],
    ['encerramento de contas', { folder: 'Encerramento de contas', theme: 'Encerramento', useYear: true }],
    ['contabilidade', { folder: 'Encerramento de contas', theme: 'Encerramento', useYear: true }],
    ['balancete', { folder: 'Encerramento de contas', theme: 'Balancete', useYear: true }],
    ['balancetes', { folder: 'Encerramento de contas', theme: 'Balancete', useYear: true }],
    ['inventario', { folder: 'Encerramento de contas', theme: 'Inventario', useYear: true }],
    ['inventarios', { folder: 'Encerramento de contas', theme: 'Inventario', useYear: true }],
    ['pessoal', { folder: 'Recursos Humanos', theme: 'RH', useYear: true }],
    ['vencimentos', { folder: 'Recursos Humanos', theme: 'RH', useYear: true }],
    ['recursos humanos', { folder: 'Recursos Humanos', theme: 'RH', useYear: true }],
    ['banco', { folder: 'Bancos', theme: 'Banco', useYear: true }],
    ['bancos', { folder: 'Bancos', theme: 'Banco', useYear: true }],
    ['cartas', { folder: 'Correspondência', theme: 'Correspondencia', useYear: true }],
    ['correspondencia', { folder: 'Correspondência', theme: 'Correspondencia', useYear: true }],
    ['via ctt', { folder: 'Correspondência', theme: 'Via CTT', useYear: true }],
    ['pagamentos', { folder: 'Pagamentos', theme: 'Pagamento', useYear: true }],
    ['saft', { folder: 'SAFT', theme: 'SAFT', useYear: true }],
    ['saf-t', { folder: 'SAFT', theme: 'SAFT', useYear: true }],
    ['documentos da sociedade', { folder: 'Documentos Oficiais', theme: 'Sociedade', useYear: false }],
    ['dados empresa', { folder: 'Documentos Oficiais', theme: 'Sociedade', useYear: false }],
    ['iapmei', { folder: 'Documentos Oficiais', theme: 'IAPMEI', useYear: true }],
    ['estagio', { folder: 'Ocorrencias', theme: 'Estagio', useYear: true }],
    ['estagios', { folder: 'Ocorrencias', theme: 'Estagio', useYear: true }],
    ['estimulo emprego', { folder: 'Ocorrencias', theme: 'Estímulo Emprego', useYear: true }],
    ['iefp', { folder: 'Ocorrencias', theme: 'IEFP', useYear: true }],
    ['outros documentos', { folder: 'Outros Documentos', theme: 'Documento', useYear: false }],
    ['outros documentos ', { folder: 'Outros Documentos', theme: 'Documento', useYear: false }],
    ['outros', { folder: 'Outros Documentos', theme: 'Documento', useYear: false }],
]);

const ORGANIZER_AI_FOLDER_MAP = new Map([
    ['documentos_oficiais', 'Documentos Oficiais'],
    ['obrigacoes_fiscais', 'Obrigações Fiscais'],
    ['encerramento_contas', 'Encerramento de contas'],
    ['ocorrencias', 'Ocorrencias'],
    ['livro_actas', 'Livro de Actas'],
    ['recursos_humanos', 'Recursos Humanos'],
    ['bancos', 'Bancos'],
    ['saft', 'SAFT'],
    ['correspondencia', 'Correspondência'],
    ['pagamentos', 'Pagamentos'],
    ['outros_documentos', 'Outros Documentos'],
]);

function organizerFold(value) {
    return String(value || '')
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
}

function extractOrganizerYear(text) {
    const raw = String(text || '');
    const matches = raw.match(/\b(20[0-4]\d|19[8-9]\d)\b/g);
    if (!matches || !matches.length) return '';
    return matches[matches.length - 1];
}

function getOrganizerFolderAlias(relativePath) {
    const parts = String(relativePath || '').split('/').filter(Boolean);
    if (!parts.length) return null;
    const foldedTop = organizerFold(parts[0]);
    return ORGANIZER_FOLDER_ALIASES.get(foldedTop) || null;
}

function classifyOrganizerDocument(relativePath, fileName) {
    const folded = organizerFold(`${relativePath} ${fileName}`);
    const year = extractOrganizerYear(`${relativePath} ${fileName}`);
    const alias = getOrganizerFolderAlias(relativePath);
    let baseFolder = 'Outros Documentos';
    let theme = 'Documento';
    let documentType = '';
    let useYear = false;

    if (alias) {
        baseFolder = alias.folder;
        theme = alias.theme;
        useYear = alias.useYear;
    } else if (/\b(saft|saf-t|saftpt|ficheiro saft)\b/.test(folded)) {
        baseFolder = 'SAFT';
        theme = 'SAFT';
        useYear = true;
    } else if (/\b(ies|modelo 22|modelo22|m22|modelo 10|modelo10|m10|crc|certidao at|certidao seguranca social|certidao ss|seguranca social direta|seg social|seguranca social|vinculo|vinculos|nao divida|nao-divida|dividas? at|dividas? ss|situacao fiscal|situacao contributiva)\b/.test(folded)) {
        baseFolder = 'Obrigações Fiscais';
        theme = 'Fiscal';
        documentType = folded.includes('ies') ? 'ies' : folded.includes('modelo 22') || folded.includes('modelo22') || folded.includes('m22') ? 'modelo_22' : '';
        useYear = true;
    } else if (/\b(certidao permanente|certidao comercial|pacto social|contrato sociedade|rcbe|inicio de atividade|inicio atividade|cartao cidadao|cartao da empresa|certificado pme|arrendamento|licenca)\b/.test(folded)) {
        baseFolder = 'Documentos Oficiais';
        theme = 'Sociedade';
        if (folded.includes('certidao permanente') || folded.includes('certidao comercial')) documentType = 'certidao_permanente';
        else if (folded.includes('rcbe')) documentType = 'rcbe';
        else if (folded.includes('inicio')) documentType = 'inicio_atividade';
        else if (folded.includes('pacto') || folded.includes('contrato sociedade')) documentType = 'pacto_social';
        else if (folded.includes('cartao cidadao')) documentType = 'cartao_cidadao';
    } else if (/\b(balancete|demonstracoes?|demonstrações?|dossier fiscal|inventario|inventário|depreciacoes?|depreciações?|amortizacoes?|concilia|encerramento|fecho contas|fecho de contas|clientes fornecedores|stocs|stocks)\b/.test(folded)) {
        baseFolder = 'Encerramento de contas';
        theme = 'Encerramento';
        useYear = true;
    } else if (/\b(apoio|incentivo|prr|portugal 2030|iefp|estagio|estágio|inspecao|inspeção|plano pagamento|cessao quotas|cessão quotas|cessao de quotas|alteracao regime|alteração regime|reclamacao|reclamação)\b/.test(folded)) {
        baseFolder = 'Ocorrencias';
        theme = 'Ocorrencia';
        useYear = true;
    } else if (/\b(ata|acta|livro actas|livro de actas|assembleia)\b/.test(folded)) {
        baseFolder = 'Livro de Actas';
        theme = 'Acta';
        useYear = true;
    } else if (/\b(pessoal|recursos humanos|vencimento|salario|salário|contrato trabalho|relatorio unico|relatório único|baixa|ferias|férias|formacao|formação|trabalhador)\b/.test(folded)) {
        baseFolder = 'Recursos Humanos';
        theme = 'RH';
        useYear = true;
    } else if (/\b(banco|bancario|bancário|extrato|extracto|responsabilidades banco de portugal|emprestimo|empréstimo|financiamento|financas? bancarias?)\b/.test(folded)) {
        baseFolder = 'Bancos';
        theme = 'Banco';
        useYear = true;
    } else if (/\b(carta|correspondencia|correspondência|email|e-mail|notificacao|notificação|comunicacao|comunicação|oficio|ofício)\b/.test(folded)) {
        baseFolder = 'Correspondência';
        theme = 'Correspondencia';
        useYear = true;
    } else if (/\b(pagamento|pago|recibo|comprovativo|duc|referencia multibanco|referência multibanco|transferencia|transferência)\b/.test(folded)) {
        baseFolder = 'Pagamentos';
        theme = 'Pagamento';
        useYear = true;
    }

    const relativeFolderParts = [baseFolder];
    if (useYear && year) relativeFolderParts.push(year);
    return { baseFolder, relativeFolder: relativeFolderParts.join('/'), theme, year, documentType };
}

function buildOrganizerFileName(sourceName, classification, sanitizeDocumentFileName) {
    const ext = path.extname(sourceName);
    const sourceBase = path.basename(sourceName, ext);
    const foldedBase = organizerFold(sourceBase);
    const parts = [];
    if (classification.year && !foldedBase.includes(classification.year)) parts.push(classification.year);
    if (
        classification.theme &&
        classification.theme !== 'Documento' &&
        !foldedBase.includes(organizerFold(classification.theme))
    ) {
        parts.push(classification.theme);
    }
    parts.push(sourceBase);
    const cleanBase = sanitizeDocumentFileName(parts.join('_')).replace(/\.[^.]+$/, '');
    return `${cleanBase || sanitizeDocumentFileName(sourceBase) || 'documento'}${ext || ''}`;
}

function parseOrganizerAiJson(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return {};
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    try {
        return JSON.parse(candidate);
    } catch (_) {
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(candidate.slice(start, end + 1));
            } catch (_) {
                return {};
            }
        }
    }
    return {};
}

function cleanOrganizerTitle(value) {
    return String(value || '')
        .replace(/\.[a-z0-9]{2,5}$/i, '')
        .replace(/[\\/:*?"<>|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90);
}

function normalizeOrganizerAiAnalysis(payload, sourceName, parseDateToIso) {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const categoryKey = organizerFold(raw.categoria || raw.category || raw.pasta || '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    const folder = ORGANIZER_AI_FOLDER_MAP.get(categoryKey) || '';
    const rawDate = String(raw.data_documento || raw.data || raw.document_date || '').trim();
    const isoDate = parseDateToIso(rawDate) || '';
    const year = String(raw.ano || raw.year || extractOrganizerYear(rawDate) || (isoDate ? isoDate.slice(0, 4) : '') || '').trim();
    const title = cleanOrganizerTitle(raw.titulo_curto || raw.titulo || raw.descricao || raw.title || path.basename(sourceName, path.extname(sourceName)));
    const docType = organizerFold(raw.tipo_documento || raw.tipo || raw.document_type || '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const validityIso = parseDateToIso(raw.validade || raw.data_validade || raw.expiry || '') || '';
    const expiredByDate = validityIso ? new Date(`${validityIso}T23:59:59Z`).getTime() < Date.now() : false;
    const expired = raw.caducado === true || String(raw.caducado || '').toLowerCase() === 'true' || expiredByDate;
    const suggestedName = cleanOrganizerTitle(raw.nome_sugerido_sem_ext || raw.nome_sugerido || raw.filename || '');
    const codeRef = cleanOrganizerTitle(raw.codigo_referencia || raw.code_ref || raw.referencia || '').replace(/\s+/g, '_');
    const periodo = String(raw.periodo || raw.period || raw.quarter || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '')
        .replace(/^(T[1-4]|\d{4}-\d{2}|ANUAL)$/, (m) => m) || '';
    const nomeTitular = cleanOrganizerTitle(raw.nome_titular || raw.titular || raw.nome_pessoa || raw.nome_empresa || '');
    return {
        folder,
        year,
        isoDate,
        title,
        documentType: docType,
        validityIso,
        expired,
        suggestedName,
        codeRef,
        periodo,
        nomeTitular,
        confidence: Number(raw.confianca || raw.confidence || 0) || 0,
        raw,
    };
}

function isOrganizerAiSupportedFile(fileName) {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    return ['.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(ext);
}

function isFutureIsoDate(isoDate) {
    const iso = String(isoDate || '').trim();
    if (!iso) return false;
    const ts = new Date(`${iso}T23:59:59Z`).getTime();
    return Number.isFinite(ts) && ts >= Date.now();
}

function extractCartaoCidadaoValidityIso(extraction, parseDateToIso) {
    const raw = extraction?.raw || {};
    const rawDate = String(
        extraction?.cartaoCidadaoValidade ||
        raw.cartao_cidadao_validade ||
        raw.cc_validade ||
        raw.validade_cc ||
        raw.data_validade ||
        raw.data_fim_validade ||
        raw.fim_validade ||
        raw.expiry ||
        ''
    ).trim();
    const normalizedDate = rawDate.replace(/^(\d{1,2})\s+(\d{1,2})\s+(\d{4})$/, '$1/$2/$3');
    return parseDateToIso(normalizedDate) || '';
}

function classificationFromAiAnalysis(ai, fallbackClassification) {
    if (!ai || !ai.folder) return fallbackClassification;
    const useYear = Boolean(ai.year && !['Documentos Oficiais', 'Outros Documentos'].includes(ai.folder));
    const relativeFolder = useYear ? `${ai.folder}/${ai.year}` : ai.folder;
    const theme = ai.documentType
        ? ai.documentType.split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
        : (fallbackClassification.theme || 'Documento');
    const knownDocType = (() => {
        const type = organizerFold(ai.documentType);
        if (type.includes('certidao_permanente')) return 'certidao_permanente';
        if (type === 'rcbe' || type.includes('beneficiario_efetivo')) return 'rcbe';
        if (type.includes('inicio_atividade')) return 'inicio_atividade';
        if (type.includes('pacto_social')) return 'pacto_social';
        if (type.includes('cartao_cidadao')) return 'cartao_cidadao';
        if (type.includes('ies')) return 'ies';
        if (type.includes('modelo_22')) return 'modelo_22';
        return fallbackClassification.documentType || '';
    })();
    return {
        ...fallbackClassification,
        baseFolder: ai.folder,
        relativeFolder,
        theme,
        year: ai.year || fallbackClassification.year || '',
        documentType: knownDocType,
        ai,
    };
}

function buildOrganizerAiFileName(sourceName, classification, sanitizeDocumentFileName) {
    const ai = classification?.ai;
    if (!ai) return buildOrganizerFileName(sourceName, classification, sanitizeDocumentFileName);
    const ext = path.extname(sourceName);
    const docType = String(ai.documentType || '').trim();
    const codeRef = String(ai.codeRef || '').replace(/\s+/g, '_');
    const validPart = (ai.validityIso && !ai.expired && ai.validityIso.length >= 7)
        ? `val_${ai.validityIso.slice(0, 7)}`
        : (ai.expired ? 'caducado' : '');
    const nomeTitular = String(ai.nomeTitular || '').replace(/\s+/g, '_').slice(0, 40);

    // --- Padrões específicos por tipo ---
    if (docType === 'certidao_permanente') {
        const ref = codeRef || '';
        const validity = validPart;
        const parts = ['CP', ref, nomeTitular, validity].filter(Boolean);
        return sanitizeDocumentFileName(`${parts.join('_')}${ext}`);
    }
    if (docType === 'cartao_cidadao') {
        const name = nomeTitular || 'Titular';
        const parts = ['CC', name, validPart].filter(Boolean);
        return sanitizeDocumentFileName(`${parts.join('_')}${ext}`);
    }
    if (docType === 'rcbe') {
        const ref = codeRef || '';
        const date = ai.isoDate ? ai.isoDate.slice(0, 7) : (ai.year || '');
        const parts = ['RCBE', ref, date].filter(Boolean);
        return sanitizeDocumentFileName(`${parts.join('_')}${ext}`);
    }
    if (docType === 'inicio_atividade') {
        const date = ai.isoDate || ai.year || '';
        const parts = ['Inicio_Atividade', date].filter(Boolean);
        return sanitizeDocumentFileName(`${parts.join('_')}${ext}`);
    }
    if (docType === 'pacto_social') {
        const date = ai.isoDate || ai.year || '';
        const parts = ['Pacto_Social', date].filter(Boolean);
        return sanitizeDocumentFileName(`${parts.join('_')}${ext}`);
    }

    // --- Prefixo data+período ---
    let datePeriodPart = '';
    const periodo = String(ai.periodo || '').trim().toUpperCase();
    if (ai.isoDate) {
        datePeriodPart = ai.isoDate.slice(0, 7); // YYYY-MM
    } else if (ai.year && periodo && periodo !== 'ANUAL') {
        datePeriodPart = `${ai.year}-${periodo}`; // 2024-T1 ou 2024-01
    } else if (ai.year) {
        datePeriodPart = ai.year;
    } else {
        datePeriodPart = classification.year || '';
    }

    // --- Tipo normalizado ---
    const TYPE_LABELS = {
        modelo_22: 'Modelo_22', modelo22: 'Modelo_22',
        modelo_10: 'Modelo_10', modelo10: 'Modelo_10',
        ies: 'IES',
        declaracao_iva: 'IVA', declaracao_iva_trimestral: 'IVA', declaracao_iva_mensal: 'IVA',
        certidao_at: 'Certidao_AT', certidao_at_nao_divida: 'Certidao_AT_Nao_Divida',
        certidao_ss: 'Certidao_SS', certidao_ss_nao_divida: 'Certidao_SS_Nao_Divida',
        extrato_bancario: 'Extrato', extrato: 'Extrato',
        ata: 'Ata', acta: 'Ata',
        contrato_trabalho: 'Contrato_Trabalho',
        recibo_vencimento: 'Recibo_Vencimento',
        relatorio_unico: 'Relatorio_Unico',
    };
    const typePart = TYPE_LABELS[docType] ||
        cleanOrganizerTitle(ai.documentType || classification.theme || '').replace(/_/g, '_').replace(/\s+/g, '_') ||
        '';

    // Para o nome: se suggestedName não é redundante com typePart, usá-lo; senão usar o codeRef ou nomeTitular
    const suggestedFolded = organizerFold(ai.suggestedName || '');
    const typeFolded = organizerFold(typePart.slice(0, 8));
    const useSuggested = ai.suggestedName &&
        suggestedFolded.length > 4 &&
        !suggestedFolded.startsWith(typeFolded) &&
        !typeFolded.startsWith(suggestedFolded.slice(0, 6));
    const extraPart = useSuggested ? ai.suggestedName : (codeRef || nomeTitular || '');

    const parts = [datePeriodPart, typePart, extraPart, validPart].filter(Boolean);
    const cleanBase = sanitizeDocumentFileName(parts.join('_')).replace(/\.[^.]+$/, '');
    return `${cleanBase || sanitizeDocumentFileName(path.basename(sourceName, ext)) || 'documento'}${ext || ''}`;
}

async function fileSha1(fs, filePath) {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(filePath);
    await new Promise((resolve, reject) => {
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
}

async function uniqueDestinationPath(fs, targetDir, targetName) {
    let candidate = path.join(targetDir, targetName);
    const ext = path.extname(targetName);
    const base = path.basename(targetName, ext);
    let index = 2;
    while (index <= 200) {
        try {
            await fs.promises.access(candidate, fs.constants.F_OK);
        } catch {
            return candidate;
        }
        candidate = path.join(targetDir, `${base}_${index}${ext}`);
        index += 1;
    }
    throw new Error(`Não foi possível encontrar nome único para "${targetName}" em "${targetDir}" após 200 tentativas.`);
}

async function safeRename(fs, source, target) {
    try {
        await fs.promises.rename(source, target);
    } catch (err) {
        if (String(err?.code || '') !== 'EXDEV') throw err;
        await fs.promises.copyFile(source, target);
        const [srcStat, dstStat] = await Promise.all([fs.promises.stat(source), fs.promises.stat(target)]);
        if (srcStat.size !== dstStat.size) {
            await fs.promises.unlink(target).catch(() => {});
            throw new Error(`Cópia cross-device falhou: tamanhos divergem (${srcStat.size} vs ${dstStat.size}).`);
        }
        await fs.promises.unlink(source);
    }
}

async function removeEmptyOrganizerDirectories(fs, rootFolder, warnings = [], maxRemoved = 40) {
    // A organizacao nao deve apagar a arvore historica do cliente. Mantemos a
    // funcao como no-op para preservar compatibilidade da resposta/audit log.
    void fs;
    void rootFolder;
    void warnings;
    void maxRemoved;
    return [];
}

async function isOrganizerDirectoryEmpty(fs, dir) {
    try {
        const entries = await fs.promises.readdir(dir);
        return entries.length === 0;
    } catch (_) {
        return false;
    }
}

async function moveDirectoryContents(fs, sourceDir, targetDir, options = {}) {
    if (path.resolve(sourceDir) === path.resolve(targetDir)) return [];
    await fs.promises.mkdir(targetDir, { recursive: true });
    const moved = Array.isArray(options.moved) ? options.moved : [];
    const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : Infinity;
    const removeEmptySourceDirs = options.removeEmptySourceDirs === true;
    const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
        if (moved.length >= maxFiles) break;
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
            await moveDirectoryContents(fs, sourcePath, targetPath, { ...options, moved });
            if (removeEmptySourceDirs && await isOrganizerDirectoryEmpty(fs, sourcePath)) {
                await fs.promises.rmdir(sourcePath).catch(() => {});
            }
            continue;
        }
        if (!entry.isFile()) continue;
        const finalTargetPath = await uniqueDestinationPath(fs, targetDir, entry.name);
        await safeRename(fs, sourcePath, finalTargetPath);
        moved.push({ from: sourcePath, to: finalTargetPath });
    }
    return moved;
}

async function makeOrganizerDirectoryWritable(fs, dir) {
    try {
        await fs.promises.chmod(dir, 0o775);
    } catch (_) {
        // Nem todas as partilhas aceitam chmod; nesse caso mantemos o erro original.
    }
    let entries = [];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) {
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        await makeOrganizerDirectoryWritable(fs, path.join(dir, entry.name));
    }
}

async function removeOrganizerDirectory(fs, dir) {
    try {
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (error) {
        const code = String(error?.code || '');
        if (code !== 'EACCES' && code !== 'EPERM') throw error;
        await makeOrganizerDirectoryWritable(fs, dir);
        await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
    }
}

async function renameOrganizerDirectoryCase(fs, sourceDir, targetDir) {
    if (path.resolve(sourceDir) === path.resolve(targetDir)) return false;
    try {
        await safeRename(fs, sourceDir, targetDir);
        return true;
    } catch (_) {
        const parent = path.dirname(sourceDir);
        const tempDir = await uniqueDestinationPath(fs, parent, `.__organizer_rename_${Date.now()}`);
        await safeRename(fs, sourceDir, tempDir);
        await safeRename(fs, tempDir, targetDir);
        return true;
    }
}

async function consolidateRemainingOrganizerFolders(fs, rootFolder, warnings = [], maxFolders = 3, maxFilesPerFolder = 20) {
    const root = path.resolve(rootFolder);
    const movedFolders = [];
    const entries = await fs.promises.readdir(root, { withFileTypes: true });

    for (const entry of entries) {
        if (movedFolders.length >= maxFolders) break;
        if (!entry.isDirectory()) continue;
        const foldedName = organizerFold(entry.name);
        const sourceDir = path.join(root, entry.name);
        const alias = ORGANIZER_FOLDER_ALIASES.get(foldedName);
        const standardCanonicalName = ORGANIZER_STANDARD_FOLDER_BY_FOLD.get(foldedName) || '';
        const aliasTargetFold = alias ? organizerFold(alias.folder) : '';
        const isProtected =
            ORGANIZER_CORE_FOLDERS.has(foldedName) ||
            ORGANIZER_STANDARD_FOLDER_FOLDS.has(foldedName) ||
            ORGANIZER_SPECIAL_FOLDERS.has(foldedName) ||
            ORGANIZER_EXTERNALLY_MANAGED_FOLDERS.has(foldedName);
        if (isProtected) continue;

        let targetDir = '';
        let reason = '';
        if (standardCanonicalName && entry.name !== standardCanonicalName && foldedName === organizerFold(standardCanonicalName)) {
            try {
                const renamed = await renameOrganizerDirectoryCase(fs, sourceDir, path.join(root, standardCanonicalName));
                if (renamed) {
                    movedFolders.push({
                        from: entry.name,
                        to: standardCanonicalName,
                        reason: 'normalizar nome da pasta',
                        partial: false,
                    });
                }
            } catch (error) {
                warnings.push(`Pasta ${entry.name}: não consegui normalizar o nome (${error?.message || error}).`);
            }
            continue;
        }
        if (alias && aliasTargetFold !== foldedName) {
            targetDir = path.join(root, alias.folder);
            reason = 'alias';
        } else if (standardCanonicalName && entry.name !== standardCanonicalName) {
            targetDir = path.join(root, standardCanonicalName);
            reason = 'normalizar nome da pasta';
        }

        if (!targetDir) continue;

        try {
            await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
            let finalTargetDir = targetDir;
            if (!alias && !standardCanonicalName) {
                finalTargetDir = await uniqueDestinationPath(fs, path.dirname(targetDir), path.basename(targetDir));
            } else {
                await fs.promises.mkdir(finalTargetDir, { recursive: true });
            }
            const movedFiles = await moveDirectoryContents(fs, sourceDir, finalTargetDir, { maxFiles: maxFilesPerFolder, removeEmptySourceDirs: true });
            if (movedFiles.length === 0) {
                continue;
            }
            const sourceEmpty = await isOrganizerDirectoryEmpty(fs, sourceDir);
            if (sourceEmpty) {
                await fs.promises.rmdir(sourceDir).catch(() => {});
            }
            movedFolders.push({
                from: entry.name,
                to: path.relative(root, finalTargetDir).split(path.sep).join('/'),
                reason: sourceEmpty
                    ? `${reason} (pasta original removida)`
                    : `${reason} (parcial: ${movedFiles.length} ficheiro(s))`,
                partial: !sourceEmpty,
            });
        } catch (error) {
            warnings.push(`Pasta ${entry.name}: não consegui consolidar (${error?.message || error}).`);
        }
    }

    return movedFolders;
}

function normalizeUploadFileName(rawName) {
    return String(rawName || '')
        .trim()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, '_')
        .replace(/[<>:"/\\|?*]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 180) || 'documento';
}

function registerSaftDocumentRoutes(context, helpers) {
    const {
        app, dbRunAsync, dbGetAsync, dbAllAsync, writeAuditLog,
        getLocalCustomerById, resolveCustomerDocumentsFolder,
        fs, sanitizeDocumentFileName,
        nowIso, API_PUBLIC_BASE_URL,
        SUPABASE_CLIENTS_SOURCE,
        parseCustomerSourceId,
        upsertLocalCustomer,
        fetchSupabaseTableColumns,
        patchSupabaseTableWithFilters,
        upsertSupabaseRow,
    } = context;
    const {
        hasConfiguredCustomerFolder,
        normalizeRelativeFolderPath,
        resolveDocsTargetFolder,
        ensureWritableFolderTree,
        guessMimeType,
        normalizeCustomerIngestDocumentType,
        extractCustomerDocumentWithGemini,
        buildIngestDocumentFileName,
        findLocalCustomerByNifDigits,
        buildSuggestedCustomerFromExtraction,
        normalizeNifDigits,
        parseDateToIso,
        toPtDate,
        normalizeExtractionManagers,
        mergeManagers,
        buildPublicBaseUrl: buildPublicBaseUrlHelper,
        hasSupabaseCustomersSync,
        findSupabaseCustomerRow,
        materializeSupabaseRowLocally,
        bumpCustomersSyncWatermark,
        buildSupabaseCustomerPayloadFromLocal,
        CUSTOMER_INGEST_DOC_TYPES,
    } = helpers;
    let organizerAiCacheReady = false;
    let organizerUndoReady = false;

    async function ensureOrganizerUndoTable() {
        if (organizerUndoReady) return;
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS customer_document_organizer_undo (
                customer_id TEXT PRIMARY KEY,
                manifest_json TEXT NOT NULL,
                organized_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        organizerUndoReady = true;
    }

    async function saveOrganizerUndoManifest(customerId, moves) {
        await ensureOrganizerUndoTable();
        await dbRunAsync(
            `INSERT INTO customer_document_organizer_undo (customer_id, manifest_json, organized_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(customer_id) DO UPDATE SET manifest_json = excluded.manifest_json, organized_at = excluded.organized_at`,
            [String(customerId), JSON.stringify(moves)]
        );
    }

    async function loadOrganizerUndoManifest(customerId) {
        await ensureOrganizerUndoTable();
        const row = await dbGetAsync(
            `SELECT manifest_json FROM customer_document_organizer_undo WHERE customer_id = ? LIMIT 1`,
            [String(customerId)]
        );
        if (!row) return null;
        try { return JSON.parse(row.manifest_json || '[]'); } catch (_) { return null; }
    }

    async function updateFiscalSummaryFromAiAnalysis({ customerId, filePath, aiAnalysis, classification, warnings }) {
        const docType = classification?.documentType || '';
        const FISCAL_TYPES = ['certidao_permanente', 'rcbe', 'inicio_atividade', 'pacto_social', 'cartao_cidadao'];
        if (!docType || !FISCAL_TYPES.includes(docType)) return { updatedSummary: false };

        const ai = aiAnalysis || {};
        const validityIso = String(ai.validityIso || '').trim();
        const isoDate = String(ai.isoDate || '').trim();
        const codeRef = String(ai.codeRef || '').trim();
        const nomeTitular = String(ai.nomeTitular || '').trim();

        const requiresFutureValidity = docType === 'certidao_permanente' || docType === 'cartao_cidadao';
        const isValidNow = validityIso ? new Date(`${validityIso}T23:59:59Z`).getTime() >= Date.now() : !requiresFutureValidity;

        if (requiresFutureValidity && !isValidNow) {
            if (warnings) warnings.push(`${path.basename(filePath)}: ignorado no resumo fiscal — documento caducado ou sem validade futura.`);
            return { updatedSummary: false, expired: true };
        }

        try {
            const { mergeFiscalSummaryData } = require('../services/fiscal/config/fiscalSummaryDefaults');
            const row = await dbGetAsync('SELECT data FROM customer_fiscal_summary WHERE customer_id = ?', [customerId]);
            const current = mergeFiscalSummaryData(row?.data ? JSON.parse(row.data) : {});
            const docs = Array.isArray(current.documentos) ? [...current.documentos] : [];

            const LABELS = {
                certidao_permanente: 'Certidão Permanente',
                rcbe: 'RCBE',
                pacto_social: 'Pacto Social',
                inicio_atividade: 'Início de Atividade',
                cartao_cidadao: 'Cartão de Cidadão',
            };

            const fiscalTipo = docType === 'cartao_cidadao'
                ? `cc_${organizerFold(nomeTitular || codeRef || path.basename(filePath, path.extname(filePath))).replace(/[^a-z0-9]+/g, '_')}`
                : docType;

            const entry = {
                tipo: fiscalTipo,
                label: docType === 'cartao_cidadao'
                    ? `CC — ${nomeTitular.toUpperCase() || 'Titular'}`
                    : LABELS[docType] || docType,
                ficheiroPdf: filePath,
                valida: isValidNow,
                notas: codeRef || '',
                dataValidade: validityIso || (docType === 'inicio_atividade' ? isoDate : ''),
            };

            const idx = docs.findIndex((d) => d?.tipo === fiscalTipo);
            if (idx >= 0) docs[idx] = { ...docs[idx], ...entry };
            else docs.push(entry);

            current.documentos = docs;
            current.updatedAt = nowIso();
            await dbRunAsync(
                `INSERT INTO customer_fiscal_summary (customer_id, data, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(customer_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
                [customerId, JSON.stringify(current), current.updatedAt]
            );
            return { updatedSummary: true };
        } catch (err) {
            if (warnings) warnings.push(`${path.basename(filePath)}: falha ao atualizar resumo fiscal (${err?.message || err}).`);
            return { updatedSummary: false };
        }
    }

    async function ensureOrganizerAiCacheTable() {
        if (organizerAiCacheReady) return;
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS customer_document_organizer_ai_cache (
                file_hash TEXT PRIMARY KEY,
                file_size INTEGER,
                analysis_json TEXT NOT NULL,
                model TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        organizerAiCacheReady = true;
    }

    async function getOrganizerAiCache(fileHash, fileSize) {
        const hash = String(fileHash || '').trim();
        if (!hash) return null;
        await ensureOrganizerAiCacheTable();
        const row = await dbGetAsync(
            `SELECT analysis_json, file_size FROM customer_document_organizer_ai_cache WHERE file_hash = ? LIMIT 1`,
            [hash]
        );
        if (!row) return null;
        const storedSize = Number(row.file_size || 0);
        if (storedSize && Number(fileSize || 0) && storedSize !== Number(fileSize || 0)) return null;
        try {
            return JSON.parse(row.analysis_json || '{}');
        } catch (_) {
            return null;
        }
    }

    async function saveOrganizerAiCache(fileHash, fileSize, analysis, model = '') {
        const hash = String(fileHash || '').trim();
        if (!hash || !analysis) return;
        await ensureOrganizerAiCacheTable();
        await dbRunAsync(
            `INSERT INTO customer_document_organizer_ai_cache (file_hash, file_size, analysis_json, model, created_at, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(file_hash) DO UPDATE SET
                file_size = excluded.file_size,
                analysis_json = excluded.analysis_json,
                model = excluded.model,
                updated_at = CURRENT_TIMESTAMP`,
            [hash, Number(fileSize || 0), JSON.stringify(analysis), String(model || '')]
        );
    }

    async function markExpiredFiscalSummaryDocumentsInvalid(customerId) {
        try {
            const { mergeFiscalSummaryData } = require('../services/fiscal/config/fiscalSummaryDefaults');
            const row = await dbGetAsync('SELECT data FROM customer_fiscal_summary WHERE customer_id = ?', [customerId]);
            if (!row?.data) return 0;
            const current = mergeFiscalSummaryData(JSON.parse(row.data));
            const docs = Array.isArray(current.documentos) ? [...current.documentos] : [];
            let changed = 0;
            const nextDocs = docs.map((doc) => {
                const validadeIso = parseDateToIso(doc?.dataValidade || doc?.data_validade || '');
                if (doc?.valida === true && validadeIso && !isFutureIsoDate(validadeIso)) {
                    changed += 1;
                    return { ...doc, valida: false };
                }
                return doc;
            });
            if (!changed) return 0;
            current.documentos = nextDocs;
            current.updatedAt = nowIso();
            await dbRunAsync(
                `INSERT INTO customer_fiscal_summary (customer_id, data, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(customer_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
                [customerId, JSON.stringify(current), current.updatedAt]
            );
            return changed;
        } catch (error) {
            return 0;
        }
    }

    async function walkOrganizerFiles(rootFolder, options = {}) {
        const files = [];
        const maxFiles = Math.max(1, Math.min(1000, Number(options.maxFiles || 200) || 200));
        const skipStandardTop = options.skipStandardTop !== false;
        async function walk(currentFolder, relativeFolder = '') {
            if (files.length >= maxFiles) return;
            const entries = await fs.promises.readdir(currentFolder, { withFileTypes: true });
            for (const entry of entries) {
                if (files.length >= maxFiles) return;
                const entryRelativePath = relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name;
                const fullPath = path.join(currentFolder, entry.name);
                if (entry.isDirectory()) {
                    const topFolder = organizerFold(entryRelativePath.split('/')[0] || '');
                    if (
                        ORGANIZER_CORE_FOLDERS.has(topFolder) ||
                        ORGANIZER_SPECIAL_FOLDERS.has(topFolder) ||
                        ORGANIZER_EXTERNALLY_MANAGED_FOLDERS.has(topFolder) ||
                        (skipStandardTop && ORGANIZER_STANDARD_FOLDER_FOLDS.has(topFolder))
                    ) {
                        continue;
                    }
                    await walk(fullPath, entryRelativePath);
                    continue;
                }
                if (!entry.isFile()) continue;
                const stat = await fs.promises.stat(fullPath);
                files.push({
                    name: entry.name,
                    fullPath,
                    relativePath: entryRelativePath,
                    relativeFolder,
                    size: Number(stat.size || 0),
                    mtimeMs: Number(stat.mtimeMs || 0),
                });
            }
        }
        await walk(rootFolder, '');
        return files;
    }

    async function seedOrganizerDuplicateIndex(rootFolder, sourceFiles, hashSeen, warnings) {
        const sourcePaths = new Set(sourceFiles.map((file) => path.resolve(file.fullPath)));
        const sourceSizes = new Set(sourceFiles.map((file) => Number(file.size || 0)).filter((size) => size > 0));
        if (!sourceSizes.size) return;

        async function walk(currentFolder, relativeFolder = '') {
            const entries = await fs.promises.readdir(currentFolder, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentFolder, entry.name);
                const resolved = path.resolve(fullPath);
                const entryRelativePath = relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    const topFolder = organizerFold(entryRelativePath.split('/')[0] || '');
                    if (ORGANIZER_EXTERNALLY_MANAGED_FOLDERS.has(topFolder)) continue;
                    await walk(fullPath, entryRelativePath);
                    continue;
                }
                if (!entry.isFile() || sourcePaths.has(resolved)) continue;

                let stat;
                try {
                    stat = await fs.promises.stat(fullPath);
                } catch (_) {
                    continue;
                }
                const size = Number(stat.size || 0);
                if (!sourceSizes.has(size)) continue;

                try {
                    const hash = await fileSha1(fs, fullPath);
                    const duplicateKey = `${size}:${hash}`;
                    if (hash && !hashSeen.has(duplicateKey)) {
                        hashSeen.set(duplicateKey, entryRelativePath);
                    }
                } catch (error) {
                    warnings.push(`${entryRelativePath}: não consegui preparar comparação de duplicados (${error?.message || error}).`);
                }
            }
        }

        await walk(rootFolder, '');
    }

    function isOrganizerExpiredDocument(file, classification) {
        const folded = organizerFold(`${file.relativePath} ${file.name}`);
        if (!/\b(certidao|certificado|cartao cidadao|rcbe)\b/.test(folded)) return false;

        const dateMatches = String(`${file.relativePath} ${file.name}`).match(/\b(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})\b|\b(\d{1,2})[-_.](\d{1,2})[-_.](20\d{2})\b/g) || [];
        for (const rawDate of dateMatches) {
            const iso = parseDateToIso(rawDate.replace(/[_.]/g, '/'));
            if (!iso) continue;
            const ts = new Date(`${iso}T23:59:59Z`).getTime();
            if (Number.isFinite(ts) && ts < Date.now()) return true;
        }

        const year = Number(classification.year || 0);
        return Boolean(year && year < new Date().getUTCFullYear() - 1 && folded.includes('certidao'));
    }

    async function updateSummaryFromOrganizerDocument({ customer, customerId, filePath, fileName, documentType, warnings }) {
        if (!documentType || !CUSTOMER_INGEST_DOC_TYPES.includes(documentType)) return { updatedFields: [], expired: false };
        const ext = path.extname(fileName).toLowerCase();
        const supported = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(ext);
        if (!supported) return { updatedFields: [] };
        const stat = await fs.promises.stat(filePath);
        if (Number(stat.size || 0) > 12 * 1024 * 1024) {
            warnings.push(`${fileName}: ignorado pela IA por ter mais de 12 MB.`);
            return { updatedFields: [], expired: false };
        }

        const contentBase64 = await fs.promises.readFile(filePath, { encoding: 'base64' });
        const extraction = await extractCustomerDocumentWithGemini({
            fileName,
            mimeType: guessMimeType(fileName),
            documentType,
            contentBase64,
        });

        const updatePayload = { id: customer.id };
        const updatedFields = [];
        let expired = false;
        let summaryValid = true;
        let summaryValidityIso = '';
        if (documentType === 'certidao_permanente') {
            const currentNumero = String(customer.certidaoPermanenteNumero || customer.customerProfile?.certidaoPermanenteNumero || '').trim();
            const currentValidade = String(customer.certidaoPermanenteValidade || customer.customerProfile?.certidaoPermanenteValidade || '').trim();
            const validadeIso = parseDateToIso(extraction.certidaoPermanenteValidade || '');
            const validadePt = toPtDate(validadeIso);
            const isValidNow = isFutureIsoDate(validadeIso);
            summaryValid = isValidNow;
            summaryValidityIso = validadeIso;
            expired = Boolean(validadeIso && !isValidNow);
            if (isValidNow && !currentNumero && extraction.certidaoPermanenteCodigo) {
                updatePayload.certidaoPermanenteNumero = extraction.certidaoPermanenteCodigo;
                updatedFields.push('certidaoPermanenteNumero');
            }
            if (isValidNow && !currentValidade && validadePt) {
                updatePayload.certidaoPermanenteValidade = validadePt;
                updatedFields.push('certidaoPermanenteValidade');
            }
            if (!isValidNow) {
                warnings.push(`${fileName}: certidão permanente ignorada no resumo fiscal por estar caducada ou sem validade futura.`);
            }
        } else if (documentType === 'rcbe') {
            const currentRcbe = String(customer.rcbeNumero || customer.customerProfile?.rcbeNumero || '').trim();
            if (!currentRcbe && extraction.rcbeNumero) {
                updatePayload.rcbeNumero = extraction.rcbeNumero;
                updatedFields.push('rcbeNumero');
            }
            const currentRcbeData = String(customer.rcbeData || customer.customerProfile?.rcbeData || '').trim();
            const rcbeIso = parseDateToIso(extraction.rcbeData || extraction.dataDocumento || '');
            const rcbePt = toPtDate(rcbeIso);
            if (!currentRcbeData && rcbePt) {
                updatePayload.rcbeData = rcbePt;
                updatedFields.push('rcbeData');
            }
        } else if (documentType === 'inicio_atividade') {
            const currentInicio = String(customer.inicioAtividade || customer.customerProfile?.inicioAtividade || '').trim();
            const inicioIso = parseDateToIso(extraction.inicioAtividade || extraction.dataDocumento || '');
            const inicioPt = toPtDate(inicioIso);
            if (!currentInicio && inicioPt) {
                updatePayload.inicioAtividade = inicioPt;
                updatedFields.push('inicioAtividade');
            }
        } else if (documentType === 'cartao_cidadao') {
            summaryValidityIso = extractCartaoCidadaoValidityIso(extraction, parseDateToIso);
            summaryValid = isFutureIsoDate(summaryValidityIso);
            expired = Boolean(summaryValidityIso && !summaryValid);
            if (!summaryValid) {
                warnings.push(`${fileName}: cartão de cidadão ignorado no resumo fiscal por estar caducado ou sem validade futura.`);
            }
        }

        if (updatedFields.length > 0) {
            await upsertLocalCustomer(updatePayload);
        }

        try {
            const { mergeFiscalSummaryData } = require('../services/fiscal/config/fiscalSummaryDefaults');
            const row = await dbGetAsync('SELECT data FROM customer_fiscal_summary WHERE customer_id = ?', [customerId]);
            const current = mergeFiscalSummaryData(row?.data ? JSON.parse(row.data) : {});
            const docs = Array.isArray(current.documentos) ? [...current.documentos] : [];
            const labels = {
                certidao_permanente: 'Certidão Permanente',
                rcbe: 'RCBE',
                pacto_social: 'Pacto Social',
                inicio_atividade: 'Início de Atividade',
                cartao_cidadao: 'Cartão de Cidadão',
            };
            if (!summaryValid) {
                return { updatedFields, extraction, expired };
            }
            const fiscalDocTipo = documentType === 'cartao_cidadao'
                ? `cc_${String(extraction?.raw?.nif || extraction?.nif || '').replace(/\D+/g, '').slice(-9) || path.basename(fileName, path.extname(fileName)).replace(/\s+/g, '_')}`
                : documentType;
            const idx = docs.findIndex((doc) => doc?.tipo === fiscalDocTipo);
            const ccName = String(
                extraction?.nomePessoa ||
                extraction?.raw?.nome_pessoa ||
                extraction?.raw?.nome_completo ||
                extraction?.raw?.nome ||
                extraction?.raw?.titular ||
                ''
            ).trim().toUpperCase();
            const ccNotes = String(
                extraction?.raw?.cartao_cidadao_numero ||
                extraction?.raw?.numero_cc ||
                extraction?.raw?.cc_numero ||
                extraction?.raw?.numero_documento ||
                extraction?.raw?.nif ||
                extraction?.nif ||
                ''
            ).trim();
            const entry = {
                tipo: fiscalDocTipo,
                label: documentType === 'cartao_cidadao' ? `CC — ${ccName || 'Cidadão'}` : (labels[documentType] || documentType),
                ficheiroPdf: filePath,
                valida: summaryValid,
                notas: documentType === 'certidao_permanente' ? extraction.certidaoPermanenteCodigo || '' : documentType === 'rcbe' ? extraction.rcbeNumero || '' : documentType === 'cartao_cidadao' ? ccNotes : '',
                dataValidade: summaryValidityIso || (documentType === 'certidao_permanente' ? parseDateToIso(extraction.certidaoPermanenteValidade || '') || '' : ''),
            };
            if (idx >= 0) docs[idx] = { ...docs[idx], ...entry };
            else docs.push(entry);
            current.documentos = docs;
            current.updatedAt = nowIso();
            await dbRunAsync(
                `INSERT INTO customer_fiscal_summary (customer_id, data, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(customer_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
                [customerId, JSON.stringify(current), current.updatedAt]
            );
        } catch (summaryError) {
            warnings.push(`${fileName}: não consegui atualizar o resumo fiscal (${summaryError?.message || summaryError}).`);
        }

        return { updatedFields, extraction, expired };
    }

    async function analyzeOrganizerDocumentWithGemini({ file, filePath, customer, warnings }) {
        if (!isOrganizerAiSupportedFile(file.name)) return null;
        if (Number(file.size || 0) > 12 * 1024 * 1024) {
            warnings.push(`${file.relativePath}: IA ignorou ficheiro com mais de 12 MB.`);
            return null;
        }

        const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
        const backupApiKey = String(process.env.GEMINI_API_KEY_BACKUP || '').trim();
        const apiKeys = Array.from(new Set([apiKey, backupApiKey].map((item) => String(item || '').trim()).filter(Boolean)));
        if (!apiKeys.length) {
            warnings.push('GEMINI_API_KEY não configurado; organização ficou pelas regras locais.');
            return null;
        }

        const configuredModel = String(process.env.GEMINI_MODEL || 'gemini-flash-latest').trim();
        const fallbackModels = String(process.env.GEMINI_MODEL_FALLBACKS || '')
            .split(',')
            .map((item) => String(item || '').trim())
            .filter(Boolean);
        const modelCandidates = Array.from(new Set([configuredModel, ...fallbackModels, 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean)));
        const contentBase64 = await fs.promises.readFile(filePath, { encoding: 'base64' });
        const prompt = `Lê este documento de um cliente de gabinete de contabilidade em Portugal e ajuda a organizar o arquivo.
Devolve APENAS JSON válido, sem markdown, neste formato:
{
  "categoria": "documentos_oficiais|obrigacoes_fiscais|encerramento_contas|ocorrencias|livro_actas|recursos_humanos|bancos|saft|correspondencia|pagamentos|outros_documentos",
  "tipo_documento": "ex: certidao_permanente, modelo_10, modelo_22, ies, declaracao_iva, contrato_cessao_quotas, rcbe, inicio_atividade, pacto_social, cartao_cidadao, ata, extrato_bancario, pagamento, outro",
  "data_documento": "YYYY-MM-DD se souberes, senão vazio",
  "ano": "YYYY se souberes, senão vazio",
  "validade": "YYYY-MM-DD se o documento tiver prazo/validade, senão vazio",
  "caducado": false,
  "codigo_referencia": "código/número do documento: código CP (ex: CP123456) para certidão permanente; número RCBE; referência AT; código IES; vazio se não houver",
  "periodo": "para documentos periódicos: T1/T2/T3/T4 para trimestral, YYYY-MM para mensal; vazio se anual ou pontual",
  "nome_titular": "nome completo da pessoa para cartão de cidadão ou contrato trabalho; nome da empresa para certidão permanente; vazio para outros",
  "titulo_curto": "descrição curta em português, sem nome do cliente se for redundante",
  "nome_sugerido_sem_ext": "nome de ficheiro curto e profissional, sem extensão, incorporando data e tipo",
  "confianca": 0.0
}
Regras:
- Não inventes datas, validade nem códigos.
- Se for declaração fiscal/Modelo 10/Modelo 22/IES/certidão AT/SS: categoria=obrigacoes_fiscais.
- Documentos estruturais da empresa (certidão permanente, RCBE, pacto social, início de atividade): categoria=documentos_oficiais.
- Apoios, incentivos, inspeções e processos especiais: categoria=ocorrencias.
- Se houver data de validade passada: caducado=true.
- Para certidão permanente: codigo_referencia deve conter o código CP visível no documento.
- Para RCBE: codigo_referencia deve conter o número de registo RCBE.
- Para IVA: periodo deve ser T1/T2/T3/T4 ou YYYY-MM conforme o período coberto.
- Para cartão de cidadão: nome_titular deve ter o nome completo do titular conforme aparece no documento.
- nome_sugerido_sem_ext deve ser inteligível: "2025-03-31_Modelo_10", "2026-02_Certidao_Permanente_CP123456", "2024-T1_IVA", "CC_Joao_Silva_val_2028-12".
Contexto:
- cliente: ${customer?.company || customer?.name || ''}
- nif: ${customer?.nif || ''}
- caminho atual: ${file.relativePath}
- nome atual: ${file.name}`;

        const requestBody = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                mimeType: guessMimeType(file.name),
                                data: contentBase64,
                            },
                        },
                    ],
                },
            ],
            generationConfig: {
                temperature: 0.05,
                topP: 0.8,
            },
        };

        const attemptErrors = [];
        for (const modelName of modelCandidates) {
            for (const key of apiKeys) {
                const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(key)}`;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), ORGANIZER_GEMINI_TIMEOUT_MS);
                let response;
                try {
                    response = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(requestBody),
                        signal: controller.signal,
                    });
                } catch (fetchError) {
                    attemptErrors.push(
                        fetchError?.name === 'AbortError'
                            ? `Gemini excedeu ${Math.round(ORGANIZER_GEMINI_TIMEOUT_MS / 1000)}s`
                            : String(fetchError?.message || fetchError)
                    );
                    continue;
                } finally {
                    clearTimeout(timeout);
                }
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    attemptErrors.push(String(payload?.error?.message || `Gemini retornou ${response.status}`));
                    continue;
                }
                const text = (Array.isArray(payload?.candidates) ? payload.candidates : [])
                    .flatMap((candidate) => (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []))
                    .map((part) => String(part?.text || '').trim())
                    .filter(Boolean)
                    .join('\n')
                    .trim();
                const normalized = normalizeOrganizerAiAnalysis(parseOrganizerAiJson(text), file.name, parseDateToIso);
                if (normalized.folder || normalized.suggestedName || normalized.title) {
                    normalized.model = modelName;
                    return normalized;
                }
                attemptErrors.push('Gemini respondeu sem classificação útil.');
            }
        }
        warnings.push(`${file.relativePath}: IA não conseguiu classificar (${attemptErrors.slice(0, 2).join(' | ')}).`);
        return null;
    }

    app.get('/api/customers/:id/documents', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }
    
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.json({
                    success: true,
                    folderPath: '',
                    storageFolderPath: '',
                    configured: false,
                    files: [],
                    warning: 'Defina a pasta de documentos na ficha do cliente para listar ficheiros.',
                });
            }
            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            const { targetFolder, relativePath } = resolveDocsTargetFolder(folderPath, req.query.path || '');
            try {
                await fs.promises.access(targetFolder, fs.constants.R_OK);
            } catch (accessError) {
                const missingFolder = accessError?.code === 'ENOENT';
                return res.json({
                    success: true,
                    folderPath: configuredFolder || folderPath,
                    storageFolderPath: folderPath,
                    currentRelativePath: relativePath,
                    currentStoragePath: targetFolder,
                    canGoUp: !!relativePath,
                    entries: [],
                    configured: !!configuredFolder,
                    files: [],
                    warning: missingFolder
                        ? 'Esta pasta ainda não existe no armazenamento.'
                        : `Sem acesso de leitura a esta pasta: ${accessError?.message || accessError}`,
                });
            }

            const entries = await fs.promises.readdir(targetFolder, { withFileTypes: true });
            const items = [];
            const files = [];
            for (const entry of entries) {
                const fullPath = path.join(targetFolder, entry.name);
                const stat = await fs.promises.stat(fullPath);
                const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    items.push({
                        type: 'directory',
                        name: entry.name,
                        relativePath: childRelativePath,
                        updatedAt: stat.mtime.toISOString(),
                    });
                    continue;
                }
                if (!entry.isFile()) continue;
                const fileItem = {
                    type: 'file',
                    name: entry.name,
                    size: Number(stat.size || 0),
                    updatedAt: stat.mtime.toISOString(),
                    relativePath: childRelativePath,
                };
                items.push(fileItem);
                files.push({
                    name: entry.name,
                    size: Number(stat.size || 0),
                    updatedAt: stat.mtime.toISOString(),
                    relativePath: childRelativePath,
                });
            }

            items.sort((left, right) => {
                if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
                return String(left.name || '').localeCompare(String(right.name || ''), 'pt', { sensitivity: 'base' });
            });
            files.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
            return res.json({
                success: true,
                folderPath: configuredFolder || folderPath,
                storageFolderPath: folderPath,
                currentRelativePath: relativePath,
                currentStoragePath: targetFolder,
                canGoUp: !!relativePath,
                entries: items,
                configured: !!configuredFolder,
                files,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro ao listar documentos do cliente:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/customers/:id/documents/organize', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }

        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem pasta definida. Preencha a pasta de documentos na ficha do cliente.',
                });
            }

            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            await ensureWritableFolderTree(folderPath, folderPath);
            for (const folderName of ORGANIZER_STANDARD_FOLDERS) {
                await fs.promises.mkdir(path.join(folderPath, folderName), { recursive: true });
            }

            const dryRun = req.body?.dryRun === true;
            const renameOnly = req.body?.renameOnly === true;
            const warnings = [];
            const moved = [];
            const repeated = [];
            const expired = [];
            let movedLegacyFolders = [];
            let removedEmptyFolders = [];
            let expiredSummaryFixedCount = 0;
            const fiscalUpdates = [];
            const hashSeen = new Map();
            const maxLegacyFolders = Math.max(
                0,
                Math.min(10, Number(req.body?.maxLegacyFolders ?? 2) || 0)
            );
            const maxEmptyFolders = Math.max(
                0,
                Math.min(200, Number(req.body?.maxEmptyFolders ?? 25) || 0)
            );
            const maxFilesPerLegacyFolder = Math.max(
                1,
                Math.min(40, Number(req.body?.maxFilesPerLegacyFolder ?? 10) || 10)
            );

            if (!dryRun) {
                try {
                    movedLegacyFolders = await consolidateRemainingOrganizerFolders(
                        fs,
                        folderPath,
                        warnings,
                        maxLegacyFolders,
                        maxFilesPerLegacyFolder
                    );
                    removedEmptyFolders = await removeEmptyOrganizerDirectories(fs, folderPath, warnings, maxEmptyFolders);
                    expiredSummaryFixedCount = await markExpiredFiscalSummaryDocumentsInvalid(customerId);
                } catch (cleanupError) {
                    warnings.push(`Não consegui consolidar algumas pastas antigas: ${cleanupError?.message || cleanupError}`);
                }
            }

            const maxFiles = Math.max(
                1,
                Math.min(500, Number(req.body?.maxFiles || 40) || 40)
            );
            const files = await walkOrganizerFiles(folderPath, { maxFiles, skipStandardTop: !renameOnly });
            const truncated = files.length >= maxFiles;
            const maxAiDocuments = Math.max(
                0,
                Math.min(
                    25,
                    Number(req.body?.maxAiDocuments ?? ORGANIZER_DEFAULT_AI_LIMIT) || 0
                )
            );
            let aiDocumentsProcessed = 0;
            let aiRenamedCount = 0;
            let aiCacheHitCount = 0;

            const compareExistingDuplicates = req.body?.compareExistingDuplicates !== false;
            if (compareExistingDuplicates) {
                try {
                    await seedOrganizerDuplicateIndex(folderPath, files, hashSeen, warnings);
                } catch (indexError) {
                    warnings.push(`Não consegui preparar todos os duplicados existentes: ${indexError?.message || indexError}`);
                }
            }

            for (const file of files) {
                const sourceFullPath = path.resolve(file.fullPath);
                if (!sourceFullPath.startsWith(`${path.resolve(folderPath)}${path.sep}`)) continue;

                let classification = classifyOrganizerDocument(file.relativePath, file.name);
                let aiAnalysis = null;
                let hash = '';
                try {
                    hash = await fileSha1(fs, sourceFullPath);
                } catch (hashError) {
                    warnings.push(`${file.relativePath}: não consegui calcular duplicado/cache (${hashError?.message || hashError}).`);
                }

                if (hash && isOrganizerAiSupportedFile(file.name)) {
                    try {
                        const cachedAnalysis = await getOrganizerAiCache(hash, file.size);
                        if (cachedAnalysis) {
                            aiAnalysis = cachedAnalysis.folder
                                ? cachedAnalysis
                                : normalizeOrganizerAiAnalysis(cachedAnalysis.raw || cachedAnalysis, file.name, parseDateToIso);
                            aiAnalysis.model = cachedAnalysis.model || aiAnalysis.model || 'cache';
                            aiCacheHitCount += 1;
                        } else if (aiDocumentsProcessed < maxAiDocuments) {
                            aiDocumentsProcessed += 1;
                            aiAnalysis = await analyzeOrganizerDocumentWithGemini({
                                file,
                                filePath: sourceFullPath,
                                customer,
                                warnings,
                            });
                            if (aiAnalysis && !dryRun) {
                                await saveOrganizerAiCache(hash, file.size, aiAnalysis, aiAnalysis.model || '');
                            }
                        }
                    } catch (aiClassifyError) {
                        warnings.push(`${file.relativePath}: IA falhou ao ler documento (${aiClassifyError?.message || aiClassifyError}).`);
                    }
                }
                if (aiAnalysis) {
                    classification = classificationFromAiAnalysis(aiAnalysis, classification);
                }

                let targetRelativeFolder = renameOnly
                    ? file.relativeFolder
                    : classification.relativeFolder;
                let targetReason = aiAnalysis ? (aiAnalysis.model === 'cache' ? 'classificado pela IA em cache' : 'classificado pela IA') : 'classificado';

                if (!renameOnly) {
                    const duplicateKey = `${file.size}:${hash}`;
                    if (hash && hashSeen.has(duplicateKey)) {
                        targetRelativeFolder = 'Documentos Repetidos';
                        targetReason = `duplicado de ${hashSeen.get(duplicateKey)}`;
                    } else if (hash) {
                        hashSeen.set(duplicateKey, file.relativePath);
                    }

                    if (targetRelativeFolder !== 'Documentos Repetidos' && isOrganizerExpiredDocument(file, classification)) {
                        targetRelativeFolder = 'Documentos Caducados';
                        targetReason = 'caducado';
                    }
                    if (aiAnalysis?.expired && targetRelativeFolder !== 'Documentos Repetidos') {
                        targetRelativeFolder = 'Documentos Caducados';
                        targetReason = 'caducado pela IA';
                    }
                }

                const targetDir = path.join(folderPath, ...targetRelativeFolder.split('/').filter(Boolean).map((part) => sanitizeDocumentFileName(part)));
                const finalFileName = aiAnalysis
                    ? buildOrganizerAiFileName(file.name, classification, sanitizeDocumentFileName)
                    : buildOrganizerFileName(file.name, classification, sanitizeDocumentFileName);

                if (dryRun) {
                    const previewTargetPath = `${targetRelativeFolder ? targetRelativeFolder + '/' : ''}${finalFileName}`;
                    if (previewTargetPath !== file.relativePath) {
                        const movement = {
                            from: file.relativePath,
                            to: previewTargetPath,
                            reason: targetReason,
                            type: classification.documentType || '',
                        };
                        moved.push(movement);
                        if (aiAnalysis) aiRenamedCount += 1;
                        if (targetRelativeFolder === 'Documentos Repetidos') repeated.push(movement);
                        if (targetRelativeFolder === 'Documentos Caducados') expired.push(movement);
                    }
                    continue;
                }

                await ensureWritableFolderTree(folderPath, targetDir);
                const targetFullPath = await uniqueDestinationPath(fs, targetDir, finalFileName);
                let targetRelativePath = path.relative(folderPath, targetFullPath).split(path.sep).join('/');

                if (path.resolve(targetFullPath) === sourceFullPath) {
                    continue;
                }

                await safeRename(fs, sourceFullPath, targetFullPath);
                const movement = {
                    from: file.relativePath,
                    fromAbsolute: sourceFullPath,
                    to: targetRelativePath,
                    toAbsolute: targetFullPath,
                    reason: targetReason,
                    type: classification.documentType || '',
                };
                moved.push(movement);
                if (aiAnalysis) aiRenamedCount += 1;
                if (targetRelativeFolder === 'Documentos Repetidos') repeated.push(movement);
                if (targetRelativeFolder === 'Documentos Caducados') expired.push(movement);

                const isFiscalType = !renameOnly &&
                    classification.documentType &&
                    ['certidao_permanente', 'rcbe', 'inicio_atividade', 'pacto_social', 'cartao_cidadao'].includes(classification.documentType) &&
                    targetRelativeFolder !== 'Documentos Repetidos';

                if (isFiscalType) {
                    const isMovedToExpired = targetRelativeFolder === 'Documentos Caducados';
                    if (aiAnalysis && !isMovedToExpired) {
                        // Atualiza resumo fiscal diretamente da análise IA — sem segunda chamada API
                        try {
                            const summaryResult = await updateFiscalSummaryFromAiAnalysis({
                                customerId,
                                filePath: targetFullPath,
                                aiAnalysis,
                                classification,
                                warnings,
                            });
                            if (summaryResult.updatedSummary) {
                                fiscalUpdates.push({ file: targetRelativePath, fields: ['fiscalSummary'] });
                            }
                            if (summaryResult.expired && targetRelativeFolder !== 'Documentos Caducados') {
                                const expiredDir = path.join(folderPath, 'Documentos Caducados');
                                await ensureWritableFolderTree(folderPath, expiredDir);
                                const expiredFullPath = await uniqueDestinationPath(fs, expiredDir, path.basename(targetFullPath));
                                await safeRename(fs, targetFullPath, expiredFullPath);
                                movement.to = path.relative(folderPath, expiredFullPath).split(path.sep).join('/');
                                movement.toAbsolute = expiredFullPath;
                                movement.reason = 'caducado pela IA';
                                expired.push(movement);
                                targetRelativePath = movement.to;
                            }
                        } catch (summaryErr) {
                            warnings.push(`${targetRelativePath}: falha no resumo fiscal (${summaryErr?.message || summaryErr}).`);
                        }
                    } else if (!isMovedToExpired && aiDocumentsProcessed < maxAiDocuments) {
                        // Fallback: extração dedicada por tipo (segunda chamada IA) para atualizar ficha e resumo
                        try {
                            aiDocumentsProcessed += 1;
                            const update = await updateSummaryFromOrganizerDocument({
                                customer,
                                customerId,
                                filePath: targetFullPath,
                                fileName: path.basename(targetFullPath),
                                documentType: classification.documentType,
                                warnings,
                            });
                            if (update.expired && targetRelativeFolder !== 'Documentos Caducados') {
                                const expiredDir = path.join(folderPath, 'Documentos Caducados');
                                await ensureWritableFolderTree(folderPath, expiredDir);
                                const expiredFullPath = await uniqueDestinationPath(fs, expiredDir, path.basename(targetFullPath));
                                await safeRename(fs, targetFullPath, expiredFullPath);
                                movement.to = path.relative(folderPath, expiredFullPath).split(path.sep).join('/');
                                movement.toAbsolute = expiredFullPath;
                                movement.reason = 'caducado pela IA';
                                expired.push(movement);
                                targetRelativePath = movement.to;
                            }
                            if (Array.isArray(update.updatedFields) && update.updatedFields.length > 0) {
                                fiscalUpdates.push({ file: targetRelativePath, fields: update.updatedFields });
                            }
                        } catch (aiError) {
                            warnings.push(`${targetRelativePath}: IA não conseguiu ler/atualizar (${aiError?.message || aiError}).`);
                        }
                    }
                }
            }

            if (dryRun) {
                return res.json({
                    success: true,
                    dryRun: true,
                    folderPath: configuredFolder || folderPath,
                    scannedCount: files.length,
                    truncated,
                    wouldMoveCount: moved.length,
                    wouldMove: moved,
                    wouldRepeat: repeated,
                    wouldExpire: expired,
                    aiReadCount: aiDocumentsProcessed,
                    aiCacheHitCount,
                    aiRenamedCount,
                    warnings,
                });
            }

            try {
                if (moved.length > 0 || movedLegacyFolders.length > 0) {
                    const extraRemovedEmptyFolders = await removeEmptyOrganizerDirectories(fs, folderPath, warnings, maxEmptyFolders);
                    removedEmptyFolders.push(...extraRemovedEmptyFolders);
                }
                expiredSummaryFixedCount += await markExpiredFiscalSummaryDocumentsInvalid(customerId);
            } catch (cleanupError) {
                warnings.push(`Não consegui limpar algumas pastas antigas vazias: ${cleanupError?.message || cleanupError}`);
            }

            if (moved.length > 0) {
                await saveOrganizerUndoManifest(customerId, moved);
            }

            await writeAuditLog({
                actorUserId: req.body?.actorUserId || customer.ownerId || null,
                entityType: 'customer_documents',
                entityId: customer.id,
                action: 'organize_ai',
                details: {
                    folderPath,
                    dryRun: false,
                    renameOnly,
                    movedCount: moved.length,
                    repeatedCount: repeated.length,
                    expiredCount: expired.length,
                    aiReadCount: aiDocumentsProcessed,
                    aiCacheHitCount,
                    aiRenamedCount,
                    movedLegacyFoldersCount: movedLegacyFolders.length,
                    movedLegacyFolders,
                    removedEmptyFoldersCount: removedEmptyFolders.length,
                    removedEmptyFolders,
                    expiredSummaryFixedCount,
                    fiscalUpdates,
                    truncated,
                    warnings,
                },
            });

            return res.json({
                success: true,
                folderPath: configuredFolder || folderPath,
                storageFolderPath: folderPath,
                scannedCount: files.length,
                truncated,
                movedCount: moved.length,
                repeatedCount: repeated.length,
                expiredCount: expired.length,
                aiReadCount: aiDocumentsProcessed,
                aiCacheHitCount,
                aiRenamedCount,
                movedLegacyFoldersCount: movedLegacyFolders.length,
                movedLegacyFolders,
                removedEmptyFoldersCount: removedEmptyFolders.length,
                removedEmptyFolders,
                expiredSummaryFixedCount,
                fiscalUpdates,
                moved,
                repeated,
                expired,
                undoAvailable: moved.length > 0,
                warnings,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro ao organizar pasta do cliente:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });
    
    app.post('/api/customers/:id/documents/organize/undo', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }

        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const manifest = await loadOrganizerUndoManifest(customerId);
            if (!manifest || !Array.isArray(manifest) || manifest.length === 0) {
                return res.status(404).json({ success: false, error: 'Não existe operação de organização para anular.' });
            }

            const reverted = [];
            const skipped = [];
            const undoWarnings = [];

            for (const move of manifest) {
                const fromAbs = String(move.fromAbsolute || '').trim();
                const toAbs = String(move.toAbsolute || '').trim();
                if (!fromAbs || !toAbs) {
                    skipped.push({ move, reason: 'caminho absoluto em falta' });
                    continue;
                }
                try {
                    await fs.promises.access(toAbs, fs.constants.F_OK);
                } catch (_) {
                    skipped.push({ move, reason: 'ficheiro de destino já não existe' });
                    continue;
                }
                try {
                    await fs.promises.mkdir(path.dirname(fromAbs), { recursive: true });
                    const finalFromPath = await uniqueDestinationPath(fs, path.dirname(fromAbs), path.basename(fromAbs));
                    await safeRename(fs, toAbs, finalFromPath);
                    reverted.push({ from: move.to, to: move.from });
                } catch (revertError) {
                    undoWarnings.push(`${move.to}: não consegui reverter (${revertError?.message || revertError}).`);
                    skipped.push({ move, reason: revertError?.message || String(revertError) });
                }
            }

            if (reverted.length > 0) {
                await dbRunAsync(
                    `DELETE FROM customer_document_organizer_undo WHERE customer_id = ?`,
                    [customerId]
                );
            }

            await writeAuditLog({
                actorUserId: req.body?.actorUserId || customer.ownerId || null,
                entityType: 'customer_documents',
                entityId: customer.id,
                action: 'organize_undo',
                details: { revertedCount: reverted.length, skippedCount: skipped.length, warnings: undoWarnings },
            });

            return res.json({
                success: true,
                revertedCount: reverted.length,
                skippedCount: skipped.length,
                reverted,
                skipped: skipped.map((s) => ({ from: s.move?.from, to: s.move?.to, reason: s.reason })),
                warnings: undoWarnings,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro ao anular organização:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/customers/:id/documents/upload', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }
    
        const body = req.body || {};
        const rawFileName = String(body.fileName || '').trim();
        const ext = path.extname(rawFileName).toLowerCase();
        const baseName = path.basename(rawFileName, ext);
        const requestedFileName = sanitizeDocumentFileName(`${normalizeUploadFileName(baseName)}${ext}`);
        const contentBase64 = String(body.contentBase64 || '').trim();
        const relativePathRaw = String(body.path || '').trim();

        if (!requestedFileName || !contentBase64) {
            return res.status(400).json({ success: false, error: 'fileName e contentBase64 são obrigatórios.' });
        }
    
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem pasta definida. Preencha a pasta de documentos na ficha do cliente.',
                });
            }
            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            const { targetFolder, relativePath } = resolveDocsTargetFolder(folderPath, relativePathRaw);
            await ensureWritableFolderTree(folderPath, targetFolder);
    
            const cleanBase64 = contentBase64.includes(',') ? contentBase64.split(',')[1] : contentBase64;
            const fileBuffer = Buffer.from(cleanBase64, 'base64');
            if (!fileBuffer.length) {
                return res.status(400).json({ success: false, error: 'Conteúdo base64 inválido.' });
            }
    
            const fullPath = path.join(targetFolder, requestedFileName);
            await fs.promises.writeFile(fullPath, fileBuffer);
    
            await writeAuditLog({
                actorUserId: body.actorUserId || customer.ownerId || null,
                entityType: 'customer_document',
                entityId: customer.id,
                action: 'upload',
                details: {
                    fileName: requestedFileName,
                    size: fileBuffer.length,
                    folderPath: targetFolder,
                    relativePath,
                },
            });
    
            return res.json({
                success: true,
                fileName: requestedFileName,
                size: fileBuffer.length,
                relativePath: relativePath ? `${relativePath}/${requestedFileName}` : requestedFileName,
                folderPath: configuredFolder || folderPath,
                storageFolderPath: folderPath,
                currentStoragePath: targetFolder,
                fullPath,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro ao guardar documento do cliente:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/customers/:id/documents/ingest', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }

        const body = req.body || {};
        const documentType = normalizeCustomerIngestDocumentType(body.documentType);
        const sourceFileName = sanitizeDocumentFileName(body.fileName || '');
        const contentBase64Raw = String(body.contentBase64 || '').trim();
        const mimeType = guessMimeType(sourceFileName, body.mimeType);
        if (!documentType || !CUSTOMER_INGEST_DOC_TYPES.includes(documentType)) {
            return res.status(400).json({ success: false, error: 'Tipo de documento inválido.' });
        }
        if (!sourceFileName || !contentBase64Raw) {
            return res.status(400).json({ success: false, error: 'fileName e contentBase64 são obrigatórios.' });
        }

        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem pasta definida. Preencha a pasta de documentos na ficha do cliente.',
                });
            }

            const cleanBase64 = contentBase64Raw.includes(',') ? contentBase64Raw.split(',')[1] : contentBase64Raw;
            const fileBuffer = Buffer.from(cleanBase64, 'base64');
            if (!fileBuffer.length) {
                return res.status(400).json({ success: false, error: 'Conteúdo base64 inválido.' });
            }

            const extraction = await extractCustomerDocumentWithGemini({
                fileName: sourceFileName,
                mimeType,
                documentType,
                contentBase64: cleanBase64,
            });
            const warnings = [];
            const extractedNif = normalizeNifDigits(extraction?.nif || '');
            const currentNif = normalizeNifDigits(customer.nif || '');
            if (documentType === 'certidao_permanente' && extractedNif) {
                const existingByNif = await findLocalCustomerByNifDigits(extractedNif);
                if (existingByNif && String(existingByNif.id || '').trim() !== customerId) {
                    return res.status(409).json({
                        success: false,
                        code: 'CERTIDAO_NIF_BELONGS_OTHER_CUSTOMER',
                        error: `O NIF ${extractedNif} já existe noutra ficha (${existingByNif.company || existingByNif.name}).`,
                        existingCustomer: {
                            id: String(existingByNif.id || '').trim(),
                            name: String(existingByNif.name || '').trim(),
                            company: String(existingByNif.company || '').trim(),
                            nif: String(existingByNif.nif || '').trim(),
                        },
                        extraction,
                    });
                }

                if (currentNif && currentNif !== extractedNif) {
                    return res.status(409).json({
                        success: false,
                        code: 'CERTIDAO_NIF_NOT_FOUND',
                        error: `A certidão indica NIF ${extractedNif}, diferente da ficha atual (${currentNif}).`,
                        suggestedCustomer: buildSuggestedCustomerFromExtraction(extraction, customer),
                        extraction,
                    });
                }
            }

            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            const docsOficiaisFolder = path.join(folderPath, sanitizeDocumentFileName('Documentos Oficiais'));
            await ensureWritableFolderTree(folderPath, docsOficiaisFolder);

            const finalFileName = buildIngestDocumentFileName({
                documentType,
                sourceFileName,
                extracted: extraction,
                customer,
            });
            const fullPath = path.join(docsOficiaisFolder, finalFileName);
            await fs.promises.writeFile(fullPath, fileBuffer);

            const updatePayload = { id: customer.id };
            const updatedFields = [];
            if (documentType === 'certidao_permanente') {
                const validadeIso = parseDateToIso(extraction.certidaoPermanenteValidade);
                const validadePt = toPtDate(validadeIso);
                const hasValidDate = !!validadeIso;
                const validadeTs = hasValidDate ? new Date(`${validadeIso}T23:59:59Z`).getTime() : 0;
                const isValidNow = hasValidDate && validadeTs >= Date.now();

                // Preenche sempre os campos-base da certidão na ficha.
                if (extraction.certidaoPermanenteCodigo) {
                    updatePayload.certidaoPermanenteNumero = extraction.certidaoPermanenteCodigo;
                    updatedFields.push('certidaoPermanenteNumero');
                }
                if (validadePt) {
                    updatePayload.certidaoPermanenteValidade = validadePt;
                    updatedFields.push('certidaoPermanenteValidade');
                }

                if (!isValidNow) {
                    warnings.push('Certidão permanente sem validade futura. Foram atualizados número/validade, mas não os dados complementares.');
                } else {
                    if (extractedNif) {
                        updatePayload.nif = extractedNif;
                        updatePayload.allowNifOverwrite = true;
                        updatedFields.push('nif');
                    }
                    if (extraction.morada) {
                        updatePayload.morada = extraction.morada;
                        updatedFields.push('morada');
                    }
                    if (extraction.caePrincipal) {
                        updatePayload.caePrincipal = extraction.caePrincipal;
                        updatedFields.push('caePrincipal');
                    }
                    const incomingManagers = mergeManagers(
                        [],
                        [
                            ...normalizeExtractionManagers(extraction.managers),
                            ...(extraction.gerenteNome ? [{ name: extraction.gerenteNome, email: '', phone: '' }] : []),
                        ]
                    );
                    if (incomingManagers.length > 0) {
                        updatePayload.managers = mergeManagers(Array.isArray(customer.managers) ? customer.managers : [], incomingManagers);
                        updatedFields.push('managers');
                    }
                }
            } else if (documentType === 'inicio_atividade') {
                const inicioIso = parseDateToIso(extraction.inicioAtividade || extraction.dataDocumento || '');
                const inicioPt = toPtDate(inicioIso);
                if (inicioPt) {
                    updatePayload.inicioAtividade = inicioPt;
                    updatedFields.push('inicioAtividade');
                } else {
                    warnings.push('Data de início de atividade não identificada.');
                }
            } else if (documentType === 'rcbe') {
                if (extraction.rcbeNumero) {
                    updatePayload.rcbeNumero = extraction.rcbeNumero;
                    updatedFields.push('rcbeNumero');
                }
                const rcbeIsoFromDoc = parseDateToIso(extraction.rcbeData || extraction.dataDocumento || '');
                const rcbeIso = rcbeIsoFromDoc || nowIso().slice(0, 10);
                const rcbePt = toPtDate(rcbeIso);
                if (rcbePt) {
                    updatePayload.rcbeData = rcbePt;
                    updatedFields.push('rcbeData');
                }
                if (!rcbeIsoFromDoc) {
                    warnings.push('Data RCBE não identificada no documento. Foi usada a data de hoje.');
                }
            }

            const savedCustomer =
                updatedFields.length > 0
                    ? await upsertLocalCustomer(updatePayload)
                    : customer;

            let canonicalCustomer = savedCustomer;
            let syncedToSupabase = false;
            const syncWarnings = [];

            if (updatedFields.length > 0 && hasSupabaseCustomersSync()) {
                try {
                    const tableColumns = await fetchSupabaseTableColumns(SUPABASE_CLIENTS_SOURCE);
                    const effectiveSourceId = parseCustomerSourceId(
                        canonicalCustomer?.id || customer.id,
                        canonicalCustomer?.sourceId || customer.sourceId || ''
                    );
                    const supabaseMatch = await findSupabaseCustomerRow({
                        columns: tableColumns,
                        sourceId: effectiveSourceId,
                        nif: canonicalCustomer?.nif || customer.nif || '',
                        phone: canonicalCustomer?.phone || customer.phone || '',
                        email: canonicalCustomer?.email || customer.email || '',
                    });
                    const columnsMeta = supabaseMatch.columnsMeta || {};
                    const payload = buildSupabaseCustomerPayloadFromLocal(canonicalCustomer, tableColumns);

                    let returnedRows = [];
                    if (supabaseMatch?.row && columnsMeta?.idColumn && effectiveSourceId) {
                        returnedRows = await patchSupabaseTableWithFilters(
                            SUPABASE_CLIENTS_SOURCE,
                            payload,
                            { [columnsMeta.idColumn]: effectiveSourceId }
                        );
                    } else if (supabaseMatch?.row && columnsMeta?.nifColumn && canonicalCustomer?.nif) {
                        returnedRows = await patchSupabaseTableWithFilters(
                            SUPABASE_CLIENTS_SOURCE,
                            payload,
                            { [columnsMeta.nifColumn]: canonicalCustomer.nif }
                        );
                    } else {
                        const payloadForInsert = { ...payload };
                        if (columnsMeta?.idColumn && effectiveSourceId) {
                            payloadForInsert[columnsMeta.idColumn] = effectiveSourceId;
                        }
                        returnedRows = await upsertSupabaseRow(
                            SUPABASE_CLIENTS_SOURCE,
                            payloadForInsert,
                            columnsMeta?.idColumn && effectiveSourceId ? [columnsMeta.idColumn] : []
                        );
                    }

                    if ((!Array.isArray(returnedRows) || returnedRows.length === 0)) {
                        const freshMatch = await findSupabaseCustomerRow({
                            columns: tableColumns,
                            sourceId: effectiveSourceId,
                            nif: canonicalCustomer?.nif || customer.nif || '',
                            phone: canonicalCustomer?.phone || customer.phone || '',
                            email: canonicalCustomer?.email || customer.email || '',
                        });
                        if (freshMatch?.row) {
                            returnedRows = [freshMatch.row];
                        }
                    }

                    if (Array.isArray(returnedRows) && returnedRows.length > 0) {
                        canonicalCustomer = await materializeSupabaseRowLocally(returnedRows[0], canonicalCustomer.id);
                        if (columnsMeta?.updatedAtColumn) {
                            await bumpCustomersSyncWatermark(returnedRows, columnsMeta.updatedAtColumn);
                        }
                    }

                    syncedToSupabase = true;
                } catch (syncError) {
                    const errorMessage = String(syncError?.message || syncError);
                    const errorPayload = syncError?.response?.data;
                    const errorDetails =
                        errorPayload && typeof errorPayload === 'object'
                            ? JSON.stringify(errorPayload)
                            : String(errorPayload || '').trim();
                    syncWarnings.push(
                        `Falha a sincronizar no Supabase: ${errorMessage}${errorDetails ? ` | ${errorDetails}` : ''}`
                    );
                }
            }

            await writeAuditLog({
                actorUserId: body.actorUserId || customer.ownerId || null,
                entityType: 'customer_document',
                entityId: customer.id,
                action: 'ingest_ai',
                details: {
                    documentType,
                    sourceFileName,
                    storedFileName: finalFileName,
                    storedPath: fullPath,
                    updatedFields,
                    warnings: [...warnings, ...syncWarnings],
                    extractedNif: extractedNif || null,
                    syncedToSupabase,
                },
            });

            // Actualizar Resumo Fiscal "Outros Documentos" com o ficheiro guardado
            const FISCAL_DOC_LABELS = {
                certidao_permanente: 'Certidão Permanente',
                rcbe: 'RCBE',
                pacto_social: 'Pacto Social',
                inicio_atividade: 'Início de Atividade',
                cartao_cidadao: 'Cartão de Cidadão',
            };
            // Para CC: usar tipo único por sócio (cc_{nif})
            // Fallback para o NIF extraído pela IA se managerNif não foi enviado
            const managerNif = String(body.managerNif || (documentType === 'cartao_cidadao' ? extractedNif : '') || '').trim().replace(/\D+/g, '').slice(-9);
            const fiscalDocTipo = (documentType === 'cartao_cidadao' && managerNif)
                ? `cc_${managerNif}` : documentType;
            // Usar nome extraído pela IA se disponível (em vez do NIF)
            const extractedName = String(
                extraction.nomePessoa || extraction.raw?.nome_pessoa || extraction.raw?.nome_completo || extraction.raw?.nome || extraction.raw?.titular || ''
            ).trim().toUpperCase();
            const fiscalDocLabel = (documentType === 'cartao_cidadao')
                ? `CC — ${extractedName || managerNif || 'Cidadão'}`
                : (FISCAL_DOC_LABELS[documentType] || documentType);

            if (FISCAL_DOC_LABELS[documentType]) {
                try {
                    const { mergeFiscalSummaryData } = require('../services/fiscal/config/fiscalSummaryDefaults');
                    const row = await dbGetAsync('SELECT data FROM customer_fiscal_summary WHERE customer_id = ?', [customerId]);
                    const current = mergeFiscalSummaryData(row?.data ? JSON.parse(row.data) : {});
                    const docs = Array.isArray(current.documentos) ? [...current.documentos] : [];
                    const idx = docs.findIndex((d) => d?.tipo === fiscalDocTipo);
                    // Extrair validade e notas por tipo de documento
                    const entryDataValidade = (() => {
                        if (documentType === 'certidao_permanente')
                            return parseDateToIso(extraction.certidaoPermanenteValidade || '') || '';
                        if (documentType === 'cartao_cidadao') {
                            return extractCartaoCidadaoValidityIso(extraction, parseDateToIso);
                        }
                        return '';
                    })();
                    const requiresFutureValidity = documentType === 'certidao_permanente' || documentType === 'cartao_cidadao';
                    const entryIsValid = requiresFutureValidity ? isFutureIsoDate(entryDataValidade) : true;
                    if (requiresFutureValidity && !entryIsValid) {
                        warnings.push(`${fiscalDocLabel} não foi atualizado no resumo fiscal porque está caducado ou não tem validade futura.`);
                        throw new Error('Documento com validade caducada/ausente ignorado no resumo fiscal.');
                    }
                    const entryNotas = (() => {
                        if (documentType === 'rcbe') return extraction.rcbeNumero || '';
                        if (documentType === 'certidao_permanente') return extraction.certidaoPermanenteCodigo || '';
                        if (documentType === 'cartao_cidadao') {
                            const raw = extraction.raw || {};
                            // Número CC extraído pela IA, senão NIF do titular como fallback
                            return String(raw.cartao_cidadao_numero || raw.numero_cc || raw.cc_numero || raw.numero_documento || raw.nif || '').trim();
                        }
                        return '';
                    })();
                    const entry = {
                        tipo: fiscalDocTipo,
                        label: fiscalDocLabel,
                        ficheiroPdf: fullPath,
                        valida: entryIsValid,
                        notas: entryNotas,
                        dataValidade: entryDataValidade,
                    };
                    if (idx >= 0) docs[idx] = { ...docs[idx], ...entry };
                    else docs.push(entry);
                    current.documentos = docs;
                    current.updatedAt = new Date().toISOString();
                    await dbRunAsync(
                        `INSERT INTO customer_fiscal_summary (customer_id, data, updated_at)
                         VALUES (?, ?, ?)
                         ON CONFLICT(customer_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
                        [customerId, JSON.stringify(current), current.updatedAt]
                    );
                } catch (summaryErr) {
                    console.error('[Ingest] Falha ao actualizar resumo fiscal:', summaryErr?.message);
                }
            }

            await markExpiredFiscalSummaryDocumentsInvalid(customerId);

            return res.json({
                success: true,
                documentType,
                savedDocument: {
                    fileName: finalFileName,
                    relativePath: `Documentos Oficiais/${finalFileName}`,
                    fullPath,
                    folderPath: configuredFolder || folderPath,
                },
                updatedFields,
                warnings: [...warnings, ...syncWarnings],
                extraction,
                syncedToSupabase,
                customer: canonicalCustomer || savedCustomer,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro no ingest de documento com IA:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/customers/:id/documents/import-link', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Cliente inválido.' });
        }

        const body = req.body || {};
        const sourceUrl = String(body.url || '').trim();
        const requestedFileName = sanitizeDocumentFileName(body.fileName);
        const relativePathRaw = String(body.path || '').trim();
        if (!sourceUrl) {
            return res.status(400).json({ success: false, error: 'url é obrigatório.' });
        }

        try {
            const parsedUrl = new URL(sourceUrl);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return res.status(400).json({ success: false, error: 'URL inválido (apenas http/https).' });
            }

            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem pasta definida. Preencha a pasta de documentos na ficha do cliente.',
                });
            }

            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            const { targetFolder, relativePath } = resolveDocsTargetFolder(folderPath, relativePathRaw);
            await ensureWritableFolderTree(folderPath, targetFolder);

            const upstreamResponse = await fetch(sourceUrl);
            if (!upstreamResponse.ok) {
                return res.status(502).json({
                    success: false,
                    error: `Falha ao descarregar documento (${upstreamResponse.status}).`,
                });
            }

            const arrayBuffer = await upstreamResponse.arrayBuffer();
            const fileBuffer = Buffer.from(arrayBuffer);
            if (!fileBuffer.length) {
                return res.status(400).json({ success: false, error: 'Conteúdo remoto vazio.' });
            }

            const contentDisposition = String(upstreamResponse.headers.get('content-disposition') || '');
            const contentDispositionMatch = contentDisposition.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
            const headerName = sanitizeDocumentFileName(contentDispositionMatch?.[1] || '');
            const urlName = sanitizeDocumentFileName(path.basename(parsedUrl.pathname || ''));
            const finalFileName = requestedFileName || headerName || urlName || `ficheiro_${Date.now()}.bin`;
            const fullPath = path.join(targetFolder, finalFileName);

            await fs.promises.writeFile(fullPath, fileBuffer);

            await writeAuditLog({
                actorUserId: body.actorUserId || customer.ownerId || null,
                entityType: 'customer_document',
                entityId: customer.id,
                action: 'import_link',
                details: {
                    fileName: finalFileName,
                    size: fileBuffer.length,
                    sourceUrl,
                    folderPath: targetFolder,
                    relativePath,
                },
            });

            return res.json({
                success: true,
                fileName: finalFileName,
                size: fileBuffer.length,
                relativePath: relativePath ? `${relativePath}/${finalFileName}` : finalFileName,
                folderPath: configuredFolder || folderPath,
                storageFolderPath: folderPath,
                currentStoragePath: targetFolder,
                fullPath,
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro ao importar link para documento do cliente:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });
    
    app.get('/api/customers/:id/documents/download', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const requestedName = sanitizeDocumentFileName(req.query.name || '');
        const requestedPath = String(req.query.path || '').trim();
        if (!customerId || (!requestedName && !requestedPath)) {
            return res.status(400).json({ success: false, error: 'Parâmetros inválidos.' });
        }
    
        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem pasta definida. Preencha a pasta de documentos na ficha do cliente.',
                });
            }
            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            let fullPath = '';
            let downloadName = requestedName;
            if (requestedPath) {
                const safeRelativePath = normalizeRelativeFolderPath(requestedPath);
                if (!safeRelativePath) {
                    return res.status(400).json({ success: false, error: 'Caminho inválido.' });
                }
                fullPath = path.resolve(folderPath, safeRelativePath);
                downloadName = sanitizeDocumentFileName(path.basename(safeRelativePath));
            } else {
                fullPath = path.resolve(folderPath, requestedName);
            }
            const folderNormalized = path.resolve(folderPath);
            if (!fullPath.startsWith(folderNormalized + path.sep) && fullPath !== path.join(folderNormalized, downloadName)) {
                return res.status(400).json({ success: false, error: 'Nome de ficheiro inválido.' });
            }
    
            await fs.promises.access(fullPath, fs.constants.R_OK);
            if (String(req.query.download || '').trim() === '1') {
                return res.download(fullPath, downloadName);
            }

            res.setHeader('Content-Type', guessMimeType(downloadName));
            res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(downloadName)}"`);
            return res.sendFile(fullPath);
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro ao descarregar documento do cliente:', details);
            return res.status(404).json({ success: false, error: 'Ficheiro não encontrado.' });
        }
    });

    app.get('/api/customers/:id/documents/share-link', async (req, res) => {
        const customerId = String(req.params.id || '').trim();
        const requestedPath = String(req.query.path || '').trim();
        if (!customerId || !requestedPath) {
            return res.status(400).json({ success: false, error: 'Parâmetros inválidos.' });
        }

        try {
            const customer = await getLocalCustomerById(customerId);
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }
            const configuredFolder = String(customer.documentsFolder || '').trim();
            if (!configuredFolder) {
                return res.status(400).json({
                    success: false,
                    error: 'Este cliente não tem pasta definida.',
                });
            }
            const folderPath = resolveCustomerDocumentsFolder(customer.id, configuredFolder);
            const safeRelativePath = normalizeRelativeFolderPath(requestedPath);
            const fullPath = path.resolve(folderPath, safeRelativePath);
            const folderNormalized = path.resolve(folderPath);
            if (fullPath !== folderNormalized && !fullPath.startsWith(`${folderNormalized}${path.sep}`)) {
                return res.status(400).json({ success: false, error: 'Caminho inválido.' });
            }
            await fs.promises.access(fullPath, fs.constants.R_OK);

            const baseUrl = buildPublicBaseUrlHelper(req);
            const query = new URLSearchParams({ path: safeRelativePath });
            const url = `${baseUrl}/api/customers/${encodeURIComponent(customer.id)}/documents/download?${query.toString()}`;
            return res.json({
                success: true,
                url,
                fileName: sanitizeDocumentFileName(path.basename(safeRelativePath)),
                relativePath: safeRelativePath,
            });
        } catch (error) {
            const details = error?.message || error;
            return res.status(500).json({ success: false, error: details });
        }
    });
    
}

module.exports = { registerSaftDocumentRoutes };
