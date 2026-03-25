function createRobotService(deps) {
    const {
        fs,
        path,
        spawn,
        baseDir,
        saftEmail,
        saftPassword,
        goffEmail,
        goffPassword,
        saftObrigacoesRobotScript,
        goffObrigacoesRobotScript,
    } = deps;

    async function runSaftObrigacoesRobot({ mode = 'dri', year, month }) {
        if (!saftEmail || !saftPassword) {
            throw new Error('Email_saft/Senha_saft não configurados no .env.');
        }
        const normalizedMode = String(mode || '').trim().toLowerCase();
        if (!['dri', 'dmr', 'saft', 'iva', 'm22', 'ies', 'm10', 'relatorio-unico'].includes(normalizedMode)) {
            throw new Error(`Modo de robô inválido: ${mode}`);
        }

        const scriptPath = path.isAbsolute(saftObrigacoesRobotScript)
            ? saftObrigacoesRobotScript
            : path.resolve(baseDir, saftObrigacoesRobotScript);

        if (!fs.existsSync(scriptPath)) {
            throw new Error(`Script de obrigações SAFT não encontrado: ${scriptPath}`);
        }

        const args = [
            scriptPath,
            '--mode',
            normalizedMode,
            '--year',
            String(year),
            '--month',
            String(month),
            '--email',
            saftEmail,
            '--password',
            saftPassword,
        ];

        const rawResult = await new Promise((resolve, reject) => {
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
                    reject(new Error(stderr || `Robot SAFT (${normalizedMode.toUpperCase()}) terminou com código ${code}`));
                    return;
                }
                resolve(String(stdout || '').trim());
            });
        });

        const parsed = JSON.parse(String(rawResult || '{}'));
        if (!Array.isArray(parsed?.rows)) {
            throw new Error(`Robot SAFT (${normalizedMode.toUpperCase()}) devolveu payload inválido.`);
        }
        return {
            year: Number(parsed.year || year),
            month: Number(parsed.month || month),
            rows: parsed.rows,
        };
    }

    async function runGoffObrigacoesRobot({ mode = 'saft', year, month, nif = '', nome = '' }) {
        if (!goffEmail || !goffPassword) {
            throw new Error('Email_goff/Senha_goff não configurados no .env.');
        }
        const normalizedMode = String(mode || '').trim().toLowerCase();
        if (!['saft', 'iva', 'dmrat', 'dmrss', 'm22', 'm10', 'ies', 'ru', 'inventario'].includes(normalizedMode)) {
            throw new Error(`Modo de robô GOFF inválido: ${mode}`);
        }

        const scriptPath = path.isAbsolute(goffObrigacoesRobotScript)
            ? goffObrigacoesRobotScript
            : path.resolve(baseDir, goffObrigacoesRobotScript);
        if (!fs.existsSync(scriptPath)) {
            throw new Error(`Script de obrigações GOFF não encontrado: ${scriptPath}`);
        }

        const args = [
            scriptPath,
            '--mode',
            normalizedMode,
            '--email',
            goffEmail,
            '--password',
            goffPassword,
        ];
        if (year !== undefined && year !== null) {
            args.push('--year', String(year));
        }
        if (month !== undefined && month !== null) {
            args.push('--month', String(month));
        }
        if (String(nif || '').trim()) {
            args.push('--nif', String(nif || '').trim());
        }
        if (String(nome || '').trim()) {
            args.push('--nome', String(nome || '').trim());
        }

        const rawResult = await new Promise((resolve, reject) => {
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
                    reject(new Error(stderr || `Robot GOFF ${normalizedMode.toUpperCase()} terminou com código ${code}`));
                    return;
                }
                resolve(String(stdout || '').trim());
            });
        });

        const parsed = JSON.parse(String(rawResult || '{}'));
        if (!Array.isArray(parsed?.rows)) {
            throw new Error(`Robot GOFF ${normalizedMode.toUpperCase()} devolveu payload inválido.`);
        }

        return {
            year: year !== undefined && year !== null ? Number(year) : null,
            month: month !== undefined && month !== null ? Number(month) : null,
            rows: parsed.rows,
            stats: parsed.stats || null,
            filters: parsed.filters || null,
        };
    }

    async function runGoffObrigacoesRobotSaft({ year, month, nif = '', nome = '' }) {
        return runGoffObrigacoesRobot({ mode: 'saft', year, month, nif, nome });
    }

    async function runGoffObrigacoesRobotIva({ year, month, nif = '', nome = '' }) {
        return runGoffObrigacoesRobot({ mode: 'iva', year, month, nif, nome });
    }

    async function runGoffObrigacoesRobotDmrAt({ year, month, nif = '', nome = '' }) {
        return runGoffObrigacoesRobot({ mode: 'dmrat', year, month, nif, nome });
    }

    async function runGoffObrigacoesRobotDmrSs({ year, month, nif = '', nome = '' }) {
        return runGoffObrigacoesRobot({ mode: 'dmrss', year, month, nif, nome });
    }

    async function runGoffObrigacoesRobotM22({ year, nif = '', nome = '' }) {
        return runGoffObrigacoesRobot({ mode: 'm22', year, month: 0, nif, nome });
    }

    async function runGoffObrigacoesRobotIes({ year, nif = '', nome = '' }) {
        return runGoffObrigacoesRobot({ mode: 'ies', year, month: 0, nif, nome });
    }

    async function runGoffObrigacoesRobotM10({ year, nif = '', nome = '' }) {
        return runGoffObrigacoesRobot({ mode: 'm10', year, month: 0, nif, nome });
    }

    async function runGoffObrigacoesRobotRelatorioUnico({ year, nif = '', nome = '' }) {
        return runGoffObrigacoesRobot({ mode: 'ru', year, month: 0, nif, nome });
    }

    async function runGoffObrigacoesRobotInventario({ year, nif = '', nome = '' }) {
        return runGoffObrigacoesRobot({ mode: 'inventario', year, month: 0, nif, nome });
    }

    async function runSaftObrigacoesRobotDri({ year, month }) {
        return runSaftObrigacoesRobot({ mode: 'dri', year, month });
    }

    async function runSaftObrigacoesRobotDmr({ year, month }) {
        return runSaftObrigacoesRobot({ mode: 'dmr', year, month });
    }

    async function runSaftObrigacoesRobotSaft({ year, month }) {
        return runSaftObrigacoesRobot({ mode: 'saft', year, month });
    }

    async function runSaftObrigacoesRobotIva({ year, month }) {
        return runSaftObrigacoesRobot({ mode: 'iva', year, month });
    }

    async function runSaftObrigacoesRobotM22({ year }) {
        return runSaftObrigacoesRobot({ mode: 'm22', year, month: 0 });
    }

    async function runSaftObrigacoesRobotIes({ year }) {
        return runSaftObrigacoesRobot({ mode: 'ies', year, month: 0 });
    }

    async function runSaftObrigacoesRobotM10({ year }) {
        return runSaftObrigacoesRobot({ mode: 'm10', year, month: 0 });
    }

    async function runSaftObrigacoesRobotRelatorioUnico({ year }) {
        return runSaftObrigacoesRobot({ mode: 'relatorio-unico', year, month: 0 });
    }

    return {
        runSaftObrigacoesRobot,
        runGoffObrigacoesRobot,
        runGoffObrigacoesRobotSaft,
        runGoffObrigacoesRobotIva,
        runGoffObrigacoesRobotDmrAt,
        runGoffObrigacoesRobotDmrSs,
        runGoffObrigacoesRobotM22,
        runGoffObrigacoesRobotIes,
        runGoffObrigacoesRobotM10,
        runGoffObrigacoesRobotRelatorioUnico,
        runGoffObrigacoesRobotInventario,
        runSaftObrigacoesRobotDri,
        runSaftObrigacoesRobotDmr,
        runSaftObrigacoesRobotSaft,
        runSaftObrigacoesRobotIva,
        runSaftObrigacoesRobotM22,
        runSaftObrigacoesRobotIes,
        runSaftObrigacoesRobotM10,
        runSaftObrigacoesRobotRelatorioUnico,
    };
}

module.exports = {
    createRobotService,
};
