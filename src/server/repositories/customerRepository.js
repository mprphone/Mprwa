function createCustomerRepository(deps) {
    const {
        dbAllAsync,
        dbGetAsync,
        dbRunAsync,
        normalizePhone,
        normalizeDigits,
        normalizeBoolean,
        normalizeCustomerType,
        parseManagersArray,
        parseAccessCredentialsArray,
        applyDefaultAccessCredentialUsernames,
        serializeAccessCredentialsForStorage,
        parseCustomerProfile,
        buildCustomerProfileFromInput,
        serializeCustomerProfile,
        parseJsonObject,
        parseJsonArray,
        parseAgregadoFamiliarArray,
        parseFichasRelacionadasArray,
        encryptCustomerSecret,
        decryptCustomerSecret,
    } = deps;

    function sanitizeCustomerId(rawId, rawPhone) {
        const candidate = String(rawId || '').trim();
        if (candidate) return candidate;

        const phoneSeed = normalizePhone(String(rawPhone || ''))
            .replace('+', '')
            .trim();
        return phoneSeed ? `local_c_${phoneSeed}` : `local_c_${Date.now()}`;
    }

    function parseCustomerSourceId(customerId, explicitSourceId) {
        const source = String(explicitSourceId || '').trim();
        if (source) return source;

        const id = String(customerId || '').trim();
        if (id.startsWith('ext_c_')) return id.slice(6);
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return id;
        return '';
    }

    function normalizeCustomerNif(value) {
        return normalizeDigits(String(value || '')).slice(-9);
    }

    function isValidPortugueseNif(value) {
        const nif = normalizeCustomerNif(value);
        if (!/^[0-9]{9}$/.test(nif)) return false;

        const firstDigit = Number(nif[0]);
        const allowedFirstDigits = new Set([1, 2, 3, 5, 6, 8, 9]);
        if (!allowedFirstDigits.has(firstDigit)) return false;

        let total = 0;
        for (let i = 0; i < 8; i += 1) {
            total += Number(nif[i]) * (9 - i);
        }
        const modulo = total % 11;
        const checkDigit = modulo < 2 ? 0 : 11 - modulo;
        return checkDigit === Number(nif[8]);
    }

    function parseContactsArray(rawValue) {
        if (Array.isArray(rawValue)) {
            return rawValue
                .map((item) => ({
                    name: String(item?.name || '').trim() || 'Contacto',
                    phone: normalizePhone(String(item?.phone || '')),
                }))
                .filter((item) => item.name || item.phone);
        }

        if (typeof rawValue === 'string' && rawValue.trim()) {
            try {
                return parseContactsArray(JSON.parse(rawValue));
            } catch (error) {
                return [];
            }
        }

        return [];
    }

    function normalizeLocalSqlCustomer(row) {
        if (!row) return null;

        const id = String(row.id || '').trim();
        const name = String(row.name || '').trim();
        const company = String(row.company || '').trim();
        if (!id || !name || !company) return null;

        const profile = parseCustomerProfile(row.customer_profile_json);

        return {
            id,
            sourceId: String(row.source_id || '').trim() || undefined,
            name,
            company,
            contactName: String(row.contact_name || '').trim() || undefined,
            phone: normalizePhone(String(row.phone || '')),
            email: String(row.email || '').trim().toLowerCase() || undefined,
            documentsFolder: String(row.documents_folder || '').trim() || undefined,
            nif: String(row.nif || '').trim() || undefined,
            niss: String(row.niss || '').trim() || undefined,
            senhaFinancas: decryptCustomerSecret(String(row.senha_financas || '').trim()) || undefined,
            senhaSegurancaSocial: decryptCustomerSecret(String(row.senha_seg_social || '').trim()) || undefined,
            tipoIva: String(row.tipo_iva || '').trim() || undefined,
            morada: String(row.morada || '').trim() || undefined,
            certidaoPermanenteNumero: profile.certidaoPermanenteNumero || undefined,
            certidaoPermanenteValidade: profile.certidaoPermanenteValidade || undefined,
            rcbeNumero: profile.rcbeNumero || undefined,
            rcbeData: profile.rcbeData || undefined,
            dataConstituicao: profile.dataConstituicao || undefined,
            inicioAtividade: profile.inicioAtividade || undefined,
            caePrincipal: profile.caePrincipal || undefined,
            codigoReparticaoFinancas: profile.codigoReparticaoFinancas || undefined,
            tipoContabilidade: profile.tipoContabilidade || undefined,
            estadoCliente: profile.estadoCliente || undefined,
            contabilistaCertificado: profile.contabilistaCertificado || undefined,
            notes: profile.notes || undefined,
            managers: parseManagersArray(row.managers_json),
            accessCredentials: applyDefaultAccessCredentialUsernames(
                parseAccessCredentialsArray(row.access_credentials_json),
                String(row.nif || '').trim()
            ),
            agregadoFamiliar: parseAgregadoFamiliarArray(row.agregado_familiar_json),
            fichasRelacionadas: parseFichasRelacionadasArray(row.fichas_relacionadas_json),
            supabasePayload: parseJsonObject(row.supabase_payload_json) || undefined,
            supabaseUpdatedAt: String(row.supabase_updated_at || '').trim() || undefined,
            ownerId: String(row.owner_id || '').trim() || null,
            type: normalizeCustomerType(row.type),
            contacts: parseContactsArray(row.contacts_json),
            allowAutoResponses: normalizeBoolean(row.allow_auto_responses, true),
        };
    }

    async function getAllLocalCustomers() {
        const rows = await dbAllAsync(
            `SELECT id, source_id, name, company, contact_name, phone, email, owner_id, type, contacts_json, allow_auto_responses, documents_folder, nif, niss, senha_financas, senha_seg_social, tipo_iva, morada, customer_profile_json, managers_json, access_credentials_json, agregado_familiar_json, fichas_relacionadas_json, supabase_payload_json, supabase_updated_at
             FROM customers
             ORDER BY datetime(updated_at) DESC`
        );
        return rows.map(normalizeLocalSqlCustomer).filter(Boolean);
    }

    async function upsertLocalCustomer(input) {
        const incomingId = sanitizeCustomerId(input.id, input.phone);
        const incomingSourceId = parseCustomerSourceId(incomingId, input.sourceId);
        const incomingName = String(input.name || '').trim();
        const incomingCompany = String(input.company || '').trim();
        const hasIncomingContactName =
            input && (
                Object.prototype.hasOwnProperty.call(input, 'contactName') ||
                Object.prototype.hasOwnProperty.call(input, 'contact_name')
            );
        const incomingContactName = String(input.contactName ?? input.contact_name ?? '').trim();
        const incomingPhone = normalizePhone(String(input.phone || ''));
        const incomingEmail = String(input.email || '').trim().toLowerCase();
        const incomingOwnerId = String(input.ownerId || '').trim();
        const hasIncomingType =
            Object.prototype.hasOwnProperty.call(input || {}, 'type') &&
            input?.type !== undefined &&
            input?.type !== null &&
            String(input?.type || '').trim() !== '';
        const incomingType = hasIncomingType ? normalizeCustomerType(input.type) : '';
        const incomingContacts = parseContactsArray(input.contacts);
        const incomingAllowAuto = normalizeBoolean(input.allowAutoResponses, true);
        const incomingDocumentsFolder = String(input.documentsFolder || '').trim();
        const rawIncomingNif = String(input.nif || '').trim();
        const incomingNif = normalizeCustomerNif(rawIncomingNif);
        const incomingNiss = String(input.niss || '').trim();
        const incomingSenhaFinancas = decryptCustomerSecret(String(input.senhaFinancas || '').trim());
        const incomingSenhaSegSocial = decryptCustomerSecret(String(input.senhaSegurancaSocial || '').trim());
        const incomingTipoIva = String(input.tipoIva || '').trim();
        const incomingMorada = String(input.morada || '').trim();
        const incomingManagers = parseManagersArray(input.managers);
        const incomingAccessCredentials = parseAccessCredentialsArray(input.accessCredentials);
        const hasIncomingAgregadoFamiliar =
            input && (
                Object.prototype.hasOwnProperty.call(input, 'agregadoFamiliar') ||
                Object.prototype.hasOwnProperty.call(input, 'agregado_familiar') ||
                Object.prototype.hasOwnProperty.call(input, 'agregado_familiar_json')
            );
        const hasIncomingFichasRelacionadas =
            input && (
                Object.prototype.hasOwnProperty.call(input, 'fichasRelacionadas') ||
                Object.prototype.hasOwnProperty.call(input, 'fichas_relacionadas') ||
                Object.prototype.hasOwnProperty.call(input, 'fichas_relacionadas_json')
            );
        const incomingAgregadoFamiliar = parseAgregadoFamiliarArray(
            input.agregadoFamiliar ?? input.agregado_familiar ?? input.agregado_familiar_json
        );
        const incomingFichasRelacionadas = parseFichasRelacionadasArray(
            input.fichasRelacionadas ?? input.fichas_relacionadas ?? input.fichas_relacionadas_json
        );
        const incomingSupabaseUpdatedAt = String(input.supabaseUpdatedAt || '').trim();
        const allowNifOverwrite = normalizeBoolean(input.allowNifOverwrite, false);
        let incomingSupabasePayloadJson = '';
        if (input.supabasePayload !== undefined) {
            try {
                incomingSupabasePayloadJson = JSON.stringify(input.supabasePayload || {});
            } catch (error) {
                incomingSupabasePayloadJson = '';
            }
        }

        const existingById = incomingId
            ? await dbGetAsync('SELECT * FROM customers WHERE id = ? LIMIT 1', [incomingId])
            : null;
        const existingBySource =
            !existingById && incomingSourceId
                ? await dbGetAsync('SELECT * FROM customers WHERE source_id = ? LIMIT 1', [incomingSourceId])
                : null;
        const allowWeakIdentityMatch = !incomingSourceId && !incomingNif;
        const existingByEmail =
            allowWeakIdentityMatch && !existingById && !existingBySource && incomingEmail
                ? await dbGetAsync('SELECT * FROM customers WHERE lower(email) = lower(?) LIMIT 1', [incomingEmail])
                : null;
        const existingByPhone =
            allowWeakIdentityMatch && !existingById && !existingBySource && !existingByEmail && incomingPhone
                ? await dbGetAsync('SELECT * FROM customers WHERE phone = ? LIMIT 1', [incomingPhone])
                : null;

        const existing = existingById || existingBySource || existingByEmail || existingByPhone;

        const finalId = existing?.id || incomingId;
        const finalSourceId = incomingSourceId || String(existing?.source_id || '').trim();
        const finalName = incomingName || String(existing?.name || '').trim();
        const finalCompany = incomingCompany || String(existing?.company || '').trim() || finalName;
        const finalContactName = hasIncomingContactName
            ? incomingContactName
            : String(existing?.contact_name || '').trim();
        const finalPhone = incomingPhone || normalizePhone(String(existing?.phone || ''));
        const finalEmail = incomingEmail || String(existing?.email || '').trim().toLowerCase();
        const finalOwnerId = incomingOwnerId || String(existing?.owner_id || '').trim();
        const finalType = hasIncomingType
            ? (incomingType || normalizeCustomerType(existing?.type))
            : normalizeCustomerType(existing?.type);
        const finalContacts = incomingContacts.length > 0 ? incomingContacts : parseContactsArray(existing?.contacts_json);
        const finalAllowAutoBase =
            input.allowAutoResponses !== undefined
                ? normalizeBoolean(input.allowAutoResponses, true)
                : normalizeBoolean(existing?.allow_auto_responses, true);
        const finalAllowAuto = finalPhone ? finalAllowAutoBase : false;
        const finalDocumentsFolder =
            input.documentsFolder !== undefined
                ? incomingDocumentsFolder
                : String(existing?.documents_folder || '').trim();
        const finalNif = input.nif !== undefined
            ? incomingNif
            : (normalizeCustomerNif(String(existing?.nif || '').trim()) || String(existing?.nif || '').trim());
        const finalNiss = input.niss !== undefined ? incomingNiss : String(existing?.niss || '').trim();
        const finalSenhaFinancas =
            input.senhaFinancas !== undefined
                ? incomingSenhaFinancas
                : decryptCustomerSecret(String(existing?.senha_financas || '').trim());
        const finalSenhaSegSocial =
            input.senhaSegurancaSocial !== undefined
                ? incomingSenhaSegSocial
                : decryptCustomerSecret(String(existing?.senha_seg_social || '').trim());
        const finalTipoIva =
            input.tipoIva !== undefined
                ? incomingTipoIva
                : String(existing?.tipo_iva || '').trim();
        const finalMorada =
            input.morada !== undefined
                ? incomingMorada
                : String(existing?.morada || '').trim();
        const finalCustomerProfile = buildCustomerProfileFromInput(input, existing?.customer_profile_json);
        const finalCustomerProfileJson = serializeCustomerProfile(finalCustomerProfile);
        const finalManagers =
            input.managers !== undefined
                ? incomingManagers
                : parseManagersArray(existing?.managers_json);
        const finalAccessCredentialsBase =
            input.accessCredentials !== undefined
                ? incomingAccessCredentials
                : parseAccessCredentialsArray(existing?.access_credentials_json);
        const finalAccessCredentials = applyDefaultAccessCredentialUsernames(finalAccessCredentialsBase, finalNif);
        const finalAgregadoFamiliar =
            hasIncomingAgregadoFamiliar
                ? incomingAgregadoFamiliar
                : parseAgregadoFamiliarArray(existing?.agregado_familiar_json);
        const finalFichasRelacionadas =
            hasIncomingFichasRelacionadas
                ? incomingFichasRelacionadas
                : parseFichasRelacionadasArray(existing?.fichas_relacionadas_json);
        const finalAgregadoFamiliarJson = finalAgregadoFamiliar.length > 0 ? JSON.stringify(finalAgregadoFamiliar) : null;
        const finalFichasRelacionadasJson = finalFichasRelacionadas.length > 0 ? JSON.stringify(finalFichasRelacionadas) : null;
        const finalSupabasePayloadJson =
            input.supabasePayload !== undefined
                ? incomingSupabasePayloadJson
                : String(existing?.supabase_payload_json || '').trim();
        const finalSupabaseUpdatedAt =
            input.supabaseUpdatedAt !== undefined
                ? incomingSupabaseUpdatedAt
                : String(existing?.supabase_updated_at || '').trim();
        const storedSenhaFinancas = finalSenhaFinancas ? encryptCustomerSecret(finalSenhaFinancas) : null;
        const storedSenhaSegSocial = finalSenhaSegSocial ? encryptCustomerSecret(finalSenhaSegSocial) : null;
        const storedAccessCredentialsJson = serializeAccessCredentialsForStorage(finalAccessCredentials || []);

        if (input.nif !== undefined) {
            const existingNifNormalized = normalizeCustomerNif(existing?.nif || '');
            const incomingNifNormalized = normalizeCustomerNif(incomingNif || '');
            if (incomingNifNormalized && incomingNifNormalized !== existingNifNormalized && !isValidPortugueseNif(incomingNifNormalized)) {
                throw new Error('NIF inválido. Introduza um NIF português válido com 9 dígitos.');
            }
            if (existingNifNormalized && incomingNifNormalized && existingNifNormalized !== incomingNifNormalized) {
                throw new Error('NIF é imutável neste sistema. Alteração bloqueada.');
            }
            if (!allowNifOverwrite && existingNifNormalized && !incomingNifNormalized) {
                throw new Error('NIF é obrigatório e não pode ser removido.');
            }
        }

        if (finalNif) {
            const nifNormalizedExpr = `
                replace(
                    replace(
                        replace(
                            replace(
                                replace(lower(ifnull(nif, '')), 'pt', ''),
                            ' ', ''),
                        '-', ''),
                    '.', ''),
                '/', '')
            `;
            const conflictRow = await dbGetAsync(
                `SELECT id, source_id, nif, name, company
                 FROM customers
                 WHERE id <> ?
                   AND ${nifNormalizedExpr} <> ''
                   AND (${nifNormalizedExpr} = ? OR substr(${nifNormalizedExpr}, -9) = ?)
                 LIMIT 1`,
                [finalId, finalNif, finalNif]
            );
            if (conflictRow) {
                throw new Error(
                    `NIF duplicado detetado (${finalNif}) entre clientes "${finalName}" e "${conflictRow.company || conflictRow.name || conflictRow.id}".`
                );
            }
        }

        if (!finalName) {
            throw new Error('Nome do cliente é obrigatório.');
        }

        await dbRunAsync(
            `INSERT INTO customers (
                id, source_id, name, company, contact_name, phone, email, owner_id, type, contacts_json, allow_auto_responses, documents_folder, nif, niss, senha_financas, senha_seg_social, tipo_iva, morada, customer_profile_json, managers_json, access_credentials_json, agregado_familiar_json, fichas_relacionadas_json, supabase_payload_json, supabase_updated_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
               source_id = excluded.source_id,
               name = excluded.name,
               company = excluded.company,
               contact_name = excluded.contact_name,
               phone = excluded.phone,
               email = excluded.email,
               owner_id = excluded.owner_id,
               type = excluded.type,
               contacts_json = excluded.contacts_json,
               allow_auto_responses = excluded.allow_auto_responses,
               documents_folder = excluded.documents_folder,
               nif = excluded.nif,
               niss = excluded.niss,
               senha_financas = excluded.senha_financas,
               senha_seg_social = excluded.senha_seg_social,
               tipo_iva = excluded.tipo_iva,
               morada = excluded.morada,
               customer_profile_json = excluded.customer_profile_json,
               managers_json = excluded.managers_json,
               access_credentials_json = excluded.access_credentials_json,
               agregado_familiar_json = excluded.agregado_familiar_json,
               fichas_relacionadas_json = excluded.fichas_relacionadas_json,
               supabase_payload_json = excluded.supabase_payload_json,
               supabase_updated_at = excluded.supabase_updated_at,
               updated_at = CURRENT_TIMESTAMP`,
            [
                finalId,
                finalSourceId || null,
                finalName,
                finalCompany,
                finalContactName || null,
                finalPhone || '',
                finalEmail || null,
                finalOwnerId || null,
                finalType,
                JSON.stringify(finalContacts),
                finalAllowAuto ? 1 : 0,
                finalDocumentsFolder || null,
                finalNif || null,
                finalNiss || null,
                storedSenhaFinancas,
                storedSenhaSegSocial,
                finalTipoIva || null,
                finalMorada || null,
                finalCustomerProfileJson,
                JSON.stringify(finalManagers || []),
                storedAccessCredentialsJson,
                finalAgregadoFamiliarJson,
                finalFichasRelacionadasJson,
                finalSupabasePayloadJson || null,
                finalSupabaseUpdatedAt || null,
            ]
        );

        const savedRow = await dbGetAsync('SELECT * FROM customers WHERE id = ? LIMIT 1', [finalId]);
        return normalizeLocalSqlCustomer(savedRow);
    }

    async function getLocalCustomerById(customerId) {
        const normalizedId = String(customerId || '').trim();
        if (!normalizedId) return null;

        let row = await dbGetAsync(
            `SELECT id, source_id, name, company, contact_name, phone, email, owner_id, type, contacts_json, allow_auto_responses, documents_folder, nif, niss, senha_financas, senha_seg_social, tipo_iva, morada, customer_profile_json, managers_json, access_credentials_json, agregado_familiar_json, fichas_relacionadas_json, supabase_payload_json, supabase_updated_at
             FROM customers
             WHERE id = ?
             LIMIT 1`,
            [normalizedId]
        );

        if (!row) {
            const sourceCandidates = Array.from(
                new Set([parseCustomerSourceId(normalizedId, ''), normalizedId].map((item) => String(item || '').trim()).filter(Boolean))
            );
            for (const sourceId of sourceCandidates) {
                row = await dbGetAsync(
                    `SELECT id, source_id, name, company, contact_name, phone, email, owner_id, type, contacts_json, allow_auto_responses, documents_folder, nif, niss, senha_financas, senha_seg_social, tipo_iva, morada, customer_profile_json, managers_json, access_credentials_json, agregado_familiar_json, fichas_relacionadas_json, supabase_payload_json, supabase_updated_at
                     FROM customers
                     WHERE source_id = ?
                     LIMIT 1`,
                    [sourceId]
                );
                if (row) break;
            }
        }

        return normalizeLocalSqlCustomer(row);
    }

    return {
        sanitizeCustomerId,
        parseCustomerSourceId,
        normalizeCustomerNif,
        isValidPortugueseNif,
        parseContactsArray,
        normalizeLocalSqlCustomer,
        getAllLocalCustomers,
        upsertLocalCustomer,
        getLocalCustomerById,
    };
}

module.exports = {
    createCustomerRepository,
};
