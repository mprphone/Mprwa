CREATE TABLE IF NOT EXISTS hr_funcionarios (
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
    numero_colaborador TEXT,
    nif TEXT,
    niss TEXT,
    cartao_cidadao TEXT,
    morada TEXT,
    codigo_postal TEXT,
    estado_civil TEXT,
    tem_filhos INTEGER NOT NULL DEFAULT 0,
    numero_filhos INTEGER NOT NULL DEFAULT 0,
    contacto_emergencia TEXT,
    iban TEXT,
    cargo TEXT,
    responsavel_direto TEXT,
    tipo_vinculo TEXT,
    data_admissao TEXT,
    data_saida TEXT,
    observacoes_internas TEXT,
    foto_url TEXT,
    estado_rh TEXT,
    tipo_horario TEXT,
    hora_entrada_prevista TEXT,
    hora_saida_prevista TEXT,
    pausa_almoco_inicio TEXT,
    pausa_almoco_fim TEXT,
    tolerancia_entrada_min INTEGER NOT NULL DEFAULT 0,
    tolerancia_saida_min INTEGER NOT NULL DEFAULT 0,
    horas_diarias_previstas REAL NOT NULL DEFAULT 8,
    horas_semanais_contratadas REAL NOT NULL DEFAULT 40,
    dias_trabalho TEXT,
    objetivos_json TEXT,
    premio_objetivos TEXT,
    supabase_payload_json TEXT,
    supabase_created_at TEXT,
    supabase_updated_at TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hr_funcionarios_nome
ON hr_funcionarios(nome);

CREATE INDEX IF NOT EXISTS idx_hr_funcionarios_email
ON hr_funcionarios(email);

CREATE TABLE IF NOT EXISTS hr_pedidos (
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
);

CREATE INDEX IF NOT EXISTS idx_hr_pedidos_funcionario
ON hr_pedidos(funcionario_id, data_inicio);

CREATE INDEX IF NOT EXISTS idx_hr_pedidos_status
ON hr_pedidos(status, data_inicio);

CREATE TABLE IF NOT EXISTS hr_registos_ponto (
    id TEXT PRIMARY KEY,
    funcionario_id TEXT NOT NULL,
    tipo TEXT NOT NULL,
    momento TEXT NOT NULL,
    origem TEXT,
    supabase_payload_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_hr_registos_ponto_funcionario
ON hr_registos_ponto(funcionario_id, momento);

CREATE TABLE IF NOT EXISTS hr_holidays (
    date TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    region TEXT,
    supabase_payload_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS hr_ferias_saldos (
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
);

CREATE INDEX IF NOT EXISTS idx_hr_ferias_saldos_ano
ON hr_ferias_saldos(ano);

CREATE TABLE IF NOT EXISTS hr_ferias_empresa_periodos (
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
);

CREATE INDEX IF NOT EXISTS idx_hr_ferias_empresa_periodos_datas
ON hr_ferias_empresa_periodos(data_inicio, data_fim);

CREATE TABLE IF NOT EXISTS hr_objetivos (
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
);

CREATE INDEX IF NOT EXISTS idx_hr_objetivos_funcionario
ON hr_objetivos(funcionario_id, ordem);

CREATE TABLE IF NOT EXISTS hr_objetivos_config (
    funcionario_id TEXT PRIMARY KEY,
    patamar_50 TEXT,
    patamar_65 TEXT,
    patamar_80 TEXT,
    premio_maximo REAL NOT NULL DEFAULT 0,
    notas_gerais TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
