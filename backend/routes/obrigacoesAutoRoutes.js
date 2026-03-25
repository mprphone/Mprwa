function registerObrigacoesAutoRoutes(context) {
    const {
        app,
        getSchedulerConfig,
        getState,
        isRunning,
        runNow,
    } = context;

    app.get('/api/import/obrigacoes/auto/status', async (req, res) => {
        return res.json({
            success: true,
            scheduler: getSchedulerConfig(),
            state: getState(),
        });
    });

    app.post('/api/import/obrigacoes/auto/run', async (req, res) => {
        if (isRunning()) {
            return res.status(409).json({
                success: false,
                error: 'Recolha automática já está em execução.',
                state: getState(),
            });
        }

        const summary = await runNow();
        return res.json({
            success: true,
            summary,
            state: getState(),
        });
    });
}

module.exports = {
    registerObrigacoesAutoRoutes,
};
