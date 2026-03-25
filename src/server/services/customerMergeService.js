function createCustomerMergeService(deps) {
    const {
        parseCustomerSourceId,
        normalizeCustomerNif,
        normalizeBoolean,
    } = deps;

    function mergeCustomersWithLocalOverrides(sourceCustomers, localCustomers) {
        if (!Array.isArray(sourceCustomers) || sourceCustomers.length === 0) {
            return Array.isArray(localCustomers) ? [...localCustomers] : [];
        }
        if (!Array.isArray(localCustomers) || localCustomers.length === 0) {
            return [...sourceCustomers];
        }

        const localById = new Map();
        const localBySourceId = new Map();

        localCustomers.forEach((localCustomer) => {
            const localId = String(localCustomer?.id || '').trim();
            const localSourceId = parseCustomerSourceId(localId, localCustomer?.sourceId);
            if (localId) localById.set(localId, localCustomer);
            if (localSourceId) localBySourceId.set(localSourceId, localCustomer);
        });

        const merged = sourceCustomers.map((sourceCustomer) => {
            const sourceId = parseCustomerSourceId(sourceCustomer?.id, sourceCustomer?.sourceId);
            const localMatch = localById.get(sourceCustomer.id) || (sourceId ? localBySourceId.get(sourceId) : null);
            if (!localMatch) {
                return sourceCustomer;
            }

            const mergedCustomer = {
                ...sourceCustomer,
                id: sourceCustomer.id,
                sourceId,
            };

            const applyLocalFallback = (fieldName) => {
                const sourceValue = mergedCustomer[fieldName];
                const localValue = localMatch[fieldName];
                const sourceMissing =
                    sourceValue === undefined ||
                    sourceValue === null ||
                    (typeof sourceValue === 'string' && sourceValue.trim() === '');
                const localPresent =
                    localValue !== undefined &&
                    localValue !== null &&
                    (typeof localValue !== 'string' || localValue.trim() !== '');
                if (sourceMissing && localPresent) {
                    mergedCustomer[fieldName] = localValue;
                }
            };

            [
                'contactName',
                'nif',
                'niss',
                'type',
                'senhaFinancas',
                'senhaSegurancaSocial',
                'tipoIva',
                'morada',
                'certidaoPermanenteNumero',
                'certidaoPermanenteValidade',
                'rcbeNumero',
                'rcbeData',
                'dataConstituicao',
                'inicioAtividade',
                'caePrincipal',
                'codigoReparticaoFinancas',
                'tipoContabilidade',
                'estadoCliente',
                'contabilistaCertificado',
                'notes',
            ].forEach(applyLocalFallback);

            if (localMatch.type) {
                mergedCustomer.type = localMatch.type;
            }

            if (!mergedCustomer.documentsFolder && localMatch.documentsFolder) {
                mergedCustomer.documentsFolder = localMatch.documentsFolder;
            }
            if ((!Array.isArray(mergedCustomer.contacts) || mergedCustomer.contacts.length === 0) && Array.isArray(localMatch.contacts) && localMatch.contacts.length > 0) {
                mergedCustomer.contacts = localMatch.contacts;
            }
            if (localMatch.allowAutoResponses !== undefined) {
                mergedCustomer.allowAutoResponses = normalizeBoolean(localMatch.allowAutoResponses, true);
            }
            if ((!Array.isArray(mergedCustomer.managers) || mergedCustomer.managers.length === 0) && Array.isArray(localMatch.managers) && localMatch.managers.length > 0) {
                mergedCustomer.managers = localMatch.managers;
            }
            if ((!Array.isArray(mergedCustomer.accessCredentials) || mergedCustomer.accessCredentials.length === 0) && Array.isArray(localMatch.accessCredentials) && localMatch.accessCredentials.length > 0) {
                mergedCustomer.accessCredentials = localMatch.accessCredentials;
            }
            if ((!Array.isArray(mergedCustomer.agregadoFamiliar) || mergedCustomer.agregadoFamiliar.length === 0) && Array.isArray(localMatch.agregadoFamiliar) && localMatch.agregadoFamiliar.length > 0) {
                mergedCustomer.agregadoFamiliar = localMatch.agregadoFamiliar;
            }
            if ((!Array.isArray(mergedCustomer.fichasRelacionadas) || mergedCustomer.fichasRelacionadas.length === 0) && Array.isArray(localMatch.fichasRelacionadas) && localMatch.fichasRelacionadas.length > 0) {
                mergedCustomer.fichasRelacionadas = localMatch.fichasRelacionadas;
            }
            if (!mergedCustomer.supabasePayload && sourceCustomer.supabasePayload) {
                mergedCustomer.supabasePayload = sourceCustomer.supabasePayload;
            }
            if (!mergedCustomer.supabaseUpdatedAt && sourceCustomer.supabaseUpdatedAt) {
                mergedCustomer.supabaseUpdatedAt = sourceCustomer.supabaseUpdatedAt;
            }
            return mergedCustomer;
        });

        localCustomers.forEach((localCustomer) => {
            const localId = String(localCustomer?.id || '').trim();
            const localSourceId = parseCustomerSourceId(localId, localCustomer?.sourceId);
            const exists = merged.some((customer) => {
                const customerId = String(customer?.id || '').trim();
                if (localId && customerId === localId) return true;
                const customerSourceId = parseCustomerSourceId(customerId, customer?.sourceId);
                return !!(localSourceId && customerSourceId && localSourceId === customerSourceId);
            });
            if (!exists) {
                merged.push(localCustomer);
            }
        });

        const deduped = [];
        const byNif = new Map();

        const isFilled = (value) => {
            if (value === undefined || value === null) return false;
            if (typeof value === 'string') return value.trim() !== '';
            if (Array.isArray(value)) return value.length > 0;
            return true;
        };

        const completenessScore = (customer) => {
            if (!customer || typeof customer !== 'object') return 0;
            let score = 0;
            if (parseCustomerSourceId(customer?.id, customer?.sourceId)) score += 6;
            if (String(customer?.id || '').startsWith('ext_c_')) score += 2;
            if (isFilled(customer?.phone)) score += 1;
            if (isFilled(customer?.email)) score += 1;
            if (isFilled(customer?.ownerId)) score += 1;
            if (isFilled(customer?.documentsFolder)) score += 1;
            if (isFilled(customer?.niss)) score += 1;
            if (isFilled(customer?.morada)) score += 1;
            if (isFilled(customer?.managers)) score += 1;
            if (isFilled(customer?.accessCredentials)) score += 1;
            if (isFilled(customer?.agregadoFamiliar)) score += 1;
            if (isFilled(customer?.fichasRelacionadas)) score += 1;
            return score;
        };

        const mergeMissingFields = (primary, secondary) => {
            const mergedCustomer = { ...primary };
            Object.entries(secondary || {}).forEach(([key, value]) => {
                if (!isFilled(mergedCustomer[key]) && isFilled(value)) {
                    mergedCustomer[key] = value;
                }
            });
            return mergedCustomer;
        };

        merged.forEach((customer) => {
            const nifKey = normalizeCustomerNif(customer?.nif || '');
            if (!nifKey) {
                deduped.push(customer);
                return;
            }

            const existingIndex = byNif.get(nifKey);
            if (existingIndex === undefined) {
                byNif.set(nifKey, deduped.length);
                deduped.push(customer);
                return;
            }

            const current = deduped[existingIndex];
            const keepCurrent = completenessScore(current) >= completenessScore(customer);
            const preferred = keepCurrent ? current : customer;
            const fallback = keepCurrent ? customer : current;
            deduped[existingIndex] = mergeMissingFields(preferred, fallback);
        });

        return deduped;
    }

    return {
        mergeCustomersWithLocalOverrides,
    };
}

module.exports = {
    createCustomerMergeService,
};
