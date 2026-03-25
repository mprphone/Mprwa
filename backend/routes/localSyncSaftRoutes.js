function registerLocalSyncSaftRoutes(context) {
    const {
        app,
        db,
        dbRunAsync,
        dbGetAsync,
        dbAllAsync,
        SUPABASE_URL,
        SUPABASE_KEY,
        SUPABASE_CLIENTS_SOURCE,
        SUPABASE_CLIENTS_UPDATED_AT_COLUMN,
        API_PUBLIC_BASE_URL,
        SMTP_CC_FALLBACK,
        parseSourceId,
        sanitizeRoleValue,
        upsertLocalUser,
        writeAuditLog,
        parseCustomerSourceId,
        parseAgregadoFamiliarArray,
        parseFichasRelacionadasArray,
        upsertLocalCustomer,
        fetchSupabaseTable,
        fetchSupabaseTableColumns,
        fetchSupabaseTableWithFilters,
        patchSupabaseTableWithFilters,
        upsertSupabaseRow,
        getSyncStateValue,
        setSyncStateValue,
        fetchSupabaseTableSince,
        normalizeSupabaseCustomerCandidate,
        resolveCustomerDocumentsFolder,
        fs,
        path,
        sanitizeDocumentFileName,
        getLocalCustomerById,
        ensureWritableSaftBunkerFolder,
        getSaftSearchTokens,
        getCachedSaftDocument,
        upsertSaftDocumentCache,
        buildBunkerFileName,
        nowIso,
        findDocumentMatches,
        selectModelo22Files,
        runSaftRobotFetch,
        runSaftDossierMetadata,
        normalizeSaftDocumentType,
        saftDocumentLabel,
        sendWhatsAppDocumentLink,
        hasEmailProvider,
        sendEmailDocumentLink,
    } = context;
    const SAFT_COMPANY_DOC_TYPES = [
        'declaracao_nao_divida',
        'ies',
        'modelo_22',
        'certidao_permanente',
        'certificado_pme',
        'crc',
    ];
    const CUSTOMER_INGEST_DOC_TYPES = [
        'certidao_permanente',
        'pacto_social',
        'inicio_atividade',
        'rcbe',
        'cartao_cidadao',
        'outros',
    ];
    const FOUR_MONTHS_MS = 1000 * 60 * 60 * 24 * 122;
    const SUPABASE_CLIENTS_CREDENTIALS_SOURCE = String(
        process.env.SUPABASE_CLIENTS_CREDENTIALS_SOURCE || 'clientes_credenciais'
    )
        .trim();
    let isFinancasAutologinRunning = false;

    function hasConfiguredCustomerFolder(customer) {
        return String(customer?.documentsFolder || '').trim().length > 0;
    }

    function normalizeFold(value) {
        return String(value || '')
            .trim()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
    }

    function isRegularizadaStatus(value) {
        return normalizeFold(value).includes('regularizad');
    }

    function hasSupabaseCustomersSync() {
        return !!(SUPABASE_URL && SUPABASE_KEY && SUPABASE_CLIENTS_SOURCE);
    }

    function hasSupabaseCustomerCredentialsSync() {
        return hasSupabaseCustomersSync() && !!SUPABASE_CLIENTS_CREDENTIALS_SOURCE;
    }

    function isUuidLike(value) {
        const raw = String(value || '').trim();
        if (!raw) return false;
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
    }

    function normalizeRelativeFolderPath(rawValue) {
        const raw = String(rawValue || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!raw) return '';
        const parts = raw
            .split('/')
            .map((part) => String(part || '').trim())
            .filter(Boolean)
            .map((part) => sanitizeDocumentFileName(part));
        if (parts.some((part) => !part || part === '.' || part === '..')) {
            throw new Error('Subpasta inválida.');
        }
        return parts.join('/');
    }

    function resolveDocsTargetFolder(rootFolderPath, rawRelativePath = '') {
        const root = path.resolve(String(rootFolderPath || '').trim());
        if (!root) throw new Error('Pasta base do cliente inválida.');
        const relativePath = normalizeRelativeFolderPath(rawRelativePath);
        const targetFolder = relativePath ? path.resolve(root, relativePath) : root;
        if (targetFolder !== root && !targetFolder.startsWith(`${root}${path.sep}`)) {
            throw new Error('Subpasta inválida.');
        }
        return { rootFolder: root, targetFolder, relativePath };
    }

    async function ensureWritableFolderTree(rootFolderPath, targetFolderPath) {
        const rootFolder = path.resolve(String(rootFolderPath || '').trim());
        const targetFolder = path.resolve(String(targetFolderPath || '').trim());
        if (!rootFolder || !targetFolder) {
            throw new Error('Pasta inválida.');
        }
        if (targetFolder !== rootFolder && !targetFolder.startsWith(`${rootFolder}${path.sep}`)) {
            throw new Error('Subpasta inválida.');
        }

        const relative = path.relative(rootFolder, targetFolder);
        if (relative.startsWith('..')) {
            throw new Error('Subpasta inválida.');
        }

        const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
        const folders = [rootFolder];
        let current = rootFolder;
        for (const segment of segments) {
            current = path.join(current, segment);
            folders.push(current);
        }

        for (const folder of folders) {
            await fs.promises.mkdir(folder, { recursive: true });
            try {
                await fs.promises.chmod(folder, 0o775);
            } catch (chmodError) {
                // Best-effort em shares SMB/CIFS: pode falhar conforme ACL remota.
            }
        }
    }

    function buildPublicBaseUrl(req) {
        const configured = String(API_PUBLIC_BASE_URL || '').trim();
        if (configured) return configured.replace(/\/+$/, '');
        const protocol = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        return `${protocol}://${host}`.replace(/\/+$/, '');
    }

    function normalizeNifDigits(value) {
        return String(value || '').replace(/\D/g, '').slice(-9);
    }

    const HOUSEHOLD_RELATION_TYPES = new Set(['conjuge', 'filho', 'pai', 'outro']);
    const RELATED_RECORD_RELATION_TYPES = new Set(['funcionario', 'amigo', 'familiar', 'gerente', 'socio', 'outro']);
    const UUID_LIKE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    function normalizeMeaningfulText(value) {
        const text = String(value || '').trim();
        if (!text) return '';
        const folded = normalizeFold(text);
        if (folded === 'undefined' || folded === 'null' || folded === 'nan') return '';
        return text;
    }

    function normalizeHouseholdRelationType(value) {
        const folded = normalizeFold(value);
        if (!folded) return 'outro';
        if (HOUSEHOLD_RELATION_TYPES.has(folded)) return folded;
        if (
            folded.startsWith('espos') ||
            folded.startsWith('marid') ||
            folded.includes('wife') ||
            folded.includes('husband') ||
            folded.includes('conjuge')
        ) {
            return 'conjuge';
        }
        if (folded.startsWith('filh')) return 'filho';
        if (folded === 'pai' || folded === 'mae' || folded.startsWith('progenitor') || folded.startsWith('parent')) return 'pai';
        return 'outro';
    }

    function normalizeRelatedRelationType(value) {
        const folded = normalizeFold(value);
        if (!folded) return 'outro';
        if (RELATED_RECORD_RELATION_TYPES.has(folded)) return folded;
        if (folded.startsWith('funcion')) return 'funcionario';
        if (folded.startsWith('amig')) return 'amigo';
        if (folded.startsWith('famil')) return 'familiar';
        if (folded.startsWith('gerent') || folded.startsWith('admin')) return 'gerente';
        if (folded.startsWith('soci')) return 'socio';
        return 'outro';
    }

    function inverseHouseholdRelationType(value) {
        const normalized = normalizeHouseholdRelationType(value);
        if (normalized === 'conjuge') return 'conjuge';
        if (normalized === 'filho') return 'pai';
        if (normalized === 'pai') return 'filho';
        return 'outro';
    }

    function parseRelationArrayFallback(rawValue, relationTypeNormalizer) {
        const rawArray = Array.isArray(rawValue)
            ? rawValue
            : (() => {
                  const rawText = String(rawValue || '').trim();
                  if (!rawText) return [];
                  try {
                      const parsed = JSON.parse(rawText);
                      return Array.isArray(parsed) ? parsed : [];
                  } catch (error) {
                      return [];
                  }
              })();

        const output = [];
        const seen = new Set();
        rawArray.forEach((item) => {
            const relationType = relationTypeNormalizer(
                normalizeMeaningfulText(
                    item?.relationType ||
                        item?.relation ||
                        item?.tipo ||
                        item?.type ||
                        item?.tipo_relacao ||
                        item?.tipoRelacao ||
                        item?.relation_type
                )
            );
            const customerId = normalizeMeaningfulText(
                item?.customerId ||
                    item?.linkedCustomerId ||
                    item?.relatedCustomerId ||
                    item?.fichaId ||
                    item?.clienteId ||
                    item?.ficha_relacionada_id ||
                    item?.fichaRelacionadaId ||
                    item?.id_ficha_relacionada
            );
            const customerSourceId = normalizeMeaningfulText(
                item?.customerSourceId ||
                    item?.sourceId ||
                    item?.linkedCustomerSourceId ||
                    item?.relatedCustomerSourceId ||
                    item?.fichaSourceId ||
                    item?.clienteSourceId ||
                    item?.ficha_relacionada_source_id ||
                    item?.fichaRelacionadaSourceId
            );
            const customerName = normalizeMeaningfulText(
                item?.customerName || item?.name || item?.nome || item?.ficha_relacionada_nome || item?.fichaRelacionadaNome
            );
            const customerCompany = normalizeMeaningfulText(
                item?.customerCompany || item?.company || item?.empresa || item?.ficha_relacionada_empresa || item?.fichaRelacionadaEmpresa
            );
            const customerNif = normalizeNifDigits(item?.customerNif || item?.nif || item?.ficha_relacionada_nif || item?.fichaRelacionadaNif);
            const note = normalizeMeaningfulText(item?.note || item?.notes || item?.observacao || item?.obs || item?.nota);

            const sourceSeed = customerSourceId || parseCustomerSourceId(customerId, '');
            const dedupeSeed = sourceSeed || customerId || customerNif || `${customerName.toLowerCase()}::${customerCompany.toLowerCase()}`;
            if (!dedupeSeed) return;
            const dedupeKey = `${relationType}::${dedupeSeed}`;
            if (seen.has(dedupeKey)) return;
            seen.add(dedupeKey);

            output.push({
                customerId: customerId || undefined,
                customerSourceId: sourceSeed || undefined,
                relationType,
                note: note || undefined,
                customerName: customerName || undefined,
                customerCompany: customerCompany || undefined,
                customerNif: customerNif || undefined,
            });
        });
        return output;
    }

    function parseHouseholdRelations(rawValue) {
        if (typeof parseAgregadoFamiliarArray === 'function') {
            return parseAgregadoFamiliarArray(rawValue);
        }
        return parseRelationArrayFallback(rawValue, normalizeHouseholdRelationType);
    }

    function parseRelatedRelations(rawValue) {
        if (typeof parseFichasRelacionadasArray === 'function') {
            return parseFichasRelacionadasArray(rawValue);
        }
        return parseRelationArrayFallback(rawValue, normalizeRelatedRelationType);
    }

    function getCustomerIdentity(customer) {
        const id = String(customer?.id || '').trim();
        const sourceId = String(parseCustomerSourceId(id, customer?.sourceId) || '').trim();
        return { id, sourceId };
    }

    function relationEntryPointsToCustomer(entry, customer) {
        const { id: customerId, sourceId: customerSourceId } = getCustomerIdentity(customer);
        if (!customerId && !customerSourceId) return false;

        const entryCustomerId = normalizeMeaningfulText(entry?.customerId);
        const entrySourceIdRaw = normalizeMeaningfulText(entry?.customerSourceId);
        const entrySourceIdFromId = parseCustomerSourceId(entryCustomerId, '');
        const entrySourceId = entrySourceIdRaw || entrySourceIdFromId;

        if (customerSourceId && entrySourceId && customerSourceId === entrySourceId) return true;
        if (customerId && entryCustomerId && customerId === entryCustomerId) return true;
        if (customerSourceId && entryCustomerId && entryCustomerId === customerSourceId) return true;
        return false;
    }

    function relationEntriesSignature(entries = []) {
        const parts = (Array.isArray(entries) ? entries : []).map((entry) => {
            const customerId = normalizeMeaningfulText(entry?.customerId);
            const customerSourceId = normalizeMeaningfulText(entry?.customerSourceId) || parseCustomerSourceId(customerId, '');
            const relationType = normalizeMeaningfulText(entry?.relationType).toLowerCase();
            const note = normalizeMeaningfulText(entry?.note).toLowerCase();
            const customerNif = normalizeNifDigits(entry?.customerNif || '');
            const customerName = normalizeMeaningfulText(entry?.customerName).toLowerCase();
            const customerCompany = normalizeMeaningfulText(entry?.customerCompany).toLowerCase();
            return `${relationType}|${customerSourceId}|${customerId}|${customerNif}|${customerName}|${customerCompany}|${note}`;
        });
        parts.sort();
        return parts.join('||');
    }

    async function resolveLinkedRelationCustomer(entry) {
        const rawCustomerId = normalizeMeaningfulText(entry?.customerId);
        const customerId = rawCustomerId && normalizeFold(rawCustomerId) !== 'undefined' ? rawCustomerId : '';
        const sourceFromId = parseCustomerSourceId(customerId, '');
        const customerSourceId = normalizeMeaningfulText(entry?.customerSourceId) || sourceFromId;

        if (customerId) {
            const direct = await getLocalCustomerById(customerId);
            if (direct) return direct;
            if (sourceFromId) {
                const bySource = await getLocalCustomerBySourceId(sourceFromId);
                if (bySource?.id) {
                    const normalized = await getLocalCustomerById(bySource.id);
                    if (normalized) return normalized;
                }
            }
            if (UUID_LIKE_REGEX.test(customerId)) {
                const byUuidSource = await getLocalCustomerBySourceId(customerId);
                if (byUuidSource?.id) {
                    const normalized = await getLocalCustomerById(byUuidSource.id);
                    if (normalized) return normalized;
                }
            }
        }

        if (customerSourceId) {
            const bySource = await getLocalCustomerBySourceId(customerSourceId);
            if (bySource?.id) {
                const normalized = await getLocalCustomerById(bySource.id);
                if (normalized) return normalized;
            }
        }

        return null;
    }

    async function buildResolvedRelationMap(entries = [], {
        relationFamily = 'household',
        currentCustomer,
    } = {}) {
        const map = new Map();
        const currentIdentity = getCustomerIdentity(currentCustomer);
        const normalizedEntries = relationFamily === 'household' ? parseHouseholdRelations(entries) : parseRelatedRelations(entries);

        for (const entry of normalizedEntries) {
            const targetCustomer = await resolveLinkedRelationCustomer(entry);
            if (!targetCustomer?.id) continue;
            const targetIdentity = getCustomerIdentity(targetCustomer);
            if (
                currentIdentity.id &&
                targetIdentity.id &&
                currentIdentity.id === targetIdentity.id
            ) {
                continue;
            }
            if (
                currentIdentity.sourceId &&
                targetIdentity.sourceId &&
                currentIdentity.sourceId === targetIdentity.sourceId
            ) {
                continue;
            }
            const normalizedType = relationFamily === 'household'
                ? normalizeHouseholdRelationType(entry?.relationType)
                : normalizeRelatedRelationType(entry?.relationType);
            map.set(targetCustomer.id, {
                targetCustomer,
                relationType: normalizedType,
                note: normalizeMeaningfulText(entry?.note),
            });
        }

        return map;
    }

    function buildMirroredRelationEntry({
        primaryCustomer,
        relationType,
        note,
        previousNote,
    }) {
        const customerId = String(primaryCustomer?.id || '').trim();
        const customerSourceId = parseCustomerSourceId(customerId, primaryCustomer?.sourceId || '');
        const cleanNote = normalizeMeaningfulText(note) || normalizeMeaningfulText(previousNote);
        return {
            customerId: customerId || undefined,
            customerSourceId: customerSourceId || undefined,
            relationType: normalizeMeaningfulText(relationType) || 'outro',
            note: cleanNote || undefined,
            customerName: normalizeMeaningfulText(primaryCustomer?.name) || undefined,
            customerCompany: normalizeMeaningfulText(primaryCustomer?.company) || undefined,
            customerNif: normalizeNifDigits(primaryCustomer?.nif || '') || undefined,
        };
    }

    function buildMirroredRelationArray({
        existingEntries,
        primaryCustomer,
        desiredRelationType,
        desiredNote,
        relationFamily = 'household',
    }) {
        const parser = relationFamily === 'household' ? parseHouseholdRelations : parseRelatedRelations;
        const parsedEntries = parser(existingEntries);
        const existingMirror = parsedEntries.find((entry) => relationEntryPointsToCustomer(entry, primaryCustomer));
        const filtered = parsedEntries.filter((entry) => !relationEntryPointsToCustomer(entry, primaryCustomer));
        if (!desiredRelationType) return filtered;
        const normalizedType = relationFamily === 'household'
            ? normalizeHouseholdRelationType(desiredRelationType)
            : normalizeRelatedRelationType(desiredRelationType);
        filtered.push(
            buildMirroredRelationEntry({
                primaryCustomer,
                relationType: normalizedType,
                note: desiredNote,
                previousNote: existingMirror?.note,
            })
        );
        return filtered;
    }

    async function syncBidirectionalCustomerLinksLocal({
        beforeCustomer,
        afterCustomer,
    }) {
        if (!afterCustomer?.id) return { updatedCustomers: [], changed: 0 };

        const beforeHouseholdMap = await buildResolvedRelationMap(beforeCustomer?.agregadoFamiliar || [], {
            relationFamily: 'household',
            currentCustomer: afterCustomer,
        });
        const afterHouseholdMap = await buildResolvedRelationMap(afterCustomer?.agregadoFamiliar || [], {
            relationFamily: 'household',
            currentCustomer: afterCustomer,
        });
        const beforeRelatedMap = await buildResolvedRelationMap(beforeCustomer?.fichasRelacionadas || [], {
            relationFamily: 'related',
            currentCustomer: afterCustomer,
        });
        const afterRelatedMap = await buildResolvedRelationMap(afterCustomer?.fichasRelacionadas || [], {
            relationFamily: 'related',
            currentCustomer: afterCustomer,
        });

        const targetIds = new Set([
            ...beforeHouseholdMap.keys(),
            ...afterHouseholdMap.keys(),
            ...beforeRelatedMap.keys(),
            ...afterRelatedMap.keys(),
        ]);

        const updatedCustomers = [];
        for (const targetId of targetIds) {
            const fromMaps =
                afterHouseholdMap.get(targetId)?.targetCustomer ||
                beforeHouseholdMap.get(targetId)?.targetCustomer ||
                afterRelatedMap.get(targetId)?.targetCustomer ||
                beforeRelatedMap.get(targetId)?.targetCustomer ||
                null;
            const targetCustomer = fromMaps || (await getLocalCustomerById(targetId));
            if (!targetCustomer?.id) continue;

            const desiredHousehold = afterHouseholdMap.get(targetId) || null;
            const desiredRelated = afterRelatedMap.get(targetId) || null;

            const nextHousehold = buildMirroredRelationArray({
                existingEntries: targetCustomer.agregadoFamiliar || [],
                primaryCustomer: afterCustomer,
                desiredRelationType: desiredHousehold ? inverseHouseholdRelationType(desiredHousehold.relationType) : '',
                desiredNote: desiredHousehold?.note || '',
                relationFamily: 'household',
            });
            const nextRelated = buildMirroredRelationArray({
                existingEntries: targetCustomer.fichasRelacionadas || [],
                primaryCustomer: afterCustomer,
                desiredRelationType: desiredRelated ? normalizeRelatedRelationType(desiredRelated.relationType) : '',
                desiredNote: desiredRelated?.note || '',
                relationFamily: 'related',
            });

            const currentHousehold = parseHouseholdRelations(targetCustomer.agregadoFamiliar || []);
            const currentRelated = parseRelatedRelations(targetCustomer.fichasRelacionadas || []);

            const householdChanged = relationEntriesSignature(currentHousehold) !== relationEntriesSignature(nextHousehold);
            const relatedChanged = relationEntriesSignature(currentRelated) !== relationEntriesSignature(nextRelated);
            if (!householdChanged && !relatedChanged) continue;

            const saved = await upsertLocalCustomer({
                id: targetCustomer.id,
                sourceId: targetCustomer.sourceId || undefined,
                agregadoFamiliar: nextHousehold,
                fichasRelacionadas: nextRelated,
            });
            if (saved?.id) {
                updatedCustomers.push(saved);
            }
        }

        return { updatedCustomers, changed: updatedCustomers.length };
    }

    function normalizeCustomerIngestDocumentType(value) {
        const folded = normalizeFold(value);
        if (!folded) return '';
        if (folded.includes('certidao')) return 'certidao_permanente';
        if (folded.includes('pacto')) return 'pacto_social';
        if (folded.includes('inicio')) return 'inicio_atividade';
        if (folded.includes('atividade')) return 'inicio_atividade';
        if (folded.includes('rcbe')) return 'rcbe';
        if (folded.includes('cartao')) return 'cartao_cidadao';
        if (folded.includes('cc')) return 'cartao_cidadao';
        if (folded.includes('outro')) return 'outros';
        return CUSTOMER_INGEST_DOC_TYPES.includes(String(value || '').trim()) ? String(value || '').trim() : '';
    }

    function guessMimeType(fileName = '', fallbackMime = '') {
        const explicit = String(fallbackMime || '').trim().toLowerCase();
        if (explicit) return explicit;
        const ext = String(path.extname(String(fileName || '')).toLowerCase() || '');
        if (ext === '.pdf') return 'application/pdf';
        if (ext === '.png') return 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
        if (ext === '.webp') return 'image/webp';
        if (ext === '.gif') return 'image/gif';
        if (ext === '.doc') return 'application/msword';
        if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        return 'application/octet-stream';
    }

    function parseDateToIso(rawValue) {
        const raw = String(rawValue || '').trim();
        if (!raw) return '';

        const ymd = raw.match(/\b(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})\b/);
        if (ymd) {
            const year = Number(ymd[1]);
            const month = Number(ymd[2]);
            const day = Number(ymd[3]);
            if (year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            }
        }

        const dmy = raw.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
        if (dmy) {
            const day = Number(dmy[1]);
            const month = Number(dmy[2]);
            const yearRaw = Number(dmy[3]);
            const year = yearRaw < 100 ? (2000 + yearRaw) : yearRaw;
            if (year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            }
        }

        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.getTime())) {
            const year = parsed.getUTCFullYear();
            const month = parsed.getUTCMonth() + 1;
            const day = parsed.getUTCDate();
            return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }

        return '';
    }

    function toPtDate(isoDate) {
        const iso = String(isoDate || '').trim();
        if (!iso) return '';
        const parsed = new Date(`${iso}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime())) return '';
        const day = String(parsed.getUTCDate()).padStart(2, '0');
        const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
        const year = parsed.getUTCFullYear();
        return `${day}/${month}/${year}`;
    }

    function toDateToken(rawDate, fallbackIso = '') {
        const iso = parseDateToIso(rawDate) || parseDateToIso(fallbackIso) || nowIso().slice(0, 10);
        return String(iso || nowIso().slice(0, 10)).replace(/-/g, '');
    }

    function parseGeminiJsonFromText(rawText) {
        const text = String(rawText || '').trim();
        if (!text) return {};

        const tryParse = (value) => {
            try {
                return JSON.parse(value);
            } catch (error) {
                return null;
            }
        };

        const direct = tryParse(text);
        if (direct && typeof direct === 'object') return direct;

        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced?.[1]) {
            const parsed = tryParse(fenced[1].trim());
            if (parsed && typeof parsed === 'object') return parsed;
        }

        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
            const parsed = tryParse(text.slice(start, end + 1));
            if (parsed && typeof parsed === 'object') return parsed;
        }

        throw new Error('A IA não devolveu JSON válido.');
    }

    function normalizeExtractionManagers(rawValue) {
        if (Array.isArray(rawValue)) {
            return rawValue
                .map((item) => ({
                    name: String(item?.name || item?.nome || '').trim(),
                    email: String(item?.email || '').trim(),
                    phone: String(item?.phone || item?.telefone || '').trim(),
                }))
                .filter((item) => item.name || item.email || item.phone);
        }
        const raw = String(rawValue || '').trim();
        if (!raw) return [];
        return raw
            .split(/\n|;|\|/)
            .map((item) => item.trim())
            .filter(Boolean)
            .map((name) => ({ name, email: '', phone: '' }));
    }

    function normalizeExtractionPayload(rawPayload) {
        const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
        const managersPrimary = normalizeExtractionManagers(payload.gerentes);
        const managersSecondary = normalizeExtractionManagers(payload.managers);
        const managers = managersPrimary.length > 0 ? managersPrimary : managersSecondary;
        return {
            nif: normalizeNifDigits(
                payload.nif || payload.nif_cliente || payload.nifEmpresa || payload.nif_empresa || ''
            ),
            niss: String(payload.niss || payload.niss_empresa || '').trim(),
            nomeEmpresa: String(payload.nome_empresa || payload.nomeEmpresa || payload.empresa || '').trim(),
            nomePessoa: String(
                payload.nome_pessoa ||
                payload.nome_completo ||
                payload.nome ||
                payload.titular ||
                payload.nome_titular ||
                ''
            ).trim(),
            certidaoPermanenteCodigo: String(
                payload.certidao_permanente_codigo ||
                payload.codigo_certidao_permanente ||
                payload.certidao_codigo ||
                payload.codigo_certidao ||
                ''
            ).trim(),
            certidaoPermanenteValidade: String(
                payload.certidao_permanente_validade ||
                payload.validade_certidao_permanente ||
                payload.validade ||
                payload.data_validade ||
                ''
            ).trim(),
            cartaoCidadaoValidade: String(
                payload.cartao_cidadao_validade ||
                payload.cc_validade ||
                payload.validade_cc ||
                payload.data_validade_cartao ||
                payload.data_validade ||
                ''
            ).trim(),
            morada: String(payload.morada || payload.endereco || payload.address || '').trim(),
            caePrincipal: String(payload.cae_principal || payload.cae || '').trim(),
            inicioAtividade: String(
                payload.inicio_atividade || payload.data_inicio_atividade || payload.inicioAtividade || payload.data_inicio || ''
            ).trim(),
            rcbeNumero: String(payload.rcbe_numero || payload.codigo_rcbe || payload.rcbe || '').trim(),
            rcbeData: String(payload.rcbe_data || payload.data_rcbe || '').trim(),
            dataDocumento: String(payload.data_documento || payload.data || payload.data_emissao || '').trim(),
            gerenteNome: String(payload.nome_gerente || payload.gerente || '').trim(),
            managers,
            raw: payload,
        };
    }

    async function extractCustomerDocumentWithGemini({ fileName, mimeType, documentType, contentBase64 }) {
        const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
        const backupApiKey = String(process.env.GEMINI_API_KEY_BACKUP || '').trim();
        const apiKeys = Array.from(new Set([apiKey, backupApiKey].map((item) => String(item || '').trim()).filter(Boolean)));
        const model = String(process.env.GEMINI_MODEL || 'gemini-flash-latest').trim();
        const fallbackModels = String(process.env.GEMINI_MODEL_FALLBACKS || '')
            .split(',')
            .map((item) => String(item || '').trim())
            .filter(Boolean);
        const modelCandidates = Array.from(
            new Set(
                [model, ...fallbackModels, 'gemini-flash-latest', 'gemini-2.5-flash']
                    .map((item) => String(item || '').trim())
                    .filter(Boolean)
            )
        );
        if (!apiKeys.length) {
            throw new Error('GEMINI_API_KEY não configurado no servidor.');
        }

        const prompt = `Extrai informação deste documento empresarial em Portugal.
Devolve APENAS JSON válido (sem markdown), com estas chaves:
{
  "nif": "",
  "niss": "",
  "nome_empresa": "",
  "nome_pessoa": "",
  "certidao_permanente_codigo": "",
  "certidao_permanente_validade": "",
  "cartao_cidadao_validade": "",
  "morada": "",
  "cae_principal": "",
  "inicio_atividade": "",
  "rcbe_numero": "",
  "rcbe_data": "",
  "nome_gerente": "",
  "gerentes": [{"name":"","email":"","phone":""}],
  "data_documento": ""
}
Contexto:
- tipo_documento: ${documentType}
- ficheiro: ${fileName}
Regras:
- Se um campo não existir, usar string vazia.
- Datas no formato original encontrado no documento.
- Não inventar dados.`;

        const requestBody = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                mimeType: mimeType || 'application/octet-stream',
                                data: contentBase64,
                            },
                        },
                    ],
                },
            ],
            generationConfig: {
                temperature: 0.1,
                topP: 0.8,
            },
        };

        const attemptErrors = [];
        for (let m = 0; m < modelCandidates.length; m += 1) {
            const modelName = modelCandidates[m];
            for (let i = 0; i < apiKeys.length; i += 1) {
                const key = apiKeys[i];
                const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(key)}`;
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody),
                });

                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    const rawErrorMessage =
                        String(payload?.error?.message || '').trim() ||
                        `Gemini retornou ${response.status}.`;
                    attemptErrors.push(`[${modelName}] ${rawErrorMessage}`);

                    const hasNextKey = i < apiKeys.length - 1;
                    if (hasNextKey) {
                        console.warn(`[Gemini] Falha na chave ${i + 1}/${apiKeys.length}; a tentar próxima chave.`);
                    } else if (m < modelCandidates.length - 1) {
                        console.warn(`[Gemini] Modelo ${modelName} falhou; a tentar modelo seguinte.`);
                    }
                    continue;
                }

                const text = (Array.isArray(payload?.candidates) ? payload.candidates : [])
                    .flatMap((candidate) => (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []))
                    .map((part) => String(part?.text || '').trim())
                    .filter(Boolean)
                    .join('\n')
                    .trim();

                if (!text) {
                    attemptErrors.push(`[${modelName}] resposta sem texto.`);
                    continue;
                }

                return normalizeExtractionPayload(parseGeminiJsonFromText(text));
            }
        }

        const allErrors = String(attemptErrors.join(' | ') || '').toLowerCase();
        if (allErrors.includes('reported as leaked') || (allErrors.includes('api key') && allErrors.includes('leaked'))) {
            throw new Error(
                'As chaves Gemini configuradas estão bloqueadas por exposição ("leaked"). Gere novas chaves no Google AI Studio e atualize GEMINI_API_KEY e GEMINI_API_KEY_BACKUP no .env.'
            );
        }
        if (allErrors.includes('has not been used in project') || allErrors.includes('disabled')) {
            throw new Error(
                'A API Generative Language não está ativa no projeto da chave Gemini. Ative a API no Google Cloud do projeto associado à chave.'
            );
        }
        throw new Error(attemptErrors.length ? `Falha no Gemini: ${attemptErrors.join(' | ')}` : 'Falha no Gemini sem detalhe.');
    }

    app.post('/api/customers/documents/detect-target', async (req, res) => {
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
            const cleanBase64 = contentBase64Raw.includes(',') ? contentBase64Raw.split(',')[1] : contentBase64Raw;
            const extraction = await extractCustomerDocumentWithGemini({
                fileName: sourceFileName,
                mimeType,
                documentType,
                contentBase64: cleanBase64,
            });

            const extractedNif = normalizeNifDigits(extraction?.nif || '');
            if (!extractedNif) {
                return res.status(422).json({
                    success: false,
                    code: 'NIF_NOT_DETECTED',
                    error: 'A IA não conseguiu identificar um NIF válido neste documento.',
                    extraction,
                });
            }

            const existingByNif = await findLocalCustomerByNifDigits(extractedNif);
            if (!existingByNif) {
                return res.status(404).json({
                    success: false,
                    code: 'NIF_NOT_FOUND',
                    error: `NIF ${extractedNif} não encontrado na base local de clientes.`,
                    extraction,
                    suggestedCustomer: buildSuggestedCustomerFromExtraction(extraction, null),
                });
            }

            return res.json({
                success: true,
                nif: extractedNif,
                extraction,
                customer: {
                    id: String(existingByNif.id || '').trim(),
                    name: String(existingByNif.name || '').trim(),
                    company: String(existingByNif.company || '').trim(),
                    nif: String(existingByNif.nif || '').trim(),
                    documentsFolder: String(existingByNif.documents_folder || '').trim(),
                },
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Docs] Erro na deteção automática de cliente por documento:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    function buildIngestDocumentFileName({ documentType, sourceFileName, extracted, customer }) {
        const extFromSource = String(path.extname(String(sourceFileName || '')).toLowerCase() || '');
        const ext = extFromSource || '.pdf';
        const nifToken = normalizeNifDigits(extracted?.nif || customer?.nif || '') || 'sem_nif';
        const sanitizeFileToken = (value, fallback = 'cliente') => {
            const clean = String(value || '')
                .trim()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-zA-Z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '');
            return clean || fallback;
        };
        const dateToken = toDateToken(
            extracted?.certidaoPermanenteValidade ||
                extracted?.inicioAtividade ||
                extracted?.rcbeData ||
                extracted?.dataDocumento ||
                '',
            nowIso().slice(0, 10)
        );
        if (String(documentType || '').trim() === 'cartao_cidadao') {
            const rawName =
                String(customer?.company || customer?.name || '').trim() ||
                String(extracted?.nomePessoa || extracted?.nomeEmpresa || '').trim() ||
                String(extracted?.raw?.nome_completo || extracted?.raw?.nome || extracted?.raw?.titular || '').trim() ||
                nifToken;
            const nameToken = sanitizeFileToken(rawName, nifToken || 'cliente');
            const validadeToken = toDateToken(
                extracted?.cartaoCidadaoValidade ||
                    extracted?.raw?.cartao_cidadao_validade ||
                    extracted?.raw?.cc_validade ||
                    extracted?.raw?.validade_cc ||
                    extracted?.raw?.data_validade ||
                    extracted?.certidaoPermanenteValidade ||
                    extracted?.dataDocumento ||
                    '',
                nowIso().slice(0, 10)
            );
            return sanitizeDocumentFileName(`CC_${nameToken}_${validadeToken}${ext}`);
        }
        if (String(documentType || '').trim() === 'certidao_permanente') {
            const rawName =
                String(customer?.company || customer?.name || '').trim() ||
                String(extracted?.nomeEmpresa || extracted?.nomePessoa || '').trim() ||
                String(extracted?.raw?.nome_empresa || extracted?.raw?.empresa || extracted?.raw?.nome || '').trim() ||
                nifToken;
            const nameToken = sanitizeFileToken(rawName, nifToken || 'cliente');
            const validadeToken = toDateToken(
                extracted?.certidaoPermanenteValidade ||
                    extracted?.raw?.certidao_permanente_validade ||
                    extracted?.raw?.validade_certidao_permanente ||
                    extracted?.dataDocumento ||
                    '',
                nowIso().slice(0, 10)
            );
            return sanitizeDocumentFileName(`CP_${nameToken}_${validadeToken}${ext}`);
        }
        const prefixes = {
            certidao_permanente: 'certidao_permanente',
            pacto_social: 'pacto_social',
            inicio_atividade: 'inicio_atividade',
            rcbe: 'rcbe',
            cartao_cidadao: 'cartao_cidadao',
            outros: 'outros',
        };
        const prefix = prefixes[String(documentType || '').trim()] || 'documento';
        return sanitizeDocumentFileName(`${prefix}_${nifToken}_${dateToken}${ext}`);
    }

    function mergeManagers(currentManagers = [], nextManagers = []) {
        const normalized = [];
        const seen = new Set();
        [...currentManagers, ...nextManagers].forEach((manager) => {
            const name = String(manager?.name || '').trim();
            const email = String(manager?.email || '').trim().toLowerCase();
            const phone = String(manager?.phone || '').trim();
            if (!name && !email && !phone) return;
            const key = `${normalizeFold(name)}|${email}|${phone.replace(/\D/g, '')}`;
            if (seen.has(key)) return;
            seen.add(key);
            normalized.push({ name, email, phone });
        });
        return normalized;
    }

    async function findLocalCustomerByNifDigits(nifDigits) {
        const target = normalizeNifDigits(nifDigits);
        if (!target) return null;
        const rows = await dbAllAsync(
            `SELECT id, name, company, nif, phone, email, owner_id, type, contacts_json, allow_auto_responses, documents_folder
             FROM customers
             WHERE nif IS NOT NULL AND trim(nif) <> ''`
        );
        return rows.find((row) => normalizeNifDigits(row?.nif || '') === target) || null;
    }

    function buildSuggestedCustomerFromExtraction(extracted, currentCustomer) {
        const companyName = String(extracted?.nomeEmpresa || '').trim();
        const personName =
            String(extracted?.nomePessoa || '').trim() ||
            String(extracted?.raw?.nome_completo || extracted?.raw?.nome || extracted?.raw?.titular || '').trim();
        const baseName = companyName || personName;
        const managerName = String(extracted?.gerenteNome || '').trim();
        const managerFromList = Array.isArray(extracted?.managers) && extracted.managers.length > 0 ? extracted.managers : [];
        const suggestedManagers = mergeManagers([], [
            ...managerFromList,
            ...(managerName ? [{ name: managerName, email: '', phone: '' }] : []),
        ]);
        return {
            name: baseName || `Cliente ${normalizeNifDigits(extracted?.nif || '') || 'novo'}`,
            company: baseName || `Cliente ${normalizeNifDigits(extracted?.nif || '') || 'novo'}`,
            nif: normalizeNifDigits(extracted?.nif || ''),
            niss: String(extracted?.niss || '').trim(),
            morada: String(extracted?.morada || '').trim(),
            caePrincipal: String(extracted?.caePrincipal || '').trim(),
            certidaoPermanenteNumero: String(extracted?.certidaoPermanenteCodigo || '').trim(),
            certidaoPermanenteValidade: String(extracted?.certidaoPermanenteValidade || '').trim(),
            inicioAtividade: String(extracted?.inicioAtividade || '').trim(),
            rcbeNumero: String(extracted?.rcbeNumero || '').trim(),
            rcbeData: String(extracted?.rcbeData || '').trim(),
            managers: suggestedManagers,
            documentsFolder: String(currentCustomer?.documentsFolder || '').trim(),
            ownerId: String(currentCustomer?.ownerId || '').trim() || null,
            type: String(currentCustomer?.type || 'Empresa'),
        };
    }

    function customersSyncStateKey() {
        return `customers_sync_last_${SUPABASE_CLIENTS_SOURCE}_${SUPABASE_CLIENTS_UPDATED_AT_COLUMN}`;
    }

    function pickExistingColumn(columns, candidates) {
        for (const candidate of candidates) {
            if (Array.isArray(columns) && columns.includes(candidate)) return candidate;
        }
        return '';
    }

    function uniqueNonEmpty(values = []) {
        return Array.from(new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean)));
    }

    function normalizeDigitsOnly(value) {
        return String(value || '').replace(/\D/g, '');
    }

    function hasExplicitSupabaseCustomerType(rawRow) {
        if (!rawRow || typeof rawRow !== 'object') return false;
        const candidates = ['type', 'tipo', 'categoria', 'tipo_entidade'];
        return candidates.some((key) => String(rawRow?.[key] || '').trim().length > 0);
    }

    function hasExplicitSupabaseAccessCredentials(rawRow) {
        if (!rawRow || typeof rawRow !== 'object') return false;

        const hasNonEmptyJsonPayload = (value) => {
            if (value === undefined || value === null) return false;
            if (Array.isArray(value)) return value.length > 0;
            if (typeof value === 'object') return Object.keys(value).length > 0;
            const text = String(value || '').trim();
            if (!text) return false;
            if (text === '[]' || text === '{}') return false;
            return true;
        };

        const jsonCandidates = [
            'access_credentials_json',
            'acessos_json',
            'dados_acesso_json',
            'dados_de_acesso_json',
            'credenciais_json',
        ];
        if (jsonCandidates.some((key) => hasNonEmptyJsonPayload(rawRow?.[key]))) return true;

        const scalarCandidates = [
            'utilizador_at', 'username_at', 'user_at', 'password_at', 'senha_at',
            'utilizador_ss', 'username_ss', 'user_ss', 'password_ss', 'senha_ss',
            'utilizador_ru', 'username_ru', 'user_ru', 'password_ru', 'senha_ru',
            'utilizador_viactt', 'username_viactt', 'user_viactt', 'password_viactt', 'senha_viactt',
            'utilizador_iapmei', 'username_iapmei', 'user_iapmei', 'password_iapmei', 'senha_iapmei',
            'senha_financas', 'senha_portal_financas', 'password_financas', 'financas_password', 'portal_financas_password',
            'senha_seguranca_social', 'senha_seg_social', 'password_seguranca_social', 'password_seg_social', 'seg_social_password',
        ];
        return scalarCandidates.some((key) => String(rawRow?.[key] || '').trim().length > 0);
    }

    function mapLocalTypeToSupabaseTipoEntidade(value) {
        const raw = String(value || '')
            .trim()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
        if (!raw) return '';
        if (raw.includes('empre') || raw.includes('socied')) return 'SOCIEDADE';
        if (raw.includes('particular') || raw.includes('private')) return 'PARTICULAR';
        // Evita enviar valor inválido para enum do Supabase (ex.: ENI quando não existe no enum remoto).
        if (raw.includes('indep') || raw.includes('eni') || raw.includes('nome individual')) return '';
        if (raw.includes('public')) return 'ENTIDADE_PUBLICA';
        if (raw.includes('fornec') || raw.includes('supplier')) return 'FORNECEDOR';
        if (raw.includes('spam')) return 'SPAM';
        if (raw.includes('outro') || raw.includes('other')) return 'OUTROS';
        return '';
    }

    function normalizeLocalTipoIvaToSupabase(value) {
        const raw = String(value || '')
            .trim()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
        if (!raw) return null;
        if (raw.includes('isent')) return 'ISENTO';
        if (raw.includes('mens')) return 'MENSAL';
        if (raw.includes('trim')) return 'TRIMESTRAL';
        return null;
    }

    function normalizeLocalTipoContabilidadeToSupabase(value) {
        const raw = String(value || '')
            .trim()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
        if (!raw) return null;
        if (raw.includes('nao organizada') || raw.includes('não organizada') || raw.includes('simplific')) {
            return 'SIMPLIFICADO';
        }
        if (raw.includes('organizada')) return 'ORGANIZADA';
        return null;
    }

    function normalizeLocalEstadoToSupabase(value) {
        const raw = String(value || '')
            .trim()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
        if (!raw) return null;
        // Enum remoto aceite: ACTIVA / INATIVA.
        if (raw.includes('inativ') || raw.includes('inactiv')) return 'INATIVA';
        if (raw.includes('suspens')) return 'INATIVA';
        if (raw.includes('encerr')) return 'INATIVA';
        if (raw.includes('ativ') || raw.includes('activ')) return 'ACTIVA';
        return null;
    }

    function normalizeCredentialServiceForSupabase(value) {
        const raw = String(value || '')
            .trim()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
        if (!raw) return '';
        if (raw === 'at' || raw.includes('autoridade') || raw.includes('financ')) return 'AT';
        if (raw === 'ss' || raw.includes('seguranca social') || raw.includes('seg_social')) return 'SS';
        if (raw === 'ru' || raw.includes('relatorio unico') || raw.includes('relatorio_unico')) return 'RU';
        if (raw.includes('viactt') || raw.includes('via ctt')) return 'ViaCTT';
        if (raw.includes('iapmei')) return 'IAPMEI';
        return String(value || '').trim();
    }

    function splitSelectorList(rawValue, fallbackValue) {
        const source = String(rawValue || fallbackValue || '').trim();
        return source
            .split(',')
            .map((item) => String(item || '').trim())
            .filter(Boolean);
    }

    async function findFirstVisibleSelector(page, selectors, options = {}) {
        const waitTimeout = Math.max(500, Number(options?.waitTimeoutMs || 3000) || 3000);
        const maxMatchesPerSelector = Math.max(1, Number(options?.maxMatchesPerSelector || 8) || 8);
        for (const selector of Array.isArray(selectors) ? selectors : []) {
            try {
                const cleanedSelector = String(selector || '').trim();
                if (!cleanedSelector) continue;
                const candidates = page.locator(cleanedSelector);
                const totalMatches = await candidates.count();
                if (totalMatches <= 0) continue;
                const maxCandidates = Math.min(totalMatches, maxMatchesPerSelector);
                for (let index = 0; index < maxCandidates; index += 1) {
                    const locator = candidates.nth(index);
                    let visible = await locator.isVisible().catch(() => false);
                    if (!visible) {
                        const perCandidateWait = totalMatches === 1 ? waitTimeout : Math.min(waitTimeout, 800);
                        await locator.waitFor({ state: 'visible', timeout: perCandidateWait }).catch(() => null);
                        visible = await locator.isVisible().catch(() => false);
                    }
                    if (!visible) continue;
                    return cleanedSelector;
                }
            } catch (error) {
                // ignora seletor inválido e tenta o próximo
            }
        }
        return null;
    }

    async function activateFinancasNifTab(page) {
        const candidates = [
            page.getByRole('tab', { name: /^NIF$/i }),
            page.getByRole('tab', { name: /NIF/i }),
            page.locator('button[role="tab"]', { hasText: /^NIF$/i }),
            page.locator('button[role="tab"]', { hasText: /NIF/i }),
            page.locator('[id$="-trigger-N"]'),
            page.locator('button', { hasText: /^NIF$/i }),
        ];

        const hasNifInputs = async () => {
            const checks = [
                'form[name="loginForm"] input[name="username"]',
                'form[name="loginForm"] input[name="password"]',
                'input[name="username"]',
            ];
            for (const selector of checks) {
                const input = page.locator(selector).first();
                if ((await input.count()) <= 0) continue;
                if (await input.isVisible().catch(() => false)) return true;
            }
            return false;
        };

        if (await hasNifInputs()) return true;

        for (const locator of candidates) {
            let count = 0;
            try {
                count = await locator.count();
            } catch (error) {
                count = 0;
            }
            if (count <= 0) continue;

            const maxItems = Math.min(count, 5);
            for (let index = 0; index < maxItems; index += 1) {
                const tab = locator.nth(index);
                try {
                    const visible = await tab.isVisible().catch(() => false);
                    if (!visible) continue;
                    const isSelected = String((await tab.getAttribute('aria-selected')) || '').trim().toLowerCase() === 'true';
                    if (!isSelected) {
                        await tab.click({ timeout: 5000 });
                        await page.waitForTimeout(700);
                    }
                    if (await hasNifInputs()) return true;
                } catch (error) {
                    // ignora e tenta próximo candidato
                }
            }
        }

        return await hasNifInputs();
    }

    async function clickContinueLoginIf2faPrompt(page, timeoutMs = 8000) {
        const safeTimeout = Math.max(1000, Number(timeoutMs) || 8000);
        const deadline = Date.now() + safeTimeout;
        const selectors = [
            () => page.getByRole('button', { name: /continuar\s*login/i }).first(),
            () => page.locator('button', { hasText: /continuar\s*login/i }).first(),
            () => page.locator('input[type="submit"][value*="Continuar"]').first(),
            () => page.locator('a', { hasText: /continuar\s*login/i }).first(),
        ];

        while (Date.now() < deadline) {
            for (const buildLocator of selectors) {
                try {
                    const locator = buildLocator();
                    if ((await locator.count()) <= 0) continue;
                    const visible = await locator.isVisible().catch(() => false);
                    if (!visible) continue;
                    await locator.click({ timeout: 3000 });
                    await page.waitForTimeout(700);
                    return true;
                } catch (error) {
                    // ignora e continua até timeout
                }
            }
            await page.waitForTimeout(250);
        }
        return false;
    }

    async function clickCookieConsentIfPresent(page, timeoutMs = 4000) {
        const safeTimeout = Math.max(500, Number(timeoutMs) || 4000);
        const deadline = Date.now() + safeTimeout;
        const selectors = [
            () => page.getByRole('button', { name: /^concordo$/i }).first(),
            () => page.getByRole('button', { name: /concordo/i }).first(),
            () => page.locator('button', { hasText: /^concordo$/i }).first(),
            () => page.locator('button', { hasText: /concordo/i }).first(),
            () => page.locator('a', { hasText: /^concordo$/i }).first(),
            () => page.locator('a', { hasText: /aceitar/i }).first(),
        ];

        while (Date.now() < deadline) {
            for (const buildLocator of selectors) {
                try {
                    const locator = buildLocator();
                    if ((await locator.count()) <= 0) continue;
                    const visible = await locator.isVisible().catch(() => false);
                    if (!visible) continue;
                    await locator.click({ timeout: 2000 });
                    await page.waitForTimeout(350);
                    return true;
                } catch (error) {
                    // ignora e continua
                }
            }
            await page.waitForTimeout(200);
        }
        return false;
    }

    async function ensureSegSocialCredentialsFormVisible(page, timeoutMs = 10000) {
        const safeTimeout = Math.max(1000, Number(timeoutMs) || 10000);
        const deadline = Date.now() + safeTimeout;
        const usernameCheckSelectors = [
            'input[name="username"]',
            'input[name="niss"]',
            'input[id*="username" i]',
            'input[name*="user" i]',
            'input[id*="utilizador" i]',
            'input[name*="utilizador" i]',
            'input[id*="niss" i]',
            'input[placeholder*="NISS" i]',
            'input[autocomplete="username"]',
        ];
        const openFormActions = [
            () => page.getByRole('button', { name: /autenticar\s+com\s+utilizador/i }).first(),
            () => page.getByRole('link', { name: /autenticar\s+com\s+utilizador/i }).first(),
            () => page.locator('button', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
            () => page.locator('a', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
            () => page.getByText(/autenticar\s+com\s+utilizador/i).first(),
            () => page.locator('button, a, [role="button"], div, span', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
        ];

        while (Date.now() < deadline) {
            const usernameSelector = await findFirstVisibleSelector(page, usernameCheckSelectors);
            if (usernameSelector) return true;

            for (const buildLocator of openFormActions) {
                try {
                    const locator = buildLocator();
                    if ((await locator.count()) <= 0) continue;
                    const visible = await locator.isVisible().catch(() => false);
                    if (!visible) continue;
                    await locator.click({ timeout: 2000 });
                    await page.waitForTimeout(500);
                    break;
                } catch (error) {
                    // ignora e tenta próximo
                }
            }

            await clickCookieConsentIfPresent(page, 800);
            await page.waitForTimeout(250);
        }

        return false;
    }

    async function openSegSocialLoginEntryIfNeeded(page, timeoutMs = 10000) {
        const safeTimeout = Math.max(1000, Number(timeoutMs) || 10000);
        const deadline = Date.now() + safeTimeout;
        const loginCtaSelectors = [
            () => page.getByRole('button', { name: /iniciar\s*sess[aã]o/i }).first(),
            () => page.getByRole('link', { name: /iniciar\s*sess[aã]o/i }).first(),
            () => page.locator('button', { hasText: /iniciar\s*sess[aã]o/i }).first(),
            () => page.locator('a', { hasText: /iniciar\s*sess[aã]o/i }).first(),
            () => page.getByRole('button', { name: /autenticar\s+com\s+utilizador/i }).first(),
            () => page.getByRole('link', { name: /autenticar\s+com\s+utilizador/i }).first(),
            () => page.locator('button', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
            () => page.locator('a', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
            () => page.getByText(/autenticar\s+com\s+utilizador/i).first(),
            () => page.locator('button, a, [role="button"], div, span', { hasText: /autenticar\s+com\s+utilizador/i }).first(),
        ];
        const usernameCheckSelectors = [
            'input[name="username"]',
            'input[name="niss"]',
            'input[id*="username" i]',
            'input[name*="user" i]',
            'input[id*="utilizador" i]',
            'input[name*="utilizador" i]',
            'input[autocomplete="username"]',
        ];

        while (Date.now() < deadline) {
            const usernameSelector = await findFirstVisibleSelector(page, usernameCheckSelectors);
            if (usernameSelector) return true;

            await clickCookieConsentIfPresent(page, 700);

            let clicked = false;
            for (const buildLocator of loginCtaSelectors) {
                try {
                    const locator = buildLocator();
                    if ((await locator.count()) <= 0) continue;
                    const visible = await locator.isVisible().catch(() => false);
                    if (!visible) continue;
                    await locator.click({ timeout: 2500 });
                    clicked = true;
                    await Promise.race([
                        page.waitForLoadState('domcontentloaded', { timeout: 4000 }).catch(() => null),
                        page.waitForTimeout(900),
                    ]);
                    break;
                } catch (error) {
                    // ignora e tenta próximo
                }
            }

            if (!clicked) {
                await page.waitForTimeout(250);
            }
        }

        return false;
    }

    async function clickContinueWithoutActivatingIfPrompt(page, timeoutMs = 12000) {
        const safeTimeout = Math.max(1000, Number(timeoutMs) || 12000);
        const deadline = Date.now() + safeTimeout;
        const selectors = [
            () => page.getByRole('button', { name: /continuar\s*sem\s*ativar/i }).first(),
            () => page.locator('button', { hasText: /continuar\s*sem\s*ativar/i }).first(),
            () => page.locator('input[type="submit"][value*="Continuar sem ativar"]').first(),
            () => page.locator('a', { hasText: /continuar\s*sem\s*ativar/i }).first(),
        ];

        while (Date.now() < deadline) {
            for (const buildLocator of selectors) {
                try {
                    const locator = buildLocator();
                    if ((await locator.count()) <= 0) continue;
                    const visible = await locator.isVisible().catch(() => false);
                    if (!visible) continue;
                    await locator.click({ timeout: 3000 });
                    await page.waitForTimeout(700);
                    return true;
                } catch (error) {
                    // ignora e continua
                }
            }
            await page.waitForTimeout(250);
        }
        return false;
    }

    async function launchFinancasBrowserWithFallback(playwright, options = {}) {
        const headless = options?.headless === true;
        const baseLaunch = {
            headless,
            args: Array.isArray(options?.args) ? options.args : headless ? [] : ['--start-maximized'],
        };

        const explicitExecutablePath = String(
            options?.browserExecutablePath || process.env.PORTAL_FINANCAS_BROWSER_EXECUTABLE || ''
        ).trim();

        const attempts = [];
        if (explicitExecutablePath) {
            attempts.push({
                label: 'executável configurado',
                launchOptions: {
                    ...baseLaunch,
                    executablePath: explicitExecutablePath,
                },
            });
        }

        attempts.push({
            label: 'Microsoft Edge',
            launchOptions: {
                ...baseLaunch,
                channel: 'msedge',
            },
        });
        attempts.push({
            label: 'Google Chrome',
            launchOptions: {
                ...baseLaunch,
                channel: 'chrome',
            },
        });
        attempts.push({
            label: 'Chromium (Playwright)',
            launchOptions: {
                ...baseLaunch,
            },
        });

        let lastError = null;
        for (const attempt of attempts) {
            try {
                const browser = await playwright.chromium.launch(attempt.launchOptions);
                return { browser, launcherLabel: attempt.label };
            } catch (error) {
                lastError = error;
                console.warn(
                    `[AT Autologin] Falha ao abrir browser (${attempt.label}):`,
                    error?.message || error
                );
            }
        }

        const details = String(lastError?.message || lastError || '').trim();
        throw new Error(
            `Não foi possível abrir um browser local para autologin. Verifique se o Microsoft Edge ou Google Chrome estão instalados neste computador.${details ? ` Detalhe: ${details}` : ''}`
        );
    }

    function resolveAtCredentialForAutologin(customer) {
        const credentials = Array.isArray(customer?.accessCredentials) ? customer.accessCredentials : [];
        const atCredential = credentials.find((entry) => normalizeCredentialServiceForSupabase(entry?.service) === 'AT') || null;
        const nif = normalizeNifDigits(customer?.nif || '');
        const username = String(atCredential?.username || nif || '').trim();
        const password = String(atCredential?.password || customer?.senhaFinancas || '').trim();
        return {
            username,
            password,
            nif,
            source: atCredential ? 'access_credentials' : 'senha_financas',
        };
    }

    function resolveSsCredentialForAutologin(customer) {
        const credentials = Array.isArray(customer?.accessCredentials) ? customer.accessCredentials : [];
        const ssCredential = credentials.find((entry) => normalizeCredentialServiceForSupabase(entry?.service) === 'SS') || null;
        const niss = String(customer?.niss || '').replace(/\D/g, '').trim();
        const username = String(ssCredential?.username || niss || '').trim();
        const password = String(ssCredential?.password || customer?.senhaSegurancaSocial || '').trim();
        return {
            username,
            password,
            niss,
            source: ssCredential ? 'access_credentials' : 'senha_seg_social',
        };
    }

    function buildSupabaseCredentialsPayloadFromLocal(localCustomer) {
        const byService = new Map();
        const pushCredential = (service, username, password) => {
            const normalizedService = normalizeCredentialServiceForSupabase(service);
            if (!normalizedService) return;
            const current = byService.get(normalizedService) || {
                tipoServico: normalizedService,
                username: '',
                password: '',
            };
            const cleanUsername = String(username || '').trim();
            const cleanPassword = String(password || '').trim();
            const nextUsername = cleanUsername || String(current.username || '').trim();
            const nextPassword = cleanPassword || String(current.password || '').trim();
            if (!nextUsername && !nextPassword) return;
            byService.set(normalizedService, {
                tipoServico: normalizedService,
                username: nextUsername,
                password: nextPassword,
            });
        };

        const credentials = Array.isArray(localCustomer?.accessCredentials) ? localCustomer.accessCredentials : [];
        credentials.forEach((entry) => {
            pushCredential(entry?.service, entry?.username, entry?.password);
        });

        const localNif = String(localCustomer?.nif || '').trim();
        const localNiss = String(localCustomer?.niss || '').trim();
        const senhaFinancas = String(localCustomer?.senhaFinancas || '').trim();
        const senhaSegSocial = String(localCustomer?.senhaSegurancaSocial || '').trim();

        if (senhaFinancas) {
            pushCredential('AT', localNif, senhaFinancas);
        }
        if (senhaSegSocial) {
            pushCredential('SS', localNiss, senhaSegSocial);
        }

        return Array.from(byService.values());
    }

    async function syncLocalCustomerCredentialsToSupabase(localCustomer, supabaseCustomerId = '') {
        const warnings = [];
        if (!hasSupabaseCustomerCredentialsSync()) return warnings;

        const candidateId = String(supabaseCustomerId || '').trim();
        const fallbackSourceId = String(parseCustomerSourceId(localCustomer?.id || '', localCustomer?.sourceId || '') || '').trim();
        const targetSupabaseCustomerId = isUuidLike(candidateId)
            ? candidateId
            : (isUuidLike(fallbackSourceId) ? fallbackSourceId : '');

        if (!targetSupabaseCustomerId) {
            warnings.push('Credenciais não sincronizadas: cliente sem id UUID no Supabase.');
            return warnings;
        }

        const desiredCredentials = buildSupabaseCredentialsPayloadFromLocal(localCustomer);
        if (desiredCredentials.length === 0) return warnings;

        let tableColumns = [];
        try {
            tableColumns = await fetchSupabaseTableColumns(SUPABASE_CLIENTS_CREDENTIALS_SOURCE);
        } catch (error) {
            warnings.push(`Credenciais não sincronizadas: falha ao ler colunas de ${SUPABASE_CLIENTS_CREDENTIALS_SOURCE}.`);
            return warnings;
        }

        const idColumn = pickExistingColumn(tableColumns, ['id']);
        const customerIdColumn = pickExistingColumn(tableColumns, ['cliente_id', 'customer_id', 'cliente_uuid']);
        const serviceColumn = pickExistingColumn(tableColumns, ['tipo_servico', 'service', 'servico', 'tipo']);
        const usernameColumn = pickExistingColumn(tableColumns, ['username', 'utilizador', 'user']);
        const passwordColumn = pickExistingColumn(tableColumns, ['password_encrypted', 'password', 'senha']);
        const activeColumn = pickExistingColumn(tableColumns, ['ativo', 'active', 'is_active']);

        if (!customerIdColumn || !serviceColumn) {
            warnings.push('Credenciais não sincronizadas: tabela de credenciais sem colunas compatíveis.');
            return warnings;
        }

        let existingRows = [];
        try {
            existingRows = await fetchSupabaseTableWithFilters(
                SUPABASE_CLIENTS_CREDENTIALS_SOURCE,
                { [customerIdColumn]: targetSupabaseCustomerId },
                { limit: 500 }
            );
        } catch (error) {
            warnings.push(`Credenciais não sincronizadas: falha ao ler ${SUPABASE_CLIENTS_CREDENTIALS_SOURCE}.`);
            return warnings;
        }

        const existingByService = new Map();
        (Array.isArray(existingRows) ? existingRows : []).forEach((row) => {
            const serviceValue = normalizeCredentialServiceForSupabase(row?.[serviceColumn] || '');
            if (!serviceValue) return;
            if (!existingByService.has(serviceValue)) {
                existingByService.set(serviceValue, row);
            }
        });

        for (const credential of desiredCredentials) {
            const serviceValue = normalizeCredentialServiceForSupabase(credential.tipoServico);
            if (!serviceValue) continue;
            const existing = existingByService.get(serviceValue) || null;
            const incomingUsername = String(credential.username || '').trim();
            const incomingPassword = String(credential.password || '').trim();
            const existingUsername = usernameColumn && existing ? String(existing?.[usernameColumn] || '').trim() : '';
            const existingPassword = passwordColumn && existing ? String(existing?.[passwordColumn] || '').trim() : '';

            // A tabela remota exige password_encrypted NOT NULL em vários ambientes.
            // Se não houver password nova nem antiga, ignoramos a credencial.
            const effectivePassword = incomingPassword || existingPassword;
            if (passwordColumn && !effectivePassword) {
                continue;
            }
            const effectiveUsername = incomingUsername || existingUsername;

            const payload = {
                [customerIdColumn]: targetSupabaseCustomerId,
                [serviceColumn]: serviceValue,
            };
            if (usernameColumn && effectiveUsername) payload[usernameColumn] = effectiveUsername;
            if (passwordColumn && effectivePassword) payload[passwordColumn] = effectivePassword;
            if (activeColumn) payload[activeColumn] = true;

            try {
                if (existing) {
                    const updateFilters = {};
                    if (idColumn && existing?.[idColumn] !== undefined && existing?.[idColumn] !== null) {
                        updateFilters[idColumn] = existing[idColumn];
                    } else {
                        updateFilters[customerIdColumn] = targetSupabaseCustomerId;
                        updateFilters[serviceColumn] = serviceValue;
                    }
                    const updatedRows = await patchSupabaseTableWithFilters(
                        SUPABASE_CLIENTS_CREDENTIALS_SOURCE,
                        payload,
                        updateFilters
                    );
                    const updated = Array.isArray(updatedRows) && updatedRows.length > 0 ? updatedRows[0] : existing;
                    existingByService.set(serviceValue, updated);
                } else {
                    const insertedRows = await upsertSupabaseRow(
                        SUPABASE_CLIENTS_CREDENTIALS_SOURCE,
                        payload,
                        []
                    );
                    const inserted = Array.isArray(insertedRows) && insertedRows.length > 0 ? insertedRows[0] : payload;
                    existingByService.set(serviceValue, inserted);
                }
            } catch (error) {
                const details = error?.response?.data ? JSON.stringify(error.response.data) : '';
                warnings.push(
                    `Falha a sincronizar credencial ${serviceValue}: ${error?.message || error}${details ? ` | ${details}` : ''}`
                );
            }
        }

        return warnings;
    }

    function normalizeSupabaseTimestamp(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const ts = Date.parse(raw);
        if (!Number.isFinite(ts)) return '';
        return new Date(ts).toISOString();
    }

    function buildSupabaseCustomerPayloadFromLocal(localCustomer, tableColumns = []) {
        const payload = {};
        const ownerSourceId = parseSourceId(localCustomer?.ownerId || '', '');
        const credentials = Array.isArray(localCustomer?.accessCredentials) ? localCustomer.accessCredentials : [];
        const normalizeCredential = (item) => ({
            service: String(item?.service || '').trim(),
            serviceFold: normalizeFold(item?.service || ''),
            username: String(item?.username || '').trim(),
            password: String(item?.password || '').trim(),
        });
        const normalizedCredentials = credentials
            .map(normalizeCredential)
            .filter((item) => item.service || item.username || item.password);
        const findCredentialByService = (candidates = []) =>
            normalizedCredentials.find((item) => {
                if (!item.serviceFold) return false;
                return candidates.some((candidate) => {
                    const folded = normalizeFold(candidate);
                    return item.serviceFold === folded || item.serviceFold.includes(folded);
                });
            }) || null;
        const atCredential = findCredentialByService(['at', 'autoridade', 'financas', 'portal_financas']);
        const ssCredential = findCredentialByService(['ss', 'seguranca social', 'seg_social']);
        const ruCredential = findCredentialByService(['ru', 'relatorio unico', 'relatorio_unico']);
        const viaCttCredential = findCredentialByService(['viactt', 'via ctt']);
        const iapmeiCredential = findCredentialByService(['iapmei']);
        const toSupabaseDateValue = (value) => {
            const raw = String(value || '').trim();
            if (!raw) return null;
            const iso = parseDateToIso(raw);
            // Evita enviar datas inválidas para colunas date/timestamp do Supabase.
            return iso || null;
        };
        const setIfColumnExists = (candidates, value) => {
            if (value === undefined) return;
            const col = pickExistingColumn(tableColumns, candidates);
            if (!col) return;
            payload[col] = value;
        };

        setIfColumnExists(['name', 'nome', 'cliente', 'full_name'], localCustomer?.name || '');
        setIfColumnExists(['company', 'empresa', 'organization', 'entidade'], localCustomer?.company || localCustomer?.name || '');
        setIfColumnExists(['phone', 'telefone', 'telemovel', 'celular', 'whatsapp', 'numero', 'contacto'], localCustomer?.phone || '');
        setIfColumnExists(['email', 'mail'], localCustomer?.email || null);
        setIfColumnExists(['owner_id', 'funcionario_id', 'responsavel_id', 'responsavel_interno_id'], ownerSourceId || null);
        const tipoEntidadeEnum = mapLocalTypeToSupabaseTipoEntidade(localCustomer?.type);
        setIfColumnExists(['tipo_entidade'], tipoEntidadeEnum || null);
        setIfColumnExists(['type', 'tipo', 'categoria'], localCustomer?.type || tipoEntidadeEnum || null);
        setIfColumnExists(['allow_auto_responses', 'allow_auto', 'auto_reply', 'resposta_automatica'], localCustomer?.allowAutoResponses ? true : false);
        setIfColumnExists(['documents_folder', 'pasta_documentos', 'document_folder', 'docs_folder'], localCustomer?.documentsFolder || null);
        setIfColumnExists(['nif', 'vat', 'tax_id', 'numero_contribuinte', 'contribuinte'], localCustomer?.nif || null);
        setIfColumnExists(['niss', 'numero_seguranca_social', 'seg_social_numero', 'social_security_number'], localCustomer?.niss || null);
        setIfColumnExists(
            ['senha_financas', 'senha_portal_financas', 'password_financas', 'financas_password', 'portal_financas_password'],
            localCustomer?.senhaFinancas || atCredential?.password || null
        );
        setIfColumnExists(
            ['senha_seguranca_social', 'senha_seg_social', 'password_seguranca_social', 'password_seg_social', 'seg_social_password'],
            localCustomer?.senhaSegurancaSocial || ssCredential?.password || null
        );
        setIfColumnExists(['utilizador_at', 'username_at', 'user_at'], atCredential?.username || null);
        setIfColumnExists(['password_at', 'senha_at'], atCredential?.password || null);
        setIfColumnExists(['utilizador_ss', 'username_ss', 'user_ss'], ssCredential?.username || null);
        setIfColumnExists(['password_ss', 'senha_ss'], ssCredential?.password || null);
        setIfColumnExists(['utilizador_ru', 'username_ru', 'user_ru'], ruCredential?.username || null);
        setIfColumnExists(['password_ru', 'senha_ru'], ruCredential?.password || null);
        setIfColumnExists(['utilizador_viactt', 'username_viactt', 'user_viactt'], viaCttCredential?.username || null);
        setIfColumnExists(['password_viactt', 'senha_viactt'], viaCttCredential?.password || null);
        setIfColumnExists(['utilizador_iapmei', 'username_iapmei', 'user_iapmei'], iapmeiCredential?.username || null);
        setIfColumnExists(['password_iapmei', 'senha_iapmei'], iapmeiCredential?.password || null);
        setIfColumnExists(
            ['tipo_iva', 'tipoiva', 'iva_tipo', 'regime_iva', 'periodicidade_iva', 'iva_periodicidade'],
            normalizeLocalTipoIvaToSupabase(localCustomer?.tipoIva)
        );
        setIfColumnExists(['morada', 'address', 'endereco'], localCustomer?.morada || null);
        setIfColumnExists(['notes', 'notas', 'observacoes', 'obs'], localCustomer?.notes || null);
        setIfColumnExists(['certidao_permanente_numero', 'certidao_permanente_n', 'certidao_permanente'], localCustomer?.certidaoPermanenteNumero || null);
        setIfColumnExists(
            ['certidao_permanente_validade', 'validade_certidao_permanente'],
            toSupabaseDateValue(localCustomer?.certidaoPermanenteValidade)
        );
        setIfColumnExists(['rcbe_numero', 'rcbe_n', 'rcbe'], localCustomer?.rcbeNumero || null);
        setIfColumnExists(['rcbe_data'], toSupabaseDateValue(localCustomer?.rcbeData));
        setIfColumnExists(['data_constituicao'], toSupabaseDateValue(localCustomer?.dataConstituicao));
        setIfColumnExists(['inicio_atividade', 'data_inicio_atividade'], toSupabaseDateValue(localCustomer?.inicioAtividade));
        setIfColumnExists(['cae_principal', 'cae'], localCustomer?.caePrincipal || null);
        setIfColumnExists(['codigo_reparticao_financas', 'reparticao_financas'], localCustomer?.codigoReparticaoFinancas || null);
        setIfColumnExists(
            ['tipo_contabilidade'],
            normalizeLocalTipoContabilidadeToSupabase(localCustomer?.tipoContabilidade)
        );
        setIfColumnExists(
            ['estado_cliente', 'estado'],
            normalizeLocalEstadoToSupabase(localCustomer?.estadoCliente)
        );
        setIfColumnExists(['contabilista_certificado_nome', 'contabilista_certificado'], localCustomer?.contabilistaCertificado || null);

        const managersJson = Array.isArray(localCustomer?.managers) && localCustomer.managers.length > 0
            ? JSON.stringify(localCustomer.managers)
            : null;
        const accessCredentialsJson = Array.isArray(localCustomer?.accessCredentials) && localCustomer.accessCredentials.length > 0
            ? JSON.stringify(localCustomer.accessCredentials)
            : null;
        const agregadoFamiliarJson = JSON.stringify(
            Array.isArray(localCustomer?.agregadoFamiliar) ? localCustomer.agregadoFamiliar : []
        );
        const fichasRelacionadasJson = JSON.stringify(
            Array.isArray(localCustomer?.fichasRelacionadas) ? localCustomer.fichasRelacionadas : []
        );
        setIfColumnExists(['managers_json', 'gerentes_json', 'gerencia_administracao_json'], managersJson);
        setIfColumnExists(
            ['access_credentials_json', 'acessos_json', 'dados_acesso_json', 'dados_de_acesso_json', 'credenciais_json'],
            accessCredentialsJson
        );
        setIfColumnExists(['agregado_familiar_json', 'agregadofamiliar_json', 'agregado_familiar'], agregadoFamiliarJson);
        setIfColumnExists(['fichas_relacionadas_json', 'fichasrelacionadas_json', 'fichas_relacionadas'], fichasRelacionadasJson);

        const updatedAtColumn = pickExistingColumn(tableColumns, [SUPABASE_CLIENTS_UPDATED_AT_COLUMN, 'updated_at']);
        if (updatedAtColumn) {
            payload[updatedAtColumn] = new Date().toISOString();
        }
        return payload;
    }

    function resolveSupabaseCustomerColumns(tableColumns = []) {
        const idColumn = pickExistingColumn(tableColumns, ['id', 'cliente_id', 'uuid']);
        const nifColumn = pickExistingColumn(tableColumns, ['nif', 'vat', 'tax_id', 'numero_contribuinte', 'contribuinte']);
        const phoneColumn = pickExistingColumn(tableColumns, ['phone', 'telefone', 'telemovel', 'celular', 'whatsapp', 'numero', 'contacto']);
        const emailColumn = pickExistingColumn(tableColumns, ['email', 'mail']);
        const updatedAtColumn = pickExistingColumn(tableColumns, [SUPABASE_CLIENTS_UPDATED_AT_COLUMN, 'updated_at']);
        return { idColumn, nifColumn, phoneColumn, emailColumn, updatedAtColumn };
    }

    async function getLocalCustomerBySourceId(sourceId) {
        const normalizedSourceId = String(sourceId || '').trim();
        if (!normalizedSourceId) return null;
        return dbGetAsync(
            `SELECT *
             FROM customers
             WHERE source_id = ?
             LIMIT 1`,
            [normalizedSourceId]
        );
    }

    async function findSupabaseCustomerRow({
        columns = [],
        sourceId = '',
        nif = '',
        phone = '',
        email = '',
    }) {
        const { idColumn, nifColumn, phoneColumn, emailColumn, updatedAtColumn } = resolveSupabaseCustomerColumns(columns);
        const filtersQueue = [];

        const normalizedSourceId = String(sourceId || '').trim();
        if (idColumn && normalizedSourceId) {
            filtersQueue.push({ [idColumn]: normalizedSourceId });
        }

        const normalizedNif = normalizeDigitsOnly(nif);
        if (nifColumn && normalizedNif) {
            const nifVariants = uniqueNonEmpty([
                String(nif || '').trim(),
                normalizedNif,
                normalizedNif.slice(-9),
                `PT${normalizedNif.slice(-9)}`,
            ]);
            nifVariants.forEach((variant) => {
                filtersQueue.push({ [nifColumn]: variant });
            });
        }

        // Quando existe NIF, evitamos fallback por telefone/email para não casar
        // incorretamente fichas diferentes (pode causar erro de NIF imutável).
        const allowWeakIdentityFallback = !(nifColumn && normalizedNif);
        if (allowWeakIdentityFallback) {
            const normalizedPhone = String(phone || '').trim();
            if (phoneColumn && normalizedPhone) {
                filtersQueue.push({ [phoneColumn]: normalizedPhone });
            }

            const normalizedEmail = String(email || '').trim().toLowerCase();
            if (emailColumn && normalizedEmail) {
                filtersQueue.push({ [emailColumn]: normalizedEmail });
            }
        }

        const tried = new Set();
        for (const filter of filtersQueue) {
            const filterKey = JSON.stringify(filter);
            if (tried.has(filterKey)) continue;
            tried.add(filterKey);
            try {
                const rows = await fetchSupabaseTableWithFilters(
                    SUPABASE_CLIENTS_SOURCE,
                    filter,
                    {
                        limit: 2,
                        orderBy: updatedAtColumn || idColumn || '',
                        orderDirection: 'desc',
                    }
                );
                if (Array.isArray(rows) && rows.length > 0) {
                    return {
                        row: rows[0],
                        filter,
                        columnsMeta: { idColumn, nifColumn, phoneColumn, emailColumn, updatedAtColumn },
                    };
                }
            } catch (error) {
                // Ignora filtro inválido (ex.: id UUID mal formatado) e tenta o próximo.
                continue;
            }
        }

        return {
            row: null,
            filter: null,
            columnsMeta: { idColumn, nifColumn, phoneColumn, emailColumn, updatedAtColumn },
        };
    }

    async function materializeSupabaseRowLocally(rawRow, preferredLocalId = '') {
        if (!rawRow || typeof rawRow !== 'object') return null;
        const candidate = normalizeSupabaseCustomerCandidate(rawRow, 0);
        const shouldApplyType = hasExplicitSupabaseCustomerType(rawRow);
        const shouldApplyAccessCredentials = hasExplicitSupabaseAccessCredentials(rawRow);
        const saved = await upsertLocalCustomer({
            id: String(preferredLocalId || '').trim() || candidate.localId || undefined,
            sourceId: candidate.sourceId || undefined,
            name: candidate.name,
            company: candidate.company,
            phone: candidate.phone,
            email: candidate.email || undefined,
            documentsFolder: candidate.documentsFolder || undefined,
            nif: candidate.nif || undefined,
            niss: candidate.niss || undefined,
            senhaFinancas: candidate.senhaFinancas || undefined,
            senhaSegurancaSocial: candidate.senhaSegurancaSocial || undefined,
            tipoIva: candidate.tipoIva || undefined,
            morada: candidate.morada || undefined,
            certidaoPermanenteNumero: candidate.certidaoPermanenteNumero || undefined,
            certidaoPermanenteValidade: candidate.certidaoPermanenteValidade || undefined,
            rcbeNumero: candidate.rcbeNumero || undefined,
            rcbeData: candidate.rcbeData || undefined,
            dataConstituicao: candidate.dataConstituicao || undefined,
            inicioAtividade: candidate.inicioAtividade || undefined,
            caePrincipal: candidate.caePrincipal || undefined,
            codigoReparticaoFinancas: candidate.codigoReparticaoFinancas || undefined,
            tipoContabilidade: candidate.tipoContabilidade || undefined,
            estadoCliente: candidate.estadoCliente || undefined,
            contabilistaCertificado: candidate.contabilistaCertificado || undefined,
            managers: Array.isArray(candidate.managers) ? candidate.managers : [],
            accessCredentials: shouldApplyAccessCredentials
                ? (Array.isArray(candidate.accessCredentials) ? candidate.accessCredentials : [])
                : undefined,
            agregadoFamiliar: Array.isArray(candidate.agregadoFamiliar) ? candidate.agregadoFamiliar : [],
            fichasRelacionadas: Array.isArray(candidate.fichasRelacionadas) ? candidate.fichasRelacionadas : [],
            ownerId: candidate.ownerId || undefined,
            type: shouldApplyType ? candidate.type : undefined,
            contacts: [],
            supabasePayload: rawRow,
            supabaseUpdatedAt: candidate.supabaseUpdatedAt || undefined,
            allowNifOverwrite: true,
            allowAutoResponses: true,
        });
        return saved;
    }

    async function pushLocalCustomerToSupabase(localCustomer, tableColumns = []) {
        let warnings = [];
        if (!localCustomer?.id || !hasSupabaseCustomersSync()) {
            return { customer: localCustomer || null, warnings };
        }

        const sourceId = String(parseCustomerSourceId(localCustomer.id, localCustomer.sourceId) || '').trim();
        const supabaseMatch = await findSupabaseCustomerRow({
            columns: tableColumns,
            sourceId,
            nif: localCustomer.nif,
            phone: localCustomer.phone,
            email: localCustomer.email,
        });
        const supabaseRow = supabaseMatch?.row || null;
        const columnsMeta = supabaseMatch?.columnsMeta || resolveSupabaseCustomerColumns(tableColumns);
        const payload = buildSupabaseCustomerPayloadFromLocal(localCustomer, tableColumns);

        let returnedRows = [];
        try {
            if (supabaseRow && columnsMeta?.idColumn && sourceId && isUuidLike(sourceId)) {
                returnedRows = await patchSupabaseTableWithFilters(
                    SUPABASE_CLIENTS_SOURCE,
                    payload,
                    { [columnsMeta.idColumn]: sourceId }
                );
            } else if (supabaseRow && columnsMeta?.nifColumn && localCustomer.nif) {
                returnedRows = await patchSupabaseTableWithFilters(
                    SUPABASE_CLIENTS_SOURCE,
                    payload,
                    { [columnsMeta.nifColumn]: localCustomer.nif }
                );
            } else {
                const payloadForInsert = { ...payload };
                // Quando o sourceId local não é UUID (ex.: NIF), não tentamos gravar no id UUID do Supabase.
                // Deixamos o Supabase gerar o id e depois materializamos esse id no SQLite local.
                if (columnsMeta?.idColumn && sourceId && isUuidLike(sourceId)) {
                    payloadForInsert[columnsMeta.idColumn] = sourceId;
                }
                returnedRows = await upsertSupabaseRow(
                    SUPABASE_CLIENTS_SOURCE,
                    payloadForInsert,
                    columnsMeta?.idColumn && sourceId && isUuidLike(sourceId) ? [columnsMeta.idColumn] : []
                );
            }
        } catch (syncError) {
            const errorMessage = String(syncError?.message || syncError);
            const errorPayload = syncError?.response?.data;
            const errorDetails =
                errorPayload && typeof errorPayload === 'object'
                    ? JSON.stringify(errorPayload)
                    : String(errorPayload || '').trim();
            warnings.push(`Falha a sincronizar no Supabase: ${errorMessage}${errorDetails ? ` | ${errorDetails}` : ''}`);
        }

        if ((!Array.isArray(returnedRows) || returnedRows.length === 0)) {
            const freshMatch = await findSupabaseCustomerRow({
                columns: tableColumns,
                sourceId,
                nif: localCustomer.nif,
                phone: localCustomer.phone,
                email: localCustomer.email,
            });
            if (freshMatch?.row) {
                returnedRows = [freshMatch.row];
            }
        }

        if (Array.isArray(returnedRows) && returnedRows.length > 0) {
            const canonical = await materializeSupabaseRowLocally(returnedRows[0], localCustomer.id);
            const remoteCustomerId = String(
                returnedRows?.[0]?.[columnsMeta?.idColumn || ''] ||
                parseCustomerSourceId(canonical?.id || '', canonical?.sourceId || '') ||
                sourceId
            ).trim();
            const credentialsWarnings = await syncLocalCustomerCredentialsToSupabase(
                canonical || localCustomer,
                remoteCustomerId
            );
            if (Array.isArray(credentialsWarnings) && credentialsWarnings.length > 0) {
                warnings.push(...credentialsWarnings);
            }
            if (columnsMeta?.updatedAtColumn) {
                await bumpCustomersSyncWatermark(returnedRows, columnsMeta.updatedAtColumn);
            }
            return { customer: canonical || localCustomer, warnings };
        }

        return { customer: localCustomer, warnings };
    }

    async function bumpCustomersSyncWatermark(rows = [], updatedAtColumn = '') {
        const safeColumn = String(updatedAtColumn || '').trim();
        if (!safeColumn || !Array.isArray(rows) || rows.length === 0) return '';
        let maxIso = '';
        rows.forEach((row) => {
            const normalized = normalizeSupabaseTimestamp(row?.[safeColumn]);
            if (!normalized) return;
            if (!maxIso || new Date(normalized).getTime() > new Date(maxIso).getTime()) {
                maxIso = normalized;
            }
        });
        if (maxIso) {
            await setSyncStateValue(customersSyncStateKey(), maxIso);
        }
        return maxIso;
    }

    async function pullCustomersFromSupabaseIncremental({ full = false, limit = 5000 }) {
        if (!hasSupabaseCustomersSync()) {
            throw new Error('Supabase clientes não configurado.');
        }

        const tableColumns = await fetchSupabaseTableColumns(SUPABASE_CLIENTS_SOURCE);
        const { updatedAtColumn } = resolveSupabaseCustomerColumns(tableColumns);
        const since = !full && updatedAtColumn ? await getSyncStateValue(customersSyncStateKey()) : '';

        let rows = [];
        if (updatedAtColumn && since) {
            rows = await fetchSupabaseTableSince(SUPABASE_CLIENTS_SOURCE, updatedAtColumn, since);
        } else {
            rows = await fetchSupabaseTable(SUPABASE_CLIENTS_SOURCE);
        }

        if (Number.isFinite(Number(limit)) && Number(limit) > 0 && rows.length > Number(limit)) {
            rows = rows.slice(0, Number(limit));
        }

        const preparedRows = rows.map((row, index) => {
            const candidate = normalizeSupabaseCustomerCandidate(row, index);
            const normalizedNif = normalizeNifDigits(candidate.nif);
            return { row, candidate, normalizedNif };
        });
        const missingNifRows = preparedRows.filter((entry) => !entry.normalizedNif);
        if (missingNifRows.length > 0) {
            const sample = missingNifRows
                .slice(0, 10)
                .map((entry) => String(entry.candidate.company || entry.candidate.name || entry.candidate.sourceId || 'desconhecido'))
                .join(', ');
            throw new Error(
                `Supabase inválido: existem clientes sem NIF (${missingNifRows.length}). Exemplos: ${sample}`
            );
        }

        const nifCountMap = new Map();
        preparedRows.forEach((entry) => {
            const current = Number(nifCountMap.get(entry.normalizedNif) || 0);
            nifCountMap.set(entry.normalizedNif, current + 1);
        });
        const duplicateNifRows = preparedRows.filter((entry) => Number(nifCountMap.get(entry.normalizedNif) || 0) > 1);
        if (duplicateNifRows.length > 0) {
            const grouped = new Map();
            duplicateNifRows.forEach((entry) => {
                const key = entry.normalizedNif;
                if (!grouped.has(key)) grouped.set(key, []);
                grouped.get(key).push(entry.candidate);
            });
            const sample = Array.from(grouped.entries())
                .slice(0, 10)
                .map(([nif, list]) => `${nif}: ${list.map((item) => String(item.company || item.name || item.sourceId || 'desconhecido')).join(' | ')}`)
                .join(' ; ');
            throw new Error(
                `Supabase inválido: existem NIF duplicados (${grouped.size} grupos). Exemplos: ${sample}`
            );
        }

        let synced = 0;
        const errors = [];
        for (const entry of preparedRows) {
            try {
                const { row, candidate } = entry;
                const localBySource = candidate.sourceId ? await getLocalCustomerBySourceId(candidate.sourceId) : null;
                await materializeSupabaseRowLocally(row, String(localBySource?.id || '').trim());
                synced += 1;
            } catch (error) {
                errors.push(String(error?.message || error));
            }
        }

        const watermark = await bumpCustomersSyncWatermark(rows, updatedAtColumn);
        return {
            synced,
            fetched: rows.length,
            skippedNoNif: 0,
            skippedDuplicateNif: 0,
            errors,
            updatedAtColumn,
            since: since || null,
            watermark: watermark || (since || null),
        };
    }

    function extractYearFromFileName(fileName) {
        const matches = String(fileName || '').match(/(20\d{2})/g);
        if (!matches || matches.length === 0) return null;
        const year = Number(matches[matches.length - 1]);
        return Number.isFinite(year) ? year : null;
    }

    function isValidAnnualObrigacaoYear(year) {
        const parsed = Number(year || 0);
        if (!Number.isFinite(parsed) || parsed < 2000) return false;
        const currentYear = new Date().getUTCFullYear();
        return parsed <= (currentYear - 1);
    }

    function extractDateToken(rawValue, fallbackIso = '') {
        const raw = String(rawValue || '').trim();
        const directIso = String(fallbackIso || '').trim();
        const toIsoToken = (value) => {
            const ts = Date.parse(value);
            if (!Number.isFinite(ts)) return '';
            const date = new Date(ts);
            const year = date.getUTCFullYear();
            const month = String(date.getUTCMonth() + 1).padStart(2, '0');
            const day = String(date.getUTCDate()).padStart(2, '0');
            return `${year}${month}${day}`;
        };
        if (raw) {
            const dmy = raw.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
            if (dmy) {
                const day = String(dmy[1]).padStart(2, '0');
                const month = String(dmy[2]).padStart(2, '0');
                const yearRaw = Number(dmy[3]);
                const year = yearRaw < 100 ? (2000 + yearRaw) : yearRaw;
                return `${year}${month}${day}`;
            }
            const ymd = raw.match(/\b(20\d{2})[\/.-](\d{1,2})[\/.-](\d{1,2})\b/);
            if (ymd) {
                const month = String(ymd[2]).padStart(2, '0');
                const day = String(ymd[3]).padStart(2, '0');
                return `${ymd[1]}${month}${day}`;
            }
            const digits = raw.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
            if (digits) {
                return `${digits[1]}${digits[2]}${digits[3]}`;
            }
            const fromDateParse = toIsoToken(raw);
            if (fromDateParse) return fromDateParse;
        }
        if (directIso) {
            const fallbackToken = toIsoToken(directIso);
            if (fallbackToken) return fallbackToken;
        }
        return nowIso().slice(0, 10).replace(/-/g, '');
    }

    function classifyDeclarationVariant(fileName = '') {
        const folded = normalizeFold(fileName);
        if (!folded) return 'at';
        if (/_2(\.[a-z0-9]+)?$/i.test(String(fileName || '').trim())) return 'ss';
        if (/_1(\.[a-z0-9]+)?$/i.test(String(fileName || '').trim())) return 'at';
        if (folded.includes('dndss') || folded.includes('seguranca') || /(^|[^a-z])ss([^a-z]|$)/.test(folded)) return 'ss';
        if (folded.includes('dndat') || folded.includes('financas') || /(^|[^a-z])at([^a-z]|$)/.test(folded)) return 'at';
        return 'at';
    }

    function classifyCrcVariant(fileName = '') {
        const folded = normalizeFold(fileName);
        if (folded.includes('bdc') || folded.includes('balancete')) return 'bdc';
        return 'crc';
    }

    function buildSaftArchivePlacement({
        documentType,
        customer,
        sourceFileName = '',
        sourceUpdatedAt = '',
        dossierMetadata = null,
    }) {
        const nif = String(customer?.nif || '').replace(/\D/g, '') || 'sem_nif';
        const ext = '.pdf';
        const updatedAtToken = extractDateToken('', sourceUpdatedAt);
        const foldedName = normalizeFold(sourceFileName);
        const metadata = dossierMetadata || {};
        const metadataDataPedidos = Array.isArray(metadata?.dataPedidos) ? metadata.dataPedidos : [];
        const metadataDataRecolhas = Array.isArray(metadata?.dataRecolhas) ? metadata.dataRecolhas : [];

        if (documentType === 'declaracao_nao_divida') {
            const variant = classifyDeclarationVariant(sourceFileName);
            if (variant === 'ss') {
                const dateToken = extractDateToken(
                    metadata?.dataPedidoSs || metadataDataPedidos[1] || metadataDataPedidos[0],
                    sourceUpdatedAt
                );
                return {
                    folderParts: ['Documentos Oficiais'],
                    fileName: `DNDSS_${nif}_${dateToken}${ext}`,
                };
            }
            const dateToken = extractDateToken(
                metadata?.dataRecolhaAt || metadataDataRecolhas[0] || metadata?.dataPedidoAt || metadataDataPedidos[0],
                sourceUpdatedAt
            );
            return {
                folderParts: ['Documentos Oficiais'],
                fileName: `DNDAT_${nif}_${dateToken}${ext}`,
            };
        }

        if (documentType === 'certidao_permanente') {
            const codeRaw = String(metadata?.certidaoPermanenteCodigo || '').replace(/[^\d-]/g, '');
            const code = codeRaw || 'sem_codigo';
            const validadeToken = extractDateToken(metadata?.certidaoPermanenteValidade, sourceUpdatedAt);
            return {
                folderParts: ['Documentos Oficiais'],
                fileName: `CP_${code}_${validadeToken}${ext}`,
            };
        }

        if (documentType === 'certificado_pme') {
            const dateToken = extractDateToken(
                metadataDataRecolhas[metadataDataRecolhas.length - 1] || metadata?.dataRecolhaPme || '',
                sourceUpdatedAt
            );
            return {
                folderParts: ['Documentos Oficiais'],
                fileName: `PME_${nif}_${dateToken}${ext}`,
            };
        }

        if (documentType === 'crc') {
            const crcVariant = classifyCrcVariant(sourceFileName);
            const dateToken = extractDateToken(
                metadata?.dataRecolhaCrc || metadataDataRecolhas[metadataDataRecolhas.length - 1] || '',
                sourceUpdatedAt
            );
            if (crcVariant === 'bdc') {
                return {
                    folderParts: ['Finanças'],
                    fileName: `BDC_${nif}_${dateToken}${ext}`,
                };
            }
            return {
                folderParts: ['Documentos Oficiais'],
                fileName: `CRC_${nif}_${dateToken}${ext}`,
            };
        }

        if (documentType === 'ies') {
            const extractedYear = extractYearFromFileName(sourceFileName);
            const year = isValidAnnualObrigacaoYear(extractedYear) ? extractedYear : null;
            const dateToken = extractDateToken('', sourceUpdatedAt);
            return {
                folderParts: ['Finanças'],
                fileName: year
                    ? `IES_${nif}_${year}${ext}`
                    : `IES_${nif}_SEM_ANO_${dateToken}${ext}`,
            };
        }

        if (documentType === 'modelo_22') {
            const extractedYear = extractYearFromFileName(sourceFileName);
            const year = isValidAnnualObrigacaoYear(extractedYear) ? extractedYear : null;
            const dateToken = extractDateToken('', sourceUpdatedAt);
            return {
                folderParts: ['Finanças'],
                fileName: year
                    ? `M22_${nif}_${year}${ext}`
                    : `M22_${nif}_SEM_ANO_${dateToken}${ext}`,
            };
        }

        return {
            folderParts: ['Documentos Oficiais'],
            fileName: sanitizeDocumentFileName(sourceFileName || `DOC_${nif}_${updatedAtToken}${ext}`),
        };
    }

    function selectLatestFilesPerYear(files, maxYears = 3, options = {}) {
        const byYear = new Map();
        const undated = [];
        const includeUndatedFallback = options?.includeUndatedFallback !== false;
        const yearFilter = typeof options?.yearFilter === 'function' ? options.yearFilter : null;
        for (const file of files) {
            const year = extractYearFromFileName(file.fileName);
            if (!year) {
                undated.push(file);
                continue;
            }
            if (yearFilter && !yearFilter(year)) {
                continue;
            }
            const previous = byYear.get(year);
            if (!previous) {
                byYear.set(year, file);
                continue;
            }
            const prevTs = new Date(previous.updatedAt || 0).getTime();
            const currTs = new Date(file.updatedAt || 0).getTime();
            if (currTs > prevTs) {
                byYear.set(year, file);
            }
        }

        const years = Array.from(byYear.keys()).sort((a, b) => b - a).slice(0, Math.max(1, Number(maxYears || 3)));
        const selected = years.map((year) => byYear.get(year)).filter(Boolean);
        if (selected.length === 0 && includeUndatedFallback && undated.length > 0) {
            const sortedUndated = [...undated].sort(
                (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
            );
            return [sortedUndated[0]];
        }
        return selected;
    }

    async function copyToCustomerStructuredFolder({ customerFolderPath, folderParts = [], documentType = '', fileName, sourcePath }) {
        try {
            const fallbackByType =
                String(documentType || '').trim() === 'modelo_22' || String(documentType || '').trim() === 'ies'
                    ? ['Finanças']
                    : ['Documentos Oficiais'];
            const safeFolderParts =
                Array.isArray(folderParts) && folderParts.length > 0
                    ? folderParts
                    : fallbackByType;
            const targetFolder = path.join(customerFolderPath, ...safeFolderParts.map((part) => sanitizeDocumentFileName(part)));
            await ensureWritableFolderTree(customerFolderPath, targetFolder);
            const targetPath = path.join(targetFolder, sanitizeDocumentFileName(fileName));
            const resolvedSource = path.resolve(String(sourcePath || ''));
            if (path.resolve(targetPath) !== resolvedSource) {
                await fs.promises.copyFile(resolvedSource, targetPath);
            }
            return targetPath;
        } catch (error) {
            console.warn(
                `[SAFT] Sem permissão para pasta estruturada em ${customerFolderPath}. A manter no root. Motivo:`,
                error?.message || error
            );
            return '';
        }
    }

    async function selectSaftFilesForDelivery({ documentType, candidateFiles, yearsToKeep = 3 }) {
        if (documentType === 'modelo_22') {
            const modelFiles = selectModelo22Files(candidateFiles);
            return selectLatestFilesPerYear(modelFiles, yearsToKeep, {
                includeUndatedFallback: false,
                yearFilter: (year) => isValidAnnualObrigacaoYear(year),
            });
        }
        if (documentType === 'ies') {
            return selectLatestFilesPerYear(candidateFiles, yearsToKeep, {
                includeUndatedFallback: false,
                yearFilter: (year) => isValidAnnualObrigacaoYear(year),
            });
        }
        const sorted = [...candidateFiles].sort(
            (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
        );
        if (documentType === 'declaracao_nao_divida') {
            const byVariant = new Map();
            sorted.forEach((item) => {
                const variant = classifyDeclarationVariant(item.fileName || '');
                if (!byVariant.has(variant)) {
                    byVariant.set(variant, item);
                }
            });
            const selected = [];
            if (byVariant.has('ss')) selected.push(byVariant.get('ss'));
            if (byVariant.has('at')) selected.push(byVariant.get('at'));
            if (selected.length === 0 && sorted.length > 0) selected.push(sorted[0]);
            return selected.filter(Boolean);
        }
        return sorted.length > 0 ? [sorted[0]] : [];
    }

    async function registerSaftSyncJobState({
        customerId,
        documentType,
        status,
        fileName = null,
        filePath = null,
        error = null,
        requestedBy = null,
    }) {
        await dbRunAsync(
            `INSERT INTO saft_jobs (
                customer_id, conversation_id, document_type, status, file_name, file_path, error, requested_by, created_at, updated_at
             ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [
                String(customerId || '').trim(),
                String(documentType || '').trim(),
                String(status || '').trim() || 'pending',
                fileName ? String(fileName).trim() : null,
                filePath ? String(filePath).trim() : null,
                error ? String(error).slice(0, 1000) : null,
                requestedBy ? String(requestedBy).trim() : null,
            ]
        );
    }

    async function appendSaftSyncLogFile(customerFolderPath, payload) {
        try {
            const logPath = path.join(customerFolderPath, 'recolha.json');
            let existingRuns = [];
            if (fs.existsSync(logPath)) {
                const raw = await fs.promises.readFile(logPath, 'utf8');
                if (raw.trim()) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        existingRuns = parsed;
                    } else if (Array.isArray(parsed?.runs)) {
                        existingRuns = parsed.runs;
                    }
                }
            }

            const nextRuns = [...existingRuns, payload].slice(-100);
            await fs.promises.writeFile(
                logPath,
                JSON.stringify(
                    {
                        updatedAt: nowIso(),
                        runs: nextRuns,
                    },
                    null,
                    2
                ),
                'utf8'
            );
        } catch (error) {
            console.warn('[SAFT] Falha ao atualizar recolha.json:', error?.message || error);
        }
    }

    async function deleteUserWithSafety({ targetUserId, actorUserId }) {
        const normalizedTargetUserId = String(targetUserId || '').trim();
        const normalizedActorUserId = String(actorUserId || '').trim();
        if (!normalizedTargetUserId) {
            return { ok: false, status: 400, error: 'ID do funcionário é obrigatório.' };
        }
        if (!normalizedActorUserId) {
            return { ok: false, status: 400, error: 'actorUserId é obrigatório.' };
        }
        if (normalizedTargetUserId === normalizedActorUserId) {
            return { ok: false, status: 400, error: 'Não pode eliminar o seu próprio utilizador.' };
        }

        const targetUser = await dbGetAsync(
            `SELECT id, name, email, role
             FROM users
             WHERE id = ?
             LIMIT 1`,
            [normalizedTargetUserId]
        );
        if (!targetUser) {
            return { ok: false, status: 404, error: 'Funcionário não encontrado.' };
        }

        const normalizedRole = String(targetUser.role || '').trim().toUpperCase();
        if (normalizedRole === 'ADMIN') {
            const adminCountRow = await dbGetAsync(
                `SELECT COUNT(*) AS c
                 FROM users
                 WHERE upper(role) = 'ADMIN'
                   AND id <> ?`,
                [normalizedTargetUserId]
            );
            const remainingAdmins = Number(adminCountRow?.c || 0);
            if (remainingAdmins <= 0) {
                return { ok: false, status: 400, error: 'Tem de existir pelo menos 1 administrador ativo.' };
            }
        }

        const refs = await dbGetAsync(
            `SELECT
                (SELECT COUNT(*) FROM internal_messages WHERE sender_user_id = ?) AS internal_messages_count,
                (SELECT COUNT(*) FROM internal_conversation_members WHERE user_id = ?) AS internal_conversations_count,
                (SELECT COUNT(*) FROM tasks WHERE assigned_user_id = ?) AS tasks_count,
                (SELECT COUNT(*) FROM calls WHERE user_id = ?) AS calls_count,
                (SELECT COUNT(*) FROM customers WHERE owner_id = ?) AS customers_count`,
            [normalizedTargetUserId, normalizedTargetUserId, normalizedTargetUserId, normalizedTargetUserId, normalizedTargetUserId]
        );

        const linkedCount =
            Number(refs?.internal_messages_count || 0)
            + Number(refs?.internal_conversations_count || 0)
            + Number(refs?.tasks_count || 0)
            + Number(refs?.calls_count || 0)
            + Number(refs?.customers_count || 0);
        if (linkedCount > 0) {
            return {
                ok: false,
                status: 409,
                error: 'Este funcionário ainda tem dados ligados (chat/tarefas/chamadas/clientes). Remova primeiro essas ligações.',
                refs: {
                    internalMessages: Number(refs?.internal_messages_count || 0),
                    internalConversations: Number(refs?.internal_conversations_count || 0),
                    tasks: Number(refs?.tasks_count || 0),
                    calls: Number(refs?.calls_count || 0),
                    customers: Number(refs?.customers_count || 0),
                },
            };
        }

        await dbRunAsync(
            `DELETE FROM users
             WHERE id = ?`,
            [normalizedTargetUserId]
        );

        await writeAuditLog({
            actorUserId: normalizedActorUserId,
            entityType: 'user',
            entityId: normalizedTargetUserId,
            action: 'delete',
            details: {
                deletedName: String(targetUser.name || '').trim(),
                deletedEmail: String(targetUser.email || '').trim().toLowerCase(),
            },
        });

        return {
            ok: true,
            status: 200,
            deletedUserId: normalizedTargetUserId,
        };
    }


    // ─── Sub-module delegation ───────────────────────────────────────
    const { registerSaftCustomerSyncRoutes } = require('./saftCustomerSyncRoutes');
    const { registerSaftDocumentRoutes } = require('./saftDocumentRoutes');
    const { registerSaftOperationsRoutes } = require('./saftOperationsRoutes');

    const helpers = {
        // customer sync helpers
        deleteUserWithSafety, hasSupabaseCustomersSync,
        getLocalCustomerBySourceId, findSupabaseCustomerRow,
        normalizeSupabaseTimestamp, materializeSupabaseRowLocally,
        pushLocalCustomerToSupabase, syncBidirectionalCustomerLinksLocal,
        pullCustomersFromSupabaseIncremental, resolveSupabaseCustomerColumns,
        bumpCustomersSyncWatermark, buildSupabaseCustomerPayloadFromLocal,
        syncLocalCustomerCredentialsToSupabase,
        splitSelectorList, resolveAtCredentialForAutologin,
        launchFinancasBrowserWithFallback, activateFinancasNifTab,
        findFirstVisibleSelector, clickContinueLoginIf2faPrompt,
        resolveSsCredentialForAutologin, clickCookieConsentIfPresent,
        openSegSocialLoginEntryIfNeeded, ensureSegSocialCredentialsFormVisible,
        clickContinueWithoutActivatingIfPrompt,
        isFinancasAutologinRunningRef: { get value() { return isFinancasAutologinRunning; }, set value(v) { isFinancasAutologinRunning = v; } },
        // document helpers
        hasConfiguredCustomerFolder, normalizeRelativeFolderPath,
        ensureWritableFolderTree, guessMimeType,
        normalizeCustomerIngestDocumentType,
        extractCustomerDocumentWithGemini, buildIngestDocumentFileName,
        findLocalCustomerByNifDigits, buildSuggestedCustomerFromExtraction,
        mergeManagers, buildPublicBaseUrl,
        CUSTOMER_INGEST_DOC_TYPES,
        // saft operations helpers
        normalizeNifDigits, parseDateToIso, toPtDate, toDateToken,
        extractDateToken, extractYearFromFileName, isValidAnnualObrigacaoYear,
        classifyDeclarationVariant, classifyCrcVariant,
        buildSaftArchivePlacement, selectLatestFilesPerYear,
        copyToCustomerStructuredFolder, selectSaftFilesForDelivery,
        registerSaftSyncJobState, appendSaftSyncLogFile,
        SAFT_COMPANY_DOC_TYPES, FOUR_MONTHS_MS,
    };

    registerSaftCustomerSyncRoutes(context, helpers);
    registerSaftDocumentRoutes(context, helpers);
    registerSaftOperationsRoutes(context, helpers);
}

module.exports = {
    registerLocalSyncSaftRoutes,
};
