#!/usr/bin/env node
/**
 * Refactoring script: removes extracted function blocks from server.js
 * and adds require() + factory calls for the 6 new modules.
 *
 * This script reads server.js, removes specific line ranges, inserts
 * new require/factory code, and writes the result back.
 */
const fs = require('fs');
const path = require('path');

const serverPath = path.resolve(__dirname, '..', 'server.js');
const lines = fs.readFileSync(serverPath, 'utf8').split('\n');

console.log(`[refactor] Read ${lines.length} lines from server.js`);

// --- Helper: find the line number (0-based) of a function start ---
function findFunctionStart(name) {
    // Matches: function name(  or  async function name(
    const rx = new RegExp(`^(async\\s+)?function\\s+${name}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
        if (rx.test(lines[i])) return i;
    }
    return -1;
}

// --- Helper: from a function start line, find its closing brace ---
function findFunctionEnd(startLine) {
    let depth = 0;
    let started = false;
    for (let i = startLine; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === '{') { depth++; started = true; }
            if (ch === '}') { depth--; }
        }
        if (started && depth === 0) return i;
    }
    return -1;
}

// Build a set of lines to remove for each extracted function
const linesToRemove = new Set();

function markFunctionForRemoval(name) {
    const start = findFunctionStart(name);
    if (start === -1) {
        console.warn(`[refactor] WARNING: function "${name}" not found!`);
        return;
    }
    const end = findFunctionEnd(start);
    if (end === -1) {
        console.warn(`[refactor] WARNING: could not find end of function "${name}" starting at L${start + 1}`);
        return;
    }
    for (let i = start; i <= end; i++) {
        linesToRemove.add(i);
    }
    // Also remove trailing blank lines
    let j = end + 1;
    while (j < lines.length && lines[j].trim() === '') {
        linesToRemove.add(j);
        j++;
    }
    console.log(`[refactor] Marked "${name}" for removal: L${start + 1}-L${end + 1}`);
}

// =========================================================================
// 1. Mappers (L340-780)
// =========================================================================
const mapperFunctions = [
    'parseManagersArray',
    'parseAccessCredentialsArray',
    'serializeAccessCredentialsForStorage',
    'applyDefaultAccessCredentialUsernames',
    'foldText',
    'normalizeRelationType',
    'parseCustomerRelationLinksArray',
    'parseAgregadoFamiliarArray',
    'parseFichasRelacionadasArray',
    'extractManagersFromRawRow',
    'extractAccessCredentialsFromRawRow',
    'parseCustomerProfile',
    'buildCustomerProfileFromInput',
    'serializeCustomerProfile',
    'parseJsonObject',
    'parseJsonArray',
];
mapperFunctions.forEach(markFunctionForRemoval);

// Also remove the two const declarations for HOUSEHOLD/RELATED sets
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('const HOUSEHOLD_RELATION_TYPES = new Set(') ||
        lines[i].includes('const RELATED_RECORD_RELATION_TYPES = new Set(')) {
        linesToRemove.add(i);
        // Remove trailing blank lines
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') {
            linesToRemove.add(j);
            j++;
        }
        console.log(`[refactor] Marked const at L${i + 1} for removal`);
    }
}

// =========================================================================
// 2. Tasks + Calls
// =========================================================================
const taskFunctions = [
    'normalizeTaskStatus',
    'normalizeTaskPriority',
    'parseTaskAttachmentsArray',
    'normalizeLocalSqlTask',
    'getLocalTasks',
    'upsertLocalTask',
    'normalizeCallSource',
    'normalizeLocalSqlCall',
    'getLocalCalls',
    'upsertLocalCall',
];
taskFunctions.forEach(markFunctionForRemoval);

// =========================================================================
// 3. Conversations + Templates + Audit + Phone resolution + Outbound queue
// =========================================================================
const conversationFunctions = [
    'normalizeConversationStatus',
    'sanitizeConversationId',
    'normalizeLocalSqlConversation',
    'getAllLocalConversations',
    'getLocalConversationById',
    'getLocalConversationByCustomerId',
    // Internal helpers in the conversation block
    'extractPhoneDigitsFromConversationId',
    'phoneDigitsMatch',
    'ensureCustomerPhoneForConversationReassign',
    'mergeConversationReferences',
    'upsertLocalConversation',
    'resolveConversationAccountId',
    'normalizeCustomerNameForConflict',
    'hasDifferentCustomerNamesForPhone',
    'resolveOutboundAccountIdForPhone',
    'setConversationWhatsAppAccount',
    'findLocalCustomerByPhone',
    'shouldHydrateCustomerNameFromHint',
    'looksLikePhoneLabel',
    'ensureCustomerForPhone',
    'ensureConversationForPhone',
    'writeAuditLog',
    'normalizeTemplateKind',
    'normalizeLocalTemplate',
    'getLocalTemplates',
    'upsertLocalTemplate',
    'applyTemplateVariables',
    'enqueueOutboundMessage',
];
conversationFunctions.forEach(markFunctionForRemoval);

// =========================================================================
// 4. Document path helpers + SAFT document cache/robot (into saftService)
// =========================================================================
const saftDocPathFunctions = [
    'sanitizeDocumentFileName',
    'isWindowsUncPath',
    'isWindowsDrivePath',
    'normalizeWindowsPathForCompare',
    'decodeProcMountPath',
    'isLinuxMountPointMounted',
    'mapWindowsFolderToLinuxMount',
    'resolveCustomerDocumentsFolder',
    'resolveSaftBunkerFolder',
    'ensureWritableSaftBunkerFolder',
    'buildBunkerFileName',
    'getCachedSaftDocument',
    'upsertSaftDocumentCache',
    'normalizeSaftDocumentType',
    'saftDocumentLabel',
    'getSaftSearchTokens',
    'findLatestDocumentMatch',
    'findDocumentMatches',
    'extractYearFromFileName',
    'selectModelo22Files',
    'runSaftRobotFetch',
    'runSaftDossierMetadata',
];
saftDocPathFunctions.forEach(markFunctionForRemoval);

// =========================================================================
// 5. Customer lookup / obrigacao functions (into saftService)
// =========================================================================
const saftCustomerFunctions = [
    'findLocalCustomerRowByNifOrCompany',
    'normalizeSupabaseCustomerCandidate',
    'loadSupabaseCustomerLookup',
    'materializeLocalCustomerFromSupabase',
    'findCustomerRowForObrigacao',
    'resolveSupabaseCustomerIdFromLocalRow',
    'upsertLocalObrigacaoRecolha',
    'markLocalObrigacaoRecolhaSynced',
    'resolveObrigacaoModeloRow',
    'syncRecolhaEstadoSupabase',
    'updateObrigacaoPeriodoSupabase',
    'resolveObrigacoesPeriodTableName',
    'loadLocalCollectedSets',
    'loadSupabaseCollectedSourceIds',
];
saftCustomerFunctions.forEach(markFunctionForRemoval);

// =========================================================================
// 6. Message service functions
// =========================================================================
const messageFunctions = [
    'handleInboundAutomationReply',
    'persistInboundWhatsAppMessage',
    'moveQueueToDeadLetter',
    'markQueueAsFailed',
    'processQueueJobViaBaileys',
    'processQueueJob',
];
messageFunctions.forEach(markFunctionForRemoval);

// =========================================================================
// 7. Obrigacoes worker functions
// =========================================================================
const obrigacoesWorkerFunctions = [
    'processPendingSaftJobs',
    'bootstrapSaftWorker',
    'runObrigacoesAutoCollection',
    'scheduleNextObrigacoesAutoRun',
    'bootstrapObrigacoesAutoScheduler',
];
obrigacoesWorkerFunctions.forEach(markFunctionForRemoval);

// Also remove the state variables that belong to obrigacoesWorker
for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === 'let saftWorkerRunning = false;' ||
        trimmed === 'let saftWorkerBootstrapped = false;' ||
        trimmed === 'let obrigacoesAutoRunning = false;' ||
        trimmed === 'let obrigacoesAutoBootstrapped = false;' ||
        trimmed === 'let obrigacoesAutoTimer = null;') {
        linesToRemove.add(i);
        console.log(`[refactor] Marked variable at L${i + 1} for removal: ${trimmed}`);
    }
}

// Remove the obrigacoesAutoState declaration block
for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'const obrigacoesAutoState = {') {
        let j = i;
        let depth = 0;
        let started = false;
        while (j < lines.length) {
            for (const ch of lines[j]) {
                if (ch === '{') { depth++; started = true; }
                if (ch === '}') { depth--; }
            }
            linesToRemove.add(j);
            if (started && depth === 0) break;
            j++;
        }
        // Remove trailing blank lines
        let k = j + 1;
        while (k < lines.length && lines[k].trim() === '') {
            linesToRemove.add(k);
            k++;
        }
        console.log(`[refactor] Marked obrigacoesAutoState block at L${i + 1}-L${j + 1} for removal`);
        break;
    }
}

console.log(`[refactor] Total lines marked for removal: ${linesToRemove.size}`);

// =========================================================================
// NOW: Build the new file
// =========================================================================

// Filter out removed lines
let newLines = lines.filter((_, i) => !linesToRemove.has(i));

// --- Insert new require() statements after existing requires ---
// Find the line with "const { encryptCustomerSecret, decryptCustomerSecret } = require"
let requireInsertIndex = -1;
for (let i = 0; i < newLines.length; i++) {
    if (newLines[i].includes("require('./src/server/utils/crypto')")) {
        requireInsertIndex = i + 1;
        break;
    }
}

if (requireInsertIndex === -1) {
    console.error('[refactor] ERROR: Could not find crypto require line!');
    process.exit(1);
}

const newRequires = [
    "const { createMappers } = require('./src/server/utils/mappers');",
    "const { createTaskRepository } = require('./src/server/repositories/taskRepository');",
    "const { createConversationRepository } = require('./src/server/repositories/conversationRepository');",
    "const { createMessageService } = require('./src/server/services/messageService');",
    "const { createSaftService } = require('./src/server/services/saftService');",
    "const { createObrigacoesWorker } = require('./src/server/jobs/obrigacoesWorker');",
];

newLines.splice(requireInsertIndex, 0, ...newRequires);
console.log(`[refactor] Inserted ${newRequires.length} require() statements at line ${requireInsertIndex + 1}`);

// --- Insert mappers factory call BEFORE customerRepository factory ---
// Find the line: "const { mergeCustomersWithLocalOverrides }"
let mergeLineIndex = -1;
for (let i = 0; i < newLines.length; i++) {
    if (newLines[i].includes('const { mergeCustomersWithLocalOverrides }')) {
        mergeLineIndex = i;
        break;
    }
}

if (mergeLineIndex === -1) {
    console.error('[refactor] ERROR: Could not find mergeCustomersWithLocalOverrides line!');
    process.exit(1);
}

// Find where customerRepository factory call starts (it's before the merge line)
let customerRepoStartIndex = -1;
for (let i = 0; i < newLines.length; i++) {
    if (newLines[i].includes('sanitizeCustomerId,') &&
        newLines[i - 1]?.trim() === 'const {') {
        customerRepoStartIndex = i - 1;
        break;
    }
}

if (customerRepoStartIndex === -1) {
    // Try another pattern
    for (let i = 0; i < newLines.length; i++) {
        if (newLines[i].includes('} = createCustomerRepository({')) {
            // Find the start of this destructuring
            let j = i;
            while (j > 0 && !newLines[j].trim().startsWith('const {')) {
                j--;
            }
            customerRepoStartIndex = j;
            break;
        }
    }
}

if (customerRepoStartIndex === -1) {
    console.error('[refactor] ERROR: Could not find customerRepository factory call!');
    process.exit(1);
}

// Insert mappers factory call before customerRepository
const mappersFactory = `
// --- Mappers (extracted) ---
const mapperDeps = {
    normalizePhone,
    normalizeDigits,
    pickFirstValue,
    decryptCustomerSecret,
    encryptCustomerSecret,
};
const {
    parseManagersArray,
    parseAccessCredentialsArray,
    serializeAccessCredentialsForStorage,
    applyDefaultAccessCredentialUsernames,
    parseCustomerProfile,
    buildCustomerProfileFromInput,
    serializeCustomerProfile,
    parseJsonObject,
    parseJsonArray,
    parseAgregadoFamiliarArray,
    parseFichasRelacionadasArray,
    extractManagersFromRawRow,
    extractAccessCredentialsFromRawRow,
    foldText,
} = createMappers(mapperDeps);
`.split('\n');

newLines.splice(customerRepoStartIndex, 0, ...mappersFactory);
console.log(`[refactor] Inserted mappers factory call at line ${customerRepoStartIndex + 1}`);

// After customerRepository is created, bind the lazy deps and insert remaining factory calls.
// Find the end of mergeCustomersWithLocalOverrides block
let afterMergeIndex = -1;
for (let i = 0; i < newLines.length; i++) {
    if (newLines[i].includes('const { mergeCustomersWithLocalOverrides }')) {
        // Find closing });
        for (let j = i; j < newLines.length; j++) {
            if (newLines[j].trim() === '});') {
                afterMergeIndex = j + 1;
                break;
            }
        }
        break;
    }
}

if (afterMergeIndex === -1) {
    console.error('[refactor] ERROR: Could not find end of mergeCustomersWithLocalOverrides!');
    process.exit(1);
}

// Insert the lazy deps binding + taskRepository factory
const postCustomerRepoCode = `
// Bind lazy deps for mappers (breaks circular dependency with customerRepository)
mapperDeps.normalizeCustomerNif = normalizeCustomerNif;
mapperDeps.parseCustomerSourceId = parseCustomerSourceId;

// --- Task Repository (extracted) ---
const {
    normalizeTaskStatus,
    normalizeTaskPriority,
    parseTaskAttachmentsArray,
    normalizeLocalSqlTask,
    getLocalTasks,
    upsertLocalTask,
    normalizeCallSource,
    normalizeLocalSqlCall,
    getLocalCalls,
    upsertLocalCall,
} = createTaskRepository({
    dbAllAsync,
    dbGetAsync,
    dbRunAsync,
    parseJsonArray,
});
`.split('\n');

newLines.splice(afterMergeIndex, 0, ...postCustomerRepoCode);
console.log(`[refactor] Inserted taskRepository factory call after mergeCustomersWithLocalOverrides`);

// Now find where to insert conversation/message/saft/obrigacoes factories.
// These need to go after the WhatsApp service + Baileys setup (since conversationRepository
// needs BAILEYS_ACCOUNTS_BY_ID etc.) and after the blocked contacts block.
// Best place: right after the Baileys gateway bootstrap and email service setup,
// but BEFORE the route registrations.

// Strategy: Find the line "async function getSyncStateValue" and insert after
// RECOLHAS_ESTADO_FALLBACK_COLUMNS block + any blank lines.

// Find RECOLHAS_ESTADO_FALLBACK_COLUMNS end
let recolhasEndIndex = -1;
for (let i = 0; i < newLines.length; i++) {
    if (newLines[i].includes('const RECOLHAS_ESTADO_FALLBACK_COLUMNS = [')) {
        // Find the closing ];
        for (let j = i; j < newLines.length; j++) {
            if (newLines[j].trim() === '];') {
                recolhasEndIndex = j + 1;
                break;
            }
        }
        break;
    }
}

if (recolhasEndIndex === -1) {
    console.error('[refactor] ERROR: Could not find RECOLHAS_ESTADO_FALLBACK_COLUMNS!');
    process.exit(1);
}

// Skip blank lines
while (recolhasEndIndex < newLines.length && newLines[recolhasEndIndex].trim() === '') {
    recolhasEndIndex++;
}

// Now insert conversationRepository factory call.
// But we need resolveOutboundAccountIdForPhone first (which comes FROM conversationRepository).
// The WhatsApp service uses (...args) => resolveOutboundAccountIdForPhone(...args) which is a
// lazy reference, so it's fine.

const conversationFactory = `
// --- Conversation Repository (extracted) ---
const {
    normalizeConversationStatus,
    sanitizeConversationId,
    normalizeLocalSqlConversation,
    getAllLocalConversations,
    getLocalConversationById,
    getLocalConversationByCustomerId,
    upsertLocalConversation,
    resolveConversationAccountId,
    hasDifferentCustomerNamesForPhone,
    resolveOutboundAccountIdForPhone,
    setConversationWhatsAppAccount,
    findLocalCustomerByPhone,
    ensureCustomerForPhone,
    ensureConversationForPhone,
    writeAuditLog,
    normalizeTemplateKind,
    normalizeLocalTemplate,
    getLocalTemplates,
    upsertLocalTemplate,
    applyTemplateVariables,
    enqueueOutboundMessage,
} = createConversationRepository({
    dbAllAsync,
    dbGetAsync,
    dbRunAsync,
    normalizePhone,
    normalizeDigits,
    normalizeBoolean,
    normalizeLocalSqlCustomer,
    sanitizeIdPart,
    isBaileysProviderEnabled,
    BAILEYS_ACCOUNTS_BY_ID,
    ACTIVE_BAILEYS_DEFAULT_ACCOUNT_ID,
    ACTIVE_BAILEYS_NAME_CONFLICT_ACCOUNT_ID,
    logChatCore,
    nowIso,
    getLocalCustomerById,
    upsertLocalCustomer,
    parseContactsArray,
    CUSTOMER_TYPES,
    normalizeCustomerType,
});

// --- Message Service (extracted) ---
const {
    handleInboundAutomationReply,
    persistInboundWhatsAppMessage,
    moveQueueToDeadLetter,
    markQueueAsFailed,
    processQueueJobViaBaileys,
    processQueueJob,
} = createMessageService({
    db,
    dbRunAsync,
    dbGetAsync,
    dbAllAsync,
    ENABLE_WEBHOOK_AUTOREPLY,
    ACTIVE_WHATSAPP_PROVIDER,
    MAX_QUEUE_RETRIES,
    sendWhatsAppTextMessage,
    sendWhatsAppMenuMessage,
    isBlockedContact,
    emitChatEvent,
    logChatCore,
    nowIso,
    resolveConversationAccountId,
    ensureConversationForPhone,
    writeAuditLog,
    mobilePushService,
    pickBaileysGatewayForOutbound,
    resolveOutboundAccountIdForPhone,
});

// --- SAFT Service (extracted) ---
const {
    sanitizeDocumentFileName,
    mapWindowsFolderToLinuxMount,
    resolveCustomerDocumentsFolder,
    resolveSaftBunkerFolder,
    ensureWritableSaftBunkerFolder,
    buildBunkerFileName,
    getCachedSaftDocument,
    upsertSaftDocumentCache,
    normalizeSaftDocumentType,
    saftDocumentLabel,
    getSaftSearchTokens,
    findLatestDocumentMatch,
    findDocumentMatches,
    extractYearFromFileName,
    selectModelo22Files,
    runSaftRobotFetch,
    runSaftDossierMetadata,
    findLocalCustomerRowByNifOrCompany,
    normalizeSupabaseCustomerCandidate,
    loadSupabaseCustomerLookup,
    materializeLocalCustomerFromSupabase,
    findCustomerRowForObrigacao,
    resolveSupabaseCustomerIdFromLocalRow,
    upsertLocalObrigacaoRecolha,
    markLocalObrigacaoRecolhaSynced,
    resolveObrigacaoModeloRow,
    syncRecolhaEstadoSupabase,
    updateObrigacaoPeriodoSupabase,
    resolveObrigacoesPeriodTableName,
    loadLocalCollectedSets,
    loadSupabaseCollectedSourceIds,
} = createSaftService({
    fs,
    path,
    spawn,
    dbGetAsync,
    dbRunAsync,
    dbAllAsync,
    axios,
    nowIso,
    sanitizeIdPart,
    normalizePhone,
    normalizeDigits,
    normalizeCustomerType,
    normalizeLookupText,
    pickFirstValue,
    extractManagersFromRawRow,
    parseAgregadoFamiliarArray,
    parseFichasRelacionadasArray,
    extractAccessCredentialsFromRawRow,
    upsertLocalCustomer,
    parseCustomerSourceId,
    normalizeCustomerNif,
    fetchSupabaseTable,
    fetchSupabaseTableColumns,
    fetchSupabaseTableWithFilters,
    upsertSupabaseRow,
    patchSupabaseTableWithFilters,
    insertSupabaseRow,
    resolveSupabaseTableName,
    pickColumnByCandidates,
    buildPayloadWithExistingColumns,
    normalizeIntValue,
    parseDatePtToIso,
    classifyObrigacaoEstado,
    baseDir: __dirname,
    SAFT_EMAIL,
    SAFT_PASSWORD,
    SAFT_ROBOT_SCRIPT,
    SAFT_BUNKER_ROOT,
    SAFT_BUNKER_FALLBACK_ROOT,
    LOCAL_DOCS_ROOT,
    DOCS_WINDOWS_PREFIX,
    DOCS_LINUX_MOUNT,
    SUPABASE_URL,
    SUPABASE_KEY,
    SUPABASE_CLIENTS_SOURCE,
    SUPABASE_CLIENTS_UPDATED_AT_COLUMN,
    SUPABASE_RECOLHAS_ESCOLHA,
    SUPABASE_OBRIGACOES_PERIODOS_PREFIX,
    RECOLHAS_ESTADO_FALLBACK_COLUMNS,
});
`.split('\n');

newLines.splice(recolhasEndIndex, 0, ...conversationFactory);
console.log(`[refactor] Inserted conversation/message/saft factory calls at line ${recolhasEndIndex + 1}`);

// Now find where obrigacoesWorker factory call should go.
// It should replace the old state variables + functions that we already removed.
// Best place: right after the createQueueWorker call.
let queueWorkerEndIndex = -1;
for (let i = 0; i < newLines.length; i++) {
    if (newLines[i].includes('} = createQueueWorker({')) {
        // Find closing });
        for (let j = i; j < newLines.length; j++) {
            if (newLines[j].trim() === '});') {
                queueWorkerEndIndex = j + 1;
                break;
            }
        }
        break;
    }
}

if (queueWorkerEndIndex === -1) {
    console.error('[refactor] ERROR: Could not find createQueueWorker closing!');
    process.exit(1);
}

const obrigacoesFactory = `
// --- Obrigacoes Worker (extracted) ---
const {
    obrigacoesAutoState,
    processPendingSaftJobs,
    bootstrapSaftWorker,
    runObrigacoesAutoCollection,
    scheduleNextObrigacoesAutoRun,
    bootstrapObrigacoesAutoScheduler,
} = createObrigacoesWorker({
    axios,
    dbAllAsync,
    nowIso,
    writeAuditLog,
    resolveShiftedYearMonth,
    computeNextDailyRunAt,
    OBRIGACOES_AUTO_ENABLED,
    OBRIGACOES_AUTO_HOUR,
    OBRIGACOES_AUTO_MINUTE,
    OBRIGACOES_AUTO_TIMEZONE,
});
`.split('\n');

newLines.splice(queueWorkerEndIndex, 0, ...obrigacoesFactory);
console.log(`[refactor] Inserted obrigacoesWorker factory call after createQueueWorker`);

// --- Also need to fix the obrigacoesAutoRunning reference in route registration ---
// The registerObrigacoesAutoRoutes call uses isRunning: () => obrigacoesAutoRunning
// but that variable is now inside the worker. Use state instead.
for (let i = 0; i < newLines.length; i++) {
    if (newLines[i].includes('isRunning: () => obrigacoesAutoRunning,')) {
        newLines[i] = newLines[i].replace(
            'isRunning: () => obrigacoesAutoRunning,',
            'isRunning: () => obrigacoesAutoState.running,'
        );
        console.log(`[refactor] Fixed obrigacoesAutoRunning reference at line ${i + 1}`);
    }
}

// --- Clean up excessive blank lines (3+ consecutive → 2) ---
const finalLines = [];
let consecutiveBlanks = 0;
for (const line of newLines) {
    if (line.trim() === '') {
        consecutiveBlanks++;
        if (consecutiveBlanks <= 2) {
            finalLines.push(line);
        }
    } else {
        consecutiveBlanks = 0;
        finalLines.push(line);
    }
}

fs.writeFileSync(serverPath, finalLines.join('\n'), 'utf8');
console.log(`[refactor] Wrote ${finalLines.length} lines to server.js (was ${lines.length})`);
console.log(`[refactor] Removed ~${lines.length - finalLines.length} lines`);
