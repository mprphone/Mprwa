'use strict';

const crypto = require('crypto');
const { createEmailAutoReplyService } = require('../../src/server/services/emailAutoReplyService');

function registerHrManagementRoutes(context) {
    const {
        app,
        dbRunAsync,
        dbGetAsync,
        dbAllAsync,
        writeAuditLog,
        SUPABASE_URL,
        SUPABASE_KEY,
        SUPABASE_FUNCIONARIOS_SOURCE,
        fetchSupabaseTable,
        resolveSupabaseTableName,
        nowIso = () => new Date().toISOString(),
    } = context;

    let schemaReady = false;
    const emailAutoReplyService = createEmailAutoReplyService({ logger: console });
    let emailAutoReplySchedulerStarted = false;
    let emailAutoReplySchedulerLastRun = '';

    async function ensureHrSchema() {
        if (schemaReady) return;
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS hr_funcionarios (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                nome TEXT NOT NULL,
                email TEXT,
                telefone TEXT,
                pin TEXT,
                activo INTEGER NOT NULL DEFAULT 1,
                horario_trabalho TEXT,
                local_trabalho TEXT,
                data_nascimento TEXT,
                objetivos_json TEXT,
                premio_objetivos TEXT,
                supabase_payload_json TEXT,
                supabase_created_at TEXT,
                supabase_updated_at TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        const ensureColumn = async (table, column, ddl) => {
            const columns = await dbAllAsync(`PRAGMA table_info(${table})`);
            if (!columns.some((row) => String(row.name || '') === column)) {
                await dbRunAsync(ddl);
            }
        };
        const funcionarioColumns = [
            ['numero_colaborador', 'ALTER TABLE hr_funcionarios ADD COLUMN numero_colaborador TEXT'],
            ['nif', 'ALTER TABLE hr_funcionarios ADD COLUMN nif TEXT'],
            ['niss', 'ALTER TABLE hr_funcionarios ADD COLUMN niss TEXT'],
            ['cartao_cidadao', 'ALTER TABLE hr_funcionarios ADD COLUMN cartao_cidadao TEXT'],
            ['morada', 'ALTER TABLE hr_funcionarios ADD COLUMN morada TEXT'],
            ['codigo_postal', 'ALTER TABLE hr_funcionarios ADD COLUMN codigo_postal TEXT'],
            ['estado_civil', 'ALTER TABLE hr_funcionarios ADD COLUMN estado_civil TEXT'],
            ['tem_filhos', 'ALTER TABLE hr_funcionarios ADD COLUMN tem_filhos INTEGER NOT NULL DEFAULT 0'],
            ['numero_filhos', 'ALTER TABLE hr_funcionarios ADD COLUMN numero_filhos INTEGER NOT NULL DEFAULT 0'],
            ['contacto_emergencia', 'ALTER TABLE hr_funcionarios ADD COLUMN contacto_emergencia TEXT'],
            ['iban', 'ALTER TABLE hr_funcionarios ADD COLUMN iban TEXT'],
            ['cargo', 'ALTER TABLE hr_funcionarios ADD COLUMN cargo TEXT'],
            ['responsavel_direto', 'ALTER TABLE hr_funcionarios ADD COLUMN responsavel_direto TEXT'],
            ['tipo_vinculo', 'ALTER TABLE hr_funcionarios ADD COLUMN tipo_vinculo TEXT'],
            ['data_admissao', 'ALTER TABLE hr_funcionarios ADD COLUMN data_admissao TEXT'],
            ['data_saida', 'ALTER TABLE hr_funcionarios ADD COLUMN data_saida TEXT'],
            ['observacoes_internas', 'ALTER TABLE hr_funcionarios ADD COLUMN observacoes_internas TEXT'],
            ['foto_url', 'ALTER TABLE hr_funcionarios ADD COLUMN foto_url TEXT'],
            ['estado_rh', 'ALTER TABLE hr_funcionarios ADD COLUMN estado_rh TEXT'],
            ['tipo_horario', 'ALTER TABLE hr_funcionarios ADD COLUMN tipo_horario TEXT'],
            ['hora_entrada_prevista', 'ALTER TABLE hr_funcionarios ADD COLUMN hora_entrada_prevista TEXT'],
            ['hora_saida_prevista', 'ALTER TABLE hr_funcionarios ADD COLUMN hora_saida_prevista TEXT'],
            ['pausa_almoco_inicio', 'ALTER TABLE hr_funcionarios ADD COLUMN pausa_almoco_inicio TEXT'],
            ['pausa_almoco_fim', 'ALTER TABLE hr_funcionarios ADD COLUMN pausa_almoco_fim TEXT'],
            ['tolerancia_entrada_min', 'ALTER TABLE hr_funcionarios ADD COLUMN tolerancia_entrada_min INTEGER NOT NULL DEFAULT 0'],
            ['tolerancia_saida_min', 'ALTER TABLE hr_funcionarios ADD COLUMN tolerancia_saida_min INTEGER NOT NULL DEFAULT 0'],
            ['horas_diarias_previstas', 'ALTER TABLE hr_funcionarios ADD COLUMN horas_diarias_previstas REAL NOT NULL DEFAULT 8'],
            ['horas_semanais_contratadas', 'ALTER TABLE hr_funcionarios ADD COLUMN horas_semanais_contratadas REAL NOT NULL DEFAULT 40'],
            ['dias_trabalho', 'ALTER TABLE hr_funcionarios ADD COLUMN dias_trabalho TEXT'],
        ];
        for (const [column, ddl] of funcionarioColumns) {
            await ensureColumn('hr_funcionarios', column, ddl);
        }
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS hr_pedidos (
                id TEXT PRIMARY KEY,
                funcionario_id TEXT,
                atribuido_a TEXT,
                tipo TEXT NOT NULL,
                descricao TEXT,
                data_inicio TEXT,
                data_fim TEXT,
                status TEXT NOT NULL DEFAULT 'PENDENTE',
                resolucao TEXT,
                supabase_payload_json TEXT,
                supabase_created_at TEXT,
                supabase_updated_at TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS hr_registos_ponto (
                id TEXT PRIMARY KEY,
                funcionario_id TEXT NOT NULL,
                tipo TEXT NOT NULL,
                momento TEXT NOT NULL,
                origem TEXT,
                supabase_payload_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS hr_holidays (
                date TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                region TEXT,
                supabase_payload_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS hr_ferias_saldos (
                id TEXT PRIMARY KEY,
                funcionario_id TEXT NOT NULL,
                ano INTEGER NOT NULL,
                dias_direito REAL NOT NULL DEFAULT 22,
                dias_extra REAL NOT NULL DEFAULT 0,
                dias_usados_manual REAL NOT NULL DEFAULT 0,
                observacoes TEXT,
                supabase_payload_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(funcionario_id, ano)
            )`
        );
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS hr_ferias_empresa_periodos (
                id TEXT PRIMARY KEY,
                titulo TEXT NOT NULL,
                descricao TEXT,
                data_inicio TEXT NOT NULL,
                data_fim TEXT NOT NULL,
                funcionarios_alvo_json TEXT,
                created_by TEXT,
                supabase_payload_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS hr_objetivos (
                id TEXT PRIMARY KEY,
                funcionario_id TEXT NOT NULL,
                titulo TEXT NOT NULL,
                deadline TEXT,
                meta_tipo TEXT NOT NULL DEFAULT 'QTD',
                meta REAL NOT NULL DEFAULT 0,
                atingido REAL NOT NULL DEFAULT 0,
                peso REAL NOT NULL DEFAULT 0,
                erros INTEGER NOT NULL DEFAULT 0,
                ordem INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS hr_objetivos_config (
                funcionario_id TEXT PRIMARY KEY,
                patamar_50 TEXT,
                patamar_65 TEXT,
                patamar_80 TEXT,
                premio_maximo REAL NOT NULL DEFAULT 0,
                notas_gerais TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS hr_email_autoreply_schedules (
                id TEXT PRIMARY KEY,
                pedido_id TEXT,
                funcionario_id TEXT NOT NULL,
                funcionario_nome TEXT,
                email TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                subject TEXT NOT NULL DEFAULT 'Ausência temporária',
                message TEXT NOT NULL,
                alternate_contact TEXT,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                deactivate_date TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'manual_necessario',
                last_action TEXT,
                last_error TEXT,
                activated_at DATETIME,
                deactivated_at DATETIME,
                template_variant TEXT NOT NULL DEFAULT 'default',
                alternate_contact_email TEXT,
                alternate_contact_phone TEXT,
                mode TEXT NOT NULL DEFAULT 'manual',
                manual_url TEXT,
                activation_alert_at DATETIME,
                deactivation_alert_at DATETIME,
                created_by TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(pedido_id)
            )`
        );
        const autoReplyColumns = [
            ['template_variant', "ALTER TABLE hr_email_autoreply_schedules ADD COLUMN template_variant TEXT NOT NULL DEFAULT 'default'"],
            ['alternate_contact_email', 'ALTER TABLE hr_email_autoreply_schedules ADD COLUMN alternate_contact_email TEXT'],
            ['alternate_contact_phone', 'ALTER TABLE hr_email_autoreply_schedules ADD COLUMN alternate_contact_phone TEXT'],
            ['mode', "ALTER TABLE hr_email_autoreply_schedules ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual'"],
            ['manual_url', 'ALTER TABLE hr_email_autoreply_schedules ADD COLUMN manual_url TEXT'],
            ['activation_alert_at', 'ALTER TABLE hr_email_autoreply_schedules ADD COLUMN activation_alert_at DATETIME'],
            ['deactivation_alert_at', 'ALTER TABLE hr_email_autoreply_schedules ADD COLUMN deactivation_alert_at DATETIME'],
        ];
        for (const [column, ddl] of autoReplyColumns) {
            await ensureColumn('hr_email_autoreply_schedules', column, ddl);
        }
        await dbRunAsync(
            `CREATE TABLE IF NOT EXISTS hr_email_autoreply_logs (
                id TEXT PRIMARY KEY,
                schedule_id TEXT,
                action TEXT NOT NULL,
                status TEXT NOT NULL,
                message TEXT,
                command TEXT,
                details_json TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        );
        await dbRunAsync(
            `CREATE INDEX IF NOT EXISTS idx_hr_email_autoreply_due
             ON hr_email_autoreply_schedules(enabled, status, start_date, end_date, deactivate_date)`
        );
        await dbRunAsync(
            `CREATE INDEX IF NOT EXISTS idx_hr_email_autoreply_funcionario
             ON hr_email_autoreply_schedules(funcionario_id, start_date)`
        );
        await dbRunAsync(
            `CREATE INDEX IF NOT EXISTS idx_hr_email_autoreply_logs_schedule
             ON hr_email_autoreply_logs(schedule_id, created_at)`
        );
        schemaReady = true;
    }

    function normalizeDate(value) {
        const raw = String(value || '').trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
        if (!raw) return '';
        const parsed = new Date(raw);
        if (!Number.isFinite(parsed.getTime())) return '';
        return parsed.toISOString().slice(0, 10);
    }

    function normalizeStatus(value) {
        const raw = String(value || '').trim().toUpperCase();
        if (raw === 'APROVADO' || raw === 'REJEITADO' || raw === 'PENDENTE') return raw;
        if (raw.includes('APROV')) return 'APROVADO';
        if (raw.includes('REJE') || raw.includes('RECUS')) return 'REJEITADO';
        return 'PENDENTE';
    }

    function normalizeTipo(value) {
        const raw = String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return raw || 'OUTRO';
    }

    function normalizePontoTipo(value) {
        const raw = String(value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .trim()
            .toUpperCase();
        return raw === 'SAIDA' ? 'SAIDA' : 'ENTRADA';
    }

    function clampNumber(value, min = 0, max = 999999) {
        const number = Number(value);
        if (!Number.isFinite(number)) return min;
        return Math.max(min, Math.min(max, number));
    }

    function normalizeMetaTipo(value) {
        const raw = String(value || '').trim().toUpperCase();
        return raw === 'PERCENT' || raw === '%' ? 'PERCENT' : 'QTD';
    }

    function normalizeDateTime(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const parsed = new Date(raw);
        if (!Number.isFinite(parsed.getTime())) return '';
        return parsed.toISOString();
    }

    function normalizeBool(value) {
        if (typeof value === 'boolean') return value ? 1 : 0;
        const raw = String(value ?? '').trim().toLowerCase();
        if (!raw) return 0;
        return ['1', 'true', 'sim', 'yes', 'ativo', 'activa', 'activo'].includes(raw) ? 1 : 0;
    }

    function normalizeArrayJson(value) {
        if (Array.isArray(value)) return JSON.stringify(value.map((item) => String(item)).filter(Boolean));
        if (typeof value === 'string' && value.trim()) {
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed)) return JSON.stringify(parsed.map((item) => String(item)).filter(Boolean));
            } catch (_) {
                return JSON.stringify([value.trim()]);
            }
        }
        return null;
    }

    function parseArrayJson(value) {
        if (!value) return null;
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    function json(value) {
        return JSON.stringify(value || {});
    }

    function newId(prefix) {
        if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }

    async function resolveTable(requested, fallbacks) {
        const normalized = String(requested || '').trim();
        if (typeof resolveSupabaseTableName !== 'function') return normalized || fallbacks[0];
        return resolveSupabaseTableName(normalized || fallbacks[0], fallbacks);
    }

    async function fetchSupabaseRows(tableName) {
        if (!SUPABASE_URL || !SUPABASE_KEY) return [];
        if (typeof fetchSupabaseTable === 'function') {
            const rows = await fetchSupabaseTable(tableName);
            return Array.isArray(rows) ? rows : [];
        }
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${encodeURIComponent(tableName)}?select=*&limit=5000`, {
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        });
        if (!response.ok) throw new Error(`Falha ao ler ${tableName}: HTTP ${response.status}`);
        const rows = await response.json().catch(() => []);
        return Array.isArray(rows) ? rows : [];
    }

    async function patchSupabaseRow(tableName, idColumn, id, payload) {
        if (!SUPABASE_URL || !SUPABASE_KEY || !tableName || !id) return null;
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/${encodeURIComponent(tableName)}?${encodeURIComponent(idColumn)}=eq.${encodeURIComponent(id)}`,
            {
                method: 'PATCH',
                headers: {
                    apikey: SUPABASE_KEY,
                    Authorization: `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                    Prefer: 'return=representation',
                },
                body: JSON.stringify(payload),
            }
        );
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            const message = data?.message || data?.error || `HTTP ${response.status}`;
            throw new Error(`Falha ao atualizar Supabase (${tableName}): ${message}`);
        }
        return Array.isArray(data) ? data[0] || null : data;
    }

    async function upsertSupabaseRow(tableName, idColumn, payload) {
        if (!SUPABASE_URL || !SUPABASE_KEY || !tableName) return null;
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/${encodeURIComponent(tableName)}?on_conflict=${encodeURIComponent(idColumn)}`,
            {
                method: 'POST',
                headers: {
                    apikey: SUPABASE_KEY,
                    Authorization: `Bearer ${SUPABASE_KEY}`,
                    'Content-Type': 'application/json',
                    Prefer: 'resolution=merge-duplicates,return=representation',
                },
                body: JSON.stringify(payload),
            }
        );
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            const message = data?.message || data?.error || `HTTP ${response.status}`;
            throw new Error(`Falha ao gravar Supabase (${tableName}): ${message}`);
        }
        return Array.isArray(data) ? data[0] || null : data;
    }

    async function deleteSupabaseRow(tableName, idColumn, id) {
        if (!SUPABASE_URL || !SUPABASE_KEY || !tableName || !id) return;
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/${encodeURIComponent(tableName)}?${encodeURIComponent(idColumn)}=eq.${encodeURIComponent(id)}`,
            {
                method: 'DELETE',
                headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
            }
        );
        if (!response.ok) throw new Error(`Falha ao apagar Supabase (${tableName}): HTTP ${response.status}`);
    }

    function mapFuncionarioRow(row) {
        return {
            id: String(row.id || ''),
            userId: String(row.user_id || ''),
            nome: String(row.nome || row.name || ''),
            email: String(row.email || ''),
            telefone: String(row.telefone || row.phone || ''),
            pin: String(row.pin || ''),
            activo: Number(row.activo ?? row.ativo ?? 1) ? true : false,
            horarioTrabalho: String(row.horario_trabalho || ''),
            localTrabalho: String(row.local_trabalho || ''),
            dataNascimento: String(row.data_nascimento || ''),
            numeroColaborador: String(row.numero_colaborador || ''),
            nif: String(row.nif || ''),
            niss: String(row.niss || ''),
            cartaoCidadao: String(row.cartao_cidadao || ''),
            morada: String(row.morada || ''),
            codigoPostal: String(row.codigo_postal || ''),
            estadoCivil: String(row.estado_civil || ''),
            temFilhos: Number(row.tem_filhos || 0) ? true : false,
            numeroFilhos: Number(row.numero_filhos || 0),
            contactoEmergencia: String(row.contacto_emergencia || ''),
            iban: String(row.iban || ''),
            cargo: String(row.cargo || ''),
            responsavelDireto: String(row.responsavel_direto || ''),
            tipoVinculo: String(row.tipo_vinculo || ''),
            dataAdmissao: normalizeDate(row.data_admissao),
            dataSaida: normalizeDate(row.data_saida),
            observacoesInternas: String(row.observacoes_internas || ''),
            fotoUrl: String(row.foto_url || ''),
            estadoRh: String(row.estado_rh || ''),
            tipoHorario: String(row.tipo_horario || ''),
            horaEntradaPrevista: String(row.hora_entrada_prevista || ''),
            horaSaidaPrevista: String(row.hora_saida_prevista || ''),
            pausaAlmocoInicio: String(row.pausa_almoco_inicio || ''),
            pausaAlmocoFim: String(row.pausa_almoco_fim || ''),
            toleranciaEntradaMin: Number(row.tolerancia_entrada_min || 0),
            toleranciaSaidaMin: Number(row.tolerancia_saida_min || 0),
            horasDiariasPrevistas: Number(row.horas_diarias_previstas || 8),
            horasSemanaisContratadas: Number(row.horas_semanais_contratadas || 40),
            diasTrabalho: String(row.dias_trabalho || ''),
            objetivos: String(row.objetivos_json || ''),
            premioObjetivos: String(row.premio_objetivos || ''),
            supabaseCreatedAt: String(row.supabase_created_at || ''),
            supabaseUpdatedAt: String(row.supabase_updated_at || ''),
            updatedAt: String(row.updated_at || ''),
        };
    }

    async function resolveHrViewer(viewerUserId) {
        const id = String(viewerUserId || '').trim();
        if (!id) return { isManager: false, user: null, funcionarioId: '' };
        const user = await dbGetAsync('SELECT id, email, role FROM users WHERE id = ? LIMIT 1', [id]);
        if (!user?.id) return { isManager: false, user: { id }, funcionarioId: '' };
        const email = String(user?.email || '').trim().toLowerCase();
        const isManager = email === 'mpr@mpr.pt';
        let funcionarioId = '';
        if (email) {
            const funcionario = await dbGetAsync(
                'SELECT id FROM hr_funcionarios WHERE lower(email) = lower(?) LIMIT 1',
                [email]
            );
            funcionarioId = String(funcionario?.id || '').trim();
        }
        return { isManager, user, funcionarioId };
    }

    async function requirePedidosManager(actorUserId) {
        const viewer = await resolveHrViewer(actorUserId);
        if (!viewer.isManager) {
            const error = new Error('Só a conta mpr@mpr.pt pode aprovar, rejeitar ou editar pedidos.');
            error.statusCode = 403;
            throw error;
        }
        return viewer;
    }

    async function requireHrManager(actorUserId, message = 'Só a conta mpr@mpr.pt pode editar fichas dos funcionários.') {
        const viewer = await resolveHrViewer(actorUserId);
        if (!viewer.isManager) {
            const error = new Error(message);
            error.statusCode = 403;
            throw error;
        }
        return viewer;
    }

    function mapPedidoRow(row) {
        return {
            id: String(row.id || ''),
            funcionarioId: String(row.funcionario_id || row.atribuido_a || ''),
            atribuidoA: String(row.atribuido_a || ''),
            funcionarioNome: String(row.funcionario_nome || ''),
            tipo: normalizeTipo(row.tipo),
            descricao: String(row.descricao || ''),
            dataInicio: normalizeDate(row.data_inicio),
            dataFim: normalizeDate(row.data_fim || row.data_inicio),
            status: normalizeStatus(row.status),
            resolucao: String(row.resolucao || ''),
            createdAt: String(row.supabase_created_at || row.created_at || ''),
            updatedAt: String(row.supabase_updated_at || row.updated_at || ''),
        };
    }

    function normalizeEmail(value) {
        return String(value || '').trim().toLowerCase();
    }

    function normalizeAutoReplyStatus(value) {
        const raw = String(value || '').trim().toLowerCase();
        if (['active', 'ativo'].includes(raw)) return 'ativo';
        if (['disabled', 'desativado', 'inactive', 'off'].includes(raw)) return 'desativado';
        if (['error', 'erro'].includes(raw)) return 'erro';
        if (['scheduled', 'agendado', 'pending'].includes(raw)) return 'agendado';
        return 'manual_necessario';
    }

    function getAutoReplyMode() {
        const config = emailAutoReplyService.getConfig();
        return String(config.mode || 'manual').trim() || 'manual';
    }

    function getDefaultAutoReplyStatus() {
        return getAutoReplyMode() === 'manual' ? 'manual_necessario' : 'agendado';
    }

    function isVacationTipo(value) {
        return normalizeTipo(value).includes('FERIA');
    }

    function addDaysIso(value, days) {
        const normalized = normalizeDate(value);
        if (!normalized) return '';
        const date = new Date(`${normalized}T12:00:00Z`);
        date.setUTCDate(date.getUTCDate() + Number(days || 0));
        return date.toISOString().slice(0, 10);
    }

    function formatPtDate(value) {
        const normalized = normalizeDate(value);
        if (!normalized) return '';
        const [year, month, day] = normalized.split('-');
        return `${day}/${month}/${year}`;
    }

    function splitAlternateContact(value) {
        const raw = String(value || '').trim();
        if (!raw) return { email: 'geral@mpr.pt', phone: '+351 253 561 548' };
        const emailMatch = raw.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
        const phone = raw.replace(emailMatch?.[0] || '', '').replace(/\bou\b/gi, '').trim();
        return {
            email: emailMatch?.[0] || raw,
            phone,
        };
    }

    function buildDefaultAutoReplyMessage(input = {}) {
        return emailAutoReplyService.generate({
            funcionarioNome: input.funcionarioNome,
            email: input.email,
            startDate: input.startDate,
            endDate: input.endDate,
            alternateContactEmail: input.alternateContactEmail || splitAlternateContact(input.alternateContact).email,
            alternateContactPhone: input.alternateContactPhone || splitAlternateContact(input.alternateContact).phone,
            motivo: input.motivo,
            templateVariant: input.templateVariant,
            subject: input.subject,
        }).message;
    }

    function mapEmailAutoReplyScheduleRow(row) {
        if (!row) return null;
        return {
            id: String(row.id || ''),
            pedidoId: String(row.pedido_id || ''),
            funcionarioId: String(row.funcionario_id || ''),
            funcionarioNome: String(row.funcionario_nome || ''),
            email: String(row.email || ''),
            enabled: Boolean(Number(row.enabled || 0)),
            subject: String(row.subject || 'Ausência temporária'),
            message: String(row.message || ''),
            alternateContact: String(row.alternate_contact || ''),
            alternateContactEmail: String(row.alternate_contact_email || splitAlternateContact(row.alternate_contact).email || ''),
            alternateContactPhone: String(row.alternate_contact_phone || splitAlternateContact(row.alternate_contact).phone || ''),
            templateVariant: String(row.template_variant || 'default'),
            mode: String(row.mode || getAutoReplyMode()),
            manualUrl: String(row.manual_url || emailAutoReplyService.getConfig().manualUrl || ''),
            startDate: normalizeDate(row.start_date),
            endDate: normalizeDate(row.end_date),
            deactivateDate: normalizeDate(row.deactivate_date),
            status: normalizeAutoReplyStatus(row.status),
            lastAction: String(row.last_action || ''),
            lastError: String(row.last_error || ''),
            activatedAt: String(row.activated_at || ''),
            deactivatedAt: String(row.deactivated_at || ''),
            activationAlertAt: String(row.activation_alert_at || ''),
            deactivationAlertAt: String(row.deactivation_alert_at || ''),
            createdBy: String(row.created_by || ''),
            createdAt: String(row.created_at || ''),
            updatedAt: String(row.updated_at || ''),
        };
    }

    function mapEmailAutoReplyLogRow(row) {
        let details = null;
        try {
            details = row?.details_json ? JSON.parse(String(row.details_json)) : null;
        } catch (_) {
            details = null;
        }
        return {
            id: String(row?.id || ''),
            scheduleId: String(row?.schedule_id || ''),
            action: String(row?.action || ''),
            status: String(row?.status || ''),
            message: String(row?.message || ''),
            command: String(row?.command || ''),
            details,
            createdAt: String(row?.created_at || ''),
        };
    }

    async function logEmailAutoReply(scheduleId, action, status, message, details = {}) {
        await dbRunAsync(
            `INSERT INTO hr_email_autoreply_logs (
                id, schedule_id, action, status, message, command, details_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                newId('hr_email_autoreply_log'),
                String(scheduleId || ''),
                String(action || ''),
                String(status || ''),
                String(message || ''),
                String(details.command || details?.result?.command || ''),
                json(details),
            ]
        );
    }

    async function attachEmailAutoReplyLogs(rows) {
        const mapped = rows.map(mapEmailAutoReplyScheduleRow).filter(Boolean);
        if (mapped.length === 0) return [];
        const placeholders = mapped.map(() => '?').join(',');
        const logs = await dbAllAsync(
            `SELECT * FROM hr_email_autoreply_logs
             WHERE schedule_id IN (${placeholders})
             ORDER BY created_at DESC
             LIMIT 200`,
            mapped.map((row) => row.id)
        );
        const bySchedule = {};
        logs.map(mapEmailAutoReplyLogRow).forEach((log) => {
            if (!bySchedule[log.scheduleId]) bySchedule[log.scheduleId] = [];
            if (bySchedule[log.scheduleId].length < 8) bySchedule[log.scheduleId].push(log);
        });
        return mapped.map((row) => ({ ...row, logs: bySchedule[row.id] || [] }));
    }

    async function ensureEmailAutoReplySchedulesForApprovedVacations(funcionarioId, actorUserId = '') {
        const targetFuncionarioId = String(funcionarioId || '').trim();
        if (!targetFuncionarioId) return [];
        const rows = await dbAllAsync(
            `SELECT p.*, f.nome AS funcionario_nome, f.email AS funcionario_email
             FROM hr_pedidos p
             LEFT JOIN hr_funcionarios f ON f.id = COALESCE(NULLIF(p.funcionario_id, ''), p.atribuido_a)
             LEFT JOIN hr_email_autoreply_schedules s ON s.pedido_id = p.id
             WHERE COALESCE(NULLIF(p.funcionario_id, ''), p.atribuido_a) = ?
               AND p.status = 'APROVADO'
               AND s.id IS NULL`,
            [targetFuncionarioId]
        );
        const config = emailAutoReplyService.getConfig();
        const created = [];
        for (const pedido of rows.filter((row) => isVacationTipo(row.tipo))) {
            const startDate = normalizeDate(pedido.data_inicio);
            const endDate = normalizeDate(pedido.data_fim || pedido.data_inicio);
            const email = normalizeEmail(pedido.funcionario_email);
            if (!startDate || !endDate || !email) continue;
            const id = newId('hr_email_autoreply');
            const generated = emailAutoReplyService.generate({
                funcionarioNome: pedido.funcionario_nome,
                email,
                startDate,
                endDate,
                alternateContactEmail: 'geral@mpr.pt',
                alternateContactPhone: '+351 253 561 548',
                motivo: pedido.descricao || pedido.tipo || 'férias',
                templateVariant: 'default',
            });
            await dbRunAsync(
                `INSERT INTO hr_email_autoreply_schedules (
                    id, pedido_id, funcionario_id, funcionario_nome, email, enabled,
                    subject, message, alternate_contact, alternate_contact_email, alternate_contact_phone,
                    template_variant, mode, manual_url, start_date, end_date, deactivate_date,
                    status, last_action, last_error, created_by, updated_at
                 ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, CURRENT_TIMESTAMP)`,
                [
                    id,
                    String(pedido.id || ''),
                    targetFuncionarioId,
                    String(pedido.funcionario_nome || ''),
                    email,
                    generated.subject,
                    generated.message,
                    'geral@mpr.pt ou +351 253 561 548',
                    'geral@mpr.pt',
                    '+351 253 561 548',
                    generated.templateVariant,
                    config.mode,
                    config.manualUrl,
                    startDate,
                    endDate,
                    addDaysIso(endDate, 1),
                    getDefaultAutoReplyStatus(),
                    'aviso_gerado',
                    actorUserId || '',
                ]
            );
            await logEmailAutoReply(id, 'aviso_gerado', 'success', 'Aviso automático gerado a partir de férias aprovadas.', {
                pedidoId: String(pedido.id || ''),
                funcionarioId: targetFuncionarioId,
                mode: config.mode,
            });
            await logEmailAutoReply(id, 'alerta_ativacao_agendado', 'success', 'Alerta interno preparado para o início das férias.', {
                dueDate: startDate,
                mode: config.mode,
            });
            await logEmailAutoReply(id, 'alerta_desativacao_agendado', 'success', 'Alerta interno preparado para o fim das férias.', {
                dueDate: addDaysIso(endDate, 1),
                mode: config.mode,
            });
            created.push(id);
        }
        return created;
    }

    async function updateEmailAutoReplyStatus(id, payload = {}) {
        await dbRunAsync(
            `UPDATE hr_email_autoreply_schedules
             SET status = COALESCE(?, status),
                 last_action = COALESCE(?, last_action),
                 last_error = COALESCE(?, last_error),
                 activated_at = COALESCE(?, activated_at),
                 deactivated_at = COALESCE(?, deactivated_at),
                 activation_alert_at = COALESCE(?, activation_alert_at),
                 deactivation_alert_at = COALESCE(?, deactivation_alert_at),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
                payload.status ?? null,
                payload.lastAction ?? null,
                payload.lastError ?? null,
                payload.activatedAt ?? null,
                payload.deactivatedAt ?? null,
                payload.activationAlertAt ?? null,
                payload.deactivationAlertAt ?? null,
                id,
            ]
        );
    }

    async function applyEmailAutoReplySchedule(scheduleInput, action, source = 'manual') {
        const schedule = mapEmailAutoReplyScheduleRow(scheduleInput);
        if (!schedule?.id) throw new Error('Agendamento de resposta automática inválido.');
        const normalizedAction = action === 'deactivate' ? 'deactivate' : 'activate';
        const mode = getAutoReplyMode();
        try {
            const result = normalizedAction === 'activate'
                ? await emailAutoReplyService.enable({
                    email: schedule.email,
                    subject: schedule.subject,
                    message: schedule.message,
                    endDate: schedule.endDate,
                })
                : await emailAutoReplyService.disable({ email: schedule.email });

            if (mode === 'manual' || result?.manual) {
                const now = new Date().toISOString();
                await updateEmailAutoReplyStatus(schedule.id, {
                    status: normalizedAction === 'activate' ? 'manual_necessario' : 'ativo',
                    lastAction: normalizedAction === 'activate' ? 'alerta_ativacao_manual' : 'alerta_desativacao_manual',
                    lastError: '',
                    activationAlertAt: normalizedAction === 'activate' ? now : null,
                    deactivationAlertAt: normalizedAction === 'deactivate' ? now : null,
                });
                await logEmailAutoReply(
                    schedule.id,
                    normalizedAction === 'activate' ? 'alerta_ativacao_manual' : 'alerta_desativacao_manual',
                    'manual',
                    normalizedAction === 'activate'
                        ? 'Alerta interno criado: ativação manual necessária.'
                        : 'Alerta interno criado: desativação manual necessária.',
                    { source, result, mode }
                );
                return { ok: true, manual: true, result };
            }

            if (result?.dryRun) {
                const error = new Error(result.stderr || 'Integração Plesk em modo simulação/desativada. Ative HR_EMAIL_AUTOREPLY_ENABLED no servidor.');
                error.code = 'PLESK_AUTORESPONDER_DRY_RUN';
                error.result = result;
                throw error;
            }

            await updateEmailAutoReplyStatus(schedule.id, {
                status: normalizedAction === 'activate' ? 'ativo' : 'desativado',
                lastAction: normalizedAction,
                lastError: '',
                activatedAt: normalizedAction === 'activate' ? new Date().toISOString() : null,
                deactivatedAt: normalizedAction === 'deactivate' ? new Date().toISOString() : null,
            });
            await logEmailAutoReply(
                schedule.id,
                normalizedAction,
                'success',
                normalizedAction === 'activate' ? 'Auto-reply ativado no Plesk.' : 'Auto-reply desativado no Plesk.',
                { source, result }
            );
            return { ok: true, result };
        } catch (error) {
            const message = error?.message || String(error);
            await updateEmailAutoReplyStatus(schedule.id, {
                status: 'erro',
                lastAction: normalizedAction,
                lastError: message,
            });
            await logEmailAutoReply(schedule.id, normalizedAction, 'error', message, {
                source,
                code: error?.code || '',
                command: error?.command || error?.result?.command || '',
                stdout: error?.stdout || error?.result?.stdout || '',
                stderr: error?.stderr || error?.result?.stderr || '',
            });
            throw error;
        }
    }

    async function markEmailAutoReplyManual(scheduleInput, action, source = 'manual') {
        const schedule = mapEmailAutoReplyScheduleRow(scheduleInput);
        if (!schedule?.id) throw new Error('Agendamento de resposta automática inválido.');
        const normalizedAction = action === 'mark_deactivated' ? 'mark_deactivated' : 'mark_activated';
        const now = new Date().toISOString();
        await updateEmailAutoReplyStatus(schedule.id, {
            status: normalizedAction === 'mark_activated' ? 'ativo' : 'desativado',
            lastAction: normalizedAction,
            lastError: '',
            activatedAt: normalizedAction === 'mark_activated' ? now : null,
            deactivatedAt: normalizedAction === 'mark_deactivated' ? now : null,
        });
        await logEmailAutoReply(
            schedule.id,
            normalizedAction,
            'success',
            normalizedAction === 'mark_activated'
                ? 'Marcado como ativado manualmente.'
                : 'Marcado como desativado manualmente.',
            { source, mode: getAutoReplyMode() }
        );
    }

    function getLocalDateTimeParts(timeZone = 'Europe/Lisbon', date = new Date()) {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).formatToParts(date);
        const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        const hour = map.hour === '24' ? '00' : map.hour;
        return {
            date: `${map.year}-${map.month}-${map.day}`,
            hour: Number(hour || 0),
            minute: Number(map.minute || 0),
        };
    }

    async function syncDueEmailAutoReplies({ actor = 'scheduler', todayIso } = {}) {
        await ensureHrSchema();
        const today = normalizeDate(todayIso) || getLocalDateTimeParts(process.env.HR_EMAIL_AUTOREPLY_TIMEZONE || 'Europe/Lisbon').date;
        const summary = { today, activated: [], deactivated: [], errors: [], skipped: [] };
        const vacationFuncionarios = await dbAllAsync(
            `SELECT DISTINCT COALESCE(NULLIF(funcionario_id, ''), atribuido_a) AS funcionario_id
             FROM hr_pedidos
             WHERE status = 'APROVADO'`
        );
        for (const row of vacationFuncionarios) {
            await ensureEmailAutoReplySchedulesForApprovedVacations(String(row.funcionario_id || ''), actor);
        }

        const deactivateRows = await dbAllAsync(
            `SELECT * FROM hr_email_autoreply_schedules
             WHERE enabled = 1
               AND status = 'ativo'
               AND date(deactivate_date) <= date(?)
               AND deactivation_alert_at IS NULL
             ORDER BY deactivate_date ASC, updated_at ASC`,
            [today]
        );
        for (const row of deactivateRows) {
            try {
                await applyEmailAutoReplySchedule(row, 'deactivate', actor);
                summary.deactivated.push(String(row.id || ''));
            } catch (error) {
                summary.errors.push({ id: String(row.id || ''), action: 'deactivate', error: error?.message || String(error) });
            }
        }

        const activateRows = await dbAllAsync(
            `SELECT * FROM hr_email_autoreply_schedules
             WHERE enabled = 1
               AND status IN ('manual_necessario', 'agendado', 'erro')
               AND date(start_date) <= date(?)
               AND date(end_date) >= date(?)
               AND activation_alert_at IS NULL
             ORDER BY start_date ASC, updated_at ASC`,
            [today, today]
        );
        for (const row of activateRows) {
            try {
                await applyEmailAutoReplySchedule(row, 'activate', actor);
                summary.activated.push(String(row.id || ''));
            } catch (error) {
                summary.errors.push({ id: String(row.id || ''), action: 'activate', error: error?.message || String(error) });
            }
        }

        const missedRows = await dbAllAsync(
            `SELECT id FROM hr_email_autoreply_schedules
             WHERE enabled = 1
               AND status IN ('manual_necessario', 'agendado', 'erro')
               AND date(end_date) < date(?)`,
            [today]
        );
        for (const row of missedRows) {
            await updateEmailAutoReplyStatus(String(row.id || ''), {
                status: 'desativado',
                lastAction: 'skip',
                lastError: '',
                deactivatedAt: new Date().toISOString(),
            });
            await logEmailAutoReply(String(row.id || ''), 'skip', 'success', 'Período de férias já terminou antes da ativação.', { source: actor, today });
            summary.skipped.push(String(row.id || ''));
        }

        return { ...summary, config: emailAutoReplyService.getConfig() };
    }

    function startEmailAutoReplyScheduler() {
        if (emailAutoReplySchedulerStarted) return;
        const schedulerEnabled = String(process.env.HR_EMAIL_AUTOREPLY_SCHEDULER_ENABLED || '1').trim() !== '0';
        if (!schedulerEnabled) return;
        emailAutoReplySchedulerStarted = true;
        const timeZone = process.env.HR_EMAIL_AUTOREPLY_TIMEZONE || 'Europe/Lisbon';
        const targetHour = Math.max(0, Math.min(23, Number(process.env.HR_EMAIL_AUTOREPLY_HOUR || 0) || 0));
        const targetMinute = Math.max(0, Math.min(59, Number(process.env.HR_EMAIL_AUTOREPLY_MINUTE || 5) || 5));
        const tick = async () => {
            const now = getLocalDateTimeParts(timeZone);
            const dueToday = now.hour > targetHour || (now.hour === targetHour && now.minute >= targetMinute);
            if (!dueToday || emailAutoReplySchedulerLastRun === now.date) return;
            emailAutoReplySchedulerLastRun = now.date;
            try {
                await syncDueEmailAutoReplies({ actor: 'scheduler', todayIso: now.date });
            } catch (error) {
                console.error?.('[HR AutoReply] Falha no agendamento diário', error);
            }
        };
        setTimeout(() => void tick(), 5000);
        setInterval(() => void tick(), 5 * 60 * 1000);
    }

    function mapRegistoPontoRow(row) {
        return {
            id: String(row.id || ''),
            funcionarioId: String(row.funcionario_id || ''),
            funcionarioNome: String(row.funcionario_nome || ''),
            tipo: String(row.tipo || '').toUpperCase(),
            momento: String(row.momento || ''),
            origem: String(row.origem || ''),
        };
    }

    function mapObjetivoRow(row) {
        return {
            id: String(row.id || ''),
            funcionarioId: String(row.funcionario_id || ''),
            titulo: String(row.titulo || ''),
            deadline: normalizeDate(row.deadline),
            metaTipo: normalizeMetaTipo(row.meta_tipo),
            meta: Number(row.meta || 0),
            atingido: Number(row.atingido || 0),
            peso: Number(row.peso || 0),
            erros: Number(row.erros || 0),
            ordem: Number(row.ordem || 0),
        };
    }

    function mapObjetivoConfigRow(row) {
        return {
            funcionarioId: String(row?.funcionario_id || ''),
            patamar50: String(row?.patamar_50 || ''),
            patamar65: String(row?.patamar_65 || ''),
            patamar80: String(row?.patamar_80 || ''),
            premioMaximo: Number(row?.premio_maximo || 0),
            notasGerais: String(row?.notas_gerais || ''),
        };
    }

    function parseObjetivosPayload(rawObjetivos, rawPremio) {
        const fallbackConfig = {
            patamar50: '',
            patamar65: '',
            patamar80: String(rawPremio || ''),
            premioMaximo: 0,
            notasGerais: '',
        };
        const text = String(rawObjetivos || '').trim();
        if (!text) return { items: [], config: fallbackConfig };
        try {
            const parsed = JSON.parse(text);
            const rawItems = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed?.objetivos) ? parsed.objetivos : [];
            const rawConfig = parsed?.recompensa || {};
            return {
                items: rawItems.map((item, index) => ({
                    id: String(item?.id || newId('obj')),
                    titulo: String(item?.titulo || item?.title || item?.objetivo || '').trim(),
                    deadline: normalizeDate(item?.deadline || item?.data || item?.date),
                    metaTipo: normalizeMetaTipo(item?.metaTipo || item?.meta_tipo || item?.unidade_meta),
                    meta: clampNumber(item?.meta ?? item?.target, 0),
                    atingido: clampNumber(item?.atingido ?? item?.valorAtingido ?? item?.achieved, 0),
                    peso: clampNumber(item?.peso ?? item?.weight, 0, 100),
                    erros: Math.round(clampNumber(item?.erros, 0, 999)),
                    ordem: index,
                })).filter((item) => item.titulo),
                config: {
                    patamar50: String(rawConfig?.patamar50 || ''),
                    patamar65: String(rawConfig?.patamar65 || rawConfig?.recompensa80 || ''),
                    patamar80: String(rawConfig?.patamar80 || rawConfig?.recompensa100 || rawPremio || ''),
                    premioMaximo: clampNumber(rawConfig?.premioMaximo, 0),
                    notasGerais: String(rawConfig?.notasGerais || ''),
                },
            };
        } catch (_) {
            return {
                items: [{ id: newId('obj'), titulo: text, deadline: '', metaTipo: 'QTD', meta: 1, atingido: 0, peso: 100, erros: 0, ordem: 0 }],
                config: fallbackConfig,
            };
        }
    }

    async function seedObjetivosFromFuncionario(funcionarioId) {
        const existing = await dbGetAsync('SELECT COUNT(*) AS total FROM hr_objetivos WHERE funcionario_id = ?', [funcionarioId]);
        if (Number(existing?.total || 0) > 0) return;
        const funcionario = await dbGetAsync('SELECT objetivos_json, premio_objetivos FROM hr_funcionarios WHERE id = ? LIMIT 1', [funcionarioId]);
        if (!funcionario) return;
        const parsed = parseObjetivosPayload(funcionario.objetivos_json, funcionario.premio_objetivos);
        for (const item of parsed.items) {
            await dbRunAsync(
                `INSERT OR IGNORE INTO hr_objetivos (id, funcionario_id, titulo, deadline, meta_tipo, meta, atingido, peso, erros, ordem, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [item.id, funcionarioId, item.titulo, item.deadline, item.metaTipo, item.meta, item.atingido, item.peso, item.erros, item.ordem]
            );
        }
        if (parsed.items.length || parsed.config.patamar50 || parsed.config.patamar65 || parsed.config.patamar80 || parsed.config.premioMaximo || parsed.config.notasGerais) {
            await dbRunAsync(
                `INSERT INTO hr_objetivos_config (funcionario_id, patamar_50, patamar_65, patamar_80, premio_maximo, notas_gerais, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(funcionario_id) DO NOTHING`,
                [funcionarioId, parsed.config.patamar50, parsed.config.patamar65, parsed.config.patamar80, parsed.config.premioMaximo, parsed.config.notasGerais]
            );
        }
    }

    async function replaceObjetivos(funcionarioId, items, config) {
        await dbRunAsync('DELETE FROM hr_objetivos WHERE funcionario_id = ?', [funcionarioId]);
        const normalized = (Array.isArray(items) ? items : [])
            .map((item, index) => ({
                id: String(item?.id || newId('obj')),
                titulo: String(item?.titulo || '').trim(),
                deadline: normalizeDate(item?.deadline),
                metaTipo: normalizeMetaTipo(item?.metaTipo),
                meta: clampNumber(item?.meta, 0),
                atingido: clampNumber(item?.atingido, 0),
                peso: clampNumber(item?.peso, 0, 100),
                erros: Math.round(clampNumber(item?.erros, 0, 999)),
                ordem: index,
            }))
            .filter((item) => item.titulo);
        for (const item of normalized) {
            await dbRunAsync(
                `INSERT INTO hr_objetivos (id, funcionario_id, titulo, deadline, meta_tipo, meta, atingido, peso, erros, ordem, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [item.id, funcionarioId, item.titulo, item.deadline, item.metaTipo, item.meta, item.atingido, item.peso, item.erros, item.ordem]
            );
        }
        await dbRunAsync(
            `INSERT INTO hr_objetivos_config (funcionario_id, patamar_50, patamar_65, patamar_80, premio_maximo, notas_gerais, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(funcionario_id) DO UPDATE SET
                patamar_50 = excluded.patamar_50,
                patamar_65 = excluded.patamar_65,
                patamar_80 = excluded.patamar_80,
                premio_maximo = excluded.premio_maximo,
                notas_gerais = excluded.notas_gerais,
                updated_at = CURRENT_TIMESTAMP`,
            [
                funcionarioId,
                String(config?.patamar50 || ''),
                String(config?.patamar65 || ''),
                String(config?.patamar80 || ''),
                clampNumber(config?.premioMaximo, 0),
                String(config?.notasGerais || ''),
            ]
        );
        const storagePayload = JSON.stringify({
            version: 6,
            items: normalized,
            recompensa: {
                patamar50: String(config?.patamar50 || ''),
                patamar65: String(config?.patamar65 || ''),
                patamar80: String(config?.patamar80 || ''),
                premioMaximo: clampNumber(config?.premioMaximo, 0),
                notasGerais: String(config?.notasGerais || ''),
            },
        });
        await dbRunAsync(
            `UPDATE hr_funcionarios SET objetivos_json = ?, premio_objetivos = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [storagePayload, `Patamares | 50%: ${String(config?.patamar50 || '')} | 65%: ${String(config?.patamar65 || '')} | 80%: ${String(config?.patamar80 || '')} | Premio maximo: ${clampNumber(config?.premioMaximo, 0)} EUR`, funcionarioId]
        );
    }

    function mapSaldoRow(row) {
        return {
            id: String(row.id || ''),
            funcionarioId: String(row.funcionario_id || ''),
            ano: Number(row.ano || new Date().getFullYear()),
            diasDireito: Number(row.dias_direito || 0),
            diasExtra: Number(row.dias_extra || 0),
            diasUsadosManual: Number(row.dias_usados_manual || 0),
            observacoes: String(row.observacoes || ''),
        };
    }

    async function syncFromSupabase() {
        await ensureHrSchema();
        if (!SUPABASE_URL || !SUPABASE_KEY) {
            const error = new Error('Supabase não configurado.');
            error.statusCode = 400;
            throw error;
        }

        const tables = {
            funcionarios: await resolveTable(SUPABASE_FUNCIONARIOS_SOURCE || 'funcionarios', ['public.funcionarios', 'funcionarios']),
            pedidos: await resolveTable(process.env.SUPABASE_PEDIDOS_SOURCE || 'pedidos', ['public.pedidos', 'pedidos']),
            registos: await resolveTable(process.env.SUPABASE_REGISTOS_PONTO_SOURCE || 'registos_ponto', ['public.registos_ponto', 'registos_ponto']),
            holidays: await resolveTable(process.env.SUPABASE_HOLIDAYS_SOURCE || 'holidays', ['public.holidays', 'holidays']),
            saldos: await resolveTable(process.env.SUPABASE_FERIAS_SALDOS_SOURCE || 'ferias_saldos', ['public.ferias_saldos', 'ferias_saldos']),
            periodos: await resolveTable(process.env.SUPABASE_FERIAS_EMPRESA_PERIODOS_SOURCE || 'ferias_empresa_periodos', ['public.ferias_empresa_periodos', 'ferias_empresa_periodos']),
        };

        const [funcionarios, pedidos, registos, holidays, saldos, periodos] = await Promise.all([
            fetchSupabaseRows(tables.funcionarios),
            fetchSupabaseRows(tables.pedidos),
            fetchSupabaseRows(tables.registos),
            fetchSupabaseRows(tables.holidays),
            fetchSupabaseRows(tables.saldos),
            fetchSupabaseRows(tables.periodos),
        ]);

        for (const row of funcionarios) {
            const id = String(row?.id || '').trim();
            const nome = String(row?.nome || row?.name || '').trim();
            if (!id || !nome) continue;
            await dbRunAsync(
                `INSERT INTO hr_funcionarios (
                    id, user_id, nome, email, telefone, pin, activo, horario_trabalho, local_trabalho,
                    data_nascimento, objetivos_json, premio_objetivos, supabase_payload_json,
                    supabase_created_at, supabase_updated_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(id) DO UPDATE SET
                    user_id = excluded.user_id,
                    nome = excluded.nome,
                    email = excluded.email,
                    telefone = excluded.telefone,
                    pin = excluded.pin,
                    activo = excluded.activo,
                    horario_trabalho = excluded.horario_trabalho,
                    local_trabalho = excluded.local_trabalho,
                    data_nascimento = excluded.data_nascimento,
                    objetivos_json = excluded.objetivos_json,
                    premio_objetivos = excluded.premio_objetivos,
                    supabase_payload_json = excluded.supabase_payload_json,
                    supabase_created_at = excluded.supabase_created_at,
                    supabase_updated_at = excluded.supabase_updated_at,
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    id,
                    String(row.user_id || ''),
                    nome,
                    String(row.email || ''),
                    String(row.telefone || row.phone || ''),
                    String(row.pin || ''),
                    normalizeBool(row.activo ?? row.ativo ?? true),
                    String(row.horario_trabalho || ''),
                    String(row.local_trabalho || ''),
                    normalizeDate(row.data_nascimento),
                    typeof row.objetivos === 'string' ? row.objetivos : row.objetivos ? JSON.stringify(row.objetivos) : '',
                    String(row.premio_objetivos || ''),
                    json(row),
                    String(row.created_at || ''),
                    String(row.updated_at || ''),
                ]
            );
        }

        for (const row of pedidos) {
            const id = String(row?.id || '').trim();
            if (!id) continue;
            await dbRunAsync(
                `INSERT INTO hr_pedidos (
                    id, funcionario_id, atribuido_a, tipo, descricao, data_inicio, data_fim, status,
                    resolucao, supabase_payload_json, supabase_created_at, supabase_updated_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(id) DO UPDATE SET
                    funcionario_id = excluded.funcionario_id,
                    atribuido_a = excluded.atribuido_a,
                    tipo = excluded.tipo,
                    descricao = excluded.descricao,
                    data_inicio = excluded.data_inicio,
                    data_fim = excluded.data_fim,
                    status = excluded.status,
                    resolucao = excluded.resolucao,
                    supabase_payload_json = excluded.supabase_payload_json,
                    supabase_created_at = excluded.supabase_created_at,
                    supabase_updated_at = excluded.supabase_updated_at,
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    id,
                    String(row.funcionario_id || row.atribuido_a || ''),
                    String(row.atribuido_a || ''),
                    normalizeTipo(row.tipo),
                    String(row.descricao || ''),
                    normalizeDate(row.data_inicio),
                    normalizeDate(row.data_fim || row.data_inicio),
                    normalizeStatus(row.status),
                    String(row.resolucao || ''),
                    json(row),
                    String(row.created_at || ''),
                    String(row.updated_at || ''),
                ]
            );
        }

        for (const row of registos) {
            const id = String(row?.id || '').trim();
            const funcionarioId = String(row?.funcionario_id || row?.atribuido_a || '').trim();
            const momento = String(row?.momento || row?.timestamp || '').trim();
            if (!id || !funcionarioId || !momento) continue;
            await dbRunAsync(
                `INSERT INTO hr_registos_ponto (id, funcionario_id, tipo, momento, origem, supabase_payload_json, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(id) DO UPDATE SET
                    funcionario_id = excluded.funcionario_id,
                    tipo = excluded.tipo,
                    momento = excluded.momento,
                    origem = excluded.origem,
                    supabase_payload_json = excluded.supabase_payload_json,
                    updated_at = CURRENT_TIMESTAMP`,
                [id, funcionarioId, String(row.tipo || '').toUpperCase(), momento, String(row.origem || ''), json(row)]
            );
        }

        for (const row of holidays) {
            const date = normalizeDate(row?.date || row?.data);
            const name = String(row?.name || row?.nome || '').trim();
            if (!date || !name) continue;
            await dbRunAsync(
                `INSERT INTO hr_holidays (date, name, region, supabase_payload_json, updated_at)
                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(date) DO UPDATE SET
                    name = excluded.name,
                    region = excluded.region,
                    supabase_payload_json = excluded.supabase_payload_json,
                    updated_at = CURRENT_TIMESTAMP`,
                [date, name, String(row.region || ''), json(row)]
            );
        }

        for (const row of saldos) {
            const id = String(row?.id || '').trim() || newId('saldo');
            const funcionarioId = String(row?.funcionario_id || '').trim();
            const ano = Number(row?.ano || new Date().getFullYear());
            if (!funcionarioId || !Number.isFinite(ano)) continue;
            await dbRunAsync(
                `INSERT INTO hr_ferias_saldos (
                    id, funcionario_id, ano, dias_direito, dias_extra, dias_usados_manual,
                    observacoes, supabase_payload_json, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(funcionario_id, ano) DO UPDATE SET
                    dias_direito = excluded.dias_direito,
                    dias_extra = excluded.dias_extra,
                    dias_usados_manual = excluded.dias_usados_manual,
                    observacoes = excluded.observacoes,
                    supabase_payload_json = excluded.supabase_payload_json,
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    id,
                    funcionarioId,
                    ano,
                    Number(row.dias_direito ?? 22) || 22,
                    Number(row.dias_extra ?? 0) || 0,
                    Number(row.dias_usados_manual ?? 0) || 0,
                    String(row.observacoes || ''),
                    json(row),
                ]
            );
        }

        for (const row of periodos) {
            const id = String(row?.id || '').trim();
            if (!id) continue;
            await dbRunAsync(
                `INSERT INTO hr_ferias_empresa_periodos (
                    id, titulo, descricao, data_inicio, data_fim, funcionarios_alvo_json,
                    created_by, supabase_payload_json, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(id) DO UPDATE SET
                    titulo = excluded.titulo,
                    descricao = excluded.descricao,
                    data_inicio = excluded.data_inicio,
                    data_fim = excluded.data_fim,
                    funcionarios_alvo_json = excluded.funcionarios_alvo_json,
                    created_by = excluded.created_by,
                    supabase_payload_json = excluded.supabase_payload_json,
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    id,
                    String(row.titulo || 'Férias da Empresa'),
                    String(row.descricao || ''),
                    normalizeDate(row.data_inicio),
                    normalizeDate(row.data_fim),
                    normalizeArrayJson(row.funcionarios_alvo),
                    String(row.created_by || ''),
                    json(row),
                ]
            );
        }

        const funcionariosLocais = await dbAllAsync('SELECT id FROM hr_funcionarios');
        for (const funcionario of funcionariosLocais) {
            await seedObjetivosFromFuncionario(String(funcionario.id || ''));
        }

        await dbRunAsync(
            `INSERT INTO sync_state (key, value, updated_at)
             VALUES ('hr_supabase_last_sync', ?, CURRENT_TIMESTAMP)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
            [nowIso()]
        );

        return {
            tables,
            counts: {
                funcionarios: funcionarios.length,
                pedidos: pedidos.length,
                registosPonto: registos.length,
                holidays: holidays.length,
                feriasSaldos: saldos.length,
                feriasEmpresaPeriodos: periodos.length,
            },
        };
    }

    app.post('/api/hr/sync', async (req, res) => {
        try {
            const summary = await syncFromSupabase();
            return res.json({ success: true, summary });
        } catch (error) {
            const statusCode = Number(error?.statusCode || 500) || 500;
            return res.status(statusCode).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.get('/api/hr/summary', async (req, res) => {
        try {
            await ensureHrSchema();
            const viewer = await resolveHrViewer(req.query.viewerUserId);
            const pedidosWhere = viewer.user && !viewer.isManager
                ? 'WHERE COALESCE(NULLIF(funcionario_id, \'\'), atribuido_a) = ?'
                : '';
            const pedidosArgs = viewer.user && !viewer.isManager ? [viewer.funcionarioId || '__none__'] : [];
            const funcionariosSql = viewer.user && !viewer.isManager
                ? 'SELECT COUNT(*) AS total FROM hr_funcionarios WHERE id = ?'
                : 'SELECT COUNT(*) AS total FROM hr_funcionarios';
            const funcionariosArgs = viewer.user && !viewer.isManager ? [viewer.funcionarioId || '__none__'] : [];
            const pontoSql = viewer.user && !viewer.isManager
                ? 'SELECT COUNT(*) AS total FROM hr_registos_ponto WHERE funcionario_id = ?'
                : 'SELECT COUNT(*) AS total FROM hr_registos_ponto';
            const pontoArgs = viewer.user && !viewer.isManager ? [viewer.funcionarioId || '__none__'] : [];
            const [funcionarios, pedidos, ponto, lastSync] = await Promise.all([
                dbGetAsync(funcionariosSql, funcionariosArgs),
                dbAllAsync(`SELECT status, COUNT(*) AS total FROM hr_pedidos ${pedidosWhere} GROUP BY status`, pedidosArgs),
                dbGetAsync(pontoSql, pontoArgs),
                dbGetAsync("SELECT value FROM sync_state WHERE key = 'hr_supabase_last_sync' LIMIT 1"),
            ]);
            return res.json({
                success: true,
                data: {
                    funcionarios: Number(funcionarios?.total || 0),
                    pedidos: pedidos.reduce((acc, row) => ({ ...acc, [normalizeStatus(row.status)]: Number(row.total || 0) }), {}),
                    registosPonto: Number(ponto?.total || 0),
                    lastSync: String(lastSync?.value || ''),
                },
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.get('/api/hr/funcionarios', async (req, res) => {
        try {
            await ensureHrSchema();
            const viewer = await resolveHrViewer(req.query.viewerUserId);
            const rows = viewer.user && !viewer.isManager
                ? await dbAllAsync('SELECT * FROM hr_funcionarios WHERE id = ? ORDER BY nome COLLATE NOCASE ASC', [viewer.funcionarioId || '__none__'])
                : await dbAllAsync('SELECT * FROM hr_funcionarios ORDER BY nome COLLATE NOCASE ASC');
            return res.json({ success: true, data: rows.map(mapFuncionarioRow) });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.patch('/api/hr/funcionarios/:id', async (req, res) => {
        try {
            await ensureHrSchema();
            await requireHrManager(req.body?.actorUserId, 'Só a conta mpr@mpr.pt pode gerir picagens de ponto.');
            const id = String(req.params.id || '').trim();
            const payload = {
                nome: String(req.body?.nome || '').trim(),
                email: String(req.body?.email || '').trim(),
                telefone: String(req.body?.telefone || '').trim(),
                pin: String(req.body?.pin || '').trim(),
                activo: normalizeBool(req.body?.activo),
                horario_trabalho: String(req.body?.horarioTrabalho || '').trim(),
                local_trabalho: String(req.body?.localTrabalho || '').trim(),
                data_nascimento: normalizeDate(req.body?.dataNascimento),
                numero_colaborador: String(req.body?.numeroColaborador || '').trim(),
                nif: String(req.body?.nif || '').trim(),
                niss: String(req.body?.niss || '').trim(),
                cartao_cidadao: String(req.body?.cartaoCidadao || '').trim(),
                morada: String(req.body?.morada || '').trim(),
                codigo_postal: String(req.body?.codigoPostal || '').trim(),
                estado_civil: String(req.body?.estadoCivil || '').trim(),
                tem_filhos: normalizeBool(req.body?.temFilhos),
                numero_filhos: Math.max(0, Math.round(Number(req.body?.numeroFilhos || 0) || 0)),
                contacto_emergencia: String(req.body?.contactoEmergencia || '').trim(),
                iban: String(req.body?.iban || '').trim(),
                cargo: String(req.body?.cargo || '').trim(),
                responsavel_direto: String(req.body?.responsavelDireto || '').trim(),
                tipo_vinculo: String(req.body?.tipoVinculo || '').trim(),
                data_admissao: normalizeDate(req.body?.dataAdmissao),
                data_saida: normalizeDate(req.body?.dataSaida),
                observacoes_internas: String(req.body?.observacoesInternas || '').trim(),
                foto_url: String(req.body?.fotoUrl || '').trim(),
                estado_rh: String(req.body?.estadoRh || '').trim(),
                tipo_horario: String(req.body?.tipoHorario || '').trim(),
                hora_entrada_prevista: String(req.body?.horaEntradaPrevista || '').trim(),
                hora_saida_prevista: String(req.body?.horaSaidaPrevista || '').trim(),
                pausa_almoco_inicio: String(req.body?.pausaAlmocoInicio || '').trim(),
                pausa_almoco_fim: String(req.body?.pausaAlmocoFim || '').trim(),
                tolerancia_entrada_min: Math.max(0, Math.round(Number(req.body?.toleranciaEntradaMin || 0) || 0)),
                tolerancia_saida_min: Math.max(0, Math.round(Number(req.body?.toleranciaSaidaMin || 0) || 0)),
                horas_diarias_previstas: Math.max(0, Number(req.body?.horasDiariasPrevistas || 8) || 0),
                horas_semanais_contratadas: Math.max(0, Number(req.body?.horasSemanaisContratadas || 40) || 0),
                dias_trabalho: String(req.body?.diasTrabalho || '').trim(),
            };
            if (!id || !payload.nome) return res.status(400).json({ success: false, error: 'ID e nome são obrigatórios.' });
            await dbRunAsync(
                `UPDATE hr_funcionarios
                 SET nome = ?, email = ?, telefone = ?, pin = ?, activo = ?, horario_trabalho = ?,
                     local_trabalho = ?, data_nascimento = ?, numero_colaborador = ?, nif = ?, niss = ?,
                     cartao_cidadao = ?, morada = ?, codigo_postal = ?, estado_civil = ?, tem_filhos = ?,
                     numero_filhos = ?, contacto_emergencia = ?, iban = ?, cargo = ?, responsavel_direto = ?,
                     tipo_vinculo = ?, data_admissao = ?, data_saida = ?, observacoes_internas = ?, foto_url = ?,
                     estado_rh = ?, tipo_horario = ?, hora_entrada_prevista = ?, hora_saida_prevista = ?,
                     pausa_almoco_inicio = ?, pausa_almoco_fim = ?, tolerancia_entrada_min = ?, tolerancia_saida_min = ?,
                     horas_diarias_previstas = ?, horas_semanais_contratadas = ?, dias_trabalho = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [
                    payload.nome,
                    payload.email,
                    payload.telefone,
                    payload.pin,
                    payload.activo,
                    payload.horario_trabalho,
                    payload.local_trabalho,
                    payload.data_nascimento,
                    payload.numero_colaborador,
                    payload.nif,
                    payload.niss,
                    payload.cartao_cidadao,
                    payload.morada,
                    payload.codigo_postal,
                    payload.estado_civil,
                    payload.tem_filhos,
                    payload.numero_filhos,
                    payload.contacto_emergencia,
                    payload.iban,
                    payload.cargo,
                    payload.responsavel_direto,
                    payload.tipo_vinculo,
                    payload.data_admissao,
                    payload.data_saida,
                    payload.observacoes_internas,
                    payload.foto_url,
                    payload.estado_rh,
                    payload.tipo_horario,
                    payload.hora_entrada_prevista,
                    payload.hora_saida_prevista,
                    payload.pausa_almoco_inicio,
                    payload.pausa_almoco_fim,
                    payload.tolerancia_entrada_min,
                    payload.tolerancia_saida_min,
                    payload.horas_diarias_previstas,
                    payload.horas_semanais_contratadas,
                    payload.dias_trabalho,
                    id,
                ]
            );
            await writeAuditLog?.({ entityType: 'hr_funcionario', entityId: id, action: 'update', details: { storage: 'local' } });
            const row = await dbGetAsync('SELECT * FROM hr_funcionarios WHERE id = ? LIMIT 1', [id]);
            return res.json({ success: true, data: mapFuncionarioRow(row) });
        } catch (error) {
            const statusCode = Number(error?.statusCode || 500) || 500;
            return res.status(statusCode).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.get('/api/hr/pedidos', async (req, res) => {
        try {
            await ensureHrSchema();
            const viewer = await resolveHrViewer(req.query.viewerUserId);
            const where = [];
            const args = [];
            if (viewer.user && !viewer.isManager) {
                where.push('COALESCE(NULLIF(p.funcionario_id, \'\'), p.atribuido_a) = ?');
                args.push(viewer.funcionarioId || '__none__');
            }
            if (req.query.status) {
                where.push('p.status = ?');
                args.push(normalizeStatus(req.query.status));
            }
            if (req.query.funcionarioId) {
                const requestedFuncionarioId = String(req.query.funcionarioId);
                if (!viewer.user || viewer.isManager || requestedFuncionarioId === viewer.funcionarioId) {
                    where.push('COALESCE(NULLIF(p.funcionario_id, \'\'), p.atribuido_a) = ?');
                    args.push(requestedFuncionarioId);
                }
            }
            if (req.query.year) {
                where.push("strftime('%Y', COALESCE(NULLIF(p.data_inicio, ''), p.supabase_created_at, p.created_at)) = ?");
                args.push(String(req.query.year));
            }
            const sql = `
                SELECT p.*, f.nome AS funcionario_nome
                FROM hr_pedidos p
                LEFT JOIN hr_funcionarios f ON f.id = COALESCE(NULLIF(p.funcionario_id, ''), p.atribuido_a)
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY COALESCE(NULLIF(p.data_inicio, ''), p.supabase_created_at, p.created_at) DESC`;
            const rows = await dbAllAsync(sql, args);
            return res.json({ success: true, data: rows.map(mapPedidoRow) });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.get('/api/hr/registos-ponto', async (req, res) => {
        try {
            await ensureHrSchema();
            const viewer = await resolveHrViewer(req.query.viewerUserId);
            const where = [];
            const args = [];
            if (viewer.user && !viewer.isManager) {
                where.push('r.funcionario_id = ?');
                args.push(viewer.funcionarioId || '__none__');
            }
            if (req.query.funcionarioId) {
                const requestedFuncionarioId = String(req.query.funcionarioId);
                if (!viewer.user || viewer.isManager || requestedFuncionarioId === viewer.funcionarioId) {
                    where.push('r.funcionario_id = ?');
                    args.push(requestedFuncionarioId);
                }
            }
            if (req.query.year) {
                where.push("strftime('%Y', r.momento) = ?");
                args.push(String(req.query.year));
            }
            if (req.query.startDate) {
                where.push("date(r.momento) >= date(?)");
                args.push(normalizeDate(req.query.startDate));
            }
            if (req.query.endDate) {
                where.push("date(r.momento) <= date(?)");
                args.push(normalizeDate(req.query.endDate));
            }
            const rows = await dbAllAsync(
                `SELECT r.*, f.nome AS funcionario_nome
                 FROM hr_registos_ponto r
                 LEFT JOIN hr_funcionarios f ON f.id = r.funcionario_id
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY r.momento DESC
                 LIMIT 800`,
                args
            );
            return res.json({ success: true, data: rows.map(mapRegistoPontoRow) });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.post('/api/hr/registos-ponto', async (req, res) => {
        try {
            await ensureHrSchema();
            await requireHrManager(req.body?.actorUserId, 'Só a conta mpr@mpr.pt pode gerir picagens de ponto.');
            const funcionarioId = String(req.body?.funcionarioId || req.body?.funcionario_id || '').trim();
            const tipo = normalizePontoTipo(req.body?.tipo);
            const momento = normalizeDateTime(req.body?.momento);
            const origem = String(req.body?.origem || 'manual').trim() || 'manual';
            if (!funcionarioId || !momento) return res.status(400).json({ success: false, error: 'Funcionário e momento são obrigatórios.' });
            const funcionario = await dbGetAsync('SELECT id FROM hr_funcionarios WHERE id = ? LIMIT 1', [funcionarioId]);
            if (!funcionario?.id) return res.status(404).json({ success: false, error: 'Funcionário não encontrado.' });
            const id = newId('ponto');
            const payload = { id, funcionario_id: funcionarioId, tipo, momento, origem };
            await dbRunAsync(
                `INSERT INTO hr_registos_ponto (id, funcionario_id, tipo, momento, origem, supabase_payload_json, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [id, funcionarioId, tipo, momento, origem, json(payload)]
            );
            await writeAuditLog?.({ entityType: 'hr_registo_ponto', entityId: id, action: 'create', details: payload });
            const row = await dbGetAsync(
                `SELECT r.*, f.nome AS funcionario_nome
                 FROM hr_registos_ponto r
                 LEFT JOIN hr_funcionarios f ON f.id = r.funcionario_id
                 WHERE r.id = ? LIMIT 1`,
                [id]
            );
            return res.json({ success: true, data: mapRegistoPontoRow(row) });
        } catch (error) {
            const statusCode = Number(error?.statusCode || 500) || 500;
            return res.status(statusCode).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.patch('/api/hr/registos-ponto/:id', async (req, res) => {
        try {
            await ensureHrSchema();
            await requireHrManager(req.body?.actorUserId);
            const id = String(req.params.id || '').trim();
            const current = await dbGetAsync('SELECT * FROM hr_registos_ponto WHERE id = ? LIMIT 1', [id]);
            if (!current) return res.status(404).json({ success: false, error: 'Picagem não encontrada.' });
            const tipo = req.body?.tipo !== undefined ? normalizePontoTipo(req.body.tipo) : normalizePontoTipo(current.tipo);
            const momento = req.body?.momento !== undefined ? normalizeDateTime(req.body.momento) : normalizeDateTime(current.momento);
            const origem = req.body?.origem !== undefined ? String(req.body.origem || '').trim() : String(current.origem || '');
            if (!momento) return res.status(400).json({ success: false, error: 'Momento inválido.' });
            const payload = { id, funcionario_id: String(current.funcionario_id || ''), tipo, momento, origem };
            await dbRunAsync(
                `UPDATE hr_registos_ponto
                 SET tipo = ?, momento = ?, origem = ?, supabase_payload_json = COALESCE(?, supabase_payload_json), updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [tipo, momento, origem, json(payload), id]
            );
            await writeAuditLog?.({ entityType: 'hr_registo_ponto', entityId: id, action: 'update', details: payload });
            const row = await dbGetAsync(
                `SELECT r.*, f.nome AS funcionario_nome
                 FROM hr_registos_ponto r
                 LEFT JOIN hr_funcionarios f ON f.id = r.funcionario_id
                 WHERE r.id = ? LIMIT 1`,
                [id]
            );
            return res.json({ success: true, data: mapRegistoPontoRow(row) });
        } catch (error) {
            const statusCode = Number(error?.statusCode || 500) || 500;
            return res.status(statusCode).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.delete('/api/hr/registos-ponto/:id', async (req, res) => {
        try {
            await ensureHrSchema();
            await requireHrManager(req.query?.actorUserId || req.body?.actorUserId, 'Só a conta mpr@mpr.pt pode gerir picagens de ponto.');
            const id = String(req.params.id || '').trim();
            const current = await dbGetAsync('SELECT id FROM hr_registos_ponto WHERE id = ? LIMIT 1', [id]);
            if (!current) return res.status(404).json({ success: false, error: 'Picagem não encontrada.' });
            await dbRunAsync('DELETE FROM hr_registos_ponto WHERE id = ?', [id]);
            await writeAuditLog?.({ entityType: 'hr_registo_ponto', entityId: id, action: 'delete', details: {} });
            return res.json({ success: true, data: null });
        } catch (error) {
            const statusCode = Number(error?.statusCode || 500) || 500;
            return res.status(statusCode).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.get('/api/hr/objetivos', async (req, res) => {
        try {
            await ensureHrSchema();
            const viewer = await resolveHrViewer(req.query.viewerUserId);
            const funcionarioId = String(req.query.funcionarioId || '').trim();
            if (!funcionarioId) return res.status(400).json({ success: false, error: 'Funcionário obrigatório.' });
            if (viewer.user && !viewer.isManager && funcionarioId !== viewer.funcionarioId) {
                return res.status(403).json({ success: false, error: 'Só pode ver os seus próprios objetivos.' });
            }
            await seedObjetivosFromFuncionario(funcionarioId);
            const [items, configRow] = await Promise.all([
                dbAllAsync('SELECT * FROM hr_objetivos WHERE funcionario_id = ? ORDER BY ordem ASC, created_at ASC', [funcionarioId]),
                dbGetAsync('SELECT * FROM hr_objetivos_config WHERE funcionario_id = ? LIMIT 1', [funcionarioId]),
            ]);
            return res.json({
                success: true,
                data: {
                    items: items.map(mapObjetivoRow),
                    config: mapObjetivoConfigRow(configRow || { funcionario_id: funcionarioId }),
                },
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.put('/api/hr/objetivos/:funcionarioId', async (req, res) => {
        try {
            await ensureHrSchema();
            await requireHrManager(req.body?.actorUserId, 'Só a conta mpr@mpr.pt pode gerir objetivos.');
            const funcionarioId = String(req.params.funcionarioId || '').trim();
            const funcionario = await dbGetAsync('SELECT id FROM hr_funcionarios WHERE id = ? LIMIT 1', [funcionarioId]);
            if (!funcionario?.id) return res.status(404).json({ success: false, error: 'Funcionário não encontrado.' });
            await replaceObjetivos(funcionarioId, req.body?.items || [], req.body?.config || {});
            const [items, configRow] = await Promise.all([
                dbAllAsync('SELECT * FROM hr_objetivos WHERE funcionario_id = ? ORDER BY ordem ASC, created_at ASC', [funcionarioId]),
                dbGetAsync('SELECT * FROM hr_objetivos_config WHERE funcionario_id = ? LIMIT 1', [funcionarioId]),
            ]);
            await writeAuditLog?.({ entityType: 'hr_objetivos', entityId: funcionarioId, action: 'update', details: { total: items.length } });
            return res.json({ success: true, data: { items: items.map(mapObjetivoRow), config: mapObjetivoConfigRow(configRow) } });
        } catch (error) {
            const statusCode = Number(error?.statusCode || 500) || 500;
            return res.status(statusCode).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.post('/api/hr/objetivos/apply-all', async (req, res) => {
        try {
            await ensureHrSchema();
            await requireHrManager(req.body?.actorUserId, 'Só a conta mpr@mpr.pt pode aplicar objetivos a todos.');
            const funcionarios = await dbAllAsync('SELECT id FROM hr_funcionarios');
            for (const funcionario of funcionarios) {
                await replaceObjetivos(String(funcionario.id || ''), req.body?.items || [], req.body?.config || {});
            }
            await writeAuditLog?.({ entityType: 'hr_objetivos', entityId: 'all', action: 'apply_all', details: { total: funcionarios.length } });
            return res.json({ success: true, data: { count: funcionarios.length } });
        } catch (error) {
            const statusCode = Number(error?.statusCode || 500) || 500;
            return res.status(statusCode).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.get('/api/hr/email-autoreplies/config', async (req, res) => {
        try {
            await ensureHrSchema();
            await requireHrManager(req.query?.actorUserId || req.query?.viewerUserId, 'Só a conta mpr@mpr.pt pode consultar a configuração de auto-reply.');
            const config = emailAutoReplyService.getConfig();
            return res.json({
                success: true,
                data: {
                    mode: config.mode,
                    enabled: config.enabled,
                    dryRun: config.dryRun,
                    command: config.command,
                    prefixArgs: Array.isArray(config.prefixArgs) ? config.prefixArgs : [],
                    timeoutMs: config.timeoutMs,
                    manualUrl: config.manualUrl,
                    defaultSubject: config.defaultSubject,
                    defaultTemplate: config.defaultTemplate,
                    simpleTemplate: config.simpleTemplate,
                    schedulerEnabled: String(process.env.HR_EMAIL_AUTOREPLY_SCHEDULER_ENABLED || '1').trim() !== '0',
                    schedulerHour: Number(process.env.HR_EMAIL_AUTOREPLY_HOUR || 0) || 0,
                    schedulerMinute: Number(process.env.HR_EMAIL_AUTOREPLY_MINUTE || 5) || 5,
                    timezone: process.env.HR_EMAIL_AUTOREPLY_TIMEZONE || 'Europe/Lisbon',
                },
            });
        } catch (error) {
            const statusCode = Number(error?.statusCode || 500) || 500;
            return res.status(statusCode).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.get('/api/hr/email-autoreplies', async (req, res) => {
        try {
            await ensureHrSchema();
            const viewer = await resolveHrViewer(req.query?.viewerUserId || req.query?.actorUserId);
            const funcionarioId = String(req.query?.funcionarioId || '').trim();
            const pedidoId = String(req.query?.pedidoId || '').trim();
            const params = [];
            const where = ['1 = 1'];
            if (pedidoId) {
                where.push('pedido_id = ?');
                params.push(pedidoId);
            }
            if (funcionarioId) {
                if (!viewer.isManager && viewer.funcionarioId !== funcionarioId) {
                    return res.status(403).json({ success: false, error: 'Sem permissão para consultar estes agendamentos.' });
                }
                await ensureEmailAutoReplySchedulesForApprovedVacations(funcionarioId, req.query?.viewerUserId || req.query?.actorUserId || '');
                where.push('funcionario_id = ?');
                params.push(funcionarioId);
            } else if (!viewer.isManager) {
                if (!viewer.funcionarioId) return res.json({ success: true, data: [] });
                await ensureEmailAutoReplySchedulesForApprovedVacations(viewer.funcionarioId, viewer.user?.id || '');
                where.push('funcionario_id = ?');
                params.push(viewer.funcionarioId);
            }
            const rows = await dbAllAsync(
                `SELECT * FROM hr_email_autoreply_schedules
                 WHERE ${where.join(' AND ')}
                 ORDER BY start_date DESC, created_at DESC`,
                params
            );
            const data = await attachEmailAutoReplyLogs(rows);
            return res.json({ success: true, data });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.post('/api/hr/email-autoreplies', async (req, res) => {
        try {
            await ensureHrSchema();
            const actor = await requireHrManager(req.body?.actorUserId, 'Só a conta mpr@mpr.pt pode agendar avisos de email.');
            const pedidoId = String(req.body?.pedidoId || req.body?.pedido_id || '').trim();
            let funcionarioId = String(req.body?.funcionarioId || req.body?.funcionario_id || '').trim();
            let funcionarioNome = String(req.body?.funcionarioNome || req.body?.funcionario_nome || '').trim();
            let startDate = normalizeDate(req.body?.startDate || req.body?.start_date);
            let endDate = normalizeDate(req.body?.endDate || req.body?.end_date);

            if (pedidoId) {
                const pedido = await dbGetAsync(
                    `SELECT p.*, f.nome AS funcionario_nome, f.email AS funcionario_email
                     FROM hr_pedidos p
                     LEFT JOIN hr_funcionarios f ON f.id = COALESCE(NULLIF(p.funcionario_id, ''), p.atribuido_a)
                     WHERE p.id = ? LIMIT 1`,
                    [pedidoId]
                );
                if (!pedido?.id) return res.status(404).json({ success: false, error: 'Pedido de férias não encontrado.' });
                if (normalizeStatus(pedido.status) !== 'APROVADO' || !isVacationTipo(pedido.tipo)) {
                    return res.status(400).json({ success: false, error: 'Só é possível agendar auto-reply para férias aprovadas.' });
                }
                funcionarioId = funcionarioId || String(pedido.funcionario_id || pedido.atribuido_a || '');
                funcionarioNome = funcionarioNome || String(pedido.funcionario_nome || '');
                startDate = startDate || normalizeDate(pedido.data_inicio);
                endDate = endDate || normalizeDate(pedido.data_fim || pedido.data_inicio);
            }

            if (!funcionarioId) return res.status(400).json({ success: false, error: 'Funcionário obrigatório.' });
            const funcionario = await dbGetAsync('SELECT id, nome, email FROM hr_funcionarios WHERE id = ? LIMIT 1', [funcionarioId]);
            if (!funcionario?.id) return res.status(404).json({ success: false, error: 'Funcionário não encontrado.' });
            funcionarioNome = funcionarioNome || String(funcionario.nome || '');

            const email = normalizeEmail(req.body?.email || funcionario.email);
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({ success: false, error: 'Email válido obrigatório.' });
            }
            if (!startDate || !endDate) return res.status(400).json({ success: false, error: 'Datas de início e fim obrigatórias.' });
            if (endDate < startDate) return res.status(400).json({ success: false, error: 'A data fim não pode ser anterior à data início.' });

            const enabled = req.body?.enabled === undefined ? 1 : (req.body.enabled ? 1 : 0);
            const fallbackContact = splitAlternateContact(req.body?.alternateContact || req.body?.alternate_contact || 'geral@mpr.pt ou +351 253 561 548');
            const alternateContactEmail = normalizeEmail(req.body?.alternateContactEmail || req.body?.alternate_contact_email || fallbackContact.email || 'geral@mpr.pt');
            const alternateContactPhone = String(req.body?.alternateContactPhone || req.body?.alternate_contact_phone || fallbackContact.phone || '+351 253 561 548').trim();
            const alternateContact = `${alternateContactEmail}${alternateContactPhone ? ` ou ${alternateContactPhone}` : ''}`;
            const templateVariant = String(req.body?.templateVariant || req.body?.template_variant || 'default').trim() === 'simple' ? 'simple' : 'default';
            const generated = emailAutoReplyService.generate({
                funcionarioNome,
                email,
                startDate,
                endDate,
                alternateContactEmail,
                alternateContactPhone,
                motivo: req.body?.motivo || req.body?.reason || 'férias',
                templateVariant,
                subject: req.body?.subject,
            });
            const subject = String(req.body?.subject || generated.subject || 'Ausência temporária').trim() || 'Ausência temporária';
            const message = String(req.body?.message || '').trim() || generated.message;
            const deactivateDate = normalizeDate(req.body?.deactivateDate || req.body?.deactivate_date) || addDaysIso(endDate, 1);
            const config = emailAutoReplyService.getConfig();

            const existing = pedidoId
                ? await dbGetAsync('SELECT * FROM hr_email_autoreply_schedules WHERE pedido_id = ? LIMIT 1', [pedidoId])
                : null;
            const id = String(existing?.id || req.body?.id || newId('hr_email_autoreply'));
            const previousStatus = normalizeAutoReplyStatus(existing?.status);
            const nextStatus = enabled ? (previousStatus === 'ativo' ? 'ativo' : getDefaultAutoReplyStatus()) : 'desativado';

            await dbRunAsync(
                `INSERT INTO hr_email_autoreply_schedules (
                    id, pedido_id, funcionario_id, funcionario_nome, email, enabled,
                    subject, message, alternate_contact, alternate_contact_email, alternate_contact_phone,
                    template_variant, mode, manual_url, start_date, end_date, deactivate_date,
                    status, last_action, last_error, created_by, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(pedido_id) DO UPDATE SET
                    funcionario_id = excluded.funcionario_id,
                    funcionario_nome = excluded.funcionario_nome,
                    email = excluded.email,
                    enabled = excluded.enabled,
                    subject = excluded.subject,
                    message = excluded.message,
                    alternate_contact = excluded.alternate_contact,
                    alternate_contact_email = excluded.alternate_contact_email,
                    alternate_contact_phone = excluded.alternate_contact_phone,
                    template_variant = excluded.template_variant,
                    mode = excluded.mode,
                    manual_url = excluded.manual_url,
                    start_date = excluded.start_date,
                    end_date = excluded.end_date,
                    deactivate_date = excluded.deactivate_date,
                    status = excluded.status,
                    last_action = excluded.last_action,
                    last_error = excluded.last_error,
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    id,
                    pedidoId || null,
                    funcionarioId,
                    funcionarioNome,
                    email,
                    enabled,
                    subject,
                    message,
                    alternateContact,
                    alternateContactEmail,
                    alternateContactPhone,
                    templateVariant,
                    config.mode,
                    config.manualUrl,
                    startDate,
                    endDate,
                    deactivateDate,
                    nextStatus,
                    enabled ? 'aviso_gerado' : 'disable',
                    '',
                    actor.user?.id || req.body?.actorUserId || '',
                ]
            );
            await logEmailAutoReply(id, enabled ? 'aviso_gerado' : 'disable', 'success', enabled ? 'Aviso automático gerado/atualizado.' : 'Agendamento desativado.', {
                pedidoId,
                funcionarioId,
                startDate,
                endDate,
                deactivateDate,
                mode: config.mode,
            });
            await writeAuditLog?.({ entityType: 'hr_email_autoreply', entityId: id, action: 'schedule', details: { pedidoId, funcionarioId, email, enabled: Boolean(enabled) } });

            let row = await dbGetAsync('SELECT * FROM hr_email_autoreply_schedules WHERE id = ? LIMIT 1', [id]);
            if (existing?.id && previousStatus === 'ativo' && !enabled && row?.id) {
                await applyEmailAutoReplySchedule(row, 'deactivate', 'manual-save');
                row = await dbGetAsync('SELECT * FROM hr_email_autoreply_schedules WHERE id = ? LIMIT 1', [id]);
            }
            const [data] = await attachEmailAutoReplyLogs(row ? [row] : []);
            return res.json({ success: true, data });
        } catch (error) {
            const statusCode = Number(error?.statusCode || 500) || 500;
            return res.status(statusCode).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.patch('/api/hr/email-autoreplies/:id', async (req, res) => {
        try {
            await ensureHrSchema();
            await requireHrManager(req.body?.actorUserId, 'Só a conta mpr@mpr.pt pode editar avisos de email.');
            const id = String(req.params.id || '').trim();
            const current = await dbGetAsync('SELECT * FROM hr_email_autoreply_schedules WHERE id = ? LIMIT 1', [id]);
            if (!current?.id) return res.status(404).json({ success: false, error: 'Agendamento não encontrado.' });

            const email = req.body?.email !== undefined ? normalizeEmail(req.body.email) : String(current.email || '');
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({ success: false, error: 'Email válido obrigatório.' });
            }
            const startDate = req.body?.startDate !== undefined || req.body?.start_date !== undefined
                ? normalizeDate(req.body?.startDate || req.body?.start_date)
                : normalizeDate(current.start_date);
            const endDate = req.body?.endDate !== undefined || req.body?.end_date !== undefined
                ? normalizeDate(req.body?.endDate || req.body?.end_date)
                : normalizeDate(current.end_date);
            if (!startDate || !endDate) return res.status(400).json({ success: false, error: 'Datas de início e fim obrigatórias.' });
            if (endDate < startDate) return res.status(400).json({ success: false, error: 'A data fim não pode ser anterior à data início.' });

            const enabled = req.body?.enabled === undefined ? Number(current.enabled || 0) : (req.body.enabled ? 1 : 0);
            const subject = req.body?.subject !== undefined ? String(req.body.subject || '').trim() : String(current.subject || '');
            const fallbackContact = splitAlternateContact(
                req.body?.alternateContact !== undefined || req.body?.alternate_contact !== undefined
                    ? String(req.body?.alternateContact || req.body?.alternate_contact || '').trim()
                    : String(current.alternate_contact || '')
            );
            const alternateContactEmail = normalizeEmail(
                req.body?.alternateContactEmail || req.body?.alternate_contact_email || current.alternate_contact_email || fallbackContact.email || 'geral@mpr.pt'
            );
            const alternateContactPhone = String(
                req.body?.alternateContactPhone || req.body?.alternate_contact_phone || current.alternate_contact_phone || fallbackContact.phone || ''
            ).trim();
            const alternateContact = `${alternateContactEmail}${alternateContactPhone ? ` ou ${alternateContactPhone}` : ''}`;
            const templateVariant = String(req.body?.templateVariant || req.body?.template_variant || current.template_variant || 'default').trim() === 'simple' ? 'simple' : 'default';
            const message = req.body?.message !== undefined
                ? String(req.body.message || '').trim()
                : String(current.message || '');
            const deactivateDate = normalizeDate(req.body?.deactivateDate || req.body?.deactivate_date) || normalizeDate(current.deactivate_date) || addDaysIso(endDate, 1);
            const config = emailAutoReplyService.getConfig();
            const nextStatus = enabled ? normalizeAutoReplyStatus(current.status) : 'desativado';

            await dbRunAsync(
                `UPDATE hr_email_autoreply_schedules
                 SET email = ?, enabled = ?, subject = ?, message = ?,
                     alternate_contact = ?, alternate_contact_email = ?, alternate_contact_phone = ?,
                     template_variant = ?, mode = ?, manual_url = ?,
                     start_date = ?, end_date = ?, deactivate_date = ?, status = ?,
                     last_action = ?, last_error = '', updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [
                    email,
                    enabled,
                    subject || 'Ausência temporária',
                    message || buildDefaultAutoReplyMessage({
                        funcionarioNome: current.funcionario_nome,
                        email,
                        startDate,
                        endDate,
                        alternateContactEmail,
                        alternateContactPhone,
                        templateVariant,
                    }),
                    alternateContact,
                    alternateContactEmail,
                    alternateContactPhone,
                    templateVariant,
                    config.mode,
                    config.manualUrl,
                    startDate,
                    endDate,
                    deactivateDate,
                    nextStatus,
                    enabled ? 'aviso_gerado' : 'disable',
                    id,
                ]
            );
            await logEmailAutoReply(id, 'update', 'success', 'Agendamento atualizado.', { startDate, endDate, enabled: Boolean(enabled) });
            let row = await dbGetAsync('SELECT * FROM hr_email_autoreply_schedules WHERE id = ? LIMIT 1', [id]);
            if (normalizeAutoReplyStatus(current.status) === 'ativo' && !enabled && row?.id) {
                await applyEmailAutoReplySchedule(row, 'deactivate', 'manual-save');
                row = await dbGetAsync('SELECT * FROM hr_email_autoreply_schedules WHERE id = ? LIMIT 1', [id]);
            }
            const [data] = await attachEmailAutoReplyLogs(row ? [row] : []);
            return res.json({ success: true, data });
        } catch (error) {
            const statusCode = Number(error?.statusCode || 500) || 500;
            return res.status(statusCode).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.post('/api/hr/email-autoreplies/:id/run', async (req, res) => {
        try {
            await ensureHrSchema();
            await requireHrManager(req.body?.actorUserId, 'Só a conta mpr@mpr.pt pode sincronizar avisos de email.');
            const id = String(req.params.id || '').trim();
            const rawAction = String(req.body?.action || '').trim();
            const action = rawAction === 'deactivate' || rawAction === 'mark_deactivated'
                ? rawAction
                : rawAction === 'mark_activated'
                    ? 'mark_activated'
                    : 'activate';
            const row = await dbGetAsync('SELECT * FROM hr_email_autoreply_schedules WHERE id = ? LIMIT 1', [id]);
            if (!row?.id) return res.status(404).json({ success: false, error: 'Agendamento não encontrado.' });
            if (action === 'mark_activated' || action === 'mark_deactivated') {
                await markEmailAutoReplyManual(row, action, 'manual');
            } else {
                await applyEmailAutoReplySchedule(row, action, 'manual');
            }
            const updated = await dbGetAsync('SELECT * FROM hr_email_autoreply_schedules WHERE id = ? LIMIT 1', [id]);
            const [data] = await attachEmailAutoReplyLogs(updated ? [updated] : []);
            return res.json({ success: true, data });
        } catch (error) {
            const statusCode = Number(error?.statusCode || 500) || 500;
            return res.status(statusCode).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.post('/api/hr/email-autoreplies/run-due', async (req, res) => {
        try {
            await ensureHrSchema();
            await requireHrManager(req.body?.actorUserId, 'Só a conta mpr@mpr.pt pode executar agendamentos de email.');
            const summary = await syncDueEmailAutoReplies({ actor: 'manual', todayIso: req.body?.today });
            return res.json({ success: true, data: summary });
        } catch (error) {
            const statusCode = Number(error?.statusCode || 500) || 500;
            return res.status(statusCode).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.patch('/api/hr/pedidos/:id', async (req, res) => {
        try {
            await ensureHrSchema();
            await requirePedidosManager(req.body?.actorUserId);
            const id = String(req.params.id || '').trim();
            if (!id) return res.status(400).json({ success: false, error: 'ID obrigatório.' });

            const current = await dbGetAsync('SELECT * FROM hr_pedidos WHERE id = ? LIMIT 1', [id]);
            if (!current) return res.status(404).json({ success: false, error: 'Pedido não encontrado.' });

            const tipo = req.body?.tipo !== undefined ? normalizeTipo(req.body.tipo) : normalizeTipo(current.tipo);
            const descricao = req.body?.descricao !== undefined ? String(req.body.descricao || '').trim() : String(current.descricao || '');
            const dataInicio = req.body?.dataInicio !== undefined || req.body?.data_inicio !== undefined
                ? normalizeDate(req.body?.dataInicio || req.body?.data_inicio)
                : normalizeDate(current.data_inicio);
            const dataFim = req.body?.dataFim !== undefined || req.body?.data_fim !== undefined
                ? normalizeDate(req.body?.dataFim || req.body?.data_fim || dataInicio)
                : normalizeDate(current.data_fim || current.data_inicio);
            const status = req.body?.status !== undefined ? normalizeStatus(req.body.status) : normalizeStatus(current.status);
            const resolucao = req.body?.resolucao !== undefined ? String(req.body.resolucao || '').trim() : String(current.resolucao || '');

            const localPayload = {
                tipo,
                descricao,
                data_inicio: dataInicio || null,
                data_fim: dataFim || dataInicio || null,
                status,
                resolucao,
            };
            await dbRunAsync(
                `UPDATE hr_pedidos
                 SET tipo = ?, descricao = ?, data_inicio = ?, data_fim = ?, status = ?, resolucao = ?, updated_at = CURRENT_TIMESTAMP,
                     supabase_payload_json = COALESCE(?, supabase_payload_json)
                 WHERE id = ?`,
                [tipo, descricao, dataInicio, dataFim || dataInicio, status, resolucao, json(localPayload), id]
            );
            await writeAuditLog?.({
                entityType: 'hr_pedido',
                entityId: id,
                action: 'update',
                details: { tipo, descricao, dataInicio, dataFim, status, resolucao },
            });
            const row = await dbGetAsync(
                `SELECT p.*, f.nome AS funcionario_nome
                 FROM hr_pedidos p
                 LEFT JOIN hr_funcionarios f ON f.id = COALESCE(NULLIF(p.funcionario_id, ''), p.atribuido_a)
                 WHERE p.id = ? LIMIT 1`,
                [id]
            );
            return res.json({ success: true, data: mapPedidoRow(row) });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.get('/api/hr/holidays', async (_req, res) => {
        try {
            await ensureHrSchema();
            const rows = await dbAllAsync('SELECT date, name, region FROM hr_holidays ORDER BY date ASC');
            return res.json({ success: true, data: rows });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.post('/api/hr/holidays', async (req, res) => {
        try {
            await ensureHrSchema();
            const date = normalizeDate(req.body?.date);
            const name = String(req.body?.name || '').trim();
            if (!date || !name) return res.status(400).json({ success: false, error: 'Data e nome são obrigatórios.' });
            const table = await resolveTable(process.env.SUPABASE_HOLIDAYS_SOURCE || 'holidays', ['public.holidays', 'holidays']);
            await upsertSupabaseRow(table, 'date', { date, name, region: String(req.body?.region || 'PT') }).catch(() => null);
            await dbRunAsync(
                `INSERT INTO hr_holidays (date, name, region, updated_at)
                 VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(date) DO UPDATE SET name = excluded.name, region = excluded.region, updated_at = CURRENT_TIMESTAMP`,
                [date, name, String(req.body?.region || 'PT')]
            );
            return res.json({ success: true, data: { date, name, region: String(req.body?.region || 'PT') } });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.delete('/api/hr/holidays/:date', async (req, res) => {
        try {
            await ensureHrSchema();
            const date = normalizeDate(req.params.date);
            if (!date) return res.status(400).json({ success: false, error: 'Data obrigatória.' });
            const table = await resolveTable(process.env.SUPABASE_HOLIDAYS_SOURCE || 'holidays', ['public.holidays', 'holidays']);
            await deleteSupabaseRow(table, 'date', date).catch(() => null);
            await dbRunAsync('DELETE FROM hr_holidays WHERE date = ?', [date]);
            return res.json({ success: true });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.get('/api/hr/ferias-saldos', async (req, res) => {
        try {
            await ensureHrSchema();
            const ano = Number(req.query.year || new Date().getFullYear());
            const rows = await dbAllAsync('SELECT * FROM hr_ferias_saldos WHERE ano = ? ORDER BY funcionario_id ASC', [ano]);
            return res.json({ success: true, data: rows.map(mapSaldoRow) });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.put('/api/hr/ferias-saldos/:funcionarioId/:year', async (req, res) => {
        try {
            await ensureHrSchema();
            const funcionarioId = String(req.params.funcionarioId || '').trim();
            const ano = Number(req.params.year || new Date().getFullYear());
            if (!funcionarioId || !Number.isFinite(ano)) return res.status(400).json({ success: false, error: 'Funcionário e ano são obrigatórios.' });
            const row = {
                id: String(req.body?.id || '').trim() || newId('saldo'),
                funcionario_id: funcionarioId,
                ano,
                dias_direito: Number(req.body?.diasDireito ?? 22) || 22,
                dias_extra: Number(req.body?.diasExtra ?? 0) || 0,
                dias_usados_manual: Number(req.body?.diasUsadosManual ?? 0) || 0,
                observacoes: String(req.body?.observacoes || '').trim(),
            };
            const table = await resolveTable(process.env.SUPABASE_FERIAS_SALDOS_SOURCE || 'ferias_saldos', ['public.ferias_saldos', 'ferias_saldos']);
            await upsertSupabaseRow(table, 'funcionario_id,ano', row).catch(() => null);
            await dbRunAsync(
                `INSERT INTO hr_ferias_saldos (id, funcionario_id, ano, dias_direito, dias_extra, dias_usados_manual, observacoes, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(funcionario_id, ano) DO UPDATE SET
                    dias_direito = excluded.dias_direito,
                    dias_extra = excluded.dias_extra,
                    dias_usados_manual = excluded.dias_usados_manual,
                    observacoes = excluded.observacoes,
                    updated_at = CURRENT_TIMESTAMP`,
                [row.id, row.funcionario_id, row.ano, row.dias_direito, row.dias_extra, row.dias_usados_manual, row.observacoes]
            );
            return res.json({ success: true, data: mapSaldoRow(row) });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.get('/api/hr/ferias-empresa-periodos', async (_req, res) => {
        try {
            await ensureHrSchema();
            const rows = await dbAllAsync('SELECT * FROM hr_ferias_empresa_periodos ORDER BY data_inicio ASC');
            return res.json({
                success: true,
                data: rows.map((row) => ({
                    id: String(row.id || ''),
                    titulo: String(row.titulo || ''),
                    descricao: String(row.descricao || ''),
                    dataInicio: normalizeDate(row.data_inicio),
                    dataFim: normalizeDate(row.data_fim),
                    funcionariosAlvo: parseArrayJson(row.funcionarios_alvo_json),
                    createdBy: String(row.created_by || ''),
                })),
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.post('/api/hr/ferias-empresa-periodos', async (req, res) => {
        try {
            await ensureHrSchema();
            const id = String(req.body?.id || '').trim() || newId('periodo');
            const titulo = String(req.body?.titulo || 'Férias da Empresa').trim() || 'Férias da Empresa';
            const descricao = String(req.body?.descricao || '').trim();
            const dataInicio = normalizeDate(req.body?.dataInicio || req.body?.data_inicio);
            const dataFim = normalizeDate(req.body?.dataFim || req.body?.data_fim || dataInicio);
            const funcionariosAlvoJson = normalizeArrayJson(req.body?.funcionariosAlvo ?? req.body?.funcionarios_alvo);
            if (!dataInicio || !dataFim) {
                return res.status(400).json({ success: false, error: 'Datas obrigatórias.' });
            }
            if (dataFim < dataInicio) {
                return res.status(400).json({ success: false, error: 'A data fim não pode ser anterior à data início.' });
            }

            const payload = {
                id,
                titulo,
                descricao: descricao || null,
                data_inicio: dataInicio,
                data_fim: dataFim,
                funcionarios_alvo: parseArrayJson(funcionariosAlvoJson),
                created_by: String(req.body?.createdBy || req.body?.created_by || '').trim() || null,
            };
            const table = await resolveTable(process.env.SUPABASE_FERIAS_EMPRESA_PERIODOS_SOURCE || 'ferias_empresa_periodos', ['public.ferias_empresa_periodos', 'ferias_empresa_periodos']);
            const supabaseRow = await upsertSupabaseRow(table, 'id', payload).catch(() => null);

            await dbRunAsync(
                `INSERT INTO hr_ferias_empresa_periodos (
                    id, titulo, descricao, data_inicio, data_fim, funcionarios_alvo_json,
                    created_by, supabase_payload_json, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(id) DO UPDATE SET
                    titulo = excluded.titulo,
                    descricao = excluded.descricao,
                    data_inicio = excluded.data_inicio,
                    data_fim = excluded.data_fim,
                    funcionarios_alvo_json = excluded.funcionarios_alvo_json,
                    created_by = excluded.created_by,
                    supabase_payload_json = excluded.supabase_payload_json,
                    updated_at = CURRENT_TIMESTAMP`,
                [
                    id,
                    titulo,
                    descricao,
                    dataInicio,
                    dataFim,
                    funcionariosAlvoJson,
                    payload.created_by || '',
                    supabaseRow ? json(supabaseRow) : json(payload),
                ]
            );

            return res.json({
                success: true,
                data: {
                    id,
                    titulo,
                    descricao,
                    dataInicio,
                    dataFim,
                    funcionariosAlvo: parseArrayJson(funcionariosAlvoJson),
                    createdBy: payload.created_by || '',
                },
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    app.delete('/api/hr/ferias-empresa-periodos/:id', async (req, res) => {
        try {
            await ensureHrSchema();
            const id = String(req.params.id || '').trim();
            if (!id) return res.status(400).json({ success: false, error: 'ID obrigatório.' });
            const table = await resolveTable(process.env.SUPABASE_FERIAS_EMPRESA_PERIODOS_SOURCE || 'ferias_empresa_periodos', ['public.ferias_empresa_periodos', 'ferias_empresa_periodos']);
            await deleteSupabaseRow(table, 'id', id).catch(() => null);
            await dbRunAsync('DELETE FROM hr_ferias_empresa_periodos WHERE id = ?', [id]);
            return res.json({ success: true });
        } catch (error) {
            return res.status(500).json({ success: false, error: error?.message || String(error) });
        }
    });

    startEmailAutoReplyScheduler();
}

module.exports = {
    registerHrManagementRoutes,
};
