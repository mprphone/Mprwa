const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_OCCURRENCE_TYPES = [
    { id: 1, name: 'Reunião' },
    { id: 2, name: 'Multa' },
    { id: 3, name: 'Projeto' },
    { id: 4, name: 'Medidas de apoio' },
    { id: 5, name: 'Fiscalização' },
    { id: 6, name: 'Rescisão' },
    { id: 7, name: 'Faltas contabilísticas' },
    { id: 8, name: 'Outros Assuntos' },
];


const IAPMEI_DOSSIE_ITEMS = [
    { key: '1_1_comunicacao_convite', principal: '1.Candidatura', nivel2: '1.1 Candidatura' },
    { key: '1_1_formulario_candidatura', principal: '1.Candidatura', nivel2: '1.1 Candidatura' },
    { key: '1_1_comprovativo_envio', principal: '1.Candidatura', nivel2: '1.1 Candidatura' },
    { key: '1_2_comprovativos_elegibilidade', principal: '1.Candidatura', nivel2: '1.2 Comprovativos dos Critérios de Elegibilidade' },
    { key: '1_3_correspondencia', principal: '1.Candidatura', nivel2: '1.3 Correspondência Trocada' },
    { key: '2_1_condicionantes_pre_contratuais', principal: '2.Decisão', nivel2: '2.1 Comprovativos das Condicionantes Pré Contratuais' },
    { key: '2_2_termo_aceitacao', principal: '2.Decisão', nivel2: '2.2 Termo de Aceitação' },
    { key: '2_3_pedidos_ate_termo', principal: '2.Decisão', nivel2: '2.3 Pedidos de Alteração (até ao Termo de Aceitação)' },
    { key: '2_4_correspondencia_decisao', principal: '2.Decisão', nivel2: '2.4 Correspondência Trocada' },
    { key: '3_1_adenda_termo', principal: '3.Pedidos de Alteração', nivel2: '3.1 Adenda ao Termo de Aceitação' },
    { key: '3_2_pedidos_pos_termo', principal: '3.Pedidos de Alteração', nivel2: '3.2 Pedidos de Alteração (após o Termo de Aceitação)' },
    { key: '4_1_acompanhamento_visita', principal: '4.Ações de Acompanhamento e Controlo', nivel2: '4.1 Acompanhamento / Visita' },
    { key: '4_2_controlo_auditoria', principal: '4.Ações de Acompanhamento e Controlo', nivel2: '4.2 Controlo / Auditoria' },
    { key: '5_1_relatorios_intercalares', principal: '5.Execução', nivel2: '5.1 Relatórios Intercalar de Progresso (Trimestral)' },
    { key: '5_2_auditorias_intercalares', principal: '5.Execução', nivel2: '5.2 Auditorias técnico científicas intercalares' },
    { key: '5_3_pedidos_pagamento_intercalares', principal: '5.Execução', nivel2: '5.3 Pedidos de Pagamento Intercalares' },
    { key: '5_4_pedido_pagamento_final', principal: '5.Execução', nivel2: '5.4 Pedido de Pagamento Final' },
    { key: '5_5_encerramento_projeto', principal: '5.Execução', nivel2: '5.5 Encerramento projeto' },
    { key: '5_6_avaliacao_metas', principal: '5.Execução', nivel2: '5.6 Avaliação de Metas' },
    { key: '5_7_comprovantes_investimento', principal: '5.Execução', nivel2: '5.7 Comprovantes de Investimento' },
    { key: '5_8_evidencias_divulgacao', principal: '5.Execução', nivel2: '5.8 Evidências da Divulgação de Resultados' },
    { key: '5_9_outros_documentos', principal: '5.Execução', nivel2: '5.9 Outros Documentos' },
    { key: '6_1_publicitacao_apoio', principal: '6.Publicitação de Apoio', nivel2: '6.1 A cumprir pelo Beneficiário (web/cartaz/ecrã eletrónico)' },
    { key: '7_1_contratacao_publica', principal: '7.Contratação Pública', nivel2: '7.1 Procedimentos de Contratação Pública' },
];


const IEFP_DOSSIE_ITEMS = [
    { key: 'iefp_candidatura_eletronica', principal: '1.Candidatura', nivel2: 'Candidatura Eletrónica' },
    { key: 'iefp_identificacao_empresa', principal: '1.Candidatura', nivel2: 'Identificação da Empresa' },
    { key: 'iefp_contrato_trabalho', principal: '2.Execução', nivel2: 'Contrato de Trabalho' },
    { key: 'iefp_inscricao_trabalhador', principal: '2.Execução', nivel2: 'Inscrição do Trabalhador' },
    { key: 'iefp_regularizacao_at_ss', principal: '1.Candidatura', nivel2: 'Situação Regularizada' },
    { key: 'iefp_recuperacao_aplicavel', principal: '1.Candidatura', nivel2: 'Declarações' },
    { key: 'iefp_majoracoes', principal: '1.Candidatura', nivel2: 'Majorações' },
    { key: 'iefp_plano_formacao', principal: '2.Execução', nivel2: 'Plano de Formação' },
];

const IEFP_DOSSIE_MAP = new Map(IEFP_DOSSIE_ITEMS.map((item) => [item.key, item]));

const IAPMEI_DOSSIE_MAP = new Map(IAPMEI_DOSSIE_ITEMS.map((item) => [item.key, item]));

const COMBINED_DOSSIE_MAP = new Map();
for (const item of [...IAPMEI_DOSSIE_ITEMS, ...IEFP_DOSSIE_ITEMS]) {
    if (!COMBINED_DOSSIE_MAP.has(item.key)) {
        COMBINED_DOSSIE_MAP.set(item.key, item);
    }
}

function registerOccurrencesRoutes(context) {
    const {
        app,
        dbRunAsync,
        dbGetAsync,
        dbAllAsync,
        writeAuditLog,
        SUPABASE_URL,
        SUPABASE_KEY,
        SUPABASE_OCORRENCIAS_SOURCE,
        SUPABASE_OCORRENCIAS_FOTOS_SOURCE,
        SUPABASE_OCORRENCIAS_DOCUMENTOS_SOURCE,
        SUPABASE_TIPOS_OCORRENCIA_SOURCE,
        SUPABASE_CLIENTS_SOURCE,
        SUPABASE_FUNCIONARIOS_SOURCE,
        fetchSupabaseTable,
        resolveSupabaseTableName,
        normalizeDigits,
        nowIso,
        resolveCustomerDocumentsFolder,
        sanitizeDocumentFileName,
    } = context;

    function toIsoDate(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
        const d = new Date(raw);
        if (!Number.isFinite(d.getTime())) return '';
        const year = d.getUTCFullYear();
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function parseJsonArray(value) {
        if (Array.isArray(value)) return value;
        const raw = String(value || '').trim();
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    function parseJsonObject(value) {
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        const raw = String(value || '').trim();
        if (!raw) return null;
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (error) {
            return null;
        }
    }

    function normalizeOccurrenceState(rawState, dueDate) {
        const value = String(rawState || '').trim().toUpperCase();
        if (value.includes('RESOLV')) return 'RESOLVIDA';
        if (value.includes('ATRAS')) return 'ATRASADA';
        if (value.includes('ABERT')) return 'ABERTA';

        const normalizedDueDate = toIsoDate(dueDate);
        if (normalizedDueDate) {
            const today = toIsoDate(new Date().toISOString());
            if (today && normalizedDueDate < today) {
                return 'ATRASADA';
            }
        }

        return 'ABERTA';
    }

    async function ensureDefaultOccurrenceTypes() {
        const row = await dbGetAsync('SELECT COUNT(*) as total FROM occurrence_types');
        if (Number(row?.total || 0) > 0) return;

        for (const type of DEFAULT_OCCURRENCE_TYPES) {
            await dbRunAsync(
                `INSERT OR IGNORE INTO occurrence_types (id, name, source_id, updated_at)
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
                [type.id, type.name, String(type.id)]
            );
        }
    }

    async function loadOccurrenceTypes() {
        await ensureDefaultOccurrenceTypes();
        const rows = await dbAllAsync(
            `SELECT id, name, source_id
             FROM occurrence_types
             ORDER BY lower(name) ASC, id ASC`
        );
        return rows.map((row) => ({
            id: Number(row.id || 0),
            name: String(row.name || '').trim(),
            sourceId: String(row.source_id || '').trim() || null,
        }));
    }

    async function loadOccurrenceById(id) {
        const row = await dbGetAsync(
            `SELECT
                o.id,
                o.source_id,
                o.customer_id,
                o.source_customer_id,
                o.customer_nif,
                o.date,
                o.type_id,
                o.type_name,
                o.title,
                o.description,
                o.state,
                o.due_date,
                o.responsible_user_id,
                o.responsible_ids_json,
                o.responsible_names_text,
                o.resolution,
                o.projeto_apoio_detalhe_json,
                o.supabase_payload_json,
                o.sync_origin,
                o.last_synced_at,
                o.created_at,
                o.updated_at,
                c.name AS customer_name,
                c.company AS customer_company,
                c.nif AS customer_nif_local,
                u.name AS responsible_user_name,
                u.email AS responsible_user_email
             FROM occurrences o
             LEFT JOIN customers c ON c.id = o.customer_id
             LEFT JOIN users u ON u.id = o.responsible_user_id
             WHERE o.id = ?
             LIMIT 1`,
            [id]
        );

        if (!row) return null;

        await dbRunAsync('ALTER TABLE occurrence_attachments ADD COLUMN section_key TEXT').catch(() => {});
        await dbRunAsync('ALTER TABLE occurrence_attachments ADD COLUMN dossie_model TEXT').catch(() => {});
        await dbRunAsync('ALTER TABLE occurrence_attachments ADD COLUMN dossie_item_key TEXT').catch(() => {});

        const attachments = await dbAllAsync(
            `SELECT
                id,
                kind,
                source_table,
                file_url,
                storage_path,
                local_file_path,
                original_name,
                section_key,
                dossie_model,
                dossie_item_key,
                created_at
             FROM occurrence_attachments
             WHERE occurrence_id = ?
             ORDER BY datetime(created_at) DESC, id DESC`,
            [id]
        );

        return {
            id: String(row.id || '').trim(),
            sourceId: String(row.source_id || '').trim() || null,
            customerId: String(row.customer_id || '').trim(),
            sourceCustomerId: String(row.source_customer_id || '').trim() || null,
            customerNif: String(row.customer_nif || row.customer_nif_local || '').trim() || null,
            date: toIsoDate(row.date) || toIsoDate(new Date().toISOString()),
            typeId: Number(row.type_id || 0) || null,
            typeName: String(row.type_name || '').trim() || null,
            title: String(row.title || '').trim(),
            description: String(row.description || '').trim() || '',
            state: normalizeOccurrenceState(row.state, row.due_date),
            dueDate: toIsoDate(row.due_date) || null,
            responsibleUserId: String(row.responsible_user_id || '').trim() || null,
            responsibleUserIds: parseJsonArray(row.responsible_ids_json)
                .map((value) => String(value || '').trim())
                .filter(Boolean),
            responsibleNames: String(row.responsible_names_text || '').trim(),
            responsibleUserName: String(row.responsible_user_name || '').trim() || null,
            responsibleUserEmail: String(row.responsible_user_email || '').trim() || null,
            resolution: String(row.resolution || '').trim() || '',
            projetoApoioDetalhe: parseJsonObject(row.projeto_apoio_detalhe_json),
            supabasePayload: parseJsonObject(row.supabase_payload_json),
            syncOrigin: String(row.sync_origin || 'local').trim(),
            lastSyncedAt: String(row.last_synced_at || '').trim() || null,
            createdAt: String(row.created_at || '').trim() || null,
            updatedAt: String(row.updated_at || '').trim() || null,
            customerName: String(row.customer_name || '').trim() || '',
            customerCompany: String(row.customer_company || '').trim() || '',
            attachments: attachments.map((item) => ({
                id: String(item.id || '').trim(),
                kind: String(item.kind || '').trim() || 'foto',
                sourceTable: String(item.source_table || '').trim() || null,
                fileUrl: String(item.file_url || '').trim() || null,
                storagePath: String(item.storage_path || '').trim() || null,
                localFilePath: String(item.local_file_path || '').trim() || null,
                originalName: String(item.original_name || '').trim() || null,
                sectionKey: String(item.section_key || '').trim() || 'geral',
                dossieModel: String(item.dossie_model || '').trim() || null,
                dossieItemKey: String(item.dossie_item_key || '').trim() || null,
                createdAt: String(item.created_at || '').trim() || null,
            })),
        };
    }

    function generateLocalId(prefix) {
        if (typeof crypto.randomUUID === 'function') {
            return `${prefix}_${crypto.randomUUID()}`;
        }
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
    function safeFileName(rawValue, fallback = 'anexo.bin') {
        const raw = String(rawValue || '').trim();
        const candidate = typeof sanitizeDocumentFileName === 'function'
            ? sanitizeDocumentFileName(raw || fallback)
            : path.basename(raw || fallback).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
        const cleaned = String(candidate || '')
            .trim()
            .replace(/^\.+/, '')
            .slice(0, 180);
        return cleaned || fallback;
    }

    function safeFolderName(rawValue, fallback = 'Sem titulo') {
        const raw = String(rawValue || '').trim().replace(/[\\/]+/g, ' ');
        const cleaned = safeFileName(raw || fallback, fallback)
            .slice(0, 120);
        return cleaned || fallback;
    }

    function normalizeAttachmentSectionKey(rawValue) {
        const value = String(rawValue || '').trim().toLowerCase();
        if (!value) return 'geral';
        if (value === 'candidatura') return 'candidatura';
        if (value === 'acompanhamento') return 'acompanhamento';
        if (value === 'encerramento') return 'encerramento';
        if (value === 'dossie_eletronico' || value === 'dossie') return 'dossie_eletronico';
        return 'geral';
    }

    function normalizeDossieModel(rawValue) {
        const value = String(rawValue || '').trim().toUpperCase();
        if (!value) return '';
        if (value === 'IAPMEI' || value === 'IEFP' || value === 'CIM' || value === 'OUTROS') return value;
        return '';
    }

    function normalizeDossieItemKey(rawValue) {
        const value = String(rawValue || '').trim();
        if (!value) return '';
        return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
    }

    function normalizeDossieTemplateModel(rawValue) {
        const value = String(rawValue || '').trim().toUpperCase();
        if (!value) return 'GLOBAL';
        if (value === 'GLOBAL') return 'GLOBAL';
        return normalizeDossieModel(value) || 'GLOBAL';
    }

    function getBuiltInDossieItemsByModel(rawModel) {
        const model = normalizeDossieModel(rawModel) || 'OUTROS';
        if (model === 'IAPMEI') return IAPMEI_DOSSIE_ITEMS;
        return IEFP_DOSSIE_ITEMS;
    }

    function buildCustomDossieItemKey(principal, nivel2, designacao) {
        const base = `${String(principal || '').trim()}_${String(nivel2 || '').trim()}_${String(designacao || '').trim()}`;
        const ascii = base
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .toLowerCase();
        return normalizeDossieItemKey(ascii || `custom_${Date.now()}`);
    }

    async function ensureDossieItemTemplatesTable() {
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS occurrence_dossie_items (
                id TEXT PRIMARY KEY,
                model TEXT NOT NULL DEFAULT 'GLOBAL',
                key TEXT NOT NULL,
                principal TEXT NOT NULL,
                nivel2 TEXT NOT NULL,
                designacao TEXT NOT NULL DEFAULT '',
                is_active INTEGER NOT NULL DEFAULT 1,
                created_by_user_id TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`
        );
        await dbRunAsync(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_occurrence_dossie_items_model_key ON occurrence_dossie_items(model, key)'
        );
    }

    async function ensureDossieItemOrderTable() {
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS occurrence_dossie_item_order (
                id TEXT PRIMARY KEY,
                model TEXT NOT NULL,
                key TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )`
        );
        await dbRunAsync(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_occurrence_dossie_item_order_model_key ON occurrence_dossie_item_order(model, key)'
        );
    }

    async function loadCustomDossieItems(rawModel) {
        await ensureDossieItemTemplatesTable();
        const model = normalizeDossieModel(rawModel) || 'OUTROS';
        const rows = await dbAllAsync(
            `SELECT id, model, key, principal, nivel2, designacao
             FROM occurrence_dossie_items
             WHERE is_active = 1
               AND (model = 'GLOBAL' OR model = ?)
             ORDER BY lower(principal) ASC, lower(nivel2) ASC, lower(designacao) ASC, datetime(created_at) ASC`,
            [model]
        );

        return rows.map((row) => ({
            id: String(row.id || '').trim(),
            model: String(row.model || '').trim().toUpperCase() || 'GLOBAL',
            key: normalizeDossieItemKey(row.key),
            principal: String(row.principal || '').trim(),
            nivel2: String(row.nivel2 || '').trim(),
            designacao: String(row.designacao || '').trim(),
            source: 'custom',
        })).filter((row) => row.key && row.principal && row.nivel2);
    }

    async function loadDossieItemOrder(rawModel) {
        await ensureDossieItemOrderTable();
        const model = normalizeDossieModel(rawModel) || 'OUTROS';
        const rows = await dbAllAsync(
            `SELECT model, key, sort_order
             FROM occurrence_dossie_item_order
             WHERE model IN ('GLOBAL', ?)
             ORDER BY CASE WHEN model = ? THEN 0 ELSE 1 END, sort_order ASC, datetime(updated_at) ASC`,
            [model, model]
        );

        const map = new Map();
        for (const row of rows) {
            const key = normalizeDossieItemKey(row.key);
            if (!key || map.has(key)) continue;
            map.set(key, Number(row.sort_order) || 0);
        }
        return map;
    }

    function resolveDossieMapByModel(model) {
        if (model === 'IAPMEI') return IAPMEI_DOSSIE_MAP;
        if (model === 'IEFP' || model === 'CIM') return IEFP_DOSSIE_MAP;
        return null;
    }

    function resolveDossieFolders(dossieModel, dossieItemKey) {
        const model = normalizeDossieModel(dossieModel) || 'OUTROS';
        const map = resolveDossieMapByModel(model);

        const key = normalizeDossieItemKey(dossieItemKey);
        if (!key) {
            return { model, principal: '', nivel2: '' };
        }

        const item = (map && map.get(key)) || COMBINED_DOSSIE_MAP.get(key);
        if (!item) {
            return { model, principal: '', nivel2: '' };
        }

        return {
            model,
            principal: String(item.principal || '').trim(),
            nivel2: String(item.nivel2 || '').trim(),
        };
    }

    async function resolveDossieFoldersWithCustom(dossieModel, dossieItemKey) {
        const resolved = resolveDossieFolders(dossieModel, dossieItemKey);
        if (resolved.principal && resolved.nivel2) return resolved;

        const key = normalizeDossieItemKey(dossieItemKey);
        if (!key) return resolved;

        await ensureDossieItemTemplatesTable();
        const row = await dbGetAsync(
            `SELECT principal, nivel2
             FROM occurrence_dossie_items
             WHERE is_active = 1
               AND key = ?
               AND (model = 'GLOBAL' OR model = ?)
             ORDER BY CASE WHEN model = 'GLOBAL' THEN 0 ELSE 1 END
             LIMIT 1`,
            [key, normalizeDossieModel(dossieModel) || 'OUTROS']
        );

        if (!row) return resolved;

        return {
            ...resolved,
            principal: String(row.principal || '').trim(),
            nivel2: String(row.nivel2 || '').trim(),
        };
    }

    function normalizeOccurrenceTypeFolderName(rawTypeName) {
        const value = String(rawTypeName || '').trim();
        const normalized = value
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');

        if (normalized.includes('falta')) return 'Faltas contabilisticas';
        if (normalized.includes('fiscal')) return 'Fiscalizacao';
        if (normalized.includes('apoio') || normalized.includes('medid')) return 'Medidas de Apoio';
        if (normalized.includes('rescis')) return 'Rescisao';
        if (normalized.includes('reun')) return 'Reuniao';
        if (normalized.includes('multa')) return 'Multa';
        if (normalized.includes('projeto')) return 'Projeto';
        if (value) return safeFolderName(value, 'Outros Assuntos');
        return 'Outros Assuntos';
    }

    function inferExtensionFromContentType(contentType, fallbackExt = '') {
        const type = String(contentType || '').toLowerCase();
        if (type.includes('pdf')) return '.pdf';
        if (type.includes('png')) return '.png';
        if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
        if (type.includes('gif')) return '.gif';
        if (type.includes('webp')) return '.webp';
        if (type.includes('msword')) return '.doc';
        if (type.includes('wordprocessingml.document')) return '.docx';
        if (type.includes('officedocument.spreadsheetml.sheet')) return '.xlsx';
        if (type.includes('officedocument.presentationml.presentation')) return '.pptx';
        if (type.includes('zip')) return '.zip';
        return fallbackExt || '';
    }

    function inferFileNameFromSources({ fileUrl, storagePath, originalName, fallbackId, contentType }) {
        const explicit = safeFileName(originalName, '');
        if (explicit) return explicit;

        const fromUrlPath = (() => {
            try {
                const parsed = new URL(String(fileUrl || '').trim());
                return safeFileName(path.basename(parsed.pathname || ''), '');
            } catch (error) {
                return '';
            }
        })();
        if (fromUrlPath) return fromUrlPath;

        const fromStoragePath = safeFileName(path.basename(String(storagePath || '').trim()), '');
        if (fromStoragePath) return fromStoragePath;

        const ext = inferExtensionFromContentType(contentType || '', '.bin');
        const idPart = String(fallbackId || Date.now());
        return safeFileName(`anexo_${idPart}${ext}`, `anexo${ext}`);
    }

    function splitStoragePath(rawStoragePath) {
        const trimmed = String(rawStoragePath || '').trim().replace(/^\/+/, '');
        if (!trimmed) return null;
        const parts = trimmed.split('/').filter(Boolean);
        if (parts.length < 2) return null;
        const bucket = parts[0];
        const objectPath = parts.slice(1).join('/');
        return { bucket, objectPath, full: trimmed };
    }

    function buildAttachmentDownloadCandidates({ fileUrl, storagePath }) {
        const candidates = [];
        const seen = new Set();

        function pushCandidate(url, options = {}) {
            const normalizedUrl = String(url || '').trim();
            if (!normalizedUrl) return;
            const key = `${normalizedUrl}|${options.withAuth ? 'auth' : 'anon'}`;
            if (seen.has(key)) return;
            seen.add(key);
            candidates.push({ url: normalizedUrl, ...options });
        }

        const urlRaw = String(fileUrl || '').trim();
        if (urlRaw) {
            pushCandidate(urlRaw, { withAuth: false });
            pushCandidate(urlRaw, { withAuth: true });
        }

        const storageRaw = String(storagePath || '').trim();
        if (storageRaw) {
            if (/^https?:\/\//i.test(storageRaw)) {
                pushCandidate(storageRaw, { withAuth: false });
                pushCandidate(storageRaw, { withAuth: true });
            } else if (SUPABASE_URL) {
                const split = splitStoragePath(storageRaw);
                const fullPath = split?.full || storageRaw.replace(/^\/+/, '');
                const bucket = split?.bucket || '';
                const objectPath = split?.objectPath || fullPath;
                pushCandidate(`${SUPABASE_URL}/storage/v1/object/public/${fullPath}`, {
                    withAuth: false,
                    bucket,
                    objectPath,
                });
                pushCandidate(`${SUPABASE_URL}/storage/v1/object/${fullPath}`, {
                    withAuth: true,
                    bucket,
                    objectPath,
                });

                if (bucket && objectPath) {
                    pushCandidate(`${SUPABASE_URL}/storage/v1/object/public/${bucket}/${objectPath}`, {
                        withAuth: false,
                        bucket,
                        objectPath,
                    });
                    pushCandidate(`${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`, {
                        withAuth: true,
                        bucket,
                        objectPath,
                    });
                }
            }
        }

        return candidates;
    }

    function toWritePermissionMessage(error, targetPath) {
        const code = String(error?.code || '').trim().toUpperCase();
        if (code !== 'EACCES' && code !== 'EPERM') return '';
        return `Sem permissões de escrita na pasta: ${targetPath}. Verifique permissões de partilha/rede e permissões NTFS para o utilizador que executa a aplicação.`;
    }

    async function fetchBinaryFromUrl(url, withAuth) {
        const headers = {};
        if (withAuth && SUPABASE_KEY) {
            headers.apikey = SUPABASE_KEY;
            headers.Authorization = `Bearer ${SUPABASE_KEY}`;
        }

        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return {
            buffer: Buffer.from(arrayBuffer),
            contentType: String(response.headers.get('content-type') || '').trim(),
        };
    }

    async function tryFetchSignedStorageUrl(bucket, objectPath) {
        if (!SUPABASE_URL || !SUPABASE_KEY || !bucket || !objectPath) return '';
        const encodedObject = String(objectPath)
            .split('/')
            .map((segment) => encodeURIComponent(segment))
            .join('/');
        const signUrl = `${SUPABASE_URL}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodedObject}`;

        const response = await fetch(signUrl, {
            method: 'POST',
            headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ expiresIn: 3600 }),
        });

        if (!response.ok) {
            throw new Error(`Assinatura falhou (${response.status})`);
        }

        const payload = await response.json().catch(() => ({}));
        const signed = String(payload?.signedURL || payload?.signedUrl || '').trim();
        if (!signed) {
            throw new Error('Sem URL assinada no retorno.');
        }
        if (/^https?:\/\//i.test(signed)) return signed;
        return `${SUPABASE_URL}/storage/v1${signed}`;
    }

    async function downloadOccurrenceAttachmentBuffer({ fileUrl, storagePath }) {
        const attempts = [];
        const candidates = buildAttachmentDownloadCandidates({ fileUrl, storagePath });

        for (const candidate of candidates) {
            try {
                const payload = await fetchBinaryFromUrl(candidate.url, !!candidate.withAuth);
                return {
                    ...payload,
                    sourceUrl: candidate.url,
                };
            } catch (error) {
                attempts.push(`${candidate.url} -> ${error?.message || error}`);
            }
        }

        const split = splitStoragePath(storagePath);
        if (split?.bucket && split?.objectPath) {
            try {
                const signedUrl = await tryFetchSignedStorageUrl(split.bucket, split.objectPath);
                if (signedUrl) {
                    const payload = await fetchBinaryFromUrl(signedUrl, false);
                    return {
                        ...payload,
                        sourceUrl: signedUrl,
                    };
                }
            } catch (error) {
                attempts.push(`signed://${split.bucket}/${split.objectPath} -> ${error?.message || error}`);
            }
        }

        return {
            buffer: null,
            contentType: '',
            sourceUrl: '',
            error: attempts.slice(-3).join(' | '),
        };
    }

    async function resolveUniqueFilePath(targetPath) {
        const parsed = path.parse(String(targetPath || '').trim());
        const ext = parsed.ext || '';
        const baseNoExt = path.basename(parsed.base, ext);
        const dir = parsed.dir || process.cwd();

        let candidate = path.join(dir, `${baseNoExt}${ext}`);
        let counter = 2;
        while (fs.existsSync(candidate)) {
            candidate = path.join(dir, `${baseNoExt}_${counter}${ext}`);
            counter += 1;
        }
        return candidate;
    }


    
    async function ensureWritableDirectory(dirPath) {
        const resolved = path.resolve(String(dirPath || '').trim());
        if (!resolved) return;
        try {
            const stat = await fs.promises.stat(resolved);
            if (!stat.isDirectory()) return;
            await fs.promises.chmod(resolved, 0o775).catch(() => {});
        } catch (error) {
            // ignore: best-effort only
        }
    }

    async function ensureWritableAncestors(targetDir) {
        const resolved = path.resolve(String(targetDir || '').trim());
        if (!resolved) return;
        const segments = resolved.split(path.sep).filter(Boolean);
        let current = resolved.startsWith(path.sep) ? path.sep : '';

        for (const segment of segments) {
            current = current === path.sep ? path.join(current, segment) : (current ? path.join(current, segment) : segment);
            try {
                const stat = await fs.promises.stat(current);
                if (!stat.isDirectory()) break;
                await fs.promises.chmod(current, 0o775).catch(() => {});
            } catch (error) {
                break;
            }
        }
    }

    app.get('/api/occurrences/meta', async (req, res) => {
        try {
            const [types, users, customers] = await Promise.all([
                loadOccurrenceTypes(),
                dbAllAsync(
                    `SELECT id, name, email
                     FROM users
                     ORDER BY lower(name) ASC`
                ),
                dbAllAsync(
                    `SELECT id, name, company, nif
                     FROM customers
                     ORDER BY lower(company) ASC, lower(name) ASC`
                ),
            ]);

            return res.json({
                success: true,
                data: {
                    types,
                    users: users.map((row) => ({
                        id: String(row.id || '').trim(),
                        name: String(row.name || '').trim(),
                        email: String(row.email || '').trim().toLowerCase(),
                    })),
                    customers: customers.map((row) => ({
                        id: String(row.id || '').trim(),
                        name: String(row.name || '').trim(),
                        company: String(row.company || '').trim(),
                        nif: String(row.nif || '').trim() || null,
                    })),
                },
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Ocorrências] Erro ao carregar meta:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/occurrences/types', async (req, res) => {
        try {
            const data = await loadOccurrenceTypes();
            return res.json({ success: true, data });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Ocorrências] Erro ao listar tipos:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/occurrences/dossie-items', async (req, res) => {
        try {
            const model = normalizeDossieModel(req.query.model) || 'OUTROS';
            const builtIn = getBuiltInDossieItemsByModel(model).map((item) => ({
                id: null,
                key: normalizeDossieItemKey(item.key),
                principal: String(item.principal || '').trim(),
                nivel2: String(item.nivel2 || '').trim(),
                designacao: String(item.designacao || item.nivel2 || '').trim(),
                model,
                source: 'builtin',
            }));

            const customItems = await loadCustomDossieItems(model);
            const merged = new Map();
            for (const item of [...builtIn, ...customItems]) {
                if (!item.key) continue;
                if (!merged.has(item.key)) {
                    merged.set(item.key, item);
                }
            }

            const orderMap = await loadDossieItemOrder(model);
            const mergedWithIndex = Array.from(merged.values()).map((item, index) => ({
                item,
                index,
                rank: orderMap.has(item.key) ? Number(orderMap.get(item.key)) : Number.MAX_SAFE_INTEGER,
            }));
            mergedWithIndex.sort((a, b) => {
                if (a.rank !== b.rank) return a.rank - b.rank;
                return a.index - b.index;
            });

            return res.json({ success: true, data: mergedWithIndex.map((entry) => entry.item) });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Ocorrências] Erro ao listar separadores do dossiê:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/occurrences/dossie-items', async (req, res) => {
        try {
            const actorUserId = String(req.body?.actorUserId || '').trim() || null;
            const model = normalizeDossieTemplateModel(req.body?.model || 'GLOBAL');
            const principal = String(req.body?.principal || '').trim();
            const nivel2 = String(req.body?.nivel2 || '').trim();
            const designacao = String(req.body?.designacao || '').trim() || nivel2;

            if (!principal || !nivel2) {
                return res.status(400).json({ success: false, error: 'Principal e nível 2 são obrigatórios.' });
            }

            await ensureDossieItemTemplatesTable();

            let key = normalizeDossieItemKey(req.body?.key) || buildCustomDossieItemKey(principal, nivel2, designacao);
            if (!key) key = buildCustomDossieItemKey(principal, nivel2, designacao);

            let candidate = key;
            let counter = 2;
            while (true) {
                const existsBuiltIn = COMBINED_DOSSIE_MAP.has(candidate);
                const existsCustom = await dbGetAsync(
                    'SELECT id FROM occurrence_dossie_items WHERE model = ? AND key = ? LIMIT 1',
                    [model, candidate]
                );
                if (!existsBuiltIn && !existsCustom) break;
                candidate = `${key}_${counter}`;
                counter += 1;
            }
            key = candidate;

            const id = generateLocalId('dossie_item');
            await dbRunAsync(
                `INSERT INTO occurrence_dossie_items (
                    id, model, key, principal, nivel2, designacao, is_active, created_by_user_id, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [id, model, key, principal, nivel2, designacao, actorUserId]
            );
            await ensureDossieItemOrderTable();
            const maxRow = await dbGetAsync(
                `SELECT COALESCE(MAX(sort_order), -1) AS max_sort
                 FROM occurrence_dossie_item_order
                 WHERE model = ?`,
                [model]
            );
            const nextSort = Number(maxRow?.max_sort ?? -1) + 1;
            await dbRunAsync(
                `INSERT OR REPLACE INTO occurrence_dossie_item_order (
                    id, model, key, sort_order, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [generateLocalId('dossie_order'), model, key, nextSort]
            );

            return res.json({
                success: true,
                data: {
                    id,
                    model,
                    key,
                    principal,
                    nivel2,
                    designacao,
                    source: 'custom',
                },
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Ocorrências] Erro ao criar separador do dossiê:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.patch('/api/occurrences/dossie-items/order', async (req, res) => {
        try {
            const model = normalizeDossieModel(req.body?.model) || 'OUTROS';
            const rawKeys = Array.isArray(req.body?.orderedKeys) ? req.body.orderedKeys : [];
            const orderedKeys = [];
            const seen = new Set();
            for (const rawKey of rawKeys) {
                const key = normalizeDossieItemKey(rawKey);
                if (!key || seen.has(key)) continue;
                seen.add(key);
                orderedKeys.push(key);
            }

            await ensureDossieItemOrderTable();
            await dbRunAsync('DELETE FROM occurrence_dossie_item_order WHERE model = ?', [model]);

            for (let i = 0; i < orderedKeys.length; i += 1) {
                await dbRunAsync(
                    `INSERT INTO occurrence_dossie_item_order (
                        id, model, key, sort_order, created_at, updated_at
                     ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                    [generateLocalId('dossie_order'), model, orderedKeys[i], i]
                );
            }

            return res.json({ success: true, data: { model, total: orderedKeys.length } });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Ocorrências] Erro ao reordenar separadores do dossiê:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });


    app.get('/api/occurrences', async (req, res) => {
        try {
            const search = String(req.query.q || '').trim();
            const state = String(req.query.state || '').trim();
            const typeId = String(req.query.typeId || '').trim();
            const responsibleUserId = String(req.query.responsibleUserId || '').trim();
            const limitRaw = Number(req.query.limit || 500);
            const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5000, limitRaw)) : 500;

            const where = [];
            const params = [];

            if (search) {
                const like = `%${search.replace(/[%_]/g, '').toLowerCase()}%`;
                where.push(`(
                    lower(ifnull(o.title, '')) LIKE ?
                    OR lower(ifnull(o.description, '')) LIKE ?
                    OR lower(ifnull(c.name, '')) LIKE ?
                    OR lower(ifnull(c.company, '')) LIKE ?
                    OR replace(replace(lower(ifnull(o.customer_nif, '')), ' ', ''), '-', '') LIKE replace(replace(?, ' ', ''), '-', '')
                )`);
                params.push(like, like, like, like, like);
            }

            if (state && !['TODOS', 'ALL'].includes(state.toUpperCase())) {
                where.push('upper(ifnull(o.state, "ABERTA")) = ?');
                params.push(state.toUpperCase());
            }

            if (typeId) {
                if (/^\d+$/.test(typeId)) {
                    where.push('o.type_id = ?');
                    params.push(Number(typeId));
                } else {
                    where.push('lower(ifnull(o.type_name, "")) = lower(?)');
                    params.push(typeId);
                }
            }

            if (responsibleUserId) {
                where.push('(o.responsible_user_id = ? OR ifnull(o.responsible_ids_json, "") LIKE ?)');
                params.push(responsibleUserId, `%${responsibleUserId.replace(/[%_]/g, '')}%`);
            }

            const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

            const rows = await dbAllAsync(
                `SELECT
                    o.id,
                    o.customer_id,
                    o.customer_nif,
                    o.date,
                    o.type_id,
                    o.type_name,
                    o.title,
                    o.description,
                    o.state,
                    o.due_date,
                    o.responsible_user_id,
                    o.responsible_ids_json,
                    o.responsible_names_text,
                    o.resolution,
                    o.sync_origin,
                    o.updated_at,
                    c.name AS customer_name,
                    c.company AS customer_company,
                    c.nif AS customer_nif_local,
                    u.name AS responsible_user_name,
                    (
                        SELECT COUNT(*)
                        FROM occurrence_attachments a
                        WHERE a.occurrence_id = o.id
                    ) AS attachments_count
                 FROM occurrences o
                 LEFT JOIN customers c ON c.id = o.customer_id
                 LEFT JOIN users u ON u.id = o.responsible_user_id
                 ${whereSql}
                 ORDER BY date(o.date) DESC, datetime(o.updated_at) DESC
                 LIMIT ?`,
                [...params, limit]
            );

            return res.json({
                success: true,
                data: rows.map((row) => ({
                    id: String(row.id || '').trim(),
                    customerId: String(row.customer_id || '').trim(),
                    customerName: String(row.customer_name || '').trim() || '',
                    customerCompany: String(row.customer_company || '').trim() || '',
                    customerNif: String(row.customer_nif || row.customer_nif_local || '').trim() || null,
                    date: toIsoDate(row.date) || null,
                    typeId: Number(row.type_id || 0) || null,
                    typeName: String(row.type_name || '').trim() || null,
                    title: String(row.title || '').trim(),
                    description: String(row.description || '').trim() || '',
                    state: normalizeOccurrenceState(row.state, row.due_date),
                    dueDate: toIsoDate(row.due_date) || null,
                    responsibleUserId: String(row.responsible_user_id || '').trim() || null,
                    responsibleUserName: String(row.responsible_user_name || '').trim() || null,
                    responsibleNames: String(row.responsible_names_text || '').trim() || null,
                    responsibleUserIds: parseJsonArray(row.responsible_ids_json)
                        .map((value) => String(value || '').trim())
                        .filter(Boolean),
                    resolution: String(row.resolution || '').trim() || '',
                    syncOrigin: String(row.sync_origin || 'local').trim(),
                    updatedAt: String(row.updated_at || '').trim() || null,
                    attachmentsCount: Number(row.attachments_count || 0),
                })),
            });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Ocorrências] Erro ao listar:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/occurrences/:id', async (req, res) => {
        try {
            const id = String(req.params.id || '').trim();
            if (!id) {
                return res.status(400).json({ success: false, error: 'ID inválido.' });
            }
            const occurrence = await loadOccurrenceById(id);
            if (!occurrence) {
                return res.status(404).json({ success: false, error: 'Ocorrência não encontrada.' });
            }
            return res.json({ success: true, data: occurrence });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Ocorrências] Erro ao carregar detalhe:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.get('/api/occurrences/attachments/:attachmentId/preview', async (req, res) => {
        try {
            const attachmentId = String(req.params.attachmentId || '').trim();
            if (!attachmentId) {
                return res.status(400).json({ success: false, error: 'ID do anexo inválido.' });
            }

            const row = await dbGetAsync(
                `SELECT id, file_url, local_file_path, original_name
                 FROM occurrence_attachments
                 WHERE id = ?
                 LIMIT 1`,
                [attachmentId]
            );

            if (!row) {
                return res.status(404).json({ success: false, error: 'Anexo não encontrado.' });
            }

            const remoteUrl = String(row.file_url || '').trim();
            if (remoteUrl) {
                return res.redirect(remoteUrl);
            }

            const localPathRaw = String(row.local_file_path || '').trim();
            if (!localPathRaw) {
                return res.status(404).json({ success: false, error: 'Anexo sem ficheiro local.' });
            }

            const resolvedPath = path.resolve(localPathRaw);
            if (!fs.existsSync(resolvedPath)) {
                return res.status(404).json({ success: false, error: 'Ficheiro não encontrado no disco.' });
            }

            const ext = path.extname(resolvedPath).toLowerCase();
            const contentTypeByExt = {
                '.pdf': 'application/pdf',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.webp': 'image/webp',
                '.txt': 'text/plain; charset=utf-8',
            };

            const contentType = contentTypeByExt[ext] || 'application/octet-stream';
            const downloadName = safeFileName(row.original_name || path.basename(resolvedPath), path.basename(resolvedPath));
            const safeHeaderName = String(downloadName || 'anexo').replace(/["\r\n]/g, '');

            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Disposition', `inline; filename=\"${safeHeaderName}\"`);

            return res.sendFile(resolvedPath);
        } catch (error) {
            const details = error?.message || error;
            console.error('[Ocorrências] Erro ao pré-visualizar anexo:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.patch('/api/occurrences/attachments/:attachmentId/dossie-link', async (req, res) => {
        try {
            const attachmentId = String(req.params.attachmentId || '').trim();
            const occurrenceIdInput = String(req.body?.occurrenceId || '').trim();
            const actorUserId = String(req.body?.actorUserId || '').trim() || null;
            const dossieModel = normalizeDossieModel(req.body?.dossieModel) || null;
            const dossieItemKey = normalizeDossieItemKey(req.body?.dossieItemKey);

            if (!attachmentId) {
                return res.status(400).json({ success: false, error: 'ID do anexo inválido.' });
            }

            await dbRunAsync('ALTER TABLE occurrence_attachments ADD COLUMN section_key TEXT').catch(() => {});
            await dbRunAsync('ALTER TABLE occurrence_attachments ADD COLUMN dossie_model TEXT').catch(() => {});
            await dbRunAsync('ALTER TABLE occurrence_attachments ADD COLUMN dossie_item_key TEXT').catch(() => {});

            const current = await dbGetAsync(
                `SELECT id, occurrence_id, section_key
                 FROM occurrence_attachments
                 WHERE id = ?
                 LIMIT 1`,
                [attachmentId]
            );

            if (!current) {
                return res.status(404).json({ success: false, error: 'Anexo não encontrado.' });
            }

            const occurrenceId = String(current.occurrence_id || '').trim();
            if (occurrenceIdInput && occurrenceId && occurrenceIdInput !== occurrenceId) {
                return res.status(400).json({ success: false, error: 'Anexo não pertence à ocorrência informada.' });
            }

            if (dossieItemKey) {
                await dbRunAsync(
                    `UPDATE occurrence_attachments
                     SET section_key = 'dossie_eletronico',
                         dossie_model = ?,
                         dossie_item_key = ?,
                         updated_at = ?
                     WHERE id = ?`,
                    [dossieModel || 'OUTROS', dossieItemKey, nowIso(), attachmentId]
                );
            } else {
                await dbRunAsync(
                    `UPDATE occurrence_attachments
                     SET dossie_model = NULL,
                         dossie_item_key = NULL,
                         updated_at = ?
                     WHERE id = ?`,
                    [nowIso(), attachmentId]
                );
            }

            if (occurrenceId && actorUserId) {
                await writeAuditLog({
                    actorUserId,
                    entityType: 'occurrence_attachment',
                    entityId: attachmentId,
                    action: dossieItemKey ? 'associate_dossie_item' : 'clear_dossie_item',
                    details: {
                        occurrenceId,
                        dossieModel: dossieModel || null,
                        dossieItemKey: dossieItemKey || null,
                    },
                }).catch(() => {});
            }

            const updated = occurrenceId ? await loadOccurrenceById(occurrenceId) : null;
            return res.json({ success: true, data: updated });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Ocorrências] Erro ao atualizar associação do dossiê:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });


    app.post('/api/occurrences/:id/attachments/upload', async (req, res) => {
        try {
            const occurrenceId = String(req.params.id || '').trim();
            const actorUserId = String(req.body?.actorUserId || '').trim() || null;
            const fileNameRaw = String(req.body?.fileName || '').trim();
            const mimeType = String(req.body?.mimeType || 'application/octet-stream').trim();
            const dataBase64 = String(req.body?.dataBase64 || '').trim();
            const sectionKey = normalizeAttachmentSectionKey(req.body?.sectionKey);
            const dossieModel = normalizeDossieModel(req.body?.dossieModel);
            const dossieItemKey = normalizeDossieItemKey(req.body?.dossieItemKey);

            if (!occurrenceId || !fileNameRaw || !dataBase64) {
                return res.status(400).json({
                    success: false,
                    error: 'occurrenceId, fileName e dataBase64 são obrigatórios.',
                });
            }

            await dbRunAsync('ALTER TABLE occurrence_attachments ADD COLUMN local_file_path TEXT').catch(() => {});
            await dbRunAsync('ALTER TABLE occurrence_attachments ADD COLUMN section_key TEXT').catch(() => {});
            await dbRunAsync('ALTER TABLE occurrence_attachments ADD COLUMN dossie_model TEXT').catch(() => {});
            await dbRunAsync('ALTER TABLE occurrence_attachments ADD COLUMN dossie_item_key TEXT').catch(() => {});

            const occurrence = await dbGetAsync(
                `SELECT
                    o.id,
                    o.customer_id,
                    o.type_name,
                    o.title,
                    c.documents_folder
                 FROM occurrences o
                 LEFT JOIN customers c ON c.id = o.customer_id
                 WHERE o.id = ?
                 LIMIT 1`,
                [occurrenceId]
            );

            if (!occurrence) {
                return res.status(404).json({ success: false, error: 'Ocorrência não encontrada.' });
            }

            const configuredFolder = String(occurrence.documents_folder || '').trim();
            if (!configuredFolder) {
                return res.status(400).json({
                    success: false,
                    error: 'Cliente sem pasta de documentos configurada. Configure a pasta primeiro.',
                });
            }

            let fileBuffer = null;
            try {
                fileBuffer = Buffer.from(dataBase64, 'base64');
            } catch (error) {
                fileBuffer = null;
            }
            if (!fileBuffer || fileBuffer.length === 0) {
                return res.status(400).json({ success: false, error: 'Conteúdo do ficheiro inválido.' });
            }
            if (fileBuffer.length > 20 * 1024 * 1024) {
                return res.status(413).json({ success: false, error: 'Ficheiro excede o limite de 20MB.' });
            }

            const customerFolderRoot = resolveCustomerDocumentsFolder(occurrence.customer_id, configuredFolder);
            const typeFolder = normalizeOccurrenceTypeFolderName(occurrence.type_name || 'Outros Assuntos');
            const titleFolder = safeFolderName(occurrence.title || 'Sem titulo', 'Sem titulo');

            let targetDir = path.join(
                customerFolderRoot,
                'Ocorrencias',
                safeFolderName(typeFolder, 'Outros Assuntos'),
                titleFolder
            );

            if (sectionKey === 'dossie_eletronico') {
                const resolved = await resolveDossieFoldersWithCustom(dossieModel, dossieItemKey);
                targetDir = path.join(targetDir, 'dossie eletronico');
                if (resolved.principal) {
                    targetDir = path.join(targetDir, safeFolderName(resolved.principal, 'Sem separador'));
                }
                if (resolved.nivel2) {
                    targetDir = path.join(targetDir, safeFolderName(resolved.nivel2, 'Sem nivel'));
                } else if (dossieItemKey) {
                    targetDir = path.join(targetDir, safeFolderName(dossieItemKey, 'Sem separador'));
                }
            }
            await ensureWritableAncestors(targetDir);
            try {
                await fs.promises.mkdir(targetDir, { recursive: true });
                await ensureWritableDirectory(targetDir);
            } catch (mkdirError) {
                const permissionMessage = toWritePermissionMessage(mkdirError, targetDir);
                if (permissionMessage) {
                    return res.status(403).json({ success: false, error: permissionMessage });
                }
                throw mkdirError;
            }

            const safeName = safeFileName(fileNameRaw, 'anexo.bin');
            const targetPath = await resolveUniqueFilePath(path.join(targetDir, safeName));
            try {
                await fs.promises.writeFile(targetPath, fileBuffer);
            } catch (writeError) {
                const permissionMessage = toWritePermissionMessage(writeError, targetPath);
                if (permissionMessage) {
                    return res.status(403).json({ success: false, error: permissionMessage });
                }
                throw writeError;
            }

            const kind = mimeType.toLowerCase().startsWith('image/') ? 'foto' : 'documento';
            const attachmentId = generateLocalId('occ_att');

            await dbRunAsync(
                `INSERT INTO occurrence_attachments (
                    id,
                    source_id,
                    occurrence_id,
                    kind,
                    source_table,
                    file_url,
                    storage_path,
                    local_file_path,
                    original_name,
                    section_key,
                    dossie_model,
                    dossie_item_key,
                    created_at,
                    updated_at
                 ) VALUES (?, NULL, ?, ?, 'local_upload', NULL, NULL, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                    attachmentId,
                    occurrenceId,
                    kind,
                    targetPath,
                    safeName,
                    sectionKey,
                    dossieModel || null,
                    dossieItemKey || null,
                    nowIso(),
                ]
            );

            await writeAuditLog({
                actorUserId,
                entityType: 'occurrence_attachment',
                entityId: attachmentId,
                action: 'upload',
                details: {
                    occurrenceId,
                    fileName: safeName,
                    mimeType,
                    bytes: fileBuffer.length,
                    path: targetPath,
                    sectionKey,
                    dossieModel: dossieModel || null,
                    dossieItemKey: dossieItemKey || null,
                },
            });

            const updated = await loadOccurrenceById(occurrenceId);
            return res.json({ success: true, data: updated });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Ocorrências] Erro ao anexar ficheiro:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/occurrences', async (req, res) => {
        try {
            const body = req.body || {};
            const idRaw = String(body.id || '').trim();
            const customerId = String(body.customerId || '').trim();
            const title = String(body.title || '').trim();
            const description = String(body.description || '').trim();
            const resolution = String(body.resolution || '').trim();
            const date = toIsoDate(body.date) || toIsoDate(new Date().toISOString());
            const dueDate = toIsoDate(body.dueDate || body.dataLimite);
            const typeIdRaw = Number(body.typeId || body.tipoOcorrenciaId || 0);
            const typeId = Number.isFinite(typeIdRaw) && typeIdRaw > 0 ? Math.trunc(typeIdRaw) : null;
            const state = normalizeOccurrenceState(body.state || body.estado, dueDate);
            const responsibleUserIdRaw = String(body.responsibleUserId || body.responsavelId || '').trim();
            const responsibleUserIdsRaw = parseJsonArray(body.responsibleUserIds || body.responsaveis)
                .map((value) => String(value || '').trim())
                .filter(Boolean);

            if (!customerId || !title) {
                return res.status(400).json({ success: false, error: 'customerId e título são obrigatórios.' });
            }

            const customer = await dbGetAsync(
                `SELECT id, nif FROM customers WHERE id = ? LIMIT 1`,
                [customerId]
            );
            if (!customer) {
                return res.status(404).json({ success: false, error: 'Cliente não encontrado.' });
            }

            const existing = idRaw
                ? await dbGetAsync('SELECT * FROM occurrences WHERE id = ? LIMIT 1', [idRaw])
                : null;
            const id = idRaw || generateLocalId('occ');

            const responsibleIdsSet = new Set(responsibleUserIdsRaw);
            if (responsibleUserIdRaw) responsibleIdsSet.add(responsibleUserIdRaw);
            if (existing && String(existing.responsible_ids_json || '').trim()) {
                parseJsonArray(existing.responsible_ids_json)
                    .map((value) => String(value || '').trim())
                    .filter(Boolean)
                    .forEach((value) => responsibleIdsSet.add(value));
            }
            const responsibleUserIds = Array.from(responsibleIdsSet);
            const responsibleUserId = responsibleUserIdRaw || responsibleUserIds[0] || '';

            let typeName = String(body.typeName || '').trim();
            if (!typeName && typeId) {
                const typeRow = await dbGetAsync('SELECT name FROM occurrence_types WHERE id = ? LIMIT 1', [typeId]);
                typeName = String(typeRow?.name || '').trim();
            }

            let responsibleNamesText = '';
            if (responsibleUserIds.length > 0) {
                const placeholders = responsibleUserIds.map(() => '?').join(',');
                const users = await dbAllAsync(
                    `SELECT id, name FROM users WHERE id IN (${placeholders})`,
                    responsibleUserIds
                );
                responsibleNamesText = users
                    .map((item) => String(item.name || '').trim())
                    .filter(Boolean)
                    .join(', ');
            }

            let projetoApoioDetalheJson = null;
            if (body.projetoApoioDetalhe !== undefined) {
                try {
                    projetoApoioDetalheJson = JSON.stringify(body.projetoApoioDetalhe || {});
                } catch (error) {
                    projetoApoioDetalheJson = null;
                }
            } else if (existing?.projeto_apoio_detalhe_json) {
                projetoApoioDetalheJson = String(existing.projeto_apoio_detalhe_json || '').trim() || null;
            }

            await dbRunAsync(
                `INSERT INTO occurrences (
                    id,
                    source_id,
                    customer_id,
                    source_customer_id,
                    customer_nif,
                    date,
                    type_id,
                    type_name,
                    title,
                    description,
                    state,
                    due_date,
                    responsible_user_id,
                    responsible_ids_json,
                    responsible_names_text,
                    resolution,
                    projeto_apoio_detalhe_json,
                    supabase_payload_json,
                    sync_origin,
                    last_synced_at,
                    created_at,
                    updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT(id) DO UPDATE SET
                    customer_id = excluded.customer_id,
                    customer_nif = excluded.customer_nif,
                    date = excluded.date,
                    type_id = excluded.type_id,
                    type_name = excluded.type_name,
                    title = excluded.title,
                    description = excluded.description,
                    state = excluded.state,
                    due_date = excluded.due_date,
                    responsible_user_id = excluded.responsible_user_id,
                    responsible_ids_json = excluded.responsible_ids_json,
                    responsible_names_text = excluded.responsible_names_text,
                    resolution = excluded.resolution,
                    projeto_apoio_detalhe_json = excluded.projeto_apoio_detalhe_json,
                    sync_origin = 'local',
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    id,
                    String(existing?.source_id || '').trim() || null,
                    customerId,
                    String(existing?.source_customer_id || '').trim() || null,
                    String(customer.nif || '').trim() || null,
                    date,
                    typeId,
                    typeName || null,
                    title,
                    description || null,
                    state,
                    dueDate || null,
                    responsibleUserId || null,
                    JSON.stringify(responsibleUserIds),
                    responsibleNamesText || null,
                    resolution || null,
                    projetoApoioDetalheJson,
                    String(existing?.supabase_payload_json || '').trim() || null,
                ]
            );

            await writeAuditLog({
                actorUserId: String(body.actorUserId || responsibleUserId || '').trim() || null,
                entityType: 'occurrence',
                entityId: id,
                action: existing ? 'update' : 'create',
                details: {
                    customerId,
                    title,
                    state,
                    dueDate: dueDate || null,
                },
            });

            const occurrence = await loadOccurrenceById(id);
            return res.json({ success: true, data: occurrence });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Ocorrências] Erro ao guardar:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.delete('/api/occurrences/:id', async (req, res) => {
        try {
            const id = String(req.params.id || '').trim();
            if (!id) {
                return res.status(400).json({ success: false, error: 'ID inválido.' });
            }

            const existing = await dbGetAsync('SELECT id, title FROM occurrences WHERE id = ? LIMIT 1', [id]);
            if (!existing) {
                return res.status(404).json({ success: false, error: 'Ocorrência não encontrada.' });
            }

            await dbRunAsync('DELETE FROM occurrence_attachments WHERE occurrence_id = ?', [id]);
            await dbRunAsync('DELETE FROM occurrences WHERE id = ?', [id]);

            await writeAuditLog({
                actorUserId: String(req.query.actorUserId || '').trim() || null,
                entityType: 'occurrence',
                entityId: id,
                action: 'delete',
                details: { title: String(existing.title || '').trim() },
            });

            return res.json({ success: true });
        } catch (error) {
            const details = error?.message || error;
            console.error('[Ocorrências] Erro ao apagar:', details);
            return res.status(500).json({ success: false, error: details });
        }
    });

    app.post('/api/occurrences/import/supabase', async (req, res) => {
        try {
            if (!SUPABASE_URL || !SUPABASE_KEY) {
                return res.status(400).json({ success: false, error: 'Supabase não configurado.' });
            }

            await dbRunAsync('ALTER TABLE occurrence_attachments ADD COLUMN local_file_path TEXT').catch(() => {});

            const [
                occurrencesTable,
                photosTable,
                docsTable,
                typesTable,
                customersTable,
                funcionariosTable,
            ] = await Promise.all([
                resolveSupabaseTableName(SUPABASE_OCORRENCIAS_SOURCE, ['public.ocorrencias', 'ocorrencias']),
                resolveSupabaseTableName(SUPABASE_OCORRENCIAS_FOTOS_SOURCE, ['public.ocorrencias_fotos', 'ocorrencias_fotos']),
                resolveSupabaseTableName(SUPABASE_OCORRENCIAS_DOCUMENTOS_SOURCE, ['public.ocorrencias_documentos', 'ocorrencias_documentos']),
                resolveSupabaseTableName(SUPABASE_TIPOS_OCORRENCIA_SOURCE, ['public.tipos_ocorrencia', 'tipos_ocorrencia']),
                resolveSupabaseTableName(SUPABASE_CLIENTS_SOURCE, ['public.clientes', 'clientes']),
                resolveSupabaseTableName(SUPABASE_FUNCIONARIOS_SOURCE, ['public.funcionarios', 'funcionarios']),
            ]);

            const [
                occurrencesRows,
                photosRows,
                docsRows,
                typesRows,
                sourceCustomersRows,
                sourceFuncionariosRows,
                localCustomersRows,
                localUsersRows,
            ] = await Promise.all([
                fetchSupabaseTable(occurrencesTable),
                fetchSupabaseTable(photosTable).catch(() => []),
                fetchSupabaseTable(docsTable).catch(() => []),
                fetchSupabaseTable(typesTable).catch(() => []),
                fetchSupabaseTable(customersTable),
                fetchSupabaseTable(funcionariosTable),
                dbAllAsync('SELECT id, source_id, nif FROM customers'),
                dbAllAsync('SELECT id, source_id, email, name FROM users'),
            ]);

            await ensureDefaultOccurrenceTypes();

            const typeNameById = new Map();
            for (const typeRow of typesRows) {
                const id = Number(typeRow?.id || 0);
                const name = String(typeRow?.nome || typeRow?.name || '').trim();
                if (!id || !name) continue;
                typeNameById.set(String(id), name);
                await dbRunAsync(
                    `INSERT INTO occurrence_types (id, name, source_id, updated_at)
                     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        source_id = excluded.source_id,
                        updated_at = CURRENT_TIMESTAMP`,
                    [id, name, String(typeRow?.id || '')]
                );
            }

            const localCustomerBySource = new Map();
            const localCustomerByNif = new Map();
            localCustomersRows.forEach((row) => {
                const id = String(row.id || '').trim();
                const sourceId = String(row.source_id || '').trim();
                const nif = normalizeDigits(String(row.nif || '').trim());
                if (sourceId) localCustomerBySource.set(sourceId, { id, sourceId, nif });
                if (nif) localCustomerByNif.set(nif, { id, sourceId, nif });
            });

            const sourceCustomerById = new Map();
            sourceCustomersRows.forEach((row) => {
                const sourceId = String(row?.id || '').trim();
                if (!sourceId) return;
                sourceCustomerById.set(sourceId, {
                    id: sourceId,
                    nif: normalizeDigits(String(row?.nif || '').trim()),
                    row,
                });
            });

            const localUserBySource = new Map();
            const localUserByEmail = new Map();
            const localUserNameById = new Map();
            localUsersRows.forEach((row) => {
                const id = String(row.id || '').trim();
                const sourceId = String(row.source_id || '').trim();
                const email = String(row.email || '').trim().toLowerCase();
                const name = String(row.name || '').trim();
                if (sourceId) localUserBySource.set(sourceId, id);
                if (email) localUserByEmail.set(email, id);
                if (id && name) localUserNameById.set(id, name);
            });

            const sourceFuncionarioById = new Map();
            sourceFuncionariosRows.forEach((row) => {
                const id = String(row?.id || '').trim();
                if (!id) return;
                sourceFuncionarioById.set(id, {
                    id,
                    name: String(row?.nome || row?.name || '').trim(),
                    email: String(row?.email || '').trim().toLowerCase(),
                });
            });

            const importedLocalOccurrenceIdBySource = new Map();
            const occurrenceInfoById = new Map();
            let importedOccurrences = 0;
            let skippedWithoutCustomer = 0;

            async function ensureLocalCustomerFromSource(sourceCustomerId, sourceCustomerInfo) {
                const current = sourceCustomerId ? localCustomerBySource.get(sourceCustomerId) : null;
                if (current?.id) return current;

                const sourceRow = sourceCustomerInfo?.row || null;
                if (!sourceRow || !sourceCustomerId) return null;

                const localId = `ext_c_${sourceCustomerId}`;
                const name = String(sourceRow?.nome || sourceRow?.name || sourceRow?.cliente || sourceRow?.empresa || '').trim() || `Cliente ${sourceCustomerId}`;
                const company = String(sourceRow?.empresa || sourceRow?.company || sourceRow?.entidade || '').trim() || name;
                const phone = String(sourceRow?.telefone || sourceRow?.telemovel || sourceRow?.phone || sourceRow?.whatsapp || '').trim();
                const email = String(sourceRow?.email || sourceRow?.mail || '').trim().toLowerCase();
                const nifRaw = String(sourceRow?.nif || '').trim();
                const nif = normalizeDigits(nifRaw);

                await dbRunAsync(
                    `INSERT INTO customers (
                        id, source_id, name, company, phone, email, owner_id, type, contacts_json, allow_auto_responses, nif, updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'Empresa', '[]', 1, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(id) DO UPDATE SET
                        source_id = excluded.source_id,
                        name = excluded.name,
                        company = excluded.company,
                        phone = excluded.phone,
                        email = excluded.email,
                        nif = excluded.nif,
                        updated_at = CURRENT_TIMESTAMP`,
                    [localId, sourceCustomerId, name, company, phone, email || null, nifRaw || null]
                );

                const localCustomer = { id: localId, sourceId: sourceCustomerId, nif };
                localCustomerBySource.set(sourceCustomerId, localCustomer);
                if (nif) localCustomerByNif.set(nif, localCustomer);
                return localCustomer;
            }

            for (const row of occurrencesRows) {
                const sourceOccurrenceId = String(row?.id || '').trim();
                if (!sourceOccurrenceId) continue;

                const sourceCustomerId = String(row?.cliente_id || '').trim();
                const sourceCustomer = sourceCustomerById.get(sourceCustomerId);
                const sourceNif = normalizeDigits(sourceCustomer?.nif || '');

                let localCustomer =
                    (sourceCustomerId ? localCustomerBySource.get(sourceCustomerId) : null)
                    || (sourceNif ? localCustomerByNif.get(sourceNif) : null);

                if (!localCustomer?.id) {
                    localCustomer = await ensureLocalCustomerFromSource(sourceCustomerId, sourceCustomer);
                }
                if (!localCustomer?.id) {
                    skippedWithoutCustomer += 1;
                    continue;
                }

                const typeIdRaw = Number(row?.tipo_ocorrencia_id || 0);
                const typeId = Number.isFinite(typeIdRaw) && typeIdRaw > 0 ? Math.trunc(typeIdRaw) : null;
                const typeName =
                    String(typeNameById.get(String(typeId || '')) || row?.tipo_nome || '').trim() || null;

                const sourceResponsavelIdsSet = new Set();
                const responsaveisArray = parseJsonArray(row?.responsaveis)
                    .map((value) => String(value || '').trim())
                    .filter(Boolean);
                responsaveisArray.forEach((value) => sourceResponsavelIdsSet.add(value));
                const responsavelId = String(row?.responsavel_id || '').trim();
                if (responsavelId) sourceResponsavelIdsSet.add(responsavelId);

                const mappedResponsibleIds = [];
                const mappedResponsibleNames = [];
                for (const sourceRespId of sourceResponsavelIdsSet) {
                    const localIdBySource = localUserBySource.get(sourceRespId);
                    if (localIdBySource) {
                        mappedResponsibleIds.push(localIdBySource);
                        const name = localUserNameById.get(localIdBySource);
                        if (name) mappedResponsibleNames.push(name);
                        continue;
                    }
                    const sourceFunc = sourceFuncionarioById.get(sourceRespId);
                    if (sourceFunc?.email) {
                        const localIdByEmail = localUserByEmail.get(sourceFunc.email);
                        if (localIdByEmail) {
                            mappedResponsibleIds.push(localIdByEmail);
                            const name = localUserNameById.get(localIdByEmail);
                            if (name) mappedResponsibleNames.push(name);
                            continue;
                        }
                    }
                    if (sourceFunc?.name) {
                        mappedResponsibleNames.push(sourceFunc.name);
                    }
                }

                const uniqueResponsibleIds = Array.from(new Set(mappedResponsibleIds));
                const uniqueResponsibleNames = Array.from(new Set(mappedResponsibleNames));

                const existing = await dbGetAsync(
                    `SELECT id FROM occurrences WHERE source_id = ? LIMIT 1`,
                    [sourceOccurrenceId]
                );
                const localOccurrenceId = String(existing?.id || sourceOccurrenceId).trim() || generateLocalId('occ');

                let projetoApoioDetalheJson = null;
                if (row?.projeto_apoio_detalhe !== undefined && row?.projeto_apoio_detalhe !== null) {
                    try {
                        projetoApoioDetalheJson = JSON.stringify(row.projeto_apoio_detalhe);
                    } catch (error) {
                        projetoApoioDetalheJson = null;
                    }
                }

                let supabasePayloadJson = null;
                try {
                    supabasePayloadJson = JSON.stringify(row || {});
                } catch (error) {
                    supabasePayloadJson = null;
                }

                const occurrenceDate = toIsoDate(row?.data) || toIsoDate(new Date().toISOString());
                const occurrenceDueDate = toIsoDate(row?.data_limite);

                await dbRunAsync(
                    `INSERT INTO occurrences (
                        id,
                        source_id,
                        customer_id,
                        source_customer_id,
                        customer_nif,
                        date,
                        type_id,
                        type_name,
                        title,
                        description,
                        state,
                        due_date,
                        responsible_user_id,
                        responsible_ids_json,
                        responsible_names_text,
                        resolution,
                        projeto_apoio_detalhe_json,
                        supabase_payload_json,
                        sync_origin,
                        last_synced_at,
                        created_at,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'supabase', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    ON CONFLICT(id) DO UPDATE SET
                        source_id = excluded.source_id,
                        customer_id = excluded.customer_id,
                        source_customer_id = excluded.source_customer_id,
                        customer_nif = excluded.customer_nif,
                        date = excluded.date,
                        type_id = excluded.type_id,
                        type_name = excluded.type_name,
                        title = excluded.title,
                        description = excluded.description,
                        state = excluded.state,
                        due_date = excluded.due_date,
                        responsible_user_id = excluded.responsible_user_id,
                        responsible_ids_json = excluded.responsible_ids_json,
                        responsible_names_text = excluded.responsible_names_text,
                        resolution = excluded.resolution,
                        projeto_apoio_detalhe_json = excluded.projeto_apoio_detalhe_json,
                        supabase_payload_json = excluded.supabase_payload_json,
                        sync_origin = 'supabase',
                        last_synced_at = excluded.last_synced_at,
                        updated_at = CURRENT_TIMESTAMP`,
                    [
                        localOccurrenceId,
                        sourceOccurrenceId,
                        localCustomer.id,
                        sourceCustomerId || null,
                        sourceNif || null,
                        occurrenceDate,
                        typeId,
                        typeName,
                        String(row?.titulo || '').trim() || 'Sem título',
                        String(row?.descricao || '').trim() || null,
                        normalizeOccurrenceState(row?.estado, occurrenceDueDate),
                        occurrenceDueDate || null,
                        uniqueResponsibleIds[0] || null,
                        JSON.stringify(uniqueResponsibleIds),
                        uniqueResponsibleNames.join(', ') || null,
                        String(row?.resolucao || '').trim() || null,
                        projetoApoioDetalheJson,
                        supabasePayloadJson,
                        nowIso(),
                    ]
                );

                importedLocalOccurrenceIdBySource.set(sourceOccurrenceId, localOccurrenceId);
                occurrenceInfoById.set(localOccurrenceId, {
                    occurrenceId: localOccurrenceId,
                    customerId: localCustomer.id,
                    typeName: typeName || '',
                    title: String(row?.titulo || '').trim() || 'Sem título',
                    documentsFolder: null,
                });
                importedOccurrences += 1;
            }

            let importedAttachments = 0;
            let importedAttachmentsToLocal = 0;
            let skippedAttachmentWithoutOccurrence = 0;
            let skippedAttachmentWithoutFolder = 0;
            let failedAttachmentDownloads = 0;

            async function upsertAttachmentRow({
                sourceAttachmentId,
                sourceOccurrenceId,
                kind,
                sourceTable,
                fileUrl,
                storagePath,
                originalName,
                createdAt,
            }) {
                if (!sourceAttachmentId || !sourceOccurrenceId) {
                    skippedAttachmentWithoutOccurrence += 1;
                    return;
                }

                let occurrenceId = importedLocalOccurrenceIdBySource.get(sourceOccurrenceId);
                if (!occurrenceId) {
                    const row = await dbGetAsync(
                        `SELECT id FROM occurrences WHERE source_id = ? LIMIT 1`,
                        [sourceOccurrenceId]
                    );
                    occurrenceId = String(row?.id || '').trim();
                }
                if (!occurrenceId) {
                    skippedAttachmentWithoutOccurrence += 1;
                    return;
                }

                let occurrenceInfo = occurrenceInfoById.get(occurrenceId) || null;
                if (!occurrenceInfo || !String(occurrenceInfo.documentsFolder || '').trim()) {
                    const row = await dbGetAsync(
                        `SELECT
                            o.id AS occurrence_id,
                            o.type_name,
                            o.title,
                            o.customer_id,
                            c.documents_folder
                         FROM occurrences o
                         LEFT JOIN customers c ON c.id = o.customer_id
                         WHERE o.id = ?
                         LIMIT 1`,
                        [occurrenceId]
                    );
                    occurrenceInfo = row
                        ? {
                              occurrenceId: String(row.occurrence_id || '').trim(),
                              customerId: String(row.customer_id || '').trim(),
                              typeName: String(row.type_name || '').trim(),
                              title: String(row.title || '').trim(),
                              documentsFolder: String(row.documents_folder || '').trim(),
                          }
                        : null;
                    if (occurrenceInfo?.occurrenceId) {
                        occurrenceInfoById.set(occurrenceInfo.occurrenceId, occurrenceInfo);
                    }
                }

                let localFilePath = null;
                let resolvedOriginalName = String(originalName || '').trim();
                const hasCustomerFolder = !!String(occurrenceInfo?.documentsFolder || '').trim();

                if (hasCustomerFolder && occurrenceInfo?.customerId && typeof resolveCustomerDocumentsFolder === 'function') {
                    try {
                        const customerFolderRoot = resolveCustomerDocumentsFolder(
                            occurrenceInfo.customerId,
                            occurrenceInfo.documentsFolder
                        );
                        const typeFolder = normalizeOccurrenceTypeFolderName(occurrenceInfo.typeName || 'Outros Assuntos');
                        const titleFolder = safeFolderName(occurrenceInfo.title || 'Sem titulo', 'Sem titulo');
                        const targetDir = path.join(
                            customerFolderRoot,
                            'Ocorrencias',
                            safeFolderName(typeFolder, 'Outros Assuntos'),
                            titleFolder
                        );
                        await ensureWritableAncestors(targetDir);
                        await fs.promises.mkdir(targetDir, { recursive: true });
                        await ensureWritableDirectory(targetDir);

                        const downloaded = await downloadOccurrenceAttachmentBuffer({ fileUrl, storagePath });
                        if (downloaded?.buffer) {
                            let fileName = inferFileNameFromSources({
                                fileUrl,
                                storagePath,
                                originalName,
                                fallbackId: sourceAttachmentId,
                                contentType: downloaded.contentType,
                            });
                            const currentExt = path.extname(fileName);
                            if (!currentExt) {
                                const inferredExt = inferExtensionFromContentType(downloaded.contentType, '');
                                if (inferredExt) {
                                    fileName = safeFileName(
                                        String(fileName || '').trim() + inferredExt,
                                        'anexo_' + String(sourceAttachmentId || Date.now()) + inferredExt
                                    );
                                }
                            }

                            const baseTargetPath = path.join(
                                targetDir,
                                safeFileName(fileName, 'anexo_' + String(sourceAttachmentId || Date.now()) + '.bin')
                            );
                            const uniqueTargetPath = await resolveUniqueFilePath(baseTargetPath);
                            await fs.promises.writeFile(uniqueTargetPath, downloaded.buffer);
                            localFilePath = uniqueTargetPath;
                            resolvedOriginalName = resolvedOriginalName || path.basename(uniqueTargetPath);
                            importedAttachmentsToLocal += 1;
                        } else {
                            failedAttachmentDownloads += 1;
                        }
                    } catch (error) {
                        failedAttachmentDownloads += 1;
                        console.warn('[Ocorrências] Falha ao gravar anexo local:', error?.message || error);
                    }
                } else {
                    skippedAttachmentWithoutFolder += 1;
                }

                const existing = await dbGetAsync(
                    `SELECT id FROM occurrence_attachments WHERE source_id = ? LIMIT 1`,
                    [sourceAttachmentId]
                );
                const localAttachmentId = String(existing?.id || sourceAttachmentId).trim() || generateLocalId('occ_att');

                await dbRunAsync(
                    `INSERT INTO occurrence_attachments (
                        id,
                        source_id,
                        occurrence_id,
                        kind,
                        source_table,
                        file_url,
                        storage_path,
                        local_file_path,
                        original_name,
                        created_at,
                        updated_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                     ON CONFLICT(id) DO UPDATE SET
                        source_id = excluded.source_id,
                        occurrence_id = excluded.occurrence_id,
                        kind = excluded.kind,
                        source_table = excluded.source_table,
                        file_url = excluded.file_url,
                        storage_path = excluded.storage_path,
                        local_file_path = excluded.local_file_path,
                        original_name = excluded.original_name,
                        created_at = excluded.created_at,
                        updated_at = CURRENT_TIMESTAMP`,
                    [
                        localAttachmentId,
                        sourceAttachmentId,
                        occurrenceId,
                        kind,
                        sourceTable,
                        fileUrl || null,
                        storagePath || null,
                        localFilePath || null,
                        resolvedOriginalName || null,
                        toIsoDate(createdAt) || String(createdAt || '').trim() || null,
                    ]
                );

                importedAttachments += 1;
            }

            for (const row of photosRows) {
                await upsertAttachmentRow({
                    sourceAttachmentId: String(row?.id || '').trim(),
                    sourceOccurrenceId: String(row?.ocorrencia_id || '').trim(),
                    kind: 'foto',
                    sourceTable: photosTable,
                    fileUrl: String(row?.foto_url || '').trim(),
                    storagePath: null,
                    originalName: null,
                    createdAt: row?.created_at,
                });
            }

            for (const row of docsRows) {
                await upsertAttachmentRow({
                    sourceAttachmentId: String(row?.id || '').trim(),
                    sourceOccurrenceId: String(row?.ocorrencia_id || '').trim(),
                    kind: 'documento',
                    sourceTable: docsTable,
                    fileUrl: null,
                    storagePath: String(row?.storage_path || '').trim(),
                    originalName: String(row?.nome_original || '').trim(),
                    createdAt: row?.created_at,
                });
            }

            await writeAuditLog({
                actorUserId: String(req.body?.actorUserId || '').trim() || null,
                entityType: 'occurrence',
                entityId: null,
                action: 'import_supabase',
                details: {
                    occurrencesTable,
                    photosTable,
                    docsTable,
                    importedOccurrences,
                    importedAttachments,
                    importedAttachmentsToLocal,
                    skippedWithoutCustomer,
                    skippedAttachmentWithoutOccurrence,
                    skippedAttachmentWithoutFolder,
                    failedAttachmentDownloads,
                },
            });

            return res.json({
                success: true,
                summary: {
                    occurrencesTable,
                    photosTable,
                    docsTable,
                    sourceOccurrences: occurrencesRows.length,
                    sourcePhotos: photosRows.length,
                    sourceDocuments: docsRows.length,
                    importedOccurrences,
                    importedAttachments,
                    importedAttachmentsToLocal,
                    skippedWithoutCustomer,
                    skippedAttachmentWithoutOccurrence,
                    skippedAttachmentWithoutFolder,
                    failedAttachmentDownloads,
                },
            });
        } catch (error) {
            const details = error?.response?.data || error?.message || error;
            console.error('[Ocorrências] Erro na importação do Supabase:', details);
            return res.status(500).json({
                success: false,
                error: typeof details === 'string' ? details : JSON.stringify(details),
            });
        }
    });
}

module.exports = {
    registerOccurrencesRoutes,
};
