function createMappers(deps) {
    const {
        normalizePhone,
        normalizeDigits,
        pickFirstValue,
        decryptCustomerSecret,
        encryptCustomerSecret,
    } = deps;
    // normalizeCustomerNif and parseCustomerSourceId are accessed lazily
    // via deps.normalizeCustomerNif / deps.parseCustomerSourceId to break
    // the circular dependency with customerRepository.

    const HOUSEHOLD_RELATION_TYPES = new Set(['conjuge', 'filho', 'pai', 'outro']);
    const RELATED_RECORD_RELATION_TYPES = new Set(['funcionario', 'amigo', 'familiar', 'gerente', 'socio', 'outro']);

    function foldText(value) {
        return String(value || '')
            .trim()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
    }

    function normalizeRelationType(value, allowedTypes) {
        const folded = foldText(value);
        if (!folded) return allowedTypes.has('outro') ? 'outro' : '';
        if (allowedTypes.has(folded)) return folded;

        if (allowedTypes === HOUSEHOLD_RELATION_TYPES) {
            if (
                folded.startsWith('espos') ||
                folded.startsWith('marid') ||
                folded.includes('conjuge') ||
                folded.includes('wife') ||
                folded.includes('husband')
            ) {
                return 'conjuge';
            }
            if (folded.startsWith('filh')) return 'filho';
            if (folded === 'pai' || folded === 'mae' || folded.startsWith('progenitor') || folded.startsWith('parent')) return 'pai';
            return 'outro';
        }

        if (allowedTypes === RELATED_RECORD_RELATION_TYPES) {
            if (folded.startsWith('funcion')) return 'funcionario';
            if (folded.startsWith('amig')) return 'amigo';
            if (folded.startsWith('famil')) return 'familiar';
            if (folded.startsWith('gerent') || folded.startsWith('admin')) return 'gerente';
            if (folded.startsWith('soci')) return 'socio';
            return 'outro';
        }

        return '';
    }

    function parseManagersArray(rawValue) {
        if (Array.isArray(rawValue)) {
            return rawValue
                .map((item) => ({
                    name: String(item?.name || '').trim(),
                    email: String(item?.email || '').trim().toLowerCase(),
                    phone: normalizePhone(String(item?.phone || '')),
                }))
                .filter((item) => item.name || item.email || item.phone);
        }

        if (typeof rawValue === 'string' && rawValue.trim()) {
            try {
                return parseManagersArray(JSON.parse(rawValue));
            } catch (error) {
                return [];
            }
        }

        return [];
    }

    function parseAccessCredentialsArray(rawValue) {
        if (Array.isArray(rawValue)) {
            return rawValue
                .map((item) => ({
                    service: String(item?.service || '').trim(),
                    username: String(item?.username || '').trim(),
                    password: decryptCustomerSecret(String(item?.password || '').trim()),
                }))
                .filter((item) => item.service || item.username || item.password);
        }

        if (typeof rawValue === 'string' && rawValue.trim()) {
            try {
                return parseAccessCredentialsArray(JSON.parse(rawValue));
            } catch (error) {
                return [];
            }
        }

        return [];
    }

    function serializeAccessCredentialsForStorage(rawCredentials) {
        const credentials = parseAccessCredentialsArray(rawCredentials);
        const normalized = credentials
            .map((item) => ({
                service: String(item?.service || '').trim(),
                username: String(item?.username || '').trim(),
                password: encryptCustomerSecret(String(item?.password || '').trim()),
            }))
            .filter((item) => item.service || item.username || item.password);
        return JSON.stringify(normalized);
    }

    function applyDefaultAccessCredentialUsernames(rawCredentials, fallbackNif = '') {
        const credentials = parseAccessCredentialsArray(rawCredentials);
        const normalizedNif = deps.normalizeCustomerNif(fallbackNif);
        if (!normalizedNif || credentials.length === 0) return credentials;

        return credentials.map((item) => {
            const service = String(item?.service || '').trim();
            const username = String(item?.username || '').trim();
            if (service.toUpperCase() !== 'AT' || username) {
                return { ...item };
            }
            return {
                ...item,
                username: normalizedNif,
            };
        });
    }

    function parseCustomerRelationLinksArray(rawValue, allowedTypes) {
        if (Array.isArray(rawValue)) {
            const seen = new Set();
            const normalized = [];

            rawValue.forEach((item) => {
                const pickText = (...values) => {
                    for (const value of values) {
                        if (value === undefined || value === null) continue;
                        const text = String(value).trim();
                        if (!text) continue;
                        const folded = foldText(text);
                        if (folded === 'undefined' || folded === 'null' || folded === 'nan') continue;
                        return text;
                    }
                    return '';
                };

                const relationType = normalizeRelationType(
                    pickText(
                        item?.relationType,
                        item?.relation,
                        item?.tipo,
                        item?.type,
                        item?.tipo_relacao,
                        item?.tipoRelacao,
                        item?.relation_type
                    ),
                    allowedTypes
                );
                if (!relationType) return;

                const customerId = pickText(
                    item?.customerId,
                    item?.linkedCustomerId,
                    item?.relatedCustomerId,
                    item?.fichaId,
                    item?.clienteId,
                    item?.ficha_relacionada_id,
                    item?.fichaRelacionadaId,
                    item?.id_ficha_relacionada,
                    item?.cliente_id,
                    item?.id_cliente
                );
                const explicitSourceId = pickText(
                    item?.customerSourceId,
                    item?.sourceId,
                    item?.linkedCustomerSourceId,
                    item?.relatedCustomerSourceId,
                    item?.fichaSourceId,
                    item?.clienteSourceId,
                    item?.ficha_relacionada_source_id,
                    item?.fichaRelacionadaSourceId,
                    item?.source_id_ficha_relacionada,
                    item?.cliente_source_id,
                    item?.source_id_cliente
                );
                const customerSourceId = explicitSourceId || deps.parseCustomerSourceId(customerId, '');
                const customerName = pickText(
                    item?.customerName,
                    item?.name,
                    item?.nome,
                    item?.ficha_relacionada_nome,
                    item?.fichaRelacionadaNome,
                    item?.nome_ficha_relacionada,
                    item?.cliente_nome,
                    item?.nome_cliente,
                    item?.ficha_relacionada
                );
                const customerCompany = pickText(
                    item?.customerCompany,
                    item?.company,
                    item?.empresa,
                    item?.ficha_relacionada_empresa,
                    item?.fichaRelacionadaEmpresa,
                    item?.empresa_ficha_relacionada,
                    item?.cliente_empresa,
                    item?.empresa_cliente
                );
                const customerNif = normalizeDigits(
                    pickText(
                        item?.customerNif,
                        item?.nif,
                        item?.ficha_relacionada_nif,
                        item?.fichaRelacionadaNif,
                        item?.nif_ficha_relacionada,
                        item?.cliente_nif,
                        item?.nif_cliente
                    )
                ).slice(-9);
                const note = pickText(item?.note, item?.notes, item?.observacao, item?.obs, item?.nota, item?.observacoes);

                const relationKeySeed =
                    customerSourceId ||
                    customerId ||
                    customerNif ||
                    `${customerName.toLowerCase()}::${customerCompany.toLowerCase()}`;
                if (!relationKeySeed) return;

                const dedupeKey = `${relationType}::${relationKeySeed}`;
                if (seen.has(dedupeKey)) return;
                seen.add(dedupeKey);

                normalized.push({
                    customerId: customerId || undefined,
                    customerSourceId: customerSourceId || undefined,
                    relationType,
                    note: note || undefined,
                    customerName: customerName || undefined,
                    customerCompany: customerCompany || undefined,
                    customerNif: customerNif || undefined,
                });
            });

            return normalized;
        }

        if (typeof rawValue === 'string' && rawValue.trim()) {
            try {
                return parseCustomerRelationLinksArray(JSON.parse(rawValue), allowedTypes);
            } catch (error) {
                return [];
            }
        }

        return [];
    }

    function parseAgregadoFamiliarArray(rawValue) {
        return parseCustomerRelationLinksArray(rawValue, HOUSEHOLD_RELATION_TYPES);
    }

    function parseFichasRelacionadasArray(rawValue) {
        return parseCustomerRelationLinksArray(rawValue, RELATED_RECORD_RELATION_TYPES);
    }

    function extractManagersFromRawRow(rawRow) {
        if (!rawRow || typeof rawRow !== 'object') return [];

        const parsed = parseManagersArray(
            pickFirstValue(rawRow, [
                'managers_json',
                'gerentes_json',
                'gerencia_administracao_json',
                'gerencia_admin_json',
                'administracao_json',
            ])
        );

        if (parsed.length > 0) return parsed;

        const managerName = String(pickFirstValue(rawRow, ['gerente', 'manager', 'administrador', 'nome_gerente']) || '').trim();
        const managerEmail = String(pickFirstValue(rawRow, ['email_gerente', 'manager_email']) || '').trim().toLowerCase();
        const managerPhone = normalizePhone(String(pickFirstValue(rawRow, ['telefone_gerente', 'manager_phone']) || ''));

        if (managerName || managerEmail || managerPhone) {
            return [{ name: managerName, email: managerEmail, phone: managerPhone }];
        }

        return [];
    }

    function extractAccessCredentialsFromRawRow(rawRow, fallback = {}) {
        if (!rawRow || typeof rawRow !== 'object') {
            return parseAccessCredentialsArray(fallback?.accessCredentials || []);
        }

        const credentials = parseAccessCredentialsArray(
            pickFirstValue(rawRow, [
                'access_credentials_json',
                'acessos_json',
                'dados_acesso_json',
                'dados_de_acesso_json',
                'credenciais_json',
            ])
        );

        const pushIfAny = (service, usernameRaw, passwordRaw) => {
            const username = String(usernameRaw || '').trim();
            const password = String(passwordRaw || '').trim();
            if (!username && !password) return;
            credentials.push({ service: String(service || '').trim(), username, password });
        };

        pushIfAny(
            'AT',
            pickFirstValue(rawRow, ['utilizador_at', 'username_at', 'user_at']),
            pickFirstValue(rawRow, ['password_at', 'senha_at']) || fallback?.senhaFinancas
        );
        pushIfAny(
            'SS',
            pickFirstValue(rawRow, ['utilizador_ss', 'username_ss', 'user_ss']),
            pickFirstValue(rawRow, ['password_ss', 'senha_ss']) || fallback?.senhaSegurancaSocial
        );
        pushIfAny(
            'RU',
            pickFirstValue(rawRow, ['utilizador_ru', 'username_ru', 'user_ru']),
            pickFirstValue(rawRow, ['password_ru', 'senha_ru'])
        );
        pushIfAny(
            'ViaCTT',
            pickFirstValue(rawRow, ['utilizador_viactt', 'username_viactt', 'user_viactt']),
            pickFirstValue(rawRow, ['password_viactt', 'senha_viactt'])
        );
        pushIfAny(
            'IAPMEI',
            pickFirstValue(rawRow, ['utilizador_iapmei', 'username_iapmei', 'user_iapmei']),
            pickFirstValue(rawRow, ['password_iapmei', 'senha_iapmei'])
        );

        const deduped = [];
        const seen = new Set();
        credentials.forEach((item) => {
            const service = String(item?.service || '').trim();
            const username = String(item?.username || '').trim();
            const password = String(item?.password || '').trim();
            if (!service && !username && !password) return;
            const key = service.toLowerCase() + '::' + username.toLowerCase() + '::' + password;
            if (seen.has(key)) return;
            seen.add(key);
            deduped.push({ service, username, password });
        });

        const fallbackNif = deps.normalizeCustomerNif(
            fallback?.nif ||
                pickFirstValue(rawRow, ['nif', 'vat', 'tax_id', 'numero_contribuinte', 'contribuinte']) ||
                ''
        );
        return applyDefaultAccessCredentialUsernames(deduped, fallbackNif);
    }

    function parseCustomerProfile(rawValue) {
        const base = {
            certidaoPermanenteNumero: '',
            certidaoPermanenteValidade: '',
            rcbeNumero: '',
            rcbeData: '',
            dataConstituicao: '',
            inicioAtividade: '',
            caePrincipal: '',
            codigoReparticaoFinancas: '',
            tipoContabilidade: '',
            estadoCliente: '',
            contabilistaCertificado: '',
            notes: '',
        };

        const parsed = parseJsonObject(rawValue);
        if (!parsed) return base;

        Object.keys(base).forEach((key) => {
            base[key] = String(parsed[key] || '').trim();
        });

        return base;
    }

    function buildCustomerProfileFromInput(input, existingRawValue) {
        const existing = parseCustomerProfile(existingRawValue);
        const nested = parseCustomerProfile(input?.customerProfile || null);

        const pick = (fieldName, aliases = []) => {
            if (input && Object.prototype.hasOwnProperty.call(input, fieldName)) {
                if (input[fieldName] !== undefined) {
                    return String(input[fieldName] || '').trim();
                }
            }
            for (const alias of aliases) {
                if (input && Object.prototype.hasOwnProperty.call(input, alias)) {
                    if (input[alias] !== undefined) {
                        return String(input[alias] || '').trim();
                    }
                }
            }
            return nested[fieldName] || existing[fieldName] || '';
        };

        return {
            certidaoPermanenteNumero: pick('certidaoPermanenteNumero', ['certidao_permanente_numero']),
            certidaoPermanenteValidade: pick('certidaoPermanenteValidade', ['certidao_permanente_validade']),
            rcbeNumero: pick('rcbeNumero', ['rcbe_numero']),
            rcbeData: pick('rcbeData', ['rcbe_data']),
            dataConstituicao: pick('dataConstituicao', ['data_constituicao']),
            inicioAtividade: pick('inicioAtividade', ['inicio_atividade']),
            caePrincipal: pick('caePrincipal', ['cae_principal']),
            codigoReparticaoFinancas: pick('codigoReparticaoFinancas', ['codigo_reparticao_financas']),
            tipoContabilidade: pick('tipoContabilidade', ['tipo_contabilidade']),
            estadoCliente: pick('estadoCliente', ['estado_cliente', 'estado']),
            contabilistaCertificado: pick('contabilistaCertificado', ['contabilista_certificado']),
            notes: pick('notes', ['notas', 'observacoes', 'obs']),
        };
    }

    function serializeCustomerProfile(profile) {
        if (!profile || typeof profile !== 'object') return null;
        const cleaned = {};
        Object.entries(profile).forEach(([key, value]) => {
            const text = String(value || '').trim();
            if (text) cleaned[key] = text;
        });
        return Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned) : null;
    }

    function parseJsonObject(rawValue) {
        if (rawValue === undefined || rawValue === null || rawValue === '') return null;
        if (typeof rawValue === 'object' && !Array.isArray(rawValue)) return rawValue;
        try {
            const parsed = JSON.parse(String(rawValue || '').trim());
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (error) {
            return null;
        }
    }

    function parseJsonArray(rawValue) {
        if (rawValue === undefined || rawValue === null || rawValue === '') return [];
        if (Array.isArray(rawValue)) return rawValue;
        try {
            const parsed = JSON.parse(String(rawValue || '').trim());
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    return {
        HOUSEHOLD_RELATION_TYPES,
        RELATED_RECORD_RELATION_TYPES,
        foldText,
        normalizeRelationType,
        parseManagersArray,
        parseAccessCredentialsArray,
        serializeAccessCredentialsForStorage,
        applyDefaultAccessCredentialUsernames,
        parseCustomerRelationLinksArray,
        parseAgregadoFamiliarArray,
        parseFichasRelacionadasArray,
        extractManagersFromRawRow,
        extractAccessCredentialsFromRawRow,
        parseCustomerProfile,
        buildCustomerProfileFromInput,
        serializeCustomerProfile,
        parseJsonObject,
        parseJsonArray,
    };
}

module.exports = { createMappers };
