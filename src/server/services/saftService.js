function createSaftService(deps) {
    const {
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
        baseDir,
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
    } = deps;

    // --- Document path helpers ---

    function sanitizeDocumentFileName(rawName) {
        const base = path.basename(String(rawName || '').trim());
        return base.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 180);
    }

    function isWindowsUncPath(value) {
        return /^\\\\[^\\]+\\[^\\]+/.test(String(value || '').trim());
    }

    function isWindowsDrivePath(value) {
        return /^[A-Za-z]:[\\/]/.test(String(value || '').trim());
    }

    function normalizeWindowsPathForCompare(value) {
        return String(value || '')
            .trim()
            .replace(/\//g, '\\')
            .replace(/\\+$/, '')
            .toLowerCase();
    }

    function decodeProcMountPath(value) {
        return String(value || '')
            .replace(/\\040/g, ' ')
            .replace(/\\011/g, '\t')
            .replace(/\\012/g, '\n')
            .replace(/\\134/g, '\\');
    }

    function isLinuxMountPointMounted(mountPath) {
        try {
            const target = path.resolve(String(mountPath || '').trim());
            if (!target) return false;
            const mountsRaw = fs.readFileSync('/proc/mounts', 'utf8');
            const mountedTargets = mountsRaw
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => line.split(/\s+/))
                .filter((parts) => parts.length >= 2)
                .map((parts) => path.resolve(decodeProcMountPath(parts[1])));
            return mountedTargets.some((mountedPath) => {
                if (mountedPath === target) return true;
                return target.startsWith(`${mountedPath}${path.sep}`);
            });
        } catch (error) {
            return false;
        }
    }

    function mapWindowsFolderToLinuxMount(rawFolder) {
        const stored = String(rawFolder || '').trim();
        if (!stored || (!isWindowsUncPath(stored) && !isWindowsDrivePath(stored))) {
            return null;
        }

        const windowsPrefix = normalizeWindowsPathForCompare(DOCS_WINDOWS_PREFIX);
        const linuxMount = String(DOCS_LINUX_MOUNT || '').trim();
        if (!windowsPrefix || !linuxMount) {
            throw new Error(
                'Pasta Windows/UNC detetada na ficha do cliente, mas sem mapeamento no Oracle. Defina DOCS_WINDOWS_PREFIX e DOCS_LINUX_MOUNT no .env.'
            );
        }
        if (!isLinuxMountPointMounted(linuxMount)) {
            throw new Error(
                `DOCS_LINUX_MOUNT (${linuxMount}) não está montado no Oracle. Monte a partilha SMB antes de usar esta pasta do cliente.`
            );
        }

        const storedNormalized = normalizeWindowsPathForCompare(stored);
        if (storedNormalized !== windowsPrefix && !storedNormalized.startsWith(`${windowsPrefix}\\`)) {
            throw new Error(
                `Pasta "${stored}" fora do prefixo configurado em DOCS_WINDOWS_PREFIX ("${DOCS_WINDOWS_PREFIX}").`
            );
        }

        const relativePart = stored
            .trim()
            .slice(DOCS_WINDOWS_PREFIX.trim().length)
            .replace(/^[\\/]+/, '');
        const segments = relativePart.split(/[\\/]+/).filter(Boolean);
        return path.resolve(linuxMount, ...segments);
    }

    function resolveCustomerDocumentsFolder(customerId, storedFolder = '') {
        const trimmed = String(storedFolder || '').trim();
        if (trimmed) {
            if (trimmed.startsWith('~')) {
                return path.resolve(process.env.HOME || baseDir, trimmed.slice(1));
            }
            const mappedWindowsFolder = mapWindowsFolderToLinuxMount(trimmed);
            if (mappedWindowsFolder) {
                return mappedWindowsFolder;
            }
            if (path.isAbsolute(trimmed)) {
                return path.normalize(trimmed);
            }
            return path.resolve(LOCAL_DOCS_ROOT, trimmed);
        }

        const fallback = sanitizeIdPart(customerId || Date.now(), `cliente_${Date.now()}`);
        return path.resolve(LOCAL_DOCS_ROOT, fallback);
    }

    function resolveSaftBunkerFolder(customer, documentType = '') {
        const nif = String(customer?.nif || '').replace(/\D/g, '') || 'sem_nif';
        const customerPart = sanitizeIdPart(customer?.id || 'cliente', 'cliente');
        const docPart = sanitizeIdPart(documentType || 'geral', 'geral');
        return path.resolve(SAFT_BUNKER_ROOT, nif, customerPart, docPart);
    }

    async function ensureWritableSaftBunkerFolder(customer, documentType = '') {
        const preferredFolder = resolveSaftBunkerFolder(customer, documentType);
        try {
            await fs.promises.mkdir(preferredFolder, { recursive: true });
            return { folderPath: preferredFolder, usingFallback: false };
        } catch (error) {
            const fallbackFolder = path.resolve(
                SAFT_BUNKER_FALLBACK_ROOT,
                String(customer?.nif || 'sem_nif').replace(/\D/g, '') || 'sem_nif',
                sanitizeIdPart(customer?.id || 'cliente', 'cliente'),
                sanitizeIdPart(documentType || 'geral', 'geral')
            );
            await fs.promises.mkdir(fallbackFolder, { recursive: true });
            console.warn(
                `[SAFT] Sem acesso ao bunker principal (${preferredFolder}). A usar fallback: ${fallbackFolder}. Erro:`,
                error?.message || error
            );
            return { folderPath: fallbackFolder, usingFallback: true };
        }
    }

    function buildBunkerFileName(documentType, originalName = '') {
        const ext = path.extname(String(originalName || '').trim()) || '.pdf';
        const base = path.basename(String(originalName || '').trim(), ext) || documentType || 'documento';
        const safeBase = sanitizeDocumentFileName(`${documentType}_${base}`).replace(/\.[^.]+$/, '');
        return `${safeBase}${ext}`;
    }

    // --- SAFT document cache ---

    async function getCachedSaftDocument(customerId, documentType) {
        const row = await dbGetAsync(
            `SELECT id, customer_id, customer_nif, document_type, file_name, file_path, source, created_at, updated_at
             FROM saft_documents_cache
             WHERE customer_id = ? AND document_type = ?
             LIMIT 1`,
            [customerId, documentType]
        );

        if (!row) return null;
        const filePath = String(row.file_path || '').trim();
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }

        await dbRunAsync(
            `UPDATE saft_documents_cache
             SET last_requested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [row.id]
        );

        return {
            id: Number(row.id || 0),
            customerId: String(row.customer_id || '').trim(),
            customerNif: String(row.customer_nif || '').trim() || null,
            documentType: String(row.document_type || '').trim(),
            fileName: String(row.file_name || '').trim() || path.basename(filePath),
            filePath,
            source: String(row.source || '').trim() || 'cache',
            updatedAt: String(row.updated_at || '').trim() || nowIso(),
        };
    }

    async function upsertSaftDocumentCache({ customerId, customerNif, documentType, fileName, filePath: rawFilePath, source }) {
        const normalizedCustomerId = String(customerId || '').trim();
        const normalizedDocType = normalizeSaftDocumentType(documentType);
        const normalizedFileName = sanitizeDocumentFileName(fileName || path.basename(String(rawFilePath || '')));
        const normalizedFilePath = path.resolve(String(rawFilePath || '').trim());

        if (!normalizedCustomerId || !normalizedDocType || !normalizedFileName || !normalizedFilePath) {
            throw new Error('Dados inválidos para cache SAFT.');
        }

        await dbRunAsync(
            `INSERT INTO saft_documents_cache (
                customer_id, customer_nif, document_type, file_name, file_path, source, created_at, updated_at, last_requested_at
             ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(customer_id, document_type) DO UPDATE SET
               customer_nif = excluded.customer_nif,
               file_name = excluded.file_name,
               file_path = excluded.file_path,
               source = excluded.source,
               updated_at = CURRENT_TIMESTAMP,
               last_requested_at = CURRENT_TIMESTAMP`,
            [
                normalizedCustomerId,
                String(customerNif || '').replace(/\D/g, '') || null,
                normalizedDocType,
                normalizedFileName,
                normalizedFilePath,
                String(source || 'collected').trim() || 'collected',
            ]
        );

        return dbGetAsync(
            `SELECT id, customer_id, customer_nif, document_type, file_name, file_path, source, created_at, updated_at
             FROM saft_documents_cache
             WHERE customer_id = ? AND document_type = ?
             LIMIT 1`,
            [normalizedCustomerId, normalizedDocType]
        );
    }

    function normalizeSaftDocumentType(rawType) {
        const value = String(rawType || '').trim().toLowerCase();
        if (['declaracao_nao_divida', 'nao_divida', 'declaracao'].includes(value)) return 'declaracao_nao_divida';
        if (['ies'].includes(value)) return 'ies';
        if (['modelo_22', 'modelo22', 'm22'].includes(value)) return 'modelo_22';
        if (['certidao_permanente', 'certidao', 'cp'].includes(value)) return 'certidao_permanente';
        if (['certificado_pme', 'pme'].includes(value)) return 'certificado_pme';
        if (['crc', 'bdc'].includes(value)) return 'crc';
        return '';
    }

    function saftDocumentLabel(type) {
        if (type === 'declaracao_nao_divida') return 'Declaração de Não Dívida';
        if (type === 'ies') return 'IES';
        if (type === 'modelo_22') return 'Modelo 22';
        if (type === 'certidao_permanente') return 'Certidão Permanente';
        if (type === 'certificado_pme') return 'Certificado PME';
        if (type === 'crc') return 'CRC';
        return type;
    }

    function getSaftSearchTokens(documentType, customer) {
        const nif = String(customer?.nif || '').replace(/\D/g, '');
        const base = {
            declaracao_nao_divida: ['nao_divida', 'nao-divida', 'declaracao', 'divida', 'at', 'ss'],
            ies: ['ies'],
            modelo_22: ['modelo22', 'modelo_22', 'modelo 22', 'modelo-22', 'm22'],
            certidao_permanente: ['certidao', 'permanente', 'cp'],
            certificado_pme: ['certificado', 'pme'],
            crc: ['crc', 'bdc'],
        }[documentType] || [documentType];

        return {
            keywords: base.map((item) => String(item || '').toLowerCase()).filter(Boolean),
            nif,
        };
    }

    async function findLatestDocumentMatch(folderPath, filters) {
        const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
        const files = [];

        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const nameLower = entry.name.toLowerCase();
            const hasKeyword = (filters.keywords || []).some((token) => nameLower.includes(token));
            const hasNif = !filters.nif || nameLower.includes(filters.nif);
            if (!hasKeyword || !hasNif) continue;
            const fullPath = path.join(folderPath, entry.name);
            const stat = await fs.promises.stat(fullPath);
            files.push({
                fileName: entry.name,
                fullPath,
                updatedAt: stat.mtime.toISOString(),
            });
        }

        files.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        return files[0] || null;
    }

    async function findDocumentMatches(folderPath, filters) {
        const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
        const files = [];

        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const nameLower = entry.name.toLowerCase();
            const hasKeyword = (filters.keywords || []).some((token) => nameLower.includes(token));
            const hasNif = !filters.nif || nameLower.includes(filters.nif);
            if (!hasKeyword || !hasNif) continue;
            const fullPath = path.join(folderPath, entry.name);
            const stat = await fs.promises.stat(fullPath);
            files.push({
                fileName: entry.name,
                fullPath,
                updatedAt: stat.mtime.toISOString(),
            });
        }

        files.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        return files;
    }

    function extractYearFromFileName(fileName) {
        const matches = String(fileName || '').match(/(20\d{2})/g);
        if (!matches || matches.length === 0) return null;
        const year = Number(matches[matches.length - 1]);
        return Number.isFinite(year) ? year : null;
    }

    function selectModelo22Files(files) {
        const byYear = new Map();
        const withoutYear = [];

        for (const file of files) {
            const year = extractYearFromFileName(file.fileName);
            if (!year) {
                withoutYear.push(file);
                continue;
            }
            if (!byYear.has(year)) {
                byYear.set(year, file);
            }
        }

        const yearsSorted = Array.from(byYear.keys()).sort((a, b) => a - b);
        const yearlyFiles = yearsSorted.map((year) => byYear.get(year)).filter(Boolean);
        return [...yearlyFiles, ...withoutYear.slice(0, 1)];
    }

    // --- Robot fetch ---

    async function runSaftRobotFetch({ customer, documentType, folderPath }) {
        if (!SAFT_ROBOT_SCRIPT) return [];
        if (!SAFT_EMAIL || !SAFT_PASSWORD) {
            throw new Error('Email_saft/Senha_saft não configurados no .env.');
        }

        const scriptPath = path.isAbsolute(SAFT_ROBOT_SCRIPT)
            ? SAFT_ROBOT_SCRIPT
            : path.resolve(baseDir, SAFT_ROBOT_SCRIPT);

        if (!fs.existsSync(scriptPath)) {
            throw new Error(`Script SAFT não encontrado: ${scriptPath}`);
        }

        const args = [
            scriptPath,
            '--email',
            SAFT_EMAIL,
            '--password',
            SAFT_PASSWORD,
            '--nif',
            String(customer?.nif || ''),
            '--document',
            documentType,
            '--outDir',
            folderPath,
        ];

        const result = await new Promise((resolve, reject) => {
            const child = spawn('node', args, { cwd: baseDir });
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (chunk) => {
                stdout += String(chunk || '');
            });
            child.stderr.on('data', (chunk) => {
                stderr += String(chunk || '');
            });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(stderr || `Script SAFT terminou com código ${code}`));
                    return;
                }
                resolve(stdout.trim());
            });
        });

        const raw = String(result || '');
        if (!raw) return [];

        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed?.filePaths)) {
                return parsed.filePaths
                    .map((item) => path.resolve(String(item || '').trim()))
                    .filter((item) => item && fs.existsSync(item));
            }
            if (parsed?.filePath) {
                const resolvedPath = path.resolve(String(parsed.filePath).trim());
                return fs.existsSync(resolvedPath) ? [resolvedPath] : [];
            }
        } catch (error) {
            // segue fallback de texto simples
        }

        if (raw.includes('\n')) {
            const lastLine = raw.split('\n').filter(Boolean).pop() || '';
            const resolvedPath = path.resolve(lastLine);
            return fs.existsSync(resolvedPath) ? [resolvedPath] : [];
        }
        const resolvedPath = path.resolve(raw);
        return fs.existsSync(resolvedPath) ? [resolvedPath] : [];
    }

    async function runSaftDossierMetadata({ customer }) {
        if (!SAFT_ROBOT_SCRIPT) return { situacaoFiscalAt: '', situacaoFiscalSs: '' };
        if (!SAFT_EMAIL || !SAFT_PASSWORD) {
            throw new Error('Email_saft/Senha_saft não configurados no .env.');
        }

        const scriptPath = path.isAbsolute(SAFT_ROBOT_SCRIPT)
            ? SAFT_ROBOT_SCRIPT
            : path.resolve(baseDir, SAFT_ROBOT_SCRIPT);

        if (!fs.existsSync(scriptPath)) {
            throw new Error(`Script SAFT não encontrado: ${scriptPath}`);
        }

        const args = [
            scriptPath,
            '--email',
            SAFT_EMAIL,
            '--password',
            SAFT_PASSWORD,
            '--nif',
            String(customer?.nif || ''),
            '--document',
            'declaracao_nao_divida',
            '--metadataOnly',
            'true',
            '--outDir',
            path.resolve(process.cwd(), '.tmp', 'saft-metadata'),
        ];

        const result = await new Promise((resolve, reject) => {
            const child = spawn('node', args, { cwd: baseDir });
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (chunk) => {
                stdout += String(chunk || '');
            });
            child.stderr.on('data', (chunk) => {
                stderr += String(chunk || '');
            });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(stderr || `Script SAFT terminou com código ${code}`));
                    return;
                }
                resolve(stdout.trim());
            });
        });

        try {
            const parsed = JSON.parse(String(result || '{}'));
            const metadata = parsed?.metadata || {};
            return {
                situacaoFiscalAt: String(metadata?.situacaoFiscalAt || '').trim(),
                situacaoFiscalSs: String(metadata?.situacaoFiscalSs || '').trim(),
                certidaoPermanenteCodigo: String(metadata?.certidaoPermanenteCodigo || '').trim(),
                certidaoPermanenteValidade: String(metadata?.certidaoPermanenteValidade || '').trim(),
                dataPedidoAt: String(metadata?.dataPedidoAt || '').trim(),
                dataPedidoSs: String(metadata?.dataPedidoSs || '').trim(),
                dataRecolhaAt: String(metadata?.dataRecolhaAt || '').trim(),
                dataRecolhaSs: String(metadata?.dataRecolhaSs || '').trim(),
                dataPedidos: Array.isArray(metadata?.dataPedidos)
                    ? metadata.dataPedidos.map((item) => String(item || '').trim()).filter(Boolean)
                    : [],
                dataRecolhas: Array.isArray(metadata?.dataRecolhas)
                    ? metadata.dataRecolhas.map((item) => String(item || '').trim()).filter(Boolean)
                    : [],
            };
        } catch (error) {
            return {
                situacaoFiscalAt: '',
                situacaoFiscalSs: '',
                certidaoPermanenteCodigo: '',
                certidaoPermanenteValidade: '',
                dataPedidoAt: '',
                dataPedidoSs: '',
                dataRecolhaAt: '',
                dataRecolhaSs: '',
                dataPedidos: [],
                dataRecolhas: [],
            };
        }
    }

    // --- Customer lookup for obrigacoes ---

    async function findLocalCustomerRowByNifOrCompany(nif, company) {
        const normalizedNif = normalizeDigits(nif);
        if (normalizedNif) {
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
            const lastNine = normalizedNif.slice(-9);
            const byNif = await dbGetAsync(
                `SELECT id, source_id, name, company, nif, tipo_iva
                 FROM customers
                 WHERE ${nifNormalizedExpr} = ?
                    OR (${nifNormalizedExpr} <> '' AND substr(${nifNormalizedExpr}, -9) = ?)
                 LIMIT 1`,
                [normalizedNif, lastNine]
            );
            if (byNif) return byNif;
            return null;
        }

        const companyLike = String(company || '').trim();
        if (!companyLike) return null;
        return dbGetAsync(
            `SELECT id, source_id, name, company, nif, tipo_iva
             FROM customers
             WHERE lower(company) = lower(?)
                OR lower(name) = lower(?)
             LIMIT 1`,
            [companyLike, companyLike]
        );
    }

    function normalizeSupabaseCustomerCandidate(rawRow, index = 0) {
        const sourceId = String(pickFirstValue(rawRow, ['id', 'cliente_id', 'uuid']) || '').trim();
        const name = String(pickFirstValue(rawRow, ['name', 'nome', 'cliente', 'full_name']) || '').trim();
        const company = String(pickFirstValue(rawRow, ['company', 'empresa', 'organization', 'entidade']) || '').trim();
        const phone = normalizePhone(
            pickFirstValue(rawRow, ['phone', 'telefone', 'telemovel', 'celular', 'whatsapp', 'numero', 'contacto'])
        );
        const email = String(pickFirstValue(rawRow, ['email', 'mail']) || '').trim().toLowerCase();
        const nif = normalizeDigits(
            pickFirstValue(rawRow, ['nif', 'vat', 'tax_id', 'numero_contribuinte', 'contribuinte']) || ''
        );
        const niss = String(
            pickFirstValue(rawRow, ['niss', 'numero_seguranca_social', 'seg_social_numero', 'social_security_number']) || ''
        ).trim();
        const senhaFinancas = String(
            pickFirstValue(rawRow, [
                'senha_financas',
                'senha_portal_financas',
                'password_financas',
                'financas_password',
                'portal_financas_password',
            ]) || ''
        ).trim();
        const senhaSegurancaSocial = String(
            pickFirstValue(rawRow, [
                'senha_seguranca_social',
                'senha_seg_social',
                'password_seguranca_social',
                'password_seg_social',
                'seg_social_password',
            ]) || ''
        ).trim();
        const ownerSource = String(
            pickFirstValue(rawRow, ['owner_id', 'funcionario_id', 'responsavel_id', 'responsavel_interno_id']) || ''
        ).trim();
        const documentsFolder = String(
            pickFirstValue(rawRow, ['pasta_documentos', 'documents_folder', 'document_folder', 'docs_folder']) || ''
        ).trim();
        const tipoIva = String(
            pickFirstValue(rawRow, [
                'tipo_iva',
                'tipoiva',
                'iva_tipo',
                'regime_iva',
                'periodicidade_iva',
                'iva_periodicidade',
            ]) || ''
        ).trim();
        const morada = String(
            pickFirstValue(rawRow, ['morada', 'address', 'endereco']) || ''
        ).trim();
        const notes = String(
            pickFirstValue(rawRow, ['notes', 'notas', 'observacoes', 'obs']) || ''
        ).trim();
        const certidaoPermanenteNumero = String(
            pickFirstValue(rawRow, ['certidao_permanente_numero', 'certidao_permanente_n', 'certidao_permanente']) || ''
        ).trim();
        const certidaoPermanenteValidade = String(
            pickFirstValue(rawRow, ['certidao_permanente_validade', 'validade_certidao_permanente']) || ''
        ).trim();
        const rcbeNumero = String(pickFirstValue(rawRow, ['rcbe_numero', 'rcbe_n', 'rcbe']) || '').trim();
        const rcbeData = String(pickFirstValue(rawRow, ['rcbe_data']) || '').trim();
        const dataConstituicao = String(pickFirstValue(rawRow, ['data_constituicao']) || '').trim();
        const inicioAtividade = String(pickFirstValue(rawRow, ['inicio_atividade', 'data_inicio_atividade']) || '').trim();
        const caePrincipal = String(pickFirstValue(rawRow, ['cae_principal', 'cae']) || '').trim();
        const codigoReparticaoFinancas = String(
            pickFirstValue(rawRow, ['codigo_reparticao_financas', 'reparticao_financas']) || ''
        ).trim();
        const tipoContabilidade = String(pickFirstValue(rawRow, ['tipo_contabilidade']) || '').trim();
        const estadoCliente = String(pickFirstValue(rawRow, ['estado_cliente', 'estado']) || '').trim();
        const contabilistaCertificado = String(
            pickFirstValue(rawRow, ['contabilista_certificado_nome', 'contabilista_certificado']) || ''
        ).trim();
        const managers = extractManagersFromRawRow(rawRow);
        const accessCredentials = extractAccessCredentialsFromRawRow(rawRow, {
            senhaFinancas,
            senhaSegurancaSocial,
        });
        const agregadoFamiliar = parseAgregadoFamiliarArray(
            pickFirstValue(rawRow, ['agregado_familiar_json', 'agregadofamiliar_json', 'agregado_familiar'])
        );
        const fichasRelacionadas = parseFichasRelacionadasArray(
            pickFirstValue(rawRow, ['fichas_relacionadas_json', 'fichasrelacionadas_json', 'fichas_relacionadas'])
        );

        return {
            sourceId,
            localId: sourceId ? `ext_c_${sanitizeIdPart(sourceId, String(index + 1))}` : '',
            name: name || company || `Cliente ${index + 1}`,
            company: company || name || `Cliente ${index + 1}`,
            phone,
            email,
            nif,
            niss,
            senhaFinancas,
            senhaSegurancaSocial,
            documentsFolder,
            tipoIva,
            morada,
            notes,
            certidaoPermanenteNumero,
            certidaoPermanenteValidade,
            rcbeNumero,
            rcbeData,
            dataConstituicao,
            inicioAtividade,
            caePrincipal,
            codigoReparticaoFinancas,
            tipoContabilidade,
            estadoCliente,
            contabilistaCertificado,
            managers,
            accessCredentials,
            agregadoFamiliar,
            fichasRelacionadas,
            ownerId: ownerSource ? `ext_u_${sanitizeIdPart(ownerSource, ownerSource)}` : null,
            type: normalizeCustomerType(pickFirstValue(rawRow, ['type', 'tipo', 'categoria', 'tipo_entidade'])),
            supabaseUpdatedAt: String(pickFirstValue(rawRow, [SUPABASE_CLIENTS_UPDATED_AT_COLUMN, 'updated_at']) || '').trim(),
            raw: rawRow,
        };
    }

    async function loadSupabaseCustomerLookup() {
        if (!(SUPABASE_URL && SUPABASE_KEY)) {
            return null;
        }

        const rows = await fetchSupabaseTable(SUPABASE_CLIENTS_SOURCE);
        const byNif = new Map();
        const byCompany = new Map();

        rows.forEach((row, index) => {
            const candidate = normalizeSupabaseCustomerCandidate(row, index);
            if (candidate.nif) {
                if (!byNif.has(candidate.nif)) byNif.set(candidate.nif, []);
                byNif.get(candidate.nif).push(candidate);
            }

            const companyKey = normalizeLookupText(candidate.company || candidate.name);
            if (companyKey) {
                if (!byCompany.has(companyKey)) byCompany.set(companyKey, []);
                byCompany.get(companyKey).push(candidate);
            }
        });

        return {
            totalRows: rows.length,
            byNif,
            byCompany,
        };
    }

    async function materializeLocalCustomerFromSupabase(candidate) {
        if (!candidate) return null;
        if (!candidate.nif) return null;

        const saved = await upsertLocalCustomer({
            id: candidate.localId || undefined,
            sourceId: candidate.sourceId || undefined,
            name: candidate.name,
            company: candidate.company,
            phone: candidate.phone,
            email: candidate.email || undefined,
            ownerId: candidate.ownerId || undefined,
            type: candidate.type,
            contacts: [],
            documentsFolder: candidate.documentsFolder || undefined,
            nif: candidate.nif || undefined,
            niss: candidate.niss || undefined,
            senhaFinancas: candidate.senhaFinancas || undefined,
            senhaSegurancaSocial: candidate.senhaSegurancaSocial || undefined,
            tipoIva: candidate.tipoIva || undefined,
            morada: candidate.morada || undefined,
            notes: candidate.notes || undefined,
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
            accessCredentials: Array.isArray(candidate.accessCredentials) ? candidate.accessCredentials : [],
            agregadoFamiliar: Array.isArray(candidate.agregadoFamiliar) ? candidate.agregadoFamiliar : [],
            fichasRelacionadas: Array.isArray(candidate.fichasRelacionadas) ? candidate.fichasRelacionadas : [],
            supabasePayload: candidate.raw || {},
            supabaseUpdatedAt: candidate.supabaseUpdatedAt || undefined,
            allowNifOverwrite: true,
            allowAutoResponses: true,
        });

        const savedId = String(saved?.id || candidate.localId || '').trim();
        if (savedId) {
            const rowById = await dbGetAsync(
                `SELECT id, source_id, name, company, nif, tipo_iva
                 FROM customers
                 WHERE id = ?
                 LIMIT 1`,
                [savedId]
            );
            if (rowById) return rowById;
        }

        if (candidate.sourceId) {
            return dbGetAsync(
                `SELECT id, source_id, name, company, nif, tipo_iva
                 FROM customers
                 WHERE source_id = ?
                 LIMIT 1`,
                [candidate.sourceId]
            );
        }

        return null;
    }

    async function findCustomerRowForObrigacao(nif, company, supabaseLookup) {
        const normalizedNif = normalizeDigits(nif).slice(-9);
        if (!normalizedNif) {
            return {
                customerRow: null,
                matchedBy: 'none',
                syncedFromSupabase: false,
            };
        }

        const localRow = await findLocalCustomerRowByNifOrCompany(normalizedNif, '');
        if (localRow) {
            return {
                customerRow: localRow,
                matchedBy: 'local_nif',
                syncedFromSupabase: false,
            };
        }

        if (!supabaseLookup) {
            return {
                customerRow: null,
                matchedBy: 'none',
                syncedFromSupabase: false,
            };
        }

        const candidate = (supabaseLookup.byNif.get(normalizedNif) || [])[0] || null;

        if (!candidate) {
            return {
                customerRow: null,
                matchedBy: 'none',
                syncedFromSupabase: false,
            };
        }

        const syncedRow = await materializeLocalCustomerFromSupabase(candidate);
        return {
            customerRow: syncedRow || null,
            matchedBy: normalizedNif ? 'supabase_nif' : 'supabase_company',
            syncedFromSupabase: !!syncedRow,
        };
    }

    function resolveSupabaseCustomerIdFromLocalRow(localRow) {
        const sourceId = String(localRow?.source_id || '').trim();
        if (sourceId) return sourceId;
        const localId = String(localRow?.id || '').trim();
        if (localId.startsWith('ext_c_')) return localId.slice(6);
        return localId || '';
    }

    // --- Obrigacao recolha persistence ---

    async function upsertLocalObrigacaoRecolha(input) {
        const payloadJson = input.payload ? JSON.stringify(input.payload) : null;
        await dbRunAsync(
            `INSERT INTO obrigacoes_recolhas (
                customer_id, customer_source_id, obrigacao_id, obrigacao_codigo, obrigacao_nome,
                periodo_tipo, periodo_ano, periodo_mes, periodo_trimestre,
                estado_codigo, identificacao, data_recebido, data_comprovativo, empresa, nif,
                payload_json, origem, synced_supabase_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT(customer_id, obrigacao_id, periodo_ano, periodo_mes, periodo_trimestre)
             DO UPDATE SET
                customer_source_id = excluded.customer_source_id,
                obrigacao_codigo = excluded.obrigacao_codigo,
                obrigacao_nome = excluded.obrigacao_nome,
                periodo_tipo = excluded.periodo_tipo,
                estado_codigo = excluded.estado_codigo,
                identificacao = excluded.identificacao,
                data_recebido = excluded.data_recebido,
                data_comprovativo = excluded.data_comprovativo,
                empresa = excluded.empresa,
                nif = excluded.nif,
                payload_json = excluded.payload_json,
                origem = excluded.origem,
                synced_supabase_at = excluded.synced_supabase_at,
                updated_at = CURRENT_TIMESTAMP`,
            [
                String(input.customerId || '').trim(),
                String(input.customerSourceId || '').trim() || null,
                Number(input.obrigacaoId || 0),
                String(input.obrigacaoCodigo || '').trim() || null,
                String(input.obrigacaoNome || '').trim() || null,
                String(input.periodoTipo || 'mensal').trim(),
                Number(input.periodoAno || 0),
                input.periodoMes === null || input.periodoMes === undefined ? 0 : Number(input.periodoMes),
                input.periodoTrimestre === null || input.periodoTrimestre === undefined ? 0 : Number(input.periodoTrimestre),
                String(input.estadoCodigo || '').trim() || null,
                String(input.identificacao || '').trim() || null,
                String(input.dataRecebido || '').trim() || null,
                String(input.dataComprovativo || '').trim() || null,
                String(input.empresa || '').trim() || null,
                String(input.nif || '').trim() || null,
                payloadJson,
                String(input.origem || 'saft_dri_robot').trim(),
                input.syncedSupabaseAt ? String(input.syncedSupabaseAt).trim() : null,
            ]
        );
    }

    async function markLocalObrigacaoRecolhaSynced({ customerId, obrigacaoId, periodo }) {
        if (!customerId || !obrigacaoId || !periodo?.ano) return;

        let query = `
            UPDATE obrigacoes_recolhas
            SET synced_supabase_at = ?, updated_at = CURRENT_TIMESTAMP
            WHERE customer_id = ?
              AND obrigacao_id = ?
              AND periodo_ano = ?
        `;
        const params = [nowIso(), String(customerId).trim(), Number(obrigacaoId), Number(periodo.ano)];

        if (periodo.tipo === 'mensal') {
            query += ' AND periodo_mes = ?';
            params.push(Number(periodo.mes || 0));
        } else if (periodo.tipo === 'trimestral') {
            query += ' AND periodo_trimestre = ?';
            params.push(Number(periodo.trimestre || 0));
        }

        await dbRunAsync(query, params);
    }

    // --- Supabase obrigacao sync ---

    function resolveObrigacaoModeloRow(rows, targetObrigacaoId, labelHints = ['dri']) {
        const list = Array.isArray(rows) ? rows : [];
        const targetId = Number(targetObrigacaoId || 0);
        for (const row of list) {
            const directId = normalizeIntValue(
                pickFirstValue(row, ['id', 'obrigacao_id', 'codigo', 'codigo_obrigacao', 'modelo_id']),
                0
            );
            if (targetId > 0 && directId === targetId) return row;
        }
        for (const row of list) {
            const label = String(
                pickFirstValue(row, ['nome', 'designacao', 'descricao', 'obrigacao_nome', 'titulo']) || ''
            )
                .trim()
                .toLowerCase();
            if (Array.isArray(labelHints) && labelHints.some((token) => token && label.includes(String(token).toLowerCase()))) {
                return row;
            }
        }
        return null;
    }

    async function syncRecolhaEstadoSupabase({
        customerSourceId,
        obrigacaoId,
        obrigacaoNome,
        periodo,
        rowData,
    }) {
        const tableName = await resolveSupabaseTableName(SUPABASE_RECOLHAS_ESCOLHA, [
            'recolhas_estado',
            'recolhas_estados',
        ]);
        const discoveredColumns = await fetchSupabaseTableColumns(tableName);
        const tableColumns =
            Array.isArray(discoveredColumns) && discoveredColumns.length > 0
                ? discoveredColumns
                : tableName === 'recolhas_estado'
                    ? RECOLHAS_ESTADO_FALLBACK_COLUMNS
                    : discoveredColumns;
        const now = nowIso();
        const entregaSource =
            rowData.dataComprovativoIso ||
            rowData.dataComprovativoRaw ||
            rowData.dataRecebidoIso ||
            rowData.dataRecebidoRaw ||
            '';
        const entregaIso = parseDatePtToIso(entregaSource) || String(entregaSource || '').trim() || null;
        const entregaDate = entregaIso
            ? String(entregaIso).slice(0, 10)
            : (periodo?.tipo === 'anual' ? String(now).slice(0, 10) : null);
        const payload = buildPayloadWithExistingColumns(tableColumns, {
            cliente_id: customerSourceId,
            customer_id: customerSourceId,
            id_cliente: customerSourceId,
            obrigacao_id: obrigacaoId,
            obrigacao_modelo_id: obrigacaoId,
            modelo_id: obrigacaoId,
            id_obrigacao: obrigacaoId,
            codigo_obrigacao: obrigacaoId,
            obrigacao_codigo: obrigacaoId,
            obrigacao_nome: obrigacaoNome,
            nome_obrigacao: obrigacaoNome,
            periodo_tipo: periodo.tipo,
            periodicidade: periodo.tipo,
            ano: periodo.ano,
            year: periodo.ano,
            mes:
                periodo.tipo === 'mensal'
                    ? Number(periodo.mes || 0)
                    : periodo.tipo === 'trimestral'
                        ? 0
                        : 0,
            month:
                periodo.tipo === 'mensal'
                    ? Number(periodo.mes || 0)
                    : periodo.tipo === 'trimestral'
                        ? 0
                        : 0,
            trimestre: periodo.tipo === 'trimestral' ? Number(periodo.trimestre || 0) : 0,
            quarter: periodo.tipo === 'trimestral' ? Number(periodo.trimestre || 0) : 0,
            estado: rowData.estado || null,
            estado_codigo: rowData.estado || null,
            status: rowData.estado || null,
            identificacao: rowData.identificacao || null,
            identificador: rowData.identificacao || null,
            data_entrega: entregaDate,
            data_recebido: rowData.dataRecebidoIso || rowData.dataRecebidoRaw || null,
            data_comprovativo: rowData.dataComprovativoIso || rowData.dataComprovativoRaw || null,
            empresa: rowData.empresa || null,
            nif: rowData.nif || null,
            origem: 'saft_dri_robot',
            payload_json: JSON.stringify(rowData.raw || {}),
            atualizado_em: now,
            updated_at: now,
            synced_at: now,
            synced_supabase_at: now,
        });

        const customerCol = pickColumnByCandidates(tableColumns, ['cliente_id', 'customer_id', 'id_cliente'], 'cliente_id');
        const obrigacaoCol = pickColumnByCandidates(
            tableColumns,
            ['obrigacao_modelo_id', 'obrigacao_id', 'id_obrigacao', 'codigo_obrigacao', 'obrigacao_codigo', 'modelo_id'],
            'obrigacao_id'
        );
        const anoCol = pickColumnByCandidates(tableColumns, ['ano', 'year'], 'ano');
        const mesCol = pickColumnByCandidates(tableColumns, ['mes', 'month'], 'mes');
        const trimestreCol = pickColumnByCandidates(tableColumns, ['trimestre', 'quarter'], 'trimestre');

        const filters = {
            [customerCol]: customerSourceId,
            [obrigacaoCol]: obrigacaoId,
            [anoCol]: periodo.ano,
        };
        if (periodo.tipo === 'mensal') {
            filters[mesCol] = periodo.mes;
        } else if (periodo.tipo === 'trimestral') {
            filters[trimestreCol] = periodo.trimestre;
        } else if (periodo.tipo === 'anual') {
            filters[mesCol] = 0;
            filters[trimestreCol] = 0;
        }

        const conflictColumns = Object.keys(filters || {}).filter(Boolean);
        try {
            const upserted = await upsertSupabaseRow(tableName, payload, conflictColumns);
            return { action: 'upserted', row: upserted?.[0] || null };
        } catch (error) {
            const updated = await patchSupabaseTableWithFilters(tableName, payload, filters);
            if (Array.isArray(updated) && updated.length > 0) {
                return { action: 'updated', row: updated[0] };
            }

            const inserted = await insertSupabaseRow(tableName, payload);
            return { action: 'inserted', row: inserted?.[0] || null };
        }
    }

    async function updateObrigacaoPeriodoSupabase({
        customerSourceId,
        obrigacaoId,
        periodo,
        estadoFinal,
    }) {
        const periodTableName = await resolveObrigacoesPeriodTableName(periodo);
        const tableColumns = await fetchSupabaseTableColumns(periodTableName);

        const customerCol = pickColumnByCandidates(tableColumns, ['cliente_id', 'customer_id', 'id_cliente'], 'cliente_id');
        const obrigacaoCol = pickColumnByCandidates(
            tableColumns,
            ['obrigacao_modelo_id', 'obrigacao_id', 'id_obrigacao', 'codigo_obrigacao', 'obrigacao_codigo', 'modelo_id'],
            'obrigacao_id'
        );
        const estadoCol = pickColumnByCandidates(
            tableColumns,
            ['estado', 'estado_id', 'status', 'situacao', 'estado_codigo'],
            'estado'
        );
        const anoCol = pickColumnByCandidates(tableColumns, ['ano', 'year'], 'ano');
        const mesCol = pickColumnByCandidates(tableColumns, ['mes', 'month'], 'mes');
        const trimestreCol = pickColumnByCandidates(tableColumns, ['trimestre', 'quarter'], 'trimestre');

        const payload = buildPayloadWithExistingColumns(tableColumns, {
            [estadoCol]: Number(estadoFinal),
            atualizado_em: nowIso(),
            updated_at: nowIso(),
        });

        const filters = {
            [customerCol]: customerSourceId,
            [obrigacaoCol]: obrigacaoId,
            [anoCol]: periodo.ano,
        };
        if (periodo.tipo === 'mensal') {
            filters[mesCol] = periodo.mes;
        } else if (periodo.tipo === 'trimestral') {
            filters[trimestreCol] = periodo.trimestre;
        }

        const updated = await patchSupabaseTableWithFilters(periodTableName, payload, filters);
        const updatedRows = Array.isArray(updated) ? updated.length : 0;
        if (updatedRows > 0) {
            return {
                table: periodTableName,
                updatedRows,
                action: 'updated',
            };
        }

        const insertPayload = buildPayloadWithExistingColumns(tableColumns, {
            [customerCol]: customerSourceId,
            [obrigacaoCol]: obrigacaoId,
            [anoCol]: periodo.ano,
            [mesCol]: periodo.tipo === 'mensal' ? Number(periodo.mes || 0) : null,
            [trimestreCol]: periodo.tipo === 'trimestral' ? Number(periodo.trimestre || 0) : null,
            [estadoCol]: Number(estadoFinal),
            atualizado_em: nowIso(),
            updated_at: nowIso(),
        });

        const inserted = await insertSupabaseRow(periodTableName, insertPayload);
        return {
            table: periodTableName,
            updatedRows: Array.isArray(inserted) ? inserted.length : 0,
            action: 'inserted',
        };
    }

    async function resolveObrigacoesPeriodTableName(periodo) {
        const yearSuffixTable = `${SUPABASE_OBRIGACOES_PERIODOS_PREFIX}${periodo.ano}`;
        const basePeriodTable = SUPABASE_OBRIGACOES_PERIODOS_PREFIX.endsWith('_')
            ? SUPABASE_OBRIGACOES_PERIODOS_PREFIX.slice(0, -1)
            : SUPABASE_OBRIGACOES_PERIODOS_PREFIX;
        return resolveSupabaseTableName(yearSuffixTable, [
            basePeriodTable,
            'clientes_obrigacoes_periodos',
            'clientes_obrigacoes_periodos_old',
        ]);
    }

    async function loadLocalCollectedSets({ obrigacaoId, periodo, statusClassifier }) {
        let query = `
            SELECT customer_id, customer_source_id, estado_codigo, payload_json
            FROM obrigacoes_recolhas
            WHERE obrigacao_id = ?
              AND periodo_ano = ?
              AND synced_supabase_at IS NOT NULL
        `;
        const params = [Number(obrigacaoId), Number(periodo.ano)];

        if (periodo.tipo === 'mensal') {
            query += ' AND periodo_mes = ?';
            params.push(Number(periodo.mes || 0));
        } else if (periodo.tipo === 'trimestral') {
            query += ' AND periodo_trimestre = ?';
            params.push(Number(periodo.trimestre || 0));
        }

        const rows = await dbAllAsync(query, params);
        const localCustomerIds = new Set();
        const sourceCustomerIds = new Set();
        rows.forEach((row) => {
            let payload = null;
            let estadoAt = '';
            try {
                payload = row?.payload_json ? JSON.parse(String(row.payload_json || '{}')) : null;
                estadoAt = String(payload?.estadoAt || payload?.estado_at || '').trim();
            } catch (error) {
                payload = null;
                estadoAt = '';
            }
            const classifier =
                typeof statusClassifier === 'function'
                    ? statusClassifier
                    : (estado, estadoAtLocal) => classifyObrigacaoEstado(estado, estadoAtLocal);
            const statusCheck = classifier(row?.estado_codigo, estadoAt, payload);
            if (!statusCheck.isSuccess) return;

            const localId = String(row?.customer_id || '').trim();
            if (localId) localCustomerIds.add(localId);
            const sourceId = String(row?.customer_source_id || '').trim();
            if (sourceId) sourceCustomerIds.add(sourceId);
        });
        return { localCustomerIds, sourceCustomerIds };
    }

    async function loadSupabaseCollectedSourceIds({ obrigacaoId, periodo }) {
        const tableName = await resolveObrigacoesPeriodTableName(periodo);
        const tableColumns = await fetchSupabaseTableColumns(tableName);
        const customerCol = pickColumnByCandidates(tableColumns, ['cliente_id', 'customer_id', 'id_cliente'], 'cliente_id');
        const obrigacaoCol = pickColumnByCandidates(
            tableColumns,
            ['obrigacao_modelo_id', 'obrigacao_id', 'id_obrigacao', 'codigo_obrigacao', 'obrigacao_codigo', 'modelo_id'],
            'obrigacao_modelo_id'
        );
        const estadoCol = pickColumnByCandidates(
            tableColumns,
            ['estado_id', 'estado', 'status', 'situacao', 'estado_codigo'],
            'estado_id'
        );
        const anoCol = pickColumnByCandidates(tableColumns, ['ano', 'year'], 'ano');
        const mesCol = pickColumnByCandidates(tableColumns, ['mes', 'month'], 'mes');
        const trimestreCol = pickColumnByCandidates(tableColumns, ['trimestre', 'quarter'], 'trimestre');

        const sourceIds = new Set();
        const pageSize = 1000;
        let offset = 0;

        while (true) {
            const params = new URLSearchParams();
            params.set('select', customerCol);
            params.set(obrigacaoCol, `eq.${Number(obrigacaoId)}`);
            params.set(anoCol, `eq.${Number(periodo.ano)}`);
            params.set(estadoCol, 'eq.4');
            if (periodo.tipo === 'mensal') {
                params.set(mesCol, `eq.${Number(periodo.mes || 0)}`);
            } else if (periodo.tipo === 'trimestral') {
                params.set(trimestreCol, `eq.${Number(periodo.trimestre || 0)}`);
            }
            params.set('limit', String(pageSize));
            params.set('offset', String(offset));

            const response = await axios.get(`${SUPABASE_URL}/rest/v1/${tableName}?${params.toString()}`, {
                headers: {
                    apikey: SUPABASE_KEY,
                    Authorization: `Bearer ${SUPABASE_KEY}`,
                },
                timeout: 15000,
            });

            const rows = Array.isArray(response.data) ? response.data : [];
            rows.forEach((row) => {
                const sourceId = String(row?.[customerCol] || '').trim();
                if (sourceId) sourceIds.add(sourceId);
            });

            if (rows.length < pageSize) break;
            offset += pageSize;
        }

        return { tableName, sourceIds };
    }

    return {
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
    };
}

module.exports = { createSaftService };
